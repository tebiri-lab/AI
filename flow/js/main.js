// Page wiring: toolbar, shortcuts, run guards, file open/save, connection panel.
import { Graph, emptyDoc } from './graph.js';
import { Engine } from './engine.js';
import { Canvas } from './canvas.js';
import { NODE_TYPES, buildRequest } from './nodes.js';
import { TEMPLATES } from './templates.js';
import { initMedia, sweepMedia } from './media.js';
import { settings, saveSettings, bridge, refreshBridge, bridgeApi, serverReady, currentProvider, toolData, relayText, PROVIDERS } from './providers.js';
import { setModels, isLiveCatalog, listModels } from './models.js';
import { h, toast, menu, modal, confirmBox, askBox, relayBox } from './ui.js';
import { library } from './library.js';

const $ = (id) => document.getElementById(id);
const graph = new Graph();
const engine = new Engine(graph, { ask: askBox, relay: relayBox });

// ---- running, with a check before several generating nodes spend credits at once
async function guarded(targetIds, force, what) {
  const spend = engine.spending(targetIds, force);
  if (settings.mode !== 'demo' && spend.length > 1) {
    const img = spend.filter((n) => n.type === 'image').length, vid = spend.filter((n) => n.type === 'video').length, etc = spend.length - img - vid;
    const parts = [img && `이미지 ${img}개`, vid && `영상 ${vid}개`, etc && `기타 ${etc}개`].filter(Boolean).join(', ');
    let costLine = '';
    if (settings.mode === 'bridge' && serverReady(settings.server)) {
      const ctx = { signal: new AbortController().signal, progress() {} };
      const costs = await Promise.all(spend.filter((n) => n.type === 'image' || n.type === 'video').map((n) => { try { return PROVIDERS.bridge.cost(buildRequest(n, engine.inputsOf(n)), ctx).catch(() => null); } catch { return null; } }));
      const known = costs.filter((c) => c != null);
      if (known.length) costLine = ` 예상 크레딧: ${known.reduce((a, b) => a + b, 0)}${known.length < spend.length ? ` (${spend.length - known.length}개는 아직 계산할 수 없음)` : ''}.`;
    }
    if (!(await confirmBox(what, `생성 노드 ${spend.length}개(${parts})를 실행합니다.${costLine} 결과가 이미 있고 설정이 그대로인 노드와 잠근 노드는 건너뜁니다.`))) return;
  }
  updateRunState(true);
  const failed = await engine.run(targetIds, force);
  if (failed.length) toast(`${failed.length}개 노드가 실패했습니다. 빨간 노드의 아래쪽 글을 확인하세요.`, 'error');
}
const actions = {
  runNode(id) { if (engine.isRunning(id) || graph.node(id)?.status === 'queued') return engine.stop(id); guarded([id], true, '노드 실행'); },
  runDownstream(id) { guarded([id, ...graph.downstream(id)], false, '여기부터 아래로 실행'); },
  // What exactly would be sent: the joined prompt, the model settings and the references. Nothing is submitted.
  preview(node) {
    let text;
    try { text = relayText(buildRequest(node, engine.inputsOf(node))).split('\n').slice(3).join('\n'); } catch (e) { text = e.message; }
    modal('보낼 요청', h('textarea', { rows: 16, readOnly: true, value: text }), [{ label: '닫기', primary: true }]);
  },
  async cost(node) {
    if (node.type !== 'image' && node.type !== 'video') return toast('이 노드는 예상 크레딧을 미리 알 수 없습니다');
    if (settings.mode !== 'bridge') return toast('예상 크레딧은 MCP 연결 모드에서 확인할 수 있습니다');
    try {
      const credits = await PROVIDERS.bridge.cost(buildRequest(node, engine.inputsOf(node)), { signal: new AbortController().signal, progress() {} });
      node.message = credits == null ? '예상 크레딧을 받지 못했습니다' : `예상 크레딧 ${credits}`;
    } catch (e) { node.message = e.message; }
    graph.emit('node:status', node);
  },
  // Expected credits under the node, in the connected mode (the server's cost preflight; nothing is submitted).
  async estimate(node) {
    let text = '';
    if (settings.mode === 'bridge' && serverReady(settings.server)) {
      try {
        const req = buildRequest(node, engine.inputsOf(node));
        const key = JSON.stringify({ ...req, prompt: req.prompt ? 1 : 0, medias: req.medias.map((m) => [m.role, m.item.jobId || m.item.mediaId || 0]) });
        if (!costCache.has(key)) costCache.set(key, PROVIDERS.bridge.cost(req, { signal: new AbortController().signal, progress() {} }).catch(() => null));
        const credits = await costCache.get(key);
        if (credits != null) text = `예상 크레딧 ${credits}${req.count > 1 ? ` · 변형 ${req.count}개` : ''}`;
      } catch { /* nothing to estimate yet (no prompt, no model) */ }
    }
    if (node.cost !== text) { node.cost = text; canvas.paintStatus(node); }
  },
  // "AI로 쓰기" on a text node: Claude writes the prompt from the instruction and the connected reference texts.
  async write(node) {
    const ask = (node.data.ask || '').trim();
    if (!ask) return toast('"AI에게 시킬 내용"을 먼저 쓰세요', 'error');
    const refs = (engine.inputsOf(node).ctx || []).map((i) => i.text).filter(Boolean);
    const prompt = [
      'You write prompts for AI image and video generation (photorealistic, live-action look unless told otherwise).',
      'Write the prompt asked for below. Output only the prompt text itself, in English, with no preface, no quotes, no markdown and no explanation.',
      refs.length ? `\nReference texts that this prompt must stay consistent with (do not repeat them verbatim):\n${refs.map((r, i) => `[${i + 1}] ${r}`).join('\n')}` : '',
      node.data.text.trim() ? `\nCurrent draft to revise:\n${node.data.text.trim()}` : '',
      `\nRequest${node.data.label ? ` (this text is used as: ${node.data.label})` : ''}:\n${ask}`,
    ].filter(Boolean).join('\n');
    const btn = canvas.els.get(node.id)?.querySelector('.action');
    if (btn) { btn.disabled = true; btn.textContent = '쓰는 중…'; }
    let text = null;
    try {
      if (bridge.online) {
        const res = await fetch(`${bridge.base}/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) });
        const body = await res.json().catch(() => ({}));
        if (res.ok) text = body.text;
        else if (res.status !== 501) throw new Error(body.error || '글을 쓰지 못했습니다');
      }
      // No bridge, or no Claude Code on this computer: hand the request to a Claude chat by copy and paste.
      if (text == null) text = await relayBox(prompt, 'text');
    } catch (e) { toast(e.message, 'error'); }
    if (text?.trim()) {
      graph.checkpoint();
      node.data.text = text.trim();
      canvas.paintFields(node);
      await canvas.recompute(node); canvas.refreshDependents(node);
      graph.emit('node:data', node);
    } else if (btn) { btn.disabled = false; btn.textContent = 'AI로 쓰기'; }
  },
  onSelection() {},
  onView(k) { $('zoomLabel').textContent = `${Math.round(k * 100)}%`; },
  onRunState() { updateRunState(); },
};
const costCache = new Map();
const canvas = new Canvas({ stage: $('stage'), graph, engine, actions });

function updateRunState(starting) {
  const n = graph.doc.nodes.filter((x) => x.status === 'running' || x.status === 'queued').length;
  $('runbar').hidden = !n && !starting;
  $('runText').textContent = n ? `실행 중 ${graph.doc.nodes.filter((x) => x.status === 'running').length} · 대기 ${graph.doc.nodes.filter((x) => x.status === 'queued').length}` : '준비 중';
}
graph.on((kind) => { if (kind === 'node:status' || kind === 'node:result') updateRunState(); if (kind === 'reset') $('docName').value = graph.doc.name; });

// ---- documents (every workflow lives in the library and is saved as you work)
let opening = false;
graph.onSave = (doc) => { if (!opening && doc.id) library.put(doc); };
function openDoc(doc, fit = true) {
  engine.stop(); graph.load(doc);
  // Fill in what instant nodes (text, joins, boards) produce so previews and "settings changed" marks are right from the start.
  for (const id of graph.order(graph.doc.nodes.map((n) => n.id))) { const n = graph.node(id); if (NODE_TYPES[n.type].instant && n.type !== 'frame') canvas.recompute(n); }
  if (fit) requestAnimationFrame(() => canvas.fit());
  else canvas.applyView();
}
// Leave the current workflow (saving it first) and show another one.
async function switchTo(doc, fit = true) {
  opening = true;
  try {
    clearTimeout(graph.saveTimer);
    if (graph.doc.id) await library.put(graph.doc);
    doc.id ||= library.newId();
    openDoc(doc, fit);
    await library.put(graph.doc);
    library.setLast(graph.doc.id);
  } finally { opening = false; }
}
const asNew = (doc) => ({ ...doc, id: library.newId(), updatedAt: undefined });
function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const when = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
async function showLibrary() {
  clearTimeout(graph.saveTimer);
  if (graph.doc.id) await library.put(graph.doc);
  await library.sync();
  const box = h('div.doc-list');
  let close;
  const draw = async () => {
    const list = await library.list();
    box.replaceChildren(...list.map((d) => h(`div.doc-row${d.id === graph.doc.id ? '.current' : ''}`, {},
      h('button.name', { onclick: async () => { close(); if (d.id !== graph.doc.id) await switchTo(await library.get(d.id), false); } }, h('b', {}, d.name || '이름 없는 워크플로우'), h('small', {}, `${when(d.updatedAt)} · 노드 ${d.nodes}개${d.id === graph.doc.id ? ' · 지금 열려 있음' : ''}`)),
      h('button', { title: '사본 만들기', onclick: async () => { const src = await library.get(d.id); await library.put(asNew({ ...src, name: `${src.name} 사본` })); draw(); } }, '복제'),
      d.id === graph.doc.id ? null : h('button.danger', { onclick: async () => { await library.remove(d.id); draw(); } }, '삭제'))));
  };
  await draw();
  const p = modal('내 워크플로우', h('div', {}, h('p', {}, '작업하는 동안 자동으로 저장됩니다. 이 브라우저에 보관되고, 브리지가 켜져 있으면 내 컴퓨터(~/.flow-bridge/workflows)에도 함께 저장됩니다.'), box), [{ label: '닫기', primary: true }]);
  close = () => document.querySelector('.modal-back')?.remove();
  return p;
}

$('docName').addEventListener('input', (e) => { graph.doc.name = e.target.value; graph.scheduleSave(); });
$('btnUndo').onclick = () => graph.undo() || toast('되돌릴 것이 없습니다');
$('btnRedo').onclick = () => graph.redo() || toast('다시 실행할 것이 없습니다');
$('btnAdd').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); const c = $('stage').getBoundingClientRect(); canvas.addMenu(Math.min(r.left, c.right - 320), c.top + 12); };
$('btnRun').onclick = () => guarded(graph.doc.nodes.filter((n) => !NODE_TYPES[n.type].note).map((n) => n.id), false, '전체 실행');
$('btnStop').onclick = () => engine.stop();
$('btnTemplates').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.left, r.bottom + 6, TEMPLATES.map((t) => ({ label: `${t.title} — ${t.hint}`, run: () => switchTo(asNew(t.doc())) })));
};
$('btnFile').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.left, r.bottom + 6, [
    { label: '내 워크플로우…', run: showLibrary },
    { label: '새 워크플로우', run: () => switchTo(asNew(emptyDoc()), false) },
    '-',
    { label: '파일에서 가져오기 (.flow.json)', run: () => $('fileInput').click() },
    { label: '파일로 내보내기 (.flow.json)', key: 'Ctrl+S', run: saveFile },
    '-',
    { label: '쓰지 않는 로컬 파일 정리', run: async () => { await sweepMedia(usedMedia()); toast('캔버스에서 쓰지 않는 로컬 이미지·영상을 지웠습니다'); } },
  ]);
};
function usedMedia() {
  const used = new Set();
  for (const n of graph.doc.nodes) { used.add(n.data.file); for (const r of [n.result, ...(n.history || [])]) for (const it of r?.items || []) used.add(it.url); }
  return used;
}
function saveFile() { download(`${(graph.doc.name || 'workflow').replace(/[\\/:*?"<>|]/g, '_')}.flow.json`, JSON.stringify(graph.doc, null, 1)); }
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try { await switchTo(asNew(JSON.parse(await file.text()))); } catch (err) { toast(`열 수 없습니다: ${err.message}`, 'error'); }
});

$('btnZoomIn').onclick = () => canvas.zoomBy(1.25);
$('btnZoomOut').onclick = () => canvas.zoomBy(0.8);
$('btnZoomReset').onclick = () => canvas.zoomBy(1 / graph.doc.view.k);
$('btnFit').onclick = () => canvas.fit(canvas.selectedNodes());
$('btnHelp').onclick = () => modal('단축키와 조작', h('dl', {}, [
  ['빈 곳 더블클릭 · 우클릭 · A', '노드 추가 (이름으로 찾기)'],
  ['포트에서 끌기', '연결. 빈 곳에 놓으면 이어 붙일 노드를 고릅니다'],
  ['연결선 클릭 → Delete', '연결 끊기'],
  ['빈 곳 끌기 / 휠', '화면 이동 / 확대·축소'],
  ['Shift + 끌기', '여러 노드 선택'],
  ['Ctrl+Enter', '선택한 노드 실행'],
  ['Ctrl+D / Ctrl+C·V', '복제 / 복사·붙여넣기'],
  ['Ctrl+Z / Ctrl+Shift+Z', '실행 취소 / 다시 실행'],
  ['F', '전체(또는 선택한 노드) 보기'],
  ['제목 더블클릭', '노드 이름 바꾸기 (예: 샷 1)'],
].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])), [{ label: '닫기', primary: true }]);

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-back, .lightbox')) return;
  const typing = e.target.closest?.('input,textarea,select,[contenteditable="true"]');
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (mod && key === 'enter') { e.preventDefault(); const ids = canvas.selectedNodes().filter((n) => !NODE_TYPES[n.type].instant).map((n) => n.id); if (ids.length) { document.activeElement?.blur?.(); guarded(ids, true, '선택한 노드 실행'); } return; }
  if (mod && key === 's') { e.preventDefault(); return saveFile(); }
  if (typing) return;
  if (mod && key === 'z') { e.preventDefault(); return e.shiftKey ? graph.redo() : graph.undo(); }
  if (mod && key === 'y') { e.preventDefault(); return graph.redo(); }
  if (mod && key === 'd') { e.preventDefault(); return canvas.duplicate(); }
  if (mod && key === 'c') return canvas.copy();
  if (mod && key === 'v') return canvas.paste();
  if (mod && key === 'a') { e.preventDefault(); return canvas.select(graph.doc.nodes.map((n) => n.id)); }
  if (mod) return;
  if (key === 'delete' || key === 'backspace') { e.preventDefault(); return canvas.deleteSelection(); }
  if (key === 'f') return canvas.fit(canvas.selectedNodes());
  if (key === 'a' || key === '/') { e.preventDefault(); const p = canvas.lastPointer || { x: innerWidth / 2, y: innerHeight / 2 }; return canvas.addMenu(p.x, p.y); }
  if (key === 'escape') return canvas.select([]);
});

// ---- connection panel
const MODES = [
  { id: 'demo', title: '데모', text: '실제 생성 없이 자리 그림으로 흐름을 확인합니다. 크레딧을 쓰지 않습니다.' },
  { id: 'bridge', title: 'MCP 연결', text: '내 컴퓨터에서 브리지 서버를 켜고 Higgsfield MCP에 로그인해 캔버스에서 바로 생성합니다.' },
  { id: 'relay', title: 'Claude 전달', text: '서버 없이 씁니다. 노드가 만든 요청을 Higgsfield 커넥터가 켜진 Claude 채팅에 붙여넣고, 결과 주소를 다시 붙여넣습니다.' },
];
function paintConn() {
  const btn = $('btnConn');
  const ready = serverReady(settings.server);
  $('connLabel').textContent = settings.mode === 'demo' ? '데모' : settings.mode === 'relay' ? 'Claude 전달' : ready ? `${bridge.servers.find((x) => x.id === settings.server)?.name || 'MCP'} 연결됨` : bridge.online ? '로그인 필요' : '브리지 꺼짐';
  btn.dataset.state = settings.mode === 'bridge' ? (ready ? 'on' : 'warn') : '';
}
async function loadCatalog() {
  const all = [];
  for (const type of ['image', 'video']) {
    let after;
    for (let page = 0; page < 6; page++) {
      const res = await fetch(`${bridge.base}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: settings.server, tool: 'models_explore', args: { action: 'list', type, limit: 100, ...(after ? { after } : {}) } }) }).then((r) => r.json());
      const data = toolData(res);
      all.push(...(data.items || []));
      if (!data.has_more || !data.next_page_token) break;
      after = String(data.next_page_token);
    }
  }
  const n = setModels(all);
  if (!n) throw new Error('모델 목록을 받지 못했습니다');
  graph.emit('reset');
  return n;
}
// After the bridge comes up: connect Higgsfield and fetch the model list, without further clicks.
// A first-time login still needs the person: the login window is opened, or the 로그인 button is left to press.
async function autoConnect() {
  const id = settings.server;
  if (!bridge.servers.some((s) => s.id === id)) return;
  try {
    if (!serverReady(id)) {
      const r = await bridgeApi.connect(id);
      if (r.authUrl) {
        const win = window.open(r.authUrl, '_blank');
        toast(win ? '새 창에서 Higgsfield 로그인을 마치면 이어서 연결합니다' : 'Higgsfield 로그인이 필요합니다. 아래 "로그인"을 누르세요.');
        if (!win) { await refreshBridge(); return; }
        for (let i = 0; i < 90 && !serverReady(id); i++) { await new Promise((res) => setTimeout(res, 2000)); await refreshBridge(); }
      }
      await refreshBridge();
    }
    if (!serverReady(id)) { const srv = bridge.servers.find((s) => s.id === id); if (srv?.error) toast(`Higgsfield 연결 실패: ${srv.error}`, 'error'); return; }
    const n = await loadCatalog();
    toast(`${bridge.servers.find((x) => x.id === id)?.name || 'MCP'}에 연결했고 모델 ${n}개를 받았습니다`);
  } catch (e) { toast(e.message, 'error'); }
}
// Tool nodes list what the connected servers offer, so they are redrawn when that changes.
function repaintTools() { for (const n of graph.doc.nodes) if (n.type === 'tool') { canvas.paintFields(n); } canvas.queueEdges(); }
async function drawConn() {
  repaintTools();
  const panel = $('connPanel');
  if (panel.hidden) return paintConn();
  const busy = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'error'); } await refreshBridge(); drawConn(); };
  const kids = [
    h('h2', {}, '연결', h('button', { onclick: () => { panel.hidden = true; } }, '닫기')),
    h('p', {}, '캔버스를 짜는 것은 어느 방식에서도 무료이고, 생성 노드를 실행할 때만 Higgsfield 크레딧이 듭니다.'),
    h('div.modes', {}, MODES.map((m) => h('label.mode', {}, h('input', { type: 'radio', name: 'mode', checked: settings.mode === m.id, onchange: async () => { settings.mode = m.id; saveSettings(); if (m.id === 'bridge') await refreshBridge(); drawConn(); } }), h('b', {}, m.title), h('small', {}, m.text)))),
  ];
  if (settings.mode === 'bridge') {
    const url = h('input', { type: 'text', value: settings.bridgeUrl, 'aria-label': '브리지 주소', onchange: async (e) => { settings.bridgeUrl = e.target.value.trim() || 'http://localhost:8787'; saveSettings(); await refreshBridge(); drawConn(); } });
    // "확인": if the bridge does not answer, ask the macOS helper (flowbridge://start, set up by install-mac.sh) to start it.
    const check = h('button', {}, bridge.online ? '확인' : '켜기 · 확인');
    check.onclick = async () => {
      check.disabled = true;
      await refreshBridge();
      if (!bridge.online) {
        toast('브리지를 켜는 중입니다');
        location.href = 'flowbridge://start';
        for (let i = 0; i < 12 && !bridge.online; i++) { await new Promise((res) => setTimeout(res, 1000)); await refreshBridge(); }
      }
      if (bridge.online) { await autoConnect(); library.sync(); }
      drawConn();
      if (!bridge.online) toast('브리지가 켜지지 않았습니다. 아래 안내를 확인하세요.', 'error');
    };
    const off = bridge.online ? h('button', { title: '브리지 서버를 끕니다', onclick: async () => { await bridgeApi.shutdown().catch(() => {}); await new Promise((res) => setTimeout(res, 400)); await refreshBridge(); drawConn(); toast('브리지를 껐습니다'); } }, '끄기') : null;
    kids.push(h('h3', {}, '브리지 서버'),
      h('div.row', {}, url, check, off,
        h('span', { className: `badge ${bridge.online ? 'on' : 'warn'}` }, bridge.online ? '켜짐' : '꺼짐')));
    if (!bridge.online) {
      kids.push(h('p', {}, 'Mac에서는 한 번만 설치해 두면 위 "켜기 · 확인" 버튼이 브리지를 켭니다. 처음 누를 때 Chrome이 "Flow Bridge 열기"를 물으면 허용하세요. 터미널에서 이 저장소의 flow/server 폴더로 가서:'),
        h('pre.cmd', {}, './install-mac.sh'),
        h('p', {}, '설치 없이 직접 켜려면 (Node.js 20 이상):'),
        h('pre.cmd', {}, 'cd flow/server\nnpm install\nnpm start'));
    } else {
      kids.push(h('h3', {}, 'MCP 서버'));
      for (const s of bridge.servers) {
        const on = s.state === 'connected';
        const act = h('button', {}, on ? '로그아웃' : s.state === 'needs_auth' ? '로그인' : '연결');
        act.onclick = busy(act, async () => {
          if (on) return bridgeApi.logout(s.id);
          const r = await bridgeApi.connect(s.id);
          if (r.authUrl) {
            window.open(r.authUrl, '_blank', 'noopener');
            toast('새 창에서 로그인과 승인을 마치면 자동으로 연결됩니다');
            for (let i = 0; i < 90 && !serverReady(s.id); i++) { await new Promise((res) => setTimeout(res, 2000)); await refreshBridge(); }
          }
        });
        const del = s.builtin ? null : h('button.danger', {}, '삭제');
        if (del) del.onclick = busy(del, () => bridgeApi.removeServer(s.id));
        kids.push(h('div.server', {},
          h('div.row', {}, h('b', {}, s.name), h('span', { className: `badge ${on ? 'on' : 'warn'}` }, on ? `연결됨 · 도구 ${s.toolCount}` : s.state === 'needs_auth' ? '로그인 필요' : s.state === 'connecting' ? '연결 중' : '연결 안 됨'), act, del),
          h('small', {}, s.url), s.error ? h('small.err', {}, s.error) : null));
      }
      const name = h('input', { type: 'text', placeholder: '이름 (예: my-mcp)' }), surl = h('input', { type: 'text', placeholder: 'https://…/mcp' });
      const add = h('button', {}, '추가');
      add.onclick = busy(add, async () => { if (!name.value.trim() || !surl.value.trim()) throw new Error('이름과 주소를 넣으세요'); await bridgeApi.addServer(name.value.trim(), surl.value.trim()); });
      kids.push(h('p', {}, '다른 원격 MCP 서버(Streamable HTTP)도 추가할 수 있습니다. 추가한 서버의 도구는 "MCP 도구" 노드에서 고릅니다.'), h('div.row', {}, name), h('div.row', {}, surl, add));

      if (serverReady(settings.server)) {
        const cat = h('button', {}, '모델 목록 새로 받기');
        cat.onclick = busy(cat, async () => toast(`모델 ${await loadCatalog()}개를 받았습니다`));
        const bal = h('button', {}, '크레딧 확인');
        const balOut = h('small', {});
        bal.onclick = async () => {
          try {
            const res = await fetch(`${bridge.base}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: settings.server, tool: 'balance', args: {} }) }).then((r) => r.json());
            const d = toolData(res);
            balOut.textContent = d.credits != null ? `남은 크레딧 ${d.credits}${d.plan ? ` · ${typeof d.plan === 'string' ? d.plan : d.plan.name || ''}` : ''}` : (d.text || JSON.stringify(d)).slice(0, 200);
          } catch (e) { balOut.textContent = e.message; }
        };
        kids.push(h('h3', {}, 'Higgsfield'), h('div.row', {}, cat, bal), balOut,
          h('p', {}, isLiveCatalog() ? `서버에서 받은 모델 목록을 쓰는 중입니다 (이미지 ${listModels('image').length} · 영상 ${listModels('video').length}).` : '지금은 페이지에 들어 있는 기본 모델 목록을 씁니다.'));
      }
      const ready = bridge.servers.filter((s) => s.state === 'connected');
      if (ready.length > 1 || (ready.length === 1 && ready[0].id !== settings.server)) {
        const pick = h('select', { onchange: (e) => { settings.server = e.target.value; saveSettings(); drawConn(); } }, bridge.servers.map((s) => h('option', { value: s.id, selected: settings.server === s.id }, s.name)));
        kids.push(h('h3', {}, '이미지·영상 생성에 쓸 서버'), h('div.row', {}, pick), h('p', {}, 'Higgsfield와 같은 도구(generate_image, generate_video, jobs_wait)를 가진 서버여야 합니다.'));
      }
      const par = h('select', { onchange: (e) => { settings.parallel = +e.target.value; saveSettings(); } }, [1, 2, 3, 4, 6].map((n) => h('option', { value: n, selected: +settings.parallel === n }, `${n}개`)));
      kids.push(h('h3', {}, '동시에 생성할 노드 수'), h('div.row', {}, par));
    }
  }
  if (settings.mode === 'relay') kids.push(h('h3', {}, '쓰는 법'), h('p', {}, '생성 노드를 실행하면 요청문이 뜹니다. 복사해 Claude 채팅에 붙여넣고, Claude가 답한 결과 주소를 다시 붙여넣으면 노드에 결과가 들어갑니다. 내 컴퓨터의 파일을 레퍼런스로 쓰려면 그 채팅에 파일을 직접 올려야 합니다.'));
  panel.replaceChildren(...kids);
  paintConn();
}
$('btnConn').onclick = async () => { const p = $('connPanel'); p.hidden = !p.hidden; if (!p.hidden && settings.mode === 'bridge') await refreshBridge(); drawConn(); };

// ---- start
(async () => {
  await initMedia();
  await library.migrate();
  const tpl = TEMPLATES.find((t) => t.id === location.hash.slice(1));
  const list = await library.list();
  let doc = null;
  if (tpl) {
    // A template link opens the workflow already made from it, if there is one, instead of piling up copies.
    const made = tpl.doc();
    const existing = list.find((d) => d.name === made.name);
    doc = existing ? await library.get(existing.id) : asNew(made);
  } else doc = (await library.get(library.last())) || (list[0] && (await library.get(list[0].id))) || asNew(TEMPLATES[0].doc());
  await switchTo(doc, !doc.updatedAt);
  if (settings.mode === 'bridge') { await refreshBridge(); repaintTools(); library.sync(); canvas.queueCost(); }
  paintConn();
  window.flow = { graph, engine, canvas, settings, currentProvider, library };
})();
// Save at once when the page is being closed or hidden, not only after the short delay.
addEventListener('pagehide', () => { if (graph.doc.id) library.put(graph.doc); });
document.addEventListener('visibilitychange', () => { if (document.hidden && graph.doc.id) library.put(graph.doc); });
