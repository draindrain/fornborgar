/**
 * Procedural tree archetypes (PLAN §6.1 amendment, 2026-08-22).
 *
 * The naturalistic-rendering decision replaces the schematic cone/icosahedron
 * forms with species-level tree meshes — and this module is where those meshes
 * come from. Nothing here is authored: every archetype is generated from a seed
 * at load time, which is what keeps the §1 "no hand-modeled 3D assets" constraint
 * and the palisade rule ("same seed ⇒ same scene on every machine") true at the
 * same time. ez-tree and friends were considered and rejected (owner decision
 * 2026-08-22): a library's internal draw order is not ours to pin, and the
 * determinism guarantee has to be ours.
 *
 * Contract with the instancing pipeline (do not break — tests pin it):
 *
 *   • **Unit height, base at y = 0, canopy diameter 1.** An instance's scale
 *     *is* its metric size, exactly as with the old cone: `scale.y` = height in
 *     meters, `scale.x = scale.z` = crown width. Everything downstream (metric
 *     size under exaggeration, zero-scale suppression, the shore-band matrix
 *     stability) works unchanged because the geometry keeps this convention.
 *   • **Species identity lives in silhouette + bark, not in leaf detail.** At
 *     the distances this app is viewed from, people identify trees by outline
 *     and trunk: spruce = dark drooping spire, pine = bare trunk with an
 *     umbrella crown, birch = white flecked trunk with an airy crown, oak =
 *     stout trunk under a broad lumpy dome. A few hundred triangles carry all
 *     four.
 *   • **Foliage takes the instance colour; bark does not.** Foliage vertices are
 *     baked as near-white × ambient occlusion so the per-instance class/species
 *     colour (InstancedMesh.setColorAt) shows through multiplied. Bark vertices
 *     carry their own RGB — a birch trunk must stay white whatever green the
 *     legend gives the stand — so the material's shader swaps the instance-
 *     tinted colour back to the raw vertex colour where the `bark` attribute
 *     says so (`createArchetypeMaterial`).
 *   • **Deterministic per (species, variant).** All jitter comes from a
 *     mulberry32 stream derived via `archetypeSeed` (streams 500+ of the app's
 *     stream-id map; see lib/random.ts call sites). Same seed, same tree.
 *
 * Triangle budget: each archetype stays in the low hundreds of triangles
 * (pinned ≤ 700 by tests) — at ~13 archetype meshes ((species × variants) + reeds)
 * the near field stays a handful of draw calls, and the Part-3 impostor tier
 * keeps the *instance* count that reaches these meshes small.
 */

import * as THREE from 'three';
import { mulberry32, streamSeed } from '../lib/random';

/** The species that get generated meshes. Reeds keep their cross-quads. */
export const ARCHETYPE_SPECIES = ['spruce', 'pine', 'birch', 'oak'] as const;
export type ArchetypeSpecies = (typeof ARCHETYPE_SPECIES)[number];

/** Mesh variants per species — enough to kill the cloned-army read. */
export const ARCHETYPE_VARIANTS = 3;

/** Stream-id base for archetype generation (near appearance = 100+, band = 200+,
 * far = 300+, species/colour = 400+ — this module owns 500+). */
const ARCHETYPE_STREAM_BASE = 500;

/** The seed for one (species, variant) archetype, derived from the layout seed. */
export function archetypeSeed(seed: number, species: ArchetypeSpecies, variant: number): number {
  const speciesIndex = ARCHETYPE_SPECIES.indexOf(species);
  return streamSeed(seed, ARCHETYPE_STREAM_BASE + speciesIndex * ARCHETYPE_VARIANTS + variant);
}

// ---------------------------------------------------------------- builder ----

/**
 * Accumulates one archetype's triangles. Positions/colours/bark are parallel;
 * normals are computed once at the end (indexed ⇒ smooth), which reads better
 * on low-poly organic shapes than facets.
 */
class Builder {
  positions: number[] = [];
  colors: number[] = [];
  bark: number[] = [];
  indices: number[] = [];

  vertex(x: number, y: number, z: number, color: THREE.Color, bark: number): number {
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.colors.push(color.r, color.g, color.b);
    this.bark.push(bark);
    return index;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('bark', new THREE.Float32BufferAttribute(this.bark, 1));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    return geometry;
  }
}

/** sRGB hex → working-space colour, the same idiom as the rest of the app. */
function srgb(hex: string): THREE.Color {
  return new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
}

/** Foliage vertex colour: near-white × AO so the instance colour multiplies in. */
function foliage(ao: number): THREE.Color {
  return new THREE.Color(ao, ao, ao);
}

// ----------------------------------------------------------------- pieces ----

interface TrunkOptions {
  baseY: number;
  topY: number;
  baseR: number;
  topR: number;
  /** Max sideways drift of the trunk axis over its length (organic bend). */
  bend: number;
  radial: number;
  segments: number;
  /** Bark colour per ring parameter t ∈ [0,1] and per vertex. */
  color: (t: number, random: () => number) => THREE.Color;
}

/** A tapered, gently bent trunk column; returns the top-center for a tip. */
function addTrunk(b: Builder, random: () => number, o: TrunkOptions): { x: number; y: number; z: number } {
  const driftX = (random() * 2 - 1) * o.bend;
  const driftZ = (random() * 2 - 1) * o.bend;
  const rings: number[][] = [];
  for (let s = 0; s <= o.segments; s++) {
    const t = s / o.segments;
    const y = o.baseY + (o.topY - o.baseY) * t;
    const r = o.baseR + (o.topR - o.baseR) * t;
    // Ease-in drift: the base stays planted, the top wanders.
    const cx = driftX * t * t;
    const cz = driftZ * t * t;
    const ring: number[] = [];
    for (let i = 0; i < o.radial; i++) {
      const a = (i / o.radial) * Math.PI * 2;
      const jitter = 1 + (random() * 2 - 1) * 0.08;
      ring.push(
        b.vertex(cx + Math.cos(a) * r * jitter, y, cz + Math.sin(a) * r * jitter, o.color(t, random), 1),
      );
    }
    rings.push(ring);
  }
  for (let s = 0; s < o.segments; s++) {
    const a = rings[s];
    const c = rings[s + 1];
    for (let i = 0; i < o.radial; i++) {
      const j = (i + 1) % o.radial;
      b.triangle(a[i], a[j], c[i]);
      b.triangle(a[j], c[j], c[i]);
    }
  }
  return { x: driftX, y: o.topY, z: driftZ };
}

interface SkirtOptions {
  /** Where the tier meets the trunk. */
  apexX: number;
  apexY: number;
  apexZ: number;
  /** The drooping rim: below the apex, out at `rimR`. */
  rimY: number;
  rimR: number;
  radial: number;
  /** AO at the rim (the apex is darker — it sits inside the crown). */
  rimAO: number;
}

/** One drooping conifer branch tier — a cone "skirt" with apex on the trunk. */
function addSkirt(b: Builder, random: () => number, o: SkirtOptions): void {
  const apex = b.vertex(o.apexX, o.apexY, o.apexZ, foliage(o.rimAO * 0.55), 0);
  const rim: number[] = [];
  for (let i = 0; i < o.radial; i++) {
    const a = (i / o.radial) * Math.PI * 2;
    const r = o.rimR * (1 + (random() * 2 - 1) * 0.18);
    const droop = (random() * 2 - 1) * 0.15 * (o.apexY - o.rimY);
    rim.push(
      b.vertex(
        o.apexX + Math.cos(a) * r,
        o.rimY + droop,
        o.apexZ + Math.sin(a) * r,
        foliage(o.rimAO * (1 + (random() * 2 - 1) * 0.08)),
        0,
      ),
    );
  }
  for (let i = 0; i < o.radial; i++) {
    const j = (i + 1) % o.radial;
    b.triangle(apex, rim[j], rim[i]);
  }
}

interface LobeOptions {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  /** Vertical flattening (pine umbrellas ~0.5, oak domes ~0.85). */
  squash: number;
  /** Icosahedron detail: 0 = 20 tris (small lobes), 1 = 80 tris (main lobes). */
  detail: 0 | 1;
  /** AO range over the lobe's own height. */
  aoLow: number;
  aoHigh: number;
  /** Per-vertex displacement as a fraction of radius. */
  roughness: number;
}

/** One displaced-icosahedron crown lobe. */
function addLobe(b: Builder, random: () => number, o: LobeOptions): void {
  const ico = new THREE.IcosahedronGeometry(o.radius, o.detail);
  const pos = ico.getAttribute('position') as THREE.BufferAttribute;
  const index = ico.getIndex();

  // Icosahedron geometry shares no vertices between faces (PolyhedronGeometry
  // is non-indexed); merge identical positions ourselves so displacement keeps
  // the lobe watertight and the computed normals smooth. Unique positions are
  // walked in first-appearance order so the displacement draw sequence is a
  // pure function of the geometry, not of Map iteration details.
  const uniqueKeys: string[] = [];
  const firstIndex = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    if (!firstIndex.has(key)) {
      firstIndex.set(key, i);
      uniqueKeys.push(key);
    }
  }

  const built = new Map<string, number>();
  for (const key of uniqueKeys) {
    const i = firstIndex.get(key)!;
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    const displacement = 1 + (random() * 2 - 1) * o.roughness;
    const px = o.cx + (x / len) * o.radius * displacement;
    const py = o.cy + (y / len) * o.radius * displacement * o.squash;
    const pz = o.cz + (z / len) * o.radius * displacement;
    const relY = THREE.MathUtils.clamp((y / o.radius + 1) / 2, 0, 1);
    const ao = o.aoLow + (o.aoHigh - o.aoLow) * relY;
    built.set(key, b.vertex(px, py, pz, foliage(ao * (1 + (random() * 2 - 1) * 0.05)), 0));
  }

  const indexOf = (i: number): number => {
    const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    return built.get(key)!;
  };
  if (index) {
    for (let t = 0; t < index.count; t += 3) {
      b.triangle(indexOf(index.getX(t)), indexOf(index.getX(t + 1)), indexOf(index.getX(t + 2)));
    }
  } else {
    for (let t = 0; t < pos.count; t += 3) {
      b.triangle(indexOf(t), indexOf(t + 1), indexOf(t + 2));
    }
  }
  ico.dispose();
}

// ---------------------------------------------------------------- species ----

/**
 * Norway spruce: near-black-green drooping spire, branched to the ground.
 * ~6–8 skirt tiers over a thin trunk; the topmost tier is a closed tip.
 */
function buildSpruce(b: Builder, random: () => number): void {
  const barkColor = srgb('#4a4038');
  addTrunk(b, random, {
    baseY: 0,
    topY: 0.99,
    baseR: 0.028,
    topR: 0.006,
    bend: 0.02,
    radial: 5,
    segments: 3,
    color: (t, r) => barkColor.clone().multiplyScalar(0.9 + 0.2 * r() * (1 - t)),
  });
  // Overlapping shingled tiers: each skirt drops well past the next tier's
  // apex, so the silhouette reads as one continuous drooping spire, not a
  // stack of separated triangles.
  const tiers = 8 + Math.floor(random() * 3);
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1); // 0 = lowest tier, 1 = top
    const apexY = 0.16 + 0.82 * t;
    const rimR = 0.5 * (1 - t * 0.8) * (1 + (random() * 2 - 1) * 0.1);
    addSkirt(b, random, {
      apexX: 0,
      apexY,
      apexZ: 0,
      rimY: apexY - (0.24 - 0.12 * t),
      rimR: Math.max(rimR, 0.06),
      radial: 7,
      rimAO: 0.7 + 0.28 * t,
    });
  }
}

/**
 * Scots pine: the Nordic treeline's other half — a tall bare trunk (upper part
 * the species' unmistakable warm orange) under a small flattened umbrella crown.
 */
function buildPine(b: Builder, random: () => number): void {
  const lower = srgb('#6b5a48');
  const upper = srgb('#b5734a');
  addTrunk(b, random, {
    baseY: 0,
    topY: 0.82,
    baseR: 0.055,
    topR: 0.028,
    bend: 0.06,
    radial: 5,
    segments: 4,
    // The colour break at ~40% height is the species tell; keep it sharp-ish.
    color: (t, r) => (t < 0.4 ? lower : upper).clone().multiplyScalar(0.92 + 0.16 * r()),
  });
  // The umbrella: wide, flat, slightly offset lobes crowning the bare trunk.
  const lobes = 3 + Math.floor(random() * 2);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + random() * 1.4;
    const spread = 0.16 + random() * 0.22;
    addLobe(b, random, {
      cx: Math.cos(a) * spread,
      cy: 0.84 + random() * 0.1,
      cz: Math.sin(a) * spread,
      radius: 0.28 + random() * 0.1,
      squash: 0.42,
      detail: 1,
      aoLow: 0.68,
      aoHigh: 1.05,
      roughness: 0.22,
    });
  }
}

/**
 * Birch: slim white trunk with dark flecks — readable from a kilometre — under
 * a small, airy, slightly weeping crown.
 */
function buildBirch(b: Builder, random: () => number): void {
  const white = srgb('#e8e4dc');
  const fleck = srgb('#3a3530');
  addTrunk(b, random, {
    baseY: 0,
    topY: 0.78,
    baseR: 0.032,
    topR: 0.012,
    bend: 0.09,
    radial: 5,
    segments: 4,
    color: (t, r) => (r() < 0.22 ? fleck : white).clone().multiplyScalar(0.95 + 0.1 * r()),
  });
  // Airy: several small, well-separated lobes rather than one mass, so sky
  // shows through the crown the way it does through a real birch.
  const lobes = 3 + Math.floor(random() * 2);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + random() * 1.6;
    const spread = 0.12 + random() * 0.18;
    addLobe(b, random, {
      cx: Math.cos(a) * spread,
      cy: 0.66 + random() * 0.24,
      cz: Math.sin(a) * spread,
      radius: 0.16 + random() * 0.08,
      squash: 0.95,
      detail: 1,
      aoLow: 0.8,
      aoHigh: 1.1,
      roughness: 0.3,
    });
  }
}

/**
 * Oak (standing in for the oak–lime–ash nemoral broadleaf component): a stout
 * short trunk under a broad, lumpy, overlapping-lobed dome.
 */
function buildOak(b: Builder, random: () => number): void {
  const barkColor = srgb('#5b4a3a');
  addTrunk(b, random, {
    baseY: 0,
    topY: 0.45,
    baseR: 0.07,
    topR: 0.04,
    bend: 0.07,
    radial: 6,
    segments: 3,
    color: (t, r) => barkColor.clone().multiplyScalar(0.88 + 0.2 * r()),
  });
  const lobes = 3 + Math.floor(random() * 2);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + random() * 1.2;
    const spread = 0.1 + random() * 0.18;
    addLobe(b, random, {
      cx: Math.cos(a) * spread,
      cy: 0.55 + random() * 0.24,
      cz: Math.sin(a) * spread,
      radius: 0.26 + random() * 0.12,
      squash: 0.8,
      detail: 1,
      aoLow: 0.62,
      aoHigh: 1.05,
      roughness: 0.24,
    });
  }
}

const BUILDERS: Record<ArchetypeSpecies, (b: Builder, random: () => number) => void> = {
  spruce: buildSpruce,
  pine: buildPine,
  birch: buildBirch,
  oak: buildOak,
};

// ----------------------------------------------------- normalize + export ----

/**
 * Scale the built shape into the instancing contract: base at y = 0, height
 * exactly 1, canopy diameter exactly 1 (max XZ radius 0.5). Both axes are
 * normalized independently — the *instance* scale carries the species' true
 * aspect (height × widthRatio), so the geometry must not double-apply it.
 */
function normalize(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  // Clamp first (a drooping skirt rim may dip below the ground plane), then
  // scale by the clamped extents — the order matters for max.y to land on 1.
  let maxY = 0;
  let maxR = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = Math.max(0, pos.getY(i));
    pos.setY(i, y);
    if (y > maxY) maxY = y;
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    if (r > maxR) maxR = r;
  }
  const sy = 1 / (maxY || 1);
  const sxz = 0.5 / (maxR || 0.5);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * sxz, pos.getY(i) * sy, pos.getZ(i) * sxz);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

/**
 * Build one archetype: unit height, base at y = 0, canopy diameter 1,
 * deterministic for the seed. See the module comment for the full contract.
 */
export function buildArchetype(species: ArchetypeSpecies, seed: number): THREE.BufferGeometry {
  const random = mulberry32(seed);
  const b = new Builder();
  BUILDERS[species](b, random);
  const geometry = b.build();
  normalize(geometry);
  geometry.name = `archetype-${species}`;
  return geometry;
}

/** The (species, variant) archetype for a layout seed — the instancing entry point. */
export function archetypeGeometry(
  species: ArchetypeSpecies,
  variant: number,
  seed: number,
): THREE.BufferGeometry {
  const geometry = buildArchetype(species, archetypeSeed(seed, species, variant));
  geometry.name = `archetype-${species}-${variant}`;
  return geometry;
}

// --------------------------------------------------------------- material ----

/**
 * The archetype material: Lambert + vertex colours, with one injection — bark
 * vertices take their raw vertex colour instead of the instance-tinted one
 * (see the module comment: a birch trunk stays white whatever the stand's
 * legend colour). Follows the app's established onBeforeCompile idiom: keep
 * the include anchors intact and extend the program cache key so the program
 * never aliases plain Lambert (same pattern as the far-field billboards).
 */
export function createArchetypeMaterial(): THREE.Material {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    // Skirt tiers and lobe shells are open surfaces seen from below on the
    // walk-up path; both sides must render.
    side: THREE.DoubleSide,
  });
  material.name = 'vegetation-archetype';

  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|archetype`;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        ['#include <common>', 'attribute float bark;', 'varying float vBark;', 'varying vec3 vBarkColor;'].join(
          '\n',
        ),
      )
      .replace(
        '#include <color_vertex>',
        [
          '#include <color_vertex>',
          'vBark = bark;',
          // The raw vertex colour, before the instance colour multiplies in.
          'vBarkColor = color.rgb;',
        ].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        ['#include <common>', 'varying float vBark;', 'varying vec3 vBarkColor;'].join('\n'),
      )
      .replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          // Bark keeps its own colour: undo the instance tint where bark = 1.
          'diffuseColor.rgb = mix(diffuseColor.rgb, vBarkColor, vBark);',
        ].join('\n'),
      );
  };
  return material;
}
