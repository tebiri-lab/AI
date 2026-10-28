import * as THREE from 'three';

// Cymbal physics for the drum kits.
// Each cymbal is a rigid plate on its stand's tilter: it swings about two axes in its own plane with a felt spring
// and damping (a crash rocks and rings out for a second or two; a clutched hi-hat barely moves). Drumsticks are
// kinematic capsules driven by the keyframed arms. Every 1/240 s step the plate integrates its swing, then each
// stick touching it pushes it out of the way (position-based contact: no stick can pass through a plate), and the
// push becomes the plate's velocity. A stick arriving at a plate also hands over the speed it came in with, so
// crashes swing on a hit. The simulation is deterministic: it always starts at rest one second before the shot and
// steps forward on a fixed clock; scrubbing backwards re-simulates from there.

const DT = 1 / 240;
const PREROLL = 1.0;          // seconds simulated before the shot starts
const STICK_R = 0.011;        // stick radius (butt end) in m
const SAMPLES = 25;           // points along each stick
const MAX_TILT = 0.6;         // rad
const TOUCH = 0.004;          // a stick this close (m) counts as striking the plate
const WMAX = 3.2;             // rad/s: the most swing a hit can give a plate (a hard crash rocks ~20 deg)
const KINDS = {
  crash: { f0: 1.5, zeta: 0.08, kick: 0.15 },
  hihat: { f0: 6.0, zeta: 0.45, kick: 0.08 },
};

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _qo = new THREE.Quaternion(), _e = new THREE.Euler();
const _n = new THREE.Vector3(), _ex = new THREE.Vector3(), _ez = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _qr = new THREE.Vector3(), _u = new THREE.Vector3();

// cone surface of the plate mesh (CylinderGeometry(r, 0.15 r, 0.025)): height above the pivot plane at radius rho
const surface = (rho, r) => -0.0125 + 0.025 * Math.min(1, Math.max(0, (rho - 0.15 * r) / (0.85 * r)));

export class CymbalPhysics {
  constructor() {
    this.state = null;        // { key, clock, cym: Map(plate -> {a, b, wa, wb}), mem: Map }
  }

  reset() { this.state = null; }

  /**
   * Bring the simulation to song time `clock` for this shot. `poseAt(clockTime)` must pose every object for that
   * song time (without physics); `groups` lists the scene groups (kits and actors) to look at.
   */
  update(key, clock, clock0, poseAt, groups) {
    const kits = groups.filter((g) => g.visible && g.userData.cymbals?.length);
    if (!kits.length) { this.state = null; return; }
    let st = this.state;
    const fresh = kits.some((k) => k.userData.cymbals.some((c) => !st?.cym.has(c.plate)));
    if (!st || fresh || st.key !== key || clock < st.clock - 1e-6) {
      st = this.state = { key, clock: clock0 - PREROLL, cym: new Map(), mem: new Map() };
      for (const k of kits) for (const c of k.userData.cymbals) st.cym.set(c.plate, { a: 0, b: 0, wa: 0, wb: 0 });
    }
    const actors = groups.filter((g) => g.visible && g.userData.rig?.elL?.userData.stick);
    const live = kits.concat(actors);
    const n = Math.min(4000, Math.round((clock - st.clock) / DT));
    for (let i = 1; i <= n; i++) {
      const tc = i === n ? clock : st.clock + DT;
      poseAt(tc);
      this.step(st, kits, live);
      st.clock = tc;
    }
    if (n <= 0) poseAt(clock);
    this.apply(st, kits);
  }

  apply(st, kits) {
    for (const k of kits) for (const c of k.userData.cymbals) {
      const s = st.cym.get(c.plate);
      if (s) c.plate.rotation.set(s.a, 0, s.b);
    }
  }

  sticks(groups) {
    const out = [];
    for (const g of groups) {
      const r = g.visible && g.userData.rig;
      if (!r) continue;
      for (const fa of [r.elL, r.elR]) {
        const s = fa?.userData.stick;
        if (!s || !s.visible) continue;
        s.updateMatrixWorld(true);
        const a = s.localToWorld(new THREE.Vector3(0, -0.205, 0));
        const b = s.localToWorld(new THREE.Vector3(0, 0.205, 0));
        out.push({ id: s.uuid, a, b });
      }
    }
    return out;
  }

  step(st, kits, groups) {
    for (const g of groups) if (g.visible) g.updateMatrixWorld(true);
    const sticks = this.sticks(groups);
    for (const k of kits) {
      for (const c of k.userData.cymbals) {
        const s = st.cym.get(c.plate);
        if (!s) continue;
        const P = KINDS[c.kind] || KINDS.crash;
        const w0 = 2 * Math.PI * P.f0;
        const a0 = s.a, b0 = s.b;
        // 1) free swing: spring back to rest, damped
        s.wa += (-w0 * w0 * s.a - 2 * P.zeta * w0 * s.wa) * DT;
        s.wb += (-w0 * w0 * s.b - 2 * P.zeta * w0 * s.wb) * DT;
        s.a += s.wa * DT; s.b += s.wb * DT;
        // 2) contacts: push the plate clear of every stick, on the side the stick is on
        for (let it = 0; it < 3; it++) {
          let moved = false;
          for (const sk of sticks) if (this.contact(st, s, c, sk, P, it === 0)) moved = true;
          if (!moved) break;
        }
        s.a = Math.max(-MAX_TILT, Math.min(MAX_TILT, s.a));
        s.b = Math.max(-MAX_TILT, Math.min(MAX_TILT, s.b));
        // 3) the plate keeps the velocity the pushes gave it (capped: a stick resting on it must not fling it)
        s.wa = (s.a - a0) / DT; s.wb = (s.b - b0) / DT;
        const w = Math.hypot(s.wa, s.wb);
        if (w > WMAX) { s.wa *= WMAX / w; s.wb *= WMAX / w; }
      }
    }
    for (const sk of sticks) {
      const m = st.mem.get(sk.id) || {};
      m.prevA = sk.a.clone(); m.prevB = sk.b.clone();
      st.mem.set(sk.id, m);
    }
  }

  frame(c, s) {
    c.pivot.getWorldPosition(_c);
    c.pivot.getWorldQuaternion(_q);
    _qo.setFromEuler(_e.set(s.a, 0, s.b));
    _q.multiply(_qo);
    _n.set(0, 1, 0).applyQuaternion(_q);
    _ex.set(1, 0, 0).applyQuaternion(_q);
    _ez.set(0, 0, 1).applyQuaternion(_q);
  }

  // One stick against one plate. Returns true if it moved the plate.
  contact(st, s, c, sk, P, first) {
    this.frame(c, s);
    const mkey = sk.id + '|' + c.plate.uuid;
    const mem = st.mem.get(mkey) || { side: 0, touching: false, vmax: 0 };
    const skm = st.mem.get(sk.id);
    let best = null, nearest = null, firstRel = null, crossed = false, lastRel = null;
    const p = new THREE.Vector3(), pp = new THREE.Vector3();
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1);
      p.copy(sk.a).lerp(sk.b, t);
      _d.copy(p).sub(_c);
      const h = _d.dot(_n);
      _qr.copy(_d).addScaledVector(_n, -h);
      const rho = _qr.length();
      const rad = STICK_R * (1 - 0.27 * t);
      if (rho > c.r + rad) { lastRel = null; continue; }
      const inside = rho <= c.r;
      let rel, pen, dir;
      if (inside) {
        rel = h - surface(rho, c.r);
        if (lastRel !== null && Math.sign(rel) !== Math.sign(lastRel)) crossed = true;
        lastRel = rel;
        if (firstRel === null) firstRel = rel;
        dir = mem.side;
        pen = mem.side ? rad - mem.side * rel : -1;
      } else {                                   // just outside the rim: its round edge pushes the way it is touched
        const dy = h - surface(c.r, c.r);
        const dist = Math.hypot(rho - c.r, dy);
        rel = (Math.sign(dy) || 1) * dist;
        dir = Math.sign(dy) || 1;
        pen = rad - dist;
        lastRel = null;
      }
      if (!nearest || Math.abs(rel) < Math.abs(nearest.rel)) nearest = { rel };
      // approach speed of this point toward the plate (for the hit kick)
      if (first && skm?.prevA) {
        pp.copy(skm.prevA).lerp(skm.prevB, t);
        const vn = -((p.x - pp.x) * _n.x + (p.y - pp.y) * _n.y + (p.z - pp.z) * _n.z) / DT * (mem.side || 1);
        if (vn > mem.vmax) mem.vmax = vn;
      }
      if (pen > -TOUCH && dir && (!best || pen > best.pen)) {
        best = { pen, dir, rho: Math.max(inside ? rho : c.r, 0.25 * c.r), q: _qr.clone().normalize() };
      }
    }
    if (first) mem.vmax *= Math.exp(-DT / 0.06);
    // which side of the plate the stick is on: taken from its hand end when first met, then kept while it touches
    if (!mem.side) mem.side = firstRel !== null ? Math.sign(firstRel) || 1 : nearest ? Math.sign(nearest.rel) || 1 : 0;
    else if (nearest && !best && !crossed && Math.abs(nearest.rel) > STICK_R * 1.5) mem.side = Math.sign(nearest.rel);
    let moved = false;
    if (best) {
      // rotate the plate about the in-plane axis across the contact so the surface there moves away from the stick
      _u.copy(best.q).cross(_n).multiplyScalar(-best.dir);
      let delta = Math.max(0, best.pen) / best.rho;
      if (!mem.touching && first) delta += (P.kick * mem.vmax / best.rho) * DT;   // momentum of the arriving stick
      s.a += delta * _u.dot(_ex);
      s.b += delta * _u.dot(_ez);
      moved = delta > 0;
      mem.touching = true;
    } else if (first) mem.touching = false;
    st.mem.set(mkey, mem);
    return moved;
  }
}
