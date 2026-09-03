# Interior-building evidence in the national fornborg register

> **Research output, not a specification.** This file measures the KMR register in order to
> inform an **open** decision — `docs/reconstruction-mode.md` **§11 decision 7**, *which interior
> state is the default (§7.5)*. Nothing in the pipeline or the app reads it, no schema depends on
> it, and it does not amend §7.5 or §11. Companion data: `docs/interior-survey-2026-08-30.json`
> (one row per fort, full description text included, so this can be re-analysed without
> re-downloading 2.3 GB).

Measured **2026-09-03** against `lamningar_sverige.gpkg` (2,290,958,336 bytes, retrieved from
`pub.raa.se/nedladdning/datauttag/lamningar_v1/` that day) over all **1 304** forts in
`pipeline/registry.json`. The filename keeps the 2026-08-30 label the request used, so it can be
cited by that name.

---

## 1. Read this first — description coverage

**1 303 of 1 304 forts (99.9 %) carry a `beskrivning` in the national extract**; exactly one has
none. Median description length is **680 characters**. Coverage is therefore *not* the limiting
factor nationally, and the rates below are not crippled lower bounds in the way the brief
anticipated.

Two caveats do bite, and they bite unevenly:

1. **213 forts (16.3 %) have a description under 200 characters** — roughly one sentence, enough
   to say "Fornborg, 90x60 m, begränsad av vall" and nothing else. A fort like that cannot
   produce a keyword hit whatever is inside it. This is concentrated almost entirely in **Västra
   Götaland**, where 131 of 223 forts (58.7 %) are that thin — median description 118 characters
   against 680 nationally. **Västra Götaland's rate below is a genuine lower bound; the rest of
   the country's mostly is not.**
2. **A description records what a surveyor saw on a walkover, not what is in the ground.**
   Broborg's own interior settlement layer is dated AD 432–542 by excavation (§7.5) and is
   invisible from the surface. Every rate here measures *visible, recorded* interior structure,
   which is a strict subset of *occupation*. Absence of a husgrund in a description is not
   absence of a house.

---

## 2. Headline

Two numbers, because the keyword rule as specified turned out to be unreliable and the audit in
§6 shows exactly where. Both have the same denominator: **all 1 304 registered fornborgar** in
`registry.json`.

| Measure | Forts | Rate | Denominator |
|---|---:|---:|---|
| **Defensible — strong keyword (modern buildings removed) OR a settlement record inside the extent** | **54** | **4.1 %** | 1 304 |
| Upper bound — the keyword rule exactly as briefed, OR a settlement record inside | 150 | 11.5 % | 1 304 |

Component measures:

| Component | Forts | Rate |
|---|---:|---:|
| (b) any interior-building term, strong or medium tier, surviving negation | 140 | 10.7 % |
| (b) strong-tier terms only (`husgrund*`, `husterrass*`, `hustomtning*`, `grophus*`, `boplatsvall*`, `boplatsborg*`) | 46 | 3.5 % |
| (b) strong tier, minus hits the same sentence marks as modern/post-medieval | 43 | 3.3 % |
| (b) strong tier, modern removed **and** every hedged claim removed (`möjlig`, `trolig`, `-liknande`) | 27 | 2.1 % |
| (c) at least one KMR settlement/house record inside the fort's own extent | 18 | 1.4 % |
| (d) **both** (b-strong-clean and (c) agree) | 7 | 0.5 % |

**A third of the strong tier hedges.** KMR writes *"möjlig husgrund"*, *"kan möjligen vara
husgrunder"* and *"husgrundsliknande lämning"* as readily as *"88 husgrunder"*. 16 of the 43
strong-tier forts are hedged in **every** hit they carry, leaving 27 (2.1 %) that state a
building inside the enclosure flatly. Read 2.1 % as the floor and 4.1 % as the working figure;
the hedge flag is per hit in the JSON and marked on every sample in §6.1.

The two measures are **independent** — one reads the fort's own free text, the other queries
neighbouring records geometrically — and they agree on 7 forts. That overlap is the single
strongest reason to trust the strong tier and not the medium one.

**Classification of every fort (§(d) of the brief):**

| Class (broad rule) | n | Rate |
|---|---:|---:|
| both language and a settlement record | 8 | 0.6 % |
| interior-building language only | 132 | 10.1 % |
| settlement record inside only | 10 | 0.8 % |
| neither | 1 153 | 88.4 % |
| undetermined (no description at all) | 1 | 0.1 % |

Because description coverage is 99.9 %, the *undetermined* bucket is 1 fort, not the large
unknown the brief allowed for. Geometry is not a limitation either: 1 261 of 1 304 forts have a
real extent polygon and got a point-in-polygon test; only 43 (the line- and point-geometry
forts) fell back to a bounding box, and those are flagged per fort in the JSON as
`settlementTestMethod`.

---

## 3. Per county

Öland is split out of Kalmar county by kommun (Borgholm, Mörbylånga); Gotland is its own county.
*Thin* = description under 200 characters. *Broad* is the briefed keyword rule (plus the spatial
test); *Refined* is strong-tier-clean plus the spatial test.

| County / region | Forts | Thin desc. | Median chars | Broad | Broad % | **Refined** | **Refined %** |
|---|---:|---:|---:|---:|---:|---:|---:|
| Södermanland | 242 | 46 | 726 | 28 | 11.6 % | **8** | **3.3 %** |
| Stockholm | 240 | 11 | 709 | 31 | 12.9 % | **12** | **5.0 %** |
| Västra Götaland | 223 | 131 | 118 | 8 | 3.6 % | **3** | **1.3 %** |
| Östergötland | 150 | 5 | 811 | 19 | 12.7 % | **6** | **4.0 %** |
| Gotland | 85 | 5 | 659 | 15 | 17.6 % | **8** | **9.4 %** |
| Uppsala | 79 | 4 | 583 | 5 | 6.3 % | **0** | **0.0 %** |
| Kalmar (mainland) | 62 | 0 | 851 | 9 | 14.5 % | **4** | **6.5 %** |
| Västmanland | 58 | 0 | 874 | 9 | 15.5 % | **1** | **1.7 %** |
| Värmland | 39 | 0 | 658 | 6 | 15.4 % | **1** | **2.6 %** |
| Örebro | 34 | 3 | 980 | 4 | 11.8 % | **1** | **2.9 %** |
| Halland | 29 | 3 | 757 | 1 | 3.4 % | **0** | **0.0 %** |
| Öland | 21 | 1 | 817 | 6 | 28.6 % | **5** | **23.8 %** |
| Gävleborg | 12 | 1 | 679 | 0 | 0.0 % | **0** | **0.0 %** |
| Västernorrland | 10 | 0 | 936 | 1 | 10.0 % | **1** | **10.0 %** |
| Blekinge | 8 | 0 | 619 | 2 | 25.0 % | **0** | **0.0 %** |
| Skåne | 5 | 1 | 907 | 4 | 80.0 % | **2** | **40.0 %** |
| Jönköping | 3 | 2 | 118 | 1 | 33.3 % | **1** | **33.3 %** |
| Kronoberg | 2 | 0 | 706 | 0 | 0.0 % | **0** | **0.0 %** |
| Stockholm,Uppsala | 1 | 0 | 442 | 0 | 0.0 % | **0** | **0.0 %** |
| Jämtland | 1 | 0 | 1249 | 1 | 100.0 % | **1** | **100.0 %** |
| **All Sweden** | **1 304** | **213** | **680** | **150** | **11.5 %** | **54** | **4.1 %** |

Counties with fewer than ~30 forts (Skåne 5, Jönköping 3, Jämtland 1, Kronoberg 2, Blekinge 8)
produce percentages that are one or two forts wide — read the counts, not the rates.

**Uppland does not obviously generalise, and neither does anywhere else.** The spread among the
large counties is real: Stockholm 5.0 % and Östergötland 4.0 % against Uppsala 0.0 % and Västra
Götaland 1.3 % — but Västra Götaland's figure is the description-coverage artefact of §1, not a
statement about its forts.

---

## 4. Öland and Gotland — the limestone question

§2 of `reconstruction-mode.md` warns that the Öland ringforts are **a different building
tradition** from a Mälardalen boulder rampart: Ismantorp with 88–95 house foundations in radial
blocks, Eketorp II with 53 internal cells. If those provinces dominated the "has buildings" set,
that would argue for a typology branch rather than a national default. **They are enriched, but
they do not dominate.**

| | Forts | Share of corpus | Refined positives | Refined rate | Share of the positive set |
|---|---:|---:|---:|---:|---:|
| Öland (Borgholm + Mörbylånga) | 21 | 1.6 % | 5 | **23.8 %** | 9.3 % |
| Gotland | 85 | 6.5 % | 8 | **9.4 %** | 14.8 % |
| Both limestone provinces | 106 | 8.1 % | 13 | **12.3 %** | **24.1 %** |
| Mainland (everything else) | 1 198 | 91.9 % | 41 | **3.4 %** | 75.9 % |

Öland and Gotland are 8.1 % of the corpus but 24.1 % of the positive set — an enrichment of
about 3.6× over the mainland rate. That is a real typological signal and it is worth a branch
**for those two provinces**. It is not, however, the whole finding: 41 of the 54 positives are
mainland forts, so removing the limestone provinces from the corpus barely moves the national
figure (it falls from 4.1 % to 3.4 %).

All 5 Öland positives are worth naming, because they include the reference forts themselves:

- `l1956-3284` — Träbyborg, Mörbylånga — strong terms: `husgrund*`
- `l1956-3453` — (unnamed), Mörbylånga — strong terms: `husgrund*`
- `l1957-426` — Ismantorps fornborg, Borgholm — strong terms: `husgrund*`
- `l1958-4198` — Eketorps borg, Mörbylånga — strong terms: `husgrund*`
- `l1958-6759` — (unnamed), Borgholm — strong terms: `husgrund*`

`l1957-426` is **Ismantorp** and `l1958-4198` is **Eketorp** — both named in §2 of
`reconstruction-mode.md` as the excavated reference forts, and both recovered here by the rule
rather than by hand. Ismantorp's description reads "Innanför muren är 88 husgrunder, fördelade
på två grupper, en yttre med husen radiellt utgående från murens insida…" — the register's own
text reproduces the 88 figure §2 quotes from the literature. `l1956-3284` (Träbyborg,
Mörbylånga) records "ca 50 husgrunder". **Neither fort returns a single settlement record from
measure (c)**, because KMR files those house foundations as part of the fort's own record rather
than as separate `Husgrund` lämningar. That is a systematic under-detection in measure (c) and
the reason it is used as a union with (b), never as a check on it.

---

## 5. Against the Mälardalen survey

`reconstruction-mode.md` §7.5 and §6.A.1 quote the Mälardalen survey: of Uppland's **~30 Middle
Iron Age forts**, **5–6 have house terraces inside or beside them**, and **just over one in five
is a *boplatsborg*** — i.e. roughly **17–21 %**.

**The two figures are not directly comparable, and it matters which way the difference runs.**

| | Mälardalen survey | This survey |
|---|---|---|
| Denominator | ~30 Uppland forts **judged Middle Iron Age** | every fort **registered** as `Fornborg` |
| Selection | field survey, Olausson's four criteria applied | none — the register as it stands |
| Evidence | a surveyor's own judgement on site | the register's free text + neighbouring records |
| Area | Uppland (province) | Sweden |

§6.A.1 puts the filter's effect in numbers: **181 forts are registered in Uppland but only ~30**
**(~17 %) are judged Middle Iron Age.** So the survey's denominator is a ~1-in-6 high-quality
subset of mine. **My rate should therefore be lower than theirs by construction** — if interior
buildings correlate at all with being a genuine Migration Period fort (and they should), a
corpus-wide rate cannot exceed the rate within the filtered subset.

How much lower? If ~17–21 % of the ~17 % that are Middle Iron Age forts have interior buildings
and essentially none of the rest do, the expected corpus-wide rate is about **3 %**. The
measured national refined rate is **4.1 %**. Those agree closely enough that the two surveys are
**consistent with each other**, and that is the most useful thing this measurement produces: it
does not overturn the Mälardalen figure, it shows what that figure implies at national scale.

The regional check is less comfortable:

| Slice | Forts | Refined positives | Refined rate | Broad keyword rate |
|---|---:|---:|---:|---:|
| Uppsala county | 79 | 0 | 0.0 % | 6.3 % |
| Uppland proxy (Uppsala county + the Uppland kommuner of Stockholm county) | 165 | 4 | 2.4 % | 10.3 % |

The Uppland proxy has 165 forts, close to §6.A.1's 181 registered — but **not one fort in
Uppsala county carries a strong-tier interior-building term**, and all 5 of its broad-rule
"hits" are false positives on inspection (§6). The Mälardalen survey says 5–6 Uppland forts have
house terraces; the register's Uppland descriptions do not say so in words this rule can find.
**The survey's judgement is field observation that never entered the KMR text.** Any national
default derived from the register alone will therefore *undercount* exactly the province the
app's own reference fort sits in.

---

## 6. Audit — is the keyword rule sane?

**Short answer: the strong tier is sound, the medium tier is not, and the brief's term list
mixes the two.** Read the samples below before using any number above.

Term frequency across all counted (non-negated, non-exterior) hits:

| Term | Tier | Counted hits |
|---|---|---:|
| `terrass*` | medium | 103 |
| `stensträng*` | medium | 78 |
| `husgrund*` | strong | 68 |
| `anläggning*` | weak (never counted toward a rate) | 59 |
| `bebygg*` | medium | 10 |
| `husterrass*` | strong | 1 |
| `boplatsborg*` | strong | 1 |

Hits discarded by rule, all auditable per fort in the JSON (`hits[].verdict`):

- **negation — 26 hits across 20 forts.** A negation cue (`inga`, `ingen`, `inte`, `ej`, `icke`,
  `saknas`, `saknar`, `avsaknad`, `utan`, `påträffades ej`, …) anywhere in the same sentence
  discards the hit. Sentence scope rather than a fixed character window, because KMR writes the
  negation on both sides of the noun: *"inga synliga anläggningar"* and *"husgrunder saknas"*.
- **exterior placement — 56 hits across 46 forts.** The sentence puts the feature *outside* the
  enclosure (`utanför`, `nedanför`, `intill`, `invid`, `N/S/Ö/V om`, `i anslutning till`, `vid
  foten`) with no interior cue in the same sentence. An explicit interior cue (`innanför`, `inne
  i`, `i borgens`, `borgplatån`, `borggård`, `i det inre`) **outranks** the exterior cue, so
  *"terrassering i borgens inre, söder om vallen"* still counts.
- **non-building terrace — 4 hits.** `odlingsterrass`, `naturlig terrass`.
- **modern building — 3 forts** dropped from the strong tier because the same sentence names a
  post-medieval or modern structure (`sentida`, `torp`, `villa`, `sommarstuga`, `uthus`,
  `tegelhus`, a 19xx date). This is the discard that matters most: KMR describes a croft
  foundation and an Iron Age one in identical vocabulary.

### 6.1 Twenty-two keyword hits, full description text

Fourteen strong-tier, spread across regions:

**`l1975-712`** — L1975:712 · Gotland, Gotland · span 110 m · 1047 chars

- counted: `husgrund` (strong, MODERN CUE: sentida)
- **verdict: DROPPED as modern — the sentence says `sentida`**

> 1) Fornborg, närmast rund, 105-115 m diam, bestående av en yttre och en inre vall jämte en mellan vallarna liggande grav. Den ytt re vallen är 5-6 m br och 0,4-0,5 m h och består mest utav jord, sannolikt kommande från vallgraven. Den inre vallen är 7-8 m br o ch 0,4-0,6 m h med i ytan talrika stenar 0,4-0,6 m st. Graven mel lan vallarna är 3-8 m br och intill 1,2 m dj. Vallarna och graven framträder tydligast mot N och Ö medan de är obetydliga mot V oc h S. I NNV och SSÖ är landbryggor över vallgraven för hålvägen 8- 9 m br och i N och Ö är två mindre landbryggor 3-4 m br. I V kant en är en sentida stenhusgrund och landsväg skär genom V halvan. I borgens Ö och N del är 2) Gravfält, bestående av 21 runda stensä ttningar, 3-5 m diam och 0,1-0,3 m h. Övertorvade och övermossade med i ytan delvis talrika stenar 0,3-0,7 m st. I flertalet stens ättningar är mittgrop. Med utgångspunkt i nutida landsväg 45 m NN V fornborgen, med passage genom borgen till 30 m S om denna är 3) Hålväg, 165 m l (NV-SÖ till NNV-SSÖ) 4-5 m br och 0,3-0,4 m dj.

**`l1955-741`** — L1955:741 · Kalmar, Västervik · span 54 m · 737 chars

- counted: `husgrunder` (strong)
- **verdict: COUNTED — strong tier, no modern cue, but every strong hit here is HEDGED (möjlig /
  trolig / -liknande); judge it from the text below**

> 1) Fornborg, oval 34x28 m (VNV-ÖSÖ) bestående av en ringformigvall 80 m l 4-8 m br och 0,5-1,0 m h. Vallen är uppförd av0,4-1,0 m stora stenar, bitvis kan en kallmurning av stenarnaiakttagas. Även enstaka större klumpstenar ingår i vallen. Ivallens ÖNÖ del är en ca 1 m br raserad ingång. Inom vallenligger ett flertal klumpstenar av 0,75-1,5 m stora.Klumpstenarna inom vallen avgränsar två röjda ytor 8x6 (VNV-ÖSÖ)och 6x4 m (Ö-V) i den S delen av borgområdet. Detta kan möjligenvara husgrunder. Muren och borgområdet är beväxt med ung lövskogoch sly. I sluttningen Ö-NÖ utanför borgen ligger det fullt medstora block. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l2013-3917`** — L2013:3917 · Garnisonen · Stockholm, Ekerö · span 51 m · 1886 chars

- counted: `husgrunder` (strong); `husgrunden` (strong); `terrasseringar` (medium); `terrass`
  (medium); `terrassen` (medium); `terrassen` (medium); `terrass` (medium)
- **verdict: COUNTED — strong tier, no modern cue, not hedged**

> Befäst område med husgrunder och terrasseringar (T 0-III) från vikingatid, delundersökt, ca 55x30-15 m (NNÖ-SSV). Benämns 'Garnisonen'.
> Vid arkeologisk undersökning år 1998-2000 påträffades 1 treskeppigt långhus, ca 19x10 m (NÖ-SV), beläget på en terrass i form av en uppbyggd platå, ca 23,5x11 m st. Anläggningar och lager bestående av bl.a. 3 golvlager, stolphål, härdar, utfyllnadslager till terrassen och ränna påträffades. Byggnaden har sannolikt haft 2 ingångar på S långsidan, och har tolkats som resterna av ett hallhus. Till den V ingången har det funnits en stenramp. Rikligt fyndmaterial, med bl.a. vapen och rustningsdetaljer. Datering: Fynd av doppsko i borrestil har daterats till senare hälften av 900-talet e. Kr. De äldsta mynten är från ca 698-749 e. Kr. och de yngsta ca 930/1-940/1 e. Kr. Vid undersökningen togs C14 prover. Byggnadens sista fas kan sannolikt daterats till slutet av 900-talet e. Kr. Under husgrunden och terrassen framkom resterna av en äldre struktur, bestående av stolphål, ränna, härdrest och sot/kollager. 1998 undersöktes även delar av en mindre terrass, belägen strax SV om hallhuset. Bl.a. framkom 1 stenpackning samt 1 större stolphål i anslutning till denna. Fynd av 1 bysantinskt kopparmynt, pilspetsar och pärlor påträffades ytligt. Inom områdets Ö del undersöktes 1 vall (tidigare införd som RAÄ-nr Adelsö 172). Bl.a. framkom 1 ränna längs med vallen, stenpackning, 3 möjliga stolphål och mörkfärgningar. Vallen är uppbyggd av grus och grusblandad sand på en undergrund av lera. I rännan påträffades spikar, vilket kan tyda på att det funnits ett träverk på vallen. Vid vallens fot framkom en ränna med stenrad, mot V och Ö sidan. Fynd av bl.a. spjutspets, knivar, skifferbryne, järnbeslag, spikar, nit, ben och lerklining m.m.
> Tidigare undersökningar på platsen har utförts av H. Stolpe 1877 och H. Arbman 1934 (RAÄ dnr 321-3666-2002).

**`l1983-1710`** — L1983:1710 · Södermanland, Nyköping · span 124 m · 1139 chars

- counted: `husgrundsterrass` (strong); `terrasseringar` (medium)
- discarded: `husgrunden` → exterior_cue (`nedanför`)
- **verdict: COUNTED — strong tier, no modern cue, not hedged**

> Fornborg, 100x50-70 m (NÖ-SV), belägen på bergklackens krön ochsluttningar. Begränsas i Ö-S-V av branta sluttningar och iNV-N-NÖ av en stenvall, ca 55 m l, med smärre avbrott, 1-2 m broch 0.3-0.6 m h, av 0.3-0.7 m st stenar, i regel skarpkantade.Valler som nu delvis är belägen på ett egendomligt sätt i brantsluttning är starkt raserad.Från borgens S del är en utsikt över Svartåns och dalens inlopp.Ca 6 m V om bergklacken på en lägre avsats är enhusgrundsterrass, 13x7 m (NV-SÖ), 0.4 m h, av 0.2-0.7 m ststenar. Mellan fornborgen och husgrunden är en passage, 2.5 m brsamt mot fornborgens bergsida en del av en kallmurad mur, ca 2 ml (NNV-SSÖ).Alldeles S och SÖ om denna är ett mindre berg som ger en naturligmur, men S om denna ligger en mängd stenar i marken som börtillhört en mur, ca 20 m l (NNV-SSÖ).I S nedanför muren går en sänka ner mot dalgånen. I sänkan finnsnågra svaga terrasseringar (Ö-V) samt i den nedre delen ev. enrest av hålväg, (N-S), ca 1-1.5 m br och 0.4 m dj.Se skiss i inventeringshandlingarna. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l2005-4856`** — L2005:4856 · Värmland, Säffle · span 104 m · 887 chars

- counted: `husgrundsliknande` (strong, MODERN CUE: sentida)
- **verdict: DROPPED as modern — the sentence says `sentida`**

> Fornborg, ca 105 x 45 m (NNÖ-SSV), anlagd på krön och sluttningar av ett berg, som sluttar tämligen brant mot SSV-V-VNV och som i S sluttar ned i ett starkt klyftrikt terrängparti. Borgområdet begränsas av mursträckningar i VNV-N, i NNÖ-Ö och i ÖSÖ-SSÖ, vilka har en sammanlagd längd av ca 105 m. Tydlig ingång, ca 2.5 m br i N (vid a på skissen). Murarna är 1-1.5 m br, 0.2-0.4 m h. De består av både klumpformiga och kantiga stenar, 0.2-0.5 m st. Ingenstans finns bevarade murliv. På en ca 17 m l sträcka i VNV är muren övertorvad. En gångstig leder från SSÖ upp till borgen genom det klyftrika partiet i dess S del (vid b på skissen). På bergskrönet i borgens inre ligger en sannolikt sentida husgrundsliknande lämning, ca 4 x 2.5 m av 0.3-0.4 m st stenar (vid c på skissen). Ingen vattentäkt eller något sumphål finns inom borgområdet, som är bevuxet med enstaka tallar och enbuskar.

**`l2003-7630`** — L2003:7630 · Sorbyborg · Västmanland, Västerås · span 116 m · 1078 chars

- counted: `husgrundsterrass` (strong)
- discarded: `stensträng` → exterior_cue (`utanför`)
- **verdict: COUNTED — strong tier, no modern cue, but every strong hit here is HEDGED (möjlig /
  trolig / -liknande); judge it from the text below**

> Fornborg, ca 100x100 m belägen på en tämligen låg moränhöjd vars svaga sluttningar förstärkts genom ett flertal murar. Den inre huvudmuren är intill 3 m h och i sitt utrasade skikt intill 10 m br. På flera ställen synlig kallmurning både in- och utvändigt. Muren synes ha haft en ursprunglig bredd av intill 5 m och bildat en sluten krets. Den är omgiven av ett system av förborgar utom i SÖ. Den inre förborgen är 2-3 m h och intill 5 m br. Såväl den inre förborgen liksom den slutna borgen är uppbyggda av i regel 0.4-0.7 m st stenar, medan den yttre förborgen är uppbyggd av i huvudsak blocksten och jordfasta stenar. Den yttre förborgen är ca 1 m h och 2-3 m br.  Utanför den yttre förborgen finns i V och Ö en stensträng av intill meterstora stenar. I murarna finns ett flertal öppningar, 2-3 m br, ej belägna mitt för varandra.Borgens inre är 34x31 m (NNV - SSÖ). Den inre samt den mellersta förborgen är ställvis kallmurade.  I fornborgens S kant strax N om vägen är en möjlig husgrundsterrass, 8x5 m (NÖ - SV) och 0.3 mh. I SÖ är ca 1-2 m st stenar. Skadad av täkt i SV.

**`l1963-1304`** — L1963:1304 · Västra Götaland, Vänersborg · span 53 m · 891 chars

- counted: `stensträng` (medium); `stensträng` (medium); `husgrund` (strong)
- **verdict: COUNTED — strong tier, no modern cue, but every strong hit here is HEDGED (möjlig /
  trolig / -liknande); judge it from the text below**

> Fornborgsmur, ca 150 m l (därav ca 65 m N om vägen), 1-3 m br och 0,2-0,8 m h, av kantiga stenar, 0,1-0,7 m st och block, intill 1,5 m st. Muren utgör numera gräns för kronoparken och är påbyggd, särskilt S om vägen. Muren är där avbruten ca 25 m av en gårdsplan samt ytterligare mot S av en 2,4 m br öppning. Muren avslutas i S med en gränssten (se Västra Tunhem 8:2) med målad vit krona och därunder ett vågrätt streck tvärsöver stenen. Ö om muren finns ytterligare stenmurar, 40 resp. 10 m l (Ö-V), 1-4 resp. 3-6 m br och 0,2-0,7 resp. 0,4-0,6 m h.
> 
> Revideringsinventeringen 1983: Muren är kraftigt påbyggd strax N om vägen och har där på Ö sidan mindre utbyggnader, 1 stensträng, 15 m l (Ö-V), 1,5 m br och 0,3-0,6 m h, samt 1 inhägnad (möjlig husgrund), 8x4 m och 0,3 m h. Längst upp mot bergsidan på V sidan om muren går 1 valliknande stensträng, 55 ml (Ö-V), 4-6 m br och 0,1-0,4 m h.

**`l1956-3284`** — L1956:3284 · Träbyborg · Kalmar, Mörbylånga · span 180 m · 1010 chars

- counted: `husgrunder` (strong); `husgrunderna` (strong); `husgrund` (strong)
- discarded: `husgrunder` → negated (`inga`); `bebyggelse` → negated (`inga`)
- **verdict: TRUE POSITIVE — Träbyborg; ~50 husgrunder in two borgrum, one test-excavated**

> Fornborg, ca 210x75 m (NÖ-SV) bestående av 3 från varandra avskiljda "borgrum", ett runt, två något ovala. Vallarna är 7-10 m br och 1-2 m h, kraftigt nedrasade och bestående av kraftigt vittrade kalkstenar.
> 
> Inom borgen finns ca 50 husgrunder, varav ca 25 är belägna inom det NÖ borgrummet och 25 inom det mellersta. 2 av dessa förefaller vara större än de övriga, 26x12 m (i N borgrummet) resp 16x10 m (i mellersta borgrummet), samt belägna centralt inom respektive borgrum (orienterade ÖNÖ-VSV).
> 
> De övriga husgrunderna, ca 12x8 m (vallarna är 1-2 m br och 0,1-0,2 m h), med ett par undantag belägna vid borgvallen och utgår radiellt från stenarna. De flesta tycks ligga vägg i vägg med varandra, i några fall tycks de dock vara friliggande.
> 
> Runt borgens vallar är stengärdesgårdar av kalkstenar uppbyggda från vallen och i S borgrummet, där inga forntida husgrunder observerats, är lämningar efter sentida bebyggelse.
> 
> I N borgrummet är 1 husgrund provgrävd och i denna syns rester av kallmur och skalmur.

**`l1980-3692`** — L1980:3692 · Tarsta berg · Örebro, Hallsberg · span 194 m · 1359 chars

- counted: `husgrund` (strong); `terrassering` (medium); `Terrasskanten` (medium)
- **verdict: COUNTED — strong tier, no modern cue, but every strong hit here is HEDGED (möjlig /
  trolig / -liknande); judge it from the text below**

> Fornborg, 190x190 m, belägen på ett högt, mot NÖ sluttande berg och begränsad av branta sluttningar, stup och stenvallar. I N, Ö och S finns 1 stenvall, 310 m l, 5-12 m br och 1,5-2,5 m h av i allmänhet, 0,5-1,5 m st stenar. I S finns en yttre mur parallell med den inre (ca 10 m från varandra). Vid ändpunkterna löper den samman med den inre. Den yttre muren är 100 m l, 4-5 m br och 0,5-1,5 m h av i allmänhet 0,5-1 m st stenar. I den inre muren finns 4 ingångar och i den yttre 1 ingång. De är 1-3 m br. Hela muranläggningen är väl bevarad. Borgen är bevuxen med barrskog.
> 
> Revidering 1981: Förutom ovan nämnda vallar finns i ÖNÖ 1 vall, 20 m l (NV-SÖ), 1 m br och 0,4 m h av 0,2-0,9 m st stenar (belägen 6 m utanför den stora vallen) och i V 1 vall, 5 m l (NNÖ-SSV), 5 m br och 0,3 m h av 0,2-0,6 m st stenar. Den 310 m l vallen är ställvis kallmurad intill 20 skift (ofta ca 5 skift). Denna vall utgörs i SV änden av grus och stenskärv inom en 20 m l sträcka. Rikligt med sten återfinns här nedanför bergsbranten. I borgens inre finns 1 terrassering, 25x8 m (S/N), i N 0,5 m h, i Ö 0,2 m h och i övrigt nära det naturliga markplanet. Terrasskanten i N och Ö utgörs av 0,2-0,7 m st stenar. Sannolikt en husgrund. Borgens inre utgörs i övrigt av småkuperad häll- och moränmark med småskrevor. I två skrevor är vid inventeringstillfället rikligt med vatten.

**`l2009-1439`** — L2009:1439 · Östergötland, Norrköping · span 251 m · 2031 chars

- counted: `stensträngskaraktär` (medium); `Husgrundsterrassen` (strong)
- discarded: `stensträngar` → negated (`ingen`); `husgrundsterrass` → exterior_cue (`nedanför`);
  `terrassformig` → exterior_cue (`intill`)
- settlement records inside the extent (polygon test): Husgrund, förhistorisk/medeltida
  `L2009:2067`
- **verdict: COUNTED — strong tier, no modern cue, not hedged**

> Fornborg 250x80-150 m (Ö-V) begränsad i N och S-SÖ av branta, i V och SV av lodräta, stup. I Ö är berget mer långsluttande och borgen är här försedd med flera, i sluttningen nedanför varandra liggande stenvallar av vilka nu endast rester kvarstår. Vallarna, sannolikt fyra till antalet, har en sammanlagd längd av ca 200 m. 
> 
> Den övre vallen, på krönkanten, är ca 30 m l (N 20cg V-S 20cg Ö) 2-4 m br och 0,2-0,3 m h, till stor del övertorvad, bestående av 0,2-0,5 m st stenar. Flertalet är utrasade åt NÖ. Sluttningen nadanför är brant men kraftigt övertorvad och med säkerhet innehållande kulturlager. Den avslutas nedåt av vall 2, som är 80 m l (svängd VNV-SSÖ). Den är terrassformig, intill 0,6 m h och till stor del övertorvad, bestående av 0,3-0,8 m st stenar. Ca 30 m från vallens NV ände finns en mindre ravin som vallen skär i övre kanten. Vallen och sluttningen är överväxt av slån, dess S begränsning är oklar. 10-15 m nedanför (ÖNÖ om) vallens S del är en husgrundsterrass, ca 19x6 m (N 10cg Ö-S 10cg V) och 0,2-0,5 m h. Övertorvad, tuvig yta, med stenskoning i nedre kanten av 0,3-0,8 m st stenar. 
> 
> 20 m Ö-ÖNÖ härom är vall 3, ca 40 m l (N-S) och ytterligare ca 20 m nedanför denna är vall 4, ca 50 m l (NNV-SSÖ) vilken i N möjligen sammanfaller med vall 3. Dessa vallar består av 0,2-0,8 mbst stenar, är av stensträngskaraktär, 2-4 m br, på enstaka ställen möjligen bredare (utrasade?) och 0,1-0,2 m h, delvis otydliga, ställvis övermossade och fragmentariska. 
> 
> I en smal ravin (N-S) i bergets S-sida ligger nära krönet enstaka spridda stenar (möjlig uppgång?) Stupet i SÖ utgörs delvis av tvärbrant morän. Vall 1 ligger i klart fornborgsläge och har befäst krönet, även om detta ej är obestigligt från N i branta klyftor. Vall 2 liknar mera fundament till andra anläggningar och utgör nedre begränsningen av ett kulturlager. Vall 3 och 4 har ingen befästningskaraktär utan liknar helt stensträngar. Husgrundsterrassen ligger dock inom dessa. Berget utgör i sin helhet ett boplatsområde med tillgång till befästning.

**`l1976-4208`** — L1976:4208 · Gotland, Gotland · span 78 m · 501 chars

- counted: `husgrund` (strong)
- **verdict: COUNTED — strong tier, no modern cue, but every strong hit here is HEDGED (möjlig /
  trolig / -liknande); judge it from the text below**

> Fornborg (rest av) 70x60 m (NÖ-SV) bestående av en vall i N-V-S. vallen är 95 m l, 3-4 m br och 0,3-0,5 m h bestående av i ytan e nstaka stenar samt jord. Utanför vallen är en vallgrav, 1-2 m br och 0,2-0,4 m dj. Ingångar troligen i N och i V 6-7 m br. Ca 3 m Ö om vallen är talrika 0,2-0,5 m st stenar synliga (10x3 m N-S) ( rest av inre vall?). I ronborgens centrum finns en anläggning, so m kan vara en liten husgrund. Fornborgens Ö del är helt bortodlat . Beväxt med lövträd samt enstaka barrträd.

**`l1959-5163`** — L1959:5163 · Tranehäll · Kalmar, Mönsterås · span 142 m · 1588 chars

- counted: `stensträng` (medium); `stensträngar` (medium); `stensträngbegränsar` (medium);
  `husgrundsliknande` (strong)
- discarded: `stensträngar` → exterior_cue (`nedanför`)
- **verdict: COUNTED — strong tier, no modern cue, but every strong hit here is HEDGED (möjlig /
  trolig / -liknande); judge it from the text below**

> 1)Fornborg, 160x100 m (NV-SÖ), begränsad av stup i SÖ-S-SV och iS V-NV-Ö av brant sluttning försedd med 4 stenvallar. En vall, iSV, på hylla nedanför bergstup, är 40 m l (NV-SÖ) 1-1,5 m br och0, 2-0,5 m h. Vallen i NV-Ö är 145 m l, 3-5 m br (i regel 4 m)och 0 ,5-1,5 m h, ställvis kallmurad intill 3 skift. Mellandessa, i V, är 2 vallar vardera 10 m l (NV-SÖ respektive NÖ-SV),1-2 m br oc h 0,2-0,5 m h. Den senare begränsar "ficka" eller"bås" tillsamma ns med bergväggar. Vallarnas stenar är 0,2-1,2 mst, i regel 0,2- 0,5 m st. Vallen i Ö är delvis övertorvad ochutgöres i S delen a v övervägande 0,2-0,2 m st stenar. 2 tydligaingångar i N och Ö, är 1,5-2 m br. Möjligen är ytterligare 1ingång i NV, 1 m br. Till ingången i N ansluter sig ifornborgens inre 1 stensträng, 16 m l (N-S) 1,5 m br och 0,2 mh, av 0,2-1 m st stenar jämte en 1,5 m st sten. I anslutningtill denna förekommer enstaka diffusa val lar, förhöjningar ochstensträngar, av jord och 0,2-1,5 m st stenar. 1 stensträngbegränsar en yta, 8x4 m (NNÖ-SSV) som är husgrundsliknande. Påberghäll på borgbergets högsta punkt är en ristning (se skiss),sentida. Fornborgens inre utgöres i övrigt av berghällar i S ochhäll- och moränmark i N. I S delen är 4 järnkrampor efterutsiktstorn. Omedelbart N om den osäkra ingången i NNV ärutanför och nedanför borgberget 3 smärre antydningar tillstensträngar, 3-8 m l (varierande utsträckning), 0,5-1,5 m broch 0,2-0, 4 m h. av 0,2-1,5 m st stenar, i regel 0,2-0,5 m st. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l2013-5619`** — L2013:5619 · Borgberget · Stockholm, Stockholm · span 251 m · 950 chars

- counted: `stensträng` (medium); `stensträng` (medium); `stensträng` (medium); `stensträng`
  (medium); `husgrundslämningar` (strong, MODERN CUE: historisk tid)
- **verdict: DROPPED as modern — the sentence says `historisk tid`**

> Fornborg?, ca 250x150 m (NÖ-SV). Den ev. borgen begränsas av branta stup i NV och SÖ. I S-SV är relativ jämn sluttning. I området finns flera vallar. De är bitvis mycket låga och övertorvade och "kantliknande". Ca 40 m NÖ om gångväg är 1 stensträng, ca 13 m l (Ö-V), med en 2 m l öppning. Från dess V del går en mycket låg halvcirkelformad anläggning, ca 13 m l (Ö-V), med ca 1 m mellan stenarna. På bergets SÖ sluttning är 1 ca 11 m l (NÖ-SV) stensträng, samt 1 ca 10 m l (NÖ-SV) stensträng. På bergets N-sida är 1 sammanlagt ca 35 m l stensträng (Ö-V) som är avbruten på flera ställen av bergklackar. Från Ö utgör den en mycket låg, övertorvad kant mot V i  ca 12 m. Efter avbrott fortsätter den ca 8 m med block, och fortsätter efter ytterligare ett avbrott i ca 15 m med synliga block mot NO-SV. Inom fornborgens utbredning finns även 6 oregelbundna husgrundslämningar, vilka bedöms vara från historisk tid. Se Bromma RAÄ 1:1. (RAÄ 326-1917-2010)

**`l1984-1190`** — L1984:1190 · Södermanland, Nyköping · span 237 m · 1212 chars

- counted: `husgrundsterrass` (strong); `husgrundsliknande` (strong); `terrassering` (medium);
  `terrassering` (medium)
- **verdict: COUNTED — strong tier, no modern cue, but every strong hit here is HEDGED (möjlig /
  trolig / -liknande); judge it from the text below**

> 1) Fornborg, 280x120 m (SÖ-NV) belägen på krön och sluttningar avkraftig berghöjd i NV del av Ö i Lindsjön med branta bergstop iV-N-Ö och en dubbel vall i SÖ slänt. Den inre vallen i SÖ är en80 m l (ÖNÖ-VSV), 8-12 m br samt 1.1.5 m h på insidan och 6-7 mh på utsidan. I S del är en ingång 2-3 m br. Vallen är av ca 0.3m st stenar och block.Den yttre vallen i SÖ är bågformad, ca 100 m l (huvudriktningN-S), 6-10 m br och 0.5-2 m br på insidan och och 2-4 m h påutsidan, av 0.3-0.7 m st stenar och block med en öppning? i ÖSÖ2-3 m br SÖ om denna vall är ytterligare en mindre jordvall ca30 ml (NÖ-SV) 0.2-0.5 m h och 2-4 m br som i V ansluter till denstörre stenvallen.En mindre vall i NNÖ slänt, av tillskuffad moras ca 50 m l(ÖSÖ-VNV) och ytterligare en spärrvall i NV skreva 10-15 m l(NNÖ-SSV).Inne i fornborgens N del är 1 husgrundsterrass 19 m l (NV-SÖ),5-6 m br och 0.5-1.4 m st stenar, samt med övertorvad plan yta,SV begränsning i ytterligare en högre stenrad.I Fornborgens SV del strax V om bergskrönet är en terrassering?10-15 m l, med plan yta en husgrundsliknande svag terrassering. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

Eight medium-tier-only forts — these are what the medium tier actually buys:

**`l1979-6219`** — L1979:6219 · Blekinge, Ronneby · span 178 m · 1003 chars

- counted: `terrassformig` (medium); `terrassformig` (medium)
- **verdict: see §6.3**

> Fornborg, ca 180 x 140 m (Ö-V), bestående av en bergklack i NÖ och Ö begränsad av stup, i S och SÖ av branta sluttningar. Mot N och NV är mera lättillgängliga slänter. Borgområdet begränsas i S av en terrassformig, ca 50 m l vall, 1,5 m br, 0,3 - 0,4 m h, uppförd av block och lossbrutna hällar, 0,6 - 2,3 m st. S om vallen är flera mindre stenbrott. I NV är en 11 m l vall, 2 - 3 m br, 0,4 - 0,75 m h med ett ytterliv av 0,8 - 1,3 m st block. Innanför detta är stenfyllningen av 0,3 -0,5 m st stenar. N härom och parallell med föregående är vid foten av berget en 10 m l vall av utkastad sten. Vallen är 0,5 m br, 0,35 - 0,5 m h och består av 0,3 - 0,5 m st stenar. I den NNV delen av borgområdet är två parallella vallar, 20 m resp 34 m l, 2 - 3 m br, 0,3 - 0,75 m h, av 0,3 - 0,6 m st stenar. Den yttre vallen är terrassformig och har i den centrala delen en 2 m br öppning. Vallen är bredast vid muröppningen.
> Omedelbart S om borgberget vidtar den utdikade Tresjön. N om berget är tidigare sankmark.

**`l1975-7123`** — L1975:7123 · Gotland, Gotland · span 93 m · 213 chars

- counted: `terrassering` (medium)
- **verdict: see §6.3**

> Fornborg i svagt krönläge, ca 90x75 m (NÖ-SV). Avgränsas av dubbla vallgravar, 3-4 m br och ca 1,5 m dj. Avgränsas i N av terrassering, ca 1,5 m h, sporadiskt stensatt. Ytan inuti är övervägande flack och stenfri.

**`l1997-3433`** — L1997:3433 · Halland, Kungsbacka · span 319 m · 854 chars

- counted: `terrassbildande` (medium)
- **verdict: see §6.3**

> Fornborg, 300x220 m (N-S), på högt berg med stup i N-V-Ö, endast tillgängligt från S, där det finns övertorvade och otydliga rester efter vallar. Den S vallen är 40 m l, (ca Ö-V), 2-6 m br och 0.2-0.4 m h och nu närmast terrassbildande, utom där den ansluter till berghäll i V. I sin Ö lägre del är den skadad med en oregelbunden grop, ca 9x1.5-3.5 m st (Ö-V) och intill 0.5 m dj (skyttevärn?). Den N vallen är ca 30 m l, ca 1 m br och 0.2-0.3 m h. Otydlig, särskilt i sin ÖNÖ del där stenarna är nedrasade. Stenarna i båda vallarna är 0.2-0.6 m st. Vallarna avbryts ställvis av utskjutande klipphällar. Beväxt med barr- och lövskog, ställvis mycket tät. 
> 1965 års inv angav 3 osäkra stensättningar (RAÄ-nr 56 och 57:1-2) inom fornborgen. Dessa var 2-4 m diam och 0.1 m h. Kunde ej återfinnas 1988 då bergets krön ställvis var helt överväxt med enbuskar.

**`l1955-1308`** — L1955:1308 · Kalmar, Västervik · span 161 m · 1139 chars

- counted: `terrass` (medium)
- **verdict: see §6.3**

> Fornborg 140x130 m (N-S ) belägen på ett högt berg med brantasidor, 3 st vallar spärrar skrevor är berget är flackare. 2 avvallarna är i den Ö delen av borgen. Vallarna är 15x2-2,5 m(NNÖ-SSV) resp (NNV-SSÖ) och 0,5-0,7 m h. Vallarna är uppbyggdaav 0,3-0,6 m st stenar. I den ena vallen kan en kallmuriakttagas, av delvis tuktade stenar. I anslutning till denkallmurade delen finns 2 uppresta stenar 0,5-0,7 m h och 0, 4 mtj. I den V delen finns två vallar, som täcker ingången tillborgen. De är 18x2-3 m och 23x2-4 m (NNÖ-SSV) resp (VNV -ÖSÖ)och 0,4-0,8 m h. Den andra vallen är en förborgsanläggning ochden första vallen täcker ingången upp på det centralaborgberget. Mellan dessa båda vallar löper en stig in motborgens centrum, vilken delvis löper nedanför den av de branter,som begränsar det inre borgsområdet. Centralt i det inreborgsområdet finns en platå 20x10 m (Ö-V) vilken i Ö begränsasav en terrass 6 m l och 0,5 m h. Ytan är avplanad. På storadelar av borgens yta går berget i dagen. Beväxt med glestallskog. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l1990-5884`** — L1990:5884 · Skåne, Simrishamn · span 310 m · 1492 chars

- counted: `terrass` (medium)
- **verdict: see §6.3**

> Fornborg, 280x270 m (N-S), omfattande N delen av Stenshuvud, begränsad av branta stup i N, Ö, SÖ och SV. I S där berget är mera långsluttande går en jord- och stenvall tvärsöver berget (Ö-V) och i NV-V, där en ravin skjuter in mot berget och där detta är mindre brant finns också vallar. Den S vallen, ca 200 m l, är från begränsningen i SV till krönet, ca 50 m S om högsta punkten, 105 m l, 6-7 m br och 0,8-1,5 m h. Vallen består underst av uppskottad jord, täckt av ofta kantiga stenar, vanligen 0,4-0,6 m st, flera 0,7-1 m och enstaka block nästan 1,5 m st. Spår av kallmurning finns. Muren är delvis utrasad. Fortsättningen av den S vallen, från krönet mot Ö är mindre framträdande, ca 95 m l, 4-5 m br och 0,5-1,5 m h, vanligen 1,2 m h (yttermått). Innermåttet är lägre, nästan 0,3 m h, ofta bildar vallen en övertorvad terass i nivå med innerplanet. Vallens jord- och stenmaterial som ovan.
> 
> I ravinen i NV syns en raserad stenmur, 35 m l, 5 m br och 0,6-1,2 m h, vilken mot S fortsätter i en svagt skönjbar övertorvad terrass, 60 m l, 2-3 m br och 0,5 m h (yttermått). Det finns en möjlig ingång, ca 1m br.
> 
> Borgområdet består av tre tämligen kala bergklackar med mellanliggande skogsklädda, delvis vattenförande områden. Vallar liksom borgområdet i övrigt är bevuxet med lövskog och delvis taggiga busksnår. I Borgen, ca 100 m ÖNÖ-Ö och 20 m N om S vallen finns en stensättning, 2,5 m i diam, 0,1 m h. Övertorvad med i ytan talrika stenar, 0,1-0,3 m st, vilket ev. är en fornlämning.

**`l2013-2363`** — L2013:2363 · Stockholm, Nynäshamn · span 121 m · 958 chars

- counted: `Terrassen` (medium)
- discarded: `anläggning` → negated (`saknar`); `terrass` → exterior_cue (`nedanför`)
- **verdict: see §6.3**

> Fornborg, ca 120 x 80 meter (N-S), begränsad av stup i S och V samt ställvis branta sluttningar i N och Ö varav den sista försedd med stenvall. Vallen är ca 70 meter lång (N-S), 0,5-1,2 meter bred och 0,3-1,2 meter hög, av ställvis kallmurade 0,3-1,5 meter stora stenar. I vallen ingår även några större, intill 2 meter stora block. Vallen är ställvis kraftigt utrasad mot Ö. Ca 40 meter från S änden av vallen är en ingång, ca 1,5 meter bred. Inuti borgen är marken starkt kuperad med ömsom kala klippor och djupa skrevor. Då lämningen saknar vall i N änden är det möjligt att den istället skall rubriceras som vallanläggning. I detta område omedelbart nedanför och N om bergstoppen är en relativt jämn terrass, ca 50 x 50 meter (NNO-SSV), begränsad i V av stup. Terrassen var vid besiktningen nyligen skogsavverkad och därmed svårbesiktad, dock iakttogs stenar längs den Ö kanten, vilka skulle kunna utgöra en begränsningslinje. (Anmälan dnr 326-2231-2005)

**`l1982-1289`** — L1982:1289 · Södermanland, Strängnäs · span 119 m · 486 chars

- counted: `stensträng` (medium)
- **verdict: see §6.3**

> Fornborg, 90 x 90-100 m (NNV-SSÖ), begränsad av brantare partier i V och i N, Ö och S av dubbla  hästskoformade stenvallar/murar, den yttre är 175 m l och den inre 65 m l, med öppningar åt V. Vallarna är 1-3 m br och 0,2-0,8 m h av 0,3-0,9 m st. Den yttersta stenmuren har kraftigare stenfyllning än den inre. Ytterligare en stensträng/mur går från borgens NV kant. Den är 40 m l (N-S) med liknande fyllning som den yttre muren.
> 
> Fornborgen ligger exponerad mot dalgång med å/dike i SV.

**`l1941-164`** — L1941:164 · Uppsala, Knivsta · span 61 m · 144 chars

- counted: `stensträng` (medium)
- **verdict: see §6.3**

> Fornborg, eventuell, ca 50 m i diam. Mot de mindre branta sidorna finns en enkel stensträng. För skiss se inskannat bokuppslag under referenser.

### 6.2 Twenty misses, full description text

One per region, taken from the longest descriptions among forts with no counted strong- or
medium-tier hit — a miss on a two-line record proves nothing, a miss on a 1 000-character record
is the rule's real failure mode.

**`l1979-4753`** — L1979:4753 · Bårkullen · Blekinge, Ronneby · span 261 m · 1233 chars

> Fornborg, 280x150 m (NNÖ-SSV), begränsad i S-SV-SO-Ö av branta stup och i NV-N-NÖ av branta bergssluttningar. Vallar begränsar borgplatån. Den yttre vallen (A-B på skissen) är 322 m l, 3-2 m br och 0,45-0,75 m h av 0,45-0,75 m st stenar. I NV, (C på skissen) en portöppning, 3 m br, delvis igengrodd. 
> Den inre vallen (D-E på skissen) är 90 m l, 2-3 m br och 0,3 m h av 0,35-0,5 m st stenar. Mellan yttre och inre vallen finns några förbindande vallar: D-K är 10 m l, 2 m br och 0,15 m h av 0,2-0,4 m st stenar, L-M är 11 m l, 2-4 m br och 0,5 m h av 0,8-1,75 m st stenar samt några smärre stenar, N-O (inre vallar) är 18 m l, 2 m br och 0,25 m h av 0,2-0,4 m st stenar. 
> Vall F-G på skissen är 28 m l, 2,5 m br och 0,25 m h av 0,2-0,4 m st stenar. Vall H-J på skissen  är 22 m l, 2 m br och 0,25 m h av 0,25-0,35 m st stenar samt enstaka block. Mellan G och H finns ett tiotal vallrester, 2-5 m l och 0,25-0,35 m h.
> 3 områden med spärrvallar finns: P-Q är 22 m l, 2-4 m br och 1 m h av 0,5-1,6 m st block, R-S är 11 m , 2 m br och 0,45 m h av 0,6-1,5 m st block, T-V är 41 m l, 2,5-3 m br och 0,5 m h av 0,35-0,9 m st stenar.
> Borgplatåmarken täckt med uppstickande hällmarker
> För skiss se det inskannade bokuppslaget under Referens.

**`l1975-1096`** — L1975:1096 · Gotland, Gotland · span 136 m · 814 chars

> 1) Fornborg, 150x82 m (NV-SÖ). I NV-N-Ö-SÖ begränsas borgen av t redubbla vallar, 2-5 m br och 0,2-01 m h. Övertorvade med i ytan grå- och kalkstenar. De är skilda genom vallgravar, 2-3 m br och 0,5-0,75 m dj. Fornborgen inre är mycket plant. Två större ingång ar i NNV och SSÖ, intill 4 m br, troligen utvidgade i sen tid. Fy ra mindre ingångar i NNÖ, NÖ, ÖNÖ och Ö, belägna på 45, 23, 23, 4 5 resp 45 m avstånd och mellan de två större. Från de större utgå r bankar, ca 4 m br, troligen breddaade i sen tid, från de mindre utgår ca 2 m br och 0,5 m h bankar. Ca 50 m NV om S spetsen och 5 m NÖ om stupet är: 2) Skärvstensvall, 6 m diam och 0,5 m h. Val len är 2 m br och 0,5 m h. Skärvsten i botten och ställvis i vall en (se även nr 66!) Fornborgen är glest beväxt med barrskog, främ st tallar. Se siss i boken!

**`l1951-3898`** — L1951:3898 · Gävleborg, Hudiksvall · span 109 m · 812 chars

> Fornborg, 110x85 m (N-S), belägen på ett mot SV sluttande berg. Den begränsas av mycket branta stup i Ö-NV, mindre stup i NV-V och 2 korta vallar i N-S.
> Den västra vallen är 8 m l, 2 m br och 0,3 m h. Stenarna är 0,3-0,8 m st. Den södra vallen är ca 10 m l, 2 m br och 0,1-0,3 m h, byggd av stenar, 0,2-0,5 m st. Möjligen har en ingång gått genom denna vall. 
> I borgen växer gles tallskog. Den har ett ovanligt bra naturligt läge och fordrar mycket korta vallar. Dock saknas stenar i en klyfta i norra delen (ev. ingången).
> Från S leder kallmurad infart upp till borgen. Infarten är till stor del uppbyggd i den branta sluttningen. Den är ca 20 m l, 2-3 m br och 0,1-0,5 m h, byggd av stenar, 0,1-0,5 m st. I infartens nedre del är uppbyggnaden störst, en stenlagd utjämning av markytan på 3x7 m och 0,2-0,5 m h.

**`l1996-2646`** — L1996:2646 · Halland, Kungsbacka · span 198 m · 1079 chars

> Fornborg, ca 190x130 m (N-S) belägen på ett tämligen högt berg iSÖ kanten av större bergsområde. Berget stupar brant i Ö och iviss mån S. Åt N-V-SSV är krönet ganska lättåtkomligt med brantsluttning och kortare bergsbranter. Åt det hållet är en höglänt,smal dalgång. I N-V-SSV är en vall av sten, ca 250 m l varav ca90 m (ÖNÖ-VSV) och ca 160 m (N-S), 0.5-2.5 m br och 0.2-0.5 m h.Stenarna är mestadels 0.3-1.5 m st, en del större stenblockingår även. Vallen är kraftigt raserad, belägen strax nedanhöjdplatåns kant. Bitvis, speciellt i N, kraftigt övervuxen avbärris och ljung. Vallen är tämligen sammanhängande med kortaavbrott för mindre bergsbranter. I SSV slutar vallen vidstengärdesgård (ägogräns) och är där svår att klart följa.Krönet saknar i stort skydd från S, där man relativt lätt kankomma upp. Höjdplatån är tämligen kuperad, ca 100x70 m (N-S). Pådessa absoluta krön, i S delen, är ett gränsmärke uppfört, ca 15m diam och 0.7 m h av sten. Raserat. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l1947-4073`** — L1947:4073 · Jämtland, Östersund · span 180 m · 1249 chars - settlement
records inside the extent (polygon test): Boplatsområde `L1947:4671`

> Fornborg, 200x160 m (Ö-V), begränsad av bergsstup i N, Ö och S samt i VNV av sluttning försedd med en stenvall och delvis med en låg yttre vall parallell med stenvallens SSV del. 
> Den inre vallen är är 120 m l, nu 10-15 m br och 0,7-1,3 m h. Stenarna är i regel 0,2-0,6 m st, enstaka stenar är något större och ett block är 1,6 m st. Den sydligaste delen är otydlig och är endast ca 0,2 m h. Ca 15 m N om det lägre partiet är en sänka i vatten, intill ca 2/3 av höjden  och ca 2,5 m br, där en stig går in i borgen. Ytterligare 9 m åt NNÖ är en liknande sänka, troligen en ursprunglig ingång.
> 30 m SSV om vallens NNÖ ände för ännu en stig in i borgen genom en sänka i vallen. Vallen är kraftigt raserad men kan i NNÖ möjligen  ha haft en utbyggnad. 
> Den yttre vallen är belägen 8-12 m VNV om den inre. Den är 70 m l, 2-4 m br och 0,1-0,3 m h. Övertorvad med i ytan enstaka stenar. Innanför vallen löper ett svagt markerat dike.
> De luftledningar som fanns 1963 (Hellmans karta) är borta och stolparna avtagna i markplanet. En nyare ledningsstolpe är uppsatt ca 4 m innanför inre vallen. Ett kabeldike har dragits rakt genom vallarna mot ett hus som är beläget på borgebrgets krön. Närmast huset är det igenlagt, men större delen är fortfarande öppet.

**`l1973-608`** — L1973:608 · Jönköping, Aneby · span 332 m · 1294 chars

> Fornborg, 320x120 m (N-S) begränsad av stup i Ö och V samt brantasluttningar i N, S och SV, de senare försedda med stenvallar.I N är vallen 28 m l och är anlagd i en båge mot N men i huvudriktning Ö-V, 2 - 4 m br och 0.2 - 1 m h av stenar, 0.2 - 0.4 m st, delvis övermossade. Nära mitten är den restaurerad och lagd i kallmur. Här är aven ett ingångshål upptaget.I S är vallen 70 m l (NV-SÖ) och mestadels 4 - 6 m br (ställvis endast 1 m br) och 0.2 - 1 m h av stenar, 0.2 - 0.4 m st (upptill 0.8 m st), med spår av kallmur på uitsidan.16 m från NV änden är en 2 m br ingång. I SV är två vallar, en är18 m l (NNÖ-SSV), 1 - 4 m br och 0.2 - 0.3 m h av stenar, 0.2 - 0.4 m st, delvis övermossade. Utrasad. Den andra vallen är 38 m l (N-S), 3 - 6 m br och 0.2 - 1 m h av stenar, mestadels 0.2 - 0.4 m st (1 - 2 m st stenar och block finns också), delvis övermossad.21 m S om N änden ör en ingång? 1.5 m br.Inuti borgen är en friggebod. Intill denna vid den med x markeradeplatsen har hemmansägare Sture Nyström, Sundsmålen 1:1 påträffaten bit av en underliggare till en malsten, 45x26x7 cm st. Fyndet gjordes vid grävning på ca 30 cm dj.Fornborgen är bevuxen glest med barrträd. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l1955-1339`** — L1955:1339 · Dacke skans · Kalmar, Västervik · span 160 m · 810 chars -
discarded: `terrasser` → exterior_cue (`nedanför`)

> Fornborg 190x150 m (NV-SÖ) bestående av 1 halvkretsvall, belägenpå krönet, och SV-V-NV-N- sluttningen av ett brant berg.Halvkretsvallen är 290m l och 1-2,5 m h, från utsidan och0,3-0,7 m h fr ån insidan. Längs långa partier av vallens utsidakan en kallmurning i skalmursteknik iakttagas av 0,3-1,5 m ststenar. Bakom skalmuren finns en fyllning av 0,2-0,2-0,6 m ststenar. Ställvis är vallen utrasad och stora stensamlingarligger nedanför vallen i sluttningen. I den SSV sidan finns enport ca 2 m br. Nedanför porten bildar berget 2 naturligaterrasser och ytorna mellan dem förefaller vara väl röjda. DeN-Ö-S sidorna utgörs av naturliga branter, vilka inte ärbefästa. Beväxt med gles tallskog. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l1986-9173`** — L1986:9173 · Skåne, Lomma · span 223 m · 907 chars - settlement records
inside the extent (polygon test): Boplats `L1989:1600`; Boplatsområde `L1989:1064`

> Ringborg, vikingatid, ca 220 m i diam. Belägen inom Borgebys gamla bytomt (RAÄ-nr Borgeby 48:1) och delvis överlagrande en möjlig boplats (RAÄ-nr Borgeby 10:1). I NÖ delen är något mindre än hälften av vallen delvis synlig i terrängen. Borgens front har bestått av en träpalissad och ca 2 m framför denna en flack vallgrav, intill 6 m br och ca 1,2 m dj. Vallen har byggts ut i flera etapper över den gamla vallgraven. En ny vallgraven kom slutligen till, ca 1,75 m dj och 7 m br. Fullt utbyggd var befästningsverket ca 34 m br. 
> 
> Flera träkonstruktioner har vid undersökningar påvisats, liksom palissader med snedställt timmer och stöttor i vallens front.  Spår av en upp emot 5 m br väg som följde ringvallens insida har observerats. Spår av avancerat vikingatida ädelmetallsmide i form av bl a gjutformar och 1 skärvel har påträffats, men även äldre boplatslager tillhörande Borgeby 10:1 med flera faser.

**`l2013-1236`** — L2013:1236 · Stockholm, Stockholm · span 208 m · 860 chars

> Fornborg, ca 210x200 m (N-S), begränsat av branta bergsluttningar och stup i NV, V-SÖ samt i N och Ö av en stenvall 120 m l (Ö-V), 2-5 m br och 0,2-0,6 m h. Den består av 0,3-1,5 m st stenar och block (vanl. 0,6-1 m st). Denna stenvall har raserats ner till nuvarande läge genom paralellt löpande högre belägen väg. I Ö änden är en liten korsande mur, 15 m l (Ö-V). 2 m br och 0,3-0,5 m h bestående av 0,5-1 m st stenar. Denna mur är det ena orörda murparti av fornborgen. Det andra partiet är 50 m mot SÖ och stänger av en sluttning mot Ö. Denna mur är 60 m l (N-S) 2-3 m br och 0,5-1 m h. Den består av 0,2-1,5 m st stenar (i regel 0,5- 1 m st). Muren har antydan till S kalmur ställvis. Muren delas vid 1964 års besiktning upp i 2 delar. Något mellanrum eller någon ingång går 1981 ej att urskilja då sten rasat ned från den högre belägna vägen S om vallen.

**`l1983-118`** — L1983:118 · Södermanland, Katrineholm · span 130 m · 906 chars

> 1) Forsborg, 140x80 m, (VNV-ÖSÖ) bestående av en vall i N och en vall i Ö. I NÖ och i NV-S-SV avlöses murarna av bergsstup.Den N vallen är 65 m l och den Ö vallen är 25 m l. bägge vallarna är2-4 m br och 0.2-1 m h. Stenarna är i allmänhet 0.2-0.7 m st. Enstaka stenar  är intill 2 m st. Ställvis syns spår av kallmurning i de annars utrasade vallarna. I N vallen är 2 ingångar, den V 2 m br och den Ö helt nedrasad. I den Ö vallenär en ingång, 2 m br. Fornborgen är beväxt med barrträd, enstakalövträd samt buskar. Det inneslutna området på bergets krön ärmycket ojämnt med bergavsatser och skrevor. Fornborgens SÖ begränsning anslutes inte till terrängen eftersom berget här sluttar svagt mot Ö.Fornoborgen ligger inom:2) Gränsbetsämt område. Inom området är Sköldinge 57:1registrerat. 
> Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l1941-3311`** — L1941:3311 · Predikstolen · Uppsala, Uppsala · span 478 m · 2930 chars

> Fornborg ca 470x180-250 m st (NNV-SSÖ), funtionellt bestående aven huvudborg i N och mellersta delar och en förborg i S delen. Huvudborgen är ca 300x200 m st (NNV-SSÖ), begränsat av en ringvall. Förutom längs kortare avslitt i Ö och SSÖ, där berget stupar brant. Vallen är 0,2-1,5 m h och 2-15 m br. Högst och bredast i N-NV, där terrängen är flackast. I V är vallen i allmänhet anlagd påbergets ytterslutning. Längs hela S-SSÖ sidan har borgen en naturlig begränsning av en intill 10 m h klippbrant. I SSÖ där vallendelvis saknas är klippan som brantast. Den SÖ framstjutna klippan kallas av ortsbefolkningen för Predikstolen. I Ö där berget stupar relativt brant mot Hågaån s dalgång, saknas vall i Mellerstadelen längs en sträcka av ca 60 m, där berget bildar en valliknande rygg. Vallen består av huvudsakligen 0,1-0,7 m st stenar. Enstaka större block ingår främst i Ö delen. I ytan av vallen finns ställvis skörbrända stenar ca 0,1 m st, möjligen tillkomna genom brand av ursprunglig överbyggnad av trä. Spår av kallmur kan iaktagas i NÖ. Vallen är raserad och utfallna stenar finns främst i Voch S. I NÖ delen av vallen finns en mindre svacka, där en stig löper in i borgen. Tre gropar 1-3 m diam, 0,4-0,7 m dj finns i NÖ,NV resp SV. Två tydliga ingångar finns i N resp SV delen, med stigar som löper in i och ut med borgen. I NV resp SV finns eventuellt ytterligar två ingångar. Vallen övertväras på flera ställen av stigar. Området innanför borgvallen är starkt kuperat. Terrängen är bergigast i V och SÖ. I S och V delen av området finns våtmarker. Jämnare terräng finns i Ö och S, med mest lämpliga ytor förboplats. Enstaka skörbrända stenar kunde konstateras på en plats, markerad på fotokartan, i S delen av borgen, platsen bär spår efter arkologisk undersökning (se undersökningar och fynd). Flerastigar genomkorsar borgområdet. Ö om borgen finns ett slags passdär en gångstig löper i N-S-lig riktning. Från denna löper en stig in i SÖ delen av fornborgen, som förefaller vara den mest   ?nutida ingången. Huvudborgen skiljes från förborgen i S av en mellanliggande sänka (Ö-V) i vars botten en bäck löper ut mot Hågadalen i Ö. SV om huvudborgen, NV om förborgen är ett plant, tidigare odlat parti, vilket ursprungligen utgjot våtmark. Förborgen ärbelägen på en bergshöjd med brantaste partierna mot Ö. I SV-S-SÖlöper en raserad mur med kortare avbrott i SÖ, ca 200 m l (NV-SÖtill Ö-V till NÖ-SV), 2-5 m br och 0,2-0,5 m h, bestående av i regel 0,3-0,6 m st stenar samt enstaka större stenar och block. Berget är lätt kuperat i anslutning till krönpartiet och med våtmark i SV delen.  Fornborgen är beväxt med blandskog. Mellersta ochNV delen är belägen i Uppsala-Näs sn; den NÖ:e och S delen i Bondkyrka sn. Undrs fynd: Provundersökn 1944 av K A Gustavsson. Fynd av bl a stenkolshärd,(Se exerpt). Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l2005-5264`** — L2005:5264 · Värmland, Karlstad · span 153 m · 1850 chars

> Fornborg, 140x75 m (N-S). Området, som utgörs av krönpartiet av berget, begränsas av 3 mursträckningar samt branta stup.
> 
> Begränsningen mot N är en mursträckning, 50 m l, som löper i en båge från Ö till V. Muren (huvudriktning NÖ-SV) är 2-3 m br och från utsidan 1,5 m h, på insidan i nivå med markytan, av rundade stenar, 0,2-0,5 m st. Bitvis finns bevarade kallmurade partier. 60 m SSV om V änden av ovanstående är N änden av en mursträckning, 60 m l (huvudriktning SSÖ-NNV), 2-3 m br, av 0,5-1 m st stenar. Ligger på kanten av avsats mot V. Mycket sten är nedfallen.
> 
> Mellan den V och S muren är naturliga klipphällar, intill 3 m h, samt i N änden av den V muren, stupande berghällar, 4 m h, utefter en 15 m l sträcka.
> 
> 10 m ÖSÖ om S änden av ovanstående är V änden av mursträckning, 30m l (ÖSÖ-VNV), 2 m br och 0,5 m h av 0,2-0,5 m st stenar. Delvis övertorvad i Ö delen. 12 m V om Ö änden är en ev. ingångsöppning, 3 m br och 0,1 m dj.
> 
> I borgens VNV del är utefter en 25 m l sträcka, mellan brant stupande berghällar, talrikt med stenmassor, vilka ev. kan utgöra rasserad mursträckning.
> 
> Fornborgens Ö sida utgörs av ett ca 15 m h stup ut mot sjön Gapern. Stupet fortsätter 10 m rakt ned till en platt dybotten med ett 0,5 m tjockt sedimentationslager av lös dy. Bergsidan under vattnet är sprängd och flikig som sidan ovanför vattenytan. Block och stenar som fallit ned från bergsidan ligger på utskjutande partier.
> 
> I den lilla viken N om borgen finns i vattnet flera små pirer eller små stenfundament till bryggor, 10 m l och 3 m br, av 0,3-1,5 m st stenar. Dessa är dock, enligt ägarna till Lindås, byggda i sen tid. Sikten i vattnet var 0,5 m. (Enligt Lindåsborna, skall den första ägaren till gården, som var invandrad från Finland på 1600-talet, knuffat sin gamla häst utför stupet.)
> 
> För skiss, se inskannat bokuppslag under Referenser.

**`l1935-1375`** — L1935:1375 · Västernorrland, Sundsvall · span 168 m · 1039 chars

> Fornborg, ca 180x110 m (Ö20gr.S-V20 gr.N). Fornborgen är belägenpå ett tämligen högt berg, som stupar brant åt alla håll. I NVoch Ö är branterna förstärkta med murar. Den i NV är ca 70 m l(N-S, Ö40gr.N-V40gr.S, N-S, Ö10gr.N-V10gr.S), 2-4,5 m br och0,4-1 m h, av i huvudsak 0,3-0,7 m st stenar. Muren ärvinkelbruten ungefärligen på mitten och är delvis starkt raserad.Murrester är synliga på sluttningen nedom muren. Muren i Ö äruppdelad i två partier, 9 och 21 m l, 1-4 m br och intill 2 m h ikallmur. Starkt raserad. Muren tycks här delvis byggd intill ochNÖ om klipp- kant, vilken är intill 2 m h. Även större block, ca1 m st, ingår här i muren i dess SÖ del. Anmärkas kan här attEkdahls 4 högar "wid Nämsforsen på N sidan om landsvägen" ej kanavse nr 116 och de där borttagna, då detta inte stämmer medforsens läge. Möjligen kan de ha legat S-SÖ om Skansberget utmedgamla landsvägen i de nuvarande tallplanteringarna. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l2002-1126`** — L2002:1126 · Bäjby borg · Västmanland, Västerås · span 118 m · 1066 chars

> Fornborg, 100x85 m (ÖSÖ-VNV), bestående av dubbla ringmurar av sten, intill 5 m från varandra. Den yttre muren är 2-3 m br och 0,7-1,7 m h från utsidan. Den inre muren är 5-6 m br och 3-4,5 m h från utsidan, stenarna är 0,2-0,8 m st. Dessutom ingår i murarna stora block, 1,5-4 m st. Kallmurarna på insidan och utsidan av den inre muren och ställvis på den yttre, är ställvis synliga intill en höjd av 1,5 m över rasmassorna. Murarna är rasade både utåt och inåt.
> 
> I yttermuren är fyra ingångar i N, SÖ, SSV och V, 1-3 m br. I innermuren är två ingångar i NNÖ och SSV, 2,5 resp 4 m br. Delvis igenrasade. Från murens insida förlängs dessa ingångar mot borgens inre med en stenrad vid vardera ingångssidan, ca 3 m l och 0,6 m h. Den NNÖ ingångens stenrad avslutas med en vinkelböjd 2,5 m l stenrad mot VNV. Den SSV ingången är förstörd av skogsmaskin. 
> 
> Borgens inre är tämligen jämnt. I NNV hörnet är en (ev.) vattengrop. Borgen är totalt uthuggen på alla träd, beväxt med högt gräs. Vid senaste inv låg i övrigt på många ställen kvar grenar och ris från avverkning.

**`l1960-1441`** — L1960:1441 · Västra Götaland, Göteborg · span 135 m · 953 chars

> Fornborg, 125 x 90  (Ö-V), belägen på det branta krönpartiet av en klippig och sönderskuren bergrygg, begränsat av brant stup i Ö-S och avskuret från ryggen N härom av en tvärgående grundsänka i berget samt mera långsluttande i V.
> 
> En stenvall, 75 m l, 2-5 m br och 0,2-0,4 m h, har anslutning till stupet i Ö och svänger mot N för att löpa intill den lilla sänkan över bergryggen. Den är uppbyggd av 0,2-0,5 m stora stenar och delvis nu något övermossad och nedrasad. 
> 
> En annan stenvall, skiljd från den förra av ett litet stup mot sänkan i bergryggen, övertvärar en liten klyfta i NV och löper upp på en mot V långsluttande hällrygg för att på nytt övertvära samma klyfta och ansluta till stupets ändpunkt i S. Den är ca 50 m l, 3-6 m br och 0,3-0,6 m h, samt uppbyggd av i regel 0,2-0,8 m stora stenar. På bergryggen i V har den troligen varit ganska kraftig men är nu starkt omplockad. Borgens inre är kuperat och beväxt med glest barrskogsbestånd.

**`l1957-4873`** — L1957:4873 · Bårbyborg · Kalmar, Mörbylånga · span 171 m · 817 chars

> Fornborg, halvcirkelformad, 160x80 m (NNÖ-SSV) bestående av en halvcirkelformad vall av nu till större delen övertorvade kalkstenar med inslag av några gråstenar. Vallen är 11-13 m br och 2-3,5 m h i förhållande till utanförliggande mark och intill 2 m h från insidan. S om mitten på Ö sidan är en ingång, 2,5-3 m br, med kallmurade sidor, delvis igenmurad. I V begränsas borgen av landborgsbranten ca 20 m h. Området innanför vallarna odlas. Marken är där högst vid branten och sluttar mot ÖSÖ. 
> 
> Mårten Stenberger har gjort en mindre undersökning genom att ta upp ett 3-5 m brett schakt mitt på högsta partiet. Fynd: bysantinskt guldmynt (SHM 12723), likt dolkblad av brons (SHM 1250), fyrsidig smalmejsel av flinta (SHM 1467), spänne av brons, djurhuvudformat spänne, guldsolidens, lerkärlskärvor, mosaikpärla m m.

**`l1980-1338`** — L1980:1338 · Örebro, Örebro · span 82 m · 1037 chars

> Fornborg, 80x40 m (NNV-SSÖ), bestående av en stenvall i N-V-SSÖ.I N-Ö stupar berget mera brant intill 15 m h med i två smärreskrevor, 1-3 m br, igentäppningar med enstaka stenar, 0.2-0.7 mst. Vallen är 100 m l, 1-3.5 m br och 0.2-1.5 m h. Stenarna är0.2-1.2 m st. Rester av kallmurning intill 4 skift, högst i S.Utmed en kortare sträcka är vallen kastad utför berget. I Sdelen en ingång, 3 m br. I N är i en skreva möjligen en delvisigenrasad ingång ca 1 m br. I SV delen av borgen en stensamling,ca 3 m diam och 0.3 m h. Stenarna är 0.1-0.25 m st med mitten engrop 0.75 m i diam och 0.4 m dj.Fornborgen är beväxt med tallar, barrbuskar och lövbuskar. Skisssid 25 i inv handl.Ytan innanför vallarna är starkt kuperad med mindre flacka ytoremellan.I anslutning till och utanför ingången i SV är diffusa tendensertill lagda stenrader, ca 10-20 m l, av 0.3-1.5 m st stenar,belägen i nturligt tämligen blockrikt moränmark. Beskrivningen är inte kvalitetssäkrad. Information kan saknas, vara felaktig eller inaktuell. Se även Inventeringsbok.

**`l2008-5937`** — L2008:5937 · Östergötland, Kinda · span 113 m · 912 chars

> Fornborg, ca 115x65 m (NNV-SSÖ), begränsad i Ö och V av stup, i N av brant blockrik sluttning och i S av brant som övergår i måttlig sluttning. Kantas i N och S av vallar, med ingång i den S vallen. 
> Den N vallen är ca 30 m l (VNV-ÖSÖ), 2-4 m br och 0,3-0,6 m h av vanligen 0,3-0,7 m st stenar, enstaka 1-1,5 m st.
> Den S vallen är närmare 40 m l, vinklad Ö-V och N-S, och utgörs av två delar med mellanliggande ingång. Den V delen är 18 m l (ÖNÖ-VSV), 2-4 m br och 0,3-0,6 m h av 0,3-0,7 m st stenar, i ytterkant större stenmaterial, 1-2 m st och 1 m h. Den Ö delen är vinklad, 10 + 5 m l (Ö-V och N-S), 3-4 m br och 0,3-0,7 m h. Ingången är 1 m br och kantas i V av en 1,5 m h bergvägg. 
> Borgplatån är småkuperad med relativt plant krön. Murarna är neddragna från krönet. Innanför den vinklade delen är en något smågropig yta, 8x4 m - skada av grävling?
> På en lantmäterikarta från 1689 kallas berget Murrberget.

**`l1975-1347`** — L1975:1347 · Hallbrosslott · Gotland, Gotland · span 102 m · 1098 chars

> Fornborg, 85x80 m (VNV-ÖSÖ), begränsad i NV-N-Ö-ÖSÖ av delvis my cket branta sluttningar. I NNV-V-S-Ö är en sammanhängande stenval l (heldragen gränslinje), ca 210 m l, 1,5-7 m br (vanligen 3-5 m) och 0,2-2 m h (vanligen 1-1,5 m). Vallarna är mäktigast i V-S-Sö , lägst och smalats i NNV-NV och Ö-SÖ. Ställvis bevarad kallmurni ng med intill 1 m st kalkhällar. I NÖ och N finns i klintkanten s tällvis låga kantställda kalkhällar, möjligen rester av tidigare hägnad (grönprickade). Huvudingångar i SV, 3-4 m br och i SÖ-ÖSÖ, 3 m br. SÖ om den förra och NÖ om den senare finns utbyggnader a v muren, intill 10 m l. SV om den senare är en spetsig utbyggnad av muren. Stigar leder in till en ca 1 m br öppning i V samt upp till klintkanten i NNV och NNÖ, de senare troligen sentida. Inom borgområdet kan i V,N och Ö-SÖ urskiljas 2-3 mer eller mindre jäm na gräsbeväxta ytor åtskilda av kalkbergrester och hällar. Från e n av fyra raukliknande bildningar i centrum utgår en ca 15 m l, 2 m br och 0,5 m h vall av sten och jord i riktning mot SSV. Borgo mrådet väl vårdat och beväxt med enstaka barrträd.

**`l1951-5045`** — L1951:5045 · Gävleborg, Nordanstig · span 187 m · 1702 chars

> Fornborg, 90x75 m st (Ö-V). Begränsas av en huvudmur åt Ö samt några mindre spärrmurar belägna i mindre bergsklyftor.
> Huvudmur åt Ö, ca 65 m l (N-S), ca 3 m br (smalnar av åt ändarna), och ca 1,5 m h. Sluttar inåt. Bestående av skärv- och klumpstenar 0,2-1m st, en del av bottenstenarna är ca 1,4 m st. I N delen av muren finns en bergklack, ca 3 m l.
> Spärrmur i klyfta i N, med ingång, ca 20 m l (NV-SÖ), 1,5-3 m br och ca 1,5 m h av 0,2-0,6 m st stenar. Ingången är 2 m och belägen 3,5 m från murens SÖ kant. 15 m ÖSÖ om denna är rest av en annan spärrmur ca 3 m l, 0,8 m br och 0,3 m h, av 0,2-0,3 m st stenar. Spärrmur i klyfta i SSV, 9 m l, 1,25 m br och ca 0,5 m h av 0,5-1 m st, övermossade stenar. Muren är delvis sönderrasad. Ytterligare en spärrmur i smal klyfta i V 2 m l (N-S), 1 m br och 0,2-0,3 m h av 0,2-0,4 m st stenar. Muren är raserad. I NÖ delen av borgen är en 3 m br bergklack, nu utan murrester. Borgområdet är närmast plant, sluttar obetydligt åt V. Bevuxet med enstaka tallar.
> Ca 20 m Ö om borgen är en grotta, 12 m l, 0,7-1,8 m br och 3-6 m h, som bildats genom att nedfallande block lagt sig som tak i övre delen av en förkastningsspricka. Ingång i N. Grottan smalnar åt S. I mitten en öppning uppåt. På Ö väggen i N delen nära ingången, 1,25 m över markytan, finns en hällristningsliknande bildning, närmast formad som en fabula, 0,33 m l och 6,1 m br. Begränsas av en ränna 2-3 mm br och 2-3 mm dj. Botten är obetydligt lägre än stenytan för övrigt. Vetter åt S. Ytan innanför den ristningslikn. konturlinjen kan vara en naturlig vittringsyta.
> N delen av den Ö muren har mycket skörbränd sten. Även hällarna runt N partiet av denna mur är skörbränt, ev. plats för vårdkase.

### 6.3 What the audit shows

**`husgrund*` and `husterrass*`/`husgrundsterrass` work.** Read the strong-tier samples: they
are unambiguous — *"Innanför muren är 88 husgrunder"*, *"Inom borgen finns ca 50 husgrunder"*,
*"husgrundsterrass, rektangulär, 11x7 m (Ö-V)"*. Of 46 strong-tier forts, 3 were removed as
modern and the remaining 43 read as genuine claims about the enclosure interior. Independently,
7 of them also return a KMR `Husgrund, förhistorisk/medeltida` record inside their own extent
polygon. This tier is safe to use.

**But a third of it hedges.** 16 of the 43 strong-clean forts carry only hedged claims — *"Detta
kan möjligen vara husgrunder"*, *"1 inhägnad (möjlig husgrund)"*, *"husgrundsliknande lämning"*.
These are flagged `hedged` per hit in the JSON and marked in the samples above. They are not
wrong to count — a surveyor's *möjlig husgrund* is still the register saying it saw something
building-shaped inside the wall — but a reconstruction built on one should say so in the methods
panel rather than drawing a confident longhouse.

**`stensträng*` is a near-total false positive and should be dropped.** In a fornborg
description *stensträng* almost always describes **the rampart itself** — *"Ställvis har vallen
endast stensträngskaraktär"*, *"en otydlig stensträngsliknande mur"*, *"två svaga stenvallar
(eller stensträngar)"* — or an outlying field boundary 300 m away. It contributed 78 counted
hits and, on inspection of the samples above, essentially none of them are interior buildings.

**`bebygg*` is worse: it usually means the fort has been *destroyed* by modern building.** *"nu
är så gott som helt bebyggd med villatomter"*, *"Inom fornborgen är bebyggelse"*, *"i borgen var
uppförd en sommarstuga"*. As an interior-building indicator it is not merely noisy, it is
frequently inverted — a positive hit is evidence the interior is a lawn.

**`terrass*` is genuinely mixed and cannot be used bare.** The same string covers a house
terrace (true positive), a terraced *section of the rampart* (*"den yttre, terrassformade delen
är 4-10 m br"*), a terraced footpath, a natural rock shelf and a 20th-century garden terrace.
Only the compound forms — `husterrass`, `husgrundsterrass` — are reliable, and those are already
in the strong tier.

**The decisive check is Uppsala.** Uppsala county returns 5 broad-rule hits and **zero**
strong-tier hits. Every one of those 5 is `stensträng` describing the wall, or a terraced wall
section. If the broad rule were sound, Uppland — the one province with an independent published
figure of 17–21 % — would be its best case. It is instead the province where the rule is
provably wrong in every instance.

**Verdict: the keyword rule as briefed is too noisy to decide on. The strong-tier subset is
not.** Use **4.1 %** (54/1 304); treat **11.5 %** as an upper bound that is known to contain
mostly rampart descriptions.

**What the misses show is a positive finding, not a gap.** Read §6.2: the register's habitual
statement about a fort interior is that it is *bare and rough*. Counting whole descriptions —
crudely, since the match is not scoped to the interior sentence:

| Interior-terrain vocabulary | Forts | Rate |
|---|---:|---:|
| `berg i dagen` / `hällmark` / `berghäll` | 117 | 9.0 % |
| `ojämn` / `kuperad` / `småkuperad` / `oländig` | 185 | 14.2 % |
| `blockig` / `blockrik` / `stenbunden` | 59 | 4.5 % |
| `avplanad` / `plan yta` / `platå` | 197 | 15.1 % |
| `våtmark` / `sankmark` / `kärr` / `myr` | 35 | 2.7 % |
| **any of the above** | **420** | **32.2 %** |

32.2 % of forts describe their interior in terrain terms — *berg i dagen*, *småkuperad*,
*blockrik*, *avplanad yta*, *våtmark* — against 4.1 % that describe a building in it. The
register is not silent about fort interiors. It is consistently telling us they are rock.

**Known weaknesses of this measurement, stated plainly:**

- Measure (c) systematically under-detects. Ismantorp's 88 house foundations return **zero**
  settlement records, because KMR keeps them inside the fort's own record. Where a fort's
  interior buildings are well known, they are least likely to be separately registered.
- Measure (c) also has false positives of its own: `l1986-9173` (Borgeby, Skåne) is a
  **Viking-age** ringfort overlying a bytomt, and `l1947-4073` (Jämtland) returns a
  Boplatsområde in a fort whose description mentions a modern house on the crown. At 18 forts
  total, individual cases matter.
- Negation and exterior detection are sentence-scoped and regex-based. They will miss a negation
  carried across a sentence boundary.
- The national extract used here (2026-09-03) is newer than the one `registry.json` was built
  from (2026-08-22). All 1 304 registry forts still resolve **by uuid**, so no fort was matched
  by the weaker lämningsnummer fallback and the two files are consistent.

---

## 7. Recommendation

**Make the national default interior "cleared surfaces" — bare measured terrain — and make
"settlement" a per-fort opt-in driven by the strong-tier evidence, not a national state.**

The reasoning, in order of weight:

1. **4.1 % is the rate, and the confident core is 2.1 %.** Drawing longhouses inside every fort
   would be wrong for about 96 % of them on the register's own evidence, and the register's
   evidence is itself an over-count relative to what is *visible*, since §6.2 shows most
   interiors are recorded as bare rock. This is the same error §6.A.1 already refuses to make
   about ramparts — rendering all 1 304 as standing Migration Period walls — applied one level
   in.
2. **The finding is consistent with the Mälardalen survey rather than contradicting it.** ~17–21
   % of a ~17 % Middle Iron Age subset predicts ~3 % nationally; we measured 4.1 %. There is no
   national signal here that the survey missed.
3. **There is a real typology branch, and it is narrow.** Öland at 23.8 % and Gotland at 9.4 %
   against a mainland 3.4 % justify treating the limestone ringforts as their own case — but
   only 13 of 54 positives are there, so this is a branch for 106 forts, not a reason to change
   the default for the other 1 198.
4. **The evidence that does exist is per-fort and citable.** The 43 strong-tier forts name their
   own buildings in KMR text — counts, dimensions, sometimes layout. That is enough to draw
   those interiors *from the record* rather than from an archetype, which is exactly the
   standard §H demands of the farmstead archetype and §5 demands of everything else. A national
   default of "settlement" would instead be archetype-H inference applied 1 304 times over — the
   weakest evidence in the taxonomy, multiplied.
5. **Broborg's own answer is unchanged and §7.5 already has it right.** The interior occupation
   there is dated (AD 432–542) but the *stone* is contested, which is why §7.5 makes it a
   two-state selector defaulting to "cleared surfaces". This survey says: that is also the right
   default nationally, and for a stronger reason — nationally there usually is no contested
   stone at all.

**Concretely, if this is adopted:**

- Default interior state: **`cleared`** for every fort. Draw the measured DEM surface and the
  SGU soil class, with stone-picked patches only where KMR places them; add nothing.
- Per-fort **`settlement`** state offered only where `refinedInteriorEvidence` is true in the
  companion JSON (54 forts), with the matched KMR sentence shown in the methods panel as the
  citation. On Öland and Gotland that sentence often carries a house *count* and *dimensions*;
  prefer them over archetype defaults.
- Do **not** wire `stensträng*`, `bebygg*` or bare `terrass*` into any interior rule. In a
  fornborg description the first two mean "the rampart" and "modern houses have destroyed this".
- Keep the §7.5 two-state selector for Broborg exactly as specified. Nothing here changes it.

**What would change this recommendation:** a fort-confidence filter. Every rate here is over
*all registered fornborgar*. §11 decision 6 says `fortConfidence` is implemented but its
distribution across the 1 304 has not been looked at. Re-running this measurement over the
high-confidence subset alone is the obvious next step, and it is cheap — the companion JSON
already carries every fort's slug, so it is a join, not another 2.3 GB download. If
interior-building evidence turns out to concentrate in high-confidence forts the way the
Mälardalen figure implies, the default could reasonably become confidence-dependent rather than
uniform.

