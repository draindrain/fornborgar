"""Shared synthetic fixtures. No network, no real data, no credentials."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from affine import Affine

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fornborg_pipeline.sites import GridSpec, SiteConfig  # noqa: E402

# A small stand-in for a real site: 400x400 m at 1 m, core 200x200 m at 1 m,
# context 400x400 m at 2 m (200x200 px) — same shape of problem as Broborg's
# 4x4 km / 2x2 km pair, 1/100th the area.
FAKE_CENTER_E = 100000.0
FAKE_CENTER_N = 6000000.0
SOURCE_SIZE = 400
NODATA = -9999.0

# Analytic surface: a 30 m Gaussian hill on a 20 m plane with a gentle east tilt
# and a low-amplitude ripple, so block-averaging and quantization have something
# non-trivial to chew on. Peak = 50 m at the site center.
HILL_AMPLITUDE = 30.0
HILL_SIGMA = 40.0
BASE_HEIGHT = 20.0


@pytest.fixture
def fake_site() -> SiteConfig:
    return SiteConfig(
        id="testsite",
        name="Test Site",
        center_e=FAKE_CENTER_E,
        center_n=FAKE_CENTER_N,
        core=GridSpec("core", half_extent=100.0, resolution=1.0, path="dem_core.tif"),
        context=GridSpec("context", half_extent=200.0, resolution=2.0, path="dem_context.tif"),
        source_resolution=1.0,
        elevation_range=(0.0, 120.0),
        center_height_range=(40.0, 60.0),
        raa={"lamningsnummer": "L0000:0000"},
        kmr_fetched="2026-01-01",
    )


def analytic_surface(cfg: SiteConfig, size: int = SOURCE_SIZE) -> tuple[np.ndarray, Affine]:
    """Height field (m) over the site's source extent, sampled at pixel centers."""
    west, _south, _east, north = cfg.source_bounds
    res = cfg.source_resolution
    transform = Affine(res, 0.0, west, 0.0, -res, north)

    cols = west + (np.arange(size) + 0.5) * res
    rows = north - (np.arange(size) + 0.5) * res
    e, n = np.meshgrid(cols, rows)
    de, dn = e - cfg.center_e, n - cfg.center_n

    z = (
        BASE_HEIGHT
        + HILL_AMPLITUDE * np.exp(-(de**2 + dn**2) / (2.0 * HILL_SIGMA**2))
        + 0.004 * de
        + 0.35 * np.sin(de / 11.0) * np.cos(dn / 13.0)
    )
    return z.astype(np.float32), transform


# Nodata holes: a block, a stripe and a few scattered cells, all well inside the
# extent so fillnodata has valid neighbours in every direction.
NODATA_HOLES = ((slice(50, 60), slice(70, 85)), (slice(300, 302), slice(120, 260)))
NODATA_SPECKLES = ((10, 390), (395, 12), (200, 199), (123, 321))


@pytest.fixture
def fake_source(fake_site: SiteConfig):
    """(array with nodata holes, transform, nodata value, pristine array)."""
    pristine, transform = analytic_surface(fake_site)
    holed = pristine.copy()
    for rows, cols in NODATA_HOLES:
        holed[rows, cols] = NODATA
    for r, c in NODATA_SPECKLES:
        holed[r, c] = NODATA
    return holed, transform, NODATA, pristine


@pytest.fixture
def fake_source_clean(fake_site: SiteConfig):
    """(array without holes, transform, nodata value)."""
    pristine, transform = analytic_surface(fake_site)
    return pristine, transform, NODATA
