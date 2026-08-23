# Data licenses — the sky (`data/sky/`)

Unlike every other directory under `data/`, this one is not per-site and is not built by
`pipeline/`. The sky is the same sky at every fornborg, so the star catalogue ships inside
the app and is committed here rather than published to the object host with the site
bundles. It is built by `app/scripts/make-star-catalogue.mjs`.

## Star catalogue — `stars-v6.bin`, `stars-v6.json`

- **Source:** *XHIP: An Extended Hipparcos Compilation* — Anderson E., Francis C. (2012),
  **VizieR V/137D** — a compilation built on the ESA *Hipparcos* astrometric catalogue
  (ESA 1997, ESA SP-1200).
- **Obtained via:** the `data/stars.6.json` file published with **d3-celestial** (Olaf
  Frohn), **BSD-3-Clause**, npm package `d3-celestial@0.7.35`. This is the form of XHIP
  obtainable without a VizieR query, and the conversion script reads it directly from the
  npm tarball.
- **License:** the underlying Hipparcos/XHIP data is freely usable with acknowledgement;
  the d3-celestial derivation carries the BSD-3-Clause notice above, whose attribution
  requirement is satisfied by this file and by the app's methods panel.
- **Voluntary attribution:** *"Star positions: XHIP (Anderson & Francis 2012, VizieR
  V/137D), from the Hipparcos catalogue (ESA 1997), via d3-celestial (BSD-3-Clause)"*.
- **Selection applied:** every star to visual magnitude 6.0 — the naked-eye limit, and so
  the right limit for a sky with no light pollution in it. 5 044 stars.
- **Processing applied:** GeoJSON longitude (−180…180) rewrapped to right ascension
  (0…360); sorted brightest first; packed column-major little-endian as
  `float32 ra`, `float32 dec`, `int32 hip`, `int16 mag × 100`, `int16 bv × 1000`.
  Positions are **J2000, geometric, with no proper motion** — the derivation does not
  carry it. The app precesses them to the epoch the year slider selects; what proper
  motion's absence costs, star by star, is stated in `docs/night-sky.md` §4 and in the
  methods panel.

The column list lives in `stars-v6.json` and is read **by name**, so a future catalogue
that adds `pmRa`/`pmDec` columns is a data change with no app change.

## The moon's face — not an asset

`src/sky/lunarFeatures.ts` carries fourteen maria and four ray craters as catalogued
selenographic coordinates and diameters, and the renderer draws them as soft-edged discs.
That is a **schematic of the moon's face, not an image of it**, it is source code rather
than data, and no lunar imagery is redistributed by this repository.
