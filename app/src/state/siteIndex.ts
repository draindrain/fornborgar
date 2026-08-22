/**
 * The national site index (docs/national-scaleout.md §6.1) — one entry per
 * published bundle, loaded by the site picker.
 *
 * The index is a *promise about what is fetchable*: the pipeline only lists a
 * site once it is uploaded and QA-clean. So the app's job here is to be strict
 * about the shape and forgiving about everything else — an entry it cannot
 * understand is dropped with a warning rather than taking the picker down, and
 * an index that is absent entirely simply means no picker (which is exactly the
 * pre-Phase-9 experience).
 */

export interface SiteIndexFeatures {
  water: boolean;
  palisade: boolean;
  landcover: boolean;
  /** Number of §11 far-field rings the bundle ships (0 = none). */
  rings: number;
}

export interface SiteIndexEntry {
  slug: string;
  name: string;
  lamningsnummer: string;
  county: string;
  kommun: string;
  /** SWEREF 99 TM (EPSG:3006) — the picker projects these directly. */
  centerE: number;
  centerN: number;
  /** KMR's own assessment; shown as a badge, never filtered on. */
  antikvariskBedomning: string;
  extentPreset: string;
  features: SiteIndexFeatures;
  horizonKm: number | null;
  bytes: number;
  thumbnail: string;
  fornsokUrl: string;
}

export interface SiteIndex {
  schemaVersion: number;
  generated: string;
  count: number;
  totalRegistered: number;
  sites: SiteIndexEntry[];
}

export class SiteIndexError extends Error {
  override readonly name = 'SiteIndexError';
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function features(raw: unknown): SiteIndexFeatures {
  const f = (raw ?? {}) as Record<string, unknown>;
  return {
    water: f['water'] === true,
    palisade: f['palisade'] === true,
    landcover: f['landcover'] === true,
    rings: num(f['rings']) ?? 0,
  };
}

/**
 * One entry, or null when it is unusable.
 *
 * The slug is the only genuinely load-bearing field — it becomes a `?site=`
 * value and a bundle path — so it gets the same guard the deep-link parser
 * applies. Coordinates matter almost as much: an entry without them cannot be
 * placed on the map, and a dot at (0, 0) would be a lie about where a fort is.
 */
export function validateEntry(raw: unknown, index: number): SiteIndexEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const slug = str(entry['slug']);
  if (!SLUG.test(slug)) {
    console.warn(`[fornborg] index.json sites[${index}]: unusable slug ${JSON.stringify(entry['slug'])}, skipped`);
    return null;
  }
  const centerE = num(entry['centerE']);
  const centerN = num(entry['centerN']);
  if (centerE === null || centerN === null) {
    console.warn(`[fornborg] index.json sites[${index}] (${slug}): no numeric centre, skipped`);
    return null;
  }
  return {
    slug,
    name: str(entry['name'], slug),
    lamningsnummer: str(entry['lamningsnummer']),
    county: str(entry['county']),
    kommun: str(entry['kommun']),
    centerE,
    centerN,
    antikvariskBedomning: str(entry['antikvariskBedomning']),
    extentPreset: str(entry['extentPreset'], 'standard'),
    features: features(entry['features']),
    horizonKm: num(entry['horizonKm']),
    bytes: num(entry['bytes']) ?? 0,
    thumbnail: str(entry['thumbnail']),
    fornsokUrl: str(entry['fornsokUrl']),
  };
}

export function validateSiteIndex(raw: unknown): SiteIndex {
  if (typeof raw !== 'object' || raw === null) {
    throw new SiteIndexError('index.json must be an object');
  }
  const doc = raw as Record<string, unknown>;
  const version = num(doc['schemaVersion']);
  if (version !== 1) {
    throw new SiteIndexError(`index.json schemaVersion ${String(doc['schemaVersion'])} is not 1`);
  }
  if (!Array.isArray(doc['sites'])) {
    throw new SiteIndexError('index.json must carry a sites array');
  }
  const sites = doc['sites']
    .map((entry, i) => validateEntry(entry, i))
    .filter((entry): entry is SiteIndexEntry => entry !== null);

  const registry = (doc['registry'] ?? {}) as Record<string, unknown>;
  return {
    schemaVersion: 1,
    generated: str(doc['generated']),
    count: sites.length,
    totalRegistered: num(registry['totalRegistered']) ?? sites.length,
    sites,
  };
}

/** Case- and diacritic-insensitive match over the fields a person would type. */
export function matchesQuery(entry: SiteIndexEntry, query: string): boolean {
  const needle = fold(query);
  if (!needle) return true;
  return [entry.name, entry.county, entry.kommun, entry.lamningsnummer, entry.slug]
    .some((field) => fold(field).includes(needle));
}

function fold(value: string): string {
  // "Södermanland" has to be findable by typing "sodermanland": Swedish
  // keyboards are not a given for everyone looking at a Swedish dataset.
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
