/**
 * Far-field class tint (contract v1.6 §13): the injection composes like every
 * other overlay, rings share one enable switch, and the terrain hands out
 * per-ring materials so the §11 "no overlays on rings" rule keeps holding for
 * everything except this one contractual exception.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FarLandcoverTint } from '../src/landcover/farTint';
import type { FarFieldClass } from '../src/landcover/legend';
import { Terrain } from '../src/terrain/terrain';

const CLASSES: FarFieldClass[] = [
  { index: 0, id: 'sea', name: 'Open sea (modern)', color: '#2d4a5b', rule: 'r' },
  { index: 1, id: 'open', name: 'Open ground', color: '#bfb377', rule: 'r' },
];

function ringGrid(half = 4000, size = 100) {
  return {
    width: size,
    height: size,
    resolution: (2 * half) / size,
    boundsLocal: { minX: -half, minZ: -half, maxX: half, maxZ: half },
    classes: new Uint8Array(size * size).fill(1),
  };
}

describe('FarLandcoverTint', () => {
  it('injects palette, rect and class sampler, preserving the include anchors', () => {
    const tint = new FarLandcoverTint(CLASSES);
    const material = new THREE.MeshStandardMaterial();
    tint.attachRing(material, ringGrid());

    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <dithering_fragment>',
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('vFarLcXZ');
    expect(shader.vertexShader).toContain('#include <begin_vertex>');
    expect(shader.fragmentShader).toContain('uFarLcPalette');
    expect(shader.fragmentShader).toContain('#include <dithering_fragment>');
    expect(shader.uniforms).toHaveProperty('uFarLcClass');
    expect(material.customProgramCacheKey()).toContain('farlandcover');
    tint.dispose();
  });

  it('drives every attached ring from one switch', () => {
    const tint = new FarLandcoverTint(CLASSES);
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshStandardMaterial();
    tint.attachRing(a, ringGrid());
    tint.attachRing(b, ringGrid(8000));

    const compile = (material: THREE.Material) => {
      const shader = {
        uniforms: {} as Record<string, { value?: unknown }>,
        vertexShader: '#include <common>\n#include <begin_vertex>',
        fragmentShader: '#include <common>\n#include <dithering_fragment>',
      };
      material.onBeforeCompile(shader as never, null as never);
      return shader.uniforms as { uFarLcOn: { value: number } };
    };
    const ua = compile(a);
    const ub = compile(b);
    expect(ua.uFarLcOn.value).toBe(0);
    tint.setEnabled(true);
    // The uniform OBJECT is shared, so both compiled programs see the flip.
    expect(ua.uFarLcOn.value).toBe(1);
    expect(ub.uFarLcOn.value).toBe(1);
    tint.dispose();
  });
});

describe('Terrain.farOverlayMaterial', () => {
  it('hands out a stable per-ring material distinct from the shared ring material', () => {
    const terrain = new Terrain();
    const m3 = terrain.farOverlayMaterial(0);
    expect(terrain.farOverlayMaterial(0)).toBe(m3); // stable across calls
    const m4 = terrain.farOverlayMaterial(1);
    expect(m4).not.toBe(m3); // per ring
    // And never one of the near-field overlay surfaces (§11's rule holds).
    for (const overlay of terrain.overlayMaterials) {
      expect(overlay).not.toBe(m3);
      expect(overlay).not.toBe(m4);
    }
    terrain.dispose();
  });
});
