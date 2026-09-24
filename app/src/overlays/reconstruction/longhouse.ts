/**
 * Archetype H — the three-aisled longhouse (`docs/reconstruction-mode.md` §6.H).
 *
 * This is the weakest-evidenced card in the catalogue: a `Boplats` record marks a
 * scatter of finds, dark soil or post-holes, and **nothing is visible**. So the
 * geometry here is not a reading of a monument, it is the literature's house —
 * and §6.H is unusually specific about which literature, because Näsman's
 * critical review of Scandinavian reconstructions names four things that
 * reconstructions routinely get wrong. All four are decisions in this file:
 *
 *   • **The walls are real walls**, at least 1 m high and load-bearing (Näsman
 *     1976, 120; Myhre 1980, 168) — not a footing under a tall steep roof, which
 *     is the 1930s Lojsta error. `wallHeightM ≥ 1.0` is a schema constraint
 *     (§15.3) and the wall carries the roof plate here.
 *   • **The roof is hipped, not gabled** (Herschend 1980; Lund & Thomsen 1982;
 *     Näsman 1983). There is no gable in this module: the ridge stops short and
 *     the roof falls away on all four sides.
 *   • **The hip slopes at the same pitch as the long sides, or steeper — never
 *     shallower.** A shallow hip is the Eketorp-II error. `hipPitchDeg` is
 *     validated ≥ `roofPitchDeg` at the door and the hip run is *derived* from
 *     it, so the geometry cannot drift from the number the data states.
 *   • **The central aisle takes less than half the breadth in the 3rd–8th
 *     centuries** — *underbalanserad*, ~40 % of breadth, 1.3–2.8 m in Mälardalen
 *     (Göthberg 2000, via the Uppsala county research overview). That is
 *     period-specific and it is the whole reason earlier Iron Age house data
 *     cannot be used uncritically for the 5th-century house this app needs.
 *
 * The default house is **Gene house II, 40 × 9 m, ~350–600 CE** — precisely
 * Broborg's period and the best regional analogue available — with birch bark
 * under turf (`nävertak`) and walls of wattle sealed with clay (§6.H). The roof
 * is far and away the biggest thing in the silhouette: at 9 m breadth and 45° it
 * stands 4.5 m over a 1.2 m wall, which is §6.H's "the roof easily twice the
 * height of the wall below it".
 *
 * Two invariants this module keeps, both from contract §0:
 *
 *   • **A building is rigid.** Every vertex of one house shares **one** ground
 *     sample — the mean over its own footprint — so the house keeps its exact
 *     metric shape at any exaggeration and the ridge is level rather than draped
 *     over the terrain. Only the whole house moves when exaggeration changes.
 *   • **The terrain is measured and stays measured** (§7.5.3: "any regrading of
 *     the measured interior to seat a building" is refused). A house on a slope
 *     is dug into it uphill and stands on its footing downhill; the footing
 *     carries a skirt that reaches below the ground it is seated on, with the
 *     same ×3 headroom `fort.ts` uses, so nothing floats up to ×3 exaggeration.
 *
 * What this module deliberately does **not** model, so the omissions are read as
 * omissions: the sunken floor of a `grophus` (it is below the measured ground,
 * and cutting the DEM to show it would be regrading), the internal partitions,
 * the byre stalls, and the fence of §6.H's "beyond them a fence and the fields".
 */

import * as THREE from 'three';

import { mulberry32, streamSeed } from '../../lib/random';
import type { BuildingKind, Range } from './schema';
import { SURFACE_COLOURS, colour, stoneCell, type MaterialFamily } from './shapes';

// --------------------------------------------------------------- defaults ---

/**
 * The archetype defaults §6.H does not put a number on.
 *
 * Every one of them is **assumed** in the §9 sense: none is in the register and
 * none is in the data contract, so they live here, named, rather than as
 * literals inside the geometry. They are the third tier of §6.H's own table —
 * the one that reads "Assumed" — and the popup's fallback list is where the data
 * says so for the values the contract does carry.
 */
export const HOUSE_DEFAULTS = {
  /** Deep eaves shading the daub. Gene's reconstruction, and every turf roof. */
  eavesOverhangM: 0.5,
  /** §6.H: "standing on a low footing of set stone". */
  footingHeightM: 0.35,
  /** A wattle wall daubed both sides. */
  wallThicknessM: 0.22,
  /** §6.H: "a wide doorway in the middle of the long side". */
  doorwayWidthM: 1.6,
  /** §6.H: "a board with a hole in it", not an open louvre — so, small. */
  smokeVentM: [0.75, 0.5] as const,
  /** A roof-bearing post, not a stake. */
  postDiameterM: 0.3,
  /**
   * §6.H: "regular and close in the byre and more varied in the dwelling end,
   * with a large span across the hearth area". The split between the two is not
   * in the literature as a number; this is the assumption that makes the
   * non-uniformity implementable, and it is the reason `trestleStations` is
   * exported and tested rather than buried in the mesh builder.
   */
  byreFraction: 0.4,
} as const;

/** Metres of wall or roof per tessellation step. Budget, not shape (§7.6). */
const STEP_M = 1.8;

// ------------------------------------------------------------ the spec ------

/** One building, placed. The sampler in `farmstead.ts` produces these. */
export interface HouseSpec {
  kind: BuildingKind;
  /** Local scene coordinates of the footprint centre (contract §0). */
  x: number;
  z: number;
  lengthM: number;
  widthM: number;
  /**
   * Rotation of the long axis, in radians, in the app's local frame
   * (`lib/coords`: east = +x, north = −z). `bearingRotation` converts a compass
   * bearing — which is what the register states — into one of these.
   */
  rotationRad: number;
  wallHeightM: number;
  roofPitchDeg: number;
  hipPitchDeg: number;
  aisleFraction: number;
  aisleWidthM: Range;
  trestleSpacingM: Range;
  /** Which long side the doorway is in: +1 or −1 across the short axis. */
  doorSide: 1 | -1;
  seed: number;
}

export interface HouseOptions {
  /** The app's one unexaggerated ground sampler (contract §0). */
  groundAt(x: number, z: number): number;
}

/** One material family's slice of one building, ready for the layer's batches. */
export interface BuildingBuild {
  /** Local scene `[x, z]` per vertex. */
  positionsXZ: Float32Array;
  /**
   * Unexaggerated ground per vertex — **one value for the whole building**, so
   * the house keeps its metric shape at any exaggeration (contract §0).
   */
  groundY: Float32Array;
  /** True metres above that ground. Never scaled by exaggeration. */
  localY: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  family: MaterialFamily;
}

/** A roof-bearing post of a trestle pair — instanced by the layer. */
export interface PostPlacement {
  x: number;
  z: number;
  groundY: number;
  /** True metres: the post's own height, from the floor to the purlin. */
  heightM: number;
  diameterM: number;
}

export interface HouseBuild {
  parts: BuildingBuild[];
  posts: PostPlacement[];
  /** The ground the whole house is seated on, unexaggerated. */
  groundY: number;
  /** What the geometry ended up being, for the tests and the readout. */
  roof: RoofGeometry;
  aisle: AisleWidth;
}

// ------------------------------------------------------- the §6.H numbers ---

export interface AisleWidth {
  widthM: number;
  /** True where §6.H's two statements of the same rule disagreed — see below. */
  clamped: boolean;
}

/**
 * The central aisle, §6.H's most period-specific number.
 *
 * The card states the *underbalanserad* form twice: as a fraction of the house
 * breadth (~40 %) and as the metric band Göthberg (2000) measured in Mälardalen
 * (1.3–2.8 m). For a Mälardalen house of 5–7 m breadth the two agree. For the
 * 9 m Gene house the fraction wants 3.6 m and the band refuses it, and one of
 * them has to give: **the measured band wins**, because it is the measurement
 * and the fraction is the summary of it. The disagreement is reported rather
 * than smoothed over, because it is exactly the thing §6.H warns about — data
 * from one house sample carried onto another.
 */
export function aisleWidth(widthM: number, fraction: number, band: Range): AisleWidth {
  const wanted = widthM * fraction;
  const clamped = Math.min(band[1], Math.max(band[0], wanted));
  return { widthM: clamped, clamped: Math.abs(clamped - wanted) > 1e-6 };
}

/**
 * Trestle positions along the house, measured from the centre (§6.H).
 *
 * "Trestle spacing is not uniform along the building: it is regular and close in
 * the byre and more varied in the dwelling end, with a large span across the
 * hearth area." So: the byre end is laid out at the *tight* end of the stated
 * band and stays regular; the dwelling end varies across the band; and one bay
 * in the middle of the dwelling is opened out to half again the wide end for the
 * hearth. A uniform row of trestles is the thing this function exists not to be.
 */
export function trestleStations(lengthM: number, spacing: Range, seed: number): number[] {
  const half = lengthM / 2;
  const tight = Math.max(0.8, spacing[0]);
  const wide = Math.max(tight, spacing[1]);
  const random = mulberry32(seed);

  // The byre is at the −u end; the dwelling runs from there to +u.
  const byreEnd = -half + lengthM * HOUSE_DEFAULTS.byreFraction;
  const out: number[] = [];
  let u = -half + tight * 0.5;
  while (u < byreEnd) {
    out.push(u);
    u += tight;
  }

  // The hearth bay sits about a third of the way up the dwelling.
  const hearthAt = byreEnd + (half - byreEnd) * 0.35;
  let hearthDone = false;
  while (u < half - tight * 0.4) {
    out.push(u);
    if (!hearthDone && u >= hearthAt) {
      u += wide * 1.5; // the large span across the hearth area
      hearthDone = true;
    } else {
      u += tight + (wide - tight) * random();
    }
  }
  return out;
}

export interface RoofGeometry {
  /** Height of the ridge above the building's own ground. */
  ridgeY: number;
  /** Half the ridge's length. Zero would be a pyramid, never a gable. */
  ridgeHalfM: number;
  /** Height of the eave edge — below the wall top, because the roof overhangs. */
  eaveY: number;
  /** Half width and half length out to the eave edge. */
  eaveHalfWidthM: number;
  eaveHalfLengthM: number;
  /** Horizontal run of one hip, in from the end eave. */
  hipRunM: number;
  /** The roof's own height, for §6.H's "easily twice the height of the wall". */
  roofHeightM: number;
}

/**
 * The hipped roof, derived from the pitches rather than drawn by eye.
 *
 * The long-side plane passes through the top of the wall at `roofPitchDeg` and
 * meets itself at the ridge; the hip plane rises from the end eave at
 * `hipPitchDeg`, and since that is never shallower than the long sides, its
 * horizontal run in from the end is never longer than half the breadth — which
 * is what keeps the ridge long and the hips steep, the shape §6.H asks for and
 * the one the Eketorp-II houses got wrong.
 */
export function roofGeometry(spec: HouseSpec): RoofGeometry {
  const overhang = HOUSE_DEFAULTS.eavesOverhangM;
  const halfWidth = spec.widthM / 2;
  const halfLength = spec.lengthM / 2;
  const pitch = Math.tan((spec.roofPitchDeg * Math.PI) / 180);
  const hipPitch = Math.tan((Math.max(spec.hipPitchDeg, spec.roofPitchDeg) * Math.PI) / 180);

  const eaveHalfWidthM = halfWidth + overhang;
  const eaveHalfLengthM = halfLength + overhang;
  // The roof plane through the wall head, continued out over the overhang.
  const eaveY = Math.max(0.2, spec.wallHeightM - overhang * pitch);
  const riseFromEave = eaveHalfWidthM * pitch;
  const ridgeY = eaveY + riseFromEave;
  const hipRunM = riseFromEave / hipPitch;
  return {
    ridgeY,
    ridgeHalfM: Math.max(0, eaveHalfLengthM - hipRunM),
    eaveY,
    eaveHalfWidthM,
    eaveHalfLengthM,
    hipRunM,
    roofHeightM: ridgeY - eaveY,
  };
}

/**
 * A compass bearing (0 = N, 90 = Ö) as a rotation in the app's local frame.
 *
 * Re-exported, not re-implemented: the conversion is a property of the frame
 * (`lib/coords`: east = +x, north = −z) and every archetype has to agree on it,
 * so there is exactly one of it in the app. Two correct-but-separate copies are
 * how a stone setting and a longhouse came to draw the same stated bearing at
 * different angles — see `lib/coords.bearingRotation`.
 */
export { bearingRotation } from '../../lib/coords';

/** The four corners of a house's footprint, in local scene coordinates. */
export function footprint(spec: HouseSpec): Array<[number, number]> {
  const cos = Math.cos(spec.rotationRad);
  const sin = Math.sin(spec.rotationRad);
  const a = spec.lengthM / 2;
  const b = spec.widthM / 2;
  return ([
    [a, b],
    [a, -b],
    [-a, -b],
    [-a, b],
  ] as Array<[number, number]>).map(
    ([u, v]) => [spec.x + u * cos - v * sin, spec.z + u * sin + v * cos] as [number, number],
  );
}

/** The radius that contains a house — the spacing test's one number. */
export function houseRadius(lengthM: number, widthM: number): number {
  return Math.hypot(lengthM, widthM) / 2;
}

// ------------------------------------------------------------- the build ----

/** One material family's vertex soup while it is being built. */
class Part {
  readonly positionsXZ: number[] = [];
  readonly localY: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  constructor(readonly family: MaterialFamily) {}

  vertex(x: number, z: number, y: number, c: THREE.Color): number {
    const index = this.localY.length;
    this.positionsXZ.push(x, z);
    this.localY.push(y);
    this.colors.push(c.r, c.g, c.b);
    return index;
  }

  /** Two triangles, wound so `a → b → c → d` runs anticlockwise seen from outside. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  build(groundY: number): BuildingBuild | null {
    if (this.indices.length === 0) return null;
    const ground = new Float32Array(this.localY.length);
    ground.fill(groundY);
    return {
      positionsXZ: new Float32Array(this.positionsXZ),
      groundY: ground,
      localY: new Float32Array(this.localY),
      colors: new Float32Array(this.colors),
      indices: new Uint32Array(this.indices),
      family: this.family,
    };
  }
}

/**
 * Build one building.
 *
 * The house is assembled in its own frame — `u` along the long axis, `v` across
 * it — and rotated into the scene once, so every dimension in the code below is
 * the dimension §6.H names rather than a world coordinate.
 */
export function buildHouse(spec: HouseSpec, options: HouseOptions): HouseBuild {
  const cos = Math.cos(spec.rotationRad);
  const sin = Math.sin(spec.rotationRad);
  const toWorld = (u: number, v: number): [number, number] => [
    spec.x + u * cos - v * sin,
    spec.z + u * sin + v * cos,
  ];

  const roof = roofGeometry(spec);
  const aisle = aisleWidth(spec.widthM, spec.aisleFraction, spec.aisleWidthM);

  // One ground sample for the whole building: the mean over its own footprint.
  // A house floor is level, so this is the height it is level *at*; the footing
  // skirt below covers the ground it stands proud of. Nothing is regraded.
  const half = { u: spec.lengthM / 2, v: spec.widthM / 2 };
  let sum = 0;
  let lowest = Infinity;
  let samples = 0;
  for (let i = -2; i <= 2; i++) {
    for (let j = -1; j <= 1; j++) {
      const [x, z] = toWorld((i / 2) * half.u, (j / 1) * half.v);
      const g = options.groundAt(x, z);
      sum += g;
      lowest = Math.min(lowest, g);
      samples++;
    }
  }
  const groundY = sum / samples;
  // Headroom of 3 covers the ×2.5 exaggeration ceiling, exactly as the rampart's
  // skirt does: at exaggeration e the ground under the low corner falls e times
  // as far below the seat as it does at ×1.
  const skirt = Math.max(0.3, (groundY - lowest) * 3);

  const turf = new Part('turf');
  const daub = new Part('soil');
  const stone = new Part('stone');

  addWalls(spec, { toWorld, turf, daub, stone, skirt });
  addRoof(spec, roof, { toWorld, turf, daub });

  const posts = spec.kind === 'longhouse' ? trestlePosts(spec, roof, aisle, groundY, toWorld) : [];

  const parts: BuildingBuild[] = [];
  for (const part of [turf, daub, stone]) {
    const built = part.build(groundY);
    if (built) parts.push(built);
  }
  return { parts, posts, groundY, roof, aisle };
}

interface WallContext {
  toWorld(u: number, v: number): [number, number];
  turf: Part;
  daub: Part;
  stone: Part;
  skirt: number;
}

/**
 * The walls: a low footing of set stone under wattle-and-daub (§6.H).
 *
 * Both faces are built, because the doorway is a hole in the wall and a visitor
 * standing in it must not see the sky through the far side. The footing reaches
 * `skirt` metres below the seat so a house on a slope stands on stone rather
 * than in mid-air — the one place where the ground the DEM measured and the
 * level floor a building needs have to be reconciled, and it is reconciled by
 * burying more wall, never by moving the ground.
 */
function addWalls(spec: HouseSpec, ctx: WallContext): void {
  const halfU = spec.lengthM / 2;
  const halfV = spec.widthM / 2;
  const thickness = Math.min(HOUSE_DEFAULTS.wallThicknessM, Math.min(halfU, halfV) * 0.2);
  const footing = Math.min(HOUSE_DEFAULTS.footingHeightM, spec.wallHeightM * 0.4);
  const door = Math.min(HOUSE_DEFAULTS.doorwayWidthM, spec.lengthM * 0.25) / 2;
  const doorV = spec.doorSide * halfV;

  /** Stations along one side, dense enough for the daub's patchy shading. */
  const walk = (from: number, to: number): number[] => {
    const steps = Math.max(1, Math.ceil(Math.abs(to - from) / STEP_M));
    return Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);
  };

  /** Move a local point `d` metres toward the building's own centre. */
  const inward = (point: [number, number], d: number): [number, number] => {
    if (d === 0) return point;
    const [u, v] = point;
    return [
      Math.abs(u) > halfU - 1e-6 ? u - Math.sign(u) * d : u,
      Math.abs(v) > halfV - 1e-6 ? v - Math.sign(v) * d : v,
    ];
  };

  /** One vertical band of one wall run, outer face and inner face. */
  const band = (
    run: Array<[number, number]>,
    yLow: number,
    yHigh: number,
    part: Part,
    tone: (x: number, z: number, t: number) => THREE.Color,
  ): void => {
    for (let i = 0; i < run.length - 1; i++) {
      for (const face of [0, 1]) {
        const a = inward(run[i], face * thickness);
        const b = inward(run[i + 1], face * thickness);
        const [ax, az] = ctx.toWorld(a[0], a[1]);
        const [bx, bz] = ctx.toWorld(b[0], b[1]);
        const v0 = part.vertex(ax, az, yLow, tone(ax, az, 0));
        const v1 = part.vertex(bx, bz, yLow, tone(bx, bz, 0));
        const v2 = part.vertex(bx, bz, yHigh, tone(bx, bz, 1));
        const v3 = part.vertex(ax, az, yHigh, tone(ax, az, 1));
        // The inner face is the same wall seen from the other side, so it is
        // wound the other way round.
        if (face === 0) part.quad(v0, v1, v2, v3);
        else part.quad(v3, v2, v1, v0);
      }
    }
  };

  const footingTone = (x: number, z: number): THREE.Color => {
    const cell = stoneCell(spec.seed + 41, x, z, 0.45);
    return colour(SURFACE_COLOURS.footingStone).clone().lerp(colour(SURFACE_COLOURS.settingStoneDark), cell * 0.8);
  };
  const daubTone = (x: number, z: number, t: number): THREE.Color => {
    // §6.H: "pale ochre-grey, patched in different shades where it has been
    // repaired" — so the patches are cell-sized, not a gradient.
    const cell = stoneCell(spec.seed + 977, x, z, 1.3);
    const base = colour(SURFACE_COLOURS.daub).clone().lerp(colour(SURFACE_COLOURS.daubPatch), cell);
    // Rain-splash off the eaves dirties the foot of the wall.
    return t < 0.35 ? base.lerp(colour(SURFACE_COLOURS.daubFoot), (0.35 - t) / 0.35 * 0.6) : base;
  };

  const sides: Array<Array<[number, number]>> = [];
  // The two short ends, then the long side without the door, then the two runs
  // of the door side. Every run is a list of local points along the wall line.
  sides.push(walk(halfV, -halfV).map((v) => [halfU, v] as [number, number]));
  sides.push(walk(-halfV, halfV).map((v) => [-halfU, v] as [number, number]));
  const plainV = -spec.doorSide * halfV;
  sides.push(walk(-halfU, halfU).map((u) => [u, plainV] as [number, number]));
  sides.push(walk(-halfU, -door).map((u) => [u, doorV] as [number, number]));
  sides.push(walk(door, halfU).map((u) => [u, doorV] as [number, number]));

  for (const run of sides) {
    band(run, -ctx.skirt, footing, ctx.stone, footingTone);
    band(run, footing, spec.wallHeightM, ctx.daub, daubTone);
  }

  // The jambs: the wall's own thickness, showing in the doorway. Without them
  // the wall reads as a sheet of paper exactly where a visitor looks closest.
  for (const u of [-door, door]) {
    const [ax, az] = ctx.toWorld(u, doorV);
    const [bx, bz] = ctx.toWorld(u, doorV - Math.sign(doorV) * thickness);
    const v0 = ctx.daub.vertex(ax, az, 0, daubTone(ax, az, 0));
    const v1 = ctx.daub.vertex(bx, bz, 0, daubTone(bx, bz, 0));
    const v2 = ctx.daub.vertex(bx, bz, spec.wallHeightM, daubTone(bx, bz, 1));
    const v3 = ctx.daub.vertex(ax, az, spec.wallHeightM, daubTone(ax, az, 1));
    if (u < 0) ctx.daub.quad(v0, v1, v2, v3);
    else ctx.daub.quad(v3, v2, v1, v0);
  }
}

interface RoofContext {
  toWorld(u: number, v: number): [number, number];
  turf: Part;
  daub: Part;
}

/**
 * The hipped roof: two trapezoids and two hips, and at the top of each hip the
 * small dark board §6.H insists on instead of an open louvre.
 *
 * Each face is a plane — that is what the hip run is derived for — so it is laid
 * out as a grid in (along, up) and the four faces meet exactly along the hips.
 * Only the interior of each grid takes the turf's relief, so the edges stay
 * shared and the roof never opens a seam.
 */
function addRoof(spec: HouseSpec, roof: RoofGeometry, ctx: RoofContext): void {
  const covering = (x: number, z: number, t: number): THREE.Color => {
    // §6.H: "turf over birch bark: green and shaggy … thick enough to read as a
    // slab of the ground lifted onto the house", darker and damper at the eaves.
    const cell = stoneCell(spec.seed + 613, x, z, 0.8);
    const base = colour(SURFACE_COLOURS.roofTurfDark).clone().lerp(colour(SURFACE_COLOURS.roofTurfLight), cell * 0.75 + t * 0.25);
    return t < 0.2 ? base.lerp(colour(SURFACE_COLOURS.roofTurfDamp), (0.2 - t) / 0.2 * 0.7) : base;
  };

  // One row count for all four faces. The hips and the long sides share their
  // whole edge, so a face tessellated on its own would leave a T-junction — a
  // hairline crack down the hip, the classic way a roof like this leaks light.
  const rows = Math.max(
    2,
    Math.ceil(Math.hypot(roof.eaveHalfWidthM, roof.roofHeightM) / STEP_M),
  );

  /**
   * One planar roof face, given its eave edge and its top edge in local (u, v).
   * `t` runs 0 at the eave to 1 at the top; the height is linear in `t` because
   * the face is a plane.
   */
  const face = (
    eaveA: [number, number],
    eaveB: [number, number],
    topA: [number, number],
    topB: [number, number],
  ): void => {
    const spanEave = Math.hypot(eaveB[0] - eaveA[0], eaveB[1] - eaveA[1]);
    const columns = Math.max(2, Math.ceil(spanEave / STEP_M));
    const relief = 0.09; // the depth of a turf sod, roughly

    const grid: number[][] = [];
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const a: [number, number] = [eaveA[0] + (topA[0] - eaveA[0]) * t, eaveA[1] + (topA[1] - eaveA[1]) * t];
      const b: [number, number] = [eaveB[0] + (topB[0] - eaveB[0]) * t, eaveB[1] + (topB[1] - eaveB[1]) * t];
      const y = roof.eaveY + (roof.ridgeY - roof.eaveY) * t;
      const row: number[] = [];
      for (let c = 0; c <= columns; c++) {
        const s = c / columns;
        const u = a[0] + (b[0] - a[0]) * s;
        const v = a[1] + (b[1] - a[1]) * s;
        const [x, z] = ctx.toWorld(u, v);
        // Only the interior lifts, so neighbouring faces keep a shared edge.
        const interior = r > 0 && r < rows && c > 0 && c < columns;
        const lift = interior ? (stoneCell(spec.seed + 29, x, z, 0.8) - 0.5) * relief : 0;
        row.push(ctx.turf.vertex(x, z, y + lift, covering(x, z, t)));
      }
      grid.push(row);
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        ctx.turf.quad(grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]);
      }
    }

    // The underside, one quad, a little inside the covering: smoke-blackened,
    // and there so the roof is not a one-sided sheet seen from the doorway.
    const soot = colour(SURFACE_COLOURS.roofSoot);
    const inner: number[] = [];
    for (const [point, y] of [
      [eaveA, roof.eaveY],
      [eaveB, roof.eaveY],
      [topB, roof.ridgeY],
      [topA, roof.ridgeY],
    ] as Array<[[number, number], number]>) {
      const [x, z] = ctx.toWorld(point[0], point[1]);
      inner.push(ctx.daub.vertex(x, z, y - 0.12, soot));
    }
    ctx.daub.quad(inner[3], inner[2], inner[1], inner[0]);
  };

  const { eaveHalfWidthM: ev, eaveHalfLengthM: eu, ridgeHalfM: ru } = roof;
  // The two long faces: eave line to ridge.
  face([-eu, ev], [eu, ev], [-ru, 0], [ru, 0]);
  face([eu, -ev], [-eu, -ev], [ru, 0], [-ru, 0]);
  // The two hips: end eave line to the ridge end. A degenerate ridge (`ru` = 0)
  // makes this a triangle in a quad's clothing, which is a pyramid — never a
  // gable, because a gable is the one thing §6.H says these roofs did not have.
  face([eu, ev], [eu, -ev], [ru, 0], [ru, 0]);
  face([-eu, -ev], [-eu, ev], [-ru, 0], [-ru, 0]);

  addSmokeVents(roof, ctx);
}

/**
 * The smoke vent: §6.H's "small dark opening — not an open louvre, a board with
 * a hole in it", at the top of each hip, leaking a thin haze of woodsmoke.
 *
 * Näsman's point is that these are reconstructed far too large, so the size here
 * is deliberately smaller than the roof would tempt: two thirds of a metre, laid
 * on the hip a little below the ridge end.
 */
function addSmokeVents(roof: RoofGeometry, ctx: RoofContext): void {
  const [ventU, ventV] = HOUSE_DEFAULTS.smokeVentM;
  if (roof.hipRunM < ventU) return;
  for (const sign of [1, -1] as const) {
    // A point on the hip plane, run in from the ridge end by a fraction of the
    // hip's own length — so the vent sits where the smoke collects.
    const t = 0.82; // just under the ridge
    const u = sign * (roof.ridgeHalfM + (roof.eaveHalfLengthM - roof.ridgeHalfM) * (1 - t));
    const y = roof.eaveY + (roof.ridgeY - roof.eaveY) * t;
    const halfSpanV = Math.max(0.12, roof.eaveHalfWidthM * (1 - t) * 0.8);
    const halfV = Math.min(ventV / 2, halfSpanV);

    /** The board, then the hole in it: two flat plates, the smaller on top. */
    const plate = (halfU: number, halfW: number, lift: number, hex: string): void => {
      const ring = (
        [
          [u - halfU, -halfW],
          [u + halfU, -halfW],
          [u + halfU, halfW],
          [u - halfU, halfW],
        ] as Array<[number, number]>
      ).map(([cu, cv]) => {
        const [x, z] = ctx.toWorld(cu, cv);
        return ctx.daub.vertex(x, z, y + lift, colour(hex));
      });
      // Both windings: the plate lies on a sloping plane and must read from
      // either side of the ridge rather than vanishing on one of them.
      ctx.daub.quad(ring[0], ring[1], ring[2], ring[3]);
      ctx.daub.quad(ring[3], ring[2], ring[1], ring[0]);
    };
    plate(ventU / 2, halfV, 0.05, SURFACE_COLOURS.ventBoard);
    plate(ventU / 5, halfV * 0.4, 0.07, SURFACE_COLOURS.ventHole);
  }
}

/**
 * The trestles — the two rows of roof-bearing posts that make the house
 * *three-aisled*, at the aisle width §6.H fixes and the non-uniform spacing it
 * describes.
 *
 * A post stands where it does its job: it reaches the roof plane at its own
 * distance from the centre line, so the posts carry the purlins rather than
 * stopping short of them. They are visible through the doorway, which is where
 * the aisle a visitor is told about can actually be seen.
 */
function trestlePosts(
  spec: HouseSpec,
  roof: RoofGeometry,
  aisle: AisleWidth,
  groundY: number,
  toWorld: (u: number, v: number) => [number, number],
): PostPlacement[] {
  const v = aisle.widthM / 2;
  const pitch = Math.tan((spec.roofPitchDeg * Math.PI) / 180);
  // Where the post meets the roof plane it is carrying.
  const heightM = Math.max(spec.wallHeightM, roof.ridgeY - v * pitch);
  const out: PostPlacement[] = [];
  for (const u of trestleStations(spec.lengthM, spec.trestleSpacingM, streamSeed(spec.seed, 0x7051))) {
    for (const side of [-1, 1] as const) {
      const [x, z] = toWorld(u, side * v);
      out.push({ x, z, groundY, heightM, diameterM: HOUSE_DEFAULTS.postDiameterM });
    }
  }
  return out;
}
