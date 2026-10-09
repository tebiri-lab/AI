// Tiny IndexedDB key-value store for things too big for localStorage (song, reference images).
const DB = 'previz-studio';
const STORE = 'kv';
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  }));
}

export async function idbGet(key) {
  try { return await run('readonly', (s) => s.get(key)); } catch { return undefined; }
}
export async function idbSet(key, value) {
  try { await run('readwrite', (s) => s.put(value, key)); return true; } catch { return false; }
}
export async function idbDel(key) {
  try { await run('readwrite', (s) => s.delete(key)); } catch { /* storage unavailable */ }
}
