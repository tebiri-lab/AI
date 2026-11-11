// Workflow library: every workflow is kept by id in this browser (IndexedDB) and saved as you work.
// When the bridge is on, each save is also written to a folder on the computer (~/.flow-bridge/workflows),
// so the same workflows show up whether the page is opened from the public address or from localhost.
import { bridge } from './providers.js';

const DB = 'flow-library', STORE = 'docs', LAST_KEY = 'flow.last', LEGACY_KEY = 'flow.doc.v1';
let dbp = null;
const memory = new Map(); // used when IndexedDB is unavailable (the workflows then last for this visit only)

function tx(mode, fn) {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp.then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  }));
}
const newId = () => `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const plain = (doc) => JSON.parse(JSON.stringify(doc));
const remote = (path, opts) => fetch(`${bridge.base}/api/workflows${path}`, opts).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`브리지 저장소 오류 (${r.status})`))));

export const library = {
  newId,
  last() { try { return localStorage.getItem(LAST_KEY); } catch { return null; } },
  setLast(id) { try { localStorage.setItem(LAST_KEY, id); } catch { /* not remembered */ } },

  async all() {
    try { return (await tx('readonly', (s) => s.getAll())) || []; } catch { return [...memory.values()]; }
  },
  async list() {
    return (await this.all()).map((d) => ({ id: d.id, name: d.name, updatedAt: d.updatedAt || 0, nodes: d.nodes?.length || 0 })).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async get(id) {
    if (!id) return null;
    try { return (await tx('readonly', (s) => s.get(id))) || null; } catch { return memory.get(id) || null; }
  },
  // Save a workflow. `touch` false keeps its time (used when copying between the browser and the bridge).
  async put(doc, touch = true) {
    const copy = plain(doc);
    copy.id ||= newId();
    if (touch || !copy.updatedAt) copy.updatedAt = Date.now();
    doc.id = copy.id; doc.updatedAt = copy.updatedAt;
    try { await tx('readwrite', (s) => s.put(copy)); } catch { memory.set(copy.id, copy); }
    if (touch && bridge.online) remote(`/${encodeURIComponent(copy.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(copy) }).catch(() => {});
    return copy.id;
  },
  async remove(id) {
    try { await tx('readwrite', (s) => s.delete(id)); } catch { memory.delete(id); }
    if (bridge.online) remote(`/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  },
  // The single workflow an earlier version kept in localStorage becomes the first library entry.
  async migrate() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      const doc = JSON.parse(raw);
      localStorage.removeItem(LEGACY_KEY);
      if (!doc?.nodes?.length) return null;
      return this.put(doc);
    } catch { return null; }
  },
  // Bring the browser and the bridge folder to the same state: for each workflow the newer copy wins.
  async sync() {
    if (!bridge.online) return 0;
    let changed = 0;
    try {
      const there = new Map((await remote('')).workflows.map((w) => [w.id, w]));
      const here = new Map((await this.all()).map((d) => [d.id, d]));
      for (const [id, meta] of there) {
        const mine = here.get(id);
        if (!mine || (meta.updatedAt || 0) > (mine.updatedAt || 0)) { await this.put(await remote(`/${encodeURIComponent(id)}`), false); changed++; }
      }
      for (const [id, mine] of here) {
        const meta = there.get(id);
        if (!meta || (mine.updatedAt || 0) > (meta.updatedAt || 0)) await remote(`/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mine) });
      }
    } catch { /* the bridge folder is a convenience; the browser copy is still there */ }
    return changed;
  },
};
