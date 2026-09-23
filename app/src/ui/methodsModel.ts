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
import type { ReconstructionFile } from '../overlays/reconstruction/schema';

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

/**
 * §9.2: the *mode* is disclosed, not just its layers. §9.3: every §5 transform is
 * reversible and quoted — "a visitor who wants to know why the wall is 2.9 m and
 * not 1.5 m can read the arithmetic" — so the panel gets the formulae, not the
 * conclusions.
 */
const RECONSTRUCTION_STATUS =
  'Reconstruction mode shows INTERPRETATIONS. Marker mode shows the register: what is ' +
  'recorded here, and where. Reconstruction mode answers a different and much less certain ' +
  'question — what a visitor would have seen standing here while these monuments were in ' +
  'use — and most of the answer is inference. Every monument states its own provenance per ' +
  'part rather than averaging to one label: a mound is measured in plan, modelled in ' +
  'profile and conjectural in surface, and its popup says so.';

const RECONSTRUCTION_RUIN_RULE =
  'Every number the register carries is a measurement of a RUIN. "Hög, 7 m diam, 0,7 m h" ' +
  'is a mound that has stood for fifteen centuries, lost its organic volume, slumped ' +
  'outward and in a third of cases been dug into; drawing 0.7 m of height would not be a ' +
  'reconstruction but the ruin, extruded. Across the corpus mounds survive at a mean flank ' +
  'angle of about 11°, cairns 10° and stone settings 8°, where dry-stacked stone stands near ' +
  '35° and loose earth near 30°. So three stated, reversible transforms convert the ' +
  'measurements, and each monument records which one was applied to it.';

const RECONSTRUCTION_TRANSFORMS =
  'Rampart height: h_orig = h_standing + (W_spread − t_wall) · d_apron · p / t_wall — the ' +
  'wall that is still standing, plus the height its own fallen debris apron represents, with ' +
  'p = 0.85 for the packing difference between built wall and rubble. At Broborg the wall is ' +
  'not an unknown shape to be guessed at: it still stands about 2 m at an estimated 4–6 m ' +
  'thickness (Kresten, Kero & Chyssler 1993), so most of the answer is simply there. Across ' +
  'the whole plausible parameter box the result spans 2.1–3.4 m; the app draws 2.5 m. ' +
  'Mound and cairn profile: where a kantkedja (kerb) is recorded — 54 % of the corpus — the ' +
  'kerb fixes the original footprint, so the diameter is kept and the surface restored to a ' +
  'smooth spherical cap through it. Where no kerb is recorded the base may have crept ' +
  'outward, so the monument is rebuilt conserving volume at its material’s angle of repose, ' +
  'which makes the corpus-median mound narrower and more than twice as tall: 7.0 × 0.7 m ' +
  'becomes 5.7 × 1.6 m. Applying the second rule to a kerbed mound would visibly pull it ' +
  'inside its own surviving kerb, which is the built-in check on the first. Robbing pits: ' +
  '32 % of records describe a pit with dimensions, so filling it is a measured operation. ' +
  'Stone settings and fire-cracked mounds are never inflated — flatness is the type, and the ' +
  'work there is cleaning rather than raising.';

const RECONSTRUCTION_PLACEMENT =
  'A Gravfält record is a compositional recipe, not a shape: it enumerates its own contents. ' +
  '28 of the 31 grave-field records here state their own monument count — the counts run from ' +
  '5 to 230 — and give a size range per constituent class, so what is in a grave field is ' +
  'measured. Where each monument stands is not, and that is the only genuinely inferential ' +
  'part of the archetype. Positions come from landscape rules rather than invention: wet ' +
  'land-cover classes are excluded, local prominence and slope are read from the DEM, larger ' +
  'monuments are biased toward the highest and most visible ground, and blue-noise spacing ' +
  'keeps nothing intersecting. Everything is seeded from the site id, so the same scene ' +
  'appears on every machine and in every screenshot.';

const RECONSTRUCTION_FORT_FILTER =
  'Not every registered Fornborg is a Migration Period fort, and this is the one error that ' +
  'would be wrong a thousand times over rather than once. Uppland registers 181 and a ' +
  'systematic field survey judges about 30 of them to be Middle Iron Age, of which 9 are ' +
  'dated. So a fort is drawn as a standing rampart only where its own record meets the ' +
  'survey’s published test — dry-stone walling (kallmurning) preserved, a wall 1 m or more ' +
  'high, running right round or across the non-steep side. Below that threshold the app draws ' +
  'the low bank the register actually records and says why in the popup: a site the app ' +
  'cannot classify should look unresolved, not confidently Migration Period.';

const RECONSTRUCTION_TIME =
  'The archetypes are not contemporaneous, and pretending otherwise would be the easiest way ' +
  'for this mode to lie. Monuments appear and disappear with the year slider: at 500 CE the ' +
  'fort stands and there are no runestones on screen, because Uppland’s runestones were raised ' +
  'between the late 900s and the early 1100s; at 1050 CE the fort is long ruined and falls back ' +
  'to its flat marker, which is the measured geometry. Dating is by TYPE, not per record — KMR ' +
  'carries almost no per-record dating. Broborg is the exception: radiocarbon, archaeomagnetic ' +
  'and bead dates converge on roughly 430–580 CE.';

const RECONSTRUCTION_VITRIFIED =
  'Broborg is one of only three Swedish forts vitrified sensu stricto. Whether the wall was ' +
  'vitrified while in use is contested: Sjöblom et al. (2022) read the glassy cake along the ' +
  'inner face as deliberate and constructive, on seven grounds including selectively enriched ' +
  'amphibolite with hewn edges and cultural layers lying on top of the vitrification residue; ' +
  'Bornfalk Back (2023) contests the reading. The band is offered as a state, not a verdict — ' +
  'under the constructive reading the fort looked vitrified while in use, under the destruction ' +
  'reading it was ordinary dry stone until the day it burned.';

/**
 * §7.5: the interior is a two-state selector, and this is the half of it that
 * carries the evidence.
 *
 * It follows the vitrified band exactly — both states rendered, neither claimed,
 * the disagreement stated rather than resolved — and it adds the one thing the
 * band does not need: a per-fort gate, so the section has to say which side of
 * that gate this fort fell and what put it there.
 */
const INTERIOR_STATUS =
  'The ground inside the wall is offered as two states rather than one picture. "Cleared ' +
  'surfaces" is the default for every fort, always: the measured DEM surface unmodified, its ' +
  'soil class and terrain vocabulary, and stone-picked patches only where the register places ' +
  'them, at the size and in the compass sector it states. "Settlement" is the same ground plus ' +
  'houses, and it is offered only where this fort’s own record — or a cited excavation — puts ' +
  'buildings inside the wall. Neither state is the empty one, and neither is a verdict: like ' +
  'the vitrified band, they are two readings of the same contested evidence, and the app ' +
  'renders both instead of picking one.';

/**
 * §7.5.1's required sentence, and it is required for a reason: an empty,
 * competently rendered fort interior reads as a finding unless the app says
 * otherwise.
 */
const INTERIOR_CLEARED_NOTE =
  'What "cleared surfaces" must never be read as saying is "nobody was here". It is a ' +
  'statement about visible, recorded structure, which is a strict subset of occupation — the ' +
  'register measures what a surveyor wrote down, not what was there. The gap is not ' +
  'hypothetical: Broborg has a settlement layer radiocarbon dated to AD 432–542 by excavation, ' +
  'invisible from the surface, on a fort whose register description says nothing about it. The ' +
  'absence of a husgrund in a description is the absence of a surveyor’s note, not the absence ' +
  'of a house.';

/** §7.5.3: why the state is withheld rather than offered behind a label. */
const INTERIOR_REFUSAL_NOTE =
  'A fort with no such evidence is not offered the state at all — not offered behind a ' +
  'warning. A caveat does not travel with a screenshot; for about a third of registered forts ' +
  'houses would contradict the description rather than merely exceed it, since 32 % describe ' +
  'their own interior as bare rock, block or wet ground; and a default longhouse drawn in ' +
  '1 250 forts would be the same building 1 250 times, which reconstructs nothing. The ' +
  'measurement behind those figures is docs/interior-survey-2026-08-30.md: 4.1 % of the 1 304 ' +
  'registered forts carry defensible interior-building evidence, 2.1 % state it without ' +
  'hedging.';

/** §7.5.3: the gate's known hole, stated by the app rather than left for a reader to find. */
const INTERIOR_GATE_UNDERCOUNTS =
  'The gate is known to undercount, and that is written here rather than left to be ' +
  'discovered: it reads the register, and the register is not a survey. Not one of Uppsala ' +
  'county’s 79 forts carries a strong-tier term, yet a systematic Mälardalen survey names 5–6 ' +
  'Uppland forts with house terraces. Broborg itself fails the keyword gate and is offered the ' +
  'state only through channel 3 — a cited excavation entered by hand — which is the honest ' +
  'repair for that hole, and is open to any fort for which somebody does the reading.';

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

/**
 * The interior selector's evidence, as the visitor's one click from the houses
 * to the sentence they came from (§7.5.3).
 *
 * Every citation is rendered **verbatim**, per channel, because the three
 * channels do not carry the same thing and flattening them would be the app
 * asserting a uniformity the data does not have: channel 1 is a KMR sentence
 * with a lämningsnummer and a matched term, channel 2 is a neighbouring record
 * plus the geometry test that placed it inside, and channel 3 is a publication
 * and a statement with no KMR sentence at all — which is precisely Broborg's
 * case, so an implementation that assumed a sentence would fail on the app's own
 * reference fort.
 *
 * A fort that failed the gate keeps its section. `gate: "fail"` is a statement,
 * and the `discarded` counters make it a useful one: "the register records no
 * buildings inside this fort, and two mentions of houses that it places outside
 * it" says more than silence does (§15.3).
 */
export function interiorSection(
  interior: NonNullable<ReconstructionFile['interior']>,
): MethodsSection {
  const evidence = interior.evidence;
  const paragraphs = [INTERIOR_STATUS, INTERIOR_CLEARED_NOTE];

  const channels = evidence.channels.length > 0 ? evidence.channels.join(', ') : 'none';
  const passed = evidence.gate === 'pass';
  paragraphs.push(
    `Gate: rule ${evidence.rule}, result ${evidence.gate}` +
      (passed ? ` on channel ${channels}.` : '.') +
      (passed
        ? ' The "settlement" state is therefore offered on this fort, and it is off until you' +
          ' switch it on.'
        : ' The "settlement" state is therefore not offered on this fort at all.') +
      (evidence.hedged
        ? ' Every surviving hit hedges (möjlig, trolig, eventuell, -liknande), so the register' +
          ' is reporting something building-shaped rather than a building, and the houses must' +
          ' not be read as a confident statement.'
        : '') +
      discardedSentence(evidence.discarded),
  );

  for (const citation of evidence.citations) {
    paragraphs.push(citationParagraph(citation));
  }
  if (evidence.citations.length === 0) {
    paragraphs.push(
      'No citation, and therefore no state: the register carries no sentence, no neighbouring ' +
        'settlement record and no cited excavation putting buildings inside this wall, so no ' +
        'building is drawn inside it at any opacity, under any label.',
    );
  }

  paragraphs.push(buildingsParagraph(interior));
  paragraphs.push(INTERIOR_REFUSAL_NOTE, INTERIOR_GATE_UNDERCOUNTS);

  const words = interior.ground?.terrainWords ?? [];
  if (words.length > 0) {
    paragraphs.push(
      `What the register says about this interior’s own ground, in its own words: ` +
        `${words.map((word) => `“${word}”`).join(', ')}. The cleared surface is read from those ` +
        `words and the ${interior.ground.soilClass.toUpperCase()} soil class, over the measured ` +
        `DEM — modelled surface on measured ground, with no regrading to seat anything.`,
    );
  }

  return {
    id: 'interior',
    title: 'The fort interior — cleared surfaces or settlement',
    badge: 'conjecture',
    paragraphs,
  };
}

/** §15.1's `discarded` counters, as a sentence, and only where there is one to make. */
function discardedSentence(discarded: Record<string, number> | undefined): string {
  if (!discarded) return '';
  const parts: string[] = [];
  const say = (key: string, text: string): void => {
    const n = discarded[key];
    if (typeof n === 'number' && n > 0) parts.push(`${n} ${text}`);
  };
  say('negated', 'negated by its own sentence');
  say('exterior', 'placed outside the enclosure');
  say('nonbuildingTerrass', 'a cultivation or natural terrace rather than a house');
  say('modern', 'a modern croft or outbuilding');
  if (parts.length === 0) return '';
  return (
    ` Mentions of buildings that were read and discarded: ${parts.join('; ')}. KMR describes a ` +
    `19th-century croft foundation and an Iron Age one in identical vocabulary, which is why ` +
    `the discards are counted here rather than assumed away.`
  );
}

/**
 * One citation, verbatim, in the shape its own channel actually has.
 *
 * `unknown`-typed on purpose: `InteriorEvidence.citations` is a list of raw
 * records in the contract, the schema guarantees only `channel`, and the app
 * must not invent a field the pipeline did not write.
 */
function citationParagraph(citation: Record<string, unknown>): string {
  const str = (key: string): string | null => {
    const value = citation[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const channel = str('channel');

  if (channel === 'description') {
    const id = str('lamningsnummer') ?? 'this record';
    const matched = str('matched') ?? str('term');
    const hedged = citation['hedged'] === true;
    const sentence = str('sentence');
    return (
      `Register description, ${id}` +
      (matched ? `, on the word “${matched}”` : '') +
      (hedged ? ', hedged' : '') +
      (sentence ? `: “${sentence}”` : ' — but the pipeline wrote no sentence with it, which is a ' +
        'defect in the data rather than a sentence the app may supply.')
    );
  }

  if (channel === 'settlement-record') {
    const id = str('id') ?? 'an unnamed record';
    const type = str('lamningstyp');
    const test = str('test');
    return (
      `Neighbouring settlement record ${id}` +
      (type ? ` (${type})` : '') +
      (test === 'bbox'
        ? ', placed inside this fort by a BOUNDING-BOX test, not by its extent polygon. That is ' +
          'the weaker of the two and is shown for that reason: a bounding box over a promontory ' +
          'fort reaches well outside the wall.'
        : test === 'polygon'
          ? ', whose representative point falls inside this fort’s own extent polygon.'
          : '.')
    );
  }

  if (channel === 'cited') {
    const reference = str('reference') ?? 'an unnamed source';
    const statement = str('statement');
    const enteredBy = str('enteredBy');
    return (
      `Cited excavation — ${reference}` +
      (enteredBy ? `, entered by hand (${enteredBy})` : '') +
      (statement ? `: “${statement}”` : '.') +
      ' This is a publication rather than a KMR sentence: there is no lämningsnummer to give, ' +
      'because the register does not record it.'
    );
  }

  return `Citation on an unrecognised channel (${channel ?? 'none'}) — shown rather than hidden.`;
}

/** What the `settlement` state would actually draw, and where each number came from. */
function buildingsParagraph(interior: NonNullable<ReconstructionFile['interior']>): string {
  const buildings = interior.buildings;
  if (!interior.settlementOffered) {
    return (
      'Nothing is drawn inside this wall in either state beyond the measured ground itself: no ' +
      'buildings, and no hearths, wells, yards, fences or paths, which are a farmstead recipe ' +
      'for open ground rather than anything recorded inside an enclosure.'
    );
  }
  if (!buildings) {
    return (
      'This fort passes the gate and still draws no houses, because what it passed on states ' +
      'that people were here without stating a single building: no count, no dimensions, no ' +
      'layout. Switching to "settlement" therefore changes the citation you can read and not ' +
      'the geometry you can see — the app will not supply a building the source does not.'
    );
  }
  const count = buildings.count ?? 1;
  const stated = buildings.countStated
    ? `${count} buildings, a count the source states`
    : `${count} building${count === 1 ? '' : 's'}, which the source does not state — the ` +
      `archetype default`;
  const layout =
    buildings.layout === 'radial'
      ? ' laid out radially against the inner wall face, as the source describes'
      : buildings.layout === 'grouped'
        ? ' in groups, as the source describes'
        : ' without a stated layout';
  const sector = buildings.sector
    ? `, restricted to the ${buildings.sector} part of the interior because that is where the ` +
      `sentence puts them`
    : '';
  // §7.5.2's Öland/Gotland branch. It changes where a house is put and nothing
  // about whether it may be put there, and the two numbers it stands on are the
  // register's own or absent — so the sentence names which, and it names the one
  // thing the app draws more tidily than the record describes it.
  const ringfort =
    interior.tradition === 'limestone-ringfort'
      ? ` This is a limestone ringfort, a different building tradition from a mainland boulder ` +
        `rampart, so the houses are laid out in radial blocks against the inner wall face rather ` +
        `than scattered across the interior — a layout branch, never a lower bar for evidence: ` +
        `no fort is offered this state for standing on limestone.` +
        (buildings.blocks
          ? ` The inner group is cut into ${buildings.blocks} blocks by streets because the ` +
            `description says so, and the record calls that group "mer oregelbunden" — more ` +
            `irregular — while the app draws it as regular as the outer one, because nothing in ` +
            `the record says what the irregularity was.`
          : ``) +
        (buildings.streetWidthM
          ? ` The street between the groups is the ${buildings.streetWidthM[0]}–` +
            `${buildings.streetWidthM[1]} m the register measures.`
          : // Only where there is more than one group is there a street to have
            // an opinion about; a single ring against the wall needs no gap.
            (buildings.groups ?? 1) > 1
            ? ` The register measures no street between the groups, so the gap between them is ` +
              `an assumption and is named below.`
            : ``)
      : '';
  const fallbacks =
    buildings.fallbacks && buildings.fallbacks.length > 0
      ? ` Everything the source leaves unstated takes a §6.H literature default, and each one is ` +
        `named: ${buildings.fallbacks.join(', ')}. A house whose length came from the register ` +
        `and a house whose length came from the 20–40 m default must not read as equally certain.`
      : ' Every value the sampler used came from the source rather than from an archetype default.';
  return (
    `In the "settlement" state this fort draws ${stated}${layout}${sector}. The count is an upper ` +
    `bound, never a target: where the measured interior will not hold them the shortfall is a ` +
    `warning on the record, not a silent truncation.${ringfort}${fallbacks}`
  );
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
  reconstruction: ReconstructionFile | null = null,
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

  if (reconstruction) {
    const coverage = reconstruction.coverage as Record<string, number>;
    const percent = (key: string): string =>
      typeof coverage[key] === 'number' ? `${Math.round(coverage[key] * 100)} %` : 'most';
    const paragraphs = [
      RECONSTRUCTION_STATUS,
      RECONSTRUCTION_RUIN_RULE,
      RECONSTRUCTION_TRANSFORMS,
      `What the register actually affords, measured on these ${coverage['records'] ?? 0} records: ` +
        `${percent('planParsed')} carry a plan size, ${percent('heightParsed')} a height, ` +
        `${percent('stoneParsed')} a constituent stone-size range, ${percent('kerbParsed')} a ` +
        `kantkedja and ${percent('pitsParsed')} a robbing pit with dimensions. Where a value ` +
        `cannot be read the archetype default is used, the popup names the field, and the ` +
        `monument's parse confidence drops — nothing is invented silently.`,
      RECONSTRUCTION_PLACEMENT,
      RECONSTRUCTION_FORT_FILTER,
      RECONSTRUCTION_TIME,
    ];
    if (reconstruction.monuments.some((monument) => monument.fort?.ramparts.some((r) => r.vitrified))) {
      paragraphs.push(RECONSTRUCTION_VITRIFIED);
    }
    paragraphs.push(reconstruction.derivation.description);
    sections.push({
      id: 'reconstruction',
      title: 'Reconstruction mode',
      badge: provenanceOf(manifest, 'reconstruction') ?? 'conjecture',
      paragraphs,
    });
    // §7.5: its own section, with its own id, because the interior selector
    // links straight to it — "a visitor can get from the rendered houses to the
    // sentence they came from in one click" is not satisfied by a paragraph
    // buried in a longer one.
    if (reconstruction.interior) sections.push(interiorSection(reconstruction.interior));
  }

  sections.push({ id: 'viewshed', title: 'Viewshed', badge: null, paragraphs: [VIEWSHED_METHOD] });

  return {
    siteName: manifest.site.name,
    sections,
    citations: CITATIONS,
    repositoryUrl: REPOSITORY_URL,
  };
}
