/**
 * Headless load check for a set of sites (Phase 9b verification).
 *
 *   node scripts/verify-sites.mjs --base http://localhost:4173 \
 *        --site l1943-7827 --site broborg
 *
 * Loads each `?site=` deep link in Chromium and asserts what the app itself
 * promises: the scene reaches `window.__terrainReady`, the far-field ring chain
 * finishes (`ringsStatus.done`), and nothing lands on the console as an error or
 * a failed request. Console errors are the point — a bundle whose optional
 * assets quietly fail still renders terrain, so "it looked fine" is not a check.
 *
 * Exit code 0 only if every site passed. The report is JSON on stdout so a
 * caller can read it without parsing prose.
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
function optAll(name) {
  return args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
}

const BASE = opt('base', 'http://localhost:4173').replace(/\/$/, '');
const SITES = optAll('site');
const TIMEOUT_MS = Number(opt('timeout', '120000'));
const EXECUTABLE = opt('chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const REQUIRE_RINGS = !args.includes('--no-rings');

if (SITES.length === 0) {
  console.error('usage: verify-sites.mjs --base <url> --site <slug> [--site <slug> ...]');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const results = [];

for (const site of SITES) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  const url = `${BASE}/?site=${encodeURIComponent(site)}`;
  const record = { site, url, ready: false, rings: null, errors: [], webglMissing: false };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await page.waitForFunction(() => window.__terrainReady === true, null, { timeout: TIMEOUT_MS });
    record.ready = true;

    if (REQUIRE_RINGS) {
      // The ring chain runs after readiness by design (lazy, inside-out), so it
      // is waited for separately rather than folded into the ready flag.
      await page.waitForFunction(
        () => window.__app?.rings?.done === true,
        null,
        { timeout: TIMEOUT_MS },
      );
    }
    record.rings = await page.evaluate(() => window.__app?.rings ?? null);
    record.manifest = await page.evaluate(() => {
      const m = window.__app?.manifest;
      return m ? { id: m.site?.id, assets: Object.keys(m.assets ?? {}), rings: m.grids?.rings?.length ?? 0 } : null;
    });
    record.siteIndex = await page.evaluate(() => window.__app?.siteIndex?.count ?? null);
  } catch (error) {
    record.errors.push(`load: ${error instanceof Error ? error.message : String(error)}`);
  }

  record.errors.push(...pageErrors.map((e) => `pageerror: ${e}`));
  record.errors.push(...consoleErrors.map((e) => `console.error: ${e}`));
  record.errors.push(...failedRequests.map((e) => `request: ${e}`));
  record.ok = record.ready && record.errors.length === 0 && (!REQUIRE_RINGS || record.rings?.done === true);
  results.push(record);

  console.error(
    `${record.ok ? 'PASS' : 'FAIL'} ${site}: ready=${record.ready} ` +
      `rings=${record.rings ? `${record.rings.loaded}/${record.rings.declared}${record.rings.farWater ? '+farwater' : ''}` : 'n/a'} ` +
      `errors=${record.errors.length}`,
  );
  for (const error of record.errors) console.error(`     ${error}`);

  await context.close();
}

await browser.close();
console.log(JSON.stringify({ base: BASE, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
