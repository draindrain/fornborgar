"""Tests for the KMR sites extract (docs/data-formats.md §3, PLAN §2.2).

Everything runs on canned GeoJSON feature dicts — no GeoPackage, no ogr2ogr,
no network. The subprocess/download seam is exercised only for its error path.
"""

import pytest

from fornborg_pipeline.fetch_sites import (
    SELECTED_TYPES,
    SitesError,
    build_records,
    build_sites_file,
    geometry_to_local,
    representative_point,
    validate_sites,
)
from fornborg_pipeline.sites import BROBORG


def feat(kind, coords, **props):
    base = {"lamningsnummer": "L2000:1", "lamningstyp": "Gravfält", "lamningsnamn": None}
    base.update(props)
    return {"type": "Feature", "properties": base, "geometry": {"type": kind, "coordinates": coords}}


E, N = BROBORG.center_e, BROBORG.center_n


class TestGeometry:
    def test_point_to_local(self):
        g = geometry_to_local({"type": "Point", "coordinates": [E + 10, N + 20]}, BROBORG)
        assert g == {"type": "Point", "coordinates": [10.0, -20.0]}  # north = -z

    def test_polygon_to_local_and_centroid(self):
        ring = [[E, N], [E + 40, N], [E + 40, N + 40], [E, N + 40], [E, N]]
        g = geometry_to_local({"type": "Polygon", "coordinates": [ring]}, BROBORG)
        assert g["type"] == "Polygon"
        p = representative_point(g)
        assert p["x"] == pytest.approx(16.0)  # ring centroid (closing vertex repeats)
        assert p["z"] == pytest.approx(-16.0)

    def test_multipolygon_representative_uses_exterior_rings_only(self):
        outer = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]]
        hole = [[400.0, 400.0], [401.0, 400.0], [401.0, 401.0], [400.0, 400.0]]
        p = representative_point({"type": "Polygon", "coordinates": [outer, hole]})
        assert p["x"] < 20  # the far-away hole must not drag the anchor


class TestRecords:
    def test_type_filter_and_merge_preference(self):
        by_kind = {
            "polygon": [feat("Polygon", [[[E, N], [E + 10, N], [E + 10, N + 10], [E, N]]])],
            "point": [
                feat("Point", [E + 5, N + 5]),  # same site: polygon wins
                feat("Point", [E + 1, N + 1], lamningsnummer="L2000:2", lamningstyp="Runristning"),
                feat("Point", [E + 2, N + 2], lamningsnummer="L2000:3", lamningstyp="Gränsmärke"),
            ],
            "linestring": [],
        }
        records = build_records(by_kind, BROBORG)
        assert [r["id"] for r in records] == ["L2000:1", "L2000:2"]  # Gränsmärke filtered out
        assert records[0]["geometryLocal"]["type"] == "Polygon"
        assert "geometryLocal" not in records[1]  # points carry position only

    def test_same_kind_rows_merge_to_multi(self):
        by_kind = {
            "polygon": [
                feat("Polygon", [[[E, N], [E + 10, N], [E + 10, N + 10], [E, N]]]),
                feat("Polygon", [[[E + 50, N], [E + 60, N], [E + 60, N + 10], [E + 50, N]]]),
            ],
            "point": [],
            "linestring": [],
        }
        (record,) = build_records(by_kind, BROBORG)
        assert record["geometryLocal"]["type"] == "MultiPolygon"

    def test_name_falls_back_to_id_and_optional_fields(self):
        by_kind = {
            "polygon": [],
            "linestring": [],
            "point": [
                feat(
                    "Point",
                    [E, N],
                    lamningsnamn="Åby gravfält",
                    url="https://pub.raa.se/visa/objekt/lamning/x",
                    beskrivning="Gravfält, 50x30 m.",
                ),
                feat("Point", [E + 1, N], lamningsnummer="L2000:9"),
            ],
        }
        records = build_records(by_kind, BROBORG)
        named = next(r for r in records if r["id"] == "L2000:1")
        bare = next(r for r in records if r["id"] == "L2000:9")
        assert named["name"] == "Åby gravfält"
        assert named["fornsokUrl"].endswith("/x")
        assert named["description"].startswith("Gravfält")
        assert bare["name"] == "L2000:9"
        assert "fornsokUrl" not in bare and "description" not in bare

    def test_plan_filter_contents(self):
        # PLAN §2.2: no Runsten, no Hålväg — those names must never appear.
        assert "Runsten" not in SELECTED_TYPES
        assert "Hålväg" not in SELECTED_TYPES
        assert {"Fornborg", "Gravfält", "Färdväg", "Färdvägssystem"} <= SELECTED_TYPES

    def test_widened_evidence_types_are_selected(self):
        # The land-cover model reads graves, field remains and roads by type, so the
        # extract has to carry them. Spellings are Lämningstypslistan v5.0 verbatim,
        # verified against live kommun GeoPackages.
        assert {
            "Hög",
            "Stensättning",
            "Röse",
            "Skärvstenshög",
            "Husgrund, förhistorisk/medeltida",
            "Fossil åker",
            "Röjningsröseområde",
            "Terrassering",
            "Hägnad",
        } <= SELECTED_TYPES
        # Historic-era types stay out: wrong era for a 500 CE model.
        assert "Lägenhetsbebyggelse" not in SELECTED_TYPES
        assert "Husgrund, historisk tid" not in SELECTED_TYPES
        assert "Bytomt/gårdstomt" not in SELECTED_TYPES


class TestValidation:
    def _doc(self):
        by_kind = {"polygon": [], "linestring": [], "point": [feat("Point", [E, N])]}
        return build_sites_file(build_records(by_kind, BROBORG), "2026-08-20")

    def test_roundtrip_valid(self):
        validate_sites(self._doc())

    def test_duplicate_ids_rejected(self):
        doc = self._doc()
        doc["sites"].append(dict(doc["sites"][0]))
        with pytest.raises(SitesError, match="duplicate"):
            validate_sites(doc)

    def test_provenance_must_be_measured(self):
        doc = self._doc()
        doc["sites"][0]["provenance"] = "conjecture"
        with pytest.raises(SitesError, match="measured"):
            validate_sites(doc)
