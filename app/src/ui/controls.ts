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
}

export interface ControlHandlers {
  onSunChange(azimuth: number, elevation: number): void;
  onExaggerationChange(value: number): void;
}

export function createControls(parent: HTMLElement, handlers: ControlHandlers): { gui: GUI; state: ControlState } {
  const state: ControlState = {
    sunAzimuth: DEFAULT_SUN_AZIMUTH,
    sunElevation: DEFAULT_SUN_ELEVATION,
    exaggeration: DEFAULT_EXAGGERATION,
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

  return { gui, state };
}
