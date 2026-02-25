# Memory - U1 Slicer Bridge

> Concise bug fix journal. For full implementation history, see [AGENTS.md](AGENTS.md).

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
