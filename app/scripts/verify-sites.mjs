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

import { describeEnvironmental, triageConsoleErrors } from './console-triage.mjs';

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

// Chromium does not inherit HTTPS_PROXY the way curl and node do, so hand it the
// proxy explicitly when one is set, bypassing localhost so the page itself still
// comes from the local preview server. The proxy CA is already in the browser
// NSS store, so TLS verification stays on.
//
// Note for anyone debugging a failure here: in a sandbox that denies the browser
// outbound network entirely, every external host fails as ERR_CONNECTION_RESET
// with or without this setting — including hosts the session can reach with
// curl. That is the sandbox, not the object host or its CORS policy, and the
// way to tell them apart is to curl the same URL.
//
// A **localhost** base skips the proxy entirely rather than relying on the
// bypass list, which is what verify-night-sky.mjs and verify-reconstruction.mjs
// already do and for the same measured reason: handing Chromium a proxy and
// trusting `bypass` has been observed not to take, and a localhost request that
// reaches this sandbox's egress proxy comes back `405 Method Not Allowed`. That
// read as four console errors and a site that never became ready — a failure of
// the harness wearing the mask of a failure of the app.
const PROXY = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
const launchOptions = { executablePath: EXECUTABLE };
if (PROXY && !LOCAL) {
  launchOptions.proxy = { server: PROXY, bypass: 'localhost,127.0.0.1,::1' };
  console.error(`(routing browser traffic through ${PROXY}, bypassing localhost)`);
}

const browser = await chromium.launch(launchOptions);
const results = [];

for (const site of SITES) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  // Transport failures and HTTP failures are kept apart. Only the first kind
  // can ever be excused as environmental, and only for a resource the app is
  // documented not to depend on — see scripts/console-triage.mjs.
  const requestFailures = [];
  const httpFailures = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push({ text: msg.text(), url: msg.location()?.url });
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('requestfailed', (request) => {
    requestFailures.push({ url: request.url(), errorText: request.failure()?.errorText ?? '' });
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    // A missing national index is a documented first-class state, not a fault:
    // a repo-relative build ships two fixtures and has nothing to pick between,
    // so the app asks once, gets a 404, and leaves the picker off.
    if (new URL(response.url()).pathname.endsWith('/index.json')) return;
    httpFailures.push(`${response.status()} ${response.url()}`);
  });

  // `&debug=1` keeps the model layers off, so this stays a check of *loading*
  // rather than a render benchmark — the software rasterizer these runs use
  // saturates on the ~10^5 vegetation instances the default view now shows.
  const url = `${BASE}/?site=${encodeURIComponent(site)}&debug=1`;
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

  const triage = triageConsoleErrors({ consoleErrors, requestFailures });
  record.errors.push(...pageErrors.map((e) => `pageerror: ${e}`));
  record.errors.push(...triage.pageErrors.map((e) => `console.error: ${e.text}`));
  record.errors.push(
    ...triage.unexpectedRequestFailures.map((r) => `request: ${r.url} — ${r.errorText}`),
  );
  record.errors.push(...httpFailures.map((e) => `request: ${e}`));
  // Not a verdict: the part of the run no commit in this repo can fix.
  record.environment = { excusedResourceFailures: triage.environmental };
  for (const line of describeEnvironmental(triage.environmental)) {
    console.error(`NOTE environment — ${line}`);
  }
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
