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
