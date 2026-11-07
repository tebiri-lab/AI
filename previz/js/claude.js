// Shot planning with Claude: the free-text shot description plus the scene goes to Claude, which answers
// with structured shot plans (shot vocabulary, optional explicit camera keys, object moves, poses).
// Both routes run on the person's own claude.ai subscription: inside the claude.ai artifact the page asks
// Claude directly (`sample` capability); anywhere else the prompt is copied into a Claude chat and the JSON pasted back.
import { SIZES, ANGLES, DIRS, MOVES, SPEED, POSE_SETS, OBJ_TYPES, SENSORS } from './constants.js';
import { objectHeight } from './generator.js';

// Object types Claude may add to the scene (whole venues and imported models are left to the person).
export const ADDABLE = Object.keys(OBJ_TYPES).filter((k) => !['ballpark', 'model', 'dust'].includes(k));
const EASES = ['inout', 'linear', 'in', 'out', 'back', 'elastic', 'bounce', 'steps'];
const RUNS = ['none', 'ahead', 'b1', 'b2', 'b3', 'home'];

const num = { type: 'number' };
const vec3 = { type: 'array', items: num };
const POSE_KEYS = { drop: num, pitch: num, lean: num, head: num, turn: num, hip: { type: 'array', items: num }, knee: { type: 'array', items: num }, sh: { type: 'array', items: num }, el: { type: 'array', items: num } };

// JSON Schema for the answer (strict structured output: every field required, empty array = not used).
export const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['new_objects', 'new_poses', 'shots', 'notes'],
  properties: {
    notes: { type: 'string' },
    new_objects: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['ref', 'type', 'name', 'pos', 'rotY', 'color', 'height', 'size'],
        properties: {
          ref: { type: 'string' },
          type: { type: 'string', enum: ADDABLE },
          name: { type: 'string' },
          pos: vec3,
          rotY: num,
          color: { type: 'string' },
          height: num,
          size: { type: 'array', items: num },
        },
      },
    },
    new_poses: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'label', 'walk', 'angles'],
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
          walk: { type: 'boolean' },
          angles: { type: 'object', additionalProperties: false, required: Object.keys(POSE_KEYS), properties: POSE_KEYS },
        },
      },
    },
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
  const custom = Object.keys(project.customPoses || {});
  const lines = project.objects.map((o) => {
    const yaw = (o.rotY || 0) * Math.PI / 180;
    const face = [r2(Math.sin(yaw)), 0, r2(Math.cos(yaw))];
    const names = POSE_SETS[o.type] ? [...Object.keys(POSE_SETS[o.type]), ...(o.type === 'actor' ? custom : [])] : null;
    const poses = names ? ` | poses: ${names.join(', ')}` : '';
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
- subject / subject2: object id from the scene list or a new_objects ref ("" for none). subject2 is the foreground shoulder for an over-the-shoulder, or the second person in a two-shot.
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
poses: [{object, pose}] with a pose name listed for that object, or one you define in new_poses.

MISSING OBJECTS — add them, do not skip them. When a shot names a person or thing that is not in the scene list, add it to new_objects and use its "ref" (a short unique string such as "new1") wherever an object id goes (subject, subject2, object_moves, poses). Fields: type (${ADDABLE.map((k) => `${k} = ${OBJ_TYPES[k].ko}`).join(', ')}; a person is always "actor"; pick the closest type for anything else, e.g. a door or building is "wall"/"box", a lamp post "cylinder", a bench "table"), name (in the director's language, as they wrote it), pos and rotY placed sensibly relative to the existing scene and the action (people face whom they talk to; keep 1-2 m between people in conversation; nothing inside another object), color ("#rrggbb", give actors distinct colours; "" for the default), height in m (0 = default; actors ≈ 1.6-1.85), size [w, h, d] in m for box-like types ([] = default). Reuse an existing object whenever one fits.

MISSING POSES — define them. When the action needs an actor posture the listed poses do not have (pointing, crouching, hands on hips, lying down, kneeling with both knees...), add it to new_poses and use its name in poses. name: lowercase ascii id (e.g. "point_right"); label: short Korean description; walk: true only for an upright pose the actor may walk in. angles (radians unless noted; all 9 keys required, 0 or [] = neutral):
- drop: pelvis height change in m (sit ≈ -0.4, deep squat ≈ -0.5); pitch: whole-body tilt about the feet (+ falls forward/prone ≈ 1.5, - backward/supine ≈ -1.5).
- lean: torso bend (+ forward). head: nod (+ looks down, - looks up). turn: head yaw (+ to the actor's left).
- hip [L, R]: thigh swing (- forward/up: sitting ≈ -1.57; + backward). knee [L, R]: bend (+, 0..2.4).
- sh [L pitch, L out, R pitch, R out]: arm swing (- forward/up: straight ahead ≈ -1.57, overhead ≈ -2.9; + backward); "out" raises the arm sideways: left + / right - (rest ≈ 0.08 / -0.08, horizontal ≈ 1.5 / -1.5).
- el [L, R]: elbow bend (- bends the forearm forward/up, 0 straight, about -2.4 at most).
Built-in examples: sit = drop -0.4, hip [-1.57,-1.57], knee [1.57,1.57], sh [-0.55,0.12,-0.55,-0.12], el [-0.2,-0.2]; catcher crouch = drop -0.5, hip [-1.6,-1.6], knee [1.95,1.95], lean 0.22. Prefer a listed pose when it fits.

If the text asks for something even new objects and poses cannot show, plan the closest shot and say so in notes (Korean). notes: one or two Korean sentences about choices you made and what you added, empty if none.`;

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

// The viewer's own Claude (subscription) through the claude.ai artifact runtime's `sample` capability.
// Resolves the sample function, or null outside claude.ai (then the copy/paste route is the way).
let samplePromise = null;
export function claudeSample() {
  if (!samplePromise) {
    samplePromise = window.claude?.use ? window.claude.use('sample').catch(() => null) : Promise.resolve(null);
  }
  return samplePromise;
}

const SAMPLE_ERRORS = {
  not_granted: 'Claude 사용을 허용하지 않아 생성할 수 없습니다 — 페이지를 새로 열면 다시 물어봅니다',
  sampling_disabled: '이 계정에서는 Claude를 쓸 수 없습니다',
  not_declared: '이 페이지에 Claude 사용 권한이 없습니다',
  capability_disabled: '이 화면에서는 Claude를 쓸 수 없습니다',
  capability_removed: '이 앱 버전에서는 Claude를 쓸 수 없습니다 — Claude 앱·브라우저를 업데이트해 주세요',
  rate_limited: '사용 한도에 걸렸습니다 — 잠시 뒤 다시 눌러 주세요',
  session_expired: 'claude.ai에 다시 로그인해 주세요',
  refused: 'Claude가 이 요청을 거절했습니다 — 샷 설명을 바꿔 보세요',
  empty_completion: 'Claude가 빈 답을 냈습니다 — 샷 수를 줄여 다시 시도하세요',
  invalid_json: 'Claude 답을 JSON으로 읽지 못했습니다 — 다시 눌러 주세요',
  prompt_too_large: '씬이나 샷 설명이 너무 깁니다 — 나눠서 생성하세요',
};
export const sampleErrorText = (e) => SAMPLE_ERRORS[e?.code] || `Claude 호출 실패 (${e?.code || 'error'}) — 다시 눌러 주세요`;

/** Plan shots with the viewer's own Claude. Rejects with the sample error shape ({code, message, text?}). */
export async function planWithSubscription(project, text, { signal, onText } = {}) {
  const sample = await claudeSample();
  if (!sample) throw { code: 'capability_disabled', message: 'sample unavailable' };
  const data = await sample.json(copyPrompt(project, text), { modelTier: 'complex', cache: false, signal, onText });
  if (!data || !Array.isArray(data.shots)) throw { code: 'invalid_json', message: 'no shots array', text: JSON.stringify(data) };
  return data;
}
