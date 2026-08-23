/**
 * The star catalogue, and the two forms the renderer needs it in.
 *
 * The data is 5 044 naked-eye stars to V = 6.0 — the limit of an unlit sky, and
 * therefore the right limit for this one — built by
 * `scripts/make-star-catalogue.mjs` into `public/data/sky/`. Provenance is in
 * `public/data/sky/DATA-LICENSES.md` and repeated in the methods panel: XHIP
 * (Anderson & Francis 2012, VizieR V/137D), reaching us through d3-celestial.
 *
 * Two representations, from one source of truth:
 *
 *  • **Directions** — one unit vector per star in the epoch's equatorial frame,
 *    for the `THREE.Points` field that is what you actually look at. Recomputed
 *    only when the *year* changes; the diurnal rotation is a matrix on the
 *    parent group (see `precession.ts`).
 *  • **A baked equirectangular map** — a small RGBA image of the same sky, so
 *    the water can reflect it. Reflections need a *function of direction*, and
 *    a point cloud is not one. It is deliberately small: a rippled surface
 *    smears the stars anyway, which is exactly what water does to them.
 *
 * The bake is pure CPU and allocates its own buffer, so it is testable under
 * the node-only vitest setup — no GL context anywhere in this file.
 */

import { directionFromEquatorial, precessionMatrix } from './precession';

export interface StarCatalogueSource {
  catalogue: string;
  vizier?: string;
  via?: string;
  properMotions: boolean;
  note?: string;
}

export interface StarCatalogueHeader {
  version: number;
  count: number;
  limitingMagnitude: number;
  epoch: string;
  frame: string;
  columns: { name: string; type: string; scale?: number }[];
  binary: string;
  source: StarCatalogueSource;
}

export interface StarCatalogue {
  count: number;
  /** J2000 right ascension, degrees. */
  ra: Float64Array;
  /** J2000 declination, degrees. */
  dec: Float64Array;
  /** Apparent visual magnitude. */
  mag: Float64Array;
  /** B−V colour index. */
  bv: Float64Array;
  hip: Int32Array;
  limitingMagnitude: number;
  source: StarCatalogueSource;
}

const TYPED: Record<string, { array: (b: ArrayBuffer, o: number, n: number) => ArrayLike<number>; bytes: number }> = {
  float32: { array: (b, o, n) => new Float32Array(b, o, n), bytes: 4 },
  float64: { array: (b, o, n) => new Float64Array(b, o, n), bytes: 8 },
  int32: { array: (b, o, n) => new Int32Array(b, o, n), bytes: 4 },
  int16: { array: (b, o, n) => new Int16Array(b, o, n), bytes: 2 },
  uint8: { array: (b, o, n) => new Uint8Array(b, o, n), bytes: 1 },
};

/**
 * Decode the column-major binary against its header.
 *
 * Columns are read **by name**, and unknown columns are skipped rather than
 * rejected. That is the whole upgrade path for proper motions: a catalogue that
 * adds `pmRa`/`pmDec` loads unchanged in an app that ignores them, and an app
 * that uses them loads a catalogue without them by falling back to zero.
 */
export function decodeStarCatalogue(header: StarCatalogueHeader, binary: ArrayBuffer): StarCatalogue {
  if (header.version !== 1) throw new Error(`star catalogue version ${header.version} not supported`);
  const n = header.count;

  const found = new Map<string, Float64Array>();
  const hip = new Int32Array(n);
  let offset = 0;
  for (const column of header.columns) {
    const spec = TYPED[column.type];
    if (!spec) throw new Error(`star catalogue column "${column.name}" has unknown type ${column.type}`);
    const width = spec.bytes * n;
    if (offset + width > binary.byteLength) {
      throw new Error(`star catalogue binary is short at column "${column.name}"`);
    }
    const raw = spec.array(binary, offset, n);
    if (column.name === 'hip') {
      for (let i = 0; i < n; i++) hip[i] = raw[i];
    } else {
      const scale = column.scale ?? 1;
      const decoded = new Float64Array(n);
      for (let i = 0; i < n; i++) decoded[i] = raw[i] * scale;
      found.set(column.name, decoded);
    }
    offset += width;
  }

  const need = (name: string): Float64Array => {
    const column = found.get(name);
    if (!column) throw new Error(`star catalogue is missing the "${name}" column`);
    return column;
  };

  return {
    count: n,
    ra: need('ra'),
    dec: need('dec'),
    mag: need('mag'),
    bv: found.get('bv') ?? new Float64Array(n),
    hip,
    limitingMagnitude: header.limitingMagnitude,
    source: header.source,
  };
}

/** Fetch and decode the catalogue from a base URL ending in "/". */
export async function loadStarCatalogue(baseUrl: string): Promise<StarCatalogue> {
  const headerResponse = await fetch(`${baseUrl}stars-v6.json`);
  if (!headerResponse.ok) throw new Error(`star catalogue header: HTTP ${headerResponse.status}`);
  const header = (await headerResponse.json()) as StarCatalogueHeader;

  const binaryResponse = await fetch(`${baseUrl}${header.binary}`);
  if (!binaryResponse.ok) throw new Error(`star catalogue binary: HTTP ${binaryResponse.status}`);
  return decodeStarCatalogue(header, await binaryResponse.arrayBuffer());
}

/**
 * Unit vectors in the equatorial frame of `jd`, three floats per star.
 *
 * Writes into `out` when given one, so the year slider does not allocate a
 * 60 kB array on every step.
 */
export function starDirectionsAtEpoch(
  catalogue: StarCatalogue,
  jd: number,
  out?: Float32Array,
): Float32Array {
  const n = catalogue.count;
  const result = out && out.length === n * 3 ? out : new Float32Array(n * 3);
  const m = precessionMatrix(jd).elements;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = directionFromEquatorial(catalogue.ra[i], catalogue.dec[i]);
    // Matrix3.elements is column-major.
    result[i * 3] = m[0] * x + m[3] * y + m[6] * z;
    result[i * 3 + 1] = m[1] * x + m[4] * y + m[7] * z;
    result[i * 3 + 2] = m[2] * x + m[5] * y + m[8] * z;
  }
  return result;
}

/**
 * A star's colour from its B−V index.
 *
 * An interpolated table of the conventional spectral-class colours rather than
 * a Planck curve: at the size a star is drawn, the hue is the only part of the
 * physics that survives, and a table is something a test can pin. Vega (B−V 0)
 * comes out white-blue, the sun (0.65) yellow-white, Betelgeuse (1.85) orange.
 */
export function starColor(bv: number): [number, number, number] {
  const table: [number, number, number, number][] = [
    [-0.4, 0.61, 0.7, 1.0],
    [-0.2, 0.67, 0.75, 1.0],
    [0.0, 0.79, 0.84, 1.0],
    [0.2, 0.92, 0.93, 1.0],
    [0.4, 1.0, 0.97, 0.92],
    [0.6, 1.0, 0.94, 0.84],
    [0.8, 1.0, 0.9, 0.75],
    [1.0, 1.0, 0.86, 0.66],
    [1.4, 1.0, 0.78, 0.55],
    [1.8, 1.0, 0.72, 0.47],
    [2.2, 1.0, 0.68, 0.42],
  ];
  if (bv <= table[0][0]) return [table[0][1], table[0][2], table[0][3]];
  const last = table[table.length - 1];
  if (bv >= last[0]) return [last[1], last[2], last[3]];
  let i = 1;
  while (table[i][0] < bv) i += 1;
  const a = table[i - 1];
  const b = table[i];
  const t = (bv - a[0]) / (b[0] - a[0]);
  return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

export interface StarMap {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Relative flux, normalised so the brightest star in the catalogue is 1.
 * Sirius at V = −1.44 is about 950 times the flux of a magnitude-6 star, which
 * is the dynamic range the encoding below has to survive.
 */
export function relativeFlux(mag: number, brightestMag: number): number {
  return Math.pow(10, -0.4 * (mag - brightestMag));
}

/** How the flux is squeezed into 8 bits. The shader undoes it with the inverse. */
export const STAR_MAP_GAMMA = 2.2;

/**
 * Splat the catalogue into an equirectangular RGBA map in the epoch's
 * equatorial frame: `u = ra / 360`, `v = (dec + 90) / 180`.
 *
 * This exists **only** so the water has a function of direction to reflect. It
 * is small on purpose. Each star is a small gaussian rather than a single
 * texel, both so that bilinear sampling has something to work with and because
 * a point spread is what the atmosphere does to a star anyway; the splat is
 * widened in longitude by 1/cos(dec) so the converging meridians near the poles
 * do not stretch it into a streak.
 */
export function bakeStarMap(
  catalogue: StarCatalogue,
  directions: Float32Array,
  options: { width?: number; height?: number; sigmaTexels?: number } = {},
): StarMap {
  const width = options.width ?? 512;
  const height = options.height ?? 256;
  const sigma = options.sigmaTexels ?? 0.65;
  const radius = Math.max(1, Math.ceil(sigma * 2.5));

  const accumulator = new Float32Array(width * height * 3);
  let brightest = Infinity;
  for (let i = 0; i < catalogue.count; i++) brightest = Math.min(brightest, catalogue.mag[i]);

  for (let i = 0; i < catalogue.count; i++) {
    const x = directions[i * 3];
    const y = directions[i * 3 + 1];
    const z = directions[i * 3 + 2];
    const decRad = Math.asin(Math.max(-1, Math.min(1, z)));
    const raRad = Math.atan2(y, x);

    const u = (((raRad / (2 * Math.PI)) % 1) + 1) % 1;
    const v = (decRad / Math.PI + 0.5);
    const px = u * width;
    const py = v * height;

    const flux = relativeFlux(catalogue.mag[i], brightest);
    const [cr, cg, cb] = starColor(catalogue.bv[i]);
    // Near the poles a texel spans far less sky in longitude, so the splat has
    // to spread over more of them to stay round.
    const uStretch = Math.min(8, 1 / Math.max(0.12, Math.cos(decRad)));
    const sigmaU = sigma * uStretch;
    const radiusU = Math.max(1, Math.ceil(sigmaU * 2.5));

    for (let dy = -radius; dy <= radius; dy++) {
      const iy = Math.floor(py) + dy;
      if (iy < 0 || iy >= height) continue;
      const fy = (iy + 0.5 - py) / sigma;
      for (let dx = -radiusU; dx <= radiusU; dx++) {
        const fx = (Math.floor(px) + dx + 0.5 - px) / sigmaU;
        const weight = Math.exp(-0.5 * (fx * fx + fy * fy));
        if (weight < 1e-3) continue;
        const ix = ((Math.floor(px) + dx) % width + width) % width;
        const o = (iy * width + ix) * 3;
        accumulator[o] += flux * weight * cr;
        accumulator[o + 1] += flux * weight * cg;
        accumulator[o + 2] += flux * weight * cb;
      }
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      const value = Math.min(1, accumulator[i * 3 + c]);
      data[i * 4 + c] = Math.round(255 * Math.pow(value, 1 / STAR_MAP_GAMMA));
    }
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}
