/**
 * Build the committed star catalogue the night sky is drawn from.
 *
 *   node scripts/make-star-catalogue.mjs [--source <stars.6.json>] [--limit 6.0]
 *
 * Writes `public/data/sky/stars-v6.json` (a header describing the columns) and
 * `public/data/sky/stars-v6.bin` (the columns themselves, column-major). Both
 * are committed: the catalogue is the same sky at every site, so unlike the DEM
 * bundles it does not belong in a per-site R2 bundle.
 *
 * ## Where the data comes from
 *
 * The positions are the **XHIP** compilation — *XHIP: An Extended Hipparcos
 * Compilation*, Anderson E. & Francis C. (2012), VizieR V/137D — reaching this
 * build through the `stars.6.json` data file of **d3-celestial** (Olaf Frohn,
 * BSD-3-Clause), which is the form of it obtainable without a VizieR query.
 * `public/data/sky/DATA-LICENSES.md` records this; the methods panel repeats it.
 *
 * ## What it does *not* contain
 *
 * Proper motions. The d3-celestial derivation drops them, and this app scrubs
 * 3 050 years. Precession — which moves the whole sky and is by far the larger
 * effect — is applied at runtime from these J2000 positions; proper motion is
 * not, and `docs/night-sky.md` states what that costs star by star.
 *
 * The column list in the header is read generically by `src/sky/stars.ts`, so
 * adding `pmRa`/`pmDec` columns later is a data change with no app change.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'public', 'data', 'sky');
const PACKAGE = 'd3-celestial@0.7.35';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const limitingMagnitude = Number(opt('limit', '6.0'));

/** The d3-celestial GeoJSON, either handed to us or fetched from npm. */
function readSource() {
  const given = opt('source');
  if (given) return JSON.parse(readFileSync(given, 'utf8'));

  const work = mkdtempSync(join(tmpdir(), 'stars-'));
  console.log(`npm pack ${PACKAGE} -> ${work}`);
  const tarball = execFileSync('npm', ['pack', PACKAGE, '--silent'], { cwd: work })
    .toString()
    .trim()
    .split('\n')
    .pop();
  execFileSync('tar', ['xzf', tarball, 'package/data/stars.6.json'], { cwd: work });
  return JSON.parse(readFileSync(join(work, 'package', 'data', 'stars.6.json'), 'utf8'));
}

const source = readSource();
if (source.type !== 'FeatureCollection') throw new Error('expected a GeoJSON FeatureCollection');

// Brightest first. Nothing depends on the order, but it makes the file
// inspectable and lets a future reader truncate it by taking a prefix.
const stars = source.features
  .map((f) => ({
    hip: Number(f.id),
    ra: Number(f.geometry.coordinates[0]),
    dec: Number(f.geometry.coordinates[1]),
    mag: Number(f.properties.mag),
    bv: f.properties.bv === '' || f.properties.bv == null ? 0 : Number(f.properties.bv),
  }))
  .filter((s) => Number.isFinite(s.ra) && Number.isFinite(s.dec) && s.mag <= limitingMagnitude)
  .sort((a, b) => a.mag - b.mag);

if (stars.length === 0) throw new Error('no stars survived the filter');

// GeoJSON longitude is -180..180; right ascension is 0..360.
for (const s of stars) s.ra = ((s.ra % 360) + 360) % 360;

const count = stars.length;
const ra = new Float32Array(count);
const dec = new Float32Array(count);
const mag = new Int16Array(count);
const bv = new Int16Array(count);
const hip = new Int32Array(count);
stars.forEach((s, i) => {
  ra[i] = s.ra;
  dec[i] = s.dec;
  mag[i] = Math.round(s.mag * 100);
  bv[i] = Math.round(Math.max(-3, Math.min(5, s.bv)) * 1000);
  hip[i] = Number.isFinite(s.hip) ? s.hip : 0;
});

const columns = [
  { name: 'ra', type: 'float32', unit: 'deg', scale: 1 },
  { name: 'dec', type: 'float32', unit: 'deg', scale: 1 },
  { name: 'hip', type: 'int32', unit: 'id', scale: 1 },
  { name: 'mag', type: 'int16', unit: 'mag', scale: 0.01 },
  { name: 'bv', type: 'int16', unit: 'mag', scale: 0.001 },
];

const buffers = [
  Buffer.from(ra.buffer),
  Buffer.from(dec.buffer),
  Buffer.from(hip.buffer),
  Buffer.from(mag.buffer),
  Buffer.from(bv.buffer),
];
const bin = Buffer.concat(buffers);

const header = {
  version: 1,
  count,
  limitingMagnitude,
  epoch: 'J2000',
  frame: 'equatorial',
  // Column-major: each column is contiguous, in this order, little-endian.
  columns,
  binary: 'stars-v6.bin',
  source: {
    catalogue: 'XHIP: An Extended Hipparcos Compilation (Anderson E., Francis C. 2012)',
    vizier: 'V/137D',
    via: `d3-celestial data/stars.6.json (Olaf Frohn, BSD-3-Clause), ${PACKAGE}`,
    properMotions: false,
    note:
      'Positions are J2000 and carry no proper motion; the app precesses them to ' +
      'the epoch the year slider selects.',
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'stars-v6.json'), `${JSON.stringify(header, null, 2)}\n`);
writeFileSync(join(OUT_DIR, 'stars-v6.bin'), bin);

const brightest = stars[0];
console.log(`${count} stars to V=${limitingMagnitude}, ${bin.length} bytes`);
console.log(
  `brightest: HIP ${brightest.hip} V=${brightest.mag} at ${brightest.ra.toFixed(4)}, ${brightest.dec.toFixed(4)}`,
);
if (!existsSync(join(OUT_DIR, 'DATA-LICENSES.md'))) {
  console.log('note: public/data/sky/DATA-LICENSES.md does not exist yet');
}
