/**
 * Legibility lighting (PLAN §4.2).
 *
 * A raking directional "sun" plus a hemisphere fill. The defaults are tuned for
 * the Phase-1 milestone: a **low** sun (elevation ~18°) from the north-west, the
 * classic hillshade setup, because 1–2 m ramparts are only unmistakable when the
 * light grazes them.
 *
 * Azimuth is compass degrees: 0 = north (−z), 90 = east (+x), clockwise.
 * Elevation is degrees above the horizon.
 */

import * as THREE from 'three';

export const DEFAULT_SUN_AZIMUTH = 315;
export const DEFAULT_SUN_ELEVATION = 18;

const DEG = Math.PI / 180;

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

    this.sun = new THREE.DirectionalLight(0xfff2df, 2.6);
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

  setSun(azimuth: number, elevation: number): void {
    this.params.azimuth = azimuth;
    this.params.elevation = elevation;
    this.apply();
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
    // A grazing sun delivers less energy per unit ground area; nudge the intensity
    // back up so the low-sun default does not simply look dark.
    this.sun.intensity = 2.2 + 1.5 * (1 - Math.sin(el));
  }
}
