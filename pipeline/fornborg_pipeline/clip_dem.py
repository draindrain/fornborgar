"""Clip, fill, downsample, quantize and write the app's elevation grids.

Everything here is a pure function of arrays + config — no network, no global
state — so the whole encoding path is testable on synthetic fixtures.

Output contract (docs/data-formats.md §1), enforced by `write_grid`:
  * int16, value = height in decimeters (`height_m = raw * 0.1`), no offset
  * no nodata cells and no nodata tag
  * DEFLATE + predictor 2, **no tiling and no overviews** (v1.5 §1a: the app
    reads full resolution only, so the 512x512 tile grid and the overview
    pyramid were ~35 % of every shipped byte). `LAYOUT_COG` still writes the
    archival COG — for GIS inspection, into `data-cache/`, never into a bundle.
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

DECIMETER_SCALE = 0.1  # height_m = raw * SCALE (core/context; rings carry their own)

# Grid layouts (docs/data-formats.md §1a, v1.5). Same pixels, same CRS, same
# band metadata in both — they differ only in what a reader has to skip past.
#: Shipped in bundles: striped, full resolution only, no overview pyramid.
LAYOUT_WEB = "web"
#: Archival: the pre-v1.5 tiled COG with overviews, for GIS inspection.
LAYOUT_COG = "cog"
LAYOUTS = (LAYOUT_WEB, LAYOUT_COG)
#: DEFLATE level for the web layout. The grids are written once and downloaded
#: many times, so the extra compression time is free where it matters (-14 % vs
#: the default 6 on the real Broborg grids [measured 2026-08-22]).
WEB_ZLEVEL = 9
#: Rows per strip in the web layout. Pinned rather than left to GDAL, which sizes
#: strips by *bytes* and so would give an int16 grid and a uint8 class raster on
#: the same geometry different strip heights — the §7/§9 "identical profile to
#: dem_context.tif" checks compare that. Past ~256 rows the compression ratio is
#: flat (<0.5 % [measured 2026-08-22]).
WEB_ROWS_PER_STRIP = 256
# The quantization steps the contract allows (docs/data-formats.md §11): 0.1 m for
# core/context, 0.5 m for rings 3-5, 1.0 m for rings 6-7.
ALLOWED_SCALES = (0.1, 0.5, 1.0)
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
        return dequantize(self.data, self.spec.quant_scale)


# --------------------------------------------------------------------------- #
# array primitives
# --------------------------------------------------------------------------- #


def fill_nodata(
    array: np.ndarray,
    nodata: float | None,
    max_search_distance: float = 200.0,
    sea_level_m: float = 0.0,
):
    """Repair nodata cells. Returns (filled float32 array, cells filled).

    Runs BEFORE quantization so the written int16 grid has no nodata at all.

    Two different repairs, because nodata means two different things in a
    *ground* model (the same distinction the §11 ring step already makes):

      * a hole **enclosed** by valid data — a pond, a building shadow, a gap in
        the returns — is interpolated across, which is what `fillnodata` is for;
      * a region reaching the grid **edge** whose surrounding land is at shore
        height is **water**. The DTM has no returns there because there is no
        ground. It is filled at sea level, not interpolated: interpolating a
        4x4 km stretch of Baltic would invent terrain out of nothing, and at a
        coastal site that is most of the window.

    A region reaching the edge but bounded by *high* ground is neither, and is
    refused: that is terrain beyond the tile set (another country), and filling
    it at 0 m would render the false flat horizon §2b exists to prevent.
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

    from .qa import classify_region, classify_uncovered

    working = array.copy()
    valid = ~invalid
    regions = classify_uncovered(valid, np.where(valid, array, nodata), nodata=nodata)

    # Sea first, so the interpolation that follows never has to reach across it.
    sea = np.zeros(array.shape, dtype=bool)
    from scipy import ndimage

    labels, _n = ndimage.label(invalid)
    refused = []
    for index, region in enumerate(_relabel(regions, labels, invalid), start=0):
        verdict = classify_region(region["stats"])
        if verdict == "sea":
            sea |= region["mask"]
        elif verdict == "foreign-land":
            refused.append(region["stats"])
    if refused:
        worst = max(refused, key=lambda r: r["cells"])
        raise ValueError(
            f"{worst['cells']} nodata cells reach the grid edge bounded by land at "
            f"{worst.get('boundaryMedianM')} m, not by a shoreline — that is terrain "
            f"outside the tile set, and filling it at {sea_level_m} m would render a "
            f"false flat horizon (docs/national-scaleout.md §2b)"
        )

    sea_cells = int(sea.sum())
    working[sea] = sea_level_m
    remaining = invalid & ~sea
    if remaining.any():
        working = fillnodata(
            working,
            mask=(~remaining).astype(np.uint8),
            max_search_distance=max_search_distance,
            smoothing_iterations=0,
        ).astype(np.float32)
    working = working.astype(np.float32)

    still_invalid = ~np.isfinite(working)
    if not np.isnan(nodata):
        still_invalid |= working == nodata
    if still_invalid.any():
        raise ValueError(
            f"{int(still_invalid.sum())} nodata cells survived fillnodata "
            f"(max_search_distance={max_search_distance}); refusing to ship a grid with holes"
        )
    if sea_cells:
        print(f"  nodata: {sea_cells:,} cells filled at sea level, {count - sea_cells:,} interpolated")
    return working, count


def _relabel(regions: list[dict], labels: np.ndarray, invalid: np.ndarray):
    """Pair each classified region with its mask, in the order `classify_uncovered` used.

    `classify_uncovered` sorts its output biggest-first for reporting, so the
    masks have to be matched back by size and edge-membership rather than by
    position. Matching on cell count is exact here: `ndimage.label` produced
    both, so the counts are the same multiset.
    """
    from scipy import ndimage

    del invalid  # labels already encode it
    sizes = ndimage.sum_labels(np.ones(labels.shape), labels, range(1, labels.max() + 1))
    by_size: dict[int, list[int]] = {}
    for label_index, size in enumerate(sizes, start=1):
        by_size.setdefault(int(size), []).append(label_index)
    paired = []
    for stats in regions:
        candidates = by_size.get(stats["cells"])
        if not candidates:
            continue
        label_index = candidates.pop(0)
        paired.append({"stats": stats, "mask": labels == label_index})
    return paired


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


def quantize(heights_m: np.ndarray, scale: float) -> np.ndarray:
    """Meters -> int16 steps of `scale` meters (docs/data-formats.md §1/§11). No offset."""
    if scale <= 0:
        raise ValueError(f"quantization scale must be positive, got {scale}")
    raw = np.round(np.asarray(heights_m, dtype=np.float64) * (1.0 / scale))
    if not np.isfinite(raw).all():
        raise ValueError("non-finite heights reached quantization")
    if raw.min() < np.iinfo(np.int16).min or raw.max() > np.iinfo(np.int16).max:
        raise ValueError(
            f"heights overflow int16 at scale {scale}: raw {raw.min()}..{raw.max()}"
        )
    return raw.astype(np.int16)


def dequantize(raw: np.ndarray, scale: float) -> np.ndarray:
    return np.asarray(raw, dtype=np.float32) * np.float32(scale)


def quantize_decimeters(heights_m: np.ndarray) -> np.ndarray:
    """Meters -> int16 decimeters — the §1 core/context encoding."""
    return quantize(heights_m, DECIMETER_SCALE)


def dequantize_decimeters(raw: np.ndarray) -> np.ndarray:
    return dequantize(raw, DECIMETER_SCALE)


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
    heights_m: np.ndarray, transform: Affine, cfg: SiteConfig, label: str,
    check_center: bool = True,
) -> float:
    """Abort if the heights look geoid-shifted. Returns the center height (m).

    This is a hard gate, not a correction: a failure means a vertical datum
    transform crept into the pipeline (PLAN.md §2.1) and the fix is to remove it,
    never to subtract an offset. `check_center=False` skips the center-band test
    only — used for the far-field rings, whose coarse block averages sample a
    different "center" than the band was tuned against; the range gate (which is
    what actually catches the geoid shift) always runs.
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
    if not check_center or cfg.center_height_range is None:
        # A registry-driven site has no hand-verified crown height to compare
        # against; the range gate above is what catches a vertical shift.
        return center
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
    source_resolution: float | None = None,
) -> Grid:
    """Crop -> block-average -> quantize one output grid from a filled source mosaic.

    `source` must already be nodata-free (see `fill_nodata`). `source_resolution`
    defaults to the site's 1 m mosaic; ring mosaics arrive pre-decimated at the
    ring's own resolution (factor 1).
    """
    if source_resolution is None:
        source_resolution = cfg.source_resolution
    bounds = cfg.bounds3006(spec.half_extent)
    cropped, cropped_transform = crop_to_bounds(source, source_transform, bounds)

    ratio = spec.resolution / source_resolution
    factor = int(round(ratio))
    if abs(ratio - factor) > 1e-9 or factor < 1:
        raise ValueError(
            f"grid {spec.name}: resolution {spec.resolution} m is not an integer multiple "
            f"of the source resolution {source_resolution} m"
        )
    reduced = downsample_average(cropped, factor)
    transform = Affine(spec.resolution, 0.0, bounds[0], 0.0, -spec.resolution, bounds[3])

    if reduced.shape != (spec.size, spec.size):
        raise ValueError(
            f"grid {spec.name}: got {reduced.shape[1]}x{reduced.shape[0]} px, "
            f"expected {spec.size}x{spec.size}"
        )

    raw = quantize(reduced, spec.quant_scale)
    heights = dequantize(raw, spec.quant_scale)
    check_height_sanity(
        heights, transform, cfg, f"grid {spec.name}",
        check_center=spec.resolution <= cfg.context.resolution,
    )

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


def _open_writer(path: Path, layout: str, width: int, height: int, dtype: str, transform: Affine, *, cog_resampling: str):
    """Open a rasterio dataset for one of the two §1a layouts.

    Both layouts write the same samples with DEFLATE + predictor 2 and the same
    horizontal-only CRS tag. `LAYOUT_WEB` (what bundles ship) is a plain striped
    GeoTIFF at full resolution; `LAYOUT_COG` is the archival tiled COG with an
    overview pyramid, which only `data-cache/` copies use.
    """
    if layout not in LAYOUTS:
        raise ValueError(f"unknown grid layout {layout!r}; expected one of {LAYOUTS}")
    path.parent.mkdir(parents=True, exist_ok=True)
    common = dict(
        width=width,
        height=height,
        count=1,
        dtype=dtype,
        # Horizontal only. Never a compound/vertical CRS (PLAN.md §2.1).
        crs=CRS.from_epsg(EPSG_HORIZONTAL),
        transform=transform,
        compress="DEFLATE",
        # No `nodata=`: the contract says the written file carries no nodata tag.
    )
    if layout == LAYOUT_COG:
        return rasterio.open(
            path,
            "w",
            driver="COG",
            predictor="YES",  # -> PREDICTOR=2 (horizontal differencing) for integer data
            blocksize=BLOCKSIZE,
            overview_resampling=cog_resampling,
            **common,
        )
    return rasterio.open(
        path,
        "w",
        driver="GTiff",
        predictor=2,  # horizontal differencing, as for the COG layout
        tiled=False,  # striped: the app decodes the whole band in one pass
        blockysize=min(WEB_ROWS_PER_STRIP, height),
        zlevel=WEB_ZLEVEL,
        **common,
    )


def write_grid(path: Path, grid: Grid, layout: str = LAYOUT_WEB) -> Path:
    """Write one grid per docs/data-formats.md §1 (+ §1a for the layout)."""
    if grid.data.dtype != np.int16:
        raise ValueError(f"expected int16 data, got {grid.data.dtype}")
    with _open_writer(
        path,
        layout,
        grid.width,
        grid.height,
        "int16",
        grid.transform,
        cog_resampling="average",
    ) as dst:
        dst.write(grid.data, 1)
        dst.update_tags(1, SCALE=str(grid.spec.quant_scale))
    return path


def write_class_grid(path: Path, data: np.ndarray, transform: Affine, layout: str = LAYOUT_WEB) -> Path:
    """Write a uint8 class-index raster per docs/data-formats.md §9.

    The same machinery as `write_grid` — DEFLATE + predictor 2, the §1a layout,
    EPSG:3006 horizontal only, no nodata — with three deliberate differences:

      * **uint8** class indices instead of int16 decimeters;
      * **no `SCALE` tag**: an index is a label, not a measurement, and a GIS that
        multiplied it by 0.1 would be lying;
      * **nearest** overview resampling in the archival layout — averaging class
        indices would invent classes that no rule produced.

    Everything else matches the elevation grids byte-for-byte in profile terms, so
    a class raster on the context geometry passes the same identical-profile check
    the water grid does (`landcover._check_context_profile`).
    """
    data = np.asarray(data)
    if data.dtype != np.uint8:
        raise ValueError(f"expected uint8 class indices, got {data.dtype}")
    if data.ndim != 2:
        raise ValueError(f"expected a 2D class raster, got shape {data.shape}")
    with _open_writer(
        path,
        layout,
        int(data.shape[1]),
        int(data.shape[0]),
        "uint8",
        transform,
        cog_resampling="nearest",
    ) as dst:
        dst.write(data, 1)
    return path
