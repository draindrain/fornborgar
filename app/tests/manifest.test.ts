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

// --------------------------------------------------------------------------- //
// v1.4 §11 — far-field rings
// --------------------------------------------------------------------------- //

import { vi } from 'vitest';

function ringGrid(km: number, resolution: number, path: string, overrides: Record<string, unknown> = {}) {
  const half = (km * 1000) / 2;
  return baseGrid({
    path,
    resolution,
    bounds3006: { minE: 665810 - half, minN: 6627880 - half, maxE: 665810 + half, maxN: 6627880 + half },
    boundsLocal: { minX: -half, minZ: -half, maxX: half, maxZ: half },
    width: (2 * half) / resolution,
    height: (2 * half) / resolution,
    encoding: { dtype: 'int16', scale: resolution >= 32 ? 1.0 : 0.5, unit: 'm' },
    ...overrides,
  });
}

function ringedManifest(rings: unknown[], overrides: Record<string, unknown> = {}) {
  const base = baseManifest(overrides);
  (base.grids as Record<string, unknown>)['rings'] = rings;
  return base;
}

describe('manifest validation — far-field rings (contract §11)', () => {
  const goodRings = [
    ringGrid(8, 4, 'dem_ring3.tif'),
    ringGrid(16, 8, 'dem_ring4.tif', { waterConnect: 'water_connect_ring4.tif' }),
    ringGrid(32, 16, 'dem_ring5.tif'),
  ];

  it('accepts a valid inside-out ladder and keeps waterConnect', () => {
    const m = validateManifest(ringedManifest(goodRings));
    expect(m.grids.rings).toHaveLength(3);
    expect(m.grids.rings?.[0].resolution).toBe(4);
    expect(m.grids.rings?.[1].waterConnect).toBe('water_connect_ring4.tif');
    expect(m.grids.rings?.[0].waterConnect).toBeUndefined();
  });

  it('a ringless manifest has no rings key and still validates', () => {
    const m = validateManifest(baseManifest());
    expect(m.grids.rings).toBeUndefined();
  });

  it('drops malformed rings with a warning instead of failing the site', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Out of order: the outer ring first.
      const m = validateManifest(ringedManifest([goodRings[2], goodRings[0]]));
      expect(m.grids.rings).toBeUndefined();
      expect(m.site.name).toBe('Broborg'); // the site itself still loads
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('rings dropped'));
    } finally {
      warn.mockRestore();
    }
  });

  it('drops rings that do not coarsen outward', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fineOuter = ringGrid(16, 4, 'dem_ring4.tif');
      const m = validateManifest(ringedManifest([ringGrid(8, 4, 'dem_ring3.tif'), fineOuter]));
      expect(m.grids.rings).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('drops rings when more than one carries waterConnect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const both = [
        ringGrid(8, 4, 'dem_ring3.tif', { waterConnect: 'a.tif' }),
        ringGrid(16, 8, 'dem_ring4.tif', { waterConnect: 'b.tif' }),
      ];
      expect(validateManifest(ringedManifest(both)).grids.rings).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('drops rings whose waterConnect path escapes the site directory', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bad = [ringGrid(8, 4, 'dem_ring3.tif', { waterConnect: '../secrets.tif' })];
      expect(validateManifest(ringedManifest(bad)).grids.rings).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps a numeric horizon block and drops a malformed one', () => {
    const good = validateManifest(
      ringedManifest(goodRings, { horizon: { crownM: 57.3, floorM: 5.1, eyeM: 2, distanceKm: 27.9 } }),
    );
    expect(good.horizon?.distanceKm).toBe(27.9);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bad = validateManifest(ringedManifest(goodRings, { horizon: { crownM: 'high' } }));
      expect(bad.horizon).toBeUndefined();
      expect(bad.grids.rings).toHaveLength(3); // rings survive a bad horizon block
    } finally {
      warn.mockRestore();
    }
  });
});
