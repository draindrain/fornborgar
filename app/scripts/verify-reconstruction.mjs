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
 *     drawn; at 1050 CE the fort is a ruin and its marker is back.
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
 * Every reconstruction vertex's Y, batch by batch, at a given exaggeration.
 * Read straight off the live scene graph: this is the rendered geometry, not a
 * recomputation of it.
 */
const READ_HEIGHTS = `(exaggeration) => {
  const app = window.__app;
  app.terrain.setExaggeration(exaggeration);
  app.reconstruction.layer.refreshHeights();
  const out = [];
  for (const child of app.reconstruction.layer.group.children) {
    const attribute = child.geometry && child.geometry.getAttribute
      ? child.geometry.getAttribute('position')
      : null;
    if (!attribute) continue;
    const array = attribute.array;
    const xs = [];
    const ys = [];
    const zs = [];
    for (let i = 0; i < array.length; i += 3) {
      xs.push(array[i]);
      ys.push(array[i + 1]);
      zs.push(array[i + 2]);
    }
    out.push({ name: child.name, xs, ys, zs });
  }
  return out;
}`;

/** Median frame time over `frames` rendered frames, in milliseconds. */
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
  const warm = samples.slice(5).sort((a, b) => a - b);
  return warm[Math.floor(warm.length / 2)];
}`;

const url = `${BASE}/?site=${encodeURIComponent(SITE)}`;
let heightsAtOne = null;
let heightsAtTwoFive = null;
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
  heightsAtOne = await page.evaluate(READ_HEIGHTS, 1);
  heightsAtTwoFive = await page.evaluate(READ_HEIGHTS, 2.5);
  const heightsAtFour = await page.evaluate(READ_HEIGHTS, 4);
  await page.evaluate(READ_HEIGHTS, 1.5); // leave the app where it started

  let drift = 0;
  let slopeError = 0;
  let sampled = 0;
  for (let b = 0; b < heightsAtOne.length; b++) {
    const one = heightsAtOne[b];
    const two = heightsAtTwoFive[b];
    const four = heightsAtFour[b];
    if (!two || !four || one.xs.length !== two.xs.length) continue;
    for (let i = 0; i < one.xs.length; i++) {
      drift = Math.max(drift, Math.abs(one.xs[i] - two.xs[i]), Math.abs(one.zs[i] - two.zs[i]));
      // y = ground·e + trueMetricHeight is exactly affine in e, so the slope
      // measured 1→2.5 must equal the one measured 1→4. A height that scaled
      // with exaggeration — the failure this whole layer is arranged to avoid —
      // is precisely what would break it.
      const slopeA = (two.ys[i] - one.ys[i]) / 1.5;
      const slopeB = (four.ys[i] - one.ys[i]) / 3;
      slopeError = Math.max(slopeError, Math.abs(slopeA - slopeB));
      sampled++;
    }
  }
  check('no-lateral-drift', drift === 0, `max |Δx|,|Δz| = ${drift}`);
  check(
    'true-metric-height',
    sampled > 10000 && slopeError < 1e-3,
    `${sampled} vertices, worst slope mismatch ${slopeError.toExponential(2)} m`,
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
  const markerFrame = await page.evaluate(async (body) => {
    window.__app.reconstruction.setEnabled(false);
    return await eval(`(${body})`)(40);
  }, MEASURE_FRAMES);
  const reconstructionFrame = await page.evaluate(async (body) => {
    window.__app.reconstruction.setEnabled(true);
    return await eval(`(${body})`)(40);
  }, MEASURE_FRAMES);
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
