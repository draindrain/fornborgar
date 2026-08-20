/**
 * Loading the optional Phase-4 assets (contract §6/§7) against the committed
 * testsite files, served through a stubbed `fetch`.
 *
 * The two things that must hold no matter what the pipeline emits:
 *   • `grids.context` is authoritative for the connectivity grid's geometry, so a
 *     dimension disagreement is a hard error rather than something to stretch;
 *   • a plain v1 manifest with no water assets keeps loading, feature off, no
 *     network traffic and no error (the backward-compatibility rule in the
 *     contract preamble).
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConnectGrid, loadShorelineTable, loadWaterAssets } from '../src/state/loader';
import { validateManifest, type SiteManifest } from '../src/state/manifest';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'testsite');

const manifest: SiteManifest = validateManifest(JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8')));

/** Serve app/public/data/testsite/<basename> for any URL the loader builds. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const name = url.slice(url.lastIndexOf('/') + 1);
    let body: Buffer;
    try {
      body = await readFile(join(DIR, name));
    } catch {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { 'content-type': name.endsWith('.json') ? 'application/json' : 'image/tiff' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('water asset loading (contract §6/§7)', () => {
  it('loads both assets for a site that declares them', async () => {
    stubFetch();
    const assets = await loadWaterAssets('testsite', manifest);
    expect(assets).not.toBeNull();
    expect(assets!.table.steps.length).toBeGreaterThanOrEqual(2);
    expect(assets!.connect.width).toBe(manifest.grids.context.width);
    expect(assets!.connect.height).toBe(manifest.grids.context.height);
    expect(assets!.connect.resolution).toBe(manifest.grids.context.resolution);
    expect(assets!.connect.boundsLocal).toEqual(manifest.grids.context.boundsLocal);
    expect(assets!.connect.values.length).toBe(manifest.grids.context.width * manifest.grids.context.height);
    // Decoded to meters through the context grid's encoding (§7: identical).
    expect(Math.max(...assets!.connect.values)).toBeLessThan(200);
  });

  it('rejects a connect grid whose dimensions disagree with grids.context', async () => {
    stubFetch();
    // Same ground extent, half the samples — self-consistent manifest, wrong file.
    const g = manifest.grids.context;
    const wrong: SiteManifest = {
      ...manifest,
      grids: {
        core: manifest.grids.core,
        context: { ...g, width: g.width / 2, height: g.height / 2, resolution: g.resolution * 2 },
      },
    };
    await expect(loadConnectGrid('testsite', wrong)).rejects.toThrow(
      /water_connect\.tif: TIFF is 256x256 but grids\.context .* declares 128x128/,
    );
  });

  it('turns the feature off (not an error) when the connect grid is unreadable', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith('.json')
        ? new Response(await readFile(join(DIR, 'shoreline.json')), { status: 200 })
        : new Response('nope', { status: 404, statusText: 'Not Found' }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadWaterAssets('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('paleo-shoreline layer disabled'));
  });

  it('rejects an invalid shoreline table with the offending file named', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ schemaVersion: 1, steps: [{ yearCE: 0, levelM: 1 }] })),
    );
    await expect(loadShorelineTable('testsite', manifest)).rejects.toThrow(/shoreline\.json: steps must be an array/);
  });
});

describe('plain v1 backward compatibility (contract preamble)', () => {
  const plain: SiteManifest = { ...manifest };
  delete plain.assets;

  it('keeps loading with no water assets: feature off, no fetch, no warning', async () => {
    const fetchMock = stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadWaterAssets('testsite', plain)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns — and stays off — when only one of the pair is declared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch();
    for (const half of ['shoreline', 'waterConnect'] as const) {
      warn.mockClear();
      const partial: SiteManifest = { ...manifest, assets: { [half]: manifest.assets![half] } };
      expect(await loadWaterAssets('testsite', partial)).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('are a pair'));
    }
  });
});
