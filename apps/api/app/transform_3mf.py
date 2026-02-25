"""Apply build-item transform deltas to 3MF files.

Initial M33 foundation: supports per-build-item XY translation and Z rotation.
Transforms are applied to `3D/3dmodel.model` build items before slicing.
"""

from __future__ import annotations

import math
import re
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Dict, List, Any, Tuple


IDENTITY_3MF = [1.0, 0.0, 0.0,
                0.0, 1.0, 0.0,
                0.0, 0.0, 1.0,
                0.0, 0.0, 0.0]


def _parse_3mf_transform(transform_str: str | None) -> List[float]:
    """Parse 3MF 3x4 affine transform into repo convention [3x3 | tx ty tz]."""
    if not transform_str:
        return list(IDENTITY_3MF)

    try:
        values = [float(x) for x in transform_str.split()]
    except ValueError:
        return list(IDENTITY_3MF)

    if len(values) == 12:
        return values

    # Some internal code paths normalize to 4x4; convert if seen.
    if len(values) == 16:
        return [
            values[0], values[1], values[2],
            values[4], values[5], values[6],
            values[8], values[9], values[10],
            values[12], values[13], values[14],
        ]

    return list(IDENTITY_3MF)


def _format_3mf_transform(values: List[float]) -> str:
    def fmt(v: float) -> str:
        if abs(v) < 1e-10:
            v = 0.0
        s = f"{v:.6f}".rstrip("0").rstrip(".")
        if not s:
            s = "0"
        if "e" not in s.lower() and "." not in s:
            s = f"{s}.0"
        return s

    return " ".join(fmt(v) for v in values[:12])


def _mat_parts(m: List[float]) -> Tuple[List[List[float]], List[float]]:
    linear = [
        [m[0], m[1], m[2]],
        [m[3], m[4], m[5]],
        [m[6], m[7], m[8]],
    ]
    t = [m[9], m[10], m[11]]
    return linear, t


def _compose_affine(a: List[float], b: List[float]) -> List[float]:
    """Return a∘b (apply b, then a) in 3MF 3x4 convention."""
    la, ta = _mat_parts(a)
    lb, tb = _mat_parts(b)

    lc = [[0.0, 0.0, 0.0] for _ in range(3)]
    for r in range(3):
        for c in range(3):
            lc[r][c] = sum(la[r][k] * lb[k][c] for k in range(3))

    tc = [
        sum(la[r][k] * tb[k] for k in range(3)) + ta[r]
        for r in range(3)
    ]

    return [
        lc[0][0], lc[0][1], lc[0][2],
        lc[1][0], lc[1][1], lc[1][2],
        lc[2][0], lc[2][1], lc[2][2],
        tc[0], tc[1], tc[2],
    ]


def _rotation_z_3mf(degrees: float) -> List[float]:
    rad = math.radians(degrees)
    c = math.cos(rad)
    s = math.sin(rad)
    return [
        c, -s, 0.0,
        s,  c, 0.0,
        0.0, 0.0, 1.0,
        0.0, 0.0, 0.0,
    ]


def apply_object_transforms_to_3mf(
    source_3mf: Path,
    output_3mf: Path,
    object_transforms: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Apply build-item transform deltas to a 3MF and write a new archive.

    Each transform item supports:
      - build_item_index (1-based, required)
      - object_id (optional sanity check)
      - translate_x_mm / translate_y_mm (optional deltas)
      - rotate_z_deg (optional delta rotation)
    """
    if not object_transforms:
        raise ValueError("object_transforms cannot be empty")

    normalized: Dict[int, Dict[str, Any]] = {}
    for item in object_transforms:
        if not isinstance(item, dict):
            raise ValueError("Each object transform must be an object")

        try:
            build_item_index = int(item.get("build_item_index"))
        except Exception as e:
            raise ValueError("Each object transform requires build_item_index") from e

        if build_item_index < 1:
            raise ValueError("build_item_index must be >= 1")
        if build_item_index in normalized:
            raise ValueError(f"Duplicate build_item_index in object_transforms: {build_item_index}")

        normalized[build_item_index] = {
            "object_id": str(item.get("object_id")) if item.get("object_id") is not None else None,
            "translate_x_mm": float(item.get("translate_x_mm") or 0.0),
            "translate_y_mm": float(item.get("translate_y_mm") or 0.0),
            "rotate_z_deg": float(item.get("rotate_z_deg") or 0.0),
        }

    ns = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}

    with zipfile.ZipFile(source_3mf, "r") as src_zf:
        raw_model_bytes = src_zf.read("3D/3dmodel.model")
        try:
            raw_model_xml = raw_model_bytes.decode("utf-8")
        except UnicodeDecodeError as e:
            raise ValueError("3D model XML is not valid UTF-8") from e

        root = ET.fromstring(raw_model_bytes)
        build = root.find("m:build", ns)
        if build is None:
            raise ValueError("3MF missing build section")

        items = build.findall("m:item", ns)
        applied: List[Dict[str, Any]] = []

        for idx, build_item in enumerate(items, start=1):
            tx_spec = normalized.get(idx)
            if not tx_spec:
                continue

            actual_object_id = build_item.get("objectid")
            expected_object_id = tx_spec.get("object_id")
            if expected_object_id and actual_object_id and expected_object_id != actual_object_id:
                raise ValueError(
                    f"build_item_index {idx} object_id mismatch "
                    f"(expected {expected_object_id}, got {actual_object_id})"
                )

            current = _parse_3mf_transform(build_item.get("transform"))
            rotate_z_deg = float(tx_spec["rotate_z_deg"])
            if abs(rotate_z_deg) > 1e-9:
                current = _compose_affine(current, _rotation_z_3mf(rotate_z_deg))
            current[9] += float(tx_spec["translate_x_mm"])
            current[10] += float(tx_spec["translate_y_mm"])

            new_transform_str = _format_3mf_transform(current)
            build_item.set("transform", new_transform_str)
            applied.append({
                "build_item_index": idx,
                "object_id": actual_object_id,
                "translate_x_mm": tx_spec["translate_x_mm"],
                "translate_y_mm": tx_spec["translate_y_mm"],
                "rotate_z_deg": tx_spec["rotate_z_deg"],
                "transform": new_transform_str,
            })

        missing = sorted(set(normalized.keys()) - {a["build_item_index"] for a in applied})
        if missing:
            raise ValueError(f"Invalid build_item_index values: {missing}")

        updated_model = _patch_build_item_transform_attributes(raw_model_xml, applied).encode("utf-8")

        updated_model_settings: bytes | None = None
        if "Metadata/model_settings.config" in src_zf.namelist():
            try:
                raw_ms_bytes = src_zf.read("Metadata/model_settings.config")
                raw_ms_xml = raw_ms_bytes.decode("utf-8")
                updated_model_settings = _patch_model_settings_assemble_transforms(raw_ms_xml, normalized, applied).encode("utf-8")
            except UnicodeDecodeError:
                # Leave original file unchanged if encoding is unexpected.
                updated_model_settings = None

        with zipfile.ZipFile(output_3mf, "w", zipfile.ZIP_DEFLATED) as dst_zf:
            for info in src_zf.infolist():
                if info.filename == "3D/3dmodel.model":
                    dst_zf.writestr(info.filename, updated_model)
                elif info.filename == "Metadata/model_settings.config" and updated_model_settings is not None:
                    dst_zf.writestr(info.filename, updated_model_settings)
                else:
                    # Write by filename+bytes to avoid carrying source ZipInfo fields
                    # that some tools are sensitive to after mutation/copy.
                    dst_zf.writestr(info.filename, src_zf.read(info.filename))

    return {
        "applied_count": len(applied),
        "applied": applied,
    }


def _patch_build_item_transform_attributes(model_xml: str, applied: List[Dict[str, Any]]) -> str:
    """Patch <build><item ...> transform attributes in-place, preserving XML text."""
    if not applied:
        return model_xml

    by_index = {
        int(item["build_item_index"]): str(item["transform"])
        for item in applied
    }

    # Only patch <item> tags inside the <build> section. 3MF object components also
    # use <item>, and counting them causes build_item_index mismatches.
    build_section_re = re.compile(
        r"(?P<open><(?:(?P<prefix>[A-Za-z_][\w.\-]*):)?build\b[^>]*>)"
        r"(?P<body>.*?)"
        r"(?P<close></(?:(?P=prefix):)?build\s*>)",
        re.DOTALL,
    )
    item_tag_re = re.compile(r"<(?:(?P<prefix>[A-Za-z_][\w.\-]*):)?item\b(?P<attrs>[^>]*)/?>")
    transform_attr_re = re.compile(r'(\stransform\s*=\s*)(["\'])(.*?)\2')

    build_match = build_section_re.search(model_xml)
    if not build_match:
        raise ValueError("3MF missing build section")

    build_item_counter = 0

    def item_repl(match: re.Match[str]) -> str:
        nonlocal build_item_counter
        build_item_counter += 1
        if build_item_counter not in by_index:
            return match.group(0)

        tag = match.group(0)
        new_transform = by_index[build_item_counter]
        if transform_attr_re.search(tag):
            return transform_attr_re.sub(
                lambda m: f'{m.group(1)}{m.group(2)}{new_transform}{m.group(2)}',
                tag,
                count=1,
            )

        # Insert before closing `/>` or `>`
        if tag.endswith("/>"):
            return tag[:-2] + f' transform="{new_transform}"/>'
        return tag[:-1] + f' transform="{new_transform}">'

    patched_build_body, count = item_tag_re.subn(item_repl, build_match.group("body"))
    if count < max(by_index.keys()):
        missing = sorted(idx for idx in by_index if idx > count)
        raise ValueError(f"Invalid build_item_index values: {missing}")

    return (
        model_xml[:build_match.start("body")]
        + patched_build_body
        + model_xml[build_match.end("body"):]
    )


def _patch_model_settings_assemble_transforms(
    model_settings_xml: str,
    normalized: Dict[int, Dict[str, Any]],
    applied: List[Dict[str, Any]] | None = None,
) -> str:
    """Patch Bambu model_settings.config <assemble_item transform=...> in-place.

    Snapmaker Orca v2.2.4 can prioritize assemble placement from model_settings.config
    over core 3MF build-item transforms for some Bambu-style exports. We apply the same
    per-build-item deltas to assemble_item transforms by position/order.
    """
    if not normalized:
        return model_settings_xml

    # Best effort validation: only patch if the XML parses.
    try:
        ET.fromstring(model_settings_xml.encode("utf-8"))
    except ET.ParseError:
        return model_settings_xml

    assemble_item_re = re.compile(r"<assemble_item\b(?P<attrs>[^>]*)/?>")
    transform_attr_re = re.compile(r'(\stransform\s*=\s*)(["\'])(.*?)\2')
    object_id_attr_re = re.compile(r'(\sobject_id\s*=\s*)(["\'])(.*?)\2')
    assemble_counter = 0
    spec_by_object_id: Dict[str, Dict[str, Any]] = {}
    if applied:
        duplicates: set[str] = set()
        for a in applied:
            oid = a.get("object_id")
            if oid is None:
                continue
            key = str(oid)
            if key in spec_by_object_id:
                duplicates.add(key)
            else:
                # Reuse normalized values keyed by build_item_index when available so field names are consistent.
                try:
                    idx = int(a.get("build_item_index"))
                except Exception:
                    idx = None
                spec = normalized.get(idx) if idx is not None else None
                if spec:
                    spec_by_object_id[key] = spec
        for d in duplicates:
            spec_by_object_id.pop(d, None)

    def repl(match: re.Match[str]) -> str:
        nonlocal assemble_counter
        assemble_counter += 1
        tag = match.group(0)
        obj_match = object_id_attr_re.search(tag)
        assemble_object_id = str(obj_match.group(3)) if obj_match else None
        spec = spec_by_object_id.get(assemble_object_id) if assemble_object_id else None
        if spec is None:
            spec = normalized.get(assemble_counter)
        if not spec:
            return tag
        m = transform_attr_re.search(tag)
        if not m:
            return tag

        current = _parse_3mf_transform(m.group(3))
        rotate_z_deg = float(spec.get("rotate_z_deg") or 0.0)
        if abs(rotate_z_deg) > 1e-9:
            current = _compose_affine(current, _rotation_z_3mf(rotate_z_deg))
        current[9] += float(spec.get("translate_x_mm") or 0.0)
        current[10] += float(spec.get("translate_y_mm") or 0.0)
        new_transform = _format_3mf_transform(current)

        return transform_attr_re.sub(
            lambda mm: f'{mm.group(1)}{mm.group(2)}{new_transform}{mm.group(2)}',
            tag,
            count=1,
        )

    return assemble_item_re.sub(repl, model_settings_xml)
