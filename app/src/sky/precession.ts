/**
 * Precession of the equinoxes — how the stars move when the year slider does.
 *
 * The catalogue is J2000. The sun and the moon are computed in the equinox *of
 * date* (the mean-longitude terms in `solar.ts` and `lunar.ts` carry the
 * precession rate implicitly), so the stars have to be brought to the same
 * equinox or the two halves of the sky would drift apart by 42° across this
 * app's range. That drift is the point: it is why the pole star of an Iron Age
 * night is Thuban and not Polaris.
 *
 * **Meeus ch. 21 rigorous precession (IAU 1976), not a long-term model.** The
 * obliquity in `solar.ts` had to be Laskar's because Meeus's own polynomial is
 * stated for ±2000 years and misbehaves outside it, and because obliquity
 * enters the sun's declination directly. Precession is a different case: over
 * the ±3050 years this app reaches, IAU 1976 departs from the Vondrák et al.
 * (2011) long-term model by of order an arcminute. That is a thirtieth of the
 * size a first-magnitude star is drawn at — and three orders of magnitude
 * smaller than the error already being carried for want of proper motions,
 * which is *degrees* for the fastest naked-eye stars. Reaching for the
 * long-term model here would be precision spent in the wrong place, and
 * `docs/night-sky.md` says so.
 *
 * Source: Meeus, *Astronomical Algorithms* 2nd ed., ch. 21, eqs. 21.2 (the
 * J2000 form of ζ, z and θ) and 21.4.
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;
const ARCSEC = 1 / 3600;

/** The three precession angles, degrees, for a Julian Day (Meeus eq. 21.2). */
export function precessionAnglesDeg(jd: number): { zeta: number; z: number; theta: number } {
  const t = (jd - 2451545.0) / 36525.0;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    zeta: (2306.2181 * t + 0.30188 * t2 + 0.017998 * t3) * ARCSEC,
    z: (2306.2181 * t + 1.09468 * t2 + 0.018203 * t3) * ARCSEC,
    theta: (2004.3109 * t - 0.42665 * t2 - 0.041833 * t3) * ARCSEC,
  };
}

/**
 * Precess one J2000 equatorial position to the equinox of `jd` (Meeus 21.4).
 * Returns degrees, right ascension wrapped into 0…360.
 */
export function precessFromJ2000(
  raDeg: number,
  decDeg: number,
  jd: number,
): { raDeg: number; decDeg: number } {
  const { zeta, z, theta } = precessionAnglesDeg(jd);
  const alpha = (raDeg + zeta) * DEG;
  const delta = decDeg * DEG;
  const th = theta * DEG;

  const a = Math.cos(delta) * Math.sin(alpha);
  const b = Math.cos(th) * Math.cos(delta) * Math.cos(alpha) - Math.sin(th) * Math.sin(delta);
  const c = Math.sin(th) * Math.cos(delta) * Math.cos(alpha) + Math.cos(th) * Math.sin(delta);

  const ra = z + Math.atan2(a, b) / DEG;
  return { raDeg: ((ra % 360) + 360) % 360, decDeg: Math.asin(Math.max(-1, Math.min(1, c))) / DEG };
}

/**
 * The same rotation as a matrix, so 5 044 stars cost one matrix build and 5 044
 * multiplies instead of 5 044 trigonometric conversions.
 *
 * Built by *running the scalar formula above* on the three basis directions
 * rather than by re-deriving the rotation from ζ, z and θ. The two are the same
 * transform, but only one of them can disagree with `precessFromJ2000` — and
 * `tests/precession.test.ts` pins them together.
 */
export function precessionMatrix(jd: number): THREE.Matrix3 {
  const columns: number[][] = [];
  for (const basis of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]) {
    const raDeg = (Math.atan2(basis[1], basis[0]) / DEG + 360) % 360;
    const decDeg = Math.asin(basis[2]) / DEG;
    const p = precessFromJ2000(raDeg, decDeg, jd);
    columns.push(directionFromEquatorial(p.raDeg, p.decDeg));
  }
  // Matrix3.set() is row-major; `columns[i]` is the image of basis i, which is
  // column i of the matrix.
  return new THREE.Matrix3().set(
    columns[0][0], columns[1][0], columns[2][0],
    columns[0][1], columns[1][1], columns[2][1],
    columns[0][2], columns[1][2], columns[2][2],
  );
}

/**
 * Unit vector in the equatorial frame: x toward the equinox (α = 0, δ = 0),
 * y toward α = 90°, z toward the north celestial pole.
 */
export function directionFromEquatorial(raDeg: number, decDeg: number): [number, number, number] {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

/** The inverse of `directionFromEquatorial`. */
export function equatorialFromDirection(x: number, y: number, z: number): {
  raDeg: number;
  decDeg: number;
} {
  return {
    raDeg: ((Math.atan2(y, x) / DEG) % 360 + 360) % 360,
    decDeg: Math.asin(Math.max(-1, Math.min(1, z))) / DEG,
  };
}

/**
 * Equatorial (of date) to the app's world frame: +x east, +y up, +z south
 * (`lighting.ts`'s convention, where north is −z).
 *
 * This one matrix *is* the diurnal rotation. The star mesh is a group carrying
 * it, so scrubbing the time-of-day slider rewrites nine numbers and touches no
 * vertex data.
 *
 * Derived from `sin a = sin φ sin δ + cos φ cos δ cos H` and its two companions
 * with `H = θ − α`, expanded onto the equatorial basis vectors — see
 * `tests/precession.test.ts`, which checks it against `solarPosition` itself.
 */
export function equatorialToWorldMatrix(latDeg: number, lastDeg: number): THREE.Matrix3 {
  const phi = latDeg * DEG;
  const l = lastDeg * DEG;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinL = Math.sin(l);
  const cosL = Math.cos(l);
  return new THREE.Matrix3().set(
    -sinL, cosL, 0,
    cosPhi * cosL, cosPhi * sinL, sinPhi,
    sinPhi * cosL, sinPhi * sinL, -cosPhi,
  );
}

/**
 * The world-frame direction of an altitude/azimuth pair, in the same convention
 * — the sun and the moon reach the shaders through this.
 */
export function worldDirectionFromHorizontal(
  altitudeDeg: number,
  azimuthDeg: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const alt = altitudeDeg * DEG;
  const az = azimuthDeg * DEG;
  return out.set(
    Math.cos(alt) * Math.sin(az),
    Math.sin(alt),
    -Math.cos(alt) * Math.cos(az),
  );
}
