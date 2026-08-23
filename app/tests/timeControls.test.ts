/**
 * The default control surface's two halves that can be tested in Node: the
 * formatters in ui/timeBar.ts, and the state factory + no-GUI seam in
 * ui/controls.ts (which is now the debug-only panel).
 */

import { describe, expect, it } from 'vitest';

import {
  addLandcoverControls,
  addPalisadeControls,
  addSitesControls,
  addWaterControls,
  createControlState,
  DEFAULT_DAY_OF_YEAR,
  DEFAULT_SOLAR_HOUR,
  DEFAULT_YEAR_CE,
} from '../src/ui/controls';
import { debugEnabled } from '../src/state/loader';
import { formatAltitude, formatSolarTime } from '../src/ui/timeBar';

describe('debugEnabled', () => {
  it('accepts the forms someone would actually type', () => {
    expect(debugEnabled('?debug')).toBe(true);
    expect(debugEnabled('?debug=1')).toBe(true);
    expect(debugEnabled('?debug=true')).toBe(true);
    expect(debugEnabled('?debug=TRUE')).toBe(true);
    expect(debugEnabled('?site=broborg&debug=1')).toBe(true);
  });

  it('is off by default and cannot be tripped by accident', () => {
    expect(debugEnabled('')).toBe(false);
    expect(debugEnabled('?site=broborg')).toBe(false);
    expect(debugEnabled('?debug=0')).toBe(false);
    expect(debugEnabled('?debug=no')).toBe(false);
    expect(debugEnabled('?debugx=1')).toBe(false);
  });
});

describe('createControlState', () => {
  it('opens with the model and conjecture layers on, so the scene means something', () => {
    const state = createControlState({ debug: false });
    expect(state.water.show).toBe(true);
    expect(state.palisade.show).toBe(true);
    expect(state.landcover.show).toBe(true);
  });

  it('restores the pre-redesign opt-in defaults under ?debug=1', () => {
    // Debug mode is meant to be a faithful copy of the old app — the headless
    // verifiers assert that the far field is lazy until first enable, and that
    // only holds if the layer starts off.
    const state = createControlState({ debug: true });
    expect(state.water.show).toBe(false);
    expect(state.palisade.show).toBe(false);
    expect(state.landcover.show).toBe(false);
  });

  it('starts the clock mid-fort-era at a raking evening sun', () => {
    const state = createControlState({ debug: false });
    expect(state.time.yearCE).toBe(DEFAULT_YEAR_CE);
    expect(state.time.dayOfYear).toBe(DEFAULT_DAY_OF_YEAR);
    expect(state.time.solarHour).toBe(DEFAULT_SOLAR_HOUR);
    expect(state.water.yearCE).toBe(state.time.yearCE);
  });

  it('leaves the manual sun override off — the time sliders drive the sun', () => {
    expect(createControlState({ debug: true }).sunManual).toBe(false);
  });

  it('does not share state between calls', () => {
    const a = createControlState({ debug: false });
    const b = createControlState({ debug: false });
    a.time.yearCE = 900;
    expect(b.time.yearCE).toBe(DEFAULT_YEAR_CE);
  });
});

describe('the no-GUI seam', () => {
  it('hands back a working no-op readout when there is no debug panel', () => {
    // main.ts calls these unconditionally and then `?.update()` from its apply
    // funnels, so a null GUI has to produce something callable, not a throw.
    const state = createControlState({ debug: false });
    const readouts = [
      addWaterControls(null, state, {
        name: 'Paleo-shoreline', years: [-1050, 1150], uncertainty: '±500 yr',
        levelAt: () => 0, onChange: () => {},
      }),
      addSitesControls(null, state, { name: 'Sites', count: 3, onChange: () => {} }),
      addPalisadeControls(null, state, { caveat: 'conjecture', postCount: () => 0, onChange: () => {} }),
      addLandcoverControls(null, state, {
        name: 'Landscape', referenceYearCE: 500, classCount: 10, caveat: 'model',
        instanceCount: () => 0, onChange: () => {},
      }),
    ];
    for (const readout of readouts) expect(() => readout.update()).not.toThrow();
  });
});

describe('formatSolarTime', () => {
  it('reads as a clock', () => {
    expect(formatSolarTime(0)).toBe('00:00');
    expect(formatSolarTime(12)).toBe('12:00');
    expect(formatSolarTime(13.75)).toBe('13:45');
    expect(formatSolarTime(18.5)).toBe('18:30');
    expect(formatSolarTime(2.5725)).toBe('02:34');
    expect(formatSolarTime(21.4275)).toBe('21:26');
  });

  it('wraps at both ends of the day rather than printing 24:00 or a negative', () => {
    expect(formatSolarTime(24)).toBe('00:00');
    expect(formatSolarTime(24.5)).toBe('00:30');
    expect(formatSolarTime(-0.5)).toBe('23:30');
  });

  it('never prints 60 minutes', () => {
    for (let h = 0; h < 24; h += 1 / 600) expect(formatSolarTime(h)).not.toMatch(/:60$/);
  });
});

describe('formatAltitude', () => {
  it('says which side of the horizon the sun is on', () => {
    expect(formatAltitude(16.63)).toBe('sun 17° above the horizon');
    expect(formatAltitude(-6.63)).toBe('sun 7° below the horizon');
    expect(formatAltitude(0)).toBe('sun 0° above the horizon');
  });
});
