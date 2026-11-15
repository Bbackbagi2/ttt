import { init, render, language, layouts, preparePhoto, normalize, nudge, locate, windowFrame } from './render.js?v=13';
import * as store from './store.js?v=8';

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
const urls = new Set();       // object URLs made by the editor
const homeUrls = new Set();   // object URLs of the draft thumbnails on the home screen

function url(blob, set = urls) { const u = URL.createObjectURL(blob); set.add(u); return u; }
function releaseUrls(set = urls) { set.forEach(u => URL.revokeObjectURL(u)); set.clear(); }

// ---------------------------------------------------------------- screen size
// The layout is drawn for the iPhone 16 Pro screen (402 x 874 pt). On that screen the fixed
// sizes below are used as they are; on any other screen they scale with the screen height.
//
// iOS home-screen apps (26.1 and later) can give the page less than the full screen and still
// report a bottom safe-area inset; see fitHeight.
const REFERENCE = { width: 402, height: 874, stage: 384 };

// Safe-area insets as numbers, read from a hidden probe sized by env().
function safeAreas() {
  let probe = document.getElementById('safe-probe');
  if (!probe) {
    probe = document.createElement('div');
    probe.id = 'safe-probe';
    document.body.append(probe);
  }
  const r = probe.getBoundingClientRect();
  return { top: Math.round(r.height), bottom: Math.round(r.width) };
}

// Lays the editor out over the area iOS actually shows, measured each time it can change.
function fitHeight() {
  const standalone = !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  const short = Math.min(screen.width, screen.height), long = Math.max(screen.width, screen.height);
  const portrait = matchMedia('(orientation: portrait)').matches;
  const vv = window.visualViewport;
  const top = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
  const h = Math.round(vv ? vv.height : window.innerHeight);
  const reference = short === REFERENCE.width && long === REFERENCE.height;
  const stage = reference ? REFERENCE.stage
    : Math.round(Math.min(460, Math.max(240, REFERENCE.stage * long / REFERENCE.height)));
  const root = document.documentElement.style;
  root.setProperty('--app-top', top + 'px');
  root.setProperty('--app-h', h + 'px');
  root.setProperty('--stage-h', stage + 'px');
  // iOS 26.1+ home-screen apps that draw under the status bar get a page as tall as the screen
  // minus the status bar, yet pinned to the top, so it stops that much short of the bottom (on an
  // iPhone 16 Pro: 874 - 62 = 812). The home indicator is then below the page, and its inset would
  // only lift the tab bar. Measured on device 2026-11-15: inner 812, safe top 62, bottom 34.
  const safe = safeAreas();
  const shortfall = (portrait ? long : short) - (top + h);
  const clipped = standalone && safe.top > 0 && shortfall > 40 && Math.abs(shortfall - safe.top) < 10;
  if (clipped) root.setProperty('--safe-bottom', '0px');
  else root.removeProperty('--safe-bottom');
  document.documentElement.dataset.screen = reference ? 'reference' : 'scaled';
  fitHeight.last = { standalone, screen: `${screen.width}×${screen.height}`, inner: `${innerWidth}×${innerHeight}`,
    visual: vv ? `${Math.round(vv.width)}×${h} @${top}` : '-', client: document.documentElement.clientHeight,
    safe, shortfall, clipped, dpr: devicePixelRatio, stage };
}

// The fixed top bar and tab bar keep their room in the editor as their sizes change.
function watchBars() {
  const root = document.documentElement.style;
  const ro = new ResizeObserver(() => {
    root.setProperty('--bar-h', $('editor').querySelector('.bar').offsetHeight + 'px');
    root.setProperty('--tab-h', $('tabs').offsetHeight + 'px');
  });
  ro.observe($('editor').querySelector('.bar'));
  ro.observe($('tabs'));
}

// What this device reports, for checking the layout on a phone.
function showScreenInfo() {
  fitHeight();
  const i = fitHeight.last, bar = $('tabs').getBoundingClientRect();
  $('screen-info').textContent = [
    `standalone ${i.standalone}`, `screen ${i.screen} · dpr ${i.dpr}`, `inner ${i.inner}`,
    `visual ${i.visual}`, `client height ${i.client}`, `safe top ${i.safe.top} · bottom ${i.safe.bottom}`,
    `shortfall ${i.shortfall} · clipped ${i.clipped}`, `stage ${i.stage}`,
    `status bar ${document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]').content}`,
    navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''),
  ].join('\n');
}

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

// ---------------------------------------------------------------- pictures already posted
// Kept on this device only (localStorage): picture id -> date it was marked used.

const USED_KEY = 'ttt-used';
function usedPictures() {
  try { return JSON.parse(localStorage.getItem(USED_KEY)) || {}; } catch (_) { return {}; }
}
function setUsed(id, on) {
  const m = usedPictures();
  if (on) m[id] = Date.now(); else delete m[id];
  try { localStorage.setItem(USED_KEY, JSON.stringify(m)); } catch (_) { toast('이 브라우저에 저장하지 못했습니다'); }
}
// Unused pictures first; falls back to all of them once every picture has been used.
function pickPicture(comps) {
  const used = usedPictures();
  const fresh = comps.filter(c => !used[c.id]);
  const pool = fresh.length ? fresh : comps;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------- home

// Home: the three draft slots as cover cards (empty ones start a new post), and a strip of
// pictures to start from, unused first.
async function renderHome() {
  const drafts = await store.list();
  $('draft-count').textContent = `${drafts.length} / ${store.LIMIT}`;
  const list = $('slots');
  releaseUrls(homeUrls);
  list.replaceChildren();
  for (let i = 0; i < store.LIMIT; i++) {
    const d = drafts[i];
    const li = document.createElement('li');
    li.className = 'slot' + (d ? '' : ' free');
    const card = document.createElement('button');
    card.className = 'card';
    if (d) {
      const img = document.createElement('img');
      if (d.thumb) img.src = url(d.thumb, homeUrls);
      img.alt = '';
      card.append(img);
      card.setAttribute('aria-label', `${d.title?.trim() || '제목 없는 초안'} 열기`);
      card.addEventListener('click', () => openDraft(d.id));
      const name = document.createElement('strong');
      name.textContent = d.title?.trim() || '제목 없음';
      if (!d.title?.trim()) name.className = 'untitled';
      const when = new Date(d.updated);
      const meta = document.createElement('span');
      meta.className = 'when';
      meta.textContent = `사진 ${d.photos.length} · ${when.getMonth() + 1}.${when.getDate()} ${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}`;
      li.append(card, name, meta);
    } else {
      card.append(icon('plus'), document.createTextNode('New post'));
      card.addEventListener('click', () => newDraft());
      li.append(card);
    }
    list.append(li);
  }
  renderStarters(drafts.length);
}

function renderStarters(count) {
  if (!catalog) return;
  if (count !== undefined) renderStarters.count = count;
  const full = (renderStarters.count ?? 0) >= store.LIMIT;
  const used = usedPictures();
  const comps = [...catalog.compositions].sort((a, b) => !!used[a.id] - !!used[b.id]);
  $('used-count').textContent = `사용 ${catalog.compositions.filter(c => used[c.id]).length} / ${catalog.compositions.length}`;
  const box = $('starters');
  box.replaceChildren(...comps.map(c => {
    const b = document.createElement('button');
    if (used[c.id]) b.className = 'used';
    b.setAttribute('aria-label', `${c.name}로 새 초안` + (used[c.id] ? ' (사용함)' : ''));
    const img = document.createElement('img');
    img.src = 'assets/' + c.thumb; img.alt = ''; img.loading = 'lazy';
    b.append(img);
    if (used[c.id]) {
      const mark = document.createElement('span');
      mark.className = 'used-mark';
      mark.append(icon('check', 'ic sm'));
      b.append(mark);
    }
    b.addEventListener('click', () => {
      if (full) { toast(`초안은 ${store.LIMIT}개까지입니다. 하나를 마치거나 지운 뒤 시작해 주세요.`); return; }
      newDraft(c.id);
    });
    return b;
  }));
}

// Assets load in the background; drafts can be listed before they arrive.
let ready = null;
async function whenReady() {
  if (!catalog) {
    toast('표지 자원을 불러오는 중입니다…');
    catalog = await ready;
  }
}

async function newDraft(composition) {
  await whenReady();
  const comps = catalog.compositions;
  draft = {
    id: uid(), created: Date.now(), updated: Date.now(),
    composition: composition || pickPicture(comps).id,
    title: '', vertical: false, layout: 0, seed: seed(), caption: '', photos: [], thumb: null,
    captionMode: 'single', coverCaption: '',
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
  $('title').value = draft.title;
  $('fallback').hidden = true;
  $('export-status').textContent = '';
  $('saved').textContent = '';
  history = [];
  future = [];
  lastCheck = { key: '', time: 0 };
  behind = { key: null, canvas: null };
  slide = 0;
  slideThumbs.clear();
  showTab('cover');
  syncControls();
  renderCompositions();
  renderPhotos();
  syncCaption();
  schedule();
  enterEditor();
}

// ---------------------------------------------------------------- moving between home and editor
// The editor slides in over the home screen like an iOS page. Opening it adds a history entry, so
// the back button, Safari's back gesture and a swipe from the left edge all lead home the same way.

const editing = () => document.body.classList.contains('editing');

function enterEditor() {
  const ed = $('editor');
  ed.hidden = false;
  $('editor').querySelector('.panels').scrollTop = 0;
  ed.getBoundingClientRect();           // start the slide from off screen
  document.body.classList.add('editing');
  $('home').inert = true;
  if (!window.history.state?.editor) window.history.pushState({ editor: true }, '');
}

// Leaves the editor. `keep` false skips saving (the draft was just deleted).
async function closeEditor(keep = true) {
  if (!editing()) return;
  clearTimeout(saveTimer); clearTimeout(renderTimer);
  $('sheet').hidden = true;
  document.body.classList.remove('editing');
  $('home').inert = false;
  setTimeout(() => { if (!editing()) $('editor').hidden = true; }, 420);
  const d = keep ? draft : null;
  // A change made just before leaving may not be drawn yet; draw it so the thumbnail matches.
  if (d && dirty) { await drawCover(); clearTimeout(saveTimer); }
  if (draft === d || !keep) draft = null;
  if (d) await persistDraft(d);
  await renderHome();
}

function goHome(keep = true) {
  closeEditor(keep);
  if (window.history.state?.editor) window.history.back();
}

function wireNavigation() {
  window.addEventListener('popstate', () => {
    const st = window.history.state || {};
    if (!st.sheet && !$('sheet').hidden) $('sheet').hidden = true;
    if (!st.editor && editing()) closeEditor();
  });
  // Swipe right from the left edge to go back, following the finger.
  const ed = $('editor');
  let s = null;
  ed.addEventListener('touchstart', e => {
    const t = e.touches[0];
    s = e.touches.length === 1 && t.clientX < 24 && $('sheet').hidden ? { x: t.clientX, y: t.clientY, dx: 0, on: false } : null;
  }, { passive: true });
  ed.addEventListener('touchmove', e => {
    if (!s) return;
    const t = e.touches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
    if (!s.on) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) { s = null; return; }
      if (dx < 10) return;
      s.on = true;
      ed.style.transition = 'none';
      $('home').style.transition = 'none';
    }
    s.dx = Math.max(0, dx);
    const k = s.dx / window.innerWidth;
    ed.style.transform = `translateX(${s.dx}px)`;
    $('home').style.transform = `translateX(${-22 * (1 - k)}%)`;
    $('home').style.opacity = String(.35 + .65 * k);
  }, { passive: true });
  const end = () => {
    if (!s?.on) { s = null; return; }
    const far = s.dx > window.innerWidth * .28;
    s = null;
    for (const el of [ed, $('home')]) { el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; }
    if (far) goHome();
  };
  ed.addEventListener('touchend', end);
  ed.addEventListener('touchcancel', end);
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
  $('unmark-used').hidden = !(visible && usedPictures()[item.id]);
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
  for (const b of $('glass-kind').querySelectorAll('button')) b.classList.toggle('on', b.dataset.g === s.win.glass);
  $('title-length').value = s.length; $('length-out').textContent = `${s.length}칸`;
  $('size-auto').classList.toggle('on', !s.size);
  $('size-manual').classList.toggle('on', !!s.size);
  $('size-slider').hidden = !s.size;
  if (s.size) { $('title-size').value = s.size; $('size-out').textContent = `${s.size}px`; }
  $('photo-count').textContent = draft.photos.length || '';
}

let renderTimer = 0, saveTimer = 0, dirty = false;
function schedule() {
  dirty = true;
  prepared = null;
  $('export-label').textContent = 'Prepare images';
  clearTimeout(renderTimer);
  renderTimer = setTimeout(drawCover, 120);
}

async function drawCover() {
  if (!draft) return;
  dirty = false;
  const canvas = $('cover');
  const back = normalize(draft).mode === 'window' ? await behindPhoto() : null;
  const result = await render(canvas, draft, { behind: back });
  $('title-warn').hidden = result.fits;
  if (result.mode === 'picture') showCompName();
  if (!draft.titleSize && result.titleSize) $('title-size').value = result.titleSize;
  if (!$('post').hidden) renderPost();
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

// The save in progress, so deleting a draft can wait for it instead of racing it.
let saving = Promise.resolve();
function persistDraft(d = draft) {
  if (!d) return saving;
  saving = saving.then(() => saveDraft(d), () => saveDraft(d));
  return saving;
}

// The save note shows briefly, then fades so the bar stays clear.
function showSaved(text, stay = false) {
  const el = $('saved');
  el.textContent = text;
  el.classList.remove('gone');
  clearTimeout(showSaved.timer);
  if (!stay) showSaved.timer = setTimeout(() => el.classList.add('gone'), 1600);
}

async function saveDraft(draft) {
  const small = document.createElement('canvas');
  small.width = 162; small.height = 216;
  small.getContext('2d').drawImage($('cover'), 0, 0, 162, 216);
  draft.thumb = await toBlob(small, .8);
  try {
    await store.save(draft);
    showSaved('이 기기에 저장됨');
  } catch (e) {
    showSaved('저장 실패', true);
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
  const used = usedPictures();
  const comps = catalog.compositions.filter(c => !filter || c.kind === filter);
  // Pictures already posted go to the end, in their usual order.
  comps.sort((a, b) => !!used[a.id] - !!used[b.id]);
  for (const c of comps) {
    const b = document.createElement('button');
    b.className = (c.id === draft.composition ? 'on' : '') + (used[c.id] ? ' used' : '');
    b.setAttribute('aria-label', c.name + (used[c.id] ? ' (used)' : ''));
    const img = document.createElement('img');
    img.src = 'assets/' + c.thumb; img.alt = ''; img.loading = 'lazy';
    b.append(img);
    if (used[c.id]) {
      const mark = document.createElement('span');
      mark.className = 'used-mark';
      mark.append(icon('check', 'ic sm'));
      b.append(mark);
    }
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

// One caption for the post, or one per slide (Instagram's "Multiple captions").
const multiple = () => draft.captionMode === 'multiple';
const slideCount = () => 1 + draft.photos.length;
function slideText(i) { return (i === 0 ? draft.coverCaption : draft.photos[i - 1]?.caption) || ''; }
function setSlideText(i, text) {
  if (i === 0) draft.coverCaption = text;
  else if (draft.photos[i - 1]) draft.photos[i - 1].caption = text;
}
const currentCaption = () => multiple() ? slideText(slide) : draft.caption;

function updateCaptionCount() {
  const n = [...currentCaption()].length;
  const el = $('caption-count');
  el.textContent = multiple() ? `${slide + 1}번 슬라이드 · ${n.toLocaleString()}자` : `${n.toLocaleString()} / ${CAPTION_LIMIT.toLocaleString()}`;
  el.classList.toggle('warn', !multiple() && n > CAPTION_LIMIT);
}

function syncCaption() {
  const multi = multiple();
  for (const b of $('caption-mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.c === (multi ? 'multiple' : 'single'));
  const t = $('caption');
  if (document.activeElement !== t || t.value !== currentCaption()) t.value = currentCaption();
  t.placeholder = multi ? `${slide + 1}번 슬라이드 아래에 보일 캡션` : '인스타그램에 붙여넣을 캡션';
  $('caption-hint').textContent = multi
    ? '슬라이드마다 캡션을 따로 씁니다. 위 미리보기를 넘기면 그 장의 캡션으로 바뀝니다.'
    : '게시물 전체에 캡션 하나를 씁니다.';
  $('copy-caption-2-label').textContent = multi ? `Copy ${slide + 1}/${slideCount()}` : 'Copy';
  updateCaptionCount();
  renderPostCaption();
}

// ---------------------------------------------------------------- post preview: an Instagram-style carousel

let slide = 0;
const slideThumbs = new Map();   // photo id:fit -> small JPEG data URL, memory only
let postToken = 0;

async function photoThumb(p) {
  const key = p.id + ':' + p.fit;
  if (!slideThumbs.has(key)) {
    const c = preparePhoto(await loadBlobImage(p.blob), p.fit);
    const s = document.createElement('canvas');
    s.width = 540; s.height = 720;
    s.getContext('2d').drawImage(c, 0, 0, 540, 720);
    slideThumbs.set(key, s.toDataURL('image/jpeg', .85));
  }
  return slideThumbs.get(key);
}

function coverThumb() {
  const s = document.createElement('canvas');
  s.width = 540; s.height = 720;
  s.getContext('2d').drawImage($('cover'), 0, 0, 540, 720);
  return s.toDataURL('image/jpeg', .85);
}

async function slideSources() {
  return [coverThumb(), ...await Promise.all(draft.photos.map(photoThumb))];
}

async function renderPost() {
  const token = ++postToken;
  const sources = await slideSources();
  if (token !== postToken || !draft) return;
  const box = $('carousel');
  box.replaceChildren(...sources.map((src, i) => {
    const img = document.createElement('img');
    img.src = src; img.alt = i ? `${i + 1}번 사진` : '표지';
    return img;
  }));
  slide = Math.min(slide, sources.length - 1);
  box.scrollLeft = slide * box.clientWidth;
  syncSlide();
}

function syncSlide() {
  const n = slideCount();
  $('slide-pill').textContent = `${slide + 1}/${n}`;
  $('slide-pill').hidden = n < 2;
  $('slide-prev').hidden = slide === 0;
  $('slide-next').hidden = slide >= n - 1;
  const dots = $('dots');
  dots.replaceChildren();
  if (n > 1) for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    if (i === slide) d.className = 'on';
    dots.append(d);
  }
  syncCaption();
}

function renderPostCaption() {
  const p = $('post-caption');
  const name = document.createElement('strong');
  name.textContent = 'ttt';
  const text = document.createElement('span');
  const value = currentCaption().trim();
  text.textContent = value || (multiple() ? '이 슬라이드의 캡션이 비어 있습니다' : '캡션이 비어 있습니다');
  text.className = value ? '' : 'none';
  p.replaceChildren(name, text);
}

function goSlide(step) {
  const box = $('carousel');
  box.scrollTo({ left: (slide + step) * box.clientWidth, behavior: 'smooth' });
}

// ---------------------------------------------------------------- full post preview (feed and profile grid)

let feedSlide = 0;

async function openPreview() {
  clearTimeout(renderTimer);
  await drawCover();
  const sources = await slideSources();
  const box = $('feed-carousel');
  box.replaceChildren(...sources.map((src, i) => {
    const img = document.createElement('img');
    img.src = src; img.alt = i ? `${i + 1}번 사진` : '표지';
    return img;
  }));
  const grid = $('grid');
  grid.replaceChildren();
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('div');
    if (i === 0) {
      const img = document.createElement('img');
      img.src = sources[0]; img.alt = '이번 표지';
      cell.append(img);
      if (sources.length > 1) cell.append(icon('photos', 'ic sm multi'));
    } else cell.className = 'past';
    grid.append(cell);
  }
  $('sheet').hidden = false;
  if (!window.history.state?.sheet) window.history.pushState({ editor: true, sheet: true }, '');
  feedSlide = 0;
  box.scrollLeft = 0;
  showPreviewMode('feed');
  syncFeed();
}

function showPreviewMode(v) {
  for (const b of $('preview-mode').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === v);
  $('feed').hidden = v !== 'feed';
  $('grid').hidden = v !== 'grid';
  $('preview-note').textContent = v === 'feed'
    ? '피드에서 보일 모습입니다. 넘기면 다음 장과 그 장의 캡션이 보입니다. 실제 앱 화면과 조금 다를 수 있습니다.'
    : '프로필 격자에서 이번 표지가 놓일 자리입니다(3:4 격자 기준). 회색 칸은 이전 게시물 자리이며, 이전 게시물은 저장하지 않습니다.';
}

function syncFeed() {
  const n = slideCount();
  $('feed-pill').textContent = `${feedSlide + 1}/${n}`;
  $('feed-pill').hidden = n < 2;
  const dots = $('feed-dots');
  dots.replaceChildren();
  if (n > 1) for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    if (i === feedSlide) d.className = 'on';
    dots.append(d);
  }
  const p = $('feed-caption');
  const name = document.createElement('strong');
  name.textContent = 'ttt';
  const text = (multiple() ? slideText(feedSlide) : draft.caption).trim();
  const body = document.createElement('span');
  body.textContent = text || '(캡션 없음)';
  if (!text) body.className = 'none';
  p.replaceChildren(name, body);
  p.classList.add('clamp');
  requestAnimationFrame(() => { $('feed-more').hidden = p.scrollHeight <= p.clientHeight + 1; });
}

async function renderCopies() {
  const multi = multiple();
  $('copy-caption').hidden = multi;
  const list = $('caption-copies');
  list.hidden = !multi;
  if (!multi) return;
  const sources = await slideSources();
  list.replaceChildren();
  sources.forEach((src, i) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = src; img.alt = '';
    const text = document.createElement('span');
    const value = slideText(i).trim();
    text.className = 'txt' + (value ? '' : ' none');
    text.textContent = `${i + 1}. ` + (value ? value.split('\n')[0] : '(비어 있음)');
    const b = document.createElement('button');
    b.append(icon('copy'));
    b.setAttribute('aria-label', `Copy caption ${i + 1}`);
    b.disabled = !value;
    b.addEventListener('click', () => copyText(slideText(i), `${i + 1}번 캡션을 복사했습니다`));
    li.append(img, text, b);
    list.append(li);
  });
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

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch (_) {
    showTab('caption');
    const t = $('caption');
    t.focus(); t.select();
    toast('캡션을 선택했습니다. 복사를 눌러 주세요');
  }
}
const copyCaption = () => copyText(currentCaption(), multiple() ? `${slide + 1}번 캡션을 복사했습니다` : '캡션을 복사했습니다');

// After posting, offer to mark the cover picture as used so it moves to the end of the list.
async function posted() {
  if (!confirm('게시를 마쳤나요? 이 초안을 기기에서 지웁니다.')) return;
  const item = normalize(draft).mode === 'picture' && catalog.compositions.find(c => c.id === draft.composition);
  if (item && !usedPictures()[item.id]
      && confirm(`이번 표지 그림("${item.name}")을 사용한 그림으로 표시할까요?\n표시하면 그림 목록 맨 아래로 가고 체크가 붙습니다.`)) {
    setUsed(item.id, true);
  }
  await discard();
}

// Deletes the open draft: stops autosave first, waits for a save already running, then removes it.
async function discard() {
  clearTimeout(saveTimer); clearTimeout(renderTimer);
  const id = draft.id;
  draft = null;
  await saving.catch(() => {});
  await store.remove(id);
  toast('초안을 지웠습니다');
  goHome(false);
}

async function finish(message) {
  if (!confirm(message)) return;
  await discard();
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
  const post = name === 'caption';
  $('cover').hidden = post;
  $('post').hidden = !post;
  if (post) renderPost();
  if (name === 'export') renderCopies();
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('back').addEventListener('click', () => goHome());
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
  $('glass-kind').addEventListener('click', e => {
    const kind = e.target.closest('button')?.dataset.g;
    if (!kind || normalize(draft).win.glass === kind) return;
    checkpoint('glass');
    draft.window = Object.assign({}, normalize(draft).win, { glass: kind });
    syncControls(); schedule();
  });
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
    draft.composition = pickPicture(comps).id;
    draft.seed = seed();
    draft.layout = Math.floor(Math.random() * 6);
    renderCompositions(); schedule();
  });
  $('photo-input').addEventListener('change', e => { addPhotos([...e.target.files]); e.target.value = ''; });
  $('caption-mode').addEventListener('click', e => {
    const c = e.target.closest('button')?.dataset.c;
    if (!c || c === (draft.captionMode || 'single')) return;
    // Starting multiple captions with an empty set carries the single caption over to the first slide.
    if (c === 'multiple' && !draft.coverCaption && !draft.photos.some(p => p.caption)) draft.coverCaption = draft.caption;
    draft.captionMode = c;
    syncCaption();
    clearTimeout(saveTimer); saveTimer = setTimeout(persistDraft, 600);
  });
  $('carousel').addEventListener('scroll', e => {
    const i = Math.round(e.target.scrollLeft / Math.max(1, e.target.clientWidth));
    if (i !== slide && i >= 0 && i < slideCount()) { slide = i; syncSlide(); }
  }, { passive: true });
  $('open-preview').addEventListener('click', openPreview);
  $('close-preview').addEventListener('click', () => {
    if (window.history.state?.sheet) window.history.back(); else $('sheet').hidden = true;
  });
  $('preview-mode').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v;
    if (v) showPreviewMode(v);
  });
  $('feed-carousel').addEventListener('scroll', e => {
    const i = Math.round(e.target.scrollLeft / Math.max(1, e.target.clientWidth));
    if (i !== feedSlide && i >= 0 && i < slideCount()) { feedSlide = i; syncFeed(); }
  }, { passive: true });
  $('feed-more').addEventListener('click', () => { $('feed-caption').classList.remove('clamp'); $('feed-more').hidden = true; });
  $('slide-prev').addEventListener('click', () => goSlide(-1));
  $('slide-next').addEventListener('click', () => goSlide(1));
  $('caption').addEventListener('input', e => {
    if (multiple()) setSlideText(slide, e.target.value); else draft.caption = e.target.value;
    updateCaptionCount(); renderPostCaption();
    clearTimeout(saveTimer); saveTimer = setTimeout(persistDraft, 600);
  });
  $('export').addEventListener('click', exportImages);
  $('copy-caption').addEventListener('click', copyCaption);
  $('done').addEventListener('click', posted);
  $('unmark-used').addEventListener('click', () => {
    const item = catalog.compositions.find(c => c.id === draft.composition);
    if (!item || !confirm(`"${item.name}"의 사용 표시를 지울까요? 목록에서 원래 자리로 돌아갑니다.`)) return;
    setUsed(item.id, false);
    renderCompositions();
  });
  $('delete').addEventListener('click', () => finish('이 초안을 삭제할까요? 되돌릴 수 없습니다.'));
}

(async () => {
  // A reload while editing leaves an editor history entry behind; start from home.
  if (window.history.state) window.history.replaceState(null, '');
  fitHeight();
  window.addEventListener('resize', fitHeight);
  window.visualViewport?.addEventListener('resize', fitHeight);
  window.addEventListener('orientationchange', () => setTimeout(fitHeight, 300));
  window.addEventListener('pageshow', fitHeight);
  watchBars();
  window.addEventListener('scroll', () => {
    $('home').querySelector('.home-head').classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });
  $('screen-note').addEventListener('toggle', e => { if (e.target.open) showScreenInfo(); });
  wire();
  wireNavigation();
  ready = init();
  ready.then(c => { catalog = c; renderStarters(); }, () => toast('자원을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'));
  store.persist();
  renderHome();
})();
