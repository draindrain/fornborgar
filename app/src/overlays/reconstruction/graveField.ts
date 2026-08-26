/**
 * Archetype G — the grave-field sampler (`docs/reconstruction-mode.md` §3.1, §6.G).
 *
 * A `Gravfält` record is not a shape, it is a **compositional recipe**. The
 * register enumerates its own contents — "245x140 m (N-S) bestående av ca 65
 * fornlämningar. Dessa utgörs av 5 högar, 2 rösen och ca 57 runda fyllda
 * stensättningar samt 1 rest sten … Stensättningarna är 3-8 m diam, 0,2-0,6 m h"
 * — so nothing about *what* is in a grave field needs inventing. 28 of the
 * Broborg bundle's 31 grave-field records state their own monument count, and
 * those counts run from **5 to 230**. This module handles both with the same
 * code, because the count is data.
 *
 * What is *not* in the record is where each monument stands, and §6.G is explicit
 * that this is the only genuinely inferential part of the archetype. It is
 * inferred from landscape rules rather than invented:
 *
 *   • **Dry ground.** Wet land-cover classes are excluded outright, using the
 *     existing §9 raster rather than a new one.
 *   • **Prominence.** Local relief against a 25 m neighbourhood, from the DEM —
 *     grave fields sit on ridges, eskers and rock crowns.
 *   • **Slope.** Steep ground is rejected; nobody built a mound on a scarp.
 *   • **Size bias.** "Larger mounds take the highest and most visible points,
 *     small stone settings fill between them", so monuments are placed largest
 *     first and the large ones are choosier.
 *   • **Clustering.** "Monuments cluster rather than scattering evenly. Even
 *     scatter looks wrong."
 *   • **Blue noise.** Variable-radius spacing, so nothing intersects anything.
 *
 * The whole sampler is seeded from the site and the record id through
 * `lib/random.mulberry32`, so a reload is byte-identical — the same rule the
 * palisade's jitter and the vegetation's placement already keep.
 */

import { mulberry32, streamSeed } from '../../lib/random';
import type { FieldClass, Monument, PlanForm, Range } from './schema';

/** One monument the sampler decided to place. */
export interface PlacedMonument {
  /** Local scene coordinates (contract §0). Ground height is sampled later. */
  x: number;
  z: number;
  archetype: string;
  form: PlanForm;
  diameterM: number;
  heightM: number;
  stoneM: Range;
  /** True where the class was recorded as `högliknande` (a profile hint). */
  moundLike: boolean;
  figure?: string;
  /** Set-stone figures and standing stones get their own bearing. */
  orientationDeg: number;
  /** Index into the field's own class list, for the popup's breakdown. */
  classIndex: number;
}

/** Local-coordinate polygon rings: `[[x, z], …]`, outer ring first. */
export type LocalRings = Array<Array<[number, number]>>;

export interface SamplerTerrain {
  /** The app's one ground sampler, unexaggerated (contract §0). */
  groundAt(x: number, z: number): number;
  /**
   * §9 land-cover class at a point, or null where the site ships no raster.
   * Returning null everywhere degrades the sampler to DEM-only, which is
   * correct rather than fatal — a site with no land cover has no wet classes
   * to exclude.
   */
  classAt: ((x: number, z: number) => number) | null;
  /** Is this class index one monuments must not stand in (water, fen, reeds)? */
  isWet: (classIndex: number) => boolean;
  /** Is this class index merely damp — allowed, but a poor site? */
  isDamp?: (classIndex: number) => boolean;
}

/** Radius (m) the local-prominence comparison is taken over. */
export const PROMINENCE_RADIUS_M = 25;
/** Above this gradient a candidate is rejected outright (≈ 15°). */
export const MAX_SLOPE = 0.27;
/** Clear ground between two monuments' rims, as a fraction of their radii. */
export const SPACING_GAP = 0.45;
/**
 * Candidate points drawn per monument before the best is taken.
 *
 * Deliberately lopsided, and this is what actually implements §6.G's size bias.
 * A field holds a handful of mounds and scores of stone settings; if both drew
 * the same number of candidates, the mounds would never see the high ground
 * (a knoll is a few per cent of an extent's area, so twenty darts miss it) while
 * the settings, being many, would carpet it by sheer volume — the exact inverse
 * of "larger mounds take the highest and most visible points, small stone
 * settings fill between them".
 */
const CANDIDATES_LARGE = 96;
const CANDIDATES_SMALL = 16;
/** Distance (m) over which the clustering bonus decays. */
const CLUSTER_SCALE_M = 18;

// ------------------------------------------------------------- geometry -----

/** Even-odd point-in-polygon over local `[x, z]` rings. */
export function pointInRings(rings: LocalRings, x: number, z: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i];
      const [xj, zj] = ring[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

export interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function ringBounds(rings: LocalRings): Bounds | null {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const ring of rings) {
    for (const [x, z] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return Number.isFinite(minX) ? { minX, minZ, maxX, maxZ } : null;
}

/**
 * The extent to sample inside.
 *
 * The KMR extent polygon where the record has one (measured, §3), and otherwise
 * an ellipse at the extent the *description* states — "245x140 m (N-S)" is a
 * measurement too, and falling back to it beats falling back to a guess. Both
 * are honest; a record with neither has no field to fill.
 */
export function fieldRings(monument: Monument, position: { x: number; z: number }, geometry: LocalRings | null): LocalRings | null {
  if (geometry && geometry.length > 0 && geometry[0].length >= 3) return geometry;
  const a = (monument.plan.lengthM ?? monument.plan.diameterM) / 2;
  const b = (monument.plan.widthM ?? monument.plan.diameterM) / 2;
  if (!(a > 0) || !(b > 0)) return null;
  const rotation = ((monument.plan.orientationDeg ?? 0) * Math.PI) / 180;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < 48; i++) {
    const theta = (i / 48) * Math.PI * 2;
    const x = Math.cos(theta) * a;
    const z = Math.sin(theta) * b;
    ring.push([
      position.x + x * Math.cos(rotation) - z * Math.sin(rotation),
      position.z + x * Math.sin(rotation) + z * Math.cos(rotation),
    ]);
  }
  return [ring];
}

// ------------------------------------------------------- the composition ----

/**
 * Expand the record's own enumeration into individual monuments (§3.1).
 *
 * Each monument's diameter and height are drawn from the *stated* class ranges
 * with **one** shared draw, not two independent ones: a 8 m stone setting in a
 * "3-8 m diam, 0,2-0,6 m h" class is the tall end of its class as well as the
 * wide end, which is how monuments actually vary. Two independent draws would
 * produce wide flat discs and tall narrow cones the register never described.
 */
export function expandComposition(classes: FieldClass[], seed: number): PlacedMonument[] {
  const out: PlacedMonument[] = [];
  classes.forEach((entry, classIndex) => {
    // Per-class stream, so adding a class cannot re-roll the others.
    const random = mulberry32(streamSeed(seed, classIndex));
    const count = Math.max(0, Math.round(entry.count));
    for (let i = 0; i < count; i++) {
      const u = random();
      const diameter = entry.diameterM[0] + (entry.diameterM[1] - entry.diameterM[0]) * u;
      const height = entry.heightM[0] + (entry.heightM[1] - entry.heightM[0]) * u;
      out.push({
        x: 0,
        z: 0,
        archetype: entry.archetype,
        form: entry.form ?? 'round',
        diameterM: Math.max(0.5, diameter),
        heightM: Math.max(0.05, height),
        stoneM: entry.stoneM,
        moundLike: Boolean(entry.moundLike),
        figure: entry.figure,
        orientationDeg: random() * 180,
        classIndex,
      });
    }
  });
  return out;
}

// ------------------------------------------------------------ the sampler ---

interface Candidate {
  x: number;
  z: number;
  score: number;
}

/** Uniform grid bucket index for the spacing test. */
function key(x: number, z: number, cell: number): string {
  return `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
}

/**
 * Place a grave field's monuments inside its extent.
 *
 * Returns the placements it could make. A field whose polygon is mostly wet or
 * steep places fewer monuments than the record states — that is the honest
 * outcome, and the layer reports the shortfall rather than forcing monuments
 * into water to hit a number.
 */
export function sampleGraveField(
  monument: Monument,
  position: { x: number; z: number },
  geometry: LocalRings | null,
  terrain: SamplerTerrain,
  seed: number,
): PlacedMonument[] {
  const spec = monument.field;
  if (!spec || spec.classes.length === 0) return [];
  const rings = fieldRings(monument, position, geometry);
  if (!rings) return [];
  const bounds = ringBounds(rings);
  if (!bounds) return [];

  const monuments = expandComposition(spec.classes, seed);
  if (monuments.length === 0) return [];
  // §6.G: largest first, so the mounds get their pick of the high ground and the
  // small settings fill in between them.
  monuments.sort((a, b) => b.diameterM - a.diameterM);

  const random = mulberry32(streamSeed(seed, 9001));
  const placed: PlacedMonument[] = [];
  const biggest = monuments[0].diameterM;
  // One bucket per largest-possible interaction distance, so the spacing test
  // only ever looks at the nine neighbouring buckets.
  const cell = Math.max(4, biggest * (1 + SPACING_GAP));
  const buckets = new Map<string, PlacedMonument[]>();

  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;

  const fits = (x: number, z: number, radius: number): boolean => {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const neighbours = buckets.get(`${cx + dx},${cz + dz}`);
        if (!neighbours) continue;
        for (const other of neighbours) {
          const need = radius + other.diameterM / 2;
          const gap = need * (1 + SPACING_GAP);
          if ((x - other.x) ** 2 + (z - other.z) ** 2 < gap * gap) return false;
        }
      }
    }
    return true;
  };

  const nearest = (x: number, z: number): number => {
    let best = Infinity;
    for (const other of placed) {
      const d = (x - other.x) ** 2 + (z - other.z) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };

  /** Prominence and slope at a point, from the DEM (§6.G). */
  const terrainScore = (x: number, z: number): number | null => {
    if (terrain.classAt) {
      const cover = terrain.classAt(x, z);
      if (terrain.isWet(cover)) return null; // no monument stands in a fen
    }
    const here = terrain.groundAt(x, z);
    let ring = 0;
    for (let i = 0; i < 8; i++) {
      const theta = (i / 8) * Math.PI * 2;
      ring += terrain.groundAt(
        x + Math.cos(theta) * PROMINENCE_RADIUS_M,
        z + Math.sin(theta) * PROMINENCE_RADIUS_M,
      );
    }
    const prominence = here - ring / 8;

    const step = 3;
    const slope = Math.max(
      Math.abs(terrain.groundAt(x + step, z) - terrain.groundAt(x - step, z)) / (2 * step),
      Math.abs(terrain.groundAt(x, z + step) - terrain.groundAt(x, z - step)) / (2 * step),
    );
    if (slope > MAX_SLOPE) return null;

    let score = prominence - slope * 8;
    if (terrain.classAt && terrain.isDamp) {
      // Damp is allowed and unattractive, unlike wet, which is refused above.
      if (terrain.isDamp(terrain.classAt(x, z))) score -= 2;
    }
    return score;
  };

  for (const candidateMonument of monuments) {
    const radius = candidateMonument.diameterM / 2;
    // §6.G's size bias: a mound is choosy about prominence, a small stone
    // setting mostly just needs somewhere dry to go.
    const large = radius >= biggest * 0.5;
    const prominenceWeight = large ? 1.0 : 0.12;
    const attempts = large ? CANDIDATES_LARGE : CANDIDATES_SMALL;
    let best: Candidate | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const x = bounds.minX + random() * width;
      const z = bounds.minZ + random() * depth;
      if (!pointInRings(rings, x, z)) continue;
      if (!fits(x, z, radius)) continue;
      const score = terrainScore(x, z);
      if (score === null) continue;
      // Clustering: a candidate near what is already there beats an isolated
      // one of equal ground, because grave fields cluster (§6.G).
      // Clustering pulls the small monuments together; it must not outbid
      // prominence for the large ones, or they end up huddling in the hollow
      // the first of them happened to land in.
      const cluster =
        placed.length === 0 ? 0 : Math.exp(-nearest(x, z) / CLUSTER_SCALE_M) * (large ? 0.3 : 1.5);
      const total = score * prominenceWeight + cluster;
      if (!best || total > best.score) best = { x, z, score: total };
    }

    if (!best) continue;
    candidateMonument.x = best.x;
    candidateMonument.z = best.z;
    placed.push(candidateMonument);
    const bucket = key(best.x, best.z, cell);
    const list = buckets.get(bucket);
    if (list) list.push(candidateMonument);
    else buckets.set(bucket, [candidateMonument]);
  }

  return placed;
}
