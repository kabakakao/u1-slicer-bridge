# AGENTS.md — AI Coding Agent Operating Manual (u1-slicer-bridge)

This repo is intended to be built with an AI coding agent (Claude Code in VS Code). Treat this document as binding.

---

## Project purpose

Self-hostable, Docker-first service for Snapmaker U1:

upload `.3mf` → validate plate → slice with Snapmaker OrcaSlicer → preview → print via Moonraker.

**Current Status:** Fully functional upload-to-preview workflow. Print control (M8) not yet implemented.

---

## Non-goals (v1)

- No MakerWorld scraping (use browser downloads)
- No per-object filament assignment (single filament per plate)
- No mesh repair or geometry modifications
- No multi-material/MMU support
- LAN-first by default (no cloud dependencies)

---

## Definition of Done (DoD)

A change is complete only if:

### Docker works
`docker compose up -d --build` must succeed.

### Health works
`curl http://localhost:8000/healthz` returns JSON.

### Deterministic
- Orca version pinned
- per-bundle sandbox
- no global slicer state

### Logs
Every job writes `/data/logs/{job_id}.log`.

### Errors
Errors must be understandable and visible in API/UI.

---

## Core invariants (do not break)

### Docker-first
Everything runs via compose.

### Snapmaker OrcaSlicer fork
Use Snapmaker's v2.2.4 fork for Bambu file compatibility.

### Preserve plate arrangements
Never normalize objects - preserve MakerWorld/Bambu layouts.

### LAN-first security
Secrets encrypted via `APP_SECRET_KEY`.

### Storage layout
Under `/data`:
- uploads/ - Uploaded 3MF files
- slices/ - Generated G-code
- logs/ - Per-job logs
- cache/ - Temporary processing files

---

## How Claude should behave

Prefer:
- small safe steps
- minimal moving parts
- explicit over magic
- worker for heavy tasks

Avoid:
- new infra unless necessary
- hidden state
- plaintext secrets

### Documentation Maintenance

**CRITICAL:** As you make fixes, implement features, or discover issues:

1. **Update AGENTS.md** when you:
   - Discover new invariants or patterns
   - Learn about system behavior that affects future work
   - Identify new constraints or requirements
   - Complete milestones or major features

2. **Update MEMORY.md** when you:
   - Fix bugs (document root cause + solution)
   - Discover configuration issues
   - Learn about performance or optimization patterns
   - Find differences between expected/actual behavior
   - Identify recurring problems and their solutions

**Keep these files living documents.** Don't wait to be asked - update them proactively as you work.

---

## Milestones Status

✅ M0 skeleton - Docker, FastAPI, services
✅ M1 database - PostgreSQL with uploads, jobs, filaments
⚠️ M2 moonraker - Health check only (no print control yet)
✅ M3 object extraction - 3MF parser (handles MakerWorld files)
✅ M4 ~~normalization~~ → plate validation - Preserves arrangements
✅ M5 ~~bundles~~ → direct slicing - Upload → slice workflow
✅ M6 slicing - Snapmaker OrcaSlicer v2.2.4, Bambu support
✅ M7 preview - Interactive 2D layer viewer
❌ M8 print control - NOT IMPLEMENTED

**Current:** 6.5 / 8 complete (81%)

---

## Plate Validation Contract

Entire plate must:
- Fit within 270x270x270mm build volume
- Return clear warning if exceeds bounds
- Preserve original object arrangements from 3MF

---

## G-code contract

Compute:
- bounds
- layers
- tool changes

Warn if out of bounds.

---

## Web Container Deployment

**CRITICAL:** The web service uses `COPY` in Dockerfile, not volume mounts.

After editing any web files (`index.html`, `app.js`, `api.js`, `viewer.js`):
```bash
docker compose build web && docker compose up -d web
```

Then users must hard refresh browser (Ctrl+Shift+R).

**Why:** Files are baked into the image at build time (see `apps/web/Dockerfile` lines 7-10).

---

## Logging contract

All subprocess output must go to `/data/logs`.
