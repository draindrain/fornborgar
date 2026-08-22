/**
 * Far-field billboards (contract v1.6 §13; docs/far-field-vegetation.md).
 *
 * The properties under test are the layer's stated invariants: deterministic for
 * a seed; populates only the annulus (outside the next-finer grid, inside 8 km);
 * its own budget, proportional and global; instances seated on the
 * curvature-dropped surface at metric size; suppressed in far water only when a
 * connect sampler exists; and lazy — nothing sampled until first enable.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FAR_BAND_MAX_RADIUS_M,
  FAR_MAX_INSTANCES,
  FarVegetationLayer,
  createBillboardMaterial,
  sampleFarBillboards,
  type FarRingInput,
} from '../src/landcover/farVegetation';
import type { FarFieldClass } from '../src/landcover/legend';
import { refractedDropM } from '../src/lib/earth';

// A ring3-like grid: 8×8 km at 40 m/px (small enough to walk in a test), every
// cell the broadleaf-forest class, flat ground at 30 m.
const RING_HALF = 4000;
const RING_RES = 40;
const RING_SIZE = (2 * RING_HALF) / RING_RES;

const FAR_CLASSES: FarFieldClass[] = [
  { index: 0, id: 'sea', name: 'Open sea (modern)', color: '#2d4a5b', rule: 'elev <= 0.05' },
  {
    index: 3,
    id: 'forest_broadleaf',
    name: 'Broadleaf forest',
    color: '#4f7a3a',
    rule: 'mosaic',
    billboard: { type: 'broadleaf', densityPerHa: 10 },
  },
];

function ringInput(fillClass = 3, innerHalfM = 2000): FarRingInput {
  const spec = {
    width: RING_SIZE,
    height: RING_SIZE,
    resolution: RING_RES,
    boundsLocal: { minX: -RING_HALF, minZ: -RING_HALF, maxX: RING_HALF, maxZ: RING_HALF },
  };
  return {
    ringIndex: 0,
    landcover: { ...spec, classes: new Uint8Array(RING_SIZE * RING_SIZE).fill(fillClass) },
    heights: { ...spec, heights: new Float32Array(RING_SIZE * RING_SIZE).fill(30) },
    innerHalfM,
  };
}

describe('sampleFarBillboards', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = sampleFarBillboards([ringInput()], FAR_CLASSES, 7);
    const b = sampleFarBillboards([ringInput()], FAR_CLASSES, 7);
    const c = sampleFarBillboards([ringInput()], FAR_CLASSES, 8);
    expect(a.total).toBeGreaterThan(0);
    expect(Array.from(a.instances[0].x)).toEqual(Array.from(b.instances[0].x));
    expect(Array.from(a.instances[0].x)).not.toEqual(Array.from(c.instances[0].x));
  });

  it('populates only the annulus: outside the inner grid, inside the 8 km reach', () => {
    const { instances } = sampleFarBillboards([ringInput()], FAR_CLASSES, 1);
    for (const batch of instances) {
      for (let i = 0; i < batch.x.length; i++) {
        const inInner = Math.abs(batch.x[i]) <= 2000 && Math.abs(batch.z[i]) <= 2000;
        expect(inInner).toBe(false);
        expect(Math.abs(batch.x[i])).toBeLessThanOrEqual(FAR_BAND_MAX_RADIUS_M);
        expect(Math.abs(batch.z[i])).toBeLessThanOrEqual(FAR_BAND_MAX_RADIUS_M);
      }
    }
  });

  it('samples nothing from classes without a billboard entry', () => {
    const { total } = sampleFarBillboards([ringInput(0)], FAR_CLASSES, 1);
    expect(total).toBe(0);
  });

  it('caps its own budget proportionally, never truncating one end', () => {
    // 10/ha over a 48 km² annulus is ~48k; a tiny budget forces the cap.
    const sample = sampleFarBillboards([ringInput()], FAR_CLASSES, 1, 1, 1000);
    expect(sample.capped).toBe(true);
    expect(sample.total).toBeLessThanOrEqual(1000);
    expect(sample.appliedScale).toBeLessThan(1);
    // A re-sample at reduced density, not a truncation: instances still span the
    // whole annulus rather than clustering at the walk's start.
    const xs = sample.instances[0].x;
    expect(Math.min(...xs)).toBeLessThan(-3000);
    expect(Math.max(...xs)).toBeGreaterThan(3000);
  });

  it('never exceeds the default far budget on a fully forested band', () => {
    const sample = sampleFarBillboards([ringInput()], FAR_CLASSES, 1);
    expect(sample.total).toBeLessThanOrEqual(FAR_MAX_INSTANCES);
  });
});

describe('FarVegetationLayer', () => {
  const options = (connectAt: ((x: number, z: number) => number) | null = null) => ({
    classes: FAR_CLASSES,
    seed: 1,
    contextHalfM: 2000,
    getExaggeration: () => 1,
    connectAt,
  });

  it('is lazy: nothing sampled or built until first enable', () => {
    const layer = new FarVegetationLayer(options());
    layer.addRing(ringInput());
    expect(layer.total).toBe(0);
    expect(layer.group.children.length).toBe(0);
    layer.setEnabled(true);
    expect(layer.total).toBeGreaterThan(0);
    expect(layer.group.children.length).toBeGreaterThan(0);
    expect(layer.group.visible).toBe(true);
    layer.setEnabled(false);
    expect(layer.group.visible).toBe(false);
    layer.dispose();
  });

  it('seats instances on the curvature-dropped surface at metric size', () => {
    const layer = new FarVegetationLayer(options());
    layer.addRing(ringInput());
    layer.setEnabled(true);
    const mesh = layer.group.children[0] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    mesh.getMatrixAt(0, matrix);
    matrix.decompose(position, quaternion, scale);
    const dropped = 30 - refractedDropM(position.x * position.x + position.z * position.z);
    expect(position.y).toBeCloseTo(dropped, 6);
    // Symmetric XZ scale — the shader's Ry must commute with it exactly.
    expect(scale.x).toBeCloseTo(scale.z, 6);
    expect(scale.y).toBeGreaterThan(0);
    layer.dispose();
  });

  it('suppresses instances in far water only when a connect sampler exists', () => {
    // Read the basis columns raw: `decompose` on a zero-scale (singular) matrix
    // is undefined and happily reports unit scale.
    const basisMagnitude = (mesh: THREE.InstancedMesh): number => {
      const matrix = new THREE.Matrix4();
      mesh.getMatrixAt(0, matrix);
      const e = matrix.elements;
      return Math.abs(e[0]) + Math.abs(e[5]) + Math.abs(e[10]);
    };
    const wetEverywhere = () => 0; // connect 0 m: wet at any level >= 0
    const layer = new FarVegetationLayer(options(wetEverywhere));
    layer.addRing(ringInput());
    layer.setEnabled(true);
    layer.setWaterLevel(5);
    expect(basisMagnitude(layer.group.children[0] as THREE.InstancedMesh)).toBe(0);
    // Without a sampler there is no modelled far water and nothing suppresses.
    const dry = new FarVegetationLayer(options(null));
    dry.addRing(ringInput());
    dry.setEnabled(true);
    dry.setWaterLevel(5);
    expect(basisMagnitude(dry.group.children[0] as THREE.InstancedMesh)).toBeGreaterThan(0);
    layer.dispose();
    dry.dispose();
  });

  it('rides exaggeration with position only, size staying metric', () => {
    const state = { exaggeration: 1 };
    const layer = new FarVegetationLayer({ ...options(), getExaggeration: () => state.exaggeration });
    layer.addRing(ringInput());
    layer.setEnabled(true);
    const mesh = layer.group.children[0] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    const before = new THREE.Vector3();
    const beforeScale = new THREE.Vector3();
    mesh.getMatrixAt(0, matrix);
    matrix.decompose(before, new THREE.Quaternion(), beforeScale);
    state.exaggeration = 2;
    layer.refreshHeights();
    const after = new THREE.Vector3();
    const afterScale = new THREE.Vector3();
    mesh.getMatrixAt(0, matrix);
    matrix.decompose(after, new THREE.Quaternion(), afterScale);
    expect(after.y).toBeCloseTo(before.y * 2, 6);
    expect(afterScale.y).toBeCloseTo(beforeScale.y, 6);
    layer.dispose();
  });
});

describe('createBillboardMaterial', () => {
  it('injects the cylindrical facing and the fade, keeping the include anchors', () => {
    const material = createBillboardMaterial(2000) as THREE.MeshLambertMaterial;
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>\n#include <dithering_fragment>',
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('cameraPosition.xz');
    expect(shader.vertexShader).toContain('vec3 transformed = vec3(');
    // The rotation replaces begin_vertex's `transformed` but the include anchors
    // the next injector would look for must survive.
    expect(shader.vertexShader).toContain('#include <project_vertex>');
    expect(shader.fragmentShader).toContain('diffuseColor.a *= vFarFade;');
    expect(shader.uniforms).toHaveProperty('uFarFadeStart');
    // Camera-facing quads must still write honest depth for the fog/logdepth path.
    expect(material.transparent).toBe(true);
  });

  it('extends the program cache key so billboard programs never alias plain Lambert', () => {
    const material = createBillboardMaterial(2000);
    expect(material.customProgramCacheKey()).toContain('farbillboard');
  });
});
