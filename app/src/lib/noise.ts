/**
 * Seeded, allocation-free 2D value noise and fBm.
 *
 * The vegetation layer needs *spatially correlated* randomness, not just more of it:
 * a forest is stands of one species, not a per-stem coin flip, and the trees in a
 * stand are of an age with each other. A per-instance draw cannot express that —
 * neighbours would be independent by construction. A noise field can: two instances
 * 5 m apart read almost the same value, two instances 500 m apart read independent
 * ones, and the field costs nothing to store.
 *
 * Three properties this module exists to guarantee, all of them load-bearing for the
 * "same seed ⇒ same scene" rule the whole app is built on (`lib/random`):
 *
 *   • **Deterministic and stateless.** A lattice value is a pure hash of
 *     (cellX, cellZ, seed) — the same folding recipe `streamSeed` uses, finished with
 *     mulberry32's avalanche. There is no lattice array, so nothing depends on the
 *     order points are sampled in, on how large an area was sampled, or on how much
 *     memory the caller was willing to spend. Sampling one point is as reproducible
 *     as sampling a million.
 *   • **Unbounded domain.** Because the lattice is hashed rather than allocated, the
 *     field is defined over the whole plane at every scale — a 16 km ring and a 2 m
 *     cell read the same field.
 *   • **Range [0, 1], mean exactly ½.** Every lattice value is uniform on [0, 1] and
 *     every sample is a *convex* combination of lattice values (quintic-faded bilinear
 *     interpolation, then an amplitude-normalised octave sum), so the output can never
 *     leave [0, 1] and its expectation is exactly ½. Callers that need a mean-preserving
 *     perturbation get it for free.
 *
 * What this is *not*: gradient (Perlin/simplex) noise. Value noise's distribution is
 * bell-shaped rather than uniform and its lattice axes are faintly visible in a
 * gradient image. Neither matters here — the consumers (species clumping, stand age)
 * quantise the field into a handful of outcomes and correct for the bell explicitly
 * (`landcover/species.ts`) — and value noise is a quarter of the code with no gradient
 * table to keep deterministic.
 */

import { streamSeed } from './random';

/**
 * One lattice value: uniform on [0, 1), a pure function of (seed, cellX, cellZ).
 *
 * The two integer coordinates are folded into the seed with `streamSeed` — the app's
 * one stream-folding hash — and the result is run through mulberry32's avalanche step,
 * i.e. this is exactly `mulberry32(fold)()` without allocating the generator closure
 * (this runs a few million times per rebuild).
 *
 * `cx * 2 + 1` / `cz * 2` keep the two coordinates in disjoint residue classes:
 * `streamSeed(s, -1) === s` is the one fixed point of the fold, and the odd/even split
 * makes it unreachable for `cz`, so no two distinct cells can collapse onto the same
 * fold.
 */
function latticeValue(seed: number, cx: number, cz: number): number {
  let a = (streamSeed(streamSeed(seed, cx * 2 + 1), cz * 2) + 0x6d2b79f5) >>> 0;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/**
 * Ken Perlin's quintic fade, 6t⁵ − 15t⁴ + 10t³.
 *
 * Its first *and* second derivatives vanish at 0 and 1, so the interpolated field is
 * C² across cell boundaries. Plain smoothstep (3t² − 2t³) would leave a curvature
 * kink on every lattice line — invisible in a height field, but the species picker
 * thresholds this field, and a kink there prints as a straight edge through a stand.
 */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Smooth value noise on a **unit** lattice: `f(x, z) ∈ [0, 1]`, one lattice point per
 * unit of x/z. Scale the inputs to choose a wavelength (or use `fbm2D`, which does).
 */
export function valueNoise2D(seed: number): (x: number, z: number) => number {
  const s = seed >>> 0;
  return (x: number, z: number): number => {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = fade(x - x0);
    const fz = fade(z - z0);

    const v00 = latticeValue(s, x0, z0);
    const v10 = latticeValue(s, x0 + 1, z0);
    const v01 = latticeValue(s, x0, z0 + 1);
    const v11 = latticeValue(s, x0 + 1, z0 + 1);

    const lo = v00 + (v10 - v00) * fx;
    const hi = v01 + (v11 - v01) * fx;
    return lo + (hi - lo) * fz;
  };
}

/** Lacunarity and gain are fixed: the consumers' calibration assumes this shape. */
const LACUNARITY = 2;
const GAIN = 0.5;

/**
 * Fractional Brownian motion over `valueNoise2D`: `octaves` octaves, each half the
 * wavelength and half the amplitude of the last, renormalised back to [0, 1].
 *
 * `baseWavelengthM` is the first octave's lattice spacing **in meters** — the size of
 * the largest feature, i.e. how big a stand is. Two octaves is the working default:
 * one gives visibly round blobs, three costs twice the hashes for detail that a
 * thresholded field throws away.
 *
 * The renormalisation is by the amplitude sum, so the result is a convex combination
 * of [0, 1] lattice values: range and mean-½ both survive (see the module comment).
 * The *distribution* does not stay uniform — averaging octaves piles values up around
 * ½ — which is why `landcover/species.ts` carries an explicit equalisation.
 */
export function fbm2D(
  seed: number,
  octaves: number,
  baseWavelengthM: number,
): (x: number, z: number) => number {
  const count = Math.max(1, Math.floor(octaves));
  const wavelength = baseWavelengthM > 0 ? baseWavelengthM : 1;

  // Each octave draws from its own lattice stream, so the octaves are independent
  // rather than the same field read at two scales (which would visibly self-align).
  const noises: ((x: number, z: number) => number)[] = [];
  const frequencies: number[] = [];
  const amplitudes: number[] = [];
  let frequency = 1 / wavelength;
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < count; o++) {
    noises.push(valueNoise2D(streamSeed(seed, o)));
    frequencies.push(frequency);
    amplitudes.push(amplitude);
    total += amplitude;
    frequency *= LACUNARITY;
    amplitude *= GAIN;
  }

  return (x: number, z: number): number => {
    let sum = 0;
    for (let o = 0; o < count; o++) {
      sum += amplitudes[o] * noises[o](x * frequencies[o], z * frequencies[o]);
    }
    return sum / total;
  };
}
