/**
 * The sea-connectivity grid (docs/data-formats.md §7).
 *
 * One value per cell of the **context** grid: the minimum water level at which
 * that cell is hydrologically connected to the open sea. Because connectivity is
 * monotone in the water level, this single grid is equivalent to a wet/dry
 * bitmask for *every* level:
 *
 *     wet and sea-connected at level h   ⇔   connect ≤ h
 *
 * The elevation test is subsumed (`connect ≥ dem` everywhere), which is why both
 * the water plane and the terrain tint need exactly one texture lookup and never
 * a second comparison against the DEM — and why false basins, whose cells carry
 * their basin's spill level rather than their own elevation, stay dry.
 *
 * Array convention is §1's, identical to the height grids: row-major,
 * row 0 = northernmost, values already scaled to meters.
 */

import type { GridSpec } from '../lib/coords';

export interface ConnectGrid extends GridSpec {
  /** Meters RH 2000, row-major, row 0 = north. */
  values: Float32Array;
}

/** Connect level (m) at integer sample (col, row), clamped to the grid. */
export function connectAtGrid(grid: ConnectGrid, col: number, row: number): number {
  const c = col < 0 ? 0 : col > grid.width - 1 ? grid.width - 1 : Math.round(col);
  const r = row < 0 ? 0 : row > grid.height - 1 ? grid.height - 1 : Math.round(row);
  return grid.values[r * grid.width + c];
}

/** Is local (x, z) wet and sea-connected at `levelM`? Nearest-sample test. */
export function isWetAt(grid: ConnectGrid, x: number, z: number, levelM: number): boolean {
  const col = (x - grid.boundsLocal.minX) / grid.resolution - 0.5;
  const row = (z - grid.boundsLocal.minZ) / grid.resolution - 0.5;
  return connectAtGrid(grid, col, row) <= levelM;
}
