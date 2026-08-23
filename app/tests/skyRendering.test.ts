/**
 * The rendering side of the sky: the shared GLSL chunk, the lunar surface
 * schematic, and the uniforms `NightSky` pushes at both.
 *
 * None of this can be run on a GPU here — vitest is node-only and there is no
 * GL context — so what is tested is everything *around* the draw call: that the
 * shader string declares what it uses, that the water and the dome genuinely
 * share one set of uniform objects rather than two that happen to agree, that
 * the composition of three's includes is what it has to be, and that the
 * numbers going into the uniforms are the right numbers.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createSkyState, skyStateAt } from '../src/sky/atmosphere';
import {
  LUNAR_MARIA,
  LUNAR_RAY_CRATERS,
  featureAngularRadius,
  lunarAlbedoGlsl,
  MOON_RADIUS_KM,
  selenographicDirection,
} from '../src/sky/lunarFeatures';
import { NightSky } from '../src/sky/nightSky';
import { worldDirectionFromHorizontal } from '../src/sky/precession';
import { SKY_CHUNK, createSkyUniforms, lunarDiscBasis } from '../src/sky/skyChunk';
import { WATER_FRAGMENT_SHADER } from '../src/water/water';

const DEG = Math.PI / 180;

describe('the shared sky chunk', () => {
  const uniforms = createSkyUniforms();

  it('declares every uniform it is given, exactly once', () => {
    for (const name of Object.keys(uniforms)) {
      const declarations = SKY_CHUNK.match(new RegExp(`^uniform\\s+\\S+\\s+${name};`, 'gm')) ?? [];
      expect(declarations, `declaration of ${name}`).toHaveLength(1);
    }
  });

  it('uses every uniform it declares', () => {
    // A uniform that is declared and never read is a uniform someone is
    // setting for nothing — which is how a feature quietly stops working.
    for (const name of Object.keys(uniforms)) {
      const uses = SKY_CHUNK.split(name).length - 1;
      expect(uses, `uses of ${name}`).toBeGreaterThan(1);
    }
  });

  it('namespaces away from the water and the viewshed', () => {
    // water/water.ts owns uWater*, viewshed/overlay.ts owns uViewshed*, and all
    // three end up in one program on the water plane.
    for (const name of Object.keys(uniforms)) {
      expect(name.startsWith('uWater')).toBe(false);
      expect(name.startsWith('uViewshed')).toBe(false);
    }
  });

  it('exposes the four functions its consumers call', () => {
    for (const fn of ['skyGradient', 'sunRadiance', 'moonRadiance', 'starRadiance', 'skyReflection']) {
      expect(SKY_CHUNK).toContain(`${fn}(`);
    }
  });

  it('returns exactly the horizon colour at the horizon', () => {
    // Not executable here, but the *form* is checkable, and it is the whole
    // reason the fog wall stays hidden: the mix has to start at uSkyHorizon and
    // its parameter has to vanish with dir.y.
    expect(SKY_CHUNK).toContain('mix(uSkyHorizon, uSkyZenith, 1.0 - exp(-up * 4.5))');
    expect(SKY_CHUNK).toContain('float up = clamp(dir.y, 0.0, 1.0);');
  });

  it('has balanced braces and parentheses', () => {
    const count = (c: string) => SKY_CHUNK.split(c).length - 1;
    expect(count('{')).toBe(count('}'));
    expect(count('(')).toBe(count(')'));
  });
});

describe('the water shader composition', () => {
  const once = (needle: string) => WATER_FRAGMENT_SHADER.split(needle).length - 1;

  it('carries the sky chunk, so it reflects the same sky that is drawn', () => {
    expect(WATER_FRAGMENT_SHADER).toContain('skyReflection(reflected, spread)');
    expect(WATER_FRAGMENT_SHADER).toContain('uniform vec3 uSkyHorizon;');
  });

  it('keeps each three include exactly once', () => {
    expect(once('#include <logdepthbuf_pars_fragment>')).toBe(1);
    expect(once('#include <logdepthbuf_fragment>')).toBe(1);
    expect(once('#include <fog_pars_fragment>')).toBe(1);
    expect(once('#include <fog_fragment>')).toBe(1);
    expect(once('#include <colorspace_fragment>')).toBe(1);
  });

  it('converts to the output colour space before fogging, not after', () => {
    // Fog is applied in three's own pipeline *after* tone mapping and colour
    // conversion; matching that order is what keeps the water agreeing with the
    // terrain it meets at the shoreline.
    expect(WATER_FRAGMENT_SHADER.indexOf('#include <colorspace_fragment>')).toBeLessThan(
      WATER_FRAGMENT_SHADER.indexOf('#include <fog_fragment>'),
    );
  });

  it('does not tone-map, and carries the exposure by hand instead', () => {
    // Deliberate. The sky is not tone-mapped — scene.background goes through the
    // clear buffer — so a tone-mapped reflection of it would disagree with it
    // exactly at the horizon line where the two meet.
    expect(WATER_FRAGMENT_SHADER).not.toContain('tonemapping_fragment');
    expect(WATER_FRAGMENT_SHADER).toContain('uWaterExposure');
  });

  it('uses a real Fresnel term rather than the old stand-in', () => {
    expect(WATER_FRAGMENT_SHADER).toContain('0.02 + 0.98 * pow(1.0 - cosTheta, 5.0)');
    expect(WATER_FRAGMENT_SHADER).not.toContain('pow(1.0 - clamp(abs(viewDir.y)');
  });
});

describe('the lunar surface schematic', () => {
  it('places longitude and latitude zero at the sub-Earth point', () => {
    expect(selenographicDirection(0, 0)).toEqual([1, 0, 0]);
  });

  it('puts east at +y and north at +z', () => {
    const east = selenographicDirection(90, 0);
    expect(east[1]).toBeCloseTo(1, 9);
    const north = selenographicDirection(0, 90);
    expect(north[2]).toBeCloseTo(1, 9);
  });

  it('produces unit vectors', () => {
    for (const m of [...LUNAR_MARIA, ...LUNAR_RAY_CRATERS]) {
      const [x, y, z] = selenographicDirection(m.lonDeg, m.latDeg);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
    }
  });

  it('sizes a feature by the angle its diameter subtends at the moon centre', () => {
    expect(featureAngularRadius(2 * MOON_RADIUS_KM)).toBeCloseTo(1, 9);
    // Imbrium is 1145 km across, which is 18.9° of the lunar globe.
    expect(featureAngularRadius(1145) / DEG).toBeCloseTo(18.9, 1);
  });

  it('keeps every feature on the near side, where it can be seen', () => {
    // Selenographic longitude runs ±180; anything past about ±90 is on the far
    // side or the limb, and a feature there would be drawn onto the wrong face.
    for (const m of [...LUNAR_MARIA, ...LUNAR_RAY_CRATERS]) {
      expect(Math.abs(m.lonDeg), m.name).toBeLessThanOrEqual(90);
      expect(Math.abs(m.latDeg), m.name).toBeLessThan(80);
    }
  });

  it('generates one line of GLSL per named feature', () => {
    const glsl = lunarAlbedoGlsl();
    for (const m of [...LUNAR_MARIA, ...LUNAR_RAY_CRATERS]) {
      expect(glsl, m.name).toContain(`// ${m.name}`);
    }
    expect(glsl.split('dot(sel,').length - 1).toBe(LUNAR_MARIA.length + LUNAR_RAY_CRATERS.length);
  });

  it('generates GLSL with balanced delimiters and no NaNs', () => {
    const glsl = lunarAlbedoGlsl();
    expect(glsl.split('(').length).toBe(glsl.split(')').length);
    expect(glsl.split('{').length).toBe(glsl.split('}').length);
    expect(glsl).not.toContain('NaN');
    expect(SKY_CHUNK).toContain('float lunarAlbedo(vec3 sel)');
  });

  it('never drives the surface to black', () => {
    // The real contrast between mare and highland is about two to three. The
    // clamp is what stops a stack of overlapping basins claiming more.
    expect(SKY_CHUNK).toMatch(/clamp\(1\.0 - min\(dark, 0\.\d+\) \+ bright, 0\.3\d*, 1\.3\)/);
  });
});

describe('the moon disc basis', () => {
  const northEclipticPole = new THREE.Vector3(0.1, 0.94, -0.32).normalize();

  it('is orthonormal, whatever the moon is doing', () => {
    for (const [alt, az] of [[5, 90], [40, 180], [-10, 300], [80, 0]]) {
      const moonDir = worldDirectionFromHorizontal(alt, az);
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      lunarDiscBasis(moonDir, northEclipticPole, right, up);
      expect(right.length()).toBeCloseTo(1, 9);
      expect(up.length()).toBeCloseTo(1, 9);
      expect(right.dot(up)).toBeCloseTo(0, 9);
      expect(right.dot(moonDir)).toBeCloseTo(0, 9);
      expect(up.dot(moonDir)).toBeCloseTo(0, 9);
    }
  });

  it('points "up" at the moon\'s north, not at an arbitrary perpendicular', () => {
    const moonDir = worldDirectionFromHorizontal(30, 150);
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    lunarDiscBasis(moonDir, northEclipticPole, right, up);
    // `up` is the ecliptic pole with the moon-ward component taken out, so it
    // has to stay on the same side of the sky as the pole itself.
    expect(up.dot(northEclipticPole)).toBeGreaterThan(0.9);
  });

  it('is right-handed, so selenographic east lands on the right of the disc', () => {
    const moonDir = worldDirectionFromHorizontal(30, 150);
    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    lunarDiscBasis(moonDir, northEclipticPole, right, up);
    // right = moonDir x up, so (right, up, -moonDir) is a right-handed frame.
    expect(new THREE.Vector3().crossVectors(moonDir, up).dot(right)).toBeCloseTo(1, 6);
  });
});

describe('NightSky uniforms', () => {
  function apply(sunAlt: number, sunAz: number, moonAlt: number, moonAz: number, lit = 0.5) {
    const sky = new NightSky(1);
    const state = skyStateAt(sunAlt, createSkyState());
    sky.apply({
      sky: state,
      sun: { altitudeDeg: sunAlt, apparentAltitudeDeg: sunAlt, azimuthDeg: sunAz },
      moon: {
        altitudeDeg: moonAlt,
        apparentAltitudeDeg: moonAlt,
        azimuthDeg: moonAz,
        declinationDeg: 0,
        rightAscensionDeg: 0,
        eclipticLongitudeDeg: 0,
        eclipticLatitudeDeg: 0,
        distanceKm: 384400,
        angularRadiusDeg: 0.259,
        parallaxDeg: 0.95,
        elongationDeg: 90,
        illuminatedFraction: lit,
        waxing: true,
        deltaTSeconds: 0,
      },
      latDeg: 59.7556,
      siderealDeg: 137,
      jd: 2451545,
      obliquityDeg: 23.44,
    });
    return sky;
  }

  it('puts the sun where the astronomy says it is', () => {
    const sky = apply(20, 135, -30, 300);
    const expected = worldDirectionFromHorizontal(20, 135);
    expect(sky.uniforms.uSunDir.value.distanceTo(expected)).toBeLessThan(1e-9);
  });

  it('takes the horizon colour straight from the atmosphere ramp', () => {
    const sky = apply(50, 180, -30, 0);
    // The fog agreement, as an assertion: the dome's horizon and the fog colour
    // are the same number, and #8fa3b4 is the flat sky this app shipped with.
    expect(sky.uniforms.uSkyHorizon.value.getHexString()).toBe('8fa3b4');
  });

  it('turns the moon off below the horizon and on above it', () => {
    expect(apply(-40, 0, -12, 90).uniforms.uMoonBrightness.value).toBe(0);
    expect(apply(-40, 0, 30, 90).uniforms.uMoonBrightness.value).toBeCloseTo(1, 6);
  });

  it('fades the sun disc out as it sets', () => {
    expect(apply(10, 180, -30, 0).uniforms.uSunDiscIntensity.value).toBeCloseTo(1, 6);
    expect(apply(-1, 180, -30, 0).uniforms.uSunDiscIntensity.value).toBe(0);
    const setting = apply(-0.2, 180, -30, 0).uniforms.uSunDiscIntensity.value;
    expect(setting).toBeGreaterThan(0);
    expect(setting).toBeLessThan(1);
  });

  it('lights the moon from the geometric sun, not the refracted one', () => {
    // Refraction bends the light that reaches us, not the light that reaches
    // the moon, so these two are allowed — required — to differ.
    const sky = new NightSky(1);
    sky.apply({
      sky: skyStateAt(-0.5, createSkyState()),
      sun: { altitudeDeg: -1, apparentAltitudeDeg: -0.5, azimuthDeg: 270 },
      moon: null,
      latDeg: 59.7556,
      siderealDeg: 0,
      jd: 2451545,
      obliquityDeg: 23.44,
    });
    expect(sky.uniforms.uSunDir.value.y).toBeCloseTo(Math.sin(-0.5 * DEG), 9);
    expect(sky.uniforms.uSunLightDir.value.y).toBeCloseTo(Math.sin(-1 * DEG), 9);
  });

  it('carries the star fade through from the ramp', () => {
    expect(apply(30, 180, -30, 0).uniforms.uStarFade.value).toBe(0);
    expect(apply(-30, 180, 20, 90).uniforms.uStarFade.value).toBe(1);
  });

  it('works with no catalogue attached', () => {
    const sky = apply(-30, 0, 20, 90);
    expect(sky.hasStars).toBe(false);
    expect(sky.starCount).toBe(0);
  });
});
