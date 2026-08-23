/**
 * Legibility lighting (PLAN §4.2), now driven by the real sun.
 *
 * A raking directional "sun" plus a hemisphere fill. The original defaults — a
 * **low** sun (elevation ~18°) from the north-west, the classic hillshade setup —
 * were hand-picked because 1–2 m ramparts are only unmistakable when the light
 * grazes them. Since the time sliders landed, the position comes from
 * sky/solar.ts and the colour and intensity from sky/atmosphere.ts; the old
 * numbers survive as the manual override the debug panel offers.
 *
 * Azimuth is compass degrees: 0 = north (−z), 90 = east (+x), clockwise.
 * Elevation is degrees above the horizon, and may now be **negative** — the sun
 * sets. Note that the light is never hidden when it does: `visible = false` would
 * change `numDirLights` and recompile every lit program mid-slider-drag, so the
 * atmosphere drives the intensity to zero instead.
 */

import * as THREE from 'three';

export const DEFAULT_SUN_AZIMUTH = 315;
export const DEFAULT_SUN_ELEVATION = 18;

/** The pre-astronomy sun colour, kept for the debug panel's manual override. */
export const LEGIBILITY_SUN_COLOR = 0xfff2df;

const DEG = Math.PI / 180;

/**
 * The pre-astronomy intensity curve: a grazing sun delivers less energy per unit
 * ground area, so the low-sun default was nudged back up rather than left dark.
 * Kept as a named export because the debug panel's manual-sun override still
 * wants exactly this behaviour, and because pinning it in a test is the cheapest
 * guarantee that "manual sun" reproduces the old look.
 */
export function legibilityIntensity(elevationDeg: number): number {
  return 2.2 + 1.5 * (1 - Math.sin(elevationDeg * DEG));
}

export interface SunParams {
  azimuth: number;
  elevation: number;
}

export class Lighting {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;

  /** How far out the light is placed; only matters for shadows/debug helpers. */
  private radius = 3000;
  private readonly params: SunParams = {
    azimuth: DEFAULT_SUN_AZIMUTH,
    elevation: DEFAULT_SUN_ELEVATION,
  };

  constructor() {
    this.group.name = 'lighting';

    this.sun = new THREE.DirectionalLight(LEGIBILITY_SUN_COLOR, 2.6);
    this.sun.name = 'sun';
    this.sun.target.position.set(0, 0, 0);

    this.hemi = new THREE.HemisphereLight(0xbcd2e8, 0x554e3c, 1.0);
    this.hemi.name = 'sky';

    this.group.add(this.sun, this.sun.target, this.hemi);
    this.apply();
  }

  setRadius(radius: number): void {
    this.radius = radius;
    this.apply();
  }

  /**
   * Place the sun. **Position only** — this used to recompute the intensity too,
   * which meant any value the atmosphere set was destroyed by the next call.
   */
  setSun(azimuth: number, elevation: number): void {
    this.params.azimuth = azimuth;
    this.params.elevation = elevation;
    this.apply();
  }

  /** Colour and intensity, from the atmosphere ramp (or the manual override). */
  setSunLight(color: THREE.ColorRepresentation, intensity: number): void {
    this.sun.color.set(color);
    this.sun.intensity = intensity;
  }

  setHemisphere(sky: THREE.ColorRepresentation, ground: THREE.ColorRepresentation, intensity: number): void {
    this.hemi.color.set(sky);
    this.hemi.groundColor.set(ground);
    this.hemi.intensity = intensity;
  }

  getSun(): SunParams {
    return { ...this.params };
  }

  private apply(): void {
    const az = this.params.azimuth * DEG;
    const el = this.params.elevation * DEG;
    const horizontal = Math.cos(el);
    // north = −z, east = +x
    this.sun.position.set(
      Math.sin(az) * horizontal * this.radius,
      Math.sin(el) * this.radius,
      -Math.cos(az) * horizontal * this.radius,
    );
  }
}
