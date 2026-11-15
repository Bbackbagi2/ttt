"""Bake the steamed-up glass layers for the window tile.

Writes two 640x640 PNGs into assets/window/:
  fog.png    RGBA. Colour of the mist and, in alpha, how thick it is. Drops and drip
             trails have wiped the mist away, so alpha is near zero there.
  drops.png  RGB. Water drops as little lenses: R and G hold the surface normal
             (128 = flat), B holds the drop height (0 = no water).

The app crops a window-sized piece of these at a seeded offset, blurs the view behind
where the mist is thick and bends it through each drop. Any other condensation layer
(a photo, for example) can replace these files as long as it keeps the same channels.

Usage:
    python3 tools/condensation.py [--seed 7]
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'window'
N = 640


def noise(rng, sigma):
    a = gaussian_filter(rng.standard_normal((N, N)), sigma, mode='wrap')
    return (a - a.mean()) / (a.std() + 1e-9)


class Water:
    """Height (0-1 cap profile) and normal of the water lying on the glass."""

    def __init__(self):
        self.cap = np.zeros((N, N))
        self.nx = np.zeros((N, N))
        self.ny = np.zeros((N, N))
        self.wipe = np.zeros((N, N))     # where water has taken the mist away

    def free(self, x, y, r):
        x0, x1 = max(0, int(x - r - 1)), min(N, int(x + r + 2))
        y0, y1 = max(0, int(y - r - 1)), min(N, int(y + r + 2))
        return x1 > x0 and y1 > y0 and self.cap[y0:y1, x0:x1].max() == 0

    def drop(self, x, y, r, squash=1.0, strength=1.0):
        """A drop of radius r; squash < 1 makes it taller (gravity pulls larger drops down)."""
        ry = r / squash
        x0, x1 = max(0, int(x - r - 3)), min(N, int(x + r + 4))
        y0, y1 = max(0, int(y - ry - 3)), min(N, int(y + ry + 4))
        if x1 <= x0 or y1 <= y0:
            return
        yy, xx = np.mgrid[y0:y1, x0:x1]
        dx, dy = (xx - x) / r, (yy - y) / ry
        # A little more water in the lower half, as on a real pane.
        dy = np.where(dy > 0, dy * .92, dy * 1.06)
        d2 = dx * dx + dy * dy
        inside = d2 < 1
        cap = np.sqrt(np.clip(1 - d2, 0, 1)) * strength
        sel = inside & (cap > self.cap[y0:y1, x0:x1])
        self.cap[y0:y1, x0:x1][sel] = cap[sel]
        self.nx[y0:y1, x0:x1][sel] = dx[sel]
        self.ny[y0:y1, x0:x1][sel] = dy[sel]
        halo = d2 < 1.9
        self.wipe[y0:y1, x0:x1] = np.maximum(self.wipe[y0:y1, x0:x1], np.where(halo, 1 - np.clip(d2 - 1, 0, .9) / .9, 0))

    def trail(self, rng, x, y, length, width):
        """A drip that ran down, leaving a clear streak and a drop at its end."""
        sway = np.cumsum(rng.normal(0, .35, int(length)))
        sway = gaussian_filter(sway, 6)
        for i in range(int(length)):
            cx = x + sway[i]
            w = width * (.7 + .3 * i / length)
            yy = int(y + i)
            if yy >= N:
                break
            x0, x1 = max(0, int(cx - w - 2)), min(N, int(cx + w + 3))
            xs = np.arange(x0, x1)
            dx = (xs - cx) / w
            band = np.clip(1 - dx * dx, 0, 1)
            # Clear the mist and any small drops in the path.
            self.wipe[yy, x0:x1] = np.maximum(self.wipe[yy, x0:x1], np.clip(band * 1.6, 0, 1))
            thin = np.sqrt(band) * .35
            keep = thin > self.cap[yy, x0:x1]
            self.cap[yy, x0:x1] = np.where(band > 0, np.where(keep, thin, self.cap[yy, x0:x1]), self.cap[yy, x0:x1])
            self.nx[yy, x0:x1] = np.where(band > 0, np.where(keep, dx * .6, self.nx[yy, x0:x1]), self.nx[yy, x0:x1])
            self.ny[yy, x0:x1] = np.where(band > 0, np.where(keep, 0, self.ny[yy, x0:x1]), self.ny[yy, x0:x1])
        end = y + length
        if end < N:
            self.drop(x + sway[-1], end, width * 1.9, squash=.82)


def bake(seed):
    rng = np.random.default_rng(seed)
    water = Water()

    # Drip trails first, so the drops they leave sit on top of the streak.
    for _ in range(7):
        x = rng.uniform(30, N - 30)
        y = rng.uniform(-80, N * .45)
        water.trail(rng, x, y, rng.uniform(140, 420), rng.uniform(3.2, 5.2))

    # Large, medium, small and fine drops, placed without overlapping.
    for count, lo, hi in ((26, 9, 15), (130, 4.5, 9), (650, 2.2, 4.5), (4200, .9, 2.2)):
        placed = tries = 0
        while placed < count and tries < count * 12:
            tries += 1
            r = rng.uniform(lo, hi)
            x, y = rng.uniform(0, N), rng.uniform(0, N)
            # More condensation toward the bottom of the pane.
            if rng.random() > .55 + .45 * y / N:
                continue
            if not water.free(x, y, r + .8):
                continue
            water.drop(x, y, r, squash=1 - .012 * max(0, r - 4))
            placed += 1

    # Mist: uneven, thicker low down and near the frame, wiped where water gathered.
    yy, xx = np.mgrid[0:N, 0:N] / (N - 1)
    density = .58 + .12 * noise(rng, 60) + .06 * noise(rng, 16) + .14 * (yy - .5)
    edge = np.minimum.reduce([xx, 1 - xx, yy, 1 - yy])
    density += .1 * np.clip(1 - edge / .12, 0, 1)
    density *= 1 - .93 * np.clip(water.wipe, 0, 1)
    density = np.clip(density, 0, .9)
    shade = 236 + 6 * noise(rng, 30)
    fog = np.dstack([shade - 3, shade + 1, shade + 2, density * 255])
    fog = np.clip(fog, 0, 255).astype(np.uint8)

    drops = np.dstack([
        128 + 127 * np.clip(water.nx, -1, 1),
        128 + 127 * np.clip(water.ny, -1, 1),
        255 * np.clip(water.cap, 0, 1),
    ])
    drops = np.clip(np.round(drops), 0, 255).astype(np.uint8)

    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(fog, 'RGBA').save(OUT / 'fog.png', optimize=True)
    Image.fromarray(drops, 'RGB').save(OUT / 'drops.png', optimize=True)
    for name in ('fog.png', 'drops.png'):
        print(name, (OUT / name).stat().st_size // 1024, 'KB')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--seed', type=int, default=7)
    bake(ap.parse_args().seed)
