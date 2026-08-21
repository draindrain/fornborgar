"""Survey: which KMR lämningstyper occur inside fornborg context extents?

    python3 type_survey.py [--kommun knivsta nyköping ...] [--half-extent 2000]

The land-cover model's evidence base (PLAN §4.7, contract §10 rule texts) selects
KMR types as proxies for settlement, graves, cultivation and roads. Whether a
candidate type is *worth* selecting is a national question, not a Broborg one —
Broborg's own 4×4 km extent happens to contain almost none of the direct-evidence
types, while they are common around forts elsewhere. This script measures that:
for every `Fornborg` record in the given kommun extracts, count which candidate
types have at least one record inside the fort's context-sized bbox.

Reference run (2026-08-21, four kommuner in three counties — Knivsta/Uppsala,
Nyköping/Södermanland, Södertälje + Norrtälje/Stockholm; 195 forts):

    99 % of forts had >= 1 candidate-type record in their extent.
    Stensättning 98 %, Röse 78 %, Hög 59 %, Fossil åker 58 %, Färdväg 56 %,
    Skärvstenshög 43 %, Röjningsröse 39 %, Hägnad 38 %, Terrassering 36 %,
    Husgrund förhistorisk/medeltida 19 %.

That measurement is what put the grave/settlement/cultivation/road type sets into
`fornborg_pipeline.landcover` — rerun it over more counties before tuning them.

Implementation notes: a GeoPackage is SQLite, so no GDAL is needed — the KMR
kommun files are read directly. Geometry bboxes come from the GPKG binary header
envelope when present; **point features often ship without an envelope** (the
header's envelope-indicator is 0), so the point WKB is parsed for those — skipping
them silently would drop exactly the single-grave types this survey exists to
count. Downloads are cached under data-cache/ like every other fetch.
"""

from __future__ import annotations

import argparse
import sqlite3
import struct
import sys
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = REPO_ROOT / "data-cache"

KOMMUN_URL = (
    "https://pub.raa.se/nedladdning/datauttag/lamningar_v1/kommun/"
    "l%C3%A4mningar_kommun_{kommun}.gpkg"
)

#: The type sets under evaluation — keep in sync with fornborg_pipeline.landcover
#: (SETTLEMENT_TYPES / CULTIVATION_TYPES / ROAD_TYPES) plus the overlay-only pair.
CANDIDATE_TYPES = (
    "Hög",
    "Stensättning",
    "Röse",
    "Gravgrupp",
    "Flatmarksgrav",
    "Grav markerad av sten/block",
    "Stenkammargrav",
    "Skärvstenshög",
    "Husgrund, förhistorisk/medeltida",
    "Boplatsvall",
    "Fossil åker",
    "Område med fossil åkermark",
    "Röjningsröse",
    "Röjningsröseområde",
    "Terrassering",
    "Färdväg",
    "Färdvägssystem",
    "Hägnad",
    "Hägnadssystem",
)

#: 2026-08-21 reference set: fornborg-rich kommuner across three counties.
DEFAULT_KOMMUNER = ("knivsta", "nyköping", "södertälje", "norrtälje")


def download(kommun: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"lamningar_kommun_{kommun}.gpkg"
    if path.exists():
        return path
    url = KOMMUN_URL.format(kommun=urllib.parse.quote(kommun))
    print(f"downloading {url} …")
    urllib.request.urlretrieve(url, path)
    print(f"  {path.stat().st_size / 1e6:.0f} MB")
    return path


def geom_bbox(blob: bytes) -> tuple[float, float, float, float] | None:
    """(minx, maxx, miny, maxy) from a GPKG geometry blob, or None if unsupported.

    Envelope from the GPKG header when the envelope-indicator says one is there;
    otherwise the WKB is parsed, which this survey only needs for Points (the one
    geometry kind the product ships envelope-less).
    """
    flags = blob[3]
    envelope_indicator = (flags >> 1) & 0x07
    order = "<" if flags & 1 else ">"
    if envelope_indicator:
        n = {1: 4, 2: 6, 3: 6, 4: 8}[envelope_indicator]
        v = struct.unpack(f"{order}{n}d", blob[8 : 8 + 8 * n])
        return v[0], v[1], v[2], v[3]
    wkb_order = "<" if blob[8] else ">"
    (wkb_type,) = struct.unpack(f"{wkb_order}I", blob[9:13])
    if wkb_type % 1000 == 1:  # Point, incl. Z/M variants
        x, y = struct.unpack(f"{wkb_order}2d", blob[13:29])
        return x, x, y, y
    return None


def read_records(gpkg: Path, kommun: str) -> list[tuple[str, float, float, float, float]]:
    """Every (lamningstyp, minx, maxx, miny, maxy) from the denormalized layers."""
    records: list[tuple[str, float, float, float, float]] = []
    db = sqlite3.connect(gpkg)
    try:
        cur = db.cursor()
        for kind in ("point", "linestring", "polygon"):
            layer = f"lämningar_kommun_{kommun}_{kind}"
            row = cur.execute(
                "SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ?",
                (layer,),
            ).fetchone()
            if row is None:
                raise SystemExit(f"{gpkg.name}: layer {layer!r} not found — schema change?")
            for typ, blob in cur.execute(f'SELECT lamningstyp, "{row[0]}" FROM "{layer}"'):
                if blob is None or typ is None:
                    continue
                bbox = geom_bbox(blob)
                if bbox is not None:
                    records.append((typ, *bbox))
    finally:
        db.close()
    return records


def survey(kommuner: list[str], half_extent: float) -> None:
    total_forts = 0
    forts_with_any = 0
    forts_with_type: Counter[str] = Counter()

    for kommun in kommuner:
        records = read_records(download(kommun), kommun)
        forts = [
            ((minx + maxx) / 2.0, (miny + maxy) / 2.0)
            for typ, minx, maxx, miny, maxy in records
            if typ == "Fornborg"
        ]
        hits = 0
        for cx, cy in forts:
            found = {
                typ
                for typ, minx, maxx, miny, maxy in records
                if typ in CANDIDATE_TYPES
                and maxx >= cx - half_extent
                and minx <= cx + half_extent
                and maxy >= cy - half_extent
                and miny <= cy + half_extent
            }
            if found:
                hits += 1
            for typ in found:
                forts_with_type[typ] += 1
        total_forts += len(forts)
        forts_with_any += hits
        print(f"{kommun}: {len(forts)} forts, {hits} with >= 1 candidate-type record in extent")

    if total_forts == 0:
        raise SystemExit("no Fornborg records found — check the kommun names")
    print(
        f"\nTOTAL: {total_forts} forts, {forts_with_any} "
        f"({100.0 * forts_with_any / total_forts:.0f} %) with >= 1 candidate-type record"
    )
    print(f"{'type':<36}{'forts':>6}{'%':>6}")
    for typ, n in forts_with_type.most_common():
        print(f"{typ:<36}{n:>6}{100.0 * n / total_forts:>5.0f}%")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--kommun",
        nargs="+",
        default=list(DEFAULT_KOMMUNER),
        help="kommun names as spelled in the RAÄ download filenames (lowercase)",
    )
    parser.add_argument(
        "--half-extent",
        type=float,
        default=2000.0,
        help="half the context extent, m (PLAN §7.11: 2000 = the 4x4 km clip)",
    )
    args = parser.parse_args()
    survey(args.kommun, args.half_extent)


if __name__ == "__main__":
    sys.exit(main())
