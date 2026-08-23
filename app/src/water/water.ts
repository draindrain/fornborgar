/**
 * The paleo-shoreline layer (Phase 4, PLAN §4.5; contract §6/§7).
 *
 * Two surfaces, one mask:
 *   • a semi-transparent water plane over the context extent, sitting at
 *     y = level *inside the terrain group*, so it inherits the group's Y scale
 *     (vertical exaggeration, contract §0) like every other parented layer;
 *   • a depth tint injected into the terrain materials, so submerged ground
 *     darkens smoothly instead of ending at a z-fighting fringe.
 *
 * Both test `connect ≤ level` from the §7 connectivity texture — a single
 * lookup, no second comparison against the DEM (the elevation test is subsumed),
 * which is what keeps false basins dry. The texture is addressed by world XZ over
 * the context bounds exactly as ViewshedOverlay does: the terrain group is
 * Y-scaled only, so world XZ equals local XZ and no matrix bookkeeping is needed.
 *
 * ## Composing with the viewshed overlay
 *
 * ViewshedOverlay.attach() already owns `onBeforeCompile` on the very same two
 * terrain materials, so attaching here must **chain** rather than replace:
 * `attachTerrain` captures the previous handler and calls it first, then applies
 * its own replacements. Both modules inject with the "keep the include, append
 * to it" idiom (`'#include <x>'` → `'#include <x>\n…'` / `'…\n#include <x>'`),
 * which leaves the anchor token in the string for the next handler to find, so
 * the two are order-independent; whichever runs last shades last, and the water
 * tint deliberately goes last (submerged ground reads as submerged whether or not
 * the viewshed is on). Identifiers are namespaced `uWater*` / `vWaterXZ` against
 * the overlay's `uViewshed*` / `vViewshedXZ`, and `customProgramCacheKey` is
 * extended so a material carrying this injection can never share a compiled
 * program with one that does not.
 */

import * as THREE from 'three';
import type { BoundsLocal } from '../lib/coords';
import { createSkyUniforms, SKY_CHUNK, type SkyUniforms } from '../sky/skyChunk';
import type { ConnectGrid } from './connectGrid';
import { levelAt, yearRange, type ShorelineTable } from './shoreline';

/** Water fades out over this much depth, giving a soft shoreline (meters). */
const SHORE_FADE = 0.15;
/** Depth at which the tint reaches its deepest value (meters). */
const DEPTH_SCALE = 6.0;
/**
 * Where individual wave facets stop being resolvable and the geometric normal
 * is handed over to the specular lobe's roughness instead. Per-pixel wave
 * normals on a plane that reaches 64 km are an aliasing machine.
 */
const WAVE_DETAIL_NEAR = 60.0;
const WAVE_DETAIL_FAR = 900.0;

const VERTEX_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vWaterXZ;
varying vec3 vWaterWorld;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWaterWorld = worldPosition.xyz;
  // The terrain group is Y-scaled only, so world XZ == local XZ (contract §0).
  vWaterXZ = worldPosition.xz;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

/**
 * Exported so `tests/waterShaderComposition.test.ts` can assert on it. The
 * composition rules this shader has to satisfy — which three includes it
 * carries, in what order, and which one it deliberately does *not* — are the
 * kind that fail silently at runtime, so they are pinned from the outside.
 */
export const WATER_FRAGMENT_SHADER = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

uniform sampler2D uWaterConnect;
uniform vec4 uWaterRect;
uniform float uWaterLevel;
uniform float uWaterOpacity;
uniform vec3 uWaterDeep;
// 0..1 daylight factor from sky/atmosphere.ts. The body of the water lights
// itself — this is a raw ShaderMaterial with lights disabled — so without this
// it would stay a luminous teal slab in a night landscape.
uniform float uWaterDaylight;
// The exposure the rest of the scene is tone-mapped at. This shader no longer
// tone-maps (see the module comment), so the body carries the exposure by hand
// while the reflected sky, like the sky itself, does not.
uniform float uWaterExposure;
uniform float uWaterTime;

// §11 far water: the ring's connect grid outside the context rect, faded out
// radially toward the 16 km edge (the SGU level is only locally valid across an
// uplift gradient). uWaterFarOn stays 0 for sites without a ring connect.
uniform sampler2D uWaterConnectFar;
uniform vec4 uWaterFarRect;
uniform float uWaterFarOn;
uniform vec2 uWaterFadeHalf; // (context half-extent, ring half-extent)

varying vec2 vWaterXZ;
varying vec3 vWaterWorld;

${SKY_CHUNK}

/**
 * Three crossing wave trains — about 6 m, 2.4 m and 1.1 m — summed as slopes
 * rather than heights, since the surface stays geometrically flat and only its
 * normal moves. Their combined slope tops out near 9 degrees: a light breeze.
 *
 * The detail factor fades the whole thing to flat with distance, and what it takes
 * away is handed to the specular lobe's roughness, so far water goes on
 * glittering without shimmering.
 */
vec3 waterNormal(vec2 p, float t, float detail) {
  vec2 d1 = vec2(0.94, 0.34);
  vec2 d2 = vec2(-0.42, 0.91);
  vec2 d3 = vec2(0.71, -0.71);
  const float k1 = 6.2831853 / 6.0;
  const float k2 = 6.2831853 / 2.4;
  const float k3 = 6.2831853 / 1.1;

  vec2 slope = vec2(0.0);
  slope += d1 * (0.055 * k1 * cos(k1 * dot(d1, p) - 1.05 * t));
  slope += d2 * (0.022 * k2 * cos(k2 * dot(d2, p) - 1.65 * t));
  slope += d3 * (0.008 * k3 * cos(k3 * dot(d3, p) - 2.40 * t));
  slope *= detail;
  return normalize(vec3(-slope.x, 1.0, -slope.y));
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 uv = (vWaterXZ - uWaterRect.xy) * uWaterRect.zw;
  float connect;
  float fade = 1.0;
  if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
    connect = texture2D(uWaterConnect, uv).r;
  } else if (uWaterFarOn > 0.5) {
    vec2 fuv = (vWaterXZ - uWaterFarRect.xy) * uWaterFarRect.zw;
    if (any(lessThan(fuv, vec2(0.0))) || any(greaterThan(fuv, vec2(1.0)))) discard;
    connect = texture2D(uWaterConnectFar, fuv).r;
    // Chebyshev distance matches the square extents: fade from the context edge
    // out to the ring edge (§2b uplift-honesty fade).
    float cheb = max(abs(vWaterXZ.x), abs(vWaterXZ.y));
    fade = 1.0 - smoothstep(uWaterFadeHalf.x, uWaterFadeHalf.y, cheb);
    if (fade <= 0.0) discard;
  } else {
    discard;
  }

  // One lookup: connect <= level means wet AND sea-connected (contract §7).
  float depth = uWaterLevel - connect;
  if (depth <= 0.0) discard;
  float shore = smoothstep(0.0, ${SHORE_FADE.toFixed(3)}, depth);
  if (shore <= 0.0) discard;

  vec3 toEye = cameraPosition - vWaterWorld;
  float eyeDistance = length(toEye);
  vec3 viewDir = toEye / eyeDistance;

  float detail = 1.0 - smoothstep(${WAVE_DETAIL_NEAR.toFixed(1)}, ${WAVE_DETAIL_FAR.toFixed(1)}, eyeDistance);
  vec3 normal = waterNormal(vWaterXZ, uWaterTime, detail);
  // The first-person camera can stand below the water level, and a normal that
  // faces away from the eye inverts the Fresnel term.
  if (viewDir.y < 0.0) normal = -normal;

  // Schlick with n = 1.33: two per cent looking straight down, a mirror at
  // grazing. The old fake pow(1 - |viewDir.y|, 4) had roughly this shape and
  // none of the consequences — in particular it could not carry a reflection.
  float cosTheta = clamp(dot(normal, viewDir), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);

  vec3 reflected = reflect(-viewDir, normal);
  // A wave slope can point the reflected ray below the horizon. There is no sky
  // down there to sample, and the far shore it would really reflect is not
  // being drawn, so fold it back up.
  reflected.y = abs(reflected.y);
  // Whatever the eye cannot resolve becomes roughness. This is the line that
  // turns the sun's half-degree disc into a glitter path.
  // 6° of RMS slope at distance, half a degree close up. An inland bay in a
  // light breeze, not open ocean — which is both what these sites are and what
  // keeps the glitter path a path rather than a wash.
  float spread = mix(0.105, 0.012, detail);
  vec3 reflection = skyReflection(reflected, spread);

  float deepness = clamp(depth / ${DEPTH_SCALE.toFixed(1)}, 0.0, 1.0);
  vec3 body = mix(uWaterDeep * 1.35, uWaterDeep, deepness) * (uWaterDaylight * uWaterExposure);

  gl_FragColor = vec4(mix(body, reflection, fresnel), mix(uWaterOpacity, 1.0, fresnel) * shore * fade);

  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Half-float R texture of the §7 connect grid, addressed by world XZ. */
function connectTexture(grid: ConnectGrid): THREE.DataTexture {
  const data = new Uint16Array(grid.values.length);
  for (let i = 0; i < grid.values.length; i++) data[i] = THREE.DataUtils.toHalfFloat(grid.values[i]);
  const texture = new THREE.DataTexture(data, grid.width, grid.height, THREE.RedFormat, THREE.HalfFloatType);
  // Linear filtering is what makes the shoreline a smooth contour instead of a
  // 2 m staircase; half-float is filterable in WebGL2 core (R32F is not).
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export class WaterLayer {
  /** Parent this under `terrain.group` so it inherits vertical exaggeration. */
  readonly mesh: THREE.Mesh;
  readonly table: ShorelineTable;
  readonly connect: ConnectGrid;
  /** [oldest, newest] yearCE — the slider's extent (contract §6). */
  readonly years: [number, number];

  private readonly texture: THREE.DataTexture;
  private farTexture: THREE.DataTexture | null = null;
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms: {
    uWaterConnect: { value: THREE.DataTexture };
    uWaterRect: { value: THREE.Vector4 };
    uWaterLevel: { value: number };
    uWaterOn: { value: number };
  };
  private readonly daylightUniform = { value: 1 };
  private readonly exposureUniform = { value: 1 };
  private readonly timeUniform = { value: 0 };
  private readonly sky: SkyUniforms;
  private readonly farUniforms: {
    uWaterConnectFar: { value: THREE.Texture };
    uWaterFarRect: { value: THREE.Vector4 };
    uWaterFarOn: { value: number };
    uWaterFadeHalf: { value: THREE.Vector2 };
  };
  private year: number;

  constructor(
    table: ShorelineTable,
    connect: ConnectGrid,
    /**
     * The sky's uniforms, **shared by reference** with the dome, so the water
     * reflects the same sky that is drawn. Defaulted so the layer still stands
     * up alone in a test; in the app `main.ts` passes `nightSky.uniforms`.
     */
    sky: SkyUniforms = createSkyUniforms(),
  ) {
    this.sky = sky;
    this.table = table;
    this.connect = connect;
    this.years = yearRange(table);
    this.year = this.years[1];

    this.texture = connectTexture(connect);
    const b: BoundsLocal = connect.boundsLocal;
    this.uniforms = {
      uWaterConnect: { value: this.texture },
      uWaterRect: {
        value: new THREE.Vector4(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ)),
      },
      uWaterLevel: { value: levelAt(table, this.year) },
      uWaterOn: { value: 0 },
    };

    // §11 far water starts disabled with a 1x1 placeholder texture, so the one
    // compiled program serves both ringless and ringed sites (no recompile when
    // the ring connect streams in later).
    this.farUniforms = {
      uWaterConnectFar: { value: new THREE.Texture() },
      uWaterFarRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uWaterFarOn: { value: 0 },
      uWaterFadeHalf: { value: new THREE.Vector2(1, 2) },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        // Fog uniforms are cloned (they are the renderer's to fill in); the
        // uWater* objects are shared *by reference* with the terrain injection,
        // so one assignment moves the plane and the tint together.
        ...THREE.UniformsUtils.clone(THREE.UniformsLib['fog']),
        ...this.uniforms,
        ...this.farUniforms,
        // Shared by reference with sky/skyDome.ts — the reflection and the sky
        // it reflects can never disagree because they read the same objects.
        ...(sky as unknown as Record<string, THREE.IUniform>),
        uWaterOpacity: { value: 0.74 },
        uWaterDaylight: this.daylightUniform,
        uWaterExposure: this.exposureUniform,
        uWaterTime: this.timeUniform,
        uWaterDeep: { value: new THREE.Color().setStyle('#254c58', THREE.SRGBColorSpace) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: WATER_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide, // the first-person camera can stand below the level
      fog: true,
    });

    const geometry = new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'water-plane';
    this.mesh.position.set((b.minX + b.maxX) / 2, this.uniforms.uWaterLevel.value, (b.minZ + b.maxZ) / 2);
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  /**
   * Inject the submerged-ground tint into one terrain material, chaining any
   * handler already there (see the module comment). Call once per material.
   */
  attachTerrain(material: THREE.Material): void {
    const uniforms = this.uniforms;
    const previousCompile = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey.bind(material);

    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vWaterXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWaterXZ = (modelMatrix * vec4(position, 1.0)).xz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'varying vec2 vWaterXZ;',
            'uniform sampler2D uWaterConnect;',
            'uniform vec4 uWaterRect;',
            'uniform float uWaterLevel;',
            'uniform float uWaterOn;',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            'if (uWaterOn > 0.5) {',
            '  vec2 wUv = (vWaterXZ - uWaterRect.xy) * uWaterRect.zw;',
            '  if (all(greaterThanEqual(wUv, vec2(0.0))) && all(lessThanEqual(wUv, vec2(1.0)))) {',
            '    // connect <= level: wet AND sea-connected, one lookup (contract §7).',
            `    float wDepth = uWaterLevel - texture2D(uWaterConnect, wUv).r;`,
            `    float wWet = smoothstep(0.0, ${SHORE_FADE.toFixed(3)}, wDepth);`,
            '    if (wWet > 0.0) {',
            `      float wDeep = clamp(wDepth / ${DEPTH_SCALE.toFixed(1)}, 0.0, 1.0);`,
            '      vec3 wBed = gl_FragColor.rgb * mix(vec3(0.62, 0.72, 0.78), vec3(0.10, 0.20, 0.26), wDeep);',
            '      gl_FragColor.rgb = mix(gl_FragColor.rgb, wBed, wWet * 0.9);',
            '    }',
            '  }',
            '}',
            '#include <dithering_fragment>',
          ].join('\n'),
        );
    };

    // Never let a water-injected program be reused for a material without it.
    material.customProgramCacheKey = () => `${previousKey()}|water1`;
    material.needsUpdate = true;
  }

  /**
   * §11: extend the paleo-water out to a far-field ring. The plane grows to the
   * ring's bounds; outside the context rect the fragment shader samples this
   * grid instead and fades the water radially from the context edge to the ring
   * edge (see the shader). The submerged-ground tint stays context-only — ring
   * terrain takes no overlays, and beyond 2 km the plane itself reads as water.
   */
  setFarConnect(connect: ConnectGrid): void {
    this.farTexture?.dispose();
    this.farTexture = connectTexture(connect);
    const b = connect.boundsLocal;
    const near = this.connect.boundsLocal;
    this.farUniforms.uWaterConnectFar.value = this.farTexture;
    this.farUniforms.uWaterFarRect.value.set(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ));
    this.farUniforms.uWaterFadeHalf.value.set(
      Math.max(near.maxX - near.minX, near.maxZ - near.minZ) / 2,
      Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2,
    );
    this.farUniforms.uWaterFarOn.value = 1;

    this.mesh.geometry.dispose();
    const geometry = new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ);
    geometry.rotateX(-Math.PI / 2);
    this.mesh.geometry = geometry;
    this.mesh.position.set((b.minX + b.maxX) / 2, this.uniforms.uWaterLevel.value, (b.minZ + b.maxZ) / 2);
  }

  /**
   * The sky uniforms this plane reflects — the same objects the dome draws
   * from. Exposed so a headless check can confirm the sharing rather than
   * assume it.
   */
  get skyUniforms(): SkyUniforms {
    return this.sky;
  }

  /** Whether the §11 far-water extension is active (dev hook / tests). */
  get hasFarWater(): boolean {
    return this.farUniforms.uWaterFarOn.value > 0.5;
  }

  /** Level (m, unexaggerated) at a year, per the §6 table. */
  levelAt(yearCE: number): number {
    return levelAt(this.table, yearCE);
  }

  /** Scrub to a year (clamped to the table's extent) and move the plane. */
  setYear(yearCE: number): void {
    this.year = Math.min(this.years[1], Math.max(this.years[0], yearCE));
    const level = levelAt(this.table, this.year);
    this.uniforms.uWaterLevel.value = level;
    // Local Y inside the Y-scaled terrain group: the plane rises with the
    // exaggerated terrain automatically (contract §0).
    this.mesh.position.y = level;
  }

  /**
   * 0..1 daylight factor from the atmosphere ramp. The body of the water lights
   * itself, so this is what keeps the sea from glowing after sunset. It does
   * *not* touch the reflection: a reflected sunset is as bright as the sunset.
   */
  setDaylight(factor: number): void {
    this.daylightUniform.value = Math.max(0, Math.min(1, factor));
  }

  /**
   * `renderer.toneMappingExposure`. This shader dropped `tonemapping_fragment`
   * so that the sky it reflects and the sky above the horizon line come out the
   * same colour — the sky has never been tone-mapped — which leaves the body of
   * the water to carry the exposure itself.
   */
  setExposure(exposure: number): void {
    this.exposureUniform.value = exposure;
  }

  /** Seconds, for the waves. Ticked from the render loop. */
  setTime(seconds: number): void {
    this.timeUniform.value = seconds;
  }

  setEnabled(on: boolean): void {
    this.uniforms.uWaterOn.value = on ? 1 : 0;
    this.mesh.visible = on;
  }

  get enabled(): boolean {
    return this.uniforms.uWaterOn.value > 0.5;
  }

  get yearCE(): number {
    return this.year;
  }

  get levelM(): number {
    return this.uniforms.uWaterLevel.value;
  }

  dispose(): void {
    this.texture.dispose();
    this.farTexture?.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
