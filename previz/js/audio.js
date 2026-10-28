// Song playback on a Web Audio clock so the animatic stays frame-locked to the music.

function computePeaks(buffer, n) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const len = buffer.length;
  const step = Math.max(1, Math.floor(len / n));
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = i * step, b = Math.min(len, a + step);
    for (let j = a; j < b; j += 16) {
      for (const ch of chans) {
        const v = Math.abs(ch[j]);
        if (v > m) m = v;
      }
    }
    peaks[i] = m;
  }
  return peaks;
}

export class SongPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.buffer = null;
    this.src = null;
    this.peaks = null;
    this.name = '';
    this.playing = false;
    this.startCtx = 0;
    this.startSong = 0;
    this.recDest = null;
    this.muted = false;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  get loaded() { return !!this.buffer; }
  get duration() { return this.buffer ? this.buffer.duration : 0; }

  async load(blob, name) {
    const ctx = this.ensure();
    const data = await blob.arrayBuffer();
    this.stop();
    this.buffer = await ctx.decodeAudioData(data);
    this.name = name || '';
    this.peaks = computePeaks(this.buffer, 4000);
  }

  unload() {
    this.stop();
    this.buffer = null;
    this.peaks = null;
    this.name = '';
  }

  setMuted(m) {
    this.muted = m;
    if (this.gain) this.gain.gain.value = m ? 0 : 1;
  }

  /** Start playback at song time `at` (seconds, may be negative = silence first). */
  play(at) {
    if (!this.buffer) return;
    const ctx = this.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    this.stop();
    if (at >= this.buffer.duration) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    const when = ctx.currentTime + 0.03 + Math.max(0, -at);
    src.start(when, Math.max(0, at));
    this.src = src;
    this.startCtx = ctx.currentTime + 0.03;
    this.startSong = at;
    this.playing = true;
  }

  stop() {
    if (this.src) {
      try { this.src.stop(); } catch { /* already stopped */ }
      this.src.disconnect();
      this.src = null;
    }
    this.playing = false;
  }

  /** Current song time while playing. */
  clock() {
    return this.startSong + Math.max(0, this.ctx.currentTime - this.startCtx);
  }

  /** An audio track carrying the song, for MediaRecorder. */
  recordTrack() {
    const ctx = this.ensure();
    if (!this.recDest) {
      this.recDest = ctx.createMediaStreamDestination();
      this.gain.connect(this.recDest);
    }
    return this.recDest.stream.getAudioTracks()[0];
  }
}
