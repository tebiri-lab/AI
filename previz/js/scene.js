// Three.js scene construction: mannequins, props, ground, lighting presets and the camera rig.
import * as THREE from 'three';
import { POSE_SETS } from './constants.js';

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...extra });
const _leanAxis = new THREE.Vector3();

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function capsule(r, len, mat) {
  return shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 12), mat));
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '600 44px system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  c.width = w; c.height = 72;
  ctx.font = font;
  ctx.fillStyle = 'rgba(12,14,18,0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 72, 18);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 18, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((w / 72) * 0.28, 0.28, 1);
  sprite.renderOrder = 10;
  sprite.userData.directorOnly = true;
  return sprite;
}

// Seeded random so procedural props look the same on every rebuild.
function rng(seedStr) {
  let h = 1779033703 ^ String(seedStr).length;
  for (let i = 0; i < String(seedStr).length; i++) {
    h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One limb segment: a pivot at the joint with the capsule hanging down from it.
function segment(parent, x, y, r, len, mat) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, 0);
  const m = capsule(r, len, mat);
  m.position.y = -(len / 2 + r);
  pivot.add(m);
  parent.add(pivot);
  return pivot;
}

function buildHold(kind, spine, forearms) {
  if (kind === 'guitar' || kind === 'bass') {
    const bass = kind === 'bass';
    const g = new THREE.Group();
    const bodyMat = std(bass ? '#2b2b2e' : '#d9d2c2', { roughness: 0.35 });
    const neckMat = std('#6b4a2f');
    const body = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.05, 20), bodyMat));
    body.rotation.x = Math.PI / 2;
    body.scale.set(1, 1, bass ? 1.3 : 1.15);
    g.add(body);
    const len = bass ? 0.86 : 0.62;
    const neck = shadowed(new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.03), neckMat));
    neck.position.x = len / 2 + 0.12;
    g.add(neck);
    const headstock = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.03), bodyMat));
    headstock.position.x = len + 0.18;
    g.add(headstock);
    g.rotation.z = 0.5; // neck rises toward the player's left
    g.position.set(-0.05, 0.02, 0.17);
    spine.add(g);
  } else if (kind === 'sticks') {
    const mat = std('#d8c39a');
    for (const fa of forearms) {
      const st = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.011, 0.41, 8), mat));
      const d = new THREE.Vector3(0, -0.5, 0.866);
      st.position.set(0, -0.3, 0).addScaledVector(d, 0.17);
      st.rotation.x = 2.094;
      fa.add(st);
      fa.userData.stick = st;
    }
  }
}

// A 1.75 m mannequin with knees, elbows, a bendable spine and a head that can look up.
function buildActor(o) {
  const g = new THREE.Group();
  const body = std(o.color);
  const dark = std(new THREE.Color(o.color).multiplyScalar(0.55));
  const skin = std('#e8c4a0');
  const rig = new THREE.Group();
  g.add(rig);
  const root = new THREE.Group();
  rig.add(root);

  const pelvis = capsule(0.13, 0.12, dark);
  pelvis.rotation.z = Math.PI / 2;
  pelvis.position.y = 0.95;
  root.add(pelvis);

  const spine = new THREE.Group();
  spine.position.y = 0.95;
  root.add(spine);
  const torso = capsule(0.16, 0.34, body);
  torso.position.y = 0.29;
  torso.scale.z = 0.72;
  spine.add(torso);

  const headG = new THREE.Group();
  headG.position.y = 0.53;
  spine.add(headG);
  const neck = capsule(0.05, 0.06, skin);
  neck.position.y = 0.02;
  headG.add(neck);
  const head = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.108, 20, 16), skin));
  head.scale.set(0.9, 1.08, 1);
  head.position.y = 0.155;
  headG.add(head);
  // nose + eyes give a readable facing direction from any angle
  const nose = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 8), skin));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.15, 0.11);
  headG.add(nose);
  const eyeMat = std('#222');
  for (const x of [-0.037, 0.037]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), eyeMat);
    eye.position.set(x, 0.18, 0.095);
    headG.add(eye);
  }

  const hipL = segment(root, 0.1, 0.93, 0.075, 0.31, dark);
  const hipR = segment(root, -0.1, 0.93, 0.075, 0.31, dark);
  const kneeL = segment(hipL, 0, -0.44, 0.062, 0.32, dark);
  const kneeR = segment(hipR, 0, -0.44, 0.062, 0.32, dark);
  for (const knee of [kneeL, kneeR]) {
    const foot = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.24), dark));
    foot.position.set(0, -0.43, 0.05);
    knee.add(foot);
  }
  const shL = segment(spine, 0.225, 0.47, 0.05, 0.2, body);
  const shR = segment(spine, -0.225, 0.47, 0.05, 0.2, body);
  const elL = segment(shL, 0, -0.29, 0.045, 0.19, body);
  const elR = segment(shR, 0, -0.29, 0.045, 0.19, body);
  const hands = [];
  for (const el of [elL, elR]) {
    const hand = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), skin));
    hand.position.y = -0.3;
    hand.scale.set(0.8, 1.1, 0.6);
    el.add(hand);
    hands.push(hand);
  }
  if (o.hold && o.hold !== 'none') buildHold(o.hold, spine, [elL, elR]);

  const s = (o.height || 1.75) / 1.75;
  rig.scale.setScalar(s);
  g.userData.rig = { root, spine, headG, hipL, hipR, kneeL, kneeR, shL, shR, elL, elR, handL: hands[0], handR: hands[1], torso, pelvis, scale: s };
  const label = makeLabel(o.name);
  label.position.y = (o.height || 1.75) + 0.3;
  g.add(label);
  return g;
}

// Joint angles in radians. sh = [L.x, L.z, R.x, R.z]; negative x swings a limb forward,
// positive knee bends the shin back, negative head looks up, positive lean bends forward.
const POSE_DEF = {
  stand: { walk: true },
  // Sprint: stride pair of 4 m of travel, so a slow-motion runner (small keyed distance) cycles slowly.
  run: { run: true, lean: 0.32, head: -0.2, stride: 4, phase: 1.2 },
  field_ready: { drop: -0.14, hip: [-0.5, -0.5], knee: [0.75, 0.75], lean: 0.5, head: -0.45, sh: [-0.55, 0.3, -0.55, -0.3], el: [-0.55, -0.55] },
  throw: { drop: -0.06, hip: [-0.85, 0.45], knee: [0.45, 0.35], lean: 0.18, head: -0.1, sh: [-1.25, 0.25, -2.7, -0.45], el: [-0.5, -1.45] },
  catcher: { drop: -0.5, hip: [-1.6, -1.6], knee: [1.95, 1.95], lean: 0.22, head: -0.15, sh: [-1.15, 0.35, -0.45, -0.2], el: [-0.85, -0.3] },
  look_up: { walk: true, head: -0.6 },
  sit: { drop: -0.4, hip: [-1.57, -1.57], knee: [1.57, 1.57], sh: [-0.55, 0.12, -0.55, -0.12], el: [-0.2, -0.2] },
  drum: { drop: -0.4, hip: [-1.45, -1.45], knee: [1.6, 1.6], lean: 0.12, head: 0.12, sh: [-0.5, 0.18, -0.5, -0.18], el: [-1.0, -1.0], beat: 'drum' },
  drum_fill: { drop: -0.4, hip: [-1.45, -1.45], knee: [1.6, 1.6], lean: 0.2, head: 0.42, turn: -0.4, sh: [-0.55, 0.1, -0.6, -0.3], el: [-0.95, -0.9], beat: 'drum' },
  // eyes on the toms, then (45%→70% of the shot) the head comes up to face straight ahead
  drum_look: { drop: -0.4, hip: [-1.45, -1.45], knee: [1.6, 1.6], lean: 0.2, head: 0.42, turn: -0.4, sh: [-0.55, 0.1, -0.6, -0.3], el: [-0.95, -0.9], beat: 'drum', look: [0.45, 0.7] },
  // Count-in: sticks raised in front of the face and crossed; twist = forearm roll [L, R] so the sticks
  // point inward; click = how far the arms swing in on each beat (beat-locked, so it lands on the count).
  count: { drop: -0.4, hip: [-1.45, -1.45], knee: [1.6, 1.6], lean: 0.02, head: -0.04, sh: [-1.7, 0.22, -1.7, -0.22], el: [-1.2, -1.2], twist: [-1.2, 1.2], click: 0.3, clickLR: [0, 1.3], hitBeat: 63, lift: [-2.35, 0.45], hit: [-0.68, 0.3, -0.9] },
  sticks_up: { drop: -0.4, hip: [-1.45, -1.45], knee: [1.6, 1.6], lean: -0.08, head: -0.25, sh: [-2.45, 0.32, -2.45, -0.32], el: [-0.95, -0.95] },
  kneel: { drop: -0.45, hip: [-1.45, 0.05], knee: [1.45, 1.52], lean: 0.12, sh: [-0.75, 0.12, -0.15, -0.42], el: [-0.55, -0.1] },
  kneel_up: { drop: -0.45, hip: [-1.45, 0.05], knee: [1.45, 1.52], lean: 0.05, head: -0.6, sh: [-1.1, 0.15, -0.15, -0.42], el: [-0.3, -0.1] },
  guitar: { walk: false, sh: [-0.65, 0.45, -0.3, 0.12], el: [-1.0, -1.25], beat: 'strum' },
  keys: { lean: 0.1, head: 0.18, sh: [-0.6, -0.06, -0.6, 0.06], el: [-0.85, -0.85], beat: 'keys' },
  // Full-energy playing for the drop: big strokes plus a groove (head nod, body bounce) on every beat.
  drum_rock: { drop: -0.4, hip: [-1.45, -1.45], knee: [1.6, 1.6], lean: 0.12, head: 0.12, sh: [-0.5, 0.18, -0.5, -0.18], el: [-1.0, -1.0], beat: 'drum_hard', groove: 1 },
  guitar_rock: { walk: false, sh: [-0.65, 0.45, -0.3, 0.12], el: [-1.0, -1.25], beat: 'strum_hard', groove: 1 },
  keys_rock: { lean: 0.1, head: 0.18, sh: [-0.6, -0.06, -0.6, 0.06], el: [-0.85, -0.85], beat: 'keys_hard', groove: 1 },
  // K4: the left stick crashes the big left crash cymbal on crashBeats (beat index from the first downbeat),
  // springs back up high between hits; the right stick hits the snare on the other beats.
  drum_crash: { drop: -0.4, hip: [-1.45, -1.45], knee: [1.6, 1.6], lean: 0.12, head: 0.05, sh: [-0.5, 0.18, -0.5, -0.18], el: [-1.0, -1.0],
    beat: 'crash_play', groove: 0.7, crashBeats: [67, 69, 71], crashUp: [-2.6, 0.4, -0.5], crashHit: [-1.45, 0.55, -0.35],
    rolls: [[68.15, 68.55], [69.05, 69.85], [71.35, 71.9]] },
  // K4 played exactly as the drum score (bars from beat 67): crashes L(K crash, his left) / R(EFX, his right),
  // the tom fill on beat 3-4 (hi tom 32nds-16ths, mid, floor, floor), then bar 2 crashes and the snare sextuplets.
  drum_score67: {
    // K4 re-timed to Gunil's live performance of this bar (v22, 1016_12 fancam synced to the song), beats from 67:
    // L crashes the K at 67 and 71 (and again at 71.55 from the rebound), each time springing up high off the rim;
    // R winds up high (hand over his head) and comes down on the EFX at 68.25, 70.8 and 72.25; in between both
    // sticks play groove strokes on the rack toms, a tom fill at 69.5-70.15 runs into the floor tom, and the head
    // lifts after each crash, nods on the beats and bows into the fill (headKeys). The big right crash is never hit.
    // Each entry: [beat, shX, shZ, elX, elY (forearm roll), wrist deg, flag?] (flag 1 = hover, 3 = shaped stroke,
    // 4 = hit: accelerating downstroke, lift scale in [7]). Poses: previz/live22_solve*.py, keys: live22_build.py,
    // checked with live22_check.py (no plate crossings, big crash 12+ cm clear, face clear from the #12 camera).
    // Cymbals swing on hits and are pushed aside by any stick that touches them: js/physics.js.
    drop: -0.4, hip: [-1.45, -1.45], knee: [1.6, 1.6], lean: 0.12, head: 0.05, sh: [-0.5, 0.18, -0.5, -0.18], el: [-1.0, -1.0],
    beat: 'strokes', groove: 0,
    strokes: {
      L: [
          [66.4, -0, 0.5764, -2.2272, -2.4794, 41.9916],
          [66.75, -0.657, 0.1769, -1.9633, -4.1715, 53.2629, 1],
          [67, -0.6604, 0.1783, -1.9004, -4.1556, 85.1514, 4, 0],
          [67.1, -0.4047, 0.185, -2.4318, -4.1382, 88.5042, 1],
          [67.35, -1.0707, 1.1591, -1.9704, -4.6025, 53.0967],
          [67.5, -0.657, 0.1769, -1.9633, -4.1715, 53.2629, 1],
          [67.62, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 0],
          [68, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 1.6],
          [68.5, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 1.6],
          [69, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 1.6],
          [69.25, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 1],
          [69.5, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 0.9],
          [69.75, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 0.9],
          [70.27, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 1.2],
          [70.6, 0.1565, 0.6128, -2.4404, -3.1609, 52.3309, 1],
          [70.8, -0.657, 0.1769, -1.9633, -4.1715, 53.2629, 1],
          [71, -0.6604, 0.1783, -1.9004, -4.1556, 85.1514, 4, 0],
          [71.1, -0.4047, 0.185, -2.4318, -4.1382, 88.5042, 1],
          [71.32, -1.0707, 1.1591, -1.9704, -4.6025, 53.0967],
          [71.55, -0.6604, 0.1783, -1.9004, -4.1556, 85.1514, 4, 0],
          [71.65, -0.4047, 0.185, -2.4318, -4.1382, 88.5042, 1],
          [71.95, 0.1565, 0.6128, -2.4404, -3.1609, 52.3309, 1],
          [72.15, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 0.8],
          [72.5, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 1.6],
          [73, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 1.6],
          [73.5, -0, 0.5764, -2.2272, -2.4794, 41.9916, 4, 1.6],
          [73.9, 0.1565, 0.6128, -2.4404, -3.1609, 52.3309, 1]],
      R: [
          [66.4, -0.0115, -0.6055, -2.2399, 2.4762, 42.1049],
          [67, 0.4445, -0.8772, -2.2563, 3.4265, 67.3872, 4, 0.8],
          [67.3, -0.004, -0.6396, -2.5894, 2.4482, 41.0998],
          [67.55, -0.004, -0.6396, -2.5894, 2.4482, 41.0998, 1],
          [67.78, -0.9412, -0.1775, -2.4661, 3.3487, 13.1097],
          [68.05, -1.7216, -1.3065, -1.8248, 4.3495, 44.8798],
          [68.25, -0.269, -0.898, -1.032, 4.603, 44.873, 4, 0],
          [68.35, 0.1286, -1.4, -1.5112, 4.2573, 62.6028, 1],
          [68.62, -0.004, -0.6396, -2.5894, 2.4482, 41.0998],
          [68.75, -0.0115, -0.6055, -2.2399, 2.4762, 42.1049, 4, 0.8],
          [69.25, -0.0115, -0.6055, -2.2399, 2.4762, 42.1049, 4, 1.6],
          [69.625, -0.0115, -0.6055, -2.2399, 2.4762, 42.1049, 4, 0.9],
          [69.875, -0.0115, -0.6055, -2.2399, 2.4762, 42.1049, 4, 0.9],
          [70, 0.4445, -0.8772, -2.2563, 3.4265, 67.3872, 4, 0.7],
          [70.15, 0.4445, -0.8772, -2.2563, 3.4265, 67.3872, 4, 0.8],
          [70.24, -0.004, -0.6396, -2.5894, 2.4482, 41.0998, 1],
          [70.36, -0.9412, -0.1775, -2.4661, 3.3487, 13.1097],
          [70.6, -1.7216, -1.3065, -1.8248, 4.3495, 44.8798],
          [70.8, -0.269, -0.898, -1.032, 4.603, 44.873, 4, 0],
          [70.9, 0.1286, -1.4, -1.5112, 4.2573, 62.6028, 1],
          [71.2, -0.004, -0.6396, -2.5894, 2.4482, 41.0998],
          [71.5, -0.0115, -0.6055, -2.2399, 2.4762, 42.1049, 4, 0.8],
          [71.62, -0.004, -0.6396, -2.5894, 2.4482, 41.0998, 1],
          [71.78, -0.9412, -0.1775, -2.4661, 3.3487, 13.1097],
          [72.05, -1.7216, -1.3065, -1.8248, 4.3495, 44.8798],
          [72.25, -0.269, -0.898, -1.032, 4.603, 44.873, 4, 0],
          [72.35, 0.1286, -1.4, -1.5112, 4.2573, 62.6028, 1],
          [72.62, -0.004, -0.6396, -2.5894, 2.4482, 41.0998],
          [72.75, -0.0115, -0.6055, -2.2399, 2.4762, 42.1049, 4, 0.8],
          [73.25, -0.0115, -0.6055, -2.2399, 2.4762, 42.1049, 4, 1.6],
          [73.75, -0.0115, -0.6055, -2.2399, 2.4762, 42.1049, 4, 1.6]],
    },
    headKeys: [[66.4, 0, 0, 0], [67, 0.03, 0, 0], [67.25, -0.25, 0.05, -0.06], [67.6, 0.05, 0, 0], [68, 0.14, 0, 0], [68.25, 0, -0.14, 0.03], [68.5, 0.12, 0, 0], [68.75, 0.02, 0, 0], [69, 0.14, 0, 0], [69.25, 0.06, 0, 0], [69.5, 0.32, -0.04, 0], [70.1, 0.42, -0.1, 0], [70.4, 0.18, -0.16, 0.04], [70.8, 0.08, -0.16, 0], [71, 0.03, 0.04, 0], [71.25, -0.18, 0.06, -0.05], [71.6, 0.05, 0, 0], [72, 0.14, 0, 0], [72.25, 0, -0.14, 0.03], [72.5, 0.12, 0, 0], [73, 0.14, 0, 0], [73.5, 0.12, 0, 0], [74, 0.08, 0, 0]],
    kicks: [67, 67.32, 67.8, 68.32, 68.57, 69.09, 69.68, 70.07, 70.32, 70.57, 70.8, 71.07, 71.34, 71.57, 72, 72.32, 72.8, 73.32],
  },
  hold: { head: 0.1, sh: [-1.05, -0.3, -1.05, 0.3], el: [-1.65, -1.65] },
  hug: { head: 0.25, lean: 0.12, sh: [-0.85, -0.45, -0.85, 0.45], el: [-1.35, -1.35] },
  reach_up: { head: -0.45, sh: [-2.6, 0.2, 0, -0.08], el: [-0.2, 0] },
  // One arm pulled up by the balloon string over the shot: armL / armR = [[shX, shZ, el] from, to],
  // in that arm's own convention (positive shZ swings the left arm outward, negative the right).
  pull_walk: { walk: true, lin: true, armL: [[-0.9, 0, -0.7], [-1.45, -0.1, -0.6]] },
  // Continues from pull_walk's end pose; wrap = [start, end, elbow flex] as fractions of the shot.
  pull_wrap: { walk: true, head: -0.15, armL: [[-1.45, -0.1, -0.6], [-1.75, -0.1, -0.5]], wrap: [0.2, 0.55, 0.6] },
  // Keyed left arm [u, shX, shZ, el] (u = fraction of the shot): reach up the string, grip, tug down.
  // grip = [from, to] the hand closes into a fist; gaze = [from, to, head angle] he looks up at the balloon.
  pull_grip: {
    walk: true,
    armLKeys: [[0, -1.45, -0.1, -0.6], [0.15, -1.45, -0.1, -0.6], [0.32, -1.95, -0.12, -0.2], [0.44, -1.2, -0.1, -0.75], [1, -1.2, -0.1, -0.75]],
    grip: [0.3, 0.37],
    gaze: [0.4, 0.6, -0.75],
  },
  // #9: the arm keeps rising at the same angular speed as pull_walk (0.11 rad/s on a 4 s shot); he stops and looks up (1.1-1.7 s).
  pull_rise: { walk: true, lin: true, armLKeys: [[0, -1.45, -0.1, -0.6], [1, -1.89, -0.1, -0.52]], gaze: [0.275, 0.425, -0.75] },
  dissolve: { head: -0.12, dissolve: { start: 0.22, end: 0.92 } },
};

// Disintegration into drifting ash, starting at the shoulders. Parts shrink away in order
// while flakes peel off them and blow downwind. Pure function of progress p (scrub-safe).
const DISSOLVE_PARTS = [
  // [rig key, delay, flake region: [x0, x1, y0, y1]] in actor space (1.75 m figure)
  ['shL', 0.0, [0.18, 0.32, 0.85, 1.45]],
  ['shR', 0.08, [-0.32, -0.18, 0.85, 1.45]],
  ['torso', 0.16, [-0.17, 0.17, 1.0, 1.45]],
  ['headG', 0.3, [-0.1, 0.1, 1.48, 1.76]],
  ['pelvis', 0.42, [-0.14, 0.14, 0.85, 1.02]],
  ['hipL', 0.5, [0.04, 0.17, 0.05, 0.92]],
  ['hipR', 0.56, [-0.17, -0.04, 0.05, 0.92]],
];
const FLAKES = 360;

function ensureDust(group) {
  if (group.userData.dust) return group.userData.dust;
  const rand = rng(group.userData.objId + 'dust');
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 0.18), std('#6b6259', { roughness: 1 }), FLAKES);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const items = [];
  for (let i = 0; i < FLAKES; i++) {
    const part = DISSOLVE_PARTS[Math.floor(rand() * DISSOLVE_PARTS.length)];
    const [x0, x1, y0, y1] = part[2];
    items.push({
      born: part[1] + rand() * 0.42,
      x: x0 + (x1 - x0) * rand(), y: y0 + (y1 - y0) * rand(), z: (rand() - 0.5) * 0.24,
      s: 0.012 + rand() * 0.03, spin: (rand() - 0.5) * 9, ph: rand() * 6.3,
      vx: 0.35 + rand() * 0.6, vy: 0.05 + rand() * 0.35, vz: -0.15 - rand() * 0.45,
    });
  }
  group.add(mesh);
  group.userData.dust = { mesh, items };
  return group.userData.dust;
}

function applyDissolve(group, r, spec, local) {
  const parts = DISSOLVE_PARTS.map(([k]) => r[k]);
  for (const part of parts) {
    if (!part.userData.base) part.userData.base = part.scale.clone();
    part.scale.copy(part.userData.base);
    part.visible = true;
  }
  const dust = group.userData.dust;
  if (!spec) {
    if (dust) dust.mesh.visible = false;
    return;
  }
  const dur = Math.max(0.1, local?.dur || 1);
  const t = local?.t || 0;
  const span = Math.max(0.1, (spec.end - spec.start) * dur);
  const p = Math.max(0, Math.min(1.6, (t - spec.start * dur) / span));
  DISSOLVE_PARTS.forEach(([, delay], i) => {
    const k = Math.max(0, Math.min(1, (p - delay) / 0.42));
    const e = 1 - k * k;
    const part = parts[i];
    part.scale.copy(part.userData.base).multiplyScalar(Math.max(0.0001, e));
    part.visible = k < 1;
  });
  const d = ensureDust(group);
  d.mesh.visible = p > 0;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), eu = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  const s = r.scale || 1;
  d.items.forEach((it, i) => {
    const age = (p - it.born) * span; // seconds since this flake broke off
    if (age <= 0) {
      sc.set(0, 0, 0);
      pos.set(0, -10, 0);
    } else {
      const fade = Math.max(0, 1 - age / 3.2);
      pos.set(
        (it.x + it.vx * age + Math.sin(age * 2.1 + it.ph) * 0.05 * age) * s,
        (it.y + it.vy * age + Math.sin(age * 1.3 + it.ph) * 0.04) * s,
        (it.z + it.vz * age + Math.cos(age * 1.7 + it.ph) * 0.05 * age) * s,
      );
      const f = it.s * fade * s;
      sc.set(f, f, f);
    }
    eu.set(it.ph + age * it.spin, it.ph * 0.7 + age * it.spin * 0.6, 0);
    q.setFromEuler(eu);
    m.compose(pos, q, sc);
    d.mesh.setMatrixAt(i, m);
  });
  d.mesh.instanceMatrix.needsUpdate = true;
}


export function poseNames(type) {
  return Object.keys(POSE_SETS[type] || {});
}

// Drumstick angle off the forearm axis (deg); 60 is the default grip, strokes poses solve their own wrist angle.
function setStickAngle(fa, deg) {
  const st = fa.userData.stick;
  if (!st) return;
  const a = (deg * Math.PI) / 180;
  st.rotation.x = Math.PI - a;
  st.position.set(0, -0.3 - 0.17 * Math.cos(a), 0.17 * Math.sin(a));
}

/** Pose an actor (or animate a prop) for this frame. clock = song seconds, beat = seconds per beat. */
export function applyPose(group, pose, dist = 0, speed = 0, clock = 0, beat = 0.65, local = null) {
  const r = group.userData.rig;
  if (r) {
    const d = POSE_DEF[pose] || POSE_DEF.stand;
    if (r.handL) { r.handL.scale.set(0.8, 1.1, 0.6); r.handR.scale.set(0.8, 1.1, 0.6); }
    const hip = d.hip || [0, 0], knee = d.knee || [0, 0], sh = d.sh || [0, 0.08, 0, -0.08], el = d.el || [0, 0];
    r.root.position.y = d.drop || 0;
    r.spine.rotation.x = d.lean || 0;
    r.headG.rotation.set(d.head || 0, d.turn || 0, 0);
    if (d.look && local) {
      const f = (local.t / Math.max(0.01, local.dur) - d.look[0]) / (d.look[1] - d.look[0]);
      const u = Math.max(0, Math.min(1, f));
      const e = u * u * (3 - 2 * u);
      r.headG.rotation.set((d.head || 0) * (1 - e), (d.turn || 0) * (1 - e), 0);
    }
    r.hipL.rotation.set(hip[0], 0, 0);
    r.hipR.rotation.set(hip[1], 0, 0);
    r.kneeL.rotation.set(knee[0], 0, 0);
    r.kneeR.rotation.set(knee[1], 0, 0);
    r.shL.rotation.set(sh[0], 0, sh[1]);
    r.shR.rotation.set(sh[2], 0, sh[3]);
    r.elL.rotation.set(el[0], 0, 0);
    r.elR.rotation.set(el[1], 0, 0);
    setStickAngle(r.elL, 60); setStickAngle(r.elR, 60);
    if (d.walk && speed > 0) {
      const amp = Math.min(1, speed / 1.3) * 0.55;
      const phase = (dist / 1.5) * Math.PI * 2; // one full cycle per 1.5 m stride pair
      const sw = Math.sin(phase) * amp;
      r.hipL.rotation.x = sw;
      r.hipR.rotation.x = -sw;
      r.kneeL.rotation.x = Math.max(0, -Math.cos(phase)) * amp * 1.2;
      r.kneeR.rotation.x = Math.max(0, Math.cos(phase)) * amp * 1.2;
      r.shL.rotation.x = -sw * 0.8;
      r.shR.rotation.x = sw * 0.8;
      r.elL.rotation.x = -0.25;
      r.elR.rotation.x = -0.25;
    }
    if (d.run) {
      // Full-effort sprint cycle driven by distance travelled, not by speed, so slow motion keeps full form.
      const ph = (dist / (d.stride || 4)) * Math.PI * 2 + (d.phase || 0);
      const sw = Math.sin(ph);
      r.root.position.y = (d.drop || 0) - 0.06 + Math.abs(Math.cos(ph)) * 0.07;
      r.hipL.rotation.x = -0.3 - 0.85 * sw;
      r.hipR.rotation.x = -0.3 + 0.85 * sw;
      r.kneeL.rotation.x = 0.3 + 1.35 * Math.max(0, sw);
      r.kneeR.rotation.x = 0.3 + 1.35 * Math.max(0, -sw);
      r.shL.rotation.set(0.95 * sw, 0, 0.12);
      r.shR.rotation.set(-0.95 * sw, 0, -0.12);
      r.elL.rotation.x = -1.5;
      r.elR.rotation.x = -1.5;
    }
    if (d.twist) { r.elL.rotation.y = d.twist[0]; r.elR.rotation.y = d.twist[1]; }
    if (d.click && beat > 0) {
      // Count-in clicks land on every beat. With hitBeat (beat index from the first downbeat): no click after
      // hitBeat-1, the sticks lift high and apart, then come down hard to strike the drums exactly on hitBeat
      // (the drop), with a small rebound after the hit.
      const ph = clock / beat;
      const f = ph - Math.round(ph);
      const sm = (v) => { const c = Math.max(0, Math.min(1, v)); return c * c * (3 - 2 * c); };
      let k = Math.exp(-((f / 0.11) ** 2));
      let x = sh[0], zl = sh[1], zr = sh[3], ex = el[0];
      if (d.hitBeat != null) {
        const H = d.hitBeat;
        k *= 1 - sm((ph - (H - 0.9)) / 0.1);
        const up = sm((ph - (H - 0.85)) / 0.5);
        x += (d.lift[0] - x) * up; zl += (d.lift[1] - zl) * up; zr += (-d.lift[1] - zr) * up;
        const dn = Math.max(0, Math.min(1, (ph - (H - 0.3)) / 0.3)) ** 2;
        x += (d.hit[0] - x) * dn; zl += (d.hit[1] - zl) * dn; zr += (-d.hit[1] - zr) * dn; ex += (d.hit[2] - ex) * dn;
        // hitTwist: on the downstroke the forearms roll back so the sticks point forward onto the drum heads
        if (d.hitTwist && d.twist) {
          const tw = Math.max(dn, ph > H ? 1 : 0);
          r.elL.rotation.y = d.twist[0] + (d.hitTwist[0] - d.twist[0]) * tw;
          r.elR.rotation.y = d.twist[1] + (d.hitTwist[1] - d.twist[1]) * tw;
        }
        if (ph > H) x -= 0.35 * Math.sin(Math.min(1, (ph - H) / 0.7) * Math.PI);
        r.shL.rotation.x = x; r.shR.rotation.x = x;
        r.elL.rotation.x = ex; r.elR.rotation.x = ex;
      }
      // clickLR scales each arm's swing: the left stick is held still and only the right one taps across it
      const cl = d.clickLR ? d.clickLR[0] : 1, cr = d.clickLR ? d.clickLR[1] : 1;
      r.shL.rotation.z = zl - d.click * k * cl;
      r.shR.rotation.z = zr + d.click * k * cr;
    }
    if (d.beat && beat > 0) {
      const ph = (clock / beat) * Math.PI; // one stroke per eighth note
      if (d.beat === 'drum') {
        r.elL.rotation.x = el[0] + Math.sin(ph * 2) * 0.28;
        r.elR.rotation.x = el[1] - Math.sin(ph * 2) * 0.28;
      } else if (d.beat === 'strum') {
        r.elR.rotation.x = el[1] + Math.sin(ph * 2) * 0.22;
      } else if (d.beat === 'keys') {
        r.elL.rotation.x = el[0] + Math.sin(ph) * 0.05;
        r.elR.rotation.x = el[1] - Math.sin(ph * 1.5) * 0.05;
      } else if (d.beat === 'drum_hard') {
        const s2 = Math.sin(ph * 2);
        r.elL.rotation.x = el[0] + s2 * 0.75;
        r.elR.rotation.x = el[1] - s2 * 0.75;
        r.shL.rotation.x = sh[0] + s2 * 0.4;
        r.shR.rotation.x = sh[2] - s2 * 0.4;
      } else if (d.beat === 'strum_hard') {
        r.elR.rotation.x = el[1] + Math.sin(ph * 4) * 0.6; // eighth-note strums, big down/up strokes
        r.shR.rotation.x = sh[2] + Math.sin(ph * 4) * 0.2;
      } else if (d.beat === 'crash_play') {
        const pb = clock / beat;
        let prev = -Infinity, next = Infinity;
        for (const hb of d.crashBeats) { if (hb <= pb + 1e-6) prev = Math.max(prev, hb); else next = Math.min(next, hb); }
        const U = d.crashUp, Hh = d.crashHit;
        const lerp3 = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
        const smo = (v) => { const c = Math.max(0, Math.min(1, v)); return c * c * (3 - 2 * c); };
        let ps;
        if (next < Infinity && pb > next - 0.35) ps = lerp3(U, Hh, ((pb - (next - 0.35)) / 0.35) ** 2); // accelerating down-swing
        else if (prev > -Infinity) ps = lerp3(Hh, U, smo((pb - prev) / 0.5)); // rebound up after the hit
        else ps = U;
        r.shL.rotation.x = ps[0]; r.shL.rotation.z = ps[1]; r.elL.rotation.x = ps[2];
        const fr = pb - Math.round(pb);
        const pr = d.crashBeats.includes(Math.round(pb)) ? 0 : Math.exp(-((fr / 0.1) ** 2));
        r.elR.rotation.x = el[1] - 0.25 + 0.6 * pr;
        // drum rolls / fills: both sticks alternate fast strokes and sweep across the toms (his left -> right)
        let rw = 0, ru = 0;
        for (const [ra, rb] of d.rolls || []) {
          const w = smo((pb - ra) / 0.12) * (1 - smo((pb - rb) / 0.12));
          if (w > rw) { rw = w; ru = Math.max(0, Math.min(1, (pb - ra) / (rb - ra))); }
        }
        if (rw > 0) {
          const tt = clock * 5 * Math.PI * 2;
          const sweep = 0.2 - 0.45 * ru;
          const tgt = [[r.shL, sh[0] - 0.1, sh[1] + sweep], [r.shR, sh[2] - 0.1, sh[3] + sweep]];
          for (const [jt, tx, tz] of tgt) { jt.rotation.x += (tx - jt.rotation.x) * rw; jt.rotation.z += (tz - jt.rotation.z) * rw; }
          r.elL.rotation.x += (el[0] + 0.35 * Math.sin(tt) - r.elL.rotation.x) * rw;
          r.elR.rotation.x += (el[1] + 0.35 * Math.sin(tt + Math.PI) - r.elR.rotation.x) * rw;
        }
      } else if (d.beat === 'strokes') {
        // Score-accurate drumming: each hand moves between scored hit targets [beat, shX, shZ, elX]
        // (beats from the first downbeat), lifting the stick between hits and landing exactly on the beat.
        const pb = clock / beat;
        const armAt = (list) => {
          if (pb <= list[0][0]) return list[0].slice(1, 6);
          for (let i = 0; i < list.length - 1; i++) {
            const a0 = list[i], a1 = list[i + 1];
            if (pb >= a0[0] && pb <= a1[0]) {
              const u = (pb - a0[0]) / (a1[0] - a0[0]);
              let e = u * u * (3 - 2 * u);
              // flag 4 = a hit: the stick accelerates into it (a real downstroke lands at speed instead of easing
              // to a stop) and springs off it after; a1[7] = lift scale on the way in (0 when it comes down from a
              // raised pose, ~1-2 for a groove stroke straight from the previous hit)
              const hitIn = a1[6] === 4, hitOut = a0[6] === 4;
              if (hitIn && hitOut) e = u;
              else if (hitIn) e = u * u;
              else if (hitOut) e = 1 - (1 - u) * (1 - u);
              // the stick comes up after each hit and drops back fast onto the next one
              const hov = hitIn ? (a1[7] || 0) : a0[6] === 1 || a1[6] === 1 ? 0.3 : hitOut ? 0.5 : 1;
              const lift = hov * Math.sin(Math.PI * Math.pow(u, 0.7)) * Math.min(0.8, 0.2 + (a1[0] - a0[0]) * 0.5);
              const v = a0.slice(1, 6).map((x, j) => x + (a1[j + 1] - x) * e);
              v[0] -= lift * 0.35; v[2] -= lift * 0.3;
              // flag 3 = a shaped stroke (e.g. one cymbal straight to another): the wrist offset a1[7] keeps the stick
              // level on the way so it does not droop into an extra stroke mid-air, a1[8] scales the arm's lift, a1[9] shapes
              // when the wrist offset peaks
              if (a1[6] === 3) {
                v[4] += (a1[7] || 0) * Math.sin(Math.PI * Math.pow(u, a1[9] ?? 1)); // a1[9] < 1 peaks the offset earlier
                if (a1[8] !== undefined) { const x = (a1[8] - 1) * Math.sin(Math.PI * Math.pow(u, 0.7)) * Math.min(0.8, 0.2 + (a1[0] - a0[0]) * 0.5); v[0] -= x * 0.35; v[2] -= x * 0.3; }
              }
              return v;
            }
          }
          return list[list.length - 1].slice(1, 6);
        };
        const L = armAt(d.strokes.L), R = armAt(d.strokes.R);
        r.shL.rotation.set(L[0], 0, L[1]); r.elL.rotation.set(L[2], L[3], 0);
        r.shR.rotation.set(R[0], 0, R[1]); r.elR.rotation.set(R[2], R[3], 0);
        setStickAngle(r.elL, L[4]); setStickAngle(r.elR, R[4]);
        if (d.headKeys) {
          // head keyframes [beat, nod (+ looks down), turn, tilt], eased, added to the pose's head angle
          const hk = d.headKeys;
          let hv = hk[hk.length - 1].slice(1);
          if (pb <= hk[0][0]) hv = hk[0].slice(1);
          else for (let i = 0; i < hk.length - 1; i++) {
            if (pb >= hk[i][0] && pb <= hk[i + 1][0]) {
              const u = (pb - hk[i][0]) / (hk[i + 1][0] - hk[i][0]), e = u * u * (3 - 2 * u);
              hv = hk[i].slice(1).map((x, j) => x + (hk[i + 1][j + 1] - x) * e);
              break;
            }
          }
          r.headG.rotation.set((d.head || 0) + hv[0], (d.turn || 0) + hv[1], hv[2] || 0);
        }
        if (d.kicks) {
          let kp = 0;
          for (const kb of d.kicks) kp = Math.max(kp, Math.exp(-(((pb - kb) / 0.12) ** 2)));
          r.kneeR.rotation.x += 0.18 * kp;
        }
      } else if (d.beat === 'keys_hard') {
        const fk = clock / beat - Math.round(clock / beat);
        const pk = Math.exp(-((fk / 0.12) ** 2));
        r.elL.rotation.x = el[0] + 0.3 * pk;
        r.elR.rotation.x = el[1] + 0.3 * pk;
        r.shL.rotation.z = sh[1] + Math.sin(ph) * 0.15;
        r.shR.rotation.z = sh[3] + Math.sin(ph) * 0.15;
      }
      if (d.groove) {
        // head nod + body bounce landing on every beat
        const fg = clock / beat - Math.round(clock / beat);
        const pg = Math.exp(-((fg / 0.14) ** 2)) * d.groove;
        r.headG.rotation.x += 0.5 * pg;
        r.spine.rotation.x += 0.15 * pg;
        if (!d.drop) {
          r.root.position.y -= 0.07 * pg;
          r.kneeL.rotation.x += 0.4 * pg; r.kneeR.rotation.x += 0.4 * pg;
          r.hipL.rotation.x -= 0.2 * pg; r.hipR.rotation.x -= 0.2 * pg;
        }
      }
    }
    const pull = d.armL || d.armR;
    if (pull && local) {
      const left = !!d.armL;
      const sh = left ? r.shL : r.shR, elb = left ? r.elL : r.elR;
      const u = Math.max(0, Math.min(1, local.t / Math.max(0.01, local.dur)));
      const e = d.lin ? u : u * u * (3 - 2 * u);
      const [a0, a1] = pull;
      sh.rotation.set(a0[0] + (a1[0] - a0[0]) * e, 0, a0[1] + (a1[1] - a0[1]) * e);
      elb.rotation.x = a0[2] + (a1[2] - a0[2]) * e;
      if (d.wrap) {
        const k = (u - d.wrap[0]) / (d.wrap[1] - d.wrap[0]);
        if (k > 0 && k < 1) {
          elb.rotation.x -= d.wrap[2] * Math.sin(k * Math.PI);
          sh.rotation.y = (left ? -0.6 : 0.6) * Math.sin(k * Math.PI * 2);
        }
      }
    }
    if (d.armLKeys && local) {
      const u = Math.max(0, Math.min(1, local.t / Math.max(0.01, local.dur)));
      const K = d.armLKeys;
      let i = 0;
      while (i < K.length - 2 && u > K[i + 1][0]) i++;
      const [u0, x0, z0, e0] = K[i], [u1, x1, z1, e1] = K[i + 1];
      const f = Math.max(0, Math.min(1, (u - u0) / Math.max(1e-4, u1 - u0)));
      const s = d.lin ? f : f * f * (3 - 2 * f);
      r.shL.rotation.set(x0 + (x1 - x0) * s, 0, z0 + (z1 - z0) * s);
      r.elL.rotation.x = e0 + (e1 - e0) * s;
      if (d.grip && r.handL) {
        const g = Math.max(0, Math.min(1, (u - d.grip[0]) / (d.grip[1] - d.grip[0])));
        r.handL.scale.set(0.8 + 0.12 * g, 1.1 - 0.3 * g, 0.6 + 0.25 * g);
      }
    }
    if (d.gaze && local) {
      const u = Math.max(0, Math.min(1, local.t / Math.max(0.01, local.dur)));
      const k = Math.max(0, Math.min(1, (u - d.gaze[0]) / (d.gaze[1] - d.gaze[0])));
      const s = k * k * (3 - 2 * k);
      r.headG.rotation.x = (d.head || 0) + (d.gaze[2] - (d.head || 0)) * s;
    }
    applyDissolve(group, r, d.dissolve, local);
    return;
  }
  const a = group.userData.anim;
  if (!a) return;
  if (a.kind === 'metronome') {
    // Extremes land on beats (clock is measured from the first downbeat). 'start' rests at the
    // centre, sets off from a half-beat (where the swing crosses centre) ~0.6 s into the shot and
    // eases in: the arc grows from nothing to the full swing by the end of the shot.
    const A = 0.42;
    let ang;
    if (pose === 'stop') ang = A;
    else if (pose === 'rest') ang = 0;
    else if (pose === 'slow') ang = -A * Math.cos((Math.PI * clock) / (beat * 2.2));
    else if (pose === 'start') {
      const c0 = local?.c0 ?? clock;
      const release = (Math.ceil((c0 + 0.6) / beat - 0.5) + 0.5) * beat;
      const end = c0 + (local?.dur ?? 4);
      const u = Math.max(0, Math.min(1, (clock - release) / Math.max(0.2, end - release)));
      ang = clock < release ? 0 : -A * u * u * Math.cos((Math.PI * clock) / beat);
    } else ang = -A * Math.cos((Math.PI * clock) / beat);
    a.pendulum.rotation.z = ang;
  } else if (a.kind === 'balloon') {
    a.reflTurn = 0;
    if (pose === 'circle' || pose === 'circle_turn') {
      // Conical sway: the lean direction sweeps one full turn per shot, clockwise seen from
      // above, starting toward the object's local +X. A balloon on a long string leans less.
      const u = local ? local.t / Math.max(0.01, local.dur) : clock / 6;
      // Stylised (non-physical): the mirrored world itself turns 60° clockwise over the shot,
      // so the reflection visibly rotates while the camera stays almost still.
      if (pose === 'circle_turn') a.reflTurn = u * (Math.PI / 3);
      const phi = Math.PI * 2 * u;
      const th = a.L > 0.5 ? 0.06 : 0.18;
      a.sway.quaternion.setFromAxisAngle(_leanAxis.set(Math.sin(phi), 0, -Math.cos(phi)), th);
      a.head.rotation.set(0, 0, 0);
    } else {
      const still = pose === 'still';
      a.sway.rotation.set(
        still ? 0 : Math.sin(clock * 0.7 + 1.3) * 0.04,
        0,
        still ? 0 : Math.sin(clock * 0.9) * 0.05 + Math.sin(clock * 2.3) * 0.015,
      );
      a.head.rotation.set(0, still ? 0 : clock * 0.25, 0);
    }
  } else if (a.kind === 'clouds') {
    a.ring.rotation.y = pose === 'still' ? 0 : -clock * a.speed; // negative yaw = drifts screen-left → right
  } else if (a.kind === 'dust') {
    // Settled dust on a slab. Pose 'burst': on beat burstBeat (counted from the first downbeat) it shoots
    // up fast, then decelerates and hangs in the air; any other pose keeps it lying on the slab.
    const age = pose === 'burst' ? clock - a.burstBeat * beat : -1;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    a.items.forEach((it, i) => {
      const ag = age - it.lag;
      const k = ag > 0 ? 1 - Math.exp(-ag / 0.16) : 0;
      p.set(it.x * (1 + it.out * k), it.y0 + it.top * k + Math.sin(clock * 0.6 + it.ph) * 0.03 * k, it.z * (1 + it.out * k));
      e.set(it.rx + k * it.spin, it.ry + k * it.spin * 0.7, 0);
      q.setFromEuler(e);
      sc.set(it.s, it.s * (k > 0 ? 1 : it.sy), it.s);
      m.compose(p, q, sc);
      a.mesh.setMatrixAt(i, m);
    });
    a.mesh.instanceMatrix.needsUpdate = true;
    a.puffs.forEach((pf) => {
      const u = pf.userData.dust;
      const ag = age - u.lag;
      const k = ag > 0 ? 1 - Math.exp(-ag / 0.22) : 0;
      pf.visible = k > 0.01;
      pf.position.set(u.x, u.top * k, u.z);
      pf.scale.setScalar(Math.max(0.001, u.r * (0.25 + 0.75 * k)));
    });
  } else if (a.kind === 'debris') {
    const still = pose === 'still';
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    a.items.forEach((it, i) => {
      const t = still ? 0 : clock;
      p.set(it.x, it.y + Math.sin(t * 0.55 + it.ph) * 0.05 * it.k, it.z);
      e.set(it.rx + t * it.spin, it.ry + t * it.spin * 0.7, it.rz);
      q.setFromEuler(e);
      sc.set(it.s, it.s * it.sy, it.s);
      m.compose(p, q, sc);
      a.mesh.setMatrixAt(i, m);
    });
    a.mesh.instanceMatrix.needsUpdate = true;
  }
}

function buildCar(o) {
  const g = new THREE.Group();
  const paint = std(o.color, { roughness: 0.35, metalness: 0.4 });
  const glass = std('#1d2630', { roughness: 0.15, metalness: 0.6 });
  const tire = std('#151515', { roughness: 0.9 });
  const body = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.62, 4.5), paint));
  body.position.y = 0.62;
  g.add(body);
  const cabin = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.52, 2.3), glass));
  cabin.position.set(0, 1.18, -0.2);
  g.add(cabin);
  const roof = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 1.9), paint));
  roof.position.set(0, 1.46, -0.25);
  g.add(roof);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 20);
  for (const [x, z] of [[0.82, 1.45], [-0.82, 1.45], [0.82, -1.4], [-0.82, -1.4]]) {
    const w = shadowed(new THREE.Mesh(wheelGeo, tire));
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.34, z);
    g.add(w);
  }
  const lightMat = std('#fff6d8', { emissive: '#fff2c0', emissiveIntensity: 0.6 });
  for (const x of [-0.62, 0.62]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.04), lightMat);
    l.position.set(x, 0.72, 2.26);
    g.add(l);
  }
  const label = makeLabel(o.name);
  label.position.y = 2.0;
  g.add(label);
  return g;
}

function buildTree(o) {
  const g = new THREE.Group();
  const h = o.height || 5;
  const trunk = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.12 * h / 5, 0.18 * h / 5, h * 0.4, 10), std('#5a4030')));
  trunk.position.y = h * 0.2;
  g.add(trunk);
  const crown = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(h * 0.3, 1), std(o.color, { flatShading: true })));
  crown.position.y = h * 0.62;
  crown.scale.y = 1.25;
  g.add(crown);
  return g;
}

function buildTable(o) {
  const g = new THREE.Group();
  const [w, h, d] = o.size;
  const mat = std(o.color);
  const top = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), mat));
  top.position.y = h - 0.025;
  g.add(top);
  const legGeo = new THREE.BoxGeometry(0.05, h - 0.05, 0.05);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = shadowed(new THREE.Mesh(legGeo, mat));
    leg.position.set(sx * (w / 2 - 0.06), (h - 0.05) / 2, sz * (d / 2 - 0.06));
    g.add(leg);
  }
  return g;
}

function buildMark(o) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: o.color });
  for (const r of [Math.PI / 4, -Math.PI / 4]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.01, 0.07), mat);
    bar.rotation.y = r;
    bar.position.y = 0.006;
    g.add(bar);
  }
  const label = makeLabel(o.name);
  label.position.y = 0.4;
  g.add(label);
  return g;
}


function buildDrums(o) {
  const g = new THREE.Group();
  const shell = std(o.color, { roughness: 0.32, metalness: 0.25 });
  const headMat = std('#ebe7de', { roughness: 0.6 });
  const chrome = std('#b9bec6', { roughness: 0.25, metalness: 0.9 });
  const brass = std('#c9a24a', { roughness: 0.3, metalness: 0.8, side: THREE.DoubleSide });
  const drum = (r, h, x, y, z, rx = 0, rz = 0) => {
    const d = new THREE.Group();
    const s = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 28), shell));
    d.add(s);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.006, 28), headMat);
    top.position.y = h / 2 + 0.003;
    d.add(top);
    d.position.set(x, y, z);
    d.rotation.set(rx, 0, rz);
    g.add(d);
    return d;
  };
  const stand = (x, z, h) => {
    const p = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, h, 8), chrome));
    p.position.set(x, h / 2, z);
    g.add(p);
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.36, 6), chrome);
      const a = (i / 3) * Math.PI * 2;
      leg.position.set(x + Math.cos(a) * 0.13, 0.12, z + Math.sin(a) * 0.13);
      leg.rotation.set(Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9);
      g.add(leg);
    }
  };
  // Each cymbal hangs on a pivot (its stand's tilter); the plate inside swings about it when physics.js pushes it.
  g.userData.cymbals = [];
  const cymbal = (x, y, z, r, tilt, tiltZ = 0, kind = 'crash') => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    pivot.rotation.set(tilt, 0, tiltZ);
    const c = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.15, 0.025, 32, 1, true), brass));
    pivot.add(c);
    g.add(pivot);
    if (kind) g.userData.cymbals.push({ pivot, plate: c, r, kind });
    return pivot;
  };
  // the drummer sits at -Z facing +Z (the audience); his left is +X
  const kick = drum(0.28, 0.42, 0, 0.3, 0.05, Math.PI / 2);
  kick.children[1].position.y = 0.214;
  drum(0.11, 0.15, 0.15, 0.74, -0.02, -0.35);
  drum(0.12, 0.16, -0.15, 0.75, -0.02, -0.35);
  drum(0.17, 0.14, 0.33, 0.62, -0.32, -0.12);
  stand(0.33, -0.32, 0.55);
  drum(0.2, 0.38, -0.58, 0.47, -0.1); // floor tom beside his right knee, head at snare height, clear of the kick
  stand(0.58, -0.2, 0.81); // hi-hat a little below the K crash, which overlaps it from above (as on the cover)
  cymbal(0.58, 0.83, -0.2, 0.17, 0, 0, null); // bottom hi-hat plate stays put
  cymbal(0.58, 0.86, -0.2, 0.17, 0, 0, 'hihat');
  stand(0.66, 0.08, 0.9);
  cymbal(0.66, 0.92, 0.08, 0.22, 0.22, -0.16); // cymbals at chest height; K crash out at his left, within reach of his right hand crossing over (cover), clear of his face from the K4 camera, tipped away from him so the sticks come down over its rim
  // his right side, as on Gunil's real kit: a big crash high at the front-right over the floor tom, and the EFX
  // effect cymbal low out at his right (4 cymbals in all with the K crash and the hi-hat)
  stand(-0.5, 0.3, 1.18); // the big crash hangs HIGH, well above the EFX, so after the EFX the right stick passes under it to the K crash
  cymbal(-0.5, 1.2, 0.3, 0.24, -0.3);
  stand(-0.95, 0.05, 0.93);
  cymbal(-0.95, 0.95, 0.05, 0.2, -0.15, -0.3); // EFX low at his right, tipped toward him so the stick crosses its rim from above
  const seat = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.08, 20), std('#202020')));
  seat.position.set(0, 0.5, -0.58);
  g.add(seat);
  stand(0, -0.58, 0.46);
  const label = makeLabel(o.name);
  label.position.y = 1.65;
  g.add(label);
  return g;
}

function buildKeyboard(o) {
  const g = new THREE.Group();
  const [w, h, d] = o.size || [1.25, 0.92, 0.38];
  const mat = std(o.color, { roughness: 0.4 });
  const body = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, 0.09, d), mat));
  body.position.y = h;
  g.add(body);
  const keys = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.015, d * 0.42), std('#f2f0ea', { roughness: 0.5 }));
  keys.position.set(0, h + 0.05, -d * 0.22);
  g.add(keys);
  const legMat = std('#111');
  for (const sgn of [-1, 1]) {
    for (const r of [0.55, -0.55]) {
      const leg = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.03, h * 1.12, 0.03), legMat));
      leg.position.set(sgn * w * 0.32, h / 2, 0);
      leg.rotation.x = r;
      g.add(leg);
    }
  }
  const label = makeLabel(o.name);
  label.position.y = h + 0.45;
  g.add(label);
  return g;
}

function buildMicStand(o) {
  const g = new THREE.Group();
  const h = o.height || 1.5;
  const mat = std(o.color, { roughness: 0.4, metalness: 0.5 });
  const pole = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, h, 8), mat));
  pole.position.y = h / 2;
  g.add(pole);
  for (let i = 0; i < 3; i++) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.4, 6), mat);
    const a = (i / 3) * Math.PI * 2;
    leg.position.set(Math.cos(a) * 0.14, 0.1, Math.sin(a) * 0.14);
    leg.rotation.set(Math.sin(a) * 1.0, 0, -Math.cos(a) * 1.0);
    g.add(leg);
  }
  const mic = new THREE.Group();
  mic.position.y = h;
  mic.rotation.x = -1.1; // tilted back toward the singer behind the stand (-Z)
  const bodyM = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.014, 0.16, 12), std('#1a1a1a')));
  bodyM.position.y = 0.08;
  mic.add(bodyM);
  const grille = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.028, 12, 10), std('#9a9da3', { metalness: 0.7, roughness: 0.4 })));
  grille.position.y = 0.17;
  mic.add(grille);
  g.add(mic);
  return g;
}

// Latex-balloon profile: narrow neck at the knot (y = 0), widest a little above the middle.
function teardropGeometry(h) {
  const pts = [];
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI;
    const y = ((1 - Math.cos(t)) / 2) * h;
    const r = 0.5 * Math.sin(t) * (0.7 + 0.3 * ((1 - Math.cos(t)) / 2)) * 1.17;
    pts.push(new THREE.Vector2(Math.max(0.0001, r), y));
  }
  return new THREE.LatheGeometry(pts, 48);
}

// Origin = where the string is tied; the balloon floats "height" metres above it.
// mirror: teardrop shape with a glossy skin that reflects the live scene through a cube camera.
function buildBalloon(o, mirror = false) {
  const g = new THREE.Group();
  const L = o.height ?? (mirror ? 0 : 1.6);
  const [w, h, d] = o.size || [0.3, 0.36, 0.3];
  if (mirror) {
    const tiltG = new THREE.Group();
    tiltG.rotation.x = THREE.MathUtils.degToRad(o.tilt || 0);
    g.add(tiltG);
    const sway = new THREE.Group();
    tiltG.add(sway);
    if (L > 0.01) {
      const str = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, L, 5), new THREE.MeshBasicMaterial({ color: '#f5f5f2' }));
      str.position.y = L / 2;
      sway.add(str);
    }
    const head = new THREE.Group();
    head.position.y = L;
    sway.add(head);
    const rt = new THREE.WebGLCubeRenderTarget(512);
    const cam = new THREE.CubeCamera(0.03, 2000, rt);
    // Unlit tinted mirror (the reflection is multiplied by the latex colour) plus an additive
    // specular-only shell for the glossy highlight.
    const skin = new THREE.MeshBasicMaterial({ color: o.color, envMap: rt.texture, combine: THREE.MultiplyOperation, reflectivity: 1 });
    const geo = teardropGeometry(h);
    const ball = shadowed(new THREE.Mesh(geo, skin));
    ball.scale.set(w, 1, d);
    ball.position.y = 0.025;
    head.add(ball);
    const gloss = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color: '#000000', specular: '#bdbdbd', shininess: 150, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    gloss.scale.set(w * 1.002, 1.002, d * 1.002);
    gloss.position.y = 0.025;
    head.add(gloss);
    const knot = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.006, 0.03, 12), skin);
    knot.position.y = 0.012;
    head.add(knot);
    const centre = new THREE.Object3D(); // where the reflection is captured from
    centre.position.y = 0.025 + h * 0.55;
    head.add(centre);
    g.userData.anim = { kind: 'balloon', sway, head, L };
    g.userData.mirror = { rt, cam, centre };
    const label = makeLabel(o.name);
    label.position.y = L + h + 0.2;
    g.add(label);
    return g;
  }
  const tiltG = new THREE.Group();
  tiltG.rotation.x = THREE.MathUtils.degToRad(o.tilt || 0); // 90 = lying forward (e.g. held at the lips)
  g.add(tiltG);
  const sway = new THREE.Group();
  tiltG.add(sway);
  if (L > 0.01) {
    const str = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, L, 5), new THREE.MeshBasicMaterial({ color: '#f5f5f2' }));
    str.position.y = L / 2;
    sway.add(str);
  }
  const head = new THREE.Group();
  head.position.y = L;
  sway.add(head);
  const skin = std(o.color, { roughness: 0.22, metalness: 0.05 });
  const ball = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.5, 28, 22), skin));
  ball.scale.set(w, h, d);
  ball.position.y = h / 2 + 0.03;
  head.add(ball);
  const knot = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.04, 10), skin);
  knot.position.y = 0.02;
  head.add(knot);
  g.userData.anim = { kind: 'balloon', sway, head, L };
  const label = makeLabel(o.name);
  label.position.y = L + h + 0.2;
  g.add(label);
  return g;
}

// Irregular extruded rock slab; its top face sits "height" above the origin.
function buildSlab(o) {
  const g = new THREE.Group();
  const [w, h, d] = o.size || [3, 0.6, 2.4];
  const rand = rng(o.id + 'slab');
  const shape = new THREE.Shape();
  const n = 7 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.35;
    const k = 0.82 + rand() * 0.18;
    const x = Math.cos(a) * (w / 2) * k * 1.12, y = Math.sin(a) * (d / 2) * k * 1.12;
    const cx = Math.max(-w / 2, Math.min(w / 2, x)), cy = Math.max(-d / 2, Math.min(d / 2, y));
    if (i === 0) shape.moveTo(cx, cy); else shape.lineTo(cx, cy);
  }
  shape.closePath();
  const bevel = Math.min(0.06, h * 0.2);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1 });
  geo.translate(0, 0, bevel);
  geo.rotateX(-Math.PI / 2);
  const mesh = shadowed(new THREE.Mesh(geo, std(o.color, { roughness: 0.95, flatShading: true })));
  const tilt = new THREE.Group();
  tilt.rotation.x = THREE.MathUtils.degToRad(o.tilt || 0);
  tilt.rotation.z = THREE.MathUtils.degToRad((o.tilt || 0) * 0.4);
  tilt.add(mesh);
  g.add(tilt);
  const label = makeLabel(o.name);
  label.position.y = h + 0.35;
  g.add(label);
  return g;
}

// Dust settled on a slab top: footprint size=[w,h,d], h = how high it rises on its burst (bottom at the origin).
function buildDust(o) {
  const g = new THREE.Group();
  const [w, h, d] = o.size || [3, 2, 2.4];
  const rand = rng(o.id + 'dust');
  const count = Math.max(15, Math.min(200, Math.round(w * d * 9))); // light scattering (~20% of the dense version)
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), std(o.color, { roughness: 1, flatShading: true }), count);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const items = [];
  for (let i = 0; i < count; i++) {
    const r = rand();
    items.push({
      x: (rand() - 0.5) * w * 0.9, z: (rand() - 0.5) * d * 0.9, y0: 0.01 + rand() * 0.02,
      top: h * (0.15 + 0.85 * Math.pow(rand(), 0.7)), s: 0.015 + 0.04 * r * r, sy: 0.3 + rand() * 0.3,
      out: 0.1 + rand() * 0.35, lag: rand() * 0.06, rx: rand() * 6.3, ry: rand() * 6.3, spin: (rand() - 0.5) * 2.4, ph: rand() * 6.3,
    });
  }
  g.add(mesh);
  const puffMat = new THREE.MeshStandardMaterial({ color: o.color, roughness: 1, transparent: true, opacity: 0.3, depthWrite: false });
  const puffs = [];
  const np = 0; // translucent puffs read as grey balls in generated video: specks only
  for (let i = 0; i < np; i++) {
    const pf = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), puffMat);
    pf.userData.dust = { x: (rand() - 0.5) * w * 0.8, z: (rand() - 0.5) * d * 0.8, top: h * (0.25 + rand() * 0.45), r: (0.35 + rand() * 0.45) * Math.min(1.4, Math.min(w, d) / 2.5), lag: rand() * 0.08 };
    g.add(pf);
    puffs.push(pf);
  }
  g.userData.anim = { kind: 'dust', mesh, items, puffs, burstBeat: +o.burstBeat || 0 };
  applyPose(g, 'rest', 0, 0, 0);
  const label = makeLabel(o.name);
  label.position.y = h + 0.3;
  g.add(label);
  return g;
}

// A cloud of rock fragments filling the box size=[w,h,d] (bottom at the origin).
function buildDebris(o) {
  const g = new THREE.Group();
  const [w, h, d] = o.size || [6, 3, 6];
  const rand = rng(o.id + 'debris');
  const count = Math.max(12, Math.min(320, Math.round(w * h * d * 1.6 + 14)));
  const scale = Math.max(0.22, Math.min(1, Math.min(w, h, d) / 3)); // shallow fields get small pebbles
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), std(o.color, { roughness: 0.95, flatShading: true }), count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const items = [];
  for (let i = 0; i < count; i++) {
    const r = rand();
    items.push({
      x: (rand() - 0.5) * w, y: rand() * h, z: (rand() - 0.5) * d,
      s: (0.025 + 0.2 * r * r * r) * scale, sy: 0.55 + rand() * 0.5,
      rx: rand() * 6.3, ry: rand() * 6.3, rz: rand() * 6.3,
      ph: rand() * 6.3, spin: (rand() - 0.5) * 0.25, k: 0.5 + rand(),
    });
  }
  g.add(mesh);
  g.userData.anim = { kind: 'debris', mesh, items };
  applyPose(g, 'float', 0, 0, 0);
  const box = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, h, d / 2)), 0x7d8794);
  box.userData.directorOnly = true;
  g.add(box);
  const label = makeLabel(o.name);
  label.position.y = h + 0.3;
  g.add(label);
  return g;
}

function buildMetronome(o) {
  const g = new THREE.Group();
  const wood = std(o.color, { roughness: 0.6 });
  const base = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.025, 0.15), wood));
  base.position.y = 0.0125;
  g.add(base);
  const body = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.25, 4), wood));
  body.rotation.y = Math.PI / 4;
  body.position.y = 0.15;
  g.add(body);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.16), std('#e8dcc0'));
  face.position.set(0, 0.13, 0.048);
  face.rotation.x = -0.32;
  g.add(face);
  const pendulum = new THREE.Group();
  pendulum.position.set(0, 0.06, 0.06);
  const arm = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.22, 0.006), std('#c8c8c8', { metalness: 0.8, roughness: 0.3 })));
  arm.position.y = 0.11;
  pendulum.add(arm);
  const weight = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.012), std('#d9b45a', { metalness: 0.7, roughness: 0.35 })));
  weight.position.y = 0.15;
  pendulum.add(weight);
  g.add(pendulum);
  g.userData.anim = { kind: 'metronome', pendulum };
  const label = makeLabel(o.name);
  label.position.y = 0.5;
  g.add(label);
  return g;
}

// One smudged graphite cloud: soft, flat, horizontally stretched patches with streaky texture,
// darker than the paper-tone sky (reads like a rubbed pencil cloud, not a 3D puff).
function cloudCanvas(rand) {
  const W = 1024, H = 320;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.filter = 'blur(9px)';
  const n = 30 + Math.floor(rand() * 20);
  for (let i = 0; i < n; i++) {
    const x = 150 + rand() * (W - 300);
    const k = 1 - Math.abs(x - W / 2) / (W / 2); // fuller in the middle
    const y = H * 0.64 - rand() * H * 0.32 * (0.3 + k);
    const rx = 40 + rand() * 120 * (0.4 + k);
    const sy = 0.26 + rand() * 0.22;
    const shade = 70 + Math.floor(rand() * 60);
    ctx.globalAlpha = 0.18 + rand() * 0.3;
    const gr = ctx.createRadialGradient(x, y, 0, x, y, rx);
    gr.addColorStop(0, `rgb(${shade},${shade},${shade + 4})`);
    gr.addColorStop(1, `rgba(${shade},${shade},${shade + 4},0)`);
    ctx.fillStyle = gr;
    ctx.save();
    ctx.translate(x, y); ctx.scale(1, sy); ctx.translate(-x, -y);
    ctx.beginPath();
    ctx.arc(x, y, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-atop'; // streaks only where there is cloud
  for (let i = 0; i < 260; i++) {
    const x = rand() * W, y = rand() * H, len = 30 + rand() * 140;
    ctx.strokeStyle = rand() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(40,40,44,0.12)';
    ctx.lineWidth = 1 + rand() * 2.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rand() - 0.5) * 8);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A ring of cloud billboards around the origin (low band just above the horizon plus a high
// band overhead, so mirrored surfaces see sky everywhere). They ignore fog. size = [radius, -].
function buildClouds(o) {
  const g = new THREE.Group();
  const R = (o.size && o.size[0]) || 400;
  const rand = rng(o.id + 'clouds');
  const texes = Array.from({ length: 8 }, () => cloudCanvas(rand));
  const ring = new THREE.Group();
  g.add(ring);
  const eye = 3.8; // typical camera height the bands are laid out for
  const add = (n, rad, e0, e1, w0, w1) => {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({ map: texes[Math.floor(rand() * texes.length)], transparent: true, depthWrite: false, fog: false, color: o.color });
      const s = new THREE.Sprite(mat);
      const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * (Math.PI * 2 / n) * 0.9;
      const r = rad * (0.9 + rand() * 0.2);
      const e = THREE.MathUtils.degToRad(e0 + rand() * (e1 - e0));
      const w = r * (w0 + rand() * (w1 - w0));
      s.position.set(Math.cos(a) * r, eye + Math.tan(e) * r + w * 0.1, Math.sin(a) * r);
      s.scale.set(w, w * 0.31, 1);
      ring.add(s);
    }
  };
  add(70, R, 0.2, 2.6, 0.08, 0.16);
  add(60, R * 0.97, 2.0, 6.0, 0.08, 0.16);
  add(46, R * 0.5, 10, 50, 0.3, 0.55);
  g.userData.anim = { kind: 'clouds', ring, speed: 0.012 };
  return g;
}

// Cracked-plate ground: jittered-grid Voronoi plates with dark seams, painted to a canvas.
function buildCrackFloor(o) {
  const g = new THREE.Group();
  const [w, , d] = o.size || [60, 0, 60];
  const rand = rng(o.id + 'crack');
  const N = 3072;
  const cell = 9; // average plate size (m)
  const gx = Math.ceil(w / cell), gz = Math.ceil(d / cell);
  const seeds = [];
  for (let j = 0; j < gz; j++) for (let i = 0; i < gx; i++) {
    seeds.push([(i + rand()) * cell, (j + rand()) * cell, 0.74 + rand() * 0.42]);
  }
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const base = new THREE.Color(o.color);
  const br = base.r * 255, bg = base.g * 255, bb = base.b * 255;
  const crack = 0.12; // seam half-width (m)
  for (let py = 0; py < N; py++) {
    const z = (py / N) * d;
    const cj = Math.floor(z / cell);
    for (let px = 0; px < N; px++) {
      const x = (px / N) * w;
      const ci = Math.floor(x / cell);
      let d1 = 1e9, d2 = 1e9, best = null;
      for (let jj = cj - 1; jj <= cj + 1; jj++) {
        if (jj < 0 || jj >= gz) continue;
        for (let ii = ci - 1; ii <= ci + 1; ii++) {
          if (ii < 0 || ii >= gx) continue;
          const s = seeds[jj * gx + ii];
          const dd = Math.hypot(x - s[0], z - s[1]);
          if (dd < d1) { d2 = d1; d1 = dd; best = s; } else if (dd < d2) d2 = dd;
        }
      }
      const edge = (d2 - d1) / 2;
      let k = best ? best[2] : 1;
      k *= 0.97 + 0.05 * Math.sin(x * 2.3 + z * 1.1) + 0.03 * Math.sin(z * 4.7 - x * 0.9); // stone mottling
      if (edge < 0.6) k *= 0.88 + 0.12 * (edge / 0.6); // plate edges sit a little lower
      if (edge < crack) k *= 0.45 + 0.4 * (edge / crack);
      k *= 0.95 + 0.1 * rand(); // grain
      const o4 = (py * N + px) * 4;
      img.data[o4] = Math.min(255, br * k);
      img.data[o4 + 1] = Math.min(255, bg * k);
      img.data[o4 + 2] = Math.min(255, bb * k);
      img.data[o4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // long fractures running across plates, so the field reads as shattered rock, not tiles
  const pxm = N / w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0, n = Math.round((w * d) / 260); i < n; i++) {
    let x = rand() * N, y = rand() * N, a = rand() * Math.PI * 2;
    ctx.strokeStyle = `rgba(40,38,36,${0.35 + rand() * 0.35})`;
    ctx.lineWidth = crack * pxm * (0.8 + rand() * 1.2);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let sgm = 0, m = 3 + Math.floor(rand() * 5); sgm < m; sgm++) {
      a += (rand() - 0.5) * 1.1;
      const len = (2 + rand() * 5) * pxm;
      x += Math.cos(a) * len; y += Math.sin(a) * len;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.004;
  mesh.receiveShadow = true;
  g.add(mesh);
  return g;
}

/** Refresh every visible mirrored balloon's reflection for this renderer (call right before rendering). */
export function updateMirrors(renderer, scene, groups) {
  for (const g of groups) {
    const m = g.userData.mirror;
    if (!m || !g.visible) continue;
    g.updateMatrixWorld(true);
    m.centre.getWorldPosition(m.cam.position);
    m.cam.rotation.set(0, g.userData.anim?.reflTurn || 0, 0); // +yaw on the capture = world appears turned clockwise
    m.cam.updateMatrixWorld(true);
    g.visible = false;
    m.cam.update(renderer, scene);
    g.visible = true;
  }
}

// Flat sign board: coloured box with Korean/any text painted on the +Z face (and optionally stacked vertically).
function buildSign(o) {
  const g = new THREE.Group();
  const [w, h, d] = o.size || [3, 0.8, 0.1];
  const text = String(o.text ?? o.name ?? '');
  const PX = 256; // px per metre
  const cw = Math.max(64, Math.min(4096, Math.round(w * PX))), ch = Math.max(64, Math.min(4096, Math.round(h * PX)));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = o.color || '#1faa59';
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = o.textColor || '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const family = '"Pretendard","Apple SD Gothic Neo","Noto Sans KR","Noto Sans CJK KR","Malgun Gothic",sans-serif';
  const chars = Array.from(text);
  if (o.vertical) {
    const fs = Math.min(cw * 0.8, (ch * 0.92) / Math.max(1, chars.length));
    ctx.font = `800 ${fs}px ${family}`;
    chars.forEach((chr, i) => ctx.fillText(chr, cw / 2, ch * 0.04 + fs * (i + 0.5)));
  } else {
    let fs = ch * 0.62;
    ctx.font = `800 ${fs}px ${family}`;
    const m = ctx.measureText(text).width;
    if (m > cw * 0.92) { fs *= (cw * 0.92) / m; ctx.font = `800 ${fs}px ${family}`; }
    ctx.fillText(text, cw / 2, ch / 2 + fs * 0.04);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const side = new THREE.MeshBasicMaterial({ color: o.color || '#1faa59' });
  const front = new THREE.MeshBasicMaterial({ map: tex });
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [side, side, side, side, front, side]));
  m.position.y = h / 2;
  g.add(m);
  return g;
}


// ---------------------------------------------------------------------------
// Ballpark: home plate at the origin, second base toward -Z (27.43 m base paths),
// an outfield wall arc and a stepped bowl of stands packed with instanced spectators.
const BASE = 27.43 / Math.SQRT2;
const WALL_C = [0, -25]; // centre of the outfield wall arc (x, z)
const WALL_R = 97;

// The whole playing surface (grass, mowing stripes, dirt, base paths, lines) is painted into one
// texture on a single plane: no stacked coplanar layers, so nothing can z-fight at any distance.
const FIELD = { x0: -125, z0: -140, w: 250, d: 250, px: 4096 };

function paintField(grassColor) {
  const c = document.createElement('canvas');
  c.width = c.height = FIELD.px;
  const ctx = c.getContext('2d');
  const k = FIELD.px / FIELD.w;
  ctx.setTransform(k, 0, 0, k, -FIELD.x0 * k, -FIELD.z0 * k); // draw in metres (x, z)
  const disc = (x, z, r, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, z, r, 0, Math.PI * 2); ctx.fill(); };
  ctx.fillStyle = '#2f6a2b';
  ctx.fillRect(FIELD.x0, FIELD.z0, FIELD.w, FIELD.d);
  disc(WALL_C[0], WALL_C[1], WALL_R, grassColor);
  // mowing stripes, clipped to the fair/foul grass inside the wall
  ctx.save();
  ctx.beginPath(); ctx.arc(WALL_C[0], WALL_C[1], WALL_R - 4.5, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  for (let x = -130; x < 130; x += 9) ctx.fillRect(x, -140, 4.5, 260);
  ctx.restore();
  ctx.strokeStyle = '#8a6a4a'; ctx.lineWidth = 4.5;
  ctx.beginPath(); ctx.arc(WALL_C[0], WALL_C[1], WALL_R - 2.25, 0, Math.PI * 2); ctx.stroke();
  disc(0, -18.44, 29, '#9a7454');
  ctx.save();
  ctx.translate(0, -BASE); ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#468f3d'; ctx.fillRect(-12.6, -12.6, 25.2, 25.2);
  ctx.restore();
  const bases = [[0, 0], [BASE, -BASE], [0, -2 * BASE], [-BASE, -BASE]];
  ctx.strokeStyle = '#9a7454'; ctx.lineWidth = 1.8; ctx.lineCap = 'square';
  ctx.beginPath();
  bases.forEach(([x, z], i) => (i ? ctx.lineTo(x, z) : ctx.moveTo(x, z)));
  ctx.closePath(); ctx.stroke();
  disc(0, 0, 4, '#9a7454');
  disc(0, -18.44, 2.9, '#9a7454');
  ctx.strokeStyle = '#ecebe5'; ctx.lineWidth = 0.1;
  ctx.beginPath();
  ctx.moveTo(-113 * Math.SQRT1_2, -113 * Math.SQRT1_2); ctx.lineTo(0, 0); ctx.lineTo(113 * Math.SQRT1_2, -113 * Math.SQRT1_2);
  ctx.stroke();
  ctx.lineWidth = 0.08; // batter's boxes
  for (const sx of [-1, 1]) ctx.strokeRect(sx * 0.9 - (sx < 0 ? 1.22 : 0), -0.9, 1.22, 1.83);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Closed outline of the stands' front edge (x, z), wound around the field.
function standOutline() {
  const pts = [];
  const u1 = [Math.SQRT1_2, -Math.SQRT1_2], u3 = [-Math.SQRT1_2, -Math.SQRT1_2];
  const n1 = [Math.SQRT1_2, Math.SQRT1_2], n3 = [-Math.SQRT1_2, Math.SQRT1_2];
  const off = 20, poleS = 113;
  // outfield bleachers just behind the wall, right-field pole -> left-field pole
  const th = (p) => Math.atan2(p[0] - WALL_C[0], p[1] - WALL_C[1]);
  const a0 = th([u1[0] * poleS, u1[1] * poleS]), a1 = th([u3[0] * poleS, u3[1] * poleS]) + Math.PI * 2;
  for (let i = 0; i <= 40; i++) {
    const a = a0 + ((a1 - a0) * i) / 40;
    pts.push([WALL_C[0] + Math.sin(a) * (WALL_R + 2.5), WALL_C[1] + Math.cos(a) * (WALL_R + 2.5)]);
  }
  for (let s = poleS; s >= 0; s -= 8) pts.push([u3[0] * s + n3[0] * off, u3[1] * s + n3[1] * off]);
  const b0 = Math.atan2(n3[0], n3[1]), b1 = Math.atan2(n1[0], n1[1]);
  for (let i = 1; i < 10; i++) {
    const b = b0 + ((b1 - b0) * i) / 10;
    pts.push([Math.sin(b) * off, Math.cos(b) * off]);
  }
  for (let s = 0; s <= poleS; s += 8) pts.push([u1[0] * s + n1[0] * off, u1[1] * s + n1[1] * off]);
  return pts;
}

function outwardNormals(pts) {
  const F = [0, -35];
  return pts.map((p, i) => {
    const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    let nx = tz, nz = -tx;
    if (nx * (p[0] - F[0]) + nz * (p[1] - F[1]) < 0) { nx = -nx; nz = -nz; }
    return [nx, nz];
  });
}

function buildBallpark(o) {
  const g = new THREE.Group();
  const rand = rng(o.id + 'park');
  // --- playing field: one painted plane, lifted with a polygon offset over the app's ground
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD.w, FIELD.d),
    new THREE.MeshStandardMaterial({ map: paintField(o.color || '#3d7a35'), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }),
  );
  field.rotation.x = -Math.PI / 2;
  field.position.set(FIELD.x0 + FIELD.w / 2, 0.012, FIELD.z0 + FIELD.d / 2);
  field.receiveShadow = true;
  g.add(field);
  const bases = [[0, 0], [BASE, -BASE], [0, -2 * BASE], [-BASE, -BASE]];
  const white = std('#f2f0ea', { roughness: 0.6 });
  for (const s of [-1, 1]) {
    const pole = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 22, 10), std('#f4c430')));
    pole.position.set(s * 113 * Math.SQRT1_2, 11, -113 * Math.SQRT1_2);
    g.add(pole);
  }
  for (const [x, z] of bases.slice(1)) {
    const bag = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.08, 0.38), white));
    bag.position.set(x, 0.07, z);
    bag.rotation.y = Math.PI / 4;
    g.add(bag);
  }
  const plateShape = new THREE.Shape([[0.216, 0], [0.216, -0.216], [0, -0.43], [-0.216, -0.216], [-0.216, 0]].map(([x, y]) => new THREE.Vector2(x, y)));
  const plate = new THREE.Mesh(new THREE.ShapeGeometry(plateShape), new THREE.MeshBasicMaterial({ color: '#f2f0ea', polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16 }));
  plate.rotation.x = -Math.PI / 2;
  plate.position.set(0, 0.04, 0.2);
  g.add(plate);
  const mound = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.9, 0.25, 40), std('#9a7454', { roughness: 0.95 })));
  mound.position.set(0, 0.125, -18.44);
  g.add(mound);
  const rubber = new THREE.Mesh(new THREE.BoxGeometry(0.61, 0.03, 0.15), white);
  rubber.position.set(0, 0.26, -18.44);
  g.add(rubber);

  // --- outfield wall (padded, dark green)
  const th = (x, z) => Math.atan2(x - WALL_C[0], z - WALL_C[1]);
  const t0 = th(113 * Math.SQRT1_2, -113 * Math.SQRT1_2), t1 = th(-113 * Math.SQRT1_2, -113 * Math.SQRT1_2) + Math.PI * 2;
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(WALL_R, WALL_R, 3.2, 160, 1, true, t0, t1 - t0), std('#1f4a33', { side: THREE.DoubleSide }));
  wall.position.set(WALL_C[0], 1.6, WALL_C[1]);
  wall.receiveShadow = true;
  g.add(wall);

  // --- stepped stands
  const ROWS = 24, DEPTH = 0.85, RISE = 0.46, Y0 = 1.3, SEAT = 0.62;
  const base = standOutline();
  const nrm = outwardNormals(base);
  const ring = (k) => base.map((p, i) => [p[0] + nrm[i][0] * k * DEPTH, p[1] + nrm[i][1] * k * DEPTH]);
  const tread = [], riser = [];
  const quad = (arr, a, b, c, d) => arr.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let k = 0; k <= ROWS; k++) {
    const inner = ring(k), outer = ring(k + 1);
    const y = Y0 + k * RISE, yPrev = k === 0 ? 0 : Y0 + (k - 1) * RISE;
    for (let i = 0; i < base.length - 1; i++) {
      const a = inner[i], b = inner[i + 1], c = outer[i + 1], d = outer[i];
      if (k < ROWS) quad(tread, [a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], [d[0], y, d[1]]);
      quad(riser, [a[0], yPrev, a[1]], [b[0], yPrev, b[1]], [b[0], k === ROWS ? 0 : y, b[1]], [a[0], k === ROWS ? 0 : y, a[1]]);
      if (k === ROWS) quad(riser, [a[0], yPrev, a[1]], [b[0], yPrev, b[1]], [b[0], yPrev + 7, b[1]], [a[0], yPrev + 7, a[1]]);
    }
  }
  for (const [arr, color] of [[tread, '#5b6068'], [riser, '#3e434b']]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, std(color, { side: THREE.DoubleSide, roughness: 0.9 }));
    m.receiveShadow = true;
    g.add(m);
  }

  // --- spectators: one instanced body + one instanced head per seat
  const seats = [];
  for (let k = 0; k < ROWS; k++) {
    const mid = ring(k + 0.45), y = Y0 + k * RISE;
    let carry = rand() * SEAT;
    for (let i = 0; i < mid.length - 1; i++) {
      const a = mid[i], b = mid[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = nrm[i];
      for (let d = carry; d < len; d += SEAT) {
        const f = d / len;
        if (rand() < 0.97) seats.push([a[0] + (b[0] - a[0]) * f, y, a[1] + (b[1] - a[1]) * f, Math.atan2(-n[0], -n[1])]);
      }
      carry = (carry - len % SEAT + SEAT) % SEAT;
    }
  }
  const shirts = ['#2a4f9e', '#2a4f9e', '#f1f1ee', '#f1f1ee', '#c8323c', '#1c2333', '#1c2333', '#7b8794', '#e3b23c', '#2f6b4f'];
  const skins = ['#e8c4a0', '#d6a77a', '#b07d56', '#f0d2b4', '#2a2a2a', '#3a2c22'];
  const body = new THREE.InstancedMesh(new THREE.BoxGeometry(0.44, 0.62, 0.3), std('#ffffff', { roughness: 0.85 }), seats.length);
  const head = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.24, 0.22), std('#ffffff', { roughness: 0.8 }), seats.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(1, 1, 1);
  const col = new THREE.Color();
  seats.forEach(([x, y, z, yaw], i) => {
    const lean = (rand() - 0.5) * 0.3;
    q.setFromAxisAngle(up, yaw + lean);
    const s = 0.9 + rand() * 0.2;
    sc.set(s, s, s);
    m4.compose(new THREE.Vector3(x, y + 0.31 * s, z), q, sc);
    body.setMatrixAt(i, m4);
    m4.compose(new THREE.Vector3(x, y + 0.76 * s, z), q, sc);
    head.setMatrixAt(i, m4);
    body.setColorAt(i, col.set(shirts[Math.floor(rand() * shirts.length)]));
    head.setColorAt(i, col.set(rand() < 0.22 ? shirts[Math.floor(rand() * 3)] : skins[Math.floor(rand() * skins.length)]));
  });
  for (const m of [body, head]) {
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    g.add(m);
  }
  g.userData.crowd = seats.length;

  // --- light towers and scoreboard on the back rim
  const rim = ring(ROWS + 2);
  const lampMat = new THREE.MeshBasicMaterial({ color: '#fbfcff' });
  const steel = std('#3a3e45', { metalness: 0.4, roughness: 0.5 });
  for (const f of [0.08, 0.3, 0.5, 0.62, 0.78, 0.94]) {
    const p = rim[Math.floor(f * (rim.length - 1))];
    const hTop = Y0 + ROWS * RISE + 26;
    const mast = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, hTop, 10), steel));
    mast.position.set(p[0], hTop / 2, p[1]);
    g.add(mast);
    const bank = new THREE.Mesh(new THREE.BoxGeometry(9, 4, 0.6), lampMat);
    bank.position.set(p[0], hTop + 1.5, p[1]);
    bank.lookAt(0, 0, -30);
    g.add(bank);
  }
  const back = rim[Math.floor(rim.length * 0.24)];
  const board = shadowed(new THREE.Mesh(new THREE.BoxGeometry(34, 14, 1.5), std('#15181d')));
  board.position.set(back[0] * 1.02, Y0 + ROWS * RISE + 10, back[1] * 1.02);
  board.lookAt(0, board.position.y, 0);
  g.add(board);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(31, 11), new THREE.MeshBasicMaterial({ color: '#1d3f78' }));
  screen.position.copy(board.position).add(new THREE.Vector3(0, 0, 0.8).applyQuaternion(board.quaternion));
  screen.quaternion.copy(board.quaternion);
  g.add(screen);
  return g;
}

function buildBaseball() {
  const g = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.037, 16, 12), std('#f4f1ea', { roughness: 0.6 }));
  ball.castShadow = true;
  g.add(ball);
  return g;
}

export function buildObject(o) {
  let g;
  switch (o.type) {
    case 'ballpark': g = buildBallpark(o); break;
    case 'baseball': g = buildBaseball(o); break;
    case 'mballoon': g = buildBalloon(o, true); break;
    case 'clouds': g = buildClouds(o); break;
    case 'crackfloor': g = buildCrackFloor(o); break;
    case 'actor': g = buildActor(o); break;
    case 'car': g = buildCar(o); break;
    case 'tree': g = buildTree(o); break;
    case 'table': g = buildTable(o); break;
    case 'mark': g = buildMark(o); break;
    case 'sign': g = buildSign(o); break;
    case 'drums': g = buildDrums(o); break;
    case 'keyboard': g = buildKeyboard(o); break;
    case 'micstand': g = buildMicStand(o); break;
    case 'balloon': g = buildBalloon(o); break;
    case 'slab': g = buildSlab(o); break;
    case 'debris': g = buildDebris(o); break;
    case 'dust': g = buildDust(o); break;
    case 'metronome': g = buildMetronome(o); break;
    case 'cylinder': {
      g = new THREE.Group();
      const [w, h] = o.size;
      const m = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 24), o.flat ? new THREE.MeshBasicMaterial({ color: o.color }) : std(o.color)));
      m.position.y = h / 2;
      g.add(m);
      break;
    }
    default: {
      g = new THREE.Group();
      const [w, h, d] = o.size || [1, 1, 1];
      const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), o.flat ? new THREE.MeshBasicMaterial({ color: o.color }) : std(o.color)));
      m.position.y = h / 2;
      g.add(m);
    }
  }
  g.userData.objId = o.id;
  g.userData.sig = signature(o);
  return g;
}

// Rebuild is needed whenever any of these change.
export function signature(o) {
  return JSON.stringify([o.type, o.name, o.color, o.height, o.size, o.hold, o.tilt, o.burstBeat, o.text, o.textColor, o.vertical, o.flat, o.rotX, o.rotZ]);
}

export function poseWalk(group, dist, speed) {
  applyPose(group, 'stand', dist, speed, 0);
}

// ---------------------------------------------------------------------------

export function buildGround() {
  const g = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({ color: '#6b6e70', roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.userData.isGround = true;
  g.add(ground);
  const grid = new THREE.GridHelper(100, 100, 0x3a3d40, 0x55585b);
  grid.position.y = 0.002;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  g.add(grid);
  g.userData.ground = ground;
  g.userData.grid = grid;
  return g;
}

export function buildLights(scene) {
  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x55504a, 1.2);
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 120;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(hemi, sun, sun.target);
  return { hemi, sun };
}

const LIGHT_PRESETS = {
  day: { sky: '#a9c6e8', fog: [40, 180], hemi: ['#e3eeff', '#5a554c', 1.3], sun: ['#fff6e8', 2.8, [12, 22, 9]], ground: '#6f7173' },
  golden: { sky: '#e9b27c', fog: [30, 150], hemi: ['#ffd6a8', '#3d3128', 0.9], sun: ['#ffb062', 3.2, [-20, 5, -8]], ground: '#6b6159' },
  overcast: { sky: '#b8bcc2', fog: [25, 120], hemi: ['#e8ecf0', '#55575a', 2.0], sun: ['#ffffff', 0.5, [5, 20, 5]], ground: '#696b6d' },
  night: { sky: '#0b1020', fog: [15, 80], hemi: ['#4a5d8a', '#101010', 0.45], sun: ['#9db4ff', 0.9, [-8, 18, -12]], ground: '#2c2e32' },
  interior: { sky: '#26282c', fog: [30, 90], hemi: ['#fff4e6', '#3a3632', 1.0], sun: ['#ffe6c8', 2.2, [4, 10, 6]], ground: '#4b4844' },
  amber: { sky: '#7a5a38', fog: [8, 45], hemi: ['#ffcf8f', '#3a2a1c', 1.1], sun: ['#ffb45e', 2.4, [-6, 8, 5]], ground: '#5a4836' },
  sunbreak: { sky: '#9ea3aa', fog: [25, 120], hemi: ['#dfe4ea', '#4d4f52', 1.3], sun: ['#ffdc96', 3.0, [-4, 26, 10]], ground: '#6b6d6f' },
  // night game: black sky, hard cool-white key from high floodlights, long fog so the far stands stay visible
  stadium: { sky: '#070b16', fog: [120, 520], hemi: ['#c4d0ff', '#1b2a18', 1.0], sun: ['#f3f6ff', 3.6, [14, 42, 18]], ground: '#1f2b1d' },
  // off-white paper sky, soft even light: closest to the graphite-on-paper key frames
  paper: { sky: '#e6e3dc', fog: [30, 160], hemi: ['#f4f3ef', '#77746f', 2.2], sun: ['#ffffff', 0.6, [6, 22, 8]], ground: '#9b978f' },
};

export function applyLighting(scene, lights, ground, name) {
  const p = LIGHT_PRESETS[name] || LIGHT_PRESETS.day;
  scene.background = new THREE.Color(p.sky);
  scene.fog = new THREE.Fog(p.sky, p.fog[0], p.fog[1]);
  lights.hemi.color.set(p.hemi[0]);
  lights.hemi.groundColor.set(p.hemi[1]);
  lights.hemi.intensity = p.hemi[2];
  lights.sun.color.set(p.sun[0]);
  lights.sun.intensity = p.sun[1];
  lights.sun.position.set(...p.sun[2]);
  ground.userData.ground.material.color.set(p.ground);
}

// Visible camera body for the director view (lens points down -Z like a THREE camera).
export function buildCameraRig() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#e8453c', roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: '#202225', roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.3), mat);
  body.position.z = 0.1;
  g.add(body);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.16, 16), dark);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = -0.12;
  g.add(lens);
  for (const z of [0.02, 0.2]) {
    const mag = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.04, 18), dark);
    mag.rotation.z = Math.PI / 2;
    mag.position.set(0, 0.16, z);
    g.add(mag);
  }
  g.traverse((m) => { m.userData.pick = 'camera'; });
  return g;
}
