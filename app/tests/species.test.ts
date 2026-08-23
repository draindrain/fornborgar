/**
 * The species layer (`landcover/species.ts`) — PLAN §6.1 amendment, 2026-08-22.
 *
 * This module's whole job is a statistical claim, so the tests are statistical:
 *
 *   • **the mix is honest** — a legend class that models 60/40 must *render* 60/40 over
 *     the extent, not the 53/47 a naive threshold on bell-shaped noise would give. This
 *     is the assertion that matters: the mix is sourced from the pollen evidence
 *     (docs/vegetation-zones.md §4), and quietly dragging it toward 50/50 would
 *     misreport that evidence exactly the way the §6.1 amendment forbids;
 *   • **the mix is clumped** — neighbouring stems mostly agree, distant ones do not;
 *     without that the forest is salt-and-pepper and the whole field machinery is
 *     pointless;
 *   • **stands are stands** — the height multiplier stays in range, moves smoothly, and
 *     uses its whole range rather than crowding around 1.0;
 *   • **determinism**, as everywhere in this app: same seed, same forest.
 *
 * A-vs-B comparisons and properties, never golden literals — the numbers may move, the
 * properties may not.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../src/lib/random';
import type { VegetationType } from '../src/landcover/legend';
import {
  SPECIES_FORMS,
  SPECIES_MIX,
  STAND_HEIGHT_MAX,
  STAND_HEIGHT_MIN,
  TREE_SPECIES,
  equalize,
  jitterPlantColor,
  speciesColor,
  speciesFieldFor,
  standHeightFieldFor,
  type TreeSpecies,
} from '../src/landcover/species';
import { VEGETATION_FORMS } from '../src/landcover/vegetation';

const MIXED_TYPES: VegetationType[] = ['conifer', 'broadleaf'];

describe('the species tables', () => {
  it('names every species it mixes, with weights that sum to 1', () => {
    for (const [type, mix] of Object.entries(SPECIES_MIX)) {
      expect(mix.length).toBeGreaterThan(0);
      const sum = mix.reduce((n, entry) => n + entry.weight, 0);
      expect(sum).toBeCloseTo(1, 10);
      for (const entry of mix) {
        expect(TREE_SPECIES).toContain(entry.species);
        expect(entry.weight).toBeGreaterThan(0);
        expect(SPECIES_FORMS[entry.species]).toBeDefined();
      }
      // No species appears twice in one mix — that would silently double its weight.
      expect(new Set(mix.map((e) => e.species)).size).toBe(mix.length);
      expect(['conifer', 'broadleaf', 'reeds']).toContain(type);
    }
  });

  it('gives every species a plausible metric form', () => {
    for (const species of TREE_SPECIES) {
      const form = SPECIES_FORMS[species];
      expect(form.heightM).toBeGreaterThan(0);
      expect(form.widthRatio).toBeGreaterThan(0);
      expect(form.heightJitter).toBeGreaterThan(0);
      expect(form.heightJitter).toBeLessThan(0.5); // never a negative height
      expect(form.widthJitter).toBeLessThan(0.5);
      expect(form.leanRad).toBeGreaterThanOrEqual(0);
      expect(THREE.MathUtils.radToDeg(form.leanRad)).toBeLessThan(15);
    }
    // The reeds form is pinned to the legend form: the shore band sizes itself from
    // `VEGETATION_FORMS.reeds` and its transforms are an invariant (vegetation.ts).
    expect(SPECIES_FORMS.reeds).toEqual(VEGETATION_FORMS.reeds);
  });
});

describe('the fBm equalisation', () => {
  it('is monotone, total on [0, 1], and pinned at the ends', () => {
    expect(equalize(0)).toBe(0);
    expect(equalize(1)).toBe(1);
    let previous = -1;
    for (let i = 0; i <= 1_000; i++) {
      const value = equalize(i / 1_000);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

/** One large sample of a form's species assignment over a few square kilometers. */
function sampleSpecies(type: VegetationType, seed: number, side = 60, step = 40): TreeSpecies[] {
  const pick = speciesFieldFor(type, seed);
  const tiebreak = mulberry32(seed * 977 + 13);
  const out: TreeSpecies[] = [];
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      out.push(pick(i * step - (side * step) / 2, j * step - (side * step) / 2, tiebreak()));
    }
  }
  return out;
}

function fractions(species: TreeSpecies[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of species) counts[s] = (counts[s] ?? 0) + 1;
  for (const key of Object.keys(counts)) counts[key] /= species.length;
  return counts;
}

describe('species assignment (docs/vegetation-zones.md §4)', () => {
  it('is a pure function of (type, seed, position, tiebreak)', () => {
    for (const type of MIXED_TYPES) {
      const a = speciesFieldFor(type, 1234);
      const b = speciesFieldFor(type, 1234);
      const other = speciesFieldFor(type, 1235);
      let differed = 0;
      for (let i = 0; i < 500; i++) {
        const x = i * 17.3 - 4_000;
        const z = i * 9.1 + 220;
        const t = (i * 0.6180339887) % 1;
        expect(a(x, z, t)).toBe(b(x, z, t));
        if (other(x, z, t) !== a(x, z, t)) differed++;
      }
      // A different seed moves the stands; with two species ~half the points flip.
      expect(differed).toBeGreaterThan(100);
    }
  });

  it('realises the modelled mix fractions over a large sample (±0.10)', () => {
    // 3 600 points at 40 m over a 2.4 km square, per seed — well past the 5 000-sample
    // floor once the seeds are pooled, and wide enough to hold ~300 stands.
    for (const type of MIXED_TYPES) {
      const pooled: TreeSpecies[] = [];
      for (const seed of [1, 2, 3, 4, 5]) {
        const sample = sampleSpecies(type, seed);
        pooled.push(...sample);
        // Per seed, too — one lucky seed must not be what carries the pooled figure.
        const perSeed = fractions(sample);
        for (const entry of SPECIES_MIX[type]) {
          expect(perSeed[entry.species] ?? 0).toBeGreaterThan(entry.weight - 0.15);
          expect(perSeed[entry.species] ?? 0).toBeLessThan(entry.weight + 0.15);
        }
      }
      expect(pooled.length).toBeGreaterThanOrEqual(5_000);
      const realised = fractions(pooled);
      for (const entry of SPECIES_MIX[type]) {
        expect(realised[entry.species] ?? 0).toBeGreaterThan(entry.weight - 0.1);
        expect(realised[entry.species] ?? 0).toBeLessThan(entry.weight + 0.1);
      }
      // Nothing outside the mix ever appears.
      expect(Object.keys(realised).sort()).toEqual(SPECIES_MIX[type].map((e) => e.species).sort());
    }
  });

  it('clumps into stands: neighbours agree far more often than distant stems', () => {
    for (const type of MIXED_TYPES) {
      const pick = speciesFieldFor(type, 77);
      const random = mulberry32(4242);
      let near = 0;
      let far = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) {
        const x = random() * 4_000 - 2_000;
        const z = random() * 4_000 - 2_000;
        const here = pick(x, z, random());
        if (pick(x + 5, z, random()) === here) near++;
        if (pick(x + 500, z, random()) === here) far++;
      }
      // At 500 m the two points share no stand, so agreement falls to chance —
      // Σ wᵢ² for the mix. At 5 m they are the same stand and mostly agree.
      const chance = SPECIES_MIX[type].reduce((s, e) => s + e.weight * e.weight, 0);
      expect(far / n).toBeGreaterThan(chance - 0.06);
      expect(far / n).toBeLessThan(chance + 0.06);
      expect(near / n).toBeGreaterThan(far / n + 0.2);
    }
  });

  it('short-circuits a single-species mix without consulting the field', () => {
    const pick = speciesFieldFor('reeds', 5);
    for (let i = 0; i < 100; i++) {
      expect(pick(i * 31.7, i * -13.3, (i * 0.618) % 1)).toBe('reeds');
    }
  });
});

describe('the stand-age height field', () => {
  it('stays in range, is deterministic, and uses the whole range', () => {
    const a = standHeightFieldFor('conifer', 8);
    const b = standHeightFieldFor('conifer', 8);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const x = i * 7.3313 * Math.SQRT2 - 3_000;
      const z = i * 3.7371 + 91;
      const value = a(x, z);
      expect(value).toBe(b(x, z));
      expect(value).toBeGreaterThanOrEqual(STAND_HEIGHT_MIN);
      expect(value).toBeLessThanOrEqual(STAND_HEIGHT_MAX);
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }
    // Centred on 1.0 — the mix of species sizes must not drift as a side effect.
    expect(sum / n).toBeGreaterThan(0.98);
    expect(sum / n).toBeLessThan(1.02);
    // ...and the equalisation is doing its job: without it the field would crowd into
    // the middle few percent and no stand would read as older than any other.
    expect(min).toBeLessThan(STAND_HEIGHT_MIN + 0.02);
    expect(max).toBeGreaterThan(STAND_HEIGHT_MAX - 0.02);
  });

  it('is continuous — a stand has an edge, not a cliff', () => {
    const field = standHeightFieldFor('broadleaf', 3);
    let worst = 0;
    for (let i = 0; i < 5_000; i++) {
      const x = i * 1.37 - 1_000;
      const z = i * 0.71;
      worst = Math.max(worst, Math.abs(field(x + 1, z) - field(x, z)));
    }
    // One meter is ~1 % of the 90 m stand size; the equalisation is piecewise linear,
    // so it can steepen the field but not by more than its steepest segment.
    expect(worst).toBeLessThan(0.05);
    expect(worst).toBeGreaterThan(0);
  });

  it('gives every form its own field', () => {
    const conifer = standHeightFieldFor('conifer', 12);
    const broadleaf = standHeightFieldFor('broadleaf', 12);
    let differed = 0;
    for (let i = 0; i < 200; i++) {
      if (conifer(i * 23.7, i * 11.3) !== broadleaf(i * 23.7, i * 11.3)) differed++;
    }
    expect(differed).toBe(200);
  });
});

describe('species tints and per-instance colour jitter', () => {
  const base = new THREE.Color().setStyle('#33512f', THREE.SRGBColorSpace);

  it('shades the class colour without replacing it', () => {
    const hsl = { h: 0, s: 0, l: 0 };
    base.getHSL(hsl);
    for (const species of TREE_SPECIES) {
      const tinted = speciesColor(base, species);
      // Never mutates the caller's colour — it is shared across thousands of instances.
      expect(base.getHex()).toBe(new THREE.Color().setStyle('#33512f', THREE.SRGBColorSpace).getHex());
      const out = { h: 0, s: 0, l: 0 };
      tinted.getHSL(out);
      expect(Math.abs(out.h - hsl.h)).toBeLessThan(0.02);
      expect(out.l).toBeGreaterThan(hsl.l * 0.8);
      expect(out.l).toBeLessThan(hsl.l * 1.25);
    }
    // Oak and reeds are the reference: the class colour, untouched.
    expect(speciesColor(base, 'oak').getHex()).toBe(base.getHex());
    expect(speciesColor(base, 'reeds').getHex()).toBe(base.getHex());
    // ...and the shaded ones are genuinely distinguishable from it and each other.
    const spruce = speciesColor(base, 'spruce');
    const pine = speciesColor(base, 'pine');
    expect(spruce.getHex()).not.toBe(base.getHex());
    expect(pine.getHex()).not.toBe(spruce.getHex());
    // Spruce is the darker of the two — the tint table's whole point.
    const dark = { h: 0, s: 0, l: 0 };
    const light = { h: 0, s: 0, l: 0 };
    spruce.getHSL(dark);
    pine.getHSL(light);
    expect(dark.l).toBeLessThan(light.l);
  });

  it('jitters with exactly three draws, deterministically, inside its envelope', () => {
    const a = mulberry32(99);
    const b = mulberry32(99);
    const hsl = { h: 0, s: 0, l: 0 };
    const reference = { h: 0, s: 0, l: 0 };
    base.getHSL(reference);

    const colors: string[] = [];
    for (let i = 0; i < 500; i++) {
      const jittered = jitterPlantColor(base, a);
      // Same stream position, same colour: three draws per call, no more, no less.
      b();
      b();
      b();
      colors.push(jittered.getHexString());

      jittered.getHSL(hsl);
      expect(Math.abs(hsl.h - reference.h)).toBeLessThanOrEqual(0.015 + 1e-9);
      expect(hsl.s).toBeGreaterThanOrEqual(reference.s * 0.88 - 1e-9);
      expect(hsl.s).toBeLessThanOrEqual(reference.s * 1.12 + 1e-9);
      expect(hsl.l).toBeGreaterThanOrEqual(reference.l * 0.9 - 1e-9);
      expect(hsl.l).toBeLessThanOrEqual(reference.l * 1.1 + 1e-9);
    }
    // The two streams are still in lockstep after 500 calls — i.e. `jitterPlantColor`
    // consumed exactly three draws every time.
    expect(a()).toBe(b());
    // And it is variation, not a constant. The count is of *8-bit* colours — the
    // jitter is deliberately small, so a dark green's neighbours quantise together and
    // 500 stems land on a few hundred displayable shades. That is the honest measure of
    // what the eye gets, and it is what breaks up the instanced-cutout look.
    expect(new Set(colors).size).toBeGreaterThan(200);
  });
});
