> **Dry-run report, 2026-09-23.** What phase 13.6 would upload to the pilot
> bucket, generated and validated in full, **with nothing uploaded**. It records
> object-store state and one planned write, not the design of anything in this
> repository, and may be deleted before any pull request. Companion to
> `docs/publish-diagnosis-2026-08-30.md`, which surveyed the same 26 bundles.

# Republishing the 27 pilot bundles: the plan, checked

## Summary

26 of the 27 published pilot bundles carry no `assets.reconstruction`, so the app
has nothing to declare a reconstruction from and correctly withholds the
Reconstruction button. This run regenerates that asset — and the v1.8 §15
`interior` block, which did not exist when the phase was written — for **all 27**
slugs from each bundle's own **published** `sites.json`, validates both files, and
reports exactly which object keys a later, credentialled run would write.

* **27 of 27 slugs generated and validated.** 2 320 register records mapped to
  archetypes, 0 unmapped types, 0 orphan ids against the published `sites.json`
  they will join to.
* **54 object keys would be written** — `manifest.json` and `reconstruction.json`
  under `v1/<slug>/`, 2.84 MB in total. Nothing else: no TIFFs, no `sites.json`,
  no `index.json`, no deletions.
* **Nothing was uploaded, and nothing could have been.** This container has none
  of `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and
  the write endpoint is unreachable from it. The public read base is reachable,
  which is all the generation half needs.
* **The two acceptance criteria that need the upload are not met and are not
  claimed.** See "What is still blocked".

The driver is `pipeline/fornborg_pipeline/republish.py`; its tests are
`pipeline/tests/test_republish.py` (27 tests). The upload half is written, tested
against a fake object store, and **has never been run against R2**.

## The environment check, restated

| thing | result |
|---|---|
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | **all four absent** |
| write path `https://<account>.r2.cloudflarestorage.com` | **unreachable** (HTTP 000, measured before this run; not re-tested here, since with no account id and no key there is nothing to reach it with) |
| public read base (`publicBaseUrl` in `pipeline/r2-config.json`) | HTTP 200 for every object read below |

One correction to the 2026-08-30 note, which reported uniform HTTP 403s through
Python and worked around them with `curl`: the 403 is the **default
`python-urllib/x.y` User-Agent**, not the container's egress proxy. The identical
request with any ordinary `User-Agent` header returns 200. `republish.fetch_json`
sets one, so the driver needs no `curl` shell-out and no per-environment
workaround.

## How the files are generated

`reconstruct.run()` cannot be pointed at a pilot slug at all: it resolves through
`sites.get_site()`, which knows only the hand-curated `SITES` dict. The driver
therefore calls the pure functions itself, in this order, per slug:

```
fetch v1/<slug>/manifest.json, v1/<slug>/sites.json      (public base, no credentials)
build_site.load_site(slug, out_dir)                      → registers the SiteConfig
reconstruct.build_document(sites, slug, county, kommun, fort_id)
reconstruct.write_reconstruction(...)                    → validate_document + validate_interior
manifest.add_reconstruction_asset(copy of manifest)
manifest.set_raa_attribution(manifest, sites["fetched"])
manifest.write_manifest(...)                             → validate_manifest
manifest.validate_manifest(...)                          → again, explicitly
```

The fetched manifest is deep-copied before it is patched, so a failure part-way
leaves nothing half-written; `write_reconstruction` validates *before* it writes,
so a bad parse leaves no file at all.

### Trap: the height band (this is the one that matters)

`manifest._band_for()` resolves the height band by looking `manifest.site.id` up
in the in-process `SITES` dict and falls back to `DEFAULT_ELEVATION_BAND` —
**Broborg's** `[-10, 200]` — for a slug it does not know. Re-measured today
against the published manifests, with no site registered:

```
15 of 27 published pilot manifests FAIL validate_manifest() for this reason alone

l1936-5794  core:     elevation range 138.3..342.1 m is outside [-10.0, 200.0] m …
l1961-5391  core:     elevation range 145.8..320.2 m …
l1951-8556  core:     elevation range  51.1..256.0 m …
l1989-1072  rings[3]: elevation range -58.0..186.0 m …
l2004-6478  rings[3]: elevation range  -1.0..288.0 m …
l1964-7416  rings[2]: elevation range  -1.0..228.0 m …
… and l1957-426, l1958-904, l1959-7076, l1976-4254, l1979-6892, l1980-3692,
     l1998-8123, l2007-1020, l2010-1810
```

Every one of those ranges lies inside `sites.NATIONAL_ELEVATION_RANGE`
`(-100, 2200)` — across every grid of all 27 bundles the extremes are **-58.0 m**
(`l1989-1072`, a Skåne ring) and **563.0 m** (`l1936-5794`, a Västernorrland
ring), which is ordinary Swedish terrain, not a datum shift. The fix is **registration**:
`prepare()` calls `build_site.load_site()`, which builds the `SiteConfig` with
`NATIONAL_ELEVATION_RANGE` exactly as `build_site.py:164` does and registers it,
so the band the manifest is checked against is the site's own.

Validation is never skipped or weakened. Three tests hold that line:
`test_the_published_manifest_fails_validation_against_broborgs_band` pins the
failure, `test_prepare_registers_the_site_with_the_national_band` shows the same
manifest validating afterwards, and
`test_validation_is_not_skipped_when_the_site_is_unregistered` monkeypatches the
registration away and asserts the run still fails. Remove the registration and
the suite goes red rather than the bucket going wrong.

### Trap: two Broborgs

`v1/broborg/` (what a bare visit loads) and `v1/l1943-7827/` (what the picker
links to) are different vintages of everything except the register records. The
driver only ever touches the slug it is given, and refuses outright if the fetched
manifest names a different site (`test_a_bundle_for_another_site_is_refused`).

**`v1/broborg/` is not in this plan.** It is not in `pilot-sites.json`, its
manifest already declares `assets.reconstruction`, and its KMR credit already
reads `hämtad 2026-08-20`. It was read, not written, and it is not in table B.
Note that it would still gain the §15 `interior` block if it were republished —
a separate decision, outside this phase.

### The fort a `interior` block belongs to

§15.1 attributes the interior to the bundle's **own** fort, from the registry's
`lamningsnummer`. This matters more than it sounds: 9 of the 27 bundles hold more
than one registered fornborg, and `l1964-7416` (the 5.9 km Vänersnäs extent)
holds **19**. Checked for all 27: each bundle's own fort record is present in its
published `sites.json`, and the fallback "first fort in the extract" was never
used.

## A. What would be generated

`naive band` is `validate_manifest()` on the **published** manifest with no site
registered — the trap above, per slug, not a property of the bundle.

| slug | name (KMR) | records → archetypes | samplers | `interior` | naive band |
|---|---|---|---|---|---|
| `l1964-7416` | *(unnamed)* | 103/103 (0 unmapped) | 0 | gate **fail** (mainland) | **fails** |
| `l1976-4254` | *(unnamed)* | 508/508 (0 unmapped) | 718 | gate **fail** (limestone-ringfort) | **fails** |
| `l2010-1810` | Ramundersborg | 478/478 (0 unmapped) | 1573 | gate **fail** (mainland) | **fails** |
| `l1943-7827` | Broborg | 127/127 (0 unmapped) | 1215 | gate pass, no building spec (cited) | OK |
| `l1957-426` | Ismantorps fornborg | 55/55 (0 unmapped) | 5 | gate pass, **88 houses stated**, radial | **fails** |
| `l1958-4198` | Eketorps borg | 76/76 (0 unmapped) | 42 | gate pass, **75 houses stated**, radial | OK |
| `l1959-7076` | Gråborg | 42/42 (0 unmapped) | 66 | gate **fail** (limestone-ringfort) | **fails** |
| `l2017-1021` | Runsa borg | 27/27 (0 unmapped) | 73 | gate pass, no building spec (settlement-record) | OK |
| `l2013-3917` | Garnisonen | 61/61 (0 unmapped) | 2051 | gate pass, count not stated, free | OK |
| `l2017-2061` | Skansberget | 103/103 (0 unmapped) | 403 | gate **fail** (mainland) | OK |
| `l2017-4807` | Vikingaberget | 101/101 (0 unmapped) | 437 | gate **fail** (mainland) | OK |
| `l2017-9140` | *(unnamed)* | 18/18 (0 unmapped) | 27 | gate **fail** (mainland) | OK |
| `l1941-3311` | Predikstolen | 71/71 (0 unmapped) | 252 | gate **fail** (mainland) | OK |
| `l2016-3043` | Borgen | 68/68 (0 unmapped) | 0 | gate **fail** (mainland) | OK |
| `l1985-6036` | Jättunaskansen | 12/12 (0 unmapped) | 0 | gate **fail** (mainland) | OK |
| `l1958-904` | Borgberget | 8/8 (0 unmapped) | 0 | gate **fail** (mainland) | **fails** |
| `l1975-2084` | Slottet | 5/5 (0 unmapped) | 0 | gate **fail** (limestone-ringfort) | OK |
| `l2004-6478` | Bolströ borg | 27/27 (0 unmapped) | 4155 | gate **fail** (mainland) | **fails** |
| `l1951-8556` | Borgberget | 10/10 (0 unmapped) | 0 | gate **fail** (mainland) | **fails** |
| `l1936-5794` | Borgen | 1/1 (0 unmapped) | 0 | gate **fail** (mainland) | **fails** |
| `l1961-5391` | Träleborg | 15/15 (0 unmapped) | 0 | gate **fail** (mainland) | **fails** |
| `l1989-1072` | Borren | 28/28 (0 unmapped) | 0 | gate pass, no building spec (settlement-record) | **fails** |
| `l1979-6892` | Silverberget | 126/126 (0 unmapped) | 6 | gate **fail** (mainland) | **fails** |
| `l1998-8123` | Kungsbjär | 141/141 (0 unmapped) | 158 | gate **fail** (mainland) | **fails** |
| `l2007-1020` | Skansen | 7/7 (0 unmapped) | 87 | gate **fail** (mainland) | **fails** |
| `l1980-3692` | Tarsta berg | 48/48 (0 unmapped) | 8 | gate pass, count not stated, free | **fails** |
| `l2017-1477` | Borg | 54/54 (0 unmapped) | 1961 | gate **fail** (mainland) | OK |

**7 of 27 forts pass the §15 evidence gate; 20 do not**, and every one of those 20
still ships an `interior` block saying so with its discard counters — "the
register records nothing built inside this fort" is a statement, and a different
one from silence. Of the 7 passes:

* **two state their own house count** — Ismantorp 88 and Eketorp 75, both from the
  record's own sentence, both `countStated: true`, both radial (§7.5.2);
* **two passed on the description without a count** (`l2013-3917` Garnisonen,
  `l1980-3692` Tarsta berg): `count: null`, `countSource: "assumed"`,
  `buildings.count` named in `fallbacks`;
* **three passed on a channel that says nothing about buildings** (`l1943-7827`
  on the hand-entered citation, `l2017-1021` and `l1989-1072` on a settlement
  record inside the extent) and carry **no building spec at all** — §7.5.1's "the
  record attests buildings but states nothing about them".

Nothing here opens on `settlement`: all 27 carry `state: "cleared"`, and a pass
makes the settlement state *offerable*, not on.

## B. What would be uploaded

54 objects, 2 843 959 bytes. Every one is `application/json` with
`Cache-Control: public, max-age=3600`, from `upload.content_type_for()` /
`upload.cache_control_for()`, so the headers match the rest of the bundle.

`published now` is measured against the object as published today: *absent* (the
26 bundles with no §14 asset), *differs*, or *identical* (nothing to send — the
ETag check would skip it).

**The md5s below are reproducible only with `--generated 2026-09-23`**, which is
how this run was made. `reconstruction.json` carries its own `generated` date, so
a run on another day produces different digests for the same content. That is
expected; it is not a sign the parse changed.

| object key | bytes | md5 | published now |
|---|---|---|---|
| `v1/l1964-7416/manifest.json` | 6795 | `52d7c34f1f93e2c80d7130d6e88feb3f` | **differs** |
| `v1/l1964-7416/reconstruction.json` | 122089 | `fcd8b9f055dc05e58d3f42f24f300686` | absent |
| `v1/l1976-4254/manifest.json` | 8226 | `128f494de65485c0cdef8b906877dcb5` | **differs** |
| `v1/l1976-4254/reconstruction.json` | 510456 | `70e86982aede5515f5f6d5d933fe7062` | absent |
| `v1/l2010-1810/manifest.json` | 7848 | `368086c942ef49e99832680ad752e357` | **differs** |
| `v1/l2010-1810/reconstruction.json` | 523455 | `6f6212b04c8d843c0ee6159af75243e3` | absent |
| `v1/l1943-7827/manifest.json` | 7708 | `eea81a16e5c43ee0831d52caf4298a9d` | **differs** |
| `v1/l1943-7827/reconstruction.json` | 163166 | `16e9aea4cad00f9c3a4ec4aba2b7659c` | **differs** |
| `v1/l1957-426/manifest.json` | 7121 | `9f5c6b7edf10771c96ae2ae467bc0d82` | **differs** |
| `v1/l1957-426/reconstruction.json` | 62016 | `8cd019d625ed82a7f043fbeec3b9e52b` | absent |
| `v1/l1958-4198/manifest.json` | 7480 | `056531897e75334aa9ffae5e9f5f9bce` | **differs** |
| `v1/l1958-4198/reconstruction.json` | 84294 | `69af4bdd129184098970946576dc19d3` | absent |
| `v1/l1959-7076/manifest.json` | 7112 | `60269aedeccb99f1f938dbc466953f31` | **differs** |
| `v1/l1959-7076/reconstruction.json` | 48356 | `88dd46ee863035a1da9e9cd12f790c4b` | absent |
| `v1/l2017-1021/manifest.json` | 7712 | `881941bea4568a5e9cd693c3546ef4a0` | **differs** |
| `v1/l2017-1021/reconstruction.json` | 37769 | `53bc5eff3bd6324d4b72b2eb58ef4d6a` | absent |
| `v1/l2013-3917/manifest.json` | 7719 | `6a4f517c01294af17ce682fe16e42580` | **differs** |
| `v1/l2013-3917/reconstruction.json` | 85650 | `e1825dddb6380da92622b656acfc3e71` | absent |
| `v1/l2017-2061/manifest.json` | 7702 | `bf1f2acd84d1ed4ba35dd165bebb99bf` | **differs** |
| `v1/l2017-2061/reconstruction.json` | 113344 | `bc0660ce110c661ce233e30cf30168cf` | absent |
| `v1/l2017-4807/manifest.json` | 7726 | `4a0b936a587381c54b8a82613b24b217` | **differs** |
| `v1/l2017-4807/reconstruction.json` | 122055 | `e73265ac57a0d3f9f6bdf9159a8cfbe6` | absent |
| `v1/l2017-9140/manifest.json` | 7723 | `b1c32391472805940eb4910ae0eb90c0` | **differs** |
| `v1/l2017-9140/reconstruction.json` | 26334 | `1e2326eb7babd3592907f4c1c6abf346` | absent |
| `v1/l1941-3311/manifest.json` | 7708 | `24880d8dd8b9a62f4be214986ad4e9e0` | **differs** |
| `v1/l1941-3311/reconstruction.json` | 83597 | `71fe2579d6d2709ba8aa32eed1557b7f` | absent |
| `v1/l2016-3043/manifest.json` | 7696 | `c76980c9b71eddefe531d6b2d4368900` | **differs** |
| `v1/l2016-3043/reconstruction.json` | 72437 | `722a69ead54fe5034216282a38cfcb4a` | absent |
| `v1/l1985-6036/manifest.json` | 7727 | `1a7b9863773929b72e1318b1a7979607` | **differs** |
| `v1/l1985-6036/reconstruction.json` | 17893 | `5e11f5ec8461ae62bd863e5cb10b6d1e` | absent |
| `v1/l1958-904/manifest.json` | 7715 | `8d3720fdbbd36c674a8a013a8a62131f` | **differs** |
| `v1/l1958-904/reconstruction.json` | 14189 | `fd4c280d4aeccf52e364804a71368460` | absent |
| `v1/l1975-2084/manifest.json` | 7423 | `0d9b7ba34bb58b27cb6bc0087c68de39` | **differs** |
| `v1/l1975-2084/reconstruction.json` | 11288 | `51eaee4d0f0d5917536a17592e01c2bd` | absent |
| `v1/l2004-6478/manifest.json` | 6889 | `d73e124969e8fcd6a9e45b9a77556a78` | **differs** |
| `v1/l2004-6478/reconstruction.json` | 43072 | `414ac865783a31e518eb560884b10fac` | absent |
| `v1/l1951-8556/manifest.json` | 7573 | `4d1a22d77f5c89174278cd26dd7ecce8` | **differs** |
| `v1/l1951-8556/reconstruction.json` | 16104 | `f03700cc1cb9e6156634f223379f2d57` | absent |
| `v1/l1936-5794/manifest.json` | 7571 | `7a73674b7772b81c9ef84ab8d5135d8c` | **differs** |
| `v1/l1936-5794/reconstruction.json` | 6988 | `ac7b3a58596de053376669617a6ed25a` | absent |
| `v1/l1961-5391/manifest.json` | 7491 | `349ccd52f4433674ac154aff43198e52` | **differs** |
| `v1/l1961-5391/reconstruction.json` | 21838 | `972507cdf72c3250a9ec7a0f7c84981c` | absent |
| `v1/l1989-1072/manifest.json` | 6961 | `d3a1a79b016f6c02f7d80704a9f76c2f` | **differs** |
| `v1/l1989-1072/reconstruction.json` | 33716 | `0b5c7d1407a14ee44df916465b4eaa89` | absent |
| `v1/l1979-6892/manifest.json` | 8051 | `5a17bab9d8abddab1d16622fb0dbb2b5` | **differs** |
| `v1/l1979-6892/reconstruction.json` | 128758 | `533de30f82a3d3eee8061e4faecba68a` | absent |
| `v1/l1998-8123/manifest.json` | 7820 | `214028d21b58f41933204f4ed17240aa` | **differs** |
| `v1/l1998-8123/reconstruction.json` | 146318 | `9b1e2b4403aadf73f5b2753ae206749f` | absent |
| `v1/l2007-1020/manifest.json` | 6824 | `5d8f9998bd741d2ce5bc969b42a6186d` | **differs** |
| `v1/l2007-1020/reconstruction.json` | 14921 | `924ed9228eca522088490a9bc8c14f19` | absent |
| `v1/l1980-3692/manifest.json` | 7525 | `773b2283d81546248205e055f0ae05be` | **differs** |
| `v1/l1980-3692/reconstruction.json` | 56715 | `a38c940760c5350d791793bdbd696f55` | absent |
| `v1/l2017-1477/manifest.json` | 7493 | `16231f49a76b90e2a9c5c6a308051072` | **differs** |
| `v1/l2017-1477/reconstruction.json` | 73802 | `703852b877450444cb845239cb9d0de1` | absent |

### What would **not** be written

Every other object in every prefix: the DEM grids, `landcover*.tif`,
`water_connect_delta*.tif`, `thumbnail.png`, `rampart.json`, `shoreline.json`,
`sites.json`, `DATA-LICENSES.md`, `v1/index.json`, and the whole of
`v1/broborg/`. `upload_prepared()` can only address `manifest.json` and
`reconstruction.json` in the one slug it is handed, and raises before making a
single request if asked for anything else
(`test_an_object_outside_the_allowed_pair_is_refused_before_any_request`,
`test_an_upload_touches_no_other_object_in_the_prefix`). Nothing deletes.

## C. The attribution repair

All 27 published pilot manifests carry the dangling credit the 2026-08-30 note
found in `l1943-7827`:

```
"Fornlämningsinformation från Riksantikvarieämbetet, Kulturmiljöregistret (CC0), hämtad "
```

Each takes the date from its own bundle's `sites.json` `fetched`: **23 slugs get
`2026-08-22`**, and **4 get `2026-08-23`** (`l1943-7827`, `l1979-6892`,
`l1980-3692`, `l2017-1477`). All 27 report `filled`; none reports `conflict`,
because none of them had a date to disagree with.

`manifest.set_raa_attribution()` never overwrites a date that is already there. A
manifest whose credit disagrees with its own `sites.json` is reporting something
real — two fetches in one bundle — and the function returns `"conflict"` and
leaves the published string alone rather than picking a winner. That is why
`v1/broborg/` (`hämtad 2026-08-20`, matching its own `sites.json`) would be
untouched even if it were in the set.

## What is still blocked

The phase's two acceptance criteria require the upload and **are not met**:

1. **"every pilot slug serves a manifest with `assets.reconstruction`"** — not
   met. 26 of 27 published manifests still lack it. Nothing was uploaded.
2. **"a spot-checked fort shows the button and its interior state in a
   browser"** — not met. The app reads bundles from the published base; with the
   objects unpublished there is nothing for a browser to load, and the local
   working tree holds no DEM grids for any pilot slug, so the fort cannot be
   rendered here either.

Neither was faked or weakened. What was produced in their place:

* **The app's own reader accepts every generated file.** A temporary vitest file
  ran the app's `validateReconstruction()` (`src/overlays/reconstruction/schema.ts`)
  and `validateManifest()` (`src/state/manifest.ts`) over all 27 generated pairs,
  passing each bundle's published `sites.json` ids as `knownIds` so the §14 join
  is enforced: **55 assertions, all passing** — every document parses, every
  monument id resolves to a published record, every patched manifest declares
  `assets.reconstruction` and a `reconstruction` layer badged `conjecture`, which
  is precisely the app-side precondition for the HUD button. The file was deleted
  afterwards (this phase does not touch `app/`); it is 30 lines and is trivially
  re-created from this paragraph.
* **Pipeline-side validation** on all 27: `validate_document`,
  `validate_interior`, `validate_manifest` — twice.
* **27 new pipeline tests**, including the three that make the band trap
  impossible to "fix" by skipping validation, and one that asserts the default
  CLI run never even builds an object-store client.
* Full suites green: `pytest` 750 passed / 8 skipped (723 + 27 new),
  `npm test` 793 passed (unchanged — this phase does not touch `app/`).

## The upload, for an environment that has credentials

With `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET`
in the environment, `boto3` installed (`pip install -e 'pipeline[upload]'`), and
`<account>.r2.cloudflarestorage.com` reachable:

```bash
cd pipeline
pip install -e '.[upload]'

# 1. rehearse — reads the public base, writes only to build/republish/, uploads nothing
python3 -m fornborg_pipeline.republish --out-dir build/republish --json-out build/republish.json

# 2. the same, but against the real bucket: reads every remote ETag, sends nothing
python3 -m fornborg_pipeline.republish --out-dir build/republish --plan-upload

# 3. one slug first, and look at it in a browser before doing the other 26
python3 -m fornborg_pipeline.republish --slug l1957-426 --out-dir build/republish --upload
#    then open the app at ?site=l1957-426

# 4. the rest
python3 -m fornborg_pipeline.republish --out-dir build/republish --upload
```

`--dry-run` is the default; `--upload` is the only way to write. Steps 1 and 2
write nothing, and step 1 does not so much as construct an object-store client —
`--upload` and `--plan-upload` are the only paths that read an `R2_*` variable at
all. Step 4 re-sends nothing step 3 already uploaded: each object's ETag is
compared first, and a match is skipped.

What step 4 writes: the 54 objects in table B, each with
`Content-Type: application/json` and `Cache-Control: public, max-age=3600`, each
verified after the PUT by re-reading its ETag and comparing it to the md5 of the
file that was validated locally — a mismatch raises rather than reporting
success. Nothing else in the bucket is touched.

Afterwards, the acceptance check the brief asks for:

```bash
for slug in $(python3 -c "from fornborg_pipeline.republish import pilot_slugs; print(' '.join(pilot_slugs()))"); do
  curl -s -H 'Cache-Control: no-cache' "<publicBaseUrl>/v1/$slug/manifest.json" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['assets'].get('reconstruction'))"
done
```

## Surprises worth your attention

**1. `l1976-4254` — the biggest bundle on Gotland, plausibly Torsburgen — fails
the interior gate** despite 508 records and 4 fort records in its extract. That is
the gate doing its job: the pass rate nationally is 4.1 % (§15,
`docs/interior-survey-2026-08-30.md`), and a famous fort is not evidence.

**2. Four bundles' samplers place far more monuments than the register has
records**: `l2004-6478` places 4 155 sampled monuments from 27 records,
`l2013-3917` 2 051 from 61, `l2017-1477` 1 961 from 54, `l1943-7827` 1 215 from
127. These come from grave fields that state their own contents (§3.1). Worth a
look at frame rate on the three heaviest before they are shown to anyone; it is a
rendering question, not a data one.

**3. `l1964-7416` holds 19 registered fornborgar in one bundle**, and eight more
bundles hold between two and five (`l2010-1810` 5, `l1976-4254` 4, and six with
2). §15.1 picks the bundle's own fort by `lamningsnummer` and got the right one in
all 27 — but any future code that reaches for "the fort in this bundle" finds
several in a third of them.

**4. `v1/broborg/` is still not in `v1/index.json`**, so the site a bare visit
loads remains one the picker cannot reach (2026-08-30, unchanged). Out of scope
here and not addressed.
