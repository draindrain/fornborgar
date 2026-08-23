/**
 * The seeded noise fields (`lib/noise`), which the vegetation layer's stands are built
 * on (PLAN §6.1 amendment).
 *
 * Four properties, in the order they can fail:
 *   • **determinism** — same seed, same field, everywhere and forever; a different seed
 *     is a different field (the palisade rule, `lib/random`);
 *   • **range** — [0, 1] with mean ½, because callers map the field straight onto
 *     bounded quantities (a height multiplier, a species threshold);
 *   • **continuity** — the whole point: neighbouring samples must be *close*, or there
 *     are no stands, just noise with extra steps;
 *   • **non-constancy** — the opposite failure, and the one a hashing bug produces
 *     silently: a field that is smooth because it never changes.
 *
 * Every assertion is a property, never a golden literal: the values are allowed to
 * change with the algorithm, the properties are not.
 */

import { describe, expect, it } from 'vitest';

import { fbm2D, valueNoise2D } from '../src/lib/noise';

/** Sample points that never land on a lattice line, at a few different scales. */
const PROBES: [number, number][] = [
  [0.37, 0.11],
  [12.73, -4.21],
  [-103.5, 87.33],
  [1_517.77, 2_913.19],
  [-9_999.01, 12_345.67],
];

describe('value noise (lib/noise)', () => {
  it('is a pure function of the seed and the position', () => {
    const a = valueNoise2D(4242);
    const b = valueNoise2D(4242);
    for (const [x, z] of PROBES) {
      expect(a(x, z)).toBe(b(x, z));
      // Sampling order and history cannot matter — there is no state to carry.
      expect(a(x, z)).toBe(a(x, z));
    }

    const other = valueNoise2D(4243);
    const differences = PROBES.filter(([x, z]) => other(x, z) !== a(x, z));
    expect(differences.length).toBe(PROBES.length);
  });

  it('stays inside [0, 1] and is not axis-symmetric', () => {
    const noise = valueNoise2D(7);
    for (let i = 0; i < 5_000; i++) {
      const x = i * 0.6180339887 * 13 - 2_000;
      const z = i * 0.4142135624 * 7 - 1_500;
      const value = noise(x, z);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // (x, z) and (z, x) must not fold onto the same lattice hash.
    expect(noise(3.25, 91.5)).not.toBe(noise(91.5, 3.25));
  });

  it('is continuous across lattice boundaries', () => {
    const noise = valueNoise2D(19);
    // A lattice line is where a naive hash-per-cell field would jump.
    for (const line of [0, 1, -5, 42]) {
      const step = 1e-4;
      const before = noise(line - step, 0.3);
      const after = noise(line + step, 0.3);
      expect(Math.abs(after - before)).toBeLessThan(1e-3);
    }
  });

  it('actually varies — a constant field would pass everything above', () => {
    const noise = valueNoise2D(3);
    const values = Array.from({ length: 200 }, (_, i) => noise(i * 3.7, i * 2.3));
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(max - min).toBeGreaterThan(0.4);
  });
});

describe('fBm (lib/noise)', () => {
  it('is a pure function of the seed', () => {
    const a = fbm2D(2026, 2, 140);
    const b = fbm2D(2026, 2, 140);
    for (const [x, z] of PROBES) expect(a(x, z)).toBe(b(x, z));

    const other = fbm2D(2027, 2, 140);
    for (const [x, z] of PROBES) expect(other(x, z)).not.toBe(a(x, z));
  });

  it('stays inside [0, 1] with mean ½, at every octave count', () => {
    for (const octaves of [1, 2, 3]) {
      const field = fbm2D(31 + octaves, octaves, 90);
      let sum = 0;
      let min = 1;
      let max = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) {
        // Irrational strides, so the walk never re-visits a lattice phase.
        const value = field(i * 7.3313 * Math.SQRT2, i * 13.7371);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        sum += value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      // Mean ½ is exact in expectation (a convex combination of uniforms), so a
      // 20 000-sample estimate lands very close.
      expect(sum / n).toBeGreaterThan(0.48);
      expect(sum / n).toBeLessThan(0.52);
      // ...and the field really uses its range rather than hugging the mean.
      expect(max - min).toBeGreaterThan(0.5);
    }
  });

  it('changes slowly relative to its wavelength', () => {
    const step = 0.1;
    for (const wavelength of [10, 90, 140, 1_000]) {
      const field = fbm2D(88, 2, wavelength);
      let worst = 0;
      for (let i = 0; i < 2_000; i++) {
        const x = i * 1.37 - 500;
        const z = i * 0.71 + 17;
        worst = Math.max(
          worst,
          Math.abs(field(x + step, z) - field(x, z)),
          Math.abs(field(x, z + step) - field(x, z)),
        );
      }
      // Two octaves of quintic-faded value noise are Lipschitz with constant ~2.5/λ,
      // so a step of `step` meters can move the field by at most ~2.5·step/λ. The
      // bound is what makes a stand a stand: at λ = 140 m a 0.1 m step moves it by
      // less than 0.2 %.
      expect(worst).toBeLessThan((2.5 * step) / wavelength);
      expect(worst).toBeGreaterThan(0); // ...but it does move.
    }
  });

  it('adds detail with each octave instead of repeating the first', () => {
    const one = fbm2D(55, 1, 200);
    const three = fbm2D(55, 3, 200);
    expect(three(31.5, 77.25)).not.toBe(one(31.5, 77.25));

    /**
     * Roughness *relative to the field's own spread*: absolute short-lag variation says
     * little here, because normalising the octave sum shrinks the base octave by
     * exactly as much as the finer octaves add. What extra octaves really buy is
     * structure at short range — the field decorrelates faster for its amplitude.
     */
    const roughness = (field: (x: number, z: number) => number): number => {
      const values: number[] = [];
      let steps = 0;
      for (let i = 0; i < 2_000; i++) {
        const x = i * 2.3;
        values.push(field(x, 11.5));
        steps += Math.abs(field(x + 5, 11.5) - field(x, 11.5));
      }
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
      return steps / values.length / sd;
    };
    expect(roughness(three)).toBeGreaterThan(roughness(one) * 1.2);
  });
});
