#!/usr/bin/env node
// Flow bridge: a small local server that holds the MCP connections (Higgsfield and any other remote MCP server)
// so the canvas in the browser can call their tools. It also serves the site itself at http://localhost:8787/.
//
// Why a server: a remote MCP server signs you in with OAuth and is not meant to be called from a web page
// (cross-origin rules, and the tokens would sit in the page). Here the tokens stay in a file in your home folder.
import http from 'node:http';
import { promises as fs, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

const PORT = +(process.env.FLOW_PORT || 8787);
const HOST = '127.0.0.1';
const ORIGIN = `http://localhost:${PORT}`;
const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DIR = process.env.FLOW_STATE_DIR || path.join(os.homedir(), '.flow-bridge');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
// Pages allowed to call this bridge besides the bridge's own page, e.g. FLOW_ALLOWED_ORIGINS=https://you.github.io
const EXTRA_ORIGINS = (process.env.FLOW_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const BUILTIN = [{ id: 'higgsfield', name: 'Higgsfield', url: process.env.HIGGSFIELD_MCP_URL || 'https://mcp.higgsfield.ai/mcp', builtin: true }];
const CALL_TIMEOUT_MS = 120000;
const WORKFLOW_DIR = path.join(STATE_DIR, 'workflows');
const workflowFile = (id) => (/^[\w-]{1,80}$/.test(id) ? path.join(WORKFLOW_DIR, `${id}.json`) : null);
// Text writing uses the Claude Code command on this computer (the person's own subscription), when it is installed.
const LLM_CMD = process.env.FLOW_LLM_CMD || 'claude';
// `images` are pictures Claude should look at: they are written into a throw-away folder that the command runs in,
// and Claude is allowed the Read tool for it.
async function writeWithClaude(prompt, images = []) {
  let cwd = os.tmpdir(), args = ['-p', '--output-format', 'text'];
  const files = [];
  if (images.length) {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-look-'));
    for (const [i, img] of images.slice(0, 8).entries()) {
      let buf, type = img.type || 'image/jpeg';
      if (img.data) buf = Buffer.from(img.data, 'base64');
      else {
        let u; try { u = new URL(img.url); } catch { throw httpError(400, '이미지 주소 형식이 아닙니다'); }
        if (u.protocol !== 'https:' || privateHost(u.hostname)) throw httpError(400, '가져올 수 없는 이미지 주소입니다');
        const r = await fetch(u);
        if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) throw httpError(502, '결과 이미지를 내려받지 못했습니다');
        type = r.headers.get('content-type'); buf = Buffer.from(await r.arrayBuffer());
      }
      const name = `picture${i + 1}.${/png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : 'jpg'}`;
      await fs.writeFile(path.join(cwd, name), buf);
      files.push(`./${name}${img.label ? ` — ${img.label}` : ''}`);
    }
    args.push('--allowedTools', 'Read');
    prompt += `\n\nPictures to look at (read every file with the Read tool before answering):\n${files.join('\n')}`;
  }
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(LLM_CMD, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill(); reject(httpError(504, '글 작성이 너무 오래 걸려 멈췄습니다')); }, 240000);
      child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? httpError(501, '이 컴퓨터에서 Claude Code(claude 명령)를 찾지 못했습니다') : httpError(500, e.message)); });
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => { clearTimeout(timer); if (code === 0 && out.trim()) resolve(out.trim()); else reject(httpError(502, (err || out).trim().slice(0, 300) || `claude 명령이 실패했습니다 (${code})`)); });
      child.stdin.end(prompt);
    });
  } finally { if (images.length) await fs.rm(cwd, { recursive: true, force: true }).catch(() => {}); }
}

// ---- saved state: added servers and each server's OAuth data
let state = { servers: [], auth: {} };
try { state = { servers: [], auth: {}, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
function persist() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), { mode: 0o600 });
  try { chmodSync(STATE_FILE, 0o600); } catch { /* not supported on this file system */ }
}
const configs = () => [...BUILTIN, ...state.servers];

// ---- live connections
const live = new Map(); // id -> { client, transport, status, error, authUrl, tools, oauthState }
function entry(id) {
  if (!live.has(id)) live.set(id, { status: 'disconnected', error: '', tools: [] });
  return live.get(id);
}

// OAuth storage for one server, in the shape the MCP SDK asks for.
function authProvider(id) {
  const slot = () => (state.auth[id] ||= {});
  return {
    get redirectUrl() { return `${ORIGIN}/oauth/callback`; },
    get clientMetadata() {
      return { client_name: 'Flow workflow canvas (local bridge)', redirect_uris: [`${ORIGIN}/oauth/callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    },
    state() { const e = entry(id); e.oauthState = `${id}.${crypto.randomBytes(16).toString('hex')}`; return e.oauthState; },
    clientInformation() { return slot().client; },
    saveClientInformation(info) { slot().client = info; persist(); },
    tokens() { return slot().tokens; },
    saveTokens(tokens) { slot().tokens = tokens; persist(); },
    redirectToAuthorization(url) { entry(id).authUrl = String(url); },
    saveCodeVerifier(v) { slot().verifier = v; persist(); },
    codeVerifier() { return slot().verifier; },
    invalidateCredentials(scope) {
      const s = slot();
      if (scope === 'all' || scope === 'tokens') delete s.tokens;
      if (scope === 'all' || scope === 'client') delete s.client;
      if (scope === 'all' || scope === 'verifier') delete s.verifier;
      persist();
    },
  };
}

async function connect(id) {
  const cfg = configs().find((s) => s.id === id);
  if (!cfg) throw httpError(404, '등록되지 않은 서버입니다');
  const e = entry(id);
  await e.client?.close().catch(() => {});
  Object.assign(e, { status: 'connecting', error: '', authUrl: '', tools: [] });
  e.transport = new StreamableHTTPClientTransport(new URL(cfg.url), { authProvider: authProvider(id) });
  e.client = new Client({ name: 'flow-bridge', version: '1.0.0' });
  try {
    await e.client.connect(e.transport);
    const tools = [];
    let cursor;
    do { const page = await e.client.listTools(cursor ? { cursor } : undefined); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
    e.tools = tools; e.status = 'connected';
  } catch (err) {
    if (err instanceof UnauthorizedError && e.authUrl) e.status = 'needs_auth';
    else { e.status = 'error'; e.error = explain(err); }
  }
  return e;
}
function explain(err) {
  const msg = err?.message || String(err);
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|EAI_AGAIN/i.test(msg) || /ENOTFOUND|ECONNREFUSED/.test(err?.cause?.code || '')) return '서버에 닿지 않습니다. 주소와 네트워크를 확인하세요.';
  if (/registration/i.test(msg)) return `이 서버는 앱 자동 등록(동적 클라이언트 등록)을 받지 않습니다: ${msg}`;
  return msg;
}

async function callTool(id, name, args) {
  const e = entry(id);
  if (e.status !== 'connected') throw httpError(409, '서버에 연결되어 있지 않습니다');
  try {
    return await e.client.callTool({ name, arguments: args || {} }, undefined, { timeout: CALL_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof UnauthorizedError) { e.status = 'needs_auth'; throw httpError(401, '로그인이 만료되었습니다. 다시 로그인하세요.'); }
    throw httpError(502, explain(err));
  }
}
const toolJson = (res) => {
  if (res.structuredContent) return res.structuredContent;
  const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
};

// ---- http helpers
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function originAllowed(origin) {
  if (!origin) return true; // same-origin navigation, curl
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  } catch { return false; }
  return EXTRA_ORIGINS.includes(origin);
}
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}
async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, '파일이 너무 큽니다'); chunks.push(c); }
  return Buffer.concat(chunks);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2' };

async function serveStatic(req, res, pathname) {
  if (pathname === '/') return send(res, 302, '', { location: '/flow/' });
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.resolve(SITE_ROOT, rel);
  // Only the site's own folders, never the server folder (dependencies, nothing secret, but not part of the site).
  const top = rel.split('/')[0];
  if (!file.startsWith(SITE_ROOT + path.sep) || !['flow', 'previz', 'index.html'].includes(top) || rel.startsWith('flow/server')) return send(res, 404, 'Not found');
  try {
    if ((await fs.stat(file)).isDirectory()) {
      if (!pathname.endsWith('/')) return send(res, 302, '', { location: `${pathname}/` });
      file = path.join(file, 'index.html');
    }
    await fs.access(file);
  } catch { return send(res, 404, 'Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

function privateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
}

// ---- routes
async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  const origin = req.headers.origin;

  if (p.startsWith('/api/')) {
    if (!originAllowed(origin)) return send(res, 403, { error: '이 페이지에서는 브리지를 쓸 수 없습니다. FLOW_ALLOWED_ORIGINS 에 주소를 추가하세요.' });
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } : {};
    if (req.method === 'OPTIONS') return send(res, 204, '', cors);
    const json = (status, body) => send(res, status, body, cors);
    try {
      if (p === '/api/status' && req.method === 'GET') {
        return json(200, { ok: true, servers: configs().map((s) => { const e = entry(s.id); return { id: s.id, name: s.name, url: s.url, builtin: !!s.builtin, state: e.status, error: e.error, toolCount: e.tools.length }; }) });
      }
      // Turn the bridge off from the page (it can be started again from the page once the macOS helper is installed).
      if (p === '/api/shutdown' && req.method === 'POST') {
        json(200, { ok: true });
        setTimeout(() => process.exit(0), 100);
        return;
      }
      if (p === '/api/tools' && req.method === 'GET') {
        return json(200, { tools: configs().flatMap((s) => entry(s.id).tools.map((t) => ({ server: s.id, name: t.name, description: t.description || '', inputSchema: t.inputSchema }))) });
      }
      if (p === '/api/servers' && req.method === 'POST') {
        const { name, url: surl } = JSON.parse((await readBody(req, 1e5)).toString() || '{}');
        const id = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
        if (!id) throw httpError(400, '이름을 넣으세요');
        if (configs().some((s) => s.id === id)) throw httpError(409, '같은 이름의 서버가 이미 있습니다');
        let u; try { u = new URL(surl); } catch { throw httpError(400, '주소 형식이 아닙니다'); }
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) throw httpError(400, 'https 주소만 추가할 수 있습니다 (내 컴퓨터의 서버는 http://localhost 가능)');
        state.servers.push({ id, name: String(name).trim(), url: u.href }); persist();
        return json(200, { id });
      }
      const m = /^\/api\/servers\/([^/]+)(?:\/(connect|logout))?$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!m[2] && req.method === 'DELETE') {
          if (BUILTIN.some((s) => s.id === id)) throw httpError(400, '기본 서버는 삭제할 수 없습니다');
          await live.get(id)?.client?.close().catch(() => {}); live.delete(id);
          state.servers = state.servers.filter((s) => s.id !== id); delete state.auth[id]; persist();
          return json(200, { ok: true });
        }
        if (m[2] === 'connect' && req.method === 'POST') {
          const e = await connect(id);
          return json(200, { state: e.status, error: e.error, authUrl: e.status === 'needs_auth' ? e.authUrl : undefined });
        }
        if (m[2] === 'logout' && req.method === 'POST') {
          await live.get(id)?.client?.close().catch(() => {}); live.delete(id);
          if (state.auth[id]) { delete state.auth[id].tokens; delete state.auth[id].verifier; persist(); }
          return json(200, { ok: true });
        }
      }
      if (p === '/api/llm' && req.method === 'POST') {
        const { prompt, images } = JSON.parse((await readBody(req, 60e6)).toString() || '{}');
        if (!prompt?.trim()) throw httpError(400, '내용이 비어 있습니다');
        return json(200, { text: await writeWithClaude(String(prompt), Array.isArray(images) ? images : []) });
      }
      if (p === '/api/workflows' && req.method === 'GET') {
        await fs.mkdir(WORKFLOW_DIR, { recursive: true });
        const list = [];
        for (const f of await fs.readdir(WORKFLOW_DIR)) {
          if (!f.endsWith('.json')) continue;
          try { const d = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, f), 'utf8')); list.push({ id: d.id, name: d.name, updatedAt: d.updatedAt || 0 }); } catch { /* unreadable file: skipped */ }
        }
        return json(200, { workflows: list });
      }
      const w = /^\/api\/workflows\/([^/]+)$/.exec(p);
      if (w) {
        const file = workflowFile(decodeURIComponent(w[1]));
        if (!file) throw httpError(400, '워크플로우 이름이 올바르지 않습니다');
        if (req.method === 'GET') { try { return json(200, JSON.parse(await fs.readFile(file, 'utf8'))); } catch { throw httpError(404, '없는 워크플로우입니다'); } }
        if (req.method === 'PUT') {
          const doc = JSON.parse((await readBody(req, 50e6)).toString());
          if (!Array.isArray(doc?.nodes)) throw httpError(400, '워크플로우 형식이 아닙니다');
          await fs.mkdir(WORKFLOW_DIR, { recursive: true });
          await fs.writeFile(file, JSON.stringify({ ...doc, id: decodeURIComponent(w[1]) }));
          return json(200, { ok: true });
        }
        if (req.method === 'DELETE') { await fs.rm(file, { force: true }); return json(200, { ok: true }); }
      }
      if (p === '/api/call' && req.method === 'POST') {
        const { server, tool, args } = JSON.parse((await readBody(req, 5e6)).toString() || '{}');
        if (!server || !tool) throw httpError(400, 'server 와 tool 이 필요합니다');
        const r = await callTool(server, tool, args);
        return json(200, { content: r.content || [], structuredContent: r.structuredContent, isError: !!r.isError });
      }
      // A local file as a generation reference: ask the server for an upload slot, PUT the bytes, confirm.
      if (p === '/api/upload' && req.method === 'POST') {
        const server = url.searchParams.get('server') || 'higgsfield';
        const filename = (url.searchParams.get('filename') || 'file.bin').replace(/[^\w.\-]+/g, '_').slice(-80);
        const kind = url.searchParams.get('kind') || 'image';
        const type = req.headers['content-type'] || 'application/octet-stream';
        const body = await readBody(req, 200e6);
        const slot = toolJson(await callTool(server, 'media_upload', { filename, content_type: type }));
        const up = slot.uploads?.[0] || slot;
        if (!up.upload_url || !up.media_id) throw httpError(502, slot.error || '업로드 주소를 받지 못했습니다');
        let put = await fetch(up.upload_url, { method: up.method || 'PUT', headers: { 'content-type': up.content_type || type }, body });
        if (put.status === 403) put = await fetch(up.upload_url, { method: up.method || 'PUT', headers: { 'content-type': up.content_type || type, 'if-none-match': '*' }, body });
        if (!put.ok) throw httpError(502, `파일을 올리지 못했습니다 (${put.status})`);
        const done = await callTool(server, 'media_confirm', { media_id: up.media_id, type: kind });
        if (done.isError) throw httpError(502, toolJson(done).error || toolJson(done).text || '업로드 확인에 실패했습니다');
        return json(200, { mediaId: up.media_id });
      }
      // Media through the bridge, so the page can read pixels of a result video (frame extraction).
      if (p === '/api/proxy' && req.method === 'GET') {
        let target; try { target = new URL(url.searchParams.get('url')); } catch { throw httpError(400, '주소 형식이 아닙니다'); }
        if (target.protocol !== 'https:' || privateHost(target.hostname)) throw httpError(400, '가져올 수 없는 주소입니다');
        const up = await fetch(target, { headers: req.headers.range ? { range: req.headers.range } : {}, redirect: 'follow' });
        const ctype = up.headers.get('content-type') || '';
        if (!/^(image|video|audio)\//.test(ctype)) { await up.body?.cancel(); throw httpError(415, '이미지·영상·오디오만 가져옵니다'); }
        const head = { ...cors, 'content-type': ctype, 'cache-control': 'private, max-age=3600', 'accept-ranges': up.headers.get('accept-ranges') || 'bytes' };
        for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) head[k] = up.headers.get(k);
        res.writeHead(up.status, head);
        if (!up.body) return res.end();
        const reader = up.body.getReader();
        res.on('close', () => reader.cancel().catch(() => {}));
        for (;;) { const { done, value } = await reader.read(); if (done) break; if (!res.write(value)) await new Promise((r) => res.once('drain', r)); }
        return res.end();
      }
      throw httpError(404, '없는 주소입니다');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      return json(err.status || 500, { error: err.status ? err.message : explain(err) });
    }
  }

  if (p === '/oauth/callback') {
    const page = (title, text) => send(res, 200, `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px/1.6 system-ui;background:#0f1114;color:#e6e8eb;display:grid;place-content:center;height:100vh;margin:0;text-align:center"><h1 style="font-size:18px">${title}</h1><p>${text}</p></body>`);
    const st = url.searchParams.get('state') || '';
    const id = [...live.keys()].find((k) => live.get(k).oauthState && live.get(k).oauthState === st);
    if (!id) return page('연결하지 못했습니다', '로그인 요청을 찾을 수 없습니다. 캔버스에서 다시 로그인을 눌러 주세요.');
    const e = live.get(id);
    e.oauthState = '';
    if (url.searchParams.get('error')) { e.status = 'error'; e.error = `로그인이 취소되었거나 거부되었습니다 (${url.searchParams.get('error')})`; return page('연결하지 못했습니다', '캔버스로 돌아가 다시 시도해 주세요.'); }
    try {
      await e.transport.finishAuth(url.searchParams.get('code'));
      const done = await connect(id);
      if (done.status !== 'connected') throw new Error(done.error || '연결하지 못했습니다');
      return page('연결되었습니다', '이 창을 닫고 캔버스로 돌아가세요.');
    } catch (err) { e.status = 'error'; e.error = explain(err); return page('연결하지 못했습니다', '캔버스로 돌아가 오류 내용을 확인해 주세요.'); }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  return serveStatic(req, res, p);
}

const server = http.createServer((req, res) => { handle(req, res).catch((err) => { if (!res.headersSent) send(res, 500, { error: explain(err) }); else res.destroy(); }); });
server.listen(PORT, HOST, async () => {
  console.log(`Flow 브리지가 켜졌습니다 → ${ORIGIN}/flow/`);
  console.log(`로그인 정보 저장 위치: ${STATE_FILE}`);
  // Servers signed in earlier reconnect on their own; ones that need a login wait for the button in the page.
  for (const s of configs()) if (state.auth[s.id]?.tokens) connect(s.id).then((e) => console.log(`${s.name}: ${e.status}${e.error ? ` (${e.error})` : ''}`));
});
if (!existsSync(path.join(SITE_ROOT, 'flow', 'index.html'))) console.warn('경고: flow/index.html 을 찾지 못했습니다. 저장소 안에서 실행하세요.');
