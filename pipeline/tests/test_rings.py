"""Far-field ring build tests (docs/data-formats.md §11). No network.

The decimated read path is exercised against a synthetic tiled COG written to
tmp_path — the same rasterio call `fetch_ring_mosaic` makes over /vsicurl.
"""

from __future__ import annotations

import numpy as np
import pytest
import rasterio
from affine import Affine
from rasterio.crs import CRS

from fornborg_pipeline.clip_dem import Grid, build_grid, dequantize
from fornborg_pipeline.connectivity import (
    build_connect_grid,
    ring_connect_spec,
)
from fornborg_pipeline.fetch_dem import DTM_NODATA, _read_window_decimated
from fornborg_pipeline.rings import ring_processing_steps
from fornborg_pipeline.sites import RING_LADDER, GridSpec

# --------------------------------------------------------------------------- #
# the ladder table itself
# --------------------------------------------------------------------------- #


def test_ring_ladder_matches_the_contract_table():
    assert [s.name for s in RING_LADDER] == ["ring3", "ring4", "ring5", "ring6", "ring7"]
    assert [s.half_extent for s in RING_LADDER] == [4000.0, 8000.0, 16000.0, 32000.0, 64000.0]
    assert [s.resolution for s in RING_LADDER] == [4.0, 8.0, 16.0, 32.0, 64.0]
    assert [s.quant_scale for s in RING_LADDER] == [0.5, 0.5, 0.5, 1.0, 1.0]
    # Every ring is the contract's constant 2000x2000 pixel budget.
    assert all(s.size == 2000 for s in RING_LADDER)
    assert [s.path for s in RING_LADDER] == [f"dem_ring{n}.tif" for n in range(3, 8)]


# --------------------------------------------------------------------------- #
# decimated windowed reads
# --------------------------------------------------------------------------- #


def _write_source_tile(path, west, north, size, res=1.0, nodata_block=None):
    """A synthetic 1 m source tile with a known analytic surface."""
    transform = Affine(res, 0.0, west, 0.0, -res, north)
    cols = west + (np.arange(size) + 0.5) * res
    rows = north - (np.arange(size) + 0.5) * res
    e, n = np.meshgrid(cols, rows)
    z = (20.0 + 0.01 * (e - west) + 0.005 * (n - (north - size * res))).astype(np.float32)
    if nodata_block is not None:
        z[nodata_block] = DTM_NODATA
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=size,
        height=size,
        count=1,
        dtype="float32",
        crs=CRS.from_epsg(3006),
        transform=transform,
        nodata=DTM_NODATA,
        tiled=True,
        blockxsize=64,
        blockysize=64,
    ) as dst:
        dst.write(z, 1)
    return z


def test_decimated_read_is_a_block_mean(tmp_path):
    tile = tmp_path / "tile.tif"
    z = _write_source_tile(tile, west=1000.0, north=2000.0, size=256)
    # Ring lattice anchored at (west=1000, north=2000), 4 m pixels, fully inside.
    result = _read_window_decimated(str(tile), (1000.0, 2000.0 - 256.0, 1000.0 + 256.0, 2000.0), 4.0)
    assert result is not None
    data, (row0, col0), _tile_bounds = result
    assert (row0, col0) == (0, 0)
    assert data.shape == (64, 64)
    expected = z.reshape(64, 4, 64, 4).mean(axis=(1, 3))
    assert np.allclose(data, expected, atol=0.02)


def test_decimated_read_snaps_inward_to_the_ring_lattice(tmp_path):
    tile = tmp_path / "tile.tif"
    _write_source_tile(tile, west=1000.0, north=2000.0, size=256)
    # Ring extends 6 m past the tile on the west: the first whole 4 m ring pixel
    # starts inside the tile, so the tile contributes from ring column 2 on.
    ring_bounds = (994.0, 2000.0 - 256.0, 994.0 + 256.0, 2000.0)
    result = _read_window_decimated(str(tile), ring_bounds, 4.0)
    assert result is not None
    data, (row0, col0), _tile_bounds = result
    assert row0 == 0
    assert col0 == 2  # ceil((1000-994)/4) = 2
    assert data.shape[1] == 62  # floor((1250-994)/4) - 2


def test_decimated_read_averages_are_nodata_aware(tmp_path):
    # The whole coverage/seam design leans on this GDAL behavior: a partially
    # nodata target pixel averages only its valid source cells, and a fully
    # nodata one comes back as the nodata value (never a poisoned average).
    tile = tmp_path / "tile.tif"
    z = _write_source_tile(
        tile, west=0.0, north=256.0, size=256, nodata_block=(slice(0, 4), slice(0, 6))
    )
    result = _read_window_decimated(str(tile), (0.0, 0.0, 256.0, 256.0), 4.0)
    assert result is not None
    data, _origin, _tile_bounds = result
    # Block (0,0) is fully nodata; block (0,1) is half nodata.
    assert data[0, 0] == DTM_NODATA
    block01 = z[0:4, 4:8]
    valid = block01[block01 != DTM_NODATA]
    assert data[0, 1] == pytest.approx(float(valid.mean()), abs=0.02)
    assert data[0, 1] > -100.0


def test_decimated_read_returns_none_without_overlap(tmp_path):
    tile = tmp_path / "tile.tif"
    _write_source_tile(tile, west=0.0, north=256.0, size=256)
    assert _read_window_decimated(str(tile), (5000.0, 5000.0, 6000.0, 6000.0), 4.0) is None


# --------------------------------------------------------------------------- #
# ring grids build at ring scale
# --------------------------------------------------------------------------- #


def test_build_grid_ring_quantizes_at_the_ring_scale(fake_site):
    spec = GridSpec("ring3", half_extent=400.0, resolution=4.0, path="dem_ring3.tif", quant_scale=0.5)
    west, _s, _e, north = fake_site.bounds3006(spec.half_extent)
    transform = Affine(spec.resolution, 0.0, west, 0.0, -spec.resolution, north)
    rng = np.random.default_rng(7)
    source = (30.0 + 10.0 * rng.random((spec.size, spec.size))).astype(np.float32)

    grid = build_grid(source, transform, spec, fake_site, source_resolution=spec.resolution)
    assert grid.data.dtype == np.int16
    # Round-trip error bounded by half the ring's quantization step.
    back = dequantize(grid.data, spec.quant_scale)
    assert float(np.abs(back - source).max()) <= spec.quant_scale / 2 + 1e-3
    # heights_m() dequantizes with the ring's own scale, not 0.1.
    assert np.allclose(grid.heights_m(), back)


def test_build_grid_ring_skips_the_center_band_check(fake_site):
    # A coarse ring whose center block-average sits below the site's 40..60 band
    # must still build — the center-band tripwire is a core/context guard.
    spec = GridSpec("ring3", half_extent=400.0, resolution=4.0, path="dem_ring3.tif", quant_scale=0.5)
    west, _s, _e, north = fake_site.bounds3006(spec.half_extent)
    transform = Affine(spec.resolution, 0.0, west, 0.0, -spec.resolution, north)
    source = np.full((spec.size, spec.size), 20.0, dtype=np.float32)
    grid = build_grid(source, transform, spec, fake_site, source_resolution=spec.resolution)
    assert grid.min_elevation == pytest.approx(20.0)


# --------------------------------------------------------------------------- #
# far-water connect at ring scale
# --------------------------------------------------------------------------- #


def test_ring_connect_spec_mirrors_the_ring():
    spec = ring_connect_spec(RING_LADDER[1])
    assert spec.path == "water_connect_ring4.tif"
    assert spec.half_extent == RING_LADDER[1].half_extent
    assert spec.resolution == RING_LADDER[1].resolution
    assert spec.quant_scale == RING_LADDER[1].quant_scale


def test_build_connect_grid_at_ring_scale_keeps_the_invariant():
    scale = 0.5
    # A rim-enclosed basin: floor below the outside, rim above it.
    dem_m = np.full((20, 20), 2.0)
    dem_m[5:15, 5:15] = 6.0  # rim
    dem_m[8:12, 8:12] = 1.0  # basin floor
    dem_raw = np.round(dem_m / scale).astype(np.int16)
    connect_raw = build_connect_grid(dem_raw, scale=scale)
    assert (connect_raw >= dem_raw).all()
    # Basin cells carry the rim's spill level in the ring's own quantization.
    assert (dequantize(connect_raw, scale)[9, 9]) == pytest.approx(6.0)
    # Open ground connects at its own elevation.
    assert (dequantize(connect_raw, scale)[0, 0]) == pytest.approx(2.0)


# --------------------------------------------------------------------------- #
# provenance seams
# --------------------------------------------------------------------------- #


def test_ring_processing_steps_disclose_the_sea_fill():
    spec = RING_LADDER[0]
    grid = Grid(
        spec=spec,
        data=np.zeros((4, 4), dtype=np.int16),
        transform=Affine(4.0, 0.0, 0.0, 0.0, -4.0, 16.0),
        bounds3006=(0.0, 0.0, 16.0, 16.0),
        min_elevation=0.0,
        max_elevation=0.0,
        filled_cells=0,
    )
    steps = ring_processing_steps([grid], [{"seaFilledCells": 123}])
    assert any("overview" in s for s in steps)
    assert any("123 cells outside tile coverage sea-filled at 0 m" in s for s in steps)
    # No sea-filled cells -> no seam line for that ring.
    steps = ring_processing_steps([grid], [{"seaFilledCells": 0}])
    assert len(steps) == 1
