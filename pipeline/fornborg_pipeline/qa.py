"""Automated QA gates for a batch-built site (scale-out §4.4).

Nobody can eyeball 1,304 sites, so the batch has to fail loudly instead. Every
gate here is a pure function of the manifest and the grids a build just wrote —
no network, no credentials — and each returns a `Check` rather than raising, so
one build produces a *complete* report instead of stopping at the first problem.

Severities:

  * `fail`  — do not ship this bundle. It is wrong, or wrong in a way we cannot
              rule out (a sea-filled hole in interior Sweden is a coverage gap,
              not a lake, and shipping it would render a false flat horizon).
  * `warn`  — ship it, but it is on the contact sheet's "look at me" list.
  * `pass`  — nothing to say.

The point of the split is that `fail` must stay rare and meaningful. A gate that
cries wolf on 200 sites gets ignored, and then the one real failure ships.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .sites import RING_LADDER

#: Nodata fill above this share of a grid means the DEM had real holes, not
#: speckle — the surface is interpolated over something, and the thumbnail
#: should be looked at (scale-out §4.4).
NODATA_WARN_SHARE = 0.01
#: ...and above this it is not a surface any more.
NODATA_FAIL_SHARE = 0.05

#: The ladder's hard stop: ring7 covers a 128x128 km box, i.e. a 64 km radius,
#: which closes the horizon for an eye ~280 m above the terrain it looks across.
#: A site needing more than that is not a Swedish fornborg — it is a bug in the
#: crown/floor derivation, and the manifest would promise a horizon it has not
#: got.
LADDER_CAP_RADIUS_M = max(spec.half_extent for spec in RING_LADDER)

#: `provenance.processing` line the ring step writes when a ring left the
#: Lantmäteriet tile set and got filled with sea at 0 m (contract §11).
SEA_FILL_PATTERN = re.compile(r"(\w+): (\d+) cells outside tile coverage sea-filled")

#: A region of uncovered cells is treated as **open sea** when the Swedish land
#: it borders sits at or below this height (m RH 2000). Sweden's Baltic and
#: Kattegat coastlines meet the water at ~0 m by construction, so a shore-like
#: boundary is a strong signal that filling at 0 m tells the truth. A land
#: border — Norwegian fjäll, the Finnish frontier — is bounded by terrain well
#: above this, and filling *that* at 0 m would render a false flat horizon,
#: which is the one dishonest thing this project must not ship (§2b).
#:
#: The threshold is deliberately generous: a coastal cell block-averaged at 32 m
#: mixes water with the first slope behind it, so a genuine coastline reads a
#: few metres up rather than exactly zero.
SEA_BOUNDARY_MAX_M = 20.0


@dataclass
class Check:
    """One gate's verdict."""

    id: str
    severity: str  # "pass" | "warn" | "fail"
    message: str
    detail: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.severity != "fail"


@dataclass
class QAReport:
    slug: str
    checks: list[Check]

    @property
    def failures(self) -> list[Check]:
        return [c for c in self.checks if c.severity == "fail"]

    @property
    def warnings(self) -> list[Check]:
        return [c for c in self.checks if c.severity == "warn"]

    @property
    def passed(self) -> bool:
        return not self.failures

    def as_json(self) -> dict:
        return {
            "slug": self.slug,
            "passed": self.passed,
            "failures": len(self.failures),
            "warnings": len(self.warnings),
            "checks": [
                {"id": c.id, "severity": c.severity, "message": c.message, **({"detail": c.detail} if c.detail else {})}
                for c in self.checks
            ],
        }

    def summary(self) -> str:
        """One line, for a batch runner's log and a subagent's report."""
        verdict = "PASS" if self.passed else "FAIL"
        parts = [f"{self.slug}: {verdict}"]
        if self.failures:
            parts.append("failures=" + "; ".join(c.message for c in self.failures))
        if self.warnings:
            parts.append("warnings=" + "; ".join(c.message for c in self.warnings))
        return " | ".join(parts)


def check_elevation_band(manifest: dict, band: tuple[float, float]) -> Check:
    """Every grid's measured min/max inside the site's plausible band (§2, §11).

    This is the geoid-shift tripwire (PLAN.md §2.1) applied to what actually got
    written, rather than to the arrays in memory — a build that wrote a shifted
    grid must not pass QA just because the in-memory check ran on something else.
    """
    lo, hi = band
    grids = dict(manifest.get("grids", {}))
    rings = grids.pop("rings", []) or []
    named = list(grids.items()) + [(f"rings[{i}]", ring) for i, ring in enumerate(rings)]

    offenders = {}
    zmin, zmax = None, None
    for name, grid in named:
        low = float(grid.get("minElevation", 0.0))
        high = float(grid.get("maxElevation", 0.0))
        zmin = low if zmin is None else min(zmin, low)
        zmax = high if zmax is None else max(zmax, high)
        if low < lo or high > hi:
            offenders[name] = [low, high]
    if offenders:
        return Check(
            "elevation-band",
            "fail",
            f"grids leave the plausible band [{lo}, {hi}] m RH 2000: {offenders}",
            {"band": [lo, hi], "offenders": offenders},
        )
    return Check(
        "elevation-band",
        "pass",
        f"z {zmin:.1f}..{zmax:.1f} m inside [{lo}, {hi}]",
        {"minElevation": zmin, "maxElevation": zmax},
    )


def check_nodata_fill(filled_by_grid: dict[str, tuple[int, int]]) -> Check:
    """Nodata repaired before quantization, as a share of each grid (§4.4)."""
    shares = {
        name: (filled / total if total else 0.0) for name, (filled, total) in filled_by_grid.items()
    }
    worst_name = max(shares, key=shares.__getitem__, default=None)
    worst = shares.get(worst_name, 0.0) if worst_name else 0.0
    detail = {"shareByGrid": {k: round(v, 5) for k, v in shares.items()}}
    if worst >= NODATA_FAIL_SHARE:
        return Check(
            "nodata-fill",
            "fail",
            f"{worst_name} is {worst:.1%} interpolated nodata (limit {NODATA_FAIL_SHARE:.0%})",
            detail,
        )
    if worst >= NODATA_WARN_SHARE:
        return Check(
            "nodata-fill",
            "warn",
            f"{worst_name} is {worst:.1%} interpolated nodata — check the thumbnail",
            detail,
        )
    return Check("nodata-fill", "pass", f"nodata fill at most {worst:.2%}", detail)


def check_ladder(manifest: dict) -> Check:
    """The §11 ladder actually closes the horizon it claims, within the cap.

    Three ways this goes wrong: the ladder stops short of the computed horizon
    distance (the skyline would end in a fog wall — the whole point of Phase 8);
    the site needs more than ring7 (the crown/floor derivation is wrong); or the
    manifest declares a horizon block with no rings to back it.
    """
    rings = manifest.get("grids", {}).get("rings") or []
    horizon = manifest.get("horizon")
    if not rings:
        if horizon:
            return Check("ladder", "fail", "a horizon block is declared but no rings ship")
        return Check("ladder", "warn", "site ships no far-field rings (§11)")
    if not horizon:
        return Check("ladder", "fail", "rings ship without the §11 horizon block")

    distance_km = float(horizon.get("distanceKm", 0.0))
    outer = rings[-1]
    reach_m = (float(outer["bounds3006"]["maxE"]) - float(outer["bounds3006"]["minE"])) / 2.0
    detail = {
        "distanceKm": distance_km,
        "ringCount": len(rings),
        "outerRadiusKm": round(reach_m / 1000.0, 1),
        "capRadiusKm": round(LADDER_CAP_RADIUS_M / 1000.0, 1),
    }
    if distance_km * 1000.0 > LADDER_CAP_RADIUS_M + 1.0:
        return Check(
            "ladder",
            "fail",
            f"horizon needs {distance_km:.1f} km but the ladder caps at "
            f"{LADDER_CAP_RADIUS_M / 1000.0:.0f} km — check crown/floor, no Swedish fort "
            f"stands that high",
            detail,
        )
    if reach_m + 1.0 < distance_km * 1000.0:
        return Check(
            "ladder",
            "fail",
            f"ladder reaches {reach_m / 1000.0:.1f} km but the horizon is at "
            f"{distance_km:.1f} km — the skyline would close in fog, not at the horizon",
            detail,
        )
    return Check(
        "ladder",
        "pass",
        f"{len(rings)} rings out to {reach_m / 1000.0:.0f} km for a {distance_km:.1f} km horizon",
        detail,
    )


def sea_filled_cells(manifest: dict) -> dict[str, int]:
    """{ring name: cells} the §11 ring step filled with sea at 0 m, from provenance."""
    found: dict[str, int] = {}
    for line in manifest.get("provenance", {}).get("processing", []):
        match = SEA_FILL_PATTERN.search(str(line))
        if match:
            found[match.group(1)] = int(match.group(2))
    return found


#: A boundary this sparsely covered by *valid ground data* is read as water.
#: The Lantmäteriet DTM is a ground model: over the sea and over lakes its tiles
#: exist but carry nodata, because there is no ground to return. So a region of
#: no-tile-at-all whose edge is nodata is surrounded by water — the absence of
#: data is the evidence, not an obstacle to it. A land border is the opposite:
#: Swedish terrain runs right up to it with valid heights all the way.
SEA_BOUNDARY_MAX_VALID_SHARE = 0.10


def classify_uncovered(
    covered: np.ndarray, heights_m: np.ndarray, nodata: float = -9999.0
) -> list[dict]:
    """Describe each connected region of cells no source tile covered.

    Returns one dict per region: its size, whether it reaches the grid edge, how
    much of its boundary carries *valid ground data*, and how high that data is.
    Those facts separate the four things a coverage hole can be:

      * **enclosed** — a real gap in the tile set, surrounded by data;
      * **edge-connected, boundary is nodata** — the tiles reach out over water
        and find no ground: open sea, where filling at 0 m is simply true;
      * **edge-connected, valid boundary at shore height** — a coastline, same
        conclusion;
      * **edge-connected, valid boundary well above sea level** — Swedish
        terrain running up to a land border, with another country beyond it.
        Filling that at 0 m invents a flat horizon that is not there.

    Pure array work, so the judgement is testable without a network or a fetch.
    """
    from scipy import ndimage

    covered = np.asarray(covered, dtype=bool)
    heights = np.asarray(heights_m, dtype=np.float64)
    # A cell can be covered by a tile and still hold no data — that is exactly
    # what the sea looks like in a ground model, so it must not be averaged in
    # as if it were an elevation.
    valid = covered & (heights > nodata + 1.0) & np.isfinite(heights)
    uncovered = ~covered
    if not uncovered.any():
        return []

    labels, count = ndimage.label(uncovered)
    edge_labels = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
    edge_labels.discard(0)

    regions = []
    for index in range(1, count + 1):
        mask = labels == index
        # The covered cells immediately around this region: its shoreline, or
        # its border with whatever country the tile set stops at.
        boundary = ndimage.binary_dilation(mask) & covered
        boundary_valid = boundary & valid
        heights_there = heights[boundary_valid]
        boundary_cells = int(boundary.sum())
        regions.append(
            {
                "cells": int(mask.sum()),
                "touchesEdge": index in edge_labels,
                "boundaryCells": boundary_cells,
                "boundaryValidCells": int(boundary_valid.sum()),
                "boundaryValidShare": round(
                    float(boundary_valid.sum() / boundary_cells) if boundary_cells else 0.0, 3
                ),
                "boundaryMedianM": round(float(np.median(heights_there)), 1)
                if heights_there.size
                else None,
                "boundaryP90M": round(float(np.percentile(heights_there, 90)), 1)
                if heights_there.size
                else None,
            }
        )
    regions.sort(key=lambda r: -r["cells"])
    return regions


def classify_region(region: dict) -> str:
    """One region -> "gap" | "sea" | "foreign-land"."""
    if not region["touchesEdge"]:
        return "gap"
    # A boundary that is mostly nodata means the tiles reach out over water and
    # find no ground: this is sea, and the missing data is what says so.
    share = region.get("boundaryValidShare")
    if share is not None and share <= SEA_BOUNDARY_MAX_VALID_SHARE:
        return "sea"
    median = region.get("boundaryMedianM")
    if median is None:
        # Edge-connected, and nothing valid anywhere on its boundary to judge
        # by. Older records without the share field land here; do not guess.
        return "sea" if share is not None else "foreign-land"
    return "sea" if median <= SEA_BOUNDARY_MAX_M else "foreign-land"


def check_sea_fill(
    regions_by_ring: dict[str, list[dict]],
    unclassified: dict[str, int] | None = None,
) -> Check:
    """Cells no Lantmäteriet tile covered (contract §11 coverage seam).

    Three verdicts, from `classify_region`:

      * **sea** — the region reaches the grid edge and the Swedish land around
        it is at shore height. Filling at 0 m is true; ship it, and say how much
        of the ring it was so the contact sheet gets a look.
      * **gap** — a hole *enclosed* by covered data. That is a missing tile, and
        it renders as a flat plate in the middle of real terrain. Fail.
      * **foreign-land** — the region reaches the edge but is bounded by high
        ground, i.e. terrain in Norway, Finland or Åland that the tile set
        stops at. Filling that at 0 m is a **false flat horizon**, which §2b
        says must be Copernicus GLO-30 filled instead. Fail, loudly, with the
        numbers — the fix is a pipeline feature, not a retry.
    """
    # "No evidence" is not "no problem". A ring whose fetch predates this
    # classification (a cache written by an older build) has cells outside
    # coverage and nothing that says what they are — and a gate that answers
    # "pass" when it means "I did not look" is worse than no gate at all.
    if unclassified:
        rings = ", ".join(f"{ring} ({cells:,} cells)" for ring, cells in sorted(unclassified.items()))
        return Check(
            "sea-fill",
            "fail",
            f"cells outside tile coverage with no classification recorded: {rings}. The "
            f"cached ring mosaic predates the check, so whether that is open sea or land "
            f"beyond the border is unknown — re-fetch with --force-download",
            {"unclassified": unclassified},
        )
    if not regions_by_ring:
        return Check("sea-fill", "pass", "no cells outside tile coverage")

    verdicts: dict[str, list[tuple[str, dict]]] = {}
    for ring, regions in regions_by_ring.items():
        for region in regions:
            verdicts.setdefault(classify_region(region), []).append((ring, region))

    detail = {
        kind: [
            {
                "ring": ring,
                "cells": r["cells"],
                "boundaryMedianM": r.get("boundaryMedianM"),
                "boundaryValidShare": r.get("boundaryValidShare"),
            }
            for ring, r in items
        ]
        for kind, items in verdicts.items()
    }

    if "foreign-land" in verdicts:
        worst = max(verdicts["foreign-land"], key=lambda item: item[1]["cells"])
        ring, region = worst
        return Check(
            "sea-fill",
            "fail",
            f"{ring}: {region['cells']:,} cells outside tile coverage are bounded by land at "
            f"{region.get('boundaryMedianM')} m over "
            f"{100 * (region.get('boundaryValidShare') or 0):.0f} % of their boundary, not by "
            f"water — this looks like terrain "
            f"beyond the Swedish border, and filling it at 0 m would render a false flat "
            f"horizon. Needs the Copernicus GLO-30 fill (§2b); do not ship this site",
            detail,
        )
    if "gap" in verdicts:
        worst = max(verdicts["gap"], key=lambda item: item[1]["cells"])
        ring, region = worst
        return Check(
            "sea-fill",
            "fail",
            f"{ring}: {region['cells']:,} uncovered cells are enclosed by covered data — "
            f"a hole in the tile set, which renders as a flat plate inside real terrain",
            detail,
        )

    total = sum(r["cells"] for items in verdicts.values() for _ring, r in items)
    return Check(
        "sea-fill",
        "warn",
        f"{total:,} ring cells sea-filled at 0 m, all bounded by shoreline — open sea, "
        f"correctly flat; confirm on the contact sheet",
        detail,
    )


#: How far a ring's heights may sit from the context grid's over their shared
#: footprint, in metres of *median* difference. Generous against block-averaging
#: (a 32 m ring cell averages 256 context cells, and averaging a valley with its
#: shoulders is not an error) and against per-ring quantization, but far below
#: the 23-36 m the EPSG:5845 geoid shift would introduce.
RING_AGREEMENT_TOLERANCE_M = 3.0


def ring_context_offset(
    ring_heights_m: np.ndarray,
    ring_bounds: tuple[float, float, float, float],
    ring_resolution: float,
    context_heights_m: np.ndarray,
    context_bounds: tuple[float, float, float, float],
) -> float | None:
    """Median (ring - context) height over the footprint they share, in metres.

    Returns None when the overlap is too small to say anything. Both grids are
    north-up and axis-aligned in EPSG:3006, so the overlap is found by
    arithmetic on the bounds — no resampling, no reprojection, nothing that
    could itself introduce the shift we are looking for.
    """
    r_min_e, r_min_n, r_max_e, r_max_n = ring_bounds
    c_min_e, c_min_n, c_max_e, c_max_n = context_bounds
    over_min_e, over_max_e = max(r_min_e, c_min_e), min(r_max_e, c_max_e)
    over_min_n, over_max_n = max(r_min_n, c_min_n), min(r_max_n, c_max_n)
    if over_max_e - over_min_e < ring_resolution or over_max_n - over_min_n < ring_resolution:
        return None

    ring = np.asarray(ring_heights_m, dtype=np.float64)
    context = np.asarray(context_heights_m, dtype=np.float64)
    context_resolution = (c_max_e - c_min_e) / context.shape[1]

    # Sample the middle of each overlapping ring cell in both grids. Row 0 is
    # the north edge in both (contract §1), so northing decreases with row.
    cols = np.arange(int((over_max_e - over_min_e) // ring_resolution))
    rows = np.arange(int((over_max_n - over_min_n) // ring_resolution))
    if cols.size == 0 or rows.size == 0:
        return None
    easts = over_min_e + (cols + 0.5) * ring_resolution
    northings = over_max_n - (rows + 0.5) * ring_resolution

    ring_cols = np.clip(((easts - r_min_e) / ring_resolution).astype(int), 0, ring.shape[1] - 1)
    ring_rows = np.clip(((r_max_n - northings) / ring_resolution).astype(int), 0, ring.shape[0] - 1)
    ctx_cols = np.clip(((easts - c_min_e) / context_resolution).astype(int), 0, context.shape[1] - 1)
    ctx_rows = np.clip(((c_max_n - northings) / context_resolution).astype(int), 0, context.shape[0] - 1)

    ring_samples = ring[np.ix_(ring_rows, ring_cols)]
    context_samples = context[np.ix_(ctx_rows, ctx_cols)]
    return float(np.median(ring_samples - context_samples))


def check_ring_agreement(offsets: dict[str, float | None]) -> Check:
    """Rings and context must describe the same ground where they overlap.

    This is the national replacement for Broborg's tight elevation band. Core
    and context come from the 1 m source mosaic; the rings come from decimated
    overview reads — a genuinely different path through GDAL. A vertical datum
    transform creeping into either one shifts it by 23-36 m relative to the
    other (PLAN.md §2.1), and unlike an absolute band this notices wherever the
    site is and however high its terrain.
    """
    measured = {name: offset for name, offset in offsets.items() if offset is not None}
    if not measured:
        return Check("ring-agreement", "pass", "no rings to cross-check")
    worst_name = max(measured, key=lambda n: abs(measured[n]))
    worst = measured[worst_name]
    detail = {"medianOffsetM": {k: round(v, 2) for k, v in measured.items()}}
    if abs(worst) > RING_AGREEMENT_TOLERANCE_M:
        return Check(
            "ring-agreement",
            "fail",
            f"{worst_name} sits {worst:+.1f} m from the context grid over their shared "
            f"footprint (tolerance ±{RING_AGREEMENT_TOLERANCE_M:.0f} m) — the ring and "
            f"the core/context grids are read through different paths, so a systematic "
            f"offset means one of them warped the data (PLAN.md §2.1)",
            detail,
        )
    return Check(
        "ring-agreement",
        "pass",
        f"rings agree with the context grid to {abs(worst):.2f} m (worst: {worst_name})",
        detail,
    )


def check_water_pair(manifest: dict) -> Check:
    """§6/§7/§12: the shoreline table and a connectivity grid ship together or not at all."""
    assets = manifest.get("assets", {})
    has_table = "shoreline" in assets
    has_connect = "waterConnect" in assets or "waterConnectDelta" in assets
    if has_table != has_connect:
        return Check(
            "water-pair",
            "fail",
            f"half a water pair: shoreline={has_table}, connectivity={has_connect}",
        )
    if not has_table:
        return Check("water-pair", "pass", "no water assets (inland site — feature off)")
    encoding = "delta (§12)" if "waterConnectDelta" in assets else "absolute (§7)"
    return Check("water-pair", "pass", f"shoreline + connectivity as {encoding}")


#: Steps whose failure makes a bundle unshippable, whatever else passed.
#: `grids` is the site; `sites` is the KMR overlay, which is a headline feature
#: and — unlike water or the rampart — has no honest "this site simply has none"
#: reading: every fort is in the register we just read it from. Everything else
#: is allowed to be absent, per the contract's "missing asset = feature off".
REQUIRED_STEPS = ("grids", "sites")


def check_steps(steps: list, required: tuple[str, ...] = REQUIRED_STEPS) -> Check:
    """A step that *failed* is different from one that was skipped.

    Skipping is the contract's own feature-off rule and is normal across 1,300
    heterogeneous sites. Failing means something broke — and for a required step
    that is not a bundle to publish, even if every other gate is green.
    """
    by_name = {getattr(s, "name", None) or s.get("name"): (getattr(s, "status", None) or s.get("status")) for s in steps}
    broken = sorted(name for name in required if by_name.get(name) == "failed")
    if broken:
        return Check(
            "required-steps",
            "fail",
            f"required step(s) failed: {', '.join(broken)}",
            {"failed": broken, "steps": by_name},
        )
    other = sorted(name for name, status in by_name.items() if status == "failed")
    if other:
        return Check(
            "required-steps",
            "warn",
            f"optional step(s) failed: {', '.join(other)}",
            {"failed": other, "steps": by_name},
        )
    return Check("required-steps", "pass", "every required step completed", {"steps": by_name})


def check_required_files(out_dir: Path, manifest: dict) -> Check:
    """Every path the manifest names actually exists in the bundle."""
    referenced = [manifest["grids"]["core"]["path"], manifest["grids"]["context"]["path"]]
    for ring in manifest.get("grids", {}).get("rings") or []:
        referenced.append(ring["path"])
        for key in ("waterConnect", "waterConnectDelta"):
            if ring.get(key):
                referenced.append(ring[key])
    referenced += [path for path in manifest.get("assets", {}).values() if isinstance(path, str)]

    missing = sorted(name for name in referenced if not (out_dir / name).exists())
    if missing:
        return Check(
            "files-present",
            "fail",
            f"the manifest names {len(missing)} file(s) the bundle does not have: {missing}",
            {"missing": missing},
        )
    return Check("files-present", "pass", f"all {len(referenced)} referenced files present")


def bundle_bytes(out_dir: Path) -> int:
    return sum(p.stat().st_size for p in out_dir.glob("*") if p.is_file())


def run_gates(
    slug: str,
    out_dir: Path,
    manifest: dict,
    band: tuple[float, float],
    filled_by_grid: dict[str, tuple[int, int]],
    uncovered_by_ring: dict[str, list[dict]] | None = None,
    unclassified_by_ring: dict[str, int] | None = None,
    steps: list | None = None,
    ring_offsets: dict[str, float | None] | None = None,
) -> QAReport:
    """Every gate, in one pass. Never raises on a gate result — that is the report."""
    return QAReport(
        slug=slug,
        checks=[
            *([check_steps(steps)] if steps is not None else []),
            check_required_files(out_dir, manifest),
            check_elevation_band(manifest, band),
            check_nodata_fill(filled_by_grid),
            check_ladder(manifest),
            check_ring_agreement(ring_offsets or {}),
            check_sea_fill(uncovered_by_ring or {}, unclassified_by_ring or {}),
            check_water_pair(manifest),
        ],
    )


def water_mask_at(connect_m: np.ndarray, level_m: float) -> np.ndarray:
    """The §7 wet set at one level — `connect <= h`, for the thumbnail's tint."""
    return np.asarray(connect_m) <= level_m
