"""manifest.json contract tests (docs/data-formats.md §2). No network."""

from __future__ import annotations

import copy
import json

import pytest

from fornborg_pipeline.clip_dem import build_grids
from fornborg_pipeline.manifest import (
    SCHEMA_VERSION,
    SGU_ATTRIBUTION,
    add_water_assets,
    build_manifest,
    local_bounds,
    validate_manifest,
    write_data_licenses,
    write_manifest,
)
from fornborg_pipeline.sites import BROBORG

SOURCE_META = {
    "stacItems": ["662_66"],
    "product": "Markhöjdmodell Nedladdning (dtm-cog)",
    "fetched": "2026-08-20T10:00:00+00:00",
}
WATER_META = {
    "product": "SGU Strandförskjutningsmodell",
    "api": "https://api.sgu.se/oppnadata/strandforskjutningsmodell/ogc/features/v1",
    "collections": ["bp1-900", "bp1000-1900", "bp2000-2900", "bp3000-3900"],
    "fetched": "2026-08-20T11:00:00+00:00",
}


@pytest.fixture
def manifest(fake_site, fake_source):
    holed, transform, nodata, _ = fake_source
    grids = build_grids(holed, transform, nodata, fake_site)
    return build_manifest(fake_site, grids, SOURCE_META, generated="2026-08-20T12:00:00+00:00")


def test_manifest_passes_its_own_validator(manifest):
    validate_manifest(manifest)


def test_manifest_top_level_shape(manifest, fake_site):
    assert manifest["schemaVersion"] == SCHEMA_VERSION == 1
    assert manifest["site"]["id"] == fake_site.id
    assert manifest["site"]["name"] == fake_site.name
    assert manifest["site"]["raa"] == fake_site.raa
    assert manifest["crs"] == {"horizontal": "EPSG:3006", "verticalDatum": "RH2000"}
    assert manifest["origin"] == {"e": fake_site.center_e, "n": fake_site.center_n}
    assert set(manifest["grids"]) == {"core", "context"}
    assert manifest["assets"]["sites"] == "sites.json"
    assert [layer["id"] for layer in manifest["layers"]] == ["terrain", "sites"]
    assert all(layer["provenance"] == "measured" for layer in manifest["layers"])
    assert [a["license"] for a in manifest["attribution"]] == ["CC BY 4.0", "CC0"]
    assert "Lantmäteriet" in manifest["attribution"][0]["text"]
    assert "Riksantikvarieämbetet" in manifest["attribution"][1]["text"]


def test_manifest_provenance_records_the_real_source(manifest):
    prov = manifest["provenance"]
    assert prov["generated"] == "2026-08-20T12:00:00+00:00"
    assert prov["pipeline"] == "fornborg-pipeline"
    source = prov["sources"][0]
    assert source["id"] == "lantmateriet-dtm"
    assert source["tiles"] == ["662_66"]
    assert source["fetched"] == SOURCE_META["fetched"]
    assert any(step.startswith("nodata fill (") for step in prov["processing"])


def test_grid_entries_are_numeric_and_complete(manifest):
    for name, grid in manifest["grids"].items():
        assert isinstance(grid["path"], str) and grid["path"].endswith(".tif")
        assert not grid["path"].startswith("/") and ".." not in grid["path"]
        for key in ("resolution", "minElevation", "maxElevation"):
            assert isinstance(grid[key], (int, float)), f"{name}.{key} must be a JSON number"
        assert isinstance(grid["width"], int) and isinstance(grid["height"], int)
        assert grid["encoding"] == {"dtype": "int16", "scale": 0.1, "unit": "m"}


def test_width_height_match_bounds_and_resolution(manifest):
    for name, grid in manifest["grids"].items():
        b = grid["bounds3006"]
        assert grid["width"] == (b["maxE"] - b["minE"]) / grid["resolution"], name
        assert grid["height"] == (b["maxN"] - b["minN"]) / grid["resolution"], name


def test_bounds_local_follows_the_scene_convention(manifest):
    origin = manifest["origin"]
    for name, grid in manifest["grids"].items():
        b, local = grid["bounds3006"], grid["boundsLocal"]
        assert local["minX"] == b["minE"] - origin["e"], name
        assert local["maxX"] == b["maxE"] - origin["e"], name
        # minZ corresponds to the NORTH edge (z = -(N - origin.n)).
        assert local["minZ"] == -(b["maxN"] - origin["n"]), name
        assert local["maxZ"] == -(b["minN"] - origin["n"]), name
        assert local["minX"] < local["maxX"] and local["minZ"] < local["maxZ"]


def test_core_is_strictly_inside_context(manifest):
    core = manifest["grids"]["core"]["bounds3006"]
    context = manifest["grids"]["context"]["bounds3006"]
    assert context["minE"] < core["minE"] < core["maxE"] < context["maxE"]
    assert context["minN"] < core["minN"] < core["maxN"] < context["maxN"]


def test_local_bounds_helper_matches_the_documented_broborg_numbers():
    """The worked example in docs/data-formats.md §2."""
    core = local_bounds((664810.0, 6626880.0, 666810.0, 6628880.0), 665810.0, 6627880.0)
    assert core == {"minX": -1000.0, "minZ": -1000.0, "maxX": 1000.0, "maxZ": 1000.0}
    context = local_bounds((663810.0, 6625880.0, 667810.0, 6629880.0), 665810.0, 6627880.0)
    assert context == {"minX": -2000.0, "minZ": -2000.0, "maxX": 2000.0, "maxZ": 2000.0}


def test_broborg_site_config_matches_the_contract_example():
    assert BROBORG.center_e == 665810.0 and BROBORG.center_n == 6627880.0
    assert BROBORG.bounds3006(BROBORG.core.half_extent) == (
        664810.0,
        6626880.0,
        666810.0,
        6628880.0,
    )
    assert BROBORG.bounds3006(BROBORG.context.half_extent) == (
        663810.0,
        6625880.0,
        667810.0,
        6629880.0,
    )
    assert BROBORG.core.size == 2000 and BROBORG.context.size == 2000
    assert BROBORG.raa["lamningsnummer"] == "L1943:7827"
    assert BROBORG.raa["kmrUuid"] == "184ca0f6-16f9-4de8-bbec-99aa959f9824"


# --------------------------------------------------------------------------- #
# the validator must actually reject violations
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "mutate, match",
    [
        (lambda m: m.update(schemaVersion=2), "schemaVersion"),
        (lambda m: m["grids"]["core"].update(width=1999), "width"),
        (lambda m: m["grids"]["core"]["boundsLocal"].update(minZ=1000.0), "boundsLocal.minZ"),
        (lambda m: m["grids"]["core"]["bounds3006"].update(minE=0.0), "width"),
        (lambda m: m["grids"]["core"].update(minElevation=-500.0), "outside"),
        (lambda m: m["grids"]["context"].update(maxElevation=9999.0), "outside"),
        (lambda m: m["grids"]["core"]["encoding"].update(scale=1.0), "scale"),
        (lambda m: m["layers"][0].update(provenance="guess"), "provenance"),
        (lambda m: m["assets"].update(sites="../secrets.json"), "relative"),
        (lambda m: m["grids"].pop("context"), "context"),
    ],
)
def test_validator_rejects(manifest, mutate, match):
    broken = copy.deepcopy(manifest)
    mutate(broken)
    with pytest.raises(ValueError, match=match):
        validate_manifest(broken)


def test_core_outside_context_is_rejected(manifest):
    broken = copy.deepcopy(manifest)
    # Blow the core out to exactly the context extent, keeping width/height consistent.
    core, context = broken["grids"]["core"], broken["grids"]["context"]
    core["bounds3006"] = dict(context["bounds3006"])
    core["boundsLocal"] = dict(context["boundsLocal"])
    core["width"] = core["height"] = 400
    with pytest.raises(ValueError, match="strictly inside"):
        validate_manifest(broken)


# --------------------------------------------------------------------------- #
# files on disk
# --------------------------------------------------------------------------- #


def test_write_manifest_roundtrips_as_utf8_json(tmp_path, manifest):
    path = write_manifest(tmp_path / "manifest.json", manifest)
    reloaded = json.loads(path.read_text(encoding="utf-8"))
    assert reloaded == manifest
    validate_manifest(reloaded)
    assert "Höjddata" in path.read_text(encoding="utf-8")  # not ö-escaped


def test_write_manifest_refuses_an_invalid_manifest(tmp_path, manifest):
    broken = copy.deepcopy(manifest)
    broken["schemaVersion"] = 99
    with pytest.raises(ValueError):
        write_manifest(tmp_path / "manifest.json", broken)
    assert not (tmp_path / "manifest.json").exists()


def test_data_licenses_names_every_source(tmp_path, fake_site):
    path = write_data_licenses(tmp_path / "DATA-LICENSES.md", fake_site, SOURCE_META)
    text = path.read_text(encoding="utf-8")
    assert "CC BY 4.0" in text and "CC0" in text
    assert "Lantmäteriet" in text and "Riksantikvarieämbetet" in text
    assert "662_66" in text
    assert "RH 2000" in text and "EPSG:3006" in text
    assert "shoreline.json" not in text  # no water assets shipped for this site


# --------------------------------------------------------------------------- #
# v1.1 water assets (docs/data-formats.md §6/§7 + the amendment preamble)
# --------------------------------------------------------------------------- #


@pytest.fixture
def water_manifest(manifest):
    patched = copy.deepcopy(manifest)
    add_water_assets(
        patched,
        "shoreline.json",
        "water_connect.tif",
        source={"id": "sgu-strandforskjutning", "fetched": WATER_META["fetched"]},
        processing=["priority-flood sea-connectivity grid"],
    )
    return patched


def test_add_water_assets_wires_up_the_whole_v11_bundle(water_manifest):
    assert water_manifest["schemaVersion"] == SCHEMA_VERSION  # additive: no bump
    assert water_manifest["assets"]["shoreline"] == "shoreline.json"
    assert water_manifest["assets"]["waterConnect"] == "water_connect.tif"
    assert [layer["id"] for layer in water_manifest["layers"]] == ["terrain", "sites", "water"]
    water = water_manifest["layers"][-1]
    assert water == {"id": "water", "name": "Paleo-shoreline (SGU model)", "provenance": "model"}
    assert SGU_ATTRIBUTION in water_manifest["attribution"]
    assert water_manifest["attribution"][-1]["license"] == "CC0"
    assert any(
        s["id"] == "sgu-strandforskjutning" for s in water_manifest["provenance"]["sources"]
    )
    validate_manifest(water_manifest)


def test_add_water_assets_is_idempotent(water_manifest):
    twice = copy.deepcopy(water_manifest)
    add_water_assets(twice, "shoreline.json", "water_connect.tif")
    assert twice["layers"] == water_manifest["layers"]
    assert twice["attribution"] == water_manifest["attribution"]
    assert twice["assets"] == water_manifest["assets"]


def test_water_layer_is_inserted_before_the_palisade_layer(manifest):
    patched = copy.deepcopy(manifest)
    patched["layers"].append(
        {"id": "palisade", "name": "Palisade (conjecture)", "provenance": "conjecture"}
    )
    add_water_assets(patched, "shoreline.json", "water_connect.tif")
    assert [layer["id"] for layer in patched["layers"]] == [
        "terrain",
        "sites",
        "water",
        "palisade",
    ]


@pytest.mark.parametrize(
    "mutate, match",
    [
        (lambda m: m["assets"].pop("waterConnect"), "pair"),
        (lambda m: m["assets"].pop("shoreline"), "pair"),
        (lambda m: m["layers"][-1].update(provenance="measured"), "must be 'model'"),
        (
            lambda m: (m["assets"].pop("shoreline"), m["assets"].pop("waterConnect")),
            "credit a source it never loads",
        ),
        (
            lambda m: m["attribution"].remove(SGU_ATTRIBUTION),
            "SGU attribution entry is missing",
        ),
        (lambda m: m["assets"].update(shoreline="/data/shoreline.json"), "relative"),
    ],
)
def test_validator_rejects_broken_water_wiring(water_manifest, mutate, match):
    broken = copy.deepcopy(water_manifest)
    mutate(broken)
    with pytest.raises(ValueError, match=match):
        validate_manifest(broken)


def test_a_v1_manifest_without_water_still_validates(manifest):
    """A missing assets entry always means 'feature off', never an error."""
    assert "shoreline" not in manifest["assets"]
    validate_manifest(manifest)


def test_data_licenses_gains_an_sgu_section_when_water_ships(tmp_path, fake_site):
    path = write_data_licenses(
        tmp_path / "DATA-LICENSES.md", fake_site, SOURCE_META, water_meta=WATER_META
    )
    text = path.read_text(encoding="utf-8")
    assert "Strandförskjutningsmodell" in text
    assert "`shoreline.json`, `water_connect.tif`" in text
    assert "`bp1000-1900`" in text
    assert WATER_META["fetched"] in text
    assert "±500" in text
    assert SGU_ATTRIBUTION["text"].split("(")[0].strip() in text
