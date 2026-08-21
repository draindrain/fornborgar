/**
 * The Phase-7 vegetation layer (contract §9 "Rendering contract", PLAN §4.7).
 *
 * Four things are worth pinning down, because breaking any of them makes the app
 * quietly lie about a model:
 *   • **sampling** — instances land only where the class raster says that class is,
 *     and the density slider scales every class together (§10);
 *   • **determinism** — the same seed is the same landscape everywhere, so a
 *     screenshot is reproducible (the palisade rule, `lib/random`);
 *   • **metric size on exaggerated ground** — a 13 m tree is 13 m at ×1 and at ×2.5,
 *     it just stands higher (contract §0);
 *   • **nothing stands in the sea** — instances whose ground is wet at the current
 *     slider level are suppressed, and come back when the level drops (§9/§7).
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { LandcoverGrid } from '../src/landcover/landcoverGrid';
import { validateLandcoverLegend, type LandcoverLegend } from '../src/landcover/legend';
import {
  DEFAULT_VEGETATION_PARAMS,
  VEGETATION_FORMS,
  VegetationLayer,
  sampleLandcoverVegetation,
  sampleShoreBand,
  sampleVegetation,
} from '../src/landcover/vegetation';

// A 16 x 16 grid at 2 m: 32 m square, 0.1024 ha. The densities below are absurd for
// real vegetation and deliberately so — they keep the instance counts meaningful in
// a fixture this small.
const SIZE = 16;
const BOUNDS = { minX: -16, minZ: -16, maxX: 16, maxZ: 16 };

/** West half conifer, south quarter reeds, the rest open (no vegetation). */
function makeGrid(): LandcoverGrid {
  const classes = new Uint8Array(SIZE * SIZE);
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      classes[row * SIZE + col] = row >= 12 ? 2 : col < 8 ? 1 : 0;
    }
  }
  return { width: SIZE, height: SIZE, resolution: 2, boundsLocal: BOUNDS, classes };
}

function makeLegend(): LandcoverLegend {
  return validateLandcoverLegend({
    schemaVersion: 1,
    site: 'unit',
    referenceYearCE: 500,
    referenceLevelM: 8,
    method: 'unit fixture',
    caveat: 'unit fixture',
    calibration: 'unit fixture',
    classes: [
      { index: 0, id: 'open', name: 'Open', color: '#a9a267', rule: 'the rest', vegetation: null },
      {
        index: 1,
        id: 'wood',
        name: 'Conifer',
        color: '#33512f',
        rule: 'west half',
        vegetation: { type: 'conifer', densityPerHa: 5000 },
      },
      {
        index: 2,
        id: 'fen',
        name: 'Reeds',
        color: '#7f9455',
        rule: 'south quarter',
        vegetation: { type: 'reeds', densityPerHa: 8000 },
      },
    ],
  });
}

/**
 * The v1.3 variant of the same legend: two runtime-only classes appended — the
 * dynamic sea and the dynamic shore band. Neither owns a cell in the raster (whose
 * values stay 0–2), which is exactly the shape the contract describes for a class the
 * app derives at the current level (§9/§10 v1.3).
 */
const BAND_M = 0.5;
const BAND_CLASS = 4;
function makeDynamicLegend(): LandcoverLegend {
  const doc = JSON.parse(JSON.stringify(makeLegend())) as { classes: Record<string, unknown>[] };
  doc.classes.push(
    {
      index: 3,
      id: 'sea',
      name: 'Open water',
      color: '#2d5a6b',
      rule: 'derived at the current level',
      vegetation: null,
      dynamic: { kind: 'water' },
    },
    {
      index: BAND_CLASS,
      id: 'shore_reeds',
      name: 'Shore reed belt',
      color: '#77875a',
      rule: 'derived at the current level',
      vegetation: { type: 'reeds', densityPerHa: 8000 },
      dynamic: { kind: 'shore-band', bandM: BAND_M },
    },
  );
  return validateLandcoverLegend(doc);
}

const grid = makeGrid();
const legend = makeLegend();
const dynamicLegend = makeDynamicLegend();

/** A ground surface that is a plain function of x, so expectations stay exact. */
const ground = (x: number, _z: number): number => 10 + x * 0.1;
/** A connect surface that rises west -> east, so a level cuts the extent in half-ish. */
const connect = (x: number, _z: number): number => 5 + x * 0.1;

function layerOn(exaggeration: { value: number }, seed = DEFAULT_VEGETATION_PARAMS.seed): VegetationLayer {
  return new VegetationLayer(
    grid,
    legend,
    { groundAt: ground, getExaggeration: () => exaggeration.value, connectAt: connect },
    { seed },
  );
}

/** connect runs 3.4 … 6.6 across the fixture, so this range covers all of it. */
const LEVEL_RANGE: [number, number] = [4, 6];

/** The same layer with the v1.3 dynamic legend and a slider range in play. */
function dynamicLayer(seed = DEFAULT_VEGETATION_PARAMS.seed, exaggeration = 1): VegetationLayer {
  return new VegetationLayer(
    grid,
    dynamicLegend,
    {
      groundAt: ground,
      getExaggeration: () => exaggeration,
      connectAt: connect,
      levelRange: LEVEL_RANGE,
    },
    { seed },
  );
}

/** Raster class under a local (x, z), the way the sampler's exclusion test reads it. */
function classAt(x: number, z: number): number {
  const col = Math.round((x - BOUNDS.minX) / 2 - 0.5);
  const row = Math.round((z - BOUNDS.minZ) / 2 - 0.5);
  return grid.classes[row * SIZE + col];
}

/**
 * `Matrix4.decompose` reports scale (1, 1, 1) for a degenerate matrix, which is
 * exactly what a suppressed instance has — so the size comes from the column lengths
 * instead, where a zero-scaled instance really does read as zero.
 */
function decompose(layer: VegetationLayer, type: 'conifer' | 'reeds', index: number) {
  const matrix = layer.instanceMatrix(type, index);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const decomposed = new THREE.Vector3();
  matrix.decompose(position, quaternion, decomposed);
  const column = (i: number) => new THREE.Vector3().setFromMatrixColumn(matrix, i).length();
  const scale = new THREE.Vector3(column(0), column(1), column(2));
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  return { position, quaternion, scale, tiltDeg: THREE.MathUtils.radToDeg(up.angleTo(new THREE.Vector3(0, 1, 0))) };
}

// ------------------------------------------------------------- sampling -----

describe('vegetation sampling (contract §9/§10)', () => {
  it('places instances only where the raster says that class is', () => {
    const sample = sampleVegetation(grid, legend, { seed: 3, densityScale: 1 });
    expect(sample.total).toBeGreaterThan(50);
    for (const batch of sample.byType) {
      const wanted = batch.type === 'conifer' ? 1 : 2;
      for (let i = 0; i < batch.x.length; i++) {
        const col = Math.round((batch.x[i] - BOUNDS.minX) / 2 - 0.5);
        const row = Math.round((batch.z[i] - BOUNDS.minZ) / 2 - 0.5);
        expect(grid.classes[row * SIZE + col]).toBe(wanted);
        expect(batch.classIndex[i]).toBe(wanted);
      }
    }
  });

  it('is a pure function of the seed', () => {
    const a = sampleVegetation(grid, legend, { seed: 7, densityScale: 1 });
    const b = sampleVegetation(grid, legend, { seed: 7, densityScale: 1 });
    expect(a.total).toBe(b.total);
    for (let t = 0; t < a.byType.length; t++) {
      expect(Array.from(a.byType[t].x)).toEqual(Array.from(b.byType[t].x));
      expect(Array.from(a.byType[t].z)).toEqual(Array.from(b.byType[t].z));
    }
    const other = sampleVegetation(grid, legend, { seed: 8, densityScale: 1 });
    expect(Array.from(other.byType[0].x)).not.toEqual(Array.from(a.byType[0].x));
  });

  it('scales every class together with the global density (§10: never per class)', () => {
    const one = sampleVegetation(grid, legend, { seed: 1, densityScale: 1 });
    const half = sampleVegetation(grid, legend, { seed: 1, densityScale: 0.5 });
    expect(half.total).toBeLessThan(one.total);
    for (const type of ['conifer', 'reeds'] as const) {
      const before = one.byType.find((t) => t.type === type)!.x.length;
      const after = half.byType.find((t) => t.type === type)!.x.length;
      expect(after).toBeLessThan(before);
      // Halving the density roughly halves each class's share; the lattice makes it
      // exact only in the limit, so allow a generous band.
      expect(after / before).toBeGreaterThan(0.3);
      expect(after / before).toBeLessThan(0.75);
    }
  });

  it('caps the total proportionally rather than dropping a class', () => {
    const uncapped = sampleVegetation(grid, legend, { seed: 1, densityScale: 1 });
    const capped = sampleVegetation(grid, legend, { seed: 1, densityScale: 1 }, 40);
    expect(uncapped.capped).toBe(false);
    expect(capped.capped).toBe(true);
    expect(capped.total).toBeLessThanOrEqual(40);
    expect(capped.appliedScale).toBeLessThan(1);
    // Both forms survive the thinning — the cap is global, not per class.
    expect(capped.byType.map((t) => t.type).sort()).toEqual(['conifer', 'reeds']);
  });
});

// ------------------------------------------------- instance transforms ------

describe('vegetation instance transforms (contract §0)', () => {
  it('stands every plant on the exaggerated ground, at its true metric size', () => {
    const exaggeration = { value: 1 };
    const layer = layerOn(exaggeration);
    layer.setWaterLevel(null); // nothing suppressed, so every scale is the plant's own
    expect(layer.count).toBeGreaterThan(50);

    const before = [0, 5, 17].map((i) => decompose(layer, 'conifer', i));
    for (const { position, scale } of before) {
      expect(position.y).toBeCloseTo(ground(position.x, position.z), 5);
      expect(scale.y).toBeGreaterThan(VEGETATION_FORMS.conifer.heightM * (1 - VEGETATION_FORMS.conifer.heightJitter) - 1e-6);
      expect(scale.y).toBeLessThan(VEGETATION_FORMS.conifer.heightM * (1 + VEGETATION_FORMS.conifer.heightJitter) + 1e-6);
    }

    exaggeration.value = 2.5;
    layer.refreshHeights();
    [0, 5, 17].forEach((index, k) => {
      const after = decompose(layer, 'conifer', index);
      // Exaggeration moves Y only: same XZ, same size, ground * 2.5.
      expect(after.position.x).toBeCloseTo(before[k].position.x, 6);
      expect(after.position.z).toBeCloseTo(before[k].position.z, 6);
      expect(after.position.y).toBeCloseTo(ground(after.position.x, after.position.z) * 2.5, 5);
      expect(after.scale.y).toBeCloseTo(before[k].scale.y, 6);
      expect(after.scale.x).toBeCloseTo(before[k].scale.x, 6);
    });
    layer.dispose();
  });

  it('is reproducible for a seed and different for another', () => {
    const a = layerOn({ value: 1 }, 5);
    const b = layerOn({ value: 1 }, 5);
    expect(a.count).toBe(b.count);
    for (const i of [0, 3, 11]) {
      expect(Array.from(a.instanceMatrix('conifer', i).elements)).toEqual(
        Array.from(b.instanceMatrix('conifer', i).elements),
      );
    }
    const c = layerOn({ value: 1 }, 6);
    expect(Array.from(c.instanceMatrix('conifer', 0).elements)).not.toEqual(
      Array.from(a.instanceMatrix('conifer', 0).elements),
    );
    for (const layer of [a, b, c]) layer.dispose();
  });

  it('leans plants by no more than the form envelope', () => {
    const layer = layerOn({ value: 1 });
    layer.setWaterLevel(null);
    const maxDeg = (THREE.MathUtils.radToDeg(VEGETATION_FORMS.conifer.leanRad) * Math.SQRT2) + 0.2;
    for (let i = 0; i < 20; i++) expect(decompose(layer, 'conifer', i).tiltDeg).toBeLessThan(maxDeg);
    layer.dispose();
  });

  it('starts hidden and lives outside the terrain group', () => {
    const layer = layerOn({ value: 1 });
    expect(layer.group.visible).toBe(false);
    expect(layer.isEnabled).toBe(false);
    layer.setEnabled(true);
    expect(layer.group.visible).toBe(true);
    // A group with no parent: main.ts adds it to the scene, never to terrain.group,
    // so the terrain's Y scale can never stretch the plants.
    expect(layer.group.parent).toBeNull();
    layer.dispose();
  });

  it('rebuilds on a seed or density change', () => {
    const layer = layerOn({ value: 1 });
    const before = layer.count;
    layer.setParams({ densityScale: 0.5 });
    expect(layer.count).toBeLessThan(before);
    layer.setParams({ densityScale: 1 });
    expect(layer.count).toBe(before);
    layer.dispose();
  });
});

// ------------------------------------------------------ water suppression ---

describe('vegetation vs. the shoreline slider (contract §9)', () => {
  it('hides exactly the instances whose ground is wet at the level, and only those', () => {
    const layer = layerOn({ value: 1 });
    layer.setWaterLevel(null);
    expect(layer.visibleCount).toBe(layer.count);

    const level = 5.0; // connect = 5 + 0.1x, so everything with x <= 0 is wet
    layer.setWaterLevel(level);
    expect(layer.waterLevel).toBe(level);

    let expectedHidden = 0;
    for (const type of ['conifer', 'reeds'] as const) {
      const counts = layer.countsByType();
      for (let i = 0; i < counts[type]; i++) {
        const { position, scale } = decompose(layer, type, i);
        const wet = connect(position.x, position.z) <= level;
        expect(layer.isSuppressed(type, i)).toBe(wet);
        // Suppressed instances collapse to zero scale; the rest keep their size.
        if (wet) {
          expect(scale.y).toBe(0);
          expectedHidden++;
        } else {
          expect(scale.y).toBeGreaterThan(0);
        }
      }
    }
    expect(expectedHidden).toBeGreaterThan(0);
    expect(layer.visibleCount).toBe(layer.count - expectedHidden);

    // Scrubbing back to a lower level brings them back — no resampling involved.
    layer.setWaterLevel(-99);
    expect(layer.visibleCount).toBe(layer.count);
    layer.dispose();
  });

  it('suppresses nothing when the site ships no connectivity grid', () => {
    const layer = new VegetationLayer(grid, legend, {
      groundAt: ground,
      getExaggeration: () => 1,
      connectAt: null,
    });
    layer.setWaterLevel(1e6);
    expect(layer.visibleCount).toBe(layer.count);
    layer.dispose();
  });
});

// -------------------------------------------- v1.3 dynamic shore band -------

describe('dynamic shore band — candidates (contract §9/§10 v1.3)', () => {
  it('is absent for a legend with no shore-band class (the pre-v1.3 path)', () => {
    expect(sampleShoreBand(grid, legend, { seed: 1, densityScale: 1 }, connect, LEVEL_RANGE)).toBeNull();
    const layer = layerOn({ value: 1 });
    expect(layer.bandM).toBe(0);
    expect(layer.bandCapacity).toBe(0);
    expect(layer.bandCount).toBe(0);
    expect(layer.bandInstancedMesh).toBeNull();
    // Without a band, `count` is still exactly the static instances placed.
    const staticTotal = Object.values(layer.countsByType()).reduce((n, v) => n + v, 0);
    expect(layer.count).toBe(staticTotal);
    layer.dispose();
  });

  it('covers exactly the slider domain, sorted, never on water or reed cells', () => {
    const band = sampleShoreBand(grid, dynamicLegend, { seed: 1, densityScale: 1 }, connect, LEVEL_RANGE)!;
    expect(band).not.toBeNull();
    expect(band.classIndex).toBe(BAND_CLASS);
    expect(band.bandM).toBe(BAND_M);
    expect(band.count).toBeGreaterThan(50);

    for (let i = 0; i < band.count; i++) {
      if (i > 0) expect(band.connect[i]).toBeGreaterThanOrEqual(band.connect[i - 1]);
      // The domain is the union of every window the slider can ask for.
      expect(band.connect[i]).toBeGreaterThan(LEVEL_RANGE[0]);
      expect(band.connect[i]).toBeLessThanOrEqual(LEVEL_RANGE[1] + BAND_M);
      expect(band.connect[i]).toBeCloseTo(connect(band.x[i], band.z[i]), 4);
      // Never on the dynamic water class, never on a class that carries reeds
      // itself — no double planting on a fen (§9 v1.3).
      expect(classAt(band.x[i], band.z[i])).not.toBe(2);
      expect(band.height[i]).toBeGreaterThan(0);
      expect(band.width[i]).toBeGreaterThan(0);
    }
    expect(band.capacity).toBeGreaterThan(0);
    expect(band.capacity).toBeLessThanOrEqual(band.count);
  });

  it("never plants on the water class's own raster cells", () => {
    // The fixture's runtime sea owns no cells (the realistic v1.3 shape), so move the
    // `water` marker onto class 0, which does, and watch those cells drop out.
    const doc = JSON.parse(JSON.stringify(dynamicLegend)) as { classes: Record<string, unknown>[] };
    delete doc.classes[3]['dynamic'];
    doc.classes[0]['dynamic'] = { kind: 'water' };
    const seaHasCells = validateLandcoverLegend(doc);

    const params = { seed: 1, densityScale: 1 };
    const band = sampleShoreBand(grid, seaHasCells, params, connect, LEVEL_RANGE)!;
    const unrestricted = sampleShoreBand(grid, dynamicLegend, params, connect, LEVEL_RANGE)!;
    expect(band.count).toBeGreaterThan(0);
    for (let i = 0; i < band.count; i++) expect(classAt(band.x[i], band.z[i])).not.toBe(0);
    // ...and the exclusion is what made the difference, not an empty domain.
    expect(unrestricted.count).toBeGreaterThan(band.count);
  });

  it('is a pure function of the seed, and the seed alone', () => {
    const a = sampleShoreBand(grid, dynamicLegend, { seed: 9, densityScale: 1 }, connect, LEVEL_RANGE)!;
    const b = sampleShoreBand(grid, dynamicLegend, { seed: 9, densityScale: 1 }, connect, LEVEL_RANGE)!;
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.height)).toEqual(Array.from(b.height));
    const other = sampleShoreBand(grid, dynamicLegend, { seed: 10, densityScale: 1 }, connect, LEVEL_RANGE)!;
    expect(Array.from(other.x)).not.toEqual(Array.from(a.x));
  });
});

describe('dynamic shore band — the window follows the slider (contract §9 v1.3)', () => {
  it('stands every band instance in (level, level + bandM], on dry non-reed ground', () => {
    const layer = dynamicLayer();
    expect(layer.bandM).toBe(BAND_M);

    for (const level of [4.1, 4.6, 5.0, 5.5, 5.9]) {
      layer.setWaterLevel(level);
      const k = layer.bandCount;
      expect(k).toBeGreaterThan(0);
      expect(k).toBeLessThanOrEqual(layer.bandCapacity);
      expect(layer.bandInstancedMesh!.count).toBe(k);

      for (let slot = 0; slot < k; slot++) {
        const c = layer.bandConnectAt(slot);
        expect(c).toBeGreaterThan(level);
        expect(c).toBeLessThanOrEqual(level + BAND_M);

        const position = new THREE.Vector3().setFromMatrixPosition(layer.bandInstanceMatrix(slot));
        expect(connect(position.x, position.z)).toBeCloseTo(c, 4);
        expect(classAt(position.x, position.z)).not.toBe(2); // never on the static fen
        // Standing on the ground at true metric size, like every other plant (§0).
        expect(position.y).toBeCloseTo(ground(position.x, position.z), 4);
        const height = new THREE.Vector3().setFromMatrixColumn(layer.bandInstanceMatrix(slot), 1).length();
        expect(height).toBeGreaterThan(VEGETATION_FORMS.reeds.heightM * (1 - VEGETATION_FORMS.reeds.heightJitter) - 1e-5);
        expect(height).toBeLessThan(VEGETATION_FORMS.reeds.heightM * (1 + VEGETATION_FORMS.reeds.heightJitter) + 1e-5);
      }
    }

    // "No level in play" empties the belt rather than stranding it somewhere.
    layer.setWaterLevel(null);
    expect(layer.bandCount).toBe(0);
    expect(layer.bandInstancedMesh!.count).toBe(0);
    layer.dispose();
  });

  it('never exceeds its capacity anywhere in the slider range', () => {
    const layer = dynamicLayer();
    let widest = 0;
    for (let level = LEVEL_RANGE[0]; level <= LEVEL_RANGE[1] + 1e-9; level += 0.05) {
      layer.setWaterLevel(level);
      expect(layer.bandCount).toBeLessThanOrEqual(layer.bandCapacity);
      widest = Math.max(widest, layer.bandCount);
    }
    // The capacity is the *measured* widest window, so it is reached, not padded.
    expect(widest).toBeGreaterThan(0);
    expect(widest).toBeLessThanOrEqual(layer.bandCapacity);
    layer.dispose();
  });

  it('is bit-identical for a seed, and a survivor keeps its transform across levels', () => {
    const a = dynamicLayer(5);
    const b = dynamicLayer(5);
    a.setWaterLevel(4.7);
    b.setWaterLevel(4.7);
    expect(a.bandCount).toBe(b.bandCount);
    expect(a.bandCount).toBeGreaterThan(0);
    for (let slot = 0; slot < a.bandCount; slot++) {
      expect(Array.from(a.bandInstanceMatrix(slot).elements)).toEqual(Array.from(b.bandInstanceMatrix(slot).elements));
    }

    // The level selects membership only: a reed present at both levels must have the
    // very same matrix at both (the seven-draws-per-cell rule in `sampleShoreBand`).
    const key = (m: THREE.Matrix4): string => `${m.elements[12]},${m.elements[14]}`;
    const before = new Map<string, number[]>();
    for (let slot = 0; slot < a.bandCount; slot++) {
      const m = a.bandInstanceMatrix(slot);
      before.set(key(m), Array.from(m.elements));
    }

    a.setWaterLevel(4.72);
    let survivors = 0;
    for (let slot = 0; slot < a.bandCount; slot++) {
      const m = a.bandInstanceMatrix(slot);
      const previous = before.get(key(m));
      if (!previous) continue;
      survivors++;
      expect(Array.from(m.elements)).toEqual(previous);
    }
    expect(survivors).toBeGreaterThan(10);

    for (const layer of [a, b]) layer.dispose();
  });

  it('re-seats the belt when the exaggeration changes', () => {
    let exaggeration = 1;
    const layer = new VegetationLayer(
      grid,
      dynamicLegend,
      { groundAt: ground, getExaggeration: () => exaggeration, connectAt: connect, levelRange: LEVEL_RANGE },
      { seed: 2 },
    );
    layer.setWaterLevel(5.0);
    const before = new THREE.Vector3().setFromMatrixPosition(layer.bandInstanceMatrix(0));
    exaggeration = 2.5;
    layer.refreshHeights();
    const after = new THREE.Vector3().setFromMatrixPosition(layer.bandInstanceMatrix(0));
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
    expect(after.y).toBeCloseTo(ground(after.x, after.z) * 2.5, 4);
    layer.dispose();
  });
});

describe('split suppression thresholds (contract §9 v1.3)', () => {
  it('hides tree forms through the reed belt, reeds only where it is wet', () => {
    const layer = dynamicLayer();
    const level = 3.9; // trees suppressed to 4.4, static reeds only to 3.9
    layer.setWaterLevel(level);

    const counts = layer.countsByType();
    let treesHiddenInBelt = 0;
    let reedsStandingInBelt = 0;
    for (const type of ['conifer', 'reeds'] as const) {
      const threshold = type === 'reeds' ? level : level + BAND_M;
      for (let i = 0; i < counts[type]; i++) {
        const { position, scale } = decompose(layer, type, i);
        const c = connect(position.x, position.z);
        // Skip the vanishingly unlikely exact-boundary case: float32 matrix storage
        // makes the recovered x a hair off the one the sampler used.
        if (Math.abs(c - threshold) < 1e-4 || Math.abs(c - level) < 1e-4) continue;
        expect(layer.isSuppressed(type, i)).toBe(c <= threshold);
        expect(scale.y === 0).toBe(c <= threshold);
        if (c > level && c <= level + BAND_M) {
          if (type === 'conifer') treesHiddenInBelt++;
          else reedsStandingInBelt++;
        }
      }
    }
    // Both halves of the split really are exercised by the fixture.
    expect(treesHiddenInBelt).toBeGreaterThan(0);
    expect(reedsStandingInBelt).toBeGreaterThan(0);
    layer.dispose();
  });

  it('keeps the pre-v1.3 threshold for a legend with no shore-band class', () => {
    const layer = layerOn({ value: 1 });
    layer.setWaterLevel(5.0);
    const counts = layer.countsByType();
    for (const type of ['conifer', 'reeds'] as const) {
      for (let i = 0; i < counts[type]; i++) {
        const { position } = decompose(layer, type, i);
        const c = connect(position.x, position.z);
        if (Math.abs(c - 5.0) < 1e-4) continue;
        expect(layer.isSuppressed(type, i)).toBe(c <= 5.0);
      }
    }
    layer.dispose();
  });
});

describe('the band inside the global budget (contract §10)', () => {
  it('counts the band capacity against the cap and thins everything together', () => {
    const params = { seed: 1, densityScale: 1 };
    const full = sampleLandcoverVegetation(grid, dynamicLegend, params, connect, LEVEL_RANGE, Number.POSITIVE_INFINITY);
    expect(full.band).not.toBeNull();
    expect(full.vegetation.capped).toBe(false);

    const cap = Math.floor((full.vegetation.total + full.band!.capacity) * 0.75);
    const capped = sampleLandcoverVegetation(grid, dynamicLegend, params, connect, LEVEL_RANGE, cap);
    expect(capped.vegetation.capped).toBe(true);
    expect(capped.vegetation.appliedScale).toBeLessThan(1);
    // The budget is static instances + the band's *capacity* — level-independent, so
    // the applied scale never fluctuates as the slider moves.
    expect(capped.vegetation.total + capped.band!.capacity).toBeLessThanOrEqual(cap);

    // Global, never per class: every form and the band thin together (§10).
    expect(capped.band!.count).toBeLessThan(full.band!.count);
    for (const type of ['conifer', 'reeds'] as const) {
      const before = full.vegetation.byType.find((t) => t.type === type)!.x.length;
      const after = capped.vegetation.byType.find((t) => t.type === type)!.x.length;
      expect(after).toBeLessThan(before);
    }
  });

  it('leaves the no-band path exactly as it was', () => {
    const params = { seed: 1, densityScale: 1 };
    const joint = sampleLandcoverVegetation(grid, legend, params, connect, LEVEL_RANGE, 40);
    const alone = sampleVegetation(grid, legend, params, 40);
    expect(joint.band).toBeNull();
    expect(joint.vegetation.total).toBe(alone.total);
    expect(joint.vegetation.appliedScale).toBe(alone.appliedScale);
    expect(joint.vegetation.capped).toBe(alone.capped);
    expect(Array.from(joint.vegetation.byType[0].x)).toEqual(Array.from(alone.byType[0].x));
  });

  it('reports placed vs. visible honestly', () => {
    const layer = dynamicLayer();
    layer.setWaterLevel(4.8);
    const counts = layer.countsByType();
    const staticTotal = Object.values(counts).reduce((n, v) => n + v, 0);
    // `count` is what was placed: static instances + the band's fixed capacity.
    expect(layer.count).toBe(staticTotal + layer.bandCapacity);

    let staticVisible = 0;
    for (const type of ['conifer', 'reeds'] as const) {
      for (let i = 0; i < counts[type]; i++) if (!layer.isSuppressed(type, i)) staticVisible++;
    }
    // ...and `visibleCount` is what is standing at this century.
    expect(layer.visibleCount).toBe(staticVisible + layer.bandCount);
    expect(layer.visibleCount).toBeLessThan(layer.count);
    layer.dispose();
  });
});
