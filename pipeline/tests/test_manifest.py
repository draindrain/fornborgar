"""manifest.json contract tests (docs/data-formats.md §2). No network."""

from __future__ import annotations

import copy
import json

import pytest

from fornborg_pipeline.clip_dem import build_grids
from fornborg_pipeline.manifest import (
    LANDCOVER_LAYER,
    SCHEMA_VERSION,
    SGU_ATTRIBUTION,
    SGU_SHORELINE_ATTRIBUTION,
    add_landcover_asset,
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
    # The shoreline section credits the shoreline product in the v1.1 wording; the
    # manifest's single SGU entry carries the widened v1.2 text (see below).
    assert SGU_SHORELINE_ATTRIBUTION["text"].split("(")[0].strip() in text
    assert "landcover.tif" not in text  # no land-cover assets shipped for this site


# --------------------------------------------------------------------------- #
# v1.2 land-cover assets (docs/data-formats.md §9/§10 + the amendment preamble)
# --------------------------------------------------------------------------- #

SOILS_META = {
    "product": "SGU Jordarter 1:25 000–1:100 000",
    "api": "https://api.sgu.se/oppnadata/jordarter25k-100k/ogc/features/v1",
    "collections": ["grundlager", "ytlager"],
    "fetched": "2026-08-21T12:00:00+00:00",
    "referenceYearCE": 500,
}


@pytest.fixture
def landcover_manifest(water_manifest):
    patched = copy.deepcopy(water_manifest)
    add_landcover_asset(
        patched,
        "landcover.tif",
        "landcover_legend.json",
        source={"id": "sgu-jordarter", "fetched": SOILS_META["fetched"]},
        processing=["rule-based land-cover classification"],
    )
    return patched


def test_add_landcover_asset_wires_up_the_whole_v12_bundle(landcover_manifest):
    assert landcover_manifest["schemaVersion"] == SCHEMA_VERSION  # additive: no bump
    assert landcover_manifest["assets"]["landcover"] == "landcover.tif"
    assert landcover_manifest["assets"]["landcoverLegend"] == "landcover_legend.json"
    assert [layer["id"] for layer in landcover_manifest["layers"]] == [
        "terrain",
        "sites",
        "water",
        "landcover",
    ]
    assert landcover_manifest["layers"][-1] == LANDCOVER_LAYER
    assert LANDCOVER_LAYER["provenance"] == "model"
    assert SGU_ATTRIBUTION in landcover_manifest["attribution"]
    assert any(
        s["id"] == "sgu-jordarter" for s in landcover_manifest["provenance"]["sources"]
    )
    validate_manifest(landcover_manifest)


def test_add_landcover_asset_is_idempotent(landcover_manifest):
    twice = copy.deepcopy(landcover_manifest)
    add_landcover_asset(twice, "landcover.tif", "landcover_legend.json")
    assert twice["layers"] == landcover_manifest["layers"]
    assert twice["attribution"] == landcover_manifest["attribution"]
    assert twice["assets"] == landcover_manifest["assets"]


def test_landcover_layer_is_inserted_between_water_and_palisade(water_manifest):
    """Contract §9: terrain, sites, water, landcover, palisade — in that order."""
    patched = copy.deepcopy(water_manifest)
    patched["layers"].append(
        {"id": "palisade", "name": "Palisade (conjecture)", "provenance": "conjecture"}
    )
    add_landcover_asset(patched, "landcover.tif", "landcover_legend.json")
    assert [layer["id"] for layer in patched["layers"]] == [
        "terrain",
        "sites",
        "water",
        "landcover",
        "palisade",
    ]


def test_the_sgu_credit_is_widened_in_place_not_duplicated(manifest):
    """v1.2: one SGU entry total — the shoreline-only wording is replaced."""
    patched = copy.deepcopy(manifest)
    patched["attribution"].append(dict(SGU_SHORELINE_ATTRIBUTION))
    position = len(patched["attribution"]) - 1
    add_water_assets(patched, "shoreline.json", "water_connect.tif")
    add_landcover_asset(patched, "landcover.tif", "landcover_legend.json")
    sgu = [
        entry
        for entry in patched["attribution"]
        if entry["url"] == SGU_ATTRIBUTION["url"]
    ]
    assert sgu == [SGU_ATTRIBUTION]  # exactly one, carrying the widened text
    assert patched["attribution"][position] == SGU_ATTRIBUTION  # kept its footer slot


def test_a_v11_manifest_carrying_the_narrow_sgu_text_still_validates(water_manifest):
    """Manifests written before the widening must not start failing the validator."""
    legacy = copy.deepcopy(water_manifest)
    legacy["attribution"] = [
        SGU_SHORELINE_ATTRIBUTION if entry == SGU_ATTRIBUTION else entry
        for entry in legacy["attribution"]
    ]
    validate_manifest(legacy)


@pytest.mark.parametrize(
    "mutate, match",
    [
        (lambda m: m["assets"].pop("landcoverLegend"), "pair"),
        (lambda m: m["assets"].pop("landcover"), "pair"),
        (lambda m: m["layers"][-1].update(provenance="measured"), "must be 'model'"),
        (lambda m: m["layers"].pop(-1), "no 'landcover' layer entry"),
        (lambda m: m["attribution"].remove(SGU_ATTRIBUTION), "SGU attribution entry is missing"),
        (lambda m: m["assets"].update(landcover="/data/landcover.tif"), "relative"),
    ],
)
def test_validator_rejects_broken_landcover_wiring(landcover_manifest, mutate, match):
    broken = copy.deepcopy(landcover_manifest)
    mutate(broken)
    with pytest.raises(ValueError, match=match):
        validate_manifest(broken)


def test_a_v1_manifest_without_landcover_still_validates(manifest):
    """A missing assets entry always means 'feature off', never an error."""
    assert "landcover" not in manifest["assets"]
    assert not any(layer["id"] == "landcover" for layer in manifest["layers"])
    validate_manifest(manifest)


def test_data_licenses_gains_a_jordarter_section_when_landcover_ships(tmp_path, fake_site):
    path = write_data_licenses(
        tmp_path / "DATA-LICENSES.md",
        fake_site,
        SOURCE_META,
        water_meta=WATER_META,
        soils_meta=SOILS_META,
    )
    text = path.read_text(encoding="utf-8")
    assert "`landcover.tif`, `landcover_legend.json`" in text
    assert "Jordarter" in text and "`grundlager`, `ytlager`" in text
    assert SOILS_META["fetched"] in text
    assert "500 CE" in text
    # The widened v1.2 credit, un-wrapping the template's line break.
    assert SGU_ATTRIBUTION["text"].split("(")[0].strip() in " ".join(text.split())
    # Re-running the land-cover step must not drop the section the water step owns.
    assert "Strandförskjutningsmodell" in text and "`bp1000-1900`" in text
    assert "Nothing SGU-related is outstanding" in text


# --------------------------------------------------------------------------- #
# v1.4 §11 — far-field rings
# --------------------------------------------------------------------------- #

import numpy as np
from affine import Affine

from fornborg_pipeline.clip_dem import build_grid
from fornborg_pipeline.horizon import horizon_info
from fornborg_pipeline.manifest import add_rings, set_ring_water_connect
from fornborg_pipeline.sites import GridSpec


def _ring_grid(cfg, name, half_extent, resolution, scale, path):
    spec = GridSpec(name, half_extent=half_extent, resolution=resolution, path=path,
                    quant_scale=scale)
    west, _s, _e, north = cfg.bounds3006(half_extent)
    transform = Affine(resolution, 0.0, west, 0.0, -resolution, north)
    source = np.full((spec.size, spec.size), 20.0, dtype=np.float32)
    return build_grid(source, transform, spec, cfg, source_resolution=resolution)


@pytest.fixture
def ringed_manifest(manifest, fake_site):
    rings = [
        _ring_grid(fake_site, "ring3", 400.0, 4.0, 0.5, "dem_ring3.tif"),
        _ring_grid(fake_site, "ring4", 800.0, 8.0, 0.5, "dem_ring4.tif"),
    ]
    return add_rings(manifest, rings, fake_site, horizon_info(50.0, 5.0),
                     processing=("far-field rings: decimated overview reads",))


def test_ringed_manifest_passes_the_validator(ringed_manifest):
    validate_manifest(ringed_manifest)


def test_ring_entries_carry_their_own_scale(ringed_manifest):
    rings = ringed_manifest["grids"]["rings"]
    assert [r["path"] for r in rings] == ["dem_ring3.tif", "dem_ring4.tif"]
    assert all(r["encoding"] == {"dtype": "int16", "scale": 0.5, "unit": "m"} for r in rings)
    assert ringed_manifest["horizon"]["eyeM"] == 2.0
    steps = ringed_manifest["provenance"]["processing"]
    assert "far-field rings: decimated overview reads" in steps


def test_core_and_context_still_require_decimeters(ringed_manifest):
    broken = copy.deepcopy(ringed_manifest)
    broken["grids"]["context"]["encoding"]["scale"] = 0.5
    with pytest.raises(ValueError, match="scale"):
        validate_manifest(broken)


def test_rings_reject_an_uncontracted_scale(ringed_manifest):
    broken = copy.deepcopy(ringed_manifest)
    broken["grids"]["rings"][0]["encoding"]["scale"] = 0.25
    with pytest.raises(ValueError, match="scale"):
        validate_manifest(broken)


def test_rings_must_be_ordered_inside_out(ringed_manifest):
    broken = copy.deepcopy(ringed_manifest)
    broken["grids"]["rings"].reverse()
    with pytest.raises(ValueError, match="inside-out|containment"):
        validate_manifest(broken)


def test_rings_must_coarsen_outward(ringed_manifest, fake_site):
    broken = copy.deepcopy(ringed_manifest)
    # Same containment, but the outer ring is as fine as the inner one.
    fine_outer = _ring_grid(fake_site, "ring4", 800.0, 4.0, 0.5, "dem_ring4.tif")
    from fornborg_pipeline.manifest import grid_entry
    broken["grids"]["rings"][1] = grid_entry(fine_outer, fake_site)
    broken["grids"]["rings"][0] = grid_entry(
        _ring_grid(fake_site, "ring3", 400.0, 4.0, 0.5, "dem_ring3.tif"), fake_site
    )
    with pytest.raises(ValueError, match="coarser"):
        validate_manifest(broken)


def test_ring_water_connect_requires_the_water_pair(ringed_manifest):
    broken = copy.deepcopy(ringed_manifest)
    set_ring_water_connect(broken, "dem_ring4.tif", "water_connect_ring4.tif")
    with pytest.raises(ValueError, match="water pair"):
        validate_manifest(broken)


def test_ring_water_connect_with_the_water_pair_validates(ringed_manifest):
    with_water = copy.deepcopy(ringed_manifest)
    add_water_assets(with_water, "shoreline.json", "water_connect.tif")
    set_ring_water_connect(with_water, "dem_ring4.tif", "water_connect_ring4.tif")
    validate_manifest(with_water)
    assert with_water["grids"]["rings"][1]["waterConnect"] == "water_connect_ring4.tif"
    assert "waterConnect" not in with_water["grids"]["rings"][0]


def test_at_most_one_ring_water_connect(ringed_manifest):
    broken = copy.deepcopy(ringed_manifest)
    add_water_assets(broken, "shoreline.json", "water_connect.tif")
    for ring in broken["grids"]["rings"]:
        ring["waterConnect"] = "water_connect_ring4.tif"
    with pytest.raises(ValueError, match="at most one"):
        validate_manifest(broken)


def test_set_ring_water_connect_requires_the_ring(ringed_manifest):
    with pytest.raises(ValueError, match="no ring entry"):
        set_ring_water_connect(copy.deepcopy(ringed_manifest), "dem_ring7.tif", "x.tif")


def test_horizon_block_must_be_numeric(ringed_manifest):
    broken = copy.deepcopy(ringed_manifest)
    broken["horizon"]["distanceKm"] = "far"
    with pytest.raises(ValueError, match="horizon.distanceKm"):
        validate_manifest(broken)


def test_ringless_manifest_still_validates(manifest):
    # v1 manifests carry no rings and no horizon — feature off, never an error.
    assert "rings" not in manifest["grids"]
    validate_manifest(manifest)


def test_add_rings_replaces_stale_ring_seam_lines(ringed_manifest, fake_site):
    """A re-run with full tile coverage must retract an earlier run's sea-fill
    provenance line, not accumulate it (the 2026-08-21 ring4 regression)."""
    stale = "ring4: 7140 cells outside tile coverage sea-filled at 0 m (…)"
    ringed_manifest["provenance"]["processing"].append(stale)
    other = "priority-flood sea-connectivity grid (int16 dm, ceil-quantized)"
    ringed_manifest["provenance"]["processing"].append(other)
    rings = [
        _ring_grid(fake_site, "ring3", 400.0, 4.0, 0.5, "dem_ring3.tif"),
        _ring_grid(fake_site, "ring4", 800.0, 8.0, 0.5, "dem_ring4.tif"),
    ]
    add_rings(ringed_manifest, rings, fake_site, horizon_info(50.0, 5.0),
              processing=("far-field rings: decimated overview reads",))
    steps = ringed_manifest["provenance"]["processing"]
    assert stale not in steps
    assert other in steps
    assert steps.count("far-field rings: decimated overview reads") == 1
