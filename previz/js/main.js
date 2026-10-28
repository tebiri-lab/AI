import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { SIZES, ANGLES, DIRS, MOVES, SENSORS, ASPECTS, LIGHTS, OBJ_TYPES, ACTOR_COLORS, POSE_SETS, HOLDS } from './constants.js';
import { sampleCamera, resolveCamera, lockTarget, sampleObject, sampleLocal, worldToLocal, ancestors, setObjects, sortKeys, keyIndexAt } from './anim.js';
import { generateShot, parseShotText, describeShot, defaultParams, objectHeight, aimOffset } from './generator.js';
import { buildObject, signature, applyPose, buildGround, buildLights, applyLighting, buildCameraRig, updateMirrors } from './scene.js';
import { exportPNG, encodeVideo, saveBlob, exportGLB, exportPrompts, exportJSON, downloadText } from './export.js';
import { SongPlayer } from './audio.js';
import { CymbalPhysics } from './physics.js';
import { idbGet, idbSet, idbDel } from './store.js';

// ---------------------------------------------------------------------------
// Helpers

const $ = (id) => document.getElementById(id);
const uid = () => Math.random().toString(36).slice(2, 9);
const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r3 = (n) => Math.round(n * 1000) / 1000;
const vArr = (v) => [r3(v.x), r3(v.y), r3(v.z)];
const isTyping = () => {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function fillSelect(sel, entries, label = (v) => v.ko) {
  sel.innerHTML = '';
  for (const [k, v] of entries) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = typeof v === 'string' ? v : label(v);
    sel.appendChild(o);
  }
}

// ---------------------------------------------------------------------------
// Project model

function makeObject(type, overrides = {}) {
  const def = OBJ_TYPES[type];
  const o = { id: uid(), type, name: def.ko, color: def.color, pos: [0, 0, 0], rotY: 0 };
  if (def.height) o.height = def.height;
  if (def.size) o.size = def.size.slice();
  if (def.tilt) o.tilt = 0;
  if (type === 'actor') o.hold = 'none';
  if (def.text) o.text = def.text;
  return Object.assign(o, overrides);
}

function makeShot(gen, extra = {}) {
  return {
    id: uid(), name: gen.name, duration: gen.duration, desc: '', ease: gen.ease, shake: gen.shake,
    keys: gen.keys, anim: gen.anim, genAnim: Object.keys(gen.anim), meta: gen.meta, ...extra,
  };
}

function baseProject(name) {
  return {
    version: 1, name, fps: 24, aspect: 2.39, sensor: 's35', lighting: 'day',
    style: 'Photorealistic live-action footage, natural lighting, subtle film grain, realistic motion blur.',
    audio: { name: '', offset: 0 }, bpm: 0, beat0: 0, sections: [], assets: {},
    objects: [], shots: [],
  };
}

function sampleProject() {
  const p = baseProject('골목 대치 씬 — 예제');
  const A = makeObject('actor', { name: '배우A', color: ACTOR_COLORS[0], pos: [-1.1, 0, 0], rotY: 90 });
  const B = makeObject('actor', { name: '배우B', color: ACTOR_COLORS[1], pos: [1.1, 0, 0], rotY: -90, height: 1.82 });
  p.objects.push(
    A, B,
    makeObject('car', { name: '자동차', pos: [-4.5, 0, -3.2], rotY: 90 }),
    makeObject('box', { name: '건물1', pos: [-7, 0, -11], size: [8, 9, 6], color: '#7d756b' }),
    makeObject('box', { name: '건물2', pos: [6, 0, -12], size: [7, 14, 7], color: '#8b8f96' }),
    makeObject('wall', { name: '담벼락', pos: [1.5, 0, -5], size: [10, 2.4, 0.25] }),
    makeObject('cylinder', { name: '가로등', pos: [3.6, 0, 2.2], size: [0.18, 4.5, 0.18], color: '#3c3f44' }),
    makeObject('tree', { name: '나무', pos: [-3, 0, 5.5], height: 5.5 }),
    makeObject('mark', { name: 'A 마크', pos: [-1.1, 0, 0] }),
  );
  const P = (o) => ({ ...defaultParams(), ...o });
  const specs = [
    [P({ subject: A.id, subject2: B.id, size: 'ws', angle: 'high', dir: 'ql', move: 'crane_down', lens: 24, duration: 5 }), '좁은 골목, 두 사람이 마주 서 있다'],
    [P({ subject: A.id, subject2: B.id, size: 'mcu', dir: 'ots', move: 'push', speed: 'slow', lens: 50, duration: 4 }), '배우A가 입을 연다'],
    [P({ subject: B.id, subject2: A.id, size: 'cu', angle: 'low', dir: 'qr', move: 'static', lens: 85, duration: 3, handheld: true }), '배우B의 굳은 표정'],
    [P({ subject: A.id, size: 'ms', angle: 'eye', dir: 'side', move: 'orbit_r', speed: 'slow', lens: 40, duration: 5 }), '긴장감이 고조된다'],
    [P({ subject: B.id, subject2: A.id, size: 'fs', dir: 'front', move: 'whip_l', lens: 35, duration: 3 }), '배우B가 고개를 돌린다'],
  ];
  for (const [params, desc] of specs) p.shots.push(makeShot(generateShot(params, p), { desc }));
  return p;
}

// Packed ballpark, time frozen: only the runner stealing third moves (in high-speed slow motion)
// while the camera orbits him in one direction for 10 s.
function stadiumProject() {
  const p = baseProject('야구장 도루 — 불릿타임');
  p.lighting = 'stadium';
  p.style = 'Photorealistic live-action night baseball game under stadium floodlights, sold-out crowd. '
    + 'Frozen-time bullet-time moment: the crowd, fielders, umpires and the ball hang perfectly still; '
    + 'only the runner moves, in ultra high-speed slow motion (1000 fps look), dust lifting from his cleats. '
    + 'Subtle film grain, anamorphic lens flares from the light towers.';
  const B = 27.43 / Math.SQRT2;
  const B2 = [0, 0, -2 * B], B3 = [-B, 0, -B];
  const dir = [-Math.SQRT1_2, Math.SQRT1_2]; // 2nd -> 3rd base on the ground plane
  const yawTo = (from, to) => r3(THREE.MathUtils.radToDeg(Math.atan2(to[0] - from[0], to[2] - from[2])));
  const home = [0, 0, 0];
  const offense = '#e9e5dc', defense = '#2c3e66';
  const park = makeObject('ballpark', { name: '야구장' });
  const runner = makeObject('actor', { name: '주자', color: offense, height: 1.83, pose: 'run', rotY: -45, pos: [B2[0] + dir[0] * 8, 0, B2[2] + dir[1] * 8] });
  const third = [-B + 1.1, 0, -B - 0.6];
  const fielder = (name, pos, pose = 'field_ready', face = home) => makeObject('actor', { name, color: defense, pose, pos, rotY: yawTo(pos, face) });
  const catcherPos = [0, 0, 1.0];
  const ball = makeObject('baseball', { name: '야구공 (공중 정지)', pos: [r3(-B * 0.55), 2.15, r3(catcherPos[2] + (-B - catcherPos[2]) * 0.55)] });
  p.objects.push(
    park,
    runner,
    fielder('3루수', third, 'field_ready', catcherPos),
    fielder('유격수', [-9.5, 0, -33], 'field_ready'),
    fielder('2루수', [9.5, 0, -33], 'field_ready'),
    fielder('1루수', [B - 1.5, 0, -B - 2], 'field_ready'),
    fielder('투수', [0, 0.25, -18.2], 'stand'),
    fielder('포수', catcherPos, 'throw', B3),
    fielder('좌익수', [-30, 0, -72]),
    fielder('중견수', [0, 0, -88]),
    fielder('우익수', [30, 0, -72]),
    makeObject('actor', { name: '주심', color: '#1d1f24', pose: 'field_ready', pos: [0, 0, 2.3], rotY: 180 }),
    makeObject('actor', { name: '3루심', color: '#1d1f24', pose: 'field_ready', pos: [-B - 4, 0, -B + 5], rotY: yawTo([-B - 4, 0, -B + 5], [-B, 0, -B]) }),
    makeObject('actor', { name: '3루 코치', color: offense, pose: 'reach_up', pos: [-B - 6, 0, -B + 9], rotY: yawTo([-B - 6, 0, -B + 9], runner.pos) }),
    ball,
  );

  // Runner covers 9.5 m in 10 s (~8x slower than a real 8.5 m/s sprint): high-speed slow motion.
  const dur = 10, run = 9.5;
  const at = (t) => [runner.pos[0] + dir[0] * run * (t / dur), 0, runner.pos[2] + dir[1] * run * (t / dur)];
  const anim = { [runner.id]: [
    { t: 0, pos: runner.pos.map(r3), rotY: -45 },
    { t: dur, pos: at(dur).map(r3), rotY: -45 },
  ] };
  // Two full turns in one direction (720° in 10 s) at a constant distance, centred on the runner.
  // Start point, height and distance come from the framing tuned in the app: the first key sits at
  // (x -7.709, y 2.45, z -22.3), about 11 m from the runner.
  const H = 2.45, aim = 1.0, turns = 2, keys = [];
  const c0 = at(0), start = [-7.709, -22.3];
  const R = Math.hypot(start[0] - c0[0], start[1] - c0[2]);
  const az0 = Math.atan2(start[0] - c0[0], start[1] - c0[2]);
  for (let t = 0; t <= dur + 1e-6; t += 0.25) {
    const c = at(t);
    const az = az0 + (Math.PI * 2 * turns * t) / dur;
    keys.push({
      t: r3(t),
      pos: [r3(c[0] + Math.sin(az) * R), H, r3(c[2] + Math.cos(az) * R)],
      target: [r3(c[0]), aim, r3(c[2])],
      focal: 24,
      roll: 0,
    });
  }
  p.shots.push({
    id: uid(), name: '도루 · 불릿타임 2회전 오빗', duration: dur, ease: 'linear', shake: 0,
    desc: '만원 관중의 야구장, 시간이 멈춘 순간 2루 주자만 3루를 향해 초고속 슬로모션으로 질주한다. 관중·수비수·심판·공중의 공은 완전히 정지해 있고, 카메라는 주자와 같은 거리를 유지하며 주자를 중심으로 한 방향으로 10초 동안 두 바퀴 돈다.',
    keys, anim, genAnim: [], lookAt: { id: runner.id, offset: [0, aim, 0] },
    meta: { subject: runner.id, size: 'fs', angle: 'eye', dir: 'side', move: 'orbit_360', speed: 'fast', lens: 24, duration: dur },
  });
  return p;
}

const SAMPLES = { alley: sampleProject, stadium: stadiumProject };

function blankProject() {
  const p = baseProject('새 프리비즈');
  const A = makeObject('actor', { name: '배우A' });
  p.objects.push(A);
  p.shots.push(makeShot(generateShot({ ...defaultParams(), subject: A.id, size: 'ms', move: 'static' }, p)));
  return p;
}

function normalizeProject(p) {
  if (!p || !Array.isArray(p.objects) || !Array.isArray(p.shots)) throw new Error('프로젝트 형식이 아닙니다');
  const base = baseProject(p.name || '프리비즈');
  const out = { ...base, ...p };
  out.aspect = +out.aspect || 2.39;
  out.fps = +out.fps || 24;
  out.audio = { name: '', offset: 0, ...(p.audio || {}) };
  out.audio.offset = +out.audio.offset || 0;
  out.bpm = +out.bpm || 0;
  out.beat0 = +out.beat0 || 0;
  out.sections = Array.isArray(p.sections) ? p.sections.filter((x) => x && Number.isFinite(+x.t)).map((x) => ({ t: +x.t, name: String(x.name || '') })) : [];
  out.assets = p.assets && typeof p.assets === 'object' ? p.assets : {};
  const ids = new Set(out.objects.map((o) => o.id));
  for (const o of out.objects) if (o.parent && !ids.has(o.parent)) delete o.parent;
  for (const s of out.shots) {
    s.id ||= uid();
    s.keys ||= [];
    s.anim ||= {};
    s.genAnim ||= [];
    s.meta ||= {};
    s.ease ||= 'inout';
    s.shake ||= 0;
    s.desc ||= '';
    sortKeys(s.keys);
  }
  if (!out.shots.length) out.shots.push({ id: uid(), name: '샷', duration: 4, desc: '', ease: 'inout', shake: 0, keys: [], anim: {}, genAnim: [], meta: {} });
  return out;
}

// ---------------------------------------------------------------------------
// State

let project;
let shotIdx = 0;
let time = 0;
let playing = false;
let selection = null; // {kind:'object', id} | {kind:'camera'} | {kind:'target'}
let dragging = false;
let exportJob = null; // { cancelled } while a video export is rendering
const undoStack = [];
const redoStack = [];
const cur = () => project.shots[shotIdx];
const objById = (id) => project.objects.find((o) => o.id === id);
const frameTol = () => 0.5 / project.fps;
const aspect = () => +project.aspect;
const sensorW = () => (SENSORS[project.sensor] || SENSORS.s35).w;

// Reference images live in project.assets and are kept out of undo snapshots.
function snapshot() {
  return JSON.stringify({ project: { ...project, assets: undefined }, shotIdx });
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}
function restore(snap) {
  const s = JSON.parse(snap);
  const assets = project.assets || {};
  project = s.project;
  project.assets = assets;
  shotIdx = clamp(s.shotIdx, 0, project.shots.length - 1);
  if (selection?.kind === 'object' && !objById(selection.id)) select(null);
  refresh();
}
function undo() {
  if (!undoStack.length) return toast('더 이상 되돌릴 수 없습니다');
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

function mutate(fn) {
  pushUndo();
  fn();
  refresh();
}

// Pushes one undo snapshot per continuous edit (e.g. slider drag).
function liveInput(el, apply, { full = false } = {}) {
  let open = false;
  el.addEventListener('input', () => {
    if (!open) { pushUndo(); open = true; }
    apply(el);
    full ? refresh() : softRefresh();
  });
  el.addEventListener('change', () => {
    open = false;
    refresh();
  });
}

let saveTimer;
let assetsDirty = false;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('previz.project.v1', JSON.stringify({ ...project, assets: undefined })); } catch { /* storage unavailable */ }
    if (assetsDirty) {
      assetsDirty = false;
      idbSet('assets', project.assets || {});
    }
  }, 400);
}

// Project copy for saving: only the reference images still in use.
function exportable() {
  const used = new Set(project.shots.map((s) => s.ref).filter(Boolean));
  const assets = {};
  for (const k of used) if (project.assets?.[k]) assets[k] = project.assets[k];
  return { ...project, assets };
}

// ---------------------------------------------------------------------------
// Song time

const song = new SongPlayer();
const shotStart = (i) => {
  let a = 0;
  for (let k = 0; k < i && k < project.shots.length; k++) a += project.shots[k].duration;
  return a;
};
const totalDur = () => project.shots.reduce((a, s) => a + s.duration, 0);
const offset = () => +project.audio?.offset || 0;
const globalTime = () => shotStart(shotIdx) + time;
const songTime = () => globalTime() + offset();
const beatLen = () => (project.bpm > 0 ? 60 / project.bpm : 0.65);
// Seconds since the first downbeat for (shot, t): drives metronomes and playing poses.
const clockFor = (shot, t) => shotStart(Math.max(0, project.shots.indexOf(shot))) + t + offset() - (project.beat0 || 0);

function fmtSong(t) {
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${neg ? '-' : ''}${m}:${s.toFixed(1).padStart(4, '0')}`;
}
function sectionAt(t) {
  let cur = null;
  for (const s of [...(project.sections || [])].sort((a, b) => a.t - b.t)) if (s.t <= t + 1e-6) cur = s;
  return cur;
}
function startAudio() {
  if (song.loaded) song.play(songTime());
}

// ---------------------------------------------------------------------------
// Three.js setup

const scene = new THREE.Scene();
const ground = buildGround();
scene.add(ground);
const lights = buildLights(scene);
const objRoot = new THREE.Group();
scene.add(objRoot);
const dirOnly = new THREE.Group();
scene.add(dirOnly);

const directorCanvas = $('directorCanvas');
const shotCanvas = $('shotCanvas');
const dirRenderer = new THREE.WebGLRenderer({ canvas: directorCanvas, antialias: true });
const shotRenderer = new THREE.WebGLRenderer({ canvas: shotCanvas, antialias: true, preserveDrawingBuffer: true });
for (const r of [dirRenderer, shotRenderer]) {
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.0;
}
const thumbCanvas = document.createElement('canvas');
const thumbRenderer = new THREE.WebGLRenderer({ canvas: thumbCanvas, antialias: true, preserveDrawingBuffer: true });
thumbRenderer.shadowMap.enabled = true;
thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;

const dirCam = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
dirCam.position.set(9, 7, 11);
const orbit = new OrbitControls(dirCam, directorCanvas);
orbit.target.set(0, 1, 0);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;

const shotCam = new THREE.PerspectiveCamera(40, 2.39, 0.03, 2000);
const helperCam = new THREE.PerspectiveCamera(40, 2.39, 0.1, 2.2);
const camHelper = new THREE.CameraHelper(helperCam);
dirOnly.add(camHelper);
const rig = buildCameraRig();
dirOnly.add(rig);

// Editable handles: the gizmo moves these; they sit on the un-shaken camera path.
const camHandle = new THREE.Object3D();
dirOnly.add(camHandle);
const tgtHandle = new THREE.Mesh(
  new THREE.SphereGeometry(0.09, 16, 12),
  new THREE.MeshBasicMaterial({ color: '#ffd84a', depthTest: false, transparent: true, opacity: 0.9 }),
);
tgtHandle.renderOrder = 5;
tgtHandle.userData.pick = 'target';
dirOnly.add(tgtHandle);
const aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineDashedMaterial({ color: '#ffd84a', dashSize: 0.12, gapSize: 0.08 }));
dirOnly.add(aimLine);
const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#ff6a5c' }));
dirOnly.add(pathLine);
const keyPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: '#ffffff', size: 9, sizeAttenuation: false, depthTest: false }));
keyPoints.renderOrder = 6;
dirOnly.add(keyPoints);

const gizmo = new TransformControls(dirCam, directorCanvas);
gizmo.setSize(0.8);
const gizmoHelper = gizmo.getHelper();
dirOnly.add(gizmoHelper);
let gizmoMode = 'translate';

// Objects that must never appear in the shot camera.
function setDirectorOnlyVisible(v) {
  dirOnly.visible = v;
  objRoot.traverse((o) => { if (o.userData.directorOnly) o.visible = v; });
}

// Re-capture mirrored surfaces for one renderer (each renderer keeps its own GPU copy).
// Director aids are hidden so the camera body and labels never show up in a reflection.
function mirrorPass(renderer) {
  const groups = [];
  for (const g of meshes.values()) if (g.userData.mirror && g.visible) groups.push(g);
  if (!groups.length) return;
  const prev = dirOnly.visible;
  setDirectorOnlyVisible(false);
  updateMirrors(renderer, scene, groups);
  setDirectorOnlyVisible(prev);
}

// ---------------------------------------------------------------------------
// Scene sync

const meshes = new Map();

function syncScene() {
  setObjects(project.objects);
  const ids = new Set(project.objects.map((o) => o.id));
  for (const [id, g] of meshes) {
    if (!ids.has(id)) {
      if (gizmo.object === g) gizmo.detach();
      objRoot.remove(g);
      disposeTree(g);
      meshes.delete(id);
    }
  }
  for (const o of project.objects) {
    const g = meshes.get(o.id);
    if (g && g.userData.sig === signature(o)) continue;
    if (g) { objRoot.remove(g); disposeTree(g); }
    const ng = buildObject(o);
    objRoot.add(ng);
    meshes.set(o.id, ng);
    if (selection?.kind === 'object' && selection.id === o.id) gizmo.attach(ng);
  }
  litNow = '';
  setLight(project.lighting);
}

let litNow = '';
function setLight(name) {
  if (name === litNow) return;
  litNow = name;
  applyLighting(scene, lights, ground, name);
}

const defaultPose = (type) => Object.keys(POSE_SETS[type] || {})[0] || '';
const poseOf = (o, shot) => shot?.poses?.[o.id] || o.pose || defaultPose(o.type);

// Pose every object for (shot, t), then run the cymbal physics up to that moment (physics.js re-poses the
// objects on its own 240 Hz clock while it steps, and leaves them posed at t).
const physics = new CymbalPhysics();
function poseObjects(shot, t) {
  poseObjectsAt(shot, t);
  const c = clockFor(shot, t);
  physics.update(shot, c, clockFor(shot, 0), (tc) => poseObjectsAt(shot, t + (tc - c)), [...meshes.values()]);
}

// Pose every object for (shot, t): transform, visibility, pose and per-shot lighting.
function poseObjectsAt(shot, t) {
  const clock = clockFor(shot, t);
  const beat = beatLen();
  for (const o of project.objects) {
    const g = meshes.get(o.id);
    if (!g) continue;
    g.visible = !shot.hide?.[o.id];
    if (dragging && gizmo.object === g) continue;
    const s = sampleObject(o, shot, t);
    g.position.set(...s.pos);
    g.rotation.set(0, THREE.MathUtils.degToRad(s.rotY), 0);
    applyPose(g, poseOf(o, shot), s.dist, s.speed, clock, beat, { t, dur: shot.duration, c0: clock - t });
  }
  setLight(shot.light || project.lighting);
}

function disposeTree(g) {
  g.userData.mirror?.rt.dispose();
  g.traverse((m) => {
    m.geometry?.dispose();
    if (m.material) {
      m.material.map?.dispose();
      m.material.dispose();
    }
  });
}

function updatePath() {
  const shot = cur();
  const pts = [];
  const n = 120;
  for (let i = 0; i <= n; i++) pts.push(sampleCamera(shot, (shot.duration * i) / n, false).pos);
  pathLine.geometry.dispose();
  pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  keyPoints.geometry.dispose();
  keyPoints.geometry = new THREE.BufferGeometry().setFromPoints(shot.keys.map((k) => new THREE.Vector3(...k.pos)));
}

function applyCamera(cam, s, asp) {
  cam.aspect = asp;
  cam.filmGauge = sensorW();
  cam.setFocalLength(s.focal);
  cam.position.copy(s.pos);
  cam.up.set(0, 1, 0);
  cam.lookAt(s.target);
  if (s.roll) cam.rotateZ(THREE.MathUtils.degToRad(s.roll));
  cam.updateMatrixWorld(true);
}

// Pose every object and the shot camera for (shot, t).
function poseScene(shot, t) {
  poseObjects(shot, t);
  const cs = resolveCamera(shot, t, project.objects);
  applyCamera(shotCam, cs, aspect());
  return cs;
}

function updateDirectorAids(cs) {
  rig.position.copy(shotCam.position);
  rig.quaternion.copy(shotCam.quaternion);
  helperCam.position.copy(shotCam.position);
  helperCam.quaternion.copy(shotCam.quaternion);
  helperCam.aspect = shotCam.aspect;
  helperCam.fov = shotCam.fov;
  helperCam.far = clamp(cs.pos.distanceTo(cs.target), 1, 6);
  helperCam.updateProjectionMatrix();
  helperCam.updateMatrixWorld(true);
  camHelper.update();
  if (!(dragging && (selection?.kind === 'camera' || selection?.kind === 'target'))) {
    const clean = resolveCamera(cur(), time, project.objects, false);
    camHandle.position.copy(clean.pos);
    tgtHandle.position.copy(clean.target);
  }
  aimLine.geometry.setFromPoints([rig.position, tgtHandle.position]);
  aimLine.computeLineDistances();
}

// ---------------------------------------------------------------------------
// Viewport sizing

let layout = 'split';
function resize() {
  if (!project) return; // still booting
  const dp = $('directorPane');
  const dw = dp.clientWidth, dh = dp.clientHeight;
  if (dw > 0 && dh > 0) {
    dirRenderer.setSize(dw, dh, false);
    dirCam.aspect = dw / dh;
    dirCam.updateProjectionMatrix();
  }
  const sp = $('shotPane');
  const pw = sp.clientWidth - 24, ph = sp.clientHeight - 24;
  if (pw > 0 && ph > 0) {
    const a = aspect();
    let w = pw, h = pw / a;
    if (h > ph) { h = ph; w = ph * a; }
    const frame = $('shotFrame');
    frame.style.width = `${Math.floor(w)}px`;
    frame.style.height = `${Math.floor(h)}px`;
    shotRenderer.setSize(Math.floor(w), Math.floor(h), false);
  }
}
new ResizeObserver(resize).observe($('viewports'));
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Thumbnails

const thumbs = new Map();
const thumbQueue = new Set();
let thumbTimer;
function queueThumbs(all = false) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    if (all) project.shots.forEach((s) => thumbQueue.add(s.id));
    else thumbQueue.add(cur().id);
  }, 250);
}
function renderOneThumb() {
  const id = thumbQueue.values().next().value;
  thumbQueue.delete(id);
  const shot = project.shots.find((s) => s.id === id);
  if (!shot) return;
  const a = aspect();
  const w = 240, h = Math.round(Math.min(240 / a, 200));
  thumbRenderer.setSize(Math.round(h * a), h, false);
  const cs = resolveCamera(shot, 0, project.objects, false);
  poseObjects(shot, 0);
  const cam = new THREE.PerspectiveCamera();
  cam.near = 0.03; cam.far = 2000;
  applyCamera(cam, cs, a);
  setDirectorOnlyVisible(false);
  mirrorPass(thumbRenderer);
  thumbRenderer.render(scene, cam);
  setDirectorOnlyVisible(true);
  thumbs.set(id, thumbCanvas.toDataURL('image/jpeg', 0.8));
  const img = document.querySelector(`.shot-card[data-id="${id}"] img`);
  if (img) img.src = thumbs.get(id);
  void w;
}

// ---------------------------------------------------------------------------
// Render loop

let last = performance.now();
let hudCache = '';
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (exportJob) {
    // the export loop owns the scene while it renders; keep the UI still
    requestAnimationFrame(frame);
    return;
  }
  if (playing) advance(dt);

  if (thumbQueue.size) renderOneThumb();

  const shot = cur();
  const cs = poseScene(shot, time);
  updateDirectorAids(cs);
  orbit.update();

  if (layout !== 'camera') {
    setDirectorOnlyVisible(true);
    mirrorPass(dirRenderer);
    dirRenderer.render(scene, dirCam);
  }
  if (layout !== 'director') {
    setDirectorOnlyVisible(false);
    mirrorPass(shotRenderer);
    shotRenderer.render(scene, shotCam);
    setDirectorOnlyVisible(true);
  }
  updateHud(cs);
  drawSongBar();
  requestAnimationFrame(frame);
}

// Offscreen render of any shot/time, used by automation and stills.
function renderFrame(i, t, w = 960) {
  const shot = project.shots[clamp(i, 0, project.shots.length - 1)];
  const a = aspect();
  thumbRenderer.setSize(w, Math.round(w / a), false);
  poseObjects(shot, t);
  const cs = resolveCamera(shot, t, project.objects);
  const cam = new THREE.PerspectiveCamera();
  cam.near = 0.03; cam.far = 2000;
  applyCamera(cam, cs, a);
  setDirectorOnlyVisible(false);
  mirrorPass(thumbRenderer);
  thumbRenderer.render(scene, cam);
  setDirectorOnlyVisible(true);
  return thumbCanvas.toDataURL('image/jpeg', 0.85);
}

let lastClock = -1;
let clockStall = 0;
function advance(dt) {
  let resync = false;
  if (song.playing && song.ctx?.state === 'running') {
    // The song clock is the master. If it stalls (audio device asleep), frame time takes over.
    const c = song.clock();
    if (c === lastClock) clockStall += dt;
    else { clockStall = 0; lastClock = c; }
    if (clockStall < 0.3) {
      const d = c - songTime();
      if (d >= -0.25) dt = Math.max(0, d);
      else resync = true;
    }
  }
  const shot = cur();
  time += dt;
  if (time >= shot.duration) {
    const all = $('chkAll').checked;
    if (all && shotIdx < project.shots.length - 1) {
      time -= shot.duration;
      setShot(shotIdx + 1, { keepTime: true });
    } else if ($('chkLoop').checked) {
      if (all) setShot(0, { keepTime: true });
      time = 0;
      resync = true;
    } else {
      time = shot.duration;
      setPlaying(false);
    }
  }
  if (resync && playing) startAudio();
  updatePlayhead();
}

function setPlaying(v) {
  playing = v;
  $('btnPlay').textContent = v ? '❚❚' : '▶';
  $('btnPlay').classList.toggle('on', v);
  if (v && time >= cur().duration - 1e-3) time = 0;
  if (v) startAudio();
  else song.stop();
}

function timecode(t, fps) {
  const total = Math.floor(t * fps + 1e-6);
  const f = total % fps, s = Math.floor(total / fps) % 60, m = Math.floor(total / fps / 60);
  return [m, s, f].map((x) => String(x).padStart(2, '0')).join(':');
}

function updateHud(cs) {
  const shot = cur();
  const sensor = SENSORS[project.sensor] || SENSORS.s35;
  const key = `${shotIdx}|${shot.name}|${Math.round(cs.focal)}|${time.toFixed(3)}|${project.aspect}|${project.sensor}|${offset()}|${(project.sections || []).length}`;
  if (key === hudCache) return;
  hudCache = key;
  $('hudTL').textContent = `#${shotIdx + 1}  ${shot.name}`;
  $('hudTR').textContent = `${Math.round(cs.focal)}mm · ${sensor.en}`;
  const st = songTime();
  const sec = sectionAt(st);
  $('hudBL').textContent = `${timecode(time, project.fps)} / ${timecode(shot.duration, project.fps)}  ♪ ${fmtSong(st)}${sec ? ` · ${sec.name}` : ''}`;
  $('songTc').textContent = `♪ ${fmtSong(st)} / ${fmtSong(Math.max(totalDur() + offset(), song.duration))}${sec ? ` · ${sec.name}` : ''}`;
  $('hudBR').textContent = `${(+project.aspect).toFixed(2)}:1 · ${project.fps}fps`;
  $('timecode').textContent = timecode(time, project.fps);
  const focal = $('cFocal');
  if (document.activeElement !== focal && document.activeElement !== $('cFocalN')) {
    focal.value = Math.round(cs.focal);
    $('cFocalN').value = Math.round(cs.focal);
  }
  const clean = resolveCamera(shot, time, project.objects, false);
  if (document.activeElement !== $('cRoll') && document.activeElement !== $('cRollN')) {
    $('cRoll').value = Math.round(clean.roll);
    $('cRollN').value = Math.round(clean.roll);
  }
  renderCamGauges();
  if (playing) renderObjInspectorValues();
}

// ---------------------------------------------------------------------------
// Selection & gizmo

function select(sel) {
  selection = sel;
  gizmo.detach();
  if (sel?.kind === 'object') {
    const g = meshes.get(sel.id);
    if (g) gizmo.attach(g);
  } else if (sel?.kind === 'camera') {
    gizmo.attach(camHandle);
  } else if (sel?.kind === 'target') {
    gizmo.attach(tgtHandle);
  }
  applyGizmoMode();
  renderObjList();
  renderObjInspector();
  renderTimeline();
  const objBtn = $('btnAddObjKey');
  objBtn.disabled = sel?.kind !== 'object';
  objBtn.textContent = sel?.kind === 'object' ? `◆ ${objById(sel.id)?.name} 키` : '◆ 오브젝트 키';
  if (sel?.kind === 'object') {
    document.querySelector('.tab[data-tab="scene"]')?.click();
    setFocusArea('scene');
  }
  const badge = $('selBadge');
  if (!sel) badge.hidden = true;
  else {
    badge.hidden = false;
    badge.textContent = sel.kind === 'camera' ? '샷 카메라' : sel.kind === 'target' ? '카메라 타깃' : objById(sel.id)?.name;
  }
}

function applyGizmoMode() {
  const isObj = selection?.kind === 'object';
  const mode = isObj ? gizmoMode : 'translate';
  gizmo.setMode(mode);
  gizmo.showX = mode === 'translate';
  gizmo.showZ = mode === 'translate';
  gizmo.showY = true;
  document.querySelectorAll('#gizmoSeg button').forEach((b) => b.classList.toggle('active', b.dataset.gizmo === gizmoMode));
}

let warnedNoKey = false;
// Insert or update the key at the current time, honouring the auto-key setting.
function upsertKey(keys, make, update) {
  const i = keyIndexAt(keys, time, frameTol());
  if (i >= 0) { update(keys[i]); return true; }
  if (!keys.length || $('chkAutoKey').checked) {
    const k = make();
    k.t = r3(time);
    update(k);
    keys.push(k);
    sortKeys(keys);
    return true;
  }
  if (keys.length === 1) { update(keys[0]); return true; }
  if (!warnedNoKey) {
    toast('자동 키가 꺼져 있습니다 — 키 위치에서만 수정됩니다');
    warnedNoKey = true;
  }
  return false;
}

// The camera key last edited and its values before the edit (for "apply to all keys").
let camEdit = null;

function writeCamera(patch) {
  const shot = cur();
  const lockObj = shot.lookAt && objById(shot.lookAt.id);
  if (patch.target && lockObj) {
    const s = sampleObject(lockObj, shot, time);
    shot.lookAt.offset = [patch.target.x - s.pos[0], patch.target.y - s.pos[1], patch.target.z - s.pos[2]].map(r3);
    patch = { ...patch, target: null };
    if (!patch.pos && patch.focal == null && patch.roll == null) return true;
  }
  const base = resolveCamera(shot, time, project.objects, false);
  const ok = upsertKey(shot.keys,
    () => ({ pos: vArr(base.pos), target: vArr(base.target), focal: r3(base.focal), roll: r3(base.roll) }),
    (k) => {
      if (!camEdit || camEdit.shotId !== shot.id || Math.abs(camEdit.t - k.t) > frameTol()) {
        camEdit = { shotId: shot.id, t: k.t, before: { pos: k.pos.slice(), target: k.target.slice(), focal: k.focal, roll: k.roll || 0 } };
      }
      if (patch.pos) k.pos = vArr(patch.pos);
      if (patch.target) k.target = vArr(patch.target);
      if (patch.focal != null) k.focal = r3(patch.focal);
      if (patch.roll != null) k.roll = r3(patch.roll);
    });
  if (ok) shot.meta = { ...shot.meta, edited: true };
  return ok;
}

// pos / rotY are in the object's parent space (world space when it has no parent).
function writeObject(o, pos, rotY) {
  const shot = cur();
  const keys = shot.anim?.[o.id];
  if (keys && keys.length) {
    const s = sampleLocal(o, shot, time);
    return upsertKey(keys, () => ({ pos: s.pos, rotY: s.rotY }), (k) => { k.pos = pos; k.rotY = rotY; });
  }
  o.pos = pos;
  o.rotY = rotY;
  return true;
}

gizmo.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  dragging = e.value;
  if (e.value) pushUndo();
  else refresh();
});
gizmo.addEventListener('objectChange', () => {
  if (!selection) return;
  if (selection.kind === 'camera') writeCamera({ pos: camHandle.position });
  else if (selection.kind === 'target') writeCamera({ target: tgtHandle.position });
  else {
    const o = objById(selection.id);
    const g = meshes.get(selection.id);
    if (!o || !g) return;
    const l = worldToLocal(o, cur(), time, vArr(g.position), THREE.MathUtils.radToDeg(g.rotation.y));
    if (!o.parent) l.pos[1] = Math.max(0, l.pos[1]);
    writeObject(o, l.pos.map(r3), Math.round(l.rotY * 10) / 10);
    renderObjInspectorValues();
  }
  updatePath();
  hudCache = '';
});

// Click-to-select in the director view.
const raycaster = new THREE.Raycaster();
let downPt = null;
directorCanvas.addEventListener('pointerdown', (e) => {
  downPt = gizmo.axis ? null : { x: e.clientX, y: e.clientY };
});
directorCanvas.addEventListener('pointerup', (e) => {
  if (!downPt || Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > 4) return;
  const rect = directorCanvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, dirCam);
  const hits = raycaster.intersectObjects([tgtHandle, rig, ...objRoot.children], true);
  for (const h of hits) {
    let o = h.object;
    if (o.userData.pick === 'target') return select({ kind: 'target' });
    if (o.userData.pick === 'camera') return select({ kind: 'camera' });
    while (o && o.userData.objId === undefined) o = o.parent;
    if (o) return select({ kind: 'object', id: o.userData.objId });
  }
  select(null);
});

function focusSelection() {
  let p;
  if (selection?.kind === 'object') p = meshes.get(selection.id)?.position.clone().add(new THREE.Vector3(0, 1, 0));
  else if (selection?.kind === 'camera') p = camHandle.position.clone();
  else if (selection?.kind === 'target') p = tgtHandle.position.clone();
  else p = tgtHandle.position.clone();
  if (!p) return;
  const off = dirCam.position.clone().sub(orbit.target).setLength(6);
  orbit.target.copy(p);
  dirCam.position.copy(p).add(off);
}

// ---------------------------------------------------------------------------
// Refresh / UI rendering

function refresh() {
  shotIdx = clamp(shotIdx, 0, project.shots.length - 1);
  time = clamp(time, 0, cur().duration);
  syncScene();
  updatePath();
  renderProjectPanel();
  renderGenSelects();
  renderShotCards();
  renderShotInspector();
  renderCamKeys();
  renderObjList();
  renderObjInspector();
  renderTimeline();
  renderPrompt();
  renderAudioPanel();
  updateRef();
  resize();
  queueThumbs();
  autosave();
  hudCache = '';
  songDirty = true;
}

// Lighter refresh for continuous edits.
// Difference between the last edited key and its values before the edit.
function camEditDelta() {
  const shot = cur();
  if (!camEdit || camEdit.shotId !== shot.id || shot.keys.length < 2) return null;
  const k = shot.keys.find((x) => Math.abs(x.t - camEdit.t) <= frameTol());
  if (!k) return null;
  const b = camEdit.before;
  const d = {
    pos: k.pos.map((v, i) => r3(v - b.pos[i])),
    target: k.target.map((v, i) => r3(v - b.target[i])),
    focal: r3(k.focal - b.focal),
    roll: r3((k.roll || 0) - b.roll),
  };
  const moved = [...d.pos, ...d.target, d.focal, d.roll].some((v) => Math.abs(v) > 1e-3);
  return moved ? { k, d } : null;
}

function describeDelta(d) {
  const f = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
  const parts = [];
  ['X', 'Y', 'Z'].forEach((a, i) => { if (Math.abs(d.pos[i]) > 1e-3) parts.push(`${a} ${f(d.pos[i])}`); });
  ['X', 'Y', 'Z'].forEach((a, i) => { if (Math.abs(d.target[i]) > 1e-3) parts.push(`타깃${a} ${f(d.target[i])}`); });
  if (Math.abs(d.focal) > 1e-3) parts.push(`렌즈 ${f(d.focal)}mm`);
  if (Math.abs(d.roll) > 1e-3) parts.push(`롤 ${f(d.roll)}°`);
  return parts.join(' · ');
}

function renderApplyAll() {
  const btn = $('btnApplyAll');
  const r = camEditDelta();
  btn.disabled = !r;
  btn.textContent = r
    ? `${r.k.t.toFixed(2)}s 키의 변화를 모든 키에 적용 (${describeDelta(r.d)})`
    : '키 하나를 수정하면 그 변화를 모든 키에 적용할 수 있습니다';
}

// Shift every other camera key by the same amount the last edited key moved.
function applyEditToAllKeys() {
  const r = camEditDelta();
  if (!r) return toast('먼저 카메라 키 하나를 수정하세요 (위치·타깃 게이지, 기즈모, 렌즈, 롤)');
  const { k: edited, d } = r;
  const n = cur().keys.length - 1;
  mutate(() => {
    for (const k of cur().keys) {
      if (k === edited) continue;
      k.pos = k.pos.map((v, i) => r3(v + d.pos[i]));
      k.target = k.target.map((v, i) => r3(v + d.target[i]));
      k.focal = r3(clamp(k.focal + d.focal, 8, 400));
      k.roll = r3((k.roll || 0) + d.roll);
    }
    camEdit.before = { pos: edited.pos.slice(), target: edited.target.slice(), focal: edited.focal, roll: edited.roll || 0 };
    cur().meta = { ...cur().meta, edited: true };
  });
  toast(`나머지 키 ${n}개에 적용했습니다: ${describeDelta(d)} — Ctrl+Z로 되돌리기`, 4500);
}

function softRefresh() {
  updatePath();
  renderTimeline();
  renderCamKeys();
  renderPrompt();
  hudCache = '';
  songDirty = true;
}

function setShot(i, { keepTime = false } = {}) {
  shotIdx = clamp(i, 0, project.shots.length - 1);
  if (!keepTime) time = 0;
  time = clamp(time, 0, cur().duration);
  updatePath();
  renderShotCards();
  renderShotInspector();
  renderCamKeys();
  renderObjInspector();
  renderTimeline();
  renderPrompt();
  updateRef();
  hudCache = '';
  songDirty = true;
}

function setTime(t) {
  time = clamp(t, 0, cur().duration);
  updatePlayhead();
  renderObjInspectorValues(true);
  renderCamGauges(true);
  hudCache = '';
}

function renderProjectPanel() {
  $('projectName').value = project.name;
  $('pAspect').value = String(Object.keys(ASPECTS).find((k) => Math.abs(ASPECTS[k].v - project.aspect) < 0.01) || '2.39');
  $('pSensor').value = project.sensor;
  $('pFps').value = String(project.fps);
  $('pLight').value = project.lighting;
  if (document.activeElement !== $('pStyle')) $('pStyle').value = project.style || '';
  if (document.activeElement !== $('pOffset')) $('pOffset').value = offset();
  if (document.activeElement !== $('pBpm')) $('pBpm').value = project.bpm || '';
  if (document.activeElement !== $('pBeat0')) $('pBeat0').value = project.beat0 || 0;
  if (document.activeElement !== $('pSections')) $('pSections').value = formatSections(project.sections);
}

function formatSections(list) {
  return [...(list || [])].sort((a, b) => a.t - b.t).map((x) => {
    const m = Math.floor(x.t / 60), sec = x.t - m * 60;
    const ss = Number.isInteger(sec) ? String(sec).padStart(2, '0') : sec.toFixed(1).padStart(4, '0');
    return `${m}:${ss} ${x.name}`;
  }).join('\n');
}
function parseSections(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)\s+(.+)$/);
    if (m) out.push({ t: (m[1] ? +m[1] * 60 : 0) + +m[2], name: m[3].trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}

function renderAudioPanel() {
  $('audioName').textContent = song.loaded ? `${song.name} · ${fmtSong(song.duration)}` : (project.audio?.name ? `"${project.audio.name}" 다시 불러오기 필요` : '불러온 음원 없음');
  $('btnAudioDel').disabled = !song.loaded;
  $('chkMute').checked = song.muted;
}

function renderGenSelects() {
  for (const id of ['gSubject', 'gSubject2']) {
    const sel = $(id);
    const prev = sel.value;
    sel.innerHTML = '';
    if (id === 'gSubject2') sel.append(new Option('없음', ''));
    for (const o of project.objects) {
      if (o.type === 'mark') continue;
      sel.append(new Option(`${o.name} (${OBJ_TYPES[o.type].ko})`, o.id));
    }
    if ([...sel.options].some((op) => op.value === prev)) sel.value = prev;
    else if (id === 'gSubject2') sel.value = '';
  }
}

function renderShotCards() {
  const wrap = $('shotCards');
  wrap.innerHTML = '';
  wrap.style.setProperty('--ar', String(aspect()));
  project.shots.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'shot-card' + (i === shotIdx ? ' active' : '');
    card.dataset.id = s.id;
    card.draggable = true;
    const img = document.createElement('img');
    img.alt = '';
    if (thumbs.has(s.id)) img.src = thumbs.get(s.id);
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = fmtSong(shotStart(i) + offset());
    card.append(st);
    if (s.ref && project.assets?.[s.ref]) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'REF';
      card.append(b);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<b>${i + 1}</b><span class="nm"></span><span class="dur">${s.duration}s</span>`;
    meta.querySelector('.nm').textContent = s.name;
    card.prepend(img);
    card.append(meta);
    card.addEventListener('click', () => { setPlaying(false); setShot(i); setFocusArea('shots'); });
    card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
    card.addEventListener('dragleave', () => card.classList.remove('over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = +e.dataTransfer.getData('text/plain');
      if (Number.isNaN(from) || from === i) return;
      mutate(() => {
        const curId = cur().id;
        const [m] = project.shots.splice(from, 1);
        project.shots.splice(i, 0, m);
        shotIdx = project.shots.findIndex((x) => x.id === curId);
      });
    });
    wrap.appendChild(card);
  });
  const total = project.shots.reduce((a, s) => a + s.duration, 0);
  $('shotIndex').textContent = `${shotIdx + 1} / ${project.shots.length} · 총 ${Math.round(total * 10) / 10}초`;
}

function renderShotInspector() {
  const s = cur();
  if (document.activeElement !== $('sName')) $('sName').value = s.name;
  if (document.activeElement !== $('sDur')) $('sDur').value = s.duration;
  $('sEase').value = s.ease;
  if (document.activeElement !== $('sDesc')) $('sDesc').value = s.desc;
  $('cShake').value = s.shake;
  $('cShakeN').textContent = (+s.shake).toFixed(2);
  const lock = $('cLock');
  lock.innerHTML = '';
  lock.append(new Option('없음 (키프레임 타깃)', ''));
  for (const o of project.objects) lock.append(new Option(o.name, o.id));
  lock.value = s.lookAt && objById(s.lookAt.id) ? s.lookAt.id : '';
  const src = s.meta?.source;
  $('sDesc').title = src ? `원문: ${src}` : '';
  $('sLight').value = s.light || '';
}

function renderCamKeys() {
  renderApplyAll();
  const ul = $('camKeys');
  ul.innerHTML = '';
  const shot = cur();
  if (!shot.keys.length) {
    ul.innerHTML = '<li class="empty">키 없음 — K 를 눌러 추가</li>';
    return;
  }
  shot.keys.forEach((k, i) => {
    const li = document.createElement('li');
    const on = Math.abs(k.t - time) <= frameTol();
    li.className = on ? 'on' : '';
    li.innerHTML = `<span class="kd">◆</span><span class="kt">${k.t.toFixed(2)}s</span><span class="kf">${Math.round(k.focal)}mm${k.roll ? ` · ${Math.round(k.roll)}°` : ''}</span>`;
    const go = document.createElement('button');
    go.textContent = '이동';
    go.onclick = () => setTime(k.t);
    const del = document.createElement('button');
    del.textContent = '삭제';
    del.className = 'danger';
    del.onclick = () => mutate(() => { shot.keys.splice(i, 1); shot.meta = { ...shot.meta, edited: true }; });
    li.append(go, del);
    ul.appendChild(li);
  });
}

function renderObjList() {
  const ul = $('objList');
  ul.innerHTML = '';
  for (const o of project.objects) {
    const li = document.createElement('li');
    li.className = selection?.kind === 'object' && selection.id === o.id ? 'active' : '';
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = o.color;
    const nm = document.createElement('span');
    nm.className = 'nm';
    const depth = ancestors(o).length;
    nm.textContent = (depth ? `${'  '.repeat(depth - 1)}↳ ` : '') + o.name;
    if (cur().hide?.[o.id]) li.style.opacity = '0.45';
    const ty = document.createElement('span');
    ty.className = 'ty';
    ty.textContent = (OBJ_TYPES[o.type]?.ko || o.type) + (cur().anim?.[o.id]?.length ? ' · ◆' : '') + (cur().hide?.[o.id] ? ' · 숨김' : '');
    li.append(sw, nm, ty);
    li.onclick = () => select({ kind: 'object', id: o.id });
    ul.appendChild(li);
  }
}

function renderObjInspector() {
  const box = $('objInspector');
  const o = selection?.kind === 'object' ? objById(selection.id) : null;
  box.hidden = !o;
  if (!o) return;
  $('oName').value = o.name;
  $('oColor').value = o.color;
  const def = OBJ_TYPES[o.type] || {};
  const isSign = o.type === 'sign';
  ['oTextWrap', 'oTextColorWrap', 'oVertWrap'].forEach((id) => { $(id).hidden = !isSign; });
  if (isSign) { $('oText').value = o.text ?? o.name; $('oTextColor').value = o.textColor || '#ffffff'; $('oVert').checked = !!o.vertical; }
  const hasH = !!def.hLabel;
  $('oHWrap').hidden = !hasH;
  if (hasH) { $('oH').value = o.height ?? def.height; $('oHLabel').textContent = def.hLabel; }
  $('oTiltWrap').hidden = !def.tilt;
  if (def.tilt) $('oTilt').value = o.tilt || 0;
  $('oHoldWrap').hidden = o.type !== 'actor';
  if (o.type === 'actor') $('oHold').value = o.hold || 'none';
  const poses = POSE_SETS[o.type];
  $('oPoseWrap').hidden = !poses;
  $('oPoseShotWrap').hidden = !poses;
  if (poses) {
    fillSelect($('oPose'), Object.entries(poses), (v) => v);
    $('oPose').value = o.pose || defaultPose(o.type);
    const ps = $('oPoseShot');
    ps.innerHTML = '';
    ps.append(new Option('기본 포즈 따름', ''));
    for (const [k, v] of Object.entries(poses)) ps.append(new Option(v, k));
    ps.value = cur().poses?.[o.id] || '';
  }
  const par = $('oParent');
  par.innerHTML = '';
  par.append(new Option('없음 (월드)', ''));
  for (const c of project.objects) {
    if (c.id === o.id || ancestors(c).includes(o)) continue;
    par.append(new Option(`${c.name} (${OBJ_TYPES[c.type]?.ko || c.type})`, c.id));
  }
  par.value = o.parent || '';
  $('oHide').checked = !!cur().hide?.[o.id];
  document.querySelectorAll('#objInspector .dims').forEach((el) => { el.hidden = !o.size; });
  if (o.size) [$('oSX').value, $('oSY').value, $('oSZ').value] = o.size;
  renderObjInspectorValues();
  const ul = $('objKeys');
  ul.innerHTML = '';
  const keys = cur().anim?.[o.id] || [];
  keys.forEach((k, i) => {
    const li = document.createElement('li');
    li.className = Math.abs(k.t - time) <= frameTol() ? 'on' : '';
    li.innerHTML = `<span class="kd">◆</span><span class="kt">${k.t.toFixed(2)}s</span><span class="kf">${k.pos.map((v) => v.toFixed(1)).join(', ')}</span>`;
    const go = document.createElement('button');
    go.textContent = '이동';
    go.onclick = () => setTime(k.t);
    const del = document.createElement('button');
    del.textContent = '삭제';
    del.className = 'danger';
    del.onclick = () => mutate(() => {
      keys.splice(i, 1);
      if (!keys.length) delete cur().anim[o.id];
    });
    li.append(go, del);
    ul.appendChild(li);
  });
}

// A gauge = range slider + number field sharing one value. Ids: `${id}` (number), `${id}R` (range).
function buildGauge(container, id, axis, label, min, max, step, unit) {
  const row = document.createElement('div');
  row.className = `slider-row gauge ${axis}`;
  row.innerHTML = `<span class="ax">${label}</span>`
    + `<input id="${id}R" type="range" min="${min}" max="${max}" step="${step}" aria-label="${label}" />`
    + `<input id="${id}" type="number" step="${step}" class="num" aria-label="${label}" />`
    + `<span class="unit">${unit}</span>`;
  container.appendChild(row);
}

// Show a value without fighting the user's own drag/typing; widen the slider if needed.
function setGauge(id, v, force = false) {
  const num = $(id), rng = $(`${id}R`);
  if (!num || !rng) return;
  if (!force && (document.activeElement === num || document.activeElement === rng)) return;
  const val = Math.round(v * 100) / 100;
  if (val < +rng.min) rng.min = Math.floor(val - 5);
  if (val > +rng.max) rng.max = Math.ceil(val + 5);
  rng.value = val;
  num.value = val;
}

// Live editing from either control: one undo step per drag, mirrored into the twin control.
function bindGauge(id, apply) {
  const num = $(id), rng = $(`${id}R`);
  let open = false;
  const onInput = (src, twin) => {
    const v = +src.value;
    if (!Number.isFinite(v)) return;
    if (!open) { pushUndo(); open = true; }
    twin.value = v;
    apply(v);
    softRefresh();
  };
  rng.addEventListener('input', () => onInput(rng, num));
  num.addEventListener('input', () => onInput(num, rng));
  for (const el of [rng, num]) el.addEventListener('change', () => { open = false; refresh(); });
}

function renderObjInspectorValues(force = false) {
  const o = selection?.kind === 'object' ? objById(selection.id) : null;
  if (!o) return;
  const s = sampleLocal(o, cur(), time);
  setGauge('oX', s.pos[0], force); setGauge('oY', s.pos[1], force);
  setGauge('oZ', s.pos[2], force); setGauge('oRot', s.rotY, force);
}

function renderCamGauges(force = false) {
  const c = resolveCamera(cur(), time, project.objects, false);
  setGauge('cPX', c.pos.x, force); setGauge('cPY', c.pos.y, force); setGauge('cPZ', c.pos.z, force);
  setGauge('cTX', c.target.x, force); setGauge('cTY', c.target.y, force); setGauge('cTZ', c.target.z, force);
}

function renderPrompt() {
  $('promptOut').textContent = describeShot(cur(), project, shotIdx).en;
}

// ---------------------------------------------------------------------------
// Timeline

const LANE_PAD_L = 64, LANE_PAD_R = 14;
function tToX(t) {
  const w = $('track').clientWidth - LANE_PAD_L - LANE_PAD_R;
  return LANE_PAD_L + (t / cur().duration) * w;
}
function xToT(clientX) {
  const rect = $('track').getBoundingClientRect();
  const w = rect.width - LANE_PAD_L - LANE_PAD_R;
  return clamp(((clientX - rect.left - LANE_PAD_L) / w) * cur().duration, 0, cur().duration);
}

function renderTimeline() {
  const shot = cur();
  const ticks = $('ticks');
  ticks.innerHTML = '';
  const dur = shot.duration;
  const step = dur > 30 ? 5 : dur > 12 ? 2 : dur > 4 ? 1 : 0.5;
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const d = document.createElement('span');
    d.style.left = `${tToX(t)}px`;
    d.textContent = `${Math.round(t * 10) / 10}s`;
    ticks.appendChild(d);
  }
  const lanes = [
    ['laneCam', shot.keys, 'cam'],
    ['laneObj', selection?.kind === 'object' ? shot.anim?.[selection.id] || [] : [], 'obj'],
  ];
  $('laneObjName').textContent = selection?.kind === 'object' ? objById(selection.id)?.name || '오브젝트' : '오브젝트';
  for (const [laneId, keys, kind] of lanes) {
    const lane = $(laneId);
    lane.querySelectorAll('.tkey').forEach((e) => e.remove());
    keys.forEach((k) => {
      const d = document.createElement('div');
      d.className = `tkey ${kind}` + (Math.abs(k.t - time) <= frameTol() ? ' on' : '');
      d.style.left = `${tToX(k.t)}px`;
      d.title = `${k.t.toFixed(2)}s — 드래그로 시간 이동`;
      d.addEventListener('pointerdown', (e) => startKeyDrag(e, keys, k));
      lane.appendChild(d);
    });
  }
  updatePlayhead();
}

function updatePlayhead() {
  $('playhead').style.left = `${tToX(time)}px`;
  $('timecode').textContent = timecode(time, project.fps);
}

function startKeyDrag(e, keys, k) {
  e.stopPropagation();
  e.preventDefault();
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  let moved = false;
  const onMove = (ev) => {
    if (!moved && Math.abs(ev.clientX - startX) < 3) return;
    if (!moved) { pushUndo(); moved = true; }
    const fps = project.fps;
    k.t = r3(Math.round(xToT(ev.clientX) * fps) / fps);
    el.style.left = `${tToX(k.t)}px`;
    setTime(k.t);
  };
  const onUp = () => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    if (moved) { sortKeys(keys); refresh(); } else setTime(k.t);
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

{
  const track = $('track');
  let scrubbing = false;
  track.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    track.setPointerCapture(e.pointerId);
    setPlaying(false);
    setTime(xToT(e.clientX));
  });
  track.addEventListener('pointermove', (e) => { if (scrubbing) setTime(xToT(e.clientX)); });
  track.addEventListener('pointerup', () => {
    if (!scrubbing) return;
    scrubbing = false;
    renderTimeline();
    renderCamKeys();
    renderObjInspector();
  });
}

// ---------------------------------------------------------------------------
// Generator

function readGenParams() {
  return {
    subject: $('gSubject').value || null,
    subject2: $('gSubject2').value || null,
    size: $('gSize').value,
    angle: $('gAngle').value,
    dir: $('gDir').value,
    move: $('gMove').value,
    speed: $('gSpeed').value,
    lens: +$('gLens').value || 35,
    duration: +$('gDur').value || 4,
    ease: $('gEase').value,
    handheld: $('gHandheld').checked,
    dutch: $('gDutch').checked,
  };
}

function writeGenParams(p) {
  if (p.subject) $('gSubject').value = p.subject;
  $('gSubject2').value = p.subject2 || '';
  $('gSize').value = p.size;
  $('gAngle').value = p.angle;
  $('gDir').value = p.dir;
  $('gMove').value = p.move;
  $('gSpeed').value = p.speed;
  $('gLens').value = p.lens;
  $('gDur').value = p.duration;
  $('gEase').value = p.ease;
  $('gHandheld').checked = !!p.handheld;
  $('gDutch').checked = !!p.dutch;
}

// Bake the live lock into the keys so framing survives unlocking.
function unlockShot(shot) {
  if (!shot.lookAt) return;
  for (const k of shot.keys) {
    const lt = lockTarget(shot, project.objects, k.t);
    if (lt) k.target = vArr(lt);
  }
  delete shot.lookAt;
}

function lockShot(shot, id) {
  const o = objById(id);
  if (!o) return;
  shot.lookAt = { id, offset: [0, r3(aimOffset(o, shot.meta?.size || 'ms')), 0] };
}

function applyGenToShot(shot, gen) {
  delete shot.lookAt;
  for (const id of shot.genAnim || []) delete shot.anim[id];
  shot.keys = gen.keys;
  shot.anim = { ...shot.anim, ...gen.anim };
  shot.genAnim = Object.keys(gen.anim);
  shot.duration = gen.duration;
  shot.ease = gen.ease;
  shot.shake = gen.shake;
  shot.meta = gen.meta;
  shot.name = gen.name;
}

function generateFromForm(asNew) {
  const p = readGenParams();
  if (!p.subject) return toast('피사체로 쓸 오브젝트를 먼저 추가하세요');
  mutate(() => {
    if (asNew) {
      const gen = generateShot(p, project, null);
      project.shots.splice(shotIdx + 1, 0, makeShot(gen));
      shotIdx += 1;
    } else {
      const shot = cur();
      const tmp = clone(shot);
      for (const id of tmp.genAnim || []) delete tmp.anim[id];
      applyGenToShot(shot, generateShot(p, project, tmp));
    }
    time = 0;
  });
  queueThumbs();
  toast(asNew ? '새 샷을 생성했습니다' : '현재 샷에 적용했습니다');
}

function generateFromText() {
  const lines = $('genText').value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return toast('샷 설명을 입력하세요');
  if (!project.objects.length) return toast('씬에 오브젝트를 먼저 추가하세요');
  const replace = $('genReplace').checked;
  const log = [];
  let lastParams;
  mutate(() => {
    lines.forEach((line, i) => {
      const [camPart, ...actionParts] = line.split('|');
      const action = actionParts.join('|').trim();
      const { params, summary } = parseShotText(camPart, project, readGenParams());
      params.source = line;
      lastParams = params;
      log.push(summary);
      if (replace && i === 0) {
        const shot = cur();
        const tmp = clone(shot);
        for (const id of tmp.genAnim || []) delete tmp.anim[id];
        applyGenToShot(shot, generateShot(params, project, tmp));
        shot.meta.source = line;
        if (action) shot.desc = action;
      } else {
        const gen = generateShot(params, project, null);
        gen.meta.source = line;
        const at = replace ? shotIdx + 1 : project.shots.length;
        project.shots.splice(at, 0, makeShot(gen, { desc: action }));
        shotIdx = at;
      }
    });
    time = 0;
  });
  if (lastParams) writeGenParams(lastParams);
  $('genLog').innerHTML = '';
  log.forEach((s, i) => {
    const d = document.createElement('div');
    d.textContent = `${i + 1}. ${s}`;
    $('genLog').appendChild(d);
  });
  queueThumbs(true);
  toast(`${lines.length}개 샷을 생성했습니다`);
}

// ---------------------------------------------------------------------------
// Recording

let exportRenderer = null;
function getExportRenderer(w, h) {
  if (!exportRenderer) {
    exportRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    exportRenderer.shadowMap.enabled = true;
    exportRenderer.shadowMap.type = shotRenderer.shadowMap.type;
    exportRenderer.toneMapping = shotRenderer.toneMapping;
    exportRenderer.toneMappingExposure = shotRenderer.toneMappingExposure;
    exportRenderer.outputColorSpace = shotRenderer.outputColorSpace;
  }
  exportRenderer.setPixelRatio(1);
  exportRenderer.setSize(w, h, false);
  return exportRenderer;
}

// The song cut to [start, start + dur) on the song clock (silence where it runs past either end).
function songSlice(start, dur) {
  const src = song.buffer;
  const sr = src.sampleRate;
  const len = Math.max(1, Math.round(dur * sr));
  const out = new AudioBuffer({ length: len, numberOfChannels: src.numberOfChannels, sampleRate: sr });
  const from = Math.round(start * sr);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const data = src.getChannelData(c);
    const a = Math.max(0, from), b = Math.min(data.length, from + len);
    if (b > a) out.copyToChannel(data.subarray(a, b), c, a - from);
  }
  return out;
}

/** Render the current shot (or every shot) frame by frame and save it as H.264 MP4 or MOV. */
async function exportVideo(format, all) {
  if (exportJob) return;
  setPlaying(false);
  const fps = project.fps;
  const a = aspect();
  const w = a >= 1 ? 1920 : 1080;
  const h = Math.round(w / a / 2) * 2;
  const shots = all ? project.shots.map((s, i) => i) : [shotIdx];
  const frames = [];
  for (const i of shots) {
    const n = Math.max(1, Math.round(project.shots[i].duration * fps));
    for (let f = 0; f < n; f++) frames.push([i, f / fps]);
  }
  const renderer = getExportRenderer(w, h);
  const cam = new THREE.PerspectiveCamera();
  cam.near = 0.03; cam.far = 2000;
  const renderAt = (f) => {
    const [i, t] = frames[f];
    const shot = project.shots[i];
    poseObjects(shot, t);
    applyCamera(cam, resolveCamera(shot, t, project.objects), a);
    setDirectorOnlyVisible(false);
    mirrorPass(renderer);
    renderer.render(scene, cam);
    setDirectorOnlyVisible(true);
  };
  const audio = song.loaded && !song.muted ? songSlice(shotStart(shots[0]) + offset(), frames.length / fps) : null;
  const job = { cancelled: false };
  exportJob = job;
  const badge = $('recBadge');
  badge.hidden = false;
  badge.classList.add('export');
  badge.onclick = () => { job.cancelled = true; };
  const label = format.toUpperCase();
  const name = `${project.name || 'previz'}${all ? '' : `_shot${shotIdx + 1}`}.${format}`;
  try {
    renderAt(0); // warm-up so the first encoded frame has shadows and materials ready
    const res = await encodeVideo({
      format,
      codec: window.__previzVideoCodec || 'avc', // test hooks: browsers without H.264/AAC encoders
      audioCodec: window.__previzAudioCodec || 'aac',
      canvas: renderer.domElement,
      fps,
      frameCount: frames.length,
      renderFrameAt: renderAt,
      audio,
      isCancelled: () => job.cancelled,
      onProgress: (n, total) => { badge.textContent = `● ${label} 내보내는 중 ${Math.floor((n / total) * 100)}% · 클릭하면 취소`; },
    });
    if (!res) return toast('영상 내보내기를 취소했습니다');
    saveBlob(res.blob, name);
    window.__previzLastExport = res;
    const note = res.audio === 'aac' ? ' · 음악 포함 (AAC)'
      : res.audio === 'unsupported' ? ' · 이 브라우저는 AAC 인코딩을 지원하지 않아 음악 없이 저장했습니다' : '';
    toast(`${label} (${window.__previzVideoCodec ? window.__previzVideoCodec.toUpperCase() : 'H.264'}, ${w}×${h}, ${fps}fps) 저장 완료${note}`, 5000);
  } finally {
    exportJob = null;
    badge.hidden = true;
    badge.classList.remove('export');
    badge.onclick = null;
    badge.textContent = '● REC';
    hudCache = '';
  }
}

// ---------------------------------------------------------------------------
// Parenting

// Attach o to another object (or detach with ''), keeping its world placement.
function reparent(o, pid) {
  const baseW = sampleObject(o, null, 0);
  const keyW = project.shots.map((s) => (s.anim?.[o.id] || []).map((k) => ({ k, w: sampleObject(o, s, k.t) })));
  if (pid) o.parent = pid;
  else delete o.parent;
  const b = worldToLocal(o, null, 0, baseW.pos, baseW.rotY);
  o.pos = b.pos.map(r3);
  o.rotY = r3(b.rotY);
  project.shots.forEach((s, i) => keyW[i].forEach(({ k, w }) => {
    const l = worldToLocal(o, s, k.t, w.pos, w.rotY);
    k.pos = l.pos.map(r3);
    k.rotY = r3(l.rotY);
  }));
}

// ---------------------------------------------------------------------------
// Reference image overlay (e.g. the key cut a shot must match)

let refOn = true;
function updateRef() {
  const url = cur().ref ? project.assets?.[cur().ref] : null;
  const ov = $('ovRef');
  if (url && ov.dataset.src !== cur().ref) { ov.src = url; ov.dataset.src = cur().ref; }
  ov.hidden = !(url && refOn);
  ov.style.opacity = $('refOpacity').value;
  const th = $('refThumb');
  th.hidden = !url;
  if (url && th.dataset.src !== cur().ref) { th.src = url; th.dataset.src = cur().ref; }
  $('refHint').textContent = url ? '샷 카메라에 겹쳐 보입니다 (R)' : '참조 이미지 없음';
  $('btnRefDel').disabled = !url;
}

function readImage(file, maxW = 1280) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxW / img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Song bar: whole-film timeline with waveform, sections, shots and beat grid

let songDirty = true;
let songPx = -1;
function songSpan() {
  return Math.max(totalDur(), song.loaded ? song.duration - offset() : 0, 1);
}
function drawSongBar() {
  const cv = $('songCanvas');
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const span = songSpan();
  const px = Math.round((globalTime() / span) * w * 2);
  if (!songDirty && px === songPx) return;
  songDirty = false;
  songPx = px;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const X = (g) => (g / span) * w;
  const off = offset();
  // sections
  const secs = [...(project.sections || [])].sort((a, b) => a.t - b.t);
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'top';
  secs.forEach((sc, i) => {
    const x0 = X(sc.t - off), x1 = i + 1 < secs.length ? X(secs[i + 1].t - off) : w;
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.025)' : 'rgba(95,168,255,0.06)';
    ctx.fillRect(x0, 0, x1 - x0, h);
    // label clipped to its own band so neighbours never overlap
    let label = sc.name;
    const room = x1 - x0 - 6;
    while (label.length > 1 && ctx.measureText(label).width > room) label = label.slice(0, -1);
    if (room > 8) {
      ctx.fillStyle = 'rgba(159,208,255,0.85)';
      ctx.fillText(label.length < sc.name.length ? `${label.slice(0, -1)}…` : label, x0 + 3, 2);
    }
  });
  // waveform
  if (song.loaded && song.peaks) {
    const pk = song.peaks, n = pk.length, dur = song.duration;
    ctx.fillStyle = 'rgba(200,206,214,0.32)';
    const mid = h * 0.6, amp = h * 0.36;
    for (let x = 0; x < w; x++) {
      const st = (x / w) * span + off;
      if (st < 0 || st > dur) continue;
      const v = pk[Math.min(n - 1, Math.floor((st / dur) * n))];
      const hh = Math.max(0.5, v * amp);
      ctx.fillRect(x, mid - hh, 1, hh * 2);
    }
  }
  // bar grid
  if (project.bpm > 0) {
    const bar = (60 / project.bpm) * 4;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    for (let t = (project.beat0 || 0) - off; t < span; t += bar) if (t >= 0) ctx.fillRect(Math.round(X(t)), h - 5, 1, 5);
  }
  // shots
  let acc = 0;
  project.shots.forEach((s, i) => {
    const x0 = X(acc), x1 = X(acc + s.duration);
    if (i === shotIdx) {
      ctx.fillStyle = 'rgba(255,90,78,0.16)';
      ctx.fillRect(x0, 0, x1 - x0, h);
    }
    ctx.fillStyle = i === shotIdx ? 'rgba(255,90,78,0.9)' : 'rgba(255,255,255,0.22)';
    ctx.fillRect(Math.round(x0), 12, 1, h - 12);
    if (x1 - x0 > 13) {
      ctx.fillStyle = i === shotIdx ? '#ffb3ad' : 'rgba(230,232,235,0.55)';
      ctx.fillText(String(i + 1), x0 + 2, 14);
    }
    if (s.ref && project.assets?.[s.ref]) {
      ctx.fillStyle = '#5fa8ff';
      ctx.fillRect(x0 + 2, h - 9, Math.max(3, Math.min(10, x1 - x0 - 4)), 3);
    }
    acc += s.duration;
  });
  // playhead
  ctx.fillStyle = '#ff5a4e';
  ctx.fillRect(Math.round(X(globalTime())) - 1, 0, 2, h);
}

function seekGlobal(g) {
  g = clamp(g, 0, totalDur() - 1e-4);
  let acc = 0;
  for (let i = 0; i < project.shots.length; i++) {
    const d = project.shots[i].duration;
    if (g < acc + d || i === project.shots.length - 1) {
      if (i !== shotIdx) setShot(i);
      setTime(g - acc);
      return;
    }
    acc += d;
  }
}

async function loadSong(blob, name, persist) {
  try {
    toast('음원을 읽는 중…');
    await song.load(blob, name);
  } catch (err) {
    toast(`음원을 읽지 못했습니다: ${err.message}`);
    return;
  }
  if (project.audio.name !== name) { project.audio.name = name; autosave(); }
  renderAudioPanel();
  songDirty = true;
  hudCache = '';
  toast(`음원 "${name}" · ${fmtSong(song.duration)}`);
  if (persist) {
    const ok = await idbSet('song', { blob, name });
    if (!ok) toast('이 브라우저에 음원을 저장하지 못했습니다 — 새로고침하면 다시 불러와야 합니다', 4000);
  }
}

// ---------------------------------------------------------------------------
// UI bindings

function bindUI() {
  fillSelect($('gSize'), Object.entries(SIZES), (v) => `${v.short} · ${v.ko}`);
  fillSelect($('gAngle'), Object.entries(ANGLES));
  fillSelect($('gDir'), Object.entries(DIRS));
  fillSelect($('gMove'), Object.entries(MOVES));
  fillSelect($('pAspect'), Object.entries(ASPECTS));
  fillSelect($('pSensor'), Object.entries(SENSORS));
  fillSelect($('pLight'), Object.entries(LIGHTS));
  fillSelect($('sLight'), [['', '프로젝트 기본'], ...Object.entries(LIGHTS).map(([k, v]) => [k, v.ko])]);
  fillSelect($('oHold'), Object.entries(HOLDS), (v) => v);
  writeGenParams(defaultParams());

  // Tabs
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== t.dataset.tab; });
  }));

  // Top bar
  $('projectName').addEventListener('change', (e) => mutate(() => { project.name = e.target.value.trim() || '프리비즈'; }));
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  $('btnNew').onclick = () => { loadProject(blankProject(), true); toast('새 프로젝트를 시작했습니다 — Ctrl+Z 로 이전 작업 복구'); };
  const sampleMenu = $('sampleMenu');
  $('btnSample').onclick = (e) => { e.stopPropagation(); sampleMenu.hidden = !sampleMenu.hidden; };
  document.addEventListener('click', () => { sampleMenu.hidden = true; });
  sampleMenu.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => {
    sampleMenu.hidden = true;
    loadProject(SAMPLES[b.dataset.sample](), true);
    toast(`예제 "${project.name}" 을(를) 열었습니다 — Ctrl+Z 로 이전 작업 복구`);
  }));
  $('btnSave').onclick = () => exportJSON(exportable());
  $('btnOpen').onclick = () => $('fileInput').click();
  $('fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      loadProject(normalizeProject(JSON.parse(await f.text())), true);
      toast(`"${project.name}" 을(를) 열었습니다`);
    } catch (err) {
      toast(`열기 실패: ${err.message}`);
    }
  });
  const menu = $('exportMenu');
  $('btnExport').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', async () => {
    menu.hidden = true;
    const kind = b.dataset.export;
    try {
      if (kind === 'png') {
        const a = aspect();
        const w = a >= 1 ? 1920 : 1080;
        exportPNG(shotRenderer, scene, shotCam, w, Math.round(w / a), setDirectorOnlyVisible, `${project.name}_shot${shotIdx + 1}_${timecode(time, project.fps).replace(/:/g, '-')}.png`);
        resize();
        toast('PNG 저장 완료');
      } else if (/^(mp4|mov)-(shot|all)$/.test(kind)) {
        const [format, scope] = kind.split('-');
        await exportVideo(format, scope === 'all');
      }
      else if (kind === 'gltf') {
        await exportGLB(project, meshes, sensorW());
        toast('GLB 저장 완료 — 샷마다 카메라와 애니메이션 클립이 포함됩니다', 4000);
      } else if (kind === 'prompts') {
        const text = exportPrompts(project, describeShot);
        try { await navigator.clipboard.writeText(text); toast('샷리스트를 저장하고 클립보드에 복사했습니다'); } catch { toast('샷리스트를 저장했습니다'); }
      } else if (kind === 'json') exportJSON(exportable());
    } catch (err) {
      console.error(err);
      toast(`내보내기 실패: ${err.message}`);
    }
  }));

  // Generator
  $('btnGenText').onclick = generateFromText;
  $('btnGenApply').onclick = () => generateFromForm(false);
  $('btnGenNew').onclick = () => generateFromForm(true);
  $('gSize').addEventListener('change', () => { $('gLens').value = SIZES[$('gSize').value].lens; });

  // Scene objects
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    const type = b.dataset.add;
    const n = project.objects.filter((o) => o.type === type).length;
    const over = {};
    const fwd = orbit.target.clone();
    over.pos = [r3(fwd.x + (Math.random() - 0.5) * 2), 0, r3(fwd.z + (Math.random() - 0.5) * 2)];
    if (type === 'actor') {
      over.name = `배우${String.fromCharCode(65 + n)}`;
      over.color = ACTOR_COLORS[n % ACTOR_COLORS.length];
    } else if (n > 0) over.name = `${OBJ_TYPES[type].ko}${n + 1}`;
    const o = makeObject(type, over);
    mutate(() => project.objects.push(o));
    select({ kind: 'object', id: o.id });
    document.querySelector('.tab[data-tab="scene"]').click();
  }));

  const objEdit = (fn) => {
    const o = selection?.kind === 'object' ? objById(selection.id) : null;
    if (o) mutate(() => fn(o));
  };
  $('oName').addEventListener('change', (e) => objEdit((o) => { o.name = e.target.value.trim() || o.name; }));
  $('oColor').addEventListener('change', (e) => objEdit((o) => { o.color = e.target.value; }));
  $('oText').addEventListener('change', (e) => objEdit((o) => { o.text = e.target.value; }));
  $('oTextColor').addEventListener('change', (e) => objEdit((o) => { o.textColor = e.target.value; }));
  $('oVert').addEventListener('change', (e) => objEdit((o) => { o.vertical = e.target.checked; }));
  $('oH').addEventListener('change', (e) => objEdit((o) => {
    const v = +e.target.value;
    o.height = clamp(Number.isFinite(v) ? v : (OBJ_TYPES[o.type]?.height || 1.75), (o.type === 'balloon' || o.type === 'mballoon') ? 0 : 0.3, 80);
  }));
  $('oTilt').addEventListener('change', (e) => objEdit((o) => { o.tilt = clamp(+e.target.value || 0, -60, 60); }));
  $('oHold').addEventListener('change', (e) => objEdit((o) => { o.hold = e.target.value; }));
  $('oPose').addEventListener('change', (e) => objEdit((o) => { o.pose = e.target.value; }));
  $('oPoseShot').addEventListener('change', (e) => objEdit((o) => {
    const s = cur();
    s.poses ||= {};
    if (e.target.value) s.poses[o.id] = e.target.value;
    else delete s.poses[o.id];
  }));
  $('oParent').addEventListener('change', (e) => objEdit((o) => reparent(o, e.target.value)));
  $('oHide').addEventListener('change', (e) => objEdit((o) => {
    const s = cur();
    s.hide ||= {};
    if (e.target.checked) s.hide[o.id] = true;
    else delete s.hide[o.id];
  }));
  ['oSX', 'oSY', 'oSZ'].forEach((id, i) => $(id).addEventListener('change', (e) => objEdit((o) => { o.size[i] = clamp(+e.target.value || 1, 0.05, 200); })));
  buildGauge($('oGauges'), 'oX', 'x', 'X', -30, 30, 0.05, 'm');
  buildGauge($('oGauges'), 'oY', 'y', 'Y', 0, 10, 0.05, 'm');
  buildGauge($('oGauges'), 'oZ', 'z', 'Z', -30, 30, 0.05, 'm');
  buildGauge($('oGauges'), 'oRot', 'r', '회전', -180, 180, 1, '°');
  const objAxis = (i) => (v) => {
    const o = selection?.kind === 'object' ? objById(selection.id) : null;
    if (!o) return;
    const cs = sampleLocal(o, cur(), time);
    const pos = cs.pos.slice();
    let rot = cs.rotY;
    if (i === 3) rot = v;
    else pos[i] = i === 1 && !o.parent ? Math.max(0, v) : v;
    writeObject(o, pos.map(r3), r3(rot));
  };
  ['oX', 'oY', 'oZ', 'oRot'].forEach((id, i) => bindGauge(id, objAxis(i)));

  for (const [box, ids, kind] of [[$('cPosGauges'), ['cPX', 'cPY', 'cPZ'], 'pos'], [$('cTgtGauges'), ['cTX', 'cTY', 'cTZ'], 'target']]) {
    buildGauge(box, ids[0], 'x', 'X', -40, 40, 0.05, 'm');
    buildGauge(box, ids[1], 'y', 'Y', 0, 20, 0.05, 'm');
    buildGauge(box, ids[2], 'z', 'Z', -40, 40, 0.05, 'm');
    ids.forEach((id, i) => bindGauge(id, (v) => {
      const c = resolveCamera(cur(), time, project.objects, false);
      const vec = c[kind].clone();
      vec.setComponent(i, i === 1 && kind === 'pos' ? Math.max(0.05, v) : v);
      writeCamera({ [kind]: vec });
    }));
  }
  $('btnObjKey').onclick = addObjKey;
  $('btnAddObjKey').onclick = addObjKey;
  $('btnObjClearKeys').onclick = () => objEdit((o) => { delete cur().anim[o.id]; });
  $('btnObjDel').onclick = deleteSelectedObject;
  $('btnObjDup').onclick = () => objEdit((o) => {
    const c = clone(o);
    c.id = uid();
    c.name = `${o.name} 복제`;
    c.pos = [o.pos[0] + 1, o.pos[1], o.pos[2]];
    project.objects.push(c);
    setTimeout(() => select({ kind: 'object', id: c.id }));
  });

  // Project settings
  $('pAspect').addEventListener('change', (e) => { mutate(() => { project.aspect = ASPECTS[e.target.value].v; queueThumbs(true); }); setLayout(layout); });
  $('pSensor').addEventListener('change', (e) => mutate(() => { project.sensor = e.target.value; queueThumbs(true); }));
  $('pFps').addEventListener('change', (e) => mutate(() => { project.fps = +e.target.value; }));
  $('pLight').addEventListener('change', (e) => mutate(() => { project.lighting = e.target.value; queueThumbs(true); }));
  liveInput($('pStyle'), (el) => { project.style = el.value; });
  $('btnAudio').onclick = () => $('audioInput').click();
  $('audioInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await loadSong(f, f.name, true);
  });
  $('btnAudioDel').onclick = () => {
    setPlaying(false);
    song.unload();
    idbDel('song');
    project.audio.name = '';
    autosave();
    renderAudioPanel();
    songDirty = true;
  };
  $('chkMute').addEventListener('change', (e) => song.setMuted(e.target.checked));
  $('pOffset').addEventListener('change', (e) => mutate(() => { project.audio.offset = r3(+e.target.value || 0); }));
  $('pBpm').addEventListener('change', (e) => mutate(() => { project.bpm = clamp(+e.target.value || 0, 0, 400); }));
  $('pBeat0').addEventListener('change', (e) => mutate(() => { project.beat0 = r3(+e.target.value || 0); }));
  $('pSections').addEventListener('change', (e) => mutate(() => { project.sections = parseSections(e.target.value); }));

  // Shot inspector
  $('sName').addEventListener('change', (e) => mutate(() => { cur().name = e.target.value.trim() || cur().name; }));
  $('sDur').addEventListener('change', (e) => mutate(() => {
    const s = cur();
    const nd = clamp(+e.target.value || s.duration, 0.5, 120);
    const ratio = nd / s.duration;
    // retime keys proportionally so the move keeps its shape
    s.keys.forEach((k) => { k.t = r3(k.t * ratio); });
    Object.values(s.anim || {}).forEach((ks) => ks.forEach((k) => { k.t = r3(k.t * ratio); }));
    s.duration = nd;
    s.meta = { ...s.meta, duration: nd };
  }));
  $('sEase').addEventListener('change', (e) => mutate(() => { cur().ease = e.target.value; }));
  liveInput($('sDesc'), (el) => { cur().desc = el.value; });
  $('sLight').addEventListener('change', (e) => mutate(() => {
    if (e.target.value) cur().light = e.target.value;
    else delete cur().light;
  }));
  $('btnRefLoad').onclick = () => $('refInput').click();
  $('refInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const url = await readImage(f);
      const id = `ref_${uid()}`;
      project.assets[id] = url;
      assetsDirty = true;
      mutate(() => { cur().ref = id; });
      toast('참조 이미지를 샷 카메라에 겹쳤습니다 — 프레이밍을 맞춰 보세요');
    } catch (err) {
      toast(err.message);
    }
  });
  $('btnRefDel').onclick = () => mutate(() => { delete cur().ref; });
  $('btnShotDup').onclick = () => mutate(() => {
    const c = clone(cur());
    c.id = uid();
    c.name = `${c.name} 복제`;
    project.shots.splice(shotIdx + 1, 0, c);
    shotIdx += 1;
  });
  $('btnShotDel').onclick = deleteShot;
  $('btnShotUp').onclick = () => { if (shotIdx > 0) mutate(() => { const [s] = project.shots.splice(shotIdx, 1); project.shots.splice(--shotIdx, 0, s); }); };
  $('btnShotDown').onclick = () => { if (shotIdx < project.shots.length - 1) mutate(() => { const [s] = project.shots.splice(shotIdx, 1); project.shots.splice(++shotIdx, 0, s); }); };
  $('btnShotAdd').onclick = () => mutate(() => {
    const cs = resolveCamera(cur(), time, project.objects, false);
    project.shots.splice(shotIdx + 1, 0, {
      id: uid(), name: `샷 ${project.shots.length + 1}`, duration: 4, desc: '', ease: 'inout', shake: 0,
      keys: [{ t: 0, pos: vArr(cs.pos), target: vArr(cs.target), focal: r3(cs.focal), roll: r3(cs.roll) }],
      anim: {}, genAnim: [], meta: {},
    });
    shotIdx += 1;
    time = 0;
  });

  // Camera controls
  const focalApply = (v) => writeCamera({ focal: clamp(+v || 35, 8, 400) });
  liveInput($('cFocal'), (el) => { focalApply(el.value); $('cFocalN').value = el.value; });
  liveInput($('cFocalN'), (el) => focalApply(el.value));
  liveInput($('cRoll'), (el) => { writeCamera({ roll: +el.value }); $('cRollN').value = el.value; });
  liveInput($('cRollN'), (el) => writeCamera({ roll: clamp(+el.value || 0, -90, 90) }));
  liveInput($('cShake'), (el) => { cur().shake = +el.value; $('cShakeN').textContent = (+el.value).toFixed(2); });
  $('cLock').addEventListener('change', (e) => {
    const id = e.target.value;
    mutate(() => {
      const shot = cur();
      unlockShot(shot);
      if (id) lockShot(shot, id);
    });
    toast(id
      ? `카메라가 ${objById(id).name}을(를) 계속 바라봅니다 — 노란 타깃을 드래그하면 겨누는 높이를 조정합니다`
      : '타깃 고정을 해제했습니다 (현재 프레이밍은 키에 저장됨)', 4000);
  });
  $('btnSelCam').onclick = () => select({ kind: 'camera' });
  $('btnSelTgt').onclick = () => select({ kind: 'target' });
  $('btnAddKey').onclick = addCamKey;
  $('btnApplyAll').onclick = applyEditToAllKeys;
  $('btnCamFromView').onclick = () => {
    pushUndo();
    const forced = $('chkAutoKey').checked;
    $('chkAutoKey').checked = true;
    writeCamera({ pos: dirCam.position, target: orbit.target });
    $('chkAutoKey').checked = forced;
    refresh();
    toast('디렉터 뷰 시점을 카메라 키로 저장했습니다');
  };
  $('btnCopyPrompt').onclick = async () => {
    try { await navigator.clipboard.writeText($('promptOut').textContent); toast('프롬프트를 복사했습니다'); } catch { toast('복사에 실패했습니다'); }
  };

  // View bar
  document.querySelectorAll('#layoutSeg button').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));
  document.querySelectorAll('#gizmoSeg button').forEach((b) => b.addEventListener('click', () => { gizmoMode = b.dataset.gizmo; applyGizmoMode(); }));
  const toggle = (btnId, ovId) => $(btnId).addEventListener('click', () => {
    const on = !$(btnId).classList.contains('active');
    $(btnId).classList.toggle('active', on);
    $(ovId).hidden = !on;
  });
  toggle('tgThirds', 'ovThirds');
  toggle('tgSafe', 'ovSafe');
  toggle('tgHud', 'ovHud');
  $('tgRef').addEventListener('click', () => {
    refOn = !refOn;
    $('tgRef').classList.toggle('active', refOn);
    updateRef();
  });
  $('refOpacity').addEventListener('input', updateRef);
  {
    const bar = $('songBar');
    let seeking = false;
    const at = (e) => {
      const r = bar.getBoundingClientRect();
      return ((e.clientX - r.left) / r.width) * songSpan();
    };
    bar.addEventListener('pointerdown', (e) => {
      seeking = true;
      bar.setPointerCapture(e.pointerId);
      setPlaying(false);
      seekGlobal(at(e));
    });
    bar.addEventListener('pointermove', (e) => { if (seeking) seekGlobal(at(e)); });
    bar.addEventListener('pointerup', () => {
      if (!seeking) return;
      seeking = false;
      renderTimeline();
      renderCamKeys();
      renderObjInspector();
    });
    new ResizeObserver(() => { songDirty = true; }).observe(bar);
  }

  // Transport
  $('btnPlay').onclick = () => setPlaying(!playing);
  $('btnStart').onclick = () => { setPlaying(false); setTime(0); };
  $('btnEnd').onclick = () => { setPlaying(false); setTime(cur().duration); };

  window.addEventListener('keydown', onKey);
}

function setLayout(l) {
  layout = l;
  $('viewports').className = `layout-${l}` + (aspect() < 1.2 ? ' cols' : '');
  document.querySelectorAll('#layoutSeg button').forEach((b) => b.classList.toggle('active', b.dataset.layout === l));
  requestAnimationFrame(resize);
}

function addCamKey() {
  const shot = cur();
  if (keyIndexAt(shot.keys, time, frameTol()) >= 0) return toast('이미 이 시간에 키가 있습니다');
  mutate(() => {
    const s = resolveCamera(shot, time, project.objects, false);
    shot.keys.push({ t: r3(time), pos: vArr(s.pos), target: vArr(s.target), focal: r3(s.focal), roll: r3(s.roll) });
    sortKeys(shot.keys);
  });
}

function addObjKey() {
  const o = selection?.kind === 'object' ? objById(selection.id) : null;
  if (!o) return toast('먼저 디렉터 뷰나 씬 목록에서 오브젝트를 선택하세요');
  const shot = cur();
  const keys = shot.anim?.[o.id] || [];
  if (keyIndexAt(keys, time, frameTol()) >= 0) return toast('이미 이 시간에 키가 있습니다');
  const first = !keys.length;
  mutate(() => {
    shot.anim ||= {};
    const ks = (shot.anim[o.id] ||= []);
    const s = sampleLocal(o, shot, time);
    ks.push({ t: r3(time), pos: s.pos, rotY: s.rotY });
    sortKeys(ks);
    shot.genAnim = (shot.genAnim || []).filter((id) => id !== o.id);
  });
  toast(first
    ? `${o.name} 키 추가 — 이제 시간을 옮기고 ${o.name}을(를) 움직이면 다음 키가 자동으로 생깁니다`
    : `${o.name} 키 추가`, 4000);
}

function deleteShot() {
  if (project.shots.length <= 1) return toast('마지막 샷은 삭제할 수 없습니다');
  const n = shotIdx + 1;
  setPlaying(false);
  mutate(() => { project.shots.splice(shotIdx, 1); shotIdx = Math.max(0, shotIdx - 1); });
  toast(`샷 #${n}을(를) 삭제했습니다 — Ctrl+Z로 복구`);
}

// Which area Delete acts on: the shot strip or the scene selection.
let lastFocus = 'scene';
function setFocusArea(area) {
  lastFocus = area;
  $('shotStrip').classList.toggle('focused', area === 'shots');
}

function deleteSelectedObject() {
  if (selection?.kind !== 'object') return;
  const id = selection.id;
  select(null);
  mutate(() => {
    for (const s of project.shots) if (s.lookAt?.id === id) unlockShot(s);
    const gone = objById(id);
    for (const c of project.objects) if (c.parent === id) reparent(c, gone?.parent || '');
    project.objects = project.objects.filter((o) => o.id !== id);
    for (const s of project.shots) {
      if (s.anim) delete s.anim[id];
      if (s.hide) delete s.hide[id];
      if (s.poses) delete s.poses[id];
      if (s.meta?.subject === id) s.meta.subject = null;
      if (s.lookAt?.id === id) unlockShot(s);
    }
  });
}

function onKey(e) {
  if (isTyping()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); exportJSON(exportable()); return; }
  if (mod) return;
  switch (e.key) {
    case ' ': e.preventDefault(); setPlaying(!playing); break;
    case 'k': case 'K': addCamKey(); break;
    case 'o': case 'O': addObjKey(); break;
    case 'w': case 'W': gizmoMode = 'translate'; applyGizmoMode(); break;
    case 'e': case 'E': gizmoMode = 'rotate'; applyGizmoMode(); break;
    case 'f': case 'F': focusSelection(); break;
    case 'c': case 'C': select({ kind: 'camera' }); break;
    case 't': case 'T': select({ kind: 'target' }); break;
    case 'r': case 'R': $('tgRef').click(); break;
    case 'Escape': select(null); break;
    case 'Delete': case 'Backspace':
      if (lastFocus === 'shots' || selection?.kind !== 'object') deleteShot();
      else deleteSelectedObject();
      break;
    case 'ArrowLeft': setPlaying(false); setTime(time - 1 / project.fps); break;
    case 'ArrowRight': setPlaying(false); setTime(time + 1 / project.fps); break;
    case 'Home': setTime(0); break;
    case 'End': setTime(cur().duration); break;
    default:
  }
}

function loadProject(p, undoable) {
  if (undoable && project) pushUndo();
  project = p;
  project.assets ||= {};
  assetsDirty = true;
  shotIdx = 0;
  time = 0;
  thumbs.clear();
  select(null);
  refresh();
  queueThumbs(true);
}

// ---------------------------------------------------------------------------
// Shots handed over from the camera lab page (lab.html) through localStorage.

function importFromLab() {
  let h = null;
  try {
    h = JSON.parse(localStorage.getItem('previz.handoff.v1') || 'null');
    localStorage.removeItem('previz.handoff.v1');
  } catch { h = null; }
  if (!h || !h.params || Date.now() - (h.at || 0) > 10 * 60 * 1000) return;
  let actor = project.objects.find((o) => o.type === 'actor');
  mutate(() => {
    if (!actor) {
      actor = makeObject('actor', { name: '인물' });
      project.objects.push(actor);
    }
    const gen = generateShot({ ...defaultParams(), ...h.params, subject: actor.id }, project, null);
    const extra = {};
    if (h.desc) extra.desc = h.desc;
    if (h.light) extra.light = h.light;
    project.shots.splice(shotIdx + 1, 0, makeShot(gen, extra));
    shotIdx += 1;
    time = 0;
  });
  queueThumbs();
  toast(`구도 실험실에서 샷 #${shotIdx + 1}을(를) 가져왔습니다 — 피사체: ${actor.name}`, 4000);
}

// ---------------------------------------------------------------------------
// Boot

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(undefined), ms))]);

async function boot() {
  bindUI();
  let initial = null;
  try {
    const saved = localStorage.getItem('previz.project.v1');
    if (saved) initial = normalizeProject(JSON.parse(saved));
  } catch { initial = null; }
  if (initial) {
    const stored = await withTimeout(idbGet('assets'), 1500);
    if (stored && typeof stored === 'object') initial.assets = { ...stored, ...initial.assets };
  }
  // A bare #stadium (or #alley) in the link opens that example directly.
  const hashSample = SAMPLES[(location.hash || '').slice(1)];
  loadProject(hashSample ? hashSample() : initial || sampleProject(), false);
  importFromLab();
  setLayout(window.innerWidth < 900 ? 'camera' : 'split');
  requestAnimationFrame(frame);
  const saved = await withTimeout(idbGet('song'), 3000);
  if (saved?.blob && !song.loaded) await loadSong(saved.blob, saved.name, false);
}
boot();

// Debug / automation hook.
window.previz = {
  get project() { return project; },
  get meshes() { return meshes; },
  get physics() { return physics; },
  setShot, setTime, generateShot, parseShotText, describeShot, downloadText,
  makeObject, makeShot, normalizeProject, loadProject, renderFrame, defaultParams, song,
  loadSong, refresh, exportable,
};
