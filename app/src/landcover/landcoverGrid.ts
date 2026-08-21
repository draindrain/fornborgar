/**
 * The land-cover class raster (docs/data-formats.md §9).
 *
 * One uint8 class **index** per cell of the **context** grid — geometry identical to
 * `grids.context` (same width, height, resolution, bounds; row 0 = north), exactly
 * like `water_connect.tif` (§7), so `grids.context` stays authoritative and the app
 * reuses the §1 array convention unchanged.
 *
 * Indices must never be interpolated: every lookup here is nearest-sample, and the
 * ground-tint texture uses `NearestFilter` for the same reason.
 */

import type { GridSpec } from '../lib/coords';

export interface LandcoverGrid extends GridSpec {
  /** Class indices into `legend.classes[]`, row-major, row 0 = north. */
  classes: Uint8Array;
}

/** Class index at integer sample (col, row), clamped to the grid. Nearest, never blended. */
export function classAtGrid(grid: LandcoverGrid, col: number, row: number): number {
  const c = col < 0 ? 0 : col > grid.width - 1 ? grid.width - 1 : Math.round(col);
  const r = row < 0 ? 0 : row > grid.height - 1 ? grid.height - 1 : Math.round(row);
  return grid.classes[r * grid.width + c];
}

/** Class index at local (x, z). Nearest-sample, same idiom as `connectAtGrid`. */
export function classAtLocal(grid: LandcoverGrid, x: number, z: number): number {
  const col = (x - grid.boundsLocal.minX) / grid.resolution - 0.5;
  const row = (z - grid.boundsLocal.minZ) / grid.resolution - 0.5;
  return classAtGrid(grid, col, row);
}

/** Per-class cell counts, length `classCount`. Used for the legend's percentages. */
export function classHistogram(grid: LandcoverGrid, classCount: number): Int32Array {
  const counts = new Int32Array(classCount);
  for (let i = 0; i < grid.classes.length; i++) {
    const v = grid.classes[i];
    if (v < classCount) counts[v]++;
  }
  return counts;
}
