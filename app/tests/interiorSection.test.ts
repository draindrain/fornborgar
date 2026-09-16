/**
 * Phase 13 §7.5: the interior selector's evidence, which is the half of the
 * feature that has to survive a screenshot.
 *
 * The section is what the selector's "Evidence" button opens, and the acceptance
 * criterion is that a visitor gets from the rendered houses to the sentence they
 * came from in one click. So these tests pin the citation rendering per channel —
 * all three, because Broborg's is a publication with no KMR sentence at all, and
 * an implementation that assumed a sentence would fail on the app's own reference
 * fort while passing every test written against Ismantorp.
 *
 * The control itself is asserted in the DOM by `scripts/verify-reconstruction.mjs`,
 * for the reason §0 of the brief gives: a check that only calls the state setter
 * would not notice a button that had stopped working.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildMethodsModel, interiorSection } from '../src/ui/methodsModel';
import { validateManifest } from '../src/state/manifest';
import { validateShoreline } from '../src/water/shoreline';
import { validateRampart } from '../src/overlays/palisade';
import { validateSites } from '../src/overlays/sites';
import { validateReconstruction } from '../src/overlays/reconstruction/schema';
import type { InteriorSpec } from '../src/overlays/reconstruction/schema';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'broborg');

async function loadBroborg() {
  const manifest = validateManifest(JSON.parse(await readFile(join(DATA, 'manifest.json'), 'utf8')));
  const shoreline = validateShoreline(
    JSON.parse(await readFile(join(DATA, 'shoreline.json'), 'utf8')),
    'shoreline.json',
  );
  const rampart = validateRampart(
    JSON.parse(await readFile(join(DATA, 'rampart.json'), 'utf8')),
    'rampart.json',
    manifest.grids.core.boundsLocal,
  );
  const sites = validateSites(JSON.parse(await readFile(join(DATA, 'sites.json'), 'utf8')));
  return { manifest, shoreline, rampart, sites };
}

const BASE: InteriorSpec = {
  state: 'cleared',
  settlementOffered: true,
  tradition: 'mainland',
  ground: { terrainWords: [], soilClass: 'sgu', clearedPatches: [], source: 'derived' },
  evidence: {
    rule: 'interior-strong-tier-2026-08-30',
    gate: 'pass',
    channels: ['description'],
    hedged: false,
    terms: ['husgrund'],
    citations: [],
  },
  buildings: null,
};

describe('interiorSection (§7.5.3 — the evidence behind the selector)', () => {
  it('quotes a channel-1 KMR sentence verbatim, with its lämningsnummer and matched term', () => {
    const sentence =
      'Innanför muren är 88 husgrunder, fördelade på två grupper, en yttre med husen radiellt ' +
      'utgående från murens insida.';
    const section = interiorSection({
      ...BASE,
      evidence: {
        ...BASE.evidence,
        citations: [
          {
            channel: 'description',
            lamningsnummer: 'L1957:426',
            term: 'husgrund',
            matched: 'husgrunder',
            hedged: false,
            sentence,
          },
        ],
      },
    });
    const text = section.paragraphs.join('\n');
    expect(section.id).toBe('interior');
    expect(section.badge).toBe('conjecture');
    // Verbatim, not paraphrased: the whole point of §7.5.3.
    expect(text).toContain(sentence);
    expect(text).toContain('L1957:426');
    expect(text).toContain('husgrunder');
  });

  it('marks a hedged fort as hedged rather than letting it read as a statement', () => {
    const text = interiorSection({
      ...BASE,
      evidence: {
        ...BASE.evidence,
        hedged: true,
        citations: [
          {
            channel: 'description',
            lamningsnummer: 'L1234:1',
            matched: 'husgrund',
            hedged: true,
            sentence: 'Möjlig husgrund i borgens inre.',
          },
        ],
      },
    }).paragraphs.join('\n');
    expect(text).toContain('hedge');
    expect(text).toContain('möjlig');
    expect(text).toContain('Möjlig husgrund i borgens inre.');
  });

  it('shows a channel-2 bbox test as the weaker one it is', () => {
    const text = interiorSection({
      ...BASE,
      evidence: {
        ...BASE.evidence,
        channels: ['settlement-record'],
        citations: [
          {
            channel: 'settlement-record',
            id: 'L1935:9444',
            lamningstyp: 'Husgrund, förhistorisk/medeltida',
            test: 'bbox',
          },
        ],
      },
    }).paragraphs.join('\n');
    expect(text).toContain('L1935:9444');
    expect(text).toContain('Husgrund, förhistorisk/medeltida');
    expect(text).toContain('BOUNDING-BOX');
    expect(text).toContain('reaches well outside the wall');
  });

  it('renders a channel-3 citation as a publication, with no KMR sentence claimed', () => {
    const text = interiorSection({
      ...BASE,
      evidence: {
        ...BASE.evidence,
        channels: ['cited'],
        terms: [],
        citations: [
          {
            channel: 'cited',
            reference: 'Englund 2018; Sjöblom et al. 2022',
            statement: 'Settlement layer inside the fort, 14C AD 432–542.',
            enteredBy: 'pipeline',
          },
        ],
      },
    }).paragraphs.join('\n');
    expect(text).toContain('Englund 2018; Sjöblom et al. 2022');
    expect(text).toContain('Settlement layer inside the fort, 14C AD 432–542.');
    expect(text).toContain('no lämningsnummer to give');
  });

  it('says a gate-passing fort with no stated buildings draws none', () => {
    const text = interiorSection({
      ...BASE,
      evidence: {
        ...BASE.evidence,
        channels: ['cited'],
        citations: [{ channel: 'cited', reference: 'Englund 2018', statement: 'x' }],
      },
      buildings: null,
    }).paragraphs.join('\n');
    expect(text).toContain('draws no houses');
    expect(text).toContain('will not supply a building the source does not');
  });

  it('keeps the section on a failed gate, and makes the failure a statement', () => {
    const text = interiorSection({
      ...BASE,
      settlementOffered: false,
      evidence: {
        ...BASE.evidence,
        gate: 'fail',
        channels: [],
        terms: [],
        citations: [],
        discarded: { negated: 1, exterior: 2, nonbuildingTerrass: 0, modern: 0 },
      },
    }).paragraphs.join('\n');
    expect(text).toContain('not offered on this fort at all');
    expect(text).toContain('No citation, and therefore no state');
    expect(text).toContain('2 placed outside the enclosure');
    expect(text).toContain('1 negated by its own sentence');
    // The refusal is explained, not merely applied (§7.5.3's three reasons).
    expect(text).toContain('not offered behind a');
  });

  it('never lets "cleared" be read as "nobody was here" (§7.5.1)', () => {
    const text = interiorSection(BASE).paragraphs.join('\n');
    expect(text).toContain('nobody was here');
    expect(text).toContain('AD 432–542');
    expect(text).toContain('absence of a surveyor');
  });

  it('names the §6.H defaults a stated record did not override', () => {
    const text = interiorSection({
      ...BASE,
      buildings: {
        count: 88,
        countSource: 'measured',
        countStated: true,
        layout: 'radial',
        groups: 2,
        sector: 'S',
        template: null,
        fallbacks: ['buildings.template.lengthM'],
        source: 'measured',
      },
    }).paragraphs.join('\n');
    expect(text).toContain('88 buildings, a count the source states');
    expect(text).toContain('radially against the inner wall face');
    expect(text).toContain('S part of the interior');
    expect(text).toContain('buildings.template.lengthM');
    expect(text).toContain('upper bound');
  });

  it('names the ringfort branch, its blocks, its street and what it does not draw', () => {
    // §7.5.2, in the panel rather than only in the geometry: the branch is a
    // layout, not a lower bar for evidence; the four blocks and the 2–5 m street
    // are the register's own; and the record calls the inner group "mer
    // oregelbunden" while the app draws it regular, which the panel has to own
    // rather than leave the picture to imply.
    const text = interiorSection({
      ...BASE,
      tradition: 'limestone-ringfort',
      buildings: {
        count: 88,
        countSource: 'measured',
        countStated: true,
        layout: 'radial',
        groups: 2,
        blocks: 4,
        streetWidthM: [2, 5],
        sector: null,
        template: null,
        fallbacks: [],
        source: 'measured',
      },
    }).paragraphs.join('\n');
    expect(text).toContain('limestone ringfort');
    expect(text).toContain('radial blocks against the inner wall face');
    expect(text).toContain('never a lower bar for evidence');
    expect(text).toContain('4 blocks');
    expect(text).toContain('2–5 m the register measures');
    expect(text).toContain('mer oregelbunden');
  });

  it('says so when a ringfort’s street between the groups is an assumption', () => {
    const text = interiorSection({
      ...BASE,
      tradition: 'limestone-ringfort',
      buildings: {
        count: 50,
        countSource: 'measured',
        countStated: true,
        layout: 'radial',
        groups: 2,
        blocks: null,
        streetWidthM: null,
        sector: null,
        template: null,
        fallbacks: ['buildings.streetWidthM'],
        source: 'measured',
      },
    }).paragraphs.join('\n');
    expect(text).toContain('measures no street between the groups');
    expect(text).toContain('buildings.streetWidthM');
    expect(text).not.toContain('blocks by streets');
  });

  it('says nothing about a street where there is only one group — Eketorp', () => {
    // Its record counts ~75 house foundations and states no grouping, no street
    // plan and no house size the parser can reach, so the paragraph names the
    // §6.H default and claims nothing about a gap between groups it has not got.
    const text = interiorSection({
      ...BASE,
      tradition: 'limestone-ringfort',
      buildings: {
        count: 75,
        countSource: 'measured',
        countStated: true,
        layout: 'radial',
        groups: null,
        blocks: null,
        streetWidthM: null,
        sector: null,
        template: null,
        fallbacks: ['buildings.template.lengthM', 'buildings.template.widthM'],
        source: 'measured',
      },
    }).paragraphs.join('\n');
    expect(text).toContain('limestone ringfort');
    expect(text).toContain('75 buildings, a count the source states');
    expect(text).toContain('buildings.template.lengthM');
    expect(text).toContain('20–40 m default');
    expect(text).not.toContain('street between the groups');
    expect(text).not.toContain('blocks by streets');
  });

  it('leaves a mainland fort’s paragraph alone', () => {
    // The same buildings block, carrying the same street plan, on a mainland
    // fort: none of §7.5.2's sentences may appear.
    const text = interiorSection({
      ...BASE,
      buildings: {
        count: 88,
        countSource: 'measured',
        countStated: true,
        layout: 'radial',
        groups: 2,
        blocks: 4,
        streetWidthM: [2, 5],
        sector: null,
        template: null,
        fallbacks: [],
        source: 'measured',
      },
    }).paragraphs.join('\n');
    expect(text).toContain('radially against the inner wall face');
    expect(text).not.toContain('limestone ringfort');
    expect(text).not.toContain('4 blocks');
  });

  it('is present for the real Broborg bundle, badged conjecture, via buildMethodsModel', async () => {
    const { manifest, shoreline, rampart, sites } = await loadBroborg();
    const reconstruction = validateReconstruction(
      JSON.parse(await readFile(join(DATA, 'reconstruction.json'), 'utf8')),
      'reconstruction.json',
    );
    const model = buildMethodsModel(manifest, shoreline, rampart, sites, null, reconstruction);
    const section = model.sections.find((s) => s.id === 'interior');
    expect(section).toBeDefined();
    expect(section!.badge).toBe('conjecture');
    const text = section!.paragraphs.join('\n');
    // Broborg's own citation, verbatim, on channel 3 — a reference and a
    // statement, with no KMR sentence and no lämningsnummer anywhere in it.
    expect(text).toContain('Englund 2018; Sjöblom et al. 2022');
    expect(text).toContain('Olausson 1997:110');
    expect(text).toContain('draws no houses');
    // And the ground words the register did give, in its own words.
    expect(text).toContain('berg i dagen');
  });

  it('omits the section for a site that ships no interior block', async () => {
    const { manifest, shoreline, rampart, sites } = await loadBroborg();
    const model = buildMethodsModel(manifest, shoreline, rampart, sites);
    expect(model.sections.map((s) => s.id)).not.toContain('interior');
  });
});
