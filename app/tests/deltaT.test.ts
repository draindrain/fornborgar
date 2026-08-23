/**
 * ΔT (sky/deltaT.ts).
 *
 * The Espenak–Meeus polynomials are published as a piecewise set, and each
 * branch's constant term is its own check value — ΔT is 10583.6 s at year 0 and
 * 1574.2 s at year 1000 by construction. The interesting property is that the
 * branches were fitted to *join*: a transcription error in any coefficient
 * would open a step at a boundary that the published set does not have.
 */

import { describe, expect, it } from 'vitest';

import { DELTA_T_LAST_YEAR, decimalYearFromJd, deltaTDays, deltaTSeconds } from '../src/sky/deltaT';
import { julianDay } from '../src/sky/solar';

describe('the published check values', () => {
  it('is 10583.6 s at year 0', () => {
    expect(deltaTSeconds(0)).toBeCloseTo(10583.6, 4);
  });

  it('is 1574.2 s at year 1000', () => {
    expect(deltaTSeconds(1000)).toBeCloseTo(1574.2, 4);
  });

  it('is 120 s at year 1600', () => {
    expect(deltaTSeconds(1600)).toBeCloseTo(120, 6);
  });

  it('is the Morrison–Stephenson parabola before 500 BCE', () => {
    const u = (-1000 - 1820) / 100;
    expect(deltaTSeconds(-1000)).toBeCloseTo(-20 + 32 * u * u, 6);
  });
});

describe('the branches join', () => {
  const boundaries = [-500, 500, 1600];

  for (const year of boundaries) {
    it(`is continuous across ${year}`, () => {
      const below = deltaTSeconds(year - 1e-6);
      const above = deltaTSeconds(year + 1e-6);
      // The published set is fitted, not spliced, so the joins are close but
      // not exact. A transcription error would open a step far larger than this.
      expect(Math.abs(above - below)).toBeLessThan(1);
    });
  }

  it('decreases monotonically across the whole year slider', () => {
    let previous = Infinity;
    for (let year = -1050; year <= 1150; year += 5) {
      const value = deltaTSeconds(year);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });
});

describe('the size of the correction', () => {
  it('is about seven hours at the far end of the year slider', () => {
    expect(deltaTSeconds(-1050) / 3600).toBeGreaterThan(7);
    expect(deltaTSeconds(-1050) / 3600).toBeLessThan(7.5);
  });

  it('is under a quarter of an hour by the near end', () => {
    expect(deltaTSeconds(1150) / 3600).toBeLessThan(0.3);
  });

  it('is worth roughly four degrees of lunar longitude at 1050 BCE', () => {
    // The moon moves 0.549°/h. This number is the justification for the whole
    // module, and the methods panel quotes it.
    expect((deltaTSeconds(-1050) / 3600) * 0.549).toBeGreaterThan(3.5);
    expect((deltaTSeconds(-1050) / 3600) * 0.549).toBeLessThan(4.5);
  });
});

describe('beyond the carried branches', () => {
  it('holds at the 1700 value rather than extrapolating a cubic', () => {
    expect(deltaTSeconds(2026)).toBe(deltaTSeconds(DELTA_T_LAST_YEAR));
  });

  it('holds a residual far below one lunar diameter', () => {
    // The clamp is only defensible because of this: the true modern ΔT is
    // ~69 s against the held 9 s, and a minute of time is 0.01° of moon.
    const residualDeg = ((69 - deltaTSeconds(2026)) / 3600) * 0.549;
    expect(Math.abs(residualDeg)).toBeLessThan(0.02);
  });
});

describe('the decimal year a Julian Day falls in', () => {
  it('places J2000.0 at the year 2000', () => {
    expect(decimalYearFromJd(2451545.0)).toBeCloseTo(2000, 6);
  });

  it('round-trips a mid-year date to within a couple of days', () => {
    expect(decimalYearFromJd(julianDay(400, 6, 21))).toBeCloseTo(400.47, 1);
  });

  it('agrees with the seconds form', () => {
    expect(deltaTDays(0) * 86400).toBeCloseTo(deltaTSeconds(0), 9);
  });
});
