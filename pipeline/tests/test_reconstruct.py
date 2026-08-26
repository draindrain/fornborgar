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

No network, no credentials, no rasters: the whole module under test is a pure
function of strings and dicts.
"""

from __future__ import annotations

import json
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
    assert set(defaults) == set(R.ARCHETYPE_DEFAULTS)
    assert defaults["mound"]["diameterM"] == 7.0
    assert defaults["cairn"]["stoneM"] == [0.4, 0.6]
    assert defaults["stone-setting"]["reprofile"] is False


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
