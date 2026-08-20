#!/usr/bin/env node
/**
 * Thin CLI shim so pytest can drive the *real* app viewshed under Node.
 *
 *   node --experimental-strip-types xdraw_runner.mjs <params.json> <heights.f32> <mask.u8>
 *
 * It imports `app/src/viewshed/xdraw.ts` directly — no copy of the algorithm lives
 * on the Python side, so the acceptance test can never drift from what ships.
 *
 * `params.json` is a `ViewshedParams` object minus `heights` (width, height,
 * resolution, observerCol, observerRow, observerHeight, targetHeight, maxRadius,
 * curvature, refractionK), optionally plus `"repeat": n` to time n runs.
 * `heights.f32` is raw little-endian float32, row-major, length width*height.
 * `mask.u8` receives width*height bytes, 1 = visible, 0 = hidden.
 * A one-line JSON summary `{"elapsedMs": ..., "visible": ...}` is printed on stdout.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { endianness } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { computeViewshed } from '../../app/src/viewshed/xdraw.ts';

if (endianness() !== 'LE') {
  throw new Error('xdraw_runner: the .f32 interchange files assume a little-endian host');
}

const [paramsPath, heightsPath, maskPath] = process.argv.slice(2);
if (!paramsPath || !heightsPath || !maskPath) {
  const self = path.basename(fileURLToPath(import.meta.url));
  throw new Error(`usage: node --experimental-strip-types ${self} <params.json> <heights.f32> <mask.u8>`);
}

const params = JSON.parse(readFileSync(paramsPath, 'utf8'));
const raw = readFileSync(heightsPath);
const n = params.width * params.height;
if (raw.byteLength !== n * 4) {
  throw new Error(`xdraw_runner: ${heightsPath} has ${raw.byteLength} bytes, expected ${n * 4}`);
}
// Copy out of the Buffer pool so the Float32Array is 4-byte aligned.
const heights = new Float32Array(n);
for (let i = 0; i < n; i++) heights[i] = raw.readFloatLE(i * 4);

const call = {
  heights,
  width: params.width,
  height: params.height,
  resolution: params.resolution,
  observerCol: params.observerCol,
  observerRow: params.observerRow,
  observerHeight: params.observerHeight,
  targetHeight: params.targetHeight,
  maxRadius: params.maxRadius,
  curvature: params.curvature,
  refractionK: params.refractionK,
};

const repeat = Math.max(1, params.repeat ?? 1);
const mask = new Uint8Array(n);
let best = Infinity;
for (let i = 0; i < repeat; i++) {
  const t0 = performance.now();
  computeViewshed(call, mask);
  const dt = performance.now() - t0;
  if (dt < best) best = dt;
}

writeFileSync(maskPath, mask);

let visible = 0;
for (let i = 0; i < n; i++) visible += mask[i];
process.stdout.write(`${JSON.stringify({ elapsedMs: best, visible, cells: n })}\n`);
