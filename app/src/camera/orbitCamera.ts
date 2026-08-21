/**
 * Orbit camera (PLAN §4.8: plain three.js, no framework).
 *
 * Phase 2 adds the first-person camera alongside this one; keep the framing helper
 * separate from the controls so both can reuse it.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { HeightGrid } from '../terrain/heightGrid';
import { heightAtLocal } from '../lib/coords';

const DEG = Math.PI / 180;

export interface OrbitRig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Re-frame the site given the grid that is currently the best available. */
  frameSite(grid: HeightGrid, exaggeration: number): void;
  /**
   * Raise the far plane so terrain out to `outerHalfExtent` meters stays in
   * frame (§11 far-field rings). Sticky: survives later `frameSite` calls. The
   * renderer's log depth buffer keeps the widened near/far ratio artifact-free.
   */
  setFarHorizon(outerHalfExtent: number): void;
}

export function createOrbitRig(domElement: HTMLElement, aspect: number): OrbitRig {
  const camera = new THREE.PerspectiveCamera(50, aspect, 1, 20000);
  camera.position.set(600, 320, 600);

  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.minDistance = 15;
  controls.maxDistance = 8000;
  // Stop just short of the horizon so the camera never ends up under the terrain.
  controls.maxPolarAngle = 88 * DEG;
  controls.zoomSpeed = 0.9;
  controls.rotateSpeed = 0.7;

  // §11: once rings load, the far plane must reach past the outermost ring's
  // corner whatever grid frameSite was last called with. 0 until rings exist.
  let farFloor = 0;

  function frameSite(grid: HeightGrid, exaggeration: number): void {
    const { minX, maxX, minZ, maxZ } = grid.boundsLocal;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const cy = heightAtLocal(grid.heights, cx, cz, grid) * exaggeration;
    const half = Math.max(maxX - minX, maxZ - minZ) / 2;

    // Comfortable oblique from the SE (+x, +z): far enough to hold the core in
    // frame, high enough to read relief, low enough that the sun's rake shows.
    const distance = half * 1.9;
    const pitch = 30 * DEG;
    const horizontal = distance * Math.cos(pitch);
    const inv = Math.SQRT1_2;

    controls.target.set(cx, cy, cz);
    camera.position.set(cx + horizontal * inv, cy + distance * Math.sin(pitch), cz + horizontal * inv);
    controls.maxDistance = half * 6;
    camera.near = Math.max(0.5, half / 5000);
    camera.far = Math.max(half * 24, farFloor);
    camera.updateProjectionMatrix();
    controls.update();
  }

  function setFarHorizon(outerHalfExtent: number): void {
    // ×3 covers the square's diagonal from any orbit position with headroom.
    farFloor = Math.max(farFloor, outerHalfExtent * 3);
    if (camera.far < farFloor) {
      camera.far = farFloor;
      camera.updateProjectionMatrix();
    }
  }

  return { camera, controls, frameSite, setFarHorizon };
}
