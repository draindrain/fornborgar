"""Reconstruction parser (contract §14, docs/reconstruction-mode.md).

Two kinds of test here, and the split is deliberate:

  * **Arithmetic**, on synthetic inputs — the §5 transforms are checked against
    the document's own published tables (§5.1's parameter box, §5.2's worked
    corpus-median mound), so a change to the derivation has to change the
    document too.
  * **Coverage**, on the committed Broborg bundle — §3 measured what the register
    actually affords (92 % plan size, 87 % stone calibre, 54 % kerb, 32 % pit,
    28 of 31 grave fields stating their own count), and those percentages are the
    regression target. A parser edit that quietly stops finding kerbs shows up
    here as a number, not as a subtly wrong scene six months later.
  * **The interior gate**, on the national survey — the §7.5.2 rule is replayed
    over all 1 304 descriptions in `docs/interior-survey-2026-08-30.json`, which
    is both the reference implementation and the fixture. The forts that pass, the
    forts where this parser and the survey disagree, and the 4.1 % rate are all
    pinned, so a rule edit has to move a named fort rather than a screenshot.

No network, no credentials, no rasters: the whole module under test is a pure
function of strings and dicts.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fornborg_pipeline import reconstruct as R  # noqa: E402
from fornborg_pipeline.fetch_sites import SELECTED_TYPES  # noqa: E402
from fornborg_pipeline.manifest import (  # noqa: E402
    RECONSTRUCTION_LAYER,
    add_reconstruction_asset,
)

BUNDLE = Path(__file__).resolve().parents[2] / "app" / "public" / "data" / "broborg"


@pytest.fixture(scope="module")
def broborg_sites() -> dict:
    return json.loads((BUNDLE / "sites.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def document(broborg_sites: dict) -> dict:
    return R.build_document(broborg_sites, "broborg", generated="2026-01-01")


@pytest.fixture(scope="module")
def by_id(document: dict) -> dict:
    return {m["id"]: m for m in document["monuments"]}


# --------------------------------------------------------------------------- #
# primitives — Swedish surveyor's shorthand
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Hög, 7 m diam, 0,7 m h", 7.0),
        ("Stensättning, ca 4,0 m diam", 4.0),
        ("rund, 10-11 m diam", 10.5),          # a stated range takes its midpoint
        ("ca 10 m i diam", 10.0),
        ("Röse, närmast runt, ca 10 m i diam ca 1,5 m h", 10.0),
    ],
)
def test_parses_round_plan_sizes(text: str, expected: float) -> None:
    assert R.parse_plan(text)["diameterM"] == pytest.approx(expected)


def test_parses_rectangular_plan_with_orientation() -> None:
    plan = R.parse_plan("Gravfält, 245x140 m (N-S) bestående av ca 65 fornlämningar")
    assert plan["lengthM"] == 245.0
    assert plan["widthM"] == 140.0
    assert plan["form"] == "rectangular"
    # The equal-area circle is what the sampler and the footprint mesh use.
    assert plan["diameterM"] == pytest.approx((245.0 * 140.0) ** 0.5, rel=1e-3)


@pytest.mark.parametrize(
    "text,form",
    [
        ("Stensättning, rund, ca 8 m diam", "round"),
        ("kvadratisk stensättning, 5x5 m", "square"),
        ("Stensättning, rektangulär, 9x5 m (NV-SÖ)", "rectangular"),
        ("oval stensättning, 6x4 m", "oval"),
        ("trekantig stensättning, 5 m i sida", "triangular"),
    ],
)
def test_parses_every_plan_form_the_register_uses(text: str, form: str) -> None:
    """§6.C: the plan form is in the text 41 % of the time, so use it."""
    assert R.parse_plan(text)["form"] == form


@pytest.mark.parametrize(
    "text,expected",
    [
        ("1,2 m h", 1.2),
        ("0,2-0,3 m h", 0.25),
        ("ca 2 m hög", 2.0),
        ("2,0 m h vid basen", 2.0),
    ],
)
def test_parses_heights(text: str, expected: float) -> None:
    assert R.parse_height(text) == pytest.approx(expected)


def test_parses_stone_calibre_range() -> None:
    assert R.parse_stone("av 0,3-1 m st stenar, enstaka större") == [0.3, 1.0]


def test_plan_size_range_is_not_read_as_stone_calibre() -> None:
    """`2x2-7x7 m st` is "2x2 to 7x7 metres large", not seven-metre boulders.

    Without the guard the `7 m st` tail matches and a square stone setting is
    surfaced with stones bigger than itself.
    """
    assert R.parse_stone("De kvadratiska stensättningarna är 2x2-7x7 m st (NV-SÖ)") is None


def test_parses_kerb_from_a_later_sentence() -> None:
    """The kerb is normally its own sentence, which is why §5.2 can rely on it."""
    kerb = R.parse_kerb(
        "Stensättning, 8 m diameter, 1,2 m h, plan övertorvad ovansida. "
        "Kantkedja 1,2 m h av 0,7-1,4 m st stenar."
    )
    assert kerb == {"heightM": 1.2, "stoneM": [0.7, 1.4]}


def test_parses_robbing_pits_with_dimensions() -> None:
    pits = R.parse_pits("I mitten en grop, ca 2x1,5 m och ca 0,5 m djup.")
    assert pits == [{"lengthM": 2.0, "widthM": 1.5, "depthM": 0.5}]


def test_a_pit_without_dimensions_is_not_invented() -> None:
    assert R.parse_pits("Ytan är gropig och ojämn.") == []


@pytest.mark.parametrize(
    "token,degrees",
    [("N", 0.0), ("Ö", 90.0), ("S", 180.0), ("V", 270.0), ("VNV", 292.5), ("ÖSÖ", 112.5)],
)
def test_swedish_compass_points(token: str, degrees: float) -> None:
    """Ö is east and V is west — an English E/W mapping mirrors the site."""
    assert R.bearing_deg(token) == degrees


def test_type_clause_finds_the_records_own_monument() -> None:
    """Several records open by describing a *neighbour*, so "first sentence" lies."""
    text = (
        "1) Stensättning, rund, ca 8 m diam fylld, ca 0,5 m h. "
        "Ca 5 m S 20cg Ö om nr 1 är 2) Hög, ca 7 m diam, 0,8 m h, övertorvad."
    )
    assert "Hög" in R.type_clause(text, "mound")
    assert R.parse_plan(R.type_clause(text, "mound"))["diameterM"] == 7.0


# --------------------------------------------------------------------------- #
# §5.1 — rampart height from the standing wall plus its debris apron
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "spread,thickness,apron_depth,expected",
    [
        # docs/reconstruction-mode.md §5.1, row for row.
        (8.0, 6.0, 0.30, 2.08),
        (8.0, 4.0, 0.30, 2.25),
        (11.5, 5.0, 0.45, 2.50),
        (15.0, 6.0, 0.60, 2.77),
        (15.0, 4.0, 0.60, 3.40),
    ],
)
def test_rampart_transform_matches_the_published_parameter_box(
    spread: float, thickness: float, apron_depth: float, expected: float
) -> None:
    params = R.TransformParams(apron_depth_m=apron_depth)
    result = R.rampart_original_height(2.0, spread, wall_thickness_m=thickness, params=params)
    assert result["heightM"] == pytest.approx(expected, abs=0.01)


def test_rampart_transform_bounds_broborg_between_two_and_three_and_a_half_metres() -> None:
    """§5.1: across the whole parameter box the answer spans 2.08–3.40 m."""
    heights = [
        R.rampart_original_height(
            2.0, spread, wall_thickness_m=thickness, params=R.TransformParams(apron_depth_m=depth)
        )["heightM"]
        for spread in (8.0, 11.5, 15.0)
        for thickness in (4.0, 5.0, 6.0)
        for depth in (0.30, 0.45, 0.60)
    ]
    assert min(heights) >= 2.0
    assert max(heights) <= 3.45


def test_a_wall_with_no_apron_keeps_its_standing_height() -> None:
    """Spread == thickness means nothing has fallen off: h_orig is a lower bound."""
    result = R.rampart_original_height(2.0, 5.0, wall_thickness_m=5.0)
    assert result["heightM"] == 2.0
    assert result["apronIncrementM"] == 0.0


# --------------------------------------------------------------------------- #
# §5.2 / §5.3 — mound re-profiling, gated on the kerb
# --------------------------------------------------------------------------- #


def test_the_corpus_median_mound_gets_narrower_and_twice_as_tall() -> None:
    """§5.2's worked example: 7 m × 0.7 m → 5.7 m × 1.6 m at 30° repose."""
    result = R.reprofile(7.0, 0.7, kerbed=False, repose_deg=30.0)
    assert result["diameterM"] == pytest.approx(5.7, abs=0.1)
    assert result["heightM"] == pytest.approx(1.6, abs=0.05)
    assert result["transform"] == "repose-reprofile"


def test_reprofiling_conserves_volume() -> None:
    before = R.cap_volume(7.0, 0.7)
    result = R.reprofile(7.0, 0.7, kerbed=False, repose_deg=30.0)
    radius = result["diameterM"] / 2.0
    after = (3.14159265358979 / 3.0) * radius * radius * result["heightM"]
    # The transform is exact; the file rounds its outputs to centimetres, which
    # is what this reads back.
    assert after == pytest.approx(before, rel=5e-3)


def test_a_kerbed_mound_is_never_pulled_inside_its_own_kerb() -> None:
    """§5.2's built-in sanity check, and the reason the kerb gate exists at all."""
    result = R.reprofile(7.0, 0.7, kerbed=True, repose_deg=30.0)
    assert result["diameterM"] == 7.0
    assert result["heightM"] == pytest.approx(0.7, abs=1e-3)


def test_filling_a_robbing_pit_raises_a_kerbed_mound_without_widening_it() -> None:
    """§5.3: the pit dimensions are recorded, so the fill is a measured operation."""
    pits = [{"lengthM": 2.0, "widthM": 1.5, "depthM": 0.5}]
    plain = R.reprofile(7.0, 0.7, kerbed=True, repose_deg=30.0)
    filled = R.reprofile(7.0, 0.7, kerbed=True, repose_deg=30.0, pits=pits)
    assert filled["diameterM"] == plain["diameterM"] == 7.0
    assert filled["heightM"] > plain["heightM"]
    assert filled["transform"] == "kerb-fixed+pit-fill"


def test_dry_stone_stands_steeper_than_earth() -> None:
    """35° for a cairn, 30° for a mound (§5.2) — same volume, different shape."""
    earth = R.reprofile(7.0, 0.7, kerbed=False, repose_deg=30.0)
    stone = R.reprofile(7.0, 0.7, kerbed=False, repose_deg=35.0)
    assert stone["heightM"] > earth["heightM"]
    assert stone["diameterM"] < earth["diameterM"]


# --------------------------------------------------------------------------- #
# the taxonomy, and what happens at its edges
# --------------------------------------------------------------------------- #


def test_every_selected_kmr_type_maps_to_an_archetype() -> None:
    """§4 covers all 26 types in the fetch filter so a site elsewhere in the
    country cannot silently fall through to nothing."""
    assert set(SELECTED_TYPES) - set(R.ARCHETYPES) == set()


def test_every_archetype_has_defaults_and_a_period() -> None:
    for archetype in set(R.ARCHETYPES.values()):
        assert archetype in R.ARCHETYPE_DEFAULTS
        assert archetype in R.PERIODS


def test_a_record_with_no_parseable_dimensions_falls_back_and_says_so() -> None:
    """§11.5: the parser must degrade to defaults, and the app must be able to
    show *how much* of a site is measured versus defaulted."""
    monument = R.build_monument(
        {"id": "L0:1", "lamningstyp": "Stensättning", "description": "Stensättning. Övertorvad."}
    )
    assert monument is not None
    defaults = R.ARCHETYPE_DEFAULTS["stone-setting"]
    assert monument["plan"]["diameterM"] == defaults.diameter_m
    assert monument["plan"]["source"] == "assumed"
    assert monument["tiers"]["plan"] == "assumed"
    assert "plan.diameterM" in monument["fallbacks"]
    assert "profile.heightM" in monument["fallbacks"]
    assert monument["parseConfidence"] == 0.0


def test_a_record_with_no_description_at_all_still_produces_a_monument() -> None:
    monument = R.build_monument({"id": "L0:2", "lamningstyp": "Hög"})
    assert monument is not None
    assert monument["parseConfidence"] == 0.0
    assert monument["archetype"] == "mound"


def test_an_unmapped_type_is_skipped_rather_than_guessed() -> None:
    assert R.build_monument({"id": "L0:3", "lamningstyp": "Kolningsanläggning"}) is None


def test_a_stone_setting_never_gains_height(document: dict) -> None:
    """§6.C: flatness is the type. The work is cleaning, not raising."""
    flat = [
        m
        for m in document["monuments"]
        if m["archetype"] in ("stone-setting", "fire-cracked-mound")
    ]
    assert flat
    for monument in flat:
        assert monument["profile"]["heightM"] <= monument["profile"]["presentHeightM"] + 1e-9


def test_no_kerbed_monument_shrinks_inside_its_kerb(document: dict) -> None:
    kerbed = [m for m in document["monuments"] if m["features"]["kerb"]]
    assert kerbed
    for monument in kerbed:
        assert (
            monument["profile"]["diameterM"] >= monument["profile"]["presentDiameterM"] - 1e-9
        )


# --------------------------------------------------------------------------- #
# §3 coverage on the committed bundle — the regression target
# --------------------------------------------------------------------------- #


def test_every_broborg_record_maps_to_an_archetype(document: dict) -> None:
    coverage = document["coverage"]
    assert coverage["records"] == 127
    assert coverage["reconstructed"] == 127
    assert coverage["unmappedTypes"] == 0


@pytest.mark.parametrize(
    "key,documented,tolerance",
    [
        # docs/reconstruction-mode.md §3, measured on these 127 records.
        ("planParsed", 0.92, 0.03),
        ("stoneParsed", 0.87, 0.03),
        ("heightParsed", 0.88, 0.04),
        ("kerbParsed", 0.54, 0.03),
        ("pitsParsed", 0.32, 0.04),
        ("turfNoted", 0.77, 0.03),
        ("damageNoted", 0.11, 0.03),
    ],
)
def test_coverage_matches_the_documented_percentages(
    document: dict, key: str, documented: float, tolerance: float
) -> None:
    assert document["coverage"][key] == pytest.approx(documented, abs=tolerance)


def test_the_archetype_histogram_matches_the_corpus_analysis(document: dict) -> None:
    """§2.1's table, regrouped by §4's archetypes rather than by register label."""
    histogram = document["coverage"]["byArchetype"]
    assert histogram["stone-setting"] == 58   # 53 Stensättning + 5 Grav mark. av sten/block
    assert histogram["grave-field"] == 31     # 28 Gravfält + 3 Grav- och boplatsområde
    assert histogram["mound"] == 12
    assert histogram["fire-cracked-mound"] == 9
    assert histogram["cairn"] == 7
    assert histogram["fort"] == 1


def test_grave_fields_state_their_own_monument_counts(document: dict) -> None:
    """§3.1: 28 of 31 do, and the counts run 5 to 230."""
    coverage = document["coverage"]
    assert coverage["graveFields"] == 31
    assert coverage["graveFieldsWithStatedCount"] == 28

    counts = sorted(
        m["field"]["count"] for m in document["monuments"] if m["archetype"] == "grave-field"
    )
    assert counts[0] == 5
    assert counts[-1] == 230


def test_the_same_bundle_parses_identically_twice(broborg_sites: dict) -> None:
    """Nothing in the parser may depend on iteration or wall-clock order."""
    first = R.build_document(broborg_sites, "broborg", generated="2026-01-01")
    second = R.build_document(broborg_sites, "broborg", generated="2026-01-01")
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


# --------------------------------------------------------------------------- #
# §3.1 — a grave field is a compositional recipe
# --------------------------------------------------------------------------- #


def test_the_worked_grave_field_is_parsed_as_the_document_reads_it(by_id: dict) -> None:
    """§3.1's own example, L1941:5480: 65 monuments = 5 mounds + 2 cairns +
    57 round filled stone settings + 1 standing stone, with a size range each."""
    field = by_id["L1941:5480"]["field"]
    assert field["count"] == 65
    assert field["countSource"] == "measured"

    counts = {(c["archetype"], c.get("form")): c for c in field["classes"]}
    assert counts[("mound", None)]["count"] == 5
    assert counts[("cairn", None)]["count"] == 2
    assert counts[("stone-setting", "round")]["count"] == 57
    assert counts[("standing-stone", None)]["count"] == 1

    # …and the ranges the sampler draws individual monuments from are measured.
    assert counts[("stone-setting", "round")]["diameterM"] == [3.0, 8.0]
    assert counts[("stone-setting", "round")]["heightM"] == [0.2, 0.6]
    assert counts[("mound", None)]["diameterM"] == [6.0, 9.0]
    assert counts[("cairn", None)]["diameterM"] == [10.0, 10.0]


def test_subclasses_of_one_archetype_keep_their_own_size_ranges(by_id: dict) -> None:
    """L1941:5542 itemises round, square, rectangular and triangular settings
    separately, and the register gives each its own dimensions."""
    classes = by_id["L1941:5542"]["field"]["classes"]
    squares = next(c for c in classes if c["archetype"] == "stone-setting" and c["form"] == "square")
    rounds = next(c for c in classes if c["archetype"] == "stone-setting" and c["form"] == "round")
    assert squares["count"] == 4
    assert rounds["count"] == 40
    assert squares["diameterM"] == [2.0, 7.0]     # "2x2-7x7 m st"
    assert rounds["diameterM"] == [3.0, 8.0]
    assert squares["diameterM"] != rounds["diameterM"]


def test_a_stated_count_below_the_itemised_one_defers_to_the_itemisation() -> None:
    """L1943:7041 says "bestående av 5 fornlämningar. Dessa utgöres av 6 runda
    stensättningar". The register contradicts itself; the itemisation is the more
    specific statement, and the class counts must still sum to the total."""
    composition = R.parse_composition(
        "Gravfält 60x30 m (N-S) bestående av 5 fornlämningar. "
        "Dessa utgöres av 6 runda stensättningar. Dessa är 3,5-9 m diam och 0,2-0,6 m h.",
        R.ARCHETYPE_DEFAULTS["grave-field"],
    )
    assert composition["count"] == 6
    assert sum(c["count"] for c in composition["classes"]) == 6


def test_a_grave_field_of_five_and_one_of_two_hundred_use_the_same_code(document: dict) -> None:
    """The count is data, not a constant — §3.1's range is 5 to 230."""
    fields = [m for m in document["monuments"] if m["archetype"] == "grave-field"]
    smallest = min(fields, key=lambda m: m["field"]["count"])
    largest = max(fields, key=lambda m: m["field"]["count"])
    assert smallest["field"]["count"] == 5
    assert largest["field"]["count"] == 230
    assert largest["field"]["count"] / smallest["field"]["count"] == 46
    for monument in (smallest, largest):
        assert monument["field"]["classes"]
        assert sum(c["count"] for c in monument["field"]["classes"]) == monument["field"]["count"]


def test_an_unitemised_remainder_is_carried_rather_than_dropped() -> None:
    """A surveyor counts everything and itemises the identifiable; the difference
    must not silently vanish from the field."""
    composition = R.parse_composition(
        "Gravfält, 100x50 m (N-S) bestående av ca 20 fornlämningar. Dessa utgörs av 3 högar.",
        R.ARCHETYPE_DEFAULTS["grave-field"],
    )
    assert composition["count"] == 20
    assert sum(c["count"] for c in composition["classes"]) == 20
    assert any(c.get("note") for c in composition["classes"])


# --------------------------------------------------------------------------- #
# §3.2 / §6.A — the fort record is a construction description
# --------------------------------------------------------------------------- #


def test_the_broborg_fort_record_yields_two_ramparts(by_id: dict) -> None:
    fort = by_id["L1943:7827"]["fort"]
    inner, outer = fort["ramparts"]
    assert inner["id"] == "inner"
    assert outer["id"] == "outer"
    # "ca 300 m l, 8-15 m br och 1-2 m h, av i allmänhet 0,3-1 m st stenar"
    assert inner["lengthM"] == 300.0
    assert inner["spreadM"] == [8.0, 15.0]
    assert inner["presentHeightM"] == [1.0, 2.0]
    assert inner["stoneM"] == [0.3, 1.0]
    assert outer["lengthM"] == 140.0
    assert outer["spreadM"] == [7.0, 10.0]


def test_the_broborg_wall_reconstructs_to_the_documented_default(by_id: dict) -> None:
    """§5.1/§7.2: 2 m standing + a 0.5 m apron increment = the 2.5 m default."""
    inner = by_id["L1943:7827"]["fort"]["ramparts"][0]
    assert inner["standingHeightM"] == 2.0
    assert inner["heightM"] == pytest.approx(2.5, abs=0.01)
    assert inner["transform"] == "rampart-apron-conservation"
    assert 2.08 <= inner["heightM"] <= 3.40


def test_entrances_belong_to_the_wall_they_are_described_on(by_id: dict) -> None:
    """KMR places the inner entrances at VNV/ÖSÖ and the outer at ÖSÖ/NNÖ —
    four in total, not four on each wall."""
    inner, outer = by_id["L1943:7827"]["fort"]["ramparts"]
    assert [e["bearing"] for e in inner["entrances"]] == ["VNV", "ÖSÖ"]
    assert [e["bearing"] for e in outer["entrances"]] == ["ÖSÖ", "NNÖ"]
    assert all(e["widthM"] == [3.0, 5.0] for e in inner["entrances"] + outer["entrances"])


def test_the_fort_record_carries_its_construction_detail(by_id: dict) -> None:
    inner = by_id["L1943:7827"]["fort"]["ramparts"][0]
    assert inner["drystone"] is True      # "Ställvis 1 m h kallmurning"
    assert inner["earthBacked"] is True   # "förstärkt med jord"
    assert inner["vitrified"] is True     # "Förslaggad och skörbränd sten"


def test_broborg_scores_full_fort_confidence(by_id: dict) -> None:
    """§6.A.1: the Mälardalen survey's operational definition, met on every count."""
    fort = by_id["L1943:7827"]["fort"]
    assert fort["confidence"] == 1.0
    assert fort["criteria"]["kallmurning"] is True
    assert fort["criteria"]["wallAtLeast1m"] is True
    assert fort["criteria"]["wallRoundOrAcross"] is True
    assert fort["criteria"]["compactEnclosure"] is True


def test_a_thin_fort_record_scores_below_the_threshold() -> None:
    """§6.A.1: roughly four in five registered `Fornborg` records are probably not
    Migration Period forts, and the discriminating criteria are the ones missing
    from a record like this one."""
    monument = R.build_monument(
        {
            "id": "L0:9",
            "lamningstyp": "Fornborg",
            "description": "Fornborg, 400x300 m. Vallen är otydlig, 0,3 m h.",
        }
    )
    assert monument is not None
    fort = monument["fort"]
    assert fort["confidence"] < R.DEFAULT_PARAMS.fort_confidence_threshold
    assert fort["criteria"]["kallmurning"] is False
    assert fort["criteria"]["wallAtLeast1m"] is False
    assert fort["criteria"]["compactEnclosure"] is False


def test_a_fort_record_with_one_undifferentiated_wall_still_builds() -> None:
    """National scope (§11.5): degrade to one rampart, never to nothing."""
    monument = R.build_monument(
        {
            "id": "L0:10",
            "lamningstyp": "Fornborg",
            "description": "Fornborg, 90x70 m. Kallmurning bevarad, 1,5 m h, 6 m br.",
        }
    )
    assert monument is not None
    assert len(monument["fort"]["ramparts"]) == 1
    assert monument["fort"]["ramparts"][0]["id"] == "inner"


# --------------------------------------------------------------------------- #
# §9 — provenance per part, never one averaged badge
# --------------------------------------------------------------------------- #


def test_a_monument_carries_a_tier_per_part(by_id: dict) -> None:
    """§9.1: a mound is Measured in plan, Model in profile, Conjecture in surface.
    The popup says so per part rather than averaging to one reassuring label."""
    monument = by_id["L1943:6889"]
    assert monument["archetype"] == "mound"
    assert monument["tiers"]["plan"] == "measured"
    assert monument["tiers"]["profile"] == "derived"
    assert monument["tiers"]["surface"] == "assumed"


def test_a_derived_profile_keeps_the_measurement_it_came_from(document: dict) -> None:
    """§9.3: every transform is reversible and quoted, so the file must carry the
    ruin measurement next to the reconstruction."""
    for monument in document["monuments"]:
        profile = monument["profile"]
        assert profile["presentHeightM"] is not None
        assert profile["presentDiameterM"] is not None
        assert profile["transform"] in {
            "none",
            "pit-omit",
            "kerb-fixed",
            "kerb-fixed+pit-fill",
            "repose-reprofile",
            "repose-reprofile+pit-fill",
            "rampart-apron-conservation",
        }


def test_grave_field_placement_is_badged_assumed(by_id: dict) -> None:
    """§6.G: composition is measured, individual positions are not."""
    assert by_id["L1941:5480"]["tiers"]["placement"] == "assumed"


def test_an_extreme_reprofile_is_flagged_rather_than_clamped(by_id: dict) -> None:
    """§5.2 conserves volume, so a 28 × 1.1 m "röse" becomes 18 × 6.3 m. Clamping
    would make the published derivation unreproducible; flagging keeps it
    checkable."""
    monument = by_id["L1943:7993"]
    assert monument["warnings"]
    assert "5.2" in monument["warnings"][0]


# --------------------------------------------------------------------------- #
# the file itself (contract §14)
# --------------------------------------------------------------------------- #


def test_the_document_validates(document: dict) -> None:
    R.validate_document(document)


def test_no_monument_carries_coordinates_or_ground_heights(document: dict) -> None:
    """Contract §0/§14: local [x, z] live in sites.json and ground height is
    sampled at runtime, so the reconstruction can never drift from the terrain."""
    for monument in document["monuments"]:
        assert "position" not in monument
        assert "geometryLocal" not in monument
        blob = json.dumps(monument)
        assert "EPSG" not in blob
        assert "easting" not in blob


def test_validation_rejects_a_monument_that_smuggles_in_a_position(document: dict) -> None:
    broken = json.loads(json.dumps(document))
    broken["monuments"][0]["position"] = {"x": 1.0, "z": 2.0}
    with pytest.raises(R.ReconstructError, match="position"):
        R.validate_document(broken)


def test_validation_rejects_an_unknown_archetype(document: dict) -> None:
    broken = json.loads(json.dumps(document))
    broken["monuments"][0]["archetype"] = "spaceship"
    with pytest.raises(R.ReconstructError, match="archetype"):
        R.validate_document(broken)


def test_validation_rejects_a_bad_tier(document: dict) -> None:
    broken = json.loads(json.dumps(document))
    broken["monuments"][0]["tiers"]["plan"] = "probably"
    with pytest.raises(R.ReconstructError, match="tiers"):
        R.validate_document(broken)


def test_the_derivation_block_quotes_its_own_arithmetic(document: dict) -> None:
    """§9.3: the methods panel shows the formulae, not the conclusions."""
    derivation = document["derivation"]
    assert derivation["method"] == R.DERIVATION_METHOD
    assert "h_standing" in derivation["description"]
    assert "angle of repose" in derivation["description"]
    params = derivation["params"]
    assert params["packing"] == 0.85
    assert params["reposeEarthDeg"] == 30.0
    assert params["reposeStoneDeg"] == 35.0
    assert params["wallThicknessM"] == 5.0


def test_the_archetype_defaults_ship_with_the_file(document: dict) -> None:
    """§1: a number that is not from the record or the literature is a *default*,
    and it is meant to be exposed as a tunable — so it travels with the data."""
    defaults = document["defaults"]
    # Every archetype, plus the two §15 keys the interior needs. `farmstead`
    # carries both: §14's footprint and §6.H's house numbers.
    assert set(defaults) == set(R.ARCHETYPE_DEFAULTS) | {"interior"}
    assert defaults["mound"]["diameterM"] == 7.0
    assert defaults["cairn"]["stoneM"] == [0.4, 0.6]
    assert defaults["stone-setting"]["reprofile"] is False
    assert defaults["farmstead"]["lengthM"] == [20.0, 40.0]
    assert defaults["farmstead"]["hipPitchDeg"] >= defaults["farmstead"]["roofPitchDeg"]
    assert defaults["interior"]["state"] == "cleared"


def test_period_gates_keep_runestones_out_of_the_migration_period(document: dict) -> None:
    """§8: at 500 CE there must be no runestones, and the fort must be standing."""
    by_archetype = {m["archetype"]: m["period"] for m in document["monuments"]}
    assert by_archetype["runestone"]["builtCE"] == 950
    assert by_archetype["fort"]["builtCE"] <= 500 < by_archetype["fort"]["abandonedCE"]


# --------------------------------------------------------------------------- #
# the manifest side of the contract
# --------------------------------------------------------------------------- #


def test_the_committed_broborg_manifest_declares_the_asset() -> None:
    manifest = json.loads((BUNDLE / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["assets"]["reconstruction"] == R.RECONSTRUCTION_PATH
    layer = next(entry for entry in manifest["layers"] if entry["id"] == "reconstruction")
    assert layer["provenance"] == "conjecture"


def test_adding_the_asset_is_idempotent() -> None:
    manifest = {"assets": {"sites": "sites.json"}, "layers": []}
    add_reconstruction_asset(manifest, "reconstruction.json")
    add_reconstruction_asset(manifest, "reconstruction.json")
    assert manifest["assets"]["reconstruction"] == "reconstruction.json"
    assert [layer["id"] for layer in manifest["layers"]] == [RECONSTRUCTION_LAYER["id"]]


def test_the_committed_file_matches_a_fresh_parse(broborg_sites: dict) -> None:
    """The bundle is committed, so a parser change that was never re-run shows up
    here rather than as a stale scene."""
    committed = json.loads((BUNDLE / "reconstruction.json").read_text(encoding="utf-8"))
    fresh = R.build_document(broborg_sites, "broborg", generated=committed["generated"])
    assert committed == fresh

# --------------------------------------------------------------------------- #
# §7.5.2 — the interior evidence gate
#
# The same split as the rest of this file: rule cases on the **real description
# text** the national survey recorded, and a coverage replay over all 1 304 forts
# whose rates are pinned. `docs/interior-survey-2026-08-30.json` is both the
# reference implementation of the rule and the regression fixture — it is a
# measurement of the register, so a parser edit that quietly widens the gate
# shows up here as a fort count, not as longhouses in a screenshot.
# --------------------------------------------------------------------------- #

SURVEY = Path(__file__).resolve().parents[2] / "docs" / "interior-survey-2026-08-30.json"


@pytest.fixture(scope="module")
def survey() -> dict:
    return json.loads(SURVEY.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def survey_forts(survey: dict) -> dict:
    return {fort["slug"]: fort for fort in survey["forts"]}


def fort_record(description: str, record_id: str = "L0000:1", **extra) -> dict:
    """A minimal `sites.json` fort record (contract §3)."""
    return {
        "id": record_id,
        "name": "test",
        "lamningstyp": "Fornborg",
        "provenance": "measured",
        "position": {"x": 0.0, "z": 0.0},
        "description": description,
        **extra,
    }


def verdicts(text: str) -> list[str]:
    return [hit["verdict"] for hit in R.scan_interior_terms(R.normalise(text))]


# --- channel 1: the strong tier, and what it refuses ------------------------ #


def test_the_strong_tier_is_six_terms_and_nothing_looser() -> None:
    """§7.5.2 names four terms the gate must *not* contain, and the survey's audit
    says why: in a fornborg description they mean the rampart, or a lawn."""
    assert R.INTERIOR_STRONG_TERMS == (
        "husgrund", "husterrass", "hustomtning", "grophus", "boplatsvall", "boplatsborg",
    )
    for text in (
        "Ställvis har vallen endast stensträngskaraktär.",          # the rampart itself
        "Fornborgen är nu så gott som helt bebyggd med villatomter.",  # a lawn
        "Den yttre, terrassformade delen är 4-10 m br.",            # a terraced wall section
        "Inom borgen finns en anläggning av okänd art.",            # too generic to carry a claim
    ):
        assert R.scan_interior_terms(text) == [], text


def test_a_husgrund_compound_is_matched_by_its_stem() -> None:
    """Prefix matching, so the register's own inflections all land on one term."""
    for word in ("husgrunder", "husgrunden", "husgrundsterrass", "husgrundsliknande"):
        hits = R.scan_interior_terms(f"Innanför muren är {word}.")
        assert [hit["term"] for hit in hits] == ["husgrund"]
        assert hits[0]["matched"] == word


def test_a_negated_hit_is_discarded(survey_forts: dict) -> None:
    """KMR writes the negation on either side of the noun, so the scope is the
    sentence and not a character window."""
    assert verdicts("Inga husgrunder är synliga inom borgen.") == ["negated"]
    assert verdicts("Husgrunder saknas inom borgområdet.") == ["negated"]
    assert verdicts("Inom vallen finns inte några husgrunder.") == ["negated"]


def test_an_exterior_hit_is_discarded(survey_forts: dict) -> None:
    """The feature is outside the enclosure and belongs to the landscape."""
    text = survey_forts["l2017-4807"]["description"]
    assert "50 m Ö om fornborgen finns husgrunder" in text
    assert verdicts(text) == ["exterior"]
    assert verdicts("Nedanför borgen finns en husgrund.") == ["exterior"]
    assert verdicts("Intill fornborgen är en husgrundsterrass.") == ["exterior"]


def test_an_interior_cue_outranks_an_exterior_cue(survey_forts: dict) -> None:
    """§7.5.2: *"terrassering i borgens inre, söder om vallen"* survives. The real
    case is L2005:1450, whose sentence carries both cues in eight words."""
    text = survey_forts["l2005-1450"]["description"]
    hits = [hit for hit in R.scan_interior_terms(R.normalise(text)) if hit["verdict"] == "counted"]
    assert len(hits) == 1
    assert "I fornborgens SÖ del intill och NV om muren" in hits[0]["sentence"]
    assert hits[0]["interiorCue"] is not None and hits[0]["exteriorCue"] is not None


def test_a_modern_building_is_discarded(survey_forts: dict) -> None:
    """The discard that matters most: KMR describes a croft foundation and an Iron
    Age one in identical vocabulary."""
    assert verdicts(survey_forts["l2013-5619"]["description"]) == ["modern"]    # "historisk tid"
    assert verdicts("I borgens V del är en sentida husgrund.") == ["modern"]
    assert verdicts("Inom borgen är en husgrund efter ett torp.") == ["modern"]
    # …and `torp` keeps its word boundary, or Ismantorp loses its 88 foundations.
    assert verdicts("Ismantorps fornborg. Innanför muren är 88 husgrunder.") == ["counted"]


def test_an_antiquarian_year_is_not_a_modern_building(survey_forts: dict) -> None:
    """§7.5.2 lists "any 19xx date" as a modern cue. Taken bare it discards
    Eketorp — 75 excavated house foundations — because the sentence dates the
    *excavation*. All four dated strong-tier sentences in the corpus are like
    that, so a year only counts where the sentence is not reporting fieldwork."""
    eketorp = survey_forts["l1958-4198"]["description"]
    assert "1960- och 1970-talens utgrävningar" in eketorp
    assert "counted" in verdicts(eketorp)
    assert verdicts("Enligt 1940 års inv skall i V finnas en husgrund.") == ["counted"]
    assert verdicts("Inom borgen är en husgrund uppförd 1904.") == ["modern"]


def test_a_nonbuilding_terrace_is_discarded() -> None:
    """A cultivation terrace or a natural rock shelf is not a house."""
    assert verdicts("Inom borgen är en odlingsterrass med husgrundsliknande form.") == [
        "nonbuildingTerrass"
    ]


def test_a_hedged_hit_counts_and_the_flag_travels(survey_forts: dict) -> None:
    """A surveyor's *möjlig husgrund* is still the register saying it saw something
    building-shaped inside the wall — but a hedged fort must not draw a confident
    longhouse, so the flag travels with the fort."""
    for text, hedged in (
        ("Detta kan möjligen vara husgrunder.", True),
        ("I borgens centrum finns en anläggning, som kan vara en liten husgrund.", True),
        ("På moränplatåns S del finns en trolig husterrass, 15x7 m (NV-SÖ).", True),
        ("En yta 8x4 m som är husgrundsliknande.", True),
        ("Innanför muren är 88 husgrunder.", False),
    ):
        hits = R.scan_interior_terms(text)
        assert [hit["hedged"] for hit in hits] == [hedged] * len(hits), text


def test_sentence_scope_survives_the_registers_lost_line_breaks(survey_forts: dict) -> None:
    """1 034 of the 1 304 descriptions lost their hard line breaks without gaining
    a space. A sentence rule that needs whitespace would run every cue on into the
    next sentence — and a decimal-blind one would cut `0.5-1.4 m st` in half."""
    glued = "Muren är 2 m h.Inne i fornborgens N del är 1 husgrundsterrass 19 m l."
    assert len(R.interior_sentences(glued)) == 2
    assert R.interior_sentences("Vallen är 0.5-1.4 m h och 2 m br.") == [
        "Vallen är 0.5-1.4 m h och 2 m br."
    ]
    # …and the negation in a later clause must not reach back to the house.
    text = survey_forts["l1970-5723"]["description"]
    assert "saknar stenvall" in text
    assert verdicts(text) == ["counted"]


# --- channel 2: the spatial test -------------------------------------------- #


def fort_with_square_extent(half: float = 50.0) -> dict:
    ring = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]]
    return fort_record(
        "Fornborg, 100x100 m.",
        geometryLocal={"type": "Polygon", "coordinates": [ring]},
    )


def settlement_record(x: float, z: float, lamningstyp: str = "Boplats", rid: str = "L1:1") -> dict:
    return {
        "id": rid,
        "name": "",
        "lamningstyp": lamningstyp,
        "provenance": "measured",
        "position": {"x": x, "z": z},
    }


def test_a_settlement_record_inside_the_extent_passes_the_gate() -> None:
    fort = fort_with_square_extent()
    inside = settlement_record(10.0, -10.0, "Husgrund, förhistorisk/medeltida")
    block = R.build_interior(fort, [fort, inside])
    assert block["evidence"]["gate"] == "pass"
    assert block["evidence"]["channels"] == ["settlement-record"]
    citation = block["evidence"]["citations"][0]
    assert citation["id"] == "L1:1" and citation["test"] == "polygon"
    # The record attests settlement; it states nothing about the buildings.
    assert block["buildings"] is None


def test_a_settlement_record_outside_the_extent_does_not() -> None:
    fort = fort_with_square_extent()
    outside = settlement_record(120.0, 0.0)
    block = R.build_interior(fort, [fort, outside])
    assert block["evidence"]["gate"] == "fail"
    assert block["evidence"]["citations"] == []


def test_channel_two_is_a_spatial_test_not_an_archetype_map() -> None:
    """`Terrassering` is a channel-2 settlement type **and** archetype J. The two
    lists are different questions: membership here is evidence that somebody lived
    inside the wall, not a licence to draw cultivation terraces as houses."""
    assert "Terrassering" in R.INTERIOR_SETTLEMENT_TYPES
    assert R.ARCHETYPES["Terrassering"] == "cultivated-ground"
    fort = fort_with_square_extent()
    terrace = settlement_record(5.0, 5.0, "Terrassering", "L1:2")
    block = R.build_interior(fort, [fort, terrace])
    assert block["evidence"]["gate"] == "pass"
    assert R.build_monument(terrace)["archetype"] == "cultivated-ground"


def test_a_fort_with_no_polygon_falls_back_to_its_bounding_box_and_says_so() -> None:
    """43 forts nationally. The bbox is the weaker test — a bounding box over a
    promontory fort reaches well outside the wall — so it is shown, not hidden."""
    fort = fort_record(
        "Fornborg.",
        geometryLocal={"type": "LineString", "coordinates": [[-50.0, -50.0], [50.0, 50.0]]},
    )
    inside = settlement_record(-40.0, 45.0)
    block = R.build_interior(fort, [fort, inside])
    assert block["evidence"]["citations"][0]["test"] == "bbox"


def test_a_fort_known_only_as_a_point_runs_no_spatial_test() -> None:
    """Inventing a radius for it would be the app's guessing done in the pipeline."""
    fort = fort_record("Fornborg.", geometryLocal={"type": "Point", "coordinates": [0.0, 0.0]})
    assert R.settlement_records_inside(fort, [fort, settlement_record(1.0, 1.0)]) == []


def test_the_two_channels_are_a_union_never_a_cross_check() -> None:
    """Ismantorp's 88 house foundations return *zero* settlement records, because
    KMR files them inside the fort's own record. A gate that required both would
    refuse the best-evidenced interior in the country."""
    fort = fort_record("Innanför muren är 88 husgrunder.", geometryLocal=None)
    block = R.build_interior(fort, [fort])
    assert block["evidence"]["channels"] == ["description"]
    assert block["settlementOffered"] is True


# --- what the record states about the buildings ----------------------------- #


def test_ismantorps_count_grouping_and_layout_come_from_the_record(survey_forts: dict) -> None:
    """§7.5.1's worked sentence: a count, a grouping and a layout in one sentence,
    with the house size two sentences later. All of it beats the archetype default."""
    fort = fort_record(survey_forts["l1957-426"]["description"], "L1957:426")
    block = R.build_interior(fort, [fort], county="Kalmar", kommun="Borgholm")
    buildings = block["buildings"]
    assert buildings["count"] == 88 and buildings["countStated"] is True
    assert buildings["countSource"] == "measured"
    assert buildings["groups"] == 2 and buildings["layout"] == "radial"
    assert buildings["template"]["lengthM"] == [12.0, 14.0]
    assert buildings["template"]["widthM"] == [4.0, 6.0]
    assert buildings["template"]["tiers"]["plan"] == "measured"
    assert buildings["fallbacks"] == []
    assert block["tradition"] == "limestone-ringfort"


def test_ismantorps_street_plan_is_the_records_own(survey_forts: dict) -> None:
    """§7.5.2's radial **block** layout, and the two numbers it stands on.

    *"…en inre, mer oregelbunden grupp, genom fyra gator uppdelade i lika många
    kvarter"* is a block count; *"De båda husgrupperna skiljs av en 2-5 m br
    ringgata"* is the street between the groups, one sentence later. Both are the
    register's; neither is an archetype default, and without them the app would
    have to invent the streets of the best-recorded fort interior in the country.
    """
    fort = fort_record(survey_forts["l1957-426"]["description"], "L1957:426")
    buildings = R.build_interior(fort, [fort], county="Kalmar", kommun="Borgholm")["buildings"]
    assert buildings["blocks"] == 4
    assert buildings["streetWidthM"] == [2.0, 5.0]
    # A stated street width means no assumption to name.
    assert "buildings.streetWidthM" not in buildings["fallbacks"]


def test_the_street_plan_is_ismantorps_alone(survey: dict) -> None:
    """The measurement that keeps §7.5.2's branch off the mainland default.

    Replayed over all 1 304 national descriptions, each pattern matches exactly
    one fort. A later edit that widens either of them has to move this number.
    """
    with_blocks = []
    with_street = []
    for fort in survey["forts"]:
        text = fort["description"] or ""
        if not text:
            continue
        streets = R.parse_interior_streets(R.normalise(text))
        if streets["blocks"] is not None:
            with_blocks.append(fort["slug"])
        if streets["streetWidthM"] is not None:
            with_street.append(fort["slug"])
    assert with_blocks == ["l1957-426"]
    assert with_street == ["l1957-426"]


def test_a_grouped_layout_with_no_stated_street_names_the_assumption() -> None:
    """A layout in more than one group has to put something between the rings, so
    where the record does not measure that gap the assumption is named (§15.3)."""
    fort = fort_record("Innanför muren är 20 husgrunder, fördelade på två grupper.")
    buildings = R.build_interior(fort, [fort], county="Kalmar", kommun="Borgholm")["buildings"]
    assert buildings["groups"] == 2
    assert buildings["streetWidthM"] is None and buildings["blocks"] is None
    assert "buildings.streetWidthM" in buildings["fallbacks"]


def test_eketorps_radial_houses_come_from_its_tradition_and_say_so(survey_forts: dict) -> None:
    """Eketorp's own record counts its houses and nothing else the sampler needs.

    ~75 house foundations is the register's number and it is read as one; the
    house *size* its description states two sentences later — "De förra är ca
    11x4-5 m" — is not reachable from the sentence that names them, because KMR's
    own text for this fort has lost a full stop mid-sentence. So the plan takes
    §6.H's literature default, `fallbacks` names it, and the panel says so rather
    than the app quietly inventing an 11 m house it cannot cite.
    """
    fort = fort_record(survey_forts["l1958-4198"]["description"], "L1958:4198")
    block = R.build_interior(fort, [fort], county="Kalmar", kommun="Mörbylånga")
    buildings = block["buildings"]
    assert block["tradition"] == "limestone-ringfort"
    assert buildings["count"] == 75 and buildings["countSource"] == "measured"
    assert buildings["layout"] == "radial"
    assert buildings["blocks"] is None and buildings["streetWidthM"] is None
    assert buildings["template"]["lengthM"] == R.FARMSTEAD_DEFAULTS["lengthM"]
    assert buildings["template"]["tiers"]["plan"] == "assumed"
    assert buildings["fallbacks"] == [
        "buildings.template.lengthM",
        "buildings.template.widthM",
    ]


def test_the_limestone_branch_never_widens_the_gate() -> None:
    """§7.5.2: "no fort is offered `settlement` for being on limestone"."""
    fort = fort_record("Fornborg, ringmur av kalksten. Inga husgrunder är synliga.")
    block = R.build_interior(fort, [fort], county="Kalmar", kommun="Borgholm")
    assert block["tradition"] == "limestone-ringfort"
    assert block["evidence"]["gate"] == "fail"
    assert block["settlementOffered"] is False
    assert block["buildings"] is None


def test_trabyborgs_stated_count_beats_the_archetype_default(survey_forts: dict) -> None:
    fort = fort_record(survey_forts["l1956-3284"]["description"], "L1956:3284")
    block = R.build_interior(fort, [fort], county="Kalmar", kommun="Mörbylånga")
    assert block["buildings"]["count"] == 50
    assert block["buildings"]["template"]["lengthM"] == [12.0, 12.0]
    assert block["buildings"]["template"]["source"] == "measured"


def test_a_record_that_states_nothing_about_its_houses_falls_back_and_says_so() -> None:
    """§15.3: where the record is silent the §6.H default is used, the path is
    listed in `fallbacks`, and the two must not read as equally certain."""
    fort = fort_record("Innanför muren finns husgrunder.")
    buildings = R.build_interior(fort, [fort])["buildings"]
    assert buildings["count"] is None and buildings["countStated"] is False
    assert buildings["countSource"] == "assumed"
    assert buildings["template"]["lengthM"] == R.FARMSTEAD_DEFAULTS["lengthM"]
    assert buildings["template"]["tiers"]["plan"] == "assumed"
    assert buildings["fallbacks"] == [
        "buildings.template.lengthM", "buildings.template.widthM", "buildings.count",
    ]


def test_a_stated_sector_is_a_compass_word_not_a_coordinate(survey_forts: dict) -> None:
    """§15.3's first rule, and the one easiest to break here."""
    fort = fort_record(survey_forts["l1984-1190"]["description"], "L1984:1190")
    block = R.build_interior(fort, [fort])
    assert block["buildings"]["sector"] == "N"
    assert block["buildings"]["template"]["orientationDeg"] == 135.0
    assert "position" not in json.dumps(block)


# --- what `cleared` draws ---------------------------------------------------- #


def test_cleared_patches_are_drawn_only_where_kmr_places_them(survey_forts: dict) -> None:
    """§7.5.1's worked case, verbatim: two patches, two sizes, one sector, and
    nothing more may be read out of it."""
    text = survey_forts["l1955-741"]["description"]
    patches = R.parse_cleared_patches(R.normalise(text))
    assert [(p["lengthM"], p["widthM"], p["orientationDeg"], p["sector"]) for p in patches] == [
        (8.0, 6.0, 112.5, "S"),
        (6.0, 4.0, 90.0, "S"),
    ]
    assert all("röjda ytor" in p["sentence"] for p in patches)


def test_a_cleared_mention_with_no_stated_size_draws_no_patch() -> None:
    """`[]` is the normal case: the register mentions cleared ground far more often
    than it measures it."""
    text = "Borgens centrala del utgörs av röjda ytor omgivna av grovblockig morän."
    assert R.parse_cleared_patches(text) == []


def test_the_terrain_vocabulary_is_quoted_as_the_surveyor_wrote_it() -> None:
    """§6.2: for about a third of the corpus, `cleared` is not the absence of a
    statement — it *is* the statement."""
    words = R.parse_terrain_words(
        "Borgens inre utgörs av grovblockig morän samt berg i dagen och småkuperad hällmark."
    )
    assert words == ["grovblockig", "berg i dagen", "småkuperad", "hällmark"]


# --- the block, on a real bundle -------------------------------------------- #


def test_broborg_fails_channels_one_and_two_and_passes_on_the_citation(document: dict) -> None:
    """§7.5.3: **Broborg itself fails this gate** — `classification: "neither"` in
    the survey — while having the best-dated interior occupation in the corpus.
    That is why channel 3 exists, and the block has to show which channel fired."""
    interior = document["interior"]
    evidence = interior["evidence"]
    assert evidence["gate"] == "pass"
    assert evidence["channels"] == ["cited"]
    assert evidence["terms"] == []
    assert [c["channel"] for c in evidence["citations"]] == ["cited"]
    assert "AD 432–542" in evidence["citations"][0]["statement"]
    assert evidence["citations"][0]["reference"] == "Englund 2018; Sjöblom et al. 2022"
    # The occupation is dated; the interior *stone* is contested, so the fort still
    # opens on the conservative geometry and the buildings stay unspecified.
    assert interior["state"] == "cleared"
    assert interior["buildings"] is None


def test_the_committed_bundle_states_its_interior(document: dict) -> None:
    interior = document["interior"]
    assert interior["tradition"] == "mainland"
    assert interior["ground"]["terrainWords"] == ["grovblockig", "berg i dagen"]
    assert interior["ground"]["soilClass"] == "sgu"
    assert interior["ground"]["clearedPatches"] == []
    assert document["coverage"]["interiorGate"] == "pass"
    assert document["coverage"]["interiorBuildingsStated"] is False


def test_a_fort_with_no_evidence_says_so_positively() -> None:
    """§15.3: a failing block is a *statement*. It lets the panel say "the register
    records no buildings inside this fort, and two mentions of houses it places
    outside it" instead of saying nothing — and it lets the app tell "no evidence"
    from "a bundle built before this rule existed"."""
    fort = fort_record(
        "Fornborg, 60x40 m. Inga husgrunder är synliga. Nedanför borgen finns en husgrund."
    )
    block = R.build_interior(fort, [fort])
    assert block["settlementOffered"] is False
    assert block["evidence"]["gate"] == "fail"
    assert block["evidence"]["channels"] == []
    assert block["evidence"]["citations"] == []
    assert block["evidence"]["discarded"] == {
        "negated": 1, "exterior": 1, "nonbuildingTerrass": 0, "modern": 0,
    }
    assert block["buildings"] is None
    # The ground block is still there: `cleared` is what this fort draws.
    assert block["ground"]["source"] == "derived"


def test_a_site_with_no_fort_carries_no_interior_block(broborg_sites: dict) -> None:
    sites = {
        "schemaVersion": 1,
        "sites": [s for s in broborg_sites["sites"] if s["lamningstyp"] != "Fornborg"],
    }
    document = R.build_document(sites, "broborg", generated="2026-01-01")
    assert "interior" not in document
    assert document["coverage"]["interiorGate"] is None


# --- the national replay, pinned --------------------------------------------- #


def gate_sets(survey: dict) -> tuple[set, set, set]:
    """Replay channel 1 over every survey description; channel 2 comes from the
    survey's own spatial run, which read the national 2.3 GB extract."""
    language: set = set()
    hedged_only: set = set()
    for fort in survey["forts"]:
        hits = [
            hit for hit in R.scan_interior_terms(R.normalise(fort.get("description") or ""))
            if hit["verdict"] == "counted"
        ]
        if hits:
            language.add(fort["slug"])
            if all(hit["hedged"] for hit in hits):
                hedged_only.add(fort["slug"])
    settlement = {fort["slug"] for fort in survey["forts"] if fort["settlementInside"]}
    return language, settlement, hedged_only


#: The three forts where this parser and the survey's own run disagree, each with
#: the sentence that decides it. They are *named* rather than tolerated, because a
#: silent difference between the rule and the measurement it was calibrated on is
#: exactly how a gate drifts open.
SURVEY_DIVERGENCES = {
    # The survey counts these two; §7.5.2's `N/S/Ö/V om` exterior cue — which the
    # survey's own cue list does not carry — discards them, and the register's own
    # words are unambiguous: "50 m Ö om fornborgen finns husgrunder" and "Inom ett
    # streckmarkerat område S om fornborgen … möjligen husgrundsterrasser". Drawing
    # houses inside those two forts would contradict the sentence the panel shows.
    "dropped": {"l2017-4807", "l2010-1595"},
    # …and this one the survey discards on `intill` while the same sentence opens
    # "I fornborgens SÖ del", which §7.5.2 says outranks the exterior cue.
    "added": {"l2005-1450"},
}


def test_the_rule_reproduces_the_national_survey(survey: dict) -> None:
    language, settlement, _hedged = gate_sets(survey)
    survey_language = {f["slug"] for f in survey["forts"] if f["interiorLanguageStrongClean"]}
    survey_refined = {f["slug"] for f in survey["forts"] if f["refinedInteriorEvidence"]}

    assert language - survey_language == SURVEY_DIVERGENCES["added"]
    assert survey_language - language == SURVEY_DIVERGENCES["dropped"]

    refined = language | settlement
    assert refined - survey_refined == SURVEY_DIVERGENCES["added"]
    assert survey_refined - refined == SURVEY_DIVERGENCES["dropped"]


def test_the_national_gate_rates_are_pinned(survey: dict) -> None:
    """§7.5's headline: 4.1 % of forts carry defensible interior-building evidence,
    and 88 % show neither building language nor a settlement record. A parser edit
    that moves these numbers is a change to what the app asserts about the country,
    and has to be argued for in the document before it is made here."""
    language, settlement, hedged_only = gate_sets(survey)
    assert len(survey["forts"]) == 1304
    assert len(language) == 42          # survey: 43 strong-tier clean forts
    assert len(settlement) == 18        # channel 2, from the survey's spatial run
    assert len(language & settlement) == 7
    assert len(language | settlement) == 53          # survey: 54
    assert round(len(language | settlement) / 1304, 3) == 0.041
    # 16 of the survey's 43 are hedged in every hit they carry; three of the four
    # differences are sentences the survey read with a wider scope than this
    # parser's, which splits the glued sentence they sit in.
    assert len(hedged_only) == 13


def test_a_glued_strong_term_is_a_known_gap_and_costs_no_fort(survey: dict) -> None:
    """The register's lost line breaks defeat every word-boundary rule in this
    module, so the gap is measured rather than assumed. For the strong tier it is
    two occurrences in the whole country: `sentida stenhusgrund` (a compound, and
    discarded as modern anyway) and `enhusgrundsterrass` (genuinely glued, in a
    fort that already passes on another sentence). **Repairing the descriptions is
    not this rule's business** — a §2 that quietly widened the gate would be the
    silent assertion the project forbids — but the size of the hole is."""
    stems = "|".join(sorted((R.fold(t) for t in R.INTERIOR_STRONG_TERMS), key=len, reverse=True))
    glued = re.compile(rf"(?<=[a-z])(?:{stems})[a-z0-9]*")
    affected: set = set()
    would_change: set = set()
    for fort in survey["forts"]:
        text = R.normalise(fort.get("description") or "")
        if not glued.search(R.fold(text)):
            continue
        affected.add(fort["slug"])
        if not any(hit["verdict"] == "counted" for hit in R.scan_interior_terms(text)):
            would_change.add(fort["slug"])
    assert affected == {"l1975-712", "l1983-1710"}
    assert would_change == {"l1975-712"}
    # …and even repaired, that one stays out: its own sentence calls it *sentida*.
    repaired = [f for f in survey["forts"] if f["slug"] == "l1975-712"][0]["description"]
    assert "sentida stenhusgrund" in repaired
    assert verdicts(repaired.replace("stenhusgrund", "sten husgrund")) == ["modern"]


# --- validation (§15.3) ------------------------------------------------------ #


def interior_document(document: dict, **changes) -> dict:
    """The committed document with a patched interior block."""
    patched = json.loads(json.dumps(document))
    patched["interior"].update(changes)
    return patched


def test_no_citation_no_state(document: dict) -> None:
    """§15.3's hardest constraint, and §7.5.3's honesty requirement expressed as a
    schema rule rather than as a hope about the UI."""
    broken = interior_document(document)
    broken["interior"]["evidence"]["citations"] = []
    with pytest.raises(R.ReconstructError, match="must be able to show"):
        R.validate_document(broken)


def test_the_gate_and_the_offer_must_agree(document: dict) -> None:
    broken = interior_document(document, settlementOffered=False)
    with pytest.raises(R.ReconstructError, match="must agree"):
        R.validate_document(broken)


def test_the_state_is_cleared_in_v1_8(document: dict) -> None:
    """Passing the gate makes the state offerable, not on."""
    with pytest.raises(R.ReconstructError, match="offerable, not on"):
        R.validate_document(interior_document(document, state="settlement"))
    with pytest.raises(R.ReconstructError, match="cleared|settlement"):
        R.validate_document(interior_document(document, state="excavated"))


def test_an_unknown_tradition_is_rejected(document: dict) -> None:
    with pytest.raises(R.ReconstructError, match="tradition"):
        R.validate_document(interior_document(document, tradition="limestone"))


def test_a_citation_must_carry_the_field_its_channel_requires(document: dict) -> None:
    broken = interior_document(document)
    broken["interior"]["evidence"]["citations"][0].pop("reference")
    with pytest.raises(R.ReconstructError, match="missing 'reference'"):
        R.validate_document(broken)

    broken = interior_document(document)
    broken["interior"]["evidence"]["channels"] = ["description"]
    broken["interior"]["evidence"]["citations"] = [
        {"channel": "description", "lamningsnummer": "L1:1", "term": "husgrund",
         "matched": "husgrunder", "sentence": ""}
    ]
    with pytest.raises(R.ReconstructError, match="missing 'sentence'"):
        R.validate_document(broken)


def test_a_settlement_record_citation_declares_which_test_placed_it(document: dict) -> None:
    broken = interior_document(document)
    broken["interior"]["evidence"]["channels"] = ["settlement-record"]
    broken["interior"]["evidence"]["citations"] = [
        {"channel": "settlement-record", "id": "L1:1", "lamningstyp": "Boplats", "test": "near"}
    ]
    with pytest.raises(R.ReconstructError, match="polygon"):
        R.validate_document(broken)


def test_buildings_on_a_failed_gate_are_rejected(document: dict) -> None:
    """§7.5.3: no buildings in a fort that fails the gate, at any opacity, under
    any label."""
    broken = interior_document(document, settlementOffered=False)
    broken["interior"]["evidence"]["gate"] = "fail"
    broken["interior"]["evidence"]["channels"] = []
    broken["interior"]["evidence"]["citations"] = []
    broken["interior"]["buildings"] = {
        "count": 3, "countSource": "assumed", "countStated": False, "layout": "free",
        "groups": None, "sector": None, "template": None, "fallbacks": [], "source": "assumed",
    }
    with pytest.raises(R.ReconstructError, match="failed the gate"):
        R.validate_document(broken)


def test_a_hip_shallower_than_the_long_sides_is_rejected() -> None:
    """§6.H's Eketorp-II error, written as an assertion."""
    template = {
        "lengthM": [20.0, 40.0], "widthM": [6.0, 8.0], "aisleWidthM": [1.3, 2.8],
        "trestleSpacingM": [2.0, 3.0], "roofPitchDeg": 45.0, "hipPitchDeg": 40.0,
        "wallHeightM": 1.2, "aisleFraction": 0.4,
        "tiers": {"plan": "assumed", "profile": "derived", "surface": "assumed"},
    }
    with pytest.raises(R.ReconstructError, match="Eketorp-II"):
        R.validate_building_template(template)
    template["hipPitchDeg"] = 48.0
    template["wallHeightM"] = 0.6
    with pytest.raises(R.ReconstructError, match="load-bearing"):
        R.validate_building_template(template)
    template["wallHeightM"] = 1.2
    template["lengthM"] = [40.0, 20.0]
    with pytest.raises(R.ReconstructError, match="min ≤ max"):
        R.validate_building_template(template)


def test_a_cleared_patch_must_quote_the_sentence_that_places_it(document: dict) -> None:
    broken = interior_document(document)
    broken["interior"]["ground"]["clearedPatches"] = [
        {"lengthM": 8.0, "widthM": 6.0, "orientationDeg": None, "sector": "S",
         "source": "measured", "sentence": ""}
    ]
    with pytest.raises(R.ReconstructError, match="quote the sentence"):
        R.validate_document(broken)


def test_the_interior_carries_no_coordinates(document: dict) -> None:
    """§15.3: a patch and a building are a size, an orientation and a compass
    sector. A second file carrying a second copy of a position is a second thing
    that can drift."""
    broken = interior_document(document)
    broken["interior"]["ground"]["clearedPatches"] = [
        {"lengthM": 8.0, "widthM": 6.0, "sector": "S", "source": "measured",
         "sentence": "…röjda ytor…", "x": 12.0, "z": -4.0}
    ]
    with pytest.raises(R.ReconstructError, match="never a position"):
        R.validate_document(broken)


def test_an_interior_block_without_a_fort_is_rejected(document: dict) -> None:
    broken = json.loads(json.dumps(document))
    broken["monuments"] = [m for m in broken["monuments"] if m["archetype"] != "fort"]
    with pytest.raises(R.ReconstructError, match="no monument is a fort"):
        R.validate_document(broken)


def test_a_fort_site_may_not_go_silent_about_its_interior(document: dict) -> None:
    """§15.3, from the other side: omitting the block is what a pre-v1.8 bundle
    looks like, and a fort built today must not be mistaken for one."""
    broken = json.loads(json.dumps(document))
    broken.pop("interior")
    with pytest.raises(R.ReconstructError, match="does not go silent"):
        R.validate_document(broken)


def test_the_interior_belongs_to_the_sites_own_fort(broborg_sites: dict) -> None:
    """A 2 × 2 km bundle can hold a second registered fornborg. Attributing that
    one's husgrunder to this site would be the quietest way to draw a building
    nobody recorded here, so the site's own `lamningsnummer` picks the record."""
    sites = json.loads(json.dumps(broborg_sites))
    neighbour = json.loads(json.dumps(next(
        s for s in sites["sites"] if s["lamningstyp"] == "Fornborg"
    )))
    neighbour["id"] = "L9999:1"
    neighbour["description"] = "Fornborg. Innanför muren är 12 husgrunder."
    sites["sites"].insert(0, neighbour)

    theirs = R.build_document(sites, "broborg", generated="2026-01-01")
    assert theirs["interior"]["buildings"]["count"] == 12      # first record wins by default

    ours = R.build_document(
        sites, "broborg", generated="2026-01-01", fort_id="L1943:7827"
    )
    assert ours["interior"]["evidence"]["channels"] == ["cited"]
    assert ours["interior"]["buildings"] is None
