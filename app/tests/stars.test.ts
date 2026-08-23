/**
 * The star catalogue (sky/stars.ts) — the committed asset, its decoder, and the
 * reflection map baked from it.
 *
 * The asset itself is checked here, not just the code that reads it: it is
 * 80 kB of binary in the repo, and the only thing standing between a corrupt
 * rebuild and a wrong sky is a test that knows where Sirius is.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bakeStarMap,
  decodeStarCatalogue,
  relativeFlux,
  starColor,
  starDirectionsAtEpoch,
  type StarCatalogue,
  type StarCatalogueHeader,
} from '../src/sky/stars';
import { equatorialFromDirection } from '../src/sky/precession';
import { julianDay } from '../src/sky/solar';

const SKY_DIR = resolve(__dirname, '..', 'public', 'data', 'sky');

function loadCommittedCatalogue(): StarCatalogue {
  const header = JSON.parse(readFileSync(resolve(SKY_DIR, 'stars-v6.json'), 'utf8')) as StarCatalogueHeader;
  const bytes = readFileSync(resolve(SKY_DIR, header.binary));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return decodeStarCatalogue(header, buffer as ArrayBuffer);
}

const catalogue = loadCommittedCatalogue();

describe('the committed catalogue', () => {
  it('is the naked-eye sky', () => {
    expect(catalogue.count).toBe(5044);
    expect(catalogue.limitingMagnitude).toBe(6);
    for (let i = 0; i < catalogue.count; i++) {
      expect(catalogue.mag[i]).toBeLessThanOrEqual(6.0001);
      expect(catalogue.ra[i]).toBeGreaterThanOrEqual(0);
      expect(catalogue.ra[i]).toBeLessThan(360);
      expect(Math.abs(catalogue.dec[i])).toBeLessThanOrEqual(90);
    }
  });

  it('declares that it carries no proper motions', () => {
    // The methods panel's honesty text is keyed on this being false; if a later
    // catalogue starts shipping them, this test is the reminder to say so.
    expect(catalogue.source.properMotions).toBe(false);
    expect(catalogue.source.catalogue).toMatch(/XHIP/);
  });

  it('has Sirius, at its J2000 position, as the brightest star', () => {
    let brightest = 0;
    for (let i = 1; i < catalogue.count; i++) {
      if (catalogue.mag[i] < catalogue.mag[brightest]) brightest = i;
    }
    expect(catalogue.hip[brightest]).toBe(32349);
    expect(catalogue.mag[brightest]).toBeCloseTo(-1.44, 2);
    expect(catalogue.ra[brightest]).toBeCloseTo(101.2872, 3);
    expect(catalogue.dec[brightest]).toBeCloseTo(-16.7161, 3);
  });

  it('has Vega, Arcturus and Betelgeuse where they belong', () => {
    const find = (hip: number) => {
      const i = catalogue.hip.indexOf(hip);
      expect(i).toBeGreaterThanOrEqual(0);
      return { ra: catalogue.ra[i], dec: catalogue.dec[i], mag: catalogue.mag[i], bv: catalogue.bv[i] };
    };
    const vega = find(91262);
    expect(vega.ra).toBeCloseTo(279.234, 2);
    expect(vega.dec).toBeCloseTo(38.784, 2);
    expect(vega.mag).toBeCloseTo(0.03, 1);

    const arcturus = find(69673);
    expect(arcturus.ra).toBeCloseTo(213.915, 2);
    expect(arcturus.dec).toBeCloseTo(19.182, 2);

    const betelgeuse = find(27989);
    // An M-type supergiant, and much the reddest of the three. (XHIP gives it
    // B−V 1.50; the 1.85 usually quoted is a different reduction of a star that
    // is genuinely variable.)
    expect(betelgeuse.bv).toBeGreaterThan(1.4);
    expect(betelgeuse.bv).toBeGreaterThan(vega.bv + 1);
  });

  it('spans both hemispheres', () => {
    let north = 0;
    for (let i = 0; i < catalogue.count; i++) if (catalogue.dec[i] > 0) north += 1;
    expect(north).toBeGreaterThan(catalogue.count * 0.35);
    expect(north).toBeLessThan(catalogue.count * 0.65);
  });
});

describe('the decoder', () => {
  const header: StarCatalogueHeader = {
    version: 1,
    count: 2,
    limitingMagnitude: 6,
    epoch: 'J2000',
    frame: 'equatorial',
    columns: [
      { name: 'ra', type: 'float32' },
      { name: 'dec', type: 'float32' },
      { name: 'hip', type: 'int32' },
      { name: 'mag', type: 'int16', scale: 0.01 },
      { name: 'bv', type: 'int16', scale: 0.001 },
    ],
    binary: 'x.bin',
    source: { catalogue: 'test', properMotions: false },
  };

  function build(extra: { name: string; type: string; scale?: number }[] = [], extraBytes = 0) {
    const size = 2 * 4 + 2 * 4 + 2 * 4 + 2 * 2 + 2 * 2 + extraBytes;
    const buffer = new ArrayBuffer(size);
    new Float32Array(buffer, 0, 2).set([10, 350]);
    new Float32Array(buffer, 8, 2).set([-20, 80]);
    new Int32Array(buffer, 16, 2).set([1, 2]);
    new Int16Array(buffer, 24, 2).set([-144, 599]);
    new Int16Array(buffer, 28, 2).set([0, 1500]);
    return { header: { ...header, columns: [...header.columns, ...extra] }, buffer };
  }

  it('applies the declared scales', () => {
    const { header: h, buffer } = build();
    const decoded = decodeStarCatalogue(h, buffer);
    expect(decoded.mag[0]).toBeCloseTo(-1.44, 9);
    expect(decoded.mag[1]).toBeCloseTo(5.99, 9);
    expect(decoded.bv[1]).toBeCloseTo(1.5, 9);
    expect(decoded.hip[1]).toBe(2);
  });

  it('reads a proper-motion catalogue without an app change', () => {
    // The upgrade path, asserted: columns are addressed by name, so extra ones
    // are carried past harmlessly rather than shifting every later column.
    const { header: h, buffer } = build([{ name: 'pmRa', type: 'float32' }], 8);
    const decoded = decodeStarCatalogue(h, buffer);
    expect(decoded.count).toBe(2);
    expect(decoded.ra[0]).toBeCloseTo(10, 5);
  });

  it('refuses a short binary rather than reading garbage', () => {
    const { header: h } = build();
    expect(() => decodeStarCatalogue(h, new ArrayBuffer(8))).toThrow(/short at column/);
  });

  it('refuses a future version', () => {
    const { header: h, buffer } = build();
    expect(() => decodeStarCatalogue({ ...h, version: 2 }, buffer)).toThrow(/version 2/);
  });
});

describe('directions at an epoch', () => {
  it('are unit vectors', () => {
    const dirs = starDirectionsAtEpoch(catalogue, julianDay(400, 6, 21));
    for (let i = 0; i < catalogue.count; i += 97) {
      const length = Math.hypot(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
      expect(length).toBeCloseTo(1, 5);
    }
  });

  it('reduce to the catalogue itself at J2000', () => {
    const dirs = starDirectionsAtEpoch(catalogue, 2451545.0);
    for (let i = 0; i < catalogue.count; i += 313) {
      const back = equatorialFromDirection(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]);
      expect(back.decDeg).toBeCloseTo(catalogue.dec[i], 3);
    }
  });

  it('reuse the buffer they are given', () => {
    const buffer = new Float32Array(catalogue.count * 3);
    expect(starDirectionsAtEpoch(catalogue, 2451545.0, buffer)).toBe(buffer);
  });

  it('move the whole sky when the year does', () => {
    const now = starDirectionsAtEpoch(catalogue, 2451545.0);
    const iron = starDirectionsAtEpoch(catalogue, julianDay(-1050, 6, 21));
    let moved = 0;
    for (let i = 0; i < catalogue.count; i += 71) {
      const dot =
        now[i * 3] * iron[i * 3] + now[i * 3 + 1] * iron[i * 3 + 1] + now[i * 3 + 2] * iron[i * 3 + 2];
      moved += (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
    }
    const mean = moved / Math.ceil(catalogue.count / 71);
    expect(mean).toBeGreaterThan(10);
  });
});

describe('star colours', () => {
  it('run blue through white to orange', () => {
    const blue = starColor(-0.3);
    const white = starColor(0.0);
    const orange = starColor(1.8);
    expect(blue[2]).toBeGreaterThan(blue[0]);
    expect(white[2]).toBeGreaterThanOrEqual(white[0]);
    expect(orange[0]).toBeGreaterThan(orange[2]);
  });

  it('clamp outside the table', () => {
    expect(starColor(-9)).toEqual(starColor(-0.4));
    expect(starColor(9)).toEqual(starColor(2.2));
  });

  it('are continuous', () => {
    for (let bv = -0.4; bv < 2.2; bv += 0.05) {
      const a = starColor(bv);
      const b = starColor(bv + 0.01);
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c] - b[c])).toBeLessThan(0.05);
    }
  });
});

describe('the reflection map', () => {
  const directions = starDirectionsAtEpoch(catalogue, 2451545.0);
  const map = bakeStarMap(catalogue, directions, { width: 512, height: 256 });

  it('has the requested shape', () => {
    expect(map.width).toBe(512);
    expect(map.height).toBe(256);
    expect(map.data.length).toBe(512 * 256 * 4);
  });

  it('is mostly empty sky', () => {
    // 5 044 small splats over 131 072 texels: the great majority of the sky is
    // dark, which is the point — a map that is bright everywhere would wash the
    // water out into a flat grey rather than reflecting individual stars.
    let bright = 0;
    let faint = 0;
    for (let i = 0; i < map.width * map.height; i++) {
      if (map.data[i * 4] > 32) bright += 1;
      if (map.data[i * 4] > 16) faint += 1;
    }
    expect(bright).toBeGreaterThan(400);
    expect(faint / (map.width * map.height)).toBeLessThan(0.1);
  });

  it('is opaque everywhere', () => {
    for (let i = 0; i < map.width * map.height; i += 37) expect(map.data[i * 4 + 3]).toBe(255);
  });

  it('puts Sirius at the texel its right ascension says', () => {
    let brightest = 0;
    for (let i = 1; i < catalogue.count; i++) {
      if (catalogue.mag[i] < catalogue.mag[brightest]) brightest = i;
    }
    const u = catalogue.ra[brightest] / 360;
    const v = catalogue.dec[brightest] / 180 + 0.5;
    const ix = Math.floor(u * map.width);
    const iy = Math.floor(v * map.height);
    const at = (x: number, y: number) => map.data[(y * map.width + x) * 4];
    // The splat straddles texel boundaries, so the peak lands in the texel the
    // coordinates name but does not reach the full 255.
    expect(at(ix, iy)).toBeGreaterThan(150);
    // …and the sky twenty texels away along the same parallel is dark.
    expect(at((ix + 20) % map.width, iy)).toBeLessThan(at(ix, iy) / 2);
  });

  it('leaves a genuinely empty region black', () => {
    // A single synthetic star in an otherwise empty catalogue: everything far
    // from it must stay at zero, so nothing is leaking a background level.
    const single: StarCatalogue = {
      count: 1,
      ra: Float64Array.from([90]),
      dec: Float64Array.from([0]),
      mag: Float64Array.from([1]),
      bv: Float64Array.from([0]),
      hip: Int32Array.from([1]),
      limitingMagnitude: 6,
      source: { catalogue: 'test', properMotions: false },
    };
    const dirs = starDirectionsAtEpoch(single, 2451545.0);
    const one = bakeStarMap(single, dirs, { width: 64, height: 32 });
    const at = (x: number, y: number) => one.data[(y * one.width + x) * 4];
    expect(at(16, 16)).toBeGreaterThan(150);
    expect(at(48, 16)).toBe(0);
    expect(at(16, 4)).toBe(0);
  });

  it('encodes brighter stars as larger values', () => {
    expect(relativeFlux(-1.44, -1.44)).toBeCloseTo(1, 9);
    expect(relativeFlux(6, -1.44)).toBeLessThan(0.002);
    expect(relativeFlux(1, -1.44)).toBeGreaterThan(relativeFlux(2, -1.44));
  });
});
