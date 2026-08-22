"""Far-field land cover for the §11 ring ladder (contract v1.6 §13, docs/far-field-vegetation.md).

    python3 -m fornborg_pipeline.far_landcover --site broborg

One class raster per shipped ring — `landcover_ring<N>.tif`, uint8 indices on that
ring's exact §11 geometry — plus the optional `farField` block in
`landcover_legend.json` and the `landcover` key on each ring's manifest entry.

**This engine is deliberately cruder than the §9 one, and every disclosed string
here says so.** The near-field rules read seven inputs; five of them (SGU
jordarter, KMR evidence distances, road lines, monument footprints, cultivation
records) are either unavailable or sub-pixel at ring scale — fetching soils for a
64×64 km box is ~256× the context fetch per site, and an 8 m road corridor is
invisible past ~4 km (docs/far-field-vegetation.md §4). So the far field reads two
things and nothing else: the ring DEM's elevation, and slope derived from it.

  1. **elevation** — `≤ 0.05 m` is sea: at ring scale that is the modern Baltic
     plus the cells the ring build filled at 0 m outside the source tile set (§11's
     coverage seam). It is a threshold on a modern DEM, not a mapped shoreline, and
     never the Iron Age sea — that stays a function of the §7 connect grid and the
     slider (§13's rendering contract);
  2. **slope** — below 0.05° above sea level is standing water (LiDAR DEMs are
     TIN-flat over lakes), above `forest_max_slope_deg` — the same 12° the §9
     engine uses, imported from `landcover.DEFAULT_PARAMS` rather than restated —
     is steep rock and sparse ground;
  3. what is left is split between open ground and forest by a **patch mosaic**
     whose open/forest ratio is *the site's own §9 context ratio*, so the far field
     statistically continues the near field instead of asserting independent
     knowledge (docs/far-field-vegetation.md §4). The mosaic is a hash of the 256 m
     **world** patch a cell falls in — floor(E/256), floor(N/256) in EPSG:3006,
     never the raster's row and column. Rings overlap (ring4 covers all of ring3),
     so a grid-anchored noise field would repaint the same ground differently at
     each resolution and the tint would pop at every ring seam.

The forest identity comes from the site's vegetation zone: in the southern boreal
zone all far forest is conifer (docs/vegetation-zones.md §4). Everything this
raster feeds is rendering — ground tint and the 2–8 km billboard band. No analysis
reads it: the viewshed, the water logic and the §9 raster are untouched.
"""

from __future__ import annotations

import json
import re
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path

import click
import numpy as np
from affine import Affine
from scipy import ndimage

from .clip_dem import dequantize, dequantize_decimeters, read_grid, write_class_grid
from .landcover import (
    DEFAULT_PARAMS,
    LandcoverError,
    _check_context_profile,
    slope_degrees,
    write_legend,
)
from .manifest import attach_ring_landcover, validate_manifest, write_manifest
from .sites import SITES, SiteConfig, get_site
from .zones import ZoneAssignment, assign_zone


class FarLandcoverError(RuntimeError):
    """A prerequisite is missing, or a written raster failed a §13 invariant."""


# --------------------------------------------------------------------------- #
# thresholds and the fixed class table (contract §13)
# --------------------------------------------------------------------------- #

#: Sea, and the §11 coverage seam's 0 m fill, in one threshold. Not 0.0 exactly:
#: the ring quantization lattice is 0.5 m or 1.0 m, so a cell written as sea comes
#: back as 0.0 m, and a hair of tolerance costs nothing while a strict `== 0`
#: would depend on float equality.
SEA_MAX_M = 0.05
#: Below this a patch of ring DEM is flat to the limit of the TIN that produced it.
#: The mire/lake proxy — the weakest rule here, and its rule string says so.
FLAT_MAX_SLOPE_DEG = 0.05
#: Flatness alone is not water at ring quantization: a 0.5 m step turns the alvar
#: pavement and the Närke clay plain into vast exactly-level patches (measured
#: 2026-08-22 — a bare flatness test called 60 % of Eketorp's ring3 "lake"). A
#: real lake surface is one *connected* component at one *exact* elevation, and
#: it is big: across the Eketorp, Tarsta berg and Träleborg rings, no non-lake
#: component reached 200 ha at 0.5 m quantization while Kvismaren, Hjälmaren and
#: Vänern exceed it by one to three orders of magnitude. At 1.0 m quantization
#: (rings 6–7) plains blow past any threshold and the test cannot be saved, so
#: it is not applied there — a disclosed limitation, not a silent one.
LAKE_MIN_COMPONENT_HA = 200.0
LAKE_MAX_QUANT_SCALE_M = 0.5
#: Steep rock: the *same* threshold the §9 engine uses to stop growing forest, taken
#: from its parameter set rather than copied, so tuning one tunes both.
ROCK_MIN_SLOPE_DEG = DEFAULT_PARAMS.forest_max_slope_deg
#: Side of the mosaic patch, in meters of EPSG:3006. Inside
#: docs/far-field-vegetation.md §4's 100–300 m band, and a power of two so the
#: patch index is exact in float arithmetic at every ring resolution.
PATCH_SIZE_M = 256.0
#: Stems per hectare the app samples billboards at, against the near field's
#: 90–120 (docs/far-field-vegetation.md §1). Quoted in the disclosure, not tuned.
BILLBOARD_DENSITY_PER_HA = 10
NEAR_FIELD_DENSITY_TEXT = "90–120"

FAR_CLASS_SEA = 0
FAR_CLASS_WATER_FLAT = 1
FAR_CLASS_OPEN = 2
FAR_CLASS_BROADLEAF = 3
FAR_CLASS_CONIFER = 4
FAR_CLASS_ROCK = 5

#: The §9 class ids whose ground is open at 8 km, used to derive the mosaic ratio
#: from the site's own context legend. The peat fen is in the list on purpose: a
#: mire is open land at this distance, whatever it is underfoot, and the rule text
#: says so rather than letting the number carry the decision silently.
CONTEXT_OPEN_IDS = (
    "farmland",
    "wet_meadow",
    "dry_corridor",
    "settlement_cleared",
    "alvar",
    "wooded_pasture",
    "peat_fen",
)
CONTEXT_WATER_ID = "water"
CONTEXT_BROADLEAF_ID = "broadleaf_forest"
CONTEXT_CONIFER_ID = "conifer_forest"
#: Both forest classes empty (an all-open or all-water context): the split has
#: nothing to inherit, so it is an even one and the legend quotes 50 %.
BROADLEAF_SHARE_FALLBACK = 0.5


@dataclass(frozen=True)
class FarClass:
    """One `farField.classes[]` row (contract §13). `index` is the raster value."""

    index: int
    id: str
    name: str
    color: str
    rule: str
    #: Optional `{"type", "densityPerHa"}`; the app draws one quad per sampled
    #: instance of a class that carries it. §13 forbids `areaFraction` (the
    #: rasters vary per ring) and `dynamic` (the far field is fully static).
    billboard: dict | None = None

    def as_json(self) -> dict:
        entry = {
            "index": self.index,
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "rule": self.rule,
        }
        if self.billboard:
            entry["billboard"] = dict(self.billboard)
        return entry


#: Fixed class set, in raster-index order: (id, name, color, billboard, rule).
#: Each rule string is a verbatim statement of the corresponding branch of
#: `classify_far()` with the thresholds actually used formatted in — the app
#: renders them in the methods panel and must never paraphrase a method it did
#: not run, exactly as for `landcover._RULES`.
_FAR_RULES = (
    (
        "sea",
        "Open sea (modern)",
        "#2d4a5b",
        None,
        "Ring DEM elevation at or below {sea:.2f} m. At ring resolution that is the "
        "modern Baltic together with the cells the ring build filled at 0 m where the "
        "Lantmäteriet tile set does not reach (contract §11's coverage seam), and the "
        "two are not distinguished here. This is an elevation threshold on a modern "
        "DEM, not a mapped shoreline: the modelled Iron Age sea is an exact function "
        "of the sea-connectivity grid and the level on the slider (contract §7/§11), "
        "and is never baked into this raster.",
    ),
    (
        "water_flat",
        "Lakes and still water",
        "#2d5a6b",
        None,
        "Not sea, and a level surface only water explains: a connected patch of at "
        "least {lake_ha:.0f} ha lying at one exact elevation with slope below "
        "{flat:.2f}°. The national DEM is TIN-interpolated from ground-classified "
        "LiDAR, which returns nothing from a water surface, so a lake comes through "
        "exactly level — while flat land varies by at least the ring's quantization "
        "step, and measured across three pilot regions no non-lake patch reached "
        "{lake_ha:.0f} ha where lakes of Hjälmaren's and Vänern's scale exceed it "
        "many times over. Two disclosed limits: smaller lakes and ponds cannot be "
        "told from level ground at ring resolution and read as open land, and the "
        "outermost rings (1.0 m quantization) cannot support the test at all, so "
        "no lake is detected there. A proxy for ground tint only, never analysis.",
    ),
    (
        "open",
        "Open ground (meadow, field, fen — mosaic)",
        "#bfb377",
        None,
        "Everything the rules above leave, split from forest by a patch mosaic: the "
        "world is divided into fixed {patch:.0f} m squares anchored to the EPSG:3006 "
        "coordinate grid — not to any ring's pixels, so the overlapping rings classify "
        "the same ground the same way — and each square is hashed with this site's "
        "seed to one value in [0, 1). A square is open ground where that value falls "
        "below {open_pct:.0f} %, this site's own measured open-land share of its §9 "
        "context raster (farmland, wet meadow, dry gravel corridor, settled ground "
        "kept clear, alvar limestone heath, wooded pasture and peat fen, counted over "
        "land cells only). The fen is counted as open ground out here because at these "
        "distances a mire reads as open land rather than as woodland. The mosaic "
        "statistically continues the near field; no evidence says that any particular "
        "square was open.",
    ),
    (
        "forest_broadleaf",
        "Broadleaf forest",
        "#4f7a3a",
        {"type": "broadleaf", "densityPerHa": BILLBOARD_DENSITY_PER_HA},
        "A mosaic square the rule above did not make open, whose second, independent "
        "hash channel falls below {broadleaf_pct:.0f} % — the broadleaf share of the "
        "closed forest in this site's own §9 context raster. Nothing beyond that "
        "measured share distinguishes this square from a conifer one.{boreal_note}",
    ),
    (
        "forest_conifer",
        "Conifer forest",
        "#2f5233",
        {"type": "conifer", "densityPerHa": BILLBOARD_DENSITY_PER_HA},
        "The forest squares the broadleaf rule leaves — {conifer_pct:.0f} % of the far "
        "field's forest here, mirroring the conifer share of this site's own §9 "
        "context raster.{boreal_note}",
    ),
    (
        "rock_sparse",
        "Steep rock and sparse ground",
        "#75775f",
        None,
        "Slope above {rock:.0f}°, measured on the ring DEM with np.gradient at the "
        "ring's own resolution. That is the same threshold the near-field §9 engine "
        "uses to stop growing forest, so a hillside that reads as rocky ground at 2 m "
        "does not become forest at {resolution:.0f} m. Ground this steep is modelled "
        "as rock and sparse cover rather than closed wood.",
    ),
)

#: Appended to both forest rules where the zone is southern boreal: same ground,
#: same mosaic, one measured identity (docs/vegetation-zones.md §4).
_BOREAL_FOREST_NOTE = (
    " In the southern boreal zone this split does not run at all: the pollen record "
    "for ~500 CE shows conifer-dominated forest there (docs/vegetation-zones.md §4), "
    "so every far-field forest square renders as conifer and the broadleaf class "
    "holds no cells."
)


def far_field_classes(
    open_fraction: float,
    broadleaf_share: float,
    zone: ZoneAssignment | None,
    resolution_m: float,
) -> tuple[FarClass, ...]:
    """The §13 taxonomy with its rule text filled in from the thresholds used.

    `resolution_m` is quoted for scale in two rules and is the *finest* ring's
    resolution — the legend block is one per site, not one per ring, so the number
    it quotes is the sharpest look the far field ever gets.
    """
    boreal = zone is not None and zone.zone == "s_boreal"
    effective_broadleaf = 0.0 if boreal else float(broadleaf_share)
    fields = {
        "sea": SEA_MAX_M,
        "flat": FLAT_MAX_SLOPE_DEG,
        "lake_ha": LAKE_MIN_COMPONENT_HA,
        "rock": ROCK_MIN_SLOPE_DEG,
        "patch": PATCH_SIZE_M,
        "resolution": float(resolution_m),
        "open_pct": 100.0 * float(open_fraction),
        "broadleaf_pct": 100.0 * effective_broadleaf,
        "conifer_pct": 100.0 * (1.0 - effective_broadleaf),
        "boreal_note": _BOREAL_FOREST_NOTE if boreal else "",
    }
    return tuple(
        FarClass(
            index=index,
            id=class_id,
            name=name,
            color=color,
            rule=rule.format(**fields),
            billboard=dict(billboard) if billboard else None,
        )
        for index, (class_id, name, color, billboard, rule) in enumerate(_FAR_RULES)
    )


# --------------------------------------------------------------------------- #
# the patch mosaic — a pure function of world coordinates
# --------------------------------------------------------------------------- #

#: A splitmix64 finalizer in numpy uint64 arithmetic. Deliberately *not* Python's
#: `hash()` (randomized per process, so a rebuild would repaint the landscape) and
#: not `np.random` (global state, and no way to key it on a coordinate). uint64
#: multiplication wraps mod 2^64 in numpy, which is exactly the mixing this needs.
_MIX_ADD = np.uint64(0x9E3779B97F4A7C15)
_MIX_1 = np.uint64(0xBF58476D1CE4E5B9)
_MIX_2 = np.uint64(0x94D049BB133111EB)
#: Odd multipliers keeping the two patch axes from cancelling each other out.
_PATCH_E_ODD = np.uint64(0x27D4EB2F165667C5)
_PATCH_N_ODD = np.uint64(0xD6E8FEB86659FD93)
#: What separates the open/forest channel (0) from the broadleaf/conifer one (1):
#: the same patch must not decide both questions with one draw.
_CHANNEL_STRIDE = np.uint64(0x8EBC6AF09C88C6E3)
#: 2^-53 — the 53 top bits of the mixed word, as IEEE doubles do it.
_TWO_POW_53 = float(1 << 53)


def _splitmix64(key: np.ndarray) -> np.ndarray:
    # Wraparound mod 2^64 *is* the mixing here, so the overflow numpy would warn
    # about on a scalar input is the intended arithmetic, not a lost carry.
    with np.errstate(over="ignore"):
        x = np.asarray(key, dtype=np.uint64) + _MIX_ADD
        x = (x ^ (x >> np.uint64(30))) * _MIX_1
        x = (x ^ (x >> np.uint64(27))) * _MIX_2
        return x ^ (x >> np.uint64(31))


def patch_uniform(
    easting: np.ndarray, northing: np.ndarray, seed: int, channel: int = 0
) -> np.ndarray:
    """Uniform [0, 1) for the 256 m **world** patch each coordinate falls in.

    A pure function of EPSG:3006 easting/northing and the site seed: the same ground
    hashes to the same value at every ring resolution, on every machine, in every
    process. That is the whole point — rings overlap, and a mosaic keyed on raster
    rows and columns would give the same hillside a different class in ring3 and
    ring4 and put a visible seam where the two meet.

    `channel` picks an independent draw for the same patch (0 = open vs forest,
    1 = broadleaf vs conifer).
    """
    patch_e = np.floor(np.asarray(easting, dtype=np.float64) / PATCH_SIZE_M).astype(np.int64)
    patch_n = np.floor(np.asarray(northing, dtype=np.float64) / PATCH_SIZE_M).astype(np.int64)
    with np.errstate(over="ignore"):  # see `_splitmix64`: the wrap is the point
        key = (
            (patch_e.astype(np.uint64) * _PATCH_E_ODD)
            ^ (patch_n.astype(np.uint64) * _PATCH_N_ODD)
            ^ (np.uint64(int(seed) & 0xFFFFFFFFFFFFFFFF) + _CHANNEL_STRIDE * np.uint64(channel))
        )
    return (_splitmix64(key) >> np.uint64(11)).astype(np.float64) / _TWO_POW_53


def _patch_field(
    shape: tuple[int, int], transform: Affine, seed: int, channel: int
) -> np.ndarray:
    """`patch_uniform` evaluated per cell of a north-up grid, via the patch table.

    Hashing 4 million cells directly would work and give the same answer; hashing
    the few thousand *patches* the grid touches and expanding is the same function
    evaluated where it actually varies.
    """
    cols = transform.c + (np.arange(shape[1], dtype=np.float64) + 0.5) * transform.a
    rows = transform.f + (np.arange(shape[0], dtype=np.float64) + 0.5) * transform.e
    patch_e = np.floor(cols / PATCH_SIZE_M).astype(np.int64)
    patch_n = np.floor(rows / PATCH_SIZE_M).astype(np.int64)

    unique_e = np.arange(patch_e.min(), patch_e.max() + 1, dtype=np.int64)
    unique_n = np.arange(patch_n.min(), patch_n.max() + 1, dtype=np.int64)
    # Patch centers, so `patch_uniform`'s own floor lands back on this index pair.
    table = patch_uniform(
        (unique_e[None, :] + 0.5) * PATCH_SIZE_M,
        (unique_n[:, None] + 0.5) * PATCH_SIZE_M,
        seed,
        channel,
    )
    return table[np.ix_(patch_n - unique_n[0], patch_e - unique_e[0])]


# --------------------------------------------------------------------------- #
# the far rule engine
# --------------------------------------------------------------------------- #


def classify_far(
    heights_m: np.ndarray,
    slope_deg: np.ndarray,
    transform: Affine,
    open_fraction: float,
    broadleaf_share: float,
    zone: ZoneAssignment | None,
    seed: int,
    resolution_m: float = 4.0,
    quant_scale_m: float = 0.5,
) -> np.ndarray:
    """Far-field class index per ring cell. Pure array function — the whole engine.

    Precedence is explicit and one-directional, as in `landcover.classify()`:
    sea -> flat standing water -> steep rock -> the open/forest mosaic on
    everything left. `_FAR_RULES` states the same order in prose and the app
    renders those strings, so a change here is a change there.

    `open_fraction` and `broadleaf_share` come from the site's own §9 context
    legend (`context_mosaic_ratio`), and `transform` is what anchors the mosaic to
    the world rather than to this particular grid.
    """
    heights_m = np.asarray(heights_m)
    slope_deg = np.asarray(slope_deg)
    if heights_m.shape != slope_deg.shape:
        raise FarLandcoverError(
            f"elevation grid is {heights_m.shape} but slope is {slope_deg.shape}"
        )
    if heights_m.ndim != 2:
        raise FarLandcoverError(f"expected a 2D ring grid, got shape {heights_m.shape}")
    for label, value in (("open_fraction", open_fraction), ("broadleaf_share", broadleaf_share)):
        if not np.isfinite(value) or not (0.0 <= float(value) <= 1.0):
            raise FarLandcoverError(f"{label} must be a fraction in [0, 1], got {value!r}")

    # 1. sea — an elevation threshold, covering both the modern Baltic and the
    #    §11 coverage seam's 0 m fill. Never the modelled Iron Age sea.
    classes = np.full(heights_m.shape, FAR_CLASS_OPEN, dtype=np.uint8)
    sea = heights_m <= SEA_MAX_M
    classes[sea] = FAR_CLASS_SEA
    taken = sea

    # 2. still water — a level surface only water explains: TIN-flat above sea
    #    level, in one connected component at one exact quantized elevation, at
    #    least LAKE_MIN_COMPONENT_HA large. Bare flatness measured as a disaster
    #    (60 % of Eketorp's ring3 read as "lake" — the alvar pavement is exactly
    #    level at 0.5 m steps); the component test separates real lakes from
    #    level land at 0.5 m quantization and is honestly skipped at 1.0 m,
    #    where it cannot (see LAKE_MIN_COMPONENT_HA). Flat ground the test does
    #    not claim falls through to the mosaic like any other ground.
    flat = ~taken & (slope_deg < FLAT_MAX_SLOPE_DEG)
    if float(quant_scale_m) <= LAKE_MAX_QUANT_SCALE_M and flat.any():
        keys = np.round(heights_m / float(quant_scale_m)).astype(np.int64)
        min_cells = int(np.ceil(LAKE_MIN_COMPONENT_HA * 1e4 / (float(resolution_m) ** 2)))
        labels, count = ndimage.label(flat)
        if count:
            component_sizes = np.bincount(labels.ravel())
            for component in np.flatnonzero(component_sizes >= min_cells):
                if component == 0:
                    continue  # bincount slot 0 is the background, not a component
                mask = labels == component
                values = keys[mask]
                # One exact elevation across the whole component — the property
                # a water surface has and a large flat field does not.
                if values.max() == values.min():
                    classes[mask] = FAR_CLASS_WATER_FLAT
                    taken = taken | mask

    # 3. steep rock — the §9 forest slope threshold, imported not restated.
    rock = ~taken & (slope_deg > ROCK_MIN_SLOPE_DEG)
    classes[rock] = FAR_CLASS_ROCK
    taken = taken | rock

    # 4. the mosaic on everything left. Both draws are functions of the 256 m world
    #    patch, so ring3 and ring4 paint their shared ground identically.
    mosaic = ~taken
    if mosaic.any():
        open_draw = _patch_field(heights_m.shape, transform, seed, channel=0)
        forest = mosaic & (open_draw >= float(open_fraction))
        if zone is not None and zone.zone == "s_boreal":
            # docs/vegetation-zones.md §4: conifer-dominated till forest at 500 CE.
            classes[forest] = FAR_CLASS_CONIFER
        else:
            species_draw = _patch_field(heights_m.shape, transform, seed, channel=1)
            broadleaf = forest & (species_draw < float(broadleaf_share))
            classes[forest] = FAR_CLASS_CONIFER
            classes[broadleaf] = FAR_CLASS_BROADLEAF

    return classes


# --------------------------------------------------------------------------- #
# the site's own context ratio (docs/far-field-vegetation.md §4, input 4)
# --------------------------------------------------------------------------- #


def context_mosaic_ratio(legend: dict) -> tuple[float, float]:
    """(open_fraction, broadleaf_share) measured on the site's §9/§10 legend.

    Classes are identified by their `id` strings, never by index: §10 has appended
    classes twice already, and an index read would silently shift with the next one.

    Both figures are shares of **land**: a coastal site whose context extent is half
    water must not get half-water far hills out of it (docs/far-field-vegetation.md
    §8). Water here is the §10 `water` class — modern SGU-mapped lakes and
    watercourses — since the modelled sea is dynamic and holds no raster cells.
    """
    fractions = {
        entry.get("id"): float(entry.get("areaFraction") or 0.0)
        for entry in legend.get("classes", [])
    }
    if not fractions:
        raise FarLandcoverError(
            "landcover_legend.json declares no classes — the §9/§10 near-field pair must "
            "be rebuilt before the far field can inherit its ratio"
        )
    land = 1.0 - fractions.get(CONTEXT_WATER_ID, 0.0)
    if land <= 0.0:
        raise FarLandcoverError(
            "the context raster is entirely mapped water, so it carries no land ratio for "
            "the far-field mosaic to continue (contract §13)"
        )
    open_fraction = sum(fractions.get(name, 0.0) for name in CONTEXT_OPEN_IDS) / land
    forest = fractions.get(CONTEXT_BROADLEAF_ID, 0.0) + fractions.get(CONTEXT_CONIFER_ID, 0.0)
    broadleaf_share = (
        fractions.get(CONTEXT_BROADLEAF_ID, 0.0) / forest
        if forest > 0.0
        else BROADLEAF_SHARE_FALLBACK
    )
    return float(np.clip(open_fraction, 0.0, 1.0)), float(np.clip(broadleaf_share, 0.0, 1.0))


def site_seed(site_id: str) -> int:
    """The mosaic seed: CRC-32 of the site id.

    Derived from the id rather than drawn, so the same site gets the same far field
    from every build on every machine, and two neighbouring sites get different
    patch draws for the ground between them. (Their rings do overlap; the seam that
    matters is the one *inside* a bundle, between that bundle's own rings, and this
    keeps that one exact.)
    """
    return int(zlib.crc32(site_id.encode("utf-8")))


# --------------------------------------------------------------------------- #
# the farField legend block (contract §13)
# --------------------------------------------------------------------------- #

METHOD = (
    "The far-field rasters — one per ring of the §11 ladder, out to "
    "{reach:.0f} km — were classified by a deliberately cruder engine than the "
    "§9 near-field one, reading two inputs and no others: the ring DEM's own "
    "elevation, and slope in degrees derived from it (np.gradient at each ring's "
    "resolution, {resolution:.0f} m per pixel on the finest ring here). None of "
    "the near-field inputs is used out here — no SGU soil polygons, no registered "
    "grave, settlement, field or road evidence, no modelled shoreline. They are "
    "not available at this extent (soils for a 64×64 km box would be some 256× "
    "the context fetch per site) and they are invisible at it: an 8 m road "
    "corridor or a 300 m grazing halo is sub-pixel beyond about 4 km. Four "
    "thresholds do the work. Elevation at or below {sea:.2f} m is sea — the "
    "modern Baltic together with the cells the ring build filled at 0 m outside "
    "the Lantmäteriet tile set (§11's coverage seam), not a mapped shoreline and "
    "not the modelled Iron Age sea. Above that, a connected surface of at least "
    "{lake_ha:.0f} ha at one exact elevation with slope below {flat:.2f}° is "
    "standing water — the DEM is TIN-flat over lakes, and only a lake is that "
    "level at that size; smaller lakes read as open land, and the outermost "
    "rings' coarser quantization cannot support the test at all. Slope above "
    "{rock:.0f}° is steep rock and sparse ground — the same threshold the §9 "
    "engine uses to stop growing forest. Everything else is split between open "
    "ground and forest by a patch mosaic: the world is divided into fixed "
    "{patch:.0f} m squares anchored to the EPSG:3006 coordinate grid rather than "
    "to any ring's pixels — so the overlapping rings classify the same ground "
    "identically and no seam appears where they meet — and each square is hashed "
    "with a per-site seed to a value in [0, 1). A square is open where that value "
    "falls below {open_pct:.0f} %, which is this site's own measured open-land "
    "share of its §9 context raster (farmland, wet meadow, dry gravel corridor, "
    "settled ground kept clear, alvar, wooded pasture and peat fen, counted over "
    "land cells only — a mire is open land at this distance). The far field "
    "therefore statistically continues the near field rather than asserting "
    "independent knowledge about ground nobody surveyed. {forest_identity} "
    "Trees in the 2–8 km band are drawn as single upright billboards at "
    "{density} stems per hectare against the model's near-field "
    "{near_density}: the band renders roughly one tree in ten as a stand-in for "
    "the stand — one in nine to twelve, exactly — the same convention as the "
    "schematic near-field tree forms, and density does not thin with distance "
    "because a farther forest is not a thinner forest. Nothing here is evidence "
    "about any particular hillside, and nothing here feeds analysis: the "
    "viewshed, the water logic and the §9 raster are untouched by this raster, "
    "which drives ground tint and billboards only."
)

_FOREST_IDENTITY_SPLIT = (
    "Forest squares take a second, independent draw on the same patch: "
    "{broadleaf_pct:.0f} % broadleaf against {conifer_pct:.0f} % conifer, the "
    "broadleaf/conifer split measured in this site's own context raster, carrying "
    "the {zone_name} zone's forest identity (docs/vegetation-zones.md §4)."
)
_FOREST_IDENTITY_BOREAL = (
    "Every forest square is conifer: this site is in the southern boreal zone, "
    "where the pollen record for ~500 CE shows conifer-dominated forest rather "
    "than oak-hazel woodland (docs/vegetation-zones.md §4), so the far field runs "
    "no broadleaf/conifer split at all and the broadleaf class holds no cells."
)


def method_text(
    open_fraction: float,
    broadleaf_share: float,
    zone: ZoneAssignment | None,
    resolution_m: float,
    reach_m: float,
) -> str:
    """The one-paragraph far-field derivation the app shows verbatim (contract §13)."""
    if zone is not None and zone.zone == "s_boreal":
        forest_identity = _FOREST_IDENTITY_BOREAL
    else:
        forest_identity = _FOREST_IDENTITY_SPLIT.format(
            broadleaf_pct=100.0 * float(broadleaf_share),
            conifer_pct=100.0 * (1.0 - float(broadleaf_share)),
            zone_name=zone.zone_name if zone is not None else "boreonemoral",
        )
    return METHOD.format(
        reach=float(reach_m) / 1000.0,
        resolution=float(resolution_m),
        sea=SEA_MAX_M,
        flat=FLAT_MAX_SLOPE_DEG,
        lake_ha=LAKE_MIN_COMPONENT_HA,
        rock=ROCK_MIN_SLOPE_DEG,
        patch=PATCH_SIZE_M,
        open_pct=100.0 * float(open_fraction),
        forest_identity=forest_identity,
        density=BILLBOARD_DENSITY_PER_HA,
        near_density=f"{NEAR_FIELD_DENSITY_TEXT} stems per hectare",
    )


def far_field_block(
    open_fraction: float,
    broadleaf_share: float,
    zone: ZoneAssignment | None,
    resolution_m: float,
    reach_m: float,
) -> dict:
    """Assemble `landcover_legend.farField` (contract §13).

    No `areaFraction` and no `dynamic` anywhere in it: the rasters vary per ring so
    a single share would be meaningless, and the far field is fully static — far
    *water* rendering stays §11's job. `landcover.validate_legend` refuses both.
    """
    classes = far_field_classes(open_fraction, broadleaf_share, zone, resolution_m)
    return {
        "method": method_text(open_fraction, broadleaf_share, zone, resolution_m, reach_m),
        "classes": [entry.as_json() for entry in classes],
    }


# --------------------------------------------------------------------------- #
# orchestration
# --------------------------------------------------------------------------- #

_RING_NUMBER = re.compile(r"ring(\d+)$", re.IGNORECASE)


def ring_landcover_path(dem_path: str) -> str:
    """`dem_ring4.tif` -> `landcover_ring4.tif` (contract §13's file naming)."""
    match = _RING_NUMBER.search(Path(dem_path).stem)
    if match is None:
        raise FarLandcoverError(
            f"ring DEM path {dem_path!r} does not end in a ring number — §13 names the "
            f"class raster after its ring (dem_ring4.tif -> landcover_ring4.tif)"
        )
    return f"landcover_ring{int(match.group(1))}.tif"


def _check_ring_profile(reference: Path, candidate: Path) -> None:
    """§13: the class raster matches its ring's DEM geometry exactly.

    The same comparator §9 runs against `dem_context.tif`, with the ring DEM as the
    reference instead — §13 defines the rule by reference to §9's, so the check is
    the same code rather than a second implementation of it.
    """
    try:
        _check_context_profile(reference, candidate)
    except LandcoverError as exc:
        raise FarLandcoverError(str(exc)) from exc


def load_manifest(cfg: SiteConfig) -> dict:
    """The committed manifest, gated on the two things §13 requires to exist."""
    manifest_path = cfg.out_dir / "manifest.json"
    if not manifest_path.exists():
        raise FarLandcoverError(
            f"{manifest_path} is missing — run `python3 -m fornborg_pipeline.build "
            f"--site {cfg.id}` first."
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest.get("grids", {}).get("rings"):
        raise FarLandcoverError(
            f"{cfg.id} declares no grids.rings — run `python3 -m fornborg_pipeline.rings "
            f"--site {cfg.id}` first; the far field is classified on the ring DEMs."
        )
    assets = manifest.get("assets", {})
    missing = [key for key in ("landcover", "landcoverLegend") if key not in assets]
    if missing:
        raise FarLandcoverError(
            f"{cfg.id} is missing assets.{' and assets.'.join(missing)} — run "
            f"`python3 -m fornborg_pipeline.landcover --site {cfg.id}` first. The far "
            f"field extends the modelled-landscape layer and cannot exist without the "
            f"near field (contract §13)."
        )
    return manifest


def run(site_id: str) -> dict:
    """Classify every ring of one site's ladder and wire the results into the bundle."""
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — far-field land cover (contract §13)")

    manifest = load_manifest(cfg)
    rings = manifest["grids"]["rings"]
    legend_path = cfg.out_dir / manifest["assets"]["landcoverLegend"]
    if not legend_path.exists():
        raise FarLandcoverError(
            f"{legend_path} is missing though the manifest declares it — re-run "
            f"`python3 -m fornborg_pipeline.landcover --site {cfg.id}`."
        )
    legend = json.loads(legend_path.read_text(encoding="utf-8"))

    open_fraction, broadleaf_share = context_mosaic_ratio(legend)
    print(
        f"-- context ratio: {100.0 * open_fraction:.1f} % open land, forest "
        f"{100.0 * broadleaf_share:.1f} % broadleaf "
        f"(measured on {manifest['assets']['landcover']}, land cells only)"
    )

    # Same zone assignment as the near field runs, on the same crown height (the
    # context grid's maximum), so the two legends never disagree about the site.
    context_dm, _transform, _bounds = read_grid(cfg.out_dir / cfg.context.path)
    crown = float(dequantize_decimeters(context_dm).max())
    zone = assign_zone(cfg.center_e, cfg.center_n, cfg.county, crown)
    seed = site_seed(cfg.id)
    print(
        f"-- zone: {zone.zone_name} (crown {crown:.1f} m); mosaic seed {seed} "
        f"(crc32 of the site id — same site, same far field, every build)"
    )

    written: list[tuple[str, Path]] = []
    for entry in rings:
        dem_path = cfg.out_dir / entry["path"]
        if not dem_path.exists():
            raise FarLandcoverError(
                f"{dem_path} is missing though the manifest declares it — re-run "
                f"`python3 -m fornborg_pipeline.rings --site {cfg.id}`."
            )
        # The manifest's own `encoding.scale` is authoritative per grid (§11): rings
        # quantize at 0.5 m or 1.0 m, never the core/context 0.1 m.
        scale = float(entry["encoding"]["scale"])
        resolution = float(entry["resolution"])
        raw, transform, _ring_bounds = read_grid(dem_path)
        heights_m = dequantize(raw, scale)
        slope = slope_degrees(heights_m, resolution)
        classes = classify_far(
            heights_m,
            slope,
            transform,
            open_fraction,
            broadleaf_share,
            zone,
            seed,
            resolution_m=resolution,
            quant_scale_m=scale,
        )

        out_name = ring_landcover_path(entry["path"])
        out_path = write_class_grid(cfg.out_dir / out_name, classes, transform)
        shares = np.bincount(classes.ravel(), minlength=len(_FAR_RULES)) / classes.size
        print(
            f"  {entry['path']} @ {resolution:.0f} m (scale {scale} m) -> {out_name} "
            f"({out_path.stat().st_size / 1e3:.1f} kB): "
            + ", ".join(
                f"{rule[0]} {100.0 * share:.1f} %"
                for rule, share in zip(_FAR_RULES, shares)
                if share > 0.0
            )
        )
        _check_ring_profile(dem_path, out_path)
        attach_ring_landcover(manifest, entry["path"], out_name)
        written.append((entry["path"], out_path))

    print("-- legend")
    finest = min(float(entry["resolution"]) for entry in rings)
    reach = max(
        float(entry["bounds3006"]["maxE"]) - float(entry["bounds3006"]["minE"])
        for entry in rings
    ) / 2.0
    legend["farField"] = far_field_block(
        open_fraction, broadleaf_share, zone, finest, reach
    )
    write_legend(legend_path, legend)
    print(f"  wrote {legend_path} (farField: {len(legend['farField']['classes'])} classes)")

    print("-- manifest")
    manifest_path = cfg.out_dir / "manifest.json"
    validate_manifest(manifest)
    write_manifest(manifest_path, manifest)
    print(f"  wrote {manifest_path} ({len(written)} rings carry landcover)")

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
    help="Site to derive the far-field land cover for.",
)
def cli(site_id: str) -> None:
    """Write landcover_ring<N>.tif per ring, the farField legend block and the manifest keys."""
    try:
        run(site_id)
    except (FarLandcoverError, LandcoverError) as exc:
        raise SystemExit(f"FAR-FIELD LAND COVER FAILED: {exc}") from exc


if __name__ == "__main__":
    sys.exit(cli())
