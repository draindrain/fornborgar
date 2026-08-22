"""Contact-sheet thumbnails (scale-out §4.4): hillshade + a stdlib PNG encoder.

The PNG writer is hand-rolled, so the tests decode what it writes rather than
trusting it — a thumbnail nobody can open is worse than no thumbnail, because
the QA sweep would show 1,304 broken images and nobody would know why.
"""

from __future__ import annotations

import struct
import zlib

import numpy as np
import pytest

from fornborg_pipeline.thumbnail import (
    downsample_to,
    hillshade,
    multidirectional,
    render_thumbnail,
    write_png,
)


def decode_png(path):
    """Minimal PNG reader: returns (width, height, colour_type, samples)."""
    blob = path.read_bytes()
    assert blob[:8] == b"\x89PNG\r\n\x1a\n"
    offset = 8
    header = None
    idat = b""
    seen_end = False
    while offset < len(blob):
        (length,) = struct.unpack_from(">I", blob, offset)
        tag = blob[offset + 4 : offset + 8]
        payload = blob[offset + 8 : offset + 8 + length]
        (crc,) = struct.unpack_from(">I", blob, offset + 8 + length)
        assert crc == zlib.crc32(tag + payload) & 0xFFFFFFFF, f"bad CRC on {tag!r}"
        if tag == b"IHDR":
            header = struct.unpack(">IIBBBBB", payload)
        elif tag == b"IDAT":
            idat += payload
        elif tag == b"IEND":
            seen_end = True
        offset += 12 + length
    assert seen_end, "PNG has no IEND chunk"
    width, height, depth, colour_type, _c, _f, _i = header
    assert depth == 8
    channels = 1 if colour_type == 0 else 3
    raw = zlib.decompress(idat)
    stride = width * channels + 1
    assert len(raw) == stride * height
    rows = []
    for r in range(height):
        assert raw[r * stride] == 0, "only filter 0 is written"
        rows.append(np.frombuffer(raw[r * stride + 1 : (r + 1) * stride], dtype=np.uint8))
    return width, height, colour_type, np.array(rows).reshape(height, width, channels)


def slope_surface(size: int = 64) -> np.ndarray:
    rows, cols = np.mgrid[0:size, 0:size]
    return 10.0 + 0.5 * cols + 0.1 * rows


def test_flat_ground_is_uniformly_shaded():
    flat = np.full((32, 32), 12.0)
    shade = hillshade(flat, 1.0, 315.0, 35.0)
    assert shade.min() == pytest.approx(shade.max())


def test_a_slope_is_brighter_facing_the_sun():
    """A west-facing slope lit from the north-west must beat one lit from the south-east."""
    surface = slope_surface()  # rises eastward, so its face points west
    lit = hillshade(surface, 1.0, 315.0, 35.0).mean()
    unlit = hillshade(surface, 1.0, 135.0, 35.0).mean()
    assert lit > unlit


def cone(size: int = 101) -> np.ndarray:
    """A symmetric hill: row 0 = north, column 0 = west (the §1 array convention)."""
    rows, cols = np.mgrid[0:size, 0:size]
    return 50.0 - 0.3 * np.hypot(rows - size // 2, cols - size // 2)


def quadrants(shade: np.ndarray) -> dict[str, float]:
    n = shade.shape[0]
    lo, hi = slice(n // 5, 2 * n // 5), slice(3 * n // 5, 4 * n // 5)
    mid = slice(2 * n // 5, 3 * n // 5)
    return {
        "N": shade[lo, mid].mean(),
        "S": shade[hi, mid].mean(),
        "E": shade[mid, hi].mean(),
        "W": shade[mid, lo].mean(),
    }


@pytest.mark.parametrize("azimuth", [0.0, 90.0, 180.0, 270.0], ids=["N", "E", "S", "W"])
def test_azimuth_is_a_compass_bearing(azimuth):
    """The flank the sun comes from is the bright one — nothing mirrored, nothing rotated.

    This is the property the phase-0 spike's aspect formula got wrong (it lit the
    opposite flank), and the one a relief-inversion illusion turns on: a contact
    sheet lit from the wrong side reads ramparts as ditches.
    """
    lit = {0.0: "N", 90.0: "E", 180.0: "S", 270.0: "W"}[azimuth]
    brightness = quadrants(hillshade(cone(), 1.0, azimuth, 35.0))
    assert max(brightness, key=brightness.__getitem__) == lit


def test_multidirectional_keeps_the_upper_left_bias():
    """The default sun mix still lights from the north-west, where the eye expects it."""
    brightness = quadrants(multidirectional(cone(), 1.0))
    assert brightness["N"] > brightness["S"]
    assert brightness["W"] > brightness["E"]


def test_hillshade_stays_in_range():
    rng = np.random.default_rng(7)
    rough = rng.normal(20.0, 3.0, size=(48, 48))
    shade = multidirectional(rough, 2.0)
    assert shade.min() >= 0.0 and shade.max() <= 1.0


def test_downsample_block_means_and_never_upsamples():
    array = np.arange(64.0).reshape(8, 8)
    assert downsample_to(array, 4).shape == (4, 4)
    assert downsample_to(array, 4)[0, 0] == pytest.approx(array[0:2, 0:2].mean())
    assert downsample_to(array, 32).shape == (8, 8)  # smaller than the target: untouched


def test_png_roundtrips_greyscale(tmp_path):
    image = (np.arange(16 * 24, dtype=np.uint8) % 251).reshape(16, 24)
    path = write_png(tmp_path / "grey.png", image)
    width, height, colour_type, samples = decode_png(path)
    assert (width, height, colour_type) == (24, 16, 0)
    np.testing.assert_array_equal(samples[:, :, 0], image)


def test_png_roundtrips_rgb(tmp_path):
    rng = np.random.default_rng(3)
    image = rng.integers(0, 256, size=(9, 11, 3), dtype=np.uint8)
    path = write_png(tmp_path / "rgb.png", image)
    width, height, colour_type, samples = decode_png(path)
    assert (width, height, colour_type) == (11, 9, 2)
    np.testing.assert_array_equal(samples, image)


def test_png_rejects_the_wrong_dtype_or_shape(tmp_path):
    with pytest.raises(ValueError, match="uint8"):
        write_png(tmp_path / "x.png", np.zeros((4, 4)))
    with pytest.raises(ValueError, match="shape"):
        write_png(tmp_path / "x.png", np.zeros((4, 4, 2), dtype=np.uint8))


def test_thumbnail_is_greyscale_without_water(tmp_path):
    path = render_thumbnail(tmp_path / "t.png", slope_surface(256), 1.0, size=64)
    width, height, colour_type, _ = decode_png(path)
    assert (width, height) == (64, 64)
    assert colour_type == 0


def test_thumbnail_tints_water_and_stays_rgb(tmp_path):
    surface = slope_surface(256)
    dry = np.zeros(surface.shape, dtype=bool)
    wet = surface < 40.0
    dry_path = render_thumbnail(tmp_path / "dry.png", surface, 1.0, size=64, water_mask=dry)
    wet_path = render_thumbnail(tmp_path / "wet.png", surface, 1.0, size=64, water_mask=wet)

    _w, _h, colour_type, dry_px = decode_png(dry_path)
    assert colour_type == 2
    _w, _h, _c, wet_px = decode_png(wet_path)
    # The flooded side reads as water: blue gains on red. (The wash darkens all
    # three channels over bright ground — what says "water" is the hue shift,
    # not absolute brightness.)
    def blueness(px):
        return px[:, :8, 2].astype(float).mean() - px[:, :8, 0].astype(float).mean()

    assert blueness(wet_px) > blueness(dry_px) + 20.0
    # Relief survives the wash — a flat blue fill would hide exactly the
    # terrain the QA sweep is looking at.
    assert wet_px[:, :8, :].std() > 0
    # And the dry side is untouched by the mask.
    np.testing.assert_array_equal(wet_px[:, -4:, :], dry_px[:, -4:, :])
