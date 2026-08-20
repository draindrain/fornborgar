"""fornborg-pipeline — offline data preparation for the Fornborg Explorer app.

Everything that needs GDAL/geodesy happens here; the deployed app is static files.
The output contract is docs/data-formats.md (FROZEN v1) — see `manifest.SCHEMA_VERSION`.

Module map:
  sites      — per-site constants (center, extents, sanity bands, RAÄ identifiers)
  fetch_dem  — the ONLY module that touches the network (Lantmäteriet STAC + /vsicurl)
  clip_dem   — pure array/transform functions: fill, crop, downsample, quantize, write
  manifest   — pure dict assembly for manifest.json
  build      — click CLI wiring fetch -> clip -> manifest
"""

__version__ = "0.1.0"

PIPELINE_NAME = "fornborg-pipeline"
