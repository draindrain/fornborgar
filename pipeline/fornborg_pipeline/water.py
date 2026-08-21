"""CLI: derive the Phase-4 water assets for one site from the committed DEM.

    python3 -m fornborg_pipeline.water --site broborg

Two outputs, both defined in docs/data-formats.md v1.1:

  * `shoreline.json`     — §6, century -> water level (needs the SGU OGC API)
  * `water_connect.tif`  — §7, sea-connectivity grid (needs only `dem_context.tif`)

and a patch of the site's `manifest.json` + `DATA-LICENSES.md` so the app can find
and credit them. This step deliberately reads the **committed** context COG rather
than the raw Lantmäteriet mosaic: the water assets can be rebuilt by anyone who has
the repository, with no Geotorget credentials. `build.py` runs the same code as
part of a full rebuild.
"""

from __future__ import annotations

import json
import sys
import time

import click
import rasterio

from .clip_dem import check_height_sanity, dequantize_decimeters, read_grid
from .connectivity import (
    WATER_CONNECT_PATH,
    basin_stats,
    build_connect_grid,
    ring_connect_spec,
    write_connect_grid,
    write_ring_connect_grid,
)
from .fetch_dem import FetchError
from .manifest import (
    add_water_assets,
    set_ring_water_connect,
    validate_manifest,
    write_data_licenses,
    write_manifest,
)
from .shoreline import (
    SHORELINE_PATH,
    STRAND_PRODUCT,
    ShorelineError,
    build_shoreline,
    derive_steps,
    fetch_strand_features,
    sweref_projector,
    write_shoreline,
)
from .sites import RING_LADDER, SITES, SiteConfig, get_site

# Levels the run log reports false-basin area at: the fort era (~8-10 m) plus the
# top of the slider range, where phase 0 found the big basins (PLAN.md §4.5).
REPORT_LEVELS = (8.0, 9.0, 10.0, 11.0, 15.0)

PROCESSING_STEPS = (
    "SGU strandförskjutning boundary sampling (median vs. context DEM)",
    "priority-flood sea-connectivity grid (int16 dm, ceil-quantized)",
)


def run_shoreline(cfg: SiteConfig, heights_m, transform, bounds, force: bool = False) -> dict:
    """Fetch SGU, derive the century table, write `shoreline.json`. Returns the meta."""
    features, meta = fetch_strand_features(cfg, force=force)
    steps, stats = derive_steps(
        features, heights_m, transform, bounds, project=sweref_projector()
    )
    table = build_shoreline(cfg, steps, stats, meta)

    print(f"  {'yearCE':>7} {'BP':>5} {'levelM':>7}  source")
    for step in sorted(steps, key=lambda s: s.year_ce):
        source = f"boundary median ({step.samples} samples)" if step.derived else "trend fit"
        print(f"  {step.year_ce:7d} {step.bp:5d} {step.level_m:7.1f}  {source}")
    print(
        f"  {stats['measured']}/{stats['stepCount']} steps measured, "
        f"{len(stats['filled'])} extrapolated (degree {stats['trendDegree']}, "
        f"RMS {stats['trendRms']:.2f} m), monotone clamp {stats['clampedTotalM']:.2f} m"
    )
    if stats["missingBp"]:
        print(f"  BP steps absent from the SGU product: {stats['missingBp']}")

    path = write_shoreline(cfg.out_dir / SHORELINE_PATH, table)
    print(f"  wrote {path} ({path.stat().st_size / 1e3:.1f} kB)")
    return meta


def run_connectivity(cfg: SiteConfig, dem_dm, transform) -> None:
    """Build and write `water_connect.tif`, then report what it excludes."""
    started = time.time()
    connect_dm = build_connect_grid(dem_dm)
    print(f"  priority flood: {dem_dm.size:,} cells in {time.time() - started:.1f} s")

    raised = int((connect_dm > dem_dm).sum())
    lifted = dequantize_decimeters(connect_dm - dem_dm)
    print(
        f"  connect > dem in {raised:,} cells ({100.0 * raised / dem_dm.size:.2f} %), "
        f"max lift {lifted.max():.1f} m"
    )

    cell_area = cfg.context.resolution**2
    print(f"  {'level':>6} {'wet %':>7} {'excluded ha':>12} {'largest basin ha':>17}")
    for level in REPORT_LEVELS:
        wet, excluded, largest = basin_stats(dem_dm, connect_dm, level, cell_area)
        print(
            f"  {level:6.1f} {100.0 * wet / dem_dm.size:7.2f} "
            f"{excluded * cell_area / 1e4:12.2f} {largest / 1e4:17.2f}"
        )

    path = write_connect_grid(cfg.out_dir / WATER_CONNECT_PATH, connect_dm, transform, cfg)
    print(f"  wrote {path} ({path.stat().st_size / 1e6:.2f} MB)")
    _check_identical_profile(cfg.out_dir / cfg.context.path, path)


def run_ring_connectivity(cfg: SiteConfig, manifest: dict) -> tuple[str, str] | None:
    """Build the §11 far-water connect grid on the 16 km ring, when the site has one.

    Returns `(ring_dem_path, connect_path)` for the manifest patch, or None when
    the site ships no rings (feature off, never an error). The grid exists only
    for far-water *rendering* — analysis stays on the context connect grid (§7).
    """
    rings = manifest.get("grids", {}).get("rings", [])
    if len(rings) < 2:
        return None
    entry = rings[1]  # the 16x16 km ring — §11 always ships ring3+ring4
    ring_spec = next((s for s in RING_LADDER if s.path == entry.get("path")), None)
    if ring_spec is None:
        print(f"  far-water connect skipped: unknown ring path {entry.get('path')!r}")
        return None
    ring_path = cfg.out_dir / ring_spec.path
    if not ring_path.exists():
        print(f"  far-water connect skipped: {ring_path} is missing")
        return None

    dem_raw, transform, _bounds = read_grid(ring_path)
    started = time.time()
    connect_raw = build_connect_grid(dem_raw, scale=ring_spec.quant_scale)
    print(
        f"  far-water priority flood ({ring_spec.name}): {dem_raw.size:,} cells "
        f"in {time.time() - started:.1f} s"
    )
    connect_spec = ring_connect_spec(ring_spec)
    path = write_ring_connect_grid(
        cfg.out_dir / connect_spec.path, connect_raw, transform, cfg, ring_spec
    )
    print(f"  wrote {path} ({path.stat().st_size / 1e6:.2f} MB)")
    return ring_spec.path, connect_spec.path


def _check_identical_profile(reference, candidate) -> None:
    """The contract says water_connect.tif matches dem_context.tif exactly (§7)."""
    with rasterio.open(reference) as ref, rasterio.open(candidate) as new:
        mismatches = {
            key: (getattr(ref, key), getattr(new, key))
            for key in ("width", "height", "crs", "transform", "bounds", "dtypes", "nodata")
            if getattr(ref, key) != getattr(new, key)
        }
        for key in ("compress", "predictor", "blockxsize", "blockysize"):
            if ref.profile.get(key) != new.profile.get(key):
                mismatches[key] = (ref.profile.get(key), new.profile.get(key))
        if ref.overviews(1) != new.overviews(1):
            mismatches["overviews"] = (ref.overviews(1), new.overviews(1))
    if mismatches:
        raise ValueError(
            f"{candidate.name} does not match {reference.name}'s profile: {mismatches}"
        )
    print(f"  profile identical to {reference.name} (geometry, encoding, tiling, overviews)")


def _soils_meta(cfg: SiteConfig, source: dict | None) -> dict | None:
    """The land-cover step's DATA-LICENSES inputs, recovered from what it left behind.

    Returns None when this site ships no land-cover assets, which is what
    `write_data_licenses` wants in order to omit the section entirely.
    """
    if not source:
        return None
    legend_path = cfg.out_dir / "landcover_legend.json"
    reference_year = "n/a"
    if legend_path.exists():
        legend = json.loads(legend_path.read_text(encoding="utf-8"))
        reference_year = legend.get("referenceYearCE", "n/a")
    return {**source, "referenceYearCE": reference_year}


def patch_manifest(cfg: SiteConfig, water_meta: dict) -> dict:
    """Add the water pair to the site's committed manifest and re-validate it."""
    manifest_path = cfg.out_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    add_water_assets(
        manifest,
        SHORELINE_PATH,
        WATER_CONNECT_PATH,
        source={
            "id": "sgu-strandforskjutning",
            "product": water_meta.get("product", STRAND_PRODUCT),
            "api": water_meta.get("api", ""),
            "collections": list(water_meta.get("collections", [])),
            "tiles": [],
            "fetched": water_meta.get("fetched", ""),
        },
        processing=PROCESSING_STEPS,
    )
    write_manifest(manifest_path, manifest)
    print(f"  wrote {manifest_path}")

    # DATA-LICENSES.md is rewritten whole, so every section a *later* step owns is
    # reconstructed from the manifest's own provenance rather than dropped — the
    # same trick `landcover.patch_manifest` uses in the other direction.
    sources = {s.get("id"): s for s in manifest.get("provenance", {}).get("sources", [])}
    dem_source = sources.get("lantmateriet-dtm", {})
    source_meta = {
        "product": dem_source.get("product", ""),
        "stacItems": dem_source.get("tiles", []),
        "fetched": dem_source.get("fetched", ""),
    }
    licenses_path = write_data_licenses(
        cfg.out_dir / "DATA-LICENSES.md",
        cfg,
        source_meta,
        water_meta=water_meta,
        soils_meta=_soils_meta(cfg, sources.get("sgu-jordarter")),
    )
    print(f"  wrote {licenses_path}")
    return manifest


def run(site_id: str, force_download: bool = False) -> dict:
    """Derive both water assets for one site and wire them into the manifest."""
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — water assets from the committed context grid")

    context_path = cfg.out_dir / cfg.context.path
    if not context_path.exists():
        raise SystemExit(
            f"{context_path} is missing — run `python3 -m fornborg_pipeline.build "
            f"--site {cfg.id}` first (that step needs Lantmäteriet credentials)."
        )
    dem_dm, transform, bounds = read_grid(context_path)
    heights_m = dequantize_decimeters(dem_dm)
    check_height_sanity(heights_m, transform, cfg, f"grid {cfg.context.name}")
    print(
        f"-- context grid: {dem_dm.shape[1]}x{dem_dm.shape[0]} @ {cfg.context.resolution} m | "
        f"z {heights_m.min():.1f}..{heights_m.max():.1f} m RH 2000"
    )

    print("-- shoreline (SGU strandförskjutningsmodell)")
    water_meta = run_shoreline(cfg, heights_m, transform, bounds, force=force_download)

    print("-- sea connectivity")
    run_connectivity(cfg, dem_dm, transform)

    print("-- far-water connectivity (contract §11)")
    committed = json.loads((cfg.out_dir / "manifest.json").read_text(encoding="utf-8"))
    ring_connect = run_ring_connectivity(cfg, committed)

    print("-- manifest")
    manifest = patch_manifest(cfg, water_meta)
    if ring_connect is not None:
        set_ring_water_connect(manifest, *ring_connect)
        write_manifest(cfg.out_dir / "manifest.json", manifest)
    validate_manifest(manifest)

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
    help="Site to derive the water assets for.",
)
@click.option(
    "--force-download",
    is_flag=True,
    help="Re-fetch the SGU shoreline extract even if a valid cached copy exists.",
)
def cli(site_id: str, force_download: bool) -> None:
    """Derive shoreline.json + water_connect.tif and patch the site manifest."""
    try:
        run(site_id, force_download=force_download)
    except FetchError as exc:
        raise SystemExit(f"FETCH FAILED: {exc}") from exc
    except ShorelineError as exc:
        raise SystemExit(f"SANITY CHECK FAILED: {exc}") from exc


if __name__ == "__main__":
    sys.exit(cli())
