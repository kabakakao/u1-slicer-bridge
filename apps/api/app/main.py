from __future__ import annotations

from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional, List
import json
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from db import init_db, close_db
from moonraker import init_moonraker, close_moonraker, get_moonraker
from routes_upload import router as upload_router
from routes_slice import router as slice_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await init_db()
    await init_moonraker()
    yield
    # Shutdown
    await close_moonraker()
    await close_db()


app = FastAPI(lifespan=lifespan)

# Configure CORS to allow web UI to access API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080", "http://127.0.0.1:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(upload_router)
app.include_router(slice_router)


@app.get("/")
def root():
    return {
        "name": "U1 Slicer Bridge API",
        "version": "1.0.0",
        "web_ui": "http://localhost:8080",
        "endpoints": {
            "health": "/healthz",
            "printer": "/printer/status",
            "upload": "POST /upload",
            "uploads": "GET /upload",
            "slice": "POST /uploads/{id}/slice",
            "job_status": "GET /jobs/{job_id}"
        }
    }


@app.get("/healthz")
def health():
    return {"status": "ok"}


@app.get("/printer/status")
async def printer_status():
    """Get printer connection status and info."""
    client = get_moonraker()

    if not client:
        return {
            "connected": False,
            "message": "Moonraker not configured. Set MOONRAKER_URL environment variable."
        }

    is_healthy = await client.health_check()
    if not is_healthy:
        return {
            "connected": False,
            "message": "Cannot reach Moonraker. Check printer network connection."
        }

    try:
        server_info = await client.get_server_info()
        printer_info = await client.get_printer_info()

        return {
            "connected": True,
            "server": server_info.get("result", {}),
            "printer": printer_info.get("result", {})
        }
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Printer error: {str(e)}")


class FilamentCreate(BaseModel):
    name: str
    material: str
    nozzle_temp: int
    bed_temp: int
    print_speed: Optional[int] = 60
    bed_type: str = "PEI"
    color_hex: str = "#FFFFFF"
    extruder_index: int = 0
    is_default: bool = False
    source_type: str = "manual"


class FilamentUpdate(BaseModel):
    name: str
    material: str
    nozzle_temp: int
    bed_temp: int
    print_speed: Optional[int] = 60
    bed_type: str = "PEI"
    color_hex: str = "#FFFFFF"
    extruder_index: int = 0
    is_default: bool = False
    source_type: str = "manual"


async def _ensure_filament_schema(conn):
    await conn.execute("ALTER TABLE filaments ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual'")


class ExtruderPreset(BaseModel):
    slot: int
    filament_id: Optional[int] = None
    color_hex: str = "#FFFFFF"


class SlicingDefaults(BaseModel):
    layer_height: float = 0.2
    infill_density: int = 15
    wall_count: int = 3
    infill_pattern: str = "gyroid"
    supports: bool = False
    enable_prime_tower: bool = False
    prime_volume: Optional[int] = None
    prime_tower_width: Optional[int] = None
    prime_tower_brim_width: Optional[int] = None
    prime_tower_brim_chamfer: bool = True
    prime_tower_brim_chamfer_max_width: Optional[int] = None
    nozzle_temp: Optional[int] = None
    bed_temp: Optional[int] = None
    bed_type: Optional[str] = None


class ExtruderPresetUpdate(BaseModel):
    extruders: List[ExtruderPreset]
    slicing_defaults: Optional[SlicingDefaults] = None


async def _ensure_preset_rows(conn):
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS extruder_presets (
            slot INTEGER PRIMARY KEY,
            filament_id INTEGER REFERENCES filaments(id) ON DELETE SET NULL,
            color_hex VARCHAR(7) NOT NULL DEFAULT '#FFFFFF',
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT chk_extruder_preset_slot CHECK (slot BETWEEN 1 AND 4)
        )
        """
    )

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS slicing_defaults (
            id INTEGER PRIMARY KEY,
            layer_height REAL NOT NULL DEFAULT 0.2,
            infill_density INTEGER NOT NULL DEFAULT 15,
            wall_count INTEGER NOT NULL DEFAULT 3,
            infill_pattern TEXT NOT NULL DEFAULT 'gyroid',
            supports BOOLEAN NOT NULL DEFAULT FALSE,
            enable_prime_tower BOOLEAN NOT NULL DEFAULT FALSE,
            prime_volume INTEGER,
            prime_tower_width INTEGER,
            prime_tower_brim_width INTEGER,
            prime_tower_brim_chamfer BOOLEAN NOT NULL DEFAULT TRUE,
            prime_tower_brim_chamfer_max_width INTEGER,
            nozzle_temp INTEGER,
            bed_temp INTEGER,
            bed_type TEXT,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            CONSTRAINT chk_slicing_defaults_single_row CHECK (id = 1)
        )
        """
    )

    await conn.execute("ALTER TABLE slicing_defaults ADD COLUMN IF NOT EXISTS enable_prime_tower BOOLEAN NOT NULL DEFAULT FALSE")
    await conn.execute("ALTER TABLE slicing_defaults ADD COLUMN IF NOT EXISTS prime_volume INTEGER")
    await conn.execute("ALTER TABLE slicing_defaults ADD COLUMN IF NOT EXISTS prime_tower_width INTEGER")
    await conn.execute("ALTER TABLE slicing_defaults ADD COLUMN IF NOT EXISTS prime_tower_brim_width INTEGER")
    await conn.execute("ALTER TABLE slicing_defaults ADD COLUMN IF NOT EXISTS prime_tower_brim_chamfer BOOLEAN NOT NULL DEFAULT TRUE")
    await conn.execute("ALTER TABLE slicing_defaults ADD COLUMN IF NOT EXISTS prime_tower_brim_chamfer_max_width INTEGER")

    for slot in range(1, 5):
        fallback_filament_id = await conn.fetchval(
            """
            SELECT id FROM filaments
            WHERE extruder_index = $1
            ORDER BY is_default DESC, id ASC
            LIMIT 1
            """,
            slot - 1,
        )
        await conn.execute(
            """
            INSERT INTO extruder_presets (slot, filament_id, color_hex)
            VALUES ($1, $2, '#FFFFFF')
            ON CONFLICT (slot) DO NOTHING
            """,
            slot,
            fallback_filament_id,
        )

    await conn.execute(
        """
        INSERT INTO slicing_defaults (id)
        VALUES (1)
        ON CONFLICT (id) DO NOTHING
        """
    )


@app.get("/filaments")
async def get_filaments():
    """Get all configured filament profiles."""
    from db import get_pg_pool
    pool = get_pg_pool()

    async with pool.acquire() as conn:
        await _ensure_filament_schema(conn)
        rows = await conn.fetch(
            """
            SELECT id, name, material, nozzle_temp, bed_temp, print_speed, bed_type, color_hex, extruder_index, is_default, source_type
            FROM filaments
            ORDER BY is_default DESC,
                     CASE WHEN UPPER(material) = 'PLA' THEN 0 ELSE 1 END,
                     name
            """
        )

        filaments = [
            {
                "id": row["id"],
                "name": row["name"],
                "material": row["material"],
                "nozzle_temp": row["nozzle_temp"],
                "bed_temp": row["bed_temp"],
                "print_speed": row["print_speed"],
                "bed_type": row["bed_type"] or "PEI",
                "color_hex": row["color_hex"] or "#FFFFFF",
                "extruder_index": row["extruder_index"] or 0,
                "is_default": row["is_default"],
                "source_type": row["source_type"] or "manual",
            }
            for row in rows
        ]

        return {"filaments": filaments}


@app.get("/presets/extruders")
async def get_extruder_presets():
    """Get extruder presets and default slicing settings."""
    from db import get_pg_pool
    pool = get_pg_pool()

    async with pool.acquire() as conn:
        await _ensure_preset_rows(conn)

        preset_rows = await conn.fetch(
            """
            SELECT slot, filament_id, color_hex
            FROM extruder_presets
            ORDER BY slot
            """
        )

        defaults = await conn.fetchrow(
            """
            SELECT layer_height, infill_density, wall_count, infill_pattern,
                   supports, enable_prime_tower, prime_volume, prime_tower_width, prime_tower_brim_width,
                   prime_tower_brim_chamfer, prime_tower_brim_chamfer_max_width,
                   nozzle_temp, bed_temp, bed_type
            FROM slicing_defaults
            WHERE id = 1
            """
        )

    return {
        "extruders": [
            {
                "slot": row["slot"],
                "filament_id": row["filament_id"],
                "color_hex": row["color_hex"] or "#FFFFFF",
            }
            for row in preset_rows
        ],
        "slicing_defaults": {
            "layer_height": round(float(defaults["layer_height"]), 3) if defaults["layer_height"] is not None else 0.2,
            "infill_density": defaults["infill_density"],
            "wall_count": defaults["wall_count"],
            "infill_pattern": defaults["infill_pattern"],
            "supports": defaults["supports"],
            "enable_prime_tower": defaults["enable_prime_tower"],
            "prime_volume": defaults["prime_volume"],
            "prime_tower_width": defaults["prime_tower_width"],
            "prime_tower_brim_width": defaults["prime_tower_brim_width"],
            "prime_tower_brim_chamfer": defaults["prime_tower_brim_chamfer"],
            "prime_tower_brim_chamfer_max_width": defaults["prime_tower_brim_chamfer_max_width"],
            "nozzle_temp": defaults["nozzle_temp"],
            "bed_temp": defaults["bed_temp"],
            "bed_type": defaults["bed_type"],
        },
    }


@app.put("/presets/extruders")
async def update_extruder_presets(payload: ExtruderPresetUpdate):
    """Update extruder presets and optional global slicing defaults."""
    from db import get_pg_pool
    pool = get_pg_pool()

    if len(payload.extruders) != 4:
        raise HTTPException(status_code=400, detail="Exactly 4 extruder presets are required (E1-E4).")

    slots = sorted(p.slot for p in payload.extruders)
    if slots != [1, 2, 3, 4]:
        raise HTTPException(status_code=400, detail="Extruder preset slots must be exactly [1,2,3,4].")

    async with pool.acquire() as conn:
        await _ensure_preset_rows(conn)

        # Validate filament IDs exist when provided.
        requested_ids = [p.filament_id for p in payload.extruders if p.filament_id is not None]
        if requested_ids:
            found = await conn.fetch(
                "SELECT id FROM filaments WHERE id = ANY($1)",
                requested_ids,
            )
            found_ids = {row["id"] for row in found}
            missing = [fid for fid in requested_ids if fid not in found_ids]
            if missing:
                raise HTTPException(status_code=404, detail=f"Filament IDs not found: {missing}")

        for preset in payload.extruders:
            await conn.execute(
                """
                INSERT INTO extruder_presets (slot, filament_id, color_hex, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (slot) DO UPDATE SET
                    filament_id = EXCLUDED.filament_id,
                    color_hex = EXCLUDED.color_hex,
                    updated_at = NOW()
                """,
                preset.slot,
                preset.filament_id,
                preset.color_hex,
            )

        if payload.slicing_defaults is not None:
            d = payload.slicing_defaults
            await conn.execute(
                """
                INSERT INTO slicing_defaults (
                    id, layer_height, infill_density, wall_count, infill_pattern,
                    supports, enable_prime_tower, prime_volume, prime_tower_width, prime_tower_brim_width,
                    prime_tower_brim_chamfer, prime_tower_brim_chamfer_max_width,
                    nozzle_temp, bed_temp, bed_type, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
                ON CONFLICT (id) DO UPDATE SET
                    layer_height = EXCLUDED.layer_height,
                    infill_density = EXCLUDED.infill_density,
                    wall_count = EXCLUDED.wall_count,
                    infill_pattern = EXCLUDED.infill_pattern,
                    supports = EXCLUDED.supports,
                    enable_prime_tower = EXCLUDED.enable_prime_tower,
                    prime_volume = EXCLUDED.prime_volume,
                    prime_tower_width = EXCLUDED.prime_tower_width,
                    prime_tower_brim_width = EXCLUDED.prime_tower_brim_width,
                    prime_tower_brim_chamfer = EXCLUDED.prime_tower_brim_chamfer,
                    prime_tower_brim_chamfer_max_width = EXCLUDED.prime_tower_brim_chamfer_max_width,
                    nozzle_temp = EXCLUDED.nozzle_temp,
                    bed_temp = EXCLUDED.bed_temp,
                    bed_type = EXCLUDED.bed_type,
                    updated_at = NOW()
                """,
                1,
                d.layer_height,
                d.infill_density,
                d.wall_count,
                d.infill_pattern,
                d.supports,
                d.enable_prime_tower,
                d.prime_volume,
                d.prime_tower_width,
                d.prime_tower_brim_width,
                d.prime_tower_brim_chamfer,
                d.prime_tower_brim_chamfer_max_width,
                d.nozzle_temp,
                d.bed_temp,
                d.bed_type,
            )

    return {"message": "Extruder presets updated"}


@app.post("/filaments")
async def create_filament(filament: FilamentCreate):
    """Create a new filament profile."""
    from db import get_pg_pool
    pool = get_pg_pool()

    async with pool.acquire() as conn:
        await _ensure_filament_schema(conn)
        async with conn.transaction():
            if filament.is_default:
                await conn.execute("UPDATE filaments SET is_default = FALSE WHERE is_default = TRUE")

            try:
                result = await conn.fetchrow(
                    """
                    INSERT INTO filaments (name, material, nozzle_temp, bed_temp, print_speed, bed_type, color_hex, extruder_index, is_default, source_type)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    RETURNING id
                    """,
                    filament.name,
                    filament.material,
                    filament.nozzle_temp,
                    filament.bed_temp,
                    filament.print_speed,
                    filament.bed_type,
                    filament.color_hex,
                    filament.extruder_index,
                    filament.is_default,
                    filament.source_type,
                )
            except Exception as e:
                if "duplicate key" in str(e).lower() or "unique" in str(e).lower():
                    raise HTTPException(status_code=409, detail="Filament name already exists")
                raise

        return {"id": result["id"], "message": "Filament created"}


@app.put("/filaments/{filament_id}")
async def update_filament(filament_id: int, filament: FilamentUpdate):
    """Update a filament profile."""
    from db import get_pg_pool
    pool = get_pg_pool()

    async with pool.acquire() as conn:
        await _ensure_filament_schema(conn)
        async with conn.transaction():
            existing = await conn.fetchrow("SELECT id FROM filaments WHERE id = $1", filament_id)
            if not existing:
                raise HTTPException(status_code=404, detail="Filament not found")

            if filament.is_default:
                await conn.execute("UPDATE filaments SET is_default = FALSE WHERE id != $1", filament_id)

            try:
                await conn.execute(
                    """
                    UPDATE filaments
                    SET name = $1,
                        material = $2,
                        nozzle_temp = $3,
                        bed_temp = $4,
                        print_speed = $5,
                        bed_type = $6,
                        color_hex = $7,
                        extruder_index = $8,
                        is_default = $9,
                        source_type = $10
                    WHERE id = $11
                    """,
                    filament.name,
                    filament.material,
                    filament.nozzle_temp,
                    filament.bed_temp,
                    filament.print_speed,
                    filament.bed_type,
                    filament.color_hex,
                    filament.extruder_index,
                    filament.is_default,
                    filament.source_type,
                    filament_id,
                )
            except Exception as e:
                if "duplicate key" in str(e).lower() or "unique" in str(e).lower():
                    raise HTTPException(status_code=409, detail="Filament name already exists")
                raise

    return {"message": "Filament updated"}


@app.post("/filaments/{filament_id}/default")
async def set_default_filament(filament_id: int):
    """Set one filament as the default fallback filament."""
    from db import get_pg_pool
    pool = get_pg_pool()

    async with pool.acquire() as conn:
        async with conn.transaction():
            existing = await conn.fetchrow("SELECT id FROM filaments WHERE id = $1", filament_id)
            if not existing:
                raise HTTPException(status_code=404, detail="Filament not found")

            await conn.execute("UPDATE filaments SET is_default = FALSE")
            await conn.execute("UPDATE filaments SET is_default = TRUE WHERE id = $1", filament_id)

    return {"message": "Default filament updated"}


@app.delete("/filaments/{filament_id}")
async def delete_filament(filament_id: int):
    """Delete a filament profile with safety checks."""
    from db import get_pg_pool
    pool = get_pg_pool()

    async with pool.acquire() as conn:
        async with conn.transaction():
            existing = await conn.fetchrow("SELECT id, name, is_default FROM filaments WHERE id = $1", filament_id)
            if not existing:
                raise HTTPException(status_code=404, detail="Filament not found")

            usage = await conn.fetch("SELECT slot FROM extruder_presets WHERE filament_id = $1 ORDER BY slot", filament_id)
            if usage:
                slots = [f"E{row['slot']}" for row in usage]
                raise HTTPException(
                    status_code=400,
                    detail=f"Filament is assigned to printer presets ({', '.join(slots)}). Reassign those slots first.",
                )

            total_count = await conn.fetchval("SELECT COUNT(*) FROM filaments")
            if int(total_count or 0) <= 1:
                raise HTTPException(status_code=400, detail="Cannot delete the only filament profile")

            await conn.execute("DELETE FROM filaments WHERE id = $1", filament_id)

            if existing["is_default"]:
                replacement_id = await conn.fetchval(
                    """
                    SELECT id
                    FROM filaments
                    ORDER BY CASE WHEN UPPER(material) = 'PLA' THEN 0 ELSE 1 END, name
                    LIMIT 1
                    """
                )
                if replacement_id is not None:
                    await conn.execute("UPDATE filaments SET is_default = TRUE WHERE id = $1", replacement_id)

    return {"message": "Filament deleted"}


def _extract_profile_value(data, keys: List[str], default=None):
    if not isinstance(data, dict):
        return default
    for key in keys:
        if key in data and data[key] is not None:
            value = data[key]
            if isinstance(value, list) and value:
                return value[0]
            return value
    return default


@app.post("/filaments/import")
async def import_filament_profile(file: UploadFile = File(...)):
    """Import a filament profile from JSON and add to library."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    if not file.filename.lower().endswith(".json"):
        raise HTTPException(status_code=400, detail="Only JSON filament profiles are supported for now")

    try:
        raw = await file.read()
        payload = json.loads(raw.decode("utf-8", errors="ignore"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON profile file")

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Profile JSON must be an object")

    root = payload.get("filament") if isinstance(payload.get("filament"), dict) else payload

    profile_name = str(
        _extract_profile_value(root, ["name", "filament_name", "profile_name"], None)
        or file.filename.rsplit(".", 1)[0]
    ).strip()

    material = str(_extract_profile_value(root, ["material", "filament_type", "type"], "PLA")).strip().upper()
    def _as_int(value, fallback: int) -> int:
        try:
            return int(float(value))
        except Exception:
            return fallback

    nozzle_temp = _as_int(_extract_profile_value(root, ["nozzle_temp", "temperature", "nozzle_temperature"], 210), 210)
    bed_temp = _as_int(_extract_profile_value(root, ["bed_temp", "bed_temperature"], 60), 60)
    print_speed = _as_int(_extract_profile_value(root, ["print_speed", "speed"], 60), 60)
    bed_type = str(_extract_profile_value(root, ["bed_type", "build_plate_type"], "PEI")).strip() or "PEI"
    color_hex = str(_extract_profile_value(root, ["color_hex", "color"], "#FFFFFF")).strip()
    if not color_hex.startswith("#"):
        color_hex = f"#{color_hex}"
    if len(color_hex) == 4:
        color_hex = f"#{color_hex[1]*2}{color_hex[2]*2}{color_hex[3]*2}"
    color_hex = color_hex[:7]

    from db import get_pg_pool
    pool = get_pg_pool()
    async with pool.acquire() as conn:
        await _ensure_filament_schema(conn)

        existing = await conn.fetchrow("SELECT id FROM filaments WHERE name = $1", profile_name)
        if existing:
            raise HTTPException(status_code=409, detail="A filament with this profile name already exists")

        row = await conn.fetchrow(
            """
            INSERT INTO filaments (
                name, material, nozzle_temp, bed_temp, print_speed,
                bed_type, color_hex, extruder_index, is_default, source_type
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0, FALSE, 'custom')
            RETURNING id
            """,
            profile_name,
            material,
            nozzle_temp,
            bed_temp,
            print_speed,
            bed_type,
            color_hex,
        )

    return {"id": row["id"], "message": "Filament profile imported", "name": profile_name}


@app.post("/filaments/init-defaults")
async def init_default_filaments():
    """Initialize default filament profiles."""
    from db import get_pg_pool
    pool = get_pg_pool()

    default_filaments = [
        {"name": "PLA Red", "material": "PLA", "nozzle_temp": 210, "bed_temp": 60, "print_speed": 60, "bed_type": "PEI", "color_hex": "#FF0000", "extruder_index": 0, "is_default": True, "source_type": "starter"},
        {"name": "PLA Blue", "material": "PLA", "nozzle_temp": 210, "bed_temp": 60, "print_speed": 60, "bed_type": "PEI", "color_hex": "#0000FF", "extruder_index": 1, "is_default": False, "source_type": "starter"},
        {"name": "PLA Green", "material": "PLA", "nozzle_temp": 210, "bed_temp": 60, "print_speed": 60, "bed_type": "PEI", "color_hex": "#00FF00", "extruder_index": 2, "is_default": False, "source_type": "starter"},
        {"name": "PLA Yellow", "material": "PLA", "nozzle_temp": 210, "bed_temp": 60, "print_speed": 60, "bed_type": "PEI", "color_hex": "#FFFF00", "extruder_index": 3, "is_default": False, "source_type": "starter"},
        {"name": "PETG", "material": "PETG", "nozzle_temp": 240, "bed_temp": 80, "print_speed": 50, "bed_type": "PEI", "color_hex": "#FF6600", "extruder_index": 0, "is_default": False, "source_type": "starter"},
        {"name": "ABS", "material": "ABS", "nozzle_temp": 250, "bed_temp": 100, "print_speed": 50, "bed_type": "Glass", "color_hex": "#333333", "extruder_index": 0, "is_default": False, "source_type": "starter"},
        {"name": "TPU", "material": "TPU", "nozzle_temp": 220, "bed_temp": 40, "print_speed": 30, "bed_type": "PEI", "color_hex": "#FF00FF", "extruder_index": 0, "is_default": False, "source_type": "starter"},
    ]

    async with pool.acquire() as conn:
        await _ensure_filament_schema(conn)
        for f in default_filaments:
            try:
                await conn.execute(
                    """
                    INSERT INTO filaments (name, material, nozzle_temp, bed_temp, print_speed, bed_type, color_hex, extruder_index, is_default, source_type)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    ON CONFLICT (name) DO NOTHING
                    """,
                    f["name"], f["material"], f["nozzle_temp"], f["bed_temp"],
                    f["print_speed"], f["bed_type"], f["color_hex"], f["extruder_index"], f["is_default"], f["source_type"]
                )
            except Exception as e:
                pass

        return {"message": "Default filaments initialized"}
