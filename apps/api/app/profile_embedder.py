"""Profile embedding for 3MF files.

Embeds Orca Slicer profiles into existing 3MF files while preserving geometry.
Handles Bambu Studio files by extracting clean geometry with trimesh.
"""

import asyncio
import copy
import json
import re
import uuid
import zipfile
import shutil
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
import xml.etree.ElementTree as ET
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

    @staticmethod
    def _has_modifier_parts(three_mf_path: Path) -> bool:
        """Check if any model file contains type='other' objects (modifier parts).

        Bambu Studio uses modifier parts (cubes, etc.) to override print settings
        in specific regions.  Trimesh doesn't understand modifier semantics and
        duplicates them as full geometry copies, so they must be stripped before
        the trimesh rebuild.
        """
        try:
            with zipfile.ZipFile(three_mf_path, 'r') as zf:
                for name in zf.namelist():
                    if not name.endswith('.model'):
                        continue
                    root = ET.fromstring(zf.read(name))
                    for elem in root.iter():
                        if elem.tag.endswith('}object') or elem.tag == 'object':
                            if elem.get('type') == 'other':
                                return True
        except Exception as e:
            logger.debug(f"Could not check for modifier parts: {e}")
        return False

    @staticmethod
    def _strip_modifier_parts(source_3mf: Path, dest_3mf: Path) -> None:
        """Create a copy of the 3MF with modifier parts removed.

        Strips component references to type='other' objects from the main model
        and removes the modifier objects from sub-model files.  This prevents
        trimesh from duplicating geometry (it merges both the main mesh and the
        modifier mesh for every component reference, producing wrong output).
        """
        # Collect modifier object IDs from sub-model files
        modifier_ids: set[str] = set()
        with zipfile.ZipFile(source_3mf, 'r') as zf:
            for name in zf.namelist():
                if not name.endswith('.model') or name == '3D/3dmodel.model':
                    continue
                root = ET.fromstring(zf.read(name))
                for elem in root.iter():
                    if (elem.tag.endswith('}object') or elem.tag == 'object') and elem.get('type') == 'other':
                        modifier_ids.add(elem.get('id'))

        if not modifier_ids:
            # Nothing to strip — just copy
            import shutil
            shutil.copy2(source_3mf, dest_3mf)
            return

        logger.info(f"Stripping modifier object IDs {modifier_ids} before trimesh rebuild")

        with zipfile.ZipFile(source_3mf, 'r') as zin:
            with zipfile.ZipFile(dest_3mf, 'w', zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    data = zin.read(item.filename)

                    if item.filename == '3D/3dmodel.model':
                        root = ET.fromstring(data)
                        for elem in root.iter():
                            if elem.tag.endswith('}components') or elem.tag == 'components':
                                for comp in list(elem):
                                    if comp.get('objectid') in modifier_ids:
                                        elem.remove(comp)
                        data = ET.tostring(root, encoding='utf-8', xml_declaration=True)

                    elif item.filename.endswith('.model') and item.filename != '3D/3dmodel.model':
                        root = ET.fromstring(data)
                        for elem in root.iter():
                            if elem.tag.endswith('}resources') or elem.tag == 'resources':
                                for obj in list(elem):
                                    if obj.get('type') == 'other':
                                        elem.remove(obj)
                        data = ET.tostring(root, encoding='utf-8', xml_declaration=True)

                    zout.writestr(item, data)

    @staticmethod
    def _strip_non_printable_items(source_3mf: Path, dest_3mf: Path) -> bool:
        """Remove build items marked ``printable="0"`` and their associated objects.

        Bambu Studio keeps non-printable copies of objects on the plate
        (e.g. previous arrangements, hidden duplicates).  Trimesh loads all
        geometry indiscriminately, so including them doubles the mesh and can
        crash Orca Slicer.

        Returns True if any items were stripped.
        """
        try:
            with zipfile.ZipFile(source_3mf, 'r') as zf:
                if '3D/3dmodel.model' not in zf.namelist():
                    return False
                root = ET.fromstring(zf.read('3D/3dmodel.model'))
        except Exception:
            return False

        ns = {'m': 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'}
        build = root.find('.//m:build', ns) or root.find('.//build')
        if build is None:
            return False

        # Identify non-printable items
        non_printable_ids: set[str] = set()
        for item in list(build):
            tag = item.tag.split('}')[-1] if '}' in item.tag else item.tag
            if tag != 'item':
                continue
            if item.get('printable') == '0':
                oid = item.get('objectid')
                if oid:
                    non_printable_ids.add(oid)
                build.remove(item)

        if not non_printable_ids:
            return False

        logger.info(f"Stripping non-printable build items (objectids={non_printable_ids})")

        # Remove the <object> elements that are only used by non-printable items.
        # Collect IDs still referenced by remaining (printable) items.
        remaining_ids: set[str] = set()
        for item in build:
            tag = item.tag.split('}')[-1] if '}' in item.tag else item.tag
            if tag == 'item':
                oid = item.get('objectid')
                if oid:
                    remaining_ids.add(oid)

        remove_ids = non_printable_ids - remaining_ids
        if remove_ids:
            resources = root.find('.//m:resources', ns) or root.find('.//resources')
            if resources is not None:
                for obj in list(resources):
                    if obj.get('id') in remove_ids:
                        resources.remove(obj)

        # Collect sub-model paths referenced by removed objects for later cleanup
        removed_paths: set[str] = set()
        for resources_elem in root.iter():
            tag = resources_elem.tag.split('}')[-1] if '}' in resources_elem.tag else resources_elem.tag
            if tag != 'resources':
                continue
            for obj in resources_elem:
                if obj.get('id') in remove_ids:
                    for comp in obj.iter():
                        ctag = comp.tag.split('}')[-1] if '}' in comp.tag else comp.tag
                        if ctag == 'component':
                            p = comp.get('{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}path')
                            if p:
                                removed_paths.add(p.lstrip('/'))

        new_model = ET.tostring(root, encoding='utf-8', xml_declaration=True)

        with zipfile.ZipFile(source_3mf, 'r') as zin:
            with zipfile.ZipFile(dest_3mf, 'w', zipfile.ZIP_DEFLATED) as zout:
                for info in zin.infolist():
                    if info.filename == '3D/3dmodel.model':
                        zout.writestr(info, new_model)
                    elif info.filename in removed_paths:
                        logger.debug(f"Skipping sub-model for non-printable object: {info.filename}")
                        continue
                    else:
                        zout.writestr(info, zin.read(info.filename))

        return True

    def _rebuild_with_trimesh(self, source_3mf: Path, dest_3mf: Path, *, concatenate: bool = False) -> None:
        """Rebuild 3MF with trimesh to extract clean geometry.

        This strips Bambu-specific format issues and creates a clean 3MF
        that Orca Slicer can parse.

        For files with modifier parts (type='other' objects), these are stripped
        before the trimesh load to prevent geometry duplication.

        When *concatenate* is True, all meshes in the scene are combined into
        a single mesh.  This is needed for Bambu component assemblies where
        the sub-objects are parts of ONE model — exporting them as separate
        build items causes OrcaSlicer to report conflicts.

        Args:
            source_3mf: Original Bambu 3MF path
            dest_3mf: Output clean 3MF path
            concatenate: Combine all meshes into a single object
        """
        try:
            import trimesh
            logger.info(f"Rebuilding Bambu 3MF with trimesh: {source_3mf.name} (concatenate={concatenate})")

            load_source = source_3mf
            temp_files: list[Path] = []

            # Strip non-printable build items — trimesh loads all geometry
            # indiscriminately, so non-printable copies double the mesh.
            temp_np = source_3mf.parent / f"{source_3mf.stem}_printable_{uuid.uuid4().hex[:8]}.3mf"
            if self._strip_non_printable_items(source_3mf, temp_np):
                load_source = temp_np
                temp_files.append(temp_np)
                logger.info("Stripped non-printable build items before trimesh rebuild")
            elif temp_np.exists():
                temp_np.unlink()

            # Strip modifier parts before trimesh load — trimesh doesn't
            # understand modifier semantics and duplicates geometry otherwise.
            if self._has_modifier_parts(load_source):
                temp_mod = load_source.parent / f"{load_source.stem}_nomod_{uuid.uuid4().hex[:8]}.3mf"
                self._strip_modifier_parts(load_source, temp_mod)
                load_source = temp_mod
                temp_files.append(temp_mod)
                logger.info("Stripped modifier parts before trimesh rebuild")

            try:
                # Load entire scene (preserves object positions)
                scene = trimesh.load(str(load_source), file_type='3mf')

                if concatenate and isinstance(scene, trimesh.Scene):
                    # Combine all meshes into a single object.  This is
                    # needed for Bambu assemblies where component parts
                    # are sub-objects of one model.
                    combined = scene.dump(concatenate=True)
                    combined.export(str(dest_3mf), file_type='3mf')
                    logger.info(f"Concatenated {len(scene.geometry)} meshes into single object")
                else:
                    # Export as clean 3MF (preserves separate objects)
                    scene.export(str(dest_3mf), file_type='3mf')
            finally:
                for tf in temp_files:
                    if tf.exists():
                        tf.unlink()

            logger.info(f"Rebuilt clean 3MF: {dest_3mf.name} ({dest_3mf.stat().st_size / 1024 / 1024:.2f} MB)")

        except ImportError:
            raise ProfileEmbedError("trimesh library not installed - cannot process Bambu files")
        except Exception as e:
            raise ProfileEmbedError(f"Failed to rebuild 3MF with trimesh: {str(e)}")

    def _has_multi_extruder_assignments(self, three_mf_path: Path) -> bool:
        """Check if model_settings.config contains multiple extruder assignments.

        Returns True when the 3MF has explicit per-object/per-part extruder mapping
        for more than one extruder. In that case we should preserve original metadata
        (no trimesh rebuild), otherwise assignments are lost and slicing becomes single-tool.
        """
        try:
            import xml.etree.ElementTree as ET

            with zipfile.ZipFile(three_mf_path, 'r') as zf:
                if 'Metadata/model_settings.config' not in zf.namelist():
                    return False

                root = ET.fromstring(zf.read('Metadata/model_settings.config'))
                extruders = set()

                for meta in root.findall('.//metadata'):
                    if meta.get('key') == 'extruder':
                        v = meta.get('value')
                        if v is not None:
                            extruders.add(v)

                return len(extruders) > 1
        except Exception as e:
            logger.debug(f"Could not detect multi-extruder assignments: {e}")
            return False

    @staticmethod
    def _has_layer_tool_changes(three_mf_path: Path) -> bool:
        """Check if custom_gcode_per_layer.xml contains ToolChange entries.

        Bambu's MultiAsSingle mode stores mid-print filament swaps as
        type="2" entries.  These must be preserved (not stripped by trimesh
        rebuild) so OrcaSlicer can emit real T-commands.
        """
        try:
            import xml.etree.ElementTree as ET
            with zipfile.ZipFile(three_mf_path, 'r') as zf:
                if 'Metadata/custom_gcode_per_layer.xml' not in zf.namelist():
                    return False
                root = ET.fromstring(zf.read('Metadata/custom_gcode_per_layer.xml'))
                for layer in root.findall('.//layer'):
                    if layer.get('type') == '2':
                        return True
            return False
        except Exception:
            return False

    def _get_assigned_extruder_count(self, three_mf_path: Path) -> int:
        """Get highest assigned extruder index from model_settings.config."""
        try:
            import xml.etree.ElementTree as ET

            with zipfile.ZipFile(three_mf_path, 'r') as zf:
                if 'Metadata/model_settings.config' not in zf.namelist():
                    return 1

                root = ET.fromstring(zf.read('Metadata/model_settings.config'))
                max_idx = 1
                for meta in root.findall('.//metadata'):
                    if meta.get('key') != 'extruder':
                        continue
                    raw = meta.get('value')
                    if raw is None:
                        continue
                    try:
                        idx = int(str(raw).strip())
                    except ValueError:
                        continue
                    if idx > max_idx:
                        max_idx = idx
                return max_idx
        except Exception as e:
            logger.debug(f"Could not parse assigned extruder count: {e}")
            return 1

    @staticmethod
    def _ensure_list(value: Any) -> List[Any]:
        if value is None:
            return []
        if isinstance(value, list):
            return value
        return [value]

    @staticmethod
    def _pad_list(values: List[Any], target_len: int, default_value: Any) -> List[Any]:
        if target_len <= 0:
            return values
        if not values:
            values = [default_value]
        padded = list(values)
        while len(padded) < target_len:
            padded.append(padded[-1])
        return padded

    # Keys whose list values are NOT per-filament and should not be padded.
    _NON_FILAMENT_LIST_KEYS = frozenset({
        'compatible_printers',
        'compatible_prints',
    })

    # Keys that have special list semantics (not simple per-filament arrays).
    _SPECIAL_LIST_KEYS = frozenset({
        'flush_volumes_matrix',   # N*N matrix
        'flush_volumes_vector',   # 2*N vector
        'different_settings_to_system',
        'inherits_group',
        'upward_compatible_machine',
        'printable_area',         # bed shape (4 corners)
        'bed_exclude_area',       # exclusion zones (variable corners)
        'thumbnails',             # image sizes list
        'head_wrap_detect_zone',  # detection zone points
        'extruder_offset',        # per-extruder XY offsets
        'wipe_tower_x',          # per-plate tower position (not per-filament)
        'wipe_tower_y',          # per-plate tower position (not per-filament)
    })

    @staticmethod
    def _normalize_per_filament_arrays(config: Dict[str, Any], target_count: int) -> None:
        """Normalize all per-filament arrays to exactly *target_count* elements.

        Pads short arrays by repeating the last element and truncates long
        arrays.  This prevents segfaults when Bambu configs have N-filament
        arrays but our settings use a different count.

        Special arrays (flush volumes matrix/vector) are handled separately.
        """
        adjusted = 0
        skip = ProfileEmbedder._NON_FILAMENT_LIST_KEYS | ProfileEmbedder._SPECIAL_LIST_KEYS
        for key, value in config.items():
            if key in skip:
                continue
            if not isinstance(value, list) or len(value) == 0:
                continue
            if len(value) == target_count:
                continue
            if len(value) < target_count:
                while len(value) < target_count:
                    value.append(value[-1])
            else:
                config[key] = value[:target_count]
            adjusted += 1

        # Special: flush_volumes_matrix is NxN
        fvm = config.get('flush_volumes_matrix')
        if isinstance(fvm, list) and len(fvm) > 0:
            needed = target_count * target_count
            if len(fvm) != needed:
                config['flush_volumes_matrix'] = (fvm + [fvm[-1]] * needed)[:needed]
                adjusted += 1

        # Special: flush_volumes_vector is 2*N
        fvv = config.get('flush_volumes_vector')
        if isinstance(fvv, list) and len(fvv) > 0:
            needed = target_count * 2
            if len(fvv) != needed:
                config['flush_volumes_vector'] = (fvv + [fvv[-1]] * needed)[:needed]
                adjusted += 1

        if adjusted:
            logger.info(
                "Normalized %d per-filament arrays to %d entries",
                adjusted, target_count,
            )

    @staticmethod
    def _sanitize_nil_values(config: Dict[str, Any]) -> None:
        """Replace Bambu 'nil' strings in per-filament arrays with defaults.

        Bambu Studio uses 'nil' to mean "use the base profile default".
        Snapmaker OrcaSlicer v2.2.4 cannot parse 'nil' as a number and
        segfaults at "Initializing StaticPrintConfigs".

        Strategy: replace 'nil' with the first non-nil value in the same
        array.  If ALL values are 'nil', remove the key entirely.
        """
        removed = []
        fixed = 0
        for key, value in config.items():
            if not isinstance(value, list):
                continue
            if not any(str(v) == 'nil' for v in value):
                continue
            # Find first non-nil value as default
            default = None
            for v in value:
                if str(v) != 'nil':
                    default = v
                    break
            if default is None:
                # All nil — remove the key
                removed.append(key)
                continue
            config[key] = [default if str(v) == 'nil' else v for v in value]
            fixed += 1

        for key in removed:
            del config[key]

        if fixed or removed:
            logger.info(
                "Sanitized Bambu nil values: %d arrays fixed, %d all-nil keys removed",
                fixed, len(removed),
            )

    @staticmethod
    def _pad_per_filament_arrays(config: Dict[str, Any], target_count: int) -> None:
        """Pad all short per-filament arrays to *target_count* by repeating the last element.

        Orca expects every per-filament array in project_settings to have the
        same length.  When filament_colour has *target_count* entries but other
        arrays (from the base filament profile) are still length 1, Orca reads
        past the array bounds and segfaults.
        """
        padded = 0
        for key, value in config.items():
            if key in ProfileEmbedder._NON_FILAMENT_LIST_KEYS:
                continue
            if isinstance(value, list) and 0 < len(value) < target_count:
                while len(value) < target_count:
                    value.append(value[-1])
                padded += 1
        if padded:
            logger.info(
                "Padded %d per-filament arrays to %d entries",
                padded, target_count,
            )

    @staticmethod
    def _sanitize_index_field(config: Dict[str, Any], key: str, minimum: int) -> None:
        raw = config.get(key)
        if raw is None:
            return
        try:
            numeric = int(float(str(raw).strip()))
        except Exception:
            numeric = minimum
        if numeric < minimum:
            numeric = minimum
        config[key] = str(numeric)

    @staticmethod
    def _sanitize_float_field(config: Dict[str, Any], key: str, minimum: float) -> None:
        raw = config.get(key)
        if raw is None:
            return

        # Bambu settings may encode numeric fields as a scalar or single-item list.
        value = raw[0] if isinstance(raw, list) and raw else raw
        try:
            numeric = float(str(value).strip())
        except Exception:
            return

        if numeric < minimum:
            numeric = minimum

        normalized = str(numeric)
        if isinstance(raw, list):
            config[key] = [normalized]
        else:
            config[key] = normalized

    @staticmethod
    def _get_numeric(config: Dict[str, Any], key: str, fallback: float) -> float:
        raw = config.get(key)
        if raw is None:
            return fallback
        value = raw[0] if isinstance(raw, list) and raw else raw
        try:
            return float(str(value).strip())
        except Exception:
            return fallback

    @staticmethod
    def _has_paint_data_zip(source_3mf: Path) -> bool:
        """Check if a 3MF file contains per-triangle paint_color data."""
        MAX_SCAN = 32 * 1024 * 1024
        CHUNK = 1024 * 1024
        needle = b"paint_color"
        try:
            with zipfile.ZipFile(source_3mf, 'r') as zf:
                for name in zf.namelist():
                    if not name.endswith(".model"):
                        continue
                    scanned = 0
                    with zf.open(name) as f:
                        while scanned < MAX_SCAN:
                            chunk = f.read(CHUNK)
                            if not chunk:
                                break
                            if needle in chunk:
                                return True
                            scanned += len(chunk)
        except Exception:
            pass
        return False

    def _sanitize_wipe_tower_position(
        self,
        config: Dict[str, Any],
        bed_size_mm: float = 270.0,
        extra_margin_mm: float = 6.0,
    ) -> None:
        """Keep wipe/prime tower safely inside bed bounds.

        Orca/Bambu configs can carry low `wipe_tower_x` values (e.g., 15mm) that
        place a wide prime tower at or beyond the printable edge.
        """
        tower_width = self._get_numeric(config, 'prime_tower_width', 35.0)
        tower_brim = max(0.0, self._get_numeric(config, 'prime_tower_brim_width', 3.0))
        half_span = max(12.0, (tower_width / 2.0) + tower_brim + extra_margin_mm)
        min_pos = half_span
        max_pos = max(min_pos, bed_size_mm - half_span)

        for axis_key in ('wipe_tower_x', 'wipe_tower_y'):
            raw = config.get(axis_key)
            if raw is None:
                continue
            config[axis_key] = self._clamp_wipe_tower_value(raw, min_pos, max_pos)

    def _clamp_wipe_tower_value(self, raw: Any, min_pos: float, max_pos: float) -> Any:
        """Clamp wipe-tower position values while preserving scalar/list shape."""
        if isinstance(raw, list):
            normalized_list: List[str] = []
            for value in raw:
                normalized_list.append(self._clamp_wipe_tower_scalar(value, min_pos, max_pos))
            return normalized_list if normalized_list else raw
        return self._clamp_wipe_tower_scalar(raw, min_pos, max_pos)

    def _clamp_wipe_tower_scalar(self, raw: Any, min_pos: float, max_pos: float) -> str:
        """Clamp one wipe-tower coordinate; preserve unparseable values as strings."""
        try:
            numeric = float(str(raw).strip())
        except Exception:
            return str(raw)
        if numeric < min_pos:
            numeric = min_pos
        if numeric > max_pos:
            numeric = max_pos
        return f"{numeric:.3f}"

    def _has_bambu_per_plate_wipe_tower_arrays(self, base_config: Dict[str, Any]) -> bool:
        return (
            isinstance(base_config.get('wipe_tower_x'), list)
            or isinstance(base_config.get('wipe_tower_y'), list)
        )

    def _preserve_bambu_wipe_tower_array_shape(
        self,
        config: Dict[str, Any],
        base_config: Dict[str, Any],
        overrides: Dict[str, Any],
    ) -> None:
        """Replicate scalar overrides into Bambu per-plate wipe_tower arrays."""
        for axis_key in ("wipe_tower_x", "wipe_tower_y"):
            if axis_key not in overrides or not isinstance(base_config.get(axis_key), list):
                continue
            base_values = self._ensure_list(base_config.get(axis_key))
            if base_values:
                config[axis_key] = [str(config[axis_key])] * len(base_values)

    def _build_assignment_preserving_config(
        self,
        source_3mf: Path,
        profiles: ProfileSettings,
        filament_settings: Dict[str, Any],
        overrides: Dict[str, Any],
        requested_filament_count: int,
    ) -> Dict[str, Any]:
        """Build config that preserves Bambu object->extruder assignments."""
        with zipfile.ZipFile(source_3mf, 'r') as zf:
            if 'Metadata/project_settings.config' in zf.namelist():
                base_config = json.loads(zf.read('Metadata/project_settings.config'))
            else:
                base_config = {}

        config: Dict[str, Any] = copy.deepcopy(base_config)

        # Overlay Snapmaker printer settings onto the Bambu base config.
        # We keep the Bambu project_settings as the foundation so that
        # OrcaSlicer can resolve Bambu format features (component assemblies,
        # plate definitions, etc.).  The printer profile provides all
        # machine-specific values: g-code macros, bed geometry, hardware
        # limits, nozzle config, and preset IDs.
        #
        # We overlay ALL printer keys to ensure Bambu hardware settings
        # (e.g. 180mm bed from A1 mini, Bambu bed_exclude_area) don't
        # leak through and cause issues on the Snapmaker 270mm bed.
        #
        # Keys from Bambu base that survive this overlay: anything NOT
        # in the Snapmaker printer profile (Bambu-specific format keys
        # that OrcaSlicer needs for multicolor resolution).
        config.update(copy.deepcopy(profiles.printer))

        # Override Bambu preset references with our Snapmaker presets.
        # OrcaSlicer looks up these IDs in its system presets and segfaults
        # when they don't exist (e.g., "Bambu Lab P1S 0.4 nozzle").
        printer_name = profiles.printer.get('name', 'Snapmaker U1 (0.4 nozzle) - multiplate')
        process_name = profiles.process.get('name', '0.20mm Standard @Snapmaker U1')
        config['printer_settings_id'] = printer_name
        config['print_settings_id'] = process_name
        config['default_print_profile'] = process_name
        config['print_compatible_printers'] = [printer_name]
        config.pop('inherits', None)
        config.pop('inherits_group', None)

        for key in ('time_lapse_gcode', 'machine_pause_gcode'):
            config.pop(key, None)

        config.update(copy.deepcopy(profiles.process))
        config.update(copy.deepcopy(profiles.filament))
        config.update(copy.deepcopy(filament_settings))
        config.update(copy.deepcopy(overrides))

        # Bambu multi-plate projects often store prime tower coordinates as
        # per-plate arrays. Replacing them with a scalar can be ignored by
        # Orca's toolchange path planning (it still uses the original plate
        # entry), which produces long fan-like travel paths when the tower is
        # moved. Preserve the array shape by replicating the requested value.
        self._preserve_bambu_wipe_tower_array_shape(config, base_config, overrides)

        config['layer_gcode'] = 'G92 E0'
        config.setdefault('enable_arc_fitting', '1')

        # Strip Bambu-specific filament_start_gcode.  Bambu macros like M142
        # and activate_air_filtration are not understood by Snapmaker firmware.
        fsg = config.get('filament_start_gcode')
        if isinstance(fsg, list) and any('M142' in str(g) or 'air_filtration' in str(g) for g in fsg):
            config.pop('filament_start_gcode', None)
            logger.info("Stripped Bambu-specific filament_start_gcode")

        self._sanitize_index_field(config, 'raft_first_layer_expansion', 0)
        self._sanitize_index_field(config, 'tree_support_wall_count', 0)
        self._sanitize_index_field(config, 'prime_volume', 0)
        self._sanitize_index_field(config, 'prime_tower_brim_width', 0)
        self._sanitize_index_field(config, 'prime_tower_brim_chamfer', 0)
        self._sanitize_index_field(config, 'prime_tower_brim_chamfer_max_width', 0)
        # Keep purge/prime tower safely inside bed bounds for U1 reliability.
        # Bambu multi-plate projects use per-plate wipe_tower_x/y arrays with
        # semantics that differ from Snapmaker's scalar fields. Applying the
        # generic clamp to those arrays can shift otherwise-valid plate tower
        # positions and break plate slices (e.g. Shashibo plate 6). Preserve
        # Bambu per-plate arrays as-is and only clamp scalar-style configs.
        if not self._has_bambu_per_plate_wipe_tower_arrays(base_config):
            self._sanitize_wipe_tower_position(config)
        self._sanitize_index_field(config, 'solid_infill_filament', 1)
        self._sanitize_index_field(config, 'sparse_infill_filament', 1)
        self._sanitize_index_field(config, 'wall_filament', 1)

        assigned_count = self._get_assigned_extruder_count(source_3mf)
        target_slots = max(assigned_count, requested_filament_count, 1)

        list_defaults = {
            'filament_type': ['PLA'],
            'filament_colour': ['#FFFFFF'],
            'extruder_colour': ['#FFFFFF'],
            'default_filament_profile': ['Snapmaker PLA'],
            'filament_settings_id': ['Snapmaker PLA'],
            'nozzle_temperature': ['210'],
            'nozzle_temperature_initial_layer': ['210'],
            'bed_temperature': ['60'],
            'bed_temperature_initial_layer': ['60'],
            'cool_plate_temp': ['60'],
            'cool_plate_temp_initial_layer': ['60'],
            'textured_plate_temp': ['60'],
            'textured_plate_temp_initial_layer': ['60'],
        }

        for key, fallback in list_defaults.items():
            values = self._ensure_list(config.get(key))
            if not values:
                values = list(fallback)
            config[key] = self._pad_list(values, target_slots, fallback[-1])

        bed_single = self._ensure_list(config.get('bed_temperature_initial_layer_single'))
        if not bed_single:
            bed_single = [config['bed_temperature_initial_layer'][0]]
        config['bed_temperature_initial_layer_single'] = bed_single

        # Painted files (per-triangle paint_color) require SEMM mode so Orca
        # reads the paint data and generates per-face tool changes.  Non-painted
        # multicolour files (per-object extruder assignments) don't need it.
        has_paint = self._has_paint_data_zip(source_3mf)
        if has_paint and target_slots > 1:
            config['single_extruder_multi_material'] = '1'
            # Ooze prevention is incompatible with SEMM + wipe tower
            config['ooze_prevention'] = '0'
            logger.info("Enabling SEMM mode for painted multicolour file")
        else:
            config['single_extruder_multi_material'] = '0'

        # Bambu configs use 'nil' for "use default".  Snapmaker OrcaSlicer
        # cannot parse 'nil' and segfaults at "Initializing StaticPrintConfigs".
        self._sanitize_nil_values(config)

        # Normalize all per-filament arrays to the same length.
        # Bambu configs may carry N-filament arrays (e.g. 5 for AMS) while our
        # settings use a different count.  Mismatched lengths segfault Orca at
        # "Initializing StaticPrintConfigs".
        self._normalize_per_filament_arrays(config, target_slots)

        logger.info(
            "Built assignment-preserving config with %s extruder slots "
            "(requested=%s, assigned=%s)",
            target_slots,
            requested_filament_count,
            assigned_count,
        )
        return config

    @staticmethod
    def _strip_flow_calibrate(gcode: str) -> str:
        """Remove SM_PRINT_FLOW_CALIBRATE blocks from machine_start_gcode.

        Each block is wrapped in {if (is_extruder_used[N])}...{endif} conditionals.
        Also removes the section comment header.
        """
        # Remove each {if}...SM_PRINT_FLOW_CALIBRATE...{endif} block
        gcode = re.sub(
            r'\{if \(is_extruder_used\[\d+\]\)\}\n'
            r'SM_PRINT_FLOW_CALIBRATE[^\n]*\n'
            r'\{endif\}\n?',
            '',
            gcode,
        )
        # Remove the section comment header
        gcode = re.sub(
            r';=+ 挤出流量\s+=+\n',
            '',
            gcode,
        )
        return gcode

    def embed_profiles(self,
                       source_3mf: Path,
                       output_3mf: Path,
                       filament_settings: Dict[str, Any],
                       overrides: Dict[str, Any],
                       requested_filament_count: int = 1,
                       extruder_remap: Dict[int, int] | None = None,
                       preserve_geometry: bool = False,
                       precomputed_is_bambu: Optional[bool] = None,
                       precomputed_has_multi_assignments: Optional[bool] = None,
                       precomputed_has_layer_changes: Optional[bool] = None,
                       enable_flow_calibrate: bool = True,
                       bambu_plate_id: Optional[int] = None) -> Path:
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
        working_3mf = source_3mf
        try:
            logger.info(f"Embedding profiles into {source_3mf.name}")

            profiles = self.load_snapmaker_profiles()

            # Check if this is a Bambu file that needs rebuilding
            # Use precomputed values when available (avoids redundant ZIP opens)
            preserve_model_settings_from = None
            is_bambu = precomputed_is_bambu if precomputed_is_bambu is not None else self._is_bambu_file(source_3mf)
            has_multi_assignments = precomputed_has_multi_assignments if precomputed_has_multi_assignments is not None else self._has_multi_extruder_assignments(source_3mf)
            has_layer_changes = precomputed_has_layer_changes if precomputed_has_layer_changes is not None else self._has_layer_tool_changes(source_3mf)

            # Use assignment-preserving path for Bambu multicolor files that
            # have actual per-object extruder assignments or per-triangle paint
            # data.  The trimesh rebuild path strips these, producing a plain
            # single-colour mesh.
            #
            # Use the assignment-preserving path for Bambu multicolor files:
            # - Multi-extruder assignments: per-object/per-part extruder mapping
            # - Layer tool changes (MultiAsSingle): mid-print filament swaps
            # - Per-triangle paint data: SEMM mode needed
            #
            # The trimesh path can't be used for multi-plate Bambu files because
            # it exports ALL objects from ALL plates with Bambu global coordinates
            # (100s-1000s of mm from origin), causing segfaults or "Nothing to
            # be sliced".  The flatten approach preserves plate structure.
            needs_preserve = has_multi_assignments or has_layer_changes
            if not needs_preserve and is_bambu and requested_filament_count > 1:
                # Also check for per-triangle paint data (needs SEMM mode)
                needs_preserve = self._has_paint_data_zip(source_3mf)

            if is_bambu and needs_preserve:
                reason = (
                    "layer-based tool changes" if has_layer_changes
                    else "model extruder assignments" if has_multi_assignments
                    else "per-triangle paint data"
                )
                logger.info(
                    f"Detected Bambu multicolor file with {reason} - "
                    "preserving extruder assignments"
                )
                config = self._build_assignment_preserving_config(
                    source_3mf=source_3mf,
                    profiles=profiles,
                    filament_settings=filament_settings,
                    overrides=overrides,
                    requested_filament_count=requested_filament_count,
                )
                if not enable_flow_calibrate and 'machine_start_gcode' in config:
                    config['machine_start_gcode'] = self._strip_flow_calibrate(config['machine_start_gcode'])
                    logger.info("Stripped SM_PRINT_FLOW_CALIBRATE blocks (flow calibration disabled)")
                settings_json = json.dumps(config, indent=2)

                # Pass original Bambu 3MF directly to OrcaSlicer.
                # The --allow-newer-file flag lets Orca load Bambu format
                # extensions (component assemblies, multi-file refs, plate
                # definitions).  This preserves per-part extruder assignments
                # for multicolor output.  Only the project_settings.config
                # is replaced with our hybrid Bambu+Snapmaker config.
                self._copy_and_inject_settings(
                    source_3mf,
                    output_3mf,
                    settings_json,
                    preserve_model_settings_from=None,
                    extruder_remap=extruder_remap,
                )

                logger.info(f"Successfully embedded profiles into {output_3mf.name}")
                return output_3mf

            if is_bambu:
                # Bambu multi-file component references (p:path) crash Snapmaker
                # OrcaSlicer v2.2.4 when combined with our Snapmaker settings.
                # Always flatten via trimesh regardless of preserve_geometry.
                logger.info("Detected Bambu Studio file - rebuilding with trimesh")
                temp_clean = source_3mf.parent / f"{source_3mf.stem}_clean_{uuid.uuid4().hex[:8]}.3mf"
                self._rebuild_with_trimesh(source_3mf, temp_clean)
                working_3mf = temp_clean

            # Merge all settings (deep copy to avoid mutating cached profiles)
            config = copy.deepcopy({
                **profiles.printer,
                **profiles.process,
                **profiles.filament,
                **filament_settings,
                **overrides
            })

            # Ensure layer_gcode for relative extruder addressing
            if 'layer_gcode' not in config:
                config['layer_gcode'] = 'G92 E0'

            # Ensure arc fitting to reduce G-code file size
            if 'enable_arc_fitting' not in config:
                config['enable_arc_fitting'] = '1'

            # Override preset references — OrcaSlicer looks these up in its
            # system presets and segfaults when they don't exist.  Also strip
            # 'inherits' which triggers system-preset lookups.
            printer_name = profiles.printer.get('name', 'Snapmaker U1 (0.4 nozzle) - multiplate')
            process_name = profiles.process.get('name', '0.20mm Standard @Snapmaker U1')
            config['printer_settings_id'] = printer_name
            config['print_settings_id'] = process_name
            config['default_print_profile'] = process_name
            config['print_compatible_printers'] = [printer_name]
            config.pop('inherits', None)
            config.pop('inherits_group', None)

            # Strip Bambu-specific filament_start_gcode (from slicer_settings
            # imported from Bambu profiles).  Bambu macros like M142 and
            # activate_air_filtration are not understood by Snapmaker firmware.
            fsg = config.get('filament_start_gcode')
            if isinstance(fsg, list) and any('M142' in str(g) or 'air_filtration' in str(g) for g in fsg):
                config.pop('filament_start_gcode', None)
                logger.info("Stripped Bambu-specific filament_start_gcode")

            # Strip time-lapse and pause gcode (Bambu-specific)
            for key in ('time_lapse_gcode', 'machine_pause_gcode'):
                config.pop(key, None)

            logger.debug(f"Merged config with {len(config)} keys")

            # Sanitize 'nil' values from Bambu filament profiles (slicer_settings
            # imported from Bambu profiles can carry 'nil' for "use default").
            self._sanitize_nil_values(config)

            # Pad per-filament arrays to match requested_filament_count.
            # Orca indexes per-filament arrays by filament number; if filament_colour
            # indicates N filaments but other arrays are length 1, Orca reads past
            # bounds and segfaults at "Initializing StaticPrintConfigs".
            if requested_filament_count > 1:
                self._pad_per_filament_arrays(config, requested_filament_count)

            # Normalize all per-filament arrays to the same length.
            # Mixed array sizes (e.g. 2 from slicer_settings, 4 from padded
            # temps) cause OrcaSlicer to read out of bounds and crash.
            # Use filament_colour length as authoritative (determines slicer
            # filament count), falling back to requested_filament_count.
            fc = config.get('filament_colour')
            target_slots = len(fc) if isinstance(fc, list) and fc else max(requested_filament_count, 1)
            self._normalize_per_filament_arrays(config, target_slots)

            if not enable_flow_calibrate and 'machine_start_gcode' in config:
                config['machine_start_gcode'] = self._strip_flow_calibrate(config['machine_start_gcode'])
                logger.info("Stripped SM_PRINT_FLOW_CALIBRATE blocks (flow calibration disabled)")

            # Create JSON settings
            settings_json = json.dumps(config, indent=2)

            # Copy and modify 3MF (use working_3mf which may be cleaned version)
            self._copy_and_inject_settings(
                working_3mf,
                output_3mf,
                settings_json,
                preserve_model_settings_from=preserve_model_settings_from,
                extruder_remap=extruder_remap,
            )

            # For Bambu MultiAsSingle files that went through trimesh:
            # inject the custom_gcode_per_layer.xml so OrcaSlicer emits the
            # mid-print tool change.  The plate ID is remapped to 1 (trimesh
            # creates a single-plate file).
            if is_bambu and has_layer_changes and not needs_preserve and bambu_plate_id is not None:
                self._inject_custom_gcode(source_3mf, output_3mf, bambu_plate_id)

            # Clean up temporary clean 3MF if we created one
            if working_3mf != source_3mf and working_3mf.exists():
                working_3mf.unlink()
                logger.debug(f"Cleaned up temporary file: {working_3mf.name}")

            logger.info(f"Successfully embedded profiles into {output_3mf.name}")
            return output_3mf

        except Exception as e:
            # Clean up temporary files on error
            temp_working = locals().get('working_3mf')
            if isinstance(temp_working, Path) and temp_working != source_3mf and temp_working.exists():
                temp_working.unlink()
            logger.error(f"Failed to embed profiles: {str(e)}")
            raise ProfileEmbedError(f"Profile embedding failed: {str(e)}") from e

    @staticmethod
    def _inject_custom_gcode(
        source_3mf: Path,
        output_3mf: Path,
        bambu_plate_id: int,
    ) -> None:
        """Inject custom_gcode_per_layer.xml from a Bambu source into a
        trimesh-rebuilt output 3MF.

        Extracts the MultiAsSingle tool-change entries for the specified
        Bambu plate and remaps them to plate 1 (since trimesh creates a
        single-plate file).
        """
        try:
            with zipfile.ZipFile(source_3mf, 'r') as zf:
                if 'Metadata/custom_gcode_per_layer.xml' not in zf.namelist():
                    return
                src_xml = zf.read('Metadata/custom_gcode_per_layer.xml')

            root = ET.fromstring(src_xml)
            target_plate = None
            for plate in root.findall('plate'):
                info = plate.find('plate_info')
                if info is not None and info.get('id') == str(bambu_plate_id):
                    target_plate = plate
                    break

            if target_plate is None:
                logger.debug(
                    f"No custom_gcode for Bambu plate {bambu_plate_id}"
                )
                return

            # Remap to plate 1 for our single-plate trimesh output
            info_elem = target_plate.find('plate_info')
            if info_elem is not None:
                info_elem.set('id', '1')

            # Build new custom_gcode XML with just this plate
            new_root = ET.Element('custom_gcodes_per_layer')
            new_root.append(target_plate)
            custom_gcode_bytes = ET.tostring(
                new_root, encoding='utf-8', xml_declaration=True
            )

            # Inject into the output 3MF
            temp_zip = output_3mf.with_suffix('.tmp_cgc')
            with zipfile.ZipFile(output_3mf, 'r') as zin:
                with zipfile.ZipFile(temp_zip, 'w', zipfile.ZIP_DEFLATED) as zout:
                    for item in zin.infolist():
                        if item.filename == 'Metadata/custom_gcode_per_layer.xml':
                            continue  # Replace
                        zout.writestr(item, zin.read(item.filename))
                    zout.writestr(
                        'Metadata/custom_gcode_per_layer.xml',
                        custom_gcode_bytes,
                    )
            temp_zip.replace(output_3mf)
            logger.info(
                f"Injected MultiAsSingle custom_gcode from Bambu plate "
                f"{bambu_plate_id} (remapped to plate 1)"
            )
        except Exception as e:
            logger.warning(f"Failed to inject custom_gcode: {e}")

    async def embed_profiles_async(self, **kwargs) -> Path:
        """Async version of embed_profiles — runs in thread pool to avoid blocking the event loop."""
        return await asyncio.to_thread(self.embed_profiles, **kwargs)

    @staticmethod
    def _parse_printable_area_center(printable_area) -> Optional[tuple]:
        """Parse printable_area polygon and return its center (cx, cy).

        printable_area is a list like ['-0.5x-1', '270.5x-1', '270.5x271', '-0.5x271']
        where each entry is 'XxY'.
        """
        if not isinstance(printable_area, list) or len(printable_area) < 3:
            return None
        xs, ys = [], []
        for pt in printable_area:
            parts = str(pt).split('x')
            if len(parts) != 2:
                return None
            try:
                xs.append(float(parts[0]))
                ys.append(float(parts[1]))
            except ValueError:
                return None
        if not xs:
            return None
        return ((min(xs) + max(xs)) / 2.0, (min(ys) + max(ys)) / 2.0)

    @staticmethod
    def _recenter_build_items(model_bytes: bytes, dx: float, dy: float) -> bytes:
        """Shift all build item transforms by (dx, dy) to recenter objects on the new bed.

        3MF build item transforms are 3x4 affine matrices stored as 12 space-separated
        floats: m00 m01 m02 m10 m11 m12 m20 m21 m22 tx ty tz. Indices 9,10 are XY translation.
        """
        if abs(dx) < 0.001 and abs(dy) < 0.001:
            return model_bytes
        try:
            model_xml = model_bytes.decode('utf-8')
        except UnicodeDecodeError:
            return model_bytes

        # Only patch <item> tags inside the <build> section.
        build_re = re.compile(
            r'(?P<open><(?:(?P<prefix>[A-Za-z_][\w.\-]*):)?build\b[^>]*>)'
            r'(?P<body>.*?)'
            r'(?P<close></(?:(?P=prefix):)?build\s*>)',
            re.DOTALL,
        )
        item_re = re.compile(r'<(?:(?P<prefix>[A-Za-z_][\w.\-]*):)?item\b(?P<attrs>[^>]*)/?>')
        transform_re = re.compile(r'(\stransform\s*=\s*)(["\'])(.*?)\2')

        def patch_item(m):
            tag = m.group(0)
            tm = transform_re.search(tag)
            if not tm:
                return tag
            vals = tm.group(3).split()
            if len(vals) != 12:
                return tag
            try:
                vals[9] = str(float(vals[9]) + dx)
                vals[10] = str(float(vals[10]) + dy)
            except ValueError:
                return tag
            new_t = ' '.join(vals)
            return transform_re.sub(
                lambda mm: f'{mm.group(1)}{mm.group(2)}{new_t}{mm.group(2)}',
                tag, count=1,
            )

        def patch_build(m):
            body = item_re.sub(patch_item, m.group('body'))
            return m.group('open') + body + m.group('close')

        patched = build_re.sub(patch_build, model_xml)
        return patched.encode('utf-8')

    @staticmethod
    def _recenter_assemble_items(ms_bytes: bytes, dx: float, dy: float) -> bytes:
        """Shift assemble_item transforms in model_settings.config by (dx, dy)."""
        if abs(dx) < 0.001 and abs(dy) < 0.001:
            return ms_bytes
        try:
            ms_xml = ms_bytes.decode('utf-8')
        except UnicodeDecodeError:
            return ms_bytes

        assemble_re = re.compile(r'<assemble_item\b(?P<attrs>[^>]*)/?>')
        transform_re = re.compile(r'(\stransform\s*=\s*)(["\'])(.*?)\2')

        def patch_assemble(m):
            tag = m.group(0)
            tm = transform_re.search(tag)
            if not tm:
                return tag
            vals = tm.group(3).split()
            if len(vals) != 12:
                return tag
            try:
                vals[9] = str(float(vals[9]) + dx)
                vals[10] = str(float(vals[10]) + dy)
            except ValueError:
                return tag
            new_t = ' '.join(vals)
            return transform_re.sub(
                lambda mm: f'{mm.group(1)}{mm.group(2)}{new_t}{mm.group(2)}',
                tag, count=1,
            )

        return assemble_re.sub(patch_assemble, ms_xml).encode('utf-8')

    def _copy_and_inject_settings(
        self,
        source: Path,
        dest: Path,
        settings_json: str,
        preserve_model_settings_from: Path | None = None,
        extruder_remap: Dict[int, int] | None = None,
    ):
        """Copy 3MF and add/update project_settings.config.

        Args:
            source: Source 3MF path
            dest: Destination 3MF path
            settings_json: JSON string to write to Metadata/project_settings.config
        """
        # Create temporary ZIP for rebuilding
        temp_zip = dest.with_suffix('.tmp')

        # Compute bed recenter delta: when the bed size changes, shift build items
        # so they maintain the same relative position on the new bed.
        recenter_dx, recenter_dy = 0.0, 0.0
        try:
            target_config = json.loads(settings_json)
            target_center = self._parse_printable_area_center(target_config.get('printable_area'))
        except Exception:
            target_center = None

        try:
            # Bambu Studio metadata files that are safe to drop
            bambu_metadata_files = {
                'Metadata/project_settings.config',  # We'll replace this
                'Metadata/slice_info.config',        # Bambu-specific
                'Metadata/cut_information.xml',      # Bambu-specific
                'Metadata/filament_sequence.json',   # Bambu-specific (can crash Orca)
            }

            with zipfile.ZipFile(source, 'r') as source_zf:
                # Read source bed center from existing project_settings
                if target_center is not None and 'Metadata/project_settings.config' in source_zf.namelist():
                    try:
                        src_config = json.loads(source_zf.read('Metadata/project_settings.config'))
                        src_center = self._parse_printable_area_center(src_config.get('printable_area'))
                        if src_center is not None:
                            recenter_dx = target_center[0] - src_center[0]
                            recenter_dy = target_center[1] - src_center[1]
                            if abs(recenter_dx) > 0.5 or abs(recenter_dy) > 0.5:
                                logger.info(
                                    f"Recentering build items: bed center {src_center} → {target_center}, "
                                    f"delta=({recenter_dx:.1f}, {recenter_dy:.1f})"
                                )
                            else:
                                recenter_dx, recenter_dy = 0.0, 0.0
                    except Exception as e:
                        logger.debug(f"Could not read source printable_area for recentering: {e}")

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
                        if item.filename == 'Metadata/model_settings.config':
                            data = self._sanitize_model_settings(data, extruder_remap=extruder_remap)
                            data = self._recenter_assemble_items(data, recenter_dx, recenter_dy)
                        if item.filename == '3D/3dmodel.model':
                            data = self._recenter_build_items(data, recenter_dx, recenter_dy)
                        dest_zf.writestr(item, data)

                    # Add new project_settings.config
                    dest_zf.writestr('Metadata/project_settings.config', settings_json)
                    logger.debug("Injected new project_settings.config")

                    # Optionally preserve model_settings.config from original 3MF
                    if preserve_model_settings_from is not None and preserve_model_settings_from != source:
                        try:
                            with zipfile.ZipFile(preserve_model_settings_from, 'r') as original_zf:
                                if 'Metadata/model_settings.config' in original_zf.namelist():
                                    model_settings = original_zf.read('Metadata/model_settings.config')
                                    model_settings = self._sanitize_model_settings(model_settings, extruder_remap=extruder_remap)
                                    dest_zf.writestr('Metadata/model_settings.config', model_settings)
                                    logger.debug("Preserved Metadata/model_settings.config from original file")
                        except Exception as e:
                            logger.warning(f"Could not preserve model_settings.config: {e}")

            # Replace destination with temp file
            temp_zip.replace(dest)

        except Exception as e:
            # Clean up temp file on error
            if temp_zip.exists():
                temp_zip.unlink()
            raise

    @staticmethod
    def _sanitize_model_settings(
        model_settings_bytes: bytes,
        extruder_remap: Dict[int, int] | None = None,
        bed_center_mm: float = 135.0,
    ) -> bytes:
        """Sanitize model_settings metadata known to trigger Orca instability.

        Some Bambu exports keep stale plate names in `plater_name` when objects are
        moved between/deleted plates. Snapmaker Orca v2.2.4 can segfault on those.

        Also recenters assemble_item transforms so objects land on the bed.
        Bambu multi-plate files use global coordinates where off-plate objects
        can be hundreds or thousands of mm away from origin, causing
        "Nothing to be sliced" errors on smaller beds like the 270mm Snapmaker U1.
        """
        try:
            root = ET.fromstring(model_settings_bytes)
            changed = False
            for meta in root.findall('.//metadata'):
                if meta.get('key') == 'plater_name' and (meta.get('value') or ''):
                    meta.set('value', '')
                    changed = True

                if extruder_remap and meta.get('key') == 'extruder':
                    raw = (meta.get('value') or '').strip()
                    if raw.isdigit():
                        src_ext = int(raw)
                        dst_ext = extruder_remap.get(src_ext)
                        if dst_ext is not None and 1 <= dst_ext <= 4 and dst_ext != src_ext:
                            meta.set('value', str(dst_ext))
                            changed = True

            # Fix assemble_item transforms for Bambu multi-plate files.
            # Bambu encodes multi-plate layout via assemble_item transforms with
            # global coordinates (x=1000s) and vertical stacking (z=62mm, 125mm).
            # These don't map to our single-plate 270mm bed.
            # Fix: recenter x,y to bed center and reset z=0 for packed coords.
            # Threshold: only catch genuinely packed coordinates (|coord| > bed_size + margin).
            # Bed-center origin files can have valid negative coords (e.g. -0.145 for an
            # object near center of a 180mm bed), so tx < 0 alone is NOT sufficient.
            packed_threshold = bed_center_mm * 2 + 100  # 370mm for Snapmaker
            for assemble in root.findall('.//assemble'):
                for item in assemble.findall('assemble_item'):
                    tfm = item.get('transform', '')
                    vals = tfm.split()
                    if len(vals) == 12:
                        try:
                            tx = float(vals[9])
                            ty = float(vals[10])
                            if abs(tx) > packed_threshold or abs(ty) > packed_threshold:
                                vals[9] = f"{bed_center_mm:.6f}"
                                vals[10] = f"{bed_center_mm:.6f}"
                                vals[11] = "0"
                            item.set('transform', ' '.join(vals))
                            changed = True
                        except ValueError:
                            pass

            if changed:
                logger.info("Sanitized model_settings metadata")
                return ET.tostring(root, encoding='utf-8', xml_declaration=True)
        except Exception as e:
            logger.warning(f"Could not sanitize model_settings.config: {e}")

        return model_settings_bytes

    # Module-level profile cache (profiles are static within a Docker image)
    _cached_profiles: Optional[ProfileSettings] = None
    _cached_profiles_dir: Optional[Path] = None

    def load_snapmaker_profiles(self) -> ProfileSettings:
        """Load default Snapmaker U1 profiles from JSON files.

        Returns cached profiles on subsequent calls (files are static in Docker).

        Returns:
            ProfileSettings with printer, process, and filament configs

        Raises:
            ProfileEmbedError: If profiles cannot be loaded
        """
        if (ProfileEmbedder._cached_profiles is not None
                and ProfileEmbedder._cached_profiles_dir == self.profile_dir):
            return ProfileEmbedder._cached_profiles

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

            logger.info(f"Loaded and cached profiles: {printer_path.name}, {process_path.name}, {filament_path.name}")

            ProfileEmbedder._cached_profiles = ProfileSettings(printer=printer, process=process, filament=filament)
            ProfileEmbedder._cached_profiles_dir = self.profile_dir
            return ProfileEmbedder._cached_profiles

        except FileNotFoundError as e:
            raise ProfileEmbedError(f"Profile file not found: {e.filename}")
        except json.JSONDecodeError as e:
            raise ProfileEmbedError(f"Invalid JSON in profile: {str(e)}")
