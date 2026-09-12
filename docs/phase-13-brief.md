# Phase 13 — the fort interior: buildings, and what a visitor sees inside the wall

**How to use this.** Each phase below is a self-contained brief for one subagent. Phases 1–6 are
sequential: each assumes the previous one is merged. Phase 7 is independent and can run at any
time. Prepend **§0 Shared context** to every phase brief you hand out — a subagent starting cold
will otherwise repeat mistakes this project has already paid for.

Run this after `claude/3d-models-historic-sites-toggle-tezvj6` is merged to `main`.

---

## §0 Shared context — prepend to every phase

You are working on **fornborgar**, an interactive 3D reconstruction of Swedish hillforts
(`fornborgar`) built from open Swedish government data: Lantmäteriet LiDAR terrain, the
Riksantikvarieämbetet cultural-heritage register (KMR), and SGU geology. The app renders one
fort at a time as real terrain, with the registered monuments around it, under a time slider.

**The project's governing principle, which matters more than any feature in this brief:** the app
distinguishes what is *measured* from what is *modelled* from what is *conjectured*, and says so
to the visitor. Every layer carries a `provenance` of `measured` / `model` / `conjecture`
(`pipeline/fornborg_pipeline/manifest.py`), conjectural layers surface a one-line caveat the
first time they are switched on (PLAN.md §6.1), and the parser records a `source` of `parsed` or
`assumed` per field plus a `fallbacks` list and a `parseConfidence` whenever it defaults
something (`pipeline/fornborg_pipeline/reconstruct.py`). **Nothing is invented silently.** A
change that makes the app look better by quietly asserting something the record does not support
is a regression, however good the screenshot.

**Read before writing code:**
- `docs/reconstruction-mode.md` — the specification for reconstruction mode. §6 is the archetype
  catalogue, §7 is the Broborg worked example, §8 the time gate, §9 the honesty requirements,
  §11 the owner decisions (several still open).
- `docs/data-formats.md` §14 — the `reconstruction.json` contract.
- `PLAN.md` §6.1 — the model/conjecture labelling rules.
- `docs/interior-survey-2026-08-30.md` and `.json` — a national measurement of interior-building
  evidence across all 1 304 registered forts, made specifically to inform this work.

**Key invariant (contract §0).** Monuments stand *on* the vertically exaggerated ground while
keeping their true metric height. They live in the scene graph, not inside `terrain.group`, and
re-sample ground height when the exaggeration changes (`refreshHeights()`). Any new geometry must
honour this — check it at ×1 and ×2.5.

**Verify your own work in the real app, not only in unit tests.** `app/scripts/verify-*.mjs` are
headless Playwright checks; Chromium is at `/opt/pw-browsers` and `PLAYWRIGHT_BROWSERS_PATH` is
already set (never run `playwright install`). Software WebGL is slow — allow minutes, not
seconds. **A lesson worth inheriting:** `verify-reconstruction.mjs` drives
`window.__app.reconstruction.setEnabled(true)` and never clicks the HUD button, so for a whole
release the button could have been broken without any check noticing. When you add a control,
assert the *control*, in the DOM, not just the state it sets.

**Do not** open a pull request unless asked. Commit to the branch you are given. Do not modify
published data in Cloudflare R2 unless your phase explicitly says to.

---

## §1 — Close §11 decision 7: write the specification before the code

**Goal.** The interior of a fort is currently untouched: what a visitor sees inside the wall is
bare measured terrain. `docs/reconstruction-mode.md` §11 decision 7 ("which Broborg interior
state is the default") is still marked open, and §11 decision 2 deliberately left the farmstead
archetype out of the first pass. This phase closes both on paper, so the following phases have
something to implement against. **This project writes the spec first — every previous phase did,
and the research doc is the reason the code is defensible.**

**Read first:** §7.5 (the Broborg interior, occupied and dated), §6.H (the farmstead archetype),
§11 decisions 2 and 7, and the whole of `docs/interior-survey-2026-08-30.md`.

**What the survey found, which is the input to the decision:**
- **4.1 %** of 1 304 registered forts show defensible interior-building evidence (54 forts);
  **2.1 %** state it without hedging; **88.4 %** show neither building language nor a settlement
  record inside their own extent.
- It is **consistent with** the Mälardalen survey rather than contradicting it: ~17–21 % of a
  ~17 % Middle-Iron-Age subset predicts ~3 % nationally against 4.1 % measured.
- Öland (23.8 %) and Gotland (9.4 %) are enriched ~3.6× over the mainland (3.4 %) — a real
  typological signal, but only 13 of 54 positives, so it is a branch for 106 forts, not a new
  national default.
- The rule's **strong tier holds, the medium tier does not**: in a fornborg description
  `stensträng` and bare `terrass` usually mean the rampart or a cultivation terrace outside it,
  and `bebygg*` usually means modern buildings destroyed the site.
- **A caution to carry into the spec:** not one of Uppsala county's 79 forts carries a strong-tier
  term, yet the Mälardalen survey says 5–6 Uppland forts have house terraces. That is field
  observation which never reached the KMR text. A register-derived rule *undercounts*, and
  Broborg's own excavated settlement layer (AD 432–542) would score zero on it. The register
  measures what a surveyor wrote down, not what was there.

**Do:**
1. Amend §7.5 and §11 decision 7 to record the decision in the same voice the other answered
   decisions use (see decisions 1, 3, 4, 6 for the house style: strike the question, state what
   was answered, name the qualification the build added).
   **The decision to record, unless you find grounds to argue otherwise in the sources:** default
   every fort to **`cleared`** — measured terrain, SGU soil class, stone-picked patches only where
   KMR places them, nothing added — with **`settlement`** as a per-fort state offered where the
   record supports it, never as a national default. Reasoning: drawing longhouses in every fort
   would be archetype-H inference applied 1 304 times, the weakest evidence in the taxonomy
   multiplied, and wrong for ~96 % of forts on the register's own evidence.
2. Amend §11 decision 2 to record that archetype H is now in scope, and under what constraint.
3. Specify the **interior evidence tiers** that phase 2 will implement, naming the exact terms:
   strong (`husgrund*`, `husterrass*`, `hustomtning*`, `grophus*`, `boplatsvall*`,
   `boplatsborg*`), the negation and exterior-placement rules, the modern-building discard
   (`sentida`, `torp`, `villa`, a 19xx date), and the hedge flag (`möjlig`, `trolig`,
   `-liknande`). `docs/interior-survey-2026-08-30.md` §6 has all of it with worked examples.
4. Specify the §14 contract additions in `docs/data-formats.md`: a per-site interior block and a
   per-monument farmstead parameter block. Additive only — `schemaVersion` stays 1, a missing
   field means "feature off", exactly as every optional asset already behaves.
5. Write the honesty requirement explicitly: a fort in the `settlement` state must be able to
   show the visitor *the KMR sentence it is drawn from*, and a fort with no evidence must not
   offer the state at all — or must offer it labelled as pure interpretation. Decide which, and
   say why, in the doc.

**Acceptance:** a reader of §7.5 + §11 can tell exactly what the app will draw inside a fort,
from what evidence, and what it will refuse to draw. No code changes in this phase.

---

## §2 — Pipeline: emit interior evidence per fort

**Goal.** Put the §1 evidence rule into `reconstruct.py` so every site's `reconstruction.json`
carries its own interior verdict and the citation behind it.

**Read first:** `pipeline/fornborg_pipeline/reconstruct.py` (especially `build_document`, the
`source`/`fallbacks`/`parseConfidence` machinery, and `validate_document`),
`docs/interior-survey-2026-08-30.json` (one row per fort, with `hits[].verdict`,
`strongTermsClean`, `refinedInteriorEvidence` — the reference implementation of the rule, and
your regression fixture).

**Do:**
1. Parse the fort's own `beskrivning` for the §1 strong-tier terms, applying the negation,
   exterior-placement, modern-building and hedge rules. Sentence scope, not a character window —
   KMR writes the negation on either side of the noun.
2. Also run the spatial test: settlement-type KMR records (`Boplats`, `Boplatsområde`,
   `Boplatslämning övrig`, `Husgrund, förhistorisk/medeltida`, `Boplatsvall`, `Terrassering`)
   whose position falls inside the fort's own extent. Point-in-polygon where the geometry allows.
   **Note the systematic gap the survey found:** Ismantorp and Eketorp return *zero* settlement
   records, because KMR files their house foundations inside the fort's own record rather than as
   separate lämningar. The two measures are a union, never a cross-check.
3. Emit into `reconstruction.json`: the interior state the site qualifies for, the matched terms,
   the **verbatim KMR sentence** for each, the hedge flag, and which measure fired. Where the text
   states a house *count* or *dimensions* (Ismantorp's "88 husgrunder", Träbyborg's "ca 50"),
   parse them out — they beat any archetype default.
4. Where nothing qualifies, say so positively (state `cleared`, evidence empty) rather than
   omitting the block, so the app can tell "no evidence" from "old bundle".
5. Extend `validate_reconstruction` in `manifest.py` / `validate_document` so a malformed interior
   block fails the build rather than reaching the app.

**Acceptance:** re-running over the committed Broborg bundle reproduces the survey's verdict for
Broborg; running over the 54 survey positives reproduces all 54; `pipeline/tests/` gains cases for
negation, exterior placement, modern cue and hedge, using the real description text in the survey
JSON. Pin the coverage percentages as a regression target the way `test_reconstruct.py` already
does.

---

## §3 — App: archetype H, the longhouse

**Goal.** Draw the farmstead archetype. It is parsed today and never rendered
(`app/src/overlays/reconstruction/layer.ts:39` — "deliberately out of scope").

**Read first:** §6.H of `docs/reconstruction-mode.md` — it is unusually specific and it is built on
Näsman's critical review of Scandinavian house reconstructions. Follow it rather than a general
sense of what an Iron Age house looks like. The four details it singles out as commonly got
wrong: **the roof is hipped, not gabled**, and shallow hips are a recurring reconstruction error;
**the central aisle takes less than half the house breadth** in the 3rd–8th centuries — a
5th-century Uppland house is *underbalanced*, aisle ~40 % of breadth, 1.3–2.8 m; **trestle spacing
is not uniform** along the building, closer in the byre; and **data from earlier Iron Age houses
cannot be used uncritically** for the 5th-century house this app needs.

**Do:**
1. Build the longhouse in `app/src/overlays/reconstruction/`, alongside `fort.ts` and
   `graveField.ts`, following those files' structure and their habit of naming the spec section
   each decision comes from.
2. Default geometry: 40 × 9 m on house II at Genesmon (~350–600 CE), hipped roof — the roof
   easily twice the height of the wall below it, sweeping down all four sides. Plus `grophus`
   (sunken-floored workshops) and one or two ancillary buildings, with the yard, outdoor hearth
   and well from §6.H's layout heuristic.
3. Every parameter that came from the record uses the record; everything else is an archetype
   default and must appear in `fallbacks` with `source: assumed`. §6.H's own table already marks
   which is which (building count, position and orientation are *assumed*; that is the honest
   answer and it must stay visible).
4. Honour contract §0: true metric height on exaggerated ground, `refreshHeights()` on
   exaggeration change, in the scene not in `terrain.group`.
5. Respect the §8 time gate: nothing before `builtCE`, marker fallback at or after `abandonedCE`.

**Acceptance:** monuments do not drift or change height between ×1 and ×2.5; a reload with the
same seed is identical; the §7.6 scene budget still holds. Extend `verify-reconstruction.mjs`
rather than writing a parallel checker.

---

## §4 — App: the interior selector

**Goal.** The two-state interior switch from §7.5: `cleared` ⇄ `settlement`.

**Read first:** `app/src/ui/hud.ts` (`enableModeSwitch` / `setMode` — the existing hard toggle and
the reasoning comment above it), `app/src/ui/controls.ts` (`addReconstructionControls` and the
vitrified-band toggle, which is the closest existing analogue: a contested question rendered as a
*state*, not a verdict), `app/src/ui/sitePanel.ts` (`appendReconstruction`, where a monument
accounts for itself), `app/src/main.ts` (`applyReconstructionSettings`, the single funnel).

**Do:**
1. Add the state, defaulting to `cleared`. Follow the vitrification precedent exactly: both states
   rendered, neither claimed, the disagreement stated in the panel.
2. Offer `settlement` per §1's rule. Where a fort has evidence, show the **KMR sentence** in the
   methods panel as the citation. Where it does not, follow whatever §1 decided — and make the
   difference visible to the visitor either way.
3. Caveat on first enable, per PLAN.md §6.1, badged `conjecture`.
4. **Assert the control in the DOM in a headless check** — see the §0 lesson. A test that only
   calls the state setter would not have caught the bug that prompted this work.

**Acceptance:** the switch is reachable and correct on a fort with evidence, absent or clearly
marked on one without, and a visitor can get from the rendered houses to the sentence they came
from in one click.

---

## §5 — Öland and Gotland: the ringfort branch

**Goal.** The limestone ringforts are a different building tradition and must not render as an
empty Mälardalen boulder rampart.

**Read first:** §2 of `docs/reconstruction-mode.md` (Ismantorp: 127 m diameter, ~400 m of wall,
nine gates, 88–95 house foundations in radial blocks around a central open space; Eketorp II:
~80 m diameter, 53 internal cells; Eketorp III: ~100 timber-framed houses) and §4 of the survey.
**Heed §2's caution on Eketorp's famous 4.8 m wall height** — it does not appear in the site's own
reference literature and the trail leads to a 2007 popular article, not the excavation monograph.
Treat it as a figure in circulation, not a measurement. §9's criticism of the on-site
reconstruction is relevant here too.

**Do:** a radial-block interior layout for forts the record identifies as ringforts, driven by the
house count and dimensions parsed in §2 where KMR states them — for Ismantorp the register's own
text gives the 88 figure, so nothing needs inventing. 106 forts qualify; do not let this branch
leak into the mainland default.

**Acceptance:** Ismantorp and Eketorp render with interiors that match their own register
descriptions; a mainland fort is unaffected.

---

## §6 — Republish every pilot bundle

**Goal.** 26 of the 27 published pilot bundles still lack the §14 reconstruction asset, so those
forts show no Reconstruction button at all. After phases 2–5 they will also need the new interior
block. This phase makes the published data match the code.

**This phase needs credentials and network egress** — `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET` from the environment, and reachability of both
`<account>.r2.cloudflarestorage.com` and the public base in `pipeline/r2-config.json`. Run it in
the environment that has them. If either is missing, stop and report rather than improvising.

**Three traps, all paid for already:**
1. **`reconstruct.run()` will not take a registry slug.** It resolves through `get_site()`, which
   only knows the hand-curated `SITES` dict. Write a driver around `build_document()` and
   `add_reconstruction_asset()`.
2. **15 of 26 will fail `validate_manifest()` for the wrong reason.** `manifest._band_for()` falls
   back to `DEFAULT_ELEVATION_BAND = (-10, 200)` — *Broborg's* band — for a slug it does not know,
   and real Swedish terrain leaves that immediately. Register each site's config with
   `NATIONAL_ELEVATION_RANGE` first, as `build_site.py:164` does. **Do not "fix" this by skipping
   validation**: that would publish manifests nobody checked.
3. **Broborg is published twice** — `v1/broborg/` (what a bare visit loads, `DEFAULT_SITE_ID`) and
   `v1/l1943-7827/` (the pilot rebuild, what the picker links to). They are different vintages of
   everything except the register records. Both are already patched; do not assume one stands for
   the other.

**Do:** generate from each bundle's *published* `sites.json`, validate, then upload only the
changed JSON objects through `upload.py`'s own `put_object` / `content_type_for` /
`cache_control_for`. No TIFFs, no `index.json`, no deletions. Dry-run first. Re-fetch and confirm.
While you are there, fix the pilot manifests' KMR attribution string, which currently ends in a
dangling `"hämtad "` with no date, though the bundle's own `sites.json` carries `"fetched"`.

**Acceptance:** every pilot slug serves a manifest with `assets.reconstruction`, and a spot-checked
fort shows the button and its interior state in a browser.

---

## §7 — Independent: does interior evidence track fort confidence?

**Goal.** The survey's own recommended follow-up, and the homework §11 decision 6 already owes.

Every rate in the survey is over *all registered fornborgar*, including the two-thirds Olausson's
criteria would reject as not genuinely fortified. `fortConfidence` is implemented and scores all
four Mälardalen criteria per fort, but its distribution across the 1 304 has never been examined.
Re-run the survey's measure over the high-confidence subset alone — **a join on
`docs/interior-survey-2026-08-30.json`, which carries every slug, not another 2.3 GB download.**

If interior-building evidence concentrates in high-confidence forts the way the Mälardalen figure
implies, the default interior could reasonably become confidence-dependent rather than uniform —
which would reopen §1's decision with better evidence. Report either way; a null result is worth
knowing.
