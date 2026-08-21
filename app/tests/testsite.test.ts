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
import { validateShoreline, levelAt } from '../src/water/shoreline';
import { validateLandcoverLegend, vegetationClasses } from '../src/landcover/legend';
import { classHistogram, type LandcoverGrid } from '../src/landcover/landcoverGrid';
import { sampleVegetation } from '../src/landcover/vegetation';
// @ts-expect-error - plain .mjs generator, imported for its height function and shared constants
import { heightAt, FALSE_BASIN, LANDCOVER } from '../scripts/make-test-dem.mjs';

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

// ------------------------------------------------ Phase 7: land cover -------

/** Raw samples of a single-band fixture TIFF, whatever type it declares. */
async function readRaw(path: string): Promise<ArrayLike<number>> {
  const buf = await readFile(join(DIR, path));
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const image = await tiff.getImage();
  const rasters = await image.readRasters({ interleave: false });
  return (rasters as unknown as ArrayLike<number>[])[0];
}

describe('synthetic land-cover fixture (contract §9/§10)', () => {
  const ctx = manifest.grids.context;

  it('declares the §9/§10 pair, the layer entry and the widened SGU slot', () => {
    expect(manifest.assets?.['landcover']).toBe('landcover.tif');
    expect(manifest.assets?.['landcoverLegend']).toBe('landcover_legend.json');

    // Contract v1.2 layer order: terrain, sites, water, landcover, palisade.
    const ids = (manifest.layers ?? []).map((l) => l.id);
    expect(ids).toContain('landcover');
    expect(ids.indexOf('landcover')).toBeGreaterThan(ids.indexOf('water'));
    expect(ids.indexOf('landcover')).toBeLessThan(ids.indexOf('palisade'));
    expect(manifest.layers?.find((l) => l.id === 'landcover')?.provenance).toBe('model');

    // The SGU attribution slot is widened from shoreline-only to soils + shoreline.
    // The fixture keeps saying "synthetic": none of it came from SGU (PLAN §6.1).
    const sgu = (manifest.attribution ?? []).find((a) => /Sveriges geologiska/.test(a.text));
    expect(sgu?.text).toMatch(/^Jordarts- och strandförskjutning/);
    expect(sgu?.text).toMatch(/synthetic test data/);

    const processing = (manifest.provenance as { processing?: string[] } | undefined)?.processing ?? [];
    expect(processing.join(' ')).toMatch(/land-cover rule model/);
    expect(processing.join(' ')).toMatch(/uint8 class raster/);
  });

  it('is a uint8 raster on the exact grids.context geometry', async () => {
    const band = await readRaw(manifest.assets!['landcover']);
    expect(band.constructor.name).toBe('Uint8Array');
    expect(band.length).toBe(ctx.width * ctx.height);
  });

  it('carries a legend whose classes the raster actually uses', async () => {
    const legend = validateLandcoverLegend(
      JSON.parse(await readFile(join(DIR, 'landcover_legend.json'), 'utf8')),
      'landcover_legend.json',
    );
    const band = await readRaw(manifest.assets!['landcover']);
    const grid: LandcoverGrid = {
      width: ctx.width,
      height: ctx.height,
      resolution: ctx.resolution,
      boundsLocal: ctx.boundsLocal,
      classes: Uint8Array.from(band as ArrayLike<number>),
    };

    // Every raw value is a legal index, and every declared class is actually used.
    const counts = classHistogram(grid, legend.classes.length);
    expect(grid.classes.reduce((m, v) => (v > m ? v : m), 0)).toBeLessThan(legend.classes.length);
    for (let i = 0; i < legend.classes.length; i++) {
      expect(counts[i], `class ${legend.classes[i].id} is declared but never used`).toBeGreaterThan(0);
    }

    // areaFraction is what the raster really contains (§10: informational, ±0.001).
    const total = grid.classes.length;
    for (let i = 0; i < legend.classes.length; i++) {
      expect(legend.classes[i].areaFraction!).toBeCloseTo(counts[i] / total, 3);
    }

    // All three vegetation forms plus a class with none — the fixture exists to
    // exercise every branch the app has.
    expect(vegetationClasses(legend).map((c) => c.vegetation.type).sort()).toEqual([
      'broadleaf',
      'conifer',
      'reeds',
    ]);
    expect(legend.classes.some((c) => c.vegetation === null)).toBe(true);
    expect(legend.method).toContain('SYNTHETIC TEST DATA');
    expect(legend.calibration).toContain('SYNTHETIC TEST DATA');
  });

  it('agrees with the §6 table on the reference century, and applies its own rules', async () => {
    const shoreline = validateShoreline(JSON.parse(await readFile(join(DIR, 'shoreline.json'), 'utf8')));
    const legend = validateLandcoverLegend(JSON.parse(await readFile(join(DIR, 'landcover_legend.json'), 'utf8')));
    const levelM = legend.referenceLevelM;
    expect(legend.referenceYearCE).toBe(LANDCOVER.referenceYearCE);
    // The level comes from the §6 table (interpolated between its century steps),
    // not from the curve behind it — same number the app's slider would show.
    expect(levelM).toBeCloseTo(levelAt(shoreline, legend.referenceYearCE), 2);

    const classes = await readRaw(manifest.assets!['landcover']);
    const connect = await readRaw(manifest.assets!['waterConnect']);
    const reedTop = levelM + LANDCOVER.reedBandM;

    // The two connectivity-driven classes must match their stated rules exactly —
    // this is the check that the legend text and the raster cannot drift apart.
    for (let i = 0; i < classes.length; i++) {
      const connectM = connect[i] * ctx.encoding.scale;
      if (classes[i] === 0) expect(connectM).toBeLessThanOrEqual(levelM + 1e-9);
      else expect(connectM).toBeGreaterThan(levelM);
      if (classes[i] === 1) expect(connectM).toBeLessThanOrEqual(reedTop + 1e-9);
    }
  });

  it('keeps the false basin out of the sea class, though its floor is below the level', async () => {
    const legend = validateLandcoverLegend(JSON.parse(await readFile(join(DIR, 'landcover_legend.json'), 'utf8')));
    const classes = await readRaw(manifest.assets!['landcover']);
    const dem = await readRaw(ctx.path);

    const b = FALSE_BASIN as { centreX: number; centreZ: number; floorRadius: number };
    const centreCol = Math.round((b.centreX - ctx.boundsLocal.minX) / ctx.resolution - 0.5);
    const centreRow = Math.round((b.centreZ - ctx.boundsLocal.minZ) / ctx.resolution - 0.5);
    const span = Math.ceil(b.floorRadius / ctx.resolution);

    let below = 0;
    for (let dr = -span; dr <= span; dr++) {
      for (let dc = -span; dc <= span; dc++) {
        if (Math.hypot(dc, dr) * ctx.resolution > b.floorRadius) continue;
        const i = (centreRow + dr) * ctx.width + (centreCol + dc);
        if (dem[i] * ctx.encoding.scale < legend.referenceLevelM) below++;
        // Every floor cell is dry land: the rule tests connectivity, not elevation.
        expect(classes[i]).not.toBe(0);
      }
    }
    // ...and some of that floor really is below the reference water level.
    expect(below).toBeGreaterThan(0);
  });

  it('samples a plausible, reproducible vegetation load from the committed files', async () => {
    const legend = validateLandcoverLegend(JSON.parse(await readFile(join(DIR, 'landcover_legend.json'), 'utf8')));
    const band = await readRaw(manifest.assets!['landcover']);
    const grid: LandcoverGrid = {
      width: ctx.width,
      height: ctx.height,
      resolution: ctx.resolution,
      boundsLocal: ctx.boundsLocal,
      classes: Uint8Array.from(band as ArrayLike<number>),
    };

    const sample = sampleVegetation(grid, legend, { seed: 1, densityScale: 1 });
    // A 512 m square fixture: hundreds to a few thousand plants, nowhere near the cap.
    expect(sample.total).toBeGreaterThan(500);
    expect(sample.total).toBeLessThan(20_000);
    expect(sample.capped).toBe(false);
    expect(sample.byType.map((t) => t.type).sort()).toEqual(['broadleaf', 'conifer', 'reeds']);

    const again = sampleVegetation(grid, legend, { seed: 1, densityScale: 1 });
    expect(again.total).toBe(sample.total);
    expect(Array.from(again.byType[0].x)).toEqual(Array.from(sample.byType[0].x));
  });
});
