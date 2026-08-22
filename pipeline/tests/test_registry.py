"""National registry builder (scale-out §4.1). No network — a synthetic KMR file.

The registry is what every batch run is reproducible against, so the tests pin
the parts that would quietly corrupt a whole national build: slug derivation,
the polygon-wins deduplication, the §5.2 preset threshold, and the guarantee
that a record we cannot place is dropped and counted rather than guessed at.
"""

from __future__ import annotations

import sqlite3

import pytest

from fornborg_pipeline.registry import (
    PRESET_LARGE,
    PRESET_STANDARD,
    RegistryError,
    build_registry,
    entry_from,
    fornborg_layers,
    get_entry,
    load_registry,
    preset_for,
    slug_for,
    write_registry,
)
from test_gpkg import gpkg_blob, wkb_point, wkb_polygon


def square(center_e: float, center_n: float, span: float):
    half = span / 2.0
    return [
        [
            (center_e - half, center_n - half),
            (center_e + half, center_n - half),
            (center_e + half, center_n + half),
            (center_e - half, center_n + half),
            (center_e - half, center_n - half),
        ]
    ]


COLUMNS = (
    "uuid TEXT, lamningsnummer TEXT, raa_nummer TEXT, lamningsnamn TEXT, "
    "lamningstyp TEXT, antikvariskbedomning TEXT, lan TEXT, kommun TEXT, geom BLOB"
)


@pytest.fixture
def kmr(tmp_path):
    """A miniature `lämningar_sverige.gpkg` with the three geometry layers."""
    path = tmp_path / "lamningar_sverige.gpkg"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT)")
    conn.execute("CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT)")
    for suffix in ("polygon", "linestring", "point"):
        table = f"lämningar_sverige_{suffix}"
        conn.execute(f'CREATE TABLE "{table}" ({COLUMNS})')
        conn.execute("INSERT INTO gpkg_contents VALUES (?, 'features')", (table,))
        conn.execute("INSERT INTO gpkg_geometry_columns VALUES (?, 'geom')", (table,))
        # The real riket file carries the KMR schema twice: these bare
        # relational geometry tables sit alongside the denormalized layers
        # above, match the same name-suffix test, and are useless — they hold
        # no attributes at all. The fixture has to include them or the layer
        # selection would be tested against a file simpler than reality.
        conn.execute(f'CREATE TABLE "{suffix}" (fid INTEGER, lamning_uuid TEXT, geom BLOB)')
        conn.execute("INSERT INTO gpkg_contents VALUES (?, 'features')", (suffix,))
        conn.execute("INSERT INTO gpkg_geometry_columns VALUES (?, 'geom')", (suffix,))

    def row(uuid, nummer, namn, typ, bedomning, lan, blob):
        return (uuid, nummer, f"RAÄ {namn}", namn, typ, bedomning, lan, "Knivsta", blob)

    conn.executemany(
        'INSERT INTO "lämningar_sverige_polygon" VALUES (?,?,?,?,?,?,?,?,?)',
        [
            row("u1", "L1943:7827", "Broborg", "Fornborg", "Fornlämning", "Uppsala",
                gpkg_blob(wkb_polygon(square(665810.0, 6627880.0, 140.0)))),
            row("u2", "L1976:4254", "Torsburgen", "Fornborg", "Fornlämning", "Gotland",
                gpkg_blob(wkb_polygon(square(700000.0, 6380000.0, 1400.0)))),
            row("u3", "L0000:0001", "Ej fornborg", "Gravfält", "Fornlämning", "Uppsala",
                gpkg_blob(wkb_polygon(square(600000.0, 6600000.0, 100.0)))),
        ],
    )
    conn.executemany(
        'INSERT INTO "lämningar_sverige_point" VALUES (?,?,?,?,?,?,?,?,?)',
        [
            # Same site as the polygon above: the polygon must win.
            row("u1", "L1943:7827", "Broborg", "Fornborg", "Fornlämning", "Uppsala",
                gpkg_blob(wkb_point(665000.0, 6627000.0))),
            row("u4", "L2000:0009", "Punktborg", "Fornborg", "Möjlig fornlämning", "Kalmar",
                gpkg_blob(wkb_point(600123.0, 6300456.0))),
            # Unplaceable: no geometry at all.
            row("u5", "L2000:0010", "Utan geometri", "Fornborg", "Fornlämning", "Kalmar", None),
        ],
    )
    conn.commit()
    conn.close()
    return path


# ------------------------------------ slugs ---------------------------------


@pytest.mark.parametrize(
    ("nummer", "expected"),
    [
        ("L1943:7827", "l1943-7827"),
        ("l1943:7827", "l1943-7827"),
        ("  L1976:4254  ", "l1976-4254"),
        ("L1964:7416", "l1964-7416"),
    ],
)
def test_slug_shape(nummer, expected):
    assert slug_for(nummer) == expected


def test_slug_is_a_safe_path_and_query_segment():
    """The slug lands in an R2 key and in the app's `?site=` guard."""
    slug = slug_for("L 1943/7827 (a)")
    assert slug.startswith(tuple("abcdefghijklmnopqrstuvwxyz0123456789"))
    assert all(c.isalnum() or c in "._-" for c in slug)
    assert ".." not in slug and "/" not in slug


def test_slug_requires_a_lamningsnummer():
    with pytest.raises(RegistryError):
        slug_for("")


# ------------------------------------ presets -------------------------------


@pytest.mark.parametrize(
    ("span", "preset"),
    [(140.0, PRESET_STANDARD), (999.9, PRESET_STANDARD), (1000.0, PRESET_STANDARD),
     (1000.1, PRESET_LARGE), (5900.0, PRESET_LARGE)],
)
def test_preset_threshold(span, preset):
    assert preset_for(span) == preset


# ------------------------------------ entries -------------------------------


def test_entry_from_a_polygon_record():
    geom_blob = gpkg_blob(wkb_polygon(square(665808.0, 6627881.0, 140.0)))
    from fornborg_pipeline.gpkg import parse_gpkg_geometry

    entry = entry_from(
        {
            "uuid": "184ca0f6-16f9-4de8-bbec-99aa959f9824",
            "lamningsnummer": "L1943:7827",
            "lamningsnamn": "Broborg",
            "raa_nummer": "Husby-Långhundra 156:1",
            "antikvariskbedomning": "Fornlämning",
            "lan": "Uppsala",
            "kommun": "Knivsta",
        },
        parse_gpkg_geometry(geom_blob),
    )
    assert entry.slug == "l1943-7827"
    # Broborg's [phase-0 verified] center, rounded to 10 m as sites.py carries it.
    assert (entry.centerE, entry.centerN) == (665810.0, 6627880.0)
    assert entry.geometryClass == "polygon"
    assert entry.extentPreset == PRESET_STANDARD
    assert entry.extentSpanM == pytest.approx(140.0)
    assert entry.fornsokUrl.endswith("184ca0f6-16f9-4de8-bbec-99aa959f9824")


def test_entry_falls_back_to_the_lamningsnummer_when_unnamed():
    from fornborg_pipeline.gpkg import parse_gpkg_geometry

    entry = entry_from(
        {"lamningsnummer": "L2000:0009", "lamningsnamn": None},
        parse_gpkg_geometry(gpkg_blob(wkb_point(1.0, 2.0))),
    )
    assert entry.name == "L2000:0009"
    assert entry.fornsokUrl == ""  # no uuid -> no Fornsök link, rather than a broken one


# ------------------------------------ the build -----------------------------


def test_layers_are_scanned_polygon_first(kmr):
    layers = fornborg_layers(kmr)
    assert layers[0].endswith("polygon")
    assert layers[-1].endswith("point")


def test_the_attribute_free_relational_layers_are_ignored(kmr):
    """The riket file's bare `polygon`/`point`/`linestring` tables carry no attributes."""
    assert fornborg_layers(kmr) == [
        "lämningar_sverige_polygon",
        "lämningar_sverige_linestring",
        "lämningar_sverige_point",
    ]


def test_a_file_with_no_usable_layer_says_so(tmp_path):
    import sqlite3

    path = tmp_path / "useless.gpkg"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE gpkg_contents (table_name TEXT, data_type TEXT)")
    conn.execute("CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT)")
    conn.execute("CREATE TABLE polygon (fid INTEGER, lamning_uuid TEXT, geom BLOB)")
    conn.execute("INSERT INTO gpkg_contents VALUES ('polygon', 'features')")
    conn.execute("INSERT INTO gpkg_geometry_columns VALUES ('polygon', 'geom')")
    conn.commit()
    conn.close()
    with pytest.raises(RegistryError, match="lamningstyp"):
        fornborg_layers(path)


def test_build_registry_selects_only_fornborgar(kmr):
    registry = build_registry(kmr)
    slugs = [site["slug"] for site in registry["sites"]]
    assert slugs == ["l1943-7827", "l1976-4254", "l2000-0009"]
    assert "l0000-0001" not in slugs  # the Gravfält record


def test_the_polygon_record_wins_over_the_point_record(kmr):
    registry = build_registry(kmr)
    broborg = next(s for s in registry["sites"] if s["slug"] == "l1943-7827")
    assert broborg["geometryClass"] == "polygon"
    assert (broborg["centerE"], broborg["centerN"]) == (665810.0, 6627880.0)
    assert registry["stats"]["duplicates"] == 1


def test_unplaceable_records_are_dropped_and_counted(kmr):
    registry = build_registry(kmr)
    assert "l2000-0010" not in [s["slug"] for s in registry["sites"]]
    # It was selected by the type filter but never became an entry.
    assert registry["stats"]["scanned"] > registry["stats"]["kept"]


def test_large_preset_is_assigned_to_the_giant_site(kmr):
    registry = build_registry(kmr)
    large = registry["stats"]["largePresetSites"]
    assert [s["slug"] for s in large] == ["l1976-4254"]
    torsburgen = next(s for s in registry["sites"] if s["slug"] == "l1976-4254")
    assert torsburgen["extentPreset"] == PRESET_LARGE


def test_registry_records_its_provenance(kmr):
    registry = build_registry(kmr)
    assert registry["crs"] == "EPSG:3006"
    assert registry["source"]["lamningstyp"] == "Fornborg"
    assert registry["source"]["file"] == kmr.name
    assert registry["schemaVersion"] == 1


def test_build_registry_refuses_an_empty_result(kmr):
    with pytest.raises(RegistryError, match="no 'Runristning' records"):
        build_registry(kmr, lamningstyp="Runristning")


def test_summarize_reports_the_distribution(kmr):
    stats = build_registry(kmr)["stats"]
    assert stats["count"] == 3
    assert stats["byCounty"]["Uppsala"] == 1
    assert stats["byBedomning"]["Möjlig fornlämning"] == 1
    assert stats["extentSpanM"]["max"] == pytest.approx(1400.0)


def test_registry_roundtrips_through_disk(tmp_path, kmr):
    out = tmp_path / "registry.json"
    write_registry(out, build_registry(kmr))
    loaded = load_registry(out)
    assert len(loaded["sites"]) == 3
    assert get_entry("l1943-7827", out)["name"] == "Broborg"
    with pytest.raises(RegistryError, match="no registry entry"):
        get_entry("nope", out)
    # Swedish names survive the JSON round trip unescaped.
    assert "Fornlämning" in out.read_text(encoding="utf-8")


def test_load_registry_says_how_to_build_it_when_missing(tmp_path):
    with pytest.raises(RegistryError, match="registry --build"):
        load_registry(tmp_path / "absent.json")


# ------------------------------- registry search -----------------------------


def test_find_matches_name_number_slug_and_county(tmp_path, kmr):
    out = tmp_path / "registry.json"
    write_registry(out, build_registry(kmr))
    from fornborg_pipeline.registry import find_entries

    assert [s["slug"] for s in find_entries("Broborg", out)] == ["l1943-7827"]
    assert [s["slug"] for s in find_entries("L1976:4254", out)] == ["l1976-4254"]
    assert [s["slug"] for s in find_entries("l2000-0009", out)] == ["l2000-0009"]
    assert {s["slug"] for s in find_entries("Uppsala", out)} == {"l1943-7827"}


def test_find_folds_diacritics_and_case(tmp_path, kmr):
    """A curated list typed on a non-Swedish keyboard still resolves to slugs."""
    out = tmp_path / "registry.json"
    write_registry(out, build_registry(kmr))
    from fornborg_pipeline.registry import find_entries

    assert [s["slug"] for s in find_entries("broborg", out)] == ["l1943-7827"]
    assert [s["slug"] for s in find_entries("TORSBURGEN", out)] == ["l1976-4254"]


def test_find_returns_nothing_for_an_unknown_name(tmp_path, kmr):
    out = tmp_path / "registry.json"
    write_registry(out, build_registry(kmr))
    from fornborg_pipeline.registry import find_entries

    assert find_entries("Camelot", out) == []
    assert find_entries("", out) == []
