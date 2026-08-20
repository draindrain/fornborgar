/**
 * The conjectural palisade (contract §8, PLAN §4.6.3).
 *
 * Three things are worth pinning down, because breaking any of them would make the
 * app quietly lie:
 *   • `rampart.json` validation — a malformed asset must be refused with a message
 *     naming the field, never half-loaded;
 *   • the instance transforms — posts every `spacingM` along the line, standing on
 *     `ground · exaggeration`, and keeping their **true metric height** at any
 *     exaggeration (contract §0);
 *   • the jitter — deterministic for a seed, so the same seed is the same palisade
 *     on every machine and in every screenshot.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PALISADE_PARAMS,
  HEIGHT_JITTER,
  LEAN_JITTER_RAD,
  PalisadeLayer,
  RampartError,
  mulberry32,
  polylineLength,
  postJitter,
  postPlacements,
  validateRampart,
  type RampartFile,
} from '../src/overlays/palisade';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'testsite');
const testsiteRampart: unknown = JSON.parse(await readFile(join(DIR, 'rampart.json'), 'utf8'));

/** A 40 m square ring, 0.5 m point spacing — a shape whose geometry is exact by hand. */
function squareRing(side = 40, step = 0.5): [number, number][] {
  const points: [number, number][] = [];
  const n = side / step;
  for (let i = 0; i < n; i++) points.push([-side / 2 + i * step, -side / 2]);
  for (let i = 0; i < n; i++) points.push([side / 2, -side / 2 + i * step]);
  for (let i = 0; i < n; i++) points.push([side / 2 - i * step, side / 2]);
  for (let i = 0; i < n; i++) points.push([-side / 2, side / 2 - i * step]);
  return points;
}

function ringFile(points: [number, number][], closed = true): RampartFile {
  return validateRampart({
    schemaVersion: 1,
    site: 'testsite',
    derivation: { method: 'dem-ridge', description: 'test fixture', generated: '2026-08-20', params: {} },
    paths: [{ id: 'inner', name: 'Inner rampart', closed, lengthM: polylineLength(points, closed), points }],
  });
}

// ------------------------------------------------------------- validation ---

describe('rampart.json validation (contract §8)', () => {
  it('accepts the committed testsite asset', () => {
    const file = validateRampart(testsiteRampart, 'rampart.json');
    expect(file.paths).toHaveLength(1);
    expect(file.paths[0].id).toBe('inner');
    expect(file.paths[0].closed).toBe(true);
    expect(file.paths[0].points.length).toBeGreaterThanOrEqual(3);
    // Contract §8: positions carry no height.
    expect(file.paths[0].points.every((p) => p.length === 2)).toBe(true);
  });

  it('checks points against the core grid bounds when given', () => {
    const points = squareRing();
    expect(() => validateRampart(ringFile(points), 'rampart.json', { minX: -100, minZ: -100, maxX: 100, maxZ: 100 })).not.toThrow();
    expect(() =>
      validateRampart(ringFile(points), 'rampart.json', { minX: -10, minZ: -10, maxX: 10, maxZ: 10 }),
    ).toThrow(/outside the core grid bounds/);
  });

  const base = () => JSON.parse(JSON.stringify(testsiteRampart)) as Record<string, unknown>;
  const paths = (doc: Record<string, unknown>) => (doc['paths'] as Record<string, unknown>[])[0];

  it.each([
    ['a non-object', 42, /must be a JSON object/],
    [
      'an unknown schemaVersion',
      (() => {
        const doc = base();
        doc['schemaVersion'] = 2;
        return doc;
      })(),
      /unsupported schemaVersion/,
    ],
    [
      'a missing derivation',
      (() => {
        const doc = base();
        delete doc['derivation'];
        return doc;
      })(),
      /derivation must be an object/,
    ],
    [
      'an empty derivation.description',
      (() => {
        const doc = base();
        (doc['derivation'] as Record<string, unknown>)['description'] = '';
        return doc;
      })(),
      /derivation.description/,
    ],
    [
      'no paths',
      (() => {
        const doc = base();
        doc['paths'] = [];
        return doc;
      })(),
      /paths must be a non-empty array/,
    ],
    [
      'a path with fewer than 3 points',
      (() => {
        const doc = base();
        paths(doc)['points'] = [
          [0, 0],
          [0.5, 0],
        ];
        return doc;
      })(),
      /needs at least 3 positions/,
    ],
    [
      'a NaN coordinate',
      (() => {
        const doc = base();
        (paths(doc)['points'] as unknown[])[4] = [1, null];
        return doc;
      })(),
      /finite \[x, z\] pair/,
    ],
    [
      'a closed ring that repeats its first point',
      (() => {
        const doc = base();
        const points = paths(doc)['points'] as [number, number][];
        points.push([...points[0]]);
        return doc;
      })(),
      /must not repeat the first/,
    ],
    [
      'points more than 1 m apart',
      (() => {
        const doc = base();
        const points = paths(doc)['points'] as [number, number][];
        paths(doc)['points'] = points.filter((_, i) => i % 4 === 0);
        return doc;
      })(),
      /densifies to/,
    ],
    [
      'duplicate path ids',
      (() => {
        const doc = base();
        const path = paths(doc);
        (doc['paths'] as unknown[]).push(JSON.parse(JSON.stringify(path)));
        return doc;
      })(),
      /duplicate path id/,
    ],
  ])('rejects %s', (_label, input, message) => {
    expect(() => validateRampart(input, 'rampart.json')).toThrow(RampartError);
    expect(() => validateRampart(input, 'rampart.json')).toThrow(message as RegExp);
  });
});

// -------------------------------------------------------- post placement ----

describe('post placement along the crest', () => {
  it('spaces posts evenly around a closed ring', () => {
    const points = squareRing(40, 0.5);
    const posts = postPlacements(points, true, 0.4);

    // 160 m perimeter at ~0.4 m => 400 posts, exactly closing the ring.
    expect(polylineLength(points, true)).toBeCloseTo(160, 6);
    expect(posts).toHaveLength(400);

    for (let i = 1; i < posts.length; i++) {
      const step = Math.hypot(posts[i].x - posts[i - 1].x, posts[i].z - posts[i - 1].z);
      // Corners are the only place a straight-line step is shorter than the arc step.
      expect(step).toBeLessThanOrEqual(0.4 + 1e-9);
      expect(step).toBeGreaterThan(0.27);
    }
    // The ring closes: last post is one step from the first.
    const closing = Math.hypot(posts[0].x - posts[posts.length - 1].x, posts[0].z - posts[posts.length - 1].z);
    expect(closing).toBeCloseTo(0.4, 2);
  });

  it('scales the post count with the spacing parameter', () => {
    const points = squareRing();
    expect(postPlacements(points, true, 0.4)).toHaveLength(400);
    expect(postPlacements(points, true, 0.8)).toHaveLength(200);
    expect(postPlacements(points, true, 2.0)).toHaveLength(80);
  });

  it('stops at the end of an open line instead of closing it', () => {
    const line: [number, number][] = [
      [0, 0],
      [10, 0],
    ];
    const posts = postPlacements(line, false, 1);
    expect(posts).toHaveLength(11); // 0 m … 10 m inclusive
    expect(posts[posts.length - 1].x).toBeCloseTo(10, 6);
  });

  it('follows a circle to within the chord error', () => {
    const radius = 45;
    const points: [number, number][] = [];
    const count = 565;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      points.push([radius * Math.sin(a), -radius * Math.cos(a)]);
    }
    for (const post of postPlacements(points, true, 0.4)) {
      expect(Math.hypot(post.x, post.z)).toBeCloseTo(radius, 2);
    }
  });
});

// -------------------------------------------------------------- jitter ------

describe('deterministic jitter', () => {
  it('is a pure function of the seed', () => {
    const a = postJitter(7, 32);
    const b = postJitter(7, 32);
    expect(Array.from(a.height)).toEqual(Array.from(b.height));
    expect(Array.from(a.leanX)).toEqual(Array.from(b.leanX));
    expect(Array.from(a.leanZ)).toEqual(Array.from(b.leanZ));

    const other = postJitter(8, 32);
    expect(Array.from(other.height)).not.toEqual(Array.from(a.height));
  });

  it('stays inside the ±10 % height / ±3° lean envelope', () => {
    const { height, leanX, leanZ } = postJitter(1, 512);
    for (let i = 0; i < height.length; i++) {
      expect(Math.abs(height[i] - 1)).toBeLessThanOrEqual(HEIGHT_JITTER + 1e-6);
      expect(Math.abs(leanX[i])).toBeLessThanOrEqual(LEAN_JITTER_RAD + 1e-6);
      expect(Math.abs(leanZ[i])).toBeLessThanOrEqual(LEAN_JITTER_RAD + 1e-6);
    }
  });

  it('mulberry32 returns the unit interval and repeats for a seed', () => {
    const first = Array.from({ length: 8 }, mulberry32(42));
    const second = Array.from({ length: 8 }, mulberry32(42));
    expect(first).toEqual(second);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ----------------------------------------------------- instance transforms --

/** A ground surface that is a plain function of x, so expectations stay exact. */
const ground = (x: number, _z: number): number => 10 + x * 0.1;

function layerOn(file: RampartFile, exaggeration: { value: number }): PalisadeLayer {
  return new PalisadeLayer(file, { groundAt: ground, getExaggeration: () => exaggeration.value });
}

function decompose(layer: PalisadeLayer, index: number) {
  const matrix = layer.instanceMatrix(index);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  return { position, quaternion, scale, tiltDeg: THREE.MathUtils.radToDeg(up.angleTo(new THREE.Vector3(0, 1, 0))) };
}

describe('palisade instance transforms (contract §0)', () => {
  const file = ringFile(squareRing());

  it('stands every post on the exaggerated ground', () => {
    const exaggeration = { value: 1 };
    const layer = layerOn(file, exaggeration);
    expect(layer.count).toBe(400);

    for (const i of [0, 37, 199, 399]) {
      const { position } = decompose(layer, i);
      expect(position.y).toBeCloseTo(ground(position.x, position.z), 5);
    }

    exaggeration.value = 2.5;
    layer.refreshHeights();
    for (const i of [0, 37, 199, 399]) {
      const { position } = decompose(layer, i);
      expect(position.y).toBeCloseTo(ground(position.x, position.z) * 2.5, 5);
    }
    layer.dispose();
  });

  it('keeps the post height metric at any exaggeration', () => {
    const exaggeration = { value: 1 };
    const layer = layerOn(file, exaggeration);
    const before = decompose(layer, 12).scale.y;

    exaggeration.value = 1.5;
    layer.refreshHeights();
    const after = decompose(layer, 12).scale.y;

    expect(after).toBeCloseTo(before, 6);
    // A 3 m post is 3 m ±10 % of jitter — never 4.5 m at ×1.5.
    expect(after).toBeGreaterThan(DEFAULT_PALISADE_PARAMS.heightM * (1 - HEIGHT_JITTER) - 1e-6);
    expect(after).toBeLessThan(DEFAULT_PALISADE_PARAMS.heightM * (1 + HEIGHT_JITTER) + 1e-6);
    layer.dispose();
  });

  it('leans posts by no more than the jitter envelope', () => {
    const layer = layerOn(file, { value: 1 });
    for (let i = 0; i < layer.count; i += 17) {
      // Two independent ±3° leans compose to at most ~4.25° off vertical.
      expect(decompose(layer, i).tiltDeg).toBeLessThan(4.3);
    }
    layer.dispose();
  });

  it('rebuilds on spacing and seed changes, and is reproducible for a seed', () => {
    const layer = layerOn(file, { value: 1 });
    layer.setParams({ spacingM: 0.8 });
    expect(layer.count).toBe(200);

    const seededHeight = decompose(layer, 5).scale.y;
    layer.setParams({ seed: 99 });
    expect(decompose(layer, 5).scale.y).not.toBeCloseTo(seededHeight, 6);
    layer.setParams({ seed: DEFAULT_PALISADE_PARAMS.seed });
    expect(decompose(layer, 5).scale.y).toBeCloseTo(seededHeight, 6);

    // Height is a scale change only — no relayout, so the post count is untouched.
    layer.setParams({ heightM: 5 });
    expect(layer.count).toBe(200);
    expect(decompose(layer, 5).scale.y).toBeCloseTo((seededHeight * 5) / DEFAULT_PALISADE_PARAMS.heightM, 6);
    layer.dispose();
  });

  it('starts hidden and lives outside the terrain group', () => {
    const layer = layerOn(file, { value: 1 });
    expect(layer.group.visible).toBe(false);
    expect(layer.isEnabled).toBe(false);
    layer.setEnabled(true);
    expect(layer.group.visible).toBe(true);
    // A group with no parent: main.ts adds it to the scene, never to terrain.group,
    // so the terrain's Y scale can never stretch the posts.
    expect(layer.group.parent).toBeNull();
    layer.dispose();
  });

  it('instances the committed testsite ring', () => {
    const layer = layerOn(validateRampart(testsiteRampart), { value: 1 });
    // ~283 m of ring at 0.4 m spacing.
    expect(layer.count).toBeGreaterThan(690);
    expect(layer.count).toBeLessThan(720);
    for (let i = 0; i < layer.count; i += 41) {
      const { position } = decompose(layer, i);
      expect(Math.hypot(position.x, position.z)).toBeCloseTo(45, 1);
    }
    layer.dispose();
  });
});
