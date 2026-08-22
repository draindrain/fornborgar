/**
 * The far-field class tint (contract v1.6 §13) — the modelled landscape's ground
 * colour carried past the context edge onto the §11 ring meshes.
 *
 * A deliberately simpler cousin of `LandcoverTint`: same injection idiom, same
 * `NearestFilter` class texture, same multiply-then-mix wash — but **per ring**
 * (each ring carries its own raster on its own geometry) and fully static: no
 * dynamic hydrology branches out here. Far *water* rendering stays §11's job,
 * and the far classifier's honesty note lives in the legend's `farField.method`,
 * rendered by the methods panel like every other rule.
 *
 * Each ring that declares a §13 raster gets its own material clone from
 * `Terrain.farOverlayMaterial(index)` — the one contractual exception to §11's
 * "ring meshes take no overlay layers" — so the three near-field overlays and
 * this one can never leak onto each other's surfaces. `uFarOn` and `uFarMix`
 * uniform objects are shared across all ring attachments, which is what makes
 * one `setEnabled` flip every ring together with the near-field layer.
 */

import * as THREE from 'three';
import type { LandcoverGrid } from './landcoverGrid';
import { MAX_CLASSES, type FarFieldClass } from './legend';
import { TINT_MIX } from './tint';

export class FarLandcoverTint {
  private readonly palette: THREE.Color[];
  private readonly classCount: number;
  private readonly textures: THREE.DataTexture[] = [];

  /** Shared across every ring attachment, so one toggle drives them all. */
  private readonly uFarOn = { value: 0 };
  private readonly uFarMix = { value: TINT_MIX };

  constructor(classes: FarFieldClass[]) {
    this.classCount = classes.length;
    this.palette = [];
    for (let i = 0; i < MAX_CLASSES; i++) {
      const entry = classes[i];
      this.palette.push(
        entry
          ? new THREE.Color().setStyle(entry.color, THREE.SRGBColorSpace)
          : new THREE.Color().setStyle('#808080', THREE.SRGBColorSpace),
      );
    }
  }

  /**
   * Inject one ring's raster into that ring's dedicated material. Call before
   * `Terrain.setRing` binds the material to the ring's band meshes.
   */
  attachRing(material: THREE.Material, grid: LandcoverGrid): void {
    const texture = new THREE.DataTexture(
      Uint8Array.from(grid.classes),
      grid.width,
      grid.height,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    this.textures.push(texture);

    const b = grid.boundsLocal;
    const uniforms = {
      uFarLcClass: { value: texture },
      uFarLcRect: {
        value: new THREE.Vector4(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ)),
      },
      uFarLcPalette: { value: this.palette },
      uFarLcCount: { value: this.classCount },
      uFarLcOn: this.uFarOn,
      uFarLcMix: this.uFarMix,
    };

    const previousCompile = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${previousKey()}|farlandcover`;

    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFarLcXZ;')
        .replace(
          '#include <begin_vertex>',
          // World XZ equals local XZ on rings too: exaggeration scales Y only
          // and the curvature drop (terrain.ts) moves vertices only in Y.
          '#include <begin_vertex>\nvFarLcXZ = (modelMatrix * vec4(position, 1.0)).xz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'varying vec2 vFarLcXZ;',
            'uniform sampler2D uFarLcClass;',
            'uniform vec4 uFarLcRect;',
            `uniform vec3 uFarLcPalette[${MAX_CLASSES}];`,
            'uniform int uFarLcCount;',
            'uniform float uFarLcOn;',
            'uniform float uFarLcMix;',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            'if (uFarLcOn > 0.5) {',
            '  vec2 farUv = (vFarLcXZ - uFarLcRect.xy) * uFarLcRect.zw;',
            '  if (all(greaterThanEqual(farUv, vec2(0.0))) && all(lessThanEqual(farUv, vec2(1.0)))) {',
            '    // NearestFilter + the 0..255 byte range: the class INDEX (§13).',
            '    int farIndex = int(texture2D(uFarLcClass, farUv).r * 255.0 + 0.5);',
            '    vec3 farColor = vec3(0.5);',
            `    for (int i = 0; i < ${MAX_CLASSES}; i++) {`,
            '      if (i >= uFarLcCount) break;',
            '      if (i == farIndex) farColor = uFarLcPalette[i];',
            '    }',
            '    vec3 farShaded = gl_FragColor.rgb * (farColor * 2.0);',
            '    gl_FragColor.rgb = mix(gl_FragColor.rgb, farShaded, uFarLcMix);',
            '  }',
            '}',
            '#include <dithering_fragment>',
          ].join('\n'),
        );
    };
    material.needsUpdate = true;
  }

  /** One switch for every attached ring — driven by the same toggle as §9's layer. */
  setEnabled(on: boolean): void {
    this.uFarOn.value = on ? 1 : 0;
  }

  get enabled(): boolean {
    return this.uFarOn.value > 0.5;
  }

  setMix(mix: number): void {
    this.uFarMix.value = Math.max(0, Math.min(1, mix));
  }

  dispose(): void {
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
  }
}
