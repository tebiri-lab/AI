// Page wiring: toolbar, shortcuts, run guards, file open/save, connection panel.
import { Graph, emptyDoc } from './graph.js';
import { Engine } from './engine.js';
import { Canvas } from './canvas.js';
import { NODE_TYPES, buildRequest, finalizeRequest, describeRefs, upscaleRequest, TAG_PORTS } from './nodes.js';
import { TEMPLATES } from './templates.js';
import { initMedia, sweepMedia, displayUrl, frameBlobs, pictureData, saveBlob } from './media.js';
import { settings, saveSettings, bridge, refreshBridge, bridgeApi, serverReady, currentProvider, toolData, relayText, PROVIDERS, LLM_MODELS, llmModel } from './providers.js';
import { setModels, isLiveCatalog, listModels } from './models.js';
import { h, toast, menu, modal, confirmBox, askBox, relayBox, refStrip } from './ui.js';
import { library } from './library.js';
import { initAgent } from './agent.js';

const $ = (id) => document.getElementById(id);
const graph = new Graph();
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
// Turn addresses and job numbers (pasted, or dragged in from the Higgsfield site) into results. A Higgsfield address
// carries its job number in the file name; with it the result is looked up on the server, which gives the full-size
// file even when the address was a small preview, and keeps the server id so it is never uploaded again.
async function resolveResults(text, kind) {
  const urls = [...new Set(text.match(/https?:\/\/[^\s"'<>]+/g) || [])];
  const ids = [...new Set(text.match(UUID_RE) || [])];
  let found = new Map(), failed = '';
  if (ids.length && settings.mode === 'bridge' && serverReady(settings.server)) {
    try { found = new Map((await PROVIDERS.bridge.lookup(ids, kind)).map((r) => [r.id, r.url])); } catch (e) { failed = e.message; }
  }
  const list = [], used = new Set();
  for (const url of urls) {
    const id = (url.match(UUID_RE) || [])[0];
    if (id && used.has(id)) continue;
    if (id) used.add(id);
    const known = id && found.has(id);
    list.push({ id: known ? id : url, noJob: !known, type: kind, model: '', at: Date.now(), url: known ? found.get(id) : url, thumb: known ? found.get(id) : url, prompt: '', refs: [], from: '붙여넣은 주소' });
  }
  for (const id of ids) if (!used.has(id) && found.has(id)) list.push({ id, type: kind, model: '', at: Date.now(), url: found.get(id), thumb: found.get(id), prompt: '', refs: [], from: '붙여넣은 작업 번호' });
  const missing = ids.filter((id) => !used.has(id) && !found.has(id)).length;
  return { list, missing, failed };
}

// Every job this canvas submits is remembered in the browser (job numbers, model, prompt). Higgsfield's own history
// list leaves some models out, so this is what lets a result be found again whatever model made it.
const JOBS_KEY = 'flow.jobs.v1';
const jobLog = { all() { try { return JSON.parse(localStorage.getItem(JOBS_KEY) || '[]'); } catch { return []; } },
  add(e) { try { localStorage.setItem(JOBS_KEY, JSON.stringify([e, ...this.all()].slice(0, 300))); } catch { /* not remembered */ } } };
const engine = new Engine(graph, { ask: askBox, relay: relayBox,
  onJobs: ({ ids, kind, at, request, node }) => jobLog.add({ ids, kind, at, model: request?.model, prompt: request?.prompt || '', resolution: request?.resolution, aspect: request?.aspect, duration: request?.duration, refs: (request?.refs || []).filter((r) => /^https?:/.test(r.url || '')), label: node.data.label || NODE_TYPES[node.type].title }) });

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
    if (!(await confirmBox(what, `생성 노드 ${spend.length}개(${parts})를 실행합니다.${costLine} 결과가 이미 있고 설정이 그대로인 노드와 잠근 노드는 건너뜁니다.`))) return null;
  }
  updateRunState(true);
  const failed = await engine.run(targetIds, force);
  if (failed.length) toast(`${failed.length}개 노드가 실패했습니다. 빨간 노드의 아래쪽 글을 확인하세요.`, 'error');
  return failed; // null = the person cancelled
}
const actions = {
  runNode(id) { if (engine.isRunning(id) || graph.node(id)?.status === 'queued') return engine.stop(id); guarded([id], true, '노드 실행'); },
  runDownstream(id) { guarded([id, ...graph.downstream(id)], false, '여기부터 아래로 실행'); },
  // What exactly would be sent: the joined prompt, the model settings and the references. Nothing is submitted.
  preview(node) {
    let text, refs = [];
    try {
      const req = buildRequest(node, engine.inputsOf(node));
      text = relayText(req).split('\n').slice(3).filter((l) => !/^medias\[/.test(l)).join('\n');
      refs = describeRefs(req.medias).map((r) => ({ ...r, url: displayUrl(r.url) }));
    } catch (e) { text = e.message; }
    modal('보낼 요청', h('div', {},
      refs.length ? h('p', {}, `첨부되는 레퍼런스 ${refs.length}개`) : null, refs.length ? refStrip(refs) : null,
      h('textarea', { rows: 14, readOnly: true, value: text })), [{ label: '닫기', primary: true }]);
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
        const req = node.type === 'vupscale' ? await upscaleRequest(node, engine.inputsOf(node)) : buildRequest(node, engine.inputsOf(node));
        if (req.tool) throw new Error('no preflight'); // the dedicated upscalers do not quote a price beforehand
        const key = JSON.stringify({ ...req, prompt: req.prompt ? 1 : 0, medias: req.medias.map((m) => [m.role, m.item.jobId || m.item.mediaId || 0]) });
        if (!costCache.has(key)) costCache.set(key, PROVIDERS.bridge.cost(req, { signal: new AbortController().signal, progress() {} }).catch(() => null));
        const credits = await costCache.get(key);
        if (credits != null) text = `예상 크레딧 ${credits}${req.count > 1 ? ` · 변형 ${req.count}개` : ''}`;
      } catch { /* nothing to estimate yet (no prompt, no model) */ }
    }
    if (node.cost !== text) { node.cost = text; canvas.paintStatus(node); }
  },
  // "생성 기록에서 결과 가져오기": pick generations that already exist on Higgsfield (made elsewhere, or lost to a reload
  // before results could be picked up) and attach them to this node as a new version.
  async adopt(node) {
    if (settings.mode !== 'bridge' || !serverReady(settings.server)) return toast('생성 기록은 MCP에 연결된 상태에서 불러올 수 있습니다', 'error');
    const kind = node.type;
    let mine = '';
    try { mine = buildRequest(node, engine.inputsOf(node)).prompt.trim(); } catch { /* no prompt yet: nothing to match against */ }
    const picked = new Map();
    const grid = h('div.history-grid'), more = h('button', {}, '더 보기'), status = h('p.hint', {}, '불러오는 중…');
    let cursor = null, take = null;
    const sync = () => { if (!take) return; take.disabled = !picked.size; take.textContent = picked.size ? `${picked.size}개 가져오기` : '가져오기'; };
    const card = (g) => {
      const same = mine && g.prompt.trim() === mine;
      const el = h(`button.history-card${same ? '.same' : ''}`, { title: g.prompt.slice(0, 600), 'aria-pressed': 'false', onclick: () => {
        if (picked.has(g.id)) picked.delete(g.id); else picked.set(g.id, g);
        el.classList.toggle('on', picked.has(g.id)); el.setAttribute('aria-pressed', String(picked.has(g.id))); sync();
      } },
        /\.(mp4|webm|mov)(\?|$)/i.test(g.thumb) ? h('video', { src: g.thumb, muted: true, preload: 'metadata' }) : h('img', { src: g.thumb, alt: '', loading: 'lazy' }),
        h('span', {}, h('b', {}, g.model || g.from || ''), h('small', {}, `${[g.model && g.from, when(g.at)].filter(Boolean).join(' · ')}${same ? ' · 이 노드의 프롬프트와 같음' : ''}`)));
      return el;
    };
    const seen = new Set(), served = new Map(), tally = h('p.hint.history-tally');
    const addCards = (list, front) => {
      const fresh = list.filter((g) => !seen.has(g.id));
      for (const g of fresh) seen.add(g.id);
      const els = fresh.map(card);
      if (front) grid.prepend(...els); else grid.append(...els);
      return els;
    };
    const say = () => { status.textContent = grid.children.length ? '가져올 결과를 누르세요. 여러 개를 고르면 한 버전의 변형으로 함께 들어옵니다.' : `찾은 ${kind === 'video' ? '영상이' : '이미지가'} 없습니다. 아래에 결과 주소나 작업 번호를 붙여넣어 연결할 수 있습니다.`; };
    // Results made from exactly this node's prompt come first: those are most likely the ones looked for.
    const mineFirst = (list) => [...list.filter((g) => mine && g.prompt.trim() === mine), ...list.filter((g) => !(mine && g.prompt.trim() === mine))];
    // 1) what this canvas itself submitted (any model), 2) Higgsfield's history list (which leaves some models out)
    const loadLog = async () => {
      const entries = jobLog.all().filter((e) => e.kind === kind).slice(0, 40);
      if (!entries.length) return;
      try {
        const found = new Map((await PROVIDERS.bridge.lookup(entries.flatMap((e) => e.ids), kind)).map((r) => [r.id, r.url]));
        addCards(mineFirst(entries.flatMap((e) => e.ids.filter((id) => found.has(id)).map((id) => ({ id, type: kind, model: e.model, at: e.at, url: found.get(id), thumb: found.get(id), prompt: e.prompt, resolution: e.resolution, aspect: e.aspect, duration: e.duration, refs: e.refs || [], from: `이 캔버스 · ${e.label}` })))), true);
      } catch { /* the log is a convenience; the history list below still loads */ }
      say();
    };
    const load = async () => {
      more.disabled = true;
      try {
        const page = await PROVIDERS.bridge.history(kind, cursor);
        // Say what Higgsfield's list actually returned, so a missing result can be told apart from a filtered one.
        for (const g of page.items) served.set(g.model || '모델 없음', (served.get(g.model || '모델 없음') || 0) + 1);
        tally.textContent = `Higgsfield 기록 목록이 돌려준 것${spaces.active ? ` (작업 공간: ${spaces.active.name})` : ''}: ${served.size ? [...served].map(([m, n]) => `${m} ${n}개`).join(', ') : '없음'}${page.next != null ? ' · 더 있음' : ''}`;
        addCards(cursor == null ? mineFirst(page.items) : page.items);
        cursor = page.next; more.hidden = cursor == null; more.disabled = false;
        say();
      } catch (e) { status.textContent = `생성 기록을 불러오지 못했습니다: ${e.message}`; more.hidden = true; }
    };
    more.onclick = load;
    // 3) anything else: paste the address of a result (or its job number) copied from Higgsfield
    const paste = h('input', { type: 'text', placeholder: '결과 이미지·영상 주소(https://…) 또는 작업 번호를 붙여넣기 (여러 개 가능)', 'aria-label': '결과 주소 또는 작업 번호' });
    const addPasted = async () => {
      const { list, missing, failed } = await resolveResults(paste.value, kind);
      if (failed) toast(`작업 번호를 조회하지 못했습니다: ${failed}`, 'error');
      else if (missing) toast('완료된 결과를 찾지 못한 작업 번호가 있습니다', 'error');
      if (!list.length) { if (!failed && !missing) toast('주소(https://…)나 작업 번호를 찾지 못했습니다', 'error'); return; }
      for (const el of addCards(list, true)) el.click(); // pasted on purpose: start selected
      paste.value = ''; say();
    };
    paste.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addPasted(); } });
    const pasteRow = h('div.row.history-paste', {}, paste, h('button', { onclick: addPasted }, '추가'));
    // History only covers the active workspace: say which one, and let it be switched right here.
    await loadSpaces();
    const where = h('div.row.history-space');
    const drawWhere = () => where.replaceChildren(...(spaces.list.length > 1
      ? [h('span', {}, '작업 공간'), spacePicker(() => { picked.clear(); sync(); grid.replaceChildren(); seen.clear(); served.clear(); cursor = null; status.textContent = '불러오는 중…'; drawWhere(); loadLog().then(load); })]
      : []));
    drawWhere();
    const note = h('p.hint', {}, 'Higgsfield 사이트(이미지·에셋 탭)에는 보이는데 여기 목록에 없는 결과가 있을 수 있습니다. 사이트는 자체 목록을 쓰고, 외부 앱에는 위의 기록 목록만 제공하기 때문입니다. 그런 결과는 사이트에서 이미지를 이 노드 위로 끌어다 놓거나, 이미지 주소를 복사해 위 칸에 붙여넣으면 연결됩니다. 이 캔버스에서 보낸 작업은 모델과 관계없이 목록 맨 위에 나옵니다.');
    const shown = modal(`생성 기록에서 가져오기 — ${node.data.label || NODE_TYPES[node.type].title}`, h('div', {}, where, status, grid, h('div.history-more', {}, more), tally, pasteRow, note), [{ label: '취소', value: false }, { label: '가져오기', value: true, primary: true }], 'wide');
    take = [...document.querySelectorAll('.modal-back')].pop().querySelector('.primary');
    sync(); loadLog().then(load);
    if (!(await shown)) return;
    if (!picked.size) return;
    const list = [...picked.values()], first = list[0];
    graph.checkpoint();
    engine.adopt(node, list.map((g) => ({ type: g.type, url: g.url, ...(g.noJob ? {} : { jobId: g.id }) })), { model: first.model, prompt: first.prompt, resolution: first.resolution, aspect: first.aspect, duration: first.duration, refs: first.refs });
    toast(`생성 기록의 결과 ${list.length}개를 v${node.result.v} 버전으로 가져왔습니다`);
  },
  // A picture or video dropped on a generation node (from the Higgsfield site in another tab or window, or a file
  // from the computer) becomes that node's result, as a new version.
  async attach(node, { files, link }) {
    const kind = node.type, items = [];
    for (const file of files) if (file.type.startsWith(`${kind}/`)) items.push({ type: kind, url: await saveBlob(file), name: file.name, local: true });
    let request = { model: '', prompt: '' };
    if (link) {
      const { list } = await resolveResults(link, kind);
      for (const g of list) items.push({ type: kind, url: g.url, ...(g.noJob ? {} : { jobId: g.id }) });
      // A job this canvas sent itself: its model and prompt are known.
      const mine = jobLog.all().find((e) => e.ids.some((id) => list.some((g) => g.id === id)));
      if (mine) request = { model: mine.model, prompt: mine.prompt, resolution: mine.resolution, aspect: mine.aspect, duration: mine.duration, refs: mine.refs };
    }
    if (!items.length) return toast(`${kind === 'video' ? '영상' : '이미지'} 생성 노드에는 ${kind === 'video' ? '영상' : '이미지'}만 결과로 붙일 수 있습니다`, 'error');
    graph.checkpoint();
    engine.adopt(node, items, request);
    toast(`${node.data.label || NODE_TYPES[node.type].title}에 결과 ${items.length}개를 v${node.result.v} 버전으로 붙였습니다`);
  },
  // "1080p로 완성 / 4K로 완성": render the picked draft again at full resolution. Shows the price first when it is known.
  async finalize(node, item, resolution) {
    if (engine.isRunning(node.id)) return;
    const label = resolution === '4k' ? '4K' : resolution;
    let costLine = '';
    if (settings.mode === 'bridge' && serverReady(settings.server)) {
      const credits = await PROVIDERS.bridge.cost(finalizeRequest(node, item, resolution), { signal: new AbortController().signal, progress() {} }).catch(() => null);
      if (credits != null) costLine = ` 예상 크레딧: ${credits}.`;
    }
    if (settings.mode !== 'demo' && !(await confirmBox(`${label}로 완성`, `v${node.result.v} 드래프트를 ${label}로 다시 생성합니다.${costLine} 드래프트와 같은 길이로 만들어지고, 결과는 이 노드의 새 버전으로 들어옵니다.`, '생성'))) return;
    updateRunState(true);
    if (!(await engine.finalize(node, item, resolution, finalizeRequest))) toast('완성하지 못했습니다. 노드 아래쪽 글을 확인하세요.', 'error');
  },
  // "피드백 받기" on a feedback node: Claude looks at the connected results (for a video: its first, middle and last
  // frame) next to the prompt they were made with, says what went wrong and writes a revised prompt.
  async review(node) {
    const attached = engine.sourcesOf(node, 'media');
    if (!attached.length) return toast('피드백 받을 결과(이미지·영상)를 왼쪽 "결과" 포트에 연결하세요', 'error');
    const given = (engine.inputsOf(node).prompt || []).map((i) => i.text).filter(Boolean).join('\n\n');
    const used = given || [...new Set(attached.map(({ src }) => src.result?.request?.prompt).filter(Boolean))].join('\n\n---\n\n');
    const btn = canvas.els.get(node.id)?.querySelector('.action');
    if (btn) { btn.disabled = true; btn.textContent = '결과를 보는 중…'; }
    node.writing = true; node.wrote = false; node.startedAt = Date.now(); canvas.paintStatus(node);
    let answer = null;
    try {
      const { images, lines } = await picturesOf(attached, 'Result', 'generated');
      // What each @Image tag of that generation actually was: its name, and (while there is room) the picture itself,
      // so a result can be checked against the right reference and mixed-up roles can be spotted.
      const refs = [], refSeen = new Set();
      for (const { src } of attached) {
        const feeders = graph.edgesInto(src.id).map((e) => graph.node(e.from.node)).filter(Boolean);
        for (const r of src.result?.request?.refs || []) {
          if (!r.label.startsWith('@') || refSeen.has(r.label)) continue;
          refSeen.add(r.label);
          const from = feeders.find((n) => [n.result, ...(n.history || [])].some((x) => (x?.items || []).some((it) => it.url === r.url)));
          refs.push({ ...r, name: from ? from.data.label || NODE_TYPES[from.type].title : '' });
        }
      }
      const refTags = refs.map((r) => r.label);
      for (const r of refs) {
        if (images.length >= 8 || r.type !== 'image') break;
        const pic = await pictureData(r.url);
        images.push({ ...(pic || { url: r.url }), label: `reference ${r.label}${r.name ? ` (${r.name})` : ''} — an input of the generation, not a result` });
      }
      const sentRefs = images.filter((x) => x.label.startsWith('reference')).length;
      const prompt = [
        'You are reviewing the output of an AI image/video generation for a filmmaker who wants photorealistic, live-action looking footage.',
        'Look at the result pictures, compare them with the prompt that produced them and with what the filmmaker says, then answer.',
        '', ...lines, '',
        `Prompt that was used:\n${used || '(not available)'}`, '',
        'Two different numberings are in play. "결과 1", "결과 2" (Result 1, 2) are the generated outputs listed above. "@Image 1", "@Image 2" are the reference inputs of the prompt. When the filmmaker writes "이미지 1" without the @, decide from the context which of the two is meant and say in the diagnosis how you read it.', '',
        ...(refs.length ? [`What each reference tag of that generation actually is: ${refs.map((r) => `${r.label}${r.name ? ` = ${r.name}` : ''}`).join(', ')}.${sentRefs ? ' Their pictures are attached too, labelled "reference".' : ''} Check that the prompt gives each tag the role its reference can really play (a person photo cannot be the layout template, a style sheet cannot be the identity); if roles are attached to the wrong tag, say so first in the diagnosis and fix it in the revised prompt.`, ''] : []),
        ...(refTags.length ? [`References that were attached to that generation: ${refTags.join(', ')}. The revised prompt is used with the same references, so point at them with these tags (and say what each is used for) instead of describing a person or place from scratch.`, ''] : []),
        `What the filmmaker is unhappy with or wants instead:\n${node.data.note.trim() || '(nothing written: find where the result fails the prompt or looks artificial)'}`, '',
        'Answer in exactly this format and nothing else:',
        '[진단]',
        '(In Korean. 3 to 6 short bullet lines starting with "- ": what in the result differs from the intent, and the most likely cause in the prompt or settings.)',
        '[수정 프롬프트]',
        '(The complete revised prompt in English, ready to use as it is. Keep reference tags such as @Image 1 or @[Image 1](image_1) exactly as they are. No commentary.)',
      ].join('\n');
      if (bridge.online) {
        const res = await fetch(`${bridge.base}/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, images, model: llmModel('review') }) });
        const body = await res.json().catch(() => ({}));
        if (res.ok) answer = body.text;
        else if (res.status !== 501) toast(/authenticat|OAuth|login|log in/i.test(body.error || '') ? '이 컴퓨터의 Claude Code 로그인이 만료되었습니다. 터미널에서 claude 를 실행해 /login 하세요. 지금은 Claude 채팅 전달로 진행합니다.' : `이 컴퓨터의 Claude Code로 보지 못했습니다 (${(body.error || '알 수 없는 오류').slice(0, 120)}). Claude 채팅 전달로 진행합니다.`, 'error');
      }
      if (answer == null) answer = await relayBox(`${prompt}\n\n(결과 이미지·영상은 이 채팅에 직접 첨부해 주세요.)`, 'text');
    } catch (e) { toast(e.message, 'error'); }
    node.writing = false; delete node.startedAt;
    const text = (answer || '').trim();
    if (text) {
      const cut = text.search(/\[\s*수정\s*프롬프트\s*\]/);
      graph.checkpoint();
      node.data.feedback = (cut >= 0 ? text.slice(0, cut) : '').replace(/\[\s*진단\s*\]/, '').trim();
      node.data.revised = (cut >= 0 ? text.slice(cut).replace(/\[\s*수정\s*프롬프트\s*\]/, '') : text).trim();
      node.wrote = true;
      node.data.noteUsed = node.data.note.trim();
      canvas.paintFields(node);
      await canvas.recompute(node); canvas.refreshDependents(node);
      graph.emit('node:data', node);
    } else { canvas.paintStatus(node); if (btn) { btn.disabled = false; btn.textContent = '피드백 받기'; } }
  },
  // "이 프롬프트로 다시 생성할 노드 만들기": a copy of the generation node the reviewed result came from
  // (same model, settings and references), with this feedback node's revised prompt as its only prompt.
  // Which generation node a feedback is about. With several results attached, the person says which one.
  async reviewed(node, what) {
    const gens = [...new Set(engine.sourcesOf(node, 'media').map((x) => x.src))].filter((n) => n.type === 'image' || n.type === 'video');
    if (gens.length < 2) return gens[0] || null;
    const id = await askBox(`결과가 여러 노드에서 연결되어 있습니다. 어느 노드를 ${what}?`, gens.map((n) => ({ label: `${n.data.label || NODE_TYPES[n.type].title}${n.result?.v ? ` v${n.result.v}` : ''}`, value: n.id })));
    return id ? graph.node(id) : undefined;
  },
  // "원래 노드에서 이 프롬프트로 다시 생성": the revised prompt goes into the generation node the result came from, and
  // that node generates again. No new node: the result becomes its next version, and this feedback node stays attached
  // to it for the next round. The node's connected prompt texts are switched off, because the revised prompt is complete.
  async reapply(node) {
    const src = await actions.reviewed(node, '다시 생성할까요');
    if (src === undefined) return;
    if (!src) return toast('원래 생성 노드를 찾지 못했습니다. 수정 프롬프트 포트를 원하는 생성 노드의 프롬프트에 직접 연결하세요.', 'error');
    if (engine.isRunning(src.id)) return toast('그 노드는 지금 생성 중입니다');
    if (src.data.locked) return toast('그 노드의 결과가 잠겨 있습니다. 노드 메뉴에서 잠금을 풀고 다시 누르세요.', 'error');
    graph.checkpoint();
    src.data.prompt = node.data.revised.trim(); src.data.solo = true;
    canvas.paintFields(src);
    graph.emit('node:data', src);
    canvas.reveal([src]);
    await guarded([src.id], true, '다시 생성');
  },
  async retry(node) {
    const src = await actions.reviewed(node, '복사할까요');
    if (src === undefined) return;
    if (!src) return toast('원래 생성 노드를 찾지 못했습니다. 수정 프롬프트 포트를 원하는 생성 노드의 프롬프트에 직접 연결하세요.', 'error');
    graph.checkpoint();
    const el = canvas.els.get(node.id);
    const { locked, pick, ...data } = structuredClone(src.data);
    const made = graph.addNode(src.type, node.x + node.w + 90, node.y, { ...data, prompt: '', label: `${src.data.label || NODE_TYPES[src.type].title} 수정` });
    for (const e of graph.edgesInto(src.id)) if (e.to.port !== 'prompt') graph.connect({ ...e.from }, { node: made.id, port: e.to.port });
    graph.connect({ node: node.id, port: 'out' }, { node: made.id, port: 'prompt' });
    canvas.select([made.id]);
    toast('원래 노드를 복사해 수정 프롬프트에 연결했습니다. ▶를 누르면 생성합니다.');
    if (el) requestAnimationFrame(() => canvas.reveal([node, made]));
  },
  // "AI로 쓰기" on a text node: Claude writes the prompt from the instruction and the connected reference texts.
  async write(node) {
    const ask = (node.data.ask || '').trim();
    const pictures = engine.sourcesOf(node, 'img');
    if (!ask && !pictures.length) return toast('"AI에게 시킬 내용"을 쓰거나 왼쪽에 참고 이미지를 연결하세요', 'error');
    const refs = (engine.inputsOf(node).ctx || []).map((i) => i.text).filter(Boolean);
    const writeKey = engine.writeKey(node);
    let prompt = [
      'You write prompts for AI image and video generation (photorealistic, live-action look unless told otherwise).',
      'Write the prompt asked for below. Output only the prompt text itself, in English, with no preface, no quotes, no markdown and no explanation.',
      'If the request or the draft contains reference tags such as @Image 1, @Video 1 or @Audio 1, keep each tag exactly as written and say what it is used for.',
      refs.length ? `\nReference texts that this prompt must stay consistent with (do not repeat them verbatim):\n${refs.map((r, i) => `[${i + 1}] ${r}`).join('\n')}` : '',
      node.data.text.trim() ? `\nCurrent draft to revise:\n${node.data.text.trim()}` : '',
      `\nRequest${node.data.label ? ` (this text is used as: ${node.data.label})` : ''}:\n${ask || '(no instruction given: write a prompt that would recreate what the attached pictures show — subject, setting, light, lens and framing)'}`,
    ].filter(Boolean).join('\n');
    // Tags this text can use: the references connected to the generation node(s) it feeds (directly or through a join).
    const tags = canvas.tagsFor(node), tagLines = tags.map((t) => `${t.tag} = ${t.name}`);
    const tagOf = new Map(tags.map((t) => [t.src.id, t.tag])); // node id -> the tag its picture has in the generation this text feeds
    if (tagLines.length) prompt += `\n\nReference tags available to this prompt (write a tag exactly like "@Image 1" when the prompt should point at that reference; use only these):\n${tagLines.join('\n')}\nThis list is the truth about what each number is. If the request says "이미지 1" / "image 1" without the @, it means the tag with that number in this list. If the request describes a numbered image as something this list (or an attached picture) shows it is not — for example it calls image 1 the person when @Image 1 is a style sheet — do not guess silently: write each role onto the tag whose reference really is that thing.`;
    const asked = [...new Set((`${ask} ${node.data.text}`.match(/@\s?(?:image|video|audio|이미지|영상|비디오|오디오)\s?\d+/gi) || []).map(tagKey))];
    const btn = canvas.els.get(node.id)?.querySelector('.action');
    if (btn) { btn.disabled = true; btn.textContent = pictures.length ? '이미지를 보는 중…' : '쓰는 중…'; }
    node.writing = true; node.wrote = false; node.startedAt = Date.now(); canvas.paintStatus(node);
    let text = null;
    try {
      // Pictures connected to this text: Claude looks at them while writing. A picture that is also a reference of the
      // generation this text feeds is named by its tag, so the prompt can point at it instead of describing it again.
      let images = [];
      if (pictures.length) {
        const seen = await picturesOf(pictures, 'Picture', 'reference', (src) => (tagOf.has(src.id) ? ` In the generation it is attached as ${tagOf.get(src.id)}: refer to it by that tag rather than describing it in full.` : ' It is not attached to the generation, so put what matters from it into words.'));
        images = seen.images;
        prompt += `\n\nPictures attached for you to look at before writing:\n${seen.lines.join('\n')}`;
      }
      if (bridge.online) {
        const res = await fetch(`${bridge.base}/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, images, model: llmModel('write') }) });
        const body = await res.json().catch(() => ({}));
        if (res.ok) text = body.text;
        // Claude Code on this computer could not write (not installed, or signed out): say why and fall back to the chat hand-off below.
        else if (res.status !== 501) toast(/authenticat|OAuth|login|log in/i.test(body.error || '') ? '이 컴퓨터의 Claude Code 로그인이 만료되었습니다. 터미널에서 claude 를 실행해 /login 하면 바로 쓰기가 됩니다. 지금은 Claude 채팅 전달로 진행합니다.' : `이 컴퓨터의 Claude Code로 쓰지 못했습니다 (${(body.error || '알 수 없는 오류').slice(0, 120)}). Claude 채팅 전달로 진행합니다.`, 'error');
      }
      // No bridge, or no Claude Code on this computer: hand the request to a Claude chat by copy and paste.
      if (text == null) text = await relayBox(pictures.length ? `${prompt}\n\n(참고 이미지·영상은 이 채팅에 직접 첨부해 주세요.)` : prompt, 'text');
    } catch (e) { toast(e.message, 'error'); }
    node.writing = false; delete node.startedAt; node.wrote = !!text?.trim();
    if (text?.trim()) {
      graph.checkpoint();
      node.data.text = text.trim();
      node.data.askUsed = ask; node.data.ctxUsed = writeKey; // what this text was written from (to show when any of it changes afterwards)
      // Tags the request mentioned must still be in what came back; say so if one was dropped.
      const kept = new Set((node.data.text.match(/@\[?\s?(?:image|video|audio|이미지|영상|비디오|오디오)\s?\d+/gi) || []).map(tagKey));
      const lost = asked.filter((t) => !kept.has(t));
      if (lost.length) toast(`AI가 쓴 글에 ${lost.map((t) => `@${t}`).join(', ')} 태그가 빠졌습니다. 결과 칸에 직접 넣어 주세요.`, 'error');
      canvas.paintFields(node);
      await canvas.recompute(node); canvas.refreshDependents(node);
      graph.emit('node:data', node);
    } else { canvas.paintStatus(node); if (btn) { btn.disabled = false; btn.textContent = 'AI로 쓰기'; } }
  },
  onSelection() {},
  onView(k) { $('zoomLabel').textContent = `${Math.round(k * 100)}%`; },
  onRunState() { updateRunState(); },
};
// Pictures for Claude to look at: images as they are (scaled down), three frames (start, middle, end) per video.
// Returns what to send and one line per item describing it. `extra(src)` may add a note about an item.
async function picturesOf(attached, word, kind, extra = () => '') {
  const images = [], lines = [];
  for (const [i, { src, item }] of attached.entries()) {
    const name = `${src.data.label || NODE_TYPES[src.type].title}${src.result?.v ? ` v${src.result.v}` : ''}`;
    const tail = extra(src);
    if (item.type === 'video' && !item.still) {
      const frames = await frameBlobs(item.url, ['first', { part: 0.5 }, 'last']);
      for (const [k, blob] of frames.entries()) { const pic = await pictureData(blob); if (pic) images.push({ ...pic, label: `${word.toLowerCase()} ${i + 1} (${name}), video frame: ${['start', 'middle', 'end'][k]}` }); }
      lines.push(`${word} ${i + 1}: a ${kind} video (${name}); you get its start, middle and end frame.${tail}`);
    } else {
      const pic = await pictureData(item.url);
      images.push(pic ? { ...pic, label: `${word.toLowerCase()} ${i + 1} (${name})` } : { url: item.url, label: `${word.toLowerCase()} ${i + 1} (${name})` });
      lines.push(`${word} ${i + 1}: a ${kind} image (${name}).${tail}`);
    }
  }
  return { images, lines };
}
const costCache = new Map();
// "@image1", "@Image 1", "@[Image 1", "@이미지 1" -> "Image 1"
const TAG_NAMES = { image: 'Image', 이미지: 'Image', video: 'Video', 영상: 'Video', 비디오: 'Video', audio: 'Audio', 오디오: 'Audio' };
const tagKey = (t) => { const m = /(image|video|audio|이미지|영상|비디오|오디오)\s?(\d+)/i.exec(t); return `${TAG_NAMES[m[1].toLowerCase()]} ${+m[2]}`; };
const canvas = new Canvas({ stage: $('stage'), graph, engine, actions });

const agent = initAgent({ graph, engine, canvas, actions, guarded, panel: $('agentPanel'), button: $('btnAgent') });

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
  for (const id of graph.order(graph.doc.nodes.map((n) => n.id))) { const n = graph.node(id); if (NODE_TYPES[n.type].instant) canvas.recompute(n); }
  if (fit) requestAnimationFrame(() => canvas.fit(undefined, false));
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
    resumePending();
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
$('btnLayout').onclick = () => canvas.autoLayout();
$('btnHelp').onclick = () => modal('단축키와 조작', h('div', {}, h('dl', {}, [
  ['빈 곳 더블클릭 · 우클릭 · A', '노드 추가 (이름으로 찾기)'],
  ['포트에서 끌기', '연결. 빈 곳에 놓으면 이어 붙일 노드를 고릅니다'],
  ['연결선 클릭 → Delete', '연결 끊기'],
  ['빈 곳 끌기 / 휠', '화면 이동 / 확대·축소'],
  ['Shift + 끌기', '여러 노드 선택'],
  ['Ctrl+Enter', '선택한 노드 실행'],
  ['Ctrl+D / Ctrl+C·V', '복제 / 복사·붙여넣기'],
  ['Ctrl+Z / Ctrl+Shift+Z', '실행 취소 / 다시 실행'],
  ['F', '전체(또는 선택한 노드) 보기'],
  ['L', '자동 정렬 (2개 이상 선택하면 그 노드들만)'],
  ['H', '선택한 노드 접기·펼치기 (선택이 없으면 전체)'],
  ['] / [', '선택한 노드를 한 칸 위로 / 아래로 (겹친 노드 기준)'],
  ['Shift+] / Shift+[', '맨 위로 / 맨 아래로'],
  ['제목 더블클릭', '노드 이름 바꾸기 (예: 샷 1)'],
].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
  h('label.help-opt', {}, h('input', { type: 'checkbox', checked: settings.wheelZoom ?? !/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent), onchange: (e) => { settings.wheelZoom = e.target.checked; saveSettings(); } }),
    h('span', {}, '마우스 휠로 확대·축소', h('small', {}, '끄면 스크롤은 항상 화면 이동이고, 확대·축소는 핀치나 Ctrl/Cmd+스크롤로만 합니다. 트랙패드를 쓰면 꺼 두세요.')))), [{ label: '닫기', primary: true }]);

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
  if (e.code === 'BracketRight') return canvas.reorder(e.shiftKey ? 'front' : 'up');
  if (e.code === 'BracketLeft') return canvas.reorder(e.shiftKey ? 'back' : 'down');
  if (key === 'h') { const ns = canvas.selectedNodes().length ? canvas.selectedNodes() : graph.doc.nodes; return canvas.setCollapsed(ns, !ns.every((n) => n.data.collapsed)); }
  if (key === 'f') return canvas.fit(canvas.selectedNodes());
  if (key === 'l') return canvas.autoLayout();
  if (key === 'a' || key === '/') { e.preventDefault(); const p = canvas.lastPointer || { x: innerWidth / 2, y: innerHeight / 2 }; return canvas.addMenu(p.x, p.y); }
  if (key === 'escape') return canvas.select([]);
});

// ---- connection panel
const MODES = [
  { id: 'demo', title: '데모', text: '실제 생성 없이 자리 그림으로 흐름을 확인합니다. 크레딧을 쓰지 않습니다.' },
  { id: 'bridge', title: 'MCP 연결', text: '내 컴퓨터에서 브리지 서버를 켜고 Higgsfield MCP에 로그인해 캔버스에서 바로 생성합니다.' },
  { id: 'relay', title: 'Claude 전달', text: '서버 없이 씁니다. 노드가 만든 요청을 Higgsfield 커넥터가 켜진 Claude 채팅에 붙여넣고, 결과 주소를 다시 붙여넣습니다.' },
];
// Higgsfield workspaces (an account can have a private one and team ones). Generating, credits and the generation
// history all belong to the active workspace, so it is shown and can be switched from the canvas.
const spaces = { list: [], active: null, loaded: false };
async function loadSpaces() {
  try { Object.assign(spaces, await PROVIDERS.bridge.workspaces(), { loaded: true }); } catch { Object.assign(spaces, { list: [], active: null, loaded: false }); }
  return spaces;
}
const spaceLabel = (w) => `${w.name}${w.type === 'private' ? '' : ' (팀)'} · 크레딧 ${Math.round(w.credits ?? 0)}`;
// A <select> of the workspaces. Switching asks first, because later generations are paid from the chosen one.
function spacePicker(after) {
  const sel = h('select', { 'aria-label': 'Higgsfield 작업 공간' }, spaces.list.map((w) => h('option', { value: w.id, selected: w.id === spaces.active?.id }, spaceLabel(w))));
  sel.onchange = async () => {
    const to = spaces.list.find((w) => w.id === sel.value), from = spaces.active;
    if (!(await confirmBox('작업 공간 바꾸기', `"${to.name}" 작업 공간으로 바꿉니다. 이후 생성은 이 작업 공간의 크레딧(${Math.round(to.credits ?? 0)})으로 결제되고, 생성 기록도 이 작업 공간 것이 보입니다. 이 선택은 Higgsfield 계정에 저장되어 다른 앱에서도 적용됩니다.`, '바꾸기'))) { sel.value = from?.id; return; }
    try { await PROVIDERS.bridge.selectWorkspace(to); await loadSpaces(); costCache.clear(); canvas.queueCost(); toast(`작업 공간을 "${to.name}"(으)로 바꿨습니다`); }
    catch (e) { toast(`작업 공간을 바꾸지 못했습니다: ${e.message}`, 'error'); sel.value = from?.id; }
    paintConn(); after?.();
  };
  return sel;
}

// Generations that were still running when the page was closed or reloaded: take their results in once the
// server they run on is reachable. Until then the node says so.
function resumePending() {
  for (const n of graph.doc.nodes) {
    if (!n.pending || engine.isRunning(n.id)) continue;
    if (settings.mode === 'bridge' && serverReady(n.pending.server)) { engine.resume(n); updateRunState(true); }
    else if (!n.message) { n.message = '새로고침 전에 시작한 생성이 있습니다. MCP에 연결되면 결과를 이어서 받습니다.'; graph.emit('node:status', n); }
  }
}
function paintConn() {
  resumePending();
  const btn = $('btnConn');
  const ready = serverReady(settings.server);
  $('connLabel').textContent = settings.mode === 'demo' ? '데모' : settings.mode === 'relay' ? 'Claude 전달' : ready ? `${bridge.servers.find((x) => x.id === settings.server)?.name || 'MCP'} 연결됨${spaces.list.length > 1 && spaces.active ? ` · ${spaces.active.name}` : ''}` : bridge.online ? '로그인 필요' : '브리지 꺼짐';
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
    await loadSpaces();
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
        for (let i = 0; i < 25 && !bridge.online; i++) { await new Promise((res) => setTimeout(res, 1000)); await refreshBridge(); }
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
        if (!spaces.loaded) await loadSpaces();
        if (spaces.list.length > 1) kids.push(h('h3', {}, 'Higgsfield 작업 공간'), h('div.row', {}, spacePicker(() => drawConn())),
          h('p', {}, '생성 결제, 크레딧, 생성 기록이 모두 여기서 고른 작업 공간을 따릅니다.'));
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
      // Claude writes prompts, reviews results and plans for the agent through Claude Code on this computer; each call uses that account's allowance.
      const pickLlm = (task) => h('select', { 'aria-label': `${task} 모델`, onchange: (e) => { (settings.llm ||= {})[task] = e.target.value; saveSettings(); } }, LLM_MODELS.map((m) => h('option', { value: m.value, selected: llmModel(task) === m.value }, m.label)));
      kids.push(h('h3', {}, 'Claude 모델 (AI 작업)'),
        h('div.row.llm', {}, h('span', {}, '에이전트'), pickLlm('agent')),
        h('div.row.llm', {}, h('span', {}, 'AI로 쓰기'), pickLlm('write')),
        h('div.row.llm', {}, h('span', {}, '피드백 받기'), pickLlm('review')),
        h('p', {}, '이 컴퓨터의 Claude Code로 실행되며 그 계정의 사용량에서 나갑니다. "기본값"은 Claude Code에 설정된 모델을 그대로 씁니다. 가벼운 모델일수록 사용량이 적게 듭니다.'));
    }
  }
  if (settings.mode === 'relay') kids.push(h('h3', {}, '쓰는 법'), h('p', {}, '생성 노드를 실행하면 요청문이 뜹니다. 복사해 Claude 채팅에 붙여넣고, Claude가 답한 결과 주소를 다시 붙여넣으면 노드에 결과가 들어갑니다. 내 컴퓨터의 파일을 레퍼런스로 쓰려면 그 채팅에 파일을 직접 올려야 합니다.'));
  panel.replaceChildren(...kids);
  paintConn();
}
$('btnConn').onclick = async () => { const p = $('connPanel'); p.hidden = !p.hidden; if (!p.hidden) agent.toggle(false); if (!p.hidden && settings.mode === 'bridge') await refreshBridge(); drawConn(); };

// Sideways two-finger swipes outside the canvas (top bar, panels, dialogs) would otherwise reach the browser and
// trigger back/forward. They are let through only to something that can still scroll sideways in that direction.
addEventListener('wheel', (e) => {
  if (e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  for (let el = e.target; el && el !== document.documentElement; el = el.parentElement) {
    if (el.id === 'stage') return; // the canvas handles its own panning
    if (el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)) {
      const max = el.scrollWidth - el.clientWidth;
      if ((e.deltaX < 0 && el.scrollLeft > 0) || (e.deltaX > 0 && el.scrollLeft < max - 1)) return;
    }
  }
  e.preventDefault();
}, { passive: false });

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
  if (settings.mode === 'bridge') { await refreshBridge(); repaintTools(); library.sync(); canvas.queueCost(); if (serverReady(settings.server)) await loadSpaces(); }
  paintConn();
  window.flow = { graph, engine, canvas, settings, currentProvider, library, agent };
})();
// Save at once when the page is being closed or hidden, not only after the short delay.
addEventListener('pagehide', () => { if (graph.doc.id) library.put(graph.doc); });
document.addEventListener('visibilitychange', () => { if (document.hidden && graph.doc.id) library.put(graph.doc); });
