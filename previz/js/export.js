// Export helpers: stills, real-time WebM capture, GLB with per-shot camera clips, shot lists.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { resolveCamera, sampleObject, isAnimated } from './anim.js';

const safe = (s) => (s || 'previz').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'previz';

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function downloadText(text, name, type = 'text/plain') {
  download(new Blob([text], { type: `${type};charset=utf-8` }), name);
}

export function exportJSON(project) {
  downloadText(JSON.stringify(project, null, 2), `${safe(project.name)}.previz.json`, 'application/json');
}

export function exportPNG(renderer, scene, camera, w, h, setDirectorOnlyVisible, name) {
  renderer.setSize(w, h, false);
  setDirectorOnlyVisible(false);
  renderer.render(scene, camera);
  setDirectorOnlyVisible(true);
  renderer.domElement.toBlob((blob) => download(blob, safe(name)), 'image/png');
}

/**
 * Offline H.264 render: draws every frame with renderFrameAt(f) into `canvas` and encodes it with WebCodecs,
 * muxed into MP4 or MOV (QuickTime). Frame-exact and independent of playback speed.
 * audio: an AudioBuffer already cut to the video's length, or null. Resolves with { blob, audio }.
 */
export async function encodeVideo({ format, canvas, fps, frameCount, renderFrameAt, audio, onProgress, isCancelled, codec = 'avc', audioCodec = 'aac' }) {
  const mb = await import('../vendor/mediabunny/mediabunny.min.mjs');
  const { width, height } = canvas;
  if (typeof VideoEncoder === 'undefined' || !(await mb.canEncodeVideo(codec, { width, height }))) {
    throw new Error('이 브라우저는 H.264 인코딩을 지원하지 않습니다. 최신 Chrome·Edge·Safari에서 시도해 주세요');
  }
  const output = new mb.Output({
    format: format === 'mov' ? new mb.MovOutputFormat({ fastStart: 'in-memory' }) : new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new mb.BufferTarget(),
  });
  const video = new mb.CanvasSource(canvas, {
    codec,
    bitrate: Math.round(width * height * fps * 0.35), // ~14 Mbps at 1080p24
    keyFrameInterval: 1,
  });
  output.addVideoTrack(video, { frameRate: fps });
  let audioSrc = null;
  let audioState = audio ? 'unsupported' : 'none';
  if (audio && typeof AudioEncoder !== 'undefined'
    && (await mb.canEncodeAudio(audioCodec, { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate }))) {
    audioSrc = new mb.AudioBufferSource({ codec: audioCodec, bitrate: 192000 });
    output.addAudioTrack(audioSrc);
    audioState = audioCodec;
  }
  await output.start();
  for (let f = 0; f < frameCount; f++) {
    if (isCancelled?.()) {
      await output.cancel();
      return null;
    }
    renderFrameAt(f);
    await video.add(f / fps, 1 / fps);
    onProgress?.(f + 1, frameCount);
  }
  if (audioSrc) await audioSrc.add(audio);
  await output.finalize();
  return { blob: new Blob([output.target.buffer], { type: format === 'mov' ? 'video/quicktime' : 'video/mp4' }), audio: audioState };
}

export function saveBlob(blob, name) {
  download(blob, safe(name));
}

const nodeName = (s) => s.replace(/[^\w\-가-힣]+/g, '_');

/** One GLB with the set, one camera per shot, and one animation clip per shot. */
export async function exportGLB(project, meshes, sensorW) {
  const root = new THREE.Scene();
  root.name = safe(project.name);
  const objNodes = new Map();
  for (const o of project.objects) {
    const src = meshes.get(o.id);
    if (!src) continue;
    const c = src.clone(true);
    c.traverse((n) => { if (n.isSprite) n.visible = false; });
    const sprites = [];
    c.traverse((n) => { if (n.isSprite) sprites.push(n); });
    sprites.forEach((s) => s.parent.remove(s));
    c.name = nodeName(`${o.name}_${o.id}`);
    const base = sampleObject(o, null, 0);
    c.position.set(...base.pos);
    c.rotation.set(0, THREE.MathUtils.degToRad(base.rotY), 0);
    root.add(c);
    objNodes.set(o.id, c);
  }

  const clips = [];
  project.shots.forEach((shot, i) => {
    const tag = `Shot${String(i + 1).padStart(2, '0')}`;
    const cam = new THREE.PerspectiveCamera(40, project.aspect, 0.05, 1000);
    cam.name = `${tag}_Cam`;
    const s0 = resolveCamera(shot, 0, project.objects);
    cam.filmGauge = sensorW;
    cam.setFocalLength(s0.focal);
    root.add(cam);

    const n = Math.max(2, Math.round(shot.duration * project.fps) + 1);
    const times = [], pos = [], quat = [];
    const tmp = new THREE.PerspectiveCamera();
    for (let f = 0; f < n; f++) {
      const t = Math.min(shot.duration, f / project.fps);
      const s = resolveCamera(shot, t, project.objects);
      tmp.position.copy(s.pos);
      tmp.up.set(0, 1, 0);
      tmp.lookAt(s.target);
      if (s.roll) tmp.rotateZ(THREE.MathUtils.degToRad(s.roll));
      times.push(t);
      pos.push(s.pos.x, s.pos.y, s.pos.z);
      quat.push(tmp.quaternion.x, tmp.quaternion.y, tmp.quaternion.z, tmp.quaternion.w);
    }
    cam.position.set(pos[0], pos[1], pos[2]);
    cam.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
    const tracks = [
      new THREE.VectorKeyframeTrack(`${cam.name}.position`, times, pos),
      new THREE.QuaternionKeyframeTrack(`${cam.name}.quaternion`, times, quat),
    ];
    for (const o of project.objects) {
      const node = objNodes.get(o.id);
      if (!node || !isAnimated(o, shot)) continue;
      const ot = [], op = [], oq = [];
      const q = new THREE.Quaternion();
      for (let f = 0; f < n; f++) {
        const t = Math.min(shot.duration, f / project.fps);
        const s = sampleObject(o, shot, t);
        ot.push(t);
        op.push(...s.pos);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(s.rotY));
        oq.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${node.name}.position`, ot, op));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, ot, oq));
    }
    clips.push(new THREE.AnimationClip(tag, shot.duration, tracks));
  });

  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(root, { binary: true, animations: clips, onlyVisible: true });
  download(new Blob([glb], { type: 'model/gltf-binary' }), `${safe(project.name)}.glb`);
}

const mmss = (t) => {
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${neg ? '-' : ''}${m}:${s.toFixed(1).padStart(4, '0')}`;
};

export function exportPrompts(project, describeShot) {
  const lines = [];
  const total = project.shots.reduce((a, s) => a + s.duration, 0);
  const off = project.audio?.offset || 0;
  const starts = [];
  project.shots.reduce((acc, s) => { starts.push(acc); return acc + s.duration; }, 0);
  lines.push(`# ${project.name}`);
  lines.push('');
  lines.push(`- 화면비 ${(+project.aspect).toFixed(2)}:1 · ${project.fps}fps · 샷 ${project.shots.length}개 · 총 ${Math.round(total * 10) / 10}초`);
  lines.push('');
  lines.push('## 샷리스트');
  lines.push('');
  project.shots.forEach((s, i) => lines.push(`- [${mmss(starts[i] + off)}–${mmss(starts[i] + off + s.duration)}] ${describeShot(s, project, i).ko}`));
  lines.push('');
  lines.push('## AI 영상 프롬프트 (EN)');
  project.shots.forEach((s, i) => {
    lines.push('');
    lines.push(`### Shot ${i + 1} — ${s.name} (${mmss(starts[i] + off)}–${mmss(starts[i] + off + s.duration)})`);
    lines.push('');
    lines.push(describeShot(s, project, i).en);
  });
  const text = lines.join('\n') + '\n';
  downloadText(text, `${safe(project.name)}_shotlist.md`, 'text/markdown');
  return text;
}
