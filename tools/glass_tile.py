"""Bake the window's glass tile from a photographed wall tile.

The window is one large glass tile. Its relief comes from a real tile photo in the small-tile
library, enlarged to the window size in the app:
  tile.png       RGB. R, G: how the tile's surface bends the view behind (128 = none);
                 B: light and shade of the surface (128 = none). Only the fine relief is kept.
  tile-body.png  L. The tile's own milky brightness.

Usage:
    python3 tools/glass_tile.py --project "<path to Proj-TheThinker'sToilet>" [--tile tile-112.png]
    python3 tools/glass_tile.py --photo <glass block photo> --box x0,y0,x1,y1   # one cell of a photo
Options: --out <folder> --name <file stem> (default assets/window/tile)
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'window'
N = 640
LUMA = np.array([.2126, .7152, .0722])


def bake(photo, box=(6, 6, 154, 154), out=OUT, name='tile'):
    with Image.open(photo) as im:
        im = im.convert('RGB').crop(box).resize((N, N), Image.Resampling.LANCZOS)
    L = np.asarray(im, np.float32) @ LUMA
    relief = L - gaussian_filter(L, 60)
    shade = gaussian_filter(relief, .7)
    gy, gx = np.gradient(gaussian_filter(relief, 3))
    s = np.percentile(np.abs(np.r_[gx.ravel(), gy.ravel()]), 99.3)
    bend = np.clip(np.dstack([gx, gy]) / s, -1, 1)
    shade = np.clip(shade / np.percentile(np.abs(shade), 99.3), -1, 1)
    rgb = np.dstack([128 + 127 * bend[..., 0], 128 + 127 * bend[..., 1], 128 + 127 * shade])
    body = gaussian_filter(L, 2.5)
    lo, hi = np.percentile(body, [1, 99])
    body = np.clip((body - lo) / max(1, hi - lo), 0, 1)
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(np.round(rgb), 0, 255).astype(np.uint8), 'RGB').save(out / f'{name}.png', optimize=True)
    Image.fromarray(np.round(body * 255).astype(np.uint8), 'L').save(out / f'{name}-body.png', optimize=True)
    for f in (f'{name}.png', f'{name}-body.png'):
        print(f, (out / f).stat().st_size // 1024, 'KB')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--project')
    ap.add_argument('--tile', default='tile-112.png')
    ap.add_argument('--photo')
    ap.add_argument('--box')
    ap.add_argument('--out', default=str(OUT))
    ap.add_argument('--name', default='tile')
    a = ap.parse_args()
    if a.photo:
        bake(Path(a.photo), tuple(int(v) for v in a.box.split(',')), Path(a.out), a.name)
    else:
        bake(Path(a.project) / 'libraries' / 'small-tile-library' / a.tile, out=Path(a.out), name=a.name)
