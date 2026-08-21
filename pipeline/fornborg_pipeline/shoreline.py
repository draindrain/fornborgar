"""Century -> water-level table for one site (docs/data-formats.md §6, PLAN.md §2.4).

SGU's *strandförskjutningsmodell* publishes, per 100-year step, polygons of where
sea (`code` 1 = Hav) and lakes (`code` 4 = Sjö) stood — modelled from the Påsse &
Daniels (2015) shore-level equations over a **50 m** DEM. We do not ship those
polygons: we ship one number per century, the water level in meters RH 2000, and
draw it on our own 1 m/2 m LiDAR terrain.

Derivation, per century step:

1. Fetch the Hav polygons intersecting the site's context extent from the SGU OGC
   API (raw GeoJSON cached under `data-cache/`, reused on rerun).
2. Densify their boundaries to the context grid spacing and sample our DEM at each
   point. Points outside the extent are dropped, and so are points within
   `EDGE_MARGIN_CELLS` of the extent edge — those follow the clip boundary, not a
   shoreline, and would drag the estimate toward whatever the terrain happens to
   be at the frame edge.
3. Take the **median** of the remaining samples. SGU's boundary is a 50 m-DEM
   contour, so any single point is coarse; the median over thousands of samples is
   the estimator, and it is robust to the tail of samples that land on a bank.
4. Steps whose modelled sea has already withdrawn past the extent yield no
   boundary to sample. They are filled from a least-squares trend through the
   measured steps (`TREND_DEGREE`), which is the honest thing to do and is stated
   in the `method` text the app shows.
5. The table is clamped monotone non-increasing (post-glacial uplift only lowers
   the sea over this range) and checked against the PLAN.md §2.4 literature
   anchors. Anchors are a hard gate: a failure means the derivation is wrong, and
   the fix is the derivation, never the number.

BP is years before 1950 (`yearCE = 1950 - bp`); BP 1100 is missing from the SGU
product [phase-0 verified], so that century simply has no entry (contract §6).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Sequence

import numpy as np
from pyproj import Transformer

from .clip_dem import sample_nearest_many
from .fetch_dem import wgs84_bbox
from .sgu import MAX_PAGES, PAGE_LIMIT, page_features
from .sites import CACHE_DIR, EPSG_HORIZONTAL, SiteConfig

SHORELINE_PATH = "shoreline.json"
SCHEMA_VERSION = 1

STRAND_API = "https://api.sgu.se/oppnadata/strandforskjutningsmodell/ogc/features/v1"
STRAND_PRODUCT = "SGU Strandförskjutningsmodell"
# The product's 14 collections [phase-0 verified]; each holds one BP decade-range.
STRAND_COLLECTIONS = (
    "bp1-900",
    "bp1000-1900",
    "bp2000-2900",
    "bp3000-3900",
    "bp4000-4900",
    "bp5000-5900",
    "bp6000-6900",
    "bp7000-7900",
    "bp8000-8900",
    "bp9000-9900",
    "bp10000-10900",
    "bp11000-11900",
    "bp12000-12900",
    "bp13000-13500",
)

CODE_HAV = 1  # sea — the only class we derive levels from
CODE_SJO = 4  # lake — modelled by filling low points, "ytterst ungefärliga" per SGU

# Slider range, PLAN.md §3 phase 4: ~1000 BCE .. ~1200 CE.
BP_OLDEST = 3000  # yearCE -1050
BP_YOUNGEST = 800  # yearCE  1150

EDGE_MARGIN_CELLS = 2.0  # boundary samples this close to the extent edge are clip artifacts
MIN_BOUNDARY_SAMPLES = 50  # fewer than this and the median is not an estimate
TREND_DEGREE = 1  # least-squares fit used to fill steps with no boundary in frame
MAX_ISOTONIC_CLAMP = 0.5  # m; a bigger upward wobble is a bug, not noise

# PLAN.md §2.4 / contract §6: (yearCE, low, high) in meters above present sea level.
# Interpolated literature estimates for the Uppsala/Knivsta area, generous bands.
SANITY_ANCHORS = (
    (-500, 13.0, 16.0),
    (1, 10.0, 12.5),
    (500, 8.0, 10.0),
    (1000, 5.0, 6.5),
)

UNCERTAINTY = (
    "SGU strandförskjutningsmodell: dating margins up to ±500 years; general "
    "progression, not for detailed studies."
)
DATUM_NOTE = (
    "Levels are meters RH 2000; 'above present sea level' agrees to within "
    "decimetres here."
)


class ShorelineError(RuntimeError):
    """The derived table failed a contract invariant or a literature anchor."""


@dataclass(frozen=True)
class Step:
    """One century of the table."""

    bp: int
    level_m: float
    samples: int  # boundary samples behind the median; 0 = filled from the trend

    @property
    def year_ce(self) -> int:
        return 1950 - self.bp

    @property
    def derived(self) -> bool:
        return self.samples > 0


# --------------------------------------------------------------------------- #
# fetch (network) — raw GeoJSON is cached verbatim under data-cache/
# --------------------------------------------------------------------------- #


def parse_collection_range(name: str) -> tuple[int, int]:
    """'bp1000-1900' -> (1000, 1900)."""
    lo, _, hi = name.removeprefix("bp").partition("-")
    return int(lo), int(hi)


def collections_for_bp_range(bp_min: int, bp_max: int) -> list[str]:
    """The SGU collections whose BP range overlaps [bp_min, bp_max]."""
    out = []
    for name in STRAND_COLLECTIONS:
        lo, hi = parse_collection_range(name)
        if hi >= bp_min and lo <= bp_max:
            out.append(name)
    if not out:
        raise ValueError(f"no SGU collection covers BP {bp_min}..{bp_max}")
    return out


def fetch_collection(collection: str, bbox4326: Sequence[float]) -> dict:
    """All features of one collection intersecting the bbox, as one FeatureCollection.

    Requested without a `crs` parameter, so the API answers in WGS84 (CRS84 axis
    order): `bbox` and the returned coordinates are lon/lat and get projected to
    EPSG:3006 before sampling. (`fetch_soils.py` takes the other route and asks
    for EPSG:3006 output directly — it rasterizes rather than samples, so the
    round trip through lon/lat would only cost precision.)
    """
    bbox = ",".join(f"{v:.8f}" for v in bbox4326)
    url = f"{STRAND_API}/collections/{collection}/items?f=json&bbox={bbox}&limit={PAGE_LIMIT}"
    return page_features(url, collection, MAX_PAGES)


def _cache_path(cfg: SiteConfig, collection: str) -> Path:
    return CACHE_DIR / f"{cfg.id}_strand_{collection}.geojson"


def _cache_meta_path(cfg: SiteConfig) -> Path:
    return CACHE_DIR / f"{cfg.id}_strand.json"


def fetch_strand_features(
    cfg: SiteConfig, bp_min: int = BP_YOUNGEST, bp_max: int = BP_OLDEST, force: bool = False
) -> tuple[list[dict], dict]:
    """Fetch (or reuse) the SGU features covering the site's context extent.

    Returns (features, meta). The cache is keyed on the bbox and the collection
    set; anything else invalidates it.
    """
    bbox = wgs84_bbox(cfg.bounds3006(cfg.context.half_extent))
    collections = collections_for_bp_range(bp_min, bp_max)
    meta_path = _cache_meta_path(cfg)

    meta: dict | None = None
    if not force and meta_path.exists():
        try:
            cached = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cached = None
        if (
            cached
            and cached.get("collections") == collections
            and cached.get("bbox4326")
            and np.allclose(cached["bbox4326"], bbox, atol=1e-9)
            and all(_cache_path(cfg, c).exists() for c in collections)
        ):
            meta = cached
            print(f"cache hit: {meta_path} ({len(collections)} collections)")

    if meta is None:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        for collection in collections:
            payload = fetch_collection(collection, bbox)
            _cache_path(cfg, collection).write_text(
                json.dumps(payload), encoding="utf-8"
            )
            print(f"  {collection}: {len(payload['features'])} features")
        meta = {
            "api": STRAND_API,
            "product": STRAND_PRODUCT,
            "collections": collections,
            "bbox4326": list(bbox),
            "fetched": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        }
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    features: list[dict] = []
    for collection in collections:
        payload = json.loads(_cache_path(cfg, collection).read_text(encoding="utf-8"))
        features.extend(payload.get("features", []))
    return features, meta


# --------------------------------------------------------------------------- #
# geometry — plain GeoJSON coordinate walks (no shapely/geopandas dependency)
# --------------------------------------------------------------------------- #


def polygon_rings(geometry: dict) -> list[list[Sequence[float]]]:
    """Every ring (exterior and holes) of a (Multi)Polygon geometry."""
    kind = geometry.get("type")
    if kind == "Polygon":
        return list(geometry["coordinates"])
    if kind == "MultiPolygon":
        return [ring for polygon in geometry["coordinates"] for ring in polygon]
    if kind == "GeometryCollection":
        return [ring for g in geometry.get("geometries", []) for ring in polygon_rings(g)]
    return []


def features_by_bp(features: Iterable[dict], code: int | None = None) -> dict[int, list[dict]]:
    """Group features by their BP step, optionally keeping only one `code` class."""
    grouped: dict[int, list[dict]] = {}
    for feature in features:
        props = feature.get("properties") or {}
        if code is not None and props.get("code") != code:
            continue
        grouped.setdefault(int(props["bp"]), []).append(feature)
    return grouped


def densify_ring(
    ring: Sequence[Sequence[float]],
    step: float,
    bounds: tuple[float, float, float, float] | None = None,
) -> np.ndarray:
    """Ring vertices plus intermediate points at most `step` apart, as an (N, 2) array.

    SGU's rings can span the whole country; `bounds` (a pad-expanded window) drops
    segments that cannot contribute a sample before they are subdivided.
    """
    points = np.asarray(ring, dtype=np.float64)
    if points.ndim != 2 or points.shape[0] < 2:
        return np.empty((0, 2))
    starts, ends = points[:-1], points[1:]
    if bounds is not None:
        min_x, min_y, max_x, max_y = bounds
        keep = (
            (np.minimum(starts[:, 0], ends[:, 0]) <= max_x)
            & (np.maximum(starts[:, 0], ends[:, 0]) >= min_x)
            & (np.minimum(starts[:, 1], ends[:, 1]) <= max_y)
            & (np.maximum(starts[:, 1], ends[:, 1]) >= min_y)
        )
        starts, ends = starts[keep], ends[keep]
    if starts.shape[0] == 0:
        return np.empty((0, 2))

    deltas = ends - starts
    counts = np.maximum(1, np.ceil(np.hypot(deltas[:, 0], deltas[:, 1]) / step)).astype(np.int64)
    pieces = [
        start + np.outer(np.arange(count + 1) / count, delta)
        for start, delta, count in zip(starts, deltas, counts)
    ]
    return np.vstack(pieces)


def sample_boundary_elevations(
    features: Iterable[dict],
    heights_m: np.ndarray,
    transform,
    bounds3006: tuple[float, float, float, float],
    project: Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]] | None = None,
    edge_margin_cells: float = EDGE_MARGIN_CELLS,
) -> np.ndarray:
    """DEM elevations along the features' boundaries, inside the extent (step 2 above).

    `project` maps the GeoJSON coordinates to EPSG:3006; `None` means they already
    are (used by the tests, which keep their fixture in grid coordinates).
    """
    resolution = float(transform.a)
    min_e, min_n, max_e, max_n = bounds3006
    margin = edge_margin_cells * resolution
    inner = (min_e + margin, min_n + margin, max_e - margin, max_n - margin)

    samples: list[np.ndarray] = []
    for feature in features:
        for ring in polygon_rings(feature.get("geometry") or {}):
            coords = np.asarray(ring, dtype=np.float64)
            if coords.ndim != 2 or coords.shape[0] < 2:
                continue
            if project is not None:
                e, n = project(coords[:, 0], coords[:, 1])
                coords = np.column_stack([e, n])
            # Densify in projected meters; the pre-filter window is the sampling
            # window itself, so cross-country segments cost nothing.
            points = densify_ring(coords, resolution, bounds=inner)
            if points.shape[0] == 0:
                continue
            e, n = points[:, 0], points[:, 1]
            keep = (e >= inner[0]) & (e <= inner[2]) & (n >= inner[1]) & (n <= inner[3])
            if not keep.any():
                continue
            samples.append(sample_nearest_many(heights_m, transform, e[keep], n[keep]))

    if not samples:
        return np.empty(0, dtype=np.float64)
    return np.concatenate(samples).astype(np.float64)


# --------------------------------------------------------------------------- #
# table assembly
# --------------------------------------------------------------------------- #


def fit_trend(years: Sequence[float], levels: Sequence[float], degree: int = TREND_DEGREE):
    """Least-squares (yearCE -> levelM) trend through the measured steps.

    Returns (callable, rms_residual). Used only to fill steps that have no
    shoreline inside the extent to measure.
    """
    if len(years) <= degree:
        raise ShorelineError(
            f"only {len(years)} measured steps — not enough to fit a degree-{degree} trend"
        )
    coefficients = np.polyfit(np.asarray(years, float), np.asarray(levels, float), degree)
    model = np.poly1d(coefficients)
    residuals = np.asarray(levels, float) - model(np.asarray(years, float))
    return model, float(np.sqrt(np.mean(residuals**2)))


def clamp_non_increasing(levels: Sequence[float], max_clamp: float = MAX_ISOTONIC_CLAMP):
    """Force levels non-increasing (contract §6). Returns (levels, total clamp in m).

    A step that wobbles up by a few cm is DEM noise in the boundary median; a step
    that wobbles up by more than `max_clamp` means the derivation is broken.
    """
    out: list[float] = []
    moved = 0.0
    cap = float("inf")
    for value in levels:
        clamped = min(float(value), cap)
        moved += float(value) - clamped
        if float(value) - clamped > max_clamp:
            raise ShorelineError(
                f"level {value:.2f} m had to be clamped down by "
                f"{float(value) - clamped:.2f} m (> {max_clamp} m) to stay non-increasing; "
                f"the century levels are not a monotone sequence — check the derivation"
            )
        out.append(clamped)
        cap = clamped
    return out, moved


def interpolate_level(steps: Sequence[dict], year_ce: float) -> float:
    """Linear interpolation of the finished table at an arbitrary year (anchor checks)."""
    years = [s["yearCE"] for s in steps]
    levels = [s["levelM"] for s in steps]
    return float(np.interp(year_ce, years, levels))


def check_sanity_anchors(steps: Sequence[dict], anchors=SANITY_ANCHORS) -> None:
    """Hard gate against the PLAN.md §2.4 literature anchors."""
    years = [s["yearCE"] for s in steps]
    for year, low, high in anchors:
        if not (min(years) <= year <= max(years)):
            raise ShorelineError(
                f"sanity anchor at {year} CE lies outside the derived table "
                f"({min(years)}..{max(years)} CE) — cannot be checked"
            )
        level = interpolate_level(steps, year)
        if not (low <= level <= high):
            raise ShorelineError(
                f"derived water level at {year} CE is {level:.2f} m RH 2000, outside the "
                f"literature band {low}–{high} m (PLAN.md §2.4). The derivation is wrong — "
                f"fix it; do NOT relax the anchor."
            )


def derive_steps(
    features: Iterable[dict],
    heights_m: np.ndarray,
    transform,
    bounds3006: tuple[float, float, float, float],
    project=None,
    bp_min: int = BP_YOUNGEST,
    bp_max: int = BP_OLDEST,
    min_samples: int = MIN_BOUNDARY_SAMPLES,
    trend_degree: int = TREND_DEGREE,
) -> tuple[list[Step], dict]:
    """Century steps for the site, oldest first. Returns (steps, derivation stats).

    Every BP step the product has for this extent gets an entry: measured from the
    Hav boundary where there is one in frame, otherwise filled from the trend.
    """
    features = list(features)
    present = sorted(
        (bp for bp in features_by_bp(features) if bp_min <= bp <= bp_max), reverse=True
    )
    if not present:
        raise ShorelineError(
            f"the SGU extract holds no century steps in BP {bp_min}..{bp_max} for this extent"
        )
    hav = features_by_bp(features, code=CODE_HAV)

    measured: dict[int, tuple[float, int]] = {}
    for bp in present:
        elevations = sample_boundary_elevations(
            hav.get(bp, []), heights_m, transform, bounds3006, project=project
        )
        if elevations.size >= min_samples:
            measured[bp] = (round(float(np.median(elevations)), 1), int(elevations.size))

    if not measured:
        raise ShorelineError(
            "no century step has a sea (Hav) boundary inside the site extent — there is "
            "nothing to derive a level from"
        )

    model, rms = fit_trend(
        [1950 - bp for bp in measured], [level for level, _ in measured.values()], trend_degree
    )
    steps = [
        Step(bp=bp, level_m=measured[bp][0], samples=measured[bp][1])
        if bp in measured
        else Step(bp=bp, level_m=round(float(model(1950 - bp)), 1), samples=0)
        for bp in present
    ]

    levels, clamped = clamp_non_increasing([s.level_m for s in steps])
    steps = [
        Step(bp=s.bp, level_m=round(level, 1), samples=s.samples)
        for s, level in zip(steps, levels)
    ]

    filled = [s.bp for s in steps if not s.derived]
    stats = {
        "stepCount": len(steps),
        "measured": len(measured),
        "filled": filled,
        "trendDegree": trend_degree,
        "trendRms": round(rms, 3),
        "clampedTotalM": round(clamped, 3),
        "sampleTotal": sum(s.samples for s in steps),
        "missingBp": sorted(
            bp for bp in range(bp_min, bp_max + 1, 100) if bp not in present
        ),
    }
    return steps, stats


def method_text(cfg: SiteConfig, steps: Sequence[Step], stats: dict) -> str:
    """The one-paragraph derivation description the app shows verbatim (contract §6)."""
    measured = [s for s in steps if s.derived]
    filled = [s for s in steps if not s.derived]
    extent_km = 2.0 * cfg.context.half_extent / 1000.0
    text = (
        f"For each 100-year step of SGU's strandförskjutningsmodell, the modelled sea "
        f"(Hav) polygons overlapping this site's {extent_km:.0f}×{extent_km:.0f} km context "
        f"extent were fetched from the SGU OGC API, their boundaries densified to the "
        f"{cfg.context.resolution:.0f} m grid spacing, and every boundary point sampled "
        f"against our own LiDAR DEM; the median of those samples is that century's water "
        f"level in meters RH 2000. Points within {EDGE_MARGIN_CELLS:.0f} cells of the extent "
        f"edge are discarded — there the polygon follows the clip boundary, not a shoreline. "
        f"SGU models on a 50 m DEM, so a single boundary point is coarse; the median over "
        f"{stats['sampleTotal']:,} samples across {len(measured)} steps is the estimator."
    )
    if filled:
        first, last = filled[0], filled[-1]
        text += (
            f" By {min(first.year_ce, last.year_ce)} CE the modelled sea has withdrawn beyond "
            f"the extent, leaving no boundary in frame: the remaining "
            f"{len(filled)} step(s) ({first.year_ce} to {last.year_ce} CE) are extrapolated "
            f"from a least-squares linear fit through the {len(measured)} measured steps "
            f"(RMS residual {stats['trendRms']:.2f} m) rather than measured."
        )
    if stats["missingBp"]:
        gaps = ", ".join(f"BP {bp} ({1950 - bp} CE)" for bp in stats["missingBp"])
        text += f" {gaps} is absent from the SGU product and therefore has no entry."
    text += (
        " The table is clamped monotone non-increasing (post-glacial uplift only lowers the "
        "sea over this range) and checked against published shoreline estimates for the "
        "Uppsala/Knivsta area before it ships."
    )
    return text


def build_shoreline(cfg: SiteConfig, steps: Sequence[Step], stats: dict, meta: dict) -> dict:
    """Assemble shoreline.json (contract §6) and gate it on the invariants."""
    table = {
        "schemaVersion": SCHEMA_VERSION,
        "site": cfg.id,
        "method": method_text(cfg, steps, stats),
        "uncertainty": UNCERTAINTY,
        "datumNote": DATUM_NOTE,
        "source": {
            "product": meta.get("product", STRAND_PRODUCT),
            "api": meta.get("api", STRAND_API),
            "fetched": meta.get("fetched", ""),
        },
        "steps": [
            {"yearCE": s.year_ce, "bp": s.bp, "levelM": round(float(s.level_m), 1)}
            for s in sorted(steps, key=lambda s: s.year_ce)
        ],
    }
    validate_shoreline(table)
    return table


def validate_shoreline(table: dict) -> None:
    """Raise ShorelineError on any contract §6 violation."""
    if table.get("schemaVersion") != SCHEMA_VERSION:
        raise ShorelineError(f"schemaVersion must be {SCHEMA_VERSION}")
    for key in ("site", "method", "uncertainty", "datumNote", "source", "steps"):
        if not table.get(key):
            raise ShorelineError(f"shoreline.json is missing {key!r}")

    steps = table["steps"]
    if len(steps) < 2:
        raise ShorelineError(f"shoreline table needs >= 2 steps, has {len(steps)}")
    for step in steps:
        for key in ("yearCE", "bp", "levelM"):
            if key not in step:
                raise ShorelineError(f"step {step} is missing {key!r}")
        if not isinstance(step["yearCE"], int) or not isinstance(step["bp"], int):
            raise ShorelineError(f"step {step}: yearCE and bp must be integers")
        if step["yearCE"] != 1950 - step["bp"]:
            raise ShorelineError(f"step {step}: yearCE must equal 1950 - bp")
    years = [s["yearCE"] for s in steps]
    if any(b <= a for a, b in zip(years, years[1:])):
        raise ShorelineError("steps must be sorted strictly ascending by yearCE")
    levels = [s["levelM"] for s in steps]
    if any(b > a for a, b in zip(levels, levels[1:])):
        raise ShorelineError("levelM must be non-increasing with yearCE (uplift only falls)")
    check_sanity_anchors(steps)


def write_shoreline(path: Path, table: dict) -> Path:
    validate_shoreline(table)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(table, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def sweref_projector() -> Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray]]:
    """lon/lat (the API's output CRS) -> EPSG:3006, as a `project` callable."""
    transformer = Transformer.from_crs(4326, EPSG_HORIZONTAL, always_xy=True)
    return transformer.transform
