/**
 * Phase-1 control surface (lil-gui, per PLAN §4.8).
 *
 * Three controls, all of them about legibility: where the sun is, how low it is,
 * and how much the relief is exaggerated.
 */

import GUI from 'lil-gui';
import { DEFAULT_SUN_AZIMUTH, DEFAULT_SUN_ELEVATION } from '../terrain/lighting';

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
