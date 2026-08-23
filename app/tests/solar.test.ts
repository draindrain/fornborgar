/**
 * The sun, pinned. Most of these are properties rather than magic numbers —
 * "the sun is due south at local noon" cannot drift out of date — but the
 * handful of computed values are recorded because they are the ones that catch a
 * plausible-looking wrong formula.
 *
 * Everything is at Broborg's latitude (59.755562° N) unless stated.
 */

import { describe, expect, it } from 'vitest';

import {
  apparentSolarLongitudeDeg,
  dateFromDayOfYear,
  daylight,
  declinationDeg,
  julianDay,
  julianDayAt,
  localApparentSiderealDeg,
  obliquityDeg,
  refractionDeg,
  rightAscensionDeg,
  seasonLabel,
  solarPosition,
} from '../src/sky/solar';

const BROBORG_LAT = 59.755562412;
/** Two days that are effectively the solstices and the March equinox. */
const MIDSUMMER = 172;
const MIDWINTER = 355;
const SPRING = 80;

describe('julianDay', () => {
  it('agrees with the standard epoch', () => {
    expect(julianDay(2000, 1, 1.5)).toBe(2451545.0);
    expect(julianDay(1957, 10, 4.81)).toBeCloseTo(2436116.31, 2); // Meeus ex. 7.a
  });

  it('uses Math.floor, not truncation, across a negative century boundary', () => {
    // The trap: Meeus writes A = INT(y/100) and states the algorithm for positive
    // years. Truncating toward zero puts the century-leap correction one day out
    // for BCE years — silent, and it covers half this app's slider. A truncating
    // implementation makes one of these gaps 366 or 364.
    for (const year of [-1101, -1001, -901, -101, -1]) {
      const span = julianDay(year + 1, 1, 1) - julianDay(year, 1, 1);
      expect([365, 366]).toContain(span);
    }
    // -1200 is divisible by 400, so it is a leap year; -1000 is divisible by 100
    // but not 400, so it is not. Both are load-bearing for the floor/truncate split.
    expect(julianDay(-1200, 3, 1) - julianDay(-1200, 2, 1)).toBe(29);
    expect(julianDay(-1000, 3, 1) - julianDay(-1000, 2, 1)).toBe(28);
    expect(julianDay(-1004, 3, 1) - julianDay(-1004, 2, 1)).toBe(29);
  });

  it('is strictly increasing day by day right across year zero', () => {
    let previous = julianDay(-2, 1, 1);
    for (let year = -2; year <= 2; year++) {
      for (let month = 1; month <= 12; month++) {
        const jd = julianDay(year, month, 1);
        expect(jd).toBeGreaterThanOrEqual(previous);
        previous = jd;
      }
    }
  });
});

describe('obliquityDeg (Laskar 1986)', () => {
  const at = (year: number): number => obliquityDeg(julianDayAt(year, 1, 12));

  it('matches the published values across the app’s whole range', () => {
    expect(at(-1050)).toBeCloseTo(23.82012, 4);
    expect(at(0)).toBeCloseTo(23.69488, 4);
    expect(at(400)).toBeCloseTo(23.64504, 4);
    expect(at(1150)).toBeCloseTo(23.54947, 4);
    expect(at(2000)).toBeCloseTo(23.43929, 4);
  });

  it('decreases monotonically — the axis has been straightening throughout', () => {
    let previous = Infinity;
    for (let year = -1050; year <= 1150; year += 50) {
      const eps = at(year);
      expect(eps).toBeLessThan(previous);
      previous = eps;
    }
  });
});

describe('declination', () => {
  it('reaches ±ε at the solstices and ~0 at the equinoxes', () => {
    const eps = obliquityDeg(julianDayAt(400, MIDSUMMER, 12));
    expect(declinationDeg(julianDayAt(400, MIDSUMMER, 12))).toBeCloseTo(eps, 1);
    expect(declinationDeg(julianDayAt(400, MIDWINTER, 12))).toBeCloseTo(-eps, 1);
    expect(Math.abs(declinationDeg(julianDayAt(400, SPRING, 12)))).toBeLessThan(0.5);
  });

  it('never exceeds the obliquity', () => {
    for (let day = 1; day <= 365; day += 7) {
      const jd = julianDayAt(400, day, 12);
      expect(Math.abs(declinationDeg(jd))).toBeLessThanOrEqual(obliquityDeg(jd) + 1e-9);
    }
  });
});

describe('solarPosition', () => {
  const at = (year: number, day: number, hour: number, lat = BROBORG_LAT) =>
    solarPosition({ latDeg: lat, yearCE: year, dayOfYear: day, solarHour: hour });

  it('puts the sun due south at 12:00 — that is what apparent solar time means', () => {
    expect(at(400, MIDSUMMER, 12).azimuthDeg).toBeCloseTo(180, 6);
    expect(at(400, MIDWINTER, 12).azimuthDeg).toBeCloseTo(180, 6);
    expect(at(-1050, SPRING, 12).azimuthDeg).toBeCloseTo(180, 6);
  });

  it('puts it due north at midnight, and just west of north just before', () => {
    expect(at(400, MIDSUMMER, 0).azimuthDeg).toBeCloseTo(0, 6);
    const almost = at(400, MIDSUMMER, 12 + 179 / 15).azimuthDeg;
    expect(almost).toBeGreaterThan(355);
    expect(almost).toBeLessThan(360);
  });

  it('sweeps east in the morning and west in the afternoon', () => {
    expect(at(400, MIDSUMMER, 6).azimuthDeg).toBeGreaterThan(30);
    expect(at(400, MIDSUMMER, 6).azimuthDeg).toBeLessThan(120);
    expect(at(400, MIDSUMMER, 18).azimuthDeg).toBeGreaterThan(240);
    expect(at(400, MIDSUMMER, 18).azimuthDeg).toBeLessThan(330);
  });

  it('satisfies the noon-altitude identity, 90 − φ + δ', () => {
    for (const day of [MIDSUMMER, MIDWINTER, SPRING, 250]) {
      const p = at(400, day, 12);
      expect(p.altitudeDeg).toBeCloseTo(90 - BROBORG_LAT + p.declinationDeg, 6);
    }
  });

  it('reproduces the default view the app opens on', () => {
    // Year 400, day 173, 18:30 solar time: a low evening sun from the west-north-west.
    // Within a couple of degrees of the hand-tuned 18°/315° this replaced, which is
    // the whole reason those defaults were chosen.
    const p = at(400, 173, 18.5);
    expect(p.altitudeDeg).toBeCloseTo(16.63, 2);
    expect(p.azimuthDeg).toBeCloseTo(288.58, 2);
  });

  it('pins the solstice and equinox altitudes at Broborg', () => {
    expect(at(500, MIDSUMMER, 12).altitudeDeg).toBeCloseTo(53.868, 3);
    expect(at(500, MIDWINTER, 12).altitudeDeg).toBeCloseTo(6.613, 3);
    expect(at(400, SPRING, 12).altitudeDeg).toBeCloseTo(29.985, 3);
  });

  it('keeps the midsummer midnight sun inside nautical twilight — the white night', () => {
    // The single best regression test for the sky ramp: at 59.76° N the sun never
    // gets more than ~7° below the horizon in June, so midsummer night must never
    // render as night.
    const midnight = at(500, MIDSUMMER, 0).altitudeDeg;
    expect(midnight).toBeGreaterThan(-7);
    expect(midnight).toBeLessThan(-6);
    expect(midnight).toBeCloseTo(-6.627, 3);
  });

  it('shows the obliquity effect the year slider exists for', () => {
    // 1050 BCE to 1150 CE at midsummer noon: a quarter of a degree, all of it ε.
    const old = at(-1050, MIDSUMMER, 12).altitudeDeg;
    const recent = at(1150, MIDSUMMER, 12).altitudeDeg;
    expect(old - recent).toBeCloseTo(0.25, 1);
    expect(old).toBeGreaterThan(recent);
  });

  it('is near-symmetric about noon, but not exactly — declination drifts intra-day', () => {
    // Exact symmetry would mean declination was frozen at noon, which would cost
    // ~0.2° at dawn near the equinoxes. So: close, but demonstrably not equal.
    // The gap grows with the offset from noon, which is the drift showing.
    let previousGap = 0;
    for (const t of [1, 3, 5]) {
      const gap = Math.abs(at(400, SPRING, 12 + t).altitudeDeg - at(400, SPRING, 12 - t).altitudeDeg);
      expect(gap).toBeLessThan(0.25);
      expect(gap).toBeGreaterThan(previousGap);
      previousGap = gap;
    }
  });

  it('stays finite and in range over a full sweep of years, days and hours', () => {
    for (const year of [-1050, 400, 1150]) {
      for (let day = 1; day <= 365; day += 15) {
        for (let hour = 0; hour < 24; hour += 1) {
          const p = solarPosition({ latDeg: BROBORG_LAT, yearCE: year, dayOfYear: day, solarHour: hour });
          expect(Number.isFinite(p.altitudeDeg)).toBe(true);
          expect(p.altitudeDeg).toBeGreaterThanOrEqual(-90);
          expect(p.altitudeDeg).toBeLessThanOrEqual(90);
          expect(p.azimuthDeg).toBeGreaterThanOrEqual(0);
          expect(p.azimuthDeg).toBeLessThan(360);
        }
      }
    }
  });
});

describe('refractionDeg (Sæmundsson)', () => {
  it('is 28.98′ at the true horizon, not the 34.5′ that belongs to apparent altitude', () => {
    expect(refractionDeg(0) * 60).toBeCloseTo(28.982, 2);
    expect(refractionDeg(-0.575) * 60).toBeCloseTo(34.444, 2);
  });

  it('never goes negative near the zenith, where the bare formula does', () => {
    expect(refractionDeg(89)).toBeGreaterThanOrEqual(0);
    expect(refractionDeg(90)).toBeGreaterThanOrEqual(0);
  });

  it('is tapered to zero below −3°, where the bare formula turns over and regrows', () => {
    expect(refractionDeg(-3)).toBe(0);
    expect(refractionDeg(-10)).toBe(0);
    expect(refractionDeg(-2)).toBeGreaterThan(0);
  });

  it('never increases with altitude, once past the taper', () => {
    // Below -1° the taper is deliberately pulling the value back down to zero, so
    // the curve rises out of 0 at -3° before it starts falling. Above -1° it is
    // the physical curve and must be monotone.
    let previous = Infinity;
    for (let h = -1; h <= 90; h += 0.25) {
      const r = refractionDeg(h);
      expect(r).toBeLessThanOrEqual(previous + 1e-12);
      previous = r;
    }
    expect(refractionDeg(-2.5)).toBeLessThan(refractionDeg(-1));
  });
});

describe('daylight', () => {
  it('pins sunrise and sunset at Broborg on the two solstices', () => {
    // 02:34 / 21:26 and 09:04 / 14:56 in apparent solar time — 18 h 51 m of
    // daylight against 5 h 52 m, which is what 59.8° N means.
    const summer = daylight(BROBORG_LAT, 500, MIDSUMMER);
    expect(summer.sunriseHour).toBeCloseTo(2.5725, 3);
    expect(summer.sunsetHour).toBeCloseTo(21.4275, 3);

    const winter = daylight(BROBORG_LAT, 500, MIDWINTER);
    expect(winter.sunriseHour).toBeCloseTo(9.0645, 3);
    expect(winter.sunsetHour).toBeCloseTo(14.9355, 3);
  });

  it('is symmetric about apparent noon, by construction', () => {
    for (const day of [1, 90, 180, 270, 365]) {
      const d = daylight(BROBORG_LAT, 400, day);
      expect((d.sunriseHour ?? 0) + (d.sunsetHour ?? 0)).toBeCloseTo(24, 9);
    }
  });

  it('agrees with the altitude function about when the sun is up', () => {
    const d = daylight(BROBORG_LAT, 400, 200);
    const justAfter = solarPosition({
      latDeg: BROBORG_LAT, yearCE: 400, dayOfYear: 200, solarHour: (d.sunriseHour ?? 0) + 0.1,
    });
    const justBefore = solarPosition({
      latDeg: BROBORG_LAT, yearCE: 400, dayOfYear: 200, solarHour: (d.sunriseHour ?? 0) - 0.1,
    });
    expect(justAfter.altitudeDeg).toBeGreaterThan(-0.833);
    expect(justBefore.altitudeDeg).toBeLessThan(-0.833);
  });

  it('reports polar day and polar night above the Arctic Circle rather than NaN', () => {
    // Kiruna's latitude — some of the national scale-out's northern sites are up here.
    const summer = daylight(67.86, 400, MIDSUMMER);
    expect(summer.polarDay).toBe(true);
    expect(summer.sunriseHour).toBeNull();

    const winter = daylight(67.86, 400, MIDWINTER);
    expect(winter.polarNight).toBe(true);
    expect(winter.sunsetHour).toBeNull();
  });

  it('never reports both, and never at Broborg', () => {
    for (let day = 1; day <= 365; day += 5) {
      const d = daylight(BROBORG_LAT, 400, day);
      expect(d.polarDay).toBe(false);
      expect(d.polarNight).toBe(false);
      expect(d.sunriseHour).not.toBeNull();
    }
  });
});

describe('dateFromDayOfYear', () => {
  it('round-trips the month boundaries in a common year', () => {
    expect(dateFromDayOfYear(1901, 1)).toEqual({ month: 1, day: 1 });
    expect(dateFromDayOfYear(1901, 31)).toEqual({ month: 1, day: 31 });
    expect(dateFromDayOfYear(1901, 32)).toEqual({ month: 2, day: 1 });
    expect(dateFromDayOfYear(1901, 59)).toEqual({ month: 2, day: 28 });
    expect(dateFromDayOfYear(1901, 60)).toEqual({ month: 3, day: 1 });
    expect(dateFromDayOfYear(1901, 365)).toEqual({ month: 12, day: 31 });
  });

  it('shifts by the leap day, and accepts day 366 only in a leap year', () => {
    expect(dateFromDayOfYear(2000, 60)).toEqual({ month: 2, day: 29 });
    expect(dateFromDayOfYear(2000, 366)).toEqual({ month: 12, day: 31 });
    expect(dateFromDayOfYear(1901, 366)).toEqual({ month: 12, day: 31 }); // clamped
  });

  it('handles negative (astronomical) years', () => {
    expect(dateFromDayOfYear(-1200, 60)).toEqual({ month: 2, day: 29 }); // −1200 / 400 is whole
    expect(dateFromDayOfYear(-1000, 60)).toEqual({ month: 3, day: 1 }); // ...−1000 / 400 is not
    expect(dateFromDayOfYear(-1001, 60)).toEqual({ month: 3, day: 1 });
  });
});

describe('seasonLabel', () => {
  it('names the four turning points from the sun’s longitude, not the date', () => {
    expect(seasonLabel(0)).toBe('spring equinox');
    expect(seasonLabel(90)).toBe('midsummer');
    expect(seasonLabel(180)).toBe('autumn equinox');
    expect(seasonLabel(270)).toBe('midwinter');
  });

  it('covers the whole circle and wraps cleanly', () => {
    for (let l = -720; l <= 1080; l += 1) expect(seasonLabel(l)).not.toBe('');
    expect(seasonLabel(359)).toBe(seasonLabel(-1));
  });

  it('is still right where the proleptic-Gregorian date has slipped', () => {
    // Day 172 is the solstice today but two days early at 1050 BCE — the label
    // follows the sun, so it says "midsummer" in both.
    const modern = solarPosition({ latDeg: BROBORG_LAT, yearCE: 2000, dayOfYear: 172, solarHour: 12 });
    const ancient = solarPosition({ latDeg: BROBORG_LAT, yearCE: -1050, dayOfYear: 174, solarHour: 12 });
    expect(seasonLabel(modern.solarLongitudeDeg)).toBe('midsummer');
    expect(seasonLabel(ancient.solarLongitudeDeg)).toBe('midsummer');
  });
});

describe('apparentSolarLongitudeDeg', () => {
  it('keeps the equation of centre — a circular orbit would be ~2° out', () => {
    // Perihelion is in early January today, so around day 100 the true sun leads
    // the mean sun by well over a degree. If C were dropped this gap collapses.
    const jd = julianDayAt(2000, 100, 12);
    const meanish = ((280.46646 + 36000.76983 * ((jd - 2451545) / 36525)) % 360 + 360) % 360;
    expect(Math.abs(apparentSolarLongitudeDeg(jd) - meanish)).toBeGreaterThan(1);
  });

  it('advances through the full circle over a year', () => {
    // Four Julian years (1461 d) is 4 tropical years to within half an hour, so
    // the sun comes back to almost exactly the same longitude. A whole Gregorian
    // year would not: 365 d undershoots the tropical year by a quarter of a day
    // and 366 d overshoots by three quarters, which is the leap rule working.
    const start = apparentSolarLongitudeDeg(julianDayAt(400, 1, 12));
    const fourYears = apparentSolarLongitudeDeg(julianDayAt(400, 1, 12) + 1461);
    expect(((fourYears - start + 540) % 360) - 180).toBeCloseTo(0, 1);

    // Half a *year* is not half the ecliptic: eccentricity makes the seasons
    // unequal in time, so day 1 -> day 183 covers ~178°, not 180°.
    const half = apparentSolarLongitudeDeg(julianDayAt(400, 183, 12));
    const advance = ((half - start) + 360) % 360;
    expect(advance).toBeGreaterThan(175);
    expect(advance).toBeLessThan(180);
  });
});

/**
 * The sidereal hook (added with the moon and the stars).
 *
 * `solarPosition` never needed the sun's right ascension — apparent solar time
 * hands it the hour angle by definition. Everything *else* in the sky needs it,
 * and these are the two properties that make it safe to build on.
 */
describe('right ascension and sidereal time', () => {
  /** The Julian Day at which the sun's apparent longitude is `target`. */
  function jdAtSolarLongitude(target: number): number {
    let lo = julianDayAt(2000, 1, 12);
    let hi = lo + 366;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const advance = (apparentSolarLongitudeDeg(mid) - apparentSolarLongitudeDeg(lo) + 360) % 360;
      const wanted = (target - apparentSolarLongitudeDeg(lo) + 360) % 360;
      if (advance < wanted) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  it('puts the sun at the origin at the March equinox', () => {
    const jd = jdAtSolarLongitude(0);
    expect(Math.abs(((rightAscensionDeg(jd) + 180) % 360) - 180)).toBeLessThan(0.01);
    expect(Math.abs(declinationDeg(jd))).toBeLessThan(0.01);
  });

  it('puts the sun at 90° of right ascension at the June solstice', () => {
    // At solar longitude 90 the sun is at the June solstice point, whose right
    // ascension is 90° and whose declination is the obliquity itself.
    const jd = jdAtSolarLongitude(90);
    expect(rightAscensionDeg(jd)).toBeCloseTo(90, 4);
    expect(declinationDeg(jd)).toBeCloseTo(obliquityDeg(jd), 4);
  });

  it('runs ahead of the mean sun and falls back, over the year', () => {
    // Right ascension is not the longitude: the obliquity alone makes them
    // disagree by up to 2.5° four times a year, which is most of why the
    // equation of time exists — and exactly what apparent solar time spares us.
    let maxGap = 0;
    for (let day = 1; day <= 365; day++) {
      const jd = julianDayAt(2000, day, 12);
      const gap = ((rightAscensionDeg(jd) - apparentSolarLongitudeDeg(jd) + 540) % 360) - 180;
      maxGap = Math.max(maxGap, Math.abs(gap));
    }
    expect(maxGap).toBeGreaterThan(2);
    expect(maxGap).toBeLessThan(3);
  });

  it('is reported on the SolarPosition alongside declination', () => {
    const jd = julianDayAt(400, 173, 15.5);
    const sun = solarPosition({ latDeg: 59.7556, yearCE: 400, dayOfYear: 173, solarHour: 15.5 });
    expect(sun.rightAscensionDeg).toBeCloseTo(rightAscensionDeg(jd), 9);
  });

  it('makes local noon at the equinox put the vernal point on the meridian', () => {
    // This is the definition test for the whole construction: LAST = H_sun +
    // alpha_sun, and at the March equinox alpha_sun = 0, so at 12:00 solar time
    // the vernal point transits.
    expect(localApparentSiderealDeg(12, 0)).toBeCloseTo(0, 9);
  });

  it('advances 15° per hour of solar time', () => {
    const alpha = 137.5;
    expect(localApparentSiderealDeg(13, alpha) - localApparentSiderealDeg(12, alpha)).toBeCloseTo(
      15,
      9,
    );
  });

  it('wraps into 0…360', () => {
    expect(localApparentSiderealDeg(0, 10)).toBeGreaterThanOrEqual(0);
    expect(localApparentSiderealDeg(0, 10)).toBeLessThan(360);
    expect(localApparentSiderealDeg(23.9, 350)).toBeGreaterThanOrEqual(0);
    expect(localApparentSiderealDeg(23.9, 350)).toBeLessThan(360);
  });
});
