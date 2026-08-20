/**
 * Registered-sites overlay (Phase 5, PLAN §3/§2.2; contract §3 `sites.json`).
 *
 * Flat cartographic markers: map symbols lying on the terrain, not 3D scenery —
 * the layer must read as "registry data draped on the ground", visually distinct
 * from both the measured terrain and the conjectural palisade. Polygon extents
 * (gravfält etc.) and färdväg lines are draped as outlines; every record also
 * gets a flat marker at its representative point, which is the click target for
 * the Fornsök popup.
 *
 * Like the viewshed observer, the whole layer lives in the SCENE, outside the
 * Y-scaled terrain group, so symbols keep their true shape; every draped vertex
 * sits at y = ground(x,z) · exaggeration and is re-seated on exaggeration
 * changes (contract §0: analysis unexaggerated, render-only Y scale).
 */

import * as THREE from 'three';
import type { GroundSampler } from '../camera/firstPerson';

export interface SitePosition {
  x: number;
  z: number;
}

/** GeoJSON-shaped local-coordinate geometry (contract §3: positions are [x, z]). */
export interface SiteGeometryLocal {
  type: string;
  coordinates: unknown;
}

export interface SiteRecord {
  id: string;
  name: string;
  lamningstyp: string;
  provenance: string;
  position: SitePosition;
  geometryLocal?: SiteGeometryLocal;
  fornsokUrl?: string;
  description?: string;
  [key: string]: unknown;
}

export interface SitesFile {
  schemaVersion: number;
  fetched?: string;
  sites: SiteRecord[];
  [key: string]: unknown;
}

export class SitesError extends Error {
  override readonly name = 'SitesError';
}

/** Contract §3 validation — hard-fail with a field-naming message. */
export function validateSites(raw: unknown, source = 'sites.json'): SitesFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SitesError(`${source} must be a JSON object`);
  }
  const doc = raw as Record<string, unknown>;
  if (doc['schemaVersion'] !== 1) {
    throw new SitesError(`${source}: unsupported schemaVersion ${JSON.stringify(doc['schemaVersion'])}`);
  }
  const sites = doc['sites'];
  if (!Array.isArray(sites)) throw new SitesError(`${source}: "sites" must be an array`);

  const seen = new Set<string>();
  sites.forEach((entry, i) => {
    const site = entry as Record<string, unknown>;
    for (const key of ['id', 'name', 'lamningstyp', 'provenance'] as const) {
      if (typeof site[key] !== 'string' || site[key] === '') {
        throw new SitesError(`${source}: sites[${i}].${key} must be a non-empty string`);
      }
    }
    if (seen.has(site['id'] as string)) throw new SitesError(`${source}: duplicate site id ${site['id']}`);
    seen.add(site['id'] as string);
    const pos = site['position'] as Record<string, unknown> | undefined;
    if (
      typeof pos !== 'object' ||
      pos === null ||
      typeof pos['x'] !== 'number' ||
      typeof pos['z'] !== 'number' ||
      !Number.isFinite(pos['x']) ||
      !Number.isFinite(pos['z'])
    ) {
      throw new SitesError(`${source}: sites[${i}].position must be finite numeric {x, z}`);
    }
    const geometry = site['geometryLocal'] as Record<string, unknown> | undefined;
    if (geometry !== undefined) {
      if (typeof geometry !== 'object' || geometry === null || typeof geometry['type'] !== 'string') {
        throw new SitesError(`${source}: sites[${i}].geometryLocal must have a "type"`);
      }
      if (!Array.isArray(geometry['coordinates'])) {
        throw new SitesError(`${source}: sites[${i}].geometryLocal.coordinates must be an array`);
      }
    }
  });
  return doc as unknown as SitesFile;
}

// --------------------------------------------------------------------------- //
// cartographic style — one place, reused by the Phase-6 legend
// --------------------------------------------------------------------------- //

export type MarkerShape = 'ring' | 'disc' | 'square' | 'diamond';

export interface SiteStyle {
  color: string;
  shape: MarkerShape;
  /** Marker footprint radius in meters (legible at valley scale). */
  radius: number;
}

const STYLES: Record<string, SiteStyle> = {
  Fornborg: { color: '#d64541', shape: 'ring', radius: 18 },
  'Gravfält': { color: '#b5443c', shape: 'disc', radius: 11 },
  'Grav- och boplatsområde': { color: '#b5443c', shape: 'ring', radius: 12 },
  Boplats: { color: '#d09a3c', shape: 'square', radius: 10 },
  'Boplatsområde': { color: '#d09a3c', shape: 'square', radius: 11 },
  'Boplatslämning övrig': { color: '#d09a3c', shape: 'square', radius: 9 },
  Runristning: { color: '#7a5fb5', shape: 'diamond', radius: 10 },
  'Färdväg': { color: '#8a6f4d', shape: 'diamond', radius: 9 },
  'Färdvägssystem': { color: '#8a6f4d', shape: 'diamond', radius: 9 },
};

const DEFAULT_STYLE: SiteStyle = { color: '#9a8f83', shape: 'disc', radius: 10 };

export function siteStyle(lamningstyp: string): SiteStyle {
  return STYLES[lamningstyp] ?? DEFAULT_STYLE;
}

// --------------------------------------------------------------------------- //
// draping — densify a local-coordinate path and seat it on the surface
// --------------------------------------------------------------------------- //

/** Max segment length (m) when draping outlines over the terrain. */
export const DRAPE_STEP = 5;
/** Lift (scene meters) that keeps flat symbols from z-fighting the ground. */
const MARKER_LIFT = 0.4;
const OUTLINE_LIFT = 0.7;

/**
 * Densified copy of `points` ([x, z] pairs) with segments ≤ `step` meters.
 * `close` appends the implicit closing segment of a ring.
 */
export function densifyPath(points: Array<[number, number]>, step = DRAPE_STEP, close = false): Array<[number, number]> {
  if (points.length < 2) return points.slice();
  const source = close ? [...points, points[0]] : points;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < source.length - 1; i++) {
    const [x0, z0] = source[i];
    const [x1, z1] = source[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step));
    for (let k = 0; k < n; k++) {
      out.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
    }
  }
  out.push(source[source.length - 1]);
  return out;
}

interface DrapedLine {
  line: THREE.Line;
  /** Unexaggerated ground heights per vertex, re-scaled on exaggeration change. */
  groundY: Float32Array;
}

// --------------------------------------------------------------------------- //
// the layer
// --------------------------------------------------------------------------- //

export interface SitesLayerEvents {
  onSelect(site: SiteRecord | null): void;
}

const CLICK_SLOP_PX = 6;

export class SitesLayer {
  readonly group = new THREE.Group();
  readonly sites: SiteRecord[];

  private readonly ground: GroundSampler;
  private readonly getExaggeration: () => number;
  private readonly events: SitesLayerEvents;
  private readonly camera: THREE.Camera;
  private readonly domElement: HTMLElement;

  private readonly markers: THREE.Mesh[] = [];
  private readonly pickTargets: THREE.Mesh[] = [];
  private readonly outlines: DrapedLine[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private downAt: { x: number; y: number } | null = null;
  private selectedId: string | null = null;

  constructor(
    file: SitesFile,
    camera: THREE.Camera,
    domElement: HTMLElement,
    ground: GroundSampler,
    getExaggeration: () => number,
    events: SitesLayerEvents,
  ) {
    this.sites = file.sites;
    this.camera = camera;
    this.domElement = domElement;
    this.ground = ground;
    this.getExaggeration = getExaggeration;
    this.events = events;
    this.group.name = 'sites-overlay';

    for (const site of this.sites) {
      this.buildMarker(site);
      if (site.geometryLocal) this.buildOutlines(site);
    }
    this.refreshHeights();

    domElement.addEventListener('pointerdown', this.onPointerDown);
    domElement.addEventListener('pointerup', this.onPointerUp);
  }

  get count(): number {
    return this.sites.length;
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
    if (!on) this.select(null);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Programmatic selection (dev hooks, tests); null clears. */
  select(id: string | null): void {
    const site = id === null ? null : (this.sites.find((s) => s.id === id) ?? null);
    this.selectedId = site?.id ?? null;
    for (const marker of this.markers) {
      const isSelected = marker.userData['siteId'] === this.selectedId;
      marker.scale.setScalar(isSelected ? 1.45 : 1);
    }
    this.events.onSelect(site);
  }

  /** Re-seat every marker and outline vertex on the exaggerated surface. */
  refreshHeights(): void {
    const exag = this.getExaggeration();
    for (const marker of this.markers) {
      const { x, z } = marker.userData as { x: number; z: number };
      marker.position.y = this.ground(x, z) * exag + MARKER_LIFT;
    }
    for (const pick of this.pickTargets) {
      const { x, z } = pick.userData as { x: number; z: number };
      pick.position.y = this.ground(x, z) * exag;
    }
    for (const { line, groundY } of this.outlines) {
      const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < groundY.length; i++) {
        attr.setY(i, groundY[i] * exag + OUTLINE_LIFT);
      }
      attr.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    }
  }

  dispose(): void {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh || (o as THREE.Line).isLine) mesh.geometry?.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.group.clear();
  }

  // ----- construction ----------------------------------------------------- //

  private markerGeometry(style: SiteStyle): THREE.BufferGeometry {
    const r = style.radius;
    let geometry: THREE.BufferGeometry;
    switch (style.shape) {
      case 'ring':
        geometry = new THREE.RingGeometry(r * 0.62, r, 28);
        break;
      case 'square':
        geometry = new THREE.PlaneGeometry(r * 1.6, r * 1.6);
        break;
      case 'diamond': {
        geometry = new THREE.PlaneGeometry(r * 1.5, r * 1.5);
        geometry.rotateZ(Math.PI / 4);
        break;
      }
      default:
        geometry = new THREE.CircleGeometry(r, 28);
    }
    geometry.rotateX(-Math.PI / 2); // flat on the ground, facing up
    return geometry;
  }

  private buildMarker(site: SiteRecord): void {
    const style = siteStyle(site.lamningstyp);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setStyle(style.color, THREE.SRGBColorSpace),
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.materials.push(material);

    const marker = new THREE.Mesh(this.markerGeometry(style), material);
    marker.position.set(site.position.x, 0, site.position.z);
    marker.renderOrder = 2;
    marker.userData = { siteId: site.id, x: site.position.x, z: site.position.z };
    this.markers.push(marker);
    this.group.add(marker);

    // Generous invisible pick volume — a flat disc is unclickable edge-on.
    const pick = new THREE.Mesh(
      new THREE.CylinderGeometry(Math.max(14, style.radius * 1.2), Math.max(14, style.radius * 1.2), 40, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    pick.position.set(site.position.x, 0, site.position.z);
    pick.userData = { siteId: site.id, x: site.position.x, z: site.position.z };
    this.pickTargets.push(pick);
    this.group.add(pick);
  }

  /** Rings/paths of a (Multi)Polygon / (Multi)LineString as draped outlines. */
  private outlinePaths(geometry: SiteGeometryLocal): Array<{ points: Array<[number, number]>; close: boolean }> {
    const c = geometry.coordinates as unknown;
    switch (geometry.type) {
      case 'Polygon':
        return (c as Array<Array<[number, number]>>).map((ring) => ({ points: ring, close: true }));
      case 'MultiPolygon':
        return (c as Array<Array<Array<[number, number]>>>).flat().map((ring) => ({ points: ring, close: true }));
      case 'LineString':
        return [{ points: c as Array<[number, number]>, close: false }];
      case 'MultiLineString':
        return (c as Array<Array<[number, number]>>).map((path) => ({ points: path, close: false }));
      default:
        return []; // Point/MultiPoint: the marker is the whole story
    }
  }

  private buildOutlines(site: SiteRecord): void {
    const style = siteStyle(site.lamningstyp);
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color().setStyle(style.color, THREE.SRGBColorSpace),
      transparent: true,
      opacity: 0.8,
    });
    this.materials.push(material);

    for (const { points, close } of this.outlinePaths(site.geometryLocal!)) {
      if (points.length < 2) continue;
      const draped = densifyPath(points, DRAPE_STEP, close);
      const positions = new Float32Array(draped.length * 3);
      const groundY = new Float32Array(draped.length);
      for (let i = 0; i < draped.length; i++) {
        const [x, z] = draped[i];
        positions[i * 3] = x;
        positions[i * 3 + 2] = z;
        groundY[i] = this.ground(x, z);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const line = new THREE.Line(geometry, material);
      line.renderOrder = 2;
      this.outlines.push({ line, groundY });
      this.group.add(line);
    }
  }

  // ----- picking ---------------------------------------------------------- //

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button === 0) this.downAt = { x: event.clientX, y: event.clientY };
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const down = this.downAt;
    this.downAt = null;
    if (!down || !this.group.visible || event.button !== 0) return;
    // A real click, not the tail end of an orbit drag.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP_PX) return;

    const rect = this.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickTargets, false);
    if (hits.length > 0) {
      this.select((hits[0].object.userData as { siteId: string }).siteId);
    } else if (this.selectedId !== null) {
      this.select(null); // click on empty ground closes the popup
    }
  };
}
