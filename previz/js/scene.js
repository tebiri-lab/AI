// Three.js scene construction: mannequins, props, ground, lighting presets and the camera rig.
import * as THREE from 'three';

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...extra });

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

// A 1.75 m mannequin built around a pelvis pivot so limbs can swing for walk cycles.
function buildActor(o) {
  const g = new THREE.Group();
  const body = std(o.color);
  const dark = std(new THREE.Color(o.color).multiplyScalar(0.55));
  const skin = std('#e8c4a0');
  const rig = new THREE.Group();
  g.add(rig);

  const pelvis = capsule(0.13, 0.12, dark);
  pelvis.rotation.z = Math.PI / 2;
  pelvis.position.y = 0.95;
  rig.add(pelvis);
  const torso = capsule(0.16, 0.34, body);
  torso.position.y = 1.24;
  torso.scale.z = 0.72;
  rig.add(torso);
  const neck = capsule(0.05, 0.06, skin);
  neck.position.y = 1.5;
  rig.add(neck);
  const head = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.108, 20, 16), skin));
  head.scale.set(0.9, 1.08, 1);
  head.position.y = 1.635;
  rig.add(head);
  // nose + eyes give a readable facing direction from any angle
  const nose = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 8), skin));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.63, 0.11);
  rig.add(nose);
  const eyeMat = std('#222');
  for (const x of [-0.037, 0.037]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), eyeMat);
    eye.position.set(x, 1.66, 0.095);
    rig.add(eye);
  }

  const limb = (x, y, r, len, mat) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const m = capsule(r, len, mat);
    m.position.y = -(len / 2 + r * 0.6);
    pivot.add(m);
    rig.add(pivot);
    return pivot;
  };
  const legL = limb(0.1, 0.93, 0.072, 0.74, dark);
  const legR = limb(-0.1, 0.93, 0.072, 0.74, dark);
  const armL = limb(0.225, 1.42, 0.048, 0.56, body);
  const armR = limb(-0.225, 1.42, 0.048, 0.56, body);
  armL.rotation.z = 0.08;
  armR.rotation.z = -0.08;
  for (const leg of [legL, legR]) {
    const foot = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.24), dark));
    foot.position.set(0, -0.87, 0.05);
    leg.add(foot);
  }

  const s = (o.height || 1.75) / 1.75;
  rig.scale.setScalar(s);
  g.userData.limbs = { legL, legR, armL, armR };
  const label = makeLabel(o.name);
  label.position.y = (o.height || 1.75) + 0.3;
  g.add(label);
  return g;
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

export function buildObject(o) {
  let g;
  switch (o.type) {
    case 'actor': g = buildActor(o); break;
    case 'car': g = buildCar(o); break;
    case 'tree': g = buildTree(o); break;
    case 'table': g = buildTable(o); break;
    case 'mark': g = buildMark(o); break;
    case 'cylinder': {
      g = new THREE.Group();
      const [w, h] = o.size;
      const m = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 24), std(o.color)));
      m.position.y = h / 2;
      g.add(m);
      break;
    }
    default: {
      g = new THREE.Group();
      const [w, h, d] = o.size || [1, 1, 1];
      const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(o.color)));
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
  return JSON.stringify([o.type, o.name, o.color, o.height, o.size]);
}

export function poseWalk(group, dist, speed) {
  const limbs = group.userData.limbs;
  if (!limbs) return;
  const amp = Math.min(1, speed / 1.3) * 0.55;
  const phase = (dist / 1.5) * Math.PI * 2; // one full cycle per 1.5 m stride pair
  const sw = Math.sin(phase) * amp;
  limbs.legL.rotation.x = sw;
  limbs.legR.rotation.x = -sw;
  limbs.armL.rotation.x = -sw * 0.8;
  limbs.armR.rotation.x = sw * 0.8;
}

// ---------------------------------------------------------------------------

export function buildGround() {
  const g = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: '#6b6e70', roughness: 0.95 }));
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
