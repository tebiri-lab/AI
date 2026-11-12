// Graph document: nodes, edges, view. Pure data + rules (port typing, cycle check, undo history, save/load).
import { NODE_TYPES } from './nodes.js';

export const DOC_VERSION = 1;
const HISTORY_MAX = 80;

let seq = 0;
export const uid = (p = 'n') => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function emptyDoc(name = '새 워크플로우') {
  return { version: DOC_VERSION, name, nodes: [], edges: [], view: { x: 0, y: 0, k: 1 } };
}

export class Graph {
  constructor() {
    this.doc = emptyDoc();
    this.listeners = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.saveTimer = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, detail) { for (const fn of this.listeners) fn(kind, detail); this.scheduleSave(); }

  // ---- lookup
  node(id) { return this.doc.nodes.find((n) => n.id === id); }
  def(node) { return NODE_TYPES[node.type]; }
  ports(node, side) {
    const d = this.def(node);
    const list = side === 'in' ? d.inputs : d.outputs;
    return typeof list === 'function' ? list(node) : list || [];
  }
  port(node, side, key) { return this.ports(node, side).find((p) => p.key === key); }
  edgesInto(nodeId, port) { return this.doc.edges.filter((e) => e.to.node === nodeId && (port == null || e.to.port === port)); }
  edgesFrom(nodeId, port) { return this.doc.edges.filter((e) => e.from.node === nodeId && (port == null || e.from.port === port)); }
  upstream(nodeId, acc = new Set()) {
    for (const e of this.edgesInto(nodeId)) if (!acc.has(e.from.node)) { acc.add(e.from.node); this.upstream(e.from.node, acc); }
    return acc;
  }
  downstream(nodeId, acc = new Set()) {
    for (const e of this.edgesFrom(nodeId)) if (!acc.has(e.to.node)) { acc.add(e.to.node); this.downstream(e.to.node, acc); }
    return acc;
  }

  // ---- history (structure only: results are kept on the node and travel with the snapshot)
  snapshot() { return JSON.stringify({ nodes: this.doc.nodes, edges: this.doc.edges }); }
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  restore(json) {
    const s = JSON.parse(json);
    this.doc.nodes = s.nodes; this.doc.edges = s.edges;
    for (const n of this.doc.nodes) if (n.status === 'running' || n.status === 'queued') n.status = 'idle';
    this.emit('reset');
  }
  undo() { if (!this.undoStack.length) return false; this.redoStack.push(this.snapshot()); this.restore(this.undoStack.pop()); return true; }
  redo() { if (!this.redoStack.length) return false; this.undoStack.push(this.snapshot()); this.restore(this.redoStack.pop()); return true; }

  // ---- mutation
  addNode(type, x, y, data = {}) {
    const d = NODE_TYPES[type];
    if (!d) throw new Error(`알 수 없는 노드 종류: ${type}`);
    const node = { id: uid('n'), type, x: Math.round(x), y: Math.round(y), w: d.width || 280, data: { ...structuredClone(d.defaults || {}), ...data }, status: 'idle', result: null, history: [] };
    this.doc.nodes.push(node);
    this.emit('node:add', node);
    return node;
  }
  removeNodes(ids) {
    const set = new Set(ids);
    this.doc.nodes = this.doc.nodes.filter((n) => !set.has(n.id));
    this.doc.edges = this.doc.edges.filter((e) => !set.has(e.from.node) && !set.has(e.to.node));
    this.emit('reset');
  }
  removeEdge(id) { this.doc.edges = this.doc.edges.filter((e) => e.id !== id); this.emit('edges'); }

  // Why a connection is refused, or '' when it is allowed.
  connectError(from, to) {
    const a = this.node(from.node), b = this.node(to.node);
    if (!a || !b) return '노드를 찾을 수 없습니다';
    if (a.id === b.id) return '같은 노드끼리는 연결할 수 없습니다';
    const po = this.port(a, 'out', from.port), pi = this.port(b, 'in', to.port);
    if (!po || !pi) return '포트를 찾을 수 없습니다';
    const accepts = pi.accepts || [pi.type];
    if (po.type !== 'any' && !accepts.includes('any') && !accepts.includes(po.type)) return `${TYPE_LABEL[po.type]} 출력은 ${accepts.map((t) => TYPE_LABEL[t]).join('·')} 입력에 연결할 수 없습니다`;
    if (this.doc.edges.some((e) => e.from.node === a.id && e.from.port === from.port && e.to.node === b.id && e.to.port === to.port)) return '이미 연결되어 있습니다';
    if (a.id === b.id || this.downstream(b.id).has(a.id)) return '순환 연결은 만들 수 없습니다';
    return '';
  }
  connect(from, to) {
    const err = this.connectError(from, to);
    if (err) return { error: err };
    const pi = this.port(this.node(to.node), 'in', to.port);
    if (!pi.multi) this.doc.edges = this.doc.edges.filter((e) => !(e.to.node === to.node && e.to.port === to.port));
    else if (pi.max && this.edgesInto(to.node, to.port).length >= pi.max) return { error: `이 입력은 ${pi.max}개까지 연결할 수 있습니다` };
    const edge = { id: uid('e'), from: { ...from }, to: { ...to } };
    this.doc.edges.push(edge);
    this.emit('edges');
    return { edge };
  }
  // Drop edges whose ports disappeared (a node's ports can depend on its settings, e.g. the chosen model).
  pruneEdges(nodeId) {
    const n = this.node(nodeId);
    const before = this.doc.edges.length;
    this.doc.edges = this.doc.edges.filter((e) => {
      if (e.to.node === nodeId && !this.port(n, 'in', e.to.port)) return false;
      if (e.from.node === nodeId && !this.port(n, 'out', e.from.port)) return false;
      return true;
    });
    return before - this.doc.edges.length;
  }

  duplicate(ids) {
    const map = new Map();
    const made = [];
    for (const id of ids) {
      const n = this.node(id); if (!n) continue;
      const c = structuredClone(n);
      c.id = uid('n'); c.x += 40; c.y += 40; c.status = c.result ? 'done' : 'idle';
      map.set(id, c.id); this.doc.nodes.push(c); made.push(c);
    }
    for (const e of [...this.doc.edges]) {
      if (map.has(e.from.node) && map.has(e.to.node)) this.doc.edges.push({ id: uid('e'), from: { node: map.get(e.from.node), port: e.from.port }, to: { node: map.get(e.to.node), port: e.to.port } });
    }
    this.emit('reset');
    return made.map((n) => n.id);
  }

  // ---- order
  // Topological order of the given node ids (Kahn). Edges to nodes outside the set are ignored.
  order(ids) {
    const set = new Set(ids);
    const indeg = new Map([...set].map((id) => [id, 0]));
    for (const e of this.doc.edges) if (set.has(e.from.node) && set.has(e.to.node)) indeg.set(e.to.node, indeg.get(e.to.node) + 1);
    const queue = this.doc.nodes.filter((n) => set.has(n.id) && indeg.get(n.id) === 0).map((n) => n.id);
    const out = [];
    while (queue.length) {
      const id = queue.shift(); out.push(id);
      for (const e of this.doc.edges) {
        if (e.from.node !== id || !set.has(e.to.node)) continue;
        indeg.set(e.to.node, indeg.get(e.to.node) - 1);
        if (indeg.get(e.to.node) === 0) queue.push(e.to.node);
      }
    }
    return out;
  }

  // ---- persistence
  serialize() { return JSON.stringify(this.doc); }
  load(doc, { keepHistory = false } = {}) {
    if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) throw new Error('워크플로우 파일 형식이 아닙니다');
    const nodes = doc.nodes.filter((n) => NODE_TYPES[n.type]).map((n) => {
      const d = NODE_TYPES[n.type];
      return { id: n.id || uid('n'), type: n.type, x: +n.x || 0, y: +n.y || 0, w: +n.w || d.width || 280, data: { ...structuredClone(d.defaults || {}), ...(n.data || {}) }, status: n.result ? 'done' : 'idle', result: n.result || null, sig: n.result ? n.sig || null : null, history: Array.isArray(n.history) ? n.history : [], vmax: +n.vmax || 0 };
    });
    // Results saved before versions existed are numbered oldest first.
    for (const n of nodes) {
      const all = [...n.history].reverse().concat(n.result ? [n.result] : []);
      if (NODE_TYPES[n.type].spends && all.some((r) => !r.v)) { all.forEach((r, i) => { r.v = i + 1; }); n.vmax = Math.max(n.vmax, all.length); }
    }
    const ids = new Set(nodes.map((n) => n.id));
    if (!keepHistory) { this.undoStack.length = 0; this.redoStack.length = 0; }
    this.doc = { version: DOC_VERSION, id: doc.id, updatedAt: doc.updatedAt, name: doc.name || '이름 없는 워크플로우', nodes, edges: [], view: doc.view || { x: 0, y: 0, k: 1 } };
    for (const e of doc.edges) {
      if (!e?.from || !e?.to || !ids.has(e.from.node) || !ids.has(e.to.node)) continue;
      const a = this.node(e.from.node), b = this.node(e.to.node);
      if (this.port(a, 'out', e.from.port) && this.port(b, 'in', e.to.port)) this.doc.edges.push({ id: e.id || uid('e'), from: { ...e.from }, to: { ...e.to } });
    }
    this.emit('reset');
  }
  // Saving is done by whoever set onSave (the workflow library); this only debounces it.
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.onSave?.(this.doc), 400);
  }
}

export const TYPE_LABEL = { text: '텍스트', image: '이미지', video: '영상', audio: '오디오', any: '모든 값' };
