// Runs nodes in dependency order. Generating nodes (the ones that spend credits) are never re-run implicitly:
// running one node reuses the existing results of the generating nodes above it and only fills in missing ones.
import { NODE_TYPES } from './nodes.js';
import { currentProvider, settings } from './providers.js';

const HISTORY_MAX = 12;

export class Engine {
  constructor(graph, hooks) {
    this.graph = graph;
    this.hooks = hooks; // { ask(question, options), relay(text, kind) }
    this.active = new Map(); // node id -> AbortController
  }

  // Items a node hands to the nodes after it.
  outItems(node) {
    const items = node.result?.items || [];
    const def = NODE_TYPES[node.type];
    if (def.outAll || node.type === 'tool') return items;
    const pick = Math.min(items.length - 1, Math.max(0, +node.data.pick || 0));
    return items.length ? [items[pick]] : [];
  }
  // Inputs by port key. Several edges into one port are ordered top to bottom by the position of their source node.
  inputsOf(node) {
    const g = this.graph, out = {};
    for (const port of g.ports(node, 'in')) {
      const accepts = port.accepts || [port.type];
      const edges = g.edgesInto(node.id, port.key).map((e) => ({ e, src: g.node(e.from.node) })).filter((x) => x.src).sort((a, b) => a.src.y - b.src.y || a.src.x - b.src.x);
      out[port.key] = edges.flatMap(({ src }) => this.outItems(src).filter((i) => accepts.includes('any') || accepts.includes(i.type)));
    }
    return out;
  }
  // What the node would run with right now. A result made with the same signature is still current.
  signature(node) {
    const { pick, label, locked, ...data } = node.data; // naming, locking or picking a variant does not change what would be generated
    const ins = Object.entries(this.inputsOf(node)).map(([k, items]) => [k, items.map((i) => i.jobId || i.url || i.text)]);
    return JSON.stringify([node.type, data, ins]);
  }
  isStale(node) { return !!node.result && !!node.sig && node.sig !== this.signature(node); }
  isRunning(id) { return id ? this.active.has(id) : this.active.size > 0; }

  // Nodes to execute for the requested targets: the targets, every instant node above them, and generating
  // nodes above them that have no result yet.
  plan(targetIds) {
    const g = this.graph, need = new Set(targetIds);
    const visit = (id) => {
      for (const e of g.edgesInto(id)) {
        const src = g.node(e.from.node);
        if (!src || need.has(src.id)) continue;
        if (NODE_TYPES[src.type].instant || !src.result) { need.add(src.id); visit(src.id); }
      }
    };
    for (const id of [...need]) visit(id);
    return g.order(need);
  }
  // Generating nodes in a plan that will really be submitted (for the "this will spend credits" check).
  spending(targetIds, force) {
    const targets = new Set(targetIds);
    return this.plan(targetIds).map((id) => this.graph.node(id)).filter((n) => {
      if (!NODE_TYPES[n.type].spends) return false;
      if (n.data.locked && n.result) return false;
      if (!targets.has(n.id)) return !n.result;
      return force || !n.result || this.isStale(n) || n.status === 'error';
    });
  }

  runNode(id) { return this.run([id], true); }
  runDownstream(id) { return this.run([id, ...this.graph.downstream(id)], false); }
  runAll() { return this.run(this.graph.doc.nodes.filter((n) => !NODE_TYPES[n.type].note).map((n) => n.id), false); }

  stop(id) {
    if (id) this.active.get(id)?.abort();
    else { this.stopped = true; for (const c of this.active.values()) c.abort(); }
  }

  // force: re-run the targets even when their result is current (asking for another take).
  async run(targetIds, force) {
    const g = this.graph;
    const order = this.plan(targetIds).filter((id) => !this.active.has(id));
    const targets = new Set(targetIds);
    const inPlan = new Set(order);
    const state = new Map(order.map((id) => [id, 'wait']));
    this.stopped = false;
    for (const id of order) { const n = g.node(id); if (!NODE_TYPES[n.type].instant) { n.status = 'queued'; n.message = ''; g.emit('node:status', n); } }

    const deps = (id) => g.edgesInto(id).map((e) => e.from.node).filter((s) => inPlan.has(s));
    let busy = 0;
    await new Promise((resolve) => {
      const pump = () => {
        for (const id of order) {
          if (state.get(id) !== 'wait') continue;
          const d = deps(id);
          if (d.some((s) => state.get(s) === 'wait' || state.get(s) === 'run')) continue;
          const n = g.node(id);
          if (!n) { state.set(id, 'skip'); continue; }
          const def = NODE_TYPES[n.type];
          const failed = d.find((s) => state.get(s) === 'fail' || state.get(s) === 'skip');
          if (failed || this.stopped) {
            state.set(id, 'skip');
            n.status = n.result ? 'done' : 'idle';
            n.message = this.stopped ? '' : '앞 노드가 실패해 건너뜀';
            g.emit('node:status', n);
            continue;
          }
          const current = n.result && n.sig === this.signature(n);
          // Keep what is already there: locked results, generating nodes that were not asked for (or are still current),
          // and instant nodes whose inputs did not change (a re-cut frame would look new to the nodes after it).
          const keep = (n.data.locked && n.result) || (def.spends && n.result && (!targets.has(id) || (!force && current))) || (def.instant && current);
          if (keep) { state.set(id, 'ok'); n.status = 'done'; n.message = ''; g.emit('node:status', n); continue; }
          if (def.spends && busy >= Math.max(1, +settings.parallel || 3)) continue;
          state.set(id, 'run');
          if (def.spends) busy++;
          this.exec(n).then((ok) => { state.set(id, ok ? 'ok' : 'fail'); if (def.spends) busy--; pump(); });
        }
        if (![...state.values()].some((s) => s === 'wait' || s === 'run')) resolve();
      };
      pump();
    });
    g.emit('run:end');
    return [...state.entries()].filter(([, s]) => s === 'fail').map(([id]) => id);
  }

  // Every result of a generating node gets a version number (v1, v2, …) that never repeats on that node.
  nextVersion(node) {
    node.vmax = Math.max(node.vmax || 0, node.result?.v || 0, ...(node.history || []).map((r) => r.v || 0)) + 1;
    return node.vmax;
  }
  versions(node) { return [node.result, ...(node.history || [])].filter(Boolean).sort((a, b) => (a.v || 0) - (b.v || 0)); }
  // Make an earlier version the node's current result; the one it replaces goes back into the history.
  showVersion(node, v) {
    const chosen = (node.history || []).find((r) => r.v === v);
    if (!chosen) return;
    if (node.result) node.result.pick = +node.data.pick || 0;
    node.history = [node.result, ...node.history.filter((r) => r !== chosen)].filter(Boolean).sort((a, b) => (b.v || 0) - (a.v || 0));
    node.result = chosen; node.sig = chosen.sig || null; node.data.pick = chosen.pick || 0;
    this.graph.emit('node:result', node);
  }
  // Render the picked draft again at full resolution, as a new version on the same node.
  finalize(node, item, resolution, buildReq) {
    const from = node.result.v;
    return this.exec(node, async (ctx) => {
      const req = buildReq(node, item, resolution);
      const items = await ctx.provider.generate(req, ctx);
      return { items, request: { ...node.result.request, draft: false, resolution, finalOf: from } };
    });
  }

  async exec(node, runner) {
    const g = this.graph, def = NODE_TYPES[node.type];
    const ctrl = new AbortController();
    this.active.set(node.id, ctrl);
    node.status = 'running'; node.message = ''; node.startedAt = Date.now();
    g.emit('node:status', node);
    const ctx = {
      node, inputs: this.inputsOf(node), provider: currentProvider(), signal: ctrl.signal,
      progress: (msg) => { node.message = msg; g.emit('node:status', node); },
      ask: this.hooks.ask, relay: this.hooks.relay,
    };
    const sig = this.signature(node);
    try {
      const res = await (runner || def.run)(ctx);
      if (ctrl.signal.aborted) throw new DOMException('중단됨', 'AbortError');
      const v = def.spends ? this.nextVersion(node) : undefined;
      if (node.result?.items?.length && def.spends) {
        node.result.pick = +node.data.pick || 0;
        node.history = [node.result, ...(node.history || [])].slice(0, HISTORY_MAX);
      }
      node.result = { items: res.items, at: Date.now(), request: res.request, sig, ...(v ? { v } : {}) };
      node.sig = sig; node.data.pick = 0;
      node.status = 'done'; node.message = '';
      return true;
    } catch (e) {
      const aborted = e?.name === 'AbortError';
      node.status = aborted ? (node.result ? 'done' : 'idle') : 'error';
      node.message = aborted ? '중단함' : (e?.message || String(e));
      return false;
    } finally {
      this.active.delete(node.id);
      delete node.startedAt;
      g.emit('node:result', node);
    }
  }
}
