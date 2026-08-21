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

const grid = makeGrid();
const legend = makeLegend();

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
