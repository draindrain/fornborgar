/**
 * The land-cover ground tint (Phase 7, contract §9 "Rendering contract").
 *
 * A stylized flat per-class colour wash blended into the terrain materials, from the
 * §10 palette, addressed by world XZ over the context grid's extent — the same
 * injection idiom `ViewshedOverlay.attach` and `WaterLayer.attachTerrain` use, and
 * the same reason it works: the terrain group is Y-scaled only (contract §0), so
 * world XZ equals local XZ and no matrix bookkeeping is needed.
 *
 * ## Where this sits in the overlay chain
 *
 * Three modules now inject into the same two terrain materials. Each chains the
 * handler it found and each injects with the "keep the include, append to it" idiom,
 * so the anchor tokens (`#include <common>`, `#include <begin_vertex>`,
 * `#include <dithering_fragment>`) survive for the next injector and **attach order
 * is shading order**. The contract fixes that order:
 *
 *     viewshed  →  landcover  →  water
 *
 * The land-cover wash must not erase the viewshed's visible/hidden distinction, and
 * submerged ground must still read as submerged whatever the land cover says — so
 * the water tint deliberately shades last. `main.ts` attaches in exactly this order.
 *
 * Identifiers are namespaced `uLandcover*` / `vLandcoverXZ`, and
 * `customProgramCacheKey` is extended so a material carrying this injection can never
 * share a compiled program with one that does not.
 *
 * ## Two textures, two filters — deliberately different
 *
 * The class texture is `NearestFilter` in both directions: class **indices** must
 * never be interpolated (§9), or a 2 m boundary between class 0 and class 4 would
 * briefly read as classes 1–3.
 *
 * The §7 connect texture this module also carries (v1.3, below) is `LinearFilter`
 * for the opposite reason: it holds *meters*, a continuous field, and the water
 * line and the reed belt's edge are level sets of it. Filtering them linearly is
 * what makes the band a smooth contour instead of a 2 m staircase — the same
 * recipe, and the same reason, as `water/water.ts`'s `connectTexture()`.
 *
 * ## v1.3 — dynamic hydrology (contract §9/§10 amendment)
 *
 * The raster is frozen at one reference century, but two of its classes were pure
 * functions of the water level. A legend may now mark them `dynamic`:
 * `{kind:'water'}` and `{kind:'shore-band', bandM}`. When the site also ships a §7
 * connect grid, this module derives both at the **current slider level** instead of
 * reading them from the raster:
 *
 *     connect ≤ level                     → the water class's colour (the sea)
 *     level < connect ≤ level + bandM      → the shore-band class's colour
 *
 * over whatever static class the raster holds there, and still *before* the §7 water
 * tint, so submerged ground shades last exactly as it did pre-v1.3. Sites with no
 * connect grid, and legends with no `dynamic` classes, take neither branch
 * (`uLandcoverHydroOn` stays 0) and render exactly as before.
 *
 * `hydroTintClass()` below is the executable spec of that GLSL precedence; the tests
 * use it as the truth table.
 */

import * as THREE from 'three';
import type { ConnectGrid } from '../water/connectGrid';
import type { LandcoverGrid } from './landcoverGrid';
import { MAX_CLASSES, dynamicClass, type LandcoverLegend } from './legend';

/**
 * How hard the wash is mixed into the shaded terrain colour. Moderate on purpose:
 * the relief shading — the thing the terrain is actually for — has to keep reading
 * through it, and the layer is a model, not a photograph.
 */
export const TINT_MIX = 0.45;

/**
 * "No level in play" — far below any connect value, so both dynamic branches are
 * false everywhere. `setWaterLevel(null)` restores it.
 */
export const NO_LEVEL_SENTINEL = -1e9;

/**
 * The executable spec of the dynamic-tint precedence the fragment shader implements
 * (contract §9 v1.3). Pure, so the tests can use it as a truth table.
 *
 *   sea wins over band, band wins over the raster class, and the band never repaints
 *   the sea. `bandM ≤ 0` disables the band entirely.
 *
 * Pass `-1` for `waterClassIndex` / `bandClassIndex` when the legend declares no
 * class of that kind; the corresponding branch is then inert, exactly like the
 * `uLandcoverSeaOn` / `uLandcoverBandM` guards in the GLSL.
 */
export function hydroTintClass(
  connectValue: number,
  levelM: number,
  bandM: number,
  rasterClass: number,
  waterClassIndex: number,
  bandClassIndex: number,
): number {
  if (waterClassIndex >= 0 && connectValue <= levelM) return waterClassIndex;
  if (bandClassIndex >= 0 && bandM > 0 && connectValue > levelM && connectValue <= levelM + bandM) {
    return bandClassIndex;
  }
  return rasterClass;
}

/**
 * Half-float R texture of the §7 connect grid, addressed by world XZ.
 *
 * Deliberately the same recipe as `water/water.ts`'s `connectTexture()`, down to the
 * filter choice: linear filtering is what makes the shoreline (and the band's outer
 * edge) a smooth contour instead of a 2 m staircase; half-float is filterable in
 * WebGL2 core (R32F is not). Note the contrast with the class texture above, which is
 * `NearestFilter` precisely because *its* values must never be interpolated.
 */
function connectTexture(grid: ConnectGrid): THREE.DataTexture {
  const data = new Uint16Array(grid.values.length);
  for (let i = 0; i < grid.values.length; i++) data[i] = THREE.DataUtils.toHalfFloat(grid.values[i]);
  const texture = new THREE.DataTexture(data, grid.width, grid.height, THREE.RedFormat, THREE.HalfFloatType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** A 1x1 stand-in, so the sampler uniform is always bound even with hydro off. */
function placeholderConnectTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint16Array([THREE.DataUtils.toHalfFloat(0)]),
    1,
    1,
    THREE.RedFormat,
    THREE.HalfFloatType,
  );
  texture.needsUpdate = true;
  return texture;
}

export class LandcoverTint {
  readonly texture: THREE.DataTexture;
  readonly classCount: number;
  /** The §7 connect texture, or `null` when the site ships no connect grid. */
  readonly connectTexture: THREE.DataTexture | null;

  private readonly placeholder: THREE.DataTexture | null;

  private readonly uniforms: {
    uLandcoverClass: { value: THREE.DataTexture };
    uLandcoverOn: { value: number };
    /** minX, minZ, 1/sizeX, 1/sizeZ of the class raster's ground rectangle. */
    uLandcoverRect: { value: THREE.Vector4 };
    uLandcoverPalette: { value: THREE.Color[] };
    uLandcoverCount: { value: number };
    uLandcoverMix: { value: number };
    // --- v1.3 dynamic hydrology (§9/§10) ---------------------------------------
    uLandcoverConnect: { value: THREE.DataTexture };
    /** Current slider level, m. `NO_LEVEL_SENTINEL` = no level in play. */
    uLandcoverLevel: { value: number };
    /** Shore-band width above the water line, m. 0 disables the band branch. */
    uLandcoverBandM: { value: number };
    /** 1 iff a connect grid *and* at least one dynamic class are present. */
    uLandcoverHydroOn: { value: number };
    /** 1 iff the legend declares a `dynamic: {kind:'water'}` class. */
    uLandcoverSeaOn: { value: number };
    uLandcoverSeaColor: { value: THREE.Color };
    uLandcoverBandColor: { value: THREE.Color };
  };

  /**
   * `connect` is the §7 grid, or `null` for a site that ships no water assets. It is
   * used only when the legend declares v1.3 `dynamic` classes; §7 and §9 share the
   * context grid's geometry by contract, so the class rect addresses both textures.
   */
  constructor(grid: LandcoverGrid, legend: LandcoverLegend, connect: ConnectGrid | null = null) {
    this.classCount = legend.classes.length;

    // A copy, not a view: the texture owns its bytes for the renderer's lifetime
    // while `grid.classes` stays the analysis-side array the sampler reads.
    this.texture = new THREE.DataTexture(
      Uint8Array.from(grid.classes),
      grid.width,
      grid.height,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;

    // Fixed-length palette: GLSL needs a compile-time array size, and §9 caps the
    // class count at 32. Unused slots are neutral grey, never sampled.
    const palette: THREE.Color[] = [];
    for (let i = 0; i < MAX_CLASSES; i++) {
      const entry = legend.classes[i];
      palette.push(
        entry
          ? new THREE.Color().setStyle(entry.color, THREE.SRGBColorSpace)
          : new THREE.Color().setStyle('#808080', THREE.SRGBColorSpace),
      );
    }

    // --- v1.3: the two runtime-derived classes, if this legend declares them ---
    const waterClass = dynamicClass(legend, 'water');
    const bandClass = dynamicClass(legend, 'shore-band');
    const hasDynamic = waterClass !== null || bandClass !== null;
    // Both halves are required: a legend can declare dynamic classes at a site that
    // ships no water assets (then the feature is simply off, never an error), and a
    // site can ship a connect grid under a pre-v1.3 legend.
    const hydroOn = connect !== null && hasDynamic;

    this.connectTexture = hydroOn ? connectTexture(connect) : null;
    this.placeholder = this.connectTexture ? null : placeholderConnectTexture();

    const b = grid.boundsLocal;
    this.uniforms = {
      uLandcoverClass: { value: this.texture },
      uLandcoverOn: { value: 0 },
      uLandcoverRect: {
        value: new THREE.Vector4(b.minX, b.minZ, 1 / (b.maxX - b.minX), 1 / (b.maxZ - b.minZ)),
      },
      uLandcoverPalette: { value: palette },
      uLandcoverCount: { value: this.classCount },
      uLandcoverMix: { value: TINT_MIX },
      uLandcoverConnect: { value: (this.connectTexture ?? this.placeholder) as THREE.DataTexture },
      uLandcoverLevel: { value: NO_LEVEL_SENTINEL },
      uLandcoverBandM: { value: hydroOn && bandClass?.dynamic?.bandM ? bandClass.dynamic.bandM : 0 },
      uLandcoverHydroOn: { value: hydroOn ? 1 : 0 },
      uLandcoverSeaOn: { value: hydroOn && waterClass ? 1 : 0 },
      uLandcoverSeaColor: {
        value: new THREE.Color().setStyle(waterClass?.color ?? '#808080', THREE.SRGBColorSpace),
      },
      uLandcoverBandColor: {
        value: new THREE.Color().setStyle(bandClass?.color ?? '#808080', THREE.SRGBColorSpace),
      },
    };
  }

  /**
   * Inject the wash into one terrain material, chaining any handler already there.
   * Call once per material, **after** the viewshed overlay and **before** the water
   * layer (see the module comment).
   */
  attach(material: THREE.Material): void {
    const uniforms = this.uniforms;
    const previousCompile = material.onBeforeCompile;
    const previousKey = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${previousKey()}|landcover2`;

    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vLandcoverXZ;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvLandcoverXZ = (modelMatrix * vec4(position, 1.0)).xz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'varying vec2 vLandcoverXZ;',
            'uniform sampler2D uLandcoverClass;',
            'uniform float uLandcoverOn;',
            'uniform vec4 uLandcoverRect;',
            `uniform vec3 uLandcoverPalette[${MAX_CLASSES}];`,
            'uniform int uLandcoverCount;',
            'uniform float uLandcoverMix;',
            'uniform sampler2D uLandcoverConnect;',
            'uniform float uLandcoverLevel;',
            'uniform float uLandcoverBandM;',
            'uniform float uLandcoverHydroOn;',
            'uniform float uLandcoverSeaOn;',
            'uniform vec3 uLandcoverSeaColor;',
            'uniform vec3 uLandcoverBandColor;',
          ].join('\n'),
        )
        .replace(
          '#include <dithering_fragment>',
          [
            'if (uLandcoverOn > 0.5) {',
            '  vec2 lcUv = (vLandcoverXZ - uLandcoverRect.xy) * uLandcoverRect.zw;',
            '  if (all(greaterThanEqual(lcUv, vec2(0.0))) && all(lessThanEqual(lcUv, vec2(1.0)))) {',
            '    // NearestFilter + the 0..255 byte range: this is the class INDEX (§9).',
            '    int lcIndex = int(texture2D(uLandcoverClass, lcUv).r * 255.0 + 0.5);',
            '    vec3 lcColor = vec3(0.5);',
            // Loop-variable indexing keeps this legal in GLSL ES 1.00 too, where a
            // dynamically indexed uniform array is not.
            `    for (int i = 0; i < ${MAX_CLASSES}; i++) {`,
            '      if (i >= uLandcoverCount) break;',
            '      if (i == lcIndex) lcColor = uLandcoverPalette[i];',
            '    }',
            // v1.3 (§9): the two classes that are functions of the water level are
            // derived here, at the CURRENT level, instead of being read from the
            // reference-century raster. `hydroTintClass()` above is the same rule in
            // TypeScript. The connect lookup is linear-filtered on purpose, so the
            // sea edge and the band edge are smooth contours (module comment).
            '    if (uLandcoverHydroOn > 0.5) {',
            '      float lcConnect = texture2D(uLandcoverConnect, lcUv).r;',
            '      if (uLandcoverSeaOn > 0.5 && lcConnect <= uLandcoverLevel) {',
            '        lcColor = uLandcoverSeaColor;',
            // `lcConnect > uLandcoverLevel` is redundant while the sea branch is on,
            // and load-bearing when it is off: the band must never repaint the sea.
            '      } else if (uLandcoverBandM > 0.0 && lcConnect > uLandcoverLevel',
            '                 && lcConnect <= uLandcoverLevel + uLandcoverBandM) {',
            '        lcColor = uLandcoverBandColor;',
            '      }',
            '    }',
            '    // Multiply, so the relief shading still reads through the wash.',
            '    vec3 lcShaded = gl_FragColor.rgb * (lcColor * 2.0);',
            '    gl_FragColor.rgb = mix(gl_FragColor.rgb, lcShaded, uLandcoverMix);',
            '  }',
            '}',
            '#include <dithering_fragment>',
          ].join('\n'),
        );
    };
    material.needsUpdate = true;
  }

  setEnabled(on: boolean): void {
    this.uniforms.uLandcoverOn.value = on ? 1 : 0;
  }

  get enabled(): boolean {
    return this.uniforms.uLandcoverOn.value > 0.5;
  }

  /** Wash strength, 0…1. Exposed for tuning; the default is `TINT_MIX`. */
  setMix(mix: number): void {
    this.uniforms.uLandcoverMix.value = Math.max(0, Math.min(1, mix));
  }

  /**
   * Push the current shoreline level into the dynamic classes (§9 v1.3). `null` =
   * no level in play, which parks the level at `NO_LEVEL_SENTINEL` so neither the
   * sea nor the band branch can fire. A no-op for a tint with hydro off.
   */
  setWaterLevel(levelM: number | null): void {
    this.uniforms.uLandcoverLevel.value = levelM === null ? NO_LEVEL_SENTINEL : levelM;
  }

  /** The level currently driving the dynamic classes, or `null` for the sentinel. */
  get waterLevel(): number | null {
    const value = this.uniforms.uLandcoverLevel.value;
    return value === NO_LEVEL_SENTINEL ? null : value;
  }

  /** Is the v1.3 dynamic derivation live (connect grid **and** dynamic classes)? */
  get hydroEnabled(): boolean {
    return this.uniforms.uLandcoverHydroOn.value > 0.5;
  }

  /** Shore-band width in meters, 0 when the legend declares no shore-band class. */
  get bandM(): number {
    return this.uniforms.uLandcoverBandM.value;
  }

  dispose(): void {
    this.texture.dispose();
    this.connectTexture?.dispose();
    this.placeholder?.dispose();
  }
}
