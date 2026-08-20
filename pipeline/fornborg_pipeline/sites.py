"""Per-site configuration.

All coordinates are SWEREF 99 TM (EPSG:3006); heights are meters RH 2000.
Extents follow PLAN.md §7.11: a 4x4 km context clip centered on the site, with a
2x2 km core clip concentric inside it.

Adding a site is a data change here plus a pipeline run — no code changes.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

# Horizontal CRS for everything the pipeline writes. Horizontal ONLY: the source
# COGs declare compound EPSG:5845 (SWEREF 99 TM + RH 2000) and carrying that
# vertical axis invites the gdalwarp RH2000 -> ellipsoid shift (PLAN.md §2.1).
EPSG_HORIZONTAL = 3006
VERTICAL_DATUM = "RH2000"

# Lantmäteriet Höjd STAC API (anonymous search; asset reads need Basic auth).
STAC_ROOT = "https://api.lantmateriet.se/stac-hojd/v1"
DTM_COLLECTION = "dtm-cog"
DTM_NODATA = -9999.0

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = REPO_ROOT / "data-cache"
APP_DATA_DIR = REPO_ROOT / "app" / "public" / "data"


@dataclass(frozen=True)
class GridSpec:
    """One output grid: a square, site-centered clip at a fixed resolution."""

    name: str
    half_extent: float  # meters from the site center to each edge
    resolution: float  # meters per pixel
    path: str  # file name, relative to the site's data directory

    @property
    def size(self) -> int:
        n = (2.0 * self.half_extent) / self.resolution
        if abs(n - round(n)) > 1e-9:
            raise ValueError(f"grid {self.name}: extent not an integer number of pixels")
        return int(round(n))


@dataclass(frozen=True)
class SiteConfig:
    id: str
    name: str
    center_e: float
    center_n: float
    core: GridSpec
    context: GridSpec
    # Resolution of the source mosaic that gets fetched/clipped (m/px).
    source_resolution: float = 1.0
    # Hard sanity band for every height in the outputs (m RH 2000). A Swedish
    # lowland site outside this range means a geoid shift crept in (PLAN.md §2.1).
    elevation_range: tuple[float, float] = (-10.0, 200.0)
    # Hard sanity band for the height at the site center (m RH 2000).
    center_height_range: tuple[float, float] = (40.0, 60.0)
    raa: dict | None = None
    kmr_fetched: str = ""

    @property
    def grids(self) -> tuple[GridSpec, ...]:
        return (self.core, self.context)

    @property
    def source_half_extent(self) -> float:
        """Half-extent of the raw mosaic to fetch (the widest grid)."""
        return max(g.half_extent for g in self.grids)

    def bounds3006(self, half_extent: float) -> tuple[float, float, float, float]:
        """(minE, minN, maxE, maxN) of a site-centered square clip."""
        return (
            self.center_e - half_extent,
            self.center_n - half_extent,
            self.center_e + half_extent,
            self.center_n + half_extent,
        )

    @property
    def source_bounds(self) -> tuple[float, float, float, float]:
        return self.bounds3006(self.source_half_extent)

    @property
    def cache_path(self) -> Path:
        return CACHE_DIR / f"{self.id}_dem_source.tif"

    @property
    def cache_meta_path(self) -> Path:
        return CACHE_DIR / f"{self.id}_dem_source.json"

    @property
    def out_dir(self) -> Path:
        return APP_DATA_DIR / self.id


def _standard_grids() -> dict:
    return {
        "core": GridSpec("core", half_extent=1000.0, resolution=1.0, path="dem_core.tif"),
        "context": GridSpec("context", half_extent=2000.0, resolution=2.0, path="dem_context.tif"),
    }


BROBORG = SiteConfig(
    id="broborg",
    name="Broborg",
    # KMR extent-polygon centroid E 665808 / N 6627881, rounded to 10 m
    # [phase-0 verified]. PLAN.md's original WGS84-derived guess was 2.6 km east.
    center_e=665810.0,
    center_n=6627880.0,
    **_standard_grids(),
    # Fort crown sits at ~50 m RH 2000; the 4x4 km clip spans ~6.8..57.3 m.
    elevation_range=(-10.0, 200.0),
    center_height_range=(40.0, 60.0),
    raa={
        "lamningsnummer": "L1943:7827",
        "raaNummer": "Husby-Långhundra 156:1",
        "kmrUuid": "184ca0f6-16f9-4de8-bbec-99aa959f9824",
        "fornsokUrl": "https://pub.raa.se/visa/objekt/lamning/184ca0f6-16f9-4de8-bbec-99aa959f9824",
    },
    kmr_fetched="2026-08-20",
)

SITES: dict[str, SiteConfig] = {BROBORG.id: BROBORG}


def get_site(site_id: str) -> SiteConfig:
    try:
        return SITES[site_id]
    except KeyError:
        raise SystemExit(
            f"unknown site {site_id!r}; known sites: {', '.join(sorted(SITES))}"
        ) from None
