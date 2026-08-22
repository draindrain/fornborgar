"""Adaptive horizon-ladder tests (docs/data-formats.md §11). No network."""

from __future__ import annotations

import math

import numpy as np
import pytest
from affine import Affine

from fornborg_pipeline.horizon import (
    EYE_HEIGHT_M,
    HORIZON_COEFF_KM,
    crown_height,
    floor_height,
    horizon_distance_m,
    horizon_info,
    ladder,
    polygon_mask,
)
from fornborg_pipeline.sites import RING_LADDER


def _grid(size: int = 100, res: float = 1.0) -> Affine:
    return Affine(res, 0.0, 0.0, 0.0, -res, size * res)


# --------------------------------------------------------------------------- #
# polygon mask + crown
# --------------------------------------------------------------------------- #


def test_polygon_mask_square():
    transform = _grid(100)
    ring = np.array([[10.0, 10.0], [30.0, 10.0], [30.0, 30.0], [10.0, 30.0]])
    mask = polygon_mask(ring, transform, (100, 100))
    # Pixel centers strictly inside a 20x20 m square at 1 m: 20x20 cells.
    assert int(mask.sum()) == 400
    # Northing 10..30 -> rows 70..90 (row 0 is the north edge at N=100).
    rows, cols = np.nonzero(mask)
    assert rows.min() == 70 and rows.max() == 89
    assert cols.min() == 10 and cols.max() == 29


def test_polygon_mask_rejects_degenerate_rings():
    with pytest.raises(ValueError):
        polygon_mask(np.array([[0.0, 0.0], [1.0, 1.0]]), _grid(), (10, 10))


def test_crown_height_inside_polygon_only():
    transform = _grid(100)
    heights = np.full((100, 100), 10.0)
    heights[80, 20] = 55.0  # inside the square below (E 20.5, N 19.5)
    heights[5, 5] = 99.0  # far outside it
    ring = np.array([[10.0, 10.0], [30.0, 10.0], [30.0, 30.0], [10.0, 30.0]])
    assert crown_height(heights, transform, ring) == 55.0


def test_crown_height_falls_back_to_grid_max():
    heights = np.full((10, 10), 10.0)
    heights[3, 3] = 42.0
    assert crown_height(heights, _grid(10)) == 42.0
    # An out-of-grid polygon must not silently shrink the ladder.
    far_ring = np.array([[9e6, 9e6], [9e6 + 10, 9e6], [9e6 + 10, 9e6 + 10]])
    assert crown_height(heights, _grid(10), far_ring) == 42.0


# --------------------------------------------------------------------------- #
# floor + distance
# --------------------------------------------------------------------------- #


def test_floor_height_is_p5():
    heights = np.linspace(0.0, 100.0, 10001)
    assert floor_height(heights) == pytest.approx(5.0, abs=0.05)


def test_floor_height_floors_at_zero_for_sea():
    heights = np.concatenate([np.full(900, -0.5), np.full(100, 40.0)])
    assert floor_height(heights) == 0.0


def test_horizon_distance_matches_the_formula():
    assert horizon_distance_m(45.0) == pytest.approx(HORIZON_COEFF_KM * math.sqrt(45.0) * 1000.0)
    assert horizon_distance_m(-3.0) == 0.0


# --------------------------------------------------------------------------- #
# ladder depth
# --------------------------------------------------------------------------- #


def test_ladder_always_ships_ring3_and_ring4():
    specs = ladder(0.0)
    assert [s.name for s in specs] == ["ring3", "ring4"]


def test_ladder_broborg_class_site_gets_rings_3_to_6():
    # h ≈ 45..54 m -> d ≈ 25.7..28.1 km: ring5's 16 km half-extent is short of it,
    # ring6's 32 km closes it (docs/national-scaleout.md §2b).
    for h in (45.0, 54.0):
        specs = ladder(horizon_distance_m(h))
        assert [s.name for s in specs] == ["ring3", "ring4", "ring5", "ring6"]


def test_ladder_caps_at_ring7():
    # h ≈ 300 m -> d ≈ 66 km > ring7's 64 km half-extent: capped, never beyond.
    specs = ladder(horizon_distance_m(300.0))
    assert [s.name for s in specs] == ["ring3", "ring4", "ring5", "ring6", "ring7"]
    assert specs == list(RING_LADDER) or tuple(specs) == RING_LADDER


def test_ladder_stops_at_the_first_closing_ring():
    # d just under 8 km: ring4 already closes the skyline.
    specs = ladder(7999.0)
    assert [s.name for s in specs] == ["ring3", "ring4"]
    # d just over 8 km: ring5 is needed.
    specs = ladder(8001.0)
    assert [s.name for s in specs] == ["ring3", "ring4", "ring5"]


# --------------------------------------------------------------------------- #
# manifest block
# --------------------------------------------------------------------------- #


def test_horizon_info_block():
    info = horizon_info(57.3, 5.1)
    assert info["crownM"] == 57.3
    assert info["floorM"] == 5.1
    assert info["eyeM"] == EYE_HEIGHT_M == 2.0
    h = (57.3 + 2.0) - 5.1
    assert info["distanceKm"] == pytest.approx(round(3.83 * math.sqrt(h), 1))


# ------------------- §5.2 large preset: where the ladder starts ---------------


def test_a_standard_context_uses_the_whole_ladder():
    from fornborg_pipeline.horizon import rings_beyond

    assert [s.name for s in rings_beyond(2000.0)] == ["ring3", "ring4", "ring5", "ring6", "ring7"]


def test_a_large_context_skips_the_ring_it_already_covers():
    """§5.2 `large` has a 4 km context half-extent — exactly ring3's, so ring3
    has no annulus to render and would fail §11's containment chain."""
    from fornborg_pipeline.horizon import rings_beyond

    assert [s.name for s in rings_beyond(4000.0)] == ["ring4", "ring5", "ring6", "ring7"]


def test_the_large_preset_ladder_still_starts_with_two_rings():
    from fornborg_pipeline.horizon import ladder

    specs = ladder(1000.0, context_half_extent_m=4000.0)
    assert [s.name for s in specs] == ["ring4", "ring5"]


def test_the_large_preset_ladder_extends_to_the_horizon():
    from fornborg_pipeline.horizon import ladder

    specs = ladder(40_000.0, context_half_extent_m=4000.0)
    assert specs[-1].half_extent >= 40_000.0
    assert [s.name for s in specs] == ["ring4", "ring5", "ring6", "ring7"]


def test_every_ring_strictly_contains_a_large_context():
    from fornborg_pipeline.horizon import ladder

    for spec in ladder(40_000.0, context_half_extent_m=4000.0):
        assert spec.half_extent > 4000.0


def test_a_context_too_wide_for_two_rings_is_refused():
    from fornborg_pipeline.horizon import ladder

    with pytest.raises(ValueError, match="needs at least two"):
        ladder(10_000.0, context_half_extent_m=32_000.0)


def test_the_floor_box_is_named_not_indexed():
    """§11's floor is the 16x16 km box, whichever preset built the ladder."""
    from fornborg_pipeline.rings import FLOOR_BOX_HALF_EXTENT_M
    from fornborg_pipeline.sites import RING_LADDER

    box = next(s for s in RING_LADDER if s.half_extent == FLOOR_BOX_HALF_EXTENT_M)
    assert box.name == "ring4"
    assert 2 * box.half_extent == 16_000.0
