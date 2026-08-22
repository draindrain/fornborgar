/**
 * Headless check for the v1.6 §13 far field (docs/far-field-vegetation.md §7).
 *
 *   node scripts/verify-far-field.mjs --base http://localhost:4173 \
 *        --site l1958-4198 --out /tmp/shots
 *
 * Complements verify-sites.mjs: loads one site, waits for the full ring chain
 * (patiently — a software-GL sandbox can take minutes per ring), then asserts
 * the §13 contract from the outside: the legend declares a farField, the lazy
 * billboard population is empty until the layer is first enabled and non-empty
 * after, the far tint follows the same toggle, and no console error lands
 * anywhere along the way. With --out it also saves an orbit and a near-ground
 * screenshot — the §7 visual pass wants eyes on the seam and the billboards in
 * both camera modes, and numbers alone have missed things before (scale-out
 * §7.2).
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = opt('base', 'http://localhost:4173').replace(/\/$/, '');
const SITE = opt('site');
const OUT = opt('out');
const RING_WAIT_MS = Number(opt('ring-timeout', String(25 * 60 * 1000)));
const EXECUTABLE = opt('chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');

if (!SITE) {
  console.error('usage: verify-far-field.mjs --base <url> --site <slug> [--out <dir>]');
  process.exit(2);
}

// Same proxy note as verify-sites.mjs: Chromium needs the proxy handed over
// explicitly, bypassing localhost so the page still comes from the local server.
const PROXY = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
const launchOptions = { executablePath: EXECUTABLE };
if (PROXY) launchOptions.proxy = { server: PROXY, bypass: 'localhost,127.0.0.1,::1' };

const browser = await chromium.launch(launchOptions);
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});

await page.goto(`${BASE}/?site=${SITE}`);

// Rings stream in behind readiness; poll rather than waitForFunction so slow
// environments show progress instead of a silent timeout.
let state = null;
const started = Date.now();
while (Date.now() - started < RING_WAIT_MS) {
  await page.waitForTimeout(30000);
  state = await page.evaluate(() => ({
    ready: window.__terrainReady === true,
    rings: window.__app?.rings ?? null,
  }));
  console.error(`${Math.round((Date.now() - started) / 1000)}s ${JSON.stringify(state)} errors:${errors.length}`);
  if (state.ready && state.rings?.done) break;
}

const record = { site: SITE, ok: false, state, errors };
if (!state?.ready || !state?.rings?.done) {
  console.log(JSON.stringify({ ...record, failure: 'rings never completed' }, null, 2));
  await browser.close();
  process.exit(1);
}

record.before = await page.evaluate(() => ({
  farField: window.__app.landcover.farField ? window.__app.landcover.farField.classes.length : null,
  farCountBeforeEnable: window.__app.landcover.farCount,
  farWater: window.__app.rings.farWater,
  farLandcover: window.__app.rings.farLandcover,
}));

await page.evaluate(() => window.__app.landcover.setEnabled(true));
await page.waitForTimeout(15000);
record.after = await page.evaluate(() => ({
  farCount: window.__app.landcover.farCount,
  nearCount: window.__app.landcover.count,
  tintOn: window.__app.landcover.farTint?.enabled ?? null,
}));

if (OUT) {
  // A software rasterizer pushing ~10⁵ instances saturates the main thread, and
  // Playwright's capture waits on it (fonts, compositing) — give it minutes,
  // not its 30 s default.
  const shot = { timeout: 180000 };
  await page.evaluate(() => window.__app.setCamera([6500, 2600, 6500], [0, 0, 0]));
  await page.waitForTimeout(10000);
  await page.screenshot({ ...shot, path: `${OUT}/${SITE}_orbit.png` });
  await page.evaluate(() => window.__app.setCamera([0, 30, 0], [-4000, 30, -3000]));
  await page.waitForTimeout(10000);
  await page.screenshot({ ...shot, path: `${OUT}/${SITE}_near.png` });
  record.screenshots = [`${OUT}/${SITE}_orbit.png`, `${OUT}/${SITE}_near.png`];
}

// The §13 contract, asserted from the outside. A site with no farField block
// passes trivially (feature off is a valid state, never an error).
const declaresFarField = record.before.farField !== null;
record.ok =
  errors.length === 0 &&
  (!declaresFarField ||
    (record.before.farCountBeforeEnable === 0 && // lazy until first enable
      record.after.farCount > 0 &&
      record.after.tintOn === true));

console.log(JSON.stringify(record, null, 2));
await browser.close();
process.exit(record.ok ? 0 : 1);
