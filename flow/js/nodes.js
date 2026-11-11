// Node type definitions: ports, settings fields and what running the node does.
// A result is { items: [{ type, url?, text?, jobId?, mediaId?, name? }], at }. Downstream nodes receive the picked item.
import { listModels, getModel, modelRoles, modelDurations, modelParams } from './models.js';
import { bridge } from './providers.js';
import { grabFrame } from './media.js';

const PROMPT_IN = { key: 'prompt', label: '프롬프트', type: 'text', multi: true };

// Reference roles a model declares -> input ports of the node.
const ROLE_PORTS = [
  { key: 'start', label: '시작 이미지', type: 'image', roles: ['start_image'] },
  { key: 'end', label: '끝 이미지', type: 'image', roles: ['end_image'] },
  { key: 'refs', label: '레퍼런스 이미지', type: 'image', multi: true, roles: ['image_references', 'image'] },
  { key: 'vref', label: '레퍼런스 영상', type: 'video', multi: true, roles: ['video_references', 'video', 'input_video'] },
  { key: 'aref', label: '레퍼런스 오디오', type: 'audio', multi: true, roles: ['audio_references', 'input_audio'] },
];
function mediaPorts(model) {
  const roles = modelRoles(model);
  const out = [];
  for (const p of ROLE_PORTS) {
    const role = p.roles.find((r) => roles.has(r));
    if (!role) continue;
    const spec = (model.medias || []).find((m) => (m.roles || []).includes(role));
    out.push({ key: p.key, label: p.label, type: p.type, multi: !!p.multi, max: p.multi ? spec?.max : undefined, role });
  }
  return out;
}

function paramFields(model, node) {
  const mode = node.data.params?.mode ?? model?.parameters?.find((p) => p.name === 'mode')?.default;
  // The extension direction only means something while extending a video.
  return modelParams(model).filter((p) => p.name !== 'extension_mode' || mode === 'video_extension').map((p) => {
    const key = `params.${p.name}`;
    const label = PARAM_LABEL[p.name] || p.name;
    if (p.options) return { key, label, kind: 'select', structural: p.name === 'mode', options: p.nullable ? ['', ...p.options] : p.options, fallback: p.default ?? (p.nullable ? '' : p.options[0]) };
    if (p.type === 'bool') return { key, label, kind: 'check', fallback: !!p.default };
    return { key, label, kind: 'number', min: p.min, max: p.max, step: Number.isInteger(p.default ?? 1) ? 1 : 0.05, fallback: p.default ?? p.min };
  });
}
const PARAM_LABEL = { resolution: '해상도', quality: '품질', mode: '모드', genre: '장르', generate_audio: '오디오 생성', variant: '변형', thinking_level: '추론 깊이', extension_mode: '확장 방향', bitrate_mode: '비트레이트', sound: '사운드', background: '배경' };

function modelField(kind) {
  return { key: 'model', label: '모델', kind: 'select', structural: true, wide: true, options: listModels(kind).map((m) => ({ value: m.id, label: `${m.name}${m.provider_name ? ` · ${m.provider_name}` : ''}` })) };
}
function pickModel(node, kind) { return getModel(node.data.model) || listModels(kind)[0]; }

function joinText(items) { return (items || []).map((i) => i.text || '').filter(Boolean).join('\n\n'); }

// Settings sent to the model: only values that differ from "not set", with the model's own parameter names.
function collectParams(node, model) {
  const out = {};
  for (const p of modelParams(model)) {
    const v = node.data.params?.[p.name] ?? p.default;
    if (v === '' || v == null) continue;
    out[p.name] = v;
  }
  return out;
}

// The request a generator node would send, from its settings and what is connected to it.
export function buildRequest(node, inputs) {
  const kind = node.type;
  const model = pickModel(node, kind);
  if (!model) throw new Error('모델을 고르세요');
  const prompt = [joinText(inputs.prompt), node.data.prompt?.trim()].filter(Boolean).join('\n\n');
  const medias = [];
  for (const p of mediaPorts(model)) for (const item of inputs[p.key] || []) medias.push({ role: p.role, item });
  if (!prompt && !medias.length) throw new Error('프롬프트를 쓰거나 연결하세요');
  const req = { kind, model: model.id, prompt, params: collectParams(node, model), medias, count: Math.max(1, Math.min(4, +node.data.count || 1)) };
  if (model.aspect_ratios?.length && node.data.aspect) req.aspect = model.aspect_ratios.includes(node.data.aspect) ? node.data.aspect : model.aspect_ratios[0];
  if (kind === 'video') {
    const d = modelDurations(model);
    if (d) {
      let sec = +node.data.duration || 5;
      if (d.options) sec = d.options.reduce((a, b) => (Math.abs(b - sec) < Math.abs(a - sec) ? b : a));
      else sec = Math.max(d.min, Math.min(d.max, Math.round(sec)));
      req.duration = sec;
    }
  }
  // Models with a text-only mode and a reference mode: follow what is actually connected.
  if (req.params.mode === 't2v' && medias.length) req.params.mode = 'omni_reference';
  else if (req.params.mode === 'omni_reference' && !medias.length) req.params.mode = 't2v';
  return req;
}
async function runGenerate(kind, ctx) {
  const req = buildRequest(ctx.node, ctx.inputs);
  const items = await ctx.provider.generate(req, ctx);
  return { items, request: { model: req.model, prompt: req.prompt } };
}

function generatorFields(kind) {
  return (node) => {
    const model = pickModel(node, kind);
    const fields = [modelField(kind), { key: 'prompt', label: '프롬프트', kind: 'textarea', rows: 4, placeholder: '여기에 쓰거나 텍스트 노드를 연결하세요. 둘 다 있으면 연결된 글 뒤에 붙습니다.' }];
    if (model?.aspect_ratios?.length) fields.push({ key: 'aspect', label: '화면비', kind: 'select', options: model.aspect_ratios, fallback: model.aspect_ratios.includes('16:9') ? '16:9' : model.aspect_ratios[0] });
    if (kind === 'video') {
      const d = modelDurations(model);
      if (d?.options) fields.push({ key: 'duration', label: '길이(초)', kind: 'select', options: d.options.map(String), fallback: String(d.options[0]) });
      else if (d) fields.push({ key: 'duration', label: `길이(초) ${d.min}–${d.max}`, kind: 'number', min: d.min, max: d.max, step: 1, fallback: 5 });
    }
    fields.push(...paramFields(model, node));
    fields.push({ key: 'count', label: '변형 수', kind: 'select', options: ['1', '2', '3', '4'], fallback: '1' });
    return fields;
  };
}

// Form fields from a tool's JSON Schema (top-level properties; nested objects and arrays are edited as JSON).
function schemaFields(schema) {
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  return Object.entries(props).map(([name, s]) => {
    const key = `args.${name}`;
    const label = required.has(name) ? `${name} *` : name;
    const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
    const hint = s.description ? String(s.description).slice(0, 240) : '';
    if (s.enum) return { key, label, hint, kind: 'select', options: required.has(name) ? s.enum.map(String) : ['', ...s.enum.map(String)], fallback: s.default ?? '' };
    if (type === 'boolean') return { key, label, hint, kind: 'check', fallback: !!s.default };
    if (type === 'integer' || type === 'number') return { key, label, hint, kind: 'number', min: s.minimum, max: s.maximum, step: type === 'integer' ? 1 : 'any', fallback: s.default ?? '' };
    if (type === 'string') return { key, label, hint, kind: /prompt|text|description|message/i.test(name) ? 'textarea' : 'text', rows: 3, fallback: s.default ?? '' };
    return { key, label: `${label} (JSON)`, hint, kind: 'textarea', rows: 3, json: true, fallback: '' };
  });
}
function toolOf(node) { return bridge.tools.find((t) => t.server === node.data.server && t.name === node.data.tool); }

export const CATEGORIES = [
  { id: 'input', label: '입력' },
  { id: 'gen', label: '생성' },
  { id: 'edit', label: '가공' },
  { id: 'out', label: '정리' },
  { id: 'mcp', label: 'MCP' },
];

export const NODE_TYPES = {
  text: {
    title: '텍스트', category: 'input', hint: '프롬프트, 캐릭터 설명, 스타일 문장', instant: true, width: 280,
    defaults: { text: '' },
    outputs: [{ key: 'out', label: '텍스트', type: 'text' }],
    fields: () => [{ key: 'text', kind: 'textarea', rows: 6, placeholder: '프롬프트나 설명을 쓰세요' }],
    run: async ({ node }) => ({ items: node.data.text.trim() ? [{ type: 'text', text: node.data.text.trim() }] : [] }),
  },
  join: {
    title: '프롬프트 조합', category: 'input', hint: '여러 텍스트를 틀에 끼워 하나로', instant: true, width: 300,
    defaults: { template: '' },
    inputs: [{ key: 'parts', label: '텍스트', type: 'text', multi: true }],
    outputs: [{ key: 'out', label: '텍스트', type: 'text' }],
    fields: () => [{ key: 'template', label: '틀', kind: 'textarea', rows: 4, placeholder: '비워 두면 연결된 순서(위→아래)대로 이어 붙입니다.\n틀을 쓰면 {1}, {2}… 자리에 들어갑니다.' }],
    preview: 'text',
    run: async ({ node, inputs }) => {
      const parts = (inputs.parts || []).map((i) => i.text || '');
      const tpl = node.data.template.trim();
      const text = tpl ? tpl.replace(/\{(\d+)\}/g, (_, n) => parts[n - 1] ?? '') : parts.filter(Boolean).join('\n\n');
      return { items: text.trim() ? [{ type: 'text', text: text.trim() }] : [] };
    },
  },
  media: {
    title: '미디어 불러오기', category: 'input', hint: '레퍼런스 이미지·영상·오디오 (파일 또는 주소)', instant: true, width: 260,
    defaults: { kind: 'image', url: '', file: '', name: '' },
    outputs: (node) => [{ key: 'out', label: { image: '이미지', video: '영상', audio: '오디오' }[node.data.kind], type: node.data.kind }],
    fields: () => [
      { key: 'kind', label: '종류', kind: 'select', structural: true, options: [{ value: 'image', label: '이미지' }, { value: 'video', label: '영상' }, { value: 'audio', label: '오디오' }] },
      { key: 'file', kind: 'file', label: '파일' },
      { key: 'url', label: '또는 주소', kind: 'text', placeholder: 'https://…' },
    ],
    preview: 'media',
    run: async ({ node }) => {
      const { kind, url, file, name } = node.data;
      if (file) return { items: [{ type: kind, url: file, name, local: true }] };
      if (url.trim()) return { items: [{ type: kind, url: url.trim(), name: url.trim().split('/').pop() }] };
      return { items: [] };
    },
  },
  image: {
    title: '이미지 생성', category: 'gen', hint: '시작 이미지, 캐릭터 시트, 키 비주얼', spends: true, width: 320,
    defaults: { model: 'nano_banana_pro', prompt: '', aspect: '16:9', count: '1', params: {} },
    inputs: (node) => [PROMPT_IN, ...mediaPorts(pickModel(node, 'image'))],
    outputs: [{ key: 'out', label: '이미지', type: 'image' }],
    fields: generatorFields('image'),
    preview: 'media',
    run: (ctx) => runGenerate('image', ctx),
  },
  video: {
    title: '영상 생성', category: 'gen', hint: '시작 이미지 → 영상, 레퍼런스 기반 샷', spends: true, width: 340,
    defaults: { model: 'seedance_2_5', prompt: '', aspect: '16:9', duration: '5', count: '1', params: {} },
    inputs: (node) => [PROMPT_IN, ...mediaPorts(pickModel(node, 'video'))],
    outputs: [{ key: 'out', label: '영상', type: 'video' }],
    fields: generatorFields('video'),
    preview: 'media',
    run: (ctx) => runGenerate('video', ctx),
  },
  upscale: {
    title: '이미지 업스케일', category: 'edit', hint: '2K·4K로 키우기', spends: true, width: 260,
    defaults: { resolution: '4k' },
    inputs: [{ key: 'image', label: '이미지', type: 'image' }],
    outputs: [{ key: 'out', label: '이미지', type: 'image' }],
    fields: () => [{ key: 'resolution', label: '목표 해상도', kind: 'select', options: ['2k', '4k'] }],
    preview: 'media',
    run: async (ctx) => {
      const item = ctx.inputs.image?.[0];
      if (!item) throw new Error('이미지를 연결하세요');
      return { items: await ctx.provider.upscale({ item, resolution: ctx.node.data.resolution }, ctx) };
    },
  },
  frame: {
    title: '프레임 추출', category: 'edit', hint: '영상의 마지막 프레임을 다음 샷의 시작 이미지로', instant: true, width: 260,
    defaults: { at: 'last', time: 0 },
    inputs: [{ key: 'video', label: '영상', type: 'video' }],
    outputs: [{ key: 'out', label: '이미지', type: 'image' }],
    fields: (node) => [
      { key: 'at', label: '위치', kind: 'select', structural: true, options: [{ value: 'last', label: '마지막 프레임' }, { value: 'first', label: '첫 프레임' }, { value: 'time', label: '시간 지정' }] },
      ...(node.data.at === 'time' ? [{ key: 'time', label: '시간(초)', kind: 'number', min: 0, step: 0.1 }] : []),
    ],
    preview: 'media',
    run: async ({ node, inputs }) => {
      const item = inputs.video?.[0];
      if (!item) throw new Error('영상을 연결하세요');
      const url = await grabFrame(item.url, node.data.at, +node.data.time || 0);
      return { items: [{ type: 'image', url, name: 'frame.png', local: true }] };
    },
  },
  board: {
    title: '샷 보드', category: 'out', hint: '결과를 샷 순서대로 모아 보기·샷리스트 내보내기', instant: true, width: 520, outAll: true,
    defaults: { title: '' },
    inputs: [{ key: 'shots', label: '샷', type: 'any', accepts: ['image', 'video'], multi: true }],
    outputs: [],
    fields: () => [{ key: 'title', kind: 'text', placeholder: '시퀀스 이름' }],
    preview: 'board',
    run: async ({ inputs }) => ({ items: inputs.shots || [] }),
  },
  note: {
    title: '메모', category: 'out', hint: '캔버스에 붙이는 설명', instant: true, width: 240, note: true,
    defaults: { text: '' },
    fields: () => [{ key: 'text', kind: 'textarea', rows: 5, placeholder: '메모' }],
    run: async () => ({ items: [] }),
  },
  tool: {
    title: 'MCP 도구', category: 'mcp', hint: '연결된 MCP 서버의 도구를 그대로 실행', spends: true, width: 340,
    defaults: { server: '', tool: '', args: {} },
    inputs: [{ key: 'in', label: '텍스트 → 첫 글 칸', type: 'text', multi: true }],
    outputs: [{ key: 'out', label: '결과', type: 'any' }],
    fields: (node) => {
      const servers = [...new Set(bridge.tools.map((t) => t.server))];
      if (!servers.length) return [{ kind: 'info', text: 'MCP 서버가 연결되어 있지 않습니다. 위쪽 "연결"에서 브리지를 켜고 서버에 로그인하세요.' }];
      const server = servers.includes(node.data.server) ? node.data.server : servers[0];
      const tools = bridge.tools.filter((t) => t.server === server);
      const fields = [
        { key: 'server', label: '서버', kind: 'select', structural: true, options: servers, fallback: server },
        { key: 'tool', label: '도구', kind: 'select', structural: true, options: ['', ...tools.map((t) => t.name)] },
      ];
      const tool = tools.find((t) => t.name === node.data.tool);
      if (tool) {
        if (tool.description) fields.push({ kind: 'info', text: tool.description.slice(0, 300) });
        fields.push(...schemaFields(tool.inputSchema));
      }
      return fields;
    },
    preview: 'mixed',
    run: async ({ node, inputs, provider }) => {
      const tool = toolOf(node);
      if (!tool) throw new Error('도구를 고르세요');
      const props = tool.inputSchema?.properties || {};
      const args = {};
      for (const [name, s] of Object.entries(props)) {
        let v = node.data.args?.[name];
        if (v === '' || v == null) continue;
        const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
        if (!s.enum && type !== 'string' && type !== 'boolean' && type !== 'integer' && type !== 'number' && typeof v === 'string') {
          try { v = JSON.parse(v); } catch { throw new Error(`${name}: JSON 형식이 아닙니다`); }
        }
        args[name] = v;
      }
      const piped = joinText(inputs.in);
      if (piped) {
        const target = Object.keys(props).find((k) => /prompt|text|query|message/i.test(k) && props[k].type === 'string');
        if (target) args[target] = [piped, args[target]].filter(Boolean).join('\n\n');
      }
      return { items: await provider.callTool(tool.server, tool.name, args) };
    },
  },
};
