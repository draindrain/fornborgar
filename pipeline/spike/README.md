# Phase-0 spike (2026-08-20) — data checks & the hillshade gate

**Gate verdict: PASSED.** Both ramparts of Broborg (inner ring incl. both entrance
gaps, outer arc) are clearly legible in the 1 m Markhöjdmodell DEM — see `out/`.
No Laserdata-skog fallback needed. Detailed findings are folded into `PLAN.md`
(entries marked *[phase-0 verified]*).

## Scripts

Run from this directory, in order. Raw downloads land in the repo-root
`data-cache/` (gitignored — licensing and size; nothing raw is ever committed).

| script | what it does |
|---|---|
| `common.py` | site constants: Broborg at **E 665810 N 6627880** (corrected from the plan's E 668400), 4×4 km bbox, cache paths |
| `fetch_dem.py` | STAC query (`dtm-cog`) + authenticated windowed `/vsicurl` read → `data-cache/broborg_dem_4km.tif` (1 m, EPSG:3006) |
| `fetch_raa.py` | downloads the Uppsala county lämningar GeoPackage, checks the Oct-2025 schema, exports Broborg's extent polygon + all bbox features |
| `fetch_sgu.py` | SGU jordarter (OGC API, `grundlager`) + strandförskjutningsmodell (OGC API + gpkg URL spot-check) for the bbox |
| `hillshade.py` | the gate: multidirectional + single-sun hillshades, slope map, rampart transects → `out/*.png` |
| `basin_check.py` | §4.5 check: edge-connected flood fill per level — false basins **exist** (≤ ~6.3 ha), so the per-century connectivity bitmask is needed |

## Credentials

`fetch_dem.py` needs Geotorget credentials in **env vars only**:
`LANTMATERIET_USER` / `LANTMATERIET_PASS` (HTTP Basic against
`dl1.lantmateriet.se`; the *Markhöjdmodell Nedladdning* order must be attached
to the account). STAC catalog queries are anonymous. RAÄ and SGU need no auth.

## Dependencies

`rasterio`, `geopandas` (pyogrio), `pyproj`, `shapely`, `matplotlib`, `numpy`,
`scipy`; GDAL CLI (`ogrinfo`) is convenient but only used interactively.
