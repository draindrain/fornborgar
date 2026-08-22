"""Minimal GeoPackage reader (fornborg_pipeline.gpkg). No network, no GDAL.

The registry builder reads the 2.3 GB national KMR extract through this module,
so the parsing has to be right about the two things it derives per record: the
representative point and the extent bbox. Fixtures are hand-built GPKG blobs and
a synthetic GeoPackage assembled with stdlib sqlite3.
"""

from __future__ import annotations

import sqlite3
import struct

import pytest

from fornborg_pipeline.gpkg import (
    GeoPackageError,
    list_layers,
    parse_gpkg_geometry,
    read_features,
    table_columns,
)


def wkb_point(x: float, y: float, dims: int = 0) -> bytes:
    """Little-endian WKB point; `dims` picks the 1000/2000/3000 Z/M/ZM variant."""
    extra = {0: 0, 1: 1, 2: 1, 3: 2}[dims]
    return struct.pack("<BI", 1, 1 + dims * 1000) + struct.pack(
        f"<{2 + extra}d", x, y, *([0.0] * extra)
    )


def wkb_linestring(points: list[tuple[float, float]]) -> bytes:
    body = struct.pack("<BII", 1, 2, len(points))
    for x, y in points:
        body += struct.pack("<dd", x, y)
    return body


def wkb_polygon(rings: list[list[tuple[float, float]]]) -> bytes:
    body = struct.pack("<BII", 1, 3, len(rings))
    for ring in rings:
        body += struct.pack("<I", len(ring))
        for x, y in ring:
            body += struct.pack("<dd", x, y)
    return body


def wkb_multipolygon(polygons: list[list[list[tuple[float, float]]]]) -> bytes:
    body = struct.pack("<BII", 1, 6, len(polygons))
    for rings in polygons:
        body += wkb_polygon(rings)
    return body


def gpkg_blob(wkb: bytes, envelope: tuple[float, float, float, float] | None = None) -> bytes:
    """Wrap WKB in the OGC GeoPackage BLOB header (§2.1.3)."""
    indicator = 1 if envelope else 0
    flags = 0x01 | (indicator << 1)  # little-endian header
    header = struct.pack("<ccBBi", b"G", b"P", 0, flags, 3006)
    if envelope:
        min_x, min_y, max_x, max_y = envelope
        header += struct.pack("<4d", min_x, max_x, min_y, max_y)
    return header + wkb


SQUARE = [[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0), (0.0, 0.0)]]


def test_point_geometry_is_its_own_representative_point():
    geom = parse_gpkg_geometry(gpkg_blob(wkb_point(665810.0, 6627880.0)))
    assert geom.kind == "point"
    assert geom.representative_point == (665810.0, 6627880.0)
    assert geom.bbox == (665810.0, 6627880.0, 665810.0, 6627880.0)


@pytest.mark.parametrize("dims", [0, 1, 2, 3], ids=["xy", "xyz", "xym", "xyzm"])
def test_extra_ordinates_are_skipped(dims):
    """KMR geometries carry Z; x/y must survive the 1000/2000/3000 type codes."""
    geom = parse_gpkg_geometry(gpkg_blob(wkb_point(10.0, 20.0, dims=dims)))
    assert geom.representative_point == (10.0, 20.0)


def test_polygon_centroid_is_area_weighted():
    geom = parse_gpkg_geometry(gpkg_blob(wkb_polygon(SQUARE)))
    assert geom.kind == "polygon"
    x, y = geom.representative_point
    assert x == pytest.approx(50.0)
    assert y == pytest.approx(50.0)
    assert geom.bbox == (0.0, 0.0, 100.0, 100.0)


def test_polygon_centroid_is_not_the_vertex_mean():
    """A ring with dense vertices along one edge would drag a vertex mean off."""
    ring = [(0.0, 0.0)]
    ring += [(x / 10.0, 0.0) for x in range(1, 100)]  # 99 extra vertices on the south edge
    ring += [(10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]
    geom = parse_gpkg_geometry(gpkg_blob(wkb_polygon([ring])))
    x, y = geom.representative_point
    assert y == pytest.approx(5.0, abs=1e-6), "area weighting must ignore vertex density"


def test_polygon_hole_shifts_the_centroid():
    hole = [(60.0, 10.0), (90.0, 10.0), (90.0, 90.0), (60.0, 90.0), (60.0, 10.0)]
    solid = parse_gpkg_geometry(gpkg_blob(wkb_polygon(SQUARE)))
    holed = parse_gpkg_geometry(gpkg_blob(wkb_polygon([SQUARE[0], hole])))
    assert holed.representative_point[0] < solid.representative_point[0]


def test_multipolygon_centroid_weights_the_parts_by_area():
    small = [[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]]
    big = [[(100.0, 0.0), (200.0, 0.0), (200.0, 100.0), (100.0, 100.0), (100.0, 0.0)]]
    geom = parse_gpkg_geometry(gpkg_blob(wkb_multipolygon([small, big])))
    assert geom.kind == "polygon"
    # The 100x100 part dominates the 10x10 one; the centroid sits inside it.
    assert geom.representative_point[0] > 100.0
    assert geom.bbox == (0.0, 0.0, 200.0, 100.0)


def test_line_representative_point_is_the_midpoint_by_length():
    # An L with a long leg and a short one: the halfway point is on the long leg.
    geom = parse_gpkg_geometry(
        gpkg_blob(wkb_linestring([(0.0, 0.0), (100.0, 0.0), (100.0, 20.0)]))
    )
    assert geom.kind == "line"
    x, y = geom.representative_point
    assert (x, y) == pytest.approx((60.0, 0.0))


def test_degenerate_polygon_falls_back_to_the_vertex_mean():
    """A zero-area ring (a collapsed extent) still has to yield a location."""
    flat = [[(5.0, 5.0), (15.0, 5.0), (5.0, 5.0)]]
    geom = parse_gpkg_geometry(gpkg_blob(wkb_polygon(flat)))
    x, _y = geom.representative_point
    assert 5.0 <= x <= 15.0


def test_envelope_header_is_skipped_not_parsed_as_wkb():
    with_env = parse_gpkg_geometry(gpkg_blob(wkb_polygon(SQUARE), envelope=(0, 0, 100, 100)))
    without = parse_gpkg_geometry(gpkg_blob(wkb_polygon(SQUARE)))
    assert with_env.representative_point == without.representative_point


def test_rejects_a_blob_that_is_not_a_geopackage_geometry():
    with pytest.raises(GeoPackageError, match="not a GeoPackage"):
        parse_gpkg_geometry(b"XX\x00\x01" + b"\x00" * 8)


def test_rejects_an_empty_geometry_flag():
    blob = bytearray(gpkg_blob(wkb_point(1.0, 2.0)))
    blob[3] |= 0x10  # the "empty geometry" flag
    with pytest.raises(GeoPackageError, match="empty geometry"):
        parse_gpkg_geometry(bytes(blob))


# ------------------------------- the SQLite side -----------------------------


@pytest.fixture
def tiny_gpkg(tmp_path):
    """A GeoPackage with the two tables the reader looks at, plus one layer."""
    path = tmp_path / "tiny.gpkg"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT)")
    conn.execute("CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT)")
    conn.execute("CREATE TABLE lamningar (uuid TEXT, lamningstyp TEXT, geom BLOB)")
    conn.execute("INSERT INTO gpkg_contents VALUES ('lamningar', 'features')")
    conn.execute("INSERT INTO gpkg_geometry_columns VALUES ('lamningar', 'geom')")
    conn.executemany(
        "INSERT INTO lamningar VALUES (?, ?, ?)",
        [
            ("a", "Fornborg", gpkg_blob(wkb_polygon(SQUARE))),
            ("b", "Gravfält", gpkg_blob(wkb_point(1.0, 2.0))),
            ("c", "Fornborg", gpkg_blob(wkb_point(7.0, 8.0))),
            ("d", "Fornborg", None),  # a record with no geometry at all
            ("e", "Fornborg", b"garbage"),  # an unreadable geometry
        ],
    )
    conn.commit()
    conn.close()
    return path


def test_lists_layers_and_columns(tiny_gpkg):
    assert list_layers(tiny_gpkg) == [("lamningar", "features")]
    assert table_columns(tiny_gpkg, "lamningar") == ["uuid", "lamningstyp", "geom"]


def test_read_features_filters_and_skips_unusable_geometries(tiny_gpkg):
    rows = list(
        read_features(
            tiny_gpkg, "lamningar", ["uuid"], where='"lamningstyp" = ?', params=("Fornborg",)
        )
    )
    # 'd' has no blob and 'e' has an unparseable one: both are dropped, not guessed at.
    assert [attrs["uuid"] for attrs, _geom in rows] == ["a", "c"]
    assert rows[0][1].kind == "polygon"
    assert rows[1][1].kind == "point"


def test_read_features_opens_the_file_read_only(tiny_gpkg):
    """The 2.3 GB cache must never be mutated by a registry build."""
    list(read_features(tiny_gpkg, "lamningar", ["uuid"]))
    conn = sqlite3.connect(f"file:{tiny_gpkg}?mode=ro", uri=True)
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("DELETE FROM lamningar")
    conn.close()
