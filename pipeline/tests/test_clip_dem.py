"""Encoding-path tests on synthetic fixtures — no network, no real data."""

from __future__ import annotations

import numpy as np
import pyproj
import pytest
import rasterio
from affine import Affine
from conftest import NODATA, NODATA_HOLES, NODATA_SPECKLES, analytic_surface

from fornborg_pipeline import clip_dem
from fornborg_pipeline.clip_dem import (
    DECIMETER_SCALE,
    VerticalDatumError,
    build_grid,
    build_grids,
    check_height_sanity,
    crop_to_bounds,
    dequantize_decimeters,
    downsample_average,
    fill_nodata,
    quantize_decimeters,
    sample_nearest,
    write_grid,
)


def _expected_hole_count() -> int:
    mask = np.zeros((400, 400), dtype=bool)
    for rows, cols in NODATA_HOLES:
        mask[rows, cols] = True
    for r, c in NODATA_SPECKLES:
        mask[r, c] = True
    return int(mask.sum())


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #


def test_grid_sizes_transforms_and_bounds(fake_site, fake_source_clean):
    source, transform, nodata = fake_source_clean
    grids = build_grids(source, transform, nodata, fake_site)

    core, context = grids["core"], grids["context"]
    assert (core.width, core.height) == (200, 200)
    assert (context.width, context.height) == (200, 200)

    assert core.bounds3006 == (99900.0, 5999900.0, 100100.0, 6000100.0)
    assert context.bounds3006 == (99800.0, 5999800.0, 100200.0, 6000200.0)

    assert core.transform == Affine(1.0, 0.0, 99900.0, 0.0, -1.0, 6000100.0)
    assert context.transform == Affine(2.0, 0.0, 99800.0, 0.0, -2.0, 6000200.0)

    # width == (maxE - minE) / resolution, exactly.
    for grid in (core, context):
        min_e, min_n, max_e, max_n = grid.bounds3006
        assert grid.width == (max_e - min_e) / grid.spec.resolution
        assert grid.height == (max_n - min_n) / grid.spec.resolution

    # core lies strictly inside context
    assert context.bounds3006[0] < core.bounds3006[0]
    assert context.bounds3006[1] < core.bounds3006[1]
    assert core.bounds3006[2] < context.bounds3006[2]
    assert core.bounds3006[3] < context.bounds3006[3]


def test_crop_is_the_right_window(fake_site, fake_source_clean):
    source, transform, _ = fake_source_clean
    cropped, cropped_transform = crop_to_bounds(source, transform, fake_site.bounds3006(100.0))
    assert cropped.shape == (200, 200)
    np.testing.assert_array_equal(cropped, source[100:300, 100:300])
    assert cropped_transform == Affine(1.0, 0.0, 99900.0, 0.0, -1.0, 6000100.0)


def test_crop_rejects_unaligned_and_out_of_range(fake_site, fake_source_clean):
    source, transform, _ = fake_source_clean
    with pytest.raises(ValueError, match="not pixel-aligned"):
        crop_to_bounds(source, transform, (99900.5, 5999900.0, 100100.5, 6000100.0))
    with pytest.raises(ValueError, match="outside the source grid"):
        crop_to_bounds(source, transform, (99000.0, 5999900.0, 100100.0, 6000100.0))


def test_downsample_average_is_a_block_mean():
    a = np.arange(16, dtype=np.float32).reshape(4, 4)
    out = downsample_average(a, 2)
    assert out.shape == (2, 2)
    np.testing.assert_allclose(out, [[2.5, 4.5], [10.5, 12.5]])
    np.testing.assert_array_equal(downsample_average(a, 1), a)
    with pytest.raises(ValueError):
        downsample_average(a, 3)


# --------------------------------------------------------------------------- #
# encoding
# --------------------------------------------------------------------------- #


def test_int16_decimeter_roundtrip_within_5_cm(fake_site, fake_source_clean):
    source, transform, nodata = fake_source_clean
    grids = build_grids(source, transform, nodata, fake_site)

    core_ref = source[100:300, 100:300]
    core_back = grids["core"].heights_m()
    assert np.max(np.abs(core_back - core_ref)) <= 0.05

    context_ref = downsample_average(source, 2)
    context_back = grids["context"].heights_m()
    assert np.max(np.abs(context_back - context_ref)) <= 0.05


def test_quantization_is_plain_decimeters_no_offset():
    heights = np.array([[0.0, 1.24, 1.26, -3.05, 57.34]], dtype=np.float32)
    raw = quantize_decimeters(heights)
    assert raw.dtype == np.int16
    np.testing.assert_array_equal(raw, [[0, 12, 13, -30, 573]])
    np.testing.assert_allclose(dequantize_decimeters(raw), raw * DECIMETER_SCALE, atol=1e-6)


def test_quantization_rejects_int16_overflow():
    with pytest.raises(ValueError, match="overflow int16"):
        quantize_decimeters(np.array([[4000.0]], dtype=np.float32))


def test_measured_min_max_match_the_written_values(fake_site, fake_source_clean):
    source, transform, nodata = fake_source_clean
    for grid in build_grids(source, transform, nodata, fake_site).values():
        heights = grid.heights_m()
        assert grid.min_elevation == pytest.approx(float(heights.min()), abs=0.05)
        assert grid.max_elevation == pytest.approx(float(heights.max()), abs=0.05)
        assert -10.0 <= grid.min_elevation <= grid.max_elevation <= 200.0


# --------------------------------------------------------------------------- #
# nodata
# --------------------------------------------------------------------------- #


def test_fill_nodata_repairs_every_hole(fake_site, fake_source):
    holed, _transform, nodata, pristine = fake_source
    filled, count, _stats = fill_nodata(holed, nodata)
    assert count == _expected_hole_count()
    assert not (filled == nodata).any()
    assert np.isfinite(filled).all()
    # Interpolated values stay in the neighbourhood of the true surface.
    assert np.max(np.abs(filled - pristine)) < 3.0


def test_no_nodata_reaches_the_output_grids(fake_site, fake_source):
    holed, transform, nodata, _ = fake_source
    grids = build_grids(holed, transform, nodata, fake_site)
    for grid in grids.values():
        heights = grid.heights_m()
        assert np.isfinite(heights).all()
        assert not (heights == nodata).any()
        assert heights.min() > fake_site.elevation_range[0]
    assert grids["core"].filled_cells == _expected_hole_count()


def test_fill_nodata_is_a_noop_without_holes(fake_site, fake_source_clean):
    source, _transform, nodata = fake_source_clean
    filled, count, _stats = fill_nodata(source, nodata)
    assert count == 0
    np.testing.assert_array_equal(filled, source)


# --------------------------------------------------------------------------- #
# the vertical-datum guard (PLAN.md §2.1)
# --------------------------------------------------------------------------- #


def test_vshift_guard_trips_on_a_25_m_offset(fake_site, fake_source_clean):
    """+25 m is the RH2000 -> ellipsoid geoid shift's signature at this latitude."""
    source, transform, nodata = fake_source_clean
    shifted = source + 25.0  # center height 50 -> 75, outside the site's [40, 60] band
    with pytest.raises(VerticalDatumError) as excinfo:
        build_grids(shifted, transform, nodata, fake_site)
    message = str(excinfo.value)
    assert "site center" in message
    assert "do NOT offset" in message


def test_vshift_guard_trips_on_an_absurd_range(fake_site, fake_source_clean):
    source, transform, nodata = fake_source_clean
    with pytest.raises(VerticalDatumError, match="plausible band"):
        build_grids(source + 200.0, transform, nodata, fake_site)


def test_vshift_guard_passes_on_unshifted_data(fake_site, fake_source_clean):
    source, transform, nodata = fake_source_clean
    grids = build_grids(source, transform, nodata, fake_site)
    core = grids["core"]
    center = sample_nearest(core.heights_m(), core.transform, fake_site.center_e, fake_site.center_n)
    assert 49.0 <= center <= 50.1  # the analytic peak is 50 m at the exact center


def test_check_height_sanity_returns_the_center_height(fake_site):
    heights, transform = analytic_surface(fake_site)
    center = check_height_sanity(heights, transform, fake_site, "unit")
    assert center == pytest.approx(50.0, abs=0.2)


# --------------------------------------------------------------------------- #
# the written GeoTIFFs
# --------------------------------------------------------------------------- #


@pytest.fixture
def written_grids(tmp_path, fake_site, fake_source):
    holed, transform, nodata, _ = fake_source
    grids = build_grids(holed, transform, nodata, fake_site)
    return {
        name: (write_grid(tmp_path / grid.spec.path, grid), grid) for name, grid in grids.items()
    }


def test_written_files_have_the_contract_profile(written_grids):
    for name, (path, grid) in written_grids.items():
        with rasterio.open(path) as src:
            assert src.count == 1
            assert src.dtypes[0] == "int16"
            assert (src.width, src.height) == (grid.width, grid.height)
            assert src.transform == grid.transform
            assert src.bounds.left == grid.bounds3006[0]
            assert src.bounds.bottom == grid.bounds3006[1]
            assert src.bounds.right == grid.bounds3006[2]
            assert src.bounds.top == grid.bounds3006[3]
            # No nodata tag and no nodata values (docs/data-formats.md §1).
            assert src.nodata is None, f"{name} must not carry a nodata tag"
            data = src.read(1)
            assert not (data == NODATA).any()
            np.testing.assert_array_equal(data, grid.data)

            profile = src.profile
            assert profile["compress"].lower() == "deflate"
            # §1a (v1.5): bundles ship the striped, overview-free web layout.
            assert profile["tiled"] is False
            assert profile["blockysize"] == min(clip_dem.WEB_ROWS_PER_STRIP, grid.height)
            assert src.overviews(1) == []
            structure = src.tags(ns="IMAGE_STRUCTURE")
            assert structure.get("COMPRESSION") == "DEFLATE"
            assert structure.get("PREDICTOR") == "2"
            assert structure.get("LAYOUT") is None  # not a COG any more
            assert src.tags(1).get("SCALE") == "0.1"


def test_archival_layout_still_writes_a_tiled_cog_with_overviews(tmp_path, written_grids):
    """§1a: `LAYOUT_COG` keeps the pre-v1.5 archival file for GIS inspection."""
    _path, grid = written_grids["context"]
    archival = write_grid(tmp_path / "archival.tif", grid, layout=clip_dem.LAYOUT_COG)
    with rasterio.open(archival) as src:
        assert src.profile["tiled"] is True
        assert src.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
        # (This fixture is smaller than one COG block, so it gets no overview
        # pyramid — the real 2000x2000 grids do. Tiling is the testable part.)
        # Same samples, same georeferencing — only the container differs.
        np.testing.assert_array_equal(src.read(1), grid.data)
        assert src.transform == grid.transform
        assert src.crs.to_epsg() == 3006


def test_web_layout_is_smaller_than_the_archival_cog(tmp_path, written_grids):
    """The whole point of §1a: overviews + tiling are ~a third of every shipped byte."""
    web_path, grid = written_grids["context"]
    archival = write_grid(tmp_path / "archival.tif", grid, layout=clip_dem.LAYOUT_COG)
    assert web_path.stat().st_size < archival.stat().st_size


def test_unknown_layout_is_rejected(tmp_path, written_grids):
    _path, grid = written_grids["core"]
    with pytest.raises(ValueError, match="unknown grid layout"):
        write_grid(tmp_path / "nope.tif", grid, layout="tiled-cog-with-sprinkles")


def test_written_crs_is_horizontal_epsg3006_only(written_grids):
    for _name, (path, _grid) in written_grids.items():
        with rasterio.open(path) as src:
            assert src.crs is not None
            assert src.crs.to_epsg() == 3006
            crs = pyproj.CRS.from_user_input(src.crs.to_wkt())
            assert not crs.is_compound, "a compound/vertical CRS invites the EPSG:5845 bug"
            assert not crs.is_vertical
            assert len(crs.axis_info) == 2
            assert all(ax.unit_name == "metre" for ax in crs.axis_info)


def test_written_row0_is_the_northernmost_row(written_grids):
    """docs/data-formats.md §1: row 0 = northernmost, columns west -> east."""
    path, grid = written_grids["core"]
    with rasterio.open(path) as src:
        data = src.read(1)
        # Sampling row 0 / col 0 must land at the NW corner pixel center.
        e, n = src.xy(0, 0)
        assert e == pytest.approx(grid.bounds3006[0] + 0.5 * grid.spec.resolution)
        assert n == pytest.approx(grid.bounds3006[3] - 0.5 * grid.spec.resolution)
        # The synthetic hill peaks at the middle row, not at row 0.
        assert data[grid.height // 2].max() > data[0].max()


def test_output_file_sizes_are_small(written_grids):
    total = sum(path.stat().st_size for path, _ in written_grids.values())
    assert total < 1_000_000  # 200x200 int16 deflate; the real 2000x2000 pair is ~4-10 MB


# --------------------------------------------------------------------------- #
# per-grid quantization scales (contract §11)
# --------------------------------------------------------------------------- #

from fornborg_pipeline.clip_dem import ALLOWED_SCALES, dequantize, quantize


def test_allowed_scales_match_the_contract():
    assert ALLOWED_SCALES == (0.1, 0.5, 1.0)


@pytest.mark.parametrize("scale", [0.5, 1.0])
def test_ring_scale_roundtrip_within_half_a_step(scale):
    rng = np.random.default_rng(11)
    values = (200.0 * rng.random(10_000) - 20.0).astype(np.float32)
    raw = quantize(values, scale)
    assert raw.dtype == np.int16
    back = dequantize(raw, scale)
    assert float(np.abs(back - values).max()) <= scale / 2 + 1e-3


def test_decimeter_wrappers_are_scale_0_1():
    values = np.array([12.34, -3.21], dtype=np.float32)
    assert np.array_equal(quantize(values, 0.1), quantize_decimeters(values))
    raw = quantize_decimeters(values)
    assert np.allclose(dequantize(raw, 0.1), dequantize_decimeters(raw))


def test_quantize_rejects_overflow_at_each_scale():
    # 20 km is fine in 1.0 m steps but overflows int16 at 0.5 m steps.
    tall = np.array([20000.0])
    quantize(tall, 1.0)
    with pytest.raises(ValueError, match="overflow"):
        quantize(tall, 0.5)
    with pytest.raises(ValueError, match="positive"):
        quantize(tall, 0.0)


def test_written_ring_grid_carries_its_scale_tag(fake_site, tmp_path):
    from affine import Affine as _Affine

    from fornborg_pipeline.sites import GridSpec

    spec = GridSpec("ring3", half_extent=400.0, resolution=4.0, path="dem_ring3.tif",
                    quant_scale=0.5)
    west, _s, _e, north = fake_site.bounds3006(spec.half_extent)
    transform = _Affine(spec.resolution, 0.0, west, 0.0, -spec.resolution, north)
    source = np.full((spec.size, spec.size), 20.0, dtype=np.float32)
    grid = build_grid(source, transform, spec, fake_site, source_resolution=spec.resolution)
    path = write_grid(tmp_path / spec.path, grid)
    with rasterio.open(path) as src:
        assert src.tags(1)["SCALE"] == "0.5"
        assert src.dtypes[0] == "int16"


# ------------- nodata in a ground model: water vs. a hole to fill -------------


def coastal_source(size=200, sea_cols=120, nodata=NODATA):
    """Land in the west, sea (no ground returns) in the east — a coastal window."""
    rows, cols = np.mgrid[0:size, 0:size]
    array = (2.0 + 0.05 * (size - cols)).astype(np.float32)
    array[:, sea_cols:] = nodata
    # ...with the shore itself at about sea level, as a real coastline is.
    array[:, sea_cols - 6 : sea_cols] = 0.4
    return array


def test_sea_is_filled_at_sea_level_not_interpolated():
    """Interpolating a 4x4 km stretch of Baltic would invent terrain from nothing."""
    source = coastal_source()
    # The sea here is 80 cells wide, so the search distance is set below it: the
    # rule is "anything fillnodata can reach across is a hole", and a real
    # coastal window is thousands of cells of water, not eighty.
    filled, count, _stats = fill_nodata(source, NODATA, max_search_distance=20.0)
    assert count == int((source == NODATA).sum())
    sea = filled[:, 130:]
    assert np.allclose(sea, 0.0), "open water must be flat at sea level"
    # And the land is untouched.
    np.testing.assert_allclose(filled[:, :100], source[:, :100])


def test_an_enclosed_hole_is_still_interpolated():
    source = np.full((60, 60), 20.0, dtype=np.float32)
    source[28:32, 28:32] = NODATA
    filled, count, _stats = fill_nodata(source, NODATA)
    assert count == 16
    # Interpolated from its surroundings, not zeroed.
    assert np.allclose(filled[28:32, 28:32], 20.0)
    assert not (filled == 0.0).any()


def test_a_hole_and_the_sea_in_one_grid_get_different_treatment():
    source = coastal_source()
    source[10:14, 10:14] = NODATA  # a pond inland
    filled, _count, _stats = fill_nodata(source, NODATA, max_search_distance=20.0)
    assert np.allclose(filled[:, 130:], 0.0)  # sea
    assert filled[10:14, 10:14].min() > 1.0  # the pond took its neighbours' height


def test_land_beyond_the_tile_set_is_refused_not_zeroed():
    """§2b: filling foreign terrain at 0 m is the false flat horizon we must not ship."""
    source = np.full((80, 80), 300.0, dtype=np.float32)
    source[:, 50:] = NODATA  # beyond the border, and the Swedish side is high
    with pytest.raises(ValueError, match="false flat horizon"):
        fill_nodata(source, NODATA, max_search_distance=10.0)


def test_a_grid_with_no_nodata_is_returned_unchanged():
    source = np.full((20, 20), 12.0, dtype=np.float32)
    filled, count, _stats = fill_nodata(source, NODATA)
    assert count == 0
    np.testing.assert_array_equal(filled, source)


def test_an_all_nodata_grid_is_refused():
    with pytest.raises(ValueError, match="whole array is nodata"):
        fill_nodata(np.full((10, 10), NODATA, dtype=np.float32), NODATA)


def test_the_sea_fill_survives_quantization_as_zero():
    """The written int16 grid must read 0 dm over water, not a nodata sentinel."""
    filled, _count, _stats = fill_nodata(coastal_source(), NODATA, max_search_distance=20.0)
    raw = quantize_decimeters(filled)
    assert raw[:, 130:].max() == 0 and raw[:, 130:].min() == 0


def test_a_one_pixel_edge_sliver_is_interpolated_not_classified():
    """The regression that broke four pilot sites' rings.

    A windowed read can leave a one- or two-pixel nodata border along a grid
    edge. It is edge-connected and bordered by whatever land is there — 70 m up,
    at one of the sites — so a naive classifier calls it terrain beyond the
    border and refuses the whole ring. It is an artifact two cells wide sitting
    next to valid data, and interpolating it is exactly right.
    """
    source = np.full((300, 300), 70.0, dtype=np.float32)
    source[0, :] = NODATA
    source[:, -2:] = NODATA
    filled, count, _stats = fill_nodata(source, NODATA)
    assert count == 300 + 600 - 2
    assert np.allclose(filled, 70.0)
    assert not (filled == 0.0).any(), "an edge sliver must not be zeroed as if it were sea"


def test_a_wide_region_is_still_classified_even_when_edge_connected():
    """The narrowness escape hatch must not swallow the case it exists beside."""
    source = np.full((600, 600), 250.0, dtype=np.float32)
    source[:, 300:] = NODATA  # 300 cells wide: beyond any sane search distance
    with pytest.raises(ValueError, match="false flat horizon"):
        fill_nodata(source, NODATA, max_search_distance=200.0)


def test_a_still_water_body_is_filled_flat_not_tented():
    """An enclosed nodata region too wide to interpolate is a lake, not a hole.

    `fillnodata` cannot reach the middle of it, and if it could it would tent
    the surface upward. A ground model returns nothing over water; the surface
    is flat at the height of the shore around it.
    """
    source = np.full((400, 400), 60.0, dtype=np.float32)
    source[100:300, 100:300] = NODATA  # 200 cells across, enclosed by land at 60 m
    filled, count, stats = fill_nodata(source, NODATA, max_search_distance=20.0)
    assert count == 200 * 200
    assert stats["stillWater"] == 200 * 200
    assert stats["interpolated"] == 0
    assert np.allclose(filled[100:300, 100:300], 60.0)
    assert filled[200, 200] == pytest.approx(60.0)  # flat in the middle, not tented


def test_the_repair_breakdown_separates_water_from_invention():
    """The QA gate keys off `interpolated`: only that invents terrain."""
    source = coastal_source()
    source[10:14, 10:14] = NODATA
    _filled, count, stats = fill_nodata(source, NODATA, max_search_distance=20.0)
    assert stats["total"] == count
    assert stats["seaFilled"] > 0
    assert stats["interpolated"] == 16  # just the pond
    assert stats["seaFilled"] + stats["stillWater"] + stats["interpolated"] == count
