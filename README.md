# U1 Slicer Bridge

**Repository:** https://github.com/taylormadearmy/u1-slicer-bridge

Self-hostable, Docker-first service for Snapmaker U1 3D printing workflow.

## Overview

U1 Slicer Bridge provides a complete workflow for 3D printing with the Snapmaker U1:

```
upload → validate → slice → preview → print
```

**Key Features:**
- Upload `.3mf` files (including MakerWorld/Bambu Studio files)
- Automatic plate validation (270x270x270mm build volume)
- Slicing with Snapmaker OrcaSlicer fork (v2.2.4)
- Interactive G-code preview with layer-by-layer visualization
- Modern web UI with 3-step workflow
- Print control via Moonraker API (partial)

## Architecture

- **Docker-first:** Everything runs via `docker-compose`
- **Snapmaker OrcaSlicer:** Uses Snapmaker's fork (v2.2.4) for Bambu file compatibility
- **Plate-based workflow:** Preserves MakerWorld arrangements, no object normalization
- **LAN-first security:** Designed for local network use
- **Deterministic:** Pinned versions, per-job sandboxing, no global state

### Services

- **API** (`apps/api/`) - FastAPI service for workflow orchestration
- **Worker** (`apps/worker/`) - Background processing for heavy tasks
- **Web** (`apps/web/`) - Frontend interface

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Snapmaker U1 with Moonraker API enabled

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

## Storage Layout

All data is stored under `/data`:
- `uploads/` - Uploaded .3mf files
- `slices/` - Generated G-code files
- `logs/` - Per-job log files
- `cache/` - Temporary processing files

## Documentation

- [AGENTS.md](AGENTS.md) - AI coding agent operating manual
- [TESTING.md](TESTING.md) - Testing procedures
- [TEST_RESULTS.md](TEST_RESULTS.md) - Test execution results
- [docs/spec.md](docs/spec.md) - Workflow specification

## Development

This project is designed to be built with AI coding agents (Claude Code). See [AGENTS.md](AGENTS.md) for development guidelines and invariants.

### Milestones

- ✅ M0: Skeleton (Docker, FastAPI, services)
- ✅ M1: Database (PostgreSQL with uploads, jobs, filaments)
- ⚠️ M2: Moonraker integration (health check only, no print control)
- ✅ M3: Object extraction (3MF parser with external references)
- ✅ M4: ~~Normalization~~ → Plate validation (preserves arrangements)
- ✅ M5: ~~Bundles~~ → Direct slicing with filament profiles
- ✅ M6: Slicing (Snapmaker OrcaSlicer, Bambu file support)
- ✅ M7: Preview (Interactive 2D layer viewer)
- ❌ M8: Print control (not implemented)

**Progress:** 6.5 / 8 complete (81%)

## Non-Goals (v1)

- MakerWorld scraping (use browser download)
- Per-object filament assignment (single filament per plate)
- Mesh repair or geometry modifications
- Multi-material/MMU support

## License

Private repository - All rights reserved

## Author

Maintained by taylormadearmy
