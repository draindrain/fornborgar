/**
 * Terrain assembly: the context ring, the chunked core, the seam skirt, and the
 * vertical-exaggeration group.
 *
 * Vertical exaggeration is a Y scale on the terrain **group** (contract §0 /
 * PLAN §4.2) so that everything later phases parent here — water plane, palisade,
 * markers, observer — inherits it. The height grids themselves are never touched;
 * all analysis runs unexaggerated.
 */

import * as THREE from 'three';
import type { HeightGrid } from './heightGrid';
import { ElevationTint, createContextMaterial, createSkirtMaterial, createTerrainMaterial } from './material';
import {
  buildGridPatch,
  buildSkirt,
  chunkRanges,
  contextInteriorRange,
  contextRingRanges,
  coreCutoutQuads,
} from './mesh';

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

/** Dispose every geometry under `group` and empty it, leaving the group in place. */
function disposeChildren(group: THREE.Group): void {
  for (const child of [...group.children]) {
    child.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }
  group.clear();
}

export class Terrain {
  /** Y-scaled by the vertical exaggeration; parent future scene layers here. */
  readonly group = new THREE.Group();

  private readonly coreGroup = new THREE.Group();
  private readonly contextGroup = new THREE.Group();

  private readonly coreMaterial = createTerrainMaterial();
  private readonly contextMaterial = createContextMaterial();
  private readonly skirtMaterial = createSkirtMaterial();

  private tint: ElevationTint = new ElevationTint(0, 1);
  private exaggeration = 1;

  contextGrid: HeightGrid | null = null;
  coreGrid: HeightGrid | null = null;

  constructor() {
    this.group.name = 'terrain';
    this.contextGroup.name = 'terrain-context';
    this.coreGroup.name = 'terrain-core';
    this.group.add(this.contextGroup, this.coreGroup);
  }

  setElevationRange(min: number, max: number): void {
    this.tint = new ElevationTint(min, max);
  }

  /**
   * The materials a ground-space overlay (Phase 3 viewshed) should inject into.
   * The skirt is excluded on purpose — its slivers are never analysis surface.
   */
  get overlayMaterials(): THREE.Material[] {
    return [this.coreMaterial, this.contextMaterial];
  }

  setExaggeration(value: number): void {
    this.exaggeration = value;
    this.group.scale.y = value;
  }

  getExaggeration(): number {
    return this.exaggeration;
  }

  /**
   * Build the context ring. Called once with `core = null` for the instant
   * overview (the full extent at 2 m, including the middle), then again once the
   * core grid has arrived — at which point the middle patch is dropped and the
   * ring keeps only the quads outside the core.
   */
  async setContext(grid: HeightGrid, onProgress: (f: number) => void = () => {}): Promise<void> {
    this.contextGrid = grid;
    disposeChildren(this.contextGroup);

    const cutout = this.coreGrid ? coreCutoutQuads(this.coreGrid, grid) : null;
    const ranges = contextRingRanges(grid, cutout);
    const interiorRange = contextInteriorRange(cutout);

    const total = ranges.length + (interiorRange && !this.coreGrid ? 1 : 0);
    let done = 0;
    for (const range of ranges) {
      const mesh = new THREE.Mesh(buildGridPatch(grid, range, this.tint), this.contextMaterial);
      mesh.name = 'context-band';
      this.contextGroup.add(mesh);
      onProgress(++done / total);
      await nextFrame();
    }

    // Interior filler only while the core is still loading.
    if (interiorRange && !this.coreGrid) {
      const interior = new THREE.Mesh(buildGridPatch(grid, interiorRange, this.tint), this.contextMaterial);
      interior.name = 'context-interior';
      this.contextGroup.add(interior);
      onProgress(++done / total);
    }
  }

  /** Build the 1 m core as 16 chunks plus its seam skirt, then re-cut the ring. */
  async setCore(grid: HeightGrid, onProgress: (f: number) => void = () => {}): Promise<void> {
    this.coreGrid = grid;
    disposeChildren(this.coreGroup);

    const ranges = chunkRanges(grid);
    let done = 0;
    for (const range of ranges) {
      const mesh = new THREE.Mesh(buildGridPatch(grid, range, this.tint), this.coreMaterial);
      mesh.name = `core-chunk-${done}`;
      this.coreGroup.add(mesh);
      onProgress((++done / (ranges.length + 1)) * 0.9);
      await nextFrame();
    }

    const depth = Math.max(8, (grid.maxElevation - grid.minElevation) * 0.25);
    const skirt = new THREE.Mesh(buildSkirt(grid, depth, this.tint), this.skirtMaterial);
    skirt.name = 'core-skirt';
    this.coreGroup.add(skirt);

    // Now that the core covers the middle, drop the 2 m interior filler.
    if (this.contextGrid) await this.setContext(this.contextGrid);
    onProgress(1);
  }

  dispose(): void {
    disposeChildren(this.coreGroup);
    disposeChildren(this.contextGroup);
    this.coreMaterial.dispose();
    this.contextMaterial.dispose();
    this.skirtMaterial.dispose();
  }
}
