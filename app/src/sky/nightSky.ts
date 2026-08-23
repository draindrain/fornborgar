/**
 * Everything in the sky that is not the sky itself: the sun's disc, the moon
 * and the stars, plus the uniforms the water reads to reflect them.
 *
 * This is the seam between the astronomy modules — which know nothing about
 * three.js — and the renderer. `main.ts` computes a sun and a moon and hands
 * them here; nothing downstream of this file does any astronomy.
 *
 * ## What is recomputed when
 *
 *  • **Every slider change**: the uniforms and the star field's orientation.
 *    The diurnal rotation is one 3×3 matrix, so the hour slider is nearly free.
 *  • **Year changes**: the stars' epoch directions (5 044 matrix multiplies).
 *  • **Year changes of more than `REBAKE_YEARS`**: the reflection map is baked
 *    again. Precession moves the sky 0.014° a year, so fifty years is one texel
 *    of a 512×256 map — rebaking more often than that would cost a hitch mid-
 *    drag to move stars by less than the width of the texel they sit in.
 */

import * as THREE from 'three';

import type { SkyState } from './atmosphere';
import type { LunarPosition } from './lunar';
import {
  directionFromEquatorial,
  equatorialToWorldMatrix,
  worldDirectionFromHorizontal,
} from './precession';
import { SkyDome } from './skyDome';
import { createSkyUniforms, lunarDiscBasis, type SkyUniforms } from './skyChunk';
import { StarField } from './starField';
import { bakeStarMap, starDirectionsAtEpoch, type StarCatalogue } from './stars';

/** How far the year has to move before the reflection map is baked again. */
export const REBAKE_YEARS = 50;

const STAR_MAP_WIDTH = 512;
const STAR_MAP_HEIGHT = 256;

/** The minimum a body needs to be placed in the sky. */
export interface SkyBody {
  /** Geometric altitude — what light actually does, for lighting the moon. */
  altitudeDeg: number;
  /** Refracted altitude — where the disc is seen, for drawing it. */
  apparentAltitudeDeg: number;
  azimuthDeg: number;
}

export interface CelestialState {
  sky: SkyState;
  sun: SkyBody;
  /** Null before the moon has been computed, or with the debug sun override on. */
  moon: LunarPosition | null;
  latDeg: number;
  /** Local apparent sidereal time, degrees. */
  siderealDeg: number;
  /** Julian Day of the epoch the stars are precessed to. */
  jd: number;
  /** Obliquity of the ecliptic, degrees — locates the moon's north pole. */
  obliquityDeg: number;
}

export class NightSky {
  readonly uniforms: SkyUniforms = createSkyUniforms();
  readonly dome: SkyDome;
  readonly group = new THREE.Group();

  private stars: StarField | null = null;
  private catalogue: StarCatalogue | null = null;
  private directions: Float32Array | null = null;
  private texture: THREE.DataTexture | null = null;
  private bakedJd = Number.NaN;
  private readonly scratch = {
    sunDir: new THREE.Vector3(),
    sunLightDir: new THREE.Vector3(),
    moonDir: new THREE.Vector3(),
    northEclipticPole: new THREE.Vector3(),
  };

  constructor(private readonly pixelRatio: number) {
    this.dome = new SkyDome(this.uniforms);
    this.group.name = 'sky';
    this.group.add(this.dome.mesh);
  }

  /** Whether a catalogue has been attached. The sky works without one. */
  get hasStars(): boolean {
    return this.stars !== null;
  }

  get starCount(): number {
    return this.catalogue?.count ?? 0;
  }

  get catalogueSource(): StarCatalogue['source'] | null {
    return this.catalogue?.source ?? null;
  }

  /**
   * Attach the catalogue once it has loaded. Deliberately separate from the
   * constructor: the sky has to be up on the first frame, and the stars arrive
   * over the network a moment later — a night without them is a night with a
   * moon in it, not a broken scene.
   */
  attachStars(catalogue: StarCatalogue, jd: number): void {
    this.catalogue = catalogue;
    this.directions = starDirectionsAtEpoch(catalogue, jd);
    this.stars = new StarField(catalogue, this.directions, this.pixelRatio);
    this.group.add(this.stars.group);
    this.rebake(jd);
  }

  /** Push one instant at the sky. Allocates nothing. */
  apply(state: CelestialState): void {
    const u = this.uniforms;
    u.uSkyHorizon.value.copy(state.sky.sky);
    u.uSkyZenith.value.copy(state.sky.zenith);
    u.uSkyAureole.value.copy(state.sky.aureole);

    // The disc is drawn where it is *seen* (refracted); the moon is lit from
    // where the sun geometrically is, because refraction bends the light that
    // reaches us, not the light that reaches the moon.
    worldDirectionFromHorizontal(state.sun.apparentAltitudeDeg, state.sun.azimuthDeg, this.scratch.sunDir);
    worldDirectionFromHorizontal(state.sun.altitudeDeg, state.sun.azimuthDeg, this.scratch.sunLightDir);
    u.uSunDir.value.copy(this.scratch.sunDir);
    u.uSunLightDir.value.copy(this.scratch.sunLightDir);
    u.uSunDiscColor.value.copy(state.sky.sunColor);
    // Fade the disc out as it sets. Nothing else hides it: the terrain covers a
    // sun below the horizon on land, but over open water there is nothing there.
    u.uSunDiscIntensity.value = smoothstep(-0.45, 0.05, state.sun.apparentAltitudeDeg);

    if (state.moon) {
      worldDirectionFromHorizontal(
        state.moon.apparentAltitudeDeg,
        state.moon.azimuthDeg,
        this.scratch.moonDir,
      );
      u.uMoonDir.value.copy(this.scratch.moonDir);
      u.uMoonCosRadius.value = Math.cos(state.moon.angularRadiusDeg * (Math.PI / 180));
      u.uMoonBrightness.value = smoothstep(-0.6, 0.15, state.moon.apparentAltitudeDeg);
      u.uMoonLitFraction.value = state.moon.illuminatedFraction;
    } else {
      u.uMoonBrightness.value = 0;
      u.uMoonLitFraction.value = 0;
    }

    u.uStarFade.value = state.sky.starFade;
    u.uEquatorialToWorld.value.copy(equatorialToWorldMatrix(state.latDeg, state.siderealDeg));

    if (state.moon) {
      // The north ecliptic pole is at right ascension 270° and declination
      // 90° − ε; through the same rotation the stars use, that is where lunar
      // north points on screen (see `lunarDiscBasis`).
      this.scratch.northEclipticPole
        .fromArray(directionFromEquatorial(270, 90 - state.obliquityDeg))
        .applyMatrix3(u.uEquatorialToWorld.value);
      lunarDiscBasis(
        u.uMoonDir.value,
        this.scratch.northEclipticPole,
        u.uMoonRight.value,
        u.uMoonUp.value,
      );
    }

    if (this.stars && this.catalogue && this.directions) {
      if (!Number.isFinite(this.bakedJd) || Math.abs(state.jd - this.bakedJd) > REBAKE_YEARS * 365.25) {
        this.directions = starDirectionsAtEpoch(this.catalogue, state.jd, this.directions);
        this.stars.setDirections(this.directions);
        this.rebake(state.jd);
      }
      this.stars.setOrientation(u.uEquatorialToWorld.value);
      this.stars.setFade(state.sky.starFade);
    }
  }

  /**
   * Re-derive the epoch directions for a new year without rebaking the map —
   * the points are what you look at, so they follow the year exactly, while the
   * reflection map only has to keep up to within a texel.
   */
  setEpoch(jd: number): void {
    if (!this.catalogue || !this.stars || !this.directions) return;
    this.directions = starDirectionsAtEpoch(this.catalogue, jd, this.directions);
    this.stars.setDirections(this.directions);
  }

  setPixelRatio(pixelRatio: number): void {
    this.stars?.setPixelRatio(pixelRatio);
  }

  private rebake(jd: number): void {
    if (!this.catalogue || !this.directions) return;
    const map = bakeStarMap(this.catalogue, this.directions, {
      width: STAR_MAP_WIDTH,
      height: STAR_MAP_HEIGHT,
    });
    if (!this.texture) {
      this.texture = new THREE.DataTexture(map.data, map.width, map.height, THREE.RGBAFormat);
      // The map's 1/2.2 encode is a flux compression of our own, undone in the
      // shader — not an sRGB transfer, so three must not touch it.
      this.texture.colorSpace = THREE.NoColorSpace;
      this.texture.wrapS = THREE.RepeatWrapping; // right ascension wraps
      this.texture.wrapT = THREE.ClampToEdgeWrapping;
      this.texture.magFilter = THREE.LinearFilter;
      this.texture.minFilter = THREE.LinearMipmapLinearFilter;
      this.texture.generateMipmaps = true;
      this.uniforms.uStarMap.value = this.texture;
      // Reflected starlight is faint; this is how faint.
      this.uniforms.uStarGain.value = 0.4;
    } else {
      this.texture.image.data = map.data;
    }
    this.texture.needsUpdate = true;
    this.bakedJd = jd;
  }

  dispose(): void {
    this.dome.dispose();
    this.stars?.dispose();
    this.texture?.dispose();
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
