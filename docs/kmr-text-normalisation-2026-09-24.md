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
without guessing. The other ~14 200 cannot, and §2.4 is the measurement that says so.**

Putting those 616 back is not free either: three rules in this module were reading a
measurement out of a clause they only happened to share with it, and correct sentence
boundaries strand the measurement and substitute an archetype default. §3.2 repairs those
scopes, and §10 records how nearly that went unnoticed.

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

### 3.1 The one placeable class, in `normalise()`, once on ingest

```python
SENTENCE_JOIN_RE = re.compile(rf"(?<=[.!?])(?=[A-ZÅÄÖ][a-zåäö][{LETTER}]*)")
```

A sentence-ending mark immediately followed by a capital that opens a lower-case word gains a
space. **No Swedish word straddles a full stop**, so the position is not inferred and the rule
cannot split a compound — the property class C lacks. The lower-case second letter is the guard
that leaves the register's own `Ö20gr.S-V20gr.N` orientation strings and its `0,5 m st.N om
vallen` abbreviations alone; 19 dot-plus-bare-bearing sequences in the corpus are skipped by it.

Putting it in `normalise()` rather than in each rule means every rule benefits and no rule needs
its own workaround, which was the point.

**Recorded, and reversible.** Each repair is one inserted space. Every `reconstruction.json` the
parser writes now carries `coverage.recordsTextRepaired` and `coverage.sentenceJoinsRepaired`, and
`derivation.description` states the rule and says outright that mid-sentence glue is left
untouched. Deleting the counted spaces reproduces the register's bytes.

**Class B is not repaired.** It is placeable, but it buys nothing measurable — no rule in the
module keys on a capitalised word — and every edit to a source has to earn itself.

### 3.2 Two scopes the repair exposed, and why they could not be left

Correct sentence boundaries are not free. Three rules in this module read a measurement out of
"the clause that names X", and the register's habit is to name X in one sentence and measure it in
the next. While the full stop was missing, those two sentences were one clause and the rules
worked by accident. Separating them **replaces a stated measurement with an archetype default**,
which is worse than losing it, because the default ships under the same `measured` badge.

Both were found by re-reading the committed Broborg bundle line by line rather than by trusting
the aggregate, and both are fixed here rather than deferred:

1. **A wall is anchored on the clause that *describes* it, not the first that names it.**
   `l2004-6478` writes *"Vallarna består av en inre vall,en yttre något osäker vall, samt två
   tvärvallar."* and then *"Den inre vallen är ca 320 m l, 0.5-5 m br och 0.5-1.5 m h."* The first
   sentence names both walls and measures neither. `parse_fort` now takes the first clause that
   names the wall **and** states a length, width or height, falling back to the first mention; and
   a wall always owns at least its own clause, where two walls named in one sentence used to leave
   the first with an empty scope.

2. **A stone calibre is taken from the sentence the register states it in.** *"Den inre vallen är
   ca 320 m l, 0.5-5 m br och 0.5-1.5 m h."* / *"Stenarna är 0.1-2.5 m st."*; *"De rektangulära
   stensättningarna är 4-6x3 m (Ö 10cg S-V 10cg N och NV-SÖ)."* / *"Övertorvade med i ytan enstaka
   synliga stenar, 0,1-0,3 m st."* `continuation_calibre_clause` (walls) and
   `continuation_calibre` (grave-field classes) take **only the calibre**, **only** from the
   immediately following clause, and only when that clause states a calibre, names no wall or
   constituent class of its own, and states no length, width, height or plan size. A kerb's
   *"Kantkedja, 0,2-0,3 m h"* is therefore not a continuation, and the next class's sentence can
   never be read as this one's tail.

Audited over all 62 grave-field classes in the committed Broborg bundle: **every** class's calibre
now comes from the clause immediately after the one its plan size came from — **zero mismatches**.
That audit was not enough, and the first version of this section went wrong here. It said that where
several classes share a size sentence they share its continuation too, "which is the behaviour the
plan size already had". But that shared sentence was never theirs. `size_clause` fell back to *"De
runda stensättningarna är …"* for any class whose own sentence scored lower. That happened when the
modifier was inflected differently (`1 rektangulär` / `Den rektangulära`), when the class's sentence
had no `är` (`Den trekantiga … har 4 m i sida`), or when a typo hid the class noun
(`stensättningarana`). Ten classes in the bundle carried the round class's diameter. §3.2 would have
copied the round class's calibre onto them too, under `measured`. Two of those ten were already
showing their register value, which is also the archetype default, and §3.2 would have replaced it:
`L1941:9481`'s triangular setting and `L1943:7830`'s rectangular one.

**§3.3, the fix at the source.** `size_clause` now matches a class's own form in any inflection. It
never takes a sentence that names a different form without naming its own. For a class that has a
form, that means any other form, because a sibling may have been counted without one
(*"1 kvadratiskfylld stensättning"*). For a class that has none, it means its siblings' forms, so
*"Stensättningarna är runda"* still sizes a single-class field. When no sentence is admissible, the
class has no stated size. It takes the archetype default and is badged `assumed`, which the visitor
sees, instead of a neighbour's figures badged `measured`. The tests are
`test_a_class_never_takes_a_sibling_forms_sentence`,
`test_a_formed_class_refuses_a_form_counted_without_one` and
`test_an_unformed_class_still_reads_a_sentence_that_names_its_shape`. The first two fail on the
parser before §3.3.

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
| Forts at or above the 0.60 threshold | **433** (33.2 %) | **459** (35.2 %) |

24 of the 26 come from the drystone stem — of the 63 forts it recovers, 28 were already above the
threshold on the other three criteria, 24 cross it and 11 stay below — and 2 from the wall-scope
repair of §3.2, where a wall now reads its own height. This is the one number here a visitor can
see: at or above 0.60 a registered `Fornborg` renders as a standing Migration Period rampart,
below it as a low bank.

`confidence_join.py`'s word-list counterfactual prints **435 → 459**, not 433 → 459, because its
comparison arm is scored on *this* parser, scope repairs included. 433 is the pre-phase figure.

### 5.3 Rampart detail — the national parse gains measurements, and loses two false ones

Replaying all 1 304 records through `build_monument`, against the pre-phase parser (`3f8744b`):

| | Before | After | Δ |
|---|---:|---:|---:|
| Ramparts with a parsed present height | 1 021 | **1 039** | **+18** |
| …with a parsed length | 889 | **902** | **+13** |
| …with a parsed stone calibre | 913 | **949** | **+36** |
| Walls whose `source` reads `measured` | 979 | **994** | **+15** |
| Entrance bearings attributed to a wall | 1 355 | **1 235** | **−120** |

**The −120 is the point of the sentence repair.** Without the space, §3's clause splitter runs a
sentence into the next and the entrance parser reads the *following* sentence's compass bearing as
an entrance on this sentence's wall. Sampled by hand, the dropped bearings are things like
`l1958-5850`'s *"…ett kallmurat parti i fem skift.Ingången är i Ö"* — where `N`, belonging to the
masonry patch, was being drawn as a second gateway — and `l1958-6759`'s *"…en 2,5 m br
öppning.Omedelbart intill och S om nr 1 är: 6) …"*, where `S` describes where a **neighbouring
monument** lies. Those are invented features in the project's own terms, and there were 120.

**Every value that changed rather than appeared was checked by hand against the register's own
words.** Across all 1 304 forts, exactly four walls differ in a way that is not a gain:

| Fort / wall | Change | Verdict |
|---|---|---|
| `l1985-6761` outer | 35 m, 1–4 m br, 0.3–0.6 m h, 0.2–0.5 m st → none; `measured` → `assumed` | **correction.** Those are the *inner* wall's numbers. *"Det yttre muren ligger nedanför berget"* and *"Den inre muren … är ca 35 m l …"* were one clause, so both walls were drawn on the inner wall's measurement. The outer now says it has none. |
| `l2004-6478` outer | 1.0–1.5 m h, 2 m br, 0.8–2 m st → none; `measured` → `assumed` | **correction.** Those came from the *tvärmur*'s sentence, merged into the outer wall's clause. Its stated length (15–20 m) is kept. |
| `l2015-9211` outer | 50 m → 90 m, 0.3–0.5 → 0.2–0.4 m h, 1.5–3 → 1–2 m br | **correction.** The record describes two outer walls; the old values came from *"En yttre mur i N…"*, the new ones from *"Den yttre muren i Ö … är ca 90 m l …"* — the sentence that names the wall. |
| `l1984-1190` outer | 0.3–0.3 → 0.3–0.7 m st | **correction.** The old value came from *"Vallen är av ca 0.3 m st stenar"*, the **inner** wall's calibre; the outer's own sentence says *"av 0.3-0.7 m st stenar"*. |

**No value goes from right to wrong.** The two walls that lose their measurements lose them
because they never had any of their own, and they say so — `presentHeightM: null`, `source:
assumed` — instead of being drawn on a neighbour's numbers.

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
records. Against the committed `reconstruction.json` it differs in three places:

* `coverage.recordsTextRepaired` and `coverage.sentenceJoinsRepaired`, new;
* the `derivation.description` sentence naming the repair;
* **34 grave-field classes** in 18 records. Each was checked by hand against its own register
  sentence:
  * **24 classes** move a calibre off an archetype default to the one the record states for that
    class, one clause after its plan size (§3.2). *"De runda stensättningarna är 4-6 m diam och
    0,2-0,4 m h."* / *"Övertorvade med i ytan enstaka synliga stenar, 0,2-0,3 m st."* Two of
    the 24 (`L1943:7532`, `L1943:7830`) are "counted in the record's total but not itemised"
    remainders. They carry that note and copy their record's largest class.
  * **4 classes** stop borrowing the round class's sentence and take their own stated size (§3.3).
    These are `L1941:5542` rectangular 9x5 m and 0,2 m h, `L1941:9481` square 4x4 m and 0,2 m h,
    `L1941:9481` rectangular 8x6 m and 0,3 m h, and `L1943:7247` rectangular 12x10 m and 0,3 m h.
  * **5 classes** stop borrowing, have no sentence the parser can size, and are now badged
    `assumed` on archetype defaults. The reasons are a sentence with no `är` (`L1941:5542` and
    `L1941:9481` triangular), a typo (`L1943:6937` *stensättningarana*), a ship setting stated by
    length and breadth (`L1943:7532`) and a glue (`L1943:7830` *4x4 moch*). Where the register
    states their height or calibre, it is still read: `L1943:7532` 0,25 m h and 0,3-0,8 m st,
    `L1943:7830` 0,1 m h and 0,1-0,2 m st.
  * **1 class**, `L1943:7035`'s round settings, was already `assumed` because of the typo *äf*. It
    stops borrowing the rectangular class's height.
* five `parseConfidence` values, which fall by 0.04–0.10 because of the five `assumed` classes.

No rampart, mound, cairn or interior geometry changes, so the regeneration does not need the app's
checker run.

Regenerated with `cd pipeline && python3 -m fornborg_pipeline.reconstruct --site broborg`.
`test_the_committed_file_matches_a_fresh_parse` passes. Two things remain disclosed rather than
fixed. `L1943:7830`'s rectangular setting is uncounted because of the glue in *stensättningoch*, so
it rides in the "counted in the record's total but not itemised" remainder with that note.
`L1941:4705`'s *"2 är stenblandade 0,5-1,5 m st block"* covers two of the four mounds and is applied
to the class.

---

## 6. Does §7 of the confidence join survive?

`docs/confidence-join-2026-09-12.md` §7 concluded that interior-building evidence does **not**
track `fortConfidence` once description length is controlled for: Mantel–Haenszel OR 1.08,
p = 0.91. Re-running `pipeline/spike/confidence_join.py` unchanged against the new rules:

| Measure (refined) | 2026-09-12 | 2026-09-24 |
|---|---|---|
| Crude | OR 1.92, p 0.026 | OR 2.21, p 0.005 |
| **MH pooled over length bands** | **OR 1.079, χ² 0.013, p 0.910** | **OR 1.205, χ² 0.233, p 0.630** |
| MH pooled over length deciles | OR 1.113, p 0.828 | OR 1.232, p 0.575 |
| Spearman(chars, confidence) | 0.481 | 0.502 |

**The null result survives.** The crude association strengthened and the stratified one did not,
which is the confound §7 named — a longer description has more room to say `kallmurade` *and* more
room to say `husgrund` — showing up more clearly now that the drystone criterion reads the longer
descriptions properly. Nothing in §7's verdict is reopened.

`confidence_join.py`'s drystone sensitivity block is **inverted rather than deleted**: it now
scores the five-form word list as the counterfactual, so the dated doc's own comparison stays
reproducible from live code, printed beside the shipped one.

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
6. **`CONSTITUENTS`' size vocabulary.** The mound constituent's size words are `('högarna',)`
   alone, so a record writing *"Högen är 8 m diam och 0,9 m h"* — a field with a single mound —
   finds no size sentence and the class is wholly archetype default. `L1943:7229` is one; the
   coincidence that the mound default `(0.2, 0.3)` equals another class's *stated* calibre in that
   record is what first made this look like a class→calibre offset. It is a real gap, it is
   pre-existing, and widening a class's count/size vocabulary is a §3 change with its own national
   blast radius, so it is named here rather than made.
7. **Per-field provenance inside a grave-field class.** A class's `source` is decided by its plan
   size alone, so a defaulted calibre still ships under `measured`. §3.2 removes most of the
   defaults; it does not fix the badge, which is a §14 contract change.

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

Note the difference between this and §3.2. There, a sentence-scope rule was quietly substituting
an archetype default for a measurement the register states — so it had to be fixed. Here, the
fallback is **named in `fallbacks`**, so the file says what it did. The rule is not "reach further
wherever a number exists"; it is "never replace a stated measurement without saying so".

---

## 9. Pinned numbers changed by this phase

| Number | Was | Is | Why |
|---|---:|---:|---|
| `_DRYSTONE` coverage | 275 / 338 | **338 / 338** | stem replaces a five-inflection word list |
| `_RING` coverage | 57 / 63 | **63 / 63** | same |
| `fortConfidence` ≥ 0.60 | 433 (33.2 %) | **459 (35.2 %)** | 24 forts from the drystone stem, 2 from the wall-scope repair |
| Ramparts with a parsed present height | 1 021 | **1 039** | wall anchored on the clause that measures it |
| …with a parsed length | 889 | **902** | same |
| …with a parsed stone calibre | 913 | **949** | the calibre sentence the register writes next |
| Walls badged `measured` | 979 | **994** | same two repairs |
| Entrance bearings on walls | 1 355 | **1 235** | 120 read out of the following sentence |
| Broborg grave-field classes | 24 calibres on defaults; 10 classes sized from another class's sentence | **24 stated calibres; 4 own sizes; 5 disclosed `assumed`** | §3.2, §3.3, §5.5 |
| MH refined OR (length-stratified) | 1.079, p 0.910 | **1.205, p 0.630** | still null |
| Interior gate: 1304 / 42 / 18 / 7 / 53 / 4.1 % / 13 | — | **unchanged** | the gate reads none of the changed rules |
| Strong-tier glue hole | `{l1975-712, l1983-1710}`, 0 forts | **unchanged** | re-measured, not assumed |

---

## 10. Postscript: how the one regression in this phase was found

The first version of this change shipped the sentence repair without §3.2 and reported the
resulting grave-field calibre move — `L1943:7229`'s rectangular stone settings, `0.1–0.3 m st` →
`0.2–0.4 m st` — as a *correction*, on the reasoning that the value now matched what the round
class in the same record already got. It was not a correction. `0,1-0,3 m st` is the rectangular
settings' own stated calibre, in the clause immediately after their size; `0.2–0.4` is the
`stone-setting` archetype default, which happens to equal the mound's stated calibre in that same
record, and the round class's `0.2–0.4` was the same default, not a measurement. Three numbers
that looked like a consistent offset were two defaults and a coincidence.

The lesson is the one the project already states and this phase nearly broke: **an aggregate is
not a check.** "−5 measurements, +112 false entrances removed" reads like a good trade and hides
the fact that the five were not all the same kind of loss. A value that goes missing and says so
is honest; a value replaced by a default under a `measured` badge is the silent assertion §9
forbids, and it has to be counted separately. Every changed value in §5.3 and §5.5 is now checked
against the register's own sentence, one at a time.

The same rule caught the next one. The regenerated bundle's diff matched its prediction exactly:
38 endpoints across 33 classes, every one moving off a default. Checking each value against its own
record then showed that 10 of those classes were taking the round class's figures (§3.3). The shape
of the diff was right and the provenance of the values was wrong.
