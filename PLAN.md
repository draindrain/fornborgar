# Fornborg Explorer — Project Plan

An interactive three.js web application that answers *"why is this hillfort here?"* for
Swedish fornborgar (Iron Age hillforts), starting with **Broborg** (Husby-Långhundra 156:1,
Knivsta, Uppland) and, later, the wider Mälaren valley. The app is an interactive argument,
not a game: fort placement only makes sense in 3D — sightlines, terrain control, and
proximity to ancient waterways that sat at a different level because of post-glacial land
uplift.

**Status: Phase 0 (data spike) complete, 2026-08-20 — gate PASSED. Corrections from the
spike are folded in below and marked "[phase-0 verified]". Spike scripts: `pipeline/spike/`.**

Facts in this plan were researched against current (2025–2026) sources. Claims are graded:

- **[verified]** — confirmed against an authoritative source (or working third-party code
  probing the live service in 2026).
- **[reported]** — consistent across multiple sources but not confirmed against the primary
  source; verify on first use.
- **[open]** — could not be verified; listed again in §7 (Open questions).
- **[phase-0 verified]** — confirmed or corrected against the live services / real data
  during the phase-0 spike, 2026-08-20.

---

## 1. Architecture overview

```
┌─────────────────────────────┐      ┌───────────────────────────┐      ┌─────────────────────────┐
│  pipeline/  (Python, local) │      │  app/public/data/<site>/  │      │  app/  (TypeScript,     │
│                             │      │  (static, pre-built)      │      │  Vite, three.js)        │
│  fetch: Lantmäteriet STAC   │─────▶│  dem_core.tif  (1 m COG)  │─────▶│  terrain mesh + normals │
│         RAÄ GeoPackage      │      │  dem_context.tif (2 m)    │      │  first-person + orbit   │
│         SGU OGC API / gpkg  │      │   (EPSG:3006, m RH 2000)  │      │  viewshed (Web Worker)  │
│  reproject / clip / derive  │      │  sites.json (local coords)│      │  water plane + slider   │
│  rampart line, land cover,  │      │  rampart.json             │      │  palisade (instanced)   │
│  shoreline table            │      │  shoreline.json           │      │  land-cover vegetation  │
│                             │      │  landcover.png + legend   │      │  methods/about panel    │
│                             │      │  manifest.json            │      │                         │
└─────────────────────────────┘      └───────────────────────────┘      └─────────────────────────┘
```

Principles:

- **All compute that needs GDAL/geodesy happens offline** in `pipeline/`. The deployed app
  is pure static files (GitHub Pages compatible). No server-side compute, no runtime calls
  to Swedish agency APIs.
- **One analysis grid, one source of truth.** The browser decodes the site's DEM once into
  a `Float32Array`; that same array feeds the terrain mesh, the viewshed worker, and the
  water shading. No parallel representations that can drift apart.
- **A per-site `manifest.json` is the contract** between pipeline and app: local origin
  (SWEREF 99 TM easting/northing of the scene origin), grid size and resolution, min/max
  elevation, shoreline lookup table, asset paths, attribution strings, and a provenance
  tag (`measured` / `model` / `conjecture`) per layer.
- **Every visual element is generated programmatically** from data or simple procedural
  geometry. No hand-modeled 3D assets (hard constraint).

Repository layout:

```
fornborgar/
├── PLAN.md
├── pipeline/                  # Python; runs locally, never deployed
│   ├── pyproject.toml         # rasterio, geopandas, pyproj, shapely, click, requests
│   ├── fornborg_pipeline/
│   │   ├── fetch_dem.py       #  STAC query + authenticated COG download / windowed read
│   │   ├── fetch_sites.py     #  RAÄ GeoPackage download + filter + local-coords export
│   │   ├── fetch_soils.py     #  SGU OGC API Features / GeoPackage clip
│   │   ├── clip_dem.py        #  clip to site bbox, fill nodata, write web COG
│   │   ├── rampart.py         #  derive rampart polyline (see §4.6)
│   │   ├── shoreline.py       #  century → water level table for the site
│   │   ├── landcover.py       #  rule engine → classification raster (phase 7)
│   │   └── manifest.py        #  assemble manifest.json
│   └── tests/                 #  pytest on small synthetic fixtures
├── app/                       # Vite + TypeScript + three.js
│   ├── public/data/broborg/   #  pipeline outputs, committed or LFS/Releases (see §5 risks)
│   └── src/
│       ├── terrain/           #  heightfield decode, mesh build, normals, materials
│       ├── viewshed/          #  Web Worker + overlay texture
│       ├── water/             #  plane + shoreline slider
│       ├── overlays/          #  RAÄ site markers, palisade
│       ├── camera/            #  orbit + first-person (pointer lock)
│       ├── ui/                #  control panel, methods/about modal, legend
│       └── state/             #  central app state (site manifest, toggles)
└── docs/
    └── data-formats.md        #  the pipeline↔app contract, kept in lockstep
```

---

## 2. Data acquisition guide (per source)

### 2.1 Elevation — Lantmäteriet *Markhöjdmodell Nedladdning*

| | |
|---|---|
| Product | **Markhöjdmodell Nedladdning** — the national 1 m ground DEM (TIN-interpolated from ground/water-classified LiDAR). The old name "Markhöjdmodell Nedladdning, grid 1+" was retired 2025-05-28. **[verified]** |
| Cost | Free since 2025-02-03 (EU High-Value Datasets). **[verified]** |
| License | **CC BY 4.0** — *not* CC0 (legacy 50 m data was CC0; stale pages disagree). Attribution required, "© Lantmäteriet". Exact mandated wording is in the terms accepted at ordering. **[verified; exact wording open]** |
| Account | Free **Geotorget** account (geotorget.lantmateriet.se) **plus** an explicit (free) order of the product attached to the account. Until the product is ordered, every download returns 401/403 even with valid credentials. Private-person accounts suffice for open data. **[verified]** |
| Discovery | **STAC API**: `https://api.lantmateriet.se/stac-hojd/v1` (Swagger at `/api.html`). Catalog browsing is anonymous; asset downloads need HTTP Basic auth with Geotorget credentials. Rate-limited (HTTP 429 + Retry-After). **[verified]** |
| Format | **10×10 km Cloud-Optimized GeoTIFF tiles**, collection **`dtm-cog`**, 10 000×10 000 px @ 1 m, float32, **nodata −9999**, hosted on `dl1.lantmateriet.se` (`.../hojd/data/grid/mhm/<ruta>/m<tile>.tif`), HTTP range reads work (`/vsicurl` + `GDAL_HTTP_AUTH=BASIC`), overviews ×2–×32, 512-px blocks. Per-tile assets also include `info`/`ursprung` JSON, thumbnail, and a `brytgeometri` GeoPackage. **[phase-0 verified]** The legacy per-100-km-square `mhm-*` collections still resolve alongside `dtm-cog` (moot for us). **[phase-0 verified]** |
| CRS | SWEREF 99 TM (EPSG:3006) + RH 2000 heights; the COGs declare **compound CRS EPSG:5845**. ⚠️ Pipeline gotcha: `gdalwarp` may apply the RH2000→ellipsoid geoid shift (~+23–36 m) because of the declared vertical CRS — pass `-novshift` / strip the vertical axis. **[reported]** |
| Backup plan | **Laserdata Nedladdning, skog** (1–2 pts/m² classified point cloud, COPC LAZ, same STAC API since June 2026) if the 1 m grid under-resolves the ramparts — rasterize our own 0.5 m DEM from ground returns with PDAL. **[verified product; collection details reported]** |

Workflow (single site): query STAC for the tile(s) intersecting the Broborg bbox → windowed
`/vsicurl` read of just the 4×4 km subset (avoids the full 100+ MB tile) → fill nodata →
write a deflate-compressed COG for the app. Broborg sits at **E 665 810, N 6 627 880**
(SWEREF 99 TM; centroid of the KMR extent polygon, E 665 808 / N 6 627 881 —
**[phase-0 verified]**; ⚠️ the plan's original WGS84-derived guess of E 668 400 was
**2.6 km too far east**), tile `662_66` in the `66_6` square — the 4×4 km extent fits in
that one tile. The spike download had zero nodata cells, z range 6.8–57.3 m; the fort
crown is at ~50 m. Regional extent later = same script over a tile list.

### 2.2 Archaeological sites — Riksantikvarieämbetet (RAÄ) *Kulturhistoriska lämningar*

| | |
|---|---|
| Product | KMR/Fornreg extract "Kulturhistoriska lämningar", ~760 000 sites. **[verified]** |
| Download | GeoPackage per kommun / län / whole country from `https://pub.raa.se/nedladdning/datauttag/lamningar_v1/` (note the **`_v1`** suffix — the plain `lamningar/` path 404s). County files under `lan/`, e.g. `lan/lämningar_län_uppsala.gpkg` (URL-encode the Swedish characters); riket = `lämningar_sverige.gpkg`. Uppsala county ≈ 146 MB. **[phase-0 verified]** |
| License | **CC0**. Attribution not required but good practice. **[verified]** |
| Restructuring | New (Oct 2025) schema **[phase-0 verified]**: relational — bare geometry layers `point` / `linestring` / `polygon` carry only `(lamning_uuid, geometrinummer)`; attributes live in the non-spatial **`lamning`** table (`uuid`, `lamningsnummer` = L-number, `raa_nummer`, `lamningstyp`, `lamningsnamn`, `beskrivning`, `url`, `antikvariskbedomning`, `aktualitetstatus`, `skadestatus`, `undersokningsstatus`, `terrang`, `lan`/`kommun`/`socken`, …) plus `ingaendelamning` and `egenskap` tables. Denormalized convenience layers **`lämningar_län_<län>_{point,linestring,polygon}`** join attributes+geometry in one layer (pipeline uses these), and **`lämningar_län_<län>_lägesosäkerhet`** (MultiPolygon) carries `inmatningskvalitet` + `lagesosakerhet_i_meter`. **There is no structured dating column** — the "typisk datering" heuristic stands. |
| Type filter | Attribute **`lamningstyp`** carried over unchanged **[phase-0 verified]**. Values from the official *Lämningstypslistan v5.0* (157 types): `Fornborg`, `Gravfält`, `Boplats` (plus `Boplatsområde`, `Boplatslämning övrig`), `Runristning` (there is **no** `Runsten` type). ⚠️ **There is no `Hålväg` type**: hollow ways are registered as `Färdväg` / `Färdvägssystem` with hålväg character in the description text — filtering for `Hålväg` returns nothing. **[verified]** |
| Dating | Structured dating is **sparsely populated**; Fornsök itself falls back to the *type's* "typisk datering". Plan: select by lämningstyp (fornborgar, gravfält are overwhelmingly Iron Age in this region) and treat period as a per-type heuristic, not a per-record fact. Disclose this in the methods panel. **[verified]** |
| Geometry | Points, lines, polygons; historically sites <~20 m were points, larger sites polygons. Broborg's record is a **single site-extent Polygon (~6 310 m², one geometry `L1943:7827-1`) — no per-rampart geometry in KMR**, confirming the §4.6 redesign. **[phase-0 verified]** |
| Supplementary | **K-samsök/SOCH API** `https://kulturarvsdata.se/ksamsok/api` (CQL queries; `x-api=test` for development, production key via ksamsok@raa.se — current enforcement **[open]**). Persistent site URIs `kulturarvsdata.se/raa/lamning/{uuid}`, resolvable to Fornsök. Used only at pipeline time to enrich site popups (links, images); the app itself stays static. **[verified]** |
| Broborg | **RAÄ Husby-Långhundra 156:1** = **L1943:7827** **[phase-0 verified]**, KMR uuid `184ca0f6-16f9-4de8-bbec-99aa959f9824`, Fornsök URL `https://pub.raa.se/visa/objekt/lamning/<uuid>`, antikvarisk bedömning *Fornlämning*, aktualitetsstatus *Bekräftad i fält*, lägesosäkerhet 10 m. The KMR `beskrivning` matches the literature verbatim (inner rampart ~300 m × 8–15 m × 1–2 m, outer ~140 m, entrances WNW+ÖSÖ, förslaggad sten). Uppland's largest fornborg, ~95×85 m, inner rampart ~300 m long, 8–15 m wide, **1–2 m high**, outer rampart ~140 m, two entrances; Migration Period, in use ~400–550 CE; famous for its vitrified inner wall (studied as a nuclear-waste-glass analogue by PNNL). The 1–2 m rampart height against a 1 m DEM is exactly the phase-0 visibility gate. **[verified]** |

### 2.3 Soils — SGU *Jordarter 1:25 000–1:100 000*

| | |
|---|---|
| Status | All SGU geological data open and free since **June 2024**; jordarter data refreshed April 2025. **[verified]** |
| License | **CC0**. **[verified]** |
| Download | GeoPackage via product page / GeoLagret catalogue. **[verified]** |
| API | **OGC API — Features**: `https://api.sgu.se/oppnadata/jordarter25k-100k/ogc/features/v1`, anonymous. Full collection list **[phase-0 verified]**: `blockighet`, `grundlager`, `landform`, `linjer`, `oversta-ytlager`, `punkter`, `tackningskarta`, `underliggande-lager`, `ytlager`. `storageCrs` = **EPSG:3006** and EPSG:3006 output is supported (plus CRS84/3857/RT90 variants) — no reprojection needed. |
| Schema | Attributes unchanged: **`jg2`** (int code) / **`jg2_tx`** (text), plus `kartering`, `karttyp`, `symbol`, `geom_area`, `geom_length`. **[phase-0 verified]** Classes observed in the Broborg bbox (362 polygons): Sandig morän, Urberg, Glacial lera, Kärrtorv, Postglacial lera, Isälvssediment, Gyttjelera (eller lergyttja), Svämsediment ler–silt, Klapper, Vatten, Fyllning, Postglacial sand, Gyttja — exactly the classes the §4.7 rules need. |

### 2.4 Shoreline displacement — SGU *Strandförskjutningsmodell*

Better than hoped: SGU publishes a ready-made open-data shoreline displacement model.

| | |
|---|---|
| Product | **Strandförskjutningsmodell** (launched June 2022, replaced "Strandlinjer"): sea/land distribution in **100-year time steps**, built from the Påsse & Daniels (2015) national shore-level equations + a land-uplift model + a 50 m DEM. **[verified]** |
| Download | GeoPackage per BP time range at `https://resource.sgu.se/data/oppnadata/jord/strandforskjutningsmodell/strandforskjutning_<from>_<to>.gpkg` (e.g. `strandforskjutning_1000_1900.gpkg`; directory listing is 403 — file URLs work). Layers **`issjohav_<bp>`** — ⚠️ keyed by **years BP (before 1950), not calendar year**, and **BP 1100 is missing** from the product. **[phase-0 verified]** Better: there is also an **OGC API — Features** endpoint `https://api.sgu.se/oppnadata/strandforskjutningsmodell/ogc/features/v1` with 14 collections `bp1-900` … `bp13000-13500`; polygon features carry `bp` (string), `year` (calendar year = 1950 − BP), `code` (**1 = Hav, 4 = Sjö**), `description`, `geom_area`. **[phase-0 verified]** Fort-era sanity check: **Hav polygons are present in the Broborg 4×4 km bbox for years 350–550 CE** — Långhundraleden was indeed a marine inlet in the fort's active period. |
| Caveats | SGU: dating margins up to **±500 years**; "general progression, not for detailed studies". Fine for us — the slider is explicitly a model, and we say so. **[verified]** |
| v1 usage | We do **not** ship SGU's 50 m-DEM polygons. Pipeline derives a per-site lookup table **century → water level (m RH 2000)** by intersecting SGU's per-century shoreline with our 1 m DEM near the site (or directly from the Påsse & Daniels equations), then the app draws that level on our own high-res terrain. Sanity anchors from literature for the Uppsala/Knivsta area (interpolated estimates, not published point values — **[reported]**): ~500 BCE ≈ 13–16 m, ~1 CE ≈ 10–12.5 m, ~500 CE ≈ 8–10 m, ~1000 CE ≈ 5–6.5 m above present sea level. Långhundraleden below Broborg was a navigable waterway in the fort's active period — the slider should visibly show it. |
| Datum notes | DEM heights are RH 2000; "above present sea level" ≈ RH 2000 height to within decimetres here — acceptable v1 approximation, disclosed in methods. Post-isolation Mälaren is regulated at **+0.86 m RH 2000**, ~0.9 m above the Baltic — only relevant if we ever show post-1200 CE states; the fort's period predates isolation (final isolation ~1200s CE; Södertälje/Stockholm passages shoaling from ~500 CE onward). **[verified]** |

### 2.5 Calibration — pollen literature (methods-panel citations only)

Used solely to sanity-check the phase-7 land-cover model's forest/open ratio; cited in the
methods panel, never rendered as data. **No quantified (REVEALS-type) openness percentage
for Iron Age Uppland specifically was found [open]** — nearest anchors:

- Karlsson, S. (1999): *Vegetationshistoria från Arlandaområdet, Uppland* (pollen records
  in the Arlanda–Knivsta area). **[verified]**
- *Paleoenvironment and shore displacement since 3200 BC in the central part of the
  Långhundraleden Trail, SE Uppland* (Stockholm Univ. thesis) — pollen + shoreline exactly
  along Broborg's waterway; also the source of the ~5.6–6.2 mm/yr apparent-uplift rates. **[verified]**
- *Domesticated Forest Landscapes in Central Scandinavia during the Iron Age*, J. Field
  Arch. (2023) — Iron Age grazing-driven landscape change. **[verified]**
- Hultberg et al., Veget. Hist. Archaeobot. 24:253–266, doi:10.1007/s00334-014-0469-8 —
  REVEALS openness for agrarian Scania (90–97 % open), a methodological benchmark, *not*
  an Uppland value. **[verified]** (Previously cited here as "Hultberg et al. (2019)";
  Crossref returns no 2019 Hultberg VHA paper — the correction is recorded in
  `docs/vegetation-zones.md` §3. The openness figure itself stays [reported].)
- Länsstyrelsen Uppsala (2013): *Brons- och järnålder i Uppsala län* — synthesis incl.
  E4-project shoreline/pollen work (shoreline ~12 m ö.h. at the start of the Iron Age). **[verified]**

---

## 3. Phased implementation plan

Each phase ends with something viewable. Phases 0–6 are v1; 7–8 are designed now, built later.

### Phase 0 — Data spike & the go/no-go gate (no app code) — ✅ DONE 2026-08-20, GATE PASSED

Outcome: ramparts **clearly legible** in the 1 m DEM (inner ring complete incl. both
entrance gaps; outer rampart a distinct concentric arc) — no Laserdata-skog fallback
needed. Renders in `pipeline/spike/out/`. All schema assumptions checked; corrections
folded into §2 and §7. One extra finding: the plan's Broborg coordinate was 2.6 km off
(see §2.1); and §4.5's basin check came back **positive** — false basins up to ~6.3 ha
exist in the slider range, so the per-century connectivity bitmask **is** needed.
1. Create Geotorget account, order *Markhöjdmodell Nedladdning* (manual, free, one-time).
2. Script: STAC query → windowed download of the 4×4 km Broborg DEM extent (§7.11).
3. Download RAÄ Uppsala-county GeoPackage; `ogrinfo` the **new (Oct 2025) schema**; locate
   Broborg's record; confirm its L-number and geometry type.
4. **Gate: multidirectional hillshade of the 1 m DEM in QGIS/matplotlib — are the ramparts
   (1–2 m high, 8–15 m wide) clearly legible?** Expected yes at that size; if marginal,
   fall back to a 0.5 m DEM rasterized from *Laserdata skog* ground returns before any
   rendering work.
5. Fetch SGU soils for the bbox from the OGC API; confirm the schema; spot-check the
   strandförskjutningsmodell download URL.

**Deliverable:** a `notebooks/` or `pipeline/spike/` artifact with hillshade images, plus
corrections to this plan where the schema assumptions were wrong.

### Phase 1 — Broborg terrain on screen *(the plan's first milestone)*
- Pipeline: clip/fill/compress DEM → `dem_core.tif` (1 m, 2×2 km) + `dem_context.tif`
  (2 m, 4×4 km) + `manifest.json` (§4.1).
- App: Vite + TS + three.js scaffold; geotiff.js decode → chunked heightfield mesh;
  central-difference normals; low-angle directional sun + hemisphere light; sun-azimuth
  and vertical-exaggeration controls; orbit camera.
- **Milestone: open the page, orbit Broborg, see the ramparts in the mesh itself.**

### Phase 2 — Standing on the walls
- First-person camera (pointer lock), eye height 1.7 m, terrain-clamped walking, walk
  speed appropriate to scale; smooth toggle orbit ↔ first-person (fly-to transition).
- **Milestone: stand on the rampart, look down Långhundraleden valley.**

### Phase 3 — Viewshed (the centerpiece)
- Web Worker computing visibility over the full grid from a draggable observer marker;
  observer eye-height and target-height sliders; curvature+refraction correction toggle
  (default on); result as a data texture blended onto the terrain material
  (visible / hidden shading).
- Validate against GDAL's `gdal_viewshed` on the same grid in pipeline tests.
- **Milestone: drop an observer on the rampart, see exactly what the garrison saw.**

### Phase 4 — Paleo-shoreline slider
- Pipeline: century → level lookup (SGU model + Påsse & Daniels), embedded in manifest.
- App: water plane + shore shading; century slider (~1000 BCE → 1200 CE); readout shows
  both year and meters-above-present; optional link to viewshed ("what could you see of
  the water?").
- **Milestone: scrub the slider, watch the valley become a navigable bay in the fort's era.**
- Basin-connectivity correctness: see decision §4.5 — v1 checks whether it matters at
  Broborg and gates the feature on evidence.

### Phase 5 — Sites overlay & palisade
- RAÄ overlays: fornborg extent, nearby gravfält/boplatser/färdvägar as flat, clearly
  cartographic markers (distinct from terrain), popups with Fornsök links (K-samsök
  enrichment optional).
- Rampart polyline derivation (§4.6) → instanced, ghosted, deliberately schematic palisade
  with height/spacing parameters; labeled **conjectural** in UI and legend.
- **Milestone: toggle the palisade; the fort reads as a fortification, unmistakably marked
  as conjecture.**

### Phase 6 — Honesty, polish, deploy
- Methods/about panel (§6), legend with provenance badges, attribution footer, loading UX,
  mobile-degraded but functional view; GitHub Pages deploy via Actions; a `sites.json`
  registry so a second site is a data addition, not a code change.
- **Milestone: public URL.**  ← end of v1

### Phase 7 — Modeled Iron Age landscape — ✅ DONE 2026-08-21
- Pipeline rule engine (§4.7) → land-cover classification raster + legend; instanced
  low-poly vegetation (procedural cones/billboards as built then; rendering superseded
  by the §6.1 amendment's species-level archetypes) driven by it; "modeled landscape"
  toggle, labeled as a model, with the rules disclosed verbatim in the methods panel and
  the forest/open ratio sanity-checked against §2.5 literature.
- Built as contract v1.2 (`docs/data-formats.md` §9–§10). One deliberate deviation from
  §4.7's sketch: the classification ships as a **uint8 GeoTIFF on the exact context-grid
  geometry (2 m)** instead of an indexed-palette PNG at 5–10 m — reuses the frozen §1
  raster machinery end-to-end (pipeline COG writer, app geotiff decode), no PNG codec
  dependency, finer than planned; the palette lives in the legend JSON. Reference
  century fixed at **500 CE** (fort era, level 8.6 m from the §2.4 table); the app
  masks vegetation below the *current* slider level via the §7 connect grid, so the
  raster is never re-derived for other centuries. Amended 2026-08-21 (i): an eighth
  class, **"Settled ground (kept clear)"**, claims the registered footprints of the
  era's occupied remains plus a disclosed 20 m margin — without it the soil rules
  reforested the fort interior and the grave fields (Broborg's own footprint had
  classified 100 % forest, i.e. trees inside the hillfort).
  Amended 2026-08-21 (ii), the general-improvements bundle (contract **v1.3**):
  **(a) dynamic hydrology** — the open sea and the shore reed belt leave the raster
  and are re-derived by the app at the *current* slider level from the §7 connect
  grid (§9 carve-out; classes marked `dynamic` in the legend), fixing the stale
  sea tint and the reed belt stranded at the reference shoreline (it was only valid
  ±~100 yr of 500 CE); **(b) widened KMR evidence** — single graves, skärvstenshögar,
  prehistoric house grounds etc. join the proxies and the kept-clear footprints
  (basis: `pipeline/spike/type_survey.py`, 195 forts in 3 counties, 99 % have such
  records in frame; Broborg's own extract grew 38 → 127 records); **(c) mapped field
  remains** (fossil åker, röjningsrösen, terraces) classify as farmland on their own
  evidence before any proximity heuristic; **(d) färdväg lines** keep an 8 m open
  corridor; **(e) "Wooded pasture (grazed, half-open)"** — sparse broadleaf (20/ha)
  on till within a 300 m grazing radius of the evidence (deliberately tighter than
  the 700 m farmland radius: infield/outland — at 700 m the rule swallowed most of
  the broadleaf forest). Broborg result: 25.3 % closed forest, 11.5 % wooded
  pasture, 57.5 % open ground (3.4 % settled), 5.7 % peat fen, 0.1 % modern water in
  the raster, plus the runtime sea (2.5 %) and reed belt (1.3 %) at the 500 CE
  level — consistent
  with the §2.5 "strongly grazing-opened Iron Age landscape" picture (no quantified
  Uppland benchmark exists; disclosed in the legend's calibration paragraph).

### Phase 8 — Far-field rings & the horizon guarantee ("see the horizon")
*(Split 2026-08-21, owner decision: the horizon work is Phase 8; everything about
multiple locations moved to Phase 9 below.)*
- **Far-field rings & horizon guarantee (owner decisions 2026-08-21, doc §2b):** every
  site ships concentric 2000² rings (8×8 km @ 4 m → up to 128×128 km @ 64 m, coarser
  vertical quantization on far rings) sized **adaptively per site** so the skyline
  closes at the true refracted horizon (`d ≈ 3.83·√h` km, `h = (crown + 2 m) − floor`)
  **from the first-person viewpoint on the fort** — lowland forts stop at 64×64 km,
  high sea/lake-facing forts get 128×128 km. Additive **contract v1.4**
  (`docs/data-formats.md` §11): optional `grids.rings` array with per-ring
  `encoding.scale`, an optional ring4 `waterConnect` grid for far-water rendering,
  and an informational `horizon` block. Render side: curvature-displaced annulus
  meshes (the horizon is ~280 m below flat-earth at 64 km), log depth buffer, lazy
  inside-out ring loading (a missing ring = nearer fog line, never an error);
  paleo-water rendered out to the 16 km ring then faded (uplift-gradient honesty
  caveat in the doc). Pipeline side: adaptive ladder from crown/floor heights,
  per-ring decimated overview reads with STAC pagination, uncovered cells (open
  Baltic) sea-filled at 0 m and disclosed in provenance (Copernicus GLO-30 fill
  deferred to Phase 9 — Broborg's ladder stays inside Lantmäteriet coverage).
  Broborg rebuilt with its ladder (expected rings 3–6, ~+7 MB).
- Exit criterion: standing on Broborg's rampart, the skyline closes at the true
  horizon, not a fog wall; near scene byte-equivalent to v1; testsite unchanged.

### Phase 9 — National scope ("view any Swedish fornborg")
- **Strategy researched and documented 2026-08-21 → `docs/national-scaleout.md`.**
  Key measured facts: **1,304 registered fornborgar** nationally (1,227 bedömda som
  fornlämning; Södermanland 242, Stockholm 240, Västra Götaland 223, …); 99.7 % fit the
  v1 4×4 km extent (extent p95 = 350 m; only 3 sites > 1 km need a `large` preset);
  centroids touch just 504 Lantmäteriet DEM tiles. Whole country ≈ **~4 GB of static
  bundles (~3 MB/site)** after two encoding wins (water-connect as delta vs. DEM: 10×;
  dropping COG overviews from web grids: −35 %) — the per-site static-bundle
  architecture scales as-is; **~12 GB** (~9 MB/site) with the Phase-8 horizon ladder
  (≈ $0.03/mo on R2). Hosting: app stays on GH Pages; bundles move to
  Cloudflare R2 (free egress, fits the free tier). No tiled/LOD terrain needed.
  Non-Swedish terrain in far rings (Norway, Finland, Åland) filled from **Copernicus
  GLO-30**, provenance-tagged (deferred from Phase 8).
- Sequenced 9a–9d (doc §7): encoding wins + batch pipeline (registry, tile cache,
  QA contact sheet) → ~25-site curated pilot on R2 → county-by-county fill to 1,304 →
  intervisibility stretch (76 % of forts have a neighbor within their context extent).

### Phase 10 — The time axis: three sliders and a real sun — ✅ DONE 2026-08-23
*(Owner decision 2026-08-23: the lil-gui panel is a debugging rig, not a way to look at
a hillfort. It moves behind `?debug=1` and a much simpler default menu replaces it.)*
- **The default control surface is three sliders** (`app/src/ui/timeBar.ts`, bottom
  centre): **year**, **time of year**, **time of day**. Nothing else — the seeds, the
  density multiplier, the vertical exaggeration and the viewshed parameters are all
  debugging affordances and are only reachable with `?debug=1`.
- **Water, palisade and vegetation are on by default**, at their default values. See the
  §6.1 amendment below for what happens to the opt-in caveat rule.
- **The sun is astronomical** (`app/src/sky/solar.ts`), computed from the site's real
  latitude for the year, day and hour the sliders set. Local apparent solar time as the
  time primitive (so 12:00 *is* the sun on the meridian, and ΔT — three hours of
  uncertainty at 1000 BCE — never enters); Meeus ch. 25 for the apparent solar
  longitude; **Laskar (1986)** for the obliquity, because Meeus's own polynomial is
  stated only for ±2000 yr and this slider reaches 3050 years before J2000. Obliquity is
  the year slider's effect on the sun: 23.82° at 1050 BCE against 23.44° today, a quarter
  degree of midsummer noon altitude. Better than ~0.1° in the sun's direction anywhere
  in range.
- **Latitude comes from the manifest origin** by inverse SWEREF 99 TM
  (`app/src/lib/sweref.ts`) — the one exception to §4.3's "the browser never does
  projection math", allowed because its output lights the scene and places nothing. A
  `site.latLon` field in the manifest wins where one exists, so the pipeline can start
  shipping it without an app change; the two synthetic fixtures declare one, because
  their round-number `{e: 0, n: 0}` origin is on the equator.
- **The sun can now set**, so the scene needs a night (`app/src/sky/atmosphere.ts`): a
  stop table keyed on refracted solar altitude drives the background, the fog colour,
  both lights and a simulated dark-adapted `toneMappingExposure`. A table rather than
  physical extinction, deliberately — per-channel Rayleigh with Kasten–Young air mass
  puts the sun at pure crimson and near-zero output at 2° altitude, i.e. it destroys the
  raking light §4.2 exists to provide. The `h = 50°` sky stop is pinned to the old flat
  `#8fa3b4`, so the daytime look is preserved as the top of the ramp.
- **Archaeological periods are data** (`app/src/lib/periods.ts`), so the year slider can
  name the age it is scrubbing through — with the standing note that the boundaries are
  conventions in general Swedish use, not events.
- Exit criterion (met): at Broborg the sliders reproduce 16.63°/288.58° at the default
  pose, sunrise 02:34 and sunset 21:26 at midsummer, a midnight sun 6.6° below the
  horizon (the white night must never render as night), and 6.6° noon at midwinter.

### Phase 11 — The sky itself: sun, moon, stars, and water that reflects them — ✅ DONE 2026-08-23
*(Phase 10 computed where the sun is. Nothing drew it: the sun was a
`DirectionalLight` and a flat background colour, the methods panel said in as many words
that there was no moon and no stars, and the water was a self-lit slab with a hardcoded
sheen that had no idea what the sky was doing.)*
- **One clock for the whole sky.** `solar.ts` gains the sun's right ascension, and from it
  local apparent sidereal time — `LAST = 15°(t − 12) + α_sun`. Phase 10's sundial decision
  keeps paying: the entire celestial sphere hangs off the clock the sliders already set,
  with no second time system, no sidereal epoch and no longitude. The diurnal rotation is
  one 3×3 matrix, checked against `solarPosition` itself to 1e-9.
- **The moon** (`sky/lunar.ts`) is Meeus ch. 47, the truncated ELP-2000/82, gated on his
  own worked Example 47.a — 120 rows of coefficients where one wrong digit would be
  invisible, so the test reproduces λ = 133.162655°, β = −3.229126°, Δ = 368409.7 km to his
  printed precision. Topocentric parallax (ch. 40) is applied: 0.95°, nearly twice the
  moon's own diameter, so a geocentric moon sits visibly too high exactly when it is low.
- **ΔT comes back** (`sky/deltaT.ts`), and this is the one place Phase 10's headline
  property does not extend. The sun *defines* the sundial; the moon does not, and its place
  can only be computed on a dynamical timescale. At 1050 BCE ΔT is 7.3 hours — 4° of lunar
  longitude, eight lunar diameters — so it is applied (Espenak–Meeus, three branches) and
  its own ±20 min stated, rather than a 4° error being left in silently.
- **Phase without a phase angle.** The renderer reconstructs each pixel's point on the
  lunar sphere and lights it with the sun's direction, so the illuminated fraction and the
  tilt of the terminator both fall out of the geometry. Reflectance is Lommel–Seeliger,
  which is why a full moon reads as a disc rather than a ball.
- **The face is a schematic** (`sky/lunarFeatures.ts`): fourteen maria and four ray craters
  at their catalogued selenographic coordinates, sized by their catalogued diameters, north
  placed from the ecliptic pole. No noise, no photograph — and called a schematic in the
  methods panel, because a soft disc is an approximation of a mare's outline. Libration is
  not modelled.
- **5 044 stars to V = 6.0** — the naked-eye limit, and so the right limit for a sky with
  no light pollution. XHIP (Anderson & Francis 2012, VizieR V/137D) by way of
  d3-celestial's derived file; 80 kB committed under `app/public/data/sky/` with its own
  `DATA-LICENSES.md`, decoded by column *name* so a proper-motion catalogue later is a data
  change with no app change. Precession is Meeus ch. 21 rigorous and deliberately **not** a
  long-term model: over ±3050 yr it costs an arcminute against Vondrák (2011), three orders
  of magnitude below the error already carried for want of proper motions. The check is
  historical — the pole lands on Thuban around 2700 BCE, and at 1050 BCE is near neither
  Thuban nor Polaris. **The Iron Age had no pole star**, which is worth knowing before
  drawing conclusions about what a rampart was aligned on.
- **Proper motion is not applied and is the largest error in the night sky**: 4.5° for
  61 Cygni, 3.2° for μ Cassiopeiae, 1.9° for Arcturus over 3 050 years, well under half a
  degree for everything else. Stated in the methods panel with those numbers.
- **The sky is drawn** (`sky/skyDome.ts`, `sky/skyChunk.ts`) as a gradient with a sunset
  aureole. The §4.5 fog agreement survives structurally, not by tuning: `skyGradient`
  returns *exactly* `Atmosphere.state.sky` at `dir.y = 0`, and that is the fog colour.
  `scene.background` still tracks the same value, so a dome that failed to draw degrades to
  the old flat sky rather than to black.
- **The water reflects the sky, not the landscape.** No mirror pass — a second render of
  150 000 instanced trees at a 96 km far plane is roughly a doubling of frame cost. Instead
  the water compiles the *same* GLSL chunk as the dome with the *same uniform objects
  shared by reference*, and evaluates it along the reflected ray, so the sunset in the
  water is the sunset in the sky by construction. Real Schlick Fresnel replaces the fake
  `pow(1 − |viewDir.y|, 4)`; three crossing wave trains fade with distance into the
  specular lobe's roughness, which is what makes a glitter path instead of an aliasing
  machine; `tonemapping_fragment` is dropped so the reflected sky and the sky agree at the
  horizon line where they meet, and the body of the water carries the exposure by hand.
- **Not drawn, and said so:** no planets (Venus at −4 would be the brightest thing up there
  after the moon), no Milky Way (the only offline source has no checkable licence), no
  libration, no lunar surface imagery, no aerial-perspective fog — that last one leaves a
  bounded seam at the sun's azimuth at sunset, which `docs/night-sky.md` §5 describes.
- Exit criteria (met): Meeus Example 47.a to six decimals; the ΔT branches join to under a
  second; the pole at Thuban around −2700; the equatorial→world rotation agrees with
  `solarPosition` to 1e-9; Sirius in the committed catalogue at its J2000 place; and the
  five headless configurations in `scripts/verify-night-sky.mjs` with no console error.
  Full detail in `docs/night-sky.md`.

### Phase 12 — Reconstruction mode — research complete 2026-08-24, implementation not started

A second overlay mode: instead of drawing registered sites as flat cartographic markers
coloured by `lamningstyp`, draw the monuments **as they may have looked when in use**.

Research, categorisation and the full per-type specification live in
**`docs/reconstruction-mode.md`**. Summary of what it settles:

- **Eleven archetypes** (fort, earth mound, stone setting, cairn, fire-cracked stone mound,
  standing stone, grave field, farmstead, field boundary, cultivated ground, route &
  monument stone), mapping all 26 types in `fetch_sites.py: SELECTED_TYPES`. Grouping is by
  shared geometry recipe, not by register label — `Gravfält` expands into a composition of
  the others using its own enumerated contents.
- **The register is parseable.** 92 % of Broborg's 127 records carry a plan size, 87 % a
  stone-size range, 54 % a `kantkedja`, 32 % a robbing pit with dimensions, and 28 of 31
  grave fields state their own monument count and class composition. Reconstruction is
  mostly *sampling measured parameters*, not inventing them.
- **Every KMR number is a ruin measurement**, and the document's core is three stated,
  reversible ruin→original transforms: rampart re-profiling by cross-section conservation
  (§5.1), kerb-gated mound re-profiling (§5.2), and robbing-pit fill (§5.3). The rampart
  transform bounds Broborg's inner wall at 2.3–3.5 m of stone rather than pinning a number,
  and the sensitivity table is published with it.
- **A §7 worked example** builds Broborg specifically: cross-section, entrances, the
  vitrified band on the inner face, superstructure states, interior treatment, and the
  instancing budget.
- **Provenance maps onto §6.1 with no new badge** — Measured / Derived→Model /
  Assumed→Conjecture — with the rule that one monument carries *different badges per part*
  (a mound is measured in plan, model in profile, conjecture in surface).
- Reconstruction wires into the Phase 10 time slider: the archetypes are not
  contemporaneous, and at 500 CE there must be **no runestones**.

Open questions for the owner are listed in `docs/reconstruction-mode.md` §11 — chiefly
whether the mode replaces or overlays the markers, and whether the farmstead archetype
(the least evidenced and most persuasive) ships at all in v1.

---

## 4. Technical decisions & rationale

### 4.1 Elevation encoding: one Cloud-Optimized GeoTIFF, decoded in-browser
**Decision:** ship two grids per site (extent per §7.11: 4×4 km core+context) and decode
with **geotiff.js** into `Float32Array`s:
- `dem_core.tif` — 1 m, central 2×2 km (4 M samples), drives the core mesh and its normals;
- `dem_context.tif` — 2 m, full 4×4 km (4 M samples), drives the context-ring mesh, the
  viewshed, and the water shading.

Both int16 decimeters (±5 cm quantization error, irrelevant vs. LiDAR accuracy) with
deflate + predictor ≈ **4–10 MB total**.

**Rationale:** the viewshed and water features need the *actual height grid* in JS anyway.
A 16-bit PNG heightmap adds min/max packing metadata and a 16-bit-PNG decode path (canvas
APIs are 8-bit; you'd need fast-png/UPNG anyway — a dependency just like geotiff.js).
Quantized mesh (Cesium-style) optimizes a streaming-LOD problem v1 doesn't have and would
*separate* the render mesh from the analysis grid. Revisit tiled formats only at Phase 9.
Load UX: progress bar; context grid can load first for instant overview, core swapped in
when ready.

### 4.2 Terrain mesh
- Two-ring layout (per §7.11): a 1 m-resolution **core mesh** over the central 2×2 km
  (2000² ≈ 4 M vertices, built as ~16 index-buffered, frustum-cullable chunks) and a 2 m
  **context ring** out to 4×4 km (~3 M vertices), skirted at the seam to hide the
  resolution step. If low-end profiling hurts, halve core mesh density **but keep shading
  at 1 m** via a normal map computed from the full-res grid — earthwork legibility lives
  in the normals, not the silhouette.
- Normals from the height grid (central differences / Sobel), not from the possibly
  decimated mesh.
- **Legibility lighting:** adjustable low-angle directional sun + hemisphere ambient;
  optional curvature/slope tint (computed in pipeline or on load) to emphasize banks and
  ditches, hillshade-style. This is the feature that makes phase 1's milestone work.
- **Vertical exaggeration** (1.0–2.5×) implemented as a Y scale on the terrain *group* so
  water plane, observer height, palisade and markers inherit it consistently; analysis
  (viewshed) always runs on unexaggerated data.

### 4.3 Coordinates: EPSG:3006 meters ↔ scene units, 1:1
- Pipeline reprojects **everything** to EPSG:3006 and subtracts a per-site origin
  (`manifest.origin = {e, n}`, chosen at the DEM clip's SW corner or site center).
- Scene mapping: **x = easting − origin.e, y = height (m RH 2000), z = −(northing −
  origin.n)** (three.js is right-handed y-up, so north must map to −z to keep east=+x and
  a top-down view looking like a map). One 10-line helper module, used by every layer;
  the browser never does projection math, only origin subtraction.
- Heights used as-is: RH 2000 meters = scene y. Water levels from §2.4 are already in the
  same datum. (Beware the pipeline `-novshift` gotcha, §2.1.)

### 4.4 Viewshed: CPU reference-plane sweep in a Web Worker
**Decision:** Wang et al.-style **XDraw/reference-plane algorithm** (O(n) per cell, single
pass over the grid) in a Web Worker on the **2 m full-extent grid** (4×4 km = 4 M cells,
per §7.11); output a `Uint8Array` visibility mask uploaded as a `DataTexture` and blended
in the terrain shader over both core and context meshes. 2 m resolution is ample for
landscape-scale visibility; the 1 m core grid exists for shading, not line-of-sight.

**Rationale & alternatives considered:**
- Exhaustive per-cell Bresenham LOS is O(n²·r) — not interactive at 4 M cells.
- GPU depth-cubemap from the observer (point-light shadow trick) is real-time under drag
  but has grazing-angle precision problems on *subtle* terrain (exactly our terrain),
  makes "target height" semantics awkward, and is hard to validate. Keep as a possible
  later enhancement for continuous-drag feedback.
- XDraw at 4 M cells (the 2 m grid) is an estimated 50–200 ms in a worker — fast enough for
  recompute-on-drop plus throttled (~4–5 Hz) recompute during drag, with the UI thread
  never blocked. Deterministic and directly testable against `gdal_viewshed` (phase 3
  includes that test); its known approximation vs. exact LOS is acceptable and disclosed.
- Parameters: observer height above ground (default 1.7 m), target height (0 m = "see the
  ground", 1.7 m = "see a person"), max radius, and **earth curvature + refraction
  (k≈0.13), default on** — at 10 km the curvature drop is ~7.8 m, which is *not*
  negligible for Mälaren-scale water sightlines and materially affects the thesis.

### 4.5 Water plane & basin correctness
- Rendering: one semi-transparent plane at level *h*; terrain shader depth-tints submerged
  ground (smooth shoreline, no z-fighting fringe). *Phase 11 replaced the original
  "fresnel-ish" shading with the real thing: Schlick with n = 1.33, animated wave normals
  that fade into a specular roughness with distance, and a reflection of the **sky** — the
  same GLSL and the same uniform objects the sky dome draws from, evaluated along the
  reflected ray. Not a mirror pass: the landscape does not appear in the water, which
  `docs/night-sky.md` §6 explains and the methods panel states.*
- **Flood-fill correctness:** a plane naively fills enclosed basins that never connected
  to the sea. **Phase-0 result: false basins DO exist** — edge-connected flood fill on the
  4×4 km clip at 1 m levels from 4–18 m found interior (non-sea-connected) wet components
  at most levels, the largest ~6.3 ha at the 11 m level and ~2.3 ha at 15 m (fort-era
  levels ~8–10 m are milder, ≤0.3 ha). Decision resolved: the pipeline precomputes the
  per-century **sea-connectivity bitmask** (≤12 centuries × 1 bit/cell, trivially small
  compressed) and the shader masks the water. The logic stays in preprocessing, never in
  the browser. (`pipeline/spike/basin_check.py`.)

### 4.6 Procedural palisade — and the rampart-geometry reality
Research finding that reshapes this feature: **KMR almost certainly provides only the
fort's extent polygon, not per-rampart geometries** (**[reported]**, phase 0 confirms).
Plan:

1. **Primary approach (automatic):** derive the rampart crest line *from the DEM* — take a
   corridor around the RAÄ extent-polygon boundary, find the local elevation ridge within
   it (per-transect max or a simple ridge-following pass in `rampart.py`), smooth, densify
   to ~0.5 m, sample heights → `rampart.json` polyline. This keeps the hard constraint:
   generated from data, reproducible, and it follows the *actual* earthwork rather than a
   registration boundary.
2. **Fallback (approved):** if ridge extraction is noisy, a one-time hand-*digitized*
   polyline traced over the LiDAR hillshade in QGIS, committed as GeoJSON with a
   provenance note ("digitized from Lantmäteriet 1 m hillshade, <date>") and surfaced as
   such in the methods panel. Rationale: georeferenced tracing of a measured surface is
   data capture, not asset modeling — the constraint targets hand-modeled 3D art, not
   digitization.
3. Rendering: `InstancedMesh` of tapered cylinders along the polyline (spacing ~0.4 m,
   height parameter default ~3 m, deterministic seeded jitter in height/lean so it reads
   as schematic, not reconstructed), ghosted semi-transparent material with fresnel edge
   glow, distinct cool hue, and a persistent **"conjectural"** label in legend and popup.
   No textures, no gates, no walkways — deliberately abstract.

### 4.7 Land-cover model (phase 7 design)
- Pipeline raster rule engine at 5–10 m resolution. Inputs: rasterized SGU `grundlager`
  class, slope (from DEM), elevation vs. the chosen reference century's shoreline,
  distance to registered contemporaneous sites (gravfält/boplatser as settlement proxies).
- Rules (v0, to be tuned): below shoreline → water; gyttja/torv → wetland; postglacial
  lera near settlement proxies → open farmland/wet meadow split by drainage class; sandy/
  silty soils & till margins near sites → early farmland; morän/berg → forest;
  isälvssediment ridges → dry open corridors. Output: indexed-palette PNG + JSON legend
  (each class carries its rule text for the methods panel).
- App: instanced low-poly cones (conifer/broadleaf as two cone variants) and cross-quad
  billboards for reeds, blue-noise-sampled per class with per-class density; a single
  draw call per vegetation type. Toggle labeled **"modeled landscape (rule-based)"**.
  *(Rendering superseded by the §6.1 amendment: species-level procedural archetypes;
  sampling, densities and the toggle unchanged.)*
- Calibration: compare resulting forest/open ratio against §2.5 literature; report the
  comparison in the methods panel rather than force-fitting.

### 4.8 Stack
- **TypeScript + Vite + three.js** (plain three; no react-three-fiber — the app is one
  scene with a small control surface, and R3F would add a framework for little gain).
  UI: hand-rolled panel or lil-gui for phase 1–3 controls, custom HTML for the methods
  panel and legend. State: a small typed store (zustand or hand-rolled events).
- **Python pipeline:** `uv`-managed project; rasterio, geopandas, shapely, pyproj, click;
  requests+STAC for downloads; pytest with tiny synthetic DEM fixtures (viewshed
  reference tests, rampart extraction tests).
- **Deploy:** GitHub Pages via Actions. Pipeline runs locally (credentials for Geotorget
  never enter CI); its outputs are committed (small site: ~10–20 MB fits a repo; if it
  grows, GitHub Releases or LFS — see §5).

---

## 5. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **DEM resolution vs. rampart visibility** — 1–2 m-high, 8–15 m-wide ramparts on a 1 m grid should be visible, but TIN interpolation may soften them | Kills the core visual claim | ✅ **Retired — phase-0 gate passed**: both ramparts and the entrance gaps clearly legible in the 1 m hillshade (`pipeline/spike/out/`); Laserdata-skog fallback not needed |
| **Geotorget friction** — account + product-order steps are manual; API tiles need Basic auth; rate limits (429) | Delays phase 0; blocks CI-side data refresh | One-time manual step, documented in `pipeline/README`; credentials via env vars, never in CI; windowed COG reads keep volume tiny |
| **RAÄ Oct-2025 schema unknown** — layer/attribute names (`lamningstyp`, `ing_lamn`) unverified in the new GeoPackage | Breaks site filtering assumptions | Phase 0 inspects real file first; pipeline isolates schema mapping in one module |
| **No per-rampart geometry in KMR** | Palisade can't extrude "the registered rampart geometry" as originally envisioned | §4.6: DEM ridge extraction (primary), hand-digitized trace (fallback, needs your sign-off) |
| **Viewshed performance** at 4 M cells | Centerpiece feels sluggish | Worker + XDraw (est. 50–200 ms); throttled drag updates; radius cap; GPU path as a later upgrade, never a v1 dependency |
| **Initial download size** (DEM 4–10 MB + assets) | Slow first load, GH Pages bandwidth | int16-dm quantization, deflate, progress UX, context-grid-first loading; per-site lazy loading from day one |
| **Shoreline model uncertainty** (±500 yr per SGU; datum subtleties; Mälaren regulation +0.86 m) | Overclaiming exactness would undermine the app's honesty premise | Slider is coarse (century steps), labeled as a model, uncertainty stated in-panel; fort's era predates Mälaren isolation so lake-regulation nuances don't bite v1 |
| **Data hosting in repo** grows with more sites | Repo bloat | Fine for 1–3 sites; move to Releases/LFS or an object host at Phase 9 |
| **Agency URL churn** (Lantmäteriet moved tiling schemes mid-2026; RAÄ restructured 2025) | Pipeline rot | Pipeline pins endpoints in one config module; PLAN and README record the "as of" date of every endpoint |

## Open questions (marked [open] above, consolidated)

**Phase-0 resolutions (spike run 2026-08-20):**
1. Exact Lantmäteriet attribution wording — **still open.** The STAC collection declares
   `license: CC-BY-4.0` with the terms at
   `https://www.lantmateriet.se/globalassets/geodata/geodataprodukter/anvandningsvillkor_for_vardefulla_datamangder.pdf`
   (host unreachable from the spike environment; pull the wording from that PDF or the
   Geotorget order confirmation). Working text in §6.3 stands until then.
2. ✅ Legacy `mhm-*` collections still resolve alongside `dtm-cog` — moot, `dtm-cog` works.
3. ✅ RAÄ schema mapped (§2.2): relational `lamning` table + denormalized
   `lämningar_län_<län>_*` layers; `lamningstyp` unchanged; **no structured dating column**.
4. ✅ Broborg = **L1943:7827**, uuid `184ca0f6-16f9-4de8-bbec-99aa959f9824`, one site-extent
   **Polygon** (~6 310 m²), centroid E 665 808 / N 6 627 881 (the plan's coordinate was
   2.6 km off — corrected in §2.1).
5. ✅ SGU jordarter: `jg2`/`jg2_tx` unchanged; full collection list in §2.3; EPSG:3006 in/out.
6. ✅ Strandförskjutningsmodell URLs confirmed (`strandforskjutning_<from>_<to>.gpkg`,
   `issjohav_<bp>` layers, **BP-keyed**, BP 1100 missing) **and** it has its own OGC API
   (14 `bp*` collections; `code` 1 = Hav / 4 = Sjö). No uplift-surface raster seen among the
   open-data files — level lookup will come from polygon∩DEM intersection or Påsse &
   Daniels directly, as planned.
7. ✅ False basins exist (largest ~6.3 ha at the 11 m level) → per-century connectivity
   bitmask confirmed necessary (§4.5).
8. K-samsök production key — **still open** (optional; only for popup enrichment).

**Resolved by decision (delegated by project owner, 2026-08-19):**
9. **Palisade fallback — approved.** Hand-digitized rampart trace over the LiDAR
   hillshade is an acceptable fallback: it is georeferenced data capture from a measured
   surface, not asset modeling. Ships as GeoJSON with explicit provenance, used only if
   automatic ridge extraction fails, disclosed in the methods panel. (§4.6 updated.)
10. **Pollen calibration — loose calibration accepted.** The land-cover layer is already
    labeled a rule-based model; calibrating its forest/open ratio qualitatively against
    the Uppland studies plus the quantified Scania benchmark is proportionate. The
    methods panel states plainly that no quantified openness estimate exists for Iron Age
    Uppland. Revisit only if phase 7 results look implausible.
11. **Site extent — 4×4 km, core + context.** A 2×2 km clip would cut the Långhundraleden
    sightlines short; full 1 m over 5×5 km (25 M cells) buys detail only the earthworks
    need. Decision: clip **4×4 km** centered on Broborg; terrain mesh at **1 m in the
    central 2×2 km core** (rampart legibility) and **2 m in the context ring**; viewshed
    computed at **2 m over the full extent** (4 M cells — same budget as before, at the
    resolution that matters for landscape visibility). The 1 m core grid stays available
    for shading/normals. (§4.1, §4.2, §4.4 updated.)

---

## 6. Methods & honesty

### 6.1 Three provenance classes, visually enforced

Every layer in the scene and every legend entry carries one of three badges, with distinct
visual language:

| Class | Layers | Visual language |
|---|---|---|
| **Measured** | Terrain (LiDAR DEM), RAÄ site geometries as registered | Opaque, naturalistic shading |
| **Model** | Paleo-shoreline level, land cover, vegetation | Naturalistic rendering permitted (amendment below); toggles & slider annotated "model"; uncertainty stated next to the control (e.g. "±500 yr, SGU") |
| **Conjecture** | Palisade (and any future reconstruction) | Ghosted/semi-transparent, cool hue, no surface detail; permanent "conjectural" tag in legend and on-hover |

**Amended 2026-08-22 (owner decision): naturalistic model rendering.** The original rule
made the *rendering style itself* part of the Model badge — vegetation was deliberately
schematic (flat-colour cones and blobs) so nobody could mistake it for a reconstruction.
That rule is retired: the vegetation layer now aims for as natural and photoreal-leaning
a look as the performance budget allows — procedurally *generated* species-level tree
models and impostors, never hand-modeled assets (§1's hard constraint stands unchanged).
Rationale: the schematic forms failed exactly where the model should persuade — up close
and at the treeline — and a badge that depends on ugliness conflates provenance with
rendering quality. What carries the honesty instead, unchanged or strengthened: the
"model" badge, the first-toggle caveat, the verbatim rule disclosure in the methods
panel, the legend's calibration text, and species composition tied to the zone evidence
(docs/vegetation-zones.md §2/§4). Provenance lives in the badges and the panel, not in
how rough the trees look.

**Amended 2026-08-23 (owner decision): model and conjecture layers default ON.** The
original rule made every model and conjecture layer opt-in, so a first-time visitor
landed on bare grey terrain and had to find four checkboxes before the scene meant
anything. Water, the palisade and the modelled landscape now come up already on. The
first-enable caveat cannot carry the honesty budget in that world — three toasts would
race a single 9-second timer and two would be overwritten in the same frame — so it is
replaced by **one combined caveat at load**: *"Measured terrain, with a modelled water
level and landscape and a conjectural palisade shown on top. Open Methods for what is
which."* Everything else that carries provenance is unchanged and unweakened: the legend
badges, the permanent notes beside each control, the methods panel, and the per-layer
caveats, which still fire the first time a layer is toggled in the debug panel.
`?debug=1` keeps the original opt-in defaults, so the debug rig — and the headless
verifiers written against it — see the pre-2026-08-23 app exactly.

**Amended 2026-08-23b (owner decision): the scene is the screen.** The default
view had accumulated prose — a technical subtitle under the fort's name, the
"terrain ×1.5" badge, the load-time caveat below, a camera hint above three lines
of attribution, and a legend panel in the corner — and a first-time visitor met
all of it before meeting the terrain. What is left over the scene now is the
fort's name, the time bar, and the fort browser. Everything else moved behind a
kebab menu in the top right corner: **Legend**, **Methods & sources**,
**Controls & camera**, **About & credits**.

Two disclosures this section had required *on screen* move with it, and the
owner's decision is that one click is close enough for both:

- The **exaggeration indicator** is no longer drawn over the terrain. It is
  stated in About & credits, rebuilt on every open so it quotes the value in
  force rather than the one at load, and it was already in the methods panel's
  terrain section (`EXAGGERATION_NOTE`). Where exaggeration is exactly 1.0 the
  sentence is omitted — there is nothing to disclose.
- The **combined load-time caveat** from the 2026-08-23 amendment above is no
  longer a toast. Its text is `PROVENANCE_SUMMARY` in `ui/menuContent.ts` and it
  is a permanent line in About & credits, next to the credits it belongs with.

Unchanged and unweakened: the legend's three badges (now a dialog rather than a
corner panel — the rows are byte-identical), the permanent uncertainty notes
beside each control, the whole methods panel, and the per-layer first-enable
caveats, which still fire for a `?debug=1` toggle. Methods & sources also stays
literally one click from the default screen through the time bar's "?" button.

The sun (Phase 10) is a **model** by the same test the shoreline meets: it is computed,
not measured, and not read from an asset. It carries the badge, states its own accuracy
in the methods panel, and says plainly which parts are not modelled at all — that night
is drawn with a simulated dark-adapted exposure and is far brighter than a real moonless
Iron Age night, and that the twilight colours are an artistic ramp keyed to the computed
solar altitude rather than radiative transfer.

UI rules: the methods panel is one click from anywhere; toggling any model/conjecture
layer on for the first time surfaces its one-line caveat (see the 2026-08-23 amendment
for the default-on case); vertical exaggeration ≠ 1.0 is always disclosed — since the
2026-08-23b amendment in the menu's About & credits and the methods panel rather than
as a badge over the terrain; the viewshed panel states its algorithm,
observer/target heights and curvature setting; screenshots (if we add an export button)
bake the active caveats into the image margin.

### 6.2 Methods panel contents
- What the terrain is (Lantmäteriet 1 m LiDAR DEM, RH 2000/SWEREF 99 TM, processing steps)
  and what it is not (modern ground surface incl. later disturbance — not an Iron Age
  surface).
- How the shoreline levels were derived (SGU Strandförskjutningsmodell / Påsse & Daniels
  2015), with the ±500 yr caveat and the datum note.
- The land-cover rule list, verbatim, plus the pollen-literature sanity check (§2.5) and
  its limits.
- The palisade's status: no archaeological evidence for its specific form is claimed;
  parameters shown are adjustable guesses along a data-derived line.
- Dating honesty: RAÄ records rarely carry per-site dating; period attribution is by site
  type ("typisk datering") unless a cited excavation says otherwise (Broborg: ~400–550 CE
  per excavation literature).
- How the sun is computed (site latitude from the manifest origin, apparent solar time,
  Meeus ch. 25 and Laskar 1986), with its accuracy claim and the disclosure that the
  night lighting and the twilight palette are legibility choices rather than physics.
- How the **moon and the stars** are computed and what they leave out (Phase 11): Meeus
  ch. 47 and ch. 40 for the moon; that ΔT — which the sun's design avoided entirely — has
  to come back for it, is 7.3 hours at 1050 BCE, and is applied; that the moon's face is a
  *schematic* of catalogued maria rather than an image, with no libration; XHIP/Hipparcos
  for the stars, precessed but carrying **no proper motion**, quantified star by star; that
  **no planets** are drawn although Venus would outshine everything but the moon; and that
  the water reflects the computed sky and not the landscape.
- Full citation list (incl. Broborg excavation/vitrification literature) and a link to
  this repository.

### 6.3 Attribution & licenses (footer + methods panel)

- **Lantmäteriet (CC BY 4.0, required):** shown persistently in the app footer, not only
  in the panel. Working text pending the exact mandated wording (**[open §7.1]**):
  *"Höjddata: © Lantmäteriet, Markhöjdmodell Nedladdning (CC BY 4.0)"*.
- **Riksantikvarieämbetet (CC0, voluntary):** *"Fornlämningsinformation från
  Riksantikvarieämbetet, Kulturmiljöregistret (CC0), hämtad <date>"*.
- **SGU (CC0, voluntary):** *"Jordarts- och strandförskjutningsdata från Sveriges
  geologiska undersökning (CC0)"*.
- App code license: MIT (repo already carries LICENSE); data directory carries a
  `DATA-LICENSES.md` restating the above per file.

---

*Phase 0 complete and the hillshade gate passed (2026-08-20). Phases 1–6 (v1) shipped
2026-08-20/21. Phase 7 (modeled Iron Age landscape) shipped 2026-08-21 as contract
v1.2. National scale-out strategy documented 2026-08-21
(`docs/national-scaleout.md`) and split 2026-08-21: Phase 8 = far-field rings &
horizon guarantee (contract v1.4 — ring pipeline + curvature/log-depth/lazy-ring
rendering); Phase 9 = national scope. Broborg rebuilt with its ring ladder
2026-08-21: rings 3–6 out to 64×64 km, horizon d ≈ 24.8 km (crown 50.4 m inside the
KMR extent + 2 m eye, floor 10.5 m), far-water connect on the 16 km ring, zero
sea-filled cells.*

***Phase 9a + 9b shipped 2026-08-22** (`docs/national-scaleout.md` §7.1–§7.2).
Contract **v1.5**, additive: §1a drops the COG container from bundle grids and §12
ships sea-connectivity as an int16 delta against the DEM — together taking the
Broborg bundle from 15.96 MB to **7.5 MB**, with every pre-v1.5 bundle still
loading unchanged (the committed `testsite` is the fixture that proves it). Batch
machinery: `registry.json` (**1,304 fornborgar**, independently reproducing every
measured figure in scale-out §1 from a stdlib GeoPackage reader), `build_site`,
QA gates, hillshade contact sheet, R2 sync with per-site resumable state, and
`VITE_DATA_BASE_URL` + a national site picker in the app. **9b pilot: 27 sites
across 15 counties published to R2**, mean 7.0 MB/site — a revised national
projection of ~9 GB against the ~12 GB estimate. Horizons 13.3–52.8 km, all well
inside the 128 km cap, and ring 7 used once (Ramundersborg), so the rare case is
real.*

*The §6.1-amendment tree track (species-level naturalistic rendering, owner
decision 2026-08-22) shipped 2026-08-22 on its parallel branch: seeded species
mixes and clumped stands over the unchanged §10 contract (conifer =
spruce/pine, broadleaf = oak/birch per `docs/vegetation-zones.md` §4),
home-generated per-species archetype meshes (no hand-modeled assets), a baked
impostor atlas with a 320 m mesh/impostor LOD split under the same 150k
budget, textured far-field silhouettes, and contact-shadow grounding. All
determinism streams and the shore-band invariants preserved; 444 app tests.*

*Two national-scope corrections the pilot forced, both of which had been failing
**silently**: the §2.4 shoreline literature band is Uppland's and was rejecting
correct derivations across the country (while the methods panel claimed a check it
had not run), and the elevation band can no longer catch a geoid shift once
widened for Norrland — that tripwire moved to a ring↔context agreement check,
measured at 0.00–0.20 m across the pilot. Copernicus GLO-30 remains deferred: no
pilot site needed it, the gate that would demand it is tested and fails loudly,
and Värmland's border-facing rings did not trip it. Next step: 9c (county-by-county
fill), which wants scale-out §4.2's shared tile cache first.*

***Phase 9d shipped 2026-08-23.** The zone-aware modelled landscape (near field +
the §13 far field, merged in PR #12) is live on R2 for all 27 pilot sites: every
bundle rebuilt with `--with-landcover`, `index.json` reports landcover on 27 of 27,
total 201 MB (mean 7.5 MB/site; the far-field ring rasters cost 14.3 MB across the
whole pilot). The Broborg control held: 4,000,000 of 4,000,000 raster cells
identical to the committed bundle, every class census equal, the pre-v1.5
back-compat fixture untouched. Build-time zone census: 2 nemoral / 21 boreonemoral /
4 southern boreal — the DEM-crown altitude term moves three sites against
`vegetation-zones.md` §1.3's altitude-inert pilot expectation (Kungsbjär/Halland up
to boreonemoral; Skansen/Värmland and Träleborg — the latter on a ~300 m Falbygden
diabase plateau — into southern boreal), the rule's documented ±, not a defect.
Alvar fractions as predicted (Eketorp 28.1 %, Ismantorp 1.7 %, Torsburgen 62.4 %,
Slottet 5.9 %, Gråborg 2.4 %) with conifer reading "Pine forest" wherever the
spruce front says absent — plus one genuine find: 3.7 % / 0.4 % alvar at Träleborg
and Halleberg, where SGU maps Sedimentärt berg on the Västgöta table mountains
(a true condition — Kinnekulle's Österplana hed is a mainland alvar — and the rule
text now says so). The unmatched-SGU-class tripwire fired at 17 of 27 sites and
surfaced 15 further class spellings, all now mapped in `SOIL_GROUPS` with
provenance comments (the age-undifferentiated clays deliberately render meadow,
never farmland candidates); the rebuilt pilot's unmatched log is empty. The §9
far-field checkerboard question is judged and closed — accepted as-is
(`far-field-vegetation.md` §9): invisible in first person, honest-schematic from
orbit. Billboard populations measured 32,881–79,800 on the four verification
sites, inside `FAR_MAX_INSTANCES`. Headless verification ran against the
published-identical bytes served locally on those four sites (full ring chains,
far tint and lazy-billboard contract all held; the one console error was the
then-unpublished `index.json`, since published), with the CDN hop verified
separately by curl (range 206, CORS headers) — the same two-halves split 9b
documented. Next: 9c — ready to start
once scale-out §4.2's shared tile cache exists; 76 % of sites share a neighbour's
tiles, so the fill without it would re-fetch the same Lantmäteriet tiles about a
dozen times over.*
