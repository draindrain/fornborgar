# Data formats — the pipeline ↔ app contract

**Status: FROZEN v1 (2026-08-20), amended v1.1 (2026-08-20, additive — §6–§8),
v1.2 (2026-08-21, additive — §9–§10), v1.3 (2026-08-21, additive — dynamic
hydrology in §9–§10), v1.4 (2026-08-21, additive — far-field rings, §11),
v1.5 (2026-08-22, additive — the §1a web grid layout and the §12 connectivity
delta, the two Phase-9a encoding wins), v1.6 (2026-08-22, additive — far-field
land cover, §13), v1.7 (2026-08-26, additive — reconstruction mode, §14),
v1.8 (2026-09-12, additive — fort interiors, §15).** This
file and the `manifest.json` schema below are the single source of truth for what the
Python pipeline writes under `app/public/data/<siteId>/` and what the TypeScript app
reads. Derived from PLAN.md §1, §4.1–§4.6 (incl. the [phase-0 verified] corrections).

**Versioning policy (clarified in v1.1):** `manifest.json.schemaVersion` is the
*breaking* version — it changes only when an existing field's meaning, encoding or
requiredness changes, and the app hard-fails on a version it does not know.
**Additive** changes (new optional `assets.*` entries, new file formats they point to,
new optional manifest keys) do *not* bump `schemaVersion`; they are recorded here as a
dated amendment **before** any code that reads or writes them is committed. A plain v1
manifest with none of the new assets (e.g. the testsite) must keep working in every
later app build — a missing `assets` entry always means "feature off", never an error.

## 0. Conventions used throughout

- **CRS:** everything georeferenced is SWEREF 99 TM (**EPSG:3006**), heights in meters
  **RH 2000**. The app never does projection math — only origin subtraction.
- **Local scene coordinates** (three.js, right-handed, y-up), given the per-site
  `origin = {e, n}` from the manifest:

  ```
  x = easting  − origin.e          // east  = +x
  y = height (m RH 2000)           // up    = +y   (scene units = meters, 1:1)
  z = −(northing − origin.n)       // north = −z  (top-down view reads like a map)
  ```

  The inverse: `easting = x + origin.e`, `northing = origin.n − z`.
  Exactly one helper module in the app implements these two mappings; every layer uses it.
- **Vertical exaggeration** is a render-only Y scale on the terrain *group* (so water,
  markers, palisade, observer inherit it). All analysis (viewshed, water logic) runs on
  the unexaggerated height grid.
- Per-site data directory: `app/public/data/<siteId>/`, reached from the app as
  `data/<siteId>/…` relative to the deployed base URL (GitHub Pages subpath — the app
  must not use absolute `/data/...` URLs; resolve against `import.meta.env.BASE_URL`).
  `manifest.json` is the single entry point; every other file is found via its
  `grids.*.path` / `assets.*` entries (paths relative to the manifest's directory,
  no leading slash, no `..`).

## 1. Elevation grids (`dem_core.tif`, `dem_context.tif`)

Two single-band GeoTIFFs per site (PLAN §4.1, extent decision §7.11):

| | `dem_core.tif` | `dem_context.tif` |
|---|---|---|
| Coverage | central 2×2 km | full 4×4 km |
| Resolution | 1 m/px | 2 m/px |
| Size | 2000 × 2000 px | 2000 × 2000 px |
| Drives | core mesh + normals (shading/legibility) | context-ring mesh, **viewshed**, water shading |

Both grids are **concentric on the site center** and axis-aligned in EPSG:3006. For
Broborg (site center E 665810, N 6627880 [phase-0 verified]) the context bounds are
E 663810–667810, N 6625880–6629880; core is E 664810–666810, N 6626880–6628880.

**Encoding (both files):**

- Band 1, **int16**, value = height in **decimeters**: `height_m = raw * 0.1`.
  No offset. (±5 cm quantization; int16 dm covers ±3276.7 m.)
- **No nodata cells.** The pipeline fills any nodata (rasterio `fillnodata`) before
  writing; the committed file has no nodata tag. The app does not implement a nodata path.
- Compression **DEFLATE**, predictor 2. The container layout is §1a below —
  since v1.5 bundles ship the plain striped form, and the tiled COG with
  overviews is archival only.
- CRS tag: **EPSG:3006 horizontal only** — the vertical CRS is deliberately stripped
  (source tiles declare compound EPSG:5845; carrying it invites the gdalwarp
  RH2000→ellipsoid vertical-shift bug, PLAN §2.1). Heights are RH 2000 by this contract.
- North-up, no rotation. GeoTIFF metadata `SCALE=0.1` is set for GIS interop, but the
  **manifest is authoritative**; the app ignores TIFF-embedded georeferencing/scale and
  uses `manifest.grids.*`.

**Pixel/array convention (app side):** geotiff.js decodes band 1 to a row-major array,
length `width*height`, **row 0 = northernmost row**, columns west→east. Values are raw
int16 decimeters; the app converts once to a `Float32Array` of meters and keeps that
single array as the source of truth for mesh, normals, viewshed, water. Sample
`(col, row)` is a **pixel center**:

```
x = boundsLocal.minX + (col + 0.5) * resolution
z = boundsLocal.minZ + (row + 0.5) * resolution     // rows grow southward = +z
y = raw[row * width + col] * 0.1
```

`boundsLocal` is precomputed in the manifest (`minX = minE − origin.e`,
`minZ = −(maxN − origin.n)`, etc. — note **minZ corresponds to the north edge**).
Terrain-mesh vertices sit at pixel centers; the context ring's inner cutout is skirted
against the core mesh edge (PLAN §4.2).

## 1a. Grid container layout (v1.5, 2026-08-22 — additive)

Applies to **every** raster this contract defines: the §1 elevation grids, the §11
rings, the §7/§12 connectivity grids and the §9 land-cover raster.

A bundle grid is a **plain striped GeoTIFF, full resolution only**:

| | Bundle (`web`) | Archival (`cog`) |
|---|---|---|
| Driver | GTiff | COG |
| Tiling | striped, 256 rows/strip | tiled 512×512 |
| Overviews | **none** | `average` (`nearest` for class rasters) |
| Compression | DEFLATE, predictor 2, zlevel 9 | DEFLATE, predictor 2 |
| Where it lives | `app/public/data/<siteId>/` and the object host | `data-cache/` only |

Rationale: the app reads full resolution only and always has — `geotiff.js` decodes
the whole band in one pass — so the overview pyramid and the 512-px tile grid were
pure download weight. Dropping them plus raising the DEFLATE level costs nothing in
fidelity: **the samples, georeferencing, CRS tag, `SCALE` band metadata and array
convention are byte-identical between the two layouts.** Measured on the real
Broborg grids **[measured 2026-08-22]**: `dem_core.tif` 1.67 → **1.01 MB**,
`dem_context.tif` 2.13 → **1.31 MB** (−39 % and −38 %).

- Strip height is **pinned** (not left to GDAL, which sizes strips by bytes and so
  would give an int16 grid and a uint8 class raster on the same geometry different
  strip heights). This is what keeps the §7/§9 "identical profile to
  `dem_context.tif`" promises checkable.
- Readers must not assume either layout. Every pre-v1.5 bundle — the committed
  `testsite`, and `broborg` until it is regenerated — is a tiled COG with
  overviews and stays valid forever; a reader that required overviews to be absent
  would break it.
- Archival COGs are still generated on request for GIS inspection (`--archive-cogs`
  on `build_site`); they are written into the gitignored `data-cache/` and are
  **never** part of a bundle.

## 2. `manifest.json`

One per site. Complete Broborg example (values illustrative where marked `<…>`):

```jsonc
{
  "schemaVersion": 1,
  "site": {
    "id": "broborg",
    "name": "Broborg",
    "raa": {                                  // optional block, present for Broborg
      "lamningsnummer": "L1943:7827",
      "raaNummer": "Husby-Långhundra 156:1",
      "kmrUuid": "184ca0f6-16f9-4de8-bbec-99aa959f9824",
      "fornsokUrl": "https://pub.raa.se/visa/objekt/lamning/184ca0f6-16f9-4de8-bbec-99aa959f9824"
    }
  },
  "crs": {
    "horizontal": "EPSG:3006",                // SWEREF 99 TM
    "verticalDatum": "RH2000"                 // meters; see docs/data-formats.md §1
  },
  "origin": { "e": 665810.0, "n": 6627880.0 },   // site center; scene (0,·,0)
  "grids": {
    "core": {
      "path": "dem_core.tif",
      "resolution": 1.0,                      // m per pixel
      "width": 2000, "height": 2000,
      "bounds3006":  { "minE": 664810.0, "minN": 6626880.0, "maxE": 666810.0, "maxN": 6628880.0 },
      "boundsLocal": { "minX": -1000.0, "minZ": -1000.0, "maxX": 1000.0, "maxZ": 1000.0 },
      "encoding": { "dtype": "int16", "scale": 0.1, "unit": "m" },
      "minElevation": <6.8>,                  // meters RH2000, measured from the data
      "maxElevation": <57.3>
    },
    "context": {
      "path": "dem_context.tif",
      "resolution": 2.0,
      "width": 2000, "height": 2000,
      "bounds3006":  { "minE": 663810.0, "minN": 6625880.0, "maxE": 667810.0, "maxN": 6629880.0 },
      "boundsLocal": { "minX": -2000.0, "minZ": -2000.0, "maxX": 2000.0, "maxZ": 2000.0 },
      "encoding": { "dtype": "int16", "scale": 0.1, "unit": "m" },
      "minElevation": <6.8>,
      "maxElevation": <57.3>
    }
  },
  "assets": {                                 // optional entries; absent = feature off
    "sites": "sites.json",
    "shoreline": "shoreline.json",            // v1.1 — §6 (century → water level)
    "waterConnectDelta": "water_connect_delta.tif", // v1.5 — §12 (the shipping form)
 // "waterConnect": "water_connect.tif",      // v1.1 — §7 (absolute grid; pre-v1.5 bundles)
    "rampart": "rampart.json",                // v1.1 — §8 (rampart crest polylines)
    "landcover": "landcover.tif",             // v1.2 — §9 (land-cover class raster)
    "landcoverLegend": "landcover_legend.json"// v1.2 — §10 (classes, palette, rules)
  },
  "layers": [                                 // provenance per layer (PLAN §6.1)
    { "id": "terrain", "name": "Terrain (LiDAR DEM)", "provenance": "measured" },
    { "id": "sites",   "name": "Registered sites (KMR)", "provenance": "measured" },
    { "id": "water",    "name": "Paleo-shoreline (SGU model)", "provenance": "model" },      // v1.1, iff assets.shoreline
    { "id": "landcover", "name": "Modeled landscape (rule-based)", "provenance": "model" },  // v1.2, iff assets.landcover
    { "id": "palisade", "name": "Palisade (conjecture)",       "provenance": "conjecture" }  // v1.1, iff assets.rampart
  ],
  "attribution": [                            // rendered in the app footer, in order
    { "text": "Höjddata: © Lantmäteriet, Markhöjdmodell Nedladdning (CC BY 4.0)",
      "license": "CC BY 4.0", "url": "https://www.lantmateriet.se" },
    { "text": "Fornlämningsinformation från Riksantikvarieämbetet, Kulturmiljöregistret (CC0), hämtad 2026-08-20",
      "license": "CC0", "url": "https://pub.raa.se" }
  ],
  "provenance": {                             // pipeline bookkeeping, shown in methods panel
    "generated": "<ISO-8601 UTC timestamp>",
    "pipeline": "fornborg-pipeline",
    "sources": [
      { "id": "lantmateriet-dtm", "product": "Markhöjdmodell Nedladdning (dtm-cog)",
        "tiles": ["<stac item id(s)>"], "fetched": "<ISO date>" }
    ],
    "processing": ["windowed /vsicurl read", "nodata fill (0 cells)", "int16 dm quantization", "COG deflate"]
  }
}
```

Rules:

- `provenance` values per layer are exactly one of `"measured" | "model" | "conjecture"`.
- All numbers are plain JSON numbers in meters (or m/px). No strings for numerics.
- The app must tolerate **unknown extra keys** everywhere (forward compatibility) and
  must hard-fail with a clear error if `schemaVersion !== 1`.
- Invariants the pipeline guarantees (and tests): `width == (maxE−minE)/resolution`,
  `height == (maxN−minN)/resolution`, `boundsLocal` consistent with `bounds3006` and
  `origin` per §0, core extent strictly inside context extent, identical
  `minElevation`-datum sanity (values in [−10, 200] for Swedish lowland sites — catches
  the +23–36 m geoid-shift bug).

## 3. `sites.json` (site markers, from RAÄ/KMR)

Local-coordinate registered sites for the overlay layer (fully used in Phase 5; Phase 1
may ship a minimal file with just the fort itself).

```jsonc
{
  "schemaVersion": 1,
  "fetched": "<ISO date>",                    // when the KMR extract was downloaded
  "sites": [
    {
      "id": "L1943:7827",                     // lamningsnummer, unique per site
      "name": "Broborg",                      // lamningsnamn or fallback to id
      "lamningstyp": "Fornborg",              // KMR type string, verbatim
      "provenance": "measured",
      "position": { "x": -2.0, "z": -1.0 },   // local coords of the representative point
                                              // (polygon centroid or the KMR point); the
                                              // app samples y from the DEM at runtime
      "geometryLocal": {                      // optional; GeoJSON-shaped, LOCAL coords
        "type": "Polygon",                    // Point | LineString | Polygon (+Multi*)
        "coordinates": [ [ [x, z], … ] ]      // positions are [x, z] pairs (NOT E/N!)
      },
      "fornsokUrl": "https://pub.raa.se/visa/objekt/lamning/<uuid>",  // optional
      "description": "<KMR beskrivning, may be long>"                 // optional
    }
  ]
}
```

## 4. Viewshed worker I/O (in-app, Phase 3 — fixed here so it can't drift)

Not a file format, but part of the frozen contract because pipeline tests validate it.

- Input grid: the **context** grid (2 m, 2000×2000), as the meters `Float32Array`
  in the §1 array convention, plus `width`, `height`, `resolution`.
- Observer given in **grid coordinates** `(col, row)` (fractional allowed) with
  `observerHeight` (m above ground, default 1.7), `targetHeight` (m, default 0),
  `maxRadius` (m, 0 = unlimited), `curvature` (bool, default **true**) with
  refraction coefficient `k = 0.13`: effective target drop
  `Δh = (1 − k) · d² / (2·R)`, `R = 6 371 000 m`, `d` = horizontal distance in meters.
- Output: `Uint8Array` length `width*height`, same array convention:
  **1 = visible, 0 = hidden**. (The observer's own cell is visible.) Rendered as a
  `DataTexture` blended over both meshes.
- Acceptance: pipeline pytest compares the worker (run under Node) against
  `gdal_viewshed` (`-cc 0.87` ≙ 1−k with GDAL's convention, same observer/target
  heights) on identical synthetic grids; required cellwise agreement ≥ 97 % overall on
  rough terrain and exact on analytically-known cases (flat plane, single ridge).
  (GDAL's earth radius differs from R = 6 371 000 m by ~0.1 %; the tolerance absorbs it.)

## 5. Synthetic test site (`app/public/data/testsite/`)

A tiny, committed, pipeline-independent fixture so the app never blocks on real data:
same manifest schema, `origin {e: 0, n: 0}`, small grids (e.g. core 256×256 @ 1 m,
context 256×256 @ 2 m, uncompressed int16 TIFFs are fine), procedural terrain (a hill
with a rampart-like ring so shading is judgeable). Generated by a committed script
(`app/scripts/make-test-dem.mjs`); loaded via `?site=testsite`. The app treats it
exactly like a real site — no code path branches on site id.

v1.1 note: the testsite generator also emits the §6/§7 water assets (a synthetic
century table and a connectivity grid over terrain that includes a deliberate **false
basin** — an enclosed depression whose floor is below several table levels but whose
rim is above them) so the Phase-4 water feature is exercised end-to-end without real
data, including the basin-exclusion behavior.

v1.4 note: the generator's `--rings` mode emits a SECOND fixture,
`app/public/data/testsite-rings/` (`?site=testsite-rings`), carrying two §11
far-field rings (one with a far-water `waterConnect`) plus a `horizon` block, so
the ring rendering path is exercised end-to-end without credentials. `testsite`
itself deliberately stays ringless — it is the proof that rings are optional.

---

# v1.1 amendment (2026-08-20) — Phase 4/5 assets

Additive per the versioning policy above; `schemaVersion` stays 1. Three new optional
assets. When `assets.shoreline` is present the manifest's `attribution` array MUST also
carry the SGU entry (CC0, voluntary but we always ship it):
`{ "text": "Strandförskjutningsdata från Sveriges geologiska undersökning (CC0)", "license": "CC0", "url": "https://www.sgu.se" }`
and `layers` SHOULD carry the `water` (model) entry; likewise `assets.rampart` ⇒ the
`palisade` (conjecture) layer entry. `assets.shoreline` and `assets.waterConnect` are a
pair: the app enables the water feature only when **both** are present.

## 6. `shoreline.json` — century → water-level table (PLAN §2.4, §4.5)

The per-site lookup table that drives the paleo-shoreline slider. Derived by the
pipeline from the SGU strandförskjutningsmodell (Påsse & Daniels 2015-based), never
computed in the browser.

```jsonc
{
  "schemaVersion": 1,
  "site": "broborg",
  "method": "<one-paragraph human-readable derivation description>",  // shown verbatim in the methods panel
  "uncertainty": "SGU strandförskjutningsmodell: dating margins up to ±500 years; general progression, not for detailed studies.",
  "datumNote": "Levels are meters RH 2000; 'above present sea level' agrees to within decimetres here.",
  "source": {
    "product": "SGU Strandförskjutningsmodell",
    "api": "https://api.sgu.se/oppnadata/strandforskjutningsmodell/ogc/features/v1",
    "fetched": "<ISO date>"
  },
  "steps": [
    { "yearCE": -1050, "bp": 3000, "levelM": 17.1 },
    // … one entry per SGU century step, ascending yearCE …
    { "yearCE": 1150, "bp": 800, "levelM": 4.2 }
  ]
}
```

Rules:

- `yearCE` is a signed integer calendar year, negative = BCE (astronomical numbering;
  the app formats `-1050` as "1050 BCE"). `bp` is SGU's years-before-1950 key
  (`yearCE = 1950 − bp`), informational. `levelM` is meters **RH 2000**, the water
  level to draw on our DEM for that century.
- `steps` sorted strictly ascending by `yearCE`, ≥ 2 entries, and `levelM`
  non-increasing with `yearCE` (post-glacial uplift: the sea only falls over the slider
  range). The pipeline tests all three invariants.
- Steps land on SGU's BP centuries; gaps in the product (BP 1100 is missing) simply
  have no entry. The app MAY interpolate `levelM` linearly between adjacent steps for
  continuous scrubbing; the readout shows the (possibly interpolated) year and
  `levelM` as "m above present sea level".
- Slider range = the table's extent (target ~1000 BCE → 1200 CE; PLAN §3 Phase 4).
- Sanity anchors the pipeline asserts against (PLAN §2.4, generous ±2.5 m bands):
  ~500 BCE ≈ 13–16 m, ~1 CE ≈ 10–12.5 m, ~500 CE ≈ 8–10 m, ~1000 CE ≈ 5–6.5 m.

## 7. `water_connect.tif` — sea-connectivity grid (PLAN §4.5)

> **v1.5 (2026-08-22):** the *semantics* below are unchanged and authoritative,
> but bundles now ship this surface in the delta form of **§12**
> (`assets.waterConnectDelta`) rather than as the absolute grid. The absolute
> form remains valid — pre-v1.5 bundles carry it and must keep loading.

Encodes, for every cell of the **context** grid, the minimum water level at which that
cell is hydrologically connected to the open sea. This one grid is exactly equivalent
to a per-century connectivity bitmask for *every* century (and every intermediate
level): sea-connectivity is monotone in the water level — the wet set at level *h* is a
subset of the wet set at any *h′ > h*, so a connecting path never disappears as the
level rises — hence "connected at level *h*" ⇔ `connect ≤ h`.

**Definition (computed by the pipeline, pytest-covered):** `connect(cell)` is the
**flood-fill elevation** of the context DEM: the minimum over all 4-connected paths
from any grid-edge cell to this cell of the maximum DEM elevation along the path,
floored at the cell's own elevation (i.e. the classic priority-flood depression-filling
output). Consequences the app may rely on:

- `connect(cell) ≥ dem_context(cell)` everywhere (pipeline-tested invariant).
- A cell is **wet and sea-connected** at water level `h` ⇔ `connect(cell) ≤ h`.
  (The elevation test is subsumed — one texture lookup in the shader, no second
  comparison against the DEM.)
- Cells inside a false basin carry the basin's *spill level*, not their own elevation,
  so they stay dry until the sea actually reaches the sill.

Sea entry = every grid-edge cell (the paleo-sea enters through the Långhundraleden
valley, which crosses the 4×4 km extent; matches `pipeline/spike/basin_check.py`).
Connectivity is **4-connected** (water does not leak between diagonal land cells).

**File encoding:** identical to the elevation grids (§1/§1a) — single band int16
**decimeters** (`meters = raw * 0.1`), no nodata, DEFLATE + predictor 2, the §1a
layout, EPSG:3006 horizontal only — and identical **geometry** to `grids.context` (same width,
height, resolution, bounds; row 0 = north). The app validates the dimensions against
`grids.context` and reuses the §1 array convention. No separate manifest grid entry:
`grids.context` is authoritative for its geometry.

Rendering contract (app side, PLAN §4.5): both the water plane and the terrain's
submerged-ground tint are masked by `connect ≤ h` — a naive `elevation ≤ h` test would
flood the false basins this asset exists to exclude. The water plane is parented under
the terrain group (inherits vertical exaggeration, contract §0).

## 8. `rampart.json` — rampart crest polylines (PLAN §4.6)

Data-derived crest lines of the fort's ramparts; the geometry the Phase-5 palisade is
instanced along. The *lines* follow the measured earthwork; the *palisade* rendered on
them is conjecture (see the layer entry).

```jsonc
{
  "schemaVersion": 1,
  "site": "broborg",
  "derivation": {
    "method": "dem-ridge",                    // "dem-ridge" | "digitized" (PLAN §4.6.1/.2)
    "description": "<human-readable summary of how the lines were derived>",  // methods panel
    "generated": "<ISO date>",
    "params": { }                             // free-form, method-specific (corridor width, smoothing, …)
  },
  "paths": [
    {
      "id": "inner",                          // unique within the file
      "name": "Inner rampart",
      "closed": true,                         // true = last point implicitly connects to the first
      "lengthM": 300.0,                       // informational, meters along the polyline
      "points": [ [x, z], … ]                 // LOCAL scene coords (§0), ordered along the crest
    },
    { "id": "outer", "name": "Outer rampart", "closed": false, "lengthM": 140.0, "points": [ … ] }
  ]
}
```

Rules:

- `points` are `[x, z]` pairs in local scene coordinates, same convention as
  `sites.json` `geometryLocal` — **no heights in the file**. The app samples ground
  height from the height grids at runtime (one analysis grid, one source of truth;
  the polyline must not carry a copy that can drift).
- Point spacing ≤ ~1 m after densification (the pipeline densifies to ~0.5 m); ≥ 3
  points per path; no NaNs; all points within the core grid's `boundsLocal`
  (pipeline-tested).
- `closed: true` means the polyline is a ring; the closing segment is implicit (last
  point ≠ first point in the file).
- Palisade appearance parameters (post spacing, height, jitter seed) are **app-side UI
  state with defaults**, not data — PLAN §4.6.3. The asset carries only the line.

---

# v1.2 amendment (2026-08-21) — Phase 7 land-cover assets

Additive per the versioning policy above; `schemaVersion` stays 1. Two new optional
`assets` entries that travel as a **pair** (both present or both absent, like
shoreline/waterConnect):

```jsonc
"assets": {
  "landcover": "landcover.tif",              // §9 — class-index raster
  "landcoverLegend": "landcover_legend.json" // §10 — classes, palette, rules
}
```

When the pair is present the manifest MUST also carry:

- the layer entry `{ "id": "landcover", "name": "Modeled landscape (rule-based)",
  "provenance": "model" }` — inserted after `water` and before `palisade` in the
  contractual layer order (terrain, sites, water, landcover, palisade);
- the SGU attribution, **widened** from the Phase-4 wording to
  `{ "text": "Jordarts- och strandförskjutningsdata från Sveriges geologiska undersökning (CC0)", "license": "CC0", "url": "https://www.sgu.se" }`
  (one SGU entry total — the pipeline replaces the narrower shoreline-only text when
  soils ship, as anticipated by PLAN §6.3).

**Format note (supersedes the `landcover.png` placeholder in §2's comment):** PLAN §4.7
sketched an indexed-palette PNG at 5–10 m. This amendment ships the classification as a
**uint8 GeoTIFF on the exact `grids.context` geometry (2 m)** instead: it reuses the
frozen §1 raster machinery end-to-end (pipeline COG writer, app `loadBand` decode, §1
array convention), stays GIS-inspectable with georeferencing, needs no PNG codec
dependency in either codebase, and is finer than the planned resolution. The palette
lives in the legend JSON, which is where the PNG's PLTE chunk would have pointed anyway.

## 9. `landcover.tif` — land-cover class raster (PLAN §4.7)

The rule-engine output: one land-cover class per cell, for **one fixed reference
century** (the fort's active era; Broborg: 500 CE). It is a *model*, never rendered as
measured data.

**File encoding:** single band **uint8**, value = class **index** into the legend's
`classes[]` array (`raw == classes[i].index`). No nodata — every cell is classified.
DEFLATE, tiled COG, EPSG:3006 horizontal only. **Geometry identical to
`grids.context`** (same width, height, resolution, bounds; row 0 = north) — the app
validates dimensions against `grids.context` and reuses the §1 array convention;
`grids.context` stays authoritative for geometry, exactly like `water_connect.tif` (§7).

Rules:

- Every raw value in the raster MUST be a valid index into `classes[]`
  (`raw < classes.length`; pipeline-tested).
- Class indices are contiguous `0 … N−1`, `N ≤ 32`.
- The raster is derived for `landcover_legend.json.referenceYearCE` only. The app MUST
  NOT re-derive classes for other centuries — **except** for legend classes marked
  `dynamic` (§10, v1.3): those are exact functions of `(water_connect, current slider
  level)` — the same data and §7 semantics the water rendering already uses — and the
  app MUST derive them at the current level rather than read them from the raster.
  Everything else interacts with the Phase-4 slider by render-side masking only (below).

**Rendering contract (app side):**

- The layer is off by default; the toggle is labeled **"modeled landscape
  (rule-based)"** and carries the `model` badge; first toggle-on surfaces the legend's
  `caveat` line (PLAN §6.1 UI rules).
- Ground tint: a flat per-class color wash (legend palette) blended into the
  terrain material — injected with the established overlay-shader chain, ordered
  **after viewshed, before water** (submerged ground must still read as submerged).
  Class lookup uses `NearestFilter` (indices must never interpolate).
- Dynamic-class tint (v1.3, iff the legend declares `dynamic` classes and the site
  ships `water_connect.tif`): inside the same wash, the app paints the
  `dynamic: {"kind": "water"}` class's color wherever `connect ≤ levelM` at the
  **current slider level**, and the `{"kind": "shore-band"}` class's color wherever
  `levelM < connect ≤ levelM + bandM` — over whatever static class the raster holds
  there. Still ordered before the §7 water tint, so submerged ground shades last
  exactly as before. Sites or legends without `dynamic` classes render as pre-v1.3.
- Vegetation: instanced procedural geometry, blue-noise/seeded-random sampled per
  class from the raster; deterministic for a given seed. Instances whose ground is
  wet at the **current slider level** (`connect ≤ levelM`, §7 semantics) are
  suppressed at runtime, so scrubbing the slider never shows trees standing in the
  sea. Appearance parameters (density scale, seed) are app-side UI state with
  defaults, not data.
  *Amended 2026-08-22 (rendering only — no schema change, no new bytes):* the app
  renders each §10 `vegetation.type` as a seeded, render-side **species mix** of
  procedurally generated tree archetypes — `conifer` → spruce + pine, `broadleaf` →
  oak + birch, `reeds` unchanged — with a mesh/impostor level-of-detail split. The
  original forms (cones for `conifer`/`broadleaf`, cross-quad billboards for
  `reeds`) are what pre-amendment builds drew; the §10 type enum, densities,
  determinism-for-a-seed, suppression semantics and the metric-size invariant below
  are all unchanged. Which species stand in a mix is an app-side rendering decision
  (evidence basis: `docs/vegetation-zones.md` §2/§4), never data.
- Dynamic-band vegetation (v1.3): a `shore-band` class's vegetation is sampled from
  the **connect grid**, not the raster — instances stand where
  `levelM < connect ≤ levelM + bandM` at the current level, excluding cells whose
  raster class is the `water` class or itself carries `reeds` vegetation (no double
  planting on fens). Layout is deterministic for a given `(seed, level)`: an instance
  that exists at two nearby levels has the identical transform at both. Tree-form
  (`conifer`/`broadleaf`) instances are suppressed at `connect ≤ levelM + bandM`
  (nothing woody stands inside the reed belt); reed-form instances at
  `connect ≤ levelM` as before.
- Vegetation keeps true metric size: positioned at `y = ground · exaggeration`, sized
  in the scale component (the palisade invariant).

## 10. `landcover_legend.json` — classes, palette, rules

```jsonc
{
  "schemaVersion": 1,
  "site": "broborg",
  "referenceYearCE": 500,                     // the century the raster models
  "referenceLevelM": 8.6,                     // water level used, m RH 2000 (from §6 table)
  "method": "<one-paragraph derivation description>",   // methods panel, verbatim
  "caveat": "<one-line model caveat>",        // first-toggle caveat + control note
  "calibration": "<forest/open ratio vs. pollen literature (PLAN §2.5), verbatim>",
  "source": {
    "product": "SGU Jordarter 1:25 000–1:100 000",
    "api": "https://api.sgu.se/oppnadata/jordarter25k-100k/ogc/features/v1",
    "fetched": "<ISO date>"
  },
  "classes": [
    {
      "index": 0,                             // == raw raster value
      "id": "water",                          // stable machine id, unique
      "name": "Open water",                   // legend row text
      "color": "#2d5a6b",                     // ground-tint + legend swatch, sRGB hex
      "rule": "<the rule that produced this class, verbatim>",  // methods panel
      "vegetation": null,                     // or { "type": "...", "densityPerHa": n }
      "dynamic": { "kind": "water" },         // v1.3, optional — see rules below
      "areaFraction": 0.081                   // informational, of the full raster
    },
    // … one entry per class, ascending contiguous index; a v1.3 runtime-derived
    // shore band looks like:
    {
      "index": 8,
      "id": "shore_reeds",
      "name": "Shore reed belt (follows the shoreline)",
      "color": "#77875a",
      "rule": "<verbatim, incl. that the app derives it at the current level>",
      "vegetation": { "type": "reeds", "densityPerHa": 500 },
      "dynamic": { "kind": "shore-band", "bandM": 0.6 },
      "areaFraction": 0.0                     // no raster cells — runtime-only class
    }
  ]
}
```

Rules:

- `classes` sorted by `index`, contiguous from 0, ids unique, colors `#rrggbb`.
- `vegetation.type` ∈ `"conifer" | "broadleaf" | "reeds"`; `densityPerHa` > 0 is the
  model's suggested instance density (the app may scale it globally for performance,
  never per class). `vegetation: null` = no instances (open/water/bare classes).
- `rule`, `method`, `calibration` and `caveat` are disclosed **verbatim** in the
  methods panel — the app never paraphrases a method it did not run. The rule engine's
  full rule list therefore lives in this file, not in app code.
- `areaFraction` entries sum to 1 ± 0.001 (pipeline-tested); they feed the calibration
  paragraph and the legend's percentage readouts. The value is measured **on the
  raster**: a purely-runtime `dynamic` class carries `0.0`, and the legend UI shows
  "follows the slider" for it instead of a percentage.
- `dynamic` (v1.3, optional): marks a class the app derives at the **current slider
  level** from the §7 connect grid instead of reading it from the raster (§9). When
  present it is an object with `kind ∈ "water" | "shore-band"`; `"shore-band"`
  requires a finite `bandM > 0` (meters above the water line) and `"water"` must not
  carry `bandM`. At most one class of each kind per legend. A class without `dynamic`
  is fully static — pre-v1.3 legends therefore render unchanged.
- The reference century is stated wherever the layer is described (legend, methods,
  control note): the *raster* answers "what might the landscape have looked like around
  <referenceYearCE>?"; v1.3 `dynamic` classes are the disclosed exception and answer
  at the century shown.

---

# v1.3 amendment (2026-08-21) — dynamic hydrology (§9/§10)

Additive per the versioning policy above; `schemaVersion` stays 1, no new assets.
The change is a **narrow carve-out** from §9's "the app MUST NOT re-derive classes"
rule, plus the optional per-class `dynamic` marker in §10 that scopes it.

**Why.** The class raster is derived for one reference century, but two of its
classes were pure functions of the water level: "sea at the reference level" and the
shore reed band just above it. Freezing those into the raster made the Phase-4
slider dishonest in exactly the two ways users can see: scrubbing to a later century
left the reference sea's dark ground tint on land the slider had drained, and the
reed belt stayed stranded at the reference shoreline (it is only valid within
±`bandM` ≈ ±100 years of the reference at this uplift rate) instead of following
the water's edge.

**What changed.** Classes may now carry `dynamic: {"kind": "water"}` or
`{"kind": "shore-band", "bandM": <m>}` (§10 rules). Such classes hold no cells in
the raster beyond their static residue (the water class keeps SGU-mapped modern
water); the app derives their extent at the **current slider level** from
`water_connect.tif` — the same grid, the same `connect ≤ h` semantics, and the same
monotonicity guarantee the §7 water rendering has always used. This is still not
"re-running the rule engine in the browser": the sea and the band are *exact*
functions of shipped, pipeline-computed data, the band width is pipeline-chosen data
(`bandM`), and the rule text disclosing the derivation still ships in the legend and
is rendered verbatim. Every soil-, slope- and evidence-derived class stays frozen at
the reference century.

**Compatibility.** A legend without `dynamic` classes (e.g. one produced before this
amendment) renders exactly as before; a site without water assets renders `dynamic`
classes as static (their raster residue), which for the shore band means "absent" —
feature off, never an error.

---

# v1.4 amendment (2026-08-21) — far-field rings & the horizon guarantee (§11)

Additive per the versioning policy above; `schemaVersion` stays 1. One new optional
manifest key (`grids.rings`), one optional per-ring asset reference (`waterConnect`),
and one optional informational block (`horizon`). A manifest without them (the
testsite, every pre-v1.4 bundle) keeps working in every later app build; an app that
predates this amendment ignores the keys entirely. Strategy and owner decisions:
`docs/national-scaleout.md` §2b.

## 11. `grids.rings` — far-field elevation rings (`dem_ring<N>.tif`)

Concentric lower-resolution DEM grids that extend a site's terrain beyond the 4×4 km
context until the skyline closes at the true refracted horizon
(`d ≈ 3.83·√h` km) from the first-person viewpoint on the fort. Each ring reuses the
§1 grid machinery unchanged except where stated.

**The ring ladder.** Every ring is a full square grid (not an annulus on disk),
concentric on `origin`, axis-aligned in EPSG:3006, 2000×2000 px:

| Ring | Coverage | Resolution | Quantization (`encoding.scale`) | File |
|---|---|---|---|---|
| ring3 | 8×8 km | 4 m/px | 0.5 m | `dem_ring3.tif` |
| ring4 | 16×16 km | 8 m/px | 0.5 m | `dem_ring4.tif` |
| ring5 | 32×32 km | 16 m/px | 0.5 m | `dem_ring5.tif` |
| ring6 | 64×64 km | 32 m/px | 1.0 m | `dem_ring6.tif` |
| ring7 (rare) | 128×128 km | 64 m/px | 1.0 m | `dem_ring7.tif` |

**Ladder depth is adaptive per site** (pipeline-computed, pytest-covered):
`h = (crown + 2 m) − floor`, where `crown` = max DEM inside the site's KMR extent
polygon (fallback: max of the core grid) and `floor` = `max(0, p5)` — the 5th
percentile elevation of the 16×16 km (ring4) box, which a sea or large lake drives to
~0 by itself. Horizon distance `d = 3.83·√h` km (refraction k = 0.13 folded into the
coefficient). A site always ships ring3 and ring4; the ladder extends while the last
ring's half-extent < d, capped at ring7. Rings ship in `grids.rings` **ordered
inside-out**; the count varies per site and the app derives everything from the
manifest, never from the ladder table above.

**Manifest entry.** `grids` gains an optional `rings` array; each element is exactly
the §2 grid shape (path, resolution, width/height, bounds3006, boundsLocal, encoding,
min/maxElevation) with two ring-specific rules:

```jsonc
"grids": {
  "core":    { … },                         // unchanged
  "context": { … },                         // unchanged
  "rings": [                                // v1.4, optional, ordered inside-out
    { "path": "dem_ring3.tif", "resolution": 4.0, "width": 2000, "height": 2000,
      "bounds3006": { … }, "boundsLocal": { "minX": -4000.0, … },
      "encoding": { "dtype": "int16", "scale": 0.5, "unit": "m" },
      "minElevation": …, "maxElevation": … },
    { "path": "dem_ring4.tif", "resolution": 8.0, …,
      "encoding": { "dtype": "int16", "scale": 0.5, "unit": "m" },
      "waterConnect": "water_connect_ring4.tif" },   // optional, see below
    …
  ]
},
"horizon": {                                // v1.4, optional, informational
  "crownM": 57.3,                           // max DEM inside the extent polygon
  "floorM": 5.1,                            // p5 of the 16×16 km box, floored at 0
  "eyeM": 2.0,                              // the +2 m in h = (crown + 2) − floor
  "distanceKm": 27.9                        // 3.83 · sqrt(h)
}
```

Rules and invariants (pipeline-guaranteed and tested):

- Encoding identical to §1 (int16, no nodata, DEFLATE predictor 2, tiled COG,
  EPSG:3006 horizontal only, north-up) **except** `encoding.scale`, which is per-grid:
  0.5 m for rings 3–5, 1.0 m for rings 6–7 (`height_m = raw * scale`). The
  manifest's `encoding.scale` is authoritative per grid; nothing may assume 0.1
  globally. Valid scales are `{0.1, 0.5, 1.0}`.
- All rings 2000×2000, concentric on `origin`, and a **strict containment chain**:
  context ⊂ rings[0] ⊂ rings[1] ⊂ …; each ring's resolution strictly greater than the
  previous grid's.
- The §2 geometry invariants (`width == (maxE−minE)/resolution`, boundsLocal vs
  bounds3006 vs origin) hold per ring. Ring elevations inherit the site's sanity band
  (Broborg: [−10, 200] m); widening the band nationally is Phase 9.
- **Coverage seam (GLO-30 deferred to Phase 9):** ring cells outside the DEM source's
  tile coverage (open Baltic beyond the Lantmäteriet tile set, non-Swedish land) are
  filled with 0.0 m and counted in `provenance.processing` (e.g.
  `"ring6: 12345 cells outside tile coverage sea-filled at 0 m"`). Outer rings are
  produced by average-resampled reads served from the source COGs' overview levels;
  that too is disclosed in `provenance.processing`.
- `horizon` is informational (methods panel); the app must not recompute the ladder.

**`waterConnect` on a ring (optional, at most one ring entry).** A §7-semantics
priority-flood connectivity grid on **that ring's exact geometry** (same width,
height, resolution, bounds; int16 at that ring's `encoding.scale`; edge-entry,
4-connected). In practice it ships on ring4 (16×16 km) as
`water_connect_ring4.tif`. It exists **only for far-water rendering**; all analysis
(viewshed, dynamic land-cover classes, water logic) stays on the context
`assets.waterConnect` grid. Present only when the site also ships the §6/§7 water
pair.

**Rendering contract (app side):**

- **Lazy, inside-out.** The app loads core+context and starts exactly as today, then
  loads rings one at a time in manifest order, extending the terrain as each arrives.
  A missing, failed or skipped ring (e.g. a low-end device stopping early) means the
  fog line stays nearer — never an error. The horizon guarantee is a *data*
  guarantee.
- **Annulus meshes.** Each ring renders only the band not covered by the next-finer
  grid (context for rings[0]), at reduced vertex density on far rings; normals are
  sampled from the ring's full-resolution grid. Ring meshes take the elevation tint
  but none of the overlay layers (viewshed, land-cover wash, submerged-ground tint) —
  those remain core/context features.
- **Earth curvature, baked.** Ring mesh vertices are lowered by
  `Δy = (1 − k) · d² / (2·R)` with k = 0.13 and R = 6 371 000 m (the §4 viewshed
  constants), d = horizontal distance from the scene origin (the guarantee
  viewpoint). Applied to ring render meshes only; core/context meshes and every
  analysis grid stay flat-earth (the viewshed applies the same drop internally, §4).
- **Log depth buffer.** With geometry to ±64 km, the renderer uses a logarithmic
  depth buffer; custom shaders must include the standard logdepth chunks.
- **Paleo-water to the 16 km ring, then faded.** When a ring `waterConnect` is
  present, the water plane extends to that ring's bounds, masked by
  `connect ≤ h` on the ring grid outside the context rect, with opacity fading
  radially from the context edge to the ring edge — the SGU level is a single
  per-century value that is only locally valid across an uplift gradient (disclosed
  in the methods panel). Rings beyond it render terrain only.

## 12. `water_connect_delta.tif` — connectivity as a delta (v1.5, 2026-08-22 — additive)

The §7 sea-connectivity surface, shipped as its **difference from the DEM grid it
sits on** rather than as absolute heights:

```
connect_raw = dem_raw + delta_raw          (exact, same quantization lattice)
connect_m   = connect_raw * grid.encoding.scale
```

**Why.** By construction `connect ≥ dem`, and the two are *equal* everywhere
outside a depression. At Broborg only **6.2 %** of cells differ, by at most
**+4.8 m** **[measured 2026-08-22]** — so the delta is a mostly-zero grid, and
deflate does the rest: `water_connect.tif` **2.03 MB → 0.22 MB** (9.2×), and the
§11 far-water grid on ring 4 **1.79 MB → 0.14 MB**. On the second-largest file in
a bundle, for one addition per cell at load.

**Encoding.** Single band **int16**, no nodata, the §1a layout, EPSG:3006
horizontal only, north-up — that is, byte-for-byte the encoding of the DEM grid it
deltas against, whose `encoding.scale` it shares (0.1 m against `grids.context`;
0.5/1.0 m against a §11 ring). Values are in *steps of that scale*, not meters.
The delta carries **no manifest grid entry of its own**: the DEM grid it belongs to
is authoritative for geometry, exactly as for §7 and §9.

**Invariants** (pipeline-guaranteed, pytest- and vitest-covered):

- `delta_raw ≥ 0` for every cell. A negative sample means the §7 invariant broke
  upstream; readers must reject the file rather than render it.
- Sample count equals the DEM grid's exactly.
- Reconstruction is **exact**, not approximate: both operands are integers on the
  same lattice, so `dem + delta` reproduces the absolute grid bit for bit.

**Where it is declared.**

- Context grid: `assets.waterConnectDelta` (alongside `assets.shoreline`).
- §11 ring: `waterConnectDelta` on that ring's entry in `grids.rings`.

**Precedence and back-compatibility.** A bundle may declare the absolute grid, the
delta, or both. **When both are present the reader prefers the delta.** The v1.1
pairing rule of §6/§7 is satisfied by *either* connectivity form — `shoreline`
plus one of `waterConnect` / `waterConnectDelta` — and the §11 "at most one ring
carries far water" rule counts a ring once whichever key it uses. A pre-v1.5
bundle declaring only `waterConnect` loads unchanged, forever; the pipeline writes
the delta by default and can be asked for the absolute form
(`fornborg_pipeline.water --absolute-connect`).

**Reader note.** Reconstruction needs the DEM grid in hand, so the app loads the
context grid (which it does first anyway) before the connectivity grid, and a
ring's DEM before that ring's far-water grid. That ordering is the only behavioural
change this amendment asks of a reader.

---

# v1.6 amendment (2026-08-22) — far-field land cover (§13)

Additive per the versioning policy above; `schemaVersion` stays 1. One new optional
per-ring asset reference (`landcover` on a `grids.rings` entry), one new optional
block in `landcover_legend.json` (`farField`), and one relaxation of a §11 rendering
rule scoped to exactly this feature. A bundle without them (every pre-v1.6 bundle)
keeps working in every later app build; an app that predates this amendment ignores
the keys entirely. Design and owner decisions: `docs/far-field-vegetation.md`;
regional grounding: `docs/vegetation-zones.md`.

**Why.** The modelled landscape (§9/§10) stops at the 4×4 km context edge while
terrain runs to 64 km (§11): with the layer on, the world is Iron Age for 2 km and
bare modern hillshade beyond — a hard seam in the first-person view the horizon
guarantee is defined for. The far field cannot reuse the §9 engine (its evidence
and soil inputs are unavailable and invisible at ring scale), so it gets a cruder,
separately disclosed classifier whose output ships per ring.

## 13. `landcover_ring<N>.tif` — far-field land-cover class rasters

**File encoding.** Exactly §9's, on the ring's geometry: single band **uint8**,
value = class **index** into `landcoverLegend.farField.classes[]`, no nodata,
§1a container (plain deflate + predictor 2, no COG layout), EPSG:3006 horizontal
only, north-up, geometry identical to that ring's DEM entry (same width, height,
resolution, bounds — pipeline-validated the same way §9 validates against
`grids.context`).

**Manifest declaration.** A `grids.rings` entry gains an optional `landcover` key:

```jsonc
"rings": [
  { "path": "dem_ring3.tif", …, "landcover": "landcover_ring3.tif" },
  { "path": "dem_ring4.tif", …, "waterConnect": …, "landcover": "landcover_ring4.tif" },
  …
]
```

Rules: the key is optional per ring (a ring without it simply renders untinted, as
today); it may only be present when the site also ships the §9/§10 pair (the far
field extends the modelled-landscape layer and shares its toggle, badge and
first-toggle caveat — it cannot exist without the near field); the pipeline ships
it for every ring of a site it builds it for, but the app must treat each ring
independently (graceful per-ring absence, like the ring DEMs themselves).

**`landcoverLegend.farField` block** (optional; absent = no far field):

```jsonc
"farField": {
  "method": "<one-paragraph derivation description, shown verbatim>",
  "classes": [
    { "index": 0, "id": "sea", "name": "Open sea (modern)", "color": "#2d4a5b",
      "rule": "<verbatim threshold rule>" },
    { "index": 3, "id": "forest_broadleaf", "name": "…", "color": "#4f7a3a",
      "rule": "…", "billboard": { "type": "broadleaf", "densityPerHa": 10 } },
    …
  ]
}
```

Rules, mirroring §10 where they overlap: indices contiguous `0 … N−1`, `N ≤ 32`;
ids unique; colors `#rrggbb`; `rule` and `method` are non-empty strings rendered
verbatim in the methods panel; `billboard` is optional per class — when present,
`type` is one of the §10 vegetation types (the billboard renders that type's
silhouette — since the 2026-08-22 §9 rendering amendment, that silhouette may be
a baked archetype texture rather than a flat-color quad; densities, budget and
orientation rules below are unchanged) and `densityPerHa > 0`. `farField` classes carry no `areaFraction`
(the rasters vary per ring) and no `dynamic` marker — the far field is fully
static; far *water* rendering remains §11's job. The `method` text MUST disclose
that the far classifier is cruder than the §9 engine (terrain-derived, no soil or
evidence inputs) and MUST state the billboard sampling fraction in plain terms
(e.g. "roughly one tree in ten as a stand-in for the stand").

**Rendering contract (app side):**

- **Same layer, same honesty machinery.** Far-field tint and billboards are part
  of the "modeled landscape (rule-based)" layer: same toggle, `model` badge, and
  first-toggle caveat; the `farField.method` and per-class rules join the methods
  panel. Nothing renders when the layer is off.
- **Ring tint.** §11's rule that ring meshes take none of the overlay layers
  gains exactly one exception: a ring whose entry declares `landcover` takes the
  far-field class tint (NearestFilter — indices never interpolate) when the
  layer is on. Viewshed and submerged-ground shading remain core/context-only.
- **Billboards.** One quad per sampled instance, sampled from ring class rasters
  (classes carrying `billboard`) with the site seed — deterministic, zero new
  bytes — only outside the context extent and only within 8 km of the origin
  (rings 3–4; farther out a tree is sub-pixel, `docs/far-field-vegetation.md`
  §1). Orientation: **camera-facing about the vertical axis** (cylindrical
  billboarding in the vertex shader; owner-delegated decision 2026-08-22 —
  side-on quads vanish edge-on in orbit mode). A hard cap
  (`FAR_MAX_INSTANCES`, app-side) scales the whole far population
  proportionally and logs the fact, exactly like §9's near-field cap; the near
  budget is never reduced by the far field.
- **Nothing stands in far water.** Where the site ships a §11 ring
  `waterConnect`, billboard instances are suppressed at
  `connect ≤ current level` (§7 semantics) at the current slider level. Where
  it ships none there is no modelled far water and no suppression — terrain
  elevation is never a stand-in (§2b.5's uplift-gradient honesty rule).
- **Seam.** Across a ~200 m band at the context edge, near-field 3D instances
  fade out and billboards fade in, so the transition is a cross-fade rather
  than a line.

**Compatibility.** Pre-v1.6 bundles (no `farField`, no ring `landcover`) render
exactly as before; a v1.6 bundle in a pre-v1.6 app renders its near field
exactly as before (unknown keys ignored, §2 rules). A ring raster whose fetch
fails tints nothing and suppresses nothing — per-ring graceful, like ring DEMs.

---

# v1.7 amendment (2026-08-26) — reconstruction mode (§14)

Additive per the versioning policy above; `schemaVersion` stays 1. **One** new
optional asset (`assets.reconstruction` → `reconstruction.json`) and one new layer
entry (`reconstruction`, provenance `conjecture`). Nothing existing changes:
`sites.json` (§3) stays exactly as defined — it is the register, and the register
does not acquire interpretation. A bundle without the new asset keeps working in
every later app build; an app that predates this amendment ignores the key
entirely. Research, taxonomy and the per-archetype specifications:
`docs/reconstruction-mode.md`; PLAN §Phase 12.

**Why.** Marker mode (§3) answers *"what is registered here, and where?"*
Reconstruction mode answers *"what would I have seen standing here in 500 CE?"* —
so it needs the parameters the register only states in prose: plan form and size,
height, kerb, stone calibre, robbing pits, and for a `Gravfält` the monument count
and class composition it enumerates about itself. Those are parsed offline
(`pipeline/fornborg_pipeline/reconstruct.py`) for the same reason every other
derivation is: the browser does no geodesy, no parsing and no guessing.

## 14. `reconstruction.json` — per-monument reconstruction parameters

```jsonc
{
  "schemaVersion": 1,
  "site": "broborg",
  "generated": "<ISO date>",
  "derivation": {
    "method": "kmr-description-parse",
    "description": "<verbatim prose, as rampart.json §8 does>",   // methods panel
    "transforms": ["rampart-apron-conservation", "mound-reprofile", "pit-fill"],
    "params": {                              // the §5 constants, all tunable
      "packing": 0.85, "apronDepthM": 0.45, "wallThicknessM": 5.0,
      "reposeEarthDeg": 30, "reposeStoneDeg": 35,
      "pitFillFactor": 0.5, "fortConfidenceThreshold": 0.6
    }
  },
  "defaults": {                              // per-archetype literature defaults
    "mound": { "diameterM": 7.0, "heightM": 0.7, "stoneM": [0.2, 0.3],
               "material": "earth", "reprofile": true, "form": "round" }
  },
  "coverage": {                              // what the parse actually found
    "records": 127, "reconstructed": 127, "unmappedTypes": 0,
    "byArchetype": { "stone-setting": 58, "grave-field": 31, "…": 0 },
    "planParsed": 0.913, "heightParsed": 0.898, "stoneParsed": 0.874,
    "formParsed": 0.913, "kerbParsed": 0.551, "pitsParsed": 0.307,
    "turfNoted": 0.756, "damageNoted": 0.11,
    "graveFields": 31, "graveFieldsWithStatedCount": 28,
    "sampledMonuments": 1211, "withWarnings": 1
  },
  "monuments": [
    {
      "id": "L1940:6792",                    // joins to sites.json §3 by id
      "lamningstyp": "Stensättning",         // KMR type, verbatim, for the popup
      "archetype": "stone-setting",          // reconstruction-mode.md §4 key
      "period": { "builtCE": -500, "abandonedCE": 1050 },   // §8 visibility gate

      "plan":    { "form": "round",          // round|square|rectangular|oval|triangular
                   "diameterM": 8.0,         // equal-area circle for non-round plans
                   "lengthM": null, "widthM": null,
                   "orientationDeg": null,   // long axis, 0–180, 0 = N–S
                   "source": "measured" },   // measured|derived|assumed, per field

      "profile": { "heightM": 1.2,           // RECONSTRUCTED height above ground
                   "diameterM": 8.0,         // reconstructed base diameter
                   "presentHeightM": 1.2,    // the ruin measurement it came from
                   "presentDiameterM": 8.0,
                   "heightGain": 1.0,
                   "transform": "none",      // which §5 rule ran; see below
                   "source": "measured" },

      "surface": { "stoneM": [0.7, 1.4],     // constituent calibre range
                   "turfed": true,           // what the register saw (a RUIN state)
                   "filled": true,           // `fylld`; null = not stated
                   "centreStone": false,
                   "source": "derived" },

      "features": {
        "kerb": { "heightM": 1.2, "stoneM": [0.7, 1.4] },   // null = none recorded
        "pits": [ { "lengthM": 2.0, "widthM": 1.5, "depthM": 0.5 } ]
      },

      "damaged": false,                      // plundrad/utgrävning/skadad/bortodlad
      "warnings": [],                        // human-readable, shown in the popup
      "tiers": { "plan": "measured", "profile": "measured", "surface": "assumed" },
      "fallbacks": [],                       // field paths that used a default
      "parseConfidence": 0.95                // 0–1, weighted field coverage
    }
  ]
}
```

Two archetypes carry one extra block each.

**`archetype: "grave-field"`** is not a shape but a **sampler specification**
(reconstruction-mode.md §3.1): the record enumerates its own contents.

```jsonc
"field": {
  "count": 65,                  // monuments to place inside the §3 extent polygon
  "countSource": "measured",
  "countStated": true,          // false = summed from the itemisation instead
  "classes": [
    { "archetype": "stone-setting", "form": "round", "count": 57,
      "diameterM": [3.0, 8.0],  // RANGES, not midpoints — each monument is drawn
      "heightM": [0.2, 0.6],    // from the stated band
      "stoneM": [0.3, 0.6],
      "moundLike": false,       // `högliknande`: profile hint, not a plan form
      "figure": "treudd",       // optional: treudd|stone-circle|ship-setting
      "source": "measured",
      "note": "…" }             // optional, e.g. an unitemised remainder
  ]
}
```

**`archetype: "fort"`** carries the §3.2 construction description and the §6.A.1
filter.

```jsonc
"fort": {
  "confidence": 1.0,            // 0–1; below derivation.params.fortConfidenceThreshold
                                // the app must NOT draw a standing rampart
  "criteria": { "kallmurning": true, "wallHeightM": 2.0, "wallAtLeast1m": true,
                "wallRoundOrAcross": true, "extentSpanM": 95.0,
                "compactEnclosure": true },
  "ramparts": [
    { "id": "inner",            // joins to rampart.json §8 `paths[].id`
      "lengthM": 300.0,
      "spreadM": [8.0, 15.0],   // KMR's collapse spread, NOT the wall body
      "presentHeightM": [1.0, 2.0],
      "stoneM": [0.3, 1.0],
      "standingHeightM": 2.0,   // §5.1 input: the top of the recorded band
      "apronIncrementM": 0.5,   // §5.1 output: what the debris apron represents
      "heightM": 2.5,           // = standing + apron; the wall the app builds
      "wallThicknessM": 5.0, "wallThicknessSource": "assumed",
      "drystone": true, "earthBacked": true, "vitrified": true,
      "entrances": [ { "bearing": "VNV", "bearingDeg": 292.5, "widthM": [3.0, 5.0] } ],
      "transform": "rampart-apron-conservation",
      "source": "measured" }
  ]
}
```

Rules — the ones that keep the mode honest and the ones that keep it on the ground:

- **No coordinates, at all.** Not local `[x, z]`, not EPSG:3006. A monument's
  position and its extent polygon live in `sites.json` (§3) and the app joins the
  two by `id`. `assets.reconstruction` therefore **requires** `assets.sites`, and
  `validate_manifest` refuses the pair broken (§2). This is the §0 rule stated once
  more where it is easiest to break: a second file with a second copy of a position
  is a second thing that can drift.
- **No ground heights.** `heightM` everywhere means *height above the ground at
  that point*, which is the whole content of the file. Ground elevation is sampled
  at runtime through the app's own sampler, exactly as §8 requires of the rampart
  crest, so a monument can never drift from the terrain under it.
- **Vertical exaggeration is a render-only Y scale on the terrain group** (§0).
  Reconstructed monuments live in the scene **outside** that group and seat
  themselves at `y = ground · exaggeration` while keeping true metric height — a
  2.5 m wall is 2.5 m at ×1 and at ×2.5 — and refresh when it changes. Same
  invariant `overlays/palisade.ts` documents.
- **Every number is a ruin measurement until a transform says otherwise**
  (reconstruction-mode.md §5). `profile.transform` names which rule ran and
  `presentHeightM` / `presentDiameterM` keep the measurement it ran on, so the
  derivation is reversible and the methods panel can show the arithmetic rather
  than the conclusion. Values:

  | `transform` | Meaning |
  |---|---|
  | `none` | Not inflated. A stone setting's flatness is the type (§6.C); a fire-cracked mound accumulated rather than being built (§6.E). |
  | `pit-omit` | As `none`, and the recorded robbing pits are simply not modelled. |
  | `kerb-fixed` | A `kantkedja` fixes the original footprint: diameter kept, surface restored to a smooth spherical cap through the kerb (§5.2). |
  | `kerb-fixed+pit-fill` | The same, plus the §5.3 pit volume returned. |
  | `repose-reprofile` | No kerb: volume-conserving rebuild at the material's angle of repose (§5.2). Narrower and taller. |
  | `repose-reprofile+pit-fill` | The same, plus the pit volume. |
  | `rampart-apron-conservation` | §5.1, standing wall plus its debris apron. |

- **Provenance is per part, never averaged** (§9.1, PLAN §6.1). `tiers` carries
  `plan`, `profile` and `surface` separately — a mound is Measured in plan, Model
  in profile, Conjecture in surface — plus `placement` for a grave field, whose
  composition is measured and whose individual positions are not. The badge
  mapping is Measured→**Measured**, `derived`→**Model**, `assumed`→**Conjecture**.
  The `reconstruction` **layer** entry is the floor of that range, so it is
  `conjecture`; the per-part tiers reach the visitor through the popup.
- **Nothing is invented silently.** A field the parser could not read takes the
  archetype default from `defaults`, its `source` reads `assumed`, its path is
  listed in `fallbacks` (`"plan.diameterM"`, `"profile.heightM"`,
  `"surface.stoneM"`, `"plan.form"`), and `parseConfidence` drops. Roughly 8 % of
  records have no parseable plan size at all; the app must be able to show *how
  much* of a site is measured versus defaulted, which is what these three fields
  are for.
- **`fortConfidence` gates archetype A** (§6.A.1). Roughly four in five registered
  `Fornborg` records are probably not Migration Period forts, so a site scoring
  below `derivation.params.fortConfidenceThreshold` must render as a low stone
  bank, not as a standing rampart, and must say why. This is the one error that
  would be wrong a thousand times over rather than once.
- **The archetypes are not contemporaneous** (§8). `period.builtCE` /
  `abandonedCE` are signed astronomical years (`null` = not gated) and drive
  visibility against the app clock: at 500 CE the fort stands and there are **no**
  runestones; at 1050 CE the reverse.
- `id` unique within the file; `archetype` one of the §4 keys; `parseConfidence`
  in `[0, 1]`; `tiers.*` one of `measured` / `derived` / `assumed`. All
  pipeline-validated (`reconstruct.validate_document`), so the app's own validator
  is a second line rather than the only one.
- **Ranges are `[min, max]`** with `min ≤ max`, and a single stated value becomes
  `[v, v]`. Grave-field class ranges are ranges on purpose: the sampler draws each
  monument from the band the register states, which is what makes a field of 230
  monuments measured rather than invented.

**Compatibility.** A pre-v1.7 bundle (no `assets.reconstruction`) simply has no
reconstruction mode — the toggle is absent, exactly as the palisade is absent for
a site with no `assets.rampart`. A v1.7 bundle in a pre-v1.7 app ignores the key
(§2 rules) and renders marker mode as before. A monument whose archetype the app
cannot draw yet keeps its §3 marker instead of disappearing.

---

# v1.8 amendment (2026-09-12) — fort interiors (§15, additions to §14)

Additive per the versioning policy above; `schemaVersion` stays **1**. **No new asset and
no new layer entry**: two optional blocks are added *inside* `reconstruction.json` (§14) —
a per-site `interior` block and a per-monument `farm` block for `archetype: "farmstead"` —
plus two `defaults` and two `coverage` keys. A bundle written before this amendment has
neither, which means exactly what a missing `assets.*` entry means everywhere else in this
file: **feature off**. An app that predates the amendment ignores both blocks and renders
the reconstruction it already knows how to render.

Decision and evidence: `docs/reconstruction-mode.md` §7.5 (the two interior states, the
evidence gate, the honesty requirement), §6.H.1 (archetype H in scope, gated), §11
decisions 2 and 7, and the national measurement they rest on,
`docs/interior-survey-2026-08-30.md`.

**Why.** §14 answers *"what stood on this ground?"* monument by monument. It says nothing
about the ground **inside** a fort, which is most of what a visitor looks at: today the
interior is bare measured terrain. §7.5 fixes two states for it — `cleared` (the measured
surface, the SGU soil class, stone-picked patches only where KMR places them) and
`settlement` (the same plus archetype-H buildings) — with `cleared` the default for all
1 304 forts and `settlement` offered per fort on the register's own evidence, for 54 of
them. Both the state and the evidence it rests on have to reach the app as data, because
**the browser does no parsing and no guessing** (§14): the gate is decided in
`pipeline/fornborg_pipeline/reconstruct.py` and the app reads a boolean and a citation.

## 15. `reconstruction.json` — the `interior` and `farm` blocks

### 15.1 `interior` — one optional per-site block, sibling of `monuments`

```jsonc
"interior": {
  "state": "cleared",              // the state the app opens in. Always "cleared" in v1.8.
  "settlementOffered": true,       // false ⇒ the app MUST NOT offer the settlement state,
                                   //         at any opacity, under any label (§7.5.3)
  "tradition": "limestone-ringfort",  // "mainland" | "limestone-ringfort" — a LAYOUT branch
                                      // (§7.5.2), never a different gate

  "ground": {                      // what `cleared` draws. Present whenever the block is.
    "terrainWords": ["berg i dagen", "blockig"],   // matched verbatim from the description
    "soilClass": "sgu",            // the §9 land-cover/soil source the surface reads from
    "clearedPatches": [            // ONLY where KMR places them; [] is the normal case
      { "lengthM": 8.0, "widthM": 6.0,
        "orientationDeg": 112.5,   // 0–180, 0 = N–S; null = not stated
        "sector": "S",             // compass sector of the interior, KMR's own word.
                                   // NOT a coordinate — see the rules below.
        "source": "measured",
        "sentence": "…avgränsar två röjda ytor 8x6 (VNV-ÖSÖ) och 6x4 m (Ö-V) i den S delen av borgområdet." }
    ],
    "source": "derived"
  },

  "evidence": {                    // §7.5.2. Present even when the gate fails.
    "rule": "interior-strong-tier-2026-08-30",   // the named rule version, for the panel
    "gate": "pass",                // "pass" | "fail"
    "channels": ["description"],   // "description" | "settlement-record" | "cited"
    "hedged": false,               // true ⇒ every surviving hit hedges (möjlig/trolig/-liknande)
    "terms": ["husgrund"],         // strong-tier stems that survived, for the popup
    "citations": [
      { "channel": "description", "lamningsnummer": "L1957:426",
        "term": "husgrund", "matched": "husgrunder", "hedged": false,
        "sentence": "Innanför muren är 88 husgrunder, fördelade på två grupper, en yttre med husen radiellt utgående från murens insida…" },
      { "channel": "settlement-record", "id": "L1935:9444",
        "lamningstyp": "Husgrund, förhistorisk/medeltida",
        "test": "polygon" },       // "polygon" | "bbox" — bbox is weaker and must be shown
      { "channel": "cited", "reference": "Englund 2018; Sjöblom et al. 2022",
        "statement": "Settlement layer inside the fort, 14C AD 432–542.",
        "enteredBy": "pipeline" }  // hand-entered, literature-backed (§7.5.3 channel 3)
    ],
    "discarded": { "negated": 0, "exterior": 2, "nonbuildingTerrass": 0, "modern": 0 },
    "survey": "docs/interior-survey-2026-08-30.json"   // provenance of the measurement
  },

  "buildings": {                   // sampler spec for the `settlement` state; null = the
                                   // record attests buildings but states nothing about them
    "count": 88,                   // how many to place inside the §3 extent polygon
    "countSource": "measured",     // measured|derived|assumed
    "countStated": true,           // false = inferred from the itemisation, as §14's field.count
    "layout": "radial",            // "radial" (against the inner wall face) | "grouped" | "free"
    "groups": 2,                   // null = not stated
    "sector": null,                // restrict placement to this compass sector; null = whole interior
    "template": { /* one building spec — see §15.2 */ },
    "source": "measured"
  }
}
```

### 15.2 `farm` — one optional per-monument block, `archetype: "farmstead"` only

§14 says "two archetypes carry one extra block each". It is now three: `grave-field`
carries `field`, `fort` carries `fort`, and **`farmstead` carries `farm`**. Every number in
it traces to `docs/reconstruction-mode.md` §6.H, which is the weakest-evidenced card in the
catalogue — which is why each one is a labelled default that the record overrides wherever
the record speaks.

```jsonc
"farm": {
  "buildings": [
    { "kind": "longhouse",         // "longhouse" | "ancillary" | "grophus"
      "count": 1,
      "lengthM": [20.0, 40.0],     // ranges per §14's range rule; a stated value ⇒ [v, v]
      "widthM": [6.0, 8.0],
      "orientationDeg": null,      // long axis 0–180, 0 = N–S; null ⇒ the sampler chooses
      "aisleFraction": 0.4,        // *underbalanserad*: ~40 % of breadth (Göthberg 2000)
      "aisleWidthM": [1.3, 2.8],
      "wallHeightM": 1.2,          // ≥ 1.0 and load-bearing — NOT a footing (Näsman 1976)
      "roofForm": "hipped",        // "hipped" — no gabled Iron Age longhouse in v1.8
      "roofPitchDeg": 45.0,
      "hipPitchDeg": 48.0,         // MUST be ≥ roofPitchDeg (§6.H; the Eketorp-II error)
      "smokeVent": "board-with-hole",       // small, at the top of each hip; not a louvre
      "covering": "turf-over-birch-bark",   // Gene analogue, ~350–600 CE
      "walls": "wattle-and-daub-on-stone-footing",
      "trestleSpacingM": [2.0, 3.0],
      "source": "assumed",
      "tiers": { "plan": "assumed", "profile": "derived", "surface": "assumed" } }
  ],
  "layout": "yard",                // "yard" | "radial" | "grouped" | "row"
  "features": { "hearth": true, "well": true, "enclosure": false },
  "insideFortId": null,            // the fort whose extent contains this record, or null.
                                   // Non-null ⇒ this record is a channel-2 citation for
                                   // that fort's `interior.evidence` (§7.5.2).
  "source": "assumed"
}
```

`defaults` gains the matching literature defaults so the app can expose them as tunables,
exactly as `defaults.mound` already is:

```jsonc
"defaults": {
  "farmstead": { "lengthM": [20.0, 40.0], "widthM": [6.0, 8.0], "aisleFraction": 0.4,
                 "wallHeightM": 1.2, "roofPitchDeg": 45.0, "hipPitchDeg": 48.0,
                 "covering": "turf-over-birch-bark", "ancillary": 2, "grophus": 1 },
  "interior": { "state": "cleared", "clearedPatchDepthM": 0.1 }
}
```

and `coverage` gains two keys, in the spirit of the rest of that block — *what the parse
actually found*:

```jsonc
"coverage": {
  "interiorGate": "pass",          // "pass" | "fail" | null (not a fort site)
  "interiorBuildingsStated": true  // a house COUNT was read from the record, not defaulted
}
```

### 15.3 Rules

- **Still no coordinates** (§14's first rule, and the one easiest to break here). A cleared
  patch and a building are given a **size, an orientation and a compass sector**, never a
  position: `sector` is KMR's own word (`S`, `SÖ`, `NV`, …) for a part of the interior, and
  the app resolves it against the fort's §3 extent polygon at runtime, the same way the
  grave-field sampler resolves `field.count` against that polygon. A second file carrying a
  second copy of a position is a second thing that can drift.
- **Still no ground heights.** `wallHeightM` and `clearedPatchDepthM` are heights and depths
  *relative to the ground at that point*; the ground is sampled at runtime, and the interior
  geometry lives in the scene outside `terrain.group` and re-seats itself on
  `refreshHeights()` like every other reconstructed monument. Check it at ×1 and ×2.5.
- **The gate is decided in the pipeline, never in the app.** `settlementOffered` is a
  boolean the app obeys. It must not re-derive it, soften it, or offer the state because a
  description "looks like" it mentions a house: the browser does no parsing and no guessing
  (§14). An app that finds `"settlementOffered": false` and an inhabited-looking description
  draws the `cleared` state and nothing else.
- **No citation, no state.** `settlementOffered: true` **requires** a non-empty
  `evidence.citations`, and `validate_document` rejects the pair broken. A fort in the
  `settlement` state must be able to show the visitor the KMR sentence (or the neighbouring
  record, or the literature reference) it is drawn from — that is §7.5.3's honesty
  requirement expressed as a schema constraint rather than as a hope about the UI.
- **A fort that fails the gate keeps its `evidence` block.** `gate: "fail"` with empty
  citations and the `discarded` counters filled is a *statement*, and a useful one: it lets
  the panel say "the register records no buildings inside this fort, and two mentions of
  houses that it places outside it" instead of saying nothing.
- **Hedging travels.** `evidence.hedged` is true when every surviving hit hedges
  (`möjlig`, `trolig`, `sannolik`, `eventuell`, `-liknande`); the app must mark the state
  accordingly. 16 of 43 strong-tier forts are in this position.
- **The record outranks the defaults.** Where the description states a house count,
  dimensions, orientation or grouping, they are written with `source: "measured"` and the
  matching `defaults.farmstead` value is *not* used; where it is silent, the default is used,
  the path is listed in the monument's `fallbacks`, and `parseConfidence` drops. This is
  §14's "nothing is invented silently" applied to the archetype that needs it most.
- **Inside a fort, `farm.features` is all false.** Hearths, wells, yards, fences and field
  systems are a farmstead recipe for open ground; inside an enclosure nobody recorded them
  (§7.5.3). The block still carries the keys, so the refusal is visible rather than implied.
- **`count` is an upper bound.** The sampler may place fewer buildings than a stated count if
  the extent will not hold them; the shortfall is a monument `warnings` entry, never a silent
  truncation.
- **Validation** (`reconstruct.validate_document`, with the app's `schema.ts` as a second
  line): `interior.state` ∈ {`cleared`, `settlement`} and is `cleared` in v1.8;
  `tradition` ∈ {`mainland`, `limestone-ringfort`}; `evidence.gate` ∈ {`pass`, `fail`} and
  `pass` ⇔ `settlementOffered`; every citation carries a `channel` and the field its channel
  requires (`sentence`, `id`, or `reference`); `hipPitchDeg ≥ roofPitchDeg`;
  `wallHeightM ≥ 1.0`; `aisleFraction` ∈ [0.3, 0.6]; every range `[min, max]` with
  `min ≤ max`; `farm` present only on `archetype: "farmstead"`, `interior` only on a site
  whose `monuments` contain a `fort`.
- **Provenance.** Nothing here changes the `reconstruction` layer's `conjecture` provenance
  (§14, PLAN §6.1): it is already the floor of the range. `interior.ground` is Model over
  Measured (a soil-class surface on the measured DEM) and reaches the visitor through the
  popup's per-part tiers; `interior.buildings` and `farm` are archetype H — **Conjecture**,
  off by default (`docs/reconstruction-mode.md` §9), with the strongest caveat in the app.

**Compatibility.** A pre-v1.8 `reconstruction.json` has no `interior` and no `farm`: the
app opens every fort on `cleared`, offers no `settlement` state anywhere, and keeps the flat
marker for every `farmstead` record, which is precisely the pre-amendment behaviour. A v1.8
file in a pre-v1.8 app ignores both blocks (§2's rules) and renders as before. A
`settlement` state the app cannot draw yet falls back to `cleared`, never to an empty
interior with the control still showing.
