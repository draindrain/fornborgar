/**
 * Archetype A — the rampart (`docs/reconstruction-mode.md` §6.A, §7.2).
 *
 * The wall's *line* is already measured: `rampart.json` (contract §8) carries the
 * crest the pipeline pulled out of the 1 m LiDAR DEM. What this module adds is
 * the §7.2 cross-section, swept along it — and unusually for this feature, most
 * of that section is measured too. Kresten, Kero & Chyssler (1993) publish
 * Broborg's wall as a dry-stone wall of glacial-drift boulders **still standing
 * about 2 m** at an estimated **4–6 m thickness**, with the inner face and top
 * **soil-covered** and socket-beams "apparently lacking".
 *
 * ```
 *                         soil cover over inner face and top
 *                     ╭─────────────────────────────╮
 *    outer face       │                             ▓▓▓▓▓  ← vitrified cake
 *    dry-stone,      ╱│                             ▓▓▓▓▓     1.0–1.5 wide
 *    battered       ╱ │        rubble core          ▓▓▓▓▓
 *    5–10°         ╱  │                             │    │
 *   ──────────────╱───┴─────────────────────────────┴────┴───  ground (DEM)
 *                 ├────────────── t = 4–6 m ──────────────┤
 * ```
 *
 * Three things this module does *not* do, and each is a deliberate scope call:
 *
 *   • **It does not draw a standing rampart on a record that cannot support
 *     one.** §6.A.1 is the biggest honesty problem in the feature — roughly four
 *     in five registered `Fornborg` records are probably not Migration Period
 *     forts — so a site below `fortConfidenceThreshold` gets `buildLowBank`
 *     instead, at the height the register actually records.
 *   • **It does not cut entrances or an `utskott`** (§7.3). Out of scope this
 *     pass; the parsed entrance bearings and widths are in the data waiting.
 *   • **It does not add a timber superstructure** (§7.4). There is no positive
 *     evidence for one at Broborg, and the existing conjectural palisade layer
 *     is where that argument already lives.
 */

import { mulberry32, streamSeed } from '../../lib/random';
import type { MaterialFamily } from './shapes';
import { SURFACE_COLOURS, colour, mid, stoneCell } from './shapes';
import type { RampartSpec } from './schema';

/** One material family's slice of a swept wall. */
export interface SweepBuild {
  /** Local scene `[x, z]` per vertex (contract §0). */
  positionsXZ: Float32Array;
  /** Where each vertex samples the ground — the crest station, not the vertex. */
  groundXZ: Float32Array;
  /** True metres above that station's base. Never scaled by exaggeration. */
  localY: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  family: MaterialFamily;
}

/** §6.A: the outer face is battered back 5–10° from vertical. */
export const BATTER_DEG = 7;
/** §7.2: the vitrified cake runs 1.0–1.5 m wide along the inner face. */
export const VITRIFIED_WIDTH_M = 1.25;
/** §5.2's earth repose angle, which the soil backing bank stands at. */
const BACKING_REPOSE_DEG = 30;

export interface RampartOptions {
  /** Unexaggerated ground at a local point — the app's one sampler. */
  groundAt(x: number, z: number): number;
  /**
   * Render the vitrified band (§7.1's contested question, §11.3).
   *
   * Only meaningful under Sjöblom et al. (2022)'s reading that the
   * vitrification was deliberate and constructive; under Bornfalk Back (2023)'s
   * the wall was ordinary dry stone until the day it burned. A state, not a
   * verdict — and the popup states the debate either way.
   */
  vitrified: boolean;
  seed: number;
}

interface Station {
  x: number;
  z: number;
  /** Outward normal, away from the ring's own centroid. */
  nx: number;
  nz: number;
  /** Ground at the crest, unexaggerated. */
  ground: number;
  /**
   * True metres from the crest ground down to the original ground surface under
   * the wall. The DEM already contains the collapsed bank, so the surface the
   * wall was built on is the crest minus the bank height the register records.
   */
  drop: number;
  /** How far below the base the outer skirt must reach to stay buried. */
  skirt: number;
}

/** Centroid of a closed local polyline. */
function centroid(points: ReadonlyArray<[number, number]>): [number, number] {
  let x = 0;
  let z = 0;
  for (const [px, pz] of points) {
    x += px;
    z += pz;
  }
  return [x / points.length, z / points.length];
}

/**
 * Walk the crest, one station every `stepM` metres of arc length.
 *
 * Stations rather than source vertices, for the same reason `palisade.ts` walks
 * by arc length: the section spacing then means the same thing on the ground
 * whatever the pipeline's densification was (§8 guarantees ≤ 1 m).
 */
export function stations(
  points: ReadonlyArray<[number, number]>,
  closed: boolean,
  stepM: number,
  options: RampartOptions,
  dropM: number,
  thicknessM: number,
): Station[] {
  if (points.length < 3) return [];
  const [cx, cz] = centroid(points);

  // Cumulative arc length, so a station is looked up by distance along the line
  // rather than by counting source vertices — the pipeline densifies to ~0.5 m
  // (§8) and the section spacing has to mean the same thing regardless.
  const segments = closed ? points.length : points.length - 1;
  const cumulative = new Float64Array(segments + 1);
  for (let i = 0; i < segments; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    cumulative[i + 1] = cumulative[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cumulative[segments];
  if (!(total > 0)) return [];

  // A closed ring gets its spacing nudged to divide the perimeter exactly, so
  // the wall closes without a double section at the seam — the same rule
  // `palisade.postPlacements` follows, and the reason the index wrap below is
  // safe.
  const count = closed
    ? Math.max(3, Math.round(total / stepM))
    : Math.max(2, Math.ceil(total / stepM) + 1);
  const step = closed ? total / count : total / (count - 1);

  const out: Station[] = [];
  let segment = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (segment < segments - 1 && cumulative[segment + 1] < target) segment++;
    const a = points[segment];
    const b = points[(segment + 1) % points.length];
    const length = cumulative[segment + 1] - cumulative[segment];
    const t = length > 0 ? (target - cumulative[segment]) / length : 0;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[1] + (b[1] - a[1]) * t;
    // The tangent is the segment; the normal is turned outward by comparing it
    // with the direction away from the ring centroid.
    let nx = (b[1] - a[1]) / length;
    let nz = -(b[0] - a[0]) / length;
    if (nx * (x - cx) + nz * (z - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const ground = options.groundAt(x, z);
    // A render-only skirt: the section is anchored to one ground height per
    // station, so on a cross-slope the outer face has to reach below the base
    // to stay buried. Headroom of 3 covers the ×2.5 exaggeration ceiling.
    const outerGround = options.groundAt(x + nx * thicknessM, z + nz * thicknessM);
    const innerGround = options.groundAt(x - nx * thicknessM, z - nz * thicknessM);
    const relief = Math.max(0, ground - Math.min(outerGround, innerGround));
    out.push({ x, z, nx, nz, ground, drop: dropM, skirt: Math.max(1, relief * 3 + 1) });
  }
  return out;
}

/** A point on the cross-section: offset along the outward normal, and height. */
interface SectionPoint {
  n: number;
  y: number;
}

/**
 * The §7.2 cross-section, from the outer toe inward.
 *
 * Every dimension is an argument: the thickness and height come from the record
 * and the §5.1 transform, and the batter and the backing angle are the two
 * literature defaults, labelled as such in §6.A's parameter table.
 */
export function crossSection(
  heightM: number,
  thicknessM: number,
  skirtM: number,
  dropM: number,
  vitrifiedWidthM: number,
): SectionPoint[] {
  const half = thicknessM / 2;
  const batter = Math.tan((BATTER_DEG * Math.PI) / 180) * heightM;
  const backing = heightM / Math.tan((BACKING_REPOSE_DEG * Math.PI) / 180);
  // Heights are measured from the original ground surface, which sits `dropM`
  // below the crest the DEM records — the ruin is *inside* the reconstruction,
  // not underneath it.
  const base = -dropM;
  const top = base + heightM;
  const vit = Math.min(vitrifiedWidthM, thicknessM * 0.4);
  return [
    { n: half, y: base - skirtM },        // buried outer toe
    { n: half, y: base },                 // outer face base
    { n: half - batter, y: top },         // outer face top (battered back)
    { n: -half + vit, y: top },           // top, soil-covered
    { n: -half, y: top },                 // inner edge — the vitrified band
    { n: -half - backing, y: base },      // soil backing bank, at earth repose
    { n: -half - backing, y: base - skirtM }, // buried inner toe
  ];
}

/** Which material each strip between consecutive section points is made of. */
function stripFamilies(vitrified: boolean): MaterialFamily[] {
  return [
    'stone',                          // buried outer toe → outer base
    'stone',                          // the built outer face: naked dry stone
    'soil',                           // the top: soil-covered (§7.2)
    vitrified ? 'vitrified' : 'soil', // the inner edge cake, or more soil
    'soil',                           // the soil backing bank
    'soil',                           // buried inner toe
  ];
}

/**
 * Sweep the section along one crest path.
 *
 * Returns one build per material family present, because the families shade
 * differently — naked stone outside, turfed soil inside and over the top, and
 * (optionally) the dark glassy cake at the inner edge — and batching by material
 * is what keeps the whole wall to a handful of draw calls.
 */
export function buildRampart(
  points: ReadonlyArray<[number, number]>,
  closed: boolean,
  rampart: RampartSpec,
  options: RampartOptions,
  overrides: { heightM?: number; thicknessM?: number; vitrifiedWidthM?: number } = {},
): SweepBuild[] {
  const height = Math.max(0.2, overrides.heightM ?? rampart.heightM);
  const thickness = Math.max(0.8, overrides.thicknessM ?? rampart.wallThicknessM);
  const stone = Math.max(0.1, mid(rampart.stoneM ?? [0.3, 0.6]));
  // The bank the DEM already contains: the midpoint of the recorded band.
  const drop = rampart.presentHeightM ? mid(rampart.presentHeightM) : height * 0.6;

  // One station per stone width or so — fine enough that the cobbled outer face
  // resolves, coarse enough that a 300 m wall is not a million triangles.
  const step = Math.max(0.5, stone * 1.4);
  const walk = stations(points, closed, step, options, drop, thickness);
  if (walk.length < 2) return [];

  const families = stripFamilies(options.vitrified && rampart.vitrified);
  const sections = walk.map((station) =>
    crossSection(height, thickness, station.skirt, station.drop, overrides.vitrifiedWidthM ?? VITRIFIED_WIDTH_M),
  );

  const builds: SweepBuild[] = [];
  const random = mulberry32(streamSeed(options.seed, 4711));
  // Per-station roughness on the built face, so the wall reads as laid stone
  // rather than as extruded plastic. Drawn once per station and shared down the
  // section, so the face stays a face.
  const roughness = walk.map(() => (random() * 2 - 1) * stone * 0.3);

  const stripCount = families.length;
  const uniqueFamilies = Array.from(new Set(families));

  for (const family of uniqueFamilies) {
    const strips = [];
    for (let s = 0; s < stripCount; s++) if (families[s] === family) strips.push(s);

    const rows = strips.length * 2;
    const columns = walk.length;
    const vertexCount = rows * columns;
    const positionsXZ = new Float32Array(vertexCount * 2);
    const groundXZ = new Float32Array(vertexCount * 2);
    const localY = new Float32Array(vertexCount);
    const colors = new Float32Array(vertexCount * 3);

    let vertex = 0;
    for (const strip of strips) {
      for (const edge of [strip, strip + 1]) {
        for (let c = 0; c < columns; c++) {
          const station = walk[c];
          const point = sections[c][edge];
          // The built face is roughened; the buried skirt and the soil bank are
          // not — a soil bank is smooth and the skirt is never seen.
          const rough =
            family === 'stone' && point.y > station.drop * -1 ? roughness[c] : 0;
          const n = point.n + rough;
          positionsXZ[vertex * 2] = station.x + station.nx * n;
          positionsXZ[vertex * 2 + 1] = station.z + station.nz * n;
          // Every vertex of a station shares that station's ground sample, so
          // the section keeps its exact metric shape at any exaggeration
          // (contract §0). Only the whole section moves when exaggeration does.
          groundXZ[vertex * 2] = station.x;
          groundXZ[vertex * 2 + 1] = station.z;
          localY[vertex] = point.y;
          const c3 = faceColour(family, options.seed, positionsXZ[vertex * 2], positionsXZ[vertex * 2 + 1], stone);
          colors[vertex * 3] = c3.r;
          colors[vertex * 3 + 1] = c3.g;
          colors[vertex * 3 + 2] = c3.b;
          vertex++;
        }
      }
    }

    const quadsPerStrip = closed ? columns : columns - 1;
    const indices = new Uint32Array(strips.length * quadsPerStrip * 6);
    let i = 0;
    for (let s = 0; s < strips.length; s++) {
      const top = s * 2 * columns;
      const bottom = top + columns;
      for (let c = 0; c < quadsPerStrip; c++) {
        const next = (c + 1) % columns;
        indices[i++] = top + c;
        indices[i++] = bottom + c;
        indices[i++] = bottom + next;
        indices[i++] = top + c;
        indices[i++] = bottom + next;
        indices[i++] = top + next;
      }
    }

    builds.push({ positionsXZ, groundXZ, localY, colors, indices, family });
  }

  return builds;
}

/**
 * The §6.A.1 fallback: a low stone bank at the height the register records.
 *
 * "Without `kallmurning` and a ≥1 m wall in the description, draw a low bank,
 * not this." A site the app cannot classify should look *unresolved*, not
 * confidently Migration Period — so this is the recorded ruin, extruded and
 * honest about it, rather than a reconstruction.
 */
export function buildLowBank(
  points: ReadonlyArray<[number, number]>,
  closed: boolean,
  rampart: RampartSpec,
  options: RampartOptions,
): SweepBuild[] {
  const recorded = Math.max(0.2, rampart.presentHeightM ? mid(rampart.presentHeightM) : 0.6);
  const spread = rampart.spreadM ? mid(rampart.spreadM) : rampart.wallThicknessM;
  return buildRampart(
    points,
    closed,
    rampart,
    { ...options, vitrified: false },
    // A bank, not a wall. The recorded height *and* the recorded drop, so the
    // bank's top lands exactly on the crest the DEM already carries and its
    // width is the full collapse spread: this is the surviving earthwork tidied
    // up, not a monument raised on top of it. Nothing is inflated, which is the
    // whole point of the §6.A.1 fallback.
    { heightM: recorded, thicknessM: Math.max(1, spread) },
  );
}

/** Surface colour on the wall. §7.2 decides which face is which. */
function faceColour(family: MaterialFamily, seed: number, x: number, z: number, stone: number) {
  const cell = stoneCell(seed + 313, x, z, stone);
  if (family === 'vitrified') {
    // "Dark, glassy, slag-like, individual stones welded into a fused mass."
    return colour(SURFACE_COLOURS.vitrified).clone().lerp(colour(SURFACE_COLOURS.vitrifiedSheen), cell * 0.8);
  }
  if (family === 'soil') {
    return colour(SURFACE_COLOURS.rampartSoil).clone().lerp(colour(SURFACE_COLOURS.turfDark), cell * 0.45);
  }
  // §7.2: small boulders dominate, so the outer skin is tightly packed
  // small-to-medium stone rather than cyclopean blocks.
  return colour(SURFACE_COLOURS.rampartStoneDark).clone().lerp(colour(SURFACE_COLOURS.rampartStone), cell);
}
