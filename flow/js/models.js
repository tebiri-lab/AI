// Model catalog. The entries use the same field shape as the Higgsfield MCP `models_explore` answer
// (parameters[], medias[].roles, aspect_ratios, durations / duration_range), so a live catalog fetched
// through the bridge replaces these as-is. The list below was taken from that catalog on 2026-11-11.

const RES = (opts, def) => ({ name: 'resolution', type: 'string', options: opts, default: def });
const AUDIO = (def = true) => ({ name: 'generate_audio', type: 'bool', default: def });
const GENRE = { name: 'genre', type: 'string', options: ['auto', 'action', 'horror', 'comedy', 'noir', 'drama', 'epic'], default: 'auto' };
const AR_WIDE = ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const AR_IMG = ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '9:16', '16:9', '21:9'];
const ALL_REFS = ['start_image', 'end_image', 'image_references', 'video_references', 'audio_references'];

export const SEED_MODELS = [
  // ---- image
  { id: 'nano_banana_pro', name: 'Nano Banana Pro', provider_name: 'Google', output_type: 'image', description: '최고 품질, 글자·도표', parameters: [RES(['1k', '2k', '4k'], '2k')], medias: [{ roles: ['image_references'] }], aspect_ratios: AR_IMG },
  { id: 'nano_banana_2_1', name: 'Nano Banana 2.1', provider_name: 'Google', output_type: 'image', description: '이미지·영상 레퍼런스', parameters: [RES(['1k', '2k', '4k'], '1k'), { name: 'thinking_level', type: 'string', options: ['minimal', 'medium', 'high'], default: 'medium' }], medias: [{ roles: ['image_references'] }], aspect_ratios: ['auto', ...AR_IMG] },
  { id: 'gpt_image_2_6', name: 'GPT Image 2.6', provider_name: 'OpenAI', output_type: 'image', description: '실사·글자·레퍼런스 편집', parameters: [{ name: 'quality', type: 'string', options: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'low' }, RES(['1k', '2k', '4k'], '1k')], medias: [{ roles: ['image_references'] }], aspect_ratios: ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9', '4:5', '5:4'] },
  { id: 'seedream_v4_5', name: 'Seedream 4.5', provider_name: 'Bytedance', output_type: 'image', description: '4K, 정밀 제어', parameters: [{ name: 'quality', type: 'string', options: ['basic', 'high'], default: 'basic' }], medias: [{ roles: ['image_references'] }], aspect_ratios: ['1:1', '4:3', '16:9', '3:2', '21:9', '3:4', '9:16', '2:3'] },
  { id: 'flux_3_image', name: 'FLUX 3 Image', provider_name: 'Black Forest Labs', output_type: 'image', description: '레퍼런스 최대 10장', parameters: [RES(['768sq', '1k', '1.5k', '2k', '4k'], '1k')], medias: [{ roles: ['image_references'] }], aspect_ratios: ['auto', '21:9', '16:9', '3:2', '4:3', '1:1', '4:5', '3:4', '2:3', '9:16'] },
  { id: 'cinematic_studio_2_5', name: 'Cinema Studio Image 2.5', provider_name: 'Higgsfield', output_type: 'image', description: '시네마틱 스틸', parameters: [RES(['1k', '2k', '4k'], '1k')], medias: [{ roles: ['image'] }], aspect_ratios: AR_IMG },
  { id: 'soul_2', name: 'Higgsfield Soul 2.0', provider_name: 'Higgsfield', output_type: 'image', description: '실사 인물·패션', parameters: [{ name: 'quality', type: 'string', options: ['1.5k', '2k'], default: '2k' }], medias: [{ max: 1, roles: ['image'] }], aspect_ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] },
  // ---- video
  { id: 'seedance_2_5', name: 'Seedance 2.5', provider_name: 'Bytedance', output_type: 'video', description: '멀티 레퍼런스, 편집, 확장',
    parameters: [{ name: 'mode', type: 'string', options: ['t2v', 'omni_reference', 'video_edit', 'video_extension'], default: 't2v' }, RES(['480p', '720p', '1080p'], '720p'), AUDIO(), { name: 'extension_mode', type: 'string', options: ['backward', 'forward'], nullable: true }],
    medias: [{ roles: ALL_REFS }], aspect_ratios: AR_WIDE, duration_range: { min: 4, max: 30 } },
  { id: 'seedance_2_0', name: 'Seedance 2.0', provider_name: 'Bytedance', output_type: 'video', description: '레퍼런스 기반, 인물 일관성',
    parameters: [RES(['480p', '720p', '1080p', '4k'], '720p'), { name: 'mode', type: 'string', options: ['std', 'fast'], default: 'std' }, GENRE, AUDIO()],
    medias: [{ roles: ALL_REFS }], aspect_ratios: ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', '21:9'], duration_range: { min: 4, max: 15 } },
  { id: 'cinematic_studio_3_0', name: 'Cinema Studio Video 3.0', provider_name: 'Higgsfield', output_type: 'video', description: '시네마 등급',
    parameters: [RES(['480p', '720p', '1080p', '4k'], '720p'), GENRE, AUDIO(false)],
    medias: [{ roles: ['image', 'start_image', 'end_image'] }], aspect_ratios: AR_WIDE, duration_range: { min: 4, max: 15 } },
  { id: 'minimax_h3', name: 'MiniMax H3', provider_name: 'MiniMax', output_type: 'video', description: '2K 키프레임·혼합 레퍼런스',
    parameters: [RES(['2K'], '2K')], medias: [{ roles: ALL_REFS }], aspect_ratios: AR_WIDE, duration_range: { min: 4, max: 15 } },
  { id: 'minimax_hailuo', name: 'Minimax Hailuo', provider_name: 'Hailuo', output_type: 'video', description: '자연스러운 물리·표정',
    parameters: [{ name: 'variant', type: 'string', options: ['minimax', 'minimax-fast', 'minimax-2.3', 'minimax-2.3-fast'], default: 'minimax-2.3' }, RES(['512', '768', '1080'], '768')],
    medias: [{ roles: ['start_image', 'end_image'] }], aspect_ratios: [], durations: [6, 10] },
  { id: 'flux_3_video', name: 'FLUX 3 Video', provider_name: 'Black Forest Labs', output_type: 'video', description: '시작·끝 프레임, 영상 이어가기',
    parameters: [RES(['720p', '1080p', '2k', '4k'], '720p'), AUDIO()],
    medias: [{ roles: ['start_image', 'end_image', 'image_references', 'video_references'] }], aspect_ratios: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], duration_range: { min: 5, max: 20 } },
  { id: 'seedance1_5', name: 'Seedance 1.5 Pro', provider_name: 'Bytedance', output_type: 'video', description: '안정적인 모션',
    parameters: [RES(['480p', '720p', '1080p'], '720p'), AUDIO()], medias: [{ roles: ['start_image', 'end_image'] }], aspect_ratios: ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', '21:9'], durations: [4, 8, 12] },
];

const STORE_KEY = 'flow.models.v1';
let models = SEED_MODELS;
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  if (Array.isArray(saved) && saved.length) models = saved;
} catch { /* keep the seed list */ }

export const listModels = (kind) => models.filter((m) => m.output_type === kind);
export const getModel = (id) => models.find((m) => m.id === id);
export const isLiveCatalog = () => models !== SEED_MODELS;

// Replace the catalog with one fetched from the MCP server (kept in the browser for the next visit).
export function setModels(items) {
  const usable = items.filter((m) => m && m.id && (m.output_type === 'image' || m.output_type === 'video'));
  if (!usable.length) return 0;
  models = usable;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(usable)); } catch { /* not saved; still used this visit */ }
  return usable.length;
}

export function modelRoles(model) {
  const roles = new Set();
  for (const m of model?.medias || []) for (const r of m.roles || []) roles.add(r);
  return roles;
}
export function modelDurations(model) {
  if (!model) return null;
  if (model.durations?.length) return { options: model.durations };
  if (model.duration_range) return model.duration_range;
  const p = model.parameters?.find((x) => x.name === 'duration');
  if (p?.options) return { options: p.options };
  if (p && p.min != null) return { min: p.min, max: p.max };
  return null;
}
// Parameters the node shows as controls: simple enums, booleans and numbers. Ids, folders and free objects are left out.
const HIDDEN = new Set(['duration', 'folder_id', 'batch_size', 'preset_id', 'style_id', 'soul_id', 'draft_job_id', 'width', 'height', 'size']);
export function modelParams(model) {
  return (model?.parameters || []).filter((p) => !HIDDEN.has(p.name) && !/_ids?$/.test(p.name) && (p.options || p.type === 'bool' || (p.type === 'number' && p.min != null)));
}
