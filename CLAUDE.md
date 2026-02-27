# CLAUDE.md — Project Context for Claude Code

## Key Documentation

- [AGENTS.md](AGENTS.md) — **Authoritative source.** Milestone tracker, coding conventions, architecture rules, non-goals, and all bug fix history. Read this first for any implementation work.
- [README.md](README.md) — Project overview, tech stack, Docker setup, milestone summary.
- [TESTING.md](TESTING.md) — Testing procedures, test suites, and API endpoint reference (43 endpoints).
- [DEPLOY.md](DEPLOY.md) — End-user deployment guide (quick deploy + build from source).
- [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) — All vendored/bundled dependency attributions.

## Architecture (quick reference)

Docker Compose stack: **api** (Python/FastAPI) + **web** (nginx + Alpine.js) + **postgres**

No Redis, no worker service — slicing runs in-process via `asyncio.to_thread()`.

- `apps/api/app/` — Backend: routes, slicer integration, 3MF parsing, profile embedding
  - `main.py` — FastAPI app, filament CRUD, preset endpoints
  - `routes_upload.py` — Upload handling, metadata caching, copies API
  - `routes_slice.py` — Slice endpoints (full-file and per-plate), G-code metadata/layers API
  - `profile_embedder.py` — 3MF profile embedding, Bambu detection/sanitization, trimesh rebuild
  - `multi_plate_parser.py` — Multi-plate detection, plate extraction, XML vertex bounds scanning
  - `copy_duplicator.py` — Grid layout engine for multiple copies
  - `parser_3mf.py` — 3MF color detection, metadata parsing
  - `slicer.py` — OrcaSlicer subprocess wrapper
  - `gcode_parser.py` — G-code metadata extraction (time, layers, bounds)
  - `schema.sql` — Database schema (run via `db.py` at startup)
- `apps/web/` — Frontend: single-page app
  - `index.html` — Full UI (Alpine.js templates)
  - `app.js` — Alpine.js component (~1600 lines) — all state management, slicing workflow, settings
  - `api.js` — Fetch wrappers for all API endpoints
  - `viewer.js` — 3D G-code viewer (gcode-preview + Three.js)
  - `lib/` — Vendored libraries (Three.js r159, gcode-preview v2.18.0)
- `test-data/` — 3MF test fixtures with attribution
- `tests/` — Playwright test specs (148 tests across 19 spec files)

## Workflow

Upload 3MF/STL → validate plate bounds → configure filament/settings → slice with Snapmaker OrcaSlicer → preview G-code in 3D viewer → download/send to printer

## Milestones & Plans

Milestone status lives in [AGENTS.md](AGENTS.md) (section: "Milestones Status"). **34/39 milestones complete (87%).**

Remaining milestones (not implemented):
- **M14** — Multi-machine support (other printer models)
- **M19** — Slicer selection (OrcaSlicer vs Snapmaker Orca) — see `memory/milestone-slicer-selection.md`
- **M31** — Android companion app (WebView wrapper)
- **M33** — Move objects on build plate (interactive drag-to-position) — see `memory/milestone-3d-viewer-and-move-objects.md`
- **M36** — AI-powered model colorization (depends on M33) — see `memory/milestone-ai-colorization.md`

Optional/future milestones with detailed plans in `memory/`:
- `memory/milestone-makerworld-integration.md` — M26 MakerWorld link import (implemented)
- `memory/milestone-slicer-selection.md` — M19 slicer selection research
- `memory/milestone-multiple-copies.md` — M32 copies implementation (implemented)
- `memory/milestone-vertical-layer-slider.md` — M34 layer slider (implemented)
- `memory/milestone-settings-backup.md` — M35 backup/restore (implemented)
- `memory/milestone-3d-viewer-and-move-objects.md` — Pre-slice 3D viewer + M33 move objects
- `memory/milestone-ai-colorization.md` — M36 AI colorization (segmentation + Claude Vision)

## Critical Conventions

### Build & Deploy
- Web container uses COPY not volumes — rebuild after changes: `docker compose build --no-cache web`
- API container caches aggressively — rebuild with: `docker compose build --no-cache api`
- **Always use `--no-cache`** — regular `docker compose build` may miss Python file changes due to layer caching
- After rebuilding web, users must hard refresh browser (Ctrl+Shift+R)

### Slicer / 3MF
- Temperatures must be string arrays for Orca: `["200"]` not `[200]` — wrap with `str()`
- Arc fitting (`enable_arc_fitting = 1`) is required to avoid 5-6x G-code bloat
- Bambu Studio files need trimesh rebuild before slicing (auto-detected via `_is_bambu_file()` in profile_embedder.py)
- Bambu modifier parts (`type="other"` objects) are stripped before trimesh load to prevent geometry duplication
- Full 3MF sanitization docs (parameter clamping, metadata stripping, wipe tower bounds) in [README.md § 3MF Sanitization](README.md)
- For Bambu files, always use `effective_plate_id = 1` in slice-plate (Bambu plate IDs don't map to our item indices)

### API / Database
- Moonraker URL is persisted in `printer_settings` table (configurable via Settings modal)
- Extruder presets API requires exactly 4 slots (E1-E4) — tests must send all 4
- 3-way setting modes (model/orca/override) stored in `slicing_defaults.setting_modes` as JSON
- Database schema migration uses `ALTER TABLE ADD COLUMN IF NOT EXISTS` pattern
- Schema runs as individual SQL statements (asyncpg can't handle multi-statement SQL)

### Frontend / Alpine.js
- Three.js objects must be stored in closure variables, NOT as Alpine.js component properties (Proxy breaks non-configurable properties like `modelViewMatrix`)
- Alpine v3 auto-calls `init()` on data objects — do NOT also use `x-init="init()"`
- `presetsLoaded` flag prevents saving null presets before `loadExtruderPresets()` completes

### Multiple Copies (M32)
- `get_object_dimensions()` in `copy_duplicator.py` must apply component transform offsets when computing bounding boxes for multi-component assemblies
- Prime tower is auto-enabled when `copies > 1` AND `extruder_count > 1`
- Grid layout uses `calculate_grid_layout()` with object dimensions + spacing
- `_patch_model_settings()` adds required `<model_instance>` and `<assemble_item>` entries for each copy (OrcaSlicer segfaults without these)

### Testing
- **IMPORTANT**: Always redirect test output to a project-local file: `npm test 2>&1 | tee tmp_test_output.txt` (with 600s timeout, NOT in background)
- Background task temp files get cleaned up and become unreadable. `tmp_*` files are already gitignored
- Fast tests: `npm run test:fast` (~103 tests, ~2 min) � use for everyday development
- Extended tests: `npm run test:extended` (~7 heavy tests, ~5 min) � use for multi-plate / transform regressions
- Full tests: `npm test` (~150+ tests, ~60 min) � use before releases
- Tests run sequentially (`workers: 1`) sharing Docker services and DB state
- When adding third-party libraries, update [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) with name, version, license, copyright, and source URL

## Release Workflow

Docker images are built and pushed to GHCR automatically via `.github/workflows/release.yml` when a version tag is pushed.

**IMPORTANT: Never push directly to prod.** Always release as beta first, then promote to stable after testing.

```bash
# 1. Push commits to master
git push origin master

# 2. Beta release (always do this first)
git tag v1.x.x-beta.1
git push origin v1.x.x-beta.1

# 3. Test the beta images
# Production users using docker-compose.prod.yml can test with IMAGE_TAG=beta

# 4. Stable/prod release (only after beta has been tested)
git tag v1.x.x
git push origin v1.x.x
```

This triggers `.github/workflows/release.yml` which builds and pushes:
- `ghcr.io/taylormadearmy/u1-slicer-bridge-api:{version,latest}`
- `ghcr.io/taylormadearmy/u1-slicer-bridge-web:{version,latest}`

Beta tags get `:beta`, stable tags get `:latest`. Production users pulling `docker-compose.prod.yml` get updates via `:latest`.

**After pushing commits, always ask the user if they want to tag a release and build new Docker images.**

## Key Patterns for New Agent

### Adding a New Feature
1. Read AGENTS.md for conventions and existing patterns
2. Implement in the relevant files (API routes, frontend HTML/JS)
3. Add tests to existing spec file or create new one if new feature area
4. Rebuild containers: `docker compose build --no-cache api web && docker compose up -d`
5. Run fast tests: `npm run test:fast 2>&1 | tee tmp_test_output.txt`
6. Update docs (AGENTS.md milestones, README.md features, TESTING.md endpoints)
7. Ask user about committing and release tagging

### Debugging Slicer Issues
1. Check per-job log: `docker exec u1-slicer-bridge-api-1 cat /data/logs/slice_*.log`
2. Check API logs: `docker logs u1-slicer-bridge-api-1`
3. Common causes: Bambu metadata not sanitized, temperature format wrong, missing model_settings.config entries
4. Test with calib-cube (fast ~2s slice) before testing with larger files

### Database Changes
1. Add column with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in schema.sql
2. Also add runtime migration in the relevant Python code (for existing databases)
3. Restart API container to apply: `docker compose build --no-cache api && docker compose up -d api`

