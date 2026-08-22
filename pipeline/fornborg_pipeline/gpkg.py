"""Minimal GeoPackage reader — stdlib `sqlite3` plus a WKB parser.

A GeoPackage *is* a SQLite database, and everything the registry builder
(§4.1 of docs/national-scaleout.md) needs from the 2.3 GB national KMR extract is
attribute columns plus, per feature, a representative point and an extent bbox.
That is a few hundred lines of well-specified binary parsing, so this module does
it directly rather than adding a GDAL/GEOS dependency to a pipeline whose other
five dependencies are numeric.

What it deliberately does NOT do: reprojection (the KMR file is already
EPSG:3006, and the pipeline never warps — PLAN.md §2.1), spatial predicates,
topology repair. `fetch_sites.py` still shells out to `ogr2ogr` for the per-site
extract, where clipping and GeoJSON emission genuinely want GDAL.

References: OGC GeoPackage 1.3 §2.1.3 (BLOB header) and OGC 06-103r4 (WKB).
"""

from __future__ import annotations

import sqlite3
import struct
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

# WKB geometry type codes, modulo the 1000/2000/3000 offsets that mark Z/M/ZM.
WKB_POINT = 1
WKB_LINESTRING = 2
WKB_POLYGON = 3
WKB_MULTIPOINT = 4
WKB_MULTILINESTRING = 5
WKB_MULTIPOLYGON = 6
WKB_GEOMETRYCOLLECTION = 7


class GeoPackageError(RuntimeError):
    """The file is not a GeoPackage, or a geometry blob is malformed."""


@dataclass(frozen=True)
class Geometry:
    """A parsed geometry, flattened to what the registry actually consumes.

    `rings` holds every coordinate sequence in the geometry as a list of (x, y)
    tuples: polygon rings (exterior and holes, in WKB order), line strings, or a
    one-point sequence per point. `kind` is the geometry class the registry
    records — "polygon" | "line" | "point" — decided by the outermost type.
    """

    kind: str
    rings: list[list[tuple[float, float]]]
    #: Ring index -> True when that ring is an interior ring (a hole).
    holes: list[bool]
    #: The GeoJSON the flattening came from, for consumers that need the part
    #: structure (the §3 `sites.json` overlay draws real polygons, not rings).
    geojson: dict | None = None

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        """(minX, minY, maxX, maxY) over every coordinate."""
        xs = [x for ring in self.rings for x, _y in ring]
        ys = [y for ring in self.rings for _x, y in ring]
        if not xs:
            raise GeoPackageError("empty geometry has no bbox")
        return (min(xs), min(ys), max(xs), max(ys))

    @property
    def representative_point(self) -> tuple[float, float]:
        """The point the pipeline centers a site on (national-scaleout.md §4.1).

        Polygon -> area-weighted centroid (holes subtracted); line -> the point
        halfway along the path by length; point -> itself. Degenerate cases
        (zero area, zero length) fall back to the mean of the vertices, which is
        always defined and always inside the data's own extent.
        """
        if self.kind == "polygon":
            point = _polygon_centroid(self.rings, self.holes)
            if point is not None:
                return point
        elif self.kind == "line":
            point = _line_midpoint(self.rings)
            if point is not None:
                return point
        return _vertex_mean(self.rings)


def _vertex_mean(rings: list[list[tuple[float, float]]]) -> tuple[float, float]:
    points = [p for ring in rings for p in ring]
    if not points:
        raise GeoPackageError("empty geometry has no representative point")
    return (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))


def _ring_area_centroid(ring: list[tuple[float, float]]) -> tuple[float, float, float]:
    """(signed area, cx*area, cy*area) by the shoelace formula."""
    area2 = 0.0
    cx = 0.0
    cy = 0.0
    for i in range(len(ring) - 1):
        x0, y0 = ring[i]
        x1, y1 = ring[i + 1]
        cross = x0 * y1 - x1 * y0
        area2 += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area = area2 / 2.0
    return area, cx / 6.0, cy / 6.0


def _polygon_centroid(
    rings: list[list[tuple[float, float]]], holes: list[bool]
) -> tuple[float, float] | None:
    total_area = 0.0
    sx = 0.0
    sy = 0.0
    for ring, is_hole in zip(rings, holes, strict=False):
        if len(ring) < 4:  # a closed ring needs at least 4 positions
            continue
        area, mx, my = _ring_area_centroid(ring)
        sign = -1.0 if is_hole else 1.0
        # Ring winding is not guaranteed in the wild, so use |area| with an
        # explicit hole sign rather than trusting the shoelace sign.
        total_area += sign * abs(area)
        scale = sign * (abs(area) / area if area else 0.0)
        sx += scale * mx
        sy += scale * my
    if abs(total_area) < 1e-9:
        return None
    return (sx / total_area, sy / total_area)


def _line_midpoint(rings: list[list[tuple[float, float]]]) -> tuple[float, float] | None:
    """The point at half the total path length, walking the parts in order."""
    segments: list[tuple[tuple[float, float], tuple[float, float], float]] = []
    total = 0.0
    for ring in rings:
        for i in range(len(ring) - 1):
            (x0, y0), (x1, y1) = ring[i], ring[i + 1]
            length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
            if length > 0:
                segments.append(((x0, y0), (x1, y1), length))
                total += length
    if total <= 0:
        return None
    half = total / 2.0
    walked = 0.0
    for (x0, y0), (x1, y1), length in segments:
        if walked + length >= half:
            t = (half - walked) / length
            return (x0 + t * (x1 - x0), y0 + t * (y1 - y0))
        walked += length
    return segments[-1][1]


def _read_wkb(buf: memoryview, offset: int) -> tuple[dict, int]:
    """Parse one WKB geometry at `offset` into a GeoJSON geometry dict.

    GeoJSON is the intermediate on purpose: it is what `fetch_sites` already
    speaks (it used to get it from `ogr2ogr -f GeoJSON`), and the registry's
    flattened view is derived from it below. Z/M ordinates are dropped — every
    consumer here is planimetric, and the KMR heights are not RH 2000 anyway.
    """
    if len(buf) < offset + 5:
        raise GeoPackageError("truncated WKB geometry")
    byte_order = buf[offset]
    if byte_order not in (0, 1):
        raise GeoPackageError(f"invalid WKB byte order {byte_order}")
    endian = "<" if byte_order == 1 else ">"
    (raw_type,) = struct.unpack_from(f"{endian}I", buf, offset + 1)
    offset += 5

    # 1000/2000/3000 offsets add Z / M / ZM ordinates after x, y.
    base = raw_type % 1000
    extra = {0: 0, 1: 1, 2: 1, 3: 2}.get(raw_type // 1000)
    if extra is None:
        raise GeoPackageError(f"unsupported WKB type code {raw_type}")
    stride = 2 + extra

    def read_points(count: int, at: int) -> tuple[list[list[float]], int]:
        values = struct.unpack_from(f"{endian}{count * stride}d", buf, at)
        points = [[values[i * stride], values[i * stride + 1]] for i in range(count)]
        return points, at + count * stride * 8

    def read_ring_list(at: int) -> tuple[list[list[list[float]]], int]:
        (ring_count,) = struct.unpack_from(f"{endian}I", buf, at)
        at += 4
        rings = []
        for _ in range(ring_count):
            (count,) = struct.unpack_from(f"{endian}I", buf, at)
            points, at = read_points(count, at + 4)
            rings.append(points)
        return rings, at

    if base == WKB_POINT:
        points, offset = read_points(1, offset)
        return {"type": "Point", "coordinates": points[0]}, offset
    if base == WKB_LINESTRING:
        (count,) = struct.unpack_from(f"{endian}I", buf, offset)
        points, offset = read_points(count, offset + 4)
        return {"type": "LineString", "coordinates": points}, offset
    if base == WKB_POLYGON:
        rings, offset = read_ring_list(offset)
        return {"type": "Polygon", "coordinates": rings}, offset

    if base in (WKB_MULTIPOINT, WKB_MULTILINESTRING, WKB_MULTIPOLYGON, WKB_GEOMETRYCOLLECTION):
        (part_count,) = struct.unpack_from(f"{endian}I", buf, offset)
        offset += 4
        parts = []
        for _ in range(part_count):
            part, offset = _read_wkb(buf, offset)
            parts.append(part)
        if base == WKB_GEOMETRYCOLLECTION:
            return {"type": "GeometryCollection", "geometries": parts}, offset
        name = {
            WKB_MULTIPOINT: "MultiPoint",
            WKB_MULTILINESTRING: "MultiLineString",
            WKB_MULTIPOLYGON: "MultiPolygon",
        }[base]
        return {"type": name, "coordinates": [p["coordinates"] for p in parts]}, offset

    raise GeoPackageError(f"unsupported WKB geometry type {base}")


#: GeoJSON type -> (registry geometry class, nesting depth of its coordinates).
_GEOJSON_KINDS = {
    "Point": ("point", 0),
    "MultiPoint": ("point", 1),
    "LineString": ("line", 1),
    "MultiLineString": ("line", 2),
    "Polygon": ("polygon", 2),
    "MultiPolygon": ("polygon", 3),
}


def _flatten(geojson: dict) -> tuple[str, list[list[tuple[float, float]]], list[bool]]:
    """GeoJSON geometry -> (kind, coordinate sequences, per-sequence hole flag)."""
    kind_depth = _GEOJSON_KINDS.get(geojson["type"])
    if kind_depth is None:
        if geojson["type"] != "GeometryCollection":
            raise GeoPackageError(f"unsupported geometry type {geojson['type']!r}")
        # A mixed collection is classified by its richest member — a polygon
        # extent is more useful to the pipeline than a stray point in the record.
        rings: list[list[tuple[float, float]]] = []
        holes: list[bool] = []
        kinds: list[str] = []
        for part in geojson.get("geometries", []):
            part_kind, part_rings, part_holes = _flatten(part)
            kinds.append(part_kind)
            rings.extend(part_rings)
            holes.extend(part_holes)
        for candidate in ("polygon", "line", "point"):
            if candidate in kinds:
                return candidate, rings, holes
        return "point", rings, holes

    kind, depth = kind_depth
    coords = geojson["coordinates"]
    if depth == 0:  # Point
        return kind, [[(coords[0], coords[1])]], [False]
    if depth == 1:  # MultiPoint / LineString
        return kind, [[(p[0], p[1]) for p in coords]], [False]
    if depth == 2:  # Polygon / MultiLineString
        sequences = [[(p[0], p[1]) for p in part] for part in coords]
        holes = [i > 0 for i in range(len(sequences))] if kind == "polygon" else [False] * len(sequences)
        return kind, sequences, holes
    # MultiPolygon: hole flags restart per part.
    sequences = []
    holes = []
    for polygon in coords:
        for index, ring in enumerate(polygon):
            sequences.append([(p[0], p[1]) for p in ring])
            holes.append(index > 0)
    return kind, sequences, holes


def parse_gpkg_geojson(blob: bytes) -> dict:
    """Parse a GPKG geometry BLOB into a GeoJSON geometry dict (EPSG:3006 coords)."""
    if blob is None or len(blob) < 8:
        raise GeoPackageError("geometry blob is empty or truncated")
    view = memoryview(blob)
    if bytes(view[0:2]) != b"GP":
        raise GeoPackageError(f"not a GeoPackage geometry blob (magic {bytes(view[0:2])!r})")
    flags = view[3]
    envelope_indicator = (flags >> 1) & 0x07
    envelope_doubles = {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}.get(envelope_indicator)
    if envelope_doubles is None:
        raise GeoPackageError(f"invalid envelope indicator {envelope_indicator}")
    if flags & 0x10:
        raise GeoPackageError("empty geometry")
    geojson, _end = _read_wkb(view, 8 + envelope_doubles * 8)
    return geojson


def parse_gpkg_geometry(blob: bytes) -> Geometry:
    """Parse a GPKG geometry BLOB into the registry's flattened `Geometry`."""
    geojson = parse_gpkg_geojson(blob)
    kind, rings, holes = _flatten(geojson)
    return Geometry(kind=kind, rings=rings, holes=holes, geojson=geojson)


def list_layers(path: Path) -> list[tuple[str, str]]:
    """(table_name, data_type) for every layer registered in `gpkg_contents`."""
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        rows = conn.execute("SELECT table_name, data_type FROM gpkg_contents").fetchall()
    return [(str(name), str(kind)) for name, kind in rows]


def geometry_column(path: Path, table: str) -> str:
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        row = conn.execute(
            "SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ?", (table,)
        ).fetchone()
    if row is None:
        raise GeoPackageError(f"{table} has no geometry column registered in the GeoPackage")
    return str(row[0])


def table_columns(path: Path, table: str) -> list[str]:
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        return [str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table}")')]


def has_rtree(path: Path, table: str) -> bool:
    """True when the GeoPackage carries the R*Tree spatial index for `table`."""
    geom_col = geometry_column(path, table)
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (f"rtree_{table}_{geom_col}",),
        ).fetchone()
    return row is not None


def read_features_bbox(
    path: Path,
    table: str,
    columns: list[str],
    bounds: tuple[float, float, float, float],
    where: str = "",
    params: tuple = (),
) -> Iterator[tuple[dict, Geometry]]:
    """Stream features whose geometry *envelope* intersects `bounds`.

    Uses the GeoPackage's R*Tree index when it has one, which is what makes a
    4x4 km window over a 2.3 GB national extract a millisecond query instead of
    a full table scan. Without an index it falls back to scanning and filtering
    on the parsed bbox — correct either way, just slower.

    Envelope intersection, not true intersection: a record whose bbox overlaps
    but whose geometry does not is kept. That matches `ogr2ogr -spat` (which the
    county path uses) and is the behaviour the overlay wants — geometries are
    never clipped, so a gravfält straddling the edge renders whole.
    """
    min_e, min_n, max_e, max_n = bounds
    geom_col = geometry_column(path, table)
    select = ", ".join(f'"{c}"' for c in columns)
    clauses = []
    query_params: list = []
    if has_rtree(path, table):
        rtree = f"rtree_{table}_{geom_col}"
        sql = (
            f'SELECT {select}, t."{geom_col}" FROM "{table}" t '
            f'JOIN "{rtree}" r ON t.rowid = r.id '
            f"WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?"
        )
        query_params += [min_e, max_e, min_n, max_n]
        if where:
            sql += f" AND {where}"
            query_params += list(params)
        rows_need_bbox_filter = False
    else:
        sql = f'SELECT {select}, "{geom_col}" FROM "{table}"'
        if where:
            clauses.append(where)
            query_params += list(params)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        rows_need_bbox_filter = True

    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        for row in conn.execute(sql, tuple(query_params)):
            blob = row[-1]
            if blob is None:
                continue
            try:
                geometry = parse_gpkg_geometry(blob)
            except GeoPackageError:
                continue
            if rows_need_bbox_filter:
                g_min_e, g_min_n, g_max_e, g_max_n = geometry.bbox
                if g_max_e < min_e or g_min_e > max_e or g_max_n < min_n or g_min_n > max_n:
                    continue
            yield dict(zip(columns, row[:-1], strict=True)), geometry


def read_features(
    path: Path,
    table: str,
    columns: list[str],
    where: str = "",
    params: tuple = (),
) -> Iterator[tuple[dict, Geometry]]:
    """Stream (attributes, geometry) for every row matching `where`.

    Streaming matters: the national extract is 2.3 GB and holds ~1.9 M records,
    of which the registry keeps ~1 300. Rows are yielded as they arrive rather
    than materialised.
    """
    geom_col = geometry_column(path, table)
    select = ", ".join(f'"{c}"' for c in columns)
    sql = f'SELECT {select}, "{geom_col}" FROM "{table}"'
    if where:
        sql += f" WHERE {where}"
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
        for row in conn.execute(sql, params):
            blob = row[-1]
            if blob is None:
                continue
            attributes = dict(zip(columns, row[:-1], strict=True))
            try:
                geometry = parse_gpkg_geometry(blob)
            except GeoPackageError:
                # A record whose geometry we cannot read is a record we cannot
                # place; the registry counts it rather than guessing a location.
                continue
            yield attributes, geometry
