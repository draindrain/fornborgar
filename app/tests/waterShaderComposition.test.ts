/**
 * The water layer, the viewshed overlay and the Phase-7 land-cover tint all inject
 * into the **same** two terrain materials, so each must compose with whatever the
 * others already put on `onBeforeCompile` rather than replace it.
 *
 * This runs the real `onBeforeCompile` chain over a stand-in for three's
 * MeshStandardMaterial shader source (no GL context needed) and checks that every
 * injection survives, in any attach order, together with its uniforms — the failure
 * mode being a silently *missing* layer at runtime rather than a crash — and that
 * the contract's shading order (§9: viewshed -> landcover -> water) is what
 * attaching in that order actually produces.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { LandcoverTint } from '../src/landcover/tint';
import { validateLandcoverLegend } from '../src/landcover/legend';
import type { LandcoverGrid } from '../src/landcover/landcoverGrid';
import { ViewshedOverlay } from '../src/viewshed/overlay';
import { WaterLayer } from '../src/water/water';
import type { ConnectGrid } from '../src/water/connectGrid';
import { validateShoreline } from '../src/water/shoreline';

const BOUNDS = { minX: -8, minZ: -8, maxX: 8, maxZ: 8 };

const connect: ConnectGrid = {
  width: 4,
  height: 4,
  resolution: 4,
  boundsLocal: BOUNDS,
  values: Float32Array.from({ length: 16 }, (_, i) => i * 0.5),
};

const landcoverGrid: LandcoverGrid = {
  width: 4,
  height: 4,
  resolution: 4,
  boundsLocal: BOUNDS,
  classes: Uint8Array.from({ length: 16 }, (_, i) => i % 3),
};

const landcoverLegend = validateLandcoverLegend({
  schemaVersion: 1,
  referenceYearCE: 500,
  referenceLevelM: 8.6,
  method: 'test',
  caveat: 'test',
  calibration: 'test',
  classes: [
    { index: 0, id: 'water', name: 'Water', color: '#2d5a6b', rule: 'r0', vegetation: null },
    { index: 1, id: 'wood', name: 'Wood', color: '#33512f', rule: 'r1', vegetation: { type: 'conifer', densityPerHa: 90 } },
    { index: 2, id: 'open', name: 'Open', color: '#a9a267', rule: 'r2', vegetation: null },
  ],
});

const table = validateShoreline({
  schemaVersion: 1,
  steps: [
    { yearCE: -1050, levelM: 14 },
    { yearCE: 1150, levelM: 2 },
  ],
});

/** The anchors three's built-in materials give an injector. */
function fakeShader() {
  return {
    uniforms: {} as Record<string, unknown>,
    vertexShader: ['#include <common>', 'void main() {', '#include <begin_vertex>', '}'].join('\n'),
    fragmentShader: ['#include <common>', 'void main() {', '#include <dithering_fragment>', '}'].join('\n'),
  };
}

function compile(material: THREE.Material) {
  const shader = fakeShader();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  material.onBeforeCompile(shader as any, null as any);
  return shader;
}

describe('water + viewshed shader composition', () => {
  it('keeps both injections when the viewshed attached first', () => {
    const material = new THREE.MeshStandardMaterial();
    new ViewshedOverlay(4, 4, BOUNDS).attach(material);
    new WaterLayer(table, connect).attachTerrain(material);

    const shader = compile(material);

    for (const token of ['uViewshedMask', 'uViewshedOn', 'vViewshedXZ', 'uWaterConnect', 'uWaterOn', 'vWaterXZ']) {
      expect(shader.fragmentShader).toContain(token);
    }
    expect(shader.vertexShader).toContain('vViewshedXZ = (modelMatrix');
    expect(shader.vertexShader).toContain('vWaterXZ = (modelMatrix');

    // Uniform objects from both modules reached the shader.
    expect(shader.uniforms['uViewshedMask']).toBeDefined();
    expect(shader.uniforms['uWaterLevel']).toBeDefined();
    expect(shader.uniforms['uWaterRect']).toBeDefined();

    // The water tint shades last, so submerged ground reads as submerged
    // whether or not the viewshed is on.
    expect(shader.fragmentShader.indexOf('uViewshedOn > 0.5')).toBeLessThan(
      shader.fragmentShader.indexOf('uWaterOn > 0.5'),
    );
  });

  it('keeps both injections when the water attached first', () => {
    const material = new THREE.MeshStandardMaterial();
    new WaterLayer(table, connect).attachTerrain(material);
    new ViewshedOverlay(4, 4, BOUNDS).attach(material);

    const shader = compile(material);
    expect(shader.fragmentShader).toContain('uViewshedMask');
    expect(shader.fragmentShader).toContain('uWaterConnect');
    expect(shader.uniforms['uViewshedMask']).toBeDefined();
    expect(shader.uniforms['uWaterLevel']).toBeDefined();
  });

  it('leaves the anchor includes in place for any further injector', () => {
    const material = new THREE.MeshStandardMaterial();
    new ViewshedOverlay(4, 4, BOUNDS).attach(material);
    new WaterLayer(table, connect).attachTerrain(material);

    const shader = compile(material);
    expect(shader.vertexShader).toContain('#include <common>');
    expect(shader.vertexShader).toContain('#include <begin_vertex>');
    expect(shader.fragmentShader).toContain('#include <common>');
    expect(shader.fragmentShader).toContain('#include <dithering_fragment>');
  });

  it('extends the program cache key so an uninjected material never shares a program', () => {
    const plain = new THREE.MeshStandardMaterial();
    const injected = new THREE.MeshStandardMaterial();
    new WaterLayer(table, connect).attachTerrain(injected);

    expect(injected.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
    expect(injected.customProgramCacheKey()).toContain('water1');
    // `needsUpdate` is write-only on Material; the version counter is the tell.
    expect(injected.version).toBeGreaterThan(plain.version);
  });

  it('does not clobber a handler that is not the viewshed', () => {
    const material = new THREE.MeshStandardMaterial();
    let called = 0;
    material.onBeforeCompile = (shader) => {
      called++;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n// someone else');
    };
    new WaterLayer(table, connect).attachTerrain(material);

    const shader = compile(material);
    expect(called).toBe(1);
    expect(shader.fragmentShader).toContain('// someone else');
    expect(shader.fragmentShader).toContain('uWaterConnect');
  });
});

describe('water layer state', () => {
  it('moves the plane in unexaggerated local Y, so the terrain group scales it', () => {
    const layer = new WaterLayer(table, connect);
    layer.setYear(-1050);
    expect(layer.levelM).toBe(14);
    expect(layer.mesh.position.y).toBe(14);
    layer.setYear(50);
    expect(layer.levelM).toBeCloseTo(layer.levelAt(50), 10);
    expect(layer.mesh.position.y).toBeCloseTo(layer.levelAt(50), 10);
  });

  it('clamps scrubbing to the table extent and starts hidden', () => {
    const layer = new WaterLayer(table, connect);
    expect(layer.enabled).toBe(false);
    expect(layer.mesh.visible).toBe(false);
    layer.setYear(-9999);
    expect(layer.yearCE).toBe(-1050);
    layer.setYear(9999);
    expect(layer.yearCE).toBe(1150);
    layer.setEnabled(true);
    expect(layer.enabled).toBe(true);
    expect(layer.mesh.visible).toBe(true);
  });

  it('sizes the plane to the context bounds and centres it there', () => {
    const layer = new WaterLayer(table, connect);
    const box = new THREE.Box3().setFromBufferAttribute(
      layer.mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
    );
    expect(box.max.x - box.min.x).toBeCloseTo(BOUNDS.maxX - BOUNDS.minX, 6);
    expect(box.max.z - box.min.z).toBeCloseTo(BOUNDS.maxZ - BOUNDS.minZ, 6);
    expect(layer.mesh.position.x).toBeCloseTo((BOUNDS.minX + BOUNDS.maxX) / 2, 6);
    expect(layer.mesh.position.z).toBeCloseTo((BOUNDS.minZ + BOUNDS.maxZ) / 2, 6);
  });
});

describe('three-way ground-overlay composition (contract §9)', () => {
  /** The order main.ts attaches in: viewshed, then land cover, then water. */
  function chained() {
    const material = new THREE.MeshStandardMaterial();
    new ViewshedOverlay(4, 4, BOUNDS).attach(material);
    new LandcoverTint(landcoverGrid, landcoverLegend).attach(material);
    new WaterLayer(table, connect).attachTerrain(material);
    return material;
  }

  it('shades viewshed -> landcover -> water, so submerged ground still reads submerged', () => {
    const shader = compile(chained());
    const viewshed = shader.fragmentShader.indexOf('uViewshedOn > 0.5');
    const landcover = shader.fragmentShader.indexOf('uLandcoverOn > 0.5');
    const water = shader.fragmentShader.indexOf('uWaterOn > 0.5');
    expect(viewshed).toBeGreaterThanOrEqual(0);
    expect(viewshed).toBeLessThan(landcover);
    expect(landcover).toBeLessThan(water);
  });

  it('carries the uniforms and varyings of all three injections', () => {
    const shader = compile(chained());
    for (const token of [
      'uViewshedMask',
      'uLandcoverClass',
      'uLandcoverPalette',
      'uLandcoverCount',
      'uWaterConnect',
      'vViewshedXZ',
      'vLandcoverXZ',
      'vWaterXZ',
    ]) {
      expect(shader.fragmentShader).toContain(token);
    }
    expect(shader.vertexShader).toContain('vLandcoverXZ = (modelMatrix');
    for (const name of ['uViewshedMask', 'uLandcoverClass', 'uLandcoverRect', 'uLandcoverMix', 'uWaterLevel']) {
      expect(shader.uniforms[name]).toBeDefined();
    }
  });

  it('leaves the anchor includes in place after all three', () => {
    const shader = compile(chained());
    expect(shader.vertexShader).toContain('#include <common>');
    expect(shader.vertexShader).toContain('#include <begin_vertex>');
    expect(shader.fragmentShader).toContain('#include <common>');
    expect(shader.fragmentShader).toContain('#include <dithering_fragment>');
  });

  it('extends the program cache key once per injection', () => {
    const plain = new THREE.MeshStandardMaterial();
    const key = chained().customProgramCacheKey();
    expect(key).not.toBe(plain.customProgramCacheKey());
    expect(key).toContain('viewshed1');
    expect(key).toContain('landcover1');
    expect(key).toContain('water1');
    expect(key.indexOf('landcover1')).toBeLessThan(key.indexOf('water1'));
  });

  it('survives any attach order, only the shading order changes', () => {
    const material = new THREE.MeshStandardMaterial();
    new WaterLayer(table, connect).attachTerrain(material);
    new LandcoverTint(landcoverGrid, landcoverLegend).attach(material);
    new ViewshedOverlay(4, 4, BOUNDS).attach(material);

    const shader = compile(material);
    expect(shader.fragmentShader).toContain('uWaterConnect');
    expect(shader.fragmentShader).toContain('uLandcoverClass');
    expect(shader.fragmentShader).toContain('uViewshedMask');
    expect(shader.uniforms['uLandcoverPalette']).toBeDefined();
  });
});

describe('land-cover tint state', () => {
  it('never interpolates class indices', () => {
    const tint = new LandcoverTint(landcoverGrid, landcoverLegend);
    expect(tint.texture.magFilter).toBe(THREE.NearestFilter);
    expect(tint.texture.minFilter).toBe(THREE.NearestFilter);
    expect(tint.texture.format).toBe(THREE.RedFormat);
    expect(tint.texture.type).toBe(THREE.UnsignedByteType);
    expect(tint.classCount).toBe(3);
    tint.dispose();
  });

  it('starts off and toggles', () => {
    const tint = new LandcoverTint(landcoverGrid, landcoverLegend);
    expect(tint.enabled).toBe(false);
    tint.setEnabled(true);
    expect(tint.enabled).toBe(true);
    tint.dispose();
  });
});
