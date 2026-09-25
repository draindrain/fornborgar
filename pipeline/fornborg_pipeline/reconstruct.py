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
  * **A fort's interior is decided here, never in the app** (§7.5.2, contract §15).
    Every fort opens on `cleared` — the measured surface and the register's own
    terrain vocabulary — and the `settlement` state is *offered* only where that
    fort's own record supports it: a strong-tier term in its `beskrivning`, a
    settlement record inside its extent, or a hand-entered literature citation.
    4.1 % of the 1 304 registered forts pass. The block carries the verbatim
    sentence behind every pass, because a fort that draws houses has to be able to
    show the visitor the sentence it drew them from.

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


#: §10 — the register's lost punctuation. KMR's descriptions in this corpus were
#: hard-wrapped at about 64 characters and then had their line breaks removed
#: **without gaining a space**, so every wrap point glued two words together
#: (`belägenpå`, `denkallmurade`, `Muren är 2 m h.Inne i fornborgens N del`).
#: 1 034 of the 1 304 national descriptions carry no `\n` at all and the other
#: 270 keep one only as a paragraph mark: not one description in the corpus still
#: carries its wrap, and the damage is of the order of 14 800 lost joins.
#:
#: Exactly one class of those joins can be repaired without guessing, and this is
#: it: a sentence-ending mark **immediately** followed by a capital that opens a
#: lower-case word. No Swedish word straddles a full stop, so the join position is
#: known exactly and the repair cannot split a compound — which is the failure
#: mode that rules out repairing the far commoner lower-to-lower glue (`belägenpå`
#: needs a lexicon to place, and Swedish compounds are themselves exactly
#: "frequent word + frequent word": `stensträng`, `blockvall`, `bergbrant`).
#: `docs/kmr-text-normalisation-2026-09-24.md` measures both.
#:
#: The lower-case second letter is the guard that keeps the register's own
#: orientation strings (`Ö20gr.S-V20gr.N`) and its single-letter abbreviations
#: (`i den. Ö hälften`) intact: those are followed by a bare compass letter, not
#: by a word.
SENTENCE_JOIN_RE = re.compile(rf"(?<=[.!?])(?=[A-ZÅÄÖ][a-zåäö][{LETTER}]*)")


def count_sentence_joins(text: str) -> int:
    """How many lost sentence boundaries `normalise` will put back (§10)."""
    return len(SENTENCE_JOIN_RE.findall(unicodedata.normalize("NFC", text or "")))


def normalise(text: str) -> str:
    """Collapse whitespace, NFC-normalise, and put back the lost full-stop space.

    KMR text arrives with hard-wrapped line breaks glued into words (`"ca7 m"`,
    `"medmedelstora"`). Two different things follow from that, and this function
    does one of them and refuses the other:

    * **repaired** — a line break lost at a sentence end, `…anlagda.Den övre
      muren…`. The position is not guessed: a full stop is not part of any
      Swedish word, so the only thing that can have been there is the space.
      Without this, §3's `split_clauses` runs one sentence into the next and
      reads the *next* sentence's compass bearing as the entrance bearing of
      this one's wall — 112 entrances nationally that the register never placed
      on a wall at all.
    * **not repaired** — the same break lost mid-sentence, `belägenpå`. Splitting
      that needs a lexicon, and the lexicon cannot tell a lost break from a
      genuine compound, because Swedish compounds are built out of exactly the
      same frequent words (`sten`+`vall`, `block`+`vall`, `berg`+`brant`). A
      repair that splits a real compound is worse than the corruption, so the
      glue is left where it is and the stems that suffer most from it are matched
      with `stem_pattern` instead.
    """
    repaired = SENTENCE_JOIN_RE.sub(" ", unicodedata.normalize("NFC", text))
    return re.sub(r"\s+", " ", repaired).strip()


def word_pattern(*stems: str) -> re.Pattern[str]:
    """Case-insensitive whole-word match over Swedish letters.

    `\\b` is unreliable next to å/ä/ö in some engines and — more importantly —
    `hög` must not match inside `skärvstenshög` or `högliknande`, which a
    substring search would.
    """
    body = "|".join(stems)
    return re.compile(rf"(?<![{LETTER}])(?:{body})(?![{LETTER}])", re.IGNORECASE)


def stem_pattern(*stems: str) -> re.Pattern[str]:
    """`word_pattern`'s counterpart for a stem no unrelated Swedish word contains.

    Two different things defeat a whole-word rule on this corpus, and this one
    pattern answers both: the register's own inflection (`kallmurade`,
    `ringvallens`, `kallmursteknik` — 47 of the 63 forts `_DRYSTONE` was missing)
    and §10's lost line breaks, which glue the stem to its neighbour
    (`ikallmur`, `denkallmurade`, `inomringvallen` — the other 16).

    It is **only** admissible for a stem that cannot occur inside an unrelated
    word, which is a claim about the language and therefore a claim that has to
    be checked: `test_the_glue_tolerant_stems_admit_nothing_but_their_own_word`
    enumerates every surface form each stem admits across all 1 304 national
    descriptions, so a stem that starts admitting something else fails there
    rather than quietly widening a criterion. `hög` or `vall` could never be
    passed here; `kallmur` and `ringvall` can.
    """
    body = "|".join(stems)
    return re.compile(rf"[{LETTER}]*(?:{body})[{LETTER}]*", re.IGNORECASE)


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
#: §6.A.1's heaviest criterion, worth 0.40 of a fort's confidence score, so the
#: five-inflection word list it used to be was the single most expensive
#: whole-word rule in the module: 338 national descriptions say `kallmur*` and it
#: fired on 275. The 63-fort gap was 47 forts of plain inflection the list did
#: not carry (`kallmurade` alone is in 53 descriptions, `kallmurningen`,
#: `kallmuren`, `kallmursteknik`) and 16 of §10's glue (`ikallmur`,
#: `denkallmurade`, `kvartstårkallmurning`). One stem closes both.
_DRYSTONE = stem_pattern("kallmur")
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


#: Every inflection of each plan form, so a class counted as "1 rektangulär
#: stensättning" recognises "Den rektangulära stensättningen är …" as its own.
_FORM_STEMS: dict[str, tuple[str, ...]] = dict(FORM_WORDS)

#: Every phrase that names a constituent class, so a continuation clause can be
#: told from the next class's own sentence. Escaped as written, so `resta stenar`
#: does not match the `synliga stenar` of a calibre clause.
_CLASS_WORDS = word_pattern(
    *[
        re.escape(phrase)
        for _archetype, count_words, size_words in CONSTITUENTS
        for phrase in (*count_words, *size_words)
    ],
    *[re.escape(phrase) for _figure, phrases in FIGURES for phrase in phrases],
)


def continuation_calibre(clauses: list[str], index: int) -> list[float] | None:
    """The stone calibre the register states in the clause *after* a class's own.

    KMR writes a grave-field class in two sentences and puts the calibre in the
    second: *"De rektangulära stensättningarna är 4-6x3 m (Ö 10cg S-V 10cg N och
    NV-SÖ)."* then *"Övertorvade med i ytan enstaka synliga stenar, 0,1-0,3 m
    st."* Reading only the first sentence means a stated measurement is replaced
    by the archetype default — and, because a class's `source` is decided by its
    diameter, replaced *under a `measured` badge*. Until §10 that mostly did not
    show, because the lost line break was holding the two sentences together.

    Deliberately narrow, and only ever the calibre:

    * one clause, the one immediately after;
    * which names **no** class of its own, so the next class's sentence can never
      be read as this one's;
    * and states no size of its own, so a fresh enumeration is not swept in.

    Height and plan size are never taken from it: *"Kantkedja, 0,2-0,3 m h"* is a
    kerb's height, not the setting's, and the calibre is the only field the
    register habitually strands.
    """
    if index + 1 >= len(clauses):
        return None
    following = clauses[index + 1]
    if _CLASS_WORDS.search(following):
        return None
    if parse_class_sizes(following).get("diameterM") is not None:
        return None
    return parse_stone(following)


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

    def size_clause(
        size_words: tuple[str, ...], form: str | None, sibling_forms: set[str]
    ) -> int | None:
        """Index of the clause stating this class's own dimensions.

        Prefers one that also names the class's own form in any inflection, so
        "Den rektangulära stensättningen är …" is found for "1 rektangulär
        stensättning". A clause naming the form of a *sibling* class is never
        this class's: without that rule a class whose own sentence scored lower
        fell through to "De runda stensättningarna är 3-8 m diam" and took the
        round class's size — and, through `continuation_calibre`, its calibre —
        under a `measured` badge. No admissible clause means no size, which the
        caller turns into a disclosed archetype default. The index rather than
        the text, because the calibre is often one clause further on.
        """
        pattern = word_pattern(*size_words) if size_words else None
        if pattern is None:
            return None
        own = word_pattern(*_FORM_STEMS[form]) if form else None
        # A class with a form of its own refuses every other form's sentence (the
        # sibling may have been counted without one — "1 kvadratiskfylld
        # stensättning"). A class without one refuses only its siblings' forms,
        # so "Stensättningarna är runda, 3-8 m diam" still sizes "20 stensättningar".
        others = [f for f in (_FORM_STEMS if form else sibling_forms) if f != form]
        foreign = word_pattern(*[s for f in others for s in _FORM_STEMS[f]]) if others else None
        best: int | None = None
        best_rank = -1
        for position, clause in enumerate(clauses):
            if not pattern.search(clause):
                continue
            if not re.search(rf"(?<![{LETTER}])(är|utgörs|mäter)(?![{LETTER}])", clause, re.I):
                continue
            matched = bool(own and own.search(clause))
            if not matched and foreign and foreign.search(clause):
                continue
            sized = parse_class_sizes(clause).get("diameterM") is not None
            rank = (2 if matched else 0) + (1 if sized else 0)
            if rank > best_rank:
                best, best_rank = position, rank
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
        sibling_forms = {entry["form"] for entry in grouped.values() if entry["form"]}
        for entry in grouped.values():
            entry.pop("_modifier")
            index = size_clause(size_words, entry["form"], sibling_forms)
            sizes = parse_class_sizes(clauses[index]) if index is not None else {}
            entry["diameterM"] = sizes.get("diameterM")
            entry["heightM"] = sizes.get("heightM")
            entry["stoneM"] = sizes.get("stoneM") or (
                continuation_calibre(clauses, index) if index is not None else None
            )
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
#: Same treatment as `_DRYSTONE`, same two causes: the genitives and plurals the
#: word list did not carry (`ringvallens`, `ringmurar`, `ringvallarna`) and §10's
#: glue (`inomringvallen`, `mellerstaringvallen`). 63 descriptions name a
#: ringvall or a ringmur; the whole-word rule saw 57.
_RING = stem_pattern("ringvall", "ringmur")


#: Any word that opens a new wall's description, used to stop a wall's calibre
#: clause running on into the next wall's.
_WALL_WORDS = word_pattern(
    "vall", "vallen", "vallar", "vallarna", "vallen", "mur", "muren", "murar", "murarna",
    "murrest", "ringvall", "ringvallen", "ringmur", "ringmuren",
)


def continuation_calibre_clause(clause: str) -> bool:
    """Is this clause the tail of the previous wall's or class's description?

    The register habitually states a calibre in a sentence of its own — *"Den
    inre vallen är ca 320 m l, 0.5-5 m br och 0.5-1.5 m h."* then *"Stenarna är
    0.1-2.5 m st."* Reading only the first leaves the wall with no calibre at
    all, which before §10 mostly did not show because the lost line break was
    holding the two sentences together.

    True only for a clause that states a calibre, names **no** wall of its own,
    and states no length, width or height — so the next wall's sentence, or a
    neighbouring monument's, can never be read as this one's tail.
    """
    if parse_stone(clause) is None:
        return False
    if _WALL_WORDS.search(clause):
        return False
    return not (_LENGTH.search(clause) or _WIDTH.search(clause) or _HEIGHT.search(clause))


def parse_rampart(
    text: str,
    clause: str,
    params: TransformParams,
    scope: str | None = None,
    following: str | None = None,
) -> dict:
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
    if stone is None and following is not None and continuation_calibre_clause(following):
        stone = parse_stone(following)

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
        named = [i for i, clause in enumerate(clauses) if pattern.search(clause)]
        if not named:
            continue
        # The clause that *describes* the wall, not the one that merely lists it.
        # *"Vallarna består av en inre vall, en yttre något osäker vall, samt två
        # tvärvallar."* names both walls and measures neither; the dimensions are
        # in the next sentence. Before §10 repaired the lost full stops the two
        # were usually one clause, so taking the first mention happened to work;
        # with the sentences correctly separated it strands the measurement and
        # the wall falls back to the archetype default height instead.
        index = next(
            (
                i
                for i in named
                if _LENGTH.search(clauses[i])
                or _HEIGHT.search(clauses[i])
                or _WIDTH.search(clauses[i])
            ),
            named[0],
        )
        starts.append((index, path_id, clauses[index]))
    starts.sort()

    ramparts: list[dict] = []
    for position, (index, path_id, clause) in enumerate(starts):
        # A wall owns at least its own clause: two walls named in one sentence
        # would otherwise leave the first one an empty scope.
        end = max(index + 1, starts[position + 1][0]) if position + 1 < len(starts) else len(clauses)
        entry = parse_rampart(
            text,
            clause,
            params,
            scope=" ".join(clauses[index:end]),
            following=clauses[index + 1] if index + 1 < len(clauses) else None,
        )
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
# §7.5.2 — the interior evidence gate
#
# `docs/reconstruction-mode.md` §7.5 fixes two interior states for a fort:
# `cleared` (the measured surface and the register's own terrain vocabulary,
# the default everywhere) and `settlement` (the same plus archetype-H buildings),
# and `settlement` is offered **per fort, on that fort's own evidence**. The gate
# is decided here because the browser does no parsing and no guessing (§14): the
# app reads a boolean and a citation.
#
# The rule is the strong tier of `docs/interior-survey-2026-08-30.md` §6 and
# nothing looser — 54 of 1 304 forts (4.1 %) pass it nationally. Three channels,
# unioned, never intersected:
#
#   1. the fort's own `beskrivning`, strong-tier terms, sentence-scoped discards;
#   2. a settlement-type KMR record inside the fort's own extent;
#   3. a hand-entered literature citation (`INTERIOR_CITED`).
#
# Channel 2 is a union member rather than a cross-check because it under-detects
# exactly where the evidence is best: Ismantorp's 88 house foundations return
# *zero* settlement records, since KMR files them inside the fort's own record
# rather than as separate lämningar.
# --------------------------------------------------------------------------- #

#: The named rule version, written into every file so the panel can say which
#: rule decided and a later revision cannot be mistaken for this one.
INTERIOR_RULE = "interior-strong-tier-2026-08-30"

#: Provenance of the measurement the rule was calibrated on.
INTERIOR_SURVEY = "docs/interior-survey-2026-08-30.json"

#: v1.8 opens every fort on `cleared` (contract §15.1); `settlement` is offerable,
#: never the opening state.
INTERIOR_STATES = ("cleared", "settlement")
INTERIOR_DEFAULT_STATE = "cleared"

#: §7.5.2 channel 1. Case- and diacritic-folded, **prefix**-matched, so `husgrund`
#: also catches `husgrunder`, `husgrunden` and `husgrundsterrass`. Three of the six
#: return no counted hit anywhere in the country; they stay in the list because
#: they cost nothing and the register is not finished being written.
INTERIOR_STRONG_TERMS: tuple[str, ...] = (
    "husgrund",
    "husterrass",
    "hustomtning",
    "grophus",
    "boplatsvall",
    "boplatsborg",
)

#: §7.5.2 channel 2 — the KMR types whose representative point, falling inside the
#: fort's own extent, is evidence of settlement in the interior.
#:
#: **This is a spatial evidence test, not an archetype mapping.** `Terrassering` is
#: in this list and `ARCHETYPES` maps it to `cultivated-ground` (§6.J), which is
#: the right archetype for drawing it. Conflating the two would draw cultivation
#: terraces as houses.
INTERIOR_SETTLEMENT_TYPES: frozenset[str] = frozenset(
    {
        "Boplats",
        "Boplatsområde",
        "Boplatslämning övrig",
        "Husgrund, förhistorisk/medeltida",
        "Boplatsvall",
        "Terrassering",
    }
)

#: §7.5.2's discard table. KMR writes the negation on either side of the noun
#: — *"inga synliga anläggningar"* and *"husgrunder saknas"* — so every one of
#: these is scoped to the **sentence**, never to a character window.
_INTERIOR_NEGATION = (
    "inga", "ingen", "inget", "inte", "ej", "icke", "saknas", "saknar",
    "avsaknad", "utan",
)
#: The feature is outside the enclosure and belongs to the landscape.
_INTERIOR_EXTERIOR = (
    "utanför", "nedanför", "intill", "invid", "i anslutning till", "vid foten",
)
#: …unless the same sentence puts it inside, which outranks the exterior cue:
#: *"terrassering i borgens inre, söder om vallen"* survives. The spec's six cues
#: plus the three spellings the survey's own run matched (`inom borgen`,
#: `i borgen`, `borgens inre`).
_INTERIOR_INTERIOR = (
    "innanför", "inne i", "i det inre", "borgplatån", "borggård", "borggården",
)
#: A cultivation terrace or a natural rock shelf is not a house.
_INTERIOR_NONBUILDING = ("odlingsterrass", "naturlig terrass", "naturliga terrass")
#: The discard that matters most: KMR describes a croft foundation and an Iron Age
#: one in identical vocabulary. The last three are not in §7.5.2's table but are
#: what the survey's own run matched — *"bedöms vara från historisk tid"* is the
#: register dating a house foundation to the wrong millennium in as many words.
_INTERIOR_MODERN = (
    "sentida", "torp", "villa", "sommarstuga", "uthus", "tegelhus",
    "nybebygg", "historisk tid", "sen tid",
)
#: §7.5.2 also lists "any 19xx date" as a modern-building cue. It is implemented
#: below, but **not** as a bare year match: all four strong-tier hit sentences in
#: the national corpus that carry an 18xx/19xx year carry it as an *antiquarian
#: activity* date — *"under 1960- och 1970-talens utgrävningar"* (Eketorp),
#: *"Enligt 1940 års inv"*, *"Revideringsinventeringen 1983"*, *"Undersökningar
#: … företogs 1963"* — and none dates a building. A bare year rule would discard
#: Eketorp's 75 excavated house foundations, which is the opposite of the rule's
#: purpose, so a year only counts when the sentence is not reporting fieldwork.
#: Deliberately *not* in this list: `1900-talet`. "En husgrund från 1900-talet" is
#: the very sentence the year cue is for.
_INTERIOR_FIELDWORK = (
    "inventering", "inventeringen", "inv", "revidering", "revideringsinventering",
    "revideringsinventeringen", "utgrävning", "utgrävningar", "utgrävningarna",
    "undersökning", "undersökningar", "undersökt", "besiktning", "besiktningen",
    "grävning", "grävningar", "utgrävdes", "företogs", "flygfotografering",
)
#: A surviving hit is *hedged*, not discarded: a surveyor's *möjlig husgrund* is
#: still the register saying it saw something building-shaped inside the wall.
#: `kan vara` / `kan utgöra` are not in §7.5.2's list and are in the survey's —
#: *"en anläggning, som kan vara en liten husgrund"* hedges as plainly as
#: *möjlig* does, and the flag travels with the fort into the panel, so missing
#: one would let a hedged fort draw a confident longhouse.
_INTERIOR_HEDGE = ("möjlig", "trolig", "sannolik", "eventuell")
_INTERIOR_HEDGE_PHRASES = ("kan vara", "kan utgöra", "kan ha varit")

#: §6.2 — the register's habitual statement about a fort interior is that it is
#: bare and rough, and 32.2 % of forts make it. `cleared` is not the absence of a
#: statement; for about a third of the corpus it *is* the statement. Matched as
#: substrings so the compound heads the register actually writes — `grovblockig`,
#: `småkuperad` — are caught, and the whole word is quoted back verbatim.
INTERIOR_TERRAIN_WORDS: tuple[str, ...] = (
    "berg i dagen", "hällmark", "berghäll",
    "blockig", "blockrik", "stenbunden",
    "ojämn", "kuperad", "oländig",
    "avplanad", "plan yta", "platå",
    "våtmark", "sankmark", "kärr", "myr",
)

#: Where `cleared`'s surface treatment reads its soil class from (§7.5.1, §9).
INTERIOR_SOIL_SOURCE = "sgu"

#: §7.5.2 channel 3 — a cited excavation, entered by hand, keyed by the fort's
#: `lamningsnummer`. **Broborg is why this channel exists**: it fails channels 1
#: and 2 (`classification: "neither"` in the survey) while having the best-dated
#: interior occupation in the corpus, a settlement layer radiocarbon dated to
#: AD 432–542. A gate that excludes the app's own reference fort is a gate with a
#: known hole in it, and the honest repair is a cited channel rather than a looser
#: keyword rule: loosening the keywords would admit a hundred rampart descriptions
#: to gain a handful of real houses (§7.5.3). Open to any fort for which somebody
#: does the reading, and it says who read it.
INTERIOR_CITED: dict[str, dict] = {
    "L1943:7827": {
        "reference": "Englund 2018; Sjöblom et al. 2022",
        "statement": (
            "A settlement layer inside the fort, superimposed on the residue of the "
            "wall's own weathering and radiocarbon dated to AD 432–542; a glass bead "
            "of 400–575 CE from inside the fort. The occupation is dated; what the "
            "loose interior stone means is contested (Olausson 1997:110 reads it as "
            "building remains and published a settlement sketch, Bornfalk Back 2023 "
            "as cleared surfaces), which is why Broborg opens on `cleared`."
        ),
    },
}

#: Öland and Gotland are a different building tradition (§2, §7.5.2) — Ismantorp's
#: 88 radial foundations, Eketorp II's 53 internal cells — and the survey finds
#: them enriched 3.6× over the mainland. It is a **layout and parameter** branch,
#: never a lower gate: no fort is offered `settlement` for being on limestone.
_LIMESTONE_KOMMUNER = frozenset({"Borgholm", "Mörbylånga"})
_LIMESTONE_COUNTIES = frozenset({"Gotland"})

#: Length-preserving fold: diacritics off, case down, offsets unchanged, so a match
#: on the folded sentence can be quoted verbatim from the original one.
_FOLD = str.maketrans(
    "åäöÅÄÖéèêÉÈÊüÜáàÁÀ",
    "aaoAAOeeeEEEuUaaAA",
)


def fold(text: str) -> str:
    """Case- and diacritic-folded text of the same length as its input (§7.5.2)."""
    return unicodedata.normalize("NFC", text).translate(_FOLD).lower()


def _folded_alternation(cues: tuple[str, ...]) -> str:
    return "|".join(re.escape(fold(cue)) for cue in sorted(cues, key=len, reverse=True))


def _cue_pattern(cues: tuple[str, ...]) -> re.Pattern[str]:
    """Whole-word (prefix-permitting) cue match over folded text."""
    return re.compile(rf"(?<![a-z])(?:{_folded_alternation(cues)})(?![a-z])")


_NEGATION_RE = _cue_pattern(_INTERIOR_NEGATION)
# The exterior and non-building cues drop their **left** word boundary, because
# the register's lost line breaks glue the cue to the word before it — *"två
# stenraderutanför vallen i SÖ"*. That is the discarding direction (more hits fail
# the gate, never fewer), so it is safe here and not for the short negation and
# hedge words, where a bare substring match would fire inside unrelated words.
#: The compass points, folded, longest first, for the `N/S/Ö/V om` cue.
_BEARINGS_FOLDED = "|".join(sorted((fold(b) for b in BEARINGS), key=len, reverse=True))
_EXTERIOR_RE = re.compile(
    rf"(?:{_folded_alternation(_INTERIOR_EXTERIOR)})(?![a-z])"
    # §7.5.2's `N/S/Ö/V om` cue, anchored on **the fort itself**: *"50 m Ö om
    # fornborgen finns husgrunder"* places the houses outside the wall, which is
    # what the cue is for. Unanchored it fires on every bearing the register uses
    # to relate two features to each other — *"9 m SÖ om husgrunden finns en
    # grop"* anchors a pit on the house rather than placing the house outside
    # anything — and would discard five forts the survey counts.
    rf"|(?<![a-z])(?:{_BEARINGS_FOLDED})\s+om\s+(?:den\s+|det\s+)?(?:forn)?"
    r"borg(?:en|ens|omradet|platan|vallen)?(?![a-z])"
)
_INTERIOR_CUE_RE = re.compile(
    rf"(?<![a-z])(?:{_folded_alternation(_INTERIOR_INTERIOR)})(?![a-z])"
    # `i borgens`, `inom fornborgen`, `i borgområdet` and their forn- spellings.
    r"|(?<![a-z])(?:i|inom)\s+(?:den\s+)?(?:forn)?borg(?:en|ens|området|plan)?(?![a-z])"
    r"|(?<![a-z])(?:forn)?borgens\s+inre(?![a-z])"
)
_NONBUILDING_RE = re.compile(rf"(?:{_folded_alternation(_INTERIOR_NONBUILDING)})[a-z]*")
# The modern cues keep their left word boundary, unlike the exterior ones: `torp`
# is the tail of half the place names in Sweden, and Ismantorp — 88 house
# foundations, the best interior in the corpus — is one of them.
_MODERN_RE = re.compile(rf"(?<![a-z])(?:{_folded_alternation(_INTERIOR_MODERN)})[a-z]*")
_MODERN_YEAR_RE = re.compile(r"(?<!\d)1[89]\d\d(?!\d)")
_FIELDWORK_RE = _cue_pattern(_INTERIOR_FIELDWORK)
_HEDGE_RE = re.compile(
    rf"(?<![a-z])(?:{_folded_alternation(_INTERIOR_HEDGE)})[a-z]*"
    rf"|(?<![a-z])(?:{_folded_alternation(_INTERIOR_HEDGE_PHRASES)})(?![a-z])"
    # `husgrundsliknande`, `terrassliknande` — the surveyor's *-liknande* is the
    # same hedge written as a suffix.
    r"|(?<![a-z])[a-z]+liknande(?![a-z])"
)
#: One pattern per terrain word: a single word matches inside a compound
#: (`grovblockig`), a phrase matches as written (`berg i dagen`).
_TERRAIN_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(
        re.escape(fold(word)) if " " in word else rf"[a-z]*{re.escape(fold(word))}[a-z]*"
    )
    for word in INTERIOR_TERRAIN_WORDS
)
_STRONG_TERM_RE = re.compile(
    rf"(?<![a-z])(?:{'|'.join(sorted((fold(t) for t in INTERIOR_STRONG_TERMS), key=len, reverse=True))})"
    r"[a-z0-9]*"
)


def interior_sentences(text: str) -> list[str]:
    """Sentence scope for §7.5.2, tolerant of the register's lost line breaks.

    `split_clauses` needs whitespace after the period, and 1 034 of the 1 304
    national descriptions lost their hard line breaks **without gaining a space**
    (`…anlagda.Den övre muren…`). A rule that misses those boundaries runs a
    negation or an exterior cue on into the next sentence and discards hits that
    are not negated at all, so this splitter is deliberately not §3's:

    * **with** whitespace, anything opens the next sentence — the register writes
      `…skärviga stenar. den kortsida som saknar stenvall…` in lower case, and
      reading that `saknar` as a negation of the house two clauses back is exactly
      the over-reach sentence scope exists to prevent;
    * **without** it, only a capital does, because `0.5-1.4 m st stenar` is a
      decimal point in a corpus that punctuates with both `,` and `.`, and
      splitting inside a number would cut a measurement in half.

    Over-splitting is the safe direction — it narrows the scope a cue can reach —
    and under-splitting is not.
    """
    if not text:
        return []
    parts = re.split(
        r"(?<=[.!?])(?:\s+(?=[(\"«]?[A-ZÅÄÖa-zåäö0-9])|(?=[(\"«]?[A-ZÅÄÖ]))",
        text,
    )
    return [part.strip() for part in parts if part.strip()]


def scan_interior_terms(text: str) -> list[dict]:
    """Every strong-tier hit in a fort description, with its §7.5.2 verdict.

    One dict per hit: the stem, the surface form KMR actually wrote, the verdict
    (`counted` or the discard rule that fired), the cue that fired, the hedge flag,
    and the **verbatim sentence**, because §7.5.3 requires the app to be able to
    show the visitor the sentence a drawn interior rests on.
    """
    hits: list[dict] = []
    for sentence in interior_sentences(text):
        folded = fold(sentence)
        negation = _NEGATION_RE.search(folded)
        exterior = _EXTERIOR_RE.search(folded)
        interior_cue = _INTERIOR_CUE_RE.search(folded)
        nonbuilding = _NONBUILDING_RE.search(folded)
        modern = _MODERN_RE.search(folded)
        if modern is None and not _FIELDWORK_RE.search(folded):
            modern = _MODERN_YEAR_RE.search(folded)
        hedge = _HEDGE_RE.search(folded)
        for match in _STRONG_TERM_RE.finditer(folded):
            matched = sentence[match.start() : match.end()]
            stem = next(
                term for term in INTERIOR_STRONG_TERMS if fold(matched).startswith(fold(term))
            )
            if negation:
                verdict = "negated"
            elif exterior and not interior_cue:
                verdict = "exterior"
            elif nonbuilding:
                verdict = "nonbuildingTerrass"
            elif modern:
                verdict = "modern"
            else:
                verdict = "counted"
            hits.append(
                {
                    "term": stem,
                    "matched": matched,
                    "verdict": verdict,
                    "negationCue": folded[negation.start() : negation.end()] if negation else None,
                    "exteriorCue": folded[exterior.start() : exterior.end()] if exterior else None,
                    "interiorCue": (
                        folded[interior_cue.start() : interior_cue.end()] if interior_cue else None
                    ),
                    "modernCue": folded[modern.start() : modern.end()] if modern else None,
                    "hedged": bool(hedge),
                    "sentence": sentence,
                }
            )
    return hits


def _geometry_rings(geometry: dict | None) -> list[list[list[float]]]:
    """Outer rings of a (Multi)Polygon in local [x, z] coordinates (§3)."""
    if not isinstance(geometry, dict):
        return []
    kind = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if kind == "Polygon" and isinstance(coordinates, list):
        return [ring for ring in coordinates if isinstance(ring, list) and len(ring) >= 3]
    if kind == "MultiPolygon" and isinstance(coordinates, list):
        rings: list[list[list[float]]] = []
        for polygon in coordinates:
            if isinstance(polygon, list):
                rings.extend(r for r in polygon if isinstance(r, list) and len(r) >= 3)
        return rings
    return []


def _geometry_points(geometry: dict | None) -> list[list[float]]:
    """Every vertex in a geometry, whatever its type — used for the bbox fallback."""
    if not isinstance(geometry, dict):
        return []
    points: list[list[float]] = []

    def walk(node) -> None:
        if (
            isinstance(node, list)
            and len(node) >= 2
            and all(isinstance(value, (int, float)) for value in node[:2])
        ):
            points.append([float(node[0]), float(node[1])])
            return
        if isinstance(node, list):
            for child in node:
                walk(child)

    walk(geometry.get("coordinates"))
    return points


def point_in_polygon(x: float, z: float, rings: list[list[list[float]]]) -> bool:
    """Even-odd ray cast, so a hole counts as outside (§7.5.2's polygon test)."""
    inside = False
    for ring in rings:
        count = len(ring)
        for index in range(count):
            x1, z1 = ring[index][0], ring[index][1]
            x2, z2 = ring[(index + 1) % count][0], ring[(index + 1) % count][1]
            if (z1 > z) != (z2 > z):
                crossing = x1 + (z - z1) * (x2 - x1) / ((z2 - z1) or 1e-12)
                if crossing > x:
                    inside = not inside
    return inside


def settlement_records_inside(fort: dict, records: list[dict]) -> list[dict]:
    """§7.5.2 channel 2 — settlement-type records inside the fort's own extent.

    Point in polygon where the fort has one, its bounding box where it has only a
    line (43 forts nationally). The bbox is the weaker test and says so in the
    citation, because a bounding box over a promontory fort reaches well outside
    the wall.

    This is a *spatial* test over `INTERIOR_SETTLEMENT_TYPES`, which is not the
    archetype map: `Terrassering` is a settlement-type record here and archetype
    J (`cultivated-ground`) there, and conflating the two would draw cultivation
    terraces as houses.
    """
    geometry = fort.get("geometryLocal")
    rings = _geometry_rings(geometry)
    test = "polygon"
    bounds: tuple[float, float, float, float] | None = None
    if not rings:
        points = _geometry_points(geometry)
        if len(points) < 2:
            # A fort known only as a point has no interior to test against, and
            # inventing a radius for it would be the app guessing in the pipeline.
            return []
        xs = [p[0] for p in points]
        zs = [p[1] for p in points]
        bounds = (min(xs), min(zs), max(xs), max(zs))
        test = "bbox"

    found: list[dict] = []
    for record in records:
        if record.get("id") == fort.get("id"):
            continue
        if (record.get("lamningstyp") or "") not in INTERIOR_SETTLEMENT_TYPES:
            continue
        position = record.get("position") or {}
        x, z = position.get("x"), position.get("z")
        if not isinstance(x, (int, float)) or not isinstance(z, (int, float)):
            continue
        if bounds is not None:
            hit = bounds[0] <= x <= bounds[2] and bounds[1] <= z <= bounds[3]
        else:
            hit = point_in_polygon(float(x), float(z), rings)
        if hit:
            found.append(
                {
                    "channel": "settlement-record",
                    "id": record.get("id"),
                    "lamningstyp": record.get("lamningstyp"),
                    "test": test,
                }
            )
    return found


# --- what `cleared` draws (§7.5.1) ----------------------------------------- #

_CLEARED_SENTENCE = re.compile(r"(?:sten)?rojd[a-z]*\s+(?:yta|ytor|ytan|ytorna)")
#: `8x6 (VNV-ÖSÖ)` — the metre unit is optional because the register drops it on
#: all but the last pair of a list.
_PATCH = re.compile(
    rf"({NUM})\s*[x×]\s*({NUM})\s*(?:m(?:eter)?)?\s*"
    rf"(?:\(\s*([NSÖVWnsövw]{{1,3}}\s*-\s*[NSÖVWnsövw]{{1,3}})\s*\))?",
    re.IGNORECASE,
)
_SECTOR = re.compile(
    rf"(?<![{LETTER}])([NSÖVW]{{1,3}})\s*(?:-\s*)?del(?:en|arna|ar)?(?![{LETTER}])"
)


def parse_interior_sector(sentence: str) -> str | None:
    """`"i den S delen av borgområdet"` → `"S"`. KMR's own word for a part of the
    interior, never a coordinate (contract §15.3): the app resolves it against the
    fort's §3 extent polygon at runtime."""
    match = _SECTOR.search(sentence)
    if not match:
        return None
    token = match.group(1).upper().replace("W", "V").replace("E", "Ö")
    return token if token in BEARINGS else None


def parse_terrain_words(text: str) -> list[str]:
    """The interior-terrain vocabulary the register actually used, verbatim.

    §6.2: 32.2 % of forts describe their interior as rock, block, rough ground or
    wet ground, against 4.1 % that describe a building in it. `cleared` is not the
    absence of a statement — for about a third of the corpus it *is* the statement
    — so the words it is drawn from travel with it.

    Matched inside compounds (`grovblockig`, `småkuperad`) and quoted back as the
    whole word the surveyor wrote, not as the stem.
    """
    folded = fold(text)
    found: list[tuple[int, str]] = []
    for pattern in _TERRAIN_PATTERNS:
        for match in pattern.finditer(folded):
            word = text[match.start() : match.end()]
            found.append((match.start(), word))
    seen: set[str] = set()
    words: list[str] = []
    for _index, word in sorted(found):
        key = word.lower()
        if key not in seen:
            seen.add(key)
            words.append(word)
    return words


def parse_cleared_patches(text: str) -> list[dict]:
    """Stone-picked patches — **only where KMR places them** (§7.5.1).

    A size, an orientation and a compass sector, never a position (§15.3). The
    normal case is `[]`: the register mentions cleared ground far more often than
    it measures it, and a patch with no stated size is not drawn.
    """
    patches: list[dict] = []
    for sentence in interior_sentences(text):
        if not _CLEARED_SENTENCE.search(fold(sentence)):
            continue
        sector = parse_interior_sector(sentence)
        for match in _PATCH.finditer(sentence):
            length = _to_float(match.group(1))
            width = _to_float(match.group(2))
            if length is None or width is None:
                continue
            patches.append(
                {
                    "lengthM": _round(max(length, width)),
                    "widthM": _round(min(length, width)),
                    "orientationDeg": orientation_deg(match.group(3)),
                    "sector": sector,
                    "source": "measured",
                    "sentence": sentence,
                }
            )
    return patches


# --- what `settlement` would draw, where the record states it (§7.5.1) ------ #

#: §6.H's literature defaults, every one of them labelled. `docs/data-formats.md`
#: §15 publishes the first block as `defaults.farmstead` so the app can expose
#: them as tunables; the rest are constants of the same card.
FARMSTEAD_DEFAULTS: dict = {
    "lengthM": [20.0, 40.0],
    "widthM": [6.0, 8.0],
    "aisleFraction": 0.4,
    "wallHeightM": 1.2,
    "roofPitchDeg": 45.0,
    "hipPitchDeg": 48.0,
    "covering": "turf-over-birch-bark",
    "ancillary": 2,
    "grophus": 1,
}
FARMSTEAD_CONSTANTS: dict = {
    "aisleWidthM": [1.3, 2.8],
    "roofForm": "hipped",
    "smokeVent": "board-with-hole",
    "walls": "wattle-and-daub-on-stone-footing",
    "trestleSpacingM": [2.0, 3.0],
}
#: §15's `defaults.interior`.
INTERIOR_DEFAULTS: dict = {"state": INTERIOR_DEFAULT_STATE, "clearedPatchDepthM": 0.1}

_SWEDISH_NUMERALS: dict[str, int] = {
    "en": 1, "ett": 1, "två": 2, "tre": 3, "fyra": 4, "fem": 5, "sex": 6,
    "sju": 7, "åtta": 8, "nio": 9, "tio": 10,
}
_GROUPS = re.compile(
    rf"(?:fordelade?\s+pa|uppdelade?\s+(?:i|pa)|i)\s+({NUM}|{'|'.join(fold(w) for w in _SWEDISH_NUMERALS)})"
    r"\s+(?:lika\s+manga\s+)?(grupper|kvarter)"
)
_RADIAL = re.compile(r"radie[lr]|radialt|radiellt|radiella|radiart")

# --- §7.5.2's Öland/Gotland branch: the street plan, where KMR draws it ------ #
#
# Ismantorp's own sentence is the whole reason these two exist, and it is the
# only sentence in the country that carries either of them. It states the block
# division — *"…en inre, mer oregelbunden grupp, genom **fyra gator** uppdelade i
# lika många **kvarter**"* — and, one sentence on, the street between the two
# groups: *"De båda husgrupperna skiljs av en **2-5 m br ringgata**."* A radial
# **block** layout needs both numbers, and inventing either of them would be
# exactly the thing this app refuses. Replayed over all 1 304 national
# descriptions each pattern matches **one** fort, `l1957-426`, and nothing else
# (`test_the_street_plan_is_ismantorps_alone`), so neither can leak onto the
# mainland default by accident.
_STREET_WIDTH = re.compile(
    rf"(?:{CA})?({NUM})\s*(?:-\s*(?:{CA})?({NUM})\s*)?m(?:eter)?\s*br(?:ed|)[^.]{{0,40}}?"
    r"(?:ring)?gat(?:a|an|or|orna)\b"
)
_BLOCKS = re.compile(
    rf"({NUM}|{'|'.join(fold(w) for w in _SWEDISH_NUMERALS)})\s+"
    r"(?:lika\s+manga\s+)?(?:gator|kvarter)"
)


def _swedish_int(token: str) -> int | None:
    """`"fyra"` or `"4"` → `4`. The register writes counts both ways."""
    if token.isdigit():
        return int(token)
    return next((value for word, value in _SWEDISH_NUMERALS.items() if fold(word) == token), None)


def parse_interior_streets(text: str) -> dict:
    """The ring street and the block division, from the fort's own description.

    Both are **layout drivers the register states**, not archetype defaults, and
    they are read from the interior sentences rather than only from the sentences
    that carry a `husgrund` hit — Ismantorp writes the ring street's width in the
    sentence *after* the one that counts its houses, and a street is a street
    wherever the surveyor put the full stop.

    Returns `{"blocks": int | None, "streetWidthM": [lo, hi] | None}`; the normal
    case nationally is both `None`, because the normal fort has no street plan
    written down.
    """
    blocks: int | None = None
    width: list[float] | None = None
    for sentence in interior_sentences(text):
        folded = fold(sentence)
        if blocks is None:
            match = _BLOCKS.search(folded)
            if match:
                value = _swedish_int(match.group(1))
                # A block division of one is not a division; a fort is not laid
                # out in fifty quarters either. Both would be a misread.
                if value is not None and 2 <= value <= 12:
                    blocks = value
        if width is None:
            match = _STREET_WIDTH.search(folded)
            if match:
                width = _range(_to_float(match.group(1)), _to_float(match.group(2)))
    return {"blocks": blocks, "streetWidthM": width}


def _stated_count(hit: dict) -> int | None:
    """A house count stated immediately before the term KMR wrote.

    *"Innanför muren är 88 husgrunder"*, *"Inom borgen finns ca 50 husgrunder"*.
    Intervening words must be at least three letters long, so the `m`, `l`, `h`
    and `br` of a dimension cannot be read as a count.
    """
    folded_sentence = fold(hit["sentence"])
    term = re.escape(fold(hit["matched"]))
    pattern = re.compile(rf"(?:{CA})?(\d+)\s*(?:st\.?\s*)?(?:[a-z]{{3,}}\s+){{0,2}}{term}")
    counts = [int(match.group(1)) for match in pattern.finditer(folded_sentence)]
    return max(counts) if counts else None


def _stated_plan(sentence: str) -> dict | None:
    """A house's stated plan: `11x7 m (Ö-V)`, or `12-14 m l, 4-6 m br`."""
    rect = _RECT.search(sentence)
    if rect:
        a, b = _to_float(rect.group(1)), _to_float(rect.group(2))
        if a is not None and b is not None:
            length, width = max(a, b), min(a, b)
            return {
                "lengthM": [_round(length), _round(length)],
                "widthM": [_round(width), _round(width)],
                "orientationDeg": orientation_deg(rect.group(3)),
            }
    length_match = _LENGTH.search(sentence)
    width_match = _WIDTH.search(sentence)
    if length_match and width_match:
        length_range = _range(_to_float(length_match.group(1)), _to_float(length_match.group(2)))
        width_range = _range(_to_float(width_match.group(1)), _to_float(width_match.group(2)))
        if length_range and width_range:
            orientation = re.search(
                r"\(\s*([NSÖVWnsövw]{1,3}\s*-\s*[NSÖVWnsövw]{1,3})\s*\)", sentence
            )
            return {
                "lengthM": length_range,
                "widthM": width_range,
                "orientationDeg": orientation_deg(orientation.group(1)) if orientation else None,
            }
    return None


def interior_buildings(hits: list[dict], tradition: str, text: str = "") -> dict | None:
    """The sampler spec for the `settlement` state, from the record's own words.

    §7.5.1: count, dimensions and layout come from the source the fort passed the
    gate on and **override the archetype defaults wherever that source states
    them**; everything the sentence does not state falls back to §6.H's literature
    defaults, and every fallback is named, because a house whose length came from
    the register and a house whose length came from the 20–40 m default must not
    read as equally certain in the popup.

    `None` — the contract's "the record attests buildings but states nothing about
    them" — is returned for a fort that passed on channel 2 or channel 3 alone.
    """
    if not hits:
        return None

    counts = [count for count in (_stated_count(hit) for hit in hits) if count]
    plan = next(
        (plan for plan in (_stated_plan(hit["sentence"]) for hit in hits) if plan), None
    )
    sector = next(
        (sector for sector in (parse_interior_sector(hit["sentence"]) for hit in hits) if sector),
        None,
    )
    joined = fold(" ".join(hit["sentence"] for hit in hits))
    groups_match = _GROUPS.search(joined)
    groups = None
    if groups_match:
        token = groups_match.group(1)
        groups = (
            int(token)
            if token.isdigit()
            else next(
                (value for word, value in _SWEDISH_NUMERALS.items() if fold(word) == token), None
            )
        )
    if _RADIAL.search(joined):
        layout = "radial"
    elif groups:
        layout = "grouped"
    else:
        # §7.5.2's Öland/Gotland branch is a *layout and parameter* branch, not a
        # lower gate: a limestone ringfort that passes the gate lays its houses
        # out radially against the inner wall face. It never admits a fort.
        layout = "radial" if tradition == "limestone-ringfort" else "free"

    # §7.5.2's layout branch needs a street plan, and takes it from the record
    # where the record draws one. Ismantorp is the only fort in the country that
    # does; everywhere else both come back `None` and the app draws no streets.
    streets = parse_interior_streets(text or " ".join(hit["sentence"] for hit in hits))

    fallbacks: list[str] = []
    if plan is None:
        fallbacks.extend(["buildings.template.lengthM", "buildings.template.widthM"])
    if not counts:
        fallbacks.append("buildings.count")
    # A layout in more than one group has to put *something* between the rings,
    # so where the record does not measure that gap the app assumes one — and a
    # gap the app assumed is named here like every other assumption.
    if groups and groups > 1 and streets["streetWidthM"] is None:
        fallbacks.append("buildings.streetWidthM")

    template = {
        "kind": "longhouse",
        "count": 1,
        "lengthM": list((plan or FARMSTEAD_DEFAULTS)["lengthM"]),
        "widthM": list((plan or FARMSTEAD_DEFAULTS)["widthM"]),
        "orientationDeg": plan.get("orientationDeg") if plan else None,
        "aisleFraction": FARMSTEAD_DEFAULTS["aisleFraction"],
        "aisleWidthM": list(FARMSTEAD_CONSTANTS["aisleWidthM"]),
        "wallHeightM": FARMSTEAD_DEFAULTS["wallHeightM"],
        "roofForm": FARMSTEAD_CONSTANTS["roofForm"],
        "roofPitchDeg": FARMSTEAD_DEFAULTS["roofPitchDeg"],
        "hipPitchDeg": FARMSTEAD_DEFAULTS["hipPitchDeg"],
        "smokeVent": FARMSTEAD_CONSTANTS["smokeVent"],
        "covering": FARMSTEAD_DEFAULTS["covering"],
        "walls": FARMSTEAD_CONSTANTS["walls"],
        "trestleSpacingM": list(FARMSTEAD_CONSTANTS["trestleSpacingM"]),
        "source": "measured" if plan else "assumed",
        "tiers": {
            "plan": "measured" if plan else "assumed",
            # The roof is §6.H's rule set applied to the plan, never a measurement:
            # no Iron Age roof survives to be measured (§6.H, Näsman 2013).
            "profile": "derived",
            "surface": "assumed",
        },
    }
    return {
        "count": max(counts) if counts else None,
        "countSource": "measured" if counts else "assumed",
        "countStated": bool(counts),
        "layout": layout,
        "groups": groups,
        # §7.5.2's radial **blocks**: the number of quarters the inner group is
        # cut into, and the width of the street that cuts it. Ismantorp's alone.
        "blocks": streets["blocks"],
        "streetWidthM": streets["streetWidthM"],
        "sector": sector,
        "template": template,
        "fallbacks": fallbacks,
        "source": "measured" if (counts or plan) else "assumed",
    }


def interior_tradition(county: str = "", kommun: str = "") -> str:
    """§7.5.2's limestone branch — a layout and parameter branch, never a gate."""
    if county in _LIMESTONE_COUNTIES or kommun in _LIMESTONE_KOMMUNER:
        return "limestone-ringfort"
    return "mainland"


def build_interior(
    fort: dict,
    records: list[dict],
    *,
    county: str = "",
    kommun: str = "",
) -> dict:
    """The §15.1 `interior` block for one fort — the gate, and what it rests on.

    Emitted **whether or not the gate passes**: `gate: "fail"` with empty citations
    and the discard counters filled is a statement, and a useful one. It lets the
    panel say "the register records no buildings inside this fort, and two mentions
    of houses that it places outside it" instead of saying nothing, and it lets the
    app tell "no evidence" from "a bundle built before this rule existed".
    """
    text = normalise(fort.get("description") or "")
    hits = scan_interior_terms(text)
    counted = [hit for hit in hits if hit["verdict"] == "counted"]
    tradition = interior_tradition(county, kommun)

    citations: list[dict] = [
        {
            "channel": "description",
            "lamningsnummer": fort.get("id"),
            "term": hit["term"],
            "matched": hit["matched"],
            "hedged": hit["hedged"],
            "sentence": hit["sentence"],
        }
        for hit in counted
    ]
    settlement = settlement_records_inside(fort, records)
    citations.extend(settlement)

    cited = INTERIOR_CITED.get(fort.get("id") or "")
    if cited is not None:
        citations.append(
            {
                "channel": "cited",
                "reference": cited["reference"],
                "statement": cited["statement"],
                "enteredBy": "pipeline",
            }
        )

    channels: list[str] = []
    if counted:
        channels.append("description")
    if settlement:
        channels.append("settlement-record")
    if cited is not None:
        channels.append("cited")

    discarded = {
        "negated": sum(1 for hit in hits if hit["verdict"] == "negated"),
        "exterior": sum(1 for hit in hits if hit["verdict"] == "exterior"),
        "nonbuildingTerrass": sum(1 for hit in hits if hit["verdict"] == "nonbuildingTerrass"),
        "modern": sum(1 for hit in hits if hit["verdict"] == "modern"),
    }

    return {
        # v1.8 opens every fort on the conservative geometry, always. Passing the
        # gate makes `settlement` *offerable*, not on (§7.5.1, §9).
        "state": INTERIOR_DEFAULT_STATE,
        "settlementOffered": bool(channels),
        "tradition": tradition,
        "ground": {
            "terrainWords": parse_terrain_words(text),
            "soilClass": INTERIOR_SOIL_SOURCE,
            "clearedPatches": parse_cleared_patches(text),
            "source": "derived",
        },
        "evidence": {
            "rule": INTERIOR_RULE,
            "gate": "pass" if channels else "fail",
            "channels": channels,
            # Hedging travels: true only when *every* surviving hit hedges, so a
            # fort with one confident sentence is not marked down for a second,
            # cautious one — and a fort with nothing but *möjlig husgrund* cannot
            # draw a confident longhouse.
            "hedged": bool(counted) and all(hit["hedged"] for hit in counted),
            "terms": sorted({hit["term"] for hit in counted}),
            "citations": citations,
            "discarded": discarded,
            "survey": INTERIOR_SURVEY,
        },
        "buildings": interior_buildings(counted, tradition, text),
    }


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
    #: §10 — records whose description had at least one lost sentence boundary put
    #: back by `normalise`, and how many boundaries that was in total. Counted and
    #: written into the file because this project does not edit its sources
    #: silently: the repair is one inserted space per count, and removing them
    #: again reproduces the register's text byte for byte.
    repaired_records: int = 0
    repaired_joins: int = 0
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
        joins = count_sentence_joins(record.get("description") or "")
        stats.repaired_joins += joins
        stats.repaired_records += joins > 0
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
    "polygons are not repeated here — this file joins back to sites.json by id. The KMR "
    "text itself reaches this parser with its hard line breaks removed and no space in "
    "their place, which glues words and sentences together; exactly one class of that is "
    "repaired here — a space put back after a full stop that runs straight into the next "
    "sentence's capital — and coverage.sentenceJoinsRepaired counts every one, because a "
    "repair is an edit to the source and has to be visible. Glue inside a sentence "
    "(\"belägenpå\") is left exactly as the register sent it."
)


def build_document(
    sites: dict,
    site_id: str,
    params: TransformParams = DEFAULT_PARAMS,
    generated: str | None = None,
    county: str = "",
    kommun: str = "",
    fort_id: str = "",
) -> dict:
    """The whole §14 file for one site's `sites.json`.

    `county` and `kommun` are the registry's own, and feed exactly one field:
    §7.5.2's Öland/Gotland layout branch (`interior.tradition`). They never widen
    or narrow the evidence gate — no fort is offered `settlement` for being on
    limestone.

    `fort_id` is the site's **own** fort (`SiteConfig.raa["lamningsnummer"]`). A
    2 × 2 km bundle can hold a second registered fornborg, and attributing one
    fort's husgrunder to the other would be the quietest possible way to draw a
    building nobody recorded there.
    """
    records = sites.get("sites")
    if not isinstance(records, list):
        raise ReconstructError("sites.json has no 'sites' array (contract §3).")

    stats = ParseStats()
    monuments: list[dict] = []
    for record in records:
        monument = build_monument(record, params, stats)
        if monument is not None:
            monuments.append(monument)

    # §15.1: the `interior` block belongs to the site's fort. A site with no fort
    # record has no interior to state anything about, and the block is omitted —
    # which is not the same as a fort with no evidence, whose block says `fail`.
    fort_ids = {m["id"] for m in monuments if m["archetype"] == "fort"}
    fort_record = next(
        (r for r in records if r.get("id") == fort_id and r.get("id") in fort_ids),
        # A bundle with no declared fort id (or one whose fort is not in this
        # extract) falls back to the first fort record, which is the site's own in
        # every bundle built so far.
        next((r for r in records if r.get("id") in fort_ids), None),
    )
    interior = (
        build_interior(fort_record, records, county=county, kommun=kommun)
        if fort_record is not None
        else None
    )

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
        # §10: how much of the register's lost punctuation this parse put back.
        "recordsTextRepaired": stats.repaired_records,
        "sentenceJoinsRepaired": stats.repaired_joins,
        # §15: what the interior parse actually found. `null` is "not a fort site"
        # and is a different statement from `"fail"`, which is "a fort, and the
        # register records nothing built inside it".
        "interiorGate": (interior["evidence"]["gate"] if interior else None),
        "interiorBuildingsStated": (
            bool(interior["buildings"] and interior["buildings"]["countStated"])
            if interior
            else None
        ),
    }

    document_defaults = {
        key: {
            "diameterM": value.diameter_m,
            "heightM": value.height_m,
            "stoneM": list(value.stone_m),
            "material": value.material,
            "reprofile": value.reprofile,
            "form": value.form,
        }
        for key, value in sorted(ARCHETYPE_DEFAULTS.items())
    }
    # §15: the §6.H literature defaults and the interior's own, exposed as tunables
    # beside `defaults.mound`. `defaults.farmstead` is the weakest-evidenced card
    # in the catalogue, which is why every number in it is a *labelled* default
    # that the record overrides wherever the record speaks. The house numbers are
    # *added to* the archetype's §14 entry rather than replacing it — the same key
    # already carries the footprint the marker is drawn from.
    document_defaults["farmstead"] = {**document_defaults["farmstead"], **FARMSTEAD_DEFAULTS}
    document_defaults["interior"] = dict(INTERIOR_DEFAULTS)

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
        "defaults": {key: document_defaults[key] for key in sorted(document_defaults)},
        "coverage": coverage,
        "monuments": monuments,
        **({"interior": interior} if interior is not None else {}),
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
    validate_interior(document)


#: The §15.1 citation shapes: each channel must carry the field that makes it
#: checkable, because "no citation, no state" is the whole point of the block.
_CITATION_REQUIRED: dict[str, tuple[str, ...]] = {
    "description": ("lamningsnummer", "term", "matched", "sentence"),
    "settlement-record": ("id", "lamningstyp", "test"),
    "cited": ("reference", "statement"),
}


def validate_interior(document: dict) -> None:
    """The §15 invariants for the `interior` block — honesty as a schema constraint.

    The one that matters most is **no citation, no state**: `settlementOffered`
    requires a non-empty `evidence.citations`, because a fort in the `settlement`
    state has to be able to show the visitor the KMR sentence, the neighbouring
    record or the publication it is drawn from (§7.5.3). A malformed block fails
    the build here rather than reaching the app, which does no parsing and no
    guessing and can only obey what this file says.
    """
    interior = document.get("interior")
    monuments = document.get("monuments") or []
    has_fort = any(m.get("archetype") == "fort" for m in monuments)
    if interior is None:
        # §15: a fort site states its interior even when the gate fails, so that the
        # app can tell "the register records nothing built inside this fort" from
        # "this bundle predates the rule". Omitting the block is the second of
        # those, and a freshly built fort site must never look like it.
        if has_fort:
            raise ReconstructError(
                "this site has a fort but no interior block — a fort with no evidence says so "
                "positively (gate 'fail'), it does not go silent (§15.3)."
            )
        return
    if not isinstance(interior, dict):
        raise ReconstructError("interior must be an object (§15.1).")

    if not has_fort:
        raise ReconstructError(
            "interior is present but no monument is a fort — the block describes the "
            "ground inside an enclosure (§15.3)."
        )

    state = interior.get("state")
    if state not in INTERIOR_STATES:
        raise ReconstructError(f"interior.state must be cleared|settlement (§15.1), got {state!r}.")
    if state != INTERIOR_DEFAULT_STATE:
        raise ReconstructError(
            "interior.state is 'cleared' in v1.8: passing the gate makes the settlement "
            "state offerable, not on (§7.5.1)."
        )
    if interior.get("tradition") not in ("mainland", "limestone-ringfort"):
        raise ReconstructError(
            f"interior.tradition must be mainland|limestone-ringfort (§15.1), "
            f"got {interior.get('tradition')!r}."
        )

    offered = interior.get("settlementOffered")
    if not isinstance(offered, bool):
        raise ReconstructError("interior.settlementOffered must be a boolean (§15.3).")

    evidence = interior.get("evidence")
    if not isinstance(evidence, dict):
        raise ReconstructError("interior.evidence must be an object, present even on a fail (§15.1).")
    gate = evidence.get("gate")
    if gate not in ("pass", "fail"):
        raise ReconstructError(f"interior.evidence.gate must be pass|fail (§15.1), got {gate!r}.")
    if (gate == "pass") != offered:
        raise ReconstructError(
            "interior.evidence.gate and interior.settlementOffered must agree (§15.3)."
        )
    if not isinstance(evidence.get("hedged"), bool):
        raise ReconstructError("interior.evidence.hedged must be a boolean (§15.3).")
    if evidence.get("rule") != INTERIOR_RULE:
        raise ReconstructError(
            f"interior.evidence.rule must name the rule version {INTERIOR_RULE!r} (§15.1)."
        )
    channels = evidence.get("channels")
    if not isinstance(channels, list) or any(
        channel not in _CITATION_REQUIRED for channel in channels
    ):
        raise ReconstructError(
            "interior.evidence.channels must be drawn from description|settlement-record|cited "
            "(§15.1)."
        )

    citations = evidence.get("citations")
    if not isinstance(citations, list):
        raise ReconstructError("interior.evidence.citations must be an array (§15.1).")
    # "No citation, no state" (§15.3, §7.5.3).
    if offered and not citations:
        raise ReconstructError(
            "interior.settlementOffered is true with no citation — a fort in the settlement "
            "state must be able to show the sentence, record or publication it is drawn from "
            "(§7.5.3, §15.3)."
        )
    if not offered and citations:
        raise ReconstructError(
            "interior.evidence.citations is non-empty but the gate failed (§15.3)."
        )
    for citation in citations:
        channel = citation.get("channel")
        required = _CITATION_REQUIRED.get(channel)
        if required is None:
            raise ReconstructError(f"interior citation has unknown channel {channel!r} (§15.1).")
        if channel not in channels:
            raise ReconstructError(
                f"interior citation on channel {channel!r} is not listed in evidence.channels (§15.1)."
            )
        for key in required:
            if not citation.get(key):
                raise ReconstructError(
                    f"interior citation on channel {channel!r} is missing {key!r} (§15.3)."
                )
        if channel == "settlement-record" and citation["test"] not in ("polygon", "bbox"):
            raise ReconstructError(
                "a settlement-record citation's test must be polygon|bbox — a bounding box over "
                "a promontory fort reaches well outside the wall and must be shown as the weaker "
                "test it is (§7.5.2)."
            )

    ground = interior.get("ground")
    if not isinstance(ground, dict):
        raise ReconstructError("interior.ground must be an object (§15.1).")
    for patch in ground.get("clearedPatches") or ():
        for key in ("lengthM", "widthM"):
            value = patch.get(key)
            if not isinstance(value, (int, float)) or value <= 0:
                raise ReconstructError(f"a cleared patch needs a positive {key} (§15.1).")
        if patch["widthM"] > patch["lengthM"]:
            raise ReconstructError("a cleared patch's widthM must not exceed its lengthM (§15.1).")
        if not patch.get("sentence"):
            raise ReconstructError(
                "a cleared patch must quote the sentence that places it — patches are drawn only "
                "where KMR places them (§7.5.1)."
            )
    for forbidden in ("position", "positionM", "x", "z", "easting", "northing"):
        if forbidden in ground or any(forbidden in patch for patch in ground.get("clearedPatches") or ()):
            raise ReconstructError(
                f"{forbidden!r} must not appear in interior.ground — a patch is a size, an "
                "orientation and a compass sector, never a position (§15.3)."
            )

    buildings = interior.get("buildings")
    if buildings is None:
        return
    if not offered:
        raise ReconstructError(
            "interior.buildings is present on a fort that failed the gate — no buildings are "
            "drawn inside it at any opacity, under any label (§7.5.3)."
        )
    count = buildings.get("count")
    if count is not None and (not isinstance(count, int) or count <= 0):
        raise ReconstructError("interior.buildings.count must be a positive integer or null (§15.1).")
    if buildings.get("countStated") and count is None:
        raise ReconstructError(
            "interior.buildings.countStated is true with no count (§15.1)."
        )
    if buildings.get("layout") not in ("radial", "grouped", "free"):
        raise ReconstructError(
            f"interior.buildings.layout must be radial|grouped|free (§15.1), "
            f"got {buildings.get('layout')!r}."
        )
    sector = buildings.get("sector")
    if sector is not None and sector not in BEARINGS:
        raise ReconstructError(f"interior.buildings.sector must be a compass point (§15.3).")
    blocks = buildings.get("blocks")
    if blocks is not None and (not isinstance(blocks, int) or not 2 <= blocks <= 12):
        raise ReconstructError(
            "interior.buildings.blocks must be a stated block count of 2–12, or null (§15.1)."
        )
    street = buildings.get("streetWidthM")
    if street is not None:
        if (
            not isinstance(street, list)
            or len(street) != 2
            or not all(isinstance(value, (int, float)) for value in street)
            or not 0 < street[0] <= street[1]
        ):
            raise ReconstructError(
                "interior.buildings.streetWidthM must be a positive [lo, hi] band or null (§15.1)."
            )
    template = buildings.get("template")
    if template is not None:
        validate_building_template(template)


def validate_building_template(template: dict) -> None:
    """§15.3's checks on one archetype-H building spec.

    `hipPitchDeg ≥ roofPitchDeg` is the Eketorp-II error written as an assertion:
    a hip shallower than the long sides is the one roof shape the reconstruction
    literature says was never built (§6.H).
    """
    for key in ("lengthM", "widthM", "aisleWidthM", "trestleSpacingM"):
        band = template.get(key)
        if (
            not isinstance(band, list)
            or len(band) != 2
            or not all(isinstance(value, (int, float)) for value in band)
            or band[0] > band[1]
        ):
            raise ReconstructError(f"building {key} must be a [min, max] range with min ≤ max (§15.3).")
    if template.get("hipPitchDeg", 0) < template.get("roofPitchDeg", 0):
        raise ReconstructError(
            "a building's hipPitchDeg must be ≥ its roofPitchDeg — a hip shallower than the "
            "long sides is the Eketorp-II error (§6.H, §15.3)."
        )
    if template.get("wallHeightM", 0) < 1.0:
        raise ReconstructError(
            "a building's wallHeightM must be ≥ 1.0 m: the wall is load-bearing, not a footing "
            "(Näsman 1976, §6.H)."
        )
    if not 0.3 <= template.get("aisleFraction", 0) <= 0.6:
        raise ReconstructError("a building's aisleFraction must be in [0.3, 0.6] (§6.H, §15.3).")
    tiers = template.get("tiers")
    if not isinstance(tiers, dict) or any(
        tiers.get(key) not in ("measured", "derived", "assumed") for key in ("plan", "profile", "surface")
    ):
        raise ReconstructError("a building needs a measured|derived|assumed tier per part (§9.1).")


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
    document = build_document(
        sites,
        cfg.id,
        params,
        county=getattr(cfg, "county", "") or "",
        kommun=getattr(cfg, "kommun", "") or "",
        fort_id=(cfg.raa or {}).get("lamningsnummer", ""),
    )
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

    interior = document.get("interior")
    if interior is not None:
        evidence = interior["evidence"]
        discarded = ", ".join(f"{key} {value}" for key, value in evidence["discarded"].items())
        print(
            f"-- interior ({interior['tradition']}): gate {evidence['gate']}, "
            f"state {interior['state']}, settlement offered "
            f"{str(evidence['gate'] == 'pass').lower()} "
            f"[channels: {', '.join(evidence['channels']) or 'none'}]"
        )
        print(f"   strong-tier terms {evidence['terms'] or '[]'}; discarded {discarded}")
        for citation in evidence["citations"]:
            if citation["channel"] == "description":
                print(
                    f"     \"{citation['matched']}\""
                    f"{' (hedged)' if citation['hedged'] else ''}: {citation['sentence'][:110]}"
                )
            elif citation["channel"] == "settlement-record":
                print(
                    f"     {citation['id']} {citation['lamningstyp']} "
                    f"inside the extent ({citation['test']})"
                )
            else:
                print(f"     cited: {citation['reference']}")
        buildings = interior["buildings"]
        if buildings:
            print(
                f"   buildings: count {buildings['count']} "
                f"({'stated' if buildings['countStated'] else 'not stated'}), "
                f"layout {buildings['layout']}, sector {buildings['sector']}, "
                f"groups {buildings['groups']}, blocks {buildings['blocks']}, "
                f"street {buildings['streetWidthM']}"
            )
        ground = interior["ground"]
        print(
            f"   cleared ground: {len(ground['clearedPatches'])} recorded patches, "
            f"terrain words {ground['terrainWords'][:4] or '[]'}"
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
