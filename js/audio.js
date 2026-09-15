// Positional audio using the game's own OGG clips (Web Audio).
export class SoundManager {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.listener = null;
    this.master = null;
    this.playing = new Set();
    this.muffle = null;
  }

  ensure() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    this.listener = this.ctx.listener;
  }

  resume() { this.ensure(); if (this.ctx.state !== 'running') this.ctx.resume(); }

  async load(id) {
    if (!id) return null;
    if (this.buffers.has(id)) return this.buffers.get(id);
    this.ensure();
    const p = fetch('assets/audio/' + id + '.ogg').then(r => { if (!r.ok) throw new Error('no clip ' + id); return r.arrayBuffer(); })
      .then(b => this.ctx.decodeAudioData(b)).catch(e => { console.warn('audio', id, e.message); return null; });
    this.buffers.set(id, p);
    return p;
  }

  setListener(pos, fwd, up) {
    if (!this.ctx) return;
    const l = this.listener, t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t); l.positionY.setValueAtTime(pos.y, t); l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(fwd.x, t); l.forwardY.setValueAtTime(fwd.y, t); l.forwardZ.setValueAtTime(fwd.z, t);
      l.upX.setValueAtTime(up.x, t); l.upY.setValueAtTime(up.y, t); l.upZ.setValueAtTime(up.z, t);
    } else { l.setPosition(pos.x, pos.y, pos.z); l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
  }

  /**
   * Play a clip. opts: {pos:{x,y,z}|null (2D), vol, loop, pitch, min, max, ref}
   * Returns a handle {stop(), setPos(), setVol(), node}.
   */
  async play(id, opts = {}) {
    this.ensure();
    const buf = await this.load(id);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = !!opts.loop; src.playbackRate.value = opts.pitch || 1;
    const gain = this.ctx.createGain(); gain.gain.value = opts.vol == null ? 1 : opts.vol;
    let panner = null;
    if (opts.pos) {
      panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
      panner.refDistance = opts.min || 1.5; panner.maxDistance = opts.max || 40; panner.rolloffFactor = opts.rolloff || 1.2;
      panner.positionX.value = opts.pos.x; panner.positionY.value = opts.pos.y; panner.positionZ.value = opts.pos.z;
      src.connect(gain); gain.connect(panner); panner.connect(this.master);
    } else { src.connect(gain); gain.connect(this.master); }
    let filter = null;
    if (opts.lowpass) {
      filter = this.ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = opts.lowpass;
      gain.disconnect(); gain.connect(filter); filter.connect(panner || this.master);
    }
    const handle = {
      node: src, gain, panner, done: false,
      stop(fade = 0) {
        if (this.done) return; this.done = true;
        try { if (fade > 0) { gain.gain.setTargetAtTime(0, src.context.currentTime, fade / 3); src.stop(src.context.currentTime + fade); } else src.stop(); } catch (e) { }
      },
      setPos(p) { if (panner) { panner.positionX.value = p.x; panner.positionY.value = p.y; panner.positionZ.value = p.z; } },
      setVol(v) { gain.gain.value = v; },
      setPitch(v) { src.playbackRate.value = v; },
    };
    src.onended = () => { handle.done = true; this.playing.delete(handle); };
    src.start(0, opts.offset || 0);
    this.playing.add(handle);
    return handle;
  }

  stopAll() { for (const h of this.playing) h.stop(); this.playing.clear(); }
}

export function pickClip(refs) {
  if (!refs) return null;
  if (Array.isArray(refs)) { const r = refs.filter(x => x && x.$); return r.length ? r[Math.floor(Math.random() * r.length)].$ : null; }
  return refs.$ || null;
}
