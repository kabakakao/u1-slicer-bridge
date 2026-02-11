"""Profile embedding for 3MF files.

Embeds Orca Slicer profiles into existing 3MF files while preserving geometry.
Handles Bambu Studio files by extracting clean geometry with trimesh.
"""

import json
import zipfile
import shutil
import logging
from pathlib import Path
from typing import Dict, Any
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class ProfileSettings:
    """Orca Slicer profile settings bundle."""
    printer: Dict[str, Any]
    process: Dict[str, Any]
    filament: Dict[str, Any]


class ProfileEmbedError(Exception):
    """Raised when profile embedding fails."""
    pass


class ProfileEmbedder:
    """Embeds Orca Slicer profiles into existing 3MF files."""

    def __init__(self, profile_dir: Path):
        """Initialize embedder with profile directory.

        Args:
            profile_dir: Directory containing orca_profiles/ with printer/process/filament JSONs
        """
        self.profile_dir = profile_dir
        logger.info(f"ProfileEmbedder initialized with profile_dir: {profile_dir}")

    def _is_bambu_file(self, three_mf_path: Path) -> bool:
        """Check if 3MF file is from Bambu Studio.

        Args:
            three_mf_path: Path to 3MF file

        Returns:
            True if file contains Bambu-specific metadata
        """
        try:
            with zipfile.ZipFile(three_mf_path, 'r') as zf:
                # Check for Bambu-specific files
                bambu_files = {
                    'Metadata/model_settings.config',
                    'Metadata/slice_info.config',
                    'Metadata/filament_sequence.json'
                }
                return bool(bambu_files & set(zf.namelist()))
        except Exception as e:
            logger.warning(f"Could not check if Bambu file: {e}")
            return False

    def _rebuild_with_trimesh(self, source_3mf: Path, dest_3mf: Path) -> None:
        """Rebuild 3MF with trimesh to extract clean geometry.

        This strips Bambu-specific format issues and creates a clean 3MF
        that Orca Slicer can parse.

        Args:
            source_3mf: Original Bambu 3MF path
            dest_3mf: Output clean 3MF path
        """
        try:
            import trimesh
            logger.info(f"Rebuilding Bambu 3MF with trimesh: {source_3mf.name}")

            # Load entire scene (preserves object positions)
            scene = trimesh.load(str(source_3mf), file_type='3mf')

            # Export as clean 3MF
            scene.export(str(dest_3mf), file_type='3mf')

            logger.info(f"Rebuilt clean 3MF: {dest_3mf.name} ({dest_3mf.stat().st_size / 1024 / 1024:.2f} MB)")

        except ImportError:
            raise ProfileEmbedError("trimesh library not installed - cannot process Bambu files")
        except Exception as e:
            raise ProfileEmbedError(f"Failed to rebuild 3MF with trimesh: {str(e)}")

    def embed_profiles(self,
                       source_3mf: Path,
                       output_3mf: Path,
                       filament_settings: Dict[str, Any],
                       overrides: Dict[str, Any]) -> Path:
        """Copy original 3MF and inject Orca profiles.

        Preserves all original geometry, transforms, and positioning.
        Only adds/updates the Metadata/project_settings.config file.

        For Bambu Studio files, extracts clean geometry with trimesh first.

        Args:
            source_3mf: Path to original 3MF file
            output_3mf: Path where modified 3MF should be saved
            filament_settings: Filament-specific settings (temps, speeds, etc.)
            overrides: User-specified settings (layer_height, infill_density, etc.)

        Returns:
            Path to output 3MF file

        Raises:
            ProfileEmbedError: If embedding fails
        """
        try:
            logger.info(f"Embedding profiles into {source_3mf.name}")

            # Check if this is a Bambu file that needs rebuilding
            working_3mf = source_3mf
            if self._is_bambu_file(source_3mf):
                logger.info("Detected Bambu Studio file - rebuilding with trimesh")
                # Create temporary clean 3MF
                temp_clean = source_3mf.parent / f"{source_3mf.stem}_clean.3mf"
                self._rebuild_with_trimesh(source_3mf, temp_clean)
                working_3mf = temp_clean

            # Load Snapmaker U1 profiles
            profiles = self.load_snapmaker_profiles()

            # Merge all settings
            config = {
                **profiles.printer,
                **profiles.process,
                **profiles.filament,
                **filament_settings,
                **overrides
            }

            # Ensure layer_gcode for relative extruder addressing
            if 'layer_gcode' not in config:
                config['layer_gcode'] = 'G92 E0'

            # Ensure arc fitting to reduce G-code file size
            if 'enable_arc_fitting' not in config:
                config['enable_arc_fitting'] = '1'

            logger.debug(f"Merged config with {len(config)} keys")

            # Create JSON settings
            settings_json = json.dumps(config, indent=2)

            # Copy and modify 3MF (use working_3mf which may be cleaned version)
            self._copy_and_inject_settings(working_3mf, output_3mf, settings_json)

            # Clean up temporary clean 3MF if we created one
            if working_3mf != source_3mf and working_3mf.exists():
                working_3mf.unlink()
                logger.debug(f"Cleaned up temporary file: {working_3mf.name}")

            logger.info(f"Successfully embedded profiles into {output_3mf.name}")
            return output_3mf

        except Exception as e:
            # Clean up temporary files on error
            if 'working_3mf' in locals() and working_3mf != source_3mf and working_3mf.exists():
                working_3mf.unlink()
            logger.error(f"Failed to embed profiles: {str(e)}")
            raise ProfileEmbedError(f"Profile embedding failed: {str(e)}") from e

    def _copy_and_inject_settings(self, source: Path, dest: Path, settings_json: str):
        """Copy 3MF and add/update project_settings.config.

        Args:
            source: Source 3MF path
            dest: Destination 3MF path
            settings_json: JSON string to write to Metadata/project_settings.config
        """
        # Create temporary ZIP for rebuilding
        temp_zip = dest.with_suffix('.tmp')

        try:
            # Bambu Studio metadata files that cause Orca to crash
            bambu_metadata_files = {
                'Metadata/project_settings.config',  # We'll replace this
                'Metadata/model_settings.config',    # Bambu-specific
                'Metadata/slice_info.config',        # Bambu-specific
                'Metadata/cut_information.xml',      # Bambu-specific
                'Metadata/filament_sequence.json',   # Bambu-specific
            }

            with zipfile.ZipFile(source, 'r') as source_zf:
                with zipfile.ZipFile(temp_zip, 'w', zipfile.ZIP_DEFLATED) as dest_zf:
                    # Copy geometry and essential files, skip Bambu metadata
                    for item in source_zf.infolist():
                        if item.filename in bambu_metadata_files:
                            logger.debug(f"Skipping Bambu metadata: {item.filename}")
                            continue

                        # Skip Bambu preview images to reduce file size
                        if item.filename.startswith('Metadata/plate') or item.filename.startswith('Metadata/top') or item.filename.startswith('Metadata/pick'):
                            logger.debug(f"Skipping preview image: {item.filename}")
                            continue

                        # Copy file as-is (geometry, relations, etc.)
                        data = source_zf.read(item.filename)
                        dest_zf.writestr(item, data)

                    # Add new project_settings.config
                    dest_zf.writestr('Metadata/project_settings.config', settings_json)
                    logger.debug("Injected new project_settings.config")

            # Replace destination with temp file
            temp_zip.replace(dest)

        except Exception as e:
            # Clean up temp file on error
            if temp_zip.exists():
                temp_zip.unlink()
            raise

    def load_snapmaker_profiles(self) -> ProfileSettings:
        """Load default Snapmaker U1 profiles from JSON files.

        Returns:
            ProfileSettings with printer, process, and filament configs

        Raises:
            ProfileEmbedError: If profiles cannot be loaded
        """
        try:
            printer_path = self.profile_dir / "printer" / "Snapmaker U1 (0.4 nozzle) - multiplate.json"
            process_path = self.profile_dir / "process" / "0.20mm Standard @Snapmaker U1.json"
            filament_path = self.profile_dir / "filament" / "PLA @Snapmaker U1.json"

            with open(printer_path) as f:
                printer = json.load(f)
            with open(process_path) as f:
                process = json.load(f)
            with open(filament_path) as f:
                filament = json.load(f)

            logger.debug(f"Loaded profiles: {printer_path.name}, {process_path.name}, {filament_path.name}")

            return ProfileSettings(printer=printer, process=process, filament=filament)

        except FileNotFoundError as e:
            raise ProfileEmbedError(f"Profile file not found: {e.filename}")
        except json.JSONDecodeError as e:
            raise ProfileEmbedError(f"Invalid JSON in profile: {str(e)}")
