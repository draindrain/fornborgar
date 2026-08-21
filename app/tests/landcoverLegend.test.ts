/**
 * `landcover_legend.json` validation (contract §10).
 *
 * The legend is the authority on what the §9 raster means *and* the only place the
 * model's own words live — method, per-class rules, calibration, caveat — so a
 * malformed one must be refused with a message naming the field rather than
 * half-loaded into a panel that then paraphrases nothing.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AREA_FRACTION_TOLERANCE,
  DYNAMIC_KINDS,
  LandcoverError,
  MAX_CLASSES,
  dynamicClass,
  staticVegetationClasses,
  validateLandcoverLegend,
  vegetationClasses,
} from '../src/landcover/legend';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'testsite');
const testsiteLegend: unknown = JSON.parse(await readFile(join(DIR, 'landcover_legend.json'), 'utf8'));

const base = () => JSON.parse(JSON.stringify(testsiteLegend)) as Record<string, unknown>;
const classes = (doc: Record<string, unknown>) => doc['classes'] as Record<string, unknown>[];

describe('landcover_legend.json validation (contract §10)', () => {
  it('accepts the committed testsite legend', () => {
    const legend = validateLandcoverLegend(testsiteLegend, 'landcover_legend.json');
    expect(legend.schemaVersion).toBe(1);
    expect(legend.classes.length).toBeGreaterThanOrEqual(3);
    expect(legend.classes.length).toBeLessThanOrEqual(MAX_CLASSES);
    // Contiguous indices from 0, in order.
    expect(legend.classes.map((c) => c.index)).toEqual(legend.classes.map((_, i) => i));
    // The three verbatim texts the methods panel needs.
    expect(legend.method).not.toBe('');
    expect(legend.caveat).not.toBe('');
    expect(legend.calibration).not.toBe('');
    // Every class states the rule that produced it.
    expect(legend.classes.every((c) => c.rule.length > 0)).toBe(true);
    // areaFraction sums to 1 within the contract's tolerance.
    const sum = legend.classes.reduce((n, c) => n + (c.areaFraction ?? 0), 0);
    expect(Math.abs(sum - 1)).toBeLessThanOrEqual(AREA_FRACTION_TOLERANCE);
  });

  it('exercises all three vegetation forms plus classes with none', () => {
    const legend = validateLandcoverLegend(testsiteLegend);
    // A set, not a list: since v1.3 the fixture may carry a *dynamic* reeds class
    // alongside a static one, and what matters is that all three forms occur.
    const types = new Set(vegetationClasses(legend).map((c) => c.vegetation.type));
    expect([...types].sort()).toEqual(['broadleaf', 'conifer', 'reeds']);
    expect(legend.classes.some((c) => c.vegetation === null)).toBe(true);
    for (const c of vegetationClasses(legend)) expect(c.vegetation.densityPerHa).toBeGreaterThan(0);
  });

  it.each([
    ['a non-object', 42, /must be a JSON object/],
    [
      'an unknown schemaVersion',
      (() => {
        const doc = base();
        doc['schemaVersion'] = 2;
        return doc;
      })(),
      /unsupported schemaVersion/,
    ],
    [
      'a missing method',
      (() => {
        const doc = base();
        delete doc['method'];
        return doc;
      })(),
      /method must be a non-empty string/,
    ],
    [
      'an empty caveat',
      (() => {
        const doc = base();
        doc['caveat'] = '';
        return doc;
      })(),
      /caveat must be a non-empty string/,
    ],
    [
      'a missing calibration',
      (() => {
        const doc = base();
        delete doc['calibration'];
        return doc;
      })(),
      /calibration must be a non-empty string/,
    ],
    [
      'a non-integer referenceYearCE',
      (() => {
        const doc = base();
        doc['referenceYearCE'] = 500.5;
        return doc;
      })(),
      /referenceYearCE must be an integer/,
    ],
    [
      'a missing referenceLevelM',
      (() => {
        const doc = base();
        delete doc['referenceLevelM'];
        return doc;
      })(),
      /referenceLevelM must be a finite number/,
    ],
    [
      'no classes',
      (() => {
        const doc = base();
        doc['classes'] = [];
        return doc;
      })(),
      /classes must be a non-empty array/,
    ],
    [
      'non-contiguous class indices',
      (() => {
        const doc = base();
        classes(doc)[2]['index'] = 7;
        return doc;
      })(),
      /contiguous from 0/,
    ],
    [
      'duplicate class ids',
      (() => {
        const doc = base();
        classes(doc)[1]['id'] = classes(doc)[0]['id'];
        return doc;
      })(),
      /duplicate class id/,
    ],
    [
      'a colour that is not #rrggbb',
      (() => {
        const doc = base();
        classes(doc)[0]['color'] = 'seagreen';
        return doc;
      })(),
      /must be an "#rrggbb" sRGB hex/,
    ],
    [
      'a class with no rule',
      (() => {
        const doc = base();
        classes(doc)[0]['rule'] = '';
        return doc;
      })(),
      /rule must be a non-empty string/,
    ],
    [
      'an unknown vegetation type',
      (() => {
        const doc = base();
        classes(doc)[1]['vegetation'] = { type: 'mangrove', densityPerHa: 10 };
        return doc;
      })(),
      /vegetation.type "mangrove" is not one of/,
    ],
    [
      'a non-positive densityPerHa',
      (() => {
        const doc = base();
        classes(doc)[1]['vegetation'] = { type: 'reeds', densityPerHa: 0 };
        return doc;
      })(),
      /densityPerHa must be > 0/,
    ],
    [
      'areaFraction entries that do not sum to 1',
      (() => {
        const doc = base();
        classes(doc)[0]['areaFraction'] = 0.5;
        return doc;
      })(),
      /areaFraction entries sum to/,
    ],
    [
      'areaFraction on only some classes',
      (() => {
        const doc = base();
        delete classes(doc)[0]['areaFraction'];
        return doc;
      })(),
      /give it for all of them or none/,
    ],
    [
      'more than 32 classes',
      (() => {
        const doc = base();
        const template = classes(doc)[classes(doc).length - 1];
        const many = Array.from({ length: MAX_CLASSES + 1 }, (_, i) => ({
          ...JSON.parse(JSON.stringify(template)),
          index: i,
          id: `c${i}`,
          areaFraction: undefined,
        }));
        doc['classes'] = many;
        return doc;
      })(),
      /exceeds the 32-class limit/,
    ],
  ])('rejects %s', (_label, input, message) => {
    expect(() => validateLandcoverLegend(input, 'landcover_legend.json')).toThrow(LandcoverError);
    expect(() => validateLandcoverLegend(input, 'landcover_legend.json')).toThrow(message as RegExp);
  });

  it('accepts a legend with no areaFraction at all (the field is informational)', () => {
    const doc = base();
    for (const c of classes(doc)) delete c['areaFraction'];
    expect(() => validateLandcoverLegend(doc)).not.toThrow();
  });

  it('tolerates unknown extra keys (forward compatibility)', () => {
    const doc = base();
    doc['futureKey'] = { anything: true };
    classes(doc)[0]['futureClassKey'] = 7;
    const legend = validateLandcoverLegend(doc);
    expect(legend['futureKey']).toEqual({ anything: true });
    expect(legend.classes[0]['futureClassKey']).toBe(7);
  });
});

// ------------------------------------------- v1.3: the `dynamic` marker -----

/**
 * A self-contained v1.3 legend, so these cases stay independent of whatever the
 * committed testsite fixture happens to declare.
 */
const dynamicDoc = () => ({
  schemaVersion: 1,
  referenceYearCE: 500,
  referenceLevelM: 8.6,
  method: 'm',
  caveat: 'c',
  calibration: 'cal',
  classes: [
    {
      index: 0,
      id: 'water',
      name: 'Open water',
      color: '#2d5a6b',
      rule: 'SGU Vatten, plus the runtime sea',
      vegetation: null,
      dynamic: { kind: 'water' },
      areaFraction: 0.1,
    },
    {
      index: 1,
      id: 'peat_fen',
      name: 'Peat fen',
      color: '#7f9455',
      rule: 'peat/gyttja',
      vegetation: { type: 'reeds', densityPerHa: 400 },
      areaFraction: 0.9,
    },
    {
      index: 2,
      id: 'shore_reeds',
      name: 'Shore reed belt',
      color: '#77875a',
      rule: 'derived by the app at the current level',
      vegetation: { type: 'reeds', densityPerHa: 500 },
      dynamic: { kind: 'shore-band', bandM: 0.6 },
      areaFraction: 0, // runtime-only class: no cells in the raster
    },
  ] as Record<string, unknown>[],
});

describe('landcover_legend.json dynamic classes (contract §10 v1.3)', () => {
  it('accepts a legend with both dynamic kinds', () => {
    const legend = validateLandcoverLegend(dynamicDoc());
    expect(legend.classes[0].dynamic).toEqual({ kind: 'water' });
    expect(legend.classes[2].dynamic).toEqual({ kind: 'shore-band', bandM: 0.6 });
    // A purely-runtime class carries areaFraction 0 and still sums to 1 (§10).
    expect(legend.classes[2].areaFraction).toBe(0);
  });

  it('treats an absent, null or omitted marker as a fully static class', () => {
    const doc = dynamicDoc();
    delete doc.classes[0]['dynamic'];
    doc.classes[2]['dynamic'] = null;
    const legend = validateLandcoverLegend(doc);
    // Absent stays absent, an explicit null stays null — both read as "static".
    expect(legend.classes[0].dynamic).toBeUndefined();
    expect(legend.classes[2].dynamic).toBeNull();
    expect(staticVegetationClasses(legend).map((c) => c.id)).toEqual(['peat_fen', 'shore_reeds']);
    expect(dynamicClass(legend, 'water')).toBeNull();
    expect(dynamicClass(legend, 'shore-band')).toBeNull();
  });

  it.each([
    [
      'an unknown dynamic kind',
      () => {
        const doc = dynamicDoc();
        doc.classes[0]['dynamic'] = { kind: 'lake' };
        return doc;
      },
      /dynamic\.kind "lake" is not one of/,
    ],
    [
      'a shore band with bandM = 0',
      () => {
        const doc = dynamicDoc();
        doc.classes[2]['dynamic'] = { kind: 'shore-band', bandM: 0 };
        return doc;
      },
      /dynamic\.bandM must be a finite number > 0/,
    ],
    [
      'a shore band with a negative bandM',
      () => {
        const doc = dynamicDoc();
        doc.classes[2]['dynamic'] = { kind: 'shore-band', bandM: -0.6 };
        return doc;
      },
      /dynamic\.bandM must be a finite number > 0/,
    ],
    [
      'a shore band with no bandM at all',
      () => {
        const doc = dynamicDoc();
        doc.classes[2]['dynamic'] = { kind: 'shore-band' };
        return doc;
      },
      /dynamic\.bandM must be a finite number > 0/,
    ],
    [
      'a water class carrying bandM',
      () => {
        const doc = dynamicDoc();
        doc.classes[0]['dynamic'] = { kind: 'water', bandM: 0.6 };
        return doc;
      },
      /dynamic\.bandM is only allowed on kind "shore-band"/,
    ],
    [
      'two classes of the same dynamic kind',
      () => {
        const doc = dynamicDoc();
        doc.classes[1]['dynamic'] = { kind: 'water' };
        return doc;
      },
      /more than one class with dynamic\.kind "water"/,
    ],
    [
      'a dynamic marker that is not an object',
      () => {
        const doc = dynamicDoc();
        doc.classes[0]['dynamic'] = 'water';
        return doc;
      },
      /dynamic must be an object or absent/,
    ],
  ])('rejects %s', (_label, make, message) => {
    expect(() => validateLandcoverLegend(make(), 'landcover_legend.json')).toThrow(LandcoverError);
    expect(() => validateLandcoverLegend(make(), 'landcover_legend.json')).toThrow(message as RegExp);
  });

  it('finds each dynamic class by kind, and only its own kind', () => {
    const legend = validateLandcoverLegend(dynamicDoc());
    expect(DYNAMIC_KINDS).toEqual(['water', 'shore-band']);
    expect(dynamicClass(legend, 'water')?.id).toBe('water');
    expect(dynamicClass(legend, 'shore-band')?.id).toBe('shore_reeds');
    expect(dynamicClass(legend, 'shore-band')?.dynamic?.bandM).toBe(0.6);
  });

  it('keeps dynamic classes out of the raster-sampled vegetation set', () => {
    const legend = validateLandcoverLegend(dynamicDoc());
    // Both reed classes carry vegetation…
    expect(vegetationClasses(legend).map((c) => c.id)).toEqual(['peat_fen', 'shore_reeds']);
    // …but only the static one is sampled from the raster (§9 v1.3).
    expect(staticVegetationClasses(legend).map((c) => c.id)).toEqual(['peat_fen']);
  });

  it('leaves a pre-v1.3 legend entirely static', () => {
    const legend = validateLandcoverLegend(testsiteLegend);
    const dynamicIds = legend.classes.filter((c) => c.dynamic).map((c) => c.id);
    // Whatever the committed fixture declares, the two helper views must agree with
    // it: static = vegetated minus dynamic, and each kind resolves at most once.
    expect(staticVegetationClasses(legend).map((c) => c.id)).toEqual(
      vegetationClasses(legend).filter((c) => !c.dynamic).map((c) => c.id),
    );
    for (const kind of DYNAMIC_KINDS) {
      const found = dynamicClass(legend, kind);
      if (found) expect(dynamicIds).toContain(found.id);
    }
  });
});
