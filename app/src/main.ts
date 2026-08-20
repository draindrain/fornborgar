/**
 * Fornborg Explorer — Phase 1 entry point.
 *
 * Load order (PLAN §4.1): manifest -> context grid (instant 2 m overview of the
 * full 4x4 km extent) -> core grid (1 m over the central 2x2 km, swapped in when
 * ready). Both decoded grids stay live on `window.__app` so the Phase-3 viewshed
 * worker and the Phase-4 water logic read the *same* arrays the mesh was built
 * from — one analysis grid, one source of truth.
 */

import * as THREE from 'three';
import './style.css';

import { createOrbitRig } from './camera/orbitCamera';
import * as coords from './lib/coords';
import { loadGrid, loadManifest, siteIdFromLocation } from './state/loader';
import type { SiteManifest } from './state/manifest';
import type { HeightGrid } from './terrain/heightGrid';
import { Lighting } from './terrain/lighting';
import { Terrain } from './terrain/terrain';
import { createControls } from './ui/controls';
import { Hud } from './ui/hud';

declare global {
  interface Window {
    /** Minimal, deliberately loose dev hook for later phases and headless tests. */
    __app?: Record<string, unknown>;
    /** Deterministic "the scene is built and has rendered" signal. */
    __terrainReady?: boolean;
  }
}

const viewport = document.getElementById('viewport') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping ?? THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
viewport.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color().setStyle('#8fa3b4', THREE.SRGBColorSpace);

const terrain = new Terrain();
const lighting = new Lighting();
scene.add(terrain.group, lighting.group);

const rig = createOrbitRig(renderer.domElement, window.innerWidth / window.innerHeight);
scene.add(rig.camera);

const hud = new Hud(document.body);
const { state: controlState } = createControls(document.body, {
  onSunChange: (azimuth, elevation) => lighting.setSun(azimuth, elevation),
  onExaggerationChange: (value) => {
    terrain.setExaggeration(value);
    hud.setExaggeration(value);
    refit();
  },
});

terrain.setExaggeration(controlState.exaggeration);
hud.setExaggeration(controlState.exaggeration);
lighting.setSun(controlState.sunAzimuth, controlState.sunElevation);

/** Keep the orbit target sitting on the ground when exaggeration changes. */
function refit(): void {
  const grid = terrain.coreGrid ?? terrain.contextGrid;
  if (!grid) return;
  const t = rig.controls.target;
  t.y = coords.heightAtLocal(grid.heights, t.x, t.z, grid) * terrain.getExaggeration();
  rig.controls.update();
}

function onResize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  rig.camera.aspect = w / h;
  rig.camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

renderer.setAnimationLoop(() => {
  rig.controls.update();
  renderer.render(scene, rig.camera);
});

function describeSite(manifest: SiteManifest): string {
  const core = manifest.grids.core;
  const context = manifest.grids.context;
  const extent = (g: typeof core) => {
    const m = g.width * g.resolution;
    return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `${Math.round(m)} m`;
  };
  return (
    `Ground elevation model — ${extent(core)} square at ${core.resolution} m, ` +
    `${extent(context)} context at ${context.resolution} m. Heights RH 2000, SWEREF 99 TM.`
  );
}

async function start(): Promise<void> {
  const siteId = siteIdFromLocation();
  console.info(`[fornborg] site=${siteId} base=${import.meta.env.BASE_URL}`);
  hud.setProgress('Reading manifest…', 0.02);

  const manifest = await loadManifest(siteId);
  hud.setSite(manifest.site.name, describeSite(manifest));
  hud.setAttribution(manifest.attribution ?? []);

  // Elevation tint spans both grids so core and context stay colour-consistent.
  terrain.setElevationRange(
    Math.min(manifest.grids.core.minElevation, manifest.grids.context.minElevation),
    Math.max(manifest.grids.core.maxElevation, manifest.grids.context.maxElevation),
  );

  const contextExtent = manifest.grids.context.boundsLocal;
  lighting.setRadius(Math.max(contextExtent.maxX - contextExtent.minX, 2000) * 1.5);

  // --- context first: instant full-extent overview -------------------------
  const contextGrid: HeightGrid = await loadGrid(siteId, 'context', manifest, (f) =>
    hud.setProgress('Loading context elevation (2 m)…', 0.05 + f * 0.35),
  );
  await terrain.setContext(contextGrid, (f) => hud.setProgress('Building context terrain…', 0.40 + f * 0.1));
  rig.frameSite(contextGrid, terrain.getExaggeration());

  const half = (contextExtent.maxX - contextExtent.minX) / 2;
  scene.fog = new THREE.Fog(scene.background as THREE.Color, half * 1.1, half * 3.4);

  window.__app = { ...(window.__app ?? {}), contextGrid };

  // --- then the 1 m core ---------------------------------------------------
  const coreGrid: HeightGrid = await loadGrid(siteId, 'core', manifest, (f) =>
    hud.setProgress('Loading core elevation (1 m)…', 0.5 + f * 0.32),
  );
  await terrain.setCore(coreGrid, (f) => hud.setProgress('Building core terrain…', 0.82 + f * 0.18));
  rig.frameSite(coreGrid, terrain.getExaggeration());

  hud.setProgress('Ready', 1);
  hud.finishLoading();

  window.__app = {
    ...(window.__app ?? {}),
    scene,
    camera: rig.camera,
    renderer,
    controls: rig.controls,
    terrain,
    lighting,
    manifest,
    coreGrid,
    contextGrid,
    coords,
    siteId,
    setCamera(position: [number, number, number], target?: [number, number, number]) {
      rig.camera.position.set(...position);
      if (target) rig.controls.target.set(...target);
      rig.controls.update();
    },
  };

  // One more rendered frame, then the deterministic ready flag.
  renderer.render(scene, rig.camera);
  requestAnimationFrame(() => {
    window.__terrainReady = true;
  });
}

start().catch((error: unknown) => {
  hud.showError(error);
  window.__app = { ...(window.__app ?? {}), error: String(error) };
  window.__terrainReady = false;
});
