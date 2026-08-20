"""Sea-connectivity grid: the water level at which each cell first reaches the sea.

Implements docs/data-formats.md §7 (`water_connect.tif`) and PLAN.md §4.5. Pure
array functions — no network, no config — so the whole algorithm is testable on
synthetic fixtures.

`connect(cell)` is the classic **priority-flood** (depression-filling) elevation:
the minimum, over all 4-connected paths from any grid-edge cell to this cell, of
the maximum DEM elevation along the path, floored at the cell's own elevation.
Two properties the app relies on:

  * `connect >= dem` everywhere, so `connect <= h` alone decides "wet and
    sea-connected at level h" — one texture lookup, no second elevation test.
  * cells inside a false basin carry the basin's **spill level**, not their own
    elevation, so they stay dry until the sea actually reaches the sill. Phase 0
    found real ones here (`pipeline/spike/basin_check.py`, PLAN.md §4.5).

Sea entry = every grid-edge cell: the paleo-sea enters through the Långhundraleden
valley, which crosses the 4x4 km extent on both sides.

Why one grid instead of a bitmask per century: sea-connectivity is monotone in the
water level (a connecting path never disappears as the level rises), so the single
`connect` surface encodes the wet set for *every* level, including the app's
interpolated in-between years.

Quantization: the written values are rounded **up** to the next decimeter, never
down — rounding down could let a cell claim connection at a level that does not
actually reach its sill.
"""

from __future__ import annotations

import heapq
from pathlib import Path

import numpy as np
from affine import Affine

from .clip_dem import DECIMETER_SCALE, Grid, dequantize_decimeters, write_grid
from .sites import GridSpec, SiteConfig

WATER_CONNECT_PATH = "water_connect.tif"

# Guard band for the meters -> decimeters ceiling. Inputs are already on the
# decimeter lattice (they come from an int16 dm grid), and float32/float64 round
# trips can land a hair above the exact lattice value; without this a value that
# *is* 8.2 m would ceil to 8.3 dm. 1e-3 dm = 0.1 mm — far below the guard the
# ceiling itself provides (0.05 m) and far above the float error (~6e-5 dm here).
CEIL_EPSILON = 1e-3


def flood_fill_elevation(dem: np.ndarray) -> np.ndarray:
    """Priority-flood `dem` from every grid edge cell. Returns the connect surface.

    Reference implementation (docs/data-formats.md §7): a Dijkstra over the
    *minimax* path cost with a binary heap. Cells are marked as seen when pushed,
    which is safe here because keys are non-decreasing along the pop order: a cell
    pushed later can never carry a lower key than the one it was pushed with.

    O(n log n) in the cell count; ~13 s for the 2000x2000 context grid.
    """
    values = np.asarray(dem)
    if values.ndim != 2 or values.size == 0:
        raise ValueError(f"expected a non-empty 2D grid, got shape {values.shape}")
    if not np.isfinite(values).all():
        raise ValueError("non-finite elevations reached the flood fill")

    height, width = values.shape
    # A flat Python list is several times faster to index than a numpy array in
    # the inner loop, and the heap needs Python scalars anyway.
    flat = values.ravel().tolist()
    n = height * width

    seen = bytearray(n)
    heap: list[tuple[float, int]] = []
    for col in range(width):
        for index in (col, (height - 1) * width + col):
            if not seen[index]:
                seen[index] = 1
                heap.append((flat[index], index))
    for row in range(height):
        for index in (row * width, row * width + width - 1):
            if not seen[index]:
                seen[index] = 1
                heap.append((flat[index], index))
    heapq.heapify(heap)

    out = [0.0] * n
    push, pop = heapq.heappush, heapq.heappop
    while heap:
        spill, index = pop(heap)
        out[index] = spill
        row, col = divmod(index, width)
        if col > 0:
            j = index - 1
            if not seen[j]:
                seen[j] = 1
                z = flat[j]
                push(heap, (z if z > spill else spill, j))
        if col < width - 1:
            j = index + 1
            if not seen[j]:
                seen[j] = 1
                z = flat[j]
                push(heap, (z if z > spill else spill, j))
        if row > 0:
            j = index - width
            if not seen[j]:
                seen[j] = 1
                z = flat[j]
                push(heap, (z if z > spill else spill, j))
        if row < height - 1:
            j = index + width
            if not seen[j]:
                seen[j] = 1
                z = flat[j]
                push(heap, (z if z > spill else spill, j))

    connect = np.asarray(out, dtype=np.float64).reshape(values.shape)
    if (connect < values).any():
        raise ValueError("priority flood produced connect < dem — algorithm bug")
    return connect


def quantize_connect_decimeters(connect_m: np.ndarray) -> np.ndarray:
    """Meters -> int16 decimeters, rounding UP (never down; see the module docstring)."""
    raw = np.ceil(np.asarray(connect_m, dtype=np.float64) / DECIMETER_SCALE - CEIL_EPSILON)
    if not np.isfinite(raw).all():
        raise ValueError("non-finite values reached quantization")
    if raw.min() < np.iinfo(np.int16).min or raw.max() > np.iinfo(np.int16).max:
        raise ValueError(f"connect levels overflow int16 decimeters: {raw.min()}..{raw.max()}")
    return raw.astype(np.int16)


def build_connect_grid(dem_dm: np.ndarray) -> np.ndarray:
    """int16-dm DEM -> int16-dm connect grid, with the `connect >= dem` invariant checked.

    The invariant is asserted **after** quantization, against the same decimeter
    values the app compares — that is the form the app actually relies on.
    """
    if dem_dm.dtype != np.int16:
        raise ValueError(f"expected the int16 decimeter DEM, got {dem_dm.dtype}")
    connect_m = flood_fill_elevation(dequantize_decimeters(dem_dm))
    connect_dm = quantize_connect_decimeters(connect_m)
    below = connect_dm < dem_dm
    if below.any():
        worst = int((dem_dm - connect_dm)[below].max())
        raise ValueError(
            f"{int(below.sum())} cells have connect < dem after quantization "
            f"(worst {worst} dm); the app's `connect <= h` test would report dry ground "
            f"as sea-connected"
        )
    return connect_dm


def connect_grid_spec(cfg: SiteConfig) -> GridSpec:
    """The connect grid's geometry — identical to the context grid by construction."""
    context = cfg.context
    return GridSpec(
        name="waterConnect",
        half_extent=context.half_extent,
        resolution=context.resolution,
        path=WATER_CONNECT_PATH,
    )


def write_connect_grid(path: Path, connect_dm: np.ndarray, transform: Affine, cfg: SiteConfig):
    """Write the connect grid as a COG with the §1 encoding (identical to the DEMs)."""
    spec = connect_grid_spec(cfg)
    heights = dequantize_decimeters(connect_dm)
    grid = Grid(
        spec=spec,
        data=connect_dm,
        transform=transform,
        bounds3006=cfg.bounds3006(spec.half_extent),
        min_elevation=round(float(heights.min()), 1),
        max_elevation=round(float(heights.max()), 1),
        filled_cells=0,
    )
    return write_grid(path, grid)


def basin_stats(dem_dm: np.ndarray, connect_dm: np.ndarray, level_m: float, cell_area_m2: float):
    """False-basin summary at one water level, for the run log.

    Returns (wet_cells, false_basin_cells, largest_component_m2) where a false
    basin cell is below the level but not sea-connected at it.
    """
    from scipy import ndimage  # only needed for the reporting path

    level_dm = round(level_m / DECIMETER_SCALE)
    wet = dem_dm <= level_dm
    excluded = wet & (connect_dm > level_dm)
    labels, count = ndimage.label(excluded)
    largest = int(np.bincount(labels.ravel())[1:].max()) if count else 0
    return int(wet.sum()), int(excluded.sum()), largest * cell_area_m2
