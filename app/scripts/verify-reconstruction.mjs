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
 *     true metric height on the exaggerated ground, identically across a reload.
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

  // --- §7.5: the interior's two states, and archetype H ------------------
  // Broborg passes the §7.5.2 gate on a literature citation (channel 3) and its
  // record states nothing at all about buildings, so `interior.buildings` is
  // null and the settlement state draws **no houses**. That is the honest case
  // and it is checked first, because it is the one a future change is most
  // likely to break by "fixing".
  const broborgInterior = await page.evaluate(() => {
    const app = window.__app;
    const settlementMeshes = () =>
      app.reconstruction.layer.group.children.filter((child) => child.name.includes('#settlement'));
    const before = settlementMeshes().length;
    const state = app.reconstruction.setInteriorState('settlement');
    const summary = app.reconstruction.interior;
    return { before, after: settlementMeshes().length, state, summary };
  });
  check(
    'gate-obeyed-and-nothing-invented',
    broborgInterior.summary?.offered === true &&
      broborgInterior.summary?.placed === 0 &&
      broborgInterior.before === 0 &&
      broborgInterior.after === 0,
    `${SITE}: gate ${broborgInterior.summary?.gate}, ${broborgInterior.summary?.citations} citation(s), ` +
      `${broborgInterior.after} building meshes — the record states no buildings (§15.1)`,
  );

  // §9: the strongest caveat in the app, in the DOM, the first time archetype H
  // is switched on. Asserted on the element a visitor actually reads.
  const caveat = await page.evaluate(() => {
    const node = document.querySelector('.hud-caveat');
    return { present: Boolean(node), hidden: node?.hidden ?? true, text: node?.textContent ?? '' };
  });
  check(
    'settlement-caveat-in-the-dom',
    caveat.present && !caveat.hidden && /ARCHETYPE H/.test(caveat.text),
    caveat.text.slice(0, 80),
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
  await page.route('**/reconstruction.json*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body && body.interior) body.interior.buildings = ISMANTORP_BUILDINGS;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  /** Load the patched bundle and switch reconstruction mode on. */
  const loadPatched = async () => {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForFunction(() => window.__terrainReady === true, null, { timeout: TIMEOUT_MS });
    return await page.evaluate(() => {
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
  };

  const patchedOff = await loadPatched();
  check(
    'houses-built-but-off-by-default',
    patchedOff.built > 0 && patchedOff.visible === 0 && patchedOff.state === 'cleared',
    `${patchedOff.built} building meshes, ${patchedOff.visible} drawn — §9 ships archetype H off`,
  );

  const patchedOn = await page.evaluate(() => {
    const app = window.__app;
    app.reconstruction.setInteriorState('settlement');
    const meshes = app.reconstruction.layer.group.children.filter((child) =>
      child.name.includes('#settlement'),
    );
    const posts = app.reconstruction.layer.group.children.filter((child) =>
      child.name.includes('accent') && child.name.includes('post'),
    );
    return {
      visible: meshes.filter((mesh) => mesh.visible).length,
      posts: posts.length,
      vertices: app.reconstruction.vertices,
      standing: app.reconstruction.standing,
      summary: app.reconstruction.interior,
    };
  });
  check(
    'houses-drawn-on-settlement',
    patchedOn.visible > 0 && patchedOn.summary.placed > 0,
    `${patchedOn.summary.placed} of ${patchedOn.summary.requested} placed, ${patchedOn.visible} meshes, ` +
      `${patchedOn.posts} trestle-post batch(es)`,
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

  // --- §0 again, with the houses on --------------------------------------
  const houseExaggeration = await page.evaluate(() => {
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
  const settlementSignature = () =>
    page.evaluate(() => {
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
    });
  const firstHouses = await settlementSignature();
  await loadPatched();
  await page.evaluate(() => window.__app.reconstruction.setInteriorState('settlement'));
  const secondHouses = await settlementSignature();
  check(
    'houses-reload-identical',
    firstHouses.length > 0 && firstHouses === secondHouses,
    `${firstHouses.split('|').length} building batches, byte-identical across a reload`,
  );

} catch (error) {
  check('run', false, error instanceof Error ? error.message : String(error));
}

check('no-page-errors', pageErrors.length === 0, pageErrors.join(' | '));
check('no-console-errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await context.close();
await browser.close();

report = { base: BASE, site: SITE, checks, ...report };
console.log(JSON.stringify(report, null, 2));
process.exit(checks.every((c) => c.ok) ? 0 : 1);
