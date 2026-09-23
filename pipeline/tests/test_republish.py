"""Regenerating the §14 asset of an already-published bundle (phase 13.6).

No network and no credentials: the published bundle is a fixture built from the
committed Broborg bundle, and the object store is the same kind of fake S3 the
upload tests use.

What these tests actually protect:

  * **the height-band trap.** `manifest._band_for()` falls back to *Broborg's*
    `[-10, 200]` for a slug it does not know, and real Swedish terrain leaves that
    band immediately. 15 of the 26 pilot bundles fail validation for that reason
    alone. `prepare()` must register the site's config first — and the temptation
    the brief names explicitly, weakening or skipping validation to get past it,
    must stay impossible: `test_validation_is_not_skipped_*` fails if it is.
  * **the blast radius.** A republish may write exactly two JSON objects in one
    slug's prefix. Not a grid, not `index.json`, not a second slug.
  * **the attribution repair.** A dangling `"hämtad "` gets the bundle's own
    `fetched` date; a date that is already there is never overwritten.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fornborg_pipeline import manifest as M  # noqa: E402
from fornborg_pipeline import republish as RP  # noqa: E402
from fornborg_pipeline.reconstruct import ReconstructError  # noqa: E402
from fornborg_pipeline.sites import SITES, NATIONAL_ELEVATION_RANGE  # noqa: E402
from fornborg_pipeline.upload import R2Config, UploadError  # noqa: E402

BUNDLE = Path(__file__).resolve().parents[2] / "app" / "public" / "data" / "broborg"

#: A real pilot slug, in the committed registry, that is **not** in `SITES` and
#: whose published manifest failed the naive band check (docs/publish-diagnosis
#: -2026-08-30.md): Ismantorps fornborg, Öland.
PILOT_SLUG = "l1957-426"

#: Höjer than Broborg's band allows, and inside the national one. A ring at 228 m
#: is ordinary Swedish terrain; it is only "out of range" against Uppland.
ABOVE_BROBORG_BAND = 228.0

CONFIG = R2Config(
    account_id="acct",
    access_key_id="key",
    secret_access_key="secret",
    bucket="bucket",
    public_base_url="https://example.r2.dev",
)


# --------------------------------------------------------------------------- #
# fixtures: a "published" bundle that is not Broborg's slug and not its band
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def unregister_pilot():
    """`register_site` mutates a process-global dict; put it back afterwards."""
    before = dict(SITES)
    yield
    SITES.clear()
    SITES.update(before)


@pytest.fixture
def published_sites() -> dict:
    sites = json.loads((BUNDLE / "sites.json").read_text(encoding="utf-8"))
    # The pilot batch published this field; the dangling credit line is the bug.
    sites["fetched"] = "2026-08-23"
    return sites


@pytest.fixture
def published_manifest() -> dict:
    """Broborg's manifest, renamed to a pilot slug and lifted out of its band.

    Renaming is what makes this a *registry* site as far as `_band_for` is
    concerned, and raising one ring above 200 m is what makes Broborg's fallback
    band the wrong answer — the two halves of the trap, in one fixture.
    """
    manifest = json.loads((BUNDLE / "manifest.json").read_text(encoding="utf-8"))
    manifest["site"]["id"] = PILOT_SLUG
    manifest["site"]["name"] = "Ismantorps fornborg"
    manifest["site"]["raa"] = {"lamningsnummer": "L1957:426"}
    manifest["grids"]["rings"][0]["maxElevation"] = ABOVE_BROBORG_BAND
    manifest["assets"].pop("reconstruction", None)
    manifest["layers"] = [
        layer for layer in manifest["layers"] if layer.get("id") != "reconstruction"
    ]
    # The credit line as the pilot batch published it: built with an empty
    # `kmr_fetched`, so it ends in a dangling "hämtad " with no date.
    manifest["attribution"] = [
        M._raa_attribution("") if entry["text"].startswith(M.RAA_ATTRIBUTION_PREFIX) else entry
        for entry in manifest["attribution"]
    ]
    return manifest


@pytest.fixture
def prepared(tmp_path: Path, published_manifest: dict, published_sites: dict):
    return RP.prepare(
        PILOT_SLUG,
        tmp_path,
        published_manifest,
        published_sites,
        generated="2026-09-23",
    )


class FakeS3:
    """Just enough S3 to test the republish: keyed objects with ETags."""

    def __init__(self, existing: dict[str, bytes] | None = None):
        self.objects: dict[str, dict] = {}
        for key, body in (existing or {}).items():
            self.objects[key] = {"Body": body, "ETag": f'"{_md5(body)}"'}
        self.puts: list[dict] = []

    def head_object(self, Bucket: str, Key: str):  # noqa: N803 - boto3's signature
        if Key not in self.objects:
            raise ClientError404()
        return {"ETag": self.objects[Key]["ETag"]}

    def put_object(self, Bucket: str, Key: str, Body: bytes, ContentType: str, CacheControl: str):  # noqa: N803
        self.puts.append(
            {"key": Key, "contentType": ContentType, "cacheControl": CacheControl, "bytes": len(Body)}
        )
        self.objects[Key] = {"Body": Body, "ETag": f'"{_md5(Body)}"'}


class ClientError404(Exception):
    response = {"Error": {"Code": "404"}}


def _md5(body: bytes) -> str:
    return hashlib.md5(body).hexdigest()  # noqa: S324


# --------------------------------------------------------------------------- #
# trap 2 — the height band
# --------------------------------------------------------------------------- #


def test_the_published_manifest_fails_validation_against_broborgs_band(
    published_manifest: dict,
) -> None:
    """The failure this phase exists to route around, pinned so it stays visible.

    Nothing is wrong with this manifest: a 228 m ring is ordinary Swedish terrain.
    It fails only because `_band_for` cannot resolve the slug and falls back to
    Broborg's `[-10, 200]`.
    """
    assert PILOT_SLUG not in SITES
    with pytest.raises(ValueError, match="outside"):
        M.validate_manifest(published_manifest)


def test_prepare_registers_the_site_with_the_national_band(prepared) -> None:
    assert SITES[PILOT_SLUG].elevation_range == NATIONAL_ELEVATION_RANGE
    # And the same manifest that failed above now validates — for the right
    # reason, not because anything was loosened.
    M.validate_manifest(prepared.manifest)


def test_validation_is_not_skipped_when_the_site_is_unregistered(
    tmp_path: Path, published_manifest: dict, published_sites: dict, monkeypatch
) -> None:
    """Remove the registration and the run must fail, loudly.

    This is the regression guard the brief asks for: if a later change drops
    `load_site` (or stops it handing out `NATIONAL_ELEVATION_RANGE`), `prepare`
    must refuse the slug rather than publish a manifest nobody checked.
    """
    from fornborg_pipeline import build_site

    def unregistered(slug, out_dir, registry_path=build_site.REGISTRY_PATH):
        return build_site.site_config(
            build_site.get_entry(slug, registry_path), out_dir
        )  # built, deliberately NOT registered

    monkeypatch.setattr(build_site, "load_site", unregistered)
    with pytest.raises(ValueError, match="outside"):
        RP.prepare(PILOT_SLUG, tmp_path, published_manifest, published_sites)


def test_a_broken_document_is_never_written(
    tmp_path: Path, published_manifest: dict, published_sites: dict
) -> None:
    """`write_reconstruction` validates first, so a bad parse leaves no file."""
    broken = copy.deepcopy(published_sites)
    for record in broken["sites"]:
        record["id"] = "duplicate"
    with pytest.raises(ReconstructError, match="duplicate monument id"):
        RP.prepare(PILOT_SLUG, tmp_path, published_manifest, broken)
    assert not (tmp_path / PILOT_SLUG / "reconstruction.json").exists()


# --------------------------------------------------------------------------- #
# what gets generated
# --------------------------------------------------------------------------- #


def test_the_pair_is_written_and_declares_the_asset(prepared) -> None:
    assert (prepared.out_dir / "reconstruction.json").is_file()
    assert (prepared.out_dir / "manifest.json").is_file()
    assert prepared.manifest["assets"]["reconstruction"] == "reconstruction.json"
    layer = next(
        entry for entry in prepared.manifest["layers"] if entry["id"] == "reconstruction"
    )
    assert layer["provenance"] == "conjecture"
    assert prepared.had_reconstruction is False


def test_the_document_names_the_bundle_it_was_generated_from(prepared) -> None:
    assert prepared.document["site"] == PILOT_SLUG
    document = json.loads(
        (prepared.out_dir / "reconstruction.json").read_text(encoding="utf-8")
    )
    assert document["site"] == PILOT_SLUG


def test_every_monument_joins_back_to_a_published_record(prepared, published_sites) -> None:
    """§14: the file carries no coordinates and joins to `sites.json` by id."""
    record_ids = {record["id"] for record in published_sites["sites"]}
    orphans = [m["id"] for m in prepared.document["monuments"] if m["id"] not in record_ids]
    assert orphans == []


def test_a_bundle_for_another_site_is_refused(
    tmp_path: Path, published_manifest: dict, published_sites: dict
) -> None:
    """Trap 3: Broborg is published twice, and one bundle never stands for another."""
    with pytest.raises(RP.RepublishError, match="refusing"):
        RP.prepare("l1943-7827", tmp_path, published_manifest, published_sites)


def test_the_interior_block_is_generated(prepared) -> None:
    """Phase 2's §15 block: what was added after this phase's brief was written."""
    interior = prepared.document["interior"]
    assert interior["evidence"]["gate"] in ("pass", "fail")
    if interior["evidence"]["gate"] == "pass":
        assert interior["evidence"]["citations"], "a pass must carry its sentence (§15)"


# --------------------------------------------------------------------------- #
# the attribution repair
# --------------------------------------------------------------------------- #


def test_the_dangling_attribution_gets_the_bundles_own_date(prepared) -> None:
    assert prepared.attribution == {
        "action": "filled",
        "before": "",
        "sitesFetched": "2026-08-23",
        "after": "2026-08-23",
    }
    text = next(
        entry["text"]
        for entry in prepared.manifest["attribution"]
        if entry["text"].startswith(M.RAA_ATTRIBUTION_PREFIX)
    )
    assert text.endswith("hämtad 2026-08-23")


def test_a_date_that_is_already_there_is_never_overwritten() -> None:
    manifest = {"attribution": [M._raa_attribution("2026-08-20")]}
    assert M.set_raa_attribution(manifest, "2026-08-23") == "conflict"
    assert M.raa_attribution_date(manifest) == "2026-08-20"


def test_setting_the_same_date_twice_is_a_no_op() -> None:
    manifest = {"attribution": [M._raa_attribution("2026-08-20")]}
    assert M.set_raa_attribution(manifest, "2026-08-20") == "unchanged"


def test_an_empty_fetched_date_fills_nothing() -> None:
    manifest = {"attribution": [M._raa_attribution("")]}
    assert M.set_raa_attribution(manifest, "") == "no-date"
    assert M.raa_attribution_date(manifest) == ""


def test_a_manifest_with_no_kmr_credit_says_so() -> None:
    assert M.set_raa_attribution({"attribution": []}, "2026-08-23") == "absent"
    assert M.raa_attribution_date({"attribution": []}) is None


# --------------------------------------------------------------------------- #
# what would be uploaded
# --------------------------------------------------------------------------- #


def test_both_objects_count_as_changed_against_an_unpatched_bundle(prepared) -> None:
    assert prepared.changed == ["manifest.json", "reconstruction.json"]
    assert prepared.as_json()["changedKeys"] == [
        f"v1/{PILOT_SLUG}/manifest.json",
        f"v1/{PILOT_SLUG}/reconstruction.json",
    ]


def test_an_already_published_identical_document_is_not_changed(
    tmp_path: Path, published_manifest: dict, published_sites: dict
) -> None:
    """A rerun against a bundle already carrying this exact pair sends nothing."""
    first = RP.prepare(
        PILOT_SLUG, tmp_path / "a", published_manifest, published_sites, generated="2026-09-23"
    )
    again = RP.prepare(
        PILOT_SLUG,
        tmp_path / "b",
        first.manifest,
        published_sites,
        generated="2026-09-23",
        published_reconstruction=first.document,
    )
    assert again.changed == []
    assert again.had_reconstruction is True


def test_a_dry_run_sends_nothing_and_names_the_keys(prepared) -> None:
    client = FakeS3()
    summary = RP.upload_prepared(prepared, CONFIG, client=client, dry_run=True)
    assert client.puts == []
    assert [obj["key"] for obj in summary["objects"]] == [
        f"v1/{PILOT_SLUG}/manifest.json",
        f"v1/{PILOT_SLUG}/reconstruction.json",
    ]
    assert {obj["action"] for obj in summary["objects"]} == {"would-put"}


def test_an_upload_sends_exactly_two_objects_with_the_bundles_headers(prepared) -> None:
    client = FakeS3()
    summary = RP.upload_prepared(prepared, CONFIG, client=client, dry_run=False)
    assert [put["key"] for put in client.puts] == [
        f"v1/{PILOT_SLUG}/manifest.json",
        f"v1/{PILOT_SLUG}/reconstruction.json",
    ]
    for put in client.puts:
        assert put["contentType"] == "application/json"
        assert put["cacheControl"] == "public, max-age=3600"
    assert all(obj["etagAfter"] == obj["md5"] for obj in summary["objects"])


def test_an_upload_touches_no_other_object_in_the_prefix(prepared) -> None:
    """No grids, no thumbnail, no `index.json`, no deletions."""
    untouched = {
        f"v1/{PILOT_SLUG}/dem_core.tif": b"grid",
        f"v1/{PILOT_SLUG}/sites.json": b"records",
        "v1/index.json": b"index",
        "v1/broborg/manifest.json": b"the other Broborg",
    }
    client = FakeS3(dict(untouched))
    RP.upload_prepared(prepared, CONFIG, client=client, dry_run=False)
    for key, body in untouched.items():
        assert client.objects[key]["Body"] == body


def test_an_unchanged_object_is_not_re_sent(prepared) -> None:
    client = FakeS3(
        {
            f"v1/{PILOT_SLUG}/manifest.json": (
                prepared.paths["manifest.json"].read_bytes()
            )
        }
    )
    summary = RP.upload_prepared(prepared, CONFIG, client=client, dry_run=False)
    assert [put["key"] for put in client.puts] == [f"v1/{PILOT_SLUG}/reconstruction.json"]
    actions = {obj["key"]: obj["action"] for obj in summary["objects"]}
    assert actions[f"v1/{PILOT_SLUG}/manifest.json"] == "skipped-unchanged"


def test_an_object_outside_the_allowed_pair_is_refused_before_any_request(prepared) -> None:
    prepared.local_digests["dem_core.tif"] = "0" * 32
    client = FakeS3()
    with pytest.raises(UploadError, match="not a republishable object"):
        RP.upload_prepared(prepared, CONFIG, client=client, dry_run=False)
    assert client.puts == []


def test_the_default_run_needs_no_credentials(monkeypatch, prepared) -> None:
    """`prepare` is the whole default path, and it never reads an R2_* variable."""
    for name in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        monkeypatch.delenv(name, raising=False)
    assert prepared.manifest["assets"]["reconstruction"] == "reconstruction.json"


# --------------------------------------------------------------------------- #
# reading the published bundle
# --------------------------------------------------------------------------- #


def test_the_pilot_list_is_the_default_target_set() -> None:
    slugs = RP.pilot_slugs()
    assert len(slugs) == 27
    assert "l1943-7827" in slugs
    assert len(set(slugs)) == len(slugs)


def test_published_urls_are_built_from_the_committed_public_base() -> None:
    url = RP.public_url(PILOT_SLUG, "manifest.json")
    assert url.endswith(f"/v1/{PILOT_SLUG}/manifest.json")
    assert url.startswith("https://")


def test_fetching_a_bundle_reads_only_what_it_declares(
    published_manifest: dict, published_sites: dict
) -> None:
    seen: list[str] = []

    def fake_fetch(url: str) -> dict:
        seen.append(url.rsplit("/", 1)[-1])
        return published_manifest if url.endswith("manifest.json") else published_sites

    manifest, sites, reconstruction = RP.fetch_published_bundle(
        PILOT_SLUG, base="https://example.r2.dev", fetch=fake_fetch
    )
    assert seen == ["manifest.json", "sites.json"]
    assert reconstruction is None
    assert manifest["site"]["id"] == PILOT_SLUG
    assert sites is published_sites
