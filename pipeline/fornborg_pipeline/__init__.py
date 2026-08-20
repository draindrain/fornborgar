"""fornborg-pipeline — offline data preparation for the Fornborg Explorer app.

Everything that needs GDAL/geodesy happens here; the deployed app is static files.
The output contract is docs/data-formats.md (FROZEN v1) — see `manifest.SCHEMA_VERSION`.

Module map:
  sites        — per-site constants (center, extents, sanity bands, RAÄ identifiers)
  fetch_dem    — Lantmäteriet STAC + /vsicurl (the only credentialed network path)
  clip_dem     — pure array/transform functions: fill, crop, downsample, quantize, read/write
  shoreline    — century -> water level table from the SGU OGC API (contract §6)
  connectivity — priority-flood sea-connectivity grid, pure arrays (contract §7)
  rampart      — click CLI + pure arrays: rampart crest lines from the DEM (contract §8)
  manifest     — pure dict assembly for manifest.json
  water        — click CLI: shoreline + connectivity off the committed grids
  build        — click CLI wiring fetch -> clip -> water -> manifest

Only `fetch_dem` and `shoreline` touch the network; everything else is arrays and
dicts, so the whole encoding path is testable on synthetic fixtures.
"""

__version__ = "0.1.0"

PIPELINE_NAME = "fornborg-pipeline"
