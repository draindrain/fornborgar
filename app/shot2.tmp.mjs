import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const BASE = 'http://localhost:4173';
const SITE = process.argv[2] ?? 'broborg';
const OUT = process.argv[3] ?? '/tmp/shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
await page.goto(`${BASE}/?site=${SITE}&debug=1`);
await page.waitForFunction(() => window.__terrainReady === true, null, { timeout: 900000 });
await page.waitForFunction(() => window.__app?.sky?.stars?.().loaded === true, null, { timeout: 180000 }).catch(() => {});
await page.evaluate(() => window.__app.water.setEnabled(true));

// A low moon in a dark sky is the only configuration that makes a glitter path.
const pick = await page.evaluate(() => {
  let best = null;
  for (let day = 1; day <= 365; day++) {
    for (let hour = 0; hour < 24; hour += 0.5) {
      window.__app.time.setDayOfYear(day);
      window.__app.time.setSolarHour(hour);
      const m = window.__app.time.moon();
      const s = window.__app.time.sun();
      if (s.apparentAltitudeDeg > -14) continue;
      if (m.apparentAltitudeDeg < 3 || m.apparentAltitudeDeg > 12) continue;
      const score = m.illuminatedFraction;
      if (!best || score > best.score) best = { score, day, hour, az: m.azimuthDeg, alt: m.apparentAltitudeDeg, k: m.illuminatedFraction };
    }
  }
  return best;
});
console.log('pick', JSON.stringify(pick));
if (pick) {
  await page.evaluate((p) => {
    window.__app.time.setDayOfYear(p.day);
    window.__app.time.setSolarHour(p.hour);
    window.__app.enterFirstPerson({ x: 0, z: 0, azimuthDeg: p.az, pitchDeg: 2, instant: true });
  }, pick);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/${SITE}-moonglitter.png`, timeout: 240000 });
}
// And the same standpoint at sunset, low over the water.
const sunset = await page.evaluate(() => {
  let best = null;
  for (let hour = 19; hour < 23; hour += 0.1) {
    window.__app.time.setDayOfYear(173);
    window.__app.time.setSolarHour(hour);
    const s = window.__app.time.sun();
    if (!best || Math.abs(s.apparentAltitudeDeg - 1.5) < Math.abs(best.alt - 1.5)) best = { hour, alt: s.apparentAltitudeDeg, az: s.azimuthDeg };
  }
  return best;
});
await page.evaluate((p) => {
  window.__app.time.setSolarHour(p.hour);
  window.__app.exitFirstPerson?.();
  window.__app.enterFirstPerson({ x: 0, z: 0, azimuthDeg: p.az, pitchDeg: 1, instant: true });
}, sunset);
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/${SITE}-sunglitter.png`, timeout: 240000 });
console.log('sunset', JSON.stringify(sunset));
console.log('errors:', errors.length ? errors.slice(0, 4) : 'none');
await browser.close();
