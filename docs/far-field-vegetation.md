# Far-field vegetation — the Phase-9d design

**Status: design, 2026-08-22. Docs before code — nothing here is implemented, and
the contract amendment sketched in §6 is recorded in `docs/data-formats.md` only
when the code that writes it lands.** Companion research document (zones,
species, openness): `docs/vegetation-zones.md`.

**The problem.** The modelled landscape (contract §9/§10) stops dead at the 4×4 km
context edge while terrain runs to 64 km (§11 rings). Standing on a rampart with
the layer on, the world is Iron Age for 2 km and bare modern hillshade beyond — a
hard rectangular seam in the one view (first-person on the fort) the whole horizon
guarantee was built for. Owner steer: extend ground colour over the whole extent,
and use progressively simpler tree representations outward — 2D silhouettes far
out.

**Measured constraints this design must respect [measured 2026-08-22, this
session]:**

- `MAX_INSTANCES = 150_000` (`app/src/landcover/vegetation.ts`) covers the
  1,600 ha context, and Broborg already sits near it (~99 k static + ~37 k
  shore-band capacity).
- Extending full instancing outward is not a tuning problem but an impossibility:
  at ~100 trees/ha over 30 % forest, ring4 (16×16 km) ≈ 770 k trees, ring6
  (64×64 km) ≈ 12 M, ring7 ≈ 49 M. Instances cannot reach the horizon.
- Angular size does the work instead: a 13 m tree subtends ~6 px at 2 km
  (60° FOV, ~1000 px viewport), ~1.5 px at 8 km, sub-pixel past ~12 km. Beyond
  8 km *no per-tree representation of any kind is visually distinguishable from
  ground colour plus surface roughness*.

## 1. The distance ladder (decision)

| Band | Representation | Budget |
|---|---|---|
| 0 – 2 km (context extent) | Full 3D instances, exactly as today — geometry, budget, shore-band machinery all unchanged | ≤ 150 k (existing) |
| 2 – 8 km (context edge → ring4 edge) | Upright cross-section **billboards**, one quad per tree, sampled from the far-field class rasters (§4) at **10 stems/ha** in forest classes | ~72 k worst case (below) |
| 8 km + (rings 5–7) | **Ground tint + canopy roughness only**: the far-field class wash on the ring meshes, with a normal-perturbation noise band in forest classes so low sun reads as canopy texture, not billiard felt | 0 instances |

Arithmetic for the billboard band [measured constraint, computed]: the 2–8 km
annulus is 16×16 − 4×4 = 240 km² = 24,000 ha; at 30 % forest and 10/ha that is
**72 k quads** — comfortable (a quad is 2 triangles; 72 k quads ≈ 144 k
triangles, a fraction of one ring mesh). Cap it with the same proportional-scale-
and-log mechanism as `MAX_INSTANCES`, as a separate `FAR_MAX_INSTANCES = 80_000`:
the near budget must not shrink because a site has forested far hills.

Density honesty: 10/ha against the model's 90–120/ha means the band renders
**roughly one tree in ten as a stand-in for the stand** — same spirit as the
schematic near-field forms, and disclosed in the methods panel in exactly those
words. Density does *not* fall off with distance within the band: perspective
already provides apparent thinning, and a real gradient would misreport the model
(a farther forest is not a thinner forest). The alternative (graded density) was
considered and rejected on that ground.

`large`-preset sites (context 8×8 km, 3 sites): the band runs from *their*
context edge (±4 km) to ±8 km; the arithmetic only shrinks.

## 2. Billboard orientation (decision needed — recommendation: camera-facing)

Two candidates, per the owner's note:

- **Fixed side-on to the site centre.** Cheapest (static geometry), and exactly
  right for the first-person viewpoint the horizon guarantee is defined for
  (scale-out §2b): from the fort, every billboard is face-on. But orbit mode —
  the *default* camera, and the picker's landing view — swings the eye through
  90°: the same billboards go edge-on and the forest **vanishes**, silently, in
  the mode most users see first.
- **Camera-facing (cylindrical, Y-axis) in the vertex shader.** Each quad rotates
  about its own vertical axis to face the camera azimuth, staying upright. Cost:
  a few vertex-shader instructions on 4 vertices per tree, no per-frame CPU work,
  no matrix updates — measured against everything else in a frame this is noise.
  Deterministic placement is untouched (position/height from the seed; only the
  facing is view-dependent).

**Recommendation: camera-facing.** The side-on optimization saves nothing that
matters and fails a first-class documented mode; a forest that exists or not
depending on camera azimuth is precisely the kind of silent visual lie this
project refuses. If profiling on low-end devices ever contradicts the "noise"
claim (it should not — this is standard impostor technique), the fallback is
side-on *in first-person only*, never in orbit. Held for the owner's sign-off
rather than silently picked, per the phase brief.

Shading: flat class colour slightly darkened versus the ground tint, no texture;
at 2–8 km a billboard is 1–6 px tall, so silhouette and colour are the entire
information content. The near/far seam at the context edge gets a ~200 m overlap
in which 3D instances fade out and billboards fade in, so the transition is a
cross-fade rather than a line.

## 3. Suppression in water

Billboards live entirely inside ring4, and ring4 is the ring that may carry a
`waterConnect` grid (§11). Where it exists, billboard placement applies the same
rule as near-field vegetation — suppressed at `connect ≤ current level` — so the
Iron Age bay stays treeless to 8 km. Where a site ships no far-water grid (13 of
27 pilot sites), there is no paleo-water beyond the context either, and terrain
elevation is *not* used as a stand-in (the uplift-gradient caveat of §2b.5:
pretending we know the far shoreline would be a lie). Beyond 8 km nothing stands,
so nothing needs suppressing — the tint band relies on the same §2b.5 rule that
already fades paleo-water out at the 16 km ring.

## 4. Far-field classification (decision: simple classifier, no new fetches)

The context land-cover engine reads seven inputs; five of them (SGU soils, KMR
evidence distances, road lines, monument footprints, cultivation records) are
either unavailable or meaningless at ring scale. Fetching SGU jordarter for a
64×64 km box would be ~256× the context fetch per site, and the evidence-driven
rules produce structure (300 m grazing halos, 8 m road corridors) that is
sub-pixel beyond ~4 km. **Confirmed: a simpler classifier is enough** — at
billboard range a class is 1–6 px of colour; what must be right is the broad
mosaic (water / wet / open / forest / rock) and the zone's forest identity, not
parcel-scale rules.

Inputs, all already in the pipeline's hands per site:

1. **Ring DEM** (already fetched, §11): slope, elevation.
2. **Ring4 `waterConnect`** where present: modern-sea mask and paleo-water for
   the dynamic water class.
3. **The zone parameter set** (`vegetation-zones.md` §4): which forest identity
   (broadleaf / conifer / mixed, spruce or pine) the forest class carries.
4. **The site's own context raster**: its measured class fractions set the
   far-field forest/open mosaic ratio, so the far field statistically continues
   the near field instead of asserting independent knowledge. (A site whose
   context is 25 % forest does not get 60 % forested far hills.)

Classifier sketch (uint8 per ring cell, fixed precedence like `classify()`):
sea/outside-coverage (from the ring build's fill mask) → water (dynamic, ring4
connect where present) → wet lowland (flat + low relative elevation: a
flatness-based mire proxy, the one genuinely new heuristic, disclosed as such) →
rock/sparse (slope above the forest threshold) → forest vs open, mosaic-sampled
(seeded blue-noise patches at ~100–300 m scale) to the context-derived ratio,
with forest carrying the zone's species identity. Every rule string ships
verbatim in the legend block, same as §10 — the far field is a *cruder model
than the near field and says so*; it feeds rendering only, never analysis
(viewshed, water logic and the §9 raster are untouched).

## 5. Assets and bytes

One new optional asset per shipped ring: `landcover_ring<N>.tif` — uint8 class
indices on that ring's exact §11 geometry (2000×2000), v1.5 §1a container (plain
deflate + predictor, no COG). Size [measured 2026-08-22]: the *busy* Broborg
context class raster deflates to **0.18 MB** at 2000²; far-field rasters are
smoother (fewer classes, larger patches), so ≤ 0.2 MB per ring is a firm upper
bound and ~0.1 MB is likely. Per site (rings 3–6): **~0.4–0.8 MB**; national,
1,304 sites ≈ **≤ 1 GB** — ~$0.015/month at R2's marginal rate on top of
scale-out §7.1's ~9 GB projection.

Rejected alternative: deriving far classes app-side (no new assets). The browser
lacks every input except the DEM, would re-run classification per visitor, and —
decisive — the rules would live outside the pipeline's disclosed, tested rule
engine. The bytes are cheap; the honesty machinery already exists pipeline-side.

Billboards themselves cost **zero bytes**: they are sampled at load from the ring
class rasters with the site seed, exactly as near-field vegetation samples the
context raster.

## 6. Contract impact (proposed v1.6, additive — to be recorded in `docs/data-formats.md` with the implementing PR)

1. `grids.rings[i].landcover` — optional path to `landcover_ring<N>.tif`, same
   geometry/validation pattern as the ring's DEM (dimension check against the
   ring entry; every raw value a valid index; §1a container).
2. `landcover_legend.json` gains an optional **`farField`** block: its own
   `classes[]` (id, name, color, rule verbatim, optional `billboard:
   {type, densityPerHa}`), a `method` paragraph for the far classifier, and the
   sampling-fraction disclosure sentence. Absent block = no far field (every
   pre-v1.6 bundle), and the app renders exactly as today.
3. §11's rendering-contract sentence "Ring meshes take the elevation tint but
   none of the overlay layers" gains the one exception: the far-field class wash
   (and its §3 water suppression) when the modeled-landscape layer is on.
4. Nothing changes in §9/§10 near-field semantics, and no existing asset changes
   bytes — the amendment is purely additive, per the versioning policy.

## 7. Verification plan (when built)

- **Broborg control:** near-field `landcover.tif`, legend `classes[]`, and every
  existing asset byte-identical after the far-field build; far assets strictly
  additive. If a refactor moves them, the refactor is wrong.
- Local browser check via `app/scripts/verify-sites.mjs` (the environment's
  browser has no outbound network — serve the published bytes locally, as the
  9b load verification did): rings + class rasters load, zero console errors,
  layer off ⇒ no far-field draw calls.
- Instance-count assertions: billboard count ≤ `FAR_MAX_INSTANCES` across all 27
  pilot sites; near-field counts unchanged to the instance.
- Contact-sheet sweep of the 27 pilots with the layer on, first-person *and*
  orbit screenshots — the seam, the orientation decision and the alvar/zone
  identities are all judged visually there, where §7.2's history says the silent
  failures get caught.

## 8. Open questions / risks

| Risk | Position |
|---|---|
| Billboard band still visible as a "band" (10/ha vs perspective-thinned 3D forest at the seam) | The 200 m cross-fade (§2) plus matched class colours; judged on the contact sheet, tuned there |
| Far-field mosaic ratio inherits a context anomaly (e.g. a mostly-sea context extent) | Ratio computed over *land* cells only; islands fall back to zone-typical fractions, disclosed in the legend |
| The flatness-based mire proxy is the weakest rule (no soils data at ring scale) | Said so verbatim in its rule string; it drives tint only, never analysis |
| Low-end devices | Billboards attach to ring3/ring4 arrival and inherit lazy loading — a device that stops at 8×8 km simply gets a shorter band, same graceful rule as terrain (§11) |
| Owner disagreement on §2 orientation | Blocking decision; both options costed above, neither is a rewrite of the other |
