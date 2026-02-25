"""Render multi-angle preview images of a G-code file.

Streams through G-code line-by-line collecting extrusion segments with 3D
coordinates, then projects them from multiple viewpoints onto a composite
image.  Memory usage is O(segments) which is much less than O(gcode_lines)
since travel moves, comments, and control lines are discarded.

Layout: one large 3D perspective view with two smaller orthographic insets
(top-down and front/side).

Supports multi-tool coloring (T0, T1, ...) using the filament_colors list.
"""

import re
import math
import logging
from pathlib import Path
from typing import List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger(__name__)

# Regex patterns
COORD_RE = re.compile(r'([XYZEF])([-+]?\d*\.?\d+)')
ARC_OFFSET_RE = re.compile(r'([IJ])([-+]?\d*\.?\d+)')

# Default colors (vibrant, distinct — used when filament_colors not provided)
DEFAULT_TOOL_COLORS = [
    (59, 130, 246),   # Blue
    (239, 68, 68),    # Red
    (34, 197, 94),    # Green
    (234, 179, 8),    # Yellow
    (168, 85, 247),   # Purple
    (236, 72, 153),   # Pink
    (20, 184, 166),   # Teal
    (249, 115, 22),   # Orange
]

BED_SIZE = 270  # Snapmaker U1 bed size in mm


def hex_to_rgb(hex_color: str) -> Tuple[int, int, int]:
    """Convert '#rrggbb' to (r, g, b) tuple."""
    h = hex_color.lstrip('#')
    if len(h) == 3:
        h = h[0]*2 + h[1]*2 + h[2]*2
    try:
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except (ValueError, IndexError):
        return (59, 130, 246)  # Fallback blue


def _build_tool_colors(
    filament_colors: Optional[List[str]],
) -> List[Tuple[int, int, int]]:
    """Build RGB tool color palette from hex strings."""
    if not filament_colors:
        return list(DEFAULT_TOOL_COLORS)
    tool_colors = []
    for c in filament_colors:
        if isinstance(c, str) and c.startswith('#'):
            rgb = hex_to_rgb(c)
            # Ensure dark colors are visible against dark background
            if rgb[0] + rgb[1] + rgb[2] < 80:
                rgb = (max(rgb[0], 60), max(rgb[1], 60), max(rgb[2], 60))
            tool_colors.append(rgb)
        else:
            tool_colors.append(
                DEFAULT_TOOL_COLORS[len(tool_colors) % len(DEFAULT_TOOL_COLORS)]
            )
    return tool_colors


# ---------------------------------------------------------------------------
# G-code parsing — collect 3D extrusion segments
# ---------------------------------------------------------------------------

def _parse_segments(gcode_path: Path):
    """Parse G-code and return extrusion segments, travel segments, and max Z.

    Returns:
        (extrusions, travels, max_z) where each segment is
        (x1, y1, z1, x2, y2, z2, tool_idx).
        Travels are decimated (1-in-N) to keep memory reasonable.
    """
    extrusions = []
    travels = []
    x, y, z, e = 0.0, 0.0, 0.0, 0.0
    absolute_pos = True
    absolute_ext = False
    current_tool = 0
    max_z = 0.0
    travel_count = 0
    TRAVEL_DECIMATE = 10  # Keep 1 in N travel moves

    with open(gcode_path, 'r', encoding='utf-8', errors='replace') as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line[0] == ';':
                continue
            if ';' in line:
                line = line[:line.index(';')].strip()
                if not line:
                    continue

            first = line[0]

            # Tool change
            if first == 'T' and len(line) >= 2 and line[1].isdigit():
                try:
                    current_tool = int(line[1:].split()[0])
                except (ValueError, IndexError):
                    pass
                continue

            # Positioning modes
            if line.startswith('G90'):
                absolute_pos = True
                continue
            elif line.startswith('G91'):
                absolute_pos = False
                continue
            elif line.startswith('M82'):
                absolute_ext = True
                continue
            elif line.startswith('M83'):
                absolute_ext = False
                continue

            # Position reset
            if line.startswith('G92'):
                coords = dict(COORD_RE.findall(line))
                if 'X' in coords: x = float(coords['X'])
                if 'Y' in coords: y = float(coords['Y'])
                if 'Z' in coords: z = float(coords['Z'])
                if 'E' in coords: e = float(coords['E'])
                continue

            # Movement commands: G0, G1, G2, G3
            is_move = False
            if first == 'G' and len(line) >= 2:
                if line[1] in ('0', '1') and (len(line) == 2 or line[2] in (' ', '\t')):
                    is_move = True
                elif line[1] in ('2', '3') and (len(line) == 2 or line[2] in (' ', '\t')):
                    is_move = True

            if not is_move:
                continue

            coords = dict(COORD_RE.findall(line))
            prev_x, prev_y, prev_z, prev_e = x, y, z, e

            if 'X' in coords:
                x = float(coords['X']) if absolute_pos else x + float(coords['X'])
            if 'Y' in coords:
                y = float(coords['Y']) if absolute_pos else y + float(coords['Y'])
            if 'Z' in coords:
                z = float(coords['Z']) if absolute_pos else z + float(coords['Z'])
            if 'E' in coords:
                new_e = float(coords['E'])
                e = new_e if absolute_ext else e + new_e

            # Skip moves with no XY displacement
            if abs(x - prev_x) < 0.001 and abs(y - prev_y) < 0.001:
                continue

            if e > prev_e:
                # Extrusion move
                extrusions.append((prev_x, prev_y, prev_z, x, y, z, current_tool))
                if z > max_z:
                    max_z = z
            else:
                # Travel move — decimate to keep memory reasonable
                travel_count += 1
                if travel_count % TRAVEL_DECIMATE == 0:
                    travels.append((prev_x, prev_y, prev_z, x, y, z, current_tool))

    return extrusions, travels, max_z


# ---------------------------------------------------------------------------
# Projection helpers
# ---------------------------------------------------------------------------

def _project_iso(
    gx: float, gy: float, gz: float,
    cx: float, cy: float,
    scale: float, ox: float, oy: float, view_h: float,
) -> Tuple[float, float]:
    """Isometric-ish 3D projection (30° elevation, 45° rotation).

    Center the bed at (cx, cy, 0), apply rotation, then simple oblique
    projection so height (Z) shifts points up and slightly back.
    """
    # Center on bed
    rx = gx - cx
    ry = gy - cy

    # Rotate 45° around Z for a nice corner view
    cos45 = 0.7071
    sin45 = 0.7071
    rx2 = rx * cos45 - ry * sin45
    ry2 = rx * sin45 + ry * cos45

    # Project: X → horizontal, Y+Z → vertical (oblique cabinet-style)
    # ry2 contributes depth (scaled down), gz contributes height
    px = ox + rx2 * scale
    py = oy - (ry2 * scale * 0.5 + gz * scale)

    return (px, py)


def _project_top(
    gx: float, gy: float,
    scale: float, margin: float, panel_size: float,
) -> Tuple[float, float]:
    """Top-down orthographic projection (XY plane)."""
    px = margin + gx * scale
    py = panel_size - margin - gy * scale
    return (px, py)


def _project_front(
    gx: float, gz: float,
    scale: float, margin: float, panel_w: float, panel_h: float,
) -> Tuple[float, float]:
    """Front view orthographic projection (XZ plane)."""
    px = margin + gx * scale
    py = panel_h - margin - gz * scale
    return (px, py)


# ---------------------------------------------------------------------------
# Main render function
# ---------------------------------------------------------------------------

def render_gcode_image(
    gcode_path: Path,
    image_size: int = 800,
    filament_colors: Optional[List[str]] = None,
    background_color: Tuple[int, int, int] = (26, 26, 26),
    line_width: int = 1,
) -> Image.Image:
    """Render a multi-angle preview of a G-code file.

    Layout (landscape):
      ┌────────────────────┬───────────┐
      │                    │  Top-down │
      │   3D perspective   ├───────────┤
      │                    │   Front   │
      └────────────────────┴───────────┘

    Args:
        gcode_path: Path to .gcode file
        image_size: Height of the output image in pixels.
                    Width is 1.5× height for the landscape layout.
        filament_colors: List of hex color strings
        background_color: RGB background color
        line_width: Line width in pixels

    Returns:
        PIL Image with composite multi-angle preview
    """
    tool_colors = _build_tool_colors(filament_colors)
    TRAVEL_COLOR = (60, 40, 40)  # Dim red-brown for travel moves
    PLATE_COLOR = (70, 70, 70)   # Plate outline color

    # Parse all segments (extrusion + travel)
    segments, travels, max_z = _parse_segments(gcode_path)

    if not segments:
        # Empty G-code — return placeholder
        img = Image.new('RGB', (int(image_size * 1.5), image_size), background_color)
        draw = ImageDraw.Draw(img)
        draw.text((image_size * 0.5, image_size * 0.45), "No extrusion data",
                  fill=(120, 120, 120), anchor="mm")
        return img

    logger.info(f"Parsed {len(segments):,} extrusion + {len(travels):,} travel segments, max Z={max_z:.1f}mm")

    # If too many segments for memory, decimate uniformly
    MAX_SEGMENTS = 2_000_000
    if len(segments) > MAX_SEGMENTS:
        step = len(segments) // MAX_SEGMENTS + 1
        segments = segments[::step]
        logger.info(f"Decimated to {len(segments):,} segments (1/{step})")

    # --- Layout dimensions ---
    total_w = int(image_size * 1.5)
    total_h = image_size
    main_w = image_size       # Left panel: square, same as height
    side_w = total_w - main_w  # Right panels: remaining width
    side_h = total_h // 2      # Each right panel is half height

    img = Image.new('RGB', (total_w, total_h), background_color)
    draw = ImageDraw.Draw(img)

    # Panel divider lines
    divider_color = (50, 50, 50)
    draw.line([(main_w, 0), (main_w, total_h)], fill=divider_color, width=1)
    draw.line([(main_w, side_h), (total_w, side_h)], fill=divider_color, width=1)

    # --- Panel labels ---
    label_color = (80, 80, 80)
    try:
        font = ImageFont.load_default(size=12)
    except TypeError:
        font = ImageFont.load_default()
    draw.text((8, 4), "3D", fill=label_color, font=font)
    draw.text((main_w + 6, 4), "Top", fill=label_color, font=font)
    draw.text((main_w + 6, side_h + 4), "Front", fill=label_color, font=font)

    # ==================== 3D PERSPECTIVE (left panel) ====================
    margin_3d = main_w * 0.08
    # Scale to fit bed + height in the panel
    # The isometric projection spreads: X range ~ bed*cos45, Y range ~ bed*sin45*0.5 + maxZ
    x_spread = BED_SIZE * 0.7071  # cos45 * bed
    y_spread = BED_SIZE * 0.7071 * 0.5 + max_z  # depth + height
    usable_w = main_w - 2 * margin_3d
    usable_h = main_w - 2 * margin_3d
    scale_3d = min(usable_w / (x_spread * 2), usable_h / (y_spread * 1.2))
    # Origin: center of left panel
    ox_3d = main_w / 2
    oy_3d = main_w * 0.65  # Push down a bit so tall prints don't clip top

    bed_cx = BED_SIZE / 2
    bed_cy = BED_SIZE / 2

    # Draw bed outline in 3D
    bed_corners = [
        (0, 0, 0), (BED_SIZE, 0, 0),
        (BED_SIZE, BED_SIZE, 0), (0, BED_SIZE, 0),
    ]
    bed_pts = [_project_iso(bx, by, 0, bed_cx, bed_cy, scale_3d, ox_3d, oy_3d, main_w)
               for bx, by, _ in bed_corners]
    for i in range(4):
        draw.line([bed_pts[i], bed_pts[(i + 1) % 4]], fill=PLATE_COLOR, width=1)

    # Sort segments back-to-front for painter's algorithm (proper occlusion).
    # In our isometric view (45° rotation), "depth" is -(x+y) after rotation,
    # plus lower Z should draw first. Sort by ascending depth so far objects
    # draw first and near objects paint over them.
    cos45 = 0.7071
    sin45 = 0.7071
    def _depth_key(seg):
        x1, y1, z1, x2, y2, z2, _ = seg
        mx = (x1 + x2) * 0.5 - bed_cx
        my = (y1 + y2) * 0.5 - bed_cy
        mz = (z1 + z2) * 0.5
        # Depth = how far "into" the screen: ry2 (rotated Y) + Z
        ry2 = mx * sin45 + my * cos45
        return ry2 * 0.5 + mz  # match projection formula
    segments_3d = sorted(segments, key=_depth_key)

    # Draw segments in 3D (back-to-front)
    for seg in segments_3d:
        x1, y1, z1, x2, y2, z2, tool = seg
        color = tool_colors[tool % len(tool_colors)]
        p1 = _project_iso(x1, y1, z1, bed_cx, bed_cy, scale_3d, ox_3d, oy_3d, main_w)
        p2 = _project_iso(x2, y2, z2, bed_cx, bed_cy, scale_3d, ox_3d, oy_3d, main_w)
        draw.line([p1, p2], fill=color, width=line_width)
    del segments_3d  # Free memory

    # ==================== TOP-DOWN (top-right panel) ====================
    top_margin = side_w * 0.08
    top_usable = min(side_w, side_h) - 2 * top_margin
    top_scale = top_usable / BED_SIZE
    # Offset: shift into the top-right panel area
    top_ox = main_w
    top_oy = 0

    # Draw bed outline
    bed_tl = (top_ox + top_margin, top_oy + side_h - top_margin - BED_SIZE * top_scale)
    bed_br = (top_ox + top_margin + BED_SIZE * top_scale, top_oy + side_h - top_margin)
    draw.rectangle([bed_tl, bed_br], outline=PLATE_COLOR, width=1)

    # Draw travels first (underneath extrusions)
    for seg in travels:
        x1, y1, _, x2, y2, _, _ = seg
        px1 = top_ox + top_margin + x1 * top_scale
        py1 = top_oy + side_h - top_margin - y1 * top_scale
        px2 = top_ox + top_margin + x2 * top_scale
        py2 = top_oy + side_h - top_margin - y2 * top_scale
        draw.line([(px1, py1), (px2, py2)], fill=TRAVEL_COLOR, width=1)

    # Draw extrusions on top
    for seg in segments:
        x1, y1, _, x2, y2, _, tool = seg
        color = tool_colors[tool % len(tool_colors)]
        px1 = top_ox + top_margin + x1 * top_scale
        py1 = top_oy + side_h - top_margin - y1 * top_scale
        px2 = top_ox + top_margin + x2 * top_scale
        py2 = top_oy + side_h - top_margin - y2 * top_scale
        draw.line([(px1, py1), (px2, py2)], fill=color, width=line_width)

    # Re-draw plate outline on top so it's always visible
    draw.rectangle([bed_tl, bed_br], outline=PLATE_COLOR, width=1)

    # ==================== FRONT VIEW (bottom-right panel) ====================
    front_margin = side_w * 0.10
    # Scale to fit full bed width (X) and print height (Z) in the panel
    front_usable_w = side_w - 2 * front_margin
    front_usable_h = side_h - 2 * front_margin
    effective_z = max(max_z, 1.0)
    front_scale = min(front_usable_w / BED_SIZE, front_usable_h / effective_z)

    # Center the bed in the panel horizontally
    bed_w_px = BED_SIZE * front_scale
    front_ox_offset = main_w + front_margin + (front_usable_w - bed_w_px) / 2
    front_oy_bottom = side_h + side_h - front_margin  # Bottom of panel

    # Draw bed line (full plate width)
    draw.line([(front_ox_offset, front_oy_bottom),
               (front_ox_offset + bed_w_px, front_oy_bottom)],
              fill=PLATE_COLOR, width=1)

    for seg in segments:
        x1, _, z1, x2, _, z2, tool = seg
        color = tool_colors[tool % len(tool_colors)]
        px1 = front_ox_offset + x1 * front_scale
        py1 = front_oy_bottom - z1 * front_scale
        px2 = front_ox_offset + x2 * front_scale
        py2 = front_oy_bottom - z2 * front_scale
        draw.line([(px1, py1), (px2, py2)], fill=color, width=line_width)

    logger.info(f"Rendered {len(segments):,} segments across 3 views")
    return img
