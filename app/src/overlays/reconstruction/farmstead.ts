/**
 * Archetype H — where the buildings go (`docs/reconstruction-mode.md` §6.H,
 * §7.5.1; contract §15).
 *
 * `longhouse.ts` builds a house. This module decides how many there are and
 * where they stand, and it is the half of archetype H that has to be most
 * careful, because **the contract carries no coordinates for a building** — a
 * compass sector and a size, deliberately, "because the register does not place
 * them" (§15.3). So:
 *
 *   • **Count, grouping, layout, size and orientation come from the record**
 *     wherever the record states them: Ismantorp's *"Innanför muren är 88
 *     husgrunder, fördelade på två grupper, en yttre med husen radiellt
 *     utgående från murens insida"* is a count, a grouping and a layout in one
 *     sentence, and all three land here as data (`count`, `groups`, `layout`).
 *   • **Position and orientation are otherwise assumed**, and stay visible as
 *     such: §6.H's own table marks building count, position and orientation
 *     Assumed, and that is the honest answer.
 *   • **A stated sector restricts placement and nothing widens it.** "If the
 *     sentence puts houses in the S part of the interior, the sampler places
 *     them there and nowhere else" (§7.5.3).
 *   • **`count` is an upper bound.** "The sampler may place fewer buildings than
 *     a stated count if the extent will not hold them; the shortfall is a
 *     warning, never a silent truncation" (§15.3). Nothing here regrades the
 *     ground to make a house fit: a house that will not sit on the measured
 *     terrain is not placed, and the count says so.
 *   • **Inside a fort there is no yard.** Hearths, wells, yards, fences and
 *     field systems are a farmstead recipe for open ground; inside an enclosure
 *     they are furniture nobody recorded (§7.5.3), so `planInteriorBuildings`
 *     has no features at all and `planFarmstead` draws only the ones
 *     `farm.features` sets — which the pipeline holds all-false inside a fort.
 *
 * Everything random is `lib/random.mulberry32`, folded per building by
 * `streamSeed`, so a reload is byte-identical and adding a building cannot
 * re-roll its neighbours.
 */

import { mulberry32, streamSeed } from '../../lib/random';
import {
  MAX_SLOPE,
  pointInRings,
  ringBounds,
  type LocalRings,
  type SamplerTerrain,
} from './graveField';
import {
  HOUSE_DEFAULTS,
  bearingRotation,
  footprint,
  houseRadius,
  type BuildingBuild,
  type HouseSpec,
} from './longhouse';
import { SURFACE_COLOURS, colour, stoneCell, type MaterialFamily } from './shapes';
import type { BuildingKind, BuildingTemplate, FarmSpec, InteriorBuildings, Range } from './schema';

/** §15.3's compass sectors, as bearings. KMR's own words for part of a place. */
export const SECTOR_BEARINGS: Record<string, number> = {
  N: 0, 'NNÖ': 22.5, 'NÖ': 45, 'ÖNÖ': 67.5,
  'Ö': 90, 'ÖSÖ': 112.5, 'SÖ': 135, 'SSÖ': 157.5,
  S: 180, SSV: 202.5, SV: 225, VSV: 247.5,
  V: 270, VNV: 292.5, NV: 315, NNV: 337.5,
};

/**
 * How wide a stated sector is taken to be, in degrees either side of its
 * bearing. A compass point is 22.5° wide, but KMR's *"i den S delen av
 * borgområdet"* is a **part of a place**, not a direction, and the parts of a
 * small interior are quadrants. Assumed, and the widest thing assumed here.
 */
export const SECTOR_HALF_WIDTH_DEG = 45;

/**
 * Clear ground kept between two buildings, in metres. Deliberately tight.
 *
 * Assumed, and it matters twice over. A radial group packs houses shoulder to
 * shoulder along the wall, so the spacing test has to be on the **footprints**
 * and not on the circles around them — a 12 × 4 m house inside its 13 m circle
 * would push its neighbours 16 m away and thin Ismantorp's 88 houses to a dozen.
 * And the count is the record's: a generous alley between houses would refuse
 * buildings the register states are there, which is the wrong way to be wrong.
 * An `husgrund` ringfort's houses stand within a metre of each other.
 */
export const BUILDING_GAP_M = 0.6;
/**
 * Clear ground kept between a building and the edge of the ground it may stand
 * on, where the caller states no better number.
 *
 * The caller usually can: a fort's §3 extent polygon reaches to the **outside**
 * of its collapsed wall — at Broborg the extent is ~93 m across and the measured
 * crest ring inside it is ~65 m — so "against the inner wall face" (§7.5.1) is
 * measured from the crest, not from the extent, and the layer passes the inset
 * that says so.
 */
export const EDGE_CLEARANCE_M = 1.5;

/**
 * The §6.H literature defaults, for a `buildings` block that carries no template
 * of its own. Identical to `reconstruct.FARMSTEAD_DEFAULTS` — the same numbers
 * from the same card — and tagged `assumed` in every tier, because they are.
 */
export const FALLBACK_TEMPLATE: BuildingTemplate = {
  kind: 'longhouse',
  count: 1,
  lengthM: [20, 40],
  widthM: [6, 8],
  orientationDeg: null,
  aisleFraction: 0.4,
  aisleWidthM: [1.3, 2.8],
  wallHeightM: 1.2,
  roofForm: 'hipped',
  roofPitchDeg: 45,
  hipPitchDeg: 48,
  smokeVent: 'board-with-hole',
  covering: 'turf-over-birch-bark',
  walls: 'wattle-and-daub-on-stone-footing',
  trestleSpacingM: [2, 3],
  source: 'assumed',
  tiers: { plan: 'assumed', profile: 'derived', surface: 'assumed' },
};

/**
 * The file's own `defaults.farmstead` block (§15), as a template.
 *
 * §15 publishes those defaults "so the app can expose them as tunables, exactly
 * as `defaults.mound` already is", so where a `buildings` block carries no
 * template of its own the numbers come from the file rather than from this
 * module's copy of them. The two §6.H invariants are re-imposed on the way
 * through, because `defaults` is a tunable and a tunable can be turned wrong:
 * a wall under a metre is the Lojsta error and a hip shallower than the long
 * sides is the Eketorp-II one.
 */
export function templateFromDefaults(defaults: unknown): BuildingTemplate {
  if (typeof defaults !== 'object' || defaults === null) return FALLBACK_TEMPLATE;
  const block = defaults as Record<string, unknown>;
  const band = (value: unknown, fallback: Range): Range =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
    value[0] <= value[1]
      ? [value[0] as number, value[1] as number]
      : fallback;
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const roofPitchDeg = number(block['roofPitchDeg'], FALLBACK_TEMPLATE.roofPitchDeg);
  return {
    ...FALLBACK_TEMPLATE,
    lengthM: band(block['lengthM'], FALLBACK_TEMPLATE.lengthM),
    widthM: band(block['widthM'], FALLBACK_TEMPLATE.widthM),
    aisleFraction: Math.min(
      0.6,
      Math.max(0.3, number(block['aisleFraction'], FALLBACK_TEMPLATE.aisleFraction)),
    ),
    wallHeightM: Math.max(1.0, number(block['wallHeightM'], FALLBACK_TEMPLATE.wallHeightM)),
    roofPitchDeg,
    hipPitchDeg: Math.max(roofPitchDeg, number(block['hipPitchDeg'], FALLBACK_TEMPLATE.hipPitchDeg)),
  };
}

/** An outdoor feature of a farmstead's yard. Never drawn inside a fort (§7.5.3). */
export interface YardFeature {
  kind: 'yard' | 'hearth' | 'well';
  x: number;
  z: number;
  radiusM: number;
}

export interface FarmPlan {
  buildings: HouseSpec[];
  features: YardFeature[];
  /** What the record (or the archetype default) asked for. */
  requested: number;
  /** Never a silent truncation (§15.3). */
  warnings: string[];
}

// ------------------------------------------------------------ one building --

/**
 * One building's dimensions, drawn from the template's stated bands.
 *
 * Length and width come from **one** shared draw, as the grave-field sampler
 * does: a house at the long end of a 12–14 m band is at the wide end of its
 * 4–6 m band too. Two independent draws would produce proportions the band
 * never described.
 */
export function houseFromTemplate(
  template: BuildingTemplate,
  kind: BuildingKind,
  seed: number,
): Omit<HouseSpec, 'x' | 'z' | 'rotationRad' | 'doorSide'> {
  const random = mulberry32(seed);
  const u = random();
  const size = (band: Range): number => band[0] + (band[1] - band[0]) * u;
  // §6.H: the farm is not a single building. A workshop or store is the same
  // recipe at the small end of it, and a `grophus` smaller again — both of them
  // archetype defaults, since no record measures them.
  const scale = kind === 'longhouse' ? 1 : kind === 'ancillary' ? 0.42 : 0.22;
  const lengthM = Math.max(2.5, size(template.lengthM) * scale);
  const widthM = Math.max(2.0, Math.min(size(template.widthM) * (kind === 'longhouse' ? 1 : 0.75), lengthM * 0.9));
  return {
    kind,
    lengthM,
    widthM,
    wallHeightM: template.wallHeightM,
    roofPitchDeg: template.roofPitchDeg,
    hipPitchDeg: template.hipPitchDeg,
    aisleFraction: template.aisleFraction,
    aisleWidthM: template.aisleWidthM,
    trestleSpacingM: template.trestleSpacingM,
    seed,
  };
}

// ---------------------------------------------------------------- helpers ---

export function centroidOf(rings: LocalRings): [number, number] {
  const ring = rings[0] ?? [];
  let x = 0;
  let z = 0;
  for (const [px, pz] of ring) {
    x += px;
    z += pz;
  }
  return ring.length ? [x / ring.length, z / ring.length] : [0, 0];
}

/** How far the extent reaches from `[cx, cz]` along a unit direction. */
export function reachAlong(
  rings: LocalRings,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
  maxR: number,
): number {
  let inside = 0;
  const step = Math.max(0.5, maxR / 200);
  for (let r = step; r <= maxR; r += step) {
    if (!pointInRings(rings, cx + dx * r, cz + dz * r)) break;
    inside = r;
  }
  return inside;
}

/** Is this a spot a building can stand on — inside, dry, and not a scarp? */
export function standable(spec: HouseSpec, rings: LocalRings | null, terrain: SamplerTerrain): boolean {
  if (rings) {
    for (const [x, z] of footprint(spec)) if (!pointInRings(rings, x, z)) return false;
  }
  if (terrain.classAt && terrain.isWet(terrain.classAt(spec.x, spec.z))) return false;
  // §7.5.3: "any regrading of the measured interior to seat a building" is
  // refused. So a slope a house cannot stand on is a house that is not placed.
  const step = 2;
  const slope = Math.max(
    Math.abs(terrain.groundAt(spec.x + step, spec.z) - terrain.groundAt(spec.x - step, spec.z)) / (2 * step),
    Math.abs(terrain.groundAt(spec.x, spec.z + step) - terrain.groundAt(spec.x, spec.z - step)) / (2 * step),
  );
  return slope <= MAX_SLOPE;
}

/**
 * Do two buildings' footprints clash, allowing for the gap between them?
 *
 * Separating axes on the two rectangles: a longhouse is long and thin, and two
 * of them standing side by side along a wall are metres apart across and metres
 * *overlapping* end to end, which is what a circle test cannot see.
 */
export function footprintsClash(a: HouseSpec, b: HouseSpec, gapM: number): boolean {
  const boxes = [a, b].map((spec) => ({
    cx: spec.x,
    cz: spec.z,
    axes: [
      [Math.cos(spec.rotationRad), Math.sin(spec.rotationRad)],
      [-Math.sin(spec.rotationRad), Math.cos(spec.rotationRad)],
    ],
    half: [spec.lengthM / 2 + gapM / 2, spec.widthM / 2 + gapM / 2],
  }));
  const dx = boxes[1].cx - boxes[0].cx;
  const dz = boxes[1].cz - boxes[0].cz;
  for (const box of boxes) {
    for (const axis of box.axes) {
      const distance = Math.abs(dx * axis[0] + dz * axis[1]);
      let reach = 0;
      for (const other of boxes) {
        for (let i = 0; i < 2; i++) {
          reach += other.half[i] * Math.abs(other.axes[i][0] * axis[0] + other.axes[i][1] * axis[1]);
        }
      }
      if (distance >= reach) return false; // a separating axis: no clash
    }
  }
  return true;
}

export function clear(spec: HouseSpec, placed: HouseSpec[]): boolean {
  const radius = houseRadius(spec.lengthM, spec.widthM);
  for (const other of placed) {
    // Cheap circle rejection first; the exact test only for what it lets through.
    const far = radius + houseRadius(other.lengthM, other.widthM) + BUILDING_GAP_M;
    if ((spec.x - other.x) ** 2 + (spec.z - other.z) ** 2 > far * far) continue;
    if (footprintsClash(spec, other, BUILDING_GAP_M)) return false;
  }
  return true;
}

/** Does a bearing fall inside the sector the record states? */
export function inSector(bearingDeg: number, sector: string | null): boolean {
  if (!sector) return true;
  const centre = SECTOR_BEARINGS[sector];
  if (centre === undefined) return true;
  // The signed difference between two bearings, folded into ±180°.
  const delta = Math.abs(((bearingDeg - centre + 540) % 360) - 180);
  return delta <= SECTOR_HALF_WIDTH_DEG;
}

/** Compass bearing of a local direction (`lib/coords`: east = +x, north = −z). */
function bearingOf(dx: number, dz: number): number {
  return (Math.atan2(dx, -dz) * 180) / Math.PI;
}

// ------------------------------------------------- the fort interior (§7.5) --

/**
 * Place a fort interior's buildings inside its own extent polygon.
 *
 * The three layouts are the three the record distinguishes (§15.1):
 *
 *   • `radial` — "en yttre med husen radiellt utgående från murens insida": the
 *     houses stand against the inner wall face with their long axis pointing at
 *     the middle. `groups` makes that two concentric rings rather than one.
 *   • `grouped` — the record states a number of groups but not radial houses.
 *   • `free` — the record attests houses and says nothing about their
 *     arrangement, so they are scattered, and the popup says the arrangement is
 *     assumed.
 */
export function planInteriorBuildings(
  buildings: InteriorBuildings,
  rings: LocalRings,
  terrain: SamplerTerrain,
  seed: number,
  defaults?: unknown,
  edgeInsetM = EDGE_CLEARANCE_M,
): FarmPlan {
  const template = buildings.template ?? templateFromDefaults(defaults);
  // §15.1: `count: null` is "the record attests houses but states no number", so
  // the archetype default is one house — `countSource` already reads `assumed`.
  const requested = Math.max(1, Math.round(buildings.count ?? 1));
  const bounds = ringBounds(rings);
  if (!bounds) return { buildings: [], features: [], requested, warnings: [] };
  const [cx, cz] = centroidOf(rings);
  const maxR = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const groups = Math.max(1, Math.round(buildings.groups ?? 1));
  // A stated sector does not thin the houses out round the whole interior — it
  // is where they are, and nowhere else (§7.5.3). So the arc they stand along is
  // the sector's when the record states one, and the whole circle when not.
  const arcCentre = buildings.sector ? (SECTOR_BEARINGS[buildings.sector] ?? 0) : 0;
  const arcWidth = buildings.sector ? SECTOR_HALF_WIDTH_DEG * 2 : 360;

  const placed: HouseSpec[] = [];
  /** The next house's own dimensions — one seeded draw per building placed. */
  const next = (index: number): Omit<HouseSpec, 'x' | 'z' | 'rotationRad' | 'doorSide'> =>
    houseFromTemplate(template, 'longhouse', streamSeed(seed, index));

  if (buildings.layout === 'radial') {
    // "En yttre med husen radiellt utgående från murens insida": walk the arc
    // and set each house down beside the last, rather than at a fixed slot —
    // the houses stand shoulder to shoulder along the wall, and how many of them
    // fit is a fact about the extent rather than a division sum.
    const perRing = Math.ceil(requested / groups);
    for (let ring = 0; ring < groups && placed.length < requested; ring++) {
      let inRing = 0;
      let bearing = arcCentre - arcWidth / 2 + (ring % 2) * 3;
      const limit = arcCentre - arcWidth / 2 + arcWidth;
      // A whole-circle arc closes on itself, so the last house must not overlap
      // the first: it stops a hair short rather than wrapping past it.
      while (inRing < perRing && placed.length < requested && bearing < limit - 1e-6) {
        const base = next(placed.length);
        const dx = Math.sin((bearing * Math.PI) / 180);
        const dz = -Math.cos((bearing * Math.PI) / 180);
        // Each ring stands one house-length further in than the one outside it.
        const inset = ring * (base.lengthM + 2);
        // The extent is reached along the house's own corners, not only along
        // its axis: a wall that curves away between them would otherwise put the
        // corners of a 12 m house outside a boundary its middle clears.
        const axial = reachAlong(rings, cx, cz, dx, dz, maxR);
        const guess = axial - edgeInsetM - base.lengthM / 2 - inset;
        const spanDeg =
          guess > 1 ? (Math.atan2(base.widthM / 2, guess) * 180) / Math.PI : 0;
        const reach = Math.min(
          axial,
          ...[-spanDeg, spanDeg].map((offset) => {
            const angle = ((bearing + offset) * Math.PI) / 180;
            return reachAlong(rings, cx, cz, Math.sin(angle), -Math.cos(angle), maxR);
          }),
        );
        const radius = reach - edgeInsetM - base.lengthM / 2 - inset;
        // How far round the wall to the next house: the angle this one subtends
        // at its **inner** end, which is where radial houses converge and touch.
        // Spacing them on their centres would set their inner corners into one
        // another. Neighbours differ in width, so this is a starting guess; the
        // footprint test below is the authority and a refused bearing creeps.
        const innerRadius = Math.max(2, radius - base.lengthM / 2);
        const step =
          (Math.atan((base.widthM + BUILDING_GAP_M) / 2 / innerRadius) * 2 * 180) / Math.PI;
        if (radius > base.lengthM * 0.2) {
          const spec: HouseSpec = {
            ...base,
            x: cx + dx * radius,
            z: cz + dz * radius,
            // Radial: the long axis points at the middle of the interior.
            rotationRad: Math.atan2(dz, dx),
            doorSide: 1,
          };
          if (standable(spec, rings, terrain) && clear(spec, placed)) {
            placed.push(spec);
            inRing++;
            bearing += Math.max(1, step);
            continue;
          }
        }
        // Nothing stood here: creep round rather than skipping a whole slot, so
        // a neighbour a metre wider than its predecessor costs a metre of wall
        // and not a house.
        bearing += 1.5;
      }
    }
  } else {
    for (let i = 0; i < requested; i++) {
      const base = next(i);
      const random = mulberry32(streamSeed(streamSeed(seed, i), 0x51a7));
      // Grouped and free differ only in where the candidates come from: a
      // cluster centre per group, or the whole interior.
      const group = i % groups;
      const groupBearing = arcCentre + (((group + 0.5) / groups) * arcWidth - arcWidth / 2);
      const cluster =
        buildings.layout === 'grouped'
          ? {
              x: cx + Math.sin((groupBearing * Math.PI) / 180) * maxR * 0.22,
              z: cz - Math.cos((groupBearing * Math.PI) / 180) * maxR * 0.22,
              spread: maxR * 0.2,
            }
          : { x: cx, z: cz, spread: maxR * 0.5 };
      // A stated orientation is the record's; without one the bearing is drawn
      // from the seed, and the popup says the orientation is assumed.
      const rotation =
        template.orientationDeg !== null
          ? bearingRotation(template.orientationDeg)
          : bearingRotation(buildings.layout === 'grouped' ? groupBearing + 90 : random() * 180);
      for (let attempt = 0; attempt < 48; attempt++) {
        const angle = random() * Math.PI * 2;
        const distance = Math.sqrt(random()) * cluster.spread;
        const x = cluster.x + Math.cos(angle) * distance;
        const z = cluster.z + Math.sin(angle) * distance;
        if (!inSector(bearingOf(x - cx, z - cz), buildings.sector)) continue;
        const spec: HouseSpec = { ...base, x, z, rotationRad: rotation, doorSide: 1 };
        if (!standable(spec, rings, terrain) || !clear(spec, placed)) continue;
        placed.push(spec);
        break;
      }
    }
  }

  const warnings: string[] = [];
  if (placed.length < requested) {
    warnings.push(
      `${placed.length} of ${requested} buildings placed: the rest had nowhere inside the ` +
        'extent to stand on the measured ground. The count is an upper bound, and the terrain ' +
        'is not regraded to meet it.',
    );
  }
  return { buildings: placed, features: [], requested, warnings };
}

// ---------------------------------------------------- the open-ground farm --

/**
 * §6.H's yard layout heuristic, for a `farm` block outside a fort.
 *
 * "The general layout is a yard in front of the houses, an outdoor hearth area,
 * a well, and enclosures and fields beyond", and at Gene the excavated farm is a
 * large longhouse **plus workshop and store**. So: the longhouse on the record's
 * own point, its doorway onto a yard, the ancillary buildings and the `grophus`
 * round that yard, the hearth in it and the well at its edge.
 *
 * Every one of those positions is **assumed** — §6.H's table says so in as many
 * words — and the enclosure of "a fence and the fields beyond" is not drawn at
 * all: there is nothing to derive its line from, and a fence drawn at a guess
 * would be the one thing in the scene claiming to know where a boundary ran.
 */
export function planFarmstead(
  farm: FarmSpec,
  position: { x: number; z: number },
  orientationDeg: number | null,
  rings: LocalRings | null,
  terrain: SamplerTerrain,
  seed: number,
  defaults?: unknown,
): FarmPlan {
  const templates = farm.buildings.length ? farm.buildings : [templateFromDefaults(defaults)];
  const main = templates.find((t) => t.kind === 'longhouse') ?? templates[0];
  const random = mulberry32(streamSeed(seed, 0x4a2d));
  // The long axis: the record's own where it states one, and otherwise a
  // bearing drawn from the seed — assumed, and labelled assumed in the data.
  const bearing = orientationDeg ?? main.orientationDeg ?? random() * 180;
  const rotation = bearingRotation(bearing);

  const house: HouseSpec = {
    ...houseFromTemplate(main, 'longhouse', streamSeed(seed, 1)),
    x: position.x,
    z: position.z,
    rotationRad: rotation,
    doorSide: 1,
  };
  const placed: HouseSpec[] = [house];
  const warnings: string[] = [];
  let requested = 1;

  // The yard is on the doorway side of the longhouse, which is where §6.H puts
  // it: "a wide doorway in the middle of the long side, ground worn bare in
  // front of it, an open yard packed hard by feet and hooves".
  const across = { x: -Math.sin(rotation), z: Math.cos(rotation) };
  const yardRadius = Math.max(6, house.lengthM * 0.35);
  const yard = {
    x: house.x + across.x * (house.widthM / 2 + yardRadius * 0.8),
    z: house.z + across.z * (house.widthM / 2 + yardRadius * 0.8),
  };

  // Workshop, store and the sunken-floored workshop, set round the yard.
  const around: Array<{ kind: BuildingKind; template: BuildingTemplate }> = [];
  for (const template of templates) {
    if (template.kind === 'longhouse') continue;
    for (let i = 0; i < Math.max(1, Math.round(template.count)); i++) {
      around.push({ kind: template.kind, template });
    }
  }
  requested += around.length;

  around.forEach((entry, i) => {
    // Set out round the yard, away from the longhouse's own side of it, and
    // stepped outward if the yard is too tight to take them all.
    const angle = ((i + 1) / (around.length + 1)) * Math.PI * 1.4 - Math.PI * 0.7;
    const dirX = across.x * Math.cos(angle) - across.z * Math.sin(angle);
    const dirZ = across.x * Math.sin(angle) + across.z * Math.cos(angle);
    const base = houseFromTemplate(entry.template, entry.kind, streamSeed(seed, 10 + i));
    for (const factor of [1.15, 1.5, 1.9, 2.4]) {
      const radius = yardRadius * factor;
      const candidate: HouseSpec = {
        ...base,
        x: yard.x + dirX * radius,
        z: yard.z + dirZ * radius,
        // Ancillary buildings face the yard, like the longhouse does.
        rotationRad: Math.atan2(-dirZ, -dirX) + Math.PI / 2,
        doorSide: -1,
      };
      if (standable(candidate, rings, terrain) && clear(candidate, placed)) {
        placed.push(candidate);
        break;
      }
    }
  });

  if (placed.length < requested) {
    warnings.push(
      `${placed.length} of ${requested} buildings placed: the rest had nowhere level and dry ` +
        'enough to stand. The terrain is measured and is not regraded to seat a building.',
    );
  }

  // §7.5.3: "hearths, wells, yards, fences, paths and field systems inside the
  // wall" are refused outright. A record the pipeline placed inside a fort gets
  // its buildings and nothing else, however its own block is filled in.
  if (farm.insideFortId) {
    return { buildings: placed, features: [], requested, warnings };
  }
  const features: YardFeature[] = [{ kind: 'yard', x: yard.x, z: yard.z, radiusM: yardRadius }];
  if (farm.features.hearth) {
    features.push({ kind: 'hearth', x: yard.x + across.x * 1.5, z: yard.z + across.z * 1.5, radiusM: 1.0 });
  }
  if (farm.features.well) {
    const wellAt = yardRadius * 1.5;
    features.push({ kind: 'well', x: yard.x + across.x * wellAt, z: yard.z + across.z * wellAt, radiusM: 0.8 });
  }
  return { buildings: placed, features, requested, warnings };
}

// ------------------------------------------------------- the yard features --

/**
 * A yard feature's mesh: a disc that **drapes** on the measured ground.
 *
 * Unlike a building, which is rigid and seated on one ground sample, a worn yard
 * or a hearth is part of the surface, so every vertex takes its own ground and
 * the whole thing follows the terrain at any exaggeration.
 */
export function buildYardFeature(
  feature: YardFeature,
  groundAt: (x: number, z: number) => number,
  seed: number,
): BuildingBuild {
  const spokes = 18;
  const rings = feature.kind === 'yard' ? 3 : 4;
  const family: MaterialFamily = feature.kind === 'yard' ? 'soil' : 'stone';

  const positionsXZ: number[] = [];
  const groundY: number[] = [];
  const localY: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // Every profile comes back to the ground at its own rim, so a feature never
  // stands on a lip of nothing — the same rule `shapes.buildShape` keeps.
  const profile = (t: number): number => {
    if (t >= 0.999) return 0;
    switch (feature.kind) {
      // A well: a stone curb standing about a third of a metre, dark inside.
      case 'well':
        return t < 0.5 ? -0.1 : 0.35;
      // A hearth: ash and embers in a low ring of set stone.
      case 'hearth':
        return t < 0.5 ? 0.03 : 0.18;
      default:
        // A yard: ground packed hard by feet and hooves, barely raised at all.
        return 0.02 * (1 - t);
    }
  };
  const tone = (t: number, x: number, z: number): [number, number, number] => {
    const cell = stoneCell(seed + 7, x, z, feature.kind === 'yard' ? 1.2 : 0.35);
    const c =
      feature.kind === 'well'
        ? t < 0.5
          ? colour(SURFACE_COLOURS.wellWater)
          : colour(SURFACE_COLOURS.wellStone).clone().lerp(colour(SURFACE_COLOURS.settingStoneDark), cell)
        : feature.kind === 'hearth'
          ? t < 0.5
            ? colour(SURFACE_COLOURS.hearthAsh).clone().lerp(colour(SURFACE_COLOURS.hearthEmber), cell * 0.8)
            : colour(SURFACE_COLOURS.wellStone)
          : colour(SURFACE_COLOURS.yardWorn).clone().lerp(colour(SURFACE_COLOURS.subsoil), cell * 0.5);
    return [c.r, c.g, c.b];
  };

  const push = (x: number, z: number, t: number): number => {
    const index = localY.length;
    positionsXZ.push(x, z);
    groundY.push(groundAt(x, z));
    localY.push(profile(t));
    colors.push(...tone(t, x, z));
    return index;
  };

  const centre = push(feature.x, feature.z, 0);
  const grid: number[][] = [];
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    const row: number[] = [];
    for (let s = 0; s < spokes; s++) {
      const theta = (s / spokes) * Math.PI * 2;
      row.push(
        push(
          feature.x + Math.cos(theta) * feature.radiusM * t,
          feature.z + Math.sin(theta) * feature.radiusM * t,
          t,
        ),
      );
    }
    grid.push(row);
  }
  for (let s = 0; s < spokes; s++) {
    const next = (s + 1) % spokes;
    indices.push(centre, grid[0][next], grid[0][s]);
    for (let r = 0; r < rings - 1; r++) {
      indices.push(grid[r][s], grid[r + 1][next], grid[r + 1][s]);
      indices.push(grid[r][s], grid[r][next], grid[r + 1][next]);
    }
  }

  return {
    positionsXZ: new Float32Array(positionsXZ),
    groundY: new Float32Array(groundY),
    localY: new Float32Array(localY),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    family,
  };
}

/** Exported for the tests: the defaults this module applies when data is silent. */
export const FARMSTEAD_LAYOUT = {
  buildingGapM: BUILDING_GAP_M,
  edgeClearanceM: EDGE_CLEARANCE_M,
  sectorHalfWidthDeg: SECTOR_HALF_WIDTH_DEG,
  postDiameterM: HOUSE_DEFAULTS.postDiameterM,
} as const;
