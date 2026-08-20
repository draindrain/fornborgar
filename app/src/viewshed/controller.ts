/**
 * Main-thread owner of the viewshed Web Worker (Phase 3, PLAN §4.4).
 *
 * Throttling model: at most one compute in flight; while one runs, the latest
 * request replaces any queued one (latest-wins). With XDraw at ~50–300 ms per
 * pass this naturally caps drag recomputes at the pace the worker can deliver,
 * and the final pointer-up position always gets computed.
 */

import type { HeightGrid } from '../terrain/heightGrid';
import type { ViewshedComputeMessage, ViewshedRequest, ViewshedResponse } from './protocol';

export interface ViewshedSettings {
  observerHeight: number;
  targetHeight: number;
  maxRadius: number;
  curvature: boolean;
}

export const DEFAULT_SETTINGS: ViewshedSettings = {
  observerHeight: 1.7,
  targetHeight: 0,
  maxRadius: 0,
  curvature: true,
};

const REFRACTION_K = 0.13;

export class ViewshedController {
  /** Called with every finished mask (length = grid width*height, 1 = visible). */
  onResult: (mask: Uint8Array, elapsedMs: number) => void = () => {};

  private readonly worker: Worker;
  private ready = false;
  private inFlight = false;
  private queued: Omit<ViewshedComputeMessage, 'type' | 'id'> | null = null;
  private nextId = 1;

  constructor(grid: HeightGrid) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<ViewshedResponse>) => this.onMessage(event.data);
    // The worker keeps its own copy of the grid; transfer a copy so the app's
    // single source-of-truth array stays untouched on this thread.
    const copy = grid.heights.slice();
    const init: ViewshedRequest = {
      type: 'init',
      width: grid.width,
      height: grid.height,
      resolution: grid.resolution,
      heights: copy,
    };
    this.worker.postMessage(init, [copy.buffer]);
  }

  /** Request a compute for observer at fractional grid (col, row). Latest wins. */
  request(observerCol: number, observerRow: number, settings: ViewshedSettings): void {
    const body = {
      observerCol,
      observerRow,
      observerHeight: settings.observerHeight,
      targetHeight: settings.targetHeight,
      maxRadius: settings.maxRadius,
      curvature: settings.curvature,
      refractionK: REFRACTION_K,
    };
    if (!this.ready || this.inFlight) {
      this.queued = body;
      return;
    }
    this.send(body);
  }

  dispose(): void {
    this.worker.terminate();
  }

  private send(body: Omit<ViewshedComputeMessage, 'type' | 'id'>): void {
    this.inFlight = true;
    const message: ViewshedComputeMessage = { type: 'compute', id: this.nextId++, ...body };
    this.worker.postMessage(message);
  }

  private onMessage(message: ViewshedResponse): void {
    if (message.type === 'ready') {
      this.ready = true;
    } else if (message.type === 'result') {
      this.inFlight = false;
      this.onResult(message.mask, message.elapsedMs);
    }
    if (this.ready && !this.inFlight && this.queued) {
      const next = this.queued;
      this.queued = null;
      this.send(next);
    }
  }
}
