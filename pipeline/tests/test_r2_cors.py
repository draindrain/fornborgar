"""The bucket CORS policy (scale-out §3): what it must contain, and the check
that catches a domain move.

No network — the S3 client is a fake that records what it was asked to do. What
these tests protect is the one failure that has no diagnostic of its own: an
allowlist that names the origin the app *used* to be served from lets every
request fail in the browser before a status code exists, which reads to a
visitor as "Failed to fetch" and to a developer as nothing at all.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from fornborg_pipeline.r2_cors import (
    CORS_PATH,
    apply_rules,
    current_rules,
    load_rules,
    origins_missing,
)
from fornborg_pipeline.upload import UploadError


class FakeS3:
    """Just enough S3 to test the policy round-trip."""

    def __init__(self, rules: list[dict] | None = None):
        self.rules = rules
        self.puts: list[dict] = []

    def get_bucket_cors(self, Bucket: str):  # noqa: N803 - boto3's signature
        if self.rules is None:
            raise RuntimeError("An error occurred (NoSuchCORSConfiguration) when calling …")
        return {"CORSRules": self.rules}

    def put_bucket_cors(self, Bucket: str, CORSConfiguration: dict):  # noqa: N803
        self.puts.append(CORSConfiguration)
        self.rules = CORSConfiguration["CORSRules"]


def write_policy(tmp_path: Path, rules: list[dict]) -> Path:
    path = tmp_path / "cors.json"
    path.write_text(json.dumps({"corsRules": rules}), encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# the committed policy
# --------------------------------------------------------------------------- #


def test_committed_policy_allows_the_domain_the_app_is_served_from():
    origins = {origin for rule in load_rules() for origin in rule["AllowedOrigins"]}
    assert "https://fornborgar.drnz.se" in origins, (
        "app/public/CNAME serves the app from this hostname; a bucket that does not "
        "allow it refuses every bundle fetch"
    )


def test_committed_policy_exposes_the_headers_range_requests_need():
    # geotiff.js reads the grids with Range; without these exposed the decode
    # fails with nothing in the console to point at the cause.
    exposed = {header for rule in load_rules() for header in rule.get("ExposeHeaders", [])}
    assert {"content-length", "content-range", "etag", "accept-ranges"} <= exposed
    allowed = {header for rule in load_rules() for header in rule.get("AllowedHeaders", [])}
    assert "range" in allowed


def test_committed_policy_is_read_only():
    methods = {method for rule in load_rules() for method in rule["AllowedMethods"]}
    assert methods <= {"GET", "HEAD"}, "a public read bucket never needs a write method"


def test_the_cname_and_the_policy_agree():
    cname = (CORS_PATH.parents[1] / "app" / "public" / "CNAME").read_text(encoding="utf-8").strip()
    origins = {origin for rule in load_rules() for origin in rule["AllowedOrigins"]}
    assert f"https://{cname}" in origins


# --------------------------------------------------------------------------- #
# reading the file
# --------------------------------------------------------------------------- #


def test_lower_camel_case_keys_become_the_s3_spelling(tmp_path):
    path = write_policy(
        tmp_path,
        [{"allowedOrigins": ["https://x"], "allowedMethods": ["GET"], "maxAgeSeconds": 60}],
    )
    assert load_rules(path) == [
        {"AllowedOrigins": ["https://x"], "AllowedMethods": ["GET"], "MaxAgeSeconds": 60}
    ]


def test_a_typo_in_a_rule_key_is_refused_rather_than_silently_dropped(tmp_path):
    # Silently dropping it would push a policy missing exactly what was typed.
    path = write_policy(
        tmp_path, [{"allowedOrigin": ["https://x"], "allowedMethods": ["GET"]}]
    )
    with pytest.raises(UploadError, match="allowedOrigin"):
        load_rules(path)


def test_a_rule_with_no_origins_is_refused(tmp_path):
    path = write_policy(tmp_path, [{"allowedOrigins": [], "allowedMethods": ["GET"]}])
    with pytest.raises(UploadError, match="allowedOrigins"):
        load_rules(path)


def test_a_file_with_no_rules_is_refused(tmp_path):
    path = tmp_path / "cors.json"
    path.write_text(json.dumps({"corsRules": []}), encoding="utf-8")
    with pytest.raises(UploadError, match="corsRules"):
        load_rules(path)


# --------------------------------------------------------------------------- #
# comparing against the bucket
# --------------------------------------------------------------------------- #


def test_a_bucket_with_no_policy_at_all_reports_empty_not_an_error():
    assert current_rules(FakeS3(rules=None), "bucket") == []


def test_an_unrelated_client_error_still_raises():
    class Broken(FakeS3):
        def get_bucket_cors(self, Bucket: str):  # noqa: N803
            raise RuntimeError("An error occurred (AccessDenied) when calling …")

    with pytest.raises(RuntimeError, match="AccessDenied"):
        current_rules(Broken(), "bucket")


def test_the_old_origin_alone_is_reported_as_missing_the_new_one():
    # Precisely the state a domain move leaves the bucket in.
    live = [{"AllowedOrigins": ["https://draindrain.github.io"], "AllowedMethods": ["GET"]}]
    wanted = [
        {
            "AllowedOrigins": ["https://fornborgar.drnz.se", "https://draindrain.github.io"],
            "AllowedMethods": ["GET"],
        }
    ]
    assert origins_missing(live, wanted) == ["https://fornborgar.drnz.se"]


def test_nothing_is_missing_once_every_origin_is_allowed():
    rules = [{"AllowedOrigins": ["https://a", "https://b"], "AllowedMethods": ["GET"]}]
    assert origins_missing(rules, rules) == []


def test_a_wildcard_bucket_allows_everything():
    live = [{"AllowedOrigins": ["*"], "AllowedMethods": ["GET"]}]
    wanted = [{"AllowedOrigins": ["https://fornborgar.drnz.se"], "AllowedMethods": ["GET"]}]
    assert origins_missing(live, wanted) == []


def test_applying_sends_the_committed_rules_verbatim():
    client = FakeS3(rules=[{"AllowedOrigins": ["https://old"], "AllowedMethods": ["GET"]}])
    rules = load_rules()
    apply_rules(client, "bucket", rules)
    assert client.puts == [{"CORSRules": rules}]
    assert origins_missing(current_rules(client, "bucket"), rules) == []
