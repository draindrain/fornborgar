"""REVEALS openness anchor per 1° cell (docs/vegetation-zones.md §3.1, §3.2).

The LandClimII product (Fyfe et al. 2021; described by Githumbi et al. 2022) holds
pollen-based REVEALS land-cover reconstructions for Europe on a 1°×1° grid, in 25
consecutive Holocene time windows. We read exactly one of them — `TW5`,
**1,200–1,700 cal BP = 250–750 CE**, the window our sites sit in — and exactly one
of its columns, open land (`OL`), plus that cell's standard error.

**What this number is for, and what it must never be.** It is *disclosure*: a site
whose 1° cell is covered gets the cell's OL ± SE quoted in the legend's calibration
paragraph as regional context, next to the model's own context fraction. It is
never a model parameter, never fitted to, never used to move a radius or a stem
density (§3.2, PLAN.md §4.7). The reasons are measured, not stylistic: the spread
across cells within one vegetation zone (10.7–58.8 % in boreonemoral) is larger
than the differences between zones, per-cell SEs run to ±25, and a 100×100 km cell
mean is the wrong scale to force onto a 4×4 km fort context.

**Absence is a result, not a failure.** 25 of the 41 cells holding registry sites —
913 of 1,304 sites (70 %), the whole Mälaren valley, Östergötland and Gotland,
Broborg's cell among them — carry no estimate in any of the product's 25 windows:
no pollen record existed to feed REVEALS there (§3.1). `openness_anchor` returns
`None` for those, and the caller is expected to say so plainly rather than
substitute a neighbouring cell or a zone mean.

Stdlib only, so the lookup costs nothing at build time beyond one parse of two
~0.24 MB CSVs, cached for the process.
"""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data" / "landclimII"
MEANS_FILE = "TW5.RV.estimates.jun21.csv"
ERRORS_FILE = "TW5.RV.standarderrors.jun21.csv"

# The one time window this module reads. TW5 in the product's numbering; the
# ordering was verified against the Skåne cell, whose modern window carries 11 %
# spruce and 4.6 % cereals against this window's 0.1 % and 1.1 % (§3).
WINDOW = "1200-1700 cal BP (250-750 CE)"
CITATION = "Githumbi et al. 2022; data Fyfe et al. 2021 (LandClimII), CC BY 4.0"

# Product grid: 1° cells addressed by their centre, i.e. whole degree + 0.5.
CELL_SIZE_DEG = 1.0

# The columns we read. The files carry ~48 more (taxa and the intermediate
# land-cover groupings); none of them is ours to interpret here.
LON_COLUMN = "lonDD"
LAT_COLUMN = "latDD"
OPEN_LAND_COLUMN = "OL"  # open land, per cent of cell cover


@dataclass(frozen=True)
class RevealsAnchor:
    """One cell's open-land estimate, as quoted — not as fitted."""

    cell_lon: float  # cell centre, degrees east
    cell_lat: float  # cell centre, degrees north
    open_land_pct: float
    open_land_se_pct: float | None  # None when the errors file has no number here
    window: str = WINDOW


def cell_centre(lon: float, lat: float) -> tuple[float, float]:
    """Centre of the 1° cell containing (lon, lat). Halves are exact in binary,
    so the result is a safe dict key."""
    return math.floor(lon) + 0.5 * CELL_SIZE_DEG, math.floor(lat) + 0.5 * CELL_SIZE_DEG


@lru_cache(maxsize=None)
def open_land_table(filename: str) -> dict[tuple[float, float], float]:
    """Parse one LandClimII CSV into {cell centre: open land %}.

    Rows whose `lonDD`, `latDD` or `OL` field does not parse as a float are
    dropped: the last rows of both files carry `#N/A` coordinates (cells outside
    the geographic product), and a cell without a numeric OL is the same thing as
    an absent cell for our purposes — no estimate to quote.
    """
    table: dict[tuple[float, float], float] = {}
    with (DATA_DIR / filename).open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            try:
                lon = float(row[LON_COLUMN])
                lat = float(row[LAT_COLUMN])
                open_land = float(row[OPEN_LAND_COLUMN])
            except (KeyError, TypeError, ValueError):
                continue
            table[cell_centre(lon, lat)] = open_land
    return table


def openness_anchor(lon: float, lat: float) -> RevealsAnchor | None:
    """The REVEALS open-land anchor for the 1° cell containing (lon, lat).

    Returns `None` when the product holds no numeric estimate for that cell —
    the documented majority case over the Swedish registry (§3.1). The caller
    discloses that absence; it does not fill it in.
    """
    cell = cell_centre(lon, lat)
    open_land = open_land_table(MEANS_FILE).get(cell)
    if open_land is None:
        return None
    return RevealsAnchor(
        cell_lon=cell[0],
        cell_lat=cell[1],
        open_land_pct=open_land,
        open_land_se_pct=open_land_table(ERRORS_FILE).get(cell),
    )
