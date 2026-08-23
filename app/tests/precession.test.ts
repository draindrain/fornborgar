/**
 * Precession (sky/precession.ts) and the frames the sky is drawn in.
 *
 * The check that matters is historical rather than numerical: run the year
 * slider back far enough and the north celestial pole has to arrive at Thuban,
 * α Draconis, which was the pole star when the pyramids were built. Nothing
 * with a sign error or a factor of two in it lands on Thuban.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  directionFromEquatorial,
  equatorialFromDirection,
  equatorialToWorldMatrix,
  precessFromJ2000,
  precessionAnglesDeg,
  precessionMatrix,
  worldDirectionFromHorizontal,
} from '../src/sky/precession';
import { julianDay, localApparentSiderealDeg, solarPosition } from '../src/sky/solar';

/** α Draconis (Thuban), J2000: 14h 04m 23.35s, +64° 22′ 33.1″. */
const THUBAN = { raDeg: 211.09735, decDeg: 64.37585 };
/** α Ursae Minoris (Polaris), J2000: 02h 31m 49.09s, +89° 15′ 50.8″. */
const POLARIS = { raDeg: 37.95456, decDeg: 89.26411 };
/** α Canis Majoris (Sirius), J2000 — the catalogue's brightest entry. */
const SIRIUS = { raDeg: 101.28715, decDeg: -16.71611 };

function angularSeparationDeg(a: { raDeg: number; decDeg: number }, b: { raDeg: number; decDeg: number }) {
  const va = new THREE.Vector3(...directionFromEquatorial(a.raDeg, a.decDeg));
  const vb = new THREE.Vector3(...directionFromEquatorial(b.raDeg, b.decDeg));
  return (Math.acos(Math.max(-1, Math.min(1, va.dot(vb)))) * 180) / Math.PI;
}

describe('the pole star of a given epoch', () => {
  it('is Polaris today', () => {
    const now = precessFromJ2000(POLARIS.raDeg, POLARIS.decDeg, 2451545.0);
    expect(90 - now.decDeg).toBeLessThan(0.75);
  });

  it('is Thuban around 2700 BCE', () => {
    // The classic result: Thuban came within about a tenth of a degree of the
    // pole in the middle of the third millennium BCE.
    const jd = julianDay(-2700, 6, 21);
    const thuban = precessFromJ2000(THUBAN.raDeg, THUBAN.decDeg, jd);
    expect(90 - thuban.decDeg).toBeLessThan(1);
  });

  it('is neither at the far end of this app’s year slider', () => {
    // 1050 BCE sits between the two: Thuban has drifted off the pole and
    // Polaris has not arrived. Kochab and Pherkad were the pole stars then, and
    // neither is within a degree — the Iron Age simply had no pole star.
    const jd = julianDay(-1050, 6, 21);
    const thuban = precessFromJ2000(THUBAN.raDeg, THUBAN.decDeg, jd);
    const polaris = precessFromJ2000(POLARIS.raDeg, POLARIS.decDeg, jd);
    expect(90 - thuban.decDeg).toBeGreaterThan(5);
    expect(90 - polaris.decDeg).toBeGreaterThan(5);
  });
});

describe('the precession angles', () => {
  it('vanish at J2000', () => {
    const a = precessionAnglesDeg(2451545.0);
    expect(a.zeta).toBe(0);
    expect(a.z).toBe(0);
    expect(a.theta).toBe(0);
  });

  it('accumulate at the textbook annual rates', () => {
    // ζ and z each run at 23.06″/yr, and their sum is the annual precession in
    // right ascension m = 46.12″/yr; θ is the annual precession in declination
    // n = 20.04″/yr. Those three numbers are the whole model at first order.
    const century = precessionAnglesDeg(2451545.0 + 36525);
    expect((century.zeta * 3600) / 100).toBeCloseTo(23.06, 1);
    expect(((century.zeta + century.z) * 3600) / 100).toBeCloseTo(46.12, 1);
    expect((century.theta * 3600) / 100).toBeCloseTo(20.04, 1);
  });

  it('carry a star tens of degrees across the whole year slider', () => {
    // The reason the stars have to be precessed at all: over the 2 200 years
    // the slider spans, the equinox slides about 31° along the ecliptic, and an
    // equatorial star's coordinates move with it.
    const early = precessFromJ2000(SIRIUS.raDeg, SIRIUS.decDeg, julianDay(-1050, 1, 1));
    const late = precessFromJ2000(SIRIUS.raDeg, SIRIUS.decDeg, julianDay(1150, 1, 1));
    const moved = angularSeparationDeg(early, late);
    expect(moved).toBeGreaterThan(20);
    expect(moved).toBeLessThan(35);
  });
});

describe('the matrix form', () => {
  it('agrees with the scalar formula for every quadrant', () => {
    const jd = julianDay(400, 6, 21);
    const m = precessionMatrix(jd);
    for (const star of [THUBAN, POLARIS, SIRIUS, { raDeg: 0, decDeg: 0 }, { raDeg: 270, decDeg: -80 }]) {
      const scalar = precessFromJ2000(star.raDeg, star.decDeg, jd);
      const viaMatrix = new THREE.Vector3(...directionFromEquatorial(star.raDeg, star.decDeg))
        .applyMatrix3(m);
      const back = equatorialFromDirection(viaMatrix.x, viaMatrix.y, viaMatrix.z);
      expect(angularSeparationDeg(scalar, back)).toBeLessThan(1e-6);
    }
  });

  it('is a rotation — orthonormal and right-handed', () => {
    const m = precessionMatrix(julianDay(-1050, 6, 21));
    expect(m.determinant()).toBeCloseTo(1, 9);
    const e = m.elements;
    const col = (i: number) => new THREE.Vector3(e[i * 3], e[i * 3 + 1], e[i * 3 + 2]);
    expect(col(0).length()).toBeCloseTo(1, 9);
    expect(col(0).dot(col(1))).toBeCloseTo(0, 9);
    expect(col(1).dot(col(2))).toBeCloseTo(0, 9);
  });

  it('is the identity at J2000', () => {
    const m = precessionMatrix(2451545.0);
    const v = new THREE.Vector3(...directionFromEquatorial(SIRIUS.raDeg, SIRIUS.decDeg));
    const moved = v.clone().applyMatrix3(m);
    expect(moved.distanceTo(v)).toBeLessThan(1e-9);
  });

  it('round-trips through the direction conversions', () => {
    for (const star of [THUBAN, POLARIS, SIRIUS]) {
      const [x, y, z] = directionFromEquatorial(star.raDeg, star.decDeg);
      const back = equatorialFromDirection(x, y, z);
      expect(back.raDeg).toBeCloseTo(star.raDeg, 9);
      expect(back.decDeg).toBeCloseTo(star.decDeg, 9);
    }
  });
});

describe('the equatorial-to-world rotation', () => {
  const LAT = 59.7556;

  it('is a rotation', () => {
    const m = equatorialToWorldMatrix(LAT, 137.4);
    expect(m.determinant()).toBeCloseTo(1, 9);
  });

  it('sends the celestial pole to the right altitude and due north', () => {
    // The pole sits at an altitude equal to the latitude, exactly north.
    const pole = new THREE.Vector3(0, 0, 1).applyMatrix3(equatorialToWorldMatrix(LAT, 210));
    const altitude = (Math.asin(pole.y) * 180) / Math.PI;
    expect(altitude).toBeCloseTo(LAT, 9);
    expect(pole.x).toBeCloseTo(0, 9);
    expect(pole.z).toBeLessThan(0); // north is -z
  });

  it('puts an object on the meridian when its right ascension equals the sidereal time', () => {
    const last = 210;
    const onMeridian = new THREE.Vector3(...directionFromEquatorial(last, 20)).applyMatrix3(
      equatorialToWorldMatrix(LAT, last),
    );
    // Due south of the zenith for a declination below the latitude.
    expect(onMeridian.x).toBeCloseTo(0, 9);
    expect(onMeridian.z).toBeGreaterThan(0);
  });

  it('reproduces solarPosition when handed the sun', () => {
    // The strongest available check: the sun's place is computed by a
    // completely separate path in solar.ts, and both must land in the same spot.
    for (const solarHour of [3, 9, 12, 17.25, 22]) {
      const sun = solarPosition({ latDeg: LAT, yearCE: 400, dayOfYear: 173, solarHour });
      const last = localApparentSiderealDeg(solarHour, sun.rightAscensionDeg);
      const viaMatrix = new THREE.Vector3(
        ...directionFromEquatorial(sun.rightAscensionDeg, sun.declinationDeg),
      ).applyMatrix3(equatorialToWorldMatrix(LAT, last));
      const direct = worldDirectionFromHorizontal(sun.altitudeDeg, sun.azimuthDeg);
      expect(viaMatrix.distanceTo(direct)).toBeLessThan(1e-9);
    }
  });
});

describe('the horizontal-to-world direction', () => {
  it('puts the zenith up', () => {
    const v = worldDirectionFromHorizontal(90, 0);
    expect(v.y).toBeCloseTo(1, 9);
  });

  it('puts north at -z and east at +x, matching lighting.ts', () => {
    const north = worldDirectionFromHorizontal(0, 0);
    expect(north.z).toBeCloseTo(-1, 9);
    const east = worldDirectionFromHorizontal(0, 90);
    expect(east.x).toBeCloseTo(1, 9);
  });
});
