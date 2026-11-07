// Shot planning with Claude: the free-text shot description plus the scene goes to Claude, which answers
// with structured shot plans (shot vocabulary, optional explicit camera keys, object moves, poses).
// Two routes: copy a prompt into the person's own Claude chat (subscription) and paste the JSON back,
// or call the API directly with the person's own API key.
import { SIZES, ANGLES, DIRS, MOVES, SPEED, POSE_SETS, OBJ_TYPES, SENSORS } from './constants.js';
import { objectHeight } from './generator.js';

export const CLAUDE_MODEL = 'claude-opus-5-5';
const EASES = ['inout', 'linear', 'in', 'out', 'back', 'elastic', 'bounce', 'steps'];
const RUNS = ['none', 'ahead', 'b1', 'b2', 'b3', 'home'];

const num = { type: 'number' };
const vec3 = { type: 'array', items: num };

// JSON Schema for the answer (strict structured output: every field required, empty array = not used).
export const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['shots', 'notes'],
  properties: {
    notes: { type: 'string' },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'source', 'subject', 'subject2', 'size', 'angle', 'dir', 'move', 'speed', 'lens', 'duration',
          'ease', 'handheld', 'dutch', 'run', 'desc', 'camera_keys', 'object_moves', 'poses'],
        properties: {
          name: { type: 'string' },
          source: { type: 'string' },
          subject: { type: 'string' },
          subject2: { type: 'string' },
          size: { type: 'string', enum: Object.keys(SIZES) },
          angle: { type: 'string', enum: Object.keys(ANGLES) },
          dir: { type: 'string', enum: Object.keys(DIRS) },
          move: { type: 'string', enum: Object.keys(MOVES) },
          speed: { type: 'string', enum: Object.keys(SPEED) },
          lens: num,
          duration: num,
          ease: { type: 'string', enum: EASES },
          handheld: { type: 'boolean' },
          dutch: { type: 'boolean' },
          run: { type: 'string', enum: RUNS },
          desc: { type: 'string' },
          camera_keys: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['t', 'pos', 'target', 'focal', 'roll'],
              properties: { t: num, pos: vec3, target: vec3, focal: num, roll: num },
            },
          },
          object_moves: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['object', 'keys'],
              properties: {
                object: { type: 'string' },
                keys: {
                  type: 'array',
                  items: {
                    type: 'object', additionalProperties: false, required: ['t', 'pos', 'rotY'],
                    properties: { t: num, pos: vec3, rotY: num },
                  },
                },
              },
            },
          },
          poses: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['object', 'pose'],
              properties: { object: { type: 'string' }, pose: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const list = (o) => Object.entries(o).map(([k, v]) => `${k} (${v.ko}${v.en ? ` / ${v.en}` : ''})`).join(', ');
const r2 = (n) => Math.round(n * 100) / 100;

function sceneBlock(project) {
  const lines = project.objects.map((o) => {
    const yaw = (o.rotY || 0) * Math.PI / 180;
    const face = [r2(Math.sin(yaw)), 0, r2(Math.cos(yaw))];
    const poses = POSE_SETS[o.type] ? ` | poses: ${Object.keys(POSE_SETS[o.type]).join(', ')}` : '';
    return `- id "${o.id}" | name "${o.name}" | type ${o.type} (${OBJ_TYPES[o.type]?.ko || o.type}) | pos [${o.pos.map(r2).join(', ')}] | rotY ${r2(o.rotY || 0)}° (faces ${JSON.stringify(face)}) | height ${r2(objectHeight(o))} m${o.parent ? ` | attached to "${o.parent}"` : ''}${poses}`;
  });
  const sensor = SENSORS[project.sensor] || SENSORS.s35;
  return [
    `Project: "${project.name}", aspect ${(+project.aspect).toFixed(2)}:1, sensor ${sensor.en} (${sensor.w} mm wide), ${project.fps} fps, lighting "${project.lighting}".`,
    'Scene objects:',
    ...(lines.length ? lines : ['- (none)']),
    `Existing shots: ${project.shots.length}${project.shots.length ? ` (last: "${project.shots[project.shots.length - 1].name}")` : ''}.`,
  ].join('\n');
}

export const SYSTEM_PROMPT = `You are the previs camera operator inside a three.js previsualization tool. The director writes shot descriptions (usually Korean, one shot per line, text after "|" is the action). Turn them into exact shot plans for the scene they give you.

World: right-handed, Y up, metres. The ground is y = 0. An object with rotY = 0° faces +Z; rotY turns it counter-clockwise seen from above, so it faces [sin(rotY), 0, cos(rotY)]. Actor height is about 1.75 m (eyes ≈ 1.63 m).

For every shot, fill the shot vocabulary; the tool computes a correctly framed camera from it using real lens maths:
- subject / subject2: object id from the scene list ("" for none). subject2 is the foreground shoulder for an over-the-shoulder, or the second person in a two-shot.
- size: ${list(SIZES)}
- angle: ${list(ANGLES)}
- dir (camera side relative to where the subject faces): ${list(DIRS)}
- move: ${list(MOVES)}
- speed: ${list(SPEED)}; ease: ${EASES.join(', ')}
- lens: focal length in mm (S35 equivalents: 18-24 wide, 35-50 normal, 85-135 tele). duration: seconds.
- handheld, dutch: booleans. run: ${RUNS.join(', ')} ("ahead" = the subject sprints forward along its facing; b1/b2/b3/home only in a ballpark).
- desc: the action in the director's own language, one short sentence. name: short shot title in the director's language. source: the original line.

Only when the vocabulary cannot express the move (e.g. a camera that starts behind and swings to the front, a move between two people, a reveal past an object), give camera_keys: at least 2 keys {t (s, 0..duration), pos [x,y,z], target [x,y,z], focal (mm), roll (deg)} in world coordinates. Check each key frames what the shot asks for: distance ≈ (frame height / 2) / tan(vfov / 2), with vfov from the focal length, sensor width and aspect. Otherwise leave camera_keys empty.

object_moves: only if something must move during the shot (walking to a spot, a car driving past). Keys {t, pos, rotY} in world coordinates; actors walk ≈1.4 m/s, run ≈7.5 m/s. Keep the first key at the object's current position unless the shot says otherwise.
poses: only with pose names listed for that object.

Stay inside the scene: use ids that exist; never invent objects. If the text asks for something the scene cannot show, plan the closest shot and say so in notes (Korean). notes: one or two Korean sentences about choices you made, empty if none.`;

export function userPrompt(project, text) {
  return `${sceneBlock(project)}\n\nShot descriptions:\n${text.trim()}`;
}

/** Everything in one message, for pasting into the person's own Claude chat. */
export function copyPrompt(project, text) {
  return `${SYSTEM_PROMPT}

Answer with ONLY one JSON object (no prose, no code fence) that matches this JSON Schema:
${JSON.stringify(SHOT_SCHEMA)}

${userPrompt(project, text)}`;
}

/** Pull the JSON object out of a pasted Claude reply (tolerates code fences and surrounding text). */
export function parseReply(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('JSON을 찾지 못했습니다');
  const data = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(data.shots)) throw new Error('"shots" 배열이 없습니다');
  return data;
}

let sdk = null;
/** Ask Claude through the API with the viewer's own key (kept only in this browser). */
export async function planWithApi(apiKey, project, text, signal) {
  if (!sdk) sdk = (await import('../vendor/anthropic/sdk.min.mjs')).default;
  const client = new sdk({ apiKey, dangerouslyAllowBrowser: true });
  const res = await client.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SHOT_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt(project, text) }],
  }, { signal });
  if (res.stop_reason === 'refusal') throw new Error(`Claude가 요청을 거절했습니다${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : ''}`);
  if (res.stop_reason === 'max_tokens') throw new Error('응답이 너무 길어 잘렸습니다 — 샷 수를 줄여 다시 시도하세요');
  const out = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  return parseReply(out);
}
