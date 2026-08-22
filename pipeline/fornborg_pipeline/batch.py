"""One site, built and published — the unit a batch runner invokes (scale-out §4, §7).

    python3 -m fornborg_pipeline.batch --slug l1943-7827

Build -> QA -> upload -> record -> evict, with the state file deciding what can be
skipped. This is deliberately a *single command with a one-line verdict*, because
the thing calling it in a national run is a fleet of small agents whose whole job
is to run it and relay what it said. Everything a caller needs is on the last
line and in the exit code; everything else is in `build_report.json` and the
per-site state file.

Exit codes: 0 = the bundle is on the object host and passed QA; 1 = it is not,
and the reason is in the summary. Nothing here retries a failed site — diagnosis
belongs to whoever reads the report, not to a runner that would just fail again.

Also here, because they are aggregate views over the same state:

  * `--index`         — the national `index.json` (§6.1) the site picker loads;
  * `--contact-sheet` — the §4.4 thumbnail page that makes a QA sweep a
                        half-hour job instead of an impossible one.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from html import escape
from pathlib import Path

import click

from .build_site import BUILD_REPORT, BuildSiteError
from .build_site import run as build_site_run
from .registry import REGISTRY_PATH, RegistryError, load_registry
from .sites import CACHE_DIR, REPO_ROOT
from .thumbnail import THUMBNAIL_PATH
from .upload import (
    STATE_DIR,
    SiteState,
    UploadError,
    config_from_env,
    is_up_to_date,
    record_build,
    record_failure,
    record_upload,
    sync_bundle,
    upload_index,
)

#: Where a batch builds before uploading. Outside `app/public/data/`: the repo
#: keeps only `testsite` and `broborg` (scale-out §3).
DEFAULT_BUILD_ROOT = REPO_ROOT / "build"
INDEX_SCHEMA_VERSION = 1
INDEX_NAME = "index.json"
CONTACT_SHEET_NAME = "contact-sheet.html"


def site_cache_files(slug: str) -> list[Path]:
    """The per-site DEM mosaics `fetch_dem` cached for this slug.

    They are the large, regenerable part of `data-cache/`: a standard site's
    source mosaic plus up to five ring mosaics. Evicting them after a successful
    upload is what keeps a national run inside a fixed disk allowance — the
    published bundle is already safe on the object host by then.
    """
    return sorted(CACHE_DIR.glob(f"{slug}_dem_*"))


def evict_site_cache(slug: str) -> int:
    """Delete this site's cached mosaics. Returns the bytes reclaimed."""
    freed = 0
    for path in site_cache_files(slug):
        try:
            freed += path.stat().st_size
            path.unlink()
        except OSError:
            continue
    return freed


def cache_bytes() -> int:
    return sum(p.stat().st_size for p in CACHE_DIR.glob("*_dem_*") if p.is_file())


# --------------------------------------------------------------------------- #
# one site
# --------------------------------------------------------------------------- #


def run_site(
    slug: str,
    build_root: Path = DEFAULT_BUILD_ROOT,
    registry_path: Path = REGISTRY_PATH,
    state_dir: Path = STATE_DIR,
    upload: bool = True,
    evict: bool = True,
    force: bool = False,
    dry_run: bool = False,
    **build_kwargs,
) -> tuple[bool, str]:
    """Build and publish one site. Returns (ok, one-line summary). Never raises."""
    out_dir = build_root / slug
    state = SiteState.load(slug, state_dir)

    if not force and state.uploaded and state.qaPassed and is_up_to_date(state, out_dir):
        return True, f"{slug}: SKIPPED (already uploaded, {len(state.objects)} objects unchanged)"
    if not force and state.uploaded and state.qaPassed and not out_dir.exists():
        # The scratch was evicted after a successful upload — that is the normal
        # finished state, not a reason to rebuild.
        return True, f"{slug}: SKIPPED (already uploaded, scratch evicted)"

    try:
        result = build_site_run(slug, out_dir, registry_path=registry_path, **build_kwargs)
    except BuildSiteError as exc:
        record_failure(slug, str(exc), state_dir)
        return False, f"{slug}: FAILED (build) {exc}"
    except Exception as exc:  # noqa: BLE001 - a runner must report, not crash
        record_failure(slug, f"{type(exc).__name__}: {exc}", state_dir)
        return False, f"{slug}: FAILED (build) {type(exc).__name__}: {exc}"

    qa_summary = result.qa.summary() if result.qa else "no QA report"
    record_build(slug, result.shippable, qa_summary, result.bytes_written, state_dir)

    if not result.shippable:
        return False, result.summary()
    if not upload:
        return True, result.summary() + " | upload skipped"

    try:
        config = config_from_env()
        summary = sync_bundle(slug, out_dir, config, dry_run=dry_run)
    except UploadError as exc:
        record_failure(slug, str(exc), state_dir)
        return False, result.summary() + f" | UPLOAD FAILED: {exc}"
    except Exception as exc:  # noqa: BLE001
        record_failure(slug, f"{type(exc).__name__}: {exc}", state_dir)
        return False, result.summary() + f" | UPLOAD FAILED ({type(exc).__name__}): {exc}"

    if not dry_run:
        record_upload(slug, summary, state_dir)

    line = (
        result.summary()
        + f" | uploaded {len(summary['uploaded'])}, unchanged {len(summary['skipped'])}"
        + (" (dry run)" if dry_run else "")
    )
    if evict and not dry_run:
        # Order matters: the bundle is on the object host before anything local
        # is deleted, and the build report is copied out first so a later sweep
        # can still see why a site looks the way it does.
        reports = state_dir / "reports"
        reports.mkdir(parents=True, exist_ok=True)
        report_src = out_dir / BUILD_REPORT
        if report_src.exists():
            (reports / f"{slug}.json").write_text(report_src.read_text(encoding="utf-8"), encoding="utf-8")
        thumb = out_dir / THUMBNAIL_PATH
        if thumb.exists():
            thumbs = state_dir / "thumbnails"
            thumbs.mkdir(parents=True, exist_ok=True)
            (thumbs / f"{slug}.png").write_bytes(thumb.read_bytes())
        freed = evict_site_cache(slug)
        from .build_site import evict_scratch

        evict_scratch(out_dir)
        line += f" | evicted scratch + {freed / 1e6:.0f} MB of cached mosaics"
    return True, line


# --------------------------------------------------------------------------- #
# the national index (§6.1)
# --------------------------------------------------------------------------- #


def index_entry(entry: dict, manifest: dict, state: SiteState) -> dict:
    """One `index.json` row: what the picker needs, and nothing it does not."""
    assets = manifest.get("assets", {})
    rings = manifest.get("grids", {}).get("rings") or []
    return {
        "slug": entry["slug"],
        "name": entry.get("name") or entry["slug"],
        "lamningsnummer": entry.get("lamningsnummer", ""),
        "county": entry.get("county", ""),
        "kommun": entry.get("kommun", ""),
        # SWEREF for the picker's projected dot map, WGS84 for deep links to
        # anything that speaks lat/lon. The app does no projection math (§0).
        "centerE": entry["centerE"],
        "centerN": entry["centerN"],
        "antikvariskBedomning": entry.get("antikvariskBedomning", ""),
        "extentPreset": entry.get("extentPreset", "standard"),
        "bundle": f"{entry['slug']}/",
        "thumbnail": f"{entry['slug']}/{THUMBNAIL_PATH}",
        "features": {
            "water": "shoreline" in assets,
            "palisade": "rampart" in assets,
            "landcover": "landcover" in assets,
            "rings": len(rings),
        },
        "horizonKm": (manifest.get("horizon") or {}).get("distanceKm"),
        "bytes": state.bundleBytes,
        "fornsokUrl": entry.get("fornsokUrl", ""),
    }


def build_index(
    registry_path: Path = REGISTRY_PATH,
    state_dir: Path = STATE_DIR,
    build_root: Path = DEFAULT_BUILD_ROOT,
) -> dict:
    """The national index over every site the state files say is published.

    A site appears only when it is *uploaded and QA-clean*: the index is what
    the picker offers people, and offering a bundle that is not there — or one
    that failed a gate — would be the app lying about its own dataset.
    """
    registry = load_registry(registry_path)
    by_slug = {site["slug"]: site for site in registry["sites"]}
    sites = []
    for path in sorted(state_dir.glob("*.json")):
        state = SiteState.load(path.stem, state_dir)
        if not (state.uploaded and state.qaPassed):
            continue
        entry = by_slug.get(state.slug)
        if entry is None:
            continue
        manifest = _manifest_for(state.slug, state_dir, build_root)
        if manifest is None:
            continue
        sites.append(index_entry(entry, manifest, state))

    sites.sort(key=lambda s: (s["county"], s["name"]))
    return {
        "schemaVersion": INDEX_SCHEMA_VERSION,
        "generated": date.today().isoformat(),
        "crs": {"horizontal": "EPSG:3006"},
        "registry": {
            "source": registry.get("source", {}).get("product", ""),
            "generated": registry.get("generated", ""),
            "totalRegistered": registry.get("stats", {}).get("count", 0),
        },
        "count": len(sites),
        "sites": sites,
    }


def _manifest_for(slug: str, state_dir: Path, build_root: Path) -> dict | None:
    """The site's manifest, from the scratch build or the archived build report."""
    live = build_root / slug / "manifest.json"
    if live.exists():
        return json.loads(live.read_text(encoding="utf-8"))
    archived = state_dir / "reports" / f"{slug}.json"
    if archived.exists():
        payload = json.loads(archived.read_text(encoding="utf-8"))
        return payload.get("manifestSummary") or _manifest_from_report(payload)
    return None


def _manifest_from_report(report: dict) -> dict | None:
    """Reconstruct the little of a manifest the index needs, from a QA report.

    After a scratch eviction the manifest itself is only on the object host, but
    the QA report kept the facts the index quotes — which assets shipped and how
    deep the ladder went. Anything it cannot recover comes back as absent, which
    the picker reads as "feature off", never as a false claim.
    """
    qa = report.get("qa") or {}
    checks = {c["id"]: c for c in qa.get("checks", [])}
    ladder = checks.get("ladder", {}).get("detail", {}) or {}
    water = checks.get("water-pair", {}).get("message", "")
    assets = {}
    if "shoreline" in water:
        assets["shoreline"] = "shoreline.json"
    steps = {s["name"]: s["status"] for s in report.get("steps", [])}
    if steps.get("rampart") == "ok":
        assets["rampart"] = "rampart.json"
    if steps.get("landcover") == "ok":
        assets["landcover"] = "landcover.tif"
    rings = [{}] * int(ladder.get("ringCount", 0) or 0)
    return {
        "assets": assets,
        "grids": {"rings": rings},
        "horizon": {"distanceKm": ladder.get("distanceKm")} if ladder.get("distanceKm") else {},
    }


def write_index(path: Path, index: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# the QA contact sheet (§4.4)
# --------------------------------------------------------------------------- #


def thumbnail_src(site: dict, sheet_dir: Path, state_dir: Path, public_base: str) -> str:
    """Where the sheet should load this site's thumbnail from.

    The local archive first (`state_dir/thumbnails/<slug>.png`, kept when the
    scratch bundle is evicted), so a QA sweep works offline and spends no object
    -host requests; the published URL only when there is no local copy.
    """
    local = state_dir / "thumbnails" / f"{site['slug']}.png"
    if local.exists():
        return os.path.relpath(local, sheet_dir)
    return f"{public_base.rstrip('/')}/{site['thumbnail']}" if public_base else site["thumbnail"]


def contact_sheet_html(index: dict, sources: dict[str, str]) -> str:
    """A plain HTML page of every built site's thumbnail, verdict and features.

    No framework, no build step: it is a QA instrument, opened from disk, and it
    has to keep working years after whatever bundler was fashionable this week.
    `sources` maps slug -> image URL (see `thumbnail_src`).
    """
    cells = []
    for site in index["sites"]:
        features = site["features"]
        badges = [
            f"{features['rings']} rings" if features["rings"] else "no rings",
            "water" if features["water"] else "inland",
        ]
        if features["palisade"]:
            badges.append("palisade")
        if site.get("extentPreset") == "large":
            badges.append("large preset")
        horizon = f"{site['horizonKm']:.0f} km horizon" if site.get("horizonKm") else ""
        cells.append(
            f"""    <figure>
      <img loading="lazy" src="{escape(sources.get(site['slug'], site['thumbnail']))}" alt="Hillshade of {escape(site['name'])}">
      <figcaption>
        <strong>{escape(site['name'])}</strong>
        <span class="meta">{escape(site['lamningsnummer'])} &middot; {escape(site['county'])}</span>
        <span class="meta">{escape(site.get('antikvariskBedomning', ''))}</span>
        <span class="badges">{escape(' &middot; '.join(badges))}</span>
        <span class="meta">{escape(horizon)} &middot; {site['bytes'] / 1e6:.1f} MB</span>
      </figcaption>
    </figure>"""
        )
    body = "\n".join(cells)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fornborg QA contact sheet — {index['count']} sites</title>
<style>
  body {{ font: 14px/1.4 system-ui, sans-serif; margin: 2rem; background: #14161a; color: #e7e9ee; }}
  h1 {{ font-size: 1.2rem; font-weight: 600; }}
  p.lead {{ color: #9aa3b2; max-width: 60ch; }}
  .sheet {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1.25rem; }}
  figure {{ margin: 0; background: #1c1f26; border-radius: 6px; overflow: hidden; }}
  img {{ width: 100%; display: block; background: #0d0f12; aspect-ratio: 1; object-fit: cover; }}
  figcaption {{ padding: .6rem .7rem; display: flex; flex-direction: column; gap: .15rem; }}
  .meta {{ color: #9aa3b2; font-size: 12px; }}
  .badges {{ color: #7fb2ff; font-size: 12px; }}
</style>
</head>
<body>
<h1>Fornborg QA contact sheet — {index['count']} of {index['registry']['totalRegistered']} registered sites</h1>
<p class="lead">
  Every published bundle, hillshaded from its own core grid; modelled paleo-water at
  500 CE is tinted. Sweep for terrain that looks wrong — a flat horizon, a hole, water
  where there should be none. Sites that failed a QA gate are not here: they were never
  published. Generated {escape(index['generated'])}.
</p>
<div class="sheet">
{body}
</div>
</body>
</html>
"""


def write_contact_sheet(
    path: Path, index: dict, state_dir: Path = STATE_DIR, public_base: str = ""
) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    sources = {
        site["slug"]: thumbnail_src(site, path.parent, state_dir, public_base)
        for site in index["sites"]
    }
    path.write_text(contact_sheet_html(index, sources), encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


@click.command()
@click.option("--slug", default=None, help="Build and publish this registry site.")
@click.option("--index", "do_index", is_flag=True, help="Rebuild (and upload) index.json.")
@click.option("--contact-sheet", "do_sheet", is_flag=True, help="Write the QA contact sheet.")
@click.option(
    "--build-root",
    type=click.Path(path_type=Path),
    default=DEFAULT_BUILD_ROOT,
    show_default=True,
    help="Where bundles are built before upload.",
)
@click.option(
    "--state-dir", type=click.Path(path_type=Path), default=STATE_DIR, show_default=True
)
@click.option(
    "--registry", "registry_path", type=click.Path(path_type=Path), default=REGISTRY_PATH
)
@click.option("--no-upload", is_flag=True, help="Build and QA only; publish nothing.")
@click.option("--no-evict", is_flag=True, help="Keep the scratch bundle and cached mosaics.")
@click.option("--force", is_flag=True, help="Rebuild even if the state says it is published.")
@click.option("--dry-run", is_flag=True, help="Do everything except send bytes.")
@click.option("--force-download", is_flag=True, help="Ignore cached mosaics and the SGU extract.")
@click.option("--with-landcover", is_flag=True, help="Also build the §9/§10 land-cover pair.")
def cli(
    slug: str | None,
    do_index: bool,
    do_sheet: bool,
    build_root: Path,
    state_dir: Path,
    registry_path: Path,
    no_upload: bool,
    no_evict: bool,
    force: bool,
    dry_run: bool,
    force_download: bool,
    with_landcover: bool,
) -> None:
    """Build, QA and publish one site — or rebuild the index / contact sheet."""
    if not (slug or do_index or do_sheet):
        raise SystemExit("nothing to do: pass --slug, --index or --contact-sheet")

    ok = True
    if slug:
        ok, summary = run_site(
            slug,
            build_root=build_root,
            registry_path=registry_path,
            state_dir=state_dir,
            upload=not no_upload,
            evict=not no_evict,
            force=force,
            dry_run=dry_run,
            force_download=force_download,
            with_landcover=with_landcover,
        )
        print(f"== {summary}")

    if do_index:
        try:
            index = build_index(registry_path, state_dir, build_root)
        except RegistryError as exc:
            raise SystemExit(f"INDEX FAILED: {exc}") from exc
        path = write_index(build_root / INDEX_NAME, index)
        print(f"== index: {index['count']} published sites -> {path}")
        if not no_upload:
            try:
                url = upload_index(path, config_from_env(), dry_run=dry_run)
                print(f"   {url}")
            except UploadError as exc:
                raise SystemExit(f"INDEX UPLOAD FAILED: {exc}") from exc

    if do_sheet:
        index = build_index(registry_path, state_dir, build_root)
        # Thumbnails come from the local archive where one exists, so the sheet
        # works offline and spends no object-host requests on a QA sweep.
        public_base = ""
        try:
            public_base = config_from_env().public_url("v1/")
        except UploadError:
            pass  # no credentials here: local thumbnails only, which is the normal case
        sheet = write_contact_sheet(
            build_root / CONTACT_SHEET_NAME, index, state_dir=state_dir, public_base=public_base
        )
        print(f"== contact sheet: {index['count']} sites -> {sheet}")

    if not ok:
        raise SystemExit(1)


if __name__ == "__main__":
    sys.exit(cli())
