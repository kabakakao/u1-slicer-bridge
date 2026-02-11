from fastapi import FastAPI, HTTPException
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


@app.get("/filaments")
async def get_filaments():
    """Get all configured filament profiles."""
    from db import get_pg_pool
    pool = get_pg_pool()

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, material, nozzle_temp, bed_temp, print_speed, is_default FROM filaments ORDER BY name"
        )

        filaments = [
            {
                "id": row["id"],
                "name": row["name"],
                "material": row["material"],
                "nozzle_temp": row["nozzle_temp"],
                "bed_temp": row["bed_temp"],
                "print_speed": row["print_speed"],
                "is_default": row["is_default"]
            }
            for row in rows
        ]

        return {"filaments": filaments}
