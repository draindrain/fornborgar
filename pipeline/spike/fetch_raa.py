"""Phase-0 spike: RAÄ lämningar GeoPackage — download, schema check, Broborg record.

Findings (2026-08-20, spike run):
- Download root moved to .../datauttag/lamningar_v1/ (county files under lan/,
  URL-encoded Swedish filenames, e.g. l%C3%A4mningar_l%C3%A4n_uppsala.gpkg).
- New (Oct 2025) schema is relational: geometry layers `point` / `linestring` /
  `polygon` carry only (lamning_uuid, geometrinummer); attributes live in the
  non-spatial `lamning` table (uuid, lamningsnummer, raa_nummer, lamningstyp,
  lamningsnamn, beskrivning, antikvariskbedomning, ...). Denormalized convenience
  layers `lämningar_län_<län>_{point,linestring,polygon}` duplicate the join, and
  `lämningar_län_<län>_lägesosäkerhet` holds positional uncertainty polygons.
  There is NO structured dating column. `lamningstyp` survives as assumed.
- Broborg = lamningsnummer L1943:7827, raa_nummer "Husby-Långhundra 156:1",
  uuid 184ca0f6-16f9-4de8-bbec-99aa959f9824, lamningstyp Fornborg,
  geometry: one POLYGON (site extent, ~6310 m2), centroid E 665808 N 6627881,
  lägesosäkerhet 10 m. No per-rampart geometry (confirms PLAN.md §4.6).

Run:  python3 pipeline/spike/fetch_raa.py
"""

import urllib.request

import geopandas as gpd
import pandas as pd

from common import BBOX_3006, CACHE_DIR

URL = (
    "https://pub.raa.se/nedladdning/datauttag/lamningar_v1/lan/"
    "l%C3%A4mningar_l%C3%A4n_uppsala.gpkg"
)
BROBORG_UUID = "184ca0f6-16f9-4de8-bbec-99aa959f9824"


def main():
    CACHE_DIR.mkdir(exist_ok=True)
    gpkg = CACHE_DIR / "lamningar_lan_uppsala.gpkg"
    if not gpkg.exists():
        print(f"downloading {URL} ...")
        urllib.request.urlretrieve(URL, gpkg)
    print(f"{gpkg}: {gpkg.stat().st_size/1e6:.0f} MB")

    import pyogrio

    for name, _ in pyogrio.list_layers(gpkg):
        print(" layer:", name)

    # Denormalized polygon layer: attributes + geometry in one place.
    polys = gpd.read_file(gpkg, layer="lämningar_län_uppsala_polygon")
    broborg = polys[polys["uuid"] == BROBORG_UUID]
    row = broborg.iloc[0]
    print(f"\nBroborg: {row['lamningsnummer']} / {row['raa_nummer']} "
          f"({row['lamningstyp']}, {row.geometry.geom_type}, "
          f"{row.geometry.area:.0f} m2, centroid "
          f"{row.geometry.centroid.x:.0f} E {row.geometry.centroid.y:.0f} N)")

    # Export Broborg extent + everything in the spike bbox for overlays.
    broborg.to_file(CACHE_DIR / "broborg_extent.geojson", driver="GeoJSON")
    w, s, e, n = BBOX_3006
    frames = []
    for lyr in ("point", "linestring", "polygon"):
        g = gpd.read_file(gpkg, layer=f"lämningar_län_uppsala_{lyr}",
                          bbox=(w, s, e, n))
        frames.append(g)
        print(f" bbox {lyr}: {len(g)} features, "
              f"types: {sorted(g['lamningstyp'].unique())[:8]}")
    allg = pd.concat(frames, ignore_index=True)
    allg.to_file(CACHE_DIR / "broborg_bbox_lamningar.gpkg", driver="GPKG")
    print(f"wrote broborg_extent.geojson + broborg_bbox_lamningar.gpkg "
          f"({len(allg)} features)")


if __name__ == "__main__":
    main()
