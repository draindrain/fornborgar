"""Join: does interior-building evidence concentrate in high-confidence forts?

    python3 confidence_join.py [--survey ../../docs/interior-survey-2026-08-30.json]
                               [--json ../../docs/confidence-join-2026-09-12.json]

The national interior survey (`docs/interior-survey-2026-08-30.md`) measures
interior-building evidence over *every* registered `Fornborg` — all 1 304 — and
closes by naming its own follow-up: every rate there is over a denominator that
includes the two-thirds Olausson's criteria would reject as not genuinely
fortified. `reconstruct.fort_confidence` (§6.A.1) scores all four Mälardalen
criteria per fort, but its distribution across the 1 304 has never been looked
at, so nobody knows whether the 4.1 % refined rate is a flat national fact or a
diluted version of a much higher rate among real forts.

This script answers that **without any new download**. The survey's companion
JSON already carries every fort's slug *and its full KMR description*, which is
the only input `fort_confidence` needs beyond the parsed plan. So:

  1. replay each fort's description through the real pipeline — `normalise`,
     `type_clause`, `parse_plan`, `parse_fort` — via `build_monument`, so the
     score is the *shipped* score and not a re-implementation;
  2. join that score onto the survey's per-fort evidence flags by slug;
  3. cross-tabulate evidence rate against confidence, and test the association.

The confound this has to survive: both variables are mined from the *same
sentence soup*. A fort with a 2 000-character description has more room to say
"kallmurad" (raising confidence) *and* more room to say "husgrund" (raising
evidence), with no archaeology involved. Every headline number here is therefore
also reported stratified by description length, and the script prints the
within-stratum rates so a spurious whole-sample association cannot hide.

No dependency beyond the standard library and `fornborg_pipeline`; nothing is
written outside `docs/` and nothing in the pipeline or app reads the output.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
PIPELINE_ROOT = HERE.parent
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

import re  # noqa: E402

from fornborg_pipeline.reconstruct import (  # noqa: E402
    DEFAULT_PARAMS,
    build_monument,
    fort_confidence,
    normalise,
)

#: `reconstruct._DRYSTONE` matches five inflections of *kallmur*; the register
#: also writes `kallmurade`, `kallmursteknik`, and — where the KMR text lost its
#: hard line breaks without gaining a space — `ikallmur`, `denkallmurade`. This
#: deliberately over-wide pattern exists only to bound how much the strictness
#: of that word list could be hiding (see the sensitivity block below). It is
#: not a proposed fix and nothing here writes it back into the pipeline.
_DRYSTONE_WIDE = re.compile(r"kallmur", re.IGNORECASE)

REPO_ROOT = PIPELINE_ROOT.parent
DEFAULT_SURVEY = REPO_ROOT / "docs" / "interior-survey-2026-08-30.json"
DEFAULT_OUT = REPO_ROOT / "docs" / "confidence-join-2026-09-12.json"

#: §6.A.1 / `TransformParams.fort_confidence_threshold`. At or above this a fort
#: renders as a standing Migration Period rampart; below it, as a low bank.
THRESHOLD = DEFAULT_PARAMS.fort_confidence_threshold

#: The survey's three nested evidence measures, weakest first (report §6).
MEASURES = [
    ("broad", "interiorLanguage or a settlement record inside the extent (upper bound)"),
    ("refined", "refinedInteriorEvidence — strong-tier clean language or a settlement record"),
    ("strongConfident", "strong-tier, unhedged, non-modern language only (floor)"),
]


# --------------------------------------------------------------------------- #
# statistics — small hand-rolled versions, so there is no scipy dependency
# --------------------------------------------------------------------------- #


def wilson(k: int, n: int) -> tuple[float, float]:
    """95 % Wilson score interval — behaves at the small counts this join has."""
    if n == 0:
        return (0.0, 0.0)
    z = 1.959963985
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def fisher_exact_two_sided(a: int, b: int, c: int, d: int) -> float:
    """Two-sided Fisher exact p for [[a, b], [c, d]], by summing tail tables.

    The counts here are small (54 positives over 1 304) and several cells go to
    zero, which is exactly where the chi-square approximation stops being
    trustworthy — hence the exact test.
    """
    n = a + b + c + d
    row1, col1 = a + b, a + c

    def logfact(x: int) -> float:
        return math.lgamma(x + 1)

    const = (
        logfact(row1)
        + logfact(n - row1)
        + logfact(col1)
        + logfact(n - col1)
        - logfact(n)
    )

    def prob(x: int) -> float:
        return math.exp(
            const
            - logfact(x)
            - logfact(row1 - x)
            - logfact(col1 - x)
            - logfact(n - row1 - col1 + x)
        )

    observed = prob(a)
    lo = max(0, col1 - (n - row1))
    hi = min(row1, col1)
    total = 0.0
    for x in range(lo, hi + 1):
        p = prob(x)
        if p <= observed * (1 + 1e-9):
            total += p
    return min(1.0, total)


def mantel_haenszel(strata: list[tuple[int, int, int, int]]) -> dict:
    """Mantel–Haenszel common odds ratio + test, pooling over strata.

    This is the confound control: each stratum is one description-length band,
    so an association that is really "longer text says more of everything"
    cancels out here while a real one survives.
    """
    num = den = 0.0
    obs = exp = var = 0.0
    for a, b, c, d in strata:
        n = a + b + c + d
        if n == 0:
            continue
        num += a * d / n
        den += b * c / n
        row1, col1 = a + b, a + c
        obs += a
        exp += row1 * col1 / n
        if n > 1:
            var += (row1 * (n - row1) * col1 * (n - col1)) / (n * n * (n - 1))
    if den == 0 or var == 0:
        return {"oddsRatio": None, "chiSquare": None, "p": None}
    chi = (abs(obs - exp) - 0.5) ** 2 / var
    # survival of chi-square with 1 df == erfc(sqrt(chi/2))
    p = math.erfc(math.sqrt(chi / 2.0))
    return {"oddsRatio": round(num / den, 3), "chiSquare": round(chi, 3), "p": p}


def spearman(xs: list[float], ys: list[float]) -> float:
    """Rank correlation with midranks for ties — the scores are heavily tied."""

    def ranks(vs: list[float]) -> list[float]:
        order = sorted(range(len(vs)), key=lambda i: vs[i])
        out = [0.0] * len(vs)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and vs[order[j + 1]] == vs[order[i]]:
                j += 1
            mid = (i + j) / 2 + 1
            for k in range(i, j + 1):
                out[order[k]] = mid
            i = j + 1
        return out

    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return round(num / den, 4) if den else 0.0


def odds_ratio(a: int, b: int, c: int, d: int) -> float | None:
    """Haldane–Anscombe corrected, so a zero cell still yields a number."""
    if min(a, b, c, d) == 0:
        a, b, c, d = a + 0.5, b + 0.5, c + 0.5, d + 0.5
    if b == 0 or c == 0:
        return None
    return round((a * d) / (b * c), 3)


# --------------------------------------------------------------------------- #
# the join
# --------------------------------------------------------------------------- #


def score_fort(fort: dict) -> dict:
    """Replay one survey fort through the shipped parser.

    `build_monument` is used rather than `fort_confidence` directly so that the
    plan span fed to the *compactEnclosure* criterion is the one the pipeline
    would really use — the plan parsed out of the description, with the
    archetype default when the text gives no size. The variant scored against
    the fort's KMR *extent* span is computed alongside it as a sensitivity
    check, because the two disagree more often than one would hope.
    """
    text = fort.get("description") or ""
    record = {
        "id": fort["slug"],
        "lamningstyp": "Fornborg",
        "description": text,
    }
    monument = build_monument(record, DEFAULT_PARAMS)
    if monument is None or "fort" not in monument:  # pragma: no cover — defensive
        raise RuntimeError(f"{fort['slug']}: no fort record came back")
    shipped = monument["fort"]

    # Sensitivity: same criteria, but *compactEnclosure* judged on the measured
    # KMR extent instead of the parsed plan text.
    normalised = normalise(text)
    variant = fort_confidence(
        normalised, fort.get("extentSpanM"), shipped["ramparts"]
    )

    criteria = shipped["criteria"]
    wide_dry = bool(_DRYSTONE_WIDE.search(normalised))
    wide = (
        0.40 * wide_dry
        + 0.30 * bool(criteria["wallAtLeast1m"])
        + 0.15 * bool(criteria["wallRoundOrAcross"])
        + 0.15 * bool(criteria["compactEnclosure"])
    )

    return {
        "confidence": shipped["confidence"],
        "criteria": shipped["criteria"],
        "drystoneWide": wide_dry,
        "confidenceWideDrystone": round(wide, 2),
        "planSource": monument["plan"]["source"],
        "planSpanM": monument["plan"].get("lengthM") or monument["plan"]["diameterM"],
        "confidenceOnExtentSpan": variant["confidence"],
        "rampartCount": len(shipped["ramparts"]),
    }


def evidence_flags(fort: dict) -> dict:
    return {
        "broad": bool(fort["interiorLanguage"] or fort["settlementInside"]),
        "refined": bool(fort["refinedInteriorEvidence"]),
        "strongConfident": bool(fort["interiorLanguageStrongConfident"]),
        "settlementInside": bool(fort["settlementInside"]),
    }


def two_by_two(rows: list[dict], measure: str, key) -> tuple[int, int, int, int]:
    """(hi+, hi-, lo+, lo-) for one evidence measure under a hi/lo predicate."""
    a = b = c = d = 0
    for r in rows:
        hit = r["evidence"][measure]
        if key(r):
            a, b = a + hit, b + (not hit)
        else:
            c, d = c + hit, d + (not hit)
    return a, b, c, d


def rate_block(k: int, n: int) -> dict:
    lo, hi = wilson(k, n)
    return {
        "n": n,
        "k": k,
        "rate": round(k / n, 4) if n else None,
        "ci95": [round(lo, 4), round(hi, 4)],
    }


def quantile_bands(values: list[int], bands: int = 4) -> list[int]:
    """Cut points splitting `values` into roughly equal-count bands."""
    ordered = sorted(values)
    return [ordered[int(len(ordered) * i / bands)] for i in range(1, bands)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--survey", type=Path, default=DEFAULT_SURVEY)
    ap.add_argument("--json", dest="out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    survey = json.loads(args.survey.read_text(encoding="utf-8"))
    forts = survey["forts"]

    rows: list[dict] = []
    for fort in forts:
        scored = score_fort(fort)
        rows.append(
            {
                "slug": fort["slug"],
                "lamningsnummer": fort["lamningsnummer"],
                "region": fort["region"],
                "descriptionChars": fort["descriptionChars"],
                "classification": fort["classification"],
                "evidence": evidence_flags(fort),
                **scored,
            }
        )

    n = len(rows)
    scores = sorted({r["confidence"] for r in rows})
    hist = Counter(r["confidence"] for r in rows)
    criteria_rates = {
        name: sum(bool(r["criteria"][name]) for r in rows) / n
        for name in ("kallmurning", "wallAtLeast1m", "wallRoundOrAcross", "compactEnclosure")
    }

    high = lambda r: r["confidence"] >= THRESHOLD  # noqa: E731
    n_high = sum(1 for r in rows if high(r))

    # --- headline: evidence rate above vs below the shipped threshold ------- #
    headline: dict = {}
    for measure, gloss in MEASURES:
        a, b, c, d = two_by_two(rows, measure, high)
        headline[measure] = {
            "gloss": gloss,
            "high": rate_block(a, a + b),
            "low": rate_block(c, c + d),
            "rateRatio": round((a / (a + b)) / (c / (c + d)), 3)
            if (a + b) and (c + d) and c
            else None,
            "oddsRatio": odds_ratio(a, b, c, d),
            "fisherP": fisher_exact_two_sided(a, b, c, d),
        }

    # --- dose-response: rate per distinct score ----------------------------- #
    by_score = []
    for s in scores:
        subset = [r for r in rows if r["confidence"] == s]
        entry = {"confidence": s, "n": len(subset)}
        for measure, _ in MEASURES:
            k = sum(r["evidence"][measure] for r in subset)
            entry[measure] = rate_block(k, len(subset))
        by_score.append(entry)

    # --- per criterion, independently of the combined score ----------------- #
    by_criterion = {}
    for name in ("kallmurning", "wallAtLeast1m", "wallRoundOrAcross", "compactEnclosure"):
        pred = lambda r, nm=name: bool(r["criteria"][nm])  # noqa: E731
        entry = {}
        for measure, _ in MEASURES:
            a, b, c, d = two_by_two(rows, measure, pred)
            entry[measure] = {
                "with": rate_block(a, a + b),
                "without": rate_block(c, c + d),
                "oddsRatio": odds_ratio(a, b, c, d),
                "fisherP": fisher_exact_two_sided(a, b, c, d),
            }
        by_criterion[name] = entry

    # --- the confound: description length ----------------------------------- #
    cuts = quantile_bands([r["descriptionChars"] for r in rows], 4)

    def band_of(chars: int) -> int:
        return sum(chars >= c for c in cuts)

    length_bands = []
    for band in range(4):
        subset = [r for r in rows if band_of(r["descriptionChars"]) == band]
        chars = [r["descriptionChars"] for r in subset]
        entry = {
            "band": band,
            "charRange": [min(chars), max(chars)] if chars else None,
            "n": len(subset),
            "meanConfidence": round(sum(r["confidence"] for r in subset) / len(subset), 3)
            if subset
            else None,
            "highShare": round(sum(1 for r in subset if high(r)) / len(subset), 3)
            if subset
            else None,
        }
        for measure, _ in MEASURES:
            a, b, c, d = two_by_two(subset, measure, high)
            entry[measure] = {
                "high": rate_block(a, a + b),
                "low": rate_block(c, c + d),
                "oddsRatio": odds_ratio(a, b, c, d),
            }
        length_bands.append(entry)

    stratified = {}
    for measure, _ in MEASURES:
        strata = []
        for band in range(4):
            subset = [r for r in rows if band_of(r["descriptionChars"]) == band]
            strata.append(two_by_two(subset, measure, high))
        stratified[measure] = {
            "strata": [list(s) for s in strata],
            **mantel_haenszel(strata),
        }

    # Finer strata, as a robustness check on the four-band pooling: if the
    # association is really length, ten bands should kill it just as dead.
    dec_cuts = quantile_bands([r["descriptionChars"] for r in rows], 10)

    def decile_of(chars: int) -> int:
        return sum(chars >= c for c in dec_cuts)

    stratified_deciles = {}
    for measure, _ in MEASURES:
        strata = []
        for band in range(10):
            subset = [r for r in rows if decile_of(r["descriptionChars"]) == band]
            strata.append(two_by_two(subset, measure, high))
        stratified_deciles[measure] = mantel_haenszel(strata)

    confound = {
        "spearmanCharsVsConfidence": spearman(
            [r["descriptionChars"] for r in rows], [r["confidence"] for r in rows]
        ),
        "meanCharsRefinedPositive": round(
            sum(r["descriptionChars"] for r in rows if r["evidence"]["refined"])
            / max(1, sum(1 for r in rows if r["evidence"]["refined"]))
        ),
        "meanCharsRefinedNegative": round(
            sum(r["descriptionChars"] for r in rows if not r["evidence"]["refined"])
            / max(1, sum(1 for r in rows if not r["evidence"]["refined"]))
        ),
        "meanCharsHigh": round(
            sum(r["descriptionChars"] for r in rows if high(r)) / max(1, n_high)
        ),
        "meanCharsLow": round(
            sum(r["descriptionChars"] for r in rows if not high(r)) / max(1, n - n_high)
        ),
        "decileCutsChars": dec_cuts,
        "mantelHaenszelDeciles": stratified_deciles,
    }

    # --- what the Mälardalen figure would predict --------------------------- #
    # ~17–21 % of genuinely fortified Middle Iron Age forts carry interior
    # buildings (report §6.1). If the score selected that population, the
    # high-confidence refined rate should land near there.
    a, b, c, d = two_by_two(rows, "refined", high)
    malardalen = {
        "predictedHighRate": [0.17, 0.21],
        "observedHighRate": round(a / (a + b), 4) if (a + b) else None,
        "positivesInHigh": a,
        "positivesTotal": a + c,
        "shareOfPositivesInHigh": round(a / (a + c), 4) if (a + c) else None,
        "highShareOfAllForts": round(n_high / n, 4),
    }

    # --- sensitivity: extent-span variant of compactEnclosure ---------------- #
    high_v = lambda r: r["confidenceOnExtentSpan"] >= THRESHOLD  # noqa: E731
    sensitivity = {"nHighExtentVariant": sum(1 for r in rows if high_v(r))}
    for measure, _ in MEASURES:
        a2, b2, c2, d2 = two_by_two(rows, measure, high_v)
        sensitivity[measure] = {
            "high": rate_block(a2, a2 + b2),
            "low": rate_block(c2, c2 + d2),
            "oddsRatio": odds_ratio(a2, b2, c2, d2),
            "fisherP": fisher_exact_two_sided(a2, b2, c2, d2),
        }

    # --- per region, because the score is partly a survey-style meter --------- #
    by_region = {}
    for region in sorted({r["region"] for r in rows}):
        subset = [r for r in rows if r["region"] == region]
        hi = [r for r in subset if high(r)]
        by_region[region] = {
            "n": len(subset),
            "high": len(hi),
            "highShare": round(len(hi) / len(subset), 4),
            "meanChars": round(sum(r["descriptionChars"] for r in subset) / len(subset)),
            "refined": sum(r["evidence"]["refined"] for r in subset),
            "refinedInHigh": sum(r["evidence"]["refined"] for r in hi),
        }

    # The starkest form of the confound: a fort cannot reach the threshold on a
    # description too short to contain the words the criteria look for.
    thin = {
        "descriptionUnder200Chars": sum(1 for r in rows if r["descriptionChars"] < 200),
        "ofWhichHighConfidence": sum(
            1 for r in rows if r["descriptionChars"] < 200 and high(r)
        ),
        "shortestHighConfidenceDescription": min(
            (r["descriptionChars"] for r in rows if high(r)), default=None
        ),
    }

    # --- what a confidence-gated default would actually do ------------------- #
    consequences = {
        "highConfidenceForts": n_high,
        "highConfidenceWithNoEvidenceAtAll": sum(
            1 for r in rows if high(r) and not r["evidence"]["broad"]
        ),
        "refinedPositivesInHigh": sum(
            1 for r in rows if high(r) and r["evidence"]["refined"]
        ),
        "refinedPositivesInLow": sum(
            1 for r in rows if not high(r) and r["evidence"]["refined"]
        ),
    }

    # --- sensitivity: the strictness of the kallmur* word list --------------- #
    high_w = lambda r: r["confidenceWideDrystone"] >= THRESHOLD  # noqa: E731
    n_high_wide = sum(1 for r in rows if high_w(r))
    sensitivity_dry = {
        "drystoneWordList": sum(1 for r in rows if r["criteria"]["kallmurning"]),
        "drystoneSubstring": sum(1 for r in rows if r["drystoneWide"]),
        "nHighWordList": n_high,
        "nHighSubstring": n_high_wide,
    }
    for measure, _ in MEASURES:
        a2, b2, c2, d2 = two_by_two(rows, measure, high_w)
        strata = []
        for band in range(4):
            subset = [r for r in rows if band_of(r["descriptionChars"]) == band]
            strata.append(two_by_two(subset, measure, high_w))
        sensitivity_dry[measure] = {
            "high": rate_block(a2, a2 + b2),
            "low": rate_block(c2, c2 + d2),
            "oddsRatio": odds_ratio(a2, b2, c2, d2),
            "fisherP": fisher_exact_two_sided(a2, b2, c2, d2),
            "mantelHaenszel": mantel_haenszel(strata),
        }

    out = {
        "_note": (
            "RESEARCH OUTPUT. A join on docs/interior-survey-2026-08-30.json — no new "
            "data was downloaded. Answers the follow-up that survey names in its own "
            "closing section, and reconstruction-mode.md §11 decision 6's outstanding "
            "homework (the fortConfidence distribution over the 1 304). Nothing in the "
            "pipeline or the app reads this file."
        ),
        "generated": "2026-09-12",
        "question": (
            "Does interior-building evidence concentrate in the forts that "
            "fortConfidence (§6.A.1) scores as genuinely fortified?"
        ),
        "method": {
            "survey": str(args.survey.name),
            "scorer": "fornborg_pipeline.reconstruct.build_monument → fort['confidence']",
            "threshold": THRESHOLD,
            "denominator": n,
            "confound": (
                "Both variables are mined from the same description text, so every "
                "headline is repeated stratified by description-length quartile and "
                "pooled with Mantel–Haenszel."
            ),
        },
        "distribution": {
            "n": n,
            "histogram": {str(s): hist[s] for s in scores},
            "atOrAboveThreshold": n_high,
            "atOrAboveThresholdRate": round(n_high / n, 4),
            "mean": round(sum(r["confidence"] for r in rows) / n, 4),
            "median": sorted(r["confidence"] for r in rows)[n // 2],
            "criteriaPassRates": {k: round(v, 4) for k, v in criteria_rates.items()},
            "planSourceMeasured": sum(1 for r in rows if r["planSource"] == "measured"),
        },
        "headline": headline,
        "byScore": by_score,
        "byCriterion": by_criterion,
        "lengthBands": {"cutsChars": cuts, "bands": length_bands},
        "stratified": stratified,
        "confound": {**confound, "thinDescriptions": thin},
        "byRegion": by_region,
        "consequences": consequences,
        "malardalenCheck": malardalen,
        "sensitivityExtentSpan": sensitivity,
        "sensitivityDrystoneWordList": sensitivity_dry,
        "forts": [
            {
                "slug": r["slug"],
                "lamningsnummer": r["lamningsnummer"],
                "region": r["region"],
                "descriptionChars": r["descriptionChars"],
                "confidence": r["confidence"],
                "confidenceOnExtentSpan": r["confidenceOnExtentSpan"],
                "confidenceWideDrystone": r["confidenceWideDrystone"],
                "criteria": r["criteria"],
                "planSource": r["planSource"],
                "classification": r["classification"],
                **r["evidence"],
            }
            for r in rows
        ],
    }

    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    # ----------------------------------------------------------------- report #
    def pct(x: float | None) -> str:
        return "—" if x is None else f"{100 * x:.1f} %"

    print(f"forts scored: {n}   threshold {THRESHOLD}")
    print("\nfortConfidence distribution")
    for s in scores:
        bar = "#" * round(60 * hist[s] / max(hist.values()))
        print(f"  {s:>4}  {hist[s]:>4}  {bar}")
    print(f"  >= {THRESHOLD}: {n_high} ({pct(n_high / n)})")
    print("  criteria pass rates: " + ", ".join(f"{k} {pct(v)}" for k, v in criteria_rates.items()))

    print("\nevidence rate, high vs low confidence")
    for measure, _ in MEASURES:
        h, l = headline[measure]["high"], headline[measure]["low"]
        print(
            f"  {measure:<16} high {h['k']:>3}/{h['n']:<4} {pct(h['rate']):>7} "
            f"[{pct(h['ci95'][0])}–{pct(h['ci95'][1])}]   "
            f"low {l['k']:>3}/{l['n']:<4} {pct(l['rate']):>7} "
            f"[{pct(l['ci95'][0])}–{pct(l['ci95'][1])}]   "
            f"OR {headline[measure]['oddsRatio']}  p {headline[measure]['fisherP']:.3f}"
        )

    print("\ndose-response by score")
    for e in by_score:
        print(
            f"  {e['confidence']:>4}  n={e['n']:<4} "
            f"broad {pct(e['broad']['rate']):>7}  refined {pct(e['refined']['rate']):>7} "
            f"strongConfident {pct(e['strongConfident']['rate']):>7}"
        )

    print("\nper criterion (refined measure)")
    for name, e in by_criterion.items():
        r = e["refined"]
        print(
            f"  {name:<20} with {pct(r['with']['rate']):>7} (n={r['with']['n']})   "
            f"without {pct(r['without']['rate']):>7} (n={r['without']['n']})   "
            f"OR {r['oddsRatio']}  p {r['fisherP']:.3f}"
        )

    print(f"\ndescription-length bands (cuts {cuts} chars)")
    for e in length_bands:
        r = e["refined"]
        print(
            f"  band {e['band']} {str(e['charRange']):>14} n={e['n']:<4} "
            f"highShare {pct(e['highShare']):>7}  refined high {pct(r['high']['rate']):>7} "
            f"(n={r['high']['n']})  low {pct(r['low']['rate']):>7} (n={r['low']['n']})  "
            f"OR {r['oddsRatio']}"
        )

    print("\nMantel–Haenszel pooled over length bands")
    for measure, _ in MEASURES:
        s = stratified[measure]
        p = "—" if s["p"] is None else f"{s['p']:.3f}"
        print(f"  {measure:<16} OR {s['oddsRatio']}  chi2 {s['chiSquare']}  p {p}")

    print("  pooled over description-length deciles")
    for measure, _ in MEASURES:
        s = stratified_deciles[measure]
        p = "—" if s["p"] is None else f"{s['p']:.3f}"
        print(f"    {measure:<14} OR {s['oddsRatio']}  chi2 {s['chiSquare']}  p {p}")
    print(
        f"  Spearman(chars, confidence) = {confound['spearmanCharsVsConfidence']}; "
        f"mean chars high {confound['meanCharsHigh']} vs low {confound['meanCharsLow']}; "
        f"refined+ {confound['meanCharsRefinedPositive']} vs refined- "
        f"{confound['meanCharsRefinedNegative']}"
    )

    print(
        f"  thin records: {thin['descriptionUnder200Chars']} forts under 200 chars, "
        f"{thin['ofWhichHighConfidence']} of them high-confidence; shortest "
        f"high-confidence description {thin['shortestHighConfidenceDescription']} chars"
    )

    print("\nhigh-confidence share by region (n >= 20)")
    for region, e in sorted(by_region.items(), key=lambda kv: -kv[1]["highShare"]):
        if e["n"] < 20:
            continue
        print(
            f"  {region:<20} n={e['n']:<4} high {pct(e['highShare']):>7} "
            f"meanChars {e['meanChars']:>5}  refined {e['refined']:>2} "
            f"({e['refinedInHigh']} in high)"
        )

    print("\nMälardalen check (refined)")
    print(
        f"  predicted high-confidence rate 17–21 %; observed "
        f"{pct(malardalen['observedHighRate'])}; "
        f"{malardalen['positivesInHigh']}/{malardalen['positivesTotal']} positives "
        f"({pct(malardalen['shareOfPositivesInHigh'])}) sit in the "
        f"{pct(malardalen['highShareOfAllForts'])} of forts above threshold"
    )

    print("\nsensitivity — compactEnclosure judged on the KMR extent span")
    print(f"  high-confidence n = {sensitivity['nHighExtentVariant']}")
    for measure, _ in MEASURES:
        s = sensitivity[measure]
        print(
            f"  {measure:<16} high {pct(s['high']['rate']):>7}  low {pct(s['low']['rate']):>7} "
            f" OR {s['oddsRatio']}  p {s['fisherP']:.3f}"
        )

    print("\nsensitivity — kallmur* as substring instead of the five-form word list")
    print(
        f"  drystone criterion passes {sensitivity_dry['drystoneWordList']} → "
        f"{sensitivity_dry['drystoneSubstring']} forts; high-confidence "
        f"{sensitivity_dry['nHighWordList']} → {sensitivity_dry['nHighSubstring']}"
    )
    for measure, _ in MEASURES:
        s = sensitivity_dry[measure]
        mh = s["mantelHaenszel"]
        mp = "—" if mh["p"] is None else f"{mh['p']:.3f}"
        print(
            f"  {measure:<16} high {pct(s['high']['rate']):>7}  low {pct(s['low']['rate']):>7} "
            f" OR {s['oddsRatio']}  p {s['fisherP']:.3f}   MH OR {mh['oddsRatio']} p {mp}"
        )

    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
