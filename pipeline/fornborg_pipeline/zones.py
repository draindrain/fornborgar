"""Vegetation-zone assignment for the land-cover model (docs/vegetation-zones.md §1.2).

Three zones cover all 1,304 registry sites — nemoral, boreonemoral (hemiboreal)
and southern boreal — and which one a site falls in is a pure function of data
the pipeline already has: the registry's `centerE/centerN` and `county`, plus the
DEM crown elevation it computes anyway for the horizon ladder. No new dataset,
no per-site hand-tuning, same answer on every run.

**The thresholds are a documented modelling choice, not surveyed boundaries.**
57.0°N and 60.7°N are round-number stand-ins for zone limits whose literature
sources (Ahti et al. 1968; Sjörs 1963/1999) could not be fetched; the pollen
evidence of §2 confirms that the zones *differ*, not where exactly they divide,
and with pollen sites spaced 0.3–0.5° apart no line can be placed more precisely
than this. Nothing downstream needs them sharper: every parameter that varies by
zone changes gradually in reality, so a site within ~50 km of a threshold is
ambiguous in nature and not only in the rule. Callers must disclose the rule
rather than present a zone as a surveyed fact.

`spruce_present` is deliberately *not* folded into the zone. It carries the one
independently measured line in the document — the 500 CE spruce front of §2.4 —
which does not coincide with any zone boundary (§4).
"""

from __future__ import annotations

from dataclasses import dataclass

from pyproj import Transformer

from .sites import EPSG_HORIZONTAL

# Registry coordinates are projected; every threshold below is geographic. Built
# once here — a Transformer is expensive to construct and this one is called per
# site across a 1,304-site batch.
_TO_WGS84 = Transformer.from_crs(EPSG_HORIZONTAL, 4326, always_xy=True)

# §1.2: nemoral below this effective latitude, boreonemoral below the next.
NEMORAL_MAX_EFF_LAT = 57.0
BOREONEMORAL_MAX_EFF_LAT = 60.7

# §1.2: the altitude-for-latitude exchange, the conventional order of magnitude
# for Scandinavian growing-season lapse [reported]. Nearly inert over the
# registry — it is what keeps a 300 m Småland highland site from being
# classified by its latitude alone.
ALTITUDE_M_PER_DEGREE = 130.0

# §1.2: Kalmar county east of this longitude is Öland. Öland and Gotland are
# conventionally boreonemoral despite their latitude (§1.1), so they are carved
# out of the latitude rule entirely.
OLAND_MIN_LON = 16.35

# §2.4/§4: the measured 500 CE spruce front. North of this latitude every
# lowland pollen site carries established spruce stands (≥ 10 % Picea).
SPRUCE_MIN_LAT = 59.7

# §2.4/§4: the eastern-lowland tongue that reaches further south — eastern
# Östergötland and the east coast, where spruce was present well below the
# lowland front.
SPRUCE_EAST_MIN_LAT = 58.0
SPRUCE_EAST_MIN_LON = 15.9

#: Zone id -> the display name used in manifests and legend method text.
ZONES: dict[str, str] = {
    "nemoral": "nemoral",
    "boreonemoral": "boreonemoral (hemiboreal)",
    "s_boreal": "southern boreal",
}


@dataclass(frozen=True)
class ZoneAssignment:
    """One site's zone and the inputs that decided it, for disclosure downstream."""

    zone: str  # "nemoral" | "boreonemoral" | "s_boreal"
    zone_name: str  # display name, from ZONES
    lat: float
    lon: float
    island: bool  # the Öland/Gotland carve-out applied (§1.2)
    effective_lat: float  # lat + elevation/130; equals lat when no elevation is given
    spruce_present: bool  # §2.4: was Norway spruce a stand-former here at 500 CE


def assign_zone(
    center_e: float,
    center_n: float,
    county: str,
    site_elevation_m: float | None = None,
) -> ZoneAssignment:
    """The §1.2 rule, verbatim: zone from latitude, county and DEM elevation.

    `site_elevation_m` is the crown height the pipeline already computes; `None`
    means the altitude term is inert, which is also how the §1.3 census was
    counted (the registry itself carries no elevation).
    """
    lon, lat = _TO_WGS84.transform(center_e, center_n)

    island = county == "Gotland" or (county == "Kalmar" and lon > OLAND_MIN_LON)
    effective_lat = lat + (site_elevation_m or 0.0) / ALTITUDE_M_PER_DEGREE

    if island:
        zone = "boreonemoral"  # the §1.1 literature convention, not the latitude
    elif effective_lat < NEMORAL_MAX_EFF_LAT:
        zone = "nemoral"
    elif effective_lat < BOREONEMORAL_MAX_EFF_LAT:
        zone = "boreonemoral"
    else:
        zone = "s_boreal"

    # This encodes the measured 500 CE spruce front of §2.4, not the zone lines:
    # established north of ~59.7°N in the lowlands, plus the eastern-lowland
    # tongue (Mabo Moss, 58.02°N/16.06°E, measured 11.4 % Picea). The south-west
    # stays false — a spruce there at 500 CE is an anachronism. The front is
    # tested on true latitude: it is a colonization history, and the altitude
    # term has no business shifting it.
    #
    # The tongue's box does reach the northernmost tip of Gotland (5 registry
    # sites above 58.0°N). No pollen core exists on either island in our window
    # (§2.5), so nothing here is measured for them either way; what actually
    # governs those sites is the alvar overlay (§5), not the tree species.
    spruce_present = (
        zone == "s_boreal"
        or lat >= SPRUCE_MIN_LAT
        or (lat >= SPRUCE_EAST_MIN_LAT and lon >= SPRUCE_EAST_MIN_LON)
    )

    return ZoneAssignment(
        zone=zone,
        zone_name=ZONES[zone],
        lat=lat,
        lon=lon,
        island=island,
        effective_lat=effective_lat,
        spruce_present=spruce_present,
    )
