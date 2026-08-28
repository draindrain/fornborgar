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

/** Keys §14 forbids outright — a coordinate or a ground height in this file. */
const FORBIDDEN_KEYS = ['position', 'geometryLocal', 'groundM', 'elevationM'] as const;

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

    return entry as Monument;
  });

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
