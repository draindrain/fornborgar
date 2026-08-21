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

import { LandcoverTint, NO_LEVEL_SENTINEL, hydroTintClass } from '../src/landcover/tint';
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

/**
 * The v1.3 variant of the same legend: the water class is the runtime sea and a
 * runtime-only shore band is appended (no raster cells — `areaFraction` would be 0).
 */
const dynamicLegend = validateLandcoverLegend({
  schemaVersion: 1,
  referenceYearCE: 500,
  referenceLevelM: 8.6,
  method: 'test',
  caveat: 'test',
  calibration: 'test',
  classes: [
    {
      index: 0,
      id: 'water',
      name: 'Open water',
      color: '#2d5a6b',
      rule: 'r0',
      vegetation: null,
      dynamic: { kind: 'water' },
    },
    { index: 1, id: 'wood', name: 'Wood', color: '#33512f', rule: 'r1', vegetation: { type: 'conifer', densityPerHa: 90 } },
    { index: 2, id: 'open', name: 'Open', color: '#a9a267', rule: 'r2', vegetation: null },
    {
      index: 3,
      id: 'shore_reeds',
      name: 'Shore reed belt',
      color: '#77875a',
      rule: 'r3 — derived at the current level',
      vegetation: { type: 'reeds', densityPerHa: 500 },
      dynamic: { kind: 'shore-band', bandM: 0.6 },
    },
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
    // v1.3 bumped the land-cover key: a tint with the dynamic-hydrology branches can
    // never share a compiled program with a pre-v1.3 one.
    expect(key).toContain('landcover2');
    expect(key).not.toContain('landcover1|');
    expect(key).toContain('water1');
    expect(key.indexOf('landcover2')).toBeLessThan(key.indexOf('water1'));
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

// ------------------------------------------------ v1.3 dynamic hydrology ----

describe('land-cover tint: dynamic hydrology (contract §9/§10 v1.3)', () => {
  it('carries its own hydro uniforms and both branches when given a connect grid', () => {
    const material = new THREE.MeshStandardMaterial();
    const tint = new LandcoverTint(landcoverGrid, dynamicLegend, connect);
    tint.attach(material);
    const shader = compile(material);

    for (const name of [
      'uLandcoverConnect',
      'uLandcoverLevel',
      'uLandcoverBandM',
      'uLandcoverHydroOn',
      'uLandcoverSeaColor',
      'uLandcoverBandColor',
    ]) {
      expect(shader.fragmentShader).toContain(name);
      expect(shader.uniforms[name]).toBeDefined();
    }
    // Never the water layer's uniforms: a site may ship no water assets at all.
    expect(shader.fragmentShader).not.toContain('uWaterLevel');

    // Sea first, band second, and the band's own guard is in the source.
    const sea = shader.fragmentShader.indexOf('lcColor = uLandcoverSeaColor');
    const band = shader.fragmentShader.indexOf('lcColor = uLandcoverBandColor');
    expect(sea).toBeGreaterThanOrEqual(0);
    expect(band).toBeGreaterThan(sea);
    expect(shader.fragmentShader).toContain('lcConnect <= uLandcoverLevel + uLandcoverBandM');

    expect(tint.hydroEnabled).toBe(true);
    expect(tint.bandM).toBeCloseTo(0.6, 10);
    // Meters, a continuous field: linear on purpose, unlike the class indices.
    expect(tint.connectTexture?.magFilter).toBe(THREE.LinearFilter);
    expect(tint.connectTexture?.minFilter).toBe(THREE.LinearFilter);
    expect(tint.connectTexture?.type).toBe(THREE.HalfFloatType);
    expect(tint.texture.magFilter).toBe(THREE.NearestFilter);
    tint.dispose();
  });

  it('keeps the contract order viewshed -> landcover -> water with hydro on', () => {
    const material = new THREE.MeshStandardMaterial();
    new ViewshedOverlay(4, 4, BOUNDS).attach(material);
    new LandcoverTint(landcoverGrid, dynamicLegend, connect).attach(material);
    new WaterLayer(table, connect).attachTerrain(material);

    const shader = compile(material);
    const viewshed = shader.fragmentShader.indexOf('uViewshedOn > 0.5');
    const landcover = shader.fragmentShader.indexOf('uLandcoverOn > 0.5');
    const hydro = shader.fragmentShader.indexOf('uLandcoverHydroOn > 0.5');
    const water = shader.fragmentShader.indexOf('uWaterOn > 0.5');
    expect(viewshed).toBeLessThan(landcover);
    expect(landcover).toBeLessThan(hydro); // the branches sit inside the wash block
    expect(hydro).toBeLessThan(water);
  });

  it.each([
    ['no connect grid', () => new LandcoverTint(landcoverGrid, dynamicLegend, null)],
    ['a legend with no dynamic classes', () => new LandcoverTint(landcoverGrid, landcoverLegend, connect)],
  ])('compiles with the branches inert given %s', (_label, make) => {
    const material = new THREE.MeshStandardMaterial();
    const tint = make();
    tint.attach(material);
    const shader = compile(material);

    expect(tint.hydroEnabled).toBe(false);
    expect(tint.bandM).toBe(0);
    expect(tint.connectTexture).toBeNull();
    // The uniforms still exist (one program per material, not per legend) and the
    // sampler is still bound — the guard is the value, not the source.
    expect(shader.uniforms['uLandcoverHydroOn']).toEqual({ value: 0 });
    expect((shader.uniforms['uLandcoverConnect'] as { value: unknown }).value).toBeInstanceOf(THREE.DataTexture);
    expect(shader.fragmentShader).toContain('uLandcoverHydroOn > 0.5');
    tint.dispose();
  });

  it('tracks the slider level and parks at the sentinel for null', () => {
    const tint = new LandcoverTint(landcoverGrid, dynamicLegend, connect);
    expect(tint.waterLevel).toBeNull();

    const material = new THREE.MeshStandardMaterial();
    tint.attach(material);
    const shader = compile(material);
    const level = shader.uniforms['uLandcoverLevel'] as { value: number };
    expect(level.value).toBe(NO_LEVEL_SENTINEL);

    tint.setWaterLevel(8.6);
    expect(tint.waterLevel).toBe(8.6);
    expect(level.value).toBe(8.6); // the shared uniform object, so no re-attach needed

    tint.setWaterLevel(null);
    expect(tint.waterLevel).toBeNull();
    expect(level.value).toBe(NO_LEVEL_SENTINEL);
    // The sentinel is far below any real connect value, so neither branch can fire.
    expect(hydroTintClass(-500, NO_LEVEL_SENTINEL, 0.6, 2, 0, 3)).toBe(2);
    tint.dispose();
  });

  it('paints the sea class where the legend declares one and none where it does not', () => {
    const withSea = new LandcoverTint(landcoverGrid, dynamicLegend, connect);
    expect(withSea.hydroEnabled).toBe(true);

    // Same legend with the water class made static again — a legal v1.3 legend.
    const doc = JSON.parse(JSON.stringify(dynamicLegend)) as { classes: Record<string, unknown>[] };
    delete doc.classes[0]['dynamic'];
    const bandOnly = validateLandcoverLegend(doc);
    const tint = new LandcoverTint(landcoverGrid, bandOnly, connect);
    const material = new THREE.MeshStandardMaterial();
    tint.attach(material);
    const shader = compile(material);
    // Band without sea: hydro is still on, but the sea branch is guarded off — and
    // the band must not spill onto submerged ground (the `>` guard in the source).
    expect(tint.hydroEnabled).toBe(true);
    expect(shader.uniforms['uLandcoverSeaOn']).toEqual({ value: 0 });
    expect(shader.fragmentShader).toContain('uLandcoverSeaOn > 0.5');
    expect(hydroTintClass(1, 5, 0.6, 2, -1, 3)).toBe(2); // submerged, no sea class: raster wins
    withSea.dispose();
    tint.dispose();
  });
});

describe('hydroTintClass — the executable spec of the GLSL (contract §9 v1.3)', () => {
  const WATER = 0;
  const BAND = 3;
  const RASTER = 2;
  const BAND_M = 0.6;
  const at = (connectValue: number, level: number, bandM = BAND_M) =>
    hydroTintClass(connectValue, level, bandM, RASTER, WATER, BAND);

  it('gives the sea everything at or below the level (§7: connect <= h is wet)', () => {
    expect(at(4.0, 8.6)).toBe(WATER);
    expect(at(8.6, 8.6)).toBe(WATER); // the boundary is wet, exactly as §7 says
    expect(at(8.600001, 8.6)).not.toBe(WATER);
  });

  it('gives the band the half-open strip just above it, and nothing else', () => {
    expect(at(8.7, 8.6)).toBe(BAND);
    expect(at(9.2, 8.6)).toBe(BAND); // level + bandM, inclusive
    expect(at(9.3, 8.6)).toBe(RASTER);
  });

  it('never lets the band repaint the sea, at any level', () => {
    for (const level of [2, 5, 8.6, 12]) {
      for (const connectValue of [0, 1.5, 4, 8.6, 12]) {
        const painted = at(connectValue, level);
        if (connectValue <= level) expect(painted).toBe(WATER);
      }
    }
  });

  it('follows the slider: the same cell is sea, then band, then land', () => {
    const cell = 9.0;
    expect(at(cell, 9.5)).toBe(WATER); // early century, high water
    expect(at(cell, 8.6)).toBe(BAND); // shoreline has just passed it
    expect(at(cell, 6.0)).toBe(RASTER); // drained: the raster class shows through
  });

  it('disables the band entirely at bandM <= 0', () => {
    expect(at(8.7, 8.6, 0)).toBe(RASTER);
    expect(at(8.7, 8.6, -1)).toBe(RASTER);
    expect(at(8.5, 8.6, 0)).toBe(WATER); // the sea branch is untouched
  });

  it('leaves the raster class alone when neither dynamic class exists', () => {
    expect(hydroTintClass(1, 8.6, 0, RASTER, -1, -1)).toBe(RASTER);
    expect(hydroTintClass(8.7, 8.6, BAND_M, RASTER, -1, -1)).toBe(RASTER);
  });
});
