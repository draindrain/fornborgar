/**
 * `landcover_legend.json` — classes, palette, rules (docs/data-formats.md §10).
 *
 * The legend is the *authority* on what the §9 class raster means: it names the
 * classes, gives their ground-tint colours, says which of them carry vegetation and
 * how densely, and — the part that matters most for PLAN §6.1 honesty — carries the
 * rule engine's own words. `method`, every class `rule`, `calibration` and `caveat`
 * are disclosed **verbatim** in the methods panel; the app never paraphrases a model
 * it did not run, which is exactly why the rule list lives in this file and not in
 * app code.
 *
 * Validation follows the hard-fail style of `state/manifest.ts`, `water/shoreline.ts`
 * and `overlays/palisade.ts`: one clear message naming the offending field and citing
 * the contract section, no silent repair. The loader turns any throw into "feature
 * off" rather than a broken scene.
 */

/** Contract §10: the three procedural forms the app knows how to instance. */
export const VEGETATION_TYPES = ['conifer', 'broadleaf', 'reeds'] as const;
export type VegetationType = (typeof VEGETATION_TYPES)[number];

export interface VegetationSpec {
  type: VegetationType;
  /** Suggested instances per hectare, > 0. The app may scale it globally, never per class. */
  densityPerHa: number;
  [key: string]: unknown;
}

export interface LandcoverClass {
  /** == the raw value in the class raster (§9). Contiguous from 0. */
  index: number;
  /** Stable machine id, unique within the file. */
  id: string;
  name: string;
  /** Ground tint + legend swatch, sRGB `#rrggbb`. */
  color: string;
  /** The rule that produced this class — disclosed verbatim (§10). */
  rule: string;
  /** `null` = no instances (open / water / bare classes). */
  vegetation: VegetationSpec | null;
  /** Informational fraction of the full raster; the set sums to 1 ± 0.001. */
  areaFraction?: number;
  [key: string]: unknown;
}

export interface LandcoverLegend {
  schemaVersion: number;
  site?: string;
  /** The one century the raster models. */
  referenceYearCE: number;
  /** Water level used to derive it, m RH 2000 (from the §6 table). */
  referenceLevelM: number;
  /** One-paragraph derivation description, methods panel, verbatim. */
  method: string;
  /** One-line model caveat: first-toggle caveat + control note. */
  caveat: string;
  /** Forest/open ratio vs. the pollen literature, verbatim. */
  calibration: string;
  source?: Record<string, unknown>;
  classes: LandcoverClass[];
  [key: string]: unknown;
}

export class LandcoverError extends Error {
  override readonly name = 'LandcoverError';
}

export const SUPPORTED_LANDCOVER_VERSION = 1;
/** Contract §9: class indices are contiguous 0 … N−1 with N ≤ 32. */
export const MAX_CLASSES = 32;
/** Contract §10: `areaFraction` entries sum to 1 ± 0.001. */
export const AREA_FRACTION_TOLERANCE = 0.001;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function str(obj: Record<string, unknown>, key: string, path: string, where: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v === '') {
    throw new LandcoverError(`${path}: ${where}${key} must be a non-empty string (docs/data-formats.md §10).`);
  }
  return v;
}

function num(obj: Record<string, unknown>, key: string, path: string, where: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new LandcoverError(
      `${path}: ${where}${key} must be a finite number (got ${JSON.stringify(v)}) (docs/data-formats.md §10).`,
    );
  }
  return v;
}

function validateVegetation(raw: unknown, path: string, where: string): VegetationSpec | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LandcoverError(`${path}: ${where}vegetation must be an object or null (§10).`);
  }
  const v = raw as Record<string, unknown>;
  const type = v['type'];
  if (typeof type !== 'string' || !(VEGETATION_TYPES as readonly string[]).includes(type)) {
    throw new LandcoverError(
      `${path}: ${where}vegetation.type ${JSON.stringify(type)} is not one of ` +
        `${VEGETATION_TYPES.map((t) => JSON.stringify(t)).join(' | ')} (§10).`,
    );
  }
  const densityPerHa = num(v, 'densityPerHa', path, `${where}vegetation.`);
  if (!(densityPerHa > 0)) {
    throw new LandcoverError(`${path}: ${where}vegetation.densityPerHa must be > 0 (got ${densityPerHa}) (§10).`);
  }
  return { ...(v as object), type: type as VegetationType, densityPerHa } as VegetationSpec;
}

/**
 * Validate a parsed `landcover_legend.json`. `path` is the URL/filename used in the
 * error messages, so a bad asset says which file it came from.
 */
export function validateLandcoverLegend(raw: unknown, path = 'landcover_legend.json'): LandcoverLegend {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LandcoverError(`${path} must be a JSON object (docs/data-formats.md §10)`);
  }
  const file = raw as Record<string, unknown>;

  if (file['schemaVersion'] !== SUPPORTED_LANDCOVER_VERSION) {
    throw new LandcoverError(
      `${path}: unsupported schemaVersion ${JSON.stringify(file['schemaVersion'])} — this build reads ` +
        `schemaVersion ${SUPPORTED_LANDCOVER_VERSION} (docs/data-formats.md §10).`,
    );
  }

  const referenceYearCE = num(file, 'referenceYearCE', path, '');
  if (!Number.isInteger(referenceYearCE)) {
    throw new LandcoverError(`${path}: referenceYearCE must be an integer calendar year (got ${referenceYearCE}) (§10).`);
  }
  const referenceLevelM = num(file, 'referenceLevelM', path, '');

  // The three texts the methods panel reproduces verbatim — a model that cannot
  // state its own method, calibration and caveat does not get rendered (PLAN §6.1).
  const method = str(file, 'method', path, '');
  const caveat = str(file, 'caveat', path, '');
  const calibration = str(file, 'calibration', path, '');

  const rawClasses = file['classes'];
  if (!Array.isArray(rawClasses) || rawClasses.length === 0) {
    throw new LandcoverError(`${path}: classes must be a non-empty array (§10).`);
  }
  if (rawClasses.length > MAX_CLASSES) {
    throw new LandcoverError(
      `${path}: ${rawClasses.length} classes exceeds the ${MAX_CLASSES}-class limit (docs/data-formats.md §9).`,
    );
  }

  const seen = new Set<string>();
  let fractionTotal = 0;
  let fractionCount = 0;

  const classes: LandcoverClass[] = rawClasses.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new LandcoverError(`${path}: classes[${i}] must be an object (§10).`);
    }
    const c = entry as Record<string, unknown>;
    const where = `classes[${i}].`;

    const index = num(c, 'index', path, where);
    if (index !== i) {
      throw new LandcoverError(
        `${path}: ${where}index is ${index} but classes are sorted and contiguous from 0, so it must be ${i} (§10).`,
      );
    }

    const id = str(c, 'id', path, where);
    if (seen.has(id)) throw new LandcoverError(`${path}: duplicate class id ${JSON.stringify(id)} (§10).`);
    seen.add(id);

    const name = str(c, 'name', path, where);
    const color = str(c, 'color', path, where);
    if (!HEX_COLOR.test(color)) {
      throw new LandcoverError(`${path}: ${where}color ${JSON.stringify(color)} must be an "#rrggbb" sRGB hex (§10).`);
    }
    // The rule is what the methods panel discloses; an empty one would be the app
    // showing a class whose derivation it cannot state.
    const rule = str(c, 'rule', path, where);
    const vegetation = validateVegetation(c['vegetation'], path, where);

    const cls: LandcoverClass = { ...(c as object), index: i, id, name, color, rule, vegetation } as LandcoverClass;

    const areaFraction = c['areaFraction'];
    if (areaFraction !== undefined && areaFraction !== null) {
      if (typeof areaFraction !== 'number' || !Number.isFinite(areaFraction) || areaFraction < 0 || areaFraction > 1) {
        throw new LandcoverError(
          `${path}: ${where}areaFraction must be a number in [0, 1] (got ${JSON.stringify(areaFraction)}) (§10).`,
        );
      }
      fractionTotal += areaFraction;
      fractionCount++;
      cls.areaFraction = areaFraction;
    }

    return cls;
  });

  if (fractionCount > 0) {
    if (fractionCount !== classes.length) {
      throw new LandcoverError(
        `${path}: areaFraction is given for ${fractionCount} of ${classes.length} classes — give it for all of ` +
          'them or none (§10).',
      );
    }
    if (Math.abs(fractionTotal - 1) > AREA_FRACTION_TOLERANCE) {
      throw new LandcoverError(
        `${path}: areaFraction entries sum to ${fractionTotal.toFixed(6)}, not 1 ± ${AREA_FRACTION_TOLERANCE} (§10).`,
      );
    }
  }

  return {
    ...(file as object),
    schemaVersion: SUPPORTED_LANDCOVER_VERSION,
    referenceYearCE,
    referenceLevelM,
    method,
    caveat,
    calibration,
    classes,
  } as LandcoverLegend;
}

/** The classes that carry vegetation, in index order. */
export function vegetationClasses(legend: LandcoverLegend): (LandcoverClass & { vegetation: VegetationSpec })[] {
  return legend.classes.filter(
    (c): c is LandcoverClass & { vegetation: VegetationSpec } => c.vegetation !== null,
  );
}
