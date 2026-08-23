/**
 * The sky, as a thing that is actually drawn.
 *
 * Before this the sky was a clear colour. It still is, underneath — `scene.
 * background` keeps tracking `Atmosphere.state.sky` so nothing downstream has
 * to change and so a failed dome degrades to the old flat sky rather than to
 * black. The dome paints over it.
 *
 * Three details make it safe to put a mesh where a clear colour was:
 *
 *  • **No depth, no fog, no tone mapping.** `depthTest` and `depthWrite` are
 *    both off and `renderOrder` is deeply negative, so it is painted first and
 *    every opaque thing in the scene covers it normally. Fog and tone mapping
 *    are off for the reason `atmosphere.ts` gives: the sky has never been
 *    subject to either, and the fog colour has to keep agreeing with it exactly.
 *  • **The camera's translation is stripped** in the vertex shader and the
 *    result pushed to the far plane with `gl_Position = clip.xyww`. The dome
 *    is therefore independent of its own radius, of a near plane that can be
 *    0.5 m, of a far plane that can be 96 km, and of the logarithmic depth
 *    buffer — none of which it participates in.
 *  • **Its horizon is `Atmosphere.state.sky`**, exactly (see `skyChunk.ts`).
 */

import * as THREE from 'three';

import type { SkyUniforms } from './skyChunk';
import { SKY_CHUNK } from './skyChunk';

const VERTEX_SHADER = /* glsl */ `
varying vec3 vSkyDir;

void main() {
  vSkyDir = position;
  // mat3() drops the translation: the dome is always centred on the eye. The
  // mesh's own matrix is the identity (see the constructor), so this is a world
  // direction, not an object-space one.
  mat4 rotationOnly = mat4(mat3(viewMatrix));
  vec4 clip = projectionMatrix * rotationOnly * vec4(position, 1.0);
  // z = w puts it on the far plane. Nothing depth-tests against it either way.
  gl_Position = clip.xyww;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying vec3 vSkyDir;

${SKY_CHUNK}

void main() {
  vec3 dir = normalize(vSkyDir);
  vec3 col = skyGradient(dir) + sunRadiance(dir) + moonRadiance(dir);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(uniforms: SkyUniforms) {
    this.material = new THREE.ShaderMaterial({
      // Shared by reference with the water, so one write moves both.
      uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    // A unit box is enough: the shader only ever uses the direction of its
    // vertices, and the projection is done with the translation removed.
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.material);
    this.mesh.name = 'sky-dome';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // Before everything. The star field sits just after it at -1.
    this.mesh.renderOrder = -1000;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
