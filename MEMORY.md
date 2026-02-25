# Memory - U1 Slicer Bridge

> Concise bug fix journal. For full implementation history, see [AGENTS.md](AGENTS.md).

## M33 Viewer/G-code Preview Visual Parity (Global Flip/Mirror Illusion) (2026-02-25)

### Symptoms
- Pre-slice `Object Placement` viewer and post-slice G-code viewer could show the same object + prime tower in apparently mirrored/flipped relative positions.
- User reported this across multiple files (Shashibo plate 5/6 and simple/single-plate cases), indicating a global viewer-frame issue rather than a model-specific placement bug.

### Root Cause
- The pre-slice mesh viewer (`mesh-viewer.js`) was using a different bed-axis world mapping and default camera pose than the G-code viewer (`gcode-preview`).
- Placement data itself was not necessarily mirrored, but the two viewers projected the bed with different visual conventions, making relative positions look wrong when compared side-by-side.

### Fix
- Aligned pre-slice viewer bed-axis visual orientation with `gcode-preview`:
  - updated bed `Y -> world Z` mapping in `mesh-viewer.js`
  - updated object/proxy/prime-tower local geometry `Y` handling to match the new viewer frame
  - aligned the pre-slice viewer default camera vector/target to the G-code viewer's default orientation
- Result: pre-slice and post-slice viewers now present consistent on-screen relative placement (object vs prime tower) without relying on camera guesswork.

### Validation
- `npm run test:smoke`
- `npm run test:viewer`
- manual screenshot comparison of pre-slice vs G-code preview after rebuild/redeploy

## Aux Fan Object-Transform Slice Failures: Backend U1 Build Volume Mismatch (2026-02-24)

### Symptoms
- `u1-auxiliary-fan-cover-hex_mw.3mf` could look valid in preview and pass transform precheck, but Orca failed with:
  - `calc_exclude_triangles: Unable to create exclude triangles`
  - `Nothing to be sliced...`
- Shashibo slices could still work, which made the failure look model-specific.

### Root Cause
- `apps/api/app/config.py` still defined `snapmaker_u1` as `300x250x235`.
- Snapmaker Orca U1 machine profile uses ~`270x270x270` printable volume.
- Backend `/layout`, transform precheck, and G-code bounds validation were using the oversized backend profile, so invalid aux-fan moves could pass precheck and only fail later inside Orca.

### Fix
- Updated backend `snapmaker_u1` profile to `270x270x270` in `config.py` to match the Orca machine profile and AGENTS invariants.
- Added/kept targeted regression coverage in `tests/slicing.spec.ts`:
  - `slice via API rejects aux fan object_transforms that move printable object off-bed (regression)`

### Validation
- `npm run test:smoke`
- `npx playwright test tests/slicing.spec.ts --grep "Bambu assemble placement path|aux fan object_transforms"`
- `npm run test:viewer`

## M33 Placement Mapping Rewrite (Stabilization) - Backend Adapter Split + Single-Plate Exact Rollback (2026-02-24)

### Why
- Placement preview drift was being caused by a mix of backend and frontend heuristics (packed-grid folding, centered preview offsets, frontend recentering).
- A regression from the `/layout` `ui_base_pose` rollout caused single-plate files (e.g. `u1-auxiliary-fan-cover-hex_mw.3mf`) to render off-plate in preview while slicing fine.

### What Changed
- `routes_slice.py::_derive_layout_placement_frame()` was refactored into explicit adapter helpers:
  - `direct`
  - `bambu_plate_translation_offset` (new)
  - `bambu_packed_grid_fold`
  - `centered_preview_offset` (legacy fallback)
- `/layout` now emits `placement_frame.version = 2`.
- Single-plate `/layout` now always uses exact `direct` `ui_base_pose` (no centered preview offset).
- Frontend `app.js` placement path no longer performs local packed-grid folding heuristics; it now relies on backend `ui_base_pose` for packed Bambu layouts.
- Added regression in `tests/viewer.spec.ts`:
  - `aux fan single-plate placement preview uses exact/direct mapping and starts on-bed (regression)`

### New Bambu Adapter (Preview-Only for Now)
- Added `bambu_plate_translation_offset` mapping:
  - `ui_xy = effective_xy - packed_plate_translation_xy + bed_center_xy`
- This is a more deterministic preview adapter for packed Bambu multi-plate files than inferring grid steps from plate spacing.
- Initial rollout kept object move/rotate disabled until backend transformed precheck used the same adapter.

### Follow-up (same day): Adapter Promoted to Exact for Selected-Plate H2D Path
- `_enforce_transformed_bounds_or_raise()` now prefers the same packed-Bambu plate-translation offset (anchored to the baseline plate translation) for transformed prechecks.
- Added parity regressions proving the selected-plate H2D path matches actual slice results:
  - preview object/tower relative placement quadrant vs sliced output (plate 6)
  - object transform XY delta vs sliced object footprint delta (plate 6)
  - object transform XY delta vs sliced object footprint delta (plate 5)
- `/layout` now marks `bambu_plate_translation_offset` as `confidence=exact` and `object_transform_edit=true` for selected-plate (`plate_id`) single-item paths, re-enabling object move/rotate in the UI for Shashibo H2D.

## M33 Shashibo Small H2D Tiny-Move False `slice-plate` Rejection (2026-02-24)

### Symptoms
- `Object Placement` preview showed Shashibo `Small - H2D` (plate 5) on-bed with margin, but even a tiny move (e.g. `+1mm X`) failed before slicing with:
  - `Object transforms place plate 5 so no printable object is fully inside the print volume`
- Error bounds were in packed Bambu coordinates (`X~385..486`, `Y~-223..-135`), not U1 bed-local coordinates.

### Root Cause
- In the `slice-plate` path, transformed-layout precheck used `baseline_file_path=(workspace / "embedded.3mf")`, but the actual pre-transform embedded file is `sliceable.3mf`.
- That meant the preview-aligned normalization offset was never computed, so the strict "fully inside" check ran against raw packed coordinates and falsely rejected on-bed tiny moves.
- Some embed/rebuild paths also lack Bambu `assemble_item` metadata in the embedded file, so normalization must fall back to baseline core build-item bounds.

### Fix
- `routes_slice.py` (`slice-plate`) now passes the correct pre-transform baseline file (`sliceable.3mf`) into `_enforce_transformed_bounds_or_raise(...)`.
- `_enforce_transformed_bounds_or_raise(...)` now falls back to baseline core build-item `world_bounds` to compute the preview-like normalization offset when Bambu assemble metadata is unavailable in the embedded file.
- Offset is applied consistently to both assemble-derived and core-derived bounds during the "fully inside" check.
- Added regression in `tests/slicing.spec.ts`:
  - `slice-plate allows tiny Shashibo small plate move when object remains on-bed (regression)`

## Test Runner Operational Note: Heavy Suites Must Run Sequentially (2026-02-24)

### Symptom
- Running slicer-heavy Playwright suites in parallel (for example `test:slice` with `test:extended`) caused false timeouts / flaky failures.

### Cause
- Suites contend for the same Docker API/web containers and Snapmaker Orca slicer resources, increasing queueing and request/poll timings.

### Guidance
- Run heavy suites sequentially:
  - `npm run test:slice`
  - `npm run test:extended`
  - `npm test`
- Parallel runs are fine for light/independent commands, but not for slicer-heavy regressions.

## M33 Shashibo `slice-plate` Wrong Plate Routed to Orca Plate 1 (2026-02-23)

### Symptoms
- Slicing Shashibo `plate_id=6` (e.g. Large H2D) completed, but output looked like the wrong plate:
  - model in wrong position
  - no prime tower
  - single filament/tool only

### Root Cause
- `slice-plate` had a Bambu compatibility fallback that forced `effective_plate_id = 1` whenever the requested plate did not have `Metadata/plate_N.json`.
- Some Bambu files (including Shashibo variants) have multiple plates but **no** `Metadata/plate_N.json` files (they use plate images and other metadata instead), so the fallback incorrectly rewrote valid requests (e.g. plate 6 -> plate 1).

### Fix
- `routes_slice.py` now only falls back to Orca plate 1 when there is positive evidence of a JSON plate mismatch (i.e. `Metadata/plate_N.json` IDs exist but do not include the requested plate).
- If no `Metadata/plate_N.json` files are present, the backend keeps the requested parser plate index.
- Added `@extended` regression in `tests/slicing.spec.ts` using `Shashibo-h2s-textured.3mf` (`plate_id=6`) that asserts the output G-code includes `T1` (guards against silently slicing plate 1).

## M33/M36 Viewer Performance Tracking Plan (2026-02-23)

### What Changed
- Added `docs/m33-m36-viewer-performance-plan.md` as a checkbox plan for shared placement/paining viewer performance work.
- Includes targets and phased tasks for:
  - lazy-loading placement viewer work
  - dynamic/progressive geometry LOD
  - transport/render optimizations
  - M33 reliability and M36 readiness

### Initial Phase-1 Progress
- Frontend now avoids loading placement `/layout` + `/geometry` before a multi-plate selection is made (prevents wasted viewer work before the user chooses a plate).
- Viewer `/geometry` endpoint budget was lowered for placement preview (`max_triangles_per_object=10000`) to reduce payload/render cost.

## M33 Placement Viewer Performance + Prime Tower Preview Coordinate Sync (2026-02-23)

### Symptoms
- Multi-plate projects (e.g. Shashibo) still felt slow in Object Placement.
- Plate thumbnails could appear to wait on placement viewer work after selection.
- Prime tower preview drag could appear not to match the eventual slice position on multi-plate previews.

### Fixes
- `app.js::loadObjectLayout()` now stages placement loading:
  - loads `/layout` first and renders proxy preview ASAP
  - fetches low-LOD `/geometry` next
  - optionally refines to high-LOD `/geometry` afterward
- `selectPlate()` now defers placement layout load by one tick so plate-card selection/thumbnail UI can paint first.
- Added placement-viewer timing telemetry (backend `timing_ms` on `/layout` and `/geometry`, frontend metrics + console log + small UI perf line).
- `mesh-viewer.js` now emits scene rebuild stats (`rebuild_ms`, object count, triangle count).
- Prime tower preview drag now uses the same multi-plate display offset/inverse mapping as object drag, so tower preview coordinates stay aligned with the visually centered plate content.

### Verification
- Generated G-code contains explicit `wipe_tower_x` / `wipe_tower_y` comments reflecting moved tower coordinates (e.g. `165`, `216.972`), confirming the values are reaching the slicer path.

## M33 Shashibo Selected-Plate Preview Coordinate Regressions (2026-02-23)

### Symptoms
- Selected Shashibo plates could render off the preview bed after a viewer coordinate-offset tweak.
- Prime tower placement complaints were not covered by existing automated tests.

### Why Existing Tests Missed It
- We had API geometry/mesh regressions and slice regressions, but no UI-state regression asserting that selected multi-plate preview objects start on-bed in the placement viewer.
- We also did not assert that explicit `wipe_tower_x/y` survive `slice-plate` into the output G-code for a real multi-plate Bambu file.

### New Regressions Added
- `tests/viewer.spec.ts`: `Shashibo plate 6 placement preview starts on-bed...`
  - checks placement-viewer state (`getObjectEffectivePoseForViewer`) keeps the selected plate object center/intersection on the bed
  - verifies enabled prime tower preview is visible on-bed
- `tests/slicing.spec.ts`: `slice-plate preserves explicit prime tower position in G-code metadata...`
  - uses Shashibo plate 6
  - asserts multicolour output (`T1`)
  - asserts explicit `wipe_tower_x/y` appear in generated G-code comments

## Prime Tower Manual Position Ignored (Snapmaker Orca v2.2.4, Bambu multicolour `slice-plate`) (2026-02-23)

### Symptom
- Dragging the prime tower preview (or setting explicit `wipe_tower_x/y`) changes G-code metadata comments, but the actual prime tower toolpath remains in the same physical location.

### Verification
- Parsed `; FEATURE: Prime tower` extrusion moves from generated Shashibo plate-6 G-code and measured the real tower footprint.
- Across slices with different requested `wipe_tower_x/y`, the tower footprint bbox/center stayed effectively unchanged while comments changed.

### Implication
- In this slicer path, prime tower manual position is currently **best-effort only** and can be ignored by Snapmaker Orca.

### Mitigation (Implemented)
- Added post-slice G-code rewrite in `slicer.py`:
  - parses actual `; FEATURE: Prime tower` footprint from extrusion moves
  - shifts `Prime tower` block XY moves so the real tower footprint center matches requested `wipe_tower_x/y`
- Wired into both slice endpoints before metadata parsing/bounds validation.
- Upgraded regression to a passing `@extended` test:
  - `actual prime tower footprint moves when explicit wipe_tower_x/y changes...`
- UI warning remains as best-effort/compatibility notice because the underlying slicer still ignores the setting in some paths (the app now compensates post-slice).

## M33 Prime Tower Placement / Conflict Retry (2026-02-23)

### Symptom
- Moving the fan-cover object in the new placement viewer and slicing with prime tower enabled could fail in Orca with:
  - `calc_exclude_triangles: Unable to create exclude triangles`
  - `Nothing to be sliced...`

### Root Cause
- This failure mode is another wipe/prime-tower placement conflict variant (object vs prime tower path/region), but the existing retry detector only matched two Orca messages and missed the `calc_exclude_triangles` + `Nothing to be sliced` combination.

### Fix
- `routes_slice.py::_is_wipe_tower_conflict()` now also treats the `calc_exclude_triangles` + `Nothing to be sliced` error pair as a prime/wipe-tower conflict and retries once with prime tower disabled.
- Slice request models/endpoints now accept and pass through explicit `wipe_tower_x` / `wipe_tower_y` overrides.
- Added prime tower placement support in the pre-slice 3D placement viewer:
  - synthetic prime tower preview (orange) shown when prime tower is enabled
  - hidden modifier meshes remain default behavior
  - tower can be dragged in `Move` mode to set explicit `wipe_tower_x/y`
  - tower width/brim and reset-position controls added to Object Placement panel

### Notes
- Prime tower preview is synthetic (Orca generates the real tower at slice time); when no explicit `wipe_tower_x/y` are set, the viewer shows an estimated auto position and labels it `PT*`.

## M33 Placement Viewer: Multi-Plate Display Offset + Large Mesh Decimation (2026-02-23)

### Symptoms
- Left/right orbit felt reversed in the pre-slice placement viewer.
- Multi-plate Bambu projects (e.g. Shashibo) could show the selected plate object far off the preview bed.
- Large objects fell back to a proxy cube (`mesh_too_large`) so the actual model shape was not visible.

### Root Causes
- Orbit theta update sign was inverted for the expected drag direction.
- Selected multi-plate layout metadata uses full-scene build-item translations (plates packed far apart in project space), which are correct for slicing but not suitable for a per-plate preview bed.
- Geometry endpoint hard-cut large objects at `max_triangles_per_object`, returning no mesh at all.

### Fix
- `mesh-viewer.js`: flipped left/right orbit direction to match expected drag behavior.
- `app.js`: added a viewer-only display offset for selected multi-plate plates (centers selected plate content on the preview bed) and inverse mapping so drag edits still produce correct transform deltas for slicing.
- `multi_plate_parser.py::list_build_item_geometry_3mf()`: large meshes are now decimated to the triangle cap instead of dropped, preserving an approximate real model shape.

### Notes
- Shashibo plate geometry now returns a decimated mesh (~19.7k triangles from ~197k original) instead of a proxy cube.
- Opening the placement viewer for complex multi-plate models can still take a few seconds due bounds validation/layout parsing.

## M33 Object Move/Rotate Foundation (2026-02-22)

### What Landed
- Backend `object_transforms` support on both slice endpoints (`/uploads/{id}/slice`, `/uploads/{id}/slice-plate`)
- New layout metadata endpoint: `GET /uploads/{id}/layout` (returns editable top-level build items + validation)
- Frontend wiring for layout loading + transform payload passthrough
- Initial configure-step UI panel with numeric `X/Y` offset and `Z` rotation controls (non-drag)

### Key Constraints / Root Causes
- **Orca XML sensitivity**: Snapmaker Orca v2.2.4 rejected transformed 3MFs after full `xml.etree` reserialization of `3D/3dmodel.model` with a misleading error (`file couldn't be read because it's empty`), even though the ZIP/XML was valid to Python.
- **Fix**: Preserve original `3D/3dmodel.model` text and patch only `<item ... transform="...">` attributes in-place (raw XML tag patch), rather than rewriting the whole XML document.
- **v1 transform anchor**: `object_id` can change during profile embedding/rebuild paths; `build_item_index` is the stable v1 selector in transform payloads. `object_id` remains optional best-effort metadata/safety check.

### Validation / Bounds
- `multi_plate_parser` XML bounds path now applies affine item transforms (rotation + translation) when computing AABBs, not translation-only.
- Slice endpoints now fail fast with `400` if requested object transforms push the model/plate outside the build volume.

### Regression Coverage
- `tests/slicing.spec.ts`: happy-path slice accepts `object_transforms` + `/layout` endpoint returns build items
- `tests/errors.spec.ts`: invalid `build_item_index` in `object_transforms` returns `400`
## Webcam Path-Validity Fallback (2026-02-23)

### Symptom
- Some deployments require webcam paths without the Moonraker API port, while others require port-preserved webcam URLs.
- A single fixed resolution strategy caused broken webcam previews for one side or the other.

### Root Cause
- URL resolution had to choose one output style (`with port` or `without port`) before browser load-time, but actual reachability is environment-dependent.

### Fix
- Backend now provides both variants for relative webcam URLs:
  - primary browser-facing URLs (`snapshot_url`, `stream_url`, no API port)
  - alternates with port preserved (`snapshot_url_alt`, `stream_url_alt`)
- Frontend webcam preview now performs staged runtime fallback on image load errors:
  1. `snapshot_url`
  2. `snapshot_url_alt`
  3. `stream_url`
  4. `stream_url_alt`
- Absolute URLs with any scheme (`https://`, `rtsp://`, etc.) remain unchanged.

### Regression
- Playwright webcam suite: `npm run test:webcams` passed
- Smoke suite: `npm run test:smoke` passed

## Printer Status Webcam Feature (2026-02-22)

### Summary
- Added full webcam support to the Printer Status overlay: discovery from Moonraker, API exposure on `GET /printer/status`, and tile rendering in the web UI.
- Webcam panel is collapsed by default and requests webcam payload only when expanded (`include_webcams=true`).
- Relative webcam URLs are resolved against Moonraker host origin (no API port), while absolute URLs are preserved.
- Preview pipeline is resilient: prefer `snapshot_url`, fallback to `stream_url` on image error, and refresh preview URL on reopen/reload via cache-busting nonce.
- Regression coverage lives in `tests/webcams.spec.ts` (collapsed gating, expanded API path, fallback behavior, reopen refresh).

## Configure Back-Nav Multicolour State Loss (2026-02-20)

### Symptom
- After slicing a multicolour file and clicking `Back to configure`, configure view could lose multicolour assignments and show a fallback single-filament summary.
- In some paths, the selected file size showed `0.00 MB` after navigating back.

### Root Cause
- The complete-step navigation could rely on partially populated `selectedUpload` state (job-origin context) without rehydrating authoritative upload metadata such as `detected_colors` or `file_size`.

### Fix
- `app.js::goBackToConfigure()` now rehydrates upload data via `GET /upload/{id}` and refreshes plate data via `GET /uploads/{id}/plates`.
- Detected colors are re-applied only when a colour state is missing or has fallen back, preserving the standard configured state while restoring broken cases.
- Added regression test `tests/slicing.spec.ts` - `back to configure preserves multicolour state`.

## Upload Progress Stuck at 0% (2026-02-20)

### Symptom
- Some clients showed `Uploading... 0%` indefinitely and never transitioned to `Preparing file`.

### Root Cause
- The service worker intercepted all requests, including multipart `POST /api/upload`, which can stall upload streams on certain browsers or devices.

### Fix
- `apps/web/sw.js` now only intercepts same-origin `GET` requests.
- Non-GET requests, including upload POSTs, bypass the service worker entirely.

### Regression
- `npm run test:smoke` passed.
- `npm run test:upload` passed.

## Pi Arm64 Regression Stability (2026-02-21)

- Symptom: Fast regression on Raspberry Pi arm64 timed out in multiplate/multicolour upload flows and removed uploads after tests.
- Cause:
  1. Test cleanup was enabled by default.
  2. Upload/UI timeouts were too tight for slower arm64 hardware.
- Fix:
  1. Playwright cleanup now requires `TEST_CLEANUP_UPLOADS=1`.
  2. `tests/helpers.ts` scales upload/UI/API timeouts for arm64 or when `PLAYWRIGHT_SLOW_ENV=1`.
- Files: `tests/global-setup.ts`, `tests/global-teardown.ts`, `tests/helpers.ts`

## Multi-Arch Slicer Packaging (2026-02-20)

### AppImage -> Flatpak Migration
- Symptom: AppImage-based Orca install blocked multi-arch container builds.
- Cause: The pinned AppImage path was not portable across `amd64` and `aarch64`.
- Fix: Switched the API Docker image to install Snapmaker Orca from architecture-specific GitHub Flatpak bundles (`x86_64`/`aarch64`) and invoke the installed binary directly, avoiding `flatpak run` and unstable `bwrap` namespaces. The build now installs the pinned bundle with `--no-deps` and avoids adding Flathub remotes for deterministic installs.
- Files: `apps/api/Dockerfile`
- Note: The Dockerfile now resolves `fdm_process_common.json` dynamically from the Flatpak installation path.

## 3D G-code Viewer (M12) â 2026-02-17

### Implementation
- Replaced 2D canvas viewer with gcode-preview v2.18.0 + Three.js r159 (vendored in `apps/web/lib/`)
- Alpine.js component wraps gcode-preview; Three.js objects stored in closure (NOT Alpine properties â Proxy breaks non-configurable props)
- Full G-code fetched via `/api/jobs/{id}/download`, parsed client-side by gcode-preview
- Mouse controls match OrcaSlicer: left=rotate, middle/right=pan, scroll=zoom

### Key Bugs Fixed
1. **TIMELAPSE tool color bug** â `TIMELAPSE_START`/`TIMELAPSE_TAKE_FRAME` parsed as `gcode="t"`, misidentified as tool changes â `state.t=undefined` â hotpink fallback. Fix: comment out with regex before processGCode.
2. **Black rendered as white** â Gradient replaces lightness (0.1-0.8), black (S=0) becomes gray/white. Fix: `disableGradient: true`.
3. **Auto filament colors ignoring presets** â `mappedColors` from `mapDetectedColorsToPresetSlots()` was unused; `syncFilamentColors()` used wrong preset index. Fix: use `mappedFromPresets.mappedColors` and `assignments[idx]`.

## Recent Fixes (2026-02-16)

### Filament Loading Race Condition
- **Symptom**: `selectedFilaments = [null, null]`, API returns "filaments not found"
- **Cause**: `init()` still loading filaments when fast upload completes
- **Fix**: Guard `if (this.filaments.length === 0) await this.loadFilaments()` before `applyDetectedColors()`. Move `currentStep = 'configure'` to AFTER filaments/colors ready.
- **Files**: `apps/web/app.js`

### Test Filament Deletion
- **Symptom**: Extruder preset filaments permanently deleted by error tests
- **Cause**: `errors.spec.ts` sent only 1 extruder slot (API requires 4), PUT silently failed
- **Fix**: Send all 4 slots, verify PUT with `expect(putRes.ok()).toBe(true)`
- **Files**: `tests/errors.spec.ts`

### waitForSliceComplete Timeout
- **Symptom**: Tests wait 2.5 min instead of failing fast on slice errors
- **Fix**: Early exit if `currentStep` reverts to 'configure' or 'upload'
- **Files**: `tests/helpers.ts`

## Upload Performance Fix (2026-02-16)
- Replaced trimesh with XML vertex scanning for upload-time bounds
- `_calculate_xml_bounds()` scans `<vertex>` elements directly
- trimesh still used at slice time for Bambu geometry rebuild

## Copies Grid Overlap Fix (2026-02-20)

### Root Cause
`_scan_object_bounds()` in `multi_plate_parser.py` scanned vertex bounds from each component's mesh but never applied the component transform offsets. Both components of the dual-colour cube referenced the same mesh, so combined bounds equaled one cube's bounds (10mm), ignoring the +/-7.455mm assembly offsets. Actual footprint is 24.9mm wide.

### Fix
Parse each component's `transform` attribute and apply translation offsets to vertex bounds before combining. Also auto-enables prime tower for multi-color copies.

### Regression Tests
- `copies.spec.ts`: "multi-component assembly dimensions account for component offsets" (width >20mm)
- `copies.spec.ts`: "copies grid has no overlapping objects" (grid cell spacing > object size)

## Scale Overlap Fix (2026-02-21)

### Symptom
- At high scale (for example `500%`) the dual-colour calicube could show its two model blocks overlapping in preview.
- Users observed Z growth, but XY internal spacing did not grow proportionally.

### Root Cause
- `apply_layout_scale_to_3mf()` only scaled `Metadata/model_settings.config` matrix metadata.
- The same assembly offsets also exist in `3D/3dmodel.model` as `<component transform="...">`, and those were left unchanged.
- Snapmaker Orca path used those unscaled component transforms, so inter-component spacing stayed near original.

### Fix
- `apps/api/app/scale_3mf.py` now scales component transforms in `3D/3dmodel.model` during layout scaling.
- Fallback uniform scaling path also scales nested component transforms so spacing remains proportional when native `--scale` fallback is used.
- `2 copies + 500%` now fails fast with a clear fit error instead of generating overlapping output.

### Regression Tests
- Added `tests/copies.spec.ts`: `scale increases full assembly XY footprint (not just Z)`.
- Updated text selectors in `tests/multicolour.spec.ts` and `tests/upload.spec.ts` for new accordion label: `Colours, Filaments and multimaterial settings`.

## Test Cleanup Safety Guard (2026-02-21)

### Symptom
- Full Playwright runs could remove uploads from the UI/db on shared test instances.

### Fix
- `tests/global-setup.ts` and `tests/global-teardown.ts` now make upload cleanup opt-in.
- Cleanup only runs when `TEST_CLEANUP_UPLOADS=1`.
- Default behavior now preserves uploads/jobs after tests.

### One-time Disk Cleanup
- Ran orphan cleanup on this instance:
  - kept files referenced by DB
  - deleted unreferenced files under `/data/uploads`, `/data/slices`, `/data/logs`
- Current state on this instance: disk data dirs are clean (`0` files in each).

## Multicolour Stability

### Key Fixes Applied
1. **plater_name metadata** â cleared in `model_settings.config` (segfault trigger)
2. **>4 colors** â rejected at API level, frontend falls back to single-filament
3. **Plate extraction** â uses `--slice <plate_id>` instead of geometry extraction
4. **SEMM painted files** â detected via `paint_color` attributes + `single_extruder_multi_material`
5. **Layer tool changes** â `custom_gcode_per_layer.xml` type=2 entries detected and preserved
6. **Machine load/unload times** â zeroed for multicolour (prevents 2x time inflation)

### Working Paths
- Trimesh rebuild: stable but single-tool output only (drops assignment semantics)
- Assignment-preserving: works when paired with metadata sanitization + Snapmaker-safe G-code

## Configuration Notes

### Extruder Presets API
- Requires exactly 4 slots (E1-E4) in PUT
- Safety check blocks deleting filaments assigned to presets
- `_ensure_preset_rows()` handles schema migration at runtime

### 3MF Sanitization
- Parameter clamping: `raft_first_layer_expansion`, `tree_support_wall_count`, `prime_volume`, `prime_tower_brim_width` etc. (Bambu `-1` â `0`)
- Metadata stripped: `slice_info.config`, `cut_information.xml`, `filament_sequence.json`
- Wipe tower position clamped within 270mm bed bounds
- `plater_name` cleared to prevent segfaults

### Docker Deployment
- Web: `docker compose build --no-cache web && docker compose up -d web`
- API: `docker compose build --no-cache api && docker compose up -d api`
- Regular `docker compose build` may miss Python file changes due to layer caching

### Temperature Format
Orca requires string arrays: `["200"]` not `[200]`. Wrap with `str()`.

### Database
asyncpg can't handle multi-statement SQL. Schema split into individual statements in `db.py`.
Runtime schema migration via `ALTER TABLE ADD COLUMN IF NOT EXISTS`.

## Pi Arm64 Playwright Timeout Tuning (2026-02-21)
- **Symptom**: `test:fast` on Raspberry Pi timed out at exactly 120s on large multi-plate/multicolour uploads even after helper timeout increases.
- **Cause**: Playwright global per-test timeout remained fixed at `120_000`, capping slower arm64 runs before helper-level waits could complete.
- **Fix**: `playwright.config.ts` now uses adaptive test timeout:
  - `240_000` for arm64, non-localhost base URLs, or `PLAYWRIGHT_SLOW_ENV=1`
  - `120_000` for standard local runs
- **Files**: `playwright.config.ts`

## Pi Arm64 API Slice Timeout Tuning (2026-02-21)
- **Symptom**: Full-suite arm64 runs still had risk on API-driven slice paths due to fixed 120s helper timeouts.
- **Cause**: `apiSlice`, `apiSlicePlate`, and `waitForJobComplete` in `tests/helpers.ts` used hardcoded 120s limits.
- **Fix**: Made API slice request/poll timeouts adaptive (`240s` in slow env, `120s` otherwise), aligned with arm64 test runtime characteristics.
- **Files**: `tests/helpers.ts`

## M33 Object Move Bug (Bambu/Snapmaker Orca Placement Override) (2026-02-22)
- **Symptom**: `object_transforms` changed the embedded 3MF `3D/3dmodel.model` build-item transform, but sliced G-code bounds did not move at all.
- **Cause**: For Bambu-style files, Snapmaker Orca v2.2.4 can prioritize placement from `Metadata/model_settings.config` `<assemble><assemble_item transform="...">` instead of the core 3MF `<build><item transform="...">`.
- **Fix**: `transform_3mf.py` now applies M33 translation/rotation deltas to both:
  - `3D/3dmodel.model` build-item transforms
  - `Metadata/model_settings.config` assemble-item transforms (best-effort, in-place attribute patch)
- **Verification (local code-level)**: Transform rewriter now moves both transforms on `u1-auxiliary-fan-cover-hex_mw.3mf` (e.g. `+25mm` X updates `build/item` and `assemble_item` X translations).
- **Note**: Docker CLI (`docker compose`) crashed locally with Go OOM during container recreate, so end-to-end redeploy/retest was temporarily blocked after the fix patch.

## M33 Object Move Bug (Snapmaker Orca Auto-Arrange Overrides Transforms) (2026-02-22)
- **Symptom**: M33 UI showed moved objects and the backend rewrote embedded 3MF geometry/metadata, but sliced G-code still printed centered (no XY movement).
- **What misled debugging**:
  - Global G-code bounds were dominated by startup/skirt motions, making some checks look unchanged.
  - Some deploy attempts recreated the API container before `docker compose build api` finished (parallel build/up), leaving stale code running.
- **Root Cause**: Snapmaker Orca CLI was slicing with default arrange/orient behavior (`auto`), which re-centered/re-oriented single-object files and overrode M33 placement edits.
- **Fix**:
  1. `slicer.py`: added `disable_arrange` option to `slice_3mf()` / `slice_3mf_async()` to pass `--arrange 0 --orient 0`
  2. `routes_slice.py`: enable `disable_arrange` whenever `request.object_transforms` is present (including retry/fallback slice paths)
  3. `transform_3mf.py`: also fixed build-item patching to target `<build><item>` only (not component `<item>` tags)
- **Verification (end-to-end)**:
  - `u1-auxiliary-fan-cover-hex_mw.3mf` with `translate_x_mm=25` now shifts sliced G-code bounds by exactly `25.0mm`
  - `npm run test:smoke` and `npm run test:slice` pass

## M33 Placement Viewer Upgrade (Mesh + Drag Move/Rotate) (2026-02-23)
- **What changed**:
  - Added `GET /uploads/{id}/geometry` (optional `?plate_id=`) to return per-build-item local mesh geometry for the pre-slice placement viewer.
  - Placement viewer now renders real object meshes when geometry extraction succeeds; falls back to proxy boxes when geometry is too large/unsupported.
  - Added mode-based drag interactions in the 3D placement viewer:
    - `Move` mode: left-drag object on bed plane
    - `Rotate` mode: left-drag object to rotate around Z (hold `Shift` for 15-degree snap)
- **Compatibility behavior**:
  - Geometry endpoint is best-effort for complex 3MF component graphs and keeps UI functional via proxy fallback.
  - M33 slice behavior still uses `object_transforms` and backend authoritative bounds validation (viewer edits only change transform inputs).
## 2026-02-23 - Prime tower post-slice relocation caused catastrophic off-bed G-code paths (fixed)

- Symptom: G-code preview showed long extrusion/travel paths far outside the build plate after moving the prime tower (especially on Shashibo `slice-plate` multicolour cases).
- Root cause:
  - Post-slice prime tower rewrite was shifting too many `G0/G1` moves inside `WIPE_TOWER` sections; some non-tower motions live there too.
  - Post-slice bounds validation had been strengthened to scan full XY paths, but slice endpoints still downgraded some validation exceptions to warnings.
- Fix:
  - `slicer.reposition_prime_tower()` now rewrites only moves whose endpoints fall near the measured original prime tower footprint (plus margin), instead of all wipe-tower block moves.
  - Prime tower target is clamped to on-bed coordinates using measured footprint size.
  - `slicer.validate_bounds()` scan-based XY checks (`X_min/Y_min` and max safety net) remain in place.
  - `routes_slice.py` now treats any bounds validation failure as fatal (logged error + raise), not warning-only.
- Regression coverage:
  - `tests/slicing.spec.ts` Shashibo prime tower footprint movement test now also asserts full-file G-code XY bounds stay within the 270x270 bed envelope.

## 2026-02-23 - G-code viewer showed fake long extrusion lines (parser bug, fixed)

- Symptom: G-code viewer (and `/jobs/{id}/gcode/layers`) showed long "toolpath" extrusion lines outside the model area even when Orca preview for the same G-code did not.
- Root cause: `_parse_gcode_layers()` ignored `G0` moves, so the next `G1` extrusion segment started from a stale XY point, creating fake long extrusion bridges in the parsed layer geometry.
- Additional parsing gaps: simplistic `E >= 0` classification misclassified some moves because it didn't track absolute vs relative extrusion (`M82/M83`) or `G92 E...` resets.
- Fix:
  - Parse both `G0` and `G1` and always update XY state.
  - Track extrusion mode (`M82`/`M83`) and `G92 E` resets.
  - Classify extrusion based on positive extrusion delta (absolute) or positive relative `E` (relative mode).
- Regression coverage:
  - `tests/viewer.spec.ts`: Shashibo `slice-plate` parser regression asserts parsed `/gcode/layers` does not contain absurdly long `extrude` segments.
# 2026-02-24 - Shashibo small plate move can fail with "Nothing to be sliced" despite extents fitting

- Root cause: M33 pre-slice transform validation only checked core 3MF build-item bounds. Shashibo/Bambu `slice-plate` can use `Metadata/model_settings.config` `assemble_item` transforms as the effective placement, so Orca could reject a moved object as "no object fully inside print volume" while our pre-check still passed.
- Fix: `routes_slice.py::_enforce_transformed_bounds_or_raise()` now also reads Bambu `assemble_item` transforms and verifies that at least one printable object on the selected plate is fully inside the U1 build volume before Orca runs.
- Result: the API now fails fast with a clear `400` validation error instead of a slicer `500` for the reproduced plate-5 Shashibo transform case.
