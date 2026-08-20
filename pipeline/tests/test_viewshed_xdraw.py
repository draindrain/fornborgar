"""Acceptance gate for the app's XDraw viewshed (PLAN §3 Phase 3, contract §4).

The app owns the algorithm (``app/src/viewshed/xdraw.ts``); this test is the
independent referee. It builds deterministic synthetic DEMs with numpy, runs
GDAL's own ``gdal_viewshed`` over them, runs the *real* TypeScript module over
the identical grid through ``xdraw_runner.mjs`` under
``node --experimental-strip-types``, and compares the two masks cellwise.
No network, no real data — everything here is generated in a tmp dir.

--------------------------------------------------------------------------
gdal_viewshed flag semantics, verified empirically against GDAL 3.8.4
--------------------------------------------------------------------------
The flag names are easy to get backwards, so they were calibrated on a flat
plane (500x500 @ 8 m, observer 0.1 m up) where the curvature horizon is
analytic: ``d = sqrt(2 * oz * R / (1 - k))``.

* ``-vv`` = value written for **visible** cells (default 255)
* ``-iv`` = value for **invisible** cells (default 0)
* ``-ov`` = value for cells **out of range** of ``-md`` (default 0) --
  it is *not* "observer value" and *not* the visible value. This test passes
  ``-vv 1 -iv 0 -ov 0`` so the GDAL raster is already 0/1 like the contract's
  mask; the mapping is done here in the test, never in the app module.
* ``-cc`` = curvature coefficient, applied as ``h -= cc * d^2 / (2R)``:

  ===========  =============================  ==============================
  ``-cc``      meaning                        measured horizon (oz = 0.1 m)
  ===========  =============================  ==============================
  ``0``        curvature **off** entirely     none - whole 500x500 visible
  ``0.87``     1 - k with k = 0.13 (ours)     1208 m vs analytic 1210.2 m
  ``1.0``      curvature, **no** refraction   1128 m vs analytic 1128.8 m
  ``0.85714``  GDAL default, k = 1/7          1216 m vs analytic 1219.2 m
  ===========  =============================  ==============================

  So ``-cc 1.0`` does **not** mean "no curvature" -- ``-cc 0`` does. The
  contract's ``k = 0.13`` maps to ``-cc 0.87``. GDAL's internal earth radius
  is 6 370 000 m against our 6 371 000 m (~0.016 %), which moves a horizon by
  well under one cell at these scales; the tolerances absorb it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import rasterio
from affine import Affine

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNNER = Path(__file__).resolve().parent / "xdraw_runner.mjs"
XDRAW_TS = REPO_ROOT / "app" / "src" / "viewshed" / "xdraw.ts"

GDAL_VIEWSHED = shutil.which("gdal_viewshed") or "/usr/bin/gdal_viewshed"
NODE = shutil.which("node")

# Arbitrary but valid SWEREF 99 TM origin (north-west corner of the test grids).
ORIGIN_E = 500000.0
ORIGIN_N = 6500000.0

EARTH_RADIUS_M = 6371000.0
REFRACTION_K = 0.13

pytestmark = [
    pytest.mark.skipif(NODE is None, reason="node not available"),
    pytest.mark.skipif(
        not Path(GDAL_VIEWSHED).exists(), reason="gdal_viewshed not available"
    ),
]


# --------------------------------------------------------------------------- #
# Synthetic terrain (deterministic: no RNG state leaks between cases)
# --------------------------------------------------------------------------- #


def flat(width: int, height: int, level: float = 10.0) -> np.ndarray:
    return np.full((height, width), level, dtype=np.float32)


def ridge(width: int, height: int, col: int = 200, thickness: int = 2, top: float = 12.0) -> np.ndarray:
    """A knife-edge north-south wall on an otherwise level plain."""
    z = np.zeros((height, width), dtype=np.float32)
    z[:, col : col + thickness] = top
    return z


def rough(width: int, height: int, seed: int = 20260820, relief: float = 15.0) -> np.ndarray:
    """Fixed-seed sines + gaussian bumps, normalised to +/-`relief` meters.

    Wavelengths are expressed as fractions of the window rather than in cells, so
    the same generator produces terrain of comparable *character* at 2 m and at
    20 m cells instead of turning into white noise at the coarse resolution.
    """
    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    u = x / width
    v = y / height
    z = (
        1.00 * np.sin(2 * np.pi * u * 1.7) * np.cos(2 * np.pi * v * 1.3)
        + 0.60 * np.sin(2 * np.pi * (u + v) * 2.3)
        + 0.35 * np.cos(2 * np.pi * (u - 2.0 * v) * 3.1)
        + 0.15 * np.sin(2 * np.pi * u * 9.0 + 2 * np.pi * v * 7.0)
    )
    rng = np.random.default_rng(seed)
    for _ in range(8):
        cx = rng.uniform(0, width)
        cy = rng.uniform(0, height)
        amp = rng.uniform(-1.0, 1.0)
        sig = rng.uniform(width / 14.0, width / 5.0)
        z += amp * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2.0 * sig**2))
    z -= z.mean()
    z *= relief / np.abs(z).max()
    return z.astype(np.float32)


# --------------------------------------------------------------------------- #
# Runners
# --------------------------------------------------------------------------- #


def write_dem(path: Path, z: np.ndarray, resolution: float) -> Affine:
    transform = Affine(resolution, 0.0, ORIGIN_E, 0.0, -resolution, ORIGIN_N)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=z.shape[1],
        height=z.shape[0],
        count=1,
        dtype="float32",
        crs="EPSG:3006",
        transform=transform,
    ) as dst:
        dst.write(z, 1)
    return transform


def run_gdal(
    dem: Path,
    out: Path,
    *,
    resolution: float,
    observer_col: int,
    observer_row: int,
    observer_height: float,
    target_height: float,
    curvature: bool,
) -> np.ndarray:
    """gdal_viewshed over `dem`, returned as a 0/1 uint8 array (1 = visible)."""
    ox = ORIGIN_E + (observer_col + 0.5) * resolution
    oy = ORIGIN_N - (observer_row + 0.5) * resolution
    cc = f"{1.0 - REFRACTION_K:.6g}" if curvature else "0"
    cmd = [
        GDAL_VIEWSHED,
        "-b", "1",
        "-om", "NORMAL",
        "-vv", "1",           # visible value
        "-iv", "0",           # invisible value
        "-ov", "0",           # out-of-range value (no -md here, so unused)
        "-cc", cc,
        "-oz", str(observer_height),
        "-tz", str(target_height),
        "-ox", f"{ox:.6f}",
        "-oy", f"{oy:.6f}",
        "-q",
        str(dem),
        str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    with rasterio.open(out) as src:
        band = src.read(1)
    return (band != 0).astype(np.uint8)


def run_xdraw(
    tmp: Path,
    z: np.ndarray,
    *,
    resolution: float,
    observer_col: float,
    observer_row: float,
    observer_height: float = 1.7,
    target_height: float = 0.0,
    max_radius: float = 0.0,
    curvature: bool = True,
    repeat: int = 1,
) -> tuple[np.ndarray, dict]:
    """The real app module, via node. Returns (mask as 0/1 uint8, runner stats)."""
    height, width = z.shape
    params = {
        "width": width,
        "height": height,
        "resolution": resolution,
        "observerCol": observer_col,
        "observerRow": observer_row,
        "observerHeight": observer_height,
        "targetHeight": target_height,
        "maxRadius": max_radius,
        "curvature": curvature,
        "refractionK": REFRACTION_K,
        "repeat": repeat,
    }
    params_path = tmp / "params.json"
    heights_path = tmp / "heights.f32"
    mask_path = tmp / "mask.u8"
    params_path.write_text(json.dumps(params))
    np.ascontiguousarray(z, dtype="<f4").tofile(heights_path)

    proc = subprocess.run(
        [NODE, "--experimental-strip-types", str(RUNNER),
         str(params_path), str(heights_path), str(mask_path)],
        check=True,
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
    )
    stats = json.loads(proc.stdout.strip().splitlines()[-1])
    mask = np.fromfile(mask_path, dtype=np.uint8).reshape(height, width)
    return mask, stats


# --------------------------------------------------------------------------- #
# Comparison helpers
# --------------------------------------------------------------------------- #


def visibility_boundary(mask: np.ndarray) -> np.ndarray:
    """Cells with an 8-neighbour of the opposite visibility (no wraparound)."""
    b = np.zeros(mask.shape, dtype=bool)

    def mark(a: np.ndarray, c: np.ndarray, sa, sc) -> None:
        diff = a != c
        b[sa] |= diff
        b[sc] |= diff

    m = mask
    mark(m[:, :-1], m[:, 1:], (slice(None), slice(0, -1)), (slice(None), slice(1, None)))
    mark(m[:-1, :], m[1:, :], (slice(0, -1), slice(None)), (slice(1, None), slice(None)))
    mark(m[:-1, :-1], m[1:, 1:], (slice(0, -1), slice(0, -1)), (slice(1, None), slice(1, None)))
    mark(m[:-1, 1:], m[1:, :-1], (slice(0, -1), slice(1, None)), (slice(1, None), slice(0, -1)))
    return b


def dilate(b: np.ndarray, radius: int) -> np.ndarray:
    """8-connected dilation (Chebyshev distance <= radius)."""
    out = b
    for _ in range(radius):
        d = out.copy()
        d[:, :-1] |= out[:, 1:]
        d[:, 1:] |= out[:, :-1]
        d[:-1, :] |= out[1:, :]
        d[1:, :] |= out[:-1, :]
        d[:-1, :-1] |= out[1:, 1:]
        d[1:, 1:] |= out[:-1, :-1]
        d[:-1, 1:] |= out[1:, :-1]
        d[1:, :-1] |= out[:-1, 1:]
        out = d
    return out


def compare(
    ours: np.ndarray,
    theirs: np.ndarray,
    *,
    label: str,
    min_agreement: float,
    boundary_radius: int = 2,
) -> float:
    """Agreement fraction; also asserts disagreements hug GDAL's visibility edges."""
    assert ours.shape == theirs.shape
    disagree = ours != theirs
    agreement = 1.0 - disagree.mean()

    near_edge = dilate(visibility_boundary(theirs), boundary_radius)
    stray = int(np.count_nonzero(disagree & ~near_edge))

    print(
        f"[{label}] agreement={agreement * 100:.3f}% "
        f"disagreeing={int(disagree.sum())}/{disagree.size} "
        f"stray(>{boundary_radius} cells from a GDAL boundary)={stray} "
        f"visible ours={ours.mean() * 100:.2f}% gdal={theirs.mean() * 100:.2f}%"
    )

    assert agreement >= min_agreement, (
        f"{label}: agreement {agreement * 100:.3f}% < required {min_agreement * 100:.3f}%"
    )
    assert stray == 0, (
        f"{label}: {stray} disagreeing cells further than {boundary_radius} cells from "
        "a gdal_viewshed visibility boundary — that is systematic bias, not edge jitter"
    )
    return agreement


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #


def test_runner_uses_the_real_app_module() -> None:
    """The gate is worthless if it grades a copy of the algorithm."""
    assert XDRAW_TS.exists()
    assert "app/src/viewshed/xdraw.ts" in RUNNER.read_text()


def test_gdal_curvature_flag_semantics(tmp_path: Path) -> None:
    """Calibration, re-run every time: -cc 0 is off, -cc 0.87 is our k = 0.13.

    Flat plane, 500x500 @ 8 m, observer 0.1 m up: the analytic curvature horizon
    ``sqrt(2*oz*R/(1-k))`` = 1210 m sits comfortably inside the 4 km grid, so the
    flag's meaning is directly readable off the mask.
    """
    width = height = 500
    res = 8.0
    z = flat(width, height, level=0.0)
    dem = tmp_path / "flatcal.tif"
    write_dem(dem, z, res)
    oc = orow = 250

    off = run_gdal(dem, tmp_path / "cc0.tif", resolution=res, observer_col=oc,
                   observer_row=orow, observer_height=0.1, target_height=0.0,
                   curvature=False)
    on = run_gdal(dem, tmp_path / "cc087.tif", resolution=res, observer_col=oc,
                  observer_row=orow, observer_height=0.1, target_height=0.0,
                  curvature=True)

    assert off.all(), "-cc 0 must mean 'no curvature': a flat plane is fully visible"
    assert not on.all(), "-cc 0.87 must apply curvature"

    last = max(x for x in range(oc, width) if on[orow, x]) - oc
    analytic = np.sqrt(2.0 * 0.1 * EARTH_RADIUS_M / (1.0 - REFRACTION_K))
    print(f"[calibration] gdal horizon={last * res:.0f} m, analytic={analytic:.1f} m")
    assert abs(last * res - analytic) <= 2 * res

    # And our module lands on the same analytic horizon.
    ours, _ = run_xdraw(tmp_path, z, resolution=res, observer_col=oc, observer_row=orow,
                        observer_height=0.1, curvature=True)
    ours_last = max(x for x in range(oc, width) if ours[orow, x]) - oc
    print(f"[calibration] xdraw horizon={ours_last * res:.0f} m")
    assert abs(ours_last * res - analytic) <= 2 * res
    compare(ours, on, label="flat+curvature", min_agreement=0.995)


def test_flat_plane_exact(tmp_path: Path) -> None:
    """(a) Flat plane 200x200 @ 2 m, curvature off — must match GDAL exactly."""
    width = height = 200
    res = 2.0
    z = flat(width, height)
    dem = tmp_path / "flat.tif"
    write_dem(dem, z, res)

    theirs = run_gdal(dem, tmp_path / "flat_vs.tif", resolution=res, observer_col=100,
                      observer_row=100, observer_height=1.7, target_height=0.0,
                      curvature=False)
    ours, _ = run_xdraw(tmp_path, z, resolution=res, observer_col=100, observer_row=100,
                        observer_height=1.7, curvature=False)

    assert ours.all(), "a flat plane with no curvature is entirely visible"
    assert np.array_equal(ours, theirs)


def test_single_ridge(tmp_path: Path) -> None:
    """(b) One knife-edge ridge: the shadow behind it is analytically crisp."""
    width = height = 300
    res = 2.0
    z = ridge(width, height, col=200, thickness=2, top=12.0)
    dem = tmp_path / "ridge.tif"
    write_dem(dem, z, res)

    theirs = run_gdal(dem, tmp_path / "ridge_vs.tif", resolution=res, observer_col=40,
                      observer_row=150, observer_height=1.7, target_height=0.0,
                      curvature=False)
    ours, _ = run_xdraw(tmp_path, z, resolution=res, observer_col=40, observer_row=150,
                        observer_height=1.7, curvature=False)

    # A real shadow must exist, or the test would pass vacuously.
    assert 0.05 < theirs.mean() < 0.95
    compare(ours, theirs, label="ridge", min_agreement=0.99)


def test_rough_terrain(tmp_path: Path) -> None:
    """(c) Rough terrain 300x300 @ 2 m, curvature off."""
    width = height = 300
    res = 2.0
    z = rough(width, height)
    dem = tmp_path / "rough.tif"
    write_dem(dem, z, res)

    theirs = run_gdal(dem, tmp_path / "rough_vs.tif", resolution=res, observer_col=150,
                      observer_row=150, observer_height=1.7, target_height=0.0,
                      curvature=False)
    ours, _ = run_xdraw(tmp_path, z, resolution=res, observer_col=150, observer_row=150,
                        observer_height=1.7, curvature=False)

    assert 0.03 < theirs.mean() < 0.95
    compare(ours, theirs, label="rough", min_agreement=0.97)


def test_rough_terrain_with_curvature(tmp_path: Path) -> None:
    """(d) Rough terrain at landscape scale where curvature genuinely bites.

    500x500 @ 20 m = a 10 x 10 km window: the curvature drop at the 5 km edge is
    ``0.87 * 5000^2 / (2R)`` = 1.7 m, i.e. comparable to the eye height, so the
    ``-cc`` term is doing real work rather than rounding: switching it off flips
    over 1 % of the grid. (The brief suggested 8 m cells; at 8 m the whole window
    is 4 km across and the drop is 0.27 m, which would let a broken curvature
    term pass unnoticed — hence the wider window and the gentler 8 m relief.)
    """
    width = height = 500
    res = 20.0
    z = rough(width, height, seed=77002, relief=8.0)
    dem = tmp_path / "roughc.tif"
    write_dem(dem, z, res)

    theirs = run_gdal(dem, tmp_path / "roughc_vs.tif", resolution=res, observer_col=250,
                      observer_row=250, observer_height=1.7, target_height=0.0,
                      curvature=True)
    ours, _ = run_xdraw(tmp_path, z, resolution=res, observer_col=250, observer_row=250,
                        observer_height=1.7, curvature=True)

    # Curvature must actually change the answer here, in both implementations.
    theirs_flatearth = run_gdal(dem, tmp_path / "roughc_nc.tif", resolution=res,
                                observer_col=250, observer_row=250, observer_height=1.7,
                                target_height=0.0, curvature=False)
    ours_flatearth, _ = run_xdraw(tmp_path, z, resolution=res, observer_col=250,
                                  observer_row=250, observer_height=1.7, curvature=False)
    gdal_delta = float((theirs != theirs_flatearth).mean())
    our_delta = float((ours != ours_flatearth).mean())
    print(f"[rough+curvature] curvature changes gdal {gdal_delta * 100:.2f}% of cells, "
          f"ours {our_delta * 100:.2f}%")
    assert gdal_delta > 0.005 and our_delta > 0.005

    assert 0.03 < theirs.mean() < 0.95
    compare(ours, theirs, label="rough+curvature", min_agreement=0.97)


def test_target_height_shifts_visibility(tmp_path: Path) -> None:
    """A non-zero target height must be handled the same way GDAL handles -tz."""
    width = height = 300
    res = 2.0
    z = rough(width, height)
    dem = tmp_path / "roughtz.tif"
    write_dem(dem, z, res)

    theirs = run_gdal(dem, tmp_path / "roughtz_vs.tif", resolution=res, observer_col=150,
                      observer_row=150, observer_height=1.7, target_height=1.7,
                      curvature=False)
    ours, _ = run_xdraw(tmp_path, z, resolution=res, observer_col=150, observer_row=150,
                        observer_height=1.7, target_height=1.7, curvature=False)

    zero_target = run_gdal(dem, tmp_path / "roughtz0_vs.tif", resolution=res,
                           observer_col=150, observer_row=150, observer_height=1.7,
                           target_height=0.0, curvature=False)
    assert theirs.mean() > zero_target.mean(), "target height must reveal more ground"
    compare(ours, theirs, label="rough+targetHeight", min_agreement=0.97)


def test_runtime_on_full_size_grid(tmp_path: Path) -> None:
    """The production grid is 2000x2000 (contract §1). Generous CI bound: 2 s."""
    width = height = 2000
    res = 2.0
    y, x = np.mgrid[0:height, 0:width].astype(np.float64)
    rng = np.random.default_rng(4242)
    z = 20.0 * np.sin(x / 97.0) * np.cos(y / 83.0) + 7.0 * np.sin((x + y) / 31.0)
    for _ in range(6):
        cx, cy = rng.uniform(0, width), rng.uniform(0, height)
        z += rng.uniform(-25, 25) * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * 300.0**2))
    z = z.astype(np.float32)

    _mask, stats = run_xdraw(tmp_path, z, resolution=res, observer_col=1000.5,
                             observer_row=1000.5, observer_height=1.7, curvature=True,
                             repeat=3)
    print(f"[runtime] 2000x2000 best of 3: {stats['elapsedMs']:.1f} ms "
          f"({stats['visible'] / stats['cells'] * 100:.1f}% visible)")
    assert stats["elapsedMs"] < 2000.0, f"too slow: {stats['elapsedMs']:.1f} ms"


if __name__ == "__main__":  # pragma: no cover - convenience
    sys.exit(pytest.main([__file__, "-q", "-s"]))
