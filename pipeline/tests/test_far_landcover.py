"""Far-field land-cover contract tests (docs/data-formats.md v1.6 §13). No network.

Everything here runs on synthetic grids: the far classifier reads elevation and
slope and nothing else, so a hand-built ramp with a sea band, a flat lake and a
scarp exercises every branch with the extent of each one known in advance.

The load-bearing test is `test_the_patch_mosaic_is_anchored_to_the_world_...`:
the rings overlap (ring4 covers all of ring3), so the mosaic must be a function of
the ground, not of the raster it is being drawn on. A grid-anchored noise field
would classify the same hillside differently in each ring and put a visible tint
seam exactly where the two meet.
"""

from __future__ import annotations

import copy
import json

import numpy as np
import pytest
import rasterio
from affine import Affine

from fornborg_pipeline.clip_dem import build_grid, build_grids, write_class_grid, write_grid
from fornborg_pipeline.far_landcover import (
    BILLBOARD_DENSITY_PER_HA,
    BROADLEAF_SHARE_FALLBACK,
    FAR_CLASS_BROADLEAF,
    FAR_CLASS_CONIFER,
    FAR_CLASS_OPEN,
    FAR_CLASS_ROCK,
    FAR_CLASS_SEA,
    FAR_CLASS_WATER_FLAT,
    FLAT_MAX_SLOPE_DEG,
    PATCH_SIZE_M,
    ROCK_MIN_SLOPE_DEG,
    SEA_MAX_M,
    FarLandcoverError,
    classify_far,
    context_mosaic_ratio,
    far_field_block,
    patch_uniform,
    ring_landcover_path,
    site_seed,
)
from fornborg_pipeline.horizon import horizon_info
from fornborg_pipeline.landcover import (
    DEFAULT_PARAMS,
    LANDCOVER_LEGEND_PATH,
    LANDCOVER_PATH,
    LandcoverError,
    build_legend,
    landcover_classes,
    validate_legend,
)
from fornborg_pipeline.manifest import (
    add_landcover_asset,
    add_rings,
    attach_ring_landcover,
    build_manifest,
    validate_manifest,
)
from fornborg_pipeline.sites import GridSpec
from fornborg_pipeline.zones import ZoneAssignment

SEED = site_seed("testsite")

# A patch of world large enough to hold ~100x100 mosaic patches, so a measured
# open/forest share is a distribution and not four coin flips.
MOSAIC_SIZE = 400
MOSAIC_RESOLUTION = 64.0
MOSAIC_TRANSFORM = Affine(
    MOSAIC_RESOLUTION, 0.0, 500000.0, 0.0, -MOSAIC_RESOLUTION, 6600000.0
)

#: Boreonemoral and southern boreal assignments built directly: these tests
#: exercise what the far classifier does WITH a zone; test_zones.py owns how one
#: is derived.
BOREONEMORAL = ZoneAssignment(
    zone="boreonemoral",
    zone_name="boreonemoral",
    lat=59.7,
    lon=17.9,
    island=False,
    effective_lat=59.9,
    spruce_present=True,
)
S_BOREAL = ZoneAssignment(
    zone="s_boreal",
    zone_name="southern boreal",
    lat=62.6,
    lon=17.9,
    island=False,
    effective_lat=62.9,
    spruce_present=True,
)


def flat_world(
    size: int = MOSAIC_SIZE,
    transform: Affine = MOSAIC_TRANSFORM,
    height: float = 20.0,
    slope: float = 1.0,
):
    """Ground with nothing but the mosaic left to decide: dry, gentle, everywhere."""
    return (
        np.full((size, size), height, dtype=np.float64),
        np.full((size, size), slope, dtype=np.float64),
        transform,
    )


# --------------------------------------------------------------------------- #
# the classifier's four thresholds (contract §13)
# --------------------------------------------------------------------------- #


def test_sea_is_an_elevation_threshold_not_a_shoreline():
    heights, slope, transform = flat_world(size=40)
    heights[:10, :] = 0.0  # the ring build's sea fill and the modern Baltic alike
    heights[10:12, :] = SEA_MAX_M  # exactly at the threshold: still sea
    heights[12:14, :] = SEA_MAX_M + 0.5

    classes = classify_far(heights, slope, transform, 0.4, 0.4, BOREONEMORAL, SEED)
    assert np.all(classes[:12, :] == FAR_CLASS_SEA)
    assert np.all(classes[12:14, :] != FAR_CLASS_SEA)


def test_only_a_large_single_elevation_flat_component_reads_as_still_water():
    """The lake test: flatness alone is NOT water (it called 60 % of Eketorp's
    ring3 "lake" — the alvar pavement is exactly level at 0.5 m quantization).
    A lake is a connected component of at least LAKE_MIN_COMPONENT_HA at one
    exact elevation; at 100 m cells that is 200 cells."""
    heights, slope, transform = flat_world(size=40)
    slope[5:20, 5:20] = 0.0  # 225 cells at 100 m = 225 ha, one elevation -> lake
    slope[30:33, 30:33] = 0.0  # 9 cells = 9 ha: far below the floor -> land

    classes = classify_far(
        heights, slope, transform, 0.4, 0.4, BOREONEMORAL, SEED, resolution_m=100.0
    )
    assert np.all(classes[5:20, 5:20] == FAR_CLASS_WATER_FLAT)
    assert FAR_CLASS_WATER_FLAT not in set(np.unique(classes[30:33, 30:33]))


def test_a_big_flat_component_spanning_two_elevations_is_land_not_lake():
    """The constancy guard: a plain can be flat, but only water is at ONE exact
    level across a whole component."""
    heights, slope, transform = flat_world(size=40)
    slope[5:20, 5:20] = 0.0
    heights[5:20, 12:20] += 0.5  # one quantization step across the patch

    classes = classify_far(
        heights, slope, transform, 0.4, 0.4, BOREONEMORAL, SEED, resolution_m=100.0
    )
    assert FAR_CLASS_WATER_FLAT not in set(np.unique(classes))


def test_the_lake_test_is_skipped_entirely_at_coarse_quantization():
    """At 1.0 m steps (rings 6-7) plains blow past any size threshold — measured
    on the Tarsta and Träleborg rings — so the test declines to run rather than
    paint the Närke plain blue. A disclosed limitation, not a silent one."""
    heights, slope, transform = flat_world(size=40)
    slope[5:20, 5:20] = 0.0

    classes = classify_far(
        heights, slope, transform, 0.4, 0.4, BOREONEMORAL, SEED,
        resolution_m=100.0, quant_scale_m=1.0,
    )
    assert FAR_CLASS_WATER_FLAT not in set(np.unique(classes))


def test_flat_ground_below_sea_level_is_sea_not_lake():
    """Precedence: sea is tested before flatness, so the Baltic is not a lake."""
    heights, slope, transform = flat_world(size=20, height=0.0, slope=0.0)
    classes = classify_far(heights, slope, transform, 0.4, 0.4, BOREONEMORAL, SEED)
    assert np.all(classes == FAR_CLASS_SEA)


def test_steep_ground_reads_as_rock_at_the_near_fields_own_threshold():
    heights, slope, transform = flat_world(size=40)
    slope[:, 30:] = ROCK_MIN_SLOPE_DEG + 0.5
    slope[:, 29] = ROCK_MIN_SLOPE_DEG  # at the threshold: not yet rock

    classes = classify_far(heights, slope, transform, 0.4, 0.4, BOREONEMORAL, SEED)
    assert np.all(classes[:, 30:] == FAR_CLASS_ROCK)
    assert np.all(classes[:, 29] != FAR_CLASS_ROCK)
    # The number is the §9 engine's, imported rather than restated (§13).
    assert ROCK_MIN_SLOPE_DEG == DEFAULT_PARAMS.forest_max_slope_deg == 12.0


# --------------------------------------------------------------------------- #
# the mosaic: the site's own context ratio, drawn per world patch
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("open_fraction", [0.15, 0.35, 0.7])
def test_the_mosaic_hits_the_context_open_fraction(open_fraction):
    heights, slope, transform = flat_world()
    classes = classify_far(heights, slope, transform, open_fraction, 0.4, BOREONEMORAL, SEED)
    measured = float((classes == FAR_CLASS_OPEN).mean())
    assert abs(measured - open_fraction) < 0.05
    assert not (classes == FAR_CLASS_SEA).any()


def test_the_species_split_respects_the_context_broadleaf_share():
    heights, slope, transform = flat_world()
    classes = classify_far(heights, slope, transform, 0.3, 0.25, BOREONEMORAL, SEED)
    broadleaf = int((classes == FAR_CLASS_BROADLEAF).sum())
    conifer = int((classes == FAR_CLASS_CONIFER).sum())
    assert abs(broadleaf / (broadleaf + conifer) - 0.25) < 0.05


def test_the_two_hash_channels_are_independent():
    """Open/forest and broadleaf/conifer must not be one draw wearing two hats."""
    heights, slope, transform = flat_world()
    # With open_fraction 0 every patch is forest, so the species split sees the
    # patches the open rule would otherwise have taken — if the channels were the
    # same draw, all of those would land on one side of the species threshold.
    classes = classify_far(heights, slope, transform, 0.0, 0.5, BOREONEMORAL, SEED)
    broadleaf = float((classes == FAR_CLASS_BROADLEAF).mean())
    assert abs(broadleaf - 0.5) < 0.05


def test_southern_boreal_forest_is_all_conifer():
    """docs/vegetation-zones.md §4: conifer-dominated till forest at ~500 CE."""
    heights, slope, transform = flat_world()
    boreal = classify_far(heights, slope, transform, 0.3, 0.9, S_BOREAL, SEED)
    assert not (boreal == FAR_CLASS_BROADLEAF).any()

    # Same ground, same seed, same mosaic — only the forest identity differs.
    other = classify_far(heights, slope, transform, 0.3, 0.9, BOREONEMORAL, SEED)
    assert (boreal == FAR_CLASS_CONIFER).sum() == (
        (other == FAR_CLASS_CONIFER) | (other == FAR_CLASS_BROADLEAF)
    ).sum()
    assert np.array_equal(boreal == FAR_CLASS_OPEN, other == FAR_CLASS_OPEN)


# --------------------------------------------------------------------------- #
# world anchoring — the reason the mosaic is hashed on (E, N) at all
# --------------------------------------------------------------------------- #


#: A corner of the 256 m world lattice (1954 * 256, 25782 * 256), so a test can
#: talk about "one patch" without the square straddling the coordinates it uses.
PATCH_CORNER_E = 1954 * PATCH_SIZE_M
PATCH_CORNER_N = 25782 * PATCH_SIZE_M


def test_the_patch_hash_is_a_pure_function_of_the_world_patch():
    """Every coordinate inside one 256 m square draws the same value; neighbours differ."""
    east, north = PATCH_CORNER_E, PATCH_CORNER_N
    inside = patch_uniform(
        np.array([east + 1.0, east + 128.0, east + 255.9]),
        np.array([north + 1.0, north + 128.0, north + 255.9]),
        SEED,
    )
    assert np.allclose(inside, inside[0])
    assert 0.0 <= inside[0] < 1.0

    neighbour = patch_uniform(east + PATCH_SIZE_M + 1.0, north + 1.0, SEED)
    assert neighbour != inside[0]
    # An independent channel for the same patch, and a different site's seed.
    assert patch_uniform(east + 1.0, north + 1.0, SEED, channel=1) != inside[0]
    assert patch_uniform(east + 1.0, north + 1.0, site_seed("other-site")) != inside[0]


def test_the_patch_hash_is_identical_at_every_ring_resolution():
    """The same ground sampled by a 4 m grid and a 32 m grid hashes identically."""
    east, north = PATCH_CORNER_E, PATCH_CORNER_N
    fine_e = east + (np.arange(64) + 0.5) * 4.0
    coarse_e = east + (np.arange(8) + 0.5) * 32.0
    fine = patch_uniform(fine_e, north + 5.0, SEED)
    coarse = patch_uniform(coarse_e, north + 5.0, SEED)
    # Both grids cover the same 256 m of world — one patch, one value.
    assert np.allclose(fine, fine[0]) and np.allclose(coarse, fine[0])


def test_the_mosaic_agrees_between_two_ring_resolutions_over_the_same_ground():
    """ring4 covers all of ring3: the shared ground must classify the same in both.

    Elevation and slope are held constant so the only thing that can disagree is
    the mosaic — which is exactly what the world anchoring exists to pin down.
    Patch edges (multiples of 256 m) fall on cell boundaries in both grids, so
    every fine cell under a coarse cell shares its patch and the agreement is
    exact, not statistical.
    """
    origin_e, origin_n = 500000.0, 6600000.0
    fine_transform = Affine(4.0, 0.0, origin_e, 0.0, -4.0, origin_n)
    coarse_transform = Affine(8.0, 0.0, origin_e, 0.0, -8.0, origin_n)

    fine = classify_far(
        *flat_world(size=256, transform=fine_transform)[:2],
        fine_transform, 0.4, 0.4, BOREONEMORAL, SEED,
    )
    coarse = classify_far(
        *flat_world(size=128, transform=coarse_transform)[:2],
        coarse_transform, 0.4, 0.4, BOREONEMORAL, SEED,
    )
    for row_offset in (0, 1):
        for col_offset in (0, 1):
            assert np.array_equal(fine[row_offset::2, col_offset::2], coarse)


def test_the_mosaic_does_not_move_when_the_grid_does():
    """A grid-anchored noise field would repaint the ground when the window shifts."""
    origin_e, origin_n = 500000.0, 6600000.0
    whole = Affine(8.0, 0.0, origin_e, 0.0, -8.0, origin_n)
    # Same resolution, window shifted 40 cells east and 24 south.
    shifted = Affine(8.0, 0.0, origin_e + 40 * 8.0, 0.0, -8.0, origin_n - 24 * 8.0)

    args = (0.45, 0.4, BOREONEMORAL, SEED)
    full = classify_far(*flat_world(size=128, transform=whole)[:2], whole, *args)
    window = classify_far(*flat_world(size=64, transform=shifted)[:2], shifted, *args)
    assert np.array_equal(full[24 : 24 + 64, 40 : 40 + 64], window)


# --------------------------------------------------------------------------- #
# determinism
# --------------------------------------------------------------------------- #


def test_two_runs_produce_identical_rasters():
    heights, slope, transform = flat_world(size=128)
    first = classify_far(heights, slope, transform, 0.4, 0.4, BOREONEMORAL, SEED)
    second = classify_far(heights, slope, transform, 0.4, 0.4, BOREONEMORAL, SEED)
    assert np.array_equal(first, second)
    assert first.dtype == np.uint8


def test_a_different_site_seed_draws_a_different_mosaic():
    heights, slope, transform = flat_world(size=128)
    first = classify_far(heights, slope, transform, 0.4, 0.4, BOREONEMORAL, SEED)
    other = classify_far(
        heights, slope, transform, 0.4, 0.4, BOREONEMORAL, site_seed("other-site")
    )
    assert not np.array_equal(first, other)
    assert site_seed("testsite") == site_seed("testsite")  # and stable within a site


def test_classify_far_rejects_inputs_that_disagree():
    heights, slope, transform = flat_world(size=16)
    with pytest.raises(FarLandcoverError, match="slope"):
        classify_far(heights, slope[:8], transform, 0.4, 0.4, None, SEED)
    with pytest.raises(FarLandcoverError, match="open_fraction"):
        classify_far(heights, slope, transform, 1.4, 0.4, None, SEED)
    with pytest.raises(FarLandcoverError, match="broadleaf_share"):
        classify_far(heights, slope, transform, 0.4, -0.1, None, SEED)


# --------------------------------------------------------------------------- #
# the ratio the far field inherits from the site's own context legend
# --------------------------------------------------------------------------- #

#: Index order of `landcover._RULES`: water, peat_fen, farmland, wet_meadow,
#: dry_corridor, broadleaf_forest, conifer_forest, settlement_cleared,
#: shore_reeds, wooded_pasture, alvar. Land = 0.80; open (fen included) = 0.50.
CONTEXT_FRACTIONS = [0.20, 0.10, 0.10, 0.05, 0.05, 0.15, 0.15, 0.05, 0.0, 0.10, 0.05]
SOILS_META = {
    "product": "SGU Jordarter 1:25 000–1:100 000",
    "api": "https://api.sgu.se/oppnadata/jordarter25k-100k/ogc/features/v1",
    "collections": ["grundlager", "ytlager"],
    "fetched": "2026-08-21T12:00:00+00:00",
}


def near_field_legend(cfg, fractions=None) -> dict:
    """A valid §10 legend for the fake site, with fractions we can do arithmetic on."""
    fractions = list(CONTEXT_FRACTIONS if fractions is None else fractions)
    taxonomy = landcover_classes(10.0)
    return build_legend(cfg, taxonomy, fractions, 10.0, SOILS_META, 0.98, 12)


def test_the_context_ratio_counts_open_ground_over_land(fake_site):
    open_fraction, broadleaf_share = context_mosaic_ratio(near_field_legend(fake_site))
    assert open_fraction == pytest.approx(0.50 / 0.80)  # the fen counts as open
    assert broadleaf_share == pytest.approx(0.5)


def test_a_forestless_context_falls_back_to_an_even_species_split(fake_site):
    fractions = list(CONTEXT_FRACTIONS)
    fractions[5] = fractions[6] = 0.0
    fractions[2] += 0.30  # farmland absorbs the forest share
    _open, broadleaf_share = context_mosaic_ratio(near_field_legend(fake_site, fractions))
    assert broadleaf_share == BROADLEAF_SHARE_FALLBACK


def test_the_ratio_is_read_by_class_id_not_by_index(fake_site):
    """§10 has appended classes twice; an index read would silently shift."""
    legend = near_field_legend(fake_site)
    legend["classes"] = list(reversed(legend["classes"]))
    open_fraction, broadleaf_share = context_mosaic_ratio(legend)
    assert open_fraction == pytest.approx(0.50 / 0.80)
    assert broadleaf_share == pytest.approx(0.5)


def test_an_all_water_context_has_no_ratio_to_continue(fake_site):
    legend = near_field_legend(fake_site)
    legend["classes"] = [{"id": "water", "areaFraction": 1.0}]
    with pytest.raises(FarLandcoverError, match="entirely mapped water"):
        context_mosaic_ratio(legend)


def test_ring_landcover_paths_are_named_after_their_ring():
    assert ring_landcover_path("dem_ring3.tif") == "landcover_ring3.tif"
    assert ring_landcover_path("dem_ring7.tif") == "landcover_ring7.tif"
    with pytest.raises(FarLandcoverError, match="ring number"):
        ring_landcover_path("dem_context.tif")


# --------------------------------------------------------------------------- #
# the farField legend block (contract §13)
# --------------------------------------------------------------------------- #


@pytest.fixture
def far_block() -> dict:
    return far_field_block(0.625, 0.5, BOREONEMORAL, 4.0, 8000.0)


def test_the_far_block_declares_the_fixed_class_set(far_block):
    assert [entry["id"] for entry in far_block["classes"]] == [
        "sea",
        "water_flat",
        "open",
        "forest_broadleaf",
        "forest_conifer",
        "rock_sparse",
    ]
    assert [entry["index"] for entry in far_block["classes"]] == list(range(6))
    billboards = {
        entry["id"]: entry.get("billboard") for entry in far_block["classes"]
    }
    assert billboards["forest_broadleaf"] == {
        "type": "broadleaf",
        "densityPerHa": BILLBOARD_DENSITY_PER_HA,
    }
    assert billboards["forest_conifer"]["type"] == "conifer"
    assert all(billboards[open_id] is None for open_id in ("sea", "water_flat", "open", "rock_sparse"))


def test_the_far_method_discloses_what_it_did_and_did_not_read(far_block):
    method = far_block["method"]
    # Cruder than §9, and named as such: no soil, no KMR evidence.
    assert "cruder" in method and "SGU soil polygons" in method
    assert "sub-pixel" in method
    # The thresholds, verbatim.
    assert "0.05 m" in method and "0.05°" in method and "12°" in method
    # The world-anchored mosaic, at the site's own ratio.
    assert "256 m" in method and "EPSG:3006" in method and "62 %" in method
    # The billboard sampling disclosure (docs/far-field-vegetation.md §1).
    assert "roughly one tree in ten as a stand-in for the stand" in method
    assert "one in nine to twelve" in method and "90–120" in method
    # And what it is not for.
    assert "viewshed" in method


def test_every_far_rule_quotes_the_numbers_it_used(far_block):
    rules = {entry["id"]: entry["rule"] for entry in far_block["classes"]}
    assert "0.05 m" in rules["sea"] and "coverage seam" in rules["sea"]
    assert "proxy" in rules["water_flat"] and "TIN" in rules["water_flat"]
    assert "256 m" in rules["open"] and "62 %" in rules["open"]
    assert "a mire reads as open land" in rules["open"]
    assert "12°" in rules["rock_sparse"]
    assert "50 %" in rules["forest_broadleaf"]


def test_the_southern_boreal_block_says_why_it_has_no_broadleaf():
    block = far_field_block(0.4, 0.6, S_BOREAL, 4.0, 8000.0)
    assert "southern boreal" in block["method"]
    broadleaf = block["classes"][FAR_CLASS_BROADLEAF]["rule"]
    assert "holds no cells" in broadleaf and "vegetation-zones.md §4" in broadleaf


def test_a_legend_carrying_a_good_far_block_validates(fake_site, far_block):
    legend = near_field_legend(fake_site)
    legend["farField"] = far_block
    validate_legend(legend)


def test_a_legend_without_a_far_block_validates_exactly_as_before(fake_site):
    """Every pre-v1.6 bundle: absent block = no far field (§13)."""
    legend = near_field_legend(fake_site)
    assert "farField" not in legend
    validate_legend(legend)


@pytest.mark.parametrize(
    "mutate, match",
    [
        (lambda far: far.pop("method"), r"farField\.method"),
        (lambda far: far.__setitem__("method", ""), r"farField\.method"),
        (lambda far: far.__setitem__("classes", []), r"farField\.classes"),
        (lambda far: far["classes"].pop(2), r"farField\.classes\[2\]\.index"),
        (
            lambda far: far["classes"][1].__setitem__("color", "rgb(1,2,3)"),
            r"farField\.classes\[1\]\.color",
        ),
        (
            lambda far: far["classes"][0].__setitem__("rule", ""),
            r"farField\.classes\[0\]\.rule",
        ),
        (
            lambda far: far["classes"][1].__setitem__("id", "sea"),
            r"duplicate farField class id",
        ),
        (
            lambda far: far["classes"][3]["billboard"].__setitem__("type", "palm"),
            r"farField\.classes\[3\]\.billboard\.type",
        ),
        (
            lambda far: far["classes"][3]["billboard"].__setitem__("densityPerHa", 0),
            r"farField\.classes\[3\]\.billboard\.densityPerHa",
        ),
        (
            lambda far: far["classes"][2].__setitem__("areaFraction", 0.4),
            r"farField\.classes\[2\]\.areaFraction",
        ),
        (
            lambda far: far["classes"][0].__setitem__("dynamic", {"kind": "water"}),
            r"farField\.classes\[0\]\.dynamic",
        ),
    ],
)
def test_the_validator_names_the_broken_far_field(fake_site, far_block, mutate, match):
    legend = near_field_legend(fake_site)
    legend["farField"] = copy.deepcopy(far_block)
    mutate(legend["farField"])
    with pytest.raises(LandcoverError, match=match):
        validate_legend(legend)


# --------------------------------------------------------------------------- #
# manifest wiring (contract §13)
# --------------------------------------------------------------------------- #


def ring_grid(cfg, name, half_extent, resolution, scale, path, surface=None):
    """One synthetic ring grid on the site's own lattice, at the ring's resolution."""
    spec = GridSpec(name, half_extent=half_extent, resolution=resolution, path=path, quant_scale=scale)
    west, _south, _east, north = cfg.bounds3006(half_extent)
    transform = Affine(resolution, 0.0, west, 0.0, -resolution, north)
    if surface is None:
        surface = np.full((spec.size, spec.size), 20.0, dtype=np.float32)
    return build_grid(surface, transform, spec, cfg, source_resolution=resolution)


@pytest.fixture
def ringed_manifest(fake_site, fake_source_clean):
    source, transform, nodata = fake_source_clean
    grids = build_grids(source, transform, nodata, fake_site)
    manifest = build_manifest(fake_site, grids, {"stacItems": [], "fetched": ""})
    add_rings(
        manifest,
        [ring_grid(fake_site, "ring3", 800.0, 8.0, 0.5, "dem_ring3.tif")],
        fake_site,
        horizon_info(50.0, 5.0),
    )
    add_landcover_asset(manifest, LANDCOVER_PATH, LANDCOVER_LEGEND_PATH)
    return manifest


def test_attach_ring_landcover_round_trips(ringed_manifest):
    attach_ring_landcover(ringed_manifest, "dem_ring3.tif", "landcover_ring3.tif")
    assert ringed_manifest["grids"]["rings"][0]["landcover"] == "landcover_ring3.tif"
    validate_manifest(ringed_manifest)
    # Idempotent, like every other manifest patcher.
    attach_ring_landcover(ringed_manifest, "dem_ring3.tif", "landcover_ring3.tif")
    validate_manifest(ringed_manifest)


def test_attach_ring_landcover_needs_the_ring_to_exist(ringed_manifest):
    with pytest.raises(ValueError, match="no ring entry"):
        attach_ring_landcover(ringed_manifest, "dem_ring9.tif", "landcover_ring9.tif")


def test_a_ring_landcover_without_the_near_field_pair_is_refused(ringed_manifest):
    """§13: the far field extends the modelled-landscape layer and cannot precede it."""
    attach_ring_landcover(ringed_manifest, "dem_ring3.tif", "landcover_ring3.tif")
    del ringed_manifest["assets"]["landcover"]
    with pytest.raises(ValueError, match="near-field pair"):
        validate_manifest(ringed_manifest)


@pytest.mark.parametrize(
    "value, match",
    [
        ("/abs/landcover_ring3.tif", "relative"),
        ("../landcover_ring3.tif", "relative"),
        ("", "relative"),
        ("landcover_ring3.png", r"\.tif"),
    ],
)
def test_the_validator_refuses_a_bad_ring_landcover_path(ringed_manifest, value, match):
    ringed_manifest["grids"]["rings"][0]["landcover"] = value
    with pytest.raises(ValueError, match=match):
        validate_manifest(ringed_manifest)


def test_a_ring_without_a_landcover_key_still_validates(ringed_manifest):
    """Per-ring and optional: a ring without it simply renders untinted (§13)."""
    validate_manifest(ringed_manifest)
    assert "landcover" not in ringed_manifest["grids"]["rings"][0]


# --------------------------------------------------------------------------- #
# end to end on a tiny bundle
# --------------------------------------------------------------------------- #

RING_HALF_EXTENT = 800.0
RING_RESOLUTION = 8.0
RING_SCALE = 0.5


def ring_surface(cfg) -> np.ndarray:
    """A ring DEM with every far branch present in a known place.

    Columns 0-19 sit at 0 m (the modern sea and the §11 coverage seam read the
    same here), rows 40-59 x columns 100-129 are a dead-flat lake surface, rows
    150-169 are a scarp steeper than the forest threshold, and the rest is a
    gentle rippled ramp the mosaic gets to divide. The ripple is there because a
    perfectly smooth ramp quantized to the ring's 0.5 m lattice comes back as
    stair treads whose centres read as dead flat — which is a real property of
    the flatness proxy, disclosed in its rule string, and not what this fixture
    is trying to exercise.
    """
    size = int(2 * RING_HALF_EXTENT / RING_RESOLUTION)
    rows, columns = np.meshgrid(
        np.arange(size, dtype=np.float64), np.arange(size, dtype=np.float64), indexing="ij"
    )
    surface = 12.0 + 0.16 * columns + 0.9 * np.sin(columns / 3.0) * np.cos(rows / 5.0)
    surface[150:170, :] += 2.0 * np.arange(20, dtype=np.float64)[:, None]
    surface[40:60, 100:130] = 25.0
    surface[:, :20] = 0.0
    return surface.astype(np.float32)


@pytest.fixture
def built_bundle(tmp_path, fake_site, fake_source_clean, monkeypatch):
    """A minimal but genuinely valid bundle: grids, one ring, the §9/§10 pair."""
    from fornborg_pipeline import sites as sites_module

    monkeypatch.setattr(sites_module, "APP_DATA_DIR", tmp_path)
    monkeypatch.setitem(sites_module.SITES, fake_site.id, fake_site)
    out_dir = fake_site.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    source, transform, nodata = fake_source_clean
    grids = build_grids(source, transform, nodata, fake_site)
    for grid in grids.values():
        write_grid(out_dir / grid.spec.path, grid)

    ring = ring_grid(
        fake_site,
        "ring3",
        RING_HALF_EXTENT,
        RING_RESOLUTION,
        RING_SCALE,
        "dem_ring3.tif",
        surface=ring_surface(fake_site),
    )
    write_grid(out_dir / ring.spec.path, ring)

    manifest = build_manifest(fake_site, grids, {"stacItems": [], "fetched": ""})
    add_rings(manifest, [ring], fake_site, horizon_info(50.0, 5.0))
    add_landcover_asset(manifest, LANDCOVER_PATH, LANDCOVER_LEGEND_PATH)
    validate_manifest(manifest)
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    context = grids["context"]
    write_class_grid(
        out_dir / LANDCOVER_PATH,
        np.zeros((context.height, context.width), dtype=np.uint8),
        context.transform,
    )
    (out_dir / LANDCOVER_LEGEND_PATH).write_text(
        json.dumps(near_field_legend(fake_site), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return out_dir


def test_run_writes_a_ring_raster_on_the_rings_own_geometry(built_bundle, fake_site):
    from fornborg_pipeline import far_landcover

    manifest = far_landcover.run(fake_site.id)

    raster = built_bundle / "landcover_ring3.tif"
    assert raster.exists()
    with rasterio.open(built_bundle / "dem_ring3.tif") as dem, rasterio.open(raster) as new:
        assert new.dtypes[0] == "uint8" and new.nodata is None
        assert (new.width, new.height) == (dem.width, dem.height)
        assert new.transform == dem.transform and new.bounds == dem.bounds
        assert new.crs.to_epsg() == 3006
        classes = new.read(1)

    # Every branch reachable on this small ring is present, and every value is a
    # legal index into farField.classes[]. The fixture's flat patch is ~3.8 ha —
    # honestly below the 200 ha lake floor — so it reads as land, not lake; the
    # lake branch itself is pinned by the classify_far unit tests, where a
    # 200 ha component fits.
    assert set(np.unique(classes)) == {
        FAR_CLASS_SEA,
        FAR_CLASS_OPEN,
        FAR_CLASS_BROADLEAF,
        FAR_CLASS_CONIFER,
        FAR_CLASS_ROCK,
    }
    assert np.all(classes[:, :19] == FAR_CLASS_SEA)
    assert FAR_CLASS_WATER_FLAT not in set(np.unique(classes[45:55, 105:125]))
    assert np.all(classes[152:168, 30:] == FAR_CLASS_ROCK)
    assert manifest["grids"]["rings"][0]["landcover"] == "landcover_ring3.tif"


def test_run_leaves_the_legend_and_the_manifest_valid(built_bundle, fake_site):
    from fornborg_pipeline import far_landcover

    far_landcover.run(fake_site.id)

    legend = json.loads((built_bundle / LANDCOVER_LEGEND_PATH).read_text(encoding="utf-8"))
    validate_legend(legend)
    assert len(legend["farField"]["classes"]) == 6
    # The near field is untouched by the far build (docs/far-field-vegetation.md §7).
    assert legend["classes"] == near_field_legend(fake_site)["classes"]
    assert legend["farField"]["method"].startswith("The far-field rasters")

    manifest = json.loads((built_bundle / "manifest.json").read_text(encoding="utf-8"))
    validate_manifest(manifest)
    assert manifest["grids"]["rings"][0]["landcover"] == "landcover_ring3.tif"


def test_run_is_reproducible(built_bundle, fake_site):
    from fornborg_pipeline import far_landcover

    far_landcover.run(fake_site.id)
    first = (built_bundle / "landcover_ring3.tif").read_bytes()
    far_landcover.run(fake_site.id)
    assert (built_bundle / "landcover_ring3.tif").read_bytes() == first


def test_run_refuses_a_site_with_no_rings(built_bundle, fake_site):
    from fornborg_pipeline import far_landcover

    manifest_path = built_bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["grids"]["rings"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(FarLandcoverError, match=r"fornborg_pipeline\.rings"):
        far_landcover.run(fake_site.id)


def test_run_refuses_a_site_with_no_near_field(built_bundle, fake_site):
    """§13: the far field cannot exist without the §9/§10 pair."""
    from fornborg_pipeline import far_landcover

    manifest_path = built_bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["assets"]["landcover"]
    del manifest["assets"]["landcoverLegend"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(FarLandcoverError, match=r"fornborg_pipeline\.landcover"):
        far_landcover.run(fake_site.id)
