"""Phase-0 spike: SGU soils (OGC API) + strandförskjutningsmodell checks.

Findings (2026-08-20, spike run):
- Jordarter OGC API works anonymously; collections: blockighet, grundlager,
  landform, linjer, oversta-ytlager, punkter, tackningskarta,
  underliggande-lager, ytlager. storageCrs = EPSG:3006 (also serves 3006 out).
  Attributes unchanged from the old schema: jg2 (int code) + jg2_tx (text),
  plus kartering/karttyp/symbol. Classes seen at Broborg: Sandig morän, Urberg,
  Glacial lera, Postglacial lera, Kärrtorv, Isälvssediment, Gyttjelera, Gyttja,
  Klapper, Svämsediment, Fyllning, Vatten, Postglacial sand.
- Strandförskjutningsmodell ALSO has an OGC API (PLAN.md said [open]):
  https://api.sgu.se/oppnadata/strandforskjutningsmodell/ogc/features/v1,
  14 collections bp1-900 ... bp13000-13500; polygon features with attributes
  bp (string), year (calendar year, 1950-BP), code (1=Hav, 4=Sjö), description.
- GeoPackage download confirmed at
  .../strandforskjutningsmodell/strandforskjutning_<from>_<to>.gpkg
  (underscore range, e.g. strandforskjutning_1000_1900.gpkg), with per-century
  layers issjohav_<bp> — NOTE: bp is years-before-1950, not calendar year, and
  bp 1100 is missing from the product.

Run:  python3 pipeline/spike/fetch_sgu.py
"""

import json
import urllib.request

from common import CACHE_DIR, wgs84_bbox

JORD_API = "https://api.sgu.se/oppnadata/jordarter25k-100k/ogc/features/v1"
STRAND_API = "https://api.sgu.se/oppnadata/strandforskjutningsmodell/ogc/features/v1"


def get_items(api, collection, bbox, limit=1000):
    url = (f"{api}/collections/{collection}/items?f=json"
           f"&bbox={bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}&limit={limit}")
    return json.load(urllib.request.urlopen(url))


def main():
    CACHE_DIR.mkdir(exist_ok=True)
    b = wgs84_bbox()

    soils = get_items(JORD_API, "grundlager", b)
    print(f"grundlager: {len(soils['features'])} features")
    (CACHE_DIR / "broborg_soils.geojson").write_text(json.dumps(soils))

    # Fort era ~400-550 CE = BP ~1400-1550; grab the whole bp1000-1900 window.
    shore = get_items(STRAND_API, "bp1000-1900", b)
    counts = {}
    for f in shore["features"]:
        p = f["properties"]
        key = (p["bp"], p["year"], p["code"])
        counts[key] = counts.get(key, 0) + 1
    for (bp, year, code), n in sorted(counts.items(), key=lambda x: int(x[0][0])):
        kind = {1: "Hav", 4: "Sjö"}.get(code, code)
        print(f"  BP {bp} (year {year}): {n} x {kind}")
    (CACHE_DIR / "broborg_shoreline_bp1000_1900.geojson").write_text(json.dumps(shore))
    print("wrote broborg_soils.geojson + broborg_shoreline_bp1000_1900.geojson")


if __name__ == "__main__":
    main()
