"""SGU *Jordarter 1:25 000–1:100 000* polygons for one site (PLAN.md §2.3).

The soil input of the phase-7 land-cover rule engine (docs/data-formats.md §9/§10).
Fetched from SGU's OGC API — Features, anonymous and CC0, cached verbatim under
`data-cache/` and reused on rerun exactly like the shoreline extract.

**What the live API actually does** (probed 2026-08-21, and it differs from the
brief this module was written to):

  * The soil *classification* attributes `jg2` (int code) / `jg2_tx` (text) live on
    the **`grundlager`** collection — the ground layer, 339 polygons over Broborg's
    4×4 km extent, carrying every class PLAN.md §2.3 lists. The `ytlager`
    collection is the thin (<0.5 m) *surface veneer* and carries a different pair,
    `jy1` / `jy1_tx`, with only two values here: `Morän` (50 polygons) and `Torv`
    (18). So both collections are fetched, and `soil_class()` reads whichever pair
    the feature carries. The peat veneer is worth the second request: it marks
    ground that maps as mineral soil but behaves as bog.
  * `crs=http://www.opengis.net/def/crs/EPSG/0/3006` **is** honoured and returns
    EPSG:3006 coordinates in **easting, northing** order — so no reprojection.
  * `bbox-crs` with the same URN is honoured too, but the bbox must then be given
    in the EPSG authority's **northing, easting** axis order (a lon/lat-ordered
    bbox silently matches nothing). `bbox_3006()` emits that order deliberately;
    the surprise is documented here rather than in a comment nobody reads.
  * Features that merely *intersect* the bbox come back whole and unclipped, so
    coordinates reach well outside the extent. The rasterizer clips them.
  * Geometries observed: `Polygon` only, but `MultiPolygon` is in the schema and
    the consumers handle both.

Public API: `fetch_soils(cfg, force_download=False) -> (features, meta)`.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np

from .fetch_dem import FetchError
from .sgu import PAGE_LIMIT, page_features
from .sites import CACHE_DIR, EPSG_HORIZONTAL, SITES, SiteConfig, get_site

JORD_API = "https://api.sgu.se/oppnadata/jordarter25k-100k/ogc/features/v1"
JORD_PRODUCT = "SGU Jordarter 1:25 000–1:100 000"

# The ground layer carries the classification the rules read; the surface layer
# carries the thin peat/till veneer on top of it. Order matters: it is the order
# the cache meta records and the order features are returned in.
GROUND_COLLECTION = "grundlager"
SURFACE_COLLECTION = "ytlager"
JORD_COLLECTIONS = (GROUND_COLLECTION, SURFACE_COLLECTION)

# OGC URN form the live API accepts for both `crs` and `bbox-crs`.
CRS_URN = f"http://www.opengis.net/def/crs/EPSG/0/{EPSG_HORIZONTAL}"

# Property names per collection (see the module docstring).
GROUND_CLASS_FIELD = "jg2_tx"
GROUND_CODE_FIELD = "jg2"
SURFACE_CLASS_FIELD = "jy1_tx"
SURFACE_CODE_FIELD = "jy1"


class SoilsError(RuntimeError):
    """The SGU soil extract is missing or unusable for this site."""


# --------------------------------------------------------------------------- #
# feature helpers — plain GeoJSON dicts, no shapely/geopandas (PLAN.md §4.8)
# --------------------------------------------------------------------------- #


def soil_class(feature: dict) -> str | None:
    """The feature's soil class text, from whichever collection it came from.

    `grundlager` names it `jg2_tx`, `ytlager` names it `jy1_tx`; a feature with
    neither is not a classified polygon and the caller drops it.
    """
    props = feature.get("properties") or {}
    value = props.get(GROUND_CLASS_FIELD) or props.get(SURFACE_CLASS_FIELD)
    return str(value) if value else None


def soil_code(feature: dict) -> int | None:
    """The feature's integer soil code (`jg2` / `jy1`), informational."""
    props = feature.get("properties") or {}
    value = props.get(GROUND_CODE_FIELD)
    if value is None:
        value = props.get(SURFACE_CODE_FIELD)
    return int(value) if value is not None else None


def is_surface_layer(feature: dict) -> bool:
    """True for a `ytlager` polygon — a thin veneer over the ground layer."""
    return SURFACE_CLASS_FIELD in (feature.get("properties") or {})


def class_census(features: list[dict]) -> dict[str, int]:
    """{soil class text -> polygon count}, for the run log and the cache report."""
    counts: dict[str, int] = {}
    for feature in features:
        name = soil_class(feature)
        if name:
            counts[name] = counts.get(name, 0) + 1
    return counts


# --------------------------------------------------------------------------- #
# fetch (network) — raw GeoJSON is cached verbatim under data-cache/
# --------------------------------------------------------------------------- #


def bbox_3006(bounds3006: tuple[float, float, float, float]) -> str:
    """The `bbox` value for a `bbox-crs=EPSG:3006` query — **northing, easting**.

    EPSG:3006's authority axis order is (N, E), and the API follows the authority
    rather than the lon/lat-ish order the URL form suggests. Passing (E, N) here
    returns an empty FeatureCollection with HTTP 200 — a silent nothing, which is
    why this conversion is a named function with a test rather than an f-string.
    """
    min_e, min_n, max_e, max_n = bounds3006
    return f"{min_n:.3f},{min_e:.3f},{max_n:.3f},{max_e:.3f}"


def fetch_collection(collection: str, bounds3006: tuple[float, float, float, float]) -> dict:
    """All features of one collection intersecting the extent, in EPSG:3006."""
    url = (
        f"{JORD_API}/collections/{collection}/items?f=json"
        f"&bbox={bbox_3006(bounds3006)}"
        f"&bbox-crs={CRS_URN}&crs={CRS_URN}&limit={PAGE_LIMIT}"
    )
    return page_features(url, collection)


def _cache_path(cfg: SiteConfig, collection: str) -> Path:
    return CACHE_DIR / f"{cfg.id}_jordarter_{collection}.geojson"


def _cache_meta_path(cfg: SiteConfig) -> Path:
    return CACHE_DIR / f"{cfg.id}_jordarter.json"


def fetch_soils(cfg: SiteConfig, force_download: bool = False) -> tuple[list[dict], dict]:
    """Fetch (or reuse) the SGU soil polygons covering the site's context extent.

    Returns (features, meta). The cache is keyed on the bbox and the collection
    set; a change to either invalidates it, as does a missing GeoJSON file.
    """
    bounds = cfg.bounds3006(cfg.context.half_extent)
    collections = list(JORD_COLLECTIONS)
    meta_path = _cache_meta_path(cfg)

    meta: dict | None = None
    if not force_download and meta_path.exists():
        try:
            cached = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cached = None
        if (
            cached
            and cached.get("collections") == collections
            and cached.get("bbox3006")
            and np.allclose(cached["bbox3006"], bounds, atol=1e-6)
            and all(_cache_path(cfg, c).exists() for c in collections)
        ):
            meta = cached
            print(f"cache hit: {meta_path} ({len(collections)} collections)")

    if meta is None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        for collection in collections:
            payload = fetch_collection(collection, bounds)
            _cache_path(cfg, collection).write_text(json.dumps(payload), encoding="utf-8")
            print(f"  {collection}: {len(payload['features'])} features")
        meta = {
            "api": JORD_API,
            "product": JORD_PRODUCT,
            "collections": collections,
            "bbox3006": list(bounds),
            "crs": f"EPSG:{EPSG_HORIZONTAL}",
            "fetched": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        }
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    features: list[dict] = []
    for collection in collections:
        payload = json.loads(_cache_path(cfg, collection).read_text(encoding="utf-8"))
        features.extend(payload.get("features", []))
    if not features:
        raise SoilsError(
            f"the SGU jordarter extract for {cfg.id!r} is empty — the API returned no polygon "
            f"for bbox {bounds}; re-run with --force-download and check the bbox axis order "
            f"(see fetch_soils.bbox_3006)"
        )
    return features, meta


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def run(site_id: str, force_download: bool = False) -> tuple[list[dict], dict]:
    """Fetch the site's soil polygons and report what came back."""
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — SGU jordarter extract (PLAN §2.3)")
    features, meta = fetch_soils(cfg, force_download=force_download)

    ground = [f for f in features if not is_surface_layer(f)]
    surface = [f for f in features if is_surface_layer(f)]
    print(
        f"-- {len(features)} polygons: {len(ground)} {GROUND_COLLECTION}, "
        f"{len(surface)} {SURFACE_COLLECTION} (fetched {meta['fetched']})"
    )
    for label, subset in ((GROUND_COLLECTION, ground), (SURFACE_COLLECTION, surface)):
        census = class_census(subset)
        for name, count in sorted(census.items(), key=lambda item: -item[1]):
            print(f"  {label:<12} {name:<32} {count:>4}")
    return features, meta


@click.command()
@click.option(
    "--site",
    "site_id",
    default="broborg",
    show_default=True,
    type=click.Choice(sorted(SITES)),
    help="Site whose soil extract to fetch.",
)
@click.option(
    "--force-download",
    is_flag=True,
    help="Re-fetch the SGU jordarter extract even if a valid cached copy exists.",
)
def cli(site_id: str, force_download: bool) -> None:
    """Fetch the SGU jordarter polygons for a site into data-cache/."""
    try:
        run(site_id, force_download=force_download)
    except FetchError as exc:
        raise SystemExit(f"FETCH FAILED: {exc}") from exc
    except SoilsError as exc:
        raise SystemExit(f"SOIL EXTRACT FAILED: {exc}") from exc


if __name__ == "__main__":
    sys.exit(cli())
