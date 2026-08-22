"""`build_site`: registry entry -> SiteConfig, and the batch's failure policy.

The network-touching half of `run()` is exercised by the real batch; what these
tests pin is everything a wrong answer here would quietly corrupt across 1,304
sites — the extent presets, the national height band, the output directory
staying out of the repository, and the thumbnail's water window.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from fornborg_pipeline.build_site import (
    BuildResult,
    BuildSiteError,
    StepResult,
    core_window_of_context,
    evict_scratch,
    load_site,
    site_config,
)
from fornborg_pipeline.qa import Check, QAReport
from fornborg_pipeline.registry import write_registry
from fornborg_pipeline.sites import APP_DATA_DIR, NATIONAL_ELEVATION_RANGE, SITES


def entry(slug="l1943-7827", preset="standard", **overrides):
    base = {
        "slug": slug,
        "lamningsnummer": "L1943:7827",
        "name": "Broborg",
        "county": "Uppsala",
        "kommun": "Knivsta",
        "centerE": 665810.0,
        "centerN": 6627880.0,
        "extent": {"minE": 665740.0, "minN": 6627810.0, "maxE": 665880.0, "maxN": 6627950.0},
        "extentSpanM": 140.0,
        "geometryClass": "polygon",
        "antikvariskBedomning": "Fornlämning",
        "extentPreset": preset,
        "uuid": "184ca0f6-16f9-4de8-bbec-99aa959f9824",
        "raaNummer": "Husby-Långhundra 156:1",
        "fornsokUrl": "https://pub.raa.se/visa/objekt/lamning/184ca0f6",
    }
    base.update(overrides)
    return base


# ------------------------------- presets ------------------------------------


def test_standard_preset_reproduces_the_v1_extents(tmp_path):
    cfg = site_config(entry(), tmp_path)
    assert (cfg.core.half_extent, cfg.core.resolution) == (1000.0, 1.0)
    assert (cfg.context.half_extent, cfg.context.resolution) == (2000.0, 2.0)
    assert cfg.source_resolution == 1.0
    assert cfg.core.size == cfg.context.size == 2000


def test_large_preset_doubles_the_ground_at_the_same_pixel_budget(tmp_path):
    """§5.2: the app's performance budgets hold because the grids stay 2000x2000."""
    cfg = site_config(entry(preset="large"), tmp_path)
    assert (cfg.core.half_extent, cfg.core.resolution) == (2000.0, 2.0)
    assert (cfg.context.half_extent, cfg.context.resolution) == (4000.0, 4.0)
    assert cfg.core.size == cfg.context.size == 2000
    # Fetching 1 m for a grid whose finest output is 2 m would quadruple the
    # transfer for data that gets block-averaged away.
    assert cfg.source_resolution == 2.0


def test_both_presets_keep_the_core_strictly_inside_the_context(tmp_path):
    for preset in ("standard", "large"):
        cfg = site_config(entry(preset=preset), tmp_path)
        assert cfg.core.half_extent < cfg.context.half_extent
        assert cfg.core.resolution < cfg.context.resolution


def test_unknown_preset_is_refused(tmp_path):
    with pytest.raises(BuildSiteError, match="unknown extent preset"):
        site_config(entry(preset="enormous"), tmp_path)


# ------------------------------- config shape --------------------------------


def test_registry_site_uses_the_national_height_band(tmp_path):
    cfg = site_config(entry(), tmp_path)
    assert cfg.elevation_range == NATIONAL_ELEVATION_RANGE
    # No hand-verified crown height exists nationally, so the center-band gate
    # is off — the range gate is what catches a geoid shift.
    assert cfg.center_height_range is None


def test_registry_site_writes_outside_the_repository(tmp_path):
    cfg = site_config(entry(), tmp_path)
    assert cfg.out_dir == tmp_path
    assert APP_DATA_DIR not in cfg.out_dir.parents


def test_raa_block_carries_what_the_later_steps_look_up(tmp_path):
    """rings/rampart find the site's own KMR record by lämningsnummer."""
    cfg = site_config(entry(), tmp_path)
    assert cfg.raa["lamningsnummer"] == "L1943:7827"
    assert cfg.raa["kmrUuid"].startswith("184ca0f6")


def test_load_site_registers_the_config_for_every_step(tmp_path):
    registry = {"schemaVersion": 1, "sites": [entry(slug="l9999-0001")]}
    path = tmp_path / "registry.json"
    write_registry(path, registry)
    try:
        cfg = load_site("l9999-0001", tmp_path / "out", path)
        # Every pipeline step resolves its site through `get_site`.
        from fornborg_pipeline.sites import get_site

        assert get_site("l9999-0001") is cfg
    finally:
        SITES.pop("l9999-0001", None)


def test_load_site_reports_an_unknown_slug(tmp_path):
    path = tmp_path / "registry.json"
    write_registry(path, {"schemaVersion": 1, "sites": [entry()]})
    with pytest.raises(BuildSiteError, match="no registry entry"):
        load_site("l0000-0000", tmp_path / "out", path)


def test_load_site_does_not_disturb_the_hand_written_broborg(tmp_path):
    path = tmp_path / "registry.json"
    write_registry(path, {"schemaVersion": 1, "sites": [entry(slug="l5555-5555")]})
    before = SITES["broborg"]
    try:
        load_site("l5555-5555", tmp_path / "out", path)
        assert SITES["broborg"] is before
        assert SITES["broborg"].out_dir_override is None
    finally:
        SITES.pop("l5555-5555", None)


# ---------------------------- the thumbnail window ---------------------------


@pytest.mark.parametrize("preset", ["standard", "large"])
def test_core_covers_the_central_half_of_the_context(tmp_path, preset):
    cfg = site_config(entry(preset=preset), tmp_path)
    rows, cols = core_window_of_context((2000, 2000), cfg)
    assert (rows.start, rows.stop) == (500, 1500)
    assert (cols.start, cols.stop) == (500, 1500)


def test_core_window_rejects_a_core_wider_than_its_context(tmp_path):
    cfg = site_config(entry(), tmp_path)
    broken = type(cfg)(**{**cfg.__dict__, "core": cfg.context, "context": cfg.core})
    with pytest.raises(ValueError, match="not inside"):
        core_window_of_context((2000, 2000), broken)


# --------------------------------- reporting ---------------------------------


def report(*checks):
    return QAReport("l1943-7827", list(checks))


def test_result_is_shippable_only_when_built_and_qa_clean(tmp_path):
    result = BuildResult("l1943-7827", tmp_path, [StepResult("grids", "ok")])
    result.qa = report(Check("x", "pass", "fine"))
    assert result.built and result.shippable
    assert "SHIPPABLE" in result.summary()


def test_a_qa_failure_is_built_but_not_shippable(tmp_path):
    result = BuildResult("l1943-7827", tmp_path, [StepResult("grids", "ok")])
    result.qa = report(Check("sea-fill", "fail", "900 cells sea-filled inland"))
    assert result.built and not result.shippable
    assert "BUILT-BUT-FAILED-QA" in result.summary()
    assert "sea-filled" in result.summary()


def test_a_failed_grid_step_is_not_built(tmp_path):
    result = BuildResult("l1943-7827", tmp_path, [StepResult("grids", "failed", "FetchError: 401")])
    assert not result.built and not result.shippable
    assert "FAILED" in result.summary()
    assert "401" in result.summary()


def test_skipped_features_are_reported_but_do_not_block_shipping(tmp_path):
    """Contract rule: a missing optional asset is "feature off", not a failure."""
    result = BuildResult(
        "l1943-7827",
        tmp_path,
        [
            StepResult("grids", "ok"),
            StepResult("water", "skipped", "no SGU coverage"),
            StepResult("rampart", "skipped", "geometryLocal is 'Point'"),
        ],
    )
    result.qa = report(Check("x", "pass", "fine"))
    assert result.shippable
    assert "skipped=water,rampart" in result.summary()


def test_result_serializes_the_whole_story(tmp_path):
    result = BuildResult("l1943-7827", tmp_path, [StepResult("grids", "ok")], bytes_written=9_500_000)
    result.qa = report(Check("ladder", "warn", "no rings"))
    payload = result.as_json()
    assert payload["slug"] == "l1943-7827"
    assert payload["shippable"] is True
    assert payload["bytes"] == 9_500_000
    assert payload["qa"]["warnings"] == 1
    assert payload["steps"][0] == {"name": "grids", "status": "ok", "message": ""}


def test_evict_scratch_removes_a_built_bundle(tmp_path):
    bundle = tmp_path / "l1943-7827"
    bundle.mkdir()
    (bundle / "dem_core.tif").write_bytes(b"x" * 1024)
    evict_scratch(bundle)
    assert not bundle.exists()
    evict_scratch(bundle)  # idempotent: a batch retry must not trip on this
