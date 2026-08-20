/**
 * End-to-end check of the committed synthetic fixture (contract §5): the files on
 * disk really do satisfy the same contract a pipeline-generated site must, and
 * the decode path produces the heights the generator intended.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';

import { boundsLocalFrom3006, localFromGrid } from '../src/lib/coords';
import { validateManifest, type GridManifest } from '../src/state/manifest';
import { decodeHeights, elevationRange } from '../src/terrain/heightGrid';
// @ts-expect-error - plain .mjs generator, imported for its height function only
import { heightAt } from '../scripts/make-test-dem.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'testsite');

const manifest = validateManifest(JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8')));

async function decode(grid: GridManifest) {
  const buf = await readFile(join(DIR, grid.path));
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const image = await tiff.getImage();
  const rasters = await image.readRasters({ interleave: false });
  const band = (rasters as unknown as ArrayLike<number>[])[0];
  return { image, band, heights: decodeHeights(band, grid.encoding.scale) };
}

describe('synthetic test site fixture', () => {
  it('declares the geometry contract §5 asks for', () => {
    expect(manifest.site.id).toBe('testsite');
    expect(manifest.origin).toEqual({ e: 0, n: 0 });
    expect(manifest.grids.core).toMatchObject({ width: 256, height: 256, resolution: 1 });
    expect(manifest.grids.context).toMatchObject({ width: 256, height: 256, resolution: 2 });
    expect(manifest.attribution?.length).toBeGreaterThan(0);
  });

  it.each(['core', 'context'] as const)('%s satisfies the manifest invariants', (name) => {
    const g = manifest.grids[name];
    expect((g.bounds3006.maxE - g.bounds3006.minE) / g.resolution).toBe(g.width);
    expect((g.bounds3006.maxN - g.bounds3006.minN) / g.resolution).toBe(g.height);
    expect(boundsLocalFrom3006(g.bounds3006, manifest.origin)).toEqual(g.boundsLocal);
    expect(g.encoding).toEqual({ dtype: 'int16', scale: 0.1, unit: 'm' });
  });

  it('keeps the core extent strictly inside the context extent', () => {
    const c = manifest.grids.core.boundsLocal;
    const x = manifest.grids.context.boundsLocal;
    expect(c.minX).toBeGreaterThan(x.minX);
    expect(c.minZ).toBeGreaterThan(x.minZ);
    expect(c.maxX).toBeLessThan(x.maxX);
    expect(c.maxZ).toBeLessThan(x.maxZ);
  });

  it.each(['core', 'context'] as const)('%s TIFF decodes to int16 dm matching the manifest', async (name) => {
    const g = manifest.grids[name];
    const { image, band, heights } = await decode(g);
    expect(image.getWidth()).toBe(g.width);
    expect(image.getHeight()).toBe(g.height);
    expect(band.constructor.name).toBe('Int16Array');
    expect(heights.length).toBe(g.width * g.height);

    const [min, max] = elevationRange(heights);
    expect(min).toBeCloseTo(g.minElevation, 5);
    expect(max).toBeCloseTo(g.maxElevation, 5);
    expect(min).toBeGreaterThan(-10); // datum sanity, contract §2
    expect(max).toBeLessThan(200);
  });

  it('samples the generator height function at pixel centres, row 0 = north', async () => {
    const g = manifest.grids.core;
    const { heights } = await decode(g);
    for (const [col, row] of [
      [0, 0],
      [255, 0],
      [0, 255],
      [128, 128],
      [77, 190],
    ] as const) {
      const { x, z } = localFromGrid(col, row, g);
      const expected = heightAt(x, z) as number;
      expect(heights[row * g.width + col]).toBeCloseTo(expected, 1); // ±5 cm quantization
    }
  });

  it('carries a legible rampart ring: the crest stands ~1.5 m above its ditch line', async () => {
    const g = manifest.grids.core;
    const { heights } = await decode(g);
    const at = (x: number, z: number) => {
      const col = Math.round((x - g.boundsLocal.minX) / g.resolution - 0.5);
      const row = Math.round((z - g.boundsLocal.minZ) / g.resolution - 0.5);
      return heights[row * g.width + col];
    };
    // Due north of centre the ring crest sits at r = 45. Compare against the
    // hillside trend either side of it, so the hill's own slope is detrended out.
    const crest = at(0, -45);
    const inside = at(0, -36);
    const outside = at(0, -56);
    expect(crest - (inside + outside) / 2).toBeGreaterThan(1.0);
    // ...and it must genuinely be a local ridge, not just a slope break.
    expect(crest).toBeGreaterThan(inside);
    expect(crest).toBeGreaterThan(outside);

    // The WNW entrance gap (bearing 292 deg) must actually break the ring.
    const gapX = 45 * Math.sin((292 * Math.PI) / 180);
    const gapZ = -45 * Math.cos((292 * Math.PI) / 180);
    expect(at(gapX, gapZ)).toBeLessThan(crest - 1.0);
  });
});
