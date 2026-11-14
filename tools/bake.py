"""Bake TTT library assets into lightweight files the web app can composite.

Heavy steps that need numpy/scipy (photo glaze layers, brush texture) run here on
the Mac. The phone only mixes the baked layers with glaze colours and a title.

Usage:
    python3 tools/bake.py --project "<path to Proj-TheThinker'sToilet>" [--generated 24]
"""
import argparse
import json
import shutil
import unicodedata
from pathlib import Path

import numpy as np
from PIL import Image, ImageColor, ImageDraw, ImageOps
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates

APP = Path(__file__).resolve().parent.parent
OUT = APP / 'assets'
W, H, PITCH = 1080, 1440, 90
SIDE = 5 * PITCH
LENGTH = 7
RESAMPLE = Image.Resampling.LANCZOS
LUMA = np.array([.2126, .7152, .0722])

# Shared colour rules from the v6-v14 studies.
POOL = ('#bfced7', '#b0c3d0', '#a1b9c9', '#94adc0', '#87a3b8', '#7796b0', '#66839f', '#a1bdc2', '#c9d5da')
WEIGHT = (.15, .14, .17, .16, .14, .105, .055, .05, .03)
ACCENTS = ('#ac8173', '#c3a175')
GROUT = '#dadede'
GLAZES = {  # picture clay, ink, accent
    'cream': ('#e9e9db', '#204576', '#b66636'),
    'sea': ('#c4e2e1', '#204670', '#ba623a'),
    'sand': ('#eadac2', '#8b3a2d', '#d88249'),
    'navy': ('#1d4383', '#fff0d6', '#eab85d'),
}
TITLE = {  # title clay, title ink
    'cream': ('#e5e8df', '#0a2848'),
    'sea': ('#e0ebe6', '#0b2a45'),
    'sand': ('#eaddc9', '#5b211a'),
    'navy': ('#e4e8e2', '#0c2b4a'),
}

# v14 covers: slug, title, language, picture origin, palette, title origin hint, title size hint.
V14 = (
    ('01-ripple', '물이 잠잠해지는 시간', 'ko', (2, 3), 'cream', (8, 3), (1, 7), 'mixed'),
    ('02-window', 'Light through the kitchen window', 'en', (5, 7), 'sea', (3, 5), (7, 1), 'truchet'),
    ('03-rain', '빗소리가 들리는 저녁', 'ko', (1, 6), 'cream', (2, 4), (6, 1), 'brush'),
    ('04-low-tide', 'Low Tide', 'en', (5, 3), 'cream', (5, 9), (4, 1), 'mixed'),
    ('05-gap', '틈', 'ko', (6, 6), 'cream', (4, 6), (1, 4), 'geometric'),
    ('06-daybreak', 'The hour before the city wakes', 'en', (3, 6), 'cream', (2, 4), (7, 1), 'truchet'),
    ('07-sip', '따뜻한 차를 한 모금', 'ko', (2, 7), 'cream', (8, 5), (1, 7), 'geometric'),
    ('08-drift', 'Drift', 'en', (5, 4), 'sea', (4, 10), (4, 1), 'truchet'),
    ('09-pebble', '조약돌', 'ko', (4, 7), 'cream', (3, 5), (4, 1), 'geometric'),
    ('10-afterglow', 'The last of the afternoon light', 'en', (1, 4), 'sand', (2, 10), (7, 1), 'geometric'),
    ('11-breath', '숨을 고르는 사이', 'ko', (6, 6), 'cream', (4, 5), (1, 6), 'mixed'),
    ('12-blue-hour', 'Blue Hour', 'en', (4, 3), 'navy', (4, 9), (5, 1), 'truchet'),
)
NAMES = {
    '01-ripple': '물결 고리', '02-window': '창가 트뤼셰', '03-rain': '빗줄기', '04-low-tide': '썰물',
    '05-gap': '겹마름모', '06-daybreak': '사분원 무늬', '07-sip': '마주 본 삼각', '08-drift': '엇갈린 곡선',
    '09-pebble': '두 겹 고리', '10-afterglow': '노을 별', '11-breath': '숨 고르기', '12-blue-hour': '달빛 원호',
}


def rgb(value):
    return np.array(ImageColor.getrgb(value), dtype=np.float32)


def light(x, y, w, h):
    yy, xx = np.ogrid[y:y + h, x:x + w]
    yy, xx = yy / (H - 1), xx / (W - 1)
    return 5.2 * (.76 - xx) * (.73 - yy) + 2.1 * (.58 - yy) + 1.0 * (.5 - xx)


def v14_rects(picture, title_hint, size_hint, language):
    (x, y), (tx, ty), (tw, th) = picture, title_hint, size_hint
    if tw > th:
        tx = min(11 - LENGTH, max(1, round(tx + (tw - LENGTH) / 2)))
        title = tx, ty, LENGTH, 1
    else:
        ty = min(13 - LENGTH, max(3, round(ty + (th - LENGTH) / 2)))
        title = tx, ty, 1, LENGTH
    return (x, y), title


# ---------------------------------------------------------------- photo tiles

def photo_layers(photo):
    a = np.asarray(photo, dtype=np.float32)
    alpha = a[..., 3] / 255
    luminance = a[..., :3] @ LUMA
    median = np.median(luminance[alpha > .94])
    coverage = gaussian_filter(alpha, 1.3)
    spread = gaussian_filter(luminance * alpha, 1.3) / np.maximum(coverage, .01)
    luma = np.where(alpha > .12, luminance, np.where(coverage > .06, spread, median))
    return np.clip(luma - median, -78, 96), alpha


def rescale(layer, size):
    return np.asarray(Image.fromarray(layer.astype('float32')).resize(size, RESAMPLE))


def slice_texture(source, size):
    im = Image.fromarray(source.astype(np.float32))
    w, h = size
    result = Image.new('F', size)
    src = (0, 26, 134, 160)
    xs, ys = (0, 14, w - 14, w), (0, 14, h - 14, h)
    for j in range(3):
        for i in range(3):
            box = (src[i], src[j], src[i + 1], src[j + 1])
            dest = (xs[i + 1] - xs[i], ys[j + 1] - ys[j])
            result.paste(im.crop(box).resize(dest, Image.Resampling.BICUBIC), (xs[i], ys[j]))
    return np.asarray(result)


def tile_atlas(library):
    files = sorted(library.glob('tile-*.png'))
    cols = 12
    rows = -(-len(files) // cols)
    atlas = np.zeros((rows * PITCH, cols * PITCH, 3), np.uint8)
    medians = []
    for n, file in enumerate(files):
        with Image.open(file) as image:
            photo = image.convert('RGBA')
        reflected, alpha = photo_layers(photo)
        variation = rescale(reflected, (PITCH, PITCH))
        mask = np.clip(rescale(alpha, (PITCH, PITCH)), 0, 1)
        reflect = np.clip(variation, -57, 69) * .63
        depth = gaussian_filter(np.roll(mask, (2, 2), axis=(0, 1)), 1.25)
        cell = np.dstack((np.clip(reflect + 128, 0, 255), mask * 255, depth * 255))
        y, x = n // cols * PITCH, n % cols * PITCH
        atlas[y:y + PITCH, x:x + PITCH] = np.uint8(np.round(cell))
        medians.append(file.name)
    Image.fromarray(atlas).save(OUT / 'tiles.png', optimize=True)
    return {'count': len(files), 'columns': cols, 'size': PITCH}


def glazed_picture(photo, clay, paint):
    reflected, alpha = photo
    size = paint.size
    variation = slice_texture(reflected, size)
    mask = slice_texture(alpha, size)
    yy, xx = np.ogrid[:size[1], :size[0]]
    inset = np.minimum(np.minimum(xx, size[0] - 1 - xx), np.minimum(yy, size[1] - 1 - yy))
    rim = np.exp(-np.maximum(inset - 9, 0) / 11)
    mid = np.clip(variation, -39, 46)
    reflect = (mid + (variation - mid) * rim * .85) * .5
    surface = np.broadcast_to(rgb(clay), (size[1], size[0], 3)).copy()
    pigment = np.asarray(paint, dtype=np.float32)
    opacity = pigment[..., 3:4] / 255
    surface = surface * (1 - opacity) + pigment[..., :3] * opacity
    shadow = np.minimum(0, reflect)[..., None]
    highlight = np.maximum(0, reflect)[..., None] / 255
    surface = np.clip(surface + shadow, 0, 255)
    surface = surface + (252 - surface) * highlight * .9 + .36 * np.maximum(0, reflect)[..., None]
    a = np.clip(mask, 0, 1)[..., None]
    depth = gaussian_filter(np.roll(a[..., 0], (3, 3), axis=(0, 1)), 1.25)
    mortar = rgb(GROUT) - (10 * depth)[..., None]
    return np.clip(surface * a + mortar * (1 - a), 0, 255)


# ---------------------------------------------------------------- brush marks

def ink_grain(brushes, n=512):
    with Image.open(brushes / 'daub.png') as original:
        image = original.convert('RGBA')
    l, t, r, b = image.getchannel('A').point(lambda v: 255 if v > 180 else 0).getbbox()
    x, y = (l + r) // 2, (t + b) // 2
    radius = min(r - l, b - t) // 4
    core = np.asarray(image.crop((x - radius, y - radius, x + radius, y + radius)), dtype=float)
    values = core[..., :3] @ np.array([.21, .72, .07])
    mirrored = np.block([[values, np.fliplr(values)], [np.flipud(values), values[::-1, ::-1]]])
    signal = np.asarray(Image.fromarray(np.float32(mirrored)).resize((n, n), Image.Resampling.BICUBIC))
    return (signal - np.median(signal)) * .48 + (signal - gaussian_filter(signal, 5)) * .64


class Painter:
    def __init__(self, brushes):
        self.brushes = brushes
        self.grain = ink_grain(brushes)

    def asset(self, name):
        folder = self.brushes / 'geometric-symbols' if name.startswith('geo-') else self.brushes
        with Image.open(folder / (name + '.png')) as image:
            return image.convert('RGBA')

    @staticmethod
    def pigment(image, tint):
        color = rgb(tint)
        rgba = np.array(image)
        luma = rgba[..., :3] @ np.array([.21, .72, .07])
        painted = rgba[..., 3] > 140
        delta = np.clip((luma - np.median(luma[painted])) * .73, -25, 30)
        if color.mean() > 160:
            delta *= -.65
        rgba[..., :3] = np.uint8(np.clip(color + delta[..., None], 0, 255))
        return Image.fromarray(rgba)

    @staticmethod
    def noise(shape, rng, columns, rows):
        coarse = Image.fromarray(rng.random((rows, columns)).astype(np.float32))
        return 2 * np.asarray(coarse.resize((shape[1], shape[0]), Image.Resampling.BICUBIC)) - 1

    def brushed(self, image, tint, seed, joined=False):
        rgba = np.asarray(image, dtype=float)
        h, w = rgba.shape[:2]
        rng = np.random.default_rng(seed)
        nz = self.noise
        broad, directional = nz((h, w), rng, 6, 6), nz((h, w), rng, 13, 5)
        edge_grain, fine = nz((h, w), rng, 99, 88), nz((h, w), rng, 160, 77)
        field = np.asarray(Image.fromarray(self.grain.astype(np.float32)).resize((w, h), RESAMPLE))
        yy, xx = np.indices((h, w), dtype=float)
        rim = np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy, h - 1 - yy))
        fade = np.minimum(rim / 14, 1) if joined else 1.
        extent = min(h, w)
        drift_y = extent * (.021 * broad + .010 * directional + .003 * edge_grain)
        drift_x = extent * (.020 * directional + .014 * broad + .002 * fine)
        original = rgba[..., 3] / 255
        inside = original > .5
        signed = distance_transform_edt(inside) - distance_transform_edt(~inside)
        edge = map_coordinates(signed, (yy + drift_y * fade, xx + drift_x * fade), order=1, mode='nearest')
        pressure = extent * (.007 * directional + .0045 * edge_grain + .002 * fine)
        pickup = extent * (.0045 if joined else .0015)
        opacity = np.clip((edge + (pressure + pickup) * fade + 1) / 3.0, 0, 1)
        rim_dry = np.clip(1 - np.maximum(edge, 0) / (extent * .016), 0, 1)
        bristles = nz((h, w), rng, 18, 55)
        dry = np.clip((bristles * .52 + fine * .19 + field / 49 - .08) * .34, 0, .34)
        opacity *= 1 - dry * (.40 + .60 * rim_dry) * fade
        if joined:
            opacity = opacity * fade + original * (1 - fade)
        color = rgb(tint)
        shade = field * .72 + 18 * directional + 9 * broad + 4 * edge_grain + 5 * bristles
        if color.mean() > 160:
            shade *= -.68
        out = np.clip(color + shade[..., None], 0, 255)
        return Image.fromarray(np.uint8(np.dstack((out, opacity * 255))))

    def mark(self, tile, name, cx, cy, span, rotation, tint, seed):
        mark = self.asset(name)
        mark = mark.crop(mark.getchannel('A').point(lambda a: 255 if a > 14 else 0).getbbox())
        if name.startswith('geo-'):
            mark = ImageOps.expand(mark, border=round(max(mark.size) * .055))
            mark = self.brushed(mark, tint, seed)
        else:
            mark = self.pigment(mark, tint)
        k = span * SIDE / max(mark.size)
        mark = mark.resize(tuple(round(d * k) for d in mark.size), RESAMPLE)
        if rotation:
            mark = mark.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=True)
        tile.alpha_composite(mark, (round(cx * SIDE - mark.width / 2), round(cy * SIDE - mark.height / 2)))

    def truchet(self, tile, count, top, design, tint, seed):
        cell = 139 if count == 2 else 94
        width = cell * count
        turns = (None, Image.Transpose.ROTATE_90, Image.Transpose.ROTATE_180, Image.Transpose.ROTATE_270)
        board = Image.new('RGBA', (width, width))
        for j, (name, turn) in enumerate(design):
            square = self.asset('geo-truchet-' + name)
            if turn:
                square = square.transpose(turns[turn])
            board.alpha_composite(square.resize((cell, cell), RESAMPLE), (j % count * cell, j // count * cell))
        tile.alpha_composite(self.brushed(board, tint, seed, joined=True), ((SIDE - width) // 2, top))


BRUSH_MAIN = ('long-arch', 'long-loop', 'long-rise', 'long-s-wave', 'long-taper', 'long-trough', 'long-ripple',
              'long-droop', 'sweep', 'split-brush', 'rain-strokes', 'spiral', 'overlapping-loops', 'open-knot',
              'stacked-crescents', 'fan-strokes', 'curved-fork', 'wave', 'arch', 'crescent')
GEO_MAIN = ('geo-ring-dot', 'geo-double-ring', 'geo-diamond-in-diamond', 'geo-four-point-star', 'geo-half-disc',
            'geo-facing-triangles', 'geo-split-ring', 'geo-square-spiral', 'geo-stepped-pair', 'geo-four-petals',
            'geo-checkerboard', 'geo-diagonal-bars')
SMALL = ('daub', 'dots', 'stipple-cluster', 'broken-pair', 'slash-and-accent', 'geo-four-petals', 'geo-ring-dot')


def generated(painter, photos, count, seed=2026):
    """Random compositions that follow the v14 rules: one calm motif, an optional partner, a warm point."""
    rng = np.random.default_rng(seed)
    kinds = ['brush', 'geometric', 'mixed', 'truchet']
    items = []
    attempt = 0
    while len(items) < count:
        attempt += 1
        kind = kinds[len(items) % 4]
        palette = rng.choice(['cream', 'cream', 'cream', 'sea', 'sand', 'navy'])
        clay, ink, accent = GLAZES[palette]
        blues = (ink, '#3b5d80', '#55778f', '#66849f') if palette != 'navy' else (ink, '#e4b985', '#cfe0e6')
        art = Image.new('RGBA', (SIDE, SIDE))
        s = int(rng.integers(1 << 30))
        if kind == 'truchet':
            n = int(rng.choice([2, 3]))
            design = [(str(rng.choice(['arc', 'arc', 'arc', 'crossing'])), int(rng.integers(4))) for _ in range(n * n)]
            top = int(rng.choice([66, 100, 137])) if n == 2 else int(rng.choice([66, 90]))
            painter.truchet(art, n, top, design, ink, s)
            if rng.random() < .6:
                y = (top + (139 if n == 2 else 94) * n) / SIDE + .08
                if y < .86:
                    painter.mark(art, 'daub', .5 + rng.uniform(-.2, .2), y, .06, 0, accent, s + 1)
        else:
            main = rng.choice(BRUSH_MAIN if kind == 'brush' else GEO_MAIN)
            painter.mark(art, str(main), .5 + rng.uniform(-.04, .04), .5 + rng.uniform(-.06, .04),
                         rng.uniform(.48, .64), int(rng.integers(-8, 9)), str(rng.choice(blues[:2])), s)
            if kind == 'mixed':
                second = rng.choice(BRUSH_MAIN[:10])
                painter.mark(art, str(second), .5 + rng.uniform(-.05, .05), rng.uniform(.66, .76),
                             rng.uniform(.5, .66), int(rng.integers(-6, 7)), str(rng.choice(blues)), s + 2)
            if rng.random() < .7:
                small = rng.choice(SMALL)
                cx, cy = rng.choice([.27, .72]), rng.choice([.26, .74])
                span = .06 if small == 'daub' else .18
                painter.mark(art, str(small), cx, cy, span, 0, accent, s + 3)
        box = art.getbbox()
        if not box or min(box[0], box[1], SIDE - box[2], SIDE - box[3]) <= 30:
            continue
        number = len(items) + 1
        photo = photos[int(rng.integers(len(photos) * .46, len(photos) * .85))]
        picture = glazed_picture(photo, clay, art)
        name = f'gen-{number:02d}'
        Image.fromarray(np.uint8(np.round(picture))).save(OUT / 'pictures' / f'{name}.png', optimize=True)
        items.append({'id': name, 'name': f'조합 {number:02d}', 'kind': kind, 'palette': str(palette),
                      'picture': f'pictures/{name}.png', 'source': 'generated'})
    return items


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True, type=Path)
    parser.add_argument('--generated', type=int, default=24)
    parser.add_argument('--font', type=Path, default=None)
    args = parser.parse_args()
    project = args.project.expanduser()
    libraries = project / 'libraries'
    OUT.mkdir(exist_ok=True)
    (OUT / 'pictures').mkdir(exist_ok=True)
    (OUT / 'glaze').mkdir(exist_ok=True)

    tiles = tile_atlas(libraries / 'small-tile-library')

    # Title plaque frame: one large tile whose bevel follows the small photographed tile.
    edge = Image.new('L', (160, 160))
    ImageDraw.Draw(edge).rounded_rectangle((5, 5, 154, 154), radius=4, fill=255)
    (OUT / 'plaque').mkdir(exist_ok=True)
    for orient in ('horizontal', 'vertical'):
        for length in range(2, LENGTH + 1):
            size = (length * PITCH, PITCH) if orient == 'horizontal' else (PITCH, length * PITCH)
            tile = np.clip(slice_texture(np.asarray(edge, dtype=float) / 255, size), 0, 1)
            depth = gaussian_filter(np.roll(tile, (3, 3), axis=(0, 1)), 1.25)
            frame = np.dstack((tile * 255, tile * 255, depth * 255))
            Image.fromarray(np.uint8(np.round(frame))).save(OUT / 'plaque' / f'{orient}-{length}.png', optimize=True)
        for n in range(1, 9):
            shutil.copy(libraries / 'glaze-filters' / f'glaze-{n:02d}-{orient}.png', OUT / 'glaze')
    # Window pane: one large tile of n x n small-tile units, no inner grout.
    for n in range(1, 9):
        shutil.copy(libraries / 'glaze-filters' / f'glaze-{n:02d}-square.png', OUT / 'glaze')
    for units in range(1, 8):
        size = (units * PITCH, units * PITCH)
        tile = np.clip(slice_texture(np.asarray(edge, dtype=float) / 255, size), 0, 1)
        depth = gaussian_filter(np.roll(tile, (3, 3), axis=(0, 1)), 1.25)
        frame = np.dstack((tile * 255, tile * 255, depth * 255))
        Image.fromarray(np.uint8(np.round(frame))).save(OUT / 'plaque' / f'square-{units}.png', optimize=True)

    # v14 picture tiles, with the wall light removed so the phone can relight them in a new place.
    covers = project / 'TTT-cover-study-v14-brushed-geometry' / 'covers'
    compositions = []
    for slug, title, lang, picture, palette, hint, size, kind in V14:
        (px, py), (tx, ty, tw, th) = v14_rects(picture, hint, size, lang)
        x, y = px * PITCH, py * PITCH
        with Image.open(covers / f'{slug}.png') as cover:
            crop = np.asarray(cover.convert('RGB').crop((x, y, x + SIDE, y + SIDE)), dtype=float)
        flat = np.clip(crop - light(x, y, SIDE, SIDE)[..., None], 0, 255)
        Image.fromarray(np.uint8(np.round(flat))).save(OUT / 'pictures' / f'{slug}.png', optimize=True)
        compositions.append({
            'id': slug, 'name': NAMES[slug], 'kind': kind, 'palette': palette,
            'picture': f'pictures/{slug}.png', 'source': 'v14',
            'example': {'title': title, 'picture': [px, py],
                        'title_rect': [tx, ty, tw, th]},
        })

    if args.generated:
        photos = []
        for file in sorted((libraries / 'small-tile-library').glob('tile-*.png')):
            with Image.open(file) as image:
                photos.append(photo_layers(image.convert('RGBA')))
        order = np.argsort([np.median(p[0]) for p in photos])
        photos = [photos[i] for i in order]
        compositions += generated(Painter(libraries / 'brush-library'), photos, args.generated)

    # Small previews for the picker, and home-screen icons.
    (OUT / 'thumbs').mkdir(exist_ok=True)
    for item in compositions:
        with Image.open(OUT / item['picture']) as image:
            image.convert('RGB').resize((180, 180), RESAMPLE).save(OUT / 'thumbs' / f"{item['id']}.jpg", quality=86)
        item['thumb'] = f"thumbs/{item['id']}.jpg"
    # Home-screen icons come from icon-1024.png (chosen design), not from this bake.
    icon_src = APP / 'icon-1024.png'
    if icon_src.exists():
        with Image.open(icon_src) as image:
            for size in (180, 512):
                image.convert('RGB').resize((size, size), RESAMPLE).save(APP / f'icon-c6-{size}.png', optimize=True)

    font = args.font or next(
        p for p in Path('~/Library/Fonts').expanduser().glob('*.ttf')
        if unicodedata.normalize('NFC', p.stem) == '나눔손글씨 예당체')
    from fontTools.ttLib import TTFont
    face = TTFont(font)
    face.flavor = 'woff'
    face.save(OUT / 'title.woff')

    catalog = {
        'version': 1,
        'canvas': [W, H], 'pitch': PITCH, 'picture': 5, 'title_length': LENGTH,
        'grout': GROUT, 'pool': POOL, 'weight': WEIGHT, 'accents': ACCENTS,
        'glazes': {k: {'clay': v[0], 'ink': v[1], 'accent': v[2],
                       'title_clay': TITLE[k][0], 'title_ink': TITLE[k][1]} for k, v in GLAZES.items()},
        'tiles': tiles, 'glaze_filters': 8,
        'compositions': compositions,
    }
    (OUT / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f"{len(compositions)} compositions, {tiles['count']} tiles")


if __name__ == '__main__':
    main()
