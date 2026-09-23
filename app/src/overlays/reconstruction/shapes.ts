/**
 * Procedural monument geometry — the one recipe archetypes B–E share.
 *
 * A mound, a stone setting, a cairn and a fire-cracked stone mound are one
 * geometry recipe with different parameters (`docs/reconstruction-mode.md` §4:
 * the grouping rule is *what you build*, not what the register calls it). All
 * four are a **plan outline** swept by a **profile curve**, skinned with a
 * **surface treatment** — and every one of those three comes from the record.
 *
 * Nothing here is a fixed size. The plan form is the one the register names
 * (round, square, rectangular, oval, triangular — §6.C), the diameter and height
 * are the reconstructed ones the §5 transforms produced, the stone calibre is the
 * record's own `0,3-0,5 m st`, and the mesh's own tessellation follows from those
 * so a 3 m stone setting and a 20 m mound are the same code at different
 * resolutions.
 *
 * Output is local to the monument's centre: `[dx, dy, dz]` offsets with `dy` the
 * **true metric height above ground**. The layer adds the centre position and
 * `ground · exaggeration`, which is what keeps the contract §0 invariant — a
 * 2.5 m wall is 2.5 m at ×1 and at ×2.5 — a property of one line rather than of
 * every archetype.
 */

import * as THREE from 'three';
import { bearingRotation } from '../../lib/coords';
import { mulberry32, streamSeed } from '../../lib/random';
import type { Monument, PlanForm, Range } from './schema';

// --------------------------------------------------------------- plan form ---

/**
 * Outline radius at bearing `theta`, for a plan of semi-axes `a` (long) and
 * `b` (short). §6.C: "the recorded form, verbatim" — 41 % of records name it.
 */
export function planRadius(form: PlanForm, a: number, b: number, theta: number): number {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  switch (form) {
    case 'oval':
      // Ellipse in polar form about its centre.
      return (a * b) / Math.hypot(b * cos, a * sin);
    case 'rectangular':
    case 'square': {
      // Axis-aligned rectangle: whichever pair of sides the ray meets first.
      const byX = Math.abs(cos) < 1e-9 ? Infinity : a / Math.abs(cos);
      const byZ = Math.abs(sin) < 1e-9 ? Infinity : b / Math.abs(sin);
      return Math.min(byX, byZ);
    }
    case 'triangular': {
      // Regular 3-gon of circumradius `a`, one vertex "up" (+z).
      const n = 3;
      const step = (2 * Math.PI) / n;
      const phase = ((theta - Math.PI / 2) % step + step) % step;
      return (a * Math.cos(Math.PI / n)) / Math.cos(phase - Math.PI / n);
    }
    default:
      return a;
  }
}

// ----------------------------------------------------------------- profile ---

/** Which §5 shape the reconstruction stands in. Chosen from `profile.transform`. */
export type ProfileKind = 'cap' | 'cone' | 'platform';

/**
 * The profile a monument's own transform implies.
 *
 * This is the geometric half of §5.2's kerb gate, and it is why the two branches
 * must not share a shape: the kerbed branch "restores a smooth spherical cap
 * through the kerb", while the kerbless branch "rebuilds at the material's angle
 * of repose" — a cone. Drawing the cone's dimensions as a cap would inflate its
 * volume by two thirds and quietly undo the conservation the transform is for.
 */
export function profileKind(monument: Monument): ProfileKind {
  const transform = monument.profile.transform;
  if (transform.startsWith('repose-reprofile')) return 'cone';
  if (transform.startsWith('kerb-fixed')) return 'cap';
  // Not inflated (§6.C, §6.E): a low platform that falls away at the rim. A
  // fire-cracked mound accumulated, so it gets the softer cap instead of the
  // stone setting's near-flat floor.
  return monument.archetype === 'fire-cracked-mound' ? 'cap' : 'platform';
}

/** Fraction of the apex radius the cone's rounded top occupies. */
const CONE_APEX = 0.18;

/**
 * Height above ground at normalised radius `t ∈ [0, 1]`, for a monument of
 * base radius `a` and reconstructed height `h`.
 */
export function profileHeight(kind: ProfileKind, t: number, a: number, h: number): number {
  const u = Math.min(1, Math.max(0, t));
  if (h <= 0 || a <= 0) return 0;
  switch (kind) {
    case 'cap': {
      // Spherical cap of base radius `a` and height `h`.
      //
      // The plain formula is only single-valued while the cap is a *minor* one
      // (h ≤ a): past that the sphere's base circle lies on its lower branch,
      // the surface overhangs its own footprint, and the rim stops meeting the
      // ground. Nothing in the corpus is taller than it is wide — the tallest
      // re-profiled mound here is under 5 m at 17 m across — so the honest fix
      // is a hemisphere stretched to the stated height rather than a shape no
      // monument takes.
      const cap = Math.min(h, a);
      const R = (a * a + cap * cap) / (2 * cap);
      const r = u * a;
      return (Math.sqrt(Math.max(0, R * R - r * r)) - (R - cap)) * (h / cap);
    }
    case 'cone': {
      // A cone at the material's repose angle, its apex rounded over the inner
      // `CONE_APEX` of the radius so it reads as built rather than machined.
      // `apex` is scaled so the rounded top still reaches exactly `h`.
      const apex = h / (1 - CONE_APEX / 2);
      if (u >= CONE_APEX) return apex * (1 - u);
      return apex * (1 - CONE_APEX + (CONE_APEX / 2) * (1 - (u / CONE_APEX) ** 2));
    }
    default:
      // §6.C: "much more like a paved floor than a mound" — level, then falling
      // away over the outer fifth to meet the ground at the kerb line.
      return h * (1 - u ** 6);
  }
}

// ---------------------------------------------------------------- surface ----

/**
 * A hashed, jittered cell grid at stone calibre — the cobble field.
 *
 * Displacing the surface by a *per-cell constant* rather than by smooth noise is
 * what makes a stone surface read as laid stone: each cell is a flat-topped
 * cobble with a hard edge against its neighbours, which under `flatShading` is
 * exactly a close-packed stone floor. Smooth noise gives a lumpy blanket.
 *
 * Pure in (x, z, seed), like `lib/noise`: nothing depends on the order cells are
 * visited, so a monument's surface is the same however the scene was built.
 */
export function stoneCell(seed: number, x: number, z: number, sizeM: number): number {
  const cx = Math.floor(x / sizeM);
  const cz = Math.floor(z / sizeM);
  const fold = streamSeed(streamSeed(seed, cx & 0xffff), cz & 0xffff);
  return mulberry32(fold)();
}

/** Midpoint of a `[min, max]` band. */
export function mid(range: Range): number {
  return (range[0] + range[1]) / 2;
}

// ------------------------------------------------------------- the palette ---

/**
 * Surface colours, per archetype. §5.4 is the rule behind all of them: the
 * register's commonest single observation, `övertorvad` (77 %), is a **ruin**
 * state. A monument in use was not turfed over, so the reconstruction strips the
 * turf and moss back off and shows fresh surfaces.
 *
 * Stated as sRGB hex and converted once; the shading is the renderer's business.
 */
export const SURFACE_COLOURS = {
  /** §6.B: laid turf showing the cut edges of stacked turves, over pale subsoil. */
  turfDark: '#5d6b3a',
  turfLight: '#7c8a4c',
  subsoil: '#b3a88c',
  /** §6.D: bare, bright, unweathered stone — "a blazing light-grey dome". */
  cairnStone: '#b7bab4',
  cairnStoneDark: '#93968f',
  /** §6.C: close-laid pale stone, with a contrasting kerb. */
  settingStone: '#a8aba3',
  settingStoneDark: '#8b8e86',
  settingKerb: '#c6c8c0',
  /** §6.E: "the one monument that isn't grey" — heat-reddened, soot-blackened. */
  fireRed: '#9c5a3c',
  fireOrange: '#b8764a',
  fireGrey: '#8d867e',
  fireSoot: '#3a3430',
  /** §7.2: the naked outer face; and the soil-covered inner face and top. */
  rampartStone: '#a5a49c',
  rampartStoneDark: '#807f78',
  rampartSoil: '#6f6a52',
  /** §7.2: dark, glassy, slag-like — individual stones welded into a fused mass. */
  vitrified: '#2f2a2e',
  vitrifiedSheen: '#4b4450',
  /**
   * §6.H, the farmstead. Every one of these is a sentence in the card's "what it
   * looked like": "woven hazel or willow daubed and smoothed with clay, pale
   * ochre-grey, patched in different shades where it has been repaired, standing
   * on a low footing of set stone"; "turf over birch bark: green and shaggy in
   * summer"; "a small dark opening — not an open louvre, a board with a hole".
   */
  daub: '#c2b294',
  daubPatch: '#a8977c',
  daubFoot: '#8e8471',
  footingStone: '#9a9c94',
  roofTurfDark: '#4e5b32',
  roofTurfLight: '#72814a',
  roofTurfDamp: '#3f4a2b',
  roofSoot: '#241f1c',
  ventBoard: '#4a3f31',
  ventHole: '#15120f',
  /** The timber of a roof-bearing post, and the worn ground of a yard. */
  timberPost: '#5a4634',
  yardWorn: '#9b8f78',
  hearthAsh: '#6d6459',
  hearthEmber: '#7d4a33',
  wellStone: '#8f918a',
  wellWater: '#26302f',
} as const;

const colourCache = new Map<string, THREE.Color>();

/** sRGB hex → a cached linear-space `THREE.Color`. */
export function colour(hex: string): THREE.Color {
  let value = colourCache.get(hex);
  if (!value) {
    value = new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
    colourCache.set(hex, value);
  }
  return value;
}

// --------------------------------------------------------- the build itself ---

/** One monument's mesh, local to its own centre. Merged by the layer. */
export interface ShapeBuild {
  /** `[dx, dy, dz]` per vertex; `dy` is true metres above ground. */
  offsets: Float32Array;
  /** Linear-space RGB per vertex. */
  colors: Float32Array;
  indices: Uint32Array;
  /** Which material family the layer batches this into. */
  material: MaterialFamily;
}

export type MaterialFamily = 'turf' | 'stone' | 'fire' | 'soil' | 'vitrified';

export interface ShapeSpec {
  archetype: string;
  form: PlanForm;
  /** Reconstructed base diameter (§5) — not necessarily the recorded one. */
  diameterM: number;
  /** Reconstructed height above ground. */
  heightM: number;
  /** Long/short axes where the record gives a rectangle; else both = diameter. */
  lengthM: number | null;
  widthM: number | null;
  orientationDeg: number | null;
  stoneM: Range;
  kind: ProfileKind;
  seed: number;
}

/** The material family an archetype's surface belongs to. */
export function materialFor(archetype: string): MaterialFamily {
  switch (archetype) {
    case 'mound':
      return 'turf';
    case 'fire-cracked-mound':
      return 'fire';
    default:
      return 'stone';
  }
}

/**
 * Tessellation, derived from the monument rather than fixed.
 *
 * Both counts follow the stone calibre, so the mesh resolves individual cobbles
 * on a 3 m stone setting and does not waste a quarter of a million triangles on
 * a 20 m mound. The clamps are budget, not shape.
 */
export function tessellation(a: number, stoneSize: number): { spokes: number; rings: number } {
  const step = Math.max(0.35, stoneSize * 0.9);
  const spokes = Math.min(48, Math.max(12, Math.round((2 * Math.PI * a) / step / 2) * 2));
  const rings = Math.min(10, Math.max(3, Math.round(a / Math.max(0.6, step))));
  return { spokes, rings };
}

/**
 * Build one monument's surface.
 *
 * The radial grid is a centre vertex plus `rings × spokes`, indexed (so the
 * vertex count stays proportional to area rather than to triangle count) and
 * drawn with `flatShading`, which computes face normals in the fragment shader.
 * That combination is what lets a cobbled surface cost one vertex per cobble
 * instead of three.
 */
export function buildShape(spec: ShapeSpec): ShapeBuild {
  const a = Math.max(0.4, (spec.lengthM ?? spec.diameterM) / 2);
  const b = Math.max(0.3, (spec.widthM ?? spec.diameterM) / 2);
  const height = Math.max(0.02, spec.heightM);
  const stone = Math.max(0.05, mid(spec.stoneM));
  // The record's own bearing, in the app's frame. `bearingRotation` is the one
  // conversion (`lib/coords`), and it has to be: `orientationDeg` is usually a
  // *measured* value — a bearing the KMR record states — and turning the plan by
  // the bearing itself drew a stated N–S monument east–west.
  const rotation = bearingRotation(spec.orientationDeg ?? 0);
  const { spokes, rings } = tessellation(Math.max(a, b), stone);
  const meanRadius = (a + b) / 2;

  const random = mulberry32(spec.seed);
  const family = materialFor(spec.archetype);
  // §6.C: stone settings are "close to perfectly circular" and deliberately
  // selected; a cairn is placed rather than tipped but far rougher. So the rim
  // wobble is per-archetype, not one global "make it look natural" constant.
  const rimJitter = spec.archetype === 'stone-setting' ? 0.02 : spec.archetype === 'cairn' ? 0.07 : 0.05;
  const relief = family === 'turf' ? stone * 0.12 : stone * 0.34;

  const count = 1 + rings * spokes;
  const offsets = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  // Per-spoke rim wobble, drawn once so the outline stays closed and continuous.
  const wobble = new Float32Array(spokes);
  for (let s = 0; s < spokes; s++) wobble[s] = 1 + (random() * 2 - 1) * rimJitter;

  const write = (index: number, x: number, y: number, z: number, c: THREE.Color): void => {
    offsets[index * 3] = x;
    offsets[index * 3 + 1] = y;
    offsets[index * 3 + 2] = z;
    colors[index * 3] = c.r;
    colors[index * 3 + 1] = c.g;
    colors[index * 3 + 2] = c.b;
  };

  const apex = surfaceColour(spec, family, 0, 0, 0, height, stone);
  write(0, 0, height + reliefAt(spec, family, 0, 0, stone, relief, 0), 0, apex);

  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    for (let s = 0; s < spokes; s++) {
      const theta = (s / spokes) * Math.PI * 2;
      const radius = planRadius(spec.form, a, b, theta) * t * wobble[s];
      // The real plan radius, not a normalised 1: a cap's shape is its aspect
      // ratio, so passing a unit radius against a metric height would make every
      // monument taller than 1 m a different shape than the transform intended.
      const local = profileHeight(spec.kind, t, meanRadius, height);
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;
      // Rotate the whole plan onto the record's own orientation.
      const rx = x * Math.cos(rotation) - z * Math.sin(rotation);
      const rz = x * Math.sin(rotation) + z * Math.cos(rotation);
      // The rim meets the ground exactly, so no monument ever hovers or is
      // buried by its own surface noise.
      const edge = r === rings ? 0 : reliefAt(spec, family, rx, rz, stone, relief, t);
      const c = surfaceColour(spec, family, rx, rz, t, height, stone);
      write(1 + (r - 1) * spokes + s, rx, Math.max(0, local + edge), rz, c);
    }
  }

  const triangles = spokes + (rings - 1) * spokes * 2;
  const indices = new Uint32Array(triangles * 3);
  let i = 0;
  for (let s = 0; s < spokes; s++) {
    const next = (s + 1) % spokes;
    indices[i++] = 0;
    indices[i++] = 1 + next;
    indices[i++] = 1 + s;
  }
  for (let r = 1; r < rings; r++) {
    const inner = 1 + (r - 1) * spokes;
    const outer = 1 + r * spokes;
    for (let s = 0; s < spokes; s++) {
      const next = (s + 1) % spokes;
      indices[i++] = inner + s;
      indices[i++] = outer + next;
      indices[i++] = outer + s;
      indices[i++] = inner + s;
      indices[i++] = inner + next;
      indices[i++] = outer + next;
    }
  }

  return { offsets, colors, indices, material: family };
}

/** Per-cobble surface relief. Flat-topped cells, so it reads as laid stone. */
function reliefAt(
  spec: ShapeSpec,
  family: MaterialFamily,
  x: number,
  z: number,
  stone: number,
  amplitude: number,
  t: number,
): number {
  if (amplitude <= 0) return 0;
  const cell = stoneCell(spec.seed, x, z, stone);
  // Turf is laid in courses, so its relief is banded rather than cellular.
  if (family === 'turf') return (Math.sin(t * Math.PI * 6) * 0.5 + cell * 0.5) * amplitude;
  return (cell - 0.5) * 2 * amplitude;
}

/**
 * Surface colour at a point. Every branch traces to a §6 "what it looked like".
 */
function surfaceColour(
  spec: ShapeSpec,
  family: MaterialFamily,
  x: number,
  z: number,
  t: number,
  height: number,
  stone: number,
): THREE.Color {
  const cell = stoneCell(spec.seed + 977, x, z, stone);
  switch (family) {
    case 'turf': {
      // §6.B: stacked turves showing their cut edges in concentric courses, over
      // soil still pale where it came out of the ground. The courses are the
      // tell, so they are geometry-aligned rather than random.
      const course = Math.sin(t * Math.PI * Math.max(3, height * 4)) * 0.5 + 0.5;
      const turf = colour(SURFACE_COLOURS.turfDark).clone().lerp(colour(SURFACE_COLOURS.turfLight), course * 0.7 + cell * 0.3);
      // Raw subsoil shows at the foot, where the build cut into the ground.
      return t > 0.88 ? turf.lerp(colour(SURFACE_COLOURS.subsoil), (t - 0.88) / 0.12 * 0.55) : turf;
    }
    case 'fire': {
      // §6.E: reds, oranges and greys shot through with soot-black. Picked per
      // cobble, because the fragments are individually burnt, not blended.
      const pick = cell;
      if (pick < 0.3) return colour(SURFACE_COLOURS.fireRed);
      if (pick < 0.55) return colour(SURFACE_COLOURS.fireOrange);
      if (pick < 0.82) return colour(SURFACE_COLOURS.fireGrey);
      return colour(SURFACE_COLOURS.fireSoot);
    }
    default: {
      // §6.D: a cairn is bright and unweathered; §6.C: a stone setting is a
      // paler, tighter floor with a contrasting kerb at the rim.
      const isCairn = spec.archetype === 'cairn';
      const light = colour(isCairn ? SURFACE_COLOURS.cairnStone : SURFACE_COLOURS.settingStone);
      const dark = colour(isCairn ? SURFACE_COLOURS.cairnStoneDark : SURFACE_COLOURS.settingStoneDark);
      const base = dark.clone().lerp(light, cell);
      if (!isCairn && t > 0.82) {
        // §6.C: "a light kerb against a dark fill" — the graphic effect the
        // excavators note, where the builders used contrasting material.
        return base.lerp(colour(SURFACE_COLOURS.settingKerb), (t - 0.82) / 0.18);
      }
      return base;
    }
  }
}

/** One kerb or accent stone: where it sits, how big, how it is turned. */
export interface StonePlacement {
  x: number;
  z: number;
  y: number;
  sizeM: number;
  rotation: number;
  tilt: number;
}

/**
 * Kerb stones round the rim (§5.2, §6.C).
 *
 * The kerb is not decoration: it is the feature §5.2 gates the whole re-profiling
 * decision on, and §6.C calls it the thing that makes a stone setting read as
 * deliberate. So it is drawn from its own recorded calibre where the register
 * gives one — `Kantkedja 1,2 m h av 0,7-1,4 m st stenar` — and stands slightly
 * proud, as the excavation reports describe.
 */
export function kerbPlacements(spec: ShapeSpec, kerbStone: Range | null): StonePlacement[] {
  const a = Math.max(0.4, (spec.lengthM ?? spec.diameterM) / 2);
  const b = Math.max(0.3, (spec.widthM ?? spec.diameterM) / 2);
  const size = Math.max(0.15, mid(kerbStone ?? spec.stoneM));
  // The same one conversion the surface uses: a kerb that ran round a plan
  // turned to a different angle than the plan itself would be a new bug.
  const rotation = bearingRotation(spec.orientationDeg ?? 0);
  const random = mulberry32(spec.seed ^ 0x6b3d);

  // One stone per stone-width of perimeter: the kerb is a contiguous chain, which
  // is what `kantkedja` means.
  const perimeter = Math.PI * (a + b);
  const count = Math.max(6, Math.round(perimeter / (size * 1.05)));
  const out: StonePlacement[] = [];
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * Math.PI * 2;
    const radius = planRadius(spec.form, a, b, theta);
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    const jitter = 0.85 + random() * 0.3;
    out.push({
      x: x * Math.cos(rotation) - z * Math.sin(rotation),
      z: x * Math.sin(rotation) + z * Math.cos(rotation),
      // Standing "a little proud" of the surface it bounds.
      y: profileHeight(spec.kind, 1, (a + b) / 2, Math.max(0.02, spec.heightM)) + size * 0.15,
      sizeM: size * jitter,
      rotation: random() * Math.PI * 2,
      tilt: (random() * 2 - 1) * 0.2,
    });
  }
  return out;
}
