import * as THREE from 'three';

const DEFS = [
  { name: 'calm',      file: 'SCP096Calm',      positional: true,  loop: true,  volume: 1.8  },
  { name: 'faceSeen',  file: 'SCP096FaceSeen',  positional: true,  loop: false, volume: 2.2  },
  { name: 'rage',      file: 'SCP096Rage',      positional: true,  loop: false, volume: 2.2  },
  { name: 'hush',      file: 'SCP096Hush',      positional: false, loop: true,  volume: 1.05 },
  { name: 'runScream', file: 'SCP096RunScream', positional: true,  loop: true,  volume: 2.2  },
  { name: 'kill',      file: 'SCP096Kill',      positional: false, loop: false, volume: 1.3  },
];

const EXTENSIONS = ['mp3', 'ogg', 'wav'];
const POS = { refDistance: 12, rolloff: 0.6, maxDistance: 140 };

export class SoundManager {
  constructor(camera) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.loader = new THREE.AudioLoader();
    this.sounds = new Map();
    this._pending = new Set();     // plays requested before audio was ready
    this._allLoaded = false;
    this._readyFired = false;
    this.onReady = null;
  }

  async loadAll(basePath = '/sounds/') {
    await Promise.all(DEFS.map(async (def) => {
      const url = await this._findUrl(basePath, def.file);
      if (!url) {
        console.warn(`[sound] missing "${def.file}" (tried ${EXTENSIONS.join(', ')})`);
        return;
      }
      let buffer;
      try { buffer = await this.loader.loadAsync(url); }
      catch (e) { console.warn(`[sound] failed to decode "${url}"`, e); return; }

      let audio;
      if (def.positional) {
        audio = new THREE.PositionalAudio(this.listener);
        audio.setRefDistance(POS.refDistance);
        audio.setRolloffFactor(POS.rolloff);
        audio.setDistanceModel('exponential');
        audio.setMaxDistance(POS.maxDistance);
      } else {
        audio = new THREE.Audio(this.listener);
      }
      audio.setBuffer(buffer);
      audio.setLoop(!!def.loop);
      audio.setVolume(def.volume ?? 1);
      this.sounds.set(def.name, { audio, def, url });
    }));

    this._allLoaded = true;
    console.log(`[sound] loaded ${this.sounds.size}/${DEFS.length}`);
    this._flushPending();
    this._maybeReady();
  }

  /** Call from any user gesture (overlay click, etc.) */
  resumeContext() {
    const ctx = this.listener.context;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        console.log('[sound] audio context resumed');
        this._flushPending();
        this._maybeReady();
      }).catch(err => console.warn('[sound] resume failed', err));
    } else {
      this._flushPending();
      this._maybeReady();
    }
  }

  _maybeReady() {
    if (this._readyFired) return;
    if (!this._allLoaded) return;
    if (this.listener.context.state !== 'running') return;
    this._readyFired = true;
    console.log('[sound] audio ready');
    if (this.onReady) this.onReady();
  }

  _flushPending() {
    if (this.listener.context.state !== 'running') return;
    if (!this.sounds.size) return;
    for (const name of [...this._pending]) {
      const e = this.sounds.get(name);
      if (!e) continue;                       // still not loaded — keep waiting
      this._pending.delete(name);
      if (!e.audio.isPlaying) e.audio.play();
    }
  }

  async _findUrl(basePath, file) {
    for (const ext of EXTENSIONS) {
      const url = `${basePath}${file}.${ext}`;
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok) return url;
      } catch (_) { /* next */ }
    }
    return null;
  }

  attach(name, obj3D) {
    const e = this.sounds.get(name);
    if (!e || !e.def.positional) return;
    if (e.audio.parent) e.audio.parent.remove(e.audio);
    obj3D.add(e.audio);
  }

  play(name, { restart = true } = {}) {
    const e = this.sounds.get(name);
    if (!e) { this._pending.add(name); return; }
    if (this.listener.context.state !== 'running') { this._pending.add(name); return; }
    this._pending.delete(name);
    if (restart && e.audio.isPlaying) e.audio.stop();
    if (!e.audio.isPlaying) e.audio.play();
  }

  stop(name) {
    this._pending.delete(name);
    const e = this.sounds.get(name);
    if (!e) return;
    if (e.audio.isPlaying) e.audio.stop();
  }

  stopAll() {
    this._pending.clear();
    for (const [, e] of this.sounds) if (e.audio.isPlaying) e.audio.stop();
  }

  isPlaying(name) {
    const e = this.sounds.get(name);
    return e ? e.audio.isPlaying : false;
  }
}
