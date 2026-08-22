"""Vegetation-zone assignment (docs/vegetation-zones.md §1.2). No network.

The rule is the one thing in the land-cover model that decides a site's whole
parameter set from three registry numbers, so the tests pin the cases where it is
allowed to disagree with a naive latitude cut: the island carve-out, the altitude
term, and the spruce front — which deliberately does not follow the zone lines.

The census test is the real gate. §1.3's 22 / 1,261 / 21 were measured against
this exact committed registry; a rule change that moves a single site moves one
of those numbers, and a national build's zone census is supposed to fail loudly
when it does (§6, Checks).
"""

from __future__ import annotations

import json
from collections import Counter

import pytest

from fornborg_pipeline.registry import REGISTRY_PATH
from fornborg_pipeline.zones import ZONES, assign_zone

# Registry coordinates (EPSG:3006) of the sites the doc names by name.
BROBORG = (665810.0, 6627880.0, "Uppsala")
EKETORP = (591980.0, 6239970.0, "Kalmar")
SLOTTET = (737760.0, 6373480.0, "Gotland")
# A mainland site at 60.309°N — close enough under the 60.7°N line that a few
# hundred metres of elevation moves it across (case: the altitude term).
UPPSALA_HIGHLAT = (631630.0, 6688190.0, "Uppsala")

# Two points at Mabo Moss's latitude (58.02°N), one at its longitude and one in
# western Småland, projected from WGS84 — the east/west sides of §2.4's tongue.
EAST_TONGUE = (562619.3, 6431428.2, "Östergötland")
WEST_LOWLAND = (470462.0, 6431046.1, "Jönköping")


def registry_sites() -> list[dict]:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))["sites"]


def test_broborg_is_boreonemoral_with_spruce():
    """The control site (§1.3): its zone is the one whose parameters are today's."""
    zone = assign_zone(*BROBORG)
    assert zone.zone == "boreonemoral"
    assert zone.zone_name == ZONES["boreonemoral"]
    assert zone.island is False
    assert zone.spruce_present is True  # 59.756°N, north of the §2.4 front
    assert zone.lat == pytest.approx(59.756, abs=0.01)
    assert zone.lon == pytest.approx(17.95, abs=0.01)


def test_eketorp_is_carved_out_of_the_nemoral_zone():
    """Öland: the §1.1 convention overrides a latitude that would say nemoral."""
    zone = assign_zone(*EKETORP)
    assert zone.island is True
    assert zone.lat < 57.0  # what the pure latitude rule would have gone on
    assert zone.zone == "boreonemoral"
    assert zone.spruce_present is False


def test_gotland_site_is_an_island_site():
    zone = assign_zone(*SLOTTET)
    assert zone.island is True
    assert zone.zone == "boreonemoral"
    assert zone.spruce_present is False


def test_skane_site_is_nemoral():
    entry = next(s for s in registry_sites() if s["slug"] == "l1989-1072")
    zone = assign_zone(entry["centerE"], entry["centerN"], entry["county"])
    assert zone.zone == "nemoral"
    assert zone.spruce_present is False


def test_vasternorrland_site_is_southern_boreal():
    entry = next(s for s in registry_sites() if s["slug"] == "l1936-5794")
    zone = assign_zone(entry["centerE"], entry["centerN"], entry["county"])
    assert zone.zone == "s_boreal"
    assert zone.spruce_present is True


def test_the_altitude_term_promotes_a_highland_site():
    """200 m ≈ 1.5° of latitude — enough to move a 60.3°N site over the line."""
    lowland = assign_zone(*UPPSALA_HIGHLAT)
    assert lowland.zone == "boreonemoral"
    assert lowland.effective_lat == lowland.lat

    highland = assign_zone(*UPPSALA_HIGHLAT, site_elevation_m=200.0)
    assert highland.effective_lat > 60.7
    assert highland.zone == "s_boreal"
    # The front is a colonization history, not a climate proxy: the altitude
    # term must not touch it (both sites are north of 59.7°N anyway).
    assert highland.lat == lowland.lat


def test_the_registry_census_matches_the_documented_one():
    """§1.3, measured against this registry: 22 / 1,261 / 21, altitude term inert."""
    census = Counter(
        assign_zone(site["centerE"], site["centerN"], site["county"]).zone
        for site in registry_sites()
    )
    assert census == {"nemoral": 22, "boreonemoral": 1261, "s_boreal": 21}


def test_the_spruce_front_has_an_eastern_tongue():
    """§2.4: at 58.0°N spruce is present in the east (Mabo Moss) and absent west."""
    east = assign_zone(*EAST_TONGUE)
    west = assign_zone(*WEST_LOWLAND)
    assert east.lat == pytest.approx(west.lat, abs=0.01)
    assert east.spruce_present is True
    assert west.spruce_present is False
    # Neither is a zone difference — the front cuts across the boreonemoral zone.
    assert east.zone == west.zone == "boreonemoral"
