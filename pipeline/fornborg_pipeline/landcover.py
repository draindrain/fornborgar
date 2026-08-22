"""Rule-based land-cover model for one reference century (contract §9/§10, PLAN.md §4.7).

    python3 -m fornborg_pipeline.landcover --site broborg

Two outputs, both defined in docs/data-formats.md v1.2:

  * `landcover.tif`          — §9, uint8 class indices on the **context** geometry
  * `landcover_legend.json`  — §10, the classes, palette, rules and area fractions

plus a patch of the site's `manifest.json` + `DATA-LICENSES.md`. Like the water
step, this reads the **committed** grids rather than the raw Lantmäteriet mosaic,
so anyone with the repository can rebuild it with no Geotorget credentials.

What the engine actually knows, per 2 m cell of the 4x4 km context extent:

  1. **soil** — SGU *Jordarter* polygons (`fetch_soils.py`), rasterized onto the
     grid: the `grundlager` class per cell, plus a boolean peat veneer from
     `ytlager`. Cells no polygon covers take their nearest neighbour's class;
     the veneer's *till* polygons are deliberately ignored (a <0.5 m till skin on
     bedrock does not change what grows there, a peat one does);
  2. **slope** — from the dequantized context DEM, `np.gradient` in degrees;
  3. **sea connectivity** — `water_connect.tif` (§7), the level at which the cell
     first connects to the open sea, compared against the modelled shoreline level
     for the reference century read out of `shoreline.json` (§6). Since the v1.3
     amendment the rules use it for one thing only: keeping seabed that drained
     within `fresh_land_m` of the reference level out of the plough. The *sea
     itself* and the reed belt at its edge are no longer raster classes — they are
     exact functions of this grid and the level the app is showing, so the app
     derives them per century (§9's v1.3 carve-out) instead of reading a frozen
     copy of the reference century's shoreline. Since Phase 9d the pair is
     optional *as a pair*: an inland site ships neither half (scale-out §4.3),
     the one sea test is then vacuous, and the legend says so;
  4. **settlement proximity** — Euclidean distance to the nearest registered
     grave/settlement record in `sites.json` (§3), the cultivation proxy and the
     grazing radius;
  5. **monument footprints** — Euclidean distance to the registered footprint
     of the era's occupied remains (the fornborg extent plus the grave and
     settlement records above): ground that *was* the settlement is kept clear
     of trees rather than reforested by the soil rules;
  6. **cultivation evidence** — distance to the registered footprint of a mapped
     field remain (fossil åker, röjningsrösen, terrasseringar): cultivated ground
     on the record's own evidence, not on a proximity guess;
  7. **road corridors** — distance to the registered line of a färdväg or
     färdvägssystem: a road through a wood is a cleared corridor.

The rules run in a fixed precedence — mapped water, then peat fen, then the
occupied footprints, then roads, then farmland (mapped evidence before the
proximity heuristic), then the remaining open ground, then wooded pasture and
forest — and each class's `rule` string in the legend is a verbatim statement of
the branch that produced it, because the app renders those strings in the methods
panel and must never paraphrase a method it did not run.

**This is a model.** SGU maps the *present-day* soil surface; the vegetation is
inferred from soil, slope and distance to burial grounds, not observed. The
legend's `caveat` says so and the app surfaces it the first time the layer is
switched on.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Iterable, Sequence

import click
import numpy as np
import rasterio
from affine import Affine
from rasterio import features
from scipy import ndimage

from .clip_dem import DECIMETER_SCALE, dequantize_decimeters, read_grid, write_class_grid
from .connectivity import WATER_CONNECT_DELTA_PATH, WATER_CONNECT_PATH, read_connect_grid
from .fetch_dem import FetchError
from .fetch_sites import SITES_PATH
from .fetch_soils import (
    JORD_API,
    JORD_PRODUCT,
    SoilsError,
    class_census,
    fetch_soils,
    is_surface_layer,
    soil_class,
)
from .manifest import (
    add_landcover_asset,
    validate_manifest,
    write_data_licenses,
    write_manifest,
)
from .reveals import CITATION as REVEALS_CITATION
from .reveals import RevealsAnchor, openness_anchor
from .shoreline import SHORELINE_PATH, interpolate_level
from .sites import SITES, SiteConfig, get_site
from .zones import ZoneAssignment, assign_zone

LANDCOVER_PATH = "landcover.tif"
LANDCOVER_LEGEND_PATH = "landcover_legend.json"
SCHEMA_VERSION = 1

#: The century the raster models — Broborg's active era (PLAN.md §2.2: in use
#: ~400–550 CE). One raster, one century; the app never re-derives it (§9).
REFERENCE_YEAR_CE = 500

#: Contract §10 allows 32 classes; this taxonomy deliberately stays around ten so
#: the legend fits on screen and every class earns a distinguishable ground tint.
MAX_CLASSES = 32
VEGETATION_TYPES = ("conifer", "broadleaf", "reeds")
#: Contract §10 v1.3: the two class kinds the app re-derives at the current slider
#: level from the §7 connect grid instead of reading them from the raster (§9).
DYNAMIC_KINDS = ("water", "shore-band")

#: `water_connect.tif` is int16 decimeters, so its dequantized meters land a hair
#: off the decimeter lattice (86 dm -> 8.600000381 m in float32). Without this
#: guard a cell sitting exactly at the modelled level would read as dry.
LEVEL_EPSILON = 0.5 * DECIMETER_SCALE * 1e-2  # 0.5 mm

PROCESSING_STEPS = (
    "SGU jordarter polygons rasterized to the context grid (nearest-fill for gaps)",
    "rule-based land-cover classification (uint8 class indices, contract §9)",
)


class LandcoverError(RuntimeError):
    """An input is missing, or the classification failed a contract invariant."""


# --------------------------------------------------------------------------- #
# soil groups — SGU class text (verbatim, as the live API returns it) -> group
# --------------------------------------------------------------------------- #

GROUP_NONE = 0  # no SGU polygon covers the cell (filled from the nearest one)
GROUP_WATER = 1
GROUP_PEAT = 2
GROUP_FINE = 3  # postglacial fine sediments — the cultivable ground
GROUP_CLAY = 4  # glacial clay and modern fill — heavy, wet, uncultivated here
GROUP_GRAVEL = 5  # glaciofluvial / beach gravels — dry, well drained
GROUP_TILL = 6
GROUP_BEDROCK = 7  # crystalline bedrock (Urberg) — the rocky conifer ground
GROUP_OTHER = 8  # mapped by SGU, but a class this table does not name
#: Sedimentary bedrock is its own group, not folded into GROUP_BEDROCK, because
#: it produces a different landscape: on Öland and Gotland "Sedimentärt berg" is
#: the limestone pavement of the alvar — centimetres of soil, no closed forest —
#: measured at 28–84 % of the island pilot extents (docs/vegetation-zones.md §5).
GROUP_SEDIMENTARY = 9

#: `jg2_tx` / `jy1_tx` strings exactly as the API spells them — note the double
#: hyphen in "Svämsediment, ler--silt", which is the product's own spelling and
#: not a typo to be tidied away here. Classes absent from this table fall to
#: `GROUP_OTHER` and are listed in the run log rather than silently absorbed.
#:
#: The table was written against the Broborg extract and extended 2026-08-22
#: with the classes the four island pilot extents actually return
#: (docs/vegetation-zones.md §5.1–§5.2) — before that extension, 89–95 % of
#: those extents fell through to `GROUP_OTHER` and would have rendered as dense
#: conifer forest on the alvar. The run-log tripwire stays: whatever class the
#: next county surprises us with is logged, never silently absorbed.
SOIL_GROUPS: dict[str, int] = {
    "Vatten": GROUP_WATER,
    "Kärrtorv": GROUP_PEAT,
    "Mosstorv": GROUP_PEAT,
    # The product uses both spellings; measured at the Tarsta berg extent.
    "Mossetorv": GROUP_PEAT,
    "Torv": GROUP_PEAT,
    "Gyttja": GROUP_PEAT,
    # Calcareous lake marl / gyttja — a wet basin deposit; classes with it read
    # as fen ground like the other gyttja variants.
    "Bleke och kalkgyttja": GROUP_PEAT,
    "Postglacial lera": GROUP_FINE,
    "Gyttjelera (eller lergyttja)": GROUP_FINE,
    "Svämsediment, ler--silt": GROUP_FINE,
    "Svämsediment, grovsilt--finsand": GROUP_FINE,
    "Svämsediment, sand": GROUP_FINE,
    "Postglacial sand": GROUP_FINE,
    "Postglacial silt": GROUP_FINE,
    "Postglacial finsand": GROUP_FINE,
    # Aeolian dune sand — the sandy-sediment family, measured at the Torsburgen
    # and Tarsta berg extents (2026-08-22 smoke run).
    "Flygsand": GROUP_FINE,
    "Glacial lera": GROUP_CLAY,
    "Glacial silt": GROUP_CLAY,
    "Fyllning": GROUP_CLAY,
    "Isälvssediment": GROUP_GRAVEL,
    "Klapper": GROUP_GRAVEL,
    # Wave-washed beach gravel (svallsediment): the same well-drained shoreline
    # deposit family as Klapper, spelled as the island extracts return it.
    "Svallsediment, grus": GROUP_GRAVEL,
    "Sandig morän": GROUP_TILL,
    "Morän": GROUP_TILL,
    "Grusig morän": GROUP_TILL,
    "Moränlera eller lermorän": GROUP_TILL,
    # The clayey-till spellings the island extracts return; same ground as the
    # "Moränlera eller lermorän" already above — Öland's cultivable till plains.
    "Lerig morän": GROUP_TILL,
    "Moränlera": GROUP_TILL,
    "Moränlera eller lerig morän": GROUP_TILL,
    "Morängrovlera": GROUP_TILL,
    "Urberg": GROUP_BEDROCK,
    "Berg": GROUP_BEDROCK,
    # Boulder fields read as rocky ground, not as a plantable or plowable class.
    "Sten--block": GROUP_BEDROCK,
    # Limestone pavement — the alvar driver; deliberately NOT GROUP_BEDROCK,
    # see the group comment above.
    "Sedimentärt berg": GROUP_SEDIMENTARY,
}

#: The one soil class the *surface* layer contributes: peat over mineral ground.
SURFACE_PEAT_CLASS = "Torv"

#: PLAN.md §2.2 / §4.7: registered graves and settlements are the cultivation
#: proxy and the grazing radius. `lamningstyp` verbatim, a subset of
#: `fetch_sites.SELECTED_TYPES`. A national survey of 195 fornborgar across four
#: kommuner found single-grave types (Stensättning 98 %, Röse 78 %, Hög 59 %) in
#: nearly every fort's extent, so the original five area types alone left most
#: sites with no evidence in frame at all.
SETTLEMENT_TYPES = frozenset(
    {
        "Gravfält",
        "Grav- och boplatsområde",
        "Boplats",
        "Boplatsområde",
        "Boplatslämning övrig",
        "Hög",
        "Stensättning",
        "Röse",
        "Gravgrupp",
        "Flatmarksgrav",
        "Grav markerad av sten/block",
        "Stenkammargrav",
        "Skärvstenshög",
        "Husgrund, förhistorisk/medeltida",
        "Boplatsvall",
    }
)

#: The remains whose *footprint* was occupied, built-on or tended ground in the
#: reference era and is therefore modelled as kept clear of trees: the fort
#: itself on top of the settlement proxies above. Runristningar are deliberately
#: absent (a runestone does not clear a wood) and färdvägar have their own role
#: below (a road clears a corridor, not a settlement); Hägnad/Hägnadssystem stay
#: overlay-only, since an enclosure bank is evidence of how land was organized
#: rather than of ground being occupied or tilled.
MONUMENT_TYPES = SETTLEMENT_TYPES | {"Fornborg"}

#: Mapped field remains: ground the record itself attests was cultivated. Their
#: footprints classify as farmland directly, ahead of the proximity heuristic —
#: a mapped field system beats guessing from distance to a grave. The types span
#: Bronze Age to medieval rather than strictly the reference century, which the
#: app's dating note discloses.
CULTIVATION_TYPES = frozenset(
    {
        "Fossil åker",
        "Område med fossil åkermark",
        "Röjningsröse",
        "Röjningsröseområde",
        "Terrassering",
    }
)

#: Registered roads and hollow-way systems, mostly LineString records: a route in
#: use is an open corridor through whatever the soil rules would otherwise grow.
ROAD_TYPES = frozenset({"Färdväg", "Färdvägssystem"})

#: The grave/settlement evidence enumerated for the rule strings. The families are
#: named because a flat 15-item list is unreadable, and "Husgrund, förhistorisk/
#: medeltida" is quoted because the type name contains a comma.
PROXY_TYPE_TEXT = (
    "grave forms (Hög, Stensättning, Röse, Gravgrupp, Flatmarksgrav, Grav markerad av "
    "sten/block, Stenkammargrav), grave fields and mixed grave/settlement areas "
    "(Gravfält, Grav- och boplatsområde), settlement remains (Boplats, Boplatsområde, "
    "Boplatslämning övrig, Boplatsvall, 'Husgrund, förhistorisk/medeltida') and "
    "fire-cracked-stone heaps (Skärvstenshög)"
)


# --------------------------------------------------------------------------- #
# parameters and the class taxonomy (contract §10)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class LandcoverParams:
    """Every threshold the rules use. Distances in meters, slopes in degrees.

    These are the knobs PLAN.md §4.7 calls "v0, to be tuned". They are quoted
    verbatim into the legend's rule strings, so tuning them re-states the rules
    rather than leaving the disclosed text drifting from the code.
    """

    #: Width of the reed belt above the water line. Since v1.3 no rule here reads
    #: it: the belt is a `dynamic` legend class (§10) the app derives at whatever
    #: level the slider shows, and this is the `bandM` it ships to do that with.
    shore_band_m: float = 0.6
    #: Ground standing less than this above the water line has emerged from the sea
    #: too recently to be arable — at this site's ~5.6-6.2 mm/yr apparent uplift
    #: (PLAN.md §2.5) that is roughly the last 500 years of seabed. Without it the
    #: engine ploughs the whole freshly-drained valley floor.
    fresh_land_m: float = 3.0
    #: How far a till unit counts as a "till margin" of the neighbouring fine
    #: sediment — the cultivable fringe, not the whole moraine.
    till_margin_m: float = 40.0
    #: How far cultivation is assumed to reach from a grave field or settlement.
    farmland_radius_m: float = 700.0
    #: How far everyday grazing keeps the tree cover half-open around the same
    #: evidence. Deliberately tighter than `farmland_radius_m`: the infield's
    #: grazed fringe, while closed forest persists on the outland till — at the
    #: farmland radius the rule swallowed most of the broadleaf forest wherever
    #: grave evidence is dense (measured at Broborg: 19.8 % of the extent).
    pasture_radius_m: float = 300.0
    #: How far beyond a registered monument footprint (fornborg extent, grave
    #: field, settlement remain) the ground is modelled as kept clear of trees.
    monument_clear_m: float = 20.0
    #: How far beyond a mapped field remain (fossil åker, röjningsröse,
    #: terrassering) the ground counts as that field. The KMR extent is a
    #: registration boundary, not a surveyed field edge.
    cultivation_margin_m: float = 20.0
    #: Half-width of the open corridor kept along a registered road line — a
    #: cart track plus its verges, not a modern road reserve.
    road_corridor_m: float = 8.0
    #: Ground steeper than this is not ploughed.
    farmland_max_slope_deg: float = 5.0
    #: Till steeper than this reads as rocky hillside rather than broadleaf wood.
    forest_max_slope_deg: float = 12.0


DEFAULT_PARAMS = LandcoverParams()


@dataclass(frozen=True)
class SiteContext:
    """What the legend text needs to know about *where* this site is (Phase 9d).

    The defaults reproduce the pre-9d behaviour — a wet boreonemoral site with no
    zone disclosure — so every earlier caller and test reads exactly as before.
    `landcover.run` always fills it in from the zone assignment, the REVEALS
    lookup and the presence of the §6/§7 water pair.
    """

    #: The vegetation-zone assignment (docs/vegetation-zones.md §1.2), or None
    #: for callers that predate zones; None writes no zone text and applies no
    #: zone override, which is the boreonemoral spruce-present behaviour.
    zone: ZoneAssignment | None = None
    #: The REVEALS open-land figure for the site's 1° grid cell, or None when
    #: the cell is absent from the product — a measured absence the calibration
    #: text discloses (docs/vegetation-zones.md §3.1).
    anchor: RevealsAnchor | None = None
    #: False for a dry site: no shoreline.json, no connect grid (scale-out
    #: §4.3 — inland forts ship no water pair). The sea-related rule clauses
    #: and the two dynamic classes are then vacuous and the text says so.
    has_shoreline: bool = True
    #: True only for the Broborg pair (the hand-configured reference site and
    #: its registry twin l1943-7827): the Långhundraleden pollen literature is a
    #: genuine local anchor *there* and nowhere else — quoting it nationally
    #: would repeat the §7.2 shoreline-sentence defect.
    local_pollen_anchors: bool = False


#: The registry twin carries the same fort as the hand-configured reference
#: site, so both keep the valley-specific pollen citations in their legends.
LOCAL_POLLEN_ANCHOR_SITES = frozenset({"broborg", "l1943-7827"})


@dataclass(frozen=True)
class LandcoverClass:
    """One legend row (contract §10). `index` is the raw value in the raster."""

    index: int
    id: str
    name: str
    color: str
    rule: str
    vegetation: dict | None
    #: Contract §10 v1.3, optional: `{"kind": "water"}` or
    #: `{"kind": "shore-band", "bandM": m}` for a class the app re-derives at the
    #: current slider level. Absent (the default) means a fully static class, which
    #: is what every soil-, slope- and evidence-derived class here is.
    dynamic: dict | None = None

    def as_json(self, area_fraction: float) -> dict:
        entry = {
            "index": self.index,
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "rule": self.rule,
            "vegetation": dict(self.vegetation) if self.vegetation else None,
        }
        # Emitted only when set: a legend with no `dynamic` key anywhere is exactly
        # a pre-v1.3 legend, which the contract requires to keep rendering as before.
        if self.dynamic:
            entry["dynamic"] = dict(self.dynamic)
        entry["areaFraction"] = round(float(area_fraction), 4)
        return entry


#: Rule text templates. Each one is an honest statement of the corresponding
#: branch in `classify()` — if a branch changes, its template changes with it.
#: Fields: (id, name, color, vegetation, dynamic kind or None, rule).
_RULES = (
    (
        "water",
        "Open water",
        "#2d5a6b",
        None,
        "water",
        "SGU maps the present ground as 'Vatten' — the lakes and watercourses that "
        "hold water whatever the sea is doing. These are the only water cells in the "
        "raster: the Iron Age sea is deliberately not baked into it, because it is an "
        "exact function of the sea-connectivity grid (water_connect.tif, contract §7) "
        "and the water level being shown. The app draws it at the century on the "
        "slider — every cell whose connection level is at or below the current level "
        "(connect ≤ current level), the same data and the same semantics as the §7 "
        "water rendering. At the {year} CE reference level of {level:.1f} m RH 2000 "
        "that sea covers {sea_pct:.1f} % of the extent.",
    ),
    (
        "peat_fen",
        "Peat fen / reed marsh",
        "#6f7f52",
        # One clump per ~20 m². Chosen with the other two so a full-extent sample
        # stays inside the app's global instance budget instead of tripping its
        # proportional down-scaling on the very first site.
        {"type": "reeds", "densityPerHa": 500},
        None,
        "Not water, and either SGU's ground layer maps peat or gyttja (Kärrtorv, "
        "Mosstorv, Torv, Gyttja, Bleke och kalkgyttja) or its surface layer maps a "
        "peat veneer over another "
        "soil. Mapped soil is what defines this class, which is why it is static and "
        "does not move with the slider: a fen stranded inland by the falling sea is "
        "still a fen.",
    ),
    (
        "farmland",
        "Open farmland",
        "#d1b96e",
        None,
        None,
        "Not water, fen, settled ground or road corridor, and then either of two "
        "branches. Mapped evidence first: ground within {cult:.0f} m of the registered "
        "footprint of a field remain (Fossil åker, Område med fossil åkermark, "
        "Röjningsröse, Röjningsröseområde, Terrassering) on a slope under "
        "{farm_slope:.0f}° is farmland directly — the record attests cultivation, so no "
        "proximity heuristic and no soil test is applied to it. Otherwise, proximity: "
        "all four of: SGU maps a postglacial fine sediment "
        "(Postglacial lera, Gyttjelera (eller lergyttja), Svämsediment, ler--silt, "
        "Postglacial sand, silt and finsand) or the margin of a till unit within "
        "{margin:.0f} m of one; "
        "{fresh_clause}the slope is "
        "under {farm_slope:.0f}°; and a registered grave or settlement site — "
        "{proxy_types} — lies within {radius:.0f} m. Away from the mapped field "
        "remains, proximity to burial and settlement evidence is the only cultivation "
        "proxy this model has.",
    ),
    (
        "wet_meadow",
        "Wet meadow / open pasture",
        "#a9c07a",
        None,
        None,
        "The remaining fine-grained ground: postglacial sediments that failed the "
        "farmland test — too close to the water line, too steep, or too far from a "
        "settlement proxy — plus Glacial lera and modern Fyllning (fill). Fyllning "
        "is a present-day anthropogenic deposit with no Iron Age counterpart; it is "
        "folded in here rather than given a class of its own, and that choice is "
        "disclosed rather than hidden.",
    ),
    (
        "dry_corridor",
        "Dry open corridor",
        "#c9b79a",
        None,
        None,
        "Two kinds of open route. Ahead of the farmland rules: registered roads and "
        "hollow-way systems (Färdväg, Färdvägssystem) within {road:.0f} m of their "
        "registered line are kept as open corridor, because a route in use is not a "
        "wood. Then, among what the wetter rules leave: Isälvssediment (glaciofluvial "
        "sand and gravel) and Klapper (boulder beach gravel) — the well-drained esker "
        "and beach deposits that carry the dry routes across an otherwise wet valley "
        "floor.",
    ),
    (
        "broadleaf_forest",
        "Broadleaf forest",
        "#4f7a3a",
        {"type": "broadleaf", "densityPerHa": 90},
        None,
        "The remaining till (Sandig morän and the other morän classes) on ground no "
        "steeper than {forest_slope:.0f}° and more than {radius:.0f} m from the era's "
        "grave and settlement evidence — closer in, the same till is modelled as "
        "grazed wooded pasture instead of closed wood.",
    ),
    (
        "conifer_forest",
        "Conifer forest / rocky ground",
        "#2f5233",
        {"type": "conifer", "densityPerHa": 120},
        None,
        "Everything the rules above leave: exposed bedrock (Urberg), any ground "
        "steeper than {forest_slope:.0f}°, and any SGU class this rule table does "
        "not name.",
    ),
    (
        "settlement_cleared",
        "Settled ground (kept clear)",
        "#b08d6e",
        None,
        None,
        "Within {clear:.0f} m of the registered footprint of an occupied remain in "
        "sites.json — the fornborg extent itself (Fornborg) plus the era's grave and "
        "settlement records: {proxy_types} — and not already water or fen. Applied "
        "before the road, farmland and forest rules, so occupied ground is neither "
        "ploughed nor reforested: a fort interior or grave field in use is modelled as "
        "trampled, grazed and deliberately kept open. Enclosure remains (Hägnad, "
        "Hägnadssystem) are deliberately not in this list — a fence bank says how land "
        "was divided, not that its ground was occupied — and roads have their own "
        "corridor rule. The KMR extent is a registration boundary, not an excavated "
        "plan, and the {clear:.0f} m margin is a modelling choice, not a mapped "
        "feature.",
    ),
    (
        "shore_reeds",
        "Shore reed belt (follows the shoreline)",
        "#77875a",
        {"type": "reeds", "densityPerHa": 500},
        "shore-band",
        "Ground within {band:.1f} m above the water line of the century being shown. "
        "It is an exact function of the sea-connectivity grid (water_connect.tif, "
        "contract §7) and the current slider level — the strip where "
        "current level < connect ≤ current level + {band:.1f} m — so the app derives "
        "it at runtime and it is never baked into the raster, which is why its area "
        "fraction is 0 rather than a measured share. At the {year} CE reference level "
        "of {level:.1f} m RH 2000 the belt covers {band_pct:.1f} % of the extent. The "
        "band is a modelling choice, not a mapped feature; ground inside it is also "
        "kept clear of trees.",
    ),
    (
        "wooded_pasture",
        "Wooded pasture (grazed, half-open)",
        "#8aa562",
        {"type": "broadleaf", "densityPerHa": 20},
        None,
        "Till on ground no steeper than {forest_slope:.0f}° within {pasture:.0f} m of "
        "the era's registered grave and settlement evidence — {proxy_types} — that no "
        "earlier rule claimed: grazed, half-open woodland rather than closed forest. "
        "This is the strongly grazing-opened landscape around Iron Age settlement that "
        "the pollen literature describes (PLAN.md §2.5), and it carries sparse "
        "broadleaf at 20 stems per hectare against the closed wood's 90. The "
        "{pasture:.0f} m radius is a modelling choice, not a mapped boundary, and is "
        "deliberately tighter than the farmland rule's {radius:.0f} m: the infield's "
        "grazed fringe, while closed forest persists on the outland till.",
    ),
    (
        "alvar",
        "Alvar / open limestone heath",
        "#b9bd9e",
        None,
        None,
        "SGU maps the ground as 'Sedimentärt berg' — on Öland and Gotland the "
        "limestone pavement of the alvar, carrying centimetres of soil at most. "
        "Ground that cannot hold closed forest is modelled as open grass heath "
        "whatever its slope, klint faces included: bare rock and thin grass, not "
        "wood. The palaeoecological record holds the great alvar grasslands open "
        "through the Iron Age under grazing (Königsson 1968; "
        "docs/vegetation-zones.md §5). Applied after the water, fen, settled-ground, "
        "road and mapped-field rules, so a registered monument or fossil field on "
        "the alvar keeps its own class. Scattered juniper is characteristic of the "
        "real alvar, but the model's three tree forms have no honest shrub, so the "
        "class ships treeless rather than dressing junipers as full-height trees.",
    ),
)


#: Rule text for the two water-tied classes on a *dry* site (no §6/§7 water
#: pair, scale-out §4.3): the wet rules describe slider behaviour the app can
#: only provide with a connect grid, so shipping them on a dry site would
#: disclose a method that never runs. Neither entry is marked `dynamic`.
_DRY_WATER_RULE = (
    "SGU maps the present ground as 'Vatten' — the lakes and watercourses that "
    "hold water whatever the sea is doing. This site ships no shoreline model "
    "(the SGU strandförskjutning polygons do not reach its extent in the era "
    "range, which is the normal case for an inland fort), so there is no "
    "modelled sea and no water-level slider here: the raster's water cells are "
    "all the water the model shows."
)
_DRY_REEDS_RULE = (
    "Defined only for sites with a modelled shoreline: the reed belt is the "
    "strip just above the sea's edge, derived from the sea-connectivity grid at "
    "the level being shown. This site has no shoreline model, so the class is "
    "empty and holds no cells."
)

#: Appended to the conifer class's rule where the measured 500 CE spruce front
#: (docs/vegetation-zones.md §2.4) says Norway spruce had not arrived.
_NO_SPRUCE_NOTE = (
    " At 500 CE Norway spruce had not yet colonized this region — the measured "
    "spruce front runs north and east of here (docs/vegetation-zones.md §2.4) — "
    "so the conifer forms in this class represent pine."
)

#: The southern boreal override for the till-forest class: same ground, same
#: density, different measured identity (docs/vegetation-zones.md §2.3).
_BOREAL_TILL_NOTE = (
    " In the southern boreal zone the pollen record for ~500 CE shows the till "
    "forest as pine, birch and spruce rather than oak-hazel woodland "
    "(docs/vegetation-zones.md §2.3), so this class renders conifer forms here, "
    "at the same 90 stems per hectare."
)


def landcover_classes(
    reference_level_m: float,
    params: LandcoverParams = DEFAULT_PARAMS,
    reference_year_ce: int = REFERENCE_YEAR_CE,
    sea_fraction: float = 0.0,
    band_fraction: float = 0.0,
    context: SiteContext = SiteContext(),
) -> tuple[LandcoverClass, ...]:
    """The taxonomy with its names and rule text filled in from the thresholds used.

    `sea_fraction` and `band_fraction` are measured on the connectivity grid at the
    reference level (see `run()`): the two dynamic classes hold no raster cells, so
    their share of the extent has to be quoted from that measurement instead of from
    the class fractions the legend reports.

    `context` (Phase 9d) carries the zone assignment and water availability. The
    default reproduces the pre-9d taxonomy exactly; a zone changes only what
    docs/vegetation-zones.md §4 licenses — the *identity* of the forest classes,
    never a density or a radius.
    """
    fresh_clause = (
        f"the ground stands more than {params.fresh_land_m:.1f} m above the "
        f"{reference_year_ce} CE water line (seabed drained more recently than "
        f"that is too wet to plough); "
        if context.has_shoreline
        else "there is no modelled water line here, so the freshly-drained-seabed "
        "test does not apply; "
    )
    fields = {
        "year": reference_year_ce,
        "level": reference_level_m,
        "band": params.shore_band_m,
        "fresh": params.fresh_land_m,
        "fresh_clause": fresh_clause,
        "margin": params.till_margin_m,
        "radius": params.farmland_radius_m,
        "pasture": params.pasture_radius_m,
        "clear": params.monument_clear_m,
        "cult": params.cultivation_margin_m,
        "road": params.road_corridor_m,
        "farm_slope": params.farmland_max_slope_deg,
        "forest_slope": params.forest_max_slope_deg,
        "proxy_types": PROXY_TYPE_TEXT,
        "sea_pct": 100.0 * float(sea_fraction),
        "band_pct": 100.0 * float(band_fraction),
    }
    dynamic_specs = {
        "water": {"kind": "water"},
        "shore-band": {"kind": "shore-band", "bandM": float(params.shore_band_m)},
    }
    taxonomy = [
        LandcoverClass(
            index=index,
            id=class_id,
            name=name.format(**fields),
            color=color,
            rule=rule.format(**fields),
            vegetation=vegetation,
            dynamic=dynamic_specs[kind] if kind else None,
        )
        for index, (class_id, name, color, vegetation, kind, rule) in enumerate(_RULES)
    ]

    if not context.has_shoreline:
        # Dry site: no dynamic classes, and rule text that does not promise a
        # slider the site cannot drive (the app already treats a legend without
        # `dynamic` keys as fully static, contract §10 v1.3).
        taxonomy[CLASS_WATER] = replace(
            taxonomy[CLASS_WATER], rule=_DRY_WATER_RULE, dynamic=None
        )
        taxonomy[CLASS_SHORE_REEDS] = replace(
            taxonomy[CLASS_SHORE_REEDS], rule=_DRY_REEDS_RULE, dynamic=None
        )

    if context.zone is not None:
        if context.zone.zone == "s_boreal":
            # Same class, same ground, same density — different measured identity.
            taxonomy[CLASS_BROADLEAF] = replace(
                taxonomy[CLASS_BROADLEAF],
                name="Mixed boreal forest (conifer-dominated)",
                vegetation={"type": "conifer", "densityPerHa": 90},
                rule=taxonomy[CLASS_BROADLEAF].rule + _BOREAL_TILL_NOTE,
            )
        if not context.zone.spruce_present:
            taxonomy[CLASS_CONIFER] = replace(
                taxonomy[CLASS_CONIFER],
                name="Pine forest / rocky ground",
                rule=taxonomy[CLASS_CONIFER].rule + _NO_SPRUCE_NOTE,
            )

    return tuple(taxonomy)


CLASS_WATER = 0
CLASS_PEAT_FEN = 1
#: The pre-v1.3 name for class 1, kept as an alias: the raster value and the ground
#: it means are unchanged, only the shore-band branch left it.
CLASS_MARSH = CLASS_PEAT_FEN
CLASS_FARMLAND = 2
CLASS_MEADOW = 3
CLASS_DRY_CORRIDOR = 4
CLASS_BROADLEAF = 5
CLASS_CONIFER = 6
#: Appended in v1.2.1 so the six original raster values kept their meaning;
#: `classify()` applies it third (after water and fen), not last.
CLASS_CLEARED = 7
#: Appended in v1.3 and never written by `classify()`: the shore reed belt is a
#: `dynamic` class the app derives from the connect grid at the level it is showing.
CLASS_SHORE_REEDS = 8
#: Appended in v1.3, applied between the gravel corridors and the broadleaf wood.
CLASS_WOOD_PASTURE = 9
#: Appended in Phase 9d for the island sites: sedimentary bedrock (limestone
#: alvar) is open heath, not conifer/rocky ground. Every legend lists it; its
#: area fraction is simply 0 wherever SGU maps no 'Sedimentärt berg'.
CLASS_ALVAR = 10


# --------------------------------------------------------------------------- #
# rasterizing the inputs onto the context grid
# --------------------------------------------------------------------------- #


def fill_nearest(values: np.ndarray, missing: np.ndarray) -> np.ndarray:
    """Replace `missing` cells with their nearest present neighbour's value.

    `distance_transform_edt(..., return_indices=True)` gives, for every cell, the
    index of the nearest zero cell — here the nearest *covered* cell — so one
    fancy-index does the whole fill. SGU's coverage over a mapped area is
    near-total; this closes the slivers between adjacent polygons.
    """
    if not missing.any():
        return values
    if missing.all():
        raise LandcoverError(
            "no SGU polygon covers any cell of the context grid — the soil extract and the "
            "site extent do not overlap (check fetch_soils.bbox_3006's axis order)"
        )
    _distance, indices = ndimage.distance_transform_edt(missing, return_indices=True)
    return values[tuple(indices)]


def rasterize_soils(
    soil_features: Iterable[dict], shape: tuple[int, int], transform: Affine
) -> tuple[np.ndarray, np.ndarray, dict[str, int], float]:
    """Burn the SGU polygons onto the grid.

    Returns `(group, peat_surface, unmatched, coverage)`:

      * `group` — one `GROUP_*` code per cell, gaps filled from the nearest
        covered cell;
      * `peat_surface` — True where `ytlager` maps a peat veneer;
      * `unmatched` — {SGU class text -> polygon count} for classes this table
        does not name, so the run log can show what fell through to `GROUP_OTHER`;
      * `coverage` — fraction of cells a polygon actually covered, before filling.

    Polygons are burned largest-first (`geom_area` descending) so that a small
    inclusion mapped inside a larger unit wins the cells it occupies.
    """
    ground: list[tuple[dict, int]] = []
    veneer: list[tuple[dict, int]] = []
    unmatched: dict[str, int] = {}

    def area(feature: dict) -> float:
        return float((feature.get("properties") or {}).get("geom_area") or 0.0)

    for feature in sorted(soil_features, key=area, reverse=True):
        geometry = feature.get("geometry")
        name = soil_class(feature)
        if not geometry or not name:
            continue
        if is_surface_layer(feature):
            if name == SURFACE_PEAT_CLASS:
                veneer.append((geometry, 1))
            continue
        group = SOIL_GROUPS.get(name)
        if group is None:
            unmatched[name] = unmatched.get(name, 0) + 1
            group = GROUP_OTHER
        ground.append((geometry, group))

    if not ground:
        raise LandcoverError(
            "the SGU extract holds no classified ground-layer polygon for this extent — "
            "there is nothing to classify the terrain against"
        )

    burned = features.rasterize(
        ground, out_shape=shape, transform=transform, fill=GROUP_NONE, dtype="uint8"
    )
    coverage = float((burned != GROUP_NONE).mean())
    group = fill_nearest(burned, burned == GROUP_NONE)

    peat_surface = (
        features.rasterize(
            veneer, out_shape=shape, transform=transform, fill=0, dtype="uint8"
        ).astype(bool)
        if veneer
        else np.zeros(shape, dtype=bool)
    )
    return group, peat_surface, unmatched, coverage


def local_to_3006(geometry: dict, cfg: SiteConfig) -> dict:
    """Local scene `[x, z]` geometry (contract §0/§3) -> EPSG:3006 `[E, N]`.

    The inverse of `fetch_sites.geometry_to_local`: `E = x + origin.e`,
    `N = origin.n - z`.
    """

    def convert(coords, depth: int):
        if depth == 0:
            return [coords[0] + cfg.center_e, cfg.center_n - coords[1]]
        return [convert(part, depth - 1) for part in coords]

    depths = {
        "Point": 0,
        "MultiPoint": 1,
        "LineString": 1,
        "MultiLineString": 2,
        "Polygon": 2,
        "MultiPolygon": 3,
    }
    kind = geometry.get("type")
    if kind not in depths:
        raise LandcoverError(f"unsupported geometryLocal type {kind!r} in sites.json")
    return {"type": kind, "coordinates": convert(geometry["coordinates"], depths[kind])}


def settlement_mask(
    sites_document: dict,
    shape: tuple[int, int],
    transform: Affine,
    cfg: SiteConfig,
    types: frozenset[str] = SETTLEMENT_TYPES,
) -> tuple[np.ndarray, int]:
    """Cells occupied by the registered records of `types`. Returns (mask, records).

    Used for every evidence set the rules read — settlement proxies, cleared
    footprints, mapped field remains and road lines — since all of them are the same
    operation on a different `lamningstyp` filter.

    Every selected record contributes its representative point; those that carry a
    `geometryLocal` outline contribute that too, so a 200 m grave field is not
    reduced to a single cell. Records outside the grid are dropped silently —
    `sites.json` is fetched with the same bbox, but a polygon can straddle the edge.
    """
    mask = np.zeros(shape, dtype=bool)
    shapes: list[tuple[dict, int]] = []
    records = 0

    for record in sites_document.get("sites", []):
        if record.get("lamningstyp") not in types:
            continue
        records += 1
        geometry = record.get("geometryLocal")
        if geometry and geometry.get("type") not in ("Point", "MultiPoint"):
            shapes.append((local_to_3006(geometry, cfg), 1))
        position = record.get("position") or {}
        if "x" not in position or "z" not in position:
            continue
        col = int((position["x"] + cfg.center_e - transform.c) / transform.a)
        row = int((transform.f - (cfg.center_n - position["z"])) / -transform.e)
        if 0 <= row < shape[0] and 0 <= col < shape[1]:
            mask[row, col] = True

    if shapes:
        mask |= features.rasterize(
            shapes, out_shape=shape, transform=transform, fill=0, dtype="uint8"
        ).astype(bool)
    return mask, records


def distance_meters(mask: np.ndarray, resolution: float) -> np.ndarray:
    """Euclidean distance (m) from every cell to the nearest True cell in `mask`."""
    if not mask.any():
        # No proxy in frame: nothing is "near a settlement", and the farmland rule
        # simply never fires. That is a missing input, not an error.
        return np.full(mask.shape, np.inf, dtype=np.float64)
    return ndimage.distance_transform_edt(~mask, sampling=resolution)


def slope_degrees(heights_m: np.ndarray, resolution: float) -> np.ndarray:
    """Slope in degrees from a north-up height grid (`np.gradient`, both axes)."""
    d_row, d_col = np.gradient(np.asarray(heights_m, dtype=np.float64), resolution)
    return np.degrees(np.arctan(np.hypot(d_col, d_row)))


# --------------------------------------------------------------------------- #
# the rule engine
# --------------------------------------------------------------------------- #


def classify(
    connect_m: np.ndarray | None,
    soil_group: np.ndarray,
    peat_surface: np.ndarray,
    slope_deg: np.ndarray,
    settlement_distance_m: np.ndarray,
    monument_distance_m: np.ndarray,
    cultivation_distance_m: np.ndarray,
    road_distance_m: np.ndarray,
    reference_level_m: float | None,
    cell_size_m: float,
    params: LandcoverParams = DEFAULT_PARAMS,
) -> np.ndarray:
    """Land-cover class index per cell. Pure array function — the whole rule engine.

    Precedence is explicit and one-directional: each rule writes only where no
    earlier rule has claimed the cell, in the order mapped water -> peat fen ->
    occupied footprints -> road corridors -> farmland (mapped evidence, then the
    proximity heuristic) -> the remaining open ground -> wooded pasture -> forest.
    The rule strings in `_RULES` state the same order in prose, and the app renders
    them verbatim, so a change here is a change there.

    `connect_m` is read for one test only — whether the ground drained long enough
    ago to plough. The sea itself and the reed belt above it are `dynamic` legend
    classes (§9/§10 v1.3) the app derives at the level it is showing, so this
    function never writes `CLASS_SHORE_REEDS` and never calls sea-connected ground
    water. A dry site (scale-out §4.3: no water pair) passes `connect_m=None` and
    `reference_level_m=None` together — the one sea test is then vacuous, since
    with no modelled sea nothing recently drained out of it.
    """
    if (connect_m is None) != (reference_level_m is None):
        raise LandcoverError(
            "connect_m and reference_level_m must be given together (wet site) or "
            "both be None (dry site)"
        )
    water_grids = (connect_m,) if connect_m is not None else ()
    shapes = {a.shape for a in (*water_grids, soil_group, peat_surface, slope_deg)}
    if len(shapes) != 1:
        raise LandcoverError(f"rule inputs disagree on shape: {sorted(shapes)}")
    for label, grid in (
        ("settlement", settlement_distance_m),
        ("monument", monument_distance_m),
        ("cultivation", cultivation_distance_m),
        ("road", road_distance_m),
    ):
        if grid.shape != soil_group.shape:
            raise LandcoverError(
                f"{label} distance grid is {grid.shape}, expected {soil_group.shape}"
            )

    # 1. water — only what SGU maps as water today. The reference century's sea is
    #    a dynamic class (§9 v1.3): freezing it here left a stale sea tint on ground
    #    the slider had already drained.
    classes = np.where(soil_group == GROUP_WATER, CLASS_WATER, CLASS_CONIFER).astype(np.uint8)
    taken = classes == CLASS_WATER

    # 2. peat fen — peat/gyttja ground or a peat veneer. Mapped soil, so the class
    #    is static: a fen the falling sea strands inland is still a fen. The reed
    #    belt that used to ride on `connect` here is class 8, derived at runtime.
    fen = ~taken & ((soil_group == GROUP_PEAT) | peat_surface)
    classes[fen] = CLASS_PEAT_FEN
    taken |= fen

    # 3. settled ground — the registered footprint of the era's occupied remains
    #    (fornborg extent, graves, settlement remains) plus a small margin.
    #    Occupied ground is kept clear of trees, and — coming before the road and
    #    farmland rules — it is not ploughed either: a grave field is not a field.
    cleared = ~taken & (monument_distance_m <= params.monument_clear_m)
    classes[cleared] = CLASS_CLEARED
    taken |= cleared

    # 4. road corridors — a registered färdväg line, buffered to a cart track's
    #    width. Before farmland, so a road crossing a field reads as the route.
    road = ~taken & (road_distance_m <= params.road_corridor_m)
    classes[road] = CLASS_DRY_CORRIDOR
    taken |= road

    # 5. farmland from mapped evidence — a registered field remain's own footprint.
    #    No soil or proximity test: the record already says this ground was tilled,
    #    and only the slope gate remains (a terrace on a 20° hillside is not ploughed
    #    ground in the sense this class means).
    evidence_farmland = (
        ~taken
        & (cultivation_distance_m <= params.cultivation_margin_m)
        & (slope_deg <= params.farmland_max_slope_deg)
    )
    classes[evidence_farmland] = CLASS_FARMLAND
    taken |= evidence_farmland

    # 6. farmland from proximity — cultivable soil, long enough out of the sea,
    #    gentle ground, close to a settlement proxy. "Till margins" is taken
    #    literally: only the fringe of a till unit that abuts a fine sediment counts,
    #    not the whole moraine, which would put half the uplands under the plough.
    fine = soil_group == GROUP_FINE
    to_fine = distance_meters(fine, cell_size_m)
    till_margin = (soil_group == GROUP_TILL) & (to_fine <= params.till_margin_m)
    # Dry site: with no modelled sea, no ground is freshly drained seabed, so the
    # test passes everywhere rather than blocking the plough nationwide.
    long_drained = (
        connect_m > reference_level_m + params.fresh_land_m - LEVEL_EPSILON
        if connect_m is not None
        else np.ones(soil_group.shape, dtype=bool)
    )
    farmland = (
        ~taken
        & (fine | till_margin)
        & long_drained
        & (slope_deg <= params.farmland_max_slope_deg)
        & (settlement_distance_m <= params.farmland_radius_m)
    )
    classes[farmland] = CLASS_FARMLAND
    taken |= farmland

    # 7. wet meadow / open pasture — the remaining fine-grained ground.
    meadow = ~taken & ((soil_group == GROUP_FINE) | (soil_group == GROUP_CLAY))
    classes[meadow] = CLASS_MEADOW
    taken |= meadow

    # 8. dry open corridor — esker and beach gravels.
    corridor = ~taken & (soil_group == GROUP_GRAVEL)
    classes[corridor] = CLASS_DRY_CORRIDOR
    taken |= corridor

    # 8b. alvar — sedimentary bedrock (Öland/Gotland limestone pavement): ground
    #     that cannot carry closed forest is open heath whatever its slope, klint
    #     faces included; treeless grass beats forested cliffs for honesty.
    #     After the evidence rules, so a monument or mapped field on the alvar
    #     keeps its own class (Phase 9d, docs/vegetation-zones.md §5.3).
    alvar = ~taken & (soil_group == GROUP_SEDIMENTARY)
    classes[alvar] = CLASS_ALVAR
    taken |= alvar

    # 9. wooded pasture — till within the grazing radius: half-open woodland,
    #    not closed wood. Tighter than the farmland radius on purpose — with the
    #    widened grave evidence, the farmland radius covers ~90 % of a typical
    #    extent and would swallow the broadleaf forest whole (infield/outland).
    pasture = (
        ~taken
        & (soil_group == GROUP_TILL)
        & (slope_deg <= params.forest_max_slope_deg)
        & (settlement_distance_m <= params.pasture_radius_m)
    )
    classes[pasture] = CLASS_WOOD_PASTURE
    taken |= pasture

    # 10. broadleaf forest — the till left beyond that radius, on gentle ground.
    broadleaf = ~taken & (soil_group == GROUP_TILL) & (slope_deg <= params.forest_max_slope_deg)
    classes[broadleaf] = CLASS_BROADLEAF

    # 11. conifer forest / rocky ground — the initial fill; everything still unclaimed.
    return classes


def area_fractions(classes: np.ndarray, class_count: int) -> list[float]:
    """Fraction of the raster in each class index, in index order (contract §10)."""
    counts = np.bincount(np.asarray(classes).ravel(), minlength=class_count)
    if counts.size > class_count:
        raise LandcoverError(
            f"the raster holds class index {int(counts.size) - 1}, but the legend declares "
            f"only {class_count} classes (contract §9)"
        )
    return [float(count) / float(classes.size) for count in counts]


# --------------------------------------------------------------------------- #
# landcover_legend.json assembly + validation (contract §10)
# --------------------------------------------------------------------------- #

CAVEAT = (
    "Modeled landscape, not evidence: a rule engine derived this from modern SGU soil "
    "mapping, DEM slope and the modelled shoreline — there is no direct evidence for the "
    "vegetation shown at any single point."
)

METHOD = (
    "Every 2 m cell of the {extent:.0f}×{extent:.0f} km context extent was classified once, "
    "for {year} CE, by a rule engine reading {input_count} inputs: the SGU Jordarter polygons "
    "({collections}) rasterized onto the grid, with any cell no polygon covered "
    "({coverage:.1f} % of the extent here) taking its nearest neighbour's class and the "
    "surface layer's peat veneer carried as a separate flag; slope in degrees from the "
    "committed LiDAR DEM (np.gradient); {water_input}"
    "the Euclidean distance to the nearest of the {proxies} registered grave or "
    "settlement records in sites.json, used as the cultivation proxy and the grazing radius; "
    "the distance to the registered footprints of the era's occupied remains (the fornborg "
    "extent plus those same grave and settlement records), whose ground is modelled as kept "
    "clear of trees; the distance to the {cultivation} registered field remains (fossil "
    "åker, röjningsrösen, terrasseringar), which are cultivated ground on the record's own "
    "evidence rather than by proximity; and the distance to the {roads} registered road "
    "records, whose line is kept as an open corridor. The rules are applied in a fixed "
    "precedence — mapped water first, then peat fen, then the occupied footprints, then the "
    "road corridors, then farmland (mapped evidence before the proximity heuristic), then "
    "the remaining open ground (the alvar among it), then wooded pasture and forest — and "
    "each class's rule text "
    "below states its own branch verbatim. {dynamic_note}"
    "Every other class was classified once, for {year} CE. SGU maps the present-day "
    "soil surface; treating it as the ground of {year} CE is the model's central assumption. "
    "The raster answers only 'what might this landscape have looked like around {year} CE?'."
    "{zone_note}"
)

#: The water-input clause of METHOD for a site with the §6/§7 pair, verbatim as
#: it read before the dry-site variant existed.
_METHOD_WATER_WET = (
    "the sea-connectivity grid (water_connect.tif) "
    "against the {year} CE water level of {level:.1f} m RH 2000 interpolated from "
    "shoreline.json, read for one test only — whether the ground drained long enough ago to "
    "plough; "
)
_METHOD_WATER_DRY = (
    "no water input: this site ships no shoreline model or connectivity grid "
    "(the strandförskjutning polygons do not reach its extent in the era range, "
    "the normal case inland), so the freshly-drained-seabed test does not apply; "
)
_METHOD_DYNAMIC_WET = (
    "Two classes are deliberately not in the raster: "
    "the open sea and the {band:.1f} m shore reed band above it are exact functions of the "
    "connectivity grid and the water level, so the app draws them for whatever century the "
    "slider shows instead of reading a frozen {year} CE copy — contract §9's v1.3 carve-out, "
    "using the same data and the same 'connect ≤ level' semantics as the §7 water rendering. "
)
_METHOD_DYNAMIC_DRY = (
    "With no water pair there are no dynamic classes here: the water class holds "
    "only SGU-mapped modern water and the shore reed class is empty. "
)
#: The Phase-9d zone disclosure appended to METHOD. Everything the zone does is
#: named; everything it does not do is named too.
_METHOD_ZONE = (
    " The parameter set is the {zone_name} zone's — assignment by latitude "
    "({lat:.2f}°N) with the altitude term and the Öland/Gotland carve-out "
    "(docs/vegetation-zones.md §1.2, a documented modelling choice, not a "
    "surveyed boundary). Norway spruce is {spruce} the {year} CE conifer mix "
    "here (the measured spruce front, docs/vegetation-zones.md §2.4). The zone "
    "changes only the identity of the forest classes; every threshold, radius "
    "and density is identical in every zone (docs/vegetation-zones.md §4)."
)

CALIBRATION_MEASURED = (
    "Measured on this raster: {forest:.1f} % closed forest ({broadleaf:.1f} % broadleaf, "
    "{conifer:.1f} % conifer), {open_land:.1f} % open ground ({farmland:.1f} % farmland, "
    "{meadow:.1f} % wet meadow/pasture, {corridor:.1f} % dry gravel corridor, "
    "{cleared:.1f} % settled ground kept clear{alvar_clause}), and {pasture:.1f} % wooded "
    "pasture — grazed "
    "and half-open, so it is reported as its own term and counted with the open ground in the "
    "ratio below, not with the forest. Then "
    "{marsh:.1f} % peat fen and {water:.1f} % modern (SGU 'Vatten') water. {sea_note}Counting "
    "only dry land, the forest-to-open ratio is {forest_land:.0f}:{open_land_dry:.0f}. "
)

_SEA_NOTE_WET = (
    "The sea is not in "
    "the raster: at the {year} CE level the sea additionally covers {sea:.1f} % of the extent "
    "and the shore reed belt {bandpct:.1f} %, both re-derived by the app for the century it "
    "is showing. "
)
_SEA_NOTE_DRY = (
    "There is no modelled sea here — the site ships no shoreline model — so the "
    "water share above is all the water the model shows. "
)

#: The regional pollen picture per zone, from the assemblages computed for this
#: phase (docs/vegetation-zones.md §2). Qualitative on purpose: raw pollen
#: percentages are not vegetation percentages and are never quoted as cover.
_ZONE_CALIBRATION = {
    "nemoral": (
        "The regional pollen record for the nemoral zone at ~500 CE "
        "(docs/vegetation-zones.md §2, computed from 13 Neotoma pollen sites) shows a "
        "broadleaf landscape — birch, alder, hazel and oak dominant, beech present but "
        "far from its later dominance — carrying the strongest agrarian signal in the "
        "country, opened district by district rather than uniformly. The model's "
        "opening around settlement evidence is consistent with that picture. "
    ),
    "boreonemoral": (
        "The regional pollen record for the boreonemoral zone at ~500 CE "
        "(docs/vegetation-zones.md §2, computed from 23 Neotoma pollen sites) shows the "
        "classic mixed picture — birch, pine, alder, oak and hazel, with opening "
        "concentrated around settlement while forest persisted on the till — which is "
        "the pattern the evidence-radius rules reproduce. "
    ),
    "s_boreal": (
        "The regional pollen record for the southern boreal zone at ~500 CE "
        "(docs/vegetation-zones.md §2, six Neotoma pollen sites) shows closed "
        "conifer-dominated forest — pine and birch with spruce as a stand-former — and "
        "agrarian indicators at trace level; the sparser KMR evidence around most "
        "sites here keeps the modelled landscape correspondingly closed. "
    ),
}

_ANCHOR_COVERED = (
    "For regional context, the pollen-based REVEALS reconstruction estimates "
    "{ol:.0f} ± {se} % open land for this site's 1°×1° grid cell in 250–750 CE "
    "({citation}). A 100 km cell mean and a 4 km fort context measure different "
    "things — forts sit where the evidence is — so the figure is quoted as "
    "context, not fitted. "
)
_ANCHOR_ABSENT = (
    "The pollen-based REVEALS reconstruction of Iron Age land cover (Githumbi et "
    "al. 2022) has no estimate for this site's 1°×1° grid cell — no suitable "
    "pollen record fed the model there, a measured absence "
    "(docs/vegetation-zones.md §3.1) — so there is no quantified regional "
    "openness figure to quote, and none has been invented. "
)
#: Only the Broborg pair carries these citations: they cover this one valley
#: (see SiteContext.local_pollen_anchors).
_LOCAL_ANCHORS = (
    "The pollen records that cover this valley (Karlsson 1999 for the "
    "Arlanda–Knivsta area; the Stockholm University thesis on shore displacement "
    "and paleoenvironment along Långhundraleden) are qualitative here: they "
    "describe an Iron Age landscape opening around settlement and waterway while "
    "forest persisted on till and bedrock, which is the pattern this "
    "classification reproduces. "
)
_CALIBRATION_CLOSE = (
    "The ratio is reported, not force-fitted (PLAN.md §4.7): the opening rules are "
    "calibrated at Broborg and held national — no regional openness figure has "
    "been fitted, per zone or otherwise (docs/vegetation-zones.md §3.2)."
)


def method_text(
    cfg: SiteConfig,
    reference_level_m: float | None,
    collections: Sequence[str],
    coverage: float,
    proxies: int,
    reference_year_ce: int = REFERENCE_YEAR_CE,
    cultivation: int = 0,
    roads: int = 0,
    params: LandcoverParams = DEFAULT_PARAMS,
    context: SiteContext = SiteContext(),
) -> str:
    """The one-paragraph derivation description the app shows verbatim (contract §10)."""
    if context.has_shoreline:
        water_input = _METHOD_WATER_WET.format(
            year=reference_year_ce, level=reference_level_m
        )
        dynamic_note = _METHOD_DYNAMIC_WET.format(
            year=reference_year_ce, band=params.shore_band_m
        )
        input_count = "seven"
    else:
        water_input = _METHOD_WATER_DRY
        dynamic_note = _METHOD_DYNAMIC_DRY
        input_count = "six"
    zone_note = (
        _METHOD_ZONE.format(
            zone_name=context.zone.zone_name,
            lat=context.zone.lat,
            year=reference_year_ce,
            spruce="part of" if context.zone.spruce_present else "absent from",
        )
        if context.zone is not None
        else ""
    )
    return METHOD.format(
        extent=2.0 * cfg.context.half_extent / 1000.0,
        year=reference_year_ce,
        input_count=input_count,
        water_input=water_input,
        dynamic_note=dynamic_note,
        zone_note=zone_note,
        collections=", ".join(collections) or "n/a",
        coverage=100.0 * (1.0 - coverage),
        proxies=proxies,
        cultivation=cultivation,
        roads=roads,
    )


def calibration_text(
    fractions: Sequence[float],
    reference_year_ce: int = REFERENCE_YEAR_CE,
    sea_fraction: float = 0.0,
    band_fraction: float = 0.0,
    context: SiteContext = SiteContext(),
) -> str:
    """The measured forest/open shares plus the regional context (contract §10).

    `sea_fraction` and `band_fraction` are the two dynamic classes' share of the
    extent at the reference level, measured on the connectivity grid: they hold no
    raster cells, so `fractions` cannot report them.

    Since Phase 9d the paragraph is assembled per site: the measured shares, the
    zone's pollen picture, the REVEALS cell anchor (or its measured absence —
    both are real results, docs/vegetation-zones.md §3), the Broborg pair's
    valley-specific citations, and the report-not-fit close. Nothing here ever
    feeds back into the rules.
    """
    percent = [100.0 * f for f in fractions]
    forest = percent[CLASS_BROADLEAF] + percent[CLASS_CONIFER]
    pasture = percent[CLASS_WOOD_PASTURE]
    # The alvar joins the open ground: it is grazed grass heath (its rule text),
    # and counting it as forest-adjacent would undo the point of the class.
    alvar = percent[CLASS_ALVAR] if len(percent) > CLASS_ALVAR else 0.0
    open_land = (
        percent[CLASS_FARMLAND]
        + percent[CLASS_MEADOW]
        + percent[CLASS_DRY_CORRIDOR]
        + percent[CLASS_CLEARED]
        + alvar
    )
    # Wooded pasture is grazed half-open ground, so the ratio counts it as open and
    # the sentence above says so rather than letting the number carry the decision.
    open_total = open_land + pasture
    dry = forest + open_total
    sea_note = (
        _SEA_NOTE_WET.format(
            year=reference_year_ce,
            sea=100.0 * float(sea_fraction),
            bandpct=100.0 * float(band_fraction),
        )
        if context.has_shoreline
        else _SEA_NOTE_DRY
    )
    text = CALIBRATION_MEASURED.format(
        year=reference_year_ce,
        forest=forest,
        broadleaf=percent[CLASS_BROADLEAF],
        conifer=percent[CLASS_CONIFER],
        pasture=pasture,
        open_land=open_land,
        farmland=percent[CLASS_FARMLAND],
        meadow=percent[CLASS_MEADOW],
        corridor=percent[CLASS_DRY_CORRIDOR],
        cleared=percent[CLASS_CLEARED],
        alvar_clause=(
            f", {alvar:.1f} % open alvar limestone heath" if alvar >= 0.05 else ""
        ),
        marsh=percent[CLASS_PEAT_FEN],
        water=percent[CLASS_WATER],
        sea_note=sea_note,
        forest_land=round(100.0 * forest / dry) if dry else 0,
        open_land_dry=round(100.0 * open_total / dry) if dry else 0,
    )
    if context.zone is not None:
        text += _ZONE_CALIBRATION[context.zone.zone]
    if context.anchor is not None:
        anchor = context.anchor
        se = f"{anchor.open_land_se_pct:.0f}" if anchor.open_land_se_pct is not None else "?"
        text += _ANCHOR_COVERED.format(
            ol=anchor.open_land_pct, se=se, citation=REVEALS_CITATION
        )
    else:
        text += _ANCHOR_ABSENT
    if context.local_pollen_anchors:
        text += _LOCAL_ANCHORS
    return text + _CALIBRATION_CLOSE


def build_legend(
    cfg: SiteConfig,
    classes: Sequence[LandcoverClass],
    fractions: Sequence[float],
    reference_level_m: float | None,
    soils_meta: dict,
    coverage: float,
    proxies: int,
    reference_year_ce: int = REFERENCE_YEAR_CE,
    cultivation: int = 0,
    roads: int = 0,
    sea_fraction: float = 0.0,
    band_fraction: float = 0.0,
    params: LandcoverParams = DEFAULT_PARAMS,
    context: SiteContext = SiteContext(),
) -> dict:
    """Assemble landcover_legend.json (contract §10) and gate it on the invariants."""
    if len(classes) != len(fractions):
        raise LandcoverError(
            f"{len(classes)} classes but {len(fractions)} area fractions — the legend and "
            f"the raster disagree"
        )
    legend = {
        "schemaVersion": SCHEMA_VERSION,
        "site": cfg.id,
        "referenceYearCE": int(reference_year_ce),
        # A dry site has no reference water level; §10 requires the field, so it
        # carries the one honest number — the level below every Swedish land
        # surface — never a made-up local sea. The app only reads it for display
        # next to a slider a dry site does not have.
        "referenceLevelM": round(float(reference_level_m), 1)
        if reference_level_m is not None
        else 0.0,
        "method": method_text(
            cfg,
            reference_level_m,
            soils_meta.get("collections", []),
            coverage,
            proxies,
            reference_year_ce,
            cultivation,
            roads,
            params,
            context,
        ),
        "caveat": CAVEAT,
        "calibration": calibration_text(
            fractions, reference_year_ce, sea_fraction, band_fraction, context
        ),
        "source": {
            "product": soils_meta.get("product", JORD_PRODUCT),
            "api": soils_meta.get("api", JORD_API),
            "fetched": soils_meta.get("fetched", ""),
        },
        "classes": [c.as_json(f) for c, f in zip(classes, fractions)],
    }
    validate_legend(legend)
    return legend


_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


def _is_hex_color(value) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 7
        and value[0] == "#"
        and set(value[1:]) <= _HEX_DIGITS
    )


def validate_legend(legend: dict) -> None:
    """Raise LandcoverError on any contract §10 violation, naming the field."""
    if legend.get("schemaVersion") != SCHEMA_VERSION:
        raise LandcoverError(f"landcover_legend.json: schemaVersion must be {SCHEMA_VERSION}")
    for key in ("site", "method", "caveat", "calibration", "source", "classes"):
        if not legend.get(key):
            raise LandcoverError(f"landcover_legend.json is missing {key!r}")
    if not isinstance(legend.get("referenceYearCE"), int):
        raise LandcoverError("landcover_legend.json: referenceYearCE must be an integer year")
    level = legend.get("referenceLevelM")
    if not isinstance(level, (int, float)) or isinstance(level, bool) or not np.isfinite(level):
        raise LandcoverError("landcover_legend.json: referenceLevelM must be a finite number")
    for key in ("product", "api", "fetched"):
        if not legend["source"].get(key):
            raise LandcoverError(f"landcover_legend.json: source.{key!r} is required")

    classes = legend["classes"]
    if not isinstance(classes, list) or not classes:
        raise LandcoverError("landcover_legend.json: classes must be a non-empty array")
    if len(classes) > MAX_CLASSES:
        raise LandcoverError(
            f"landcover_legend.json: {len(classes)} classes exceeds the {MAX_CLASSES} the "
            f"contract allows (§9)"
        )

    seen: set[str] = set()
    seen_dynamic: set[str] = set()
    for position, entry in enumerate(classes):
        label = f"classes[{position}]"
        if entry.get("index") != position:
            raise LandcoverError(
                f"landcover_legend.json: {label}.index is {entry.get('index')!r}; indices must "
                f"be contiguous and ascending from 0 (§10)"
            )
        for key in ("id", "name", "rule"):
            if not entry.get(key) or not isinstance(entry[key], str):
                raise LandcoverError(f"landcover_legend.json: {label}.{key} must be a non-empty string")
        if entry["id"] in seen:
            raise LandcoverError(f"landcover_legend.json: duplicate class id {entry['id']!r}")
        seen.add(entry["id"])
        if not _is_hex_color(entry.get("color")):
            raise LandcoverError(
                f"landcover_legend.json: {label}.color must be '#rrggbb', got {entry.get('color')!r}"
            )

        vegetation = entry.get("vegetation", ...)
        if vegetation is ...:
            raise LandcoverError(f"landcover_legend.json: {label}.vegetation is required (may be null)")
        if vegetation is not None:
            if vegetation.get("type") not in VEGETATION_TYPES:
                raise LandcoverError(
                    f"landcover_legend.json: {label}.vegetation.type must be one of "
                    f"{VEGETATION_TYPES}, got {vegetation.get('type')!r}"
                )
            density = vegetation.get("densityPerHa")
            if not isinstance(density, (int, float)) or isinstance(density, bool) or density <= 0:
                raise LandcoverError(
                    f"landcover_legend.json: {label}.vegetation.densityPerHa must be > 0, "
                    f"got {density!r}"
                )

        # `dynamic` is optional (§10 v1.3) and absent means a fully static class, so a
        # pre-amendment legend passes here unchanged. The rules mirror the app-side
        # validator in app/src/landcover/legend.ts exactly — the two are read as one.
        dynamic = entry.get("dynamic")
        if dynamic is not None:
            if not isinstance(dynamic, dict):
                raise LandcoverError(
                    f"landcover_legend.json: {label}.dynamic must be an object when present "
                    f"(§10 v1.3)"
                )
            kind = dynamic.get("kind")
            if kind not in DYNAMIC_KINDS:
                raise LandcoverError(
                    f"landcover_legend.json: {label}.dynamic.kind must be one of "
                    f"{DYNAMIC_KINDS}, got {kind!r} (§10 v1.3)"
                )
            band = dynamic.get("bandM")
            if kind == "shore-band":
                if (
                    not isinstance(band, (int, float))
                    or isinstance(band, bool)
                    or not np.isfinite(band)
                    or band <= 0
                ):
                    raise LandcoverError(
                        f"landcover_legend.json: {label}.dynamic.bandM must be a finite number "
                        f"> 0 for kind 'shore-band', got {band!r} (§10 v1.3)"
                    )
            elif "bandM" in dynamic:
                raise LandcoverError(
                    f"landcover_legend.json: {label}.dynamic.bandM is only allowed on kind "
                    f"'shore-band' (§10 v1.3)"
                )
            if kind in seen_dynamic:
                raise LandcoverError(
                    f"landcover_legend.json: more than one class with dynamic.kind {kind!r} — "
                    f"at most one of each kind per legend (§10 v1.3)"
                )
            seen_dynamic.add(kind)

        fraction = entry.get("areaFraction")
        if not isinstance(fraction, (int, float)) or isinstance(fraction, bool):
            raise LandcoverError(f"landcover_legend.json: {label}.areaFraction must be a number")
        if not (0.0 <= float(fraction) <= 1.0):
            raise LandcoverError(
                f"landcover_legend.json: {label}.areaFraction is {fraction}, outside [0, 1]"
            )

    total = sum(float(entry["areaFraction"]) for entry in classes)
    if abs(total - 1.0) > 0.001:
        raise LandcoverError(
            f"landcover_legend.json: areaFraction entries sum to {total:.4f}, not 1 ± 0.001 (§10)"
        )


def write_legend(path: Path, legend: dict) -> Path:
    validate_legend(legend)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(legend, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

# Geometry, encoding and tiling must match `dem_context.tif` exactly (§9). `dtypes`
# is the one property that legitimately differs — uint8 indices vs int16 decimeters
# — so it is checked separately rather than compared.
PROFILE_KEYS = ("width", "height", "crs", "transform", "bounds", "nodata")
PROFILE_ENTRIES = ("compress", "blockxsize", "blockysize", "tiled")
#: rasterio does not surface the predictor in `profile`, only in GDAL's
#: IMAGE_STRUCTURE metadata — so the COG layout and predictor are compared there.
STRUCTURE_TAGS = ("LAYOUT", "COMPRESSION", "PREDICTOR")


def _check_context_profile(reference: Path, candidate: Path) -> None:
    """The contract says landcover.tif matches dem_context.tif's geometry exactly (§9)."""
    with rasterio.open(reference) as ref, rasterio.open(candidate) as new:
        if new.dtypes[0] != "uint8":
            raise LandcoverError(f"{candidate.name} must be uint8 class indices, got {new.dtypes[0]}")
        mismatches = {
            key: (getattr(ref, key), getattr(new, key))
            for key in PROFILE_KEYS
            if getattr(ref, key) != getattr(new, key)
        }
        for key in PROFILE_ENTRIES:
            if ref.profile.get(key) != new.profile.get(key):
                mismatches[key] = (ref.profile.get(key), new.profile.get(key))
        ref_tags, new_tags = ref.tags(ns="IMAGE_STRUCTURE"), new.tags(ns="IMAGE_STRUCTURE")
        for key in STRUCTURE_TAGS:
            if ref_tags.get(key) != new_tags.get(key):
                mismatches[key] = (ref_tags.get(key), new_tags.get(key))
        if ref.overviews(1) != new.overviews(1):
            mismatches["overviews"] = (ref.overviews(1), new.overviews(1))
    if mismatches:
        raise LandcoverError(
            f"{candidate.name} does not match {reference.name}'s profile: {mismatches}"
        )
    print(f"  profile identical to {reference.name} (geometry, tiling, overviews; dtype uint8)")


def _require(path: Path, rerun: str) -> Path:
    if not path.exists():
        raise LandcoverError(f"{path} is missing — run `{rerun}` first.")
    return path


def load_inputs(
    cfg: SiteConfig,
) -> tuple[np.ndarray, np.ndarray | None, Affine, float | None, dict]:
    """Read every committed input the rules need. Returns (heights, connect, transform, level, sites).

    The §6/§7 water pair is optional as a *pair* (scale-out §4.3: inland forts
    ship no shoreline model — "missing asset = feature off"): with neither
    shoreline.json nor a connect grid, `connect` and `level` come back None and
    the caller runs the dry-site rules. Half a pair is still an error — that is
    a broken build, not a dry site.
    """
    build_cmd = f"python3 -m fornborg_pipeline.build --site {cfg.id}"
    water_cmd = f"python3 -m fornborg_pipeline.water --site {cfg.id}"
    sites_cmd = f"python3 -m fornborg_pipeline.fetch_sites --site {cfg.id}"

    context_path = _require(cfg.out_dir / cfg.context.path, build_cmd)
    sites_path = _require(cfg.out_dir / SITES_PATH, sites_cmd)
    _require(cfg.out_dir / "manifest.json", build_cmd)

    has_shoreline = (cfg.out_dir / SHORELINE_PATH).exists()
    has_connect = (cfg.out_dir / WATER_CONNECT_DELTA_PATH).exists() or (
        cfg.out_dir / WATER_CONNECT_PATH
    ).exists()
    if has_shoreline != has_connect:
        missing = "the connect grid" if has_shoreline else SHORELINE_PATH
        raise LandcoverError(
            f"{cfg.id} has half a water pair ({missing} is missing) — re-run "
            f"`{water_cmd}`; a dry site ships neither half."
        )

    dem_dm, transform, _bounds = read_grid(context_path)
    sites_document = json.loads(sites_path.read_text(encoding="utf-8"))
    if not has_shoreline:
        return dequantize_decimeters(dem_dm), None, transform, None, sites_document

    # v1.5 §12: the bundle ships the delta form; `read_connect_grid` reconstructs
    # `connect = dem + delta` exactly as the app does, and still reads a pre-v1.5
    # absolute grid where one is all a bundle has.
    connect_dm, connect_path = read_connect_grid(cfg.out_dir, dem_dm)
    if connect_dm.shape != dem_dm.shape:
        raise LandcoverError(
            f"{connect_path.name} does not share {context_path.name}'s geometry — re-run "
            f"`{water_cmd}`."
        )

    table = json.loads((cfg.out_dir / SHORELINE_PATH).read_text(encoding="utf-8"))
    level = round(float(interpolate_level(table["steps"], REFERENCE_YEAR_CE)), 1)
    return (
        dequantize_decimeters(dem_dm),
        dequantize_decimeters(connect_dm),
        transform,
        level,
        sites_document,
    )


def patch_manifest(cfg: SiteConfig, soils_meta: dict, reference_year_ce: int) -> dict:
    """Add the land-cover pair to the committed manifest and regenerate DATA-LICENSES.md.

    `DATA-LICENSES.md` is rewritten whole, so the shoreline section is reconstructed
    from the manifest's own provenance sources — the same trick `water.patch_manifest`
    uses for the Lantmäteriet block, and the reason re-running this step never drops
    a section an earlier step wrote.
    """
    manifest_path = cfg.out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    add_landcover_asset(
        manifest,
        LANDCOVER_PATH,
        LANDCOVER_LEGEND_PATH,
        source={
            "id": "sgu-jordarter",
            "product": soils_meta.get("product", JORD_PRODUCT),
            "api": soils_meta.get("api", JORD_API),
            "collections": list(soils_meta.get("collections", [])),
            "tiles": [],
            "fetched": soils_meta.get("fetched", ""),
        },
        processing=PROCESSING_STEPS,
    )
    write_manifest(manifest_path, manifest)
    print(f"  wrote {manifest_path}")

    sources = {s.get("id"): s for s in manifest.get("provenance", {}).get("sources", [])}
    dem_source = sources.get("lantmateriet-dtm", {})
    strand_source = sources.get("sgu-strandforskjutning")
    licenses_path = write_data_licenses(
        cfg.out_dir / "DATA-LICENSES.md",
        cfg,
        {
            "product": dem_source.get("product", ""),
            "stacItems": dem_source.get("tiles", []),
            "fetched": dem_source.get("fetched", ""),
        },
        water_meta=dict(strand_source) if strand_source else None,
        soils_meta={**soils_meta, "referenceYearCE": reference_year_ce},
    )
    print(f"  wrote {licenses_path}")
    return manifest


def run(
    site_id: str, force_download: bool = False, params: LandcoverParams = DEFAULT_PARAMS
) -> dict:
    """Derive both land-cover assets for one site and wire them into the manifest."""
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — modeled land cover for {REFERENCE_YEAR_CE} CE")

    heights_m, connect_m, transform, level, sites_document = load_inputs(cfg)
    shape = heights_m.shape
    level_note = (
        f"{REFERENCE_YEAR_CE} CE water level {level:.1f} m RH 2000"
        if level is not None
        else "dry site (no §6/§7 water pair — scale-out §4.3)"
    )
    print(
        f"-- context grid: {shape[1]}x{shape[0]} @ {cfg.context.resolution} m | "
        f"z {heights_m.min():.1f}..{heights_m.max():.1f} m RH 2000 | {level_note}"
    )

    # Phase 9d: the zone parameter set and the REVEALS disclosure. Crown height
    # (context max) carries the altitude term, per docs/vegetation-zones.md §6.
    zone = assign_zone(
        cfg.center_e, cfg.center_n, cfg.county, float(heights_m.max())
    )
    anchor = openness_anchor(zone.lon, zone.lat)
    context = SiteContext(
        zone=zone,
        anchor=anchor,
        has_shoreline=level is not None,
        local_pollen_anchors=cfg.id in LOCAL_POLLEN_ANCHOR_SITES,
    )
    anchor_note = (
        f"REVEALS cell ({anchor.cell_lon}, {anchor.cell_lat}): "
        f"{anchor.open_land_pct:.1f} % open land"
        if anchor is not None
        else "REVEALS cell absent from the product (disclosed)"
    )
    print(
        f"-- zone: {zone.zone_name} ({zone.lat:.3f}N {zone.lon:.3f}E, "
        f"effective {zone.effective_lat:.2f}); spruce "
        f"{'present' if zone.spruce_present else 'absent'} at {REFERENCE_YEAR_CE} CE; "
        f"{anchor_note}"
    )

    print("-- soils (SGU Jordarter)")
    soil_features, soils_meta = fetch_soils(cfg, force_download=force_download)
    soil_group, peat_surface, unmatched, coverage = rasterize_soils(
        soil_features, shape, transform
    )
    census = class_census([f for f in soil_features if not is_surface_layer(f)])
    print(
        f"  {len(soil_features)} polygons, {len(census)} ground classes, "
        f"{100.0 * coverage:.1f} % of cells covered directly "
        f"({100.0 * (1.0 - coverage):.1f} % filled from the nearest polygon)"
    )
    print(f"  peat veneer (ytlager Torv): {100.0 * peat_surface.mean():.2f} % of cells")
    if unmatched:
        listed = ", ".join(f"{name} ({count})" for name, count in sorted(unmatched.items()))
        print(f"  SGU classes not named by the rule table -> conifer/rocky: {listed}")

    print("-- settlement proxies (KMR graves and settlements)")
    proxies, proxy_records = settlement_mask(sites_document, shape, transform, cfg)
    distance = distance_meters(proxies, float(cfg.context.resolution))
    within = float((distance <= params.farmland_radius_m).mean())
    print(
        f"  {proxy_records} records, {int(proxies.sum())} cells occupied; "
        f"{100.0 * within:.1f} % of the extent within {params.farmland_radius_m:.0f} m"
    )

    print("-- occupied footprints (fornborg extent + the proxies above)")
    monuments, monument_records = settlement_mask(
        sites_document, shape, transform, cfg, types=MONUMENT_TYPES
    )
    monument_distance = distance_meters(monuments, float(cfg.context.resolution))
    cleared_extent = float((monument_distance <= params.monument_clear_m).mean())
    print(
        f"  {monument_records} records, {int(monuments.sum())} cells occupied; "
        f"{100.0 * cleared_extent:.2f} % of the extent kept clear "
        f"(footprint + {params.monument_clear_m:.0f} m margin)"
    )

    print("-- cultivation evidence (KMR field remains)")
    cultivation_mask, cultivation_records = settlement_mask(
        sites_document, shape, transform, cfg, types=CULTIVATION_TYPES
    )
    cultivation_distance = distance_meters(cultivation_mask, float(cfg.context.resolution))
    cultivated = float((cultivation_distance <= params.cultivation_margin_m).mean())
    print(
        f"  {cultivation_records} records, {int(cultivation_mask.sum())} cells occupied; "
        f"{100.0 * cultivated:.2f} % of the extent within {params.cultivation_margin_m:.0f} m"
    )

    print("-- road remains (KMR färdvägar)")
    road_mask, road_records = settlement_mask(
        sites_document, shape, transform, cfg, types=ROAD_TYPES
    )
    road_distance = distance_meters(road_mask, float(cfg.context.resolution))
    corridored = float((road_distance <= params.road_corridor_m).mean())
    print(
        f"  {road_records} records, {int(road_mask.sum())} cells on a road line; "
        f"{100.0 * corridored:.2f} % of the extent within {params.road_corridor_m:.0f} m"
    )

    print("-- classification")
    slope = slope_degrees(heights_m, float(cfg.context.resolution))
    classes = classify(
        connect_m,
        soil_group,
        peat_surface,
        slope,
        distance,
        monument_distance,
        cultivation_distance,
        road_distance,
        level,
        float(cfg.context.resolution),
        params,
    )

    # The two dynamic classes (§9/§10 v1.3) hold no raster cells, so their share of
    # the extent at the reference level is measured here instead — the numbers the
    # legend quotes for the sea and the reed belt. The band excludes cells the raster
    # already calls water or fen, matching the app's band-candidate exclusion.
    # A dry site has no connect grid and both fractions are honestly zero.
    if connect_m is not None:
        sea = connect_m <= level + LEVEL_EPSILON
        sea_fraction = float(sea.mean())
        band = (
            ~sea
            & (connect_m <= level + params.shore_band_m + LEVEL_EPSILON)
            & (classes != CLASS_WATER)
            & (classes != CLASS_PEAT_FEN)
        )
        band_fraction = float(band.mean())
        print(
            f"  dynamic classes at {level:.1f} m: sea {100.0 * sea_fraction:.2f} % of the "
            f"extent, shore reed belt {100.0 * band_fraction:.2f} % "
            f"(both re-derived by the app per century, not in the raster)"
        )
    else:
        sea_fraction = band_fraction = 0.0
        print("  no water pair: no dynamic classes; the raster is fully static")

    taxonomy = landcover_classes(
        level if level is not None else 0.0,
        params,
        REFERENCE_YEAR_CE,
        sea_fraction,
        band_fraction,
        context,
    )
    fractions = area_fractions(classes, len(taxonomy))

    print(f"  {'class':<40} {'cells':>10} {'%':>7}")
    for entry, fraction in zip(taxonomy, fractions):
        print(f"  {entry.name:<40} {int(round(fraction * classes.size)):>10,} {100.0 * fraction:>6.2f}")
    forest = fractions[CLASS_BROADLEAF] + fractions[CLASS_CONIFER]
    pasture = fractions[CLASS_WOOD_PASTURE]
    open_land = (
        fractions[CLASS_FARMLAND]
        + fractions[CLASS_MEADOW]
        + fractions[CLASS_DRY_CORRIDOR]
        + fractions[CLASS_CLEARED]
        + fractions[CLASS_ALVAR]
        + pasture
    )
    dry = forest + open_land
    print(
        f"  forest {100.0 * forest:.1f} % vs open {100.0 * open_land:.1f} % "
        f"(incl. {100.0 * pasture:.1f} % wooded pasture; dry land only: "
        f"{100.0 * forest / dry:.0f}:{100.0 * open_land / dry:.0f})"
    )

    path = write_class_grid(cfg.out_dir / LANDCOVER_PATH, classes, transform)
    print(f"  wrote {path} ({path.stat().st_size / 1e3:.1f} kB)")
    _check_context_profile(cfg.out_dir / cfg.context.path, path)

    legend = build_legend(
        cfg,
        taxonomy,
        fractions,
        level,
        soils_meta,
        coverage,
        proxy_records,
        REFERENCE_YEAR_CE,
        cultivation_records,
        road_records,
        sea_fraction,
        band_fraction,
        params,
        context,
    )
    legend_path = write_legend(cfg.out_dir / LANDCOVER_LEGEND_PATH, legend)
    print(f"  wrote {legend_path} ({legend_path.stat().st_size / 1e3:.1f} kB)")

    print("-- manifest")
    manifest = patch_manifest(cfg, soils_meta, REFERENCE_YEAR_CE)
    validate_manifest(manifest)

    total = sum(p.stat().st_size for p in cfg.out_dir.glob("*") if p.is_file())
    print(f"== done: {cfg.out_dir} ({total / 1e6:.2f} MB total)")
    return manifest


@click.command()
@click.option(
    "--site",
    "site_id",
    default="broborg",
    show_default=True,
    type=click.Choice(sorted(SITES)),
    help="Site to derive the land-cover model for.",
)
@click.option(
    "--force-download",
    is_flag=True,
    help="Re-fetch the SGU jordarter extract even if a valid cached copy exists.",
)
@click.option(
    "--farmland-radius",
    default=DEFAULT_PARAMS.farmland_radius_m,
    show_default=True,
    help="How far cultivation is assumed to reach from a settlement proxy (m).",
)
@click.option(
    "--pasture-radius",
    default=DEFAULT_PARAMS.pasture_radius_m,
    show_default=True,
    help="How far grazing keeps the till half-open around the same evidence (m).",
)
@click.option(
    "--forest-slope",
    default=DEFAULT_PARAMS.forest_max_slope_deg,
    show_default=True,
    help="Above this slope, till reads as rocky conifer ground rather than broadleaf (deg).",
)
@click.option(
    "--monument-clear",
    default=DEFAULT_PARAMS.monument_clear_m,
    show_default=True,
    help="Margin around a registered monument footprint kept clear of trees (m).",
)
@click.option(
    "--cultivation-margin",
    default=DEFAULT_PARAMS.cultivation_margin_m,
    show_default=True,
    help="Margin around a mapped field remain classified as farmland (m).",
)
@click.option(
    "--road-corridor",
    default=DEFAULT_PARAMS.road_corridor_m,
    show_default=True,
    help="Half-width of the open corridor kept along a registered road line (m).",
)
def cli(
    site_id: str,
    force_download: bool,
    farmland_radius: float,
    pasture_radius: float,
    forest_slope: float,
    monument_clear: float,
    cultivation_margin: float,
    road_corridor: float,
) -> None:
    """Derive landcover.tif + landcover_legend.json and patch the site manifest."""
    params = replace(
        DEFAULT_PARAMS,
        farmland_radius_m=float(farmland_radius),
        pasture_radius_m=float(pasture_radius),
        forest_max_slope_deg=float(forest_slope),
        monument_clear_m=float(monument_clear),
        cultivation_margin_m=float(cultivation_margin),
        road_corridor_m=float(road_corridor),
    )
    try:
        run(site_id, force_download=force_download, params=params)
    except FetchError as exc:
        raise SystemExit(f"FETCH FAILED: {exc}") from exc
    except SoilsError as exc:
        raise SystemExit(f"SOIL EXTRACT FAILED: {exc}") from exc
    except LandcoverError as exc:
        raise SystemExit(f"LAND-COVER MODEL FAILED: {exc}") from exc


if __name__ == "__main__":
    sys.exit(cli())
