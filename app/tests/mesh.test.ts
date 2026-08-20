import { describe, expect, it } from 'vitest';
import type { HeightGrid } from '../src/terrain/heightGrid';
import { ElevationTint } from '../src/terrain/material';
import {
  CORE_CHUNKS_PER_SIDE,
  buildGridPatch,
  buildSkirt,
  chunkRanges,
  contextInteriorRange,
  contextRingRanges,
  coreCutoutQuads,
  coveredRect,
} from '../src/terrain/mesh';

function grid(width: number, height: number, resolution: number, half: number, fill = 5): HeightGrid {
  return {
    width,
    height,
    resolution,
    boundsLocal: { minX: -half, minZ: -half, maxX: half, maxZ: half },
    heights: new Float32Array(width * height).fill(fill),
    minElevation: fill,
    maxElevation: fill,
  };
}

// Broborg-sized grids (contract §2 example).
const core = grid(2000, 2000, 1, 1000);
const context = grid(2000, 2000, 2, 2000);

describe('chunking (PLAN §4.2: 16 frustum-cullable chunks sharing edge vertices)', () => {
  const ranges = chunkRanges(core);

  it('produces 4x4 = 16 chunks', () => {
    expect(CORE_CHUNKS_PER_SIDE).toBe(4);
    expect(ranges).toHaveLength(16);
  });

  it('tiles all 1999x1999 cells exactly once', () => {
    let cells = 0;
    for (const r of ranges) cells += (r.col1 - r.col0) * (r.row1 - r.row0);
    expect(cells).toBe(1999 * 1999);
  });

  it('shares edge vertices between neighbours', () => {
    const row0 = ranges.filter((r) => r.row0 === 0).sort((a, b) => a.col0 - b.col0);
    for (let i = 1; i < row0.length; i++) {
      expect(row0[i].col0).toBe(row0[i - 1].col1); // the seam column belongs to both
    }
    expect(row0[0].col0).toBe(0);
    expect(row0[row0.length - 1].col1).toBe(core.width - 1);
  });

  it('handles a grid whose cell count is not divisible by 4', () => {
    const odd = grid(256, 256, 1, 128);
    const r = chunkRanges(odd);
    let cells = 0;
    for (const x of r) cells += (x.col1 - x.col0) * (x.row1 - x.row0);
    expect(cells).toBe(255 * 255);
    expect(Math.max(...r.map((x) => x.col1))).toBe(255);
  });
});

describe('geometry from a grid patch', () => {
  const tint = new ElevationTint(0, 10);

  it('puts vertices at pixel centres and keeps y = height', () => {
    const g = grid(4, 4, 1, 2, 0);
    g.heights[2 * 4 + 1] = 3.5;
    const geom = buildGridPatch(g, { col0: 0, col1: 3, row0: 0, row1: 3 }, tint);
    const pos = geom.getAttribute('position').array as Float32Array;

    // Sample (0,0): NW corner, half a pixel in.
    expect(pos[0]).toBeCloseTo(-1.5, 6);
    expect(pos[2]).toBeCloseTo(-1.5, 6);
    // Sample (1,2) carries its own height.
    const v = 2 * 4 + 1;
    expect(pos[v * 3 + 1]).toBeCloseTo(3.5, 6);
  });

  it('emits two triangles per cell, indexed', () => {
    const g = grid(5, 4, 2, 5);
    const geom = buildGridPatch(g, { col0: 0, col1: 4, row0: 0, row1: 3 }, tint);
    expect(geom.getAttribute('position').count).toBe(5 * 4);
    expect(geom.getIndex()?.count).toBe(4 * 3 * 6);
  });

  it('has upward normals on flat ground and a bounding sphere for culling', () => {
    const g = grid(6, 6, 1, 3);
    const geom = buildGridPatch(g, { col0: 0, col1: 5, row0: 0, row1: 5 }, tint);
    const n = geom.getAttribute('normal').array as Float32Array;
    for (let i = 0; i < n.length; i += 3) expect(n[i + 1]).toBeCloseTo(1, 6);
    expect(geom.boundingSphere).not.toBeNull();
  });

  it('rejects degenerate ranges', () => {
    const g = grid(4, 4, 1, 2);
    expect(() => buildGridPatch(g, { col0: 1, col1: 1, row0: 0, row1: 3 }, tint)).toThrow(/degenerate/);
  });
});

describe('core cut-out and the context ring', () => {
  it('covers only the pixel-centre rectangle, not the full bounds', () => {
    expect(coveredRect(core)).toEqual({ minX: -999.5, minZ: -999.5, maxX: 999.5, maxZ: 999.5 });
  });

  it('omits only context quads that lie wholly under the core', () => {
    const cut = coreCutoutQuads(core, context)!;
    expect(cut).toEqual({ c0: 500, c1: 1498, r0: 500, r1: 1498 });

    // The first kept quad on each side straddles the core edge, so the context
    // surface continues underneath the seam.
    const quadMinX = (q: number) => context.boundsLocal.minX + (q + 0.5) * context.resolution;
    const quadMaxX = (q: number) => context.boundsLocal.minX + (q + 1.5) * context.resolution;
    expect(quadMinX(cut.c0)).toBeGreaterThanOrEqual(coveredRect(core).minX);
    expect(quadMinX(cut.c0 - 1)).toBeLessThan(coveredRect(core).minX);
    expect(quadMaxX(cut.c1)).toBeLessThanOrEqual(coveredRect(core).maxX);
  });

  it('tiles the whole context grid with ring bands + interior, without overlap', () => {
    const cut = coreCutoutQuads(core, context);
    const bands = contextRingRanges(context, cut);
    const interior = contextInteriorRange(cut)!;

    const area = (r: { col0: number; col1: number; row0: number; row1: number }) =>
      (r.col1 - r.col0) * (r.row1 - r.row0);
    const total = bands.reduce((s, b) => s + area(b), 0) + area(interior);
    expect(bands).toHaveLength(4);
    expect(total).toBe(1999 * 1999);
  });

  it('falls back to one full patch when there is no core yet', () => {
    const bands = contextRingRanges(context, null);
    expect(bands).toEqual([{ col0: 0, col1: 1999, row0: 0, row1: 1999 }]);
    expect(contextInteriorRange(null)).toBeNull();
  });

  it('works for the synthetic test site geometry too', () => {
    const tCore = grid(256, 256, 1, 128);
    const tContext = grid(256, 256, 2, 256);
    const cut = coreCutoutQuads(tCore, tContext)!;
    expect(cut).toEqual({ c0: 64, c1: 190, r0: 64, r1: 190 });
    expect(contextRingRanges(tContext, cut)).toHaveLength(4);
  });
});

describe('seam skirt', () => {
  const tint = new ElevationTint(0, 20);

  it('hangs a double-sided curtain of the requested depth around the whole edge', () => {
    const g = grid(6, 6, 1, 3, 12);
    const geom = buildSkirt(g, 9, tint);
    const pos = geom.getAttribute('position').array as Float32Array;
    // 4 strips x 6 samples x 2 vertices.
    expect(geom.getAttribute('position').count).toBe(4 * 6 * 2);
    expect(pos[1]).toBeCloseTo(12, 6);
    expect(pos[4]).toBeCloseTo(3, 6); // 12 − 9
    expect(geom.getIndex()?.count).toBe(4 * 5 * 6);
  });

  it('carries the terrain tint, darkening downward, so the seam sliver reads as ground', () => {
    const g = grid(6, 6, 1, 3, 12);
    const geom = buildSkirt(g, 9, tint);
    const colors = geom.getAttribute('color');
    expect(colors.count).toBe(4 * 6 * 2);
    // Vertex 0 is a top edge vertex, vertex 1 the one hanging below it.
    expect(colors.getX(1)).toBeLessThan(colors.getX(0));
  });
});
