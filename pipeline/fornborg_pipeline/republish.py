"""Regenerate the §14 reconstruction asset for an *already published* bundle.

    python3 -m fornborg_pipeline.republish --dry-run            # plan all pilots
    python3 -m fornborg_pipeline.republish --slug l1957-426 --upload

26 of the 27 published pilot bundles were built before contract v1.7 and carry no
`assets.reconstruction`, so the app has nothing to declare a reconstruction from
and correctly withholds the Reconstruction button. This module regenerates that
asset — plus the v1.8/§15 `interior` block the parser now produces — from each
bundle's **own published `sites.json`**, and can upload the two changed JSON
objects back. Nothing else in a bundle is read, written, or touched.

Why this exists instead of `reconstruct.run()`
----------------------------------------------
`run()` resolves its slug through `sites.get_site()`, which knows only the
hand-curated `SITES` dict — Broborg and the test site. A pilot slug such as
`l1957-426` is a *registry* site and is not in it, so `run()` cannot be pointed at
one at all. This module drives the pure functions directly:
`build_document()` → `write_reconstruction()` (which runs `validate_document()`
and `validate_interior()`) → `add_reconstruction_asset()` → `write_manifest()`
(which runs `validate_manifest()`), plus an explicit second `validate_manifest()`.

Two things that will bite anyone writing this a second time
-----------------------------------------------------------
**The site's config must be registered before anything validates.**
`manifest._band_for()` resolves the height band by looking `manifest.site.id` up
in the in-process `SITES` dict, and falls back to `DEFAULT_ELEVATION_BAND` —
*Broborg's* `[-10, 200]` — for a slug it does not know. Real Swedish terrain
leaves that band immediately (a Västernorrland ring at 342 m, a Skåne one at
-58 m), so 15 of the 26 pilots fail validation for a reason that is about
Broborg, not about them. `prepare()` therefore registers each site through
`build_site.load_site()`, which gives it `sites.NATIONAL_ELEVATION_RANGE`, exactly
as a batch build does. The fix is **registration, never skipping validation**: a
driver that validated nothing would publish 26 manifests no one checked, which is
worse than the missing button it set out to repair.

**Broborg is published twice**, as `v1/broborg/` (what a bare visit loads,
`DEFAULT_SITE_ID`) and `v1/l1943-7827/` (the pilot rebuild the picker links to).
They are different vintages of everything except the register records. Neither
stands in for the other; this module only ever touches the slug it is given.

Reads go over the public base URL (`pipeline/r2-config.json`) and need no
credentials. Writes go through `upload.py`'s own `put_object` /
`content_type_for` / `cache_control_for`, so the headers match the rest of the
bundle, and are refused for any object name outside `UPLOADED_NAMES` — no TIFFs,
no `index.json`, no deletions, ever.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import click

from .manifest import (
    add_reconstruction_asset,
    raa_attribution_date,
    set_raa_attribution,
    validate_manifest,
    write_manifest,
)
from .reconstruct import (
    DEFAULT_PARAMS,
    PROCESSING_STEP,
    RECONSTRUCTION_PATH,
    TransformParams,
    build_document,
    write_reconstruction,
)
from .registry import REGISTRY_PATH
from .upload import (
    BUNDLE_PREFIX,
    R2Config,
    UploadError,
    bundle_key,
    cache_control_for,
    content_type_for,
    file_md5,
    public_base_url_from_config,
    put_object,
    remote_etag,
)

#: The pilot list, so the driver's default set is the committed, auditable one.
PILOT_SITES_PATH = Path(__file__).resolve().parents[1] / "pilot-sites.json"

#: The only object names this module will ever write. A bundle also holds DEM
#: TIFFs, a thumbnail, land-cover rasters and `DATA-LICENSES.md`; none of them is
#: affected by adding a reconstruction, and re-uploading a 30 MB grid to fix a
#: 7 kB manifest is how a "small patch" becomes an outage.
UPLOADED_NAMES = ("manifest.json", "reconstruction.json")

MANIFEST_NAME = "manifest.json"
SITES_NAME = "sites.json"

#: A User-Agent is set explicitly on every read. The default `python-urllib/x.y`
#: is rejected with HTTP 403 both by r2.dev and by some egress proxies, which
#: reads exactly like "the bundle is not published" and is not. (The 2026-08-30
#: survey hit this and worked around it with `curl`; the header is the fix.)
USER_AGENT = "fornborg-pipeline/republish (+https://github.com/draindrain/fornborgar)"

FETCH_TIMEOUT_S = 60.0


class RepublishError(RuntimeError):
    """The regeneration could not be completed for this slug."""


# --------------------------------------------------------------------------- #
# reading what is already published
# --------------------------------------------------------------------------- #


def pilot_slugs(path: Path = PILOT_SITES_PATH) -> list[str]:
    """Every slug in the committed pilot list, in its published order."""
    data = json.loads(path.read_text(encoding="utf-8"))
    return [str(entry["slug"]) for entry in data["sites"]]


def public_url(slug: str, name: str, base: str | None = None) -> str:
    """The public read URL of one object in one published bundle."""
    root = (base or public_base_url_from_config()).rstrip("/")
    if not root:
        raise RepublishError(
            "no public base URL: give pipeline/r2-config.json a `publicBaseUrl`, or pass "
            "--base. It is the base the app itself fetches bundles from."
        )
    return f"{root}/{bundle_key(slug, name)}"


def fetch_json(url: str, timeout: float = FETCH_TIMEOUT_S) -> dict:
    """GET one published JSON object. Read-only, unauthenticated, no credentials."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            body = response.read()
    except urllib.error.HTTPError as exc:
        raise RepublishError(f"{url}: HTTP {exc.code}") from exc
    except OSError as exc:
        raise RepublishError(f"{url}: {exc}") from exc
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RepublishError(f"{url}: not JSON ({exc})") from exc


def fetch_published_bundle(
    slug: str,
    base: str | None = None,
    fetch: Callable[[str], dict] = fetch_json,
) -> tuple[dict, dict, dict | None]:
    """`(manifest, sites, reconstruction)` as currently published for `slug`.

    Generating from the *published* `sites.json` rather than from anything in the
    working tree is the point: the reconstruction has to join by `id` to the
    records the app will actually load, and a bundle published in August is not
    obliged to match a registry extract made today.

    The third element is `None` for the 26 bundles that declare no §14 asset. For
    one that does, it is fetched too, so "would this upload change anything?" is
    *measured* against the published file rather than assumed.
    """
    manifest = fetch(public_url(slug, MANIFEST_NAME, base))
    sites = fetch(public_url(slug, SITES_NAME, base))
    declared = manifest.get("assets", {}).get("reconstruction")
    reconstruction = fetch(public_url(slug, declared, base)) if declared else None
    return manifest, sites, reconstruction


# --------------------------------------------------------------------------- #
# generating, validating
# --------------------------------------------------------------------------- #


@dataclass
class Prepared:
    """One slug's regenerated pair, on disk and validated. Nothing uploaded yet."""

    slug: str
    out_dir: Path
    document: dict
    manifest: dict
    #: What `set_raa_attribution` did, and the dates on either side of it.
    attribution: dict = field(default_factory=dict)
    #: Object name -> what the published bundle already holds ("" = not published).
    published_digests: dict[str, str] = field(default_factory=dict)
    #: Object name -> md5 of the regenerated file.
    local_digests: dict[str, str] = field(default_factory=dict)
    #: True when the published bundle already declared `assets.reconstruction`.
    had_reconstruction: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def paths(self) -> dict[str, Path]:
        return {name: self.out_dir / name for name in UPLOADED_NAMES}

    @property
    def changed(self) -> list[str]:
        """The object names whose bytes differ from what is published."""
        return [
            name
            for name in UPLOADED_NAMES
            if self.local_digests.get(name) != self.published_digests.get(name)
        ]

    @property
    def keys(self) -> dict[str, str]:
        return {name: bundle_key(self.slug, name) for name in UPLOADED_NAMES}

    def as_json(self) -> dict:
        coverage = self.document["coverage"]
        interior = self.document.get("interior")
        return {
            "slug": self.slug,
            "hadReconstruction": self.had_reconstruction,
            "attribution": dict(self.attribution),
            "coverage": {
                "records": coverage["records"],
                "reconstructed": coverage["reconstructed"],
                "unmappedTypes": coverage["unmappedTypes"],
                "sampledMonuments": coverage["sampledMonuments"],
                "byArchetype": coverage["byArchetype"],
                "interiorGate": coverage["interiorGate"],
                "interiorBuildingsStated": coverage["interiorBuildingsStated"],
            },
            "interior": (
                {
                    "tradition": interior["tradition"],
                    "state": interior["state"],
                    "gate": interior["evidence"]["gate"],
                    "channels": interior["evidence"]["channels"],
                    "buildings": (
                        None
                        if not interior.get("buildings")
                        else {
                            "count": interior["buildings"]["count"],
                            "countStated": interior["buildings"]["countStated"],
                            "layout": interior["buildings"]["layout"],
                        }
                    ),
                }
                if interior is not None
                else None
            ),
            "validated": True,
            "bytes": {name: path.stat().st_size for name, path in self.paths.items()},
            "localDigests": dict(self.local_digests),
            "publishedDigests": dict(self.published_digests),
            "changedKeys": [self.keys[name] for name in self.changed],
            "unchangedKeys": [
                self.keys[name] for name in UPLOADED_NAMES if name not in self.changed
            ],
            "notes": list(self.notes),
        }


def prepare(
    slug: str,
    out_root: Path,
    manifest: dict,
    sites: dict,
    params: TransformParams = DEFAULT_PARAMS,
    generated: str | None = None,
    registry_path: Path = REGISTRY_PATH,
    published_reconstruction: dict | None = None,
) -> Prepared:
    """Regenerate one slug's `reconstruction.json` + patched `manifest.json`.

    `manifest` and `sites` are that bundle's **published** objects; both are used
    read-only (the manifest is copied before it is patched). The pair is written
    under `out_root/<slug>/` and both files are validated on the way out —
    `write_reconstruction` runs the §14/§15 document checks, `write_manifest` runs
    `validate_manifest`, and it is run once more afterwards so the check is
    visible here rather than only as a side effect of writing.

    Nothing is uploaded. `upload_prepared()` is the only thing in this module that
    can write to the object store, and it is a separate call.
    """
    # Imported here rather than at module import: `build_site` pulls in the whole
    # raster stack, and the driver's read/report path does not need it. This one
    # call is also the fix for the height-band trap in this module's docstring —
    # `load_site` is what gives a registry slug `NATIONAL_ELEVATION_RANGE`
    # (build_site.site_config) and registers it for `manifest._band_for`.
    from .build_site import load_site

    out_dir = out_root / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    cfg = load_site(slug, out_dir, registry_path)

    published_id = manifest.get("site", {}).get("id")
    if published_id != slug:
        raise RepublishError(
            f"{slug}: the fetched manifest names site {published_id!r} — refusing to "
            f"generate a reconstruction for one bundle out of another's records."
        )

    notes: list[str] = []
    published_lamning = (manifest.get("site", {}).get("raa") or {}).get("lamningsnummer", "")
    fort_id = (cfg.raa or {}).get("lamningsnummer", "")
    if published_lamning and fort_id and published_lamning != fort_id:
        # §15.1 attributes the interior to the bundle's *own* fort. If the registry
        # and the published bundle disagree about which record that is, the
        # published bundle wins — it is what the app will join against.
        notes.append(
            f"registry lämningsnummer {fort_id} != published {published_lamning}; "
            f"used the published one for interior attribution (§15.1)"
        )
        fort_id = published_lamning

    document = build_document(
        sites,
        slug,
        params,
        generated=generated,
        county=cfg.county or "",
        kommun=cfg.kommun or "",
        fort_id=fort_id,
    )
    # Validates (§14 document invariants + §15 interior invariants) before writing.
    write_reconstruction(out_dir / RECONSTRUCTION_PATH, document)

    patched = json.loads(json.dumps(manifest))  # deep copy; the fetched dict stays as published
    had_reconstruction = "reconstruction" in patched.get("assets", {})
    add_reconstruction_asset(patched, RECONSTRUCTION_PATH, processing=[PROCESSING_STEP])

    before_date = raa_attribution_date(patched)
    fetched = str(sites.get("fetched", "") or "")
    action = set_raa_attribution(patched, fetched)
    attribution = {
        "action": action,
        "before": before_date,
        "sitesFetched": fetched,
        "after": raa_attribution_date(patched),
    }
    if action == "conflict":
        notes.append(
            f"KMR credit states {before_date!r} but sites.json was fetched {fetched!r}; "
            f"left as published rather than picking one"
        )
    elif action == "absent":
        notes.append("manifest carries no KMR credit line to date")

    # Validates. Then validate again, explicitly, so a future refactor of
    # `write_manifest` cannot quietly remove the only check on this path.
    write_manifest(out_dir / MANIFEST_NAME, patched)
    validate_manifest(patched)

    prepared = Prepared(
        slug=slug,
        out_dir=out_dir,
        document=document,
        manifest=patched,
        attribution=attribution,
        had_reconstruction=had_reconstruction,
        notes=notes,
    )
    prepared.local_digests = {
        name: file_md5(path) for name, path in prepared.paths.items()
    }
    prepared.published_digests = {
        MANIFEST_NAME: _digest_of(manifest, indent=2),
        # `None` for the 26 bundles with no §14 asset at all; "" can never equal an
        # md5, so such an object always counts as changed — as it must, it does not
        # exist yet.
        RECONSTRUCTION_PATH: (
            "" if published_reconstruction is None else _digest_of(published_reconstruction, indent=1)
        ),
    }
    return prepared


def _digest_of(document: dict, indent: int) -> str:
    """md5 of `document` re-serialised the way the pipeline writes it.

    Comparing re-serialisations rather than the fetched bytes keeps the
    "changed?" answer about content: both published files were written by
    `write_manifest` / `write_reconstruction`, so the formatting matches, and a
    byte difference that survives this is a real difference.
    """
    import hashlib

    body = json.dumps(document, indent=indent, ensure_ascii=False) + "\n"
    return hashlib.md5(body.encode("utf-8")).hexdigest()  # noqa: S324 - ETag match, not security


def prepare_slug(
    slug: str,
    out_root: Path,
    base: str | None = None,
    params: TransformParams = DEFAULT_PARAMS,
    generated: str | None = None,
    registry_path: Path = REGISTRY_PATH,
    fetch: Callable[[str], dict] = fetch_json,
) -> Prepared:
    """`fetch_published_bundle` + `prepare`: the whole read-and-generate half."""
    manifest, sites, reconstruction = fetch_published_bundle(slug, base=base, fetch=fetch)
    return prepare(
        slug,
        out_root,
        manifest,
        sites,
        params=params,
        generated=generated,
        registry_path=registry_path,
        published_reconstruction=reconstruction,
    )


# --------------------------------------------------------------------------- #
# the upload half — separate on purpose
# --------------------------------------------------------------------------- #


def upload_prepared(
    prepared: Prepared,
    config: R2Config,
    client=None,
    dry_run: bool = True,
    force: bool = False,
) -> dict:
    """Send the changed objects of one prepared slug. `dry_run` sends nothing.

    Deliberately not `upload.sync_bundle`: that syncs *every* file in a directory,
    and the whole safety property here is that a republish can only ever touch two
    named JSON objects in one slug's prefix. Anything else raises before a single
    request is made.

    Change detection is the remote ETag, which for these single-part PUTs is the
    object's MD5 — an object whose ETag already matches is left alone, so a rerun
    of a finished batch costs one HEAD per object and sends nothing.
    """
    for name in prepared.local_digests:
        if name not in UPLOADED_NAMES:
            raise UploadError(
                f"{name!r} is not a republishable object; this step writes only "
                f"{', '.join(UPLOADED_NAMES)} (no grids, no index.json, no deletions)"
            )
    if client is None:
        if dry_run:
            raise UploadError(
                "a dry run still needs a client to read remote ETags; pass one, or run "
                "with credentials so `upload.make_client` can build it"
            )
        from .upload import make_client

        client = make_client(config)

    planned: list[dict] = []
    for name in UPLOADED_NAMES:
        path = prepared.paths[name]
        key = bundle_key(prepared.slug, name)
        digest = prepared.local_digests[name]
        before = remote_etag(client, config.bucket, key)
        entry = {
            "key": key,
            "bytes": path.stat().st_size,
            "md5": digest,
            "etagBefore": before,
            "contentType": content_type_for(name),
            "cacheControl": cache_control_for(name),
            "action": "skipped-unchanged",
        }
        if before == digest and not force:
            planned.append(entry)
            continue
        if dry_run:
            entry["action"] = "would-put"
            planned.append(entry)
            continue
        put_object(client, config.bucket, key, path)
        after = remote_etag(client, config.bucket, key)
        entry["action"] = "put"
        entry["etagAfter"] = after
        if after != digest:
            raise UploadError(
                f"{key}: ETag after upload is {after!r}, expected {digest!r} — the object "
                f"in the bucket is not the file that was validated here"
            )
        planned.append(entry)

    return {
        "slug": prepared.slug,
        "prefix": f"{BUNDLE_PREFIX}/{prepared.slug}/",
        "dryRun": dry_run,
        "objects": planned,
        "publicUrl": config.public_url(bundle_key(prepared.slug, MANIFEST_NAME)),
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def _print_prepared(prepared: Prepared) -> None:
    coverage = prepared.document["coverage"]
    interior = prepared.document.get("interior")
    print(
        f"== {prepared.slug}: {coverage['reconstructed']}/{coverage['records']} records "
        f"-> archetypes ({coverage['unmappedTypes']} unmapped), "
        f"{coverage['sampledMonuments']} sampled"
    )
    if interior is not None:
        buildings = interior.get("buildings")
        print(
            f"   interior: tradition {interior['tradition']}, gate "
            f"{interior['evidence']['gate']}, state {interior['state']}"
            + (
                f", buildings {buildings['count']}"
                f" ({'stated' if buildings['countStated'] else 'default'}),"
                f" layout {buildings['layout']}"
                if buildings
                else ", no buildings"
            )
        )
    else:
        print("   interior: none (no fort record in this bundle's sites.json)")
    print(
        f"   attribution: {prepared.attribution['action']} "
        f"({prepared.attribution['before']!r} -> {prepared.attribution['after']!r}, "
        f"sites.json fetched {prepared.attribution['sitesFetched']!r})"
    )
    print("   validate_document() OK, validate_manifest() OK")
    for name in UPLOADED_NAMES:
        path = prepared.paths[name]
        mark = "CHANGED" if name in prepared.changed else "unchanged"
        print(
            f"   {bundle_key(prepared.slug, name):45} {path.stat().st_size:>8} B "
            f"md5={prepared.local_digests[name]} {mark}"
        )
    for note in prepared.notes:
        print(f"   [note] {note}")


@click.command()
@click.option("--slug", "slugs", multiple=True, help="Slug(s); default is the pilot list.")
@click.option(
    "--out-dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=Path("build/republish"),
    show_default=True,
    help="Where the regenerated pairs are written.",
)
@click.option("--base", default=None, help="Public base URL to read published bundles from.")
@click.option("--generated", default=None, help="Override the document's `generated` date.")
@click.option(
    "--json-out",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Write the machine-readable summary here.",
)
@click.option(
    "--upload/--dry-run",
    default=False,
    show_default=True,
    help="Upload the changed objects. Off by default: the default run writes nothing.",
)
@click.option(
    "--plan-upload",
    is_flag=True,
    default=False,
    help=(
        "Read the remote ETags and print what --upload would send, without sending it. "
        "Needs credentials; still writes nothing."
    ),
)
def cli(
    slugs: tuple[str, ...],
    out_dir: Path,
    base: str | None,
    generated: str | None,
    json_out: Path | None,
    upload: bool,
    plan_upload: bool,
) -> None:
    """Regenerate (and optionally republish) the §14 asset of published bundles."""
    if upload and plan_upload:
        raise SystemExit("--upload and --plan-upload are mutually exclusive.")
    targets = list(slugs) or pilot_slugs()
    config = None
    client = None
    if upload or plan_upload:
        # Only reached with --upload/--plan-upload. A default run never asks for
        # credentials, and never touches the object store at all.
        from .upload import config_from_env, make_client

        config = config_from_env()
        client = make_client(config)

    results: list[dict] = []
    failures: list[str] = []
    for slug in targets:
        try:
            prepared = prepare_slug(
                slug, out_dir, base=base, generated=generated
            )
        except Exception as exc:  # one bad slug must not lose the other 25
            print(f"== {slug}: FAILED — {exc}")
            failures.append(f"{slug}: {exc}")
            results.append({"slug": slug, "error": str(exc)})
            continue
        _print_prepared(prepared)
        entry = prepared.as_json()
        if config is not None:
            summary = upload_prepared(
                prepared, config, client=client, dry_run=not upload
            )
            entry["upload"] = summary
            for obj in summary["objects"]:
                print(f"   {obj['action']:20} {obj['key']}")
        results.append(entry)

    print(
        f"\n-- {len(results) - len(failures)}/{len(targets)} slugs prepared"
        + (f", {len(failures)} failed" if failures else "")
        + (" (nothing uploaded — dry run)" if not upload else "")
        + (" — remote ETags read, nothing sent" if plan_upload else "")
    )
    if json_out is not None:
        json_out.parent.mkdir(parents=True, exist_ok=True)
        json_out.write_text(
            json.dumps({"slugs": results}, ensure_ascii=False, indent=1) + "\n",
            encoding="utf-8",
        )
        print(f"   summary -> {json_out}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    cli()
