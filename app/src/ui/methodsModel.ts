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

import { PERIOD_CONVENTION_NOTE } from '../lib/periods';
import { siteLatLon } from '../lib/sweref';
import { SOLSTICE_DRIFT_NOTE } from '../sky/solar';
import type { SiteManifest } from '../state/manifest';
import type { ShorelineTable } from '../water/shoreline';
import { formatYear } from '../water/shoreline';
import { dynamicClass, type LandcoverLegend } from '../landcover/legend';
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
  'Broborg itself is dated ~400–550 CE (Migration Period) by excavation. That attribution ' +
  'is weakest for the cultivation remains: fossil field systems, clearance cairns and ' +
  'terraces span the Bronze Age to the medieval period, so where the model reads ' +
  'cultivation from them it is reading pre-modern land use, not specifically Iron Age ' +
  'land use.';

/** PLAN §6.2: say what the sun calculation is, in the same detail as the rest. */
const SUN_METHOD =
  'Time of day is local apparent solar time — sundial time, where 12:00 is by definition ' +
  'the sun on the meridian. That is the only clock this landscape ever had, and it removes ' +
  'the equation of time, the time zone and ΔT (about three hours of genuine uncertainty at ' +
  '1000 BCE) from the calculation rather than guessing at them. Declination comes from the ' +
  "sun's apparent ecliptic longitude (Meeus, Astronomical Algorithms ch. 25) and the mean " +
  'obliquity of the ecliptic from the long-term expression of Laskar (1986), which is valid ' +
  'across ten millennia — the standard polynomial is not, and this app scrubs back 3 000 ' +
  'years. Obliquity is the one way the year slider moves the sun: it was 23.82° at 1050 BCE ' +
  'against 23.44° today, a quarter of a degree on the midsummer noon altitude.';

const SUN_ACCURACY =
  'Accuracy: better than about 0.1° in the sun\u2019s direction anywhere in this range — a fifth ' +
  'of a solar diameter — except within roughly a degree of the horizon, where atmospheric ' +
  'refraction is inherently uncertain at the 0.1–0.3° level and more under a temperature ' +
  'inversion. That is far tighter than anything else in this scene claims.';

const NIGHT_RENDERING_NOTE =
  'Night is rendered with a simulated dark-adapted exposure and a floor on the ambient light: ' +
  'a real moonless Iron Age night is far darker than what is drawn here. The sky, twilight and ' +
  'sunset colours are an artistic ramp keyed to the computed solar altitude, not a ' +
  'radiative-transfer model — and the reflection in the water is a reflection of that computed ' +
  'sky, not of the landscape: the hills, the trees and the palisade do not appear in it.';

const MOON_METHOD =
  'The moon is computed from the truncated ELP-2000/82 lunar theory (Meeus, Astronomical ' +
  'Algorithms ch. 47), corrected for the observer\u2019s offset from the centre of the Earth — the ' +
  'moon\u2019s parallax is about 0.95°, nearly twice its own width, so a geocentric moon would sit ' +
  'visibly too high whenever it is low. Its phase is not drawn from a phase angle: the renderer ' +
  'lights a sphere with the sun\u2019s direction, so the illuminated fraction and the tilt of the ' +
  'terminator are both consequences of where the two bodies actually are.';

const MOON_DELTA_T =
  'The moon reintroduces the one uncertainty the sun was built to avoid. Apparent solar time ' +
  'fixes the sun\u2019s hour angle by definition, so \u0394T never enters the sun\u2019s position; the moon ' +
  'has no such privilege, because its place has to be computed on a dynamical timescale and \u0394T ' +
  'is the map from the sundial to that scale. It is applied here from the Espenak–Meeus ' +
  'polynomials (the standard fit for ancient eclipse work), and it is large: about 7.3 hours at ' +
  '1050 BCE, falling to a quarter of an hour by 1150 CE. Ignoring it would misplace the moon by ' +
  'some 4° — eight lunar diameters — at the far end of the year slider. What remains is the ' +
  'uncertainty in \u0394T itself, of order twenty minutes that far back, or roughly a third of a ' +
  'lunar diameter.';

const MOON_SURFACE =
  'The face of the moon is a schematic, not an image. Fourteen maria and four ray craters are ' +
  'drawn as soft-edged discs at their catalogued selenographic coordinates, sized by their ' +
  'catalogued diameters; the maria are irregular and a disc is an approximation of an outline. ' +
  'North is placed from the ecliptic pole, which stands in for the moon\u2019s rotation axis to ' +
  'within 1.5°. Libration — the rocking of up to about 7° that lets us see 59 % of the surface ' +
  'rather than half of it — is not modelled, so the face never turns.';

const STARS_METHOD =
  'The stars are the 5 044 in the sky down to visual magnitude 6.0 — the naked-eye limit, and ' +
  'the right limit for a sky with no light pollution in it. Positions come from XHIP, an ' +
  'extended compilation of the Hipparcos catalogue (Anderson & Francis 2012, VizieR V/137D), by ' +
  'way of the derived data set published with d3-celestial. They are precessed from J2000 to the ' +
  'year the slider sets (Meeus ch. 21), which over this range moves the whole sky by tens of ' +
  'degrees: at 1050 BCE there is no pole star, Thuban having drifted off the pole two thousand ' +
  'years earlier and Polaris not yet arrived.';

const STARS_PROPER_MOTION =
  'Proper motion is not applied — the derived catalogue does not carry it. Precession, which ' +
  'moves the entire sky, is by far the larger effect and is applied; what is left is that a few ' +
  'nearby stars are drawn where they were in 2000 CE rather than where they were in the Iron ' +
  'Age. Over 3 050 years that is about 4.5° for 61 Cygni, 3.2° for μ Cassiopeiae and 1.9° for ' +
  'Arcturus, and well under half a degree for essentially everything else: a distortion in the ' +
  'shape of a few constellations, not a wrong sky.';

const NO_PLANETS =
  'No planets are drawn. Venus at magnitude −4 would be the brightest thing in this sky after ' +
  'the moon, and Jupiter, Mars and Saturn are all brighter than most of the stars that are ' +
  'drawn, so this is a real absence rather than a rounding: what is shown is the fixed stars, ' +
  'the sun and the moon. The Milky Way, which would dominate an unlit sky, is also absent.';

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
  'Sveriges geologiska undersökning, Jordarter 1:25 000–1:100 000 (Quaternary deposits). CC0.',
  'Påsse, T. & Daniels, J. (2015): Past shore-level and sea-level displacements. SGU Rapporter och meddelanden 137.',
  'Kresten, P. & Ambrosiani, B. (1992): Swedish vitrified forts — a reconnaissance study. Fornvännen 87.',
  'PNNL-led analogue studies of Broborg’s vitrified inner wall as a natural analogue for nuclear-waste glass (npj Materials Degradation, 2018–2022).',
  'KMR record L1943:7827 (RAÄ Husby-Långhundra 156:1): fort description, dimensions and status.',
];

/**
 * Everything the land-cover model says about itself, in its own words.
 *
 * `method`, every class `rule`, `calibration` and `caveat` are contract §10's
 * verbatim fields: the app runs no rule engine, so it must not paraphrase one. The
 * only app-authored sentence here is the one describing what the *app* does with the
 * raster — render-side masking against the Phase-4 slider — because that is our
 * behaviour to disclose, not the pipeline's.
 */
/**
 * The app-authored "what the app does with the raster" sentence.
 *
 * Two variants, chosen by the legend itself: a v1.3 legend that marks classes
 * `dynamic` gets the honest description of the §9 carve-out (the sea and the shore
 * reed belt follow the slider, everything else is frozen), and a legend without them
 * keeps the pre-v1.3 sentence — old data must stay truthfully described.
 */
function landcoverAppBehaviour(legend: LandcoverLegend): string {
  const year = formatYear(legend.referenceYearCE);
  const level = legend.referenceLevelM.toFixed(1);
  const water = dynamicClass(legend, 'water');
  const band = dynamicClass(legend, 'shore-band');
  const bandM = typeof band?.dynamic?.bandM === 'number' ? Number(band.dynamic.bandM.toFixed(2)) : null;

  if (!water && !band) {
    return (
      `The raster models one reference century — ${year}, at a modelled water ` +
      `level of ${level} m — and is never re-derived for another. Scrubbing the ` +
      `shoreline slider only masks it: vegetation whose ground is under water at the level shown is hidden, ` +
      `so nothing is ever drawn standing in the sea.`
    );
  }

  const subjects: string[] = [];
  if (water) subjects.push('open sea');
  if (band && bandM !== null) {
    subjects.push(`the shore reed belt (the ground within ${bandM} m above the water line)`);
  }
  const subject = subjects.join(' and ');
  const verb = subjects.length > 1 ? 'are' : 'is';

  return (
    `The raster models the reference century ${year}, at a modelled water level of ${level} m. Two ` +
    `purely hydrological classes are the disclosed exception (contract §9 v1.3): ${subject} ` +
    `${verb} re-derived by the app at the century shown, from the same sea-connectivity grid and the same ` +
    `"connected to the open sea" semantics the water layer itself uses — no rule engine runs in the ` +
    `browser.` +
    (band ? ' Ground inside the belt is kept clear of trees, too.' : '') +
    ` Every other class is the frozen ${year} classification, which the slider only masks: vegetation ` +
    `standing in the sea at the level shown is hidden, so nothing is ever drawn standing in the water.`
  );
}

function landcoverParagraphs(legend: LandcoverLegend): string[] {
  const rules = legend.classes.map((c) => `${c.name} — ${c.rule}`);
  const source = legend.source ?? {};
  const product = typeof source['product'] === 'string' ? source['product'] : null;
  const fetched = typeof source['fetched'] === 'string' && source['fetched'] ? `, fetched ${source['fetched']}` : '';

  return [
    legend.method,
    landcoverAppBehaviour(legend),
    `Class rules, verbatim: ${rules.join(' | ')}`,
    legend.calibration,
    // v1.6 §13: the far field is a cruder, separately disclosed classifier —
    // its method paragraph and rules join the panel in the data's own words.
    ...(legend.farField
      ? [
          legend.farField.method,
          `Far-field class rules, verbatim: ${legend.farField.classes
            .map((c) => `${c.name} — ${c.rule}`)
            .join(' | ')}`,
        ]
      : []),
    legend.caveat,
    ...(product
      ? [
          `Source: ${product}${fetched}. Soil and shoreline-displacement data from Sveriges geologiska ` +
            `undersökning (SGU), CC0.`,
        ]
      : []),
  ];
}

/**
 * v1.4 §11: how the far-field rings were made and what was done to them —
 * per-ring resolutions/quantization from the manifest itself, the curvature
 * constant shared with the viewshed, and the far-water fade caveat. Absent for
 * ringless sites: the panel never describes terrain the viewer cannot see.
 */
function horizonDisclosure(manifest: SiteManifest): string | null {
  const rings = manifest.grids.rings;
  if (!rings?.length) return null;
  const ladder = rings
    .map((r) => {
      const km = Math.round((r.width * r.resolution) / 1000);
      return `${km}×${km} km at ${r.resolution} m (±${r.encoding.scale} m quantization)`;
    })
    .join(', ');
  const h = manifest.horizon;
  const derivation = h
    ? ` Ladder depth is derived per site: crown ${h.crownM} m + ${h.eyeM} m eye − ` +
      `surrounding floor ${h.floorM} m gives a refracted horizon at ~${h.distanceKm} km, ` +
      `and rings extend until they close it.`
    : '';
  // v1.5 §12: far water ships as either the absolute grid or the delta.
  const hasFarWater = rings.some((r) => r.waterConnect || r.waterConnectDelta);
  return (
    `Far-field rings extend the terrain beyond the context window: ${ladder}. Outer rings are ` +
    `block-averaged reads from the source elevation model's overview levels — silhouettes, not ` +
    `survey-grade surfaces.${derivation} Ring meshes are lowered by the earth-curvature drop ` +
    `(1−k)·d²/2R with k = 0.13, the same correction the viewshed applies, so the skyline sits ` +
    `where the refracted horizon actually is; analysis grids stay flat and the viewshed still ` +
    `runs on the 2 m context grid only.` +
    (hasFarWater
      ? ` The paleo-shoreline is drawn out to the 16 km ring and faded toward its edge: ` +
        `post-glacial uplift is a gradient, so a single per-century level grows less valid ` +
        `with distance from the site.`
      : '')
  );
}

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
  landcover: LandcoverLegend | null = null,
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
  const horizonParagraph = horizonDisclosure(manifest);
  if (horizonParagraph) terrain.splice(1, 0, horizonParagraph);
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
          `types inside this extent: forts; grave fields and single graves (högar, stensättningar, ` +
          `rösen, flatmarksgravar, stenkammargravar); settlement remains (boplatser, boplatsvallar, ` +
          `skärvstenshögar, förhistoriska/medeltida husgrunder); cultivation remains (fossil åker, ` +
          `röjningsrösen, terrasseringar); roads and enclosures (färdvägar, hägnader); and rune ` +
          `inscriptions. Historic-era types (bytomter, historiska husgrunder, lägenhetsbebyggelse) ` +
          `are deliberately excluded as the wrong era for this model. Geometry and descriptions are ` +
          `shown as registered, unmodified.`,
        DATING_HONESTY,
      ],
    });
  }

  // The sun is computed, not measured and not read from an asset: it is a model
  // of a physical system, so it carries the model badge like the shoreline does,
  // and — per PLAN §6.1 — states its own uncertainty rather than implying none.
  const site = siteLatLon(manifest);
  sections.push({
    id: 'sun',
    title: 'Sun and time',
    badge: 'model',
    paragraphs: [
      `The sun's position is computed for this site's real location — ` +
        `${site.latDeg.toFixed(4)}° N, ${site.lonDeg.toFixed(4)}° E, derived from the ` +
        `manifest's SWEREF 99 TM origin — from the year, the day of the year and the time ` +
        `of day the three sliders set.`,
      SUN_METHOD,
      SOLSTICE_DRIFT_NOTE,
      SUN_ACCURACY,
      `The year slider also names the archaeological period. ${PERIOD_CONVENTION_NOTE}`,
    ],
  });

  // The night sky is a separate model with a separate provenance and a separate
  // set of things it gets wrong, so it says so separately rather than hiding
  // behind the sun's much tighter accuracy claim.
  sections.push({
    id: 'nightsky',
    title: 'The moon and the stars',
    badge: 'model',
    paragraphs: [
      MOON_METHOD,
      MOON_DELTA_T,
      MOON_SURFACE,
      STARS_METHOD,
      STARS_PROPER_MOTION,
      NO_PLANETS,
      NIGHT_RENDERING_NOTE,
    ],
  });

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

  if (landcover) {
    sections.push({
      id: 'landcover',
      title: 'Modeled landscape',
      badge: provenanceOf(manifest, 'landcover') ?? 'model',
      paragraphs: landcoverParagraphs(landcover),
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
