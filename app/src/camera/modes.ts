/**
 * Orbit ↔ first-person mode manager (Phase 2, PLAN §3): one shared camera, a
 * smooth fly-to transition between the two rigs, and the keyboard toggle.
 *
 * Entering first person flies the camera from wherever the orbit left it down to
 * eye height at the chosen standpoint; exiting flies it back up to an oblique
 * orbit view of that same spot. During a transition both control schemes are
 * disabled, so there is never a frame with two owners of the camera.
 */

import * as THREE from 'three';
import type { OrbitRig } from './orbitCamera';
import { EYE_HEIGHT, FirstPersonController, type GroundSampler, type WalkBounds, eyeY } from './firstPerson';

export type CameraMode = 'orbit' | 'firstPerson' | 'transition';

const TRANSITION_S = 1.4;
const easeInOut = (t: number): number => t * t * (3 - 2 * t);

export interface EnterOptions {
  /** Standpoint (local ground-plane coords). Defaults to the current orbit target. */
  x?: number;
  z?: number;
  /** Initial view direction; defaults to the orbit camera's current heading. */
  azimuthDeg?: number;
  pitchDeg?: number;
  /** Skip the fly-to (used by headless tests and deep links). */
  instant?: boolean;
  /** Grab pointer lock on arrival (only works from a user gesture). */
  pointerLock?: boolean;
}

interface Transition {
  fromPos: THREE.Vector3;
  fromQuat: THREE.Quaternion;
  toPos: THREE.Vector3;
  toQuat: THREE.Quaternion;
  elapsed: number;
  duration: number;
  onDone: () => void;
}

export class CameraModes {
  mode: CameraMode = 'orbit';

  readonly firstPerson: FirstPersonController;

  private readonly rig: OrbitRig;
  private readonly camera: THREE.PerspectiveCamera;
  private transition: Transition | null = null;
  private wantPointerLock = false;

  /** Notified after every completed mode change (for HUD hints / GUI state). */
  onModeChange: (mode: CameraMode) => void = () => {};

  constructor(rig: OrbitRig, domElement: HTMLElement) {
    this.rig = rig;
    this.camera = rig.camera;
    this.firstPerson = new FirstPersonController(rig.camera, domElement);
  }

  enterFirstPerson(opts: EnterOptions = {}, ground: GroundSampler, exaggeration: number): void {
    if (this.mode !== 'orbit') return;
    const x = opts.x ?? this.rig.controls.target.x;
    const z = opts.z ?? this.rig.controls.target.z;
    // Default heading: keep looking the way the orbit camera was facing.
    const dx = x - this.camera.position.x;
    const dz = z - this.camera.position.z;
    const azimuth = opts.azimuthDeg ?? ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    this.firstPerson.setPose(x, z, azimuth, opts.pitchDeg ?? 0);
    this.wantPointerLock = opts.pointerLock ?? false;

    const toPos = new THREE.Vector3(x, eyeY(ground(x, z), exaggeration), z);
    const toQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(this.firstPerson.pitch, this.firstPerson.yaw, 0, 'YXZ'),
    );

    this.rig.controls.enabled = false;
    if (opts.instant) {
      this.camera.position.copy(toPos);
      this.camera.quaternion.copy(toQuat);
      this.finishEnter();
      return;
    }
    this.beginTransition(toPos, toQuat, () => this.finishEnter());
  }

  exitToOrbit(instant = false, ground?: GroundSampler, exaggeration = 1): void {
    if (this.mode !== 'firstPerson') return;
    this.firstPerson.disable();

    // Fly up to an oblique view of the standpoint, looking back down at it.
    const fp = this.firstPerson;
    const groundY = ground ? ground(fp.x, fp.z) * exaggeration : this.camera.position.y - EYE_HEIGHT * exaggeration;
    const target = new THREE.Vector3(fp.x, groundY, fp.z);
    const back = new THREE.Vector3(Math.sin(fp.yaw), 0, Math.cos(fp.yaw)); // opposite the view heading
    const toPos = target.clone().addScaledVector(back, 260).add(new THREE.Vector3(0, 180, 0));
    const toQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(toPos, target, new THREE.Vector3(0, 1, 0)),
    );

    const finish = (): void => {
      this.rig.controls.target.copy(target);
      this.rig.controls.enabled = true;
      this.rig.controls.update();
      this.mode = 'orbit';
      this.onModeChange(this.mode);
    };

    if (instant) {
      this.camera.position.copy(toPos);
      this.camera.quaternion.copy(toQuat);
      finish();
      return;
    }
    this.beginTransition(toPos, toQuat, finish);
  }

  toggle(ground: GroundSampler, exaggeration: number): void {
    if (this.mode === 'orbit') this.enterFirstPerson({ pointerLock: true }, ground, exaggeration);
    else if (this.mode === 'firstPerson') this.exitToOrbit(false, ground, exaggeration);
  }

  /** Advance transitions / walking. Call once per frame with the frame delta. */
  update(dt: number, ground: GroundSampler, exaggeration: number, bounds: WalkBounds): void {
    if (this.transition) {
      const t = this.transition;
      t.elapsed += dt;
      const f = easeInOut(Math.min(t.elapsed / t.duration, 1));
      this.camera.position.lerpVectors(t.fromPos, t.toPos, f);
      this.camera.quaternion.slerpQuaternions(t.fromQuat, t.toQuat, f);
      if (t.elapsed >= t.duration) {
        this.transition = null;
        t.onDone();
      }
      return;
    }
    if (this.mode === 'firstPerson') {
      this.firstPerson.update(dt, ground, exaggeration, bounds);
    }
  }

  private beginTransition(toPos: THREE.Vector3, toQuat: THREE.Quaternion, onDone: () => void): void {
    this.mode = 'transition';
    this.onModeChange(this.mode);
    this.transition = {
      fromPos: this.camera.position.clone(),
      fromQuat: this.camera.quaternion.clone(),
      toPos,
      toQuat,
      elapsed: 0,
      duration: TRANSITION_S,
      onDone,
    };
  }

  private finishEnter(): void {
    this.firstPerson.enable();
    if (this.wantPointerLock) this.firstPerson.requestPointerLock();
    this.mode = 'firstPerson';
    this.onModeChange(this.mode);
  }
}
