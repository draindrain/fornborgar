"""REVEALS openness-anchor lookup tests (docs/vegetation-zones.md §3.1, §3.2).

No network and no fixtures: the two TW5 CSVs are committed data, so these are
assertions about the shipped product itself. Every expected number below is one
the research document already states, which makes this file the regression guard
on the committed data as much as on the parser — if a future re-fetch shifts the
Eketorp cell's 43.4 %, that is a data change and must be seen.
"""

from __future__ import annotations

import dataclasses

import pytest

from fornborg_pipeline.reveals import RevealsAnchor, WINDOW, openness_anchor

# --------------------------------------------------------------------------- #
# covered cells
# --------------------------------------------------------------------------- #


def test_eketorp_ismantorp_cell_is_covered():
    """The alvar pair on Öland shares the 16.5°E/56.5°N cell — §3.2's one
    quantified anchor behind the open-alvar rendering."""
    anchor = openness_anchor(16.6, 56.3)
    assert anchor is not None
    assert (anchor.cell_lon, anchor.cell_lat) == (16.5, 56.5)
    assert anchor.open_land_pct == pytest.approx(43.4, abs=0.1)
    assert anchor.open_land_se_pct == pytest.approx(7.1, abs=0.1)
    assert anchor.window == WINDOW


def test_skane_cell_is_covered():
    anchor = openness_anchor(13.4, 55.9)
    assert anchor is not None
    # floor(13.4) + 0.5 = 13.5; floor(55.9) + 0.5 = 55.5.
    assert (anchor.cell_lon, anchor.cell_lat) == (13.5, 55.5)
    assert anchor.open_land_pct == pytest.approx(37.4, abs=0.1)


# --------------------------------------------------------------------------- #
# absent cells — the documented majority
# --------------------------------------------------------------------------- #


def test_broborg_cell_is_absent():
    """Broborg (59.756°N, 17.95°E) falls in 17.5/59.5, one of the 25 cells the
    product does not cover in any time window (§3.1). The honest answer is None,
    not a neighbouring cell."""
    assert openness_anchor(17.95, 59.76) is None


def test_far_outside_the_grid_is_absent():
    assert openness_anchor(-30.0, 10.0) is None


# --------------------------------------------------------------------------- #
# the anchor object
# --------------------------------------------------------------------------- #


def test_anchor_is_frozen_and_names_its_window():
    anchor = openness_anchor(16.6, 56.3)
    assert isinstance(anchor, RevealsAnchor)
    assert dataclasses.is_dataclass(anchor)
    # Frozen on purpose: a reported number that no caller may nudge (§3.2).
    with pytest.raises(dataclasses.FrozenInstanceError):
        anchor.open_land_pct = 0.0
    assert "1200-1700" in anchor.window
