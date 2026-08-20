"""Rampart crest polylines derived from the DEM (contract §8, PLAN.md §4.6.1).

KMR registers Broborg as a **single site-extent polygon** — there is no per-rampart
geometry to extrude (PLAN.md §2.2, §5). So the crest line is derived from the
measured surface instead:

  1. resample the RAÄ extent-polygon boundary at a fixed arc-length step and smooth
     it, so the per-transect normals are stable rather than following the polygon's
     20-vertex corners;
  2. walk a corridor across each normal — biased *inward*, because the registered
     extent traces the fort's outer limit while the bank sits inside it — and sample
     the 1 m DEM along it;
  3. **detrend** each transect against a broad moving average and take the maximum of
     the residual. The plain elevation maximum is not usable here: the fort interior
     (~49.5 m) stands higher than the rampart crest (~48 m), so a raw max walks into
     the interior plateau. The residual isolates the 8–15 m wide, 1–2 m high bank
     from the hillslope it sits on — which is exactly the feature KMR describes;
  4. take a circular median of those picks as a robust guide and re-pick within a
     narrow window around it, so the two entrance gaps — where there is no bank to
     find — carry the neighbouring crest through instead of wandering inland; then
     smooth and densify to ~0.5 m.

Output is `rampart.json` per docs/data-formats.md §8: local `[x, z]` pairs only —
**no heights**. The app samples ground height from the same grid at runtime, so the
line can never drift from the terrain it is drawn on.

Everything except `run()` is a pure function of arrays + dicts: no network, no
credentials, and the whole derivation is exercised on synthetic fixtures in
`pipeline/tests/test_rampart.py`.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

import click
import numpy as np

from .clip_dem import dequantize_decimeters, read_grid
from .manifest import add_rampart_asset, local_bounds, validate_manifest, write_manifest
from .sites import SITES, SiteConfig, get_site

RAMPART_PATH = "rampart.json"
SCHEMA_VERSION = 1
DERIVATION_METHOD = "dem-ridge"

INNER_PATH_ID = "inner"
INNER_PATH_NAME = "Inner rampart"

PROCESSING_STEP = "rampart crest from DEM transect ridge (detrended per-transect maximum)"


class RampartError(RuntimeError):
    """The crest derivation could not produce a line worth committing."""


# --------------------------------------------------------------------------- #
# parameters
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class CrestParams:
    """Every knob of the derivation; serialised verbatim into `derivation.params`.

    Distances are meters. `corridor_inner_m` / `corridor_outer_m` are asymmetric on
    purpose: the KMR extent polygon traces the fort's outer limit (Broborg's is also
    carried with a 10 m lägesosäkerhet), so the bank crest lies *inside* it — at
    Broborg by 9–17 m. A symmetric ±10 m corridor would straddle the outer foot and
    miss the crest on most transects.
    """

    corridor_inner_m: float = 25.0
    corridor_outer_m: float = 5.0
    transect_step_m: float = 1.0
    sample_step_m: float = 0.25
    boundary_smooth_m: float = 15.0
    background_window_m: float = 24.0
    #: Circular median window over the first-pass picks — the robust guide the second
    #: pass searches around. Wide enough to outvote an entrance gap.
    median_window_m: float = 25.0
    #: Half-width of that second-pass search window around the guide.
    outlier_reject_m: float = 5.0
    crest_smooth_m: float = 9.0
    densify_m: float = 0.5
    #: Below this residual height a transect is treated as bankless (an entrance gap)
    #: and takes the guide value instead of its own pick.
    min_prominence_m: float = 0.3

    def as_json(self) -> dict:
        """`derivation.params` (contract §8) — camelCase, plain JSON numbers."""
        return {
            "corridorInnerM": self.corridor_inner_m,
            "corridorOuterM": self.corridor_outer_m,
            "transectStepM": self.transect_step_m,
            "sampleStepM": self.sample_step_m,
            "boundarySmoothM": self.boundary_smooth_m,
            "backgroundWindowM": self.background_window_m,
            "medianWindowM": self.median_window_m,
            "outlierRejectM": self.outlier_reject_m,
            "crestSmoothM": self.crest_smooth_m,
            "densifyM": self.densify_m,
            "minProminenceM": self.min_prominence_m,
        }


DEFAULT_PARAMS = CrestParams()


# --------------------------------------------------------------------------- #
# the local-coordinate view of a committed grid
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class LocalGrid:
    """A height grid addressed in local scene coordinates (contract §0/§1).

    `heights` is meters, row 0 = northernmost; `bounds_local` is the manifest's
    `boundsLocal` for the same grid, so sample (col, row) sits at the pixel center
    `minX + (col + 0.5) * resolution`, `minZ + (row + 0.5) * resolution`.
    """

    heights: np.ndarray
    resolution: float
    bounds_local: dict

    @property
    def width(self) -> int:
        return int(self.heights.shape[1])

    @property
    def height(self) -> int:
        return int(self.heights.shape[0])

    def contains(self, x, z) -> np.ndarray:
        b = self.bounds_local
        return (
            (np.asarray(x) >= b["minX"])
            & (np.asarray(x) <= b["maxX"])
            & (np.asarray(z) >= b["minZ"])
            & (np.asarray(z) <= b["maxZ"])
        )

    def sample(self, x, z) -> np.ndarray:
        """Bilinear height (m) at local (x, z), clamped at the grid edges.

        Same arithmetic as the app's `coords.heightAtLocal`, vectorised.
        """
        x = np.asarray(x, dtype=np.float64)
        z = np.asarray(z, dtype=np.float64)
        col = (x - self.bounds_local["minX"]) / self.resolution - 0.5
        row = (z - self.bounds_local["minZ"]) / self.resolution - 0.5

        c0 = np.clip(np.floor(col), 0, self.width - 1).astype(np.intp)
        r0 = np.clip(np.floor(row), 0, self.height - 1).astype(np.intp)
        c1 = np.clip(c0 + 1, 0, self.width - 1)
        r1 = np.clip(r0 + 1, 0, self.height - 1)
        fx = np.clip(col - c0, 0.0, 1.0)
        fz = np.clip(row - r0, 0.0, 1.0)

        h = self.heights
        top = h[r0, c0] * (1.0 - fx) + h[r0, c1] * fx
        bottom = h[r1, c0] * (1.0 - fx) + h[r1, c1] * fx
        return top * (1.0 - fz) + bottom * fz


def load_core_grid(cfg: SiteConfig, manifest: dict | None = None) -> LocalGrid:
    """Read the committed 1 m core COG as a local-coordinate height grid."""
    path = cfg.out_dir / cfg.core.path
    if not path.exists():
        raise RampartError(
            f"{path} is missing — run `python3 -m fornborg_pipeline.build --site {cfg.id}` "
            "first (that step needs Lantmäteriet credentials)."
        )
    data, _transform, bounds = read_grid(path)
    heights = dequantize_decimeters(data).astype(np.float64)
    bounds_local = local_bounds(bounds, cfg.center_e, cfg.center_n)
    if manifest is not None:
        declared = manifest["grids"]["core"]["boundsLocal"]
        for key, value in bounds_local.items():
            if abs(float(declared[key]) - value) > 1e-6:
                raise RampartError(
                    f"core grid boundsLocal.{key} = {declared[key]} in manifest.json but the "
                    f"committed COG implies {value} — regenerate the site (contract §0/§1)."
                )
    return LocalGrid(heights=heights, resolution=float(cfg.core.resolution), bounds_local=bounds_local)


# --------------------------------------------------------------------------- #
# polyline primitives (closed rings, local [x, z])
# --------------------------------------------------------------------------- #


def extent_ring(sites: dict, site_id: str) -> np.ndarray:
    """The site's KMR extent polygon as an open ring of local `[x, z]` points.

    `sites` is a parsed `sites.json` (contract §3). Raises `RampartError` unless the
    record exists and carries a `geometryLocal` Polygon.
    """
    records = [s for s in sites.get("sites", []) if s.get("id") == site_id]
    if not records:
        raise RampartError(f"sites.json has no record with id {site_id!r}")
    geometry = records[0].get("geometryLocal")
    if not geometry or geometry.get("type") != "Polygon":
        kind = geometry.get("type") if geometry else None
        raise RampartError(
            f"{site_id}: geometryLocal is {kind!r}, but the crest derivation needs a Polygon "
            "extent to run its corridor around (contract §3, PLAN.md §4.6)."
        )
    ring = np.asarray(geometry["coordinates"][0], dtype=np.float64)
    if ring.ndim != 2 or ring.shape[1] != 2:
        raise RampartError(f"{site_id}: geometryLocal ring must be a list of [x, z] pairs")
    # GeoJSON repeats the first position last; the derivation works on an open ring.
    if ring.shape[0] > 1 and np.allclose(ring[0], ring[-1]):
        ring = ring[:-1]
    if ring.shape[0] < 3:
        raise RampartError(f"{site_id}: extent ring has only {ring.shape[0]} distinct points")
    if not np.isfinite(ring).all():
        raise RampartError(f"{site_id}: extent ring contains non-finite coordinates")
    return ring


def ring_length(points: np.ndarray) -> float:
    """Perimeter of a closed ring, including the implicit closing segment."""
    closed = np.vstack([points, points[:1]])
    return float(np.hypot(*(closed[1:] - closed[:-1]).T).sum())


def resample_closed(points: np.ndarray, step: float) -> np.ndarray:
    """Resample a closed ring to a uniform arc-length `step` (last point != first)."""
    if step <= 0:
        raise ValueError("step must be positive")
    closed = np.vstack([points, points[:1]])
    seg = np.hypot(*(closed[1:] - closed[:-1]).T)
    total = float(seg.sum())
    if total <= 0:
        raise ValueError("degenerate ring: zero perimeter")
    cumulative = np.concatenate([[0.0], np.cumsum(seg)])
    count = max(3, int(round(total / step)))
    t = np.linspace(0.0, total, count, endpoint=False)
    return np.stack(
        [np.interp(t, cumulative, closed[:, 0]), np.interp(t, cumulative, closed[:, 1])],
        axis=1,
    )


def window_samples(length_m: float, step_m: float) -> int:
    """A window given in meters as an odd, >= 1 sample count."""
    n = int(round(length_m / step_m))
    if n < 1:
        return 1
    return n if n % 2 == 1 else n + 1


def smooth_closed(values: np.ndarray, window: int) -> np.ndarray:
    """Circular moving average over the last axis (window in samples, odd)."""
    if window <= 1:
        return np.asarray(values, dtype=np.float64).copy()
    values = np.asarray(values, dtype=np.float64)
    pad = window // 2
    padded = np.concatenate([values[-pad:], values, values[:pad]])
    kernel = np.ones(window) / window
    return np.convolve(padded, kernel, mode="valid")


def median_closed(values: np.ndarray, window: int) -> np.ndarray:
    """Circular median filter over a 1-D series (window in samples, odd)."""
    if window <= 1:
        return np.asarray(values, dtype=np.float64).copy()
    values = np.asarray(values, dtype=np.float64)
    pad = window // 2
    padded = np.concatenate([values[-pad:], values, values[:pad]])
    windows = np.lib.stride_tricks.sliding_window_view(padded, window)
    return np.median(windows, axis=1)


def inward_normals(points: np.ndarray) -> np.ndarray:
    """Unit normals of a closed ring, pointing into the polygon's interior.

    The side is decided by the ring's signed area (shoelace), not by a centroid
    test, so it stays correct on the concave stretches of a real extent polygon.
    """
    tangent = np.roll(points, -1, axis=0) - np.roll(points, 1, axis=0)
    length = np.hypot(tangent[:, 0], tangent[:, 1])
    if not (length > 0).all():
        raise RampartError("duplicate consecutive points in the ring — cannot orient normals")
    tangent = tangent / length[:, None]

    x, z = points[:, 0], points[:, 1]
    signed_area = 0.5 * float(np.sum(x * np.roll(z, -1) - np.roll(x, -1) * z))
    if signed_area == 0:
        raise RampartError("degenerate ring: zero signed area")
    orientation = 1.0 if signed_area > 0 else -1.0
    # Left normal of the direction of travel; for a CCW ring that points inward.
    normals = orientation * np.stack([-tangent[:, 1], tangent[:, 0]], axis=1)

    centroid = points.mean(axis=0)
    if float(np.mean(np.sum((centroid - points) * normals, axis=1))) <= 0:
        raise RampartError("could not orient the corridor normals into the extent polygon")
    return normals


def moving_average_rows(profiles: np.ndarray, window: int) -> np.ndarray:
    """Edge-padded moving average along each row (window in samples, odd)."""
    if window <= 1:
        return np.asarray(profiles, dtype=np.float64).copy()
    profiles = np.asarray(profiles, dtype=np.float64)
    pad = window // 2
    padded = np.pad(profiles, ((0, 0), (pad, pad)), mode="edge")
    kernel = np.ones(window) / window
    return np.apply_along_axis(lambda row: np.convolve(row, kernel, mode="valid"), 1, padded)


def _pick_ridge(
    residual: np.ndarray,
    offsets: np.ndarray,
    sample_step: float,
    low: np.ndarray | None = None,
    high: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Per-transect residual maximum, optionally restricted to `[low, high]`.

    Returns (inset in meters, residual height at the pick). The restriction is what
    lets a second pass follow a ring through an entrance gap: outside the window the
    residual is masked away rather than clipped, so the pick is a real local maximum.
    """
    masked = residual
    if low is not None and high is not None:
        window = (offsets[None, :] >= low[:, None]) & (offsets[None, :] <= high[:, None])
        if not window.any(axis=1).all():
            raise RampartError("the restricted ridge window fell outside the corridor")
        masked = np.where(window, residual, -np.inf)

    index = np.argmax(masked, axis=1)
    rows = np.arange(masked.shape[0])
    prominence = residual[rows, index]
    inset = np.array(
        [offsets[k] + _refine_peak(masked[i], int(k)) * sample_step for i, k in enumerate(index)]
    )
    if low is not None and high is not None:
        inset = np.clip(inset, low, high)
    return inset, prominence


def _refine_peak(values: np.ndarray, index: int) -> float:
    """Sub-sample peak offset (in samples) by parabolic interpolation."""
    if index <= 0 or index >= values.size - 1:
        return 0.0
    a, b, c = values[index - 1], values[index], values[index + 1]
    if not np.isfinite([a, b, c]).all():  # a masked-away neighbour (see `_pick_ridge`)
        return 0.0
    denominator = a - 2.0 * b + c
    if denominator == 0:
        return 0.0
    delta = 0.5 * (a - c) / denominator
    return float(np.clip(delta, -0.5, 0.5))


# --------------------------------------------------------------------------- #
# the derivation
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class CrestResult:
    """One derived crest line plus the numbers the run log and tests care about."""

    points: np.ndarray  # (N, 2) local [x, z], closed ring, last != first
    length_m: float
    inset_m: np.ndarray  # per-transect distance inside the extent boundary
    prominence_m: np.ndarray  # residual height of the picked ridge per transect
    rejected: int  # transects replaced by their neighbourhood median
    heights_m: np.ndarray  # sampled crest height at the output points

    @property
    def stats(self) -> dict:
        radius = np.hypot(*(self.points - self.points.mean(axis=0)).T)
        spacing = np.hypot(*(np.vstack([self.points, self.points[:1]])[1:] - self.points).T)
        return {
            "points": int(self.points.shape[0]),
            "lengthM": round(self.length_m, 1),
            "maxSpacingM": round(float(spacing.max()), 3),
            "insetMedianM": round(float(np.median(self.inset_m)), 2),
            "insetMinM": round(float(self.inset_m.min()), 2),
            "insetMaxM": round(float(self.inset_m.max()), 2),
            "radiusMinM": round(float(radius.min()), 1),
            "radiusMaxM": round(float(radius.max()), 1),
            "radiusMeanM": round(float(radius.mean()), 1),
            "prominenceMedianM": round(float(np.median(self.prominence_m)), 2),
            "rejectedTransects": int(self.rejected),
            "transects": int(self.inset_m.size),
            "crestMinM": round(float(self.heights_m.min()), 1),
            "crestMaxM": round(float(self.heights_m.max()), 1),
        }


def derive_crest(grid: LocalGrid, ring: np.ndarray, params: CrestParams = DEFAULT_PARAMS) -> CrestResult:
    """Derive the rampart crest ring inside `ring` from `grid` (see module docstring)."""
    boundary = resample_closed(ring, params.transect_step_m)
    smooth_window = window_samples(params.boundary_smooth_m, params.transect_step_m)
    base = np.stack(
        [smooth_closed(boundary[:, 0], smooth_window), smooth_closed(boundary[:, 1], smooth_window)],
        axis=1,
    )
    normals = inward_normals(base)

    # Corridor offsets: positive = inward from the extent boundary.
    offsets = np.arange(
        -params.corridor_outer_m,
        params.corridor_inner_m + 0.5 * params.sample_step_m,
        params.sample_step_m,
    )
    sample_x = base[:, 0, None] + normals[:, 0, None] * offsets[None, :]
    sample_z = base[:, 1, None] + normals[:, 1, None] * offsets[None, :]
    if not grid.contains(sample_x, sample_z).all():
        raise RampartError(
            "the transect corridor leaves the core grid — the site extent sits too close to "
            "the grid edge for this corridor width (contract §8 requires in-bounds points)."
        )

    profiles = grid.sample(sample_x, sample_z)
    background = moving_average_rows(profiles, window_samples(params.background_window_m, params.sample_step_m))
    residual = profiles - background

    # Pass 1: the unrestricted residual maximum on every transect. Most transects
    # cross a real bank and land on it; the few that do not (entrance gaps) can land
    # anywhere, typically on the interior dome, whose curvature also leaves a small
    # positive residual.
    inset_raw, _ = _pick_ridge(residual, offsets, params.sample_step_m)

    # A circular median of pass 1 is a robust guide even with the gaps in it — the
    # gap transects are outvoted by their neighbours.
    guide = median_closed(inset_raw, window_samples(params.median_window_m, params.transect_step_m))

    # Pass 2: re-pick, restricted to the guide's neighbourhood, so a transect with no
    # bank of its own follows the ring through the gap instead of running inland.
    inset, prominence = _pick_ridge(
        residual, offsets, params.sample_step_m, low=guide - params.outlier_reject_m,
        high=guide + params.outlier_reject_m,
    )
    bad = prominence < params.min_prominence_m
    inset = np.where(bad, guide, inset)
    if bad.all():
        raise RampartError(
            "every transect was rejected — no coherent ridge inside the extent polygon "
            "(PLAN.md §4.6 fallback: a hand-digitized trace, which needs sign-off)."
        )

    inset = smooth_closed(inset, window_samples(params.crest_smooth_m, params.transect_step_m))
    crest = base + normals * inset[:, None]

    points = np.round(resample_closed(crest, params.densify_m), 2)
    if not grid.contains(points[:, 0], points[:, 1]).all():
        raise RampartError("derived crest points fall outside the core grid (contract §8)")

    return CrestResult(
        points=points,
        length_m=ring_length(points),
        inset_m=inset,
        prominence_m=prominence,
        rejected=int(bad.sum()),
        heights_m=grid.sample(points[:, 0], points[:, 1]),
    )


# --------------------------------------------------------------------------- #
# rampart.json assembly + validation (contract §8)
# --------------------------------------------------------------------------- #

DESCRIPTION = (
    "Crest line of the inner rampart, derived from the committed 1 m LiDAR DEM "
    "(dem_core.tif). Transects are cast every {transect} m along a smoothed copy of the "
    "RAÄ/KMR site-extent polygon, running from {outer} m outside to {inner} m inside it; "
    "each transect's height profile is detrended against a {background} m moving average "
    "and the maximum of that residual is taken as the bank crest (the fort interior stands "
    "higher than the rampart, so an undetrended maximum would walk inland). A circular "
    "median over {median} m of those first picks guides a second pass restricted to "
    "±{reject} m around it, so the entrance gaps — where there is no bank to find — follow "
    "the neighbouring crest instead of wandering. The result is smoothed over {smooth} m and "
    "densified to {densify} m. The line is measured; the palisade drawn on it is conjecture."
)


def build_rampart(
    site_id: str,
    crest: CrestResult,
    params: CrestParams = DEFAULT_PARAMS,
    generated: str | None = None,
    description: str | None = None,
) -> dict:
    """Assemble the `rampart.json` document (contract §8). Pure dict assembly."""
    return {
        "schemaVersion": SCHEMA_VERSION,
        "site": site_id,
        "derivation": {
            "method": DERIVATION_METHOD,
            "description": description
            or DESCRIPTION.format(
                transect=params.transect_step_m,
                outer=params.corridor_outer_m,
                inner=params.corridor_inner_m,
                background=params.background_window_m,
                median=params.median_window_m,
                reject=params.outlier_reject_m,
                smooth=params.crest_smooth_m,
                densify=params.densify_m,
            ),
            "generated": generated or datetime.now(timezone.utc).date().isoformat(),
            "params": params.as_json(),
        },
        "paths": [
            {
                "id": INNER_PATH_ID,
                "name": INNER_PATH_NAME,
                "closed": True,
                "lengthM": round(crest.length_m, 1),
                "points": [[float(x), float(z)] for x, z in crest.points],
            }
        ],
    }


MAX_SPACING_M = 1.0
MIN_POINTS = 3


def validate_rampart(document: dict, bounds_local: dict | None = None) -> None:
    """Raise ValueError on any docs/data-formats.md §8 violation."""
    if document.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"rampart.json: schemaVersion must be {SCHEMA_VERSION}")
    if not document.get("site"):
        raise ValueError("rampart.json: site is required")

    derivation = document.get("derivation")
    if not isinstance(derivation, dict):
        raise ValueError("rampart.json: derivation block is required (§8)")
    if derivation.get("method") not in ("dem-ridge", "digitized"):
        raise ValueError(
            f"rampart.json: derivation.method must be 'dem-ridge' or 'digitized', "
            f"got {derivation.get('method')!r}"
        )
    for key in ("description", "generated"):
        if not derivation.get(key):
            raise ValueError(f"rampart.json: derivation.{key} is required (§8)")
    if not isinstance(derivation.get("params"), dict):
        raise ValueError("rampart.json: derivation.params must be an object (§8)")

    paths = document.get("paths")
    if not isinstance(paths, list) or not paths:
        raise ValueError("rampart.json: paths must be a non-empty array (§8)")

    seen: set[str] = set()
    for index, path in enumerate(paths):
        label = f"paths[{index}]"
        if not isinstance(path, dict):
            raise ValueError(f"rampart.json: {label} must be an object")
        path_id = path.get("id")
        if not path_id or not isinstance(path_id, str):
            raise ValueError(f"rampart.json: {label}.id must be a non-empty string")
        if path_id in seen:
            raise ValueError(f"rampart.json: duplicate path id {path_id!r}")
        seen.add(path_id)
        label = f"paths[{path_id}]"
        if not path.get("name"):
            raise ValueError(f"rampart.json: {label}.name is required")
        if not isinstance(path.get("closed"), bool):
            raise ValueError(f"rampart.json: {label}.closed must be a boolean")

        points = path.get("points")
        if not isinstance(points, list) or len(points) < MIN_POINTS:
            count = len(points) if isinstance(points, list) else 0
            raise ValueError(f"rampart.json: {label}.points needs >= {MIN_POINTS} points, got {count}")
        array = np.asarray(points, dtype=np.float64)
        if array.ndim != 2 or array.shape[1] != 2:
            raise ValueError(f"rampart.json: {label}.points must be [x, z] pairs")
        if not np.isfinite(array).all():
            raise ValueError(f"rampart.json: {label}.points contains a non-finite value")

        if bounds_local is not None:
            outside = (
                (array[:, 0] < bounds_local["minX"])
                | (array[:, 0] > bounds_local["maxX"])
                | (array[:, 1] < bounds_local["minZ"])
                | (array[:, 1] > bounds_local["maxZ"])
            )
            if outside.any():
                first = array[np.argmax(outside)]
                raise ValueError(
                    f"rampart.json: {label}.points has {int(outside.sum())} point(s) outside the core "
                    f"grid boundsLocal, first at [{first[0]}, {first[1]}] (§8)"
                )

        if path["closed"] and np.allclose(array[0], array[-1]):
            raise ValueError(
                f"rampart.json: {label} is closed, so the closing segment is implicit — "
                "the last point must not repeat the first (§8)"
            )

        segments = array[1:] - array[:-1]
        if path["closed"]:
            segments = np.vstack([segments, array[0] - array[-1]])
        spacing = np.hypot(segments[:, 0], segments[:, 1])
        if spacing.max() > MAX_SPACING_M + 1e-9:
            raise ValueError(
                f"rampart.json: {label} point spacing {spacing.max():.3f} m exceeds the "
                f"{MAX_SPACING_M} m the contract allows (§8)"
            )

        declared = path.get("lengthM")
        if not isinstance(declared, (int, float)) or not np.isfinite(declared):
            raise ValueError(f"rampart.json: {label}.lengthM must be a finite number")
        if abs(float(declared) - float(spacing.sum())) > 0.5:
            raise ValueError(
                f"rampart.json: {label}.lengthM = {declared} disagrees with the polyline's "
                f"{spacing.sum():.1f} m (§8)"
            )


def write_rampart(path: Path, document: dict, bounds_local: dict | None = None) -> Path:
    validate_rampart(document, bounds_local)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

# Broborg ground truth (KMR beskrivning / PLAN.md §2.2), used as a *reported*
# sanity band in the run log — never to correct the derived geometry.
GROUND_TRUTH = {
    "broborg": {
        "lengthM": (180.0, 320.0),
        "crestM": (44.0, 53.0),
        "note": "KMR: inner rampart 'ca 300 m l, 8-15 m br, 1-2 m h'; crown ~50 m RH 2000",
    }
}


def patch_manifest(cfg: SiteConfig, manifest_path: Path) -> dict:
    """Wire `assets.rampart` + the conjectural palisade layer into the manifest."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    add_rampart_asset(manifest, RAMPART_PATH, processing=(PROCESSING_STEP,))
    write_manifest(manifest_path, manifest)
    print(f"  wrote {manifest_path}")
    return manifest


def run(site_id: str, params: CrestParams = DEFAULT_PARAMS) -> dict:
    """Derive the crest for one site, write `rampart.json`, patch the manifest."""
    cfg = get_site(site_id)
    print(f"== {cfg.name} ({cfg.id}) — rampart crest from the committed core grid")

    manifest_path = cfg.out_dir / "manifest.json"
    if not manifest_path.exists():
        raise RampartError(f"{manifest_path} is missing — run the build step for {cfg.id} first.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    sites_path = cfg.out_dir / "sites.json"
    if not sites_path.exists():
        raise RampartError(
            f"{sites_path} is missing — run `python3 -m fornborg_pipeline.fetch_sites "
            f"--site {cfg.id}` first (contract §3 supplies the extent polygon)."
        )
    site_key = (cfg.raa or {}).get("lamningsnummer") or cfg.id
    ring = extent_ring(json.loads(sites_path.read_text(encoding="utf-8")), site_key)
    print(
        f"-- extent polygon {site_key}: {ring.shape[0]} vertices, "
        f"{ring_length(ring):.1f} m perimeter"
    )

    grid = load_core_grid(cfg, manifest)
    print(
        f"-- core grid: {grid.width}x{grid.height} @ {grid.resolution} m | "
        f"z {grid.heights.min():.1f}..{grid.heights.max():.1f} m RH 2000"
    )

    crest = derive_crest(grid, ring, params)
    stats = crest.stats
    print(
        f"-- crest: {stats['points']} points, {stats['lengthM']} m, spacing <= "
        f"{stats['maxSpacingM']} m, {stats['rejectedTransects']}/{stats['transects']} transects "
        f"replaced by the neighbourhood median"
    )
    print(
        f"   inset inside the extent boundary: {stats['insetMinM']}..{stats['insetMaxM']} m "
        f"(median {stats['insetMedianM']} m), ridge prominence median "
        f"{stats['prominenceMedianM']} m"
    )
    print(
        f"   radial spread from the ring centroid: {stats['radiusMinM']}..{stats['radiusMaxM']} m "
        f"(mean {stats['radiusMeanM']} m)"
    )
    print(f"   sampled crest height: {stats['crestMinM']}..{stats['crestMaxM']} m RH 2000")

    truth = GROUND_TRUTH.get(cfg.id)
    if truth:
        lo, hi = truth["lengthM"]
        clo, chi = truth["crestM"]
        length_ok = lo <= stats["lengthM"] <= hi
        height_ok = clo <= stats["crestMinM"] and stats["crestMaxM"] <= chi
        print(f"   ground truth ({truth['note']}):")
        print(f"     length {stats['lengthM']} m in [{lo}, {hi}] -> {'ok' if length_ok else 'CHECK'}")
        print(
            f"     crest {stats['crestMinM']}..{stats['crestMaxM']} m in [{clo}, {chi}] -> "
            f"{'ok' if height_ok else 'CHECK'}"
        )

    document = build_rampart(cfg.id, crest, params)
    bounds_local = manifest["grids"]["core"]["boundsLocal"]
    path = write_rampart(cfg.out_dir / RAMPART_PATH, document, bounds_local)
    print(f"  wrote {path} ({path.stat().st_size / 1e3:.1f} kB)")

    print("-- manifest")
    manifest = patch_manifest(cfg, manifest_path)
    validate_manifest(manifest)
    print(f"== done: {cfg.out_dir}")
    return document


@click.command()
@click.option(
    "--site",
    "site_id",
    default="broborg",
    show_default=True,
    type=click.Choice(sorted(SITES)),
    help="Site to derive the rampart crest for.",
)
@click.option(
    "--corridor-inner",
    default=DEFAULT_PARAMS.corridor_inner_m,
    show_default=True,
    help="How far inside the extent boundary the transects reach (m).",
)
@click.option(
    "--corridor-outer",
    default=DEFAULT_PARAMS.corridor_outer_m,
    show_default=True,
    help="How far outside the extent boundary the transects reach (m).",
)
def cli(site_id: str, corridor_inner: float, corridor_outer: float) -> None:
    """Derive rampart.json from the DEM and patch the site manifest."""
    params = replace(
        DEFAULT_PARAMS, corridor_inner_m=float(corridor_inner), corridor_outer_m=float(corridor_outer)
    )
    try:
        run(site_id, params)
    except RampartError as exc:
        raise SystemExit(f"CREST DERIVATION FAILED: {exc}") from exc


if __name__ == "__main__":
    sys.exit(cli())
