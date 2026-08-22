"""Object-store sync (scale-out §3): idempotence, cache headers, resumable state.

No network: the S3 client is a fake that records what it was asked to do. What
these tests actually protect is a national batch's economics and honesty — an
unchanged object must not be re-sent, a bundle that failed QA must never look
uploaded, and credentials must not reach the state file.
"""

from __future__ import annotations

import json

import pytest

from fornborg_pipeline.upload import (
    BUNDLE_PREFIX,
    CACHE_IMMUTABLE,
    CACHE_INDEX,
    CACHE_SITE_JSON,
    INDEX_KEY,
    R2Config,
    SiteState,
    UploadError,
    bundle_files,
    bundle_key,
    cache_control_for,
    config_from_env,
    content_type_for,
    file_md5,
    is_up_to_date,
    record_build,
    record_failure,
    record_upload,
    sync_bundle,
    upload_index,
)


class FakeS3:
    """Just enough S3 to test the sync: keyed objects with ETags."""

    def __init__(self, existing: dict[str, bytes] | None = None):
        self.objects: dict[str, dict] = {}
        for key, body in (existing or {}).items():
            self.objects[key] = {"Body": body, "ETag": f'"{_md5(body)}"'}
        self.puts: list[dict] = []
        self.heads: list[str] = []

    def head_object(self, Bucket: str, Key: str):  # noqa: N803 - boto3's signature
        self.heads.append(Key)
        if Key not in self.objects:
            raise ClientError404()
        return {"ETag": self.objects[Key]["ETag"], "ContentLength": len(self.objects[Key]["Body"])}

    def put_object(self, Bucket: str, Key: str, Body: bytes, ContentType: str, CacheControl: str):  # noqa: N803
        self.puts.append(
            {"key": Key, "bytes": len(Body), "contentType": ContentType, "cacheControl": CacheControl}
        )
        self.objects[Key] = {"Body": Body, "ETag": f'"{_md5(Body)}"'}


class ClientError404(Exception):
    response = {"Error": {"Code": "404"}}


def _md5(body: bytes) -> str:
    import hashlib

    return hashlib.md5(body).hexdigest()  # noqa: S324


CONFIG = R2Config(
    account_id="acct",
    access_key_id="key",
    secret_access_key="secret",
    bucket="bucket",
    public_base_url="https://example.r2.dev",
)


@pytest.fixture
def bundle(tmp_path):
    out = tmp_path / "l1943-7827"
    out.mkdir()
    (out / "manifest.json").write_text('{"schemaVersion": 1}', encoding="utf-8")
    (out / "dem_core.tif").write_bytes(b"core-grid-bytes")
    (out / "dem_context.tif").write_bytes(b"context-grid-bytes")
    (out / "thumbnail.png").write_bytes(b"png")
    (out / "DATA-LICENSES.md").write_text("licenses", encoding="utf-8")
    (out / "build_report.json").write_text("{}", encoding="utf-8")
    return out


# ------------------------------- configuration -------------------------------


def test_config_names_the_missing_variable_not_its_value():
    with pytest.raises(UploadError, match="R2_SECRET_ACCESS_KEY"):
        config_from_env({"R2_ACCOUNT_ID": "a", "R2_ACCESS_KEY_ID": "b", "R2_BUCKET": "c"})


CREDENTIALS = {
    "R2_ACCOUNT_ID": "a",
    "R2_ACCESS_KEY_ID": "b",
    "R2_SECRET_ACCESS_KEY": "c",
    "R2_BUCKET": "d",
}


def test_the_public_base_url_comes_from_the_committed_config(monkeypatch, tmp_path):
    """§3: it is public by definition, so it is config — not a secret, not a constant."""
    config_file = tmp_path / "r2-config.json"
    config_file.write_text('{"publicBaseUrl": "https://data.example"}', encoding="utf-8")
    monkeypatch.setattr("fornborg_pipeline.upload.CONFIG_PATH", config_file)
    assert config_from_env(CREDENTIALS).public_base_url == "https://data.example"


def test_the_environment_overrides_the_config_file(monkeypatch, tmp_path):
    config_file = tmp_path / "r2-config.json"
    config_file.write_text('{"publicBaseUrl": "https://data.example"}', encoding="utf-8")
    monkeypatch.setattr("fornborg_pipeline.upload.CONFIG_PATH", config_file)
    env = {**CREDENTIALS, "R2_PUBLIC_BASE_URL": "https://staging.example"}
    assert config_from_env(env).public_base_url == "https://staging.example"


def test_config_requires_a_public_base_url_from_somewhere(monkeypatch, tmp_path):
    monkeypatch.setattr("fornborg_pipeline.upload.CONFIG_PATH", tmp_path / "absent.json")
    with pytest.raises(UploadError, match="no public base URL"):
        config_from_env(CREDENTIALS)


def test_a_corrupt_config_file_does_not_crash_the_batch(monkeypatch, tmp_path):
    config_file = tmp_path / "r2-config.json"
    config_file.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr("fornborg_pipeline.upload.CONFIG_PATH", config_file)
    with pytest.raises(UploadError, match="no public base URL"):
        config_from_env(CREDENTIALS)


def test_the_committed_config_holds_no_credentials():
    """The one file in the repo that names the object store must stay boring."""
    from fornborg_pipeline.upload import CONFIG_PATH

    text = CONFIG_PATH.read_text(encoding="utf-8")
    for forbidden in ("R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "secretAccessKey", "accessKeyId"):
        assert forbidden not in text or "never" in text.lower()
    payload = json.loads("".join(
        line for line in text.splitlines(keepends=True) if True
    ))
    assert set(payload) <= {"comment", "publicBaseUrl"}


def test_endpoint_and_public_url_shapes():
    assert CONFIG.endpoint_url == "https://acct.r2.cloudflarestorage.com"
    assert CONFIG.public_url("v1/x/manifest.json") == "https://example.r2.dev/v1/x/manifest.json"


def test_keys_carry_the_schema_version_in_the_path():
    assert bundle_key("l1943-7827", "manifest.json") == "v1/l1943-7827/manifest.json"
    assert INDEX_KEY == f"{BUNDLE_PREFIX}/index.json"


# ------------------------------- cache headers -------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("dem_core.tif", CACHE_IMMUTABLE),
        ("water_connect_delta.tif", CACHE_IMMUTABLE),
        ("thumbnail.png", CACHE_IMMUTABLE),
        ("manifest.json", CACHE_SITE_JSON),
        ("shoreline.json", CACHE_SITE_JSON),
        ("index.json", CACHE_INDEX),
    ],
)
def test_cache_control_policy(name, expected):
    assert cache_control_for(name) == expected


def test_index_is_never_cached_like_a_grid():
    """The index gains a site every time the batch finishes one."""
    assert cache_control_for("index.json") != CACHE_IMMUTABLE
    assert "immutable" not in cache_control_for("index.json")


@pytest.mark.parametrize(
    ("name", "expected"),
    [("a.tif", "image/tiff"), ("a.json", "application/json"), ("a.png", "image/png")],
)
def test_content_types(name, expected):
    assert content_type_for(name) == expected


# ----------------------------------- sync ------------------------------------


def test_build_report_is_never_published(bundle):
    names = [p.name for p in bundle_files(bundle)]
    assert "build_report.json" not in names
    assert "manifest.json" in names


def test_first_sync_uploads_everything(bundle):
    client = FakeS3()
    summary = sync_bundle("l1943-7827", bundle, CONFIG, client=client)
    assert set(summary["uploaded"]) == {
        "DATA-LICENSES.md",
        "dem_context.tif",
        "dem_core.tif",
        "manifest.json",
        "thumbnail.png",
    }
    assert summary["skipped"] == []
    assert {p["key"] for p in client.puts} == {
        f"v1/l1943-7827/{n}" for n in summary["uploaded"]
    }


def test_second_sync_uploads_nothing(bundle):
    client = FakeS3()
    sync_bundle("l1943-7827", bundle, CONFIG, client=client)
    client.puts.clear()
    summary = sync_bundle("l1943-7827", bundle, CONFIG, client=client)
    assert summary["uploaded"] == []
    assert len(summary["skipped"]) == 5
    assert client.puts == [], "an unchanged object must cost one HEAD and nothing else"


def test_only_the_changed_object_is_re_sent(bundle):
    client = FakeS3()
    sync_bundle("l1943-7827", bundle, CONFIG, client=client)
    client.puts.clear()
    (bundle / "manifest.json").write_text('{"schemaVersion": 1, "changed": true}', encoding="utf-8")
    summary = sync_bundle("l1943-7827", bundle, CONFIG, client=client)
    assert summary["uploaded"] == ["manifest.json"]
    assert [p["key"] for p in client.puts] == ["v1/l1943-7827/manifest.json"]


def test_grids_go_up_with_the_immutable_header(bundle):
    client = FakeS3()
    sync_bundle("l1943-7827", bundle, CONFIG, client=client)
    by_key = {p["key"]: p for p in client.puts}
    assert by_key["v1/l1943-7827/dem_core.tif"]["cacheControl"] == CACHE_IMMUTABLE
    assert by_key["v1/l1943-7827/dem_core.tif"]["contentType"] == "image/tiff"
    assert by_key["v1/l1943-7827/manifest.json"]["cacheControl"] == CACHE_SITE_JSON


def test_dry_run_sends_nothing_but_still_reports(bundle):
    client = FakeS3()
    summary = sync_bundle("l1943-7827", bundle, CONFIG, client=client, dry_run=True)
    assert len(summary["uploaded"]) == 5
    assert client.puts == []
    assert summary["dryRun"] is True


def test_sync_refuses_a_missing_or_empty_directory(tmp_path):
    with pytest.raises(UploadError, match="not a directory"):
        sync_bundle("x", tmp_path / "absent", CONFIG, client=FakeS3())
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(UploadError, match="no bundle files"):
        sync_bundle("x", empty, CONFIG, client=FakeS3())


def test_index_upload_uses_the_short_ttl(tmp_path):
    client = FakeS3()
    index = tmp_path / "index.json"
    index.write_text('{"sites": []}', encoding="utf-8")
    url = upload_index(index, CONFIG, client=client)
    assert url == "https://example.r2.dev/v1/index.json"
    assert client.puts[0]["key"] == INDEX_KEY
    assert client.puts[0]["cacheControl"] == CACHE_INDEX


# ------------------------------- per-site state ------------------------------


def test_state_roundtrips(tmp_path, bundle):
    record_build("l1943-7827", True, "l1943-7827: PASS", 9_500_000, state_dir=tmp_path)
    state = SiteState.load("l1943-7827", tmp_path)
    assert state.built and state.qaPassed and not state.uploaded
    assert state.bundleBytes == 9_500_000
    assert state.builtAt.endswith("+00:00")


def test_a_qa_failure_clears_any_earlier_upload_flag(tmp_path, bundle):
    summary = sync_bundle("l1943-7827", bundle, CONFIG, client=FakeS3())
    record_upload("l1943-7827", summary, state_dir=tmp_path)
    assert SiteState.load("l1943-7827", tmp_path).uploaded

    record_build("l1943-7827", False, "l1943-7827: FAIL", 9_500_000, state_dir=tmp_path)
    state = SiteState.load("l1943-7827", tmp_path)
    assert not state.uploaded, "a bundle that failed QA must never look shipped"


def test_up_to_date_skips_only_an_identical_bundle(tmp_path, bundle):
    summary = sync_bundle("l1943-7827", bundle, CONFIG, client=FakeS3())
    record_upload("l1943-7827", summary, state_dir=tmp_path)
    state = SiteState.load("l1943-7827", tmp_path)
    assert is_up_to_date(state, bundle)

    (bundle / "dem_core.tif").write_bytes(b"rebuilt-with-different-bytes")
    assert not is_up_to_date(state, bundle)


def test_a_never_uploaded_site_is_not_up_to_date(tmp_path, bundle):
    assert not is_up_to_date(SiteState(slug="l1943-7827"), bundle)


def test_state_survives_a_corrupt_file(tmp_path):
    path = SiteState.path_for("l1943-7827", tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    state = SiteState.load("l1943-7827", tmp_path)
    assert state.slug == "l1943-7827" and not state.built


def test_state_ignores_unknown_keys_from_a_future_version(tmp_path):
    path = SiteState.path_for("l1943-7827", tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"slug": "l1943-7827", "built": True, "warpDrive": 9}), encoding="utf-8")
    assert SiteState.load("l1943-7827", tmp_path).built


def test_state_never_holds_a_credential(tmp_path, bundle):
    summary = sync_bundle("l1943-7827", bundle, CONFIG, client=FakeS3())
    record_upload("l1943-7827", summary, state_dir=tmp_path)
    record_failure("l1943-7827", "AccessDenied on put", state_dir=tmp_path)
    text = SiteState.path_for("l1943-7827", tmp_path).read_text(encoding="utf-8")
    for secret in (CONFIG.secret_access_key, CONFIG.access_key_id, CONFIG.account_id):
        assert secret not in text


def test_failure_is_recorded_without_losing_the_build(tmp_path):
    record_build("l1943-7827", True, "PASS", 100, state_dir=tmp_path)
    record_failure("l1943-7827", "connection reset", state_dir=tmp_path)
    state = SiteState.load("l1943-7827", tmp_path)
    assert state.built and state.lastError == "connection reset"


def test_file_md5_matches_the_etag_convention(bundle):
    assert file_md5(bundle / "dem_core.tif") == _md5(b"core-grid-bytes")
