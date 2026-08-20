"""KMR sites extract -> `sites.json` (docs/data-formats.md §3, PLAN.md §2.2, phase 5).

Reads the RAÄ *Kulturhistoriska lämningar* county GeoPackage (new Oct-2025
relational schema; we use the denormalized ``lämningar_län_<län>_{point,
linestring,polygon}`` layers, which join attributes and geometry in one place)
and writes the site-local overlay records the app renders as flat cartographic
markers with Fornsök popups.

Selection follows PLAN.md §2.2's type filter — fornborgar, gravfält, boplatser,
färdvägar, runristningar — by ``lamningstyp`` verbatim. There is deliberately no
per-record dating: KMR's structured dating is sparsely populated, so period
attribution is by *type* ("typisk datering"), disclosed in the methods panel,
never invented here.

GeoPackage reading is delegated to ``ogr2ogr`` (gdal-bin), spawned per layer
with a bbox filter; everything after that is plain GeoJSON + origin subtraction
(the app never sees EPSG:3006 numbers, contract §0). The county file (~146 MB)
is cached under ``data-cache/`` and downloaded on demand.
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.request
from datetime import date
from pathlib import Path

import click

from .sites import CACHE_DIR, SITES, SiteConfig, get_site

SITES_PATH = "sites.json"
SCHEMA_VERSION = 1

# RAÄ download root [phase-0 verified]: note the `lamningar_v1` path and the
# URL-encoded Swedish filename.
RAA_COUNTY_URL = (
    "https://pub.raa.se/nedladdning/datauttag/lamningar_v1/lan/"
    "l%C3%A4mningar_l%C3%A4n_uppsala.gpkg"
)
RAA_GPKG = "lamningar_lan_uppsala.gpkg"
LAYER_PREFIX = "lämningar_län_uppsala"

# PLAN.md §2.2 type filter, `lamningstyp` verbatim from Lämningstypslistan v5.0.
# Reminders from phase 0: there is no `Runsten` type (runstenar are
# `Runristning`) and no `Hålväg` type (hollow ways are `Färdväg` /
# `Färdvägssystem`).
SELECTED_TYPES = frozenset(
    {
        "Fornborg",
        "Gravfält",
        "Grav- och boplatsområde",
        "Boplats",
        "Boplatsområde",
        "Boplatslämning övrig",
        "Färdväg",
        "Färdvägssystem",
        "Runristning",
    }
)

# One record per lamningsnummer; when a site carries several geometry rows the
# most informative kind wins and same-kind rows merge into a Multi* geometry.
GEOMETRY_PREFERENCE = {"polygon": 0, "linestring": 1, "point": 2}
COORD_DECIMALS = 1  # 0.1 m — far below marker/outline legibility


class SitesError(RuntimeError):
    """The extract failed an invariant worth stopping for."""


def download_gpkg(force: bool = False) -> Path:
    """Fetch (or reuse) the county GeoPackage in data-cache/."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / RAA_GPKG
    if path.exists() and not force:
        return path
    print(f"downloading {RAA_COUNTY_URL} …")
    urllib.request.urlretrieve(RAA_COUNTY_URL, path)
    print(f"  {path.stat().st_size / 1e6:.0f} MB")
    return path


def read_layer_bbox(gpkg: Path, layer: str, bounds3006: tuple[float, float, float, float]) -> list[dict]:
    """One denormalized layer, bbox-filtered, as GeoJSON features (EPSG:3006).

    ``-spat`` keeps every feature whose geometry intersects the bbox; geometries
    are NOT clipped, which is what the overlay wants (a gravfält straddling the
    extent edge renders whole).
    """
    min_e, min_n, max_e, max_n = bounds3006
    cmd = [
        "ogr2ogr",
        "-f",
        "GeoJSON",
        "/vsistdout/",
        str(gpkg),
        layer,
        "-spat",
        str(min_e),
        str(min_n),
        str(max_e),
        str(max_n),
    ]
    result = subprocess.run(cmd, capture_output=True, check=False)
    if result.returncode != 0:
        raise SitesError(
            f"ogr2ogr failed on layer {layer!r}: {result.stderr.decode(errors='replace')[:400]}"
        )
    payload = json.loads(result.stdout.decode("utf-8"))
    return payload.get("features", [])


# --------------------------------------------------------------------------- #
# geometry helpers — plain coordinate walks, EPSG:3006 -> local (contract §0)
# --------------------------------------------------------------------------- #


def _to_local(e: float, n: float, cfg: SiteConfig) -> list[float]:
    return [
        round(e - cfg.center_e, COORD_DECIMALS),
        round(-(n - cfg.center_n), COORD_DECIMALS),
    ]


def _map_positions(coords, cfg: SiteConfig, depth: int):
    """Recursively convert a GeoJSON coordinate array to local [x, z] pairs."""
    if depth == 0:
        return _to_local(coords[0], coords[1], cfg)
    return [_map_positions(c, cfg, depth - 1) for c in coords]


_DEPTH = {"Point": 0, "LineString": 1, "Polygon": 2, "MultiPolygon": 3, "MultiLineString": 2, "MultiPoint": 1}


def geometry_to_local(geometry: dict, cfg: SiteConfig) -> dict:
    kind = geometry["type"]
    if kind not in _DEPTH:
        raise SitesError(f"unsupported geometry type {kind!r}")
    return {"type": kind, "coordinates": _map_positions(geometry["coordinates"], cfg, _DEPTH[kind])}


def _flatten_positions(geometry: dict) -> list[list[float]]:
    depth = _DEPTH[geometry["type"]]
    coords = geometry["coordinates"]
    if depth == 0:
        return [coords]
    out = coords
    for _ in range(depth - 1):
        out = [p for part in out for p in part]
    return out


def representative_point(geometry_local: dict) -> dict:
    """Marker anchor: ring/vertex centroid — good enough for a popup anchor."""
    points = _flatten_positions(geometry_local)
    if geometry_local["type"] in ("Polygon", "MultiPolygon"):
        # Use only exterior rings (first ring of each polygon).
        coords = geometry_local["coordinates"]
        rings = [coords[0]] if geometry_local["type"] == "Polygon" else [p[0] for p in coords]
        points = [p for ring in rings for p in ring]
    if not points:
        raise SitesError("geometry has no coordinates")
    x = sum(p[0] for p in points) / len(points)
    z = sum(p[1] for p in points) / len(points)
    return {"x": round(x, 2), "z": round(z, 2)}


def _merge_same_kind(geoms: list[dict]) -> dict:
    """Several same-kind geometry rows for one site -> one (Multi*) geometry."""
    if len(geoms) == 1:
        return geoms[0]
    kind = geoms[0]["type"]
    if kind == "Polygon":
        return {"type": "MultiPolygon", "coordinates": [g["coordinates"] for g in geoms]}
    if kind == "LineString":
        return {"type": "MultiLineString", "coordinates": [g["coordinates"] for g in geoms]}
    if kind == "Point":
        return {"type": "MultiPoint", "coordinates": [g["coordinates"] for g in geoms]}
    return geoms[0]


# --------------------------------------------------------------------------- #
# record assembly
# --------------------------------------------------------------------------- #


def build_records(features_by_kind: dict[str, list[dict]], cfg: SiteConfig) -> list[dict]:
    """Merge the three geometry layers into one record per lamningsnummer."""
    collected: dict[str, dict] = {}

    for kind in sorted(features_by_kind, key=lambda k: GEOMETRY_PREFERENCE[k]):
        for feature in features_by_kind[kind]:
            props = feature.get("properties") or {}
            if props.get("lamningstyp") not in SELECTED_TYPES:
                continue
            lamning_id = props.get("lamningsnummer")
            if not lamning_id:
                continue
            entry = collected.setdefault(
                lamning_id,
                {"props": props, "kind": kind, "geometries": []},
            )
            if entry["kind"] == kind:
                entry["geometries"].append(feature["geometry"])
            # A lower-preference kind for an already-seen site adds nothing:
            # the marker anchors on the best geometry we have.

    records: list[dict] = []
    for lamning_id, entry in collected.items():
        props = entry["props"]
        geometry = geometry_to_local(_merge_same_kind(entry["geometries"]), cfg)
        record: dict = {
            "id": lamning_id,
            "name": props.get("lamningsnamn") or lamning_id,
            "lamningstyp": props["lamningstyp"],
            "provenance": "measured",
            "position": representative_point(geometry),
        }
        # Points carry no geometryLocal — the position is the whole story.
        if geometry["type"] != "Point":
            record["geometryLocal"] = geometry
        if props.get("url"):
            record["fornsokUrl"] = props["url"]
        if props.get("beskrivning"):
            record["description"] = props["beskrivning"]
        records.append(record)

    records.sort(key=lambda r: r["id"])
    return records


def build_sites_file(records: list[dict], fetched: str) -> dict:
    doc = {"schemaVersion": SCHEMA_VERSION, "fetched": fetched, "sites": records}
    validate_sites(doc)
    return doc


def validate_sites(doc: dict) -> None:
    """Contract §3 invariants; raise SitesError with a field-naming message."""
    if doc.get("schemaVersion") != SCHEMA_VERSION:
        raise SitesError(f"schemaVersion must be {SCHEMA_VERSION}")
    seen: set[str] = set()
    for i, site in enumerate(doc.get("sites", [])):
        for key in ("id", "name", "lamningstyp", "provenance", "position"):
            if not site.get(key):
                raise SitesError(f"sites[{i}] is missing {key!r}")
        if site["id"] in seen:
            raise SitesError(f"duplicate site id {site['id']!r}")
        seen.add(site["id"])
        if site["provenance"] != "measured":
            raise SitesError(f"sites[{i}] ({site['id']}): KMR records are 'measured'")
        pos = site["position"]
        if not all(isinstance(pos.get(k), (int, float)) for k in ("x", "z")):
            raise SitesError(f"sites[{i}] ({site['id']}): position must be numeric x/z")


def write_sites(path: Path, doc: dict) -> Path:
    validate_sites(doc)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def run(site_id: str, force_download: bool = False) -> dict:
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — KMR sites extract (PLAN §2.2 type filter)")
    gpkg = download_gpkg(force=force_download)

    bounds = cfg.bounds3006(cfg.context.half_extent)
    features_by_kind = {
        kind: read_layer_bbox(gpkg, f"{LAYER_PREFIX}_{kind}", bounds)
        for kind in ("polygon", "linestring", "point")
    }
    for kind, feats in features_by_kind.items():
        kept = sum(1 for f in feats if (f.get("properties") or {}).get("lamningstyp") in SELECTED_TYPES)
        print(f"  {kind}: {len(feats)} in bbox, {kept} selected")

    records = build_records(features_by_kind, cfg)
    by_type: dict[str, int] = {}
    for r in records:
        by_type[r["lamningstyp"]] = by_type.get(r["lamningstyp"], 0) + 1
    for typ, n in sorted(by_type.items(), key=lambda x: -x[1]):
        print(f"  {typ}: {n}")

    fort = next((r for r in records if r["id"] == "L1943:7827"), None)
    if cfg.id == "broborg" and (fort is None or fort["lamningstyp"] != "Fornborg"):
        raise SitesError("Broborg's own record (L1943:7827, Fornborg) is missing from the extract")

    doc = build_sites_file(records, cfg.kmr_fetched or date.today().isoformat())
    path = write_sites(cfg.out_dir / SITES_PATH, doc)
    print(f"== wrote {path} ({path.stat().st_size / 1e3:.1f} kB, {len(records)} sites)")
    return doc


@click.command()
@click.option(
    "--site",
    "site_id",
    default="broborg",
    show_default=True,
    type=click.Choice(sorted(SITES)),
    help="Site whose sites.json to build.",
)
@click.option("--force-download", is_flag=True, help="Re-download the county GeoPackage.")
def cli(site_id: str, force_download: bool) -> None:
    """Extract nearby KMR sites into the site's sites.json overlay data."""
    try:
        run(site_id, force_download=force_download)
    except SitesError as exc:
        raise SystemExit(f"SITES EXTRACT FAILED: {exc}") from exc


if __name__ == "__main__":
    sys.exit(cli())
