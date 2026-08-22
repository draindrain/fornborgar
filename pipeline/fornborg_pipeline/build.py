"""CLI: fetch -> clip -> manifest -> rings -> water -> rampart -> land cover for one site.

    python3 -m fornborg_pipeline.build --site broborg

Raw downloads are cached in the gitignored `data-cache/` at the repo root and
reused when they match the site config; the app-facing outputs land in
`app/public/data/<siteId>/` (docs/data-formats.md).

The water step (shoreline table + connectivity grid, contract §6/§7), the rampart
step (crest polylines, §8) and the land-cover step (class raster + legend, §9/§10)
all run off the grids this module just wrote, so each can also be re-run on its own
without the Lantmäteriet credentials — see `fornborg_pipeline.water`,
`fornborg_pipeline.rampart` and `fornborg_pipeline.landcover`.
"""

from __future__ import annotations

import json
import sys

import click

from . import landcover, rampart, rings, water
from .clip_dem import VerticalDatumError, build_grids, sample_nearest, write_grid
from .fetch_dem import FetchError, fetch_source_mosaic, read_source_mosaic
from .fetch_soils import SoilsError
from .landcover import LandcoverError
from .manifest import build_manifest, write_data_licenses, write_manifest
from .rampart import RampartError
from .rings import RingsError
from .shoreline import ShorelineError
from .sites import SITES, get_site


def run(
    site_id: str,
    force_download: bool = False,
    skip_rings: bool = False,
    skip_water: bool = False,
    skip_rampart: bool = False,
    skip_landcover: bool = False,
) -> dict:
    """Run the whole pipeline for one site. Returns the manifest dict."""
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — center E {cfg.center_e:.0f} N {cfg.center_n:.0f}")

    print("-- fetch")
    cache_path, source_meta = fetch_source_mosaic(cfg, force=force_download)
    source, source_transform, nodata = read_source_mosaic(cache_path)

    print("-- clip / quantize")
    grids = build_grids(source, source_transform, nodata, cfg)
    for name, grid in grids.items():
        out_path = cfg.out_dir / grid.spec.path
        write_grid(out_path, grid)
        size_mb = out_path.stat().st_size / 1e6
        print(
            f"  {name}: {grid.width}x{grid.height} @ {grid.spec.resolution} m | "
            f"z {grid.min_elevation:.1f}..{grid.max_elevation:.1f} m | "
            f"filled {grid.filled_cells} | {size_mb:.2f} MB -> {out_path}"
        )

    core = grids["core"]
    center = sample_nearest(core.heights_m(), core.transform, cfg.center_e, cfg.center_n)
    band = cfg.center_height_range or "not checked — registry site"
    print(f"  center height check: {center:.1f} m RH 2000 (band {band})")

    print("-- manifest")
    manifest = build_manifest(cfg, grids, source_meta)
    manifest_path = write_manifest(cfg.out_dir / "manifest.json", manifest)
    licenses_path = write_data_licenses(cfg.out_dir / "DATA-LICENSES.md", cfg, source_meta)
    print(f"  wrote {manifest_path}")
    print(f"  wrote {licenses_path}")

    if not skip_rings:
        # Contract §11: fetches the far-field ring mosaics (decimated overview
        # reads), decides the ladder depth from the horizon math and patches
        # `grids.rings` + `horizon` into this manifest. Runs before the water
        # step so the far-water connect grid can be derived from the 16 km ring.
        try:
            manifest = rings.run(site_id, force_download=force_download)
        except RingsError as exc:
            print(f"  rings skipped: {exc}")

    if not skip_water:
        # Derives shoreline.json + water_connect.tif from the grids just written and
        # patches this manifest (and DATA-LICENSES.md) with the water pair — plus
        # the §11 far-water connect grid when the site ships rings.
        manifest = water.run(site_id, force_download=force_download)

    if not skip_rampart:
        # Contract §8: derives rampart.json from the core grid + the committed KMR
        # extent polygon and patches this manifest with the asset + palisade layer.
        # A site with no extent polygon simply has no crest to derive — that is a
        # missing input, not a build failure.
        try:
            rampart.run(site_id)
            manifest = json.loads((cfg.out_dir / "manifest.json").read_text(encoding="utf-8"))
        except RampartError as exc:
            print(f"  rampart crest skipped: {exc}")

    if not skip_landcover:
        # Contract §9/§10: derives landcover.tif + landcover_legend.json from the
        # grids just written, the water assets and the SGU soil polygons, and
        # patches this manifest with the pair + the modelled `landcover` layer. A
        # site whose soil extract or water assets are missing simply has nothing to
        # classify — a missing input, not a build failure.
        try:
            manifest = landcover.run(site_id, force_download=force_download)
        except (LandcoverError, SoilsError, FetchError) as exc:
            print(f"  landcover skipped: {exc}")

    total = sum(p.stat().st_size for p in cfg.out_dir.glob("*") if p.is_file())
    print(f"== done: {cfg.out_dir} ({total / 1e6:.2f} MB total)")
    return manifest


@click.command()
@click.option(
    "--site",
    "site_id",
    default="broborg",
    show_default=True,
    type=click.Choice(sorted(SITES)),
    help="Site to build.",
)
@click.option(
    "--force-download",
    is_flag=True,
    help="Re-download the raw mosaic (and the SGU extract) even if a valid cache exists.",
)
@click.option(
    "--skip-rings",
    is_flag=True,
    help="Leave the far-field ring grids untouched (contract §11).",
)
@click.option(
    "--skip-water",
    is_flag=True,
    help="Stop after the manifest; leave shoreline.json / water_connect.tif untouched.",
)
@click.option(
    "--skip-rampart",
    is_flag=True,
    help="Leave rampart.json untouched (contract §8).",
)
@click.option(
    "--skip-landcover",
    is_flag=True,
    help="Leave landcover.tif / landcover_legend.json untouched (contract §9/§10).",
)
def cli(
    site_id: str,
    force_download: bool,
    skip_rings: bool,
    skip_water: bool,
    skip_rampart: bool,
    skip_landcover: bool,
) -> None:
    """Build the app data for a site: fetch the DEM, clip it, derive water, write the manifest."""
    try:
        run(
            site_id,
            force_download=force_download,
            skip_rings=skip_rings,
            skip_water=skip_water,
            skip_rampart=skip_rampart,
            skip_landcover=skip_landcover,
        )
    except FetchError as exc:
        raise SystemExit(f"FETCH FAILED: {exc}") from exc
    except (VerticalDatumError, ShorelineError, LandcoverError) as exc:
        raise SystemExit(f"SANITY CHECK FAILED: {exc}") from exc


if __name__ == "__main__":
    sys.exit(cli())
