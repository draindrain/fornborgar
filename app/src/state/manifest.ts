/**
 * `manifest.json` types + validation.
 *
 * Mirrors docs/data-formats.md §2 exactly. The contract requires that we
 *   - hard-fail when `schemaVersion !== 1`, and
 *   - tolerate unknown extra keys everywhere (forward compatibility),
 * so every interface here is an open shape and validation only checks the fields
 * the app actually consumes.
 */

export const SUPPORTED_SCHEMA_VERSION = 1;

export interface Origin {
  e: number;
  n: number;
}

export interface Bounds3006 {
  minE: number;
  minN: number;
  maxE: number;
  maxN: number;
}

export interface BoundsLocal {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface GridEncoding {
  dtype: string;
  /** Multiply raw samples by this to get meters. int16 decimeters => 0.1. */
  scale: number;
  unit: string;
}

export interface GridManifest {
  path: string;
  /** Meters per pixel. */
  resolution: number;
  width: number;
  height: number;
  bounds3006: Bounds3006;
  boundsLocal: BoundsLocal;
  encoding: GridEncoding;
  minElevation: number;
  maxElevation: number;
}

export interface AttributionEntry {
  text: string;
  license?: string;
  url?: string;
}

export interface LayerEntry {
  id: string;
  name: string;
  provenance: 'measured' | 'model' | 'conjecture';
}

export interface SiteManifest {
  schemaVersion: number;
  site: { id: string; name: string; raa?: Record<string, unknown> };
  crs?: { horizontal?: string; verticalDatum?: string };
  origin: Origin;
  grids: { core: GridManifest; context: GridManifest };
  assets?: Record<string, string>;
  layers?: LayerEntry[];
  attribution?: AttributionEntry[];
  provenance?: Record<string, unknown>;
  /** Unknown extra keys are preserved and ignored. */
  [key: string]: unknown;
}

export class ManifestError extends Error {
  override readonly name = 'ManifestError';
}

function req(obj: unknown, path: string): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new ManifestError(`manifest.${path} must be an object`);
  }
  return obj as Record<string, unknown>;
}

function num(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ManifestError(`manifest.${path}.${key} must be a finite number (got ${JSON.stringify(v)})`);
  }
  return v;
}

function str(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ManifestError(`manifest.${path}.${key} must be a non-empty string`);
  }
  return v;
}

function validateGrid(raw: unknown, path: string): GridManifest {
  const g = req(raw, path);
  const p = str(g, 'path', path);
  if (p.startsWith('/') || p.includes('..')) {
    throw new ManifestError(`manifest.${path}.path must be relative with no ".." (got "${p}")`);
  }
  const bounds3006 = req(g['bounds3006'], `${path}.bounds3006`);
  const boundsLocal = req(g['boundsLocal'], `${path}.boundsLocal`);
  const encoding = req(g['encoding'], `${path}.encoding`);

  const grid: GridManifest = {
    path: p,
    resolution: num(g, 'resolution', path),
    width: num(g, 'width', path),
    height: num(g, 'height', path),
    bounds3006: {
      minE: num(bounds3006, 'minE', `${path}.bounds3006`),
      minN: num(bounds3006, 'minN', `${path}.bounds3006`),
      maxE: num(bounds3006, 'maxE', `${path}.bounds3006`),
      maxN: num(bounds3006, 'maxN', `${path}.bounds3006`),
    },
    boundsLocal: {
      minX: num(boundsLocal, 'minX', `${path}.boundsLocal`),
      minZ: num(boundsLocal, 'minZ', `${path}.boundsLocal`),
      maxX: num(boundsLocal, 'maxX', `${path}.boundsLocal`),
      maxZ: num(boundsLocal, 'maxZ', `${path}.boundsLocal`),
    },
    encoding: {
      dtype: str(encoding, 'dtype', `${path}.encoding`),
      scale: num(encoding, 'scale', `${path}.encoding`),
      unit: str(encoding, 'unit', `${path}.encoding`),
    },
    minElevation: num(g, 'minElevation', path),
    maxElevation: num(g, 'maxElevation', path),
  };

  if (!Number.isInteger(grid.width) || !Number.isInteger(grid.height) || grid.width < 2 || grid.height < 2) {
    throw new ManifestError(`manifest.${path} width/height must be integers >= 2`);
  }
  if (grid.resolution <= 0) {
    throw new ManifestError(`manifest.${path}.resolution must be > 0`);
  }
  return grid;
}

/**
 * Validate a parsed manifest. Throws `ManifestError` with a human-readable
 * message; the caller renders that on-page (there is no silent fallback).
 */
export function validateManifest(raw: unknown): SiteManifest {
  const m = req(raw, '');
  const version = m['schemaVersion'];
  if (version !== SUPPORTED_SCHEMA_VERSION) {
    throw new ManifestError(
      `Unsupported manifest schemaVersion ${JSON.stringify(version)} — this build of the app ` +
        `only reads schemaVersion ${SUPPORTED_SCHEMA_VERSION}. Regenerate the site data with a ` +
        `matching pipeline version (docs/data-formats.md).`,
    );
  }

  const site = req(m['site'], 'site');
  const origin = req(m['origin'], 'origin');
  const grids = req(m['grids'], 'grids');

  const manifest: SiteManifest = {
    ...(m as Record<string, unknown>),
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    site: {
      ...(site as object),
      id: str(site, 'id', 'site'),
      name: str(site, 'name', 'site'),
    },
    origin: { e: num(origin, 'e', 'origin'), n: num(origin, 'n', 'origin') },
    grids: {
      core: validateGrid(grids['core'], 'grids.core'),
      context: validateGrid(grids['context'], 'grids.context'),
    },
  } as SiteManifest;

  const attribution = m['attribution'];
  manifest.attribution = Array.isArray(attribution)
    ? attribution.filter((a): a is AttributionEntry => typeof (a as AttributionEntry)?.text === 'string')
    : [];

  return manifest;
}
