import { init, render, language, layouts, preparePhoto } from './render.js?v=1';
import * as store from './store.js?v=1';

const $ = id => document.getElementById(id);
const CAPTION_LIMIT = 2200;
let catalog = null;
let draft = null;
let filter = '';
let prepared = null;          // files ready to share for the current draft state
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
    b.append(img, meta);
    b.addEventListener('click', () => openDraft(d.id));
    li.append(b);
    list.append(li);
  }
}

async function newDraft() {
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
  syncDirection();
  renderCompositions();
  renderPhotos();
  updateCaptionCount();
  schedule();
}

let renderTimer = 0, saveTimer = 0;
function schedule() {
  prepared = null;
  $('export').textContent = '이미지 준비';
  clearTimeout(renderTimer);
  renderTimer = setTimeout(drawCover, 120);
}

async function drawCover() {
  if (!draft) return;
  const canvas = $('cover');
  const result = await render(canvas, draft);
  $('title-warn').hidden = result.fits;
  $('comp-name').textContent = result.item.name;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistDraft, 500);
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
  $('direction').hidden = !ko;
  $('lang').textContent = !text ? '제목 없이 만들기' : ko ? '한국어 · 가로 또는 세로' : '영어 · 가로';
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
      draft.composition = c.id;
      grid.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      schedule();
    });
    grid.append(b);
  }
  for (const b of $('filters').querySelectorAll('button')) b.classList.toggle('on', b.dataset.k === filter);
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
  schedule();
}

async function renderPhotos() {
  const list = $('photos');
  list.replaceChildren();
  $('photo-count').textContent = draft.photos.length ? `${draft.photos.length}장` : '';
  for (const [i, p] of draft.photos.entries()) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'num'; num.textContent = i + 2;
    const img = document.createElement('img');
    img.alt = '';
    const tools = document.createElement('div');
    tools.className = 'tools';
    const button = (label, fn, disabled = false) => {
      const b = document.createElement('button');
      b.textContent = label; b.disabled = disabled;
      b.addEventListener('click', fn);
      tools.append(b);
    };
    button(p.fit === 'crop' ? '자르기' : '여백', () => { p.fit = p.fit === 'crop' ? 'pad' : 'crop'; renderPhotos(); schedule(); });
    button('↑', () => { move(i, -1); }, i === 0);
    button('↓', () => { move(i, 1); }, i === draft.photos.length - 1);
    button('✕', () => { draft.photos.splice(i, 1); renderPhotos(); schedule(); });
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
    button.textContent = `사진 앱에 저장 (${prepared.length}장)`;
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

// ---------------------------------------------------------------- wiring

function wire() {
  $('new-draft').addEventListener('click', newDraft);
  $('back').addEventListener('click', async () => { clearTimeout(saveTimer); await persistDraft(); showHome(); });
  $('title').addEventListener('input', e => { draft.title = e.target.value; syncDirection(); schedule(); });
  $('direction').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v;
    if (v === undefined) return;
    draft.vertical = v === '1'; draft.layout = 0;
    syncDirection(); schedule();
  });
  $('filters').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.k;
    renderCompositions();
  });
  $('shuffle-tiles').addEventListener('click', () => { draft.seed = seed(); schedule(); });
  $('next-layout').addEventListener('click', () => {
    const vertical = language(draft.title.trim()) === 'ko' && draft.vertical;
    draft.layout = (draft.layout + 1) % layouts(vertical).length;
    schedule();
  });
  $('random-all').addEventListener('click', () => {
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
  try {
    catalog = await init();
  } catch (e) {
    toast('자원을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    throw e;
  }
  store.persist();
  showHome();
})();
