/**
 * The moon (sky/lunar.ts), and the one test that matters.
 *
 * `lunarTables.ts` is 120 rows of hand-entered coefficients, and a single wrong
 * digit anywhere in it would move the moon by an amount nothing else in this
 * codebase would ever notice. Meeus's own worked Example 47.a is the gate:
 * reproducing λ, β and Δ to his printed precision is not something a table with
 * a typo in it can do.
 */

import { describe, expect, it } from 'vitest';

import { deltaTSeconds } from '../src/sky/deltaT';
import {
  equatorialFromEcliptic,
  geocentricRadiusFactor,
  lunarEcliptic,
  moonPosition,
  phaseLabel,
} from '../src/sky/lunar';
import { julianDay, obliquityDeg, solarPosition } from '../src/sky/solar';

/** Meeus, Astronomical Algorithms 2nd ed., Example 47.a: 1992 April 12.0 TD. */
const EXAMPLE_JDE = 2448724.5;

describe('Meeus example 47.a', () => {
  const moon = lunarEcliptic(EXAMPLE_JDE);

  it('reproduces the Julian Day the example is stated for', () => {
    expect(julianDay(1992, 4, 12)).toBe(EXAMPLE_JDE);
  });

  it('reproduces the apparent ecliptic longitude', () => {
    expect(moon.longitudeDeg).toBeCloseTo(133.162655, 5);
  });

  it('reproduces the ecliptic latitude', () => {
    expect(moon.latitudeDeg).toBeCloseTo(-3.229126, 5);
  });

  it('reproduces the distance', () => {
    expect(moon.distanceKm).toBeCloseTo(368409.7, 1);
  });

  it('reproduces the equatorial horizontal parallax', () => {
    expect(moon.parallaxDeg).toBeCloseTo(0.99199, 5);
  });

  it('reproduces the equatorial coordinates', () => {
    // Meeus continues the example in ch. 13 with the apparent longitude
    // (133.167265, i.e. with nutation) and the true obliquity 23.440636,
    // giving α = 134.688470, δ = 13.768368.
    const equatorial = equatorialFromEcliptic(133.167265, -3.229126, 23.440636);
    expect(equatorial.rightAscensionDeg).toBeCloseTo(134.68847, 4);
    expect(equatorial.declinationDeg).toBeCloseTo(13.768368, 4);
  });

  it('is not accidentally right: perturbing one table row breaks it', () => {
    // A guard on the guard. The largest Σl term is 6288774; if the test above
    // were insensitive to the table, this sanity check would be meaningless.
    const shifted = lunarEcliptic(EXAMPLE_JDE + 0.001);
    expect(Math.abs(shifted.longitudeDeg - moon.longitudeDeg)).toBeGreaterThan(0.0001);
  });
});

describe('the ecliptic-to-equatorial conversion', () => {
  it('puts the March equinox point at the origin', () => {
    const eq = equatorialFromEcliptic(0, 0, 23.44);
    expect(eq.rightAscensionDeg).toBeCloseTo(0, 9);
    expect(eq.declinationDeg).toBeCloseTo(0, 9);
  });

  it('puts the June solstice point at 90° and the obliquity', () => {
    const eq = equatorialFromEcliptic(90, 0, 23.44);
    expect(eq.rightAscensionDeg).toBeCloseTo(90, 9);
    expect(eq.declinationDeg).toBeCloseTo(23.44, 9);
  });

  it('sends the north ecliptic pole to 90° − ε', () => {
    const eq = equatorialFromEcliptic(0, 90, 23.44);
    expect(eq.declinationDeg).toBeCloseTo(90 - 23.44, 6);
  });
});

describe('the observer offset from the centre of the Earth', () => {
  it('is one equatorial radius at the equator', () => {
    expect(geocentricRadiusFactor(0)).toBeCloseTo(1, 6);
  });

  it('is the flattening at the pole', () => {
    expect(geocentricRadiusFactor(90)).toBeCloseTo(0.99664719, 6);
  });

  it('is symmetric across the equator', () => {
    expect(geocentricRadiusFactor(59.7556)).toBeCloseTo(geocentricRadiusFactor(-59.7556), 12);
  });
});

describe('the topocentric moon', () => {
  const BROBORG_LAT = 59.7556;

  it('is pushed down by the parallax, most when it is low', () => {
    // Scan a day and compare the topocentric altitude against the geocentric
    // one implied by the same declination and hour angle. The correction must
    // always be downward, and must grow toward the horizon.
    let maxShiftLow = 0;
    let maxShiftHigh = 0;
    for (let hour = 0; hour < 24; hour += 0.25) {
      const moon = moonPosition({
        latDeg: BROBORG_LAT,
        yearCE: 400,
        dayOfYear: 173,
        solarHour: hour,
      });
      const shift = Math.abs(moon.parallaxDeg * Math.cos(moon.altitudeDeg * (Math.PI / 180)));
      if (Math.abs(moon.altitudeDeg) < 5) maxShiftLow = Math.max(maxShiftLow, shift);
      if (moon.altitudeDeg > 40) maxShiftHigh = Math.max(maxShiftHigh, shift);
      expect(moon.parallaxDeg).toBeGreaterThan(0.88);
      expect(moon.parallaxDeg).toBeLessThan(1.02);
    }
    if (maxShiftHigh > 0) expect(maxShiftLow).toBeGreaterThan(maxShiftHigh);
  });

  it('keeps the disc inside the real range of lunar angular sizes', () => {
    for (let day = 1; day <= 365; day += 7) {
      const moon = moonPosition({ latDeg: BROBORG_LAT, yearCE: 400, dayOfYear: day, solarHour: 22 });
      expect(moon.angularRadiusDeg).toBeGreaterThan(0.243);
      expect(moon.angularRadiusDeg).toBeLessThan(0.281);
    }
  });

  it('carries the ΔT it applied, and it is hours at the far end of the slider', () => {
    const iron = moonPosition({ latDeg: BROBORG_LAT, yearCE: -1050, dayOfYear: 173, solarHour: 22 });
    // ΔT is evaluated at the *instant*, so midsummer of -1050 sits about half a
    // year later than the year's start and its ΔT is correspondingly smaller.
    expect(iron.deltaTSeconds).toBeLessThan(deltaTSeconds(-1050));
    expect(iron.deltaTSeconds).toBeGreaterThan(deltaTSeconds(-1049));
    expect(iron.deltaTSeconds / 3600).toBeGreaterThan(6);
    expect(iron.deltaTSeconds / 3600).toBeLessThan(8);
  });

  it('would misplace the moon by degrees if ΔT were dropped', () => {
    // The justification for reintroducing ΔT at all, as an assertion: at 1050
    // BCE the moon moves this far during the ~7 hours ΔT is worth.
    const at = (hour: number) =>
      moonPosition({ latDeg: BROBORG_LAT, yearCE: -1050, dayOfYear: 173, solarHour: hour });
    const drift = Math.abs(at(12).eclipticLongitudeDeg - at(12 - 7.3).eclipticLongitudeDeg);
    expect(drift).toBeGreaterThan(3);
    expect(drift).toBeLessThan(5);
  });
});

describe('the phase', () => {
  const BROBORG_LAT = 59.7556;

  it('is full when the moon is opposite the sun and new when it is with it', () => {
    // Walk a synodic month at 6-hour resolution and find the extremes.
    let minK = 1;
    let maxK = 0;
    let elongationAtMax = 0;
    let elongationAtMin = 180;
    for (let step = 0; step < 4 * 30; step++) {
      const dayOfYear = 100 + Math.floor(step / 4);
      const moon = moonPosition({
        latDeg: BROBORG_LAT,
        yearCE: 400,
        dayOfYear,
        solarHour: (step % 4) * 6,
      });
      if (moon.illuminatedFraction > maxK) {
        maxK = moon.illuminatedFraction;
        elongationAtMax = moon.elongationDeg;
      }
      if (moon.illuminatedFraction < minK) {
        minK = moon.illuminatedFraction;
        elongationAtMin = moon.elongationDeg;
      }
    }
    expect(maxK).toBeGreaterThan(0.99);
    expect(elongationAtMax).toBeGreaterThan(170);
    expect(minK).toBeLessThan(0.01);
    expect(elongationAtMin).toBeLessThan(12);
  });

  it('recovers the synodic month from successive full moons', () => {
    // Sample every 6 hours for a year and collect local maxima of the lit
    // fraction; their spacing is the synodic month, 29.53 days.
    const samples: { t: number; k: number }[] = [];
    for (let step = 0; step < 4 * 360; step++) {
      const moon = moonPosition({
        latDeg: BROBORG_LAT,
        yearCE: 400,
        dayOfYear: 1 + Math.floor(step / 4),
        solarHour: (step % 4) * 6,
      });
      samples.push({ t: step / 4, k: moon.illuminatedFraction });
    }
    const fulls: number[] = [];
    for (let i = 1; i < samples.length - 1; i++) {
      if (samples[i].k > samples[i - 1].k && samples[i].k >= samples[i + 1].k && samples[i].k > 0.9) {
        fulls.push(samples[i].t);
      }
    }
    expect(fulls.length).toBeGreaterThan(10);
    const gaps = fulls.slice(1).map((t, i) => t - fulls[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(29.2);
    expect(mean).toBeLessThan(29.9);
  });

  it('sits near the antisolar point when it is full', () => {
    // A full moon rises as the sun sets: their azimuths must be roughly
    // opposite and their altitudes roughly mirrored.
    let best: { moonAz: number; sunAz: number; moonAlt: number; sunAlt: number; k: number } | null =
      null;
    for (let day = 1; day <= 60; day++) {
      const moon = moonPosition({ latDeg: BROBORG_LAT, yearCE: 400, dayOfYear: day, solarHour: 0 });
      if (!best || moon.illuminatedFraction > best.k) {
        const sun = solarPosition({
          latDeg: BROBORG_LAT,
          yearCE: 400,
          dayOfYear: day,
          solarHour: 0,
        });
        best = {
          moonAz: moon.azimuthDeg,
          sunAz: sun.azimuthDeg,
          moonAlt: moon.altitudeDeg,
          sunAlt: sun.altitudeDeg,
          k: moon.illuminatedFraction,
        };
      }
    }
    expect(best!.k).toBeGreaterThan(0.98);
    // Wrapped separation in azimuth: 180° is exactly opposite. The moon's
    // orbit is inclined 5° to the ecliptic, so opposition is not exact.
    const azimuthGap = Math.abs(((best!.moonAz - best!.sunAz + 540) % 360) - 180);
    expect(azimuthGap).toBeGreaterThan(155);
    // At local midnight a full moon is up while the sun is down.
    expect(best!.sunAlt).toBeLessThan(0);
    expect(best!.moonAlt).toBeGreaterThan(-10);
  });

  it('names the phases', () => {
    expect(phaseLabel(0.0, true)).toBe('new moon');
    expect(phaseLabel(1.0, false)).toBe('full moon');
    expect(phaseLabel(0.5, true)).toBe('first quarter');
    expect(phaseLabel(0.5, false)).toBe('last quarter');
    expect(phaseLabel(0.25, true)).toBe('waxing crescent');
    expect(phaseLabel(0.8, false)).toBe('waning gibbous');
  });
});

describe('the obliquity the moon is converted through', () => {
  it('is the same one the sun uses', () => {
    // Not a tautology worth skipping: if these ever diverged, the sun and the
    // moon would sit on two different equators.
    expect(obliquityDeg(EXAMPLE_JDE)).toBeCloseTo(23.440636, 3);
  });
});
