# M33 Placement Coordinate Model (Stabilization Plan)

Purpose: define one explicit coordinate contract for the pre-slice mover/viewer so Bambu/Snapmaker multi-plate files (e.g. Shashibo H2D) do not require layered frontend heuristics.

## Canonical Frame

Use `F_UI_BED_LOCAL` as the canonical placement frame for all interactive UI state:

- units: `mm`
- axes: `x,y` on build plate
- origin: printer bed local origin
- values stored/edited in UI:
  - object move deltas (`translate_x_mm`, `translate_y_mm`)
  - object rotation (`rotate_z_deg`)
  - prime tower anchor (`wipe_tower_x`, `wipe_tower_y`)

## Other Frames (for reference)

- `F_3MF_BUILD`: top-level 3MF `<build><item>` transform coordinates
- `F_BAMBU_ASSEMBLE_PACKED`: Bambu `model_settings.config` `assemble_item` packed project coordinates
- `F_VIEWER_THREE`: Three.js scene coordinates (axis-swapped from bed-local)
- `F_GCODE_BED`: final sliced G-code bed coordinates

## Rules

1. Frontend interaction logic should operate only in `F_UI_BED_LOCAL`.
2. Prime tower preview/drag should remain in `F_UI_BED_LOCAL` (same frame as slicer `wipe_tower_x/y`).
3. Bambu packed/assemble mapping should be converted into `F_UI_BED_LOCAL` in one adapter layer (preferably backend `/layout`).
4. Viewer (`mesh-viewer.js`) should only convert `F_UI_BED_LOCAL <-> F_VIEWER_THREE`.
5. Preview should expose confidence:
   - `exact` when mapping is authoritative
   - `approximate` when heuristic normalization is used

## `/layout` Contract (stabilization scaffolding)

The backend now returns:

- `placement_frame`
  - `version`: `2` (stabilization rewrite in progress)
  - `canonical`: `bed_local_xy_mm`
  - `mapping`: `direct` | `bambu_plate_translation_offset` | `bambu_packed_grid_fold` | `centered_preview_offset`
  - `confidence`: `exact` | `approximate`
  - `offset_xy` (when centered preview mapping is used)
  - `packed_grid_step_x_mm` / `packed_grid_step_y_mm` (when Bambu packed-grid fold is used)
  - `plate_translation_mm` (when Bambu plate-translation offset mapping is used)
  - `capabilities` (UI feature gating)

- `objects[].ui_base_pose`
  - `{ x, y, z, rotate_z_deg }`
  - bed-local preview pose hint computed by backend

This is a transition contract. The frontend should move to consuming `ui_base_pose` and stop duplicating Bambu coordinate heuristics.

## Known Current Limitation

- Selected-plate Shashibo/H2D path now uses `bambu_plate_translation_offset` and is treated as exact for object editing (backend `/layout` + transformed precheck alignment + parity regressions).
- Multi-plate aggregated preview paths (no `plate_id`) may still use approximate mappings and should not be treated as authoritative for object editing.

## Next Refactor Steps

1. Frontend: remove remaining legacy fallback heuristics once all supported `/layout` paths return stable `ui_base_pose`.
2. Extend exact adapter coverage beyond Shashibo/H2D-selected-plate cases (other packed Bambu multi-plate exports).
3. Add UI drag parity regressions (not just API/object-transform parity) for the exact adapter path.
