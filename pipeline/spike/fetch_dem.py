"""Phase-0 spike: STAC query + windowed download of the Broborg 4x4 km DEM.

Queries the Lantmäteriet STAC API (anonymous) for dtm-cog tiles intersecting
the spike bbox, then does windowed /vsicurl reads (HTTP Basic auth from the
LANTMATERIET_USER / LANTMATERIET_PASS env vars — never written to disk) and
mosaics them into data-cache/broborg_dem_4km.tif (EPSG:3006, 1 m, float32).

Run:  python3 pipeline/spike/fetch_dem.py
"""

import json
import os
import sys
import urllib.request

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.windows import from_bounds

from common import BBOX_3006, CACHE_DIR, DTM_COLLECTION, STAC_ROOT, wgs84_bbox


def stac_search():
    body = {"collections": [DTM_COLLECTION], "bbox": list(wgs84_bbox()), "limit": 20}
    req = urllib.request.Request(
        f"{STAC_ROOT}/search",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["features"]


def main():
    user, pw = os.environ.get("LANTMATERIET_USER"), os.environ.get("LANTMATERIET_PASS")
    if not (user and pw):
        sys.exit("Set LANTMATERIET_USER and LANTMATERIET_PASS (Geotorget credentials).")
    os.environ["GDAL_HTTP_AUTH"] = "BASIC"
    os.environ["GDAL_HTTP_USERPWD"] = f"{user}:{pw}"
    os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"

    items = stac_search()
    print(f"STAC returned {len(items)} item(s): {[f['id'] for f in items]}")

    w, s, e, n = BBOX_3006
    width, height = e - w, n - s  # 1 m resolution
    mosaic = np.full((height, width), -9999.0, dtype=np.float32)
    out_transform = from_origin(w, n, 1.0, 1.0)

    for item in items:
        url = "/vsicurl/" + item["assets"]["data"]["href"]
        with rasterio.open(url) as src:
            tb = src.bounds
            iw, is_, ie, in_ = (
                max(w, tb.left), max(s, tb.bottom), min(e, tb.right), min(n, tb.top),
            )
            if iw >= ie or is_ >= in_:
                print(f"  {item['id']}: no overlap (WGS84 bbox edge artifact), skipped")
                continue
            win = from_bounds(iw, is_, ie, in_, src.transform)
            data = src.read(1, window=win)
            r0, c0 = int(n - in_), int(iw - w)
            mosaic[r0 : r0 + data.shape[0], c0 : c0 + data.shape[1]] = data
            print(f"  {item['id']}: read {data.shape[1]}x{data.shape[0]} px window")

    nodata_count = int((mosaic == -9999.0).sum())
    print(f"mosaic: {width}x{height}, nodata cells: {nodata_count}")

    CACHE_DIR.mkdir(exist_ok=True)
    out = CACHE_DIR / "broborg_dem_4km.tif"
    with rasterio.open(
        out, "w", driver="GTiff", width=width, height=height, count=1,
        dtype="float32", crs="EPSG:3006", transform=out_transform, nodata=-9999.0,
        compress="deflate", predictor=3, tiled=True,
    ) as dst:
        dst.write(mosaic, 1)
    valid = mosaic[mosaic != -9999.0]
    print(f"wrote {out} | z range {valid.min():.2f}..{valid.max():.2f} m RH2000")


if __name__ == "__main__":
    main()
