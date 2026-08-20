/**
 * The decoded height grid — the single source of truth for mesh, normals and
 * (from Phase 3 on) the viewshed and water shading.
 *
 * Array convention (docs/data-formats.md §1): row-major, length width*height,
 * row 0 = northernmost row, columns west -> east. Values are **meters RH 2000**
 * (raw int16 decimeters already multiplied by `encoding.scale`).
 */

import type { GridSpec } from '../lib/coords';

export interface HeightGrid extends GridSpec {
  /** Meters RH 2000, row-major, row 0 = north. */
  heights: Float32Array;
  minElevation: number;
  maxElevation: number;
}

/**
 * Raw int16 decimeters -> Float32Array of meters. Done exactly once per grid;
 * everything downstream reads this array.
 */
export function decodeHeights(raw: ArrayLike<number>, scale: number): Float32Array {
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] * scale;
  return out;
}

/** Measured [min, max] of a decoded grid, in meters. */
export function elevationRange(heights: Float32Array): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/**
 * Surface normal at sample (col, row) by **central differences on the height
 * grid** (PLAN §4.2) — never `computeVertexNormals()`. This is where earthwork
 * legibility lives: the normals come from the full-resolution grid regardless of
 * how the mesh is tessellated, and at the grid edges we fall back to one-sided
 * differences.
 *
 * With east = +x and rows growing southward = +z, a surface h(x, z) has
 * normal ∝ (−∂h/∂x, 1, −∂h/∂z).
 *
 * Writes the unit normal into `out` (length >= 3) and returns it.
 */
export function normalAt(
  heights: Float32Array,
  width: number,
  height: number,
  resolution: number,
  col: number,
  row: number,
  out: Float32Array | number[] = new Float32Array(3),
): Float32Array | number[] {
  const cw = col < 0 ? 0 : col > width - 1 ? width - 1 : col;
  const rw = row < 0 ? 0 : row > height - 1 ? height - 1 : row;

  const cL = cw > 0 ? cw - 1 : cw;
  const cR = cw < width - 1 ? cw + 1 : cw;
  const rN = rw > 0 ? rw - 1 : rw;
  const rS = rw < height - 1 ? rw + 1 : rw;

  const dx = (heights[rw * width + cR] - heights[rw * width + cL]) / ((cR - cL) * resolution);
  const dz = (heights[rS * width + cw] - heights[rN * width + cw]) / ((rS - rN) * resolution);

  const nx = -dx;
  const ny = 1;
  const nz = -dz;
  const inv = 1 / Math.hypot(nx, ny, nz);
  out[0] = nx * inv;
  out[1] = ny * inv;
  out[2] = nz * inv;
  return out;
}
