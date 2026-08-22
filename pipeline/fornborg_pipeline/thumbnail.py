"""Hillshade thumbnails for the QA contact sheet (scale-out §4.4).

Nobody can eyeball 1,304 sites in a viewer, but a contact sheet of 1,304
hillshades is a 30-minute human sweep — and the same images double as the site
picker's preview imagery (§5.4 `index.json`). One PNG per built site, rendered
from the grids the build just wrote.

PNG encoding is done here with `zlib` + `struct` rather than Pillow: the format's
8-bit greyscale/RGB case is a dozen lines, and the batch pipeline should not grow
an imaging dependency for it.

The hillshade is the same *multidirectional* relief the phase-0 legibility gate
used (`pipeline/spike/hillshade.py`), but computed from the surface normal rather
than that spike's aspect formula, whose azimuth came out mirrored (asking for a
north-west sun lit the south-east flank). That never mattered for the gate — the
question there was whether 1-2 m ramparts are legible at all, and mirrored relief
is still relief — but it matters here: a contact sheet lit from below-right
triggers the classic relief-inversion illusion, and ridges reading as ditches is
exactly the misjudgement a QA sweep must not make. The spike is left as the
phase-0 record it is.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np

THUMBNAIL_PATH = "thumbnail.png"
#: Contact-sheet cell size. Large enough that a rampart ring is recognisable,
#: small enough that 1,304 of them are a ~30 MB page.
DEFAULT_SIZE = 320
#: Sun directions for the multidirectional hillshade, and their weights.
SUN_AZIMUTHS = (315.0, 45.0, 135.0, 225.0)
SUN_WEIGHTS = (0.45, 0.25, 0.15, 0.15)
SUN_ALTITUDE = 35.0


def hillshade(heights_m: np.ndarray, resolution: float, azimuth_deg: float, altitude_deg: float) -> np.ndarray:
    """Lambertian hillshade in [0, 1]. `azimuth_deg` is a compass bearing.

    Computed as `normal · sun` in an (east, north, up) frame, which leaves no
    room for an aspect-convention sign error: the sun for azimuth A, altitude α
    is `(cos α sin A, cos α cos A, sin α)`, and the unit normal of the surface is
    `(−∂z/∂east, −∂z/∂north, 1)` normalised.

    Array convention is the contract's (docs/data-formats.md §1): row 0 is the
    northernmost row, columns run west to east — so `np.gradient`'s first output
    is ∂z/∂south and has to be negated to become ∂z/∂north.
    """
    z = np.asarray(heights_m, dtype=np.float64)
    dz_dsouth, dz_deast = np.gradient(z, resolution)
    dz_dnorth = -dz_dsouth

    azimuth = np.radians(azimuth_deg)
    altitude = np.radians(altitude_deg)
    sun = (
        np.cos(altitude) * np.sin(azimuth),
        np.cos(altitude) * np.cos(azimuth),
        np.sin(altitude),
    )
    norm = np.sqrt(dz_deast**2 + dz_dnorth**2 + 1.0)
    shaded = (-dz_deast * sun[0] - dz_dnorth * sun[1] + sun[2]) / norm
    return np.clip(shaded, 0.0, 1.0)


def multidirectional(heights_m: np.ndarray, resolution: float) -> np.ndarray:
    """Weighted multi-sun relief — earthworks stay legible whatever their aspect."""
    total = np.zeros(np.asarray(heights_m).shape, dtype=np.float64)
    for azimuth, weight in zip(SUN_AZIMUTHS, SUN_WEIGHTS, strict=True):
        total += weight * hillshade(heights_m, resolution, azimuth, SUN_ALTITUDE)
    return np.clip(total / sum(SUN_WEIGHTS), 0.0, 1.0)


def downsample_to(array: np.ndarray, size: int) -> np.ndarray:
    """Block-mean `array` down to at most `size` px per side (never upsamples)."""
    array = np.asarray(array, dtype=np.float64)
    height, width = array.shape
    factor = max(1, int(min(height, width) // size))
    if factor == 1:
        return array
    h = (height // factor) * factor
    w = (width // factor) * factor
    return array[:h, :w].reshape(h // factor, factor, w // factor, factor).mean(axis=(1, 3))


def _chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_png(path: Path, image: np.ndarray) -> Path:
    """Write a uint8 array as a PNG: (h, w) greyscale or (h, w, 3) RGB."""
    data = np.asarray(image)
    if data.dtype != np.uint8:
        raise ValueError(f"expected uint8 samples, got {data.dtype}")
    if data.ndim == 2:
        height, width = data.shape
        colour_type, channels = 0, 1
    elif data.ndim == 3 and data.shape[2] == 3:
        height, width, _ = data.shape
        colour_type, channels = 2, 3
    else:
        raise ValueError(f"expected (h, w) or (h, w, 3), got shape {data.shape}")

    # Each scanline is prefixed with its filter byte; filter 0 (None) keeps the
    # encoder trivial and costs little on already-smooth relief.
    raw = bytearray()
    flat = data.reshape(height, width * channels)
    for row in range(height):
        raw.append(0)
        raw += flat[row].tobytes()

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as out:
        out.write(b"\x89PNG\r\n\x1a\n")
        out.write(_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, colour_type, 0, 0, 0)))
        out.write(_chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        out.write(_chunk(b"IEND", b""))
    return path


def render_thumbnail(
    path: Path,
    heights_m: np.ndarray,
    resolution: float,
    size: int = DEFAULT_SIZE,
    water_mask: np.ndarray | None = None,
) -> Path:
    """Render one site's contact-sheet thumbnail from its core grid.

    `water_mask` (True = under the reference water level) tints the modelled
    paleo-water so a coastal site reads as coastal at thumbnail scale — the QA
    sweep is largely about spotting sites where the water came out wrong.
    """
    relief = multidirectional(heights_m, resolution)
    small = downsample_to(relief, size)
    grey = np.clip(small * 255.0, 0, 255).astype(np.uint8)

    if water_mask is None:
        return write_png(path, grey)

    wet = downsample_to(np.asarray(water_mask, dtype=np.float64), size)
    wet = wet[: grey.shape[0], : grey.shape[1]]
    rgb = np.repeat(grey[:, :, None], 3, axis=2).astype(np.float64)
    # A cool wash, not a flat fill: the relief under the water stays readable.
    tint = np.array([40.0, 90.0, 140.0])
    alpha = np.clip(wet, 0.0, 1.0)[:, :, None] * 0.65
    rgb = rgb * (1.0 - alpha) + tint * alpha
    return write_png(path, np.clip(rgb, 0, 255).astype(np.uint8))
