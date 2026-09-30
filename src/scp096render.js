import * as THREE from 'three';

const CLIP = {
  sit:           'scp096_skeleton|sit',
  sit2start:     'scp096_skeleton|sit2start',
  sit2:          'scp096_skeleton|sit2',
  getup:         'scp096_skeleton|getup',
  panicstart1:   'scp096_skeleton|panicstart1',
  panic:         'scp096_skeleton|panic',
  running:       'scp096_skeleton|running',
  attackrunstart:'scp096_skeleton|attackrunstart',
  attackrun:     'scp096_skeleton|attackrun',
  attackjump:    'scp096_skeleton|attackjump',
  attack:        'scp096_skeleton|attack',
  teslagatehit:  'scp096_skeleton|teslagatehit',
};

const LOOPING = new Set([
  'sit', 'sit2', 'panic', 'running', 'attackrun', 'teslagatehit',
]);

export class SCP096Renderer {
  constructor({ model, gltf, scene, sounds }) {
    this.model = model;
    this.gltf = gltf;
    this.scene = scene;
    this.sounds = sounds;

    /* ---- feet on the floor -------------------------------------- */
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    model.position.y = -box.min.y;
    model.updateMatrixWorld(true);

    /* ---- red point light ---------------------------------------- */
    this.redLight = new THREE.PointLight(0xff1a1a, 3.2, 14, 1.8);
    this.redLight.position.set(0, 1.6, 0);
    model.add(this.redLight);

    /* ---- sounds anchored at head height ------------------------- */
    if (this.sounds) {
      this.soundAnchor = new THREE.Object3D();
      this.soundAnchor.position.set(0, 2.2, 0);
      model.add(this.soundAnchor);
      this.sounds.attach('calm',      this.soundAnchor);
      this.sounds.attach('faceSeen',  this.soundAnchor);
      this.sounds.attach('rage',      this.soundAnchor);
      this.sounds.attach('runScream', this.soundAnchor);
    }

    /* ---- animations -------------------------------------------- */
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    this._finishCB = new Map();
    const byName = new Map(gltf.animations.map(c => [c.name, c]));
    for (const [k, n] of Object.entries(CLIP)) {
      const clip = byName.get(n);
      if (!clip) { console.warn('[SCP] missing clip:', n); continue; }
      this.actions[k] = this.mixer.clipAction(clip);
    }
    this.mixer.addEventListener('finished', (e) => {
      const cb = this._finishCB.get(e.action);
      if (cb) { this._finishCB.delete(e.action); cb(); }
    });

    /* ---- bones for hit testing ---------------------------------- */
    this.bones = [];
    model.traverse(o => { if (o.isBone) this.bones.push(o); });
    console.log(`[SCP render] indexed ${this.bones.length} bones for hit tests`);

    /* ---- scratch ------------------------------------------------ */
    this._hitVec = new THREE.Vector3();
    this._tmpPt  = new THREE.Vector3();
    this._hitBox = new THREE.Box3();

    /* ---- state -------------------------------------------------- */
    this.state = null;
    this.substate = null;
    this.currentAnim = null;
    this.currentAction = null;
    this._stunned = false;

    /* local IDLE cycle */
    this.idlePhase = 'sit';
    this.idleTimer = 0;

    /* interpolation */
    this._target = new THREE.Vector3();
    this._targetYaw = 0;
    this._posInit = false;
  }

  /* ============================================================== *
   *  SOUND HELPERS
   * ============================================================== */
  _sound(n)  { if (this.sounds) this.sounds.play(n); }
  _stop(n)   { if (this.sounds) this.sounds.stop(n); }
  _stopAll() { if (this.sounds) this.sounds.stopAll(); }

  /* ============================================================== *
   *  POSITION (from server state tick)
   * ============================================================== */
  setPosition(scpPos) {
    if (!scpPos) return;
    this._target.set(scpPos.x, 0, scpPos.z);
    this._targetYaw = scpPos.yaw;
    if (!this._posInit) {
      this.model.position.x = scpPos.x;
      this.model.position.z = scpPos.z;
      this.model.rotation.y = scpPos.yaw;
      this._posInit = true;
    }
  }

  /* ============================================================== *
   *  HIT TESTING (client-side, used by the bazooka)
   * ============================================================== */
  hitTestPoint(x, y, z, extraRadius = 0) {
    if (!this.model) return false;
    if (this.bones && this.bones.length) {
      const r = 0.55 + extraRadius;
      const r2 = r * r;
      const v = this._hitVec;
      for (const b of this.bones) {
        b.getWorldPosition(v);
        const dx = x - v.x, dy = y - v.y, dz = z - v.z;
        if (dx * dx + dy * dy + dz * dz <= r2) return true;
      }
    }
    if (this._hitBox) {
      if (this._hitBox.containsPoint(this._tmpPt.set(x, y, z))) return true;
    }
    return false;
  }

  hitTestSegment(x1, y1, z1, x2, y2, z2, extraRadius = 0) {
    if (!this.model) return false;
    this.model.updateMatrixWorld(true);

    /* rebuild bbox once per query */
    if (this.bones && this.bones.length) {
      this._hitBox.makeEmpty();
      const v = this._hitVec;
      for (const b of this.bones) {
        b.getWorldPosition(v);
        this._hitBox.expandByPoint(v);
      }
      this._hitBox.expandByScalar(0.45);
    }

    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz);
    const r = 0.55 + extraRadius;
    const steps = Math.max(2, Math.ceil(len / (r * 0.5)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      if (this.hitTestPoint(x1 + dx * t, y1 + dy * t, z1 + dz * t, extraRadius))
        return true;
    }
    return false;
  }

  isStunned() { return this._stunned === true; }

  /* ============================================================== *
   *  STATE (from server)
   * ============================================================== */
  setState(state, substate) {
    const stateChanged    = state !== this.state;
    const substateChanged = substate !== this.substate;
    this.state = state;
    this.substate = substate;

    /* track stunned flag for hit test filtering */
    this._stunned = (state === 'STUNNED');

    if (!stateChanged && !substateChanged) return;

    console.log(`[SCP render] state ${state}${substate ? '/' + substate : ''}`);

    switch (state) {
      case 'STUNNED':
        if (stateChanged) {
          this._stopAll();
          this._playOnce('teslagatehit', null, 0.1);
          this.currentAnim = 'teslagatehit';
        }
        break;

      case 'IDLE':
        if (stateChanged) {
          this._stopAll();
          this._sound('calm');
          this._startIdleCycle();
        }
        break;

      case 'PANIC':
        if (stateChanged) {
          this._stop('calm');
          this._sound('faceSeen');
          this._sound('rage');
          this._startPanicSequence();
        }
        break;

      case 'CHASE':
        if (stateChanged) {
          /* leave rage sound playing through its tail */
          this._sound('hush');
          this._sound('runScream');
          this._playLoop('running');
          this.currentAnim = 'running';
        } else {
          this._handleChaseSubstate(substate);
        }
        break;

      case 'ATTACK':
        if (stateChanged) {
          this._stop('hush');
          this._stop('runScream');
          this._stop('rage');
          this._sound('kill');
        }
        this._handleAttackSubstate(substate);
        break;
    }
  }

  /* ---- IDLE cycle ---- */
  _startIdleCycle() {
    this.idlePhase = 'sit';
    this.idleTimer = 15;
    this._playLoop('sit');
    this.currentAnim = 'sit';
  }

  _updateIdleCycle(dt) {
    if (this.state !== 'IDLE') return;
    this.idleTimer -= dt;
    if (this.idleTimer > 0) return;

    if (this.idlePhase === 'sit') {
      this.idlePhase = 'sit2';
      this.idleTimer = 15;
      this._playOnce('sit2start', () => {
        if (this.state === 'IDLE' && this.idlePhase === 'sit2') {
          this._playLoop('sit2');
          this.currentAnim = 'sit2';
        }
      });
      this.currentAnim = 'sit2start';
    } else {
      this.idlePhase = 'sit';
      this.idleTimer = 15;
      this._playLoop('sit');
      this.currentAnim = 'sit';
    }
  }

  /* ---- PANIC chain ---- */
  _startPanicSequence() {
    this._playOnce('getup', () => {
      this._playOnce('panicstart1', () => {
        this._playLoop('panic');
        this.currentAnim = 'panic';
      });
      this.currentAnim = 'panicstart1';
    });
    this.currentAnim = 'getup';
  }

  /* ---- CHASE substates ---- */
  _handleChaseSubstate(substate) {
    switch (substate) {
      case 'running':
        if (this.currentAnim !== 'running') {
          this._playLoop('running');
          this.currentAnim = 'running';
        }
        break;

      case 'attackrunstart':
        this._playOnce('attackrunstart', () => {
          if (this.state === 'CHASE' && this.substate === 'attackrunstart') {
            this._playLoop('attackrun');
            this.currentAnim = 'attackrun';
          }
        });
        this.currentAnim = 'attackrunstart';
        break;

      case 'attackrun':
        if (this.currentAnim !== 'attackrun') {
          this._playLoop('attackrun');
          this.currentAnim = 'attackrun';
        }
        break;

      case 'attackrunstart_reverse':
        this._playReverse('attackrunstart', () => {
          if (this.state === 'CHASE' && this.substate === 'attackrunstart_reverse') {
            this._playLoop('running');
            this.currentAnim = 'running';
          }
        });
        this.currentAnim = 'attackrunstart_reverse';
        break;
    }
  }

  /* ---- ATTACK substates ---- */
  _handleAttackSubstate(substate) {
    if (substate === 'attackjump') {
      if (this.currentAnim !== 'attackjump') {
        this._playOnce('attackjump', null, 0.1);
        this.currentAnim = 'attackjump';
      }
    } else if (substate === 'attack') {
      if (this.currentAnim !== 'attack') {
        this._playOnce('attack', null, 0.1);
        this.currentAnim = 'attack';
      }
    }
  }

  /* ============================================================== *
   *  PLAYBACK PRIMITIVES
   * ============================================================== */
  _stopOthers(keepKey, fade) {
    for (const [k, a] of Object.entries(this.actions)) {
      if (k === keepKey) continue;
      if (a.isRunning() || a.getEffectiveWeight() > 0.001) a.fadeOut(fade);
    }
  }

  _playLoop(name, fade = 0.2) {
    const a = this.actions[name];
    if (!a) return null;
    this._stopOthers(name, fade);
    a.reset();
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = false;
    a.timeScale = 1;
    a.paused = false;
    a.fadeIn(fade).play();
    this.currentAction = a;
    return a;
  }

  _playOnce(name, onFinish, fade = 0.15) {
    const a = this.actions[name];
    if (!a) return null;
    this._stopOthers(name, fade);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = 1;
    a.paused = false;
    a.fadeIn(fade).play();
    if (onFinish) this._finishCB.set(a, onFinish);
    this.currentAction = a;
    return a;
  }

  _playReverse(name, onFinish, fade = 0.15) {
    const a = this.actions[name];
    if (!a) return null;
    this._stopOthers(name, fade);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = -1;
    a.paused = false;
    a.time = a.getClip().duration;
    a.fadeIn(fade).play();
    if (onFinish) this._finishCB.set(a, onFinish);
    this.currentAction = a;
    return a;
  }

  /* ============================================================== *
   *  FRAME UPDATE
   * ============================================================== */
  update(dt) {
    this.mixer.update(dt);
    this._updateIdleCycle(dt);

    /* smooth position */
    const t = Math.min(1, dt * 15);
    this.model.position.x += (this._target.x - this.model.position.x) * t;
    this.model.position.z += (this._target.z - this.model.position.z) * t;

    let dy = this._targetYaw - this.model.rotation.y;
    while (dy >  Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.model.rotation.y += dy * t;
  }
}
