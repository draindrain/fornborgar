/**
 * Terrain material + elevation tint.
 *
 * Deliberately naturalistic-neutral and almost matte: the point of Phase 1 is that
 * 1–2 m earthworks read in the *shading*, so the albedo must not compete with it.
 * The tint is a low-saturation elevation ramp (cool damp low ground -> warm pale
 * crowns) baked into a Uint8 vertex-colour attribute.
 */

import * as THREE from 'three';

const RAMP: Array<[number, string]> = [
  [0.0, '#6d7862'],
  [0.35, '#878b6b'],
  [0.7, '#a29b83'],
  [1.0, '#c0b49c'],
];

/** Maps height (m) -> linear-space RGB bytes, via a 256-entry LUT. */
export class ElevationTint {
  private readonly lut: Uint8Array;
  private readonly min: number;
  private readonly invSpan: number;

  constructor(minElevation: number, maxElevation: number) {
    this.min = minElevation;
    const span = Math.max(1e-3, maxElevation - minElevation);
    this.invSpan = 1 / span;

    const stops = RAMP.map(([t, hex]) => {
      const c = new THREE.Color();
      c.setStyle(hex, THREE.SRGBColorSpace); // converts to the linear working space
      return { t, c };
    });

    this.lut = new Uint8Array(256 * 3);
    const tmp = new THREE.Color();
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let a = stops[0];
      let b = stops[stops.length - 1];
      for (let s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s].t && t <= stops[s + 1].t) {
          a = stops[s];
          b = stops[s + 1];
          break;
        }
      }
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      tmp.copy(a.c).lerp(b.c, f);
      this.lut[i * 3] = Math.round(tmp.r * 255);
      this.lut[i * 3 + 1] = Math.round(tmp.g * 255);
      this.lut[i * 3 + 2] = Math.round(tmp.b * 255);
    }
  }

  write(height: number, out: Uint8Array, offset: number): void {
    let t = (height - this.min) * this.invSpan;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const i = (t * 255) | 0;
    out[offset] = this.lut[i * 3];
    out[offset + 1] = this.lut[i * 3 + 1];
    out[offset + 2] = this.lut[i * 3 + 2];
  }
}

export function createTerrainMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
    flatShading: false,
    dithering: true,
  });
}

/**
 * Context ring material: identical shading, nudged back in depth so the ~1 cell of
 * deliberate overlap under the core edge never z-fights with the core mesh.
 */
export function createContextMaterial(): THREE.MeshStandardMaterial {
  const m = createTerrainMaterial();
  m.polygonOffset = true;
  m.polygonOffsetFactor = 1;
  m.polygonOffsetUnits = 1;
  return m;
}

/**
 * The seam skirt: never meant to be looked at, only to stop daylight. It carries
 * the same elevation tint as the terrain so that the sliver which *is* visible at
 * the core edge reads as ground, not as a dark hairline. Double-sided, so the
 * strip winding does not have to be load-bearing.
 */
export function createSkirtMaterial(): THREE.MeshStandardMaterial {
  const m = createTerrainMaterial();
  m.side = THREE.DoubleSide;
  return m;
}
