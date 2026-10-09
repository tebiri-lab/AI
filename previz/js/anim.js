// Keyframe evaluation for shot cameras and animated scene objects.
import * as THREE from 'three';

export const EASE = {
  linear: (u) => u,
  in: (u) => u * u * u,
  out: (u) => 1 - Math.pow(1 - u, 3),
  inout: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
};

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function catmull(p0, p1, p2, p3, s) {
  const s2 = s * s, s3 = s2 * s;
  return 0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s2 + (-p0 + 3 * p1 - 3 * p2 + p3) * s3);
}

function catmullVec(a, b, c, d, s) {
  return [0, 1, 2].map((i) => catmull(a[i], b[i], c[i], d[i], s));
}

export function sortKeys(keys) {
  keys.sort((a, b) => a.t - b.t);
  return keys;
}

// Returns the index of the segment containing time t and the local 0..1 parameter.
function locate(keys, t) {
  if (t <= keys[0].t) return { i: 0, s: 0 };
  const last = keys.length - 1;
  if (t >= keys[last].t) return { i: last - 1, s: 1 };
  for (let i = 0; i < last; i++) {
    if (t >= keys[i].t && t <= keys[i + 1].t) {
      const span = keys[i + 1].t - keys[i].t;
      return { i, s: span > 1e-6 ? (t - keys[i].t) / span : 1 };
    }
  }
  return { i: last - 1, s: 1 };
}

// Deterministic smooth pseudo-noise for handheld shake.
function wobble(t, seed) {
  return (
    Math.sin(t * 1.7 + seed) * 0.5 +
    Math.sin(t * 3.1 + seed * 2.3) * 0.3 +
    Math.sin(t * 7.3 + seed * 4.1) * 0.15 +
    Math.sin(t * 13.7 + seed * 1.3) * 0.05
  );
}

export function sampleCamera(shot, t, withShake = true) {
  const keys = shot.keys;
  if (!keys.length) {
    return { pos: new THREE.Vector3(0, 1.6, 5), target: new THREE.Vector3(0, 1.5, 0), focal: 35, roll: 0 };
  }
  let out;
  if (keys.length === 1) {
    const k = keys[0];
    out = { pos: v3(k.pos), target: v3(k.target), focal: k.focal, roll: k.roll || 0 };
  } else {
    const t0 = keys[0].t, t1 = keys[keys.length - 1].t;
    let tt = t;
    if (t1 > t0 && t > t0 && t < t1) {
      tt = t0 + (EASE[shot.ease] || EASE.linear)((t - t0) / (t1 - t0)) * (t1 - t0);
    }
    const { i, s } = locate(keys, tt);
    const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
    out = {
      pos: v3(catmullVec(k0.pos, k1.pos, k2.pos, k3.pos, s)),
      target: v3(catmullVec(k0.target, k1.target, k2.target, k3.target, s)),
      focal: k1.focal + (k2.focal - k1.focal) * s,
      roll: (k1.roll || 0) + ((k2.roll || 0) - (k1.roll || 0)) * s,
    };
  }
  const shake = shot.shake || 0;
  if (withShake && shake > 0) {
    const a = 0.035 * shake;
    out.pos.x += wobble(t, 1) * a;
    out.pos.y += wobble(t, 2) * a * 0.8;
    out.pos.z += wobble(t, 3) * a;
    out.target.x += wobble(t, 4) * a * 1.6;
    out.target.y += wobble(t, 5) * a * 1.6;
    out.target.z += wobble(t, 6) * a * 1.6;
    out.roll += wobble(t, 7) * 1.2 * shake;
  }
  return out;
}

function lerpAngle(a, b, s) {
  let d = ((b - a + 540) % 360) - 180;
  return a + d * s;
}

// Objects can be attached to a parent (e.g. a drummer on a floating slab). Transforms in
// o.pos / object keys are then relative to the parent. The registry is set by the app.
let REG = [];
export function setObjects(list) { REG = list || []; }
const byId = (id) => REG.find((o) => o.id === id);
const D2R = Math.PI / 180;

/** Ancestors of an object, nearest first (cycle-safe). */
export function ancestors(obj) {
  const out = [];
  let cur = obj.parent ? byId(obj.parent) : null;
  while (cur && out.length < 8 && !out.includes(cur) && cur !== obj) {
    out.push(cur);
    cur = cur.parent ? byId(cur.parent) : null;
  }
  return out;
}

// Object transform at time t in its parent's space: base transform unless the shot animates it.
export function sampleLocal(obj, shot, t) {
  const keys = shot && shot.anim && shot.anim[obj.id];
  if (!keys || !keys.length) {
    return { pos: obj.pos.slice(), rotY: obj.rotY, dist: 0, speed: 0 };
  }
  if (keys.length === 1) {
    return { pos: keys[0].pos.slice(), rotY: keys[0].rotY, dist: 0, speed: 0 };
  }
  const { i, s } = locate(keys, t);
  const a = keys[i], b = keys[i + 1];
  const u = (EASE[a.ease] || EASE.linear)(s);
  const pos = [0, 1, 2].map((j) => a.pos[j] + (b.pos[j] - a.pos[j]) * u);
  let dist = 0;
  for (let j = 0; j < i; j++) dist += v3(keys[j].pos).distanceTo(v3(keys[j + 1].pos));
  const segLen = v3(a.pos).distanceTo(v3(b.pos));
  dist += segLen * u;
  const span = b.t - a.t;
  const moving = t > keys[0].t && t < keys[keys.length - 1].t;
  return { pos, rotY: lerpAngle(a.rotY, b.rotY, u), dist, speed: moving && span > 0 ? segLen / span : 0 };
}

function compose(parentS, local) {
  const a = parentS.rotY * D2R, c = Math.cos(a), sn = Math.sin(a);
  const [x, y, z] = local.pos;
  return {
    pos: [parentS.pos[0] + x * c + z * sn, parentS.pos[1] + y, parentS.pos[2] - x * sn + z * c],
    rotY: parentS.rotY + local.rotY,
    dist: local.dist,
    speed: local.speed,
  };
}

// World transform of an object at time t (parents applied).
export function sampleObject(obj, shot, t) {
  let s = sampleLocal(obj, shot, t);
  for (const p of ancestors(obj)) s = compose(sampleLocal(p, shot, t), s);
  return s;
}

/** Convert a world position/rotation into obj's parent space at (shot, t). */
export function worldToLocal(obj, shot, t, pos, rotY) {
  const p = obj.parent ? byId(obj.parent) : null;
  if (!p) return { pos: pos.slice(), rotY };
  const ps = sampleObject(p, shot, t);
  const a = ps.rotY * D2R, c = Math.cos(a), sn = Math.sin(a);
  const dx = pos[0] - ps.pos[0], dy = pos[1] - ps.pos[1], dz = pos[2] - ps.pos[2];
  return { pos: [dx * c - dz * sn, dy, dx * sn + dz * c], rotY: rotY - ps.rotY };
}

/** True when the object or any ancestor has keys in this shot. */
export function isAnimated(obj, shot) {
  if (shot?.anim?.[obj.id]?.length) return true;
  return ancestors(obj).some((p) => shot?.anim?.[p.id]?.length);
}

export function keyIndexAt(keys, t, tol) {
  return keys.findIndex((k) => Math.abs(k.t - t) <= tol);
}

// Live target of a shot whose camera is locked onto a (possibly moving) object.
export function lockTarget(shot, objects, t) {
  const lock = shot.lookAt;
  if (!lock) return null;
  const o = objects.find((x) => x.id === lock.id);
  if (!o) return null;
  const s = sampleObject(o, shot, t);
  return new THREE.Vector3(s.pos[0] + lock.offset[0], s.pos[1] + lock.offset[1], s.pos[2] + lock.offset[2]);
}

// Camera sample with the look-at lock applied (handheld shake still rides on top).
export function resolveCamera(shot, t, objects, withShake = true) {
  const out = sampleCamera(shot, t, withShake);
  const lt = lockTarget(shot, objects, t);
  if (lt) {
    if (withShake && shot.shake > 0) out.target = lt.add(out.target.sub(sampleCamera(shot, t, false).target));
    else out.target = lt;
  }
  return out;
}
