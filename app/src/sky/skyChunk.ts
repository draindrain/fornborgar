/**
 * What the sky looks like in a given direction — as GLSL, and as the uniforms
 * that feed it.
 *
 * This module is the single source of truth for the *look* of the sky, and it
 * is compiled into two different materials: the sky dome (`skyDome.ts`), which
 * evaluates it along the view ray, and the water plane (`water/water.ts`),
 * which evaluates it along the **reflected** ray. That sharing is the whole
 * design. It is why the sunset in the water is the same sunset that is in the
 * sky, why the glitter path lies under the real sun, and why none of it needs a
 * second render pass of a scene carrying 150 000 instanced trees out to 64 km.
 *
 * The uniform objects are shared **by reference** between the two materials —
 * the pattern `WaterLayer` already uses to keep the plane and the submerged
 * ground tint in step. One assignment moves the sky and its reflection together.
 *
 * ## The constraint that shapes the gradient
 *
 * `atmosphere.ts` keeps `scene.background` and the fog colour byte-identical so
 * the fog wall at the horizon is invisible. A gradient sky could easily break
 * that, so `skyGradient` is built to make it structural: at `dir.y == 0` it
 * returns `uSkyHorizon` exactly, and `uSkyHorizon` *is* `Atmosphere.state.sky`.
 * The gradient only departs from it going up. The sun's aureole is the one
 * exception — it reaches the horizon, because that is where a sunset is — and
 * the seam that leaves at the sun's azimuth is what a sky-matched fog would
 * close (see `docs/night-sky.md`).
 */

import * as THREE from 'three';

import { lunarAlbedoGlsl } from './lunarFeatures';
import { STAR_MAP_GAMMA } from './stars';

/**
 * The shared GLSL. It declares its own uniforms, so a material includes this
 * string once and then calls the functions.
 *
 * Colour space: the uniforms arrive **linear**, because that is how
 * `THREE.Color` stores the sRGB hexes the stop table authors, and radiances add
 * correctly there. Every material that includes this chunk therefore ends with
 * `#include <colorspace_fragment>` and none of them tone-map — which is what
 * makes the dome's horizon come out byte-identical to the background clear
 * colour, since three writes that through the same linear → sRGB step.
 */
export const SKY_CHUNK = /* glsl */ `
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uSkyAureole;
uniform vec3 uSunDir;
uniform vec3 uSunLightDir;
uniform vec3 uSunDiscColor;
uniform float uSunCosRadius;
uniform float uSunDiscIntensity;
uniform vec3 uMoonDir;
uniform vec3 uMoonRight;
uniform vec3 uMoonUp;
uniform vec3 uMoonColor;
uniform float uMoonCosRadius;
uniform float uMoonBrightness;
uniform float uMoonLitFraction;
uniform float uStarFade;
uniform float uStarGain;
uniform mat3 uEquatorialToWorld;
uniform sampler2D uStarMap;

#define SKY_TAU 6.283185307179586
#define SKY_PI 3.141592653589793
/** Peak radiance of the sun's disc. Well past 1: the sun clips, as it should. */
#define SKY_SUN_RADIANCE 3.4

/**
 * The sky's own colour: a horizon-to-zenith ramp plus the sun's aureole.
 * Exactly uSkyHorizon at dir.y == 0, which is what keeps the fog agreement.
 */
vec3 skyGradient(vec3 dir) {
  float up = clamp(dir.y, 0.0, 1.0);
  // An exponential rather than a power: it reaches the zenith colour over the
  // first 15° or so, which puts the horizon's colour in a band the width a
  // horizon band actually is instead of smearing it over the whole hemisphere.
  // Still exactly uSkyHorizon at up == 0, which is the fog agreement.
  vec3 base = mix(uSkyHorizon, uSkyZenith, 1.0 - exp(-up * 4.5));
  float toSun = max(dot(dir, uSunDir), 0.0);
  // Two lobes: a broad forward scatter about 35° across — the one that reddens
  // a quarter of the sky at sunset — and a tight one a few degrees across that
  // reads as the glow immediately around the disc.
  base += uSkyAureole * (0.45 * pow(toSun, 4.0) + 1.1 * pow(toSun, 300.0));
  return base;
}

/**
 * The sun's disc, antialiased across its own limb, at its true angular size.
 *
 * Half a degree is *small* — eight pixels across a 1280-wide frame at this
 * field of view — so it is drawn bright enough to clip rather than drawn
 * bigger. The tight halo around it is the scattering that happens in the
 * atmosphere and in the eye, which is the real reason the sun reads as larger
 * than the half degree it subtends.
 */
vec3 sunRadiance(vec3 dir) {
  float c = dot(dir, uSunDir);
  float edge = (1.0 - uSunCosRadius) * 0.3;
  float disc = smoothstep(uSunCosRadius - edge, uSunCosRadius + edge * 0.25, c);
  float halo = pow(max(c, 0.0), 3000.0);
  return uSunDiscColor * ((disc * SKY_SUN_RADIANCE + halo * 1.2) * uSunDiscIntensity);
}

/** Earthshine is the Earth's own daylight, so it arrives blue. */
#define SKY_EARTHSHINE vec3(0.55, 0.68, 1.0)

${lunarAlbedoGlsl()}

/**
 * The moon's disc, shaded as the sphere it is.
 *
 * For every pixel inside the disc this reconstructs the point on the lunar
 * surface it looks at, and lights that point with the sun's direction. The
 * illuminated fraction and the orientation of the terminator both fall out of
 * the geometry — there is no phase angle and no position angle of the bright
 * limb anywhere in this codebase, because none is needed.
 *
 * The reflectance is Lommel-Seeliger rather than Lambert: the moon is a rough
 * regolith, and a full moon is far brighter than twice a half moon, which is
 * why it reads as a flat disc rather than a ball.
 *
 * uMoonUp is the moon's **north**, not an arbitrary perpendicular, so the
 * reconstructed point also has selenographic coordinates — which is what lets
 * lunarAlbedo put the maria where the maria are. See lunarFeatures.ts.
 *
 * The glare belongs to the air and the eye, so it is drawn *outside* the limb
 * only. Adding it across the disc, as this did first, floods the unlit side
 * with grey and destroys the phase.
 */
vec3 moonRadiance(vec3 dir) {
  if (uMoonBrightness <= 0.0) return vec3(0.0);

  float c = dot(dir, uMoonDir);
  float angle = acos(clamp(c, -1.0, 1.0));
  float radius = acos(clamp(uMoonCosRadius, -1.0, 1.0));

  if (angle > radius) {
    float glow = 0.085 * exp(-(angle - radius) / (radius * 0.9));
    return uMoonColor * (glow * uMoonBrightness * uMoonLitFraction);
  }

  float sinRadius = max(sin(radius), 1.0e-6);
  vec3 offset = dir - c * uMoonDir;
  vec2 p = vec2(dot(offset, uMoonRight), dot(offset, uMoonUp)) / sinRadius;
  float r2 = min(dot(p, p), 1.0);
  float toward = sqrt(1.0 - r2);

  // Minus, not plus: uMoonDir points *away* from the observer, and the
  // hemisphere we can see is the one whose normals point back at us. Getting
  // this sign wrong mirrors the terminator through the centre of the disc and
  // draws every phase backwards — which is exactly what it did first time.
  vec3 n = normalize(uMoonRight * p.x + uMoonUp * p.y - uMoonDir * toward);
  float mu0 = max(dot(n, uSunLightDir), 0.0);
  float mu = max(toward, 0.02);
  float lit = mu0 / (mu0 + mu);

  // In the moon's own frame: x toward the sub-Earth point, y east, z north.
  float albedo = lunarAlbedo(vec3(toward, p.x, p.y));

  float limb = 1.0 - smoothstep(0.955, 1.0, r2);
  // Earthshine: real, and only ever *seen* on a crescent, because otherwise the
  // lit side dazzles it out. Drawn far brighter than the ~1/10 000 it is, and
  // fading out as the moon fills so it cannot grey the shadow of a gibbous one.
  // ...and fading toward the limb with the same grazing factor the lit side
  // obeys, which also softens what would otherwise be a hard dark circle
  // against the sky.
  float ashen = 0.012 * toward * (1.0 - uMoonLitFraction) * (1.0 - smoothstep(0.0, 0.08, mu0));
  vec3 col = uMoonColor * (lit * 2.0 * albedo) + SKY_EARTHSHINE * (ashen * albedo);
  return col * (limb * uMoonBrightness);
}

/**
 * The star field as a function of direction, from the baked equatorial map.
 *
 * Only the water calls this: the sky itself draws stars as points, which stay
 * crisp, while a reflection off a rippled surface smears them — so a small map
 * is not a compromise there, it is what water does to stars.
 *
 * \`dir * uEquatorialToWorld\` is the *transpose* product in GLSL, i.e. the
 * inverse of that rotation, taking a world direction back to the equator.
 */
vec3 starRadiance(vec3 dir) {
  vec3 eq = dir * uEquatorialToWorld;
  float dec = asin(clamp(eq.z, -1.0, 1.0));
  float ra = atan(eq.y, eq.x);
  vec2 uv = vec2(fract(ra / SKY_TAU), dec / SKY_PI + 0.5);
  vec3 stored = texture2D(uStarMap, uv).rgb;
  return pow(stored, vec3(${STAR_MAP_GAMMA.toFixed(1)})) * (uStarGain * uStarFade);
}

/**
 * A light of angular radius \`cosRadius\` seen in a surface of angular roughness
 * \`spread\`, normalised so that roughening the surface spreads the same energy
 * wider rather than adding any. This is what turns the sun's half-degree disc
 * into the long shimmering column under a low sun.
 */
float glossyLobe(float cosAngle, float cosRadius, float spread) {
  float angle = acos(clamp(cosAngle, -1.0, 1.0));
  float radius = acos(clamp(cosRadius, -1.0, 1.0));
  float sigma = max(radius, spread);
  float energy = (radius * radius) / (sigma * sigma);
  return exp(-0.5 * (angle * angle) / (sigma * sigma)) * energy;
}

/**
 * Everything the sky sends back along one direction, for a surface of the given
 * angular roughness: the gradient, the sun and the moon as glossy lobes, and
 * the stars. This is what the water reflects.
 */
vec3 skyReflection(vec3 dir, float spread) {
  vec3 col = skyGradient(dir);
  col += uSunDiscColor *
    (SKY_SUN_RADIANCE * uSunDiscIntensity * glossyLobe(dot(dir, uSunDir), uSunCosRadius, spread));
  col += uMoonColor *
    (2.0 * uMoonBrightness * uMoonLitFraction *
      glossyLobe(dot(dir, uMoonDir), uMoonCosRadius, spread));
  col += starRadiance(dir);
  return col;
}
`;

/** The uniform objects, shared by reference with every material that uses them. */
export interface SkyUniforms {
  uSkyHorizon: { value: THREE.Color };
  uSkyZenith: { value: THREE.Color };
  uSkyAureole: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  uSunLightDir: { value: THREE.Vector3 };
  uSunDiscColor: { value: THREE.Color };
  uSunCosRadius: { value: number };
  uSunDiscIntensity: { value: number };
  uMoonDir: { value: THREE.Vector3 };
  uMoonRight: { value: THREE.Vector3 };
  uMoonUp: { value: THREE.Vector3 };
  uMoonColor: { value: THREE.Color };
  uMoonCosRadius: { value: number };
  uMoonBrightness: { value: number };
  uMoonLitFraction: { value: number };
  uStarFade: { value: number };
  uStarGain: { value: number };
  uEquatorialToWorld: { value: THREE.Matrix3 };
  uStarMap: { value: THREE.Texture | null };
}

/**
 * The moon's colour as drawn. The lunar geometric albedo is 0.12 — asphalt —
 * but the moon in the sky is not a reflectance sample; it is the brightest
 * thing up there after the sun, and this is the colour of that.
 */
const MOON_COLOR = '#d9d4c9';

/** The sun's mean angular radius, degrees (it varies 0.262–0.271 over a year). */
export const SUN_ANGULAR_RADIUS_DEG = 0.2665;

export function createSkyUniforms(): SkyUniforms {
  return {
    uSkyHorizon: { value: new THREE.Color().setStyle('#8fa3b4', THREE.SRGBColorSpace) },
    uSkyZenith: { value: new THREE.Color().setStyle('#5d84a8', THREE.SRGBColorSpace) },
    uSkyAureole: { value: new THREE.Color(0, 0, 0) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunDiscColor: { value: new THREE.Color().setStyle('#fff4e6', THREE.SRGBColorSpace) },
    uSunCosRadius: { value: Math.cos(SUN_ANGULAR_RADIUS_DEG * (Math.PI / 180)) },
    uSunDiscIntensity: { value: 1 },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonRight: { value: new THREE.Vector3(1, 0, 0) },
    uMoonUp: { value: new THREE.Vector3(0, 0, 1) },
    uMoonColor: { value: new THREE.Color().setStyle(MOON_COLOR, THREE.SRGBColorSpace) },
    uMoonCosRadius: { value: Math.cos(0.26 * (Math.PI / 180)) },
    uMoonBrightness: { value: 0 },
    uMoonLitFraction: { value: 0 },
    uStarFade: { value: 0 },
    uStarGain: { value: 1 },
    uEquatorialToWorld: { value: new THREE.Matrix3() },
    uStarMap: { value: null },
  };
}

/**
 * The disc basis for the moon: `up` is the moon's **north**, `right` is the
 * direction that selenographic east runs on screen.
 *
 * This is what makes the maria in `lunarFeatures.ts` land in the right place
 * and the right way up. The moon's rotation axis is tilted only 1.54° from the
 * ecliptic pole, so the north ecliptic pole stands in for lunar north to within
 * a degree and a half — well inside the ±7° that libration moves the face
 * anyway. The moon never strays more than 5.5° from the ecliptic, so the
 * projection below is never near-degenerate.
 *
 * `right = moonDir × up` puts increasing selenographic longitude on the right
 * of the disc as seen with north up, which is where Mare Crisium is.
 */
export function lunarDiscBasis(
  moonDir: THREE.Vector3,
  northEclipticPole: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
): void {
  up.copy(northEclipticPole).addScaledVector(moonDir, -northEclipticPole.dot(moonDir)).normalize();
  right.copy(moonDir).cross(up).normalize();
}
