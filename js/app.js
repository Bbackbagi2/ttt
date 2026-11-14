import { init, render, language, layouts, preparePhoto, normalize, nudge, locate, windowFrame } from './render.js?v=7';
import * as store from './store.js?v=7';

const $ = id => document.getElementById(id);
const CAPTION_LIMIT = 2200;
let catalog = null;
let draft = null;
let filter = '';
let prepared = null;          // files ready to share for the current draft state
let history = [];             // cover settings before each change, for undo
let future = [];              // settings undone, for redo
let lastCheck = { key: '', time: 0 };
let behind = { key: null, canvas: null };   // first body photo fitted to 3:4, seen through the window
const COVER_KEYS = ['composition', 'seed', 'layout', 'vertical', 'mode', 'window', 'titleLength', 'titleSize'];
const urls = new Set();

function url(blob) { const u = URL.createObjectURL(blob); urls.add(u); return u; }
function releaseUrls() { urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); }

function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

function seed() { return (Math.random() * 2 ** 31) >>> 0; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function toBlob(canvas, quality = .92) {
  return new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
}
function loadBlobImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const u = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('사진을 읽지 못했습니다.')); };
    img.src = u;
  });
}

// ---------------------------------------------------------------- home

async function showHome() {
  releaseUrls();
  draft = null;
  $('editor').hidden = true;
  $('home').hidden = false;
  const drafts = await store.list();
  $('draft-count').textContent = `${drafts.length} / ${store.LIMIT}`;
  $('new-draft').disabled = drafts.length >= store.LIMIT;
  $('empty').hidden = drafts.length > 0;
  const list = $('drafts');
  list.replaceChildren();
  for (const d of drafts) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const img = document.createElement('img');
    if (d.thumb) img.src = url(d.thumb);
    img.alt = '';
    const meta = document.createElement('span');
    meta.className = 'meta';
    const strong = document.createElement('strong');
    strong.textContent = d.title?.trim() || '(제목 없음)';
    const info = document.createElement('span');
    info.className = 'muted small';
    const when = new Date(d.updated);
    info.textContent = `사진 ${d.photos.length}장 · ${when.getMonth() + 1}월 ${when.getDate()}일 ${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')} 수정`;
    meta.append(strong, info);
    const chev = icon('chev', 'ic sm chev');
    b.append(img, meta, chev);
    b.addEventListener('click', () => openDraft(d.id));
    li.append(b);
    list.append(li);
  }
}

// Assets load in the background; drafts can be listed before they arrive.
let ready = null;
async function whenReady() {
  if (!catalog) {
    toast('표지 자원을 불러오는 중입니다…');
    catalog = await ready;
  }
}

async function newDraft() {
  await whenReady();
  const comps = catalog.compositions;
  draft = {
    id: uid(), created: Date.now(), updated: Date.now(),
    composition: comps[Math.floor(Math.random() * comps.length)].id,
    title: '', vertical: false, layout: 0, seed: seed(), caption: '', photos: [], thumb: null,
  };
  try { await store.save(draft); } catch (e) { toast(e.message); return; }
  openEditor();
}

async function openDraft(id) {
  await whenReady();
  draft = await store.get(id);
  if (draft) openEditor();
}

// ---------------------------------------------------------------- editor

function openEditor() {
  releaseUrls();
  prepared = null;
  $('home').hidden = true;
  $('editor').hidden = false;
  window.scrollTo(0, 0);
  $('title').value = draft.title;
  $('caption').value = draft.caption;
  $('fallback').hidden = true;
  $('export-status').textContent = '';
  $('saved').textContent = '';
  history = [];
  future = [];
  lastCheck = { key: '', time: 0 };
  behind = { key: null, canvas: null };
  showTab('cover');
  syncControls();
  renderCompositions();
  renderPhotos();
  updateCaptionCount();
  schedule();
}

// ---------------------------------------------------------------- undo

function snapshot() {
  return JSON.stringify(Object.fromEntries(COVER_KEYS.map(k => [k, draft[k] ?? null])));
}

// Records the settings before a change. Rapid repeats of one control (a slider drag) count once.
function checkpoint(key) {
  const now = Date.now();
  if (key === lastCheck.key && now - lastCheck.time < 900) { lastCheck.time = now; return; }
  lastCheck = { key, time: now };
  const snap = snapshot();
  if (history[history.length - 1] !== snap) history.push(snap);
  if (history.length > 60) history.shift();
  future = [];
  syncHistory();
}

function travel(from, to) {
  const snap = from.pop();
  if (!snap) return;
  to.push(snapshot());
  Object.assign(draft, JSON.parse(snap));
  lastCheck = { key: '', time: 0 };
  syncControls();
  renderCompositions();
  schedule();
}
const undo = () => travel(history, future);
const redo = () => travel(future, history);

function syncHistory() {
  $('undo').disabled = !history.length;
  $('redo').disabled = !future.length;
}

function icon(name, cls = 'ic') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

// The picture name shows only while its category is on screen.
function showCompName(name) {
  const item = catalog.compositions.find(c => c.id === draft.composition);
  const visible = item && (!filter || item.kind === filter);
  $('comp-name').textContent = name ?? (visible ? item.name : '');
}

function syncControls() {
  const s = normalize(draft);
  syncDirection();
  syncHistory();
  for (const b of $('mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === s.mode);
  $('window-panel').hidden = s.mode !== 'window';
  $('picture-panel').hidden = s.mode === 'window';
  $('cover').classList.toggle('grab', s.mode === 'window');
  $('window-nophoto').hidden = !!draft.photos.length;
  $('win-n').value = s.win.n; $('win-n-out').textContent = `${s.win.n} × ${s.win.n}칸`;
  $('title-length').value = s.length; $('length-out').textContent = `${s.length}칸`;
  $('size-auto').classList.toggle('on', !s.size);
  $('size-manual').classList.toggle('on', !!s.size);
  $('size-slider').hidden = !s.size;
  if (s.size) { $('title-size').value = s.size; $('size-out').textContent = `${s.size}px`; }
  $('photo-count').textContent = draft.photos.length || '';
}

let renderTimer = 0, saveTimer = 0;
function schedule() {
  prepared = null;
  $('export-label').textContent = 'Prepare images';
  clearTimeout(renderTimer);
  renderTimer = setTimeout(drawCover, 120);
}

async function drawCover() {
  if (!draft) return;
  const canvas = $('cover');
  const back = normalize(draft).mode === 'window' ? await behindPhoto() : null;
  const result = await render(canvas, draft, { behind: back });
  $('title-warn').hidden = result.fits;
  if (result.mode === 'picture') showCompName();
  if (!draft.titleSize && result.titleSize) $('title-size').value = result.titleSize;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistDraft, 500);
}

async function behindPhoto() {
  const p = draft.photos[0];
  if (!p) return null;
  const key = p.id + ':' + p.fit;
  if (behind.key !== key) behind = { key, canvas: preparePhoto(await loadBlobImage(p.blob), p.fit) };
  return behind.canvas;
}

async function persistDraft() {
  if (!draft) return;
  const small = document.createElement('canvas');
  small.width = 162; small.height = 216;
  small.getContext('2d').drawImage($('cover'), 0, 0, 162, 216);
  draft.thumb = await toBlob(small, .8);
  try {
    await store.save(draft);
    $('saved').textContent = '이 기기에 저장됨';
  } catch (e) {
    $('saved').textContent = '저장 실패';
    toast(e.message);
  }
}

function syncDirection() {
  const text = draft.title.trim();
  const ko = language(text) === 'ko';
  $('direction-field').hidden = !ko;
  $('lang').textContent = !text ? '비워 두면 제목 타일 없이 만듭니다.' : ko ? '한국어 제목 · 가로 또는 세로' : '영어 제목 · 가로';
  for (const b of $('direction').querySelectorAll('button')) {
    b.classList.toggle('on', String(+!!draft.vertical) === b.dataset.v);
  }
}

function renderCompositions() {
  const grid = $('compositions');
  grid.replaceChildren();
  for (const c of catalog.compositions) {
    if (filter && c.kind !== filter) continue;
    const b = document.createElement('button');
    b.className = c.id === draft.composition ? 'on' : '';
    b.setAttribute('aria-label', c.name);
    const img = document.createElement('img');
    img.src = 'assets/' + c.thumb; img.alt = ''; img.loading = 'lazy';
    b.append(img);
    b.addEventListener('click', () => {
      checkpoint('composition:' + c.id);
      draft.composition = c.id;
      grid.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      schedule();
    });
    grid.append(b);
  }
  for (const b of $('filters').querySelectorAll('button')) b.classList.toggle('on', b.dataset.k === filter);
  showCompName();
}

// ---------------------------------------------------------------- photos

async function addPhotos(files) {
  for (const file of files) {
    try {
      const img = await loadBlobImage(file);
      // Keep a reduced copy only: enough for a 1080x1440 crop or pad.
      const k = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, c.width, c.height);
      draft.photos.push({ id: uid(), blob: await toBlob(c, .9), fit: 'crop' });
    } catch (e) { toast(e.message); }
  }
  renderPhotos();
  syncControls();
  schedule();
}

async function renderPhotos() {
  const list = $('photos');
  list.replaceChildren();
  for (const [i, p] of draft.photos.entries()) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'num'; num.textContent = i + 2;
    if (i === 0) num.title = '창 너머로 보이는 사진';
    const img = document.createElement('img');
    img.alt = '';
    const tools = document.createElement('div');
    tools.className = 'tools';
    const button = (name, label, fn, disabled = false, cls = '') => {
      const b = document.createElement('button');
      b.append(icon(name)); b.disabled = disabled; b.className = cls;
      b.setAttribute('aria-label', label); b.title = label;
      b.addEventListener('click', fn);
      tools.append(b);
    };
    button(p.fit === 'crop' ? 'fill' : 'fit', p.fit === 'crop' ? 'Fill (tap for fit)' : 'Fit (tap for fill)',
      () => { p.fit = p.fit === 'crop' ? 'pad' : 'crop'; renderPhotos(); schedule(); }, false, 'fit');
    button('up', 'Move up', () => { move(i, -1); }, i === 0);
    button('down', 'Move down', () => { move(i, 1); }, i === draft.photos.length - 1);
    button('close', 'Remove', () => { draft.photos.splice(i, 1); renderPhotos(); syncControls(); schedule(); });
    li.append(num, img, tools);
    list.append(li);
    loadBlobImage(p.blob).then(source => {
      const c = preparePhoto(source, p.fit);
      const s = document.createElement('canvas');
      s.width = 120; s.height = 160;
      s.getContext('2d').drawImage(c, 0, 0, 120, 160);
      img.src = s.toDataURL('image/jpeg', .8);
    });
  }
}

function move(i, step) {
  const j = i + step;
  [draft.photos[i], draft.photos[j]] = [draft.photos[j], draft.photos[i]];
  renderPhotos();
  schedule();
}

// ---------------------------------------------------------------- caption & export

function updateCaptionCount() {
  const n = [...draft.caption].length;
  const el = $('caption-count');
  el.textContent = `${n.toLocaleString()} / ${CAPTION_LIMIT.toLocaleString()}`;
  el.classList.toggle('warn', n > CAPTION_LIMIT);
}

async function prepareFiles() {
  const files = [];
  files.push(new File([await toBlob($('cover'), .95)], '01-cover.jpg', { type: 'image/jpeg' }));
  for (const [i, p] of draft.photos.entries()) {
    const c = preparePhoto(await loadBlobImage(p.blob), p.fit);
    files.push(new File([await toBlob(c, .93)], `${String(i + 2).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
  }
  return files;
}

async function exportImages() {
  const button = $('export'), status = $('export-status');
  if (!prepared) {
    button.disabled = true;
    status.textContent = '이미지를 만드는 중…';
    clearTimeout(renderTimer);
    await drawCover();
    prepared = await prepareFiles();
    button.disabled = false;
    $('export-label').textContent = `Save ${prepared.length} to Photos`;
    status.textContent = '준비되었습니다. 버튼을 한 번 더 눌러 저장하세요.';
    return;
  }
  // Share must be called directly from the tap, so the files are prepared beforehand.
  if (navigator.canShare && navigator.canShare({ files: prepared })) {
    try {
      await navigator.share({ files: prepared });
      status.textContent = '공유 시트에서 "이미지 저장"을 고르면 사진 앱에 순서대로 저장됩니다.';
    } catch (e) {
      if (e.name !== 'AbortError') status.textContent = '공유하지 못했습니다: ' + e.message;
    }
    return;
  }
  // Fallback: show the images so each can be long-pressed and saved.
  const box = $('fallback');
  box.replaceChildren();
  for (const f of prepared) {
    const a = document.createElement('a');
    a.href = url(f); a.download = f.name;
    const img = document.createElement('img');
    img.src = a.href; img.alt = f.name;
    a.append(img);
    box.append(a);
  }
  box.hidden = false;
  status.textContent = '이 브라우저는 한 번에 저장을 지원하지 않습니다. 이미지를 길게 눌러 저장하세요.';
}

async function copyCaption() {
  try {
    await navigator.clipboard.writeText(draft.caption);
    toast('캡션을 복사했습니다');
  } catch (_) {
    const t = $('caption');
    t.focus(); t.select();
    toast('캡션을 선택했습니다. 복사를 눌러 주세요');
  }
}

async function finish(message) {
  if (!confirm(message)) return;
  await store.remove(draft.id);
  toast('초안을 지웠습니다');
  showHome();
}

// ---------------------------------------------------------------- drag to pan the window photo

function wireDrag() {
  const canvas = $('cover');
  let drag = null, frame = 0;
  const point = e => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * 1080 / r.width, (e.clientY - r.top) * 1440 / r.height];
  };
  canvas.addEventListener('pointerdown', e => {
    const f = windowFrame(draft);
    if (!f) return;
    const [x, y] = point(e);
    if (x < f.x || x > f.x + f.size || y < f.y || y > f.y + f.size) return;
    checkpoint('drag');
    drag = { dx: x - f.x, dy: y - f.y, id: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic or ended pointer */ }
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const [x, y] = point(e);
    const px = Math.round((x - drag.dx) / 90), py = Math.round((y - drag.dy) / 90);
    const i = locate(draft, px, py);
    if (i < 0 || i === draft.layout) return;
    draft.layout = i;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawCover(); });
  });
  const end = e => { if (drag && e.pointerId === drag.id) { drag = null; schedule(); } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function showTab(name) {
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('new-draft').addEventListener('click', newDraft);
  $('back').addEventListener('click', async () => { clearTimeout(saveTimer); await persistDraft(); showHome(); });
  $('title').addEventListener('input', e => { draft.title = e.target.value; syncDirection(); schedule(); });
  $('direction').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v;
    if (v === undefined || (v === '1') === !!draft.vertical) return;
    checkpoint('direction');
    draft.vertical = v === '1'; draft.layout = 0;
    syncDirection(); schedule();
  });
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('mode').addEventListener('click', e => {
    const m = e.target.closest('button')?.dataset.m;
    if (!m || normalize(draft).mode === m) return;
    checkpoint('mode');
    draft.mode = m; draft.layout = 0;
    syncControls(); schedule();
  });
  const winSlider = (id, key, scale) => $(id).addEventListener('input', e => {
    checkpoint(id);
    draft.window = Object.assign({}, normalize(draft).win, { [key]: +e.target.value / scale });
    if (key === 'n') draft.layout = 0;
    syncControls(); schedule();
  });
  winSlider('win-n', 'n', 1);
  $('title-length').addEventListener('input', e => {
    checkpoint('title-length');
    draft.titleLength = +e.target.value; draft.layout = 0;
    syncControls(); schedule();
  });
  $('title-size').addEventListener('input', e => {
    checkpoint('title-size');
    draft.titleSize = +e.target.value;
    syncControls(); schedule();
  });
  $('size-auto').addEventListener('click', () => {
    if (!draft.titleSize) return;
    checkpoint('size-auto');
    draft.titleSize = 0;
    syncControls(); schedule();
  });
  $('size-manual').addEventListener('click', () => {
    if (draft.titleSize) return;
    checkpoint('size-manual');
    draft.titleSize = +$('title-size').value || 30;
    syncControls(); schedule();
  });
  for (const st of document.querySelectorAll('.stepper')) {
    st.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const input = $(st.dataset.for);
      const v = Math.min(+input.max, Math.max(+input.min, +input.value + +b.dataset.d));
      if (v === +input.value) return;
      input.value = v;
      input.dispatchEvent(new Event('input'));
    });
  }
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) showTab(b.dataset.tab);
  });
  $('copy-caption-2').addEventListener('click', copyCaption);
  for (const b of document.querySelectorAll('.dpad button')) {
    b.addEventListener('click', () => {
      const i = nudge(draft, +b.dataset.dx, +b.dataset.dy);
      if (i < 0) { toast('그쪽으로는 더 옮길 수 없습니다'); return; }
      checkpoint('nudge');
      draft.layout = i; schedule();
    });
  }
  wireDrag();
  $('filters').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.k;
    renderCompositions();
  });
  $('shuffle-tiles').addEventListener('click', () => { checkpoint('shuffle'); draft.seed = seed(); schedule(); });
  $('next-layout').addEventListener('click', () => {
    checkpoint('layout');
    const s = normalize(draft);
    draft.layout = ((draft.layout || 0) + 1) % layouts(s.vertical, s.block, s.length).length;
    schedule();
  });
  $('random-all').addEventListener('click', () => {
    checkpoint('random');
    const comps = catalog.compositions.filter(c => !filter || c.kind === filter);
    draft.composition = comps[Math.floor(Math.random() * comps.length)].id;
    draft.seed = seed();
    draft.layout = Math.floor(Math.random() * 6);
    renderCompositions(); schedule();
  });
  $('photo-input').addEventListener('change', e => { addPhotos([...e.target.files]); e.target.value = ''; });
  $('caption').addEventListener('input', e => {
    draft.caption = e.target.value; updateCaptionCount();
    clearTimeout(saveTimer); saveTimer = setTimeout(persistDraft, 600);
  });
  $('export').addEventListener('click', exportImages);
  $('copy-caption').addEventListener('click', copyCaption);
  $('done').addEventListener('click', () => finish('게시를 마쳤나요? 이 초안을 기기에서 지웁니다.'));
  $('delete').addEventListener('click', () => finish('이 초안을 삭제할까요? 되돌릴 수 없습니다.'));
}

(async () => {
  wire();
  ready = init();
  ready.then(c => { catalog = c; }, () => toast('자원을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'));
  store.persist();
  showHome();
})();
