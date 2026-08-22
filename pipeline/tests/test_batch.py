"""Batch driver: skip logic, the national index, and the QA contact sheet.

No network. The properties that matter to a 1,304-site run: a finished site is
skipped without rebuilding it, a site that failed a gate never reaches the index
the picker reads, and the contact sheet points at images that actually exist.
"""

from __future__ import annotations

import json

import pytest

from fornborg_pipeline.batch import (
    build_index,
    contact_sheet_html,
    evict_site_cache,
    index_entry,
    run_site,
    site_cache_files,
    thumbnail_src,
    write_contact_sheet,
    write_index,
)
from fornborg_pipeline.registry import write_registry
from fornborg_pipeline.upload import SiteState


REGISTRY = {
    "schemaVersion": 1,
    "generated": "2026-08-22",
    "source": {"product": "RAÄ KMR (riket)"},
    "stats": {"count": 1304},
    "sites": [
        {
            "slug": "l1943-7827",
            "lamningsnummer": "L1943:7827",
            "name": "Broborg",
            "county": "Uppsala",
            "kommun": "Knivsta",
            "centerE": 665810.0,
            "centerN": 6627880.0,
            "antikvariskBedomning": "Fornlämning",
            "extentPreset": "standard",
            "fornsokUrl": "https://pub.raa.se/visa/objekt/lamning/184ca0f6",
        },
        {
            "slug": "l1976-4254",
            "lamningsnummer": "L1976:4254",
            "name": "Torsburgen",
            "county": "Gotland",
            "kommun": "Gotland",
            "centerE": 700000.0,
            "centerN": 6380000.0,
            "antikvariskBedomning": "Fornlämning",
            "extentPreset": "large",
            "fornsokUrl": "",
        },
    ],
}

MANIFEST = {
    "assets": {"shoreline": "shoreline.json", "waterConnectDelta": "water_connect_delta.tif", "rampart": "rampart.json"},
    "grids": {"rings": [{}, {}, {}, {}]},
    "horizon": {"distanceKm": 24.8},
}


@pytest.fixture
def workspace(tmp_path):
    registry_path = tmp_path / "registry.json"
    write_registry(registry_path, REGISTRY)
    return {
        "registry": registry_path,
        "state": tmp_path / "state",
        "build": tmp_path / "build",
    }


def publish(workspace, slug, qa_passed=True, uploaded=True, manifest=MANIFEST, bytes_=9_500_000):
    """Put a site into the state a finished (or failed) batch run would leave."""
    state = SiteState(
        slug=slug,
        built=True,
        qaPassed=qa_passed,
        uploaded=uploaded,
        bundleBytes=bytes_,
        objects={"manifest.json": "abc"},
    )
    state.save(workspace["state"])
    out = workspace["build"] / slug
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return state


# ---------------------------------- skipping ---------------------------------


def test_a_published_unchanged_site_is_skipped_without_rebuilding(workspace, monkeypatch):
    publish(workspace, "l1943-7827")
    out = workspace["build"] / "l1943-7827"
    state = SiteState.load("l1943-7827", workspace["state"])
    from fornborg_pipeline.upload import local_digest_map

    state.objects = local_digest_map(out)
    state.save(workspace["state"])

    def explode(*args, **kwargs):
        raise AssertionError("build_site must not run for an unchanged published site")

    monkeypatch.setattr("fornborg_pipeline.batch.build_site_run", explode)
    ok, summary = run_site(
        "l1943-7827",
        build_root=workspace["build"],
        registry_path=workspace["registry"],
        state_dir=workspace["state"],
    )
    assert ok and "SKIPPED" in summary


def test_a_published_site_whose_scratch_was_evicted_is_still_skipped(workspace, monkeypatch):
    """Eviction is the normal finished state, not a reason to rebuild 9 MB."""
    publish(workspace, "l1943-7827")
    import shutil

    shutil.rmtree(workspace["build"] / "l1943-7827")

    monkeypatch.setattr(
        "fornborg_pipeline.batch.build_site_run",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not rebuild")),
    )
    ok, summary = run_site(
        "l1943-7827",
        build_root=workspace["build"],
        registry_path=workspace["registry"],
        state_dir=workspace["state"],
    )
    assert ok and "scratch evicted" in summary


def test_a_site_that_failed_qa_is_rebuilt_not_skipped(workspace, monkeypatch):
    publish(workspace, "l1943-7827", qa_passed=False, uploaded=False)
    calls = []
    monkeypatch.setattr(
        "fornborg_pipeline.batch.build_site_run",
        lambda slug, out_dir, **k: calls.append(slug) or _stub_result(slug, out_dir),
    )
    run_site(
        "l1943-7827",
        build_root=workspace["build"],
        registry_path=workspace["registry"],
        state_dir=workspace["state"],
        upload=False,
    )
    assert calls == ["l1943-7827"]


def _stub_result(slug, out_dir):
    from fornborg_pipeline.build_site import BuildResult, StepResult
    from fornborg_pipeline.qa import Check, QAReport

    result = BuildResult(slug, out_dir, [StepResult("grids", "ok")], bytes_written=1234)
    result.qa = QAReport(slug, [Check("x", "pass", "fine")])
    return result


def test_a_build_crash_is_reported_not_raised(workspace, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("STAC went away")

    monkeypatch.setattr("fornborg_pipeline.batch.build_site_run", boom)
    ok, summary = run_site(
        "l1943-7827",
        build_root=workspace["build"],
        registry_path=workspace["registry"],
        state_dir=workspace["state"],
    )
    assert not ok
    assert "STAC went away" in summary
    assert SiteState.load("l1943-7827", workspace["state"]).lastError.endswith("STAC went away")


# ----------------------------------- index -----------------------------------


def test_index_lists_only_published_qa_clean_sites(workspace):
    publish(workspace, "l1943-7827", qa_passed=True, uploaded=True)
    publish(workspace, "l1976-4254", qa_passed=False, uploaded=False)
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    assert index["count"] == 1
    assert [s["slug"] for s in index["sites"]] == ["l1943-7827"]


def test_index_carries_what_the_picker_needs(workspace):
    publish(workspace, "l1943-7827")
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    site = index["sites"][0]
    assert site["name"] == "Broborg"
    assert site["county"] == "Uppsala"
    assert (site["centerE"], site["centerN"]) == (665810.0, 6627880.0)
    assert site["bundle"] == "l1943-7827/"
    assert site["thumbnail"] == "l1943-7827/thumbnail.png"
    assert site["features"] == {"water": True, "palisade": True, "landcover": False, "rings": 4}
    assert site["horizonKm"] == 24.8
    assert site["antikvariskBedomning"] == "Fornlämning"


def test_index_records_the_registry_it_came_from(workspace):
    publish(workspace, "l1943-7827")
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    assert index["registry"]["totalRegistered"] == 1304
    assert index["schemaVersion"] == 1


def test_index_sorts_by_county_then_name(workspace):
    publish(workspace, "l1943-7827")
    publish(workspace, "l1976-4254")
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    assert [s["county"] for s in index["sites"]] == ["Gotland", "Uppsala"]


def test_index_survives_a_site_whose_manifest_is_gone(workspace):
    publish(workspace, "l1943-7827")
    (workspace["build"] / "l1943-7827" / "manifest.json").unlink()
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    # No manifest and no archived report: the site is omitted rather than
    # guessed at, because the index is a promise about what is fetchable.
    assert index["count"] == 0


def test_index_recovers_a_site_from_its_archived_report(workspace):
    """After eviction the manifest is only on the object host; the report remains."""
    publish(workspace, "l1943-7827")
    import shutil

    shutil.rmtree(workspace["build"] / "l1943-7827")
    reports = workspace["state"] / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    (reports / "l1943-7827.json").write_text(
        json.dumps(
            {
                "steps": [{"name": "rampart", "status": "ok"}],
                "qa": {
                    "checks": [
                        {"id": "ladder", "severity": "pass", "message": "ok", "detail": {"ringCount": 4, "distanceKm": 24.8}},
                        {"id": "water-pair", "severity": "pass", "message": "shoreline + connectivity as delta (§12)"},
                    ]
                },
            }
        ),
        encoding="utf-8",
    )
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    assert index["count"] == 1
    assert index["sites"][0]["features"]["rings"] == 4
    assert index["sites"][0]["features"]["water"] is True
    assert index["sites"][0]["features"]["palisade"] is True


def test_index_writes_swedish_names_unescaped(workspace, tmp_path):
    publish(workspace, "l1943-7827")
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    path = write_index(tmp_path / "index.json", index)
    assert "Fornlämning" in path.read_text(encoding="utf-8")


# ------------------------------- contact sheet -------------------------------


def test_contact_sheet_shows_every_indexed_site(workspace):
    publish(workspace, "l1943-7827")
    publish(workspace, "l1976-4254")
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    html = contact_sheet_html(index, {s["slug"]: s["thumbnail"] for s in index["sites"]})
    assert html.count("<figure>") == 2
    assert "Broborg" in html and "Torsburgen" in html
    assert "large preset" in html  # Torsburgen's §5.2 preset is worth seeing


def test_contact_sheet_prefers_the_local_thumbnail_archive(workspace, tmp_path):
    publish(workspace, "l1943-7827")
    thumbs = workspace["state"] / "thumbnails"
    thumbs.mkdir(parents=True, exist_ok=True)
    (thumbs / "l1943-7827.png").write_bytes(b"png")
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])

    src = thumbnail_src(index["sites"][0], tmp_path, workspace["state"], "https://x.r2.dev/v1")
    assert src.endswith("l1943-7827.png")
    assert not src.startswith("http"), "a local copy must not cost an object-host request"


def test_contact_sheet_falls_back_to_the_published_url(workspace, tmp_path):
    publish(workspace, "l1943-7827")
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    src = thumbnail_src(index["sites"][0], tmp_path, workspace["state"], "https://x.r2.dev/v1")
    assert src == "https://x.r2.dev/v1/l1943-7827/thumbnail.png"


def test_contact_sheet_escapes_site_names(workspace):
    hostile = dict(REGISTRY["sites"][0], name="<script>alert(1)</script>")
    index = {
        "count": 1,
        "generated": "2026-08-22",
        "registry": {"totalRegistered": 1304},
        "sites": [index_entry(hostile, MANIFEST, SiteState(slug=hostile["slug"]))],
    }
    html = contact_sheet_html(index, {})
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html


def test_contact_sheet_writes_a_file(workspace, tmp_path):
    publish(workspace, "l1943-7827")
    index = build_index(workspace["registry"], workspace["state"], workspace["build"])
    path = write_contact_sheet(tmp_path / "sheet.html", index, state_dir=workspace["state"])
    assert path.exists() and "<!doctype html>" in path.read_text(encoding="utf-8")


# ---------------------------------- eviction ---------------------------------


def test_evict_removes_only_this_sites_cached_mosaics(tmp_path, monkeypatch):
    monkeypatch.setattr("fornborg_pipeline.batch.CACHE_DIR", tmp_path)
    for name in (
        "l1943-7827_dem_source.tif",
        "l1943-7827_dem_ring3.tif",
        "l1976-4254_dem_source.tif",
        "lamningar_sverige.gpkg",
    ):
        (tmp_path / name).write_bytes(b"x" * 100)

    assert len(site_cache_files("l1943-7827")) == 2
    freed = evict_site_cache("l1943-7827")
    assert freed == 200
    remaining = sorted(p.name for p in tmp_path.iterdir())
    assert remaining == ["l1976-4254_dem_source.tif", "lamningar_sverige.gpkg"]
