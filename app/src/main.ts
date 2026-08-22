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

import { CameraModes, type EnterOptions } from './camera/modes';
import { createOrbitRig } from './camera/orbitCamera';
import * as coords from './lib/coords';
import { LandcoverTint } from './landcover/tint';
import { VegetationLayer } from './landcover/vegetation';
import { PalisadeLayer } from './overlays/palisade';
import {
  loadGrid,
  loadLandcoverAssets,
  loadManifest,
  loadRampart,
  loadRingConnect,
  loadRingGrid,
  loadSites,
  loadWaterAssets,
  siteIdFromLocation,
} from './state/loader';
import type { SiteManifest } from './state/manifest';
import type { HeightGrid } from './terrain/heightGrid';
import { Lighting } from './terrain/lighting';
import { Terrain } from './terrain/terrain';
import { SitesLayer } from './overlays/sites';
import { addLandcoverControls, addPalisadeControls, addSitesControls, addWaterControls, createControls } from './ui/controls';
import { Hud } from './ui/hud';
import { Legend } from './ui/legend';
import { buildMethodsModel } from './ui/methodsModel';
import { MethodsPanel } from './ui/methodsPanel';
import { SitePanel } from './ui/sitePanel';
import { ViewshedController } from './viewshed/controller';
import { ObserverMarker } from './viewshed/observer';
import { ViewshedOverlay } from './viewshed/overlay';
import { connectAtLocal } from './water/connectGrid';
import { WaterLayer } from './water/water';

declare global {
  interface Window {
    /** Minimal, deliberately loose dev hook for later phases and headless tests. */
    __app?: Record<string, unknown>;
    /** Deterministic "the scene is built and has rendered" signal. */
    __terrainReady?: boolean;
    /** Increments every time a viewshed mask is applied to the overlay. */
    __viewshedStamp?: number;
  }
}

const viewport = document.getElementById('viewport') as HTMLDivElement;

// Log depth buffer (§11): the far-field rings put sub-meter geometry and a
// 32–96 km far plane in the same frustum; a linear depth buffer would z-fight.
// Harmless for ringless sites (the testsite), so it is unconditional.
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,
});
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

/**
 * Unexaggerated ground height at local (x, z): the 1 m core grid where it
 * covers, the 2 m context grid elsewhere. Phase-2 walking and the camera
 * transitions both sample through here.
 */
function groundAt(x: number, z: number): number {
  const core = terrain.coreGrid;
  if (
    core &&
    x >= core.boundsLocal.minX &&
    x <= core.boundsLocal.maxX &&
    z >= core.boundsLocal.minZ &&
    z <= core.boundsLocal.maxZ
  ) {
    return coords.heightAtLocal(core.heights, x, z, core);
  }
  const grid = terrain.contextGrid;
  return grid ? coords.heightAtLocal(grid.heights, x, z, grid) : 0;
}

const modes = new CameraModes(rig, renderer.domElement);

/** Phase-3 viewshed rig; built in start() once the context grid is decoded. */
interface ViewshedRig {
  controller: ViewshedController;
  overlay: ViewshedOverlay;
  marker: ObserverMarker;
  hasMask: boolean;
}
let viewshed: ViewshedRig | null = null;

function applyViewshedSettings(): void {
  if (!viewshed) return;
  const s = controlState.viewshed;
  viewshed.marker.setVisible(s.show);
  viewshed.overlay.setEnabled(s.show && viewshed.hasMask);
  if (s.show) requestViewshed();
}

/** Phase-4 water layer; built in start() only if the site ships §6/§7 assets. */
let water: WaterLayer | null = null;
let waterReadout: { update(): void } | null = null;
/** The layer's one-line caveat, surfaced on first enable (PLAN §6.1). */
let waterCaveat: { badge: string; text: string } | null = null;

/**
 * Single funnel for every way the water layer can change — the slider, the
 * toggle, and the `window.__app.water` dev hooks all land here, so a headless
 * driver sees exactly what a click produces, caveat included.
 */
function applyWaterSettings(): void {
  if (!water) return;
  water.setYear(controlState.water.yearCE);
  water.setEnabled(controlState.water.show);
  // Contract §9: vegetation standing in water at the *current* slider level is
  // suppressed, so scrubbing the slider never shows trees wading. The level tracks
  // the slider, not the water toggle — the modelled landscape must stay consistent
  // with the century the viewer has chosen even with the water plane hidden.
  vegetation?.setWaterLevel(water.levelM);
  // v1.3 (§9/§10): and the two dynamic land-cover classes — the open sea's ground
  // tint and the shore reed belt — are derived at that same level, so scrubbing
  // leaves no stale water tint on drained seabed and no stranded reed belt.
  landcoverTint?.setWaterLevel(water.levelM);
  landcoverReadout?.update(); // the plant readout counts what is visible *now*
  waterReadout?.update();
  if (controlState.water.show && waterCaveat) {
    hud.showCaveatOnce('water', waterCaveat.badge, waterCaveat.text);
  }
}

/** Phase-5 registered-sites overlay; built in start() if `assets.sites` exists. */
let sitesLayer: SitesLayer | null = null;
let sitesControls: { update(): void } | null = null;

function applySitesSettings(): void {
  if (!sitesLayer) return;
  sitesLayer.setVisible(controlState.sites.show);
  sitesControls?.update();
}

// --- Phase 5: conjectural palisade (optional §8 asset; absent = feature off) --
/** Built in start() only if the site ships `assets.rampart`. */
let palisade: PalisadeLayer | null = null;
let palisadeReadout: { update(): void } | null = null;

const PALISADE_CAVEAT =
  'Palisade is CONJECTURE: no palisade has been excavated at Broborg. The line follows the ' +
  'measured rampart crest; posts, height and spacing are illustrative parameters.';

/** Single funnel for the palisade UI and the `window.__app.palisade` dev hooks. */
function applyPalisadeSettings(): void {
  if (!palisade) return;
  const s = controlState.palisade;
  palisade.setParams({ heightM: s.heightM, spacingM: s.spacingM, seed: Math.round(s.seed) });
  palisade.setEnabled(s.show);
  palisadeReadout?.update();
  if (s.show) hud.showCaveatOnce('palisade', 'conjecture', PALISADE_CAVEAT);
}
// -----------------------------------------------------------------------------

// --- Phase 7: modeled landscape (optional §9/§10 pair; absent = feature off) --
/**
 * Two halves, built at different points in start() for a shader-ordering reason
 * spelled out there: the ground tint has to be injected into the terrain materials
 * between the viewshed and the water, while the vegetation needs the water assets
 * that load after it.
 */
let landcoverTint: LandcoverTint | null = null;
let vegetation: VegetationLayer | null = null;
let landcoverReadout: { update(): void } | null = null;
/** The legend's own one-line caveat, surfaced on first enable (PLAN §6.1). */
let landcoverCaveat: { badge: string; text: string } | null = null;

/** Single funnel for the landscape UI and the `window.__app.landcover` dev hooks. */
function applyLandcoverSettings(): void {
  if (!landcoverTint && !vegetation) return;
  const s = controlState.landcover;
  vegetation?.setParams({ seed: Math.round(s.seed), densityScale: s.density });
  vegetation?.setEnabled(s.show);
  landcoverTint?.setEnabled(s.show);
  landcoverReadout?.update();
  if (s.show && landcoverCaveat) {
    hud.showCaveatOnce('landcover', landcoverCaveat.badge, landcoverCaveat.text);
  }
}
// -----------------------------------------------------------------------------

/** Ask the worker for a mask at the marker's position (latest-wins throttled). */
function requestViewshed(): void {
  if (!viewshed || !terrain.contextGrid) return;
  const grid = terrain.contextGrid;
  const { col, row } = coords.gridFromLocal(viewshed.marker.x, viewshed.marker.z, grid);
  viewshed.controller.request(col, row, controlState.viewshed);
}

const hud = new Hud(document.body);
const { gui, state: controlState } = createControls(document.body, {
  onSunChange: (azimuth, elevation) => lighting.setSun(azimuth, elevation),
  onExaggerationChange: (value) => {
    terrain.setExaggeration(value);
    hud.setExaggeration(value);
    viewshed?.marker.refreshHeight();
    sitesLayer?.refreshHeights();
    palisade?.refreshHeights(); // posts sit on the exaggerated ground, at true height
    vegetation?.refreshHeights(); // ...and so do the plants (contract §0/§9)
    refit();
  },
  onToggleFirstPerson: () => modes.toggle(groundAt, terrain.getExaggeration()),
  onViewshedChange: () => applyViewshedSettings(),
});

const ORBIT_HINT = 'F — first person';
const FP_HINT = 'WASD walk · Shift run · click to lock mouse & look · F back to orbit';
hud.setModeHint(ORBIT_HINT);
modes.onModeChange = (mode) => {
  if (mode === 'transition') hud.setModeHint('');
  else hud.setModeHint(mode === 'firstPerson' ? FP_HINT : ORBIT_HINT);
};
window.addEventListener('keydown', (event) => {
  const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (event.code === 'KeyF' && !event.repeat && !inField) modes.toggle(groundAt, terrain.getExaggeration());
});

terrain.setExaggeration(controlState.exaggeration);
hud.setExaggeration(controlState.exaggeration);
lighting.setSun(controlState.sunAzimuth, controlState.sunElevation);

/** Keep the orbit target sitting on the ground when exaggeration changes. */
function refit(): void {
  if (modes.mode !== 'orbit') return; // first-person re-clamps every frame anyway
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

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  const walkable = terrain.contextGrid?.boundsLocal ?? { minX: -1, minZ: -1, maxX: 1, maxZ: 1 };
  modes.update(dt, groundAt, terrain.getExaggeration(), walkable);
  if (modes.mode === 'orbit') rig.controls.update();
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

  // Elevation tint spans every grid the site ships — core, context and the §11
  // rings (known from the manifest before any ring loads) — so near and far
  // terrain stay colour-consistent when the rings stream in.
  const tintGrids = [manifest.grids.core, manifest.grids.context, ...(manifest.grids.rings ?? [])];
  terrain.setElevationRange(
    Math.min(...tintGrids.map((g) => g.minElevation)),
    Math.max(...tintGrids.map((g) => g.maxElevation)),
  );

  const contextExtent = manifest.grids.context.boundsLocal;
  lighting.setRadius(Math.max(contextExtent.maxX - contextExtent.minX, 2000) * 1.5);

  // --- context first: instant full-extent overview -------------------------
  const contextGrid: HeightGrid = await loadGrid(siteId, 'context', manifest, (f) =>
    hud.setProgress('Loading context elevation (2 m)…', 0.05 + f * 0.35),
  );
  await terrain.setContext(contextGrid, (f) => hud.setProgress('Building context terrain…', 0.40 + f * 0.1));
  rig.frameSite(contextGrid, terrain.getExaggeration());

  // The fog band hugs the edge of whatever terrain exists: today's haze wall at
  // the context edge until rings load, then pushed out with each ring so the
  // skyline stays terrain out to the (curvature-corrected) horizon and only the
  // outermost edge hazes over. Re-run after every ring arrives (§11).
  function updateFog(): void {
    const outer = terrain.outerHalfExtent();
    const bg = scene.background as THREE.Color;
    if (terrain.ringCount === 0) {
      const half = (contextExtent.maxX - contextExtent.minX) / 2;
      scene.fog = new THREE.Fog(bg, half * 1.1, half * 3.4);
    } else {
      scene.fog = new THREE.Fog(bg, outer * 0.75, outer * 1.02);
    }
  }
  updateFog();

  window.__app = { ...(window.__app ?? {}), contextGrid };

  // --- then the 1 m core ---------------------------------------------------
  const coreGrid: HeightGrid = await loadGrid(siteId, 'core', manifest, (f) =>
    hud.setProgress('Loading core elevation (1 m)…', 0.5 + f * 0.32),
  );
  await terrain.setCore(coreGrid, (f) => hud.setProgress('Building core terrain…', 0.82 + f * 0.18));
  rig.frameSite(coreGrid, terrain.getExaggeration());

  // --- Phase 3: viewshed worker + overlay + draggable observer --------------
  // Analysis runs on the 2 m context grid (contract §4); the overlay texture is
  // addressed by world XZ so it shades core and context meshes alike.
  const overlay = new ViewshedOverlay(contextGrid.width, contextGrid.height, contextGrid.boundsLocal);
  for (const material of terrain.overlayMaterials) overlay.attach(material);

  const controller = new ViewshedController(contextGrid);
  const marker = new ObserverMarker(
    rig.camera,
    renderer.domElement,
    groundAt,
    () => terrain.getExaggeration(),
    () => contextGrid.boundsLocal,
    { onMove: () => requestViewshed() },
  );
  marker.onDragStateChange = (dragging) => {
    if (modes.mode === 'orbit') rig.controls.enabled = !dragging;
  };
  marker.setPosition(0, 0); // site center; for Broborg that is the fort crown
  marker.setVisible(false);
  scene.add(marker.group);

  viewshed = { controller, overlay, marker, hasMask: false };
  controller.onResult = (mask, elapsedMs) => {
    if (!viewshed) return;
    overlay.setMask(mask);
    viewshed.hasMask = true;
    overlay.setEnabled(controlState.viewshed.show);
    window.__app = { ...(window.__app ?? {}), viewshedElapsedMs: elapsedMs };
    window.__viewshedStamp = (window.__viewshedStamp ?? 0) + 1;
  };

  // --- Phase 4 assets, loaded first (v1.3) ---------------------------------
  // Load order and attach order are two different things here, and since the v1.3
  // amendment they genuinely differ. The §6/§7 water assets are *loaded* first
  // because the land-cover tint takes the §7 connect grid in its constructor (the
  // dynamic sea and shore band are derived from it at the current level); the water
  // *layer* is still attached after the tint, below, because attach order is shading
  // order and contract §9 fixes that as viewshed -> landcover -> water.
  const assets = await loadWaterAssets(
    siteId,
    manifest,
    (f) => hud.setProgress('Loading paleo-shoreline model…', 0.94 + f * 0.03),
    // v1.5 §12: the connectivity grid ships as a delta against this DEM.
    contextGrid,
  );

  // --- Phase 7 (first half): the land-cover ground tint ---------------------
  // All three ground overlays inject into the same two terrain materials, each
  // chaining the handler it found, so **attach order is shading order**; contract
  // §9 fixes that order as viewshed -> landcover -> water, because submerged ground
  // must still read as submerged whatever the land cover says. The rest of the
  // layer (the vegetation and the UI) is wired after the palisade block.
  const landcover = await loadLandcoverAssets(siteId, manifest, (f) =>
    hud.setProgress('Loading modeled landscape…', 0.97 + f * 0.03),
  );
  if (landcover) {
    landcoverTint = new LandcoverTint(landcover.grid, landcover.legend, assets?.connect ?? null);
    for (const material of terrain.overlayMaterials) landcoverTint.attach(material);
  }

  // --- Phase 4: paleo-shoreline (optional assets; absent = feature off) -----
  // The water plane is parented under the terrain group so it inherits vertical
  // exaggeration (contract §0 / PLAN §4.5), and its tint is chained onto the same
  // materials the viewshed overlay and the land-cover tint injected into — see
  // water/water.ts for how the injections compose.
  if (assets) {
    water = new WaterLayer(assets.table, assets.connect);
    terrain.group.add(water.mesh);
    for (const material of terrain.overlayMaterials) water.attachTerrain(material);

    const layerName = manifest.layers?.find((l) => l.id === 'water')?.name ?? 'Paleo-shoreline';
    const caveat = assets.table.uncertainty ?? 'Modeled water level — see the methods panel.';
    waterCaveat = { badge: 'model', text: `${layerName}. ${caveat}` };
    waterReadout = addWaterControls(gui, controlState, {
      name: layerName,
      years: water.years,
      uncertainty: caveat,
      // Start in the middle of the fort era rather than at an endpoint.
      initialYear: 400,
      levelAt: (yearCE) => water?.levelAt(yearCE) ?? 0,
      onChange: () => applyWaterSettings(),
    });
    applyWaterSettings();
  }

  // --- Phase 5: registered-sites overlay (optional asset; absent = off) -----
  // Flat cartographic markers + Fornsök popups from the KMR extract. The layer
  // lives in the scene (not the Y-scaled terrain group) and re-seats itself on
  // exaggeration changes, like the viewshed observer.
  const sitesFile = await loadSites(siteId, manifest);
  if (sitesFile) {
    const panel = new SitePanel(document.body);
    sitesLayer = new SitesLayer(
      sitesFile,
      rig.camera,
      renderer.domElement,
      groundAt,
      () => terrain.getExaggeration(),
      {
        onSelect: (site) => {
          if (site) panel.show(site);
          else panel.hide();
        },
      },
    );
    panel.onClose = () => sitesLayer?.select(null);
    scene.add(sitesLayer.group);

    const sitesName = manifest.layers?.find((l) => l.id === 'sites')?.name ?? 'Registered sites (KMR)';
    sitesControls = addSitesControls(gui, controlState, {
      name: sitesName,
      count: sitesLayer.count,
      onChange: () => applySitesSettings(),
    });
    applySitesSettings();
  }

  // --- Phase 5: conjectural palisade along the §8 rampart crest -------------
  // The mesh is added to the SCENE, not to `terrain.group`: posts must stand on
  // the exaggerated ground while keeping their true metric height (contract §0).
  const rampart = await loadRampart(siteId, manifest);
  if (rampart) {
    palisade = new PalisadeLayer(rampart, { groundAt, getExaggeration: () => terrain.getExaggeration() });
    scene.add(palisade.group);
    palisadeReadout = addPalisadeControls(gui, controlState, {
      caveat: PALISADE_CAVEAT,
      postCount: () => palisade?.count ?? 0,
      onChange: () => applyPalisadeSettings(),
    });
    applyPalisadeSettings();
  }
  // -------------------------------------------------------------------------

  // --- Phase 7 (second half): vegetation + the landscape controls -----------
  // Instanced cones and reed billboards sampled from the §9 raster. Like the
  // palisade this goes in the SCENE, not in `terrain.group`: plants stand on the
  // exaggerated ground while keeping their true metric size (contract §0/§9). The
  // §7 connect grid, if this site ships one, decides which instances are under
  // water at the current slider level.
  if (landcover) {
    const connect = assets?.connect ?? null;
    // v1.3: the dynamic shore band's candidates are precomputed over every level the
    // slider can reach. The §6 table is monotone in the year, so the two endpoints
    // bracket it; Math.min/max keeps that true whichever way round the table runs.
    const levelRange: [number, number] | null = water
      ? [
          Math.min(water.levelAt(water.years[0]), water.levelAt(water.years[1])),
          Math.max(water.levelAt(water.years[0]), water.levelAt(water.years[1])),
        ]
      : null;
    vegetation = new VegetationLayer(landcover.grid, landcover.legend, {
      groundAt,
      getExaggeration: () => terrain.getExaggeration(),
      connectAt: connect ? (x, z) => connectAtLocal(connect, x, z) : null,
      levelRange,
    });
    scene.add(vegetation.group);
    if (water) vegetation.setWaterLevel(water.levelM);

    const layerName = manifest.layers?.find((l) => l.id === 'landcover')?.name ?? 'Modeled landscape (rule-based)';
    landcoverCaveat = { badge: 'model', text: `${layerName}. ${landcover.legend.caveat}` };
    landcoverReadout = addLandcoverControls(gui, controlState, {
      name: layerName,
      referenceYearCE: landcover.legend.referenceYearCE,
      classCount: landcover.legend.classes.length,
      caveat: landcover.legend.caveat,
      // v1.3: some classes follow the slider, so the note has to say which.
      hasDynamicClasses: landcover.legend.classes.some((c) => c.dynamic),
      // What is standing at the century shown, not what was placed: with the band
      // window and the split suppression thresholds those differ a lot (§9 v1.3).
      instanceCount: () => vegetation?.visibleCount ?? 0,
      onChange: () => applyLandcoverSettings(),
    });
    applyLandcoverSettings();
  }
  // -------------------------------------------------------------------------

  // --- Phase 6: methods panel + legend (PLAN §6.1/§6.2) ---------------------
  // Built after every optional asset has resolved, so the panel describes only
  // the layers this site actually ships, in the data's own words.
  const methods = new MethodsPanel(document.body);
  methods.setContent(buildMethodsModel(manifest, assets?.table ?? null, rampart, sitesFile, landcover?.legend ?? null));
  hud.mountAction(methods.button);

  const legend = new Legend(document.body);
  legend.setContent(manifest.layers ?? [], sitesFile?.sites ?? null, landcover?.legend ?? null);
  // -------------------------------------------------------------------------

  // The sites overlay is cartographic (flat map symbols): standing on the
  // ground it reads as floating sheets, so it hides in first person.
  modes.onModeChange = (mode) => {
    if (mode === 'transition') hud.setModeHint('');
    else hud.setModeHint(mode === 'firstPerson' ? FP_HINT : ORBIT_HINT);
    sitesLayer?.setVisible(controlState.sites.show && mode !== 'firstPerson');
  };

  hud.setProgress('Ready', 1);
  hud.finishLoading();

  // --- v1.4 §11: far-field rings, lazily, inside-out ------------------------
  // Startup above is byte-identical to a ringless build; the rings stream in
  // behind it, each one extending the terrain, the fog line and the far plane.
  // A missing or failed ring stops the chain and keeps what loaded — the fog
  // line just stays nearer (the horizon guarantee is a data guarantee).
  const ringsStatus = {
    declared: manifest.grids.rings?.length ?? 0,
    loaded: 0,
    done: manifest.grids.rings?.length ? false : true,
    farWater: false,
  };
  async function loadRingsLazily(): Promise<void> {
    const rings = manifest.grids.rings;
    if (!rings?.length) return;
    for (let i = 0; i < rings.length; i++) {
      let ringGrid: HeightGrid;
      try {
        ringGrid = await loadRingGrid(siteId, manifest, i);
        await terrain.setRing(i, ringGrid);
        ringsStatus.loaded += 1;
        rig.setFarHorizon(terrain.outerHalfExtent());
        updateFog();
        console.info(
          `[fornborg] ring ${i + 1}/${rings.length} up — terrain out to ` +
            `${Math.round((terrain.outerHalfExtent() * 2) / 1000)} km`,
        );
      } catch (error) {
        console.error(
          `[fornborg] ${siteId}: ring ${i} failed, keeping the ${ringsStatus.loaded} nearer ring(s) — ` +
            (error instanceof Error ? error.message : String(error)),
        );
        break;
      }
      // §11 far water: the ring that carries a connect grid extends the
      // paleo-water plane out to its bounds, faded toward its edge.
      if ((rings[i].waterConnect || rings[i].waterConnectDelta) && water) {
        try {
          const farConnect = await loadRingConnect(siteId, rings[i], () => {}, ringGrid);
          water.setFarConnect(farConnect);
          ringsStatus.farWater = true;
        } catch (error) {
          console.error(
            `[fornborg] ${siteId}: far-water connect failed, water stays at the context extent — ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }
    ringsStatus.done = true;
  }
  // -------------------------------------------------------------------------

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
    modes,
    groundAt,
    enterFirstPerson(opts: EnterOptions = {}) {
      modes.enterFirstPerson({ instant: true, ...opts }, groundAt, terrain.getExaggeration());
    },
    exitFirstPerson() {
      modes.exitToOrbit(true, groundAt, terrain.getExaggeration());
    },
    setLook(azimuthDeg: number, pitchDeg: number) {
      const fp = modes.firstPerson;
      fp.setPose(fp.x, fp.z, azimuthDeg, pitchDeg);
    },
    viewshed: {
      controlState: controlState.viewshed,
      overlay,
      marker,
      setObserver(x: number, z: number) {
        marker.setPosition(x, z);
        requestViewshed();
      },
      apply: applyViewshedSettings,
    },
    // Phase 4. Present (with `layer: null`) even when the site ships no water
    // assets, so a headless check can tell "feature off" from "not wired up".
    water: {
      layer: water,
      state: controlState.water,
      table: assets?.table ?? null,
      connect: assets?.connect ?? null,
      setYear(yearCE: number) {
        controlState.water.yearCE = yearCE;
        applyWaterSettings();
      },
      setEnabled(on: boolean) {
        controlState.water.show = on;
        applyWaterSettings();
      },
      levelAt(yearCE: number) {
        return water ? water.levelAt(yearCE) : null;
      },
    },
    // Phase 5. Same convention as `water`: present with `layer: null` when the
    // site ships no sites.json, so headless checks can tell off from missing.
    sites: {
      layer: sitesLayer,
      state: controlState.sites,
      count: sitesLayer?.count ?? 0,
      setEnabled(on: boolean) {
        controlState.sites.show = on;
        applySitesSettings();
      },
      select(id: string | null) {
        sitesLayer?.select(id);
      },
    },
    // Phase 5. Present (with `layer: null`) even when the site ships no rampart,
    // so a headless check can tell "feature off" from "not wired up".
    palisade: {
      layer: palisade,
      state: controlState.palisade,
      rampart,
      get count() {
        return palisade?.count ?? 0;
      },
      setEnabled(on: boolean) {
        controlState.palisade.show = on;
        applyPalisadeSettings();
      },
      setParams(next: { heightM?: number; spacingM?: number; seed?: number }) {
        Object.assign(controlState.palisade, next);
        applyPalisadeSettings();
      },
    },
    // Phase 7. Present (with `layer: null`) even when the site ships no land-cover
    // pair, so a headless check can tell "feature off" from "not wired up".
    landcover: {
      layer: vegetation,
      tint: landcoverTint,
      state: controlState.landcover,
      legend: landcover?.legend ?? null,
      grid: landcover?.grid ?? null,
      get count() {
        return vegetation?.count ?? 0;
      },
      get visibleCount() {
        return vegetation?.visibleCount ?? 0;
      },
      // v1.3 dynamic shore band, for headless checks of the slider behaviour.
      get bandM() {
        return vegetation?.bandM ?? 0;
      },
      get bandCount() {
        return vegetation?.bandCount ?? 0;
      },
      setEnabled(on: boolean) {
        controlState.landcover.show = on;
        applyLandcoverSettings();
      },
      setParams(next: { seed?: number; density?: number }) {
        Object.assign(controlState.landcover, next);
        applyLandcoverSettings();
      },
    },
    // Phase 8 (§11). Present even for ringless sites, so a headless check can
    // tell "feature off" (declared: 0, done: true) from "not wired up".
    rings: ringsStatus,
    // Phase 6.
    methods: {
      open: () => methods.show(),
      close: () => methods.hide(),
      get isOpen() {
        return methods.open;
      },
    },
    legend,
  };

  // One more rendered frame, then the deterministic ready flag. The ring chain
  // starts after it: readiness means "the near scene is up", exactly as before.
  renderer.render(scene, rig.camera);
  requestAnimationFrame(() => {
    window.__terrainReady = true;
    void loadRingsLazily();
  });
}

start().catch((error: unknown) => {
  hud.showError(error);
  window.__app = { ...(window.__app ?? {}), error: String(error) };
  window.__terrainReady = false;
});
