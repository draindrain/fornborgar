/**
 * Control surface (lil-gui, per PLAN §4.8).
 *
 * Phase 1: where the sun is, how low it is, how much the relief is exaggerated.
 * Phase 3: the viewshed parameters, stated plainly.
 * Phase 4: the paleo-shoreline slider — added lazily by `addWaterControls`,
 * because the feature only exists for sites that ship the §6/§7 assets, and
 * because PLAN §6.1 requires a model layer to be labelled as a model with its
 * uncertainty next to the control.
 * Phase 5: the conjectural palisade's appearance parameters — added lazily by
 * `addPalisadeControls`, for sites that ship a rampart crest (contract §8).
 * Phase 7: the modeled landscape — added lazily by `addLandcoverControls`, for
 * sites that ship the §9/§10 land-cover pair. Its appearance parameters (seed,
 * global density scale) are app-side UI state with defaults, not data (§9).
 *
 * **This whole panel is now the DEBUG surface, behind `?debug=1`** (see
 * `debugEnabled` in state/loader.ts). What a visitor gets instead is ui/timeBar.ts:
 * three sliders, no seeds. Two consequences shape the code below.
 *
 *   1. `ControlState` outlives the panel. `createControlState()` builds it
 *      unconditionally; `main.ts` reads and writes it whether or not a GUI ever
 *      existed, and `window.__app.*.state` still points at the same object.
 *   2. Every `addXControls` takes `gui: GUI | null` and returns a no-op readout
 *      when it is null, so all five call sites in `main.ts` are unchanged.
 *
 * The Sun folder is now an *override*: the sliders normally follow the time bar,
 * and `sunManual` freezes them at hand-set values — the pre-astronomy behaviour,
 * kept because a hand-picked raking light is what the screenshots want.
 */

import GUI from 'lil-gui';
import { DEFAULT_VEGETATION_PARAMS } from '../landcover/vegetation';
import { DEFAULT_PALISADE_PARAMS } from '../overlays/palisade';
import { DEFAULT_SUN_AZIMUTH, DEFAULT_SUN_ELEVATION } from '../terrain/lighting';
import { formatLevel, formatYear } from '../water/shoreline';

export const DEFAULT_EXAGGERATION = 1.5;

/** The three sliders the default UI exposes (ui/timeBar.ts). */
export interface TimeState {
  /**
   * Signed astronomical year — *the* app clock. The water level, the period
   * label and the sun's obliquity all read it. It is mirrored into
   * `water.yearCE`, not replacing it; see the note there.
   */
  yearCE: number;
  /** 1-based day of the year; the season. */
  dayOfYear: number;
  /** Local apparent solar time, hours. 12 = sun on the meridian. */
  solarHour: number;
}

/** Day 173 ≈ the June solstice; 18:30 solar time is a raking evening sun. */
export const DEFAULT_DAY_OF_YEAR = 173;
export const DEFAULT_SOLAR_HOUR = 18.5;
/** Mid-fort-era rather than an endpoint; was `initialYear` at the call site. */
export const DEFAULT_YEAR_CE = 400;

export interface ControlState {
  sunAzimuth: number;
  sunElevation: number;
  /**
   * Debug override: freeze the sun at `sunAzimuth`/`sunElevation` instead of
   * computing it from `time`. Off by default, and unreachable without `?debug=1`.
   */
  sunManual: boolean;
  time: TimeState;
  exaggeration: number;
  viewshed: {
    show: boolean;
    observerHeight: number;
    targetHeight: number;
    maxRadius: number;
    curvature: boolean;
  };
  water: {
    show: boolean;
    /**
     * Signed calendar year, mirrored from `time.yearCE` on every change.
     *
     * The two are one number with one owner — the time bar writes the clock and
     * `applyTimeSettings` copies it here. It is kept as a separate field, rather
     * than the water funnel reading `time` directly, because `window.__app.water.state`
     * is a published hook that headless drivers already read and write.
     */
    yearCE: number;
  };
  sites: {
    show: boolean;
  };
  /** Phase 5 — appearance parameters of the conjectural palisade (contract §8). */
  palisade: {
    show: boolean;
    heightM: number;
    spacingM: number;
    seed: number;
  };
  /** Phase 7 — appearance parameters of the modeled landscape (contract §9). */
  landcover: {
    show: boolean;
    /** Placement/jitter seed. Same seed ⇒ same landscape. */
    seed: number;
    /** Global multiplier on the legend's `densityPerHa` — never per class (§10). */
    density: number;
  };
}

export interface ControlOptions {
  /**
   * Debug mode restores the pre-redesign opt-in defaults for every model and
   * conjecture layer. Without it they start on — the scene is supposed to mean
   * something before anyone touches a control.
   */
  debug: boolean;
}

/**
 * The mutable state object, built whether or not a GUI is ever created.
 *
 * Layer defaults are mode-dependent, which is the one rule that makes `?debug=1`
 * a faithful copy of the old app: model and conjecture layers were opt-in
 * (PLAN §6.1), and the headless verifiers assert on that. Outside debug the owner
 * decision is that water, palisade and vegetation are simply on.
 */
export function createControlState(options: ControlOptions): ControlState {
  const optIn = !options.debug;
  return {
    sunAzimuth: DEFAULT_SUN_AZIMUTH,
    sunElevation: DEFAULT_SUN_ELEVATION,
    sunManual: false,
    time: {
      yearCE: DEFAULT_YEAR_CE,
      dayOfYear: DEFAULT_DAY_OF_YEAR,
      solarHour: DEFAULT_SOLAR_HOUR,
    },
    exaggeration: DEFAULT_EXAGGERATION,
    viewshed: {
      show: false,
      observerHeight: 1.7,
      targetHeight: 0,
      maxRadius: 0,
      curvature: true,
    },
    water: {
      show: optIn,
      yearCE: DEFAULT_YEAR_CE,
    },
    sites: {
      show: true,
    },
    palisade: {
      show: optIn,
      heightM: DEFAULT_PALISADE_PARAMS.heightM,
      spacingM: DEFAULT_PALISADE_PARAMS.spacingM,
      seed: DEFAULT_PALISADE_PARAMS.seed,
    },
    landcover: {
      show: optIn,
      seed: DEFAULT_VEGETATION_PARAMS.seed,
      density: DEFAULT_VEGETATION_PARAMS.densityScale,
    },
  };
}

/** Returned by every `addXControls` when there is no GUI to add to. */
const NO_READOUT: { update(): void } = { update: () => {} };

export interface ControlHandlers {
  onSunChange(azimuth: number, elevation: number): void;
  onExaggerationChange(value: number): void;
  /** Phase 2: orbit <-> first-person toggle (also bound to the F key). */
  onToggleFirstPerson(): void;
  /** Phase 3: any viewshed setting (incl. show) changed; read them from state. */
  onViewshedChange(): void;
}

/**
 * Build the debug panel over an existing `state`. Only called in debug mode;
 * `main.ts` owns the state either way.
 */
export function createControls(
  parent: HTMLElement,
  state: ControlState,
  handlers: ControlHandlers,
): { gui: GUI; sun: { update(): void } } {
  const host = document.createElement('div');
  host.className = 'control-panel';
  parent.append(host);

  // lil-gui positions itself only in `autoPlace` mode; giving it our own
  // positioned host keeps the layout in style.css and out of a specificity fight.
  const gui = new GUI({ container: host, title: 'View', width: 260 });

  // The sun normally follows the time bar. This folder overrides it: tick
  // `manual sun` and the two sliders below are the sun, at the pre-astronomy
  // intensity curve (`legibilityIntensity`), which is what a hillshade-style
  // screenshot wants. Untick it and the astronomy takes over again.
  const sun = gui.addFolder('Sun (manual override)');
  const sunChanged = (): void => handlers.onSunChange(state.sunAzimuth, state.sunElevation);
  const manual = sun.add(state, 'sunManual').name('manual sun (ignore time)').onChange(sunChanged);
  const azimuth = sun.add(state, 'sunAzimuth', 0, 360, 1).name('azimuth (°)').onChange(sunChanged);
  const elevation = sun
    .add(state, 'sunElevation', -20, 70, 1)
    .name('elevation (°)')
    .onChange(sunChanged);
  const sunReadout = note(sun, 'control-readout', '');
  note(sun, 'control-note', 'Unticked, the sun comes from the site latitude and the three time sliders.');
  const sunControls = {
    update(): void {
      for (const control of [manual, azimuth, elevation]) control.updateDisplay();
      sunReadout.textContent =
        `${state.sunElevation.toFixed(1)}° above horizon · ${state.sunAzimuth.toFixed(1)}° ` +
        `${state.sunManual ? '(manual)' : '(computed)'}`;
    },
  };

  gui
    .add(state, 'exaggeration', 1.0, 2.5, 0.05)
    .name('vertical ×')
    .onChange(() => handlers.onExaggerationChange(state.exaggeration));

  gui.add({ firstPerson: () => handlers.onToggleFirstPerson() }, 'firstPerson').name('first person (F)');

  // Phase 3 — viewshed (XDraw in a worker; PLAN §4.4). The panel states the
  // algorithm parameters plainly, per the honesty rules (PLAN §6.1).
  const vs = gui.addFolder('Viewshed');
  const changed = (): void => handlers.onViewshedChange();
  vs.add(state.viewshed, 'show').name('show (drag the marker)').onChange(changed);
  vs.add(state.viewshed, 'observerHeight', 0.5, 20, 0.1).name('observer height (m)').onChange(changed);
  vs.add(state.viewshed, 'targetHeight', 0, 5, 0.1).name('target height (m)').onChange(changed);
  vs.add(state.viewshed, 'maxRadius', 0, 3000, 50).name('radius (m, 0 = ∞)').onChange(changed);
  vs.add(state.viewshed, 'curvature').name('curvature + refraction (k = 0.13)').onChange(changed);
  vs.close();

  // Phase 6, mobile degradation: on a narrow viewport the panel starts folded
  // so the scene is not born half-covered; everything stays reachable.
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches) {
    gui.close();
  }

  sunControls.update();
  return { gui, sun: sunControls };
}

export interface WaterControlOptions {
  /** Layer name from `manifest.layers` (falls back to a generic label). */
  name: string;
  /** [oldest, newest] yearCE — the slider spans exactly the table's extent. */
  years: [number, number];
  /** `shoreline.json.uncertainty`, shown verbatim next to the control. */
  uncertainty: string;
  levelAt(yearCE: number): number;
  onChange(): void;
}

/**
 * A static, non-interactive line inside a lil-gui folder.
 *
 * The child container is `.lil-children` in lil-gui 0.21 (`.children` in older
 * builds); matching both matters, because anything appended to the folder root
 * instead stays visible when the folder is collapsed.
 */
function note(folder: GUI, className: string, text: string): HTMLElement {
  const host = folder.domElement.querySelector('.lil-children, .children') ?? folder.domElement;
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  host.append(div);
  return div;
}

/**
 * PLAN §6.1: a model layer's control has to say "model". The layer name from the
 * manifest usually already does ("Paleo-shoreline (SGU model)", "Modeled landscape
 * (rule-based)"), so the tag is only appended when the name does not say it itself.
 */
export function modelTitle(name: string): string {
  return /model/i.test(name) ? name : `${name} — model`;
}

/**
 * Phase-4 paleo-shoreline folder (PLAN §3 Phase 4, §4.5, §6.1).
 *
 * Only created for sites that actually ship the water assets — a site without
 * them shows no water UI at all. The folder is labelled a model, states its
 * uncertainty next to the slider, and the readout carries **both** the calendar
 * year and the level in meters above present sea.
 */
export function addWaterControls(
  gui: GUI | null,
  state: ControlState,
  options: WaterControlOptions,
): { update(): void } {
  if (!gui) return NO_READOUT;
  const [oldest, newest] = options.years;

  const folder = gui.addFolder(modelTitle(options.name));
  const show = folder.add(state.water, 'show').name('show water').onChange(() => options.onChange());
  // Same number the time bar's year slider writes — this one is the debug
  // mirror of it, so both widgets stay in sync through `update()`.
  const year = folder
    .add(state.water, 'yearCE', oldest, newest, 1)
    .name('year (scrub)')
    .onChange(() => options.onChange());

  const readout = note(folder, 'control-readout', '');
  note(folder, 'control-note', options.uncertainty);

  const update = (): void => {
    // The dev hooks and the F-key-style shortcuts write straight to `state`, so
    // push the widgets back in sync before rendering the readout.
    show.updateDisplay();
    year.updateDisplay();
    readout.textContent = `${formatYear(state.water.yearCE)} · ${formatLevel(options.levelAt(state.water.yearCE))}`;
  };
  update();
  folder.open();

  return { update };
}

export interface SitesControlOptions {
  /** Layer name from `manifest.layers` (falls back to a generic label). */
  name: string;
  count: number;
  onChange(): void;
}

/**
 * Phase-5 registered-sites folder. Only created for sites that ship
 * `assets.sites`. Registry data is "measured" (PLAN §6.1) — no caveat needed,
 * but the source is named right on the control.
 */
export function addSitesControls(
  gui: GUI | null,
  state: ControlState,
  options: SitesControlOptions,
): { update(): void } {
  if (!gui) return NO_READOUT;
  const folder = gui.addFolder(options.name);
  const show = folder
    .add(state.sites, 'show')
    .name(`show markers (${options.count})`)
    .onChange(() => options.onChange());
  note(folder, 'control-note', 'Kulturmiljöregistret (RAÄ). Click a marker for details and its Fornsök link.');
  folder.open();

  return {
    update(): void {
      show.updateDisplay();
    },
  };
}

export interface PalisadeControlOptions {
  /** The one-line caveat shown permanently under the controls (PLAN §6.1). */
  caveat: string;
  /** Post count for the readout, read after every change. */
  postCount(): number;
  onChange(): void;
}

/**
 * Phase-5 palisade folder (PLAN §4.6.3, §6.1).
 *
 * Only created for sites that ship `assets.rampart`. The title shouts CONJECTURAL,
 * the caveat sits permanently under the sliders, and every control is an *appearance*
 * parameter — the contract keeps them out of the data on purpose (§8), because
 * nothing about the posts is measured.
 */
export function addPalisadeControls(
  gui: GUI | null,
  state: ControlState,
  options: PalisadeControlOptions,
): { update(): void } {
  if (!gui) return NO_READOUT;
  const folder = gui.addFolder('Palisade (CONJECTURAL)');
  const changed = (): void => options.onChange();

  const show = folder.add(state.palisade, 'show').name('show palisade').onChange(changed);
  const height = folder.add(state.palisade, 'heightM', 1, 5, 0.1).name('post height (m)').onChange(changed);
  const spacing = folder.add(state.palisade, 'spacingM', 0.3, 2, 0.05).name('spacing (m)').onChange(changed);
  const seed = folder.add(state.palisade, 'seed', 1, 999, 1).name('jitter seed').onChange(changed);

  const readout = note(folder, 'control-readout', '');
  note(folder, 'control-note', options.caveat);

  const update = (): void => {
    for (const control of [show, height, spacing, seed]) control.updateDisplay();
    readout.textContent = `${options.postCount()} posts · ${state.palisade.spacingM.toFixed(2)} m apart`;
  };
  update();
  folder.close();

  return { update };
}

export interface LandcoverControlOptions {
  /** Layer name from `manifest.layers` (falls back to a generic label). */
  name: string;
  /** The century the raster models (§10 `referenceYearCE`). */
  referenceYearCE: number;
  /** Number of classes in the legend. */
  classCount: number;
  /** `landcover_legend.json.caveat`, shown verbatim next to the control. */
  caveat: string;
  /**
   * v1.3 (§10): does the legend mark any class `dynamic`? Those classes are derived
   * at the century the slider shows, so the permanent note must not claim the whole
   * layer is frozen at the reference year.
   */
  hasDynamicClasses?: boolean;
  /** Vegetation instances **visible** at the current level, read after every change. */
  instanceCount(): number;
  onChange(): void;
}

/**
 * Phase-7 modeled-landscape folder (PLAN §4.7, §6.1; contract §9).
 *
 * Only created for sites that ship the §9/§10 pair. The folder is labelled a model,
 * the legend's own caveat sits permanently under the sliders, and the readout states
 * the **reference century** — the raster answers "what might the landscape have
 * looked like around then?" and nothing else, so the number belongs next to the
 * control as much as in the methods panel (§10).
 *
 * Both sliders are *appearance* parameters: the density one scales every class
 * together, never one class at a time (§10).
 */
export function addLandcoverControls(
  gui: GUI | null,
  state: ControlState,
  options: LandcoverControlOptions,
): { update(): void } {
  if (!gui) return NO_READOUT;
  const folder = gui.addFolder(modelTitle(options.name));
  const changed = (): void => options.onChange();

  const show = folder.add(state.landcover, 'show').name('show landscape').onChange(changed);
  const density = folder.add(state.landcover, 'density', 0.25, 1.5, 0.05).name('density ×').onChange(changed);
  const seed = folder.add(state.landcover, 'seed', 1, 999, 1).name('layout seed').onChange(changed);

  const readout = note(folder, 'control-readout', '');
  // Which century this layer speaks for, stated permanently — and since v1.3 that
  // answer is split: the soil-derived classes are frozen at the reference year, the
  // two hydrological ones follow the shoreline slider (contract §9/§10).
  const scope = options.hasDynamicClasses
    ? `Soil-derived classes modelled for ${formatYear(options.referenceYearCE)}; open water and the shore reed ` +
      'belt follow the shoreline slider.'
    : `Modelled for ${formatYear(options.referenceYearCE)} only.`;
  note(folder, 'control-note', `${options.caveat} ${scope}`);

  const update = (): void => {
    for (const control of [show, density, seed]) control.updateDisplay();
    readout.textContent =
      `${formatYear(options.referenceYearCE)} · ${options.classCount} classes · ` +
      `${options.instanceCount().toLocaleString('en-US')} plants visible`;
  };
  update();
  folder.close();

  return { update };
}
