import { describe, expect, it } from 'vitest';
import { ManifestError, validateManifest } from '../src/state/manifest';

function baseGrid(overrides: Record<string, unknown> = {}) {
  return {
    path: 'dem_core.tif',
    resolution: 1.0,
    width: 2000,
    height: 2000,
    bounds3006: { minE: 664810, minN: 6626880, maxE: 666810, maxN: 6628880 },
    boundsLocal: { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 },
    encoding: { dtype: 'int16', scale: 0.1, unit: 'm' },
    minElevation: 6.8,
    maxElevation: 57.3,
    ...overrides,
  };
}

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    site: { id: 'broborg', name: 'Broborg' },
    crs: { horizontal: 'EPSG:3006', verticalDatum: 'RH2000' },
    origin: { e: 665810.0, n: 6627880.0 },
    grids: {
      core: baseGrid(),
      context: baseGrid({
        path: 'dem_context.tif',
        resolution: 2.0,
        bounds3006: { minE: 663810, minN: 6625880, maxE: 667810, maxN: 6629880 },
        boundsLocal: { minX: -2000, minZ: -2000, maxX: 2000, maxZ: 2000 },
      }),
    },
    attribution: [{ text: 'Höjddata: © Lantmäteriet', license: 'CC BY 4.0' }],
    ...overrides,
  };
}

describe('manifest validation (contract §2)', () => {
  it('accepts the frozen v1 shape', () => {
    const m = validateManifest(baseManifest());
    expect(m.site.name).toBe('Broborg');
    expect(m.grids.context.resolution).toBe(2);
    expect(m.attribution?.[0].text).toContain('Lantmäteriet');
  });

  it('hard-fails on any schemaVersion other than 1', () => {
    for (const v of [2, 0, '1', undefined, null]) {
      expect(() => validateManifest(baseManifest({ schemaVersion: v }))).toThrow(ManifestError);
    }
    expect(() => validateManifest(baseManifest({ schemaVersion: 2 }))).toThrow(/schemaVersion/);
  });

  it('tolerates unknown extra keys everywhere', () => {
    const m = validateManifest(
      baseManifest({
        futureTopLevel: { anything: true },
        assets: { rampart: 'rampart.json', somethingNew: 'x.bin' },
        site: { id: 'broborg', name: 'Broborg', raa: { lamningsnummer: 'L1943:7827' }, futureField: 42 },
      }),
    );
    expect(m['futureTopLevel']).toEqual({ anything: true });
    expect(m.assets?.rampart).toBe('rampart.json');
    expect((m.site as Record<string, unknown>)['futureField']).toBe(42);
  });

  it('rejects grid paths that escape the site directory', () => {
    expect(() =>
      validateManifest(baseManifest({ grids: { core: baseGrid({ path: '/etc/passwd' }), context: baseGrid() } })),
    ).toThrow(/relative/);
    expect(() =>
      validateManifest(baseManifest({ grids: { core: baseGrid({ path: '../secrets.tif' }), context: baseGrid() } })),
    ).toThrow(/relative/);
  });

  it('rejects numerics supplied as strings', () => {
    expect(() =>
      validateManifest(baseManifest({ grids: { core: baseGrid({ resolution: '1.0' }), context: baseGrid() } })),
    ).toThrow(/finite number/);
  });

  it('defaults attribution to an empty list rather than throwing', () => {
    expect(validateManifest(baseManifest({ attribution: undefined })).attribution).toEqual([]);
  });
});
