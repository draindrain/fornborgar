/**
 * Tree archetypes (PLAN §6.1 amendment): the generator's contract with the
 * instancing pipeline — unit height, base at y = 0, canopy diameter 1,
 * deterministic for a seed, triangle budget bounded — plus the bark/foliage
 * split the material relies on. Same A-vs-B determinism style as the rest of
 * the suite: two fresh builds compared, never golden literals.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ARCHETYPE_SPECIES,
  ARCHETYPE_VARIANTS,
  archetypeGeometry,
  archetypeSeed,
  buildArchetype,
  createArchetypeMaterial,
} from '../src/landcover/treeGeometry';

describe('buildArchetype', () => {
  it('is a pure function of (species, seed)', () => {
    for (const species of ARCHETYPE_SPECIES) {
      const a = buildArchetype(species, 1234);
      const b = buildArchetype(species, 1234);
      expect(Array.from((b.getAttribute('position') as THREE.BufferAttribute).array)).toEqual(
        Array.from((a.getAttribute('position') as THREE.BufferAttribute).array),
      );
      expect(Array.from((b.getAttribute('color') as THREE.BufferAttribute).array)).toEqual(
        Array.from((a.getAttribute('color') as THREE.BufferAttribute).array),
      );
      const c = buildArchetype(species, 1235);
      expect(Array.from((c.getAttribute('position') as THREE.BufferAttribute).array)).not.toEqual(
        Array.from((a.getAttribute('position') as THREE.BufferAttribute).array),
      );
    }
  });

  it('keeps the instancing contract: base at y=0, height 1, canopy diameter 1', () => {
    for (const species of ARCHETYPE_SPECIES) {
      for (let variant = 0; variant < ARCHETYPE_VARIANTS; variant++) {
        const geometry = archetypeGeometry(species, variant, 7);
        geometry.computeBoundingBox();
        const box = geometry.boundingBox!;
        expect(box.min.y).toBeGreaterThanOrEqual(0);
        expect(box.min.y).toBeLessThan(0.05);
        expect(box.max.y).toBeCloseTo(1, 5);
        const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
        let maxR = 0;
        for (let i = 0; i < pos.count; i++) {
          maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getZ(i)));
        }
        expect(maxR).toBeCloseTo(0.5, 5);
      }
    }
  });

  it('stays inside the triangle budget (and is not degenerate)', () => {
    for (const species of ARCHETYPE_SPECIES) {
      for (let variant = 0; variant < ARCHETYPE_VARIANTS; variant++) {
        const geometry = archetypeGeometry(species, variant, 42);
        const triangles = geometry.getIndex()!.count / 3;
        expect(triangles).toBeGreaterThan(50);
        expect(triangles).toBeLessThanOrEqual(700);
      }
    }
  });

  it('carries the bark/foliage split every species needs', () => {
    for (const species of ARCHETYPE_SPECIES) {
      const geometry = buildArchetype(species, 9);
      const bark = geometry.getAttribute('bark') as THREE.BufferAttribute;
      expect(bark).toBeDefined();
      let barkCount = 0;
      let foliageCount = 0;
      for (let i = 0; i < bark.count; i++) {
        const value = bark.getX(i);
        expect(value === 0 || value === 1).toBe(true);
        if (value === 1) barkCount++;
        else foliageCount++;
      }
      expect(barkCount).toBeGreaterThan(0);
      expect(foliageCount).toBeGreaterThan(0);
    }
  });

  it('gives birch a predominantly light trunk and pine a two-tone one', () => {
    const trunkColors = (species: 'birch' | 'pine'): THREE.Color[] => {
      const geometry = buildArchetype(species, 11);
      const bark = geometry.getAttribute('bark') as THREE.BufferAttribute;
      const color = geometry.getAttribute('color') as THREE.BufferAttribute;
      const out: THREE.Color[] = [];
      for (let i = 0; i < bark.count; i++) {
        if (bark.getX(i) === 1) out.push(new THREE.Color(color.getX(i), color.getY(i), color.getZ(i)));
      }
      return out;
    };

    const birch = trunkColors('birch');
    const light = birch.filter((c) => (c.r + c.g + c.b) / 3 > 0.4).length;
    expect(light / birch.length).toBeGreaterThan(0.6);

    // Pine's species tell: warm (r > b) bark on the upper trunk.
    const pine = trunkColors('pine');
    const warm = pine.filter((c) => c.r > c.b * 1.5).length;
    expect(warm).toBeGreaterThan(0);
  });

  it('derives distinct variant seeds per (species, variant)', () => {
    const seen = new Set<number>();
    for (const species of ARCHETYPE_SPECIES) {
      for (let variant = 0; variant < ARCHETYPE_VARIANTS; variant++) {
        seen.add(archetypeSeed(1, species, variant));
      }
    }
    expect(seen.size).toBe(ARCHETYPE_SPECIES.length * ARCHETYPE_VARIANTS);
  });
});

describe('createArchetypeMaterial', () => {
  it('injects the bark colour split, keeping the include anchors', () => {
    const material = createArchetypeMaterial() as THREE.MeshLambertMaterial;
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <color_vertex>\n#include <begin_vertex>\n#include <project_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>\n#include <dithering_fragment>',
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('attribute float bark;');
    expect(shader.vertexShader).toContain('#include <color_vertex>');
    expect(shader.vertexShader).toContain('#include <project_vertex>');
    expect(shader.fragmentShader).toContain('mix(diffuseColor.rgb, vBarkColor, vBark)');
    expect(shader.fragmentShader).toContain('#include <dithering_fragment>');
    expect(material.vertexColors).toBe(true);
  });

  it('extends the program cache key so archetype programs never alias plain Lambert', () => {
    const material = createArchetypeMaterial();
    expect(material.customProgramCacheKey()).toContain('archetype');
  });
});
