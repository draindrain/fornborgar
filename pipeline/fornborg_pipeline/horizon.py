"""Adaptive horizon-ladder depth: how many far-field rings a site needs.

Implements docs/data-formats.md §11 and docs/national-scaleout.md §2b (owner
decisions 2026-08-21). Pure array functions — no network, no filesystem — so the
whole derivation is testable on synthetic fixtures.

The guarantee is written for the first-person viewpoint on the fort:

    h = (crown + EYE_HEIGHT_M) − floor
    d ≈ 3.83 · √h   [km]     (refraction k = 0.13 folded into the coefficient)

where `crown` is the highest DEM cell inside the site's KMR extent polygon
(fallback: the core grid's maximum) and `floor` is the 5th-percentile elevation
of the 16×16 km (ring4) box, floored at 0 — a sea or large lake drives the
percentile to ~0 by itself. A site always ships ring3+ring4; the ladder extends
while the last ring's half-extent < d, capped at ring7 (64 km radius, covers h
up to ~280 m).
"""

from __future__ import annotations

import math

import numpy as np
from affine import Affine

from .sites import RING_LADDER, GridSpec

# Eye height above the crown used by the guarantee (a standing observer, rounded
# up — the app's first-person camera uses 1.7 m).
EYE_HEIGHT_M = 2.0

# d[km] = 3.83 * sqrt(h[m]) — the refracted-horizon coefficient (k = 0.13).
HORIZON_COEFF_KM = 3.83

# Percentile that defines the surrounding lowland "floor".
FLOOR_PERCENTILE = 5.0


def polygon_mask(ring_en: np.ndarray, transform: Affine, shape: tuple[int, int]) -> np.ndarray:
    """Boolean mask of the grid cells whose centers lie inside a closed polygon.

    `ring_en` is an (N, 2) array of (easting, northing) vertices, open (the
    closing edge is implicit). Even-odd ray casting, vectorized per edge — the
    polygon bounding box is tiny relative to the grid, so only that sub-window
    is evaluated.
    """
    ring = np.asarray(ring_en, dtype=np.float64)
    if ring.ndim != 2 or ring.shape[1] != 2 or ring.shape[0] < 3:
        raise ValueError(f"expected an (N>=3, 2) polygon ring, got shape {ring.shape}")
    if not np.isfinite(ring).all():
        raise ValueError("polygon ring contains non-finite coordinates")

    height, width = shape
    res_x, res_y = transform.a, -transform.e
    # Pixel-center coordinates of the polygon's bounding sub-window.
    col0 = max(0, int(math.floor((ring[:, 0].min() - transform.c) / res_x)) - 1)
    col1 = min(width, int(math.ceil((ring[:, 0].max() - transform.c) / res_x)) + 1)
    row0 = max(0, int(math.floor((transform.f - ring[:, 1].max()) / res_y)) - 1)
    row1 = min(height, int(math.ceil((transform.f - ring[:, 1].min()) / res_y)) + 1)

    mask = np.zeros(shape, dtype=bool)
    if col0 >= col1 or row0 >= row1:
        return mask

    e = transform.c + (np.arange(col0, col1) + 0.5) * res_x
    n = transform.f - (np.arange(row0, row1) + 0.5) * res_y
    ee, nn = np.meshgrid(e, n)

    inside = np.zeros(ee.shape, dtype=bool)
    x0, y0 = ring[:, 0], ring[:, 1]
    x1, y1 = np.roll(x0, -1), np.roll(y0, -1)
    for ax, ay, bx, by in zip(x0, y0, x1, y1):
        if ay == by:
            continue
        crosses = (nn >= min(ay, by)) & (nn < max(ay, by))
        x_at = ax + (nn - ay) * (bx - ax) / (by - ay)
        inside ^= crosses & (ee < x_at)

    mask[row0:row1, col0:col1] = inside
    return mask


def crown_height(
    heights_m: np.ndarray, transform: Affine, ring_en: np.ndarray | None = None
) -> float:
    """Max DEM inside the site extent polygon; the grid max when no polygon exists."""
    heights = np.asarray(heights_m)
    if ring_en is None:
        return float(heights.max())
    mask = polygon_mask(ring_en, transform, heights.shape)
    if not mask.any():
        # A degenerate/out-of-grid polygon must not silently shrink the ladder.
        return float(heights.max())
    return float(heights[mask].max())


def floor_height(ring4_heights_m: np.ndarray) -> float:
    """The surrounding lowland floor: p5 of the 16×16 km box, floored at 0 m."""
    p5 = float(np.percentile(np.asarray(ring4_heights_m, dtype=np.float64), FLOOR_PERCENTILE))
    return max(0.0, p5)


def horizon_distance_m(h_m: float) -> float:
    """Refracted horizon distance (m) for an eye h_m meters above the floor."""
    return HORIZON_COEFF_KM * math.sqrt(max(0.0, h_m)) * 1000.0


def ladder(distance_m: float, rings: tuple[GridSpec, ...] = RING_LADDER) -> tuple[GridSpec, ...]:
    """The ring specs a site ships: always the first two, extended while the
    last ring's half-extent < the horizon distance, capped at the ladder's end."""
    if len(rings) < 2:
        raise ValueError("the ring ladder needs at least ring3 and ring4")
    count = 2
    while count < len(rings) and rings[count - 1].half_extent < distance_m:
        count += 1
    return rings[:count]


def horizon_info(crown_m: float, floor_m: float) -> dict:
    """The informational `manifest.horizon` block (docs/data-formats.md §11)."""
    h = (crown_m + EYE_HEIGHT_M) - floor_m
    return {
        "crownM": round(crown_m, 1),
        "floorM": round(floor_m, 1),
        "eyeM": EYE_HEIGHT_M,
        "distanceKm": round(horizon_distance_m(h) / 1000.0, 1),
    }
