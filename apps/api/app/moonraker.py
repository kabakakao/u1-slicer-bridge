import os
import re
from pathlib import Path
from typing import Optional, Dict, Any
import httpx


class MoonrakerClient:
    """Moonraker API client for printer communication."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.client: Optional[httpx.AsyncClient] = None

    async def connect(self):
        """Initialize HTTP client."""
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=10.0,
            follow_redirects=True
        )

    async def close(self):
        """Close HTTP client."""
        if self.client:
            await self.client.aclose()
            self.client = None

    async def reconnect(self, new_url: str):
        """Close existing connection and reconnect to a new URL."""
        await self.close()
        self.base_url = new_url.rstrip("/")
        await self.connect()

    async def get_printer_info(self) -> Dict[str, Any]:
        """Get printer information and status."""
        if not self.client:
            raise RuntimeError("Client not connected. Call connect() first.")

        response = await self.client.get("/printer/info")
        response.raise_for_status()
        return response.json()

    async def get_server_info(self) -> Dict[str, Any]:
        """Get Moonraker server information."""
        if not self.client:
            raise RuntimeError("Client not connected. Call connect() first.")

        response = await self.client.get("/server/info")
        response.raise_for_status()
        return response.json()

    async def health_check(self) -> bool:
        """Check if Moonraker is reachable."""
        try:
            await self.get_server_info()
            return True
        except Exception:
            return False

    async def upload_gcode(self, gcode_path: str, filename: str) -> Dict[str, Any]:
        """Upload a G-code file to Moonraker's virtual SD card."""
        if not self.client:
            raise RuntimeError("Client not connected. Call connect() first.")

        path = Path(gcode_path)
        if not path.exists():
            raise FileNotFoundError(f"G-code file not found: {gcode_path}")

        file_size = path.stat().st_size
        # Dynamic timeout: min 30s, ~1s per MB, max 300s
        upload_timeout = min(300.0, max(30.0, file_size / (1024 * 1024)))

        with open(path, "rb") as f:
            files = {"file": (filename, f, "application/octet-stream")}
            data = {"root": "gcodes"}
            response = await self.client.post(
                "/server/files/upload",
                files=files,
                data=data,
                timeout=upload_timeout,
            )
        response.raise_for_status()
        return response.json()

    async def start_print(self, filename: str) -> Dict[str, Any]:
        """Start printing a file already uploaded to the printer."""
        if not self.client:
            raise RuntimeError("Client not connected. Call connect() first.")

        response = await self.client.post(
            "/printer/print/start",
            params={"filename": filename},
        )
        response.raise_for_status()
        return response.json()

    async def pause_print(self) -> Dict[str, Any]:
        """Pause the current print."""
        if not self.client:
            raise RuntimeError("Client not connected. Call connect() first.")
        response = await self.client.post("/printer/print/pause")
        response.raise_for_status()
        return response.json()

    async def resume_print(self) -> Dict[str, Any]:
        """Resume a paused print."""
        if not self.client:
            raise RuntimeError("Client not connected. Call connect() first.")
        response = await self.client.post("/printer/print/resume")
        response.raise_for_status()
        return response.json()

    async def cancel_print(self) -> Dict[str, Any]:
        """Cancel the current print."""
        if not self.client:
            raise RuntimeError("Client not connected. Call connect() first.")
        response = await self.client.post("/printer/print/cancel")
        response.raise_for_status()
        return response.json()

    async def _query_print_status(self, include_afc: bool = False) -> Dict[str, Any]:
        """Query printer objects for print status, progress, and temperatures."""
        if not self.client:
            raise RuntimeError("Client not connected. Call connect() first.")

        response = await self.client.get(
            "/printer/objects/query",
            params={
                "print_stats": "",
                "virtual_sdcard": "",
                "toolhead": "",
                "extruder": "",
                "extruder1": "",
                "extruder2": "",
                "extruder3": "",
                "heater_bed": "",
            },
        )
        response.raise_for_status()
        data = response.json().get("result", {}).get("status", {})

        print_stats = data.get("print_stats", {})
        virtual_sdcard = data.get("virtual_sdcard", {})
        heater_bed = data.get("heater_bed", {})

        # Active extruder from toolhead
        active_extruder_name = data.get("toolhead", {}).get("extruder", "extruder")

        # All 4 extruder temperatures
        extruders = []
        for name in ["extruder", "extruder1", "extruder2", "extruder3"]:
            ext = data.get(name, {})
            if ext:
                extruders.append({
                    "temp": ext.get("temperature", 0.0),
                    "target": ext.get("target", 0.0),
                    "active": name == active_extruder_name,
                })
            else:
                extruders.append({"temp": 0.0, "target": 0.0, "active": False})

        active_extruder = data.get(active_extruder_name, data.get("extruder", {}))

        afc_slots = []
        if include_afc:
            try:
                afc_slots = await self.query_afc_slots()
            except Exception:
                afc_slots = []

        return {
            "state": print_stats.get("state", "standby"),
            "progress": virtual_sdcard.get("progress", 0.0),
            "filename": print_stats.get("filename"),
            "duration": print_stats.get("print_duration", 0.0),
            "filament_used": print_stats.get("filament_used", 0.0),
            "nozzle_temp": active_extruder.get("temperature", 0.0),
            "nozzle_target": active_extruder.get("target", 0.0),
            "bed_temp": heater_bed.get("temperature", 0.0),
            "bed_target": heater_bed.get("target", 0.0),
            "extruders": extruders,
            "afc_slots": afc_slots,
        }

    async def query_afc_slots(self) -> list[dict[str, Any]]:
        """Discover AFC-related Moonraker objects and extract loaded color info."""
        if not self.client:
            raise RuntimeError("Client not connected. Call connect() first.")

        list_response = await self.client.get("/printer/objects/list")
        list_response.raise_for_status()
        objects = list_response.json().get("result", {}).get("objects", [])

        afc_objects = [name for name in objects if "afc" in str(name).lower()]
        if not afc_objects:
            return []

        query_params = {name: "" for name in afc_objects}
        query_response = await self.client.get("/printer/objects/query", params=query_params)
        query_response.raise_for_status()
        status = query_response.json().get("result", {}).get("status", {})

        slots: list[dict[str, Any]] = []
        seen: set[tuple[str, str, Optional[str], Optional[str], Optional[bool], Optional[bool]]] = set()

        def _walk(path: str, node: Any):
            if isinstance(node, dict):
                color = self._extract_hex_color(node)
                if color:
                    label = self._extract_slot_label(path, node)
                    loaded = self._extract_loaded_state(node)
                    tool_loaded = self._extract_tool_loaded_state(node)
                    material_type = self._extract_material_type(node)
                    manufacturer = self._extract_manufacturer(node)
                    key = (label, color, material_type, manufacturer, loaded, tool_loaded)
                    if key not in seen:
                        seen.add(key)
                        slots.append({
                            "label": label,
                            "color": color,
                            "loaded": loaded,
                            "tool_loaded": tool_loaded,
                            "material_type": material_type,
                            "manufacturer": manufacturer,
                        })

                for key, value in node.items():
                    next_path = f"{path}.{key}" if path else str(key)
                    _walk(next_path, value)

            elif isinstance(node, list):
                for idx, item in enumerate(node):
                    _walk(f"{path}[{idx}]", item)

        for object_name in afc_objects:
            _walk(object_name, status.get(object_name, {}))

        return slots[:12]

    @staticmethod
    def _extract_hex_color(node: dict[str, Any]) -> Optional[str]:
        color_keys = [
            "color",
            "colour",
            "color_hex",
            "colour_hex",
            "hex",
            "spool_color",
            "filament_color",
            "loaded_color",
        ]
        for key in color_keys:
            value = node.get(key)
            normalized = MoonrakerClient._normalize_hex(value)
            if normalized:
                return normalized
        return None

    @staticmethod
    def _normalize_hex(value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        candidate = value.strip()
        if not candidate:
            return None
        if not candidate.startswith("#"):
            candidate = f"#{candidate}"
        if re.fullmatch(r"#[0-9a-fA-F]{6}", candidate):
            return candidate.upper()
        return None

    @staticmethod
    def _extract_loaded_state(node: dict[str, Any]) -> Optional[bool]:
        bool_keys = ["loaded", "is_loaded", "filament_present", "has_filament", "load", "prep"]
        for key in bool_keys:
            value = node.get(key)
            if isinstance(value, bool):
                return value
        return None

    @staticmethod
    def _extract_tool_loaded_state(node: dict[str, Any]) -> Optional[bool]:
        bool_keys = ["tool_loaded", "loaded_to_tool", "loaded_to_nozzle", "nozzle_loaded"]
        for key in bool_keys:
            value = node.get(key)
            if isinstance(value, bool):
                return value
        return None

    @staticmethod
    def _extract_slot_label(path: str, node: dict[str, Any]) -> str:
        if isinstance(node.get("name"), str) and node.get("name").strip():
            return node.get("name").strip()
        if node.get("lane") is not None:
            return f"Lane {node.get('lane')}"
        if node.get("slot") is not None:
            return f"Slot {node.get('slot')}"
        if node.get("index") is not None:
            return f"Slot {node.get('index')}"
        tail = path.split(".")[-1] if path else "AFC"
        return str(tail)

    @staticmethod
    def _extract_material_type(node: dict[str, Any]) -> Optional[str]:
        material_keys = [
            "material",
            "material_type",
            "filament_material",
            "filament_type",
            "spool_material",
            "mat",
            "type",
        ]
        for key in material_keys:
            value = node.get(key)
            normalized = MoonrakerClient._normalize_material_type(value)
            if normalized:
                return normalized
        return None

    @staticmethod
    def _normalize_material_type(value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        candidate = value.strip().upper().replace(" ", "")
        if not candidate:
            return None
        aliases = {
            "PLA+": "PLA",
            "PLAPLUS": "PLA",
            "PET-G": "PETG",
            "ABS+": "ABS",
            "NYLON": "PA",
            "PA6": "PA",
            "PA12": "PA",
        }
        candidate = aliases.get(candidate, candidate)
        known = {"PLA", "PETG", "ABS", "ASA", "TPU", "PC", "PA", "PVA", "HIPS"}
        if candidate in known:
            return candidate
        return candidate if len(candidate) <= 12 and re.fullmatch(r"[A-Z0-9_+\-]+", candidate) else None

    @staticmethod
    def _extract_manufacturer(node: dict[str, Any]) -> Optional[str]:
        manufacturer_keys = [
            "manufacturer",
            "brand",
            "vendor",
            "vendor_name",
            "maker",
            "filament_brand",
            "material_brand",
            "spool_brand",
            "mfr",
            "supplier",
        ]
        for key in manufacturer_keys:
            value = node.get(key)
            if isinstance(value, str):
                cleaned = value.strip()
                if cleaned:
                    return cleaned

        # Generic fallback: any key that hints at manufacturer/brand/vendor
        for key, value in node.items():
            key_l = str(key).lower()
            if any(token in key_l for token in ("manufacturer", "brand", "vendor", "maker", "mfr", "supplier")):
                if isinstance(value, str) and value.strip():
                    return value.strip()
                if isinstance(value, list) and value and isinstance(value[0], str) and value[0].strip():
                    return value[0].strip()

        # Heuristic fallback from profile/name-like fields (e.g., "Bambu PLA Basic")
        for key in ("filament_name", "spool_name", "profile_name", "material_name", "name"):
            value = node.get(key)
            if not isinstance(value, str):
                continue
            guessed = MoonrakerClient._guess_manufacturer_from_name(value)
            if guessed:
                return guessed

        return None

    @staticmethod
    def _guess_manufacturer_from_name(name: str) -> Optional[str]:
        if not isinstance(name, str):
            return None
        text = name.strip()
        if not text:
            return None

        known = {
            "bambu": "Bambu",
            "sunlu": "Sunlu",
            "esun": "eSUN",
            "polymaker": "Polymaker",
            "prusament": "Prusament",
            "snapmaker": "Snapmaker",
        }
        lower = text.lower()
        for token, canonical in known.items():
            if token in lower:
                return canonical

        first = re.split(r"[\s_\-]+", text)[0].strip("()[]")
        if not first or len(first) < 3:
            return None
        if re.fullmatch(r"(?i)(pla|petg|abs|asa|tpu|pc|pa|pva)", first):
            return None
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9+._]*", first):
            return first
        return None

    async def query_print_status(self, include_afc: bool = False) -> Dict[str, Any]:
        """Query printer objects for print status, progress, and temperatures."""
        return await self._query_print_status(include_afc=include_afc)


# Global client instance
_moonraker_client: Optional[MoonrakerClient] = None


async def init_moonraker(pool=None):
    """Initialize Moonraker client. Checks DB first, then env var."""
    global _moonraker_client

    moonraker_url = None

    # Try DB first
    if pool:
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT moonraker_url FROM printer_settings WHERE id = 1"
                )
                if row and row["moonraker_url"]:
                    moonraker_url = row["moonraker_url"]
        except Exception:
            pass  # Table may not exist yet on first run

    # Fall back to env var
    if not moonraker_url:
        moonraker_url = os.getenv("MOONRAKER_URL")

    if not moonraker_url:
        return

    _moonraker_client = MoonrakerClient(moonraker_url)
    await _moonraker_client.connect()


async def close_moonraker():
    """Close Moonraker client."""
    global _moonraker_client

    if _moonraker_client:
        await _moonraker_client.close()


def get_moonraker() -> Optional[MoonrakerClient]:
    """Get Moonraker client (may be None if not configured)."""
    return _moonraker_client


async def set_moonraker_url(url: str):
    """Set or change the Moonraker URL at runtime."""
    global _moonraker_client

    if not url:
        if _moonraker_client:
            await _moonraker_client.close()
            _moonraker_client = None
        return

    if _moonraker_client:
        await _moonraker_client.reconnect(url)
    else:
        _moonraker_client = MoonrakerClient(url)
        await _moonraker_client.connect()
