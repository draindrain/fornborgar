"""National site registry: the KMR extract -> `registry.json` (scale-out §4.1).

    python3 -m fornborg_pipeline.registry --build

One entry per registered fornborg in Sweden — slug, name, county, representative
point, extent bbox, geometry class, antikvarisk bedömning and the extent preset
(§5.2). This registry is what drives everything else at national scale: batch
builds (`build_site`), the national `index.json`, and the QA reports.

Source: the *riket* GeoPackage `lämningar_sverige.gpkg` from pub.raa.se (~2.3 GB,
cached in `data-cache/`). County files would work too, but the riket file has an
identical schema and using it avoids county-border seams — a fort whose extent
straddles a border appears once, not twice.

Everything here is deterministic given the cached file: no network beyond the
one-time download, no per-site hand-tuning. Adding a site to a batch is a slug,
not a code change.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
import urllib.request
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path

import click

from .gpkg import GeoPackageError, Geometry, list_layers, read_features, table_columns
from .sites import CACHE_DIR, REPO_ROOT

#: The national extract. The Swedish filename is URL-encoded on the server.
RAA_NATIONAL_URL = (
    "https://pub.raa.se/nedladdning/datauttag/lamningar_v1/"
    "l%C3%A4mningar_sverige.gpkg"
)
NATIONAL_GPKG = "lamningar_sverige.gpkg"

#: The type this project is about, `lamningstyp` verbatim from Lämningstypslistan.
FORNBORG_TYPE = "Fornborg"

#: Where the built registry lands. Committed: it is small (~0.4 MB), it is the
#: input every batch run is reproducible against, and rebuilding it needs 2.3 GB
#: of download that nobody should need in order to run one site.
REGISTRY_PATH = REPO_ROOT / "pipeline" / "registry.json"
SCHEMA_VERSION = 1

#: Extent presets (docs/national-scaleout.md §5.2). A site whose KMR extent bbox
#: is wider than this in either dimension gets the `large` preset: the same
#: 2000x2000 pixel budget spread over twice the ground (8x8 km context @ 4 m,
#: 4x4 km core @ 2 m), so every app performance budget holds unchanged.
LARGE_PRESET_THRESHOLD_M = 1000.0
PRESET_STANDARD = "standard"
PRESET_LARGE = "large"

#: KMR columns the registry reads, in the denormalized `lämningar_sverige_*`
#: layers. Resolved case-insensitively against the actual schema, because the
#: published column names have changed spelling between releases.
WANTED_COLUMNS = {
    "uuid": ("uuid", "lamning_uuid"),
    "lamningsnummer": ("lamningsnummer", "lamningnummer"),
    "raa_nummer": ("raa_nummer", "raanummer"),
    "lamningsnamn": ("lamningsnamn", "namn"),
    "lamningstyp": ("lamningstyp",),
    "antikvariskbedomning": ("antikvariskbedomning", "antikvarisk_bedomning"),
    "lan": ("lan", "lansnamn", "lan_namn", "county"),
    "kommun": ("kommun", "kommunnamn", "kommun_namn"),
}


class RegistryError(RuntimeError):
    """The registry cannot be built from what is on disk."""


@dataclass(frozen=True)
class RegistryEntry:
    """One registered fornborg, as the batch pipeline needs it."""

    slug: str
    lamningsnummer: str
    name: str
    county: str
    kommun: str
    #: Representative point, EPSG:3006 (polygon centroid / line midpoint / point).
    centerE: float
    centerN: float
    #: The KMR extent bbox in EPSG:3006, and its widest dimension in meters.
    extent: dict
    extentSpanM: float
    geometryClass: str
    antikvariskBedomning: str
    extentPreset: str
    uuid: str
    raaNummer: str
    fornsokUrl: str


def gpkg_path() -> Path:
    return CACHE_DIR / NATIONAL_GPKG


def fetch_national_gpkg(force: bool = False, progress: bool = True) -> Path:
    """Download the riket GeoPackage into `data-cache/`, resuming a partial file.

    ~2.3 GB over a slow public endpoint, so the download writes to `<name>.part`
    and only renames on success — an interrupted run never leaves a truncated
    file that looks complete to the next one.
    """
    target = gpkg_path()
    if target.exists() and not force:
        return target
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".part")
    if force and partial.exists():
        partial.unlink()

    already = partial.stat().st_size if partial.exists() else 0
    request = urllib.request.Request(RAA_NATIONAL_URL)
    if already:
        request.add_header("Range", f"bytes={already}-")
    with urllib.request.urlopen(request) as response:
        resuming = response.status == 206
        if already and not resuming:
            already = 0  # the server ignored the range; start over
        total = int(response.headers.get("content-length", 0)) + already
        mode = "ab" if resuming and already else "wb"
        with partial.open(mode) as out:
            downloaded = already
            while chunk := response.read(1 << 20):
                out.write(chunk)
                downloaded += len(chunk)
                if progress and downloaded % (64 << 20) < (1 << 20):
                    share = f" / {total / 1e9:.2f} GB" if total else ""
                    print(f"  {downloaded / 1e9:.2f} GB{share}", flush=True)
    partial.rename(target)
    return target


def slug_for(lamningsnummer: str) -> str:
    """`L1943:7827` -> `l1943-7827`: a safe path segment and a stable site id.

    The app's `?site=` guard accepts `[A-Za-z0-9][A-Za-z0-9._-]*`, and R2 keys
    live under `v1/<slug>/`, so anything else in the KMR number is normalised
    out rather than escaped.
    """
    if not lamningsnummer:
        raise RegistryError("a registry entry needs a lämningsnummer to build a slug from")
    slug = lamningsnummer.strip().lower().replace(":", "-")
    slug = re.sub(r"[^a-z0-9._-]+", "-", slug).strip("-")
    if not slug or not slug[0].isalnum():
        raise RegistryError(f"lämningsnummer {lamningsnummer!r} yields no usable slug")
    return slug


def preset_for(span_m: float) -> str:
    """§5.2: `large` for the handful of sites wider than a kilometre."""
    return PRESET_LARGE if span_m > LARGE_PRESET_THRESHOLD_M else PRESET_STANDARD


def _resolve_columns(path: Path, table: str) -> dict[str, str]:
    """Map our canonical names onto whatever this release actually calls them."""
    present = {name.lower(): name for name in table_columns(path, table)}
    resolved: dict[str, str] = {}
    for canonical, candidates in WANTED_COLUMNS.items():
        for candidate in candidates:
            if candidate in present:
                resolved[canonical] = present[candidate]
                break
    for required in ("lamningsnummer", "lamningstyp"):
        if required not in resolved:
            raise RegistryError(
                f"{table} has no {required} column (looked for "
                f"{WANTED_COLUMNS[required]}); columns are {sorted(present)}"
            )
    return resolved


def fornborg_layers(path: Path) -> list[str]:
    """The denormalized feature layers to scan, geometry classes in a stable order.

    The riket GeoPackage carries the KMR schema *twice*: bare relational geometry
    tables (`polygon`, `point`, `linestring` — only `lamning_uuid` and a geometry
    column) alongside the denormalized `lämningar_sverige_*` layers that join the
    attributes back in. Both match a name-suffix test, and only the second kind
    is usable, so layers are selected by **carrying the attributes we need** — a
    test that also survives the layers being renamed again, as they were in the
    October 2025 schema change.

    Order is polygon, then line, then point: a site with both an extent polygon
    and a point should be registered from the polygon (§4.1), and `build_entries`
    keeps the first row it sees per slug.
    """
    order = {"polygon": 0, "linestring": 1, "point": 2}
    candidates = []
    for name, kind in list_layers(path):
        if kind != "features":
            continue
        present = {column.lower() for column in table_columns(path, name)}
        if not ({"lamningstyp"} <= present and present & set(WANTED_COLUMNS["lamningsnummer"])):
            continue
        rank = next((r for suffix, r in order.items() if name.lower().endswith(suffix)), 3)
        candidates.append((rank, name))
    if not candidates:
        raise RegistryError(
            f"{path.name} has no feature layer carrying lamningstyp + lamningsnummer; "
            f"layers are {[n for n, _k in list_layers(path)]}"
        )
    return [name for _rank, name in sorted(candidates)]


def entry_from(attributes: dict, geometry: Geometry) -> RegistryEntry:
    """Build one registry entry from a KMR row. Pure — no file access."""
    lamningsnummer = str(attributes.get("lamningsnummer") or "").strip()
    min_e, min_n, max_e, max_n = geometry.bbox
    span = max(max_e - min_e, max_n - min_n)
    center_e, center_n = geometry.representative_point
    uuid = str(attributes.get("uuid") or "").strip()
    name = str(attributes.get("lamningsnamn") or "").strip() or lamningsnummer
    return RegistryEntry(
        slug=slug_for(lamningsnummer),
        lamningsnummer=lamningsnummer,
        name=name,
        county=str(attributes.get("lan") or "").strip(),
        kommun=str(attributes.get("kommun") or "").strip(),
        # Rounded to 10 m, as Broborg's hand-checked center was [phase-0 verified]:
        # the DEM grid is site-centered, and a sub-meter center is false precision
        # against a KMR extent digitised at ~10 m positional uncertainty.
        centerE=round(center_e, -1),
        centerN=round(center_n, -1),
        extent={
            "minE": round(min_e, 1),
            "minN": round(min_n, 1),
            "maxE": round(max_e, 1),
            "maxN": round(max_n, 1),
        },
        extentSpanM=round(span, 1),
        geometryClass=geometry.kind,
        antikvariskBedomning=str(attributes.get("antikvariskbedomning") or "").strip(),
        extentPreset=preset_for(span),
        uuid=uuid,
        raaNummer=str(attributes.get("raa_nummer") or "").strip(),
        fornsokUrl=f"https://pub.raa.se/visa/objekt/lamning/{uuid}" if uuid else "",
    )


def build_entries(path: Path, lamningstyp: str = FORNBORG_TYPE) -> tuple[list[RegistryEntry], dict]:
    """Scan every feature layer and return (entries, stats), deduplicated by slug.

    A record can appear in more than one geometry layer (a fort with both an
    extent polygon and a point). Polygons are scanned first and win, because the
    extent polygon is the richer record — the pipeline uses it for the rampart
    derivation and the site-extent overlay.
    """
    entries: dict[str, RegistryEntry] = {}
    stats = {"scanned": 0, "kept": 0, "duplicates": 0, "unusable": 0, "byLayer": {}}
    for table in fornborg_layers(path):
        columns = _resolve_columns(path, table)
        rows = read_features(
            path,
            table,
            list(columns.values()),
            where=f'"{columns["lamningstyp"]}" = ?',
            params=(lamningstyp,),
        )
        layer_kept = 0
        for raw, geometry in rows:
            stats["scanned"] += 1
            attributes = {canonical: raw.get(actual) for canonical, actual in columns.items()}
            try:
                entry = entry_from(attributes, geometry)
            except (RegistryError, GeoPackageError):
                stats["unusable"] += 1
                continue
            if entry.slug in entries:
                stats["duplicates"] += 1
                continue
            entries[entry.slug] = entry
            layer_kept += 1
        stats["byLayer"][table] = layer_kept
    stats["kept"] = len(entries)
    return sorted(entries.values(), key=lambda e: e.slug), stats


def summarize(entries: list[RegistryEntry]) -> dict:
    """The distribution facts the scale-out doc quotes, recomputed from the build."""
    spans = sorted(entry.extentSpanM for entry in entries)

    def percentile(p: float) -> float:
        if not spans:
            return 0.0
        return round(spans[min(len(spans) - 1, int(len(spans) * p))], 1)

    return {
        "count": len(entries),
        "byCounty": dict(Counter(e.county for e in entries).most_common()),
        "byBedomning": dict(Counter(e.antikvariskBedomning for e in entries).most_common()),
        "byGeometryClass": dict(Counter(e.geometryClass for e in entries).most_common()),
        "byPreset": dict(Counter(e.extentPreset for e in entries).most_common()),
        "extentSpanM": {
            "p50": percentile(0.50),
            "p90": percentile(0.90),
            "p95": percentile(0.95),
            "p99": percentile(0.99),
            "max": spans[-1] if spans else 0.0,
        },
        "largePresetSites": [
            {"slug": e.slug, "name": e.name, "county": e.county, "spanM": e.extentSpanM}
            for e in entries
            if e.extentPreset == PRESET_LARGE
        ],
    }


def build_registry(path: Path, lamningstyp: str = FORNBORG_TYPE) -> dict:
    entries, stats = build_entries(path, lamningstyp)
    if not entries:
        raise RegistryError(
            f"no {lamningstyp!r} records found in {path.name} — wrong file or wrong type filter"
        )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generated": date.today().isoformat(),
        "source": {
            "id": "raa-kmr",
            "product": "Riksantikvarieämbetet, Kulturmiljöregistret — lämningar (riket)",
            "url": RAA_NATIONAL_URL,
            "file": path.name,
            "bytes": path.stat().st_size,
            "lamningstyp": lamningstyp,
        },
        "crs": "EPSG:3006",
        "stats": {**stats, **summarize(entries)},
        "sites": [asdict(entry) for entry in entries],
    }


def write_registry(path: Path, registry: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def load_registry(path: Path = REGISTRY_PATH) -> dict:
    if not path.exists():
        raise RegistryError(
            f"{path} is missing — run `python3 -m fornborg_pipeline.registry --build` "
            f"(downloads {NATIONAL_GPKG} into data-cache/ once)."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def find_entries(text: str, path: Path = REGISTRY_PATH, limit: int = 25) -> list[dict]:
    """Registry rows matching `text` in name, lämningsnummer, slug or county.

    How a curated site list (§7's pilot, say) gets turned into slugs. KMR names
    only a minority of fornborgar — most rows carry no `lamningsnamn` at all —
    so this searches the identifiers too, and a caller that finds nothing should
    reach for the lämningsnummer rather than assume the fort is absent.
    """
    needle = _fold(text)
    if not needle:
        return []
    matches = [
        site
        for site in load_registry(path)["sites"]
        if any(
            needle in _fold(str(site.get(field, "")))
            for field in ("name", "lamningsnummer", "slug", "county", "kommun")
        )
    ]
    return matches[:limit]


def _fold(value: str) -> str:
    """Casefold and strip diacritics, so "graborg" finds "Gråborg"."""
    decomposed = unicodedata.normalize("NFD", value)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower().strip()


def get_entry(slug: str, path: Path = REGISTRY_PATH) -> dict:
    registry = load_registry(path)
    for site in registry["sites"]:
        if site["slug"] == slug:
            return site
    raise RegistryError(f"no registry entry for slug {slug!r} in {path.name}")


@click.command()
@click.option("--find", "find_text", default=None, help="Search the built registry and print matches.")
@click.option("--build", "do_build", is_flag=True, help="Build registry.json from the cached extract.")
@click.option("--fetch", "do_fetch", is_flag=True, help="Download the national GeoPackage only.")
@click.option("--force-download", is_flag=True, help="Re-download even if a cached copy exists.")
@click.option("--lamningstyp", default=FORNBORG_TYPE, show_default=True, help="KMR type to select.")
@click.option(
    "--out",
    "out_path",
    type=click.Path(path_type=Path),
    default=REGISTRY_PATH,
    show_default=True,
    help="Where to write registry.json.",
)
def cli(
    find_text: str | None,
    do_build: bool,
    do_fetch: bool,
    force_download: bool,
    lamningstyp: str,
    out_path: Path,
) -> None:
    """Build the national fornborg registry from the KMR riket GeoPackage."""
    if find_text:
        try:
            matches = find_entries(find_text, out_path)
        except RegistryError as exc:
            raise SystemExit(str(exc)) from exc
        if not matches:
            print(f"no registry entry matches {find_text!r}")
            return
        for site in matches:
            print(
                f"  {site['slug']:16} {site['lamningsnummer']:14} {site['extentPreset']:9} "
                f"{site['extentSpanM']:8.0f} m  {site['county']:20} {site['name']}"
            )
        return
    if not (do_build or do_fetch):
        raise SystemExit("nothing to do: pass --build, --fetch or --find")
    print(f"-- national KMR extract ({NATIONAL_GPKG})")
    path = fetch_national_gpkg(force=force_download)
    print(f"  {path} ({path.stat().st_size / 1e9:.2f} GB)")
    if not do_build:
        return

    print(f"-- scanning for lamningstyp = {lamningstyp!r}")
    registry = build_registry(path, lamningstyp)
    stats = registry["stats"]
    print(f"  {stats['kept']} sites from {stats['scanned']} records "
          f"({stats['duplicates']} duplicate geometries, {stats['unusable']} unusable)")
    print(f"  by geometry class: {stats['byGeometryClass']}")
    print(f"  by bedömning: {stats['byBedomning']}")
    print(f"  extent span p50 {stats['extentSpanM']['p50']} m, p95 {stats['extentSpanM']['p95']} m, "
          f"max {stats['extentSpanM']['max']} m")
    print(f"  presets: {stats['byPreset']}")
    for site in stats["largePresetSites"]:
        print(f"    large: {site['slug']} {site['name']} ({site['county']}, {site['spanM']} m)")
    top = list(stats["byCounty"].items())[:8]
    print("  top counties: " + ", ".join(f"{county} {n}" for county, n in top))

    written = write_registry(out_path, registry)
    print(f"== wrote {written} ({written.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    sys.exit(cli())
