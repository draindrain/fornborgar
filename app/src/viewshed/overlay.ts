/**
 * Viewshed overlay (Phase 3, PLAN §4.4): the worker's Uint8Array mask uploaded
 * as a DataTexture and blended into the terrain materials in the fragment
 * shader, addressed by world-space XZ over the context grid's extent.
 *
 * The terrain group is Y-scaled only (contract §0), so world XZ equals local XZ
 * and the lookup needs no matrix bookkeeping. Mask convention: 1 = visible,
 * 0 = hidden (contract §4); the shader thresholds the normalized red channel.
 */

import * as THREE from 'three';
import type { BoundsLocal } from '../lib/coords';

export class ViewshedOverlay {
  readonly texture: THREE.DataTexture;

  private readonly uniforms: {
    uViewshedMask: { value: THREE.DataTexture };
    uViewshedOn: { value: number };
    /** minX, minZ, 1/sizeX, 1/sizeZ of the mask's ground rectangle. */
    uViewshedRect: { value: THREE.Vector4 };
  };

  constructor(width: number, height: number, bounds: BoundsLocal) {
    this.texture = new THREE.DataTexture(
      new Uint8Array(width * height),
      width,
      height,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;

    this.uniforms = {
      uViewshedMask: { value: this.texture },
      uViewshedOn: { value: 0 },
      uViewshedRect: {
        value: new THREE.Vector4(
          bounds.minX,
          bounds.minZ,
          1 / (bounds.maxX - bounds.minX),
          1 / (bounds.maxZ - bounds.minZ),
        ),
      },
    };
  }

  /** Inject the overlay into a terrain material. Call once per material, before first render. */
  attach(material: THREE.Material): void {
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vViewshedXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvViewshedXZ = (modelMatrix * vec4(position, 1.0)).xz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'varying vec2 vViewshedXZ;',
            'uniform sampler2D uViewshedMask;',
            'uniform float uViewshedOn;',
            'uniform vec4 uViewshedRect;',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            'if (uViewshedOn > 0.5) {',
            '  vec2 vsUv = (vViewshedXZ - uViewshedRect.xy) * uViewshedRect.zw;',
            '  if (all(greaterThanEqual(vsUv, vec2(0.0))) && all(lessThanEqual(vsUv, vec2(1.0)))) {',
            '    // Mask bytes are 0/1, so any nonzero normalized value means visible.',
            '    float vsVis = smoothstep(0.0005, 0.0025, texture2D(uViewshedMask, vsUv).r);',
            '    vec3 vsHidden = gl_FragColor.rgb * vec3(0.32, 0.36, 0.46);',
            '    vec3 vsSeen = min(gl_FragColor.rgb * vec3(1.06, 1.03, 0.92) + vec3(0.015), vec3(1.0));',
            '    gl_FragColor.rgb = mix(vsHidden, vsSeen, vsVis);',
            '  }',
            '}',
            '#include <dithering_fragment>',
          ].join('\n'),
        );
    };
    material.needsUpdate = true;
  }

  setMask(mask: Uint8Array): void {
    (this.texture.image.data as Uint8Array).set(mask);
    this.texture.needsUpdate = true;
  }

  setEnabled(on: boolean): void {
    this.uniforms.uViewshedOn.value = on ? 1 : 0;
  }

  get enabled(): boolean {
    return this.uniforms.uViewshedOn.value > 0.5;
  }

  dispose(): void {
    this.texture.dispose();
  }
}
