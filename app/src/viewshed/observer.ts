/**
 * The draggable viewshed observer (Phase 3): a bright marker standing on the
 * terrain, picked and dragged with the pointer. Terrain picking is done by ray
 * marching against the height grids (via the app's ground sampler) rather than
 * raycasting 14 M triangles.
 *
 * The marker lives in the SCENE (not the Y-scaled terrain group) so it keeps
 * its true shape; its y position is ground · exaggeration, refreshed on drag
 * and on exaggeration changes.
 */

import * as THREE from 'three';
import type { GroundSampler } from '../camera/firstPerson';
import type { WalkBounds } from '../camera/firstPerson';
import { clampToBounds } from '../camera/firstPerson';

const MARKER_COLOR = 0xe4572e;
const POLE_HEIGHT = 6; // exaggerated scene meters — legible at valley scale

export interface ObserverEvents {
  /** Fired while dragging (throttle downstream) and once on drop. */
  onMove(x: number, z: number, final: boolean): void;
}

/** March a pointer ray against the height field; returns ground hit or null. */
export function pickTerrain(
  ray: THREE.Ray,
  ground: GroundSampler,
  exaggeration: number,
  bounds: WalkBounds,
  maxDistance = 12000,
  step = 4,
): { x: number; z: number } | null {
  const p = new THREE.Vector3();
  let prevT = 0;
  let prevAbove = true;
  for (let t = 0; t <= maxDistance; t += step) {
    p.copy(ray.origin).addScaledVector(ray.direction, t);
    const inX = p.x >= bounds.minX && p.x <= bounds.maxX;
    const inZ = p.z >= bounds.minZ && p.z <= bounds.maxZ;
    if (inX && inZ) {
      const above = p.y > ground(p.x, p.z) * exaggeration;
      if (!above) {
        // Bisect between prevT (above) and t (below) for a crisp hit.
        let lo = prevAbove ? prevT : t;
        let hi = t;
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          p.copy(ray.origin).addScaledVector(ray.direction, mid);
          if (p.y > ground(p.x, p.z) * exaggeration) lo = mid;
          else hi = mid;
        }
        p.copy(ray.origin).addScaledVector(ray.direction, (lo + hi) / 2);
        const c = clampToBounds(p.x, p.z, bounds, 2);
        return { x: c.x, z: c.z };
      }
      prevAbove = true;
    }
    prevT = t;
  }
  return null;
}

export class ObserverMarker {
  readonly group = new THREE.Group();
  x = 0;
  z = 0;

  private readonly camera: THREE.Camera;
  private readonly domElement: HTMLElement;
  private readonly ground: GroundSampler;
  private readonly events: ObserverEvents;
  private getExaggeration: () => number;
  private getBounds: () => WalkBounds;
  private dragging = false;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly pickMesh: THREE.Mesh;

  /** Suspends OrbitControls while a drag is active. */
  onDragStateChange: (dragging: boolean) => void = () => {};

  constructor(
    camera: THREE.Camera,
    domElement: HTMLElement,
    ground: GroundSampler,
    getExaggeration: () => number,
    getBounds: () => WalkBounds,
    events: ObserverEvents,
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.ground = ground;
    this.getExaggeration = getExaggeration;
    this.getBounds = getBounds;
    this.events = events;

    const material = new THREE.MeshStandardMaterial({ color: MARKER_COLOR, roughness: 0.5 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, POLE_HEIGHT, 12), material);
    pole.position.y = POLE_HEIGHT / 2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(2.4, 20, 14), material);
    head.position.y = POLE_HEIGHT + 1.6;
    // Generous invisible grab target so the marker is draggable at valley scale.
    const grab = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 14, POLE_HEIGHT + 22, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    grab.position.y = (POLE_HEIGHT + 22) / 2 - 6;
    this.pickMesh = grab;
    this.group.add(pole, head, grab);
    this.group.name = 'viewshed-observer';

    domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
  }

  setPosition(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.refreshHeight();
  }

  /** Re-seat the marker on the (possibly re-exaggerated) surface. */
  refreshHeight(): void {
    this.group.position.set(this.x, this.ground(this.x, this.z) * this.getExaggeration(), this.z);
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
  }

  private setRayFromEvent(event: PointerEvent): void {
    const rect = this.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.group.visible || event.button !== 0) return;
    this.setRayFromEvent(event);
    if (this.raycaster.intersectObject(this.pickMesh, false).length > 0) {
      this.dragging = true;
      this.onDragStateChange(true);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.setRayFromEvent(event);
    const hit = pickTerrain(this.raycaster.ray, this.ground, this.getExaggeration(), this.getBounds());
    if (hit) {
      this.setPosition(hit.x, hit.z);
      this.events.onMove(hit.x, hit.z, false);
    }
  };

  private readonly onPointerUp = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.onDragStateChange(false);
    this.events.onMove(this.x, this.z, true);
  };
}
