/**
 * Sky, twilight and night: everything downstream of "where is the sun".
 *
 * `skyStateAt` is a pure lookup over a hand-authored stop table keyed on the
 * sun's refracted altitude. A stop table rather than a physical model, on
 * purpose: per-channel Rayleigh extinction with Kasten–Young air mass is elegant
 * and unusable — it puts the sun at (1.00, 0.27, 0.04) at 2° altitude and
 * (1.00, 0.08, 0.00) at 0°, i.e. pure crimson contributing almost no light at
 * exactly the elevation where this app most needs a raking sun to make 1–2 m
 * ramparts legible (terrain/lighting.ts explains why that matters). The table
 * keeps the *shape* physics gives — reddening and dimming toward the horizon —
 * and stops short of the part that would make the scene unreadable.
 *
 * Three constraints from the rest of the renderer shape the design:
 *
 *  • **The sky is not tone-mapped.** `scene.background` goes through the clear
 *    buffer and three applies fog *after* tone mapping, so the background and the
 *    fog agree exactly (which is why today's flat sky hides its fog wall) and
 *    neither responds to `toneMappingExposure`. The night stops are therefore
 *    already the dark-*adapted* colours, not physical black.
 *  • **Fog is replaced, not mutated.** Three refreshes a material's `fogColor`
 *    uniform on an identity comparison, and water/water.ts is a raw
 *    `ShaderMaterial` with `lights: false` that clones `UniformsLib.fog` — it
 *    would keep yesterday's sky if we edited `scene.fog.color` in place.
 *  • **The sun light is never hidden.** Toggling `visible` changes `numDirLights`
 *    and recompiles every lit program, which is a visible hitch mid-drag. Below
 *    the horizon its intensity simply reaches zero.
 */

import * as THREE from 'three';

import type { Lighting } from '../terrain/lighting';

/** Everything the scene needs to know about the sky at one solar altitude. */
export interface SkyState {
  /**
   * Background and fog colour, authored as final display sRGB. This is also
   * the sky dome's colour **at the horizon**, exactly — which is what lets the
   * dome carry a gradient without reopening the fog wall the flat sky hid.
   */
  sky: THREE.Color;
  /** The dome's colour straight up. `sky` is the horizon end of the same ramp. */
  zenith: THREE.Color;
  /**
   * The glow added around the sun's direction — black at night, deep orange at
   * sunset, a pale forward-scatter by day. Added, not mixed, so it can only
   * brighten the sky it sits in.
   */
  aureole: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  /**
   * The hemisphere light's up-facing colour. Deliberately *not* the background
   * colour, though it tracks its hue: the night and twilight sky stops are dark
   * because that is what the sky looks like, and feeding them straight to the
   * fill light crushes the landscape to pure black long before it should be.
   * These are the same hues at roughly even luminance, so `hemiIntensity` is the
   * one knob that dims the scene.
   */
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  /** `renderer.toneMappingExposure` — a simulated dark-adapted eye. */
  exposure: number;
  /**
   * 0…1 daylight factor for materials that light themselves (the water plane).
   * Not a physical quantity; it exists so nothing glows in the dark.
   */
  daylight: number;
  /**
   * 0…1 visibility of the stars. Zero while the sun is up, one below
   * astronomical twilight — the same ramp your eyes walk down outdoors, where a
   * couple of first-magnitude stars arrive well before the Milky Way does.
   */
  starFade: number;
}

interface Stop {
  /** Refracted solar altitude, degrees. */
  h: number;
  sky: [number, number, number];
  zenith: [number, number, number];
  aureole: [number, number, number];
  starFade: number;
  sun: [number, number, number];
  sunIntensity: number;
  hemiSky: [number, number, number];
  hemiGround: [number, number, number];
  hemiIntensity: number;
  exposure: number;
  daylight: number;
}

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/**
 * The ramp. `h = 50` is pinned to `#8fa3b4`, the flat background this app shipped
 * with, and Broborg's summer noon sun reaches 53.9° — so the daytime look is
 * preserved as the top of the ramp and this change reads as a diff.
 *
 * `sky` is now specifically the **horizon** end of the dome's gradient, which is
 * why that pin still means what it meant: the fog colour is still exactly the
 * colour of the sky the fog wall stands in front of. `zenith` is the other end,
 * `aureole` the glow added around the sun, and `starFade` how much of the star
 * field is out — zero until the sun is a few degrees down, full below −18°.
 */
const STOPS: readonly Stop[] = [
  { h: -90,     sky: rgb('#05070d'), zenith: rgb('#03040a'), aureole: rgb('#000000'), starFade: 1.00, sun: rgb('#000000'), sunIntensity: 0,     hemiSky: rgb('#20293d'), hemiGround: rgb('#0e1014'), hemiIntensity: 0.10, exposure: 3.2,   daylight: 0.05 },
  { h: -18,     sky: rgb('#070a12'), zenith: rgb('#04060e'), aureole: rgb('#000000'), starFade: 1.00, sun: rgb('#000000'), sunIntensity: 0,     hemiSky: rgb('#243050'), hemiGround: rgb('#101318'), hemiIntensity: 0.13, exposure: 3.0,   daylight: 0.06 },
  { h: -12,     sky: rgb('#10182c'), zenith: rgb('#0a0f1e'), aureole: rgb('#05050b'), starFade: 0.72, sun: rgb('#000000'), sunIntensity: 0,     hemiSky: rgb('#33456e'), hemiGround: rgb('#14161a'), hemiIntensity: 0.22, exposure: 2.4,   daylight: 0.10 },
  { h: -6,      sky: rgb('#2c3a56'), zenith: rgb('#1a2440'), aureole: rgb('#221820'), starFade: 0.26, sun: rgb('#241a1c'), sunIntensity: 0,     hemiSky: rgb('#5b6f95'), hemiGround: rgb('#20211f'), hemiIntensity: 0.42, exposure: 1.7,   daylight: 0.26 },
  { h: -3,      sky: rgb('#57516a'), zenith: rgb('#2c3557'), aureole: rgb('#4a2a26'), starFade: 0.05, sun: rgb('#5a2f28'), sunIntensity: 0,     hemiSky: rgb('#8b849f'), hemiGround: rgb('#2e2c25'), hemiIntensity: 0.60, exposure: 1.35,  daylight: 0.42 },
  // -0.833° is the conventional sunset altitude (upper limb on the horizon) and
  // -0.267° is the disc fully set, so the direct beam is gone by the former and
  // barely there at the latter. Twilight past that is the hemisphere light's job.
  { h: -0.833,  sky: rgb('#8f6a63'), zenith: rgb('#3f4a70'), aureole: rgb('#8a4526'), starFade: 0,    sun: rgb('#b04d24'), sunIntensity: 0,     hemiSky: rgb('#bd9186'), hemiGround: rgb('#3d382c'), hemiIntensity: 0.78, exposure: 1.15,  daylight: 0.58 },
  { h: -0.267,  sky: rgb('#9a7167'), zenith: rgb('#43506f'), aureole: rgb('#984d28'), starFade: 0,    sun: rgb('#bb5426'), sunIntensity: 0.16,  hemiSky: rgb('#c49489'), hemiGround: rgb('#3f392d'), hemiIntensity: 0.82, exposure: 1.13,  daylight: 0.60 },
  { h: 0,       sky: rgb('#a2766a'), zenith: rgb('#46536f'), aureole: rgb('#a2542a'), starFade: 0,    sun: rgb('#c65a29'), sunIntensity: 0.45,  hemiSky: rgb('#c9968a'), hemiGround: rgb('#413b2e'), hemiIntensity: 0.85, exposure: 1.12,  daylight: 0.62 },
  { h: 2,       sky: rgb('#c19178'), zenith: rgb('#4e5f7d'), aureole: rgb('#b2602f'), starFade: 0,    sun: rgb('#f0813c'), sunIntensity: 1.10,  hemiSky: rgb('#d3a288'), hemiGround: rgb('#4a4232'), hemiIntensity: 0.92, exposure: 1.05,  daylight: 0.72 },
  { h: 6,       sky: rgb('#c9a68e'), zenith: rgb('#557090'), aureole: rgb('#8d6039'), starFade: 0,    sun: rgb('#ffab63'), sunIntensity: 1.90,  hemiSky: rgb('#c9a68e'), hemiGround: rgb('#504736'), hemiIntensity: 1.00, exposure: 1.0,   daylight: 0.84 },
  { h: 12,      sky: rgb('#b4b3ae'), zenith: rgb('#5a7ba1'), aureole: rgb('#6b6353'), starFade: 0,    sun: rgb('#ffd39a'), sunIntensity: 2.55,  hemiSky: rgb('#b4b3ae'), hemiGround: rgb('#544d3a'), hemiIntensity: 1.00, exposure: 1.0,   daylight: 0.93 },
  { h: 25,      sky: rgb('#9aabb8'), zenith: rgb('#5b83ae'), aureole: rgb('#5b5c5b'), starFade: 0,    sun: rgb('#ffeccb'), sunIntensity: 2.95,  hemiSky: rgb('#9aabb8'), hemiGround: rgb('#554e3c'), hemiIntensity: 1.05, exposure: 1.0,   daylight: 0.99 },
  { h: 50,      sky: rgb('#8fa3b4'), zenith: rgb('#5d84a8'), aureole: rgb('#55585b'), starFade: 0,    sun: rgb('#fff4e6'), sunIntensity: 3.10,  hemiSky: rgb('#8fa3b4'), hemiGround: rgb('#554e3c'), hemiIntensity: 1.10, exposure: 1.0,   daylight: 1.0 },
  { h: 90,      sky: rgb('#86a0b6'), zenith: rgb('#5b82a8'), aureole: rgb('#54575a'), starFade: 0,    sun: rgb('#fff6ea'), sunIntensity: 3.15,  hemiSky: rgb('#86a0b6'), hemiGround: rgb('#554e3c'), hemiIntensity: 1.10, exposure: 1.0,   daylight: 1.0 },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Interpolate a stop colour **in sRGB**, then declare the space.
 * `THREE.Color.lerp` works in the linear working space, which drags an
 * orange→deep-blue transition through a noticeably darker, muddier path than the
 * ramp above was authored to take.
 */
function lerpSrgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
  out: THREE.Color,
): THREE.Color {
  return out.setRGB(
    lerp(a[0], b[0], t) / 255,
    lerp(a[1], b[1], t) / 255,
    lerp(a[2], b[2], t) / 255,
    THREE.SRGBColorSpace,
  );
}

/**
 * The sky at a given refracted solar altitude. Writes into `out` (default: a
 * fresh state) so the per-tick path allocates nothing.
 */
export function skyStateAt(altitudeDeg: number, out: SkyState = createSkyState()): SkyState {
  const h = Math.max(-90, Math.min(90, altitudeDeg));

  let hi = 1;
  while (hi < STOPS.length - 1 && STOPS[hi].h < h) hi += 1;
  const a = STOPS[hi - 1];
  const b = STOPS[hi];
  const t = b.h === a.h ? 0 : Math.max(0, Math.min(1, (h - a.h) / (b.h - a.h)));

  lerpSrgb(a.sky, b.sky, t, out.sky);
  lerpSrgb(a.zenith, b.zenith, t, out.zenith);
  lerpSrgb(a.aureole, b.aureole, t, out.aureole);
  lerpSrgb(a.sun, b.sun, t, out.sunColor);
  lerpSrgb(a.hemiSky, b.hemiSky, t, out.hemiSky);
  lerpSrgb(a.hemiGround, b.hemiGround, t, out.hemiGround);
  out.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t);
  out.hemiIntensity = lerp(a.hemiIntensity, b.hemiIntensity, t);
  out.exposure = lerp(a.exposure, b.exposure, t);
  out.daylight = lerp(a.daylight, b.daylight, t);
  out.starFade = lerp(a.starFade, b.starFade, t);
  return out;
}

export function createSkyState(): SkyState {
  return {
    sky: new THREE.Color(),
    zenith: new THREE.Color(),
    aureole: new THREE.Color(),
    sunColor: new THREE.Color(),
    sunIntensity: 0,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0,
    exposure: 1,
    daylight: 1,
    starFade: 0,
  };
}

/**
 * Owns the scene's sky: background colour, fog, both lights and the exposure.
 *
 * `setFogBand` keeps the "build a fresh `THREE.Fog`" behaviour the far-field ring
 * loader already relied on — see the header note about identity comparison.
 */
export class Atmosphere {
  readonly state: SkyState = createSkyState();

  private fogNear = 1;
  private fogFar = 2;
  private hasFogBand = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly lighting: Lighting,
  ) {
    this.scene.background = new THREE.Color();
    this.apply(50, 315);
  }

  /** Live reference into `state` — copy it if you need to keep a value. */
  get skyColor(): THREE.Color {
    return this.state.sky;
  }

  get daylight(): number {
    return this.state.daylight;
  }

  /** Sun altitude/azimuth in degrees; altitude may be negative. */
  apply(apparentAltitudeDeg: number, azimuthDeg: number): void {
    const s = skyStateAt(apparentAltitudeDeg, this.state);

    this.lighting.setSun(azimuthDeg, apparentAltitudeDeg);
    this.lighting.setSunLight(s.sunColor, s.sunIntensity);
    // Hue-matched to the background but not equal to it (see `SkyState.hemiSky`):
    // blue fill at noon, warm fill at sunset, deep blue at twilight, all
    // consistent with the sky without inheriting how dark the night sky is.
    this.lighting.setHemisphere(s.hemiSky, s.hemiGround, s.hemiIntensity);

    (this.scene.background as THREE.Color).copy(s.sky);
    this.renderer.toneMappingExposure = s.exposure;
    this.refreshFog();
  }

  /** Called by the ring loader as terrain (and therefore the horizon) grows. */
  setFogBand(near: number, far: number): void {
    this.fogNear = near;
    this.fogFar = far;
    this.hasFogBand = true;
    this.refreshFog();
  }

  private refreshFog(): void {
    if (!this.hasFogBand) return;
    // A NEW Fog every time, deliberately: three keys its fog-uniform refresh on
    // object identity, and the water plane's raw ShaderMaterial needs that push.
    const fog = new THREE.Fog(0x000000, this.fogNear, this.fogFar);
    fog.color.copy(this.state.sky);
    this.scene.fog = fog;
  }
}
