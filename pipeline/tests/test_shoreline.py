"""shoreline.json contract tests (docs/data-formats.md §6). No network.

The SGU response is canned: `canned_sgu()` builds a FeatureCollection with the real
API's property schema (`bp` as a string, `year`, `code` 1 = Hav / 4 = Sjö) over a
synthetic ramp DEM whose elevation is a known function of the row, so every
century's boundary median has an exact expected value. The fixture reproduces the
two awkward shapes of the real extract: a **tail** of centuries whose sea has left
the frame (nothing to measure — must be extrapolated) and the **BP 1100 gap** that
is missing from the product entirely.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
from affine import Affine

from fornborg_pipeline.clip_dem import grid_bounds
from fornborg_pipeline.shoreline import (
    CODE_HAV,
    CODE_SJO,
    SANITY_ANCHORS,
    ShorelineError,
    build_shoreline,
    check_sanity_anchors,
    collections_for_bp_range,
    densify_ring,
    derive_steps,
    features_by_bp,
    polygon_rings,
    sample_boundary_elevations,
    validate_shoreline,
    write_shoreline,
)
from fornborg_pipeline.sites import BROBORG

# Ramp DEM: 200x200 cells at 2 m over E 0..400 / N 0..400, elevation a function of
# the row alone — row r is exactly (200 - r) / 10 meters, i.e. 20.0 m along the
# north edge falling to 0.1 m along the south edge.
SIZE, RES = 200, 2.0
TRANSFORM = Affine(RES, 0.0, 0.0, 0.0, -RES, SIZE * RES)
BOUNDS = grid_bounds((SIZE, SIZE), TRANSFORM)

# Steps: BP 3000..800 by centuries. Hav is in frame down to BP 1400 (as at Broborg);
# BP 1100 is absent from the product; the rest carry lakes only.
BP_STEPS = tuple(range(3000, 700, -100))
BP_MISSING = 1100
BP_LAST_HAV = 1400
SGU_META = {
    "product": "SGU Strandförskjutningsmodell",
    "api": "https://api.sgu.se/oppnadata/strandforskjutningsmodell/ogc/features/v1",
    "fetched": "2026-08-20T12:00:00+00:00",
}


def ramp_dem() -> np.ndarray:
    return np.repeat(((SIZE - np.arange(SIZE)) / 10.0)[:, None], SIZE, axis=1)


def row_for_level(level: float) -> int:
    return int(round(SIZE - 10.0 * level))


def northing_for_level(level: float) -> float:
    """Center northing of the row whose elevation is exactly `level`."""
    return SIZE * RES - (row_for_level(level) + 0.5) * RES


def expected_level(bp: int) -> float:
    """The level the fixture encodes for a step, on the DEM's 0.1 m lattice."""
    return round(round(10.9 - 0.0053 * (1950 - bp), 1), 1)


def sea_polygon(level: float) -> dict:
    """A rectangle covering everything below `level`, inset 1 m from the extent.

    Three of its four sides run 1 m inside the extent edge — inside the raster but
    within the 2-cell margin, so they are clip artifacts the derivation must drop.
    Only the north side is a real shoreline.
    """
    north = northing_for_level(level)
    return {
        "type": "Polygon",
        "coordinates": [[[1.0, 1.0], [399.0, 1.0], [399.0, north], [1.0, north], [1.0, 1.0]]],
    }


def lake_polygon() -> dict:
    """A Sjö polygon sitting high on the ramp — a decoy for the `code` filter."""
    south, north = northing_for_level(19.0), northing_for_level(19.4)
    return {
        "type": "Polygon",
        "coordinates": [
            [[100.0, south], [300.0, south], [300.0, north], [100.0, north], [100.0, south]]
        ],
    }


def _feature(bp: int, code: int, geometry: dict) -> dict:
    return {
        "type": "Feature",
        "id": f"{bp}-{code}",
        "geometry": geometry,
        "properties": {
            "uniktid": bp * 10 + code,
            "bp": str(bp),
            "year": 1950 - bp,
            "code": code,
            "description": "Hav" if code == CODE_HAV else "Sjö",
        },
    }


def canned_sgu(offset_m: float = 0.0) -> list[dict]:
    """The canned extract. `offset_m` shifts every sea boundary up — a corrupt fixture."""
    features = []
    for bp in BP_STEPS:
        if bp == BP_MISSING:
            continue
        features.append(_feature(bp, CODE_SJO, lake_polygon()))
        if bp >= BP_LAST_HAV:
            features.append(_feature(bp, CODE_HAV, sea_polygon(expected_level(bp) + offset_m)))
    return features


@pytest.fixture
def dem():
    return ramp_dem()


@pytest.fixture
def steps_and_stats(dem):
    return derive_steps(canned_sgu(), dem, TRANSFORM, BOUNDS, project=None)


# --------------------------------------------------------------------------- #
# geometry helpers
# --------------------------------------------------------------------------- #


def test_polygon_rings_handles_polygons_multipolygons_and_holes():
    ring = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]]
    assert polygon_rings({"type": "Polygon", "coordinates": [ring, ring]}) == [ring, ring]
    assert polygon_rings({"type": "MultiPolygon", "coordinates": [[ring], [ring]]}) == [ring, ring]
    assert polygon_rings({"type": "Point", "coordinates": [0.0, 0.0]}) == []


def test_densify_adds_points_no_further_apart_than_the_step():
    points = densify_ring([[0.0, 0.0], [10.0, 0.0]], step=2.0)
    assert np.allclose(points[:, 0], [0.0, 2.0, 4.0, 6.0, 8.0, 10.0])
    spacing = np.hypot(*np.diff(points, axis=0).T)
    assert spacing.max() <= 2.0 + 1e-9


def test_densify_drops_segments_that_cannot_reach_the_window():
    """SGU rings span the country; only segments near the extent may be subdivided."""
    window = (0.0, 0.0, 20.0, 20.0)
    elsewhere = [[-5000.0, -5000.0], [-4000.0, -5000.0], [-4000.0, -4000.0], [-5000.0, -5000.0]]
    assert densify_ring(elsewhere, step=2.0).shape[0] > 1000
    assert densify_ring(elsewhere, step=2.0, bounds=window).shape[0] == 0

    crossing = [[-5000.0, 10.0], [5000.0, 10.0], [-5000.0, 10.0]]
    assert densify_ring(crossing, step=2.0, bounds=window).shape[0] > 0


def test_features_by_bp_groups_and_filters_on_code():
    grouped = features_by_bp(canned_sgu(), code=CODE_HAV)
    assert max(grouped) == 3000 and min(grouped) == BP_LAST_HAV
    assert BP_MISSING not in features_by_bp(canned_sgu())


def test_collection_selection_covers_the_slider_range():
    assert collections_for_bp_range(800, 3000) == [
        "bp1-900",
        "bp1000-1900",
        "bp2000-2900",
        "bp3000-3900",
    ]


# --------------------------------------------------------------------------- #
# level derivation: boundary median + bbox-edge exclusion
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("level", [16.5, 12.0, 8.3])
def test_boundary_median_recovers_the_known_level(dem, level):
    feature = _feature(2000, CODE_HAV, sea_polygon(level))
    samples = sample_boundary_elevations([feature], dem, TRANSFORM, BOUNDS)
    assert samples.size > 100
    assert float(np.median(samples)) == pytest.approx(level)
    assert samples.min() == pytest.approx(level), "only the shoreline side should survive"


def test_extent_edge_samples_are_excluded_as_clip_artifacts(dem):
    feature = _feature(2000, CODE_HAV, sea_polygon(16.5))
    kept = sample_boundary_elevations([feature], dem, TRANSFORM, BOUNDS)
    with_artifacts = sample_boundary_elevations(
        [feature], dem, TRANSFORM, BOUNDS, edge_margin_cells=0.0
    )
    assert with_artifacts.size > kept.size
    # The three sides that hug the extent edge run down the whole ramp and would
    # drag the median metres away from the true shoreline.
    assert float(np.median(with_artifacts)) < 16.5 - 1.0


def test_lake_polygons_never_contribute_a_level(dem, steps_and_stats):
    steps, _ = steps_and_stats
    lakes = [f for f in canned_sgu() if f["properties"]["code"] == CODE_SJO]
    lake_samples = sample_boundary_elevations(lakes, dem, TRANSFORM, BOUNDS)
    assert lake_samples.size > 0 and float(np.median(lake_samples)) > 18.0
    assert all(step.level_m < 18.0 for step in steps)


# --------------------------------------------------------------------------- #
# the table
# --------------------------------------------------------------------------- #


def test_measured_steps_match_the_fixtures_known_levels(steps_and_stats):
    steps, stats = steps_and_stats
    measured = {s.bp: s.level_m for s in steps if s.derived}
    assert set(measured) == {bp for bp in BP_STEPS if bp >= BP_LAST_HAV}
    for bp, level in measured.items():
        assert level == pytest.approx(expected_level(bp), abs=0.05)
    assert stats["measured"] == len(measured)
    assert stats["sampleTotal"] > 1000


def test_the_tail_without_a_shoreline_in_frame_is_extrapolated(steps_and_stats):
    steps, stats = steps_and_stats
    filled = [s for s in steps if not s.derived]
    expected = [bp for bp in BP_STEPS if bp < BP_LAST_HAV and bp != BP_MISSING]
    assert [s.bp for s in filled] == expected
    assert stats["filled"] == [s.bp for s in filled]
    # The fixture's levels are linear in the year, so the trend must recover them.
    for step in filled:
        assert step.level_m == pytest.approx(expected_level(step.bp), abs=0.15)
    assert stats["trendRms"] < 0.1


def test_a_step_missing_from_the_product_gets_no_entry(steps_and_stats):
    steps, stats = steps_and_stats
    assert BP_MISSING not in {s.bp for s in steps}
    assert stats["missingBp"] == [BP_MISSING]
    assert stats["stepCount"] == len(BP_STEPS) - 1


def test_table_invariants(steps_and_stats):
    steps, stats = steps_and_stats
    table = build_shoreline(BROBORG, steps, stats, SGU_META)
    validate_shoreline(table)

    entries = table["steps"]
    assert len(entries) >= 2
    years = [e["yearCE"] for e in entries]
    levels = [e["levelM"] for e in entries]
    assert years == sorted(years) and len(set(years)) == len(years)
    assert all(b <= a for a, b in zip(levels, levels[1:]))
    assert all(e["yearCE"] == 1950 - e["bp"] for e in entries)
    assert (years[0], years[-1]) == (1950 - 3000, 1950 - 800)


def test_method_text_is_honest_about_extrapolation(steps_and_stats):
    steps, stats = steps_and_stats
    table = build_shoreline(BROBORG, steps, stats, SGU_META)
    method = table["method"]
    assert "median" in method and "50 m DEM" in method
    assert "extrapolated" in method
    assert f"BP {BP_MISSING}" in method
    assert table["source"]["fetched"] == SGU_META["fetched"]
    assert "±500" in table["uncertainty"] and "RH 2000" in table["datumNote"]


def test_written_file_round_trips(tmp_path, steps_and_stats):
    steps, stats = steps_and_stats
    table = build_shoreline(BROBORG, steps, stats, SGU_META)
    path = write_shoreline(tmp_path / "shoreline.json", table)
    reloaded = json.loads(path.read_text(encoding="utf-8"))
    assert reloaded == table
    validate_shoreline(reloaded)


# --------------------------------------------------------------------------- #
# the sanity gate
# --------------------------------------------------------------------------- #


def test_sanity_anchors_pass_on_the_fixture(steps_and_stats):
    steps, stats = steps_and_stats
    check_sanity_anchors(build_shoreline(BROBORG, steps, stats, SGU_META)["steps"])


def test_corrupted_fixture_trips_the_sanity_anchors(dem):
    """A 6 m vertical offset — the shape of the EPSG:5845 geoid bug — must abort."""
    steps, stats = derive_steps(
        canned_sgu(offset_m=6.0), dem, TRANSFORM, BOUNDS, project=None
    )
    with pytest.raises(ShorelineError, match="outside the literature band"):
        build_shoreline(BROBORG, steps, stats, SGU_META)


def test_validate_rejects_unsorted_and_rising_tables(steps_and_stats):
    steps, stats = steps_and_stats
    table = build_shoreline(BROBORG, steps, stats, SGU_META)

    rising = json.loads(json.dumps(table))
    rising["steps"][-1]["levelM"] = rising["steps"][0]["levelM"] + 1.0
    with pytest.raises(ShorelineError, match="non-increasing"):
        validate_shoreline(rising)

    unsorted_table = json.loads(json.dumps(table))
    unsorted_table["steps"].reverse()
    with pytest.raises(ShorelineError, match="ascending"):
        validate_shoreline(unsorted_table)

    short = json.loads(json.dumps(table))
    short["steps"] = short["steps"][:1]
    with pytest.raises(ShorelineError, match=">= 2 steps"):
        validate_shoreline(short)


def test_anchor_bands_are_the_documented_ones():
    assert SANITY_ANCHORS == (
        (-500, 13.0, 16.0),
        (1, 10.0, 12.5),
        (500, 8.0, 10.0),
        (1000, 5.0, 6.5),
    )


def test_derive_fails_loudly_when_no_sea_is_in_frame(dem):
    lakes = [f for f in canned_sgu() if f["properties"]["code"] == CODE_SJO]
    with pytest.raises(ShorelineError, match="nothing to derive"):
        derive_steps(lakes, dem, TRANSFORM, BOUNDS, project=None)
