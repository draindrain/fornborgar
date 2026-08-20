"""Phase-0 gate: multidirectional hillshade of the 1 m DEM around Broborg.

Renders to pipeline/spike/out/:
- broborg_hillshade_4km.png      — full 4x4 km extent, multidirectional (shown at 4 m)
- broborg_hillshade_800m.png     — 800 m close-up on the fort, multidirectional
- broborg_hillshade_800m_nw.png  — same close-up, single low NW sun (az 315, alt 30)
- broborg_hillshade_300m.png     — 300 m two-panel close-up (multidir + NW sun)
- broborg_slope_800m.png         — slope map close-up (earthwork edges)
- broborg_rampart_profile.png    — two elevation transects across the ramparts

The gate question (PLAN.md §3 phase 0): are the 1-2 m high, 8-15 m wide
ramparts clearly legible at 1 m resolution?

Run:  python3 pipeline/spike/hillshade.py
"""

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import rasterio

from common import BROBORG_E, BROBORG_N, CACHE_DIR, OUT_DIR

DEM = CACHE_DIR / "broborg_dem_4km.tif"


def hillshade(z, azimuth_deg, altitude_deg, dx=1.0):
    gy, gx = np.gradient(z, dx)
    slope = np.pi / 2 - np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az = np.radians(360.0 - azimuth_deg + 90.0)
    alt = np.radians(altitude_deg)
    shaded = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(az - aspect)
    return np.clip(shaded, 0, 1)


def multidirectional(z, altitude_deg=45.0, azimuths=(225, 270, 315, 360)):
    # GDAL-style: weighted combination of shades from several azimuths.
    acc = np.zeros(z.shape, dtype=np.float64)
    for a in azimuths:
        acc += hillshade(z, a, altitude_deg)
    return acc / len(azimuths)


def save_png(img, path, extent, title, cmap="gray", overlay=None, dpi=150):
    h, w = img.shape
    fig, ax = plt.subplots(figsize=(w / dpi * 1.1, h / dpi * 1.1), dpi=dpi)
    ax.imshow(img, cmap=cmap, extent=extent, interpolation="nearest")
    if overlay is not None:
        for ring in overlay:
            xs, ys = zip(*ring)
            ax.plot(xs, ys, color="#ff3333", lw=1.0, alpha=0.85)
    ax.set_title(title, fontsize=9)
    ax.set_xlabel("E (SWEREF 99 TM)", fontsize=7)
    ax.set_ylabel("N", fontsize=7)
    ax.tick_params(labelsize=6)
    ax.ticklabel_format(style="plain", useOffset=False)
    fig.tight_layout()
    fig.savefig(path, dpi=dpi)
    plt.close(fig)
    print("wrote", path)


def rings_from_geojson(path):
    gj = json.loads(path.read_text())
    rings = []
    for f in gj["features"]:
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            rings.extend(poly)
    return rings


def main():
    OUT_DIR.mkdir(exist_ok=True)
    with rasterio.open(DEM) as src:
        z = src.read(1).astype(np.float64)
        b = src.bounds
    extent_full = (b.left, b.right, b.bottom, b.top)

    rampart_overlay = None
    gj = CACHE_DIR / "broborg_extent.geojson"
    if gj.exists():
        rampart_overlay = rings_from_geojson(gj)

    md = multidirectional(z)
    save_png(md[::4, ::4], OUT_DIR / "broborg_hillshade_4km.png",
             extent_full, "Broborg 4x4 km — multidirectional hillshade, 1 m DEM (shown at 4 m)",
             overlay=rampart_overlay)

    # 800 m close-up centered on the fort.
    half = 400
    r0 = int(b.top - (BROBORG_N + half))
    c0 = int((BROBORG_E - half) - b.left)
    zc = z[r0 : r0 + 2 * half, c0 : c0 + 2 * half]
    extent_c = (BROBORG_E - half, BROBORG_E + half, BROBORG_N - half, BROBORG_N + half)

    save_png(multidirectional(zc), OUT_DIR / "broborg_hillshade_800m.png",
             extent_c, "Broborg 800 m — multidirectional hillshade (red: RAÄ extent polygon)",
             overlay=rampart_overlay)
    save_png(hillshade(zc, 315, 30), OUT_DIR / "broborg_hillshade_800m_nw.png",
             extent_c, "Broborg 800 m — single NW sun, az 315°, alt 30°",
             overlay=rampart_overlay)

    # 300 m two-panel close-up — the actual gate exhibit.
    half3 = 150
    r3 = int(b.top - (BROBORG_N + half3))
    c3 = int((BROBORG_E - half3) - b.left)
    z3 = z[r3 : r3 + 2 * half3, c3 : c3 + 2 * half3]
    ext3 = (BROBORG_E - half3, BROBORG_E + half3, BROBORG_N - half3, BROBORG_N + half3)
    fig, axes = plt.subplots(1, 2, figsize=(14, 7.4), dpi=150)
    for ax, img, title in [
        (axes[0], multidirectional(z3, altitude_deg=35), "multidirectional, alt 35°"),
        (axes[1], hillshade(z3, 315, 25), "single NW sun, az 315°, alt 25°"),
    ]:
        ax.imshow(img, cmap="gray", extent=ext3, interpolation="bilinear")
        if rampart_overlay:
            for ring in rampart_overlay:
                xs, ys = zip(*ring)
                ax.plot(xs, ys, color="#ff3333", lw=1.2, alpha=0.9)
        ax.set_title(f"Broborg 300 m — {title}", fontsize=10)
        ax.set_xlim(ext3[0], ext3[1]); ax.set_ylim(ext3[2], ext3[3])
        ax.tick_params(labelsize=7); ax.ticklabel_format(style="plain", useOffset=False)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "broborg_hillshade_300m.png", dpi=150)
    plt.close(fig)
    print("wrote", OUT_DIR / "broborg_hillshade_300m.png")
    gy, gx = np.gradient(zc)
    slope_deg = np.degrees(np.arctan(np.hypot(gx, gy)))
    save_png(np.clip(slope_deg, 0, 45), OUT_DIR / "broborg_slope_800m.png",
             extent_c, "Broborg 800 m — slope (0-45°)", cmap="magma",
             overlay=rampart_overlay)

    # Elevation transects across the fort (W-E and S-N through the site center).
    fig, axes = plt.subplots(2, 1, figsize=(10, 6))
    n_row = int(b.top - BROBORG_N)
    e_col = int(BROBORG_E - b.left)
    xs = np.arange(BROBORG_E - 150, BROBORG_E + 150)
    axes[0].plot(xs, z[n_row, e_col - 150 : e_col + 150], lw=1)
    axes[0].set_title("W–E transect through site center (N = %d)" % BROBORG_N, fontsize=9)
    axes[0].set_xlabel("E"); axes[0].set_ylabel("m RH2000")
    ys = np.arange(BROBORG_N - 150, BROBORG_N + 150)
    axes[1].plot(ys, z[n_row + 150 : n_row - 150 : -1, e_col], lw=1)
    axes[1].set_title("S–N transect through site center (E = %d)" % BROBORG_E, fontsize=9)
    axes[1].set_xlabel("N"); axes[1].set_ylabel("m RH2000")
    for ax in axes:
        ax.grid(True, lw=0.3)
        ax.ticklabel_format(style="plain", useOffset=False)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "broborg_rampart_profile.png", dpi=150)
    print("wrote", OUT_DIR / "broborg_rampart_profile.png")


if __name__ == "__main__":
    main()
