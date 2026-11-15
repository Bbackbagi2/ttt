import { init, render, language, layouts, preparePhoto, normalize, nudge, locate, windowFrame, memoryStats } from './render.js?v=14';
import * as store from './store.js?v=9';

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
const trashUrls = new Set();  // object URLs of the thumbnails on the trash page

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

// True while a text field has focus (the keyboard is up).
const typing = () => document.body.classList.contains('typing');

// Lays the editor out over the area iOS actually shows, measured each time it can change.
// Measured on an iPhone 16 Pro home-screen app (iOS 27.2, 2026-11-15): inner 812 of 874, safe
// area top 0 / bottom 34 with the opaque status bar.
function fitHeight() {
  const standalone = !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  const short = Math.min(screen.width, screen.height), long = Math.max(screen.width, screen.height);
  const portrait = matchMedia('(orientation: portrait)').matches;
  const vv = window.visualViewport;
  // The layout viewport, not the visual one: the keyboard shrinks the visual viewport, and
  // following it made the tab bar ride up with the keyboard. While typing, keep the last size.
  if (typing() && fitHeight.last) return;
  const top = 0;
  const h = Math.round(window.innerHeight);
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
  fitHeight.last = { h, top };
}

// The fixed top bar and tab bar keep their room in the editor as their sizes change.
function watchBars() {
  const root = document.documentElement.style;
  const ro = new ResizeObserver(() => {
    root.setProperty('--bar-h', $('editor').querySelector('.bar').offsetHeight + 'px');
    root.setProperty('--tab-h', $('tabs').offsetHeight + 'px');
    springPill(tabIndex(currentTab), true);
  });
  ro.observe($('editor').querySelector('.bar'));
  ro.observe($('tabs'));
}

// A short message; with an action (like Undo) it stays a little longer and offers a button.
function toast(text, action) {
  const t = $('toast'), b = $('toast-action');
  $('toast-text').textContent = text;
  b.hidden = !action;
  b.onclick = null;
  if (action) {
    b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.run(); };
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, action ? 5000 : 2200);
}

const mb = n => (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';

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

// ---------------------------------------------------------------- settings
// Kept on this device only. New options go in DEFAULTS and get a row on the settings page.

const SETTINGS_KEY = 'ttt-settings';
const DEFAULTS = { haptics: true, dev: false, beginner: false, toured: {} };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); } catch (_) { /* first run */ }
// Beginner mode shows the on-screen help (elements marked .guide) and a guide tour per screen.
function applyBeginner() { document.body.classList.toggle('beginner', !!settings.beginner); }

// ---------------------------------------------------------------- guide tour (beginner mode)
// A spotlight ring moves from one control to the next with a short note under or above it.

const TOURS = {
  home: [
    ['#slots .slot:last-child .card', '여기서 새 게시물을 시작합니다. 초안은 이 기기에만 5개까지 보관됩니다.'],
    ['#slots', '초안 카드를 누르면 이어서 편집하고, 길게 누르면 열기·휴지통 메뉴가 나옵니다.'],
    ['#open-settings', '설정입니다. 초보자 모드, 휴지통, 자주 묻는 질문이 여기 있습니다.'],
  ],
  editor: [
    ['#cover', '표지 미리보기입니다. 창(Window)을 고르면 미리보기에서 창을 끌어 옮길 수 있습니다.'],
    ['#mode', 'Picture는 그림 타일, Window는 다음 장 사진이 비쳐 보이는 김 서린 유리창입니다.'],
    ['#tabs', '제목·사진·캡션·내보내기로 넘어가는 메뉴입니다. 누르거나 가로로 문질러 넘깁니다.'],
    ['#open-preview', '인스타그램에 올렸을 때의 모습을 미리 봅니다.'],
    ['.bar .history', '바꾼 표지 설정을 되돌리거나 다시 실행합니다.'],
  ],
};

function maybeTour(name) {
  if (!settings.beginner || settings.toured?.[name] || !$('coach').hidden) return;
  const steps = TOURS[name]
    .map(([sel, text]) => ({ el: document.querySelector(sel), text }))
    .filter(st => st.el && st.el.getClientRects().length);
  if (!steps.length) return;
  let i = 0;
  const ring = $('coach').querySelector('.coach-ring'), bubble = $('coach').querySelector('.coach-bubble');
  const place = () => {
    const r = steps[i].el.getBoundingClientRect(), pad = 6;
    const top = Math.max(2, r.top - pad), left = Math.max(2, r.left - pad);
    const right = Math.min(window.innerWidth - 2, r.right + pad), bottom = Math.min(window.innerHeight - 2, r.bottom + pad);
    Object.assign(ring.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    $('coach-text').textContent = steps[i].text;
    $('coach-step').textContent = `${i + 1} / ${steps.length}`;
    $('coach-next').textContent = i === steps.length - 1 ? 'Done' : 'Next';
    const below = r.bottom + 16 + 150 < window.innerHeight;
    bubble.style.top = below ? `${r.bottom + 16}px` : '';
    bubble.style.bottom = below ? '' : `${window.innerHeight - r.top + 16}px`;
  };
  const finish = () => {
    $('coach').hidden = true;
    settings.toured = { ...settings.toured, [name]: true };
    saveSettings();
  };
  $('coach-next').onclick = () => { tick(); if (++i < steps.length) place(); else finish(); };
  $('coach-skip').onclick = finish;
  $('coach').hidden = false;
  place();
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { toast('설정을 저장하지 못했습니다'); }
}

// Help: questions and answers, collected here as they come up.
const FAQ = [
  ['게시는 어떻게 하나요?',
    'Export 탭에서 이미지를 사진 앱에 저장하고, 캡션을 복사해 인스타그램에 붙여넣습니다. 게시한 뒤 Mark as posted를 누르면 초안이 정리되고, 원하면 쓴 그림에 사용 표시가 붙습니다.'],
  ['창(Window)은 무엇인가요?',
    '표지 벽에 낸 김 서린 유리 타일입니다. 다음 장(본문 첫 사진)의 같은 자리가 비쳐 보여서, 표지에서 넘기면 사진이 이어집니다. 유리는 Tile과 Block 중에서 고릅니다.'],
  ['초안은 어디에 저장되나요?',
    `초안은 최대 ${store.LIMIT}개까지 이 기기의 이 앱 안에만 저장되고, 서버나 iCloud로 보내지 않습니다. 홈 화면 앱을 지우면 초안도 함께 지워질 수 있고, 홈 화면 앱과 Safari 탭은 초안을 따로 보관합니다. 지운 초안은 휴지통에 ${store.TRASH_DAYS}일 동안 보관됩니다. 사진 원본은 사진 앱에 그대로 있습니다.`],
];

function settingsView(view) {
  $('settings-main').hidden = view !== 'main';
  $('settings-help').hidden = view !== 'help';
  $('settings-trash').hidden = view !== 'trash';
  $('settings-title').textContent = { help: '자주 묻는 질문', trash: '휴지통' }[view] || 'Settings';
  if (view === 'trash') renderTrash();
  if (view === 'main') store.listTrash().then(t => { $('trash-count').textContent = t.length || ''; });
  $('settings').querySelector('.page-body').scrollTop = 0;
}

async function renderTrash() {
  const items = await store.listTrash();
  $('trash-count').textContent = items.length || '';
  $('trash-empty').hidden = items.length > 0;
  $('empty-trash').hidden = !items.length;
  releaseUrls(trashUrls);
  $('trash-list').replaceChildren(...items.map(d => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    if (d.thumb) img.src = url(d.thumb, trashUrls);
    img.alt = '';
    const meta = document.createElement('span');
    meta.className = 'trash-meta';
    const name = document.createElement('strong');
    name.textContent = d.title?.trim() || '제목 없음';
    const left = Math.max(0, Math.ceil((d.deleted + store.TRASH_DAYS * 864e5 - Date.now()) / 864e5));
    const when = document.createElement('span');
    when.textContent = `${left}일 뒤 삭제 · 사진 ${d.photos.length}`;
    meta.append(name, when);
    const back = document.createElement('button');
    back.className = 'btn';
    back.textContent = 'Restore';
    back.addEventListener('click', async () => {
      try { await store.restore(d.id); } catch (e) { toast(e.message); return; }
      toast('초안을 되살렸습니다'); renderTrash(); renderHome();
    });
    const del = document.createElement('button');
    del.className = 'icon-btn danger';
    del.setAttribute('aria-label', 'Delete forever');
    del.append(icon('trash'));
    del.addEventListener('click', async () => {
      if (!confirm(`"${name.textContent}"을(를) 완전히 삭제할까요? 되돌릴 수 없습니다.`)) return;
      await store.purge(d.id); renderTrash();
    });
    li.append(img, meta, back, del);
    return li;
  }));
}

function renderSettings() {
  $('opt-haptics').checked = settings.haptics;
  $('opt-beginner').checked = settings.beginner;
  $('opt-dev').checked = settings.dev;
  $('dev-info').hidden = !settings.dev;
  liveDevInfo(settings.dev);
  $('faq').replaceChildren(...FAQ.map(([q, a]) => {
    const d = document.createElement('details');
    d.className = 'faq-item';
    const sm = document.createElement('summary');
    sm.textContent = q;
    const p = document.createElement('p');
    p.textContent = a;
    d.append(sm, p);
    return d;
  }));
}

// Developer info, refreshed while it is on screen: this device's layout numbers, the storage
// the app holds, and an estimate of the image memory it keeps (iOS gives pages no heap figure).
let devTimer = 0;
function liveDevInfo(on) {
  clearInterval(devTimer);
  if (on) { renderDevInfo(); devTimer = setInterval(renderDevInfo, 1500); }
}

function editorMemory() {
  let n = 0;
  for (const src of slideThumbs.values()) n += src.length * .75;          // base64 JPEG data URLs
  if (behind.canvas) n += behind.canvas.width * behind.canvas.height * 4;
  n += 1080 * 1440 * 4;                                                    // the cover canvas
  return n;
}

async function renderDevInfo() {
  const standalone = !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  const safe = safeAreas();
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '-';
  const build = document.querySelector('script[src*="app.js"]')?.getAttribute('src').split('?v=')[1] || '-';
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const use = await store.usage().catch(() => null);
  let local = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); local += (k.length + (localStorage.getItem(k) || '').length) * 2; } } catch (_) { /* blocked */ }
  const heap = performance.memory ? `${mb(performance.memory.usedJSHeapSize)} / ${mb(performance.memory.jsHeapSizeLimit)}` : 'n/a (iOS)';
  const mem = memoryStats();
  if ($('dev-info').hidden) return;
  $('dev-info').textContent = [
    `build v${build} · ${new Date().toLocaleTimeString('ko-KR')}`,
    '— storage',
    est ? `used ${mb(est.usage || 0)} of ${mb(est.quota || 0)}` : 'used n/a',
    use ? `drafts ${use.drafts} · ${mb(use.draftBytes)}` : '',
    use ? `trash ${use.trash} · ${mb(use.trashBytes)}` : '',
    `localStorage ${(local / 1024).toFixed(1)} KB`,
    '— memory (estimate)',
    `renderer images ${mb(mem.total)} (assets ${mb(mem.assets)}, pictures ${mem.pictures})`,
    `editor images ${mb(editorMemory())}`,
    `JS heap ${heap}`,
    '— screen',
    `standalone ${standalone}`,
    `screen ${screen.width}×${screen.height} · dpr ${devicePixelRatio}`,
    `inner ${innerWidth}×${innerHeight}`,
    `safe top ${safe.top} · bottom ${safe.bottom}`,
    `app ${css('--app-h')} · stage ${css('--stage-h')} · tab ${css('--tab-h')}`,
    `status bar ${document.querySelector('meta[name=apple-mobile-web-app-status-bar-style]').content}`,
    navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''),
  ].join('\n');
}

function openSettings() {
  renderSettings();
  settingsView('main');
  const page = $('settings');
  page.hidden = false;
  page.getBoundingClientRect();
  document.body.classList.add('in-settings');
  $('home').inert = true;
  window.history.pushState({ settings: 'main' }, '');
}

function closeSettings() {
  if (!document.body.classList.contains('in-settings')) return;
  liveDevInfo(false);
  setTimeout(() => maybeTour('home'), 450);
  document.body.classList.remove('in-settings');
  $('home').inert = false;
  setTimeout(() => { if (!document.body.classList.contains('in-settings')) $('settings').hidden = true; }, 420);
}

function wireSettings() {
  $('open-settings').addEventListener('click', openSettings);
  $('settings-back').addEventListener('click', () => {
    if (window.history.state?.settings) window.history.back();
    else closeSettings();
  });
  $('open-trash').addEventListener('click', () => {
    settingsView('trash');
    window.history.pushState({ settings: 'trash' }, '');
  });
  $('empty-trash').addEventListener('click', async () => {
    const n = (await store.listTrash()).length;
    if (!n || !confirm(`휴지통의 초안 ${n}개를 완전히 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await store.emptyTrash(); renderTrash();
  });
  $('open-help').addEventListener('click', () => {
    settingsView('help');
    window.history.pushState({ settings: 'help' }, '');
  });
  $('opt-haptics').addEventListener('change', e => { settings.haptics = e.target.checked; saveSettings(); });
  $('opt-beginner').addEventListener('change', e => {
    settings.beginner = e.target.checked;
    if (settings.beginner) settings.toured = {};   // turning it on replays the guide tours
    saveSettings();
    applyBeginner();
    toast(settings.beginner ? '도움말과 사용법 안내를 보여 줍니다' : '도움말을 숨깁니다');
  });
  $('opt-dev').addEventListener('change', e => {
    settings.dev = e.target.checked;
    saveSettings();
    $('dev-info').hidden = !settings.dev;
    liveDevInfo(settings.dev);
  });
}

// ---------------------------------------------------------------- home

// Press and hold: fires after half a second unless the finger moves or lifts first.
function onLongPress(el, fn) {
  let timer = 0, x = 0, y = 0;
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerdown', e => {
    x = e.clientX; y = e.clientY;
    timer = setTimeout(() => { tick(); fn(); }, 480);
  });
  el.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => el.addEventListener(t, cancel));
  el.addEventListener('contextmenu', e => e.preventDefault());
}

// The action sheet for a draft card (press and hold on home).
function showActions(d) {
  $('actions-title').textContent = d.title?.trim() || '제목 없는 초안';
  const close = () => { $('actions').hidden = true; };
  $('action-open').onclick = () => { close(); openDraft(d.id); };
  $('action-trash').onclick = () => { close(); trashDraft(d.id); };
  $('action-cancel').onclick = close;
  $('actions').querySelector('.actions-backdrop').onclick = close;
  $('actions').hidden = false;
}

// Home: the drafts as cover cards, and one New post card after them while there is room.
async function renderHome() {
  const drafts = await store.list();
  $('draft-count').textContent = `${drafts.length} / ${store.LIMIT}`;
  const list = $('slots');
  releaseUrls(homeUrls);
  list.replaceChildren();
  // The drafts, then one New post card after the last while there is room.
  const cards = drafts.length < store.LIMIT ? drafts.length + 1 : drafts.length;
  for (let i = 0; i < cards; i++) {
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
      card.addEventListener('click', () => { if (!card.pressed) openDraft(d.id); card.pressed = false; });
      onLongPress(card, () => { card.pressed = true; showActions(d); });
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
  if (!editing() && !document.body.classList.contains('in-settings')) maybeTour('home');
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
  springPill(tabIndex(currentTab), true);
  document.body.classList.add('editing');
  $('home').inert = true;
  if (!window.history.state?.editor) window.history.pushState({ editor: true }, '');
  setTimeout(() => { if (editing()) maybeTour('editor'); }, 450);
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
    if (!st.settings) closeSettings();
    else if (st.settings === 'main' && $('settings-main').hidden) settingsView('main');
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

// Pastes the clipboard at the cursor of a field, like a text editor's Paste.
async function pasteInto(field) {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch (_) {
    field.focus();
    toast('길게 눌러 붙여넣기를 써 주세요');
    return;
  }
  if (!text) { toast('클립보드가 비어 있습니다'); return; }
  if (field.tagName === 'INPUT') text = text.replace(/\s*\n\s*/g, ' ');
  const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, 'end');
  field.dispatchEvent(new Event('input'));
  toast('붙여넣었습니다');
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
  await discard('게시 완료. 초안은 휴지통에 10일 보관됩니다');
}

// Moves the open draft to the trash: stops autosave first, waits for a save already running.
async function discard(message = '휴지통으로 옮겼습니다') {
  clearTimeout(saveTimer); clearTimeout(renderTimer);
  const id = draft.id;
  draft = null;
  await saving.catch(() => {});
  await trashDraft(id, message);
  goHome(false);
}

// Trash with an Undo, from the editor or a card on home.
async function trashDraft(id, message = '휴지통으로 옮겼습니다') {
  await store.trash(id);
  if (!editing()) renderHome();
  toast(message, {
    label: '되돌리기',
    run: async () => {
      try { await store.restore(id); } catch (e) { toast(e.message); return; }
      renderHome();
      toast('초안을 되살렸습니다');
    },
  });
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

// ---------------------------------------------------------------- tab slider
// The tab bar is a slider: a pill glides between the tabs on a spring, and a finger dragged
// across the bar pulls the pill like a magnet toward the nearest tab, ticking (iOS haptic) and
// switching as it crosses from one tab to the next.

const tabButtons = () => [...$('tabs').querySelectorAll('button')];
const tabIndex = name => tabButtons().findIndex(b => b.dataset.tab === name);
const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let currentTab = 'cover';
const pill = { x: 0, v: 0, w: 0, target: 0, tw: 0, raf: 0 };

function paintPill() {
  const el = $('tab-pill');
  const stretch = Math.min(18, Math.abs(pill.v) * .012);    // a little longer while it flies
  el.style.width = (pill.w + stretch) + 'px';
  el.style.transform = `translateX(${pill.x - (pill.v > 0 ? stretch : 0)}px)`;
}

function stepPill() {
  const dt = 1 / 60, k = 520, c = 31;                       // spring stiffness and damping
  pill.v += (k * (pill.target - pill.x) - c * pill.v) * dt;
  pill.x += pill.v * dt;
  pill.w += (pill.tw - pill.w) * .3;
  if (Math.abs(pill.target - pill.x) < .3 && Math.abs(pill.v) < 4) {
    Object.assign(pill, { x: pill.target, v: 0, w: pill.tw, raf: 0 });
    paintPill();
    return;
  }
  paintPill();
  pill.raf = requestAnimationFrame(stepPill);
}

function springPill(i, instant = false) {
  const b = tabButtons()[i];
  if (!b || !b.offsetWidth) return;
  pill.target = b.offsetLeft; pill.tw = b.offsetWidth;
  if (instant || stillMotion() || !pill.w) {
    cancelAnimationFrame(pill.raf);
    Object.assign(pill, { x: pill.target, v: 0, w: pill.tw, raf: 0 });
    paintPill();
  } else if (!pill.raf) pill.raf = requestAnimationFrame(stepPill);
}

// iOS gives Safari no vibration API, but toggling a native switch control plays the system
// haptic tick (iOS 18 and later). A hidden one is clicked on each snap.
function tick() {
  if (!settings.haptics) return;
  try { $('haptic').click(); } catch (_) { /* no haptics here */ }
}

function wireTabSlider() {
  const bar = $('tabs');
  let drag = null;
  bar.addEventListener('pointerdown', e => {
    drag = { x0: e.clientX, on: false, i: tabIndex(currentTab), id: e.pointerId };
  });
  bar.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) {
      if (Math.abs(e.clientX - drag.x0) < 8) return;
      drag.on = true;
      try { bar.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
      cancelAnimationFrame(pill.raf); pill.raf = 0;
    }
    const fx = e.clientX - bar.getBoundingClientRect().left;
    const items = tabButtons().map((b, i) => ({ i, x: b.offsetLeft, w: b.offsetWidth, c: b.offsetLeft + b.offsetWidth / 2 }));
    const near = items.reduce((a, b) => (Math.abs(b.c - fx) < Math.abs(a.c - fx) ? b : a));
    // Magnet: the closer the finger is to a tab's centre, the harder the pill is pulled onto it.
    const d = fx - near.c, pull = Math.exp(-(d * d) / (2 * (near.w * .3) ** 2));
    const centre = fx - d * .8 * pull;
    pill.v = (centre - near.w / 2 - pill.x) * 60;
    pill.x = Math.min(items.at(-1).x, Math.max(items[0].x, centre - near.w / 2));
    pill.w = pill.tw = near.w;
    paintPill();
    if (near.i !== drag.i) {
      drag.i = near.i;
      tick();
      showTab(tabButtons()[near.i].dataset.tab, { glide: false });
    }
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const was = drag.on;
    drag = null;
    if (was) { pill.v = 0; springPill(tabIndex(currentTab)); }
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
}

function showTab(name, { glide = true } = {}) {
  const from = tabIndex(currentTab), to = tabIndex(name);
  const changed = name !== currentTab;
  currentTab = name;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of document.querySelectorAll('[data-panel]')) {
    p.hidden = p.dataset.panel !== name;
    // The new panel slides in from the side it comes from.
    if (!p.hidden && changed && !stillMotion()) {
      p.classList.remove('from-left', 'from-right');
      void p.offsetWidth;
      p.classList.add(to > from ? 'from-right' : 'from-left');
    }
  }
  if (glide) springPill(to);
  const post = name === 'caption';
  $('cover').hidden = post;
  $('post').hidden = !post;
  if (post) renderPost();
  if (name === 'export') renderCopies();
}

// ---------------------------------------------------------------- wiring

function wire() {
  $('back').addEventListener('click', () => goHome());
  // Korean is typed through composition; redrawing the cover mid-syllable stalls the keyboard and
  // drops letters. Keep the text, and redraw once the syllable is done and typing pauses.
  let composing = false;
  const titleChanged = () => {
    draft.title = $('title').value;
    syncDirection();
    if (composing) return;
    prepared = null;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(drawCover, 350);
  };
  $('title').addEventListener('compositionstart', () => { composing = true; });
  $('title').addEventListener('compositionend', () => { composing = false; titleChanged(); });
  $('title').addEventListener('input', titleChanged);
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
    if (!b) return;
    if (b.dataset.tab !== currentTab) tick();
    showTab(b.dataset.tab);
  });
  wireTabSlider();
  $('copy-caption-2').addEventListener('click', copyCaption);
  $('paste-caption').addEventListener('click', () => pasteInto($('caption')));
  $('paste-title').addEventListener('click', () => pasteInto($('title')));
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
  // Recoverable for 10 days and undoable at once, so no confirmation is asked.
  $('delete').addEventListener('click', () => discard());
}

(async () => {
  // A reload while editing leaves an editor history entry behind; start from home.
  if (window.history.state) window.history.replaceState(null, '');
  fitHeight();
  window.addEventListener('resize', fitHeight);
  window.addEventListener('orientationchange', () => setTimeout(fitHeight, 300));
  window.addEventListener('pageshow', fitHeight);
  watchBars();
  // While a text field is focused the tab bar steps aside, so it never rides on the keyboard.
  const isField = el => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'));
  document.addEventListener('focusin', e => { if (isField(e.target)) document.body.classList.add('typing'); });
  document.addEventListener('focusout', e => {
    if (!isField(e.target)) return;
    setTimeout(() => {
      if (isField(document.activeElement)) return;
      document.body.classList.remove('typing');
      fitHeight();
    }, 80);
  });
  window.addEventListener('scroll', () => {
    $('home').querySelector('.home-head').classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });

  wire();
  wireNavigation();
  wireSettings();
  ready = init();
  ready.then(c => { catalog = c; }, () => toast('자원을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'));
  applyBeginner();
  store.persist();
  store.sweepTrash().catch(() => {});
  renderHome();
})();
