/**
 * The §6 shoreline table: validation, interpolation for continuous scrubbing,
 * and the two halves of the Phase-4 readout (year and meters above present sea).
 */

import { describe, expect, it } from 'vitest';

import {
  ShorelineError,
  formatLevel,
  formatReadout,
  formatYear,
  levelAt,
  validateShoreline,
  yearRange,
  type ShorelineTable,
} from '../src/water/shoreline';

function table(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    site: 'broborg',
    method: 'derived from the SGU strandförskjutningsmodell',
    uncertainty: 'SGU strandförskjutningsmodell: dating margins up to ±500 years.',
    steps: [
      { yearCE: -1050, bp: 3000, levelM: 17.1 },
      { yearCE: -950, bp: 2900, levelM: 16.1 },
      { yearCE: -850, bp: 2800, levelM: 15.1 },
      { yearCE: 1150, bp: 800, levelM: 4.2 },
    ],
    ...overrides,
  };
}

describe('shoreline table validation (contract §6)', () => {
  it('accepts the frozen v1 shape and keeps unknown keys', () => {
    const t = validateShoreline(table({ futureKey: 42 }));
    expect(t.steps).toHaveLength(4);
    expect(t.steps[0]).toEqual({ yearCE: -1050, bp: 3000, levelM: 17.1 });
    expect(t['futureKey']).toBe(42);
    expect(yearRange(t)).toEqual([-1050, 1150]);
  });

  it('hard-fails on a schemaVersion it does not know', () => {
    expect(() => validateShoreline(table({ schemaVersion: 2 }))).toThrow(ShorelineError);
    expect(() => validateShoreline(table({ schemaVersion: 2 }))).toThrow(/schemaVersion/);
  });

  it('requires at least two steps', () => {
    expect(() => validateShoreline(table({ steps: [{ yearCE: 0, levelM: 5 }] }))).toThrow(/at least 2/);
    expect(() => validateShoreline(table({ steps: [] }))).toThrow(/at least 2/);
    expect(() => validateShoreline(table({ steps: 'nope' }))).toThrow(/steps/);
  });

  it('requires strictly ascending yearCE', () => {
    const steps = [
      { yearCE: 100, levelM: 9 },
      { yearCE: 100, levelM: 8 },
    ];
    expect(() => validateShoreline(table({ steps }))).toThrow(/ascending/);
    steps[1].yearCE = 50;
    expect(() => validateShoreline(table({ steps }))).toThrow(/ascending/);
  });

  it('requires non-increasing levelM (post-glacial uplift only falls)', () => {
    const steps = [
      { yearCE: 0, levelM: 8 },
      { yearCE: 100, levelM: 8.1 },
    ];
    expect(() => validateShoreline(table({ steps }))).toThrow(/non-increasing/);
    // Equal levels are allowed.
    steps[1].levelM = 8;
    expect(validateShoreline(table({ steps })).steps).toHaveLength(2);
  });

  it('rejects non-finite numbers and non-objects', () => {
    expect(() => validateShoreline(table({ steps: [{ yearCE: 0, levelM: 'x' }, { yearCE: 1, levelM: 1 }] }))).toThrow(
      /levelM must be a finite number/,
    );
    expect(() =>
      validateShoreline(table({ steps: [{ yearCE: Number.NaN, levelM: 1 }, { yearCE: 1, levelM: 1 }] })),
    ).toThrow(/yearCE must be a finite number/);
    expect(() => validateShoreline(null)).toThrow(/must be a JSON object/);
    expect(() => validateShoreline([])).toThrow(/must be a JSON object/);
  });

  it('names the file it was reading in every message', () => {
    expect(() => validateShoreline(table({ schemaVersion: 9 }), 'shoreline.json')).toThrow(/^shoreline\.json:/);
  });
});

describe('levelAt (linear interpolation for continuous scrubbing, §6)', () => {
  const t: ShorelineTable = validateShoreline(table());

  it('returns the table value exactly at each step', () => {
    for (const step of t.steps) expect(levelAt(t, step.yearCE)).toBeCloseTo(step.levelM, 10);
  });

  it('interpolates linearly between adjacent steps', () => {
    expect(levelAt(t, -1000)).toBeCloseTo(16.6, 10); // halfway -1050 -> -950
    expect(levelAt(t, -975)).toBeCloseTo(16.35, 10); // a quarter of the way
    // Across the long -850 -> 1150 gap (2000 yr, 15.1 -> 4.2 m).
    expect(levelAt(t, 150)).toBeCloseTo(15.1 - 10.9 / 2, 10);
  });

  it('clamps outside the table extent instead of extrapolating', () => {
    expect(levelAt(t, -5000)).toBe(17.1);
    expect(levelAt(t, -1050)).toBe(17.1);
    expect(levelAt(t, 1150)).toBe(4.2);
    expect(levelAt(t, 9999)).toBe(4.2);
  });

  it('is monotone non-increasing across the whole range', () => {
    let previous = Infinity;
    for (let year = -1200; year <= 1300; year += 7) {
      const level = levelAt(t, year);
      expect(level).toBeLessThanOrEqual(previous + 1e-12);
      previous = level;
    }
  });
});

describe('readout formatting (PLAN §3 Phase 4: year AND meters above present)', () => {
  it('formats BCE and CE years, never a year zero', () => {
    expect(formatYear(-1050)).toBe('1050 BCE');
    expect(formatYear(-1)).toBe('1 BCE');
    expect(formatYear(0)).toBe('1 BCE'); // astronomical 0 = 1 BCE; no "0 CE"
    expect(formatYear(550)).toBe('550 CE');
    expect(formatYear(1150)).toBe('1150 CE');
    expect(formatYear(-450.4)).toBe('450 BCE'); // scrubbing lands between steps
  });

  it('formats the level as meters above present sea', () => {
    expect(formatLevel(8.44)).toBe('+8.4 m above present sea');
    expect(formatLevel(0)).toBe('+0.0 m above present sea');
    expect(formatLevel(-0.6)).toBe('-0.6 m above present sea');
  });

  it('shows both halves in the combined readout', () => {
    expect(formatReadout(-1050, 17.1)).toBe('1050 BCE · +17.1 m above present sea');
    expect(formatReadout(550, 8.25)).toBe('550 CE · +8.3 m above present sea');
  });
});
