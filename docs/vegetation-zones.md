# Regional vegetation at ~500 CE — the Phase-9d research base

**Status: research, 2026-08-22. No code changes in this document — it exists to
decide, before any code is written, which land-cover parameters may vary by region,
which must not, and what evidence either choice stands on.** The companion design
document for the far-field rendering work is `docs/far-field-vegetation.md`.

Facts follow PLAN.md's grading convention. **[measured 2026-08-22]** marks numbers
computed in this session from data fetched in this session (Neotoma palaeoecology
API, SGU Jordarter OGC API, Crossref, the committed registry and bundles).
**[reported]** marks anything recalled or taken from secondary sources whose full
text could not be fetched. Bibliographic metadata (authors, year, journal, DOI) that
was confirmed against the live Crossref API is marked **[metadata measured]** — the
*content* attributed to those papers remains [reported] unless stated otherwise.

**Network status for this session [measured 2026-08-22]:** reachable —
`api.neotomadb.org` (the decisive one), `api.crossref.org`, `doi.org`,
`pub.epsilon.slu.se`, `api.sgu.se`; opened later the same day on request —
`doi.pangaea.de`, `essd.copernicus.org`, and finally `download.pangaea.de`
(PANGAEA's file server, a separate hostname from the landing pages — the third
ask, and the one that held the actual data). Still blocked but no longer
material: `www.diva-portal.org`, `europepmc.org`, `www.pangaea.de`,
`www.eea.europa.eu`. With the file server open, the quantified-openness dataset
was fetched and §3 carries measured numbers — and a measured coverage gap.

---

## 0. Summary of recommendations

1. **Zone framework (§1):** three zones cover all 1,304 registry sites — nemoral
   (22 sites), boreonemoral (1,261), southern boreal (21) — plus an **alvar
   overlay** that is a per-site soil condition, not a zone. Assignment is a pure
   function of registry latitude, county, and DEM elevation; no new dataset.
2. **Species mix per zone (§2, §4):** vary it. The pollen evidence is strong,
   regional, and partly [measured] in this session. The headline: **at 500 CE
   Norway spruce had not yet colonized southern Sweden** — a "conifer forest" of
   120 spruce-form stems/ha south of the spruce front is a confident anachronism.
3. **Openness per zone (§3):** the quantified (REVEALS-type) dataset is now
   **fetched and measured** — Iron Age open-land is ~39 % across the nemoral
   cells, ~33 % across the covered boreonemoral cells, ~7 % southern boreal.
   But **the cells holding 913 of 1,304 registry sites (70 %) — the whole
   Mälaren valley, Gotland, Östergötland — are absent from the product
   entirely**, Broborg's included, and within-zone spread (11–59 % in
   boreonemoral) exceeds the between-zone differences. Recommendation
   unchanged in substance, upgraded in disclosure: engine rules and radii stay
   national; each site whose 1° cell has an estimate gets that **cell's own
   OL ± SE quoted in its legend calibration paragraph** as the regional anchor
   (report, never force-fit — PLAN §4.7); uncovered cells keep the honest
   "no quantified estimate covers this cell".
4. **Alvar (§5):** fix it. All four island pilot sites sit on SGU classes the
   current soil table does not map, so today's rules would render **spruce forest
   on Stora Alvaret** [measured]. The fix needs no new dataset — SGU already
   returns the signature classes.
5. **Procedure (§6):** one deterministic assignment rule for all 1,304 sites, with
   Broborg as the fixed control (its zone must resolve to boreonemoral-east and its
   output must not change).

---

## 1. Zone framework

### 1.1 The framework and its sources

Swedish vegetation geography conventionally divides the country into a **nemoral**
zone (temperate broadleaf; Skåne, Blekinge, coastal Halland and a coastal strip of
Bohuslän), a **boreonemoral** (hemiboreal) zone (mixed; north to *Limes
Norrlandicus*, roughly the Dalälven valley at the Baltic coast, dipping south-west
with altitude), and the **boreal** zones (southern/middle/northern), with the
subalpine birch belt and alpine zone in the fjäll. Öland and Gotland are
conventionally placed in the boreonemoral zone despite their latitude-and-climate
affinity with the south, with their alvar areas treated as an edaphic
(soil-determined) exception. The canonical statements of this scheme are Ahti,
Hämet-Ahti & Jalas (1968) for the Northwest-European zonation and Sjörs (1963;
1999) for Sweden specifically. **[reported — none of these could be fetched this
session; the boundary descriptions above are recall and must not be treated as
surveyed lines]**

Two finer frameworks were considered and rejected for this phase:

- **Naturgeografiska regioner** (Nordic Council, 76 regions): finer than we can
  parameterize — we have zone-level evidence at best (§2) — and it needs a region
  polygon layer we do not fetch. Rejected on both grounds.
- **EEA biogeographical regions**: host blocked [measured], and coarser than the
  Swedish scheme in the one place it matters (it has no boreonemoral).

### 1.2 The operational rule (what the pipeline can actually compute)

The registry carries `centerE/centerN` (EPSG:3006) and `county` for every site; the
pipeline computes crown elevation from the DEM it already reads. That is enough for
a deterministic assignment with no new dataset:

```
lat        = inverse-project(centerE, centerN)            # pyproj, EPSG:3006 → 4326
island     = county == "Gotland" or (county == "Kalmar" and lon > 16.35°E)  # Öland
eff_lat    = lat + site_elevation_m / 130                 # altitude-for-latitude exchange
zone       = boreonemoral        if island                # convention, §1.1
           = nemoral             if eff_lat < 57.0
           = boreonemoral        if eff_lat < 60.7
           = s_boreal            otherwise                # registry max is 63.2°N
alvar_flag = per-site, from the SGU soils extract the pipeline already fetches (§5)
```

Three honesty notes on this rule, stated once here and repeated in the methods
panel when it ships:

- **The thresholds are a modelling choice, not surveyed boundaries.** 57.0°N and
  60.7°N are round-number stand-ins for zone limits whose literature sources could
  not be fetched (§1.1). What the §2 data can and cannot check: the
  nemoral/boreonemoral contrast (grasses, hazel, beech, cereals) and the
  boreonemoral/southern-boreal contrast are both real in the measured columns and
  land on the expected sides of these thresholds — but the zone columns of §2.2
  are computed *given* this rule, so they confirm that the zones differ, not
  where exactly they divide, and with pollen sites spaced ~0.3–0.5° apart no
  line can be placed precisely from them. (The one genuinely independent
  measured line, the 500 CE spruce front at ~59.7°N lowland, deliberately does
  **not** coincide with the 60.7°N zone boundary — which is why it is carried as
  its own `spruce_present` parameter in §4 rather than folded into the zone.)
  Nothing in the model needs the lines more precise: every parameter that varies
  by zone changes gradually in reality, so a site within ~50 km of a threshold
  is ambiguous in nature, not just in the rule.
- **The altitude term** (130 m ≈ 1° latitude) is the conventional order of
  magnitude for Scandinavian growing-season lapse **[reported]**. Over the
  registry it is nearly inert — the census below moves single-digit numbers of
  inland-highland sites — but it is what keeps a 300 m Småland highland site from
  being classified by its latitude alone. The pollen data neither confirms nor
  refutes it cleanly: Kansjön (57.6°N, 299 m) carries 13.5 % spruce — but from a
  single in-window sample — while Lake Avegöl at 292 m and the same latitude
  carries 0.3 %, so the 500 CE highland front was patchy (§2.4) and the term
  stands on the [reported] convention, kept because it is small, directionally
  right, and cheap to compute from data we have.
- **The island carve-out** implements the §1.1 convention. It moves 20 sites
  (southern Öland + one southernmost Gotland site) that a pure latitude rule would
  call nemoral. No pollen core in our window exists on either island to check it
  (§2.5), so it stands on the literature convention alone [reported] — and on the
  fact that for these 130 island sites the alvar overlay (§5), not the zone, does
  the real work.

### 1.3 Census over the registry [measured 2026-08-22]

Applying the rule (latitude + carve-out; altitude term inert at census time because
the registry itself carries no elevation — the pipeline applies it from the DEM at
build time) to all 1,304 registry entries:

| Zone | Sites | Counties (top) |
|---|---|---|
| nemoral | **22** | Skåne 5, Blekinge 8, Halland 5, Kronoberg 2, Kalmar-mainland 2 |
| boreonemoral | **1,261** | Södermanland 242, Stockholm 240, V. Götaland 223, Östergötland 150, Gotland 85, Kalmar 81, Uppsala 79 |
| southern boreal | **21** | Västernorrland 10, Gävleborg 10, Jämtland 1 |

- Registry latitude span: **55.376°N – 63.170°N** (L1986:8238, Skåne →
  L1947:4073, Jämtland). No site reaches the middle boreal zone, the subalpine
  birch belt, or the alpine zone — **three zones cover everything**, and the two
  Norrland-facing rows are thin.
- Island sites (alvar-overlay candidates): **45 on Öland, 85 on Gotland** — 130
  sites, 10 % of the registry.
- **Broborg resolves to boreonemoral** (59.756°N), as it must: the zone whose
  parameters are the current calibrated ones. The control invariant (§6, Checks)
  is that the boreonemoral parameter set *is* today's parameter set, so Broborg's
  output cannot change.
- Pilot coverage [measured]: the 27 pilot sites land 3 nemoral / 22 boreonemoral
  (5 of them island sites — the four alvar sites of §5 plus Gråborg) / 2 southern
  boreal — every zone and the overlay are exercised by sites we have already
  built and can rebuild.

## 2. What the pollen actually shows at ~500 CE [measured 2026-08-22]

### 2.1 Method

Everything in this section was computed in this session from the open **Neotoma
Paleoecology Database** API (which now serves the European Pollen Database's
Swedish holdings):

- Query: all pollen datasets with geopolitical unit Sweden — **104 datasets**.
- Window: samples dated **300–700 CE** (1,250–1,650 cal BP; target 1,450 cal BP =
  500 CE) on each dataset's calibrated chronology. One site (Kassjön) carries only
  a radiocarbon chronology and was windowed at 1,350–1,750 ¹⁴C BP instead
  (≈ the same calendar window on IntCal-family curves [reported]); it is flagged
  in Appendix A.
- **62 datasets** cover the window; **57** yielded at least one sample with ≥ 100
  terrestrial pollen grains; merging same-site datasets leaves **55 sites, 237
  samples**. Scripts and raw responses are in the session scratchpad; every
  dataset's ID and DOI is in Appendix A, so the pull is reproducible from the
  public API.
- Per sample, each taxon was expressed as a percentage of the **terrestrial pollen
  sum** (Neotoma ecological groups TRSH — trees and shrubs — plus UPHE — upland
  herbs); percentages were averaged per site, then per zone (each site weighted
  equally). Taxa harmonized to genus/family (suffix "-type", "undiff." stripped;
  cereal types pooled as Cerealia).

**What these numbers are and are not.** They are pollen proportions, not
vegetation proportions. Pinus, Betula and Alnus over-produce and over-disperse
pollen; Tilia and most herbs under-produce; a raw 25 % Betula does not mean a
quarter of the landscape was birch. Correcting for that is precisely the REVEALS
problem (§3). Presence, rank order and *gradients* between zones are robust to
this bias; absolute percentages are not, and none of them may be pasted into a
land-cover parameter as if they were cover fractions.

### 2.2 The zone table

Site-mean percentages of the terrestrial sum, averaged per zone (zone assignment
by the §1.2 rule on each pollen site's latitude/altitude). Full table with medians
and all taxa: Appendix B.

| % of terrestrial pollen | nemoral (13 sites, 69 samples) | boreonemoral (23, 105) | s. boreal (6, 22) | m. boreal (2, 14) | n. boreal/subalpine (11, 27) |
|---|---|---|---|---|---|
| **Picea** (spruce) | 0.1 | 2.0 (median 0.1) | **15.6** | 14.1 | 5.9 |
| **Pinus** (pine) | 6.8 | 12.8 | **40.8** | 34.6 | 34.7 |
| **Betula** (birch) | 25.2 | 35.9 | 29.5 | 28.1 | **44.7** |
| **Alnus** (alder) | 14.1 | 14.0 | 6.4 | 11.0 | 2.0 |
| **Quercus** (oak) | 9.8 | 9.7 | 1.6 | 0.0 | 0.2 |
| **Corylus** (hazel) | **13.6** | 6.9 | 1.2 | 0.5 | 0.4 |
| Tilia + Ulmus + Fraxinus | 3.0 | 2.6 | 0.5 | 0.4 | 0.0 |
| **Fagus** (beech) | 3.1 | 2.0 | 0.1 | 0.0 | 0.0 |
| Carpinus (hornbeam) | 1.0 | 0.4 | 0.1 | 0.1 | 0.0 |
| Juniperus | 0.2 | 0.4 | 0.3 | 0.1 | 1.5 |
| Poaceae (grasses) | **9.1** | 3.8 | 1.2 | 1.8 | 1.8 |
| Cyperaceae (sedges) | 2.6 | 1.0 | 0.7 | 6.7 | 3.4 |
| Calluna (heather) | 3.6 | 4.0 | 0.2 | 0.0 | 0.4 |
| Cerealia (cereals) | 0.5 | 0.1 | 0.0 | 0.0 | 0.0 |
| Plantago + Artemisia + Rumex | 4.0 | 0.7 | 0.2 | 0.0 | 0.2 |
| **Arboreal pollen (AP)** | 81.6 (median 92.0, min 38.8) | 92.3 (median 95.0, min 64.2) | 97.6 | 89.9 | 93.0 |

The two boreal-and-north columns are shown for completeness; no fornborg reaches
them (§1.3). The rest of this document uses only the first three.

### 2.3 What the table says, zone by zone

**Nemoral (Skåne/Blekinge/Halland lowlands).** A broadleaf landscape with a heavy
human fingerprint. Birch–alder–hazel–oak dominate the tree pollen; lime, elm, ash
and hornbeam are all present; **beech is established but nowhere near its later
dominance** (site range 0.9–9.5 %; its great expansion is later Iron Age–medieval,
consistent with Bradshaw & Lindbladh 2005 [metadata measured; content reported]).
Grasses at 9 %, cereals at 0.5 % mean, and the disturbance herbs (Plantago,
Artemisia, Rumex) at 4 % are the strongest agrarian signal in the country. The
within-zone spread is the real finding: the five lakes of the Ystad agrarian
district (Bjäresjösjön, Bjärsjöholmssjön, Bussjösjön, Fårarps Mosse,
Krageholmssjön — Berglund's Ystad-project area [reported]) run **AP 39–78 %**
with cereals to 2.6 %, while the zone's interior sites sit at AP 91–98 %. At
500 CE the fully opened agrarian plain existed *in districts*, not as a
zone-wide condition.

**Boreonemoral (where 1,261 of 1,304 fornborgar stand).** Birch 36 %, pine 13 %,
alder 14 %, oak 10 %, hazel 7 %, the nemoral broadleaves (Tilia/Ulmus/Fraxinus)
present at 2.6 % — the classic mixed zone. **Spruce: median 0.1 %.** The zone mean
of 2.0 % is carried entirely by its north-eastern and high-interior sites (§2.4).
Beech and hornbeam trail off to trace values away from the south-west. Cereal
pollen is present but thin (0.1 %); openness indicators exist around settlement
(Rogberga in the Småland settlement district: AP 64 %) against a ~95 % AP
interior. This is the qualitative picture the Phase-7 engine already encodes —
opening concentrated around evidence, forest on the till between — now with
measured regional pollen behind it.

**Southern boreal (the 21 Norrland-coast sites).** A genuinely different forest:
pine 41 %, birch 30 %, **spruce 15.6 %** — spruce is a stand-former here at
500 CE — while oak, hazel, lime and the agrarian herbs fall to trace values.
AP ≥ 96 % at every site. A fornborg landscape here is coniferous, closed, and
nearly free of the agrarian mosaic; rendering it with Uppland's broadleaf-heavy,
evidence-opened parameters would be wrong in the opposite direction from the
alvar.

### 2.4 The spruce front — the sharpest regional fact [measured 2026-08-22]

Per-site Picea percentages at 500 CE split cleanly:

- **≥ 10 %** (established stands): every site north of 59.7°N in the lowlands
  (Ljustjärnen 13.4 % at 59.76°N, Lilla Gloppsjön 18.8 %, the Dalarna/Gästrikland
  sites 13–19 %, the mid-Norrland sites 21–27 %) — plus, further south, only
  scattered points of the elevated south-Swedish interior (Kansjön 13.5 % at
  57.6°N/299 m — one sample — and Skallskog 11.0 % at 57.5°N/219 m, against
  near-zero at neighbouring highland sites: the front was patchy) and eastern
  Östergötland (Mabo Moss 11.4 %).
- **≤ 1 %** (absent as a forest tree): every lowland site south and west of that
  — all of Skåne, Halland, western Småland, Blekinge; Västergötland's Lake
  Flarken (4.6 %) and Östergötland's Dags Mosse (2.9 %) sit in the approach zone.

This matches the published colonization history — spruce spread south-westward
through the Holocene and reached south-central Sweden only in the late Iron Age /
medieval period (Giesecke & Bennett 2004 [metadata measured; content reported]) —
but the split above is measured from the fetched data, not recalled. Consequences
for the model, spelled out in §4: Broborg's region (boreonemoral-east) had spruce
at 500 CE and its current conifer class is defensible; **Västra Götaland's 223
forts, and everything south-west of the front, did not** — their rocky-ground
conifer class must read as *pine*, and any future per-species rendering must not
put spruce there.

### 2.5 Where the pollen record is silent [measured absences, 2026-08-22]

Documented gaps, which are results in their own right:

1. **No Öland or Gotland core in the window.** Neotoma's Swedish holdings contain
   no pollen site on either island with samples dated 300–700 CE. The alvar case
   (§5) therefore rests on soil data (measured) and literature (reported), not on
   assemblages we computed.
2. **No Mälaren-valley core in the window.** Nothing between 58.6°N and 59.7°N in
   the eastern lowlands — the region holding Broborg and ~600 forts. PLAN §2.5's
   citations (Karlsson 1999; the Långhundraleden thesis) remain the local
   anchors [reported]; the nearest measured sites are Mabo Moss (Östergötland)
   and the Bergslagen lakes, which bracket the region from south and north-west.
   The boreonemoral zone column is real but its site list tilts south-west; the
   doc says so rather than pretending the column is Uppland.
3. **Thin northern rows.** Southern boreal = 6 sites, and the two northernmost
   zones (no forts) are 2 and 11. Zone means on single-digit site counts carry
   the uncertainty single digits imply.

## 3. Openness per zone — the crux

**The question:** is there a quantified, REVEALS-type openness estimate for Iron
Age Sweden, per region, that per-zone calibration could rest on?

**What exists [metadata measured 2026-08-22; content [reported] except where a
bullet states otherwise]:**

- The REVEALS method itself: Sugita (2007), *The Holocene* 17,
  doi:10.1177/0959683607075837, with the standard European PPE set of Mazier
  et al. (2012), doi:10.1016/j.revpalbo.2012.07.017.
- **Trondman et al. (2015)**, *Global Change Biology* 21:676–697,
  doi:10.1111/gcb.12737 — gridded (1°) REVEALS reconstructions of open-land vs
  forest cover for north-central Europe including Sweden, for *selected* Holocene
  time windows. **None of them covers the Iron Age [measured 2026-08-22]**: the
  first-generation archive (Gaillard 2019, doi:10.1594/PANGAEA.897303, metadata
  fetched after the host was opened) holds five windows between 6 ka BP and
  present, none containing 1,450 BP.
- **Githumbi et al. (2022)**, *Earth System Science Data* 14:1581–1619,
  doi:10.5194/essd-14-1581-2022 — the successor dataset (archive: Fyfe et al.
  2021, doi:10.1594/PANGAEA.937075, CC-BY-4.0). After the three hosts involved
  were opened on request — `essd.copernicus.org`, `doi.pangaea.de`, and finally
  `download.pangaea.de`, the file server — the paper, the metadata **and the
  data were all fetched [measured 2026-08-22]**: REVEALS estimates for Europe
  at 1°×1° in 25 consecutive Holocene time windows, one of which is
  **1,200–1,700 cal BP = 250–750 CE** — squarely our window (file `TW5`;
  ordering verified against the Skåne cell, where the modern window carries
  11 % spruce and 4.6 % cereals against the Iron Age window's 0.1 % and 1.1 %) —
  with three land-cover types: open land (OL), evergreen trees (ET),
  summer-green trees (ST).
- **Hultberg et al.**, *Vegetation History and Archaeobotany* 24:253–266,
  doi:10.1007/s00334-014-0469-8 — LRA/REVEALS openness applied in southern
  Sweden. Note: this is almost certainly the paper PLAN §2.5 cites as "Hultberg
  et al. (2019)" with the 90–97 % agrarian-Scania openness figure; Crossref
  returns no 2019 Hultberg VHA paper. The figure itself stays [reported].

### 3.1 The measured answer [measured 2026-08-22]

Method: every 1° cell containing at least one registry site was selected (41
cells), assigned the majority §1.2 zone of its sites, and read out of the
1,200–1,700 BP means and standard-errors files. Two results, equally important.

**First, the coverage gap.** 25 of the 41 cells — holding **913 of 1,304
registry sites (70 %)** — are **absent from the LandClimII product entirely**,
in every one of its 25 time windows, not just ours: no suitable pollen record
existed to feed REVEALS there. The absences are exactly where the forts are
densest: the Mälaren valley (the cells around 59.5°N/16–18°E alone hold 477
sites, Broborg's cell among them), Östergötland, Gotland, inland Västergötland.
This is the same east-coast silence the Neotoma pull hit (§2.5) seen from the
other side, and it means **no quantified openness estimate exists for the
region holding most Swedish fornborgar** — a documented negative, not a
fetch failure.

**Second, where cells are covered** (16 cells, 391 sites):

| Zone (covered cells only) | Cells | Registry sites in them | Open land, mean | OL range across cells | mean SE | Evergreen trees | Summer-green trees |
|---|---|---|---|---|---|---|---|
| nemoral | 5 | 20 | **39.3 %** | 14.5–50.1 % | ±12.0 | 5.5 % | 55.2 % |
| boreonemoral | 9 | 366 | **32.8 %** | 10.7–58.8 % | ±9.4 | 28.6 % | 38.6 % |
| southern boreal | 2 | 5 | **6.5 %** | 4.7–8.2 % | ±0.9 | 72.0 % | 21.5 % |

Cross-checks, both passed: REVEALS Picea across these zones runs 0.1 % / 10.1 %
/ 41.2 % — the same front §2.4 measured independently from raw assemblages —
and the correction's size vindicates §2.1's warning: the nemoral zone's raw
pollen is 92 % AP (median) yet its REVEALS openness is ~40 %; raw ratios
understate openness by a factor of five here, which is why they were never
allowed to stand in as numbers.

### 3.2 What follows for the model

1. **Raw pollen ratios stay banned as calibration numbers** — now demonstrated
   by the data rather than argued (§3.1).
2. **Engine rules and radii stay national.** Within-zone spread across covered
   cells (10.7–58.8 % in boreonemoral) is larger than the between-zone
   differences, the per-cell SEs run to ±25, and a 100×100 km cell mean is the
   wrong scale to force onto a 4×4 km fort context that the evidence rules
   already open locally. Fitting radii per zone to these means would be
   precision theatre.
3. **The upgrade that is real: per-cell disclosure.** The pipeline gains the
   TW5 OL ± SE lookup (the two CSVs, ~0.2 MB each, committed with CC-BY-4.0
   attribution in `DATA-LICENSES.md`). A site whose cell is covered gets one
   sentence in its legend calibration paragraph — *"the REVEALS reconstruction
   for this site's 100 km grid cell estimates N ± SE % open land in 250–750
   CE (Githumbi et al. 2022); the model's context fraction is M %"* — reported,
   never fitted (PLAN §4.7). A site in an absent cell keeps the honest line
   that no quantified estimate covers it. Broborg's methods panel is unchanged
   in substance: its cell is one of the absent ones, so the §2.5-era statement
   "no quantified openness figure for Iron Age Uppland" is now *measured*, not
   just unfound. One concrete gain for the alvar pair: Eketorp and Ismantorp
   share the covered cell at 16.5°E/56.5°N — **43.4 ± 7.1 % open land** — the
   first quantified regional anchor behind the open-alvar rendering (§5).

## 4. Species composition per zone — the parameter sets

What §2 supports varying now, within the three vegetation types the app renders
(conifer / broadleaf / reeds), and what it records for the finer tree models we
intend to add later. Densities (stems/ha) deliberately stay at their current
values everywhere — no regional stem-density evidence was found, and inventing a
gradient would be exactly the failure mode this document exists to prevent.

| Parameter | nemoral | boreonemoral (control: Broborg unchanged) | s. boreal | alvar overlay (§5) |
|---|---|---|---|---|
| Broadleaf-forest class identity | broadleaf (oak–hazel–birch–alder; beech present) | broadleaf (as today) | **conifer-dominated**: till forest here is pine–spruce–birch; render the class with conifer forms at the same density | unchanged where it occurs |
| Conifer-forest class identity | **pine, no spruce** (§2.4) | pine + spruce east/north of the front; pine-only south-west of it | pine + spruce | **replaced by alvar class** on the flagged ground |
| Wooded-pasture / reeds / fen classes | unchanged | unchanged | unchanged | unchanged |
| Openness rules & radii | unchanged, disclosed (§3) | unchanged | unchanged, disclosed | see §5 — thin soil is the constraint, not grazing radius |

Notes for the future finer-grained tree models (recording what §2 found, beyond
what three forms can render):

- Nemoral broadleaf should eventually distinguish an oak–lime–elm–ash component,
  a hazel understory (13.6 % of the pollen sum — hazel was a major landscape
  constituent, not an accent), and early beech stands in the south-west.
- The boreonemoral "conifer" split (pine vs spruce) is a *longitude/latitude*
  fact, not a soil fact: east of ~16°E and north of ~59°N spruce is defensible at
  500 CE; south-west of the front it is not. A single zone-level boolean
  (`spruce_present`) derived from §2.4 is enough to carry this.
- Southern-boreal rendering wants a taller, narrower conifer silhouette mix and
  birch as the only significant broadleaf.
- Juniperus reads as a shrub, not a tree, everywhere south of the subalpine zone;
  it matters visually only on the alvar (§5).

## 5. Alvar — the structural case

### 5.1 What the soil data already shows [measured 2026-08-22]

SGU Jordarter (`grundlager`), fetched this session over the 4×4 km context extent
of the four island pilot sites and clipped to the extent (area fractions of the
extent; the pipeline's unclipped fetch returns whole polygons, so these were
recomputed with clipping):

| Site | Composition of the 4×4 km extent |
|---|---|
| Eketorps borg (Öland) | Lerig morän 51 %, **Sedimentärt berg 28 %**, Vatten 9 %, Svallsediment grus 7 %, Morängrovlera 2 %, Postglacial sand 2 % |
| Ismantorps fornborg (Öland) | Lerig morän 81 %, Svallsediment grus 10 %, Kärrtorv 4 %, Sandig morän 2 %, Sedimentärt berg 2 % |
| Slottet (Gotland) | Vatten (Baltic) 89 %; the land: **Sedimentärt berg 6 %**, Svallsediment grus 5 % |
| L1976:4254 (Gotland, plausibly Torsburgen [reported]) | **Sedimentärt berg 84 %**, Svallsediment grus 5 %, Moränlera eller lerig morän 4 %, Postglacial sand 3 %, Bleke och kalkgyttja 2 %, Kärrtorv 2 % |

Broborg's extent, for contrast, is 100 % covered by classes the current
`SOIL_GROUPS` table maps (Sandig morän 31 %, Postglacial lera 30 %, Glacial lera
13 %, Gyttjelera 13 %, Urberg 10 %, …) [measured 2026-08-22] — which is precisely
the calibration-locality problem: the table is complete for the one valley it was
written against.

### 5.2 The defect this exposes [measured 2026-08-22]

Of the classes returned at the island sites, none of `Sedimentärt berg`,
`Svallsediment, grus`, `Lerig morän`, `Moränlera eller lerig morän`,
`Morängrovlera`, `Sten--block`, `Bleke och kalkgyttja` or `Postglacial finsand`
appears in `landcover.SOIL_GROUPS`. Every one falls through to `GROUP_OTHER`,
and ground in `GROUP_OTHER` that no earlier rule claims (mapped water, peat
veneer, settled footprints, road corridors) classifies as **"Conifer forest /
rocky ground" at 120 stems/ha**. The unmapped share is **89 % of Eketorp's
extent, 91 % of Ismantorp's and 95 % of Torsburgen's** — outside the fens and
the registered footprints, essentially all of it would render as dense conifer
forest: **the model would plant spruce forest across Stora Alvaret**. The
engine does log unmatched classes rather than absorbing them silently, but the
*output* is a confident, plausible, wrong landscape: exactly the scale-out §7.2
failure pattern, caught here before the flag is turned on.

### 5.3 What the alvar actually was, and the fix

The alvar is limestone pavement with centimetres of soil: what SGU maps as
`Sedimentärt berg` (with `Oklassad jordart` / thin veneers in `ytlager`
[measured — the ytlager response at all four sites]). Vegetation there is
edaphically constrained grassland/heath with scattered juniper — and the
palaeoecological literature holds that the great alvar grasslands are ancient,
kept open through the Iron Age by grazing on ground that cannot carry closed
forest; the classic study is Königsson (1968), *The Holocene history of the
Great Alvar of Öland*, Acta Phytogeographica Suecica 55 **[reported — the
monograph itself is unfetchable; its existence and subject are confirmed by
contemporary reviews via Crossref, doi:10.2307/3543799]**. Eketorp and Ismantorp
stand *on* this ground; their Iron Age setting is open alvar, not forest of any
composition.

The fix needs **no new dataset** — only table and rule work, in Phase-9d code:

1. Extend `SOIL_GROUPS` with the national classes measured above (till variants →
   `GROUP_TILL`, svallsediment/sten-block → `GROUP_GRAVEL`, postglacial finsand →
   `GROUP_FINE`, bleke/kalkgyttja → `GROUP_PEAT`-adjacent wetland, `Sedimentärt
   berg` → `GROUP_BEDROCK`). The unmatched-class run log stays as the tripwire
   for whatever the next county surprises us with.
2. Add an **alvar class** (open limestone grassland, sparse juniper shrub forms
   at low stems/ha, own ground tint): `GROUP_BEDROCK` where the bedrock is
   sedimentary — operationally, `jg2_tx == "Sedimentärt berg"` directly, so the
   flag needs no separate bedrock-geology fetch — with the island/zone context
   disclosed in the rule text. Crystalline `Urberg` keeps today's behaviour.
3. QA check: on the four island pilot sites, the alvar class must appear and the
   conifer fraction must collapse from ~90 % to a residual; on Broborg, the
   raster must be byte-identical to today's.

## 6. The repeatable procedure (all 1,304 sites, no hand-tuning)

**Inputs** (all already fetched or computed per site by the existing pipeline):
registry `centerE/centerN` + `county`; DEM (site elevation = crown, already
computed for the horizon ladder); the per-site SGU soils extract; the per-site KMR
sites extract.

**Assignment** (pure function, pipeline-side, disclosed in the manifest):

1. Zone: the §1.2 rule — latitude from inverse-projection, island carve-out from
   county+longitude, altitude term from the DEM crown. Emitted into the manifest
   (e.g. `landcover.zone: "boreonemoral"`) and the legend's method text.
2. Parameter set: the §4 table keyed by zone, plus the `spruce_present` boolean
   (§2.4: east/north of the measured front). Everything not listed in §4 —
   radii, densities, thresholds, `REFERENCE_YEAR_CE` — is deliberately identical
   across zones, with the §3 disclosure line stating so.
3. Alvar overlay: per-site from the soils extract (§5.3), independent of zone.
4. REVEALS anchor: look up the site's 1° cell in the committed TW5 OL means/SE
   tables (§3.2); covered cell → the quoted anchor sentence in the calibration
   paragraph, absent cell → the no-estimate disclosure. Pure lookup, no tuning.

**Checks** (batch QA gates + the contact sheet, per scale-out §4.4):

- **Broborg control:** boreonemoral parameters ≡ today's parameters; the
  committed Broborg `landcover.tif` and legend must be reproduced byte-identically
  by the zone-aware pipeline. If a refactor moves them, the refactor is wrong.
- Zone census printed by the batch (expect 22 / 1,261 / 21 ± the altitude term);
  any site whose zone changes between runs fails loudly.
- Per-zone class-fraction sanity on the pilot: alvar class present at the four
  island sites and absent elsewhere; conifer-identity change applied in the two
  s. boreal sites; unmatched-SGU-class log empty across all 27 (§5.3's table
  extension is complete when it is).
- Contact-sheet sweep after `--with-landcover` rebuilds — the visual pass that
  §7.2's history says catches what numbers miss.

**What cannot be automated, named explicitly:** the zone thresholds themselves
(§1.2 — a modelling choice pending fetchable boundary sources); the alvar species
list and its stems/ha (literature-based, [reported]); the decision to keep
engine openness rules national rather than fitted to the REVEALS cell means
(§3.2 — a judgement about scale and spread, now made on measured data); and the
final visual judgement of the contact sheet.

## 7. Sources

Graded per PLAN.md. DOIs marked ✓ were resolved against the live Crossref API this
session ([metadata measured 2026-08-22]); content of externally hosted papers
remains [reported] — full text was unreachable for all of them.

- Neotoma Paleoecology Database, `api.neotomadb.org` v2.0 — 57 Swedish pollen
  datasets, IDs and dataset DOIs in Appendix A. **[measured — primary data]**
- SGU Jordarter 1:25k–100k OGC API — island-site extracts. **[measured]**
- Ahti, T., Hämet-Ahti, L. & Jalas, J. (1968): Vegetation zones and their
  sections in northwestern Europe. Ann. Bot. Fennici 5:169–211. [reported; no
  Crossref record — pre-digital]
- Sjörs, H. (1963; 1999): Swedish zonation syntheses (Nordisk växtgeografi; Acta
  Phytogeogr. Suec. 84). [reported]
- Sugita, S. (2007): REVEALS. The Holocene 17. doi:10.1177/0959683607075837 ✓
- Mazier, F. et al. (2012): European PPEs. Rev. Palaeobot. Palynol. 187:38–49.
  doi:10.1016/j.revpalbo.2012.07.017 ✓
- Trondman, A.-K. et al. (2015): Gridded REVEALS, N-C Europe. Glob. Change Biol.
  21:676–697. doi:10.1111/gcb.12737 ✓
- Githumbi, E. et al. (2022): European REVEALS reconstructions, full Holocene.
  ESSD 14:1581–1619. doi:10.5194/essd-14-1581-2022 — paper full text fetched
  2026-08-22. Data archive: Fyfe, R.M. et al. (2021),
  doi:10.1594/PANGAEA.937075 (CC-BY-4.0) — **fetched in full 2026-08-22** after
  all three hostnames were opened; §3.1's per-cell numbers are computed from
  its TW5 (1,200–1,700 cal BP) means and standard-error files. **[measured —
  primary data]**
- Hultberg, T. et al. (2015): LRA openness, southern Sweden. Veget. Hist.
  Archaeobot. 24:253–266. doi:10.1007/s00334-014-0469-8 ✓ — evidently PLAN
  §2.5's "Hultberg et al. (2019)"; PLAN's entry should be corrected when next
  touched.
- Giesecke, T. & Bennett, K.D. (2004): The Holocene spread of *Picea abies*.
  J. Biogeogr. 31. doi:10.1111/j.1365-2699.2004.01095.x ✓
- Bradshaw, R.H.W. & Lindbladh, M. (2005): *Fagus*/*Picea* establishment in
  Scandinavia. Ecology 86. doi:10.1890/03-0785 ✓
- Königsson, L.-K. (1968): The Holocene history of the Great Alvar of Öland.
  Acta Phytogeogr. Suec. 55. [reported; reviews confirmed via
  doi:10.2307/3543799 ✓]
- Berglund, B.E. (ed., 1991): The cultural landscape during 6000 years in
  southern Sweden — the Ystad project. Ecol. Bull. 41. [reported; reviews
  confirmed via doi:10.2307/2261508 ✓]
- PLAN.md §2.5's Uppland anchors (Karlsson 1999; the Långhundraleden thesis;
  Länsstyrelsen Uppsala 2013) — unchanged, still the local qualitative anchors.
  [reported, as graded there]

## Appendix A — Neotoma sites used (300–700 CE window)

55 sites / 57 datasets / 237 samples. `n` = samples in window; age basis `cal`
except Kassjön (`c14`, see §2.1). Zone by the §1.2 rule. Dataset DOIs resolve at
`doi.org`.

| Site | Lat °N | Lon °E | Alt m | Zone | n | Neotoma dataset id(s) |
|---|---|---|---|---|---|---|
| Bjärsjöholmssjön | 55.45 | 13.78 | 36 | nemoral | 6 | 3931 |
| Bjäresjösjön | 55.46 | 13.75 | 39 | nemoral | 6 | 53999 |
| Bussjösjön | 55.47 | 13.82 | 49 | nemoral | 3 | 53995 |
| Fårarps Mosse | 55.49 | 13.91 | 18 | nemoral | 3 | 53997 |
| Krageholmssjön | 55.50 | 13.74 | 71 | nemoral | 11 | 4162, 23013 |
| Bökesjön | 55.58 | 13.44 | 57 | nemoral | 4 | 54001 |
| Ageröds Mosse | 55.93 | 13.43 | 47 | nemoral | 11 | 12 |
| Färskesjön | 56.16 | 15.86 | 11 | nemoral | 4 | 4037 |
| Stobydeltat | 56.17 | 13.83 | 32 | nemoral | 4 | 54016 |
| Flinkasjön | 56.25 | 13.24 | 75 | nemoral | 4 | 54024 |
| Östra Ringarp | 56.26 | 13.32 | 93 | nemoral | 3 | 54018 |
| Ran Viken | 56.28 | 14.29 | 77 | nemoral | 4 | 4370 |
| Grisavad | 56.28 | 13.33 | 88 | nemoral | 6 | 53770 |
| Kullaberg | 56.29 | 12.51 | 135 | boreonemoral | 5 | 53982 |
| Värsjö Utmark | 56.32 | 13.43 | 127 | boreonemoral | 6 | 54022 |
| Bjärabygget | 56.35 | 13.47 | 128 | boreonemoral | 4 | 53768 |
| Västragylet | 56.35 | 14.88 | 112 | boreonemoral | 2 | 53964 |
| Siggaboda | 56.47 | 14.57 | 139 | boreonemoral | 7 | 54026 |
| Exhult | 56.48 | 13.65 | 130 | boreonemoral | 4 | 53994 |
| Uddared | 56.52 | 13.25 | 91 | boreonemoral | 6 | 53771 |
| Trälhultet | 56.80 | 12.90 | 151 | boreonemoral | 3 | 53974 |
| Lake Trummen | 56.86 | 14.83 | 162 | boreonemoral | 3 | 4496 |
| Storasjö | 56.93 | 15.27 | 254 | boreonemoral | 4 | 54004, 54005 |
| Flahult | 56.97 | 13.83 | 178 | boreonemoral | 3 | 53993 |
| Stavsåkra | 57.02 | 14.81 | 182 | boreonemoral | 2 | 54003 |
| Bocksten site A | 57.12 | 12.57 | 125 | boreonemoral | 9 | 54030 |
| Lake Sämbosjön | 57.16 | 12.41 | 12 | boreonemoral | 8 | 4403 |
| Lake Öagöl | 57.21 | 14.80 | 221 | boreonemoral | 6 | 57602 |
| Mattarp | 57.48 | 14.62 | 266 | boreonemoral | 3 | 54028 |
| Övre myren från Skallskog | 57.48 | 14.78 | 219 | boreonemoral | 2 | 53984 |
| Kansjön | 57.64 | 14.53 | 299 | boreonemoral | 1 | 1438 |
| Lake Avegöl | 57.69 | 14.49 | 292 | boreonemoral | 5 | 54020 |
| Rogberga | 57.74 | 14.29 | 215 | boreonemoral | 5 | 53976 |
| Mabo Moss | 58.02 | 16.06 | 97 | boreonemoral | 11 | 24110 |
| Dags Mosse | 58.32 | 14.71 | 89 | boreonemoral | 4 | 4011 |
| Lake Flarken | 58.56 | 13.67 | 104 | boreonemoral | 2 | 4042 |
| Ljustjärnen | 59.76 | 14.48 | 161 | s. boreal | 4 | 53966 |
| Lilla Gloppsjön | 59.80 | 14.62 | 186 | s. boreal | 4 | 4200 |
| Gilltjärnen | 60.08 | 15.83 | 169 | s. boreal | 1 | 53991 |
| Stor-flen | 60.30 | 14.58 | 268 | s. boreal | 5 | 53988 |
| Holtjärnen | 60.65 | 14.93 | 232 | s. boreal | 3 | 21790 |
| Trygåsen (II) | 61.77 | 13.33 | 569 | m. boreal | 7 | 53986 |
| Klotjärnen | 61.82 | 16.40 | 214 | s. boreal | 5 | 19909 |
| Styggtjärnen | 62.32 | 13.56 | 711 | n. boreal/subalp. | 4 | 19906 |
| Fjällnas | 62.62 | 12.13 | 779 | n. boreal/subalp. | 3 | 4040 |
| Storsnasen | 63.23 | 12.42 | 686 | n. boreal/subalp. | 2 | 53968 |
| Abborrtjärnen | 63.88 | 14.45 | 374 | n. boreal/subalp. | 3 | 19913 |
| Kassjön | 63.93 | 20.01 | 91 | m. boreal | 7 | 4141 (¹⁴C window) |
| Lake Svartkälstjärn | 64.27 | 19.55 | 267 | n. boreal/subalp. | 1 | 53972 |
| Alanen Laanijärvi | 67.97 | 20.46 | 354 | n. boreal/subalp. | 2 | 45314 |
| Vuolep Allasasjaure | 68.17 | 18.17 | 1109 | n. boreal/subalp. | 2 | 45312 |
| Lake Tibenatus | 68.34 | 18.69 | 568 | n. boreal/subalp. | 2 | 53980 |
| Lake Vuolep Njakajaure | 68.34 | 18.78 | 402 | n. boreal/subalp. | 2 | 53978 |
| Lake Badsjön | 68.34 | 18.80 | 395 | n. boreal/subalp. | 2 | 52214 |
| Vuoskkujávri | 68.35 | 19.10 | 345 | n. boreal/subalp. | 4 | 45311 |

## Appendix B — full zone table (mean / median, % of terrestrial sum)

| Taxon | nemoral | boreonemoral | s. boreal | m. boreal | n. boreal/subalp. |
|---|---|---|---|---|---|
| Picea | 0.1 / 0.1 | 2.0 / 0.1 | 15.6 / 14.3 | 14.1 / 14.1 | 5.9 / 0.9 |
| Pinus | 6.8 / 6.3 | 12.8 / 7.7 | 40.8 / 42.3 | 34.6 / 34.6 | 34.7 / 31.3 |
| Betula | 25.2 / 22.2 | 35.9 / 38.4 | 29.5 / 26.8 | 28.1 / 28.1 | 44.7 / 43.4 |
| Alnus | 14.1 / 13.2 | 14.0 / 9.2 | 6.4 / 6.0 | 11.0 / 11.0 | 2.0 / 1.7 |
| Quercus | 9.8 / 8.7 | 9.7 / 7.4 | 1.6 / 1.5 | 0.0 / 0.0 | 0.2 / 0.1 |
| Tilia | 1.0 / 1.0 | 2.1 / 1.0 | 0.3 / 0.1 | 0.1 / 0.1 | 0.0 / 0.0 |
| Ulmus | 0.9 / 0.7 | 0.3 / 0.3 | 0.1 / 0.1 | 0.3 / 0.3 | 0.0 / 0.0 |
| Fraxinus | 1.1 / 0.8 | 0.2 / 0.2 | 0.1 / 0.1 | 0.0 / 0.0 | 0.0 / 0.0 |
| Fagus | 3.1 / 2.0 | 2.0 / 0.4 | 0.1 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 |
| Carpinus | 1.0 / 0.7 | 0.4 / 0.3 | 0.1 / 0.1 | 0.1 / 0.1 | 0.0 / 0.0 |
| Corylus | 13.6 / 12.2 | 6.9 / 6.0 | 1.2 / 1.1 | 0.5 / 0.5 | 0.4 / 0.1 |
| Salix | 0.3 / 0.2 | 0.3 / 0.1 | 0.3 / 0.3 | 0.1 / 0.1 | 0.6 / 0.5 |
| Juniperus | 0.2 / 0.0 | 0.4 / 0.0 | 0.3 / 0.2 | 0.1 / 0.1 | 1.5 / 0.7 |
| Poaceae | 9.1 / 4.5 | 3.8 / 2.5 | 1.2 / 1.0 | 1.8 / 1.8 | 1.8 / 1.2 |
| Cyperaceae | 2.6 / 1.3 | 1.0 / 0.7 | 0.7 / 0.5 | 6.7 / 6.7 | 3.4 / 1.3 |
| Calluna | 3.6 / 0.7 | 4.0 / 0.5 | 0.2 / 0.2 | 0.0 / 0.0 | 0.4 / 0.0 |
| Ericaceae/Empetrum | 0.2 / 0.0 | 0.9 / 0.1 | 0.1 / 0.1 | 0.6 / 0.6 | 2.1 / 0.9 |
| Artemisia | 1.1 / 0.5 | 0.3 / 0.2 | 0.1 / 0.1 | 0.0 / 0.0 | 0.1 / 0.1 |
| Plantago | 1.8 / 0.7 | 0.1 / 0.1 | 0.1 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 |
| Rumex | 1.1 / 0.7 | 0.3 / 0.2 | 0.0 / 0.0 | 0.0 / 0.0 | 0.1 / 0.0 |
| Cerealia | 0.5 / 0.2 | 0.1 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 |
| **AP (sum TRSH)** | 81.6 / 92.0 | 92.3 / 95.0 | 97.6 / 97.9 | 89.9 / 89.9 | 93.0 / 95.5 |

---

*Summary: three zones and one soil overlay cover all 1,304 sites from data the
pipeline already has. Species identity varies by zone on measured evidence — above
all the 500 CE spruce front. Openness is now quantified where the REVEALS record
reaches — ~39 % open nemoral, ~33 % covered boreonemoral, ~7 % southern boreal —
but the record is measured to be absent for the cells holding 70 % of the
registry, Broborg's included, so the engine's rules stay national and each site
reports its own cell's anchor or the honest lack of one. Per-site KMR evidence
density keeps doing the local work it already does. The alvar is a measured,
structural exception that today's soil table would silently render as spruce
forest — the exact class of error this phase exists to prevent.*
