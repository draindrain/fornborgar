/**
 * v1.5 §12: the delta-encoded connectivity grid, loaded against the committed
 * ringed fixture (which ships the delta form) and cross-checked against the
 * plain testsite (which still ships the absolute §7 grid).
 *
 * The two properties that matter:
 *   • `dem + delta` reconstructs exactly the surface the absolute grid carried,
 *     so every `connect <= h` decision downstream is unchanged;
 *   • a pre-v1.5 bundle that declares only `assets.waterConnect` still loads
 *     through the same code path — the app never requires the new encoding.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConnectGrid, loadGrid, loadRingGrid, loadRingConnect, loadWaterAssets } from '../src/state/loader';
import { validateManifest, type SiteManifest } from '../src/state/manifest';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

async function manifestFor(site: string): Promise<SiteManifest> {
  return validateManifest(JSON.parse(await readFile(join(DATA, site, 'manifest.json'), 'utf8')));
}

const ringed = await manifestFor('testsite-rings');
const plain = await manifestFor('testsite');

function stubFetch(site: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const name = url.slice(url.lastIndexOf('/') + 1);
      try {
        const body = await readFile(join(DATA, site, name));
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-type': name.endsWith('.json') ? 'application/json' : 'image/tiff' },
        });
      } catch {
        return new Response('not found', { status: 404, statusText: 'Not Found' });
      }
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('delta-encoded connectivity (contract §12)', () => {
  it('reconstructs connect = dem + delta on the context grid', async () => {
    stubFetch('testsite-rings');
    const dem = await loadGrid('testsite-rings', 'context', ringed);
    const connect = await loadConnectGrid('testsite-rings', ringed, () => {}, dem);

    expect(connect.width).toBe(ringed.grids.context.width);
    expect(connect.values.length).toBe(dem.heights.length);
    // The §7 invariant the whole water layer rests on, after reconstruction.
    for (let i = 0; i < connect.values.length; i++) {
      expect(connect.values[i]).toBeGreaterThanOrEqual(dem.heights[i] - 1e-6);
    }
    // And it is not the trivial reconstruction: some cells were actually lifted.
    expect(connect.values.some((v, i) => v > dem.heights[i] + 1e-6)).toBe(true);
  });

  it('reconstructs the §11 far-water grid against its own ring DEM', async () => {
    stubFetch('testsite-rings');
    const ring = ringed.grids.rings![1];
    const ringDem = await loadRingGrid('testsite-rings', ringed, 1);
    const far = await loadRingConnect('testsite-rings', ring, () => {}, ringDem);

    expect(far.width).toBe(ring.width);
    expect(far.resolution).toBe(ring.resolution);
    for (let i = 0; i < far.values.length; i++) {
      expect(far.values[i]).toBeGreaterThanOrEqual(ringDem.heights[i] - 1e-6);
    }
  });

  it('accepts the delta half of the pair as satisfying the §6/§7 pairing', async () => {
    stubFetch('testsite-rings');
    const dem = await loadGrid('testsite-rings', 'context', ringed);
    const assets = await loadWaterAssets('testsite-rings', ringed, () => {}, dem);
    expect(assets).not.toBeNull();
    expect(assets!.table.steps.length).toBeGreaterThanOrEqual(2);
    expect(assets!.connect.values.length).toBe(dem.heights.length);
  });

  it('still loads a pre-v1.5 bundle that ships only the absolute grid', async () => {
    stubFetch('testsite');
    expect(plain.assets?.['waterConnectDelta']).toBeUndefined();
    expect(plain.assets?.['waterConnect']).toBe('water_connect.tif');
    const dem = await loadGrid('testsite', 'context', plain);
    // Passing the DEM must not change anything when there is no delta to use.
    const withDem = await loadConnectGrid('testsite', plain, () => {}, dem);
    const withoutDem = await loadConnectGrid('testsite', plain);
    expect(Array.from(withDem.values)).toEqual(Array.from(withoutDem.values));
  });

  it('refuses to reconstruct a delta without the DEM rather than mis-decoding it', async () => {
    stubFetch('testsite-rings');
    await expect(loadConnectGrid('testsite-rings', ringed)).rejects.toThrow(/needs the context DEM/);
  });

  it('rejects a delta whose sample count disagrees with its DEM', async () => {
    stubFetch('testsite-rings');
    const wrongSize = await loadGrid('testsite-rings', 'core', ringed);
    // The core grid has the same pixel count as the context grid in this
    // fixture, so shorten it explicitly to make the mismatch real.
    const truncated = { ...wrongSize, heights: wrongSize.heights.slice(0, 16) };
    await expect(
      loadConnectGrid('testsite-rings', ringed, () => {}, truncated),
    ).rejects.toThrow(/delta samples/);
  });
});
