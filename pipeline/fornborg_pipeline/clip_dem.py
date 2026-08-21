"""Clip, fill, downsample, quantize and write the app's elevation grids.

Everything here is a pure function of arrays + config — no network, no global
state — so the whole encoding path is testable on synthetic fixtures.

Output contract (docs/data-formats.md §1), enforced by `write_grid`:
  * int16, value = height in decimeters (`height_m = raw * 0.1`), no offset
  * no nodata cells and no nodata tag
  * DEFLATE + predictor 2, tiled 512x512, COG layout with overviews
  * CRS tag EPSG:3006, HORIZONTAL ONLY (never the compound EPSG:5845 of the
    source tiles — see the vertical-shift guard below)
  * band metadata SCALE=0.1 for GIS interop (the manifest stays authoritative)

Vertical-datum guard (PLAN.md §2.1): the source COGs declare compound EPSG:5845
(SWEREF 99 TM + RH 2000). Any gdalwarp/WarpedVRT pass with a vertical datum
transform silently adds the ~+23..36 m RH2000 -> ellipsoid geoid shift. This
module therefore never warps: it reads heights as stored and only ever crops,
block-averages and rounds. `check_height_sanity` is the tripwire that catches a
shift if one is ever reintroduced — it aborts; it must never "correct" by offset.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.fill import fillnodata

from .sites import EPSG_HORIZONTAL, GridSpec, SiteConfig

DECIMETER_SCALE = 0.1  # height_m = raw * SCALE
BLOCKSIZE = 512


class VerticalDatumError(RuntimeError):
    """Heights are outside the site's plausible band — likely a geoid shift."""


@dataclass(frozen=True)
class Grid:
    """One finished output grid, ready to write and to describe in the manifest."""

    spec: GridSpec
    data: np.ndarray  # int16 decimeters, row 0 = northernmost
    transform: Affine
    bounds3006: tuple[float, float, float, float]  # (minE, minN, maxE, maxN)
    min_elevation: float  # meters RH 2000, measured from the written values
    max_elevation: float
    filled_cells: int  # nodata cells repaired before quantization

    @property
    def width(self) -> int:
        return int(self.data.shape[1])

    @property
    def height(self) -> int:
        return int(self.data.shape[0])

    def heights_m(self) -> np.ndarray:
        return dequantize_decimeters(self.data)


# --------------------------------------------------------------------------- #
# array primitives
# --------------------------------------------------------------------------- #


def fill_nodata(array: np.ndarray, nodata: float | None, max_search_distance: float = 200.0):
    """Interpolate across nodata cells. Returns (filled float32 array, cells filled).

    Runs BEFORE quantization so the written int16 grid has no nodata at all.
    """
    array = np.asarray(array, dtype=np.float32)
    if nodata is None:
        return array.copy(), 0
    invalid = np.isnan(array) if np.isnan(nodata) else (array == nodata)
    invalid |= ~np.isfinite(array)
    count = int(invalid.sum())
    if count == 0:
        return array.copy(), 0
    if invalid.all():
        raise ValueError("cannot fill nodata: the whole array is nodata")
    filled = fillnodata(
        array.copy(),
        mask=(~invalid).astype(np.uint8),
        max_search_distance=max_search_distance,
        smoothing_iterations=0,
    ).astype(np.float32)
    still_invalid = ~np.isfinite(filled)
    if not np.isnan(nodata):
        still_invalid |= filled == nodata
    if still_invalid.any():
        raise ValueError(
            f"{int(still_invalid.sum())} nodata cells survived fillnodata "
            f"(max_search_distance={max_search_distance}); refusing to ship a grid with holes"
        )
    return filled, count


def crop_to_bounds(
    array: np.ndarray, transform: Affine, bounds: tuple[float, float, float, float]
) -> tuple[np.ndarray, Affine]:
    """Crop to (minE, minN, maxE, maxN). Bounds must be pixel-aligned and inside."""
    if transform.b != 0 or transform.d != 0:
        raise ValueError("rotated/sheared transforms are not supported")
    res_x, res_y = transform.a, -transform.e
    if res_x <= 0 or res_y <= 0:
        raise ValueError("expected a north-up transform with positive pixel size")
    min_e, min_n, max_e, max_n = bounds
    col0 = (min_e - transform.c) / res_x
    row0 = (transform.f - max_n) / res_y
    ncols = (max_e - min_e) / res_x
    nrows = (max_n - min_n) / res_y
    for name, value in (("col0", col0), ("row0", row0), ("ncols", ncols), ("nrows", nrows)):
        if abs(value - round(value)) > 1e-6:
            raise ValueError(f"crop bounds are not pixel-aligned ({name}={value})")
    col0, row0, ncols, nrows = (int(round(v)) for v in (col0, row0, ncols, nrows))
    if col0 < 0 or row0 < 0 or col0 + ncols > array.shape[1] or row0 + nrows > array.shape[0]:
        raise ValueError(
            f"crop bounds {bounds} fall outside the source grid "
            f"({array.shape[1]}x{array.shape[0]} px)"
        )
    out = array[row0 : row0 + nrows, col0 : col0 + ncols]
    return out, Affine(res_x, 0.0, min_e, 0.0, -res_y, max_n)


def downsample_average(array: np.ndarray, factor: int) -> np.ndarray:
    """Block-average by an integer factor (the 1 m -> 2 m context step)."""
    if factor == 1:
        return np.asarray(array, dtype=np.float32)
    if factor < 1 or array.shape[0] % factor or array.shape[1] % factor:
        raise ValueError(f"cannot block-average {array.shape} by factor {factor}")
    h, w = array.shape[0] // factor, array.shape[1] // factor
    return (
        np.asarray(array, dtype=np.float64)
        .reshape(h, factor, w, factor)
        .mean(axis=(1, 3))
        .astype(np.float32)
    )


def quantize_decimeters(heights_m: np.ndarray) -> np.ndarray:
    """Meters -> int16 decimeters (docs/data-formats.md §1). No offset."""
    raw = np.round(np.asarray(heights_m, dtype=np.float64) * (1.0 / DECIMETER_SCALE))
    if not np.isfinite(raw).all():
        raise ValueError("non-finite heights reached quantization")
    if raw.min() < np.iinfo(np.int16).min or raw.max() > np.iinfo(np.int16).max:
        raise ValueError(f"heights overflow int16 decimeters: {raw.min()}..{raw.max()}")
    return raw.astype(np.int16)


def dequantize_decimeters(raw: np.ndarray) -> np.ndarray:
    return np.asarray(raw, dtype=np.float32) * np.float32(DECIMETER_SCALE)


# --------------------------------------------------------------------------- #
# sanity guards
# --------------------------------------------------------------------------- #


def sample_nearest(array: np.ndarray, transform: Affine, e: float, n: float) -> float:
    """Value of the pixel containing (easting, northing)."""
    col = int(np.floor((e - transform.c) / transform.a))
    row = int(np.floor((transform.f - n) / -transform.e))
    col = min(max(col, 0), array.shape[1] - 1)
    row = min(max(row, 0), array.shape[0] - 1)
    return float(array[row, col])


def sample_nearest_many(
    array: np.ndarray, transform: Affine, e: np.ndarray, n: np.ndarray
) -> np.ndarray:
    """Vectorized `sample_nearest` for point sets (shoreline boundary sampling)."""
    col = np.floor((np.asarray(e, dtype=np.float64) - transform.c) / transform.a).astype(np.int64)
    row = np.floor((transform.f - np.asarray(n, dtype=np.float64)) / -transform.e).astype(np.int64)
    np.clip(col, 0, array.shape[1] - 1, out=col)
    np.clip(row, 0, array.shape[0] - 1, out=row)
    return array[row, col]


def check_height_sanity(
    heights_m: np.ndarray, transform: Affine, cfg: SiteConfig, label: str
) -> float:
    """Abort if the heights look geoid-shifted. Returns the center height (m).

    This is a hard gate, not a correction: a failure means a vertical datum
    transform crept into the pipeline (PLAN.md §2.1) and the fix is to remove it,
    never to subtract an offset.
    """
    lo, hi = cfg.elevation_range
    zmin, zmax = float(np.min(heights_m)), float(np.max(heights_m))
    if zmin < lo or zmax > hi:
        raise VerticalDatumError(
            f"{label}: height range {zmin:.2f}..{zmax:.2f} m leaves the plausible band "
            f"[{lo}, {hi}] m RH 2000 for site {cfg.id!r}. This is the signature of the "
            f"EPSG:5845 vertical-datum bug (RH2000 -> ellipsoid, ~+23..36 m): some step "
            f"warped the data instead of reading it as stored (PLAN.md §2.1). Fix the "
            f"read path — do NOT offset the values."
        )
    center = sample_nearest(heights_m, transform, cfg.center_e, cfg.center_n)
    clo, chi = cfg.center_height_range
    if not (clo <= center <= chi):
        raise VerticalDatumError(
            f"{label}: height at the site center (E {cfg.center_e:.0f}, N {cfg.center_n:.0f}) "
            f"is {center:.2f} m, outside the expected [{clo}, {chi}] m for site {cfg.id!r}. "
            f"Either the grid is vertically shifted (EPSG:5845 geoid-shift bug, PLAN.md §2.1) "
            f"or it is centered on the wrong place. Abort — do NOT offset the values."
        )
    return center


# --------------------------------------------------------------------------- #
# the grid build
# --------------------------------------------------------------------------- #


def build_grid(
    source: np.ndarray,
    source_transform: Affine,
    spec: GridSpec,
    cfg: SiteConfig,
    filled_cells: int = 0,
) -> Grid:
    """Crop -> block-average -> quantize one output grid from a filled source mosaic.

    `source` must already be nodata-free (see `fill_nodata`).
    """
    bounds = cfg.bounds3006(spec.half_extent)
    cropped, cropped_transform = crop_to_bounds(source, source_transform, bounds)

    ratio = spec.resolution / cfg.source_resolution
    factor = int(round(ratio))
    if abs(ratio - factor) > 1e-9 or factor < 1:
        raise ValueError(
            f"grid {spec.name}: resolution {spec.resolution} m is not an integer multiple "
            f"of the source resolution {cfg.source_resolution} m"
        )
    reduced = downsample_average(cropped, factor)
    transform = Affine(spec.resolution, 0.0, bounds[0], 0.0, -spec.resolution, bounds[3])

    if reduced.shape != (spec.size, spec.size):
        raise ValueError(
            f"grid {spec.name}: got {reduced.shape[1]}x{reduced.shape[0]} px, "
            f"expected {spec.size}x{spec.size}"
        )

    raw = quantize_decimeters(reduced)
    heights = dequantize_decimeters(raw)
    check_height_sanity(heights, transform, cfg, f"grid {spec.name}")

    return Grid(
        spec=spec,
        data=raw,
        transform=transform,
        bounds3006=bounds,
        min_elevation=round(float(heights.min()), 1),
        max_elevation=round(float(heights.max()), 1),
        filled_cells=filled_cells,
    )


def build_grids(
    source: np.ndarray, source_transform: Affine, nodata: float | None, cfg: SiteConfig
) -> dict[str, Grid]:
    """Full array path: fill nodata once, then derive every grid in the site config."""
    filled, filled_cells = fill_nodata(source, nodata)
    return {
        spec.name: build_grid(filled, source_transform, spec, cfg, filled_cells)
        for spec in cfg.grids
    }


def grid_bounds(shape: tuple[int, int], transform: Affine) -> tuple[float, float, float, float]:
    """(minE, minN, maxE, maxN) covered by a north-up grid of this shape."""
    height, width = shape
    min_e, max_n = transform.c, transform.f
    return (min_e, max_n - height * -transform.e, min_e + width * transform.a, max_n)


def read_grid(path: Path) -> tuple[np.ndarray, Affine, tuple[float, float, float, float]]:
    """Read a committed grid back as (int16 decimeters, transform, bounds3006).

    The counterpart of `write_grid`: the water steps run against the *committed*
    COGs, so a rebuild of the water assets never needs the Lantmäteriet fetch path.
    """
    with rasterio.open(path) as src:
        if src.count != 1:
            raise ValueError(f"{path}: expected a single-band grid, got {src.count} bands")
        if src.dtypes[0] != "int16":
            raise ValueError(f"{path}: expected int16 decimeters, got {src.dtypes[0]}")
        data = src.read(1)
        transform = src.transform
    return data, transform, grid_bounds(data.shape, transform)


def write_grid(path: Path, grid: Grid) -> Path:
    """Write one grid as a COG per docs/data-formats.md §1."""
    if grid.data.dtype != np.int16:
        raise ValueError(f"expected int16 data, got {grid.data.dtype}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="COG",
        width=grid.width,
        height=grid.height,
        count=1,
        dtype="int16",
        # Horizontal only. Never a compound/vertical CRS (PLAN.md §2.1).
        crs=CRS.from_epsg(EPSG_HORIZONTAL),
        transform=grid.transform,
        compress="DEFLATE",
        predictor="YES",  # -> PREDICTOR=2 (horizontal differencing) for integer data
        blocksize=BLOCKSIZE,
        overview_resampling="average",
        # No `nodata=`: the contract says the committed file carries no nodata tag.
    ) as dst:
        dst.write(grid.data, 1)
        dst.update_tags(1, SCALE=str(DECIMETER_SCALE))
    return path


def write_class_grid(path: Path, data: np.ndarray, transform: Affine) -> Path:
    """Write a uint8 class-index raster as a COG per docs/data-formats.md §9.

    The same COG machinery as `write_grid` — DEFLATE + predictor 2, 512x512 tiles,
    EPSG:3006 horizontal only, no nodata — with three deliberate differences:

      * **uint8** class indices instead of int16 decimeters;
      * **no `SCALE` tag**: an index is a label, not a measurement, and a GIS that
        multiplied it by 0.1 would be lying;
      * **nearest** overview resampling — averaging class indices would invent
        classes that no rule produced.

    Everything else matches the elevation grids byte-for-byte in profile terms, so
    a class raster on the context geometry passes the same identical-profile check
    the water grid does (`landcover._check_context_profile`).
    """
    data = np.asarray(data)
    if data.dtype != np.uint8:
        raise ValueError(f"expected uint8 class indices, got {data.dtype}")
    if data.ndim != 2:
        raise ValueError(f"expected a 2D class raster, got shape {data.shape}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="COG",
        width=int(data.shape[1]),
        height=int(data.shape[0]),
        count=1,
        dtype="uint8",
        crs=CRS.from_epsg(EPSG_HORIZONTAL),
        transform=transform,
        compress="DEFLATE",
        predictor="YES",  # -> PREDICTOR=2, as for the integer elevation grids
        blocksize=BLOCKSIZE,
        overview_resampling="nearest",
        # No `nodata=`: contract §9 says every cell is classified.
    ) as dst:
        dst.write(data, 1)
    return path
