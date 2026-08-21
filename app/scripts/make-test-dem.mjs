#!/usr/bin/env node
/**
 * Generates the committed synthetic test site (docs/data-formats.md §5).
 *
 *   app/public/data/testsite/dem_core.tif       256 x 256 @ 1 m, int16 decimeters
 *   app/public/data/testsite/dem_context.tif    256 x 256 @ 2 m, int16 decimeters
 *   app/public/data/testsite/water_connect.tif  256 x 256 @ 2 m, int16 dm (§7)
 *   app/public/data/testsite/shoreline.json     century -> water level (§6)
 *   app/public/data/testsite/rampart.json       rampart crest polyline (§8)
 *   app/public/data/testsite/landcover.tif      256 x 256 @ 2 m, uint8 class ids (§9)
 *   app/public/data/testsite/landcover_legend.json  classes, palette, rules (§10)
 *   app/public/data/testsite/manifest.json      schemaVersion 1, fully conformant
 *
 * The point of this fixture is that the app never blocks on the Python pipeline:
 * `?site=testsite` exercises exactly the same code path as a real site, with no
 * branch on site id anywhere. The terrain is procedural — a hill carrying a
 * ~1.5 m rampart-like ring with two entrance gaps, a shorter outer arc, and a
 * diagonal valley — so low-angle shading is judgeable by eye.
 *
 * Both grids sample the *same* continuous height function at their own pixel
 * centres, which is also what makes the core/context seam a meaningful test.
 *
 * v1.1 (Phase 4) additions:
 *   • a deliberate **false basin** in the SE quadrant (contract §5): an enclosed
 *     depression whose floor sits below several table levels while its rim is
 *     above them, so the basin-exclusion behaviour of §7 is exercised by eye and
 *     by test. It lies wholly outside the core grid's extent, so the 1 m core
 *     DEM is bit-identical to the pre-v1.1 fixture.
 *   • the diagonal valley already reaches the southern grid edge at <1 m, which
 *     is where the rising sea enters the extent from outside.
 *
 * v1.2 (Phase 7) additions:
 *   • a land-cover class raster (§9) and its legend (§10), derived from the *same*
 *     closed-form terrain plus the §7 connectivity grid, for one reference century
 *     (500 CE). Five classes exercise every branch the app has: `conifer`,
 *     `broadleaf` and `reeds` vegetation plus two classes with `vegetation: null`.
 *     The false basin is a deliberate highlight: its floor lies below several table
 *     levels, so an elevation-only rule would call it sea — the connectivity rule
 *     makes it woodland instead.
 *
 * Run: npm run make-test-dem
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'data', 'testsite');

const ORIGIN = { e: 0, n: 0 };
const SCALE = 0.1; // int16 decimeters -> meters

const GRIDS = {
  core: { path: 'dem_core.tif', size: 256, resolution: 1 },
  context: { path: 'dem_context.tif', size: 256, resolution: 2 },
};

const CONNECT_PATH = 'water_connect.tif';
const SHORELINE_PATH = 'shoreline.json';
const RAMPART_PATH = 'rampart.json';
const LANDCOVER_PATH = 'landcover.tif';
const LANDCOVER_LEGEND_PATH = 'landcover_legend.json';

/**
 * The inner rampart ring the terrain function draws, restated as the crest
 * geometry (contract §8). No ridge *extraction* happens here: the generator knows
 * its own ring analytically, which is exactly what makes the fixture a clean test
 * of the app — the pipeline's DEM-ridge derivation is tested on the Python side.
 */
const RAMPART = {
  centreX: 0,
  centreZ: 0,
  radius: 45, // matches the `ring({ radius: 45, ... })` call in heightAt()
  densifyM: 0.5,
};

/**
 * The deliberate false basin (contract §5): a flat-floored bowl ringed by a
 * continuous rim, placed in the SE quadrant well away from the central hill and
 * wholly outside the core grid's ±128 m extent.
 *
 *   floor  ≈ base terrain (≈ 11.0 m) − DEPTH        → ≈ 5.0 m
 *   sill   ≈ lowest rim crest (SW side)             → ≈ 10 m
 *
 * So for every table level between those two the floor is *below* the water
 * level yet must stay dry: `dem ≤ h` floods it, `connect ≤ h` does not.
 */
export const FALSE_BASIN = {
  centreX: 180,
  centreZ: 180,
  /** Full depth out to this radius, then a smooth ramp back to grade. */
  floorRadius: 16,
  bowlRadius: 36,
  depth: 6.0,
  /** Gaussian rim ridge, clear of the bowl so it is never undercut by it. */
  rimRadius: 46,
  rimSigma: 7,
  rimHeight: 2.2,
};

/** Shoreline table (contract §6): SGU-shaped BP centuries, yearCE = 1950 − bp. */
const SHORELINE = {
  bpFrom: 3000, // yearCE −1050
  bpTo: 800, //  yearCE  1150
  bpStep: 100,
  levelMin: 2.0,
  levelSpan: 12.0,
  /** >1 = decelerating fall, the shape of a post-glacial uplift curve. */
  levelCurve: 1.35,
};

// ---------------------------------------------------------------- terrain ---

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const gauss = (d, sigma) => Math.exp(-(d * d) / (2 * sigma * sigma));

/** Smallest signed difference between two bearings, in degrees. */
function bearingDelta(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  return d;
}

/**
 * A rampart-like ring: a gaussian ridge at `radius` with entrance gaps.
 * `gaps` are [bearingDegrees, halfWidthDegrees] pairs.
 */
function ring(r, bearing, { radius, sigma, amplitude, gaps = [], arc = null }) {
  let f = gauss(r - radius, sigma);
  if (f < 1e-4) return 0;
  for (const [centre, halfWidth] of gaps) {
    const d = Math.abs(bearingDelta(bearing, centre));
    f *= smoothstep(halfWidth * 0.55, halfWidth, d);
  }
  if (arc) {
    const [centre, halfWidth] = arc;
    const d = Math.abs(bearingDelta(bearing, centre));
    f *= 1 - smoothstep(halfWidth * 0.8, halfWidth, d);
  }
  return amplitude * f;
}

/** Height in meters at local scene coordinates (x = east, z = south). */
export function heightAt(x, z) {
  const r = Math.hypot(x, z);
  // Compass bearing: 0 = north (-z), 90 = east (+x), clockwise.
  const bearing = (Math.atan2(x, -z) * 360) / TAU;

  let h = 13.0;

  // Regional tilt: ground rises gently toward the north.
  h += -z * 0.012;

  // The hill the fort sits on.
  h += 22 * gauss(r, 95);

  // A diagonal valley (running NE–SW), cut across the SW half of the extent.
  const perpendicular = (x - z) / Math.SQRT2;
  h -= 9.5 * gauss(perpendicular + 118, 48);

  // Inner rampart: ~1.5 m high, two entrances (WNW and ESE), like Broborg's.
  h += ring(r, bearing, {
    radius: 45,
    sigma: 3.4,
    amplitude: 1.5,
    gaps: [
      [292, 15],
      [112, 13],
    ],
  });

  // Outer rampart: shorter, lower, only an arc.
  h += ring(r, bearing, {
    radius: 67,
    sigma: 3.8,
    amplitude: 0.85,
    arc: [235, 105],
  });

  // A shallow interior hollow so the ring reads as an enclosure, not a bump.
  h -= 0.55 * gauss(r, 26);

  // The false basin (contract §5): flat floor, smooth walls, continuous rim.
  const b = FALSE_BASIN;
  const db = Math.hypot(x - b.centreX, z - b.centreZ);
  h -= b.depth * (1 - smoothstep(b.floorRadius, b.bowlRadius, db));
  h += b.rimHeight * gauss(db - b.rimRadius, b.rimSigma);

  // Micro-relief so the shading has texture at 1 m (deterministic, no RNG).
  h += 0.22 * Math.sin(x * 0.087) * Math.cos(z * 0.071);
  h += 0.13 * Math.sin((x + z) * 0.19 + 1.3);
  h += 0.07 * Math.sin(x * 0.41 - 0.7) * Math.sin(z * 0.37 + 2.1);

  return h;
}

// ------------------------------------------------- water: §7 connectivity ---

/**
 * Priority-flood (Barnes et al. 2014) over the context grid, contract §7.
 *
 * `connect(cell)` = min over all 4-connected paths from any grid-edge cell to
 * this cell of the max elevation along the path, floored at the cell's own
 * elevation. Equivalently: the water level at which the cell first becomes
 * hydrologically connected to the open sea, with every edge cell a sea entry.
 *
 * Run directly on the int16-**decimeter** grid the app will decode, so the
 * result is already integral: the contract's CEIL to decimeters is a no-op and
 * the file agrees exactly, cell for cell, with a brute-force flood fill of the
 * committed DEM (which is what `tests/testsiteWater.test.ts` checks).
 *
 * 65 536 cells, so a plain binary heap over (key, index) is ample.
 */
function priorityFlood(dem, width, height) {
  const n = width * height;
  const connect = new Int16Array(n);
  const seen = new Uint8Array(n);

  // Binary min-heap over parallel key/index arrays. Capacity n is sufficient:
  // every cell is pushed exactly once (it is marked `seen` at push time).
  const keys = new Int32Array(n);
  const idx = new Int32Array(n);
  let size = 0;

  const push = (key, i) => {
    let c = size++;
    keys[c] = key;
    idx[c] = i;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (keys[p] <= keys[c]) break;
      [keys[p], keys[c]] = [keys[c], keys[p]];
      [idx[p], idx[c]] = [idx[c], idx[p]];
      c = p;
    }
  };

  const pop = () => {
    const topKey = keys[0];
    const topIdx = idx[0];
    size--;
    if (size > 0) {
      keys[0] = keys[size];
      idx[0] = idx[size];
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < size && keys[l] < keys[m]) m = l;
        if (r < size && keys[r] < keys[m]) m = r;
        if (m === p) break;
        [keys[p], keys[m]] = [keys[m], keys[p]];
        [idx[p], idx[m]] = [idx[m], idx[p]];
        p = m;
      }
    }
    return { key: topKey, i: topIdx };
  };

  // Sea entry = every grid-edge cell (contract §7).
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (row !== 0 && row !== height - 1 && col !== 0 && col !== width - 1) continue;
      const i = row * width + col;
      seen[i] = 1;
      connect[i] = dem[i];
      push(dem[i], i);
    }
  }

  while (size > 0) {
    const { key, i } = pop();
    const row = (i / width) | 0;
    const col = i - row * width;
    // 4-connectivity: water does not leak between diagonal land cells (§7).
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || c >= width || r < 0 || r >= height) continue;
      const j = r * width + c;
      if (seen[j]) continue;
      seen[j] = 1;
      const spill = dem[j] > key ? dem[j] : key;
      connect[j] = spill;
      push(spill, j);
    }
  }

  return connect;
}

// -------------------------------------------------- water: §6 level table ---

/**
 * Level (m) at a year read off the *committed table*, linearly interpolated between
 * steps exactly as the app's `levelAt` does. The reference century need not land on
 * an SGU-shaped BP step (500 CE does not), and contract §10 says `referenceLevelM`
 * comes from the §6 table — so the land-cover model must read the table, not the
 * closed form behind it, or the two would disagree by the rounding.
 */
function tableLevelAt(steps, yearCE) {
  if (yearCE <= steps[0].yearCE) return steps[0].levelM;
  const last = steps[steps.length - 1];
  if (yearCE >= last.yearCE) return last.levelM;
  for (let i = 1; i < steps.length; i++) {
    const b = steps[i];
    if (b.yearCE < yearCE) continue;
    const a = steps[i - 1];
    const t = (yearCE - a.yearCE) / (b.yearCE - a.yearCE);
    return a.levelM + (b.levelM - a.levelM) * t;
  }
  return last.levelM;
}

/** Level (m) for a calendar year, on the synthetic decelerating uplift curve. */
function levelForYear(yearCE) {
  const yOld = 1950 - SHORELINE.bpFrom;
  const yNew = 1950 - SHORELINE.bpTo;
  const t = (yNew - yearCE) / (yNew - yOld); // 1 at the oldest step, 0 at the newest
  return Number((SHORELINE.levelMin + SHORELINE.levelSpan * t ** SHORELINE.levelCurve).toFixed(1));
}

function buildShorelineSteps() {
  const steps = [];
  for (let bp = SHORELINE.bpFrom; bp >= SHORELINE.bpTo; bp -= SHORELINE.bpStep) {
    const yearCE = 1950 - bp;
    steps.push({ yearCE, bp, levelM: levelForYear(yearCE) });
  }
  // Contract §6 invariants, asserted here so a bad curve can never be committed.
  for (let i = 1; i < steps.length; i++) {
    if (!(steps[i].yearCE > steps[i - 1].yearCE)) throw new Error('shoreline steps must ascend by yearCE');
    if (!(steps[i].levelM <= steps[i - 1].levelM)) throw new Error('shoreline levelM must be non-increasing');
  }
  if (steps.length < 2) throw new Error('shoreline needs >= 2 steps');
  return steps;
}

// --------------------------------------------------- rampart: §8 crest ring --

/**
 * The crest ring as a closed polyline, densified to ~0.5 m (contract §8):
 * local [x, z] pairs, last point != first, no heights (the app samples those).
 */
function buildRampartPath() {
  const circumference = TAU * RAMPART.radius;
  const count = Math.round(circumference / RAMPART.densifyM);
  const points = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * TAU;
    points.push([
      Number((RAMPART.centreX + RAMPART.radius * Math.sin(angle)).toFixed(2)),
      Number((RAMPART.centreZ - RAMPART.radius * Math.cos(angle)).toFixed(2)),
    ]);
  }

  let lengthM = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (step > 1.0) throw new Error(`rampart point spacing ${step.toFixed(2)} m exceeds the 1 m contract limit`);
    lengthM += step;
  }
  if (points.length < 3) throw new Error('rampart needs >= 3 points');

  return { id: 'inner', name: 'Inner rampart', closed: true, lengthM: Number(lengthM.toFixed(1)), points };
}

// ------------------------------------------- land cover: §9/§10 rule model ---

/**
 * The land-cover rule model (contract §9/§10), for ONE reference century.
 *
 * Every rule below reads only two things the fixture already has: the context DEM
 * and the §7 connectivity grid. That is deliberate — the classes are a *derivation*
 * of the same closed-form terrain, so the raster can never disagree with the ground
 * it is painted on, and the rule strings shipped in the legend are literally the
 * rules the code applies (contract §10 requires them verbatim in the methods panel;
 * a paraphrase here would be a lie there).
 */
export const LANDCOVER = {
  referenceYearCE: 500,
  /** How far above the reference level the shore/reed band reaches, meters. */
  reedBandM: 1.2,
  /** Ground below this height above the reference level counts as damp low ground. */
  lowGroundM: 4.0,
  /** Slope (m/m) at which the flanks count as forested rather than open. */
  forestSlope: 0.05,
  /** Radius (m) of the fort's cleared crown around the site origin. */
  clearedRadiusM: 58,
};

/** Central-difference slope (m/m) of the decimeter grid at (col, row). */
function slopeAt(dem, size, resolution, col, row) {
  const at = (c, r) => dem[Math.min(size - 1, Math.max(0, r)) * size + Math.min(size - 1, Math.max(0, c))];
  const dx = ((at(col + 1, row) - at(col - 1, row)) * SCALE) / (2 * resolution);
  const dz = ((at(col, row + 1) - at(col, row - 1)) * SCALE) / (2 * resolution);
  return Math.hypot(dx, dz);
}

/**
 * Class index for one cell. Order matters: water and shore are decided by
 * connectivity before anything looks at elevation, which is exactly how the false
 * basin escapes being called sea.
 */
function classifyCell({ x, z, demM, connectM, slope, levelM }) {
  if (connectM <= levelM) return 0; // sea at the reference level
  if (connectM <= levelM + LANDCOVER.reedBandM) return 1; // shore band
  if (Math.hypot(x, z) <= LANDCOVER.clearedRadiusM) return 4; // the fort's crown
  if (demM - levelM < LANDCOVER.lowGroundM) return 2; // damp low ground
  if (slope >= LANDCOVER.forestSlope) return 3; // hill flanks
  return 4; // gentle high ground
}

/** The §10 class list, with the rules stated exactly as `classifyCell` applies them. */
function landcoverClasses(levelM) {
  const m = (v) => v.toFixed(1);
  return [
    {
      index: 0,
      id: 'water',
      name: `Water (sea, ~${LANDCOVER.referenceYearCE} CE)`,
      color: '#2d5a6b',
      rule:
        `Sea-connectivity value at or below the ${m(levelM)} m reference water level ` +
        '(connect ≤ level, docs/data-formats.md §7) — wet AND connected to the open sea, so enclosed ' +
        'basins below that level are excluded.',
      vegetation: null,
    },
    {
      index: 1,
      id: 'reeds',
      name: 'Reed bed and shore fen',
      color: '#7f9455',
      rule:
        `Dry at the reference level but flooded by a further ${LANDCOVER.reedBandM} m rise ` +
        `(connect ≤ ${m(levelM + LANDCOVER.reedBandM)} m): the shallow, seasonally wet shore band.`,
      vegetation: { type: 'reeds', densityPerHa: 600 },
    },
    {
      index: 2,
      id: 'broadleaf',
      name: 'Damp broadleaf woodland',
      color: '#5c7f3c',
      rule:
        `Dry ground less than ${LANDCOVER.lowGroundM} m above the reference level ` +
        `(below ${m(levelM + LANDCOVER.lowGroundM)} m), outside the fort's cleared crown — the valley ` +
        'floors and the enclosed basin.',
      vegetation: { type: 'broadleaf', densityPerHa: 90 },
    },
    {
      index: 3,
      id: 'conifer',
      name: 'Conifer forest',
      color: '#33512f',
      rule:
        `Ground at least ${LANDCOVER.lowGroundM} m above the reference level whose DEM slope is at least ` +
        `${(LANDCOVER.forestSlope * 100).toFixed(0)} % — the hill flanks, the rampart ring and the basin rim.`,
      vegetation: { type: 'conifer', densityPerHa: 120 },
    },
    {
      index: 4,
      id: 'open',
      name: 'Open grazed ground',
      color: '#a9a267',
      rule:
        `Everything else: gentle high ground below ${(LANDCOVER.forestSlope * 100).toFixed(0)} % slope, plus a ` +
        `${LANDCOVER.clearedRadiusM} m cleared radius around the fort itself.`,
      vegetation: null,
    },
  ];
}

/**
 * Build the §9 class raster on the context geometry and the §10 legend that
 * describes it, asserting the contract's invariants as it goes.
 */
function buildLandcover({ spec, grid }, connect) {
  const { size, resolution } = spec;
  const levelM = Number(tableLevelAt(buildShorelineSteps(), LANDCOVER.referenceYearCE).toFixed(2));
  const classes = landcoverClasses(levelM);
  const raw = new Uint8Array(size * size);
  const counts = new Int32Array(classes.length);

  for (let row = 0; row < size; row++) {
    const z = grid.boundsLocal.minZ + (row + 0.5) * resolution;
    for (let col = 0; col < size; col++) {
      const x = grid.boundsLocal.minX + (col + 0.5) * resolution;
      const i = row * size + col;
      const index = classifyCell({
        x,
        z,
        demM: grid.raw[i] * SCALE,
        connectM: connect[i] * SCALE,
        slope: slopeAt(grid.raw, size, resolution, col, row),
        levelM,
      });
      raw[i] = index;
      counts[index]++;
    }
  }

  // Contract §9/§10 invariants — asserted here so a bad rule set can never be
  // committed, exactly like the shoreline and rampart checks above.
  if (classes.length > 32) throw new Error('landcover: at most 32 classes (§9)');
  classes.forEach((c, i) => {
    if (c.index !== i) throw new Error(`landcover: class indices must be contiguous from 0 (§10), got ${c.index} at ${i}`);
    if (!/^#[0-9a-f]{6}$/i.test(c.color)) throw new Error(`landcover: class ${c.id} color must be #rrggbb (§10)`);
    if (c.vegetation && !['conifer', 'broadleaf', 'reeds'].includes(c.vegetation.type)) {
      throw new Error(`landcover: class ${c.id} vegetation.type is not a §10 type`);
    }
    if (c.vegetation && !(c.vegetation.densityPerHa > 0)) {
      throw new Error(`landcover: class ${c.id} densityPerHa must be > 0 (§10)`);
    }
    if (counts[i] === 0) {
      throw new Error(`landcover: class ${c.id} has no cells — the fixture must exercise every class it declares`);
    }
  });
  if (new Set(classes.map((c) => c.id)).size !== classes.length) throw new Error('landcover: class ids must be unique (§10)');
  for (const value of raw) {
    if (value >= classes.length) throw new Error(`landcover: raw value ${value} is not a valid class index (§9)`);
  }

  // areaFraction: rounded for legibility, then the largest class absorbs the
  // rounding error so the set still sums to 1 ± 0.001 (§10).
  const total = size * size;
  const fractions = classes.map((_, i) => Number((counts[i] / total).toFixed(4)));
  const largest = fractions.indexOf(Math.max(...fractions));
  fractions[largest] = Number((fractions[largest] + (1 - fractions.reduce((a, b) => a + b, 0))).toFixed(6));
  const sum = fractions.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.001) throw new Error(`landcover: areaFraction sums to ${sum}, not 1 ± 0.001 (§10)`);
  classes.forEach((c, i) => {
    c.areaFraction = fractions[i];
  });

  const legend = {
    schemaVersion: 1,
    site: 'testsite',
    referenceYearCE: LANDCOVER.referenceYearCE,
    referenceLevelM: levelM,
    method:
      'SYNTHETIC TEST DATA — no soil map, pollen record or rule engine was consulted. Classes are derived ' +
      'by app/scripts/make-test-dem.mjs from the fixture\'s own closed-form terrain and its §7 ' +
      `connectivity grid, for the single reference century ${LANDCOVER.referenceYearCE} CE at the ` +
      `${levelM.toFixed(2)} m level its synthetic shoreline table gives at that year. It exists so the app's Phase-7 ` +
      'land-cover feature can be exercised end to end against app/public/data/testsite/ without the Python ' +
      'pipeline. A real site derives its classes from SGU Jordarter plus the DEM.',
    caveat:
      'Synthetic test data — a rule model of one century, not a survey of past vegetation. ' +
      '(A real site states the rule engine\'s own caveat here.)',
    calibration:
      'SYNTHETIC TEST DATA — not calibrated against anything. The forest/open split here is whatever the ' +
      'closed-form hill produces; a real site reports its forest/open ratio against the regional pollen ' +
      'literature (PLAN §2.5).',
    source: {
      product: 'Synthetic — app/scripts/make-test-dem.mjs',
      fetched: new Date().toISOString().slice(0, 10),
    },
    classes,
  };

  return { raw, legend, counts, levelM };
}

/** What the vegetation layer will instance, so a reviewer can sanity-check the load. */
function reportVegetation(legend, counts, resolution) {
  const cellArea = resolution * resolution;
  let total = 0;
  const parts = legend.classes.map((c, i) => {
    const ha = (counts[i] * cellArea) / 10_000;
    const instances = c.vegetation ? Math.round(ha * c.vegetation.densityPerHa) : 0;
    total += instances;
    return `${c.id} ${(c.areaFraction * 100).toFixed(1)} %${c.vegetation ? ` (~${instances} ${c.vegetation.type})` : ''}`;
  });
  return { line: parts.join(', '), total };
}

// ------------------------------------------------------------------ output --

function buildGrid({ size, resolution }) {
  // boundsLocal, concentric on the origin (contract §1: minZ is the NORTH edge).
  const halfExtent = (size * resolution) / 2;
  const boundsLocal = { minX: -halfExtent, minZ: -halfExtent, maxX: halfExtent, maxZ: halfExtent };
  const bounds3006 = {
    minE: ORIGIN.e + boundsLocal.minX,
    maxE: ORIGIN.e + boundsLocal.maxX,
    // northing = origin.n − z, so maxZ (south edge) gives minN.
    minN: ORIGIN.n - boundsLocal.maxZ,
    maxN: ORIGIN.n - boundsLocal.minZ,
  };

  const raw = new Int16Array(size * size);
  let minRaw = Infinity;
  let maxRaw = -Infinity;
  for (let row = 0; row < size; row++) {
    // Row 0 = northernmost row; rows grow southward = +z.
    const z = boundsLocal.minZ + (row + 0.5) * resolution;
    for (let col = 0; col < size; col++) {
      const x = boundsLocal.minX + (col + 0.5) * resolution;
      const dm = Math.round(heightAt(x, z) / SCALE);
      raw[row * size + col] = dm;
      if (dm < minRaw) minRaw = dm;
      if (dm > maxRaw) maxRaw = dm;
    }
  }

  return {
    raw,
    boundsLocal,
    bounds3006,
    minElevation: Number((minRaw * SCALE).toFixed(1)),
    maxElevation: Number((maxRaw * SCALE).toFixed(1)),
  };
}

function writeTiff(file, raw, size, resolution, bounds3006) {
  // NOTE (geotiff 3.0.5): the writer's `encodeImage` only knows how to serialise
  // Float64/Float32/Uint32/Uint16/Uint8 arrays — an Int16Array silently writes a
  // strip of zero bytes. Two's-complement means the *bytes* are identical, so we
  // hand it a Uint16 view of the same buffer and declare `SampleFormat: [2]`
  // (signed int) explicitly; readers then decode band 1 straight back to Int16.
  //
  // A Uint8Array (the §9 class raster) needs none of that: it is written as-is,
  // 8 bits per sample, SampleFormat 1 (unsigned int).
  const isBytes = raw instanceof Uint8Array;
  const samples = isBytes ? raw : new Uint16Array(raw.buffer, raw.byteOffset, raw.length);

  const arrayBuffer = writeArrayBuffer(samples, {
    width: size,
    height: size,
    BitsPerSample: [isBytes ? 8 : 16],
    SampleFormat: [isBytes ? 1 : 2], // 1 = unsigned int, 2 = two's-complement signed
    PhotometricInterpretation: 1,
    SamplesPerPixel: [1],
    // EPSG:3006 horizontal only — the vertical CRS is deliberately absent
    // (docs/data-formats.md §1). The app ignores this anyway; it is here so the
    // fixture opens sensibly in GDAL/QGIS.
    GTModelTypeGeoKey: 1, // projected
    GTRasterTypeGeoKey: 1, // RasterPixelIsArea
    ProjectedCSTypeGeoKey: 3006,
    PCSCitationGeoKey: 'SWEREF99 TM',
    ModelPixelScale: [resolution, resolution, 0],
    // Tiepoint ties raster (0,0) — the NW corner of the NW pixel — to (minE, maxN).
    ModelTiepoint: [0, 0, 0, bounds3006.minE, bounds3006.maxN, 0],
  });
  writeFileSync(file, Buffer.from(arrayBuffer));
  return arrayBuffer.byteLength;
}

/**
 * Print what the false basin actually came out as (floor, sill, the level window
 * in which it is below water yet dry) — the numbers a reviewer screenshots against.
 */
function reportFalseBasin({ spec, grid }, connect) {
  const { size, resolution } = spec;
  const toCol = (x) => Math.round((x - grid.boundsLocal.minX) / resolution - 0.5);
  const toRow = (z) => Math.round((z - grid.boundsLocal.minZ) / resolution - 0.5);
  const b = FALSE_BASIN;

  let floorDm = Infinity;
  let sillDm = Infinity;
  const radius = Math.ceil(b.floorRadius / resolution);
  const cc = toCol(b.centreX);
  const cr = toRow(b.centreZ);
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (Math.hypot(dc, dr) * resolution > b.floorRadius) continue;
      const i = (cr + dr) * size + (cc + dc);
      floorDm = Math.min(floorDm, grid.raw[i]);
      sillDm = Math.min(sillDm, connect[i]);
    }
  }

  const steps = buildShorelineSteps();
  const window = steps.filter((s) => s.levelM * 10 >= floorDm && s.levelM * 10 < sillDm);
  console.log(
    `false basin at local (x ${b.centreX}, z ${b.centreZ}) — floor ${(floorDm * SCALE).toFixed(1)} m, ` +
      `sill ${(sillDm * SCALE).toFixed(1)} m; below water yet dry for ` +
      (window.length
        ? `${window.length} table steps (${window[0].yearCE}…${window[window.length - 1].yearCE} CE, ` +
          `levels ${window[0].levelM}–${window[window.length - 1].levelM} m)`
        : 'NO table step — check the parameters'),
  );
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const built = {};
  for (const [name, spec] of Object.entries(GRIDS)) {
    const grid = buildGrid(spec);
    const bytes = writeTiff(join(OUT_DIR, spec.path), grid.raw, spec.size, spec.resolution, grid.bounds3006);
    built[name] = { spec, grid };
    console.log(
      `${spec.path}: ${spec.size}x${spec.size} @ ${spec.resolution} m, ` +
        `z ${grid.minElevation}–${grid.maxElevation} m, ${(bytes / 1024).toFixed(0)} KiB`,
    );
  }

  // --- §7 sea-connectivity grid, geometry identical to grids.context ---------
  const context = built.context;
  const connect = priorityFlood(context.grid.raw, context.spec.size, context.spec.size);
  const connectBytes = writeTiff(
    join(OUT_DIR, CONNECT_PATH),
    connect,
    context.spec.size,
    context.spec.resolution,
    context.grid.bounds3006,
  );
  reportFalseBasin(context, connect);
  console.log(
    `${CONNECT_PATH}: ${context.spec.size}x${context.spec.size} @ ${context.spec.resolution} m, ` +
      `priority-flood (4-connected, edge = sea), ${(connectBytes / 1024).toFixed(0)} KiB`,
  );

  // --- §6 century -> level table --------------------------------------------
  const steps = buildShorelineSteps();
  const shoreline = {
    schemaVersion: 1,
    site: 'testsite',
    method:
      'SYNTHETIC TEST DATA — no shoreline model was consulted. Levels come from the closed form ' +
      `${SHORELINE.levelMin} + ${SHORELINE.levelSpan}·t^${SHORELINE.levelCurve} m (t = 1 at the oldest step, ` +
      '0 at the newest), a plausible decelerating post-glacial uplift curve over SGU-shaped BP centuries ' +
      '(yearCE = 1950 − bp). It exists so the app\'s Phase-4 water feature can be exercised end to end ' +
      'against app/public/data/testsite/ without the Python pipeline.',
    uncertainty: 'Synthetic test data — not a shoreline model. (A real site states the SGU ±500 yr caveat here.)',
    datumNote: 'Levels are meters in the fixture\'s notional RH 2000 datum, same datum as the synthetic DEM.',
    source: {
      product: 'Synthetic — app/scripts/make-test-dem.mjs',
      fetched: new Date().toISOString().slice(0, 10),
    },
    steps,
  };
  writeFileSync(join(OUT_DIR, SHORELINE_PATH), `${JSON.stringify(shoreline, null, 2)}\n`);
  console.log(
    `${SHORELINE_PATH}: ${steps.length} steps, ${steps[0].yearCE}–${steps[steps.length - 1].yearCE} CE, ` +
      `levels ${steps[0].levelM}–${steps[steps.length - 1].levelM} m`,
  );

  // --- §8 rampart crest ------------------------------------------------------
  const rampartPath = buildRampartPath();
  const rampart = {
    schemaVersion: 1,
    site: 'testsite',
    derivation: {
      method: 'dem-ridge',
      description:
        'SYNTHETIC TEST DATA — no ridge extraction was run. The ring is the closed form used by ' +
        `app/scripts/make-test-dem.mjs to draw the fixture's rampart into the DEM (radius ` +
        `${RAMPART.radius} m about the site origin), densified to ${RAMPART.densifyM} m. It exists so the ` +
        "app's Phase-5 palisade can be exercised end to end against app/public/data/testsite/ " +
        'without the Python pipeline. A real site derives this line from its LiDAR DEM.',
      generated: new Date().toISOString().slice(0, 10),
      params: { radiusM: RAMPART.radius, densifyM: RAMPART.densifyM, synthetic: true },
    },
    paths: [rampartPath],
  };
  writeFileSync(join(OUT_DIR, RAMPART_PATH), `${JSON.stringify(rampart, null, 2)}\n`);
  console.log(
    `${RAMPART_PATH}: ${rampartPath.points.length} points, ${rampartPath.lengthM} m closed ring ` +
      `at radius ${RAMPART.radius} m`,
  );

  // --- §9 land-cover class raster + §10 legend -------------------------------
  const { raw: landcoverRaw, legend: landcoverLegend, counts: landcoverCounts } = buildLandcover(context, connect);
  const landcoverBytes = writeTiff(
    join(OUT_DIR, LANDCOVER_PATH),
    landcoverRaw,
    context.spec.size,
    context.spec.resolution,
    context.grid.bounds3006,
  );
  writeFileSync(join(OUT_DIR, LANDCOVER_LEGEND_PATH), `${JSON.stringify(landcoverLegend, null, 2)}\n`);
  const vegetationReport = reportVegetation(landcoverLegend, landcoverCounts, context.spec.resolution);
  console.log(
    `${LANDCOVER_PATH}: ${context.spec.size}x${context.spec.size} @ ${context.spec.resolution} m, uint8, ` +
      `${landcoverLegend.classes.length} classes, ${(landcoverBytes / 1024).toFixed(0)} KiB`,
  );
  console.log(
    `${LANDCOVER_LEGEND_PATH}: ${LANDCOVER.referenceYearCE} CE at ${landcoverLegend.referenceLevelM.toFixed(1)} m — ` +
      `${vegetationReport.line}; ~${vegetationReport.total} vegetation instances at density x1`,
  );

  const gridManifest = (name) => {
    const { spec, grid } = built[name];
    return {
      path: spec.path,
      resolution: spec.resolution,
      width: spec.size,
      height: spec.size,
      bounds3006: grid.bounds3006,
      boundsLocal: grid.boundsLocal,
      encoding: { dtype: 'int16', scale: SCALE, unit: 'm' },
      minElevation: grid.minElevation,
      maxElevation: grid.maxElevation,
    };
  };

  const manifest = {
    schemaVersion: 1,
    site: {
      id: 'testsite',
      name: 'Synthetic test site',
    },
    crs: {
      horizontal: 'EPSG:3006',
      verticalDatum: 'RH2000',
    },
    origin: { e: ORIGIN.e, n: ORIGIN.n },
    grids: {
      core: gridManifest('core'),
      context: gridManifest('context'),
    },
    assets: {
      shoreline: SHORELINE_PATH,
      waterConnect: CONNECT_PATH,
      rampart: RAMPART_PATH,
      landcover: LANDCOVER_PATH,
      landcoverLegend: LANDCOVER_LEGEND_PATH,
    },
    layers: [
      { id: 'terrain', name: 'Terrain (synthetic)', provenance: 'model' },
      // Same shape as Broborg's `water` entry (contract §2/§6); the name says
      // "synthetic" because nothing here came from SGU (PLAN §6.1 honesty).
      { id: 'water', name: 'Paleo-shoreline (synthetic model)', provenance: 'model' },
      // Contract v1.2 order: terrain, sites, water, landcover, palisade.
      { id: 'landcover', name: 'Modeled landscape (synthetic rule model)', provenance: 'model' },
      // The provenance is the one value the pipeline validator allows here (PLAN §6.1).
      { id: 'palisade', name: 'Palisade (conjectural)', provenance: 'conjecture' },
    ],
    attribution: [
      {
        text: 'Synthetic fixture — procedurally generated by app/scripts/make-test-dem.mjs. Not real elevation data.',
        license: 'MIT',
      },
      {
        // The slot the contract v1.1/v1.2 preamble reserves for the SGU CC0 line,
        // widened for the land-cover pair. A real site says "Jordarts- och
        // strandförskjutningsdata från Sveriges geologiska undersökning (CC0)";
        // this fixture must not, because none of it came from SGU (PLAN §6.1).
        text: 'Jordarts- och strandförskjutning: synthetic test data — not from Sveriges geologiska undersökning.',
        license: 'MIT',
      },
    ],
    provenance: {
      generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      pipeline: 'app/scripts/make-test-dem.mjs',
      sources: [],
      processing: [
        'procedural height function (hill + rampart ring with two entrance gaps + outer arc + diagonal valley + false basin)',
        'sampled at pixel centres',
        'int16 dm quantization',
        'uncompressed single-strip GeoTIFF',
        'priority-flood sea connectivity over the context grid (4-connected, every edge cell a sea entry)',
        'synthetic century -> level table on SGU-shaped BP centuries',
        'rampart crest ring restated from the same closed form that drew it (no ridge extraction)',
        'land-cover rule model over the context grid (connectivity + height above the reference level + DEM slope)',
        'uint8 class raster on the grids.context geometry, one reference century',
      ],
    },
  };

  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest.json written to ${OUT_DIR}`);
}

// Only run when invoked directly, so tests can import `heightAt`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
