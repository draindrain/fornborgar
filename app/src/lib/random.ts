/**
 * The app's one seeded random generator.
 *
 * Every procedural layer that has to look the same twice — the Phase-5 palisade's
 * post jitter, the Phase-7 vegetation sampling — draws from here, so "same seed ⇒
 * same scene on every machine and in every screenshot" is a property of one
 * function rather than of several copies that can drift apart.
 */

/** mulberry32 — 32-bit, seedable, identical everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fold a small integer stream id into a seed, so independent streams derived from
 * one user-facing seed stay independent (and stay stable when a stream is added).
 */
export function streamSeed(seed: number, stream: number): number {
  // Knuth's multiplicative hash on the stream, xored into the base seed.
  return (Math.imul(stream + 1, 0x9e3779b1) ^ (seed >>> 0)) >>> 0;
}
