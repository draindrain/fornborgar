"""Assemble and validate `manifest.json` — the pipeline ↔ app contract.

Implements docs/data-formats.md §2 (FROZEN v1) exactly. Pure dict assembly plus a
validator for the invariants the contract says the pipeline guarantees; both run
in tests without touching the network or the filesystem.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from datetime import datetime, timezone
from pathlib import Path

from . import PIPELINE_NAME
from .clip_dem import ALLOWED_SCALES, DECIMETER_SCALE, Grid
from .sites import EPSG_HORIZONTAL, VERTICAL_DATUM, SiteConfig

SCHEMA_VERSION = 1
TOL = 1e-6

LANTMATERIET_ATTRIBUTION = {
    "text": "Höjddata: © Lantmäteriet, Markhöjdmodell Nedladdning (CC BY 4.0)",
    "license": "CC BY 4.0",
    "url": "https://www.lantmateriet.se",
}

# v1.2 (contract amendment): the single SGU credit line, widened from the v1.1
# shoreline-only wording now that soils ship too (PLAN.md §6.3). Both patchers
# write this one; `_ensure_sgu_attribution` guarantees there is exactly one SGU
# entry, so a manifest never credits the same agency twice.
SGU_ATTRIBUTION = {
    "text": "Jordarts- och strandförskjutningsdata från Sveriges geologiska undersökning (CC0)",
    "license": "CC0",
    "url": "https://www.sgu.se",
}
# The v1.1 wording. Manifests written before the widening carry it, and the
# contract still mandates it for a shoreline-only site, so the validator accepts
# either text — but the pipeline only ever writes the widened one.
SGU_SHORELINE_ATTRIBUTION = {
    "text": "Strandförskjutningsdata från Sveriges geologiska undersökning (CC0)",
    "license": "CC0",
    "url": "https://www.sgu.se",
}
SGU_ATTRIBUTION_TEXTS = (SGU_ATTRIBUTION["text"], SGU_SHORELINE_ATTRIBUTION["text"])

WATER_LAYER = {"id": "water", "name": "Paleo-shoreline (SGU model)", "provenance": "model"}

# v1.2 §9/§10: the rule engine's output is a model and the layer entry says so —
# `_validate_landcover` refuses any other provenance, for the same reason
# `_validate_palisade` refuses one on the palisade.
LANDCOVER_LAYER = {
    "id": "landcover",
    "name": "Modeled landscape (rule-based)",
    "provenance": "model",
}

# v1.1 §8: the crest *line* is measured, the palisade drawn on it is not. PLAN §6.1
# makes the provenance tag load-bearing, so `validate_manifest` refuses any other
# value for this layer — see `_validate_palisade`.
PALISADE_LAYER = {"id": "palisade", "name": "Palisade (conjectural)", "provenance": "conjecture"}


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
        "encoding": {"dtype": "int16", "scale": grid.spec.quant_scale, "unit": "m"},
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


def _ensure_sgu_attribution(manifest: dict) -> None:
    """Exactly one SGU credit entry, carrying the widened v1.2 text.

    Both SGU products are CC0 and the contract wants one entry for the agency, so
    an already-present v1.1 shoreline-only entry is *replaced* in place (keeping
    its position in the footer order) rather than joined by a second one.
    """
    attribution = manifest.setdefault("attribution", [])
    existing = [
        i for i, entry in enumerate(attribution) if entry.get("text") in SGU_ATTRIBUTION_TEXTS
    ]
    if not existing:
        attribution.append(dict(SGU_ATTRIBUTION))
        return
    attribution[existing[0]] = dict(SGU_ATTRIBUTION)
    for index in reversed(existing[1:]):
        del attribution[index]


def _merge_provenance(manifest: dict, source: dict | None, processing: Iterable[str]) -> None:
    """Add/replace one provenance source by id and append new processing steps."""
    provenance = manifest.setdefault("provenance", {})
    if source is not None:
        sources = provenance.setdefault("sources", [])
        sources = [s for s in sources if s.get("id") != source.get("id")]
        sources.append(dict(source))
        provenance["sources"] = sources
    steps = provenance.setdefault("processing", [])
    for entry in processing:
        if entry not in steps:
            steps.append(entry)


def _insert_layer(layers: list[dict], layer: dict, before: tuple[str, ...]) -> None:
    """Insert `layer` once, ahead of the first layer id in `before`."""
    if any(existing.get("id") == layer["id"] for existing in layers):
        return
    insert_at = next(
        (i for i, existing in enumerate(layers) if existing.get("id") in before), len(layers)
    )
    layers.insert(insert_at, dict(layer))


def add_water_assets(
    manifest: dict,
    shoreline_path: str,
    connect_path: str,
    source: dict | None = None,
    processing: Iterable[str] = (),
) -> dict:
    """Patch the v1.1 water pair into an existing manifest, in place. Idempotent.

    Additive per the contract's versioning policy — `schemaVersion` stays 1. The
    shoreline asset, the SGU attribution entry and the `water` layer travel
    together (see `validate_manifest`).
    """
    manifest.setdefault("assets", {})["shoreline"] = shoreline_path
    manifest["assets"]["waterConnect"] = connect_path

    # Contract order: terrain, sites, water, landcover, palisade.
    _insert_layer(manifest.setdefault("layers", []), WATER_LAYER, ("landcover", "palisade"))
    _ensure_sgu_attribution(manifest)
    _merge_provenance(manifest, source, processing)
    return manifest


def add_landcover_asset(
    manifest: dict,
    landcover_path: str,
    legend_path: str,
    source: dict | None = None,
    processing: Iterable[str] = (),
) -> dict:
    """Patch the v1.2 §9/§10 land-cover pair into an existing manifest. Idempotent.

    Additive per the contract's versioning policy — `schemaVersion` stays 1. The
    raster, the legend, the `landcover` (model) layer and the SGU attribution
    travel together (see `validate_manifest`); the attribution is the widened v1.2
    wording, which replaces the shoreline-only one if the water step wrote it.
    """
    manifest.setdefault("assets", {})["landcover"] = landcover_path
    manifest["assets"]["landcoverLegend"] = legend_path

    # Contract order: terrain, sites, water, landcover, palisade.
    _insert_layer(manifest.setdefault("layers", []), LANDCOVER_LAYER, ("palisade",))
    _ensure_sgu_attribution(manifest)
    _merge_provenance(manifest, source, processing)
    return manifest


def add_rings(
    manifest: dict,
    ring_grids: list[Grid],
    cfg: SiteConfig,
    horizon: dict,
    processing: Iterable[str] = (),
) -> dict:
    """Patch the v1.4 §11 far-field rings into an existing manifest, in place.

    Additive per the contract's versioning policy — `schemaVersion` stays 1. The
    entries land ordered inside-out under `grids.rings`, plus the informational
    `horizon` block. No new attribution: rings are the same Lantmäteriet DEM,
    already credited.
    """
    manifest["grids"]["rings"] = [grid_entry(grid, cfg) for grid in ring_grids]
    manifest["horizon"] = dict(horizon)
    # A rebuild replaces the ring seam lines rather than accumulating them — a
    # stale "sea-filled" count from an earlier run must not survive a re-run
    # that fetched full coverage.
    steps = manifest.get("provenance", {}).get("processing")
    if steps:
        manifest["provenance"]["processing"] = [
            s
            for s in steps
            if not s.startswith("far-field rings:")
            and "cells outside tile coverage sea-filled" not in s
        ]
    _merge_provenance(manifest, None, processing)
    return manifest


def set_ring_water_connect(manifest: dict, ring_path: str, connect_path: str) -> dict:
    """Reference a §11 far-water connect grid from the ring entry with `ring_path`."""
    rings = manifest.get("grids", {}).get("rings", [])
    entry = next((ring for ring in rings if ring.get("path") == ring_path), None)
    if entry is None:
        raise ValueError(
            f"no ring entry with path {ring_path!r} — add_rings must run before the "
            f"far-water step"
        )
    entry["waterConnect"] = connect_path
    return manifest


def add_rampart_asset(
    manifest: dict,
    rampart_path: str,
    processing: Iterable[str] = (),
) -> dict:
    """Patch the v1.1 §8 rampart asset into an existing manifest, in place. Idempotent.

    Additive per the contract's versioning policy — `schemaVersion` stays 1. No new
    attribution: the crest is derived from the Lantmäteriet DEM and the RAÄ extent
    polygon, both already credited. The asset and the conjectural `palisade` layer
    travel together (see `validate_manifest`).
    """
    manifest.setdefault("assets", {})["rampart"] = rampart_path

    layers = manifest.setdefault("layers", [])
    if not any(layer.get("id") == PALISADE_LAYER["id"] for layer in layers):
        # Contract order: terrain, sites, water, palisade — palisade goes last.
        layers.append(dict(PALISADE_LAYER))

    steps = manifest.setdefault("provenance", {}).setdefault("processing", [])
    for entry in processing:
        if entry not in steps:
            steps.append(entry)
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
        if name == "rings":
            continue  # validated below (v1.4 §11 — a list, not a grid entry)
        _validate_grid_entry(name, grid, oe, on, allowed_scales=(DECIMETER_SCALE,))

    core, context = grids["core"]["bounds3006"], grids["context"]["bounds3006"]
    if not _strictly_inside(core, context):
        raise ValueError("core extent must lie strictly inside the context extent")

    _validate_rings(manifest, grids, oe, on)

    for layer in manifest["layers"]:
        if layer["provenance"] not in ("measured", "model", "conjecture"):
            raise ValueError(f"layer {layer['id']!r}: invalid provenance {layer['provenance']!r}")

    assets = manifest["assets"]
    for entry in assets.values():
        if entry.startswith("/") or ".." in entry:
            raise ValueError(f"asset path {entry!r} must be relative and contain no '..'")

    _validate_water(manifest, assets)
    _validate_landcover(manifest, assets)
    _validate_palisade(manifest, assets)


def _validate_grid_entry(
    name: str, grid: dict, oe: float, on: float, allowed_scales: tuple[float, ...]
) -> None:
    """The §2 per-grid invariants, shared by core/context and the §11 rings."""
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
    if enc["dtype"] != "int16" or not any(
        _close(float(enc["scale"]), scale) for scale in allowed_scales
    ):
        raise ValueError(
            f"{name}: encoding must be int16 with scale in {allowed_scales}, "
            f"got {enc.get('dtype')!r} scale {enc.get('scale')!r}"
        )

    lo, hi = float(grid["minElevation"]), float(grid["maxElevation"])
    if lo > hi:
        raise ValueError(f"{name}: minElevation {lo} > maxElevation {hi}")
    # Datum sanity: catches the +23..36 m EPSG:5845 geoid-shift bug.
    if lo < -10.0 or hi > 200.0:
        raise ValueError(
            f"{name}: elevation range {lo}..{hi} m is outside [-10, 200] for a Swedish "
            f"lowland site — suspect a vertical-datum shift (PLAN.md §2.1)"
        )


def _strictly_inside(inner: dict, outer: dict) -> bool:
    return (
        outer["minE"] < inner["minE"]
        and outer["minN"] < inner["minN"]
        and inner["maxE"] < outer["maxE"]
        and inner["maxN"] < outer["maxN"]
    )


def _validate_rings(manifest: dict, grids: dict, oe: float, on: float) -> None:
    """v1.4 §11 rules: per-ring §2 invariants, the containment chain, one far-water grid."""
    rings = grids.get("rings")
    if rings is None:
        return
    if not isinstance(rings, list) or not rings:
        raise ValueError("grids.rings must be a non-empty array when present (contract §11)")

    water_connects = 0
    previous_name, previous = "context", grids["context"]
    for index, ring in enumerate(rings):
        name = f"rings[{index}]"
        _validate_grid_entry(name, ring, oe, on, allowed_scales=ALLOWED_SCALES)
        if not _strictly_inside(previous["bounds3006"], ring["bounds3006"]):
            raise ValueError(
                f"{name}: rings must be ordered inside-out — {previous_name} extent must lie "
                f"strictly inside it (contract §11 containment chain)"
            )
        if float(ring["resolution"]) <= float(previous["resolution"]):
            raise ValueError(
                f"{name}: resolution {ring['resolution']} must be coarser than "
                f"{previous_name}'s {previous['resolution']} (contract §11)"
            )
        connect = ring.get("waterConnect")
        if connect is not None:
            if not isinstance(connect, str) or connect.startswith("/") or ".." in connect:
                raise ValueError(
                    f"{name}: waterConnect path {connect!r} must be relative with no '..'"
                )
            if "shoreline" not in manifest.get("assets", {}):
                raise ValueError(
                    f"{name}: waterConnect requires the §6/§7 water pair to be present "
                    f"(contract §11 — far water renders the same shoreline table)"
                )
            water_connects += 1
        previous_name, previous = name, ring
    if water_connects > 1:
        raise ValueError("at most one ring entry may carry waterConnect (contract §11)")

    horizon = manifest.get("horizon")
    if horizon is not None:
        for key in ("crownM", "floorM", "eyeM", "distanceKm"):
            if not isinstance(horizon.get(key), (int, float)):
                raise ValueError(f"horizon.{key} must be a number (contract §11)")


def _has_sgu_attribution(manifest: dict) -> bool:
    """True if the manifest credits SGU, in either the v1.1 or the v1.2 wording."""
    return any(
        entry.get("text") in SGU_ATTRIBUTION_TEXTS for entry in manifest.get("attribution", [])
    )


def _validate_water(manifest: dict, assets: dict) -> None:
    """v1.1 §6/§7 rules: the water assets, layer and attribution travel together."""
    has_shoreline = "shoreline" in assets
    has_connect = "waterConnect" in assets
    if has_shoreline != has_connect:
        raise ValueError(
            "assets.shoreline and assets.waterConnect are a pair (contract v1.1 preamble): "
            f"shoreline={assets.get('shoreline')!r}, waterConnect={assets.get('waterConnect')!r}"
        )

    water = next((layer for layer in manifest["layers"] if layer.get("id") == "water"), None)
    if water is not None and water.get("provenance") != "model":
        raise ValueError(
            f"the 'water' layer is derived from the SGU model; provenance must be 'model', "
            f"got {water.get('provenance')!r}"
        )

    has_sgu = _has_sgu_attribution(manifest)
    if has_shoreline and not has_sgu:
        raise ValueError(
            "assets.shoreline is present but the SGU attribution entry is missing from "
            f"`attribution` (contract v1.1/v1.2 requires one of {SGU_ATTRIBUTION_TEXTS!r})"
        )
    if has_sgu and not has_shoreline and "landcover" not in assets:
        raise ValueError(
            "the SGU attribution is present but neither assets.shoreline nor assets.landcover "
            "is — the app would credit a source it never loads"
        )


def _validate_landcover(manifest: dict, assets: dict) -> None:
    """v1.2 §9/§10 rules: the raster, the legend, the layer and the credit travel together."""
    has_raster = "landcover" in assets
    has_legend = "landcoverLegend" in assets
    if has_raster != has_legend:
        raise ValueError(
            "assets.landcover and assets.landcoverLegend are a pair (contract v1.2 preamble): "
            f"landcover={assets.get('landcover')!r}, "
            f"landcoverLegend={assets.get('landcoverLegend')!r}"
        )

    layer = next(
        (entry for entry in manifest["layers"] if entry.get("id") == LANDCOVER_LAYER["id"]), None
    )
    if layer is not None and layer.get("provenance") != LANDCOVER_LAYER["provenance"]:
        raise ValueError(
            f"the 'landcover' layer is a rule-based reconstruction; provenance must be "
            f"{LANDCOVER_LAYER['provenance']!r}, got {layer.get('provenance')!r} (PLAN.md §6.1)"
        )
    if has_raster and layer is None:
        raise ValueError(
            "assets.landcover is present but there is no 'landcover' layer entry — the app "
            "would draw a modelled layer with no provenance label (contract §9, PLAN.md §6.1)"
        )
    if has_raster and not _has_sgu_attribution(manifest):
        raise ValueError(
            "assets.landcover is present but the SGU attribution entry is missing from "
            f"`attribution` (contract v1.2 requires {SGU_ATTRIBUTION['text']!r})"
        )


def _validate_palisade(manifest: dict, assets: dict) -> None:
    """v1.1 §8 + PLAN §6.1: the palisade layer is conjecture, and says so.

    The honesty rule is the whole point of the layer entry, so a wrong provenance is
    a hard failure rather than a warning: a manifest that shipped
    `{"id": "palisade", "provenance": "measured"}` would have the app label a
    reconstruction as evidence.
    """
    palisade = next((layer for layer in manifest["layers"] if layer.get("id") == "palisade"), None)
    if palisade is not None and palisade.get("provenance") != PALISADE_LAYER["provenance"]:
        raise ValueError(
            "the 'palisade' layer is a conjectural reconstruction; provenance must be "
            f"{PALISADE_LAYER['provenance']!r}, got {palisade.get('provenance')!r} (PLAN.md §6.1)"
        )
    if "rampart" in assets and palisade is None:
        raise ValueError(
            "assets.rampart is present but there is no 'palisade' layer entry — the app "
            "would draw a conjectural layer with no provenance label (contract §8, PLAN.md §6.1)"
        )


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

{water_section}{soils_section}## Later phases (added when the layers ship)

- {later_sgu}

## Application code

MIT — see `LICENSE` at the repository root. The code license does not extend to the data
files in this directory, which carry the licenses above.
"""

LATER_SGU_PENDING = (
    "Soils and shoreline displacement: Sveriges geologiska undersökning (SGU), **CC0** —\n"
    '  *"Jordarts- och strandförskjutningsdata från Sveriges geologiska undersökning (CC0)"*.'
)
LATER_SGU_SHIPPED = (
    "Soils (jordarter, phase 7): Sveriges geologiska undersökning (SGU), **CC0** — when it\n"
    "  ships, the SGU attribution line above widens to *\"Jordarts- och\n"
    "  strandförskjutningsdata från Sveriges geologiska undersökning (CC0)\"* (PLAN.md §6.3)."
)
LATER_SGU_COMPLETE = (
    "Both SGU products (jordarter and strandförskjutning) now ship, so the app's single SGU\n"
    "  credit line reads *\"Jordarts- och strandförskjutningsdata från Sveriges geologiska\n"
    "  undersökning (CC0)\"* (PLAN.md §6.3). Nothing SGU-related is outstanding."
)

WATER_SECTION_TEMPLATE = """## Paleo-shoreline — `shoreline.json`, `water_connect.tif`

- **Source:** Sveriges geologiska undersökning, *Strandförskjutningsmodell* (sea/land
  distribution in 100-year steps, built from the Påsse & Daniels (2015) shore-level
  equations, a land-uplift model and a 50 m DEM).
- **Endpoint:** OGC API — Features, `{api}`
- **Collections read:** {collections}
- **Fetched:** {fetched}
- **License:** **CC0** — attribution not required, given voluntarily.
- **Voluntary attribution:** *"Strandförskjutningsdata från Sveriges geologiska undersökning (CC0)"*.
- **Caveat (shown in the app):** dating margins up to **±500 years**; SGU calls it a
  general progression, not a basis for detailed studies.
- **Processing applied:** none of SGU's geometry is shipped. `shoreline.json` holds one
  water level per century, derived by sampling our own LiDAR DEM along SGU's modelled sea
  (Hav) boundaries inside the site extent and taking the median (see the `method` field in
  that file for the full derivation, including which steps are extrapolated).
  `water_connect.tif` is derived from `dem_context.tif` alone — a priority-flood
  sea-connectivity surface (the level at which each cell first connects to open water at
  the grid edge), so the app can exclude enclosed basins that never met the sea. It
  carries no SGU data and inherits the Lantmäteriet elevation license above.

"""


SOILS_SECTION_TEMPLATE = """## Modeled landscape — `landcover.tif`, `landcover_legend.json`

- **Source:** Sveriges geologiska undersökning, *Jordarter 1:25 000–1:100 000* (Quaternary
  deposit polygons; the `grundlager` ground layer carries the classification `jg2`/`jg2_tx`,
  the `ytlager` surface layer the thin peat/till veneer `jy1`/`jy1_tx`).
- **Endpoint:** OGC API — Features, `{api}`
- **Collections read:** {collections}
- **Fetched:** {fetched}
- **License:** **CC0** — attribution not required, given voluntarily.
- **Voluntary attribution:** *"Jordarts- och strandförskjutningsdata från Sveriges geologiska
  undersökning (CC0)"*.
- **Caveat (shown in the app):** SGU maps the **present-day** soil surface. Using it as a
  proxy for the ground of {reference_year} CE is a modelling assumption; the classification
  is a rule engine's output, not evidence for the vegetation at any single point.
- **Processing applied:** none of SGU's geometry is shipped. The polygons are rasterized
  onto the site's context grid and combined with slope from our own LiDAR DEM, the modelled
  shoreline level for {reference_year} CE and distance to registered grave/settlement sites
  to produce `landcover.tif`, a uint8 class-index raster. Every rule, the palette and the
  measured area fractions are disclosed verbatim in `landcover_legend.json`, which is what
  the app's methods panel renders.

"""


def water_section(water_meta: dict | None) -> str:
    if not water_meta:
        return ""
    collections = ", ".join(f"`{c}`" for c in water_meta.get("collections", [])) or "n/a"
    return WATER_SECTION_TEMPLATE.format(
        api=water_meta.get("api", "n/a"),
        collections=collections,
        fetched=water_meta.get("fetched", "n/a"),
    )


def soils_section(soils_meta: dict | None) -> str:
    if not soils_meta:
        return ""
    collections = ", ".join(f"`{c}`" for c in soils_meta.get("collections", [])) or "n/a"
    return SOILS_SECTION_TEMPLATE.format(
        api=soils_meta.get("api", "n/a"),
        collections=collections,
        fetched=soils_meta.get("fetched", "n/a"),
        reference_year=soils_meta.get("referenceYearCE", "n/a"),
    )


def write_data_licenses(
    path: Path,
    cfg: SiteConfig,
    source_meta: dict,
    water_meta: dict | None = None,
    soils_meta: dict | None = None,
) -> Path:
    """Regenerate DATA-LICENSES.md from whatever this site currently ships.

    The file is rewritten whole every time, so a caller that only just derived the
    soils must pass `water_meta` too or the shoreline section would silently
    vanish — `landcover.patch_manifest` reconstructs it from the manifest's own
    provenance sources, exactly as `water.patch_manifest` does for the DEM.
    """
    tiles = ", ".join(f"`{t}`" for t in source_meta.get("stacItems", [])) or "n/a"
    if soils_meta:
        later_sgu = LATER_SGU_COMPLETE
    elif water_meta:
        later_sgu = LATER_SGU_SHIPPED
    else:
        later_sgu = LATER_SGU_PENDING
    text = DATA_LICENSES_TEMPLATE.format(
        site_name=cfg.name,
        site_id=cfg.id,
        pipeline=PIPELINE_NAME,
        tiles=tiles,
        fetched=source_meta.get("fetched", "n/a"),
        kmr_fetched=cfg.kmr_fetched or "n/a",
        water_section=water_section(water_meta),
        soils_section=soils_section(soils_meta),
        later_sgu=later_sgu,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path
