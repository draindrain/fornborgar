# National scale-out — "view any Swedish fornborg like this"

**Status: strategy, researched 2026-08-21.** This document sizes and designs Phase 8:
extending the v1 per-site experience (Broborg) to every registered fornborg in Sweden.
Facts follow PLAN.md's grading convention; numbers marked **[measured 2026-08-21]** were
computed from the live national KMR extract (`lämningar_sverige.gpkg`, 2.29 GB,
fetched 2026-08-21) and from the shipped Broborg bundle.

---

## 1. The population: what "every fornborg" means

From the national KMR GeoPackage, `lamningstyp = 'Fornborg'` **[measured 2026-08-21]**:

| | |
|---|---|
| Total registered fornborg records | **1,304** |
| — antikvarisk bedömning *Fornlämning* | 1,227 |
| — *Möjlig fornlämning* | 21 |
| — *Övrig kulturhistorisk lämning* | 27 |
| — *Ingen antikvarisk bedömning* | 29 |
| With site-extent polygon | 1,261 unique sites |
| Point-only geometry | 21 |
| Line/mixed geometry | 102 (all records have *some* geometry; zero orphans) |

County distribution (top): Södermanland 242, Stockholm 240, Västra Götaland 223,
Östergötland 150, Gotland 85, Kalmar 83, Uppsala 79, Västmanland 58 — the classic
Mälaren/east-coast concentration. The east-coast counties where the paleo-shoreline
feature is meaningful (Södermanland, Stockholm, Östergötland, Uppsala, Gotland, Kalmar,
Västmanland, Gävleborg, Västernorrland) hold ~72 % of all sites.

Extent sizes (bbox max dimension of the KMR extent polygon) **[measured 2026-08-21]**:

- p50 = 140 m, p90 = 280 m, p95 = 350 m, p99 = 584 m.
- **Only 3 sites exceed 1 km**: L1964:7416 (Västra Götaland, 5.9 km — plausibly the
  Halleberg plateau fort **[reported]**), Ramundersborg L2010:1810 (Östergötland,
  1.5 km), L1976:4254 (Gotland, 1.4 km — plausibly Torsburgen **[reported]**).

**Conclusion:** the v1 extent decision (4×4 km context, 2×2 km core) fits ≥ 99.7 % of
all sites unchanged. A single additional "large" preset (§5.2) covers the outliers.
No per-site hand-tuning is needed.

Clustering **[measured 2026-08-21]**: site centroids touch only **504** distinct
Lantmäteriet 10×10 km DEM tiles (max 13 forts in one tile), and **76 %** of sites have
another fornborg within a 4×4 km box. Two consequences: a pipeline **tile cache** pays
off enormously (§5.3), and neighboring forts will routinely be visible inside each
other's context extent — which is a feature (intervisibility, the Phase-8 stretch),
not a problem.

## 2. Data budget: how much data is it?

Measured baseline — the shipped Broborg bundle is **5.98 MB**: `dem_core.tif` 1.67 MB +
`dem_context.tif` 2.13 MB + `water_connect.tif` 2.03 MB + JSON/text ~0.15 MB.

Naive extrapolation: 1,304 × 6 MB ≈ **7.8 GB**.

Two compression findings change this **[measured 2026-08-21]**, tested on the real
Broborg grids:

1. **`water_connect` should ship as a delta, not an absolute grid.** By construction
   `connect ≥ dem` and they are *equal* outside depressions — at Broborg only 6.2 % of
   cells differ (max +4.8 m). `int16(connect − dem)` deflate-compresses to
   **0.19–0.22 MB vs 2.03 MB** — a 10× saving on the second-largest file. The app
   reconstructs `connect = dem_context + delta` in one pass at load.
2. **Drop COG overviews/tiling from the web bundles.** The app reads full resolution
   only; overviews + 512-px tile overhead cost ~35 %. The same int16-dm data as plain
   deflate + horizontal predictor: core 1.10 MB (vs 1.67), context 1.43 MB (vs 2.13).
   (Keep generating archival COGs pipeline-side for GIS inspection; just don't ship
   them.) zstd-19 would save a further ~15 % but geotiff.js decode support is not
   assured — not worth the risk. **Stay on DEFLATE.**

Optimized per-site bundle: ~1.1 + 1.45 + 0.22 + ~0.25 (JSONs, higher `sites.json`
allowance for dense areas) ≈ **~3 MB per coastal site**, ~2.7 MB inland (no water
assets). First-load payload per site stays ≈ 3 MB — comfortably below v1's risk budget.

| Scenario | Total |
|---|---|
| All 1,304 sites, current encoding | ~7.8 GB |
| All 1,304 sites, optimized encoding (§2.1–2), 4×4 km as today | **~4 GB** |
| — with the adaptive horizon ladder, 64–128 km extents (§2b) | **~12 GB** |
| App shell (GH Pages, unchanged) | ~1 MB |
| National site index (`index.json`, §6.1) | ~0.2 MB |

**Answer: the whole country is ~4 GB of static files** (≤ 8 GB without the encoding
work). This is small enough that *architecture does not need to change* — per-site
static bundles remain correct at national scale; no tiled/LOD streaming terrain, no
server, no database. The one thing that must change is *where the bundles live* (§3).

Do we need to compress? We already do (int16 decimeters + DEFLATE ≈ 4.5× vs raw
float32). The §2 items are worth doing because they halve storage *and* per-site load
time for ~1–2 days of work, but nothing breaks without them.

## 2b. Far-field rings & the horizon guarantee (added 2026-08-21; decided 2026-08-21)

Owner request: extend the per-site view beyond 4×4 km — lower detail farther out, and
**the map must be big enough that the horizon closes from a reasonable height**. Owner
decisions (2026-08-21): the guarantee holds for the **first-person viewpoint on the
fort** (not elevated orbit); ladder depth is **adaptive per site**; DEM gaps beyond
Sweden's borders are **filled from the Copernicus global 30 m DEM**.

The extension slots cleanly into the existing two-ring design, because each doubling of
extent at halved resolution costs the same 2000×2000 pixel budget (constant *angular*
detail: ~1 m of ground per km of distance, ≈ 0.06°):

| Ring | Extent | Res | Grid | Quant | Compressed |
|---|---|---|---|---|---|
| core | 2×2 km | 1 m | 2000² | 0.1 m | 1.10 MB **[measured 2026-08-21]** |
| context | 4×4 km | 2 m | 2000² | 0.1 m | 1.43 MB **[measured]** |
| ring 3 | 8×8 km | 4 m | 2000² | 0.5 m | 0.85 MB **[measured]** |
| ring 4 | 16×16 km | 8 m | 2000² | 0.5 m | 1.20 MB **[measured]** |
| ring 5 | 32×32 km | 16 m | 2000² | 0.5 m | 1.68 MB **[measured]** |
| ring 6 | 64×64 km | 32 m | 2000² | 1.0 m | ~1.7 MB **[estimated; verify in 8a]** |
| ring 7 (rare) | 128×128 km | 64 m | 2000² | 1.0 m | ~2.0 MB **[estimated]** |

Measured sizes come from block-mean downsampling the real Broborg context grid and
compressing with deflate + predictor. Coarser vertical quantization on far rings is the
key win (≈ ½ the bytes of 0.1 m steps): at ≥ 2 km viewing distance 0.5 m subtends
< 0.015°, and the manifest's per-grid `encoding.scale` field already expresses it —
**no schema change**, just `"scale": 0.5` (or `1.0`) on ring grids. Disclosed per-ring
in the methods panel.

### The horizon guarantee (first-person, adaptive per site)

Refracted horizon distance is `d ≈ 3.83·√h` km for an eye `h` meters above the terrain
it looks across. The pipeline computes, per site:

- `h = (crown + 2 m) − floor`, where `crown` = max DEM elevation inside the site
  extent polygon, and `floor` = the 5th-percentile elevation of the 16×16 km box
  (0 m when sea or a large lake is present — the sea horizon is the far bound);
- required radius `d = 3.83·√h`, then the ladder is extended ring by ring until the
  half-extent ≥ `d`, capped at ring 7 (64 km radius, which covers `h` up to ~280 m —
  more relative height than any Swedish fornborg has, so the cap never truncates in
  practice **[verify against the registry in 8b]**).

Expected distribution: lowland forts (h ≈ 30–70 m → d ≈ 21–32 km) stop at ring 6;
high sea/lake-facing forts (the Västgöta plateau forts over Vänern, Omberg-class sites
over Vättern, h up to ~200 m → d ≈ 54 km) get ring 7. Typical site ≈ **~9 MB**
(terrain ladder ~7.7 MB + ring water-connect deltas ~0.5 MB + JSONs), ring-7 sites
~11 MB. National total ≈ **~12 GB** — ~2 GB past the R2 free tier ≈ **$0.03/month**.
Orbit views above the guarantee height may still see the haze band at the map edge;
that is accepted (owner decision — the guarantee is the on-foot experience).

### Border fill: Copernicus DEM

Rings ≥ 32 km near national borders and coasts leave Lantmäteriet coverage. Open
Baltic is genuinely sea-at-0 m, but Norwegian fjäll, Finnish coast and Åland would
otherwise render as a false flat horizon. Decision: fill non-Swedish land in far rings
from the **Copernicus DEM GLO-30** (free, attribution required **[reported — confirm
license text on first use]**; note it is a *surface* model including canopy —
irrelevant at 30 m in a far ring, disclosed in methods). Pipeline: reproject/resample
to the ring grid, mosaic under the Lantmäteriet data (which always wins where present),
tag the source in `provenance`, add the attribution line to affected manifests.
Affected: Värmland's 39 sites, the Norrland handful, and east-coast archipelago views
toward Åland.

Rendering requirements the app must add (none change the analysis contract):

1. **Earth-curvature displacement on far rings** — at 16 km the refracted drop is
   ~17.5 m, at 32 km ~70 m, at 64 km ~280 m; without sinking ring vertices by
   `(1−k)·d²/2R` the skyline sits visibly too high — at horizon scale this is the
   difference between a horizon and a wall. Analysis grids stay flat (the viewshed
   already applies curvature internally); this is a render-mesh transform only.
2. **Annulus meshes, decimated** — each ring renders only its outer annulus (75 % of
   cells), at reduced vertex density (¼–⅛), with normals sampled from the full-res
   grid; far-terrain legibility lives in shading, not silhouette. Keeps total scene
   vertices ≈ 9–10 M (vs ~7 M today).
3. **Logarithmic depth buffer** (three.js flag) — a 32–64 km far plane with sub-meter
   near geometry needs it.
4. **Lazy ring loading** — core+context first (today's experience, unchanged startup),
   rings stream in behind; low-end/mobile stops at 8×8 km. A missing ring is just a
   nearer fog line — graceful everywhere, so the horizon guarantee is a *data*
   guarantee; devices render as much of it as they can.
5. **Water on the rings** — extend the paleo-shoreline plane and per-ring connect
   deltas outward. This is the emotional payoff of the whole feature: from Broborg's
   rampart at 500 CE the entire Långhundraleden inlet system toward the Baltic becomes
   visible water. Flood-fill at ring resolution is the same priority-flood, sea entry
   from the outermost ring's edge (which is far more robustly "open sea" than the
   4×4 km edge — this *simplifies* §4.3's sea-entry concern for coastal sites).
   One honesty caveat at horizon scale: post-glacial uplift is a *gradient*, so a
   single per-century level is only locally valid — across a 64 km extent the true
   fort-era shoreline can differ by a few meters edge to edge. Default: render
   paleo-water out to the 16 km ring and fade it; farther rings show terrain only.
   Revisit with a per-ring level offset if the visual cut bothers (risk table §8).

Viewshed: unchanged at 2 m/4×4 km for the interactive tool. As a cheap follow-on, the
same XDraw worker can optionally run on the 16 m/32×32 km grid ("far sight" mode, 4 M
cells again) to answer *"could they see Birka from here?"*-class questions, with the
resolution caveat stated in-panel.

Pipeline cost: outer rings are read from the source COGs' **overview levels** (×4–×32
exist per PLAN §2.1) via decimated windowed reads — a few MB per touched tile instead
of ~110 MB (the 64 m ring decimates the ×32 overview). The tile *footprint* grows
substantially (a 64 km box spans ~7×7 tiles; the national union approaches most of
settled Sweden's tiles) but overview-only fetches keep the added transfer to roughly
**~40–60 GB one-time [estimated]**, alongside the 504-tile full-res cache. Mosaicking
across tile edges (§4.2) becomes the normal case rather than the exception. Copernicus
GLO-30 adds a handful of 1°-tile downloads, cached the same way.

Contract: one additive v1.3 item — optional `grids.rings: [ … ]` array (same per-grid
schema as core/context, ordered inside-out, each with its own `encoding.scale` and
optional connect-delta asset; a per-ring `sources` note distinguishes
Lantmäteriet-only rings from Copernicus-filled ones). Old manifests have no rings;
old apps ignore them. Ring count varies per site — the app derives everything from
the manifest and never assumes a fixed ladder depth.

## 3. Storage & hosting

The repo/GH Pages path dies at this scale: GitHub recommends repos < 1 GB (hard-limits
around 5 GB), Pages sites are soft-capped at 1 GB with 100 GB/month bandwidth
**[reported]**. 4–8 GB of data cannot be committed.

**Decision: keep the app on GitHub Pages; move site bundles to Cloudflare R2 behind
the Cloudflare CDN, on a custom domain (e.g. `data.fornborgar.example`).**

| Option | Verdict |
|---|---|
| **Cloudflare R2** | ✅ **Free egress** (bandwidth never costs, however popular the app gets); free tier 10 GB-month storage — the 4×4 km dataset fits at **$0/month**, the full horizon-ladder dataset (~12 GB) runs ≈ **$0.03/month**; $0.015/GB-mo beyond the tier. S3-compatible API (`rclone sync` from the pipeline), custom domains, proper `Cache-Control`/CORS. **[reported 2026]** |
| GitHub Releases | Workable free fallback (2 GB/file, CORS OK) but no cache control, clumsy URLs, and hotlinking release assets as a CDN is gray-zone. Keep as plan B only. |
| GitHub LFS | ❌ 1 GB free bandwidth/month; a few visitors would exhaust it. |
| AWS S3 / GCS | ❌ Egress pricing (~$0.09–0.12/GB) is exactly the cost R2 eliminates. |
| Committed to repo | ❌ Size limits; also every data refresh becomes a giant commit. |

Layout: `https://<data-host>/v1/<siteId>/manifest.json` etc. — the schema version in
the path lets a future breaking format change coexist with deployed apps. Bundles are
immutable-ish: long `Cache-Control` on grids (content changes are rare — LiDAR
re-flights), short on `index.json`.

Repo keeps: `testsite` (synthetic fixture) and `broborg` (the reference site, dev
fallback) — nothing else. The app reads a `VITE_DATA_BASE_URL`; unset = repo-relative
`data/` exactly as today, so local dev and the deployed app share one code path.

## 4. Pipeline scale-out (the actual work)

The v1 pipeline is already per-site and manifest-driven; scaling it is batching, not
redesign.

### 4.1 Site registry builder (new)
One script reads the national KMR GeoPackage (county files are unnecessary — the
riket file has identical schema, and using it avoids county-border seams) and emits
`registry.json`: one entry per fornborg — slug (from lamningsnummer: `l1943-7827`),
name, county, centroid (E/N), extent bbox, geometry class (polygon/point/line),
antikvarisk bedömning, chosen extent preset (§5.2). This registry drives everything:
batch builds, the national index, QA reports.

Representative point: polygon → centroid of the (multi)polygon; line → midpoint;
point → the point. The 21 point-only + 102 line-only sites build fine — they just get
no extent-polygon overlay and their rampart derivation (§4.4) is skipped.

### 4.2 DEM tile cache
Instead of per-site windowed remote reads (re-fetching overlapping windows for the 76 %
clustered sites), fetch each needed 10×10 km `dtm-cog` tile once into a local cache:
**504 tiles × ~110 MB ≈ ~55 GB disk, fetched once** over a few nights with 429-aware
throttling. Every site build then reads locally; full-country rebuilds become
download-free. Sites whose 4×4 km box crosses tile edges mosaic up to 4 cached tiles —
the pipeline must handle this from day one (Broborg happened to fit one tile; many
sites won't).

### 4.3 Per-site build = the existing pipeline, parameterized
`build_site --slug l1943-7827` runs the v1 steps (clip/fill DEM, shoreline table,
connectivity grid, KMR sites extract, rampart, manifest) with only data-driven inputs.
Per-site compute is dominated by the priority-flood (seconds at 4 M cells); the full
country is **hours of CPU** once tiles are cached. Incremental: content-hash inputs in
the registry; rebuild only changed sites.

Feature applicability is decided per site, automatically, using the existing contract
rule "missing asset = feature off":

- **Shoreline/water**: built only where the SGU strandförskjutningsmodell has Hav/Sjö
  polygons intersecting the bbox in the slider range (≈ the 72 % east-coast share).
  Inland/highland forts ship no `shoreline.json`/connect grid, and the app's slider
  simply doesn't appear. Sea-entry cells for the flood fill must be *sea-connected
  edge cells*, not all edge cells, for coastal sites where a lake also touches the
  clip edge — a generalization of the Broborg assumption to review in code.
- **Rampart/palisade**: DEM-ridge extraction (§4.6 of PLAN) will not be robust across
  1,300 heterogeneous sites. Make it best-effort with acceptance checks (closure,
  height contrast along the crest, length vs. extent perimeter); on failure ship no
  `rampart.json`. Hand-digitized fallbacks remain reserved for curated sites.

### 4.4 QA gates (the real scaling risk)
Nobody can eyeball 1,304 sites, so the batch emits a per-site build report and fails
loudly: elevation range sanity (the [−10, 200] m guard already in the contract —
extend the upper bound; Sweden's forts reach higher terrain than Uppland's),
nodata-fill percentage (flag > 1 %), shoreline monotonicity (existing test), rampart
acceptance metrics, and an automatic **hillshade thumbnail** per site. A contact-sheet
HTML page of all thumbnails makes a full-country visual sweep a 30-minute human task —
and doubles as the picker's preview imagery.

## 5. Contract changes (additive, v1.3 amendment to docs/data-formats.md — v1.2 was taken by phase 7 land cover, 2026-08-21)

1. **`assets.waterConnectDelta`** — int16 decimeters, `connect = dem_context + delta`,
   same geometry as `grids.context`; when present the app prefers it over
   `assets.waterConnect`. (Old sites keep working; Broborg gets rebuilt with it.)
2. **Web-grid encoding note** — bundle TIFFs are deflate + predictor 2, full-res only,
   no overviews required. (The app already ignores overviews; this legalizes their
   absence.)
3. **Extent presets** — `standard` (4×4 km ctx @ 2 m / 2×2 km core @ 1 m, today's
   budget) and `large` (8×8 km ctx @ 4 m / 4×4 km core @ 2 m — same pixel counts,
   same memory/perf envelope) for the 3 giant sites. The manifest's grid geometry
   already carries everything the app needs; `site.extentPreset` is informational.
   Grid *sizes* stay 2000×2000 in both presets — every performance budget in the app
   holds unchanged.
4. **`index.json`** (national, not per-site): schemaVersion, fetched date, and one
   entry per built site — slug, name, county, WGS84 + SWEREF centroid, bundle URL,
   feature flags (water? palisade?), antikvarisk bedömning, thumbnail URL. ~0.2 MB.

## 6. App changes

- **Site picker**: load `index.json`, render a Sweden overview (SWEREF-projected
  SVG dot map — no map-library dependency needed at 1,304 points) with county/name
  search; deep links stay `?site=<slug>`. Show antikvarisk bedömning as a badge —
  *Möjlig fornlämning* / *Övrig* sites are included but honestly labeled (the
  project's honesty premise extends to "this may not actually be a fort").
- **`VITE_DATA_BASE_URL`** resolution (§3) — one change in the manifest loader.
- Nothing else: the app is already site-agnostic by design (testsite proves it).

## 7. Rollout

| Step | Scope | Exit criterion |
|---|---|---|
| **8a. Encoding + contract v1.3** | delta grid, no-overview TIFFs, presets, `grids.rings` + ring pipeline, curvature/log-depth/lazy-ring rendering; rebuild Broborg with its full horizon ladder | Standing on Broborg's rampart, the skyline closes at the true horizon; near scene byte-equivalent to v1; ring-size estimates verified |
| **8b. Batch machinery** | registry builder (incl. per-site horizon-ladder depth from crown/floor heights), tile + Copernicus cache, `build_site`, QA report + contact sheet | Broborg + 2 arbitrary registry sites build unattended; ladder-depth histogram sanity-checked against the 128 km cap |
| **8c. Pilot: ~25 curated forts** | the famous ones (Torsburgen, Ismantorp, Eketorp, Gråborg, Runsa, Gåseborg, Birka borg, Halleberg, Ramundersborg, …) incl. the 3 `large`-preset outliers; R2 bucket + custom domain live; picker MVP | public URL serves 25+ sites from R2; manual QA pass |
| **8d. County-by-county fill** | remaining ~1,280 sites, east-coast counties first (they exercise the water path) | all 1,304 built; QA contact-sheet sweep done |
| **8e. Stretch** | intervisibility between neighboring forts (76 % have a neighbor in-extent), Phase-7 landcover for curated sites | — |

Owner actions needed: a Cloudflare account (free plan) + R2 bucket + domain/subdomain
choice; pipeline runs stay local (Geotorget credentials never enter CI; ~55 GB free
disk for the tile cache).

## 8. Risks

| Risk | Mitigation |
|---|---|
| Bulk fetch vs. Lantmäteriet rate limits | Tile cache = one polite pass (504 tiles, 429-aware backoff, overnight); data is CC BY open data — volume is legitimate, manner should be courteous |
| QA at 1,304 sites | Automated gates + thumbnail contact sheet (§4.4); antikvarisk-bedömning badges keep dubious records honest instead of hand-filtering them |
| Rampart extraction quality varies wildly | Best-effort with acceptance checks; absent asset = feature off; curated digitization only for pilot sites |
| Sea-entry assumption in flood fill wrong for some coasts/lakes | Generalize entry-cell selection (§4.3); testsite already exercises the basin logic |
| R2 dependency | S3-compatible + rclone: the whole dataset moves anywhere in minutes; GitHub Releases as documented plan B |
| Tile-edge sites | Mosaic support in the clip step from day one (§4.2) |
| Uplift gradient across 64 km extents makes one water level per century locally wrong at the edges | v1 renders paleo-water only to the 16 km ring (§2b.5); per-ring level offsets from the SGU model as a later refinement |
| Copernicus GLO-30 is a surface model (canopy included) with its own datum/license terms | Far-ring use only (invisible at 30 m/px in a distant silhouette); confirm license text and attribution wording on first use; provenance-tagged per manifest |

---

*Summary: 1,304 sites; ~12 GB (~9 MB/site) with the adaptive horizon ladder — every
fort's skyline closes at the true refracted horizon from the first-person viewpoint,
64×64 km extents for lowland sites, 128×128 km for the high outliers, Copernicus-filled
beyond the borders. ≈ $0.03/month on R2, and no architectural change: the v1
per-site-bundle design scales to the whole country as-is. Next concrete step: 8a
(encoding + contract v1.3, including `grids.rings` and the horizon rendering work).*
