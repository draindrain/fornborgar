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
| All 1,304 sites, optimized encoding (§2.1–2) | **~4 GB** |
| App shell (GH Pages, unchanged) | ~1 MB |
| National site index (`index.json`, §6.1) | ~0.2 MB |

**Answer: the whole country is ~4 GB of static files** (≤ 8 GB without the encoding
work). This is small enough that *architecture does not need to change* — per-site
static bundles remain correct at national scale; no tiled/LOD streaming terrain, no
server, no database. The one thing that must change is *where the bundles live* (§3).

Do we need to compress? We already do (int16 decimeters + DEFLATE ≈ 4.5× vs raw
float32). The §2 items are worth doing because they halve storage *and* per-site load
time for ~1–2 days of work, but nothing breaks without them.

## 3. Storage & hosting

The repo/GH Pages path dies at this scale: GitHub recommends repos < 1 GB (hard-limits
around 5 GB), Pages sites are soft-capped at 1 GB with 100 GB/month bandwidth
**[reported]**. 4–8 GB of data cannot be committed.

**Decision: keep the app on GitHub Pages; move site bundles to Cloudflare R2 behind
the Cloudflare CDN, on a custom domain (e.g. `data.fornborgar.example`).**

| Option | Verdict |
|---|---|
| **Cloudflare R2** | ✅ **Free egress** (bandwidth never costs, however popular the app gets); free tier 10 GB-month storage — the optimized dataset fits **at $0/month**; beyond that $0.015/GB-mo (8 GB ≈ $0.12/mo). S3-compatible API (`rclone sync` from the pipeline), custom domains, proper `Cache-Control`/CORS. **[reported 2026]** |
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

## 5. Contract changes (additive, v1.2 amendment to docs/data-formats.md)

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
| **8a. Encoding + contract v1.2** | delta grid, no-overview TIFFs, presets, index schema; rebuild Broborg | Broborg loads byte-for-byte-equivalent scene at ~3 MB |
| **8b. Batch machinery** | registry builder, tile cache, `build_site`, QA report + contact sheet | Broborg + 2 arbitrary registry sites build unattended |
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

---

*Summary: 1,304 sites, ~4 GB optimized (~3 MB/site), $0/month on R2 free tier, no
architectural change — the v1 per-site-bundle design scales to the whole country as-is.
Next concrete step: 8a (encoding + contract v1.2).*
