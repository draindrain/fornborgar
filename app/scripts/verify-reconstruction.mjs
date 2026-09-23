/**
 * Headless check for reconstruction mode (Phase 12; contract §14).
 *
 *   node scripts/verify-reconstruction.mjs --base http://localhost:4173 --site broborg
 *
 * The unit tests pin the geometry in isolation. This asserts the things that
 * only exist once the real bundle is loaded into a real renderer, and that the
 * feature's own build sheet names as the acceptance criteria:
 *
 *   • the §14 asset loads and the mode switches on with no console error;
 *   • **monuments sit on the terrain at ×1 and at ×2.5 without drifting or
 *     changing height** — the contract §0 invariant, measured on the live scene
 *     graph rather than on a mock;
 *   • **a reload is identical** — same seed, same monuments, byte for byte;
 *   • **frame time has not regressed** — the mode is compared against marker
 *     mode in the same page, so the software rasterizer's own speed cancels;
 *   • §8's gate actually moves: at 500 CE the fort stands and no runestone is
 *     drawn; at 1050 CE the fort is a ruin and its marker is back;
 *   • **archetype H obeys its gate** (§7.5): the settlement state is offered on
 *     the record's own evidence and draws nothing where the record states no
 *     buildings, carries its caveat in the DOM when it is switched on, and —
 *     against a fort whose record *does* state its houses, patched into the
 *     response at the door — draws them off by default, inside the extent, at
 *     true metric height on the exaggerated ground, identically across loads;
 *   • **the interior selector is a control, asserted as one**: it is in the DOM,
 *     it opens on `cleared`, one *click* on it changes the state and raises the
 *     caveat, one *click* on its evidence button puts the citation on screen —
 *     and on a fort the gate fails, patched in the same way, none of it exists.
 *     That last one is the point: every other check here runs against a fort
 *     that passes, so an absence nobody asserts is an absence nobody notices.
 *     Driving the buttons rather than the state setter is the whole design —
 *     for a release this file switched reconstruction mode through `setEnabled`
 *     and never clicked the HUD button, so the button could have been broken
 *     without any check noticing.
 *   • **§7.5.2's Öland/Gotland branch is taken on `interior.tradition` and on
 *     nothing else**: the same record, the same seed and the same terrain are
 *     drawn twice, once as `limestone-ringfort` and once as `mainland`, and the
 *     two must produce different geometry while the mainland one places exactly
 *     what it placed before the branch existed. The panel has to name which of
 *     the ringfort's numbers are the register's — and the one thing the app
 *     draws more tidily than the register describes it.
 *
 * **One live page at a time.** Each patched fixture opens its own context and the
 * previous one is closed before it does. Under a software rasterizer each live
 * page holds a 4 M-vertex terrain and its far-field rings, and a fourth load
 * stacked on the same page gets the renderer killed — which reads as a failure
 * of the feature and is a failure of the harness. For the same reason the
 * teardown is bounded and ends in an explicit exit: a route handler left pending
 * against a page that has gone blocks `context.close()` forever, and a checker
 * that never returns is worse than one that fails.
 *
 * Exit code 0 only if every check passed. The report is JSON on stdout.
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = opt('base', 'http://localhost:4173').replace(/\/$/, '');
const SITE = opt('site', 'broborg');
// Generous on purpose: these runs fall back to software WebGL, where decoding
// the 1 m core grid and building the first frame takes minutes rather than
// seconds. The frame-time check below is a *ratio* against marker mode in the
// same page for exactly that reason.
const TIMEOUT_MS = Number(opt('timeout', '900000'));
const EXECUTABLE = opt('chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
/** How much slower reconstruction mode may be than marker mode before it fails. */
const FRAME_BUDGET = Number(opt('frame-budget', '1.6'));
/**
 * Frames sampled per mode. Small on purpose: these runs fall back to software
 * WebGL, where one frame of the 4 M-vertex terrain is measured in seconds, and
 * the check is a median ratio between two modes in the same page rather than an
 * absolute number — it converges long before a benchmark would.
 */
const FRAMES = Number(opt('frames', '16'));
/**
 * How long a *click* may take, which is a different number from everything else
 * here and was learned the hard way: a 120 s click timed out on this box.
 *
 * Playwright will not click an element until it is visible, enabled and stable,
 * and "stable" means the same bounding box across two consecutive animation
 * frames. Under a software rasterizer one frame of this scene is measured in
 * *seconds* — the frame-time check above reported 18.5 ms × 10³ — so two frames
 * plus a hit-test can outrun a timeout that would be absurdly generous in a real
 * browser. The waiting is the renderer's, not the control's, and shortening it
 * would only turn a slow box into a failed feature.
 */
const CLICK_TIMEOUT_MS = Number(opt('click-timeout', String(TIMEOUT_MS)));
/**
 * How many of Ismantorp's 88 houses the **mainland** layout seats on Broborg's
 * measured crest ring — the number that existed before §7.5.2's limestone branch
 * did, pinned so the branch cannot move it.
 *
 * It is low because the fixture is deliberately mismatched: 88 houses stated for
 * a 127 m ringfort, laid out inside a 65 m Uppland crest. That is the honest
 * result (§15.3: "the count is an upper bound; the terrain is not regraded to
 * meet it"), and it is exactly what makes it a good regression pin — a layout
 * change that silently loosened the placement rules would move it.
 */
const MAINLAND_PLACED = Number(opt('mainland-placed', '13'));

// Unlike verify-sites.mjs this never needs the agent proxy: the whole check runs
// against a locally previewed build with repo-relative bundles, and routing a
// localhost request through the proxy gets it refused (405) rather than served.
// A remote `--base` still gets the proxy, since then the page really is external.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
const PROXY = LOCAL ? '' : (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '');
const launchOptions = { executablePath: EXECUTABLE };
if (PROXY) launchOptions.proxy = { server: PROXY, bypass: 'localhost,127.0.0.1,::1' };

const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (error) => pageErrors.push(String(error)));

const checks = [];
function check(id, ok, detail) {
  checks.push({ id, ok: Boolean(ok), detail });
  console.error(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Median frame time over `frames` rendered frames, in milliseconds.
 *
 * Kept as a string and `eval`-ed in the page rather than passed as a function,
 * because it has to be async inside the page's own rAF loop.
 */
const MEASURE_FRAMES = `async (frames) => {
  const samples = [];
  let last = performance.now();
  await new Promise((resolve) => {
    let seen = 0;
    const tick = () => {
      const now = performance.now();
      samples.push(now - last);
      last = now;
      if (++seen >= frames) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Drop the first few: the first frame after a mode switch pays for upload.
  const warm = samples.slice(4).sort((a, b) => a - b);
  return warm[Math.floor(warm.length / 2)];
}`;

const url = `${BASE}/?site=${encodeURIComponent(SITE)}`;
let firstLoadSignature = null;
let report = {};
/** The archetype-H fixture's own context, while one is open. */
let patched = null;
/** True once the first page is closed, so the teardown does not close it twice. */
let firstContextClosed = false;

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForFunction(() => window.__terrainReady === true, null, { timeout: TIMEOUT_MS });

  const wired = await page.evaluate(() => Boolean(window.__app?.reconstruction?.layer));
  check('asset-loaded', wired, wired ? `${SITE} ships assets.reconstruction` : 'no §14 layer built');
  if (!wired) throw new Error('reconstruction layer absent — nothing further to check');

  // --- the mode switches on, and takes the markers with it -----------------
  const before = await page.evaluate(() => ({
    markers: window.__app.reconstruction.markers,
    standing: window.__app.reconstruction.standing,
  }));
  await page.evaluate(() => {
    window.__app.time.setYear(500);
    window.__app.reconstruction.setEnabled(true);
  });
  const after = await page.evaluate(() => ({
    markers: window.__app.reconstruction.markers,
    standing: window.__app.reconstruction.standing,
    vertices: window.__app.reconstruction.vertices,
    enabled: window.__app.reconstruction.layer.isEnabled,
  }));
  check('mode-on', after.enabled && after.standing > 0, `${after.standing} monuments standing`);
  check(
    'markers-replaced',
    after.markers < before.markers,
    `markers ${before.markers} → ${after.markers} (§11.1: replace, not overlay)`,
  );
  check(
    'scene-budget',
    after.vertices > 10000 && after.vertices < 4_000_000,
    `${Math.round(after.vertices / 1000)} k vertices`,
  );

  // --- §0: on the terrain at ×1 and ×2.5, no drift, no change in height ----
  // The comparison runs *inside* the page: the scene carries a few hundred
  // thousand vertices, and shipping three copies of them across the CDP bridge
  // to compare them here would cost minutes and prove nothing extra.
  const exaggerationCheck = await page.evaluate(() => {
    const app = window.__app;
    const batches = () =>
      app.reconstruction.layer.group.children
        .map((child) => child.geometry && child.geometry.getAttribute('position'))
        .filter(Boolean)
        .map((attribute) => attribute.array);

    const snapshot = (exaggeration) => {
      app.terrain.setExaggeration(exaggeration);
      app.reconstruction.layer.refreshHeights();
      return batches().map((array) => Float32Array.from(array));
    };

    const one = snapshot(1);
    const twoFive = snapshot(2.5);
    const four = snapshot(4);
    app.terrain.setExaggeration(1.5); // leave the app where it started
    app.reconstruction.layer.refreshHeights();

    let drift = 0;
    let slopeError = 0;
    let sampled = 0;
    for (let b = 0; b < one.length; b++) {
      if (!twoFive[b] || !four[b] || one[b].length !== twoFive[b].length) continue;
      for (let i = 0; i < one[b].length; i += 3) {
        // x and z must not move at all: exaggeration is a Y scale and nothing else.
        drift = Math.max(
          drift,
          Math.abs(one[b][i] - twoFive[b][i]),
          Math.abs(one[b][i + 2] - twoFive[b][i + 2]),
        );
        // y = ground·e + trueMetricHeight is exactly affine in e, so the slope
        // measured 1→2.5 must equal the one measured 1→4. A height that scaled
        // with exaggeration — the failure this whole layer is arranged to avoid —
        // is precisely what would break it, and nothing else would.
        const slopeA = (twoFive[b][i + 1] - one[b][i + 1]) / 1.5;
        const slopeB = (four[b][i + 1] - one[b][i + 1]) / 3;
        slopeError = Math.max(slopeError, Math.abs(slopeA - slopeB));
        sampled++;
      }
    }
    return { drift, slopeError, sampled, batches: one.length };
  });

  check(
    'no-lateral-drift',
    exaggerationCheck.drift === 0,
    `max |Δx|,|Δz| = ${exaggerationCheck.drift} over ${exaggerationCheck.batches} batches`,
  );
  check(
    'true-metric-height',
    exaggerationCheck.sampled > 10000 && exaggerationCheck.slopeError < 1e-3,
    `${exaggerationCheck.sampled} vertices, worst slope mismatch ` +
      `${exaggerationCheck.slopeError.toExponential(2)} m between ×1, ×2.5 and ×4`,
  );

  // --- §8: the gate moves -------------------------------------------------
  const gate = await page.evaluate(() => {
    const app = window.__app;
    const read = (year) => {
      app.time.setYear(year);
      const fort = app.reconstruction.file.monuments.find((m) => m.archetype === 'fort');
      const rune = app.reconstruction.file.monuments.find((m) => m.archetype === 'runestone');
      const meshes = app.reconstruction.layer.group.children.filter((c) => c.name.includes('fort:'));
      return {
        year,
        fortState: app.reconstruction.summary(fort.id).state,
        runeState: app.reconstruction.summary(rune.id).state,
        fortDrawn: meshes.some((m) => m.visible),
        markers: app.reconstruction.markers,
      };
    };
    const at500 = read(500);
    const at1050 = read(1050);
    app.time.setYear(500);
    return { at500, at1050 };
  });
  check(
    'fort-standing-at-500',
    gate.at500.fortState === 'standing' && gate.at500.fortDrawn,
    JSON.stringify(gate.at500),
  );
  check(
    'no-runestone-at-500',
    gate.at500.runeState === 'unbuilt',
    `runestone is ${gate.at500.runeState} at 500 CE (§8)`,
  );
  check(
    'fort-ruined-at-1050',
    gate.at1050.fortState === 'ruin' && !gate.at1050.fortDrawn,
    JSON.stringify(gate.at1050),
  );

  // --- frame time: reconstruction vs marker mode, same page ---------------
  const markerFrame = await page.evaluate(async ([body, frames]) => {
    window.__app.reconstruction.setEnabled(false);
    return await eval(`(${body})`)(frames);
  }, [MEASURE_FRAMES, FRAMES]);
  const reconstructionFrame = await page.evaluate(async ([body, frames]) => {
    window.__app.reconstruction.setEnabled(true);
    return await eval(`(${body})`)(frames);
  }, [MEASURE_FRAMES, FRAMES]);
  const ratio = reconstructionFrame / markerFrame;
  check(
    'frame-time',
    ratio <= FRAME_BUDGET,
    `${markerFrame.toFixed(2)} ms markers → ${reconstructionFrame.toFixed(2)} ms reconstruction ` +
      `(×${ratio.toFixed(2)}, budget ×${FRAME_BUDGET})`,
  );
  report.frame = { markerFrame, reconstructionFrame, ratio };

  // --- a reload is identical ----------------------------------------------
  firstLoadSignature = await page.evaluate(() => {
    const out = [];
    for (const child of window.__app.reconstruction.layer.group.children) {
      const attribute = child.geometry?.getAttribute?.('position');
      if (!attribute) continue;
      // A cheap order-sensitive digest: summing would hide a permutation.
      let hash = 2166136261;
      const array = attribute.array;
      for (let i = 0; i < array.length; i++) {
        hash ^= Math.round(array[i] * 1000) | 0;
        hash = Math.imul(hash, 16777619);
      }
      out.push(`${child.name}:${array.length}:${hash >>> 0}`);
    }
    return out.join('|');
  });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForFunction(() => window.__terrainReady === true, null, { timeout: TIMEOUT_MS });
  await page.evaluate(() => {
    window.__app.time.setYear(500);
    window.__app.reconstruction.setEnabled(true);
  });
  const secondLoadSignature = await page.evaluate(() => {
    const out = [];
    for (const child of window.__app.reconstruction.layer.group.children) {
      const attribute = child.geometry?.getAttribute?.('position');
      if (!attribute) continue;
      let hash = 2166136261;
      const array = attribute.array;
      for (let i = 0; i < array.length; i++) {
        hash ^= Math.round(array[i] * 1000) | 0;
        hash = Math.imul(hash, 16777619);
      }
      out.push(`${child.name}:${array.length}:${hash >>> 0}`);
    }
    return out.join('|');
  });
  check(
    'reload-identical',
    firstLoadSignature === secondLoadSignature && firstLoadSignature.length > 0,
    `${firstLoadSignature.split('|').length} batches`,
  );

  // --- §7.5: the interior selector, as a CONTROL --------------------------
  // Everything below drives the buttons a visitor presses, not the state setter
  // behind them, and that is deliberate. For a whole release this file switched
  // reconstruction mode on through `setEnabled` and never clicked the HUD button,
  // so the button could have been broken without any check noticing. The
  // interior selector is not getting the same hole: the state setter is checked
  // once, at the end, only to confirm that it agrees with the control.
  const selectorBefore = await page.evaluate(() => {
    const group = document.querySelector('.hud-interior');
    const states = [...document.querySelectorAll('.hud-interior-state')].map((b) => ({
      state: b.dataset.state,
      pressed: b.getAttribute('aria-pressed'),
      label: b.textContent,
    }));
    return {
      present: Boolean(group),
      hidden: group?.hidden ?? true,
      states,
      evidence: Boolean(document.querySelector('.hud-interior-evidence')),
      offered: window.__app.reconstruction.layer.settlementOffered,
      layerState: window.__app.reconstruction.layer.interiorState,
    };
  });
  check(
    'interior-selector-offered-in-the-dom',
    selectorBefore.present &&
      !selectorBefore.hidden &&
      selectorBefore.offered === true &&
      selectorBefore.evidence &&
      selectorBefore.states.length === 2 &&
      selectorBefore.states[0].state === 'cleared' &&
      selectorBefore.states[1].state === 'settlement',
    `${selectorBefore.states.map((s) => s.label).join(' / ')} + evidence button`,
  );
  check(
    'interior-opens-on-cleared',
    selectorBefore.layerState === 'cleared' &&
      selectorBefore.states.find((s) => s.state === 'cleared')?.pressed === 'true' &&
      selectorBefore.states.find((s) => s.state === 'settlement')?.pressed === 'false',
    `layer ${selectorBefore.layerState}, control agrees (§7.5.1: every fort, always)`,
  );

  // Broborg passes the §7.5.2 gate on a literature citation (channel 3) and its
  // record states nothing at all about buildings, so `interior.buildings` is
  // null and the settlement state draws **no houses**. That is the honest case
  // and it is checked first, because it is the one a future change is most
  // likely to break by "fixing".
  const meshesBefore = await page.evaluate(
    () =>
      window.__app.reconstruction.layer.group.children.filter((child) =>
        child.name.includes('#settlement'),
      ).length,
  );
  // Record the caveat *as it appears*, before the click that raises it.
  //
  // PLAN §6.1's toast lives for nine seconds. On this box one frame takes
  // eighteen, so asking the page about it after the click would routinely read a
  // toast that had already come and gone — a harness artefact reported as a
  // missing caveat. A MutationObserver fires as a microtask on the DOM change
  // itself, so this snapshots what a visitor would have seen at the instant the
  // button was pressed. It is a stricter check than reading the node later, not
  // a looser one: it also proves the caveat was raised BY the click.
  await page.evaluate(() => {
    window.__caveatSeen = null;
    const node = document.querySelector('.hud-caveat');
    if (!node) return;
    const snap = () => {
      if (node.hidden || window.__caveatSeen) return;
      window.__caveatSeen = { hidden: node.hidden, text: node.textContent };
    };
    new MutationObserver(snap).observe(node, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    });
    snap();
  });
  await page.click('.hud-interior-state[data-state="settlement"]', { timeout: CLICK_TIMEOUT_MS });
  const broborgInterior = await page.evaluate(() => {
    const app = window.__app;
    const pressed = (state) =>
      document
        .querySelector(`.hud-interior-state[data-state="${state}"]`)
        ?.getAttribute('aria-pressed');
    return {
      after: app.reconstruction.layer.group.children.filter((c) => c.name.includes('#settlement'))
        .length,
      state: app.reconstruction.layer.interiorState,
      clearedPressed: pressed('cleared'),
      settlementPressed: pressed('settlement'),
      summary: app.reconstruction.interior,
    };
  });
  check(
    'interior-switch-click-changes-state',
    broborgInterior.state === 'settlement' &&
      broborgInterior.settlementPressed === 'true' &&
      broborgInterior.clearedPressed === 'false',
    `one click on the control → ${broborgInterior.state}, and the control says so`,
  );
  check(
    'gate-obeyed-and-nothing-invented',
    broborgInterior.summary?.offered === true &&
      broborgInterior.summary?.placed === 0 &&
      meshesBefore === 0 &&
      broborgInterior.after === 0,
    `${SITE}: gate ${broborgInterior.summary?.gate}, ${broborgInterior.summary?.citations} citation(s), ` +
      `${broborgInterior.after} building meshes — the record states no buildings (§15.1)`,
  );

  // §9: the strongest caveat in the app, in the DOM, the first time archetype H
  // is switched on — and switched on by the button, so the caveat is checked on
  // the path a visitor actually takes.
  const caveat = await page.evaluate(() => {
    const node = document.querySelector('.hud-caveat');
    const live = { present: Boolean(node), hidden: node?.hidden ?? true, text: node?.textContent ?? '' };
    const seen = window.__caveatSeen;
    // Prefer what the observer caught at the moment of the click; fall back to
    // the live node when the toast is somehow still up.
    return seen ? { present: true, hidden: seen.hidden, text: seen.text, recorded: true } : live;
  });
  check(
    'settlement-caveat-in-the-dom',
    caveat.present && !caveat.hidden && /ARCHETYPE H/.test(caveat.text),
    `${caveat.recorded ? 'raised by the click: ' : 'still on screen: '}${caveat.text.slice(0, 80)}`,
  );

  // §7.5.3: one click from the houses to the sentence they came from. On Broborg
  // that sentence is not a KMR sentence at all — it is a channel-3 literature
  // citation with no lämningsnummer — so this check also pins that the panel
  // renders a channel the register never wrote.
  await page.click('.hud-interior-evidence', { timeout: CLICK_TIMEOUT_MS });
  const evidence = await page.evaluate(() => {
    const section = document.querySelector('.methods-section[data-section="interior"]');
    return {
      open: window.__app.methods.isOpen,
      present: Boolean(section),
      targeted: section?.classList.contains('is-targeted') ?? false,
      text: section?.textContent ?? '',
    };
  });
  check(
    'evidence-is-one-click-from-the-houses',
    evidence.open &&
      evidence.present &&
      evidence.targeted &&
      /Englund 2018; Sjöblom et al\. 2022/.test(evidence.text) &&
      /AD 432–542/.test(evidence.text),
    evidence.present
      ? `methods panel opened at the interior section, ${evidence.text.length} characters of it`
      : 'no interior section in the methods panel',
  );
  check(
    'cleared-never-says-nobody-was-here',
    /nobody was here/.test(evidence.text) && /absence of a surveyor/.test(evidence.text),
    '§7.5.1: the conservative state states what it is a statement about',
  );

  // And back again: two states, both reachable, neither a trap.
  await page.evaluate(() => window.__app.methods.close());
  await page.click('.hud-interior-state[data-state="cleared"]', { timeout: CLICK_TIMEOUT_MS });
  const backToCleared = await page.evaluate(() => ({
    state: window.__app.reconstruction.layer.interiorState,
    pressed: document
      .querySelector('.hud-interior-state[data-state="cleared"]')
      ?.getAttribute('aria-pressed'),
  }));
  check(
    'interior-switch-is-two-way',
    backToCleared.state === 'cleared' && backToCleared.pressed === 'true',
    `clicked back to ${backToCleared.state}`,
  );

  // --- the drawn longhouse, on a record that states its houses ------------
  // Broborg's own record does not, so the geometry is checked against a fort
  // whose record does: Ismantorp's sentence — "Innanför muren är 88 husgrunder,
  // fördelade på två grupper, en yttre med husen radiellt utgående från murens
  // insida" — as the pipeline writes it, patched into the response at the door
  // exactly as an Ismantorp bundle would deliver it. No committed data changes.
  const ISMANTORP_BUILDINGS = {
    count: 88,
    countSource: 'measured',
    countStated: true,
    layout: 'radial',
    groups: 2,
    // §7.5.2's street plan, from the same sentence and the one after it: "genom
    // fyra gator uppdelade i lika många kvarter" and "De båda husgrupperna
    // skiljs av en 2-5 m br ringgata". A mainland fort ignores both; the
    // limestone branch below draws them.
    blocks: 4,
    streetWidthM: [2, 5],
    sector: null,
    fallbacks: [],
    source: 'measured',
    template: {
      kind: 'longhouse',
      count: 1,
      lengthM: [12, 14],
      widthM: [4, 6],
      orientationDeg: null,
      aisleFraction: 0.4,
      aisleWidthM: [1.3, 2.8],
      wallHeightM: 1.2,
      roofForm: 'hipped',
      roofPitchDeg: 45,
      hipPitchDeg: 48,
      smokeVent: 'board-with-hole',
      covering: 'turf-over-birch-bark',
      walls: 'wattle-and-daub-on-stone-footing',
      trestleSpacingM: [2, 3],
      source: 'measured',
      tiers: { plan: 'measured', profile: 'derived', surface: 'assumed' },
    },
  };
  /**
   * Open the site in a **fresh context**, with the fixture patched into the
   * response at the door, and hand back the page plus what it built.
   *
   * A fresh context rather than another `page.reload`, for a reason that is
   * specific to this sandbox: the software rasterizer holds a 4 M-vertex terrain
   * and its far-field rings per live page, and stacking a third and fourth load
   * onto the page that has already been reloaded once and frame-timed twice gets
   * the renderer killed — "Target page, context or browser has been closed",
   * three quarters of the way through a fifty-minute run. One live page at a
   * time costs nothing and does not depend on how much memory the box has.
   */
  /**
   * A fort the register says nothing about: the gate fails, the state is not
   * offered, and §7.5.3's refusal is "not offered-and-labelled: not offered".
   *
   * This is the failure mode the spec most needs a test for and the easy one to
   * leave untested, because every other check here runs against a fort that
   * passes. `settlementOffered` and `evidence.gate` have to move together or the
   * app's own schema rejects the pair (§15.3), and `buildings` must go with them.
   */
  const NO_EVIDENCE = (interior) => {
    interior.settlementOffered = false;
    interior.buildings = null;
    interior.evidence.gate = 'fail';
    interior.evidence.channels = [];
    interior.evidence.terms = [];
    interior.evidence.citations = [];
  };

  const openPatched = async (mutate = (interior) => void (interior.buildings = ISMANTORP_BUILDINGS)) => {
    const patchedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const patchedPage = await patchedContext.newPage();
    // The same listeners the first page has: a patched load's console errors are
    // this run's errors too.
    patchedPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    patchedPage.on('pageerror', (error) => pageErrors.push(String(error)));
    await patchedPage.route('**/reconstruction.json*', async (route) => {
      try {
        const response = await route.fetch();
        const body = await response.json();
        if (body && body.interior) mutate(body.interior);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      } catch {
        // The page went away under the handler. Let the request take its own
        // chances rather than leaving it pending, which would hang the close.
        await route.continue().catch(() => {});
      }
    });

    await patchedPage.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await patchedPage.waitForFunction(() => window.__terrainReady === true, null, {
      timeout: TIMEOUT_MS,
    });
    const built = await patchedPage.evaluate(() => {
      window.__app.time.setYear(500);
      window.__app.reconstruction.setEnabled(true);
      const meshes = window.__app.reconstruction.layer.group.children.filter((child) =>
        child.name.includes('#settlement'),
      );
      return {
        built: meshes.length,
        visible: meshes.filter((mesh) => mesh.visible).length,
        state: window.__app.reconstruction.layer.interiorState,
        vertices: window.__app.reconstruction.vertices,
      };
    });
    return { patchedContext, patchedPage, built };
  };

  /** Close a patched context, and its route handler with it. */
  const closePatched = async (open) => {
    if (!open) return;
    await open.patchedContext.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await open.patchedContext.close().catch(() => {});
  };

  /** The digest of everything archetype H drew, for the determinism check. */
  const SETTLEMENT_SIGNATURE = () => {
    const out = [];
    for (const child of window.__app.reconstruction.layer.group.children) {
      if (!child.name.includes('#settlement')) continue;
      const attribute = child.geometry?.getAttribute?.('position');
      if (!attribute) continue;
      let hash = 2166136261;
      const array = attribute.array;
      for (let i = 0; i < array.length; i++) {
        hash ^= Math.round(array[i] * 1000) | 0;
        hash = Math.imul(hash, 16777619);
      }
      out.push(`${child.name}:${array.length}:${hash >>> 0}`);
    }
    return out.join('|');
  };

  // The first page has nothing left to check, and holding it open while another
  // renders the same terrain is what kills the renderer.
  await context.close().catch(() => {});
  firstContextClosed = true;

  patched = await openPatched();
  const patchedOff = patched.built;
  check(
    'houses-built-but-off-by-default',
    patchedOff.built > 0 && patchedOff.visible === 0 && patchedOff.state === 'cleared',
    `${patchedOff.built} building meshes, ${patchedOff.visible} drawn — §9 ships archetype H off`,
  );

  // The houses go on the same way a visitor would put them on: by clicking the
  // control. This is the check that would have caught the bug §0 of the brief
  // describes, and the reason the state setter is not used here.
  await patched.patchedPage.click('.hud-interior-state[data-state="settlement"]', {
    timeout: CLICK_TIMEOUT_MS,
  });
  const patchedOn = await patched.patchedPage.evaluate(() => {
    const app = window.__app;
    const meshes = app.reconstruction.layer.group.children.filter((child) =>
      child.name.includes('#settlement'),
    );
    const posts = app.reconstruction.layer.group.children.filter(
      (child) => child.name.includes('accent') && child.name.includes('post'),
    );
    return {
      visible: meshes.filter((mesh) => mesh.visible).length,
      posts: posts.length,
      vertices: app.reconstruction.vertices,
      standing: app.reconstruction.standing,
      summary: app.reconstruction.interior,
      pressed: document
        .querySelector('.hud-interior-state[data-state="settlement"]')
        ?.getAttribute('aria-pressed'),
    };
  });
  check(
    'houses-drawn-on-settlement',
    patchedOn.visible > 0 && patchedOn.summary.placed > 0 && patchedOn.pressed === 'true',
    `${patchedOn.summary.placed} of ${patchedOn.summary.requested} placed, ${patchedOn.visible} meshes, ` +
      `${patchedOn.posts} trestle-post batch(es) — drawn by one click on the control`,
  );
  check(
    'count-is-an-upper-bound',
    patchedOn.summary.placed <= patchedOn.summary.requested &&
      (patchedOn.summary.placed === patchedOn.summary.requested ||
        patchedOn.summary.warnings.length > 0),
    patchedOn.summary.warnings.join(' | ') || 'every stated building placed',
  );
  check(
    'scene-budget-with-houses',
    patchedOn.vertices < 4_000_000,
    `${Math.round(patchedOn.vertices / 1000)} k vertices with ${patchedOn.summary.placed} buildings ` +
      `(${Math.round(patchedOff.vertices / 1000)} k without them drawn)`,
  );
  report.settlement = {
    placed: patchedOn.summary.placed,
    requested: patchedOn.summary.requested,
    vertices: patchedOn.vertices,
  };
  // Kept for the mainland-unchanged check at the end of the run: this page is
  // the same fixture with `tradition: mainland`, and it has to have ignored the
  // street plan the limestone branch draws.
  const mainlandSummary = patchedOn.summary;

  // --- §0 again, with the houses on --------------------------------------
  const houseExaggeration = await patched.patchedPage.evaluate(() => {
    const app = window.__app;
    const arrays = () =>
      app.reconstruction.layer.group.children
        .filter((child) => child.name.includes('#settlement') && child.geometry)
        .map((child) => Float32Array.from(child.geometry.getAttribute('position').array));
    const snapshot = (exaggeration) => {
      app.terrain.setExaggeration(exaggeration);
      app.reconstruction.layer.refreshHeights();
      return arrays();
    };
    const one = snapshot(1);
    const twoFive = snapshot(2.5);
    const four = snapshot(4);
    app.terrain.setExaggeration(1.5);
    app.reconstruction.layer.refreshHeights();

    let drift = 0;
    let slopeError = 0;
    let sampled = 0;
    let tallest = 0;
    for (let b = 0; b < one.length; b++) {
      for (let i = 0; i < one[b].length; i += 3) {
        drift = Math.max(
          drift,
          Math.abs(one[b][i] - twoFive[b][i]),
          Math.abs(one[b][i + 2] - twoFive[b][i + 2]),
        );
        const slopeA = (twoFive[b][i + 1] - one[b][i + 1]) / 1.5;
        const slopeB = (four[b][i + 1] - one[b][i + 1]) / 3;
        slopeError = Math.max(slopeError, Math.abs(slopeA - slopeB));
        // The metric height each vertex keeps: y = ground·e + height.
        tallest = Math.max(tallest, one[b][i + 1] - slopeA);
        sampled++;
      }
    }
    return { drift, slopeError, sampled, tallest };
  });
  check(
    'houses-no-lateral-drift',
    houseExaggeration.drift === 0,
    `max |Δx|,|Δz| = ${houseExaggeration.drift} over ${houseExaggeration.sampled} house vertices`,
  );
  check(
    'houses-true-metric-height',
    houseExaggeration.sampled > 1000 &&
      houseExaggeration.slopeError < 1e-3 &&
      houseExaggeration.tallest > 2 &&
      houseExaggeration.tallest < 12,
    `${houseExaggeration.sampled} vertices, worst slope mismatch ` +
      `${houseExaggeration.slopeError.toExponential(2)} m between ×1, ×2.5 and ×4; ridge ` +
      `${houseExaggeration.tallest.toFixed(2)} m above its own ground`,
  );
  report.houseExaggeration = houseExaggeration;

  // --- and the patched scene is reproducible too --------------------------
  const firstHouses = await patched.patchedPage.evaluate(SETTLEMENT_SIGNATURE);
  await closePatched(patched);
  patched = await openPatched();
  await patched.patchedPage.evaluate(() => window.__app.reconstruction.setInteriorState('settlement'));
  const secondHouses = await patched.patchedPage.evaluate(SETTLEMENT_SIGNATURE);
  check(
    'houses-reload-identical',
    firstHouses.length > 0 && firstHouses === secondHouses,
    `${firstHouses.split('|').length} building batches, byte-identical across a fresh load`,
  );
  await closePatched(patched);
  patched = null;

  // --- §7.5.3: a fort with no evidence is not offered the state -----------
  // The absence is the point, and it is the easy thing to leave untested: every
  // check above runs against a fort that passes the gate, so a selector that had
  // quietly started appearing everywhere would sail through all of them. It is
  // asserted on the DOM rather than on a flag, because "not offered" is a
  // statement about what a visitor can reach — and a hidden control is still
  // reachable, which is why the app builds none at all here.
  patched = await openPatched(NO_EVIDENCE);
  const refused = await patched.patchedPage.evaluate(() => {
    const app = window.__app;
    // Ask for it anyway, by every route there is, and record what happens.
    const applied = app.reconstruction.setInteriorState('settlement');
    return {
      selectorPresent: Boolean(document.querySelector('.hud-interior')),
      states: document.querySelectorAll('.hud-interior-state').length,
      evidenceButton: Boolean(document.querySelector('.hud-interior-evidence')),
      hookSaysSelector: app.reconstruction.interiorSelector,
      offered: app.reconstruction.layer.settlementOffered,
      applied,
      layerState: app.reconstruction.layer.interiorState,
      settlementMeshes: app.reconstruction.layer.group.children.filter((child) =>
        child.name.includes('#settlement'),
      ).length,
      // Reconstruction mode itself still works — the refusal is local to the
      // interior, not a fort that fails to draw.
      standing: app.reconstruction.standing,
      section: Boolean(document.querySelector('.methods-section[data-section="interior"]')),
    };
  });
  check(
    'selector-absent-without-evidence',
    refused.selectorPresent === false &&
      refused.states === 0 &&
      refused.evidenceButton === false &&
      refused.hookSaysSelector === false,
    `gate fail ⇒ no .hud-interior, no state buttons, no evidence button in the DOM ` +
      `(§7.5.3: not offered-and-labelled — not offered)`,
  );
  check(
    'settlement-refused-without-evidence',
    refused.offered === false &&
      refused.applied === 'cleared' &&
      refused.layerState === 'cleared' &&
      refused.settlementMeshes === 0 &&
      refused.standing > 0,
    `asked for settlement anyway → ${refused.applied}, ${refused.settlementMeshes} building meshes, ` +
      `${refused.standing} monuments still standing`,
  );
  check(
    'failed-gate-still-explains-itself',
    refused.section === true,
    '§15.3: a fort that failed the gate keeps its evidence section — a fail is a statement',
  );
  await closePatched(patched);
  patched = null;

  // --- §7.5.2: the Öland / Gotland ringfort branch ------------------------
  // The same buildings block as every check above, with one field changed:
  // `interior.tradition`. That is the whole switch, and running both sides of it
  // against the same data on the same terrain is the only way to show that the
  // limestone layout reaches the renderer *and* that a mainland fort is left
  // alone — the half of the acceptance that is easy to assume and easy to get
  // wrong, because nothing in a mainland screenshot would look different if the
  // branch had quietly swallowed it.
  const RINGFORT = (interior) => {
    interior.tradition = 'limestone-ringfort';
    interior.buildings = ISMANTORP_BUILDINGS;
  };
  patched = await openPatched(RINGFORT);
  await patched.patchedPage.click('.hud-interior-state[data-state="settlement"]', {
    timeout: CLICK_TIMEOUT_MS,
  });
  const ringfort = await patched.patchedPage.evaluate(() => {
    const app = window.__app;
    const meshes = app.reconstruction.layer.group.children.filter((child) =>
      child.name.includes('#settlement'),
    );
    return {
      summary: app.reconstruction.interior,
      visible: meshes.filter((mesh) => mesh.visible).length,
      pressed: document
        .querySelector('.hud-interior-state[data-state="settlement"]')
        ?.getAttribute('aria-pressed'),
    };
  });
  const ringfortHouses = await patched.patchedPage.evaluate(SETTLEMENT_SIGNATURE);
  check(
    'ringfort-branch-drawn-from-the-record',
    ringfort.summary.tradition === 'limestone-ringfort' &&
      ringfort.summary.layout === 'radial' &&
      ringfort.summary.blocks === 4 &&
      Array.isArray(ringfort.summary.streetWidthM) &&
      ringfort.visible > 0 &&
      ringfort.summary.placed > 0 &&
      ringfort.pressed === 'true',
    `${ringfort.summary.placed} of ${ringfort.summary.requested} placed in ` +
      `${ringfort.summary.blocks} blocks with a ` +
      `${(ringfort.summary.streetWidthM ?? []).join('–')} m street — drawn by one click on ` +
      `the control`,
  );
  check(
    'ringfort-count-is-still-an-upper-bound',
    ringfort.summary.placed <= ringfort.summary.requested &&
      (ringfort.summary.placed === ringfort.summary.requested ||
        ringfort.summary.warnings.length > 0),
    ringfort.summary.warnings.join(' | ') || 'every stated building placed',
  );
  // The branch actually reached the geometry: the same record, the same seed and
  // the same terrain, laid out two different ways.
  check(
    'ringfort-geometry-differs-from-the-mainland-layout',
    ringfortHouses.length > 0 && firstHouses.length > 0 && ringfortHouses !== firstHouses,
    `${ringfortHouses.split('|').length} ringfort batches against ` +
      `${firstHouses.split('|').length} mainland ones, on identical data`,
  );
  // §7.5.2's honesty clause, in the DOM rather than in a comment: the panel has
  // to say the layout is a tradition branch and not a lower bar for evidence,
  // and it has to own the one thing the app draws more tidily than the register
  // describes it.
  await patched.patchedPage.click('.hud-interior-evidence', { timeout: CLICK_TIMEOUT_MS });
  const ringfortPanel = await patched.patchedPage.evaluate(() => {
    const section = document.querySelector('.methods-section[data-section="interior"]');
    return (section?.textContent ?? '').replace(/\s+/g, ' ');
  });
  check(
    'ringfort-panel-says-which-numbers-are-the-registers',
    /limestone ringfort/i.test(ringfortPanel) &&
      /radial blocks/i.test(ringfortPanel) &&
      /never a lower bar/i.test(ringfortPanel) &&
      /4 blocks/.test(ringfortPanel) &&
      /2–5 m/.test(ringfortPanel) &&
      /oregelbunden/.test(ringfortPanel),
    `${ringfortPanel.length} characters naming the tradition, the four blocks, the 2–5 m ` +
      `street and the irregularity the app does not draw`,
  );
  report.ringfort = {
    placed: ringfort.summary.placed,
    requested: ringfort.summary.requested,
    blocks: ringfort.summary.blocks,
    streetWidthM: ringfort.summary.streetWidthM,
  };
  await closePatched(patched);
  patched = null;

  // --- the other reference ringfort, drawn as it parses -------------------
  // Eketorp's record counts ~75 house foundations and states no grouping and no
  // street plan, and the house size it gives two sentences later is not
  // reachable from the sentence that counts them — KMR's own text for that fort
  // has lost a full stop mid-sentence. So the plan is §6.H's 20–40 m literature
  // default, and the check is that the app *says* so rather than passing the
  // default off as the register's: `fallbacks` names it and the shortfall is a
  // warning, not 75 houses forced into a courtyard that will not hold them.
  const EKETORP = (interior) => {
    interior.tradition = 'limestone-ringfort';
    interior.buildings = {
      ...ISMANTORP_BUILDINGS,
      count: 75,
      groups: null,
      blocks: null,
      streetWidthM: null,
      template: null,
      fallbacks: ['buildings.template.lengthM', 'buildings.template.widthM'],
    };
  };
  patched = await openPatched(EKETORP);
  await patched.patchedPage.click('.hud-interior-state[data-state="settlement"]', {
    timeout: CLICK_TIMEOUT_MS,
  });
  const eketorp = await patched.patchedPage.evaluate(() => {
    const app = window.__app;
    return {
      summary: app.reconstruction.interior,
      visible: app.reconstruction.layer.group.children.filter(
        (child) => child.name.includes('#settlement') && child.visible,
      ).length,
    };
  });
  await patched.patchedPage.click('.hud-interior-evidence', { timeout: CLICK_TIMEOUT_MS });
  const eketorpPanel = await patched.patchedPage.evaluate(() => {
    const section = document.querySelector('.methods-section[data-section="interior"]');
    return (section?.textContent ?? '').replace(/\s+/g, ' ');
  });
  check(
    'ringfort-without-a-street-plan-draws-none-and-says-so',
    eketorp.summary.tradition === 'limestone-ringfort' &&
      eketorp.summary.blocks === null &&
      eketorp.summary.streetWidthM === null &&
      eketorp.summary.requested === 75 &&
      eketorp.summary.placed > 0 &&
      eketorp.summary.placed < 75 &&
      eketorp.summary.warnings.length > 0 &&
      eketorp.visible > 0 &&
      /buildings\.template\.lengthM/.test(eketorpPanel) &&
      /20–40 m default/.test(eketorpPanel) &&
      !/blocks by streets/.test(eketorpPanel),
    `${eketorp.summary.placed} of 75 placed at §6.H's default plan, no invented street plan, ` +
      `and the panel names the fallback`,
  );
  report.eketorp = {
    placed: eketorp.summary.placed,
    requested: eketorp.summary.requested,
    fallbacks: eketorp.summary.fallbacks,
  };
  await closePatched(patched);
  patched = null;

  // --- and the mainland fort the branch must not have touched -------------
  // `report.settlement` above is the *same* fixture with `tradition: mainland`,
  // carrying the same `blocks` and `streetWidthM` the limestone run used. It has
  // to ignore both and place exactly what it placed before this branch existed.
  check(
    'mainland-layout-unchanged',
    report.settlement.placed === MAINLAND_PLACED &&
      mainlandSummary.tradition === 'mainland' &&
      mainlandSummary.blocks === 4 &&
      mainlandSummary.layout === 'radial',
    `${report.settlement.placed} placed (${MAINLAND_PLACED} before the branch), tradition ` +
      `${mainlandSummary.tradition} — the same street plan in the data, and the mainland ` +
      `layout drew none of it`,
  );

} catch (error) {
  check('run', false, error instanceof Error ? error.message : String(error));
}

check('no-page-errors', pageErrors.length === 0, pageErrors.join(' | '));
check('no-console-errors', consoleErrors.length === 0, consoleErrors.join(' | '));

// Teardown that cannot hang, because a checker that never exits is worse than
// one that fails: a route handler left pending against a page that has gone away
// blocks `context.close()` indefinitely, and a crashed renderer makes every one
// of these throw. So each step swallows its own error and the lot is raced
// against a deadline, after which the report is printed and the process ends.
await Promise.race([
  (async () => {
    if (patched) {
      await patched.patchedContext.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await patched.patchedContext.close().catch(() => {});
    }
    if (!firstContextClosed) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  })(),
  new Promise((resolve) => setTimeout(resolve, 60000)),
]);

report = { base: BASE, site: SITE, checks, ...report };
console.log(JSON.stringify(report, null, 2));
// Explicit, and the last thing that happens: a stray browser handle must not
// keep the run alive after its verdict is written.
process.exit(checks.every((c) => c.ok) ? 0 : 1);
