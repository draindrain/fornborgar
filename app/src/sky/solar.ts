/**
 * Where the sun is, for a given site, year, day of the year and time of day.
 *
 * Three deliberate choices make this defensible over the app's 1050 BCE – 1150 CE
 * range instead of merely plausible:
 *
 *  1. **Time of day is local apparent solar time** — sundial time. 12:00 *is* the
 *     sun on the meridian, by definition, so the hour angle is exactly
 *     `15° × (t − 12)`. That removes the equation of time, the time zone, the
 *     site's longitude, and — the one that actually matters for prehistory — ΔT,
 *     which is around three hours of genuine uncertainty at 1000 BCE. It is also
 *     the only clock the landscape being drawn ever had.
 *  2. **Obliquity comes from Laskar (1986)**, not from Meeus's chapter-22
 *     polynomial. That one is stated as good for ±2000 years and our range starts
 *     3050 years before J2000; Laskar's holds to ±10 000.
 *  3. **The calendar is proleptic Gregorian.** The Gregorian rule tracks the
 *     tropical year, so the equinox stays put and the season↔date mapping barely
 *     moves. It is not perfectly stable — see `SOLSTICE_DRIFT_NOTE`.
 *
 * Accuracy: better than ~0.1° in the sun's direction anywhere in range, except
 * within about a degree of the horizon where refraction is inherently uncertain.
 * Sources: Meeus, *Astronomical Algorithms* 2nd ed., ch. 7 (Julian Day),
 * ch. 22 eq. 22.3 quoting Laskar, *A&A* 157 (1986) 59, ch. 25 (low-precision
 * solar coordinates), and eq. 16.4 (Sæmundsson refraction).
 */

const DEG = Math.PI / 180;

/** Stated in the methods panel; see `apparentSolarLongitudeDeg`. */
export const SOLSTICE_DRIFT_NOTE =
  'Dates are proleptic Gregorian. The Gregorian rule tracks the tropical year, so the ' +
  'seasons stay put to within a couple of days across this range — the June solstice ' +
  'falls on 21 June around 2000 CE and on about 23 June around 1050 BCE.';

export interface SolarPosition {
  /** Geometric altitude above the horizon, degrees; negative below it. */
  altitudeDeg: number;
  /** Altitude as refracted by the atmosphere — what an observer would see. */
  apparentAltitudeDeg: number;
  /** Compass azimuth, degrees: 0 = north, 90 = east. Matches terrain/lighting.ts. */
  azimuthDeg: number;
  declinationDeg: number;
  /** Apparent ecliptic longitude of the sun, degrees; 0 = March equinox. */
  solarLongitudeDeg: number;
  obliquityDeg: number;
}

/**
 * Proleptic-Gregorian calendar date -> Julian Day (Meeus ch. 7).
 *
 * `Math.floor`, not Meeus's `INT()`. Meeus writes `A = INT(y/100)` and states the
 * algorithm for positive years; truncation toward zero puts the century-leap
 * correction one day out for every BCE year, which is silent and covers half this
 * app's slider. Years are astronomical (0 = 1 BCE), matching `yearCE` everywhere
 * else in the codebase.
 */
export function julianDay(year: number, month: number, day: number): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524.5;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Day of year (1-based) -> calendar month/day in `year`.
 *
 * The slider always spans 1..365 so its position means the same thing in every
 * year; in a leap year day 366 exists and is accepted, and days from 1 March on
 * therefore name a date one later than in a common year. That is the calendar
 * being honest, not an off-by-one.
 */
export function dateFromDayOfYear(year: number, dayOfYear: number): { month: number; day: number } {
  let remaining = Math.max(1, Math.min(isLeapYear(year) ? 366 : 365, Math.round(dayOfYear)));
  let month = 0;
  for (;;) {
    const length = MONTH_LENGTHS[month] + (month === 1 && isLeapYear(year) ? 1 : 0);
    if (remaining <= length) break;
    remaining -= length;
    month += 1;
  }
  return { month: month + 1, day: remaining };
}

/** Julian Day for `dayOfYear` at `solarHour` in `year`. */
export function julianDayAt(year: number, dayOfYear: number, solarHour: number): number {
  const { month, day } = dateFromDayOfYear(year, dayOfYear);
  return julianDay(year, month, day) + (solarHour - 12) / 24;
}

/** Julian centuries from J2000.0. */
function centuries(jd: number): number {
  return (jd - 2451545.0) / 36525.0;
}

/**
 * Mean obliquity of the ecliptic, degrees — Laskar (1986), Meeus eq. 22.3.
 * Argument is in units of 10 000 Julian years from J2000.
 */
export function obliquityDeg(jd: number): number {
  const u = centuries(jd) / 100;
  const c = [-4680.93, -1.55, 1999.25, -51.38, -249.67, -39.05, 7.12, 27.87, 5.79, 2.45];
  let arcsec = 0;
  let power = u;
  for (const coefficient of c) {
    arcsec += coefficient * power;
    power *= u;
  }
  return 23 + 26 / 60 + 21.448 / 3600 + arcsec / 3600;
}

/**
 * Apparent ecliptic longitude of the sun, degrees (Meeus ch. 25, low precision).
 *
 * The equation of centre is kept: dropping it (a circular orbit) costs ±2° in
 * longitude, ±0.8° in declination and about four minutes on sunrise. It also
 * extrapolates honestly — `L0 − M` carries perihelion precession at 1.71954°/century,
 * so the 52° of apsidal motion between here and 1050 BCE is tracked rather than
 * assumed away.
 */
export function apparentSolarLongitudeDeg(jd: number): number {
  const t = centuries(jd);
  const l0 = 280.46646 + 36000.76983 * t + 0.0003032 * t * t;
  const m = 357.52911 + 35999.05029 * t - 0.0001537 * t * t;
  const c =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(m * DEG) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * m * DEG) +
    0.000289 * Math.sin(3 * m * DEG);
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  return ((lambda % 360) + 360) % 360;
}

/** Solar declination, degrees. */
export function declinationDeg(jd: number): number {
  const eps = obliquityDeg(jd);
  const lambda = apparentSolarLongitudeDeg(jd);
  return Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG)) / DEG;
}

/**
 * Atmospheric refraction, degrees, from *geometric* altitude — Sæmundsson,
 * Meeus eq. 16.4. (Bennett's better-known 34' at the horizon is a function of
 * *apparent* altitude and would need iterating from what we have.)
 *
 * Two clamps the bare formula needs: it returns a small negative above ~85°, and
 * it turns over and grows again below about −2.5°. Refraction is used for the
 * readout and for sunrise/sunset only — never to aim the light. Half a degree
 * does not move a shadowless scene, and pretending otherwise is false precision.
 */
export function refractionDeg(trueAltitudeDeg: number): number {
  const h = Math.max(trueAltitudeDeg, -1);
  const arcmin = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * DEG);
  const taper = Math.min(1, Math.max(0, (trueAltitudeDeg + 3) / 2));
  return (Math.max(0, arcmin) / 60) * taper;
}

export interface SolarQuery {
  latDeg: number;
  yearCE: number;
  /** 1-based day of the year. */
  dayOfYear: number;
  /** Local apparent solar time, hours; 12 = sun on the meridian. */
  solarHour: number;
}

/**
 * The sun's horizontal coordinates.
 *
 * Declination is evaluated at the *instant*, not at local noon: near the
 * equinoxes it moves up to 0.4°/day, so freezing it at noon would cost ~0.2° at
 * dawn. Treating apparent solar time as UT when forming the Julian Day is fine —
 * the offset is at most ~1.3 h, over which the sun's longitude moves under 0.05°.
 */
export function solarPosition(query: SolarQuery): SolarPosition {
  const jd = julianDayAt(query.yearCE, query.dayOfYear, query.solarHour);
  const dec = declinationDeg(jd);
  const h = 15 * (query.solarHour - 12);

  const phi = query.latDeg * DEG;
  const delta = dec * DEG;
  const hourAngle = h * DEG;

  const altitude =
    Math.asin(
      Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(hourAngle),
    ) / DEG;
  // 180° + atan2(...) is the compass form: 0 = north, 90 = east, matching the
  // azimuth convention terrain/lighting.ts already uses.
  const azimuth =
    (180 +
      Math.atan2(
        Math.sin(hourAngle),
        Math.cos(hourAngle) * Math.sin(phi) - Math.tan(delta) * Math.cos(phi),
      ) /
        DEG +
      360) %
    360;

  return {
    altitudeDeg: altitude,
    apparentAltitudeDeg: altitude + refractionDeg(altitude),
    azimuthDeg: azimuth,
    declinationDeg: dec,
    solarLongitudeDeg: apparentSolarLongitudeDeg(jd),
    obliquityDeg: obliquityDeg(jd),
  };
}

/**
 * Conventional geometric altitude of sunrise/sunset: 34' of horizon refraction
 * plus 16' of solar semidiameter, so the *upper limb* touches the horizon.
 */
export const SUNRISE_ALTITUDE_DEG = -0.833;

export interface Daylight {
  /** Apparent solar time of sunrise/sunset, or null under polar day/night. */
  sunriseHour: number | null;
  sunsetHour: number | null;
  polarDay: boolean;
  polarNight: boolean;
}

export function daylight(latDeg: number, yearCE: number, dayOfYear: number): Daylight {
  const dec = declinationDeg(julianDayAt(yearCE, dayOfYear, 12));
  const phi = latDeg * DEG;
  const delta = dec * DEG;
  const cosH =
    (Math.sin(SUNRISE_ALTITUDE_DEG * DEG) - Math.sin(phi) * Math.sin(delta)) /
    (Math.cos(phi) * Math.cos(delta));

  if (cosH >= 1) return { sunriseHour: null, sunsetHour: null, polarDay: false, polarNight: true };
  if (cosH <= -1) return { sunriseHour: null, sunsetHour: null, polarDay: true, polarNight: false };

  const halfDay = Math.acos(cosH) / DEG / 15;
  return {
    sunriseHour: 12 - halfDay,
    sunsetHour: 12 + halfDay,
    polarDay: false,
    polarNight: false,
  };
}

/**
 * A season word derived from the sun's longitude rather than from the calendar
 * date, so it stays right even where the proleptic-Gregorian date has slipped a
 * couple of days against the solstice (see `SOLSTICE_DRIFT_NOTE`). Northern
 * hemisphere — every site this app ships is Swedish.
 */
export function seasonLabel(solarLongitudeDeg: number): string {
  const l = ((solarLongitudeDeg % 360) + 360) % 360;
  if (l < 3 || l >= 357) return 'spring equinox';
  if (l < 87) return 'spring';
  if (l < 93) return 'midsummer';
  if (l < 177) return 'high summer';
  if (l < 183) return 'autumn equinox';
  if (l < 267) return 'autumn';
  if (l < 273) return 'midwinter';
  return 'winter';
}
