/**
 * Heightfield geometry construction (PLAN §4.2).
 *
 * Everything is built from one primitive, `buildGridPatch`, which turns an
 * inclusive rectangular range of grid samples into an indexed BufferGeometry with
 *   • vertices at **pixel centres** (docs/data-formats.md §1),
 *   • normals from **central differences on the height grid** (never
 *     `computeVertexNormals`) so shading stays at grid resolution, and
 *   • a bounding sphere, so each patch is independently frustum-cullable.
 *
 * The core mesh is a 4x4 grid of such patches (16 chunks sharing edge vertices);
 * the context ring is four bands around the core cut-out plus, until the core has
 * loaded, an interior patch that gives an instant full-extent overview.
 */

import * as THREE from 'three';
import type { HeightGrid } from './heightGrid';
import { normalAt } from './heightGrid';
import type { ElevationTint } from './material';

/** Inclusive **vertex** (sample) range. */
export interface PatchRange {
  col0: number;
  col1: number;
  row0: number;
  row1: number;
}

export const CORE_CHUNKS_PER_SIDE = 4; // 4x4 = 16 chunks

export function buildGridPatch(grid: HeightGrid, range: PatchRange, tint: ElevationTint): THREE.BufferGeometry {
  const { col0, col1, row0, row1 } = range;
  const nx = col1 - col0 + 1;
  const nz = row1 - row0 + 1;
  if (nx < 2 || nz < 2) throw new Error(`buildGridPatch: degenerate range ${JSON.stringify(range)}`);

  const vertexCount = nx * nz;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 3);

  const { minX, minZ } = grid.boundsLocal;
  const res = grid.resolution;
  const w = grid.width;
  const n3 = new Float32Array(3);

  let v = 0;
  for (let r = row0; r <= row1; r++) {
    const z = minZ + (r + 0.5) * res;
    for (let c = col0; c <= col1; c++, v++) {
      const y = grid.heights[r * w + c];
      const o = v * 3;
      positions[o] = minX + (c + 0.5) * res;
      positions[o + 1] = y;
      positions[o + 2] = z;

      normalAt(grid.heights, grid.width, grid.height, res, c, r, n3);
      normals[o] = n3[0];
      normals[o + 1] = n3[1];
      normals[o + 2] = n3[2];

      tint.write(y, colors, o);
    }
  }

  const quads = (nx - 1) * (nz - 1);
  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(quads * 6);
  let i = 0;
  for (let r = 0; r < nz - 1; r++) {
    for (let c = 0; c < nx - 1; c++) {
      const a = r * nx + c;
      const b = a + 1;
      const d = a + nx;
      const e = d + 1;
      // CCW when viewed from +y (x east, z south) => front faces point up.
      indices[i++] = a;
      indices[i++] = d;
      indices[i++] = b;
      indices[i++] = b;
      indices[i++] = d;
      indices[i++] = e;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  return geom;
}

/**
 * Like `buildGridPatch`, but sampling every `step`-th grid cell — the §11 ring
 * annuli render at ¼–⅛ vertex density while their normals still come from the
 * full-resolution grid (`normalAt` reads the heights array directly), so
 * far-terrain legibility lives in shading, not silhouette. The range's last
 * sample is always included exactly (the final interval may be shorter), so
 * decimated bands still tile the grid edge-to-edge with no gaps.
 */
export function buildDecimatedPatch(
  grid: HeightGrid,
  range: PatchRange,
  step: number,
  tint: ElevationTint,
): THREE.BufferGeometry {
  if (!Number.isInteger(step) || step < 1) throw new Error(`buildDecimatedPatch: bad step ${step}`);
  if (step === 1) return buildGridPatch(grid, range, tint);
  const { col0, col1, row0, row1 } = range;
  if (col1 - col0 < 1 || row1 - row0 < 1) {
    throw new Error(`buildDecimatedPatch: degenerate range ${JSON.stringify(range)}`);
  }

  const samplesAlong = (a: number, b: number): number[] => {
    const out: number[] = [];
    for (let v = a; v < b; v += step) out.push(v);
    out.push(b);
    return out;
  };
  const cols = samplesAlong(col0, col1);
  const rows = samplesAlong(row0, row1);
  const nx = cols.length;
  const nz = rows.length;

  const vertexCount = nx * nz;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 3);

  const { minX, minZ } = grid.boundsLocal;
  const res = grid.resolution;
  const w = grid.width;
  const n3 = new Float32Array(3);

  let v = 0;
  for (const r of rows) {
    const z = minZ + (r + 0.5) * res;
    for (const c of cols) {
      const y = grid.heights[r * w + c];
      const o = v * 3;
      positions[o] = minX + (c + 0.5) * res;
      positions[o + 1] = y;
      positions[o + 2] = z;

      normalAt(grid.heights, grid.width, grid.height, res, c, r, n3);
      normals[o] = n3[0];
      normals[o + 1] = n3[1];
      normals[o + 2] = n3[2];

      tint.write(y, colors, o);
      v++;
    }
  }

  const quads = (nx - 1) * (nz - 1);
  const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(quads * 6);
  let i = 0;
  for (let r = 0; r < nz - 1; r++) {
    for (let c = 0; c < nx - 1; c++) {
      const a = r * nx + c;
      const b = a + 1;
      const d = a + nx;
      const e = d + 1;
      indices[i++] = a;
      indices[i++] = d;
      indices[i++] = b;
      indices[i++] = b;
      indices[i++] = d;
      indices[i++] = e;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  return geom;
}

/** Split a grid's sample rectangle into `n x n` patches that share edge vertices. */
export function chunkRanges(grid: HeightGrid, n: number = CORE_CHUNKS_PER_SIDE): PatchRange[] {
  const cellsX = grid.width - 1;
  const cellsZ = grid.height - 1;
  const perX = Math.ceil(cellsX / n);
  const perZ = Math.ceil(cellsZ / n);
  const out: PatchRange[] = [];
  for (let j = 0; j < n; j++) {
    const r0 = j * perZ;
    const r1 = Math.min((j + 1) * perZ, cellsZ);
    if (r1 <= r0) continue;
    for (let i = 0; i < n; i++) {
      const c0 = i * perX;
      const c1 = Math.min((i + 1) * perX, cellsX);
      if (c1 <= c0) continue;
      out.push({ col0: c0, col1: c1, row0: r0, row1: r1 });
    }
  }
  return out;
}

/** Local-space rectangle actually covered by a grid's mesh (pixel centres). */
export function coveredRect(grid: HeightGrid): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const { minX, minZ } = grid.boundsLocal;
  const r = grid.resolution;
  return {
    minX: minX + 0.5 * r,
    minZ: minZ + 0.5 * r,
    maxX: minX + (grid.width - 0.5) * r,
    maxZ: minZ + (grid.height - 0.5) * r,
  };
}

/** Inclusive **quad** range of the context grid that lies wholly under the core mesh. */
export interface QuadRange {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

export function coreCutoutQuads(core: HeightGrid, context: HeightGrid): QuadRange | null {
  const rect = coveredRect(core);
  const { minX, minZ } = context.boundsLocal;
  const r = context.resolution;
  const eps = 1e-9;

  const c0 = Math.max(0, Math.ceil((rect.minX - minX) / r - 0.5 - eps));
  const c1 = Math.min(context.width - 2, Math.floor((rect.maxX - minX) / r - 1.5 + eps));
  const r0 = Math.max(0, Math.ceil((rect.minZ - minZ) / r - 0.5 - eps));
  const r1 = Math.min(context.height - 2, Math.floor((rect.maxZ - minZ) / r - 1.5 + eps));

  if (c1 < c0 || r1 < r0) return null;
  return { c0, c1, r0, r1 };
}

const quadsToVertices = (q: QuadRange): PatchRange => ({
  col0: q.c0,
  col1: q.c1 + 1,
  row0: q.r0,
  row1: q.r1 + 1,
});

/**
 * The four bands of the context grid outside `cutout`. They tile the grid exactly
 * (no gaps, no overlaps), and quads that merely *straddle* the core edge stay in
 * the ring — so the context surface continues a little way underneath the core and
 * the seam can never show through from directly above.
 */
export function contextRingRanges(context: HeightGrid, cutout: QuadRange | null): PatchRange[] {
  const lastQuadX = context.width - 2;
  const lastQuadZ = context.height - 2;
  if (!cutout) return [quadsToVertices({ c0: 0, c1: lastQuadX, r0: 0, r1: lastQuadZ })];

  const { c0, c1, r0, r1 } = cutout;
  const bands: QuadRange[] = [];
  if (r0 > 0) bands.push({ c0: 0, c1: lastQuadX, r0: 0, r1: r0 - 1 }); // north
  if (r1 < lastQuadZ) bands.push({ c0: 0, c1: lastQuadX, r0: r1 + 1, r1: lastQuadZ }); // south
  if (c0 > 0) bands.push({ c0: 0, c1: c0 - 1, r0, r1 }); // west
  if (c1 < lastQuadX) bands.push({ c0: c1 + 1, c1: lastQuadX, r0, r1 }); // east
  return bands.map(quadsToVertices);
}

export function contextInteriorRange(cutout: QuadRange | null): PatchRange | null {
  return cutout ? quadsToVertices(cutout) : null;
}

/**
 * A short downward curtain along the outer boundary of a grid's mesh. Sits at the
 * core/context seam so the 1 m -> 2 m resolution step never shows daylight.
 * Built as four independent strips; the material is double-sided, so winding is
 * not load-bearing.
 */
export function buildSkirt(grid: HeightGrid, depth: number, tint: ElevationTint): THREE.BufferGeometry {
  const { minX, minZ } = grid.boundsLocal;
  const res = grid.resolution;
  const w = grid.width;
  const h = grid.height;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const rgb = new Uint8Array(3);

  // Normals point straight up, not outward: the curtain is meant to be invisible,
  // and a horizontal normal would catch the raking sun completely differently from
  // the ground it abuts, drawing a dark hairline along the seam.
  const strip = (samples: Array<[number, number]>): void => {
    const base = positions.length / 3;
    for (const [c, r] of samples) {
      const x = minX + (c + 0.5) * res;
      const z = minZ + (r + 0.5) * res;
      const y = grid.heights[r * w + c];
      positions.push(x, y, z, x, y - depth, z);
      normals.push(0, 1, 0, 0, 1, 0);
      // Same tint as the terrain at the top edge, shading off downward, so the
      // sliver that does peek out at the seam reads as ground, not a dark hairline.
      tint.write(y, rgb, 0);
      colors.push(rgb[0], rgb[1], rgb[2], (rgb[0] * 0.7) | 0, (rgb[1] * 0.7) | 0, (rgb[2] * 0.7) | 0);
    }
    for (let i = 0; i < samples.length - 1; i++) {
      const a = base + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };

  const cols = Array.from({ length: w }, (_, c) => c);
  const rows = Array.from({ length: h }, (_, r) => r);

  strip(cols.map((c) => [c, 0] as [number, number])); // north edge
  strip(cols.map((c) => [c, h - 1] as [number, number])); // south edge
  strip(rows.map((r) => [0, r] as [number, number])); // west edge
  strip(rows.map((r) => [w - 1, r] as [number, number])); // east edge

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(Uint8Array.from(colors), 3, true));
  geom.setIndex(indices);
  geom.computeBoundingSphere();
  return geom;
}
