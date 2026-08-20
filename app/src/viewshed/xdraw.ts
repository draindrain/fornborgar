/**
 * XDraw / reference-plane viewshed (PLAN §4.4, contract docs/data-formats.md §4).
 *
 * Wang, Robinson & White's XDraw: sweep the grid outward from the observer, ring by
 * ring, in eight octants. Every cell's line-of-sight angle is compared against a
 * *reference plane* linearly interpolated from the two cells of the previous ring
 * that straddle the line back to the observer. One pass, O(n) total, no per-cell
 * ray walk — the whole point, since the production grid is 2000x2000 = 4 M cells.
 *
 * Implementation shape: the eight octants are grouped into four half-plane sweeps
 * (east, west, north, south). The east/west sweeps march column by column, the
 * north/south sweeps row by row; in each the "previous ring" is simply the previous
 * column/row, and the straddling pair is found by scaling the observer-relative
 * offset by (d_prev / d). Fractional observer positions fall out of that for free.
 *
 * Contract points that are load-bearing and must not drift:
 *   - `heights` is row-major meters, row 0 = north (docs/data-formats.md §1).
 *   - Output is `Uint8Array`, **1 = visible, 0 = hidden**; the observer's own cell
 *     is visible; cells beyond `maxRadius` are 0.
 *   - Curvature + refraction drop is subtracted from the **terrain** height:
 *     `dh = (1 - k) * d^2 / (2R)`, `R = 6 371 000 m`, `k = 0.13` by default. The
 *     dropped terrain is used both as the blocking surface and as the base for the
 *     target test height (`ground + targetHeight - dh`).
 *
 * PURITY: no DOM, no worker, no three.js, no imports at all. This file must run
 * unchanged under `node --experimental-strip-types` (the pipeline acceptance test
 * imports it directly), so it also avoids every TS-only runtime construct — no
 * enums, no namespaces, no parameter properties, no decorators.
 */

/** Mean earth radius used by the curvature correction (contract §4). */
export const EARTH_RADIUS_M = 6371000;

/** Default atmospheric refraction coefficient (contract §4, PLAN §4.4). */
export const DEFAULT_REFRACTION_K = 0.13;

/** Default observer eye height above ground, in meters (contract §4). */
export const DEFAULT_OBSERVER_HEIGHT = 1.7;

/**
 * Finite stand-in for "nothing blocks yet". Must be finite: the reference plane is
 * a linear blend of two stored angles, and -Infinity * 0 would be NaN.
 */
const NO_BLOCK = -1e30;

export interface ViewshedParams {
  /** Heights in meters, row-major, length >= width*height, row 0 = north. */
  heights: Float32Array;
  width: number;
  height: number;
  /** Meters per cell (square cells). */
  resolution: number;
  /** Observer column, fractional allowed (pixel-center index space). */
  observerCol: number;
  /** Observer row, fractional allowed (pixel-center index space). */
  observerRow: number;
  /** Eye height above the ground at the observer, meters. Default 1.7. */
  observerHeight?: number;
  /** Height above ground a target must reach to count as seen, meters. Default 0. */
  targetHeight?: number;
  /** Analysis radius in meters; 0 (default) = unlimited. Cells beyond it are hidden. */
  maxRadius?: number;
  /** Apply earth curvature + refraction. Default true. */
  curvature?: boolean;
  /** Refraction coefficient k. Default 0.13. */
  refractionK?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Bilinear ground height at a fractional (col, row), clamped at the grid edges.
 * Local copy of the coords.ts convention so this module stays import-free.
 */
function bilinearHeight(
  heights: Float32Array,
  width: number,
  height: number,
  col: number,
  row: number,
): number {
  const c0 = clamp(Math.floor(col), 0, width - 1);
  const r0 = clamp(Math.floor(row), 0, height - 1);
  const c1 = clamp(c0 + 1, 0, width - 1);
  const r1 = clamp(r0 + 1, 0, height - 1);
  const fx = clamp(col - c0, 0, 1);
  const fy = clamp(row - r0, 0, 1);
  const h00 = heights[r0 * width + c0];
  const h10 = heights[r0 * width + c1];
  const h01 = heights[r1 * width + c0];
  const h11 = heights[r1 * width + c1];
  return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
}

/**
 * East/west half-plane sweep: octants where |dRow| <= |dCol|.
 * Marches one column at a time away from the observer; `dir` is +1 (east) or -1 (west).
 *
 * `prev`/`cur` are scratch rings of length >= height holding, per row, the largest
 * blocking LOS angle seen so far along the line from the observer through that cell.
 */
function sweepColumns(
  heights: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number,
  res: number,
  oCol: number,
  oRow: number,
  eyeZ: number,
  targetHeight: number,
  curv: number,
  maxRadius: number,
  dir: number,
  prevIn: Float64Array,
  curIn: Float64Array,
): void {
  let prev = prevIn;
  let cur = curIn;
  let havePrev = false;
  let prevLo = 0;
  let prevHi = -1;

  const first = dir > 0 ? Math.floor(oCol) + 1 : Math.ceil(oCol) - 1;
  for (let x = first; x >= 0 && x < width; x += dir) {
    const dCol = x - oCol;
    const aCol = dCol < 0 ? -dCol : dCol;
    const dxm = dCol * res;
    if (maxRadius > 0 && aCol * res > maxRadius) break;

    // Octant rows (|dRow| <= |dCol|) plus two rows of slack on each side, so the
    // next column always finds both interpolation neighbours already written.
    const yLo = Math.ceil(oRow - aCol);
    const yHi = Math.floor(oRow + aCol);
    const wLo = yLo - 2 < 0 ? 0 : yLo - 2;
    const wHi = yHi + 2 > height - 1 ? height - 1 : yHi + 2;

    const pCol = x - dir - oCol;
    const usePrev = havePrev && (dir > 0 ? pCol > 0 : pCol < 0);
    const t = usePrev ? pCol / dCol : 0;

    const rowStart = x;
    for (let y = wLo; y <= wHi; y++) {
      const dym = (y - oRow) * res;
      const d2 = dxm * dxm + dym * dym;
      const d = Math.sqrt(d2);
      const invD = 1 / d;
      // Terrain height with the curvature/refraction drop already applied.
      const hEff = heights[y * width + rowStart] - curv * d2;

      let ref = NO_BLOCK;
      if (usePrev) {
        const yp = oRow + (y - oRow) * t;
        const fy = Math.floor(yp);
        const f = yp - fy;
        let r0 = fy < prevLo ? prevLo : fy > prevHi ? prevHi : fy;
        let r1 = fy + 1;
        r1 = r1 < prevLo ? prevLo : r1 > prevHi ? prevHi : r1;
        const a0 = prev[r0];
        ref = a0 + (prev[r1] - a0) * f;
      }

      const angBlock = (hEff - eyeZ) * invD;
      cur[y] = angBlock > ref ? angBlock : ref;

      if (y >= yLo && y <= yHi && (maxRadius <= 0 || d <= maxRadius)) {
        const angTarget = (hEff + targetHeight - eyeZ) * invD;
        if (angTarget >= ref) mask[y * width + rowStart] = 1;
      }
    }

    const swap = prev;
    prev = cur;
    cur = swap;
    prevLo = wLo;
    prevHi = wHi;
    havePrev = true;
  }
}

/**
 * North/south half-plane sweep: octants where |dCol| < |dRow| (strict, so the two
 * sweep families partition the grid exactly). `dir` is +1 (south, rows increasing)
 * or -1 (north). Scratch rings are indexed by column and must be length >= width.
 */
function sweepRows(
  heights: Float32Array,
  mask: Uint8Array,
  width: number,
  height: number,
  res: number,
  oCol: number,
  oRow: number,
  eyeZ: number,
  targetHeight: number,
  curv: number,
  maxRadius: number,
  dir: number,
  prevIn: Float64Array,
  curIn: Float64Array,
): void {
  let prev = prevIn;
  let cur = curIn;
  let havePrev = false;
  let prevLo = 0;
  let prevHi = -1;

  const first = dir > 0 ? Math.floor(oRow) + 1 : Math.ceil(oRow) - 1;
  for (let y = first; y >= 0 && y < height; y += dir) {
    const dRow = y - oRow;
    const aRow = dRow < 0 ? -dRow : dRow;
    const dym = dRow * res;
    if (maxRadius > 0 && aRow * res > maxRadius) break;

    const xLo = Math.floor(oCol - aRow) + 1;
    const xHi = Math.ceil(oCol + aRow) - 1;
    const wLo = xLo - 2 < 0 ? 0 : xLo - 2;
    const wHi = xHi + 2 > width - 1 ? width - 1 : xHi + 2;

    const pRow = y - dir - oRow;
    const usePrev = havePrev && (dir > 0 ? pRow > 0 : pRow < 0);
    const t = usePrev ? pRow / dRow : 0;

    const base = y * width;
    for (let x = wLo; x <= wHi; x++) {
      const dxm = (x - oCol) * res;
      const d2 = dxm * dxm + dym * dym;
      const d = Math.sqrt(d2);
      const invD = 1 / d;
      const hEff = heights[base + x] - curv * d2;

      let ref = NO_BLOCK;
      if (usePrev) {
        const xp = oCol + (x - oCol) * t;
        const fx = Math.floor(xp);
        const f = xp - fx;
        let c0 = fx < prevLo ? prevLo : fx > prevHi ? prevHi : fx;
        let c1 = fx + 1;
        c1 = c1 < prevLo ? prevLo : c1 > prevHi ? prevHi : c1;
        const a0 = prev[c0];
        ref = a0 + (prev[c1] - a0) * f;
      }

      const angBlock = (hEff - eyeZ) * invD;
      cur[x] = angBlock > ref ? angBlock : ref;

      if (x >= xLo && x <= xHi && (maxRadius <= 0 || d <= maxRadius)) {
        const angTarget = (hEff + targetHeight - eyeZ) * invD;
        if (angTarget >= ref) mask[base + x] = 1;
      }
    }

    const swap = prev;
    prev = cur;
    cur = swap;
    prevLo = wLo;
    prevHi = wHi;
    havePrev = true;
  }
}

/**
 * Compute a visibility mask for `params`.
 *
 * Writes into `out` when it is supplied and large enough (it is cleared first), so
 * the worker can recycle one buffer across drags; otherwise a new `Uint8Array` of
 * length `width*height` is allocated. Returns the buffer that was written.
 */
export function computeViewshed(params: ViewshedParams, out?: Uint8Array): Uint8Array {
  const { heights, width, height, resolution } = params;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`computeViewshed: bad grid size ${width}x${height}`);
  }
  const n = width * height;
  if (heights.length < n) {
    throw new Error(`computeViewshed: heights has ${heights.length} cells, need ${n}`);
  }
  if (!(resolution > 0)) {
    throw new Error(`computeViewshed: resolution must be > 0, got ${resolution}`);
  }

  const mask = out && out.length >= n ? out : new Uint8Array(n);
  mask.fill(0, 0, n);

  const observerHeight = params.observerHeight ?? DEFAULT_OBSERVER_HEIGHT;
  const targetHeight = params.targetHeight ?? 0;
  const maxRadius = params.maxRadius ?? 0;
  const useCurvature = params.curvature ?? true;
  const k = params.refractionK ?? DEFAULT_REFRACTION_K;
  // dh = (1 - k) * d^2 / (2R)  =>  factor applied to d^2.
  const curv = useCurvature ? (1 - k) / (2 * EARTH_RADIUS_M) : 0;

  // An observer outside the grid has no defined ground height; clamp it in.
  const oCol = clamp(params.observerCol, 0, width - 1);
  const oRow = clamp(params.observerRow, 0, height - 1);
  const eyeZ = bilinearHeight(heights, width, height, oCol, oRow) + observerHeight;

  const scratch = width > height ? width : height;
  const bufA = new Float64Array(scratch);
  const bufB = new Float64Array(scratch);
  bufA.fill(NO_BLOCK);
  bufB.fill(NO_BLOCK);

  sweepColumns(heights, mask, width, height, resolution, oCol, oRow, eyeZ, targetHeight, curv, maxRadius, 1, bufA, bufB);
  bufA.fill(NO_BLOCK);
  bufB.fill(NO_BLOCK);
  sweepColumns(heights, mask, width, height, resolution, oCol, oRow, eyeZ, targetHeight, curv, maxRadius, -1, bufA, bufB);
  bufA.fill(NO_BLOCK);
  bufB.fill(NO_BLOCK);
  sweepRows(heights, mask, width, height, resolution, oCol, oRow, eyeZ, targetHeight, curv, maxRadius, 1, bufA, bufB);
  bufA.fill(NO_BLOCK);
  bufB.fill(NO_BLOCK);
  sweepRows(heights, mask, width, height, resolution, oCol, oRow, eyeZ, targetHeight, curv, maxRadius, -1, bufA, bufB);

  // The observer's own cell is visible by definition (contract §4).
  const cellCol = clamp(Math.round(oCol), 0, width - 1);
  const cellRow = clamp(Math.round(oRow), 0, height - 1);
  mask[cellRow * width + cellCol] = 1;

  return mask;
}
