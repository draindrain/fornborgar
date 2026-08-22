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
    # Vertical quantization step (m): height_m = raw_int16 * quant_scale
    # (docs/data-formats.md §1 and §11 — 0.1 m core/context, coarser far rings).
    quant_scale: float = 0.1

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
    # Hard sanity band for the height at the site center (m RH 2000). `None`
    # skips the center test: a registry-driven site has no hand-verified crown
    # height to compare against, and inventing one would either never fire or
    # fire on perfectly good data. The *range* gate — which is what actually
    # catches the geoid shift — always runs.
    center_height_range: tuple[float, float] | None = (40.0, 60.0)
    raa: dict | None = None
    kmr_fetched: str = ""
    # Where the bundle is written. `None` = the committed `app/public/data/<id>/`
    # (Broborg and the testsite); batch builds point it at a scratch directory
    # so a national run never touches the repository.
    out_dir_override: Path | None = None
    # Informational, from the registry: which §5.2 extent preset produced the
    # grid specs above, and the KMR extent bbox the preset was chosen from.
    extent_preset: str = "standard"
    county: str = ""
    # True for a site built from `registry.json` rather than configured by hand
    # here. It is what tells the KMR extract step that the *national* GeoPackage
    # is required: the Uppsala county file is a legitimate fallback for the
    # hand-configured Uppland sites and would silently return an empty overlay
    # for a fort anywhere else in the country.
    from_registry: bool = False

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

    def ring_cache_path(self, spec: GridSpec) -> Path:
        return CACHE_DIR / f"{self.id}_dem_{spec.name}.tif"

    def ring_cache_meta_path(self, spec: GridSpec) -> Path:
        return CACHE_DIR / f"{self.id}_dem_{spec.name}.json"

    @property
    def out_dir(self) -> Path:
        return self.out_dir_override or (APP_DATA_DIR / self.id)


def _standard_grids() -> dict:
    return {
        "core": GridSpec("core", half_extent=1000.0, resolution=1.0, path="dem_core.tif"),
        "context": GridSpec("context", half_extent=2000.0, resolution=2.0, path="dem_context.tif"),
    }


def _large_grids() -> dict:
    """The §5.2 `large` preset: twice the ground, same 2000x2000 pixel budget.

    Only the three registered forts wider than a kilometre need it (Halleberg,
    Ramundersborg, Torsburgen). Grid *sizes* are unchanged, so every performance
    and memory budget in the app holds exactly as for a standard site.
    """
    return {
        "core": GridSpec("core", half_extent=2000.0, resolution=2.0, path="dem_core.tif"),
        "context": GridSpec("context", half_extent=4000.0, resolution=4.0, path="dem_context.tif"),
    }


#: §5.2 extent presets, by name. `source_resolution` is the resolution of the raw
#: mosaic the clip step reads: 1 m for a standard site, 2 m for a `large` one
#: (whose finest output grid is 2 m — fetching 1 m would quadruple the transfer
#: for data that gets block-averaged away).
EXTENT_PRESETS: dict[str, dict] = {
    "standard": {"grids": _standard_grids, "source_resolution": 1.0},
    "large": {"grids": _large_grids, "source_resolution": 2.0},
}

#: National height band (m RH 2000) for a registry-driven site.
#:
#: Broborg's tight [-10, 200] band was tuned to one Uppland valley. Nationally it
#: has to hold everything a legitimate ladder covers, and the first three
#: registry sites built showed both ends of that: a fort near Örebro has ring
#: cells at 208 m (Kilsbergen is real terrain), and one on Öland has ring cells
#: at -16 m, where a 64 km box reaches Baltic water and the ground model carries
#: interpolated and occasionally negative values there. Neither is a bug.
#:
#: **This band is a gross-corruption check, not the geoid tripwire.** That is
#: the honest consequence of widening it: the EPSG:5845 bug shifts heights
#: *up* by 23-36 m, and on a lowland site that lands a 0..60 m range at 25..85 m
#: — comfortably inside any band wide enough for Norrland. What actually catches
#: a vertical shift nationally is `qa.check_ring_agreement`: the rings are read
#: through a different code path from core/context (decimated overview reads vs.
#: the 1 m mosaic), so the two disagreeing over their shared footprint is a
#: direct, site-independent signal that one of them warped the data.
NATIONAL_ELEVATION_RANGE = (-100.0, 2200.0)


# The far-field ring ladder (docs/data-formats.md §11, docs/national-scaleout.md
# §2b): concentric 2000x2000 grids that extend a site until the skyline closes at
# the true refracted horizon. Every ring is fetched at its own resolution from the
# source COGs' overview levels — rings never go through the 1 m source mosaic.
# How deep a site's ladder goes is decided per site by `horizon.ladder` (a site
# always ships ring3+ring4; the ladder extends while half_extent < the horizon
# distance, capped at ring7).
RING_LADDER: tuple[GridSpec, ...] = (
    GridSpec("ring3", half_extent=4000.0, resolution=4.0, path="dem_ring3.tif", quant_scale=0.5),
    GridSpec("ring4", half_extent=8000.0, resolution=8.0, path="dem_ring4.tif", quant_scale=0.5),
    GridSpec("ring5", half_extent=16000.0, resolution=16.0, path="dem_ring5.tif", quant_scale=0.5),
    GridSpec("ring6", half_extent=32000.0, resolution=32.0, path="dem_ring6.tif", quant_scale=1.0),
    GridSpec("ring7", half_extent=64000.0, resolution=64.0, path="dem_ring7.tif", quant_scale=1.0),
)


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


def register_site(cfg: SiteConfig) -> SiteConfig:
    """Make `cfg` resolvable by `get_site` for the rest of this process.

    Every pipeline step takes a `site_id` and looks it up here, which is exactly
    what makes a batch build possible without touching those steps: `build_site`
    turns a registry entry into a `SiteConfig`, registers it, and then runs the
    ordinary per-site pipeline. Nothing is persisted — the hand-written entries
    above stay the only ones that survive a restart.
    """
    SITES[cfg.id] = cfg
    return cfg


def get_site(site_id: str) -> SiteConfig:
    try:
        return SITES[site_id]
    except KeyError:
        raise SystemExit(
            f"unknown site {site_id!r}; known sites: {', '.join(sorted(SITES))}"
        ) from None
