/**
 * Far-field billboard trees (contract v1.6 §13; design: docs/far-field-vegetation.md).
 *
 * Past the context edge a tree subtends a few pixels at most, so the far field
 * renders one camera-facing quad per sampled stem — sampled from the §13 ring
 * class rasters at the legend's far densities (10/ha against the near field's
 * 90–120: the billboards are a disclosed ~one-in-ten stand-in for the stand,
 * never a census). Everything deterministic for a seed, like every procedural
 * layer in this app.
 *
 * Decisions this module encodes, and why:
 *
 *   • **Camera-facing about the vertical axis** (cylindrical billboarding in the
 *     vertex shader; owner-delegated decision 2026-08-22). Fixed side-on quads
 *     are exactly right from the fort and exactly wrong in orbit mode, where
 *     they turn edge-on and the forest silently vanishes — the kind of
 *     view-dependent lie this project refuses. The rotation composes *before*
 *     `instanceMatrix`, which is why billboard instances carry no yaw and a
 *     symmetric XZ scale: `Ry(θ)` then commutes with the scale exactly.
 *   • **Instances sit on the curvature-dropped ring surface.** Ring render
 *     meshes are lowered by `refractedDropM` (terrain.ts §11) while the raw
 *     grids stay flat-earth; a billboard seated on the raw height would float
 *     ~17.5 m above the terrain at 16 km. Ground is therefore sampled from the
 *     ring grid *minus* the same drop, then scaled by exaggeration at matrix
 *     time (contract §0: size stays metric, only position rides the Y scale).
 *   • **Own budget.** `FAR_MAX_INSTANCES` caps the far population with the same
 *     proportional-rescale-and-log rule as the near field's cap — but as a
 *     separate pool, so a forested far field can never thin the near forest.
 *   • **Lazy.** Sampling and GPU buffers are built on first enable (and on ring
 *     arrivals while enabled); a visitor who never toggles the layer pays
 *     nothing for ~10⁴ quads they never see.
 *   • **Nothing stands in far water.** Where the site ships the §11 ring
 *     connect grid, instances are suppressed at `connect ≤ level` (§7
 *     semantics). No grid — no modelled far water, no suppression; terrain
 *     elevation is never a stand-in (§2b.5).
 *   • **Fade-in at the context edge.** Alpha ramps over `FAR_FADE_METERS`
 *     outside the near field's boundary, so the §13 seam is a blend, not a line.
 */

import * as THREE from 'three';
import type { GridSpec } from '../lib/coords';
import { heightAtLocal } from '../lib/coords';
import { refractedDropM } from '../lib/earth';
import { mulberry32, streamSeed } from '../lib/random';
import { classAtLocal, type LandcoverGrid } from './landcoverGrid';
import type { FarFieldClass, VegetationType } from './legend';
import { VEGETATION_FORMS } from './vegetation';

/** Square meters per hectare — the unit §13 billboard densities are quoted in. */
const M2_PER_HA = 10_000;

/**
 * Hard ceiling on far-field billboards, separate from the near field's
 * `MAX_INSTANCES` on purpose (design §1): the near budget is never reduced by
 * far hills. Worst case at 10/ha over a fully forested 2–8 km band is ~72 k.
 */
export const FAR_MAX_INSTANCES = 80_000;

/** Billboards reach at most this far (§13): beyond, a tree is sub-pixel. */
export const FAR_BAND_MAX_RADIUS_M = 8_000;

/** Width of the alpha fade-in band outside the near field's edge (§13 seam). */
export const FAR_FADE_METERS = 200;

/** Stream-id base for far-field sampling (near field uses 0…, 100+, 200+). */
const FAR_STREAM_BASE = 300;

/** One ring's inputs: the §13 class raster, the §11 height grid, and the
 * half-extent of the next-finer grid (whose ground the ring must not repopulate). */
export interface FarRingInput {
  ringIndex: number;
  landcover: LandcoverGrid;
  heights: { heights: Float32Array } & GridSpec;
  innerHalfM: number;
}

export interface FarInstances {
  type: VegetationType;
  x: Float32Array;
  z: Float32Array;
  classIndex: Uint8Array;
  ringIndex: Uint8Array;
}

export interface FarSample {
  instances: FarInstances[];
  total: number;
  appliedScale: number;
  capped: boolean;
}

/**
 * Stratified jittered-grid sampling over the ring annuli — the near field's
 * lattice walk (vegetation.ts) on different ground: only cells outside the
 * next-finer grid's box and inside `FAR_BAND_MAX_RADIUS_M` are eligible, and the
 * class raster consulted is the ring's own. Two draws per lattice cell whether
 * kept or not, so the stream stays aligned and adding a ring later cannot
 * reshuffle an earlier one (each (ring, class) pair owns a stream).
 */
export function sampleFarBillboards(
  rings: FarRingInput[],
  classes: FarFieldClass[],
  seed: number,
  densityScale = 1,
  maxInstances = FAR_MAX_INSTANCES,
): FarSample {
  const billboardClasses = classes.filter((c) => c.billboard);

  const sampleAt = (scale: number): FarInstances[] => {
    const out: FarInstances[] = [];
    for (const ring of rings) {
      const b = ring.landcover.boundsLocal;
      const minX = Math.max(b.minX, -FAR_BAND_MAX_RADIUS_M);
      const maxX = Math.min(b.maxX, FAR_BAND_MAX_RADIUS_M);
      const minZ = Math.max(b.minZ, -FAR_BAND_MAX_RADIUS_M);
      const maxZ = Math.min(b.maxZ, FAR_BAND_MAX_RADIUS_M);
      if (minX >= maxX || minZ >= maxZ) continue;

      for (const cls of billboardClasses) {
        const billboard = cls.billboard!;
        const density = billboard.densityPerHa * scale;
        if (!(density > 0)) continue;
        const spacing = Math.sqrt(M2_PER_HA / density);
        const cols = Math.max(1, Math.ceil((maxX - minX) / spacing));
        const rows = Math.max(1, Math.ceil((maxZ - minZ) / spacing));

        const random = mulberry32(
          streamSeed(seed, FAR_STREAM_BASE + ring.ringIndex * 8 + cls.index),
        );
        const xs: number[] = [];
        const zs: number[] = [];
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const x = minX + (col + random()) * spacing;
            const z = minZ + (row + random()) * spacing;
            if (x > maxX || z > maxZ) continue;
            // The annulus: this ring populates only ground the next-finer grid
            // does not cover (for rings[0], the context — where the real 3D
            // instances stand).
            if (Math.abs(x) <= ring.innerHalfM && Math.abs(z) <= ring.innerHalfM) continue;
            if (classAtLocal(ring.landcover, x, z) !== cls.index) continue;
            xs.push(x);
            zs.push(z);
          }
        }
        if (xs.length === 0) continue;

        const existing = out.find(
          (t) => t.type === billboard.type && t.ringIndex[0] === ring.ringIndex,
        );
        const classIndex = new Uint8Array(xs.length).fill(cls.index);
        const ringIndex = new Uint8Array(xs.length).fill(ring.ringIndex);
        if (existing) {
          out[out.indexOf(existing)] = {
            type: existing.type,
            x: concatF32(existing.x, Float32Array.from(xs)),
            z: concatF32(existing.z, Float32Array.from(zs)),
            classIndex: concatU8(existing.classIndex, classIndex),
            ringIndex: concatU8(existing.ringIndex, ringIndex),
          };
        } else {
          out.push({
            type: billboard.type,
            x: Float32Array.from(xs),
            z: Float32Array.from(zs),
            classIndex,
            ringIndex,
          });
        }
      }
    }
    return out;
  };

  const requested = Math.max(0, densityScale);
  let instances = sampleAt(requested);
  let total = instances.reduce((n, t) => n + t.x.length, 0);
  let appliedScale = requested;
  let capped = false;

  if (total > maxInstances && total > 0) {
    // Proportional and re-sampled, never truncated — the near-field cap's rule.
    appliedScale = (requested * maxInstances) / total;
    capped = true;
    instances = sampleAt(appliedScale);
    total = instances.reduce((n, t) => n + t.x.length, 0);
  }

  return { instances, total, appliedScale, capped };
}

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** The near field darkens plant colours against the ground wash; same recipe. */
function billboardColor(hex: string): THREE.Color {
  const color = new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return color.setHSL(hsl.h, hsl.s * 0.85, hsl.l * 0.82);
}

/**
 * The §13 billboard material: flat-colour Lambert with two vertex-shader
 * injections — the cylindrical camera-facing rotation and the context-edge
 * fade — chained with the same idiom as every overlay in this app, so logdepth
 * and fog come from the built-in chunks for free.
 */
export function createBillboardMaterial(fadeStartM: number): THREE.Material {
  const material = new THREE.MeshLambertMaterial({
    // A billboard is pure silhouette + colour; DoubleSide guards the edge case
    // where the per-frame rotation trails the camera by one frame.
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    alphaTest: 0.01,
  });
  material.name = 'far-billboards';

  const uniforms = {
    uFarFadeStart: { value: fadeStartM },
    uFarFadeWidth: { value: FAR_FADE_METERS },
  };

  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|farbillboard`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform float uFarFadeStart;',
          'uniform float uFarFadeWidth;',
          'varying float vFarFade;',
        ].join('\n'),
      )
      .replace(
        '#include <begin_vertex>',
        [
          // Cylindrical billboarding (§13): rotate the quad about its own
          // vertical axis to face the camera azimuth. Applied to the *local*
          // position before instanceMatrix — instances carry no yaw and a
          // symmetric XZ scale, so the composition is exact.
          'vec4 fbInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
          'vec3 fbWorld = (modelMatrix * fbInst).xyz;',
          'vec2 fbToCam = cameraPosition.xz - fbWorld.xz;',
          'float fbAng = atan(fbToCam.x, fbToCam.y);',
          'float fbS = sin(fbAng); float fbC = cos(fbAng);',
          'vec3 transformed = vec3(',
          '  fbC * position.x + fbS * position.z,',
          '  position.y,',
          '  -fbS * position.x + fbC * position.z);',
          // Fade-in outside the near field: a blend at the §13 seam, not a line.
          'float fbDist = max(abs(fbWorld.x), abs(fbWorld.z));',
          'vFarFade = clamp((fbDist - uFarFadeStart) / uFarFadeWidth, 0.0, 1.0);',
        ].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFarFade;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vFarFade;');
  };
  return material;
}

/** One unit quad, base-anchored, normals up so lighting reads like the ground
 * whatever the facing (a rotating diffuse pop at 5 px would just be noise). */
function billboardGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0, 0.5, 0);
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
  normals.needsUpdate = true;
  return geometry;
}

export interface FarVegetationOptions {
  classes: FarFieldClass[];
  seed: number;
  /** The near field's half-extent — the fade band starts here. */
  contextHalfM: number;
  getExaggeration: () => number;
  /** §11 ring connect sampler, or null: no far water, no suppression (§2b.5).
   * The ring connect streams in after construction — see `setConnect`. */
  connectAt?: ((x: number, z: number) => number) | null;
}

interface FarBatch {
  instances: FarInstances;
  ground: Float32Array;
  connect: Float32Array;
  height: Float32Array;
  width: Float32Array;
  mesh: THREE.InstancedMesh;
}

export class FarVegetationLayer {
  /** Parent this at the scene root, NOT the terrain group — same reason as the
   * near field: instances keep metric size under exaggeration (contract §0). */
  readonly group = new THREE.Group();

  private readonly options: FarVegetationOptions & {
    connectAt: ((x: number, z: number) => number) | null;
    seed: number;
  };
  private readonly rings: FarRingInput[] = [];
  private readonly geometry = billboardGeometry();
  private readonly material: THREE.Material;
  private batches: FarBatch[] = [];
  private built = false;
  private enabled = false;
  private levelM: number | null = null;
  private lastSample: FarSample | null = null;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();

  constructor(options: FarVegetationOptions) {
    this.options = { ...options, connectAt: options.connectAt ?? null };
    this.group.name = 'far-vegetation';
    this.group.visible = false;
    this.material = createBillboardMaterial(options.contextHalfM);
  }

  /** Instances currently sampled (0 until first enable — the lazy contract). */
  get total(): number {
    return this.lastSample?.total ?? 0;
  }

  /**
   * Register one ring's rasters as they stream in (§11 lazy order). Rebuilds
   * only if the layer has already been built — otherwise the ring waits for
   * the first enable, and a visitor who never toggles the layer pays nothing.
   */
  addRing(ring: FarRingInput): void {
    this.rings.push(ring);
    if (this.built) this.rebuild();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.built) {
      this.built = true;
      this.rebuild();
    }
    this.group.visible = on && this.batches.length > 0;
  }

  /** §7 semantics on the §11 ring connect grid: nothing stands in far water. */
  setWaterLevel(levelM: number | null): void {
    this.levelM = levelM;
    if (this.built) this.refreshMatrices();
  }

  /**
   * The §11 ring connect grid arrives after construction (it streams in with
   * its ring). Cached per-instance connect values go stale, so an already-built
   * population resamples; an unbuilt one just remembers the sampler.
   */
  setConnect(connectAt: ((x: number, z: number) => number) | null): void {
    this.options.connectAt = connectAt;
    if (this.built) this.rebuild();
  }

  /** Same seed contract as the near field: same seed, same far forest. */
  setSeed(seed: number): void {
    if (seed === this.options.seed) return;
    this.options.seed = seed;
    if (this.built) this.rebuild();
  }

  /** Re-seat instances after an exaggeration change (position only — §0). */
  refreshHeights(): void {
    if (this.built) this.refreshMatrices();
  }

  private rebuild(): void {
    for (const batch of this.batches) {
      this.group.remove(batch.mesh);
      batch.mesh.dispose();
    }
    this.batches = [];

    const sample = sampleFarBillboards(this.rings, this.options.classes, this.options.seed);
    this.lastSample = sample;
    if (sample.capped) {
      console.info(
        `[fornborg] far-field billboards capped at ${FAR_MAX_INSTANCES.toLocaleString('en-US')} instances — ` +
          `density scaled globally to ×${sample.appliedScale.toFixed(3)} of the legend's ` +
          'far densityPerHa (contract §13: proportional, never per class).',
      );
    }

    const colors = new Map<number, THREE.Color>();
    for (const cls of this.options.classes) colors.set(cls.index, billboardColor(cls.color));

    for (const instances of sample.instances) {
      const n = instances.x.length;
      if (n === 0) continue;
      const form = VEGETATION_FORMS[instances.type];
      const ring = this.rings.find((r) => r.ringIndex === instances.ringIndex[0]);
      if (!ring) continue;

      const random = mulberry32(
        streamSeed(this.options.seed, FAR_STREAM_BASE + 100 + instances.ringIndex[0]),
      );
      const ground = new Float32Array(n);
      const connect = new Float32Array(n);
      const height = new Float32Array(n);
      const width = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = instances.x[i];
        const z = instances.z[i];
        // Seated on the curvature-dropped render surface (module comment).
        ground[i] =
          heightAtLocal(ring.heights.heights, x, z, ring.heights) - refractedDropM(x * x + z * z);
        connect[i] = this.options.connectAt
          ? this.options.connectAt(x, z)
          : Number.POSITIVE_INFINITY;
        const h = form.heightM * (1 + (random() * 2 - 1) * form.heightJitter);
        height[i] = h;
        width[i] = h * form.widthRatio * (1 + (random() * 2 - 1) * form.widthJitter);
      }

      const mesh = new THREE.InstancedMesh(this.geometry, this.material, n);
      mesh.name = `far-vegetation-ring${instances.ringIndex[0]}-${instances.type}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      for (let i = 0; i < n; i++) {
        mesh.setColorAt(i, colors.get(instances.classIndex[i]) ?? new THREE.Color(0x5a7a4a));
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      this.batches.push({ instances, ground, connect, height, width, mesh });
      this.group.add(mesh);
    }

    this.refreshMatrices();
    this.group.visible = this.enabled && this.batches.length > 0;
  }

  private refreshMatrices(): void {
    const exaggeration = this.options.getExaggeration();
    const level = this.levelM;
    this.quaternion.identity();
    for (const batch of this.batches) {
      const n = batch.instances.x.length;
      for (let i = 0; i < n; i++) {
        const wet = level !== null && batch.connect[i] <= level;
        this.position.set(batch.instances.x[i], batch.ground[i] * exaggeration, batch.instances.z[i]);
        if (wet) this.scale.set(0, 0, 0);
        // Symmetric XZ scale — required for the shader's Ry to commute exactly.
        else this.scale.set(batch.width[i], batch.height[i], batch.width[i]);
        batch.mesh.setMatrixAt(i, this.matrix.compose(this.position, this.quaternion, this.scale));
      }
      batch.mesh.instanceMatrix.needsUpdate = true;
      batch.mesh.computeBoundingSphere();
    }
  }

  dispose(): void {
    for (const batch of this.batches) {
      this.group.remove(batch.mesh);
      batch.mesh.dispose();
    }
    this.batches = [];
    this.geometry.dispose();
    this.material.dispose();
  }
}
