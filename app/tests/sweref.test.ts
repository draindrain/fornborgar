/**
 * The one piece of projection math the browser is allowed to do: SWEREF 99 TM
 * -> WGS84, for the solar position (lib/sweref.ts explains why it is an
 * exception to the rule in lib/coords.ts).
 *
 * The pins matter more than usual because the failure mode is silent: swapping
 * the starred (inverse) footpoint coefficients for the unstarred forward ones
 * still produces a plausible Swedish latitude, about 60 m off.
 */

import { describe, expect, it } from 'vitest';

import { enFromLocal } from '../src/lib/coords';
import { siteLatLon, wgs84FromSweref99tm } from '../src/lib/sweref';
import type { SiteManifest } from '../src/state/manifest';

describe('wgs84FromSweref99tm', () => {
  it("places Broborg's origin in Husby-Långhundra, Uppland", () => {
    const { latDeg, lonDeg } = wgs84FromSweref99tm(665810, 6627880);
    expect(latDeg).toBeCloseTo(59.755562412, 5);
    expect(lonDeg).toBeCloseTo(17.951595670, 5);
  });

  it('is exact on the central meridian at the equator (the projection origin)', () => {
    const { latDeg, lonDeg } = wgs84FromSweref99tm(500000, 0);
    expect(latDeg).toBeCloseTo(0, 9);
    expect(lonDeg).toBeCloseTo(15, 9);
  });

  it('keeps the central meridian at 15° all the way up the country', () => {
    // η = 0 exactly: exercises the sinh/atan branch and catches a sign slip in
    // the δ series, which would otherwise only show as a small easting error.
    const { latDeg, lonDeg } = wgs84FromSweref99tm(500000, 6650000);
    expect(latDeg).toBeCloseTo(59.987328540, 8);
    expect(lonDeg).toBeCloseTo(15, 9);
  });

  it('holds several degrees either side of the central meridian', () => {
    const gotland = wgs84FromSweref99tm(700000, 6380000);
    expect(gotland.latDeg).toBeCloseTo(57.518280199, 7);
    expect(gotland.lonDeg).toBeCloseTo(18.339648446, 7);

    const westCoast = wgs84FromSweref99tm(319000, 6399000);
    expect(westCoast.latDeg).toBeCloseTo(57.696701229, 7);
    expect(westCoast.lonDeg).toBeCloseTo(11.962893498, 7);
  });

  it('is monotone: north raises the latitude, east raises the longitude', () => {
    const base = wgs84FromSweref99tm(665810, 6627880);
    expect(wgs84FromSweref99tm(665810, 6637880).latDeg).toBeGreaterThan(base.latDeg);
    expect(wgs84FromSweref99tm(675810, 6627880).lonDeg).toBeGreaterThan(base.lonDeg);
  });

  it('agrees with the scene-local coordinate helper, convergence and all', () => {
    // A point 1 km grid-north of Broborg's origin, routed through the app's own
    // local -> E/N converter. Latitude gains the expected ~0.009°.
    const origin = { e: 665810, n: 6627880 };
    const here = wgs84FromSweref99tm(origin.e, origin.n);
    const north = enFromLocal(0, -1000, origin);
    const there = wgs84FromSweref99tm(north.e, north.n);
    expect(there.latDeg - here.latDeg).toBeCloseTo(0.00899, 4);

    // Longitude moves too, and it should: grid north is not true north away from
    // the central meridian. The offset must match the meridian convergence,
    // γ ≈ atan(tan Δλ · sin φ) ≈ 2.549° here — about 44 m sideways per km.
    const DEG = Math.PI / 180;
    const gamma = Math.atan(Math.tan((here.lonDeg - 15) * DEG) * Math.sin(here.latDeg * DEG));
    const expected = (1000 * Math.tan(gamma)) / (111320 * Math.cos(here.latDeg * DEG));
    expect(Math.abs(there.lonDeg - here.lonDeg)).toBeCloseTo(Math.abs(expected), 5);
  });
});

describe('siteLatLon', () => {
  const manifest = (site: Record<string, unknown>): SiteManifest =>
    ({ site, origin: { e: 665810, n: 6627880 } }) as unknown as SiteManifest;

  it('derives from the origin when the manifest declares nothing', () => {
    expect(siteLatLon(manifest({ id: 'broborg' })).latDeg).toBeCloseTo(59.755562, 5);
  });

  it('prefers a declared site.latLon, so the pipeline can start shipping one', () => {
    const declared = siteLatLon(manifest({ id: 'x', latLon: { latDeg: 63.5, lonDeg: 20.1 } }));
    expect(declared).toEqual({ latDeg: 63.5, lonDeg: 20.1 });
  });

  it('ignores a malformed declaration rather than trusting it', () => {
    const bad = siteLatLon(manifest({ id: 'x', latLon: { latDeg: 'north', lonDeg: 20.1 } }));
    expect(bad.latDeg).toBeCloseTo(59.755562, 5);
  });
});
