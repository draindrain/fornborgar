/**
 * The methods panel's CONTENT, assembled as plain data (Phase 6, PLAN §6.2).
 *
 * Kept separate from the modal rendering so the §6.2 disclosure requirements are
 * unit-testable in Node: every section below is required by the plan, and the
 * tests assert the load-bearing sentences survive editing. Data-derived text
 * (the shoreline derivation, the rampart derivation, fetch dates) comes verbatim
 * from the assets the pipeline shipped — the app never paraphrases a method it
 * did not run.
 */

import type { SiteManifest } from '../state/manifest';
import type { ShorelineTable } from '../water/shoreline';
import type { RampartFile } from '../overlays/palisade';
import type { SitesFile } from '../overlays/sites';

export type Provenance = 'measured' | 'model' | 'conjecture';

export interface MethodsSection {
  id: string;
  title: string;
  badge: Provenance | null;
  paragraphs: string[];
}

export interface MethodsModel {
  siteName: string;
  sections: MethodsSection[];
  /** Citation list, §6.2 last bullet. */
  citations: string[];
  repositoryUrl: string;
}

export const REPOSITORY_URL = 'https://github.com/draindrain/fornborgar';

/** PLAN §6.2: what the terrain is NOT. Verbatim requirement, do not soften. */
const TERRAIN_IS_NOT =
  'The terrain is the modern ground surface, including roads, ditches, quarrying and ' +
  'other later disturbance — it is NOT an Iron Age surface. Sediment has filled the ' +
  'valley floors since the fort era, so ancient water depths under the modelled levels ' +
  'are understated.';

/** PLAN §6.2: dating honesty. */
const DATING_HONESTY =
  'KMR records rarely carry per-site dating. Period attribution here is by site type ' +
  '("typisk datering" — e.g. gravfält of this form are overwhelmingly Iron Age in this ' +
  'region), not a per-record fact, except where excavation literature says otherwise: ' +
  'Broborg itself is dated ~400–550 CE (Migration Period) by excavation.';

const PALISADE_STATUS =
  'No palisade has been excavated at Broborg, and no archaeological evidence for its ' +
  'specific form is claimed. The crest line the posts stand on is measured (derived ' +
  'from the LiDAR DEM); everything else — that there were posts at all, their height ' +
  'and spacing — is an adjustable guess, rendered deliberately schematic.';

const VIEWSHED_METHOD =
  'Viewshed: XDraw algorithm over the 2 m context grid in a Web Worker, validated ' +
  'against gdal_viewshed (≥97 % cellwise agreement on rough terrain). Observer and ' +
  'target heights are the panel settings; earth curvature with atmospheric refraction ' +
  'k = 0.13 is on by default. Line-of-sight on the modern surface: forests, buildings ' +
  'and Iron Age structures are not modelled.';

const EXAGGERATION_NOTE =
  'Vertical exaggeration is a render-only Y scale, always indicated on screen when ' +
  'active ("terrain ×1.5"). All analysis — viewshed, water, palisade footing — runs on ' +
  'the unexaggerated heights.';

export const CITATIONS: string[] = [
  'Lantmäteriet, Markhöjdmodell Nedladdning (1 m national elevation model, LiDAR). CC BY 4.0.',
  'Riksantikvarieämbetet, Kulturmiljöregistret (KMR) / Fornsök, dataset "Kulturhistoriska lämningar". CC0.',
  'Sveriges geologiska undersökning, Strandförskjutningsmodell (sea/land distribution in 100-year steps). CC0.',
  'Påsse, T. & Daniels, J. (2015): Past shore-level and sea-level displacements. SGU Rapporter och meddelanden 137.',
  'Kresten, P. & Ambrosiani, B. (1992): Swedish vitrified forts — a reconnaissance study. Fornvännen 87.',
  'PNNL-led analogue studies of Broborg’s vitrified inner wall as a natural analogue for nuclear-waste glass (npj Materials Degradation, 2018–2022).',
  'KMR record L1943:7827 (RAÄ Husby-Långhundra 156:1): fort description, dimensions and status.',
];

function provenanceOf(manifest: SiteManifest, layerId: string): Provenance | null {
  const entry = manifest.layers?.find((l) => l.id === layerId);
  return (entry?.provenance as Provenance | undefined) ?? null;
}

function processingLines(manifest: SiteManifest): string {
  const provenance = manifest.provenance as { processing?: unknown } | undefined;
  const steps = Array.isArray(provenance?.processing)
    ? (provenance.processing as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  return steps.length > 0 ? `Pipeline processing: ${steps.join('; ')}.` : '';
}

/**
 * Assemble the §6.2 panel content from everything the site actually shipped.
 * Sections for assets a site does not carry are simply absent — the panel
 * never describes a layer the viewer cannot see.
 */
export function buildMethodsModel(
  manifest: SiteManifest,
  shoreline: ShorelineTable | null,
  rampart: RampartFile | null,
  sites: SitesFile | null,
): MethodsModel {
  const sections: MethodsSection[] = [];

  const terrain: string[] = [
    `Terrain: Lantmäteriet Markhöjdmodell Nedladdning — the national 1 m LiDAR ground DEM ` +
      `(TIN-interpolated from ground/water-classified laser returns). Heights are meters ` +
      `RH 2000; coordinates SWEREF 99 TM (EPSG:3006). The scene uses two windows: a 2×2 km ` +
      `core at 1 m and a 4×4 km context at 2 m, quantized to decimeters.`,
    TERRAIN_IS_NOT,
    EXAGGERATION_NOTE,
  ];
  const processing = processingLines(manifest);
  if (processing) terrain.splice(1, 0, processing);
  sections.push({ id: 'terrain', title: 'Terrain', badge: provenanceOf(manifest, 'terrain') ?? 'measured', paragraphs: terrain });

  if (sites) {
    sections.push({
      id: 'sites',
      title: 'Registered sites',
      badge: provenanceOf(manifest, 'sites') ?? 'measured',
      paragraphs: [
        `Site markers and outlines come from the Kulturmiljöregistret (KMR) county extract, ` +
          `fetched ${sites.fetched ?? 'from RAÄ'} — ${sites.sites.length} lämningar of the selected ` +
          `types (fornborgar, gravfält, boplatser, färdvägar, runristningar) inside this extent. ` +
          `Geometry and descriptions are shown as registered, unmodified.`,
        DATING_HONESTY,
      ],
    });
  }

  if (shoreline) {
    const caveats = [shoreline.uncertainty, shoreline.datumNote].filter((s): s is string => Boolean(s));
    const source = shoreline.source ?? {};
    const product = typeof source['product'] === 'string' ? source['product'] : 'SGU Strandförskjutningsmodell';
    const fetched = typeof source['fetched'] === 'string' && source['fetched'] ? `, fetched ${source['fetched']}` : '';
    sections.push({
      id: 'water',
      title: 'Paleo-shoreline',
      badge: provenanceOf(manifest, 'water') ?? 'model',
      paragraphs: [
        shoreline.method ?? 'Century water levels from the SGU shoreline-displacement model.',
        ...(caveats.length > 0 ? [caveats.join(' ')] : []),
        `Source: ${product}${fetched}. Enclosed basins that never connected to the sea are ` +
          `kept dry via a connectivity grid computed from the DEM.`,
      ],
    });
  }

  if (rampart) {
    sections.push({
      id: 'palisade',
      title: 'Palisade',
      badge: provenanceOf(manifest, 'palisade') ?? 'conjecture',
      paragraphs: [PALISADE_STATUS, rampart.derivation.description],
    });
  }

  sections.push({ id: 'viewshed', title: 'Viewshed', badge: null, paragraphs: [VIEWSHED_METHOD] });

  return {
    siteName: manifest.site.name,
    sections,
    citations: CITATIONS,
    repositoryUrl: REPOSITORY_URL,
  };
}
