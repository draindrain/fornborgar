import { describe, expect, it } from 'vitest';
import { decodeHeights, elevationRange, normalAt } from '../src/terrain/heightGrid';

describe('int16-decimetre decode (contract §1)', () => {
  it('multiplies raw samples by encoding.scale', () => {
    const raw = Int16Array.from([0, 1, 10, 68, 573, -100, 32767, -32768]);
    const m = decodeHeights(raw, 0.1);
    expect(m).toBeInstanceOf(Float32Array);
    expect(Array.from(m, (v) => Number(v.toFixed(4)))).toEqual([0, 0.1, 1, 6.8, 57.3, -10, 3276.7, -3276.8]);
  });

  it('keeps the row-major layout untouched', () => {
    const raw = Int16Array.from([1, 2, 3, 4, 5, 6]);
    expect(Array.from(decodeHeights(raw, 0.1), (v) => Math.round(v * 10))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('measures the elevation range', () => {
    expect(elevationRange(decodeHeights(Int16Array.from([68, 573, 120]), 0.1)).map((v) => Number(v.toFixed(2)))).toEqual(
      [6.8, 57.3],
    );
  });
});

/** Build a grid whose heights follow h(x, z) = a*x + b*z at pixel centres. */
function analyticSlope(width: number, height: number, resolution: number, a: number, b: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      out[row * width + col] = a * ((col + 0.5) * resolution) + b * ((row + 0.5) * resolution);
    }
  }
  return out;
}

function expectUnit(n: ArrayLike<number>): void {
  expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 6);
}

describe('central-difference normals (PLAN §4.2)', () => {
  it('is straight up on flat ground', () => {
    const flat = new Float32Array(25).fill(7.25);
    const n = normalAt(flat, 5, 5, 1, 2, 2);
    expectUnit(n);
    expect(n[0]).toBeCloseTo(0, 9);
    expect(n[1]).toBeCloseTo(1, 9);
    expect(n[2]).toBeCloseTo(0, 9);
  });

  it('matches the analytic normal of a plane sloping east', () => {
    const a = 0.25; // rises 0.25 m per metre eastward
    const heights = analyticSlope(9, 9, 1, a, 0);
    const n = normalAt(heights, 9, 9, 1, 4, 4);
    expectUnit(n);
    const expected = [-a, 1, 0].map((v) => v / Math.hypot(a, 1, 0));
    expect(n[0]).toBeCloseTo(expected[0], 6);
    expect(n[1]).toBeCloseTo(expected[1], 6);
    expect(n[2]).toBeCloseTo(expected[2], 6);
    // Rising eastward tilts the normal west.
    expect(n[0]).toBeLessThan(0);
  });

  it('matches the analytic normal of a plane sloping in both axes, at 2 m resolution', () => {
    const a = -0.1;
    const b = 0.4; // rises southward (+z)
    const res = 2;
    const heights = analyticSlope(11, 11, res, a, b);
    const n = normalAt(heights, 11, 11, res, 5, 5);
    expectUnit(n);
    const len = Math.hypot(a, 1, b);
    expect(n[0]).toBeCloseTo(-a / len, 6);
    expect(n[1]).toBeCloseTo(1 / len, 6);
    expect(n[2]).toBeCloseTo(-b / len, 6);
  });

  it('falls back to one-sided differences at the border, staying exact on a plane', () => {
    const a = 0.3;
    const b = -0.2;
    const heights = analyticSlope(7, 7, 1, a, b);
    const len = Math.hypot(a, 1, b);
    for (const [col, row] of [
      [0, 0],
      [6, 0],
      [0, 6],
      [6, 6],
      [3, 0],
      [0, 3],
    ] as const) {
      const n = normalAt(heights, 7, 7, 1, col, row);
      expectUnit(n);
      expect(n[0]).toBeCloseTo(-a / len, 6);
      expect(n[2]).toBeCloseTo(-b / len, 6);
    }
  });

  it('resolves a 1.5 m rampart on a 1 m grid as opposed tilts on its two flanks', () => {
    // A single-cell-wide bank across an otherwise flat surface: exactly the
    // Phase-1 legibility case (PLAN §5 risk row).
    const w = 9;
    const heights = new Float32Array(w * w);
    for (let row = 0; row < w; row++) heights[row * w + 4] = 1.5;

    const west = normalAt(heights, w, w, 1, 3, 4); // approaching the bank
    const east = normalAt(heights, w, w, 1, 5, 4); // leaving it
    expect(west[0]).toBeLessThan(-0.5); // uphill east -> normal points west
    expect(east[0]).toBeGreaterThan(0.5); // downhill east -> normal points east
    expectUnit(west);
    expectUnit(east);
  });

  it('writes into the supplied output array and returns it', () => {
    const out = new Float32Array(3);
    const returned = normalAt(new Float32Array(9), 3, 3, 1, 1, 1, out);
    expect(returned).toBe(out);
    expect(out[1]).toBe(1);
  });
});
