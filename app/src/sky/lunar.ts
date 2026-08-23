/**
 * Where the moon is, on the same clock the sliders already set.
 *
 * This is `solar.ts`'s harder sibling, and it differs from it in exactly one
 * uncomfortable way: **ΔT comes back**. Phase 10's headline property — that
 * local apparent solar time makes the sun's hour angle exact by definition and
 * so removes ΔT, the time zone and the equation of time from the problem — does
 * not extend to the moon. The sun defines the sundial; the moon does not. Its
 * hour angle is
 *
 *     H_moon = 15° × (t − 12) + α_sun − α_moon
 *
 * and α_moon exists only on a dynamical timescale. See `deltaT.ts` for what
 * that costs and why it is still much better than ignoring it.
 *
 * What is computed here, and from where:
 *
 *  • **Geocentric ecliptic position** from Meeus, *Astronomical Algorithms* 2nd
 *    ed., ch. 47 — the truncated ELP-2000/82 with tables 47.A and 47.B (in
 *    `lunarTables.ts`). Stated accuracy ~10″ in longitude and ~4″ in latitude,
 *    which is a hundredth of the moon's own width.
 *  • **Topocentric correction** (ch. 40). The moon's horizontal parallax is
 *    about 0.95° — nearly *twice the moon's diameter* — so a geocentric moon
 *    would sit visibly too high whenever it is low, which is exactly when
 *    anyone looks at it.
 *  • **Refraction** through `solar.ts`'s Sæmundsson implementation, so the sun
 *    and the moon are bent by the same atmosphere.
 *  • **Phase** from the elongation. Nothing draws the phase from these numbers —
 *    `skyChunk.ts` lights a sphere with the sun's direction and gets the
 *    illuminated fraction *and* the terminator's orientation for free — but the
 *    readout wants a number and the tests want something to check.
 *
 * Deliberately not modelled, all far below the ~0.01° this is otherwise good
 * to: nutation in longitude (17″, and it would have to move the sun too),
 * the moon's own libration, and the topocentric enlargement of the disc when
 * the moon is overhead (1.7 %).
 */

import { deltaTDays, decimalYearFromJd } from './deltaT';
import { TERMS_B, TERMS_LR } from './lunarTables';
import {
  apparentSolarLongitudeDeg,
  julianDayAt,
  localApparentSiderealDeg,
  obliquityDeg,
  refractionDeg,
  rightAscensionDeg,
} from './solar';

const DEG = Math.PI / 180;
/** IAU mean lunar radius, km — the disc's angular size comes from this. */
const MOON_RADIUS_KM = 1737.4;
/** IAU equatorial radius of the Earth, km — the parallax baseline. */
const EARTH_RADIUS_KM = 6378.14;

export interface LunarEcliptic {
  /** Geocentric apparent ecliptic longitude, degrees. */
  longitudeDeg: number;
  /** Geocentric ecliptic latitude, degrees. */
  latitudeDeg: number;
  /** Earth–moon distance, km. */
  distanceKm: number;
  /** Equatorial horizontal parallax, degrees. */
  parallaxDeg: number;
}

/** Julian centuries from J2000, on the dynamical timescale. */
function centuries(jde: number): number {
  return (jde - 2451545.0) / 36525.0;
}

function norm360(x: number): number {
  return ((x % 360) + 360) % 360;
}

function poly(x: number, coefficients: readonly number[]): number {
  let sum = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) sum = sum * x + coefficients[i];
  return sum;
}

/**
 * Geocentric ecliptic coordinates of the moon (Meeus ch. 47).
 *
 * `jde` is a Julian Day on the **dynamical** timescale — pass TT, not the
 * sundial. `moonPosition` does that conversion; this stays pure so Meeus's
 * worked example can be reproduced exactly.
 */
export function lunarEcliptic(jde: number): LunarEcliptic {
  const t = centuries(jde);

  // Meeus 47.1–47.5. The quartic tails matter here: over 3 000 years the T³
  // term in the mean longitude alone is worth several arcminutes.
  const lp = norm360(poly(t, [218.3164477, 481267.88123421, -0.0015786, 1 / 538841, -1 / 65194000]));
  const d = norm360(poly(t, [297.8501921, 445267.1114034, -0.0018819, 1 / 545868, -1 / 113065000]));
  const m = norm360(poly(t, [357.5291092, 35999.0502909, -0.0001536, 1 / 24490000]));
  const mp = norm360(poly(t, [134.9633964, 477198.8675055, 0.0087414, 1 / 69699, -1 / 14712000]));
  const f = norm360(poly(t, [93.272095, 483202.0175233, -0.0036539, -1 / 3526000, 1 / 863310000]));

  // Venus (A1), Jupiter (A2) and the flattening of the Earth (A3) leak into the
  // moon's motion; Meeus carries them as three extra arguments.
  const a1 = norm360(119.75 + 131.849 * t);
  const a2 = norm360(53.09 + 479264.29 * t);
  const a3 = norm360(313.45 + 481266.484 * t);

  // The eccentricity of the Earth's orbit is decreasing, so terms involving the
  // sun's mean anomaly are scaled by E (E² where M appears twice).
  const e = 1 - 0.002516 * t - 0.0000074 * t * t;

  let sumL = 0;
  let sumR = 0;
  for (const [cd, cm, cmp, cf, al, ar] of TERMS_LR) {
    const arg = (cd * d + cm * m + cmp * mp + cf * f) * DEG;
    const scale = cm === 0 ? 1 : Math.abs(cm) === 1 ? e : e * e;
    sumL += al * scale * Math.sin(arg);
    sumR += ar * scale * Math.cos(arg);
  }

  let sumB = 0;
  for (const [cd, cm, cmp, cf, ab] of TERMS_B) {
    const arg = (cd * d + cm * m + cmp * mp + cf * f) * DEG;
    const scale = cm === 0 ? 1 : Math.abs(cm) === 1 ? e : e * e;
    sumB += ab * scale * Math.sin(arg);
  }

  sumL += 3958 * Math.sin(a1 * DEG) + 1962 * Math.sin((lp - f) * DEG) + 318 * Math.sin(a2 * DEG);
  sumB +=
    -2235 * Math.sin(lp * DEG) +
    382 * Math.sin(a3 * DEG) +
    175 * Math.sin((a1 - f) * DEG) +
    175 * Math.sin((a1 + f) * DEG) +
    127 * Math.sin((lp - mp) * DEG) -
    115 * Math.sin((lp + mp) * DEG);

  const distanceKm = 385000.56 + sumR / 1000;
  return {
    longitudeDeg: norm360(lp + sumL / 1000000),
    latitudeDeg: sumB / 1000000,
    distanceKm,
    parallaxDeg: Math.asin(EARTH_RADIUS_KM / distanceKm) / DEG,
  };
}

/** Ecliptic (λ, β) to equatorial (α, δ) at obliquity ε — Meeus ch. 13. */
export function equatorialFromEcliptic(
  longitudeDeg: number,
  latitudeDeg: number,
  obliquityDegValue: number,
): { rightAscensionDeg: number; declinationDeg: number } {
  const l = longitudeDeg * DEG;
  const b = latitudeDeg * DEG;
  const eps = obliquityDegValue * DEG;
  const alpha = Math.atan2(
    Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps),
    Math.cos(l),
  );
  const delta = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l));
  return { rightAscensionDeg: norm360(alpha / DEG), declinationDeg: delta / DEG };
}

/**
 * The observer's distance from the centre of the Earth, in equatorial radii,
 * for a sea-level observer at geodetic latitude φ (Meeus ch. 11).
 *
 * Only ρ is kept, not the ρ·sin φ′ / ρ·cos φ′ pair: the parallax is applied in
 * the horizontal frame (as a shift along the vertical circle) rather than in
 * right ascension and declination, which is the same correction to within a few
 * arcseconds and avoids carrying a second coordinate conversion for it.
 */
export function geocentricRadiusFactor(latDeg: number): number {
  const u = Math.atan(0.99664719 * Math.tan(latDeg * DEG));
  const rhoSin = 0.99664719 * Math.sin(u);
  const rhoCos = Math.cos(u);
  return Math.hypot(rhoSin, rhoCos);
}

export interface LunarQuery {
  latDeg: number;
  yearCE: number;
  /** 1-based day of the year. */
  dayOfYear: number;
  /** Local apparent solar time, hours; 12 = sun on the meridian. */
  solarHour: number;
}

export interface LunarPosition {
  /** Topocentric geometric altitude, degrees; negative below the horizon. */
  altitudeDeg: number;
  /** Altitude as refracted by the atmosphere — what an observer would see. */
  apparentAltitudeDeg: number;
  /** Compass azimuth, degrees: 0 = north, 90 = east. Matches solar.ts. */
  azimuthDeg: number;
  declinationDeg: number;
  rightAscensionDeg: number;
  eclipticLongitudeDeg: number;
  eclipticLatitudeDeg: number;
  distanceKm: number;
  /** Angular radius of the disc, degrees (0.245–0.279 over the moon's orbit). */
  angularRadiusDeg: number;
  parallaxDeg: number;
  /** Sun–moon elongation as seen from the Earth, degrees. */
  elongationDeg: number;
  /** 0 = new, 1 = full. */
  illuminatedFraction: number;
  /** Waxing (toward full) or waning — for the readout's phase word. */
  waxing: boolean;
  /** ΔT applied to reach the dynamical timescale, seconds. */
  deltaTSeconds: number;
}

/**
 * The moon's horizontal coordinates, for the site and the instant the sliders
 * set.
 *
 * Note which timescale each piece runs on. The moon and the sun's right
 * ascension are evaluated at the *dynamical* instant (sundial + ΔT), because
 * that is where the theories live. The hour angle of the sun stays exactly
 * `15° × (t − 12)` because that is the definition of the clock, and local
 * sidereal time is built from the two — see `localApparentSiderealDeg`.
 */
export function moonPosition(query: LunarQuery): LunarPosition {
  const jdUt = julianDayAt(query.yearCE, query.dayOfYear, query.solarHour);
  const dtSeconds = deltaTDays(decimalYearFromJd(jdUt)) * 86400;
  const jde = jdUt + dtSeconds / 86400;

  const ecliptic = lunarEcliptic(jde);
  const eps = obliquityDeg(jde);
  const { rightAscensionDeg: alpha, declinationDeg: delta } = equatorialFromEcliptic(
    ecliptic.longitudeDeg,
    ecliptic.latitudeDeg,
    eps,
  );

  const sunRa = rightAscensionDeg(jde);
  const last = localApparentSiderealDeg(query.solarHour, sunRa);
  const hourAngle = norm360(last - alpha) * DEG;

  const phi = query.latDeg * DEG;
  const dec = delta * DEG;

  const geocentricAltitude =
    Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle)) /
    DEG;
  const azimuth = norm360(
    180 +
      Math.atan2(
        Math.sin(hourAngle),
        Math.cos(hourAngle) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
      ) /
        DEG,
  );

  // Parallax in altitude: the observer is one Earth radius off-centre, so the
  // moon appears lower than it would from the centre, by nothing at the zenith
  // and by the full ~0.95° at the horizon. Azimuth is untouched — the shift is
  // along the vertical circle.
  const rho = geocentricRadiusFactor(query.latDeg);
  const parallaxShift =
    Math.asin(rho * Math.sin(ecliptic.parallaxDeg * DEG) * Math.cos(geocentricAltitude * DEG)) / DEG;
  const altitude = geocentricAltitude - parallaxShift;

  // Elongation from the sun, and the illuminated fraction it implies. The sun
  // is treated as infinitely distant, so the phase angle is 180° − elongation;
  // the real difference is at most 0.15° and moves the lit fraction by 0.001.
  const sunLongitude = apparentSolarLongitudeDeg(jde);
  const cosElongation =
    Math.cos(ecliptic.latitudeDeg * DEG) * Math.cos((ecliptic.longitudeDeg - sunLongitude) * DEG);
  const elongation = Math.acos(Math.max(-1, Math.min(1, cosElongation))) / DEG;
  const illuminated = (1 - cosElongation) / 2;
  // Waxing while the moon is east of the sun in longitude.
  const waxing = norm360(ecliptic.longitudeDeg - sunLongitude) < 180;

  return {
    altitudeDeg: altitude,
    apparentAltitudeDeg: altitude + refractionDeg(altitude),
    azimuthDeg: azimuth,
    declinationDeg: delta,
    rightAscensionDeg: alpha,
    eclipticLongitudeDeg: ecliptic.longitudeDeg,
    eclipticLatitudeDeg: ecliptic.latitudeDeg,
    distanceKm: ecliptic.distanceKm,
    angularRadiusDeg: Math.asin(MOON_RADIUS_KM / ecliptic.distanceKm) / DEG,
    parallaxDeg: ecliptic.parallaxDeg,
    elongationDeg: elongation,
    illuminatedFraction: illuminated,
    waxing,
    deltaTSeconds: dtSeconds,
  };
}

/** The phase word the readout shows — the eight conventional lunar phases. */
export function phaseLabel(illuminatedFraction: number, waxing: boolean): string {
  const k = illuminatedFraction;
  if (k < 0.02) return 'new moon';
  if (k > 0.98) return 'full moon';
  if (Math.abs(k - 0.5) < 0.06) return waxing ? 'first quarter' : 'last quarter';
  if (k < 0.5) return waxing ? 'waxing crescent' : 'waning crescent';
  return waxing ? 'waxing gibbous' : 'waning gibbous';
}
