/**
 * Procedural vegetation for the modeled landscape (Phase 7, PLAN §4.7/§6.1;
 * contract §9 "Rendering contract").
 *
 * The §9 raster says *what kind* of ground each 2 m cell is; the §10 legend says how
 * densely that kind was vegetated. This module turns the two into instanced geometry.
 *
 * ## v1.4 — naturalistic rendering (PLAN §6.1 amendment, 2026-08-22)
 *
 * The original rule made the *rendering style itself* part of the Model badge: flat
 * colours, deliberately schematic forms, so nobody could mistake the layer for a
 * reconstruction. **That rule is retired.** It failed exactly where the model has to
 * persuade — up close and at the treeline — and it conflated provenance with rendering
 * quality. Honesty now lives where it belongs: in the "model" badge, the first-toggle
 * caveat, the verbatim rule disclosure in the methods panel, the legend's calibration
 * text, and species composition tied to the zone evidence (docs/vegetation-zones.md
 * §2/§4). Not in how rough the trees look.
 *
 * So the population is built as a *statistical* model of a stand rather than a field of
 * identical props (`landcover/species.ts` owns all of it):
 *
 *   • **Species mixes.** A legend class still says "conifer forest at 120 stems/ha" —
 *     that is the data contract — but the renderer resolves that form into the species
 *     mix §4 supports (conifer = spruce/pine, broadleaf = oak/birch).
 *   • **Clumped stands, not salt-and-pepper.** Species and stand age both come from
 *     smooth noise fields (`lib/noise`), so neighbours mostly share a species and share
 *     a height, the way regeneration actually works — with the realised species
 *     fractions still landing on the model's weights (see `species.ts` on why that
 *     needs an explicit distribution correction).
 *   • **Per-instance colour variation.** A few percent of hue/saturation/lightness
 *     wobble per stem, so a thousand crowns read as a thousand trees instead of one
 *     repeated cutout.
 *
 *   • **Species archetype meshes** (`treeGeometry.ts`). Tree instances draw as
 *     generated per-species meshes — spruce spire, bare-trunked pine, white-trunked
 *     birch, broad oak — in seeded variants, batched one `InstancedMesh` per
 *     (species, variant). Reeds keep their cross-quads. Every mesh keeps the old
 *     cone's instancing contract (unit height, base at y = 0), so scale-as-size,
 *     suppression and exaggeration semantics are untouched.
 *
 * Four invariants, all easy to break later:
 *
 *   • **Deterministic for a seed.** Placement, per-instance jitter, species and colour
 *     all come from `lib/random`'s mulberry32 (and from noise fields seeded through it),
 *     walked in a fixed order, so the same seed is the same forest on every machine and
 *     in every screenshot (the palisade rule). Each concern owns a **stream id**, and
 *     each stream is walked a fixed number of draws per instance whether or not the
 *     draw is used — see `rebuild()`, where the counts are pinned.
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
 *
 * ## v1.3 — the shore reed belt follows the slider (contract §9/§10 amendment)
 *
 * A legend may mark one class `dynamic: {kind:'shore-band', bandM}`. That class holds
 * no raster cells: its instances stand where `level < connect ≤ level + bandM` at the
 * **current** level, so the reed belt tracks the water's edge century by century
 * instead of staying stranded at the reference shoreline.
 *
 * Doing that naively is unaffordable (measured on Broborg: the full superset is
 * ~297k always-resident instances; re-sampling per slider tick is ~800k lattice cells
 * per tick). Instead `sampleShoreBand()` precomputes the candidate superset **once**
 * per (seed, density), sorted by connect, and every level change binary-searches the
 * `(level, level+bandM]` window into one fixed-capacity `InstancedMesh` — O(log n + k)
 * per tick, no mesh churn.
 *
 * Two consequences worth stating:
 *   • The split suppression threshold — tree forms are hidden at
 *     `connect ≤ level + bandM`, reed forms at `connect ≤ level` — so no conifer ever
 *     stands inside the reed belt (§9 v1.3).
 *   • The band's budget contribution is its **capacity**, not its current window, so
 *     the global density cap never fluctuates as the slider moves.
 */

import * as THREE from 'three';
import { mulberry32, streamSeed } from '../lib/random';
import { classAtLocal, type LandcoverGrid } from './landcoverGrid';
import {
  ARCHETYPE_VARIANTS,
  archetypeGeometry,
  createArchetypeMaterial,
  type ArchetypeSpecies,
} from './treeGeometry';
import {
  archetypeIndex,
  createImpostorMaterial,
  impostorGeometry,
  type ImpostorAtlas,
} from './impostors';
import {
  SPECIES_FORMS,
  TREE_SPECIES,
  jitterPlantColor,
  speciesColor,
  speciesFieldFor,
  standHeightFieldFor,
  type TreeSpecies,
} from './species';
import {
  dynamicClass,
  staticVegetationClasses,
  type LandcoverClass,
  type LandcoverLegend,
  type VegetationSpec,
  type VegetationType,
} from './legend';

/** Square meters per hectare — the unit `densityPerHa` is quoted in (§10). */
const M2_PER_HA = 10_000;

/**
 * Hard ceiling on instances across all types. Above this the *whole* model is scaled
 * down proportionally (never one class at a time) and the fact is logged, because a
 * silently thinned forest would misreport the model's density.
 *
 * Sized for Phase 7's ~99k static instances and raised for the v1.3 dynamic shore
 * band, whose fixed capacity (~37k at Broborg) counts against the same budget. The
 * proportional cap stays exactly as it was — it is the safety net, not the plan.
 */
export const MAX_INSTANCES = 150_000;

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

/**
 * The per-**form** envelope: one size for each of the legend's three vegetation types.
 *
 * Since the §6.1 amendment the near-field trees size themselves from `SPECIES_FORMS`
 * instead (a spruce and a pine are not one "conifer"), but this table is still the live
 * envelope for the two populations that must not move:
 *   • the **shore band**, whose whole honesty argument is that a candidate's appearance
 *     is a pure function of (seed, lattice cell) — see `sampleShoreBand`;
 *   • the **far field** (`farVegetation.ts`), where a stem is a few pixels of silhouette
 *     and a species split would cost draws to buy nothing.
 * It is also the fallback envelope for any legend type without a species mix.
 */
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
 * v1.3: only the **static** vegetated classes are sampled here. A `dynamic` class
 * (the shore band) has no raster cells to sample from — `sampleShoreBand()` derives
 * it from the connect grid instead.
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

    for (const cls of staticVegetationClasses(legend)) {
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
      byType = trimTypes(byType, maxInstances);
      total = byType.reduce((n, t) => n + t.x.length, 0);
    }
  }

  return { byType, total, appliedScale, capped };
}

/** Rounding can leave a handful over the budget; trim deterministically. */
function trimTypes(byType: TypeSample[], budget: number): TypeSample[] {
  let left = budget;
  return byType.map((t) => {
    const keep = Math.max(0, Math.min(t.x.length, left));
    left -= keep;
    return keep === t.x.length
      ? t
      : { type: t.type, x: t.x.slice(0, keep), z: t.z.slice(0, keep), classIndex: t.classIndex.slice(0, keep) };
  });
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

// ------------------------------------------------------ dynamic shore band --

/**
 * The precomputed candidate superset of the v1.3 shore reed belt, sorted by connect.
 *
 * Every array is parallel and in **ascending connect order**, which is what lets a
 * level change pick its instances with two binary searches instead of a scan.
 */
export interface ShoreBandCandidates {
  /** Legend index of the `shore-band` class — carries the colour. */
  classIndex: number;
  /** Band width above the water line, m (§10 `dynamic.bandM`). */
  bandM: number;
  /** Candidate count. */
  count: number;
  /**
   * Largest number of candidates any window `(level, level+bandM]` can hold — the
   * `InstancedMesh` capacity, and the band's (level-independent) budget share.
   */
  capacity: number;
  x: Float32Array;
  z: Float32Array;
  /** Ascending. The window bounds are found in here. */
  connect: Float32Array;
  height: Float32Array;
  width: Float32Array;
  yaw: Float32Array;
  leanX: Float32Array;
  leanZ: Float32Array;
}

/** Stream id for the band's single RNG stream (see the loud comment in the body). */
const BAND_STREAM_BASE = 200;

/**
 * Derive the shore reed belt's candidate set from the §7 connect grid (contract §9
 * v1.3). Returns `null` when the legend declares no `shore-band` class — the
 * pre-v1.3 path, where nothing about this function runs.
 *
 * `levelRange` is `[min, max]` over the levels the slider can reach; the candidate
 * domain is `connect ∈ (min, max + bandM]`, i.e. exactly the union of every window
 * the slider can ask for.
 *
 * Pure: no three.js, no DOM.
 */
export function sampleShoreBand(
  grid: LandcoverGrid,
  legend: LandcoverLegend,
  params: VegetationParams,
  connectAt: (x: number, z: number) => number,
  levelRange: [number, number],
): ShoreBandCandidates | null {
  const bandCls: LandcoverClass | null = dynamicClass(legend, 'shore-band');
  const veg: VegetationSpec | null = bandCls?.vegetation ?? null;
  const bandM = bandCls?.dynamic?.bandM ?? 0;
  if (!bandCls || !veg || !(bandM > 0)) return null;

  const density = veg.densityPerHa * Math.max(0, params.densityScale);
  const form = VEGETATION_FORMS[veg.type];
  const empty = (): ShoreBandCandidates => ({
    classIndex: bandCls.index,
    bandM,
    count: 0,
    capacity: 0,
    x: new Float32Array(0),
    z: new Float32Array(0),
    connect: new Float32Array(0),
    height: new Float32Array(0),
    width: new Float32Array(0),
    yaw: new Float32Array(0),
    leanX: new Float32Array(0),
    leanZ: new Float32Array(0),
  });
  if (!(density > 0)) return empty();

  // Cells the band must never plant on: open water (a reed does not stand in the
  // sea) and any class that already carries reeds of its own — a stranded fen keeps
  // its own reeds, and double-planting would read as twice the modelled density.
  const excluded = new Set<number>();
  const waterCls = dynamicClass(legend, 'water');
  if (waterCls) excluded.add(waterCls.index);
  for (const cls of legend.classes) {
    if (cls.vegetation?.type === 'reeds') excluded.add(cls.index);
  }

  const [minLevel, maxLevel] = levelRange;
  const lowerBound = Math.min(minLevel, maxLevel);
  const upperBound = Math.max(minLevel, maxLevel) + bandM;

  const b = grid.boundsLocal;
  const spacing = Math.sqrt(M2_PER_HA / density);
  const cols = Math.max(1, Math.ceil((b.maxX - b.minX) / spacing));
  const rows = Math.max(1, Math.ceil((b.maxZ - b.minZ) / spacing));

  // ---------------------------------------------------------------------------
  // SEVEN unconditional draws per lattice cell — position jitter *and* every
  // appearance parameter — from ONE stream. This is a DELIBERATE deviation from the
  // per-form jitter streams the static batches use (`VegetationLayer.rebuild`),
  // and it is the whole reason the band can be honest across the slider:
  //
  //   a candidate's full appearance is a pure function of (seed, lattice cell), so
  //   the LEVEL ONLY SELECTS MEMBERSHIP. A reed that survives a slider move keeps a
  //   bit-identical transform.
  //
  // With per-form streams the draws would be consumed in *membership* order, so
  // every candidate entering or leaving the window would re-roll the appearance of
  // everything after it — the belt would shimmer as you scrub. Do not "tidy" this
  // into the shared stream layout.
  // ---------------------------------------------------------------------------
  const random = mulberry32(streamSeed(params.seed, BAND_STREAM_BASE + bandCls.index));

  const xs: number[] = [];
  const zs: number[] = [];
  const cs: number[] = [];
  const hs: number[] = [];
  const ws: number[] = [];
  const yaws: number[] = [];
  const lxs: number[] = [];
  const lzs: number[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const jx = random();
      const jz = random();
      const jh = random();
      const jw = random();
      const jyaw = random();
      const jlx = random();
      const jlz = random();

      const x = b.minX + (col + jx) * spacing;
      const z = b.minZ + (row + jz) * spacing;
      if (x > b.maxX || z > b.maxZ) continue;

      const connect = connectAt(x, z);
      if (!(connect > lowerBound) || !(connect <= upperBound)) continue;
      if (excluded.has(classAtLocal(grid, x, z))) continue;

      const h = form.heightM * (1 + (jh * 2 - 1) * form.heightJitter);
      xs.push(x);
      zs.push(z);
      cs.push(connect);
      hs.push(h);
      ws.push(h * form.widthRatio * (1 + (jw * 2 - 1) * form.widthJitter));
      yaws.push(jyaw * Math.PI * 2);
      lxs.push((jlx * 2 - 1) * form.leanRad);
      lzs.push((jlz * 2 - 1) * form.leanRad);
    }
  }

  const n = xs.length;
  if (n === 0) return empty();

  // Sorted by connect ascending; ties keep lattice order, so the layout is a pure
  // function of (seed, density) whatever the connect field looks like.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, c) => cs[a] - cs[c] || a - c);

  const out: ShoreBandCandidates = {
    classIndex: bandCls.index,
    bandM,
    count: n,
    capacity: 0,
    x: new Float32Array(n),
    z: new Float32Array(n),
    connect: new Float32Array(n),
    height: new Float32Array(n),
    width: new Float32Array(n),
    yaw: new Float32Array(n),
    leanX: new Float32Array(n),
    leanZ: new Float32Array(n),
  };
  for (let k = 0; k < n; k++) {
    const i = order[k];
    out.x[k] = xs[i];
    out.z[k] = zs[i];
    out.connect[k] = cs[i];
    out.height[k] = hs[i];
    out.width[k] = ws[i];
    out.yaw[k] = yaws[i];
    out.leanX[k] = lxs[i];
    out.leanZ[k] = lzs[i];
  }

  // Capacity: the widest window `(level, level+bandM]` over the sorted values. Two
  // pointers, O(n) — the extremal window always starts at a candidate, so testing
  // one window per candidate is exhaustive.
  let capacity = 0;
  let end = 0;
  for (let start = 0; start < n; start++) {
    if (end < start) end = start;
    while (end < n && out.connect[end] <= out.connect[start] + bandM) end++;
    if (end - start > capacity) capacity = end - start;
  }
  out.capacity = capacity;
  return out;
}

/**
 * The whole modelled vegetation load — static classes plus the v1.3 shore band —
 * under **one** global budget.
 *
 * The band contributes its level-independent capacity, so the applied density scale
 * can never fluctuate as the slider moves, and the proportional cap (§10: global,
 * never per class) thins the static classes and the band by the same factor.
 */
export interface LandcoverVegetationSample {
  vegetation: VegetationSample;
  band: ShoreBandCandidates | null;
}

export function sampleLandcoverVegetation(
  grid: LandcoverGrid,
  legend: LandcoverLegend,
  params: VegetationParams,
  connectAt: ((x: number, z: number) => number) | null,
  levelRange: [number, number] | null,
  maxInstances = MAX_INSTANCES,
): LandcoverVegetationSample {
  const requested = Math.max(0, params.densityScale);
  const bandAt = (scale: number): ShoreBandCandidates | null =>
    connectAt && levelRange
      ? sampleShoreBand(grid, legend, { seed: params.seed, densityScale: scale }, connectAt, levelRange)
      : null;

  // No band: the pre-v1.3 path, byte for byte — `sampleVegetation` owns the cap.
  const hasBand = connectAt !== null && levelRange !== null && dynamicClass(legend, 'shore-band') !== null;
  if (!hasBand) {
    return { vegetation: sampleVegetation(grid, legend, params, maxInstances), band: null };
  }

  const at = (scale: number): LandcoverVegetationSample => ({
    // Uncapped: the joint budget below is the cap now.
    vegetation: sampleVegetation(grid, legend, { seed: params.seed, densityScale: scale }, Number.POSITIVE_INFINITY),
    band: bandAt(scale),
  });
  const totalOf = (s: LandcoverVegetationSample): number => s.vegetation.total + (s.band?.capacity ?? 0);

  let result = at(requested);
  let total = totalOf(result);
  let appliedScale = requested;
  let capped = false;

  if (total > maxInstances && total > 0) {
    appliedScale = (requested * maxInstances) / total;
    capped = true;
    result = at(appliedScale);
    total = totalOf(result);
    if (total > maxInstances) {
      // Rounding can leave a handful over: give the band its (already re-sampled)
      // capacity and trim the static forms into what is left, exactly as the
      // single-sampler path does.
      const staticBudget = Math.max(0, maxInstances - (result.band?.capacity ?? 0));
      const byType = trimTypes(result.vegetation.byType, staticBudget);
      result = {
        ...result,
        vegetation: {
          ...result.vegetation,
          byType,
          total: byType.reduce((n, t) => n + t.x.length, 0),
        },
      };
    }
  }

  result.vegetation = { ...result.vegetation, appliedScale, capped };
  return result;
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
 * The **base** colour of one legend class's plants: the class colour a shade darker and
 * duller, because the ground wash already carries the class colour at full strength and
 * the plants should sit against it rather than shout over it.
 *
 * This is where a plant's colour starts, not where it ends — `rebuild()` shades it per
 * species and wobbles it per stem (§6.1 amendment, `species.ts`).
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

/**
 * Stream-id bases for the near field's per-instance draws.
 *
 * The whole map, so a future stream lands somewhere free: class placement 0–31
 * (`cls.index`), near-field appearance 100+, shore band 200+, far field 300+ and 400+
 * (its colour jitter at 420+), this module's two additions below, and
 * `landcover/species.ts`'s noise fields at 430+ / 440+.
 *
 * Each base is offset by the form's index in `VEGETATION_TYPE_ORDER`, so adding a form
 * — or changing what a stream is used for — cannot reshuffle another form's stems.
 */
const SPECIES_TIEBREAK_STREAM_BASE = 400;
const NEAR_COLOR_STREAM_BASE = 410;
/** Which of a species' archetype variants an instance draws with (§6.1). */
const VARIANT_STREAM_BASE = 450;

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
  /**
   * v1.3: `[min, max]` over the water levels the shoreline slider can reach — the
   * domain the dynamic shore band's candidates are precomputed over. `null`/omitted
   * (or a legend with no `shore-band` class) = no dynamic band at all.
   */
  levelRange?: [number, number] | null;
  /**
   * §6.1 LOD: the baked impostor atlas for a seed (`impostors.ts`), or `null` when
   * baking is unavailable. A callback rather than a value because archetypes are
   * seed-derived — a seed change needs a fresh bake, and only the caller holds the
   * renderer. `null`/omitted = every tree draws as a full mesh at any distance
   * (correct, and what the headless tests exercise; only viable at small counts).
   */
  impostorAtlas?: ((seed: number) => ImpostorAtlas | null) | null;
}

/** Trees nearer the camera than this draw as full archetype meshes (§6.1 LOD). */
export const MESH_TIER_RADIUS_M = 320;

/** Camera movement that triggers a tier rebin — hysteresis against thrash. */
export const REBIN_MOVE_M = 40;

interface Batch {
  type: VegetationType;
  sample: TypeSample;
  /**
   * Which species each instance is, as an index into `TREE_SPECIES` (§6.1 amendment).
   * Sized and ordered like `sample.x`.
   */
  species: Uint8Array;
  /** Cached per instance so an exaggeration or level change never resamples. */
  ground: Float32Array;
  connect: Float32Array;
  height: Float32Array;
  width: Float32Array;
  yaw: Float32Array;
  leanX: Float32Array;
  leanZ: Float32Array;
  /**
   * §6.1 amendment: a tree-form batch draws as several `InstancedMesh`es — one per
   * (species, variant) archetype present — while reeds keep their single cross-quad
   * mesh. The batch's per-instance arrays stay in **sample order** (that is what the
   * RNG stream walk and every A-vs-B test key on); `subOf`/`slotOf` map instance `i`
   * to its mesh and slot, so suppression/exaggeration refreshes stay one O(n) pass.
   */
  meshes: THREE.InstancedMesh[];
  /**
   * §6.1 LOD: the impostor twin of each tree sub-mesh (same capacity, same slots),
   * or `null` where there is none (reeds, or no atlas available). An instance is
   * drawn in exactly one tier at a time — the other tier holds a zero-scale matrix,
   * the same trick suppression uses.
   */
  impostors: (THREE.InstancedMesh | null)[];
  subOf: Uint8Array;
  slotOf: Uint32Array;
}

/**
 * One `InstancedMesh` per (species, variant) archetype — plus one for reeds — all
 * under one group.
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
  /** Archetype meshes for the current seed, keyed `species-variant` (§6.1). */
  private readonly archetypeGeometries = new Map<string, THREE.BufferGeometry>();
  /** The seed the cached archetypes were generated for (they are seed-derived). */
  private archetypeGeometrySeed: number | null = null;
  /** One material shared by every archetype mesh (bark/foliage split shader). */
  private archetypeMaterial: THREE.Material | null = null;
  /** §6.1 LOD: the current seed's atlas (owned by the caller) and one impostor
   * material per archetype row — same lifetime as the archetype geometries. */
  private impostorAtlasFor: ImpostorAtlas | null = null;
  private readonly impostorMaterials = new Map<number, THREE.Material>();
  /** Camera position of the last tier rebin; `null` = everything mesh tier. */
  private cameraX: number | null = null;
  private cameraZ = 0;
  private batches: Batch[] = [];
  private params: VegetationParams;
  private enabled = false;
  /** Current water level for the suppression test; -∞ means "no water anywhere". */
  private waterLevelM = Number.NEGATIVE_INFINITY;
  private lastSample: VegetationSample = { byType: [], total: 0, appliedScale: 1, capped: false };

  // --- v1.3 dynamic shore band (contract §9/§10) ------------------------------
  /** Candidate superset, sorted by connect; `null` when the legend has no band. */
  private bandSample: ShoreBandCandidates | null = null;
  /** Ground height per candidate, sampled once at build (index-parallel). */
  private bandGround: Float32Array = new Float32Array(0);
  private bandMesh: THREE.InstancedMesh | null = null;
  /** First candidate index of the current `(level, level+bandM]` window. */
  private bandStart = 0;
  /** How many candidates that window holds — the mesh's live `count`. */
  private bandWindow = 0;
  /** `dynamic.bandM` from the legend — 0 when there is no shore-band class. */
  private readonly legendBandM: number;

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
    this.legendBandM = dynamicClass(legend, 'shore-band')?.dynamic?.bandM ?? 0;
    this.group.name = 'landcover-vegetation';
    this.group.visible = false;
    this.rebuild();
  }

  /**
   * Total instances **placed**: the static instances plus the dynamic band's fixed
   * capacity (not its current window — the capacity is what the budget reserved and
   * what the GPU buffer holds). For "how many are standing at this century", read
   * `visibleCount`.
   */
  get count(): number {
    return this.lastSample.total + this.bandCapacity;
  }

  /**
   * Instances actually standing at the current level: static instances not suppressed
   * by the split threshold, plus the band's current window.
   */
  get visibleCount(): number {
    let n = 0;
    for (const batch of this.batches) {
      const threshold = this.suppressionThreshold(batch.type);
      for (let i = 0; i < batch.connect.length; i++) {
        if (!(batch.connect[i] <= threshold)) n++;
      }
    }
    return n + this.bandWindow;
  }

  /** Band instances in the current `(level, level+bandM]` window. */
  get bandCount(): number {
    return this.bandWindow;
  }

  /** The band mesh's fixed instance capacity (0 when the legend has no band). */
  get bandCapacity(): number {
    return this.bandSample?.capacity ?? 0;
  }

  /** Shore-band width in meters, 0 when the legend declares no shore-band class. */
  get bandM(): number {
    return this.legendBandM;
  }

  /**
   * The connect level at or below which an instance of `type` is suppressed.
   *
   * **Split by form** (contract §9 v1.3): reeds are hidden only where the ground is
   * actually wet, but tree forms are hidden through the whole reed belt as well —
   * nothing woody stands inside the reed belt at any century. With no shore-band
   * class in the legend `bandM` is 0 and both thresholds collapse to the pre-v1.3
   * `connect ≤ level`.
   */
  private suppressionThreshold(type: VegetationType): number {
    return type === 'reeds' ? this.waterLevelM : this.waterLevelM + this.legendBandM;
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

  /**
   * Instance counts per **species**, for the readout and the tests (§6.1 amendment).
   *
   * Only species that were actually placed appear, so the readout never claims a stand
   * of nothing. Sums to `countsByType()`'s total — the shore band is not included here,
   * it is reeds-only by construction (see `sampleShoreBand`).
   */
  countsBySpecies(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const batch of this.batches) {
      for (let i = 0; i < batch.species.length; i++) {
        const name = TREE_SPECIES[batch.species[i]] ?? 'unknown';
        counts[name] = (counts[name] ?? 0) + 1;
      }
    }
    return counts;
  }

  /** The species assigned to `type` instance `index`, for tests and dev hooks. */
  speciesOf(type: VegetationType, index: number): TreeSpecies {
    const batch = this.batchOf(type);
    if (index < 0 || index >= batch.species.length) {
      throw new RangeError(`vegetation: no ${type} instance at index ${index} (count ${batch.species.length})`);
    }
    return TREE_SPECIES[batch.species[index]];
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
    this.refreshBand();
  }

  get waterLevel(): number | null {
    return this.waterLevelM === Number.NEGATIVE_INFINITY ? null : this.waterLevelM;
  }

  /** Re-seat every instance on the (possibly re-exaggerated) surface. */
  refreshHeights(): void {
    this.refreshMatrices();
    this.refreshBand();
  }

  /**
   * §6.1 LOD: tell the layer where the camera is, so instances can move between
   * the mesh and impostor tiers. Call as often as you like (every frame is fine):
   * the rebin — an O(n) matrix rewrite, the same cost class as a slider move —
   * only runs once the camera has moved `REBIN_MOVE_M` from the last one. With no
   * atlas (options.impostorAtlas absent) this is a no-op and every tree stays a
   * full mesh.
   */
  updateCamera(x: number, z: number): void {
    if (!this.impostorAtlasFor) return;
    if (this.cameraX !== null) {
      const dx = x - this.cameraX;
      const dz = z - this.cameraZ;
      if (dx * dx + dz * dz < REBIN_MOVE_M * REBIN_MOVE_M) return;
    }
    this.cameraX = x;
    this.cameraZ = z;
    this.refreshMatrices();
  }

  /** Is instance `index` of `type` suppressed at the current level (split threshold)? */
  isSuppressed(type: VegetationType, index: number): boolean {
    const batch = this.batchOf(type);
    return batch.connect[index] <= this.suppressionThreshold(type);
  }

  /** The band's `InstancedMesh`, or `null` when the legend declares no band. */
  get bandInstancedMesh(): THREE.InstancedMesh | null {
    return this.bandMesh;
  }

  /** Connect value of the candidate drawn in band window slot `slot`. */
  bandConnectAt(slot: number): number {
    if (!this.bandSample || slot < 0 || slot >= this.bandWindow) {
      throw new RangeError(`vegetation: no band instance in slot ${slot} (window ${this.bandWindow})`);
    }
    return this.bandSample.connect[this.bandStart + slot];
  }

  /** The instance matrix of band window slot `slot`, for tests and dev hooks. */
  bandInstanceMatrix(slot: number, target = new THREE.Matrix4()): THREE.Matrix4 {
    if (!this.bandMesh || slot < 0 || slot >= this.bandWindow) {
      throw new RangeError(`vegetation: no band instance in slot ${slot} (window ${this.bandWindow})`);
    }
    this.bandMesh.getMatrixAt(slot, target);
    return target;
  }

  /** The instance colour of `type` instance `index`, for tests and dev hooks. */
  instanceColor(type: VegetationType, index: number, target = new THREE.Color()): THREE.Color {
    const batch = this.batchOf(type);
    if (index < 0 || index >= batch.sample.x.length) {
      throw new RangeError(`vegetation: no ${type} instance at index ${index} (count ${batch.sample.x.length})`);
    }
    batch.meshes[batch.subOf[index]].getColorAt(batch.slotOf[index], target);
    return target;
  }

  /** The instance matrix of `type` instance `index`, for tests and dev hooks. */
  instanceMatrix(type: VegetationType, index: number, target = new THREE.Matrix4()): THREE.Matrix4 {
    const batch = this.batchOf(type);
    if (index < 0 || index >= batch.sample.x.length) {
      throw new RangeError(`vegetation: no ${type} instance at index ${index} (count ${batch.sample.x.length})`);
    }
    batch.meshes[batch.subOf[index]].getMatrixAt(batch.slotOf[index], target);
    return target;
  }

  /**
   * The impostor-tier matrix of `type` instance `index` (§6.1 LOD), or `null`
   * when the instance has no impostor twin (reeds, or no atlas). Tests and dev
   * hooks; zero scale in exactly one of the two tiers is the LOD invariant.
   */
  impostorInstanceMatrix(type: VegetationType, index: number, target = new THREE.Matrix4()): THREE.Matrix4 | null {
    const batch = this.batchOf(type);
    if (index < 0 || index >= batch.sample.x.length) {
      throw new RangeError(`vegetation: no ${type} instance at index ${index} (count ${batch.sample.x.length})`);
    }
    const impostor = batch.impostors[batch.subOf[index]];
    if (!impostor) return null;
    impostor.getMatrixAt(batch.slotOf[index], target);
    return target;
  }

  dispose(): void {
    this.disposeMeshes();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    for (const geometry of this.archetypeGeometries.values()) geometry.dispose();
    this.archetypeGeometries.clear();
    this.archetypeMaterial?.dispose();
    this.archetypeMaterial = null;
    this.disposeImpostorMaterials();
    // The atlas itself is the caller's (it holds the render targets).
    this.impostorAtlasFor = null;
  }

  private batchOf(type: VegetationType): Batch {
    const batch = this.batches.find((b) => b.type === type);
    if (!batch) throw new RangeError(`vegetation: no instances of type ${type}`);
    return batch;
  }

  private disposeMeshes(): void {
    for (const batch of this.batches) {
      for (const mesh of batch.meshes) {
        this.group.remove(mesh);
        mesh.dispose();
      }
      for (const impostor of batch.impostors) {
        if (!impostor) continue;
        this.group.remove(impostor);
        // Impostor geometries are per-mesh clones (they carry the instanced yaw
        // attribute), so they are owned here, not by a shared cache.
        impostor.geometry.dispose();
        impostor.dispose();
      }
    }
    this.batches = [];
    if (this.bandMesh) {
      this.group.remove(this.bandMesh);
      this.bandMesh.dispose();
      this.bandMesh = null;
    }
    this.bandSample = null;
    this.bandGround = new Float32Array(0);
    this.bandStart = 0;
    this.bandWindow = 0;
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
        // The reeds' cross-quads (and the shore band, whatever its form) keep this
        // plain per-instance-colour Lambert; the tree forms draw with the archetype
        // material's bark/foliage split instead (§6.1 amendment).
        flatShading: type !== 'reeds',
        side: type === 'reeds' ? THREE.DoubleSide : THREE.FrontSide,
      });
      material.name = `vegetation-${type}`;
      this.materials.set(type, material);
    }
    return material;
  }

  /**
   * The (species, variant) archetype for the current seed. Archetype shapes are
   * seed-derived (streams 500+), so a seed change invalidates the whole cache —
   * regeneration is a dozen meshes of a few hundred triangles, trivial next to the
   * instance resample that same rebuild is already doing.
   */
  private archetypeOf(species: ArchetypeSpecies, variant: number): THREE.BufferGeometry {
    if (this.archetypeGeometrySeed !== this.params.seed) {
      for (const geometry of this.archetypeGeometries.values()) geometry.dispose();
      this.archetypeGeometries.clear();
      this.archetypeGeometrySeed = this.params.seed;
    }
    const key = `${species}-${variant}`;
    let geometry = this.archetypeGeometries.get(key);
    if (!geometry) {
      geometry = archetypeGeometry(species, variant, this.params.seed);
      this.archetypeGeometries.set(key, geometry);
    }
    return geometry;
  }

  private archetypeMaterialOf(): THREE.Material {
    if (!this.archetypeMaterial) this.archetypeMaterial = createArchetypeMaterial();
    return this.archetypeMaterial;
  }

  /** One impostor material per archetype row, for the current atlas (§6.1 LOD). */
  private impostorMaterialOf(row: number): THREE.Material {
    let material = this.impostorMaterials.get(row);
    if (!material) {
      material = createImpostorMaterial(this.impostorAtlasFor!, row);
      this.impostorMaterials.set(row, material);
    }
    return material;
  }

  private disposeImpostorMaterials(): void {
    for (const material of this.impostorMaterials.values()) material.dispose();
    this.impostorMaterials.clear();
  }

  private rebuild(): void {
    this.disposeMeshes();
    // The seed's impostor atlas, if the caller can bake one (§6.1 LOD). A changed
    // atlas invalidates the per-row materials, which hold its textures.
    const atlas = this.options.impostorAtlas?.(this.params.seed) ?? null;
    if (atlas !== this.impostorAtlasFor) {
      this.disposeImpostorMaterials();
      this.impostorAtlasFor = atlas;
    }
    const connectAt = this.options.connectAt ?? null;
    const { vegetation: sample, band } = sampleLandcoverVegetation(
      this.grid,
      this.legend,
      this.params,
      connectAt,
      this.options.levelRange ?? null,
    );
    this.lastSample = sample;
    this.bandSample = band;
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
      const formIndex = VEGETATION_TYPE_ORDER.indexOf(typeSample.type);

      // -----------------------------------------------------------------------
      // FOUR streams, each walked a FIXED number of draws per instance, in
      // instance order, unconditionally:
      //
      //   100 + form  — appearance:  5 draws (height, width, yaw, leanX, leanZ)
      //   400 + form  — species:     1 draw  (the mix tiebreak)
      //   410 + form  — colour:      3 draws (hue, saturation, lightness)
      //   450 + form  — variant:     1 draw  (which archetype mesh; drawn and
      //                              ignored for reeds, so the walk stays fixed)
      //
      // Splitting them this way is the point: the §6.1 species and colour work adds
      // draws WITHOUT touching the appearance stream, so an existing seed's layout —
      // which stem stands where, which way it leans — is exactly what it was. Adding a
      // draw to the 100+ stream, or making any of these three conditional, re-rolls
      // every instance after it and silently changes every saved screenshot.
      // -----------------------------------------------------------------------
      const random = mulberry32(streamSeed(this.params.seed, 100 + formIndex));
      const speciesRandom = mulberry32(streamSeed(this.params.seed, SPECIES_TIEBREAK_STREAM_BASE + formIndex));
      const colorRandom = mulberry32(streamSeed(this.params.seed, NEAR_COLOR_STREAM_BASE + formIndex));
      const variantRandom = mulberry32(streamSeed(this.params.seed, VARIANT_STREAM_BASE + formIndex));

      // The two clump fields (species.ts): smooth functions of position, so a stand
      // shares a species and an age. Both are pure — no draws, no order dependence.
      const speciesAt = speciesFieldFor(typeSample.type, this.params.seed);
      const standHeightAt = standHeightFieldFor(typeSample.type, this.params.seed);

      const species = new Uint8Array(n);
      const variant = new Uint8Array(n);
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

        // The five appearance draws, in their original order — see the note above.
        const jitterHeight = random();
        const jitterWidth = random();
        const jitterYaw = random();
        const jitterLeanX = random();
        const jitterLeanZ = random();

        const kind = speciesAt(x, z, speciesRandom());
        species[i] = TREE_SPECIES.indexOf(kind);
        variant[i] = Math.min(ARCHETYPE_VARIANTS - 1, Math.floor(variantRandom() * ARCHETYPE_VARIANTS));
        const form = SPECIES_FORMS[kind] ?? VEGETATION_FORMS[typeSample.type];

        // Height is the species' own size × the stand's age × this stem's jitter: the
        // stand term is what makes a wood read as stands rather than as noise.
        const h = form.heightM * standHeightAt(x, z) * (1 + (jitterHeight * 2 - 1) * form.heightJitter);
        height[i] = h;
        width[i] = h * form.widthRatio * (1 + (jitterWidth * 2 - 1) * form.widthJitter);
        yaw[i] = jitterYaw * Math.PI * 2;
        leanX[i] = (jitterLeanX * 2 - 1) * form.leanRad;
        leanZ[i] = (jitterLeanZ * 2 - 1) * form.leanRad;
      }

      // ------------------------------------------------------------------------
      // Partition into meshes (§6.1 amendment). Reeds: one cross-quad mesh, as
      // ever. Tree forms: one InstancedMesh per (species, variant) archetype that
      // actually occurs — at 2 species × 3 variants per form that is ≤ 6 draws
      // where there used to be 1, which is noise next to the terrain chunks.
      // Instance order inside each partition follows sample order, so the colour
      // stream below is still consumed strictly in instance order.
      // ------------------------------------------------------------------------
      const isReeds = typeSample.type === 'reeds';
      const keyOf = (i: number): string => {
        if (isReeds) return 'reeds';
        const kind = TREE_SPECIES[species[i]] as ArchetypeSpecies;
        return `${kind}-${variant[i]}`;
      };

      const meshes: THREE.InstancedMesh[] = [];
      const impostors: (THREE.InstancedMesh | null)[] = [];
      const meshIndexByKey = new Map<string, number>();
      const countByKey = new Map<string, number>();
      for (let i = 0; i < n; i++) countByKey.set(keyOf(i), (countByKey.get(keyOf(i)) ?? 0) + 1);
      for (const [key, count] of countByKey) {
        let mesh: THREE.InstancedMesh;
        let impostor: THREE.InstancedMesh | null = null;
        if (isReeds) {
          mesh = new THREE.InstancedMesh(this.geometryOf('reeds'), this.materialOf('reeds'), count);
          mesh.name = `vegetation-reeds`;
        } else {
          const [kind, variantName] = key.split('-');
          const treeSpecies = kind as ArchetypeSpecies;
          const treeVariant = Number(variantName);
          mesh = new THREE.InstancedMesh(
            this.archetypeOf(treeSpecies, treeVariant),
            this.archetypeMaterialOf(),
            count,
          );
          mesh.name = `vegetation-${typeSample.type}-${key}`;
          if (this.impostorAtlasFor) {
            // The impostor twin (§6.1 LOD): same capacity, same slot for every
            // instance, its own quad geometry carrying the per-instance yaw the
            // frame-selection shader reads. Which twin actually shows an instance
            // is decided per rebin in refreshMatrices.
            const quad = impostorGeometry();
            quad.setAttribute('yaw', new THREE.InstancedBufferAttribute(new Float32Array(count), 1));
            impostor = new THREE.InstancedMesh(
              quad,
              this.impostorMaterialOf(archetypeIndex(treeSpecies, treeVariant)),
              count,
            );
            impostor.name = `vegetation-${typeSample.type}-${key}-impostor`;
            impostor.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            impostor.castShadow = false;
            impostor.receiveShadow = false;
          }
        }
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        meshIndexByKey.set(key, meshes.length);
        meshes.push(mesh);
        impostors.push(impostor);
      }

      const subOf = new Uint8Array(n);
      const slotOf = new Uint32Array(n);
      const nextSlot = new Uint32Array(meshes.length);
      // Class colour → species tint → per-stem wobble, three draws each in instance
      // order. The class colour still dominates: both steps are a few percent of HSL
      // (species.ts), so the legend swatch stays the thing the eye reads. The
      // impostor twin gets the identical colour and the instance's yaw — no extra
      // draws, so the stream walk is byte-identical with or without an atlas.
      for (let i = 0; i < n; i++) {
        const sub = meshIndexByKey.get(keyOf(i))!;
        subOf[i] = sub;
        slotOf[i] = nextSlot[sub]++;
        const base = colors.get(typeSample.classIndex[i]) ?? new THREE.Color(0x6b8f5a);
        const tinted = speciesColor(base, TREE_SPECIES[species[i]]);
        const shaded = jitterPlantColor(tinted, colorRandom);
        meshes[sub].setColorAt(slotOf[i], shaded);
        const impostor = impostors[sub];
        if (impostor) {
          impostor.setColorAt(slotOf[i], shaded);
          (impostor.geometry.getAttribute('yaw') as THREE.InstancedBufferAttribute).setX(slotOf[i], yaw[i]);
        }
      }
      for (const mesh of meshes) {
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        this.group.add(mesh);
      }
      for (const impostor of impostors) {
        if (!impostor) continue;
        if (impostor.instanceColor) impostor.instanceColor.needsUpdate = true;
        (impostor.geometry.getAttribute('yaw') as THREE.InstancedBufferAttribute).needsUpdate = true;
        this.group.add(impostor);
      }

      this.batches.push({
        type: typeSample.type,
        sample: typeSample,
        species,
        ground,
        connect,
        height,
        width,
        yaw,
        leanX,
        leanZ,
        meshes,
        impostors,
        subOf,
        slotOf,
      });
    }

    this.buildBandMesh(colors);
    this.refreshMatrices();
    this.refreshBand();
  }

  /**
   * One `InstancedMesh` at the band's fixed capacity, filled per level change.
   *
   * Ground is sampled here, once per candidate, so a slider move stays O(log n + k):
   * the candidate set is level-independent, only the window into it moves.
   */
  private buildBandMesh(colors: Map<number, THREE.Color>): void {
    const band = this.bandSample;
    if (!band || band.capacity === 0) return;

    const type: VegetationType = this.legend.classes[band.classIndex]?.vegetation?.type ?? 'reeds';
    const mesh = new THREE.InstancedMesh(this.geometryOf(type), this.materialOf(type), band.capacity);
    mesh.name = 'vegetation-shore-band';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // the window walks the whole domain as the slider moves
    const color = colors.get(band.classIndex) ?? new THREE.Color(0x6b8f5a);
    for (let i = 0; i < band.capacity; i++) mesh.setColorAt(i, color);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.count = 0;

    this.bandGround = new Float32Array(band.count);
    for (let i = 0; i < band.count; i++) this.bandGround[i] = this.options.groundAt(band.x[i], band.z[i]);

    this.bandMesh = mesh;
    this.group.add(mesh);
  }

  /**
   * Write the `(level, level+bandM]` window into the band mesh (contract §9 v1.3).
   *
   * Two binary searches plus `k` matrix writes — the whole reason the candidate array
   * is sorted by connect. Nothing is re-sampled and nothing is re-jittered, so a reed
   * that survives a slider move keeps a bit-identical transform.
   */
  private refreshBand(): void {
    const band = this.bandSample;
    const mesh = this.bandMesh;
    if (!band || !mesh) return;

    const level = this.waterLevelM;
    const start = upperBound(band.connect, level); // first candidate with connect > level
    const end = upperBound(band.connect, level + band.bandM); // first with connect > level+bandM
    const count = Math.min(Math.max(0, end - start), band.capacity);

    this.bandStart = start;
    this.bandWindow = count;
    mesh.count = count;

    const exaggeration = this.options.getExaggeration();
    for (let k = 0; k < count; k++) {
      const i = start + k;
      this.position.set(band.x[i], this.bandGround[i] * exaggeration, band.z[i]);
      this.euler.set(band.leanX[i], band.yaw[i], band.leanZ[i], 'YXZ');
      this.quaternion.setFromEuler(this.euler);
      this.scale.set(band.width[i], band.height[i], band.width[i]);
      mesh.setMatrixAt(k, this.matrix.compose(this.position, this.quaternion, this.scale));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (count > 0) mesh.computeBoundingSphere();
  }

  /**
   * Instance transforms: standing on the exaggerated ground at true metric size, or
   * collapsed to zero scale when the ground is suppressed at the current level (wet
   * for reeds, wet-or-inside-the-reed-belt for the tree forms — v1.3, see
   * `suppressionThreshold`).
   * Y/XZ scale carries the size, so exaggeration touches only the position — that
   * separation is the whole point (contract §0).
   */
  private refreshMatrices(): void {
    const exaggeration = this.options.getExaggeration();
    for (const batch of this.batches) {
      const n = batch.sample.x.length;
      const threshold = this.suppressionThreshold(batch.type);
      for (let i = 0; i < n; i++) {
        const x = batch.sample.x[i];
        const z = batch.sample.z[i];
        const wet = batch.connect[i] <= threshold;
        this.position.set(x, batch.ground[i] * exaggeration, z);
        this.euler.set(batch.leanX[i], batch.yaw[i], batch.leanZ[i], 'YXZ');
        this.quaternion.setFromEuler(this.euler);
        const sub = batch.subOf[i];
        const slot = batch.slotOf[i];
        const impostor = batch.impostors[sub];
        // §6.1 LOD: the instance shows in exactly one tier — mesh inside
        // MESH_TIER_RADIUS_M of the camera (or when there is no impostor twin /
        // no camera yet), impostor beyond. The hidden tier gets the zero-scale
        // matrix, the same trick suppression uses, so a rebin is matrix writes
        // and nothing else.
        let meshTier = true;
        if (!wet && impostor && this.cameraX !== null) {
          const dx = x - this.cameraX;
          const dz = z - this.cameraZ;
          meshTier = dx * dx + dz * dz <= MESH_TIER_RADIUS_M * MESH_TIER_RADIUS_M;
        }
        if (wet || !meshTier) this.scale.set(0, 0, 0);
        else this.scale.set(batch.width[i], batch.height[i], batch.width[i]);
        batch.meshes[sub].setMatrixAt(slot, this.matrix.compose(this.position, this.quaternion, this.scale));
        if (impostor) {
          // Impostors carry no yaw/lean in the matrix — the facing shader needs a
          // symmetric XZ scale and composes its own rotation; yaw rides along as
          // an instanced attribute and picks the baked frame instead.
          if (wet || meshTier) this.scale.set(0, 0, 0);
          else this.scale.set(batch.width[i], batch.height[i], batch.width[i]);
          impostor.setMatrixAt(slot, this.matrix.compose(this.position, IDENTITY_QUATERNION, this.scale));
        }
      }
      for (const mesh of batch.meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
      for (const impostor of batch.impostors) {
        if (!impostor) continue;
        impostor.instanceMatrix.needsUpdate = true;
        impostor.computeBoundingSphere();
      }
    }
  }
}

/** Impostor matrices never rotate — the facing shader owns rotation. */
const IDENTITY_QUATERNION = new THREE.Quaternion();

/**
 * First index `i` with `values[i] > value` in an ascending array (`std::upper_bound`).
 *
 * The band window is half-open on the left and closed on the right —
 * `level < connect ≤ level + bandM` — so both of its ends are exactly this search.
 */
function upperBound(values: Float32Array, value: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
