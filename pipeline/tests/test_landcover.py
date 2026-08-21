"""Land-cover model contract tests (docs/data-formats.md §9/§10). No network.

The SGU response is canned: `canned_jordarter()` builds a FeatureCollection with
the property schema the live API actually serves — `grundlager` polygons carrying
`jg2` / `jg2_tx` and `ytlager` polygons carrying `jy1` / `jy1_tx`, both in
EPSG:3006 easting/northing order (`fetch_soils`'s module docstring records the
probe this came from).

The terrain fixture is analytic: a north-to-south elevation ramp with a rocky
scarp on one band and a flat settled shelf on another, laid out so that **every
rule fires in a region whose extent is known in advance**. Each classification
test therefore asserts an exact class over an exact slice, not a distribution.
"""

from __future__ import annotations

import copy
import json

import numpy as np
import pytest
import rasterio
from affine import Affine

from fornborg_pipeline.clip_dem import write_class_grid
from fornborg_pipeline.fetch_soils import (
    bbox_3006,
    class_census,
    is_surface_layer,
    soil_class,
    soil_code,
)
from fornborg_pipeline.landcover import (
    CLASS_BROADLEAF,
    CLASS_CLEARED,
    CLASS_CONIFER,
    CLASS_DRY_CORRIDOR,
    CLASS_FARMLAND,
    CLASS_MARSH,
    CLASS_MEADOW,
    CLASS_WATER,
    GROUP_BEDROCK,
    GROUP_CLAY,
    GROUP_FINE,
    GROUP_GRAVEL,
    GROUP_NONE,
    GROUP_OTHER,
    GROUP_PEAT,
    GROUP_TILL,
    GROUP_WATER,
    MONUMENT_TYPES,
    REFERENCE_YEAR_CE,
    SCHEMA_VERSION,
    DEFAULT_PARAMS,
    LandcoverError,
    area_fractions,
    build_legend,
    calibration_text,
    classify,
    distance_meters,
    fill_nearest,
    landcover_classes,
    local_to_3006,
    rasterize_soils,
    settlement_mask,
    slope_degrees,
    validate_legend,
    write_legend,
)

# The fixture grid: 40x40 cells at 2 m over E 0..80 / N 0..80, north-up. Small
# enough to reason about cell by cell, same shape of problem as the real 2000x2000.
SIZE = 40
RESOLUTION = 2.0
TRANSFORM = Affine(RESOLUTION, 0.0, 0.0, 0.0, -RESOLUTION, SIZE * RESOLUTION)
SHAPE = (SIZE, SIZE)

REFERENCE_LEVEL = 10.0

SOILS_META = {
    "product": "SGU Jordarter 1:25 000–1:100 000",
    "api": "https://api.sgu.se/oppnadata/jordarter25k-100k/ogc/features/v1",
    "collections": ["grundlager", "ytlager"],
    "fetched": "2026-08-21T12:00:00+00:00",
}


def cell_bounds(row0: int, row1: int, col0: int, col1: int) -> list[list[float]]:
    """A rectangle covering rows [row0, row1) x cols [col0, col1) as an EPSG:3006 ring."""
    min_e = TRANSFORM.c + col0 * RESOLUTION
    max_e = TRANSFORM.c + col1 * RESOLUTION
    max_n = TRANSFORM.f - row0 * RESOLUTION
    min_n = TRANSFORM.f - row1 * RESOLUTION
    return [[min_e, min_n], [max_e, min_n], [max_e, max_n], [min_e, max_n], [min_e, min_n]]


def ground_feature(row0, row1, col0, col1, code: int, text: str) -> dict:
    """One `grundlager` polygon, with the live API's property schema."""
    return {
        "type": "Feature",
        "id": f"grundlager.{code}.{row0}",
        "geometry": {"type": "Polygon", "coordinates": [cell_bounds(row0, row1, col0, col1)]},
        "properties": {
            "jg2": code,
            "jg2_tx": text,
            "kartering": "uppsalanv",
            "karttyp": 2,
            "symbol": 11,
            "objectid": 100000 + code * 100 + row0,
            "geom_area": (row1 - row0) * (col1 - col0) * RESOLUTION**2,
            "geom_length": 2.0 * ((row1 - row0) + (col1 - col0)) * RESOLUTION,
        },
    }


def surface_feature(row0, row1, col0, col1, code: int, text: str) -> dict:
    """One `ytlager` polygon — a different property pair, as the live API serves it."""
    feature = ground_feature(row0, row1, col0, col1, code, text)
    feature["id"] = f"ytlager.{code}.{row0}"
    props = feature["properties"]
    props["jy1"] = props.pop("jg2")
    props["jy1_tx"] = props.pop("jg2_tx")
    return feature


def canned_jordarter() -> list[dict]:
    """Soil polygons in horizontal bands, one band per rule the engine has.

    rows  0-7   Urberg           -> bedrock -> conifer
    rows  8-15  Sandig morän     -> till    -> farmland at the margin / broadleaf / conifer
    rows 16-19  Isälvssediment   -> gravel  -> dry corridor
    rows 20-23  Glacial lera     -> clay    -> wet meadow
    rows 24-31  Postglacial lera -> fine    -> farmland (dry) / wet meadow (fresh)
    rows 32-33  Kärrtorv         -> peat    -> reed marsh
    rows 34-35  Sandig morän     -> till    -> reed marsh (the shore band overrides)
    rows 36-39  Vatten           -> water   -> water
    plus a `ytlager` peat veneer over part of the Urberg band (which becomes marsh)
    and a `ytlager` till veneer next to it (which is ignored on purpose).
    """
    return [
        ground_feature(0, 8, 0, SIZE, 890, "Urberg"),
        ground_feature(8, 16, 0, SIZE, 95, "Sandig morän"),
        ground_feature(16, 20, 0, SIZE, 50, "Isälvssediment"),
        ground_feature(20, 24, 0, SIZE, 40, "Glacial lera"),
        ground_feature(24, 32, 0, SIZE, 17, "Postglacial lera"),
        ground_feature(32, 34, 0, SIZE, 5, "Kärrtorv"),
        ground_feature(34, 36, 0, SIZE, 95, "Sandig morän"),
        ground_feature(36, 40, 0, SIZE, 91, "Vatten"),
        surface_feature(0, 4, 0, 10, 90, "Torv"),
        surface_feature(4, 8, 10, 20, 100, "Morän"),
    ]


@pytest.fixture
def soil_grids():
    """(group, peat_surface, unmatched, coverage) for the canned extract."""
    return rasterize_soils(canned_jordarter(), SHAPE, TRANSFORM)


# --------------------------------------------------------------------------- #
# fetch_soils: the API's real schema, without touching the network
# --------------------------------------------------------------------------- #


def test_bbox_is_emitted_in_the_authority_axis_order():
    """EPSG:3006 is (N, E); an (E, N) bbox silently matches nothing (see the docstring)."""
    assert bbox_3006((663810.0, 6625880.0, 667810.0, 6629880.0)) == (
        "6625880.000,663810.000,6629880.000,667810.000"
    )


def test_soil_class_reads_both_collections_property_pairs():
    extract = canned_jordarter()
    ground = next(f for f in extract if not is_surface_layer(f))
    surface = next(f for f in extract if soil_class(f) == "Torv")
    assert soil_class(ground) == "Urberg" and soil_code(ground) == 890
    assert soil_class(surface) == "Torv" and soil_code(surface) == 90
    assert not is_surface_layer(ground) and is_surface_layer(surface)
    assert soil_class({"properties": {"kartering": "x"}}) is None


def test_class_census_counts_polygons_per_class():
    census = class_census(canned_jordarter())
    assert census["Urberg"] == 1 and census["Torv"] == 1 and census["Morän"] == 1
    assert sum(census.values()) == len(canned_jordarter())


# --------------------------------------------------------------------------- #
# rasterizing the inputs
# --------------------------------------------------------------------------- #


def test_rasterize_soils_lands_every_band_on_its_own_rows(soil_grids):
    group, peat_surface, unmatched, coverage = soil_grids
    assert group.shape == SHAPE and coverage == 1.0 and unmatched == {}
    assert (group[0:8] == GROUP_BEDROCK).all()
    assert (group[8:16] == GROUP_TILL).all()
    assert (group[16:20] == GROUP_GRAVEL).all()
    assert (group[20:24] == GROUP_CLAY).all()
    assert (group[24:32] == GROUP_FINE).all()
    assert (group[32:34] == GROUP_PEAT).all()
    assert (group[34:36] == GROUP_TILL).all()
    assert (group[36:40] == GROUP_WATER).all()
    # Only the ytlager *peat* veneer is carried; its till veneer is ignored on purpose.
    assert peat_surface[0:4, 0:10].all()
    assert not peat_surface[4:8, 10:20].any()
    assert peat_surface.sum() == 4 * 10


def test_unnamed_sgu_classes_fall_through_to_other_and_are_reported():
    extract = [ground_feature(0, SIZE, 0, SIZE, 999, "Lerig sandmorän med skalgrus")]
    group, _peat, unmatched, _coverage = rasterize_soils(extract, SHAPE, TRANSFORM)
    assert (group == GROUP_OTHER).all()
    assert unmatched == {"Lerig sandmorän med skalgrus": 1}


def test_uncovered_cells_take_their_nearest_polygons_class():
    """SGU coverage has slivers; the fill closes them without inventing a class."""
    extract = [ground_feature(0, 10, 0, SIZE, 890, "Urberg")]
    group, _peat, _unmatched, coverage = rasterize_soils(extract, SHAPE, TRANSFORM)
    assert coverage == pytest.approx(10.0 / SIZE)
    assert (group == GROUP_BEDROCK).all()  # the whole grid filled from the one band


def test_rasterize_soils_refuses_an_extract_with_no_ground_layer():
    with pytest.raises(LandcoverError, match="no classified ground-layer polygon"):
        rasterize_soils([surface_feature(0, 4, 0, 4, 90, "Torv")], SHAPE, TRANSFORM)


def test_fill_nearest_replaces_only_the_missing_cells():
    values = np.zeros(SHAPE, dtype=np.uint8)
    values[0] = 7
    missing = values == GROUP_NONE
    filled = fill_nearest(values, missing)
    assert (filled == 7).all()
    untouched = np.full(SHAPE, 3, dtype=np.uint8)
    assert fill_nearest(untouched, untouched == GROUP_NONE) is untouched


def test_fill_nearest_refuses_a_grid_no_polygon_covers():
    empty = np.zeros(SHAPE, dtype=np.uint8)
    with pytest.raises(LandcoverError, match="no SGU polygon covers"):
        fill_nearest(empty, empty == GROUP_NONE)


def test_slope_is_degrees_on_an_analytic_ramp():
    """A 1:1 ramp is 45°, a flat plane is 0° — the only two cases with no ambiguity."""
    rows = np.arange(SIZE, dtype=np.float64)[:, None] * RESOLUTION
    assert slope_degrees(np.zeros(SHAPE), RESOLUTION).max() == pytest.approx(0.0)
    assert slope_degrees(np.broadcast_to(rows, SHAPE), RESOLUTION) == pytest.approx(45.0)


def test_local_to_3006_inverts_the_scene_convention(fake_site):
    """Contract §0: E = x + origin.e, N = origin.n - z."""
    geometry = local_to_3006({"type": "Point", "coordinates": [10.0, -20.0]}, fake_site)
    assert geometry == {
        "type": "Point",
        "coordinates": [fake_site.center_e + 10.0, fake_site.center_n + 20.0],
    }
    polygon = local_to_3006(
        {"type": "Polygon", "coordinates": [[[0.0, 0.0], [2.0, 0.0], [0.0, 2.0], [0.0, 0.0]]]},
        fake_site,
    )
    assert polygon["coordinates"][0][1] == [fake_site.center_e + 2.0, fake_site.center_n]
    with pytest.raises(LandcoverError, match="unsupported geometryLocal type"):
        local_to_3006({"type": "Triangle", "coordinates": []}, fake_site)


def test_settlement_mask_uses_positions_and_outlines(fake_site):
    """A point record marks one cell; a polygon record marks its whole footprint."""
    grid_transform = Affine(
        RESOLUTION,
        0.0,
        fake_site.center_e - SIZE * RESOLUTION / 2,
        0.0,
        -RESOLUTION,
        fake_site.center_n + SIZE * RESOLUTION / 2,
    )
    document = {
        "sites": [
            {"id": "a", "lamningstyp": "Boplats", "position": {"x": 0.0, "z": 0.0}},
            {
                "id": "b",
                "lamningstyp": "Gravfält",
                "position": {"x": -20.0, "z": -20.0},
                "geometryLocal": {
                    "type": "Polygon",
                    "coordinates": [
                        [[-30.0, -30.0], [-10.0, -30.0], [-10.0, -10.0], [-30.0, -10.0], [-30.0, -30.0]]
                    ],
                },
            },
            {"id": "c", "lamningstyp": "Runristning", "position": {"x": 30.0, "z": 30.0}},
        ]
    }
    mask, records = settlement_mask(document, SHAPE, grid_transform, fake_site)
    assert records == 2  # the Runristning is not a settlement proxy
    assert mask[SIZE // 2, SIZE // 2]  # site "a" at the grid center
    assert mask.sum() > 1 + 10 * 10 - 1  # the 20x20 m outline of site "b"
    # Nothing burned near the runestone's cell.
    assert not mask[SIZE // 2 - 15, SIZE // 2 + 15]


def test_monument_types_add_the_fornborg_footprint(fake_site):
    """The fort's own extent clears trees but is never a cultivation proxy."""
    grid_transform = Affine(
        RESOLUTION,
        0.0,
        fake_site.center_e - SIZE * RESOLUTION / 2,
        0.0,
        -RESOLUTION,
        fake_site.center_n + SIZE * RESOLUTION / 2,
    )
    document = {
        "sites": [
            {
                "id": "fort",
                "lamningstyp": "Fornborg",
                "position": {"x": 0.0, "z": 0.0},
                "geometryLocal": {
                    "type": "Polygon",
                    "coordinates": [
                        [[-10.0, -10.0], [10.0, -10.0], [10.0, 10.0], [-10.0, 10.0], [-10.0, -10.0]]
                    ],
                },
            },
        ]
    }
    proxy_mask, proxy_records = settlement_mask(document, SHAPE, grid_transform, fake_site)
    assert proxy_records == 0 and not proxy_mask.any()
    monument_mask, monument_records = settlement_mask(
        document, SHAPE, grid_transform, fake_site, types=MONUMENT_TYPES
    )
    assert monument_records == 1
    assert monument_mask.sum() >= 10 * 10  # the 20x20 m footprint at 2 m cells


def test_distance_is_metric_and_infinite_with_no_proxy():
    mask = np.zeros(SHAPE, dtype=bool)
    assert np.isinf(distance_meters(mask, RESOLUTION)).all()
    mask[0, 0] = True
    distance = distance_meters(mask, RESOLUTION)
    assert distance[0, 0] == 0.0
    assert distance[0, 5] == pytest.approx(5 * RESOLUTION)
    assert distance[3, 4] == pytest.approx(5 * RESOLUTION)  # 3-4-5, in meters


# --------------------------------------------------------------------------- #
# the rule engine — every rule fires in a region with a known extent
# --------------------------------------------------------------------------- #


# The connectivity surface, per band of rows: monotone non-increasing northward to
# southward, like a real one, and chosen so that at the reference level of 10.0 m
# every threshold in `DEFAULT_PARAMS` lands strictly between two bands — no ties,
# so each assertion below is exact rather than approximate.
#
#   >= 13.0 (level + fresh_land_m) — dry enough to plough
#   <= 10.6 (level + shore_band_m) — shore fen
#   <= 10.0 (level)                — sea
CONNECT_BANDS = (
    (0, 20, 25.0),  # uplands: bedrock, till, gravel
    (20, 24, 20.0),  # clay terrace
    (24, 32, 16.0),  # postglacial clay, dry enough to plough... except:
    (28, 32, 11.5),  # ...its southern half, drained too recently
    (32, 34, 11.0),  # the fen
    (34, 36, 10.4),  # the shore shelf — dry ground inside the shore band
    (36, 40, 9.0),  # below the water line
)


@pytest.fixture
def rule_inputs(soil_grids):
    """Analytic inputs laid out so each rule owns a band of rows.

    Slope is flat everywhere except rows 12-15, a 30° scarp inside the till band;
    a settlement proxy is 100 m from rows 8-31 and 5 km from everything else. No
    monument footprint is in frame by default — the cleared-ground tests place
    their own so the band assertions here stay exact.
    """
    group, peat_surface, _unmatched, _coverage = soil_grids
    connect = np.zeros(SHAPE, dtype=np.float64)
    for row0, row1, level in CONNECT_BANDS:
        connect[row0:row1] = level
    slope = np.zeros(SHAPE, dtype=np.float64)
    slope[12:16] = 30.0  # a rocky scarp inside the till band
    distance = np.full(SHAPE, 5000.0, dtype=np.float64)
    distance[8:32] = 100.0  # near a settlement, from the till band down to the clay
    monument = np.full(SHAPE, np.inf, dtype=np.float64)
    return connect, group, peat_surface, slope, distance, monument


def run_rules(rule_inputs, **overrides):
    connect, group, peat_surface, slope, distance, monument = rule_inputs
    params = DEFAULT_PARAMS if not overrides else DEFAULT_PARAMS.__class__(**{
        **{f: getattr(DEFAULT_PARAMS, f) for f in DEFAULT_PARAMS.__dataclass_fields__},
        **overrides,
    })
    return classify(
        connect, group, peat_surface, slope, distance, monument,
        REFERENCE_LEVEL, RESOLUTION, params,
    )


def test_water_wins_over_every_other_rule(rule_inputs):
    classes = run_rules(rule_inputs)
    # Rows 36-39: connect <= 10.0 m AND SGU maps 'Vatten' — both branches agree.
    assert (classes[36:40] == CLASS_WATER).all()
    assert (classes[0:36] != CLASS_WATER).all()


def test_peat_ground_and_the_shore_band_both_become_marsh(rule_inputs):
    classes = run_rules(rule_inputs)
    assert (classes[32:34] == CLASS_MARSH).all()  # Kärrtorv, above the water line
    # Rows 34-35 are till — forest soil — but inside the 0.6 m shore band.
    assert (classes[34:36] == CLASS_MARSH).all()
    assert (classes[0:4, 0:10] == CLASS_MARSH).all()  # the ytlager peat veneer
    # The shore band is a separate branch: with a wide band the marsh climbs.
    wide = run_rules(rule_inputs, shore_band_m=4.0)
    assert (wide[28:36] == CLASS_MARSH).all()
    assert (wide[36:40] == CLASS_WATER).all()


def test_farmland_needs_soil_slope_settlement_and_dry_ground(rule_inputs):
    classes = run_rules(rule_inputs)
    # Postglacial lera, flat, 100 m from a proxy, 6 m above the water line.
    assert (classes[24:28] == CLASS_FARMLAND).all()
    # Rows 28-31 are the same soil, but drained to within fresh_land_m of the line.
    assert (classes[28:32] == CLASS_MEADOW).all()
    # Move the settlement out of reach and the whole band drops to wet meadow.
    far = run_rules(rule_inputs, farmland_radius_m=10.0)
    assert (far[24:32] == CLASS_MEADOW).all()
    assert CLASS_FARMLAND not in set(np.unique(far))


def test_till_becomes_farmland_only_at_the_margin_of_a_fine_sediment(rule_inputs):
    """"Till margins" is taken literally — the fringe, never the whole moraine."""
    classes = run_rules(rule_inputs)
    # The flat till (rows 8-11) is 26-32 m from the fine sediment at row 24, so the
    # default 40 m margin makes it farmland...
    assert (classes[8:12] == CLASS_FARMLAND).all()
    # ...and with no margin at all it is forest again.
    narrow = run_rules(rule_inputs, till_margin_m=0.0)
    assert (narrow[8:12] == CLASS_BROADLEAF).all()


def test_glacial_clay_is_meadow_and_gravel_is_a_dry_corridor(rule_inputs):
    classes = run_rules(rule_inputs)
    assert (classes[20:24] == CLASS_MEADOW).all()
    assert (classes[16:20] == CLASS_DRY_CORRIDOR).all()


def test_bedrock_and_steep_ground_are_conifer(rule_inputs):
    classes = run_rules(rule_inputs)
    assert (classes[0:8, 10:] == CLASS_CONIFER).all()  # Urberg, minus the peat veneer
    assert (classes[12:16] == CLASS_CONIFER).all()  # till, but a 30° scarp
    gentle = run_rules(rule_inputs, forest_max_slope_deg=45.0)
    assert (gentle[12:16] == CLASS_BROADLEAF).all()


def test_registered_monument_footprints_are_kept_clear_of_trees(rule_inputs):
    """A fort or grave field's footprint is settled ground, not forest or farmland."""
    connect, group, peat_surface, slope, distance, _ = rule_inputs
    monument = np.full(SHAPE, np.inf, dtype=np.float64)
    monument[4:8, 20:30] = 0.0  # a fort on the bedrock band — was conifer
    monument[8:12, 0:10] = 0.0  # a grave field on flat till — was farmland
    monument[0:4, 0:10] = 0.0  # over the peat veneer — marsh must still win
    monument[36:40, 0:10] = 0.0  # in the sea — water must still win
    classes = classify(
        connect, group, peat_surface, slope, distance, monument, REFERENCE_LEVEL, RESOLUTION
    )
    assert (classes[4:8, 20:30] == CLASS_CLEARED).all()
    assert (classes[8:12, 0:10] == CLASS_CLEARED).all()
    assert (classes[0:4, 0:10] == CLASS_MARSH).all()
    assert (classes[36:40, 0:10] == CLASS_WATER).all()
    # Untouched ground keeps its earlier classification.
    assert (classes[8:12, 20:] == CLASS_FARMLAND).all()


def test_the_clear_margin_is_metric_and_tunable(rule_inputs):
    connect, group, peat_surface, slope, distance, _ = rule_inputs
    monument = np.full(SHAPE, np.inf, dtype=np.float64)
    monument[4:8, 20:30] = 15.0  # inside the default 20 m margin
    monument[4:8, 30:40] = 25.0  # just beyond it
    classes = classify(
        connect, group, peat_surface, slope, distance, monument, REFERENCE_LEVEL, RESOLUTION
    )
    assert (classes[4:8, 20:30] == CLASS_CLEARED).all()
    assert (classes[4:8, 30:40] == CLASS_CONIFER).all()
    wide = classify(
        connect, group, peat_surface, slope, distance, monument, REFERENCE_LEVEL, RESOLUTION,
        DEFAULT_PARAMS.__class__(**{
            **{f: getattr(DEFAULT_PARAMS, f) for f in DEFAULT_PARAMS.__dataclass_fields__},
            "monument_clear_m": 30.0,
        }),
    )
    assert (wide[4:8, 30:40] == CLASS_CLEARED).all()


def test_every_cell_is_classified_and_indices_stay_in_range(rule_inputs):
    classes = run_rules(rule_inputs)
    assert classes.dtype == np.uint8
    assert set(np.unique(classes)) <= set(range(len(landcover_classes(REFERENCE_LEVEL))))


def test_classify_rejects_inputs_that_disagree_on_shape(rule_inputs):
    connect, group, peat_surface, slope, distance, monument = rule_inputs
    with pytest.raises(LandcoverError, match="disagree on shape"):
        classify(
            connect[:-1], group, peat_surface, slope, distance, monument,
            REFERENCE_LEVEL, RESOLUTION,
        )
    with pytest.raises(LandcoverError, match="settlement distance grid"):
        classify(
            connect, group, peat_surface, slope, distance[:-1], monument,
            REFERENCE_LEVEL, RESOLUTION,
        )
    with pytest.raises(LandcoverError, match="monument distance grid"):
        classify(
            connect, group, peat_surface, slope, distance, monument[:-1],
            REFERENCE_LEVEL, RESOLUTION,
        )


def test_area_fractions_sum_to_one(rule_inputs):
    classes = run_rules(rule_inputs)
    fractions = area_fractions(classes, len(landcover_classes(REFERENCE_LEVEL)))
    assert len(fractions) == 8
    assert sum(fractions) == pytest.approx(1.0)
    assert fractions[CLASS_WATER] == pytest.approx(4.0 / SIZE)


def test_area_fractions_refuse_a_class_the_legend_does_not_declare():
    classes = np.array([[0, 9]], dtype=np.uint8)
    with pytest.raises(LandcoverError, match="class index 9"):
        area_fractions(classes, 8)


# --------------------------------------------------------------------------- #
# landcover_legend.json (contract §10)
# --------------------------------------------------------------------------- #


@pytest.fixture
def legend(fake_site, rule_inputs):
    classes = run_rules(rule_inputs)
    taxonomy = landcover_classes(REFERENCE_LEVEL)
    fractions = area_fractions(classes, len(taxonomy))
    return build_legend(fake_site, taxonomy, fractions, REFERENCE_LEVEL, SOILS_META, 1.0, 35)


def test_legend_matches_the_contract_shape(legend, fake_site):
    assert legend["schemaVersion"] == SCHEMA_VERSION == 1
    assert legend["site"] == fake_site.id
    assert legend["referenceYearCE"] == REFERENCE_YEAR_CE == 500
    assert legend["referenceLevelM"] == REFERENCE_LEVEL
    assert legend["source"]["api"] == SOILS_META["api"]
    assert [entry["index"] for entry in legend["classes"]] == list(range(8))
    assert len({entry["id"] for entry in legend["classes"]}) == 8
    assert all(entry["color"].startswith("#") for entry in legend["classes"])
    assert sum(entry["areaFraction"] for entry in legend["classes"]) == pytest.approx(1.0, abs=1e-3)


def test_every_class_rule_quotes_the_thresholds_the_code_used(legend):
    """The rule strings are disclosed verbatim, so they must state the real numbers."""
    rules = {entry["id"]: entry["rule"] for entry in legend["classes"]}
    assert f"{REFERENCE_LEVEL:.1f} m RH 2000" in rules["water"]
    assert f"{DEFAULT_PARAMS.shore_band_m:.1f} m" in rules["reed_marsh"]
    assert f"{DEFAULT_PARAMS.farmland_radius_m:.0f} m" in rules["farmland"]
    assert f"{DEFAULT_PARAMS.till_margin_m:.0f} m" in rules["farmland"]
    assert f"{DEFAULT_PARAMS.forest_max_slope_deg:.0f}°" in rules["broadleaf_forest"]
    assert f"{DEFAULT_PARAMS.monument_clear_m:.0f} m" in rules["settlement_cleared"]
    assert str(REFERENCE_YEAR_CE) in legend["classes"][0]["name"]


def test_vegetation_is_declared_only_where_the_app_should_instance_it(legend):
    vegetation = {entry["id"]: entry["vegetation"] for entry in legend["classes"]}
    assert vegetation["water"] is None and vegetation["farmland"] is None
    assert vegetation["settlement_cleared"] is None  # the whole point of the class
    assert vegetation["reed_marsh"]["type"] == "reeds"
    assert vegetation["broadleaf_forest"]["type"] == "broadleaf"
    assert vegetation["conifer_forest"]["type"] == "conifer"
    assert all(v["densityPerHa"] > 0 for v in vegetation.values() if v)


def test_calibration_reports_measured_numbers_and_refuses_to_invent_an_anchor(legend):
    text = legend["calibration"]
    assert "Hultberg" in text and "90–97 %" in text and "Scania" in text
    assert "No quantified (REVEALS-type) openness figure for Iron Age Uppland" in text
    assert "not force-fitted" in text
    # The percentages are the ones actually measured on this raster.
    forest = sum(
        entry["areaFraction"]
        for entry in legend["classes"]
        if entry["id"].endswith("_forest")
    )
    assert f"{100.0 * forest:.1f} % forest" in text


def test_calibration_survives_an_all_water_raster():
    """Degenerate input must not divide by a zero dry-land area."""
    fractions = [1.0] + [0.0] * 7
    assert "0:0" in calibration_text(fractions)


def test_method_and_caveat_say_what_the_model_is(legend):
    assert "rule engine" in legend["method"]
    assert "present-day soil surface" in legend["method"]
    assert str(REFERENCE_YEAR_CE) in legend["method"]
    assert "not evidence" in legend["caveat"] and len(legend["caveat"].splitlines()) == 1


# --------------------------------------------------------------------------- #
# the validator must actually reject violations
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "mutate, match",
    [
        (lambda g: g.update(schemaVersion=2), "schemaVersion"),
        (lambda g: g.update(site=""), "'site'"),
        (lambda g: g.update(caveat=""), "'caveat'"),
        (lambda g: g.update(calibration=""), "'calibration'"),
        (lambda g: g.update(referenceYearCE="500"), "referenceYearCE"),
        (lambda g: g.update(referenceLevelM="8.6"), "referenceLevelM"),
        (lambda g: g["source"].update(fetched=""), "source.'fetched'"),
        (lambda g: g["classes"].pop(0), "index"),
        (lambda g: g["classes"][2].update(index=9), "contiguous"),
        (lambda g: g["classes"][1].update(id=""), "id must be a non-empty string"),
        (lambda g: g["classes"][1].update(id=g["classes"][0]["id"]), "duplicate class id"),
        (lambda g: g["classes"][0].update(color="2d5a6b"), "#rrggbb"),
        (lambda g: g["classes"][0].update(color="#gggggg"), "#rrggbb"),
        (lambda g: g["classes"][3].update(rule=""), "rule must be a non-empty string"),
        (lambda g: g["classes"][0].pop("vegetation"), "vegetation is required"),
        (lambda g: g["classes"][1]["vegetation"].update(type="grass"), "vegetation.type"),
        (lambda g: g["classes"][1]["vegetation"].update(densityPerHa=0), "densityPerHa"),
        (lambda g: g["classes"][0].update(areaFraction=1.5), "outside \\[0, 1\\]"),
        (lambda g: g["classes"][0].update(areaFraction="0.1"), "areaFraction must be a number"),
        (lambda g: g["classes"][6].update(areaFraction=0.5), "sum to"),
    ],
)
def test_validator_rejects(legend, mutate, match):
    broken = copy.deepcopy(legend)
    mutate(broken)
    with pytest.raises(LandcoverError, match=match):
        validate_legend(broken)


def test_validator_rejects_more_classes_than_the_contract_allows(legend):
    broken = copy.deepcopy(legend)
    template = broken["classes"][0]
    broken["classes"] = [
        {**template, "index": i, "id": f"c{i}", "areaFraction": 1.0 / 33} for i in range(33)
    ]
    with pytest.raises(LandcoverError, match="exceeds the 32"):
        validate_legend(broken)


def test_build_legend_refuses_a_fraction_per_class_mismatch(fake_site):
    taxonomy = landcover_classes(REFERENCE_LEVEL)
    with pytest.raises(LandcoverError, match="area fractions"):
        build_legend(fake_site, taxonomy, [1.0], REFERENCE_LEVEL, SOILS_META, 1.0, 1)


# --------------------------------------------------------------------------- #
# files on disk
# --------------------------------------------------------------------------- #


def test_write_legend_roundtrips_as_utf8_json(tmp_path, legend):
    path = write_legend(tmp_path / "landcover_legend.json", legend)
    reloaded = json.loads(path.read_text(encoding="utf-8"))
    assert reloaded == legend
    validate_legend(reloaded)
    assert "Kärrtorv" in path.read_text(encoding="utf-8")  # not ä-escaped


def test_write_legend_refuses_an_invalid_legend(tmp_path, legend):
    broken = copy.deepcopy(legend)
    broken["classes"][0]["areaFraction"] = 0.9
    with pytest.raises(LandcoverError):
        write_legend(tmp_path / "landcover_legend.json", broken)
    assert not (tmp_path / "landcover_legend.json").exists()


def test_class_raster_roundtrips_with_the_contract_encoding(tmp_path, rule_inputs, legend):
    """Contract §9: uint8 indices, no nodata, DEFLATE COG, every value in the legend."""
    classes = run_rules(rule_inputs)
    path = write_class_grid(tmp_path / "landcover.tif", classes, TRANSFORM)
    with rasterio.open(path) as src:
        assert src.count == 1 and src.dtypes[0] == "uint8"
        assert src.nodata is None
        assert src.crs.to_epsg() == 3006
        assert src.transform == TRANSFORM
        assert src.profile["compress"].lower() == "deflate"
        structure = src.tags(ns="IMAGE_STRUCTURE")
        assert structure["PREDICTOR"] == "2" and structure["LAYOUT"] == "COG"
        assert src.tags(1).get("SCALE") is None  # an index is not a measurement
        raw = src.read(1)
    assert np.array_equal(raw, classes)
    assert int(raw.max()) < len(legend["classes"])


def test_class_raster_writer_refuses_a_non_uint8_grid(tmp_path):
    with pytest.raises(ValueError, match="uint8"):
        write_class_grid(tmp_path / "x.tif", np.zeros(SHAPE, dtype=np.int16), TRANSFORM)


def test_missing_inputs_name_the_command_that_produces_them(tmp_path, fake_site, monkeypatch):
    """A missing input is a rerun instruction, never a traceback."""
    from fornborg_pipeline import sites as sites_module
    from fornborg_pipeline.landcover import load_inputs

    monkeypatch.setattr(sites_module, "APP_DATA_DIR", tmp_path)
    out_dir = fake_site.out_dir
    out_dir.mkdir(parents=True)

    with pytest.raises(LandcoverError, match=r"fornborg_pipeline\.build --site testsite"):
        load_inputs(fake_site)

    (out_dir / fake_site.context.path).touch()
    with pytest.raises(LandcoverError, match=r"fornborg_pipeline\.water --site testsite"):
        load_inputs(fake_site)

    (out_dir / "water_connect.tif").touch()
    (out_dir / "shoreline.json").touch()
    with pytest.raises(LandcoverError, match=r"fornborg_pipeline\.fetch_sites --site testsite"):
        load_inputs(fake_site)


def test_class_raster_matches_the_context_grids_geometry(tmp_path, fake_site, fake_source_clean):
    """§9: the raster shares `grids.context`'s geometry, tiling and overviews exactly."""
    from fornborg_pipeline.clip_dem import build_grids, write_grid
    from fornborg_pipeline.landcover import _check_context_profile

    source, transform, nodata = fake_source_clean
    context = build_grids(source, transform, nodata, fake_site)["context"]
    reference = write_grid(tmp_path / "dem_context.tif", context)

    classes = np.zeros((context.height, context.width), dtype=np.uint8)
    candidate = write_class_grid(tmp_path / "landcover.tif", classes, context.transform)
    _check_context_profile(reference, candidate)  # must not raise

    shifted = Affine(
        context.transform.a, 0.0, context.transform.c + 100.0, 0.0, context.transform.e,
        context.transform.f,
    )
    moved = write_class_grid(tmp_path / "moved.tif", classes, shifted)
    with pytest.raises(LandcoverError, match="does not match"):
        _check_context_profile(reference, moved)
