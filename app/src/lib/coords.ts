/**
 * The one and only coordinate helper (docs/data-formats.md §0 and §1, PLAN §4.3).
 *
 * Every layer in the app — terrain, viewshed, water, markers, camera — converts
 * through this module. The browser never does projection math; only origin
 * subtraction and pixel-center arithmetic.
 *
 *   x = easting  − origin.e            east  = +x
 *   y = height (m RH 2000)             up    = +y   (scene units = meters, 1:1)
 *   z = −(northing − origin.n)         north = −z   (top-down reads like a map)
 *
 * Consequences worth remembering:
 *   • `boundsLocal.minZ` is the **north** edge and `maxZ` the south edge.
 *   • Grid row 0 is the northernmost row, so rows grow toward +z.
 */

export interface Origin {
  e: number;
  n: number;
}

export interface BoundsLocal {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** The minimum a grid must describe for coordinate math (a subset of GridManifest). */
export interface GridSpec {
  width: number;
  height: number;
  /** Meters per pixel. */
  resolution: number;
  boundsLocal: BoundsLocal;
}

export interface LocalXZ {
  x: number;
  z: number;
}

export interface EastingNorthing {
  e: number;
  n: number;
}

export interface GridColRow {
  col: number;
  row: number;
}

/** SWEREF 99 TM (E, N) -> local scene (x, z). */
export function localFromEN(e: number, n: number, origin: Origin): LocalXZ {
  return { x: e - origin.e, z: -(n - origin.n) };
}

/** Local scene (x, z) -> SWEREF 99 TM (E, N). Exact inverse of `localFromEN`. */
export function enFromLocal(x: number, z: number, origin: Origin): EastingNorthing {
  return { e: x + origin.e, n: origin.n - z };
}

/**
 * Grid sample (col, row) -> local (x, z) at the **pixel center**
 * (docs/data-formats.md §1). Fractional col/row are allowed.
 */
export function localFromGrid(col: number, row: number, grid: GridSpec): LocalXZ {
  return {
    x: grid.boundsLocal.minX + (col + 0.5) * grid.resolution,
    z: grid.boundsLocal.minZ + (row + 0.5) * grid.resolution,
  };
}

/** Local (x, z) -> fractional grid (col, row). Exact inverse of `localFromGrid`. */
export function gridFromLocal(x: number, z: number, grid: GridSpec): GridColRow {
  return {
    col: (x - grid.boundsLocal.minX) / grid.resolution - 0.5,
    row: (z - grid.boundsLocal.minZ) / grid.resolution - 0.5,
  };
}

/** Row-major index of sample (col, row); row 0 = northernmost. No bounds check. */
export function sampleIndex(col: number, row: number, grid: GridSpec): number {
  return row * grid.width + col;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Height (m) at integer sample (col, row), clamped to the grid. */
export function heightAtGrid(heights: Float32Array, col: number, row: number, grid: GridSpec): number {
  const c = clampInt(Math.round(col), 0, grid.width - 1);
  const r = clampInt(Math.round(row), 0, grid.height - 1);
  return heights[r * grid.width + c];
}

/**
 * Bilinearly interpolated height (m) at local (x, z), clamped at the edges.
 * Unexaggerated — vertical exaggeration is render-only (contract §0).
 */
export function heightAtLocal(heights: Float32Array, x: number, z: number, grid: GridSpec): number {
  const { col, row } = gridFromLocal(x, z, grid);
  const c0 = clampInt(Math.floor(col), 0, grid.width - 1);
  const r0 = clampInt(Math.floor(row), 0, grid.height - 1);
  const c1 = clampInt(c0 + 1, 0, grid.width - 1);
  const r1 = clampInt(r0 + 1, 0, grid.height - 1);
  const fx = clampInt(col - c0, 0, 1);
  const fz = clampInt(row - r0, 0, 1);

  const w = grid.width;
  const h00 = heights[r0 * w + c0];
  const h10 = heights[r0 * w + c1];
  const h01 = heights[r1 * w + c0];
  const h11 = heights[r1 * w + c1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}

/**
 * Derive `boundsLocal` from `bounds3006` + origin, per contract §1. Used by tests
 * and by the manifest sanity check — note the north/south flip on Z.
 */
export function boundsLocalFrom3006(
  b: { minE: number; minN: number; maxE: number; maxN: number },
  origin: Origin,
): BoundsLocal {
  const nw = localFromEN(b.minE, b.maxN, origin); // north-west corner -> (minX, minZ)
  const se = localFromEN(b.maxE, b.minN, origin); // south-east corner -> (maxX, maxZ)
  return { minX: nw.x, minZ: nw.z, maxX: se.x, maxZ: se.z };
}
