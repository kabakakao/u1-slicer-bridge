"""Plate bounds validation for 3MF files.

Validates that the entire plate layout fits within the printer's build volume.
"""

import trimesh
import logging
from pathlib import Path
from typing import Dict, Any, List
from config import PrinterProfile


logger = logging.getLogger(__name__)


class PlateValidationError(Exception):
    """Raised when plate validation fails."""
    pass


class PlateValidator:
    """Validates 3MF plate layouts against printer build volume."""

    def __init__(self, printer_profile: PrinterProfile):
        """Initialize validator with printer profile.

        Args:
            printer_profile: PrinterProfile with build volume limits
        """
        self.printer = printer_profile
        logger.info(f"PlateValidator initialized for {printer_profile.name}")

    def validate_3mf_bounds(self, file_path: Path) -> Dict[str, Any]:
        """Load entire 3MF as scene and calculate overall bounding box.

        Args:
            file_path: Path to .3mf file

        Returns:
            Dictionary containing:
            - bounds: {min: [x,y,z], max: [x,y,z], size: [w,d,h]}
            - warnings: List of warning messages
            - fits: Boolean indicating if plate fits in build volume

        Raises:
            PlateValidationError: If 3MF cannot be loaded
        """
        try:
            logger.info(f"Validating plate bounds for {file_path.name}")

            # Load entire scene (all objects with their transforms)
            scene = trimesh.load(str(file_path), file_type='3mf')

            # Get combined bounding box for entire scene
            # bounds = [[min_x, min_y, min_z], [max_x, max_y, max_z]]
            bounds = scene.bounds

            # Calculate dimensions
            width = float(bounds[1][0] - bounds[0][0])
            depth = float(bounds[1][1] - bounds[0][1])
            height = float(bounds[1][2] - bounds[0][2])

            logger.info(f"Plate dimensions: {width:.1f}x{depth:.1f}x{height:.1f}mm")

            # Check against printer build volume limits
            warnings = self._check_build_volume(width, depth, height)

            # Check for objects below bed (Z < 0)
            if bounds[0][2] < -0.001:  # Tolerance for floating point
                warnings.append(
                    f"Warning: Objects extend below bed (Z_min = {bounds[0][2]:.1f}mm). "
                    "This may cause printing issues."
                )

            result = {
                "bounds": {
                    "min": bounds[0].tolist(),
                    "max": bounds[1].tolist(),
                    "size": [width, depth, height]
                },
                "warnings": warnings,
                "fits": len(warnings) == 0
            }

            if warnings:
                logger.warning(f"Plate validation warnings: {'; '.join(warnings)}")
            else:
                logger.info("Plate fits within build volume")

            return result

        except Exception as e:
            logger.error(f"Failed to validate plate bounds: {str(e)}")
            raise PlateValidationError(f"Could not validate plate: {str(e)}") from e

    def _check_build_volume(self, width: float, depth: float, height: float) -> List[str]:
        """Check dimensions against build volume and generate warnings.

        Args:
            width: X dimension in mm
            depth: Y dimension in mm
            height: Z dimension in mm

        Returns:
            List of warning messages (empty if all dimensions OK)
        """
        warnings = []

        # Check X (width)
        if width > self.printer.build_volume_x:
            warnings.append(
                f"Width exceeds build volume: {width:.1f}mm > {self.printer.build_volume_x:.1f}mm (X-axis)"
            )

        # Check Y (depth)
        if depth > self.printer.build_volume_y:
            warnings.append(
                f"Depth exceeds build volume: {depth:.1f}mm > {self.printer.build_volume_y:.1f}mm (Y-axis)"
            )

        # Check Z (height)
        if height > self.printer.build_volume_z:
            warnings.append(
                f"Height exceeds build volume: {height:.1f}mm > {self.printer.build_volume_z:.1f}mm (Z-axis)"
            )

        return warnings
