/**
 * Fornborg Explorer — Phase 1 entry point.
 *
 * Load order (PLAN §4.1): manifest -> context grid (instant 2 m overview of the
 * full 4x4 km extent) -> core grid (1 m over the central 2x2 km, swapped in when
 * ready). Both decoded grids stay live on `window.__app` so the Phase-3 viewshed
 * worker and the Phase-4 water logic read the *same* arrays the mesh was built
 * from — one analysis grid, one source of truth.
 */

import type GUI from 'lil-gui';
import * as THREE from 'three';
import './style.css';

import { CameraModes, type EnterOptions } from './camera/modes';
import { createOrbitRig } from './camera/orbitCamera';
import * as coords from './lib/coords';
import { periodAt } from './lib/periods';
import { siteLatLon } from './lib/sweref';
import { FarLandcoverTint } from './landcover/farTint';
import { FarVegetationLayer } from './landcover/farVegetation';
import { classAtLocal, type LandcoverGrid } from './landcover/landcoverGrid';
import { LandcoverTint } from './landcover/tint';
import { bakeImpostorAtlas, type ImpostorAtlas } from './landcover/impostors';
import { VegetationLayer } from './landcover/vegetation';
import { PalisadeLayer } from './overlays/palisade';
import { ReconstructionLayer, SETTLEMENT_CAVEAT } from './overlays/reconstruction/layer';
import { Atmosphere } from './sky/atmosphere';
import { moonPosition, phaseLabel, type LunarPosition } from './sky/lunar';
import { NightSky } from './sky/nightSky';
import {
  dateFromDayOfYear,
  daylight,
  localApparentSiderealDeg,
  MONTH_NAMES,
  julianDayAt,
  seasonLabel,
  solarPosition,
  type SolarPosition,
} from './sky/solar';
import { loadStarCatalogue } from './sky/stars';
import {
  debugEnabled,
  loadGrid,
  loadLandcoverAssets,
  loadReconstruction,
  loadManifest,
  loadRampart,
  loadRingConnect,
  loadRingGrid,
  loadRingLandcover,
  loadSites,
  loadSiteIndex,
  loadWaterAssets,
  siteIdFromLocation,
  skyDataUrl,
} from './state/loader';
import type { SiteManifest } from './state/manifest';
import type { HeightGrid } from './terrain/heightGrid';
import { legibilityIntensity, LEGIBILITY_SUN_COLOR, Lighting } from './terrain/lighting';
import { Terrain } from './terrain/terrain';
import { SitesLayer } from './overlays/sites';
import {
  addLandcoverControls,
  addPalisadeControls,
  addReconstructionControls,
  addSitesControls,
  addWaterControls,
  createControls,
  createControlState,
} from './ui/controls';
import { formatAltitude, formatSolarTime, TimeBar } from './ui/timeBar';
import { Hud } from './ui/hud';
import { Legend } from './ui/legend';
import { buildMethodsModel } from './ui/methodsModel';
import { MethodsPanel } from './ui/methodsPanel';
import { SitePanel } from './ui/sitePanel';
import { SitePicker } from './ui/sitePicker';
import { AboutPanel, CameraHelpPanel, Menu } from './ui/menu';
import { buildAboutModel } from './ui/menuContent';
import { ViewshedController } from './viewshed/controller';
import { ObserverMarker } from './viewshed/observer';
import { ViewshedOverlay } from './viewshed/overlay';
import { connectAtLocal } from './water/connectGrid';
import { formatLevel, formatYear } from './water/shoreline';
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

const terrain = new Terrain();
const lighting = new Lighting();
scene.add(terrain.group, lighting.group);

// Owns `scene.background`, `scene.fog`, both lights and the tone-mapping
// exposure. Constructed with a high-sun default, so the first frame before any
// site data lands looks exactly like the flat '#8fa3b4' sky this app shipped with.
const atmosphere = new Atmosphere(scene, renderer, lighting);

/**
 * The things in the sky: the sun's disc, the moon and the stars, plus the
 * uniforms the water plane reads to reflect them. The dome paints over
 * `scene.background` rather than replacing it, so a site that never gets this
 * far still shows the flat sky the atmosphere sets.
 */
const nightSky = new NightSky(renderer.getPixelRatio());
scene.add(nightSky.group);

/** `?debug=1` — the old lil-gui rig, plus the pre-redesign layer defaults. */
const debug = debugEnabled();
/**
 * The one mutable settings object. It exists whether or not a GUI is ever built,
 * and `window.__app.*.state` still points straight at its slices.
 */
const controlState = createControlState({ debug });

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
  // v1.6 (§13): the far-field billboards obey the same rule against the §11
  // ring connect grid, where the site ships one.
  farVegetation?.setWaterLevel(water.levelM);
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

// --- Phase 12: reconstruction mode (optional §14 asset; absent = mode off) ---
/**
 * The second overlay *mode*: standing monuments where marker mode draws registry
 * dots. Built in start() only if the site ships `assets.reconstruction`.
 *
 * It **replaces** the markers rather than drawing over them (owner decision,
 * docs/reconstruction-mode.md §11.1) — but not all of them: §8's ruin state
 * "simply falls back to today's marker-mode geometry, which is the measured
 * one", so a monument that is a ruin in the year on the clock, and any archetype
 * this build cannot draw yet, keeps its flat marker. `applyReconstructionSettings`
 * is the one place that decision is made.
 */
let reconstruction: ReconstructionLayer | null = null;
let reconstructionReadout: { update(): void } | null = null;
let reconstructionCaveat: { badge: string; text: string } | null = null;

const RECONSTRUCTION_CAVEAT =
  'Reconstruction mode shows INTERPRETATIONS, not the register. Plan sizes are measured; ' +
  'profiles are derived by stated, reversible transforms from ruin measurements; surfaces ' +
  'and grave-field positions are inference. Each monument states its own badge per part.';

/** Single funnel for the mode switch, the debug folder and the dev hooks. */
function applyReconstructionSettings(): void {
  if (!reconstruction) return;
  const on = controlState.reconstruction.show;
  reconstruction.setEnabled(on);
  hud.setMode(on);
  // The markers are the other half of the mode. In reconstruction mode only the
  // ruins and the not-yet-drawn archetypes keep theirs; leaving the mode
  // restores every one of them.
  if (on) {
    const keep = reconstruction.markerIds();
    sitesLayer?.setFilter((site) => keep.has(site.id));
  } else {
    sitesLayer?.setFilter(null);
  }
  reconstructionReadout?.update();
  if (on && reconstructionCaveat) {
    hud.showCaveatOnce('reconstruction', reconstructionCaveat.badge, reconstructionCaveat.text);
  }
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
// §6.1 LOD: one baked impostor atlas per seed (archetypes are seed-derived), on
// the app's own renderer. Cached so GUI toggles never re-bake; a seed change
// swaps it and disposes the old targets.
let impostorAtlasCache: { seed: number; atlas: ImpostorAtlas } | null = null;
function impostorAtlasFor(seed: number): ImpostorAtlas | null {
  if (impostorAtlasCache?.seed !== seed) {
    impostorAtlasCache?.atlas.dispose();
    impostorAtlasCache = { seed, atlas: bakeImpostorAtlas(renderer, seed) };
  }
  return impostorAtlasCache.atlas;
}
/** v1.6 §13: the far half of the same layer — one toggle drives all four. */
let farTint: FarLandcoverTint | null = null;
let farVegetation: FarVegetationLayer | null = null;
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
  // The far field is part of the same "modeled landscape" layer (§13): same
  // toggle, same seed contract. Its sampling is lazy — the first enable is
  // what builds the billboard population.
  farVegetation?.setSeed(Math.round(s.seed));
  farVegetation?.setEnabled(s.show);
  farTint?.setEnabled(s.show);
  landcoverReadout?.update();
  if (s.show && landcoverCaveat) {
    hud.showCaveatOnce('landcover', landcoverCaveat.badge, landcoverCaveat.text);
  }
}
// -----------------------------------------------------------------------------

// --- The sun, and everything the sun drags with it ---------------------------
/**
 * The site's real latitude and longitude, derived from the manifest's SWEREF 99
 * TM origin. Set in start(); until then the sun runs at Broborg's parallel so the
 * pre-manifest frames are not lit from nowhere.
 */
let siteLat = 59.7556;
let siteLon = 17.9516;

/** The sun as last computed, for the readouts and the `window.__app` hook. */
let sun: SolarPosition = solarPosition({
  latDeg: siteLat,
  yearCE: controlState.time.yearCE,
  dayOfYear: controlState.time.dayOfYear,
  solarHour: controlState.time.solarHour,
});

let timeBar: TimeBar | null = null;

/** The moon as last computed, for the readouts and the `window.__app` hook. */
let moon: LunarPosition = moonPosition({
  latDeg: siteLat,
  yearCE: controlState.time.yearCE,
  dayOfYear: controlState.time.dayOfYear,
  solarHour: controlState.time.solarHour,
});

/**
 * Single funnel for the sun: the three time sliders, the debug panel's manual
 * override, and the `window.__app.time` hooks all land here.
 *
 * The astronomy is in sky/solar.ts and the look in sky/atmosphere.ts; this only
 * decides which of the two sources of sun to believe and pushes the result at
 * the scene. Note it does *not* touch the water — the year drives that through
 * `applyWaterSettings`, which calls back here.
 */
function applySunSettings(): void {
  const t = controlState.time;
  sun = solarPosition({
    latDeg: siteLat,
    yearCE: t.yearCE,
    dayOfYear: t.dayOfYear,
    solarHour: t.solarHour,
  });

  moon = moonPosition({
    latDeg: siteLat,
    yearCE: t.yearCE,
    dayOfYear: t.dayOfYear,
    solarHour: t.solarHour,
  });

  if (controlState.sunManual) {
    // Sky and fill still come from the atmosphere at the hand-set elevation, so a
    // manually lowered sun gets a coherent sunset rather than a noon sky. Only the
    // beam is overridden, back to the pre-astronomy legibility curve — the point
    // of the override is a light that stays strong while grazing.
    atmosphere.apply(controlState.sunElevation, controlState.sunAzimuth);
    lighting.setSunLight(LEGIBILITY_SUN_COLOR, legibilityIntensity(controlState.sunElevation));
  } else {
    controlState.sunAzimuth = sun.azimuthDeg;
    controlState.sunElevation = sun.apparentAltitudeDeg;
    atmosphere.apply(sun.apparentAltitudeDeg, sun.azimuthDeg);
  }

  // The drawn sun follows whichever sun is lighting the scene, override
  // included — a disc in one place and a shadow from another would be worse
  // than no disc. The moon keeps its real position either way: the override is
  // a lighting rig, not a different sky.
  const drawnSun = controlState.sunManual
    ? {
        altitudeDeg: controlState.sunElevation,
        apparentAltitudeDeg: controlState.sunElevation,
        azimuthDeg: controlState.sunAzimuth,
      }
    : sun;
  nightSky.apply({
    sky: atmosphere.state,
    sun: drawnSun,
    moon,
    latDeg: siteLat,
    siderealDeg: localApparentSiderealDeg(t.solarHour, sun.rightAscensionDeg),
    jd: julianDayAt(t.yearCE, t.dayOfYear, t.solarHour),
    obliquityDeg: sun.obliquityDeg,
  });

  // The water plane lights itself (a raw ShaderMaterial with lights disabled),
  // so without this it stays a glowing teal slab after sunset.
  water?.setDaylight(atmosphere.daylight);
  water?.setExposure(atmosphere.state.exposure);

  timeBar?.update();
  sunControls?.update();
}

/**
 * Everything the year slider means. The water funnel owns the level, so the year
 * is written into `controlState.water.yearCE` — the number that already drives
 * the water plane, the reed belt, the vegetation suppression and the sea tint —
 * and the sun is recomputed because obliquity depends on the year too.
 */
function applyTimeSettings(): void {
  controlState.water.yearCE = controlState.time.yearCE;
  applyWaterSettings();
  applySunSettings();
  // §8: the archetypes are not contemporaneous, and pretending otherwise is the
  // single most likely way reconstruction mode ends up lying. At 500 CE the fort
  // stands and there are no runestones; at 1050 CE the reverse. Cheap — the gate
  // is per-archetype `visible` flags, never a rebuild — so it rides the slider.
  if (reconstruction) {
    reconstruction.setYear(controlState.time.yearCE);
    applyReconstructionSettings();
  }
}

/**
 * The moon, in one line: its phase, and whether it is up.
 *
 * It rides the *time of year* slider rather than the time of day one because
 * that is the slider that walks it through its phases — a month of day-of-year
 * is a full lunation, where an hour of solar time barely moves it.
 */
function moonReadout(): string {
  const lit = `${Math.round(moon.illuminatedFraction * 100)} %`;
  const phase = phaseLabel(moon.illuminatedFraction, moon.waxing);
  const where =
    moon.apparentAltitudeDeg > -0.5
      ? formatAltitude(moon.apparentAltitudeDeg, 'moon')
      : 'moon below the horizon';
  return `${phase} ${lit} · ${where}`;
}

/** What the three sliders say, assembled once per change. */
function timeReadouts(): {
  year: string;
  yearNote: string;
  season: string;
  seasonNote: string;
  day: string;
  dayNote: string;
} {
  const t = controlState.time;
  const period = periodAt(t.yearCE);
  const { month, day } = dateFromDayOfYear(t.yearCE, t.dayOfYear);
  const light = daylight(siteLat, t.yearCE, t.dayOfYear);

  let dayNote: string;
  if (light.polarDay) dayNote = 'midnight sun — the sun does not set';
  else if (light.polarNight) dayNote = 'polar night — the sun does not rise';
  else dayNote = `sunrise ${formatSolarTime(light.sunriseHour ?? 0)} · sunset ${formatSolarTime(light.sunsetHour ?? 0)}`;

  return {
    year: `${formatYear(t.yearCE)} · ${period.name}`,
    yearNote: water ? formatLevel(water.levelAt(t.yearCE)) : '',
    season: `${day} ${MONTH_NAMES[month - 1]} · ${seasonLabel(sun.solarLongitudeDeg)}`,
    seasonNote: moonReadout(),
    day: `${formatSolarTime(t.solarHour)} solar time · ${formatAltitude(sun.apparentAltitudeDeg)}`,
    dayNote,
  };
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
// PLAN §6.1 requires a model or conjecture layer to surface its caveat the first
// time it is switched on. Outside debug they are all on from the start, so there
// is no first toggle to hang a toast on — and since the 2026-08-23b amendment
// nothing is written over the scene at load at all. The combined provenance line
// lives in the menu's About & credits (`PROVENANCE_SUMMARY`) instead, beside the
// legend badges and the methods panel, which are unchanged. The per-layer caveats
// still fire for a debug-panel toggle.
//
// This runs here, not down in `start()`, because the load's own
// `applyWater/Landcover/PalisadeSettings()` calls are exactly what would
// otherwise fire them — suppressing afterwards is one frame too late.
if (!debug) {
  for (const id of ['water', 'landcover', 'palisade']) hud.markCaveatShown(id);
}

/**
 * The debug panel, or null. Every `addXControls` below takes `GUI | null` and
 * hands back a no-op readout when there is none, so these call sites read the
 * same in both modes.
 */
let gui: GUI | null = null;
let sunControls: { update(): void } | null = null;
if (debug) {
  const built = createControls(document.body, controlState, {
  onSunChange: () => applySunSettings(),
  onExaggerationChange: (value) => {
    terrain.setExaggeration(value);
    viewshed?.marker.refreshHeight();
    sitesLayer?.refreshHeights();
    palisade?.refreshHeights(); // posts sit on the exaggerated ground, at true height
    reconstruction?.refreshHeights(); // ...and so do the monuments (contract §0/§14)
    vegetation?.refreshHeights(); // ...and so do the plants (contract §0/§9)
    farVegetation?.refreshHeights(); // ...billboards included (v1.6 §13)
    refit();
  },
  onToggleFirstPerson: () => modes.toggle(groundAt, terrain.getExaggeration()),
  onViewshedChange: () => applyViewshedSettings(),
  });
  gui = built.gui;
  sunControls = built.sun;
}

window.addEventListener('keydown', (event) => {
  const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (event.code === 'KeyF' && !event.repeat && !inField) modes.toggle(groundAt, terrain.getExaggeration());
});

terrain.setExaggeration(controlState.exaggeration);
applySunSettings();

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
  // Moving between displays changes the device pixel ratio, and a star's size
  // is in device pixels.
  nightSky.setPixelRatio(renderer.getPixelRatio());
  rig.camera.aspect = w / h;
  rig.camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

const clock = new THREE.Clock();
/** Seconds since load, for the only thing in this scene that moves by itself. */
let elapsed = 0;
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  elapsed += dt;
  water?.setTime(elapsed);
  const walkable = terrain.contextGrid?.boundsLocal ?? { minX: -1, minZ: -1, maxX: 1, maxZ: 1 };
  modes.update(dt, groundAt, terrain.getExaggeration(), walkable);
  if (modes.mode === 'orbit') rig.controls.update();
  // §6.1 LOD: the layer rebins mesh/impostor tiers only after the camera has
  // moved REBIN_MOVE_M, so a per-frame call costs a comparison.
  vegetation?.updateCamera(rig.camera.position.x, rig.camera.position.z);
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

/**
 * The star catalogue, in the background.
 *
 * Deliberately not awaited and deliberately not fatal. The sky is up on the
 * first frame with its sun and its moon; the stars are 80 kB that arrive a
 * moment later and simply appear. A site whose host is missing the file gets a
 * starless night and a console warning, not a failed load — the catalogue is
 * app-shipped, so if it is missing something is wrong with the deployment
 * rather than with the site.
 */
async function loadStars(): Promise<void> {
  try {
    const catalogue = await loadStarCatalogue(skyDataUrl());
    const t = controlState.time;
    nightSky.attachStars(catalogue, julianDayAt(t.yearCE, t.dayOfYear, t.solarHour));
    applySunSettings();
    console.info(
      `[fornborg] stars: ${catalogue.count} to V=${catalogue.limitingMagnitude} ` +
        `(${catalogue.source.catalogue})`,
    );
  } catch (error) {
    console.warn('[fornborg] star catalogue unavailable; the night sky will have no stars', error);
  }
}

async function start(): Promise<void> {
  const siteId = siteIdFromLocation();
  console.info(`[fornborg] site=${siteId} base=${import.meta.env.BASE_URL}`);
  hud.setProgress('Reading manifest…', 0.02);

  const manifest = await loadManifest(siteId);

  // Where on Earth this is. The manifest only ships a projected SWEREF 99 TM
  // origin, and the sun needs a parallel — see lib/sweref.ts for why that one
  // piece of projection math is allowed to live in the browser.
  ({ latDeg: siteLat, lonDeg: siteLon } = siteLatLon(manifest));
  applySunSettings();
  void loadStars();

  hud.setSite(manifest.site.name);

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
    if (terrain.ringCount === 0) {
      const half = (contextExtent.maxX - contextExtent.minX) / 2;
      atmosphere.setFogBand(half * 1.1, half * 3.4);
    } else {
      atmosphere.setFogBand(outer * 0.75, outer * 1.02);
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
    // v1.6 §13: the far field exists only when the legend declares it. The tint
    // attaches per ring as rings stream in (the §11 loop below); the billboards
    // sample lazily on first enable.
    if (landcover.legend.farField) {
      farTint = new FarLandcoverTint(landcover.legend.farField.classes);
      farVegetation = new FarVegetationLayer({
        classes: landcover.legend.farField.classes,
        seed: Math.round(controlState.landcover.seed),
        contextHalfM: (contextExtent.maxX - contextExtent.minX) / 2,
        getExaggeration: () => terrain.getExaggeration(),
        atlasFor: impostorAtlasFor,
      });
      scene.add(farVegetation.group);
    }
  }

  // --- Phase 4: paleo-shoreline (optional assets; absent = feature off) -----
  // The water plane is parented under the terrain group so it inherits vertical
  // exaggeration (contract §0 / PLAN §4.5), and its tint is chained onto the same
  // materials the viewshed overlay and the land-cover tint injected into — see
  // water/water.ts for how the injections compose.
  if (assets) {
    water = new WaterLayer(assets.table, assets.connect, nightSky.uniforms);
    terrain.group.add(water.mesh);
    for (const material of terrain.overlayMaterials) water.attachTerrain(material);

    // The clock has to sit inside the model's own extent before anything reads
    // it — the default is mid-fort-era, but a site whose table starts later must
    // not open on a year its shoreline says nothing about.
    const [oldestYear, newestYear] = water.years;
    controlState.time.yearCE = Math.min(newestYear, Math.max(oldestYear, controlState.time.yearCE));

    const layerName = manifest.layers?.find((l) => l.id === 'water')?.name ?? 'Paleo-shoreline';
    const caveat = assets.table.uncertainty ?? 'Modeled water level — see the methods panel.';
    waterCaveat = { badge: 'model', text: `${layerName}. ${caveat}` };
    waterReadout = addWaterControls(gui, controlState, {
      name: layerName,
      years: water.years,
      uncertainty: caveat,
      levelAt: (yearCE) => water?.levelAt(yearCE) ?? 0,
      // The debug year slider writes `water.yearCE`; mirror it back onto the
      // clock so the time bar and the panel can never disagree.
      onChange: () => {
        controlState.time.yearCE = controlState.water.yearCE;
        applyTimeSettings();
      },
    });
    applyTimeSettings();
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
          // §9.1: in reconstruction mode the card also carries the monument's
          // own badge per part — measured plan, model profile, conjectural
          // surface — rather than one averaged label.
          if (site) {
            panel.show(
              site,
              reconstruction?.isEnabled ? reconstruction.summary(site.id) : null,
            );
          } else panel.hide();
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

  // --- Phase 12: reconstruction mode (optional §14 asset; absent = mode off) -
  // Built after the sites overlay (§14 joins to it by id), after the rampart
  // (archetype A sweeps its §7.2 section along the measured crest) and after the
  // land-cover grid (the grave-field sampler excludes wet classes with it).
  // Like the palisade it goes in the SCENE, not in `terrain.group`: monuments
  // stand *on* the exaggerated ground while keeping true metric height
  // (contract §0/§14).
  const reconstructionFile = await loadReconstruction(siteId, manifest, sitesFile);
  if (reconstructionFile && sitesFile) {
    const legend = landcover?.legend ?? null;
    reconstruction = new ReconstructionLayer(
      reconstructionFile,
      sitesFile,
      {
        groundAt,
        getExaggeration: () => terrain.getExaggeration(),
        // §6.G: "exclude wet classes using the existing land-cover raster" —
        // the existing one, by legend id rather than by index, because the
        // indices are per site and the ids are the contract's.
        classAt: landcover ? (x, z) => classAtLocal(landcover.grid, x, z) : null,
        classId: legend ? (index) => legend.classes[index]?.id ?? null : null,
        rampart,
        seed: Math.round(controlState.reconstruction.seed),
        vitrified: controlState.reconstruction.vitrified,
      },
      controlState.time.yearCE,
    );
    scene.add(reconstruction.group);
    // The reconstruction's own pick volumes join the marker layer's, so one
    // click handler serves both modes and a monument opens the same card its
    // marker does — with the §9.1 per-part provenance added.
    sitesLayer?.setExtraPickables(() => reconstruction?.pickables ?? []);

    const reconstructionName =
      manifest.layers?.find((l) => l.id === 'reconstruction')?.name ??
      'Reconstructed monuments (interpretation)';
    reconstructionCaveat = { badge: 'conjecture', text: RECONSTRUCTION_CAVEAT };
    hud.enableModeSwitch((on) => {
      controlState.reconstruction.show = on;
      applyReconstructionSettings();
    });
    reconstructionReadout = addReconstructionControls(gui, controlState, {
      name: reconstructionName,
      caveat: RECONSTRUCTION_CAVEAT,
      standingCount: () => reconstruction?.standingCount ?? 0,
      vertexCount: () => reconstruction?.vertexCount ?? 0,
      markerCount: () => sitesLayer?.shownCount ?? 0,
      onChange: () => applyReconstructionSettings(),
    });
    applyReconstructionSettings();
  }
  // -------------------------------------------------------------------------

  // --- Phase 7 (second half): vegetation + the landscape controls -----------
  // Instanced species archetype meshes (baked impostors beyond the near field) and
  // reed cross-quads, sampled from the §9 raster. Like the
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
      impostorAtlas: impostorAtlasFor,
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

  // --- The default control surface: three sliders ---------------------------
  // Built after the optional water assets have resolved, so the year slider spans
  // the site's own shoreline table where it ships one. Sites without a table get
  // the same span the tables use, and the year readout drops the water clause.
  timeBar = new TimeBar(document.body, controlState.time, {
    years: water?.years ?? [-1050, 1150],
    onChange: () => applyTimeSettings(),
    readouts: () => timeReadouts(),
  });
  applyTimeSettings();
  // -------------------------------------------------------------------------

  // --- Phase 6: methods panel + legend (PLAN §6.1/§6.2) ---------------------
  // Built after every optional asset has resolved, so the panel describes only
  // the layers this site actually ships, in the data's own words.
  const methods = new MethodsPanel(document.body);
  methods.setContent(
    buildMethodsModel(
      manifest,
      assets?.table ?? null,
      rampart,
      sitesFile,
      landcover?.legend ?? null,
      reconstructionFile,
    ),
  );

  const legend = new Legend(document.body);
  legend.setContent(manifest.layers ?? [], sitesFile?.sites ?? null, landcover?.legend ?? null);
  timeBar.setExplain(() => methods.show());
  // -------------------------------------------------------------------------

  // --- The kebab menu (PLAN §6.1, 2026-08-23b amendment) --------------------
  // Everything the default screen used to say, one click away in the top right
  // corner. What is left over the scene is the fort's name, the time bar and the
  // fort browser.
  const cameraHelp = new CameraHelpPanel(document.body);
  const about = new AboutPanel(document.body, () =>
    buildAboutModel({
      siteName: manifest.site.name,
      siteDescription: describeSite(manifest),
      // Read on open, not at construction: `?debug=1` can move it while the app runs.
      exaggeration: terrain.getExaggeration(),
      attribution: manifest.attribution ?? [],
      hasReconstruction: reconstruction !== null,
    }),
  );

  const menu = new Menu(document.body);
  menu.addItem('Legend', () => legend.show());
  menu.addItem('Methods & sources', () => methods.show());
  menu.addItem('Controls & camera', () => cameraHelp.show());
  menu.addItem('About & credits', () => about.show());
  // -------------------------------------------------------------------------

  // The sites overlay is cartographic (flat map symbols): standing on the
  // ground it reads as floating sheets, so it hides in first person.
  modes.onModeChange = (mode) => {
    sitesLayer?.setVisible(controlState.sites.show && mode !== 'firstPerson');
  };

  hud.setProgress('Ready', 1);
  hud.finishLoading();

  // --- Phase 9 §6: the national site picker ---------------------------------
  // Off unless the build has somewhere to fetch an index from, which is a
  // repo-relative build's normal state (it ships two fixtures — there is
  // nothing to pick between). Loaded after `finishLoading` so it never delays
  // the scene: the fort the user asked for is the point, the picker is how they
  // find the next one.
  let picker: SitePicker | null = null;
  void loadSiteIndex().then((index) => {
    if (!index || index.sites.length === 0) return;
    picker = new SitePicker(document.body, index, siteId);
    picker.onPick = (slug) => {
      if (slug === siteId) {
        picker?.hide();
        return;
      }
      // A full navigation, not an in-place swap: `?site=` is the deep link the
      // app already supports, and reloading through it means a picked site and
      // a pasted URL take exactly the same code path.
      const url = new URL(window.location.href);
      url.searchParams.set('site', slug);
      window.location.assign(url.toString());
    };
    hud.setSitePickerToggle(() => picker?.toggle());
    window.__app = { ...(window.__app ?? {}), siteIndex: index, picker };
  });
  // -------------------------------------------------------------------------

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
    /** v1.6 §13: rings whose class raster loaded (tint + billboard source). */
    farLandcover: 0,
  };
  async function loadRingsLazily(): Promise<void> {
    const rings = manifest.grids.rings;
    if (!rings?.length) return;
    // The §13 fade band starts at the near field's edge; each ring populates
    // billboards only outside the next-finer grid it wraps.
    let innerHalfM = (contextExtent.maxX - contextExtent.minX) / 2;
    for (let i = 0; i < rings.length; i++) {
      let ringGrid: HeightGrid;
      try {
        ringGrid = await loadRingGrid(siteId, manifest, i);
        // v1.6 §13: a ring's class raster loads before its meshes are built, so
        // the tint's dedicated material exists when `setRing` binds materials.
        // Any failure tints nothing and populates nothing — per-ring graceful,
        // like the ring DEMs themselves.
        let ringLandcover: LandcoverGrid | null = null;
        if (rings[i].landcover && farTint && landcover) {
          try {
            ringLandcover = await loadRingLandcover(
              siteId,
              manifest,
              i,
              landcover.legend.farField?.classes.length ?? 0,
            );
            farTint.attachRing(terrain.farOverlayMaterial(i), ringLandcover);
            ringsStatus.farLandcover += 1;
          } catch (error) {
            console.error(
              `[fornborg] ${siteId}: ring ${i} land cover failed, ring renders untinted — ` +
                (error instanceof Error ? error.message : String(error)),
            );
          }
        }
        await terrain.setRing(i, ringGrid);
        if (ringLandcover && farVegetation) {
          farVegetation.addRing({
            ringIndex: i,
            landcover: ringLandcover,
            heights: ringGrid,
            innerHalfM,
          });
        }
        innerHalfM = (ringGrid.boundsLocal.maxX - ringGrid.boundsLocal.minX) / 2;
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
          // §13: nothing stands in far water — the billboards suppress against
          // this same grid, at the current slider level.
          farVegetation?.setConnect((x, z) => connectAtLocal(farConnect, x, z));
          farVegetation?.setWaterLevel(water.levelM);
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
    /** Last-frame draw stats, so headless perf checks read real numbers. */
    renderInfo: () => ({ ...renderer.info.render }),
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
    /**
     * The three time sliders and the sun they produce. Same convention as the
     * layer hooks: always present, so a headless check can tell "off" from "not
     * wired up". `sun()` recomputes rather than returning a cached value, so a
     * driver that wrote `state` directly still reads the truth.
     */
    time: {
      state: controlState.time,
      latLon: { latDeg: siteLat, lonDeg: siteLon },
      debug,
      bar: timeBar,
      sun: () =>
        solarPosition({
          latDeg: siteLat,
          yearCE: controlState.time.yearCE,
          dayOfYear: controlState.time.dayOfYear,
          solarHour: controlState.time.solarHour,
        }),
      daylight: () => daylight(siteLat, controlState.time.yearCE, controlState.time.dayOfYear),
      period: () => periodAt(controlState.time.yearCE),
      sky: () => atmosphere.state,
      moon: () =>
        moonPosition({
          latDeg: siteLat,
          yearCE: controlState.time.yearCE,
          dayOfYear: controlState.time.dayOfYear,
          solarHour: controlState.time.solarHour,
        }),
      setYear(yearCE: number) {
        controlState.time.yearCE = yearCE;
        applyTimeSettings();
      },
      setDayOfYear(dayOfYear: number) {
        controlState.time.dayOfYear = dayOfYear;
        applyTimeSettings();
      },
      setSolarHour(solarHour: number) {
        controlState.time.solarHour = solarHour;
        applyTimeSettings();
      },
      apply: applyTimeSettings,
    },
    /**
     * What is drawn in the sky, as opposed to where it is — `time.sun()` and
     * `time.moon()` answer the astronomy, this answers the rendering. Same
     * convention as the layer hooks: always present, `stars: 0` meaning the
     * catalogue has not arrived rather than that the feature is missing.
     */
    sky: {
      layer: nightSky,
      dome: nightSky.dome.mesh,
      uniforms: nightSky.uniforms,
      stars: () => ({
        count: nightSky.starCount,
        loaded: nightSky.hasStars,
        source: nightSky.catalogueSource,
        fade: atmosphere.state.starFade,
      }),
      siderealDeg: () =>
        localApparentSiderealDeg(controlState.time.solarHour, sun.rightAscensionDeg),
      /** Where the discs actually are, read back off the uniforms. */
      drawn: () => ({
        sun: nightSky.uniforms.uSunDir.value.toArray(),
        sunIntensity: nightSky.uniforms.uSunDiscIntensity.value,
        moon: nightSky.uniforms.uMoonDir.value.toArray(),
        moonBrightness: nightSky.uniforms.uMoonBrightness.value,
        moonLit: nightSky.uniforms.uMoonLitFraction.value,
        starFade: nightSky.uniforms.uStarFade.value,
      }),
    },
    // Phase 4. Present (with `layer: null`) even when the site ships no water
    // assets, so a headless check can tell "feature off" from "not wired up".
    water: {
      layer: water,
      state: controlState.water,
      table: assets?.table ?? null,
      connect: assets?.connect ?? null,
      // Kept as an alias for the clock: the year is one number with one owner,
      // and this hook predates the time bar.
      setYear(yearCE: number) {
        controlState.time.yearCE = yearCE;
        applyTimeSettings();
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
    // Phase 12. Present (with `layer: null`) even when the site ships no §14
    // asset, so a headless check can tell "mode off" from "not wired up".
    reconstruction: {
      layer: reconstruction,
      state: controlState.reconstruction,
      file: reconstructionFile,
      get standing() {
        return reconstruction?.standingCount ?? 0;
      },
      get vertices() {
        return reconstruction?.vertexCount ?? 0;
      },
      get markers() {
        return sitesLayer?.shownCount ?? 0;
      },
      summary: (id: string) => reconstruction?.summary(id) ?? null,
      setEnabled(on: boolean) {
        controlState.reconstruction.show = on;
        applyReconstructionSettings();
      },
      // Phase 13 (§7.5): the fort interior's two states. `cleared` is the
      // default for every fort, always; `settlement` is refused outright where
      // the pipeline's gate did not offer it, and carries archetype H's caveat —
      // the strongest in the app (§9) — the first time it is switched on.
      get interior() {
        return reconstruction?.interiorSummary() ?? null;
      },
      setInteriorState(state: 'cleared' | 'settlement') {
        const applied = reconstruction?.setInteriorState(state) ?? 'cleared';
        if (applied === 'settlement') {
          hud.showCaveatOnce('reconstruction-settlement', 'conjecture', SETTLEMENT_CAVEAT);
        }
        // Archetype H going on or off moves records between drawn and marked.
        applyReconstructionSettings();
        return applied;
      },
      apply: applyReconstructionSettings,
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
      // v1.6 §13, for headless checks of the far field. `farLayer: null` with a
      // farField legend block means the wiring is broken; farField null means
      // the site simply ships no far field.
      farLayer: farVegetation,
      farTint,
      get farCount() {
        return farVegetation?.total ?? 0;
      },
      get farField() {
        return landcover?.legend.farField ?? null;
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
    // The kebab menu and its panels, drivable the same way — a headless check
    // should not have to synthesise pointer events to open them.
    menu: {
      open: () => menu.open(),
      close: () => menu.close(),
      get isOpen() {
        return menu.isOpen;
      },
    },
    about: {
      open: () => about.show(),
      close: () => about.hide(),
      get isOpen() {
        return about.open;
      },
    },
    cameraHelp: {
      open: () => cameraHelp.show(),
      close: () => cameraHelp.hide(),
      get isOpen() {
        return cameraHelp.open;
      },
    },
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
