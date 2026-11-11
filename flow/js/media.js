// Local media: files the person adds and frames cut from videos are kept in IndexedDB as blobs and
// referenced from the workflow as "idb:<id>", so the saved workflow JSON stays small.
import { bridge } from './providers.js';

const DB = 'flow-media', STORE = 'blobs';
const urls = new Map(); // id -> object URL
const blobs = new Map(); // id -> Blob
let dbp = null;

function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  }));
}

// Load every stored blob once so display URLs can be resolved synchronously afterwards.
export async function initMedia() {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    const vals = await tx('readonly', (s) => s.getAll());
    keys.forEach((k, i) => { blobs.set(k, vals[i]); urls.set(k, URL.createObjectURL(vals[i])); });
  } catch { /* no IndexedDB: local files last for this visit only */ }
}
export async function saveBlob(blob) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  blobs.set(id, blob); urls.set(id, URL.createObjectURL(blob));
  try { await tx('readwrite', (s) => s.put(blob, id)); } catch { /* kept in memory only */ }
  return `idb:${id}`;
}
export const isLocal = (url) => typeof url === 'string' && (url.startsWith('idb:') || url.startsWith('blob:') || url.startsWith('data:'));
export const getBlob = (url) => (url?.startsWith('idb:') ? blobs.get(url.slice(4)) : null);
// URL usable in <img>/<video>. Empty when a local file is gone (e.g. the workflow was opened in another browser).
export function displayUrl(url) {
  if (!url) return '';
  if (url.startsWith('idb:')) return urls.get(url.slice(4)) || '';
  return url;
}
// Delete stored blobs no workflow node refers to any more.
export async function sweepMedia(usedRefs) {
  const used = new Set([...usedRefs].filter((u) => u?.startsWith?.('idb:')).map((u) => u.slice(4)));
  for (const id of [...blobs.keys()]) {
    if (used.has(id)) continue;
    URL.revokeObjectURL(urls.get(id)); urls.delete(id); blobs.delete(id);
    try { await tx('readwrite', (s) => s.delete(id)); } catch { /* ignore */ }
  }
}

export function imageSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('이미지를 읽을 수 없습니다'));
    img.src = displayUrl(url);
  });
}

// One frame of a video as a stored PNG. Remote videos must allow cross-origin reads; with the bridge on, they are fetched through it.
export async function grabFrame(url, at, time) {
  let src = displayUrl(url);
  if (!src) throw new Error('영상 파일을 찾을 수 없습니다');
  const remote = /^https?:/.test(src);
  if (/^https:/.test(src) && bridge.online) src = `${bridge.base}/api/proxy?url=${encodeURIComponent(src)}`;
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto'; video.playsInline = true;
  if (remote) video.crossOrigin = 'anonymous';
  const wait = (ev) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('영상을 불러오는 데 너무 오래 걸립니다')), 30000);
    video.addEventListener(ev, () => { clearTimeout(timer); resolve(); }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('영상을 불러올 수 없습니다')); }, { once: true });
  });
  video.src = src;
  await wait('loadedmetadata');
  const dur = Number.isFinite(video.duration) ? video.duration : 0;
  const t = at === 'first' ? 0 : at === 'last' ? Math.max(0, dur - 0.05) : Math.max(0, Math.min(time, Math.max(0, dur - 0.05)));
  video.currentTime = t;
  await wait('seeked');
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  let blob;
  try { blob = await new Promise((r) => c.toBlob(r, 'image/png')); } catch { blob = null; }
  video.removeAttribute('src'); video.load();
  if (!blob) throw new Error('영상 서버가 프레임 읽기를 허용하지 않습니다. 브리지를 켜면 브리지를 거쳐 읽습니다.');
  return saveBlob(blob);
}
