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


def check_sea_fill(manifest: dict, coastal: bool) -> Check:
    """Cells no Lantmäteriet tile covered (contract §11 coverage seam).

    For a site whose rings reach open Baltic this is correct and expected — the
    sea *is* at 0 m. For an interior site it means one of two things, and we
    cannot tell which from here: a gap in the tile set, or terrain outside
    Sweden (Norway, Finland, Åland) that Copernicus GLO-30 was meant to fill and
    has not. Either way the render is a **false flat horizon**, which is the one
    dishonest thing this project must not ship. So: `fail`, and go look.
    """
    filled = sea_filled_cells(manifest)
    total = sum(filled.values())
    if total == 0:
        return Check("sea-fill", "pass", "no cells outside tile coverage")
    if coastal:
        return Check(
            "sea-fill",
            "warn",
            f"{total:,} ring cells sea-filled at 0 m — expected for a coastal site, "
            f"but confirm the thumbnail shows sea there",
            {"byRing": filled, "coastal": True},
        )
    return Check(
        "sea-fill",
        "fail",
        f"{total:,} ring cells outside tile coverage on an interior site "
        f"({filled}) — a coverage gap or un-filled non-Swedish land would render "
        f"a false flat horizon; investigate before shipping",
        {"byRing": filled, "coastal": False},
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
    coastal: bool,
    steps: list | None = None,
) -> QAReport:
    """Every gate, in one pass. Never raises on a gate result — that is the report."""
    return QAReport(
        slug=slug,
        checks=[
            *( [check_steps(steps)] if steps is not None else [] ),
            check_required_files(out_dir, manifest),
            check_elevation_band(manifest, band),
            check_nodata_fill(filled_by_grid),
            check_ladder(manifest),
            check_sea_fill(manifest, coastal),
            check_water_pair(manifest),
        ],
    )


def water_mask_at(connect_m: np.ndarray, level_m: float) -> np.ndarray:
    """The §7 wet set at one level — `connect <= h`, for the thumbnail's tint."""
    return np.asarray(connect_m) <= level_m
