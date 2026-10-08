import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { SIZES, ANGLES, DIRS, MOVES, SENSORS, ASPECTS, LIGHTS, OBJ_TYPES, ACTOR_COLORS } from './constants.js';
import { sampleCamera, sampleObject, sortKeys, keyIndexAt } from './anim.js';
import { generateShot, parseShotText, describeShot, defaultParams } from './generator.js';
import { buildObject, signature, poseWalk, buildGround, buildLights, applyLighting, buildCameraRig } from './scene.js';
import { exportPNG, recordWebM, exportGLB, exportPrompts, exportJSON, downloadText } from './export.js';

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
  if (type === 'actor') o.height = 1.75;
  if (type === 'tree') o.height = 5;
  if (def.size) o.size = def.size.slice();
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
let recording = null;
const undoStack = [];
const redoStack = [];
const cur = () => project.shots[shotIdx];
const objById = (id) => project.objects.find((o) => o.id === id);
const frameTol = () => 0.5 / project.fps;
const aspect = () => +project.aspect;
const sensorW = () => (SENSORS[project.sensor] || SENSORS.s35).w;

function snapshot() {
  return JSON.stringify({ project, shotIdx });
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
}
function restore(snap) {
  const s = JSON.parse(snap);
  project = s.project;
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
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('previz.project.v1', JSON.stringify(project)); } catch { /* storage unavailable */ }
  }, 400);
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

// ---------------------------------------------------------------------------
// Scene sync

const meshes = new Map();

function syncScene() {
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
  applyLighting(scene, lights, ground, project.lighting);
}

function disposeTree(g) {
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
  for (const o of project.objects) {
    const g = meshes.get(o.id);
    if (!g) continue;
    if (dragging && gizmo.object === g) continue;
    const s = sampleObject(o, shot, t);
    g.position.set(...s.pos);
    g.rotation.set(0, THREE.MathUtils.degToRad(s.rotY), 0);
    poseWalk(g, s.dist, s.speed);
  }
  const cs = sampleCamera(shot, t);
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
    const clean = sampleCamera(cur(), time, false);
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
  const dp = $('directorPane');
  const dw = dp.clientWidth, dh = dp.clientHeight;
  if (dw > 0 && dh > 0) {
    dirRenderer.setSize(dw, dh, false);
    dirCam.aspect = dw / dh;
    dirCam.updateProjectionMatrix();
  }
  const sp = $('shotPane');
  const pw = sp.clientWidth - 24, ph = sp.clientHeight - 24;
  if (pw > 0 && ph > 0 && !recording) {
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
  const cs = sampleCamera(shot, 0, false);
  for (const o of project.objects) {
    const g = meshes.get(o.id);
    const s = sampleObject(o, shot, 0);
    g.position.set(...s.pos);
    g.rotation.set(0, THREE.MathUtils.degToRad(s.rotY), 0);
    poseWalk(g, 0, 0);
  }
  const cam = new THREE.PerspectiveCamera();
  cam.near = 0.03; cam.far = 2000;
  applyCamera(cam, cs, a);
  setDirectorOnlyVisible(false);
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
  if (playing) advance(dt);

  if (thumbQueue.size) renderOneThumb();

  const shot = cur();
  const cs = poseScene(shot, time);
  updateDirectorAids(cs);
  orbit.update();

  if (layout !== 'camera') {
    setDirectorOnlyVisible(true);
    dirRenderer.render(scene, dirCam);
  }
  if (layout !== 'director' || recording) {
    setDirectorOnlyVisible(false);
    shotRenderer.render(scene, shotCam);
    setDirectorOnlyVisible(true);
  }
  updateHud(cs);
  requestAnimationFrame(frame);
}

function advance(dt) {
  const shot = cur();
  time += dt;
  if (time >= shot.duration) {
    const all = $('chkAll').checked || recording?.all;
    if (all && shotIdx < project.shots.length - 1) {
      time -= shot.duration;
      setShot(shotIdx + 1, { keepTime: true });
    } else if (recording) {
      time = shot.duration;
      stopRecording();
    } else if ($('chkLoop').checked) {
      if (all) setShot(0, { keepTime: true });
      time = 0;
    } else {
      time = shot.duration;
      setPlaying(false);
    }
  }
  updatePlayhead();
}

function setPlaying(v) {
  playing = v;
  $('btnPlay').textContent = v ? '❚❚' : '▶';
  $('btnPlay').classList.toggle('on', v);
  if (v && time >= cur().duration - 1e-3) time = 0;
}

function timecode(t, fps) {
  const total = Math.floor(t * fps + 1e-6);
  const f = total % fps, s = Math.floor(total / fps) % 60, m = Math.floor(total / fps / 60);
  return [m, s, f].map((x) => String(x).padStart(2, '0')).join(':');
}

function updateHud(cs) {
  const shot = cur();
  const sensor = SENSORS[project.sensor] || SENSORS.s35;
  const key = `${shotIdx}|${shot.name}|${Math.round(cs.focal)}|${time.toFixed(3)}|${project.aspect}|${project.sensor}`;
  if (key === hudCache) return;
  hudCache = key;
  $('hudTL').textContent = `#${shotIdx + 1}  ${shot.name}`;
  $('hudTR').textContent = `${Math.round(cs.focal)}mm · ${sensor.en}`;
  $('hudBL').textContent = `${timecode(time, project.fps)} / ${timecode(shot.duration, project.fps)}`;
  $('hudBR').textContent = `${(+project.aspect).toFixed(2)}:1 · ${project.fps}fps`;
  $('timecode').textContent = timecode(time, project.fps);
  const focal = $('cFocal');
  if (document.activeElement !== focal && document.activeElement !== $('cFocalN')) {
    focal.value = Math.round(cs.focal);
    $('cFocalN').value = Math.round(cs.focal);
  }
  const clean = sampleCamera(shot, time, false);
  if (document.activeElement !== $('cRoll') && document.activeElement !== $('cRollN')) {
    $('cRoll').value = Math.round(clean.roll);
    $('cRollN').value = Math.round(clean.roll);
  }
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

function writeCamera(patch) {
  const shot = cur();
  const base = sampleCamera(shot, time, false);
  const ok = upsertKey(shot.keys,
    () => ({ pos: vArr(base.pos), target: vArr(base.target), focal: r3(base.focal), roll: r3(base.roll) }),
    (k) => {
      if (patch.pos) k.pos = vArr(patch.pos);
      if (patch.target) k.target = vArr(patch.target);
      if (patch.focal != null) k.focal = r3(patch.focal);
      if (patch.roll != null) k.roll = r3(patch.roll);
    });
  if (ok) shot.meta = { ...shot.meta, edited: true };
  return ok;
}

function writeObject(o, pos, rotY) {
  const shot = cur();
  const keys = shot.anim?.[o.id];
  if (keys && keys.length) {
    const s = sampleObject(o, shot, time);
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
    const rot = Math.round(THREE.MathUtils.radToDeg(g.rotation.y) * 10) / 10;
    writeObject(o, vArr(g.position).map((v, i) => (i === 1 ? Math.max(0, v) : v)), rot);
    renderObjInspectorValues();
  }
  updatePath();
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
  resize();
  queueThumbs();
  autosave();
  hudCache = '';
}

// Lighter refresh for continuous edits.
function softRefresh() {
  updatePath();
  renderTimeline();
  renderCamKeys();
  renderPrompt();
  hudCache = '';
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
  hudCache = '';
}

function setTime(t) {
  time = clamp(t, 0, cur().duration);
  updatePlayhead();
  hudCache = '';
}

function renderProjectPanel() {
  $('projectName').value = project.name;
  $('pAspect').value = String(Object.keys(ASPECTS).find((k) => Math.abs(ASPECTS[k].v - project.aspect) < 0.01) || '2.39');
  $('pSensor').value = project.sensor;
  $('pFps').value = String(project.fps);
  $('pLight').value = project.lighting;
  if (document.activeElement !== $('pStyle')) $('pStyle').value = project.style || '';
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
  project.shots.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'shot-card' + (i === shotIdx ? ' active' : '');
    card.dataset.id = s.id;
    card.draggable = true;
    const img = document.createElement('img');
    img.alt = '';
    if (thumbs.has(s.id)) img.src = thumbs.get(s.id);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<b>${i + 1}</b><span class="nm"></span><span class="dur">${s.duration}s</span>`;
    meta.querySelector('.nm').textContent = s.name;
    card.append(img, meta);
    card.addEventListener('click', () => { setPlaying(false); setShot(i); });
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
  const src = s.meta?.source;
  $('sDesc').title = src ? `원문: ${src}` : '';
}

function renderCamKeys() {
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
    nm.textContent = o.name;
    const ty = document.createElement('span');
    ty.className = 'ty';
    ty.textContent = OBJ_TYPES[o.type].ko + (cur().anim?.[o.id]?.length ? ' · ◆' : '');
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
  const hasH = o.type === 'actor' || o.type === 'tree';
  $('oHWrap').hidden = !hasH;
  if (hasH) $('oH').value = o.height;
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

function renderObjInspectorValues() {
  const o = selection?.kind === 'object' ? objById(selection.id) : null;
  if (!o) return;
  const s = sampleObject(o, cur(), time);
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = Math.round(v * 100) / 100; };
  set('oX', s.pos[0]); set('oY', s.pos[1]); set('oZ', s.pos[2]); set('oRot', s.rotY);
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

function applyGenToShot(shot, gen) {
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

async function startRecording(all) {
  if (recording) return;
  if (typeof MediaRecorder === 'undefined' || !shotCanvas.captureStream) return toast('이 브라우저는 영상 녹화를 지원하지 않습니다');
  setPlaying(false);
  if (all) setShot(0);
  time = 0;
  const a = aspect();
  const w = a >= 1 ? 1920 : 1080;
  const h = Math.round(w / a / 2) * 2;
  shotRenderer.setSize(w, h, false);
  recording = { all, done: null };
  $('recBadge').hidden = false;
  const finished = recordWebM(shotCanvas, project.fps, (stop) => { recording.done = stop; });
  setPlaying(true);
  toast(all ? '전체 애니매틱을 녹화하는 중… (실시간)' : '현재 샷을 녹화하는 중… (실시간)', 4000);
  const shotNo = shotIdx + 1;
  const blob = await finished;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${project.name || 'previz'}${all ? '' : `_shot${shotNo}`}.webm`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('WebM 저장 완료');
}

function stopRecording() {
  setPlaying(false);
  const r = recording;
  recording = null;
  $('recBadge').hidden = true;
  r?.done?.();
  resize();
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
  $('btnSample').onclick = () => loadProject(sampleProject(), true);
  $('btnSave').onclick = () => exportJSON(project);
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
      } else if (kind === 'webm-shot') await startRecording(false);
      else if (kind === 'webm-all') await startRecording(true);
      else if (kind === 'gltf') {
        await exportGLB(project, meshes, sensorW());
        toast('GLB 저장 완료 — 샷마다 카메라와 애니메이션 클립이 포함됩니다', 4000);
      } else if (kind === 'prompts') {
        const text = exportPrompts(project, describeShot);
        try { await navigator.clipboard.writeText(text); toast('샷리스트를 저장하고 클립보드에 복사했습니다'); } catch { toast('샷리스트를 저장했습니다'); }
      } else if (kind === 'json') exportJSON(project);
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
  $('oH').addEventListener('change', (e) => objEdit((o) => { o.height = clamp(+e.target.value || 1.75, 0.3, 30); }));
  ['oSX', 'oSY', 'oSZ'].forEach((id, i) => $(id).addEventListener('change', (e) => objEdit((o) => { o.size[i] = clamp(+e.target.value || 1, 0.05, 200); })));
  const posEdit = () => objEdit((o) => {
    writeObject(o, [+$('oX').value || 0, Math.max(0, +$('oY').value || 0), +$('oZ').value || 0], +$('oRot').value || 0);
  });
  ['oX', 'oY', 'oZ', 'oRot'].forEach((id) => $(id).addEventListener('change', posEdit));
  $('btnObjKey').onclick = () => objEdit((o) => {
    const shot = cur();
    shot.anim ||= {};
    const keys = (shot.anim[o.id] ||= []);
    const s = sampleObject(o, shot, time);
    const i = keyIndexAt(keys, time, frameTol());
    if (i >= 0) return;
    keys.push({ t: r3(time), pos: s.pos, rotY: s.rotY });
    sortKeys(keys);
    shot.genAnim = (shot.genAnim || []).filter((id) => id !== o.id);
  });
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
  $('btnShotDup').onclick = () => mutate(() => {
    const c = clone(cur());
    c.id = uid();
    c.name = `${c.name} 복제`;
    project.shots.splice(shotIdx + 1, 0, c);
    shotIdx += 1;
  });
  $('btnShotDel').onclick = () => {
    if (project.shots.length <= 1) return toast('마지막 샷은 삭제할 수 없습니다');
    mutate(() => { project.shots.splice(shotIdx, 1); shotIdx = Math.max(0, shotIdx - 1); });
  };
  $('btnShotUp').onclick = () => { if (shotIdx > 0) mutate(() => { const [s] = project.shots.splice(shotIdx, 1); project.shots.splice(--shotIdx, 0, s); }); };
  $('btnShotDown').onclick = () => { if (shotIdx < project.shots.length - 1) mutate(() => { const [s] = project.shots.splice(shotIdx, 1); project.shots.splice(++shotIdx, 0, s); }); };
  $('btnShotAdd').onclick = () => mutate(() => {
    const cs = sampleCamera(cur(), time, false);
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
  $('btnSelCam').onclick = () => select({ kind: 'camera' });
  $('btnSelTgt').onclick = () => select({ kind: 'target' });
  $('btnAddKey').onclick = addCamKey;
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
    const s = sampleCamera(shot, time, false);
    shot.keys.push({ t: r3(time), pos: vArr(s.pos), target: vArr(s.target), focal: r3(s.focal), roll: r3(s.roll) });
    sortKeys(shot.keys);
  });
}

function deleteSelectedObject() {
  if (selection?.kind !== 'object') return;
  const id = selection.id;
  select(null);
  mutate(() => {
    project.objects = project.objects.filter((o) => o.id !== id);
    for (const s of project.shots) {
      if (s.anim) delete s.anim[id];
      if (s.meta?.subject === id) s.meta.subject = null;
    }
  });
}

function onKey(e) {
  if (isTyping()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); exportJSON(project); return; }
  if (mod) return;
  switch (e.key) {
    case ' ': e.preventDefault(); setPlaying(!playing); break;
    case 'k': case 'K': addCamKey(); break;
    case 'w': case 'W': gizmoMode = 'translate'; applyGizmoMode(); break;
    case 'e': case 'E': gizmoMode = 'rotate'; applyGizmoMode(); break;
    case 'f': case 'F': focusSelection(); break;
    case 'c': case 'C': select({ kind: 'camera' }); break;
    case 't': case 'T': select({ kind: 'target' }); break;
    case 'Escape': select(null); break;
    case 'Delete': case 'Backspace': deleteSelectedObject(); break;
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
  shotIdx = 0;
  time = 0;
  thumbs.clear();
  select(null);
  refresh();
  queueThumbs(true);
}

// ---------------------------------------------------------------------------
// Boot

bindUI();
let initial = null;
try {
  const saved = localStorage.getItem('previz.project.v1');
  if (saved) initial = normalizeProject(JSON.parse(saved));
} catch { initial = null; }
loadProject(initial || sampleProject(), false);
setLayout(window.innerWidth < 900 ? 'camera' : 'split');
requestAnimationFrame(frame);

// Debug / automation hook.
window.previz = {
  get project() { return project; },
  setShot, setTime, generateShot, parseShotText, describeShot, downloadText,
};
