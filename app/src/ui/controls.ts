/**
 * Control surface (lil-gui, per PLAN §4.8).
 *
 * Phase 1: where the sun is, how low it is, how much the relief is exaggerated.
 * Phase 3: the viewshed parameters, stated plainly.
 * Phase 4: the paleo-shoreline slider — added lazily by `addWaterControls`,
 * because the feature only exists for sites that ship the §6/§7 assets, and
 * because PLAN §6.1 requires a model layer to be labelled as a model with its
 * uncertainty next to the control.
 */

import GUI from 'lil-gui';
import { DEFAULT_SUN_AZIMUTH, DEFAULT_SUN_ELEVATION } from '../terrain/lighting';
import { formatLevel, formatYear } from '../water/shoreline';

export const DEFAULT_EXAGGERATION = 1.5;

export interface ControlState {
  sunAzimuth: number;
  sunElevation: number;
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
    /** Signed calendar year; meaningful only once the water folder exists. */
    yearCE: number;
  };
  sites: {
    show: boolean;
  };
}

export interface ControlHandlers {
  onSunChange(azimuth: number, elevation: number): void;
  onExaggerationChange(value: number): void;
  /** Phase 2: orbit <-> first-person toggle (also bound to the F key). */
  onToggleFirstPerson(): void;
  /** Phase 3: any viewshed setting (incl. show) changed; read them from state. */
  onViewshedChange(): void;
}

export function createControls(parent: HTMLElement, handlers: ControlHandlers): { gui: GUI; state: ControlState } {
  const state: ControlState = {
    sunAzimuth: DEFAULT_SUN_AZIMUTH,
    sunElevation: DEFAULT_SUN_ELEVATION,
    exaggeration: DEFAULT_EXAGGERATION,
    viewshed: {
      show: false,
      observerHeight: 1.7,
      targetHeight: 0,
      maxRadius: 0,
      curvature: true,
    },
    water: {
      show: false,
      yearCE: 0,
    },
    sites: {
      show: true,
    },
  };

  const host = document.createElement('div');
  host.className = 'control-panel';
  parent.append(host);

  // lil-gui positions itself only in `autoPlace` mode; giving it our own
  // positioned host keeps the layout in style.css and out of a specificity fight.
  const gui = new GUI({ container: host, title: 'View', width: 260 });

  const sun = gui.addFolder('Sun');
  sun
    .add(state, 'sunAzimuth', 0, 360, 1)
    .name('azimuth (°)')
    .onChange(() => handlers.onSunChange(state.sunAzimuth, state.sunElevation));
  sun
    .add(state, 'sunElevation', 5, 60, 1)
    .name('elevation (°)')
    .onChange(() => handlers.onSunChange(state.sunAzimuth, state.sunElevation));

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

  return { gui, state };
}

export interface WaterControlOptions {
  /** Layer name from `manifest.layers` (falls back to a generic label). */
  name: string;
  /** [oldest, newest] yearCE — the slider spans exactly the table's extent. */
  years: [number, number];
  /** `shoreline.json.uncertainty`, shown verbatim next to the control. */
  uncertainty: string;
  /** Where the slider starts; clamped into `years`. */
  initialYear: number;
  levelAt(yearCE: number): number;
  onChange(): void;
}

/** A static, non-interactive line inside a lil-gui folder. */
function note(folder: GUI, className: string, text: string): HTMLElement {
  const host = folder.domElement.querySelector('.children') ?? folder.domElement;
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  host.append(div);
  return div;
}

/**
 * Phase-4 paleo-shoreline folder (PLAN §3 Phase 4, §4.5, §6.1).
 *
 * Only created for sites that actually ship the water assets — a site without
 * them shows no water UI at all. The folder is labelled a model, states its
 * uncertainty next to the slider, and the readout carries **both** the calendar
 * year and the level in meters above present sea.
 */
export function addWaterControls(gui: GUI, state: ControlState, options: WaterControlOptions): { update(): void } {
  const [oldest, newest] = options.years;
  state.water.yearCE = Math.min(newest, Math.max(oldest, options.initialYear));

  // PLAN §6.1: the control itself has to say "model". The layer name usually
  // already does ("Paleo-shoreline (SGU model)"), so only add the tag when it does not.
  const title = /\bmodel\b/i.test(options.name) ? options.name : `${options.name} — model`;
  const folder = gui.addFolder(title);
  const show = folder.add(state.water, 'show').name('show water').onChange(() => options.onChange());
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
export function addSitesControls(gui: GUI, state: ControlState, options: SitesControlOptions): { update(): void } {
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
