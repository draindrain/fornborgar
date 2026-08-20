/**
 * The committed testsite water assets (contract §5 fixture, §6/§7 formats).
 *
 * The connectivity grid is verified the hard way: for a spread of water levels,
 * `connect ≤ h` must equal an independent 4-connected flood fill of `dem ≤ h`
 * started from every grid-edge cell. That is the definition in §7, computed by a
 * different algorithm (BFS per level) than the generator's priority flood, so
 * the two agreeing means the file really does encode every century's wet mask.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';

import { validateManifest } from '../src/state/manifest';
import { validateShoreline, levelAt } from '../src/water/shoreline';
import { isWetAt, type ConnectGrid } from '../src/water/connectGrid';
import { decodeHeights } from '../src/terrain/heightGrid';
// @ts-expect-error - plain .mjs generator, imported for its shared constants
import { FALSE_BASIN } from '../scripts/make-test-dem.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'testsite');

const manifest = validateManifest(JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8')));
const shoreline = validateShoreline(JSON.parse(await readFile(join(DIR, 'shoreline.json'), 'utf8')), 'shoreline.json');

/** Raw int16 decimeters of a single-band fixture TIFF. */
async function readRaw(path: string): Promise<Int16Array> {
  const buf = await readFile(join(DIR, path));
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const image = await tiff.getImage();
  const rasters = await image.readRasters({ interleave: false });
  return (rasters as unknown as Int16Array[])[0];
}

const ctx = manifest.grids.context;
const W = ctx.width;
const H = ctx.height;
const dem = await readRaw(ctx.path);
const connect = await readRaw(manifest.assets!['waterConnect']);

/**
 * Reference implementation of §7's wet set: cells with `dem ≤ h` reachable by
 * 4-connected steps from any grid-edge cell (every edge cell is a sea entry).
 */
function floodFill(h: number): Uint8Array {
  const wet = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (i: number): void => {
    if (wet[i] || dem[i] > h) return;
    wet[i] = 1;
    stack.push(i);
  };
  for (let col = 0; col < W; col++) {
    push(col);
    push((H - 1) * W + col);
  }
  for (let row = 0; row < H; row++) {
    push(row * W);
    push(row * W + W - 1);
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const row = (i / W) | 0;
    const col = i - row * W;
    if (col > 0) push(i - 1);
    if (col < W - 1) push(i + 1);
    if (row > 0) push(i - W);
    if (row < H - 1) push(i + W);
  }
  return wet;
}

describe('testsite water_connect.tif (contract §7)', () => {
  it('has exactly the geometry of grids.context, no manifest entry of its own', async () => {
    const buf = await readFile(join(DIR, 'water_connect.tif'));
    const tiff = await fromArrayBuffer(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const image = await tiff.getImage();
    expect(image.getWidth()).toBe(W);
    expect(image.getHeight()).toBe(H);
    expect(connect.constructor.name).toBe('Int16Array');
    expect(connect.length).toBe(W * H);
    expect((manifest.grids as Record<string, unknown>)['waterConnect']).toBeUndefined();
  });

  it('satisfies connect >= dem everywhere', () => {
    let worst = Infinity;
    for (let i = 0; i < connect.length; i++) worst = Math.min(worst, connect[i] - dem[i]);
    expect(worst).toBeGreaterThanOrEqual(0);
  });

  it('leaves every grid-edge cell at its own elevation (edge = sea entry)', () => {
    for (let col = 0; col < W; col++) {
      expect(connect[col]).toBe(dem[col]);
      expect(connect[(H - 1) * W + col]).toBe(dem[(H - 1) * W + col]);
    }
    for (let row = 0; row < H; row++) {
      expect(connect[row * W]).toBe(dem[row * W]);
      expect(connect[row * W + W - 1]).toBe(dem[row * W + W - 1]);
    }
  });

  // Decimeter levels spanning dry (below the valley mouth) to almost everything.
  it.each([10, 30, 42, 55, 70, 85, 99, 110, 130, 150, 200])(
    'connect <= %i dm equals the 4-connected edge flood fill of dem <= %i dm',
    (h) => {
      const wet = floodFill(h);
      let mismatches = 0;
      let wetCount = 0;
      for (let i = 0; i < connect.length; i++) {
        if (wet[i]) wetCount++;
        if ((connect[i] <= h ? 1 : 0) !== wet[i]) mismatches++;
      }
      expect(mismatches).toBe(0);
      // Guard against a vacuous pass at either end of the range.
      expect(wetCount).toBeGreaterThan(0);
      expect(wetCount).toBeLessThan(W * H);
    },
  );

  it('is monotone: the wet set only grows as the level rises', () => {
    let previous = 0;
    for (let h = 0; h <= 200; h += 10) {
      let count = 0;
      for (let i = 0; i < connect.length; i++) if (connect[i] <= h) count++;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });
});

describe('the deliberate false basin (contract §5)', () => {
  const toCol = (x: number): number => Math.round((x - ctx.boundsLocal.minX) / ctx.resolution - 0.5);
  const toRow = (z: number): number => Math.round((z - ctx.boundsLocal.minZ) / ctx.resolution - 0.5);
  const centre = toRow(FALSE_BASIN.centreZ) * W + toCol(FALSE_BASIN.centreX);

  it('carries its spill level, not its own elevation', () => {
    const floorM = dem[centre] * 0.1;
    const sillM = connect[centre] * 0.1;
    expect(sillM - floorM).toBeGreaterThan(3); // a real basin, not a dimple
    expect(floorM).toBeLessThan(6);
    expect(sillM).toBeGreaterThan(9);
  });

  it('stays dry at levels above its floor but below its sill, where a naive elevation test floods it', () => {
    const floor = dem[centre];
    const sill = connect[centre];
    const h = Math.floor((floor + sill) / 2);
    expect(dem[centre]).toBeLessThanOrEqual(h); // naive `dem <= h` says wet…
    expect(connect[centre]).toBeGreaterThan(h); // …§7 says dry, and wins.

    // The exclusion is a whole component, not one cell: the flood fill at that
    // level must leave the basin's floor entirely dry.
    const wet = floodFill(h);
    let dryFloorCells = 0;
    const r = Math.floor(FALSE_BASIN.floorRadius / ctx.resolution);
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        const i = centre + dr * W + dc;
        if (dem[i] <= h && !wet[i]) dryFloorCells++;
      }
    }
    expect(dryFloorCells).toBeGreaterThan(50);
  });

  it('is submerged for real once the table level clears the sill', () => {
    const sill = connect[centre];
    const oldest = shoreline.steps[0];
    expect(oldest.levelM * 10).toBeGreaterThan(sill);
    expect(connect[centre]).toBeLessThanOrEqual(oldest.levelM * 10);
  });

  it('sits outside the core grid, so the 1 m core DEM is untouched by it', () => {
    const core = manifest.grids.core.boundsLocal;
    expect(FALSE_BASIN.centreX - FALSE_BASIN.rimRadius).toBeGreaterThan(core.maxX);
    expect(FALSE_BASIN.centreZ - FALSE_BASIN.rimRadius).toBeGreaterThan(core.maxZ);
  });
});

describe('testsite shoreline.json (contract §6)', () => {
  it('spans ~1000 BCE to ~1200 CE in century steps (PLAN §3 Phase 4)', () => {
    expect(shoreline.steps[0].yearCE).toBeLessThanOrEqual(-1000);
    expect(shoreline.steps[shoreline.steps.length - 1].yearCE).toBeGreaterThanOrEqual(1100);
    for (const step of shoreline.steps) {
      expect(step.bp).toBe(1950 - step.yearCE); // §6: yearCE = 1950 − bp
      expect(step.yearCE % 100).not.toBe(0); // SGU-shaped centuries never hit year 0
    }
  });

  it('sweeps a range that floods the valley and drains it again', () => {
    const first = shoreline.steps[0].levelM;
    const last = shoreline.steps[shoreline.steps.length - 1].levelM;
    expect(first).toBeGreaterThan(ctx.minElevation + 8); // the valley mouth drowns
    expect(last).toBeLessThan(first - 8); // and comes back out
    expect(first).toBeLessThan(ctx.maxElevation); // the hill never drowns
  });

  it('is marked as synthetic wherever a real site would name SGU', () => {
    expect(shoreline.method).toMatch(/SYNTHETIC/i);
    expect(shoreline.uncertainty).toMatch(/[Ss]ynthetic/);
  });

  it('interpolated levels stay inside the fixture terrain, all the way along', () => {
    for (let year = -1100; year <= 1200; year += 25) {
      const level = levelAt(shoreline, year);
      expect(level).toBeGreaterThan(ctx.minElevation);
      expect(level).toBeLessThan(ctx.maxElevation);
    }
  });
});

describe('testsite manifest declares the v1.1 water layer', () => {
  it('pairs both assets and labels the layer as a model', () => {
    expect(manifest.assets?.['shoreline']).toBe('shoreline.json');
    expect(manifest.assets?.['waterConnect']).toBe('water_connect.tif');
    const layer = manifest.layers?.find((l) => l.id === 'water');
    expect(layer).toBeDefined();
    expect(layer!.provenance).toBe('model');
    expect(manifest.attribution?.some((a) => /[Ss]trandförskjutning/.test(a.text))).toBe(true);
  });
});

describe('connectGrid helpers', () => {
  const grid: ConnectGrid = {
    width: W,
    height: H,
    resolution: ctx.resolution,
    boundsLocal: ctx.boundsLocal,
    values: decodeHeights(connect, ctx.encoding.scale),
  };

  it('agrees with the raw grid on local-coordinate wetness lookups', () => {
    const { minX, minZ } = ctx.boundsLocal;
    for (const [col, row] of [
      [0, 0],
      [128, 128],
      [217, 217],
      [255, 255],
      [40, 200],
    ] as const) {
      const x = minX + (col + 0.5) * ctx.resolution;
      const z = minZ + (row + 0.5) * ctx.resolution;
      // The decoded Float32 value itself — `raw * 0.1` in float64 can land a
      // hair either side of it, which is not what this test is about.
      const level = grid.values[row * W + col];
      expect(isWetAt(grid, x, z, level)).toBe(true); // connect <= h, inclusive
      expect(isWetAt(grid, x, z, level - 0.05)).toBe(false);
    }
  });
});
