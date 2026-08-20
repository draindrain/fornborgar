"""Assemble and validate `manifest.json` — the pipeline ↔ app contract.

Implements docs/data-formats.md §2 (FROZEN v1) exactly. Pure dict assembly plus a
validator for the invariants the contract says the pipeline guarantees; both run
in tests without touching the network or the filesystem.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from . import PIPELINE_NAME
from .clip_dem import DECIMETER_SCALE, Grid
from .sites import EPSG_HORIZONTAL, VERTICAL_DATUM, SiteConfig

SCHEMA_VERSION = 1
TOL = 1e-6

LANTMATERIET_ATTRIBUTION = {
    "text": "Höjddata: © Lantmäteriet, Markhöjdmodell Nedladdning (CC BY 4.0)",
    "license": "CC BY 4.0",
    "url": "https://www.lantmateriet.se",
}


def _raa_attribution(fetched: str) -> dict:
    return {
        "text": (
            "Fornlämningsinformation från Riksantikvarieämbetet, "
            f"Kulturmiljöregistret (CC0), hämtad {fetched}"
        ),
        "license": "CC0",
        "url": "https://pub.raa.se",
    }


def local_bounds(bounds3006: tuple[float, float, float, float], origin_e: float, origin_n: float):
    """EPSG:3006 bounds -> scene-local bounds (docs/data-formats.md §0).

    x = E - origin.e, z = -(N - origin.n), so **minZ corresponds to the north edge**.
    """
    min_e, min_n, max_e, max_n = bounds3006
    return {
        "minX": min_e - origin_e,
        "minZ": -(max_n - origin_n),
        "maxX": max_e - origin_e,
        "maxZ": -(min_n - origin_n),
    }


def grid_entry(grid: Grid, cfg: SiteConfig) -> dict:
    min_e, min_n, max_e, max_n = grid.bounds3006
    return {
        "path": grid.spec.path,
        "resolution": float(grid.spec.resolution),
        "width": grid.width,
        "height": grid.height,
        "bounds3006": {
            "minE": float(min_e),
            "minN": float(min_n),
            "maxE": float(max_e),
            "maxN": float(max_n),
        },
        "boundsLocal": local_bounds(grid.bounds3006, cfg.center_e, cfg.center_n),
        "encoding": {"dtype": "int16", "scale": DECIMETER_SCALE, "unit": "m"},
        "minElevation": grid.min_elevation,
        "maxElevation": grid.max_elevation,
    }


def build_manifest(
    cfg: SiteConfig,
    grids: dict[str, Grid],
    source_meta: dict,
    generated: str | None = None,
) -> dict:
    """Assemble the manifest dict for one site."""
    site: dict = {"id": cfg.id, "name": cfg.name}
    if cfg.raa:
        site["raa"] = dict(cfg.raa)

    filled = max((g.filled_cells for g in grids.values()), default=0)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "site": site,
        "crs": {
            "horizontal": f"EPSG:{EPSG_HORIZONTAL}",
            "verticalDatum": VERTICAL_DATUM,
        },
        "origin": {"e": float(cfg.center_e), "n": float(cfg.center_n)},
        "grids": {name: grid_entry(grid, cfg) for name, grid in grids.items()},
        "assets": {"sites": "sites.json"},
        "layers": [
            {"id": "terrain", "name": "Terrain (LiDAR DEM)", "provenance": "measured"},
            {"id": "sites", "name": "Registered sites (KMR)", "provenance": "measured"},
        ],
        "attribution": [LANTMATERIET_ATTRIBUTION, _raa_attribution(cfg.kmr_fetched)],
        "provenance": {
            "generated": generated
            or datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "pipeline": PIPELINE_NAME,
            "sources": [
                {
                    "id": "lantmateriet-dtm",
                    "product": source_meta.get(
                        "product", "Markhöjdmodell Nedladdning (dtm-cog)"
                    ),
                    "tiles": list(source_meta.get("stacItems", [])),
                    "fetched": source_meta.get("fetched", ""),
                }
            ],
            "processing": [
                "windowed /vsicurl read",
                f"nodata fill ({filled} cells)",
                "int16 dm quantization",
                "COG deflate",
            ],
        },
    }
    return manifest


# --------------------------------------------------------------------------- #
# validation — the invariants docs/data-formats.md §2 says the pipeline guarantees
# --------------------------------------------------------------------------- #


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= TOL


def validate_manifest(manifest: dict) -> None:
    """Raise ValueError on any contract violation."""
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"schemaVersion must be {SCHEMA_VERSION}")

    origin = manifest["origin"]
    oe, on = float(origin["e"]), float(origin["n"])

    grids = manifest["grids"]
    for required in ("core", "context"):
        if required not in grids:
            raise ValueError(f"manifest is missing the {required!r} grid")

    for name, grid in grids.items():
        res = float(grid["resolution"])
        b = grid["bounds3006"]
        expected_w = (b["maxE"] - b["minE"]) / res
        expected_h = (b["maxN"] - b["minN"]) / res
        if not _close(grid["width"], expected_w):
            raise ValueError(f"{name}: width {grid['width']} != (maxE-minE)/res {expected_w}")
        if not _close(grid["height"], expected_h):
            raise ValueError(f"{name}: height {grid['height']} != (maxN-minN)/res {expected_h}")

        expected_local = local_bounds((b["minE"], b["minN"], b["maxE"], b["maxN"]), oe, on)
        for key, value in expected_local.items():
            if not _close(float(grid["boundsLocal"][key]), value):
                raise ValueError(
                    f"{name}: boundsLocal.{key} = {grid['boundsLocal'][key]}, "
                    f"expected {value} from bounds3006 + origin"
                )

        enc = grid["encoding"]
        if enc["dtype"] != "int16" or not _close(float(enc["scale"]), DECIMETER_SCALE):
            raise ValueError(f"{name}: encoding must be int16 with scale {DECIMETER_SCALE}")

        lo, hi = float(grid["minElevation"]), float(grid["maxElevation"])
        if lo > hi:
            raise ValueError(f"{name}: minElevation {lo} > maxElevation {hi}")
        # Datum sanity: catches the +23..36 m EPSG:5845 geoid-shift bug.
        if lo < -10.0 or hi > 200.0:
            raise ValueError(
                f"{name}: elevation range {lo}..{hi} m is outside [-10, 200] for a Swedish "
                f"lowland site — suspect a vertical-datum shift (PLAN.md §2.1)"
            )

    core, context = grids["core"]["bounds3006"], grids["context"]["bounds3006"]
    if not (
        context["minE"] < core["minE"]
        and context["minN"] < core["minN"]
        and core["maxE"] < context["maxE"]
        and core["maxN"] < context["maxN"]
    ):
        raise ValueError("core extent must lie strictly inside the context extent")

    for layer in manifest["layers"]:
        if layer["provenance"] not in ("measured", "model", "conjecture"):
            raise ValueError(f"layer {layer['id']!r}: invalid provenance {layer['provenance']!r}")

    for entry in manifest["assets"].values():
        if entry.startswith("/") or ".." in entry:
            raise ValueError(f"asset path {entry!r} must be relative and contain no '..'")


def write_manifest(path: Path, manifest: dict) -> Path:
    validate_manifest(manifest)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


DATA_LICENSES_TEMPLATE = """# Data licenses — {site_name} (`{site_id}`)

Everything in this directory is generated by `pipeline/` (`{pipeline}`) from open
Swedish government data. Licenses per source, restating PLAN.md §6.3; the app
renders the short attribution strings from `manifest.json` → `attribution`.

## Elevation grids — `dem_core.tif`, `dem_context.tif`

- **Source:** Lantmäteriet, *Markhöjdmodell Nedladdning* (national 1 m ground DEM,
  TIN-interpolated from ground-classified LiDAR), collection `dtm-cog`, fetched via the
  Höjd STAC API (`https://api.lantmateriet.se/stac-hojd/v1`).
- **Source tiles:** {tiles}
- **Fetched:** {fetched}
- **License:** **CC BY 4.0** — attribution required.
- **Required attribution:** *"Höjddata: © Lantmäteriet, Markhöjdmodell Nedladdning (CC BY 4.0)"*
  (working wording; the exact mandated text lives in the terms accepted at ordering —
  PLAN.md open question §7.1).
- **Processing applied:** windowed `/vsicurl` read of the site extent, nodata fill,
  block-average downsample (context grid), quantization to int16 decimeters, DEFLATE COG.
  Heights are read as stored — **no vertical datum transform** (PLAN.md §2.1) — and are
  meters **RH 2000** in **SWEREF 99 TM (EPSG:3006)**.

## Site records — `sites.json`

- **Source:** Riksantikvarieämbetet, *Kulturmiljöregistret / Kulturhistoriska lämningar*
  (`https://pub.raa.se/nedladdning/datauttag/lamningar_v1/`).
- **License:** **CC0** — attribution not required, given voluntarily.
- **Voluntary attribution:** *"Fornlämningsinformation från Riksantikvarieämbetet,
  Kulturmiljöregistret (CC0), hämtad {kmr_fetched}"*.

## Later phases (added when the layers ship)

- Soils and shoreline displacement: Sveriges geologiska undersökning (SGU), **CC0** —
  *"Jordarts- och strandförskjutningsdata från Sveriges geologiska undersökning (CC0)"*.

## Application code

MIT — see `LICENSE` at the repository root. The code license does not extend to the data
files in this directory, which carry the licenses above.
"""


def write_data_licenses(path: Path, cfg: SiteConfig, source_meta: dict) -> Path:
    tiles = ", ".join(f"`{t}`" for t in source_meta.get("stacItems", [])) or "n/a"
    text = DATA_LICENSES_TEMPLATE.format(
        site_name=cfg.name,
        site_id=cfg.id,
        pipeline=PIPELINE_NAME,
        tiles=tiles,
        fetched=source_meta.get("fetched", "n/a"),
        kmr_fetched=cfg.kmr_fetched or "n/a",
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path
