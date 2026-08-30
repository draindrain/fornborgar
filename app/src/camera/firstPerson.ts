/**
 * First-person camera (Phase 2, PLAN §3): pointer-lock look, WASD walking
 * clamped to the terrain surface at eye height 2 m.
 *
 * Coordinate conventions (docs/data-formats.md §0): scene units are meters,
 * north = −z. We define **azimuth** the map way — 0° = north, 90° = east — and
 * convert to the camera's Y rotation with `yawFromAzimuth`. Pitch is radians,
 * positive = looking up.
 *
 * The ground sample callback returns UNEXAGGERATED meters (the analysis grids);
 * exaggeration is applied here, render-side only, so the walker stays glued to
 * the rendered surface: eye y = (ground + eyeHeight) · exaggeration.
 *
 * Two input paths feed the same state, and they are merged rather than switched
 * between: keys/mouse (desktop) and analog sticks (touch overlay). A hybrid
 * device — laptop with a touchscreen — can use either without a mode flag.
 */

import * as THREE from 'three';

export const EYE_HEIGHT = 2.0; // meters above ground (PLAN §3 Phase 2)
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

/** A joystick reading on the unit circle: +y = up on screen = forward. */
export interface StickVec {
  x: number;
  y: number;
}

/**
 * Movement axes from the key state: strafe (+x = right) and forward/back
 * (+z = backwards, matching the scene's −z-is-forward heading). Diagonals are
 * normalized so W+D isn't faster than W.
 */
export function axesFromKeys(keys: MoveKeys): { x: number; z: number } {
  const x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const z = (keys.back ? 1 : 0) - (keys.forward ? 1 : 0);
  if (x === 0 && z === 0) return { x: 0, z: 0 };
  const inv = 1 / Math.hypot(x, z);
  return { x: x * inv, z: z * inv };
}

/**
 * Combine the keyboard's on/off axes with an analog stick. Keys are already
 * unit-length, the stick may be anywhere inside the unit circle — partial
 * deflection is a slower walk, which is the whole point of a stick — and the
 * sum is clamped back to 1 so holding both never outruns either.
 */
export function mergeMoveAxes(keys: MoveKeys, stick: StickVec | null): { x: number; z: number } {
  const k = axesFromKeys(keys);
  if (!stick) return k;
  const x = k.x + stick.x;
  const z = k.z - stick.y; // stick +y = forward = −z
  const len = Math.hypot(x, z);
  if (len <= 1) return { x, z };
  return { x: x / len, z: z / len };
}

/**
 * Horizontal displacement for one frame, in scene meters, from already-merged
 * axes. Forward follows the yaw's heading projected onto the ground plane
 * (looking up/down never slows walking); the axis magnitude scales the speed.
 */
export function moveDeltaAxes(
  yaw: number,
  ax: number,
  az: number,
  dt: number,
  speed = WALK_SPEED,
): { dx: number; dz: number } {
  if (ax === 0 && az === 0) return { dx: 0, dz: 0 };
  const s = speed * dt;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // Camera forward on the ground plane is (−sin yaw, −cos yaw); right is (cos yaw, −sin yaw).
  // `az` is +1 for backwards, so forward contributes −az · forward-vector.
  return {
    dx: (ax * cos + az * sin) * s,
    dz: (-ax * sin + az * cos) * s,
  };
}

/**
 * Horizontal displacement for one frame from the key state alone. Kept as the
 * keyboard-only entry point (and as the contract the Phase-2 tests pin); the
 * analog path underneath is shared with the touch sticks.
 */
export function moveDelta(yaw: number, keys: MoveKeys, dt: number, walkSpeed = WALK_SPEED): { dx: number; dz: number } {
  const { x, z } = axesFromKeys(keys);
  return moveDeltaAxes(yaw, x, z, dt, walkSpeed * (keys.sprint ? SPRINT_FACTOR : 1));
}

/** Look-stick turn rates at full deflection, radians per second. */
export const LOOK_RATE_YAW = 2.4;
export const LOOK_RATE_PITCH = 1.6;

/**
 * Look-stick contribution for one frame. The response curve is `v·|v|` — a
 * square that keeps its sign — so small deflections aim and large ones sweep,
 * which is what makes a thumbstick usable for a 1° adjustment. Stick right is a
 * right turn, i.e. decreasing yaw, matching the mouse's `yaw -= movementX`.
 */
export function lookRateDelta(stick: StickVec, dt: number): { dYaw: number; dPitch: number } {
  const curve = (v: number): number => v * Math.abs(v);
  return {
    dYaw: -curve(stick.x) * LOOK_RATE_YAW * dt,
    dPitch: curve(stick.y) * LOOK_RATE_PITCH * dt,
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

  /**
   * Analog input, written by the touch overlay and read once per frame. `null`
   * means "no stick on screen / at rest", which is not the same as `{0,0}` for
   * the look stick: at rest we skip the look branch entirely rather than adding
   * zeros to the angles every frame.
   */
  moveStick: StickVec | null = null;
  lookStick: StickVec | null = null;

  /**
   * Pointer lock is a desktop affordance. On a coarse pointer the request
   * either does nothing or throws up a browser prompt over the scene, so the
   * caller switches it off there and the sticks do the looking.
   */
  allowPointerLock = true;

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
    this.moveStick = null;
    this.lookStick = null;
    if (this.pointerLocked) document.exitPointerLock();
  }

  /** Ask the browser for pointer lock. Must be called from a user gesture. */
  requestPointerLock(): void {
    if (!this.allowPointerLock) return;
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
    // Cap the step so a backgrounded tab does not teleport the walker across
    // the valley on its first frame back.
    const step = Math.min(dt, 0.1);

    const axes = mergeMoveAxes(this.keys, this.moveStick);
    const speed = WALK_SPEED * (this.keys.sprint ? SPRINT_FACTOR : 1);
    const { dx, dz } = moveDeltaAxes(this.yaw, axes.x, axes.z, step, speed);
    const clamped = clampToBounds(this.x + dx, this.z + dz, bounds);
    this.x = clamped.x;
    this.z = clamped.z;

    if (this.lookStick) {
      const { dYaw, dPitch } = lookRateDelta(this.lookStick, step);
      this.yaw += dYaw;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
    }

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
