# LandClimII REVEALS estimates — one time window

Two verbatim files from the LandClimII archive, read by `fornborg_pipeline.reveals`:

| File | What it holds |
|---|---|
| `TW5.RV.estimates.jun21.csv` | REVEALS **mean** land-cover estimates, time window TW5 |
| `TW5.RV.standarderrors.jun21.csv` | The matching **standard errors**, same cells, same columns |

**Time window TW5 = 1,200–1,700 cal BP ≈ 250–750 CE** — the Iron Age window the
fornborg model works in.

**Grid:** Europe, 1°×1° cells addressed by their centre in `lonDD` / `latDD`
(whole degree + 0.5). Rows whose coordinates read `#N/A` are cells outside the
geographic product and are skipped on load.

**Columns:** one per pollen taxon plus the aggregated land-cover types, of which
this pipeline reads the three headline ones — **OL** (open land), **ET**
(evergreen trees) and **ST** (summer-green trees), each a per-cent of cell cover.

A cell being **absent** from these files is a real, documented result rather than a
gap in our fetch: no pollen record existed there to feed REVEALS. 25 of the 41
cells containing Swedish fornborgar are absent, Broborg's included
(`docs/vegetation-zones.md` §3.1).

## Source and licence

Data — **CC-BY-4.0**:

> Fyfe, R.M., Githumbi, E., Trondmann, A.-K., Mazier, F., Nielsen, A.B., Poska,
> A., Sugita, S., Woodbridge, J., LandClimII contributors & Gaillard, M.-J.
> (2021): A full Holocene record of transient gridded vegetation cover in Europe.
> PANGAEA, https://doi.org/10.1594/PANGAEA.937075

Descriptive paper:

> Githumbi, E., et al. (2022): European pollen-based REVEALS land-cover
> reconstructions for the Holocene. *Earth System Science Data* 14:1581–1619,
> doi:10.5194/essd-14-1581-2022

Fetched 2026-08-22.

## Why only these two files

The archive holds 50 files — means and standard errors for 25 Holocene time
windows. Only the **TW5 pair** is committed, because the land-cover model reads
exactly one time window and never interpolates between them
(`docs/vegetation-zones.md` §3.2). The remaining 48 files are reproducible from the
DOI above.

The files are committed byte-for-byte as published: no reformatting, no column
pruning, no re-encoding.
