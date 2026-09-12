# Reconstruction mode — categorisation, literature research, and per-type specifications

**Status:** research + specification. No app code exists for this yet. This document is
the evidence base and the design contract for a second overlay mode; it is written so
that the geometry work can start from it without going back to the literature.

**Scope.** The app today draws registered sites as flat cartographic markers coloured by
`lamningstyp` (`app/src/overlays/sites.ts`), plus one conjectural palisade on a
DEM-derived rampart crest (`app/src/overlays/palisade.ts`, PLAN §4.6). Reconstruction
mode replaces the marker layer with **standing three-dimensional monuments as they may
have looked when in use**. This document decides *what* the categories are, *what the
literature says each one looked like*, and *which parameters can be driven from data
rather than invented*.

**The hard constraint from PLAN §1 still holds:** everything is *procedurally generated*
from data plus published parameters. No hand-modeled 3D assets, no textures lifted from
photographs, no artist's impression baked into a mesh. If a number in this document is
not derived from the KMR record or cited to literature, it is labelled a default and is
meant to be exposed as a tunable.

---

## 1. Why a second mode, and what it must not become

The marker mode answers *"what is registered here, and where?"* It is honest, complete,
and completely mute about what any of it looked like. A visitor standing on Broborg's
rampart sees a grey ridge and 126 coloured dots.

Reconstruction mode answers *"what would I have seen standing here in 500 CE?"* That is a
different and much less certain question, and the risk is obvious: a smooth, confident,
well-lit 3D reconstruction is the most persuasive thing this app could possibly render,
and most of it is inference. The mitigation is not to render it badly — PLAN §6.1's
2026-08-22 amendment already retired that idea for vegetation — but to be exact about
which of three things each parameter is:

| Tier | Meaning | Example |
|---|---|---|
| **Measured** | Read from the KMR record or the LiDAR DEM | A stensättning's 6 m plan diameter, the rampart crest line |
| **Derived** | Computed from a measured value by a stated, reversible rule | Original rampart height from collapsed-rubble cross-section |
| **Assumed** | A literature default with no site-specific evidence | Palisade post spacing, roof pitch, turf colour |

Every archetype table in §6 carries this tier per parameter. §9 maps the tiers onto the
existing three provenance badges.

---

## 2. Method

1. **Corpus analysis.** Every `lamningstyp` value and every free-text `beskrivning` in
   the committed Broborg bundle (127 records) was parsed for form vocabulary,
   construction vocabulary and numeric dimensions, to find out what the registry actually
   affords a reconstruction. The national fort registry (1 304 records) was used for the
   fort size distribution.
2. **Taxonomy.** Types were grouped by *what you build*, not by what the register calls
   them — several `lamningstyp` values collapse to one geometry recipe, and one
   (`Gravfält`) expands into a composition of others.
3. **Literature.** Per archetype, published construction detail, dimensions, materials
   and the state of debate. Sources listed in §12.
4. **Specification.** Per archetype: a prose description of the original appearance, a
   procedural recipe, and a parameter table with tiers.

### 2.1 What the corpus actually contains

Broborg bundle, `app/public/data/broborg/sites.json`, 127 records:

| `lamningstyp` | n | | `lamningstyp` | n |
|---|---:|---|---|---:|
| Stensättning | 53 | | Grav- och boplatsområde | 3 |
| Gravfält | 28 | | Runristning | 2 |
| Hög | 12 | | Hägnad | 2 |
| Skärvstenshög | 9 | | Boplats | 2 |
| Röse | 7 | | Boplatslämning övrig | 2 |
| Grav markerad av sten/block | 5 | | Röjningsröse | 1 |
| | | | **Fornborg** | **1** |

The pipeline's selection filter (`fetch_sites.py: SELECTED_TYPES`) admits 26 types;
13 occur at Broborg. The taxonomy below covers all 26 so a site elsewhere in the country
does not fall through.

National fort registry, `pipeline/registry.json`, 1 304 forts, `extentSpanM`:

```
min 12   p10 76   p25 100   median 138   p75 194   p90 280   max 5930   (metres)
```

That distribution is the reason fort reconstruction cannot be one hard-coded ring: the
median fort is ~140 m across, the top decile is over 280 m, and three are wide enough to
need the pipeline's `large` extent preset.

---

## 3. The description grammar — what the register will actually give us

RAÄ free-text descriptions are not prose in the ordinary sense; they are a
semi-formulaic surveyor's shorthand, and that is what makes reconstruction mode
tractable. The canonical form is:

> `<Typ>`, `<form>`, `<plan size>` (`<orientation>`), `<height>` h, `<surface>`.
> Kantkedja `<height>` h av `<stone size>` st stenar.

Measured on the 127 Broborg records:

| Feature | Coverage | Notes |
|---|---:|---|
| Plan size anywhere in text (`N m diam` or `A x B m`) | **92 %** | the primary geometry driver |
| Constituent stone size range (`0,3-1 m st`) | **87 %** | drives the stone instancing |
| Plan size in the *first* sentence | 85 % | the record's own headline monument |
| Turf/moss cover noted (`övertorvad`, `övermossad`) | 77 % | present state, and a reconstruction cue |
| Height (`N m h`) in the first sentence | 58 % | 88 % somewhere in the text |
| `kantkedja` (kerb) recorded | **54 %** | see §5.2 — this pins the original base |
| Form adjective in the first sentence | 41 % | `rund`, `kvadratisk`, `rektangulär`, `oval`, `högliknande` |
| An explicit pit feature with dimensions (`grop … m diam … m dj`) | **32 %** | robbing pits — see §5.3 |

Two structural findings matter more than the percentages.

### 3.1 `Gravfält` records are compositional recipes

A grave field's description enumerates its own contents, with a size range per
constituent class. Example, `L1941:5480`:

> *"Gravfält, 245x140 m (N-S) bestående av ca 65 fornlämningar. Dessa utgörs av 5 högar,
> 2 rösen och ca 57 runda fyllda stensättningar samt 1 rest sten … Stensättningarna är
> 3-8 m diam, 0,2-0,6 m h … Högarna är 6-9 m diam … Rösena … ca 10 m i diam, ca 1 m h."*

28 of 31 grave-field-like records (`Gravfält` + `Grav- och boplatsområde`) state a
monument count; counts range **5 to 230**. Across the corpus the enumerated constituents
total 91 stensättningar, 81 standing stones, 63 mounds and 4 cairns.

This means a grave field does not need invented content. It needs a *sampler*: place N
monuments of the stated classes, with diameters and heights drawn from the stated ranges,
inside the stated extent polygon. Everything but the individual positions is measured.

### 3.2 The fort record is a construction description

`L1943:7827`, Broborg, in full — this single record carries more reconstruction detail
than any other in the bundle:

> *"Fornborg, 95x85 m (NÖ-SV), bestående av en inre och en yttre ringvall. I N och V
> begränsas borgen av branta sluttningar. Den inre vallen är ca 300 m l, 8-15 m br och
> 1-2 m h, av i allmänhet 0,3-1 m st stenar, enstaka större. Insidan av muren är förstärkt
> med jord. Ställvis 1 m h kallmurning. I VNV och ÖSÖ är vallen försedd med ingångar, 3-5 m
> br. Förslaggad och skörbränd sten finns på flera platser, men särskilt i S. Den yttre
> vallen är ca 140 m l, 7-10 m br och 0,5-1,5 m h … Ställvis 1,5 m h kallmurning. I ÖSÖ och
> NNÖ har vallen ingångar, 3-5 m br. … Den inre muren är huvudsakligen raserad utåt, medan
> den yttre är raserad både inåt och utåt. Borgens centrala del utgörs av röjda ytor
> omgivna av grovblockig morän samt berg i dagen."*

Parsed, that is: two ramparts with lengths, widths, heights and stone sizes; an earth-backed
inner face; surviving dry-stone facing (`kallmurning`) up to 1 m and 1.5 m; four entrances
with widths; vitrified and fire-shattered stone; collapse *direction*; and an interior of
cleared surfaces among coarse boulder moraine and outcrop. Section §7 turns this into geometry.

---

## 4. The taxonomy

Eleven archetypes. The grouping rule is *shared geometry recipe*, so `Hög` and the
`högliknande` stensättningar in a grave field are one archetype with different parameters,
while `Boplats` and `Boplatslämning övrig` — which look identical in the register and
identical on the ground (nothing visible) — are one archetype whose reconstruction is
entirely inferential.

| # | Archetype | `lamningstyp` values mapped | Typical period | Visible today? |
|---|---|---|---|---|
| **A** | **Fort / rampart work** | Fornborg | 400–550 CE core; some 0–1100 CE | Yes — rubble banks |
| **B** | **Earth mound** | Hög | Late Iron Age (400–1050) | Yes |
| **C** | **Stone setting** | Stensättning, Grav markerad av sten/block, Flatmarksgrav, Gravgrupp | Bronze Age – Late Iron Age | Yes, low |
| **D** | **Cairn** | Röse | Bronze Age – Early Iron Age | Yes |
| **E** | **Fire-cracked stone mound** | Skärvstenshög | Bronze Age – Early Iron Age | Yes, low |
| **F** | **Standing stone & stone figure** | (constituents of Gravfält), Stenkammargrav | Late Bronze Age – Late Iron Age | Yes |
| **G** | **Grave field** | Gravfält, Grav- och boplatsområde | Composite | Yes |
| **H** | **Farmstead** | Boplats, Boplatsområde, Boplatslämning övrig, Husgrund förhistorisk/medeltida, Boplatsvall | Whole Iron Age | **No** |
| **I** | **Field boundary** | Hägnad, Hägnadssystem | ~0–550 CE | Yes, low |
| **J** | **Cultivated ground** | Fossil åker, Område med fossil åkermark, Röjningsröse, Röjningsröseområde, Terrassering | Bronze Age – Medieval | Yes, low |
| **K** | **Route & monument stone** | Färdväg, Färdvägssystem, Runristning | Route: broad; runestone: 950–1130 CE | Yes |

Two deliberate decisions:

- **`Gravfält` is not a leaf.** It is a container that expands into archetypes B–F using
  its own enumerated composition (§3.1). Rendering it as one big shape would throw away
  the best structured data in the corpus.
- **`Fornborg` is one archetype, not three.** The literature typology (ringvall,
  promontory fort/*uddeborg*, terrace fort) describes *where the wall runs*, and that is
  already answered by the measured crest line from the DEM. It does not change how the
  wall is built. Siting is data; construction is the archetype.

---

## Drawing guide — one card per type

A condensed build sheet. Each card gives the footprint source, the profile rule, the surface
treatment, the one detail that makes the thing read as itself, and how much of it is actually
evidenced. Full reasoning and citations are in §6 and §7.

**Basis ratings.** *Strong* = measured plan, measured or derived profile, and published
construction detail. *Moderate* = measured plan, literature profile and surface.
*Weak* = position is all we have; everything visible is inference.

---

### A. Fort / rampart work — **Strong at Broborg, weak elsewhere**

- **Plan** — the DEM-derived crest polyline (`rampart.json`), already measured. Entrances cut
  where the description places them, 3–5 m wide.
- **Profile** — a dry-stone wall `t_wall` thick, standing `h_orig` high (§5.1). Broborg:
  4–6 m thick, 2.1–3.4 m high, default 2.5 m. Outer face battered 5–10°.
- **Surface** — outer face tightly packed small-to-medium glacial boulders (small dominate);
  inner face coarse 40–60 cm equidimensional blocks; **soil and turf over the inner face and
  top**, so the naked stone shows only on the outside.
- **Tell** — the wall stops dead where the natural cliff takes over. A fort that rings its
  whole hill reads as a stadium; a fort that walls only the climbable third reads as a fort.
- **Watch out** — §6.A.1: roughly four in five registered `Fornborg` records are probably not
  Migration Period forts. Without `kallmurning` and a ≥1 m wall in the description, draw a low
  bank, not this.

### B. Earth mound (`Hög`) — **Strong**

- **Plan** — circle at the recorded diameter (corpus median 7 m).
- **Profile** — kerb recorded (54 % of records) → keep the diameter, restore a smooth
  spherical cap. No kerb → volume-conserving re-profile to ~30° repose, which makes the
  corpus-median mound **narrower and taller**: 5.7 m across, 1.6 m high, against today's
  7 m × 0.7 m. Fill any recorded robbing pit.
- **Surface** — laid turf, showing the cut edges of stacked turves in concentric or spiral
  courses; pale raw subsoil where it came out of the ground.
- **Tell** — steepness. Today's mounds sit at ~11°; a built one stands near 30° and reads as
  unmistakably artificial from a distance.

### C. Stone setting (`Stensättning` and kin) — **Strong**

- **Plan** — the recorded form, verbatim: round, square, rectangular, oval (41 % of records
  name it). Corpus median 6 m across.
- **Profile** — **do not inflate.** Flatness is the type. The recorded 0.4 m median is close
  to original; the work here is cleaning, not raising.
- **Surface** — close-laid, tight-packed stone like a paved floor, 0.2–0.4 m calibre. Kerb of
  larger selected stones round the edge, standing slightly proud. Strip the turf and moss
  that 77 % of records note.
- **Tell** — deliberate selection. The graves are near-perfectly circular and the builders
  sometimes used *contrasting* stone — a light kerb against dark fill, or one large centre
  block as a focus. Random rubble looks wrong.

### D. Cairn (`Röse`) — **Strong**

- **Plan** — circle at recorded diameter (corpus median 7 m); sited on crowns and skylines.
- **Profile** — volume-conserving re-profile toward ~35°, the angle dry stone holds.
- **Surface** — bare, bright, unweathered stone. Calibre is the giveaway: corpus median
  0.4–0.6 m for cairns against 0.2–0.4 m for stone settings and 0.2–0.3 m for mounds.
  Retaining kerb or dry-stone wall holding the edge in.
- **Tell** — **no vegetation at all.** A maintained cairn is a blazing light-grey dome against
  dark rock or heath, visible for kilometres. The mossy lichen-black tumble is the ruin.

### E. Fire-cracked stone mound (`Skärvstenshög`) — **Strong**

- **Plan** — recorded diameter, corpus median 6 m. Place at a settlement edge or on a slope.
- **Profile** — **leave it low.** It accumulated rather than being built, so the recorded 7.6°
  is probably near-original.
- **Surface** — angular shattered fragments a few cm to ~0.2 m, quite unlike rounded field
  stone; heat-reddened oranges and greys shot through with soot-black.
- **Tell** — the colour. It is the one monument that isn't grey.

### F. Standing stone & set-stone figure — **Moderate**

- **Plan** — from the grave-field text, which records individual height, width and thickness
  (81 standing stones across the corpus), plus `treudd`, `domarring`, ship-setting outlines.
- **Profile** — upright, plumb, tapering up; corpus examples cluster 0.85–2.0 m high.
- **Surface** — local granite, unworked, bases packed with wedging stones, ground scuffed bare.
- **Tell** — **stand the fallen ones back up.** The corpus says *"de två västra är
  omkullfallna"*. A row of upright stones reads instantly as human intent; a row of fallen
  ones reads as nothing. Small operation, largest visual return in the whole feature.

### G. Grave field (`Gravfält`) — **Strong** (composition), **Moderate** (placement)

- **Plan** — the KMR extent polygon, populated by the record's *own* enumeration: monument
  count (28 of 31 records state it, 5–230), class composition, and per-class size ranges.
- **Profile / surface** — whatever archetypes B–F the enumeration names.
- **Placement** — the only real guesswork. Terrain-aware blue-noise: dry well-drained ground,
  ridges and rock crowns, wet land-cover classes excluded, larger mounds biased to the highest
  and most visible points, small settings filling between.
- **Tell** — clustering and skyline. Grave fields sit above the settlement and were meant to
  be seen against the sky from it. Even scatter looks wrong.

### H. Farmstead (`Boplats` and kin) — **Weak — everything visible is inference**

- **Plan** — nothing survives. A three-aisled longhouse 20–40 m × 6–8 m, entrance mid-long-wall,
  yard in front, outdoor hearth, well, one or two ancillary buildings and a sunken `grophus`.
- **Profile** — walls **≥1 m and load-bearing** (not a low footing), under a **hipped** roof
  whose hip pitch equals or exceeds the long sides, never less. Central aisle
  ***underbalanserad*** for a 5th-century Uppland house: ~40 % of breadth, 1.3–2.8 m.
- **Surface** — turf over birch bark, green and shaggy in summer, grey-brown and flat in
  winter; walls of wattle daubed pale ochre-grey, visibly patched, on a low stone footing.
- **Tell** — the roof dwarfs the walls, and there is **no gable** — the ridge stops short and
  falls away on all four sides, with a small dark smoke hole at the top of each hip. Not an
  open louvre: a board with a hole in it.
- **Watch out** — ship it **off by default**. Least evidenced, most persuasive, and the one
  thing that makes the landscape feel inhabited. Inside a fort it may only be drawn where
  §7.5.2's interior evidence gate passes, and the record's own counts and dimensions outrank
  every default above (§6.H.1).

### I. Field boundary (`Hägnad`, `Hägnadssystem`) — **Moderate**

- **Plan** — KMR line or polygon geometry, measured. Runs contours, turns sharp corners.
- **Profile** — a single wall **80–90 cm high**, one course wide by default (recorded examples
  reach ~5 m wide). Optional timber fence above, +0.8 m, off by default.
- **Surface** — grey-white unworked stone, notably **larger** than grave stone: corpus median
  calibre for `Hägnad` is 1.0–2.0 m against 0.2–0.4 m for stone settings.
- **Tell** — length and knee-height. It should run for hundreds of metres and never be
  impressive. Its job is to read as a boundary, not a defence.

### J. Cultivated ground (`Fossil åker`, `Röjningsröse`, `Terrassering`) — **Moderate**

- **Plan** — KMR polygon, filled with plots ~20–40 m across and clearance cairns 4–6 m across,
  sampled to fill.
- **Profile** — cairns 0.2–0.5 m, low and rounded; plot edges as low banks; ridged fields
  where recorded at 20–60 × 10–16 m, 0.3 m high.
- **Surface** — bare picked field stone on the cairns; reuse the existing land-cover farmland
  class for the ground between.
- **Tell** — irregularity, on a south-facing slope. Small stone-picked plots with the lifted
  stone heaped in and around the crop, and boulders nobody moved left in place.
- **Watch out** — dating is genuinely broad (Bronze Age to the 17th century). Keep the period
  attribution loose and say so.

### K. Route & monument stone — **Route: weak. Runestone: moderate**

- **Route (`Färdväg`)** — measured line; draw a *used surface*, not a built road: bare,
  compacted, braided earth 1.5–3 m wide, cut slightly into the slope. Everything but the line
  is guessed.
- **Runestone (`Runristning`)** — 1.5–2.3 m of local granite at a roadside, ford, bridge or
  landing place. **Painted**, not bare grey: red best attested, black for contrast, traces of
  white. Carved bands and beast ornament picked out in strong pigment.
- **Tell** — a runestone is a brightly coloured public sign, and the weathered grey stone
  visitors know today is the ruin state. Offer painted and unpainted.
- **Watch out** — chronology. Uppland's runestones are late 900s to early 1100s; Broborg's
  fort is 400s–500s. **At 500 CE there must be no runestones on screen.**

---

**Coverage summary.** Strong basis for A (at Broborg), B, C, D, E and G — measured plan,
defensible profile, published construction. Moderate for F, I, J and the runestone. Weak for
H and for `Färdväg`, where the position is real and the appearance is literature plus
judgement. The one systematic risk is A away from Broborg, which §6.A.1's `fortConfidence`
exists to manage.

## 5. The central problem: every number in the register is a ruin measurement

This is the methodological core of reconstruction mode, and getting it wrong would make
the whole overlay quietly false.

**KMR records the monument as it survives.** "Hög, 7 m diam, 0,7 m h" is a mound that has
stood for fifteen centuries, lost its organic volume to decay, slumped outward, been
ploughed around, and in a third of cases been dug into. Rendering 0.7 m of height is not a
reconstruction — it is the ruin, extruded.

The corpus proves the point. Pairing plan diameter with height within the same clause and
taking the implied mean flank angle:

| Archetype | n | median h/d | implied flank |
|---|---:|---:|---:|
| Hög | 25 | 0.100 | **11.3°** |
| Röse | 15 | 0.086 | 9.7° |
| Stensättning | 71 | 0.067 | 7.6° |
| Skärvstenshög | 18 | 0.067 | 7.6° |
| Grave-field constituents | 53 | 0.075 | 8.5° |

Dry-stacked stone of 0.2–0.4 m calibre — the corpus median stone range — stands at an
angle of repose near **35°**. Loose earth and turf stand near **30–33°**. Nothing in this
table is anywhere near that. A stensättning at 7.6° is not necessarily degraded — the type
is *defined* as a low, flat, close-laid stone floor, so 7.6° may be close to original. But
a **mound at 11.3° is unambiguously a slumped mound**, and a cairn at 9.7° is a spread cairn.

So the reconstruction needs an explicit, stated, per-archetype **ruin → original**
transform. Three are needed.

### 5.1 Transform 1 — rampart height, anchored on the standing wall

**This section was rewritten after reading the excavation literature, and the method
changed.** The first draft back-calculated a height from the full collapse spread, and got
a useless answer: 1.0–6.1 m across the plausible parameter box. The problem was that it
treated the rampart as a heap of unknown original shape. It is not. At Broborg the wall's
own dimensions are published.

Kresten, Kero & Chyssler (1993) state it directly: *"The remaining parts of the dry-stone
wall are all about **2 m high**, with an estimated **thickness of 4–6 m**."* Both ramparts
are dry-stone walls built of glacial-drift boulders, and — importantly — *"socket-beams or
other timber constructions are apparently lacking."*

That converts the problem. The wall is not an unknown shape to be inferred; it is a
4–6 m thick dry-stone wall **still standing 2 m high**, plus however much has fallen off the
top into an apron either side. So:

```
h_orig  =  h_standing  +  Δh
Δh      =  (A_apron · p) / t_wall
A_apron =  (W_spread − t_wall) · d_apron
```

with `h_standing = 2.0 m` and `t_wall = 4–6 m` **measured**, `W_spread = 8–15 m` from the
KMR record, `d_apron` the mean depth of the fallen debris (0.3–0.6 m), and `p = 0.85` for
the packing difference between built wall and rubble.

| W_spread | t_wall | apron | d_apron | A_apron | Δh | **h_orig** |
|---:|---:|---:|---:|---:|---:|---:|
| 8.0 | 6.0 | 2.0 | 0.30 | 0.60 | 0.09 | 2.08 m |
| 8.0 | 4.0 | 4.0 | 0.30 | 1.20 | 0.26 | 2.25 m |
| 11.5 | 5.0 | 6.5 | 0.45 | 2.93 | 0.50 | **2.50 m** |
| 15.0 | 6.0 | 9.0 | 0.60 | 5.40 | 0.77 | 2.77 m |
| 15.0 | 4.0 | 11.0 | 0.60 | 6.60 | 1.40 | 3.40 m |

Across the whole parameter box the answer now spans **2.08–3.40 m**, with the central 80 %
at **2.15–3.02 m** and a median of **2.5 m**. That is a usable default with an honest band,
and it is far better constrained than the first draft's estimate because most of it is not
estimated at all — 2 m of it is simply *there*.

**Why the two published widths are no longer a contradiction.** KMR's "8–15 m br" is the
spread; Kresten's 4–6 m is the wall; the Mälardalen survey's "widest 5 m" is the same wall.
The transform above consumes both without having to choose: the wall thickness sets the
divisor and the spread sets the apron. The first draft flagged this as the document's most
consequential ambiguity. It is resolved.

**Where this does *not* transfer.** Every number above except `W_spread` comes from Broborg
specifically. A registry fort whose description gives only a bank width and height has no
measured wall thickness, and there the method degrades to the first draft's weak version.
Treat `t_wall` as required input: without it, report a range and say so, or fall back to
the standing height alone as a lower bound.

### 5.2 Transform 2 — mound re-profiling, gated on the kerb

For mounds and cairns, whether the base is original is decided by one recorded feature:

- **`kantkedja` recorded (54 % of the corpus).** A kerb of set stones fixes the monument's
  original footprint. The diameter is *measured original*, not a spread. Then volume
  conservation says the height is also close to original, because the material did not
  leave — what a kerbed mound loses is organic bulk (decayed turf) and whatever a robbing
  pit removed, not lateral spread. **Rule: keep d, restore the surface to a smooth
  spherical cap through the kerb, and apply only the §5.3 pit fill.** Do not inflate.
- **No kerb recorded.** The base may have crept outward. Reconstruct at the material's
  angle of repose while conserving volume:

```
V_now  = (π·h/6)·(3a² + h²)            spherical cap, a = d/2
h_orig = 0.577·a_orig  with  V_cone = (π/3)·a_orig³·0.577 = V_now      (30° repose, earth)
```

  Worked, for the corpus-median mound (d = 7 m, h = 0.7 m): V ≈ 13.7 m³ → base diameter
  **5.7 m**, height **1.6 m**. The mound gets *narrower and more than twice as tall*. That
  is the physically coherent story of a slumped mound, and it is why the kerb test matters
  so much — applying this rule to a kerbed mound would visibly pull the mound inside its
  own surviving kerb, which is the built-in sanity check.

### 5.3 Transform 3 — fill the robbing pits

32 % of records describe an explicit pit with dimensions: *"grop uppbruten, ca 2x1,5 m ca
0,5 m djup"*, *"grop i mitten, 1 m diam och 0,1-0,2 m dj"*. These are plundering and
antiquarian digging, not original features. Reconstruction fills them — and because they
are parseable with dimensions, the fill is a measured operation, not a guess. Records that
also note damage (`plundrad`, `utgrävning`, `skadad`, `bortodlad` — 11 %) should be flagged
in the popup so the visitor knows the reconstruction is over a disturbed monument.

### 5.4 What comes off, and what goes on

The register's most common single observation — `övertorvad`, 77 % — is a *ruin* state.
A monument in use was not turfed over. The reconstruction must:

- **remove** turf, moss, lichen, self-sown trees and the softened profile;
- **restore** bare surfaces: fresh stone with sharp arrises and unweathered faces, exposed
  soil, laid turf where turf was structural (mounds) rather than incidental;
- **keep** the surrounding vegetation model exactly as Phase 7 computes it — reconstruction
  mode changes the *monuments*, not the landscape. The land-cover layer already carries its
  own "model" badge and its own calibration.

---

## 6. Per-archetype specifications

Each entry gives: what the register affords, what the literature says, a prose
**"what it looked like"**, a procedural recipe, and a parameter table with §1 tiers.

### A. Fort / rampart work (`Fornborg`)

**Register affords.** Extent polygon; a DEM-derived crest line already produced by
`pipeline/fornborg_pipeline/rampart.py` (measured); and — where the description is as full
as Broborg's — rampart length, width, height, stone calibre, entrance count and widths,
collapse direction, and notes on facing and earth backing.

**Literature.** Roughly a thousand forts are registered in Sweden (1 304 in our own
registry extract); Uppland has ~150–181 depending on the count, and Michael Olausson's
*Det inneslutna rummet* concluded only about a third are genuinely fortified — the rest are
better read as enclosed spaces of other kinds. Construction is consistent across the
mainland type: a **dry-stone (`kallmurad`) outer face of unworked local stone, a rubble
core, and an earth-and-stone backing on the inner side**, following the crest of a hill
whose steep flanks are left unwalled and do the defensive work. Timber survives in Uppland
ramparts, though whether as palisade, revetment or internal lacing is generally
undeterminable; some superstructure above the stone is widely accepted as likely. Where
timber lacing burns, the vanished wood leaves glassy tunnels through the core.

The two great excavated reference forts are Öland limestone ringforts and must be used
with care — they are a **different building tradition** from a Mälardalen boulder rampart:
- **Ismantorp**: 127 m diameter, wall ~400 m round and 3–4 m high, **nine** gates, 88–95
  house foundations in radial blocks around a central open space.
- **Eketorp**: the only one of Öland's ~20 known forts to be **completely excavated**
  (1964–74, ~27 000 finds), in three phases — Eketorp I (300–400 CE), II (400–650 CE,
  enlarged to ~80 m diameter with 53 internal cells), III (1170–1240 CE, the stone cells
  partly replaced by ~100 timber-framed houses and a second wall added). Limestone, stacked
  without mortar. Reconstructed on site by RAÄ under Mårten Stenberger with the architect
  Nils Arne Rosén.
  **Caution on the famous 4.8 m wall height.** It is widely repeated, but it does not appear
  in the site's own reference literature; the trail leads to a 2007 popular-history article,
  not to the excavation monograph (Borg ed. 1976). Treat it as *a figure in circulation*,
  not as an excavated measurement, until someone reads the monograph. The full-scale
  reconstruction built on such readings is itself criticised — see §9.

**What it looked like.** A pale, hard-edged band of grey stone drawn along the top of a
rocky hill, following every kink of the crest, and stopping wherever the natural cliff took
over. From outside and below it read as a single continuous wall two to three-and-a-half
metres of stone high — a near-vertical face of unworked, angular granitic gneiss blocks
mostly a foot or two across, laid without mortar, slightly battered back, its face
irregular but its *line* deliberate and unbroken. From inside the fort the same wall was
barely a wall at all: the interior fill and the natural ground came up behind it, so a
defender stepped up onto a broad rubble-and-earth bank and looked over a low crest. Timber
almost certainly stood above the stone — a palisade, a breastwork, or both — but no
excavated post-setting at Broborg says what, so it is the single least constrained element
in the whole model. The entrances were narrow, 3–5 m gaps with squared, carefully built
stone cheeks, the only places where the wall's construction was visible in section. What
went on inside varies by fort and is often disputed: at some, cleared and walked-flat
patches of ground among coarse boulder moraine and bare rock outcrop; at others — just over
one in five of Uppland's Middle Iron Age forts — terraced platforms carrying real
buildings.

**Recipe.**
1. Take the measured crest polyline (`rampart.json`).
2. Sweep a wall cross-section along it: a dry-stone wall of thickness `t_wall`, outer face
   battered 5–10° from vertical, inner face merging into a soil-covered backing bank. At
   Broborg `t_wall` is a measured 4–6 m (§7.2); elsewhere it is an assumption.
3. Height from §5.1 — standing height plus the debris-apron increment — exposed as a slider
   with the band shown.
4. Skin the outer face with instanced stone: blocks sampled from the record's own stone
   range (`0,3–1 m` at Broborg; corpus median range 0.2–0.4 m), seeded per site so it is
   reproducible, laid in courses that follow the batter.
5. Cut entrances where the description places them (`I VNV och ÖSÖ … 3-5 m br`), squaring
   the wall ends into built cheeks. Middle Iron Age forts often carry an **`utskott`** — an
   extra length of wall that overlaps the entrance gap, so the approach is funnelled between
   two wall ends rather than passing straight through (Olausson 1995:143ff). Support it in
   the archetype and switch it on where the crest line's own geometry shows the overlap.
6. Optional timber superstructure — **off by default and badged conjectural**, reusing the
   existing `palisade.ts` line and material. **Place posts along the *outside* face of the
   rampart**, not on or behind the crest: that is where known standing palisades sit
   (Büchsenschütz & Ralston 1981). The first draft of this document had them on the crest,
   which the literature does not support.

| Parameter | Value / default | Tier |
|---|---|---|
| Crest line | `rampart.json`, DEM ridge extraction | Measured |
| Rampart length, width, height (present) | Parsed from description | Measured |
| Stone calibre | Parsed (`0,3-1 m st`); fallback 0.2–0.4 m | Measured / Assumed |
| Wall thickness | Measured where published (Broborg 4–6 m); else assumed | Measured / Assumed |
| Original wall height | §5.1: standing height + apron increment | **Derived** |
| Outer face batter | 5–10° | Assumed |
| Entrance positions & widths | Parsed from description | Measured |
| Timber superstructure | Off by default; 3 m posts, 0.4 m spacing, **on the outer face** | **Assumed** |
| Stone colour | Local bedrock class from SGU | Derived |

**Confidence: the line is measured, the height is bounded, the top is a guess.**

#### A.1 Not every registered `Fornborg` is a Migration Period fort — and there is a filter

This is the biggest honesty problem in the whole feature, and it only appears at national
scope. Our registry holds **1 304** records typed `Fornborg`. In Uppland, **181** are
registered — but a systematic field survey judges only about **30 of them (~17 %)** to be
Middle Iron Age forts, of which only **9** are dated by ¹⁴C or datable finds. On Södertörn
the figure is ~20 % of ~90. Olausson's dissertation reached a compatible conclusion by a
different route: only about a third of Uppland's "fornborgar" are genuinely fortified
installations, which is why he preferred the neutral term *vallanläggning*.

So **rendering all 1 304 as standing Migration Period ramparts at 500 CE would be
systematically false** for roughly four out of five of them. The rest are older enclosed
hills (*hägnade berg*), symbolic boundaries, or undatable.

The useful part: the discriminating criteria are published, and most of them are things
this pipeline already parses out of the KMR description.

| Olausson's criterion | Parseable? |
|---|---|
| `kallmurning` — dry-stone walling preserved or partly preserved | **Yes** — string match |
| Wall **≥ 1 m high** | **Yes** — already parsed (§3) |
| A wall right round, or across the non-steep side | Partly — from the crest line + DEM slope |
| `utskott` — an overlapping extra wall length, often at the entrance | Partly — from crest-line geometry |
| Overlooks its own territory or a waterway | **Yes** — the app already computes viewsheds |
| Older enclosures: wall absent on outcrop, or a merely symbolic stone row | Yes — by negation |
| Older enclosures: larger enclosed area | **Yes** — `extentSpanM` is in the registry |

The operational definition used by the Mälardalen survey is tight enough to implement
directly: *registered as `Fornborg`, with a wall right round (or across the non-steep side)
that has preserved or partly preserved `kallmurning`, and is 1 metre or more high.*

**Recommendation:** compute a `fortConfidence` per registry site from these criteria and let
it drive the reconstruction. High confidence → the full standing rampart. Low confidence →
fall back to a low stone bank or to marker mode, and say why in the popup. A site the app
cannot classify should look *unresolved*, not confidently Migration Period.

Two landscape facts worth carrying with it: of Uppland's ~30 Middle Iron Age forts, **all
but three lie directly at, or within 300 m of, water** — which interacts directly with the
app's paleo-shoreline slider, since the relevant water is the Iron Age shoreline and not
today's. And forts are argued to be associated with a nearby *storgård*, often a Tuna farm
(Carlsson 2015:161).

### B. Earth mound (`Hög`)

**Literature.** Late Iron Age mounds are built of **earth-sourced materials kept in
deliberate, unmixed layers** — rounded stones, slabs, turf, peat, sands and clays,
charcoal, moss, bark and fine gathered brushwood. Layers repeat but are very rarely mixed,
which means a mound is a *stratified construction*, not a heap. Many are raised over a
stone core or a cairn — the Håga mound near Uppsala (~1000 BCE, 7 m high, 45 m across) is
turf laid over a cairn — and the final surface is a skin of turf or stone.

**What it looked like.** A crisp, geometric dome of bare earth and laid turf, far steeper
and far more obviously artificial than the soft green swelling that survives. New, it was a
raw scar: stacked turves showing their cut edges in a spiral or concentric courses, the
soil beneath still pale where it came out of the ground, standing at close to the angle
material will hold — around 30°. On a corpus-median mound that is a dome roughly 5.7 m
across and 1.6 m high rather than today's 7 m by 0.7 m. Set on a ridge or crest, unshaded
and unvegetated, it caught the light and was meant to: mounds are placed to be seen from
the settlement below and to stand against the sky.

| Parameter | Value / default | Tier |
|---|---|---|
| Plan diameter | Parsed | Measured |
| Present height | Parsed | Measured |
| Kerb present | Parsed (`kantkedja`) | Measured |
| Original profile | §5.2, kerb-gated | **Derived** |
| Repose angle | 30° | Assumed |
| Surface | Laid turf; stacked-turf banding | Assumed |
| Robbing-pit fill | Parsed pit dimensions | Measured |

### C. Stone setting (`Stensättning`, `Grav markerad av sten/block`, `Flatmarksgrav`, `Gravgrupp`)

**Register affords.** The richest class in the corpus, 53 records: plan form (`rund`,
`kvadratisk`, `rektangulär`, `oval`, `högliknande`), diameter, height, `fylld`/filled or
not, kerb height and kerb stone calibre, central stone or block, surface stone density.

**Literature.** A stone setting is a low, close-laid stone construction over a burial,
normally with a **`kantkedja`** — a ring of selected stones bounding it — and stone packed
inside that ring. Early Iron Age examples show real formal variety: round and rectangular
plans, large centre stones, and *deliberately contrasting stone material within a single
grave*. Excavators consistently note the care taken: the graves are close to perfectly
circular and the stones were selected, not gathered at random.

**Period-specific, for Broborg's own century.** In Migration Period Uppland the rite is
cremation in *round stone settings* over urn graves or other bone containers, with burnt
layers and burnt-fill pits; mounds and cairns occur alongside. Inhumation appears especially
in chamber graves under cairns or mounds — and in Uppland specifically, inhumation dominates
Mälardalen and is **most common from the end of the 400s into the early 500s** (Ljungkvist
2011, 139), which is exactly the fort's window. Two dating notes for the sampler: `Grav
markerad av sten/block` is the *mittblocksgrav*, a Bronze Age to Early Iron Age form; and an
excavated Uppland grave field at Fullerö had 26 stone settings ranging **1.2–5.7 m** across,
which is a useful independent check on the size ranges parsed from KMR.

**What it looked like.** A flat, pale disc of close-packed stone laid deliberately into
the ground surface — much more like a paved floor than a mound. The kerb of larger, chosen
stones ran cleanly round the edge, often standing a little proud, and inside it the fill
stones were laid tight and level. Where the builders used contrasting material the effect
was graphic: a light kerb against a dark fill, or a single large centre stone or earthfast
boulder as the focus. This is the archetype whose *present* profile is closest to its
original, because flatness is the point — the reconstruction's work here is not raising it
but **cleaning it**: strip 77 % of the corpus's turf and moss back off, sharpen the kerb,
and let it read as new stone.

| Parameter | Value / default | Tier |
|---|---|---|
| Plan form & size | Parsed | Measured |
| Kerb height & stone calibre | Parsed | Measured |
| Filled vs. unfilled | Parsed (`fylld`) | Measured |
| Central stone / block | Parsed (`mittsten`, `mittblock`) | Measured |
| Height | Parsed; **not** inflated | Measured |
| Surface treatment | Turf and moss removed | Derived |

### D. Cairn (`Röse`)

**Literature.** The classic Bronze Age cairn is a layered construction, not a stone pile:
a central burial — often a cist (`hällkista`) or a wooden coffin — covered by a carefully
built **`kärnröse`** (core cairn) of large placed stones, sometimes with a turf mound over
it, and bounded by a **`kantkedja`** of large set stones or an actual dry-stone retaining
wall (`kallmur`). One excavated example had a core cairn ~5 × 6 m inside a monument ~20 m
across and ~2 m high. Cairns are sited on the highest ground available, and on the coast on
bare rock facing the water.

**What it looked like.** A bright, hard, unmistakably built dome of bare stone, blazing
light grey against dark rock or heath, with a sharp retaining edge holding it in — nothing
like the mossy, spread, lichen-blackened tumble that survives. The stones were large —
the corpus median stone range for `Röse` is 0.4–0.6 m, against 0.2–0.4 m for stone settings and
0.2–0.3 m for mounds — placed rather than tipped, and the profile stood
much closer to the ~35° that dry stone will hold. Because cairns sit on crowns and
skylines, a fresh one was visible for kilometres and stayed visible: no vegetation grew on
it while it was maintained.

| Parameter | Value / default | Tier |
|---|---|---|
| Diameter, height | Parsed | Measured |
| Stone calibre | Parsed | Measured |
| Kerb / `kallmur` | Parsed | Measured |
| Original profile | §5.2, no-kerb branch → ~35° repose | **Derived** |
| Surface | Bare stone; no moss or lichen | Derived |

### E. Fire-cracked stone mound (`Skärvstenshög`)

**Literature.** Composed of ~95 % fire-cracked stone, with soot through ~95 % of the fill
and charcoal in ~80 %. Function is genuinely contested — cooking and settlement waste,
burial monument, and ritual deposit are all argued, and some contain human remains and
bronze objects. They mark **settlement**, and that is their most useful property here: a
`Skärvstenshög` is a strong locational proxy for a nearby farm even when no `Boplats` is
registered.

**What it looked like.** A low, dark, loose mound of shattered, heat-reddened and
soot-blackened stone — angular fragments a few centimetres to a couple of decimetres
across, quite unlike the rounded field stone of a cairn — sitting at the edge of a
settlement, on a slope or beside a house. Its colour is the distinguishing feature: reds,
oranges and greys shot through with black, a rubbish heap that happens to be beautiful.
Because it accumulated rather than being built, it never had a sharp designed profile; the
corpus median of 7.6° is probably not far off, and this archetype should be **left low**.

| Parameter | Value / default | Tier |
|---|---|---|
| Diameter, height | Parsed | Measured |
| Profile | Not inflated | Measured |
| Fragment size | 0.03–0.2 m | Assumed |
| Colour | Fire-reddened + soot-blackened | Assumed |
| Settlement proximity flag | Derived from type | Derived |

### F. Standing stone & stone figure

**Register affords.** Mostly *inside* grave-field descriptions rather than as standalone
records: `resta stenar` with individual height, width and thickness — the corpus records
81 of them — plus `treudd`, `domarring` and `skeppssättning` where present.

**Literature.** Standing stones span roughly the late Bronze Age to the end of the Iron
Age. Grave fields carry figures built from set stones: three-armed `treuddar`, ring-shaped
`domarringar`, and ship settings. Recorded examples run from a 15 m ship of 24 stones up to
very large monuments. `Stenkammargrav` (and the Neolithic/Bronze Age `hällkista`) belongs to
this archetype rather than to the cairn: it is a chamber built of large set slabs, and where
one survives it is normally *inside* a cairn or mound — so it is modelled as a slab structure
that archetype B or D is then raised over.

**What it looked like.** Upright slabs and blocks of local granite, tapering upward, set
in the ground — the corpus's standing examples cluster around 0.85–2.0 m high with
0.6–1.4 m widths. Fresh-set they stood plumb, in deliberate rows, arcs or ship-outlines,
their bases packed with wedging stones and the ground round them scuffed bare. Today they
lean or lie flat: the corpus notes *"De två västra är omkullfallna"*. **Reconstruction
stands them back up** — a small, well-evidenced, high-impact operation, since a row of
upright stones reads instantly as human intent where a row of fallen ones reads as nothing.

| Parameter | Value / default | Tier |
|---|---|---|
| Height, width, thickness | Parsed per stone | Measured |
| Count and arrangement | Parsed from grave-field text | Measured |
| Fallen → upright | Re-erect | **Derived** |
| Stone type | Local bedrock (SGU) | Derived |

### G. Grave field (`Gravfält`, `Grav- och boplatsområde`)

Not a shape — a **sampler** over archetypes B–F, driven by the record's own enumeration
(§3.1) inside the measured extent polygon.

**Placement rules** (the only genuinely inferential part, and they are landscape rules,
not invented data): grave fields sit on dry, well-drained ground — ridges, eskers, rock
crowns — above and visible from the settlement, and frequently alongside a route. Monuments
cluster rather than scattering evenly, larger mounds take the highest and most visible
points, and small stone settings fill between them. Sampling must therefore be
**terrain-aware**: use the DEM for local prominence and slope, exclude wet classes using the
existing land-cover raster, and use blue-noise spacing so monuments do not intersect.

| Parameter | Value / default | Tier |
|---|---|---|
| Extent polygon | KMR geometry | Measured |
| Monument count | Parsed (`bestående av ca N fornlämningar`) | Measured |
| Class composition | Parsed enumeration | Measured |
| Per-class size ranges | Parsed | Measured |
| Individual positions | Terrain-aware blue-noise sampling | **Assumed** |
| Prominence bias | Larger monuments to higher ground | Assumed |

### H. Farmstead (`Boplats`, `Boplatsområde`, `Boplatslämning övrig`, `Husgrund, förhistorisk/medeltida`, `Boplatsvall`)

**The honest starting point: nothing is visible.** A `Boplats` record marks a scatter of
finds, dark soil, or post-holes seen in an excavation trench. There is no standing
structure to reconstruct *from*. Everything here is archetype-level inference, and this is
the archetype where reconstruction mode is furthest from the data.

**Literature.** The Scandinavian Iron Age farm is built around the **three-aisled
longhouse**: two rows of internal roof-bearing posts paired into trestles across the
building, carrying the roof on purlins. Length runs 10–50 m against 5–9 m width,
exceptionally to 80 m; the wealthiest farms sit in the 30–50 m range. Entrances are
commonly in the middle of a long wall. Farms are not single buildings: at Gene
(Ångermanland) the excavated farm has a large longhouse plus workshop and store, with a
smithy added later; the general layout is a yard in front of the houses, an outdoor hearth
area, a well, and enclosures and fields beyond.

Four details from Näsman's critical review of Scandinavian house reconstructions are worth
more than the general description, because each is a thing reconstructions routinely get
wrong:

- **The walls are real walls, at least 1 m high, and they carry load** (Näsman 1976, 120;
  Myhre 1980, 168). The 1930s Lojsta reconstruction misread very low excavated dry-stone
  walling as a mere footing under a tall steep roof; later excavation corrected this.
- **The roof is hipped, not gabled.** The bulk of Iron Age houses had hipped roofs
  (Herschend 1980; Lund & Thomsen 1982; Näsman 1983), with an opening at the top of the hip
  angle serving as a smoke vent.
- **The hip slopes at the same pitch as the long sides, or steeper — never shallower.**
  Every hipped roof in the ethnological comparanda from the Netherlands to Estonia behaves
  this way, and shallower hips are a recurring reconstruction error (the Eketorp-II houses
  built in 1978 among them). The smoke vent is also **much smaller** than usually
  reconstructed — often a fixed board with a small hole, meant to let smoke and moist air
  out rather than light in.
- **The central aisle takes less than half the house breadth from the 3rd to the 8th
  century CE**, narrower than in earlier Iron Age houses, because the walls had come to
  take a heavier share of the roof load (Hvass 1982; Myhre 1980, 178). This matters here
  precisely because it is period-specific: Näsman's explicit warning is that wall-construction
  data from a 1st-century-BC house sample cannot be used uncritically for a 5th-century
  house — which is exactly the house this app needs.

The Uppsala county research overview gives the same distinction in **metres**, for
Mälardalen, following Göthberg (2000) — which makes it directly implementable:

| Type | Central aisle | Width |
|---|---|---|
| *balanserad* | ~50 % of house breadth | 2.3–4.4 m |
| *överbalanserad* | > 50 % | — |
| ***underbalanserad*** | **~40 %** | **1.3–2.8 m** |

The *underbalanserad* form begins in the Roman Iron Age and spreads through it, so a
5th-century Uppland house should be built underbalanced: **central aisle ~40 % of breadth,
1.3–2.8 m.** Two gable types come in with it — two heavy corner posts (sometimes with a
middle post), or four posts of which two form a trestle pair (Göthberg 2000, 48). Bay length
reads as function: short bays are byre or store, long bays are the dwelling. Unusually long
houses of **35–45 m** are known from the Late Roman Iron Age around Uppsala, sited low
toward wet meadows; Fagerlund (2007) reads them as cattle-and-hay satellite farms rather
than high-status halls. Since the E4 project, markedly large and deep post-holes are
increasingly read as evidence of an **upper storey**.

Trestle spacing is not uniform along the building: it is regular and close in the byre and
more varied in the dwelling end, with a large span across the hearth area.

**Roofing is the weakest link and must be labelled as such.** There is very little
archaeological evidence for roof covering, so reconstructions everywhere fall back on
ethnological analogy from local vernacular building — thatch in Denmark, turf sods in
Norway and on Öland, with birch bark or straw as a water-shield beneath the sods. The Gene
reconstruction — 40 m × 9 m, modelled on house II at Genesmon dated ~350–600 CE, which is
precisely Broborg's period — uses **birch bark under turf** (`nävertak`) with walls of
wattle sealed with clay. That is the best regional analogue available for a Mälardalen
Migration Period farm and is the recommended default. Smaller **`grophus`** (sunken-floored
buildings) serve as workshops and stores. Näsman's verdict on the state of the art is worth
quoting as-is: *"An entirely convincing hipped roof construction is so far not presented by
any Scandinavian reconstructions."*

**What it looked like.** A long building under an enormous hipped roof — the roof easily
twice the height of the wall below it, sweeping down on all four sides so the building has
no gable, only a long ridge that stops short and falls away at each end. The covering is
turf over birch bark: green and shaggy in summer, grey-brown and flattened in winter,
thick enough to read as a slab of the ground lifted onto the house. At the top of each hip,
a small dark opening — not an open louvre, a board with a hole in it — leaking a thin
haze of woodsmoke. Below, walls a good metre or more high and clearly structural: woven
hazel or willow daubed and smoothed with clay, pale ochre-grey, patched in different
shades where it has been repaired, standing on a low footing of set stone. A wide doorway
in the middle of the long side, ground worn bare in front of it, an open yard packed hard
by feet and hooves, an outdoor hearth, a well, one or two smaller buildings and a half-sunk
workshop, and beyond them a fence and the fields.

| Parameter | Value / default | Tier |
|---|---|---|
| Location | KMR extent / point | Measured |
| Building count, position, orientation | Yard layout heuristic | **Assumed** |
| Longhouse length | 20–40 m (default 30 m) | Assumed |
| Longhouse width | 6–8 m (default 7 m) | Assumed |
| Central aisle width | **~40 % of breadth, 1.3–2.8 m** (*underbalanserad*, Mälardalen) | **Derived** (literature) |
| Wall height | ≥ 1.0 m, load-bearing | **Derived** (literature) |
| Roof form | **Hipped**, smoke vent at the top of each hip | **Derived** (literature) |
| Hip pitch | ≥ long-side pitch, never lower | **Derived** (literature) |
| Long-side roof pitch | 45° | Assumed |
| Smoke vent | Small; board with a hole, not an open louvre | Derived (literature) |
| Trestle spacing | 2.0–3.0 m; closer in the byre, wider at the hearth | Assumed |
| Roof covering | Turf over birch bark (Gene analogue) | **Assumed** |
| Walls | Wattle-and-daub on a low stone footing | Assumed |
| Ancillary buildings | 1–2 + 1 `grophus` | Assumed |

**Confidence: lowest of any archetype.** Recommend shipping it **off by default** with the
strongest caveat in the app, because it is the layer most likely to be mistaken for
evidence — and it is the one thing that makes the landscape feel inhabited, so the
temptation to leave it on will be real.

#### H.1 Archetype H is in scope — under one gate and one sourcing rule

**Amended 2026-09-12 (§11 decision 2).** H was deliberately left out of the first geometry
pass: `reconstruct.py` mapped `Boplats` and kin onto the `farmstead` archetype so the contract
was complete, and the app kept their flat markers. It is now **in scope**, for one job — the
`settlement` interior state of §7.5 — and the constraint that makes it defensible is that H is
never drawn on its own authority:

1. **Gate.** Inside a fort, H may be drawn only where §7.5.2's interior evidence gate passes
   (54 of 1 304 forts on the register, plus any fort given a cited channel-3 entry). A fort that
   fails the gate is not offered the `settlement` state at all — §7.5.3 gives the reasoning and
   the cost.
2. **Sourcing.** Where the record states a house **count**, **dimensions**, **orientation** or
   **layout**, those override the literature defaults in the table above; the defaults fill only
   what the record is silent about, and every one of them lands in `fallbacks` and costs
   `parseConfidence`. The table above is a floor, not a look.
3. **Default.** Unchanged from §9: **off by default**, with the strongest caveat in the app.
   Passing the gate makes the state offerable, not on.
4. **Outside a fort**, a free-standing `Boplats` record is *not* covered by this amendment. The
   §7.5 gate is a statement about fort interiors, and nothing in the interior survey measures
   the landscape layer. Free-standing farmsteads keep their flat markers until somebody makes
   the equivalent measurement for them.

The per-monument data this needs is specified in `docs/data-formats.md` §15 (the `farm` block);
the per-site interior evidence and state live in the same amendment's `interior` block.

### I. Field boundary (`Hägnad`, `Hägnadssystem`)

**Literature.** `Stensträngar` are the collapsed remains of single walls originally
**80–90 cm high**, and in many cases too low to have worked as barriers on their own — they
are widely read as **footings for a wooden fence above**. Their function is to separate
grazed outland from arable and meadow, with cattle droveways running from the outland in
toward the farm. They are generally of the Roman Iron Age and Migration Period — **the turn
of the era to 550 CE** — and in eastern Östergötland specifically the systems come into use
around **100 CE and go out of use around 500 CE**, contemporary with, and then ending
alongside, the Migration Period forts. Width varies far more than height: a recorded
Gotland example is ~5 m wide. One of Sweden's largest such landscapes is in Täby, southern
Uppland, ~30 km². Detailed regional studies indicate the stone rows are generally *older*
than the forts, possibly back to around year 0.

**What it looked like.** A long, low, grey-white line of stone running across the ground
for hundreds of metres, knee-high, one course wide, following contours and turning sharp
corners — and above it, probably, a fence: split rails or woven wattle hurdles carried on
paired stakes, making the whole thing chest-high and actually stock-proof. The stone alone
is what survives; the fence is inference, but the low height is precisely the evidence for
it.

| Parameter | Value / default | Tier |
|---|---|---|
| Line geometry | KMR LineString / Polygon | Measured |
| Stone calibre | Parsed; corpus median range for `Hägnad` is **1.0–2.0 m** — markedly larger than grave stone | Measured |
| Stone footing height | 0.8–0.9 m | **Derived** (literature) |
| Footing width | 0.8–1.2 m default; recorded examples reach ~5 m | Assumed |
| Timber fence above | Optional, off by default; +0.8 m | **Assumed** |
| Active period | ~0–550 CE (Östergötland systems ~100–500 CE) | Derived |

### J. Cultivated ground (`Fossil åker`, `Område med fossil åkermark`, `Röjningsröse`, `Röjningsröseområde`, `Terrassering`)

**Literature.** The oldest visible cultivation traces in Sweden, spanning the Bronze Age
into historical times. **Clearance cairns** (`röjningsrösen`) are typically **4–6 m across
and only a few decimetres high**, and occur in areas of hundreds of cairns over several
hectares; the oldest (`hackerör`) are flat and heavily turfed. **Celtic fields** — small
squarish plots with bank margins — run from the Bronze Age into the early Iron Age.
**Ridged fields** (`ryggade åkrar`) are strip-shaped with a blunt roof-like section,
recorded at 20–60 m long, 10–16 m wide, 0.3 m high; these are later. Dating is genuinely
broad: many clearance cairns are Late Iron Age, medieval, or 16th–17th century, so
**period attribution for this archetype must stay explicitly loose**.

**What it looked like.** An irregular patchwork of small, stone-picked plots on a
south-facing slope, each a few tens of metres across, their edges marked by low banks and
by the cairns of stone lifted off them — rounded knee-high heaps of field stone, bare when
fresh, sitting in and around the growing crop. Between and around, the unploughed ground:
grazed grass, scrub, and the boulders nobody moved.

| Parameter | Value / default | Tier |
|---|---|---|
| Area geometry | KMR polygon | Measured |
| Clearance cairn diameter | 4–6 m | Derived (literature) |
| Clearance cairn height | 0.2–0.5 m | Derived (literature) |
| Cairn density | Sampled to fill polygon | Assumed |
| Plot size | 20–40 m | Assumed |
| Crop / surface treatment | Reuse land-cover farmland class | Derived |
| Period | Deliberately wide; disclosed | — |

### K. Route & monument stone (`Färdväg`, `Färdvägssystem`, `Runristning`)

**Routes.** `Färdväg` records are usually hollow ways — worn, sunken tracks. A
reconstruction shows them as a *used surface*: bare, compacted, braided earth cut a little
into the slope, not a constructed road. The geometry is measured (KMR LineString);
everything about width and surface is assumed.

**Runestones — and a hard chronological warning.** Uppland has over 1 300 runestones and
almost all of them were raised between the **late 900s and the early 1100s**. Broborg's
fort is dated ~400–550 CE. **A runestone and a Migration Period fort never stood at the
same time.** Reconstruction mode is wired to the existing time slider (PLAN Phase 10), so
this is not a problem to paper over — it is the feature: at 500 CE the runestones must
simply *not be there*, and at 1050 CE the fort must be a ruin. See §8.

**What a runestone looked like.** Not the bare grey stone visitors see today. Runestones
were **painted**: red is the best-attested colour, with black used for contrast and traces
of white, and rarer yellows and blues detected by Raman spectroscopy and XRF. A fresh
runestone was a brightly coloured, high-contrast public sign — carved bands and beast
ornament picked out in strong pigment against the stone — standing at a roadside, a ford,
a bridge or a landing place where people would pass it. Pigment evidence is fragmentary and
the exact schemes are not recoverable, so colour choice is an **assumption**, and the
reconstruction should offer painted and unpainted states.

| Parameter | Value / default | Tier |
|---|---|---|
| Position / line | KMR geometry | Measured |
| Stone dimensions | Parsed where given; else 1.5–2.3 m high | Measured / Assumed |
| Paint scheme | Red ground, black detail, white highlight | **Assumed** |
| Visible only after | 950 CE | Derived |
| Hollow-way width | 1.5–3 m | Assumed |

---

## 7. Worked example — building Broborg in 3D

This is the section to hand to whoever writes the geometry. Everything here traces to
either the KMR record quoted in §3.2, the DEM, or the cited literature.

### 7.1 What Broborg is

A Migration Period hillfort ~20 km east-southeast of Uppsala, on top of an isolated hill
rising **about 40 m above the surrounding plains**, overlooking the river Storån. It is one
of only three Swedish forts that are vitrified *sensu stricto* (with Kollerborg and
Norsborg), which is why it carries an evidence base almost no other fort in the registry has.

**Setting.** Storån was part of **Långhundraleden**, the waterway linking the Uppsala region
to the Baltic, passing Broborg at the border between the ancient territories Attundaland and
Tiundaland. Kresten dates it navigable *until about 400–500 CE* — that is, the waterway went
out of use across the fort's own lifetime. For this app that is not trivia: the shoreline
slider and the fort's reason for existing are the same variable.

**Fabric and dimensions** (Kresten, Kero & Chyssler 1993 unless noted):

| | |
|---|---|
| Plan | 95 × 85 m; complete inner rampart, crescent-shaped outer rampart to the SE, entrance there |
| Form | Half-moon; N and W sides are steep slopes, left unwalled |
| Wall type | **Dry-stone, both ramparts**, built of glacial-drift boulders |
| Standing height | **~2 m**, all remaining parts |
| Wall thickness | **4–6 m (estimated)** |
| Inner wall circumference | **~200 m** (Sjöblom et al. 2022) — note KMR says "ca 300 m l" |
| Inner face | Built of **larger, equidimensional blocks, 40–60 cm**, gneissic granite |
| Inner face & top | **Soil-covered** — matching KMR's *"insidan av muren är förstärkt med jord"* |
| Timber in the wall | **"Socket-beams or other timber constructions are apparently lacking"** |
| Bedrock | Gneissic granite core under 5 m of moraine (NNW) to 10–30 m (SSE) |
| Entrances | 3–5 m wide; KMR places them VNV/ÖSÖ (inner) and ÖSÖ/NNÖ (outer) |

**Building stone.** Kresten counted 1 972 boulders and classified them: **s ≤ 20 cm,
m 20–50 cm, l 50–100 cm, vl > 100 cm** (the last exceeding 2.5 t and not humanly movable).
Small boulders dominate the inner rampart. Within 5–20 m of the fort the ground is
measurably **depleted** of small and medium gneissic granite compared with background
250 m away — they picked the hilltop clean to build it. Reconstruction should show that:
bare, stone-poor ground immediately outside the wall.

**Vitrification.** A cake along the **inner face** of the inner rampart, **1–1.5 m wide**
and **0.4–0.7 m deep** (reported variously as 0.3 m, 0.7 m, and 0.2 m at the edges rising to
0.8 m in the middle), running **~150 m of the ~200 m circumference**, with the notable
exception of the entrance. Molten amphibolite penetrating and cementing fire-cracked
gneissic granite; ~1130 °C at low oxygen fugacity; charcoal rather than wood as the fuel.
The vitrified mass forms a solid roof over frequent **hollow spaces** left by the
disintegrating fire-cracked granite beneath it. Between the outer edge of the vitrified mass
and the outer dry-stone face lie **2–4 m of unvitrified wall**, showing dry-stone setting
where preserved. The vitrified surface is **quite flat**, and the wall there resolves into
a series of **box-like structures ~1–2 m long**, suggesting it was vitrified in sections.

**Dating.**

- Charcoal from a 0.5 m deep hole just inside the inner wall, with evidence it **held a
  wooden pole**: ¹⁴C **AD 430–660** (1σ), 340–780 (2σ) (Fagerlund 2009).
- A **settlement layer inside the fort**, lying on top of the wall's weathering residue:
  ¹⁴C **AD 432–542** (1σ) (Englund 2018).
- A glass bead from inside the fort, of the period **400–575 CE** (Löfstrand 1983).
- Archaeomagnetic analysis gives three candidate intervals, of which **389–579 CE** is the
  one consistent with the radiocarbon dates.
- A TL date of 740 ± 100 AD on burnt stones just below the vitrified layer (Mejdahl 1983)
  sits awkwardly with the rest and should be mentioned, not quietly dropped.

**The live debate — render both, claim neither.** Sjöblom et al. (2022) argue the
vitrification was **intentional and constructive**, on seven grounds: amphibolite was
selectively enriched to roughly 50:50 with granite; the amphibolite has **sharp cut edges**
where nearly everything else on the hill is glacially rounded, so it was *hewn*; charcoal
imprints have straight terminations, implying charcoal prepared in advance; the box-like
sections are arranged along 150 m of wall; and cultural layers of human occupation lie *on
top of* the vitrification residue, which a destruction event would not allow. Bornfalk Back
(2023) contests the reading, and the exchange continued in print. The reconstruction must
not silently pick a side: under the constructive reading the fort looked vitrified while in
use; under the destruction reading it was ordinary dry stone until the day it burned.

### 7.2 Rampart cross-section

Sweep this along the measured crest polyline. Dimensions in metres, and — unusually for this
document — most of them are measured rather than assumed.

```
                        soil cover over inner face and top
                    ╭─────────────────────────────╮
                    │                             ▓▓▓▓▓  ← vitrified cake
   outer face       │                             ▓▓▓▓▓     1.0–1.5 wide
   dry-stone,      ╱│                             ▓▓▓▓▓     0.4–0.7 deep
   glacial        ╱ │        rubble core          ├────┤    (inner face only,
   boulders,     ╱  │   (small boulders dominant) │####│     ~150 m of 200 m,
   battered     ╱   │                             │####│     never at the entrance)
   5–10°       ╱    │                             │    │  ← hollow voids under
              ╱     │←──── 2–4 m unvitrified ────→│    │     the vitrified roof
  ───────────╱──────┴─────────────────────────────┴────┴───  ground (DEM)
             ├────────────── t = 4–6 m ──────────────────┤
                                                    inner face: 40–60 cm blocks

   h_standing = 2.0 (observed)          h_orig = 2.1–3.4, default 2.5  (§5.1)
```

Notes that change the render:

- **The outer face is the built face.** Small boulders dominate the inner rampart's fabric,
  so the outer skin reads as tightly packed small-to-medium stone, not cyclopean blocks.
- **The inner face is the coarse one** — 40–60 cm equidimensional blocks — and it is the
  face the vitrified cake sits against.
- **Soil over the inner face and top.** This is both what KMR records and what Sjöblom's
  furnace argument requires (the soil provided the confined space). So from inside the fort
  the wall reads as a turfed, soil-covered bank; the naked stone shows on the *outside*.
- The vitrified band is therefore **only visible from inside**, at the top of the inner
  face — dark, glassy, slag-like, individual stones welded into a fused mass, with the
  hewn-edged amphibolite distinguishable against rounded granite.

### 7.3 Entrances

The entrance is in the SE, where the outer rampart is. KMR gives 3–5 m widths and places
inner entrances at VNV and ÖSÖ, outer at ÖSÖ and NNÖ. Square the wall ends into built
cheeks and expose the full section — the entrance is the one place a visitor can see how the
wall is made, and it is also the one place with **no vitrification**, which is worth making
legible.

Kresten reads the outer rampart as a deliberate reinforcement of the entrance: an enemy
storming the fort would target the gate, *"probably closed by wooden constructions"*. That
is the one place a gate structure has published support, and even there it is an inference,
not a find. Middle Iron Age forts elsewhere often carry an **`utskott`** — an extra length of
wall overlapping the gap so the approach is funnelled between two wall ends (Olausson
1995:143ff); support it in the archetype and enable it where the crest geometry shows it.

### 7.4 Superstructure — the one big unknown, but now a constrained one

The first draft treated the timber superstructure as wide open. The literature narrows it in
two useful ways, and both cut against the most picturesque option.

1. **No timber lacing in the wall.** Kresten is explicit: socket-beams and other timber
   constructions are *apparently lacking* at Broborg. A `murus gallicus`-style laced rampart
   — which is what the destruction model of vitrification usually requires — has no positive
   evidence here. Keep it as a state, but label it the weakest of the three.
2. **If there was a palisade, it stood on the OUTSIDE face.** Known standing palisades are
   placed along the outside face of ramparts (Büchsenschütz & Ralston 1981), and Kresten uses
   exactly this to argue against the destruction model: a palisade burning on the outside
   cannot vitrify the inner face. This is a concrete placement rule and it replaces the first
   draft's "posts set on or behind the crest" — which was wrong.

There is one positive trace of timber: the 0.5 m deep hole **just inside** the inner wall
that held a wooden pole, ¹⁴C AD 430–660. One pole is not a palisade, and it is inside, not
outside. Show it as what it is.

Offer three named states rather than one "reconstruction", all off by default and badged
conjectural, reusing `palisade.ts`'s line and ghosted material:

- **(a) Bare stone wall, no superstructure** — the default, and the one the excavated
  evidence most nearly supports.
- **(b) External palisade** — posts along the outside face, per the placement rule above.
- **(c) Timber-laced / breastwork** — flagged as having no positive evidence at this site.

### 7.5 Interior — occupied, and now dated

This was originally written as "do not populate it with buildings." That was wrong twice
over, and the excavation literature settles the first half of it.

**Occupation is not merely evidenced, it is dated.** The 1982–83 test pits found charcoal,
burnt clay, burnt and unburnt bone (food waste) and pottery. The 2017 excavation went
further: a **settlement layer inside the fort**, superimposed on the residue of the wall's
own weathering, radiocarbon dated to **AD 432–542**. A glass bead of 400–575 CE came from
inside the fort. People were up there, in the fort's own century.

**What the interior *stone* means is still contested, and the two readings look completely
different in 3D.** Olausson (1997:110) read the loose stone on the plateau as building
remains and published a sketch of the settlement; Bornfalk Back (2023) reads the same stone
as cleared surfaces — ground picked clear, stone heaped at the margins. The Mälardalen
survey lists Broborg among Uppland forts that *may* have house terraces, with an explicit
"eventuellt". For context: 5–6 of Uppland's ~30 Middle Iron Age forts have house terraces
inside or beside them, and just over one in five is a *boplatsborg*.

**Render it as a two-state selector, exactly like §7.4's vitrification question:**

- **"Cleared surfaces"** — exposed bedrock and coarse blocks from the DEM and the SGU soil
  class, with walked-flat, stone-picked patches where KMR places them.
- **"Settlement"** — the same ground plus house terraces and archetype-H buildings, following
  Olausson's published sketch for placement rather than free invention.

Neither is "the empty option": the dated cultural layer holds under both. Default to
"cleared surfaces" as the more conservative geometry. The possible stone setting on the
crown renders as archetype C in both states.

**Answered 2026-09-12 (§11 decision 7) — and the answer generalised on the way.** The
question as posed asked only which state Broborg opens in.
`docs/interior-survey-2026-08-30.md` measured it nationally before it was answered, and that
turns a Broborg preference into a rule: **default every fort to `cleared`, and offer
`settlement` per fort, only where that fort's own record supports it — never as a national
default.** The grounds, one line each:

- **4.1 %** of the 1 304 registered forts (54) carry defensible interior-building evidence;
  **2.1 %** (27) state it without hedging; **88.4 %** (1 153) show neither building language
  nor a settlement record inside their own extent.
- The register is not *silent* about fort interiors, it disagrees: **32.2 %** of forts
  describe the inside in terrain vocabulary — *berg i dagen*, *småkuperad*, *blockrik*,
  *avplanad yta*, *våtmark* — against 4.1 % that describe a building in it. `cleared` is not
  the absence of a statement. For about a third of the corpus it *is* the statement.
- The measurement is **consistent with** the Mälardalen survey rather than contradicting it:
  17–21 % of a ~17 % Middle Iron Age subset predicts ~3 % nationally, and 4.1 % was measured.
  Nothing here overturns that survey; it shows what it implies at national scale.
- Öland (23.8 %) and Gotland (9.4 %) are enriched ~3.6× over the mainland (3.4 %). That is a
  real typological signal and it gets a branch — but only 13 of the 54 positives sit there, so
  it is a branch for 106 forts, not a new default for the other 1 198.
- Drawing longhouses in every fort would be **archetype H applied 1 304 times**: §6.H is the
  one card in the catalogue whose own heading reads *"everything visible is inference"*, and
  multiplying the weakest evidence in the taxonomy by a thousand is exactly the §6.A.1 error —
  rendering every registered `Fornborg` as a standing Migration Period wall — committed one
  level further in.

#### 7.5.1 The two interior states, fixed

**`cleared` — the default, for every fort, always available.**

- The measured DEM surface, unmodified. No flattening, no platform terracing, no invented
  building pads.
- Surface treatment from the SGU soil class and the description's own terrain vocabulary:
  exposed rock and coarse block where the record says `berg i dagen` / `blockig`, turf and thin
  soil where it says `avplanad` / `plan yta`, wet ground where it says `sankmark`.
- Stone-picked patches **only where KMR places them**, at the size and in the compass sector
  the description states — `l1955-741`'s *"…avgränsar två röjda ytor 8x6 (VNV-ÖSÖ) och 6x4 m
  (Ö-V) i den S delen av borgområdet"* is two patches, two sizes and one sector, and nothing
  more may be read out of it.
- **Nothing else.** No buildings, no hearths, no paths, no fences, no yard.

Under PLAN §6.1 `cleared` is a **Model** surface over **Measured** ground, and it needs
archetype H not at all. That is the point of it: the conservative state is not a blank, it is
the register's own account of the interior, drawn.

**`settlement` — per fort, offered only where §7.5.2's gate passes, and off by default.**

- Everything `cleared` draws, plus archetype-H geometry (§6.H) *inside* the enclosure.
- Building **count**, **dimensions** and, where stated, **layout** come from the source the
  fort passed the gate on — the KMR sentence, or for a channel-3 fort the cited publication —
  and override the archetype defaults wherever that source states them. Ismantorp's *"Innanför
  muren är 88 husgrunder, fördelade på två grupper, en yttre med husen radiellt utgående från
  murens insida…"* is a count, a grouping and a layout in one sentence; Träbyborg states *"ca
  50 husgrunder"*; a `husgrundsterrass` is routinely given as *"rektangulär, 11x7 m (Ö-V)"*,
  which is a plan and an orientation.
- Everything the sentence does not state falls back to §6.H's literature defaults, and every
  fallback is named in `fallbacks` and costs `parseConfidence`, exactly as §10 and
  `docs/data-formats.md` §14 already require of every other archetype. A house whose length
  came from the register and a house whose length came from the 20–40 m default must not read
  as equally certain in the popup.
- The state carries §6.H's caveat, which is the strongest in the app, and archetype H stays
  **off by default** (§9). Passing the gate makes the state *offerable*, not *on*.

Broborg itself keeps the selector this section already specified and opens on `cleared`, for
the reason given above: the occupation is dated, the *stone* is contested, and Bornfalk Back's
reading of that stone is the cleared one. The dated cultural layer holds under both states, and
the popup says so in both.

**The one thing `cleared` must never be allowed to say is "nobody was here."** It is a
statement about *visible, recorded structure*, which is a strict subset of occupation — and the
gap between the two is not hypothetical, it is Broborg: a settlement layer dated AD 432–542 by
excavation, invisible from the surface, on a fort whose register description says nothing about
it. Absence of a `husgrund` in a description is absence of a surveyor's note, not absence of a
house. The `cleared` state's own one-line note must carry that sentence, because a visitor
looking at an empty, competently rendered fort interior will otherwise read it as a finding.

#### 7.5.2 The interior evidence gate — which forts may offer `settlement`

This is what the implementing phase builds. It is the **strong tier** of
`docs/interior-survey-2026-08-30.md` §6 and nothing looser; that document's §6.1–§6.3 carry the
worked examples behind every rule below.

**Channel 1 — strong-tier description terms.** A hit on any of these stems, case- and
diacritic-folded, prefix-matched:

`husgrund*` · `husterrass*` · `hustomtning*` · `grophus*` · `boplatsvall*` · `boplatsborg*`

Three of the six returned no counted hit anywhere in the country (68 `husgrund`, 1
`husterrass`, 1 `boplatsborg`, zero for the rest). They stay in the list because they cost
nothing and the register is not finished being written.

A hit is **discarded** when, *within the same sentence*:

| Rule | Cues | Why |
|---|---|---|
| **Negation** | `inga`, `ingen`, `inte`, `ej`, `icke`, `saknas`, `saknar`, `avsaknad`, `utan`, `påträffades ej` | KMR writes the negation on either side of the noun — *"inga synliga anläggningar"* and *"husgrunder saknas"* — so the scope is the sentence, not a character window. 26 hits across 20 forts. |
| **Exterior placement** | `utanför`, `nedanför`, `intill`, `invid`, `N/S/Ö/V om`, `i anslutning till`, `vid foten` | The feature is outside the enclosure and belongs to the landscape, not the interior. 56 hits across 46 forts. |
| **Non-building terrace** | `odlingsterrass`, `naturlig terrass` | A cultivation terrace or a natural rock shelf is not a house. |
| **Modern building** | `sentida`, `torp`, `villa`, `sommarstuga`, `uthus`, `tegelhus`, any `19xx` date | **The discard that matters most: KMR describes a croft foundation and an Iron Age one in identical vocabulary.** 3 forts. |

An explicit **interior cue** in the same sentence — `innanför`, `inne i`, `i borgens`,
`borgplatån`, `borggård`, `i det inre` — **outranks the exterior cue**, so *"terrassering i
borgens inre, söder om vallen"* survives.

A surviving hit is flagged **hedged** when its sentence hedges: `möjlig`, `trolig`, `sannolik`,
`eventuell`, `-liknande`. Hedged hits **count** — a surveyor's *möjlig husgrund* is still the
register saying it saw something building-shaped inside the wall — but the flag travels with
the fort, into the data and into the panel, and a hedged fort must not draw a confident
longhouse. 16 of the 43 clean strong-tier forts are hedged in every hit they carry.

**Channel 2 — a settlement record inside the fort's own extent.** A KMR record of `Boplats`,
`Boplatsområde`, `Boplatslämning övrig`, `Husgrund, förhistorisk/medeltida`, `Boplatsvall` or
`Terrassering` whose representative point falls inside the fort's own extent polygon — or
inside its bounding box where the fort has only line or point geometry (43 forts). The bbox
fallback is flagged per fort and shown to the visitor, because a bounding box over a promontory
fort reaches well outside the wall.

The two channels are **independent** — one reads the fort's free text, the other queries
neighbouring records geometrically — and the gate is their **union**, never their intersection.
43 forts pass channel 1, 18 pass channel 2, 7 pass both, **54 pass the gate**. Channel 2 is a
union member rather than a check because it under-detects exactly where the evidence is best:
**Ismantorp's 88 house foundations return zero settlement records**, since KMR files them inside
the fort's own record rather than as separate lämningar.

**Channel 3 — a cited excavation, entered by hand.** See §7.5.3. Broborg is why it exists.

**Explicitly not in the gate**, and the implementing phase must not wire them in:

- `stensträng*` — 78 counted hits, and in a fornborg description it almost always describes
  **the rampart itself** (*"Ställvis har vallen endast stensträngskaraktär"*) or a field
  boundary hundreds of metres away.
- `bebygg*` — 10 hits, and it is not merely noisy but **inverted**: *"nu är så gott som helt
  bebyggd med villatomter"* means the interior is a lawn.
- bare `terrass*` — 103 hits, covering house terraces, terraced *rampart sections*, footpaths,
  natural rock shelves and 20th-century garden terraces indiscriminately. Only the compounds
  `husterrass` / `husgrundsterrass` are reliable, and they are already strong tier.
- `anläggning*` — too generic to carry a claim on its own.

The decisive check on all four is Uppsala county: 5 broad-rule hits, **zero** strong-tier hits,
and all 5 are `stensträng` or a terraced wall section on inspection. The one province with an
independently published figure is the province where the loose rule is provably wrong in every
instance.

**The Öland / Gotland branch.** The limestone ringforts are a different building tradition
(§2) — Ismantorp's 88 radial foundations, Eketorp II's 53 internal cells — and the survey finds
them enriched 3.6× (12.3 % across 106 forts against 3.4 % mainland). The branch is a **layout
and parameter** branch, not a lower gate: a fort on Öland or Gotland that passes the gate lays
its houses out radially against the inner wall face, and takes its house count and sizes from
the sentence, which on those two islands usually states both. The gate itself is identical
everywhere, and no fort is offered `settlement` for being on limestone.

**One filter this gate deliberately does not have: fort confidence.** Every rate above is over
*all* registered fornborgar, including the two in three that §6.A.1's score puts below its
threshold — so the obvious objection is that 4.1 % is measured over the wrong denominator, and
that within the forts the app actually draws as standing ramparts the rate would climb toward
the Mälardalen survey's 17–21 %. **That join has been run**, and the answer is a null:
`docs/confidence-join-2026-09-12.md` (2026-09-12) replays all 1 304 descriptions through the
shipped `fort_confidence` and cross-tabulates the result against
`docs/interior-survey-2026-08-30.json`. Its findings, which belong here because they decide the
shape of this gate:

- **433 forts (33.2 %) reach the 0.60 threshold.** Mean 0.42, median 0.30, strongly bimodal —
  441 forts at exactly 0.15, 119 at a perfect 1.00.
- Refined interior evidence runs **6.0 % above the threshold against 3.2 % below** (crude odds
  ratio 1.92, *p* = 0.026) — and that difference is **entirely description length**. Both
  variables are mined from the same block of prose; stratified by description-length quartile
  the within-band odds ratios change sign and pool to **Mantel–Haenszel OR 1.08, *p* = 0.91**
  (ten strata: OR 1.11, *p* = 0.83).
- **No dose–response.** The highest refined rate, 11.5 %, sits at score 0.55 — one notch
  *below* the threshold — and the 119 forts that score a perfect 1.00 carry it at 5.0 %, barely
  above the national 4.1 %.
- Against the 17–21 % the Mälardalen figure would predict if the score were selecting that
  population, the observed high-confidence rate is **6.0 %**, over a subset that is a third of
  the register rather than the ~17 % that prediction assumes. Uppsala — the county the four
  criteria were derived from — passes only **26.6 %**, with **zero** refined positives.

So the gate stays uniform, **and now on evidence rather than for want of the run**: interior
evidence does not concentrate in confident forts, and 4.1 % is not an artefact of the
denominator. The two scores answer different questions — one asks whether a wall was built, the
other whether a surveyor wrote down what stood inside it — and keeping them independent is the
honest consequence. A fort scoring 0.15 whose description names its own husgrunder has better
grounds for the `settlement` state than a fort scoring 1.00 whose description says nothing;
Broborg is the second of those. **One pairing the implementing phase must handle rather than
this gate:** 28 of the 54 positives fall below the confidence threshold, so a fort can be owed
a `settlement` interior while §6.A.1 refuses it a standing rampart. That is not a contradiction
— the register can record houses inside an enclosure whose wall it does not describe well
enough to rebuild — but the two states have to be drawn together honestly, low bank and all.

**Implemented 2026-09-12 in `reconstruct.py`, and it does not land on exactly 54.** The rule
above is now code (`scan_interior_terms`, `settlement_records_inside`, `INTERIOR_CITED`), and
replaying it over the survey's own 1 304 descriptions passes **53** forts rather than 54 — still
4.1 %. Three forts differ from the measurement, all three because this section's cue list is
slightly wider than the survey's own run, and each is named here rather than tolerated:

- **`l2017-4807`** and **`l2010-1595`** are dropped. Both are counted by the survey and both are
  placed outside their fort by the register's own words — *"50 m Ö om fornborgen finns
  husgrunder och skyttevärn"* and *"Inom ett streckmarkerat område **S om fornborgen** … möjligen
  husgrundsterrasser"*. The `N/S/Ö/V om` exterior cue in the table above is not in the survey's
  cue set, which is why they survived it. Drawing houses in those two forts would contradict the
  very sentence §7.5.3 requires the panel to show.
- **`l2005-1450`** is added. The survey discards it on `intill`; the same sentence opens *"I
  fornborgens SÖ del…"*, and this section says an interior cue outranks an exterior one.
- Two cues in the table are implemented **narrower than written**, because taken literally they
  are provably wrong on this corpus. `N/S/Ö/V om` fires only when the anchor is the fort itself
  — unanchored it reads *"9 m SÖ om husgrunden finns en grop"* as placing the house outside
  something, and costs five forts. "Any `19xx` date" fires only where the sentence is not
  reporting fieldwork: all four dated strong-tier sentences in the country date an *excavation
  or an inventory*, not a building, and a bare year rule discards Eketorp's 75 house
  foundations.

The divergences and the national rates are pinned in `pipeline/tests/test_reconstruct.py`, so
the next edit to the rule has to move a named number rather than a screenshot.

#### 7.5.3 What the visitor must be able to check, and what the app refuses

**A fort in the `settlement` state must be able to show the sentence it is drawn from.** Not a
citation of the register in general: the specific `beskrivning` sentence, verbatim, with the
matched term marked, the hedge flag where it hedges, and the fort's `lamningsnummer`. For a
channel-2 fort it is the neighbouring record's id, type and the geometry test that placed it
inside (polygon or bbox) instead. This is the standard §9 already sets for the §5 transforms —
publish the arithmetic, not the conclusion — and it is cheap here, because the sentence is
already in the text the parser read.

**A fort with no evidence is not offered the state at all.** Not offered-and-labelled: not
offered. Three reasons, in order of weight:

1. **A label does not travel with an image.** §9's Lojsta case is this exact failure — a
   reconstruction built from thin evidence, corrected in print within about twenty years, and
   still illustrating papers fifty years later. The caveat stayed with the publication; the
   picture went everywhere. Offering a "pure interpretation" longhouse in 1 250 forts would put
   the most persuasive geometry in the catalogue behind the weakest warning the app can write,
   once per fort.
2. **For a third of those forts it would contradict the register, not merely exceed it.** The
   32.2 % that describe their interior as rock, block and bare rise are not silent. A
   pure-interpretation state would draw houses on ground a surveyor wrote down as *berg i
   dagen*. "Nothing is invented silently" is not satisfied by inventing loudly and admitting it
   in small print.
3. **Nobody would learn anything from it.** Archetype H with no site parameters draws the same
   30 m default longhouse everywhere. 1 250 identical buildings is not a reconstruction of
   anything.

The cost of refusing is real, and it goes in the doc in the same breath, because it is the
survey's sharpest finding: **a register-derived gate undercounts.** Not one of Uppsala county's
79 forts carries a strong-tier term, yet the Mälardalen survey names 5–6 Uppland forts with
house terraces — field observation that never reached the KMR text. **Broborg itself fails this
gate**: it is `classification: "neither"`, `refinedInteriorEvidence: false` in the survey JSON,
while having the best-dated interior occupation in the corpus (AD 432–542, by excavation). A
gate that excludes the app's own reference fort is a gate with a known hole in it, and the doc
should say so rather than let the rate stand as if it were a count of occupied forts.

The honest repair is **channel 3, not a looser keyword rule**: a per-site interior evidence
entry written by hand in the pipeline, carrying a literature citation where the others carry a
KMR sentence, and shown to the visitor as that citation with its author and year. It is how
Broborg gets its selector, and it is open to any fort for which somebody does the reading.
Loosening the keyword rule would admit a hundred rampart descriptions to gain a handful of real
houses; adding a cited channel admits exactly what has been read, and says who read it. The
register measures what a surveyor wrote down, not what was there — and that sentence belongs in
the `cleared` state's own note, not only in the methods panel, because it is the one thing a
visitor standing in an empty fort interior is most likely to get wrong.

**What the app refuses to draw inside a fort**, as a list, so a reader can check it without
inferring it:

- Buildings in a fort that fails the gate — at any opacity, under any label.
- Buildings where the source does not place them: if the sentence puts houses in the S part of
  the interior, the sampler places them there and nowhere else. For a channel-3 fort the cited
  source is what licenses the placement — Broborg's comes from Olausson's published sketch, not
  from the sampler's own judgement, and the sketch is named in the popup.
- More buildings than a stated count. Fewer is allowed — the extent may not hold 88 — and the
  shortfall is a warning on the record, not a silent truncation.
- Hearths, wells, yards, fences, paths and field systems inside the wall. §6.H's yard layout is
  a *farmstead* recipe for open ground; inside an enclosure it is furniture nobody recorded.
  Only buildings the record attests, on ground the DEM measured.
- Any regrading of the measured interior to seat a building. The terrain is measured; if a
  longhouse will not sit on it, that is a finding, not a licence to flatten.

### 7.6 Scene budget

The inner and outer ramparts total ~440 m of wall. At ~3 blocks per metre of face and
~5 courses, the outer faces alone are on the order of 6–7 000 instanced stones — one
`InstancedMesh` per stone-size bucket, in the same pattern the vegetation layer already
uses. Reuse `lib/random.mulberry32` so the wall is byte-identical between reloads, and
place instances in scene space outside the terrain group so vertical exaggeration does not
stretch the stones (the invariant `palisade.ts` already documents).

---

## 8. Time behaviour — reconstruction mode belongs on the existing slider

The app already has a year slider and a period model (`lib/periods.ts`, PLAN Phase 10).
Reconstruction mode should be wired straight into it, because **the archetypes are not
contemporaneous** and pretending otherwise is the single most likely way this feature ends
up lying:

| Archetype | Built | In use | Ruin |
|---|---|---|---|
| D Cairn, E fire-cracked mound | Bronze Age | –500 CE | Iron Age onward |
| I Field boundary | ~0 CE | to ~550 CE | after ~550 CE |
| A Fort | ~400 CE | ~400–550 CE | after ~550 CE |
| B Mound, C stone setting, G grave field | continuous | 400–1050 CE | after 1050 CE |
| H Farmstead | continuous | whole Iron Age | — |
| K Runestone | ~950 CE | 950–1130 CE | — |

At 500 CE: fort standing, field boundaries in their last century of use, cairns already a
thousand years old and mossy, **no runestones**. At 1050 CE: fort long ruined, runestones
freshly painted. Three visual states per archetype — *building / in use / ruin* — with the
ruin state simply falling back to today's marker-mode geometry, which is the measured one.

This also resolves the chronology honestly rather than by omission, and it makes the time
slider do real work in reconstruction mode instead of only moving the sun and the shoreline.

**Dating caveat, unchanged from PLAN §6.2:** KMR carries almost no per-record dating, so
period attribution here is **by type** ("typisk datering"), not per site. Broborg itself is
the exception — it has excavation and archaeomagnetic dating. The methods panel must keep
saying this, and reconstruction mode makes it matter more, not less.

---

## 9. Provenance — how this maps onto PLAN §6.1

PLAN §6.1 defines three badges: **Measured**, **Model**, **Conjecture**. Reconstruction
mode's three tiers (§1) map on cleanly, and no new badge is needed:

| §1 tier | §6.1 badge | Treatment |
|---|---|---|
| Measured | **Measured** | Opaque, naturalistic |
| Derived | **Model** | Naturalistic rendering permitted (2026-08-22 amendment); the derivation rule quoted verbatim in the methods panel, exactly as the land-cover rules are |
| Assumed | **Conjecture** | Ghosted, cool hue, permanent "conjectural" tag |

Three rules follow, and they are what keep the mode honest:

1. **A reconstructed monument is not one badge.** A mound is Measured in plan, Model in
   profile, Conjecture in surface treatment. The popup should say so per part rather than
   averaging to a single reassuring label.
2. **The mode itself is disclosed, not just the layers.** Switching to reconstruction mode
   fires its own caveat — reconstruction mode shows *interpretations*, the marker mode
   shows *the register* — and the mode is named in About & credits alongside
   `PROVENANCE_SUMMARY`.
3. **Every §5 transform is reversible and quoted.** The methods panel gets the actual
   formulae from §5.1 and §5.2 and the sensitivity table, in the same style
   `rampart.json`'s `derivation.description` already uses for the crest extraction. A
   visitor who wants to know why the wall is 2.9 m and not 1.5 m can read the arithmetic.

**A cautionary case worth keeping in view.** The first Swedish Iron Age house
reconstruction was built at Lojsta on Gotland in the 1930s from a handful of excavated
plans. Its wall construction was wrong — excavated low dry-stone walling was misread as a
footing under a tall steep roof, where later excavation showed real load-bearing walls at
least a metre high — and Stenberger said so within about twenty years. Näsman's review
notes that the Lojsta house was *still* being used to illustrate papers on Gotland Iron Age
settlement fifty years after the criticism. A built reconstruction outlives the evidence
that justified it and crowds out its own corrections. A rendered one propagates faster and
costs nothing to copy. That is the risk this section exists to manage, and it is the reason
the §5 transforms are published with their arithmetic rather than their conclusions.

Recommended defaults, following the 2026-08-23 amendment (model and conjecture layers
default ON) but with one exception:

- Archetypes A–G, I–K: **on** in reconstruction mode.
- Archetype H (farmstead): **off by default.** It is the least evidenced and the most
  persuasive, which is the worst combination in the app. Inside a fort it is additionally
  *gated*, not merely defaulted off: §7.5.2 decides which forts may offer it at all, and
  §7.5.3 says why a fort without evidence is not offered the state even behind a label.

---

## 10. Proposed data contract

Reconstruction mode should add **one** file per site and change nothing existing.
`sites.json` stays exactly as `docs/data-formats.md` §3 defines it — it is the register,
and the register should not acquire interpretation.

`reconstruction.json` (sketch; to be fixed properly in `docs/data-formats.md` before any
app code is written):

```jsonc
{
  "schemaVersion": 1,
  "site": "broborg",
  "generated": "<ISO date>",
  "derivation": {
    "description": "<verbatim prose, as rampart.json does>",
    "transforms": ["rampart-section-conservation", "mound-reprofile", "pit-fill"],
    "params": { "alpha": 0.5, "packing": 0.85, "reposeEarthDeg": 30, "reposeStoneDeg": 35 }
  },
  "monuments": [
    {
      "id": "L1940:6792",              // joins back to sites.json
      "archetype": "stone-setting",    // §4 archetype key
      "period": { "builtCE": -200, "abandonedCE": 550 },
      "plan": { "form": "round", "diameterM": 8.0 },
      "profile": { "heightM": 1.2, "source": "measured" },
      "features": { "kerb": { "heightM": 1.2, "stoneM": [0.7, 1.4] } },
      "pits": [ { "widthM": 2.0, "lengthM": 1.5, "depthM": 0.5 } ],
      "tiers": { "plan": "measured", "profile": "measured", "surface": "assumed" },
      "parseConfidence": 0.9
    }
  ]
}
```

Constraints inherited from the existing contract (`docs/data-formats.md` §0, §8):

- **Local `[x, z]` coordinates only.** No EPSG:3006 numbers reach the app.
- **No heights in the data.** Ground height is sampled at runtime through the app's ground
  sampler so monuments can never drift from the terrain — the invariant `palisade.ts`
  already enforces. Monument *heights above ground* are fine; ground elevation is not.
- **Vertical exaggeration is a render-only Y scale on the terrain group.** Reconstructed
  monuments live outside that group and position themselves at `y = ground · exaggeration`
  while keeping true metric height.

The parser producing this file belongs in a new `pipeline/fornborg_pipeline/reconstruct.py`
and must record `parseConfidence` per record, because §3's coverage is high but not total —
8 % of records have no parseable plan size at all and must fall back to archetype defaults
or be skipped rather than guessed.

---

## 11. Open questions for the owner

**Four answered 2026-08-26**, before the first geometry pass was written, and **two more
(2 and 7) answered 2026-09-12** on the evidence of `docs/interior-survey-2026-08-30.md`,
before any interior geometry was written. All six are marked **Answered** below with what was
decided and what the build — or, for 2 and 7, the specification — added. The rest still stand.

1. ~~**Does reconstruction mode replace or overlay the markers?**~~ **Answered: replace, with
   a hard toggle** — the switch sits next to the fort's name in the HUD header. A monument
   rendered both as a 3D mound and as a flat coloured dot is worse than either. One
   qualification the build added: §8's *ruin* state falls back to the flat marker, which is
   the measured geometry, so in reconstruction mode the markers that remain are exactly the
   ruins and the archetypes not yet drawn — 23 of Broborg's 127 at 500 CE.
2. ~~**Is the farmstead archetype (H) in scope at all for v1?**~~ **Answered 2026-09-12: yes,
   inside a fort, gated — and still off by default.** It was deliberately left out of the first
   pass; `reconstruct.py` parsed `Boplats` and kin into the `farmstead` archetype so the
   contract was complete, and the app kept their flat markers. Closing decision 7 needs H,
   because the `settlement` interior state *is* archetype H, so it comes into scope with the
   constraint written into §6.H.1: it may be drawn inside a fort **only** where §7.5.2's
   interior evidence gate passes, the record's own house counts and dimensions **outrank** the
   literature defaults wherever it states them, and every default that fills a gap is listed in
   `fallbacks` and costs `parseConfidence`. Two qualifications the decision adds: it stays off
   by default under §9 — passing the gate makes the state *offerable*, not on — and a
   **free-standing** `Boplats` outside a fort is **not** in scope, because the interior survey
   measured fort interiors and nothing else. Those keep their flat markers.
3. ~~**Do we render the vitrified band at Broborg as an in-use feature?**~~ **Answered: yes,
   as a state.** It is drawn along the top of the inner face, 1.0–1.5 m wide, with the
   Sjöblom-vs-Bornfalk-Back debate stated in the methods panel and a toggle that takes it
   away. The §7.4 superstructure selector it was to be tied to is *not* in the first pass, so
   the band currently stands on its own toggle; wiring the two together is a second-pass job.
4. ~~**How far does the time slider drive reconstruction?**~~ **Answered: the cheaper v1** —
   one "in use" state per archetype plus a gate on the built/abandoned years. The build split
   the gate three ways rather than two, because "not yet built" and "ruined" are not the same
   thing: before `builtCE` nothing is drawn at all (so at 500 CE there are no runestones),
   and at or after `abandonedCE` the monument falls back to its §3 marker, which is what §8
   already says the ruin state should be. Full three-state geometry remains open.
5. **National scope.** Broborg has a uniquely rich record. A registry fort in Västra Götaland
   may have three lines of description. The parser must degrade to archetype defaults, and the
   app must show *how much* of a given site is measured versus defaulted — otherwise a
   thin-record fort silently renders as confidently as Broborg.
6. ~~**Do we implement `fortConfidence` (§6.A.1) before shipping national reconstruction?**~~
   **Answered: yes, and it is implemented.** `reconstruct.py` scores all four of the
   Mälardalen survey's criteria per fort — `kallmurning` preserved, a wall ≥ 1 m, a wall
   right round or across the non-steep side, and an enclosure compact enough not to read as a
   *hägnat berg* — and writes the score, the threshold and the individual criteria into
   `reconstruction.json`. Below the threshold the app draws the low bank the register records
   and the popup says which criteria failed. Broborg scores 1.00 on all four. *The outstanding
   item — a look at the score **distribution** across the 1 304 registry forts — was discharged
   2026-09-12 by `docs/confidence-join-2026-09-12.md`, which replays every registry description
   through the shipped `fort_confidence`:* **433 forts (33.2 %) reach the 0.60 threshold** and
   871 render as the low bank; mean 0.42, median 0.30; the distribution is strongly bimodal,
   with 441 forts at exactly 0.15 and 119 at a perfect 1.00. Two properties of the score that
   doc states plainly and that national scope should carry: `compactEnclosure` passes 93.3 % of
   forts, so it functions as a near-constant offset rather than a discriminator, and **no fort
   with a description under 200 characters reaches the threshold** — the score partly measures
   how much the surveyor wrote. County pass rates spread from 75.9 % to 3.4 % for the same
   reason, so the score must not be read as a map of Migration Period fortification.
7. ~~**Which Broborg interior state is the default (§7.5)?**~~ **Answered 2026-09-12:
   `cleared`, and not only at Broborg — `cleared` is the default for all 1 304 forts, with
   `settlement` a per-fort state and never a national one.** The question was asked about one
   fort; `docs/interior-survey-2026-08-30.md` measured it across the register first, and the
   measurement decided it: **4.1 %** of forts (54) carry defensible interior-building evidence,
   **2.1 %** state it without hedging, **88.4 %** show none — and **32.2 %** describe their
   interior in terrain vocabulary instead, so for a third of the corpus `cleared` is not a
   blank but the register's own account, drawn. A `settlement` default would be archetype H
   applied 1 304 times: the weakest evidence in the taxonomy, multiplied, and wrong for ~96 %
   of forts on the register's own text. Three qualifications the build must carry: **(a)** the
   gate is the survey's *strong* tier only (§7.5.2) — `stensträng*`, `bebygg*` and bare
   `terrass*` are excluded, because in a fornborg description the first two mean "the rampart"
   and "modern houses destroyed this"; **(b)** a fort in `settlement` must be able to show the
   visitor the KMR sentence it is drawn from, and a fort with no evidence is **not offered the
   state at all** rather than offered it labelled (§7.5.3 argues it, including the argument
   against); **(c)** the gate is known to undercount — no Uppsala fort carries a strong-tier
   term although the Mälardalen survey names 5–6 with house terraces, and **Broborg itself
   fails the gate** despite an excavated, dated interior settlement layer. The repair is
   §7.5.2's cited channel 3, a per-site entry carrying a literature citation, not a looser
   keyword rule. Öland and Gotland get a layout branch (§7.5.2), not a lower gate. **(d)** the
   gate is **uniform, and tested**: the obvious objection — that 4.1 % is measured over all
   1 304 forts rather than over the third the app draws as standing ramparts — was answered by
   the join in `docs/confidence-join-2026-09-12.md`, which finds **no** concentration of
   interior evidence in high-confidence forts (6.0 % vs 3.2 % crude, but Mantel–Haenszel
   OR 1.08, *p* = 0.91 once description length is controlled, and no dose–response). Fort
   confidence is therefore out of this gate on evidence, not for want of the measurement.
   Contract: `docs/data-formats.md` §15.
8. ~~**Do we need a section measured through a rampart?**~~ **Answered — and better than
   hoped.** Two excavated cross-sections through Broborg's inner wall are published as
   drawings (Sjöblom et al. 2022, Figs. 5a/5b; the same sections as Englund 2018, Figs. 9–10),
   from the October 2017 excavation. §5.1 and §7.2 are now built on the published wall
   thickness rather than on inference. Remaining action: obtain Englund 2018 in full for the
   layer detail behind those figures — it is an Upplandsmuseet report and should be findable
   through Arkivsök.
9. **Which dating do we show for the fort?** The radiocarbon, archaeomagnetic and bead dates
   converge on roughly 430–580 CE, but a TL date of 740 ± 100 AD on burnt stone beneath the
   vitrified layer does not fit. Recommendation: drive the app from the converged range and
   disclose the outlier in the methods panel rather than dropping it.
10. **Do we model Långhundraleden as navigable?** Kresten has the waterway navigable until
   ~400–500 CE, i.e. it silts and lifts out of use across the fort's own lifetime. The app
   already has a shoreline slider, so this is reachable — and it is arguably the fort's whole
   reason for being where it is.

---

## 12. Sources

Hillforts, and Broborg specifically:

- Michael Olausson, *Det inneslutna rummet* (diss. Stockholm 1995) and the project *Borgar och
  befästningsverk i Mellansverige 400–1100 e.Kr.* — typology, the "vallanläggning" term, and
  the finding that ~1/3 of Uppland's forts are genuinely fortified.
  https://sv.wikipedia.org/wiki/Michael_Olausson_(arkeolog)
- *Fornborg*, Swedish Wikipedia — general construction, distribution, palisade evidence.
  https://sv.wikipedia.org/wiki/Fornborg
- **Fornborgar i Mälardalen** — the systematic Uppland/Södertörn field survey. Three pages
  are load-bearing for this document:
  *Sammanfattning Uppland* (181 registered vs. ~30 Middle Iron Age forts, 9 dated; siting
  within 300 m of water; house terraces and *boplatsborgar*) —
  https://fornborgar.se/sammanfattning-uppland/ ·
  *Husby-Långhundra 156 Broborg* (95×85 m, "highest wall height 2 m, widest 5 m"; the
  contested interior; the 1982–83 test pits) —
  https://fornborgar.se/husby-langhundra-1561-broborg/ ·
  *Datering av fornborgar* (Olausson's discriminating criteria and the survey's operational
  definition) — https://fornborgar.se/datering-av-fornborgar/
- Secondary citations reached through those pages, listed so they can be chased in full text:
  **Olausson 1995**:53, :143ff (typology A/B; `utskott`); **Olausson 1997**:110 (Broborg
  interior read as buildings, with a settlement sketch); **Olausson 2009**:44 (siting);
  **Fagerlund 2009** (summary of the lost 1982–83 Broborg test-pit report); **Bornfalk Back
  2023** (interior read as cleared surfaces); **Schneider 2011**:190–192 (the *bro* element
  as a boat landing); **Carlsson 2015**:161 (forts and *storgårdar* / Tuna farms); **Åsa
  Wall 2003**, *De hägnade bergens landskap* (Södertörn).
- Kaj Borg (ed.), *Eketorp: fortification and settlement on Öland/Sweden. The monument*
  (Royal Acad. of Letters, History and Antiquities, 1976) — the Eketorp excavation
  monograph. **Not consulted**; it is where the wall-height question should be settled.
- **Peter Kresten, Leif Kero & Jan Chyssler, "Geology of the vitrified hill-fort Broborg in
  Uppland, Sweden", *Geologiska Föreningens i Stockholm Förhandlingar* 115:1 (1993), 13–24.**
  Read in full. The primary source for §7.1 and §7.2: dry-stone construction of both
  ramparts, ~2 m standing height and 4–6 m estimated thickness, absence of socket-beams,
  40–60 cm inner-face blocks, the boulder-size classification and depletion survey, the
  2–4 m unvitrified zone, the soil-covered inner face and top, palisade placement on the
  outer face, and the constructive-vitrification argument.
  https://www.broborg.org/0_auxiliary/Geology_of_the_vitrified_hill_%20fort_%20Broborg_etc.pdf
- **Rolf Sjöblom et al., "Assessment of the reason for the vitrification of a wall at a
  hillfort. The example of Broborg in Sweden", *J. Archaeological Science: Reports* 43
  (2022), 103459.** Read in full (open access via OSTI). Source for the ~200 m inner-wall
  circumference, the ~150 m vitrified run, the excavated cross-sections (Figs. 5a/5b), the
  dated settlement layer (AD 432–542), the pole-hole date (AD 430–660), and the seven-point
  case for intentional vitrification. https://www.osti.gov/pages/biblio/1869778
- Secondary Broborg literature cited by the above, for follow-up: **Löfstrand 1982/1983**
  (first excavation); **Englund 2018a/b**, *Broborg fornborg / Broborg hillfort: a research
  study of the vitrified wall*, Upplandsmuseet (the 2017 excavation, and the source of the
  section drawings); **Fagerlund 2009** (synthesis of the 1982–83 work); **Kresten &
  Ambrosiani 1992**; **Kresten & Kero 1992**; **Mejdahl 1983** (the outlying TL date);
  **Ambrosiani 1961** (Långhundraleden); **Büchsenschütz & Ralston 1981** (palisade
  placement).
- *Archaeomagnetic dating of vitrified Broborg hillfort in southeast Uppsala, Sweden*,
  Journal of Archaeological Science: Reports.
  https://www.sciencedirect.com/science/article/abs/pii/S2352409X20301024
- Sjöblom et al., *Assessment of the reason for the vitrification of a wall at a hillfort:
  the example of Broborg in Sweden* (NIST/OSTI).
  https://www.nist.gov/publications/assessment-reason-vitrification-wall-hillfort-example-broborg-sweden
- Bornfalk Back, *The vitrified wall of Broborg hillfort in Uppland, Sweden — a comment on
  Sjöblom et al. (2022)* — the opposing reading.
  https://www.sciencedirect.com/science/article/pii/S2352409X23000792
- *Reproduction of melting behavior for vitrified hillforts based on amphibolite, granite, and
  basalt lithologies*, Scientific Reports.
  https://www.nature.com/articles/s41598-020-80485-w
- *Eketorps borg* and Eketorp reconstruction commentary — wall height from collapse volume,
  phasing, cell count. https://sv.wikipedia.org/wiki/Eketorps_borg ·
  https://popularhistoria.se/vetenskap/arkeologi/svenska-fornminnen-eketorps-fornborg-unik-befastning-inspirerad-av-romarna
- *Ismantorp Fortress* — diameter, wall height, nine gates, radial house blocks.
  https://en.wikipedia.org/wiki/Ismantorp_Fortress
- *Arrangement of space inside Ölandic ringforts* (Lund student paper).
  https://lup.lub.lu.se/student-papers/record/8992278/file/8992283.pdf
- Erik Andersson, *Sjöbergs fornborg och Täbys storgårdar: om relationen mellan bygd och borg
  under mellersta järnåldern i Uppland*. https://libris.kb.se/bib/19452789
- *Vitrified fort* — appearance of vitrified masonry.
  https://en.wikipedia.org/wiki/Vitrified_fort
- Oxford Reference, *box rampart* and *timber-laced rampart*; and hillfort rampart archaeology.
  https://www.oxfordreference.com/view/10.1093/oi/authority.20110803104638125 ·
  https://fortified-britain.com/archaeology-of-hillforts-ramparts/

Graves and grave fields:

- *What Makes a Mound? Earth-Sourced Materials in Late Iron Age Burial Mounds*, Cambridge
  Archaeological Journal — layered, unmixed mound construction.
  https://www.cambridge.org/core/journals/cambridge-archaeological-journal/article/what-makes-a-mound-earthsourced-materials-in-late-iron-age-burial-mounds/FF14741EBD54FDA39286CBC9507274F9
- Historiska museet, *Burials in the Iron Age*.
  https://historiska.se/en/explore-history/history-hub/burials-in-the-iron-age/
- Arkeologerna, *Omsorgsfullt och strävsamt stenarbete* — kerb chains, stone selection,
  form variety. https://arkeologerna.com/bloggar/liv-och-dod-under-jarnaldern-i-malardalen/omsorgsfullt-och-stravsamt-stenarbete/
- Arkeologerna, *Kantkedjor och kallmurar* / *Röset vid Arendal* — core cairn, kerb, dry-stone
  retaining wall, dimensions. https://arkeologerna.com/bloggar/arendal-pa-hisingen/kantkedjor-och-kallmurar/
- *Stensättning*, *Gravröse*, *Gravhög*, *Hällkista* — Swedish Wikipedia type definitions.
  https://sv.wikipedia.org/wiki/Stens%C3%A4ttning · https://sv.wikipedia.org/wiki/Gravr%C3%B6se
- *Håga mound* — turf over a cairn, dimensions. https://en.wikipedia.org/wiki/H%C3%A5ga_mound
- Upplandsmuseet, *Kättsta — boplatser och gravar under 2 000 år* (E4 excavations, Uppland).
  https://www.upplandsmuseet.se/globalassets/publikationer/rapportserien/rapporter-2006/2006_07.pdf
- **Tina Fors, *Brons– och järnålder i Uppsala län — uppdragsarkeologisk kunskapsöversikt
  2013*, Länsstyrelsens meddelandeserie 2014:06.** Read in full. The regional synthesis
  behind §6.C's period-specific grave forms and §6.H's metric aisle typology (after Göthberg
  2000 and Göthberg 2000:48; also Ljungkvist 2011:139, Ljungkvist & Victor 2007, Engström &
  Wikborg 2007, Lagerstedt 2009, Fagerlund 2007:177/189).
  https://www.lansstyrelsen.se/download/18.1b1d393819324610c374987f/1732517954020/Brons%E2%80%93%20och%20j%C3%A4rn%C3%A5lder%20i%20Uppsala%20l%C3%A4n.pdf
- *Skärvstenshögar med gravgömmor i östligaste Mälarområdet* — composition and function debate.
  https://www.academia.edu/111316862/

Settlement and landscape:

- Ulf Näsman, *Aspects on Realizing House Reconstructions: a Scandinavian Perspective*,
  EXARC Journal 2013/2 — **the source for most of §6.H**: load-bearing walls ≥1 m, hipped
  roofs with a hip pitch never shallower than the long sides, small board-and-hole smoke
  vents, the period-specific central-aisle proportion, the roofing-evidence gap, and the
  Lojsta cautionary tale used in §9.
  https://exarc.net/issue-2013-2/ea/aspects-realizing-house-reconstructions-scandinavian-perspective
  Secondary citations within it, for full-text follow-up: Näsman 1976:120 and Myhre 1980:168
  (wall height); Herschend 1980, Lund & Thomsen 1982, Näsman 1983:200 (hipped roofs); Hvass
  1982 and Myhre 1980:178 (central-aisle proportion, 3rd–8th c.); Åhstrand 1768 (Öland sod
  roofs over birch bark); Boethius & Nihlén 1932 (Lojsta).
- *Gene fornby* / *Genesmon* — the 40 × 9 m reconstructed longhouse on house II, ~350–600 CE,
  birch-bark-and-turf roof, clay-sealed wattle walls.
  https://en.wikipedia.org/wiki/Gene_fornby · https://sv.wikipedia.org/wiki/Genesmon
- Per H. Ramqvist, *Gene: On the origin, function and development of sedentary Iron Age
  settlement in Northern Sweden*. https://www.academia.edu/2120243/
- *Grophus*, Swedish Wikipedia. https://sv.wikipedia.org/wiki/Grophus
- *Stensträng*, Swedish Wikipedia — original 80–90 cm height, fence-footing reading.
  https://sv.wikipedia.org/wiki/Stenstr%C3%A4ng
- Mats Widgren, *Stensträngssystemens datering*; Alf Ericsson, *Stensträngar i Uppland och
  fossila åkrar i Södermanland*. http://widgren.blogspot.com/2006/05/stenstrangssystemens-datering_298.html ·
  https://www.academia.edu/4079464/
- Länsstyrelsen Östergötland, *Äldre järnålderslandskap vid Grävsten*.
  https://www.lansstyrelsen.se/ostergotland/besoksmal/kulturmiljoer/aldre-jarnalderslandskap-vid-gravsten.html
- *Fossil åkermark*, Swedish Wikipedia and NE — clearance cairn and ridged field dimensions.
  https://sv.wikipedia.org/wiki/Fossil_%C3%A5kermark

Runestones:

- Riksantikvarieämbetet, *Runstenar* and *Runstenar i Sverige — Uppland* — counts, dating,
  placement at routes and waterways. https://www.raa.se/kulturarv/runor-och-runstenar/runskolan/runstenar/
- *How to decorate like a Viking* (ScienceNordic) — pigment evidence and colour analysis.
  https://www.sciencenordic.com/denmark-history-society--culture/how-to-decorate-like-a-viking/1455997

Primary data used in §2, §3 and §5: `app/public/data/broborg/sites.json` (RAÄ/KMR, CC0,
fetched 2026-08-20) and `pipeline/registry.json` (1 304 forts, national KMR extract).

**Access note (updated 2026-08-25, after the second allowlist change).**

Read in **full text** this pass: Kresten, Kero & Chyssler 1993 (broborg.org); Sjöblom et al.
2022 (OSTI); Fors 2014 (Länsstyrelsen Uppsala); Näsman 2013 (EXARC); the Mälardalen fort
survey (fornborgar.se); Swedish Wikipedia. Downloaded but not mined in depth: the Kättsta E4
report (Upplandsmuseet 2006:07) — it is a two-column layout that defeats plain text
extraction, and the Fors synthesis already covers the same ground more usably.

Still unreachable: **DiVA** (`diva-portal.org` fails at connect), and `cambridge.org`,
`sciencedirect.com`, `tandfonline.com`, `academia.edu`, `researchgate.net` all return HTTP
403 — that is the publishers' own bot-blocking rather than the network policy, so allowlisting
cannot fix it. `arkivsok.raa.se` now resolves and is the route to the Englund 2018 report.

**Samla has been retired.** `samla.raa.se` redirects to a dead page; RAÄ's publications moved
to DiVA and its archaeological reports to Arkivsök.

**What changed in this document as a result.** Sections rewritten from primary sources rather
than summaries: §5.1 (the rampart transform — method changed, not just numbers), §7.1–§7.5
(the whole Broborg worked example), §6.H (house construction), plus additions to §6.A, §6.C
and §11.

Corrections the primary sources forced, listed so the diff is auditable:

| First draft said | Sources say |
|---|---|
| Rampart height 1.0–6.1 m, unpinnable | **2.1–3.4 m**, because the wall is *still standing* 2 m at a measured 4–6 m thickness |
| KMR's 8–15 m vs. literature 4–6 m is the document's worst ambiguity | Resolved: spread vs. wall body. The transform now consumes both |
| Palisade posts "set on or behind the crest" | Palisades stand on the **outer face**; Kresten uses this against the destruction model |
| Timber lacing an open possibility | **"Socket-beams or other timber constructions are apparently lacking"** at Broborg |
| "Do not populate the interior with buildings" | A **dated settlement layer**, AD 432–542, inside the fort |
| Eketorp's 4.8 m wall as method exemplar | Figure's provenance is weak; §5.1 no longer needs it |

**Remaining verification debt.** Englund 2018 (Upplandsmuseet) for the 2017 section detail;
the Eketorp monograph (Borg ed. 1976) for the wall-height question; and the Cambridge
mound-materials paper behind §6.B, which is still only a summary.
