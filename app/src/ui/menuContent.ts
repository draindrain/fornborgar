/**
 * The copy the kebab menu shows, as data.
 *
 * Same idiom as ui/methodsModel.ts: prose lives in exported constants and pure
 * builders so a vitest can pin it without a DOM. That matters most for the
 * attribution — the Lantmäteriet licence is CC BY, so the credit line is a
 * condition of use, not decoration, and it must not be able to vanish silently
 * when the screen it used to sit on is taken away.
 */

import type { AttributionEntry } from '../state/manifest';

/**
 * How to move the camera. Absorbed from the on-screen mode hint that used to
 * sit above the footer; the F key still works whether or not anyone reads this.
 */
export const CAMERA_HELP: string[] = [
  'Orbit: drag to turn, scroll to zoom, right-drag to pan.',
  'F — switch between orbit and first person.',
  'First person: WASD to walk, Shift to run, click to lock the mouse and look, F back to orbit.',
];

/**
 * PLAN §6.1's combined provenance line. It used to fade in over the terrain at
 * load; since the 2026-08-23b amendment it is a permanent line in here instead,
 * next to the credits, with the legend badges and the methods panel unchanged.
 */
export const PROVENANCE_SUMMARY =
  'Measured terrain, with a modelled water level and landscape and a conjectural ' +
  'palisade shown on top. Legend and Methods & sources say which is which.';

/** "×1.5" — trailing zeros trimmed, so 1.5 does not read as 1.50. */
export function formatExaggeration(value: number): string {
  return `×${Number(value.toFixed(2))}`;
}

export interface AboutOptions {
  /** The fort, for the panel title. */
  siteName: string;
  /** `describeSite(manifest)` — the grids, resolutions, datum and projection. */
  siteDescription: string;
  /** Current vertical exaggeration; PLAN §6.1 requires it stated wherever it is ≠ 1. */
  exaggeration: number;
  /** `manifest.attribution`, verbatim. */
  attribution: AttributionEntry[];
}

export interface AboutModel {
  title: string;
  paragraphs: string[];
  attribution: AttributionEntry[];
}

/**
 * The About & credits body.
 *
 * The exaggeration sentence is only present when there is one — at ×1.0 the
 * terrain is the terrain, and saying so would be noise.
 */
export function buildAboutModel(options: AboutOptions): AboutModel {
  const paragraphs = [options.siteDescription, PROVENANCE_SUMMARY];
  if (Math.abs(options.exaggeration - 1) > 1e-6) {
    paragraphs.push(
      `Heights are drawn at ${formatExaggeration(options.exaggeration)} vertical exaggeration — ` +
        'slopes look steeper than they are.',
    );
  }
  return {
    title: `${options.siteName} — about & credits`,
    paragraphs,
    attribution: options.attribution,
  };
}
