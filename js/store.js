// Drafts live only in this browser's IndexedDB on this device. At most three.

const DB = 'ttt', STORE = 'drafts', VERSION = 1;
export const LIMIT = 3;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
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
