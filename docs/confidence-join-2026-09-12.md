# Does interior-building evidence track fort confidence?

> **Research output, not a specification.** This file answers the follow-up that
> `docs/interior-survey-2026-08-30.md` §7 names for itself, and discharges the homework
> `docs/reconstruction-mode.md` **§11 decision 6** still owes — *a look at the `fortConfidence`
> score distribution across the 1 304 registry forts*. Nothing in the pipeline or the app reads
> it, no schema depends on it, and it does not amend §6.A.1, §7.5 or §11. Companion data:
> `docs/confidence-join-2026-09-12.json`; the script is `pipeline/spike/confidence_join.py`.

Computed **2026-09-12** as a **join on `docs/interior-survey-2026-08-30.json`**. No new data was
downloaded: that file already carries all 1 304 slugs *and* each fort's full KMR description,
which is the only input `fort_confidence` needs. Each description was replayed through the real
`fornborg_pipeline.reconstruct.build_monument`, so every score below is the **shipped** score,
not a re-implementation of it. Validation: Broborg (`l1943-7827`) comes back at **1.00 on all
four criteria**, exactly as §11 decision 6 records.

---

## 0. Verdict

**No.** Interior-building evidence does **not** concentrate in high-confidence forts.

The crude comparison looks like a signal — **6.0 % of high-confidence forts carry refined
interior evidence against 3.2 % of low-confidence ones**, odds ratio 1.92, Fisher p = 0.026. It
does not survive the one control it has to survive. Both variables are mined from the same block
of prose, and once the comparison is stratified by description length the association goes to
nothing: **Mantel–Haenszel OR 1.08, p = 0.91** over four length bands, **OR 1.11, p = 0.83** over
ten. Every sensitivity run reproduces the same collapse.

The observed high-confidence rate of 6.0 % is also nowhere near the **17–21 %** the Mälardalen
figure would predict if the score were selecting that population. And **28 of the 54 positives
(52 %) sit below the threshold**, in forts the app already refuses to draw as standing ramparts.

**This is not grounds to reopen §1's decision.** The survey's recommendation stands unchanged and
is, if anything, better supported than before: a uniform `cleared` default, with `settlement`
offered per fort where the register itself names the buildings — all 54 of them, regardless of
confidence.

---

## 1. The distribution §11 decision 6 asked for

The primary deliverable, independent of the interior question. All 1 304 forts, scored by
`fort_confidence`, threshold 0.60.

| Score | Forts | | Criterion | Passes | Rate |
|---:|---:|---|---|---:|---:|
| 0.00 | 14 | | `kallmurning` (0.40) | 275 | 21.1 % |
| 0.15 | 441 | | `wallAtLeast1m` (0.30) | 535 | 41.0 % |
| 0.30 | 238 | | `wallRoundOrAcross` (0.15) | 651 | 49.9 % |
| 0.40 | 1 | | `compactEnclosure` (0.15) | 1 216 | 93.3 % |
| 0.45 | 151 |
| 0.55 | 26 |
| **0.60** | **185** |
| 0.70 | 62 |
| 0.85 | 67 |
| 1.00 | 119 |

**433 forts (33.2 %) reach the threshold**; 871 (66.8 %) fall below it and render as the low bank
§6.A.1 specifies. Mean 0.42, median 0.30. The distribution is strongly bimodal: 441 forts sit at
exactly 0.15 (compactness alone), and 119 score a perfect 1.00.

The national 33.2 % pass rate is *close* to Olausson's "roughly one third of Uppland's forts are
genuinely fortified" — but the resemblance is an artefact of averaging, and §3 shows why it
should not be taken as validation.

Two properties of the score are worth stating plainly because they are load-bearing for
everything below:

- **`compactEnclosure` is nearly free.** 93.3 % of forts pass it, so its 0.15 is close to a
  constant offset rather than a discriminator. The score is in practice driven by `kallmurning`
  and `wallAtLeast1m`, which between them carry 0.70 of the 1.00.
- **No fort with a thin description can reach the threshold.** Of the 213 forts with a
  description under 200 characters, **zero** score ≥ 0.60; the shortest high-confidence
  description is 233 characters. That is not a bug in the score — a criterion cannot fire on
  words that are not there — but it means the score is partly a measure of *how much the surveyor
  wrote*, which is precisely the confound the interior question runs into.

---

## 2. The join — evidence rate above and below the threshold

The survey's three nested measures, weakest to strongest, cross-tabulated against the threshold.

| Measure | High conf. (n = 433) | Low conf. (n = 871) | OR | Fisher *p* |
|---|---:|---:|---:|---:|
| **broad** — any interior language or a settlement record (upper bound) | 59 — **13.6 %** [10.7–17.2] | 91 — **10.4 %** [8.6–12.7] | 1.35 | 0.097 |
| **refined** — `refinedInteriorEvidence`, the survey's working figure | 26 — **6.0 %** [4.1–8.6] | 28 — **3.2 %** [2.2–4.6] | 1.92 | **0.026** |
| **strongConfident** — unhedged, non-modern strong-tier only (floor) | 12 — **2.8 %** [1.6–4.8] | 15 — **1.7 %** [1.1–2.8] | 1.63 | 0.220 |

Brackets are 95 % Wilson intervals. Taken at face value this is a ~1.9× enrichment on the working
measure, significant at 5 %. §4 is why that reading is wrong.

There is also **no dose–response**, which a real biological-style signal would normally show:

| Score | n | broad | refined | strongConfident |
|---:|---:|---:|---:|---:|
| 0.00 | 14 | **28.6 %** | 7.1 % | **7.1 %** |
| 0.15 | 441 | 9.3 % | 2.9 % | 1.1 % |
| 0.30 | 238 | 10.1 % | 1.7 % | 0.8 % |
| 0.45 | 151 | 11.3 % | 4.6 % | 2.6 % |
| 0.55 | 26 | 19.2 % | **11.5 %** | **11.5 %** |
| 0.60 | 185 | 15.7 % | 6.5 % | 3.2 % |
| 0.70 | 62 | 6.5 % | 3.2 % | 3.2 % |
| 0.85 | 67 | 14.9 % | 9.0 % | 3.0 % |
| 1.00 | 119 | 13.5 % | 5.0 % | 1.7 % |

The highest broad rate in the table is at confidence **0.00**, and the highest refined rate is at
**0.55** — one notch *below* the threshold. The 119 forts that pass all four criteria perfectly
carry refined evidence at 5.0 %, lower than the 0.55 band and barely above the national 4.1 %.
Broborg, the one fort in the register scored 1.00 that we know most about, carries **no interior
evidence at all** in its KMR text — its interior occupation is dated AD 432–542 by excavation and
is invisible from the surface (§7.5). The two measures are simply not looking at the same thing.

Per criterion, independently of the combined score (refined measure):

| Criterion | with | without | OR | *p* |
|---|---:|---:|---:|---:|
| `wallAtLeast1m` | 5.8 % (n = 535) | 3.0 % (n = 769) | 2.00 | 0.016 |
| `kallmurning` | 6.2 % (n = 275) | 3.6 % (n = 1 029) | 1.77 | 0.062 |
| `wallRoundOrAcross` | 4.5 % (n = 651) | 3.8 % (n = 653) | 1.17 | 0.582 |
| `compactEnclosure` | 4.0 % (n = 1 216) | 6.8 % (n = 88) | 0.56 | 0.172 |

The two criteria that carry any apparent signal are exactly the two that **require the surveyor to
have written a specific measurement or technical term down**. The one criterion that can be
satisfied from geometry alone, without prose — `compactEnclosure`, computed from the plan span —
points the *other* way.

---

## 3. Why the crude comparison cannot be believed

`fortConfidence` and the interior measure are both text-mining rules over the same `beskrivning`.
A fort with 2 000 characters of description has more room to say *kallmurad* and more room to say
*husgrund*, with no archaeology involved. The confound is not hypothetical — it is large:

- **Spearman(description length, confidence) = 0.48.**
- Mean description length: **953 characters** above the threshold vs **618** below.
- Mean description length: **1 230** characters for a refined positive vs **708** for a negative.
- 213 forts under 200 characters; **none of them reach the threshold**, and by construction almost
  none can produce a keyword hit either. The survey already flagged these as a genuine lower
  bound (its §1); they are also the bulk of the low-confidence denominator.

The regional pattern says the same thing in a different voice. If the score measured
fortification we would expect it to track the archaeology; instead it tracks who wrote the
county's survey:

| Region | n | ≥ 0.60 | mean chars | refined |
|---|---:|---:|---:|---:|
| Västmanland | 58 | **75.9 %** | 957 | 1 |
| Kalmar (mainland) | 62 | 58.1 % | 888 | 4 |
| Örebro | 34 | 50.0 % | 898 | 1 |
| Östergötland | 150 | 40.0 % | 937 | 6 |
| Södermanland | 242 | 37.6 % | 747 | 8 |
| Stockholm | 240 | 31.7 % | 704 | 12 |
| **Uppsala** | 79 | **26.6 %** | 667 | **0** |
| Öland | 21 | 23.8 % | 1 035 | 5 |
| Gotland | 85 | 21.2 % | 776 | 8 |
| Västra Götaland | 223 | **14.3 %** | **429** | 3 |
| Halland | 29 | **3.4 %** | 754 | 0 |

Västmanland at 75.9 % against Halland at 3.4 % is not a fact about Migration Period fortification
in Sweden. Västra Götaland's 14.3 % is the direct shadow of its 429-character mean description —
the same thinness the survey identified as the reason its interior rate is a lower bound. And
Uppsala — the county the Mälardalen criteria were *derived from* — passes 26.6 %, below the
national average, with zero refined positives among its 79 forts.

### The controlled comparison

Splitting the 1 304 into description-length quartiles and comparing within each:

| Band | chars | n | ≥ 0.60 | refined, high | refined, low | OR |
|---:|---|---:|---:|---:|---:|---:|
| 0 | 0–399 | 326 | 7.7 % | 0.0 % (n = 25) | 0.3 % (n = 301) | 3.93 |
| 1 | 401–679 | 325 | 30.8 % | 2.0 % (n = 100) | 2.2 % (n = 225) | 0.90 |
| 2 | 680–976 | 327 | 41.3 % | 3.0 % (n = 135) | 4.7 % (n = 192) | 0.62 |
| 3 | 977–5 318 | 326 | 53.1 % | **11.6 %** (n = 173) | **8.5 %** (n = 153) | 1.41 |

The within-band odds ratios scatter around 1 and change sign — two above, two below. Pooling them
properly:

| Measure | MH OR, 4 bands | *p* | MH OR, 10 bands | *p* |
|---|---:|---:|---:|---:|
| broad | 0.77 | 0.202 | 0.77 | 0.198 |
| **refined** | **1.08** | **0.910** | **1.11** | 0.828 |
| strongConfident | 0.82 | 0.779 | 0.84 | 0.831 |

**The entire crude association (OR 1.92, p = 0.026) is description length.** Controlled for it,
the working measure gives OR 1.08 with p = 0.91 — as close to no association as this dataset can
express. The broad measure even points mildly the wrong way.

Note also what band 3 shows on its own: among the 326 best-described forts, high-confidence forts
carry refined evidence at 11.6 % and low-confidence ones at 8.5 %. That gap is not significant,
and both figures are far above the national 4.1 % — which is a statement about **description
quality**, not about fortification.

### Sensitivity runs

All three reproduce the null.

1. **`compactEnclosure` judged on the measured KMR extent span** instead of the span parsed out of
   the description (420 forts above threshold rather than 433): crude refined OR 2.02, p = 0.016 —
   the same crude signal, the same confound.
2. **A deliberately over-wide drystone rule** (`kallmur` as a bare substring; 275 → 338 forts pass
   the criterion, 433 → 458 above threshold), to bound how much the strictness of the word list
   could be hiding: crude refined OR 2.22, p = 0.005, but **MH OR 1.21, p = 0.63**. Widening the
   rule widens the crude signal and leaves the controlled one at nothing — which is the signature
   of a text-volume artefact, not of a suppressed real effect.
3. **Ten strata instead of four**: MH OR 1.11, p = 0.83.

---

## 4. Against the Mälardalen prediction

The survey's §5 reasoning was: ~17–21 % of genuinely fortified Middle Iron Age forts carry
interior buildings; those are ~17 % of the register; 0.17 × 0.19 ≈ 3 %, and we measured 4.1 %
nationally. If `fortConfidence` were selecting that Middle Iron Age population, the
high-confidence refined rate should land near **17–21 %**.

| | |
|---|---:|
| Predicted high-confidence refined rate | 17–21 % |
| **Observed** | **6.0 %** |
| Refined positives inside the high-confidence subset | 26 of 54 (48.1 %) |
| Share of all forts in that subset | 33.2 % |

Two failures at once. The rate is a third of the prediction, and the subset is nearly twice as
large as the Mälardalen population it is supposed to stand in for (33.2 % against ~17 %). The
positives are split almost exactly in half by a threshold that cuts the register in thirds —
26 above, 28 below — which is very close to what you would get by drawing at random.

The honest reading is that `fortConfidence` is doing the job §6.A.1 gives it — refusing to draw
1 304 standing Migration Period ramparts on the strength of a register label — while being far too
coarse, and far too entangled with survey prose volume, to serve as a *proxy for the Middle Iron
Age subset* in a second, unrelated inference. It was never specified to do the second job.

---

## 5. What this means for the interior default

**The survey's recommendation is unchanged, and the case for it is now stronger.**

A confidence-dependent default would mean: draw `settlement` inside the 433 forts that score
≥ 0.60. **374 of those 433 (86 %) carry no interior evidence at all** — not even the survey's
discredited upper-bound keyword rule. That is archetype-H inference applied 374 times over, on
the strength of an association that vanishes under its only control. It is precisely the move the
governing principle forbids: the app would look more inhabited by asserting something the record
does not support.

Gating the *per-fort* `settlement` offer on confidence would be worse in a different direction: it
would withhold the state from **28 of the 54 forts whose own KMR text names their buildings**,
including **8 of the 13** Öland and Gotland limestone-ringfort positives the survey singles out as
its strongest per-fort evidence (only 5 of the 13 reach the threshold). The evidence for those 28 is
a citable sentence in the register; the reason to hide it would be a score that this analysis
shows is uncorrelated with that evidence.

So, concretely — no change to what the survey already recommended:

- Default interior state **`cleared`** for every fort, at every confidence level.
- **`settlement`** offered per fort where `refinedInteriorEvidence` is true (54 forts), with the
  matched KMR sentence cited in the methods panel. Confidence does not enter.
- `fortConfidence` keeps doing exactly what §6.A.1 gives it — gating the *rampart* geometry — and
  is not extended to the interior.
- Keep the §7.5 two-state selector for Broborg as specified.

One thing this analysis does suggest, and which costs nothing: where a fort is drawn as
high-confidence with a rich description and still has no interior evidence, that is a genuine
measured absence rather than a thin record, and the methods panel could say so. The 374 forts
above are the set where "the register looked and recorded nothing inside" is an honest sentence.

---

## 6. What would change this conclusion

Not more statistics on this data — the join is at the limit of what 54 positives can support, and
the controlled estimate is not merely non-significant but centred on 1.00.

What would change it is a **confidence measure that is not mined from the same prose**: rampart
morphology read off the LiDAR DEM rather than off the `beskrivning`. The pipeline already has the
terrain. A DEM-derived wall height and closure test would be independent of how much the surveyor
wrote, and re-running this exact join against it would be a real test rather than a repeat of this
one. That is a larger piece of work than a join, and nothing in the present result makes it
urgent.

---

## 7. Noticed on the way — out of scope here, but recorded

Neither affects the verdict (sensitivity run 2 in §3 bounds the first, and the second is a
property of the source data), but both are real and both cost real forts real score.

1. **`_DRYSTONE` misses `kallmurade`.** The pattern
   (`reconstruct.py:380`) lists `kallmurning`, `kallmurad`, `kallmur`, `kallmurar`, `kallmurat`
   — and `word_pattern` matches whole words only, so the common definite/plural adjective
   **`kallmurade`** does not match. It occurs in 41 fort descriptions, plus `kallmursteknik` and
   `kallmurningen` in a handful more. **63 forts contain `kallmur*` in their text but fail the
   criterion**, and **52 of them would cross the 0.60 threshold if they passed it** — the
   high-confidence subset would go from 433 to 485 (+12 %). Since the criterion is worth 0.40 of
   1.00, this is the single largest correctable error in the score.
2. **Some KMR descriptions have lost their hard line breaks without gaining a space**, gluing
   words together: `…intill 2 m h ikallmur`, `belägenpå`, `denkallmurade`, `kallmuradestenvallar`.
   1 034 of the 1 304 descriptions carry no `\n` at all while plainly having been hard-wrapped.
   A minority of the 63 `kallmur*` misses above are this rather than inflection, and the same
   failure mode will silently cost `ringvall`/`ringmur` (57 word matches against 63 substring
   matches) and every other `word_pattern` rule in the parser, including the interior survey's own
   keyword tiers. A normalisation step that re-inserts a space at a lower-case/lower-case boundary
   inside an unknown token would be delicate to get right and should be measured before being
   trusted — but the current behaviour is an undercount, not a neutral one.

---

## 8. Reproducing

```sh
cd pipeline/spike
python3 confidence_join.py            # reads ../../docs/interior-survey-2026-08-30.json
                                      # writes ../../docs/confidence-join-2026-09-12.json
```

Standard library plus `fornborg_pipeline` only; no network, no GDAL, ~1 s. The JSON carries one
row per fort — slug, region, description length, shipped `confidence` and its four criteria, both
sensitivity variants of the score, and the survey's evidence flags — so any cross-tabulation here
can be re-cut without re-running the parser.
