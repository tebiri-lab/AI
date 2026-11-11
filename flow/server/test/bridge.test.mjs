// End-to-end check of the bridge against the mock MCP server: no network, no credits.  Run: npm test
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = mkdtempSync(path.join(os.tmpdir(), 'flow-bridge-test-'));
const B = 'http://localhost:8786', M = 'http://localhost:8798';
const procs = [
  spawn(process.execPath, [path.join(here, 'mock-mcp.mjs')], { env: { ...process.env, MOCK_PORT: '8798', MOCK_DELAY_MS: '200' }, stdio: 'ignore' }),
  spawn(process.execPath, [path.join(here, '..', 'server.mjs')], { env: { ...process.env, FLOW_PORT: '8786', FLOW_STATE_DIR: stateDir, HIGGSFIELD_MCP_URL: `${M}/mcp` }, stdio: 'ignore' }),
];
const stop = () => { for (const p of procs) p.kill(); rmSync(stateDir, { recursive: true, force: true }); };
const api = async (p, opts) => { const r = await fetch(B + p, opts); return { status: r.status, body: await r.json().catch(() => null) }; };
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = async (tool, args) => JSON.parse((await post('/api/call', { server: 'higgsfield', tool, args })).body.content[0].text);

try {
  for (let i = 0; i < 50; i++) { try { await fetch(`${B}/api/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  assert.equal((await api('/api/status', { headers: { origin: 'https://elsewhere.example' } })).status, 403, 'other sites are refused');
  assert.equal((await post('/api/call', { server: 'higgsfield', tool: 'balance' })).status, 409, 'calls need a connection');
  assert.equal((await post('/api/servers/higgsfield/connect')).body.state, 'connected');
  const tools = (await api('/api/tools')).body.tools;
  assert.ok(tools.some((t) => t.name === 'generate_video' && t.inputSchema), 'tools are listed with their schema');

  assert.equal((await call('generate_video', { params: { model: 'x', get_cost: true } })).cost.credits, 35);
  const up = await api('/api/upload?filename=ref.png&kind=image', { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from('png') });
  assert.equal(up.status, 200); assert.match(up.body.mediaId, /^[0-9a-f-]{36}$/);

  const job = (await call('generate_image', { params: { model: 'x', prompt: 'a', medias: [{ role: 'image_references', value: up.body.mediaId }] } })).jobs[0];
  let done;
  for (let i = 0; i < 40 && !done?.all_terminal; i++) { await new Promise((r) => setTimeout(r, 100)); done = await call('jobs_wait', { jobs: [{ index: 0, job_id: job.job_id }], timeout_seconds: 1 }); }
  assert.equal(done.jobs[0].status, 'completed'); assert.match(done.jobs[0].results[0].url, /^http/);

  assert.equal((await post('/api/servers', { name: 'Other', url: 'http://example.com/mcp' })).status, 400, 'plain http is refused');
  assert.equal((await post('/api/servers', { name: 'Other', url: `${M}/mcp` })).body.id, 'other');
  assert.equal((await post('/api/servers/other/connect')).body.state, 'connected');
  assert.equal((await api('/api/servers/other', { method: 'DELETE' })).status, 200);
  assert.equal((await api('/api/proxy?url=' + encodeURIComponent('https://localhost/x.mp4'))).status, 400, 'private hosts are not proxied');
  assert.equal((await fetch(`${B}/flow/server/server.mjs`)).status, 404, 'the server folder is not served');
  assert.equal((await fetch(`${B}/flow/`)).status, 200);
  console.log('bridge: all checks passed');
} finally { stop(); }
