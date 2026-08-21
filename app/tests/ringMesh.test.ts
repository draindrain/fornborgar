/**
 * §11 far-field ring rendering units: the shared curvature constants, the
 * decimated annulus meshes, the baked curvature drop and the Terrain ring API.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_REFRACTION_K, EARTH_RADIUS_M, refractedDropM } from '../src/lib/earth';
import {
  DEFAULT_REFRACTION_K as XDRAW_K,
  EARTH_RADIUS_M as XDRAW_R,
} from '../src/viewshed/xdraw';
import type { HeightGrid } from '../src/terrain/heightGrid';
import { normalAt } from '../src/terrain/heightGrid';
import { ElevationTint } from '../src/terrain/material';
import { buildDecimatedPatch, buildGridPatch, contextRingRanges, coreCutoutQuads } from '../src/terrain/mesh';
import { RING_DECIMATION_STEPS, Terrain, applyCurvatureDrop, ringStep } from '../src/terrain/terrain';

function grid(size: number, resolution: number, fill = 5, bumps = false): HeightGrid {
  const half = (size * resolution) / 2;
  const heights = new Float32Array(size * size).fill(fill);
  if (bumps) {
    for (let i = 0; i < heights.length; i++) heights[i] = fill + Math.sin(i * 0.37) * 2;
  }
  return {
    width: size,
    height: size,
    resolution,
    boundsLocal: { minX: -half, minZ: -half, maxX: half, maxZ: half },
    heights,
    minElevation: fill - 2,
    maxElevation: fill + 2,
  };
}

describe('earth constants (contract §4 = §11)', () => {
  it('render-side constants equal the viewshed constants exactly', () => {
    expect(EARTH_RADIUS_M).toBe(XDRAW_R);
    expect(DEFAULT_REFRACTION_K).toBe(XDRAW_K);
  });

  it('refractedDropM matches (1−k)·d²/2R and the §2b landmark values', () => {
    const d = 12345;
    expect(refractedDropM(d * d)).toBeCloseTo((0.87 * d * d) / (2 * 6371000), 10);
    expect(refractedDropM(16000 ** 2)).toBeCloseTo(17.5, 0);
    expect(refractedDropM(32000 ** 2)).toBeCloseTo(69.9, 0);
    expect(refractedDropM(64000 ** 2)).toBeCloseTo(279.6, 0);
  });
});

describe('applyCurvatureDrop (§11: baked into ring render meshes only)', () => {
  it('lowers every sample by the drop at its distance from the origin', () => {
    const g = grid(16, 100, 10); // ±800 m
    const dropped = applyCurvatureDrop(g);
    for (const [col, row] of [
      [0, 0],
      [8, 8],
      [15, 3],
    ]) {
      const x = g.boundsLocal.minX + (col + 0.5) * g.resolution;
      const z = g.boundsLocal.minZ + (row + 0.5) * g.resolution;
      const expected = g.heights[row * g.width + col] - refractedDropM(x * x + z * z);
      expect(dropped.heights[row * g.width + col]).toBeCloseTo(expected, 6);
    }
  });

  it('leaves the raw grid untouched (analysis stays flat-earth)', () => {
    const g = grid(8, 100, 10);
    const before = g.heights.slice();
    applyCurvatureDrop(g);
    expect(g.heights).toEqual(before);
  });
});

describe('buildDecimatedPatch (§11: annulus density ladder)', () => {
  const tint = new ElevationTint(0, 10);
  const g = grid(33, 4, 5, true); // 33 samples → 32 cells, not divisible by 4

  it('step 1 is exactly buildGridPatch', () => {
    const range = { col0: 0, col1: 8, row0: 0, row1: 8 };
    const a = buildDecimatedPatch(g, range, 1, tint);
    const b = buildGridPatch(g, range, tint);
    expect(a.getAttribute('position').array).toEqual(b.getAttribute('position').array);
  });

  it('strides samples and always includes the range end', () => {
    const range = { col0: 0, col1: 32, row0: 0, row1: 32 };
    const geom = buildDecimatedPatch(g, range, 4, tint);
    const pos = geom.getAttribute('position');
    // cols 0,4,…,32 → 9 samples per side.
    expect(pos.count).toBe(9 * 9);
    // First and last vertex sit at the exact range corners (pixel centers).
    const first = [pos.getX(0), pos.getZ(0)];
    const last = [pos.getX(pos.count - 1), pos.getZ(pos.count - 1)];
    const at = (c: number, r: number) => [
      g.boundsLocal.minX + (c + 0.5) * g.resolution,
      g.boundsLocal.minZ + (r + 0.5) * g.resolution,
    ];
    expect(first).toEqual(at(0, 0));
    expect(last).toEqual(at(32, 32));
  });

  it('keeps a shorter final interval when the range is not divisible by step', () => {
    const range = { col0: 0, col1: 30, row0: 0, row1: 30 };
    const geom = buildDecimatedPatch(g, range, 4, tint);
    // cols 0,4,…,28,30 → 9 samples per side.
    expect(geom.getAttribute('position').count).toBe(9 * 9);
  });

  it('takes normals from the full-resolution grid', () => {
    const range = { col0: 0, col1: 32, row0: 0, row1: 32 };
    const geom = buildDecimatedPatch(g, range, 4, tint);
    const nrm = geom.getAttribute('normal');
    const n3 = new Float32Array(3);
    // Vertex (col 8, row 4) is sample index: row 1 (of 9) * 9 + col 2.
    normalAt(g.heights, g.width, g.height, g.resolution, 8, 4, n3);
    const v = 1 * 9 + 2;
    expect(nrm.getX(v)).toBeCloseTo(n3[0], 6);
    expect(nrm.getY(v)).toBeCloseTo(n3[1], 6);
    expect(nrm.getZ(v)).toBeCloseTo(n3[2], 6);
  });
});

describe('ring decimation ladder', () => {
  it('follows the §2b table and clamps beyond it', () => {
    expect([...RING_DECIMATION_STEPS]).toEqual([2, 2, 4, 4, 8]);
    expect(ringStep(0)).toBe(2);
    expect(ringStep(4)).toBe(8);
    expect(ringStep(9)).toBe(8);
  });
});

describe('Terrain.setRing (§11: annulus around the next-finer grid)', () => {
  it('builds inside-out, tracks the outer half-extent, and rejects gaps', async () => {
    const terrain = new Terrain();
    terrain.setElevationRange(0, 10);
    const context = grid(65, 2, 5); // ±65 m
    const ring0 = grid(65, 4, 5); // ±130 m
    const ring1 = grid(65, 8, 5); // ±260 m

    await expect(terrain.setRing(0, ring0)).rejects.toThrow(/next-finer/);
    await terrain.setContext(context);
    expect(terrain.outerHalfExtent()).toBe(65);

    await terrain.setRing(0, ring0);
    expect(terrain.ringCount).toBe(1);
    expect(terrain.outerHalfExtent()).toBe(130);
    await expect(terrain.setRing(2, grid(65, 16, 5))).rejects.toThrow(/next-finer/);

    await terrain.setRing(1, ring1);
    expect(terrain.ringCount).toBe(2);
    expect(terrain.outerHalfExtent()).toBe(260);

    terrain.dispose();
  });

  it('meshes only the annulus band, with the curvature drop baked in', async () => {
    const terrain = new Terrain();
    terrain.setElevationRange(0, 10);
    const context = grid(65, 2, 5);
    const ring0 = grid(65, 40, 5); // ±1300 m — big enough for a measurable drop
    await terrain.setContext(context);
    await terrain.setRing(0, ring0);

    const bands: number[] = [];
    let minY = Infinity;
    terrain.group.traverse((o) => {
      const mesh = o as unknown as { isMesh?: boolean; name: string; geometry?: { getAttribute(n: string): { array: ArrayLike<number>; count: number } } };
      if (!mesh.isMesh || !mesh.name.startsWith('ring-0-band')) return;
      const pos = mesh.geometry!.getAttribute('position');
      bands.push(pos.count);
      for (let i = 0; i < pos.count; i++) minY = Math.min(minY, (pos.array as Float32Array)[i * 3 + 1]);
    });
    expect(bands.length).toBeGreaterThan(0);
    // The far corner (~1838 m out) sits ~0.23 m below the flat 5 m surface.
    const cornerDrop = refractedDropM(2 * 1280 * 1280);
    expect(minY).toBeLessThan(5 - cornerDrop * 0.9);

    // The annulus leaves the context-covered interior to the context mesh: the
    // cutout the ranges were built from is non-empty.
    const cutout = coreCutoutQuads(context, ring0);
    expect(cutout).not.toBeNull();
    expect(contextRingRanges(ring0, cutout).length).toBeGreaterThan(0);
    terrain.dispose();
  });
});
