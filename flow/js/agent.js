// The agent: a chat panel. The person says what picture or video they want; Claude (through the bridge's /api/llm, or a
// Claude chat by copy and paste) answers with a plan as JSON, and this file turns the plan into nodes and runs them.
//  - When the plan needs something only the person has (a face, a product, a place), the agent asks for it first.
//  - Generation goes in stages (stills, then the videos that depend on them); after each stage the person is asked
//    whether the result is right. A written complaint goes back to Claude together with the result pictures.
// Nodes the agent made carry data.agent = their key in the plan; reference material is ref1, ref2, …
import { NODE_TYPES, buildRequest, finalResolutions, UPSCALE_METHODS } from './nodes.js';
import { listModels, getModel, modelRoles, modelDurations, modelParams, recentModels } from './models.js';
import { settings, saveSettings, bridge, refreshBridge, serverReady, PROVIDERS, llmModel, llmName } from './providers.js';
import { displayUrl, pictureData, frameBlobs, saveBlob } from './media.js';
import { h, toast, relayBox, lightbox } from './ui.js';

const BUILDABLE = new Set(['image', 'video', 'frame', 'trim', 'vupscale', 'board']);
const EDITABLE = new Set(['text', 'image', 'video', 'frame', 'trim', 'vupscale', 'board']); // existing nodes the agent may change
const FIELD_KO = { start: '시작', end: '끝', title: '시퀀스 이름', text: '글', prompt: '프롬프트', model: '모델', aspect: '화면비', count: '변형 수', duration: '길이', params: '설정', at: '위치', method: '방식', resolution: '해상도' };
const MEDIA = ['image', 'video', 'audio'];
// Conversations are kept in the browser, one per workflow, so a reload (or opening the workflow again) continues them.
const TALK_KEY = 'flow.agent.v1', TALK_MAX = 30;
const talks = {
  all() { try { return JSON.parse(localStorage.getItem(TALK_KEY) || '{}'); } catch { return {}; } },
  get(id) { return (id && this.all()[id]) || null; },
  put(id, talk) {
    if (!id) return;
    const all = this.all();
    if (talk) all[id] = { ...talk, at: Date.now() }; else delete all[id];
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, TALK_MAX);
    try { localStorage.setItem(TALK_KEY, JSON.stringify(Object.fromEntries(keep))); } catch { /* storage full: the conversation lives until the page closes */ }
  },
};
const isRef = (key) => /^ref\d+$/.test(key);
const isCanvas = (key) => /^c\d+$/.test(key); // a node of the existing workflow, as named to Claude

const RULES = `You are the production agent of a node-canvas tool for AI image and video generation. A filmmaker tells you what they want; you decide the nodes, models, settings and prompts, and the tool builds and runs them. The filmmaker wants photorealistic, live-action looking results unless they say otherwise.

Answer with exactly one JSON object and nothing else (no markdown fence, no commentary):

{"action":"ask","message":"..."}
  Use this when you cannot do a good job without something only the filmmaker can give:
  - a specific person, character, product, location, logo or existing shot that the request refers to ("me", "our product", "the same character as before", "like this photo") and that is not in the reference material listed below;
  - a choice that changes the cost or the result a lot and that you cannot settle with a sensible default.
  Ask for everything in one message, as a short numbered list, saying for each item what kind of file or answer you need. Do not ask about things you can decide yourself (aspect ratio defaults to 16:9, video length to 5 seconds). If the request is generic and needs no specific identity, do not ask: build.

{"action":"build","message":"...","nodes":[...],"links":[...],"unlink":[...],"rerun":[...]}
  "message": 1 to 3 sentences telling the filmmaker what you set up (or changed) and why. "unlink" and "rerun" are optional and only concern existing nodes (see "The existing workflow").

"message" is always written in Korean, plain and short. Refer to nodes by their names ("캐릭터 시트", "샷 1"), never by keys such as c1, ref2 or shot1: the filmmaker does not see keys.

Nodes
  {"key":"still","type":"image","label":"시작 이미지","model":"<image model id>","prompt":"...","aspect":"16:9","count":2,"params":{}}
  {"key":"shot1","type":"video","label":"샷 1","model":"<video model id>","prompt":"...","aspect":"16:9","duration":5,"count":2,"params":{}}
  {"key":"last1","type":"frame","label":"샷 1 마지막 프레임","at":"last"}   takes a video and gives its first or last frame as an image ("at": "first" or "last")
  {"key":"cut1","type":"trim","label":"레퍼런스 구간","start":3,"end":11}   takes a video and gives the part between "start" and "end" seconds ("end":0 = to the end). Free. A reference video (vref) must be 2 to 30 seconds long: put a trim node before vref when the source may be longer, or when only part of it matters.
  {"key":"up1","type":"vupscale","label":"샷 1 1080p","method":"wan","resolution":"1080p"}   takes a video and renders it again at a higher resolution (methods: ${UPSCALE_METHODS.map((m) => m.id).join(', ')}). Only when the filmmaker asks for upscaling.
  {"key":"board1","type":"board","title":"확정 샷"}   a shot board: collects images and videos in the order of your links into its "shots" port and shows them side by side. It generates nothing and costs nothing.
  - "key": short and unique, letters, digits and underscore only. "label": a short Korean name shown on the node.
  - "model" must be an id from the model list below. "params" may only use the parameter names and values listed for that model. Leave out what you do not need to set.
  - "prompt": the complete prompt, in English, written for that model: subject, action, setting, light, lens and framing, and for a video the camera move and what happens over time.
  - "count" is the number of variants (1 to 4). Use 2 unless the filmmaker says otherwise.

Links: "fromKey>toKey.port". fromKey is a node key, a reference key (ref1, ref2, …) or the key of an existing node (c1, c2, …). Ports of image and video nodes, only those listed for the chosen model: start (first frame), end (last frame), refs (reference images), vref (reference videos), aref (reference audio), and prompt (takes text nodes only). frame, trim and vupscale nodes have the one port "video"; a board has the one port "shots" (any number of images and videos).
  - Images linked to "refs" of a node are numbered in the order of your links: the first is @Image 1, the second @Image 2 (likewise @Video N for vref and @Audio N for aref). In that node's prompt, point at each reference with its tag and say what it is used for ("the woman from @Image 1", "the room from @Image 2"). start and end have no tag.
  - Never write a tag that has no link behind it.

The existing workflow
  The nodes the filmmaker already has on the canvas are listed under "Existing workflow" with the keys c1, c2, …: what each is, its text or prompt, whether it has a result, and how they are connected. Read it before planning.
  - Use what is there instead of making it again: an existing character sheet, approved still, extracted frame or uploaded picture can be a link source exactly like a reference (c3>shot1.refs, c5>shot1.start), and an existing video can go to vref or to a frame or vupscale node.
  - An existing text node (a look, a character description, a shot description) can be linked to the "prompt" port of your image or video node. Connected texts are sent first, in link order, followed by the node's own "prompt"; so write in "prompt" only what the connected texts do not already say.
  - Match what is there: when the filmmaker's existing shots share a model, aspect ratio, look text or character reference, a shot you add should use the same unless they ask otherwise.
  - You may change an existing node when the filmmaker asks for it, or when changing it is plainly the way to do what they ask. List it under "nodes" with its c-key and only the fields that change (no "type"). What can be changed: a text node ("text": the complete new text), an image or video node (prompt, model, aspect, count, duration, params), a frame node (at), a vupscale node (method, resolution, prompt), a board (title; its contents are changed with links and unlink). Their prompts were written or approved by the filmmaker: change the smallest part that does the job and keep the rest word for word. Never touch a node they did not ask about.
  - A text or prompt shown ending in "… [shortened]" is not complete here: do not change that node. Ask the filmmaker to select it and send the request again.
  - A text node that feeds several generation nodes changes all of them: say so in "message".
  - "unlink":["fromKey>toKey.port", …] removes existing links (for example to swap a reference). Links into existing nodes are allowed; a port that takes one input replaces what was connected.
  - "rerun":["c7", …] lists existing generation nodes to generate again. An existing generation node you changed is generated again by itself; nodes that only sit after a changed text are not, so list the ones the filmmaker wants regenerated. Use it also when they just ask for another take of an existing node.
  - An existing node marked "no result" has nothing to hand on yet; do not build on it unless the filmmaker asks, and say so in "message" if you do.
  - Nodes marked "selected" are the ones the filmmaker is pointing at with this message. The mark can be on an existing node or on one of your own under "Current nodes"; both lists together are the whole canvas. A board shows its node name and, separately, its sequence title: the filmmaker may call it by either.
  - A node marked "locked" has a result the filmmaker locked: that is how they mark a result as decided / approved ("결정된 것", "확정"). When they refer to the decided ones, take the locked nodes if there are any; if nothing is locked or selected and you cannot tell from the conversation, ask which nodes they mean in one short question.

How to plan
  - Organising is not generating. When the filmmaker asks to collect, arrange, sort, compare or put results on a board ("보드에 정리해줘", "모아줘", "결정된 것만 추려줘"), make a board node and link the existing result nodes into its "shots" port, in the order they should appear. Never make an image or video node for that: no collage, no contact sheet, no re-generation of what already exists. Each linked node hands over the variant the filmmaker has picked on it, so "the decided ones" are simply the nodes they mean, linked as they are. If you cannot tell which nodes they mean, ask.
  - Generate only when the filmmaker asks for a new picture or video, or for a change to one.
  - Keep it minimal: the fewest nodes that do the job.
  - A video that needs a particular look, person or composition: make the still first (an image node) and link it to the video's start port; the video prompt then describes only the motion, the camera and what changes. A plain idea with no such need can be a single video node.
  - Use attached reference material the way the filmmaker says: a person goes to refs with identity wording, a style to refs with style wording, a first frame to start.
  - Video models that list the parameter "draft": make the first pass a draft with "params":{"draft":true,"resolution":"480p"}. The filmmaker renders the approved draft at 1080p afterwards.
  - Videos are made at 480p unless the filmmaker asked for more in this conversation: set "resolution":"480p" on every video model that lists it. Anything above 480p costs several times as much, and the tool stops and asks the filmmaker for permission before running it, so do not raise the resolution on your own.
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
  const st = { log: [], files: [], busy: false, stage: [], abort: null, docId: null, view: [], keys: new Map(), seq: 0, edited: new Set(), force: new Set(), clipped: new Set(), okRes: new Map() };
  const mine = () => graph.doc.nodes.filter((n) => n.data.agent);
  const built = () => mine().filter((n) => !isRef(n.data.agent));
  const refs = () => mine().filter((n) => isRef(n.data.agent)).sort((a, b) => +a.data.agent.slice(3) - +b.data.agent.slice(3));
  const name = (n) => n.data.label || (n.type === 'board' && n.data.title) || NODE_TYPES[n.type].title;
  const nextRef = () => { const used = new Set(mine().map((n) => n.data.agent)); let i = 1; while (used.has(`ref${i}`)) i++; return `ref${i}`; };
  // The rest of the canvas: the workflow that was there before, or was made by hand. Each node gets a key (c1, c2, …)
  // that stays the same for the whole conversation, so Claude can point at it.
  const others = () => graph.doc.nodes.filter((n) => !n.data.agent && !NODE_TYPES[n.type].note);
  const canvasKey = (n) => { if (!st.keys.has(n.id)) st.keys.set(n.id, `c${++st.seq}`); return st.keys.get(n.id); };
  const keyOf = (n) => n.data.agent || canvasKey(n);
  // What the agent generates and asks about: its own nodes, and existing nodes it changed or was told to run again.
  const active = () => [...built(), ...others().filter((n) => st.edited.has(n.id) || st.force.has(n.id))];
  const picked = () => canvas.selectedNodes().filter((n) => !NODE_TYPES[n.type].note); // whoever made them
  // A copy of an agent node (Ctrl+D, copy and paste) carries the same key as its original. A key must name one node:
  // the first keeps it, the copies count as ordinary nodes of the workflow.
  const dedupe = () => { const seen = new Set(); for (const n of graph.doc.nodes) { if (!n.data.agent) continue; if (seen.has(n.data.agent)) delete n.data.agent; else seen.add(n.data.agent); } };

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
    // What can be shown again after a reload: the words, the small notes, and which nodes' results were shown.
    st.view.push({ who, text: text || '', hints: [...el.querySelectorAll(':scope > .hint')].map((x) => x.textContent), nodes: [...el.querySelectorAll('.agent-result')].map((x) => x.dataset.node) });
    save();
    return el;
  }
  function save() {
    if (!st.docId || st.docId !== graph.doc.id) return;
    talks.put(st.docId, st.view.length ? { view: st.view.slice(-200), log: st.log.slice(-200), stage: st.stage, keys: [...st.keys], seq: st.seq, edited: [...st.edited], force: [...st.force] } : null);
  }
  // Bring back the conversation saved for the open workflow, and offer to pick up where it stopped.
  function restore() {
    const talk = talks.get(graph.doc.id);
    if (!talk?.view?.length) return false;
    const alive = (id) => !!graph.node(id);
    st.log = talk.log || []; st.stage = (talk.stage || []).filter(alive);
    st.keys = new Map((talk.keys || []).filter(([id]) => alive(id))); st.seq = talk.seq || 0;
    st.edited = new Set((talk.edited || []).filter(alive)); st.force = new Set((talk.force || []).filter(alive));
    const saved = talk.view; st.view = [];
    for (const m of saved) {
      const el = h(`div.agent-msg.${m.who}`, {}, m.text ? h('p', {}, m.text) : null, ...(m.nodes || []).map((id) => graph.node(id)).filter((n) => n?.result).map(resultBlock), ...(m.hints || []).map((t) => h('p.hint', {}, t)));
      feed.append(el); st.view.push(m);
    }
    // The buttons of the last message are gone with the page: offer the step that was open.
    const stageNodes = st.stage.map((id) => graph.node(id)), waiting = st.log.length && st.log[st.log.length - 1].who === 'me' && saved[saved.length - 1].who === 'me';
    const opts = [
      waiting ? { label: '마지막 요청 다시 보내기', primary: true, run: () => turn() } : null,
      stageNodes.length ? { label: '마지막 생성 결과 확인', primary: !waiting, keep: true, run: (row) => { if (stageNodes.some((n) => engine.isRunning(n.id) || n.pending)) return toast('아직 생성 중입니다. 끝난 뒤에 다시 눌러 주세요'); row.remove(); showResults(); } } : null,
      !waiting && nextStage().length ? { label: `이어서 생성 (${nextStage().map(name).join(', ')})`, run: () => runStage() } : null,
    ].filter(Boolean);
    const el2 = h('div.agent-msg.agent.resumed', {}, h('p.hint', {}, '이전 대화를 이어서 불러왔습니다.'), opts.length ? choices(opts) : null);
    feed.append(el2); feed.scrollTop = feed.scrollHeight;
    return true;
  }
  function say(who, text, ...kids) { if (text) st.log.push({ who, text }); return bubble(who, text, ...kids); }
  // Buttons under an agent message. Pressing one retires the whole row, so an old question cannot be answered twice.
  function choices(list) {
    const row = h('div.agent-choices');
    row.append(...list.filter(Boolean).map((c) => h(`button${c.primary ? '.primary' : ''}`, { title: c.title || '', onclick: () => { if (st.busy) return; if (!c.keep) row.remove(); c.run(row); } }, c.label)));
    return row;
  }
  function intro() {
    feed.replaceChildren(h('div.agent-msg.agent', {}, h('p', {}, '만들고 싶은 이미지나 영상을 말해 주세요. 필요한 노드를 만들고 생성까지 진행합니다.'),
      h('p.hint', {}, '참고할 사진·영상이 있으면 이 창에 끌어다 놓거나 붙여넣으세요. 캔버스에 이미 있는 워크플로우(텍스트, 이미지·영상 결과, 올려 둔 자료)도 살펴보고 필요한 것을 가져다 쓰거나 고칩니다. 특정 노드를 가리키려면 선택해 두고 말하세요. 인물·제품처럼 제가 지어낼 수 없는 것이 필요하면 먼저 되묻고, 생성이 끝날 때마다 마음에 드는지 확인합니다.')));
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
    const sel = picked();
    selNote.hidden = !sel.length;
    selNote.textContent = sel.length ? `선택한 노드 ${sel.length}개(${sel.map(name).join(', ')})를 "이것"으로 가리켜 보냅니다.` : '';
  }
  function addFiles(list) {
    const ok = [...(list || [])].filter((f) => MEDIA.some((k) => f.type.startsWith(`${k}/`)));
    if (!ok.length) return toast('이미지·영상·오디오 파일만 첨부할 수 있습니다', 'error');
    st.files.push(...ok); drawFiles();
  }
  function reset(strip) {
    if (st.busy) return toast('진행 중인 작업이 끝난 뒤에 새 작업을 시작할 수 있습니다');
    if (strip) for (const n of mine()) delete n.data.agent;
    if (strip) { graph.scheduleSave(); talks.put(graph.doc.id, null); }
    st.view = []; st.log = []; st.files = []; st.stage = []; st.docId = graph.doc.id; st.keys = new Map(); st.seq = 0; st.edited = new Set(); st.force = new Set(); st.clipped = new Set(); st.okRes = new Map();
    intro(); restore(); drawFiles();
  }
  function toggle(open = panel.hidden) {
    panel.hidden = !open; document.body.classList.toggle('agent-open', open);
    button.setAttribute('aria-pressed', String(open));
    settings.agentOpen = open; saveSettings();
    if (open) { document.getElementById('connPanel').hidden = true; if (!feed.children.length || st.docId !== graph.doc.id) reset(false); if (!bridge.online) refreshBridge(); drawFiles(); input.focus(); }
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
        const res = await fetch(`${bridge.base}/api/llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, images, model: llmModel('agent') }), signal: ctrl.signal });
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
    dedupe();
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
    // The existing workflow. Pictures: the selected nodes first, then the others, while there is room.
    const rest = others(), sel = new Set(picked().map((n) => n.id));
    const cut = rest.length > 40 ? 220 : 6000; st.clipped = new Set();
    const clip = (n, t) => { const x = String(t || '').trim(); if (sel.has(n.id) || x.length <= cut) return x; st.clipped.add(n.id); return `${x.slice(0, cut)}… [shortened]`; };
    const seen = new Set();
    // Leave room for the latest results, which matter most when the filmmaker is reacting to them.
    const room = Math.min(6, 8 - Math.min(4, st.stage.filter((id) => graph.node(id)?.result).length));
    for (const n of [...rest.filter((x) => sel.has(x.id)), ...rest.filter((x) => !sel.has(x.id))]) {
      const item = engine.outItems(n)[0];
      if (!item || !MEDIA.includes(item.type) || item.type === 'audio' || images.length >= room) continue;
      const before = images.length;
      await look(item, `existing node ${canvasKey(n)} (${name(n)})`, images);
      if (images.length > before) seen.add(n.id);
    }
    lines.push('', 'Existing workflow:');
    if (!rest.length) lines.push('(the canvas has nothing else on it)');
    for (const n of rest) {
      const def = NODE_TYPES[n.type], item = engine.outItems(n)[0];
      const ins = graph.ports(n, 'in').flatMap((p) => engine.sourceNodes(n, p.key).map((x) => `${keyOf(x)}>${p.key}`));
      const gives = n.type === 'board' ? 'collects shots (port: shots)' : item ? `gives ${item.type}${seen.has(n.id) ? ' (picture attached)' : MEDIA.includes(item.type) && item.type !== 'audio' ? ' (not attached)' : ''}` : def.spends ? 'no result' : 'empty';
      const gen = n.type === 'image' || n.type === 'video';
      const about = [gen ? `model ${n.data.model}, aspect ${n.data.aspect}${n.type === 'video' ? `, ${n.data.duration}s` : ''}${n.data.params?.resolution ? `, ${n.data.params.resolution}` : ''}` : '', n.type === 'media' ? `${n.data.kind} file "${n.data.name || n.data.url || ''}"` : '', n.type === 'vupscale' ? `${n.data.method} ${n.data.resolution}` : '', n.type === 'trim' ? `start ${n.data.start}s, end ${n.data.end || 'to the end'}${n.message ? ` (${n.message})` : ''}` : '', n.type === 'board' ? `sequence title "${n.data.title || ''}"` : ''].filter(Boolean).join('');
      lines.push(`- ${canvasKey(n)} | ${n.type} | "${name(n)}"${sel.has(n.id) ? ' | selected' : ''}${n.data.locked && n.result ? ' | locked' : ''}${about ? ` | ${about}` : ''} | ${gives}${n.result?.v ? ` v${n.result.v}` : ''}${n.status === 'error' ? ` | failed: ${n.message}` : ''}${st.edited.has(n.id) ? ' | changed by you' : ''} | links in: ${ins.join(', ') || 'none'}`);
      const text = n.type === 'text' ? n.data.text : item?.type === 'text' ? item.text : gen || n.type === 'vupscale' ? n.data.prompt : '';
      if (text) lines.push(`  ${gen || n.type === 'vupscale' ? 'own prompt' : 'text'}: ${clip(n, text)}`);
    }
    lines.push('', 'Current nodes (the ones you made in this conversation):');
    const nodes = built();
    if (!nodes.length) lines.push('(none yet)');
    for (const n of nodes) {
      const ins = graph.ports(n, 'in').flatMap((p) => engine.sourceNodes(n, p.key).map((x) => `${keyOf(x)}>${p.key}`));
      const set = n.type === 'image' || n.type === 'video' ? { model: n.data.model, aspect: n.data.aspect, ...(n.type === 'video' ? { duration: +n.data.duration } : {}), count: +n.data.count, params: n.data.params } : n.type === 'frame' ? { at: n.data.at } : n.type === 'trim' ? { start: n.data.start, end: n.data.end } : n.type === 'board' ? { title: n.data.title } : { method: n.data.method, resolution: n.data.resolution };
      const state = n.type === 'board' ? `shows ${engine.outItems(n).length} item(s)` : n.status === 'error' ? `failed: ${n.message}` : n.result ? `generated v${n.result.v || 1}${engine.isStale(n) ? ' (settings changed since)' : ''}` : 'not generated yet';
      lines.push(`- ${n.data.agent} | ${n.type} | "${name(n)}"${sel.has(n.id) ? ' | selected' : ''} | ${JSON.stringify(set)} | links in: ${ins.join(', ') || 'none'} | ${state}${n.data.prompt ? `\n  prompt: ${n.data.prompt}` : ''}`);
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
    } else if (type === 'text') {
      if (typeof spec.text === 'string') data.text = spec.text.trim();
    } else if (type === 'board') {
      const title = typeof spec.title === 'string' && spec.title.trim() ? spec.title : spec.label;
      if (typeof title === 'string' && title.trim()) data.title = title.trim().slice(0, 60);
      delete data.label;
    } else if (type === 'trim') {
      if (spec.start != null) data.start = Math.max(0, +spec.start || 0);
      if (spec.end != null) data.end = Math.max(0, +spec.end || 0);
    } else if (type === 'frame') {
      if (spec.at === 'first' || spec.at === 'last') data.at = spec.at;
    } else if (type === 'vupscale') {
      if (UPSCALE_METHODS.some((m) => m.id === spec.method)) data.method = spec.method;
      if (typeof spec.resolution === 'string') data.resolution = spec.resolution;
      if (typeof spec.prompt === 'string') data.prompt = spec.prompt.trim();
    }
    return data;
  }
  async function apply(plan) {
    const problems = [], made = [], changed = [];
    const byKey = new Map(mine().map((n) => [n.data.agent, n]));
    for (const n of others()) if (st.keys.has(n.id)) byKey.set(st.keys.get(n.id), n);
    graph.checkpoint();
    const all = canvas.bounds(graph.doc.nodes), at = all ? { x: all.x0, y: all.y1 + 140 } : canvas.center();
    for (const spec of Array.isArray(plan.nodes) ? plan.nodes : []) {
      const key = String(spec?.key || '').trim();
      const have = byKey.get(key);
      if (isCanvas(key) && !have) { problems.push(`${key}: 없는 노드라 건너뛰었습니다`); continue; }
      if (!/^\w+$/.test(key) || isRef(key)) { problems.push(`이름(${key || '없음'})을 쓸 수 없는 노드는 건너뛰었습니다`); continue; }
      const type = have?.type || spec.type, own = !have || !!have.data.agent;
      if (!(own ? BUILDABLE : EDITABLE).has(type)) { problems.push(have ? `${name(have)}: 이 종류의 노드(${NODE_TYPES[type].title})는 에이전트가 고치지 않습니다` : `${key}: 만들 수 없는 노드 종류(${spec.type})라 건너뛰었습니다`); continue; }
      if (have && !own && st.clipped.has(have.id) && (spec.prompt != null || spec.text != null)) { problems.push(`${name(have)}: 글이 길어 일부만 읽은 상태라 고치지 않았습니다. 그 노드를 선택하고 다시 요청해 주세요`); continue; }
      const data = dataOf(type, { ...spec, key: have && !own ? name(have) : key }, have, problems);
      if (!own) delete data.label; // the filmmaker's names stay
      if (have) {
        const was = JSON.stringify(have.data);
        Object.assign(have.data, data, data.params ? { params: { ...have.data.params, ...data.params } } : {});
        if (JSON.stringify(have.data) === was) continue;
        graph.pruneEdges(have.id); canvas.renderNode(have);
        if (NODE_TYPES[type].instant) await canvas.recompute(have);
        graph.emit('node:data', have);
        if (!own) { changed.push(`${name(have)} (${Object.keys(data).map((k) => FIELD_KO[k] || k).join('·')})`); if (NODE_TYPES[type].spends) st.edited.add(have.id); }
      } else {
        const node = graph.addNode(type, at.x + made.length * 400, at.y, { ...data, agent: key });
        byKey.set(key, node); made.push(node);
      }
    }
    const ends = (link) => { const m = /^\s*(\w+)(?:\.\w+)?\s*>\s*(\w+)\.(\w+)\s*$/.exec(String(link)); return m && byKey.get(m[1]) && byKey.get(m[2]) ? { from: byKey.get(m[1]), to: byKey.get(m[2]), port: m[3] } : null; };
    for (const link of Array.isArray(plan.unlink) ? plan.unlink : []) {
      const e = ends(link), edge = e && graph.doc.edges.find((x) => x.from.node === e.from.id && x.to.node === e.to.id && x.to.port === e.port);
      if (!edge) { problems.push(`연결 끊기 ${link}: 그런 연결이 없습니다`); continue; }
      graph.removeEdge(edge.id);
      const order = e.to.data.order?.[e.port]; if (order) e.to.data.order[e.port] = order.filter((id) => id !== e.from.id);
      if (!e.to.data.agent) { changed.push(`${name(e.to)} (${name(e.from)} 연결 끊음)`); if (NODE_TYPES[e.to.type].spends) st.edited.add(e.to.id); }
    }
    for (const link of Array.isArray(plan.links) ? plan.links : []) {
      const e = ends(link);
      if (!e) { problems.push(`연결 ${link}: 없는 노드를 가리켜 건너뛰었습니다`); continue; }
      const { from, to } = e, m = [0, 0, 0, e.port];
      const r = graph.connect({ node: from.id, port: 'out' }, { node: to.id, port: m[3] });
      if (r.error) { if (!/이미 연결/.test(r.error)) problems.push(`연결 ${link}: ${r.error}`); continue; }
      if (!to.data.agent && to.type !== 'board') { changed.push(`${name(to)} (${name(from)} 연결)`); if (NODE_TYPES[to.type].spends) st.edited.add(to.id); }
      // References are numbered (@Image 1, 2, …) in the order of the plan's links, wherever the nodes end up on the canvas.
      if (graph.port(to, 'in', m[3])?.multi) { const order = ((to.data.order ||= {})[m[3]] ||= []); if (!order.includes(from.id)) order.push(from.id); }
    }
    canvas.afterChange();
    for (const n of made) if (NODE_TYPES[n.type].instant) { await canvas.recompute(n); canvas.paintPreview(n); }
    if (made.length) {
      // Lay the agent's nodes out together, references on the left.
      const group = mine();
      canvas.select(group.map((n) => n.id));
      if (group.length > 1) canvas.autoLayout(); else canvas.reveal(group);
      canvas.select([]);
    }
    for (const key of Array.isArray(plan.rerun) ? plan.rerun : []) {
      const n = byKey.get(String(key));
      if (n && NODE_TYPES[n.type].spends) st.force.add(n.id); else problems.push(`다시 생성 ${key}: 생성 노드가 아니라 건너뛰었습니다`);
    }
    return { problems, changed };
  }

  // ---- generating in stages
  // Generating nodes of the agent that still have to run, and of those the ones whose inputs are ready.
  function nextStage() {
    const need = active().filter((n) => NODE_TYPES[n.type].spends && !(n.data.locked && n.result) && (!n.result || engine.isStale(n) || n.status === 'error' || st.force.has(n.id)));
    return need.filter((n) => ![...graph.upstream(n.id)].some((id) => need.some((m) => m.id === id)));
  }
  async function stageCost(nodes) {
    if (settings.mode !== 'bridge' || !serverReady(settings.server)) return '';
    const ctx = { signal: new AbortController().signal, progress() {} };
    const costs = await Promise.all(nodes.map(async (n) => { try { return n.type === 'image' || n.type === 'video' ? await PROVIDERS.bridge.cost(buildRequest(n, engine.inputsOf(n)), ctx) : null; } catch { return null; } }));
    const known = costs.filter((c) => c != null);
    return known.length ? ` 예상 크레딧 ${known.reduce((a, b) => a + b, 0)}${known.length < nodes.length ? ' (일부는 미리 알 수 없음)' : ''}.` : '';
  }
  // The resolution a node would render a video at, when that is above 480p (or cannot be told): { label, lower }.
  // `lower` says the node could be run at 480p instead. Stills and 480p videos give null.
  const pixels = (r) => { const t = String(r).toLowerCase(); return t === '4k' ? 2160 : t === '2k' ? 1440 : parseInt(t, 10) || 0; };
  function highRes(n) {
    if (n.type === 'vupscale') return { label: n.data.resolution || '1080p', lower: false };
    if (n.type !== 'video') return null;
    let req; try { req = buildRequest(n, engine.inputsOf(n)); } catch { return null; } // it will fail when run and say why
    const p = getModel(req.model)?.parameters?.find((x) => x.name === 'resolution'), res = req.params.resolution;
    if (res != null && pixels(res) && pixels(res) <= 512) return null;
    return { label: res != null ? String(res) : '모델 기본 해상도', lower: !!p?.options?.includes('480p') };
  }
  // Videos above 480p are only run with the filmmaker's say-so: asked once per node and resolution.
  async function permit(stage) {
    const high = stage.map((n) => ({ n, ...highRes(n) })).filter((x) => x.label && st.okRes.get(x.n.id) !== x.label);
    if (!high.length) return true;
    setBusy('예상 크레딧 확인 중…');
    const cost = await stageCost(stage);
    setBusy('');
    const allow = () => { for (const x of high) st.okRes.set(x.n.id, x.label); };
    const lowerable = high.filter((x) => x.lower);
    say('agent', `480p보다 높은 화질로 영상을 만들려고 합니다: ${high.map((x) => `${name(x.n)} (${x.label})`).join(', ')}.${cost} 이대로 생성할까요?`,
      choices([
        { label: '허락 — 이 화질로 생성', primary: true, run: () => { st.log.push({ who: 'me', text: '(높은 화질로 생성하도록 허락함)' }); allow(); runStage(); } },
        lowerable.length ? { label: lowerable.length < high.length ? `${lowerable.map((x) => name(x.n)).join(', ')}만 480p로 낮추고, ${high.filter((x) => !x.lower).map((x) => `${name(x.n)}(480p 없음)`).join(', ')}은 그대로 생성` : '480p로 낮춰서 생성', run: () => {
          st.log.push({ who: 'me', text: '(480p로 낮춰서 생성하라고 함)' });
          graph.checkpoint();
          for (const x of lowerable) { (x.n.data.params ||= {}).resolution = '480p'; canvas.renderNode(x.n); graph.emit('node:data', x.n); }
          for (const x of high) if (!x.lower) st.okRes.set(x.n.id, x.label);
          runStage();
        } } : null,
        { label: '생성하지 않기', run: () => { st.log.push({ who: 'me', text: '(높은 화질 생성을 허락하지 않음)' }); say('agent', '생성하지 않았습니다. 노드는 캔버스에 그대로 있습니다. 화질이나 내용을 바꾸려면 말씀해 주세요.'); } },
      ]));
    return false;
  }
  async function runStage() {
    const stage = nextStage();
    if (!stage.length) return finish();
    if (!(await permit(stage))) return;
    st.stage = stage.map((n) => n.id);
    setBusy('예상 크레딧 확인 중…');
    const cost = await stageCost(stage);
    say('agent', `생성을 시작합니다: ${stage.map(name).join(', ')}.${cost}`);
    setBusy('생성 중…', () => engine.stop());
    let failed;
    try { failed = await guarded(st.stage, true, '에이전트 생성'); } finally { setBusy(''); }
    if (failed !== null) for (const id of st.stage) st.force.delete(id);
    save();
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
    return h('div.agent-result', { 'data-node': n.id }, h('b', {}, `${name(n)}${n.result?.v ? ` · v${n.result.v}` : ''}`), h('div.agent-thumbs', {}, tiles), pickRow);
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
    const drafts = active().filter((n) => n.type === 'video' && n.result?.request?.draft && finalResolutions(n, engine.outItems(n)[0]).includes('1080p'));
    const upscaled = new Set(graph.doc.nodes.filter((n) => n.type === 'vupscale').flatMap((n) => graph.edgesInto(n.id).map((e) => e.from.node)));
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
    st.okRes.set(node.id, '1080p'); // asked for by pressing the button
    runStage();
  }

  // ---- one turn of the conversation
  async function turn() {
    setBusy(`생각하는 중…${llmName('agent') ? ` (${llmName('agent')})` : ''}`, () => st.abort?.abort());
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
    const { problems, changed } = await apply(plan);
    say('agent', message || '노드를 구성했습니다.',
      changed.length ? h('p.hint', {}, `바꾼 기존 노드: ${changed.join(', ')}. 원래대로 돌리려면 Ctrl+Z를 누르세요.`) : null,
      problems.length ? h('p.hint', {}, `참고: ${problems.join(' · ')}`) : null);
    if (nextStage().length) await runStage();
  }
  async function send() {
    const text = input.value.trim();
    if (st.busy || (!text && !st.files.length)) return;
    input.value = '';
    st.docId = graph.doc.id;
    // Attached files become reference material (ref1, ref2, …), placed on the canvas as media nodes.
    const files = st.files, added = [];
    st.files = [];
    if (files.length) graph.checkpoint();
    const all = canvas.bounds(graph.doc.nodes), at = all ? { x: all.x0, y: all.y1 + 140 } : canvas.center();
    for (const [i, f] of files.entries()) {
      const node = graph.addNode('media', at.x + i * 300, at.y, { kind: MEDIA.find((k) => f.type.startsWith(`${k}/`)), file: await saveBlob(f), name: f.name, label: f.name.replace(/\.[^.]+$/, '').slice(0, 40), agent: nextRef() });
      await canvas.recompute(node); canvas.renderNode(node);
      added.push(node);
    }
    if (added.length) { canvas.afterChange(); graph.scheduleSave(); }
    drawFiles();
    const note = added.length ? `참고 자료 ${added.map((n) => `${n.data.agent} "${name(n)}"`).join(', ')}` : '';
    st.log.push({ who: 'me', text: [text, note && `(attached: ${added.map((n) => n.data.agent).join(', ')})`].filter(Boolean).join(' ') });
    bubble('me', text, note ? h('p.hint', {}, note) : null);
    await turn();
  }

  return { toggle, send, state: st, apply, nextStage };
}
