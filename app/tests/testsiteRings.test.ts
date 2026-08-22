/**
 * End-to-end check of the committed ringed fixture (contract §11): the files on
 * disk satisfy the same contract a pipeline-generated ringed site must, the
 * ring DEMs decode to the generator's own surface at each ring's quantization,
 * and the methods panel discloses the horizon machinery.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';

import { validateManifest, type GridManifest } from '../src/state/manifest';
import { decodeHeights } from '../src/terrain/heightGrid';
import { buildMethodsModel } from '../src/ui/methodsModel';
// @ts-expect-error - plain .mjs generator, imported for its height function
import { heightAt } from '../scripts/make-test-dem.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'testsite-rings');

const manifest = validateManifest(JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8')));

async function decodeBand(path: string): Promise<ArrayLike<number>> {
  const buf = await readFile(join(DIR, path));
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const image = await tiff.getImage();
  const rasters = await image.readRasters({ interleave: false });
  return (rasters as unknown as ArrayLike<number>[])[0];
}

describe('ringed synthetic fixture (contract §11)', () => {
  it('declares two rings, inside-out, with far water on the outer one', () => {
    const rings = manifest.grids.rings;
    expect(rings).toHaveLength(2);
    expect(rings?.[0]).toMatchObject({ path: 'dem_ring3.tif', resolution: 4 });
    expect(rings?.[1]).toMatchObject({ path: 'dem_ring4.tif', resolution: 8 });
    expect(rings?.[0].encoding.scale).toBe(0.5);
    expect(rings?.[1].encoding.scale).toBe(1.0);
    expect(rings?.[0].waterConnect).toBeUndefined();
    expect(rings?.[0].waterConnectDelta).toBeUndefined();
    // v1.5 §12: this fixture ships the delta form (the plain `testsite` keeps
    // the absolute §7 grid, so both encodings stay covered by committed data).
    expect(rings?.[1].waterConnect).toBeUndefined();
    expect(rings?.[1].waterConnectDelta).toBe('water_connect_delta_ring4.tif');
    expect(manifest.assets?.['waterConnect']).toBeUndefined();
    expect(manifest.assets?.['waterConnectDelta']).toBe('water_connect_delta.tif');
  });

  it('carries a numeric horizon block', () => {
    expect(manifest.horizon).toBeTruthy();
    for (const key of ['crownM', 'floorM', 'eyeM', 'distanceKm'] as const) {
      expect(typeof manifest.horizon?.[key]).toBe('number');
    }
    expect(manifest.horizon?.eyeM).toBe(2);
  });

  it.each([0, 1])('ring %i decodes to the generator surface at its own scale', async (index) => {
    const ring = manifest.grids.rings?.[index] as GridManifest;
    const band = await decodeBand(ring.path);
    const heights = decodeHeights(band, ring.encoding.scale);
    // Spot-check pixel centers across the grid, including the far corners the
    // context never covered.
    for (const [col, row] of [
      [0, 0],
      [255, 255],
      [40, 200],
      [128, 128],
    ]) {
      const x = ring.boundsLocal.minX + (col + 0.5) * ring.resolution;
      const z = ring.boundsLocal.minZ + (row + 0.5) * ring.resolution;
      expect(Math.abs(heights[row * ring.width + col] - heightAt(x, z))).toBeLessThanOrEqual(
        ring.encoding.scale / 2 + 1e-6,
      );
    }
  });

  it('the far-water delta is non-negative and reconstructs connect >= dem', async () => {
    const ring = manifest.grids.rings?.[1] as GridManifest;
    const dem = await decodeBand(ring.path);
    const delta = await decodeBand(ring.waterConnectDelta!);
    expect(delta.length).toBe(dem.length);
    let lifted = 0;
    for (let i = 0; i < dem.length; i++) {
      const lift = delta[i] as number;
      if (lift < 0) throw new Error(`§12 delta is negative at ${i}: ${lift}`);
      if (lift > 0) lifted++;
    }
    // A delta that is zero everywhere would pass the check above while proving
    // nothing — this fixture's basins must actually raise some cells.
    expect(lifted).toBeGreaterThan(0);
  });

  it('the delta grids are much smaller than the absolute grids would be', async () => {
    // The §12 saving is the whole reason the encoding exists. The fixture's
    // TIFFs are uncompressed, so compare the *entropy* proxy the encoding
    // targets: how many samples are non-zero.
    const context = manifest.grids.context;
    const delta = await decodeBand(manifest.assets?.['waterConnectDelta'] as string);
    let nonZero = 0;
    for (let i = 0; i < delta.length; i++) if (delta[i] !== 0) nonZero++;
    expect(delta.length).toBe(context.width * context.height);
    expect(nonZero).toBeLessThan(delta.length / 2);
  });

  it('the plain testsite fixture stays ringless (rings are optional)', async () => {
    const plainDir = join(DIR, '..', 'testsite');
    const plain = validateManifest(JSON.parse(await readFile(join(plainDir, 'manifest.json'), 'utf8')));
    expect(plain.grids.rings).toBeUndefined();
    expect(plain.horizon).toBeUndefined();
  });

  it('the methods panel discloses the rings, the curvature and the water fade', () => {
    const model = buildMethodsModel(manifest, null, null, null, null);
    const terrain = model.sections.find((s) => s.id === 'terrain');
    const text = terrain?.paragraphs.join(' ') ?? '';
    expect(text).toContain('Far-field rings');
    expect(text).toContain('overview levels');
    expect(text).toContain('(1−k)·d²/2R');
    expect(text).toContain('k = 0.13');
    expect(text).toContain('faded');
    // Ringless sites say nothing about rings.
    const plainModel = buildMethodsModel({ ...manifest, grids: { core: manifest.grids.core, context: manifest.grids.context } }, null, null, null, null);
    expect(plainModel.sections.find((s) => s.id === 'terrain')?.paragraphs.join(' ')).not.toContain('Far-field rings');
  });
});
