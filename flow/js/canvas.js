// The canvas: pan/zoom, node cards, typed ports, edges, selection, minimap.
import { NODE_TYPES, CATEGORIES, finalResolutions, TAG_PORTS } from './nodes.js';
import { TYPE_LABEL } from './graph.js';
import { displayUrl, saveBlob } from './media.js';
import { h, toast, menu, palette, tabPicker, copyText, lightbox } from './ui.js';
import { listModels, getModel, recentModels, touchModel } from './models.js';

const SVG = 'http://www.w3.org/2000/svg';
const INTERACTIVE = 'input,textarea,select,button,video,a,.port,[contenteditable="true"],.thumb,.resize';
const STATUS = { idle: '', queued: '대기', running: '실행 중', done: '완료', error: '오류' };
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.'); const last = keys.pop();
  let o = obj; for (const k of keys) o = o[k] ??= {};
  o[last] = value;
}

export class Canvas {
  constructor({ stage, graph, engine, actions }) {
    Object.assign(this, { stage, graph, engine, actions });
    this.world = h('div.world');
    this.edgeLayer = document.createElementNS(SVG, 'svg'); this.edgeLayer.classList.add('edges');
    this.nodeLayer = h('div.nodes');
    this.world.append(this.edgeLayer, this.nodeLayer);
    this.marquee = h('div.marquee', { hidden: true });
    this.mini = h('canvas.minimap', { width: 180, height: 120, 'aria-label': '미니맵' });
    this.empty = h('div.empty', {},
      h('h2', {}, '빈 캔버스'),
      h('p', {}, '빈 곳을 더블클릭하거나 우클릭하면 노드를 추가합니다. 위쪽 "템플릿"에서 완성된 흐름으로 시작할 수도 있습니다.'));
    stage.append(this.world, this.marquee, this.mini, this.empty);
    this.els = new Map();
    this.sel = new Set();
    this.selEdge = null;
    this.clip = null;
    this.frame = 0;
    this.bind();
    graph.on((kind, detail) => this.onGraph(kind, detail));
    new ResizeObserver(() => this.queueEdges()).observe(this.nodeLayer);
    setInterval(() => { for (const n of graph.doc.nodes) if (n.status === 'running') this.paintStatus(n); }, 1000);
  }

  get view() { return this.graph.doc.view; }
  toWorld(cx, cy) { const r = this.stage.getBoundingClientRect(); return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k }; }
  applyView() {
    const v = this.view;
    this.world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    this.stage.style.backgroundPosition = `${v.x}px ${v.y}px`;
    this.stage.style.backgroundSize = `${24 * v.k}px ${24 * v.k}px`;
    this.stage.classList.toggle('far', v.k < 0.45);
    this.drawMini(); this.graph.scheduleSave();
    this.actions.onView?.(v.k);
  }
  zoomAt(cx, cy, factor) {
    const v = this.view, r = this.stage.getBoundingClientRect();
    const k = Math.max(0.15, Math.min(2.5, v.k * factor));
    const px = cx - r.left, py = cy - r.top;
    v.x = px - ((px - v.x) / v.k) * k; v.y = py - ((py - v.y) / v.k) * k; v.k = k;
    this.applyView();
  }
  zoomBy(factor) { const r = this.stage.getBoundingClientRect(); this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor); }
  bounds(nodes = this.graph.doc.nodes) {
    if (!nodes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const el = this.els.get(n.id);
      const hgt = el ? el.offsetHeight : 200;
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + hgt);
    }
    return { x0, y0, x1, y1 };
  }
  fit(nodes) {
    const b = this.bounds(nodes?.length ? nodes : undefined), r = this.stage.getBoundingClientRect();
    if (!b || !r.width) { Object.assign(this.view, { x: 0, y: 0, k: 1 }); return this.applyView(); }
    const pad = 60, k = Math.max(0.15, Math.min(1, (r.width - pad * 2) / (b.x1 - b.x0), (r.height - pad * 2) / (b.y1 - b.y0)));
    Object.assign(this.view, { k, x: (r.width - (b.x1 - b.x0) * k) / 2 - b.x0 * k, y: (r.height - (b.y1 - b.y0) * k) / 2 - b.y0 * k });
    this.applyView();
  }
  center() { const r = this.stage.getBoundingClientRect(); return this.toWorld(r.left + r.width / 2, r.top + r.height / 2); }

  // ---- graph events
  onGraph(kind, node) {
    if (kind === 'reset') this.renderAll();
    else if (kind === 'node:add') { this.renderNode(node); this.afterChange(); }
    else if (kind === 'edges') this.afterChange();
    else if (kind === 'node:status') this.paintStatus(node);
    else if (kind === 'node:result') { this.paintStatus(node); this.paintPreview(node); this.refreshDependents(node); this.queueEdges(); }
    else if (kind === 'node:data') { this.paintStatus(node); this.refreshDependents(node); this.queueCost(); }
    else if (kind === 'run:end') this.actions.onRunState?.();
  }
  afterChange() {
    this.empty.hidden = this.graph.doc.nodes.length > 0;
    for (const n of this.graph.doc.nodes) { this.paintPorts(n); this.paintStatus(n); this.paintTags(n); }
    this.queueEdges(); this.actions.onSelection?.(); this.queueCost();
  }
  // Expected credits are asked for a moment after things settle, not on every keystroke.
  queueCost() { clearTimeout(this.costTimer); this.costTimer = setTimeout(() => { for (const n of this.graph.doc.nodes) if (n.type === 'image' || n.type === 'video') this.actions.estimate?.(n); }, 700); }
  // Nodes after this one may now be out of date, and instant nodes (text joins, boards) can simply be recomputed.
  refreshDependents(node) {
    for (const id of this.graph.downstream(node.id)) {
      const n = this.graph.node(id);
      if (NODE_TYPES[n.type].instant && !this.engine.isRunning(id) && n.type !== 'frame') this.recompute(n);
      else this.paintStatus(n);
      this.paintTags(n);
    }
  }
  async recompute(n) {
    try {
      const res = await NODE_TYPES[n.type].run({ node: n, inputs: this.engine.inputsOf(n) });
      n.result = { items: res.items, at: Date.now() }; n.sig = this.engine.signature(n); n.status = 'done'; n.message = '';
    } catch { return; }
    this.paintPreview(n); this.paintStatus(n);
  }

  renderAll() {
    this.nodeLayer.replaceChildren(); this.els.clear();
    for (const id of [...this.sel]) if (!this.graph.node(id)) this.sel.delete(id);
    if (this.selEdge && !this.graph.doc.edges.some((e) => e.id === this.selEdge)) this.selEdge = null;
    for (const n of this.graph.doc.nodes) this.renderNode(n);
    this.applyView(); this.afterChange();
  }

  // ---- node card
  renderNode(node) {
    const def = NODE_TYPES[node.type];
    const old = this.els.get(node.id);
    const el = h(`div.node${def.note ? '.note' : ''}`, { dataset: { id: node.id, type: node.type }, style: { left: `${node.x}px`, top: `${node.y}px`, width: `${node.w}px` } });
    const title = h('span.title', { title: '더블클릭해 이름 바꾸기', ondblclick: (e) => this.rename(node, e.currentTarget) }, node.data.label || def.title);
    const head = h('div.node-head', {}, h('i.cat', { dataset: { cat: def.category } }), title, h('span.chip'),
      def.instant ? null : h('button.run', { title: '이 노드 실행 (Ctrl+Enter)', 'aria-label': '실행', onclick: () => this.actions.runNode(node.id) }, '▶'),
      h('button.more', { title: '메뉴', 'aria-label': '노드 메뉴', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); this.nodeMenu(node, r.left, r.bottom + 4); } }, '⋯'));
    el.append(head, h('div.ports'), h('div.fields'), h('div.cost', { hidden: true }), h('div.preview'), h('div.foot'), h('div.resize', { title: '너비 조절' }));
    if (old) old.replaceWith(el); else this.nodeLayer.append(el);
    this.els.set(node.id, el);
    el.classList.toggle('sel', this.sel.has(node.id));
    this.paintPorts(node); this.paintFields(node); this.paintPreview(node); this.paintStatus(node);
    return el;
  }
  rename(node, span) {
    span.contentEditable = 'true'; span.focus();
    getSelection().selectAllChildren(span);
    const finish = () => {
      span.contentEditable = 'false';
      const v = span.textContent.trim();
      if (v !== (node.data.label || NODE_TYPES[node.type].title)) { this.graph.checkpoint(); node.data.label = v && v !== NODE_TYPES[node.type].title ? v : undefined; this.graph.emit('node:data', node); }
      span.textContent = node.data.label || NODE_TYPES[node.type].title;
    };
    span.addEventListener('blur', finish, { once: true });
    span.onkeydown = (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); span.blur(); } e.stopPropagation(); };
  }
  paintPorts(node) {
    const el = this.els.get(node.id); if (!el) return;
    const box = el.querySelector('.ports');
    const ins = this.graph.ports(node, 'in'), outs = this.graph.ports(node, 'out');
    const key = JSON.stringify([ins.map((p) => [p.key, p.type]), outs.map((p) => [p.key, p.type])]);
    const rows = (list, side) => list.map((p) => {
      const n = side === 'in' ? this.graph.edgesInto(node.id, p.key).length : this.graph.edgesFrom(node.id, p.key).length;
      return h(`div.port.${side}${n ? '.linked' : ''}`, { dataset: { node: node.id, port: p.key, side, type: p.type }, title: `${TYPE_LABEL[p.type]}${p.multi ? ' · 여러 개 연결 가능' : ''}` },
        h('i.dot'), h('span', {}, p.label, p.multi && n > 1 ? ` ×${n}` : ''));
    });
    box.replaceChildren(h('div.col', {}, rows(ins, 'in')), h('div.col.right', {}, rows(outs, 'out')));
    box.hidden = !ins.length && !outs.length;
    box.dataset.key = key;
  }
  paintFields(node) {
    const el = this.els.get(node.id); if (!el) return;
    const def = NODE_TYPES[node.type];
    const box = el.querySelector('.fields');
    box.replaceChildren(...def.fields(node).map((f) => this.field(node, f)));
    this.paintTags(node);
  }
  // Reference tags under the prompt: one chip per connected reference, numbered the way it is sent. A click types the tag.
  paintTags(node) {
    const box = this.els.get(node.id)?.querySelector('.tags'); if (!box) return;
    const chips = [];
    for (const [key, name] of Object.entries(TAG_PORTS)) {
      this.engine.sourcesOf(node, key).forEach(({ src, item }, i) => {
        const tag = `@${name} ${i + 1}`, url = displayUrl(item.url);
        chips.push(h('button.tag-chip', { title: `프롬프트에 ${tag} 넣기`, onclick: () => this.insertTag(node, tag) },
          item.type === 'image' && url ? h('img', { src: url, alt: '', loading: 'lazy', draggable: false }) : null, h('b', {}, tag), h('span', {}, src.data.label || NODE_TYPES[src.type].title)));
      });
    }
    // Connected but not generated yet: the number is known from the connection order, the picture is not there yet.
    if (!chips.length) {
      for (const [key, name] of Object.entries(TAG_PORTS)) {
        this.graph.edgesInto(node.id, key).map((e) => this.graph.node(e.from.node)).filter(Boolean).sort((a, b) => a.y - b.y || a.x - b.x).forEach((src, i) => {
          const tag = `@${name} ${i + 1}`;
          chips.push(h('button.tag-chip', { title: `프롬프트에 ${tag} 넣기`, onclick: () => this.insertTag(node, tag) }, h('b', {}, tag), h('span', {}, src.data.label || NODE_TYPES[src.type].title)));
        });
      }
    }
    box.replaceChildren(...(chips.length ? [h('small', {}, '레퍼런스 태그 — 누르면 프롬프트에 들어갑니다'), ...chips] : []));
    box.hidden = !chips.length;
  }
  insertTag(node, tag) {
    const ta = this.els.get(node.id)?.querySelector('.fields textarea'); if (!ta) return;
    const at = document.activeElement === ta ? ta.selectionStart : ta.value.length;
    const before = ta.value.slice(0, at), after = ta.value.slice(document.activeElement === ta ? ta.selectionEnd : at);
    const text = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${tag} `;
    this.graph.checkpoint();
    ta.value = text + after; node.data.prompt = ta.value;
    ta.focus(); ta.setSelectionRange(text.length, text.length);
    this.graph.emit('node:data', node);
  }
  field(node, f) {
    if (f.kind === 'info') return h('p.info', {}, f.text);
    if (f.kind === 'tags') return h('div.tags', { hidden: true });
    if (f.kind === 'action') return h('button.action', { title: f.hint || '', onclick: () => this.actions[f.action](node) }, f.label);
    if (f.kind === 'model') return this.modelField(node, f);
    let v = getPath(node.data, f.key);
    if ((v == null || v === '') && f.fallback != null && f.fallback !== '') { v = f.fallback; if (f.kind !== 'textarea' && f.kind !== 'text') setPath(node.data, f.key, f.kind === 'number' ? +v : v); }
    let dirty = false;
    const commit = (value, structural) => {
      if (!dirty) { this.graph.checkpoint(); dirty = true; }
      setPath(node.data, f.key, value);
      if (NODE_TYPES[node.type].onChange?.(node, f.key, value) && !structural) this.paintFields(node);
      if (structural) {
        const cut = this.graph.pruneEdges(node.id);
        this.paintFields(node); this.afterChange();
        if (cut) toast(`이 설정에서는 쓰지 않는 연결 ${cut}개를 끊었습니다`);
      }
      this.graph.emit('node:data', node);
    };
    let input;
    if (f.kind === 'textarea') input = h('textarea', { rows: f.rows || 3, placeholder: f.placeholder || '', value: v ?? '', spellcheck: false, oninput: (e) => commit(e.target.value) });
    else if (f.kind === 'text') input = h('input', { type: 'text', placeholder: f.placeholder || '', value: v ?? '', oninput: (e) => commit(e.target.value) });
    else if (f.kind === 'number') input = h('input', { type: 'number', min: f.min, max: f.max, step: f.step ?? 1, value: v ?? '', oninput: (e) => commit(e.target.value === '' ? '' : +e.target.value) });
    else if (f.kind === 'check') input = h('input', { type: 'checkbox', checked: !!v, onchange: (e) => commit(e.target.checked) });
    else if (f.kind === 'select') {
      const opts = f.options.map((o) => (typeof o === 'object' ? o : { value: String(o), label: o === '' ? '(지정 안 함)' : String(o) }));
      input = h('select', { onchange: (e) => commit(e.target.value, f.structural) }, opts.map((o) => h('option', { value: o.value, selected: String(v ?? '') === o.value }, o.label)));
      if (!opts.some((o) => o.value === String(v ?? '')) && opts.length) { setPath(node.data, f.key, opts[0].value); input.value = opts[0].value; }
    } else if (f.kind === 'file') {
      const kind = node.data.kind;
      input = h('input', { type: 'file', accept: `${kind}/*`, onchange: async (e) => {
        const file = e.target.files[0]; if (!file) return;
        this.graph.checkpoint();
        node.data.file = await saveBlob(file); node.data.name = file.name; node.data.url = '';
        this.paintFields(node); this.recompute(node).then(() => this.refreshDependents(node));
        this.graph.emit('node:data', node);
      } });
      if (node.data.file) return h('label.field', {}, h('span', {}, f.label), h('span.file', {}, h('em', {}, node.data.name || '파일'), h('button', { onclick: () => { this.graph.checkpoint(); node.data.file = ''; node.data.name = ''; this.paintFields(node); this.recompute(node).then(() => this.refreshDependents(node)); this.graph.emit('node:data', node); } }, '빼기')));
    }
    input.addEventListener('blur', () => { dirty = false; if (NODE_TYPES[node.type].instant && node.type !== 'frame') this.recompute(node).then(() => this.refreshDependents(node)); });
    const wrap = h(`label.field${f.kind === 'check' ? '.inline' : ''}${f.wide ? '.wide' : ''}`, { title: f.hint || '' }, f.label ? h('span', {}, f.label) : null, input);
    return wrap;
  }

  // Model chooser: a button that opens a list with a tab per company and the recently used models first.
  modelField(node, f) {
    const kind = f.modelKind, all = listModels(kind);
    const cur = getModel(node.data.model) || all[0];
    const item = (m) => ({ id: m.id, title: m.name, hint: [m.provider_name, m.description].filter(Boolean).join(' · ') });
    const open = (e) => {
      const recent = recentModels(kind);
      const companies = [...new Set(all.map((m) => m.provider_name || '기타'))].sort((a, b) => all.filter((m) => (m.provider_name || '기타') === b).length - all.filter((m) => (m.provider_name || '기타') === a).length);
      const rest = all.filter((m) => !recent.includes(m));
      const tabs = [
        ...(recent.length ? [{ id: '~recent', label: '최근', items: recent.map(item) }] : []),
        { id: '~all', label: '전체', all: true, items: [...recent, ...rest].map(item) },
        ...companies.map((c) => ({ id: c, label: c, items: all.filter((m) => (m.provider_name || '기타') === c).map(item) })),
      ];
      const r = e.currentTarget.getBoundingClientRect();
      tabPicker(r.left, r.bottom + 4, tabs, cur?.id, (id) => {
        if (id === node.data.model) return;
        this.graph.checkpoint();
        node.data.model = id; touchModel(id);
        const cut = this.graph.pruneEdges(node.id);
        this.paintFields(node); this.afterChange();
        if (cut) toast(`이 모델에서는 쓰지 않는 연결 ${cut}개를 끊었습니다`);
        this.graph.emit('node:data', node);
      });
    };
    return h('div.field.wide', {}, h('span', {}, f.label), h('button.model-pick', { onclick: open, 'aria-haspopup': 'listbox' }, h('b', {}, cur?.name || '모델 고르기'), h('small', {}, cur?.provider_name || ''), h('i', {}, '▾')));
  }

  paintStatus(node) {
    const el = this.els.get(node.id); if (!el) return;
    const def = NODE_TYPES[node.type];
    const stale = node.status !== 'running' && node.status !== 'queued' && this.engine.isStale(node);
    el.dataset.status = node.status || 'idle';
    el.classList.toggle('stale', stale);
    el.classList.toggle('locked', !!node.data.locked);
    const chip = el.querySelector('.chip');
    let text = def.instant ? '' : STATUS[node.status] || '';
    if (node.status === 'running' && node.startedAt) text = `${node.message || '실행 중'} · ${Math.round((Date.now() - node.startedAt) / 1000)}초`;
    else if (node.data.locked) text = '잠금';
    else if (stale) text = '설정 바뀜';
    chip.textContent = text; chip.hidden = !text;
    const run = el.querySelector('.run');
    if (run) { const on = node.status === 'running' || node.status === 'queued'; run.textContent = on ? '■' : '▶'; run.title = on ? '중단' : '이 노드 실행 (Ctrl+Enter)'; run.setAttribute('aria-label', on ? '중단' : '실행'); }
    const foot = el.querySelector('.foot');
    const msg = node.status === 'error' ? node.message : node.status === 'running' ? '' : node.message;
    foot.textContent = msg || ''; foot.hidden = !msg; foot.classList.toggle('err', node.status === 'error');
    const cost = el.querySelector('.cost');
    cost.textContent = node.cost || ''; cost.hidden = !node.cost;
    this.drawMini();
  }

  paintPreview(node) {
    const el = this.els.get(node.id); if (!el) return;
    const def = NODE_TYPES[node.type], box = el.querySelector('.preview');
    const items = node.result?.items || [];
    box.replaceChildren();
    if (!def.preview || !items.length) { box.hidden = true; return; }
    box.hidden = false;
    const media = items.filter((i) => i.type !== 'text'), texts = items.filter((i) => i.type === 'text');
    if (def.preview === 'board') return box.append(this.board(node, items));
    if (media.length) {
      const pick = Math.min(media.length - 1, +node.data.pick || 0);
      box.append(h(`div.thumbs.n${Math.min(4, media.length)}`, {}, media.map((it, i) => this.thumb(it, {
        picked: media.length > 1 && i === pick,
        onPick: media.length > 1 && !def.outAll && node.type !== 'tool' ? () => { node.data.pick = i; this.paintPreview(node); this.refreshDependents(node); this.graph.emit('node:data', node); } : null,
      }))));
      if (media.length > 1 && !def.outAll && node.type !== 'tool') box.append(h('p.hint', {}, `다음 노드로는 테두리가 켜진 ${pick + 1}번이 넘어갑니다. 다른 것을 누르면 바뀝니다.`));
    }
    if (texts.length && (def.preview === 'text' || def.preview === 'mixed')) {
      const text = texts.map((t) => t.text).join('\n\n');
      box.append(h('pre.text', {}, text.length > 1200 ? `${text.slice(0, 1200)}…` : text), h('button.small', { onclick: async () => toast((await copyText(text)) ? '복사했습니다' : '복사하지 못했습니다') }, '복사'));
    }
    // Versions: every generation on this node, oldest first. Pressing one makes it the result the next nodes use.
    const versions = def.spends ? this.engine.versions(node).filter((r) => r.v) : [];
    if (versions.length) {
      const cur = node.result;
      const about = (r) => [`v${r.v}`, r.request?.finalOf ? `v${r.request.finalOf} 드래프트를 ${r.request.resolution}로 완성` : r.request?.draft ? '드래프트' : '', r.request?.model, r.at ? new Date(r.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ');
      box.prepend(h('div.versions', { role: 'group', 'aria-label': '버전' },
        versions.map((r) => h(`button${r === cur ? '.on' : ''}`, { title: about(r), 'aria-pressed': String(r === cur), onclick: () => { if (r !== cur) this.engine.showVersion(node, r.v); } }, `v${r.v}`)),
        h('span', {}, about(cur).replace(/^v\d+ · /, ''))));
    }
    const picked = media[Math.min(media.length - 1, +node.data.pick || 0)];
    for (const res of finalResolutions(node, picked)) {
      box.append(h('button.small.final', { title: '드래프트를 이 해상도로 다시 생성합니다 (업스케일이 아니라 Higgsfield의 Generate in 1080p/4K). 크레딧이 듭니다.', onclick: () => this.actions.finalize(node, picked, res) }, `${res === '4k' ? '4K' : res}로 완성`));
    }
  }
  thumb(item, { picked, onPick, index } = {}) {
    const url = displayUrl(item.url);
    const open = () => (url ? lightbox(item, url) : toast('이 브라우저에 파일이 없습니다', 'error'));
    let media;
    if (!url) media = h('div.missing', {}, '파일 없음');
    else if (item.type === 'video' && !item.still) media = h('video', { src: url, preload: 'metadata', muted: true, loop: true, playsInline: true, onpointerenter: (e) => e.target.play().catch(() => {}), onpointerleave: (e) => e.target.pause() });
    else if (item.type === 'audio') media = h('audio', { src: url, controls: true, preload: 'none' });
    else media = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: false });
    return h(`div.thumb${picked ? '.picked' : ''}`, { onclick: (e) => { if (e.target.closest('a,audio')) return; if (onPick && !picked) onPick(); else open(); }, ondblclick: open },
      media,
      index != null ? h('b.no', {}, index) : null,
      item.demo ? h('span.tag', {}, item.still ? '데모 · 영상 자리' : '데모') : item.type === 'video' ? h('span.tag', {}, '영상') : null,
      url && !item.local ? h('a.dl', { href: url, target: '_blank', rel: 'noopener', title: '새 탭에서 열기' }, '열기') : null);
  }
  board(node, items) {
    const sources = this.graph.edgesInto(node.id, 'shots').map((e) => this.graph.node(e.from.node)).filter(Boolean).sort((a, b) => a.y - b.y || a.x - b.x);
    const listText = () => [`# ${node.data.title || '샷리스트'}`, '', ...items.map((it, i) => {
      const src = sources.find((s) => this.engine.outItems(s).includes(it));
      return [`## 샷 ${i + 1}${src?.data.label ? ` — ${src.data.label}` : ''}`, `- 종류: ${it.type === 'video' ? '영상' : '이미지'}${src?.result?.request?.model ? ` · ${src.result.request.model}` : ''}`, it.local ? null : `- 파일: ${it.url}`, src?.result?.request?.prompt ? `- 프롬프트:\n\n${src.result.request.prompt}` : null, ''].filter((x) => x != null).join('\n');
    })].join('\n');
    return h('div', {},
      h('div.strip', {}, items.map((it, i) => this.thumb(it, { index: i + 1 }))),
      h('p.hint', {}, '순서는 연결된 노드의 위→아래 위치를 따릅니다.'),
      h('button.small', { onclick: async () => toast((await copyText(listText())) ? '샷리스트를 복사했습니다' : '복사하지 못했습니다') }, '샷리스트 복사 (.md)'));
  }

  // ---- edges
  queueEdges() { cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => { this.drawEdges(); this.drawMini(); }); }
  portPos(nodeId, side, key) {
    const dot = this.els.get(nodeId)?.querySelector(`.port.${side}[data-port="${CSS.escape(key)}"] .dot`);
    if (!dot) return null;
    const r = dot.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  static curve(a, b) { const dx = Math.max(50, Math.abs(b.x - a.x) / 2); return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`; }
  drawEdges() {
    const frag = document.createDocumentFragment();
    for (const e of this.graph.doc.edges) {
      const a = this.portPos(e.from.node, 'out', e.from.port), b = this.portPos(e.to.node, 'in', e.to.port);
      if (!a || !b) continue;
      const src = this.graph.node(e.from.node);
      const type = this.graph.port(src, 'out', e.from.port)?.type || 'any';
      const g = document.createElementNS(SVG, 'g');
      g.dataset.edge = e.id; g.dataset.type = type;
      if (e.id === this.selEdge) g.classList.add('sel');
      if (src.status === 'running') g.classList.add('flow');
      const d = Canvas.curve(a, b);
      for (const cls of ['hit', 'line']) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); p.setAttribute('class', cls); g.append(p); }
      frag.append(g);
    }
    if (this.temp) frag.append(this.temp);
    this.edgeLayer.replaceChildren(frag);
  }
  drawMini() {
    const c = this.mini, ctx = c.getContext('2d'), nodes = this.graph.doc.nodes;
    c.hidden = nodes.length < 2;
    if (c.hidden) return;
    const r = this.stage.getBoundingClientRect(), v = this.view;
    const vw = { x0: -v.x / v.k, y0: -v.y / v.k, x1: (r.width - v.x) / v.k, y1: (r.height - v.y) / v.k };
    const b = this.bounds();
    const x0 = Math.min(b.x0, vw.x0), y0 = Math.min(b.y0, vw.y0), x1 = Math.max(b.x1, vw.x1), y1 = Math.max(b.y1, vw.y1);
    const s = Math.min(c.width / (x1 - x0), c.height / (y1 - y0));
    const ox = (c.width - (x1 - x0) * s) / 2, oy = (c.height - (y1 - y0) * s) / 2;
    this.miniMap = { s, ox, oy, x0, y0 };
    ctx.clearRect(0, 0, c.width, c.height);
    for (const n of nodes) {
      const hgt = this.els.get(n.id)?.offsetHeight || 160;
      ctx.fillStyle = n.status === 'error' ? '#ff6b6b' : n.status === 'running' ? '#ffd84a' : this.sel.has(n.id) ? '#e6e8eb' : '#59626f';
      ctx.fillRect(ox + (n.x - x0) * s, oy + (n.y - y0) * s, Math.max(2, n.w * s), Math.max(2, hgt * s));
    }
    ctx.strokeStyle = '#ff5a4e'; ctx.lineWidth = 1;
    ctx.strokeRect(ox + (vw.x0 - x0) * s + 0.5, oy + (vw.y0 - y0) * s + 0.5, (vw.x1 - vw.x0) * s - 1, (vw.y1 - vw.y0) * s - 1);
  }

  // ---- selection
  select(ids, add = false) {
    if (!add) this.sel.clear();
    for (const id of ids) this.sel.add(id);
    this.selEdge = null;
    for (const [id, el] of this.els) el.classList.toggle('sel', this.sel.has(id));
    this.queueEdges(); this.actions.onSelection?.();
  }
  selectedNodes() { return [...this.sel].map((id) => this.graph.node(id)).filter(Boolean); }
  deleteSelection() {
    if (this.selEdge) { this.graph.checkpoint(); this.graph.removeEdge(this.selEdge); this.selEdge = null; return; }
    if (!this.sel.size) return;
    this.graph.checkpoint();
    for (const id of this.sel) this.engine.stop(id);
    this.graph.removeNodes([...this.sel]); this.sel.clear(); this.actions.onSelection?.();
  }
  copy() { const nodes = this.selectedNodes(); if (!nodes.length) return; const ids = new Set(nodes.map((n) => n.id)); this.clip = structuredClone({ nodes, edges: this.graph.doc.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)) }); toast(`노드 ${nodes.length}개를 복사했습니다`); }
  paste() {
    if (!this.clip) return;
    this.graph.checkpoint();
    const b = { x: Math.min(...this.clip.nodes.map((n) => n.x)), y: Math.min(...this.clip.nodes.map((n) => n.y)) };
    const at = this.lastPointer ? this.toWorld(this.lastPointer.x, this.lastPointer.y) : this.center();
    const map = new Map();
    for (const n of this.clip.nodes) {
      const made = this.graph.addNode(n.type, n.x - b.x + at.x, n.y - b.y + at.y, structuredClone(n.data));
      made.w = n.w; made.result = structuredClone(n.result); made.sig = n.sig; made.status = made.result ? 'done' : 'idle';
      map.set(n.id, made.id); this.renderNode(made);
    }
    for (const e of this.clip.edges) this.graph.connect({ node: map.get(e.from.node), port: e.from.port }, { node: map.get(e.to.node), port: e.to.port });
    this.select([...map.values()]);
  }
  duplicate() { if (!this.sel.size) return; this.graph.checkpoint(); this.select(this.graph.duplicate([...this.sel])); }

  // ---- menus
  nodeMenu(node, x, y) {
    const def = NODE_TYPES[node.type], running = this.engine.isRunning(node.id);
    if (!this.sel.has(node.id)) this.select([node.id]);
    menu(x, y, [
      !def.instant && { label: running ? '중단' : '이 노드 실행', key: 'Ctrl+Enter', run: () => this.actions.runNode(node.id) },
      this.graph.edgesFrom(node.id).length && { label: '여기부터 아래로 실행', run: () => this.actions.runDownstream(node.id) },
      (node.type === 'image' || node.type === 'video') && { label: '보낼 요청 미리 보기', run: () => this.actions.preview(node) },
      def.spends && { label: '예상 크레딧 확인', run: () => this.actions.cost(node) },
      def.spends && node.result && { label: node.data.locked ? '결과 잠금 풀기' : '결과 잠금 (다시 생성하지 않음)', run: () => { this.graph.checkpoint(); node.data.locked = !node.data.locked; this.graph.emit('node:data', node); } },
      node.result && !def.instant && { label: '결과 지우기', run: () => { this.graph.checkpoint(); node.result = null; node.history = []; node.status = 'idle'; node.message = ''; this.graph.emit('node:result', node); } },
      '-',
      { label: '복제', key: 'Ctrl+D', run: () => this.duplicate() },
      { label: '삭제', key: 'Del', danger: true, run: () => this.deleteSelection() },
    ]);
  }
  // Node list for the add menu; with `from`, only node types that have a port the dragged connection fits.
  addMenu(cx, cy, from) {
    const fits = (type) => {
      if (!from) return true;
      const probe = { type, data: structuredClone(NODE_TYPES[type].defaults || {}) };
      const ports = this.graph.ports(probe, from.side === 'out' ? 'in' : 'out');
      return ports.some((p) => (from.side === 'out' ? (p.accepts || [p.type]).some((t) => t === 'any' || t === from.type || from.type === 'any') : p.type === from.type || from.type === 'any' || p.type === 'any'));
    };
    const groups = CATEGORIES.map((c) => ({ label: c.label, items: Object.entries(NODE_TYPES).filter(([t, d]) => d.category === c.id && fits(t)).map(([id, d]) => ({ id, title: d.title, hint: d.hint })) }));
    const at = this.toWorld(cx, cy);
    palette(cx, cy, groups, (type) => {
      this.graph.checkpoint();
      const node = this.graph.addNode(type, at.x - (from?.side === 'in' ? NODE_TYPES[type].width || 280 : 0), at.y - 20);
      if (from) {
        const ports = this.graph.ports(node, from.side === 'out' ? 'in' : 'out');
        for (const p of ports) {
          const res = from.side === 'out' ? this.graph.connect({ node: from.node, port: from.port }, { node: node.id, port: p.key }) : this.graph.connect({ node: node.id, port: p.key }, { node: from.node, port: from.port });
          if (!res.error) break;
        }
      }
      this.select([node.id]);
      this.els.get(node.id)?.querySelector('textarea, input[type=text]')?.focus();
    }, from ? '연결할 노드 찾기' : '노드 찾기');
  }

  // ---- pointer + keyboard
  bind() {
    const st = this.stage;
    st.addEventListener('wheel', (e) => {
      const ta = e.target.closest('textarea, pre, .palette-list');
      if (ta && ta.scrollHeight > ta.clientHeight && !e.ctrlKey) return;
      e.preventDefault();
      const trackpad = !e.ctrlKey && (e.deltaX !== 0 || !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 40);
      if (trackpad) { this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.applyView(); }
      else this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    st.addEventListener('pointermove', (e) => { this.lastPointer = { x: e.clientX, y: e.clientY }; });
    st.addEventListener('pointerdown', (e) => this.onDown(e));
    st.addEventListener('dblclick', (e) => {
      const g = e.target.closest?.('[data-edge]');
      if (!g) return;
      const edge = this.graph.doc.edges.find((x) => x.id === g.dataset.edge); if (!edge) return;
      const p = this.toWorld(e.clientX, e.clientY), a = this.portPos(edge.from.node, 'out', edge.from.port), b = this.portPos(edge.to.node, 'in', edge.to.port);
      const near = 18 / this.view.k;
      if ((a && Math.hypot(p.x - a.x, p.y - a.y) < near) || (b && Math.hypot(p.x - b.x, p.y - b.y) < near)) return;
      this.graph.checkpoint(); this.selEdge = null; this.graph.removeEdge(edge.id);
      toast('연결을 끊었습니다 (Ctrl+Z로 되돌리기)');
    });
    st.addEventListener('dblclick', (e) => { if (e.target === st || e.target === this.world || e.target === this.nodeLayer || e.target === this.edgeLayer) this.addMenu(e.clientX, e.clientY); });
    st.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input,textarea,[contenteditable="true"]')) return;
      e.preventDefault();
      const nodeEl = e.target.closest('.node');
      if (nodeEl) this.nodeMenu(this.graph.node(nodeEl.dataset.id), e.clientX, e.clientY);
      else this.addMenu(e.clientX, e.clientY);
    });
    this.mini.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const go = (ev) => {
        const m = this.miniMap, r = this.mini.getBoundingClientRect(), sr = st.getBoundingClientRect();
        const wx = m.x0 + (ev.clientX - r.left - m.ox) / m.s, wy = m.y0 + (ev.clientY - r.top - m.oy) / m.s;
        this.view.x = sr.width / 2 - wx * this.view.k; this.view.y = sr.height / 2 - wy * this.view.k; this.applyView();
      };
      go(e); this.drag(e, go);
    });
  }
  drag(e, move, end) {
    // Window listeners instead of pointer capture: capture would retarget the following click/dblclick to the stage.
    const target = window;
    const mv = (ev) => { if (ev.pointerId === e.pointerId) move(ev); };
    const up = (ev) => { if (ev.pointerId !== e.pointerId) return; target.removeEventListener('pointermove', mv); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); end?.(ev); };
    target.addEventListener('pointermove', mv); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  }
  onDown(e) {
    if (e.button === 2) return;
    const port = e.target.closest('.port');
    if (port && e.button === 0) return this.startConnect(e, port);
    const resize = e.target.closest('.resize');
    const nodeEl = e.target.closest('.node');
    if (resize && nodeEl) return this.startResize(e, this.graph.node(nodeEl.dataset.id), nodeEl);
    const edge = e.target.closest('[data-edge]');
    if (edge && e.button === 0) { this.select([]); this.selEdge = edge.dataset.edge; this.queueEdges(); this.actions.onSelection?.(); return; }
    if (nodeEl && e.button === 0) {
      const id = nodeEl.dataset.id;
      const multi = e.shiftKey || e.ctrlKey || e.metaKey;
      if (e.target.closest(INTERACTIVE)) { if (!this.sel.has(id)) this.select([id], multi); return; }
      if (multi && this.sel.has(id)) { this.sel.delete(id); this.select([...this.sel]); return; }
      if (!this.sel.has(id)) this.select([id], multi);
      document.activeElement?.blur?.();
      return this.startMove(e);
    }
    document.activeElement?.blur?.();
    if (e.button === 0 && e.shiftKey) return this.startMarquee(e);
    this.startPan(e);
  }
  startPan(e) {
    const s = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y }; let moved = false;
    this.stage.classList.add('panning');
    this.drag(e, (ev) => { moved ||= Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > 3; this.view.x = s.vx + ev.clientX - s.x; this.view.y = s.vy + ev.clientY - s.y; this.applyView(); },
      () => { this.stage.classList.remove('panning'); if (!moved && e.button === 0) this.select([]); });
  }
  startMarquee(e) {
    const r = this.stage.getBoundingClientRect(), s = { x: e.clientX, y: e.clientY }, base = new Set(this.sel);
    this.marquee.hidden = false;
    this.drag(e, (ev) => {
      const x0 = Math.min(s.x, ev.clientX), y0 = Math.min(s.y, ev.clientY), x1 = Math.max(s.x, ev.clientX), y1 = Math.max(s.y, ev.clientY);
      Object.assign(this.marquee.style, { left: `${x0 - r.left}px`, top: `${y0 - r.top}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      const hit = [...this.els].filter(([, el]) => { const b = el.getBoundingClientRect(); return b.left < x1 && b.right > x0 && b.top < y1 && b.bottom > y0; }).map(([id]) => id);
      this.select([...base, ...hit]);
    }, () => { this.marquee.hidden = true; this.marquee.style.width = this.marquee.style.height = '0px'; });
  }
  startMove(e) {
    const nodes = this.selectedNodes(), s = { x: e.clientX, y: e.clientY }, orig = nodes.map((n) => ({ n, x: n.x, y: n.y }));
    let moved = false;
    this.drag(e, (ev) => {
      const dx = (ev.clientX - s.x) / this.view.k, dy = (ev.clientY - s.y) / this.view.k;
      if (!moved && Math.hypot(dx, dy) * this.view.k < 3) return;
      if (!moved) { moved = true; this.graph.checkpoint(); }
      for (const o of orig) { o.n.x = Math.round(o.x + dx); o.n.y = Math.round(o.y + dy); const el = this.els.get(o.n.id); el.style.left = `${o.n.x}px`; el.style.top = `${o.n.y}px`; }
      this.drawEdges();
    }, () => {
      if (!moved) return;
      // Vertical order decides the order of multi-inputs (prompt parts, shots), so things after a moved node are refreshed.
      for (const o of orig) { this.paintStatus(o.n); this.refreshDependents(o.n); }
      this.drawMini(); this.graph.scheduleSave();
    });
  }
  startResize(e, node, el) {
    e.stopPropagation();
    const s = { x: e.clientX, w: node.w }; this.graph.checkpoint();
    this.drag(e, (ev) => { node.w = Math.round(Math.max(200, Math.min(900, s.w + (ev.clientX - s.x) / this.view.k))); el.style.width = `${node.w}px`; this.drawEdges(); }, () => this.graph.scheduleSave());
  }
  startConnect(e, portEl) {
    e.stopPropagation(); e.preventDefault();
    let from = { node: portEl.dataset.node, port: portEl.dataset.port, side: portEl.dataset.side, type: portEl.dataset.type };
    // Pulling on a connected single input picks the existing connection up from its source end.
    if (from.side === 'in') {
      const existing = this.graph.edgesInto(from.node, from.port);
      const p = this.graph.port(this.graph.node(from.node), 'in', from.port);
      if (existing.length === 1 && !p.multi) {
        const ed = existing[0];
        this.graph.checkpoint(); this.graph.removeEdge(ed.id);
        const srcNode = this.graph.node(ed.from.node);
        from = { node: ed.from.node, port: ed.from.port, side: 'out', type: this.graph.port(srcNode, 'out', ed.from.port).type };
      }
    }
    const start = this.portPos(from.node, from.side, from.port);
    const path = document.createElementNS(SVG, 'path'); path.setAttribute('class', 'temp'); path.dataset.type = from.type;
    this.temp = path;
    const pair = (el) => (from.side === 'out' ? [{ node: from.node, port: from.port }, { node: el.dataset.node, port: el.dataset.port }] : [{ node: el.dataset.node, port: el.dataset.port }, { node: from.node, port: from.port }]);
    this.stage.classList.add('connecting');
    for (const el of this.nodeLayer.querySelectorAll('.port')) el.classList.toggle('ok', el.dataset.side !== from.side && !this.graph.connectError(...pair(el)));
    // Snap: the port under the pointer, else the nearest connectable port within reach, else the first
    // connectable port of the node the pointer is over.
    const SNAP = 44;
    let snapped = null;
    const findPort = (ev) => {
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const direct = under?.closest?.('.port');
      if (direct && direct !== portEl) return direct;
      let best = null, bestD = SNAP;
      for (const el of this.nodeLayer.querySelectorAll('.port.ok')) {
        const r = el.querySelector('.dot').getBoundingClientRect();
        const d = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2));
        if (d < bestD) { best = el; bestD = d; }
      }
      return best || under?.closest?.('.node')?.querySelector('.port.ok') || null;
    };
    this.drag(e, (ev) => {
      const hit = findPort(ev);
      const next = hit?.classList.contains('ok') ? hit : null;
      if (next !== snapped) { snapped?.classList.remove('snap'); next?.classList.add('snap'); snapped = next; }
      const p = snapped ? this.portPos(snapped.dataset.node, snapped.dataset.side, snapped.dataset.port) : this.toWorld(ev.clientX, ev.clientY);
      path.setAttribute('d', from.side === 'out' ? Canvas.curve(start, p) : Canvas.curve(p, start));
      if (!path.isConnected) this.edgeLayer.append(path);
    }, (ev) => {
      this.temp = null; path.remove();
      this.stage.classList.remove('connecting');
      const target = snapped || findPort(ev);
      snapped?.classList.remove('snap');
      for (const el of this.nodeLayer.querySelectorAll('.port.ok')) el.classList.remove('ok');
      if (target && target !== portEl) {
        if (target.dataset.side === from.side) return toast(from.side === 'out' ? '출력은 입력에 연결합니다' : '입력은 출력에 연결합니다', 'error');
        this.graph.checkpoint();
        const res = this.graph.connect(...pair(target));
        if (res.error) { this.graph.undoStack.pop(); toast(res.error, 'error'); }
        else { const to = this.graph.node(res.edge.to.node); this.paintStatus(to); this.refreshDependents(this.graph.node(res.edge.from.node)); }
        return;
      }
      const overNode = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.node');
      if (!overNode && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > 24) this.addMenu(ev.clientX, ev.clientY, from);
      else this.afterChange();
    });
  }
}
