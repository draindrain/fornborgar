"""One command builds one registry site, end to end (scale-out §4.3).

    python3 -m fornborg_pipeline.build_site --slug l1943-7827 --out-dir build/

Turns a `registry.json` entry into a finished bundle: DEM grids, the §11 ring
ladder, the §6/§7/§12 water assets, the §3 KMR overlay, a best-effort §8 rampart
crest — then runs the §4.4 QA gates and renders the contact-sheet thumbnail.

The per-site steps are the *existing* pipeline, unchanged. What this module adds
is the three things a batch needs and a hand-configured site did not:

  * a `SiteConfig` derived from the registry (extent preset, national height
    band, an output directory outside the repository), registered so every step
    resolves it by slug;
  * a **feature-applicability policy**: water, rampart and land cover are built
    where their inputs exist and skipped where they do not — "missing asset =
    feature off" is the contract's own rule, so an inland fort with no SGU
    coverage is a normal build, not a failure;
  * **failure that lands somewhere**. Every step is caught, recorded in a build
    report, and the process exit code says whether the bundle may ship. A site
    that fails is in `skipped.json` with a reason, never silently absent.
"""

from __future__ import annotations

import json
import shutil
import sys
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import click

from . import landcover, rampart, rings, water
from .clip_dem import (
    LAYOUT_COG,
    VerticalDatumError,
    build_grids,
    dequantize,
    read_grid,
    sample_nearest,
    write_grid,
)
from .connectivity import read_connect_grid
from .fetch_dem import FetchError, fetch_source_mosaic, read_source_mosaic
from .fetch_sites import SitesError
from .fetch_sites import run as fetch_sites_run
from .landcover import LandcoverError
from .manifest import build_manifest, write_data_licenses, write_manifest
from .qa import QAReport, bundle_bytes, run_gates, water_mask_at
from .rampart import RampartError
from .registry import REGISTRY_PATH, RegistryError, get_entry
from .rings import RingsError
from .shoreline import SHORELINE_PATH, ShorelineError, interpolate_level
from .sites import (
    CACHE_DIR,
    EXTENT_PRESETS,
    NATIONAL_ELEVATION_RANGE,
    SiteConfig,
    register_site,
)
from .thumbnail import THUMBNAIL_PATH, DEFAULT_SIZE, render_thumbnail

#: The century the thumbnail's water is drawn at — the reference the land-cover
#: model already uses, so a site's thumbnail and its modelled landscape agree.
THUMBNAIL_YEAR_CE = 500

#: Where a batch keeps its per-site state and reports.
BUILD_REPORT = "build_report.json"


class BuildSiteError(RuntimeError):
    """The site cannot be built at all (bad slug, unusable registry entry)."""


@dataclass
class StepResult:
    name: str
    status: str  # "ok" | "skipped" | "failed"
    message: str = ""

    def line(self) -> str:
        return f"{self.name}: {self.status}" + (f" ({self.message})" if self.message else "")


@dataclass
class BuildResult:
    slug: str
    out_dir: Path
    steps: list[StepResult] = field(default_factory=list)
    qa: QAReport | None = None
    manifest: dict | None = None
    bytes_written: int = 0

    @property
    def built(self) -> bool:
        """True when the grids exist — QA is a separate verdict (see `shippable`)."""
        return any(s.name == "grids" and s.status == "ok" for s in self.steps)

    @property
    def shippable(self) -> bool:
        return self.built and self.qa is not None and self.qa.passed

    def as_json(self) -> dict:
        return {
            "slug": self.slug,
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "outDir": str(self.out_dir),
            "built": self.built,
            "shippable": self.shippable,
            "bytes": self.bytes_written,
            "steps": [{"name": s.name, "status": s.status, "message": s.message} for s in self.steps],
            "qa": self.qa.as_json() if self.qa else None,
        }

    def summary(self) -> str:
        """The one-line report a batch runner (or a subagent) relays."""
        verdict = "SHIPPABLE" if self.shippable else ("BUILT-BUT-FAILED-QA" if self.built else "FAILED")
        parts = [f"{self.slug}: {verdict}", f"{self.bytes_written / 1e6:.1f} MB"]
        skipped = [s.name for s in self.steps if s.status == "skipped"]
        failed = [s.line() for s in self.steps if s.status == "failed"]
        if skipped:
            parts.append("skipped=" + ",".join(skipped))
        if failed:
            parts.append("failed=" + "; ".join(failed))
        if self.qa:
            if self.qa.failures:
                parts.append("QA-fail=" + "; ".join(c.message for c in self.qa.failures))
            if self.qa.warnings:
                parts.append("QA-warn=" + "; ".join(c.message for c in self.qa.warnings))
        return " | ".join(parts)


# --------------------------------------------------------------------------- #
# registry entry -> SiteConfig
# --------------------------------------------------------------------------- #


def site_config(entry: dict, out_dir: Path) -> SiteConfig:
    """Build the `SiteConfig` the rest of the pipeline runs on, from a registry row."""
    preset_name = entry.get("extentPreset", "standard")
    preset = EXTENT_PRESETS.get(preset_name)
    if preset is None:
        raise BuildSiteError(
            f"{entry['slug']}: unknown extent preset {preset_name!r}; "
            f"known presets are {sorted(EXTENT_PRESETS)}"
        )
    grids = preset["grids"]()
    return SiteConfig(
        id=entry["slug"],
        name=entry.get("name") or entry["slug"],
        center_e=float(entry["centerE"]),
        center_n=float(entry["centerN"]),
        core=grids["core"],
        context=grids["context"],
        source_resolution=preset["source_resolution"],
        # National band: a registry site can legitimately sit far above Uppland,
        # and its far rings can cover the fjäll (sites.NATIONAL_ELEVATION_RANGE).
        elevation_range=NATIONAL_ELEVATION_RANGE,
        # No hand-verified crown height exists for a registry site; the range
        # gate is what catches a vertical shift.
        center_height_range=None,
        raa={
            "lamningsnummer": entry.get("lamningsnummer", ""),
            "raaNummer": entry.get("raaNummer", ""),
            "kmrUuid": entry.get("uuid", ""),
            "fornsokUrl": entry.get("fornsokUrl", ""),
        },
        out_dir_override=out_dir,
        extent_preset=preset_name,
        county=entry.get("county", ""),
        from_registry=True,
    )


def load_site(slug: str, out_dir: Path, registry_path: Path = REGISTRY_PATH) -> SiteConfig:
    """Resolve a slug through the registry and register the config for every step."""
    try:
        entry = get_entry(slug, registry_path)
    except RegistryError as exc:
        raise BuildSiteError(str(exc)) from exc
    return register_site(site_config(entry, out_dir))


# --------------------------------------------------------------------------- #
# the build
# --------------------------------------------------------------------------- #


def _grid_counts(grids: dict) -> dict[str, tuple[int, int]]:
    return {name: (grid.filled_cells, grid.width * grid.height) for name, grid in grids.items()}


def build_grids_step(cfg: SiteConfig, force_download: bool, archive_cogs: bool) -> tuple[dict, dict, dict]:
    """Fetch, clip and write the §1 core/context grids. Returns (grids, meta, manifest)."""
    cache_path, source_meta = fetch_source_mosaic(cfg, force=force_download)
    source, source_transform, nodata = read_source_mosaic(cache_path)
    grids = build_grids(source, source_transform, nodata, cfg)

    for name, grid in grids.items():
        out_path = cfg.out_dir / grid.spec.path
        write_grid(out_path, grid)
        print(
            f"  {name}: {grid.width}x{grid.height} @ {grid.spec.resolution} m | "
            f"z {grid.min_elevation:.1f}..{grid.max_elevation:.1f} m | "
            f"filled {grid.filled_cells} | {out_path.stat().st_size / 1e6:.2f} MB"
        )
        if archive_cogs:
            # §1a: the archival tiled COG for GIS inspection, into data-cache/ —
            # never into the bundle.
            archive_dir = CACHE_DIR / "archive" / cfg.id
            write_grid(archive_dir / grid.spec.path, grid, layout=LAYOUT_COG)

    core = grids["core"]
    center = sample_nearest(core.heights_m(), core.transform, cfg.center_e, cfg.center_n)
    print(f"  center height: {center:.1f} m RH 2000")

    manifest = build_manifest(cfg, grids, source_meta)
    write_manifest(cfg.out_dir / "manifest.json", manifest)
    write_data_licenses(cfg.out_dir / "DATA-LICENSES.md", cfg, source_meta)
    return grids, source_meta, manifest


def drop_asset(manifest_path: Path, key: str) -> None:
    """Remove an `assets` entry whose file a failed step never wrote.

    A manifest that names a missing file is a promise the bundle cannot keep;
    "feature off" is the contract's own way of saying the same thing truthfully.
    """
    if not manifest_path.exists():
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("assets", {}).pop(key, None) is None:
        return
    # Written without `write_manifest`'s validation on purpose: this runs on the
    # failure path, and a validation error here would replace a clear "the KMR
    # fetch failed" with an obscure schema complaint about the manifest we were
    # in the middle of repairing. The QA gates validate the finished bundle, and
    # every later step re-validates anyway.
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"  dropped assets.{key} from the manifest — the step that writes it failed")


def render_site_thumbnail(cfg: SiteConfig, size: int = DEFAULT_SIZE) -> str:
    """Hillshade the site for the §4.4 contact sheet, tinting the modelled water.

    Rendered from the **context** grid, not the core one. At 320 px a 2 km window
    and a 4 km window draw a 300 m fort at much the same size — neither resolves a
    rampart — but the wider window shows the landform the fort sits in and, at a
    coastal site, the water. Water is the thing a sweep is actually looking for:
    at Broborg the 500 CE level leaves only 0.8 % of the *core* window wet (the
    fort is on a hill) against 2.2 % of the context window and the whole
    Långhundraleden inlet beyond it. It also means no resampling at all — the §7
    connect grid is already on this exact geometry.

    A tint that cannot be derived is dropped with a note, never faked: a thumbnail
    showing water nobody modelled would be the QA sweep lying to its reader.
    """
    context_dm, _transform, _bounds = read_grid(cfg.out_dir / cfg.context.path)
    heights = dequantize(context_dm, cfg.context.quant_scale)

    mask = None
    shoreline_path = cfg.out_dir / SHORELINE_PATH
    if shoreline_path.exists():
        try:
            table = json.loads(shoreline_path.read_text(encoding="utf-8"))
            level = float(interpolate_level(table["steps"], THUMBNAIL_YEAR_CE))
            connect_dm, _path = read_connect_grid(cfg.out_dir, context_dm)
            mask = water_mask_at(dequantize(connect_dm, cfg.context.quant_scale), level)
        except (KeyError, ValueError, OSError) as exc:
            print(f"  thumbnail water tint skipped: {type(exc).__name__}: {exc}")
            mask = None

    render_thumbnail(
        cfg.out_dir / THUMBNAIL_PATH, heights, cfg.context.resolution, size=size, water_mask=mask
    )
    return THUMBNAIL_PATH


def run(
    slug: str,
    out_dir: Path,
    registry_path: Path = REGISTRY_PATH,
    force_download: bool = False,
    skip_rings: bool = False,
    skip_water: bool = False,
    skip_rampart: bool = False,
    with_landcover: bool = False,
    archive_cogs: bool = False,
    thumbnail_size: int = DEFAULT_SIZE,
) -> BuildResult:
    """Build one registry site into `out_dir`. Never raises for a per-step failure."""
    cfg = load_site(slug, out_dir, registry_path)
    result = BuildResult(slug=slug, out_dir=out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(
        f"== {cfg.name} ({cfg.id}) — {cfg.county or 'county unknown'}, preset "
        f"{cfg.extent_preset}, center E {cfg.center_e:.0f} N {cfg.center_n:.0f}"
    )

    print("-- grids (fetch, clip, quantize)")
    try:
        grids, _meta, manifest = build_grids_step(cfg, force_download, archive_cogs)
        filled = _grid_counts(grids)
        result.steps.append(StepResult("grids", "ok"))
    except (FetchError, VerticalDatumError, ValueError, OSError) as exc:
        result.steps.append(StepResult("grids", "failed", f"{type(exc).__name__}: {exc}"))
        result.bytes_written = bundle_bytes(out_dir) if out_dir.exists() else 0
        return result

    # The KMR overlay comes before the rings and the rampart: both want the
    # site's own extent polygon out of it (the crown height and the crest
    # corridor). A site with no polygon still builds — those steps just skip.
    print("-- KMR sites overlay (contract §3)")
    try:
        fetch_sites_run(cfg.id)
        result.steps.append(StepResult("sites", "ok"))
    except (SitesError, OSError, RuntimeError) as exc:
        result.steps.append(StepResult("sites", "failed", f"{type(exc).__name__}: {exc}"))
        # `build_manifest` declared `assets.sites` optimistically. Leaving it
        # there would make the bundle claim a file it does not have, which is a
        # worse failure than the fetch itself: the app would report a broken
        # asset instead of the honest "this layer is off". The step failure is
        # what `check_steps` refuses to ship on.
        drop_asset(cfg.out_dir / "manifest.json", "sites")

    if skip_rings:
        result.steps.append(StepResult("rings", "skipped", "--skip-rings"))
    else:
        print("-- far-field rings (contract §11)")
        try:
            manifest = rings.run(cfg.id, force_download=force_download)
            result.steps.append(StepResult("rings", "ok"))
        except (RingsError, FetchError, VerticalDatumError, ValueError, OSError) as exc:
            result.steps.append(StepResult("rings", "failed", f"{type(exc).__name__}: {exc}"))

    coastal = False
    if skip_water:
        result.steps.append(StepResult("water", "skipped", "--skip-water"))
    else:
        print("-- water (contract §6/§7/§12)")
        try:
            manifest = water.run(cfg.id, force_download=force_download)
            coastal = "shoreline" in manifest.get("assets", {})
            result.steps.append(StepResult("water", "ok" if coastal else "skipped", "" if coastal else "no SGU coverage"))
        except ShorelineError as exc:
            # An inland site the shoreline model does not cover is the contract's
            # "missing asset = feature off", not a build failure.
            result.steps.append(StepResult("water", "skipped", str(exc)))
        except (FetchError, ValueError, OSError, SystemExit) as exc:
            result.steps.append(StepResult("water", "failed", f"{type(exc).__name__}: {exc}"))

    if skip_rampart:
        result.steps.append(StepResult("rampart", "skipped", "--skip-rampart"))
    else:
        print("-- rampart crest (contract §8, best effort)")
        try:
            rampart.run(cfg.id)
            result.steps.append(StepResult("rampart", "ok"))
        except RampartError as exc:
            # Expected across 1,300 heterogeneous sites — scale-out §4.3 makes
            # this best-effort on purpose. No asset means no palisade layer.
            result.steps.append(StepResult("rampart", "skipped", str(exc)))
        except (ValueError, OSError) as exc:
            result.steps.append(StepResult("rampart", "failed", f"{type(exc).__name__}: {exc}"))

    if with_landcover:
        print("-- land cover (contract §9/§10)")
        try:
            manifest = landcover.run(cfg.id, force_download=force_download)
            result.steps.append(StepResult("landcover", "ok"))
        except (LandcoverError, FetchError, ValueError, OSError) as exc:
            result.steps.append(StepResult("landcover", "skipped", f"{type(exc).__name__}: {exc}"))

    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))

    print("-- thumbnail")
    try:
        render_site_thumbnail(cfg, size=thumbnail_size)
        result.steps.append(StepResult("thumbnail", "ok"))
    except (ValueError, OSError) as exc:
        result.steps.append(StepResult("thumbnail", "failed", f"{type(exc).__name__}: {exc}"))

    print("-- QA gates (scale-out §4.4)")
    result.manifest = manifest
    result.qa = run_gates(
        slug, out_dir, manifest, cfg.elevation_range, filled, coastal, steps=result.steps
    )
    for check in result.qa.checks:
        print(f"  [{check.severity:4}] {check.id}: {check.message}")

    result.bytes_written = bundle_bytes(out_dir)
    (out_dir / BUILD_REPORT).write_text(
        json.dumps(result.as_json(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"== {result.summary()}")
    return result


def evict_scratch(out_dir: Path) -> None:
    """Delete a built bundle. Disk is a fixed allowance in a batch environment."""
    if out_dir.exists():
        shutil.rmtree(out_dir)


@click.command()
@click.option("--slug", required=True, help="Registry slug, e.g. l1943-7827.")
@click.option(
    "--out-dir",
    type=click.Path(path_type=Path),
    default=None,
    help="Bundle output directory [default: build/<slug>/ under the repo root].",
)
@click.option(
    "--registry",
    "registry_path",
    type=click.Path(path_type=Path),
    default=REGISTRY_PATH,
    show_default=True,
    help="registry.json to resolve the slug against.",
)
@click.option("--force-download", is_flag=True, help="Ignore the cached mosaics and SGU extract.")
@click.option("--skip-rings", is_flag=True, help="Leave the §11 ring ladder unbuilt.")
@click.option("--skip-water", is_flag=True, help="Leave the §6/§7/§12 water assets unbuilt.")
@click.option("--skip-rampart", is_flag=True, help="Leave the §8 crest derivation unrun.")
@click.option("--with-landcover", is_flag=True, help="Also build the §9/§10 land-cover pair.")
@click.option(
    "--archive-cogs",
    is_flag=True,
    help="Also write archival tiled COGs into data-cache/archive/<slug>/ (§1a).",
)
@click.option("--thumbnail-size", default=DEFAULT_SIZE, show_default=True, help="Thumbnail px per side.")
def cli(
    slug: str,
    out_dir: Path | None,
    registry_path: Path,
    force_download: bool,
    skip_rings: bool,
    skip_water: bool,
    skip_rampart: bool,
    with_landcover: bool,
    archive_cogs: bool,
    thumbnail_size: int,
) -> None:
    """Build one registry site end to end and run the QA gates.

    Exit code 0 = the bundle passed QA and may ship; 1 = it did not. Either way
    the reasons are in `build_report.json` inside the output directory.
    """
    from .sites import REPO_ROOT

    target = out_dir or (REPO_ROOT / "build" / slug)
    try:
        result = run(
            slug,
            target,
            registry_path=registry_path,
            force_download=force_download,
            skip_rings=skip_rings,
            skip_water=skip_water,
            skip_rampart=skip_rampart,
            with_landcover=with_landcover,
            archive_cogs=archive_cogs,
            thumbnail_size=thumbnail_size,
        )
    except BuildSiteError as exc:
        raise SystemExit(f"BUILD FAILED: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 — a batch must never lose the reason
        traceback.print_exc()
        raise SystemExit(f"BUILD FAILED ({type(exc).__name__}): {exc}") from exc

    if not result.shippable:
        raise SystemExit(1)


if __name__ == "__main__":
    sys.exit(cli())
