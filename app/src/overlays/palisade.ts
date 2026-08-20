/**
 * The conjectural palisade (Phase 5, PLAN §4.6.3; contract §8).
 *
 * `rampart.json` carries a **measured** crest line — the ridge the pipeline pulled
 * out of the 1 m DEM — and nothing else. Everything this module adds on top of it
 * (that there were posts at all, how tall, how far apart) is conjecture: no palisade
 * has been excavated at Broborg. So the rendering is deliberately schematic — ghosted
 * cyan cylinders with a fresnel rim, seeded jitter in height and lean, no textures, no
 * gates, no walkways — and the UI folder, the layer provenance and a first-enable
 * caveat all say "conjectural" out loud (PLAN §6.1).
 *
 * Two invariants worth stating, because both are easy to break later:
 *
 *   • **No heights in the data** (contract §8). Post ground heights are sampled at
 *     runtime through the app's own ground sampler, so the line can never drift from
 *     the terrain under it.
 *   • **Vertical exaggeration is a render-only Y scale on the terrain _group_**
 *     (contract §0). The posts must stand *on* the exaggerated ground while keeping
 *     their true metric height — a 3 m post is 3 m at ×1 and at ×2.5 — so this layer
 *     lives in the scene *outside* that group and positions each instance at
 *     `y = ground · exaggeration` itself, refreshed whenever the exaggeration changes.
 *     Same pattern as `ObserverMarker.refreshHeight`.
 */

import * as THREE from 'three';
import type { BoundsLocal } from '../lib/coords';

// ------------------------------------------------------------- the asset ----

export interface RampartPath {
  id: string;
  name: string;
  /** True = ring; the closing segment is implicit (last point ≠ first). */
  closed: boolean;
  lengthM: number;
  /** Local scene `[x, z]` pairs (contract §0). Never heights. */
  points: [number, number][];
}

export interface RampartDerivation {
  method: string;
  description: string;
  generated: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RampartFile {
  schemaVersion: number;
  site?: string;
  derivation: RampartDerivation;
  paths: RampartPath[];
  [key: string]: unknown;
}

export class RampartError extends Error {
  override readonly name = 'RampartError';
}

export const SUPPORTED_RAMPART_VERSION = 1;
/** Contract §8: the pipeline densifies to ~0.5 m and guarantees ≤ 1 m. */
export const MAX_POINT_SPACING_M = 1.0;
const MIN_POINTS = 3;

/**
 * Validate a parsed `rampart.json`. Hard-fail with one clear message naming the
 * offending field — same style as `state/manifest.ts` and `water/shoreline.ts`; the
 * loader turns any throw into "feature off" rather than a broken scene.
 *
 * `bounds` (the core grid's `boundsLocal`) is checked when given: a point outside the
 * grid has no ground height to stand on, which the contract forbids for exactly that
 * reason.
 */
export function validateRampart(raw: unknown, path = 'rampart.json', bounds?: BoundsLocal): RampartFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RampartError(`${path} must be a JSON object (docs/data-formats.md §8)`);
  }
  const file = raw as Record<string, unknown>;

  if (file['schemaVersion'] !== SUPPORTED_RAMPART_VERSION) {
    throw new RampartError(
      `${path}: unsupported schemaVersion ${JSON.stringify(file['schemaVersion'])} — this build reads ` +
        `schemaVersion ${SUPPORTED_RAMPART_VERSION} (docs/data-formats.md §8).`,
    );
  }

  const derivation = file['derivation'];
  if (typeof derivation !== 'object' || derivation === null || Array.isArray(derivation)) {
    throw new RampartError(`${path}: derivation must be an object (§8) — it is what the methods panel shows.`);
  }
  const d = derivation as Record<string, unknown>;
  for (const key of ['method', 'description', 'generated'] as const) {
    if (typeof d[key] !== 'string' || d[key] === '') {
      throw new RampartError(`${path}: derivation.${key} must be a non-empty string (§8).`);
    }
  }

  const rawPaths = file['paths'];
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new RampartError(`${path}: paths must be a non-empty array (§8).`);
  }

  const seen = new Set<string>();
  const paths: RampartPath[] = rawPaths.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new RampartError(`${path}: paths[${i}] must be an object.`);
    }
    const p = entry as Record<string, unknown>;
    const id = p['id'];
    if (typeof id !== 'string' || id === '') {
      throw new RampartError(`${path}: paths[${i}].id must be a non-empty string.`);
    }
    if (seen.has(id)) throw new RampartError(`${path}: duplicate path id ${JSON.stringify(id)}.`);
    seen.add(id);
    const label = `paths[${id}]`;

    if (typeof p['name'] !== 'string' || p['name'] === '') {
      throw new RampartError(`${path}: ${label}.name must be a non-empty string.`);
    }
    if (typeof p['closed'] !== 'boolean') {
      throw new RampartError(`${path}: ${label}.closed must be a boolean (§8).`);
    }

    const rawPoints = p['points'];
    if (!Array.isArray(rawPoints) || rawPoints.length < MIN_POINTS) {
      throw new RampartError(
        `${path}: ${label}.points needs at least ${MIN_POINTS} positions, got ` +
          `${Array.isArray(rawPoints) ? rawPoints.length : 0} (§8).`,
      );
    }
    const points: [number, number][] = rawPoints.map((position, j) => {
      if (!Array.isArray(position) || position.length < 2) {
        throw new RampartError(`${path}: ${label}.points[${j}] must be an [x, z] pair (§8).`);
      }
      const [x, z] = position as unknown[];
      if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) {
        throw new RampartError(
          `${path}: ${label}.points[${j}] = ${JSON.stringify(position)} is not a finite [x, z] pair (§8).`,
        );
      }
      if (
        bounds &&
        (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ)
      ) {
        throw new RampartError(
          `${path}: ${label}.points[${j}] = [${x}, ${z}] lies outside the core grid bounds ` +
            `(x ${bounds.minX}…${bounds.maxX}, z ${bounds.minZ}…${bounds.maxZ}) — there is no ground ` +
            'height to stand a post on there (§8).',
        );
      }
      return [x, z];
    });

    const closed = p['closed'] as boolean;
    if (closed && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]) {
      throw new RampartError(
        `${path}: ${label} is closed, so the closing segment is implicit — the last point must not ` +
          'repeat the first (§8).',
      );
    }

    let worst = 0;
    const last = closed ? points.length : points.length - 1;
    for (let j = 0; j < last; j++) {
      const a = points[j];
      const b = points[(j + 1) % points.length];
      worst = Math.max(worst, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    if (worst > MAX_POINT_SPACING_M + 1e-9) {
      throw new RampartError(
        `${path}: ${label} has a ${worst.toFixed(2)} m gap between consecutive points; the contract ` +
          `densifies to ≤ ${MAX_POINT_SPACING_M} m (§8).`,
      );
    }

    const lengthM = typeof p['lengthM'] === 'number' && Number.isFinite(p['lengthM']) ? p['lengthM'] : polylineLength(points, closed);
    return { id, name: p['name'] as string, closed, lengthM, points };
  });

  return { ...(file as object), schemaVersion: SUPPORTED_RAMPART_VERSION, paths } as RampartFile;
}

/** Length along a polyline, including the closing segment when `closed`. */
export function polylineLength(points: readonly [number, number][], closed: boolean): number {
  let total = 0;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

// -------------------------------------------------------- post placement ----

export interface PostPlacement {
  x: number;
  z: number;
  /** Heading of the line at this post (radians, atan2(dz, dx)); posts lean across it. */
  heading: number;
}

/**
 * Walk the polyline and drop a post every `spacingM` meters of arc length.
 *
 * The walk is by arc length rather than per vertex, so the spacing the UI shows is
 * the spacing on the ground whatever the source densification was. A closed ring
 * gets its spacing nudged to divide the perimeter exactly, so the ring closes
 * without a double post at the seam.
 */
export function postPlacements(
  points: readonly [number, number][],
  closed: boolean,
  spacingM: number,
): PostPlacement[] {
  if (points.length < 2 || !(spacingM > 0)) return [];
  const total = polylineLength(points, closed);
  if (total <= 0) return [];

  const count = Math.max(2, Math.round(total / spacingM));
  const step = closed ? total / count : spacingM;
  const posts: PostPlacement[] = [];

  const segments = closed ? points.length : points.length - 1;
  let segment = 0;
  let walked = 0; // arc length consumed inside the current segment
  let target = 0; // arc length of the next post from the start

  while (target <= total + 1e-9) {
    if (!closed && target > total) break;
    // Advance to the segment containing `target`.
    let a = points[segment % points.length];
    let b = points[(segment + 1) % points.length];
    let length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (segment < segments && walked + length < target - 1e-9) {
      walked += length;
      segment++;
      if (segment >= segments) break;
      a = points[segment % points.length];
      b = points[(segment + 1) % points.length];
      length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (segment >= segments) break;

    const t = length > 0 ? (target - walked) / length : 0;
    posts.push({
      x: a[0] + (b[0] - a[0]) * t,
      z: a[1] + (b[1] - a[1]) * t,
      heading: Math.atan2(b[1] - a[1], b[0] - a[0]),
    });
    target += step;
    if (closed && posts.length >= count) break;
  }

  return posts;
}

// -------------------------------------------------------------- rendering ---

/** mulberry32 — 32-bit, seedable, identical everywhere. The jitter must be reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PalisadeParams {
  /** True post height in meters — never scaled by vertical exaggeration. */
  heightM: number;
  spacingM: number;
  /** Integer seed for the height/lean jitter. Same seed ⇒ same palisade. */
  seed: number;
}

export const DEFAULT_PALISADE_PARAMS: PalisadeParams = { heightM: 3.0, spacingM: 0.4, seed: 1 };

export const POST_RADIUS_BOTTOM = 0.15;
export const POST_RADIUS_TOP = 0.09;
/** ±10 % on height, ±3° of lean: enough to read as schematic, not as a reconstruction. */
export const HEIGHT_JITTER = 0.1;
export const LEAN_JITTER_RAD = (3 * Math.PI) / 180;

export interface PostJitter {
  /** Multiplier on `heightM`, in [1 − HEIGHT_JITTER, 1 + HEIGHT_JITTER]. */
  height: Float32Array;
  /** Lean angles about the X and Z axes (radians). */
  leanX: Float32Array;
  leanZ: Float32Array;
}

/** Deterministic per-post jitter for a seed. Pure — the tests pin it. */
export function postJitter(seed: number, count: number): PostJitter {
  const random = mulberry32(seed);
  const height = new Float32Array(count);
  const leanX = new Float32Array(count);
  const leanZ = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    height[i] = 1 + (random() * 2 - 1) * HEIGHT_JITTER;
    leanX[i] = (random() * 2 - 1) * LEAN_JITTER_RAD;
    leanZ[i] = (random() * 2 - 1) * LEAN_JITTER_RAD;
  }
  return { height, leanX, leanZ };
}

const GLOW_COLOR = '#bff3ff';
const POST_COLOR = '#79c6dd';
const OPACITY = 0.45;

function createPostGeometry(): THREE.CylinderGeometry {
  // Unit height with the base at y = 0, so an instance's Y scale *is* its height.
  const geometry = new THREE.CylinderGeometry(POST_RADIUS_TOP, POST_RADIUS_BOTTOM, 1, 6, 1, false);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/**
 * Ghosted material: cool hue, semi-transparent, no depth write (so posts never
 * punch holes in each other or in the water plane), plus a fresnel rim so the
 * silhouette stays readable against both sky and ground.
 */
function createPostMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setStyle(POST_COLOR, THREE.SRGBColorSpace),
    roughness: 0.75,
    metalness: 0.0,
    transparent: true,
    opacity: OPACITY,
    depthWrite: false,
  });

  const glow = { value: new THREE.Color().setStyle(GLOW_COLOR, THREE.SRGBColorSpace) };
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uPalisadeGlow'] = glow;
    // Own varyings rather than three's internals, so the injection cannot break on
    // a shader-chunk rename (same defensive idiom as water/water.ts).
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPalNormal;\nvarying vec3 vPalView;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvPalNormal = normalize(transformedNormal);\nvPalView = -mvPosition.xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vPalNormal;\nvarying vec3 vPalView;\nuniform vec3 uPalisadeGlow;',
      )
      .replace(
        '#include <dithering_fragment>',
        [
          'float palFresnel = pow(1.0 - clamp(abs(dot(normalize(vPalNormal), normalize(vPalView))), 0.0, 1.0), 3.0);',
          'gl_FragColor.rgb = mix(gl_FragColor.rgb, uPalisadeGlow, palFresnel * 0.8);',
          'gl_FragColor.a = clamp(gl_FragColor.a + palFresnel * 0.4, 0.0, 1.0);',
          '#include <dithering_fragment>',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'palisade-fresnel-1';
  return material;
}

export interface PalisadeOptions {
  /** Unexaggerated ground height at local (x, z) — the app's single sampler. */
  groundAt(x: number, z: number): number;
  /** Current vertical exaggeration (the terrain group's Y scale). */
  getExaggeration(): number;
}

/**
 * One `InstancedMesh` of tapered posts along the rampart crest.
 *
 * Lives in the scene, **not** under the terrain group — see the module comment.
 * Changing spacing or the seed rebuilds the instance buffer; changing exaggeration
 * only re-seats the existing posts (`refreshHeights`).
 */
export class PalisadeLayer {
  /** Add this to the scene (outside the terrain group). */
  readonly group = new THREE.Group();
  readonly file: RampartFile;

  private readonly options: PalisadeOptions;
  private readonly geometry = createPostGeometry();
  private readonly material = createPostMaterial();
  private mesh: THREE.InstancedMesh | null = null;
  private placements: PostPlacement[] = [];
  private jitter: PostJitter = { height: new Float32Array(), leanX: new Float32Array(), leanZ: new Float32Array() };
  private params: PalisadeParams;
  private enabled = false;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scale = new THREE.Vector3();

  constructor(file: RampartFile, options: PalisadeOptions, params: Partial<PalisadeParams> = {}) {
    this.file = file;
    this.options = options;
    this.params = { ...DEFAULT_PALISADE_PARAMS, ...params };
    this.group.name = 'palisade';
    this.group.visible = false;
    this.rebuild();
  }

  /** Number of posts currently instanced. */
  get count(): number {
    return this.placements.length;
  }

  get currentParams(): PalisadeParams {
    return { ...this.params };
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setParams(next: Partial<PalisadeParams>): void {
    const merged = { ...this.params, ...next };
    const relayout = merged.spacingM !== this.params.spacingM || merged.seed !== this.params.seed;
    this.params = merged;
    if (relayout) this.rebuild();
    else this.refreshHeights();
  }

  /** Re-seat every post on the (possibly re-exaggerated) surface. Cheap: N matrices. */
  refreshHeights(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    const exaggeration = this.options.getExaggeration();
    for (let i = 0; i < this.placements.length; i++) {
      mesh.setMatrixAt(i, this.composeMatrix(i, exaggeration));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  /** The instance matrix of post `i`, for tests and dev hooks. */
  instanceMatrix(index: number, target = new THREE.Matrix4()): THREE.Matrix4 {
    if (!this.mesh || index < 0 || index >= this.placements.length) {
      throw new RangeError(`palisade: no post at index ${index} (count ${this.placements.length})`);
    }
    this.mesh.getMatrixAt(index, target);
    return target;
  }

  dispose(): void {
    this.disposeMesh();
    this.geometry.dispose();
    this.material.dispose();
  }

  private disposeMesh(): void {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
  }

  private rebuild(): void {
    this.disposeMesh();
    this.placements = this.file.paths.flatMap((path) =>
      postPlacements(path.points, path.closed, this.params.spacingM),
    );
    this.jitter = postJitter(this.params.seed, this.placements.length);
    if (this.placements.length === 0) return;

    const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.placements.length);
    mesh.name = 'palisade-posts';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.renderOrder = 2; // after the water plane (renderOrder 1)
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.mesh = mesh;
    this.group.add(mesh);
    this.refreshHeights();
  }

  /**
   * Post `i`'s transform: standing on the exaggerated ground, at its own true
   * metric height. Y scale carries the height, so exaggeration touches only the
   * position — that separation is the whole point (contract §0).
   */
  private composeMatrix(index: number, exaggeration: number): THREE.Matrix4 {
    const post = this.placements[index];
    const ground = this.options.groundAt(post.x, post.z);
    this.position.set(post.x, ground * exaggeration, post.z);
    // Y spins the hexagonal post to face along the line; the two small leans are the
    // jitter. 'YXZ' applies the spin first, so the lean angle stays independent of it.
    this.euler.set(this.jitter.leanX[index], post.heading, this.jitter.leanZ[index], 'YXZ');
    this.quaternion.setFromEuler(this.euler);
    const height = this.params.heightM * this.jitter.height[index];
    this.scale.set(1, height, 1);
    return this.matrix.compose(this.position, this.quaternion, this.scale);
  }
}
