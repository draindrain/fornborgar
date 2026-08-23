/**
 * Species mixes, stands, and per-species tints — the statistical layer under the
 * vegetation model (PLAN §6.1 amendment, 2026-08-22; evidence: docs/vegetation-zones.md
 * §2/§4).
 *
 * The §9 legend names three *forms* — `conifer`, `broadleaf`, `reeds` — and that stays
 * the data contract: a legend class says "conifer forest at 120 stems/ha", never
 * "60 % spruce". This module is where the app turns that form into the species mix the
 * pollen evidence actually supports, entirely inside the renderer, without touching the
 * raster, the legend, or the pipeline.
 *
 * ## Why a field and not a per-stem draw
 *
 * A coin flip per stem gives a 60/40 mix whose *realised fraction* is right and whose
 * *appearance* is wrong: salt-and-pepper, every spruce next to a pine, a texture no
 * forest has. Real mixed woodland is patchy at 50–200 m — stands of one species with
 * mixed margins — and the trees in a patch are of an age with each other because they
 * regenerated together. So both facts come from smooth noise fields (`lib/noise`):
 *
 *   • `speciesFieldFor` — a ~140 m fBm decides *which way the dice are loaded* here;
 *     the per-instance draw decides the individual stem. Neighbours share the loading,
 *     so they mostly share the species, and the stand margins stay mixed.
 *   • `standHeightFieldFor` — a ~90 m fBm scales the whole stand's height by
 *     ±18 %, so a mature stand reads as mature and a young one as young, instead of
 *     every tree independently rolling its own height.
 *
 * ## The one statistical trap, and how it is handled
 *
 * fBm is **not uniformly distributed** — it is an average of lattice values, so it
 * piles up around ½ (measured sd ≈ 0.169 for the two-octave shape this module uses).
 * Thresholding it naively would drag every realised mix toward 50/50 and quietly
 * misreport the model: a legend that says 60/40 would render 53/47. Two corrections,
 * both exact rather than tuned:
 *
 *   1. `equalize()` maps the fBm through its own measured CDF, so the field variable is
 *      uniform on [0, 1] before it is used for anything.
 *   2. `blendCdf()` maps the field/tiebreak blend through the CDF of the blend (an
 *      exactly-known trapezoid: the sum of two independent uniforms with unequal
 *      spans), so the quantity finally compared against the cumulative mix weights is
 *      uniform again.
 *
 * Together those make the plane-wide realised fraction equal the model's weights to
 * within sampling error, *whatever* the clump wavelength or the field/tiebreak split —
 * the tests pin it at ±0.10 over ≥5 000 instances. Change the weights, the octave
 * count, or `SPECIES_FIELD_WEIGHT` and the guarantee still holds; change `fbm2D`'s
 * shape (octaves, gain, lacunarity) and `FBM_QUANTILES` must be re-measured.
 *
 * ## What is deliberately *not* here yet
 *
 * The mix is a function of the legend's vegetation **type** only. docs/vegetation-zones.md
 * §4 shows it should eventually be a function of the *site*: at 500 CE Norway spruce had
 * not yet colonised southern Sweden, so a spruce-bearing conifer mix is an anachronism
 * south-west of the front (§2.4), and the doc proposes a single zone-level
 * `spruce_present` boolean to carry exactly that. When the legend grows that field,
 * `SPECIES_MIX` becomes a function of (type, zone) and nothing else here changes.
 * Until then the mix is boreonemoral-east — Broborg's own zone, the control site.
 */

import * as THREE from 'three';
import { fbm2D } from '../lib/noise';
import { streamSeed } from '../lib/random';
import type { VegetationType } from './legend';
import type { VegetationForm } from './vegetation';

/**
 * Every species the renderer can place. **Stable order** — the near-field layer stores
 * species as an index into this array, and the archetype geometry work indexes into it
 * too. Append, never reorder.
 */
export const TREE_SPECIES = ['spruce', 'pine', 'birch', 'oak', 'reeds'] as const;

export type TreeSpecies = (typeof TREE_SPECIES)[number];

/**
 * Metric envelope per species, in the same shape the legend's three forms use
 * (`VegetationForm`), because for now they drive the same instanced geometry.
 *
 * The numbers are ordinary mature-stand dimensions for the boreonemoral zone, chosen so
 * each pair inside a mix is *distinguishable at a distance*: spruce is the tall narrow
 * spire, pine the tall broader crown, oak the short wide dome, birch the slighter,
 * leanier one. `reeds` is bit-identical to `VEGETATION_FORMS.reeds` on purpose — the
 * shore band (vegetation.ts) is pinned to that form and must not move.
 */
export const SPECIES_FORMS: Record<TreeSpecies, VegetationForm> = {
  // Picea abies: the spire. Narrowest crown of the four, strongest height spread.
  spruce: { heightM: 14, widthRatio: 0.3, heightJitter: 0.28, widthJitter: 0.15, leanRad: (2 * Math.PI) / 180 },
  // Pinus sylvestris: as tall, but a broader, more open crown and a leaning habit.
  pine: { heightM: 15, widthRatio: 0.42, heightJitter: 0.25, widthJitter: 0.18, leanRad: (3 * Math.PI) / 180 },
  // Betula: slighter and shorter than the conifers, the widest lean of the trees.
  birch: { heightM: 11, widthRatio: 0.55, heightJitter: 0.26, widthJitter: 0.2, leanRad: (4 * Math.PI) / 180 },
  // Quercus: short and very broad — the silhouette that says "not a conifer".
  oak: { heightM: 9.5, widthRatio: 0.85, heightJitter: 0.26, widthJitter: 0.18, leanRad: (4 * Math.PI) / 180 },
  // Reed beds: knee-to-head high clumps, near-uniform. Identical to VEGETATION_FORMS.reeds.
  reeds: { heightM: 1.8, widthRatio: 0.65, heightJitter: 0.22, widthJitter: 0.2, leanRad: (7 * Math.PI) / 180 },
};

/** One species' share of a form's stems. Weights inside a mix sum to 1. */
export interface SpeciesWeight {
  species: TreeSpecies;
  weight: number;
}

/**
 * What each legend form is made of (docs/vegetation-zones.md §4, boreonemoral zone).
 *
 * §4: the boreonemoral conifer class is "pine + spruce east/north of the front" — the
 * two are co-dominant on till, with spruce the slight majority on the moister ground a
 * Mälaren-valley fort sits in. The broadleaf class is the oak–hazel–birch woodland of
 * §2/§4, rendered as its two tree constituents (hazel is understory — a shrub layer the
 * renderer has no form for, so it is not silently promoted to a tree here).
 *
 * The split is a function of the **type only**, not of the site — see the module
 * comment: §4's `spruce_present` boolean is the next step, and mixing a per-site rule in
 * before the legend carries the zone would be inventing a gradient (exactly what
 * docs/vegetation-zones.md exists to prevent).
 */
export const SPECIES_MIX: Record<VegetationType, ReadonlyArray<SpeciesWeight>> = {
  conifer: [
    { species: 'spruce', weight: 0.6 },
    { species: 'pine', weight: 0.4 },
  ],
  broadleaf: [
    { species: 'oak', weight: 0.65 },
    { species: 'birch', weight: 0.35 },
  ],
  reeds: [{ species: 'reeds', weight: 1 }],
};

// ------------------------------------------------------------- the fields ---

/**
 * Stream ids for this module's noise fields. **New ids in the 400+ range**, disjoint
 * from every stream `vegetation.ts` already walks (class placement 0–31, near-field
 * appearance 100+, shore band 200+, far field 300+, near-field species tiebreak 400+
 * and colour jitter 410+, far-field colour jitter 420+).
 *
 * Each field gets one stream per vegetation type, so adding a type — or changing one
 * type's mix — can never reshuffle another type's stands.
 */
const SPECIES_FIELD_STREAM_BASE = 430;
const STAND_HEIGHT_STREAM_BASE = 440;

/** Type → stream offset. Matches `VEGETATION_TYPE_ORDER` in vegetation.ts; both are
 * append-only for the same reason (a reorder silently reshuffles every saved scene). */
const TYPE_ORDER: readonly VegetationType[] = ['conifer', 'broadleaf', 'reeds'];

function typeOffset(type: VegetationType): number {
  const index = TYPE_ORDER.indexOf(type);
  return index < 0 ? TYPE_ORDER.length : index;
}

/**
 * Stand size, meters. ~140 m is a mixed-woodland patch: several stands across a 1 km
 * context extent, but big enough that a visitor standing in one is *inside* it rather
 * than looking at a mosaic.
 */
const SPECIES_FIELD_WAVELENGTH_M = 140;

/** Stand-age patch size — deliberately finer than the species patch, so the two
 * structures do not coincide and print as one blotchy map. */
const STAND_HEIGHT_WAVELENGTH_M = 90;

/** Two octaves: enough to break the round-blob look, cheap enough to sample per stem. */
const FIELD_OCTAVES = 2;

/**
 * How much of the species decision the clump field owns, against the per-instance
 * tiebreak draw. 0 = pure salt-and-pepper, 1 = hard-edged single-species patches with
 * no mixing at all. 0.7 gives readable stands with mixed margins.
 *
 * It does **not** affect the realised fractions — `blendCdf` corrects for it exactly.
 */
const SPECIES_FIELD_WEIGHT = 0.7;

/** Stand-age height multiplier bounds. Exported: the tests bound instance scales
 * against `species form × this range`, and so must anything else that does. */
export const STAND_HEIGHT_MIN = 0.82;
export const STAND_HEIGHT_MAX = 1.18;

/**
 * The measured CDF of `fbm2D(seed, 2, w)` — 33 knots at the k/32 quantiles, with the
 * theoretical support ends 0 and 1 pinned as the outer knots.
 *
 * **[measured 2026-08-22]** over 1 280 000 samples (40 seeds × 4 wavelengths ×
 * 8 000 points; mean 0.5006, sd 0.1686, symmetric to ±0.0008). The distribution depends
 * only on the *shape* of the fBm — octaves, gain, lacunarity — and not on the seed or
 * the wavelength, because every lattice value is i.i.d. uniform and the interpolation
 * weights are scale-free. That is what makes a fixed table legitimate here rather than
 * a per-scene calibration pass. **Re-measure if `FIELD_OCTAVES` or `fbm2D`'s gain or
 * lacunarity ever change** (the species test's realised-fraction assertion is the
 * tripwire).
 */
const FBM_QUANTILES = [
  0, 0.19618, 0.24, 0.27157, 0.29709, 0.31948, 0.33959, 0.35839, 0.37605, 0.39304, 0.40931, 0.42507,
  0.44068, 0.45582, 0.47057, 0.48555, 0.50032, 0.51518, 0.53015, 0.54515, 0.56034, 0.5761, 0.59204,
  0.60856, 0.62551, 0.64322, 0.66185, 0.68185, 0.7037, 0.72899, 0.76051, 0.80462, 1,
];

/**
 * Histogram equalisation: bell-shaped fBm in, **uniform** [0, 1] out.
 *
 * Piecewise-linear through `FBM_QUANTILES`, so it is monotone and continuous — which
 * matters as much as the uniformity: it preserves the field's spatial smoothness, and
 * therefore the stands. (A rank/hash-based equalisation would be uniform and useless.)
 */
export function equalize(value: number): number {
  const intervals = FBM_QUANTILES.length - 1;
  if (!(value > 0)) return 0;
  if (value >= 1) return 1;
  let lo = 0;
  let hi = intervals;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (FBM_QUANTILES[mid] <= value) lo = mid;
    else hi = mid;
  }
  const a = FBM_QUANTILES[lo];
  const b = FBM_QUANTILES[lo + 1];
  const t = b > a ? (value - a) / (b - a) : 0;
  return (lo + t) / intervals;
}

/**
 * CDF of `SPECIES_FIELD_WEIGHT · U₁ + (1 − SPECIES_FIELD_WEIGHT) · U₂` for independent
 * uniforms — the trapezoid distribution. Exact, not fitted.
 *
 * With spans `a ≥ b` (a + b = 1): quadratic ramp on [0, b], linear on [b, a], mirrored
 * quadratic on [a, 1]. Feeding the blend through this makes the comparison variable
 * uniform, which is what keeps the realised mix on the model's weights no matter how
 * the blend is weighted.
 */
function blendCdf(s: number): number {
  const a = Math.max(SPECIES_FIELD_WEIGHT, 1 - SPECIES_FIELD_WEIGHT);
  const b = Math.min(SPECIES_FIELD_WEIGHT, 1 - SPECIES_FIELD_WEIGHT);
  if (!(s > 0)) return 0;
  if (s >= 1) return 1;
  if (b <= 0) return s; // degenerate: one component carries everything
  if (s < b) return (s * s) / (2 * a * b);
  if (s <= a) return (s - b / 2) / a;
  const d = 1 - s;
  return 1 - (d * d) / (2 * a * b);
}

/**
 * The species picker for one legend form: `(x, z, tiebreak) → species`.
 *
 * `tiebreak` is the caller's per-instance uniform draw (one draw, from its own stream —
 * see `vegetation.ts`), so this function stays pure and the caller keeps full control of
 * its RNG stream layout.
 *
 * Neighbouring stems share the field term and differ only in the tiebreak, so they
 * mostly agree; stems a stand apart share nothing. A single-species mix (reeds) short
 * -circuits to a constant and never touches the noise at all.
 */
export function speciesFieldFor(
  type: VegetationType,
  seed: number,
): (x: number, z: number, tiebreak: number) => TreeSpecies {
  const mix = SPECIES_MIX[type] ?? SPECIES_MIX.conifer;
  if (mix.length === 1) {
    const only = mix[0].species;
    return () => only;
  }

  const field = fbm2D(
    streamSeed(seed, SPECIES_FIELD_STREAM_BASE + typeOffset(type)),
    FIELD_OCTAVES,
    SPECIES_FIELD_WAVELENGTH_M,
  );

  // Cumulative weights: `u < cumulative[i]` picks species i. The last entry is 1 by
  // construction and is never tested, so a mix whose weights are a hair off 1 degrades
  // into "the remainder goes to the last species" rather than into an undefined result.
  const cumulative: number[] = [];
  let acc = 0;
  for (const entry of mix) {
    acc += entry.weight;
    cumulative.push(acc);
  }

  return (x: number, z: number, tiebreak: number): TreeSpecies => {
    const t = tiebreak < 0 ? 0 : tiebreak > 1 ? 1 : tiebreak;
    const blend = SPECIES_FIELD_WEIGHT * equalize(field(x, z)) + (1 - SPECIES_FIELD_WEIGHT) * t;
    const u = blendCdf(blend);
    for (let i = 0; i < mix.length - 1; i++) {
      if (u < cumulative[i]) return mix[i].species;
    }
    return mix[mix.length - 1].species;
  };
}

/**
 * The stand-age height multiplier for one form: `(x, z) → [0.82, 1.18]`.
 *
 * Equalised, so the whole range is actually used instead of crowding around 1.0 — a
 * field of trees within ±3 % of each other reads as a hedge, not a forest. Continuous,
 * so a stand's edge is a gradient rather than a step, and shared by every stem in the
 * stand, which is the entire point: this is the variation a per-stem draw *cannot*
 * produce.
 */
export function standHeightFieldFor(type: VegetationType, seed: number): (x: number, z: number) => number {
  const field = fbm2D(
    streamSeed(seed, STAND_HEIGHT_STREAM_BASE + typeOffset(type)),
    FIELD_OCTAVES,
    STAND_HEIGHT_WAVELENGTH_M,
  );
  const span = STAND_HEIGHT_MAX - STAND_HEIGHT_MIN;
  return (x: number, z: number): number => STAND_HEIGHT_MIN + span * equalize(field(x, z));
}

// ------------------------------------------------------------- the colours --

/**
 * Per-species tint, as multipliers/offsets on the **class** colour's HSL.
 *
 * Deliberately small. The legend class colour is the honest signal — it is what the
 * ground wash, the legend swatch and the methods panel all show — so a species may
 * shade it, never replace it. Oak and reeds are the reference: they render the class
 * colour unchanged, and the others read as a variation on it.
 */
const SPECIES_TINT: Record<TreeSpecies, { hue: number; saturation: number; lightness: number }> = {
  // Spruce: the dark, blue-green one — the tone that makes a spruce stand read as shade.
  spruce: { hue: 0.012, saturation: 1.05, lightness: 0.88 },
  // Pine: warmer and a touch lighter (the yellow-green crown over a red-brown bole).
  pine: { hue: -0.014, saturation: 0.96, lightness: 1.07 },
  // Birch: the fresh, light green that picks a birch stand out of oak woodland.
  birch: { hue: -0.005, saturation: 1.07, lightness: 1.15 },
  // Oak / reeds: the class colour, untouched.
  oak: { hue: 0, saturation: 1, lightness: 1 },
  reeds: { hue: 0, saturation: 1, lightness: 1 },
};

const hsl = { h: 0, s: 0, l: 0 };

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Shade a class colour toward one species. Returns a **new** colour: the caller's
 * per-class colours are shared across thousands of instances and must never be mutated.
 */
export function speciesColor(base: THREE.Color, species: TreeSpecies): THREE.Color {
  const tint = SPECIES_TINT[species] ?? SPECIES_TINT.oak;
  const out = base.clone();
  if (tint.hue === 0 && tint.saturation === 1 && tint.lightness === 1) return out;
  out.getHSL(hsl);
  return out.setHSL(
    (hsl.h + tint.hue + 1) % 1,
    clamp01(hsl.s * tint.saturation),
    clamp01(hsl.l * tint.lightness),
  );
}

/** Per-instance colour jitter envelope — the one recipe, shared near and far. */
const JITTER_HUE = 0.015;
const JITTER_SATURATION = 0.12;
const JITTER_LIGHTNESS = 0.1;

/**
 * Wobble one instance's colour: hue ±0.015, saturation ×(1 ± 0.12), lightness
 * ×(1 ± 0.10). **Exactly three draws**, always, in that order — callers walk a
 * dedicated stream per batch and their per-instance draw counts are an invariant.
 *
 * Small numbers on purpose. What this fixes is the giveaway that a stand of instanced
 * geometry is *instanced*: a thousand crowns in one flat colour read as a single object
 * with a repeating cutout. A few percent of spread is enough for the eye to resolve
 * individual trees, and too little to muddy the class colour the legend promises.
 */
export function jitterPlantColor(base: THREE.Color, random: () => number): THREE.Color {
  const dh = (random() * 2 - 1) * JITTER_HUE;
  const ds = 1 + (random() * 2 - 1) * JITTER_SATURATION;
  const dl = 1 + (random() * 2 - 1) * JITTER_LIGHTNESS;
  const out = base.clone();
  out.getHSL(hsl);
  return out.setHSL((hsl.h + dh + 1) % 1, clamp01(hsl.s * ds), clamp01(hsl.l * dl));
}
