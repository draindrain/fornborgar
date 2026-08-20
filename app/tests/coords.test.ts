import { describe, expect, it } from 'vitest';
import {
  boundsLocalFrom3006,
  enFromLocal,
  gridFromLocal,
  heightAtGrid,
  heightAtLocal,
  localFromEN,
  localFromGrid,
  sampleIndex,
  type GridSpec,
} from '../src/lib/coords';

// Broborg's real numbers (PLAN §2.1 [phase-0 verified] / docs/data-formats.md §2).
const ORIGIN = { e: 665810.0, n: 6627880.0 };

const CORE: GridSpec = {
  width: 2000,
  height: 2000,
  resolution: 1,
  boundsLocal: { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 },
};

describe('EPSG:3006 <-> local scene mapping (contract §0)', () => {
  it('puts the origin at the scene origin', () => {
    const at = localFromEN(ORIGIN.e, ORIGIN.n, ORIGIN);
    expect(at.x).toBeCloseTo(0, 9);
    expect(at.z).toBeCloseTo(0, 9);
  });

  it('maps east to +x and north to -z', () => {
    const east = localFromEN(ORIGIN.e + 250, ORIGIN.n, ORIGIN);
    expect(east.x).toBeCloseTo(250, 9);
    expect(east.z).toBeCloseTo(0, 9);

    const north = localFromEN(ORIGIN.e, ORIGIN.n + 250, ORIGIN);
    expect(north.x).toBeCloseTo(0, 9);
    expect(north.z).toBeCloseTo(-250, 9); // north = −z
  });

  it('round-trips E/N -> local -> E/N', () => {
    for (const [e, n] of [
      [664810, 6626880],
      [666810, 6628880],
      [665810.5, 6627880.25],
      [0, 0],
    ] as const) {
      const { x, z } = localFromEN(e, n, ORIGIN);
      const back = enFromLocal(x, z, ORIGIN);
      expect(back.e).toBeCloseTo(e, 6);
      expect(back.n).toBeCloseTo(n, 6);
    }
  });

  it('derives boundsLocal from bounds3006 with minZ on the NORTH edge', () => {
    const bounds = boundsLocalFrom3006(
      { minE: 664810, minN: 6626880, maxE: 666810, maxN: 6628880 },
      ORIGIN,
    );
    expect(bounds).toEqual({ minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 });

    // The load-bearing half of the convention: minZ comes from *maxN*.
    expect(localFromEN(664810, 6628880, ORIGIN).z).toBeCloseTo(bounds.minZ, 9);
    expect(localFromEN(664810, 6626880, ORIGIN).z).toBeCloseTo(bounds.maxZ, 9);
  });

  it('agrees with the manifest example for both Broborg grids', () => {
    expect(boundsLocalFrom3006({ minE: 663810, minN: 6625880, maxE: 667810, maxN: 6629880 }, ORIGIN)).toEqual({
      minX: -2000,
      minZ: -2000,
      maxX: 2000,
      maxZ: 2000,
    });
  });
});

describe('grid <-> local pixel-centre math (contract §1)', () => {
  it('places sample (0,0) half a pixel inside the NW corner', () => {
    expect(localFromGrid(0, 0, CORE)).toEqual({ x: -999.5, z: -999.5 });
  });

  it('places the last sample half a pixel inside the SE corner', () => {
    expect(localFromGrid(CORE.width - 1, CORE.height - 1, CORE)).toEqual({ x: 999.5, z: 999.5 });
  });

  it('advances +x with col and +z (southward) with row', () => {
    const a = localFromGrid(10, 10, CORE);
    const b = localFromGrid(11, 10, CORE);
    const c = localFromGrid(10, 11, CORE);
    expect(b.x - a.x).toBeCloseTo(CORE.resolution, 9);
    expect(c.z - a.z).toBeCloseTo(CORE.resolution, 9);
  });

  it('round-trips grid -> local -> grid, including fractional samples', () => {
    for (const [col, row] of [
      [0, 0],
      [1999, 1999],
      [37, 1042],
      [12.5, 800.25],
    ] as const) {
      const { x, z } = localFromGrid(col, row, CORE);
      const back = gridFromLocal(x, z, CORE);
      expect(back.col).toBeCloseTo(col, 6);
      expect(back.row).toBeCloseTo(row, 6);
    }
  });

  it('works at 2 m resolution too', () => {
    const context: GridSpec = {
      width: 2000,
      height: 2000,
      resolution: 2,
      boundsLocal: { minX: -2000, minZ: -2000, maxX: 2000, maxZ: 2000 },
    };
    expect(localFromGrid(0, 0, context)).toEqual({ x: -1999, z: -1999 });
    const rt = gridFromLocal(-1999, -1999, context);
    expect(rt.col).toBeCloseTo(0, 9);
    expect(rt.row).toBeCloseTo(0, 9);
  });

  it('indexes row-major with row 0 = north', () => {
    expect(sampleIndex(0, 0, CORE)).toBe(0);
    expect(sampleIndex(5, 0, CORE)).toBe(5);
    expect(sampleIndex(0, 1, CORE)).toBe(CORE.width);
    expect(sampleIndex(3, 2, CORE)).toBe(2 * CORE.width + 3);
  });
});

describe('height sampling', () => {
  const grid: GridSpec = {
    width: 3,
    height: 3,
    resolution: 10,
    boundsLocal: { minX: 0, minZ: 0, maxX: 30, maxZ: 30 },
  };
  // Rows north -> south; value = 10*row + col so orientation errors are obvious.
  const heights = Float32Array.from([0, 1, 2, 10, 11, 12, 20, 21, 22]);

  it('reads integer samples', () => {
    expect(heightAtGrid(heights, 2, 0, grid)).toBe(2);
    expect(heightAtGrid(heights, 0, 2, grid)).toBe(20);
  });

  it('clamps outside the grid', () => {
    expect(heightAtGrid(heights, -5, -5, grid)).toBe(0);
    expect(heightAtGrid(heights, 99, 99, grid)).toBe(22);
  });

  it('bilinearly interpolates at local coordinates', () => {
    // Pixel centres are at 5, 15, 25.
    expect(heightAtLocal(heights, 5, 5, grid)).toBeCloseTo(0, 6);
    expect(heightAtLocal(heights, 15, 5, grid)).toBeCloseTo(1, 6);
    expect(heightAtLocal(heights, 10, 5, grid)).toBeCloseTo(0.5, 6);
    expect(heightAtLocal(heights, 5, 10, grid)).toBeCloseTo(5, 6);
    expect(heightAtLocal(heights, 10, 10, grid)).toBeCloseTo(5.5, 6);
  });

  it('clamps at the edges instead of wrapping', () => {
    expect(heightAtLocal(heights, -100, -100, grid)).toBeCloseTo(0, 6);
    expect(heightAtLocal(heights, 500, 500, grid)).toBeCloseTo(22, 6);
  });
});
