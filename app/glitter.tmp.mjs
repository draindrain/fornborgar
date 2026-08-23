import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = '/tmp/shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:4173/?site=broborg&debug=1');
let ready = false; const t0 = Date.now();
while (!ready && Date.now() - t0 < 1800000) {
  ready = await page.waitForFunction(() => window.__terrainReady === true, null, { timeout: 30000 }).then(() => true).catch(() => false);
  if (!ready) console.error(Math.round((Date.now() - t0) / 1000) + 's');
}
await page.waitForFunction(() => window.__app?.sky?.stars?.().loaded === true, null, { timeout: 180000 }).catch(() => {});
await page.evaluate(() => window.__app.water.setEnabled(true));

for (const [name, day, hour] of [['sun', 173, 21.05], ['moon', 294, 19]]) {
  const spot = await page.evaluate(({ day, hour }) => {
    window.__app.time.setDayOfYear(day);
    window.__app.time.setSolarHour(hour);
    const sun = window.__app.time.sun();
    const moon = window.__app.time.moon();
    const body = sun.apparentAltitudeDeg > -6 ? sun : moon;
    const level = window.__app.water.layer.levelM;
    const ground = window.__app.groundAt;
    const d = Math.PI / 180;
    const dir = [Math.sin(body.azimuthDeg * d), -Math.cos(body.azimuthDeg * d)];
    // The specular point for a body at altitude h, seen from eye height e, is
    // e/tan(h) in front of the eye. Stand where that point lands on water.
    const eyeAbove = 1.7;
    let best = null;
    for (let x = -1800; x <= 1800; x += 40) {
      for (let z = -1800; z <= 1800; z += 40) {
        const g = ground(x, z);
        if (g <= level + 0.5) continue;              // must be dry underfoot
        const e = g + eyeAbove - level;              // eye height above the water
        const d = e / Math.tan(Math.max(2, body.apparentAltitudeDeg) * Math.PI / 180);
        let hits = 0;
        for (const f of [0.7, 0.85, 1.0, 1.2, 1.5]) {
          const px = x + dir[0] * d * f;
          const pz = z + dir[1] * d * f;
          if (Math.abs(px) > 1900 || Math.abs(pz) > 1900) continue;
          if (ground(px, pz) < level) hits++;
        }
        if (hits < 4) continue;
        // Prefer a high standpoint: it pushes the specular point further out,
        // so the path is a path rather than a patch at your feet.
        if (!best || e > best.e) best = { x, z, e, d, hits };
      }
    }
    return { best, az: body.azimuthDeg, alt: body.apparentAltitudeDeg, level };
  }, { day, hour });
  console.log(name, JSON.stringify(spot));
  if (!spot.best) { console.log('no standpoint with water at the specular distance'); continue; }
  await page.evaluate((s) => {
    window.__app.exitFirstPerson?.();
    window.__app.enterFirstPerson({ x: s.best.x, z: s.best.z, azimuthDeg: s.az, pitchDeg: 1.5, instant: true });
  }, spot);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/broborg-glitter-${name}.png`, timeout: 240000 });
}
console.log('errors:', errors.length ? errors.slice(0, 4) : 'none');
await browser.close();
