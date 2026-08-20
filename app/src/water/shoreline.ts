/**
 * `shoreline.json` types, validation, interpolation and formatting
 * (docs/data-formats.md §6, PLAN §4.5).
 *
 * The table is a *model* (PLAN §6.1): the pipeline derives it from SGU's
 * strandförskjutningsmodell, the app only reads it. Nothing here computes a
 * shoreline — it looks one up and, for continuous scrubbing, interpolates
 * linearly between the century steps the contract explicitly permits.
 *
 * Validation follows the hard-fail style of state/manifest.ts: one clear
 * message naming the offending field, no silent repair.
 */

export interface ShorelineStep {
  /** Signed calendar year, negative = BCE (astronomical numbering). */
  yearCE: number;
  /** SGU's years-before-1950 key; informational. */
  bp?: number;
  /** Water level to draw, meters RH 2000. */
  levelM: number;
}

export interface ShorelineTable {
  schemaVersion: number;
  site?: string;
  /** One-paragraph derivation description, shown verbatim in the methods panel. */
  method?: string;
  /** One-line caveat shown next to the control (PLAN §6.1). */
  uncertainty?: string;
  datumNote?: string;
  source?: Record<string, unknown>;
  steps: ShorelineStep[];
  [key: string]: unknown;
}

export class ShorelineError extends Error {
  override readonly name = 'ShorelineError';
}

export const SUPPORTED_SHORELINE_VERSION = 1;

/**
 * Validate a parsed shoreline table. `path` is the URL/filename used in error
 * messages so a bad asset says which file it came from.
 */
export function validateShoreline(raw: unknown, path = 'shoreline.json'): ShorelineTable {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ShorelineError(`${path} must be a JSON object (docs/data-formats.md §6)`);
  }
  const t = raw as Record<string, unknown>;

  if (t['schemaVersion'] !== SUPPORTED_SHORELINE_VERSION) {
    throw new ShorelineError(
      `${path}: unsupported schemaVersion ${JSON.stringify(t['schemaVersion'])} — this build reads ` +
        `schemaVersion ${SUPPORTED_SHORELINE_VERSION} (docs/data-formats.md §6).`,
    );
  }

  const rawSteps = t['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length < 2) {
    throw new ShorelineError(`${path}: steps must be an array of at least 2 entries (§6).`);
  }

  const steps: ShorelineStep[] = rawSteps.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ShorelineError(`${path}: steps[${i}] must be an object.`);
    }
    const s = entry as Record<string, unknown>;
    const yearCE = s['yearCE'];
    const levelM = s['levelM'];
    if (typeof yearCE !== 'number' || !Number.isFinite(yearCE)) {
      throw new ShorelineError(`${path}: steps[${i}].yearCE must be a finite number (got ${JSON.stringify(yearCE)}).`);
    }
    if (typeof levelM !== 'number' || !Number.isFinite(levelM)) {
      throw new ShorelineError(`${path}: steps[${i}].levelM must be a finite number (got ${JSON.stringify(levelM)}).`);
    }
    const step: ShorelineStep = { yearCE, levelM };
    if (typeof s['bp'] === 'number' && Number.isFinite(s['bp'])) step.bp = s['bp'];
    return step;
  });

  for (let i = 1; i < steps.length; i++) {
    if (!(steps[i].yearCE > steps[i - 1].yearCE)) {
      throw new ShorelineError(
        `${path}: steps must be sorted strictly ascending by yearCE — steps[${i - 1}].yearCE = ` +
          `${steps[i - 1].yearCE} is not before steps[${i}].yearCE = ${steps[i].yearCE} (§6).`,
      );
    }
    if (!(steps[i].levelM <= steps[i - 1].levelM)) {
      throw new ShorelineError(
        `${path}: levelM must be non-increasing with yearCE (post-glacial uplift) — steps[${i}].levelM = ` +
          `${steps[i].levelM} rises above steps[${i - 1}].levelM = ${steps[i - 1].levelM} (§6).`,
      );
    }
  }

  return { ...(t as object), schemaVersion: SUPPORTED_SHORELINE_VERSION, steps } as ShorelineTable;
}

/** The slider's extent: [oldest, newest] yearCE in the table (§6). */
export function yearRange(table: ShorelineTable): [number, number] {
  return [table.steps[0].yearCE, table.steps[table.steps.length - 1].yearCE];
}

/**
 * Water level (m) at any year, linearly interpolated between the two adjacent
 * century steps (§6 permits this for continuous scrubbing) and **clamped** to the
 * table's extent outside it — the model says nothing beyond its own range, and a
 * flat extrapolation is the honest reading of that.
 */
export function levelAt(table: ShorelineTable, yearCE: number): number {
  const steps = table.steps;
  if (yearCE <= steps[0].yearCE) return steps[0].levelM;
  const last = steps[steps.length - 1];
  if (yearCE >= last.yearCE) return last.levelM;

  // Binary search for the bracketing pair; tables are small but this is exact.
  let lo = 0;
  let hi = steps.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].yearCE <= yearCE) lo = mid;
    else hi = mid;
  }
  const a = steps[lo];
  const b = steps[hi];
  const f = (yearCE - a.yearCE) / (b.yearCE - a.yearCE);
  return a.levelM + (b.levelM - a.levelM) * f;
}

/**
 * "1050 BCE" / "550 CE", never a year zero.
 *
 * The contract (§6) fixes the mapping: `-1050` reads as "1050 BCE", i.e. yearCE
 * carries the sign of an astronomical year but is *displayed* as a plain
 * era-suffixed number. Astronomical year 0 is 1 BCE in that convention, and the
 * SGU-shaped century steps (yearCE ≡ 50 mod 100) never land on it — only
 * continuous scrubbing can, so it is handled rather than left to print "0 CE".
 */
export function formatYear(yearCE: number): string {
  const y = Math.round(yearCE);
  if (y > 0) return `${y} CE`;
  if (y === 0) return '1 BCE';
  return `${-y} BCE`;
}

/** "+8.4 m above present sea" — the level half of the Phase-4 readout. */
export function formatLevel(levelM: number): string {
  const v = levelM.toFixed(1);
  return `${levelM >= 0 ? '+' : ''}${v} m above present sea`;
}

/** The full readout the control panel and dev hooks share. */
export function formatReadout(yearCE: number, levelM: number): string {
  return `${formatYear(yearCE)} · ${formatLevel(levelM)}`;
}
