/**
 * Site data loading: manifest + the two DEM COGs.
 *
 * URL rule (docs/data-formats.md §0): every data URL is resolved against
 * `import.meta.env.BASE_URL` as `data/<siteId>/<path>` — never a leading slash —
 * so the app works from a GitHub Pages project subpath.
 */

import { fromArrayBuffer } from 'geotiff';
import { validateManifest, type GridManifest, type SiteManifest } from './manifest';
import { decodeHeights, elevationRange, type HeightGrid } from '../terrain/heightGrid';
import { boundsLocalFrom3006 } from '../lib/coords';

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
  const buffer = await fetchWithProgress(url, (f) => onProgress(f * 0.85));

  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  if (image.getWidth() !== g.width || image.getHeight() !== g.height) {
    throw new Error(
      `${g.path}: TIFF is ${image.getWidth()}x${image.getHeight()} but the manifest declares ` +
        `${g.width}x${g.height}.`,
    );
  }
  const rasters = await image.readRasters({ interleave: false });
  onProgress(0.95);
  const band = (rasters as unknown as ArrayLike<number>[])[0];
  if (!band || band.length !== g.width * g.height) {
    throw new Error(`${g.path}: expected a single band of ${g.width * g.height} samples.`);
  }

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
