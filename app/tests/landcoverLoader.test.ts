/**
 * Loading the optional Phase-7 land-cover pair (contract §9/§10) through a stubbed
 * `fetch`, against the committed testsite files.
 *
 * The feature gate is the point, exactly as for the Phase-4 water pair: a manifest
 * that declares neither asset must load with **no fetch at all** (every pre-v1.2
 * manifest looks like that), a half-declared pair is a pipeline bug worth a warning,
 * and a declared-but-broken asset must disable the layer rather than take the site
 * down.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadLandcoverAssets, loadLandcoverGrid, loadRingLandcover } from '../src/state/loader';
import { validateManifest, type SiteManifest } from '../src/state/manifest';
import { classAtLocal } from '../src/landcover/landcoverGrid';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'testsite');
const manifest: SiteManifest = validateManifest(JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8')));

interface Override {
  body: string | Uint8Array;
  status?: number;
  contentType?: string;
}

/** Serve app/public/data/testsite/<basename>, or an override body per file name. */
function stubFetch(overrides: Record<string, Override> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const name = url.slice(url.lastIndexOf('/') + 1);
    const override = overrides[name];
    if (override) {
      return new Response(override.body as BodyInit, {
        status: override.status ?? 200,
        statusText: override.status === 404 ? 'Not Found' : 'OK',
        headers: { 'content-type': override.contentType ?? 'application/json' },
      });
    }
    try {
      const buf = await readFile(join(DIR, name));
      const binary = name.endsWith('.tif');
      return new Response(binary ? new Uint8Array(buf) : buf.toString('utf8'), {
        status: 200,
        headers: { 'content-type': binary ? 'image/tiff' : 'application/json' },
      });
    } catch {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function without(...keys: string[]): SiteManifest {
  const copy = JSON.parse(JSON.stringify(manifest)) as SiteManifest;
  for (const key of keys) delete (copy.assets as Record<string, string>)[key];
  return copy;
}

/** A single-band uint8 GeoTIFF of `size` x `size`, every sample `value`. */
function uint8Tiff(size: number, value: number): Uint8Array {
  const raw = new Uint8Array(size * size).fill(value);
  const buffer = writeArrayBuffer(raw, {
    width: size,
    height: size,
    BitsPerSample: [8],
    SampleFormat: [1],
    PhotometricInterpretation: 1,
    SamplesPerPixel: [1],
  });
  return new Uint8Array(buffer as ArrayBuffer);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('land-cover loading (contract §9/§10)', () => {
  it('loads and validates the pair a site declares', async () => {
    stubFetch();
    const assets = await loadLandcoverAssets('testsite', manifest);
    expect(assets).not.toBeNull();

    const { grid, legend } = assets!;
    // Geometry comes from grids.context, which stays authoritative (§9).
    expect(grid.width).toBe(manifest.grids.context.width);
    expect(grid.height).toBe(manifest.grids.context.height);
    expect(grid.resolution).toBe(manifest.grids.context.resolution);
    expect(grid.boundsLocal).toEqual(manifest.grids.context.boundsLocal);
    expect(grid.classes).toBeInstanceOf(Uint8Array);
    expect(grid.classes.length).toBe(grid.width * grid.height);
    // Every sample addresses a class the legend declares.
    expect(grid.classes.reduce((m, v) => (v > m ? v : m), 0)).toBeLessThan(legend.classes.length);
    expect(legend.referenceYearCE).toBe(500);
    // The lookup is nearest-sample and lands inside the grid.
    expect(classAtLocal(grid, 0, 0)).toBeLessThan(legend.classes.length);
  });

  it('resolves both URLs relative to the site data directory', async () => {
    const fetchMock = stubFetch();
    await loadLandcoverAssets('testsite', manifest);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => u.endsWith('data/testsite/landcover_legend.json'))).toBe(true);
    expect(urls.some((u) => u.endsWith('data/testsite/landcover.tif'))).toBe(true);
    for (const url of urls) expect(url).not.toContain('..');
  });

  it('is off — with no fetch, no warning — when the manifest declares neither', async () => {
    const fetchMock = stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadLandcoverAssets('testsite', without('landcover', 'landcoverLegend'))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['landcover', 'landcoverLegend'],
    ['landcoverLegend', 'landcover'],
  ])('warns and stays off when only %s is declared', async (_kept, dropped) => {
    const fetchMock = stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadLandcoverAssets('testsite', without(dropped))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('are a pair'));
  });

  it('disables the layer, loudly, when the declared raster is missing', async () => {
    stubFetch({ 'landcover.tif': { body: 'nope', status: 404 } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadLandcoverAssets('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('land-cover layer disabled'));
  });

  it('disables the layer when the legend is not JSON (SPA fallback)', async () => {
    stubFetch({ 'landcover_legend.json': { body: '<!doctype html>', contentType: 'text/html' } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadLandcoverAssets('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('did not return JSON'));
  });

  it('disables the layer when the legend violates §10', async () => {
    stubFetch({
      'landcover_legend.json': {
        body: JSON.stringify({
          schemaVersion: 1,
          referenceYearCE: 500,
          referenceLevelM: 8.6,
          method: 'm',
          caveat: 'c',
          calibration: 'cal',
          classes: [{ index: 0, id: 'water', name: 'Water', color: 'not-a-hex', rule: 'r', vegetation: null }],
        }),
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadLandcoverAssets('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('#rrggbb'));
  });

  it('disables the layer when the raster geometry disagrees with grids.context', async () => {
    stubFetch({ 'landcover.tif': { body: uint8Tiff(8, 0), contentType: 'image/tiff' } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadLandcoverAssets('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('grids.context'));
  });

  it('disables the layer when a raw value is not a legal class index', async () => {
    const size = manifest.grids.context.width;
    stubFetch({ 'landcover.tif': { body: uint8Tiff(size, 200), contentType: 'image/tiff' } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadLandcoverAssets('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('not a valid index'));
  });

  it('loads a legend whose last class is runtime-only (contract §10 v1.3)', async () => {
    // A `dynamic` shore band holds no cells: areaFraction 0 and an index the raster
    // never contains. The loader's "every raw value is a legal index" check is a
    // `<` test, so a class beyond the maximum raster value is legal by construction.
    const doc = JSON.parse(await readFile(join(DIR, 'landcover_legend.json'), 'utf8')) as {
      classes: Record<string, unknown>[];
    };
    // Start from a legend with no dynamic markers, whatever the fixture ships, so
    // this case pins the loader rather than the fixture's current class layout.
    for (const c of doc.classes) delete c['dynamic'];
    doc.classes.push({
      index: doc.classes.length,
      id: 'shore_reeds_runtime_only',
      name: 'Shore reed belt (follows the shoreline)',
      color: '#77875a',
      rule: 'derived by the app at the current level from water_connect.tif',
      vegetation: { type: 'reeds', densityPerHa: 500 },
      dynamic: { kind: 'shore-band', bandM: 0.6 },
      areaFraction: 0,
    });

    stubFetch({ 'landcover_legend.json': { body: JSON.stringify(doc) } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const assets = await loadLandcoverAssets('testsite', manifest);
    expect(error).not.toHaveBeenCalled();
    expect(assets).not.toBeNull();

    const { grid, legend } = assets!;
    const band = legend.classes[legend.classes.length - 1];
    expect(band.dynamic).toEqual({ kind: 'shore-band', bandM: 0.6 });
    expect(band.areaFraction).toBe(0);
    // No cell in the raster addresses it — that is what "runtime-only" means.
    expect(grid.classes.reduce((m, v) => (v > m ? v : m), 0)).toBeLessThan(band.index);
  });

  it('reports progress and never scales the class indices', async () => {
    stubFetch();
    const seen: number[] = [];
    const grid = await loadLandcoverGrid('testsite', manifest, 5, (f) => seen.push(f));
    expect(seen[seen.length - 1]).toBe(1);
    // §9 values are indices, not measurements: `encoding.scale` (0.1) must not touch them.
    expect(grid.classes.every((v) => Number.isInteger(v))).toBe(true);
    expect(grid.classes.some((v) => v > 0)).toBe(true);
  });
});

// -------------------------------------- v1.6 §13: far-field land cover ------

/**
 * A ring's class raster, served against the committed `testsite-rings` bundle.
 *
 * That bundle is pre-v1.6 (no far field), so the far-field keys are injected into
 * a clone of it here rather than committed to the fixture: what is being tested is
 * the loader's contract, not the pipeline's current output. The raster itself is
 * constructed at the ring entry's own dimensions — §13 requires exactly that.
 */
const RINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'testsite-rings');
const ringsDoc: Record<string, unknown> = JSON.parse(await readFile(join(RINGS_DIR, 'manifest.json'), 'utf8'));

/** The rings manifest with the §13 keys a v1.6 bundle would ship. */
function ringsManifest(ringLandcover: string | null = 'landcover_ring3.tif'): SiteManifest {
  const doc = JSON.parse(JSON.stringify(ringsDoc)) as Record<string, unknown>;
  const assets = (doc['assets'] ?? {}) as Record<string, string>;
  assets['landcover'] = 'landcover.tif';
  assets['landcoverLegend'] = 'landcover_legend.json';
  doc['assets'] = assets;
  const rings = (doc['grids'] as Record<string, unknown>)['rings'] as Record<string, unknown>[];
  if (ringLandcover !== null) rings[0]['landcover'] = ringLandcover;
  return validateManifest(doc);
}

/** Serve one constructed ring raster; anything else 404s (nothing else is fetched). */
function stubRingFetch(body: Uint8Array | undefined) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    body
      ? new Response(body as BodyInit, { status: 200, headers: { 'content-type': 'image/tiff' } })
      : new Response('not found', { status: 404, statusText: 'Not Found' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('far-field ring land cover (contract §13)', () => {
  const ringEntry = () => ringsManifest().grids.rings![0];

  it('decodes a ring raster on the ring entry\'s own geometry', async () => {
    const manifest = ringsManifest();
    const ring = manifest.grids.rings![0];
    stubRingFetch(uint8Tiff(ring.width, 2));

    const grid = await loadRingLandcover('testsite-rings', manifest, 0, 4);
    // The ring entry is authoritative for geometry, not grids.context (§13).
    expect(grid.width).toBe(ring.width);
    expect(grid.height).toBe(ring.height);
    expect(grid.resolution).toBe(ring.resolution);
    expect(grid.boundsLocal).toEqual(ring.boundsLocal);
    expect(grid.classes).toBeInstanceOf(Uint8Array);
    expect(grid.classes.length).toBe(ring.width * ring.height);
    // Indices, never measurements: the ring's 0.5 m `encoding.scale` must not touch them.
    expect(grid.classes.every((v) => v === 2)).toBe(true);
  });

  it('resolves the URL under the site data directory and reports progress', async () => {
    const manifest = ringsManifest();
    const fetchMock = stubRingFetch(uint8Tiff(ringEntry().width, 0));
    const seen: number[] = [];
    await loadRingLandcover('testsite-rings', manifest, 0, 1, (f) => seen.push(f));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.endsWith('data/testsite-rings/landcover_ring3.tif')).toBe(true);
    expect(url).not.toContain('..');
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('throws when the raster geometry disagrees with the ring entry', async () => {
    const manifest = ringsManifest();
    stubRingFetch(uint8Tiff(8, 0));
    await expect(loadRingLandcover('testsite-rings', manifest, 0, 4)).rejects.toThrow(
      /dem_ring3\.tif ring entry/,
    );
  });

  it('throws when a raw value is not a legal far-field class index', async () => {
    const manifest = ringsManifest();
    stubRingFetch(uint8Tiff(ringEntry().width, 7));
    await expect(loadRingLandcover('testsite-rings', manifest, 0, 4)).rejects.toThrow(
      /not a valid index into the legend's 4 classes/,
    );
  });

  it('throws — with no fetch — for a ring that declares none, and for a ring that is not there', async () => {
    const manifest = ringsManifest(null);
    const fetchMock = stubRingFetch(undefined);
    await expect(loadRingLandcover('testsite-rings', manifest, 0, 4)).rejects.toThrow(
      /declares no far-field land-cover raster/,
    );
    await expect(loadRingLandcover('testsite-rings', manifest, 9, 4)).rejects.toThrow(
      /grids\.rings\[9\] is not declared/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables the ring tint rather than the site when the raster is missing', async () => {
    const manifest = ringsManifest();
    stubRingFetch(undefined);
    // §13: per-ring graceful. The loader throws; the caller treats that as "this
    // ring tints nothing", and the rings themselves are untouched.
    await expect(loadRingLandcover('testsite-rings', manifest, 0, 4)).rejects.toThrow(/404/);
    expect(manifest.grids.rings).toHaveLength(2);
  });
});
