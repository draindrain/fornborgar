/**
 * The national site picker (docs/national-scaleout.md §6) — model and search.
 *
 * The DOM half needs a browser; what is testable in Node is the part that would
 * quietly mislead someone: the index validation (a dot must never point at a
 * bundle that is not there), the projection (a dot in the wrong place is a lie
 * about where a fort is), and the search (a Swedish dataset has to be findable
 * from a keyboard without å/ä/ö).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  matchesQuery,
  validateEntry,
  validateSiteIndex,
  SiteIndexError,
  type SiteIndexEntry,
} from '../src/state/siteIndex';
import { MAP_BOUNDS, MAP_HEIGHT, badgeText, filterSites, projectToMap, rankResults } from '../src/ui/sitePicker';

function entry(overrides: Partial<SiteIndexEntry> = {}): SiteIndexEntry {
  return {
    slug: 'l1943-7827',
    name: 'Broborg',
    lamningsnummer: 'L1943:7827',
    county: 'Uppsala',
    kommun: 'Knivsta',
    centerE: 665810,
    centerN: 6627880,
    antikvariskBedomning: 'Fornlämning',
    extentPreset: 'standard',
    features: { water: true, palisade: true, landcover: false, rings: 4 },
    horizonKm: 24.8,
    bytes: 9_500_000,
    thumbnail: 'l1943-7827/thumbnail.png',
    fornsokUrl: 'https://pub.raa.se/visa/objekt/lamning/184ca0f6',
    ...overrides,
  };
}

function index(sites: SiteIndexEntry[]) {
  return { schemaVersion: 1, generated: '2026-08-22', count: sites.length, totalRegistered: 1304, sites };
}

// ------------------------------- validation ---------------------------------

describe('site index validation (§6.1)', () => {
  it('accepts a well-formed index', () => {
    const parsed = validateSiteIndex({
      schemaVersion: 1,
      generated: '2026-08-22',
      registry: { totalRegistered: 1304 },
      sites: [entry()],
    });
    expect(parsed.count).toBe(1);
    expect(parsed.totalRegistered).toBe(1304);
    expect(parsed.sites[0].name).toBe('Broborg');
  });

  it('rejects an index of the wrong schema version', () => {
    expect(() => validateSiteIndex({ schemaVersion: 2, sites: [] })).toThrow(SiteIndexError);
  });

  it('rejects something that is not an index at all', () => {
    expect(() => validateSiteIndex(null)).toThrow(SiteIndexError);
    expect(() => validateSiteIndex({ schemaVersion: 1 })).toThrow(/sites array/);
  });

  it('drops an entry whose slug could not be a bundle path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(validateEntry({ slug: '../secrets', centerE: 1, centerN: 2 }, 0)).toBeNull();
    expect(validateEntry({ slug: '', centerE: 1, centerN: 2 }, 0)).toBeNull();
    warn.mockRestore();
  });

  it('drops an entry with no usable centre rather than plotting it at zero', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(validateEntry({ slug: 'ok', centerE: 'x', centerN: 2 }, 0)).toBeNull();
    warn.mockRestore();
  });

  it('keeps the good entries when one is broken', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = validateSiteIndex({
      schemaVersion: 1,
      sites: [entry(), { slug: '/bad' }, entry({ slug: 'l1976-4254', name: 'Torsburgen' })],
    });
    expect(parsed.sites.map((s) => s.slug)).toEqual(['l1943-7827', 'l1976-4254']);
    expect(parsed.count).toBe(2);
    warn.mockRestore();
  });

  it('defaults missing optional fields instead of failing', () => {
    const parsed = validateEntry({ slug: 'l1', centerE: 1, centerN: 2 }, 0)!;
    expect(parsed.name).toBe('l1');
    expect(parsed.features).toEqual({ water: false, palisade: false, landcover: false, rings: 0 });
    expect(parsed.horizonKm).toBeNull();
  });
});

// -------------------------------- projection --------------------------------

describe('dot map projection', () => {
  it('puts the south-west corner bottom-left and north up', () => {
    const sw = projectToMap(MAP_BOUNDS.minE, MAP_BOUNDS.minN);
    const ne = projectToMap(MAP_BOUNDS.maxE, MAP_BOUNDS.maxN);
    expect(sw.x).toBeCloseTo(0);
    expect(ne.y).toBeCloseTo(0);
    expect(sw.y).toBeGreaterThan(ne.y);
    expect(ne.x).toBeGreaterThan(sw.x);
  });

  it('keeps the aspect ratio of the country', () => {
    const eastWestM = MAP_BOUNDS.maxE - MAP_BOUNDS.minE;
    const southNorthM = MAP_BOUNDS.maxN - MAP_BOUNDS.minN;
    const sw = projectToMap(MAP_BOUNDS.minE, MAP_BOUNDS.minN);
    const ne = projectToMap(MAP_BOUNDS.maxE, MAP_BOUNDS.maxN);
    const drawn = (sw.y - ne.y) / (ne.x - sw.x);
    expect(drawn).toBeCloseTo(southNorthM / eastWestM, 1);
    expect(MAP_HEIGHT).toBeGreaterThan(0);
  });

  it('places a northern site above a southern one', () => {
    const kiruna = projectToMap(700_000, 7_530_000);
    const gotland = projectToMap(700_000, 6_380_000);
    expect(kiruna.y).toBeLessThan(gotland.y);
  });
});

// ---------------------------------- search ----------------------------------

describe('search', () => {
  it('matches on name, county, kommun and lämningsnummer', () => {
    const site = entry();
    for (const query of ['broborg', 'Uppsala', 'knivsta', 'L1943:7827', 'l1943-7827']) {
      expect(matchesQuery(site, query)).toBe(true);
    }
    expect(matchesQuery(site, 'Torsburgen')).toBe(false);
  });

  it('is findable without a Swedish keyboard', () => {
    const site = entry({ name: 'Gråborg', county: 'Södermanland' });
    expect(matchesQuery(site, 'graborg')).toBe(true);
    expect(matchesQuery(site, 'sodermanland')).toBe(true);
    // ...and still works when you do have one.
    expect(matchesQuery(site, 'Gråborg')).toBe(true);
  });

  it('treats an empty query as "everything"', () => {
    expect(matchesQuery(entry(), '')).toBe(true);
    expect(matchesQuery(entry(), '   ')).toBe(true);
  });

  it('ranks an exact name match above a substring one', () => {
    const ranked = rankResults(
      [entry({ slug: 'a', name: 'Gamla Borgen' }), entry({ slug: 'b', name: 'Borgen' })],
      'borgen',
    );
    expect(ranked.map((r) => r.slug)).toEqual(['b', 'a']);
  });

  it('sorts an unfiltered list by county then name', () => {
    const ranked = rankResults(
      [
        entry({ slug: 'a', name: 'Zeta', county: 'Uppsala' }),
        entry({ slug: 'b', name: 'Alfa', county: 'Uppsala' }),
        entry({ slug: 'c', name: 'Mitten', county: 'Gotland' }),
      ],
      '',
    );
    expect(ranked.map((r) => r.slug)).toEqual(['c', 'b', 'a']);
  });

  it('caps the rendered result list', () => {
    const many = Array.from({ length: 500 }, (_, i) => entry({ slug: `l${i}`, name: `Fort ${i}` }));
    expect(filterSites(index(many), '', 200)).toHaveLength(200);
  });
});

// --------------------------------- badges -----------------------------------

describe('badges', () => {
  it('stays quiet about the ordinary grading', () => {
    // 94 % of the register is "Fornlämning"; saying so on every row is noise
    // that hides the rows where the grading actually matters.
    expect(badgeText(entry())).toBe('Uppsala · water');
  });

  it('surfaces a grading that qualifies the claim', () => {
    const badge = badgeText(entry({ antikvariskBedomning: 'Möjlig fornlämning', features: { water: false, palisade: false, landcover: false, rings: 0 } }));
    expect(badge).toContain('Möjlig fornlämning');
  });

  it('flags the large-preset outliers', () => {
    expect(badgeText(entry({ extentPreset: 'large' }))).toContain('large');
  });
});
