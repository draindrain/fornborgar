/**
 * The sky ramp. Pure lookups only — no WebGL, no scene.
 *
 * The properties here are what keep a slider drag from flickering, and what keep
 * night dark without going black.
 */

import { describe, expect, it } from 'vitest';

import { createSkyState, skyStateAt } from '../src/sky/atmosphere';

const channels = (h: number): [number, number, number] => {
  const s = skyStateAt(h, createSkyState());
  return [s.sky.r, s.sky.g, s.sky.b];
};

describe('skyStateAt', () => {
  it('preserves the daytime look this app shipped with', () => {
    // '#8fa3b4' was the flat background before the sun moved, and Broborg's
    // summer noon sun reaches 53.9° — so the old daylight is the top of the ramp.
    const noon = skyStateAt(50, createSkyState());
    expect(noon.sky.getHexString()).toBe('8fa3b4');
    expect(noon.exposure).toBe(1);
    expect(noon.daylight).toBe(1);
  });

  it('is continuous — no visible step anywhere in a slider drag', () => {
    let previous = channels(-90);
    for (let h = -90; h <= 90; h += 0.1) {
      const next = channels(h);
      for (let c = 0; c < 3; c++) expect(Math.abs(next[c] - previous[c])).toBeLessThan(0.02);
      previous = next;
    }
  });

  it('never turns the sun back on below the horizon', () => {
    for (let h = -90; h <= -1; h += 0.25) {
      expect(skyStateAt(h, createSkyState()).sunIntensity).toBe(0);
    }
    expect(skyStateAt(0, createSkyState()).sunIntensity).toBeGreaterThan(0);
  });

  it('brightens monotonically as the sun climbs', () => {
    let sun = -Infinity;
    let hemi = -Infinity;
    let day = -Infinity;
    for (let h = -90; h <= 90; h += 0.5) {
      const s = skyStateAt(h, createSkyState());
      expect(s.sunIntensity).toBeGreaterThanOrEqual(sun - 1e-9);
      expect(s.hemiIntensity).toBeGreaterThanOrEqual(hemi - 1e-9);
      expect(s.daylight).toBeGreaterThanOrEqual(day - 1e-9);
      sun = s.sunIntensity;
      hemi = s.hemiIntensity;
      day = s.daylight;
    }
  });

  it('opens the simulated eye as the light goes, and never past 1 in daylight', () => {
    let previous = Infinity;
    for (let h = -90; h <= 90; h += 0.5) {
      const exposure = skyStateAt(h, createSkyState()).exposure;
      expect(exposure).toBeLessThanOrEqual(previous + 1e-9);
      previous = exposure;
    }
    expect(skyStateAt(6, createSkyState()).exposure).toBe(1);
    expect(skyStateAt(-90, createSkyState()).exposure).toBeGreaterThan(2);
  });

  it('keeps a floor under the night, so terrain still has a silhouette', () => {
    const night = skyStateAt(-90, createSkyState());
    expect(night.hemiIntensity).toBeGreaterThan(0);
    expect(night.daylight).toBeGreaterThan(0);
    // ...but genuinely dark: the sky is far below the daytime value.
    expect(night.sky.r).toBeLessThan(skyStateAt(50, createSkyState()).sky.r / 10);
  });

  it('runs warm through sunset and cool through twilight', () => {
    const sunset = skyStateAt(0, createSkyState());
    expect(sunset.sky.r).toBeGreaterThan(sunset.sky.b);
    const twilight = skyStateAt(-9, createSkyState());
    expect(twilight.sky.b).toBeGreaterThan(twilight.sky.r);
  });

  it('clamps beyond the ends rather than extrapolating into nonsense', () => {
    expect(channels(-200)).toEqual(channels(-90));
    expect(channels(200)).toEqual(channels(90));
  });

  it('is finite and in gamut everywhere', () => {
    for (let h = -90; h <= 90; h += 1) {
      const s = skyStateAt(h, createSkyState());
      for (const color of [s.sky, s.sunColor, s.hemiGround]) {
        for (const c of [color.r, color.g, color.b]) {
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
      expect(Number.isFinite(s.sunIntensity)).toBe(true);
      expect(Number.isFinite(s.exposure)).toBe(true);
    }
  });

  it('writes into the state it is given, so the per-tick path allocates nothing', () => {
    const state = createSkyState();
    expect(skyStateAt(20, state)).toBe(state);
  });
});
