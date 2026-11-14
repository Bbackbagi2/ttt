// Cover renderer. Composites baked library layers on a 1080x1440 canvas.
// Everything runs in the browser; no image or text leaves the device.

const W = 1080, H = 1440, P = 90, SIDE = 450, LEN = 7;
const COLS = 12, ROWS = 16;
const FONT = 'TTTTitle';

let catalog = null;
let atlas = null;           // ImageData of tiles.png
const frames = {};          // plaque frames by orientation
const glazes = {};          // glaze filter images by orientation
const pictures = new Map(); // composition id -> ImageData

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다: ' + src));
    img.src = src;
  });
}

function pixels(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}

export async function init() {
  if (catalog) return catalog;
  catalog = await (await fetch('assets/catalog.json')).json();
  const font = new FontFace(FONT, 'url(assets/title.woff)');
  const jobs = [
    loadImage('assets/tiles.png').then(img => { atlas = pixels(img); }),
    font.load().then(f => document.fonts.add(f)),
  ];
  for (const o of ['horizontal', 'vertical']) {
    jobs.push(loadImage(`assets/plaque-${o}.png`).then(img => { frames[o] = pixels(img); }));
    glazes[o] = [];
    for (let n = 1; n <= catalog.glaze_filters; n++) {
      jobs.push(loadImage(`assets/glaze/glaze-${String(n).padStart(2, '0')}-${o}.png`)
        .then(img => { glazes[o][n - 1] = img; }));
    }
  }
  await Promise.all(jobs);
  return catalog;
}

async function picture(item) {
  if (!pictures.has(item.id)) pictures.set(item.id, pixels(await loadImage('assets/' + item.picture)));
  return pictures.get(item.id);
}

// ---------------------------------------------------------------- helpers

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(v) {
  const n = parseInt(v.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function permutation(n, rand) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function language(text) {
  return /[ㄱ-ㆎ가-힣]/.test(text) ? 'ko' : 'en';
}

// Picture 5x5 and title 7x1 (or 1x7) with exactly one background tile between them.
// Everything keeps one tile clear of the 1:1 / 4:5 / 3:4 crop edges.
export function layouts(vertical) {
  const out = [];
  for (let py = 3; py <= 8; py++) {
    for (let px = 1; px <= 6; px++) {
      if (!vertical) {
        const tx = Math.min(4, Math.max(1, px - 1));
        for (const ty of [py + 6, py - 2]) {
          if (ty >= 3 && ty <= 12) out.push({ picture: [px, py], title: [tx, ty, LEN, 1] });
        }
      } else {
        const ty = Math.min(6, Math.max(3, py - 1));
        for (const tx of [px + 6, px - 2]) {
          if (tx >= 1 && tx <= 10) out.push({ picture: [px, py], title: [tx, ty, 1, LEN] });
        }
      }
    }
  }
  // Prefer arrangements whose whole block sits near the middle of the wall.
  const score = l => {
    const [px, py] = l.picture, [tx, ty, tw, th] = l.title;
    const x0 = Math.min(px, tx), x1 = Math.max(px + 5, tx + tw);
    const y0 = Math.min(py, ty), y1 = Math.max(py + 5, ty + th);
    return Math.abs((x0 + x1) / 2 - 6) + Math.abs((y0 + y1) / 2 - 8) * .8;
  };
  return out.sort((a, b) => score(a) - score(b));
}

// ---------------------------------------------------------------- title

function measureGlyphs(chars, size, vertical, ctx) {
  ctx.font = `${size}px ${FONT}`;
  return chars.map(c => {
    const m = ctx.measureText(c);
    return {
      c, left: m.actualBoundingBoxLeft, right: m.actualBoundingBoxRight,
      ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent,
      width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
      height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
    };
  });
}

// Returns null when the title cannot fit at the smallest size.
export function fitTitle(text, vertical) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const wordEnds = new Set();
  let n = 0;
  for (const w of words.slice(0, -1)) { n += [...w].length; wordEnds.add(n - 1); }
  const glyphChars = words.flatMap(w => [...w]);
  const weight = text.trim().match(/^[\x00-\x7f]*$/) ? 3.6 : vertical ? 2.8 : 3.0;
  const weights = glyphChars.slice(0, -1).map((_, i) => (wordEnds.has(i) ? weight : 1));
  const sumW = weights.reduce((a, b) => a + b, 0);
  const wordy = words.length >= 3;
  const target = wordy ? 486 : 523;
  const ctx = document.createElement('canvas').getContext('2d');
  for (let size = 45; size >= 18; size--) {
    const g = measureGlyphs(glyphChars, size, vertical, ctx);
    const ink = g.reduce((a, b) => a + (vertical ? b.height : b.width), 0);
    const cross = vertical ? Math.max(...g.map(x => x.width))
      : Math.max(...g.map(x => x.ascent)) + Math.max(...g.map(x => x.descent));
    if (cross > 30) continue;
    let gap;
    if (!sumW) gap = 0;
    else if (wordy) { gap = (target - ink) / sumW; if (gap < 2.5) continue; }
    else { gap = Math.min(19, Math.max(4, (target - ink) / sumW)); if (ink + gap * sumW > target + 2) continue; }
    return { size, glyphs: g, gaps: weights.map(w => w * gap), ink, span: ink + gap * sumW, vertical };
  }
  return null;
}

function drawTitle(fit, ink, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.font = `${fit.size}px ${FONT}`;
  g.fillStyle = ink;
  g.textBaseline = 'alphabetic';
  if (!fit.vertical) {
    const asc = Math.max(...fit.glyphs.map(x => x.ascent));
    const desc = Math.max(...fit.glyphs.map(x => x.descent));
    const baseline = Math.round((h - (asc + desc)) / 2 + asc);
    let x = (w - fit.span) / 2;
    fit.glyphs.forEach((gl, i) => {
      g.fillText(gl.c, x + gl.left, baseline);
      x += gl.width + (fit.gaps[i] || 0);
    });
  } else {
    let y = (h - fit.span) / 2;
    fit.glyphs.forEach((gl, i) => {
      g.fillText(gl.c, w / 2 - (gl.right - gl.left) / 2, y + gl.ascent);
      y += gl.height + (fit.gaps[i] || 0);
    });
  }
  return c;
}

function plaque(fit, colors, orient, rand) {
  const [w, h] = orient === 'horizontal' ? [LEN * P, P] : [P, LEN * P];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = colors.title_clay;
  g.fillRect(0, 0, w, h);
  if (fit) g.drawImage(drawTitle(fit, colors.title_ink, w, h), 0, 0);
  // The glaze lies over the lettering so the title reads as fired under it.
  const list = glazes[orient];
  g.globalAlpha = .88;
  g.drawImage(list[Math.floor(rand() * list.length)], 0, 0);
  g.globalAlpha = 1;
  return g.getImageData(0, 0, w, h);
}

// ---------------------------------------------------------------- cover

export async function render(canvas, spec) {
  await init();
  const item = catalog.compositions.find(c => c.id === spec.composition) || catalog.compositions[0];
  const colors = catalog.glazes[item.palette];
  const text = (spec.title || '').trim();
  const vertical = language(text) === 'ko' && !!spec.vertical;
  const options = layouts(vertical);
  const layout = options[((spec.layout || 0) % options.length + options.length) % options.length];
  const rand = rng(spec.seed || 1);
  const grout = hex(catalog.grout);

  const [px, py] = layout.picture;
  const [tx, ty, tw, th] = layout.title;
  const reserved = new Set();
  const mark = (x, y, w, h) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) reserved.add(j * COLS + i); };
  mark(px, py, 5, 5);
  if (text) mark(tx, ty, tw, th);

  // Background glaze pattern and photographed tile assignment.
  const pool = catalog.pool.map(hex), cum = [];
  catalog.weight.reduce((a, b, i) => (cum[i] = a + b), 0);
  const pattern = Array.from({ length: ROWS * COLS }, () => {
    const r = rand() * cum[cum.length - 1];
    return pool[cum.findIndex(v => r < v)];
  });
  const accents = catalog.accents.map(hex);
  for (const [x, y, k] of [[1 + Math.floor(rand() * 4), 1 + Math.floor(rand() * 4), 0],
                           [8 + Math.floor(rand() * 3), 10 + Math.floor(rand() * 5), 1]]) {
    if (!reserved.has(y * COLS + x)) pattern[y * COLS + x] = accents[k];
  }
  const count = catalog.tiles.count;
  let ids = [];
  while (ids.length < ROWS * COLS) ids = ids.concat(permutation(count, rand));

  const out = new ImageData(W, H);
  const d = out.data;
  const a = atlas.data, aw = atlas.width;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const k = row * COLS + col;
      if (reserved.has(k)) continue;
      const id = ids[k];
      const sx = (id % catalog.tiles.columns) * P, sy = Math.floor(id / catalog.tiles.columns) * P;
      const glaze = pattern[k];
      for (let y = 0; y < P; y++) {
        let si = ((sy + y) * aw + sx) * 4;
        let di = ((row * P + y) * W + col * P) * 4;
        for (let x = 0; x < P; x++, si += 4, di += 4) {
          const reflect = a[si] - 128, mask = a[si + 1] / 255, depth = a[si + 2] / 255;
          const shadow = Math.min(0, reflect), hi = Math.max(0, reflect);
          const m = 1 - mask, mortar = 10 * depth;
          for (let ch = 0; ch < 3; ch++) {
            let s = glaze[ch] + shadow;
            s = s < 0 ? 0 : s > 255 ? 255 : s;
            s = s + (252 - s) * (hi / 255) * .9 + .36 * hi;
            d[di + ch] = s * mask + (grout[ch] - mortar) * m;
          }
          d[di + 3] = 255;
        }
      }
    }
  }

  // Picture tile.
  const pic = await picture(item);
  for (let y = 0; y < SIDE; y++) {
    const src = pic.data.subarray(y * SIDE * 4, (y + 1) * SIDE * 4);
    d.set(src, ((py * P + y) * W + px * P) * 4);
  }

  // Title plaque.
  let fit = null;
  if (text) {
    fit = fitTitle(text, vertical);
    const orient = vertical ? 'vertical' : 'horizontal';
    const face = plaque(fit, colors, orient, rand);
    const frame = frames[orient];
    const w = tw * P, h = th * P;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const fi = (y * w + x) * 4;
        const tile = frame.data[fi] / 255, depth = frame.data[fi + 2] / 255;
        const di = ((ty * P + y) * W + tx * P + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          d[di + ch] = face.data[fi + ch] * tile + (grout[ch] - 10 * depth) * (1 - tile);
        }
        d[di + 3] = 255;
      }
    }
  }

  // One soft upper-left light across the whole wall.
  for (let y = 0; y < H; y++) {
    const yy = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const xx = x / (W - 1);
      const l = 5.2 * (.76 - xx) * (.73 - yy) + 2.1 * (.58 - yy) + 1.0 * (.5 - xx);
      const i = (y * W + x) * 4;
      d[i] += l; d[i + 1] += l; d[i + 2] += l;
    }
  }

  canvas.width = W; canvas.height = H;
  canvas.getContext('2d').putImageData(out, 0, 0);
  return { layouts: options.length, fits: !text || !!fit, item };
}

// Body photo prepared at 3:4 without any theme.
export function preparePhoto(img, fit, background = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = background;
  g.fillRect(0, 0, W, H);
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const k = fit === 'pad' ? Math.min(W / iw, H / ih) : Math.max(W / iw, H / ih);
  const w = iw * k, h = ih * k;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  return c;
}

export const SIZE = { W, H };
