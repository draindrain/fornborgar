/**
 * Phase-5 registered-sites overlay: contract §3 validation, the cartographic
 * style map, path densification for draping, and the committed Broborg
 * sites.json actually passing the same validator the app runs.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { densifyPath, siteStyle, validateSites, SitesError, DRAPE_STEP } from '../src/overlays/sites';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function minimalSite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'L0000:1',
    name: 'Test',
    lamningstyp: 'Gravfält',
    provenance: 'measured',
    position: { x: 1, z: -2 },
    ...overrides,
  };
}

describe('validateSites (contract §3)', () => {
  it('accepts a minimal valid file', () => {
    const doc = validateSites({ schemaVersion: 1, fetched: '2026-08-20', sites: [minimalSite()] });
    expect(doc.sites).toHaveLength(1);
  });

  it('accepts optional geometryLocal and unknown extra keys', () => {
    const doc = validateSites({
      schemaVersion: 1,
      sites: [
        minimalSite({
          geometryLocal: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10]]] },
          futureKey: { anything: true },
        }),
      ],
      alsoUnknown: 1,
    });
    expect(doc.sites[0].geometryLocal?.type).toBe('Polygon');
  });

  it.each([
    ['wrong schemaVersion', { schemaVersion: 2, sites: [] }],
    ['sites not an array', { schemaVersion: 1, sites: {} }],
    ['missing id', { schemaVersion: 1, sites: [minimalSite({ id: undefined })] }],
    ['missing name', { schemaVersion: 1, sites: [minimalSite({ name: '' })] }],
    ['non-numeric position', { schemaVersion: 1, sites: [minimalSite({ position: { x: 'a', z: 0 } })] }],
    ['NaN position', { schemaVersion: 1, sites: [minimalSite({ position: { x: NaN, z: 0 } })] }],
    ['geometry without type', { schemaVersion: 1, sites: [minimalSite({ geometryLocal: { coordinates: [] } })] }],
    [
      'geometry without coordinates',
      { schemaVersion: 1, sites: [minimalSite({ geometryLocal: { type: 'Polygon' } })] },
    ],
    ['duplicate ids', { schemaVersion: 1, sites: [minimalSite(), minimalSite()] }],
  ])('rejects %s', (_label, raw) => {
    expect(() => validateSites(raw)).toThrow(SitesError);
  });

  it('the committed Broborg sites.json passes the app validator', async () => {
    const raw = JSON.parse(await readFile(join(ROOT, 'public', 'data', 'broborg', 'sites.json'), 'utf8'));
    const doc = validateSites(raw, 'broborg/sites.json');
    expect(doc.sites.length).toBeGreaterThanOrEqual(30);
    const fort = doc.sites.find((s) => s.id === 'L1943:7827');
    expect(fort?.lamningstyp).toBe('Fornborg');
    expect(fort?.geometryLocal?.type).toBe('Polygon');
    // Every representative point lies inside the 4x4 km context extent.
    for (const site of doc.sites) {
      expect(Math.abs(site.position.x)).toBeLessThanOrEqual(2000);
      expect(Math.abs(site.position.z)).toBeLessThanOrEqual(2000);
    }
  });
});

/**
 * The evidence families the widened KMR selection is drawn in. Colour carries the
 * family, so these lists are what the assertions below compare against each other —
 * an exact hex would pin the palette, which is a design choice, not a contract.
 */
const GRAVE_POINT_TYPES = [
  'Hög',
  'Stensättning',
  'Röse',
  'Gravgrupp',
  'Flatmarksgrav',
  'Grav markerad av sten/block',
  'Stenkammargrav',
];
const SETTLEMENT_TYPES = ['Boplats', 'Skärvstenshög', 'Husgrund, förhistorisk/medeltida', 'Boplatsvall'];
const CULTIVATION_TYPES = [
  'Fossil åker',
  'Område med fossil åkermark',
  'Röjningsröse',
  'Röjningsröseområde',
  'Terrassering',
];
const ENCLOSURE_TYPES = ['Hägnad', 'Hägnadssystem'];
const ROAD_TYPES = ['Färdväg', 'Färdvägssystem'];

const NEW_TYPES = [...GRAVE_POINT_TYPES, ...SETTLEMENT_TYPES, ...CULTIVATION_TYPES, ...ENCLOSURE_TYPES].filter(
  (t) => t !== 'Boplats',
);

describe('siteStyle', () => {
  it('maps the PLAN §2.2 types and falls back for unknown ones', () => {
    expect(siteStyle('Fornborg').shape).toBe('ring');
    expect(siteStyle('Gravfält').shape).toBe('disc');
    expect(siteStyle('Boplats').shape).toBe('square');
    expect(siteStyle('Runristning').shape).toBe('diamond');
    const fallback = siteStyle('Something new');
    expect(fallback.color).toBeTruthy();
    expect(fallback.radius).toBeGreaterThan(0);
  });

  it('styles every type of the widened selection, none left on the gray fallback', () => {
    const fallback = siteStyle('Något helt annat');
    for (const type of NEW_TYPES) {
      const style = siteStyle(type);
      expect(style, type).not.toEqual(fallback);
      expect(['ring', 'disc', 'square', 'diamond'], type).toContain(style.shape);
      expect(style.radius, type).toBeGreaterThan(0);
    }
  });

  it('keeps single-grave point records small and area records large', () => {
    // A national extract puts hundreds of grave points in one 4x4 km frame; big
    // symbols would smother both the terrain and each other.
    for (const type of GRAVE_POINT_TYPES) {
      expect(siteStyle(type).radius, type).toBeLessThanOrEqual(8);
      expect(siteStyle(type).radius, type).toBeGreaterThanOrEqual(7);
    }
    expect(siteStyle('Röjningsröse').radius).toBeLessThanOrEqual(8); // a single cairn is a point too
    for (const type of ['Fossil åker', 'Område med fossil åkermark', 'Röjningsröseområde', 'Terrassering']) {
      expect(siteStyle(type).radius, type).toBeGreaterThanOrEqual(10);
      expect(siteStyle(type).radius, type).toBeLessThanOrEqual(12);
    }
    // ...and the fort itself stays the biggest symbol on the map.
    for (const type of NEW_TYPES) {
      expect(siteStyle(type).radius, type).toBeLessThan(siteStyle('Fornborg').radius);
    }
  });

  it('groups the new types into the existing semantic colour families', () => {
    const colorsOf = (types: string[]) => new Set(types.map((t) => siteStyle(t).color));

    // Graves keep the red family they already had (at most one extra tone for the
    // stone-built forms), and share it with the committed gravfält style.
    const graves = colorsOf([...GRAVE_POINT_TYPES, 'Gravfält']);
    expect(graves.size).toBeLessThanOrEqual(2);
    expect(siteStyle('Hög').color).toBe(siteStyle('Gravfält').color);

    // Settlement evidence is one amber, cultivation evidence one green-brown, and
    // enclosures a single neutral — each family internally consistent...
    expect(colorsOf(SETTLEMENT_TYPES).size).toBe(1);
    expect(siteStyle('Skärvstenshög').color).toBe(siteStyle('Boplats').color);
    expect(colorsOf(CULTIVATION_TYPES).size).toBe(1);
    expect(colorsOf(ENCLOSURE_TYPES).size).toBe(1);

    // ...and mutually distinct, so the map reads as evidence families, not a rainbow.
    const families = [
      siteStyle('Gravfält').color,
      siteStyle('Boplats').color,
      siteStyle('Fossil åker').color,
      siteStyle('Hägnad').color,
      siteStyle('Färdväg').color,
      siteStyle('Runristning').color,
      siteStyle('Fornborg').color,
      siteStyle('Något helt annat').color,
    ];
    expect(new Set(families).size).toBe(families.length);
    expect(colorsOf(ROAD_TYPES).size).toBe(1); // roads were and stay one brown
  });
});

describe('densifyPath', () => {
  it('splits long segments to <= DRAPE_STEP meters', () => {
    const out = densifyPath(
      [
        [0, 0],
        [100, 0],
      ],
      DRAPE_STEP,
    );
    expect(out.length).toBe(21); // 100 m / 5 m + endpoint
    for (let i = 1; i < out.length; i++) {
      const d = Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]);
      expect(d).toBeLessThanOrEqual(DRAPE_STEP + 1e-9);
    }
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([100, 0]);
  });

  it('closes rings when asked (contract §3: closing segment implicit)', () => {
    const square: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const open = densifyPath(square, 5, false);
    const closed = densifyPath(square, 5, true);
    expect(open[open.length - 1]).toEqual([0, 10]);
    expect(closed[closed.length - 1]).toEqual([0, 0]); // back to the start
    expect(closed.length).toBeGreaterThan(open.length);
  });

  it('keeps short paths unchanged apart from copying', () => {
    const pts: Array<[number, number]> = [
      [0, 0],
      [1, 1],
    ];
    expect(densifyPath(pts, 5)).toEqual(pts);
  });
});
