/**
 * The stars you look at — 5 044 points, one draw call.
 *
 * The reflection in the water reads a baked map (`stars.ts`), because a
 * reflection needs a function of direction. What you look at directly does not:
 * points stay crisp at any zoom, cost one buffer, and can carry a per-star
 * magnitude and colour. Both come from the same catalogue and the same epoch
 * directions, so they cannot disagree about where a star is.
 *
 * ## Two things that are easy to get wrong here
 *
 * **Depth.** The points are pushed to the far plane with `gl_Position =
 * clip.xyww` and *do* depth-test, unlike the dome. They have to: a transparent
 * material is always drawn after the opaque pass, so with the test off the
 * stars would shine straight through the terrain. At the far plane the test is
 * `1.0 <= 1.0` against an untouched depth buffer — which passes — and fails
 * against any terrain fragment, which is exactly the wanted behaviour. They
 * carry no logarithmic-depth chunk on purpose; participating in that would put
 * them at the distance of the unit sphere they are drawn on.
 *
 * **The diurnal rotation.** Star positions are epoch-equatorial and are
 * rewritten only when the *year* changes. Time of day is the group's matrix
 * (`equatorialToWorldMatrix`), so dragging the hour slider costs nine numbers.
 */

import * as THREE from 'three';

import { starColor, type StarCatalogue } from './stars';

const VERTEX_SHADER = /* glsl */ `
attribute float aMagnitude;
attribute vec3 aColor;

uniform float uStarFade;
uniform float uPixelRatio;
uniform float uSizeScale;

varying vec3 vColor;
varying float vAlpha;

void main() {
  // The group's matrix is the equatorial -> world rotation, so this is the
  // star's direction in the scene's own frame.
  vec3 dir = normalize((modelMatrix * vec4(position, 0.0)).xyz);

  // The limiting magnitude rises as the sky darkens, the way it does outdoors:
  // a couple of first-magnitude stars at civil twilight, the whole catalogue
  // only once the sun is past -18°.
  float limit = mix(-1.0, 6.6, uStarFade);
  float visible = clamp((limit - aMagnitude) / 1.2, 0.0, 1.0);

  // Extinction: the last few degrees of atmosphere put out everything faint.
  float extinction = smoothstep(-0.005, 0.13, dir.y);

  vAlpha = visible * uStarFade * extinction;
  vColor = aColor;

  if (dir.y < -0.02 || vAlpha <= 0.001) {
    // Off-screen and zero-sized: cheaper than a discard, and keeps the whole
    // lower hemisphere out of the fragment stage.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  gl_PointSize = uPixelRatio * uSizeScale * (1.0 + 2.4 * pow(visible, 1.5));

  mat4 rotationOnly = mat4(mat3(viewMatrix));
  vec4 clip = projectionMatrix * rotationOnly * vec4(dir, 1.0);
  gl_Position = clip.xyww;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main() {
  // A gaussian point spread rather than a square: this is what a star looks
  // like through an atmosphere and through an eye, and it antialiases for free.
  float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float falloff = exp(-4.0 * r * r) - 0.018;
  if (falloff <= 0.0) discard;

  gl_FragColor = vec4(vColor, vAlpha * falloff);
  #include <colorspace_fragment>
}
`;

export class StarField {
  /** Parent this to the scene; its matrix carries the diurnal rotation. */
  readonly group = new THREE.Group();

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private readonly fadeUniform = { value: 0 };
  private positions: Float32Array;

  constructor(catalogue: StarCatalogue, directions: Float32Array, pixelRatio: number) {
    this.positions = directions;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(directions, 3));

    const magnitudes = new Float32Array(catalogue.count);
    const colors = new Float32Array(catalogue.count * 3);
    for (let i = 0; i < catalogue.count; i++) {
      magnitudes[i] = catalogue.mag[i];
      const color = new THREE.Color().setStyle(
        starHex(catalogue.bv[i]),
        THREE.SRGBColorSpace,
      );
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    this.geometry.setAttribute('aMagnitude', new THREE.BufferAttribute(magnitudes, 1));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uStarFade: this.fadeUniform,
        uPixelRatio: { value: pixelRatio },
        uSizeScale: { value: 1.35 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      // See the header: the test is what keeps them behind the landscape.
      depthTest: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'stars';
    this.points.frustumCulled = false;
    this.points.renderOrder = -1;
    this.group.name = 'star-field';
    this.group.matrixAutoUpdate = false;
    this.group.add(this.points);
  }

  /** The diurnal rotation: `equatorialToWorldMatrix(lat, localSiderealDeg)`. */
  setOrientation(equatorialToWorld: THREE.Matrix3): void {
    this.group.matrix.setFromMatrix3(equatorialToWorld);
    this.group.matrixWorldNeedsUpdate = true;
  }

  /** 0…1 from the atmosphere ramp. Zero means the sky is too bright for stars. */
  setFade(fade: number): void {
    this.fadeUniform.value = Math.max(0, Math.min(1, fade));
    this.points.visible = this.fadeUniform.value > 0.001;
  }

  /** New epoch directions, in place. Only the year slider causes this. */
  setDirections(directions: Float32Array): void {
    if (directions !== this.positions) {
      this.positions.set(directions);
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  setPixelRatio(pixelRatio: number): void {
    this.material.uniforms.uPixelRatio.value = pixelRatio;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * B−V to a hex colour, via the same table `stars.ts` uses for the baked map, so
 * a star is the same colour whether you look at it or at its reflection.
 */
function starHex(bv: number): string {
  const [r, g, b] = starColor(bv);
  const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}
