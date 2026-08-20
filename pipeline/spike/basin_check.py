"""Phase-0 check for PLAN.md §4.5: do false basins exist at Broborg?

For each candidate water level h, cells with z <= h are labeled into connected
components. Components touching the DEM edge are treated as sea-connected
(the paleo-sea enters through the Långhundraleden valley, which crosses the
4x4 km extent); interior components are "false basins" a naive water plane
would flood even though they never connected to the sea.

Run:  python3 pipeline/spike/basin_check.py
"""

import numpy as np
import rasterio
from scipy import ndimage

from common import CACHE_DIR

# Slider range ~1000 BCE -> 1200 CE; local shoreline literature puts that at
# roughly 17 m down to ~4 m above present sea level (PLAN.md §2.4).
LEVELS = np.arange(4.0, 18.5, 1.0)


def main():
    with rasterio.open(CACHE_DIR / "broborg_dem_4km.tif") as src:
        z = src.read(1)

    print(f"{'level':>6} {'wet %':>6} {'false-basin cells':>18} {'largest (m2)':>13}")
    worst = 0
    for h in LEVELS:
        wet = z <= h
        labels, n = ndimage.label(wet)
        edge = np.unique(np.concatenate([
            labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]]))
        edge = edge[edge != 0]
        connected = np.isin(labels, edge)
        false_basin = wet & ~connected
        sizes = ndimage.sum(false_basin, labels, index=np.arange(1, n + 1))
        largest = int(sizes.max()) if n else 0
        worst = max(worst, largest)
        print(f"{h:6.1f} {100*wet.mean():6.2f} {int(false_basin.sum()):18d} {largest:13d}")

    print(f"\nlargest false basin across all levels: {worst} m2 "
          f"({'significant - needs connectivity mask' if worst > 10000 else 'negligible - plain plane OK'})")


if __name__ == "__main__":
    main()
