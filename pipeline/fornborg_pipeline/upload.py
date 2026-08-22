"""Sync a built bundle to the object host, and remember what happened (§3, §4).

    python3 -m fornborg_pipeline.upload --slug l1943-7827 --dir build/l1943-7827

Bundles live at `<base>/v1/<slug>/…` — the schema version in the *path*, so a
future breaking format change can coexist with already-deployed apps (§3).

Three properties a national batch needs:

  * **Idempotent.** Every object is compared by content hash before it is sent;
    an unchanged file costs one HEAD. Re-running a finished batch is cheap and
    safe, which is what makes "just run it again" the recovery procedure.
  * **Resumable.** A per-site state file records built / QA / uploaded, with the
    hash of every object as uploaded. A rerun skips a site whose local bundle
    still matches its recorded upload and moves on.
  * **Cache-correct.** Grids get a year and `immutable` (their content changes
    only when Lantmäteriet re-flies); the national index gets minutes, because
    it is the file that gains a site every time the batch finishes one.

Credentials come from the R2_* environment variables only, are passed straight
to the S3 client, and are never written to the state file, a log line or a
manifest. The public base URL is *configuration* (R2_PUBLIC_BASE_URL) rather
than a constant: it is expected to move to a custom domain.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import click

from .sites import CACHE_DIR

#: Path prefix for this contract generation (docs/national-scaleout.md §3).
BUNDLE_PREFIX = "v1"
#: Where per-site batch state lives. Gitignored with the rest of data-cache/.
STATE_DIR = CACHE_DIR / "batch-state"
#: The national site index (§6.1) — one object at the bundle root.
INDEX_KEY = f"{BUNDLE_PREFIX}/index.json"

#: Cache-Control by file kind. Grids are effectively immutable; the index is the
#: one object that changes every time a batch finishes a site.
CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
CACHE_SITE_JSON = "public, max-age=3600"
CACHE_INDEX = "public, max-age=300"

CONTENT_TYPES = {
    ".tif": "image/tiff",
    ".json": "application/json",
    ".png": "image/png",
    ".md": "text/markdown; charset=utf-8",
}

#: Files that never belong in a published bundle.
EXCLUDED_NAMES = frozenset({"build_report.json"})


class UploadError(RuntimeError):
    """The sync could not complete. Never raised for an unchanged object."""


# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class R2Config:
    """Everything the S3 client needs. `secret_access_key` never leaves this object."""

    account_id: str
    access_key_id: str
    secret_access_key: str
    bucket: str
    public_base_url: str

    @property
    def endpoint_url(self) -> str:
        return f"https://{self.account_id}.r2.cloudflarestorage.com"

    def public_url(self, key: str) -> str:
        return f"{self.public_base_url.rstrip('/')}/{key.lstrip('/')}"


def config_from_env(env: dict | None = None) -> R2Config:
    """Read the R2_* variables. Raises naming what is missing — never their values."""
    source = os.environ if env is None else env
    required = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
    missing = [name for name in required if not source.get(name)]
    if missing:
        raise UploadError(
            f"missing environment variable(s): {', '.join(missing)}. The pipeline reads "
            f"object-store credentials from the environment only, never from a file."
        )
    public = source.get("R2_PUBLIC_BASE_URL", "").strip()
    if not public:
        raise UploadError(
            "R2_PUBLIC_BASE_URL is not set. It is the base the app fetches bundles from "
            "(the r2.dev development URL today, a custom domain later), so it is "
            "configuration rather than a constant in the source."
        )
    return R2Config(
        account_id=source["R2_ACCOUNT_ID"],
        access_key_id=source["R2_ACCESS_KEY_ID"],
        secret_access_key=source["R2_SECRET_ACCESS_KEY"],
        bucket=source["R2_BUCKET"],
        public_base_url=public,
    )


def make_client(config: R2Config):
    """An S3 client pointed at R2. `boto3` is an optional dependency (`[upload]`)."""
    try:
        import boto3
        from botocore.config import Config as BotoConfig
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise UploadError(
            "boto3 is not installed; the upload step needs it "
            "(`python3 -m pip install -e 'pipeline[upload]'`)."
        ) from exc
    return boto3.client(
        "s3",
        endpoint_url=config.endpoint_url,
        aws_access_key_id=config.access_key_id,
        aws_secret_access_key=config.secret_access_key,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}),
    )


# --------------------------------------------------------------------------- #
# what to upload, and how to cache it
# --------------------------------------------------------------------------- #


def bundle_key(slug: str, name: str) -> str:
    return f"{BUNDLE_PREFIX}/{slug}/{name}"


def cache_control_for(name: str) -> str:
    """§3: long on grids, short on the index, an hour on per-site JSON.

    Per-site JSON sits in between on purpose. It is not immutable — a rebuild
    rewrites `manifest.json` — but it is also not the file a visitor's browser
    needs to re-check constantly, and a stale manifest pointing at a grid that
    still exists is harmless.
    """
    if name == "index.json":
        return CACHE_INDEX
    if Path(name).suffix in (".tif", ".png"):
        return CACHE_IMMUTABLE
    return CACHE_SITE_JSON


def content_type_for(name: str) -> str:
    return CONTENT_TYPES.get(Path(name).suffix, "application/octet-stream")


def file_md5(path: Path, chunk: int = 1 << 20) -> str:
    digest = hashlib.md5()  # noqa: S324 - matches the S3 ETag; not a security use
    with path.open("rb") as handle:
        while block := handle.read(chunk):
            digest.update(block)
    return digest.hexdigest()


def bundle_files(out_dir: Path) -> list[Path]:
    """Every file that belongs in the published bundle, sorted for stable logs."""
    return sorted(
        p
        for p in out_dir.iterdir()
        if p.is_file() and p.name not in EXCLUDED_NAMES and not p.name.startswith(".")
    )


def local_digest_map(out_dir: Path) -> dict[str, str]:
    return {path.name: file_md5(path) for path in bundle_files(out_dir)}


# --------------------------------------------------------------------------- #
# per-site state
# --------------------------------------------------------------------------- #


@dataclass
class SiteState:
    """Built / QA-passed / uploaded, with enough detail to resume from any of them."""

    slug: str
    built: bool = False
    qaPassed: bool = False
    uploaded: bool = False
    builtAt: str = ""
    uploadedAt: str = ""
    bundleBytes: int = 0
    #: file name -> md5, exactly as last uploaded. This is what makes a rerun
    #: skip a site: local digests equal to these means R2 already has this bundle.
    objects: dict[str, str] = field(default_factory=dict)
    qaSummary: str = ""
    lastError: str = ""

    @classmethod
    def path_for(cls, slug: str, state_dir: Path = STATE_DIR) -> Path:
        return state_dir / f"{slug}.json"

    @classmethod
    def load(cls, slug: str, state_dir: Path = STATE_DIR) -> SiteState:
        path = cls.path_for(slug, state_dir)
        if not path.exists():
            return cls(slug=slug)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            # A half-written state file must not wedge a batch; the worst case
            # is re-uploading a bundle, which the digest check makes cheap.
            return cls(slug=slug)
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in payload.items() if k in known})

    def save(self, state_dir: Path = STATE_DIR) -> Path:
        path = self.path_for(self.slug, state_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(asdict(self), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return path


def is_up_to_date(state: SiteState, out_dir: Path) -> bool:
    """True when R2 already holds exactly this bundle, per our own record.

    Deliberately a *local* comparison: a batch of 25 sites should not need 250
    HEAD requests to decide it has nothing to do. `sync_bundle` still compares
    every object against the bucket when it does run, so the worst a stale state
    file costs is one extra pass.
    """
    if not (state.uploaded and state.objects):
        return False
    if not out_dir.is_dir():
        return False
    return local_digest_map(out_dir) == state.objects


# --------------------------------------------------------------------------- #
# the sync
# --------------------------------------------------------------------------- #


def remote_etag(client, bucket: str, key: str) -> str | None:
    """The object's ETag without quotes, or None when it is not there."""
    try:
        head = client.head_object(Bucket=bucket, Key=key)
    except Exception as exc:  # botocore raises ClientError; 404 is a normal answer
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if code in ("404", "NoSuchKey", "NotFound"):
            return None
        raise
    return str(head.get("ETag", "")).strip('"')


def put_object(client, bucket: str, key: str, path: Path) -> None:
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=path.read_bytes(),
        ContentType=content_type_for(path.name),
        CacheControl=cache_control_for(path.name),
    )


def sync_bundle(
    slug: str,
    out_dir: Path,
    config: R2Config,
    client=None,
    dry_run: bool = False,
) -> dict:
    """Upload every changed object under `v1/<slug>/`. Returns a summary dict.

    Change detection is the object's ETag, which for a single-part PUT is the
    content MD5 — every file in a bundle is a few MB, so nothing here is ever
    multipart. An object whose ETag already matches is left alone.
    """
    if not out_dir.is_dir():
        raise UploadError(f"{out_dir} is not a directory — build the site before uploading it")
    files = bundle_files(out_dir)
    if not files:
        raise UploadError(f"{out_dir} holds no bundle files")
    if client is None:
        client = make_client(config)

    uploaded: list[str] = []
    skipped: list[str] = []
    digests: dict[str, str] = {}
    sent_bytes = 0

    for path in files:
        key = bundle_key(slug, path.name)
        digest = file_md5(path)
        digests[path.name] = digest
        if remote_etag(client, config.bucket, key) == digest:
            skipped.append(path.name)
            continue
        if not dry_run:
            put_object(client, config.bucket, key, path)
        uploaded.append(path.name)
        sent_bytes += path.stat().st_size

    return {
        "slug": slug,
        "prefix": f"{BUNDLE_PREFIX}/{slug}/",
        "uploaded": uploaded,
        "skipped": skipped,
        "sentBytes": sent_bytes,
        "objects": digests,
        "publicUrl": config.public_url(bundle_key(slug, "manifest.json")),
        "dryRun": dry_run,
    }


def upload_index(index_path: Path, config: R2Config, client=None, dry_run: bool = False) -> str:
    """Publish the national `index.json` at the bundle root, with a short TTL."""
    if not index_path.is_file():
        raise UploadError(f"{index_path} does not exist")
    if client is None:
        client = make_client(config)
    if not dry_run:
        client.put_object(
            Bucket=config.bucket,
            Key=INDEX_KEY,
            Body=index_path.read_bytes(),
            ContentType="application/json",
            CacheControl=CACHE_INDEX,
        )
    return config.public_url(INDEX_KEY)


def record_build(
    slug: str,
    qa_passed: bool,
    qa_summary: str,
    bundle_bytes: int,
    state_dir: Path = STATE_DIR,
) -> SiteState:
    """Note that a build happened, whatever its verdict. Uploading is a later step."""
    state = SiteState.load(slug, state_dir)
    state.built = True
    state.qaPassed = qa_passed
    state.qaSummary = qa_summary
    state.builtAt = datetime.now(timezone.utc).isoformat(timespec="seconds")
    state.bundleBytes = bundle_bytes
    state.lastError = ""
    if not qa_passed:
        # A bundle that failed QA must never look uploaded, even if an earlier
        # run of the same slug did upload one.
        state.uploaded = False
    state.save(state_dir)
    return state


def record_upload(slug: str, summary: dict, state_dir: Path = STATE_DIR) -> SiteState:
    state = SiteState.load(slug, state_dir)
    state.uploaded = True
    state.uploadedAt = datetime.now(timezone.utc).isoformat(timespec="seconds")
    state.objects = dict(summary["objects"])
    state.lastError = ""
    state.save(state_dir)
    return state


def record_failure(slug: str, message: str, state_dir: Path = STATE_DIR) -> SiteState:
    state = SiteState.load(slug, state_dir)
    state.lastError = message
    state.save(state_dir)
    return state


@click.command()
@click.option("--slug", required=True, help="Registry slug whose bundle to sync.")
@click.option(
    "--dir",
    "out_dir",
    type=click.Path(path_type=Path),
    required=True,
    help="The built bundle directory.",
)
@click.option(
    "--state-dir",
    type=click.Path(path_type=Path),
    default=STATE_DIR,
    show_default=True,
    help="Where per-site batch state lives.",
)
@click.option("--dry-run", is_flag=True, help="Compare and report, but send nothing.")
@click.option("--force", is_flag=True, help="Ignore the local state and re-compare every object.")
def cli(slug: str, out_dir: Path, state_dir: Path, dry_run: bool, force: bool) -> None:
    """Sync one built bundle to the object host under v1/<slug>/."""
    try:
        config = config_from_env()
    except UploadError as exc:
        raise SystemExit(f"UPLOAD FAILED: {exc}") from exc

    state = SiteState.load(slug, state_dir)
    if not force and is_up_to_date(state, out_dir):
        print(f"== {slug}: already uploaded and unchanged ({len(state.objects)} objects) — skipping")
        return

    try:
        summary = sync_bundle(slug, out_dir, config, dry_run=dry_run)
    except UploadError as exc:
        record_failure(slug, str(exc), state_dir)
        raise SystemExit(f"UPLOAD FAILED: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - the batch needs the reason recorded
        record_failure(slug, f"{type(exc).__name__}: {exc}", state_dir)
        raise SystemExit(f"UPLOAD FAILED ({type(exc).__name__}): {exc}") from exc

    for name in summary["uploaded"]:
        print(f"  put  {bundle_key(slug, name)}  [{cache_control_for(name)}]")
    for name in summary["skipped"]:
        print(f"  skip {bundle_key(slug, name)} (unchanged)")
    if not dry_run:
        record_upload(slug, summary, state_dir)
    print(
        f"== {slug}: {len(summary['uploaded'])} uploaded, {len(summary['skipped'])} unchanged, "
        f"{summary['sentBytes'] / 1e6:.2f} MB sent" + (" (dry run)" if dry_run else "")
    )
    print(f"   {summary['publicUrl']}")


if __name__ == "__main__":
    sys.exit(cli())
