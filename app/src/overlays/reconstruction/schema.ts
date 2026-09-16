/**
 * `reconstruction.json` — the §14 contract, as types and one validator.
 *
 * The file carries what the KMR register only says in prose: plan form and size,
 * reconstructed height, kerb, stone calibre, robbing pits, and — for a `Gravfält`
 * — the monument count and class composition the record enumerates about itself.
 * `pipeline/fornborg_pipeline/reconstruct.py` parses it offline; nothing here
 * parses Swedish.
 *
 * Two §14 rules this module exists to enforce at the door, because both are
 * invisible until the scene is already wrong:
 *
 *   • **No coordinates.** A monument's position and extent polygon live in
 *     `sites.json` (§3) and the two files join by `id`. A `position` key here
 *     would be a second copy of a number that can drift, so it is rejected.
 *   • **No ground heights.** `heightM` always means *height above the ground at
 *     that point*. Ground elevation is sampled at runtime through the app's own
 *     sampler, exactly as the rampart crest is (§8).
 *
 * Validation is hard-fail with a field-naming message, in the same style as
 * `state/manifest.ts`, `overlays/palisade.ts` and `water/shoreline.ts`; the
 * loader turns any throw into "feature off" rather than a broken scene.
 */

/** The §4 archetype keys the pipeline emits. */
export type Archetype =
  | 'fort'
  | 'mound'
  | 'stone-setting'
  | 'cairn'
  | 'fire-cracked-mound'
  | 'standing-stone'
  | 'grave-field'
  | 'farmstead'
  | 'field-boundary'
  | 'cultivated-ground'
  | 'clearance-cairn'
  | 'route'
  | 'runestone';

/** §9 provenance tiers; they map onto PLAN §6.1's three badges. */
export type Tier = 'measured' | 'derived' | 'assumed';

/** PLAN §6.1's badge vocabulary. §9's mapping, in one place. */
export const BADGE_FOR_TIER: Record<Tier, string> = {
  measured: 'measured',
  derived: 'model',
  assumed: 'conjecture',
};

export type PlanForm = 'round' | 'square' | 'rectangular' | 'oval' | 'triangular';

/** A `[min, max]` band. A single stated value arrives as `[v, v]` (§14). */
export type Range = [number, number];

export interface MonumentPlan {
  form: PlanForm;
  /** Equal-area circle diameter for non-round plans (§14). */
  diameterM: number;
  lengthM: number | null;
  widthM: number | null;
  /** Long axis, 0–180°, 0 = N–S. */
  orientationDeg: number | null;
  source: Tier;
}

export interface MonumentProfile {
  /** The **reconstructed** height above ground. */
  heightM: number;
  /** The reconstructed base diameter — not always the recorded one (§5.2). */
  diameterM: number;
  /** The ruin measurements the transform ran on, kept so it stays reversible. */
  presentHeightM: number;
  presentDiameterM: number;
  heightGain: number;
  transform: string;
  source: Tier;
}

export interface MonumentSurface {
  stoneM: Range;
  /** What the register saw. `övertorvad` is a **ruin** state (§5.4). */
  turfed: boolean;
  filled: boolean | null;
  centreStone: boolean;
  source: Tier;
}

export interface Kerb {
  heightM: number | null;
  stoneM: Range | null;
}

export interface Pit {
  lengthM: number;
  widthM: number;
  depthM: number;
}

export interface FieldClass {
  archetype: Archetype;
  form: PlanForm | null;
  count: number;
  /** Ranges, not midpoints: each monument is drawn from the stated band. */
  diameterM: Range;
  heightM: Range;
  stoneM: Range;
  moundLike?: boolean;
  figure?: string;
  source: Tier;
  note?: string;
}

export interface GraveFieldSpec {
  count: number;
  countSource: Tier;
  countStated: boolean;
  classes: FieldClass[];
}

export interface RampartSpec {
  /** Joins to `rampart.json` (§8) `paths[].id`. */
  id: string;
  lengthM: number | null;
  spreadM: Range | null;
  presentHeightM: Range | null;
  stoneM: Range | null;
  standingHeightM: number;
  apronIncrementM: number;
  /** The wall the app builds: standing height plus its debris apron (§5.1). */
  heightM: number;
  wallThicknessM: number;
  drystone: boolean;
  earthBacked: boolean;
  vitrified: boolean;
  entrances: Array<{ bearing: string; bearingDeg: number; widthM: Range | null }>;
  transform: string;
  source: Tier;
}

export interface FortSpec {
  /** §6.A.1. Below `params.fortConfidenceThreshold` there is no standing rampart. */
  confidence: number;
  criteria: Record<string, unknown>;
  ramparts: RampartSpec[];
}

// --------------------------------------------------- §15 (the v1.8 amendment) -

/** §15.1. `cleared` is the default for every fort, always; `settlement` is offered. */
export type InteriorState = 'cleared' | 'settlement';

/** §7.5.2's layout branch — never a different gate. */
export type InteriorTradition = 'mainland' | 'limestone-ringfort';

/** §15.2. Three kinds, one recipe (§6.H): the farm is not a single building. */
export type BuildingKind = 'longhouse' | 'ancillary' | 'grophus';

/** §15.1. How a fort's interior buildings are arranged, where the record says. */
export type BuildingLayout = 'radial' | 'grouped' | 'free';

/**
 * One archetype-H building spec (§15.2).
 *
 * Every number traces to `docs/reconstruction-mode.md` §6.H, the weakest-evidenced
 * card in the catalogue — which is why each one is a labelled default that the
 * record overrides wherever the record speaks, and why `source` and `tiers` ride
 * along with it rather than being inferred from the shape.
 */
export interface BuildingTemplate {
  kind: BuildingKind;
  count: number;
  lengthM: Range;
  widthM: Range;
  /** Long axis, 0–180°, 0 = N–S; null ⇒ the sampler chooses and says so. */
  orientationDeg: number | null;
  /** *Underbalanserad*: ~40 % of breadth (Göthberg 2000, §6.H). */
  aisleFraction: number;
  aisleWidthM: Range;
  /** ≥ 1.0 m and load-bearing — not a footing (Näsman 1976, §6.H). */
  wallHeightM: number;
  /** `hipped`. There is no gabled Iron Age longhouse in v1.8 (§6.H). */
  roofForm: string;
  roofPitchDeg: number;
  /** MUST be ≥ `roofPitchDeg` — a shallower hip is the Eketorp-II error (§6.H). */
  hipPitchDeg: number;
  smokeVent: string;
  covering: string;
  walls: string;
  trestleSpacingM: Range;
  source: Tier;
  tiers: { plan: Tier; profile: Tier; surface: Tier };
}

/** §15.1's sampler spec for the `settlement` state. */
export interface InteriorBuildings {
  /** An **upper bound** (§15.3). `null` = no count stated; the default is one. */
  count: number | null;
  countSource: Tier;
  countStated: boolean;
  layout: BuildingLayout;
  groups: number | null;
  /**
   * §7.5.2's radial **blocks** — how many quarters the inner group is cut into,
   * where the record states it. Ismantorp's *"genom fyra gator uppdelade i lika
   * många kvarter"* is the only description in the country that does, so this is
   * `null` everywhere else and the layout then draws no streets.
   */
  blocks?: number | null;
  /**
   * The street between the groups (*ringgata*), as the record measures it.
   * `null` ⇒ not stated, `fallbacks` carries `buildings.streetWidthM`, and the
   * layout falls back to a §6.H-tier assumption the panel names.
   */
  streetWidthM?: Range | null;
  /** A compass sector of the interior — KMR's own word, never a coordinate. */
  sector: string | null;
  template: BuildingTemplate | null;
  /** Field paths that fell back to a §6.H default. */
  fallbacks?: string[];
  source: Tier;
}

/** One stone-picked patch, drawn only where KMR places it (§7.5.1). */
export interface ClearedPatch {
  lengthM: number;
  widthM: number;
  orientationDeg: number | null;
  sector: string | null;
  source: Tier;
  /** The sentence that places it — a patch with no sentence is not drawn. */
  sentence: string;
}

/** §15.1's evidence block. Present even when the gate fails — a `fail` is a statement. */
export interface InteriorEvidence {
  rule: string;
  gate: 'pass' | 'fail';
  channels: string[];
  hedged: boolean;
  terms: string[];
  citations: Array<Record<string, unknown>>;
  discarded?: Record<string, number>;
  survey?: string;
}

/** §15.1 — one optional per-site block, sibling of `monuments`. */
export interface InteriorSpec {
  state: InteriorState;
  /** false ⇒ the app MUST NOT offer the settlement state, at any opacity (§7.5.3). */
  settlementOffered: boolean;
  tradition: InteriorTradition;
  ground: {
    terrainWords: string[];
    soilClass: string;
    clearedPatches: ClearedPatch[];
    source: Tier;
  };
  evidence: InteriorEvidence;
  /** `null` = the record attests buildings but states nothing about them. */
  buildings: InteriorBuildings | null;
}

/** §15.2 — one optional per-monument block, `archetype: "farmstead"` only. */
export interface FarmSpec {
  buildings: BuildingTemplate[];
  layout: 'yard' | 'radial' | 'grouped' | 'row';
  /** All false inside a fort: a yard is a recipe for open ground (§15.3). */
  features: { hearth: boolean; well: boolean; enclosure: boolean };
  /** The fort whose extent contains this record, or null. */
  insideFortId: string | null;
  source: Tier;
}

export interface Monument {
  id: string;
  lamningstyp: string;
  archetype: Archetype;
  period: { builtCE: number | null; abandonedCE: number | null };
  plan: MonumentPlan;
  profile: MonumentProfile;
  surface: MonumentSurface;
  features: { kerb: Kerb | null; pits: Pit[] };
  damaged: boolean;
  warnings: string[];
  tiers: { plan: Tier; profile: Tier; surface: Tier; placement?: Tier };
  /** Field paths that fell back to an archetype default (§14). */
  fallbacks: string[];
  parseConfidence: number;
  field?: GraveFieldSpec;
  fort?: FortSpec;
  /** §15.2. Present only on `archetype: "farmstead"`. */
  farm?: FarmSpec;
}

export interface ReconstructionParams {
  packing: number;
  apronDepthM: number;
  wallThicknessM: number;
  reposeEarthDeg: number;
  reposeStoneDeg: number;
  pitFillFactor: number;
  fortConfidenceThreshold: number;
  [key: string]: number;
}

export interface ReconstructionDerivation {
  method: string;
  description: string;
  transforms: string[];
  params: ReconstructionParams;
}

export interface ReconstructionFile {
  schemaVersion: number;
  site?: string;
  generated?: string;
  derivation: ReconstructionDerivation;
  defaults: Record<string, unknown>;
  coverage: Record<string, unknown>;
  monuments: Monument[];
  /** §15.1. Absent in a pre-v1.8 bundle, which means exactly "feature off". */
  interior?: InteriorSpec;
}

export class ReconstructionError extends Error {
  override readonly name = 'ReconstructionError';
}

export const SUPPORTED_RECONSTRUCTION_VERSION = 1;

const ARCHETYPES = new Set<string>([
  'fort', 'mound', 'stone-setting', 'cairn', 'fire-cracked-mound', 'standing-stone',
  'grave-field', 'farmstead', 'field-boundary', 'cultivated-ground', 'clearance-cairn',
  'route', 'runestone',
]);
const TIERS = new Set<string>(['measured', 'derived', 'assumed']);
const FORMS = new Set<string>(['round', 'square', 'rectangular', 'oval', 'triangular']);
const BUILDING_KINDS = new Set<string>(['longhouse', 'ancillary', 'grophus']);
const BUILDING_LAYOUTS = new Set<string>(['radial', 'grouped', 'free']);
const FARM_LAYOUTS = new Set<string>(['yard', 'radial', 'grouped', 'row']);
/** §15.3's compass sectors: KMR's own words for a part of an interior. */
const SECTORS = new Set<string>([
  'N', 'NNÖ', 'NÖ', 'ÖNÖ', 'Ö', 'ÖSÖ', 'SÖ', 'SSÖ',
  'S', 'SSV', 'SV', 'VSV', 'V', 'VNV', 'NV', 'NNV',
]);

/** Keys §14 forbids outright — a coordinate or a ground height in this file. */
const FORBIDDEN_KEYS = ['position', 'geometryLocal', 'groundM', 'elevationM'] as const;
/**
 * The same rule for §15's blocks, where it is easiest to break: a cleared patch
 * and a building are a **size, an orientation and a compass sector**, never a
 * position. The register does not place them, so neither may this file.
 */
const FORBIDDEN_PLACEMENT_KEYS = ['position', 'positionM', 'x', 'z', 'easting', 'northing'] as const;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readRange(value: unknown, label: string, source: string): Range {
  if (!Array.isArray(value) || value.length !== 2 || !finite(value[0]) || !finite(value[1])) {
    throw new ReconstructionError(`${source}: ${label} must be a [min, max] pair of finite numbers (§14).`);
  }
  const [lo, hi] = value as [number, number];
  if (lo > hi) {
    throw new ReconstructionError(`${source}: ${label} = [${lo}, ${hi}] is inverted; §14 requires min ≤ max.`);
  }
  return [lo, hi];
}

function readTier(value: unknown, label: string, source: string): Tier {
  if (typeof value !== 'string' || !TIERS.has(value)) {
    throw new ReconstructionError(
      `${source}: ${label} must be measured|derived|assumed (§9), got ${JSON.stringify(value)}.`,
    );
  }
  return value as Tier;
}

function readPositive(value: unknown, label: string, source: string): number {
  if (!finite(value) || value < 0) {
    throw new ReconstructionError(`${source}: ${label} must be a finite non-negative number, got ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * §15.3's checks on one archetype-H building spec — the second line behind
 * `reconstruct.validate_building_template`.
 *
 * `hipPitchDeg ≥ roofPitchDeg` is the Eketorp-II error written as an assertion:
 * a hip shallower than the long sides is the one roof shape the reconstruction
 * literature says was never built (§6.H). `wallHeightM ≥ 1.0` is the Lojsta
 * error: the 1930s reconstruction read a low dry-stone wall as a footing under a
 * tall roof, and later excavation corrected it.
 */
export function readBuildingTemplate(value: unknown, where: string): BuildingTemplate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReconstructionError(`${where} must be an object (§15.2).`);
  }
  const t = value as Record<string, unknown>;
  if (typeof t['kind'] !== 'string' || !BUILDING_KINDS.has(t['kind'] as string)) {
    throw new ReconstructionError(
      `${where}.kind must be longhouse|ancillary|grophus (§15.2), got ${JSON.stringify(t['kind'])}.`,
    );
  }
  for (const key of ['lengthM', 'widthM', 'aisleWidthM', 'trestleSpacingM'] as const) {
    readRange(t[key], key, where);
  }
  const roofPitch = t['roofPitchDeg'];
  const hipPitch = t['hipPitchDeg'];
  if (!finite(roofPitch) || !finite(hipPitch)) {
    throw new ReconstructionError(`${where}: roofPitchDeg and hipPitchDeg must be numbers (§15.2).`);
  }
  if ((hipPitch as number) < (roofPitch as number)) {
    throw new ReconstructionError(
      `${where}: hipPitchDeg ${hipPitch} is shallower than roofPitchDeg ${roofPitch} — a hip ` +
        'shallower than the long sides is the Eketorp-II error (§6.H, §15.3).',
    );
  }
  if (!finite(t['wallHeightM']) || (t['wallHeightM'] as number) < 1.0) {
    throw new ReconstructionError(
      `${where}.wallHeightM must be ≥ 1.0 m: the wall is load-bearing, not a footing ` +
        '(Näsman 1976, §6.H).',
    );
  }
  const aisle = t['aisleFraction'];
  if (!finite(aisle) || (aisle as number) < 0.3 || (aisle as number) > 0.6) {
    throw new ReconstructionError(`${where}.aisleFraction must be in [0.3, 0.6] (§6.H, §15.3).`);
  }
  if (t['roofForm'] !== 'hipped') {
    throw new ReconstructionError(
      `${where}.roofForm must be "hipped" — v1.8 draws no gabled Iron Age longhouse (§6.H).`,
    );
  }
  const tiers = t['tiers'] as Record<string, unknown> | undefined;
  if (typeof tiers !== 'object' || tiers === null) {
    throw new ReconstructionError(`${where}.tiers must be an object (§9.1 — one badge per part).`);
  }
  for (const key of ['plan', 'profile', 'surface'] as const) readTier(tiers[key], `tiers.${key}`, where);
  readTier(t['source'], 'source', where);
  return value as BuildingTemplate;
}

/** §15.3's "still no coordinates", applied to whatever object §15 hands over. */
function refusePlacementKeys(value: unknown, where: string): void {
  if (typeof value !== 'object' || value === null) return;
  for (const key of FORBIDDEN_PLACEMENT_KEYS) {
    if (key in (value as Record<string, unknown>)) {
      throw new ReconstructionError(
        `${where}.${key} must not appear — a patch or a building is a size, an orientation and ` +
          'a compass sector, never a position (§15.3).',
      );
    }
  }
}

/**
 * Validate the §15.1 `interior` block.
 *
 * The rule that matters most is **no citation, no state**: a fort in the
 * `settlement` state must be able to show the visitor the KMR sentence, the
 * neighbouring record or the publication it is drawn from (§7.5.3), so the app
 * refuses the pair broken rather than drawing houses it cannot source. The gate
 * itself is decided in the pipeline and never here — this is a second line, not
 * a second opinion.
 */
export function readInterior(value: unknown, source: string, archetypes: ReadonlySet<string>): InteriorSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReconstructionError(`${source}: interior must be an object (§15.1).`);
  }
  const block = value as Record<string, unknown>;
  const where = `${source}: interior`;
  if (!archetypes.has('fort')) {
    throw new ReconstructionError(
      `${where} is present but no monument is a fort — the block describes the ground inside ` +
        'an enclosure (§15.3).',
    );
  }
  if (block['state'] !== 'cleared' && block['state'] !== 'settlement') {
    throw new ReconstructionError(`${where}.state must be cleared|settlement (§15.1).`);
  }
  if (block['tradition'] !== 'mainland' && block['tradition'] !== 'limestone-ringfort') {
    throw new ReconstructionError(`${where}.tradition must be mainland|limestone-ringfort (§15.1).`);
  }
  const offered = block['settlementOffered'];
  if (typeof offered !== 'boolean') {
    throw new ReconstructionError(`${where}.settlementOffered must be a boolean (§15.3).`);
  }

  const evidence = block['evidence'] as Record<string, unknown> | undefined;
  if (typeof evidence !== 'object' || evidence === null) {
    throw new ReconstructionError(`${where}.evidence must be an object, present even on a fail (§15.1).`);
  }
  if (evidence['gate'] !== 'pass' && evidence['gate'] !== 'fail') {
    throw new ReconstructionError(`${where}.evidence.gate must be pass|fail (§15.1).`);
  }
  if ((evidence['gate'] === 'pass') !== offered) {
    throw new ReconstructionError(
      `${where}.evidence.gate and settlementOffered must agree (§15.3).`,
    );
  }
  const citations = evidence['citations'];
  if (!Array.isArray(citations)) {
    throw new ReconstructionError(`${where}.evidence.citations must be an array (§15.1).`);
  }
  if (offered && citations.length === 0) {
    throw new ReconstructionError(
      `${where}: settlementOffered is true with no citation — a fort in the settlement state ` +
        'must be able to show the sentence, record or publication it is drawn from (§7.5.3).',
    );
  }
  for (const citation of citations as Array<Record<string, unknown>>) {
    if (typeof citation?.['channel'] !== 'string') {
      throw new ReconstructionError(`${where}.evidence.citations[] each need a channel (§15.1).`);
    }
  }

  const ground = block['ground'] as Record<string, unknown> | undefined;
  if (typeof ground !== 'object' || ground === null) {
    throw new ReconstructionError(`${where}.ground must be an object (§15.1).`);
  }
  refusePlacementKeys(ground, `${where}.ground`);
  const patches = ground['clearedPatches'];
  if (patches !== undefined && !Array.isArray(patches)) {
    throw new ReconstructionError(`${where}.ground.clearedPatches must be an array (§15.1).`);
  }
  for (const [i, patch] of ((patches ?? []) as Array<Record<string, unknown>>).entries()) {
    const label = `${where}.ground.clearedPatches[${i}]`;
    refusePlacementKeys(patch, label);
    readPositive(patch['lengthM'], 'lengthM', label);
    readPositive(patch['widthM'], 'widthM', label);
    if (!patch['sentence']) {
      throw new ReconstructionError(
        `${label} must quote the sentence that places it — patches are drawn only where KMR ` +
          'places them (§7.5.1).',
      );
    }
  }

  const buildings = block['buildings'];
  if (buildings !== undefined && buildings !== null) {
    const b = buildings as Record<string, unknown>;
    const label = `${where}.buildings`;
    if (!offered) {
      throw new ReconstructionError(
        `${label} is present on a fort that failed the gate — no buildings are drawn inside it ` +
          'at any opacity, under any label (§7.5.3).',
      );
    }
    refusePlacementKeys(b, label);
    const count = b['count'];
    if (count !== null && count !== undefined && (!finite(count) || (count as number) <= 0)) {
      throw new ReconstructionError(`${label}.count must be a positive number or null (§15.1).`);
    }
    if (b['countStated'] === true && (count === null || count === undefined)) {
      throw new ReconstructionError(`${label}.countStated is true with no count (§15.1).`);
    }
    if (typeof b['layout'] !== 'string' || !BUILDING_LAYOUTS.has(b['layout'] as string)) {
      throw new ReconstructionError(`${label}.layout must be radial|grouped|free (§15.1).`);
    }
    const sector = b['sector'];
    if (sector !== null && sector !== undefined && !SECTORS.has(String(sector))) {
      throw new ReconstructionError(`${label}.sector must be a compass point (§15.3).`);
    }
    // §7.5.2's street plan. Each is the record's or it is absent, and the band
    // the pipeline enforces is enforced here too rather than trusted: a block
    // count of one is not a division and fifty is a misread, and a street of no
    // width is not a street.
    const blocks = b['blocks'];
    if (
      blocks !== null &&
      blocks !== undefined &&
      (!finite(blocks) || !Number.isInteger(blocks) || (blocks as number) < 2 || (blocks as number) > 12)
    ) {
      throw new ReconstructionError(
        `${label}.blocks must be a stated block count of 2–12, or null (§15.1).`,
      );
    }
    if (b['streetWidthM'] !== null && b['streetWidthM'] !== undefined) {
      const street = readRange(b['streetWidthM'], 'streetWidthM', label);
      if (street[0] <= 0) {
        throw new ReconstructionError(`${label}.streetWidthM must be a positive band (§15.1).`);
      }
    }
    readTier(b['countSource'], 'countSource', label);
    if (b['template'] !== null && b['template'] !== undefined) {
      readBuildingTemplate(b['template'], `${label}.template`);
    }
  }

  return value as InteriorSpec;
}

/** §15.2's `farm` block, on a farmstead record and nowhere else. */
function readFarm(value: unknown, archetype: string, where: string): FarmSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReconstructionError(`${where}.farm must be an object (§15.2).`);
  }
  if (archetype !== 'farmstead') {
    throw new ReconstructionError(
      `${where}.farm is present on a ${archetype} record — §15.2 carries it on archetype H only.`,
    );
  }
  const farm = value as Record<string, unknown>;
  refusePlacementKeys(farm, `${where}.farm`);
  const buildings = farm['buildings'];
  if (!Array.isArray(buildings)) {
    throw new ReconstructionError(`${where}.farm.buildings must be an array (§15.2).`);
  }
  buildings.forEach((building, i) => readBuildingTemplate(building, `${where}.farm.buildings[${i}]`));
  if (typeof farm['layout'] !== 'string' || !FARM_LAYOUTS.has(farm['layout'] as string)) {
    throw new ReconstructionError(`${where}.farm.layout must be yard|radial|grouped|row (§15.2).`);
  }
  const features = farm['features'] as Record<string, unknown> | undefined;
  if (typeof features !== 'object' || features === null) {
    throw new ReconstructionError(`${where}.farm.features must be an object (§15.2).`);
  }
  // §15.3: "Inside a fort, `farm.features` is all false." Hearths, wells, yards
  // and fences are a farmstead recipe for open ground; inside an enclosure they
  // are furniture nobody recorded (§7.5.3).
  if (farm['insideFortId'] && Object.values(features).some(Boolean)) {
    throw new ReconstructionError(
      `${where}.farm is inside fort ${JSON.stringify(farm['insideFortId'])} with a yard feature ` +
        'set — hearths, wells, yards and fences are refused inside an enclosure (§15.3, §7.5.3).',
    );
  }
  return value as FarmSpec;
}

/**
 * Validate a parsed `reconstruction.json` against §14.
 *
 * `knownIds`, when given, is the set of `sites.json` ids: a monument that joins to
 * nothing has no position and cannot be drawn, so it is a contract violation
 * rather than something to discover at render time.
 */
export function validateReconstruction(
  raw: unknown,
  source = 'reconstruction.json',
  knownIds?: ReadonlySet<string>,
): ReconstructionFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ReconstructionError(`${source} must be a JSON object (docs/data-formats.md §14)`);
  }
  const file = raw as Record<string, unknown>;

  if (file['schemaVersion'] !== SUPPORTED_RECONSTRUCTION_VERSION) {
    throw new ReconstructionError(
      `${source}: unsupported schemaVersion ${JSON.stringify(file['schemaVersion'])} — this build reads ` +
        `schemaVersion ${SUPPORTED_RECONSTRUCTION_VERSION} (docs/data-formats.md §14).`,
    );
  }

  const derivation = file['derivation'];
  if (typeof derivation !== 'object' || derivation === null || Array.isArray(derivation)) {
    throw new ReconstructionError(`${source}: derivation must be an object (§14) — it is what the methods panel shows.`);
  }
  const d = derivation as Record<string, unknown>;
  for (const key of ['method', 'description'] as const) {
    if (typeof d[key] !== 'string' || d[key] === '') {
      throw new ReconstructionError(`${source}: derivation.${key} must be a non-empty string (§14).`);
    }
  }
  const params = d['params'];
  if (typeof params !== 'object' || params === null) {
    throw new ReconstructionError(`${source}: derivation.params must be an object (§14).`);
  }
  // §6.A.1 makes this one load-bearing: without a threshold the app has no rule
  // for refusing to draw a standing rampart on a record that does not support one.
  if (!finite((params as Record<string, unknown>)['fortConfidenceThreshold'])) {
    throw new ReconstructionError(
      `${source}: derivation.params.fortConfidenceThreshold must be a number (§14/§6.A.1).`,
    );
  }

  const rawMonuments = file['monuments'];
  if (!Array.isArray(rawMonuments) || rawMonuments.length === 0) {
    throw new ReconstructionError(`${source}: monuments must be a non-empty array (§14).`);
  }

  const seen = new Set<string>();
  const monuments: Monument[] = rawMonuments.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ReconstructionError(`${source}: monuments[${i}] must be an object.`);
    }
    const m = entry as Record<string, unknown>;
    const id = m['id'];
    if (typeof id !== 'string' || id === '') {
      throw new ReconstructionError(`${source}: monuments[${i}].id must be a non-empty string (§14).`);
    }
    if (seen.has(id)) throw new ReconstructionError(`${source}: duplicate monument id ${JSON.stringify(id)}.`);
    seen.add(id);
    const label = `monuments[${id}]`;

    for (const key of FORBIDDEN_KEYS) {
      if (key in m) {
        throw new ReconstructionError(
          `${source}: ${label}.${key} must not appear — positions live in sites.json and ground ` +
            'height is sampled at runtime (§14).',
        );
      }
    }
    if (knownIds && !knownIds.has(id)) {
      throw new ReconstructionError(
        `${source}: ${label} does not join to any sites.json record — there is nowhere to put it (§14).`,
      );
    }

    const archetype = m['archetype'];
    if (typeof archetype !== 'string' || !ARCHETYPES.has(archetype)) {
      throw new ReconstructionError(`${source}: ${label}.archetype ${JSON.stringify(archetype)} is not a §4 key.`);
    }

    const plan = m['plan'] as Record<string, unknown> | undefined;
    if (typeof plan !== 'object' || plan === null) {
      throw new ReconstructionError(`${source}: ${label}.plan must be an object (§14).`);
    }
    if (typeof plan['form'] !== 'string' || !FORMS.has(plan['form'] as string)) {
      throw new ReconstructionError(`${source}: ${label}.plan.form ${JSON.stringify(plan['form'])} is not a §14 plan form.`);
    }
    readPositive(plan['diameterM'], 'plan.diameterM', `${source}: ${label}`);

    const profile = m['profile'] as Record<string, unknown> | undefined;
    if (typeof profile !== 'object' || profile === null) {
      throw new ReconstructionError(`${source}: ${label}.profile must be an object (§14).`);
    }
    readPositive(profile['heightM'], 'profile.heightM', `${source}: ${label}`);
    readPositive(profile['diameterM'], 'profile.diameterM', `${source}: ${label}`);
    // §9.3: a derived profile is only reversible if it keeps what it was derived
    // from, so these are required rather than optional.
    readPositive(profile['presentHeightM'], 'profile.presentHeightM', `${source}: ${label}`);
    readPositive(profile['presentDiameterM'], 'profile.presentDiameterM', `${source}: ${label}`);

    const surface = m['surface'] as Record<string, unknown> | undefined;
    if (typeof surface !== 'object' || surface === null) {
      throw new ReconstructionError(`${source}: ${label}.surface must be an object (§14).`);
    }
    readRange(surface['stoneM'], 'surface.stoneM', `${source}: ${label}`);

    const tiers = m['tiers'] as Record<string, unknown> | undefined;
    if (typeof tiers !== 'object' || tiers === null) {
      throw new ReconstructionError(`${source}: ${label}.tiers must be an object (§9.1 — one badge per part).`);
    }
    for (const key of ['plan', 'profile', 'surface'] as const) {
      readTier(tiers[key], `tiers.${key}`, `${source}: ${label}`);
    }
    if (tiers['placement'] !== undefined) readTier(tiers['placement'], 'tiers.placement', `${source}: ${label}`);

    const confidence = m['parseConfidence'];
    if (!finite(confidence) || confidence < 0 || confidence > 1) {
      throw new ReconstructionError(
        `${source}: ${label}.parseConfidence must be in [0, 1] (§14), got ${JSON.stringify(confidence)}.`,
      );
    }

    const field = m['field'] as Record<string, unknown> | undefined;
    if (field !== undefined) {
      const classes = field['classes'];
      if (!Array.isArray(classes)) {
        throw new ReconstructionError(`${source}: ${label}.field.classes must be an array (§14).`);
      }
      let enumerated = 0;
      classes.forEach((cls, j) => {
        const c = cls as Record<string, unknown>;
        const where = `${source}: ${label}.field.classes[${j}]`;
        if (typeof c['archetype'] !== 'string' || !ARCHETYPES.has(c['archetype'] as string)) {
          throw new ReconstructionError(`${where}.archetype ${JSON.stringify(c['archetype'])} is not a §4 key.`);
        }
        if (!finite(c['count']) || (c['count'] as number) < 0) {
          throw new ReconstructionError(`${where}.count must be a non-negative number (§14).`);
        }
        readRange(c['diameterM'], 'diameterM', where);
        readRange(c['heightM'], 'heightM', where);
        readRange(c['stoneM'], 'stoneM', where);
        enumerated += c['count'] as number;
      });
      // §14: the sampler places exactly `count` monuments, so the classes have to
      // account for all of them or a field silently loses monuments.
      if (finite(field['count']) && (field['count'] as number) !== enumerated) {
        throw new ReconstructionError(
          `${source}: ${label}.field classes sum to ${enumerated} but count is ${field['count']} (§14).`,
        );
      }
    }

    const fort = m['fort'] as Record<string, unknown> | undefined;
    if (fort !== undefined) {
      if (!finite(fort['confidence']) || (fort['confidence'] as number) < 0 || (fort['confidence'] as number) > 1) {
        throw new ReconstructionError(`${source}: ${label}.fort.confidence must be in [0, 1] (§6.A.1).`);
      }
      const ramparts = fort['ramparts'];
      if (!Array.isArray(ramparts) || ramparts.length === 0) {
        throw new ReconstructionError(`${source}: ${label}.fort.ramparts must be a non-empty array (§14).`);
      }
      ramparts.forEach((rampart, j) => {
        const r = rampart as Record<string, unknown>;
        const where = `${source}: ${label}.fort.ramparts[${j}]`;
        if (typeof r['id'] !== 'string' || r['id'] === '') {
          throw new ReconstructionError(`${where}.id must be a non-empty string — it joins to rampart.json §8.`);
        }
        readPositive(r['heightM'], 'heightM', where);
        readPositive(r['wallThicknessM'], 'wallThicknessM', where);
      });
    }

    if (m['farm'] !== undefined && m['farm'] !== null) {
      readFarm(m['farm'], archetype, `${source}: ${label}`);
    }

    return entry as Monument;
  });

  // §15.1's block is a sibling of `monuments`, and it is validated after them
  // because two of its rules are about them: it belongs to a fort site, and the
  // gate it carries decides whether archetype H may be drawn inside that fort.
  if (file['interior'] !== undefined && file['interior'] !== null) {
    readInterior(file['interior'], source, new Set(monuments.map((m) => m.archetype)));
  }

  return { ...(file as object), schemaVersion: SUPPORTED_RECONSTRUCTION_VERSION, monuments } as ReconstructionFile;
}

/**
 * §8 visibility gate: is this monument standing in the year the clock shows?
 *
 * The v1 behaviour (owner decision, §11.4) is a gate, not three states: a
 * monument is drawn in its "in use" form between `builtCE` and `abandonedCE` and
 * not at all outside them. That is what keeps runestones off the screen at
 * 500 CE and takes the fort away at 1050 — which §8 calls the single most likely
 * way this feature ends up lying.
 */
export function standingAt(monument: Monument, yearCE: number): boolean {
  const { builtCE, abandonedCE } = monument.period;
  if (builtCE !== null && yearCE < builtCE) return false;
  if (abandonedCE !== null && yearCE >= abandonedCE) return false;
  return true;
}

/**
 * Does this record support drawing a standing Migration Period rampart (§6.A.1)?
 *
 * Roughly four in five registered `Fornborg` records are probably not Migration
 * Period forts. A site below the threshold gets a low stone bank instead, and the
 * popup says why — a site the app cannot classify should look *unresolved*, not
 * confidently Migration Period.
 */
export function fortIsConfident(monument: Monument, params: ReconstructionParams): boolean {
  if (!monument.fort) return false;
  return monument.fort.confidence >= params.fortConfidenceThreshold;
}
