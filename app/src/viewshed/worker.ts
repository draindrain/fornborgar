/**
 * Viewshed Web Worker (docs/data-formats.md §4, PLAN §4.4).
 *
 * Instantiated from the main thread as a Vite module worker:
 *
 *   const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
 *
 * It holds the context grid for the lifetime of the site and answers `compute`
 * requests; nothing here touches the DOM, and the heavy loop lives in `xdraw.ts`
 * so the pipeline acceptance test can import the same code under plain Node.
 */

import { computeViewshed } from './xdraw';
import type { ViewshedRequest, ViewshedResponse } from './protocol';

/**
 * Minimal shape of `DedicatedWorkerGlobalScope`. Declared locally because the app's
 * tsconfig loads the DOM libs, not `WebWorker`, and the two conflict on `self`.
 */
interface ViewshedWorkerScope {
  onmessage: ((event: { data: ViewshedRequest }) => void) | null;
  postMessage(message: ViewshedResponse, transfer?: Transferable[]): void;
}

const ctx = self as unknown as ViewshedWorkerScope;

interface LoadedGrid {
  width: number;
  height: number;
  resolution: number;
  heights: Float32Array;
}

let grid: LoadedGrid | null = null;

ctx.onmessage = (event: { data: ViewshedRequest }): void => {
  const msg = event.data;

  if (msg.type === 'init') {
    grid = {
      width: msg.width,
      height: msg.height,
      resolution: msg.resolution,
      heights: msg.heights,
    };
    ctx.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'compute') {
    if (grid === null) {
      throw new Error('viewshed worker: received "compute" before "init"');
    }
    const t0 = performance.now();
    const mask = computeViewshed({
      heights: grid.heights,
      width: grid.width,
      height: grid.height,
      resolution: grid.resolution,
      observerCol: msg.observerCol,
      observerRow: msg.observerRow,
      observerHeight: msg.observerHeight,
      targetHeight: msg.targetHeight,
      maxRadius: msg.maxRadius,
      curvature: msg.curvature,
      refractionK: msg.refractionK,
    });
    const elapsedMs = performance.now() - t0;
    // The mask is transferred, so a fresh buffer is allocated per request.
    ctx.postMessage({ type: 'result', id: msg.id, mask, elapsedMs }, [mask.buffer]);
  }
};
