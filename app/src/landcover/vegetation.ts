/**
 * Procedural vegetation for the modeled landscape (Phase 7, PLAN §4.7/§6.1;
 * contract §9 "Rendering contract").
 *
 * The §9 raster says *what kind* of ground each 2 m cell is; the §10 legend says how
 * densely that kind was vegetated. This module turns the two into instanced
 * geometry — cones for `conifer`, rounder crowns for `broadleaf`, cross-quad
 * billboards for `reeds` — and nothing more. It is a **model**: flat colours, no
 * textures, deliberately schematic, so nobody mistakes it for a reconstruction of a
 * particular wood.
 *
 * Four invariants, all easy to break later:
 *
 *   • **Deterministic for a seed.** Placement and per-instance jitter both come from
 *     `lib/random`'s mulberry32, walked in a fixed order, so the same seed is the
 *     same forest on every machine and in every screenshot (the palisade rule).
 *   • **Vertical exaggeration is a render-only Y scale on the terrain _group_**
 *     (contract §0). Plants must stand *on* the exaggerated ground while keeping
 *     their true metric size, so this layer lives in the scene *outside* that group
 *     and positions each instance at `y = ground · exaggeration` itself.
 *   • **Nothing stands in the sea.** An instance whose ground cell is wet at the
 *     *current* slider level (`connect ≤ level`, §7 semantics) is suppressed, so
 *     scrubbing the Phase-4 slider never shows trees wading. The connect value is
 *     sampled once per instance at build time; a level change is then O(n) matrix
 *     writes with no resampling.
 *   • **The density slider scales every class together** (§10: "the app may scale it
 *     globally for performance, never per class").
 */

import * as THREE from 'three';
import { mulberry32, streamSeed } from '../lib/random';
import { classAtLocal, type LandcoverGrid } from './landcoverGrid';
import { vegetationClasses, type LandcoverLegend, type VegetationType } from './legend';

/** Square meters per hectare — the unit `densityPerHa` is quoted in (§10). */
const M2_PER_HA = 10_000;

/**
 * Hard ceiling on instances across all types. Above this the *whole* model is scaled
 * down proportionally (never one class at a time) and the fact is logged, because a
 * silently thinned forest would misreport the model's density.
 */
export const MAX_INSTANCES = 120_000;

export interface VegetationParams {
  /** Integer seed for placement + jitter. Same seed ⇒ same vegetation. */
  seed: number;
  /** Global multiplier on every class's `densityPerHa` (§10). */
  densityScale: number;
}

export const DEFAULT_VEGETATION_PARAMS: VegetationParams = { seed: 1, densityScale: 1 };

/** Metric size of each procedural form, before per-instance jitter. */
export interface VegetationForm {
  /** Height in meters — true metric size, never scaled by exaggeration. */
  heightM: number;
  /** Width as a fraction of the height. */
  widthRatio: number;
  /** ± fraction of height jitter. */
  heightJitter: number;
  /** ± fraction of width jitter. */
  widthJitter: number;
  /** ± lean, radians. */
  leanRad: number;
}

export const VEGETATION_FORMS: Record<VegetationType, VegetationForm> = {
  // Boreal spruce/pine: tall, narrow, strongly varied in height.
  conifer: { heightM: 13, widthRatio: 0.34, heightJitter: 0.28, widthJitter: 0.15, leanRad: (3 * Math.PI) / 180 },
  // Oak/lime/hazel woodland: shorter, much broader crown.
  broadleaf: { heightM: 9.5, widthRatio: 0.8, heightJitter: 0.26, widthJitter: 0.18, leanRad: (4 * Math.PI) / 180 },
  // Reed beds: knee-to-head high clumps, near-uniform.
  reeds: { heightM: 1.8, widthRatio: 0.65, heightJitter: 0.22, widthJitter: 0.2, leanRad: (7 * Math.PI) / 180 },
};

// ------------------------------------------------------------- placement ----

/** One type's instances, as parallel arrays (the counts get large). */
export interface TypeSample {
  type: VegetationType;
  x: Float32Array;
  z: Float32Array;
  /** Which legend class each instance came from — it carries the colour. */
  classIndex: Uint8Array;
}

export interface VegetationSample {
  byType: TypeSample[];
  total: number;
  /** The density multiplier actually used (≤ `params.densityScale` when capped). */
  appliedScale: number;
  capped: boolean;
}

/**
 * Stratified jittered-grid sampling, one pass per vegetated class.
 *
 * Each class gets its own square lattice whose cell area is exactly one instance's
 * worth of ground (`10 000 / densityPerHa` m²), with the instance jittered uniformly
 * inside its cell and kept only where the raster actually says that class. That gives
 * blue-noise-ish spacing without a Poisson-disk pass, is O(cells) per class, and —
 * because the lattice is walked row-major from a per-class RNG stream — is exactly
 * reproducible for a seed.
 *
 * Pure: no three.js, no DOM. The tests pin its determinism.
 */
export function sampleVegetation(
  grid: LandcoverGrid,
  legend: LandcoverLegend,
  params: VegetationParams,
  maxInstances = MAX_INSTANCES,
): VegetationSample {
  const sampleAt = (scale: number): TypeSample[] => {
    const out: TypeSample[] = [];
    const b = grid.boundsLocal;
    const spanX = b.maxX - b.minX;
    const spanZ = b.maxZ - b.minZ;

    for (const cls of vegetationClasses(legend)) {
      const density = cls.vegetation.densityPerHa * scale;
      if (!(density > 0)) continue;
      const spacing = Math.sqrt(M2_PER_HA / density);
      const cols = Math.max(1, Math.ceil(spanX / spacing));
      const rows = Math.max(1, Math.ceil(spanZ / spacing));

      const random = mulberry32(streamSeed(params.seed, cls.index));
      const xs: number[] = [];
      const zs: number[] = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          // Two draws per cell whether or not the cell is kept, so the stream stays
          // aligned to the lattice and the layout cannot depend on the raster's
          // decoding order.
          const x = b.minX + (col + random()) * spacing;
          const z = b.minZ + (row + random()) * spacing;
          if (x > b.maxX || z > b.maxZ) continue;
          if (classAtLocal(grid, x, z) !== cls.index) continue;
          xs.push(x);
          zs.push(z);
        }
      }
      if (xs.length === 0) continue;

      const existing = out.find((t) => t.type === cls.vegetation.type);
      const classIndex = new Uint8Array(xs.length).fill(cls.index);
      if (existing) {
        // Two classes can share a form (e.g. two kinds of conifer wood); they share
        // one InstancedMesh and keep their own colours per instance.
        const merged: TypeSample = {
          type: existing.type,
          x: concatF32(existing.x, Float32Array.from(xs)),
          z: concatF32(existing.z, Float32Array.from(zs)),
          classIndex: concatU8(existing.classIndex, classIndex),
        };
        out[out.indexOf(existing)] = merged;
      } else {
        out.push({
          type: cls.vegetation.type,
          x: Float32Array.from(xs),
          z: Float32Array.from(zs),
          classIndex,
        });
      }
    }
    return out;
  };

  const requested = Math.max(0, params.densityScale);
  let byType = sampleAt(requested);
  let total = byType.reduce((n, t) => n + t.x.length, 0);
  let appliedScale = requested;
  let capped = false;

  if (total > maxInstances && total > 0) {
    // Proportional, global, and re-sampled rather than truncated: a thinned-out
    // forest must still be a *uniform* sample of the same model.
    appliedScale = (requested * maxInstances) / total;
    capped = true;
    byType = sampleAt(appliedScale);
    total = byType.reduce((n, t) => n + t.x.length, 0);
    if (total > maxInstances) {
      // Rounding can still leave a handful over; trim deterministically.
      let budget = maxInstances;
      byType = byType.map((t) => {
        const keep = Math.max(0, Math.min(t.x.length, budget));
        budget -= keep;
        return keep === t.x.length
          ? t
          : { type: t.type, x: t.x.slice(0, keep), z: t.z.slice(0, keep), classIndex: t.classIndex.slice(0, keep) };
      });
      total = byType.reduce((n, t) => n + t.x.length, 0);
    }
  }

  return { byType, total, appliedScale, capped };
}

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// -------------------------------------------------------------- geometry ----

/** Unit height, base at y = 0, unit width — so an instance's scale *is* its size. */
function coniferGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(0.5, 1, 6, 1, false);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/** A low-poly crown: rounder and broader than the conifer cone, still 20 triangles. */
function broadleafGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(0.5, 0);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/**
 * Two perpendicular unit quads, base at y = 0 — the classic cross-billboard, drawn
 * `DoubleSide` so a reed clump reads from every angle without a texture.
 */
function reedsGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  // prettier-ignore
  const positions = new Float32Array([
    -0.5, 0, 0,  0.5, 0, 0,  0.5, 1, 0,  -0.5, 1, 0,
    0, 0, -0.5,  0, 0, 0.5,  0, 1, 0.5,  0, 1, -0.5,
  ]);
  // prettier-ignore
  const normals = new Float32Array([
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
    1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
  ]);
  // prettier-ignore
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return geometry;
}

function geometryFor(type: VegetationType): THREE.BufferGeometry {
  if (type === 'conifer') return coniferGeometry();
  if (type === 'broadleaf') return broadleafGeometry();
  return reedsGeometry();
}

/**
 * Flat, cheap, slightly desaturated: PLAN §6.1 asks for stylized rendering, and the
 * ground wash already carries the class colour, so the plants sit a shade darker and
 * duller than their class rather than shouting over it.
 */
function plantColor(hex: string): THREE.Color {
  const color = new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return color.setHSL(hsl.h, hsl.s * 0.85, hsl.l * 0.82);
}

// ---------------------------------------------------------------- layer -----

/** Stable order for the per-form jitter streams (see `VegetationLayer.rebuild`). */
const VEGETATION_TYPE_ORDER: VegetationType[] = ['conifer', 'broadleaf', 'reeds'];

export interface VegetationOptions {
  /** Unexaggerated ground height at local (x, z) — the app's single sampler. */
  groundAt(x: number, z: number): number;
  /** Current vertical exaggeration (the terrain group's Y scale). */
  getExaggeration(): number;
  /**
   * §7 connect level at local (x, z), or `null`/omitted when the site ships no water
   * assets (then nothing is ever wet and nothing is ever suppressed).
   */
  connectAt?: ((x: number, z: number) => number) | null;
}

interface Batch {
  type: VegetationType;
  sample: TypeSample;
  /** Cached per instance so an exaggeration or level change never resamples. */
  ground: Float32Array;
  connect: Float32Array;
  height: Float32Array;
  width: Float32Array;
  yaw: Float32Array;
  leanX: Float32Array;
  leanZ: Float32Array;
  mesh: THREE.InstancedMesh;
}

/**
 * One `InstancedMesh` per vegetation form, all under one group.
 *
 * Add the group to the **scene**, never to `terrain.group` — see the module comment.
 * Changing the seed or density rebuilds the instance buffers; changing exaggeration
 * or the water level only rewrites the existing matrices.
 */
export class VegetationLayer {
  /** Add this to the scene (outside the terrain group). */
  readonly group = new THREE.Group();
  readonly legend: LandcoverLegend;

  private readonly grid: LandcoverGrid;
  private readonly options: VegetationOptions;
  private readonly materials = new Map<VegetationType, THREE.Material>();
  private readonly geometries = new Map<VegetationType, THREE.BufferGeometry>();
  private batches: Batch[] = [];
  private params: VegetationParams;
  private enabled = false;
  /** Current water level for the suppression test; +∞ means "no water anywhere". */
  private waterLevelM = Number.NEGATIVE_INFINITY;
  private lastSample: VegetationSample = { byType: [], total: 0, appliedScale: 1, capped: false };

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scale = new THREE.Vector3();

  constructor(
    grid: LandcoverGrid,
    legend: LandcoverLegend,
    options: VegetationOptions,
    params: Partial<VegetationParams> = {},
  ) {
    this.grid = grid;
    this.legend = legend;
    this.options = options;
    this.params = { ...DEFAULT_VEGETATION_PARAMS, ...params };
    this.group.name = 'landcover-vegetation';
    this.group.visible = false;
    this.rebuild();
  }

  /** Total instances currently placed (hidden ones included). */
  get count(): number {
    return this.lastSample.total;
  }

  /** Instances not suppressed by the current water level. */
  get visibleCount(): number {
    let n = 0;
    for (const batch of this.batches) {
      for (let i = 0; i < batch.connect.length; i++) {
        if (!(batch.connect[i] <= this.waterLevelM)) n++;
      }
    }
    return n;
  }

  get currentParams(): VegetationParams {
    return { ...this.params };
  }

  /** The density multiplier actually in force — below the requested one when capped. */
  get appliedDensityScale(): number {
    return this.lastSample.appliedScale;
  }

  get wasCapped(): boolean {
    return this.lastSample.capped;
  }

  /** Instance counts per form, for the readout and the tests. */
  countsByType(): Record<string, number> {
    return Object.fromEntries(this.batches.map((b) => [b.type, b.sample.x.length]));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setParams(next: Partial<VegetationParams>): void {
    const merged = { ...this.params, ...next };
    const relayout = merged.seed !== this.params.seed || merged.densityScale !== this.params.densityScale;
    this.params = merged;
    if (relayout) this.rebuild();
  }

  /**
   * Suppress everything standing in water at `levelM` (contract §9). `null` means
   * "no water level in play" — nothing is suppressed.
   */
  setWaterLevel(levelM: number | null): void {
    const next = levelM === null ? Number.NEGATIVE_INFINITY : levelM;
    if (next === this.waterLevelM) return;
    this.waterLevelM = next;
    this.refreshMatrices();
  }

  get waterLevel(): number | null {
    return this.waterLevelM === Number.NEGATIVE_INFINITY ? null : this.waterLevelM;
  }

  /** Re-seat every instance on the (possibly re-exaggerated) surface. */
  refreshHeights(): void {
    this.refreshMatrices();
  }

  /** Is instance `index` of `type` suppressed by the current water level? */
  isSuppressed(type: VegetationType, index: number): boolean {
    const batch = this.batchOf(type);
    return batch.connect[index] <= this.waterLevelM;
  }

  /** The instance matrix of `type` instance `index`, for tests and dev hooks. */
  instanceMatrix(type: VegetationType, index: number, target = new THREE.Matrix4()): THREE.Matrix4 {
    const batch = this.batchOf(type);
    if (index < 0 || index >= batch.sample.x.length) {
      throw new RangeError(`vegetation: no ${type} instance at index ${index} (count ${batch.sample.x.length})`);
    }
    batch.mesh.getMatrixAt(index, target);
    return target;
  }

  dispose(): void {
    this.disposeMeshes();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
  }

  private batchOf(type: VegetationType): Batch {
    const batch = this.batches.find((b) => b.type === type);
    if (!batch) throw new RangeError(`vegetation: no instances of type ${type}`);
    return batch;
  }

  private disposeMeshes(): void {
    for (const batch of this.batches) {
      this.group.remove(batch.mesh);
      batch.mesh.dispose();
    }
    this.batches = [];
  }

  private geometryOf(type: VegetationType): THREE.BufferGeometry {
    let geometry = this.geometries.get(type);
    if (!geometry) {
      geometry = geometryFor(type);
      this.geometries.set(type, geometry);
    }
    return geometry;
  }

  private materialOf(type: VegetationType): THREE.Material {
    let material = this.materials.get(type);
    if (!material) {
      material = new THREE.MeshLambertMaterial({
        // Flat shading and no map: a stylized model, never a photographic one.
        flatShading: type !== 'reeds',
        side: type === 'reeds' ? THREE.DoubleSide : THREE.FrontSide,
      });
      material.name = `vegetation-${type}`;
      this.materials.set(type, material);
    }
    return material;
  }

  private rebuild(): void {
    this.disposeMeshes();
    const sample = sampleVegetation(this.grid, this.legend, this.params);
    this.lastSample = sample;
    if (sample.capped) {
      console.info(
        `[fornborg] land-cover vegetation capped at ${MAX_INSTANCES.toLocaleString('en-US')} instances — ` +
          `density scaled globally to ×${sample.appliedScale.toFixed(3)} of the model's ` +
          'densityPerHa (docs/data-formats.md §10: never per class).',
      );
    }

    const colors = new Map<number, THREE.Color>();
    for (const cls of this.legend.classes) colors.set(cls.index, plantColor(cls.color));

    for (const typeSample of sample.byType) {
      const n = typeSample.x.length;
      if (n === 0) continue;
      const form = VEGETATION_FORMS[typeSample.type];

      // Jitter draws from its own stream, so adding a form later cannot reshuffle
      // an existing one's placement.
      const random = mulberry32(streamSeed(this.params.seed, 100 + VEGETATION_TYPE_ORDER.indexOf(typeSample.type)));
      const ground = new Float32Array(n);
      const connect = new Float32Array(n);
      const height = new Float32Array(n);
      const width = new Float32Array(n);
      const yaw = new Float32Array(n);
      const leanX = new Float32Array(n);
      const leanZ = new Float32Array(n);

      for (let i = 0; i < n; i++) {
        const x = typeSample.x[i];
        const z = typeSample.z[i];
        ground[i] = this.options.groundAt(x, z);
        connect[i] = this.options.connectAt ? this.options.connectAt(x, z) : Number.POSITIVE_INFINITY;
        const h = form.heightM * (1 + (random() * 2 - 1) * form.heightJitter);
        height[i] = h;
        width[i] = h * form.widthRatio * (1 + (random() * 2 - 1) * form.widthJitter);
        yaw[i] = random() * Math.PI * 2;
        leanX[i] = (random() * 2 - 1) * form.leanRad;
        leanZ[i] = (random() * 2 - 1) * form.leanRad;
      }

      const mesh = new THREE.InstancedMesh(this.geometryOf(typeSample.type), this.materialOf(typeSample.type), n);
      mesh.name = `vegetation-${typeSample.type}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      for (let i = 0; i < n; i++) {
        mesh.setColorAt(i, colors.get(typeSample.classIndex[i]) ?? new THREE.Color(0x6b8f5a));
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      this.batches.push({
        type: typeSample.type,
        sample: typeSample,
        ground,
        connect,
        height,
        width,
        yaw,
        leanX,
        leanZ,
        mesh,
      });
      this.group.add(mesh);
    }

    this.refreshMatrices();
  }

  /**
   * Instance transforms: standing on the exaggerated ground at true metric size, or
   * collapsed to zero scale when the ground is under water at the current level.
   * Y/XZ scale carries the size, so exaggeration touches only the position — that
   * separation is the whole point (contract §0).
   */
  private refreshMatrices(): void {
    const exaggeration = this.options.getExaggeration();
    for (const batch of this.batches) {
      const n = batch.sample.x.length;
      for (let i = 0; i < n; i++) {
        const x = batch.sample.x[i];
        const z = batch.sample.z[i];
        const wet = batch.connect[i] <= this.waterLevelM;
        this.position.set(x, batch.ground[i] * exaggeration, z);
        this.euler.set(batch.leanX[i], batch.yaw[i], batch.leanZ[i], 'YXZ');
        this.quaternion.setFromEuler(this.euler);
        if (wet) this.scale.set(0, 0, 0);
        else this.scale.set(batch.width[i], batch.height[i], batch.width[i]);
        batch.mesh.setMatrixAt(i, this.matrix.compose(this.position, this.quaternion, this.scale));
      }
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
    }
  }
}
