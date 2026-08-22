"""KMR sites extract -> `sites.json` (docs/data-formats.md §3, PLAN.md §2.2, phase 5).

Reads the RAÄ *Kulturhistoriska lämningar* county GeoPackage (new Oct-2025
relational schema; we use the denormalized ``lämningar_län_<län>_{point,
linestring,polygon}`` layers, which join attributes and geometry in one place)
and writes the site-local overlay records the app renders as flat cartographic
markers with Fornsök popups.

Selection follows PLAN.md §2.2's type filter, by ``lamningstyp`` verbatim: the
fort types themselves, graves of every registered form (from gravfält down to the
single stensättning, hög or röse), settlement remains, mapped field remains
(fossil åker, röjningsrösen, terrasseringar), enclosure remains, färdvägar and
runristningar. Historic-era types (Lägenhetsbebyggelse, "Husgrund, historisk
tid", Bytomt/gårdstomt) stay out: wrong era for a 500 CE model. There is
deliberately no per-record dating: KMR's structured dating is sparsely populated,
so period attribution is by *type* ("typisk datering"), disclosed in the methods
panel, never invented here — and the cultivation types span the Bronze Age to the
medieval period, which the panel says rather than pretending they are Iron Age.

Two ways in, same GeoJSON afterwards. The **national** extract
(``lämningar_sverige.gpkg``, the file the registry is built from) is read
directly through ``fornborg_pipeline.gpkg`` — stdlib sqlite3 plus the
GeoPackage's own R*Tree index, so a 4x4 km window over 2.3 GB is a millisecond
query. That is the path every registry site takes, and it needs no GDAL binary.
The original **county** path shells out to ``ogr2ogr`` (gdal-bin) and is kept for
the hand-configured Uppsala sites. Everything after either reader is plain
GeoJSON + origin subtraction (the app never sees EPSG:3006 numbers, contract §0).
Both files are cached under ``data-cache/`` and downloaded on demand.
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.request
from datetime import date
from pathlib import Path

import click

from .gpkg import list_layers, read_features_bbox, table_columns
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
#
# The single-grave, field-remain and enclosure types were added after a survey of
# 195 fornborgar across four kommuner in three counties measured how much evidence
# the original nine-type filter was leaving on the table: 99 % of forts have at
# least one of them inside their 4x4 km extent (Stensättning 98 %, Röse 78 %,
# Hög 59 %, Fossil åker 58 %, Skärvstenshög 43 %, Röjningsröse 39 %, Hägnad 38 %,
# Terrassering 36 %). Every spelling here was verified against live kommun
# GeoPackages, not transcribed from the type list.
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
        # graves, single and grouped
        "Hög",
        "Stensättning",
        "Röse",
        "Gravgrupp",
        "Flatmarksgrav",
        "Grav markerad av sten/block",
        "Stenkammargrav",
        "Skärvstenshög",
        # settlement remains
        "Husgrund, förhistorisk/medeltida",
        "Boplatsvall",
        # land organization and cultivation
        "Hägnad",
        "Hägnadssystem",
        "Fossil åker",
        "Område med fossil åkermark",
        "Röjningsröse",
        "Röjningsröseområde",
        "Terrassering",
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


# KMR attribute columns the overlay needs, with the spellings seen across
# releases. Resolved case-insensitively against the layer's actual schema.
NATIONAL_COLUMNS = {
    "lamningsnummer": ("lamningsnummer", "lamningnummer"),
    "lamningsnamn": ("lamningsnamn", "namn"),
    "lamningstyp": ("lamningstyp",),
    "beskrivning": ("beskrivning",),
    "url": ("url", "fornsok_url", "lank"),
    "uuid": ("uuid", "lamning_uuid"),
}


def national_gpkg_path() -> Path:
    """The riket extract the registry caches, when it is there."""
    from .registry import gpkg_path

    return gpkg_path()


def national_layers(gpkg: Path) -> dict[str, str]:
    """{"polygon": <table>, "linestring": …} for the riket file's feature layers."""
    tables = [name for name, kind in list_layers(gpkg) if kind == "features"]
    found = {}
    for suffix in ("polygon", "linestring", "point"):
        matches = sorted(name for name in tables if name.lower().endswith(suffix))
        if matches:
            found[suffix] = matches[0]
    return found


def _resolve(gpkg: Path, table: str) -> dict[str, str]:
    present = {name.lower(): name for name in table_columns(gpkg, table)}
    resolved = {}
    for canonical, candidates in NATIONAL_COLUMNS.items():
        for candidate in candidates:
            if candidate in present:
                resolved[canonical] = present[candidate]
                break
    if "lamningstyp" not in resolved or "lamningsnummer" not in resolved:
        raise SitesError(
            f"{table} lacks lamningstyp/lamningsnummer; columns are {sorted(present)}"
        )
    return resolved


def read_layer_bbox_national(
    gpkg: Path, layer: str, bounds3006: tuple[float, float, float, float]
) -> list[dict]:
    """One riket layer, bbox-filtered, as GeoJSON features — the ogr2ogr-free path.

    Returns the same feature shape `read_layer_bbox` does, so `build_records`
    below cannot tell which reader produced it. Type filtering happens here
    rather than downstream: pushing `lamningstyp IN (…)` into SQL is what keeps
    a dense 4x4 km window from materialising thousands of irrelevant records.
    """
    columns = _resolve(gpkg, layer)
    placeholders = ", ".join("?" for _ in SELECTED_TYPES)
    types = tuple(sorted(SELECTED_TYPES))
    features = []
    for attributes, geometry in read_features_bbox(
        gpkg,
        layer,
        list(columns.values()),
        bounds3006,
        where=f'"{columns["lamningstyp"]}" IN ({placeholders})',
        params=types,
    ):
        properties = {canonical: attributes.get(actual) for canonical, actual in columns.items()}
        if not properties.get("url") and properties.get("uuid"):
            properties["url"] = f"https://pub.raa.se/visa/objekt/lamning/{properties['uuid']}"
        features.append({"type": "Feature", "properties": properties, "geometry": geometry.geojson})
    return features


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


def read_all_layers(cfg: SiteConfig, force_download: bool = False) -> dict[str, list[dict]]:
    """The three geometry layers over this site's context bbox, whichever file we have.

    The riket extract wins when it is cached: it covers every county, so a
    registry site anywhere in Sweden works with no per-county download, and it
    reads without a GDAL binary.

    The Uppsala county file is a fallback **only for the hand-configured Uppland
    sites**. For a registry site it would be worse than no data: `ogr2ogr -spat`
    over a bbox the file does not cover returns zero features and no error, so a
    fort on Gotland would ship a perfectly valid `sites.json` saying there is
    nothing near it — and its rampart derivation, which needs the site's own
    extent polygon, would silently skip. That is a wrong answer wearing a
    right answer's clothes, so it is refused outright.
    """
    bounds = cfg.bounds3006(cfg.context.half_extent)
    national = national_gpkg_path()
    if national.exists():
        layers = national_layers(national)
        missing = {"polygon", "linestring", "point"} - set(layers)
        if missing:
            raise SitesError(f"{national.name} has no {sorted(missing)} layer(s)")
        print(f"  source: {national.name} (riket, R*Tree bbox query)")
        return {kind: read_layer_bbox_national(national, layers[kind], bounds) for kind in layers}

    if cfg.from_registry:
        raise SitesError(
            f"{cfg.id} is a registry site, so its KMR extract needs the national "
            f"GeoPackage ({national.name}), which is not in data-cache/. Run "
            f"`python3 -m fornborg_pipeline.registry --fetch` first. (The "
            f"{RAA_GPKG} fallback covers Uppsala only and would return an empty "
            f"extract for a site outside it — without saying so.)"
        )

    print(f"  source: {RAA_GPKG} (Uppsala county, via ogr2ogr)")
    gpkg = download_gpkg(force=force_download)
    return {
        kind: read_layer_bbox(gpkg, f"{LAYER_PREFIX}_{kind}", bounds)
        for kind in ("polygon", "linestring", "point")
    }


def run(site_id: str, force_download: bool = False) -> dict:
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — KMR sites extract (PLAN §2.2 type filter)")
    features_by_kind = read_all_layers(cfg, force_download=force_download)
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
    help="Site whose sites.json to build (a registered site id or registry slug).",
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
