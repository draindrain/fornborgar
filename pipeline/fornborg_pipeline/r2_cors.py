"""Read and apply the bucket's CORS policy (docs/national-scaleout.md §3).

    python3 -m fornborg_pipeline.r2_cors           # show live policy + diff
    python3 -m fornborg_pipeline.r2_cors --apply   # push pipeline/r2-cors.json

The app fetches every bundle cross-origin, so the browser will only hand the
bytes to it when the bucket's allowlist names the app's origin. Move the app to
a new hostname and nothing about the data changes — but every fetch starts
failing at the network layer, before any status code exists to report. This
command exists so that recovery is one line rather than a dashboard hunt, and so
the allowlist is reviewable in the same commit as the domain that needs it.

Credentials come from the same R2_* environment variables the upload step reads
and are never written anywhere.
"""

from __future__ import annotations

import json
from pathlib import Path

import click

from .upload import UploadError, config_from_env, make_client

#: The committed policy. Non-secret, and coupled to the app's origin, so it is
#: version-controlled next to the public base URL it complements.
CORS_PATH = Path(__file__).resolve().parents[1] / "r2-cors.json"


def load_rules(path: Path | None = None) -> list[dict]:
    """The committed rules, in the boto3 shape (`AllowedOrigins`, …).

    The file is written in the lowerCamelCase the rest of this repo's JSON uses;
    boto3 wants the S3 capitalisation. Translating here keeps exactly one
    spelling in the file a human edits.
    """
    path = path or CORS_PATH
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise UploadError(f"could not read {path}: {exc}") from exc

    rules = document.get("corsRules")
    if not isinstance(rules, list) or not rules:
        raise UploadError(f"{path.name} has no `corsRules` array.")
    return [_to_boto(rule, path.name) for rule in rules]


_KEYS = {
    "allowedOrigins": "AllowedOrigins",
    "allowedMethods": "AllowedMethods",
    "allowedHeaders": "AllowedHeaders",
    "exposeHeaders": "ExposeHeaders",
    "maxAgeSeconds": "MaxAgeSeconds",
}


def _to_boto(rule: dict, filename: str) -> dict:
    unknown = sorted(set(rule) - set(_KEYS))
    if unknown:
        raise UploadError(f"{filename}: unknown CORS rule key(s) {', '.join(unknown)}.")
    if not rule.get("allowedOrigins"):
        raise UploadError(f"{filename}: a CORS rule needs at least one `allowedOrigins` entry.")
    if not rule.get("allowedMethods"):
        raise UploadError(f"{filename}: a CORS rule needs at least one `allowedMethods` entry.")
    return {_KEYS[key]: value for key, value in rule.items()}


def current_rules(client, bucket: str) -> list[dict]:
    """The live rules, or `[]` when the bucket has no CORS policy at all.

    "No policy" is the state a fresh bucket is in and the state that makes the
    app fail, so it is an answer to report, not an error to raise.
    """
    try:
        response = client.get_bucket_cors(Bucket=bucket)
    except Exception as exc:  # boto3 raises ClientError; NoSuchCORSConfiguration is normal
        if "NoSuchCORSConfiguration" in str(exc) or "NoSuchCORSConfig" in str(exc):
            return []
        raise
    return list(response.get("CORSRules", []))


def origins_missing(live: list[dict], wanted: list[dict]) -> list[str]:
    """Origins the committed policy allows that the live policy does not.

    This is the check that matters after a domain move: the live policy is not
    empty and not obviously broken, it simply does not name where the app is
    served from any more.
    """
    have = {origin for rule in live for origin in rule.get("AllowedOrigins", [])}
    if "*" in have:
        return []
    want = [origin for rule in wanted for origin in rule.get("AllowedOrigins", [])]
    return [origin for origin in want if origin not in have]


def apply_rules(client, bucket: str, rules: list[dict]) -> None:
    client.put_bucket_cors(Bucket=bucket, CORSConfiguration={"CORSRules": rules})


@click.command()
@click.option("--apply", "do_apply", is_flag=True, help="Write the committed policy to the bucket.")
@click.option(
    "--path",
    "path",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=None,
    help=f"Policy file to read (default {CORS_PATH.name}).",
)
def cli(do_apply: bool, path: Path | None) -> None:
    """Show or apply the bucket CORS policy."""
    try:
        wanted = load_rules(path)
        config = config_from_env()
        client = make_client(config)
        live = current_rules(client, config.bucket)
    except UploadError as exc:
        raise SystemExit(f"r2-cors: {exc}") from exc

    click.echo(f"bucket:   {config.bucket}")
    click.echo(f"live:     {json.dumps(live, sort_keys=True)}")
    click.echo(f"file:     {json.dumps(wanted, sort_keys=True)}")

    missing = origins_missing(live, wanted)
    if missing:
        click.echo(f"MISSING:  {', '.join(missing)} — the app's fetches from these origins fail.")
    else:
        click.echo("origins:  every origin in the file is already allowed.")

    if not do_apply:
        if missing:
            click.echo("Run again with --apply to push the committed policy.")
        return

    apply_rules(client, config.bucket, wanted)
    click.echo(f"applied {len(wanted)} rule(s) to {config.bucket}.")


if __name__ == "__main__":  # pragma: no cover
    cli()
