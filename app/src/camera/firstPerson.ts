/**
 * First-person camera (Phase 2, PLAN §3): pointer-lock look, WASD walking
 * clamped to the terrain surface at eye height 1.7 m.
 *
 * Coordinate conventions (docs/data-formats.md §0): scene units are meters,
 * north = −z. We define **azimuth** the map way — 0° = north, 90° = east — and
 * convert to the camera's Y rotation with `yawFromAzimuth`. Pitch is radians,
 * positive = looking up.
 *
 * The ground sample callback returns UNEXAGGERATED meters (the analysis grids);
 * exaggeration is applied here, render-side only, so the walker stays glued to
 * the rendered surface: eye y = (ground + eyeHeight) · exaggeration.
 */

import * as THREE from 'three';

export const EYE_HEIGHT = 1.7; // meters above ground (PLAN §3 Phase 2)
export const WALK_SPEED = 3; // m/s — brisk walk; the scene is 1:1 meters
export const SPRINT_FACTOR = 6; // Shift held: 18 m/s, for crossing the valley
const MAX_PITCH = 88 * (Math.PI / 180);

/** Map azimuth (deg, 0 = north = −z, 90 = east = +x) -> three.js rotation.y (rad). */
export function yawFromAzimuth(azimuthDeg: number): number {
  return -azimuthDeg * (Math.PI / 180);
}

/** Inverse of `yawFromAzimuth`, normalized to [0, 360). */
export function azimuthFromYaw(yaw: number): number {
  return ((-yaw * 180) / Math.PI + 360 * 4) % 360;
}

export interface MoveKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  sprint: boolean;
}

/**
 * Horizontal displacement for one frame, in scene meters. Forward follows the
 * yaw's heading projected onto the ground plane (looking up/down never slows
 * walking). Diagonals are normalized so W+D isn't faster than W.
 */
export function moveDelta(yaw: number, keys: MoveKeys, dt: number, walkSpeed = WALK_SPEED): { dx: number; dz: number } {
  let ax = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  let az = (keys.back ? 1 : 0) - (keys.forward ? 1 : 0);
  if (ax === 0 && az === 0) return { dx: 0, dz: 0 };
  const inv = 1 / Math.hypot(ax, az);
  ax *= inv;
  az *= inv;
  const speed = walkSpeed * (keys.sprint ? SPRINT_FACTOR : 1) * dt;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // Camera forward on the ground plane is (−sin yaw, −cos yaw); right is (cos yaw, −sin yaw).
  // `az` is +1 for the back key, so forward contributes −az · forward-vector.
  return {
    dx: (ax * cos + az * sin) * speed,
    dz: (-ax * sin + az * cos) * speed,
  };
}

/** Eye height in rendered (exaggerated) scene coordinates. */
export function eyeY(groundMeters: number, exaggeration: number, eyeHeight = EYE_HEIGHT): number {
  return (groundMeters + eyeHeight) * exaggeration;
}

export interface WalkBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Keep the walker inside the data extent, `margin` meters from the edge. */
export function clampToBounds(x: number, z: number, bounds: WalkBounds, margin = 10): { x: number; z: number } {
  return {
    x: Math.min(Math.max(x, bounds.minX + margin), bounds.maxX - margin),
    z: Math.min(Math.max(z, bounds.minZ + margin), bounds.maxZ - margin),
  };
}

/** Unexaggerated ground height (m RH 2000) at local (x, z). */
export type GroundSampler = (x: number, z: number) => number;

export class FirstPersonController {
  /** Local ground-plane position of the feet. */
  x = 0;
  z = 0;
  yaw = 0;
  pitch = 0;

  enabled = false;

  private readonly keys: MoveKeys = { forward: false, back: false, left: false, right: false, sprint: false };
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly lookSpeed = 0.0022; // rad per pointer px

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;

    // Bound listeners so enable()/disable() can add and remove them cleanly.
    this.onKey = this.onKey.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onClick = this.onClick.bind(this);
  }

  /** True while the browser has the pointer locked to our canvas. */
  get pointerLocked(): boolean {
    return document.pointerLockElement === this.domElement;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    document.addEventListener('mousemove', this.onMouseMove);
    this.domElement.addEventListener('click', this.onClick);
    this.camera.rotation.order = 'YXZ';
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.domElement.removeEventListener('click', this.onClick);
    for (const k of Object.keys(this.keys) as (keyof MoveKeys)[]) this.keys[k] = false;
    if (this.pointerLocked) document.exitPointerLock();
  }

  /** Ask the browser for pointer lock. Must be called from a user gesture. */
  requestPointerLock(): void {
    if (!this.pointerLocked) this.domElement.requestPointerLock();
  }

  /** Place the walker (feet position + view direction). Used by transitions and dev hooks. */
  setPose(x: number, z: number, azimuthDeg: number, pitchDeg = 0): void {
    this.x = x;
    this.z = z;
    this.yaw = yawFromAzimuth(azimuthDeg);
    this.pitch = THREE.MathUtils.clamp(pitchDeg * (Math.PI / 180), -MAX_PITCH, MAX_PITCH);
  }

  /** Advance one frame: walk, clamp to terrain, orient the camera. */
  update(dt: number, ground: GroundSampler, exaggeration: number, bounds: WalkBounds): void {
    if (!this.enabled) return;
    const { dx, dz } = moveDelta(this.yaw, this.keys, Math.min(dt, 0.1));
    const clamped = clampToBounds(this.x + dx, this.z + dz, bounds);
    this.x = clamped.x;
    this.z = clamped.z;

    this.camera.position.set(this.x, eyeY(ground(this.x, this.z), exaggeration), this.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private onKey(event: KeyboardEvent): void {
    const down = event.type === 'keydown';
    switch (event.code) {
      case 'KeyW':
      case 'ArrowUp':
        this.keys.forward = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this.keys.back = down;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this.keys.left = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this.keys.right = down;
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this.keys.sprint = down;
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.pointerLocked) return;
    this.yaw -= event.movementX * this.lookSpeed;
    this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * this.lookSpeed, -MAX_PITCH, MAX_PITCH);
  }

  private onClick(): void {
    this.requestPointerLock();
  }
}
