/**
 * Message protocol between the main thread and the viewshed Web Worker
 * (docs/data-formats.md §4). Types only — importing this file pulls in no code.
 *
 * Lifecycle:
 *   main -> worker  { type: 'init', ... }      heights buffer is **transferred**
 *   worker -> main  { type: 'ready' }
 *   main -> worker  { type: 'compute', id, ... }
 *   worker -> main  { type: 'result', id, mask, elapsedMs }   mask is **transferred**
 *
 * `compute` may be sent any number of times after `ready`. Every response carries
 * back the `id` it was asked with, so the main thread can drop stale results from
 * a drag that has already moved on.
 */

/** Hand the worker the grid. `heights` should be transferred, not copied. */
export interface ViewshedInitMessage {
  type: 'init';
  width: number;
  height: number;
  /** Meters per cell. */
  resolution: number;
  /** Meters, row-major, row 0 = north (docs/data-formats.md §1). */
  heights: Float32Array;
}

/**
 * Ask for one mask. Omitted optional fields take the contract defaults
 * (`observerHeight` 1.7, `targetHeight` 0, `maxRadius` 0 = unlimited,
 * `curvature` true, `refractionK` 0.13).
 */
export interface ViewshedComputeMessage {
  type: 'compute';
  /** Echoed back on the matching result; lets the caller discard stale masks. */
  id: number;
  /** Fractional grid coordinates (pixel-center index space). */
  observerCol: number;
  observerRow: number;
  observerHeight?: number;
  targetHeight?: number;
  maxRadius?: number;
  curvature?: boolean;
  refractionK?: number;
}

export type ViewshedRequest = ViewshedInitMessage | ViewshedComputeMessage;

/** Sent once, after `init` — the worker is holding the grid and can compute. */
export interface ViewshedReadyMessage {
  type: 'ready';
}

/** One finished mask: 1 = visible, 0 = hidden. `mask` is transferred. */
export interface ViewshedResultMessage {
  type: 'result';
  id: number;
  mask: Uint8Array;
  /** Wall-clock milliseconds spent inside `computeViewshed`. */
  elapsedMs: number;
}

export type ViewshedResponse = ViewshedReadyMessage | ViewshedResultMessage;
