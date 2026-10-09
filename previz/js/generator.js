// Rule-based shot generation: turns cinematography vocabulary (size, angle,
// lens, move) into camera keyframes, and parses free text into those params.
import * as THREE from 'three';
import { SIZES, ANGLES, DIRS, MOVES, SPEED, SENSORS } from './constants.js';
import { sampleObject } from './anim.js';

const V = THREE.Vector3;
const UP = new V(0, 1, 0);
const D2R = Math.PI / 180;
const round = (n) => Math.round(n * 1000) / 1000;
const arr = (v) => [round(v.x), round(v.y), round(v.z)];

export function verticalFov(focal, sensorW, aspect) {
  const filmH = aspect >= 1 ? sensorW / aspect : sensorW;
  return 2 * Math.atan(filmH / 2 / focal);
}

export function objectHeight(o) {
  switch (o.type) {
    case 'actor': return o.height || 1.75;
    case 'car': return 1.45;
    case 'tree': return o.height || 5;
    case 'mark': return 0.05;
    case 'drums': return 1.3;
    case 'micstand': return o.height || 1.5;
    case 'metronome': return 0.26;
    case 'balloon': case 'mballoon': return (o.size && o.size[1]) || 0.36;
    default: return (o.size && o.size[1]) || 1;
  }
}

// Height above the origin where an object's framed part starts (a balloon floats on its string).
export function objectBase(o) {
  return o.type === 'balloon' ? (o.height ?? 1.6) : o.type === 'mballoon' ? (o.height ?? 0) : 0;
}

/** Look-at offset above the object's origin for a shot size. */
export function aimOffset(o, sizeKey) {
  const frac = o.type === 'actor' ? (SIZES[sizeKey]?.aim ?? 0.85) : 0.5;
  return objectBase(o) + objectHeight(o) * frac;
}

function startTransform(obj, shot) {
  const s = sampleObject(obj, shot, 0);
  return { pos: new V(...s.pos), rotY: s.rotY };
}

function aimPoint(obj, sizeKey, shot) {
  const { pos } = startTransform(obj, shot);
  return new V(pos.x, pos.y + aimOffset(obj, sizeKey), pos.z);
}

export const defaultParams = () => ({
  subject: null, subject2: null, size: 'ms', angle: 'eye', dir: 'ql', move: 'push',
  speed: 'normal', lens: 50, duration: 4, ease: 'inout', handheld: false, dutch: false,
});

/**
 * Build camera keys (and object animation where the move needs it).
 * @returns {{keys, anim, ease, shake, meta, duration, name}}
 */
export function generateShot(p, project, prevShot) {
  const subj = project.objects.find((o) => o.id === p.subject) || null;
  const sec = project.objects.find((o) => o.id === p.subject2 && o.id !== p.subject) || null;
  const size = SIZES[p.size] || SIZES.ms;
  const sensorW = (SENSORS[project.sensor] || SENSORS.s35).w;
  const focal = Math.max(8, +p.lens || size.lens);
  const dur = Math.max(0.5, +p.duration || 4);
  const k = (SPEED[p.speed] || SPEED.normal).k;
  const roll = p.dutch ? 12 : 0;

  const start = subj ? startTransform(subj, prevShot) : { pos: new V(0, 0, 0), rotY: 0 };
  const yaw = start.rotY * D2R;
  const H = subj ? objectHeight(subj) : 1.75;
  const isActor = !subj || subj.type === 'actor';
  const frameH = isActor ? size.frame * (H / 1.75) : Math.max(0.3, size.obj * H);
  const aim = subj ? aimPoint(subj, p.size, prevShot) : new V(0, 1.75 * size.aim, 0);
  const fov = verticalFov(focal, sensorW, project.aspect);
  const d = frameH / 2 / Math.tan(fov / 2);

  const facing = new V(Math.sin(yaw), 0, Math.cos(yaw));
  const dirKey = p.dir === 'ots' && !sec ? 'ql' : p.dir;
  const hdir = facing.clone().applyAxisAngle(UP, ((DIRS[dirKey] || DIRS.front).az) * D2R);

  let pos;
  let target = aim.clone();
  const ground = start.pos.y;

  if (dirKey === 'ots' && sec) {
    const secStart = startTransform(sec, prevShot);
    const v = secStart.pos.clone().sub(start.pos).setY(0);
    const sep = v.length() || 1;
    v.normalize();
    const lateral = new V().crossVectors(UP, v).normalize(); // to the camera's right when looking at the subject
    const secH = objectHeight(sec);
    const dd = Math.max(d, sep + 0.75);
    pos = aim.clone().addScaledVector(v, dd).addScaledVector(lateral, -0.42 * (secH / 1.75));
    pos.y = secStart.pos.y + secH * 0.9;
    hdir.copy(v);
  } else {
    const angle = ANGLES[p.angle] || ANGLES.eye;
    if (angle.elev === null) {
      pos = aim.clone().addScaledVector(hdir, d);
      pos.y = ground + 0.12;
    } else {
      const e = angle.elev * D2R;
      pos = aim.clone().addScaledVector(hdir, Math.cos(e) * d).addScaledVector(UP, Math.sin(e) * d);
      if (angle.elev > 80) pos.addScaledVector(hdir, 0.02); // avoid a degenerate up vector
      pos.y = Math.max(pos.y, ground + 0.15);
    }
  }

  const key = (t, ps, tg, f = focal) => ({ t: round(t), pos: arr(ps), target: arr(tg), focal: round(f), roll });
  const keys = [];
  const anim = {};
  let ease = p.ease || 'inout';
  const off = pos.clone().sub(target);
  const fwd = target.clone().sub(pos).setY(0).normalize();
  const right = new V().crossVectors(fwd, UP).normalize();
  const scale = Math.max(0.6, d * 0.35);
  const rotAround = (point, center, deg) => point.clone().sub(center).applyAxisAngle(UP, deg * D2R).add(center);

  switch (p.move) {
    case 'push':
      keys.push(key(0, target.clone().addScaledVector(off, 1 + 0.5 * k), target), key(dur, pos, target));
      break;
    case 'pull':
      keys.push(key(0, pos, target), key(dur, target.clone().addScaledVector(off, 1 + 0.5 * k), target));
      break;
    case 'truck_l':
    case 'truck_r': {
      const L = scale * 1.6 * k * (p.move === 'truck_l' ? -1 : 1);
      const a = right.clone().multiplyScalar(-L / 2), b = right.clone().multiplyScalar(L / 2);
      keys.push(key(0, pos.clone().add(a), target.clone().add(a)), key(dur, pos.clone().add(b), target.clone().add(b)));
      break;
    }
    case 'crane_up':
    case 'crane_down': {
      const sv = Math.max(0.8, d * 0.3) * 1.2 * k;
      const lo = pos.clone(); lo.y = Math.max(ground + 0.2, pos.y - sv);
      const hi = pos.clone(); hi.y = pos.y + sv;
      if (p.move === 'crane_up') keys.push(key(0, lo, target), key(dur, hi, target));
      else keys.push(key(0, hi, target), key(dur, lo, target));
      break;
    }
    case 'orbit_l':
    case 'orbit_r':
    case 'orbit_360': {
      const total = p.move === 'orbit_360' ? 360 : (p.move === 'orbit_l' ? -1 : 1) * Math.min(180, 90 * k);
      const steps = Math.max(2, Math.ceil(Math.abs(total) / 15));
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        keys.push(key(u * dur, rotAround(pos, target, -total / 2 + total * u + (p.move === 'orbit_360' ? total / 2 : 0)), target));
      }
      break;
    }
    case 'track': {
      if (!subj || !['actor', 'car'].includes(subj.type) || subj.parent) {
        keys.push(key(0, target.clone().addScaledVector(off, 1.3), target), key(dur, pos, target));
        break;
      }
      const speed = (subj.type === 'car' ? 8 : 1.3) * k;
      const move = facing.clone().multiplyScalar(speed * dur);
      anim[subj.id] = [
        { t: 0, pos: arr(start.pos), rotY: start.rotY },
        { t: round(dur), pos: arr(start.pos.clone().add(move)), rotY: start.rotY },
      ];
      keys.push(key(0, pos, target), key(dur, pos.clone().add(move), target.clone().add(move)));
      ease = 'linear';
      break;
    }
    case 'pan_l':
    case 'pan_r':
    case 'whip_l':
    case 'whip_r': {
      const whip = p.move.startsWith('whip');
      const sign = p.move.endsWith('_l') ? 1 : -1;
      if (whip) {
        let endTarget;
        if (sec) {
          endTarget = aimPoint(sec, p.size, prevShot);
        } else {
          endTarget = rotAround(target, pos, sign * 100);
        }
        const toA = target.clone().sub(pos), toB = endTarget.clone().sub(pos);
        const angA = Math.atan2(toA.x, toA.z), angB = Math.atan2(toB.x, toB.z);
        let delta = angB - angA;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        keys.push(key(0, pos, target), key(dur * 0.4, pos, target));
        const n = 5;
        for (let i = 1; i <= n; i++) {
          const u = i / n;
          const tg = rotAround(target, pos, (delta * u) / D2R);
          tg.lerp(endTarget, u * u); // land exactly on the second subject
          keys.push(key(dur * (0.4 + 0.15 * u), pos, tg));
        }
        keys.push(key(dur, pos, endTarget));
        ease = 'linear';
      } else {
        const A = 35 * k;
        keys.push(key(0, pos, rotAround(target, pos, -sign * A / 2)), key(dur, pos, rotAround(target, pos, sign * A / 2)));
      }
      break;
    }
    case 'tilt_up':
    case 'tilt_down': {
      const low = target.clone();
      low.y = Math.max(ground + 0.15, target.y - Math.max(0.6, frameH * 1.4) * k);
      const high = target.clone();
      if (p.move === 'tilt_up') keys.push(key(0, pos, low), key(dur, pos, high));
      else keys.push(key(0, pos, high), key(dur, pos, low));
      break;
    }
    case 'dolly_zoom': {
      const m = 1 + 1.2 * k;
      keys.push(key(0, pos, target, focal), key(dur, target.clone().addScaledVector(off, m), target, Math.min(400, focal * m)));
      break;
    }
    case 'drone': {
      const flat = off.clone().setY(0);
      const a = target.clone().addScaledVector(flat, 0.7); a.y = Math.max(ground + 0.5, pos.y);
      const b = target.clone().addScaledVector(flat, 1 + 1.2 * k); b.y = target.y + d * 0.7 + 3 * k;
      keys.push(key(0, a, target), key(dur, b, target));
      break;
    }
    default:
      keys.push(key(0, pos, target));
  }

  const name = `${size.short} · ${(MOVES[p.move] || MOVES.static).ko}`;
  return {
    name,
    duration: dur,
    keys,
    anim,
    ease,
    shake: p.handheld ? 0.6 : 0,
    meta: { ...p, lens: focal, duration: dur },
  };
}

// ---------------------------------------------------------------------------
// Free-text parsing (Korean + English cinematography shorthand)

const SIZE_RULES = [
  ['ecu', /익스트림\s*클로즈|초\s*근접|\becu\b|extreme\s*close/],
  ['ews', /익스트림\s*와이드|설정\s*샷|establishing|\bews\b|extreme\s*wide/],
  ['mcu', /미디엄\s*클로즈|바스트|\bmcu\b|medium\s*close/],
  ['cu', /클로즈|근접|\bcu\b|close/],
  ['mls', /니\s*샷|카우보이|미디엄\s*롱|\bmls\b|cowboy|knee/],
  ['ms', /미디엄|웨이스트|\bms\b|medium|waist/],
  ['fs', /풀\s*샷|전신|full\s*shot|\bfs\b/],
  ['ws', /와이드|롱\s*샷|원경|wide|\bws\b|long\s*shot/],
];
const ANGLE_RULES = [
  ['overhead', /탑\s*뷰|탑\s*샷|수직|버즈\s*아이|overhead|top[\s-]*down|bird/],
  ['worm', /웜|지면|worm/],
  ['low', /로우|앙각|올려\s*다|low/],
  ['high', /하이|부감|내려\s*다|high/],
  ['eye', /아이\s*레벨|눈\s*높이|eye/],
];
const DIR_RULES = [
  ['ots', /오버\s*숄더|어깨\s*너머|\bots\b|over[\s-]*the[\s-]*shoulder/],
  ['back', /뒷\s*모습|후면|뒤에서|from\s*behind|\bback\b/],
  ['side', /측면|프로필|옆\s*모습|옆에서|profile|side/],
  ['ql', /3\/4|쿼터|three[\s-]*quarter/],
  ['front', /정면|front/],
];
const LEFT = /왼|좌측|좌로|\bleft\b/;
const lr = (s, l, r) => (LEFT.test(s) ? l : r);
const MOVE_RULES = [
  [/달리\s*줌|돌리\s*줌|버티고|vertigo|dolly\s*zoom/, () => 'dolly_zoom'],
  [/휩\s*팬|whip/, (s) => lr(s, 'whip_l', 'whip_r')],
  [/360/, () => 'orbit_360'],
  [/오빗|오비트|궤도|회전|아크|orbit|\barc\b/, (s) => lr(s, 'orbit_l', 'orbit_r')],
  [/드론|에어리얼|drone|aerial/, () => 'drone'],
  [/트래킹|팔로우|따라|추적|tracking|follow/, () => 'track'],
  [/달리\s*인|돌리\s*인|푸시|푸쉬|다가|push|dolly\s*in/, () => 'push'],
  [/달리\s*아웃|돌리\s*아웃|풀\s*아웃|풀\s*백|멀어|pull/, () => 'pull'],
  [/크레인\s*업|붐\s*업|상승|올라|crane\s*up|boom\s*up/, () => 'crane_up'],
  [/크레인\s*다운|붐\s*다운|하강|내려\s*오|crane\s*down|boom\s*down/, () => 'crane_down'],
  [/틸트\s*업|tilt\s*up/, () => 'tilt_up'],
  [/틸트\s*다운|tilt\s*down/, () => 'tilt_down'],
  [/트럭|트러킹|횡\s*이동|좌우|truck|slide|슬라이드/, (s) => lr(s, 'truck_l', 'truck_r')],
  [/팬|패닝|\bpan\b/, (s) => lr(s, 'pan_l', 'pan_r')],
  [/고정|스태틱|static|locked/, () => 'static'],
];

const first = (rules, s) => {
  for (const [v, re] of rules) if (re.test(s)) return v;
  return null;
};

/** Parse one line of shot description into generator params (unspecified fields fall back to `base`). */
export function parseShotText(line, project, base) {
  const s = line.toLowerCase();
  const p = { ...defaultParams(), ...base, handheld: false, dutch: false };
  const found = [];

  const size = first(SIZE_RULES, s);
  if (size) { p.size = size; found.push(SIZES[size].ko); }
  const angle = first(ANGLE_RULES, s);
  p.angle = angle || 'eye';
  if (angle) found.push(ANGLES[angle].ko);
  const dir = first(DIR_RULES, s);
  if (dir) { p.dir = dir; found.push(DIRS[dir].ko); }
  let move = null;
  for (const [re, fn] of MOVE_RULES) if (re.test(s)) { move = fn(s); break; }
  p.move = move || 'static';
  found.push(MOVES[p.move].ko);
  if (/천천히|느리게|슬로우|살짝|slow|subtle|gentle/.test(s)) p.speed = 'slow';
  else if (/빠르게|빠른|급하게|fast|quick|rapid/.test(s)) p.speed = 'fast';
  else p.speed = 'normal';
  if (/핸드\s*헬드|흔들|handheld|shaky/.test(s)) { p.handheld = true; found.push('핸드헬드'); }
  if (/더치|기울|dutch|canted/.test(s)) { p.dutch = true; found.push('더치'); }

  const mm = s.match(/(\d{2,3})\s*mm/);
  p.lens = mm ? +mm[1] : SIZES[p.size].lens;
  found.push(`${p.lens}mm`);
  const sec = s.match(/(\d+(?:\.\d+)?)\s*(초|sec|s\b)/);
  if (sec) p.duration = Math.min(60, Math.max(0.5, +sec[1]));
  found.push(`${p.duration}초`);

  // Subjects: match object names, longest first so "배우A2" beats "배우A".
  const byName = [...project.objects].filter((o) => o.name).sort((a, b) => b.name.length - a.name.length);
  const hits = [];
  let rest = s;
  for (const o of byName) {
    const n = o.name.toLowerCase();
    const idx = rest.indexOf(n);
    if (idx >= 0) {
      hits.push({ o, idx });
      rest = rest.slice(0, idx) + ' '.repeat(n.length) + rest.slice(idx + n.length);
    }
  }
  hits.sort((a, b) => a.idx - b.idx);
  if (hits[0]) p.subject = hits[0].o.id;
  p.subject2 = hits[1] ? hits[1].o.id : null;
  if (!project.objects.some((o) => o.id === p.subject)) {
    const actor = project.objects.find((o) => o.type === 'actor') || project.objects[0];
    p.subject = actor ? actor.id : null;
  }
  if ((p.dir === 'ots' || p.move.startsWith('whip')) && !p.subject2) {
    const other = project.objects.find((o) => o.type === 'actor' && o.id !== p.subject);
    if (other) p.subject2 = other.id;
  }
  const subjName = project.objects.find((o) => o.id === p.subject)?.name;
  return { params: p, summary: [subjName, ...found].filter(Boolean).join(' · ') };
}

// ---------------------------------------------------------------------------
// Prompt writing

function lensFeel(f) {
  if (f <= 20) return 'ultra-wide lens with strong perspective';
  if (f <= 28) return 'wide-angle lens';
  if (f <= 40) return 'natural wide-normal lens';
  if (f <= 60) return 'normal lens';
  if (f <= 100) return 'portrait telephoto lens, shallow depth of field, creamy bokeh';
  return 'long telephoto lens, compressed background, very shallow depth of field';
}

export function describeShot(shot, project, index) {
  const m = shot.meta || {};
  const keys = shot.keys;
  const f0 = keys[0]?.focal ?? 35;
  const f1 = keys[keys.length - 1]?.focal ?? f0;
  const sensor = SENSORS[project.sensor] || SENSORS.s35;
  const size = SIZES[m.size];
  const angle = ANGLES[m.angle];
  const dir = DIRS[m.dir];
  const move = MOVES[m.move] || (keys.length > 1 ? { ko: '커스텀 무브', en: 'custom camera move' } : MOVES.static);
  const speed = SPEED[m.speed] || SPEED.normal;
  const subj = project.objects.find((o) => o.id === m.subject);
  const lens = f0 === f1 ? `${Math.round(f0)}mm` : `${Math.round(f0)}→${Math.round(f1)}mm`;
  const aspect = (+project.aspect).toFixed(2).replace(/\.00$/, '');
  const lockName = shot.lookAt ? project.objects.find((o) => o.id === shot.lookAt.id)?.name : null;

  const ko = [
    `#${index + 1} ${shot.name}`,
    `${shot.duration}초`,
    size ? size.ko : null,
    angle && m.angle !== 'eye' ? angle.ko : null,
    dir ? dir.ko : null,
    move.ko,
    lens,
    shot.shake > 0 ? '핸드헬드' : null,
    lockName ? `타깃 고정: ${lockName}` : null,
    shot.desc ? `— ${shot.desc}` : null,
  ].filter(Boolean).join(' | ');

  const parts = [];
  parts.push(`Cinematic ${size ? size.en : 'shot'}`);
  if (angle && m.angle !== 'eye') parts.push(angle.en);
  else parts.push('eye-level');
  const onName = lockName || subj?.name;
  if (dir) parts.push(`${dir.en} angle${onName ? ` on ${onName}` : ''}`);
  const moveTxt = m.move === 'static' || (!m.move && keys.length < 2) ? move.en : `${speed.en} ${move.en}`;
  parts.push(moveTxt);
  if ((keys[0]?.roll || 0) !== 0) parts.push('Dutch tilt');
  if (shot.shake > 0) parts.push('handheld camera with subtle natural shake');
  if (lockName) parts.push('camera keeps the subject locked in frame');
  parts.push(`shot on ${lens} ${lensFeel(f1)}, ${sensor.en} sensor`);
  parts.push(`${aspect}:1 aspect ratio`);
  parts.push(`${shot.duration} seconds`);
  let en = parts.join(', ') + '.';
  if (shot.desc) en += ` Action: ${shot.desc.trim().replace(/[.。!?]+$/, '')}.`;
  if (project.style) en += ` ${project.style}`;
  return { ko, en };
}
