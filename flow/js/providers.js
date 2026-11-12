// Where a node's work is actually done.
//  - demo:   placeholder pictures drawn in the browser. Costs nothing; for building and checking a graph.
//  - bridge: the local Node bridge (flow/server) holds the MCP connections (Higgsfield and others) and this page calls it.
//  - relay:  no server. The page writes the request for a Claude chat that has the Higgsfield connector; the person pastes the result links back.
import { getBlob, isLocal, saveBlob, imageSize } from './media.js';

const SETTINGS_KEY = 'flow.settings.v1';
export const settings = { mode: 'demo', bridgeUrl: 'http://localhost:8787', server: 'higgsfield', parallel: 3 };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* defaults */ }
export function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* not saved */ } }

export const bridge = { base: '', online: false, servers: [], tools: [], error: '' };

async function api(path, opts = {}) {
  const res = await fetch(`${bridge.base || settings.bridgeUrl}${path}`, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `브리지 오류 (${res.status})`);
  return body;
}

// Ask the bridge what it is connected to. Never throws: an unreachable bridge is a normal state.
export async function refreshBridge() {
  bridge.base = settings.bridgeUrl.replace(/\/+$/, '');
  try {
    const st = await api('/api/status');
    bridge.online = true; bridge.error = ''; bridge.servers = st.servers || [];
    bridge.tools = (await api('/api/tools')).tools || [];
  } catch (e) {
    bridge.online = false; bridge.servers = []; bridge.tools = [];
    bridge.error = e.message?.includes('fetch') ? '브리지에 닿지 않습니다' : e.message;
  }
  return bridge;
}
export const bridgeApi = {
  addServer: (name, url) => api('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, url }) }),
  removeServer: (id) => api(`/api/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  connect: (id) => api(`/api/servers/${encodeURIComponent(id)}/connect`, { method: 'POST' }),
  shutdown: () => api('/api/shutdown', { method: 'POST' }),
  logout: (id) => api(`/api/servers/${encodeURIComponent(id)}/logout`, { method: 'POST' }),
};
export const serverReady = (id) => bridge.online && bridge.servers.some((s) => s.id === id && s.state === 'connected');

// ---- reading MCP tool results -------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXT = { image: /\.(png|jpe?g|webp|gif|avif|svg)(\?|#|$)/i, video: /\.(mp4|webm|mov|m4v)(\?|#|$)/i, audio: /\.(mp3|wav|m4a|ogg|flac)(\?|#|$)/i };
const kindOfUrl = (url, fallback) => Object.keys(EXT).find((k) => EXT[k].test(url)) || fallback;

// A tool answer as plain data: structuredContent when present, otherwise the JSON (or text) of its text blocks.
export function toolData(res) {
  if (res.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent;
  const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}
function walk(v, fn, key = '') {
  if (Array.isArray(v)) v.forEach((x) => walk(x, fn, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, fn, k);
  else fn(v, key);
}
export function findJobIds(data) {
  const ids = [];
  walk(data, (v, k) => { if (typeof v === 'string' && UUID.test(v) && /^(job_?ids?|ids?|generation_?ids?)$/i.test(k) && !ids.includes(v)) ids.push(v); });
  return ids;
}
// Result links in a tool answer. Thumbnails/posters are skipped when a full result is present.
export function findUrls(data, kind) {
  const full = [], small = [];
  walk(data, (v, k) => {
    if (typeof v !== 'string' || !/^https?:\/\//.test(v)) return;
    (/thumb|poster|preview|cover|min_/i.test(k) ? small : full).push(v);
  });
  const list = full.length ? full : small;
  const typed = list.filter((u) => kindOfUrl(u, null) === kind);
  return [...new Set(typed.length ? typed : list.filter((u) => !kindOfUrl(u, null)))];
}
function failure(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.error === 'string') return data.error;
  if (data.error?.message) return data.error.message;
  return '';
}

// ---- demo ------------------------------------------------------------------------------------
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; }
function ratio(aspect) { const m = /^(\d+):(\d+)$/.exec(aspect || ''); return m ? +m[1] / +m[2] : 16 / 9; }
async function placeholder({ kind, model, prompt, aspect }, n) {
  const r = ratio(aspect), w = r >= 1 ? 960 : Math.round(960 * r), h = r >= 1 ? Math.round(960 / r) : 960;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const seed = hash(`${prompt}|${model}|${n}`);
  const hue = seed % 360;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue} 32% 24%)`); grad.addColorStop(1, `hsl(${(hue + 50) % 360} 38% 11%)`);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,.10)'; g.lineWidth = 1;
  for (let i = 1; i < 3; i++) { g.beginPath(); g.moveTo((w * i) / 3, 0); g.lineTo((w * i) / 3, h); g.moveTo(0, (h * i) / 3); g.lineTo(w, (h * i) / 3); g.stroke(); }
  g.fillStyle = 'rgba(255,255,255,.92)'; g.font = `600 ${Math.round(w / 34)}px system-ui, sans-serif`;
  g.fillText(`데모 ${kind === 'video' ? '영상 자리' : '이미지'} · ${model}${n ? ` · 변형 ${n + 1}` : ''}`, w * 0.05, h * 0.2);
  g.fillStyle = 'rgba(255,255,255,.72)'; g.font = `${Math.round(w / 44)}px system-ui, sans-serif`;
  const words = (prompt || '(프롬프트 없음)').split(/\s+/); let line = '', y = h * 0.3;
  for (const word of words) {
    if (g.measureText(`${line} ${word}`).width > w * 0.9) { g.fillText(line, w * 0.05, y); line = word; y += w / 34; if (y > h * 0.9) break; } else line = line ? `${line} ${word}` : word;
  }
  if (y <= h * 0.9) g.fillText(line, w * 0.05, y);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
  return saveBlob(blob);
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('중단됨', 'AbortError')); }, { once: true });
});

const demo = {
  id: 'demo', label: '데모',
  async generate(req, ctx) {
    ctx.progress('데모 결과를 그리는 중');
    await sleep(500 + (hash(req.prompt) % 600), ctx.signal);
    const items = [];
    // A demo "video" is a still: nothing is generated, so there is no motion to show.
    for (let n = 0; n < req.count; n++) items.push({ type: req.kind, url: await placeholder(req, n), demo: true, still: req.kind === 'video', local: true });
    return items;
  },
  async upscale({ item }, ctx) { await sleep(400, ctx.signal); return [{ ...item, demo: true }]; },
  async callTool() { throw new Error('MCP 도구는 브리지 연결 모드에서만 실행됩니다'); },
  async cost() { return null; },
};

// ---- bridge (MCP) ------------------------------------------------------------------------------
async function call(server, tool, args, signal) {
  const res = await api('/api/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server, tool, args }), signal });
  const data = toolData(res);
  if (res.isError) throw new Error(failure(data) || data.text || `${tool} 실패`);
  return data;
}

// The id a generation tool accepts for a reference: an earlier job, an uploaded file or an imported link.
async function mediaValue(item, ctx) {
  if (item.jobId) return item.jobId;
  if (item.mediaId) return item.mediaId;
  if (item.demo) throw new Error('데모 결과는 실제 생성의 레퍼런스로 쓸 수 없습니다. 앞 노드를 연결 모드에서 다시 실행하세요.');
  if (isLocal(item.url)) {
    const blob = getBlob(item.url);
    if (!blob) throw new Error('레퍼런스 파일을 찾을 수 없습니다. 파일을 다시 넣어 주세요.');
    ctx.progress('레퍼런스 올리는 중');
    const name = item.name || `ref.${(blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`;
    const r = await api(`/api/upload?server=${encodeURIComponent(settings.server)}&filename=${encodeURIComponent(name)}&kind=${item.type}`, { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream' }, body: blob, signal: ctx.signal });
    item.mediaId = r.mediaId;
    return item.mediaId;
  }
  ctx.progress('레퍼런스 가져오는 중');
  const data = await call(settings.server, 'media_import_url', { url: item.url, type: item.type }, ctx.signal);
  const id = data.media_id || data.id || findJobIds(data)[0];
  if (!id) throw new Error('레퍼런스 주소를 가져오지 못했습니다');
  item.mediaId = id;
  return id;
}

async function waitJobs(ids, kind, ctx) {
  const done = new Map();
  let pending = ids.map((job_id, index) => ({ index, job_id }));
  while (pending.length) {
    if (ctx.signal.aborted) throw new DOMException('중단됨', 'AbortError');
    const data = await call(settings.server, 'jobs_wait', { jobs: pending, timeout_seconds: 15 }, ctx.signal);
    for (const j of data.jobs || []) {
      const status = String(j.status || '').toLowerCase();
      if (/fail|error|cancel|nsfw|reject/.test(status)) throw new Error(j.error || j.message || `생성 실패 (${j.status})`);
      const links = findUrls(j, kind);
      if (/complete|success|done|finish/.test(status) || (data.all_terminal && links.length)) done.set(j.job_id, links);
    }
    pending = pending.filter((p) => !done.has(p.job_id));
    if (!pending.length) break;
    if (data.all_terminal) throw new Error('생성이 끝났지만 결과 주소를 받지 못했습니다');
    ctx.progress('생성 중');
    await sleep(Math.min(15, Math.max(1, +data.poll_after_seconds || 2)) * 1000, ctx.signal);
  }
  const items = [];
  for (const id of ids) for (const url of done.get(id)) items.push({ type: kind, url, jobId: id });
  if (!items.length) throw new Error('결과 주소를 받지 못했습니다');
  return items;
}

async function submit(tool, params, kind, ctx) {
  let data = await call(settings.server, tool, { params }, ctx.signal);
  // The account holds free "unlimited" generations for this model: the server asks which balance to use before spending.
  if (data.unlim_choice) {
    const useUnlim = await ctx.ask('이 모델에 쓸 수 있는 무제한 생성권이 있습니다. 어느 쪽으로 생성할까요?', [{ label: '무제한 생성권 사용', value: true }, { label: '크레딧 사용', value: false }]);
    if (useUnlim == null) throw new DOMException('중단됨', 'AbortError');
    data = await call(settings.server, tool, { params: { ...params, use_unlim: useUnlim } }, ctx.signal);
  }
  const err = failure(data);
  if (err) throw new Error(err);
  const ids = findJobIds(data);
  if (!ids.length) {
    const urls = findUrls(data, kind);
    if (urls.length) return urls.map((url) => ({ type: kind, url }));
    throw new Error('생성 요청의 답에서 작업 번호를 찾지 못했습니다');
  }
  ctx.progress('생성 중');
  return waitJobs(ids, kind, ctx);
}

async function generationParams(req, ctx) {
  const medias = [];
  for (const m of req.medias) medias.push({ role: m.role, value: await mediaValue(m.item, ctx) });
  const params = { model: req.model, ...req.params };
  if (req.prompt) params.prompt = req.prompt;
  if (req.aspect) params.aspect_ratio = req.aspect;
  if (req.duration) params.duration = req.duration;
  if (req.count > 1) params.count = req.count;
  if (medias.length) params.medias = medias;
  return params;
}

const mcp = {
  id: 'bridge', label: 'MCP 연결',
  ready() { if (!serverReady(settings.server)) throw new Error('Higgsfield MCP에 연결되어 있지 않습니다. 위쪽 "연결"을 확인하세요.'); },
  async generate(req, ctx) {
    this.ready();
    return submit(req.kind === 'video' ? 'generate_video' : 'generate_image', await generationParams(req, ctx), req.kind, ctx);
  },
  async upscale({ item, resolution }, ctx) {
    this.ready();
    const { width, height } = await imageSize(item.url);
    return submit('upscale_image', { image_id: await mediaValue(item, ctx), width, height, resolution }, 'image', ctx);
  },
  // Credits a generation would cost, without submitting it (the tools' get_cost preflight).
  async cost(req, ctx) {
    this.ready();
    const params = await generationParams({ ...req, medias: req.medias.filter((m) => m.item.jobId || m.item.mediaId) }, ctx);
    const data = await call(settings.server, req.kind === 'video' ? 'generate_video' : 'generate_image', { params: { ...params, get_cost: true } }, ctx.signal);
    const credits = data.cost?.credits ?? data.credits;
    return credits == null ? null : +credits;
  },
  async callTool(server, tool, args) {
    if (!serverReady(server)) throw new Error(`${server} 서버에 연결되어 있지 않습니다`);
    const data = await call(server, tool, args);
    const items = [];
    for (const kind of ['image', 'video', 'audio']) for (const url of findUrls(data, kind)) if (kindOfUrl(url, null) === kind) items.push({ type: kind, url });
    items.push({ type: 'text', text: typeof data.text === 'string' && Object.keys(data).length === 1 ? data.text : JSON.stringify(data, null, 2) });
    return items;
  },
};

// ---- relay (copy to a Claude chat, paste the links back) ----------------------------------------
export function relayText(req) {
  const tool = req.kind === 'video' ? 'generate_video' : 'generate_image';
  const lines = [
    `Higgsfield MCP의 ${tool} 도구로 아래 요청을 그대로 실행해 줘. 프롬프트는 한 글자도 바꾸지 마.`,
    '끝나면 다른 말 없이 결과마다 한 줄씩 `작업 번호(job_id) 결과 파일 주소(URL)` 형식으로만 적어 줘.',
    '',
    `model: ${req.model}`,
  ];
  if (req.aspect) lines.push(`aspect_ratio: ${req.aspect}`);
  if (req.duration) lines.push(`duration: ${req.duration}`);
  if (req.count > 1) lines.push(`count: ${req.count}`);
  for (const [k, v] of Object.entries(req.params)) lines.push(`${k}: ${v}`);
  req.medias.forEach((m, i) => {
    const ref = m.item.jobId ? `job_id ${m.item.jobId}` : isLocal(m.item.url) ? `(첨부 파일 ${i + 1}: 이 채팅에 직접 올려 주세요)` : `${m.item.url} (media_import_url로 가져오기)`;
    lines.push(`medias[${i}]: role=${m.role}, ${ref}`);
  });
  lines.push('', 'prompt:', req.prompt || '(없음)');
  return lines.join('\n');
}
const relay = {
  id: 'relay', label: 'Claude 전달',
  async generate(req, ctx) {
    const pasted = await ctx.relay(relayText(req), req.kind);
    if (pasted == null) throw new DOMException('중단됨', 'AbortError');
    const urls = [...new Set(pasted.match(/https?:\/\/[^\s"'<>)\]]+/g) || [])];
    if (!urls.length) throw new Error('붙여넣은 글에서 주소를 찾지 못했습니다');
    const ids = pasted.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi) || [];
    return urls.map((url, i) => ({ type: kindOfUrl(url, req.kind), url, ...(ids.length === urls.length ? { jobId: ids[i] } : {}) }));
  },
  async upscale() { throw new Error('업스케일은 MCP 연결 모드에서 실행됩니다'); },
  async callTool() { throw new Error('MCP 도구는 MCP 연결 모드에서만 실행됩니다'); },
  async cost() { return null; },
};

export const PROVIDERS = { demo, bridge: mcp, relay };
export const currentProvider = () => PROVIDERS[settings.mode] || demo;
