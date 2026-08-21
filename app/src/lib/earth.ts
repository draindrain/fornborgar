/**
 * Earth curvature + atmospheric refraction constants for the far-field ring
 * meshes (contract §11). They MUST equal the viewshed's constants in
 * `viewshed/xdraw.ts` (contract §4) so the rendered skyline and the computed
 * visibility can never disagree about where the horizon is — xdraw.ts is
 * deliberately import-free (it runs standalone under Node in the pipeline
 * acceptance test), so the values are duplicated here and pinned equal by
 * `tests/ringMesh.test.ts`.
 */

/** Mean earth radius (m). */
export const EARTH_RADIUS_M = 6371000;

/** Standard atmospheric refraction coefficient (the k in (1−k)·d²/2R). */
export const DEFAULT_REFRACTION_K = 0.13;

/**
 * Refracted curvature drop (m) at a horizontal distance whose square is
 * `distanceSqM` (m²): how far below the flat-earth plane the earth's surface
 * sits. ~17.5 m at 16 km, ~70 m at 32 km, ~280 m at 64 km.
 */
export function refractedDropM(distanceSqM: number, k: number = DEFAULT_REFRACTION_K): number {
  return ((1 - k) * distanceSqM) / (2 * EARTH_RADIUS_M);
}
