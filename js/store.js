// Drafts live only in this browser's IndexedDB on this device. At most five.
// Deleted drafts wait in a trash store for a while, so a deletion can be undone.

const DB = 'ttt', STORE = 'drafts', TRASH = 'trash', VERSION = 2;
export const LIMIT = 5;
export const TRASH_DAYS = 10;   // each deleted post is kept this long, then deleted for good

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(TRASH)) db.createObjectStore(TRASH, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(result && 'result' in result ? result.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('저장이 취소되었습니다')); };
  });
}

export async function list() {
  const all = await run('readonly', s => s.getAll());
  return (all || []).sort((a, b) => b.updated - a.updated);
}

export const get = id => run('readonly', s => s.get(id));
export const remove = id => run('readwrite', s => s.delete(id));

export async function save(draft) {
  draft.updated = Date.now();
  const existing = await list();
  if (!existing.some(d => d.id === draft.id) && existing.length >= LIMIT) {
    throw new Error(`초안은 ${LIMIT}개까지 보관할 수 있습니다.`);
  }
  await run('readwrite', s => s.put(draft));
  return draft;
}

export async function persist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (_) { /* not supported */ }
  return false;
}

// One transaction over both stores, for moving a draft between them.
async function both(fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, TRASH], 'readwrite');
    let out;
    fn(tx.objectStore(STORE), tx.objectStore(TRASH), v => { out = v; });
    tx.oncomplete = () => { db.close(); resolve(out); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('취소되었습니다')); };
  });
}

async function all(name) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(name).objectStore(name).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result || []); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

// Moves a draft to the trash.
export const trash = id => both((drafts, bin) => {
  const req = drafts.get(id);
  req.onsuccess = () => {
    if (!req.result) return;
    bin.put({ ...req.result, deleted: Date.now() });
    drafts.delete(id);
  };
});

// Brings a draft back from the trash, if there is room for it.
export async function restore(id) {
  if ((await list()).length >= LIMIT) throw new Error(`초안은 ${LIMIT}개까지입니다. 하나를 비운 뒤 복원해 주세요.`);
  return both((drafts, bin) => {
    const req = bin.get(id);
    req.onsuccess = () => {
      if (!req.result) return;
      const { deleted, ...draft } = req.result;
      drafts.put({ ...draft, updated: Date.now() });
      bin.delete(id);
    };
  });
}

export async function listTrash() {
  return (await all(TRASH)).sort((a, b) => b.deleted - a.deleted);
}

export const purge = id => both((_, bin) => { bin.delete(id); });
export const emptyTrash = () => both((_, bin) => { bin.clear(); });

// Deletes for good what has been in the trash longer than TRASH_DAYS.
export async function sweepTrash() {
  const items = await listTrash();
  const old = Date.now() - TRASH_DAYS * 864e5;
  const gone = items.filter(d => d.deleted < old).map(d => d.id);
  if (gone.length) await both((_, bin) => gone.forEach(id => bin.delete(id)));
  return gone.length;
}

// Bytes held by drafts and the trash (photos and thumbnails).
const bytes = d => (d.thumb?.size || 0) + (d.photos || []).reduce((n, p) => n + (p.blob?.size || 0), 0);
export async function usage() {
  const [drafts, bin] = await Promise.all([all(STORE), all(TRASH)]);
  return {
    drafts: drafts.length, draftBytes: drafts.reduce((n, d) => n + bytes(d), 0),
    trash: bin.length, trashBytes: bin.reduce((n, d) => n + bytes(d), 0),
  };
}
