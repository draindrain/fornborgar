/**
 * The archaeological-period table behind the year slider's readout.
 *
 * The tests are mostly about *coverage*: the slider can land anywhere, so every
 * year must produce exactly one name, with no gap to fall into.
 */

import { describe, expect, it } from 'vitest';

import { PERIODS, periodAt } from '../src/lib/periods';
import { formatYear } from '../src/water/shoreline';

describe('PERIODS', () => {
  it('is contiguous — each period starts exactly where the last one ended', () => {
    for (let i = 1; i < PERIODS.length; i++) {
      expect(PERIODS[i].fromYearCE).toBe(PERIODS[i - 1].toYearCE);
    }
  });

  it('is padded at both ends, so no finite year falls off it', () => {
    expect(PERIODS[0].fromYearCE).toBe(-Infinity);
    expect(PERIODS[PERIODS.length - 1].toYearCE).toBe(Infinity);
  });

  it('names every period in both languages', () => {
    for (const period of PERIODS) {
      expect(period.name.length).toBeGreaterThan(0);
      expect(period.swedish.length).toBeGreaterThan(0);
    }
  });
});

describe('periodAt', () => {
  it('places the boundary years on the later side, as the table declares', () => {
    expect(periodAt(-501).name).toBe('Bronze Age');
    expect(periodAt(-500).name).toBe('Pre-Roman Iron Age');
    expect(periodAt(-1).name).toBe('Pre-Roman Iron Age');
    expect(periodAt(0).name).toBe('Roman Iron Age');
    expect(periodAt(399).name).toBe('Roman Iron Age');
    expect(periodAt(400).name).toBe('Migration Period');
    expect(periodAt(549).name).toBe('Migration Period');
    expect(periodAt(550).name).toBe('Vendel Period');
    expect(periodAt(800).name).toBe('Viking Age');
    expect(periodAt(1050).name).toBe('Middle Ages');
  });

  it("puts Broborg's excavated date in the Migration Period", () => {
    // ~400–550 CE per the excavation literature, which is what methodsModel.ts
    // says in prose. If the table and the prose ever disagree, this catches it.
    expect(periodAt(400).name).toBe('Migration Period');
    expect(periodAt(500).name).toBe('Migration Period');
    expect(periodAt(549).name).toBe('Migration Period');
  });

  it('covers every year the shoreline sliders can reach, with no gap', () => {
    for (let year = -1200; year <= 1300; year++) {
      const period = periodAt(year);
      expect(period).toBeDefined();
      expect(year).toBeGreaterThanOrEqual(period.fromYearCE);
      expect(year).toBeLessThan(period.toYearCE);
    }
  });

  it('rounds a fractional year rather than falling between periods', () => {
    expect(periodAt(399.6).name).toBe('Migration Period');
    expect(periodAt(399.4).name).toBe('Roman Iron Age');
  });

  it('reads sensibly alongside the era formatter, including around year zero', () => {
    // yearCE 0 is 1 BCE, and the readout is built from both halves — the pairing
    // must not print "0 CE" or claim the Roman Iron Age started before it did.
    expect(`${formatYear(0)} · ${periodAt(0).name}`).toBe('1 BCE · Roman Iron Age');
    expect(`${formatYear(-1050)} · ${periodAt(-1050).name}`).toBe('1050 BCE · Bronze Age');
    expect(`${formatYear(1150)} · ${periodAt(1150).name}`).toBe('1150 CE · Middle Ages');
  });
});
