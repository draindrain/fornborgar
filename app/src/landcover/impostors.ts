/**
 * Baked tree impostors (PLAN §6.1 amendment — the LOD tier's far half).
 *
 * A 150k-instance near field cannot draw a few hundred triangles per tree, and
 * does not need to: past a few hundred meters a tree is silhouette + colour.
 * At startup each (species, variant) archetype is rendered once into a shared
 * texture atlas from `AZIMUTH_FRAMES` compass directions, and everything beyond
 * the mesh radius draws as one camera-facing quad sampling that atlas — the
 * exact photoreal analogue of the far field's flat-colour billboard, produced
 * with zero authored assets and deterministic because the archetypes are.
 *
 * Two textures, same layout, one draw:
 *
 *   • **Colour atlas** — the archetype's vertex colours (foliage = white × AO,
 *     bark = bark RGB) rendered unlit; alpha is coverage. Unlit on purpose: a
 *     baked sun direction would disagree with the scene's movable sun, so the
 *     quad is lit by the scene's Lambert with an up normal, exactly like the
 *     §13 far billboards ("lighting reads like the ground").
 *   • **Bark mask** — the geometry's `bark` attribute as grayscale. The
 *     impostor fragment tints foliage pixels by the instance colour and leaves
 *     bark pixels alone, mirroring `createArchetypeMaterial`'s split (a birch
 *     trunk stays white in every stand).
 *
 * Frame selection happens per instance in the vertex shader: the quad rotates
 * to face the camera about the vertical axis (the far-field idiom — rotation
 * composed *before* a yaw-free, XZ-symmetric instance matrix so it commutes
 * exactly), and the instance's own `yaw` attribute offsets which of the 8
 * azimuth frames is sampled, so a stand of impostors shows varied aspects
 * instead of one cloned picture. Alpha-tested, never blended: no sorting, and
 * the zero-scale suppression trick works unchanged.
 */

import * as THREE from 'three';
import {
  ARCHETYPE_SPECIES,
  ARCHETYPE_VARIANTS,
  archetypeGeometry,
  type ArchetypeSpecies,
} from './treeGeometry';

/** Compass directions each archetype is baked from. */
export const AZIMUTH_FRAMES = 8;

/** Pixels per atlas cell (square: the archetype is unit-height, unit-wide). */
export const CELL_PX = 128;

/** All archetypes in bake order — row index in the atlas. */
export const ARCHETYPE_COUNT = ARCHETYPE_SPECIES.length * ARCHETYPE_VARIANTS;

export function archetypeIndex(species: ArchetypeSpecies, variant: number): number {
  return ARCHETYPE_SPECIES.indexOf(species) * ARCHETYPE_VARIANTS + variant;
}

/**
 * Atlas layout: one row per archetype, one column per azimuth frame.
 * 12 rows × 8 columns of 128 px = 1024 × 1536 — WebGL2 needs no power of two.
 */
export interface AtlasLayout {
  width: number;
  height: number;
  cols: number;
  rows: number;
}

export function atlasLayout(): AtlasLayout {
  return {
    cols: AZIMUTH_FRAMES,
    rows: ARCHETYPE_COUNT,
    width: AZIMUTH_FRAMES * CELL_PX,
    height: ARCHETYPE_COUNT * CELL_PX,
  };
}

/** UV origin + extent of one frame cell, for tests and the shader's math. */
export function frameUV(archetype: number, frame: number): { u: number; v: number; w: number; h: number } {
  const layout = atlasLayout();
  return {
    u: frame / layout.cols,
    v: 1 - (archetype + 1) / layout.rows,
    w: 1 / layout.cols,
    h: 1 / layout.rows,
  };
}

export interface ImpostorAtlas {
  color: THREE.Texture;
  mask: THREE.Texture;
  layout: AtlasLayout;
  dispose(): void;
}

/** The bake pass's bark-mask override: the `bark` attribute as grayscale. */
function maskMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'impostor-bake-mask',
    vertexShader: [
      'attribute float bark;',
      'varying float vBark;',
      'void main() {',
      '  vBark = bark;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}',
    ].join('\n'),
    fragmentShader: [
      'varying float vBark;',
      'void main() { gl_FragColor = vec4(vBark, vBark, vBark, 1.0); }',
    ].join('\n'),
  });
}

/**
 * Bake every (species, variant) archetype into the colour + mask atlases.
 * Runs once at startup on the app's own renderer; deterministic because the
 * archetypes are. The caller owns disposal (`ImpostorAtlas.dispose`).
 */
export function bakeImpostorAtlas(renderer: THREE.WebGLRenderer, seed: number): ImpostorAtlas {
  const layout = atlasLayout();
  const makeTarget = (): THREE.WebGLRenderTarget =>
    new THREE.WebGLRenderTarget(layout.width, layout.height, {
      // NearestFilter on minification would shimmer; linear + no mips keeps the
      // alpha-tested edge stable and avoids cross-cell mip bleeding.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
  const colorTarget = makeTarget();
  const maskTarget = makeTarget();

  const scene = new THREE.Scene();
  // Unlit bake (module comment): vertex colours are the whole payload.
  const colorMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mask = maskMaterial();
  mask.side = THREE.DoubleSide;

  // Orthographic camera framing the unit archetype: x ∈ [−0.5, 0.5], y ∈ [0, 1].
  const camera = new THREE.OrthographicCamera(-0.5, 0.5, 1, 0, -2, 2);

  const previousTarget = renderer.getRenderTarget();
  // The renderer is the app's own: every piece of state this bake touches is
  // captured here and put back at the end, viewport included (see below).
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousAutoClear = renderer.autoClear;
  const previousClearColor = new THREE.Color();
  renderer.getClearColor(previousClearColor);
  const previousClearAlpha = renderer.getClearAlpha();

  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);

  const geometries: THREE.BufferGeometry[] = [];
  for (const [pass, target] of [
    [colorMaterial, colorTarget],
    [mask, maskTarget],
  ] as const) {
    renderer.setRenderTarget(target);
    renderer.clear(true, true, false);
    for (let row = 0; row < ARCHETYPE_COUNT; row++) {
      const species = ARCHETYPE_SPECIES[Math.floor(row / ARCHETYPE_VARIANTS)];
      const variant = row % ARCHETYPE_VARIANTS;
      const geometry = archetypeGeometry(species, variant, seed);
      geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, pass);
      scene.add(mesh);
      for (let frame = 0; frame < AZIMUTH_FRAMES; frame++) {
        const azimuth = (frame / AZIMUTH_FRAMES) * Math.PI * 2;
        camera.position.set(Math.sin(azimuth), 0.5, Math.cos(azimuth));
        camera.up.set(0, 1, 0);
        camera.lookAt(0, 0.5, 0);
        // OrthographicCamera's frustum is symmetric about its own axis; keep
        // the unit framing by re-centering top/bottom around the look height.
        camera.top = 0.5;
        camera.bottom = -0.5;
        camera.updateProjectionMatrix();
        // Cells are addressed in the target's own texels, so the render
        // target's viewport is the one to move: `renderer.setViewport` means
        // CSS pixels and scales by the canvas pixel ratio, which would both
        // mis-place the cells on a HiDPI display and leave that scaled
        // viewport behind for the scene we are borrowing the renderer from.
        target.viewport.set(frame * CELL_PX, (ARCHETYPE_COUNT - 1 - row) * CELL_PX, CELL_PX, CELL_PX);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
      }
      scene.remove(mesh);
    }
    target.viewport.set(0, 0, layout.width, layout.height); // leave it whole
  }

  renderer.setRenderTarget(previousTarget);
  renderer.setViewport(previousViewport);
  renderer.autoClear = previousAutoClear;
  renderer.setClearColor(previousClearColor, previousClearAlpha);
  for (const geometry of geometries) geometry.dispose();
  colorMaterial.dispose();
  mask.dispose();

  return {
    color: colorTarget.texture,
    mask: maskTarget.texture,
    layout,
    dispose: () => {
      colorTarget.dispose();
      maskTarget.dispose();
    },
  };
}

/**
 * The impostor quad material for one archetype (= one atlas row). Injections,
 * in the app's established onBeforeCompile idiom (include anchors intact,
 * distinct cache key):
 *
 *   • cylindrical camera-facing rotation — verbatim the §13 far-billboard
 *     math, legal for the same reason (yaw-free instances, symmetric XZ scale);
 *   • per-instance azimuth frame selection from the `yaw` instanced attribute:
 *     the view azimuth minus the tree's own yaw picks which baked frame shows;
 *   • the archetype's atlas row as a uniform — the row is constant per
 *     `InstancedMesh` (batches are keyed by (species, variant)), so the twelve
 *     material instances share one shader program via the common cache key;
 *   • the bark/foliage split: foliage pixels multiply the instance colour,
 *     bark pixels keep the atlas colour (mask texture).
 *
 * Alpha-tested and opaque — no sorting, honest depth, suppression untouched.
 */
export function createImpostorMaterial(atlas: ImpostorAtlas, archetypeRow: number): THREE.Material {
  const material = new THREE.MeshLambertMaterial({
    side: THREE.DoubleSide,
    transparent: false,
    alphaTest: 0.5,
  });
  material.name = `vegetation-impostors-${archetypeRow}`;

  const uniforms = {
    uAtlasColor: { value: atlas.color },
    uAtlasMask: { value: atlas.mask },
    uFrames: { value: AZIMUTH_FRAMES },
    uRows: { value: atlas.layout.rows },
    uRow: { value: archetypeRow },
  };

  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}|treeimpostor`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'attribute float yaw;',
          'uniform float uFrames;',
          'uniform float uRows;',
          'uniform float uRow;',
          'varying vec2 vImpostorUv;',
        ].join('\n'),
      )
      .replace(
        '#include <begin_vertex>',
        [
          // Cylindrical billboarding, the §13 far-billboard math verbatim:
          // rotate the unit quad about its vertical axis to face the camera.
          'vec4 tiInst = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
          'vec3 tiWorld = (modelMatrix * tiInst).xyz;',
          'vec2 tiToCam = cameraPosition.xz - tiWorld.xz;',
          'float tiAng = atan(tiToCam.x, tiToCam.y);',
          'float tiS = sin(tiAng); float tiC = cos(tiAng);',
          'vec3 transformed = vec3(',
          '  tiC * position.x + tiS * position.z,',
          '  position.y,',
          '  -tiS * position.x + tiC * position.z);',
          // Frame selection: the view azimuth relative to the tree\'s own yaw
          // picks the baked aspect, so a stand shows varied frames.
          'float tiRel = tiAng - yaw;',
          'float tiFrame = mod(floor(tiRel / (6.28318530718 / uFrames) + 0.5), uFrames);',
          'vImpostorUv = vec2(',
          '  (tiFrame + uv.x) / uFrames,',
          '  1.0 - (uRow + 1.0 - uv.y) / uRows);',
        ].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'uniform sampler2D uAtlasColor;',
          'uniform sampler2D uAtlasMask;',
          'varying vec2 vImpostorUv;',
        ].join('\n'),
      )
      .replace(
        '#include <color_fragment>',
        [
          'vec4 tiTexel = texture2D(uAtlasColor, vImpostorUv);',
          'float tiBark = texture2D(uAtlasMask, vImpostorUv).r;',
          '#include <color_fragment>',
          // Foliage multiplies the instance colour (already in diffuseColor via
          // vColor); bark keeps the atlas colour. Alpha is baked coverage.
          'diffuseColor.rgb = mix(diffuseColor.rgb * tiTexel.rgb, tiTexel.rgb, tiBark);',
          'diffuseColor.a = tiTexel.a;',
        ].join('\n'),
      );
  };
  return material;
}

/**
 * One unit quad, base-anchored, normals up — lighting reads like the ground
 * whatever the facing (the far-field billboard's reasoning, at nearer range).
 */
export function impostorGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0, 0.5, 0);
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, 1, 0);
  normals.needsUpdate = true;
  return geometry;
}
