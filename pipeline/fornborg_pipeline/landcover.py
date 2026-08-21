"""Rule-based land-cover model for one reference century (contract §9/§10, PLAN.md §4.7).

    python3 -m fornborg_pipeline.landcover --site broborg

Two outputs, both defined in docs/data-formats.md v1.2:

  * `landcover.tif`          — §9, uint8 class indices on the **context** geometry
  * `landcover_legend.json`  — §10, the classes, palette, rules and area fractions

plus a patch of the site's `manifest.json` + `DATA-LICENSES.md`. Like the water
step, this reads the **committed** grids rather than the raw Lantmäteriet mosaic,
so anyone with the repository can rebuild it with no Geotorget credentials.

What the engine actually knows, per 2 m cell of the 4x4 km context extent:

  1. **water** — `water_connect.tif` (§7), the level at which the cell first
     connects to the open sea, compared against the modelled shoreline level for
     the reference century read out of `shoreline.json` (§6);
  2. **soil** — SGU *Jordarter* polygons (`fetch_soils.py`), rasterized onto the
     grid: the `grundlager` class per cell, plus a boolean peat veneer from
     `ytlager`. Cells no polygon covers take their nearest neighbour's class;
     the veneer's *till* polygons are deliberately ignored (a <0.5 m till skin on
     bedrock does not change what grows there, a peat one does);
  3. **slope** — from the dequantized context DEM, `np.gradient` in degrees;
  4. **settlement proximity** — Euclidean distance to the nearest registered
     grave/settlement record in `sites.json` (§3), the only cultivation proxy
     used;
  5. **monument footprints** — Euclidean distance to the registered footprint
     of the era's occupied remains (the fornborg extent plus the grave and
     settlement records above): ground that *was* the settlement is kept clear
     of trees rather than reforested by the soil rules.

The rules run in a fixed precedence — water, then wetland, then the occupied
footprints, then farmland, then everything else — and each class's `rule`
string in the legend is a verbatim statement of the branch that produced it,
because the app renders those strings in the methods panel and must never
paraphrase a method it did not run.

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
from .connectivity import WATER_CONNECT_PATH
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
from .shoreline import SHORELINE_PATH, interpolate_level
from .sites import SITES, SiteConfig, get_site

LANDCOVER_PATH = "landcover.tif"
LANDCOVER_LEGEND_PATH = "landcover_legend.json"
SCHEMA_VERSION = 1

#: The century the raster models — Broborg's active era (PLAN.md §2.2: in use
#: ~400–550 CE). One raster, one century; the app never re-derives it (§9).
REFERENCE_YEAR_CE = 500

#: Contract §10 allows 32 classes; this taxonomy deliberately stays under 8 so the
#: legend fits on screen and every class earns a distinguishable ground tint.
MAX_CLASSES = 32
VEGETATION_TYPES = ("conifer", "broadleaf", "reeds")

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
GROUP_BEDROCK = 7
GROUP_OTHER = 8  # mapped by SGU, but a class this table does not name

#: `jg2_tx` / `jy1_tx` strings exactly as the API spells them — note the double
#: hyphen in "Svämsediment, ler--silt", which is the product's own spelling and
#: not a typo to be tidied away here. Classes absent from this table fall to
#: `GROUP_OTHER` and are listed in the run log rather than silently absorbed.
SOIL_GROUPS: dict[str, int] = {
    "Vatten": GROUP_WATER,
    "Kärrtorv": GROUP_PEAT,
    "Mosstorv": GROUP_PEAT,
    "Torv": GROUP_PEAT,
    "Gyttja": GROUP_PEAT,
    "Postglacial lera": GROUP_FINE,
    "Gyttjelera (eller lergyttja)": GROUP_FINE,
    "Svämsediment, ler--silt": GROUP_FINE,
    "Postglacial sand": GROUP_FINE,
    "Postglacial silt": GROUP_FINE,
    "Glacial lera": GROUP_CLAY,
    "Glacial silt": GROUP_CLAY,
    "Fyllning": GROUP_CLAY,
    "Isälvssediment": GROUP_GRAVEL,
    "Klapper": GROUP_GRAVEL,
    "Sandig morän": GROUP_TILL,
    "Morän": GROUP_TILL,
    "Grusig morän": GROUP_TILL,
    "Moränlera eller lermorän": GROUP_TILL,
    "Urberg": GROUP_BEDROCK,
    "Berg": GROUP_BEDROCK,
}

#: The one soil class the *surface* layer contributes: peat over mineral ground.
SURFACE_PEAT_CLASS = "Torv"

#: PLAN.md §2.2 / §4.7: registered graves and settlements are the cultivation
#: proxy. `lamningstyp` verbatim, a subset of `fetch_sites.SELECTED_TYPES`.
SETTLEMENT_TYPES = frozenset(
    {
        "Gravfält",
        "Grav- och boplatsområde",
        "Boplats",
        "Boplatsområde",
        "Boplatslämning övrig",
    }
)

#: The remains whose *footprint* was occupied, built-on or tended ground in the
#: reference era and is therefore modelled as kept clear of trees: the fort
#: itself on top of the settlement proxies above. Runristningar and färdvägar
#: are deliberately absent — a runestone or a road does not clear a wood.
MONUMENT_TYPES = SETTLEMENT_TYPES | {"Fornborg"}


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

    #: Wetland band above the modelled water line: ground the sea reaches within
    #: this much of the reference level is shore fen, not dry land.
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
    #: How far beyond a registered monument footprint (fornborg extent, grave
    #: field, settlement remain) the ground is modelled as kept clear of trees.
    monument_clear_m: float = 20.0
    #: Ground steeper than this is not ploughed.
    farmland_max_slope_deg: float = 5.0
    #: Till steeper than this reads as rocky hillside rather than broadleaf wood.
    forest_max_slope_deg: float = 12.0


DEFAULT_PARAMS = LandcoverParams()


@dataclass(frozen=True)
class LandcoverClass:
    """One legend row (contract §10). `index` is the raw value in the raster."""

    index: int
    id: str
    name: str
    color: str
    rule: str
    vegetation: dict | None

    def as_json(self, area_fraction: float) -> dict:
        return {
            "index": self.index,
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "rule": self.rule,
            "vegetation": dict(self.vegetation) if self.vegetation else None,
            "areaFraction": round(float(area_fraction), 4),
        }


#: Rule text templates. Each one is an honest statement of the corresponding
#: branch in `classify()` — if a branch changes, its template changes with it.
_RULES = (
    (
        "water",
        "Water (sea, ~{year} CE)",
        "#2d5a6b",
        None,
        "Sea-connected at the modelled {year} CE water level: the priority-flood "
        "connectivity grid (water_connect.tif, contract §7) is at or below "
        "{level:.1f} m RH 2000 — or SGU maps the present ground as 'Vatten'. Applied "
        "first, so every later rule sees only what this one leaves.",
    ),
    (
        "reed_marsh",
        "Reed marsh / shore fen",
        "#77875a",
        # One clump per ~20 m². Chosen with the other two so a full-extent sample
        # stays inside the app's global instance budget instead of tripping its
        # proportional down-scaling on the very first site.
        {"type": "reeds", "densityPerHa": 500},
        "Not water, and either SGU's ground layer maps peat or gyttja (Kärrtorv, "
        "Mosstorv, Torv, Gyttja), or its surface layer maps a peat veneer over "
        "another soil, or the ground lies within {band:.1f} m above the {year} CE "
        "water line. The shore band is a modelling choice, not a mapped feature.",
    ),
    (
        "farmland",
        "Open farmland",
        "#d1b96e",
        None,
        "Not water, marsh or settled ground, and all four of: SGU maps a postglacial "
        "fine sediment "
        "(Postglacial lera, Gyttjelera (eller lergyttja), Svämsediment, ler--silt, "
        "Postglacial sand) or the margin of a till unit within {margin:.0f} m of one; "
        "the ground stands more than {fresh:.1f} m above the {year} CE water line "
        "(seabed drained more recently than that is too wet to plough); the slope is "
        "under {farm_slope:.0f}°; and a registered grave or settlement site "
        "(Gravfält, Grav- och boplatsområde, Boplats, Boplatsområde, Boplatslämning "
        "övrig) lies within {radius:.0f} m. Proximity to burial and settlement "
        "remains is the only cultivation proxy used — no Iron Age field system is "
        "mapped here.",
    ),
    (
        "wet_meadow",
        "Wet meadow / open pasture",
        "#a9c07a",
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
        "Isälvssediment (glaciofluvial sand and gravel) and Klapper (boulder beach "
        "gravel) — the well-drained esker and beach deposits that carry the dry "
        "routes across an otherwise wet valley floor.",
    ),
    (
        "broadleaf_forest",
        "Broadleaf forest",
        "#4f7a3a",
        {"type": "broadleaf", "densityPerHa": 90},
        "The remaining till (Sandig morän and the other morän classes) on ground no "
        "steeper than {forest_slope:.0f}°.",
    ),
    (
        "conifer_forest",
        "Conifer forest / rocky ground",
        "#2f5233",
        {"type": "conifer", "densityPerHa": 120},
        "Everything the rules above leave: exposed bedrock (Urberg), any ground "
        "steeper than {forest_slope:.0f}°, and any SGU class this rule table does "
        "not name.",
    ),
    (
        "settlement_cleared",
        "Settled ground (kept clear)",
        "#b08d6e",
        None,
        "Within {clear:.0f} m of the registered footprint of an occupied remain in "
        "sites.json — the fornborg extent itself and the grave and settlement "
        "records (Fornborg, Gravfält, Grav- och boplatsområde, Boplats, "
        "Boplatsområde, Boplatslämning övrig) — and not already water or marsh. "
        "Applied before the farmland rule, so occupied ground is neither ploughed "
        "nor reforested: a fort interior or grave field in use is modelled as "
        "trampled, grazed and deliberately kept open. The KMR extent is a "
        "registration boundary, not an excavated plan, and the {clear:.0f} m "
        "margin is a modelling choice, not a mapped feature.",
    ),
)


def landcover_classes(
    reference_level_m: float,
    params: LandcoverParams = DEFAULT_PARAMS,
    reference_year_ce: int = REFERENCE_YEAR_CE,
) -> tuple[LandcoverClass, ...]:
    """The taxonomy with its names and rule text filled in from the thresholds used."""
    fields = {
        "year": reference_year_ce,
        "level": reference_level_m,
        "band": params.shore_band_m,
        "fresh": params.fresh_land_m,
        "margin": params.till_margin_m,
        "radius": params.farmland_radius_m,
        "clear": params.monument_clear_m,
        "farm_slope": params.farmland_max_slope_deg,
        "forest_slope": params.forest_max_slope_deg,
    }
    return tuple(
        LandcoverClass(
            index=index,
            id=class_id,
            name=name.format(**fields),
            color=color,
            rule=rule.format(**fields),
            vegetation=vegetation,
        )
        for index, (class_id, name, color, vegetation, rule) in enumerate(_RULES)
    )


CLASS_WATER = 0
CLASS_MARSH = 1
CLASS_FARMLAND = 2
CLASS_MEADOW = 3
CLASS_DRY_CORRIDOR = 4
CLASS_BROADLEAF = 5
CLASS_CONIFER = 6
#: Appended in v1.2.1 so the six original raster values kept their meaning;
#: `classify()` applies it third (after water and marsh), not last.
CLASS_CLEARED = 7


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
    """Cells occupied by a registered grave/settlement site. Returns (mask, records).

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
    connect_m: np.ndarray,
    soil_group: np.ndarray,
    peat_surface: np.ndarray,
    slope_deg: np.ndarray,
    settlement_distance_m: np.ndarray,
    monument_distance_m: np.ndarray,
    reference_level_m: float,
    cell_size_m: float,
    params: LandcoverParams = DEFAULT_PARAMS,
) -> np.ndarray:
    """Land-cover class index per cell. Pure array function — the whole rule engine.

    Precedence is explicit and one-directional: each rule writes only where no
    earlier rule has claimed the cell, in the order water -> wetland -> occupied
    footprints -> farmland -> the rest. The rule strings in `_RULES` state the
    same order in prose, and the app renders them verbatim, so a change here is a
    change there.
    """
    shapes = {a.shape for a in (connect_m, soil_group, peat_surface, slope_deg)}
    if len(shapes) != 1:
        raise LandcoverError(f"rule inputs disagree on shape: {sorted(shapes)}")
    if settlement_distance_m.shape != connect_m.shape:
        raise LandcoverError(
            f"settlement distance grid is {settlement_distance_m.shape}, "
            f"expected {connect_m.shape}"
        )
    if monument_distance_m.shape != connect_m.shape:
        raise LandcoverError(
            f"monument distance grid is {monument_distance_m.shape}, "
            f"expected {connect_m.shape}"
        )

    # 1. water — sea-connected at the reference level, or mapped as water today.
    wet = connect_m <= reference_level_m + LEVEL_EPSILON
    classes = np.where(
        wet | (soil_group == GROUP_WATER), CLASS_WATER, CLASS_CONIFER
    ).astype(np.uint8)
    taken = classes == CLASS_WATER

    # 2. wetland — peat/gyttja ground, a peat veneer, or the shore band above the line.
    shore_band = connect_m <= reference_level_m + params.shore_band_m + LEVEL_EPSILON
    marsh = ~taken & ((soil_group == GROUP_PEAT) | peat_surface | shore_band)
    classes[marsh] = CLASS_MARSH
    taken |= marsh

    # 3. settled ground — the registered footprint of the era's occupied remains
    #    (fornborg extent, grave fields, settlement remains) plus a small margin.
    #    Occupied ground is kept clear of trees, and — coming before the farmland
    #    rule — it is not ploughed either: a grave field is not a field.
    cleared = ~taken & (monument_distance_m <= params.monument_clear_m)
    classes[cleared] = CLASS_CLEARED
    taken |= cleared

    # 4. farmland — cultivable soil, long enough out of the sea, gentle ground,
    #    close to a settlement proxy. "Till margins" is taken literally: only the
    #    fringe of a till unit that abuts a fine sediment counts, not the whole
    #    moraine, which would put half the uplands under the plough.
    fine = soil_group == GROUP_FINE
    to_fine = distance_meters(fine, cell_size_m)
    till_margin = (soil_group == GROUP_TILL) & (to_fine <= params.till_margin_m)
    farmland = (
        ~taken
        & (fine | till_margin)
        & (connect_m > reference_level_m + params.fresh_land_m - LEVEL_EPSILON)
        & (slope_deg <= params.farmland_max_slope_deg)
        & (settlement_distance_m <= params.farmland_radius_m)
    )
    classes[farmland] = CLASS_FARMLAND
    taken |= farmland

    # 5. wet meadow / open pasture — the remaining fine-grained ground.
    meadow = ~taken & ((soil_group == GROUP_FINE) | (soil_group == GROUP_CLAY))
    classes[meadow] = CLASS_MEADOW
    taken |= meadow

    # 6. dry open corridor — esker and beach gravels.
    corridor = ~taken & (soil_group == GROUP_GRAVEL)
    classes[corridor] = CLASS_DRY_CORRIDOR
    taken |= corridor

    # 7. broadleaf forest — remaining till on gentle to moderate ground.
    broadleaf = ~taken & (soil_group == GROUP_TILL) & (slope_deg <= params.forest_max_slope_deg)
    classes[broadleaf] = CLASS_BROADLEAF

    # 8. conifer forest / rocky ground — the initial fill; everything still unclaimed.
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
    "for {year} CE, by a rule engine reading five inputs: the sea-connectivity grid "
    "(water_connect.tif) against the {year} CE water level of {level:.1f} m RH 2000 "
    "interpolated from shoreline.json; the SGU Jordarter polygons ({collections}) rasterized "
    "onto the same grid, with any cell no polygon covered ({coverage:.1f} % of the extent "
    "here) taking its nearest neighbour's class and the surface layer's peat veneer carried "
    "as a separate flag; slope in degrees from the committed LiDAR DEM (np.gradient); "
    "the Euclidean distance to the nearest of the {proxies} registered grave or settlement "
    "records in sites.json, used as the cultivation proxy; and the distance to the "
    "registered footprints of the era's occupied remains (the fornborg extent plus those "
    "same grave and settlement records), whose ground is modelled as kept clear of trees. "
    "The rules are applied in a fixed precedence — water first, then wetland, then the "
    "occupied footprints, then farmland, then the drier classes — and each class's rule "
    "text below states its own branch verbatim. SGU maps the present-day "
    "soil surface; treating it as the ground of {year} CE is the model's central assumption. "
    "The raster answers only 'what might this landscape have looked like around {year} CE?'."
)

CALIBRATION = (
    "Measured on this raster: {forest:.1f} % forest ({broadleaf:.1f} % broadleaf, "
    "{conifer:.1f} % conifer), {open_land:.1f} % open ground ({farmland:.1f} % farmland, "
    "{meadow:.1f} % wet meadow/pasture, {corridor:.1f} % dry gravel corridor, "
    "{cleared:.1f} % settled ground kept clear), "
    "{marsh:.1f} % reed marsh and {water:.1f} % open water at the {year} CE level. Counting "
    "only dry land, the forest-to-open ratio is {forest_land:.0f}:{open_land_dry:.0f}. No "
    "quantified (REVEALS-type) openness figure for Iron Age Uppland has been found (PLAN.md "
    "§2.5 records this as open), so there is no local number to calibrate against and none "
    "has been fitted. The nearest published benchmark — Hultberg et al. (2019), REVEALS "
    "openness of 90–97 % for agrarian Scania — is cited as methodological context only: it "
    "describes a different region and a later, far more intensively cleared agrarian "
    "landscape, and this model does not aim at it. The pollen records that do cover this "
    "valley (Karlsson 1999 for the Arlanda–Knivsta area; the Stockholm University thesis on "
    "shore displacement and paleoenvironment along Långhundraleden) are qualitative here: "
    "they describe an Iron Age landscape opening around settlement and waterway while forest "
    "persisted on till and bedrock, which is the pattern this classification reproduces. The "
    "ratio is reported, not force-fitted (PLAN.md §4.7)."
)


def method_text(
    cfg: SiteConfig,
    reference_level_m: float,
    collections: Sequence[str],
    coverage: float,
    proxies: int,
    reference_year_ce: int = REFERENCE_YEAR_CE,
) -> str:
    """The one-paragraph derivation description the app shows verbatim (contract §10)."""
    return METHOD.format(
        extent=2.0 * cfg.context.half_extent / 1000.0,
        year=reference_year_ce,
        level=reference_level_m,
        collections=", ".join(collections) or "n/a",
        coverage=100.0 * (1.0 - coverage),
        proxies=proxies,
    )


def calibration_text(
    fractions: Sequence[float], reference_year_ce: int = REFERENCE_YEAR_CE
) -> str:
    """The forest/open comparison against the PLAN.md §2.5 anchors (contract §10)."""
    percent = [100.0 * f for f in fractions]
    forest = percent[CLASS_BROADLEAF] + percent[CLASS_CONIFER]
    open_land = (
        percent[CLASS_FARMLAND]
        + percent[CLASS_MEADOW]
        + percent[CLASS_DRY_CORRIDOR]
        + percent[CLASS_CLEARED]
    )
    dry = forest + open_land
    return CALIBRATION.format(
        year=reference_year_ce,
        forest=forest,
        broadleaf=percent[CLASS_BROADLEAF],
        conifer=percent[CLASS_CONIFER],
        open_land=open_land,
        farmland=percent[CLASS_FARMLAND],
        meadow=percent[CLASS_MEADOW],
        corridor=percent[CLASS_DRY_CORRIDOR],
        cleared=percent[CLASS_CLEARED],
        marsh=percent[CLASS_MARSH],
        water=percent[CLASS_WATER],
        forest_land=round(100.0 * forest / dry) if dry else 0,
        open_land_dry=round(100.0 * open_land / dry) if dry else 0,
    )


def build_legend(
    cfg: SiteConfig,
    classes: Sequence[LandcoverClass],
    fractions: Sequence[float],
    reference_level_m: float,
    soils_meta: dict,
    coverage: float,
    proxies: int,
    reference_year_ce: int = REFERENCE_YEAR_CE,
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
        "referenceLevelM": round(float(reference_level_m), 1),
        "method": method_text(
            cfg,
            reference_level_m,
            soils_meta.get("collections", []),
            coverage,
            proxies,
            reference_year_ce,
        ),
        "caveat": CAVEAT,
        "calibration": calibration_text(fractions, reference_year_ce),
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


def load_inputs(cfg: SiteConfig) -> tuple[np.ndarray, np.ndarray, Affine, float, dict]:
    """Read every committed input the rules need. Returns (heights, connect, transform, level, sites)."""
    build_cmd = f"python3 -m fornborg_pipeline.build --site {cfg.id}"
    water_cmd = f"python3 -m fornborg_pipeline.water --site {cfg.id}"
    sites_cmd = f"python3 -m fornborg_pipeline.fetch_sites --site {cfg.id}"

    context_path = _require(cfg.out_dir / cfg.context.path, build_cmd)
    connect_path = _require(cfg.out_dir / WATER_CONNECT_PATH, water_cmd)
    shoreline_path = _require(cfg.out_dir / SHORELINE_PATH, water_cmd)
    sites_path = _require(cfg.out_dir / SITES_PATH, sites_cmd)
    _require(cfg.out_dir / "manifest.json", build_cmd)

    dem_dm, transform, _bounds = read_grid(context_path)
    connect_dm, connect_transform, _ = read_grid(connect_path)
    if connect_dm.shape != dem_dm.shape or connect_transform != transform:
        raise LandcoverError(
            f"{connect_path.name} does not share {context_path.name}'s geometry — re-run "
            f"`{water_cmd}`."
        )

    table = json.loads(shoreline_path.read_text(encoding="utf-8"))
    level = round(float(interpolate_level(table["steps"], REFERENCE_YEAR_CE)), 1)
    sites_document = json.loads(sites_path.read_text(encoding="utf-8"))
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
    print(
        f"-- context grid: {shape[1]}x{shape[0]} @ {cfg.context.resolution} m | "
        f"z {heights_m.min():.1f}..{heights_m.max():.1f} m RH 2000 | "
        f"{REFERENCE_YEAR_CE} CE water level {level:.1f} m RH 2000"
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

    print("-- classification")
    slope = slope_degrees(heights_m, float(cfg.context.resolution))
    classes = classify(
        connect_m,
        soil_group,
        peat_surface,
        slope,
        distance,
        monument_distance,
        level,
        float(cfg.context.resolution),
        params,
    )
    taxonomy = landcover_classes(level, params)
    fractions = area_fractions(classes, len(taxonomy))

    print(f"  {'class':<28} {'cells':>10} {'%':>7}")
    for entry, fraction in zip(taxonomy, fractions):
        print(f"  {entry.name:<28} {int(round(fraction * classes.size)):>10,} {100.0 * fraction:>6.2f}")
    forest = fractions[CLASS_BROADLEAF] + fractions[CLASS_CONIFER]
    open_land = (
        fractions[CLASS_FARMLAND]
        + fractions[CLASS_MEADOW]
        + fractions[CLASS_DRY_CORRIDOR]
        + fractions[CLASS_CLEARED]
    )
    dry = forest + open_land
    print(
        f"  forest {100.0 * forest:.1f} % vs open {100.0 * open_land:.1f} % "
        f"(dry land only: {100.0 * forest / dry:.0f}:{100.0 * open_land / dry:.0f})"
    )

    path = write_class_grid(cfg.out_dir / LANDCOVER_PATH, classes, transform)
    print(f"  wrote {path} ({path.stat().st_size / 1e3:.1f} kB)")
    _check_context_profile(cfg.out_dir / cfg.context.path, path)

    legend = build_legend(
        cfg, taxonomy, fractions, level, soils_meta, coverage, proxy_records
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
def cli(
    site_id: str,
    force_download: bool,
    farmland_radius: float,
    forest_slope: float,
    monument_clear: float,
) -> None:
    """Derive landcover.tif + landcover_legend.json and patch the site manifest."""
    params = replace(
        DEFAULT_PARAMS,
        farmland_radius_m=float(farmland_radius),
        forest_max_slope_deg=float(forest_slope),
        monument_clear_m=float(monument_clear),
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
