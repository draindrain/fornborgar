/**
 * Contact shadow discs under the near-field trees (§6.1 amendment, "grounding").
 *
 * The renderer runs with no shadow map, so the only thing joining a tree to the
 * ground is this disc. What has to hold — and what silently rots if someone edits
 * `refreshMatrices` — is that the disc is a *pure consequence* of the instance it
 * belongs to:
 *
 *   • it exists for tree forms and not for reeds;
 *   • it is visible for exactly the instances drawn in the mesh tier, so a tree and
 *     its shadow can never disagree about being there (suppressed → gone,
 *     impostor tier → gone);
 *   • its diameter tracks the crown it sits under, and its lift above the surface is
 *     the same nudge at any vertical exaggeration (contract §0);
 *   • it is bit-identical for a seed, like everything else in this layer.
 *
 * All A-vs-B: nothing here pins a number that only the current tuning would satisfy.
 * The headless environment has no `document`, so the discs build untextured — which is
 * the wrong look but the right transform, and transforms are all these tests read.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { LandcoverGrid } from '../src/landcover/landcoverGrid';
import { validateLandcoverLegend, type LandcoverLegend } from '../src/landcover/legend';
import { atlasLayout, type ImpostorAtlas } from '../src/landcover/impostors';
import {
  CONTACT_DISC_LIFT_M,
  CONTACT_DISC_WIDTH_RATIO,
  MESH_TIER_RADIUS_M,
  VegetationLayer,
} from '../src/landcover/vegetation';

// ------------------------------------------------------------- the fixture --

const SIZE = 16;
const BOUNDS = { minX: -16, minZ: -16, maxX: 16, maxZ: 16 };

/** West half conifer, south quarter reeds — both forms present in one layer. */
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

/** Sloped ground and an east-rising connect field, so both are non-constant. */
const ground = (x: number, _z: number): number => 10 + x * 0.1;
const connect = (x: number, _z: number): number => 5 + x * 0.1;

function layerOn(exaggeration = 1, seed = 1): VegetationLayer {
  return new VegetationLayer(
    grid,
    legend,
    { groundAt: ground, getExaggeration: () => exaggeration, connectAt: connect },
    { seed },
  );
}

function scaleOf(m: THREE.Matrix4): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixScale(m);
}

// ------------------------------------------------------- existence + tiers --

describe('contact shadow discs', () => {
  it('gives every tree batch a disc and reeds none', () => {
    const layer = layerOn();
    expect(layer.discInstanceMatrix('conifer', 0)).not.toBeNull();
    // Reeds stand in water and grow in dense belts; a disc under each would read as
    // mud, not as contact.
    expect(layer.discInstanceMatrix('reeds', 0)).toBeNull();
    layer.dispose();
  });

  it('reports the same instance count as the batch it grounds', () => {
    const layer = layerOn();
    const n = layer.countsByType()['conifer'] ?? 0;
    expect(n).toBeGreaterThan(0);
    // Every instance is addressable, and one past the end is not — the disc mesh is
    // indexed by instance, so this is exactly the batch's range.
    expect(layer.discInstanceMatrix('conifer', n - 1)).not.toBeNull();
    expect(() => layer.discInstanceMatrix('conifer', n)).toThrow(RangeError);
    layer.dispose();
  });

  it('shows a disc for exactly the unsuppressed instances, and follows the level back', () => {
    const layer = layerOn();
    const n = layer.countsByType()['conifer'] ?? 0;

    // Dry: every tree is drawn, so every tree has a shadow.
    layer.setWaterLevel(null);
    for (let i = 0; i < n; i++) {
      expect(scaleOf(layer.discInstanceMatrix('conifer', i)!).x).toBeGreaterThan(0);
    }

    // Raise the water: the disc must vanish for exactly the instances the mesh tier
    // dropped — never one without the other.
    // connect runs 3.4 … 5.0 across the conifer half, so this cuts it roughly in two.
    layer.setWaterLevel(4.2);
    let suppressed = 0;
    let standing = 0;
    for (let i = 0; i < n; i++) {
      const disc = scaleOf(layer.discInstanceMatrix('conifer', i)!).x;
      const tree = scaleOf(layer.instanceMatrix('conifer', i)).x;
      if (layer.isSuppressed('conifer', i)) {
        suppressed++;
        expect(disc).toBe(0);
        expect(tree).toBe(0);
      } else {
        standing++;
        expect(disc).toBeGreaterThan(0);
        expect(tree).toBeGreaterThan(0);
      }
    }
    expect(suppressed).toBeGreaterThan(0);
    expect(standing).toBeGreaterThan(0);

    // Drop it again: the discs come back, unchanged.
    layer.setWaterLevel(null);
    for (let i = 0; i < n; i++) {
      expect(scaleOf(layer.discInstanceMatrix('conifer', i)!).x).toBeGreaterThan(0);
    }
    layer.dispose();
  });
});

// ----------------------------------------------------- size and placement --

describe('contact disc transform', () => {
  it('scales with the crown it sits under, by one ratio for every instance', () => {
    const layer = layerOn();
    const n = layer.countsByType()['conifer'] ?? 0;
    const widths: number[] = [];
    const diameters: number[] = [];
    for (let i = 0; i < n; i++) {
      const tree = scaleOf(layer.instanceMatrix('conifer', i));
      const disc = scaleOf(layer.discInstanceMatrix('conifer', i)!);
      // Symmetric in XZ: the disc is a footprint hint, not a projected silhouette.
      expect(disc.z).toBeCloseTo(disc.x, 6);
      expect(disc.x / tree.x).toBeCloseTo(CONTACT_DISC_WIDTH_RATIO, 5);
      widths.push(tree.x);
      diameters.push(disc.x);
    }
    // Crown widths genuinely vary in this fixture (species mix × stand age × jitter),
    // so the ratio test above is testing something, and wider crowns get wider discs.
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
    const order = diameters.map((d, i) => [widths[i], d] as const).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < order.length; i++) expect(order[i][1]).toBeGreaterThanOrEqual(order[i - 1][1]);
    layer.dispose();
  });

  it('lies flat and unrotated whatever the tree does', () => {
    const layer = layerOn();
    const n = layer.countsByType()['conifer'] ?? 0;
    const q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      layer.discInstanceMatrix('conifer', i)!.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      // Yaw and lean would only shear the radial falloff, so the disc takes neither.
      expect(Math.abs(q.w)).toBeCloseTo(1, 6);
    }
    layer.dispose();
  });

  it('keeps the same lift above the tree base at any exaggeration (contract §0)', () => {
    const flat = layerOn(1);
    const tall = layerOn(2.5);
    const n = flat.countsByType()['conifer'] ?? 0;
    for (const i of [0, 3, n - 1]) {
      const flatBase = new THREE.Vector3().setFromMatrixPosition(flat.instanceMatrix('conifer', i));
      const flatDisc = new THREE.Vector3().setFromMatrixPosition(flat.discInstanceMatrix('conifer', i)!);
      const tallBase = new THREE.Vector3().setFromMatrixPosition(tall.instanceMatrix('conifer', i));
      const tallDisc = new THREE.Vector3().setFromMatrixPosition(tall.discInstanceMatrix('conifer', i)!);
      // Same XZ as its tree, and a lift that does not grow with the slider.
      expect(flatDisc.x).toBeCloseTo(flatBase.x, 6);
      expect(flatDisc.z).toBeCloseTo(flatBase.z, 6);
      expect(flatDisc.y - flatBase.y).toBeCloseTo(CONTACT_DISC_LIFT_M, 5);
      expect(tallDisc.y - tallBase.y).toBeCloseTo(CONTACT_DISC_LIFT_M, 5);
      // The ground itself does move with exaggeration — otherwise the test above
      // would pass on a layer that ignored exaggeration entirely.
      expect(tallBase.y).toBeGreaterThan(flatBase.y);
      // ...and the disc size is metric, untouched by the render-only Y scale.
      expect(scaleOf(tall.discInstanceMatrix('conifer', i)!).x).toBeCloseTo(
        scaleOf(flat.discInstanceMatrix('conifer', i)!).x,
        6,
      );
    }
    flat.dispose();
    tall.dispose();
  });

  it('is bit-identical for a seed and differs between seeds', () => {
    const a = layerOn(1, 7);
    const b = layerOn(1, 7);
    const other = layerOn(1, 8);
    const n = a.countsByType()['conifer'] ?? 0;
    for (const i of [0, 3, n - 1]) {
      expect(Array.from(b.discInstanceMatrix('conifer', i)!.elements)).toEqual(
        Array.from(a.discInstanceMatrix('conifer', i)!.elements),
      );
    }
    const first = (layer: VegetationLayer): number[] =>
      Array.from(layer.discInstanceMatrix('conifer', 0)!.elements);
    expect(first(other)).not.toEqual(first(a));
    a.dispose();
    b.dispose();
    other.dispose();
  });
});

// --------------------------------------------------- the LOD tier coupling --

/** A texture-free atlas: enough for the layer to build impostor twins headlessly. */
function stubAtlas(): ImpostorAtlas {
  return {
    color: new THREE.Texture(),
    mask: new THREE.Texture(),
    layout: atlasLayout(),
    dispose: () => {},
  };
}

/** One all-conifer 1 km grid — big enough for both tiers to exist at once. */
function wideLayer(atlas: ImpostorAtlas | null): VegetationLayer {
  const size = 64;
  const cell = 16;
  const wide = validateLandcoverLegend({
    schemaVersion: 1,
    referenceYearCE: 500,
    referenceLevelM: 8.6,
    method: 'test',
    caveat: 'test',
    calibration: 'test',
    classes: [
      {
        index: 0,
        id: 'conifer',
        name: 'Conifer forest',
        color: '#2f4f2f',
        rule: 'test',
        vegetation: { type: 'conifer', densityPerHa: 40 },
      },
    ],
  });
  const wideGrid: LandcoverGrid = {
    width: size,
    height: size,
    resolution: cell,
    boundsLocal: { minX: -512, maxX: 512, minZ: -512, maxZ: 512 },
    classes: new Uint8Array(size * size).fill(0),
  };
  return new VegetationLayer(
    wideGrid,
    wide,
    {
      groundAt: () => 10,
      getExaggeration: () => 1,
      connectAt: null,
      impostorAtlas: atlas ? () => atlas : null,
    },
    { seed: 1 },
  );
}

describe('contact discs and the §6.1 LOD tiers', () => {
  it('draws a disc for the mesh tier only, moving with the camera', () => {
    const layer = wideLayer(stubAtlas());
    const n = layer.countsByType()['conifer'] ?? 0;
    expect(n).toBeGreaterThan(100);

    layer.updateCamera(-512, -512);
    const position = new THREE.Vector3();
    let withDisc = 0;
    let without = 0;
    for (let i = 0; i < n; i++) {
      const tree = layer.instanceMatrix('conifer', i);
      const disc = layer.discInstanceMatrix('conifer', i)!;
      const meshTier = scaleOf(tree).x > 0;
      if (meshTier) {
        withDisc++;
        expect(scaleOf(disc).x).toBeGreaterThan(0);
        // The disc's own position confirms it is inside the mesh radius — the zeroed
        // impostor twin still carries a position, so read the disc, not the tier.
        position.setFromMatrixPosition(disc);
        expect(Math.hypot(position.x + 512, position.z + 512)).toBeLessThanOrEqual(MESH_TIER_RADIUS_M + 1);
      } else {
        without++;
        // Impostor tier: the baked quad carries its own ground contact, and at that
        // range the disc would be sub-pixel anyway.
        expect(scaleOf(disc).x).toBe(0);
        expect(scaleOf(layer.impostorInstanceMatrix('conifer', i)!).x).toBeGreaterThan(0);
      }
    }
    expect(withDisc).toBeGreaterThan(0);
    expect(without).toBeGreaterThan(0);

    // Walk the camera to the far corner: the discs follow the mesh tier there.
    layer.updateCamera(512, 512);
    let flipped = 0;
    for (let i = 0; i < n; i++) {
      const meshTier = scaleOf(layer.instanceMatrix('conifer', i)).x > 0;
      const hasDisc = scaleOf(layer.discInstanceMatrix('conifer', i)!).x > 0;
      expect(hasDisc).toBe(meshTier);
      position.setFromMatrixPosition(layer.instanceMatrix('conifer', i));
      if (meshTier && Math.hypot(position.x + 512, position.z + 512) > MESH_TIER_RADIUS_M) flipped++;
    }
    expect(flipped).toBeGreaterThan(0);
    layer.dispose();
  });

  it('grounds every tree when there is no atlas at all', () => {
    // Without a bake every instance is mesh tier, so every instance keeps its disc.
    const layer = wideLayer(null);
    const n = layer.countsByType()['conifer'] ?? 0;
    for (const i of [0, 5, n - 1]) {
      expect(layer.impostorInstanceMatrix('conifer', i)).toBeNull();
      expect(scaleOf(layer.discInstanceMatrix('conifer', i)!).x).toBeGreaterThan(0);
    }
    layer.dispose();
  });
});
