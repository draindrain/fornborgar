"""Rampart crest contract tests (docs/data-formats.md §8, PLAN.md §4.6.1). No network.

The fixture is the derivation's whole problem in miniature: a gaussian ring ridge of
known radius sitting on a hill whose **interior stands higher than the ridge**, plus
correlated noise, plus an "extent polygon" that is deliberately offset from the true
crest — inward on one parametrisation, outward on the other, as a registration
boundary usually is. If the derivation tracks the ridge under that, it is doing
ridge extraction rather than tracing the polygon it was handed.
"""

from __future__ import annotations

import json
from dataclasses import replace

import numpy as np
import pytest
from scipy import ndimage

from fornborg_pipeline.manifest import PALISADE_LAYER, add_rampart_asset, validate_manifest
from fornborg_pipeline.rampart import (
    DEFAULT_PARAMS,
    CrestParams,
    LocalGrid,
    RampartError,
    build_rampart,
    derive_crest,
    extent_ring,
    inward_normals,
    resample_closed,
    ring_length,
    validate_rampart,
)

# The synthetic fort: a 40 m-radius bank crest, 1.6 m high, on a 200x200 m grid.
CREST_RADIUS = 40.0
CREST_SIGMA = 3.5
CREST_AMPLITUDE = 1.6
HALF_EXTENT = 100.0
RESOLUTION = 1.0

BOUNDS_LOCAL = {"minX": -HALF_EXTENT, "minZ": -HALF_EXTENT, "maxX": HALF_EXTENT, "maxZ": HALF_EXTENT}


def synthetic_grid(gap_bearing: float | None = None, seed: int = 11) -> LocalGrid:
    """Hill + ring crest + correlated noise, sampled at pixel centers (contract §1).

    The interior plateau is ~1 m *above* the crest, which is what makes a plain
    per-transect elevation maximum useless and the detrended one necessary — and it
    is also what Broborg's own DEM looks like (interior ~49.5 m, crest ~48 m).
    """
    size = int(2 * HALF_EXTENT / RESOLUTION)
    axis = BOUNDS_LOCAL["minX"] + (np.arange(size) + 0.5) * RESOLUTION
    x, z = np.meshgrid(axis, axis)
    r = np.hypot(x, z)

    height = 20.0 + 9.0 * np.exp(-(r**2) / (2.0 * 35.0**2))  # the hill
    ridge = CREST_AMPLITUDE * np.exp(-((r - CREST_RADIUS) ** 2) / (2.0 * CREST_SIGMA**2))
    if gap_bearing is not None:
        bearing = np.degrees(np.arctan2(x, -z)) % 360.0
        delta = np.abs((bearing - gap_bearing + 180.0) % 360.0 - 180.0)
        # A ~5 m entrance gap at the crest radius, like Broborg's ("3-5 m br").
        ridge *= np.clip((delta - 3.5) / 3.0, 0.0, 1.0)
    height += ridge

    rng = np.random.default_rng(seed)
    noise = ndimage.gaussian_filter(rng.normal(size=(size, size)), sigma=1.5)
    height += 0.12 * noise / noise.std()

    # Quantize to decimeters exactly like a committed grid, so the test sees the
    # same +-5 cm staircase the real derivation runs on.
    height = np.round(height * 10.0) / 10.0
    return LocalGrid(heights=height, resolution=RESOLUTION, bounds_local=dict(BOUNDS_LOCAL))


def wobbly_ring(radius: float, vertices: int = 24, wobble: float = 2.0) -> np.ndarray:
    """A closed, deliberately irregular polygon — a plausible hand-drawn extent."""
    angle = np.linspace(0.0, 2.0 * np.pi, vertices, endpoint=False)
    rr = radius + wobble * np.sin(3.0 * angle) + 0.5 * wobble * np.cos(7.0 * angle + 1.0)
    return np.stack([rr * np.sin(angle), -rr * np.cos(angle)], axis=1)


def radial_error(points: np.ndarray) -> np.ndarray:
    return np.abs(np.hypot(points[:, 0], points[:, 1]) - CREST_RADIUS)


# --------------------------------------------------------------------------- #
# the derivation follows the ridge, not the polygon it was handed
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("extent_radius", "params"),
    [
        # Broborg's case: the registered extent lies outside the bank, defaults apply.
        (52.0, DEFAULT_PARAMS),
        # A site registered *inside* its own rampart: same derivation, corridor turned
        # around. The corridor is the only knob that should need to move.
        (36.0, replace(DEFAULT_PARAMS, corridor_outer_m=15.0, corridor_inner_m=10.0)),
    ],
    ids=["extent-outside", "extent-inside"],
)
def test_crest_tracks_the_true_ridge(extent_radius: float, params: CrestParams) -> None:
    grid = synthetic_grid()
    crest = derive_crest(grid, wobbly_ring(extent_radius), params)

    errors = radial_error(crest.points)
    assert np.median(errors) < 1.0, f"median radial error {np.median(errors):.2f} m"
    assert errors.max() < 3.0, f"worst radial error {errors.max():.2f} m"


def test_crest_length_matches_the_ring_circumference() -> None:
    crest = derive_crest(synthetic_grid(), wobbly_ring(52.0))
    expected = 2.0 * np.pi * CREST_RADIUS
    assert crest.length_m == pytest.approx(expected, rel=0.05)
    assert crest.length_m == pytest.approx(ring_length(crest.points), abs=1e-6)


def test_crest_spacing_bounds_and_closure() -> None:
    """Contract §8: >= 3 points, spacing <= 1 m, in bounds, last point != first."""
    crest = derive_crest(synthetic_grid(), wobbly_ring(52.0))
    points = crest.points

    assert points.shape[0] >= 3
    assert np.isfinite(points).all()
    assert not np.allclose(points[0], points[-1])
    assert grid_contains(points)

    segments = np.vstack([points[1:] - points[:-1], points[0] - points[-1]])
    spacing = np.hypot(segments[:, 0], segments[:, 1])
    assert spacing.max() <= 1.0
    # Densified to ~0.5 m, so the spacing should sit right at the target.
    assert spacing.max() == pytest.approx(DEFAULT_PARAMS.densify_m, abs=0.1)


def grid_contains(points: np.ndarray) -> bool:
    return bool(
        (points[:, 0] >= BOUNDS_LOCAL["minX"]).all()
        and (points[:, 0] <= BOUNDS_LOCAL["maxX"]).all()
        and (points[:, 1] >= BOUNDS_LOCAL["minZ"]).all()
        and (points[:, 1] <= BOUNDS_LOCAL["maxZ"]).all()
    )


def test_undetrended_maximum_would_fail_here() -> None:
    """The fixture really does defeat a plain per-transect elevation maximum.

    Guards the reason the module detrends at all: if someone "simplifies" the
    derivation back to `argmax(height)`, this is the test that explains why not.
    """
    grid = synthetic_grid()
    ring = wobbly_ring(52.0)
    boundary = resample_closed(ring, 1.0)
    normals = inward_normals(boundary)
    offsets = np.arange(-5.0, 25.01, 0.25)
    profiles = grid.sample(
        boundary[:, 0, None] + normals[:, 0, None] * offsets[None, :],
        boundary[:, 1, None] + normals[:, 1, None] * offsets[None, :],
    )
    naive = boundary + normals * offsets[np.argmax(profiles, axis=1)][:, None]
    assert np.median(radial_error(naive)) > 3.0


def test_entrance_gap_is_bridged_by_the_neighbourhood_median() -> None:
    """A gap in the bank (Broborg has two) must not pull the line off the ridge."""
    grid = synthetic_grid(gap_bearing=90.0)
    crest = derive_crest(grid, wobbly_ring(52.0))

    bearing = np.degrees(np.arctan2(crest.points[:, 0], -crest.points[:, 1])) % 360.0
    in_gap = np.abs((bearing - 90.0 + 180.0) % 360.0 - 180.0) < 3.5
    assert in_gap.any()
    assert radial_error(crest.points[in_gap]).max() < 3.0


def test_derivation_is_deterministic() -> None:
    grid = synthetic_grid()
    ring = wobbly_ring(52.0)
    first = derive_crest(grid, ring)
    second = derive_crest(synthetic_grid(), wobbly_ring(52.0))

    assert np.array_equal(first.points, second.points)
    assert json.dumps(build_rampart("testsite", first, generated="2026-08-20")) == json.dumps(
        build_rampart("testsite", second, generated="2026-08-20")
    )


def test_crest_stays_inside_the_grid_or_fails_loudly() -> None:
    """A corridor that would leave the grid is an error, never a clamped guess."""
    grid = synthetic_grid()
    with pytest.raises(RampartError, match="leaves the core grid"):
        derive_crest(grid, wobbly_ring(98.0))


# --------------------------------------------------------------------------- #
# ring / normal primitives
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("reverse", [False, True], ids=["ccw", "cw"])
def test_inward_normals_point_into_the_polygon(reverse: bool) -> None:
    ring = wobbly_ring(50.0)
    if reverse:
        ring = ring[::-1]
    normals = inward_normals(ring)
    # Every normal is a unit vector pointing back toward the ring's interior.
    assert np.allclose(np.hypot(normals[:, 0], normals[:, 1]), 1.0)
    assert (np.sum(-ring * normals, axis=1) > 0).all()


def test_resample_closed_is_uniform_and_open() -> None:
    ring = wobbly_ring(50.0)
    resampled = resample_closed(ring, 0.5)
    segments = np.vstack([resampled[1:] - resampled[:-1], resampled[0] - resampled[-1]])
    spacing = np.hypot(segments[:, 0], segments[:, 1])
    assert spacing.max() <= 0.51
    assert not np.allclose(resampled[0], resampled[-1])
    assert ring_length(resampled) == pytest.approx(ring_length(ring), rel=1e-3)


def test_extent_ring_reads_the_kmr_polygon() -> None:
    sites = {
        "sites": [
            {
                "id": "L0000:0001",
                "geometryLocal": {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 0]]]},
            }
        ]
    }
    ring = extent_ring(sites, "L0000:0001")
    # The repeated GeoJSON closing position is dropped (contract §8 wants last != first).
    assert ring.shape == (3, 2)


@pytest.mark.parametrize(
    ("sites", "message"),
    [
        ({"sites": []}, "no record"),
        (
            {"sites": [{"id": "L0000:0001", "geometryLocal": {"type": "Point", "coordinates": [0, 0]}}]},
            "needs a Polygon",
        ),
        ({"sites": [{"id": "L0000:0001"}]}, "needs a Polygon"),
    ],
)
def test_extent_ring_rejects_unusable_geometry(sites: dict, message: str) -> None:
    with pytest.raises(RampartError, match=message):
        extent_ring(sites, "L0000:0001")


# --------------------------------------------------------------------------- #
# rampart.json validation (contract §8)
# --------------------------------------------------------------------------- #


def good_document() -> dict:
    crest = derive_crest(synthetic_grid(), wobbly_ring(52.0))
    return build_rampart("testsite", crest, generated="2026-08-20")


def test_validator_accepts_a_generated_document() -> None:
    document = good_document()
    validate_rampart(document, BOUNDS_LOCAL)

    path = document["paths"][0]
    assert document["derivation"]["method"] == "dem-ridge"
    assert document["derivation"]["params"]["densifyM"] == DEFAULT_PARAMS.densify_m
    assert path["id"] == "inner" and path["closed"] is True
    # No heights in the file (contract §8): every position is exactly [x, z].
    assert all(len(p) == 2 for p in path["points"])


def mutate(**changes) -> dict:
    document = good_document()
    document["paths"][0].update(changes)
    return document


def test_validator_rejects_too_few_points() -> None:
    with pytest.raises(ValueError, match=r"points needs >= 3"):
        validate_rampart(mutate(closed=False, points=[[0.0, 0.0], [0.5, 0.0]], lengthM=0.5), BOUNDS_LOCAL)


def test_validator_rejects_nan() -> None:
    document = good_document()
    document["paths"][0]["points"][7][1] = float("nan")
    with pytest.raises(ValueError, match="non-finite"):
        validate_rampart(document, BOUNDS_LOCAL)


def test_validator_rejects_out_of_bounds_points() -> None:
    document = good_document()
    document["paths"][0]["points"][3] = [HALF_EXTENT + 5.0, 0.0]
    with pytest.raises(ValueError, match="outside the core grid"):
        validate_rampart(document, BOUNDS_LOCAL)


def test_validator_rejects_a_repeated_closing_point() -> None:
    document = good_document()
    document["paths"][0]["points"].append(list(document["paths"][0]["points"][0]))
    with pytest.raises(ValueError, match="must not repeat the first"):
        validate_rampart(document, BOUNDS_LOCAL)


def test_validator_rejects_coarse_spacing() -> None:
    document = good_document()
    document["paths"][0]["points"] = document["paths"][0]["points"][::4]  # ~2 m apart
    with pytest.raises(ValueError, match="spacing"):
        validate_rampart(document, BOUNDS_LOCAL)


def test_validator_rejects_a_wrong_length() -> None:
    with pytest.raises(ValueError, match="lengthM"):
        validate_rampart(mutate(lengthM=999.0), BOUNDS_LOCAL)


@pytest.mark.parametrize("method", ["hand-waving", None])
def test_validator_rejects_an_unknown_method(method) -> None:
    document = good_document()
    document["derivation"]["method"] = method
    with pytest.raises(ValueError, match="derivation.method"):
        validate_rampart(document, BOUNDS_LOCAL)


# --------------------------------------------------------------------------- #
# manifest wiring (contract §8 + PLAN.md §6.1 honesty rule)
# --------------------------------------------------------------------------- #


def minimal_manifest(fake_site) -> dict:
    """The smallest manifest `validate_manifest` accepts, built from the fixture site."""
    from fornborg_pipeline.manifest import local_bounds

    grids = {}
    for name, spec in (("core", fake_site.core), ("context", fake_site.context)):
        bounds = fake_site.bounds3006(spec.half_extent)
        grids[name] = {
            "path": spec.path,
            "resolution": spec.resolution,
            "width": spec.size,
            "height": spec.size,
            "bounds3006": {
                "minE": bounds[0],
                "minN": bounds[1],
                "maxE": bounds[2],
                "maxN": bounds[3],
            },
            "boundsLocal": local_bounds(bounds, fake_site.center_e, fake_site.center_n),
            "encoding": {"dtype": "int16", "scale": 0.1, "unit": "m"},
            "minElevation": 20.0,
            "maxElevation": 50.0,
        }
    return {
        "schemaVersion": 1,
        "site": {"id": fake_site.id, "name": fake_site.name},
        "origin": {"e": fake_site.center_e, "n": fake_site.center_n},
        "grids": grids,
        "assets": {"sites": "sites.json"},
        "layers": [{"id": "terrain", "name": "Terrain", "provenance": "measured"}],
        "attribution": [],
        "provenance": {"processing": []},
    }


def test_add_rampart_asset_wires_the_conjecture_layer(fake_site) -> None:
    manifest = minimal_manifest(fake_site)
    add_rampart_asset(manifest, "rampart.json", processing=("crest step",))
    validate_manifest(manifest)

    assert manifest["assets"]["rampart"] == "rampart.json"
    assert manifest["layers"][-1] == PALISADE_LAYER
    assert manifest["schemaVersion"] == 1  # additive change, no version bump
    assert "crest step" in manifest["provenance"]["processing"]

    # Idempotent: a second run must not duplicate the layer or the step.
    add_rampart_asset(manifest, "rampart.json", processing=("crest step",))
    assert [layer["id"] for layer in manifest["layers"]].count("palisade") == 1
    assert manifest["provenance"]["processing"].count("crest step") == 1


@pytest.mark.parametrize("provenance", ["measured", "model", "conjectural"])
def test_manifest_validator_rejects_a_mislabelled_palisade(fake_site, provenance: str) -> None:
    """PLAN §6.1: shipping a palisade as anything but conjecture is a hard failure."""
    manifest = minimal_manifest(fake_site)
    add_rampart_asset(manifest, "rampart.json")
    manifest["layers"][-1]["provenance"] = provenance
    with pytest.raises(ValueError, match="palisade"):
        validate_manifest(manifest)


def test_manifest_validator_rejects_a_rampart_without_its_layer(fake_site) -> None:
    manifest = minimal_manifest(fake_site)
    manifest["assets"]["rampart"] = "rampart.json"
    with pytest.raises(ValueError, match="no 'palisade' layer"):
        validate_manifest(manifest)


def test_manifest_without_a_rampart_still_validates(fake_site) -> None:
    """A plain v1 manifest (the testsite before v1.1) keeps validating unchanged."""
    validate_manifest(minimal_manifest(fake_site))
