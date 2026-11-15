// Cover renderer. Composites baked library layers on a 1080x1440 canvas.
// Everything runs in the browser; no image or text leaves the device.

const W = 1080, H = 1440, P = 90, SIDE = 450, MAXLEN = 7;
const COLS = 12, ROWS = 16;
const FONT = 'TTTTitle';
const GLASS = [214, 228, 230];   // pale blue-green tint of the window glass
const FROST = .35;                // fixed semi-transparent glass

let catalog = null;
let atlas = null;           // ImageData of tiles.png
const frames = {};          // plaque frames by "orient-length"
const glazes = {};          // glaze filter images by orientation
const pictures = new Map(); // composition id -> ImageData
const steam = {};           // window condensation layers: fog (RGBA) and drops (normal + height)

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
  c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
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
    loadImage('assets/window/fog.png').then(img => { steam.fog = pixels(img); }),
    loadImage('assets/window/drops.png').then(img => { steam.drops = pixels(img); }),
  ];
  for (let n = 1; n <= MAXLEN; n++) {
    jobs.push(loadImage(`assets/plaque/square-${n}.png`).then(img => { frames[`square-${n}`] = pixels(img); }));
  }
  for (const o of ['horizontal', 'vertical', 'square']) {
    for (let n = 2; n <= MAXLEN && o !== 'square'; n++) {
      jobs.push(loadImage(`assets/plaque/${o}-${n}.png`).then(img => { frames[`${o}-${n}`] = pixels(img); }));
    }
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

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function language(text) {
  return /[ㄱ-ㆎ가-힣]/.test(text) ? 'ko' : 'en';
}

// The cover spec, with defaults for drafts saved by older versions.
export function normalize(spec) {
  const text = (spec.title || '').trim();
  const mode = spec.mode === 'window' ? 'window' : 'picture';
  const win = Object.assign({ n: 5 }, spec.window || {}, { frost: FROST });
  win.n = clamp(Math.round(win.n), 1, 7);
  return {
    mode, win, text,
    vertical: language(text) === 'ko' && !!spec.vertical,
    block: mode === 'window' ? win.n : 5,
    length: clamp(Math.round(spec.titleLength || MAXLEN), 2, MAXLEN),
    size: spec.titleSize ? clamp(spec.titleSize, 14, 80) : 0,
  };
}

// A square block (picture 5x5, or window 1..7) and a title strip of 2..7 tiles,
// with exactly one background tile between them. Everything keeps one tile clear
// of the 1:1 / 4:5 / 3:4 crop edges.
export function layouts(vertical, block = 5, length = MAXLEN) {
  const out = [];
  for (let py = 3; py + block <= 13; py++) {
    for (let px = 1; px + block <= 11; px++) {
      if (!vertical) {
        const tx = clamp(px + Math.round((block - length) / 2), 1, 11 - length);
        for (const ty of [py + block + 1, py - 2]) {
          if (ty >= 3 && ty <= 12) out.push({ picture: [px, py], title: [tx, ty, length, 1] });
        }
      } else {
        const ty = clamp(py + Math.round((block - length) / 2), 3, 13 - length);
        for (const tx of [px + block + 1, px - 2]) {
          if (tx >= 1 && tx <= 10) out.push({ picture: [px, py], title: [tx, ty, 1, length] });
        }
      }
    }
  }
  // Prefer arrangements whose whole block sits near the middle of the wall.
  const score = l => {
    const [px, py] = l.picture, [tx, ty, tw, th] = l.title;
    const x0 = Math.min(px, tx), x1 = Math.max(px + block, tx + tw);
    const y0 = Math.min(py, ty), y1 = Math.max(py + block, ty + th);
    return Math.abs((x0 + x1) / 2 - 6) + Math.abs((y0 + y1) / 2 - 8) * .8;
  };
  return out.sort((a, b) => score(a) - score(b));
}

// Index of the layout that moves the block one tile in (dx, dy), keeping the title side.
export function nudge(spec, dx, dy) {
  const s = normalize(spec);
  const list = layouts(s.vertical, s.block, s.length);
  const cur = list[((spec.layout || 0) % list.length + list.length) % list.length];
  const side = l => (s.vertical ? Math.sign(l.title[0] - l.picture[0]) : Math.sign(l.title[1] - l.picture[1]));
  const want = [cur.picture[0] + dx, cur.picture[1] + dy];
  let best = list.findIndex(l => l.picture[0] === want[0] && l.picture[1] === want[1] && side(l) === side(cur));
  if (best < 0) best = list.findIndex(l => l.picture[0] === want[0] && l.picture[1] === want[1]);
  return best;
}

// ---------------------------------------------------------------- title

function measureGlyphs(chars, size, ctx) {
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

// Auto size: the largest size that fits. Manual size: that size, flagged when it overflows.
// Returns null only for an empty title or an auto title that cannot fit.
export function fitTitle(text, vertical, length = MAXLEN, manual = 0) {
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
  const tile = length * P;
  const target = Math.round(tile * (wordy ? .77 : .83));
  const ctx = document.createElement('canvas').getContext('2d');
  const sizes = manual ? [manual] : Array.from({ length: 28 }, (_, i) => 45 - i);
  for (const size of sizes) {
    const g = measureGlyphs(glyphChars, size, ctx);
    const ink = g.reduce((a, b) => a + (vertical ? b.height : b.width), 0);
    const cross = vertical ? Math.max(...g.map(x => x.width))
      : Math.max(...g.map(x => x.ascent)) + Math.max(...g.map(x => x.descent));
    let gap;
    if (!sumW) gap = 0;
    else if (wordy) gap = Math.max(manual ? 2 : 0, (target - ink) / sumW);
    else gap = clamp((target - ink) / sumW, manual ? 2 : 4, 19);
    const span = ink + gap * sumW;
    const fits = cross <= (manual ? 62 : 30) && span <= (manual ? tile - 28 : target + 2) && (!!manual || !wordy || gap >= 2.5);
    if (fits || manual) return { size, glyphs: g, gaps: weights.map(w => w * gap), ink, span, vertical, fits };
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

function plaque(fit, colors, orient, w, h, rand) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = colors.title_clay;
  g.fillRect(0, 0, w, h);
  if (fit) g.drawImage(drawTitle(fit, colors.title_ink, w, h), 0, 0);
  // The glaze lies over the lettering so the title reads as fired under it.
  const list = glazes[orient];
  const glaze = list[Math.floor(rand() * list.length)];
  g.globalAlpha = .88;
  g.drawImage(glaze, 0, 0, w, h, 0, 0, w, h);
  g.globalAlpha = 1;
  return g.getImageData(0, 0, w, h);
}

// ---------------------------------------------------------------- window

// One glass pane of n x n small-tile units. It is a hole in the wall: behind it is the
// next slide (the first body photo, already fitted to 1080x1440) at the very same place,
// so swiping from the cover to the photo continues the view.
function windowPane(behind, x0, y0, n, frost, rand) {
  const S = n * P, pad = 16, B = S + 2 * pad;
  // The view behind, with a margin so the drops can bend in light from just outside.
  const src = document.createElement('canvas');
  src.width = src.height = B;
  const sg = src.getContext('2d', { willReadFrequently: true });
  sg.imageSmoothingQuality = 'high';
  sg.fillStyle = '#c8d6da';
  sg.fillRect(0, 0, B, B);
  if (behind) sg.drawImage(behind, x0 - pad, y0 - pad, B, B, 0, 0, B, B);
  const sharp = sg.getImageData(0, 0, B, B).data;
  // Behind the mist the view is soft: a strong downscale and smooth upscale stands in for a blur.
  const small = document.createElement('canvas');
  small.width = small.height = Math.max(4, Math.round(B / 18));
  const mg = small.getContext('2d');
  mg.imageSmoothingQuality = 'high';
  mg.drawImage(src, 0, 0, small.width, small.height);
  sg.drawImage(small, 0, 0, B, B);
  const soft = sg.getImageData(0, 0, B, B).data;

  // A window-sized piece of the steamed-up glass layers, at a seeded place.
  const T = steam.fog.width;
  const ox = Math.floor(rand() * Math.max(1, T - S)), oy = Math.floor(rand() * Math.max(1, T - S));
  const fog = steam.fog.data, drops = steam.drops.data;
  const thick = clamp(frost / FROST, 0, 1.6);

  const pane = document.createElement('canvas');
  pane.width = pane.height = S;
  const g = pane.getContext('2d', { willReadFrequently: true });
  const out = g.createImageData(S, S);
  const o = out.data;
  const sample = (data, x, y, ch) => {
    x = clamp(x, 0, B - 1.001); y = clamp(y, 0, B - 1.001);
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy;
    const a = (iy * B + ix) * 4 + ch, b = a + 4, c = a + B * 4, d = c + 4;
    const top = data[a] + (data[b] - data[a]) * fx;
    return top + (data[c] + (data[d] - data[c]) * fx - top) * fy;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const k = (y * S + x) * 4;
      const t = ((oy + y) % T * T + (ox + x) % T) * 4;
      const cap = drops[t + 2] / 255;
      if (cap > 0) {
        // A drop is a small lens: it shows the view flipped and a little sharper,
        // darkens toward its rim and carries a highlight from the upper-left light.
        const nx = (drops[t] - 128) / 127, ny = (drops[t + 1] - 128) / 127;
        const bend = 7 + 9 * cap;
        const sx = x + pad - nx * bend, sy = y + pad - ny * bend;
        const rim = .8 + .2 * Math.sqrt(cap);
        const lit = Math.max(0, nx * .55 + ny * .8);
        const d = Math.hypot(nx + .36, ny + .46);
        const spec = cap > .25 ? Math.max(0, 1 - d / .24) ** 2 : 0;
        for (let ch = 0; ch < 3; ch++) {
          const v = sample(sharp, sx, sy, ch) * rim + 12 + 95 * lit * lit * (1 - cap) + 235 * spec;
          o[k + ch] = v;
        }
      } else {
        // Mist: the view goes soft and pale where it is thick.
        const f = clamp(fog[t + 3] / 255 * thick, 0, 1);
        const blur = Math.min(1, f * 1.5), white = f * .62;
        const i = ((y + pad) * B + x + pad) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const v = sharp[i + ch] + (soft[i + ch] - sharp[i + ch]) * blur;
          o[k + ch] = v + (fog[t + ch] - v) * white;
        }
      }
      o[k + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);

  // Glass tint, thicker-looking toward the edges.
  const tint = g.createRadialGradient(S * .45, S * .4, S * .1, S / 2, S / 2, S * .75);
  tint.addColorStop(0, `rgba(${GLASS.join(',')},.04)`);
  tint.addColorStop(1, `rgba(${GLASS.join(',')},.14)`);
  g.fillStyle = tint;
  g.fillRect(0, 0, S, S);

  // A faint glaze surface from the tile photographs, so the pane belongs to the wall.
  const list = glazes.square;
  g.globalAlpha = .06;
  g.drawImage(list[Math.floor(rand() * list.length)], 0, 0, S, S);
  g.globalAlpha = 1;

  // Reflections of the room light, which comes from the upper left like the wall light:
  // a soft sheen in that corner and two diagonal streaks.
  g.save();
  g.globalCompositeOperation = 'screen';
  const sheen = g.createLinearGradient(0, 0, S, S);
  sheen.addColorStop(0, 'rgba(255,255,255,.12)');
  sheen.addColorStop(.45, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(255,255,255,.05)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, S, S);
  const shift = (rand() - .5) * .08;
  const streak = g.createLinearGradient(0, 0, S, S);
  const stops = [[0, 0], [.2, 0], [.25, .14], [.3, .02], [.34, .08], [.37, 0], [.68, 0], [.71, .05], [.74, 0], [1, 0]];
  for (const [t, a] of stops) streak.addColorStop(clamp(t + (t > 0 && t < 1 ? shift : 0), 0, 1), `rgba(255,255,255,${a})`);
  g.fillStyle = streak;
  g.fillRect(0, 0, S, S);
  g.restore();

  // Depth of the opening: the top and left inner edges sit in shadow, the bottom and right catch light.
  const edge = Math.max(8, Math.round(S * .05));
  const shade = (x0g, y0g, x1g, y1g, color, x, y, w, h) => {
    const gr = g.createLinearGradient(x0g, y0g, x1g, y1g);
    gr.addColorStop(0, color);
    gr.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
  };
  shade(0, 0, 0, edge * 1.6, 'rgba(20,28,32,.38)', 0, 0, S, edge * 1.6);
  shade(0, 0, edge * 1.2, 0, 'rgba(20,28,32,.26)', 0, 0, edge * 1.2, S);
  shade(0, S, 0, S - edge * .5, 'rgba(255,255,255,.3)', 0, S - edge * .5, S, edge * .5);
  shade(S, 0, S - edge * .5, 0, 'rgba(255,255,255,.22)', S - edge * .5, 0, edge * .5, S);
  return g.getImageData(0, 0, S, S);
}

// Layout index that puts the block at (px, py), keeping the title on the same side if possible.
export function locate(spec, px, py) {
  const s = normalize(spec);
  const list = layouts(s.vertical, s.block, s.length);
  const cur = list[((spec.layout || 0) % list.length + list.length) % list.length];
  const side = l => (s.vertical ? Math.sign(l.title[0] - l.picture[0]) : Math.sign(l.title[1] - l.picture[1]));
  let best = list.findIndex(l => l.picture[0] === px && l.picture[1] === py && side(l) === side(cur));
  if (best < 0) best = list.findIndex(l => l.picture[0] === px && l.picture[1] === py);
  return best;
}

// Converts a point on the cover to the window's photo framing, for drag-to-pan.
export function windowFrame(spec) {
  const s = normalize(spec);
  if (s.mode !== 'window') return null;
  const list = layouts(s.vertical, s.block, s.length);
  const l = list[((spec.layout || 0) % list.length + list.length) % list.length];
  return { x: l.picture[0] * P, y: l.picture[1] * P, size: s.block * P };
}

// ---------------------------------------------------------------- cover

export async function render(canvas, spec, extra = {}) {
  await init();
  const s = normalize(spec);
  const item = catalog.compositions.find(c => c.id === spec.composition) || catalog.compositions[0];
  const colors = catalog.glazes[s.mode === 'window' ? 'cream' : item.palette];
  const options = layouts(s.vertical, s.block, s.length);
  const layout = options[((spec.layout || 0) % options.length + options.length) % options.length];
  const rand = rng(spec.seed || 1);
  const grout = hex(catalog.grout);

  const [px, py] = layout.picture;
  const [tx, ty, tw, th] = layout.title;
  const reserved = new Set();
  const mark = (x, y, w, h) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) reserved.add(j * COLS + i); };
  mark(px, py, s.block, s.block);
  if (s.text) mark(tx, ty, tw, th);

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
            let v = glaze[ch] + shadow;
            v = v < 0 ? 0 : v > 255 ? 255 : v;
            v = v + (252 - v) * (hi / 255) * .9 + .36 * hi;
            d[di + ch] = v * mask + (grout[ch] - mortar) * m;
          }
          d[di + 3] = 255;
        }
      }
    }
  }

  // Picture tile, or the window pane set in the wall like one large tile.
  if (s.mode === 'picture') {
    const pic = await picture(item);
    for (let y = 0; y < SIDE; y++) {
      d.set(pic.data.subarray(y * SIDE * 4, (y + 1) * SIDE * 4), ((py * P + y) * W + px * P) * 4);
    }
  } else {
    const pane = windowPane(extra.behind, px * P, py * P, s.block, s.win.frost, rand);
    const frame = frames[`square-${s.block}`];
    const S = s.block * P;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const fi = (y * S + x) * 4;
        const tile = frame.data[fi] / 255, depth = frame.data[fi + 2] / 255;
        const di = ((py * P + y) * W + px * P + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          d[di + ch] = pane.data[fi + ch] * tile + (grout[ch] - 10 * depth) * (1 - tile);
        }
        d[di + 3] = 255;
      }
    }
  }

  // Title plaque.
  let fit = null;
  if (s.text) {
    fit = fitTitle(s.text, s.vertical, s.length, s.size);
    const orient = s.vertical ? 'vertical' : 'horizontal';
    const w = tw * P, h = th * P;
    const face = plaque(fit, colors, orient, w, h, rand);
    const frame = frames[`${orient}-${s.length}`];
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
  return {
    layouts: options.length, item, mode: s.mode,
    fits: !s.text || (!!fit && fit.fits), titleSize: fit ? fit.size : 0,
  };
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

export const SIZE = { W, H, P };
