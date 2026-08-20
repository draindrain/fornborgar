#!/usr/bin/env node
/**
 * Generates the committed synthetic test site (docs/data-formats.md §5).
 *
 *   app/public/data/testsite/dem_core.tif      256 x 256 @ 1 m, int16 decimeters
 *   app/public/data/testsite/dem_context.tif   256 x 256 @ 2 m, int16 decimeters
 *   app/public/data/testsite/manifest.json     schemaVersion 1, fully conformant
 *
 * The point of this fixture is that the app never blocks on the Python pipeline:
 * `?site=testsite` exercises exactly the same code path as a real site, with no
 * branch on site id anywhere. The terrain is procedural — a hill carrying a
 * ~1.5 m rampart-like ring with two entrance gaps, a shorter outer arc, and a
 * diagonal valley — so low-angle shading is judgeable by eye.
 *
 * Both grids sample the *same* continuous height function at their own pixel
 * centres, which is also what makes the core/context seam a meaningful test.
 *
 * Run: npm run make-test-dem
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'data', 'testsite');

const ORIGIN = { e: 0, n: 0 };
const SCALE = 0.1; // int16 decimeters -> meters

const GRIDS = {
  core: { path: 'dem_core.tif', size: 256, resolution: 1 },
  context: { path: 'dem_context.tif', size: 256, resolution: 2 },
};

// ---------------------------------------------------------------- terrain ---

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const gauss = (d, sigma) => Math.exp(-(d * d) / (2 * sigma * sigma));

/** Smallest signed difference between two bearings, in degrees. */
function bearingDelta(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  return d;
}

/**
 * A rampart-like ring: a gaussian ridge at `radius` with entrance gaps.
 * `gaps` are [bearingDegrees, halfWidthDegrees] pairs.
 */
function ring(r, bearing, { radius, sigma, amplitude, gaps = [], arc = null }) {
  let f = gauss(r - radius, sigma);
  if (f < 1e-4) return 0;
  for (const [centre, halfWidth] of gaps) {
    const d = Math.abs(bearingDelta(bearing, centre));
    f *= smoothstep(halfWidth * 0.55, halfWidth, d);
  }
  if (arc) {
    const [centre, halfWidth] = arc;
    const d = Math.abs(bearingDelta(bearing, centre));
    f *= 1 - smoothstep(halfWidth * 0.8, halfWidth, d);
  }
  return amplitude * f;
}

/** Height in meters at local scene coordinates (x = east, z = south). */
export function heightAt(x, z) {
  const r = Math.hypot(x, z);
  // Compass bearing: 0 = north (-z), 90 = east (+x), clockwise.
  const bearing = (Math.atan2(x, -z) * 360) / TAU;

  let h = 13.0;

  // Regional tilt: ground rises gently toward the north.
  h += -z * 0.012;

  // The hill the fort sits on.
  h += 22 * gauss(r, 95);

  // A diagonal valley (running NE–SW), cut across the SW half of the extent.
  const perpendicular = (x - z) / Math.SQRT2;
  h -= 9.5 * gauss(perpendicular + 118, 48);

  // Inner rampart: ~1.5 m high, two entrances (WNW and ESE), like Broborg's.
  h += ring(r, bearing, {
    radius: 45,
    sigma: 3.4,
    amplitude: 1.5,
    gaps: [
      [292, 15],
      [112, 13],
    ],
  });

  // Outer rampart: shorter, lower, only an arc.
  h += ring(r, bearing, {
    radius: 67,
    sigma: 3.8,
    amplitude: 0.85,
    arc: [235, 105],
  });

  // A shallow interior hollow so the ring reads as an enclosure, not a bump.
  h -= 0.55 * gauss(r, 26);

  // Micro-relief so the shading has texture at 1 m (deterministic, no RNG).
  h += 0.22 * Math.sin(x * 0.087) * Math.cos(z * 0.071);
  h += 0.13 * Math.sin((x + z) * 0.19 + 1.3);
  h += 0.07 * Math.sin(x * 0.41 - 0.7) * Math.sin(z * 0.37 + 2.1);

  return h;
}

// ------------------------------------------------------------------ output --

function buildGrid({ size, resolution }) {
  // boundsLocal, concentric on the origin (contract §1: minZ is the NORTH edge).
  const halfExtent = (size * resolution) / 2;
  const boundsLocal = { minX: -halfExtent, minZ: -halfExtent, maxX: halfExtent, maxZ: halfExtent };
  const bounds3006 = {
    minE: ORIGIN.e + boundsLocal.minX,
    maxE: ORIGIN.e + boundsLocal.maxX,
    // northing = origin.n − z, so maxZ (south edge) gives minN.
    minN: ORIGIN.n - boundsLocal.maxZ,
    maxN: ORIGIN.n - boundsLocal.minZ,
  };

  const raw = new Int16Array(size * size);
  let minRaw = Infinity;
  let maxRaw = -Infinity;
  for (let row = 0; row < size; row++) {
    // Row 0 = northernmost row; rows grow southward = +z.
    const z = boundsLocal.minZ + (row + 0.5) * resolution;
    for (let col = 0; col < size; col++) {
      const x = boundsLocal.minX + (col + 0.5) * resolution;
      const dm = Math.round(heightAt(x, z) / SCALE);
      raw[row * size + col] = dm;
      if (dm < minRaw) minRaw = dm;
      if (dm > maxRaw) maxRaw = dm;
    }
  }

  return {
    raw,
    boundsLocal,
    bounds3006,
    minElevation: Number((minRaw * SCALE).toFixed(1)),
    maxElevation: Number((maxRaw * SCALE).toFixed(1)),
  };
}

function writeTiff(file, raw, size, resolution, bounds3006) {
  // NOTE (geotiff 3.0.5): the writer's `encodeImage` only knows how to serialise
  // Float64/Float32/Uint32/Uint16/Uint8 arrays — an Int16Array silently writes a
  // strip of zero bytes. Two's-complement means the *bytes* are identical, so we
  // hand it a Uint16 view of the same buffer and declare `SampleFormat: [2]`
  // (signed int) explicitly; readers then decode band 1 straight back to Int16.
  const asUint16 = new Uint16Array(raw.buffer, raw.byteOffset, raw.length);

  const arrayBuffer = writeArrayBuffer(asUint16, {
    width: size,
    height: size,
    BitsPerSample: [16],
    SampleFormat: [2], // 2 = two's-complement signed integer
    PhotometricInterpretation: 1,
    SamplesPerPixel: [1],
    // EPSG:3006 horizontal only — the vertical CRS is deliberately absent
    // (docs/data-formats.md §1). The app ignores this anyway; it is here so the
    // fixture opens sensibly in GDAL/QGIS.
    GTModelTypeGeoKey: 1, // projected
    GTRasterTypeGeoKey: 1, // RasterPixelIsArea
    ProjectedCSTypeGeoKey: 3006,
    PCSCitationGeoKey: 'SWEREF99 TM',
    ModelPixelScale: [resolution, resolution, 0],
    // Tiepoint ties raster (0,0) — the NW corner of the NW pixel — to (minE, maxN).
    ModelTiepoint: [0, 0, 0, bounds3006.minE, bounds3006.maxN, 0],
  });
  writeFileSync(file, Buffer.from(arrayBuffer));
  return arrayBuffer.byteLength;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const built = {};
  for (const [name, spec] of Object.entries(GRIDS)) {
    const grid = buildGrid(spec);
    const bytes = writeTiff(join(OUT_DIR, spec.path), grid.raw, spec.size, spec.resolution, grid.bounds3006);
    built[name] = { spec, grid };
    console.log(
      `${spec.path}: ${spec.size}x${spec.size} @ ${spec.resolution} m, ` +
        `z ${grid.minElevation}–${grid.maxElevation} m, ${(bytes / 1024).toFixed(0)} KiB`,
    );
  }

  const gridManifest = (name) => {
    const { spec, grid } = built[name];
    return {
      path: spec.path,
      resolution: spec.resolution,
      width: spec.size,
      height: spec.size,
      bounds3006: grid.bounds3006,
      boundsLocal: grid.boundsLocal,
      encoding: { dtype: 'int16', scale: SCALE, unit: 'm' },
      minElevation: grid.minElevation,
      maxElevation: grid.maxElevation,
    };
  };

  const manifest = {
    schemaVersion: 1,
    site: {
      id: 'testsite',
      name: 'Synthetic test site',
    },
    crs: {
      horizontal: 'EPSG:3006',
      verticalDatum: 'RH2000',
    },
    origin: { e: ORIGIN.e, n: ORIGIN.n },
    grids: {
      core: gridManifest('core'),
      context: gridManifest('context'),
    },
    layers: [{ id: 'terrain', name: 'Terrain (synthetic)', provenance: 'model' }],
    attribution: [
      {
        text: 'Synthetic fixture — procedurally generated by app/scripts/make-test-dem.mjs. Not real elevation data.',
        license: 'MIT',
      },
    ],
    provenance: {
      generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      pipeline: 'app/scripts/make-test-dem.mjs',
      sources: [],
      processing: [
        'procedural height function (hill + rampart ring with two entrance gaps + outer arc + diagonal valley)',
        'sampled at pixel centres',
        'int16 dm quantization',
        'uncompressed single-strip GeoTIFF',
      ],
    },
  };

  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest.json written to ${OUT_DIR}`);
}

// Only run when invoked directly, so tests can import `heightAt`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
