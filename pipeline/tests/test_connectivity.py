"""Sea-connectivity contract tests (docs/data-formats.md §7). No network.

The false-basin fixture is the whole point of the asset: a plain water plane at
level h floods every cell with `dem <= h`, including depressions that never met the
sea. These tests pin the behaviour the app's shader relies on — `connect <= h` —
against a brute-force flood fill (the `pipeline/spike/basin_check.py` method).
"""

from __future__ import annotations

import numpy as np
import pytest
import rasterio
from scipy import ndimage

from fornborg_pipeline.clip_dem import build_grids, quantize_decimeters, write_grid
from fornborg_pipeline.connectivity import (
    WATER_CONNECT_DELTA_PATH,
    WATER_CONNECT_PATH,
    apply_connect_delta,
    build_connect_grid,
    connect_delta,
    flood_fill_elevation,
    quantize_connect_decimeters,
    read_connect_grid,
    write_connect_delta_grid,
    write_connect_grid,
)

FOUR_CONNECTED = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8)

# False-basin fixture: a 10 m plain, a 30 m rim enclosing a 2 m floor, and one
# 20 m notch cut through the rim — the basin's sill.
PLAIN, RIM, FLOOR, SILL = 10.0, 30.0, 2.0, 20.0
FLOOR_SLICE = (slice(12, 28), slice(12, 28))


def tilted_plane(size: int = 32) -> np.ndarray:
    """A surface with no depressions at all: every cell drains straight to an edge."""
    rows, cols = np.mgrid[0:size, 0:size]
    return (5.0 + 0.3 * rows + 0.2 * cols).astype(np.float64)


def false_basin(size: int = 40) -> np.ndarray:
    dem = np.full((size, size), PLAIN, dtype=np.float64)
    dem[10:30, 10:30] = RIM
    dem[FLOOR_SLICE] = FLOOR
    dem[10:12, 20] = SILL  # notch through the two-cell-thick north rim
    return dem


def rough_terrain(size: int = 64, seed: int = 7) -> np.ndarray:
    """Deterministic lumpy terrain with plenty of enclosed pits."""
    rng = np.random.default_rng(seed)
    field = ndimage.gaussian_filter(rng.normal(size=(size, size)), sigma=2.0)
    field += 0.25 * ndimage.gaussian_filter(rng.normal(size=(size, size)), sigma=0.7)
    field -= field.min()
    return np.round(20.0 * field / field.max(), 1)


def sea_connected(dem: np.ndarray, level: float) -> np.ndarray:
    """Brute-force reference: edge-connected components of the wet set (basin_check.py)."""
    wet = dem <= level
    labels, count = ndimage.label(wet, structure=FOUR_CONNECTED)
    if count == 0:
        return np.zeros_like(wet)
    edge = np.unique(
        np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    )
    return np.isin(labels, edge[edge != 0])


# --------------------------------------------------------------------------- #
# (a) an open surface: the connect grid must not invent anything
# --------------------------------------------------------------------------- #


def test_open_plane_connect_equals_dem():
    dem = tilted_plane()
    assert np.array_equal(flood_fill_elevation(dem), dem)


def test_single_cell_and_thin_grids_are_handled():
    assert flood_fill_elevation(np.array([[4.2]])) == pytest.approx(4.2)
    # Every cell of a one-row grid is a grid-edge cell, so nothing is ever lifted.
    strip = np.array([[3.0, 1.0, 5.0, 1.0, 2.0]])
    assert np.array_equal(flood_fill_elevation(strip), strip)
    # A pit in the middle row spills over the lower of its two rim neighbours.
    pit = np.array([[9.0, 9.0, 9.0], [8.0, 0.0, 7.0], [9.0, 9.0, 9.0]])
    assert flood_fill_elevation(pit)[1, 1] == 7.0


# --------------------------------------------------------------------------- #
# (b) the false basin — the reason this asset exists (PLAN.md §4.5)
# --------------------------------------------------------------------------- #


def test_false_basin_floor_carries_the_sill_level_not_its_own():
    dem = false_basin()
    connect = flood_fill_elevation(dem)

    floor = connect[FLOOR_SLICE]
    assert np.all(floor == SILL), "basin floor must carry the spill level"
    assert np.all(dem[FLOOR_SLICE] == FLOOR)
    assert np.all(connect >= dem)
    # Outside the basin nothing is lifted: the plain drains to the grid edge.
    assert connect[0, 0] == PLAIN
    assert np.all(connect[dem == PLAIN] == PLAIN)


@pytest.mark.parametrize("level", [3.0, 10.0, 15.0, 19.9])
def test_false_basin_stays_dry_below_its_sill(level):
    dem = false_basin()
    connect = flood_fill_elevation(dem)
    wet_naive = dem <= level
    wet_connected = connect <= level

    assert wet_naive[FLOOR_SLICE].all(), "a naive water plane floods the basin"
    assert not wet_connected[FLOOR_SLICE].any(), "the connect grid keeps it dry"


@pytest.mark.parametrize("level", [20.0, 25.0])
def test_false_basin_fills_at_and_above_the_sill(level):
    connect = flood_fill_elevation(false_basin())
    assert (connect <= level)[FLOOR_SLICE].all()


# --------------------------------------------------------------------------- #
# (c) brute-force cross-check against edge-connected flood fill
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "dem_factory", [tilted_plane, false_basin, rough_terrain], ids=["plane", "basin", "rough"]
)
def test_connect_matches_bruteforce_flood_fill(dem_factory):
    dem = dem_factory()
    connect = flood_fill_elevation(dem)
    for level in np.arange(dem.min() - 1.0, dem.max() + 1.0, 0.5):
        assert np.array_equal(connect <= level, sea_connected(dem, level)), (
            f"level {level}: connect <= h disagrees with the edge-connected flood fill"
        )


def test_connect_is_monotone_in_the_level():
    """The wet set only grows with the level — what makes one grid enough for all years."""
    connect = flood_fill_elevation(rough_terrain())
    previous = np.zeros_like(connect, dtype=bool)
    for level in np.arange(0.0, 21.0, 0.5):
        wet = connect <= level
        assert np.all(wet >= previous)
        previous = wet


# --------------------------------------------------------------------------- #
# (d) the written encoding: int16 decimeters, rounded up
# --------------------------------------------------------------------------- #


def test_quantization_rounds_up_but_never_inflates_exact_decimeters():
    values = np.array([[8.2, 8.21, 8.29, 0.0, -1.5]])
    assert np.array_equal(quantize_connect_decimeters(values), np.array([[82, 83, 83, 0, -15]]))


@pytest.mark.parametrize(
    "dem_factory", [tilted_plane, false_basin, rough_terrain], ids=["plane", "basin", "rough"]
)
def test_quantized_connect_never_dips_below_the_quantized_dem(dem_factory):
    dem_dm = quantize_decimeters(dem_factory())
    connect_dm = build_connect_grid(dem_dm)
    assert connect_dm.dtype == np.int16
    assert np.all(connect_dm >= dem_dm)
    # And it still answers the connectivity question correctly, in decimeters.
    dem_m = dem_dm.astype(np.float64) * 0.1
    for level_dm in range(int(dem_dm.min()), int(dem_dm.max()) + 1, 5):
        expected = sea_connected(dem_m, level_dm * 0.1)
        assert np.array_equal(connect_dm <= level_dm, expected)


def test_build_connect_grid_rejects_a_float_dem():
    with pytest.raises(ValueError, match="int16"):
        build_connect_grid(tilted_plane())


def test_written_connect_grid_matches_the_context_grid_profile(tmp_path, fake_site, fake_source):
    holed, transform, nodata, _ = fake_source
    grids = build_grids(holed, transform, nodata, fake_site)
    context = grids["context"]
    dem_path = write_grid(tmp_path / context.spec.path, context)

    connect_dm = build_connect_grid(context.data)
    connect_path = write_connect_grid(
        tmp_path / "water_connect.tif", connect_dm, context.transform, fake_site
    )

    with rasterio.open(dem_path) as ref, rasterio.open(connect_path) as new:
        assert (new.width, new.height) == (ref.width, ref.height)
        assert new.crs == ref.crs == rasterio.crs.CRS.from_epsg(3006)
        assert new.transform == ref.transform
        assert new.bounds == ref.bounds
        assert new.dtypes == ref.dtypes == ("int16",)
        assert new.nodata is None and ref.nodata is None
        assert new.profile["compress"] == ref.profile["compress"] == "deflate"
        # §1a (v1.5): both are the striped, overview-free web layout, and the
        # §7 "identical profile" promise is what pins them to the same strip height.
        assert new.profile["tiled"] is ref.profile["tiled"] is False
        assert new.profile["blockysize"] == ref.profile["blockysize"]
        structure = new.tags(ns="IMAGE_STRUCTURE")
        assert structure == ref.tags(ns="IMAGE_STRUCTURE")
        assert structure["PREDICTOR"] == "2"
        assert new.overviews(1) == ref.overviews(1) == []
        assert np.all(new.read(1) >= ref.read(1))


# ------------------------- v1.5 §12: the delta shipping form -----------------


@pytest.mark.parametrize(
    "dem_factory", [tilted_plane, false_basin, rough_terrain], ids=["plane", "basin", "rough"]
)
def test_delta_roundtrips_the_connect_surface_exactly(dem_factory):
    """§12: `dem + delta` must reconstruct the connect grid bit for bit, not nearly."""
    dem_dm = quantize_decimeters(dem_factory())
    connect_dm = build_connect_grid(dem_dm)

    delta = connect_delta(connect_dm, dem_dm)
    assert delta.dtype == np.int16
    assert delta.min() >= 0  # connect >= dem is what makes the delta meaningful
    np.testing.assert_array_equal(apply_connect_delta(dem_dm, delta), connect_dm)


def test_delta_is_zero_wherever_the_ground_drains():
    """The saving comes from the zeros: only depression cells carry a lift."""
    dem_dm = quantize_decimeters(tilted_plane())
    delta = connect_delta(build_connect_grid(dem_dm), dem_dm)
    assert not delta.any(), "a surface with no depressions must produce an all-zero delta"

    basin_dm = quantize_decimeters(false_basin())
    basin_delta = connect_delta(build_connect_grid(basin_dm), basin_dm)
    raised = basin_delta > 0
    assert raised.any()
    # Every raised cell is inside the basin floor, and nothing outside it moved.
    assert np.all(basin_delta[~raised] == 0)
    assert raised[FLOOR_SLICE].all()


def test_connect_delta_rejects_a_broken_invariant():
    dem_dm = quantize_decimeters(false_basin())
    connect_dm = build_connect_grid(dem_dm)
    connect_dm[5, 5] = dem_dm[5, 5] - 1
    with pytest.raises(ValueError, match="connect < dem"):
        connect_delta(connect_dm, dem_dm)


def test_connect_delta_rejects_a_geometry_mismatch():
    dem_dm = quantize_decimeters(tilted_plane(16))
    other = quantize_decimeters(tilted_plane(20))
    with pytest.raises(ValueError, match="share a geometry"):
        connect_delta(other, dem_dm)


def test_written_delta_grid_matches_the_context_grid_profile(tmp_path, fake_site, fake_source):
    """§12: the delta is written with exactly the §1/§1a encoding of its DEM grid."""
    holed, transform, nodata, _ = fake_source
    grids = build_grids(holed, transform, nodata, fake_site)
    context = grids["context"]
    dem_path = write_grid(tmp_path / context.spec.path, context)

    connect_dm = build_connect_grid(context.data)
    delta_path = write_connect_delta_grid(
        tmp_path / WATER_CONNECT_DELTA_PATH,
        connect_delta(connect_dm, context.data),
        context.transform,
        fake_site,
        fake_site.context,
        WATER_CONNECT_DELTA_PATH,
    )

    with rasterio.open(dem_path) as ref, rasterio.open(delta_path) as new:
        assert (new.width, new.height) == (ref.width, ref.height)
        assert new.crs == ref.crs and new.transform == ref.transform
        assert new.bounds == ref.bounds
        assert new.dtypes == ref.dtypes == ("int16",)
        assert new.nodata is None
        assert new.tags(ns="IMAGE_STRUCTURE") == ref.tags(ns="IMAGE_STRUCTURE")
        assert new.profile["blockysize"] == ref.profile["blockysize"]
        assert new.overviews(1) == []
        np.testing.assert_array_equal(
            apply_connect_delta(ref.read(1), new.read(1)), connect_dm
        )


def test_read_connect_grid_prefers_the_delta_and_falls_back(tmp_path, fake_site, fake_source):
    """The app's precedence, mirrored pipeline-side so both read the same surface."""
    holed, transform, nodata, _ = fake_source
    context = build_grids(holed, transform, nodata, fake_site)["context"]
    connect_dm = build_connect_grid(context.data)

    with pytest.raises(FileNotFoundError):
        read_connect_grid(tmp_path, context.data)

    write_connect_grid(tmp_path / WATER_CONNECT_PATH, connect_dm, context.transform, fake_site)
    absolute, path = read_connect_grid(tmp_path, context.data)
    assert path.name == WATER_CONNECT_PATH
    np.testing.assert_array_equal(absolute, connect_dm)

    write_connect_delta_grid(
        tmp_path / WATER_CONNECT_DELTA_PATH,
        connect_delta(connect_dm, context.data),
        context.transform,
        fake_site,
        fake_site.context,
        WATER_CONNECT_DELTA_PATH,
    )
    reconstructed, path = read_connect_grid(tmp_path, context.data)
    assert path.name == WATER_CONNECT_DELTA_PATH
    np.testing.assert_array_equal(reconstructed, connect_dm)
