> **Scratch diagnostic note, 2026-08-30.** A record of one publishing repair and a
> survey of the pilot bucket. It documents object-store state, not the design of
> anything in this repository, and may be deleted before any pull request.

# Why the Reconstruction button was missing on the fort you were looking at

## Summary

Broborg is published on R2 twice, under two different slugs, and only one of them
had been patched.

* `v1/broborg/` — the reference bundle, loaded by a bare visit to the app
  (`DEFAULT_SITE_ID = "broborg"` in `app/src/state/loader.ts`). Patched by an
  earlier session; already working.
* `v1/l1943-7827/` — the Phase-9b pilot rebuild of the same fort under contract
  v1.5, and the one the "Browse forts" picker links to as `?site=l1943-7827`.
  This one had **no** `assets.reconstruction`, so the app had nothing to declare
  a reconstruction from and correctly withheld the button.

That second bundle is what you were looking at. It is now patched, verified live,
and the button's precondition is satisfied for both slugs. The remaining 26 pilot
sites are all still unpatched — surveyed below, none touched.

## `assets.reconstruction`, before and after

Fetched from `https://pub-9ea507a776bc4f54b159e7bf7095a2fa.r2.dev`
(`publicBaseUrl` in `pipeline/r2-config.json`).

| bundle | before this run | after this run |
|---|---|---|
| `v1/broborg/` | `"reconstruction": "reconstruction.json"` present | unchanged — not touched by this run |
| `v1/l1943-7827/` | **absent** | `"reconstruction": "reconstruction.json"` present |

Raw asset keys as fetched at the start of the run:

```
broborg      assets: landcover, landcoverLegend, rampart, reconstruction, shoreline, sites, waterConnect
             layers: terrain, sites, water, landcover, palisade, reconstruction
l1943-7827   assets: landcover, landcoverLegend, rampart, shoreline, sites, waterConnectDelta
             layers: terrain, sites, water, landcover, palisade
```

And the same two objects re-fetched from R2 after the upload, with
`Cache-Control: no-cache`:

```
LIVE manifest assets: landcover, landcoverLegend, rampart, reconstruction, shoreline, sites, waterConnectDelta
LIVE manifest layers: terrain=measured sites=measured water=model landcover=model
                      palisade=conjecture reconstruction=conjecture
LIVE assets.reconstruction = reconstruction.json
LIVE reconstruction: site=l1943-7827 schemaVersion=1 monuments=127 generated=2026-08-30
join check against live sites.json: orphans = []
```

## How the file was generated

`reconstruct.run()` could not be used: it resolves the slug through
`sites.get_site()`, which only knows the hand-curated `SITES` dict, and
`l1943-7827` is a registry site that is not in it. So a small driver called the
pure functions directly — `build_document()`, `write_reconstruction()` (which runs
`validate_document()`), then `add_reconstruction_asset()` and `write_manifest()`
(which runs `validate_manifest()`), plus an explicit second `validate_manifest()`
call. Input was the **published** `v1/l1943-7827/sites.json`, downloaded from R2,
not anything in the working tree. No network, no rasters, no credentials in the
generation step.

Parser output on the published records:

```
== l1943-7827: 127/127 records -> archetypes (0 unmapped types)
     cairn                   7      grave-field            31
     clearance-cairn         1      mound                  12
     farmstead               4      runestone               2
     field-boundary          2      stone-setting          58
     fire-cracked-mound      9
     fort                    1
-- parsed: plan 91%, height 90%, stone 87%, form 91%, kerb 55%, pits 31%
-- grave fields 28/31 state a count; samplers place 1215 further monuments
-- join: 127 monuments, 127 site records, 0 orphan ids
   validate_manifest() OK
```

Every one of the 127 monument ids joins to a record in that bundle's own
`sites.json`. The §14 rules in `manifest.py` pass: the `reconstruction` layer
exists and carries `provenance: "conjecture"`, and `assets.sites` is present
alongside `assets.reconstruction`.

One useful cross-check: the generated file is **byte-identical to the published
`v1/broborg/reconstruction.json`** apart from two lines.

```
194c194
<     "generated": "2026-08-26",          (broborg)
---
>     "generated": "2026-08-30",          (l1943-7827)
9041c9041
<     "site": "broborg"
---
>     "site": "l1943-7827"
```

That is the expected result — see the divergence section — and it is good
evidence the parser saw the same register text the earlier session did.

## What was uploaded

Exactly two objects, both through `upload.py`'s own `put_object()` /
`content_type_for()` / `cache_control_for()` helpers, so the headers match the
rest of the bundle. Dry run first, then the real upload. No TIFFs, no
`index.json`, no other slug, no deletions.

```
mode=DRY RUN — nothing sent
  v1/l1943-7827/manifest.json         7698 bytes  md5=61c263b26f201b8850b98e09449cb81f
    Content-Type='application/json' Cache-Control='public, max-age=3600'
    remote ETag before: c3be082c90230103198d2cd9911b0991
  v1/l1943-7827/reconstruction.json 161604 bytes  md5=d815d38566ac436f42a118e1235c3101
    Content-Type='application/json' Cache-Control='public, max-age=3600'
    remote ETag before: None            (object did not exist)

mode=LIVE UPLOAD
  v1/l1943-7827/manifest.json       -> PUT done. ETag after: 61c263b26f201b8850b98e09449cb81f  (matches local md5)
  v1/l1943-7827/reconstruction.json -> PUT done. ETag after: d815d38566ac436f42a118e1235c3101  (matches local md5)
```

Re-fetched over HTTPS afterwards, both parse as JSON and the ETags agree:

```
manifest.json        http=200 bytes=7698    ETag "61c263b26f201b8850b98e09449cb81f"
reconstruction.json  http=200 bytes=161604  ETag "d815d38566ac436f42a118e1235c3101"
Content-Type: application/json   Cache-Control: public, max-age=3600
```

A bucket listing confirms the blast radius — `manifest.json` rewritten and
`reconstruction.json` created at 19:58 today; every other object in the prefix
still carries its original 08-22/08-23 timestamp:

```
== v1/l1943-7827/  (21 objects)
   manifest.json                     7698  2026-08-30T19:58:16Z  61c263b26f201b8850b98e09449cb81f
   reconstruction.json             161604  2026-08-30T19:58:21Z  d815d38566ac436f42a118e1235c3101
   sites.json                      192260  2026-08-23T01:54:34Z  703f08d938e29fb2dd7db21bc37f9df6
   DATA-LICENSES.md / rampart.json / shoreline.json / landcover*  2026-08-23T01:54Z
   dem_*.tif / water_connect_delta*.tif / thumbnail.png           2026-08-22T08:48Z
```

`v1/broborg/` was not written to at all in this run; its `manifest.json` and
`reconstruction.json` still carry the earlier session's 2026-08-30T18:39
timestamps.

## Did Phase 12 actually ship to Pages?

Yes. `https://fornborgar.drnz.se/` serves `/assets/index-DdTMrsSV.js` (875,595
bytes, HTTP 200), and that bundle contains the string `hud-mode-button` (1
occurrence) along with 27 occurrences of `reconstruction`. So the Pages
deployment is not the problem and never was — the missing button was purely a
data-side omission in one bundle.

(`https://drnz.se/analytics.js`, referenced from the page, could not be fetched
from this container — the egress proxy returns 403 for that host. That is an
artifact of this environment, not a finding about the site.)

## The other 26 pilot slugs — survey only, nothing patched

Every slug in `pipeline/pilot-sites.json` except `l1943-7827`. All 26 manifests
fetched HTTP 200. **None** has `assets.reconstruction`; **all** have
`assets.sites`.

| slug | HTTP | `assets.reconstruction` | `assets.sites` | other assets | manifest `provenance.generated` | naive `validate_manifest()` |
|---|---|---|---|---|---|---|
| `l1964-7416` | 200 | **absent** | present | landcover, landcoverLegend | 2026-08-22T23:53:22+00:00 | **fails** — 2 grid(s) outside band |
| `l1976-4254` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:53:23+00:00 | **fails** — 1 grid(s) outside band |
| `l2010-1810` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:53:26+00:00 | **fails** — 3 grid(s) outside band |
| `l1957-426` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:54:36+00:00 | **fails** — 1 grid(s) outside band |
| `l1958-4198` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:54:20+00:00 | OK |
| `l1959-7076` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:54:43+00:00 | **fails** — 1 grid(s) outside band |
| `l2017-1021` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:55:16+00:00 | OK |
| `l2013-3917` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:55:09+00:00 | OK |
| `l2017-2061` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:55:23+00:00 | OK |
| `l2017-4807` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:56:22+00:00 | OK |
| `l2017-9140` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:56:03+00:00 | OK |
| `l1941-3311` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:56:21+00:00 | OK |
| `l2016-3043` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:57:26+00:00 | OK |
| `l1985-6036` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:57:04+00:00 | OK |
| `l1958-904` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:57:26+00:00 | **fails** — 3 grid(s) outside band |
| `l1975-2084` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-22T23:58:34+00:00 | OK |
| `l2004-6478` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:58:14+00:00 | **fails** — 1 grid(s) outside band |
| `l1951-8556` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:58:14+00:00 | **fails** — 7 grid(s) outside band |
| `l1936-5794` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:59:16+00:00 | **fails** — 7 grid(s) outside band |
| `l1961-5391` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:59:01+00:00 | **fails** — 7 grid(s) outside band |
| `l1989-1072` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:59:03+00:00 | **fails** — 1 grid(s) outside band |
| `l1979-6892` | 200 | **absent** | present | landcover, landcoverLegend, rampart, shoreline, waterConnectDelta | 2026-08-23T00:00:04+00:00 | **fails** — 1 grid(s) outside band |
| `l1998-8123` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:59:49+00:00 | **fails** — 3 grid(s) outside band |
| `l2007-1020` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-22T23:59:45+00:00 | **fails** — 2 grid(s) outside band |
| `l1980-3692` | 200 | **absent** | present | landcover, landcoverLegend, rampart | 2026-08-23T00:01:09+00:00 | **fails** — 3 grid(s) outside band |
| `l2017-1477` | 200 | **absent** | present | landcover, landcoverLegend, shoreline, waterConnectDelta | 2026-08-23T00:00:36+00:00 | OK |

All 26 were generated in one batch between 2026-08-22T23:53 and 2026-08-23T00:01,
which is the same run that produced `l1943-7827` (2026-08-23T00:00:27). The three
distinct asset shapes reflect what each site's terrain supports, not a fault: 13
carry `shoreline` + `waterConnectDelta` + `rampart`, 11 carry `rampart` but no
water layer, one (`l2017-1477`, the deliberate no-polygon case) carries neither
`rampart` nor water, and one carries water but no `rampart`.

## What one patch costs, and why the other 26 are not a three-second job

Measured wall clock per slug, on three of the 26 rehearsed dry (generated and
validated locally, **nothing uploaded**):

| step | time |
|---|---|
| fetch that bundle's `sites.json` + `manifest.json` from R2 | 1.0–1.2 s |
| `build_document()` + `validate_document()` (54–127 records) | 0.05 s |
| whole driver run incl. interpreter start, write, `validate_manifest()` | 0.4 s |
| the two `put_object()` calls plus their `head_object()` checks | ~5 s |

So roughly **8 seconds of machine time per slug**, and the full set of 26 is well
under five minutes of compute. That is not the real cost.

The real cost is this: **15 of the 26 fail `validate_manifest()`** if you run the
driver as written for `l1943-7827`. The failures look alarming and are not:

```
l1964-7416: rings[2]: elevation range -1.0..228.0 m is outside [-10.0, 200.0] m
            RH 2000 for this site — suspect a vertical-datum shift (PLAN.md §2.1)
l1957-426:  rings[3]: elevation range -16.0..102.0 m is outside [-10.0, 200.0] m ...
```

`manifest._band_for()` resolves the height band by looking `manifest.site.id` up
in the in-process `SITES` dict. A registry slug is not in it, so it falls back to
`DEFAULT_ELEVATION_BAND` — which is *Broborg's* band, `[-10, 200]`. Actual Swedish
terrain elsewhere leaves that band immediately: Västernorrland at 342 m, a Skåne
ring dipping to -58 m. The batch itself never hits this because `build_site.py:164`
registers each registry site with `NATIONAL_ELEVATION_RANGE = (-100.0, 2200.0)`
first. Confirmed by doing the same in the driver:

```
l1964-7416: naive validate FAILS -> rings[2]: elevation range -1.0..228.0 m is outside [-10.0, 200.0] ...
l1964-7416: with NATIONAL_ELEVATION_RANGE (-100.0, 2200.0) -> validate OK
l1957-426:  naive validate FAILS -> rings[3]: elevation range -16.0..102.0 m is outside [-10.0, 200.0] ...
l1957-426:  with NATIONAL_ELEVATION_RANGE (-100.0, 2200.0) -> validate OK
```

Every one of the 15 sits inside the national band, so none of them is a real
datum problem. But a batch patch must register each site's config before
validating, or it will refuse 15 sites for the wrong reason — and, worse, a
driver that skipped validation to get past it would publish 26 manifests nobody
checked. The per-slug column in the table above says which 15.

`l1943-7827` passed the naive check only by luck: its terrain *is* Broborg's
terrain, so Broborg's band happened to fit. The validation it passed was
therefore stricter than the batch's own, not weaker.

## Surprises worth your attention

**1. The two Broborgs hold identical register records, but are different vintages
of everything else.** This is the most important thing here, so plainly: the
`sites.json` in the two bundles are byte-identical apart from one line.

```
diff (sorted, pretty-printed):
2c2
<     "fetched": "2026-08-20",     (v1/broborg/)
---
>     "fetched": "2026-08-23",     (v1/l1943-7827/)
```

Both carry 127 records, both start at `L1940:6792`, and the grids agree exactly —
same origin `E 665810 / N 6627880`, same six DEM grids at 1/2/4/8/16/32 m, same
per-grid elevation ranges to the decimetre. That is why the generated
`reconstruction.json` came out identical to Broborg's. For reconstruction-mode
purposes the two are interchangeable.

For everything else they are **not**, and the manifests differ in ways that are
contract-version differences, not noise:

* `v1/broborg/` publishes `waterConnect: water_connect.tif`; the pilot publishes
  `waterConnectDelta: water_connect_delta.tif` — "sea-connectivity shipped as
  int16 delta vs. the DEM (contract §12)", a processing step only the pilot's
  provenance lists.
* The pilot carries ring land-cover (`landcover_ring3..6.tif`) that
  `v1/broborg/` does not.
* `provenance.generated`: `2026-08-20T13:14:24Z` (broborg) vs
  `2026-08-23T00:00:27Z` (pilot). The SGU and land-cover source fetches differ
  by days too.
* The pilot bundle has a `thumbnail.png`; `v1/broborg/` has none, and
  `v1/broborg/` is absent from `v1/index.json`, which lists exactly the 27 pilot
  slugs. So the default site a bare visit loads is not a site the picker can
  reach — consistent with the two-slug split that caused this whole confusion.

Treat them as two different builds of one fort. Anything you verify on
`?site=broborg` about water or land-cover should be re-checked on
`?site=l1943-7827` before you believe it there.

**2. The pilot bundle's KMR attribution string is missing its date.** In
`v1/l1943-7827/manifest.json`, published and unchanged by me:

```
"Fornlämningsinformation från Riksantikvarieämbetet, Kulturmiljöregistret (CC0), hämtad "
```

against `v1/broborg/`'s `... hämtad 2026-08-20`. The `kmr_fetched` value was
empty when that manifest was written. The bundle's own `sites.json` does carry
`"fetched": "2026-08-23"`, so the date exists and simply did not reach the
attribution line. It is cosmetic — a visible attribution string ending in a
dangling "hämtad" — and it is upstream of this repair, in whatever built the
pilot batch. I did not fix it: doing so would mean rewriting a manifest field
that has nothing to do with the reconstruction asset. Worth a look before the
pilot bundles are shown to anyone.

**3. A survey caveat, so the numbers are not over-read.** The first pass of the
26-slug survey returned HTTP 403 for every slug through Python's `urllib`, which
would have read as "the whole pilot set is missing". It was the container's
egress proxy, not R2: the identical requests through `curl` returned 200 for all
26. The table above is the `curl` pass. If you re-run any of this from a
different environment and see uniform 403s, suspect the proxy first.

## What I did not do

No pipeline, application, or existing documentation file was modified. No pull
request was opened. Of the 26 unpatched pilot slugs, none was written to — they
were fetched read-only, and the three rehearsed for timing were generated and
validated in a temp directory outside the repository and discarded.
