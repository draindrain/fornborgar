/**
 * Baked tree impostors + the near-field LOD split (§6.1 amendment).
 *
 * The bake's pixels need a GL context, so what these tests pin is everything
 * around it: the bake's use of the renderer it borrows (cells addressed in
 * target texels, every borrowed piece of state handed back), the atlas layout
 * math, the impostor material's shader injections
 * (the far-billboard anchor-test pattern), and — through a stub atlas — the
 * VegetationLayer tier machinery: exactly one visible tier per instance, tiers
 * split by camera distance with hysteresis, suppression zeroing both tiers,
 * and byte-identical layouts with or without an atlas.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ARCHETYPE_COUNT,
  AZIMUTH_FRAMES,
  CELL_PX,
  archetypeIndex,
  atlasLayout,
  bakeImpostorAtlas,
  createImpostorMaterial,
  frameUV,
  impostorGeometry,
  type ImpostorAtlas,
} from '../src/landcover/impostors';
import { ARCHETYPE_SPECIES, ARCHETYPE_VARIANTS } from '../src/landcover/treeGeometry';
import {
  MESH_TIER_RADIUS_M,
  REBIN_MOVE_M,
  VegetationLayer,
} from '../src/landcover/vegetation';
import type { LandcoverGrid } from '../src/landcover/landcoverGrid';
import { validateLandcoverLegend } from '../src/landcover/legend';

// ------------------------------------------------------------ atlas layout --

describe('atlas layout', () => {
  it('gives every (species, variant) a distinct row and every frame a distinct cell', () => {
    const seen = new Set<string>();
    for (const species of ARCHETYPE_SPECIES) {
      for (let variant = 0; variant < ARCHETYPE_VARIANTS; variant++) {
        const row = archetypeIndex(species, variant);
        expect(row).toBeGreaterThanOrEqual(0);
        expect(row).toBeLessThan(ARCHETYPE_COUNT);
        for (let frame = 0; frame < AZIMUTH_FRAMES; frame++) {
          const { u, v, w, h } = frameUV(row, frame);
          expect(u).toBeGreaterThanOrEqual(0);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(u + w).toBeLessThanOrEqual(1 + 1e-9);
          expect(v + h).toBeLessThanOrEqual(1 + 1e-9);
          const key = `${u.toFixed(6)},${v.toFixed(6)}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    }
    expect(seen.size).toBe(ARCHETYPE_COUNT * AZIMUTH_FRAMES);
  });

  it('sizes the atlas to the cell grid', () => {
    const layout = atlasLayout();
    expect(layout.width).toBe(layout.cols * 128);
    expect(layout.height).toBe(layout.rows * 128);
    expect(layout.rows).toBe(ARCHETYPE_COUNT);
  });
});

// ------------------------------------------------------------ the material --

function stubAtlas(): ImpostorAtlas {
  return {
    color: new THREE.Texture(),
    mask: new THREE.Texture(),
    layout: atlasLayout(),
    dispose: () => {},
  };
}

describe('createImpostorMaterial', () => {
  it('injects facing, frame selection and the bark split, keeping the anchors', () => {
    const material = createImpostorMaterial(stubAtlas(), 3) as THREE.MeshLambertMaterial;
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>\n#include <dithering_fragment>',
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('cameraPosition.xz');
    expect(shader.vertexShader).toContain('attribute float yaw;');
    expect(shader.vertexShader).toContain('vec3 transformed = vec3(');
    expect(shader.vertexShader).toContain('#include <project_vertex>');
    expect(shader.fragmentShader).toContain('uAtlasColor');
    expect(shader.fragmentShader).toContain('#include <dithering_fragment>');
    expect(shader.uniforms).toHaveProperty('uRow');
    // Alpha-tested, never blended: no sorting, and zero-scale suppression works.
    expect(material.transparent).toBe(false);
    expect(material.alphaTest).toBe(0.5);
  });

  it('extends the program cache key so impostor programs never alias plain Lambert', () => {
    expect(createImpostorMaterial(stubAtlas(), 0).customProgramCacheKey()).toContain('treeimpostor');
  });

  it('anchors the quad at its base with up normals', () => {
    const geometry = impostorGeometry();
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(geometry.boundingBox!.max.y).toBeCloseTo(1, 6);
    const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < normals.count; i++) expect(normals.getY(i)).toBe(1);
  });
});

// ------------------------------------------- textured far-field billboards --

describe('createBillboardMaterial with an atlas (§6.1)', () => {
  it('samples the atlas row, keeps the fade, and stays distinct from the flat path', async () => {
    const { createBillboardMaterial } = await import('../src/landcover/farVegetation');
    const material = createBillboardMaterial(2000, { atlas: stubAtlas(), row: 2 }) as THREE.MeshLambertMaterial;
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>',
      fragmentShader: '#include <common>\n#include <color_fragment>\n#include <dithering_fragment>',
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('cameraPosition.xz');
    expect(shader.vertexShader).toContain('vAtlasUv');
    expect(shader.vertexShader).toContain('#include <project_vertex>');
    expect(shader.fragmentShader).toContain('uAtlasColor');
    expect(shader.fragmentShader).toContain('fbTexel.a * vFarFade');
    expect(shader.uniforms).toHaveProperty('uRow');
    expect(material.customProgramCacheKey()).toContain('farbillboard-tex');

    // The flat path must remain what the §13 anchor tests pin.
    const flat = createBillboardMaterial(2000);
    expect(flat.customProgramCacheKey()).toContain('farbillboard');
    expect(flat.customProgramCacheKey()).not.toContain('-tex');
  });
});

// ------------------------------------------------------- the LOD machinery --

/** One all-conifer 1 km grid — big enough for both tiers to exist at once. */
function conedLayer(atlas: ImpostorAtlas | null, seed = 1): VegetationLayer {
  const size = 64;
  const cell = 16; // 1024 m across
  const legend = validateLandcoverLegend({
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
  const grid: LandcoverGrid = {
    width: size,
    height: size,
    resolution: cell,
    boundsLocal: { minX: -512, maxX: 512, minZ: -512, maxZ: 512 },
    classes: new Uint8Array(size * size).fill(0),
  };
  return new VegetationLayer(
    grid,
    legend,
    {
      groundAt: () => 10,
      getExaggeration: () => 1,
      connectAt: null,
      impostorAtlas: atlas ? () => atlas : null,
    },
    { seed },
  );
}

function scaleY(m: THREE.Matrix4): number {
  return new THREE.Vector3().setFromMatrixColumn(m, 1).length();
}

describe('near-field LOD tiers (§6.1)', () => {
  it('draws every tree as a full mesh when no atlas is available', () => {
    const layer = conedLayer(null);
    expect(scaleY(layer.instanceMatrix('conifer', 0))).toBeGreaterThan(0);
    expect(layer.impostorInstanceMatrix('conifer', 0)).toBeNull();
    layer.dispose();
  });

  it('shows exactly one tier per instance, split by camera distance', () => {
    const layer = conedLayer(stubAtlas());
    const n = layer.countsByType()['conifer'] ?? 0;
    expect(n).toBeGreaterThan(100);

    // Before any camera: everything mesh tier, impostors all zero-scale.
    for (const i of [0, 5, n - 1]) {
      expect(scaleY(layer.instanceMatrix('conifer', i))).toBeGreaterThan(0);
      expect(scaleY(layer.impostorInstanceMatrix('conifer', i)!)).toBe(0);
    }

    // Camera at the SW corner: near instances stay meshes, far ones swap tier.
    layer.updateCamera(-512, -512);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    let meshTier = 0;
    let impostorTier = 0;
    for (let i = 0; i < n; i++) {
      const meshScale = scaleY(layer.instanceMatrix('conifer', i, matrix));
      matrix.decompose(position, new THREE.Quaternion(), new THREE.Vector3());
      const impostorScale = scaleY(layer.impostorInstanceMatrix('conifer', i)!);
      const distance = Math.hypot(position.x - -512, position.z - -512);
      if (meshScale > 0) {
        meshTier++;
        expect(impostorScale).toBe(0);
        // Position only survives in the visible tier, so use the mesh matrix.
        expect(distance).toBeLessThanOrEqual(MESH_TIER_RADIUS_M + 1);
      } else {
        impostorTier++;
        expect(impostorScale).toBeGreaterThan(0);
      }
    }
    expect(meshTier).toBeGreaterThan(0);
    expect(impostorTier).toBeGreaterThan(0);
    layer.dispose();
  });

  it('keeps impostor matrices rotation-free (the facing shader owns rotation)', () => {
    const layer = conedLayer(stubAtlas());
    layer.updateCamera(10_000, 10_000); // everything impostor tier
    const m = layer.impostorInstanceMatrix('conifer', 0)!;
    const q = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    expect(Math.abs(q.w)).toBeCloseTo(1, 6);
    layer.dispose();
  });

  it('rebins only after the camera has moved REBIN_MOVE_M (hysteresis)', () => {
    const layer = conedLayer(stubAtlas());
    layer.updateCamera(0, 0);
    const before = scaleY(layer.instanceMatrix('conifer', 0));
    // A camera step just under the hysteresis distance must not rewrite tiers,
    // even if it would move an instance across the radius.
    layer.updateCamera(REBIN_MOVE_M - 1, 0);
    expect(scaleY(layer.instanceMatrix('conifer', 0))).toBe(before);
    layer.dispose();
  });

  it('is bit-identical for a seed, with and without prior camera moves', () => {
    const a = conedLayer(stubAtlas(), 7);
    const b = conedLayer(stubAtlas(), 7);
    b.updateCamera(200, 200);
    b.updateCamera(-100, 300);
    a.updateCamera(-100, 300);
    const n = a.countsByType()['conifer'] ?? 0;
    for (const i of [0, 3, n - 1]) {
      expect(Array.from(b.instanceMatrix('conifer', i).elements)).toEqual(
        Array.from(a.instanceMatrix('conifer', i).elements),
      );
      expect(Array.from(b.impostorInstanceMatrix('conifer', i)!.elements)).toEqual(
        Array.from(a.impostorInstanceMatrix('conifer', i)!.elements),
      );
    }
    a.dispose();
    b.dispose();
  });

  it('places both tiers of an instance at the same spot with the same footprint', () => {
    const layer = conedLayer(stubAtlas());
    const n = layer.countsByType()['conifer'] ?? 0;
    layer.updateCamera(-512, -512);
    const meshM = new THREE.Matrix4();
    const impM = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      layer.instanceMatrix('conifer', i, meshM);
      layer.impostorInstanceMatrix('conifer', i, impM);
      const meshS = scaleY(meshM);
      const impS = scaleY(impM);
      if (impS === 0) continue; // mesh tier — nothing to compare
      const meshP = new THREE.Vector3().setFromMatrixPosition(meshM);
      const impP = new THREE.Vector3().setFromMatrixPosition(impM);
      // The zero-scale mesh matrix still carries its position.
      expect(impP.x).toBeCloseTo(meshP.x, 4);
      expect(impP.z).toBeCloseTo(meshP.z, 4);
      expect(impS).toBeGreaterThan(0);
      expect(meshS).toBe(0);
    }
    layer.dispose();
  });
});

// ------------------------------------------------------------- the bake pass --

/**
 * A renderer stub: the bake's pixels need GL, but its *use* of the renderer is
 * plain bookkeeping, and that is what broke the scene camera once — a viewport
 * left behind in canvas pixels, doubled again by the pixel ratio, which put the
 * view's centre in a screen corner and made looking up impossible.
 */
const PIXEL_RATIO = 2;

function stubRenderer(): {
  renderer: THREE.WebGLRenderer;
  cells: THREE.Vector4[];
  viewportCalls: THREE.Vector4[];
} {
  const cells: THREE.Vector4[] = [];
  const viewportCalls: THREE.Vector4[] = [];
  // The app's own viewport: CSS pixels, as `setSize` leaves it.
  const viewport = new THREE.Vector4(0, 0, 1280, 720);
  let target: THREE.WebGLRenderTarget | null = null;
  const renderer = {
    domElement: { width: 2560, height: 1440 }, // a 2× HiDPI drawing buffer
    autoClear: true,
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t;
    },
    getPixelRatio: () => PIXEL_RATIO,
    getViewport: (out: THREE.Vector4) => out.copy(viewport),
    // Both call signatures the real renderer takes, and its unit convention:
    // what it stores is CSS pixels, what GL gets is that × the pixel ratio.
    setViewport: (x: THREE.Vector4 | number, y?: number, w?: number, h?: number) => {
      if (typeof x === 'number') viewport.set(x, y!, w!, h!);
      else viewport.copy(x);
      viewportCalls.push(viewport.clone());
    },
    getClearColor: (out: THREE.Color) => out.setRGB(0.1, 0.2, 0.3),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    clear: () => {},
    render: () => {
      // Whatever the bake is drawing into lands in the *target's* viewport.
      if (target) cells.push(target.viewport.clone());
    },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, cells, viewportCalls };
}

describe('bakeImpostorAtlas', () => {
  it('hands the renderer back exactly as it found it', () => {
    const { renderer, viewportCalls } = stubRenderer();
    const atlas = bakeImpostorAtlas(renderer, 7);
    expect(renderer.getRenderTarget()).toBe(null);
    expect(renderer.autoClear).toBe(true);
    // Restored to the app's CSS-pixel viewport — never the drawing buffer's
    // physical size, which the renderer scales by the pixel ratio a second
    // time, landing the scene's view centre in a corner of the canvas.
    const restored = renderer.getViewport(new THREE.Vector4());
    expect([restored.x, restored.y, restored.z, restored.w]).toEqual([0, 0, 1280, 720]);
    for (const v of viewportCalls) {
      // Whatever the bake asks for, the GL viewport it leaves behind covers
      // the drawing buffer exactly.
      expect([v.z * PIXEL_RATIO, v.w * PIXEL_RATIO]).toEqual([
        renderer.domElement.width,
        renderer.domElement.height,
      ]);
    }
    atlas.dispose();
  });

  it('draws every cell inside the atlas, one per (archetype, frame)', () => {
    const { renderer, cells } = stubRenderer();
    const layout = atlasLayout();
    const atlas = bakeImpostorAtlas(renderer, 7);
    // Two passes (colour + bark mask) over the same cell grid.
    expect(cells.length).toBe(2 * ARCHETYPE_COUNT * AZIMUTH_FRAMES);
    const seen = new Set<string>();
    for (const c of cells) {
      expect(c.z).toBe(CELL_PX);
      expect(c.w).toBe(CELL_PX);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.z).toBeLessThanOrEqual(layout.width);
      expect(c.y + c.w).toBeLessThanOrEqual(layout.height);
      seen.add(`${c.x},${c.y}`);
    }
    expect(seen.size).toBe(ARCHETYPE_COUNT * AZIMUTH_FRAMES);
    atlas.dispose();
  });

  it('puts each archetype row where frameUV says it is', () => {
    const { renderer, cells } = stubRenderer();
    const layout = atlasLayout();
    const atlas = bakeImpostorAtlas(renderer, 7);
    for (let row = 0; row < ARCHETYPE_COUNT; row++) {
      for (let frame = 0; frame < AZIMUTH_FRAMES; frame++) {
        const uv = frameUV(row, frame);
        const cell = cells.find((c) => c.x === frame * CELL_PX && c.y === (ARCHETYPE_COUNT - 1 - row) * CELL_PX);
        expect(cell).toBeDefined();
        expect(cell!.x / layout.width).toBeCloseTo(uv.u, 9);
        expect(cell!.y / layout.height).toBeCloseTo(uv.v, 9);
      }
    }
    atlas.dispose();
  });
});
