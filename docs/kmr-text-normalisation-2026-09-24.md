# The register's lost punctuation, and what it is safe to put back

> **Measurement and a decision.** The measurement is of the KMR free text as this project
> receives it; the decision is what `pipeline/fornborg_pipeline/reconstruct.py` does about it.
> Unlike `docs/interior-survey-2026-08-30.md` this one *is* implemented — `normalise()` now
> repairs one named class of damage and refuses the rest, and the shipped
> `reconstruction.json` counts every repair it made. Read `reconstruction-mode.md` §3 and §6.A.1
> for the rules affected, and §9 for why an unrecorded edit to a source would be a regression
> however much it improved the numbers.

Measured **2026-09-24** over all **1 304** registered `Fornborg` descriptions in
`docs/interior-survey-2026-08-30.json` — 1 303 non-empty, **950 820 characters**. That file is a
frozen artefact and is *not* amended here; it is used as the corpus because it carries every
fort's full `beskrivning`, which is exactly the input the live path (`sites.json` →
`reconstruct.normalise`) sees.

---

## 1. The finding, in one line

KMR's descriptions were hard-wrapped at about 64 characters and then had their line breaks
removed **without a space put in their place**, so every wrap point glued two words together.
There are of the order of **14 800** such joins in the corpus. **616 of them can be put back
without guessing. The other ~14 200 cannot, and this document is mostly about why.**

---

## 2. Characterisation

### 2.1 Every description in the corpus is damaged

| | Forts |
|---|---:|
| Registered `Fornborg` records | 1 304 |
| With a `beskrivning` | 1 303 |
| Carrying **no** `\n` at all | 1 034 |
| Carrying at least one `\n` | 270 |
| …of those, any whose longest line is ≤ 75 characters | **0** |

The 270 survivors are not counter-examples. Their shortest maximum line is over 150 characters
and the longest is 2 702: every surviving `\n` is a **paragraph** mark, and the text *inside*
each paragraph is glued exactly like the rest. **There is no uncorrupted reference text anywhere
in the register**, which matters later: a re-segmentation rule cannot be validated against
ground truth, because the corpus contains none.

### 2.2 The wrap width was about 64 characters

Taking every *detectable* join — a full stop running straight into a capital, or a lower-case
letter running straight into a capital — and histogramming the distance between consecutive ones
inside the same description (778 joins, 277 gaps under 200 characters):

| Commonest short gaps | 64 | 60 | 63 | 58 | 62 | 59 | … | 123 | 182 | 183 | 190 |
|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|
| occurrences | 14 | 8 | 8 | 5 | 4 | 4 | | 5 | 4 | 4 | 4 |

A single mode at 64 with a shoulder down to 58, a second cluster near 2 × 62 and a third near
3 × 61. Worked through on one record — `l1935:1375`, 1 039 characters, whose joins can be located
by hand end to end (`belägenpå`, `NVoch`, `och0,4`, `ärvinkelbruten`, `raserad.Murrester`,
`äruppdelad`, `ikallmur`, `ochNÖ`, `ca1 m`, `attEkdahls`, `kanavse`) — the joins fall at
characters 64, 126, 248, 302, 367, 428, 493, 557, 621, 682 and 746: spacings of 62, 122 (= two
lines), 54, 65, 61, 65, 64, 64, 61, 64.

950 820 characters ÷ 64 ⇒ **≈ 14 800 lost joins**.

### 2.3 Four classes, only one of them placeable

| Class | Example | Count | Position known? |
|---|---|---:|---|
| **A** sentence end run into the next capital | `raserad.Murrester`, `2 m h.Inne` | **616** in 293 descriptions | **yes, exactly** |
| **B** mid-token capital | `ochNÖ`, `skedeII`, `attEkdahls` | 162 | yes, exactly |
| **C** lower-case into lower-case | `belägenpå`, `denkallmurade`, `kallmuradestenvallar` | ≈ 14 000 | **no** |
| **D** hyphenated wrap | `klipp- kant` | a handful | yes, but the hyphen is part of the word |

Class A is 4 % of the damage and class C is 95 % of it.

### 2.4 Why class C cannot be repaired: Swedish compounding

The obvious repair for class C is a lexicon: split a token when both halves are frequent words
and the token itself is not. **Swedish defeats it, because Swedish compounds are built out of
exactly the same frequent words.** In this corpus `stenvall` occurs 331 times, `ringvall` 46,
`stensträng` 41, `husgrund` 27, `hällmark` 16 — and `sten`, `vall`, `ring`, `sträng`, `hus`,
`grund`, `häll`, `mark` are all common standalone tokens. Protecting a compound by its own
frequency works for those five and fails for every compound the surveyor wrote once.

This was not left as an intuition. A prototype was built and measured:

* lexicon from the corpus itself — 9 033 distinct letter-tokens over 161 196 occurrences;
* rule — split a token that occurs at most twice, at the unique point where both fragments occur
  at least 30 times;
* result — **1 304 candidate splits**, i.e. **8.8 % of the estimated 14 800 joins**.

Its accuracy, measured twice:

* **Recall.** Against the 30 glued technical tokens this phase actually cares about
  (`ikallmur`, `denkallmurade`, `inomringvallen`, …) it produced a unique correct split for 22
  and missed 8 — **73 %**, on the vocabulary chosen to favour it.
* **Precision.** 149 of the 1 304 split off a single letter (`bergklack`+`s`, `felaktig`+`t`,
  `begränsning`+`e`, `utgör`+`d`) — a systematic error class, because the register's bare compass
  letters make `s`, `n`, `v` and `ö` frequent "words". Of the remaining 1 155, a hand audit of a
  random 40 found **8 genuine Swedish compounds that would have been destroyed** — `överdelen`,
  `högplatå`, `vallparti`, `stupkant`, `muröppningen`, `längdriktning`, `krönvallen`,
  `morändelen` — i.e. **≈ 20 %** (95 % CI roughly 9–36 %).

**Nine per cent of the damage repaired, one in five of the repairs a fabrication, and no clean
text in the corpus to check against.** That is not a repair; it is a rewrite with a plausible
error rate. Class C is left exactly as the register sent it.

---

## 3. What was repaired, and where

**In `normalise()`, once, on ingest** — so no downstream rule needs its own workaround:

```python
SENTENCE_JOIN_RE = re.compile(rf"(?<=[.!?])(?=[A-ZÅÄÖ][a-zåäö][{LETTER}]*)")
```

A sentence-ending mark immediately followed by a capital that opens a lower-case word gains a
space. **No Swedish word straddles a full stop**, so the position is not inferred and the rule
cannot split a compound — the property class C lacks. The lower-case second letter is the guard
that leaves the register's own `Ö20gr.S-V20gr.N` orientation strings and its `0,5 m st.N om
vallen` abbreviations alone; 19 dot-plus-bare-bearing sequences in the corpus are skipped by it.

**Recorded, and reversible.** Each repair is one inserted space. Every `reconstruction.json` the
parser writes now carries `coverage.recordsTextRepaired` and `coverage.sentenceJoinsRepaired`, and
`derivation.description` states the rule and says outright that mid-sentence glue is left
untouched. Deleting the counted spaces reproduces the register's bytes.

**Class B is not repaired.** It is placeable, but it buys nothing measurable — no rule in the
module keys on a capitalised word — and every edit to a source has to earn itself.

---

## 4. The other half: two stems that were never a punctuation problem

The brief that opened this phase attributed `_DRYSTONE`'s 63-fort gap to the lost line breaks.
**It is mostly not that.** 338 descriptions contain `kallmur*` and the five-inflection word list
(`kallmurning|kallmurad|kallmur|kallmurar|kallmurat`) fired on 275. Splitting the 63:

| Cause | Forts |
|---|---:|
| Plain inflection the word list did not carry — `kallmurade` (53 descriptions), `kallmurningen`, `kallmuren`, `kallmurarna`, `kallmuring`, `kallmursteknik` | **44** |
| A form with letters **in front of** the stem — the one unambiguous signature of a lost line break, since no Swedish word puts letters there (`ikallmur`, `denkallmurade`, `kvartstårkallmurning`) | **11** |
| Extra letters **after** the stem, where a lost break and a genuine compound look identical (`kallmuratparti`, `kallmuradestenvallar`) | **8** |

Morphology was the majority; the corruption was the minority. `ringvall|ringmur` splits the same
way: 63 descriptions, 57 matched, the rest genitives and plurals (`ringvallens`, `ringmurar`,
`ringvallarna`) plus four glued forms.

One rule closes both causes at once, and it is *not* a text repair — it is a matching rule.
`stem_pattern()` is `word_pattern()`'s counterpart for a stem **no unrelated Swedish word
contains**:

```python
_DRYSTONE = stem_pattern("kallmur")
_RING = stem_pattern("ringvall", "ringmur")
```

That is a claim about the language, so it is checked rather than asserted:
`test_the_glue_tolerant_stems_admit_nothing_but_their_own_word` enumerates **every** surface form
the two patterns admit across all 1 304 descriptions — 39 and 14 of them — and every one is the
register talking about dry-stone walling or about a ring wall. A stem that starts admitting
something else fails there. `hög` or `vall` could never be passed to it; `husgrund` deliberately
is not (see §7).

---

## 5. What moved

### 5.1 Coverage of the two widened criteria

| | Before | After |
|---|---:|---:|
| Descriptions matching `kallmur*` by substring | 338 | 338 |
| …that `_DRYSTONE` fires on | **275** | **338** |
| Descriptions matching `ringvall\|ringmur` by substring | 63 | 63 |
| …that `_RING` fires on | **57** | **63** |

Both gaps are **closed**, not bounded.

### 5.2 `fortConfidence` (§6.A.1)

| | Before | After |
|---|---:|---:|
| Forts at or above the 0.60 threshold | **433** (33.2 %) | **458** (35.1 %) |

Of the 63 forts recovered by the drystone stem, 27 were already above the threshold on the other
three criteria, **25 cross it**, and 11 stay below. This is the one number here a visitor can
see: at or above 0.60 a registered `Fornborg` renders as a standing Migration Period rampart,
below it as a low bank. 25 forts change how they are drawn, each because its own record says
`kallmurade` and the old rule could not read the word.

### 5.3 Rampart detail — the sentence repair pays for itself and costs a little

Replaying all 1 304 records through `build_monument`, attributable to the class-A repair alone:

| | Before | After | Δ |
|---|---:|---:|---:|
| Entrance bearings attributed to a wall | 1 355 | 1 243 | **−112** |
| Ramparts with a parsed present height | 1 021 | 1 018 | −3 |
| Ramparts with a parsed length | 889 | 887 | −2 |

**The −112 is the point of the repair.** Without the space, §3's clause splitter runs a sentence
into the next and the entrance parser reads the *following* sentence's compass bearing as an
entrance on this sentence's wall. Sampled by hand, the dropped bearings are things like
`l1958-5850`'s *"…ett kallmurat parti i fem skift.Ingången är i Ö"* — where `N`, belonging to the
masonry patch, was being drawn as a second gateway — and `l1958-6759`'s *"…en 2,5 m br
öppning.Omedelbart intill och S om nr 1 är: 6) …"*, where `S` describes where a **neighbouring
monument** lies. Those are invented features in the project's own terms, and there were 112 of
them.

**The −5 is the price, and it is honest about a different weakness.** `parse_fort` gives each
named wall the clauses from its own name to the next wall's. When two wall names fall in one
clause (`l2004-6478`: *"en inre vall,en yttre något osäker vall"*) the first wall's scope is
empty, so a dimension stated in the *following* sentence is now out of reach where under-splitting
used to sweep it in. That fort drops 1.00 → 0.70. **The corruption was silently compensating for
a narrow scope in the parser**, and removing it makes the weakness visible. Widening wall scope is
a §3 change, not a §10 one, and is left as a named follow-up.

### 5.4 The interior gate: nothing moved

All six pinned numbers in `test_the_national_gate_rates_are_pinned` are **unchanged**: 1 304
forts, 42 channel-1, 18 channel-2, 7 overlap, 53 union, 4.1 %, 13 hedged-only. So is
`test_a_glued_strong_term_is_a_known_gap_and_costs_no_fort`: the strong-tier glue hole is still
exactly `{l1975-712, l1983-1710}` and still costs zero forts. Its docstring is updated to say that
this was re-measured after normalisation rather than assumed, and to record why the strong tier
did **not** get `stem_pattern` (§7).

Consequently **`docs/interior-survey-2026-08-30.md` would not read differently if it were
re-measured today**, and it is not retro-edited.

### 5.5 The committed Broborg bundle — one open step

A fresh parse of `app/public/data/broborg/sites.json` repairs 26 joins across 25 of its 127
records. Against the committed `reconstruction.json` it differs in exactly four places: the two
new `coverage` counters, the `derivation.description` sentence, and one substantive number.
`L1943:7229`'s rectangular stone-setting class moves from
`stoneM 0.1–0.3` to `0.2–0.4`. The register states that calibre in the sentence *after* the one
naming the class, and the glue was joining the two. The value it falls back to is the one the
**round** class in the *same record* already took from the same rule, where the register's space
happened to survive — so the change makes the record self-consistent, at the cost of one number
that was right by accident. Same follow-up as §5.3.

**The committed file is not regenerated in this branch**, because `app/` is out of this phase's
scope. `test_the_committed_file_matches_a_fresh_parse` therefore fails, which is exactly what that
test is for — it exists so that a parser change that was never re-run shows up here rather than as
a stale scene. One command closes it:

```
cd pipeline && python3 -m fornborg_pipeline.reconstruct --site broborg
```

No rampart, mound, cairn or interior geometry is touched by that regeneration, so it does not
need the app's checker run; the diff is the four items listed above.

---

## 6. Does §7 of the confidence join survive?

`docs/confidence-join-2026-09-12.md` §7 concluded that interior-building evidence does **not**
track `fortConfidence` once description length is controlled for: Mantel–Haenszel OR 1.08,
p = 0.91. Re-running `pipeline/spike/confidence_join.py` unchanged against the new rule:

| Measure (refined) | 2026-09-12 | 2026-09-24 |
|---|---|---|
| Crude | OR 1.92, p 0.026 | OR 2.22, p 0.005 |
| **MH pooled over length bands** | **OR 1.079, χ² 0.013, p 0.910** | **OR 1.207, χ² 0.239, p 0.625** |
| MH pooled over length deciles | OR 1.113, p 0.828 | OR 1.236, p 0.569 |
| Spearman(chars, confidence) | 0.481 | 0.500 |

**The null result survives.** The crude association strengthened and the stratified one did not,
which is the confound §7 named — a longer description has more room to say `kallmurade` *and* more
room to say `husgrund` — showing up more clearly now that the drystone criterion reads the longer
descriptions properly. Nothing in §7's verdict is reopened.

`confidence_join.py`'s drystone sensitivity block is **inverted rather than deleted**: it now
scores the five-form word list as the counterfactual, so the dated doc's own numbers (275, 433,
MH OR 1.079, p 0.910) remain reproducible from live code, printed beside the shipped ones.

---

## 7. What was deliberately not repaired

1. **Class C glue — ~14 000 joins.** §2.4. Nine per cent recall at a hand-audited ~20 % rate of
   destroyed compounds, with no clean text in the corpus to validate against.
2. **Class B — 162 mid-token capitals.** Placeable, but no rule keys on capitalisation, so the
   edit would buy nothing and an unearned edit to a source is not free.
3. **Class D — hyphenated wraps.** Rejoining `klipp- kant` means deciding whether the hyphen was
   the wrap's or the word's, which is class C's problem with an extra character.
4. **`stem_pattern` for the six strong interior terms.** The glue hole there is two occurrences
   nationally and costs **zero** forts, so there is nothing to win; and unlike `kallmur` the terms
   are ordinary words in compound (`hus`+`grund`), so dropping the left boundary would start
   admitting compounds whose head is not a house. Measured, then declined.
5. **Eketorp's house dimensions** — §8.
6. **Wall scope in `parse_fort` and class scope in `parse_grave_field`** (§5.3, §5.5). Real
   weaknesses, newly visible, but a §3 change rather than a text-normalisation one.

---

## 8. Eketorp: the dimensions still do not parse, and the corruption is not why

`l1958-4198` states its houses' size two sentences after it counts them:

> …De är orienterade radiellt liksom flertalet av de 53 från skedeII, av vilka nu kan ses 17 av
> totalt 37 grunder närmast innanförden inre nutida vallen och 7 på borggårdens mitt. **De förra
> är ca 11x4-5 m**, medan de från skede I är ca 7x5-6 m.

The record *is* glued (`skedeII`, `innanförden`, `lämningarnadärav`, `begränsning.De`), and
`begränsning.De` is now repaired. It changes nothing, because neither blocker is punctuation:

1. **Sentence scope.** `interior_buildings` reads dimensions only from the sentences the fort
   passed the gate on. Eketorp passes on exactly one — *"Av de under 1960- och 1970-talens
   utgrävningar framkomna ca 75 husgrunderna…"* — four sentences earlier. The size sentence
   carries no strong-tier term and never will; *"De förra"* is a pronoun.
2. **`_RECT` cannot read a ranged second dimension.** It wants `({NUM})\s*[x×]\s*({NUM})\s*m`, and
   the register wrote `11x4-5 m`. It does not match, and would not even if the sentence were in
   scope.

So Eketorp's 75 houses keep §6.H's 20–40 m literature default with `buildings.template.lengthM`
and `buildings.template.widthM` both named in `fallbacks` — which is the honest outcome, not a
silent one, and is what §7.5.1 prescribes for a record that states a count but no size. Both
blockers are pinned in `test_eketorps_stated_house_size_still_does_not_parse` so that whoever
widens either rule knows this is the case to check. Widening them is a real change to what the
app asserts about the best-preserved fort interior in the country and deserves its own argument,
not a side-effect of a punctuation fix.

---

## 9. Pinned numbers changed by this phase

| Number | Was | Is | Why |
|---|---:|---:|---|
| `_DRYSTONE` coverage | 275 / 338 | **338 / 338** | stem replaces a five-inflection word list |
| `_RING` coverage | 57 / 63 | **63 / 63** | same |
| `fortConfidence` ≥ 0.60 | 433 (33.2 %) | **458 (35.1 %)** | 25 forts cross on the drystone criterion |
| Entrance bearings on walls | 1 355 | **1 243** | 112 read out of the following sentence |
| Rampart heights / lengths parsed | 1 021 / 889 | **1 018 / 887** | wall scope, exposed by correct splitting |
| MH refined OR (length-stratified) | 1.079, p 0.910 | **1.207, p 0.625** | still null |
| Broborg `L1943:7229` class 2 `stoneM` | 0.1–0.3 | **0.2–0.4** | §5.5 |
| Interior gate: 1304 / 42 / 18 / 7 / 53 / 4.1 % / 13 | — | **unchanged** | the gate reads none of the changed rules |
| Strong-tier glue hole | `{l1975-712, l1983-1710}`, 0 forts | **unchanged** | re-measured, not assumed |
