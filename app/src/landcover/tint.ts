/**
 * The land-cover ground tint (Phase 7, contract §9 "Rendering contract").
 *
 * A stylized flat per-class colour wash blended into the terrain materials, from the
 * §10 palette, addressed by world XZ over the context grid's extent — the same
 * injection idiom `ViewshedOverlay.attach` and `WaterLayer.attachTerrain` use, and
 * the same reason it works: the terrain group is Y-scaled only (contract §0), so
 * world XZ equals local XZ and no matrix bookkeeping is needed.
 *
 * ## Where this sits in the overlay chain
 *
 * Three modules now inject into the same two terrain materials. Each chains the
 * handler it found and each injects with the "keep the include, append to it" idiom,
 * so the anchor tokens (`#include <common>`, `#include <begin_vertex>`,
 * `#include <dithering_fragment>`) survive for the next injector and **attach order
 * is shading order**. The contract fixes that order:
 *
 *     viewshed  →  landcover  →  water
 *
 * The land-cover wash must not erase the viewshed's visible/hidden distinction, and
 * submerged ground must still read as submerged whatever the land cover says — so
 * the water tint deliberately shades last. `main.ts` attaches in exactly this order.
 *
 * Identifiers are namespaced `uLandcover*` / `vLandcoverXZ`, and
 * `customProgramCacheKey` is extended so a material carrying this injection can never
 * share a compiled program with one that does not.
 *
 * The class texture is `NearestFilter` in both directions: class **indices** must
 * never be interpolated (§9), or a 2 m boundary between class 0 and class 4 would
 * briefly read as classes 1–3.
 */

import * as THREE from 'three';
import type { LandcoverGrid } from './landcoverGrid';
import { MAX_CLASSES, type LandcoverLegend } from './legend';

/**
 * How hard the wash is mixed into the shaded terrain colour. Moderate on purpose:
 * the relief shading — the thing the terrain is actually for — has to keep reading
 * through it, and the layer is a model, not a photograph.
 */
export const TINT_MIX = 0.45;

export class LandcoverTint {
  readonly texture: THREE.DataTexture;
  readonly classCount: number;

  private readonly uniforms: {
    uLandcoverClass: { value: THREE.DataTexture };
    uLandcoverOn: { value: number };
    /** minX, minZ, 1/sizeX, 1/sizeZ of the class raster's ground rectangle. */
    uLandcoverRect: { value: THREE.Vector4 };
    uLandcoverPalette: { value: THREE.Color[] };
    uLandcoverCount: { value: number };
    uLandcoverMix: { value: number };
  };

  constructor(grid: LandcoverGrid, legend: LandcoverLegend) {
    this.classCount = legend.classes.length;

    // A copy, not a view: the texture owns its bytes for the renderer's lifetime
    // while `grid.classes` stays the analysis-side array the sampler reads.
    this.texture = new THREE.DataTexture(
      Uint8Array.from(grid.classes),
      grid.width,
      grid.height,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;

    // Fixed-length palette: GLSL needs a compile-time array size, and §9 caps the
    // class count at 32. Unused slots are neutral grey, never sampled.
    const palette: THREE.Color[] = [];
    for (let i = 0; i < MAX_CLASSES; i++) {
      const entry = legend.classes[i];
      palette.push(
        entry
          ? new THREE.Color().setStyle(entry.color, THREE.SRGBColorSpace)
          : new THREE.Color().setStyle('#808080', THREE.SRGBColorSpace),
      );
    }

    const b = grid.boundsLocal;
    this.uniforms = {
      uLandcoverClass: { value: this.texture },
      uLandcoverOn: { value: 0 },
      uLandcoverRect: {
        value: new THREE.Vector4(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ)),
      },
      uLandcoverPalette: { value: palette },
      uLandcoverCount: { value: this.classCount },
      uLandcoverMix: { value: TINT_MIX },
    };
  }

  /**
   * Inject the wash into one terrain material, chaining any handler already there.
   * Call once per material, **after** the viewshed overlay and **before** the water
   * layer (see the module comment).
   */
  attach(material: THREE.Material): void {
    const uniforms = this.uniforms;
    const previousCompile = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${previousKey()}|landcover1`;

    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vLandcoverXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvLandcoverXZ = (modelMatrix * vec4(position, 1.0)).xz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'varying vec2 vLandcoverXZ;',
            'uniform sampler2D uLandcoverClass;',
            'uniform float uLandcoverOn;',
            'uniform vec4 uLandcoverRect;',
            `uniform vec3 uLandcoverPalette[${MAX_CLASSES}];`,
            'uniform int uLandcoverCount;',
            'uniform float uLandcoverMix;',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            'if (uLandcoverOn > 0.5) {',
            '  vec2 lcUv = (vLandcoverXZ - uLandcoverRect.xy) * uLandcoverRect.zw;',
            '  if (all(greaterThanEqual(lcUv, vec2(0.0))) && all(lessThanEqual(lcUv, vec2(1.0)))) {',
            '    // NearestFilter + the 0..255 byte range: this is the class INDEX (§9).',
            '    int lcIndex = int(texture2D(uLandcoverClass, lcUv).r * 255.0 + 0.5);',
            '    vec3 lcColor = vec3(0.5);',
            // Loop-variable indexing keeps this legal in GLSL ES 1.00 too, where a
            // dynamically indexed uniform array is not.
            `    for (int i = 0; i < ${MAX_CLASSES}; i++) {`,
            '      if (i >= uLandcoverCount) break;',
            '      if (i == lcIndex) lcColor = uLandcoverPalette[i];',
            '    }',
            '    // Multiply, so the relief shading still reads through the wash.',
            '    vec3 lcShaded = gl_FragColor.rgb * (lcColor * 2.0);',
            '    gl_FragColor.rgb = mix(gl_FragColor.rgb, lcShaded, uLandcoverMix);',
            '  }',
            '}',
            '#include <dithering_fragment>',
          ].join('\n'),
        );
    };
    material.needsUpdate = true;
  }

  setEnabled(on: boolean): void {
    this.uniforms.uLandcoverOn.value = on ? 1 : 0;
  }

  get enabled(): boolean {
    return this.uniforms.uLandcoverOn.value > 0.5;
  }

  /** Wash strength, 0…1. Exposed for tuning; the default is `TINT_MIX`. */
  setMix(mix: number): void {
    this.uniforms.uLandcoverMix.value = Math.max(0, Math.min(1, mix));
  }

  dispose(): void {
    this.texture.dispose();
  }
}
