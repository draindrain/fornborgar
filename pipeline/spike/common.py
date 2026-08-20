"""Shared constants for the phase-0 spike scripts.

All coordinates are SWEREF 99 TM (EPSG:3006), heights RH 2000.
Raw downloads go to the gitignored data-cache/ directory at the repo root.
"""

from pathlib import Path

# Broborg (RAÄ Husby-Långhundra 156:1 / L1943:7827), site center from the
# KMR extent-polygon centroid (E 665808, N 6627881), rounded to 10 m.
# NOTE: PLAN.md originally assumed E 668400 — that was ~2.6 km east of the
# actual fort; corrected in phase 0.
BROBORG_E = 665810
BROBORG_N = 6627880

# 4x4 km spike extent centered on the site (PLAN.md §7.11).
HALF = 2000
BBOX_3006 = (BROBORG_E - HALF, BROBORG_N - HALF, BROBORG_E + HALF, BROBORG_N + HALF)

STAC_ROOT = "https://api.lantmateriet.se/stac-hojd/v1"
DTM_COLLECTION = "dtm-cog"

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = REPO_ROOT / "data-cache"
OUT_DIR = Path(__file__).resolve().parent / "out"


def wgs84_bbox():
    """Spike bbox as WGS84 lon/lat for STAC/OGC API queries."""
    from pyproj import Transformer

    t = Transformer.from_crs(3006, 4326, always_xy=True)
    lon1, lat1 = t.transform(BBOX_3006[0], BBOX_3006[1])
    lon2, lat2 = t.transform(BBOX_3006[2], BBOX_3006[3])
    return (lon1, lat1, lon2, lat2)
