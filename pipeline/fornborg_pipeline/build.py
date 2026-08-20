"""CLI: fetch -> clip -> manifest for one site.

    python3 -m fornborg_pipeline.build --site broborg

Raw downloads are cached in the gitignored `data-cache/` at the repo root and
reused when they match the site config; the app-facing outputs land in
`app/public/data/<siteId>/` (docs/data-formats.md).
"""

from __future__ import annotations

import sys

import click

from .clip_dem import VerticalDatumError, build_grids, sample_nearest, write_grid
from .fetch_dem import FetchError, fetch_source_mosaic, read_source_mosaic
from .manifest import build_manifest, write_data_licenses, write_manifest
from .sites import SITES, get_site


def run(site_id: str, force_download: bool = False) -> dict:
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
    print(f"  center height check: {center:.1f} m RH 2000 (band {cfg.center_height_range})")

    print("-- manifest")
    manifest = build_manifest(cfg, grids, source_meta)
    manifest_path = write_manifest(cfg.out_dir / "manifest.json", manifest)
    licenses_path = write_data_licenses(cfg.out_dir / "DATA-LICENSES.md", cfg, source_meta)
    print(f"  wrote {manifest_path}")
    print(f"  wrote {licenses_path}")

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
    help="Re-download the raw mosaic even if a valid cached copy exists.",
)
def cli(site_id: str, force_download: bool) -> None:
    """Build the app data for a site: fetch the DEM, clip it, write the manifest."""
    try:
        run(site_id, force_download=force_download)
    except FetchError as exc:
        raise SystemExit(f"FETCH FAILED: {exc}") from exc
    except VerticalDatumError as exc:
        raise SystemExit(f"SANITY CHECK FAILED: {exc}") from exc


if __name__ == "__main__":
    sys.exit(cli())
