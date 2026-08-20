"""Fetch the raw 1 m DEM mosaic for a site from Lantmäteriet.

This is the ONLY module in the package that touches the network. Everything
downstream (clip_dem, manifest) works on plain arrays + config so it can be
tested without a network.

Flow (PLAN.md §2.1): query the Höjd STAC API for `dtm-cog` items intersecting the
site bbox (anonymous), then do windowed `/vsicurl` reads of just the site extent
out of the 10x10 km / 10000x10000 px tiles, and mosaic them into
`data-cache/<site>_dem_source.tif` (float32, EPSG:3006, 1 m, nodata -9999).

Credentials come from the LANTMATERIET_USER / LANTMATERIET_PASS environment
variables ONLY. They are passed to GDAL through a scoped `rasterio.Env` and are
never written to a file, a log line, or a command line.

The heights are read exactly as stored. No gdalwarp, no WarpedVRT, no vertical
datum transform — the source tiles declare compound EPSG:5845 and any vertical
transform would silently add the ~+23..36 m geoid shift (PLAN.md §2.1).
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
import requests
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.errors import RasterioIOError
from rasterio.transform import from_origin
from rasterio.windows import from_bounds

from .sites import DTM_COLLECTION, DTM_NODATA, EPSG_HORIZONTAL, STAC_ROOT, SiteConfig

USER_AGENT = "fornborg-pipeline/0.1 (+https://github.com/; hobby project)"
MAX_RETRIES = 5
DEFAULT_BACKOFF = 5.0  # seconds, used when the server sends no Retry-After


class FetchError(RuntimeError):
    """Network/authentication failure that the caller should report, not paper over."""


def credentials() -> tuple[str, str]:
    """Geotorget credentials from the environment. Never persisted anywhere."""
    user = os.environ.get("LANTMATERIET_USER")
    password = os.environ.get("LANTMATERIET_PASS")
    if not (user and password):
        raise FetchError(
            "LANTMATERIET_USER / LANTMATERIET_PASS are not set. They must come from the "
            "environment (Geotorget account with 'Markhöjdmodell Nedladdning' ordered); "
            "the pipeline never reads credentials from a file."
        )
    return user, password


def _retry_after_seconds(response: requests.Response, attempt: int) -> float:
    header = response.headers.get("Retry-After", "")
    try:
        return max(1.0, float(header))
    except ValueError:
        return DEFAULT_BACKOFF * attempt


def wgs84_bbox(bounds3006: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """Project an EPSG:3006 bbox to WGS84 lon/lat for the STAC query."""
    t = Transformer.from_crs(EPSG_HORIZONTAL, 4326, always_xy=True)
    lon1, lat1 = t.transform(bounds3006[0], bounds3006[1])
    lon2, lat2 = t.transform(bounds3006[2], bounds3006[3])
    return (min(lon1, lon2), min(lat1, lat2), max(lon1, lon2), max(lat1, lat2))


def stac_search(bounds3006: tuple[float, float, float, float], limit: int = 20) -> list[dict]:
    """POST /search on the Höjd STAC API. Anonymous; retries on HTTP 429."""
    body = {"collections": [DTM_COLLECTION], "bbox": list(wgs84_bbox(bounds3006)), "limit": limit}
    url = f"{STAC_ROOT}/search"
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = requests.post(
                url,
                json=body,
                headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
                timeout=60,
            )
        except requests.RequestException as exc:
            if attempt == MAX_RETRIES:
                raise FetchError(f"STAC search failed after {attempt} attempts: {exc}") from exc
            time.sleep(DEFAULT_BACKOFF * attempt)
            continue
        if response.status_code == 429:
            delay = _retry_after_seconds(response, attempt)
            if attempt == MAX_RETRIES:
                raise FetchError(f"STAC search rate-limited (429) after {attempt} attempts")
            print(f"  STAC 429, retrying in {delay:.0f}s ({attempt}/{MAX_RETRIES})")
            time.sleep(delay)
            continue
        if response.status_code >= 400:
            raise FetchError(
                f"STAC search HTTP {response.status_code} for {url}: {response.text[:300]}"
            )
        return response.json().get("features", [])
    raise FetchError("STAC search exhausted retries")


def _gdal_env(user: str, password: str) -> rasterio.Env:
    """GDAL config scoped to the read. GDAL_HTTP_USERPWD stays inside this object."""
    return rasterio.Env(
        GDAL_HTTP_AUTH="BASIC",
        GDAL_HTTP_USERPWD=f"{user}:{password}",
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
        # GDAL's own retry loop covers 429/5xx transients inside a range read.
        GDAL_HTTP_MAX_RETRY=str(MAX_RETRIES),
        GDAL_HTTP_RETRY_DELAY=str(int(DEFAULT_BACKOFF)),
        GDAL_HTTP_USERAGENT=USER_AGENT,
    )


def _read_window(url: str, bounds: tuple[float, float, float, float]):
    """Windowed read of one COG. Retries the whole read on transient IO errors."""
    west, south, east, north = bounds
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with rasterio.open(url) as src:
                tb = src.bounds
                iw, is_, ie, in_ = (
                    max(west, tb.left),
                    max(south, tb.bottom),
                    min(east, tb.right),
                    min(north, tb.top),
                )
                if iw >= ie or is_ >= in_:
                    return None
                window = from_bounds(iw, is_, ie, in_, src.transform)
                return src.read(1, window=window).astype(np.float32), (iw, is_, ie, in_)
        except RasterioIOError as exc:
            message = str(exc)
            if attempt == MAX_RETRIES:
                raise FetchError(
                    f"windowed read of {url} failed after {attempt} attempts: {message}"
                ) from exc
            delay = DEFAULT_BACKOFF * attempt
            print(f"  read error ({message[:120]}), retrying in {delay:.0f}s "
                  f"({attempt}/{MAX_RETRIES})")
            time.sleep(delay)
    return None


def _cache_is_valid(cfg: SiteConfig) -> dict | None:
    """Return the cached mosaic's metadata if the cache matches the site config."""
    if not (cfg.cache_path.exists() and cfg.cache_meta_path.exists()):
        return None
    try:
        meta = json.loads(cfg.cache_meta_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    west, south, east, north = cfg.source_bounds
    res = cfg.source_resolution
    expected_w = int(round((east - west) / res))
    expected_h = int(round((north - south) / res))
    try:
        with rasterio.open(cfg.cache_path) as src:
            if (src.width, src.height) != (expected_w, expected_h):
                return None
            if src.crs is None or src.crs.to_epsg() != EPSG_HORIZONTAL:
                return None
            if abs(src.transform.c - west) > 1e-6 or abs(src.transform.f - north) > 1e-6:
                return None
            if abs(src.transform.a - res) > 1e-9 or abs(src.transform.e + res) > 1e-9:
                return None
    except RasterioIOError:
        return None
    if meta.get("bounds3006") != [west, south, east, north]:
        return None
    return meta


def fetch_source_mosaic(cfg: SiteConfig, force: bool = False) -> tuple[Path, dict]:
    """Ensure `cfg.cache_path` holds the site's raw 1 m mosaic; return (path, meta).

    Reuses a valid cached file instead of re-downloading unless `force` is set.
    """
    if not force:
        meta = _cache_is_valid(cfg)
        if meta is not None:
            print(f"cache hit: {cfg.cache_path} (STAC items {meta.get('stacItems')})")
            return cfg.cache_path, meta

    user, password = credentials()
    west, south, east, north = cfg.source_bounds
    res = cfg.source_resolution
    width = int(round((east - west) / res))
    height = int(round((north - south) / res))

    items = stac_search(cfg.source_bounds)
    if not items:
        raise FetchError(
            f"STAC search returned no {DTM_COLLECTION} items for bbox {cfg.source_bounds}"
        )
    print(f"STAC returned {len(items)} item(s): {[i['id'] for i in items]}")

    mosaic = np.full((height, width), DTM_NODATA, dtype=np.float32)
    used_items: list[str] = []

    with _gdal_env(user, password):
        for item in items:
            href = item["assets"]["data"]["href"]
            result = _read_window("/vsicurl/" + href, cfg.source_bounds)
            if result is None:
                print(f"  {item['id']}: no overlap with the clip, skipped")
                continue
            data, (iw, is_, ie, in_) = result
            row0 = int(round((north - in_) / res))
            col0 = int(round((iw - west) / res))
            mosaic[row0 : row0 + data.shape[0], col0 : col0 + data.shape[1]] = data
            used_items.append(item["id"])
            print(f"  {item['id']}: read {data.shape[1]}x{data.shape[0]} px window")

    if not used_items:
        raise FetchError("no STAC item overlapped the clip — nothing was downloaded")

    nodata_cells = int((mosaic == DTM_NODATA).sum())
    valid = mosaic[mosaic != DTM_NODATA]
    if valid.size == 0:
        raise FetchError("downloaded mosaic is entirely nodata")
    print(
        f"mosaic {width}x{height} @ {res} m | nodata cells {nodata_cells} | "
        f"z {valid.min():.2f}..{valid.max():.2f} m"
    )

    cfg.cache_path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        cfg.cache_path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="float32",
        crs=CRS.from_epsg(EPSG_HORIZONTAL),
        transform=from_origin(west, north, res, res),
        nodata=DTM_NODATA,
        compress="deflate",
        predictor=3,
        tiled=True,
        blockxsize=512,
        blockysize=512,
    ) as dst:
        dst.write(mosaic, 1)

    meta = {
        "stacItems": used_items,
        "collection": DTM_COLLECTION,
        "product": "Markhöjdmodell Nedladdning (dtm-cog)",
        "fetched": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "bounds3006": [west, south, east, north],
        "resolution": res,
        "nodataCells": nodata_cells,
    }
    cfg.cache_meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {cfg.cache_path} ({cfg.cache_path.stat().st_size / 1e6:.1f} MB)")
    return cfg.cache_path, meta


def read_source_mosaic(path: Path):
    """Read the cached mosaic as (float32 array, affine transform, nodata value)."""
    with rasterio.open(path) as src:
        if src.crs is None or src.crs.to_epsg() != EPSG_HORIZONTAL:
            raise FetchError(f"cached mosaic {path} is not EPSG:{EPSG_HORIZONTAL}")
        return src.read(1).astype(np.float32), src.transform, src.nodata
