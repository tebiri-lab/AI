#!/usr/bin/env node
// A stand-in MCP server for trying the bridge without spending credits: it answers a few Higgsfield-style
// tools (generate_image, generate_video, jobs_wait, media_upload, media_confirm, media_import_url,
// models_explore, balance) with made-up jobs and simple pictures. The answer shapes of media_upload,
// jobs_wait (job list, all_terminal) and get_cost follow the real server; the result-link field is a guess.
//   node test/mock-mcp.mjs            -> http://localhost:8799/mcp   (add it in the canvas: 연결 → MCP 서버 추가)
import http from 'node:http';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = +(process.env.MOCK_PORT || 8799);
const BASE = `http://localhost:${PORT}`;
const DELAY = +(process.env.MOCK_DELAY_MS || 1200);
const jobs = new Map(); // id -> { kind, prompt, readyAt, fail }
const uploads = new Map(); // id -> { type, body }
export const calls = [];

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const PARAMS = obj({ params: { type: 'object' } }, ['params']);
const TOOLS = [
  { name: 'generate_image', description: 'Mock image generation.', inputSchema: PARAMS },
  { name: 'generate_video', description: 'Mock video generation.', inputSchema: PARAMS },
  { name: 'upscale_image', description: 'Mock upscale.', inputSchema: PARAMS },
  { name: 'jobs_wait', description: 'Wait for jobs.', inputSchema: obj({ jobs: { type: 'array' }, timeout_seconds: { type: 'integer' } }, ['jobs']) },
  { name: 'media_upload', description: 'Get an upload URL.', inputSchema: obj({ filename: { type: 'string' }, content_type: { type: 'string' } }) },
  { name: 'media_confirm', description: 'Confirm an upload.', inputSchema: obj({ media_id: { type: 'string' }, type: { type: 'string', enum: ['image', 'video', 'audio', 'file'] } }, ['type']) },
  { name: 'media_import_url', description: 'Import a media URL.', inputSchema: obj({ url: { type: 'string' }, type: { type: 'string', enum: ['auto', 'image', 'video', 'audio'] } }, ['url']) },
  { name: 'models_explore', description: 'List models.', inputSchema: obj({ action: { type: 'string', enum: ['list', 'search', 'get', 'recommend'] }, type: { type: 'string' }, limit: { type: 'integer' }, after: { type: 'string' } }, ['action']) },
  { name: 'balance', description: 'Credits.', inputSchema: obj({}) },
  { name: 'echo', description: 'Returns the text it is given. For trying the generic MCP tool node.', inputSchema: obj({ text: { type: 'string', description: 'Text to echo' }, shout: { type: 'boolean' }, times: { type: 'integer', minimum: 1, maximum: 5 }, tone: { type: 'string', enum: ['plain', 'fancy'] } }, ['text']) },
];
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

function tool(name, a) {
  calls.push({ name, args: a });
  const p = a.params || {};
  if (name === 'generate_image' || name === 'generate_video' || name === 'upscale_image') {
    if (p.get_cost) { const c = p.draft_job_id ? (p.resolution === '4k' ? 272 : 128) : name === 'generate_video' ? 35 : 2; return ok({ cost: { credits: c, credits_exact: c } }); }
    if (name !== 'upscale_image' && !p.model) return ok({ error: 'model is required' });
    if (p.draft_job_id && !jobs.has(p.draft_job_id)) return ok({ error: `unknown draft ${p.draft_job_id}` });
    for (const m of p.medias || []) if (!uploads.has(m.value) && !jobs.has(m.value)) return ok({ error: `unknown media ${m.value}` });
    const ids = Array.from({ length: p.count || 1 }, () => crypto.randomUUID());
    for (const id of ids) jobs.set(id, { kind: name === 'generate_video' ? 'video' : 'image', prompt: p.prompt || '', readyAt: Date.now() + DELAY, fail: /FAIL/.test(p.prompt || '') });
    return ok({ jobs: ids.map((job_id, index) => ({ index, job_id, status: 'queued' })) });
  }
  if (name === 'jobs_wait') {
    const out = a.jobs.map(({ index, job_id }) => {
      const j = jobs.get(job_id);
      if (!j) return { index, job_id, status: 'lookup_failed', error: 'Generation not found', retryable: false };
      if (Date.now() < j.readyAt) return { index, job_id, status: 'in_progress' };
      if (j.fail) return { index, job_id, status: 'failed', error: 'Mock failure requested by the prompt' };
      return { index, job_id, status: 'completed', results: [{ url: `${BASE}/media/${job_id}.${j.kind === 'video' ? 'mp4' : 'svg'}`, thumbnail_url: `${BASE}/media/${job_id}.svg` }] };
    });
    const all = out.every((j) => j.status !== 'in_progress');
    return ok({ jobs: out, all_terminal: all, ...(all ? {} : { poll_after_seconds: 1 }) });
  }
  if (name === 'media_upload') { const id = crypto.randomUUID(); uploads.set(id, null); return ok({ uploads: [{ upload_url: `${BASE}/upload/${id}`, media_id: id, method: 'PUT', content_type: a.content_type || 'application/octet-stream' }] }); }
  if (name === 'media_confirm') return uploads.get(a.media_id) ? ok({ media_id: a.media_id, status: 'confirmed' }) : { ...ok({ error: 'upload not found' }), isError: true };
  if (name === 'media_import_url') { const id = crypto.randomUUID(); uploads.set(id, { type: 'url', body: a.url }); return ok({ media_id: id }); }
  if (name === 'models_explore') return ok({ items: a.type === 'video'
    ? [{ id: 'mock_video', name: 'Mock Video', provider_name: 'Mock', output_type: 'video', parameters: [{ name: 'resolution', type: 'string', options: ['720p', '1080p'], default: '720p' }], medias: [{ roles: ['start_image', 'image_references'] }], aspect_ratios: ['16:9', '9:16'], duration_range: { min: 4, max: 10 } }]
    : [{ id: 'mock_image', name: 'Mock Image', provider_name: 'Mock', output_type: 'image', parameters: [], medias: [{ roles: ['image_references'] }], aspect_ratios: ['16:9', '1:1'] }], has_more: false });
  if (name === 'balance') return ok({ credits: 1234, plan: 'mock' });
  if (name === 'echo') { const t = Array(a.times || 1).fill(a.shout ? String(a.text).toUpperCase() : a.text).join(' '); return ok({ text: a.tone === 'fancy' ? `✦ ${t} ✦` : t }); }
  return { ...ok({ error: `unknown tool ${name}` }), isError: true };
}

function picture(id) {
  const j = jobs.get(id); const hue = parseInt(id.slice(0, 4), 16) % 360;
  const text = (j?.prompt || '').replace(/[<&>]/g, '').slice(0, 70);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540" width="960" height="540"><rect width="960" height="540" fill="hsl(${hue} 35% 22%)"/><text x="40" y="80" fill="#fff" font-family="sans-serif" font-size="30">mock ${j?.kind || 'media'}</text><text x="40" y="130" fill="#ddd" font-family="sans-serif" font-size="20">${text}</text></svg>`;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  res.setHeader('access-control-allow-origin', '*');
  const m = /^\/(media|upload)\/([0-9a-f-]+)(?:\.(\w+))?$/.exec(url.pathname);
  if (m?.[1] === 'upload' && req.method === 'PUT') { const chunks = []; for await (const c of req) chunks.push(c); uploads.set(m[2], { type: req.headers['content-type'], body: Buffer.concat(chunks) }); return res.writeHead(200).end(); }
  if (m?.[1] === 'media') {
    if (m[3] === 'mp4' && process.env.MOCK_VIDEO) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end((await import('node:fs')).readFileSync(process.env.MOCK_VIDEO)); }
    res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(picture(m[2]));
  }
  if (url.pathname !== '/mcp') return res.writeHead(404).end();
  if (req.method !== 'POST') return res.writeHead(405).end();
  const chunks = []; for await (const c of req) chunks.push(c);
  const server = new Server({ name: 'mock-higgsfield', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => tool(r.params.name, r.params.arguments || {}));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString() || 'null'));
}).listen(PORT, '127.0.0.1', () => console.log(`mock MCP → ${BASE}/mcp`));
