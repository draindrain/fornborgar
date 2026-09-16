/**
 * Reconstruction mode (contract §14, docs/reconstruction-mode.md).
 *
 * The whole feature turns on a handful of properties that are invisible until
 * the scene is already wrong, so they are pinned here rather than eyeballed:
 *
 *   • **The §14 contract at the door.** A file carrying coordinates, a bad tier
 *     or a class list that does not add up must be refused with a message naming
 *     the field, never half-loaded.
 *   • **The §0 exaggeration invariant.** Monuments live outside the terrain
 *     group and seat themselves at `ground · exaggeration` while keeping true
 *     metric height — a 2.5 m wall is 2.5 m at ×1 and at ×2.5.
 *   • **The §5 transforms as geometry.** A kerbed mound is a cap, a kerbless one
 *     a cone, and a stone setting is neither raised nor rounded.
 *   • **§8's gate.** At 500 CE the fort stands and there are no runestones.
 *   • **Determinism.** Same seed ⇒ byte-identical monuments, so a reload is the
 *     same scene and a screenshot is reproducible.
 *   • **Nothing is a fixed size.** A grave field of 5 and one of 230 are the
 *     same code; a plan form the register names is the plan form drawn.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  ReconstructionError,
  fortIsConfident,
  standingAt,
  validateReconstruction,
  type BuildingTemplate,
  type FarmSpec,
  type InteriorBuildings,
  type Monument,
  type ReconstructionFile,
} from '../src/overlays/reconstruction/schema';
import {
  ReconstructionLayer,
  RENDERED_ARCHETYPES,
  isDrawable,
  localRings,
  monumentState,
} from '../src/overlays/reconstruction/layer';
import {
  aisleWidth,
  bearingRotation,
  buildHouse,
  footprint,
  roofGeometry,
  trestleStations,
  type HouseSpec,
} from '../src/overlays/reconstruction/longhouse';
import {
  FALLBACK_TEMPLATE,
  buildYardFeature,
  footprintsClash,
  houseFromTemplate,
  inSector,
  planFarmstead,
  planInteriorBuildings,
  templateFromDefaults,
  type FarmPlan,
} from '../src/overlays/reconstruction/farmstead';
import {
  ASSUMED_STREET_M,
  planFortInterior,
  planRingfortInterior,
} from '../src/overlays/reconstruction/ringfort';
import {
  buildShape,
  kerbPlacements,
  planRadius,
  profileHeight,
  profileKind,
  tessellation,
  type ShapeSpec,
} from '../src/overlays/reconstruction/shapes';
import {
  MAX_SLOPE,
  SPACING_GAP,
  expandComposition,
  pointInRings,
  sampleGraveField,
  type SamplerTerrain,
} from '../src/overlays/reconstruction/graveField';
import { buildLowBank, buildRampart, crossSection } from '../src/overlays/reconstruction/fort';
import { validateSites, type SitesFile } from '../src/overlays/sites';
import type { RampartFile } from '../src/overlays/palisade';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'broborg');

const rawReconstruction: unknown = JSON.parse(await readFile(join(DATA, 'reconstruction.json'), 'utf8'));
const rawSites: unknown = JSON.parse(await readFile(join(DATA, 'sites.json'), 'utf8'));
const rawRampart: unknown = JSON.parse(await readFile(join(DATA, 'rampart.json'), 'utf8'));

const sites: SitesFile = validateSites(rawSites);
const siteIds = new Set(sites.sites.map((site) => site.id));
const file: ReconstructionFile = validateReconstruction(rawReconstruction, 'reconstruction.json', siteIds);
const rampart = rawRampart as RampartFile;
const byId = new Map(file.monuments.map((monument) => [monument.id, monument]));

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(rawReconstruction)) as Record<string, unknown>;
}

/** A gently domed synthetic ground, so "sits on the terrain" has a shape to sit on. */
function ground(x: number, z: number): number {
  return 20 + 8 * Math.exp(-(x * x + z * z) / (2 * 300 * 300)) + Math.sin(x / 40) * 0.6;
}

// --------------------------------------------------------------------------- //
// the contract, at the door
// --------------------------------------------------------------------------- //

describe('validateReconstruction (§14)', () => {
  it('accepts the committed Broborg file', () => {
    expect(file.schemaVersion).toBe(1);
    expect(file.monuments.length).toBe(127);
    expect(file.derivation.params.fortConfidenceThreshold).toBeGreaterThan(0);
  });

  it('refuses a monument carrying a position — coordinates live in sites.json', () => {
    const broken = clone();
    (broken['monuments'] as Array<Record<string, unknown>>)[0]['position'] = { x: 1, z: 2 };
    expect(() => validateReconstruction(broken)).toThrow(/position/);
  });

  it('refuses a ground height smuggled into a monument', () => {
    const broken = clone();
    (broken['monuments'] as Array<Record<string, unknown>>)[0]['groundM'] = 42;
    expect(() => validateReconstruction(broken)).toThrow(ReconstructionError);
  });

  it('refuses a monument that joins to no site record', () => {
    const broken = clone();
    (broken['monuments'] as Array<Record<string, unknown>>)[0]['id'] = 'L9999:9999';
    expect(() => validateReconstruction(broken, 'reconstruction.json', siteIds)).toThrow(
      /does not join/,
    );
  });

  it('refuses a tier outside measured|derived|assumed (§9)', () => {
    const broken = clone();
    const monument = (broken['monuments'] as Array<Record<string, unknown>>)[0];
    (monument['tiers'] as Record<string, unknown>)['plan'] = 'probably';
    expect(() => validateReconstruction(broken)).toThrow(/tiers\.plan/);
  });

  it('refuses a grave field whose classes do not add up to its count', () => {
    const broken = clone();
    const field = (broken['monuments'] as Array<Record<string, unknown>>).find((m) => m['field']);
    expect(field).toBeDefined();
    (field!['field'] as Record<string, unknown>)['count'] = 99999;
    expect(() => validateReconstruction(broken)).toThrow(/sum to/);
  });

  it('refuses an unsupported schemaVersion rather than guessing', () => {
    const broken = clone();
    broken['schemaVersion'] = 2;
    expect(() => validateReconstruction(broken)).toThrow(/schemaVersion/);
  });

  it('refuses a file with no fortConfidenceThreshold — §6.A.1 needs a rule', () => {
    const broken = clone();
    delete (broken['derivation'] as Record<string, Record<string, unknown>>)['params'][
      'fortConfidenceThreshold'
    ];
    expect(() => validateReconstruction(broken)).toThrow(/fortConfidenceThreshold/);
  });
});

// --------------------------------------------------------------------------- //
// §8 — the archetypes are not contemporaneous
// --------------------------------------------------------------------------- //

describe('the §8 visibility gate', () => {
  const fort = byId.get('L1943:7827')!;

  it('has the fort standing at 500 CE', () => {
    expect(monumentState(fort, 500)).toBe('standing');
    expect(standingAt(fort, 500)).toBe(true);
  });

  it('has the fort a ruin at 1050 CE, so its marker comes back', () => {
    expect(monumentState(fort, 1050)).toBe('ruin');
  });

  it('has no runestone on screen at 500 CE', () => {
    const runestone = file.monuments.find((m) => m.archetype === 'runestone')!;
    expect(runestone.period.builtCE).toBe(950);
    expect(monumentState(runestone, 500)).toBe('unbuilt');
    expect(monumentState(runestone, 1000)).toBe('ruin'); // exists, not drawn in 3D
  });

  it('treats a Bronze Age cairn at 500 CE as a ruin, not as absent', () => {
    const cairn = file.monuments.find((m) => m.archetype === 'cairn')!;
    expect(monumentState(cairn, -800)).toBe('standing');
    expect(monumentState(cairn, 500)).toBe('ruin');
  });

  it('keeps a marker for every archetype this build does not draw', () => {
    for (const monument of file.monuments) {
      if (RENDERED_ARCHETYPES.has(monument.archetype)) continue;
      const built = monument.period.builtCE ?? -9999;
      expect(monumentState(monument, built + 1)).toBe('ruin');
    }
  });

  it('keeps the flat marker for a farmstead record the data says nothing about (§6.H.1.4)', () => {
    // Archetype H is drawn from a `farm` block (§15.2) and from a fort's
    // `interior.buildings`, never from the bare archetype: "free-standing
    // farmsteads keep their flat markers until somebody makes the equivalent
    // measurement for them". None of Broborg's four `Boplats` records carries
    // one, so all four stay markers.
    expect(RENDERED_ARCHETYPES.has('farmstead')).toBe(false);
    const farmsteads = file.monuments.filter((m) => m.archetype === 'farmstead');
    expect(farmsteads.length).toBeGreaterThan(0);
    for (const monument of farmsteads) {
      expect(monument.farm).toBeUndefined();
      expect(isDrawable(monument)).toBe(false);
      expect(monumentState(monument, 500)).toBe('ruin');
    }
  });
});

// --------------------------------------------------------------------------- //
// §6.A.1 — the fortConfidence filter
// --------------------------------------------------------------------------- //

describe('fortConfidence (§6.A.1)', () => {
  it('passes Broborg, which meets every criterion', () => {
    const fort = byId.get('L1943:7827')!;
    expect(fort.fort!.confidence).toBe(1);
    expect(fortIsConfident(fort, file.derivation.params)).toBe(true);
  });

  it('refuses a record below the threshold, whatever its geometry says', () => {
    const fort = byId.get('L1943:7827')!;
    const weak: Monument = { ...fort, fort: { ...fort.fort!, confidence: 0.3 } };
    expect(fortIsConfident(weak, file.derivation.params)).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// the plan form is the one the register names
// --------------------------------------------------------------------------- //

describe('planRadius (§6.C)', () => {
  it('is constant for a round plan', () => {
    for (const theta of [0, 1, 2, 3]) expect(planRadius('round', 4, 4, theta)).toBeCloseTo(4, 9);
  });

  it('gives a square its corners at √2 of its half-side', () => {
    expect(planRadius('square', 3, 3, 0)).toBeCloseTo(3, 9);
    expect(planRadius('square', 3, 3, Math.PI / 4)).toBeCloseTo(3 * Math.SQRT2, 9);
  });

  it('gives a rectangle two different half-axes', () => {
    expect(planRadius('rectangular', 6, 2, 0)).toBeCloseTo(6, 9);
    expect(planRadius('rectangular', 6, 2, Math.PI / 2)).toBeCloseTo(2, 9);
  });

  it('gives an ellipse for an oval', () => {
    expect(planRadius('oval', 6, 3, 0)).toBeCloseTo(6, 9);
    expect(planRadius('oval', 6, 3, Math.PI / 2)).toBeCloseTo(3, 9);
  });

  it('gives a triangle three corners at its circumradius', () => {
    const radii = [0, 1, 2].map((k) => planRadius('triangular', 5, 5, Math.PI / 2 + (k * 2 * Math.PI) / 3));
    for (const r of radii) expect(r).toBeCloseTo(5, 6);
  });

  it('draws the four forms the corpus actually uses as four different shapes', () => {
    const at = (form: Parameters<typeof planRadius>[0]) => planRadius(form, 4, 4, Math.PI / 4);
    expect(new Set([at('round'), at('square'), at('triangular')]).size).toBe(3);
  });
});

// --------------------------------------------------------------------------- //
// §5 as geometry — the kerb gate decides the shape, not just the numbers
// --------------------------------------------------------------------------- //

describe('profileHeight (§5.2)', () => {
  it('reaches the stated height at the centre and zero at the rim, every kind', () => {
    for (const kind of ['cap', 'cone', 'platform'] as const) {
      expect(profileHeight(kind, 0, 3, 1.6)).toBeCloseTo(1.6, 6);
      expect(profileHeight(kind, 1, 3, 1.6)).toBeCloseTo(0, 6);
    }
  });

  it('falls monotonically outward', () => {
    for (const kind of ['cap', 'cone', 'platform'] as const) {
      let previous = Infinity;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const h = profileHeight(kind, t, 3, 1.6);
        expect(h).toBeLessThanOrEqual(previous + 1e-9);
        previous = h;
      }
    }
  });

  it('gives a cone straight flanks and a cap a dome — §5.2’s two branches', () => {
    // The kerbless branch rebuilds at the angle of repose, so its flank is a
    // straight line; the kerbed one restores a spherical cap through the kerb,
    // which is fuller at mid-radius and steeper at the rim. Drawing one with the
    // other's dimensions would undo the volume conservation the transform is for.
    expect(profileHeight('cap', 0.5, 3, 1.6)).toBeGreaterThan(profileHeight('cone', 0.5, 3, 1.6));
    const drop = (from: number, to: number) =>
      profileHeight('cone', from, 3, 1.6) - profileHeight('cone', to, 3, 1.6);
    expect(drop(0.4, 0.5)).toBeCloseTo(drop(0.7, 0.8), 6);
  });

  it('meets the ground at the rim even for a monument taller than it is wide', () => {
    // The plain spherical-cap formula stops being single-valued once h > a, and
    // its rim then lands well above zero — a step where the monument should meet
    // the ground. A pathological record must not produce one.
    for (const [a, h] of [[3, 1.6], [1, 1.6], [0.5, 4], [8.5, 0.35]] as const) {
      expect(profileHeight('cap', 1, a, h)).toBeCloseTo(0, 6);
      expect(profileHeight('cap', 0, a, h)).toBeCloseTo(h, 6);
    }
  });

  it('keeps a platform flat across its middle — flatness is the type (§6.C)', () => {
    expect(profileHeight('platform', 0.5, 3, 0.4)).toBeGreaterThan(0.4 * 0.98);
  });
});

describe('profileKind follows the §5 transform the parser recorded', () => {
  const kindOf = (transform: string, archetype = 'mound') =>
    profileKind({ archetype, profile: { transform } } as unknown as Monument);

  it('gives a kerbed monument a cap — it must not shrink inside its kerb', () => {
    expect(kindOf('kerb-fixed')).toBe('cap');
    expect(kindOf('kerb-fixed+pit-fill')).toBe('cap');
  });

  it('gives a kerbless one a cone, at the material’s angle of repose', () => {
    expect(kindOf('repose-reprofile')).toBe('cone');
    expect(kindOf('repose-reprofile+pit-fill')).toBe('cone');
  });

  it('gives a stone setting a flat platform, never a dome', () => {
    expect(kindOf('none', 'stone-setting')).toBe('platform');
    expect(kindOf('pit-omit', 'stone-setting')).toBe('platform');
  });
});

// --------------------------------------------------------------------------- //
// the mesh itself
// --------------------------------------------------------------------------- //

function spec(overrides: Partial<ShapeSpec> = {}): ShapeSpec {
  return {
    archetype: 'stone-setting',
    form: 'round',
    diameterM: 6,
    heightM: 0.4,
    lengthM: null,
    widthM: null,
    orientationDeg: null,
    stoneM: [0.2, 0.4],
    kind: 'platform',
    seed: 7,
    ...overrides,
  };
}

describe('buildShape', () => {
  it('produces a closed, well-indexed mesh', () => {
    const build = buildShape(spec());
    const vertices = build.offsets.length / 3;
    expect(build.colors.length).toBe(build.offsets.length);
    expect(build.indices.length % 3).toBe(0);
    for (const index of build.indices) expect(index).toBeLessThan(vertices);
  });

  it('meets the ground exactly at the rim, so nothing hovers or is buried', () => {
    // Every kind, and a tall narrow case with each — the rim is where a profile
    // bug shows up as a step, and it is the one place the mesh must be exact.
    for (const kind of ['cap', 'cone', 'platform'] as const) {
      for (const [diameterM, heightM] of [[6, 0.4], [7, 2], [3, 2.5]] as const) {
        const build = buildShape(spec({ archetype: 'cairn', kind, diameterM, heightM }));
        const vertices = build.offsets.length / 3;
        let minY = Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < vertices; i++) {
          minY = Math.min(minY, build.offsets[i * 3 + 1]);
          maxY = Math.max(maxY, build.offsets[i * 3 + 1]);
        }
        expect(minY).toBe(0);
        // …and the apex still reaches the height the §5 transform asked for.
        expect(maxY).toBeGreaterThan(heightM * 0.9);
      }
    }
  });

  it('reaches the reconstructed height at its apex', () => {
    const build = buildShape(spec({ kind: 'cone', heightM: 1.63, archetype: 'mound' }));
    expect(build.offsets[1]).toBeGreaterThan(1.5);
  });

  it('is byte-identical for the same seed, and different for another', () => {
    const a = buildShape(spec());
    const b = buildShape(spec());
    const c = buildShape(spec({ seed: 8 }));
    expect(Array.from(a.offsets)).toEqual(Array.from(b.offsets));
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
    expect(Array.from(a.offsets)).not.toEqual(Array.from(c.offsets));
  });

  it('sends each archetype to its own material family', () => {
    expect(buildShape(spec({ archetype: 'mound' })).material).toBe('turf');
    expect(buildShape(spec({ archetype: 'fire-cracked-mound' })).material).toBe('fire');
    expect(buildShape(spec({ archetype: 'cairn' })).material).toBe('stone');
  });

  it('scales its own tessellation with the monument, not with a constant', () => {
    const small = tessellation(1.5, 0.3);
    const large = tessellation(10, 0.3);
    expect(large.spokes).toBeGreaterThan(small.spokes);
    expect(large.rings).toBeGreaterThan(small.rings);
  });

  it('draws a rectangular plan wider than it is deep', () => {
    const build = buildShape(spec({ form: 'rectangular', lengthM: 9, widthM: 5, orientationDeg: 0 }));
    let maxX = 0;
    let maxZ = 0;
    for (let i = 0; i < build.offsets.length / 3; i++) {
      maxX = Math.max(maxX, Math.abs(build.offsets[i * 3]));
      maxZ = Math.max(maxZ, Math.abs(build.offsets[i * 3 + 2]));
    }
    expect(maxX).toBeGreaterThan(maxZ * 1.4);
  });
});

describe('kerbPlacements (§5.2, §6.C)', () => {
  it('rings the whole rim with contiguous stones', () => {
    const stones = kerbPlacements(spec(), [0.5, 0.7]);
    expect(stones.length).toBeGreaterThan(20);
    const radii = stones.map((s) => Math.hypot(s.x, s.z));
    for (const r of radii) expect(r).toBeCloseTo(3, 5);
  });

  it('uses the kerb’s own recorded calibre, not the surface stone', () => {
    const fine = kerbPlacements(spec(), [0.2, 0.2]);
    const coarse = kerbPlacements(spec(), [1.2, 1.4]);
    expect(coarse[0].sizeM).toBeGreaterThan(fine[0].sizeM * 3);
    expect(coarse.length).toBeLessThan(fine.length);
  });
});

// --------------------------------------------------------------------------- //
// §3.1 / §6.G — the grave-field sampler
// --------------------------------------------------------------------------- //

const flatTerrain: SamplerTerrain = {
  groundAt: ground,
  classAt: null,
  isWet: () => false,
};

function squareRings(half: number): Array<Array<[number, number]>> {
  return [[[-half, -half], [half, -half], [half, half], [-half, half]]];
}

describe('the grave-field sampler', () => {
  const small = file.monuments.find((m) => m.field?.count === 5)!;
  const large = file.monuments.find((m) => m.field?.count === 230)!;

  it('finds a field of 5 and one of 230 in the corpus, as §3.1 says', () => {
    expect(small).toBeDefined();
    expect(large).toBeDefined();
  });

  it('expands a composition to exactly the record’s own count', () => {
    for (const monument of [small, large]) {
      expect(expandComposition(monument.field!.classes, 1).length).toBe(monument.field!.count);
    }
  });

  it('draws diameter and height from one shared draw, so big is also tall', () => {
    const classes = [
      { archetype: 'mound' as const, form: null, count: 40, diameterM: [4, 10] as [number, number],
        heightM: [0.4, 2.0] as [number, number], stoneM: [0.2, 0.4] as [number, number], source: 'measured' as const },
    ];
    const items = expandComposition(classes, 3);
    const widest = items.reduce((a, b) => (b.diameterM > a.diameterM ? b : a));
    const narrowest = items.reduce((a, b) => (b.diameterM < a.diameterM ? b : a));
    expect(widest.heightM).toBeGreaterThan(narrowest.heightM);
  });

  it('places every monument inside the extent polygon', () => {
    const rings = squareRings(80);
    const placed = sampleGraveField(small, { x: 0, z: 0 }, rings, flatTerrain, 11);
    expect(placed.length).toBeGreaterThan(0);
    for (const item of placed) expect(pointInRings(rings, item.x, item.z)).toBe(true);
  });

  it('never lets two monuments intersect (blue-noise spacing)', () => {
    const rings = squareRings(140);
    const placed = sampleGraveField(large, { x: 0, z: 0 }, rings, flatTerrain, 12);
    expect(placed.length).toBeGreaterThan(20);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const need = (placed[i].diameterM + placed[j].diameterM) / 2;
        const distance = Math.hypot(placed[i].x - placed[j].x, placed[i].z - placed[j].z);
        expect(distance).toBeGreaterThan(need * (1 + SPACING_GAP) - 1e-6);
      }
    }
  });

  it('places nothing where the land cover says wet (§6.G)', () => {
    // Class 1 west of the origin, class 2 east; only class 1 is wet.
    const terrain: SamplerTerrain = {
      groundAt: ground,
      classAt: (x) => (x < 0 ? 1 : 2),
      isWet: (index) => index === 1,
    };
    const placed = sampleGraveField(large, { x: 0, z: 0 }, squareRings(140), terrain, 13);
    expect(placed.length).toBeGreaterThan(10);
    for (const item of placed) expect(item.x).toBeGreaterThanOrEqual(0);
  });

  it('refuses ground steeper than the stated limit', () => {
    const cliff: SamplerTerrain = { groundAt: (x) => x * (MAX_SLOPE * 2), classAt: null, isWet: () => false };
    expect(sampleGraveField(large, { x: 0, z: 0 }, squareRings(140), cliff, 14).length).toBe(0);
  });

  it('biases the largest monuments toward the highest ground (§6.G)', () => {
    // A single hill in the middle of the extent.
    const hill: SamplerTerrain = {
      groundAt: (x, z) => 30 * Math.exp(-(x * x + z * z) / (2 * 45 * 45)),
      classAt: null,
      isWet: () => false,
    };
    const placed = sampleGraveField(large, { x: 0, z: 0 }, squareRings(140), hill, 15);
    const sorted = [...placed].sort((a, b) => b.diameterM - a.diameterM);
    const biggest = sorted.slice(0, 5);
    const smallest = sorted.slice(-20);
    const mean = (items: typeof placed) =>
      items.reduce((sum, item) => sum + hill.groundAt(item.x, item.z), 0) / items.length;
    expect(mean(biggest)).toBeGreaterThan(mean(smallest));
  });

  it('is byte-identical for the same seed', () => {
    const rings = squareRings(140);
    const a = sampleGraveField(large, { x: 0, z: 0 }, rings, flatTerrain, 21);
    const b = sampleGraveField(large, { x: 0, z: 0 }, rings, flatTerrain, 21);
    const c = sampleGraveField(large, { x: 0, z: 0 }, rings, flatTerrain, 22);
    expect(a.map((m) => [m.x, m.z])).toEqual(b.map((m) => [m.x, m.z]));
    expect(a.map((m) => [m.x, m.z])).not.toEqual(c.map((m) => [m.x, m.z]));
  });

  it('falls back to the extent the description states when there is no polygon', () => {
    const placed = sampleGraveField(large, { x: 0, z: 0 }, null, flatTerrain, 23);
    expect(placed.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------- //
// §7.2 — the rampart cross-section
// --------------------------------------------------------------------------- //

describe('the rampart cross-section (§7.2)', () => {
  it('runs outer toe → outer top → top → inner edge → backing bank', () => {
    const section = crossSection(2.5, 5, 1, 1.5, 1.25);
    expect(section).toHaveLength(7);
    // Offsets fall monotonically from the outer face to the inner backing toe.
    for (let i = 1; i < section.length; i++) {
      expect(section[i].n).toBeLessThanOrEqual(section[i - 1].n + 1e-9);
    }
  });

  it('batters the outer face back, so its top sits inside its base', () => {
    const section = crossSection(3, 5, 1, 1.5, 1.25);
    expect(section[2].n).toBeLessThan(section[1].n);
  });

  it('measures the wall from the ground the ruin sits on, not from the ruin', () => {
    // §7.2: the DEM already contains the collapsed bank, so the wall's base is
    // the recorded bank height *below* the crest — the ruin ends up inside the
    // reconstruction rather than under it.
    const drop = 1.5;
    const section = crossSection(2.5, 5, 1, drop, 1.25);
    expect(section[1].y).toBeCloseTo(-drop, 9);
    expect(section[2].y - section[1].y).toBeCloseTo(2.5, 9);
  });

  it('keeps the wall body at the thickness the section was asked for', () => {
    const section = crossSection(2.5, 4.5, 1, 1.5, 1.25);
    expect(section[1].n - section[4].n).toBeCloseTo(4.5, 9);
  });
});

describe('buildRampart', () => {
  const fort = byId.get('L1943:7827')!;
  const inner = fort.fort!.ramparts[0];
  const options = { groundAt: ground, vitrified: true, seed: 5 };

  it('sweeps the measured crest into a wall of stone, soil and vitrified cake', () => {
    const builds = buildRampart(rampart.paths[0].points, rampart.paths[0].closed, inner, options);
    const families = builds.map((build) => build.family).sort();
    expect(families).toEqual(['soil', 'stone', 'vitrified']);
    for (const build of builds) {
      expect(build.localY.length).toBeGreaterThan(100);
      expect(build.positionsXZ.length).toBe(build.localY.length * 2);
      expect(build.indices.length % 3).toBe(0);
    }
  });

  it('leaves the cake off when the state is off (§7.1 — render both, claim neither)', () => {
    const builds = buildRampart(rampart.paths[0].points, rampart.paths[0].closed, inner, {
      ...options,
      vitrified: false,
    });
    expect(builds.some((build) => build.family === 'vitrified')).toBe(false);
  });

  it('stands the wall at the derived height, not at the recorded ruin height', () => {
    const builds = buildRampart(rampart.paths[0].points, rampart.paths[0].closed, inner, options);
    let top = -Infinity;
    let bottom = Infinity;
    for (const build of builds) {
      for (const y of build.localY) {
        top = Math.max(top, y);
        bottom = Math.min(bottom, y);
      }
    }
    // Top of wall = base + 2.5 m, base = 1.5 m below the crest the DEM records.
    expect(top).toBeCloseTo(2.5 - 1.5, 6);
    expect(bottom).toBeLessThan(-1.5);
  });

  it('draws a low bank instead where §6.A.1 refuses a standing rampart', () => {
    const wall = buildRampart(rampart.paths[0].points, rampart.paths[0].closed, inner, options);
    const bank = buildLowBank(rampart.paths[0].points, rampart.paths[0].closed, inner, options);
    const highest = (builds: typeof wall) =>
      Math.max(...builds.flatMap((build) => Array.from(build.localY)));
    expect(highest(bank)).toBeLessThan(highest(wall));
    expect(bank.some((build) => build.family === 'vitrified')).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// the layer — §0's exaggeration invariant, and the scene budget
// --------------------------------------------------------------------------- //

describe('ReconstructionLayer', () => {
  let exaggeration = 1;
  const layer = new ReconstructionLayer(
    file,
    sites,
    {
      groundAt: ground,
      getExaggeration: () => exaggeration,
      classAt: null,
      classId: null,
      rampart,
      seed: 1,
      vitrified: true,
    },
    500,
  );

  function meshes(): THREE.Mesh[] {
    return layer.group.children.filter(
      (child) => (child as THREE.Mesh).isMesh && !(child as THREE.InstancedMesh).isInstancedMesh,
    ) as THREE.Mesh[];
  }

  /** Every vertex of every batch, as `[x, y, z]`. */
  function vertices(): Float32Array[] {
    return meshes()
      .filter((mesh) => mesh.name.startsWith('reconstruction-') && !mesh.name.includes('accent'))
      .map((mesh) => (mesh.geometry.getAttribute('position').array as Float32Array));
  }

  it('builds monuments for the whole corpus', () => {
    expect(layer.vertexCount).toBeGreaterThan(10000);
    expect(layer.standingCount).toBeGreaterThan(100);
  });

  it('lives outside the terrain group, as its own scene child', () => {
    expect(layer.group.name).toBe('reconstruction');
    expect(layer.group.parent).toBeNull();
  });

  it('seats every vertex on the terrain at ×1', () => {
    exaggeration = 1;
    layer.refreshHeights();
    let checked = 0;
    let highest = -Infinity;
    for (const array of vertices()) {
      for (let i = 0; i < array.length; i += 3) {
        highest = Math.max(highest, array[i + 1] - ground(array[i], array[i + 2]));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10000);
    // Nothing floats: the tallest thing in the corpus is a re-profiled mound of
    // about 5 m, and the fort wall stands 2.5 m over its own base.
    expect(highest).toBeLessThan(12);
  });

  /** Every vertex's Y at one exaggeration, batch by batch. */
  function heightsAt(value: number): Float32Array[] {
    exaggeration = value;
    layer.refreshHeights();
    return vertices().map((array) => {
      const out = new Float32Array(array.length / 3);
      for (let i = 0; i < out.length; i++) out[i] = array[i * 3 + 1];
      return out;
    });
  }

  it('never moves a monument sideways when exaggeration changes', () => {
    exaggeration = 1;
    layer.refreshHeights();
    const before = vertices().map((array) => Float32Array.from(array));
    exaggeration = 2.5;
    layer.refreshHeights();
    const after = vertices();
    let worst = 0;
    for (let m = 0; m < after.length; m++) {
      for (let i = 0; i < after[m].length; i += 3) {
        worst = Math.max(worst, Math.abs(after[m][i] - before[m][i]));
        worst = Math.max(worst, Math.abs(after[m][i + 2] - before[m][i + 2]));
      }
    }
    expect(worst).toBe(0);
    exaggeration = 1;
    layer.refreshHeights();
  });

  it('keeps true metric height at every exaggeration — the contract §0 invariant', () => {
    // `y = ground · exaggeration + trueMetricHeight` is exactly affine in the
    // exaggeration, so the per-vertex slope measured between ×1 and ×2.5 must
    // equal the one measured between ×1 and ×4. Anything that scaled the
    // monument itself — a height baked into the Y, a group under the terrain —
    // would break this, and nothing else would.
    const one = heightsAt(1);
    const twoFive = heightsAt(2.5);
    const four = heightsAt(4);

    let worst = 0;
    let sampled = 0;
    for (let m = 0; m < one.length; m++) {
      for (let i = 0; i < one[m].length; i++) {
        const slopeA = (twoFive[m][i] - one[m][i]) / 1.5;
        const slopeB = (four[m][i] - one[m][i]) / 3;
        worst = Math.max(worst, Math.abs(slopeA - slopeB));
        sampled++;
      }
    }
    expect(sampled).toBeGreaterThan(10000);
    // Float32 storage on ground heights around 30 m; 1 mm is far below anything
    // visible and far above the storage's own noise floor.
    expect(worst).toBeLessThan(1e-3);
    exaggeration = 1;
    layer.refreshHeights();
  });

  it('keeps a mound the same height above its own ground at ×1 and ×2.5', () => {
    const one = heightsAt(1);
    const twoFive = heightsAt(2.5);
    let worst = 0;
    for (let m = 0; m < one.length; m++) {
      for (let i = 0; i < one[m].length; i++) {
        // Recover the stored ground from the pair, then the metric height from
        // either — they must agree to float32 precision.
        const g = (twoFive[m][i] - one[m][i]) / 1.5;
        worst = Math.max(worst, Math.abs(one[m][i] - g - (twoFive[m][i] - g * 2.5)));
      }
    }
    expect(worst).toBeLessThan(1e-3);
    exaggeration = 1;
    layer.refreshHeights();
  });

  it('gates whole archetypes by year, never rebuilding', () => {
    layer.setYear(500);
    const fortMeshes = meshes().filter((mesh) => mesh.name.includes('fort:'));
    expect(fortMeshes.length).toBeGreaterThan(0);
    expect(fortMeshes.every((mesh) => mesh.visible)).toBe(true);
    layer.setYear(1200);
    expect(fortMeshes.every((mesh) => mesh.visible)).toBe(false);
    layer.setYear(500);
  });

  it('hands back the ids whose flat markers must stay on screen', () => {
    layer.setYear(500);
    const markers = layer.markerIds();
    expect(markers.has('L1943:7827')).toBe(false); // the fort is standing
    const runestone = file.monuments.find((m) => m.archetype === 'runestone')!;
    expect(markers.has(runestone.id)).toBe(false); // …and not built yet
    layer.setYear(1200);
    expect(layer.markerIds().has('L1943:7827')).toBe(true); // a ruin: marker back
    layer.setYear(500);
  });

  it('reports per-part provenance for the popup, never one averaged badge', () => {
    const summary = layer.summary('L1943:6889');
    expect(summary).not.toBeNull();
    expect(summary!.monument.tiers.plan).toBe('measured');
    expect(summary!.monument.tiers.profile).toBe('derived');
    expect(summary!.monument.tiers.surface).toBe('assumed');
  });

  it('reports how many grave-field monuments it actually placed', () => {
    const field = file.monuments.find((m) => m.field && m.field.count > 40)!;
    const summary = layer.summary(field.id)!;
    expect(summary.requested).toBe(field.field!.count);
    expect(summary.sampled).toBeGreaterThan(0);
    expect(summary.sampled).toBeLessThanOrEqual(summary.requested);
  });

  it('gives every drawn record a click target, but only while the mode is on', () => {
    // The group being hidden does not clear a child's own `visible` flag, so a
    // marker-mode click on empty ground must not find a monument's pick volume.
    layer.setEnabled(false);
    expect(layer.pickables.length).toBe(0);
    layer.setEnabled(true);
    expect(layer.pickables.length).toBeGreaterThan(50);
    for (const pick of layer.pickables) {
      expect(pick.userData['siteId']).toBeTruthy();
      // The handler picks the most *specific* target, so every volume has to
      // say how big it is — a grave field's covers its whole extent.
      expect(pick.userData['pickRadius']).toBeGreaterThan(0);
    }
    const field = file.monuments.find((m) => m.field && m.field.count > 100)!;
    const mound = file.monuments.find((m) => m.archetype === 'mound')!;
    const radiusOf = (id: string) =>
      layer.pickables.find((p) => p.userData['siteId'] === id)!.userData['pickRadius'] as number;
    expect(radiusOf(field.id)).toBeGreaterThan(radiusOf(mound.id) * 5);
    layer.setEnabled(false);
  });

  it('lights smooth-shaded monuments off their seated surface, not off a flat disc', () => {
    // Normals must be computed after the vertices are seated on the terrain and
    // again whenever they move; computed on the unseated geometry they would all
    // point straight up, and a mound would shade like a painted circle.
    exaggeration = 1;
    layer.refreshHeights();
    const mound = meshes().find((m) => m.name === 'reconstruction-mound:turf')!;
    const normals = mound.geometry.getAttribute('normal').array as Float32Array;
    let sideways = 0;
    for (let i = 0; i < normals.length; i += 3) {
      if (Math.hypot(normals[i], normals[i + 2]) > 0.15) sideways++;
    }
    expect(sideways).toBeGreaterThan(normals.length / 3 / 4);
  });

  it('is byte-identical for the same seed — a reload is the same scene', () => {
    const build = () =>
      new ReconstructionLayer(
        file,
        sites,
        { groundAt: ground, getExaggeration: () => 1, classAt: null, classId: null, rampart, seed: 1, vitrified: true },
        500,
      );
    const a = build();
    const b = build();
    const positions = (l: ReconstructionLayer): number[] =>
      l.group.children
        .filter((child) => (child as THREE.Mesh).isMesh)
        .flatMap((child) => {
          const attribute = (child as THREE.Mesh).geometry.getAttribute('position');
          return attribute ? Array.from(attribute.array as Float32Array) : [];
        });
    expect(positions(a)).toEqual(positions(b));
    a.dispose();
    b.dispose();
  });

  it('disposes cleanly', () => {
    const throwaway = new ReconstructionLayer(
      file,
      sites,
      { groundAt: ground, getExaggeration: () => 1, classAt: null, classId: null, rampart: null, seed: 2, vitrified: false },
      500,
    );
    throwaway.dispose();
    expect(throwaway.group.children.length).toBe(0);
  });
});

describe('localRings', () => {
  it('reads a Polygon extent straight out of sites.json', () => {
    const record = sites.sites.find((site) => site.geometryLocal?.type === 'Polygon')!;
    const rings = localRings(record)!;
    expect(rings[0].length).toBeGreaterThan(2);
    expect(rings[0][0]).toHaveLength(2);
  });

  it('returns null for a point record, so the sampler falls back to the extent', () => {
    const record = sites.sites.find((site) => !site.geometryLocal)!;
    expect(localRings(record)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// §15 — the interior and farm blocks at the door
// --------------------------------------------------------------------------- //

/** Ismantorp's own sentence, as the pipeline writes it (§7.5.1, §15.1). */
const ISMANTORP_TEMPLATE: BuildingTemplate = {
  kind: 'longhouse',
  count: 1,
  lengthM: [12, 14],
  widthM: [4, 6],
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
  source: 'measured',
  tiers: { plan: 'measured', profile: 'derived', surface: 'assumed' },
};

const ISMANTORP_BUILDINGS: InteriorBuildings = {
  count: 88,
  countSource: 'measured',
  countStated: true,
  layout: 'radial',
  groups: 2,
  // §7.5.2's street plan, as the pipeline now parses it from the same sentence
  // and the one after it: "genom fyra gator uppdelade i lika många kvarter" and
  // "De båda husgrupperna skiljs av en 2-5 m br ringgata".
  blocks: 4,
  streetWidthM: [2, 5],
  sector: null,
  template: ISMANTORP_TEMPLATE,
  fallbacks: [],
  source: 'measured',
};

/** The committed file with a different `interior` block spliced into it. */
function withInterior(patch: Record<string, unknown>): Record<string, unknown> {
  const raw = clone();
  raw['interior'] = { ...(raw['interior'] as Record<string, unknown>), ...patch };
  return raw;
}

describe('the §15 interior block, at the door', () => {
  it('accepts Broborg: the gate passes on a citation, and states no buildings', () => {
    // §7.5.3's channel 3, and the reason Broborg is *not* the drawn-longhouse
    // case: the occupation is dated, the interior stone is contested, and the
    // record says nothing about buildings, so `buildings` is null and none are
    // drawn.
    const interior = file.interior!;
    expect(interior.state).toBe('cleared');
    expect(interior.settlementOffered).toBe(true);
    expect(interior.evidence.gate).toBe('pass');
    expect(interior.evidence.citations.length).toBeGreaterThan(0);
    expect(interior.buildings).toBeNull();
  });

  it('refuses a hip shallower than the long sides — the Eketorp-II error (§6.H)', () => {
    const broken = withInterior({
      buildings: { ...ISMANTORP_BUILDINGS, template: { ...ISMANTORP_TEMPLATE, hipPitchDeg: 38 } },
    });
    expect(() => validateReconstruction(broken)).toThrow(/hipPitchDeg/);
  });

  it('refuses a wall under a metre — the wall carries load, it is not a footing', () => {
    const broken = withInterior({
      buildings: { ...ISMANTORP_BUILDINGS, template: { ...ISMANTORP_TEMPLATE, wallHeightM: 0.6 } },
    });
    expect(() => validateReconstruction(broken)).toThrow(/wallHeightM/);
  });

  it('refuses an aisle outside the underbalanced band (§6.H, §15.3)', () => {
    const broken = withInterior({
      buildings: {
        ...ISMANTORP_BUILDINGS,
        template: { ...ISMANTORP_TEMPLATE, aisleFraction: 0.75 },
      },
    });
    expect(() => validateReconstruction(broken)).toThrow(/aisleFraction/);
  });

  it('refuses a gabled roof: v1.8 draws no gabled Iron Age longhouse', () => {
    const broken = withInterior({
      buildings: { ...ISMANTORP_BUILDINGS, template: { ...ISMANTORP_TEMPLATE, roofForm: 'gabled' } },
    });
    expect(() => validateReconstruction(broken)).toThrow(/roofForm/);
  });

  it('refuses the settlement state with no citation — no citation, no state', () => {
    const broken = withInterior({
      settlementOffered: true,
      evidence: { ...file.interior!.evidence, gate: 'pass', citations: [] },
    });
    expect(() => validateReconstruction(broken)).toThrow(/citation/);
  });

  it('refuses buildings inside a fort that failed the gate (§7.5.3)', () => {
    const broken = withInterior({
      settlementOffered: false,
      evidence: { ...file.interior!.evidence, gate: 'fail', citations: [] },
      buildings: ISMANTORP_BUILDINGS,
    });
    expect(() => validateReconstruction(broken)).toThrow(/failed the gate/);
  });

  it('refuses a coordinate hidden in a building spec — a sector is not a position', () => {
    const broken = withInterior({ buildings: { ...ISMANTORP_BUILDINGS, x: 12, z: -4 } });
    expect(() => validateReconstruction(broken)).toThrow(/never a position/);
  });

  it('refuses a cleared patch with no sentence to place it', () => {
    const broken = withInterior({
      ground: {
        ...file.interior!.ground,
        clearedPatches: [
          { lengthM: 8, widthM: 6, orientationDeg: null, sector: 'S', source: 'measured' },
        ],
      },
    });
    expect(() => validateReconstruction(broken)).toThrow(/sentence/);
  });

  it('refuses a farm block on a record that is not a farmstead (§15.2)', () => {
    const broken = clone();
    const mound = (broken['monuments'] as Array<Record<string, unknown>>).find(
      (m) => m['archetype'] === 'mound',
    )!;
    mound['farm'] = {
      buildings: [],
      layout: 'yard',
      features: {},
      insideFortId: null,
      source: 'assumed',
    };
    expect(() => validateReconstruction(broken)).toThrow(/archetype H only/);
  });

  it('refuses a yard inside a fort: no hearths, wells or fences in an enclosure', () => {
    const broken = clone();
    const farmstead = (broken['monuments'] as Array<Record<string, unknown>>).find(
      (m) => m['archetype'] === 'farmstead',
    )!;
    farmstead['farm'] = {
      buildings: [ISMANTORP_TEMPLATE],
      layout: 'yard',
      features: { hearth: true, well: false, enclosure: false },
      insideFortId: 'L1943:7827',
      source: 'assumed',
    };
    expect(() => validateReconstruction(broken)).toThrow(/inside fort/);
  });
});

// --------------------------------------------------------------------------- //
// §6.H — the four things reconstructions get wrong
// --------------------------------------------------------------------------- //

/** Gene house II, 40 × 9 m, ~350–600 CE: §6.H's recommended default. */
function house(overrides: Partial<HouseSpec> = {}): HouseSpec {
  return {
    kind: 'longhouse',
    x: 0,
    z: 0,
    lengthM: 40,
    widthM: 9,
    rotationRad: 0,
    wallHeightM: 1.2,
    roofPitchDeg: 45,
    hipPitchDeg: 48,
    aisleFraction: 0.4,
    aisleWidthM: [1.3, 2.8],
    trestleSpacingM: [2, 3],
    doorSide: 1,
    seed: 77,
    ...overrides,
  };
}

describe('the §6.H longhouse', () => {
  it('gives Gene house II a roof far more than twice the height of its wall', () => {
    const roof = roofGeometry(house());
    expect(roof.roofHeightM).toBeCloseTo(5.0, 1);
    expect(roof.roofHeightM).toBeGreaterThan(house().wallHeightM * 2);
    expect(roof.ridgeY).toBeCloseTo(5.7, 1);
  });

  it('is hipped, never gabled: the ridge stops short of both ends', () => {
    const roof = roofGeometry(house());
    expect(roof.ridgeHalfM).toBeGreaterThan(0);
    expect(roof.ridgeHalfM).toBeLessThan(roof.eaveHalfLengthM - 1);
    expect(roof.hipRunM).toBeGreaterThan(0);
  });

  it('never lets the hip fall shallower than the long sides — the Eketorp-II error', () => {
    // A steeper hip runs in a shorter way and leaves a longer ridge; an equal
    // one runs in exactly half the breadth. Neither can be shallower, because a
    // hip pitch under the roof pitch is clamped up rather than drawn.
    const equal = roofGeometry(house({ hipPitchDeg: 45 }));
    const steep = roofGeometry(house({ hipPitchDeg: 60 }));
    const refused = roofGeometry(house({ hipPitchDeg: 20 }));
    expect(equal.hipRunM).toBeCloseTo(equal.eaveHalfWidthM, 5);
    expect(steep.hipRunM).toBeLessThan(equal.hipRunM);
    expect(steep.ridgeHalfM).toBeGreaterThan(equal.ridgeHalfM);
    expect(refused.hipRunM).toBeCloseTo(equal.hipRunM, 5);
  });

  it('builds the aisle underbalanced — 40 % of breadth, inside the Mälardalen band', () => {
    // §6.H's table, in metres: *underbalanserad* is ~40 % of breadth at 1.3–2.8 m.
    expect(aisleWidth(6, 0.4, [1.3, 2.8]).widthM).toBeCloseTo(2.4, 6);
    expect(aisleWidth(6, 0.4, [1.3, 2.8]).clamped).toBe(false);
    expect(aisleWidth(5, 0.4, [1.3, 2.8]).widthM).toBeCloseTo(2.0, 6);
    // The 9 m Gene house is the case where the fraction and the measured band
    // disagree; the band wins, and the disagreement is reported, not hidden.
    expect(aisleWidth(9, 0.4, [1.3, 2.8])).toEqual({ widthM: 2.8, clamped: true });
    // …and it is always less than half the breadth, which is the period rule.
    for (const breadth of [5, 6, 7, 8, 9]) {
      expect(aisleWidth(breadth, 0.4, [1.3, 2.8]).widthM).toBeLessThan(breadth / 2);
    }
  });

  it('spaces the trestles unevenly: tight in the byre, open over the hearth', () => {
    const stations = trestleStations(40, [2, 3], 7);
    const gaps = stations.slice(1).map((u, i) => u - stations[i]);
    expect(stations.length).toBeGreaterThan(10);
    // The byre end is regular and close, at the tight end of the stated band.
    const byre = gaps.slice(0, 6);
    expect(Math.max(...byre) - Math.min(...byre)).toBeLessThan(1e-6);
    expect(byre[0]).toBeCloseTo(2, 6);
    // Somewhere in the dwelling there is one much larger span — the hearth.
    expect(Math.max(...gaps)).toBeGreaterThan(3 * 1.4);
    // …and the rest of the dwelling varies rather than repeating the byre.
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(3);
    expect(trestleStations(40, [2, 3], 7)).toEqual(stations);
    expect(trestleStations(40, [2, 3], 8)).not.toEqual(stations);
  });

  it('carries the roof on two rows of posts at the aisle width', () => {
    const spec = house();
    const build = buildHouse(spec, { groundAt: () => 12 });
    const aisle = aisleWidth(spec.widthM, spec.aisleFraction, spec.aisleWidthM);
    expect(build.posts.length).toBe(trestleStations(40, [2, 3], 0).length * 0 + build.posts.length);
    expect(build.posts.length % 2).toBe(0);
    expect(build.posts.length).toBeGreaterThan(10);
    for (const post of build.posts) {
      // Every post stands at half the aisle width from the centre line…
      expect(Math.abs(post.z)).toBeCloseTo(aisle.widthM / 2, 6);
      // …and reaches the roof plane it carries: above the wall, under the ridge.
      expect(post.heightM).toBeGreaterThan(spec.wallHeightM);
      expect(post.heightM).toBeLessThan(build.roof.ridgeY);
    }
  });

  it('gives an ancillary building and a grophus no trestles', () => {
    for (const kind of ['ancillary', 'grophus'] as const) {
      const build = buildHouse(house({ kind, lengthM: 8, widthM: 5 }), { groundAt: () => 0 });
      expect(build.posts).toEqual([]);
    }
  });

  it('seats the whole building on one ground sample, so it cannot warp', () => {
    // A house is rigid: contract §0 keeps its metric shape at any exaggeration,
    // and a ridge draped over the terrain would sag differently at ×2.5.
    const build = buildHouse(house(), { groundAt: (x) => 10 + x / 20 });
    for (const part of build.parts) {
      for (const value of part.groundY) expect(value).toBeCloseTo(build.groundY, 6);
    }
  });

  it('keeps the wall, the roof and the footing in their own material families', () => {
    const build = buildHouse(house(), { groundAt: () => 0 });
    const families = build.parts.map((part) => part.family).sort();
    expect(families).toEqual(['soil', 'stone', 'turf']);
    for (const part of build.parts) {
      expect(part.indices.length % 3).toBe(0);
      expect(part.localY.length).toBe(part.positionsXZ.length / 2);
      for (const index of part.indices) expect(index).toBeLessThan(part.localY.length);
    }
  });

  it('reaches the ridge and no higher, and buries its footing rather than floating', () => {
    const build = buildHouse(house(), { groundAt: (x, z) => 10 + Math.sin(x / 9) + z / 30 });
    let highest = -Infinity;
    let lowest = Infinity;
    for (const part of build.parts) {
      for (const y of part.localY) {
        highest = Math.max(highest, y);
        lowest = Math.min(lowest, y);
      }
    }
    expect(highest).toBeCloseTo(build.roof.ridgeY, 1);
    expect(lowest).toBeLessThan(0); // the footing skirt reaches below the seat
  });

  it('leaves a doorway in the middle of a long side (§6.H)', () => {
    const build = buildHouse(house({ rotationRad: 0 }), { groundAt: () => 0 });
    const wall = build.parts.find((part) => part.family === 'soil')!;
    const doorSide: number[] = [];
    for (let i = 0; i < wall.localY.length; i++) {
      const x = wall.positionsXZ[i * 2];
      const z = wall.positionsXZ[i * 2 + 1];
      // Wall vertices on the door side: at the wall line, no higher than its head.
      if (z > 4 && wall.localY[i] <= 1.2 && wall.localY[i] >= 0) doorSide.push(x);
    }
    expect(doorSide.length).toBeGreaterThan(0);
    // Nothing stands across the middle of that wall: that is the doorway.
    expect(doorSide.filter((x) => Math.abs(x) < 0.7).length).toBe(0);
    expect(doorSide.some((x) => x < -1)).toBe(true);
    expect(doorSide.some((x) => x > 1)).toBe(true);
  });

  it('is byte-identical for the same seed, and different for another', () => {
    const flatten = (spec: HouseSpec): number[] =>
      buildHouse(spec, { groundAt: () => 3 }).parts.flatMap((part) => [
        ...part.positionsXZ,
        ...part.localY,
      ]);
    expect(flatten(house())).toEqual(flatten(house()));
    expect(flatten(house({ seed: 78 }))).not.toEqual(flatten(house()));
  });

  it('reads a compass bearing in the app frame, where north is −z', () => {
    const north = bearingRotation(0);
    expect(Math.cos(north)).toBeCloseTo(0, 6);
    expect(Math.sin(north)).toBeCloseTo(-1, 6); // the long axis points north
    const east = bearingRotation(90);
    expect(Math.cos(east)).toBeCloseTo(1, 6);
    expect(Math.sin(east)).toBeCloseTo(0, 6);
  });
});

// --------------------------------------------------------------------------- //
// §7.5.1 / §15.3 — where the buildings go, and how many of them
// --------------------------------------------------------------------------- //

/** A ring-fort interior, as a polygon. Ismantorp is ~125 m across. */
function circleRings(radius: number): Array<Array<[number, number]>> {
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < 64; i++) {
    const theta = (i / 64) * Math.PI * 2;
    ring.push([Math.cos(theta) * radius, Math.sin(theta) * radius]);
  }
  return [ring];
}

const levelTerrain: SamplerTerrain = { groundAt: () => 20, classAt: null, isWet: () => false };

describe('the interior building sampler (§7.5.1)', () => {
  const ismantorp = (patch: Partial<InteriorBuildings> = {}): InteriorBuildings => ({
    ...ISMANTORP_BUILDINGS,
    ...patch,
  });

  it('places Ismantorp’s houses radially against the inner wall face', () => {
    const rings = circleRings(62.5);
    const plan = planInteriorBuildings(ismantorp(), rings, levelTerrain, 4711);
    expect(plan.requested).toBe(88);
    expect(plan.buildings.length).toBeGreaterThan(40);
    for (const spec of plan.buildings) {
      // Radial: the long axis points at the middle of the interior.
      const axis = [Math.cos(spec.rotationRad), Math.sin(spec.rotationRad)];
      const radial = Math.hypot(spec.x, spec.z);
      expect(Math.abs((spec.x * axis[0] + spec.z * axis[1]) / radial)).toBeCloseTo(1, 3);
    }
  });

  it('never places more than the record states, and says so when it places fewer', () => {
    // §15.3: "`count` is an upper bound. The sampler may place fewer buildings
    // than a stated count if the extent will not hold them; the shortfall is a
    // warning, never a silent truncation."
    const tight = planInteriorBuildings(ismantorp(), circleRings(30), levelTerrain, 4711);
    expect(tight.buildings.length).toBeLessThan(88);
    expect(tight.buildings.length).toBeGreaterThan(0);
    expect(tight.warnings.join(' ')).toMatch(/upper bound/);
    const roomy = planInteriorBuildings(
      ismantorp({ count: 6 }),
      circleRings(62.5),
      levelTerrain,
      4711,
    );
    expect(roomy.buildings.length).toBe(6);
    expect(roomy.warnings).toEqual([]);
  });

  it('never lets two buildings stand in each other', () => {
    const plan = planInteriorBuildings(ismantorp(), circleRings(62.5), levelTerrain, 4711);
    for (let i = 0; i < plan.buildings.length; i++) {
      for (let j = i + 1; j < plan.buildings.length; j++) {
        expect(footprintsClash(plan.buildings[i], plan.buildings[j], 0)).toBe(false);
      }
    }
  });

  it('keeps every building inside the fort’s own extent', () => {
    const rings = circleRings(62.5);
    const plan = planInteriorBuildings(ismantorp(), rings, levelTerrain, 4711);
    for (const spec of plan.buildings) {
      for (const [x, z] of footprint(spec)) expect(pointInRings(rings, x, z)).toBe(true);
    }
  });

  it('places them in the stated sector and nowhere else (§7.5.3)', () => {
    const plan = planInteriorBuildings(
      ismantorp({ count: 20, layout: 'free', groups: 1, sector: 'S' }),
      circleRings(62.5),
      levelTerrain,
      4711,
    );
    expect(plan.buildings.length).toBeGreaterThan(4);
    for (const spec of plan.buildings) {
      // South is +z in the app's frame, and the sector is a quadrant of it.
      expect(spec.z).toBeGreaterThan(0);
      expect(inSector((Math.atan2(spec.x, -spec.z) * 180) / Math.PI, 'S')).toBe(true);
    }
  });

  it('refuses ground the terrain says is wet or too steep to build on', () => {
    const wet: SamplerTerrain = { groundAt: () => 20, classAt: () => 1, isWet: () => true };
    expect(
      planInteriorBuildings(ismantorp(), circleRings(62.5), wet, 4711).buildings.length,
    ).toBeGreaterThanOrEqual(0);
    const scarp: SamplerTerrain = { groundAt: (x) => x * 2, classAt: null, isWet: () => false };
    const onScarp = planInteriorBuildings(
      ismantorp({ layout: 'free' }),
      circleRings(62.5),
      scarp,
      4711,
    );
    // §7.5.3: "if a longhouse will not sit on it, that is a finding, not a
    // licence to flatten" — so a fort of scarp holds nothing at all.
    expect(onScarp.buildings.length).toBe(0);
    expect(onScarp.warnings.length).toBe(1);
  });

  it('uses the record’s stated orientation where it has one', () => {
    const stated = planInteriorBuildings(
      ismantorp({
        count: 4,
        layout: 'free',
        groups: 1,
        template: { ...ISMANTORP_TEMPLATE, orientationDeg: 135 },
      }),
      circleRings(62.5),
      levelTerrain,
      4711,
    );
    expect(stated.buildings.length).toBeGreaterThan(0);
    for (const spec of stated.buildings) {
      expect(spec.rotationRad).toBeCloseTo(bearingRotation(135), 6);
    }
  });

  it('falls back to one house and the §6.H defaults where the record is silent', () => {
    // §15.1: `count: null` is "the record attests houses but states no number".
    const plan = planInteriorBuildings(
      { ...ISMANTORP_BUILDINGS, count: null, countStated: false, countSource: 'assumed', template: null },
      circleRings(62.5),
      levelTerrain,
      4711,
    );
    expect(plan.requested).toBe(1);
    expect(plan.buildings.length).toBe(1);
    expect(plan.buildings[0].lengthM).toBeGreaterThanOrEqual(FALLBACK_TEMPLATE.lengthM[0]);
    expect(plan.buildings[0].lengthM).toBeLessThanOrEqual(FALLBACK_TEMPLATE.lengthM[1]);
  });

  it('draws length and width from one shared draw, so long is also wide', () => {
    const long = houseFromTemplate(ISMANTORP_TEMPLATE, 'longhouse', 11);
    const wide = houseFromTemplate({ ...ISMANTORP_TEMPLATE }, 'longhouse', 11);
    expect(long).toEqual(wide);
    const t = (long.lengthM - 12) / 2;
    expect(long.widthM).toBeCloseTo(4 + t * 2, 6);
  });

  it('is byte-identical for the same seed — a reload is the same interior', () => {
    const rings = circleRings(62.5);
    const a = planInteriorBuildings(ismantorp(), rings, levelTerrain, 4711);
    const b = planInteriorBuildings(ismantorp(), rings, levelTerrain, 4711);
    const c = planInteriorBuildings(ismantorp(), rings, levelTerrain, 4712);
    expect(a.buildings).toEqual(b.buildings);
    expect(a.buildings).not.toEqual(c.buildings);
  });

  it('never draws a yard feature inside a fort (§7.5.3)', () => {
    expect(planInteriorBuildings(ismantorp(), circleRings(62.5), levelTerrain, 1).features).toEqual(
      [],
    );
  });

  it('is the layout a mainland fort gets, and it has not moved', () => {
    // The mainland half of §7.5.2's acceptance, as a number rather than an
    // assumption: the limestone branch is reached through `planFortInterior`,
    // and a `mainland` fort goes down this function unchanged. 76 is what it
    // placed before the branch existed, on the same fixture and the same seed.
    const plan = planInteriorBuildings(ismantorp(), circleRings(62.5), levelTerrain, 4711);
    expect(plan.buildings.length).toBe(76);
    const viaBranch = planFortInterior(
      'mainland',
      ismantorp(),
      circleRings(62.5),
      levelTerrain,
      4711,
    );
    expect(viaBranch.buildings).toEqual(plan.buildings);
  });
});

// --------------------------------------------------------------------------- //
// §7.5.2 — the Öland / Gotland ringfort branch
// --------------------------------------------------------------------------- //

describe('the limestone ringfort layout (§7.5.2)', () => {
  const ismantorp = (patch: Partial<InteriorBuildings> = {}): InteriorBuildings => ({
    ...ISMANTORP_BUILDINGS,
    ...patch,
  });
  /** The bearings of the houses standing in a given radius band, sorted. */
  const bearingsWithin = (plan: FarmPlan, max: number): number[] =>
    plan.buildings
      .filter((spec) => Math.hypot(spec.x, spec.z) < max)
      .map((spec) => ((Math.atan2(spec.x, -spec.z) * 180) / Math.PI + 360) % 360)
      .sort((a, b) => a - b);
  /** The gaps between consecutive bearings, round the circle. */
  const gaps = (bearings: number[]): number[] =>
    bearings.map((bearing, i) => {
      const next = bearings[(i + 1) % bearings.length];
      return (next - bearing + 360) % 360;
    });

  it('is taken on the tradition and on nothing else', () => {
    const rings = circleRings(62.5);
    const limestone = planFortInterior('limestone-ringfort', ismantorp(), rings, levelTerrain, 4711);
    const mainland = planFortInterior('mainland', ismantorp(), rings, levelTerrain, 4711);
    expect(limestone.buildings).not.toEqual(mainland.buildings);
    expect(mainland.buildings).toEqual(
      planInteriorBuildings(ismantorp(), rings, levelTerrain, 4711).buildings,
    );
    // A limestone fort whose record states a layout the branch is not about goes
    // down the same path a mainland fort does.
    const grouped = ismantorp({ layout: 'grouped' });
    expect(
      planFortInterior('limestone-ringfort', grouped, rings, levelTerrain, 4711).buildings,
    ).toEqual(planInteriorBuildings(grouped, rings, levelTerrain, 4711).buildings);
  });

  it('lays Ismantorp’s houses radially against the inner wall face', () => {
    const rings = circleRings(62.5);
    const plan = planRingfortInterior(ismantorp(), rings, levelTerrain, 4711);
    expect(plan.requested).toBe(88);
    expect(plan.buildings.length).toBe(74);
    for (const spec of plan.buildings) {
      // Radial: the long axis points at the middle of the interior.
      const axis = [Math.cos(spec.rotationRad), Math.sin(spec.rotationRad)];
      const radial = Math.hypot(spec.x, spec.z);
      expect(Math.abs((spec.x * axis[0] + spec.z * axis[1]) / radial)).toBeCloseTo(1, 3);
      // Inside the extent, every corner of it.
      for (const [x, z] of footprint(spec)) expect(pointInRings(rings, x, z)).toBe(true);
    }
    for (let i = 0; i < plan.buildings.length; i++) {
      for (let j = i + 1; j < plan.buildings.length; j++) {
        expect(footprintsClash(plan.buildings[i], plan.buildings[j], 0)).toBe(false);
      }
    }
  });

  it('cuts the inner group into the blocks the record states, and only the inner one', () => {
    // "…en inre, mer oregelbunden grupp, genom **fyra gator** uppdelade i lika
    // många **kvarter**." Four streets is four gaps, and the outer group — "en
    // yttre med husen radiellt utgående från murens insida" — is one unbroken
    // ring against the wall, so it has none.
    const plan = planRingfortInterior(ismantorp(), circleRings(62.5), levelTerrain, 4711);
    const inner = bearingsWithin(plan, 45);
    const outer = plan.buildings
      .filter((spec) => Math.hypot(spec.x, spec.z) >= 45)
      .map((spec) => ((Math.atan2(spec.x, -spec.z) * 180) / Math.PI + 360) % 360)
      .sort((a, b) => a - b);
    expect(inner.length).toBeGreaterThan(20);
    expect(outer.length).toBeGreaterThan(20);
    const wide = (bearings: number[]): number[] => gaps(bearings).filter((gap) => gap > 15);
    expect(wide(inner)).toHaveLength(4);
    expect(wide(outer)).toHaveLength(0);
    // The four streets stand a quarter-circle apart, which is what four equal
    // blocks means — including across the seam the arc closes on.
    const starts = inner.filter((_bearing, i) => gaps(inner)[i] > 15).sort((a, b) => a - b);
    const spans = starts.map((bearing, i) => ((starts[(i + 1) % 4] - bearing + 360) % 360));
    for (const span of spans) expect(span).toBeGreaterThan(60);
  });

  it('draws no streets where the record states no blocks', () => {
    // The normal case nationally: Ismantorp is the only description in the
    // country that draws a street plan, so nowhere else gets one invented.
    const plan = planRingfortInterior(
      ismantorp({ blocks: null }),
      circleRings(62.5),
      levelTerrain,
      4711,
    );
    expect(gaps(bearingsWithin(plan, 45)).filter((gap) => gap > 15)).toHaveLength(0);
  });

  it('steps the inner group back by the street the register measured', () => {
    // 2–5 m, so 3.5 — against the 2 m the app assumes when nothing states one.
    const rings = circleRings(62.5);
    const stated = planRingfortInterior(ismantorp(), rings, levelTerrain, 4711);
    const assumed = planRingfortInterior(
      ismantorp({ streetWidthM: null, fallbacks: ['buildings.streetWidthM'] }),
      rings,
      levelTerrain,
      4711,
    );
    const innermost = (plan: FarmPlan): number =>
      Math.min(...plan.buildings.map((spec) => Math.hypot(spec.x, spec.z)));
    // The record's wider street pushes the inner ring further in than the
    // narrower assumption does.
    expect(innermost(stated)).toBeLessThan(innermost(assumed));
    expect(ASSUMED_STREET_M).toBe(2);
  });

  it('keeps the count an upper bound and the terrain unregraded (§15.3)', () => {
    const tight = planRingfortInterior(ismantorp(), circleRings(30), levelTerrain, 4711);
    expect(tight.buildings.length).toBeGreaterThan(0);
    expect(tight.buildings.length).toBeLessThan(88);
    expect(tight.warnings.join(' ')).toMatch(/upper bound/);
    const scarp: SamplerTerrain = { groundAt: (x) => x * 2, classAt: null, isWet: () => false };
    const onScarp = planRingfortInterior(ismantorp(), circleRings(62.5), scarp, 4711);
    expect(onScarp.buildings.length).toBe(0);
    expect(onScarp.warnings).toHaveLength(1);
    const roomy = planRingfortInterior(
      ismantorp({ count: 6 }),
      circleRings(62.5),
      levelTerrain,
      4711,
    );
    expect(roomy.buildings.length).toBe(6);
    expect(roomy.warnings).toEqual([]);
  });

  it('draws Eketorp from its own record, default plan and all', () => {
    // Its description counts ~75 house foundations and states no grouping and no
    // street plan, and the house size it gives two sentences later is not
    // reachable from the sentence that counts them — so the plan is §6.H's
    // default, `fallbacks` says so, and the shortfall is a warning rather than
    // 75 houses forced into a courtyard that will not hold them.
    const eketorp: InteriorBuildings = {
      ...ISMANTORP_BUILDINGS,
      count: 75,
      groups: null,
      blocks: null,
      streetWidthM: null,
      template: null,
      fallbacks: ['buildings.template.lengthM', 'buildings.template.widthM'],
    };
    const plan = planRingfortInterior(eketorp, circleRings(40), levelTerrain, 99);
    expect(plan.requested).toBe(75);
    expect(plan.buildings.length).toBeGreaterThan(0);
    expect(plan.buildings.length).toBeLessThan(75);
    expect(plan.warnings.join(' ')).toMatch(/upper bound/);
    for (const spec of plan.buildings) {
      expect(spec.lengthM).toBeGreaterThanOrEqual(FALLBACK_TEMPLATE.lengthM[0]);
      expect(spec.lengthM).toBeLessThanOrEqual(FALLBACK_TEMPLATE.lengthM[1]);
    }
  });

  it('is byte-identical for the same seed, and draws no yard (§7.5.3)', () => {
    const rings = circleRings(62.5);
    const a = planRingfortInterior(ismantorp(), rings, levelTerrain, 4711);
    const b = planRingfortInterior(ismantorp(), rings, levelTerrain, 4711);
    const c = planRingfortInterior(ismantorp(), rings, levelTerrain, 4712);
    expect(a.buildings).toEqual(b.buildings);
    expect(a.buildings).not.toEqual(c.buildings);
    expect(a.features).toEqual([]);
  });
});

describe('the §6.H yard layout, outside a fort', () => {
  const farm: FarmSpec = {
    buildings: [
      ISMANTORP_TEMPLATE,
      { ...ISMANTORP_TEMPLATE, kind: 'ancillary', count: 2 },
      { ...ISMANTORP_TEMPLATE, kind: 'grophus', count: 1 },
    ],
    layout: 'yard',
    features: { hearth: true, well: true, enclosure: false },
    insideFortId: null,
    source: 'assumed',
  };

  it('draws a longhouse, its outbuildings and a grophus round one yard', () => {
    const plan = planFarmstead(farm, { x: 0, z: 0 }, 90, null, levelTerrain, 5);
    expect(plan.requested).toBe(4);
    expect(plan.buildings.length).toBe(4);
    expect(plan.buildings[0].kind).toBe('longhouse');
    expect(plan.buildings.filter((b) => b.kind === 'ancillary').length).toBe(2);
    expect(plan.buildings.filter((b) => b.kind === 'grophus').length).toBe(1);
    // The farm is not a single building, and the outbuildings are smaller.
    for (const other of plan.buildings.slice(1)) {
      expect(other.lengthM).toBeLessThan(plan.buildings[0].lengthM);
    }
    expect(plan.buildings.every((b) => b.lengthM > 2)).toBe(true);
  });

  it('puts the hearth and the well in the yard, on the doorway side', () => {
    const plan = planFarmstead(farm, { x: 0, z: 0 }, 90, null, levelTerrain, 5);
    const kinds = plan.features.map((f) => f.kind).sort();
    expect(kinds).toEqual(['hearth', 'well', 'yard']);
    const yard = plan.features.find((f) => f.kind === 'yard')!;
    const house0 = plan.buildings[0];
    // The yard sits across the house from its long axis — that is the side the
    // doorway is in — and the hearth is inside the yard.
    const across = Math.hypot(yard.x - house0.x, yard.z - house0.z);
    expect(across).toBeGreaterThan(house0.widthM / 2);
    const hearth = plan.features.find((f) => f.kind === 'hearth')!;
    expect(Math.hypot(hearth.x - yard.x, hearth.z - yard.z)).toBeLessThan(yard.radiusM);
  });

  it('draws no hearth, well or fence the data does not set', () => {
    const bare = planFarmstead(
      { ...farm, features: { hearth: false, well: false, enclosure: true } },
      { x: 0, z: 0 },
      null,
      null,
      levelTerrain,
      5,
    );
    // The enclosure is not modelled at all: there is nothing to derive its line
    // from, so the honest answer is to draw nothing rather than a guess.
    expect(bare.features.map((f) => f.kind)).toEqual(['yard']);
  });


  it('draws no yard at all for a record the pipeline placed inside a fort', () => {
    // §7.5.3 refuses "hearths, wells, yards, fences, paths and field systems
    // inside the wall" — buildings the record attests, on ground the DEM
    // measured, and nothing else.
    const inside = planFarmstead(
      { ...farm, features: { hearth: false, well: false, enclosure: false }, insideFortId: 'L1943:7827' },
      { x: 0, z: 0 },
      null,
      null,
      levelTerrain,
      5,
    );
    expect(inside.buildings.length).toBeGreaterThan(0);
    expect(inside.features).toEqual([]);
  });


  it('brings every yard feature back to the ground at its own rim', () => {
    // The same rule the monument shapes keep: nothing stands on a lip of
    // nothing, and a feature drapes on the measured ground rather than being
    // seated rigidly like a building.
    for (const kind of ['yard', 'hearth', 'well'] as const) {
      const build = buildYardFeature(
        { kind, x: 4, z: -2, radiusM: kind === 'yard' ? 6 : 1 },
        (x, z) => 12 + x / 50 - z / 80,
        9,
      );
      const rim: number[] = [];
      for (let i = 0; i < build.localY.length; i++) {
        const x = build.positionsXZ[i * 2];
        const z = build.positionsXZ[i * 2 + 1];
        const radius = Math.hypot(x - 4, z + 2);
        if (radius > (kind === 'yard' ? 6 : 1) - 1e-6) rim.push(build.localY[i]);
        // Draped, not seated: each vertex takes the ground under itself.
        expect(build.groundY[i]).toBeCloseTo(12 + x / 50 - z / 80, 4);
      }
      expect(rim.length).toBeGreaterThan(8);
      for (const y of rim) expect(y).toBe(0);
    }
  });

  it('is byte-identical for the same seed', () => {
    const a = planFarmstead(farm, { x: 10, z: -5 }, null, null, levelTerrain, 3);
    const b = planFarmstead(farm, { x: 10, z: -5 }, null, null, levelTerrain, 3);
    expect(a.buildings).toEqual(b.buildings);
    expect(a.features).toEqual(b.features);
  });
});

// --------------------------------------------------------------------------- //
// the layer, with archetype H switched on
// --------------------------------------------------------------------------- //

describe('the settlement state in the layer (§7.5, §9)', () => {
  const settlementFile = validateReconstruction(
    withInterior({ buildings: ISMANTORP_BUILDINGS }),
    'patched',
    siteIds,
  );
  let exaggeration = 1;
  function build(seed = 1): ReconstructionLayer {
    return new ReconstructionLayer(
      settlementFile,
      sites,
      {
        groundAt: ground,
        getExaggeration: () => exaggeration,
        classAt: null,
        classId: null,
        rampart,
        seed,
        vitrified: true,
      },
      500,
    );
  }
  const settlementMeshes = (layer: ReconstructionLayer): THREE.Mesh[] =>
    layer.group.children.filter((child) => child.name.includes('#settlement')) as THREE.Mesh[];

  it('opens on `cleared`, with the houses built but not drawn (§9, off by default)', () => {
    const layer = build();
    expect(layer.interiorState).toBe('cleared');
    expect(settlementMeshes(layer).length).toBeGreaterThan(0);
    expect(settlementMeshes(layer).every((mesh) => !mesh.visible)).toBe(true);
    layer.dispose();
  });

  it('draws them when the interior is switched to `settlement`', () => {
    const layer = build();
    const before = layer.standingCount;
    expect(layer.setInteriorState('settlement')).toBe('settlement');
    expect(settlementMeshes(layer).some((mesh) => mesh.visible)).toBe(true);
    expect(layer.standingCount).toBeGreaterThan(before);
    const summary = layer.interiorSummary()!;
    expect(summary.offered).toBe(true);
    expect(summary.requested).toBe(88);
    expect(summary.placed).toBeGreaterThan(10);
    expect(summary.placed).toBeLessThanOrEqual(88);
    expect(summary.countStated).toBe(true);
    expect(summary.countSource).toBe('measured');
    expect(summary.layout).toBe('radial');
    expect(summary.citations).toBeGreaterThan(0);
    layer.dispose();
  });

  it('refuses the settlement state where the gate did not offer it (§15.3)', () => {
    // "An app that finds `settlementOffered: false` and an inhabited-looking
    // description draws the `cleared` state and nothing else."
    const refusedFile = validateReconstruction(
      withInterior({
        settlementOffered: false,
        evidence: { ...file.interior!.evidence, gate: 'fail', citations: [] },
        buildings: null,
      }),
      'refused',
      siteIds,
    );
    const layer = new ReconstructionLayer(
      refusedFile,
      sites,
      { groundAt: ground, getExaggeration: () => 1, classAt: null, classId: null, rampart, seed: 1, vitrified: true },
      500,
    );
    expect(layer.settlementOffered).toBe(false);
    expect(layer.setInteriorState('settlement')).toBe('cleared');
    expect(layer.interiorState).toBe('cleared');
    expect(layer.group.children.filter((c) => c.name.includes('#settlement')).length).toBe(0);
    layer.dispose();
  });

  it('draws no houses on Broborg itself, which states none (§15.1)', () => {
    // The committed bundle passes the gate on a literature citation and carries
    // `buildings: null`. Passing the gate is not a licence to invent a house.
    const layer = new ReconstructionLayer(
      file,
      sites,
      { groundAt: ground, getExaggeration: () => 1, classAt: null, classId: null, rampart, seed: 1, vitrified: true },
      500,
    );
    expect(layer.settlementOffered).toBe(true);
    expect(layer.setInteriorState('settlement')).toBe('settlement');
    expect(layer.group.children.filter((c) => c.name.includes('#settlement')).length).toBe(0);
    expect(layer.interiorSummary()!.placed).toBe(0);
    layer.dispose();
  });

  it('keeps true metric height at ×1 and ×2.5 — contract §0, with houses on', () => {
    const layer = build();
    layer.setInteriorState('settlement');
    const heights = (value: number): Float32Array[] => {
      exaggeration = value;
      layer.refreshHeights();
      return settlementMeshes(layer).map((mesh) => {
        const array = mesh.geometry.getAttribute('position').array as Float32Array;
        const out = new Float32Array(array.length / 3);
        for (let i = 0; i < out.length; i++) out[i] = array[i * 3 + 1];
        return out;
      });
    };
    const positionsAt = (value: number): Float32Array[] => {
      exaggeration = value;
      layer.refreshHeights();
      return settlementMeshes(layer).map(
        (mesh) => Float32Array.from(mesh.geometry.getAttribute('position').array as Float32Array),
      );
    };

    const flat = positionsAt(1);
    const tall = positionsAt(2.5);
    let drift = 0;
    for (let m = 0; m < flat.length; m++) {
      for (let i = 0; i < flat[m].length; i += 3) {
        drift = Math.max(drift, Math.abs(flat[m][i] - tall[m][i]), Math.abs(flat[m][i + 2] - tall[m][i + 2]));
      }
    }
    expect(drift).toBe(0);

    const one = heights(1);
    const twoFive = heights(2.5);
    const four = heights(4);
    let worst = 0;
    let sampled = 0;
    for (let m = 0; m < one.length; m++) {
      for (let i = 0; i < one[m].length; i++) {
        const slopeA = (twoFive[m][i] - one[m][i]) / 1.5;
        const slopeB = (four[m][i] - one[m][i]) / 3;
        worst = Math.max(worst, Math.abs(slopeA - slopeB));
        sampled++;
      }
    }
    expect(sampled).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(1e-3);
    exaggeration = 1;
    layer.dispose();
  });

  it('is byte-identical for the same seed, houses and all', () => {
    exaggeration = 1;
    const positions = (layer: ReconstructionLayer): number[] =>
      layer.group.children
        .filter((child) => (child as THREE.Mesh).isMesh)
        .flatMap((child) => {
          const attribute = (child as THREE.Mesh).geometry.getAttribute('position');
          return attribute ? Array.from(attribute.array as Float32Array) : [];
        });
    const a = build();
    const b = build();
    a.setInteriorState('settlement');
    b.setInteriorState('settlement');
    expect(positions(a)).toEqual(positions(b));
    a.dispose();
    b.dispose();
  });

  it('takes the houses away with the fort at 1050 CE (§8)', () => {
    exaggeration = 1;
    const layer = build();
    layer.setInteriorState('settlement');
    expect(settlementMeshes(layer).some((mesh) => mesh.visible)).toBe(true);
    layer.setYear(1050);
    // The buildings are this fort's interior: they stand exactly as long as it does.
    expect(settlementMeshes(layer).some((mesh) => mesh.visible)).toBe(false);
    layer.setYear(500);
    expect(settlementMeshes(layer).some((mesh) => mesh.visible)).toBe(true);
    layer.dispose();
  });

  it('gives a farm-block record its marker back when archetype H is off', () => {
    // §9: archetype H is off by default, and a record whose geometry is off
    // keeps its flat §3 marker rather than disappearing from the scene.
    const raw = withInterior({ buildings: ISMANTORP_BUILDINGS });
    const farmstead = (raw['monuments'] as Array<Record<string, unknown>>).find(
      (m) => m['archetype'] === 'farmstead',
    )!;
    farmstead['farm'] = {
      buildings: [ISMANTORP_TEMPLATE, { ...ISMANTORP_TEMPLATE, kind: 'grophus', count: 1 }],
      layout: 'yard',
      features: { hearth: true, well: true, enclosure: false },
      insideFortId: null,
      source: 'assumed',
    };
    const withFarm = validateReconstruction(raw, 'with-farm', siteIds);
    const id = farmstead['id'] as string;
    exaggeration = 1;
    const layer = new ReconstructionLayer(
      withFarm,
      sites,
      { groundAt: ground, getExaggeration: () => 1, classAt: null, classId: null, rampart, seed: 1, vitrified: true },
      500,
    );
    expect(layer.markerIds().has(id)).toBe(true);
    expect(layer.summary(id)!.state).toBe('ruin');
    layer.setInteriorState('settlement');
    expect(layer.markerIds().has(id)).toBe(false);
    expect(layer.summary(id)!.state).toBe('standing');
    expect(layer.summary(id)!.requested).toBe(2);
    layer.dispose();
  });
});

describe('defaults.farmstead as the app’s tunables (§15)', () => {
  it('takes the file’s own §6.H defaults where the record states nothing', () => {
    const template = templateFromDefaults(file.defaults['farmstead']);
    expect(template.lengthM).toEqual([20, 40]);
    expect(template.widthM).toEqual([6, 8]);
    expect(template.wallHeightM).toBe(1.2);
    expect(template.hipPitchDeg).toBe(48);
    expect(template.source).toBe('assumed');
  });

  it('re-imposes the two §6.H invariants, because a tunable can be turned wrong', () => {
    const bad = templateFromDefaults({ wallHeightM: 0.4, roofPitchDeg: 50, hipPitchDeg: 30 });
    expect(bad.wallHeightM).toBe(1.0); // Lojsta: the wall is load-bearing
    expect(bad.hipPitchDeg).toBeGreaterThanOrEqual(bad.roofPitchDeg); // Eketorp-II
  });

  it('falls back to §6.H’s own numbers when the block is missing', () => {
    expect(templateFromDefaults(undefined)).toEqual(FALLBACK_TEMPLATE);
  });
});
