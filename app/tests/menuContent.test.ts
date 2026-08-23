/**
 * The kebab menu's copy (ui/menuContent.ts).
 *
 * The point of these is the attribution. Lantmäteriet's elevation data is CC BY,
 * so the credit line is a condition of use — and the 2026-08-23b amendment moved
 * it off the screen it used to live on. A test that walks it back out of
 * `manifest.attribution` is what stops it quietly disappearing next time the
 * chrome is rearranged.
 */

import { describe, expect, it } from 'vitest';
import { buildAboutModel, formatExaggeration, PROVENANCE_SUMMARY } from '../src/ui/menuContent';
import type { AttributionEntry } from '../src/state/manifest';

const ATTRIBUTION: AttributionEntry[] = [
  { text: 'Höjddata: © Lantmäteriet, Markhöjdmodell Nedladdning (CC BY 4.0)', license: 'CC BY 4.0', url: 'https://www.lantmateriet.se' },
  { text: 'Fornlämningsinformation från Riksantikvarieämbetet, Kulturmiljöregistret (CC0)', license: 'CC0' },
  { text: 'Jordarts- och strandförskjutningsdata från Sveriges geologiska undersökning (CC0)', license: 'CC0' },
];

const BASE = {
  siteName: 'Broborg',
  siteDescription: 'Ground elevation model — 2 km square at 1 m, 4 km context at 2 m.',
  exaggeration: 1.5,
  attribution: ATTRIBUTION,
};

describe('buildAboutModel', () => {
  it('carries every attribution entry through verbatim', () => {
    const model = buildAboutModel(BASE);
    expect(model.attribution).toEqual(ATTRIBUTION);
    // The CC BY line specifically: it is the one that is a licence condition.
    expect(model.attribution.some((a) => /Lantmäteriet/.test(a.text))).toBe(true);
  });

  it('names the site and repeats the site description', () => {
    const model = buildAboutModel(BASE);
    expect(model.title).toContain('Broborg');
    expect(model.paragraphs).toContain(BASE.siteDescription);
  });

  it('states the provenance summary — measured terrain, modelled water, conjectural palisade', () => {
    const model = buildAboutModel(BASE);
    expect(model.paragraphs).toContain(PROVENANCE_SUMMARY);
    expect(PROVENANCE_SUMMARY).toMatch(/measured/i);
    expect(PROVENANCE_SUMMARY).toMatch(/modelled/i);
    expect(PROVENANCE_SUMMARY).toMatch(/conjectural/i);
  });

  it('states the vertical exaggeration whenever it is not 1 (PLAN §6.1)', () => {
    const model = buildAboutModel(BASE);
    expect(model.paragraphs.some((p) => p.includes('×1.5'))).toBe(true);
  });

  it('says nothing about exaggeration at ×1 — there is nothing to disclose', () => {
    const model = buildAboutModel({ ...BASE, exaggeration: 1 });
    expect(model.paragraphs.some((p) => /exaggeration/i.test(p))).toBe(false);
  });

  it('survives a manifest with no attribution block', () => {
    const model = buildAboutModel({ ...BASE, attribution: [] });
    expect(model.attribution).toEqual([]);
    expect(model.paragraphs.length).toBeGreaterThan(0);
  });
});

describe('formatExaggeration', () => {
  it('trims trailing zeros', () => {
    expect(formatExaggeration(1.5)).toBe('×1.5');
    expect(formatExaggeration(2)).toBe('×2');
    expect(formatExaggeration(1.25)).toBe('×1.25');
  });
});
