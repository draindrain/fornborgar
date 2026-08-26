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
  type Monument,
  type ReconstructionFile,
} from '../src/overlays/reconstruction/schema';
import {
  ReconstructionLayer,
  RENDERED_ARCHETYPES,
  localRings,
  monumentState,
} from '../src/overlays/reconstruction/layer';
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

  it('leaves the farmstead archetype out of this pass entirely (§6.H)', () => {
    expect(RENDERED_ARCHETYPES.has('farmstead')).toBe(false);
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
    const build = buildShape(spec({ archetype: 'cairn', kind: 'cone', heightM: 2 }));
    const vertices = build.offsets.length / 3;
    let minY = Infinity;
    for (let i = 0; i < vertices; i++) minY = Math.min(minY, build.offsets[i * 3 + 1]);
    expect(minY).toBe(0);
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

  it('gives every drawn record a click target', () => {
    expect(layer.pickables.length).toBeGreaterThan(50);
    for (const pick of layer.pickables) expect(pick.userData['siteId']).toBeTruthy();
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
