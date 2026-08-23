/**
 * SWEREF 99 TM (EPSG:3006) -> WGS84 geographic, for the solar position only.
 *
 * This is the one place in the app that does projection math, and it is a
 * deliberate exception to the rule stated at the top of lib/coords.ts ("the
 * browser never does projection math"). That rule exists so no two layers can
 * disagree about where geometry sits; nothing here places anything. Latitude is
 * a *lighting* parameter — the sun's declination and hour angle need to know
 * which parallel the site is on, and the manifest only ships a projected origin.
 *
 * The inversion is Lantmäteriet's published Gauss-conformal (Krüger) series for
 * the Gauss-Krüger projections, with the SWEREF 99 TM parameters: GRS 80,
 * λ0 = 15°, k0 = 0.9996, FE = 500 000, FN = 0, φ0 = 0. It round-trips against
 * the forward projection to well under a millimetre anywhere in Sweden, which is
 * six orders of magnitude better than the sun cares about.
 */

import type { SiteManifest } from '../state/manifest';

export interface LatLon {
  latDeg: number;
  lonDeg: number;
}

// GRS 80.
const A = 6378137.0;
const F = 1 / 298.257222101;

// SWEREF 99 TM.
const LON0 = 15.0;
const K0 = 0.9996;
const FALSE_EASTING = 500000.0;
const FALSE_NORTHING = 0.0;

const DEG = Math.PI / 180;

const E2 = F * (2 - F);
const N = F / (2 - F);
/** Radius of the rectifying sphere, scaled. */
const A_HAT = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64);

// δ1..δ4 — the inverse Krüger series (projected -> conformal latitude).
const D1 = N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360;
const D2 = N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440;
const D3 = (17 * N ** 3) / 480 - (37 * N ** 4) / 840;
const D4 = (4397 * N ** 4) / 161280;

// A*..D* — conformal latitude -> geodetic latitude. These are the *starred*
// (inverse) coefficients; the unstarred forward ones are a different series and
// substituting them silently costs ~60 m of latitude.
const A_STAR = E2 + E2 ** 2 + E2 ** 3 + E2 ** 4;
const B_STAR = -(7 * E2 ** 2 + 17 * E2 ** 3 + 30 * E2 ** 4) / 6;
const C_STAR = (224 * E2 ** 3 + 889 * E2 ** 4) / 120;
const D_STAR = -(4279 * E2 ** 4) / 1260;

/** SWEREF 99 TM easting/northing (m) -> WGS84 degrees. */
export function wgs84FromSweref99tm(e: number, n: number): LatLon {
  const xi = (n - FALSE_NORTHING) / (K0 * A_HAT);
  const eta = (e - FALSE_EASTING) / (K0 * A_HAT);

  const xiPrime =
    xi -
    (D1 * Math.sin(2 * xi) * Math.cosh(2 * eta) +
      D2 * Math.sin(4 * xi) * Math.cosh(4 * eta) +
      D3 * Math.sin(6 * xi) * Math.cosh(6 * eta) +
      D4 * Math.sin(8 * xi) * Math.cosh(8 * eta));
  const etaPrime =
    eta -
    (D1 * Math.cos(2 * xi) * Math.sinh(2 * eta) +
      D2 * Math.cos(4 * xi) * Math.sinh(4 * eta) +
      D3 * Math.cos(6 * xi) * Math.sinh(6 * eta) +
      D4 * Math.cos(8 * xi) * Math.sinh(8 * eta));

  const conformal = Math.asin(Math.sin(xiPrime) / Math.cosh(etaPrime));
  const dLon = Math.atan(Math.sinh(etaPrime) / Math.cos(xiPrime));

  const s2 = Math.sin(conformal) ** 2;
  const lat =
    conformal +
    Math.sin(conformal) *
      Math.cos(conformal) *
      (A_STAR + B_STAR * s2 + C_STAR * s2 * s2 + D_STAR * s2 * s2 * s2);

  return { latDeg: lat / DEG, lonDeg: LON0 + dLon / DEG };
}

function isLatLon(value: unknown): value is LatLon {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['latDeg'] === 'number' &&
    Number.isFinite(v['latDeg']) &&
    typeof v['lonDeg'] === 'number' &&
    Number.isFinite(v['lonDeg'])
  );
}

/**
 * Where the site is, in degrees.
 *
 * A `site.latLon` field in the manifest wins if the pipeline ever starts
 * emitting one — bundles already published to the object host never will, so the
 * derived path is the one that has to work, and it is exact anyway.
 */
export function siteLatLon(manifest: SiteManifest): LatLon {
  const declared = (manifest.site as unknown as Record<string, unknown>)['latLon'];
  if (isLatLon(declared)) return { latDeg: declared.latDeg, lonDeg: declared.lonDeg };
  return wgs84FromSweref99tm(manifest.origin.e, manifest.origin.n);
}
