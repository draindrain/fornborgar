/**
 * ΔT — the gap between the sundial and the clock the equations of motion run on.
 *
 * Phase 10 made a point of *not* needing this. Local apparent solar time defines
 * the sun's hour angle as `15° × (t − 12)`, so the sun's place never depended on
 * how fast the Earth was turning three thousand years ago, and ΔT — three to
 * seven hours of genuine uncertainty at that end of the slider — stayed out of
 * the calculation entirely.
 *
 * The moon takes that gift away. Its hour angle is
 *
 *     H_moon = 15° × (t − 12) + α_sun − α_moon
 *
 * and α_moon can only be had from a lunar theory evaluated on **Terrestrial
 * Time**. The map from the sundial to TT *is* ΔT. Ignoring it at 1050 BCE would
 * misplace the moon by about 4° — eight lunar diameters — and shift its phase by
 * a few hours, so a moon computed without it would not be worth drawing.
 *
 * The expressions are the Espenak–Meeus polynomial set (NASA's *Five Millennium
 * Canon of Solar Eclipses*, Espenak & Meeus 2006, Appendix), which is the
 * standard fit for historical eclipse work and rests on Morrison & Stephenson's
 * telescopic and pre-telescopic timings. Its own stated uncertainty at 1000 BCE
 * is of order ±20 minutes — about 0.2° of lunar longitude, less than half a
 * lunar diameter, and far better than the 4° the correction removes.
 *
 * Only the branches this app's clock can reach are carried; see
 * `deltaTSeconds` for what happens past them.
 */

/** Where the polynomial set stops being carried here. See `deltaTSeconds`. */
export const DELTA_T_LAST_YEAR = 1700;

/**
 * ΔT = TT − UT, in seconds, for a decimal year.
 *
 * Beyond 1700 CE the value is held at its 1700 value rather than carrying the
 * eleven further branches of the canonical table. That is deliberate: this
 * app's year slider stops at 1150 CE, and even at the present day the resulting
 * error — about a minute of time — is 0.01° of lunar longitude, which is a
 * fiftieth of the moon's own width.
 */
export function deltaTSeconds(decimalYear: number): number {
  const y = Math.min(decimalYear, DELTA_T_LAST_YEAR);

  if (y < -500) {
    // Morrison & Stephenson's long-term parabola: the tidal secular
    // acceleration, and all that survives once there are no observations left.
    const u = (y - 1820) / 100;
    return -20 + 32 * u * u;
  }

  if (y < 500) {
    return poly(y / 100, [
      10583.6, -1014.41, 33.78311, -5.952053, -0.1798452, 0.022174192, 0.0090316521,
    ]);
  }

  if (y < 1600) {
    return poly((y - 1000) / 100, [
      1574.2, -556.01, 71.23472, 0.319781, -0.8503463, -0.005050998, 0.0083572073,
    ]);
  }

  return poly(y - 1600, [120, -0.9808, -0.01532, 1 / 7129]);
}

/** ΔT in days, which is the form every Julian Day needs it in. */
export function deltaTDays(decimalYear: number): number {
  return deltaTSeconds(decimalYear) / 86400;
}

/**
 * Decimal year for a Julian Day — good to a couple of days, which is all ΔT
 * needs (it changes by under a second per year at the fast end of this range).
 */
export function decimalYearFromJd(jd: number): number {
  return 2000 + (jd - 2451545.0) / 365.25;
}

function poly(x: number, coefficients: readonly number[]): number {
  let sum = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) sum = sum * x + coefficients[i];
  return sum;
}
