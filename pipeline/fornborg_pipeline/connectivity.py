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

Shipping form (docs/data-formats.md §12, v1.5): bundles carry the **delta**
`connect_raw - dem_raw` rather than the absolute surface. By construction
`connect >= dem`, and the two are *equal* everywhere outside a depression, so the
delta is a mostly-zero grid that deflate-compresses ~10x better than the absolute
one. The app reconstructs `connect = dem + delta` in one pass at load; nothing
about the semantics above changes.
"""

from __future__ import annotations

import heapq
from pathlib import Path

import numpy as np
from affine import Affine

from .clip_dem import DECIMETER_SCALE, Grid, dequantize, dequantize_decimeters, write_grid
from .sites import GridSpec, SiteConfig

WATER_CONNECT_PATH = "water_connect.tif"
#: The §12 shipping form: `connect_raw - dem_raw`, same geometry and scale.
WATER_CONNECT_DELTA_PATH = "water_connect_delta.tif"

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


def quantize_connect(connect_m: np.ndarray, scale: float = DECIMETER_SCALE) -> np.ndarray:
    """Meters -> int16 steps of `scale`, rounding UP (never down; see the module docstring)."""
    raw = np.ceil(np.asarray(connect_m, dtype=np.float64) / scale - CEIL_EPSILON)
    if not np.isfinite(raw).all():
        raise ValueError("non-finite values reached quantization")
    if raw.min() < np.iinfo(np.int16).min or raw.max() > np.iinfo(np.int16).max:
        raise ValueError(
            f"connect levels overflow int16 at scale {scale}: {raw.min()}..{raw.max()}"
        )
    return raw.astype(np.int16)


def quantize_connect_decimeters(connect_m: np.ndarray) -> np.ndarray:
    """Meters -> int16 decimeters — the §7 context-grid encoding."""
    return quantize_connect(connect_m)


def build_connect_grid(dem_raw: np.ndarray, scale: float = DECIMETER_SCALE) -> np.ndarray:
    """int16 DEM -> int16 connect grid at the same `scale`, `connect >= dem` checked.

    The invariant is asserted **after** quantization, against the same quantized
    values the app compares — that is the form the app actually relies on.
    """
    if dem_raw.dtype != np.int16:
        raise ValueError(f"expected the int16 quantized DEM, got {dem_raw.dtype}")
    connect_m = flood_fill_elevation(dequantize(dem_raw, scale))
    connect_raw = quantize_connect(connect_m, scale)
    below = connect_raw < dem_raw
    if below.any():
        worst = int((dem_raw - connect_raw)[below].max())
        raise ValueError(
            f"{int(below.sum())} cells have connect < dem after quantization "
            f"(worst {worst} steps of {scale} m); the app's `connect <= h` test would "
            f"report dry ground as sea-connected"
        )
    return connect_raw


def connect_delta(connect_raw: np.ndarray, dem_raw: np.ndarray) -> np.ndarray:
    """`connect_raw - dem_raw` as int16, with the §12 invariants checked.

    Both inputs are on the *same* quantization lattice (they come from the same
    grid), so the delta is exact: the app's `dem + delta` reconstructs the connect
    surface bit for bit, not approximately.
    """
    if connect_raw.dtype != np.int16 or dem_raw.dtype != np.int16:
        raise ValueError(
            f"expected two int16 grids, got {connect_raw.dtype} and {dem_raw.dtype}"
        )
    if connect_raw.shape != dem_raw.shape:
        raise ValueError(
            f"connect grid {connect_raw.shape} and DEM {dem_raw.shape} must share a geometry"
        )
    # int32 first: `connect - dem` in int16 would wrap silently on a bad input.
    delta = connect_raw.astype(np.int32) - dem_raw.astype(np.int32)
    if delta.min() < 0:
        raise ValueError(
            f"{int((delta < 0).sum())} cells have connect < dem (worst {int(delta.min())} "
            f"steps) — the §7 invariant is broken and the delta would be meaningless"
        )
    if delta.max() > np.iinfo(np.int16).max:
        raise ValueError(f"connect delta overflows int16: max {int(delta.max())} steps")
    return delta.astype(np.int16)


def apply_connect_delta(dem_raw: np.ndarray, delta_raw: np.ndarray) -> np.ndarray:
    """`dem_raw + delta_raw` as int16 — the pipeline-side mirror of the app's §12 load.

    Used by the steps that consume the connect surface (land cover, QA) so they
    work off a delta-encoded bundle exactly as the app does.
    """
    if dem_raw.shape != delta_raw.shape:
        raise ValueError(
            f"DEM {dem_raw.shape} and delta {delta_raw.shape} must share a geometry"
        )
    total = dem_raw.astype(np.int32) + delta_raw.astype(np.int32)
    if total.min() < np.iinfo(np.int16).min or total.max() > np.iinfo(np.int16).max:
        raise ValueError(f"reconstructed connect overflows int16: {total.min()}..{total.max()}")
    return total.astype(np.int16)


def connect_delta_spec(dem_spec: GridSpec, path: str) -> GridSpec:
    """A delta grid's geometry — identical to the DEM grid it is a delta against."""
    return GridSpec(
        name=f"waterConnectDelta_{dem_spec.name}",
        half_extent=dem_spec.half_extent,
        resolution=dem_spec.resolution,
        path=path,
        quant_scale=dem_spec.quant_scale,
    )


def write_connect_delta_grid(
    path: Path,
    delta_raw: np.ndarray,
    transform: Affine,
    cfg: SiteConfig,
    dem_spec: GridSpec,
    asset_path: str,
):
    """Write a §12 delta grid with the §1/§1a encoding of the grid it deltas against.

    `min_elevation`/`max_elevation` on the `Grid` carry the delta's *lift* range in
    meters here, not absolute heights — a delta grid never gets a manifest entry of
    its own (the DEM grid it belongs to is authoritative), so nothing reads them
    except the run log.
    """
    spec = connect_delta_spec(dem_spec, asset_path)
    lift = dequantize(delta_raw, spec.quant_scale)
    grid = Grid(
        spec=spec,
        data=delta_raw,
        transform=transform,
        bounds3006=cfg.bounds3006(spec.half_extent),
        min_elevation=round(float(lift.min()), 2),
        max_elevation=round(float(lift.max()), 2),
        filled_cells=0,
    )
    return write_grid(path, grid)


def read_connect_grid(out_dir: Path, dem_raw: np.ndarray) -> tuple[np.ndarray, Path]:
    """Read a site's connect surface from whichever §7/§12 form the bundle carries.

    Returns `(connect_raw, path_read)`. The §12 delta wins when both exist, which
    is the same precedence the app applies; a bundle with neither raises so the
    caller can tell the user to run the water step.
    """
    from .clip_dem import read_grid  # local: avoids a cycle at module import time

    delta_path = out_dir / WATER_CONNECT_DELTA_PATH
    if delta_path.exists():
        delta_raw, _transform, _bounds = read_grid(delta_path)
        return apply_connect_delta(dem_raw, delta_raw), delta_path
    absolute_path = out_dir / WATER_CONNECT_PATH
    if absolute_path.exists():
        connect_raw, _transform, _bounds = read_grid(absolute_path)
        return connect_raw, absolute_path
    raise FileNotFoundError(
        f"neither {WATER_CONNECT_DELTA_PATH} nor {WATER_CONNECT_PATH} exists in {out_dir}"
    )


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


def ring_connect_delta_path(ring_spec: GridSpec) -> str:
    """The §12 delta file name for a ring's far-water connect grid."""
    return f"water_connect_delta_{ring_spec.name}.tif"


def ring_connect_spec(ring_spec: GridSpec) -> GridSpec:
    """The §11 ring-connect grid's geometry — identical to its ring by construction."""
    return GridSpec(
        name=f"waterConnect_{ring_spec.name}",
        half_extent=ring_spec.half_extent,
        resolution=ring_spec.resolution,
        path=f"water_connect_{ring_spec.name}.tif",
        quant_scale=ring_spec.quant_scale,
    )


def write_ring_connect_grid(
    path: Path,
    connect_raw: np.ndarray,
    transform: Affine,
    cfg: SiteConfig,
    ring_spec: GridSpec,
):
    """Write a §11 far-water connect grid on a ring's geometry and quant scale."""
    spec = ring_connect_spec(ring_spec)
    heights = dequantize(connect_raw, spec.quant_scale)
    grid = Grid(
        spec=spec,
        data=connect_raw,
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
