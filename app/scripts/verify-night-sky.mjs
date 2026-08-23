/**
 * Headless check for the night sky (docs/night-sky.md §8).
 *
 *   node scripts/verify-night-sky.mjs --base http://localhost:4173 \
 *        --site broborg --out /tmp/shots
 *
 * Asserts from the outside what the unit tests cannot: that the sky is wired
 * into the app at all, that the sun's disc, the moon and the stars appear and
 * disappear when they should, that the water shares the sky's uniforms rather
 * than a copy of them, and that nothing logs an error along the way. With
 * `--out` it also saves the five configurations the §8 visual pass wants eyes
 * on — numbers have missed things before.
 *
 * Two things worth knowing before editing this:
 *
 *  • `&debug=1` turns the model layers off, which is the only way a software
 *    rasterizer gets through a real site in reasonable time. Water is switched
 *    back on by hand, because the reflection is half the point.
 *  • The orbit rig clamps at 88° of polar angle and **cannot look up**. Every
 *    shot aimed at the sky goes through first person.
 */

import { mkdirSync } from 'node:fs';

import { chromium } from 'playwright';

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = opt('base', 'http://localhost:4173').replace(/\/$/, '');
const SITE = opt('site', 'broborg');
const OUT = opt('out');
const READY_MS = Number(opt('timeout', String(20 * 60 * 1000)));
const EXECUTABLE = opt('chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');

// Same proxy note as verify-far-field.mjs: Chromium needs the proxy handed over
// explicitly. Unlike that check, this one is only ever pointed at a local
// server with local data, so the proxy is skipped entirely for a localhost base
// — handing it one and relying on the bypass list has been observed to stall
// the load indefinitely, which looks exactly like a hung app and is not one.
const PROXY = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
const launchOptions = { executablePath: EXECUTABLE };
if (PROXY && !LOCAL) launchOptions.proxy = { server: PROXY, bypass: 'localhost,127.0.0.1,::1' };

const browser = await chromium.launch(launchOptions);
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

await page.goto(`${BASE}/?site=${SITE}&debug=1`);

// Poll rather than wait silently: a software rasterizer can take minutes per
// site, and a stalled load and a slow one look identical from the outside.
const started = Date.now();
let ready = false;
while (!ready && Date.now() - started < READY_MS) {
  ready = await page
    .waitForFunction(() => window.__terrainReady === true, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!ready) console.error(`${Math.round((Date.now() - started) / 1000)}s waiting for terrain, errors:${errors.length}`);
}
if (!ready) {
  console.log(JSON.stringify({ site: SITE, ok: false, failure: 'terrain never became ready', errors }, null, 2));
  await browser.close();
  process.exit(1);
}
const starsLoaded = await page
  .waitForFunction(() => window.__app?.sky?.stars?.().loaded === true, null, { timeout: 180000 })
  .then(() => true)
  .catch(() => false);
check(starsLoaded, 'the star catalogue never loaded');

const wiring = await page.evaluate(() => {
  window.__app.water.setEnabled(true);
  const sky = window.__app.sky;
  const water = window.__app.water.layer;
  return {
    stars: sky.stars(),
    // The reflection is only the same sky as the dome because these are the
    // very same objects. Identity, not equality.
    sharesUniforms: water ? water.skyUniforms === sky.uniforms : null,
    domeInScene: Boolean(sky.dome.parent),
    renderOrder: sky.dome.renderOrder,
    depthTest: sky.dome.material.depthTest,
  };
});
check(wiring.stars.count === 5044, `expected 5044 stars, got ${wiring.stars.count}`);
check(wiring.stars.source?.properMotions === false, 'the catalogue no longer declares its missing proper motions — update the methods panel');
check(wiring.sharesUniforms !== false, 'the water does not share the sky uniforms');
check(wiring.domeInScene, 'the sky dome is not in the scene');
check(wiring.renderOrder < -100, 'the sky dome is not drawn first');
check(wiring.depthTest === false, 'the sky dome depth-tests, and will be clipped by the far plane');

/**
 * Set the clock, and report the sky it produced.
 *
 * Every one of these is a round trip that has to wait for a rendered frame, and
 * a software rasterizer takes seconds over one — so the *searches* below all run
 * inside a single evaluate rather than stepping the clock from out here. An
 * earlier version stepped the sunset search from Node in 0.05 h increments and
 * never finished.
 */
const at = (dayOfYear, solarHour) =>
  page.evaluate(
    ({ dayOfYear, solarHour }) => {
      window.__app.time.setDayOfYear(dayOfYear);
      window.__app.time.setSolarHour(solarHour);
      const sun = window.__app.time.sun();
      const moon = window.__app.time.moon();
      return { sun, moon, drawn: window.__app.sky.drawn() };
    },
    { dayOfYear, solarHour },
  );

/** The first hour of `dayOfYear` at which the sun has dropped to `altitudeDeg`. */
const hourAtSunAltitude = (dayOfYear, altitudeDeg) =>
  page.evaluate(
    ({ dayOfYear, altitudeDeg }) => {
      for (let hour = 12; hour < 24; hour += 0.02) {
        window.__app.time.setDayOfYear(dayOfYear);
        window.__app.time.setSolarHour(hour);
        if (window.__app.time.sun().apparentAltitudeDeg <= altitudeDeg) return hour;
      }
      return null;
    },
    { dayOfYear, altitudeDeg },
  );

const aim = (azimuthDeg, pitchDeg) =>
  page.evaluate(
    ({ azimuthDeg, pitchDeg }) => {
      window.__app.exitFirstPerson();
      window.__app.enterFirstPerson({ x: 0, z: 0, azimuthDeg, pitchDeg, instant: true });
    },
    { azimuthDeg, pitchDeg },
  );

const shot = async (name, body) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await aim(body.azimuthDeg, Math.max(2, Math.min(60, body.apparentAltitudeDeg)));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${SITE}-${name}.png`, timeout: 240000 });
};

// 1. Midsummer noon: the disc is up and blazing, and there are no stars.
const noon = await at(173, 12);
check(noon.sun.apparentAltitudeDeg > 30, 'the midsummer noon sun is not high');
check(noon.drawn.sunIntensity > 0.99, 'the noon sun disc is not at full intensity');
check(noon.drawn.starFade === 0, 'stars are out at noon');
await shot('noon', noon.sun);

// 2. Sunset: the disc is on the horizon, fully drawn, and still no stars.
const sunsetHour = await hourAtSunAltitude(173, 0.5);
const sunset = sunsetHour === null ? null : await at(173, sunsetHour);
check(sunset !== null, 'never found sunset on the June solstice');
if (sunset) {
  check(sunset.drawn.sunIntensity > 0.99, 'the sun disc is not drawn while the sun is still up');
  check(sunset.drawn.starFade === 0, 'stars are out at sunset');
  await shot('sunset', sunset.sun);
}

// 2b. Just set. The terrain hides a sun below the horizon on land, but over
// open water there is nothing there to hide it, so the disc has to go out by
// itself — a sun hanging over the sea after sunset is the failure this catches.
const setHour = await hourAtSunAltitude(173, -0.9);
const justSet = setHour === null ? null : await at(173, setHour);
if (justSet) {
  check(justSet.drawn.sunIntensity === 0, 'the sun disc is still drawn after the sun has set');
}

// 3. Civil twilight: a handful of stars, not the whole catalogue.
const twilightHour = await hourAtSunAltitude(173, -5);
const twilight = twilightHour === null ? null : await at(173, twilightHour);
if (twilight) {
  check(twilight.drawn.sunIntensity === 0, 'the sun disc is still drawn below the horizon');
  check(
    twilight.drawn.starFade > 0 && twilight.drawn.starFade < 0.5,
    `stars at civil twilight should be part-way out, got ${twilight.drawn.starFade}`,
  );
  await shot('twilight', twilight.sun);
}

// 4. Astronomical night with the moon up: the full field, and a lit moon.
const night = await page.evaluate(() => {
  for (let day = 1; day <= 365; day++) {
    for (let hour = 0; hour < 24; hour += 0.5) {
      window.__app.time.setDayOfYear(day);
      window.__app.time.setSolarHour(hour);
      const sun = window.__app.time.sun();
      const moon = window.__app.time.moon();
      if (sun.apparentAltitudeDeg < -18 && moon.apparentAltitudeDeg > 15 && moon.illuminatedFraction > 0.9) {
        return { day, hour, sun, moon, drawn: window.__app.sky.drawn() };
      }
    }
  }
  return null;
});
check(night !== null, 'no full moon in a dark sky anywhere in the year');
if (night) {
  check(night.drawn.starFade > 0.99, 'the star field is not fully out at astronomical night');
  check(night.drawn.moonBrightness > 0.99, 'the moon is up but not drawn');
  check(night.drawn.moonLit > 0.9, 'the moon is full but not drawn lit');
  // A full moon stands opposite the sun: the two directions must point apart.
  const dot =
    night.drawn.sun[0] * night.drawn.moon[0] +
    night.drawn.sun[1] * night.drawn.moon[1] +
    night.drawn.sun[2] * night.drawn.moon[2];
  check(dot < -0.8, `a full moon should be antisolar, cos = ${dot.toFixed(2)}`);
  await shot('night', night.moon);
}

// 5. Midwinter midday — the Phase 10 exit criterion, still standing.
const midwinter = await at(355, 12);
check(midwinter.sun.apparentAltitudeDeg > 0, 'the midwinter sun does not rise');
check(midwinter.drawn.starFade === 0, 'stars are out at midwinter midday');
await shot('midwinter', midwinter.sun);

// The moon has to set as well as rise.
const moonDown = await page.evaluate(() => {
  for (let day = 1; day <= 365; day++) {
    window.__app.time.setDayOfYear(day);
    window.__app.time.setSolarHour(0);
    if (window.__app.time.moon().apparentAltitudeDeg < -10) return window.__app.sky.drawn();
  }
  return null;
});
check(moonDown !== null && moonDown.moonBrightness === 0, 'a moon below the horizon is still being drawn');

const record = {
  site: SITE,
  ok: failures.length === 0 && errors.length === 0,
  stars: wiring.stars,
  failures,
  errors,
};
console.log(JSON.stringify(record, null, 2));
await browser.close();
process.exit(record.ok ? 0 : 1);
