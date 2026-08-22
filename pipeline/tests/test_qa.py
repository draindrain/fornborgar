"""Batch QA gates (scale-out §4.4). Pure functions over a manifest — no network.

The gates are what stands between a 1,304-site batch and shipping something
wrong, so the tests care most about the two ways a gate fails at its job:
passing a bundle it should have stopped, and failing so often that nobody reads
the report.
"""

from __future__ import annotations

import copy

import pytest

import numpy as np

from fornborg_pipeline.qa import (
    LADDER_CAP_RADIUS_M,
    RING_AGREEMENT_TOLERANCE_M,
    check_elevation_band,
    check_ring_agreement,
    ring_context_offset,
    check_ladder,
    check_nodata_fill,
    check_required_files,
    check_sea_fill,
    check_steps,
    check_water_pair,
    run_gates,
    sea_filled_cells,
    water_mask_at,
)


def grid(path, half_extent, resolution, zmin=5.0, zmax=60.0):
    return {
        "path": path,
        "resolution": resolution,
        "width": int(2 * half_extent / resolution),
        "height": int(2 * half_extent / resolution),
        "bounds3006": {
            "minE": 665810.0 - half_extent,
            "minN": 6627880.0 - half_extent,
            "maxE": 665810.0 + half_extent,
            "maxN": 6627880.0 + half_extent,
        },
        "boundsLocal": {"minX": -half_extent, "minZ": -half_extent, "maxX": half_extent, "maxZ": half_extent},
        "encoding": {"dtype": "int16", "scale": 0.1, "unit": "m"},
        "minElevation": zmin,
        "maxElevation": zmax,
    }


@pytest.fixture
def manifest():
    return {
        "schemaVersion": 1,
        "site": {"id": "l1943-7827", "name": "Broborg"},
        "grids": {
            "core": grid("dem_core.tif", 1000.0, 1.0),
            "context": grid("dem_context.tif", 2000.0, 2.0),
            "rings": [
                grid("dem_ring3.tif", 4000.0, 4.0),
                grid("dem_ring4.tif", 8000.0, 8.0),
                grid("dem_ring5.tif", 16000.0, 16.0),
                grid("dem_ring6.tif", 32000.0, 32.0),
            ],
        },
        "horizon": {"crownM": 50.4, "floorM": 10.5, "eyeM": 2.0, "distanceKm": 24.8},
        "assets": {"shoreline": "shoreline.json", "waterConnectDelta": "water_connect_delta.tif"},
        "provenance": {"processing": ["far-field rings: decimated windowed reads"]},
    }


BAND = (-15.0, 2200.0)


# ------------------------------- elevation band ------------------------------


def test_elevation_band_passes_a_normal_site(manifest):
    assert check_elevation_band(manifest, BAND).severity == "pass"


def test_elevation_band_catches_a_geoid_shifted_ring(manifest):
    """A +23..36 m shift shows up as a grid that leaves the band (PLAN.md §2.1)."""
    shifted = copy.deepcopy(manifest)
    shifted["grids"]["rings"][2]["maxElevation"] = 2500.0
    check = check_elevation_band(shifted, BAND)
    assert check.severity == "fail"
    assert "rings[2]" in check.message


def test_elevation_band_checks_core_and_context_too(manifest):
    shifted = copy.deepcopy(manifest)
    shifted["grids"]["core"]["minElevation"] = -40.0
    assert check_elevation_band(shifted, BAND).severity == "fail"


# --------------------------------- nodata fill -------------------------------


@pytest.mark.parametrize(
    ("filled", "severity"),
    [(0, "pass"), (39_999, "pass"), (40_001, "warn"), (200_001, "fail")],
)
def test_nodata_thresholds(filled, severity):
    check = check_nodata_fill({"context": (filled, 4_000_000)})
    assert check.severity == severity


def test_nodata_reports_the_worst_grid():
    check = check_nodata_fill({"core": (0, 4_000_000), "context": (100_000, 4_000_000)})
    assert "context" in check.message
    assert check.detail["shareByGrid"]["core"] == 0.0


# ------------------------------------ ladder ---------------------------------


def test_ladder_passes_when_the_rings_reach_the_horizon(manifest):
    check = check_ladder(manifest)
    assert check.severity == "pass"
    assert check.detail["outerRadiusKm"] == 32.0


def test_ladder_fails_when_it_stops_short_of_the_horizon(manifest):
    """Exactly the Phase-8 failure mode: the skyline would close in fog."""
    short = copy.deepcopy(manifest)
    short["grids"]["rings"] = short["grids"]["rings"][:2]  # out to 8 km only
    check = check_ladder(short)
    assert check.severity == "fail"
    assert "fog" in check.message


def test_ladder_fails_past_the_128_km_cap(manifest):
    beyond = copy.deepcopy(manifest)
    beyond["horizon"]["distanceKm"] = LADDER_CAP_RADIUS_M / 1000.0 + 5.0
    check = check_ladder(beyond)
    assert check.severity == "fail"
    assert "caps at" in check.message


def test_ladder_fails_on_a_horizon_block_with_no_rings(manifest):
    orphan = copy.deepcopy(manifest)
    orphan["grids"].pop("rings")
    assert check_ladder(orphan).severity == "fail"


def test_ladder_warns_on_a_ringless_site(manifest):
    ringless = copy.deepcopy(manifest)
    ringless["grids"].pop("rings")
    ringless.pop("horizon")
    assert check_ladder(ringless).severity == "warn"


# ----------------------------------- sea fill --------------------------------


def test_sea_filled_cells_parses_the_provenance_lines(manifest):
    manifest["provenance"]["processing"] += [
        "ring6: 12345 cells outside tile coverage sea-filled at 0 m",
        "ring5: 7 cells outside tile coverage sea-filled at 0 m",
    ]
    assert sea_filled_cells(manifest) == {"ring6": 12345, "ring5": 7}


def test_sea_fill_passes_when_coverage_is_complete(manifest):
    assert check_sea_fill(manifest, coastal=False).severity == "pass"


def test_sea_fill_fails_for_an_interior_site(manifest):
    """A hole in interior Sweden is a coverage gap, not a lake — never ship it."""
    manifest["provenance"]["processing"].append(
        "ring6: 900 cells outside tile coverage sea-filled at 0 m"
    )
    check = check_sea_fill(manifest, coastal=False)
    assert check.severity == "fail"
    assert "false flat horizon" in check.message


def test_sea_fill_only_warns_for_a_coastal_site(manifest):
    manifest["provenance"]["processing"].append(
        "ring6: 900000 cells outside tile coverage sea-filled at 0 m"
    )
    assert check_sea_fill(manifest, coastal=True).severity == "warn"


# ---------------------------------- water pair -------------------------------


def test_water_pair_accepts_either_encoding(manifest):
    assert check_water_pair(manifest).severity == "pass"
    absolute = copy.deepcopy(manifest)
    absolute["assets"] = {"shoreline": "shoreline.json", "waterConnect": "water_connect.tif"}
    assert check_water_pair(absolute).severity == "pass"


def test_water_pair_accepts_an_inland_site_with_neither(manifest):
    inland = copy.deepcopy(manifest)
    inland["assets"] = {"sites": "sites.json"}
    check = check_water_pair(inland)
    assert check.severity == "pass"
    assert "inland" in check.message


def test_water_pair_fails_on_half_a_pair(manifest):
    broken = copy.deepcopy(manifest)
    broken["assets"].pop("waterConnectDelta")
    assert check_water_pair(broken).severity == "fail"


# --------------------------------- files present -----------------------------


def test_files_present_fails_on_a_manifest_that_lies(tmp_path, manifest):
    check = check_required_files(tmp_path, manifest)
    assert check.severity == "fail"
    assert "dem_core.tif" in check.detail["missing"]


def test_files_present_passes_when_everything_is_there(tmp_path, manifest):
    for name in ("dem_core.tif", "dem_context.tif", "dem_ring3.tif", "dem_ring4.tif",
                 "dem_ring5.tif", "dem_ring6.tif", "shoreline.json", "water_connect_delta.tif"):
        (tmp_path / name).write_bytes(b"x")
    assert check_required_files(tmp_path, manifest).severity == "pass"


# ------------------------------------ report ---------------------------------


def test_report_summarizes_and_serializes(tmp_path, manifest):
    report = run_gates("l1943-7827", tmp_path, manifest, BAND, {"context": (0, 4_000_000)}, False)
    assert not report.passed  # the files are not on disk in this tmp_path
    assert "FAIL" in report.summary()
    payload = report.as_json()
    assert payload["slug"] == "l1943-7827"
    assert payload["failures"] >= 1
    assert {c["id"] for c in payload["checks"]} >= {"elevation-band", "ladder", "sea-fill"}


def test_a_clean_build_passes_every_gate(tmp_path, manifest):
    for name in ("dem_core.tif", "dem_context.tif", "dem_ring3.tif", "dem_ring4.tif",
                 "dem_ring5.tif", "dem_ring6.tif", "shoreline.json", "water_connect_delta.tif"):
        (tmp_path / name).write_bytes(b"x")
    report = run_gates("l1943-7827", tmp_path, manifest, BAND, {"context": (12, 4_000_000)}, False)
    assert report.passed
    assert report.warnings == []
    assert report.summary() == "l1943-7827: PASS"


def test_water_mask_is_the_contract_test():
    import numpy as np

    connect = np.array([[5.0, 12.0], [8.0, 9.5]])
    np.testing.assert_array_equal(water_mask_at(connect, 9.0), [[True, False], [True, False]])


# --------------------------------- steps gate --------------------------------


def _steps(**statuses):
    return [{"name": name, "status": status} for name, status in statuses.items()]


def test_steps_gate_passes_a_clean_build():
    check = check_steps(_steps(grids="ok", sites="ok", water="ok"))
    assert check.severity == "pass"


def test_a_skipped_optional_step_is_not_a_problem():
    """The contract's own rule: a missing asset means feature off, not failure."""
    check = check_steps(_steps(grids="ok", sites="ok", water="skipped", rampart="skipped"))
    assert check.severity == "pass"


def test_a_failed_required_step_blocks_the_bundle():
    check = check_steps(_steps(grids="ok", sites="failed"))
    assert check.severity == "fail"
    assert "sites" in check.message


def test_a_failed_optional_step_only_warns():
    check = check_steps(_steps(grids="ok", sites="ok", thumbnail="failed"))
    assert check.severity == "warn"
    assert "thumbnail" in check.message


def test_steps_gate_accepts_dataclass_step_results():
    from fornborg_pipeline.build_site import StepResult

    check = check_steps([StepResult("grids", "ok"), StepResult("sites", "failed", "boom")])
    assert check.severity == "fail"


def test_run_gates_includes_the_steps_check_when_given_steps(tmp_path, manifest):
    report = run_gates(
        "l1943-7827", tmp_path, manifest, BAND, {"context": (0, 4_000_000)}, False,
        steps=_steps(grids="ok", sites="failed"),
    )
    assert "required-steps" in {c.id for c in report.checks}
    assert not report.passed


# ----------------------------- ring/context agreement ------------------------


def flat_grid(shape, value):
    return np.full(shape, value, dtype=np.float64)


CONTEXT_BOUNDS = (663810.0, 6625880.0, 667810.0, 6629880.0)  # 4x4 km @ 2 m
RING_BOUNDS = (661810.0, 6623880.0, 669810.0, 6631880.0)  # 8x8 km @ 4 m


def test_matching_grids_have_no_offset():
    offset = ring_context_offset(
        flat_grid((2000, 2000), 42.0), RING_BOUNDS, 4.0,
        flat_grid((2000, 2000), 42.0), CONTEXT_BOUNDS,
    )
    assert offset == pytest.approx(0.0)


def test_a_geoid_shifted_ring_shows_up_as_its_shift():
    """A +25 m EPSG:5845 shift on the ring path, which no absolute band catches."""
    offset = ring_context_offset(
        flat_grid((2000, 2000), 67.0), RING_BOUNDS, 4.0,
        flat_grid((2000, 2000), 42.0), CONTEXT_BOUNDS,
    )
    assert offset == pytest.approx(25.0)
    check = check_ring_agreement({"dem_ring3.tif": offset})
    assert check.severity == "fail"
    assert "warped" in check.message


def test_a_shifted_context_grid_is_caught_the_same_way():
    """The check is symmetric — it does not care which path did the warping."""
    offset = ring_context_offset(
        flat_grid((2000, 2000), 42.0), RING_BOUNDS, 4.0,
        flat_grid((2000, 2000), 67.0), CONTEXT_BOUNDS,
    )
    assert offset == pytest.approx(-25.0)
    assert check_ring_agreement({"dem_ring3.tif": offset}).severity == "fail"


def test_a_ring_that_does_not_overlap_is_not_measured():
    far = (900000.0, 6900000.0, 908000.0, 6908000.0)
    assert ring_context_offset(
        flat_grid((2000, 2000), 42.0), far, 4.0,
        flat_grid((2000, 2000), 42.0), CONTEXT_BOUNDS,
    ) is None


def test_block_averaging_noise_stays_inside_the_tolerance():
    """Real rings differ from the context grid; only a systematic offset is a fault."""
    rng = np.random.default_rng(11)
    context = rng.normal(40.0, 8.0, size=(2000, 2000))
    ring = rng.normal(40.0, 8.0, size=(2000, 2000))
    offset = ring_context_offset(ring, RING_BOUNDS, 4.0, context, CONTEXT_BOUNDS)
    assert abs(offset) < RING_AGREEMENT_TOLERANCE_M
    assert check_ring_agreement({"dem_ring3.tif": offset}).severity == "pass"


def test_agreement_check_reports_the_worst_ring():
    check = check_ring_agreement({"a.tif": 0.4, "b.tif": -25.0, "c.tif": 1.1})
    assert check.severity == "fail"
    assert "b.tif" in check.message
    assert check.detail["medianOffsetM"]["c.tif"] == 1.1


def test_agreement_check_passes_a_ringless_site():
    assert check_ring_agreement({}).severity == "pass"
    assert check_ring_agreement({"a.tif": None}).severity == "pass"
