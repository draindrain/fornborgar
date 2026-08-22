"""CLI: build the far-field ring grids for one site (contract v1.4 §11).

    python3 -m fornborg_pipeline.rings --site broborg

Fetches each ring's mosaic at ring resolution (decimated reads served from the
source COGs' overview levels — needs Lantmäteriet credentials), decides the
ladder depth from the horizon math (`fornborg_pipeline.horizon`), writes the
`dem_ring<N>.tif` COGs and patches `grids.rings` + `horizon` into the committed
manifest. `build.py` runs the same code as part of a full rebuild.

The far-water connect grid on the 16 km ring is NOT built here — it belongs to
the water step (`fornborg_pipeline.water`), which needs no credentials and runs
against the committed ring COG this module writes.
"""

from __future__ import annotations

import json
import sys

import click
import numpy as np

from .clip_dem import Grid, build_grid, dequantize_decimeters, fill_nodata, read_grid, write_grid
from .fetch_dem import FetchError, fetch_ring_mosaic, read_source_mosaic
from .horizon import (
    EYE_HEIGHT_M,
    crown_height,
    floor_height,
    horizon_distance_m,
    horizon_info,
    ladder,
    rings_beyond,
)
from .manifest import add_rings, validate_manifest, write_manifest
from .rampart import RampartError, extent_ring
from .sites import RING_LADDER, GridSpec, SiteConfig, get_site


class RingsError(RuntimeError):
    """A missing prerequisite for the ring build (not a sanity failure)."""


def build_ring(cfg: SiteConfig, spec: GridSpec, force: bool = False) -> tuple[Grid, dict]:
    """Fetch one ring's mosaic and turn it into a finished output grid."""
    cache_path, meta = fetch_ring_mosaic(cfg, spec, force=force)
    source, transform, nodata = read_source_mosaic(cache_path)
    filled, filled_cells = fill_nodata(source, nodata)
    grid = build_grid(
        filled, transform, spec, cfg, filled_cells, source_resolution=spec.resolution
    )
    return grid, meta


def extent_ring_en(cfg: SiteConfig) -> np.ndarray | None:
    """The KMR extent polygon in (E, N), or None when the site ships no polygon."""
    sites_path = cfg.out_dir / "sites.json"
    if not sites_path.exists():
        return None
    site_key = (cfg.raa or {}).get("lamningsnummer") or cfg.id
    try:
        ring_local = extent_ring(json.loads(sites_path.read_text(encoding="utf-8")), site_key)
    except RampartError:
        return None
    # Local scene -> EPSG:3006 (docs/data-formats.md §0): E = x + origin.e, N = origin.n - z.
    return np.column_stack(
        (ring_local[:, 0] + cfg.center_e, cfg.center_n - ring_local[:, 1])
    )


#: §11 defines the horizon floor as the 5th percentile of the **16x16 km box**.
#: That is ring4 for a standard site and, for a `large` one whose ladder starts
#: at ring4, still ring4 — but naming the box rather than an index keeps the
#: definition true whichever preset built the ladder.
FLOOR_BOX_HALF_EXTENT_M = 8000.0


def _floor_grid(ring_grids: list[Grid]) -> Grid:
    """The built ring covering §11's 16x16 km floor box, or the widest we have."""
    for grid in ring_grids:
        if abs(grid.spec.half_extent - FLOOR_BOX_HALF_EXTENT_M) < 1e-6:
            return grid
    return max(ring_grids, key=lambda g: g.spec.half_extent)


def ring_processing_steps(ring_grids: list[Grid], metas: list[dict]) -> list[str]:
    """Provenance lines for the §11 seams: overview resampling + sea fill."""
    steps = [
        "far-field rings: decimated windowed reads (average) from source COG overviews"
    ]
    for grid, meta in zip(ring_grids, metas):
        sea = int(meta.get("seaFilledCells", 0))
        if sea:
            steps.append(
                f"{grid.spec.name}: {sea} cells outside tile coverage sea-filled at 0 m "
                f"(Copernicus GLO-30 fill deferred to Phase 9)"
            )
    return steps


def run(site_id: str, force_download: bool = False) -> dict:
    """Build the ring ladder for one site and wire it into the manifest."""
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — far-field rings (contract §11)")

    manifest_path = cfg.out_dir / "manifest.json"
    if not manifest_path.exists():
        raise RingsError(
            f"{manifest_path} is missing — run `python3 -m fornborg_pipeline.build "
            f"--site {cfg.id}` first."
        )
    core_path = cfg.out_dir / cfg.core.path
    if not core_path.exists():
        raise RingsError(f"{core_path} is missing — run the build step for {cfg.id} first.")

    # A site always ships the first two rings beyond its context (§11); the
    # 16x16 km box among them supplies the floor height.
    usable = rings_beyond(cfg.context.half_extent)
    ring_grids: list[Grid] = []
    metas: list[dict] = []
    for spec in usable[:2]:
        print(f"-- {spec.name}: {2 * spec.half_extent / 1000:.0f} km box @ {spec.resolution:.0f} m")
        grid, meta = build_ring(cfg, spec, force=force_download)
        ring_grids.append(grid)
        metas.append(meta)

    core_dm, core_transform, _ = read_grid(core_path)
    crown = crown_height(
        dequantize_decimeters(core_dm), core_transform, extent_ring_en(cfg)
    )
    floor = floor_height(_floor_grid(ring_grids).heights_m())
    h = (crown + EYE_HEIGHT_M) - floor
    distance = horizon_distance_m(h)
    specs = ladder(distance, context_half_extent_m=cfg.context.half_extent)
    print(
        f"-- horizon: crown {crown:.1f} m + eye {EYE_HEIGHT_M:.0f} m, floor {floor:.1f} m "
        f"-> h {h:.1f} m -> d {distance / 1000:.1f} km -> "
        f"{len(specs)} rings (out to {2 * specs[-1].half_extent / 1000:.0f} km)"
    )

    for spec in specs[2:]:
        print(f"-- {spec.name}: {2 * spec.half_extent / 1000:.0f} km box @ {spec.resolution:.0f} m")
        grid, meta = build_ring(cfg, spec, force=force_download)
        ring_grids.append(grid)
        metas.append(meta)

    for grid in ring_grids:
        out_path = cfg.out_dir / grid.spec.path
        write_grid(out_path, grid)
        print(
            f"  {grid.spec.name}: {grid.width}x{grid.height} @ {grid.spec.resolution:.0f} m | "
            f"z {grid.min_elevation:.1f}..{grid.max_elevation:.1f} m | "
            f"quant {grid.spec.quant_scale} m | filled {grid.filled_cells} | "
            f"{out_path.stat().st_size / 1e6:.2f} MB -> {out_path}"
        )

    print("-- manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    add_rings(
        manifest,
        ring_grids,
        cfg,
        horizon_info(crown, floor),
        processing=ring_processing_steps(ring_grids, metas),
    )
    write_manifest(manifest_path, manifest)
    validate_manifest(manifest)
    print(f"  wrote {manifest_path} ({len(ring_grids)} rings + horizon block)")

    total = sum(p.stat().st_size for p in cfg.out_dir.glob("*") if p.is_file())
    print(f"== done: {cfg.out_dir} ({total / 1e6:.2f} MB total)")
    return manifest


@click.command()
@click.option(
    "--site",
    "site_id",
    default="broborg",
    show_default=True,
    help="Site to build the ring ladder for.",
)
@click.option(
    "--force-download",
    is_flag=True,
    help="Re-download the ring mosaics even if valid caches exist.",
)
def cli(site_id: str, force_download: bool) -> None:
    """Build the far-field ring grids and patch the site manifest (contract §11)."""
    try:
        run(site_id, force_download=force_download)
    except (FetchError, RingsError) as exc:
        raise SystemExit(f"RINGS FAILED: {exc}") from exc


if __name__ == "__main__":
    sys.exit(cli())
