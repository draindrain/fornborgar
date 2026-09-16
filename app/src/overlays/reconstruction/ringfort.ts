/**
 * §7.5.2's Öland / Gotland branch — the limestone ringfort interior.
 *
 * **Why this exists.** The Öland and Gotland ringforts are a *different building
 * tradition* from a Mälardalen boulder rampart (`docs/reconstruction-mode.md`
 * §6.A, §7.5.2), and the one thing they must not do is render as an empty
 * mainland enclosure. Ismantorp is 127 m across with **88** house foundations in
 * radial blocks round a central open space; Eketorp II is ~80 m across with 53
 * internal cells. The survey measured the island rate at 12.3 % against the
 * mainland's 3.4 % — a real typological signal across **106** forts.
 *
 * **What it is not.** It is a *layout and parameter* branch, never a lower gate.
 * No fort is offered the `settlement` state for standing on limestone: that is
 * decided in the pipeline by §7.5.2's gate, which is identical everywhere, and
 * this module is only ever reached for a fort that already passed it. And the
 * branch is taken on `interior.tradition`, so a mainland fort's layout is the
 * one `farmstead.planInteriorBuildings` already draws, byte for byte —
 * `planFortInterior` below is the only place the two ever meet.
 *
 * **What it draws, and where each part of it comes from.**
 *
 *   • **The outer group, radial against the inner wall face.** Ismantorp: *"en
 *     yttre med husen radiellt utgående från murens insida"*. Measured.
 *   • **The inner group, cut into blocks by streets.** Ismantorp: *"en inre, mer
 *     oregelbunden grupp, genom fyra gator uppdelade i lika många kvarter"* —
 *     `buildings.blocks`, parsed. Where the record states no block count no
 *     streets are drawn, which is the normal case nationally.
 *   • **The ring street between the two groups.** Ismantorp: *"De båda
 *     husgrupperna skiljs av en 2-5 m br ringgata"* — `buildings.streetWidthM`,
 *     parsed. Where it is unstated the app assumes {@link ASSUMED_STREET_M} and
 *     the pipeline has already named `buildings.streetWidthM` in `fallbacks`, so
 *     the panel says which of the two the visitor is looking at.
 *   • **The central open space** is not a parameter. It is what is left when the
 *     groups the record states have been laid against the wall, and giving it a
 *     radius of its own would be the app asserting a measurement nobody made.
 *
 * **Two things it deliberately refuses.**
 *
 *   • Ismantorp's inner group is *"mer oregelbunden"* — more irregular — and this
 *     draws it as regularly as the outer one, because there is nothing in the
 *     record to derive the irregularity *from*. A jitter that looked right would
 *     be invented, so the methods panel says the app has drawn it regular rather
 *     than the geometry implying it was.
 *   • Eketorp's record places seven of its houses *"på borggårdens mitt"*, in the
 *     middle of the courtyard. That is not parsed and is not drawn: a per-house
 *     position is exactly what contract §15.3 refuses to carry.
 *
 * **The count is still an upper bound.** §15.3, and §3's rule stands unchanged:
 * a house that will not sit on the measured terrain is not placed, the terrain is
 * not regraded to meet the record, and the shortfall is a warning. A radial block
 * layout fits more houses than a scatter does — that is a fact about the layout,
 * not a licence to reach 88.
 */

import { streamSeed } from '../../lib/random';
import {
  BUILDING_GAP_M,
  EDGE_CLEARANCE_M,
  SECTOR_BEARINGS,
  SECTOR_HALF_WIDTH_DEG,
  centroidOf,
  clear,
  houseFromTemplate,
  planInteriorBuildings,
  reachAlong,
  standable,
  templateFromDefaults,
  type FarmPlan,
} from './farmstead';
import { ringBounds, type LocalRings, type SamplerTerrain } from './graveField';
import type { HouseSpec } from './longhouse';
import type { InteriorBuildings, InteriorTradition } from './schema';

/**
 * The gap assumed between two groups where the record does not measure one, in
 * metres.
 *
 * Assumed, and the only number this module invents. It is the width the previous
 * generic radial layout already used between its rings, kept rather than changed
 * so a fort that states no street width is drawn exactly as it was before this
 * branch existed. The pipeline names `buildings.streetWidthM` in `fallbacks`
 * whenever it is reached, so nothing here is silent.
 */
export const ASSUMED_STREET_M = 2;

/** The mid of a stated range — the app's usual reading of a `[lo, hi]` band. */
function mid(band: readonly number[] | null | undefined): number | null {
  if (!band || band.length !== 2) return null;
  return (band[0] + band[1]) / 2;
}

/** How many degrees `metres` subtends at `radius`. A street is a gap on the ground. */
function degreesFor(metres: number, radius: number): number {
  if (!(radius > 0.5)) return 0;
  return (Math.atan2(metres / 2, radius) * 2 * 180) / Math.PI;
}

/**
 * §7.5's entry point for a fort interior: the branch, and nothing else.
 *
 * The mainland path is `farmstead.planInteriorBuildings` called with exactly the
 * arguments it was called with before — not a re-implementation of it, so a
 * mainland fort cannot drift when this branch is edited.
 */
export function planFortInterior(
  tradition: InteriorTradition,
  buildings: InteriorBuildings,
  rings: LocalRings,
  terrain: SamplerTerrain,
  seed: number,
  defaults?: unknown,
  edgeInsetM = EDGE_CLEARANCE_M,
): FarmPlan {
  if (tradition === 'limestone-ringfort' && buildings.layout === 'radial') {
    return planRingfortInterior(buildings, rings, terrain, seed, defaults, edgeInsetM);
  }
  return planInteriorBuildings(buildings, rings, terrain, seed, defaults, edgeInsetM);
}

/**
 * The radial-block layout: concentric groups against the inner wall face, the
 * inner ones cut into the blocks the record states.
 *
 * Each group walks its arc and sets a house down beside the last rather than at
 * a fixed slot, so how many fit is a fact about the measured interior and not a
 * division sum. A ring is stepped inward from the one outside it by the longest
 * house that ring actually placed plus the street between them — the record's
 * street where it states one.
 */
export function planRingfortInterior(
  buildings: InteriorBuildings,
  rings: LocalRings,
  terrain: SamplerTerrain,
  seed: number,
  defaults?: unknown,
  edgeInsetM = EDGE_CLEARANCE_M,
): FarmPlan {
  const template = buildings.template ?? templateFromDefaults(defaults);
  const requested = Math.max(1, Math.round(buildings.count ?? 1));
  const bounds = ringBounds(rings);
  if (!bounds) return { buildings: [], features: [], requested, warnings: [] };
  const [cx, cz] = centroidOf(rings);
  const maxR = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const groups = Math.max(1, Math.round(buildings.groups ?? 1));
  // The record's street, or the assumption the pipeline has already declared.
  const streetM = mid(buildings.streetWidthM) ?? ASSUMED_STREET_M;
  // §7.5.2: the blocks are the *inner* group's — "en inre, mer oregelbunden
  // grupp, genom fyra gator uppdelade i lika många kvarter". The outer group is
  // one unbroken ring of houses against the wall, and is drawn as one.
  const blocks =
    typeof buildings.blocks === 'number' && buildings.blocks >= 2 ? Math.round(buildings.blocks) : null;
  // A stated sector is where the houses are and nowhere else (§7.5.3).
  const arcCentre = buildings.sector ? (SECTOR_BEARINGS[buildings.sector] ?? 0) : 0;
  const arcWidth = buildings.sector ? SECTOR_HALF_WIDTH_DEG * 2 : 360;
  const arcStart = arcCentre - arcWidth / 2;

  const placed: HouseSpec[] = [];
  /** How far in from the wall this ring stands, in metres. */
  let ringInset = 0;

  // The groups are filled from the wall inward, and **not** by dividing the
  // count between them: the record says *"en yttre med husen radiellt utgående
  // från murens insida och en inre"*, which defines the outer group by standing
  // against the wall, and says nothing about how the 88 split. Packing the wall
  // face and letting the remainder fall into the next ring in reads that
  // sentence; an even split would invent a proportion and leave a house-wide hole
  // in the outer ring wherever the arithmetic ran out, which looks like a street
  // the register never described.
  for (let ring = 0; ring < groups && placed.length < requested; ring++) {
    const blockSpan = ring > 0 && blocks ? arcWidth / blocks : null;
    let bearing = arcStart;
    let longest = 0;
    const limit = arcStart + arcWidth;
    // A whole-circle arc closes on itself, so the last house must not overlap
    // the first: it stops a hair short rather than wrapping past it.
    while (placed.length < requested && bearing < limit - 1e-6) {
      const base = houseFromTemplate(template, 'longhouse', streamSeed(seed, placed.length));
      const dx = Math.sin((bearing * Math.PI) / 180);
      const dz = -Math.cos((bearing * Math.PI) / 180);
      // The extent is reached along the house's own corners, not only along its
      // axis: a wall that curves away between them would otherwise put the
      // corners of a 12 m house outside a boundary its middle clears.
      const axial = reachAlong(rings, cx, cz, dx, dz, maxR);
      const guess = axial - edgeInsetM - base.lengthM / 2 - ringInset;
      const spanDeg = guess > 1 ? (Math.atan2(base.widthM / 2, guess) * 180) / Math.PI : 0;
      const reach = Math.min(
        axial,
        ...[-spanDeg, spanDeg].map((offset) => {
          const angle = ((bearing + offset) * Math.PI) / 180;
          return reachAlong(rings, cx, cz, Math.sin(angle), -Math.cos(angle), maxR);
        }),
      );
      const radius = reach - edgeInsetM - base.lengthM / 2 - ringInset;
      // How far round the wall to the next house: the angle this one subtends at
      // its **inner** end, which is where radial houses converge and touch.
      const innerRadius = Math.max(2, radius - base.lengthM / 2);
      const step = degreesFor(base.widthM + BUILDING_GAP_M, innerRadius);

      // A street is a gap nobody builds in. The house is centred on `bearing`
      // and reaches half a step either side of it, so it has to fit **inside**
      // its own block with half a street clear at each end — including at the
      // block boundary the arc closes on, which is a street like the other three
      // and not a seam where two blocks are allowed to touch. A house that will
      // not fit is not squeezed in: the walk moves to the far side of the street
      // and opens the next block there.
      if (blockSpan !== null) {
        const index = Math.floor((bearing - arcStart) / blockSpan + 1e-9);
        const blockStart = arcStart + index * blockSpan;
        const blockEnd = blockStart + blockSpan;
        const streetDeg = degreesFor(streetM, innerRadius);
        if (bearing - step / 2 < blockStart + streetDeg / 2) {
          bearing = Math.max(bearing + 0.5, blockStart + streetDeg / 2 + step / 2);
          continue;
        }
        if (bearing + step / 2 > blockEnd - streetDeg / 2) {
          bearing = Math.max(bearing + 0.5, blockEnd + streetDeg / 2 + step / 2);
          continue;
        }
      }

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
          longest = Math.max(longest, base.lengthM);
          bearing += Math.max(1, step);
          continue;
        }
      }
      // Nothing stood here: creep round rather than skipping a whole slot, so a
      // neighbour a metre wider than its predecessor costs a metre of wall and
      // not a house.
      bearing += 1.5;
    }
    // The next group stands one ring-street further in than this one, behind the
    // longest house this ring actually placed.
    ringInset += (longest || template.lengthM[1]) + streetM;
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
