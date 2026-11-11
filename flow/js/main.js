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
  onSelection() {},
  onView(k) { $('zoomLabel').textContent = `${Math.round(k * 100)}%`; },
  onRunState() { updateRunState(); },
};
const canvas = new Canvas({ stage: $('stage'), graph, engine, actions });

function updateRunState(starting) {
  const n = graph.doc.nodes.filter((x) => x.status === 'running' || x.status === 'queued').length;
  $('runbar').hidden = !n && !starting;
  $('runText').textContent = n ? `실행 중 ${graph.doc.nodes.filter((x) => x.status === 'running').length} · 대기 ${graph.doc.nodes.filter((x) => x.status === 'queued').length}` : '준비 중';
}
graph.on((kind) => { if (kind === 'node:status' || kind === 'node:result') updateRunState(); if (kind === 'reset') $('docName').value = graph.doc.name; });

// ---- documents
function openDoc(doc, fit = true) {
  engine.stop(); graph.load(doc);
  // Fill in what instant nodes (text, joins, boards) produce so previews and "settings changed" marks are right from the start.
  for (const id of graph.order(graph.doc.nodes.map((n) => n.id))) { const n = graph.node(id); if (NODE_TYPES[n.type].instant && n.type !== 'frame') canvas.recompute(n); }
  if (fit) requestAnimationFrame(() => canvas.fit());
}
function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function replaceGuard() { return !graph.doc.nodes.length || confirmBox('워크플로우 바꾸기', '지금 캔버스의 워크플로우를 닫고 새로 엽니다. 필요하면 먼저 파일 → 저장으로 내려받으세요.', '바꾸기'); }

$('docName').addEventListener('input', (e) => { graph.doc.name = e.target.value; graph.scheduleSave(); });
$('btnUndo').onclick = () => graph.undo() || toast('되돌릴 것이 없습니다');
$('btnRedo').onclick = () => graph.redo() || toast('다시 실행할 것이 없습니다');
$('btnAdd').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); const c = $('stage').getBoundingClientRect(); canvas.addMenu(Math.min(r.left, c.right - 320), c.top + 12); };
$('btnRun').onclick = () => guarded(graph.doc.nodes.filter((n) => !NODE_TYPES[n.type].note).map((n) => n.id), false, '전체 실행');
$('btnStop').onclick = () => engine.stop();
$('btnTemplates').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.left, r.bottom + 6, TEMPLATES.map((t) => ({ label: `${t.title} — ${t.hint}`, run: async () => { if (await replaceGuard()) openDoc(t.doc()); } })));
};
$('btnFile').onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  menu(r.left, r.bottom + 6, [
    { label: '새 워크플로우', run: async () => { if (await replaceGuard()) openDoc(emptyDoc(), false); } },
    { label: '열기 (.flow.json)', run: () => $('fileInput').click() },
    { label: '저장 (.flow.json)', key: 'Ctrl+S', run: saveFile },
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
  try { const doc = JSON.parse(await file.text()); if (await replaceGuard()) openDoc(doc); } catch (err) { toast(`열 수 없습니다: ${err.message}`, 'error'); }
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
    kids.push(h('h3', {}, '브리지 서버'),
      h('div.row', {}, url, h('button', { onclick: async () => { await refreshBridge(); drawConn(); toast(bridge.online ? '브리지에 연결했습니다' : '브리지에 닿지 않습니다', bridge.online ? '' : 'error'); } }, '확인'),
        h('span', { className: `badge ${bridge.online ? 'on' : 'warn'}` }, bridge.online ? '켜짐' : '꺼짐')));
    if (!bridge.online) {
      kids.push(h('p', {}, '이 저장소의 flow/server 폴더에서 아래 명령으로 브리지를 켭니다 (Node.js 20 이상). 켠 뒤 http://localhost:8787 로 이 페이지를 열면 가장 확실합니다.'),
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
  const hash = location.hash.slice(1);
  const tpl = TEMPLATES.find((t) => t.id === hash);
  if (tpl) openDoc(tpl.doc());
  else if (graph.loadSaved()) { openDoc(graph.doc, false); canvas.applyView(); }
  else openDoc(TEMPLATES[0].doc());
  if (settings.mode === 'bridge') { await refreshBridge(); repaintTools(); }
  paintConn();
  window.flow = { graph, engine, canvas, settings, currentProvider };
})();
