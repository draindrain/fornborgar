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
  /**
   * v1.4 §11, ring entries only: a far-water connectivity grid on this ring's
   * exact geometry (at most one ring carries it). Rendering only — analysis
   * stays on the §7 context connect grid.
   */
  waterConnect?: string;
}

/** v1.4 §11: the informational ladder-depth derivation, for the methods panel. */
export interface HorizonInfo {
  crownM: number;
  floorM: number;
  eyeM: number;
  distanceKm: number;
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
  grids: {
    core: GridManifest;
    context: GridManifest;
    /** v1.4 §11: optional far-field rings, ordered inside-out. Absent = feature off. */
    rings?: GridManifest[];
  };
  /** v1.4 §11: present iff `grids.rings` is (informational). */
  horizon?: HorizonInfo;
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
 * v1.4 §11: validate `grids.rings`. Throws on any violation; the caller catches,
 * warns and drops the whole array — a malformed optional asset must never take
 * the site down (the horizon guarantee is a data guarantee).
 */
function validateRings(raw: unknown, context: GridManifest): GridManifest[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ManifestError('manifest.grids.rings must be a non-empty array when present (§11)');
  }
  let waterConnects = 0;
  let previous = context;
  let previousName = 'grids.context';
  const rings = raw.map((entry, index) => {
    const name = `grids.rings[${index}]`;
    const ring = validateGrid(entry, name);
    const inner = previous.boundsLocal;
    const outer = ring.boundsLocal;
    if (!(outer.minX < inner.minX && outer.minZ < inner.minZ && inner.maxX < outer.maxX && inner.maxZ < outer.maxZ)) {
      throw new ManifestError(
        `manifest.${name} must strictly contain ${previousName} (§11 inside-out containment chain)`,
      );
    }
    if (ring.resolution <= previous.resolution) {
      throw new ManifestError(
        `manifest.${name}.resolution ${ring.resolution} must be coarser than ${previousName}'s ${previous.resolution} (§11)`,
      );
    }
    const connect = (entry as Record<string, unknown>)['waterConnect'];
    if (connect !== undefined) {
      if (typeof connect !== 'string' || connect.length === 0 || connect.startsWith('/') || connect.includes('..')) {
        throw new ManifestError(`manifest.${name}.waterConnect must be a relative path with no ".."`);
      }
      ring.waterConnect = connect;
      waterConnects += 1;
    }
    previous = ring;
    previousName = name;
    return ring;
  });
  if (waterConnects > 1) {
    throw new ManifestError('manifest.grids.rings: at most one ring may carry waterConnect (§11)');
  }
  return rings;
}

/** v1.4 §11: the informational horizon block, or null when absent/malformed. */
function validateHorizon(raw: unknown): HorizonInfo | null {
  if (raw === undefined || raw === null) return null;
  const h = req(raw, 'horizon');
  return {
    crownM: num(h, 'crownM', 'horizon'),
    floorM: num(h, 'floorM', 'horizon'),
    eyeM: num(h, 'eyeM', 'horizon'),
    distanceKm: num(h, 'distanceKm', 'horizon'),
  };
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

  // v1.4 §11: rings and the horizon block are optional AND non-fatal — a
  // malformed entry is a pipeline bug worth a loud console line, but the site
  // must still load exactly as a ringless one would.
  if (grids['rings'] !== undefined) {
    try {
      manifest.grids.rings = validateRings(grids['rings'], manifest.grids.context);
    } catch (error) {
      delete manifest.grids.rings;
      console.warn(
        `[fornborg] far-field rings dropped — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    const horizon = validateHorizon(m['horizon']);
    if (horizon) manifest.horizon = horizon;
    else delete manifest.horizon;
  } catch (error) {
    delete manifest.horizon;
    console.warn(
      `[fornborg] horizon block dropped — ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const attribution = m['attribution'];
  manifest.attribution = Array.isArray(attribution)
    ? attribution.filter((a): a is AttributionEntry => typeof (a as AttributionEntry)?.text === 'string')
    : [];

  return manifest;
}
