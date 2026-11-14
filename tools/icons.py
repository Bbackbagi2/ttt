"""App icon candidates: three T's built from TTT library strokes and tiles.

Usage:
    python3 tools/icons.py --project "<path to Proj-TheThinker'sToilet>" --out <folder>
"""
import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

import bake

N = 1024
COBALT = '#233f64'
INK = '#204576'
WARM = '#b66636'


class Studio:
    def __init__(self, project):
        lib = project / 'libraries'
        self.painter = bake.Painter(lib / 'brush-library')
        photos = []
        for file in sorted((lib / 'small-tile-library').glob('tile-*.png')):
            with Image.open(file) as image:
                photos.append(bake.photo_layers(image.convert('RGBA')))
        order = np.argsort([np.median(p[0]) for p in photos])
        self.photos = [photos[i] for i in order]
        self.atlas = np.asarray(Image.open(bake.OUT / 'tiles.png'), dtype=float)

    # A library brush stroke, trimmed, tinted and placed by its centre.
    def stroke(self, art, name, cx, cy, length, rotation, tint, seed=0, width=None):
        mark = self.painter.asset(name)
        mark = mark.crop(mark.getchannel('A').point(lambda a: 255 if a > 14 else 0).getbbox())
        mark = self.painter.pigment(mark, tint)
        k = length / mark.width
        h = round(mark.height * (width / mark.height if width else k))
        mark = mark.resize((round(mark.width * k), max(1, h)), bake.RESAMPLE)
        mark = mark.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=True)
        art.alpha_composite(mark, (round(cx - mark.width / 2), round(cy - mark.height / 2)))

    # Solid geometry given the library's brushed-geometry ink treatment.
    def brushed(self, art, shape, tint, seed, joined=False):
        box = shape.getbbox()
        pad = 40
        region = (box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad)
        layer = Image.new('RGBA', (region[2] - region[0], region[3] - region[1]))
        layer.putalpha(shape.crop(region))
        art.alpha_composite(self.painter.brushed(layer, tint, seed, joined=joined), region[:2])

    def tile(self, art, clay, photo=.62):
        p = self.photos[int(len(self.photos) * photo)]
        surface = bake.glazed_picture(p, clay, art)
        return Image.fromarray(np.uint8(np.round(surface)))


def stem(st, art, x, y, angle, length, tint, name='long-droop'):
    """A tapering stroke at its natural proportions, thick end at (x, y), heading along angle
    (degrees, 0 = up, clockwise)."""
    a = math.radians(angle)
    cx, cy = x + math.sin(a) * length / 2, y - math.cos(a) * length / 2
    # The stroke runs left to right with its thick end on the left; turn it to the heading.
    st.stroke(art, name, cx, cy, length, 90 - angle, tint)


def brush_row(st, raw=False, dot=True):
    """One long arched stroke shared by three stems: the gaps between the T's disappear."""
    art = Image.new('RGBA', (N, N))
    st.stroke(art, 'long-arch', 512, 352, 760, 0, INK)
    for x, lean in ((300, 182), (512, 179), (724, 177)):
        stem(st, art, x, 362, lean, 400, INK)
    if dot:
        st.stroke(art, 'daub', 760, 800, 64, 0, WARM)
    return art if raw else st.tile(art, '#e9e9db')


def brush_bold_row(st):
    """Three swept bars laid end to end so they read as one, each with its own stem."""
    art = Image.new('RGBA', (N, N))
    for i, x in enumerate((300, 512, 724)):
        st.stroke(art, 'sweep', x, 360 + (-6, 4, -2)[i], 290, (2, -1, 3)[i], INK)
        stem(st, art, x, 360, (181, 179, 182)[i], 300, INK, 'sweep')
    st.stroke(art, 'daub', 770, 790, 60, 0, WARM)
    return st.tile(art, '#e9e9db', .5)


def brush_triangle(st):
    """Three T's turned 120 degrees apart; their bars outline a triangle, stems point inward."""
    art = Image.new('RGBA', (N, N))
    c = (512, 548)
    for rot in (0, 120, 240):
        a = math.radians(rot)
        bx, by = c[0] + 250 * math.sin(a), c[1] - 250 * math.cos(a)
        st.stroke(art, 'sweep', bx, by, 420, -rot, INK)
        stem(st, art, bx - 30 * math.sin(a), by + 30 * math.cos(a), rot + 180, 200, INK, 'sweep')
    st.stroke(art, 'daub', c[0], c[1], 64, 0, WARM)
    return st.tile(art, '#e9e9db', .55)


def truchet_row(st, raw=False, dot=True, clay='#c4e2e1', ink='#244365', warm=WARM, cell=300, top=360):
    """The library's crossing tile with its upper arm removed becomes a T.
    Three of them side by side join into one continuous bar."""
    cross = st.painter.asset('geo-truchet-through').getchannel('A')
    w, h = cross.size
    # Keep the horizontal arm and the lower arm only, then lengthen the stem.
    t = cross.crop((0, round(h * .45), w, h))
    t = t.resize((cell, round(cell * .55 * 1.55)), bake.RESAMPLE).point(lambda v: 255 if v > 90 else 0)
    t = t.filter(ImageFilter.MaxFilter(31))   # thicken the library line to icon weight
    shape = Image.new('L', (N, N))
    left = (N - cell * 3) // 2
    for i in range(3):
        shape.paste(t, (left + i * cell, top), t)
    # Trim the open ends so the bar finishes inside the tile.
    ImageDraw.Draw(shape).rectangle((0, 0, left + 20, N), fill=0)
    ImageDraw.Draw(shape).rectangle((left + cell * 3 - 20, 0, N, N), fill=0)
    art = Image.new('RGBA', (N, N))
    st.brushed(art, shape, ink, 311, joined=False)
    art.alpha_composite(Image.new('RGBA', (N, N)))
    if dot:
        st.stroke(art, "daub", 512 + cell, top + t.height + cell * .45, cell * .22, 0, warm)
    return art if raw else st.tile(art, clay, .5)


def geometric_triangle(st):
    """A triangle outline with three stems meeting in the middle: three T's sharing edges."""
    shape = Image.new('L', (N, N))
    d = ImageDraw.Draw(shape)
    c = np.array([512, 560])
    r = 330
    pts = [c + r * np.array([math.sin(math.radians(a)), -math.cos(math.radians(a))]) for a in (0, 120, 240)]
    for i in range(3):
        p, q = pts[i], pts[(i + 1) % 3]
        d.line([tuple(p), tuple(q)], fill=255, width=58)
        mid = (p + q) / 2
        d.line([tuple(mid), tuple(c)], fill=255, width=50)
    for p in pts:
        d.ellipse((p[0] - 29, p[1] - 29, p[0] + 29, p[1] + 29), fill=255)
    art = Image.new('RGBA', (N, N))
    st.brushed(art, shape, '#fff0d6', 977)
    st.stroke(art, 'daub', c[0], c[1], 96, 0, '#eab85d')
    return st.tile(art, '#1d4383', .6)


def brush_triangle_out(st):
    """Three T's whose bars form a triangle and whose stems reach outward."""
    art = Image.new('RGBA', (N, N))
    c = (512, 560)
    d = 120
    for rot in (0, 120, 240):
        a = math.radians(rot)
        bx, by = c[0] + d * math.sin(a), c[1] - d * math.cos(a)
        # The arch bows toward the centre so the three bars close into a soft triangle.
        st.stroke(art, 'sweep', bx, by, 400, -rot, INK)
        stem(st, art, bx + 20 * math.sin(a), by - 20 * math.cos(a), rot, 230, INK, 'sweep')
    st.stroke(art, 'daub', c[0], c[1], 58, 0, WARM)
    return st.tile(art, '#e9e9db', .58)


def geometric_triangle_out(st):
    """A triangle outline with a stem from each edge pointing outward."""
    shape = Image.new('L', (N, N))
    d = ImageDraw.Draw(shape)
    c = np.array([512, 470])
    r, stem = 250, 205
    pts = [c + r * np.array([math.sin(math.radians(a)), -math.cos(math.radians(a))]) for a in (0, 120, 240)]
    for i in range(3):
        p, q = pts[i], pts[(i + 1) % 3]
        d.line([tuple(p), tuple(q)], fill=255, width=58)
        mid = (p + q) / 2
        out = (mid - c) / np.linalg.norm(mid - c)
        d.line([tuple(mid), tuple(mid + out * stem)], fill=255, width=52)
    for p in pts:
        d.ellipse((p[0] - 29, p[1] - 29, p[0] + 29, p[1] + 29), fill=255)
    art = Image.new('RGBA', (N, N))
    st.brushed(art, shape, '#fff0d6', 1213)
    st.stroke(art, 'daub', c[0], c[1], 84, 0, '#eab85d')
    return st.tile(art, '#1d4383', .6)


def mosaic(st, blank=False, grid_n=11, accents=((1, 2), (9, 8))):
    """Three T's laid in small tiles, the middle one upside down so they lock together."""
    # Three T's whose bars touch, so the gaps between them disappear into one bar.
    grid = [
        'XXXXXXXXX',
        '.X..X..X.',
        '.X..X..X.',
        '.X..X..X.',
    ]
    rows = cols = grid_n
    cells = [['.'] * cols for _ in range(rows)]
    if not blank:
        for r, line in enumerate(grid):
            for c, ch in enumerate(line):
                cells[r + 3][c + 1] = ch
    pitch = N // cols
    out = np.zeros((N, N, 3))
    out[:] = bake.rgb(bake.GROUT)
    rng = np.random.default_rng(7)
    pool = [bake.rgb(c) for c in bake.POOL[:5]]
    count = len(st.photos)
    a = st.atlas
    for r in range(rows):
        for c in range(cols):
            k = int(rng.integers(120))
            sx, sy = k % 12 * 90, k // 12 * 90
            cell = a[sy:sy + 90, sx:sx + 90]
            cell = np.asarray(Image.fromarray(np.uint8(cell)).resize((pitch, pitch), bake.RESAMPLE), dtype=float)
            reflect, mask, depth = cell[..., 0] - 128, cell[..., 1] / 255, cell[..., 2] / 255
            glaze = bake.rgb('#22427a') if cells[r][c] == 'X' and not blank else pool[int(rng.integers(len(pool)))]
            if cells[r][c] == '.' and (r, c) in accents:
                glaze = bake.rgb(bake.ACCENTS[0])
            s = np.clip(glaze + np.minimum(0, reflect)[..., None], 0, 255)
            hi = np.maximum(0, reflect)[..., None]
            s = s + (252 - s) * hi / 255 * .9 + .36 * hi
            mortar = bake.rgb(bake.GROUT) - 10 * depth[..., None]
            m = mask[..., None]
            y0, x0 = r * pitch + (N - rows * pitch) // 2, c * pitch + (N - cols * pitch) // 2
            out[y0:y0 + pitch, x0:x0 + pitch] = s * m + mortar * (1 - m)
    return Image.fromarray(np.uint8(np.clip(out, 0, 255)))


WHITE = '#f3f1ea'


def on_wall(st, art_fn, units):
    """The mosaic wall of E with one white glazed tile of units x units cells set in it."""
    wall = mosaic(st, blank=True)
    pitch = N // 11
    size = units * pitch
    # Centre the drawing in the white tile with an even margin.
    raw = art_fn(st, raw=True)
    raw = raw.crop(raw.getbbox())
    k = size * .66 / max(raw.size)
    raw = raw.resize((round(raw.width * k), round(raw.height * k)), bake.RESAMPLE)
    art = Image.new('RGBA', (size, size))
    art.alpha_composite(raw, ((size - raw.width) // 2, (size - raw.height) // 2))
    photo = st.photos[int(len(st.photos) * .7)]
    tile = Image.fromarray(np.uint8(np.round(bake.glazed_picture(photo, WHITE, art))))
    origin = (N - 11 * pitch) // 2 + (11 - units) // 2 * pitch
    wall.paste(tile, (origin, origin))
    return wall


def squircle(size, inset, scale=4):
    """Anti-aliased rounded square with continuous corners like the home-screen icon mask."""
    big = size * scale
    r = (size - 2 * inset) / 2 * scale
    yy, xx = np.mgrid[0:big, 0:big] + .5
    c = big / 2
    # A superellipse with exponent 5 follows the iOS icon outline closely.
    v = (np.abs(xx - c) / r) ** 5 + (np.abs(yy - c) / r) ** 5
    mask = Image.fromarray(np.uint8((v <= 1) * 255)).resize((size, size), Image.Resampling.BOX)
    return np.asarray(mask, dtype=float) / 255


def on_wall_round(st, art_fn, units, grid_n=10, fill=.88):
    """E's wall with a white tile whose corners curve like the icon itself."""
    from scipy.ndimage import gaussian_filter
    pitch = N // grid_n
    off = (N - grid_n * pitch) // 2
    first = (grid_n - units) // 2
    wall = np.asarray(mosaic(st, blank=True, grid_n=grid_n,
                             accents=((1, 2), (grid_n - 2, grid_n - 3))), dtype=float)
    size = units * pitch
    # The T's alone set the size; the warm dot is added afterwards so it does not shift them.
    raw = art_fn(st, raw=True, dot=False)
    raw = raw.crop(raw.getbbox())
    k = size * fill / max(raw.size)
    raw = raw.resize((round(raw.width * k), round(raw.height * k)), bake.RESAMPLE)
    art = Image.new('RGBA', (size, size))
    left, top = (size - raw.width) // 2, (size - raw.height) // 2
    art.alpha_composite(raw, (left, top))
    st.stroke(art, 'daub', left + raw.width * .9, top + raw.height + size * .06, size * .045, 0, WARM)
    photo = st.photos[int(len(st.photos) * .7)]
    surface = bake.glazed_picture(photo, WHITE, art)
    mask = squircle(size, 7)
    # Soft bevel inside the curved edge, and the grout shadow outside it.
    edge = 1 - gaussian_filter(mask, 5)
    surface = surface * (1 - .07 * edge[..., None])
    depth = gaussian_filter(np.roll(mask, (3, 3), axis=(0, 1)), 1.6)
    mortar = bake.rgb(bake.GROUT) - 10 * depth[..., None]
    x0 = off + first * pitch
    region = mortar * (1 - mask[..., None]) + surface * mask[..., None]
    wall[x0:x0 + size, x0:x0 + size] = region
    return Image.fromarray(np.uint8(np.clip(wall, 0, 255)))


WALL_VARIANTS = (
    ('I-wall-A-7', '벽 + 흰 타일 A (7칸)', lambda st: on_wall(st, brush_row, 7)),
    ('J-wall-A-5', '벽 + 흰 타일 A (5칸)', lambda st: on_wall(st, brush_row, 5)),
    ('K-wall-C-7', '벽 + 흰 타일 C (7칸)', lambda st: on_wall(st, truchet_row, 7)),
    ('L-wall-C-5', '벽 + 흰 타일 C (5칸)', lambda st: on_wall(st, truchet_row, 5)),
)

C_COLORS = (
    ('C1-sea', '물빛 (현재)', '#c4e2e1', '#244365', WARM),
    ('C2-white', '흰 유약', '#f3f1ea', '#244365', WARM),
    ('C3-cream', '크림', '#e9e9db', '#204576', WARM),
    ('C4-sand', '모래', '#eadac2', '#8b3a2d', '#d88249'),
    ('C5-mist', '안개 파랑', '#a1b9c9', '#1d3a63', '#ac8173'),
    ('C6-navy', '코발트', '#1d4383', '#fff0d6', '#eab85d'),
    ('C7-slate', '짙은 회청', '#2d4e66', '#f1ecd7', '#d79755'),
    ('C8-terracotta', '테라코타', '#ac8173', '#fff3e2', '#2d4e66'),
)

ROUND_VARIANTS = (
    ('M-round-A-4', '둥근 흰 타일 A (4칸)', lambda st: on_wall_round(st, brush_row, 4)),
    ('N-round-C-4', '둥근 흰 타일 C (4칸)', lambda st: on_wall_round(st, truchet_row, 4)),
)


CANDIDATES = (
    ('A-brush-row', '붓 한 줄', brush_row),
    ('B-brush-triangle', '붓 삼각', brush_triangle),
    ('C-truchet-row', '트뤼셰 이음', truchet_row),
    ('D-geometric-triangle', '기하 삼각', geometric_triangle),
    ('E-mosaic', '모자이크 이음', mosaic),
    ('F-brush-triangle-out', '붓 삼각 바깥', brush_triangle_out),
    ('G-geometric-triangle-out', '기하 삼각 바깥', geometric_triangle_out),
    ('H-brush-bold-row', '붓 굵은 줄', brush_bold_row),
)


def board(images, out, title='TTT 앱 아이콘 후보'):
    from PIL import ImageFont
    size, gap, pad, per_row = 300, 40, 60, 4
    rows = -(-len(images) // per_row)
    page = Image.new('RGB', (pad * 2 + per_row * size + (per_row - 1) * gap, 90 + rows * 430), '#f4f1ea')
    d = ImageDraw.Draw(page)
    font = ImageFont.truetype('/System/Library/Fonts/AppleSDGothicNeo.ttc', 26)
    small = ImageFont.truetype('/System/Library/Fonts/AppleSDGothicNeo.ttc', 20)
    d.text((pad, 34), title, fill='#1d3550', font=font)
    for i, (key, label, img) in enumerate(images):
        x = pad + i % per_row * (size + gap)
        y0 = 90 + i // per_row * 430 - 100
        # Preview with the iOS corner mask.
        mask = Image.new('L', (size, size))
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=round(size * .2237), fill=255)
        page.paste(img.resize((size, size), bake.RESAMPLE), (x, y0 + 100), mask)
        small_icon = img.resize((60, 60), bake.RESAMPLE)
        m2 = mask.resize((60, 60), bake.RESAMPLE)
        page.paste(small_icon, (x, y0 + 420 - 10), m2)
        d.text((x + 76, y0 + 412), f'{key[0]} · {label}', fill='#1d3550', font=small)
        d.text((x + 76, y0 + 442), '홈 화면 크기', fill='#687a88', font=small)
    page.save(out, quality=92)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--only', choices=('all', 'wall', 'round', 'colors', 'app'), default='all')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    st = Studio(args.project.expanduser())
    if args.only == 'app':
        # The chosen design (C6): TTT kept inside the home-screen safe area.
        img = truchet_row(st, clay='#1d4383', ink='#fff0d6', warm='#eab85d', cell=230, top=395).convert('RGB')
        w = img.width
        img = img.crop((18, 18, w - 18, w - 18)).resize((N, N), bake.RESAMPLE)
        img.save(bake.APP / 'icon-1024.png', optimize=True)
        for size in (180, 512):
            img.resize((size, size), bake.RESAMPLE).save(bake.APP / f'icon-{bake.icon_hash()}-{size}.png', optimize=True)
        img.save(args.out / 'C6-navy-app.png', optimize=True)
        return
    if args.only == 'colors':
        images = []
        for key, label, clay, ink, warm in C_COLORS:
            img = truchet_row(st, clay=clay, ink=ink, warm=warm).convert('RGB')
            img.save(args.out / f'{key}.png', optimize=True)
            images.append((key, label, img))
        board(images, args.out / 'TTT-app-icon-C-colors.jpg', 'C · 트뤼셰 이음 바탕색 비교')
        return
    if args.only == 'round':
        images = []
        for key, label, make in ROUND_VARIANTS:
            img = make(st).convert('RGB')
            img.save(args.out / f'{key}.png', optimize=True)
            images.append((key, label, img))
        board(images, args.out / 'TTT-app-icon-round-variants.jpg', '둥근 흰 타일 4×4칸 + 큰 TTT')
        return
    if args.only == 'wall':
        images = []
        for key, label, make in WALL_VARIANTS:
            img = make(st).convert('RGB')
            img.save(args.out / f'{key}.png', optimize=True)
            images.append((key, label, img))
        board(images, args.out / 'TTT-app-icon-wall-variants.jpg', 'E의 타일 벽 + 흰 타일 A·C')
        return
    images = []
    for key, label, make in CANDIDATES:
        img = make(st).convert('RGB')
        img.save(args.out / f'{key}.png', optimize=True)
        images.append((key, label, img))
    board(images, args.out / 'TTT-app-icon-candidates.jpg')


if __name__ == '__main__':
    main()
