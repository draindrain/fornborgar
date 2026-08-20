/**
 * Site data loading: manifest, the two DEM COGs, and the optional Phase-4 water
 * assets (contract §6 shoreline table + §7 connectivity grid).
 *
 * URL rule (docs/data-formats.md §0): every data URL is resolved against
 * `import.meta.env.BASE_URL` as `data/<siteId>/<path>` — never a leading slash —
 * so the app works from a GitHub Pages project subpath.
 *
 * Optional assets follow the versioning policy in the contract preamble: a
 * missing `assets` entry always means "feature off", never an error.
 */

import { fromArrayBuffer } from 'geotiff';
import { validateManifest, type GridManifest, type SiteManifest } from './manifest';
import { decodeHeights, elevationRange, type HeightGrid } from '../terrain/heightGrid';
import { boundsLocalFrom3006 } from '../lib/coords';
import type { ConnectGrid } from '../water/connectGrid';
import { validateShoreline, type ShorelineTable } from '../water/shoreline';

export const DEFAULT_SITE_ID = 'broborg';

/** `?site=` query param, defaulting to Broborg. Sanitised to a safe path segment. */
export function siteIdFromLocation(search: string = window.location.search): string {
  const raw = new URLSearchParams(search).get('site');
  if (!raw) return DEFAULT_SITE_ID;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw)) {
    throw new Error(`Invalid ?site= value ${JSON.stringify(raw)} — expected a simple site id.`);
  }
  return raw;
}

/** Base URL for a site's data directory, always ending in "/". */
export function siteDataUrl(siteId: string, base: string = import.meta.env.BASE_URL): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}data/${siteId}/`;
}

export type ProgressFn = (stage: string, fraction: number) => void;

async function fetchWithProgress(url: string, onProgress: (f: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} while fetching ${url}`);

  const lengthHeader = res.headers.get('content-length');
  const total = lengthHeader ? Number(lengthHeader) : 0;
  if (!res.body || !total) {
    onProgress(0.5);
    const buf = await res.arrayBuffer();
    onProgress(1);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(1, received / total));
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  onProgress(1);
  return merged.buffer;
}

export async function loadManifest(siteId: string): Promise<SiteManifest> {
  const url = `${siteDataUrl(siteId)}manifest.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Could not load ${url} (${res.status} ${res.statusText}). ` +
        `Has the pipeline written app/public/data/${siteId}/ yet?`,
    );
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A dev/preview server with an SPA fallback answers 200 + index.html for a
    // missing file, so say what actually happened instead of "unexpected token <".
    throw new Error(
      `${url} did not return JSON (got ${res.headers.get('content-type') ?? 'unknown content type'}). ` +
        `The site directory app/public/data/${siteId}/ is probably missing.`,
    );
  }
  return validateManifest(parsed);
}

const EPS = 1e-6;

/** Contract invariants worth catching early; cheap and they fail loudly. */
function checkGridInvariants(name: string, g: GridManifest, origin: { e: number; n: number }): void {
  const expectedW = (g.bounds3006.maxE - g.bounds3006.minE) / g.resolution;
  const expectedH = (g.bounds3006.maxN - g.bounds3006.minN) / g.resolution;
  if (Math.abs(expectedW - g.width) > EPS || Math.abs(expectedH - g.height) > EPS) {
    throw new Error(
      `manifest.grids.${name}: size ${g.width}x${g.height} disagrees with bounds3006/resolution ` +
        `(${expectedW}x${expectedH}).`,
    );
  }
  const derived = boundsLocalFrom3006(g.bounds3006, origin);
  for (const k of ['minX', 'minZ', 'maxX', 'maxZ'] as const) {
    if (Math.abs(derived[k] - g.boundsLocal[k]) > 1e-3) {
      throw new Error(
        `manifest.grids.${name}.boundsLocal.${k} = ${g.boundsLocal[k]} but origin + bounds3006 imply ` +
          `${derived[k]} (docs/data-formats.md §0).`,
      );
    }
  }
}

/**
 * Fetch one single-band int16 GeoTIFF and hand back band 1 in the §1 array
 * convention, checked against the geometry the manifest declares for it. Shared
 * by the DEM grids (§1) and the water-connectivity grid (§7) — one decode path,
 * so a dimension mismatch reads the same either way.
 */
async function loadBand(
  url: string,
  path: string,
  width: number,
  height: number,
  onProgress: (f: number) => void,
  dimsSource: string,
): Promise<ArrayLike<number>> {
  const buffer = await fetchWithProgress(url, (f) => onProgress(f * 0.85));

  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  if (image.getWidth() !== width || image.getHeight() !== height) {
    throw new Error(
      `${path}: TIFF is ${image.getWidth()}x${image.getHeight()} but ${dimsSource} declares ${width}x${height}.`,
    );
  }
  const rasters = await image.readRasters({ interleave: false });
  onProgress(0.95);
  const band = (rasters as unknown as ArrayLike<number>[])[0];
  if (!band || band.length !== width * height) {
    throw new Error(`${path}: expected a single band of ${width * height} samples.`);
  }
  return band;
}

/**
 * Fetch + decode one DEM COG into the meters `Float32Array` of the §1 array
 * convention. The manifest is authoritative for geometry; TIFF-embedded
 * georeferencing is deliberately ignored.
 */
export async function loadGrid(
  siteId: string,
  name: 'core' | 'context',
  manifest: SiteManifest,
  onProgress: (f: number) => void = () => {},
): Promise<HeightGrid> {
  const g = manifest.grids[name];
  checkGridInvariants(name, g, manifest.origin);

  const url = `${siteDataUrl(siteId)}${g.path}`;
  const band = await loadBand(url, g.path, g.width, g.height, onProgress, 'the manifest');

  const heights = decodeHeights(band, g.encoding.scale);
  const [min, max] = elevationRange(heights);
  onProgress(1);

  return {
    width: g.width,
    height: g.height,
    resolution: g.resolution,
    boundsLocal: g.boundsLocal,
    heights,
    minElevation: min,
    maxElevation: max,
  };
}

// ------------------------------------------------- Phase 4: water assets ----

/** Both §6/§7 assets, or nothing: the contract pairs them (v1.1 preamble). */
export interface WaterAssets {
  table: ShorelineTable;
  connect: ConnectGrid;
}

/** Fetch + validate the §6 century → level table. Throws `ShorelineError`. */
export async function loadShorelineTable(siteId: string, manifest: SiteManifest): Promise<ShorelineTable> {
  const path = manifest.assets?.['shoreline'];
  if (!path) throw new Error('manifest.assets.shoreline is not declared for this site.');
  const url = `${siteDataUrl(siteId)}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} while fetching ${url}`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${url} did not return JSON (got ${res.headers.get('content-type') ?? 'unknown content type'}).`);
  }
  return validateShoreline(parsed, path);
}

/**
 * Fetch + decode the §7 sea-connectivity grid.
 *
 * Contract §7: the file carries **no** manifest grid entry of its own —
 * `grids.context` is authoritative for its geometry and encoding — so a file
 * whose dimensions disagree with the context grid is a hard error, not something
 * to stretch over.
 */
export async function loadConnectGrid(
  siteId: string,
  manifest: SiteManifest,
  onProgress: (f: number) => void = () => {},
): Promise<ConnectGrid> {
  const path = manifest.assets?.['waterConnect'];
  if (!path) throw new Error('manifest.assets.waterConnect is not declared for this site.');
  const g = manifest.grids.context;

  const url = `${siteDataUrl(siteId)}${path}`;
  const band = await loadBand(
    url,
    path,
    g.width,
    g.height,
    onProgress,
    'grids.context (authoritative for its geometry, docs/data-formats.md §7)',
  );

  const values = decodeHeights(band, g.encoding.scale);
  onProgress(1);
  return {
    width: g.width,
    height: g.height,
    resolution: g.resolution,
    boundsLocal: g.boundsLocal,
    values,
  };
}

/**
 * The Phase-4 feature gate: both assets present and valid, or the feature is
 * off. A site that declares neither (plain v1, e.g. the testsite before v1.1)
 * loads exactly as before and says nothing — only a *half*-declared pair is
 * worth a warning, because that is a pipeline bug rather than a choice.
 */
export async function loadWaterAssets(
  siteId: string,
  manifest: SiteManifest,
  onProgress: (f: number) => void = () => {},
): Promise<WaterAssets | null> {
  const hasTable = Boolean(manifest.assets?.['shoreline']);
  const hasConnect = Boolean(manifest.assets?.['waterConnect']);
  if (!hasTable || !hasConnect) {
    if (hasTable !== hasConnect) {
      console.warn(
        `[fornborg] ${siteId}: assets.shoreline and assets.waterConnect are a pair ` +
          `(docs/data-formats.md §6/§7); only ${hasTable ? 'shoreline' : 'waterConnect'} is declared, ` +
          'so the paleo-shoreline layer stays off.',
      );
    }
    return null;
  }

  try {
    const table = await loadShorelineTable(siteId, manifest);
    const connect = await loadConnectGrid(siteId, manifest, onProgress);
    return { table, connect };
  } catch (error) {
    // A broken optional asset must not take the whole site down with it.
    console.error(
      `[fornborg] ${siteId}: paleo-shoreline layer disabled — ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}
