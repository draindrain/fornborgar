/**
 * Phase-6 methods panel content: the PLAN §6.2 disclosures must survive edits.
 * These tests pin the load-bearing sentences — what the terrain is NOT, dating
 * honesty, the palisade's evidentiary status — and that data-derived text is
 * passed through verbatim rather than paraphrased.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildMethodsModel, REPOSITORY_URL } from '../src/ui/methodsModel';
import { validateManifest } from '../src/state/manifest';
import { validateShoreline } from '../src/water/shoreline';
import { validateRampart } from '../src/overlays/palisade';
import { validateSites } from '../src/overlays/sites';
import { validateLandcoverLegend } from '../src/landcover/legend';

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

describe('buildMethodsModel (§6.2 disclosures)', () => {
  it('carries every required disclosure for the full Broborg site', async () => {
    const { manifest, shoreline, rampart, sites } = await loadBroborg();
    const model = buildMethodsModel(manifest, shoreline, rampart, sites);
    const all = model.sections.flatMap((s) => s.paragraphs).join('\n');

    // Terrain: what it is and what it is NOT.
    expect(all).toContain('RH 2000');
    expect(all).toContain('NOT an Iron Age surface');
    // Dating honesty.
    expect(all).toContain('typisk datering');
    expect(all).toContain('400–550 CE');
    // Shoreline: the pipeline's own derivation text, verbatim.
    expect(all).toContain(shoreline.method!);
    expect(all).toContain('±500');
    // Palisade status + the pipeline's derivation text, verbatim.
    expect(all).toContain('No palisade has been excavated at Broborg');
    expect(all).toContain(rampart!.derivation.description);
    // Viewshed algorithm statement (§6.1).
    expect(all).toContain('XDraw');
    expect(all).toContain('k = 0.13');
    // Exaggeration indicator rule.
    expect(all).toContain('render-only');

    expect(model.repositoryUrl).toBe(REPOSITORY_URL);
    expect(model.citations.length).toBeGreaterThanOrEqual(5);
    expect(model.citations.join('\n')).toContain('Påsse');
  });

  it('badges sections from manifest.layers provenance', async () => {
    const { manifest, shoreline, rampart, sites } = await loadBroborg();
    const model = buildMethodsModel(manifest, shoreline, rampart, sites);
    const byId = Object.fromEntries(model.sections.map((s) => [s.id, s.badge]));
    expect(byId['terrain']).toBe('measured');
    expect(byId['sites']).toBe('measured');
    expect(byId['water']).toBe('model');
    expect(byId['palisade']).toBe('conjecture');
  });

  it('omits sections for assets a site does not ship', async () => {
    const { manifest } = await loadBroborg();
    const model = buildMethodsModel(manifest, null, null, null);
    const ids = model.sections.map((s) => s.id);
    expect(ids).toContain('terrain');
    expect(ids).toContain('viewshed');
    expect(ids).not.toContain('water');
    expect(ids).not.toContain('palisade');
    expect(ids).not.toContain('sites');
  });
});

/**
 * A stand-in legend rather than Broborg's own file: the land-cover pair is optional
 * (contract v1.2 is additive), so this test must not require the pipeline to have
 * shipped it yet. The texts are distinctive on purpose — the assertions below are
 * about *verbatim passthrough*, so a paraphrase anywhere would show up as a miss.
 */
const LANDCOVER_LEGEND = validateLandcoverLegend({
  schemaVersion: 1,
  site: 'broborg',
  referenceYearCE: 500,
  referenceLevelM: 8.6,
  method: 'RULE-ENGINE METHOD SENTENCE: soils crossed with height above the modelled shoreline.',
  caveat: 'CAVEAT SENTENCE: a rule model of one century, not a survey of past vegetation.',
  calibration: 'CALIBRATION SENTENCE: 62 % forest against the regional pollen record.',
  source: { product: 'SGU Jordarter 1:25 000–1:100 000', fetched: '2026-08-21' },
  classes: [
    { index: 0, id: 'water', name: 'Water (sea, ~500 CE)', color: '#2d5a6b', rule: 'RULE ZERO: connect <= 8.6 m.', vegetation: null },
    {
      index: 1,
      id: 'reeds',
      name: 'Reed bed',
      color: '#7f9455',
      rule: 'RULE ONE: the shore band within 1.2 m of the level.',
      vegetation: { type: 'reeds', densityPerHa: 600 },
    },
    {
      index: 2,
      id: 'forest',
      name: 'Conifer forest',
      color: '#33512f',
      rule: 'RULE TWO: till on the flanks above the shore band.',
      vegetation: { type: 'conifer', densityPerHa: 120 },
    },
  ],
});

describe('buildMethodsModel — the land-cover section (contract §9/§10)', () => {
  it('reproduces the model\'s method, every class rule, calibration and caveat verbatim', async () => {
    const { manifest, shoreline, rampart, sites } = await loadBroborg();
    const model = buildMethodsModel(manifest, shoreline, rampart, sites, LANDCOVER_LEGEND);
    const section = model.sections.find((s) => s.id === 'landcover');
    expect(section).toBeDefined();

    const text = section!.paragraphs.join('\n');
    expect(text).toContain(LANDCOVER_LEGEND.method);
    expect(text).toContain(LANDCOVER_LEGEND.calibration);
    expect(text).toContain(LANDCOVER_LEGEND.caveat);
    for (const cls of LANDCOVER_LEGEND.classes) {
      // "Name — rule", both verbatim: the app never paraphrases a rule it did not run.
      expect(text).toContain(`${cls.name} — ${cls.rule}`);
    }
    // The reference century is stated wherever the layer is described (§10).
    expect(text).toContain('500 CE');
    // ...as is the SGU attribution the v1.2 amendment widens.
    expect(text).toContain('Sveriges geologiska undersökning');
    expect(text).toContain('SGU Jordarter');
  });

  it('badges the section from manifest.layers, defaulting to model', async () => {
    const { manifest } = await loadBroborg();
    const model = buildMethodsModel(manifest, null, null, null, LANDCOVER_LEGEND);
    expect(model.sections.find((s) => s.id === 'landcover')?.badge).toBe(
      manifest.layers?.find((l) => l.id === 'landcover')?.provenance ?? 'model',
    );
  });

  it('omits the section entirely for a site with no land-cover pair', async () => {
    const { manifest, shoreline, rampart, sites } = await loadBroborg();
    const model = buildMethodsModel(manifest, shoreline, rampart, sites);
    expect(model.sections.map((s) => s.id)).not.toContain('landcover');
  });
});
