// The agent: a chat panel. The person says what picture or video they want; Claude (through the bridge's /api/llm, or a
// Claude chat by copy and paste) answers with a plan as JSON, and this file turns the plan into nodes and runs them.
//  - When the plan needs something only the person has (a face, a product, a place), the agent asks for it first.
//  - Generation goes in stages (stills, then the videos that depend on them); after each stage the person is asked
//    whether the result is right. A written complaint goes back to Claude together with the result pictures.
// Nodes the agent made carry data.agent = their key in the plan; reference material is ref1, ref2, …
import { NODE_TYPES, buildRequest, finalResolutions, UPSCALE_METHODS } from './nodes.js';
import { listModels, getModel, modelRoles, modelDurations, modelParams, recentModels } from './models.js';
import { settings, bridge, refreshBridge, serverReady, PROVIDERS } from './providers.js';
import { displayUrl, pictureData, frameBlobs, saveBlob } from './media.js';
import { h, toast, relayBox, lightbox } from './ui.js';

const BUILDABLE = new Set(['image', 'video', 'frame', 'vupscale']);
const MEDIA = ['image', 'video', 'audio'];
const isRef = (key) => /^ref\d+$/.test(key);

const RULES = `You are the production agent of a node-canvas tool for AI image and video generation. A filmmaker tells you what they want; you decide the nodes, models, settings and prompts, and the tool builds and runs them. The filmmaker wants photorealistic, live-action looking results unless they say otherwise.

Answer with exactly one JSON object and nothing else (no markdown fence, no commentary):

{"action":"ask","message":"..."}
  Use this when you cannot do a good job without something only the filmmaker can give:
  - a specific person, character, product, location, logo or existing shot that the request refers to ("me", "our product", "the same character as before", "like this photo") and that is not in the reference material listed below;
  - a choice that changes the cost or the result a lot and that you cannot settle with a sensible default.
  Ask for everything in one message, as a short numbered list, saying for each item what kind of file or answer you need. Do not ask about things you can decide yourself (aspect ratio defaults to 16:9, video length to 5 seconds). If the request is generic and needs no specific identity, do not ask: build.

{"action":"build","message":"...","nodes":[...],"links":[...]}
  "message": 1 to 3 sentences telling the filmmaker what you set up (or changed) and why.

"message" is always written in Korean, plain and short.

Nodes
  {"key":"still","type":"image","label":"시작 이미지","model":"<image model id>","prompt":"...","aspect":"16:9","count":2,"params":{}}
  {"key":"shot1","type":"video","label":"샷 1","model":"<video model id>","prompt":"...","aspect":"16:9","duration":5,"count":2,"params":{}}
  {"key":"last1","type":"frame","label":"샷 1 마지막 프레임","at":"last"}   takes a video and gives its first or last frame as an image ("at": "first" or "last")
  {"key":"up1","type":"vupscale","label":"샷 1 1080p","method":"wan","resolution":"1080p"}   takes a video and renders it again at a higher resolution (methods: ${UPSCALE_METHODS.map((m) => m.id).join(', ')}). Only when the filmmaker asks for upscaling.
  - "key": short and unique, letters, digits and underscore only. "label": a short Korean name shown on the node.
  - "model" must be an id from the model list below. "params" may only use the parameter names and values listed for that model. Leave out what you do not need to set.
  - "prompt": the complete prompt, in English, written for that model: subject, action, setting, light, lens and framing, and for a video the camera move and what happens over time.
  - "count" is the number of variants (1 to 4). Use 2 unless the filmmaker says otherwise.

Links: "fromKey>toKey.port". fromKey is a node key or a reference key (ref1, ref2, …). Ports of image and video nodes, only those listed for the chosen model: start (first frame), end (last frame), refs (reference images), vref (reference videos), aref (reference audio). frame and vupscale nodes have the one port "video".
  - Images linked to "refs" of a node are numbered in the order of your links: the first is @Image 1, the second @Image 2 (likewise @Video N for vref and @Audio N for aref). In that node's prompt, point at each reference with its tag and say what it is used for ("the woman from @Image 1", "the room from @Image 2"). start and end have no tag.
  - Never write a tag that has no link behind it.

How to plan
  - Keep it minimal: the fewest nodes that do the job.
  - A video that needs a particular look, person or composition: make the still first (an image node) and link it to the video's start port; the video prompt then describes only the motion, the camera and what changes. A plain idea with no such need can be a single video node.
  - Use attached reference material the way the filmmaker says: a person goes to refs with identity wording, a style to refs with style wording, a first frame to start.
  - Video models that list the parameter "draft": make the first pass a draft with "params":{"draft":true,"resolution":"480p"}. The filmmaker renders the approved draft at 1080p afterwards.
  - Several shots: one video node per shot. To continue a shot, put a frame node ("at":"last") after it and link the frame to the next shot's start.
  - The tool runs the nodes in stages (stills first, then the videos that depend on them) and asks the filmmaker after each stage, so you do not have to think about order.

Revising
  When "Current nodes" lists nodes, the filmmaker is reacting to what exists. Reuse the existing keys: list only the nodes you change (give only the fields that change; a changed "prompt" is always given in full) and the nodes you add. Give only new links. Change as little as it takes to fix what they are unhappy with, and look at the attached result pictures before deciding. A node whose line says "failed" did not run: fix the cause named there.`;

function modelLine(m) {
  const roles = modelRoles(m), ports = [];
  const max = (names) => (m.medias || []).find((x) => (x.roles || []).some((r) => names.includes(r)))?.max;
  if (roles.has('start_image')) ports.push('start');
  if (roles.has('end_image')) ports.push('end');
  if (roles.has('image_references') || roles.has('image')) ports.push(`refs${max(['image_references', 'image']) ? ` (max ${max(['image_references', 'image'])})` : ''}`);
  if (['video_references', 'video', 'input_video'].some((r) => roles.has(r))) ports.push('vref');
  if (['audio_references', 'input_audio'].some((r) => roles.has(r))) ports.push('aref');
  const d = modelDurations(m);
  const params = modelParams(m).filter((p) => p.name !== 'extension_mode').map((p) => (p.options ? `${p.name}=${p.options.join('|')}` : p.type === 'bool' ? `${p.name}=true|false` : `${p.name}=${p.min}..${p.max}`));
  return `- ${m.id} — ${m.name}${m.provider_name ? ` (${m.provider_name})` : ''}: ${(m.description || '').slice(0, 110)}. ports: ${ports.join(', ') || 'none (text only)'}. aspect: ${m.aspect_ratios?.length ? m.aspect_ratios.join(' ') : 'model default'}.${d ? ` duration: ${d.options ? d.options.join('|') : `${Math.max(1, d.min)}..${d.max}`}s.` : ''}${params.length ? ` params: ${params.join('; ')}` : ''}`;
}

// The JSON object in Claude's answer (it may come wrapped in a code fence or a sentence).
export function readPlan(raw) {
  const text = String(raw || '');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  let plan = null;
  if (a >= 0 && b > a) { try { plan = JSON.parse(text.slice(a, b + 1)); } catch { plan = null; } }
  if (!plan || (plan.action !== 'ask' && plan.action !== 'build')) throw new Error(`에이전트의 답을 읽지 못했습니다: ${text.slice(0, 160) || '(빈 답)'}`);
  return plan;
}

export function initAgent({ graph, engine, canvas, actions, guarded, panel, button }) {
  const st = { log: [], files: [], busy: false, stage: [], abort: null, docId: null };
  const mine = () => graph.doc.nodes.filter((n) => n.data.agent);
  const built = () => mine().filter((n) => !isRef(n.data.agent));
  const refs = () => mine().filter((n) => isRef(n.data.agent)).sort((a, b) => +a.data.agent.slice(3) - +b.data.agent.slice(3));
  const name = (n) => n.data.label || NODE_TYPES[n.type].title;
  const nextRef = () => { const used = new Set(mine().map((n) => n.data.agent)); let i = 1; while (used.has(`ref${i}`)) i++; return `ref${i}`; };
  // Nodes selected on the canvas that hold a picture, video or sound: handed to the agent as reference material too.
  const pickedRefs = () => canvas.selectedNodes().filter((n) => !n.data.agent && engine.outItems(n).some((i) => MEDIA.includes(i.type)));

  // ---- panel
  const feed = h('div.agent-feed', { 'aria-live': 'polite' });
  const status = h('div.agent-status', { hidden: true });
  const chips = h('div.agent-files');
  const selNote = h('p.agent-sel', { hidden: true });
  const input = h('textarea', { rows: 3, placeholder: '만들고 싶은 이미지나 영상을 말해 주세요. (Enter 보내기 · Shift+Enter 줄바꿈)', 'aria-label': '에이전트에게 보낼 내용' });
  const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*,audio/*', hidden: true, onchange: (e) => { addFiles(e.target.files); e.target.value = ''; } });
  const sendBtn = h('button.primary', { onclick: () => send() }, '보내기');
  panel.replaceChildren(
    h('h2', {}, '에이전트', h('span', {}, h('button', { title: '대화를 비우고 새 작업을 시작합니다. 만든 노드는 캔버스에 그대로 남습니다.', onclick: () => reset(true) }, '새 작업'), h('button', { onclick: () => toggle(false) }, '닫기'))),
    feed, status, chips, selNote,
    h('div.agent-input', {}, input, h('div.row', {}, h('button', { title: '참고할 이미지·영상·오디오 파일 첨부 (끌어다 놓거나 붙여넣어도 됩니다)', onclick: () => fileInput.click() }, '＋ 참고 자료'), fileInput, h('span.grow'), sendBtn)));

  function bubble(who, text, ...kids) {
    const el = h(`div.agent-msg.${who}`, {}, text ? h('p', {}, text) : null, ...kids.filter(Boolean));
    feed.append(el); feed.scrollTop = feed.scrollHeight;
    return el;
  }
  function say(who, text, ...kids) { if (text) st.log.push({ who, text }); return bubble(who, text, ...kids); }
  // Buttons under an agent message. Pressing one retires the whole row, so an old question cannot be answered twice.
  function choices(list) {
    const row = h('div.agent-choices');
    row.append(...list.filter(Boolean).map((c) => h(`button${c.primary ? '.primary' : ''}`, { title: c.title || '', onclick: () => { if (st.busy) return; if (!c.keep) row.remove(); c.run(); } }, c.label)));
    return row;
  }
  function intro() {
    feed.replaceChildren();
    bubble('agent', '만들고 싶은 이미지나 영상을 말해 주세요. 필요한 노드를 만들고 생성까지 진행합니다.',
      h('p.hint', {}, '참고할 사진·영상이 있으면 이 창에 끌어다 놓거나 붙여넣으세요. 캔버스에서 노드를 선택해 두면 그 결과도 참고 자료로 함께 넘어갑니다. 인물·제품처럼 제가 지어낼 수 없는 것이 필요하면 먼저 되묻고, 생성이 끝날 때마다 마음에 드는지 확인합니다.'));
  }
  let timer = null;
  function setBusy(text, stop) {
    st.busy = !!text; sendBtn.disabled = st.busy;
    clearInterval(timer);
    status.hidden = !text;
    if (!text) return;
    const t0 = Date.now(), label = h('span', {}, text);
    status.replaceChildren(h('i.spin'), label, stop ? h('button.small', { onclick: stop }, '중단') : null);
    timer = setInterval(() => { label.textContent = `${text} ${Math.round((Date.now() - t0) / 1000)}초`; }, 1000);
  }
  function drawFiles() {
    chips.replaceChildren(...st.files.map((f, i) => h('span.agent-chip', {}, f.name, h('button', { 'aria-label': `${f.name} 빼기`, onclick: () => { st.files.splice(i, 1); drawFiles(); } }, '×'))));
    const sel = pickedRefs();
    selNote.hidden = !sel.length;
    selNote.textContent = sel.length ? `캔버스에서 선택한 노드 ${sel.length}개(${sel.map(name).join(', ')})도 참고 자료로 보냅니다.` : '';
  }
  function addFiles(list) {
    const ok = [...(list || [])].filter((f) => MEDIA.some((k) => f.type.startsWith(`${k}/`)));
    if (!ok.length) return toast('이미지·영상·오디오 파일만 첨부할 수 있습니다', 'error');
    st.files.push(...ok); drawFiles();
  }
  function reset(strip) {
    if (st.busy) return toast('진행 중인 작업이 끝난 뒤에 새 작업을 시작할 수 있습니다');
    if (strip) for (const n of mine()) delete n.data.agent;
    if (strip) graph.scheduleSave();
    st.log = []; st.files = []; st.stage = []; st.docId = graph.doc.id;
    intro(); drawFiles();
  }
  function toggle(open = panel.hidden) {
    panel.hidden = !open; document.body.classList.toggle('agent-open', open);
    button.setAttribute('aria-pressed', String(open));
    if (open) { document.getElementById('connPanel').hidden = true; if (!feed.children.length) reset(false); if (!bridge.online) refreshBridge(); drawFiles(); input.focus(); }
    canvas.queueEdges?.();
  }
  button.onclick = () => toggle();
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // canvas shortcuts (Ctrl+Enter = run the selected nodes) do not apply while writing here
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === 'Escape') input.blur();
  });
  input.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
  panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('dropping'); });
  panel.addEventListener('dragleave', () => panel.classList.remove('dropping'));
  panel.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); panel.classList.remove('dropping'); addFiles(e.dataTransfer.files); });
  // Another workflow was opened: its conversation is not this one.
  graph.on((kind) => { if (kind === 'reset' && graph.doc.id !== st.docId && !panel.hidden && !st.busy) reset(false); });
  const baseSelection = actions.onSelection;
  actions.onSelection = () => { baseSelection?.(); if (!panel.hidden) drawFiles(); };

  // ---- asking Claude
  async function askClaude(prompt, images) {
    let text = null;
    if (bridge.online) {
      const ctrl = new AbortController(); st.abort = ctrl;
      try {
        const res = await fetch(`${bridge.base}/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, images }), signal: ctrl.signal });
        const body = await res.json().catch(() => ({}));
        if (res.ok) text = body.text;
        else if (res.status !== 501) toast(/authenticat|OAuth|login|log in/i.test(body.error || '') ? '이 컴퓨터의 Claude Code 로그인이 만료되었습니다. 터미널에서 claude 를 실행해 /login 하세요. 지금은 Claude 채팅 전달로 진행합니다.' : `이 컴퓨터의 Claude Code가 답하지 못했습니다 (${(body.error || '알 수 없는 오류').slice(0, 120)}). Claude 채팅 전달로 진행합니다.`, 'error');
      } catch (e) { if (e.name === 'AbortError') return null; }
      finally { st.abort = null; }
    }
    // No bridge, or no Claude Code on this computer: hand the request to a Claude chat by copy and paste.
    if (text == null) text = await relayBox(images.length ? `${prompt}\n\n(참고 자료와 결과 이미지는 이 채팅에 직접 첨부해 주세요.)` : prompt, 'text');
    return text;
  }
  // One picture per image, the middle frame of a video. Unreadable ones are simply not shown to Claude.
  async function look(item, label, out) {
    if (out.length >= 8 || !item) return;
    try {
      if (item.type === 'image' || item.still) { const pic = await pictureData(item.url); out.push(pic ? { ...pic, label } : /^https:/.test(item.url) ? { url: item.url, label } : null); }
      else if (item.type === 'video') { const [blob] = await frameBlobs(item.url, [{ part: 0.5 }]); const pic = await pictureData(blob); if (pic) out.push({ ...pic, label: `${label}, middle frame of the video` }); }
    } catch { /* not readable from here */ }
    while (out.length && out[out.length - 1] == null) out.pop();
  }
  async function brief() {
    const images = [], lines = [RULES, ''];
    for (const kind of ['image', 'video']) {
      const recent = recentModels(kind).slice(0, 3).map((m) => m.id);
      lines.push(`${kind === 'image' ? 'Image' : 'Video'} models${recent.length ? ` (the filmmaker used these most recently, prefer them when they fit: ${recent.join(', ')})` : ''}:`, ...listModels(kind).map(modelLine), '');
    }
    const material = refs();
    lines.push('Reference material the filmmaker has given:');
    if (!material.length) lines.push('(none)');
    for (const n of material) {
      const item = engine.outItems(n)[0];
      lines.push(`- ${n.data.agent}: ${item ? item.type : 'empty'}${item?.type === 'audio' ? '' : ' (attached for you to look at)'} — "${name(n)}"`);
      await look(item, `reference ${n.data.agent} (${name(n)})`, images);
    }
    lines.push('', 'Current nodes:');
    const nodes = built();
    if (!nodes.length) lines.push('(none yet)');
    for (const n of nodes) {
      const ins = graph.ports(n, 'in').flatMap((p) => engine.sourceNodes(n, p.key).map((s) => `${s.data.agent || `(${name(s)})`}>${p.key}`));
      const set = n.type === 'image' || n.type === 'video' ? { model: n.data.model, aspect: n.data.aspect, ...(n.type === 'video' ? { duration: +n.data.duration } : {}), count: +n.data.count, params: n.data.params } : n.type === 'frame' ? { at: n.data.at } : { method: n.data.method, resolution: n.data.resolution };
      const state = n.status === 'error' ? `failed: ${n.message}` : n.result ? `generated v${n.result.v || 1}${engine.isStale(n) ? ' (settings changed since)' : ''}` : 'not generated yet';
      lines.push(`- ${n.data.agent} | ${n.type} | "${name(n)}" | ${JSON.stringify(set)} | links in: ${ins.join(', ') || 'none'} | ${state}${n.data.prompt ? `\n  prompt: ${n.data.prompt}` : ''}`);
    }
    // What the last stage produced, for Claude to look at when the filmmaker reacts to it.
    const shown = st.stage.map((id) => graph.node(id)).filter((n) => n?.result);
    if (shown.length) {
      lines.push('', 'Latest results (the variant the filmmaker has picked on each node is attached):');
      for (const n of shown) { lines.push(`- result of ${n.data.agent} ("${name(n)}", v${n.result.v || 1})`); await look(engine.outItems(n)[0], `result of ${n.data.agent} (${name(n)})`, images); }
    }
    lines.push('', 'Conversation so far:', ...st.log.map((m) => `${m.who === 'me' ? 'Filmmaker' : 'Agent'}: ${m.text}`), '', 'Now answer the filmmaker\'s last message with one JSON object.');
    return { prompt: lines.join('\n'), images };
  }

  // ---- turning a plan into nodes
  function dataOf(type, spec, have, problems) {
    const data = {}, key = spec.key;
    if (typeof spec.label === 'string' && spec.label.trim()) data.label = spec.label.trim().slice(0, 40);
    if (type === 'image' || type === 'video') {
      if (spec.model != null) { const m = getModel(spec.model); if (m && m.output_type === type) data.model = m.id; else problems.push(`${key}: 모델 ${spec.model}을(를) 목록에서 찾지 못해 ${have ? '그대로 두었습니다' : '기본 모델로 두었습니다'}`); }
      const model = getModel(data.model || have?.data.model || NODE_TYPES[type].defaults.model) || listModels(type)[0];
      if (typeof spec.prompt === 'string') data.prompt = spec.prompt.trim();
      if (typeof spec.aspect === 'string') data.aspect = spec.aspect;
      if (spec.count != null) data.count = String(Math.max(1, Math.min(4, Math.round(+spec.count) || 1)));
      if (type === 'video' && spec.duration != null) data.duration = String(Math.round(+spec.duration) || 5);
      if (spec.params && typeof spec.params === 'object') {
        const known = new Map(modelParams(model).map((p) => [p.name, p])), params = {};
        for (const [k, v] of Object.entries(spec.params)) {
          const p = known.get(k);
          if (!p || (p.options && !p.options.map(String).includes(String(v)))) { problems.push(`${key}: ${model?.name || '모델'}에 없는 설정 ${k}=${v}은(는) 뺐습니다`); continue; }
          params[k] = p.type === 'bool' ? v === true || v === 'true' : p.options ? p.options.find((o) => String(o) === String(v)) : +v;
        }
        if (params.draft && known.get('resolution')?.options?.includes('480p')) params.resolution = '480p';
        else if (params.resolution && params.resolution !== '480p' && known.has('draft') && params.draft == null && have?.data.params?.draft) params.draft = false;
        data.params = params;
      }
    } else if (type === 'frame') {
      if (spec.at === 'first' || spec.at === 'last') data.at = spec.at;
    } else if (type === 'vupscale') {
      if (UPSCALE_METHODS.some((m) => m.id === spec.method)) data.method = spec.method;
      if (typeof spec.resolution === 'string') data.resolution = spec.resolution;
      if (typeof spec.prompt === 'string') data.prompt = spec.prompt.trim();
    }
    return data;
  }
  function apply(plan) {
    const problems = [], made = [];
    const byKey = new Map(mine().map((n) => [n.data.agent, n]));
    graph.checkpoint();
    const all = canvas.bounds(graph.doc.nodes), at = all ? { x: all.x0, y: all.y1 + 140 } : canvas.center();
    for (const spec of Array.isArray(plan.nodes) ? plan.nodes : []) {
      const key = String(spec?.key || '').trim();
      if (!/^\w+$/.test(key) || isRef(key)) { problems.push(`이름(${key || '없음'})을 쓸 수 없는 노드는 건너뛰었습니다`); continue; }
      const have = byKey.get(key), type = have?.type || spec.type;
      if (!BUILDABLE.has(type)) { problems.push(`${key}: 만들 수 없는 노드 종류(${spec.type})라 건너뛰었습니다`); continue; }
      const data = dataOf(type, { ...spec, key }, have, problems);
      if (have) {
        Object.assign(have.data, data, data.params ? { params: { ...have.data.params, ...data.params } } : {});
        graph.pruneEdges(have.id); canvas.renderNode(have); graph.emit('node:data', have);
      } else {
        const node = graph.addNode(type, at.x + made.length * 400, at.y, { ...data, agent: key });
        byKey.set(key, node); made.push(node);
      }
    }
    for (const link of Array.isArray(plan.links) ? plan.links : []) {
      const m = /^\s*(\w+)(?:\.\w+)?\s*>\s*(\w+)\.(\w+)\s*$/.exec(String(link));
      const from = m && byKey.get(m[1]), to = m && byKey.get(m[2]);
      if (!from || !to) { problems.push(`연결 ${link}: 없는 노드를 가리켜 건너뛰었습니다`); continue; }
      const r = graph.connect({ node: from.id, port: 'out' }, { node: to.id, port: m[3] });
      if (r.error && !/이미 연결/.test(r.error)) { problems.push(`연결 ${link}: ${r.error}`); continue; }
      // References are numbered (@Image 1, 2, …) in the order of the plan's links, wherever the nodes end up on the canvas.
      if (graph.port(to, 'in', m[3])?.multi) { const order = ((to.data.order ||= {})[m[3]] ||= []); if (!order.includes(from.id)) order.push(from.id); }
    }
    canvas.afterChange();
    if (made.length) {
      // Lay the agent's nodes out together, references on the left.
      const group = mine();
      canvas.select(group.map((n) => n.id));
      if (group.length > 1) canvas.autoLayout(); else canvas.reveal(group);
      canvas.select([]);
    }
    return problems;
  }

  // ---- generating in stages
  // Generating nodes of the agent that still have to run, and of those the ones whose inputs are ready.
  function nextStage() {
    const need = built().filter((n) => NODE_TYPES[n.type].spends && !(n.data.locked && n.result) && (!n.result || engine.isStale(n) || n.status === 'error'));
    return need.filter((n) => ![...graph.upstream(n.id)].some((id) => need.some((m) => m.id === id)));
  }
  async function stageCost(nodes) {
    if (settings.mode !== 'bridge' || !serverReady(settings.server)) return '';
    const ctx = { signal: new AbortController().signal, progress() {} };
    const costs = await Promise.all(nodes.map(async (n) => { try { return n.type === 'image' || n.type === 'video' ? await PROVIDERS.bridge.cost(buildRequest(n, engine.inputsOf(n)), ctx) : null; } catch { return null; } }));
    const known = costs.filter((c) => c != null);
    return known.length ? ` 예상 크레딧 ${known.reduce((a, b) => a + b, 0)}${known.length < nodes.length ? ' (일부는 미리 알 수 없음)' : ''}.` : '';
  }
  async function runStage() {
    const stage = nextStage();
    if (!stage.length) return finish();
    st.stage = stage.map((n) => n.id);
    setBusy('예상 크레딧 확인 중…');
    const cost = await stageCost(stage);
    say('agent', `생성을 시작합니다: ${stage.map(name).join(', ')}.${cost}`);
    setBusy('생성 중…', () => engine.stop());
    let failed;
    try { failed = await guarded(st.stage, true, '에이전트 생성'); } finally { setBusy(''); }
    if (failed === null) return say('agent', '생성을 취소했습니다. 노드는 캔버스에 그대로 있습니다.', choices([{ label: '생성 시작', primary: true, run: () => runStage() }]));
    showResults();
  }
  function resultBlock(n) {
    const items = (n.result?.items || []).filter((i) => MEDIA.includes(i.type));
    const tiles = items.map((it, i) => {
      const url = displayUrl(it.url);
      const open = () => lightbox(it, url, canvas.infoOf(n), undefined, canvas.galleryOf(n, it));
      return h('button.agent-thumb', { title: '크게 보기', onclick: open }, it.type === 'video' && !it.still ? h('video', { src: url, muted: true, loop: true, autoplay: true, playsInline: true }) : h('img', { src: url, alt: `${name(n)} 결과 ${i + 1}` }));
    });
    const pickRow = h('div.agent-pick');
    const drawPick = () => pickRow.replaceChildren(...(items.length > 1 ? [h('span', {}, '다음 단계에 쓸 것'), ...items.map((_, i) => h(`button.small${(+n.data.pick || 0) === i ? '.on' : ''}`, { onclick: () => { n.data.pick = i; canvas.paintPreview(n); canvas.refreshDependents(n); graph.emit('node:data', n); drawPick(); } }, `${i + 1}번`))] : []));
    drawPick();
    return h('div.agent-result', {}, h('b', {}, `${name(n)}${n.result?.v ? ` · v${n.result.v}` : ''}`), h('div.agent-thumbs', {}, tiles), pickRow);
  }
  function showResults() {
    const nodes = st.stage.map((id) => graph.node(id)).filter(Boolean);
    const ok = nodes.filter((n) => n.status !== 'error' && n.result && !engine.isStale(n)), bad = nodes.filter((n) => n.status === 'error');
    const stopped = nodes.filter((n) => !ok.includes(n) && !bad.includes(n));
    if (!ok.length) {
      return say('agent', bad.length ? `생성에 실패했습니다. ${bad.map((n) => `${name(n)}: ${n.message}`).join(' / ')}` : '생성을 중단했습니다.',
        choices([{ label: '다시 시도', primary: true, run: () => runStage() }]), h('p.hint', {}, '원인을 고쳐야 하면 아래에 적어 보내 주세요.'));
    }
    const more = nextStage().filter((n) => !bad.includes(n) && !stopped.includes(n));
    const problems = [bad.length ? `실패: ${bad.map((n) => `${name(n)} (${n.message})`).join(', ')}.` : '', stopped.length ? `중단됨: ${stopped.map(name).join(', ')}.` : ''].filter(Boolean).join(' ');
    say('agent', `${ok.map(name).join(', ')} 결과입니다. 만족스러우신가요?${problems ? ` ${problems}` : ''}`,
      ...ok.map(resultBlock),
      choices([{ label: more.length ? `만족 — 다음 단계 (${more.map(name).join(', ')})` : '만족 — 마무리', primary: true, run: () => { st.log.push({ who: 'me', text: '(만족한다고 답함)' }); runStage(); } },
        bad.length || stopped.length ? { label: '실패한 것 다시 시도', run: () => runStage() } : null]),
      h('p.hint', {}, '고치고 싶은 점이 있으면 아래에 적어 보내 주세요. 그 부분만 고쳐서 다시 생성합니다.'));
  }
  // Nothing left to generate. Drafts can now be brought to full resolution.
  function finish() {
    const drafts = built().filter((n) => n.type === 'video' && n.result?.request?.draft && finalResolutions(n, engine.outItems(n)[0]).includes('1080p'));
    const upscaled = new Set(built().filter((n) => n.type === 'vupscale').flatMap((n) => graph.edgesInto(n.id).map((e) => e.from.node)));
    const opts = drafts.flatMap((n) => [
      { label: `${name(n)} — 1080p로 완성`, title: '같은 모델이 이 드래프트를 1080p로 다시 생성합니다 (Generate in 1080p)', keep: true, run: () => actions.finalize(n, engine.outItems(n)[0], '1080p') },
      upscaled.has(n.id) ? null : { label: `${name(n)} — Wan 3.0으로 1080p`, title: '이 480p 영상을 레퍼런스로 넣고 Wan 3.0이 1080p로 다시 그립니다. 보통 더 싸지만 세부와 소리가 달라질 수 있습니다.', run: () => upscale(n) },
    ]);
    say('agent', drafts.length ? '모두 생성했습니다. 드래프트(480p)는 아래에서 1080p로 올릴 수 있습니다.' : '모두 생성했습니다. 더 고치거나 이어서 만들 것이 있으면 말씀해 주세요.', opts.length ? choices(opts) : null);
  }
  function upscale(src) {
    graph.checkpoint();
    const used = new Set(mine().map((n) => n.data.agent)); let i = 1; while (used.has(`up${i}`)) i++;
    const node = graph.addNode('vupscale', src.x + src.w + 90, src.y, { label: `${name(src)} 1080p`, method: 'wan', resolution: '1080p', agent: `up${i}` });
    graph.connect({ node: src.id, port: 'out' }, { node: node.id, port: 'video' });
    canvas.afterChange(); canvas.reveal([src, node]);
    runStage();
  }

  // ---- one turn of the conversation
  async function turn() {
    setBusy('생각하는 중…', () => st.abort?.abort());
    let plan = null;
    try {
      const { prompt, images } = await brief();
      const raw = await askClaude(prompt, images);
      if (raw == null || !String(raw).trim()) { setBusy(''); return say('agent', '답을 받지 못해 멈췄습니다.', choices([{ label: '다시 시도', primary: true, run: () => turn() }])); }
      plan = readPlan(raw);
    } catch (e) {
      setBusy('');
      return say('agent', e.message, choices([{ label: '다시 시도', primary: true, run: () => turn() }]));
    }
    setBusy('');
    const message = String(plan.message || '').trim();
    if (plan.action === 'ask') return say('agent', message || '조금 더 알려 주세요.');
    const problems = apply(plan);
    say('agent', message || '노드를 구성했습니다.', problems.length ? h('p.hint', {}, `참고: ${problems.join(' · ')}`) : null);
    if (nextStage().length) await runStage();
  }
  async function send() {
    const text = input.value.trim();
    if (st.busy || (!text && !st.files.length)) return;
    input.value = '';
    st.docId = graph.doc.id;
    // Attached files and selected canvas nodes become reference material (ref1, ref2, …).
    const files = st.files, picked = pickedRefs(), added = [];
    st.files = [];
    if (files.length || picked.length) graph.checkpoint();
    const all = canvas.bounds(graph.doc.nodes), at = all ? { x: all.x0, y: all.y1 + 140 } : canvas.center();
    for (const [i, f] of files.entries()) {
      const node = graph.addNode('media', at.x + i * 300, at.y, { kind: MEDIA.find((k) => f.type.startsWith(`${k}/`)), file: await saveBlob(f), name: f.name, label: f.name.replace(/\.[^.]+$/, '').slice(0, 40), agent: nextRef() });
      await canvas.recompute(node); canvas.renderNode(node);
      added.push(node);
    }
    for (const n of picked) { n.data.agent = nextRef(); added.push(n); }
    if (added.length) { canvas.afterChange(); graph.scheduleSave(); }
    drawFiles();
    const note = added.length ? `참고 자료 ${added.map((n) => `${n.data.agent} "${name(n)}"`).join(', ')}` : '';
    st.log.push({ who: 'me', text: [text, note && `(attached: ${added.map((n) => n.data.agent).join(', ')})`].filter(Boolean).join(' ') });
    bubble('me', text, note ? h('p.hint', {}, note) : null);
    await turn();
  }

  return { toggle, send, state: st, apply, nextStage };
}
