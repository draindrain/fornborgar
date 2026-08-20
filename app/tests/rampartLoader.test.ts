/**
 * Loading the optional Phase-5 rampart asset (contract §8) through a stubbed
 * `fetch`, against the committed testsite files.
 *
 * The feature gate is the point: a manifest without `assets.rampart` must load with
 * **no fetch at all** (every pre-v1.1 manifest looks like that), and a declared but
 * broken asset must disable the palisade rather than take the site down.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadRampart } from '../src/state/loader';
import { validateManifest, type SiteManifest } from '../src/state/manifest';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'testsite');
const manifest: SiteManifest = validateManifest(JSON.parse(await readFile(join(DIR, 'manifest.json'), 'utf8')));

/** Serve app/public/data/testsite/<basename>, or an override body per file name. */
function stubFetch(overrides: Record<string, { body: string; status?: number; contentType?: string }> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const name = url.slice(url.lastIndexOf('/') + 1);
    const override = overrides[name];
    if (override) {
      return new Response(override.body, {
        status: override.status ?? 200,
        statusText: override.status === 404 ? 'Not Found' : 'OK',
        headers: { 'content-type': override.contentType ?? 'application/json' },
      });
    }
    try {
      return new Response(await readFile(join(DIR, name), 'utf8'), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function withoutRampart(): SiteManifest {
  const copy = JSON.parse(JSON.stringify(manifest)) as SiteManifest;
  delete (copy.assets as Record<string, string>)['rampart'];
  return copy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('rampart loading (contract §8)', () => {
  it('loads and validates the asset a site declares', async () => {
    stubFetch();
    const file = await loadRampart('testsite', manifest);
    expect(file).not.toBeNull();
    expect(file!.paths[0].id).toBe('inner');
    expect(file!.paths[0].closed).toBe(true);
    expect(file!.derivation.method).toBe('dem-ridge');
  });

  it('resolves the URL relative to the site data directory', async () => {
    const fetchMock = stubFetch();
    await loadRampart('testsite', manifest);
    // `siteDataUrl` prefixes import.meta.env.BASE_URL (contract §0), so the tail is
    // what the loader itself contributes.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url.endsWith('data/testsite/rampart.json')).toBe(true);
    expect(url).not.toContain('..');
  });

  it('is off — with no fetch — when the manifest declares no rampart', async () => {
    const fetchMock = stubFetch();
    expect(await loadRampart('testsite', withoutRampart())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables the layer, loudly, when the declared asset is missing', async () => {
    stubFetch({ 'rampart.json': { body: 'nope', status: 404 } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadRampart('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('palisade layer disabled'));
  });

  it('disables the layer when the asset is not JSON (SPA fallback)', async () => {
    stubFetch({ 'rampart.json': { body: '<!doctype html>', contentType: 'text/html' } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadRampart('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('did not return JSON'));
  });

  it('disables the layer when the asset violates §8', async () => {
    stubFetch({
      'rampart.json': {
        body: JSON.stringify({
          schemaVersion: 1,
          derivation: { method: 'dem-ridge', description: 'x', generated: '2026-08-20' },
          paths: [{ id: 'inner', name: 'Inner', closed: true, lengthM: 1, points: [[0, 0]] }],
        }),
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadRampart('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('at least 3 positions'));
  });

  it('rejects points that fall outside the core grid', async () => {
    stubFetch({
      'rampart.json': {
        body: JSON.stringify({
          schemaVersion: 1,
          derivation: { method: 'dem-ridge', description: 'x', generated: '2026-08-20' },
          paths: [
            {
              id: 'inner',
              name: 'Inner',
              closed: false,
              lengthM: 1,
              points: [
                [0, 0],
                [0.5, 0],
                [10_000, 0],
              ],
            },
          ],
        }),
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadRampart('testsite', manifest)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('outside the core grid bounds'));
  });
});
