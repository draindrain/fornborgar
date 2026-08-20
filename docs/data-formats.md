# Data formats — the pipeline ↔ app contract

**Status: FROZEN v1 (2026-08-20).** This file and the `manifest.json` schema below are
the single source of truth for what the Python pipeline writes under
`app/public/data/<siteId>/` and what the TypeScript app reads. Changes require a schema
version bump and a matching change on both sides in the same commit. Derived from
PLAN.md §1, §4.1, §4.2, §4.3, §4.4 (incl. the [phase-0 verified] corrections).

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
- Compression **DEFLATE**, predictor 2, tiled (512×512 internal blocks), COG layout
  with overviews (for GIS inspection; the app reads full resolution only).
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
    "sites": "sites.json"
    // later phases add: "rampart": "rampart.json", "shoreline": "shoreline.json",
    // "landcover": "landcover.png", "waterMask": "watermask.bin", …
  },
  "layers": [                                 // provenance per layer (PLAN §6.1)
    { "id": "terrain", "name": "Terrain (LiDAR DEM)", "provenance": "measured" },
    { "id": "sites",   "name": "Registered sites (KMR)", "provenance": "measured" }
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
  `gdal_viewshed` (`-cc 0.86667` ≙ 1−k with GDAL's convention, same observer/target
  heights) on identical synthetic grids; required cellwise agreement ≥ 97 % overall on
  rough terrain and exact on analytically-known cases (flat plane, single ridge).

## 5. Synthetic test site (`app/public/data/testsite/`)

A tiny, committed, pipeline-independent fixture so the app never blocks on real data:
same manifest schema, `origin {e: 0, n: 0}`, small grids (e.g. core 256×256 @ 1 m,
context 256×256 @ 2 m, uncompressed int16 TIFFs are fine), procedural terrain (a hill
with a rampart-like ring so shading is judgeable). Generated by a committed script
(`app/scripts/make-test-dem.mjs`); loaded via `?site=testsite`. The app treats it
exactly like a real site — no code path branches on site id.
