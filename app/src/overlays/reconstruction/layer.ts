/**
 * Reconstruction mode — standing monuments where marker mode draws registry dots.
 *
 * `docs/reconstruction-mode.md` is the specification; `docs/data-formats.md` §14
 * is the data contract. This module is the assembly: it joins `reconstruction.json`
 * to `sites.json` by id, builds each monument from its own parsed parameters, fills
 * grave fields with a terrain-aware sampler, sweeps the fort's cross-section along
 * the measured crest, and batches the lot into a handful of draw calls.
 *
 * Four invariants, all of them easy to break later and none of them local:
 *
 *   • **Nothing is a fixed size.** Every dimension comes from the record, the DEM,
 *     or a labelled literature default carried in the file's own `defaults` block.
 *     The same code draws a grave field of 5 monuments and one of 230, a fort
 *     spanning 76 m and one spanning 280 m.
 *   • **Vertical exaggeration is a render-only Y scale on the terrain _group_**
 *     (contract §0). This layer lives in the scene *outside* that group and seats
 *     every vertex at `y = ground · exaggeration + trueMetricHeight` itself — a
 *     2.5 m wall is 2.5 m at ×1 and at ×2.5 — refreshed whenever exaggeration
 *     changes. Same pattern as `overlays/palisade.ts`.
 *   • **Ground height is never in the data.** It is sampled at runtime through the
 *     app's one sampler, so a monument cannot drift from the terrain under it.
 *   • **Same seed ⇒ same scene.** Everything random draws from
 *     `lib/random.mulberry32`, seeded from the site id and folded per monument by
 *     `streamSeed`, so a reload is byte-identical and adding a monument cannot
 *     re-roll its neighbours.
 *
 * §8's time behaviour is a **visibility gate** in v1 (owner decision, §11.4), and
 * the gate has three outcomes rather than two, because "not yet built" and
 * "ruined" are not the same thing and rendering them the same way would lie in
 * one direction or the other:
 *
 *   | State | When | What is drawn |
 *   |---|---|---|
 *   | `unbuilt` | before `period.builtCE` | nothing — at 500 CE there are **no** runestones |
 *   | `standing` | between the two | the reconstruction |
 *   | `ruin` | at or after `period.abandonedCE` | the §3 marker, which is the *measured* geometry |
 *
 * An archetype this build cannot draw yet (field boundary, cultivated ground,
 * route, runestone) is `ruin` whenever it exists, so it keeps its marker rather
 * than disappearing.
 *
 * **Archetype H, the farmstead, is the one layer that is off when the mode is
 * on.** §9 ships it off by default with the strongest caveat in the app, because
 * it is the layer most likely to be mistaken for evidence and the one thing that
 * makes the landscape feel inhabited. So the houses of §6.H — inside a fort
 * whose §7.5.2 gate passed, and only there in any bundle written today — hang
 * off one switch, `setInteriorState`, which refuses `settlement` outright unless
 * the data says the state is offered. The gate is decided in the pipeline and
 * obeyed here; this layer does no parsing and no guessing.
 */

import * as THREE from 'three';
import type { GroundSampler } from '../../camera/firstPerson';
import { mulberry32, streamSeed } from '../../lib/random';
import type { SiteRecord, SitesFile } from '../sites';
import {
  buildLowBank,
  buildRampart,
  type SweepBuild,
} from './fort';
import {
  sampleGraveField,
  type LocalRings,
  type PlacedMonument,
  type SamplerTerrain,
} from './graveField';
import {
  buildShape,
  colour,
  kerbPlacements,
  mid,
  profileHeight,
  profileKind,
  SURFACE_COLOURS,
  type MaterialFamily,
  type ShapeSpec,
} from './shapes';
import {
  fortIsConfident,
  standingAt,
  type InteriorState,
  type Monument,
  type ReconstructionFile,
  type Tier,
} from './schema';
import { buildHouse, type BuildingBuild, type HouseSpec } from './longhouse';
import { buildYardFeature, planFarmstead, type FarmPlan } from './farmstead';
import { planFortInterior } from './ringfort';
import type { RampartFile } from '../palisade';

/** Archetypes this build actually draws in 3D. Everything else keeps its marker. */
export const RENDERED_ARCHETYPES: ReadonlySet<string> = new Set([
  'fort',
  'mound',
  'stone-setting',
  'cairn',
  'fire-cracked-mound',
  'grave-field',
  'standing-stone',
]);

export type MonumentState = 'unbuilt' | 'standing' | 'ruin';

/**
 * Does this build have geometry for this record?
 *
 * Archetype H is the one conditional answer, and the condition is the data:
 * §6.H.1 puts the farmstead in scope for the `settlement` interior state only,
 * and §6.H.1.4 leaves a free-standing `Boplats` out of that amendment
 * altogether — "free-standing farmsteads keep their flat markers until somebody
 * makes the equivalent measurement for them". A `farm` block (§15.2) *is* that
 * measurement arriving, so a farmstead record is drawable exactly when it
 * carries one, and keeps its marker when it does not.
 */
export function isDrawable(monument: Monument): boolean {
  if (monument.archetype === 'farmstead') return Boolean(monument.farm);
  return RENDERED_ARCHETYPES.has(monument.archetype);
}

/**
 * What §8's gate says about one record in a given year.
 *
 * Exported and pure: `main.ts` uses it to decide which flat markers stay on
 * screen in reconstruction mode, and the tests pin the runestone case.
 */
export function monumentState(monument: Monument, yearCE: number): MonumentState {
  const { builtCE } = monument.period;
  if (builtCE !== null && yearCE < builtCE) return 'unbuilt';
  if (!standingAt(monument, yearCE)) return 'ruin';
  return isDrawable(monument) ? 'standing' : 'ruin';
}

/**
 * The one-line caveat archetype H carries — §9's "strongest caveat in the app".
 *
 * Exported for whatever switches the state: the dev hook in `main.ts` today, and
 * the interior selector that replaces it.
 */
export const SETTLEMENT_CAVEAT =
  'Buildings inside this fort are ARCHETYPE H: the register records that houses were here, ' +
  'and everything you can see — where each one stands, which way it faces, its roof, its ' +
  'walls — is the archaeological literature, not this record. Count, grouping and size come ' +
  'from the record where it states them; the rest is a 5th-century default after Gene and ' +
  'Göthberg. Off by default for that reason.';

// --------------------------------------------------------------- batching ---

/**
 * One merged mesh: every monument of one archetype in one material family.
 *
 * Batching by *archetype* rather than by material alone is what makes §8's gate
 * free — the archetypes are not contemporaneous, `period` is per archetype, so a
 * year change is a handful of `visible` flags rather than a rebuild.
 */
interface Batch {
  key: string;
  archetype: string;
  /**
   * Whose §8 period governs this batch's visibility. Usually its own archetype;
   * for a fort's interior buildings it is the **fort**, because they are that
   * fort's interior and stand exactly as long as it does.
   */
  gateArchetype: string;
  /** Archetype H, off unless the interior is in the `settlement` state (§9). */
  settlementOnly: boolean;
  family: MaterialFamily;
  /**
   * True where the family shades smoothly and therefore needs real vertex
   * normals. The flat-shaded families compute face normals in the fragment
   * shader (see `shapes.buildShape`), so recomputing an attribute they ignore
   * would be pure cost on every exaggeration change.
   */
  smooth: boolean;
  positions: number[];
  colors: number[];
  indices: number[];
  /** Unexaggerated ground per vertex, index-parallel with `positions`. */
  groundY: number[];
  /** True metres above that ground, index-parallel. */
  localY: number[];
  mesh: THREE.Mesh | null;
  groundArray: Float32Array | null;
  localArray: Float32Array | null;
}

/** An instanced accent: a kerb stone, a centre block, a standing stone, a post. */
interface Accent {
  archetype: string;
  gateArchetype: string;
  settlementOnly: boolean;
  kind: 'boulder' | 'standing' | 'post';
  x: number;
  z: number;
  groundY: number;
  localY: number;
  sizeM: number;
  heightM: number;
  rotation: number;
  tilt: number;
  color: THREE.Color;
}

export interface ReconstructionOptions {
  /** The app's one unexaggerated ground sampler. */
  groundAt: GroundSampler;
  /** Current vertical exaggeration (the terrain group's Y scale). */
  getExaggeration(): number;
  /** §9 land-cover class at a point, where the site ships the raster. */
  classAt?: ((x: number, z: number) => number) | null;
  /** Class index → id, so wet classes are named rather than numbered. */
  classId?: ((index: number) => string | null) | null;
  /** The §8 rampart crest, where the site ships one. Archetype A needs it. */
  rampart?: RampartFile | null;
  /** Seed for every placement and jitter. Same seed ⇒ same scene. */
  seed?: number;
  /** §7.1's contested question, as a state (§11.3). */
  vitrified?: boolean;
}

/**
 * §6.G: wet land-cover classes monuments are never placed in, by legend id
 * rather than by index — the indices are per-site, the ids are the contract's.
 */
const WET_CLASS_IDS: ReadonlySet<string> = new Set(['water', 'peat_fen', 'shore_reeds']);
/** Allowed, but a poor site: it costs a candidate score rather than excluding it. */
const DAMP_CLASS_IDS: ReadonlySet<string> = new Set(['wet_meadow']);

/** Per-monument provenance, for the popup (§9.1 — never one averaged badge). */
export interface MonumentSummary {
  monument: Monument;
  state: MonumentState;
  /** Monuments the grave-field sampler actually placed, where it ran. */
  sampled: number;
  /** What the record asked for, so a shortfall is visible rather than silent. */
  requested: number;
  /** True where §6.A.1's filter refused a standing rampart. */
  fortDowngraded: boolean;
  /** Sampler warnings — a shortfall is never a silent truncation (§15.3). */
  warnings: string[];
}

/**
 * What the app can say about this fort's interior (§7.5, §15.1).
 *
 * Everything an interior selector and the popup need in order to state the case
 * rather than assert the picture: whether the state is offered at all, what the
 * gate rested on, how many buildings the record asked for against how many the
 * measured ground actually held, and which of the numbers drawn were defaults.
 */
export interface InteriorSummary {
  /** The pipeline's boolean. The app obeys it and never re-derives it (§15.3). */
  offered: boolean;
  state: InteriorState;
  /** The fort the block describes, where its extent was resolvable. */
  fortId: string | null;
  /** `pass` or `fail` — a fail is a statement, and a useful one (§15.3). */
  gate: string;
  /** True where every surviving hit hedges (möjlig, trolig, -liknande). */
  hedged: boolean;
  /** How the fort passed: description, settlement-record or cited. */
  channels: string[];
  /** Non-empty whenever the state is offered — no citation, no state (§7.5.3). */
  citations: number;
  /** The count the record stated, or the archetype default of one. */
  requested: number;
  placed: number;
  countStated: boolean;
  countSource: Tier;
  layout: string;
  /**
   * §7.5.2's building tradition, which selects the layout and never the gate.
   * `limestone-ringfort` is the Öland/Gotland radial-block branch.
   */
  tradition: string;
  /** The inner group's blocks and the street between the groups, where stated. */
  blocks: number | null;
  streetWidthM: [number, number] | null;
  sector: string | null;
  /** Field paths that took a §6.H default rather than the record (§15.3). */
  fallbacks: string[];
  warnings: string[];
}

export class ReconstructionLayer {
  /** Add this to the scene — **outside** the terrain group (contract §0). */
  readonly group = new THREE.Group();
  /**
   * The click volumes, deliberately **not** in the scene.
   *
   * They are invisible geometry: a material with `visible: false` is skipped at
   * draw time, but the object still goes through frustum culling and render-list
   * sorting every frame, and there is one per record. Kept out of the graph they
   * cost nothing, and `raycaster.intersectObjects` does not care whether an
   * object is in a scene — only that its world matrix is current, which
   * `refreshHeights` sees to.
   */
  private readonly pickGroup = new THREE.Group();
  readonly file: ReconstructionFile;

  private readonly options: Required<Pick<ReconstructionOptions, 'groundAt' | 'getExaggeration'>> &
    ReconstructionOptions;
  private readonly monuments = new Map<string, Monument>();
  private readonly records = new Map<string, SiteRecord>();
  private readonly summaries = new Map<string, MonumentSummary>();
  private readonly batches = new Map<string, Batch>();
  private readonly accents: Accent[] = [];
  private readonly materials = new Map<MaterialFamily, THREE.Material>();
  private readonly pickTargets: THREE.Mesh[] = [];
  private accentMeshes: THREE.InstancedMesh[] = [];
  private pickMaterial: THREE.MeshBasicMaterial | null = null;
  private yearCE: number;
  private enabled = false;
  private vertexTotal = 0;
  /**
   * §7.5.1: `cleared` is the default for every fort, always. Passing the gate
   * makes `settlement` *offerable*, not on — so the state the file carries (and
   * the contract pins to `cleared` in v1.8) is where the layer opens.
   */
  private interior: InteriorState;
  private interiorPlan: FarmPlan | null = null;
  private interiorFortId: string | null = null;

  constructor(
    file: ReconstructionFile,
    sites: SitesFile,
    options: ReconstructionOptions,
    yearCE = 500,
  ) {
    this.file = file;
    this.options = options as ReconstructionLayer['options'];
    this.yearCE = yearCE;
    this.interior = file.interior?.state ?? 'cleared';
    this.group.name = 'reconstruction';
    this.group.visible = false;

    for (const record of sites.sites) this.records.set(record.id, record);
    for (const monument of file.monuments) this.monuments.set(monument.id, monument);

    this.build();
    this.setYear(yearCE);
  }

  // ------------------------------------------------------------- lifecycle --

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Total vertices across every batch — the scene budget, for the readout. */
  get vertexCount(): number {
    return this.vertexTotal;
  }

  /** Monuments drawn in 3D right now (records plus everything sampled). */
  get standingCount(): number {
    let total = 0;
    for (const summary of this.summaries.values()) {
      if (summary.state !== 'standing') continue;
      total += 1 + summary.sampled;
    }
    if (this.interior === 'settlement') total += this.interiorPlan?.buildings.length ?? 0;
    return total;
  }

  /** §7.5's two interior states. `cleared` until something switches it. */
  get interiorState(): InteriorState {
    return this.interior;
  }

  /**
   * May this site offer the `settlement` state at all?
   *
   * Two sources, and neither is the app's own judgement. The first is the
   * pipeline's boolean: `settlementOffered` decides which forts may draw
   * archetype H inside them, and "an app that finds `settlementOffered: false`
   * and an inhabited-looking description draws the `cleared` state and nothing
   * else" (§15.3). The second is a `farm` block on a record **outside** any
   * fort, which the fort-interior gate says nothing about either way (§6.H.1.4)
   * — where the pipeline has written one, the record is what licenses it.
   */
  get settlementOffered(): boolean {
    if (this.file.interior?.settlementOffered) return true;
    for (const monument of this.monuments.values()) {
      if (monument.farm && !monument.farm.insideFortId) return true;
    }
    return false;
  }

  /**
   * Switch the interior between §7.5's two states. Returns the state in force.
   *
   * `settlement` is refused outright where the data does not offer it — "not
   * offered-and-labelled: not offered" (§7.5.3) — so a caller cannot turn houses
   * on in a fort whose record does not carry them, however it asks.
   */
  setInteriorState(state: InteriorState): InteriorState {
    const next = state === 'settlement' && !this.settlementOffered ? 'cleared' : state;
    if (next === this.interior) return next;
    this.interior = next;
    // Archetype H going on or off changes which records are drawn, so the §8
    // states — and with them the flat markers — have to be recomputed.
    this.setYear(this.yearCE);
    return next;
  }

  /** What the app may say about this fort's interior (§7.5.3), or null. */
  interiorSummary(): InteriorSummary | null {
    const block = this.file.interior;
    if (!block) return null;
    const buildings = block.buildings;
    return {
      offered: block.settlementOffered,
      state: this.interior,
      fortId: this.interiorFortId,
      gate: block.evidence?.gate ?? 'fail',
      hedged: Boolean(block.evidence?.hedged),
      channels: block.evidence?.channels ?? [],
      citations: block.evidence?.citations?.length ?? 0,
      requested: this.interiorPlan?.requested ?? 0,
      placed: this.interiorPlan?.buildings.length ?? 0,
      countStated: Boolean(buildings?.countStated),
      countSource: buildings?.countSource ?? 'assumed',
      layout: buildings?.layout ?? 'free',
      tradition: block.tradition,
      blocks: buildings?.blocks ?? null,
      streetWidthM: buildings?.streetWidthM ?? null,
      sector: buildings?.sector ?? null,
      fallbacks: buildings?.fallbacks ?? [],
      warnings: this.interiorPlan?.warnings ?? [],
    };
  }

  summary(id: string): MonumentSummary | null {
    return this.summaries.get(id) ?? null;
  }

  /**
   * Record ids whose flat §3 marker should stay on screen in reconstruction
   * mode: the ruins, and the archetypes this build does not draw. §8's ruin
   * state *is* marker mode — "today's marker-mode geometry, which is the
   * measured one".
   */
  markerIds(): Set<string> {
    const out = new Set<string>();
    for (const [id, summary] of this.summaries) {
      if (summary.state === 'ruin') out.add(id);
    }
    // A record with no reconstruction entry at all keeps its marker too.
    for (const id of this.records.keys()) if (!this.monuments.has(id)) out.add(id);
    return out;
  }

  /** §8's gate. Cheap: per-archetype `visible` flags, never a rebuild. */
  setYear(yearCE: number): void {
    this.yearCE = yearCE;
    for (const [id, monument] of this.monuments) {
      const summary = this.summaries.get(id);
      if (!summary) continue;
      summary.state = monumentState(monument, yearCE);
      // Archetype H is off unless the interior is in the `settlement` state, and
      // a record whose geometry is off keeps its flat §3 marker rather than
      // vanishing — the same rule as an archetype this build cannot draw.
      if (monument.archetype === 'farmstead' && this.interior !== 'settlement') {
        summary.state = summary.state === 'unbuilt' ? 'unbuilt' : 'ruin';
      }
    }
    // A grave field's constituents are drawn as their own archetypes, so they
    // follow their own periods — a Bronze Age cairn inside a Late Iron Age field
    // is a ruin at 500 CE even though the field is in use, which is exactly what
    // §8's table says.
    for (const batch of this.batches.values()) {
      if (!batch.mesh) continue;
      batch.mesh.visible = this.drawnNow(batch.gateArchetype, batch.settlementOnly, yearCE);
    }
    for (const mesh of this.accentMeshes) {
      mesh.visible = this.drawnNow(
        mesh.userData['gateArchetype'] as string,
        Boolean(mesh.userData['settlementOnly']),
        yearCE,
      );
    }
    for (const pick of this.pickTargets) {
      const id = pick.userData['siteId'] as string;
      pick.visible = this.summaries.get(id)?.state === 'standing';
    }
  }

  /** Re-seat every vertex on the (possibly re-exaggerated) surface. */
  refreshHeights(): void {
    const exaggeration = this.options.getExaggeration();
    for (const batch of this.batches.values()) {
      const mesh = batch.mesh;
      if (!mesh || !batch.groundArray || !batch.localArray) continue;
      const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const array = position.array as Float32Array;
      for (let i = 0; i < batch.groundArray.length; i++) {
        array[i * 3 + 1] = batch.groundArray[i] * exaggeration + batch.localArray[i];
      }
      position.needsUpdate = true;
      // Normals have to be computed *after* the vertices are seated, and again
      // whenever they move: the surface's shape depends on the exaggerated
      // ground it is draped over, and normals computed on the unseated geometry
      // would all point straight up — a mound lit as a flat disc.
      if (batch.smooth) mesh.geometry.computeVertexNormals();
      mesh.geometry.computeBoundingSphere();
    }
    this.refreshAccents(exaggeration);
    for (const pick of this.pickTargets) {
      const data = pick.userData as { x: number; z: number };
      pick.position.y = this.options.groundAt(data.x, data.z) * exaggeration;
    }
    // The pick volumes are outside the scene graph, so nothing else will bring
    // their world matrices up to date before the raycaster reads them.
    this.pickGroup.updateMatrixWorld(true);
  }

  dispose(): void {
    for (const root of [this.group, this.pickGroup]) {
      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry?.dispose();
      });
    }
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.pickMaterial?.dispose();
    this.pickMaterial = null;
    this.accentMeshes = [];
    this.pickTargets.length = 0;
    this.group.clear();
    this.pickGroup.clear();
  }

  /**
   * The invisible pick volumes, for the app's raycaster.
   *
   * Empty while the mode is off: the group being hidden does not clear a child's
   * own `visible` flag, so a marker-mode click on empty ground would otherwise
   * still open the card of whatever monument stands there in the other mode.
   */
  get pickables(): THREE.Object3D[] {
    return this.enabled ? this.pickTargets : [];
  }

  // ------------------------------------------------------------ construction -

  /** §8's period gate and §9's off-by-default, in one answer. */
  private drawnNow(gateArchetype: string, settlementOnly: boolean, yearCE: number): boolean {
    if (settlementOnly && this.interior !== 'settlement') return false;
    return this.archetypeStandsFor(gateArchetype, yearCE);
  }

  private archetypeStandsFor(archetype: string, yearCE: number): boolean {
    // The constituents of a grave field have no record of their own, so their
    // period comes from any monument of that archetype — the periods are
    // per archetype (§8), so any representative answers for all of them.
    for (const monument of this.monuments.values()) {
      if (monument.archetype === archetype) return monumentState(monument, yearCE) === 'standing';
    }
    // Sampled-only archetypes (a cairn inside a field, with no cairn record of
    // its own) fall back to the §8 table through a synthetic probe.
    const probe = SAMPLED_PERIODS[archetype];
    if (!probe) return true;
    const [built, abandoned] = probe;
    if (built !== null && yearCE < built) return false;
    if (abandoned !== null && yearCE >= abandoned) return false;
    return true;
  }

  private seedFor(id: string): number {
    let hash = this.options.seed ?? 1;
    for (let i = 0; i < id.length; i++) hash = streamSeed(hash, id.charCodeAt(i));
    return hash >>> 0;
  }

  private terrain(): SamplerTerrain {
    const classAt = this.options.classAt ?? null;
    const classId = this.options.classId ?? null;
    return {
      groundAt: (x, z) => this.options.groundAt(x, z),
      classAt,
      isWet: (index) => {
        const id = classId ? classId(index) : null;
        return id !== null && WET_CLASS_IDS.has(id);
      },
      isDamp: (index) => {
        const id = classId ? classId(index) : null;
        return id !== null && DAMP_CLASS_IDS.has(id);
      },
    };
  }

  private build(): void {
    // Deterministic order: the file's own, which the pipeline writes in
    // `sites.json` order. Nothing here may depend on Map iteration.
    for (const monument of this.file.monuments) {
      const record = this.records.get(monument.id);
      if (!record) continue;
      const summary: MonumentSummary = {
        monument,
        state: monumentState(monument, this.yearCE),
        sampled: 0,
        requested: monument.field?.count ?? 0,
        fortDowngraded: false,
        warnings: [],
      };
      this.summaries.set(monument.id, summary);

      if (!isDrawable(monument)) continue;

      if (monument.archetype === 'fort') {
        this.buildFort(monument, summary);
      } else if (monument.archetype === 'grave-field') {
        this.buildGraveField(monument, record, summary);
      } else if (monument.archetype === 'farmstead') {
        this.buildFarmstead(monument, record, summary);
      } else {
        this.buildRecordMonument(monument, record);
      }
      this.addPickTarget(monument, record);
    }

    this.buildInterior();
    this.materialise();
    // The layer opens in whatever state the file carries, which §15 pins to
    // `cleared`: the meshes exist, and they are off until something asks.
    this.setYear(this.yearCE);
  }

  /**
   * Archetype H inside a fort — §7.5.1's `settlement` state.
   *
   * Three refusals live here, and each is §7.5.3 written as control flow: no
   * buildings without the gate, no buildings without a fort extent to put them
   * in, and no buildings at all where the record attests houses but states
   * nothing about them (`buildings: null` — which is Broborg's own case, and the
   * reason Broborg draws none).
   */
  private buildInterior(): void {
    const block = this.file.interior;
    if (!block || !block.settlementOffered || !block.buildings) return;
    const fort = this.file.monuments.find((monument) => monument.archetype === 'fort');
    const record = fort ? this.records.get(fort.id) : undefined;
    if (!fort || !record) return;
    // §15.3: a building is a size, an orientation and a compass sector, resolved
    // "against the fort's §3 extent polygon at runtime". A fort known only as a
    // point has no interior to resolve them against, and inventing one would be
    // the app doing the guessing the contract forbids it.
    const ground = this.interiorGround(fort, record);
    if (!ground) return;

    this.interiorFortId = fort.id;
    // §7.5.2's Öland/Gotland branch is taken here and nowhere else: the
    // tradition selects the layout, and a `mainland` fort goes down exactly the
    // path it went down before the branch existed.
    const plan = planFortInterior(
      block.tradition,
      block.buildings,
      ground.rings,
      this.terrain(),
      this.seedFor(`${fort.id}#interior`),
      // §15's `defaults.farmstead`, for whatever the record left unstated.
      this.file.defaults?.['farmstead'],
      ground.insetM,
    );
    this.interiorPlan = plan;
    for (const house of plan.buildings) {
      // The §8 gate follows the fort: these are that fort's interior, and they
      // stand exactly as long as it does.
      this.addHouse(house, 'farmstead', 'fort');
    }
  }

  /**
   * The ground inside the wall, and how far in from its edge a house may stand.
   *
   * §7.5.1 puts the houses "against the inner wall face", and the inner wall
   * face is not the §3 extent: a fort's registered extent reaches to the outside
   * of its collapsed rampart — at Broborg the extent spans ~93 m and the crest
   * ring the DEM measured inside it spans ~65 m — so a house set 1.5 m inside
   * the extent would stand on the wall. So the boundary is the **measured crest**
   * (`rampart.json` §8) wherever the site ships one, inset by half the wall's own
   * thickness; where it does not, it is the extent inset by the collapse spread
   * the register records. Both numbers are the record's, not this module's.
   */
  private interiorGround(
    fort: Monument,
    record: SiteRecord,
  ): { rings: LocalRings; insetM: number } | null {
    const spec = fort.fort?.ramparts[0];
    const crest = this.options.rampart?.paths.filter((path) => path.closed && path.points.length > 3);
    if (crest && crest.length > 0) {
      // The main enclosure is the closed crest that encloses the most ground;
      // an outwork or a cross-wall encloses less.
      let best = crest[0];
      let bestArea = -Infinity;
      for (const path of crest) {
        const area = ringArea(path.points as Array<[number, number]>);
        if (area > bestArea) {
          bestArea = area;
          best = path;
        }
      }
      const thickness = spec?.wallThicknessM ?? 5;
      return { rings: [best.points as Array<[number, number]>], insetM: thickness / 2 + 1 };
    }
    const rings = localRings(record);
    if (!rings) return null;
    const spread = spec?.spreadM ? mid(spec.spreadM) : 0;
    return { rings, insetM: Math.max(1.5, spread) };
  }

  /** Archetype H on its own record — §15.2's `farm` block, outside a fort. */
  private buildFarmstead(monument: Monument, record: SiteRecord, summary: MonumentSummary): void {
    const farm = monument.farm;
    if (!farm) return;
    const plan = planFarmstead(
      farm,
      record.position,
      monument.plan.orientationDeg,
      localRings(record),
      this.terrain(),
      this.seedFor(monument.id),
      this.file.defaults?.['farmstead'],
    );
    summary.sampled = Math.max(0, plan.buildings.length - 1);
    summary.requested = plan.requested;
    summary.warnings = plan.warnings;
    for (const house of plan.buildings) this.addHouse(house, monument.archetype, monument.archetype);
    // §15.3: inside a fort `farm.features` is all false, so this loop draws
    // nothing there — a yard, a hearth and a well are a recipe for open ground.
    for (const feature of plan.features) {
      this.addBuilding(
        buildYardFeature(feature, (x, z) => this.options.groundAt(x, z), this.seedFor(monument.id)),
        monument.archetype,
        monument.archetype,
      );
    }
  }

  /** One building: its merged surfaces, and its trestle posts as instances. */
  private addHouse(spec: HouseSpec, archetype: string, gateArchetype: string): void {
    const build = buildHouse(spec, { groundAt: (x, z) => this.options.groundAt(x, z) });
    for (const part of build.parts) this.addBuilding(part, archetype, gateArchetype);
    for (const post of build.posts) {
      this.accents.push({
        archetype,
        gateArchetype,
        settlementOnly: true,
        kind: 'post',
        x: post.x,
        z: post.z,
        groundY: post.groundY,
        localY: 0,
        sizeM: post.diameterM,
        heightM: post.heightM,
        rotation: spec.rotationRad,
        tilt: 0,
        color: colour(SURFACE_COLOURS.timberPost),
      });
    }
  }

  /** One record's own headline monument — archetypes B, C, D, E. */
  private buildRecordMonument(monument: Monument, record: SiteRecord): void {
    const seed = this.seedFor(monument.id);
    const spec: ShapeSpec = {
      archetype: monument.archetype,
      form: monument.plan.form,
      // The **reconstructed** dimensions: §5.2 may have made this narrower and
      // taller than the register records, and that is the whole point.
      diameterM: monument.profile.diameterM,
      heightM: monument.profile.heightM,
      lengthM: scaleAxis(monument.plan.lengthM, monument.plan.diameterM, monument.profile.diameterM),
      widthM: scaleAxis(monument.plan.widthM, monument.plan.diameterM, monument.profile.diameterM),
      orientationDeg: monument.plan.orientationDeg,
      stoneM: monument.surface.stoneM,
      kind: profileKind(monument),
      seed,
    };
    this.addShape(spec, record.position.x, record.position.z, monument.archetype);

    // §5.2/§6.C: a kerb is drawn only where one is *recorded*. Inventing kerbs
    // would erase the very distinction the mound transform is gated on.
    if (monument.features.kerb) {
      this.addKerb(spec, record.position.x, record.position.z, monument);
    }
    if (monument.surface.centreStone) {
      this.addCentreStone(spec, record.position.x, record.position.z, monument);
    }
  }

  /** Archetype G — fill the extent with what the record says is in it. */
  private buildGraveField(monument: Monument, record: SiteRecord, summary: MonumentSummary): void {
    const rings = localRings(record);
    const placed = sampleGraveField(
      monument,
      record.position,
      rings,
      this.terrain(),
      this.seedFor(monument.id),
    );
    summary.sampled = placed.length;

    for (let i = 0; i < placed.length; i++) {
      const item = placed[i];
      if (item.archetype === 'standing-stone') {
        this.addStandingStone(item, this.seedFor(`${monument.id}#${i}`));
        continue;
      }
      const spec: ShapeSpec = {
        archetype: item.archetype,
        form: item.form,
        diameterM: item.diameterM,
        heightM: item.heightM,
        lengthM: null,
        widthM: null,
        orientationDeg: item.orientationDeg,
        stoneM: item.stoneM,
        // A sampled monument has no kerb record of its own, so it takes the
        // profile its archetype implies: mounds and cairns at repose, stone
        // settings and fire-cracked mounds left low.
        kind: item.archetype === 'mound' || item.archetype === 'cairn' ? 'cone' : 'platform',
        seed: this.seedFor(`${monument.id}#${i}`),
      };
      this.addShape(spec, item.x, item.z, item.archetype);
    }
  }

  /** Archetype A — the rampart, gated on §6.A.1's fortConfidence. */
  private buildFort(monument: Monument, summary: MonumentSummary): void {
    const crest = this.options.rampart;
    if (!crest || !monument.fort) return;
    const confident = fortIsConfident(monument, this.file.derivation.params);
    summary.fortDowngraded = !confident;
    const seed = this.seedFor(monument.id);

    for (const path of crest.paths) {
      const spec =
        monument.fort.ramparts.find((rampart) => rampart.id === path.id) ?? monument.fort.ramparts[0];
      if (!spec) continue;
      const options = {
        groundAt: (x: number, z: number) => this.options.groundAt(x, z),
        vitrified: this.options.vitrified ?? true,
        seed,
      };
      // §6.A.1: a record that does not meet the survey's operational definition
      // gets the bank the register records, not a Migration Period wall.
      const builds = confident
        ? buildRampart(path.points, path.closed, spec, options)
        : buildLowBank(path.points, path.closed, spec, options);
      for (const build of builds) this.addSweep(build, monument.archetype);
    }
  }

  // ------------------------------------------------------------- primitives --

  private batch(
    archetype: string,
    family: MaterialFamily,
    settlementOnly = false,
    gateArchetype = archetype,
  ): Batch {
    // The key carries whatever makes two batches behave differently, so two
    // things that switch on and off together are one draw call and two things
    // that do not are never merged into one.
    const key =
      `${archetype}${settlementOnly ? '#settlement' : ''}` +
      `${gateArchetype === archetype ? '' : `@${gateArchetype}`}:${family}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = {
        key,
        archetype,
        gateArchetype,
        settlementOnly,
        family,
        smooth: family === 'turf' || family === 'soil',
        positions: [],
        colors: [],
        indices: [],
        groundY: [],
        localY: [],
        mesh: null,
        groundArray: null,
        localArray: null,
      };
      this.batches.set(key, batch);
    }
    return batch;
  }

  private addShape(spec: ShapeSpec, cx: number, cz: number, archetype: string): void {
    const build = buildShape(spec);
    const batch = this.batch(archetype, build.material);
    const base = batch.positions.length / 3;
    // A monument sits on the ground under its own centre, and never *below* the
    // ground under any part of it: on a slope the uphill side merges into the
    // hill and the downhill side stands proud, which is what a built mound does.
    const centreGround = this.options.groundAt(cx, cz);
    const vertexCount = build.offsets.length / 3;

    for (let i = 0; i < vertexCount; i++) {
      const x = cx + build.offsets[i * 3];
      const z = cz + build.offsets[i * 3 + 2];
      const ground = Math.max(centreGround, this.options.groundAt(x, z));
      batch.positions.push(x, 0, z);
      batch.groundY.push(ground);
      batch.localY.push(build.offsets[i * 3 + 1]);
      batch.colors.push(build.colors[i * 3], build.colors[i * 3 + 1], build.colors[i * 3 + 2]);
    }
    for (let i = 0; i < build.indices.length; i++) batch.indices.push(base + build.indices[i]);
  }

  private addSweep(build: SweepBuild, archetype: string): void {
    const batch = this.batch(archetype, build.family);
    const base = batch.positions.length / 3;
    const vertexCount = build.localY.length;
    for (let i = 0; i < vertexCount; i++) {
      batch.positions.push(build.positionsXZ[i * 2], 0, build.positionsXZ[i * 2 + 1]);
      batch.groundY.push(this.options.groundAt(build.groundXZ[i * 2], build.groundXZ[i * 2 + 1]));
      batch.localY.push(build.localY[i]);
      batch.colors.push(build.colors[i * 3], build.colors[i * 3 + 1], build.colors[i * 3 + 2]);
    }
    for (let i = 0; i < build.indices.length; i++) batch.indices.push(base + build.indices[i]);
  }

  /**
   * One archetype-H surface: walls, roof, footing or a yard feature.
   *
   * Unlike `addShape` and `addSweep`, the ground is **already sampled** — a
   * building is rigid and takes one ground height for all its vertices, while a
   * yard drapes and takes one per vertex (see `longhouse.ts`). Both arrive here
   * as metres of unexaggerated ground, which is all this layer needs to keep
   * contract §0: `y = ground · exaggeration + trueMetricHeight`.
   */
  private addBuilding(build: BuildingBuild, archetype: string, gateArchetype: string): void {
    const batch = this.batch(archetype, build.family, true, gateArchetype);
    const base = batch.positions.length / 3;
    for (let i = 0; i < build.localY.length; i++) {
      batch.positions.push(build.positionsXZ[i * 2], 0, build.positionsXZ[i * 2 + 1]);
      batch.groundY.push(build.groundY[i]);
      batch.localY.push(build.localY[i]);
      batch.colors.push(build.colors[i * 3], build.colors[i * 3 + 1], build.colors[i * 3 + 2]);
    }
    for (let i = 0; i < build.indices.length; i++) batch.indices.push(base + build.indices[i]);
  }

  private addKerb(spec: ShapeSpec, cx: number, cz: number, monument: Monument): void {
    const stones = kerbPlacements(spec, monument.features.kerb?.stoneM ?? null);
    const random = mulberry32(spec.seed ^ 0x51ed);
    for (const stone of stones) {
      const x = cx + stone.x;
      const z = cz + stone.z;
      this.accents.push({
        archetype: monument.archetype,
        gateArchetype: monument.archetype,
        settlementOnly: false,
        kind: 'boulder',
        x,
        z,
        groundY: Math.max(this.options.groundAt(cx, cz), this.options.groundAt(x, z)),
        localY: stone.y,
        sizeM: stone.sizeM,
        heightM: stone.sizeM,
        rotation: stone.rotation,
        tilt: stone.tilt,
        color: colour(SURFACE_COLOURS.settingKerb).clone().lerp(colour(SURFACE_COLOURS.cairnStone), random()),
      });
    }
  }

  private addCentreStone(spec: ShapeSpec, cx: number, cz: number, monument: Monument): void {
    // §6.C: "a single large centre stone or earthfast boulder as the focus".
    const size = Math.max(0.5, mid(monument.surface.stoneM) * 2.2);
    this.accents.push({
      archetype: monument.archetype,
      gateArchetype: monument.archetype,
      settlementOnly: false,
      kind: 'boulder',
      x: cx,
      z: cz,
      groundY: this.options.groundAt(cx, cz),
      localY: profileHeight(spec.kind, 0, spec.diameterM / 2, Math.max(0.02, spec.heightM)) - size * 0.15,
      sizeM: size,
      heightM: size,
      rotation: mulberry32(spec.seed ^ 0x2c1f)() * Math.PI * 2,
      tilt: 0,
      color: colour(SURFACE_COLOURS.cairnStoneDark),
    });
  }

  private addStandingStone(item: PlacedMonument, seed: number): void {
    // §6.F: "stand the fallen ones back up" — the smallest operation with the
    // largest visual return in the feature. A row of upright stones reads
    // instantly as human intent; a row of fallen ones reads as nothing.
    const random = mulberry32(seed);
    this.accents.push({
      archetype: 'standing-stone',
      gateArchetype: 'standing-stone',
      settlementOnly: false,
      kind: 'standing',
      x: item.x,
      z: item.z,
      groundY: this.options.groundAt(item.x, item.z),
      localY: 0,
      sizeM: Math.max(0.35, item.diameterM * 0.6),
      heightM: item.heightM,
      rotation: (item.orientationDeg * Math.PI) / 180,
      tilt: (random() * 2 - 1) * 0.03,
      color: colour(SURFACE_COLOURS.cairnStone).clone().lerp(colour(SURFACE_COLOURS.settingStoneDark), random()),
    });
  }

  private addPickTarget(monument: Monument, record: SiteRecord): void {
    if (!this.pickMaterial) this.pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
    const radius = Math.max(4, monument.profile.diameterM * 0.6);
    const pick = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, Math.max(8, monument.profile.heightM * 3), 8),
      this.pickMaterial,
    );
    pick.position.set(record.position.x, 0, record.position.z);
    pick.userData = {
      siteId: monument.id,
      x: record.position.x,
      z: record.position.z,
      // A grave field's volume covers its whole extent, which is correct — its
      // monuments have no records of their own — so the handler needs to know
      // how specific this target is to break the tie with anything inside it.
      pickRadius: radius,
    };
    this.pickTargets.push(pick);
    this.pickGroup.add(pick);
  }

  // -------------------------------------------------------------- materials --

  private materialFor(family: MaterialFamily): THREE.Material {
    let material = this.materials.get(family);
    if (material) return material;
    const common = { vertexColors: true, metalness: 0.0 } as const;
    switch (family) {
      case 'turf':
        // §6.B: laid turf. Smooth-shaded, because the courses are the tell and
        // faceting would compete with them.
        material = new THREE.MeshStandardMaterial({ ...common, roughness: 0.95 });
        break;
      case 'soil':
        material = new THREE.MeshStandardMaterial({ ...common, roughness: 0.92 });
        break;
      case 'vitrified':
        // §7.2: dark, glassy, slag-like — the one shiny surface in the scene.
        material = new THREE.MeshStandardMaterial({
          ...common,
          roughness: 0.28,
          metalness: 0.12,
          flatShading: true,
        });
        break;
      default:
        // Flat shading computes face normals in the shader, so a cobbled surface
        // costs one vertex per cobble instead of three (see `shapes.buildShape`).
        material = new THREE.MeshStandardMaterial({ ...common, roughness: 0.82, flatShading: true });
    }
    this.materials.set(family, material);
    return material;
  }

  private materialise(): void {
    for (const batch of this.batches.values()) {
      if (batch.positions.length === 0) continue;
      const positions = new Float32Array(batch.positions);
      batch.groundArray = new Float32Array(batch.groundY);
      batch.localArray = new Float32Array(batch.localY);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(batch.colors), 3));
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(batch.indices), 1));
      // Normals are left to `refreshHeights`, which runs at the end of this
      // method: at this point every Y is still zero.
      geometry.setAttribute(
        'normal',
        new THREE.BufferAttribute(new Float32Array(batch.groundArray.length * 3), 3),
      );

      const mesh = new THREE.Mesh(geometry, this.materialFor(batch.family));
      mesh.name = `reconstruction-${batch.key}`;
      mesh.userData['archetype'] = batch.archetype;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      batch.mesh = mesh;
      this.group.add(mesh);
      this.vertexTotal += batch.groundArray.length;

      // Free the build-time scratch: the typed arrays are the record now.
      batch.positions.length = 0;
      batch.colors.length = 0;
      batch.indices.length = 0;
      batch.groundY.length = 0;
      batch.localY.length = 0;
    }

    this.materialiseAccents();
    this.refreshHeights();
  }

  private materialiseAccents(): void {
    const byKey = new Map<string, Accent[]>();
    for (const accent of this.accents) {
      const key = `${accent.archetype}:${accent.kind}:${accent.gateArchetype}:${accent.settlementOnly}`;
      const list = byKey.get(key);
      if (list) list.push(accent);
      else byKey.set(key, [accent]);
    }

    for (const [key, group] of byKey) {
      const [archetype, kind, gateArchetype, settlementOnly] = key.split(':');
      const geometry =
        kind === 'standing'
          ? standingStoneGeometry()
          : kind === 'post'
            ? postGeometry()
            : new THREE.IcosahedronGeometry(0.5, 0);
      const mesh = new THREE.InstancedMesh(geometry, this.materialFor('stone'), group.length);
      mesh.name = `reconstruction-accent-${key}`;
      mesh.userData['archetype'] = archetype;
      mesh.userData['gateArchetype'] = gateArchetype;
      mesh.userData['settlementOnly'] = settlementOnly === 'true';
      mesh.userData['accents'] = group;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const colors = new Float32Array(group.length * 3);
      group.forEach((accent, i) => {
        colors[i * 3] = accent.color.r;
        colors[i * 3 + 1] = accent.color.g;
        colors[i * 3 + 2] = accent.color.b;
      });
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      this.accentMeshes.push(mesh);
      this.group.add(mesh);
      this.vertexTotal += group.length * geometry.attributes['position'].count;
    }
  }

  private refreshAccents(exaggeration: number): void {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    for (const mesh of this.accentMeshes) {
      const group = mesh.userData['accents'] as Accent[];
      for (let i = 0; i < group.length; i++) {
        const accent = group[i];
        position.set(accent.x, accent.groundY * exaggeration + accent.localY, accent.z);
        euler.set(accent.tilt, accent.rotation, accent.tilt * 0.7, 'YXZ');
        quaternion.setFromEuler(euler);
        // True metric size, always: exaggeration touches the position only.
        scale.set(accent.sizeM, accent.heightM, accent.sizeM);
        mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }
}

/**
 * A standing stone: a unit-height tapered slab with its base at y = 0, so an
 * instance's Y scale *is* its height — the same convention `palisade.ts` uses.
 * §6.F: local granite, unworked, tapering upward.
 */
function standingStoneGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.28, 0.5, 1, 5, 1, false);
  geometry.scale(1, 1, 0.55); // a slab, not a post
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/**
 * A roof-bearing post of a trestle pair (§6.H), on the same convention: unit
 * height, base at y = 0, so the instance's Y scale is the post's own height.
 *
 * Six sides, because it is a split and dressed timber standing in a dark
 * interior seen through a doorway, and every side of it costs 88 houses' worth
 * of vertices at Ismantorp.
 */
function postGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.45, 0.5, 1, 6, 1, false);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/**
 * Scale a recorded plan axis by whatever §5.2 did to the diameter.
 *
 * A re-profiled mound is narrower than the register records; a rectangular one
 * has to shrink on both axes by the same factor, or the transform would silently
 * change its proportions as well as its size.
 */
function scaleAxis(axis: number | null, recordedD: number, reconstructedD: number): number | null {
  if (axis === null || !(recordedD > 0)) return null;
  return axis * (reconstructedD / recordedD);
}

/** `sites.json` geometry → local rings, or null for a point record (§3). */
export function localRings(record: SiteRecord): LocalRings | null {
  const geometry = record.geometryLocal;
  if (!geometry) return null;
  const coordinates = geometry.coordinates as unknown;
  switch (geometry.type) {
    case 'Polygon':
      return coordinates as LocalRings;
    case 'MultiPolygon': {
      const polygons = coordinates as LocalRings[];
      // The largest ring wins: a multipolygon extent is one field with outliers.
      let best: LocalRings | null = null;
      let bestArea = -Infinity;
      for (const polygon of polygons) {
        const area = ringArea(polygon[0] ?? []);
        if (area > bestArea) {
          bestArea = area;
          best = polygon;
        }
      }
      return best;
    }
    default:
      return null;
  }
}

function ringArea(ring: Array<[number, number]>): number {
  let total = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    total += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(total / 2);
}

/**
 * §8's periods for archetypes that only ever appear as grave-field constituents,
 * so a sampled cairn is gated even when the site has no cairn record of its own.
 */
const SAMPLED_PERIODS: Record<string, [number | null, number | null]> = {
  mound: [400, 1050],
  'stone-setting': [-500, 1050],
  cairn: [-1700, -500],
  'fire-cracked-mound': [-1700, -500],
  'standing-stone': [-1000, 1050],
};
