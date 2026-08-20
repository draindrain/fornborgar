import { describe, expect, it } from 'vitest';
import {
  computeViewshed,
  DEFAULT_REFRACTION_K,
  EARTH_RADIUS_M,
  type ViewshedParams,
} from '../src/viewshed/xdraw';

/**
 * Unit tests for the XDraw viewshed (contract docs/data-formats.md §4, PLAN §4.4).
 *
 * The interesting cases are the ones with an analytic answer: a flat plane (all
 * visible), a flat plane under curvature (visible out to the geometric horizon and
 * no further), a knife-edge ridge (a shadow with a closed-form far edge). For the
 * ridge we do not hand-derive the mask — we brute-force an exact line-of-sight per
 * cell here in the test and hold XDraw against it, because "the approximation is
 * acceptable" is only a claim until it is measured. Agreement against gdal_viewshed
 * on real-shaped terrain is the pipeline's job (pipeline/tests/test_viewshed_xdraw.py).
 */

function flat(width: number, height: number, level = 10): Float32Array {
  return new Float32Array(width * height).fill(level);
}

function count(mask: Uint8Array, value: number): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === value) n++;
  return n;
}

function bilinear(heights: Float32Array, width: number, height: number, col: number, row: number): number {
  const cl = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  const c0 = cl(Math.floor(col), width - 1);
  const r0 = cl(Math.floor(row), height - 1);
  const c1 = cl(c0 + 1, width - 1);
  const r1 = cl(r0 + 1, height - 1);
  const fx = cl(col - c0, 1);
  const fy = cl(row - r0, 1);
  const h00 = heights[r0 * width + c0];
  const h10 = heights[r0 * width + c1];
  const h01 = heights[r1 * width + c0];
  const h11 = heights[r1 * width + c1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
}

/**
 * Reference implementation: exact per-cell line of sight, walking the segment from
 * the observer to every cell at quarter-cell steps on the bilinear surface. O(n·r),
 * far too slow for 4 M cells — which is exactly why the app ships XDraw.
 */
function exactViewshed(p: ViewshedParams): Uint8Array {
  const { heights, width, height, resolution } = p;
  const observerHeight = p.observerHeight ?? 1.7;
  const targetHeight = p.targetHeight ?? 0;
  const maxRadius = p.maxRadius ?? 0;
  const curv = (p.curvature ?? true) ? (1 - (p.refractionK ?? DEFAULT_REFRACTION_K)) / (2 * EARTH_RADIUS_M) : 0;
  const eyeZ = bilinear(heights, width, height, p.observerCol, p.observerRow) + observerHeight;

  const out = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const dCol = col - p.observerCol;
      const dRow = row - p.observerRow;
      const d = Math.hypot(dCol, dRow) * resolution;
      if (d === 0) {
        out[row * width + col] = 1;
        continue;
      }
      if (maxRadius > 0 && d > maxRadius) continue;
      const targetSlope = (heights[row * width + col] - curv * d * d + targetHeight - eyeZ) / d;
      const steps = Math.ceil(Math.max(Math.abs(dCol), Math.abs(dRow)) * 4);
      let visible = 1;
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        const dd = d * f;
        const th = bilinear(heights, width, height, p.observerCol + dCol * f, p.observerRow + dRow * f) - curv * dd * dd;
        if ((th - eyeZ) / dd > targetSlope + 1e-12) {
          visible = 0;
          break;
        }
      }
      out[row * width + col] = visible;
    }
  }
  return out;
}

/** Cells with an 8-neighbour of the opposite visibility. */
function boundaryCells(mask: Uint8Array, width: number, height: number): Uint8Array {
  const b = new Uint8Array(mask.length);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      for (let dr = -1; dr <= 1 && !b[i]; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= height || c < 0 || c >= width) continue;
          if (mask[r * width + c] !== mask[i]) {
            b[i] = 1;
            break;
          }
        }
      }
    }
  }
  return b;
}

describe('flat ground', () => {
  it('is entirely visible with curvature off (contract §4)', () => {
    const width = 101;
    const height = 81;
    const mask = computeViewshed({
      heights: flat(width, height),
      width,
      height,
      resolution: 2,
      observerCol: 50,
      observerRow: 40,
      curvature: false,
    });
    expect(mask).toBeInstanceOf(Uint8Array);
    expect(mask.length).toBe(width * height);
    expect(count(mask, 1)).toBe(width * height);
  });

  it('loses everything past the analytic horizon with curvature on', () => {
    // Δh = (1 − k)·d²/(2R) reaches the eye height at d = sqrt(2·h·R/(1−k)).
    // Eye 0.1 m up puts that horizon at ~1210 m, well inside a 4 km window.
    const width = 501;
    const height = 501;
    const resolution = 8;
    const observerHeight = 0.1;
    const horizon = Math.sqrt((2 * observerHeight * EARTH_RADIUS_M) / (1 - DEFAULT_REFRACTION_K));
    expect(horizon).toBeGreaterThan(1200);
    expect(horizon).toBeLessThan(1220);

    const mask = computeViewshed({
      heights: flat(width, height, 0),
      width,
      height,
      resolution,
      observerCol: 250,
      observerRow: 250,
      observerHeight,
      curvature: true,
    });

    // Every visible cell is inside the horizon, every hidden one outside — to
    // within the one cell of quantisation the grid allows.
    let maxVisible = 0;
    let minHidden = Infinity;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const d = Math.hypot(col - 250, row - 250) * resolution;
        if (mask[row * width + col]) maxVisible = Math.max(maxVisible, d);
        else minHidden = Math.min(minHidden, d);
      }
    }
    expect(maxVisible).toBeLessThanOrEqual(horizon + resolution);
    expect(minHidden).toBeGreaterThanOrEqual(horizon - resolution);
    expect(count(mask, 0)).toBeGreaterThan(0);
  });

  it('is fully visible again when curvature is switched off on the same grid', () => {
    const width = 501;
    const height = 501;
    const mask = computeViewshed({
      heights: flat(width, height, 0),
      width,
      height,
      resolution: 8,
      observerCol: 250,
      observerRow: 250,
      observerHeight: 0.1,
      curvature: false,
    });
    expect(count(mask, 0)).toBe(0);
  });
});

describe('a single ridge', () => {
  const width = 129;
  const height = 129;
  const resolution = 2;
  const heights = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    heights[row * width + 70] = 12;
    heights[row * width + 71] = 12;
  }
  const params: ViewshedParams = {
    heights,
    width,
    height,
    resolution,
    observerCol: 20,
    observerRow: 64,
    observerHeight: 1.7,
    curvature: false,
  };

  it('agrees with exact per-cell line of sight, with errors only at the shadow edge', () => {
    const ours = computeViewshed(params);
    const exact = exactViewshed(params);

    let disagree = 0;
    let stray = 0;
    const near = boundaryCells(exact, width, height);
    // One dilation step: "adjacent to the shadow boundary".
    const near2 = new Uint8Array(near.length);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const r = row + dr;
            const c = col + dc;
            if (r < 0 || r >= height || c < 0 || c >= width) continue;
            if (near[r * width + c]) near2[row * width + col] = 1;
          }
        }
      }
    }
    for (let i = 0; i < ours.length; i++) {
      if (ours[i] !== exact[i]) {
        disagree++;
        if (!near2[i]) stray++;
      }
    }
    const agreement = 1 - disagree / ours.length;
    expect(agreement).toBeGreaterThanOrEqual(0.99);
    expect(stray).toBe(0);

    // Guard against a vacuous pass: there has to be a real shadow.
    const visible = count(exact, 1) / exact.length;
    expect(visible).toBeGreaterThan(0.3);
    expect(visible).toBeLessThan(0.9);
  });

  it('hides ground behind the ridge and shows the ridge crest itself', () => {
    const mask = computeViewshed(params);
    expect(mask[64 * width + 70]).toBe(1); // crest, facing the observer
    expect(mask[64 * width + 72]).toBe(0); // immediately in the lee
    expect(mask[64 * width + 60]).toBe(1); // open ground in front of the ridge

    // The 12 m wall seen from 1.7 m at 100 m keeps hiding ground far downrange:
    // the shadow only ends where the sight line climbs back to the ground, which
    // for level ground behind an opaque wall is never.
    expect(mask[64 * width + 128]).toBe(0);
  });
});

describe('observer handling', () => {
  const width = 65;
  const height = 65;

  it('always marks the observer cell visible, even inside a pit', () => {
    const heights = new Float32Array(width * height).fill(30);
    heights[32 * width + 32] = 0; // observer sits at the bottom of a 30 m hole
    const mask = computeViewshed({
      heights,
      width,
      height,
      resolution: 2,
      observerCol: 32,
      observerRow: 32,
      observerHeight: 1.7,
      curvature: false,
    });
    expect(mask[32 * width + 32]).toBe(1);
  });

  it('handles a fractional observer position sanely', () => {
    const heights = new Float32Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) heights[row * width + col] = col * 0.25;
    }
    const base: ViewshedParams = {
      heights,
      width,
      height,
      resolution: 2,
      observerCol: 32,
      observerRow: 32,
      observerHeight: 1.7,
      curvature: false,
    };
    const whole = computeViewshed(base);
    const nudged = computeViewshed({ ...base, observerCol: 32.4, observerRow: 32.4 });
    const halfway = computeViewshed({ ...base, observerCol: 32.5, observerRow: 32.5 });

    for (const m of [nudged, halfway]) {
      expect(count(m, 1) + count(m, 0)).toBe(width * height);
      // The nearest cell to a fractional observer is still visible.
      expect(m[32 * width + 32]).toBe(1);
    }
    // A 0.4-cell nudge on this gentle plane must not upend the answer.
    let same = 0;
    for (let i = 0; i < whole.length; i++) if (whole[i] === nudged[i]) same++;
    expect(same / whole.length).toBeGreaterThan(0.95);

    // Bilinear observer ground height: on this west-east ramp, moving the observer
    // half a cell east raises the eye and can only reveal more of the upslope.
    expect(count(halfway, 1)).toBeGreaterThanOrEqual(count(whole, 1) - width);
  });

  it('interpolates the observer ground height bilinearly', () => {
    // One row: a 4 m step at col 1, then level ground with a 2 m block at col 4.
    // Standing at col 0 the eye is at 1 m and the step hides everything past it;
    // standing at col 0.9 the bilinear ground is 3.6 m, the eye clears the step,
    // and the far side opens up. Nothing but the eye height changes.
    const w = 8;
    const h = 1;
    const heights = Float32Array.from([0, 4, 0, 0, 2, 0, 0, 0]);
    const common = { heights, width: w, height: h, resolution: 1, observerRow: 0, observerHeight: 1, curvature: false };

    const onGround = computeViewshed({ ...common, observerCol: 0 });
    const onStep = computeViewshed({ ...common, observerCol: 0.9 });

    expect(onGround[1]).toBe(1); // the step face itself
    expect(onGround[4]).toBe(0); // eye at 1.0 m — the 4 m step hides the far side
    expect(onStep[4]).toBe(1); // eye at 4.6 m — over the step, the block is in view
    expect(count(onStep, 1)).toBeGreaterThan(count(onGround, 1));
  });
});

describe('maxRadius', () => {
  it('cuts a circle and hides everything outside it', () => {
    const width = 121;
    const height = 121;
    const resolution = 2;
    const maxRadius = 80; // = 40 cells
    const mask = computeViewshed({
      heights: flat(width, height),
      width,
      height,
      resolution,
      observerCol: 60,
      observerRow: 60,
      maxRadius,
      curvature: false,
    });

    let inside = 0;
    let insideVisible = 0;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const d = Math.hypot(col - 60, row - 60) * resolution;
        const v = mask[row * width + col];
        if (d <= maxRadius) {
          inside++;
          insideVisible += v;
        } else {
          expect(v).toBe(0);
        }
      }
    }
    // Flat ground: everything inside the disc is visible.
    expect(insideVisible).toBe(inside);
    // And the disc is really a disc, not the whole grid.
    expect(inside).toBeLessThan(width * height);
    expect(inside).toBeGreaterThan(0.9 * Math.PI * (maxRadius / resolution) ** 2);
  });

  it('maxRadius 0 means unlimited', () => {
    const width = 41;
    const height = 41;
    const mask = computeViewshed({
      heights: flat(width, height),
      width,
      height,
      resolution: 2,
      observerCol: 20,
      observerRow: 20,
      maxRadius: 0,
      curvature: false,
    });
    expect(count(mask, 1)).toBe(width * height);
  });
});

describe('output buffer', () => {
  const width = 63;
  const height = 45;
  const heights = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      heights[row * width + col] = 5 * Math.sin(col / 6) * Math.cos(row / 5) + 0.02 * col * row;
    }
  }
  const params: ViewshedParams = {
    heights,
    width,
    height,
    resolution: 2,
    observerCol: 31,
    observerRow: 22,
    observerHeight: 1.7,
    curvature: false,
  };

  it('reuses a supplied buffer and returns identical content', () => {
    const fresh = computeViewshed(params);
    const reused = new Uint8Array(width * height).fill(7); // pre-dirtied
    const returned = computeViewshed(params, reused);
    expect(returned).toBe(reused);
    expect(Array.from(reused)).toEqual(Array.from(fresh));
  });

  it('clears stale visibility from a previous run', () => {
    const buf = computeViewshed({ ...params, observerHeight: 200 });
    const manyVisible = count(buf, 1);
    computeViewshed({ ...params, observerHeight: 0.01 }, buf);
    expect(count(buf, 1)).toBeLessThan(manyVisible);
    expect(count(buf, 1) + count(buf, 0)).toBe(width * height);
  });

  it('allocates when the supplied buffer is too small', () => {
    const tooSmall = new Uint8Array(10);
    const returned = computeViewshed(params, tooSmall);
    expect(returned).not.toBe(tooSmall);
    expect(returned.length).toBe(width * height);
  });

  it('emits only 0 and 1', () => {
    const mask = computeViewshed(params);
    expect(count(mask, 0) + count(mask, 1)).toBe(width * height);
  });
});

describe('argument validation', () => {
  it('rejects a heights array that is too short', () => {
    expect(() =>
      computeViewshed({ heights: new Float32Array(10), width: 100, height: 100, resolution: 2, observerCol: 1, observerRow: 1 }),
    ).toThrow(/heights/);
  });

  it('rejects a non-positive resolution', () => {
    expect(() =>
      computeViewshed({ heights: new Float32Array(100), width: 10, height: 10, resolution: 0, observerCol: 1, observerRow: 1 }),
    ).toThrow(/resolution/);
  });
});
