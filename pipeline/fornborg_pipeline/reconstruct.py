"""Reconstruction parameters parsed out of KMR descriptions (contract §14).

`docs/reconstruction-mode.md` is the specification this module implements. The
short version:

  * **Every number in the register is a ruin measurement** (§5). "Hög, 7 m diam,
    0,7 m h" is a mound that has stood for fifteen centuries and slumped. So the
    parser does not just extract dimensions — it applies the document's three
    stated, reversible ruin→original transforms (§5.1 rampart apron, §5.2
    kerb-gated re-profiling, §5.3 robbing-pit fill) and records which one it used.
  * **The register is parseable** (§3). RAÄ free text is a semi-formulaic
    surveyor's shorthand: `<Typ>, <form>, <plan size> (<orientation>), <height> h,
    <surface>. Kantkedja <height> h av <stone size> st stenar.` 92 % of the
    committed Broborg bundle carries a plan size, 87 % a stone range, 54 % a kerb.
  * **A `Gravfält` record is a compositional recipe** (§3.1), not a shape: it
    enumerates its own contents with a size range per class. It is parsed into a
    sampler specification, never into one big blob.
  * **Nothing is invented silently.** Where a field cannot be parsed the archetype
    default is used, the field's `source` says `assumed`, its name is appended to
    `fallbacks`, and `parseConfidence` drops. 8 % of records have no parseable plan
    size at all and this is the whole reason that machinery exists.

Output is `reconstruction.json` per docs/data-formats.md §14: **no coordinates and
no ground heights** — the file joins back to `sites.json` by `id` for position and
extent geometry, and the app samples ground height at runtime. Monument heights
*above ground* are the point of the file; ground elevation never enters it.

Everything except `run()` is a pure function of strings and dicts: no network, no
credentials, no rasters. `pipeline/tests/test_reconstruct.py` exercises the whole
parser against the committed Broborg bundle and pins the §3 coverage percentages
as a regression target.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import click

from .manifest import add_reconstruction_asset, validate_manifest, write_manifest
from .sites import SITES, SiteConfig, get_site

RECONSTRUCTION_PATH = "reconstruction.json"
SCHEMA_VERSION = 1
DERIVATION_METHOD = "kmr-description-parse"

PROCESSING_STEP = (
    "reconstruction parameters parsed from KMR descriptions with the "
    "docs/reconstruction-mode.md §5 ruin→original transforms applied"
)


class ReconstructError(RuntimeError):
    """The reconstruction could not produce a file worth committing."""


# --------------------------------------------------------------------------- #
# §4 taxonomy — lamningstyp → archetype key
# --------------------------------------------------------------------------- #

#: Grouping rule is *shared geometry recipe*, not register label (§4). All 26
#: types in `fetch_sites.SELECTED_TYPES` are mapped so a site elsewhere in the
#: country cannot fall through; the app decides which archetypes it can draw.
ARCHETYPES: dict[str, str] = {
    # A — fort / rampart work
    "Fornborg": "fort",
    # B — earth mound
    "Hög": "mound",
    # C — stone setting and kin
    "Stensättning": "stone-setting",
    "Grav markerad av sten/block": "stone-setting",
    "Flatmarksgrav": "stone-setting",
    "Gravgrupp": "stone-setting",
    # D — cairn
    "Röse": "cairn",
    # E — fire-cracked stone mound
    "Skärvstenshög": "fire-cracked-mound",
    # F — standing stone & stone figure
    "Stenkammargrav": "standing-stone",
    # G — grave field (a sampler over B–F)
    "Gravfält": "grave-field",
    "Grav- och boplatsområde": "grave-field",
    # H — farmstead. Parsed so the contract is complete; explicitly out of scope
    # for the app this pass (§6.H: least evidenced, most persuasive).
    "Boplats": "farmstead",
    "Boplatsområde": "farmstead",
    "Boplatslämning övrig": "farmstead",
    "Boplatsvall": "farmstead",
    "Husgrund, förhistorisk/medeltida": "farmstead",
    # I — field boundary
    "Hägnad": "field-boundary",
    "Hägnadssystem": "field-boundary",
    # J — cultivated ground
    "Fossil åker": "cultivated-ground",
    "Område med fossil åkermark": "cultivated-ground",
    "Röjningsröse": "clearance-cairn",
    "Röjningsröseområde": "cultivated-ground",
    "Terrassering": "cultivated-ground",
    # K — route & monument stone
    "Färdväg": "route",
    "Färdvägssystem": "route",
    "Runristning": "runestone",
}

#: §8 — the archetypes are not contemporaneous, and pretending otherwise is the
#: single most likely way this feature ends up lying. Visibility gate only in v1
#: (owner decision, §11.4): one "in use" state plus these built/abandoned years.
#: Signed astronomical years; `null` either side means "not gated".
PERIODS: dict[str, tuple[int | None, int | None]] = {
    "fort": (400, 550),
    "mound": (400, 1050),
    "stone-setting": (-500, 1050),
    "cairn": (-1700, -500),
    "fire-cracked-mound": (-1700, -500),
    "standing-stone": (-1000, 1050),
    "grave-field": (-500, 1050),
    "farmstead": (-500, 1050),
    "field-boundary": (0, 550),
    "cultivated-ground": (-1700, 1600),
    "clearance-cairn": (-1700, 1600),
    "route": (None, None),
    "runestone": (950, None),
}


# --------------------------------------------------------------------------- #
# archetype defaults — every one of these is a *labelled literature default*
# (§1) and is written into the file so the app can expose it as a tunable
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ArchetypeDefault:
    """Fallback dimensions for a record whose text says nothing usable.

    Corpus medians from `docs/reconstruction-mode.md` §5/§6 unless noted. These
    are used only where parsing fails, and every use is recorded in the
    monument's `fallbacks` list — never applied silently.
    """

    diameter_m: float
    height_m: float
    stone_m: tuple[float, float]
    #: Which §5.2 angle of repose applies: "earth" (30°) or "stone" (35°). The
    #: angles themselves live in `TransformParams`, so they stay tunable.
    material: str
    #: Whether the §5.2 re-profile applies at all. A stone setting must never
    #: gain height — flatness is the type (§6.C) — and a fire-cracked mound
    #: accumulated rather than being built, so its 7.6° is near original (§6.E).
    reprofile: bool
    form: str = "round"


ARCHETYPE_DEFAULTS: dict[str, ArchetypeDefault] = {
    "mound": ArchetypeDefault(7.0, 0.7, (0.2, 0.3), "earth", True),
    "stone-setting": ArchetypeDefault(6.0, 0.4, (0.2, 0.4), "stone", False),
    "cairn": ArchetypeDefault(7.0, 0.6, (0.4, 0.6), "stone", True),
    "fire-cracked-mound": ArchetypeDefault(6.0, 0.4, (0.03, 0.2), "stone", False),
    "standing-stone": ArchetypeDefault(1.0, 1.4, (0.6, 1.4), "stone", False),
    "grave-field": ArchetypeDefault(6.0, 0.4, (0.2, 0.4), "stone", False),
    "clearance-cairn": ArchetypeDefault(5.0, 0.35, (0.2, 0.5), "stone", False),
    "field-boundary": ArchetypeDefault(1.0, 0.85, (1.0, 2.0), "stone", False),
    "cultivated-ground": ArchetypeDefault(30.0, 0.3, (0.2, 0.5), "stone", False),
    "farmstead": ArchetypeDefault(30.0, 1.0, (0.2, 0.5), "stone", False),
    "runestone": ArchetypeDefault(1.0, 1.9, (0.6, 1.2), "stone", False),
    "route": ArchetypeDefault(2.0, 0.0, (0.05, 0.2), "stone", False),
    "fort": ArchetypeDefault(120.0, 1.5, (0.3, 1.0), "stone", False),
}


@dataclass(frozen=True)
class TransformParams:
    """The §5 transform constants. Written into `derivation.params` verbatim.

    Named and defaulted here so a reader can check the arithmetic against the
    document's own tables — §5.1's parameter box and §5.2's worked median mound.
    """

    #: §5.1 — packing difference between built wall and fallen rubble.
    packing: float = 0.85
    #: §5.1 — mean depth of the fallen debris apron, m.
    apron_depth_m: float = 0.45
    #: §5.1 — dry-stone wall body thickness. Measured 4–6 m at Broborg
    #: (Kresten, Kero & Chyssler 1993); an assumption anywhere else.
    wall_thickness_m: float = 5.0
    #: §5.2 — angle of repose, loose earth and turf.
    repose_earth_deg: float = 30.0
    #: §5.2 — angle of repose, dry-stacked stone.
    repose_stone_deg: float = 35.0
    #: §5.3 — a robbing pit is a shallow bowl, not a box: the fraction of its
    #: bounding prism that is actually missing material.
    pit_fill_factor: float = 0.5
    #: §6.A.1 — the Mälardalen survey's operational definition, as a score.
    #: At or above this a `Fornborg` renders as a standing Migration Period
    #: rampart; below it, as a low bank.
    fort_confidence_threshold: float = 0.6


DEFAULT_PARAMS = TransformParams()


# --------------------------------------------------------------------------- #
# number and text primitives — Swedish surveyor's shorthand
# --------------------------------------------------------------------------- #

#: A Swedish decimal number: comma separator, optional thousands-free integer.
NUM = r"\d+(?:[,.]\d+)?"
#: "ca", "c:a", "omkr" — the surveyor's hedge, which never changes the number.
CA = r"(?:c(?:a|:a)|omkr(?:ing)?)\.?\s*"
#: Swedish letters, for word-boundary work `\b` gets wrong on å/ä/ö.
LETTER = r"a-zA-ZåäöÅÄÖ"


def _to_float(text: str | None) -> float | None:
    """`"0,3"` → `0.3`. Returns None for anything unparseable."""
    if text is None:
        return None
    try:
        value = float(text.replace(",", "."))
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(value + 0.0, digits)


def normalise(text: str) -> str:
    """Collapse whitespace and NFC-normalise, leaving the words untouched.

    KMR text arrives with hard-wrapped line breaks glued into words (`"ca7 m"`,
    `"medmedelstora"`). Whitespace is normalised; the glue is not repaired,
    because repairing it would mean guessing, and the numeric patterns below
    tolerate a missing space after `ca` anyway.
    """
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip()


def word_pattern(*stems: str) -> re.Pattern[str]:
    """Case-insensitive whole-word match over Swedish letters.

    `\\b` is unreliable next to å/ä/ö in some engines and — more importantly —
    `hög` must not match inside `skärvstenshög` or `högliknande`, which a
    substring search would.
    """
    body = "|".join(stems)
    return re.compile(rf"(?<![{LETTER}])(?:{body})(?![{LETTER}])", re.IGNORECASE)


def split_clauses(text: str) -> list[str]:
    """Split a description into sentence-ish clauses.

    Deliberately conservative: a period is a boundary only when it is followed by
    whitespace and a capital or a digit, and is not part of a decimal number or a
    one-letter abbreviation. Over-splitting is cheap here (each clause is parsed
    independently and the one naming the record's own type wins); under-splitting
    is not.
    """
    if not text:
        return []
    parts = re.split(rf"(?<=[.!?])\s+(?=[A-ZÅÄÖ0-9])", text)
    return [p.strip() for p in parts if p.strip()]


#: Type keywords per `lamningstyp`, used to find the clause that describes the
#: record's *own* headline monument. Several Broborg descriptions open with a
#: neighbouring monument ("1) Stensättning … 2) Hög …" on a record typed `Hög`),
#: so "first sentence" alone would parse the wrong thing.
TYPE_WORDS: dict[str, tuple[str, ...]] = {
    "fort": ("fornborg", "fornborgen", "borgen", "borg"),
    "mound": ("hög", "högen", "högar", "högarna"),
    "stone-setting": (
        "stensättning",
        "stensättningen",
        "stensättningar",
        "stensättningarna",
        "grav",
        "graven",
    ),
    "cairn": ("röse", "röset", "rösen", "rösena"),
    "fire-cracked-mound": ("skärvstenshög", "skärvstenshögen", "skärvstenshögar"),
    "standing-stone": ("stenkammargrav", "hällkista", "rest", "resta"),
    "grave-field": ("gravfält", "gravfältet", "grav-", "boplatsområde"),
    "farmstead": ("boplats", "boplatsen", "boplatsområde", "husgrund", "boplatsvall"),
    "field-boundary": ("hägnad", "hägnaden", "stensträng", "stensträngar"),
    "cultivated-ground": ("åker", "åkermark", "terrassering", "röjningsröseområde"),
    "clearance-cairn": ("röjningsröse", "röjningsrösen"),
    "route": ("färdväg", "färdvägen", "hålväg", "hålvägar"),
    "runestone": ("runristning", "runsten", "runstenen"),
}


def type_clause(text: str, archetype: str) -> str:
    """The clause describing the record's own headline monument.

    Falls back to the first clause, then to the whole text — §3 measured 85 % of
    plan sizes in the first sentence, so the fallback is usually right too.
    """
    clauses = split_clauses(text)
    if not clauses:
        return ""
    words = TYPE_WORDS.get(archetype)
    if words:
        pattern = word_pattern(*words)
        for clause in clauses:
            if pattern.search(clause):
                return clause
    return clauses[0]


# --------------------------------------------------------------------------- #
# field parsers — one per line of the §3 grammar
# --------------------------------------------------------------------------- #

_DIAM = re.compile(
    rf"(?:{CA})?({NUM})\s*(?:-\s*({NUM})\s*)?m(?:eter)?\s*(?:i\s+)?diam(?:eter)?",
    re.IGNORECASE,
)
_RECT = re.compile(
    rf"(?:{CA})?({NUM})\s*[x×]\s*({NUM})\s*m(?:eter)?\b(?!\s*(?:st|stora|dj))"
    rf"(?:\s*\(\s*([NSÖVWEnsövwe]{{1,3}}\s*-\s*[NSÖVWEnsövwe]{{1,3}})\s*\))?",
    re.IGNORECASE,
)
_HEIGHT = re.compile(
    rf"(?:{CA})?({NUM})\s*(?:-\s*(?:{CA})?({NUM})\s*)?m(?:eter)?\s*h(?:ög|öjd)?(?![{LETTER}])",
    re.IGNORECASE,
)
# The leading lookbehind matters: `2x2-7x7 m st (NV-SÖ)` is a *plan size* range
# ("stora"), not a stone calibre, and without the guard the `7 m st` tail of it
# would be read as 7-metre building stone.
_STONE = re.compile(
    rf"(?<![x×\d,.])(?:{CA})?({NUM})\s*(?:-\s*({NUM})\s*)?m(?:eter)?\s*st(?:or|ora|orlek)?(?![{LETTER}])",
    re.IGNORECASE,
)
_DEPTH = re.compile(
    rf"(?:{CA})?({NUM})\s*(?:-\s*({NUM})\s*)?m(?:eter)?\s*dj(?:up)?(?![{LETTER}])",
    re.IGNORECASE,
)
_LENGTH = re.compile(
    rf"(?:{CA})?({NUM})\s*(?:-\s*({NUM})\s*)?m(?:eter)?\s*l(?:ång|)(?![{LETTER}])",
    re.IGNORECASE,
)
_WIDTH = re.compile(
    rf"(?:{CA})?({NUM})\s*(?:-\s*({NUM})\s*)?m(?:eter)?\s*br(?:ed|)(?![{LETTER}])",
    re.IGNORECASE,
)

#: §3 form vocabulary. `högliknande` is a *profile* hint, not a plan form.
FORM_WORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("square", ("kvadratisk", "kvadratiska", "kvadratiskt")),
    ("rectangular", ("rektangulär", "rektangulära", "rektangulärt", "avlång", "avlånga")),
    ("oval", ("oval", "ovala", "ovalt")),
    ("triangular", ("trekantig", "trekantiga", "triangulär", "treudd", "treuddar")),
    ("round", ("rund", "runt", "runda", "cirkelrund", "cirkulär")),
)

_TURF = word_pattern(
    "övertorvad", "övertorvade", "övertorvat", "torvbevuxen", "övermossad",
    "övermossade", "mossbevuxen", "grästorv",
)
_FILLED = word_pattern("fylld", "fyllda", "fyllt")
_UNFILLED = word_pattern("ofylld", "ofyllda")
_CENTRE_STONE = re.compile(
    r"(mittblock|mittsten|klumpsten|jordfast\s+sten|block\s+i\s+(?:centrum|mitten)"
    r"|sten\s+i\s+(?:centrum|mitten))",
    re.IGNORECASE,
)
_DAMAGE = word_pattern(
    "plundrad", "plundrat", "utgrävning", "utgrävd", "skadad", "skadat",
    "bortodlad", "borttagen", "förstörd", "sönderodlad", "omplockad", "omplockat",
)
_KERB = word_pattern("kantkedja", "kantkedjan", "kantkedjor", "kantkedjer")
_DRYSTONE = word_pattern("kallmurning", "kallmurad", "kallmur", "kallmurar", "kallmurat")
_PIT = word_pattern("grop", "gropen", "gropar", "groparna")


def _range(lo: float | None, hi: float | None) -> list[float] | None:
    """A `[lo, hi]` pair from an optional range match; `None` when nothing parsed."""
    if lo is None:
        return None
    if hi is None:
        return [_round(lo), _round(lo)]
    return [_round(min(lo, hi)), _round(max(lo, hi))]


def _mid(values: list[float] | None) -> float | None:
    return None if values is None else _round((values[0] + values[1]) / 2)


def parse_form(text: str) -> str | None:
    """Plan form word from the text, or None. `round` is checked last on purpose:
    `rund` is a substring risk next to `rundad`, and the more specific forms win."""
    for form, stems in FORM_WORDS:
        if word_pattern(*stems).search(text):
            return form
    return None


def parse_plan(clause: str) -> dict:
    """Plan form and size (§3: 92 % coverage across the corpus).

    Handles both idioms the grammar uses — `N m diam` (round) and `A x B m
    (orientation)` (rectangular/oval) — and never guesses one from the other.
    """
    out: dict = {
        "form": None,
        "diameterM": None,
        "lengthM": None,
        "widthM": None,
        "orientation": None,
    }
    form = parse_form(clause)

    diam = _DIAM.search(clause)
    if diam:
        span = _range(_to_float(diam.group(1)), _to_float(diam.group(2)))
        out["diameterM"] = _mid(span)
        out["form"] = form or "round"
        return out

    rect = _RECT.search(clause)
    if rect:
        a = _to_float(rect.group(1))
        b = _to_float(rect.group(2))
        if a is not None and b is not None:
            out["lengthM"] = _round(max(a, b))
            out["widthM"] = _round(min(a, b))
            out["diameterM"] = _round(math.sqrt(a * b))  # equal-area circle
            out["orientation"] = (rect.group(3) or "").upper().replace(" ", "") or None
            if form in ("oval", "triangular"):
                out["form"] = form
            elif form == "round":
                # "rund … 3x4 m" happens; the measured pair is the stronger signal.
                out["form"] = "oval"
            else:
                out["form"] = form or ("square" if abs(a - b) < 1e-9 else "rectangular")
        return out

    out["form"] = form
    return out


def parse_height(clause: str) -> float | None:
    """Present (ruin) height in metres. A stated range takes its midpoint."""
    match = _HEIGHT.search(clause)
    if not match:
        return None
    return _mid(_range(_to_float(match.group(1)), _to_float(match.group(2))))


def parse_stone(text: str) -> list[float] | None:
    """Constituent stone calibre range (§3: 87 % coverage) — drives the instancing."""
    match = _STONE.search(text)
    if not match:
        return None
    return _range(_to_float(match.group(1)), _to_float(match.group(2)))


def parse_kerb(text: str) -> dict | None:
    """`kantkedja` and its own height and stone calibre (§3: 54 % coverage).

    This is the single most consequential parse in the module: §5.2 gates the
    whole mound re-profiling on whether a kerb was recorded, because a kerb fixes
    the monument's original footprint.
    """
    match = _KERB.search(text)
    if not match:
        return None
    window = text[match.start() : match.start() + 160]
    height = parse_height(window)
    stone = parse_stone(window)
    return {"heightM": height, "stoneM": stone}


def parse_pits(text: str) -> list[dict]:
    """Robbing pits with dimensions (§3: 32 % coverage; filled by §5.3).

    Plundering and antiquarian digging, not original features — and because they
    are parseable *with dimensions*, filling them is a measured operation.
    """
    pits: list[dict] = []
    for match in _PIT.finditer(text):
        window = text[match.start() : match.start() + 140]
        depth_match = _DEPTH.search(window)
        if not depth_match:
            continue
        depth = _mid(_range(_to_float(depth_match.group(1)), _to_float(depth_match.group(2))))
        rect = _RECT.search(window)
        diam = _DIAM.search(window)
        if rect:
            a, b = _to_float(rect.group(1)), _to_float(rect.group(2))
            if a is None or b is None:
                continue
            length, width = _round(max(a, b)), _round(min(a, b))
        elif diam:
            d = _mid(_range(_to_float(diam.group(1)), _to_float(diam.group(2))))
            if d is None:
                continue
            length = width = d
        else:
            continue
        if depth is None or depth <= 0:
            continue
        pits.append({"lengthM": length, "widthM": width, "depthM": depth})
    return pits


# --------------------------------------------------------------------------- #
# §5 — the ruin → original transforms
# --------------------------------------------------------------------------- #


def cap_volume(diameter_m: float, height_m: float) -> float:
    """Volume of a spherical cap of base diameter `d` and height `h` (§5.2)."""
    a = diameter_m / 2.0
    return (math.pi * height_m / 6.0) * (3.0 * a * a + height_m * height_m)


def pit_volume(pits: list[dict], fill_factor: float) -> float:
    """Missing material in the recorded robbing pits (§5.3).

    A pit is a shallow bowl, not a box, so only `fill_factor` of its bounding
    prism is treated as missing. The dimensions themselves are measured.
    """
    total = 0.0
    for pit in pits:
        length = pit.get("lengthM") or 0.0
        width = pit.get("widthM") or 0.0
        depth = pit.get("depthM") or 0.0
        total += length * width * depth * fill_factor
    return total


def cap_height_for_volume(diameter_m: float, volume_m3: float) -> float:
    """Invert `cap_volume` for `h` at fixed base diameter — the kerbed branch.

    `V = (π h / 6)(3a² + h²)` is monotone in `h ≥ 0`, so a short bisection is
    exact enough and cannot diverge the way a Cardano form can at small `h`.
    """
    if volume_m3 <= 0 or diameter_m <= 0:
        return 0.0
    lo, hi = 0.0, max(diameter_m, 1.0)
    while cap_volume(diameter_m, hi) < volume_m3:
        hi *= 2.0
        if hi > 1e4:
            break
    for _ in range(80):
        mid = (lo + hi) / 2.0
        if cap_volume(diameter_m, mid) < volume_m3:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def reprofile(
    diameter_m: float,
    height_m: float,
    *,
    kerbed: bool,
    repose_deg: float,
    pits: list[dict] | None = None,
    params: TransformParams = DEFAULT_PARAMS,
) -> dict:
    """§5.2 + §5.3: the ruin → original transform for a mound or a cairn.

    Two branches, gated on the kerb, exactly as the document specifies:

    * **Kerb recorded** — the kerb fixes the original footprint, so the diameter
      is measured original. Keep `d`, restore a smooth spherical cap through it,
      and apply only the §5.3 pit fill. **Never** re-profile: pulling a kerbed
      mound in to its repose angle would visibly shrink it inside its own
      surviving kerb, which is the built-in sanity check the document names.
    * **No kerb** — the base may have crept outward. Conserve volume and rebuild
      at the material's angle of repose, which makes the corpus-median mound
      narrower and more than twice as tall (7.0 × 0.7 m → 5.7 × 1.6 m).
    """
    pits = pits or []
    volume = cap_volume(diameter_m, height_m) + pit_volume(pits, params.pit_fill_factor)

    if kerbed:
        return {
            "diameterM": _round(diameter_m),
            "heightM": _round(cap_height_for_volume(diameter_m, volume)),
            "transform": "kerb-fixed" if not pits else "kerb-fixed+pit-fill",
        }

    slope = math.tan(math.radians(repose_deg))
    # V_cone = (π/3)·a³·tan θ  ⇒  a = ∛(3V / (π tan θ)); h = a·tan θ.
    a_orig = (3.0 * volume / (math.pi * slope)) ** (1.0 / 3.0) if volume > 0 else 0.0
    return {
        "diameterM": _round(2.0 * a_orig),
        "heightM": _round(a_orig * slope),
        "transform": "repose-reprofile" if not pits else "repose-reprofile+pit-fill",
    }


def rampart_original_height(
    standing_h_m: float,
    spread_w_m: float,
    *,
    wall_thickness_m: float,
    params: TransformParams = DEFAULT_PARAMS,
) -> dict:
    """§5.1: original rampart height = standing wall + its own debris apron.

        h_orig  = h_standing + Δh
        Δh      = (A_apron · p) / t_wall
        A_apron = (W_spread − t_wall) · d_apron

    The method is anchored on the *standing* wall rather than on a heap of
    unknown original shape: at Broborg 2 m of the answer is simply there, and the
    KMR spread (8–15 m) and the excavated wall body (4–6 m) are consumed as two
    different measurements rather than treated as a contradiction. Across the
    whole parameter box this spans 2.08–3.40 m with a median of 2.5 m.
    """
    apron_width = max(0.0, spread_w_m - wall_thickness_m)
    apron_area = apron_width * params.apron_depth_m
    delta = (apron_area * params.packing) / wall_thickness_m if wall_thickness_m > 0 else 0.0
    return {
        "standingHeightM": _round(standing_h_m),
        "apronIncrementM": _round(delta),
        "heightM": _round(standing_h_m + delta),
        "wallThicknessM": _round(wall_thickness_m),
        "transform": "rampart-apron-conservation",
    }


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def repose_for(archetype: str, params: TransformParams) -> float:
    """The §5.2 angle of repose this archetype's material stands at."""
    material = ARCHETYPE_DEFAULTS[archetype].material
    return params.repose_earth_deg if material == "earth" else params.repose_stone_deg


# --------------------------------------------------------------------------- #
# compass bearings — orientations and entrance placements
# --------------------------------------------------------------------------- #

#: Swedish compass points. Ö(ster) is east and V(äster) is west, so the letters
#: are not the English ones and a naive E/W mapping silently mirrors the site.
BEARINGS: dict[str, float] = {
    "N": 0.0, "NNÖ": 22.5, "NÖ": 45.0, "ÖNÖ": 67.5,
    "Ö": 90.0, "ÖSÖ": 112.5, "SÖ": 135.0, "SSÖ": 157.5,
    "S": 180.0, "SSV": 202.5, "SV": 225.0, "VSV": 247.5,
    "V": 270.0, "VNV": 292.5, "NV": 315.0, "NNV": 337.5,
}


def bearing_deg(token: str | None) -> float | None:
    """`"NÖ"` → 45.0. Returns None for anything not a compass point."""
    if not token:
        return None
    return BEARINGS.get(token.strip().upper().replace("W", "V").replace("E", "Ö"))


def orientation_deg(token: str | None) -> float | None:
    """`"NV-SÖ"` → 315.0 folded to the 0–180 axis a plan's long side runs on."""
    if not token:
        return None
    head = re.split(r"[-–]", token)[0]
    value = bearing_deg(head)
    return None if value is None else _round(value % 180.0, 1)


# --------------------------------------------------------------------------- #
# §3.1 — a Gravfält record is a compositional recipe, so parse it as one
# --------------------------------------------------------------------------- #

#: (archetype, phrases used when counting, phrases used in the size sentence).
#: Ordered longest-first within each group so `resta stenar` cannot be eaten by
#: a shorter alternative.
CONSTITUENTS: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("fire-cracked-mound", ("skärvstenshögar", "skärvstenshög"), ("skärvstenshögarna",)),
    ("stone-setting", ("stensättningar", "stensättningen", "stensättning"),
     ("stensättningarna", "stensättningen")),
    ("standing-stone", ("resta stenar", "rest sten", "resta stenarna"), ("resta stenarna",)),
    ("mound", ("högar", "högen", "hög"), ("högarna",)),
    ("cairn", ("rösen", "röset", "röse"), ("rösena", "röset")),
)

#: Set-stone figures. Counted like the classes above but carrying their own
#: outline (§6.F): three-armed treuddar, ring-shaped domarringar, ship settings.
FIGURES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("treudd", ("treuddar", "treudd")),
    ("stone-circle", ("domarringar", "domarring", "stenkretsar", "stenkrets")),
    ("ship-setting", ("skeppssättningar", "skeppssättning")),
)

#: Modifier words that appear between the count and the class noun and carry the
#: plan form of that subclass: "ca 57 **runda fyllda** stensättningar".
MODIFIER_FORMS: tuple[tuple[str, tuple[str, ...]], ...] = FORM_WORDS

_COUNT_TOTAL = re.compile(
    rf"(?:bestå(?:ende|r)\s+av|utgörs\s+av|innehåll(?:er|ande))\s*(?:{CA})?(\d+)\s*"
    rf"(?:st\s+)?(?:fornlämningar|gravar|anläggningar|synliga)",
    re.IGNORECASE,
)


def _class_count_pattern(phrases: tuple[str, ...]) -> re.Pattern[str]:
    body = "|".join(re.escape(p) for p in sorted(phrases, key=len, reverse=True))
    return re.compile(
        rf"(?:{CA})?(\d+)\s+(?:st\.?\s+)?((?:[{LETTER}]+\s+){{0,3}}?)(?:{body})(?![{LETTER}])",
        re.IGNORECASE,
    )


def parse_class_sizes(text: str) -> dict:
    """Per-class size ranges out of a "Stensättningarna är 3-8 m diam …" sentence.

    Ranges, not midpoints: the sampler draws each individual monument from the
    stated range, which is what makes a grave field measured rather than invented
    (§3.1). Handles the three idioms the corpus uses — `A-B m diam`, `AxB-CxD m`
    (square settings) and `A-B m i sida` (triangular ones).
    """
    out: dict = {"diameterM": None, "heightM": None, "stoneM": None}

    diam = re.search(
        rf"(?:{CA})?({NUM})\s*(?:-\s*(?:{CA})?({NUM})\s*)?m(?:eter)?\s*(?:i\s+)?diam",
        text, re.IGNORECASE,
    )
    side = re.search(
        rf"(?:{CA})?({NUM})\s*(?:-\s*({NUM})\s*)?m(?:eter)?\s*i\s+sida", text, re.IGNORECASE
    )
    rect_range = re.search(
        rf"({NUM})\s*[x×]\s*({NUM})\s*-\s*({NUM})\s*[x×]\s*({NUM})\s*m", text, re.IGNORECASE
    )
    if diam:
        out["diameterM"] = _range(_to_float(diam.group(1)), _to_float(diam.group(2)))
    elif rect_range:
        lo = math.sqrt((_to_float(rect_range.group(1)) or 0) * (_to_float(rect_range.group(2)) or 0))
        hi = math.sqrt((_to_float(rect_range.group(3)) or 0) * (_to_float(rect_range.group(4)) or 0))
        out["diameterM"] = _range(lo, hi)
    elif side:
        out["diameterM"] = _range(_to_float(side.group(1)), _to_float(side.group(2)))
    else:
        rect = _RECT.search(text)
        if rect:
            a, b = _to_float(rect.group(1)), _to_float(rect.group(2))
            if a and b:
                out["diameterM"] = _range(math.sqrt(a * b), None)

    height = _HEIGHT.search(text)
    if height:
        out["heightM"] = _range(_to_float(height.group(1)), _to_float(height.group(2)))
    out["stoneM"] = parse_stone(text)
    return out


def parse_composition(text: str, archetype_default: ArchetypeDefault) -> dict:
    """Turn a grave-field description into a sampler specification (§3.1).

    28 of 31 grave-field-like records in the Broborg bundle state their own
    monument count (5 to 230) and enumerate their classes with a size range each.
    Everything here except the individual positions is therefore measured; the
    positions are the app's terrain-aware blue-noise sampling, and are badged
    Assumed there.
    """
    clauses = split_clauses(text)
    classes: list[dict] = []

    def size_sentence(size_words: tuple[str, ...], modifier: str | None) -> str | None:
        """The clause stating this class's own dimensions.

        Prefers one that also carries the subclass modifier, so "De kvadratiska
        stensättningarna är …" is not read as the size of the round ones.
        """
        pattern = word_pattern(*size_words) if size_words else None
        if pattern is None:
            return None
        best: str | None = None
        best_rank = -1
        for clause in clauses:
            if not pattern.search(clause):
                continue
            if not re.search(rf"(?<![{LETTER}])(är|utgörs|mäter)(?![{LETTER}])", clause, re.I):
                continue
            sized = parse_class_sizes(clause).get("diameterM") is not None
            matched = bool(modifier and word_pattern(modifier).search(clause))
            rank = (2 if matched else 0) + (1 if sized else 0)
            if rank > best_rank:
                best, best_rank = clause, rank
        return best

    for archetype, count_words, size_words in CONSTITUENTS:
        pattern = _class_count_pattern(count_words)
        # Group by (form) so "40 runda" and "4 kvadratiska stensättningar" stay
        # two classes with two size ranges, which is how the register writes them.
        grouped: dict[tuple[str | None, str | None], dict] = {}
        for match in pattern.finditer(text):
            count = int(match.group(1))
            modifiers = (match.group(2) or "").strip().lower()
            form = None
            modifier_word = None
            for candidate, stems in MODIFIER_FORMS:
                for stem in stems:
                    if word_pattern(stem).search(modifiers):
                        form, modifier_word = candidate, stem
                        break
                if form:
                    break
            mound_like = bool(word_pattern("högliknande", "röseliknande").search(modifiers))
            key = (form, modifier_word)
            entry = grouped.setdefault(
                key,
                {
                    "archetype": archetype,
                    "form": form,
                    "count": 0,
                    "moundLike": mound_like,
                    "_modifier": modifier_word,
                },
            )
            entry["count"] += count
            entry["moundLike"] = entry["moundLike"] or mound_like
        for entry in grouped.values():
            modifier = entry.pop("_modifier")
            sentence = size_sentence(size_words, modifier)
            sizes = parse_class_sizes(sentence) if sentence else {}
            entry["diameterM"] = sizes.get("diameterM")
            entry["heightM"] = sizes.get("heightM")
            entry["stoneM"] = sizes.get("stoneM")
            entry["source"] = "measured" if entry["diameterM"] else "assumed"
            classes.append(entry)

    for figure, phrases in FIGURES:
        pattern = _class_count_pattern(phrases)
        total = sum(int(m.group(1)) for m in pattern.finditer(text))
        if total:
            classes.append(
                {
                    "archetype": "standing-stone",
                    "figure": figure,
                    "form": "triangular" if figure == "treudd" else "round",
                    "count": total,
                    "diameterM": None,
                    "heightM": None,
                    "stoneM": None,
                    "moundLike": False,
                    "source": "assumed",
                }
            )

    # Standing stones state individual dimensions rather than a class range
    # ("Den stående är 0,85 m h. 0,65 m br"), so give them the archetype default
    # band unless the text hands us a height.
    for entry in classes:
        if entry["archetype"] == "standing-stone" and not entry["heightM"]:
            # Every clause that names them, not just the first: the enumeration
            # clause mentions "1 rest sten" and carries no dimensions, while the
            # heights are two sentences later ("Den stående är 0,85 m h").
            named = word_pattern("rest", "resta", "stående", "stenen", "stenarna")
            heights: list[float] = []
            for clause in clauses:
                if not named.search(clause):
                    continue
                for match in _HEIGHT.finditer(clause):
                    value = _to_float(match.group(1))
                    upper = _to_float(match.group(2))
                    for candidate in (value, upper):
                        # Bound the accepted band: a standing stone is 0.3–5 m,
                        # and the same clause often gives a neighbouring mound's
                        # height too.
                        if candidate is not None and 0.3 <= candidate <= 5.0:
                            heights.append(candidate)
            if heights:
                entry["heightM"] = _range(min(heights), max(heights))
                entry["source"] = "measured"

    stated = _COUNT_TOTAL.search(text)
    enumerated = sum(int(entry["count"]) for entry in classes)
    if stated:
        # The register contradicts itself in two Broborg records ("bestående av 5
        # fornlämningar. Dessa utgöres av 6 runda stensättningar"). The itemised
        # list is the more specific statement, so it wins — and this keeps the
        # invariant the sampler relies on: the class counts sum to `count`.
        count = max(int(stated.group(1)), enumerated)
        count_source = "measured"
    elif enumerated:
        count = enumerated
        count_source = "measured"
    else:
        count = 0
        count_source = "assumed"

    # A stated total that exceeds the enumeration is normal — the surveyor counts
    # everything and itemises the identifiable. The remainder becomes the field's
    # commonest class rather than vanishing, and says so.
    remainder = max(0, count - enumerated)
    if remainder and classes:
        biggest = max(classes, key=lambda c: c["count"])
        classes.append(
            {
                "archetype": biggest["archetype"],
                "form": biggest.get("form"),
                "count": remainder,
                "diameterM": biggest.get("diameterM"),
                "heightM": biggest.get("heightM"),
                "stoneM": biggest.get("stoneM"),
                "moundLike": biggest.get("moundLike", False),
                "source": "assumed",
                "note": "counted in the record's total but not itemised",
            }
        )
    elif remainder:
        classes.append(
            {
                "archetype": "stone-setting",
                "form": "round",
                "count": remainder,
                "diameterM": None,
                "heightM": None,
                "stoneM": None,
                "moundLike": False,
                "source": "assumed",
                "note": "record states a count but no composition",
            }
        )

    # Fall back per *constituent* archetype, never to the grave field's own
    # default: a standing stone is ~1 m across and a cairn ~7 m, and a single
    # field-level default would silently make both of them 6 m stone settings.
    for entry in classes:
        default = ARCHETYPE_DEFAULTS.get(entry["archetype"], archetype_default)
        if not entry.get("diameterM"):
            entry["diameterM"] = [
                _round(default.diameter_m * 0.7),
                _round(default.diameter_m * 1.3),
            ]
            entry["source"] = "assumed"
        if not entry.get("heightM"):
            entry["heightM"] = [_round(default.height_m * 0.6), _round(default.height_m * 1.4)]
        if not entry.get("stoneM"):
            entry["stoneM"] = list(default.stone_m)

    return {
        "count": count,
        "countSource": count_source,
        "countStated": bool(stated),
        "classes": classes,
    }


# --------------------------------------------------------------------------- #
# §3.2 / §6.A — the fort record is a construction description
# --------------------------------------------------------------------------- #

#: Which `rampart.json` path a described wall belongs to. The ids match the ones
#: `rampart.py` writes, so the app can join the two files without heuristics.
RAMPART_IDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("inner", ("inre vallen", "inre muren", "inre ringvallen", "inre vall")),
    ("outer", ("yttre vallen", "yttre muren", "yttre ringvallen", "yttre vall")),
)

_ENTRANCE = word_pattern("ingång", "ingången", "ingångar", "ingångarna", "öppning", "öppningar")
_STEEP = re.compile(
    r"brant(?:a|)\s+(?:slutt|stup|berg)|stupar|otillgängl", re.IGNORECASE
)
_RING = word_pattern("ringvall", "ringvallar", "ringvallen", "ringmur")


def parse_rampart(text: str, clause: str, params: TransformParams, scope: str | None = None) -> dict:
    """One wall: length, spread, present height, stone calibre, entrances.

    `clause` is the sentence naming this wall and `scope` the run of text that
    belongs to it — everything from that sentence up to the next wall's. The
    Broborg record describes four entrances across two walls ("I VNV och ÖSÖ är
    vallen försedd med ingångar" for the inner, "I ÖSÖ och NNÖ" for the outer),
    so scanning the whole record for both would give each wall all four.

    Site-wide facts — dry-stone construction, vitrification — are read from the
    whole `text` on purpose: the record states them once, about the fort.

    The §5.1 transform is applied here, so the file carries the derived original
    height *and* the standing height it was derived from — the app quotes both
    and the methods panel can show the arithmetic (§9.3).
    """
    scope = clause if scope is None else scope
    length = _LENGTH.search(clause)
    width = _WIDTH.search(clause)
    height = _HEIGHT.search(clause)

    spread = _range(_to_float(width.group(1)), _to_float(width.group(2))) if width else None
    height_range = _range(_to_float(height.group(1)), _to_float(height.group(2))) if height else None
    stone = parse_stone(clause)

    # §5.1 is anchored on the *standing* wall, so the top of the recorded band is
    # the input, not its midpoint: "1-2 m h" means parts of it still stand 2 m.
    standing = height_range[1] if height_range else None
    spread_mid = _mid(spread)

    entrances: list[dict] = []
    for entrance_clause in split_clauses(scope):
        if not _ENTRANCE.search(entrance_clause):
            continue
        widths = _WIDTH.search(entrance_clause)
        band = _range(_to_float(widths.group(1)), _to_float(widths.group(2))) if widths else None
        bearings = re.findall(r"(?<![A-ZÅÄÖ])([NSÖVÄ]{1,3})(?![A-ZÅÄÖa-zåäö])", entrance_clause)
        for token in bearings:
            deg = bearing_deg(token)
            if deg is None:
                continue
            entrances.append({"bearing": token.upper(), "bearingDeg": deg, "widthM": band})

    out: dict = {
        "lengthM": _mid(_range(_to_float(length.group(1)), _to_float(length.group(2)))) if length else None,
        "spreadM": spread,
        "presentHeightM": height_range,
        "stoneM": stone,
        "drystone": bool(_DRYSTONE.search(clause) or _DRYSTONE.search(text)),
        "earthBacked": bool(re.search(r"förstärkt\s+med\s+jord|jordfyllning", text, re.I)),
        "vitrified": bool(word_pattern("förslaggad", "förslaggat", "slaggad", "vitrifierad").search(text)),
        "entrances": entrances,
        "source": "measured" if (spread and height_range) else "assumed",
    }

    if standing is not None and spread_mid is not None:
        out.update(
            rampart_original_height(
                standing, spread_mid, wall_thickness_m=params.wall_thickness_m, params=params
            )
        )
        out["wallThicknessSource"] = "assumed"
    else:
        default = ARCHETYPE_DEFAULTS["fort"]
        out.update(
            rampart_original_height(
                standing if standing is not None else default.height_m,
                spread_mid if spread_mid is not None else params.wall_thickness_m * 2.0,
                wall_thickness_m=params.wall_thickness_m,
                params=params,
            )
        )
        out["wallThicknessSource"] = "assumed"
    return out


def fort_confidence(text: str, extent_span_m: float | None, ramparts: list[dict]) -> dict:
    """§6.A.1 — is this registered `Fornborg` actually a Migration Period fort?

    Uppland registers 181 and a systematic field survey judges ~30 to be Middle
    Iron Age; on Södertörn the figure is ~20 % of ~90. Rendering all 1 304
    registry records as standing ramparts at 500 CE would therefore be
    systematically false for roughly four in five of them.

    The Mälardalen survey's operational definition is tight enough to implement
    directly: *registered as `Fornborg`, with a wall right round (or across the
    non-steep side) that has preserved or partly preserved `kallmurning`, and is
    1 metre or more high.* Each criterion is scored and all four are reported, so
    a low score is explicable rather than mysterious.
    """
    drystone = bool(_DRYSTONE.search(text))
    heights = [r["presentHeightM"][1] for r in ramparts if r.get("presentHeightM")]
    max_height = max(heights) if heights else None
    tall_enough = bool(max_height is not None and max_height >= 1.0)
    # "A wall right round, or across the non-steep side": a named ringvall, or a
    # description that leaves the steep flanks unwalled and does the rest.
    encircling = bool(_RING.search(text) or _STEEP.search(text) or len(ramparts) > 1)
    # Older enclosures (*hägnade berg*) enclose markedly larger areas (§6.A.1).
    compact = extent_span_m is None or extent_span_m <= 250.0

    score = (
        0.40 * drystone
        + 0.30 * tall_enough
        + 0.15 * encircling
        + 0.15 * compact
    )
    return {
        "confidence": _round(score),
        "criteria": {
            "kallmurning": drystone,
            "wallHeightM": _round(max_height) if max_height is not None else None,
            "wallAtLeast1m": tall_enough,
            "wallRoundOrAcross": encircling,
            "extentSpanM": _round(extent_span_m) if extent_span_m is not None else None,
            "compactEnclosure": compact,
        },
    }


def parse_fort(text: str, plan: dict, params: TransformParams) -> dict:
    """The whole §3.2 fort record: one entry per described wall, plus the filter."""
    clauses = split_clauses(text)
    # Where each named wall's description starts, so a wall's own entrances can
    # be read from its own run of text rather than from the whole record.
    starts: list[tuple[int, str, str]] = []
    for path_id, phrases in RAMPART_IDS:
        pattern = word_pattern(*[re.escape(p) for p in phrases])
        index = next((i for i, c in enumerate(clauses) if pattern.search(c)), None)
        if index is not None:
            starts.append((index, path_id, clauses[index]))
    starts.sort()

    ramparts: list[dict] = []
    for position, (index, path_id, clause) in enumerate(starts):
        end = starts[position + 1][0] if position + 1 < len(starts) else len(clauses)
        entry = parse_rampart(text, clause, params, scope=" ".join(clauses[index:end]))
        entry["id"] = path_id
        ramparts.append(entry)
    if not ramparts:
        # A thin record with one undifferentiated wall still gets a rampart, from
        # whatever the whole text says. National scope §11.5: degrade, don't skip.
        entry = parse_rampart(text, text, params)
        entry["id"] = "inner"
        ramparts.append(entry)

    span = plan.get("lengthM") or plan.get("diameterM")
    return {"ramparts": ramparts, **fort_confidence(text, span, ramparts)}


# --------------------------------------------------------------------------- #
# the per-record builder
# --------------------------------------------------------------------------- #

#: What each parsed field is worth when scoring `parseConfidence`. The weights
#: follow §3's own ranking of what a reconstruction actually needs: the plan size
#: is the primary geometry driver, the height is second, and everything else is
#: detail that improves the model without which it still stands up.
CONFIDENCE_WEIGHTS: dict[str, float] = {
    "plan": 0.40,
    "height": 0.25,
    "stone": 0.15,
    "form": 0.10,
    "kerb": 0.05,
    "pits": 0.05,
}
FIELD_CONFIDENCE_WEIGHTS: dict[str, float] = {
    "count": 0.35,
    "composition": 0.35,
    "classSizes": 0.20,
    "extent": 0.10,
}


@dataclass
class ParseStats:
    """Coverage counters, checked against §3's measured percentages in the tests."""

    records: int = 0
    reconstructed: int = 0
    unmapped: int = 0
    plan: int = 0
    height: int = 0
    stone: int = 0
    form: int = 0
    kerb: int = 0
    pits: int = 0
    turf: int = 0
    damaged: int = 0
    field_records: int = 0
    field_counts: int = 0
    #: Monuments the grave-field sampler will place, over and above the records.
    sampled: int = 0
    warned: int = 0
    by_archetype: dict[str, int] = field(default_factory=dict)


def build_monument(
    record: dict,
    params: TransformParams = DEFAULT_PARAMS,
    stats: ParseStats | None = None,
) -> dict | None:
    """One `sites.json` record → one §14 monument entry, or None if unmappable.

    Carries **no coordinates**: position and extent geometry stay in `sites.json`
    and the app joins the two by `id` (§14). What this file adds is everything the
    register only says in prose.
    """
    lamningstyp = record.get("lamningstyp") or ""
    archetype = ARCHETYPES.get(lamningstyp)
    if stats:
        stats.records += 1
    if archetype is None:
        if stats:
            stats.unmapped += 1
        return None

    defaults = ARCHETYPE_DEFAULTS[archetype]
    text = normalise(record.get("description") or "")
    clause = type_clause(text, archetype)
    fallbacks: list[str] = []

    # --- plan ------------------------------------------------------------- #
    plan = parse_plan(clause)
    if plan["diameterM"] is None and text:
        # §3: 85 % of plan sizes are in the first sentence, but the other 7 % of
        # the 92 % are further in. Widening the search is honest; inventing is not.
        plan = parse_plan(text)
    plan_measured = plan["diameterM"] is not None
    form_parsed = plan["form"] is not None
    if not plan_measured:
        plan["diameterM"] = defaults.diameter_m
        fallbacks.append("plan.diameterM")
    if plan["form"] is None:
        plan["form"] = defaults.form
        fallbacks.append("plan.form")
    plan["orientationDeg"] = orientation_deg(plan.pop("orientation", None))
    plan["source"] = "measured" if plan_measured else "assumed"

    # --- profile ---------------------------------------------------------- #
    present_height = parse_height(clause)
    if present_height is None:
        present_height = parse_height(text)
    height_measured = present_height is not None
    if not height_measured:
        present_height = defaults.height_m
        fallbacks.append("profile.heightM")

    kerb = parse_kerb(text)
    pits = parse_pits(text)
    if defaults.reprofile:
        profile = reprofile(
            plan["diameterM"],
            present_height,
            kerbed=kerb is not None,
            repose_deg=repose_for(archetype, params),
            pits=pits,
            params=params,
        )
    else:
        # §6.C/§6.E: flatness is the type. A stone setting's recorded height is
        # close to original and a fire-cracked mound accumulated rather than
        # being built, so neither is inflated — the reconstruction's work is
        # cleaning, not raising. Recorded pits are simply not modelled rather
        # than being filled by redistributing their volume into extra height.
        profile = {
            "diameterM": _round(plan["diameterM"]),
            "heightM": _round(present_height),
            "transform": "pit-omit" if pits else "none",
        }
    profile["presentHeightM"] = _round(present_height)
    profile["presentDiameterM"] = _round(plan["diameterM"])
    gain = (profile["heightM"] / present_height) if present_height else 1.0
    profile["heightGain"] = _round(gain)

    warnings: list[str] = []
    # §5.2 conserves volume, so a very wide, very flat record re-profiles into a
    # startlingly tall monument (a 28 × 1.1 m "röse" becomes 18 × 6.3 m). The
    # arithmetic is right and the record is probably a spread or a mis-typing.
    # Rather than clamp the published rule — which would make the derivation
    # unreproducible — flag it, so the app can badge it and a reader can check.
    if gain >= 3.0:
        warnings.append(
            f"§5.2 re-profiling multiplies the recorded height by {gain:.1f} "
            f"({profile['presentDiameterM']} × {profile['presentHeightM']} m → "
            f"{profile['diameterM']} × {profile['heightM']} m); the record is "
            "unusually wide and flat for its type."
        )
    profile["source"] = (
        "measured" if height_measured and profile["transform"] in ("none", "pit-omit") else
        "derived" if height_measured else "assumed"
    )

    # A kerbed monument must never be pulled inside its own surviving kerb — the
    # sanity check §5.2 builds the kerb gate around. Assert it rather than trust it.
    if kerb is not None and profile["diameterM"] < plan["diameterM"] - 1e-6:
        raise ReconstructError(
            f"{record.get('id')}: kerbed monument re-profiled from {plan['diameterM']} m to "
            f"{profile['diameterM']} m — a kerb fixes the original footprint (§5.2)."
        )

    # --- surface ---------------------------------------------------------- #
    stone = parse_stone(text)
    stone_measured = stone is not None
    if not stone_measured:
        stone = list(defaults.stone_m)
        fallbacks.append("surface.stoneM")
    turfed = bool(_TURF.search(text))
    filled = True if _FILLED.search(text) else (False if _UNFILLED.search(text) else None)

    surface = {
        "stoneM": stone,
        "turfed": turfed,
        "filled": filled,
        "centreStone": bool(_CENTRE_STONE.search(text)),
        # §5.4: `övertorvad` is a *ruin* state. The reconstruction strips the turf
        # and moss back off and shows fresh stone; the flag records what the
        # register saw, not what is drawn.
        "source": "derived" if stone_measured else "assumed",
    }

    tiers = {
        "plan": "measured" if plan_measured else "assumed",
        "profile": profile["source"],
        # §9.1: a monument is not one badge. A mound's laid-turf skin and banding
        # are a literature default whatever its stone calibre says.
        "surface": "assumed" if archetype == "mound" else surface["source"],
    }

    score = (
        CONFIDENCE_WEIGHTS["plan"] * plan_measured
        + CONFIDENCE_WEIGHTS["height"] * height_measured
        + CONFIDENCE_WEIGHTS["stone"] * stone_measured
        + CONFIDENCE_WEIGHTS["form"] * form_parsed
        + CONFIDENCE_WEIGHTS["kerb"] * (kerb is not None)
        + CONFIDENCE_WEIGHTS["pits"] * bool(pits)
    )

    built, abandoned = PERIODS.get(archetype, (None, None))
    monument: dict = {
        "id": record.get("id"),
        "lamningstyp": lamningstyp,
        "archetype": archetype,
        "period": {"builtCE": built, "abandonedCE": abandoned},
        "plan": {
            "form": plan["form"],
            "diameterM": _round(plan["diameterM"]),
            "lengthM": plan.get("lengthM"),
            "widthM": plan.get("widthM"),
            "orientationDeg": plan.get("orientationDeg"),
            "source": plan["source"],
        },
        "profile": profile,
        "surface": surface,
        "features": {"kerb": kerb, "pits": pits},
        "damaged": bool(_DAMAGE.search(text)),
        "warnings": warnings,
        "tiers": tiers,
        "fallbacks": fallbacks,
        "parseConfidence": _round(score),
    }

    if archetype == "grave-field":
        composition = parse_composition(text, defaults)
        monument["field"] = composition
        monument["tiers"] = {
            "plan": tiers["plan"],
            "profile": "measured" if any(c["source"] == "measured" for c in composition["classes"]) else "assumed",
            "surface": "assumed",
            # §6.G: the only genuinely inferential part, and it is landscape
            # rules rather than invented data — but it is still an assumption.
            "placement": "assumed",
        }
        measured_classes = [c for c in composition["classes"] if c["source"] == "measured"]
        monument["parseConfidence"] = _round(
            FIELD_CONFIDENCE_WEIGHTS["count"] * (composition["countSource"] == "measured")
            + FIELD_CONFIDENCE_WEIGHTS["composition"] * bool(composition["classes"])
            + FIELD_CONFIDENCE_WEIGHTS["classSizes"]
            * (len(measured_classes) / len(composition["classes"]) if composition["classes"] else 0.0)
            + FIELD_CONFIDENCE_WEIGHTS["extent"] * plan_measured
        )
        if stats:
            stats.field_records += 1
            stats.sampled += composition["count"]
            if composition["countStated"]:
                stats.field_counts += 1

    if archetype == "fort":
        monument["fort"] = parse_fort(text, monument["plan"], params)
        monument["profile"]["heightM"] = monument["fort"]["ramparts"][0]["heightM"]
        monument["profile"]["transform"] = "rampart-apron-conservation"
        monument["tiers"]["profile"] = "derived"

    if stats:
        stats.reconstructed += 1
        stats.by_archetype[archetype] = stats.by_archetype.get(archetype, 0) + 1
        stats.plan += plan_measured
        stats.height += height_measured
        stats.stone += stone_measured
        stats.form += form_parsed
        stats.kerb += kerb is not None
        stats.pits += bool(pits)
        stats.turf += turfed
        stats.damaged += monument["damaged"]
        stats.warned += bool(warnings)

    return monument


# --------------------------------------------------------------------------- #
# document assembly
# --------------------------------------------------------------------------- #

DERIVATION_DESCRIPTION = (
    "Reconstruction parameters parsed from the KMR free-text descriptions in sites.json, "
    "with the ruin→original transforms of docs/reconstruction-mode.md §5 applied. Every "
    "number KMR records is a measurement of a ruin, so three stated transforms convert "
    "them: (§5.1) a rampart's original height is its still-standing height plus the "
    "height its own collapse apron represents, h_orig = h_standing + (W_spread − t_wall)·"
    "d_apron·p / t_wall; (§5.2) a mound or cairn whose kantkedja is recorded keeps its "
    "measured footprint and is restored to a smooth spherical cap through that kerb, while "
    "one with no kerb is rebuilt volume-conserving at its material's angle of repose, which "
    "makes the corpus-median mound narrower and taller (7.0 × 0.7 m → 5.7 × 1.6 m); (§5.3) "
    "recorded robbing pits are filled, which is a measured operation because the register "
    "gives their dimensions. Stone settings and fire-cracked mounds are never inflated — "
    "flatness is the type. Where a field cannot be parsed the archetype default is used, "
    "the field's source reads \"assumed\", its name appears in the monument's fallbacks "
    "list, and parseConfidence drops; nothing is invented silently. Positions and extent "
    "polygons are not repeated here — this file joins back to sites.json by id."
)


def build_document(
    sites: dict,
    site_id: str,
    params: TransformParams = DEFAULT_PARAMS,
    generated: str | None = None,
) -> dict:
    """The whole §14 file for one site's `sites.json`."""
    records = sites.get("sites")
    if not isinstance(records, list):
        raise ReconstructError("sites.json has no 'sites' array (contract §3).")

    stats = ParseStats()
    monuments: list[dict] = []
    for record in records:
        monument = build_monument(record, params, stats)
        if monument is not None:
            monuments.append(monument)

    total = max(1, stats.reconstructed)
    coverage = {
        "records": stats.records,
        "reconstructed": stats.reconstructed,
        "unmappedTypes": stats.unmapped,
        "byArchetype": dict(sorted(stats.by_archetype.items())),
        "planParsed": _round(stats.plan / total, 3),
        "heightParsed": _round(stats.height / total, 3),
        "stoneParsed": _round(stats.stone / total, 3),
        "formParsed": _round(stats.form / total, 3),
        "kerbParsed": _round(stats.kerb / total, 3),
        "pitsParsed": _round(stats.pits / total, 3),
        "turfNoted": _round(stats.turf / total, 3),
        "damageNoted": _round(stats.damaged / total, 3),
        "graveFields": stats.field_records,
        "graveFieldsWithStatedCount": stats.field_counts,
        "sampledMonuments": stats.sampled,
        "withWarnings": stats.warned,
    }

    return {
        "schemaVersion": SCHEMA_VERSION,
        "site": site_id,
        "generated": generated or datetime.now(timezone.utc).date().isoformat(),
        "derivation": {
            "method": DERIVATION_METHOD,
            "description": DERIVATION_DESCRIPTION,
            "transforms": [
                "rampart-apron-conservation",
                "mound-reprofile",
                "pit-fill",
            ],
            # camelCase to match the rest of the contract; the field names are
            # the §5 symbols so the arithmetic in the methods panel is checkable.
            "params": {
                _camel(key): value for key, value in asdict(params).items()
            },
        },
        "defaults": {
            key: {
                "diameterM": value.diameter_m,
                "heightM": value.height_m,
                "stoneM": list(value.stone_m),
                "material": value.material,
                "reprofile": value.reprofile,
                "form": value.form,
            }
            for key, value in sorted(ARCHETYPE_DEFAULTS.items())
        },
        "coverage": coverage,
        "monuments": monuments,
    }


def write_reconstruction(path: Path, document: dict) -> Path:
    """Write the file, after re-checking the invariants §14 states."""
    validate_document(document)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return path


def validate_document(document: dict) -> None:
    """The §14 invariants, checked pipeline-side so the app never has to guess."""
    if document.get("schemaVersion") != SCHEMA_VERSION:
        raise ReconstructError("schemaVersion must be 1 (§14).")
    monuments = document.get("monuments")
    if not isinstance(monuments, list) or not monuments:
        raise ReconstructError("monuments must be a non-empty array (§14).")
    seen: set[str] = set()
    for monument in monuments:
        mid = monument.get("id")
        if not isinstance(mid, str) or not mid:
            raise ReconstructError("every monument needs a non-empty string id (§14).")
        if mid in seen:
            raise ReconstructError(f"duplicate monument id {mid!r} (§14).")
        seen.add(mid)
        if monument.get("archetype") not in set(ARCHETYPES.values()):
            raise ReconstructError(f"{mid}: unknown archetype {monument.get('archetype')!r} (§4).")
        for key in ("plan", "profile", "surface", "tiers"):
            if not isinstance(monument.get(key), dict):
                raise ReconstructError(f"{mid}: {key} must be an object (§14).")
        for key in ("plan", "profile", "surface"):
            tier = monument["tiers"].get(key)
            if tier not in ("measured", "derived", "assumed"):
                raise ReconstructError(
                    f"{mid}: tiers.{key} must be measured|derived|assumed (§9), got {tier!r}."
                )
        confidence = monument.get("parseConfidence")
        if not isinstance(confidence, (int, float)) or not 0.0 <= confidence <= 1.0:
            raise ReconstructError(f"{mid}: parseConfidence must be in [0, 1] (§14).")
        # Contract §14: no coordinates, no ground heights. The join is by id.
        for forbidden in ("position", "geometryLocal", "groundM", "elevationM"):
            if forbidden in monument:
                raise ReconstructError(
                    f"{mid}: {forbidden!r} must not appear in reconstruction.json — "
                    "positions live in sites.json and ground height is sampled at runtime (§14)."
                )


def patch_manifest(cfg: SiteConfig, manifest_path: Path) -> dict:
    """Declare the §14 asset (and the reconstruction layer) in the manifest."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    add_reconstruction_asset(manifest, RECONSTRUCTION_PATH, processing=[PROCESSING_STEP])
    write_manifest(manifest_path, manifest)
    return manifest


def run(site_id: str, params: TransformParams = DEFAULT_PARAMS) -> dict:
    """Parse one site's `sites.json`, write `reconstruction.json`, patch the manifest."""
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — reconstruction parameters from the committed KMR extract")

    manifest_path = cfg.out_dir / "manifest.json"
    if not manifest_path.exists():
        raise ReconstructError(f"{manifest_path} is missing — run the build step for {cfg.id} first.")

    sites_path = cfg.out_dir / "sites.json"
    if not sites_path.exists():
        raise ReconstructError(
            f"{sites_path} is missing — run `python3 -m fornborg_pipeline.fetch_sites "
            f"--site {cfg.id}` first (contract §3 is the input)."
        )

    sites = json.loads(sites_path.read_text(encoding="utf-8"))
    document = build_document(sites, cfg.id, params)
    coverage = document["coverage"]
    print(
        f"-- {coverage['reconstructed']}/{coverage['records']} records mapped to an archetype "
        f"({coverage['unmappedTypes']} unmapped types)"
    )
    for archetype, count in coverage["byArchetype"].items():
        print(f"     {archetype:20} {count:4}")
    print(
        f"-- parsed: plan {coverage['planParsed']:.0%}, height {coverage['heightParsed']:.0%}, "
        f"stone {coverage['stoneParsed']:.0%}, form {coverage['formParsed']:.0%}, "
        f"kerb {coverage['kerbParsed']:.0%}, pits {coverage['pitsParsed']:.0%}"
    )
    print(
        f"   grave fields: {coverage['graveFieldsWithStatedCount']}/{coverage['graveFields']} "
        "state their own monument count"
    )
    forts = [m for m in document["monuments"] if m["archetype"] == "fort"]
    for fort in forts:
        criteria = fort["fort"]["criteria"]
        print(
            f"   fortConfidence {fort['id']}: {fort['fort']['confidence']:.2f} "
            f"(kallmurning {criteria['kallmurning']}, wall {criteria['wallHeightM']} m, "
            f"round/across {criteria['wallRoundOrAcross']}, span {criteria['extentSpanM']} m)"
        )
        for rampart in fort["fort"]["ramparts"]:
            print(
                f"     {rampart['id']:6} standing {rampart['standingHeightM']} m + apron "
                f"{rampart['apronIncrementM']} m -> original {rampart['heightM']} m "
                f"(t_wall {rampart['wallThicknessM']} m)"
            )

    print(
        f"   grave-field samplers will place {coverage['sampledMonuments']} further monuments"
    )

    low = [m for m in document["monuments"] if m["parseConfidence"] < 0.5]
    print(f"-- {len(low)} monuments below 0.5 parseConfidence (archetype defaults, flagged)")
    for monument in document["monuments"]:
        for warning in monument.get("warnings", ()):
            print(f"   [warn] {monument['id']}: {warning}")

    path = write_reconstruction(cfg.out_dir / RECONSTRUCTION_PATH, document)
    print(f"  wrote {path} ({path.stat().st_size / 1e3:.1f} kB)")

    print("-- manifest")
    manifest = patch_manifest(cfg, manifest_path)
    validate_manifest(manifest)
    print(f"== done: {cfg.out_dir}")
    return document


@click.command()
@click.option(
    "--site",
    "site_id",
    default="broborg",
    show_default=True,
    type=click.Choice(sorted(SITES)),
    help="Site to parse reconstruction parameters for.",
)
def cli(site_id: str) -> None:
    """Parse KMR descriptions into `reconstruction.json` (contract §14)."""
    run(site_id)


if __name__ == "__main__":
    cli()
