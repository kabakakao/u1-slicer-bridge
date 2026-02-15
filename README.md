# U1 Slicer Bridge

**Repository:** https://github.com/taylormadearmy/u1-slicer-bridge

Self-hostable, Docker-first service for Snapmaker U1 3D printing workflow.

## Overview

U1 Slicer Bridge provides a complete workflow for 3D printing with the Snapmaker U1:

```
upload .3mf → validate plate → configure → slice → preview
```

**Key Features:**
- Upload `.3mf` files (including MakerWorld/Bambu Studio exports)
- Multi-plate 3MF support with per-plate validation and visual selection
- Multicolour/multi-extruder slicing (up to 4 extruders)
- Automatic plate validation (270x270x270mm build volume)
- Slicing with Snapmaker OrcaSlicer fork (v2.2.4)
- Interactive 2D G-code preview with layer-by-layer visualization and colour legend
- Configurable slicing options (wall count, infill pattern/density, prime tower)
- Persistent extruder presets and filament library with JSON profile import
- Temperature and build plate type overrides per job
- File management (browse, download, delete uploads and sliced files)
- Modern web UI with upload/settings tabs and 3-step slice workflow

## Architecture

- **Docker-first:** Everything runs via `docker compose`
- **Snapmaker OrcaSlicer:** Uses Snapmaker's fork (v2.2.4) for Bambu file compatibility
- **Plate-based workflow:** Preserves MakerWorld/Bambu Studio arrangements, no object normalization
- **LAN-first security:** Designed for local network use, secrets encrypted via `APP_SECRET_KEY`
- **Deterministic:** Pinned slicer version, per-job sandboxing, no global slicer state

### Services

| Service | Path | Description |
|---------|------|-------------|
| API | `apps/api/` | FastAPI backend - upload, parse, slice, job management |
| Worker | `apps/worker/` | Background processing for heavy tasks |
| Web | `apps/web/` | Nginx + static frontend (Alpine.js) |
| PostgreSQL | via compose | Persistent storage for uploads, jobs, filaments, presets |

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Snapmaker U1 with Moonraker API enabled (optional - needed for print control)

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/taylormadearmy/u1-slicer-bridge.git
   cd u1-slicer-bridge
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env and set your APP_SECRET_KEY and MOONRAKER_URL
   ```

3. Start services:
   ```bash
   docker compose up -d --build
   ```

4. Verify health:
   ```bash
   curl http://localhost:8000/healthz
   ```

5. Open the web UI: http://localhost:8080

## Storage Layout

All data is stored under `/data`:

| Directory | Purpose |
|-----------|---------|
| `uploads/` | Uploaded .3mf files |
| `slices/` | Generated G-code files |
| `logs/` | Per-job log files |
| `cache/` | Temporary processing files |

## Milestones

### Complete

| ID | Feature |
|----|---------|
| M0 | Skeleton - Docker, FastAPI, services |
| M1 | Database - PostgreSQL with uploads, jobs, filaments |
| M3 | Object extraction - 3MF parser (handles MakerWorld files) |
| M4 | Plate validation - Preserves arrangements |
| M5 | Direct slicing with filament profiles |
| M6 | Slicing - Snapmaker OrcaSlicer v2.2.4, Bambu support |
| M7 | Preview - Interactive 2D layer viewer |
| M7.1 | Multi-plate support - Detection and visual selection |
| M7.2 | Build plate type & temperature overrides |
| M9 | Sliced file access - Browse and view G-code files |
| M10 | File deletion - Delete old uploads and sliced files |
| M11 | Multifilament support - Colour detection, auto-assignment, override |
| M15 | Multicolour viewer - Colour legend in 2D viewer |
| M16 | Flexible filament assignment - Override colour per extruder |
| M17 | Prime tower options - Configurable prime tower settings |
| M18 | Multi-plate visual selection - Plate names and preview images |
| M21 | Upload/configure loading UX - Progress indicators |
| M22 | Navigation consistency - Standardized actions across UI |
| M23 | Common slicing options - Wall count, infill pattern, density |
| M24 | Extruder presets - Default settings per extruder |

### Not Yet Implemented

| ID | Feature |
|----|---------|
| M2 | Moonraker integration (health check only, no print control) |
| M8 | Print control via Moonraker |
| M12 | 3D G-code viewer |
| M13 | Custom filament profiles (JSON import foundation exists) |
| M14 | Multi-machine support |
| M19 | Slicer selection (OrcaSlicer vs Snapmaker Orca) |
| M20 | G-code viewer zoom controls |

**Progress:** 19.7 / 24 milestones complete (82%)

## Non-Goals (v1)

- MakerWorld scraping (use browser download)
- Per-object filament assignment (single filament per plate)
- Mesh repair or geometry modifications
- Multi-material/MMU support
- Cloud dependencies (LAN-first by default)

## Documentation

- [AGENTS.md](AGENTS.md) - AI coding agent operating manual (authoritative milestone tracker)
- [MEMORY.md](MEMORY.md) - Bug fix journal with root causes and solutions
- [TESTING.md](TESTING.md) - Testing procedures and API endpoint reference

## Development

This project is designed to be built with AI coding agents (Claude Code in VS Code). See [AGENTS.md](AGENTS.md) for development guidelines, invariants, and definition of done.

### Rebuilding After Changes

Web files are baked into the Docker image at build time:
```bash
docker compose build web && docker compose up -d web
```
Then hard refresh browser (Ctrl+Shift+R).

For API changes:
```bash
docker compose build api && docker compose up -d api
```

## License

Private repository - All rights reserved

## Author

Maintained by taylormadearmy
