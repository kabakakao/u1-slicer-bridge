"""STL to 3MF conversion using trimesh.

Converts uploaded STL files to 3MF format so they can enter the existing
plate-based slicing pipeline. Single-filament only.
"""

import io
import uuid
import logging
from pathlib import Path

import trimesh

logger = logging.getLogger(__name__)

UPLOAD_DIR = Path("/data/uploads")


class STLConversionError(Exception):
    """Raised when STL to 3MF conversion fails."""
    pass


def convert_stl_to_3mf(stl_content: bytes, original_filename: str) -> dict:
    """Convert STL file bytes to a 3MF file on disk.

    Args:
        stl_content: Raw bytes of the uploaded STL file.
        original_filename: Original filename for naming the output.

    Returns:
        Dict with file_path (Path), vertex_count (int), face_count (int).

    Raises:
        STLConversionError: If loading or conversion fails.
    """
    try:
        mesh = trimesh.load(
            io.BytesIO(stl_content),
            file_type='stl',
        )

        # trimesh may return a Scene for multi-body STLs — flatten
        if isinstance(mesh, trimesh.Scene):
            geometries = list(mesh.geometry.values())
            if not geometries:
                raise STLConversionError("STL file contains no geometry")
            mesh = trimesh.util.concatenate(geometries)

        if not hasattr(mesh, 'vertices') or len(mesh.vertices) == 0:
            raise STLConversionError("STL file contains no vertices")
        if not hasattr(mesh, 'faces') or len(mesh.faces) == 0:
            raise STLConversionError("STL file contains no faces")

        # Generate output path matching 3MF upload naming convention
        file_id = uuid.uuid4().hex[:12]
        stem = Path(original_filename).stem
        output_path = UPLOAD_DIR / f"{file_id}_{stem}.3mf"

        # Export as 3MF via trimesh (same pattern as _rebuild_with_trimesh)
        scene = trimesh.Scene(mesh)
        scene.export(str(output_path), file_type='3mf')

        logger.info(
            f"Converted STL to 3MF: {original_filename} -> {output_path.name} "
            f"({len(mesh.vertices)} verts, {len(mesh.faces)} faces, "
            f"{output_path.stat().st_size / 1024:.0f} KB)"
        )

        return {
            "file_path": output_path,
            "vertex_count": len(mesh.vertices),
            "face_count": len(mesh.faces),
        }

    except STLConversionError:
        raise
    except Exception as e:
        raise STLConversionError(f"Failed to convert STL: {e}") from e
