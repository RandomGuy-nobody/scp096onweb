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
  teslagatehit:  'scp096_skeleton|teslagatehit',   // ← add this
};

const S = { IDLE: 'IDLE', PANIC: 'PANIC', CHASE: 'CHASE', ATTACK: 'ATTACK' };

const T = {
  SIT_CYCLE:        15,
  PANIC_DURATION:   27,
  CHASE_SPEED:      23,
  TURN_SPEED:       9,
  ATTACK_RANGE:     7.0,
  ATTACK_EXIT_RANGE:10.5,
  KILL_RANGE:       1.7,
  RESPAWN_AT:       1.5,
  LOOK_RANGE:       42,
  REPATH_INTERVAL:  0.6,
  PATH_NODE_REACH:  0.35,
};

const FACE = {
  RADIUS:  0.45,
  FORWARD: 0.38,
  UP:      0.05,
};

/* Bone hitbox radius — every bone is treated as a small sphere of this
   radius. With 48 bones on the SCP-096 rig, this fully envelops the body
   in any pose. Bump it up if you want a more forgiving hitbox. */
const BONE_HIT_RADIUS = 0.5;


export class SCP096AI {
  constructor({ model, gltf, scene, grid, W, H, CELL, originX, originZ,
                camera, player, sounds, eyeHeight = 2.4 }) {
    Object.assign(this, {
      model, gltf, scene, grid, W, H, CELL, originX, originZ,
      camera, player, sounds, eyeHeight,
    });

    /* ---- feet on the floor -------------------------------------- */
    model.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(model);
    const lift = -box.min.y;
    model.position.y += lift;
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    console.log(
      `[SCP-096 AI] lifted model by ${lift.toFixed(3)} ` +
      `→ world min.y = ${box.min.y.toFixed(3)} (should be ~0)`
    );

    /* ---- red point light ---------------------------------------- */
    this.redLight = new THREE.PointLight(0xff1a1a, 3.2, 14, 1.8);
    this.redLight.position.set(0, 1.6, 0);
    this.redLight.castShadow = false;
    model.add(this.redLight);

    /* ---- bones -------------------------------------------------- */
    this.headBone = null;
    this.eyeBone  = null;
    model.traverse(o => {
      if (!o.isBone) return;
      if (!this.headBone && /head/i.test(o.name)) this.headBone = o;
      if (!this.eyeBone  && /eye/i.test(o.name))  this.eyeBone  = o;
    });
    if (!this.headBone) {
      let topY = -Infinity;
      const wp = new THREE.Vector3();
      model.traverse(o => {
        if (o.isBone) {
          o.getWorldPosition(wp);
          if (wp.y > topY) { topY = wp.y; this.headBone = o; }
        }
      });
    }
    console.log('[SCP-096 AI] head bone:', this.headBone?.name || '(none)');
    console.log('[SCP-096 AI] eye  bone:', this.eyeBone?.name  || '(none — using model yaw)');
    /* index every bone — used by the bazooka projectile hit test */
    this.bones = [];
    model.traverse(o => { if (o.isBone) this.bones.push(o); });
    console.log(`[SCP-096 AI] indexed ${this.bones.length} bones for hitbox`);


    /* ---- FACE HITBOX — low-poly, solid, depthWrite off --------- */
    this.faceHitbox = new THREE.Mesh(
      new THREE.SphereGeometry(FACE.RADIUS, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0xff2b2b,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
        depthWrite: false,
      })
    );
    this.faceHitbox.visible = false;
    this.faceHitbox.renderOrder = 1000;
    scene.add(this.faceHitbox);

    /* ---- animations -------------------------------------------- */
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    this._finishCB = new Map();
    const byName = new Map(gltf.animations.map(c => [c.name, c]));
    for (const [key, name] of Object.entries(CLIP)) {
      const clip = byName.get(name);
      if (!clip) { console.warn('[SCP-096 AI] missing clip:', name); continue; }
      this.actions[key] = this.mixer.clipAction(clip);
    }
    this.mixer.addEventListener('finished', (e) => {
      const cb = this._finishCB.get(e.action);
      if (cb) { this._finishCB.delete(e.action); cb(); }
    });

    /* ---- sounds: anchor at head height -------------------------- */
    if (this.sounds) {
      this.soundAnchor = new THREE.Object3D();
      this.soundAnchor.position.set(0, 2.2, 0);
      model.add(this.soundAnchor);

      this.sounds.attach('calm',      this.soundAnchor);
      this.sounds.attach('faceSeen',  this.soundAnchor);
      this.sounds.attach('rage',      this.soundAnchor);
      this.sounds.attach('runScream', this.soundAnchor);
    }

    /* ---- state -------------------------------------------------- */
    this.state      = S.IDLE;
    this.stateTime  = 0;
    this.sitTimer   = 0;
    this.sitPhase   = 'sit';
    this.panicTimer = 0;
    this.inAttackRun = false;
    this.inReverseAttackRun = false;
    this.respawned  = false;
    this._attackAction = null;

    this.path = null;
    this.pathIdx = 0;
    this.repathTimer = 0;

    this.onKill = null;
    /* ---- stun (bazooka / tesla hit) ---------------------------- */
    this.stunned    = false;
    this.stunTimer  = 0;
    this.stunDuration = 0;

    /* ---- scratch ------------------------------------------------ */
    this._v1       = new THREE.Vector3();
    this._v2       = new THREE.Vector3();
    this._eye      = new THREE.Vector3();
    this._dir      = new THREE.Vector3();
    this._head     = new THREE.Vector3();
    this._eyePos   = new THREE.Vector3();
    this._facePos  = new THREE.Vector3();
    this._faceDir  = new THREE.Vector3(0, 0, 1);
    this._lo       = new THREE.Vector3();    
    this._hitVec   = new THREE.Vector3();

    this._updateFaceHitbox();
    this._enterIdle();
  }

  /* ============================================================== *
   *  FACE HITBOX
   * ============================================================== */
  _updateFaceHitbox() {
    if (!this.headBone) return;
    this.headBone.getWorldPosition(this._head);

    /* Derive forward from the rig itself: head → eyes, flattened to XZ.
       This is the face direction, by construction, on any export. */
    let fwdX, fwdZ;
    if (this.eyeBone) {
      this.eyeBone.getWorldPosition(this._eyePos);
      fwdX = this._eyePos.x - this._head.x;
      fwdZ = this._eyePos.z - this._head.z;
      const len = Math.hypot(fwdX, fwdZ);
      if (len < 1e-4) {
        fwdX = Math.sin(this.model.rotation.y);
        fwdZ = Math.cos(this.model.rotation.y);
      } else {
        fwdX /= len; fwdZ /= len;
      }
    } else {
      fwdX = Math.sin(this.model.rotation.y);
      fwdZ = Math.cos(this.model.rotation.y);
    }

    this._faceDir.set(fwdX, 0, fwdZ);

    this._facePos.set(
      this._head.x + fwdX * FACE.FORWARD,
      this._head.y + FACE.UP,
      this._head.z + fwdZ * FACE.FORWARD
    );
    this.faceHitbox.position.copy(this._facePos);
  }

  showFaceHitbox()   { this.faceHitbox.visible = true;  }
  hideFaceHitbox()   { this.faceHitbox.visible = false; }
  toggleFaceHitbox() {
    this.faceHitbox.visible = !this.faceHitbox.visible;
    return this.faceHitbox.visible;
  }

  /* ============================================================== *
   *  SOUND
   * ============================================================== */
  _sound(n, o) { if (this.sounds) this.sounds.play(n, o); }
  _sndStop(n)  { if (this.sounds) this.sounds.stop(n); }
  _sndStopAll(){ if (this.sounds) this.sounds.stopAll(); }

  /** Called by main.js when the SoundManager is fully ready. Re-fires the
   *  ambient loop for whatever state we're currently in. */
  refreshSoundState() {
    if (!this.sounds) return;
    if (this.state === S.IDLE) {
      this._sndStopAll();
      this._sound('calm');
    } else if (this.state === S.CHASE) {
      this._sound('hush');
      this._sound('runScream');
    }
  }


  /* ============================================================== *
   *  BONE-BASED HIT TESTING (used by the bazooka projectile)
   * ============================================================== */
  /** True if the world-space point (x, y, z) is within
   *  (BONE_HIT_RADIUS + extraRadius) of any bone. */
  hitTestPoint(x, y, z, extraRadius = 0) {
    if (!this.bones || !this.bones.length) return false;
    const r = BONE_HIT_RADIUS + extraRadius;
    const r2 = r * r;
    for (const b of this.bones) {
      b.getWorldPosition(this._hitVec);
      const dx = x - this._hitVec.x;
      const dy = y - this._hitVec.y;
      const dz = z - this._hitVec.z;
      if (dx * dx + dy * dy + dz * dz <= r2) return true;
    }
    return false;
  }

  /** Swept version — samples along the segment from p1 to p2 so fast
   *  projectiles can't skip past a bone between frames. */
  hitTestSegment(x1, y1, z1, x2, y2, z2, extraRadius = 0) {
    if (!this.bones || !this.bones.length) return false;

    /* Bone matrices may be a frame stale if this is called before the
       renderer runs; force them current. Cheap for 48 bones. */
    this.model.updateMatrixWorld(true);

    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz);
    const r = BONE_HIT_RADIUS + extraRadius;
    const steps = Math.max(2, Math.ceil(len / (r * 0.5)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      if (this.hitTestPoint(x1 + dx * t, y1 + dy * t, z1 + dz * t, extraRadius))
        return true;
    }
    return false;
  }


  /* ============================================================== *
   *  ANIMATION PRIMITIVES
   * ============================================================== */
  _stopOthers(keepKey, fade) {
    for (const [k, a] of Object.entries(this.actions)) {
      if (k === keepKey) continue;
      if (a.isRunning() || a.getEffectiveWeight() > 0.001) a.fadeOut(fade);
    }
  }

  _playLoop(name, fade = 0.25) {
    const a = this.actions[name]; if (!a) return null;
    this._stopOthers(name, fade);
    a.reset();
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = false;
    a.timeScale = 1; a.paused = false;
    a.fadeIn(fade).play();
    this._current = name;
    return a;
  }

  _playOnce(name, onFinish, fade = 0.15) {
    const a = this.actions[name]; if (!a) return null;
    this._stopOthers(name, fade);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = 1; a.paused = false;
    a.fadeIn(fade).play();
    if (onFinish) this._finishCB.set(a, onFinish);
    this._current = name;
    return a;
  }

  _playReverse(name, onFinish, fade = 0.15) {
    const a = this.actions[name]; if (!a) return null;
    this._stopOthers(name, fade);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = -1; a.paused = false;
    a.time = a.getClip().duration;
    a.fadeIn(fade).play();
    if (onFinish) this._finishCB.set(a, onFinish);
    this._current = name + '|reverse';
    return a;
  }

  /* ============================================================== *
   *  STUN — triggered by the bazooka projectile
   * ============================================================== */
  isStunned() { return this.stunned; }

  stun() {
    if (this.stunned) return false;

    /* Only CHASE is stunnable — sitting, raging, and the kill are immune. */
    if (this.state !== S.CHASE) {
      console.log(`[SCP-096 AI] stun rejected — state is ${this.state} (only CHASE)`);
      return false;
    }

    let action = this.actions.teslagatehit;
    if (!action) {
      const clips = this.gltf.animations || [];
      const found = clips.find(c => /tesla|gate|shock|stun|hit/i.test(c.name));
      if (found) {
        action = this.mixer.clipAction(found);
        this.actions.teslagatehit = action;
        console.warn(`[SCP-096 AI] teslagatehit not mapped — fallback: ${found.name}`);
      } else {
        console.warn('[SCP-096 AI] no stun-compatible clip found.');
        return false;
      }
    }

    this.stunned      = true;
    this.stunTimer    = 0;
    this.stunDuration = action.getClip().duration;

    this._sndStop('runScream');
    this._playOnce('teslagatehit', () => {
      this.stunned = false;
      this._resumeAfterStun();
    }, 0.08);

    this.stunTimer  = 0;
    this.stunDuration = action.getClip().duration;

    /* chase scream cuts out when he gets hit; ambient chase theme stays */
    this._sndStop('runScream');

    this._playOnce('teslagatehit', () => {
      this.stunned = false;
      this._resumeAfterStun();
    }, 0.08);

    console.log(`[SCP-096 AI] STUNNED for ${this.stunDuration.toFixed(2)}s`);
    return true;
  }

  _resumeAfterStun() {
    switch (this.state) {
      case S.IDLE:
        this._playLoop(this.sitPhase === 'sit2' ? 'sit2' : 'sit', 0.2);
        break;
      case S.PANIC:
        /* skip whatever intro we were mid-way through and just run the rage loop */
        this._playLoop('panic', 0.2);
        if (this.panicTimer <= 0) this.panicTimer = T.PANIC_DURATION;
        break;
      case S.CHASE:
        this._playLoop('running', 0.2);
        this._sound('runScream');
        break;
      case S.ATTACK:
        /* shouldn't happen — stun is ignored during ATTACK */
        break;
    }
  }

  /* ============================================================== *
   *  STATE TRANSITIONS
   * ============================================================== */
  _enterIdle() {
    this.state = S.IDLE;
    this.stateTime = 0;
    this.sitTimer = T.SIT_CYCLE;
    this.sitPhase = 'sit';
    this.inAttackRun = false;
    this.inReverseAttackRun = false;
    this.respawned = false;
    this._attackAction = null;
    this._playLoop('sit', 0.3);

    this._sndStopAll();
    this._sound('calm');
    console.log('[SCP-096 AI] → IDLE (sit)');
  }

  _triggerFaceSeen() {
    this._sndStop('calm');
    this._sound('faceSeen');
    this._sound('rage');
    this._enterPanic();
  }

  _enterPanic() {
    this.state = S.PANIC;
    this.stateTime = 0;
    this.panicTimer = 0;
    console.log('[SCP-096 AI] → PANIC (rage sound plays through)');
    this._playOnce('getup', () => {
      this._playOnce('panicstart1', () => {
        this._playLoop('panic', 0.2);
        this.panicTimer = T.PANIC_DURATION;
      }, 0.1);
    }, 0.1);
  }

  _enterChase() {
    this.state = S.CHASE;
    this.stateTime = 0;
    this.repathTimer = 0;
    this.inAttackRun = false;
    this.inReverseAttackRun = false;
    this._playLoop('running', 0.25);
    this._sound('hush');
    this._sound('runScream');
    console.log('[SCP-096 AI] → CHASE');
  }

  _enterAttack() {
    this.state = S.ATTACK;
    this.stateTime = 0;
    this.respawned = false;
    console.log('[SCP-096 AI] → ATTACK');

    this._sndStop('hush');
    this._sndStop('runScream');
    this._sndStop('rage');
    this._sound('kill');

    if (this.onKill) this.onKill('start');

    this._playOnce('attackjump', () => {
      this._attackAction = this._playOnce('attack', () => {
        if (this.onKill) this.onKill('done');
        this._enterIdle();
      }, 0.1);
    }, 0.1);
  }

  /* ============================================================== *
   *  PERCEPTION
   * ============================================================== */
  _rayHitsSphere(O, D, C, r) {
    const ox = O.x - C.x, oy = O.y - C.y, oz = O.z - C.z;
    const b = ox * D.x + oy * D.y + oz * D.z;
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - c;
    if (disc < 0) return false;
    return (-b + Math.sqrt(disc)) > 0;
  }

  _isPlayerLookingAtMe() {
    if (!this.headBone) return false;

    const eye = this._eye.set(this.player.pos.x, this.eyeHeight, this.player.pos.z);

    /* range gate (against the hitbox) */
    const dx = this._facePos.x - eye.x;
    const dy = this._facePos.y - eye.y;
    const dz = this._facePos.z - eye.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > T.LOOK_RANGE * T.LOOK_RANGE) return false;

    /* face-plane gate — using the ACTUAL face direction, not a guessed axis */
    const relX = eye.x - this._head.x;
    const relZ = eye.z - this._head.z;
    const forwardDot = this._faceDir.x * relX + this._faceDir.z * relZ;
    if (forwardDot <= 0) return false;

    /* view direction (unit) */
    const cp = Math.cos(this.player.pitch);
    const dir = this._dir.set(
      -Math.sin(this.player.yaw) * cp,
       Math.sin(this.player.pitch),
      -Math.cos(this.player.yaw) * cp
    );

    /* hard ray → hitbox intersection */
    if (!this._rayHitsSphere(eye, dir, this._facePos, FACE.RADIUS)) return false;

    /* and no wall between us */
    return this._lineOfSight(eye, this._facePos);
  }

  _lineOfSight(a, b) {
    const dist = a.distanceTo(b);
    const steps = Math.max(2, Math.ceil(dist / (this.CELL * 0.4)));
    const tmp = this._lo;
    for (let i = 1; i < steps; i++) {
      tmp.lerpVectors(a, b, i / steps);
      const gx = Math.floor((tmp.x - this.originX) / this.CELL);
      const gy = Math.floor((tmp.z - this.originZ) / this.CELL);
      if (gx < 0 || gy < 0 || gx >= this.W || gy >= this.H) return false;
      if (this.grid[gy * this.W + gx] === 1) return false;
    }
    return true;
  }

  /* ============================================================== *
   *  NAVIGATION
   * ============================================================== */
  _worldToCell(x, z) {
    return {
      gx: Math.max(0, Math.min(this.W - 1, Math.floor((x - this.originX) / this.CELL))),
      gy: Math.max(0, Math.min(this.H - 1, Math.floor((z - this.originZ) / this.CELL))),
    };
  }
  _cellCenter(gx, gy) {
    return {
      x: this.originX + gx * this.CELL + this.CELL / 2,
      z: this.originZ + gy * this.CELL + this.CELL / 2,
    };
  }

  _recomputePath(targetX, targetZ) {
    const start = this._worldToCell(this.model.position.x, this.model.position.z);
    const goal  = this._worldToCell(targetX, targetZ);
    const W = this.W, H = this.H;
    const sIdx = start.gy * W + start.gx;
    const gIdx = goal.gy  * W + goal.gx;
    if (sIdx === gIdx || this.grid[sIdx] === 1) { this.path = null; return; }

    const visited = new Int32Array(W * H).fill(-1);
    const prev    = new Int32Array(W * H).fill(-1);
    visited[sIdx] = 0;
    const q = [sIdx];
    let found = false;
    for (let head = 0; head < q.length; head++) {
      const c = q[head];
      if (c === gIdx) { found = true; break; }
      const cx = c % W, cy = (c / W) | 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (this.grid[n] === 1 || visited[n] !== -1) continue;
        visited[n] = visited[c] + 1;
        prev[n] = c;
        q.push(n);
      }
    }
    if (!found) { this.path = null; return; }
    const cells = [];
    let c = gIdx;
    while (c !== -1 && c !== sIdx) { cells.push(c); c = prev[c]; }
    cells.reverse();
    this.path = cells.map(idx => this._cellCenter(idx % W, (idx / W) | 0));
    this.pathIdx = 0;
  }

  _followPath(dt, speed) {
    if (!this.path || this.pathIdx >= this.path.length) return false;
    const target = this.path[this.pathIdx];
    const dx = target.x - this.model.position.x;
    const dz = target.z - this.model.position.z;
    const d = Math.hypot(dx, dz);
    if (d < T.PATH_NODE_REACH) { this.pathIdx++; return this.pathIdx < this.path.length; }
    const nx = dx / d, nz = dz / d;
    this.model.position.x += nx * speed * dt;
    this.model.position.z += nz * speed * dt;
    this._faceDirection(nx, nz, dt);
    return true;
  }

  _faceDirection(nx, nz, dt) {
    const targetYaw = Math.atan2(nx, nz);
    let dy = targetYaw - this.model.rotation.y;
    while (dy >  Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.model.rotation.y += dy * Math.min(1, T.TURN_SPEED * dt);
  }

  /* ============================================================== *
   *  UPDATE
   * ============================================================== */
  update(dt) {
    this.stateTime += dt;
    this.mixer.update(dt);
    this._updateFaceHitbox();

    /* while stunned: mixer keeps advancing (so teslagatehit animates),
       but no AI logic runs — no movement, no state transitions, no look checks */
    if (this.stunned) {
      this.stunTimer += dt;
      return;
    }

    switch (this.state) {
      case S.IDLE:   this._updateIdle(dt);   break;
      case S.PANIC:  this._updatePanic(dt);  break;
      case S.CHASE:  this._updateChase(dt);  break;
      case S.ATTACK: this._updateAttack(dt); break;
    }
  }

  _updateIdle(dt) {
    if (this._isPlayerLookingAtMe()) {
      console.log('[SCP-096 AI] player looked at my FACE → PANIC');
      this._triggerFaceSeen();
      return;
    }
    this.sitTimer -= dt;
    if (this.sitTimer <= 0) {
      if (this.sitPhase === 'sit') {
        this.sitPhase = 'sit2';
        this.sitTimer = T.SIT_CYCLE;
        this._playOnce('sit2start', () => {
          if (this.state === S.IDLE && this.sitPhase === 'sit2')
            this._playLoop('sit2', 0.2);
        }, 0.2);
      } else {
        this.sitPhase = 'sit';
        this.sitTimer = T.SIT_CYCLE;
        this._playLoop('sit', 0.3);
      }
    }
  }

  _updatePanic(dt) {
    if (this.panicTimer > 0) {
      this.panicTimer -= dt;
      if (this.panicTimer <= 0) this._enterChase();
    }
  }

  _updateChase(dt) {
    const px = this.player.pos.x, pz = this.player.pos.z;
    const dx = px - this.model.position.x;
    const dz = pz - this.model.position.z;
    const dist = Math.hypot(dx, dz);

    this.repathTimer -= dt;
    if (this.repathTimer <= 0) {
      this._recomputePath(px, pz);
      this.repathTimer = T.REPATH_INTERVAL;
    }

    const moved = this._followPath(dt, T.CHASE_SPEED);
    if (!moved && dist > 0.01) {
      const nx = dx / dist, nz = dz / dist;
      this.model.position.x += nx * T.CHASE_SPEED * dt;
      this.model.position.z += nz * T.CHASE_SPEED * dt;
      this._faceDirection(nx, nz, dt);
    }

    if (!this.inAttackRun && !this.inReverseAttackRun && dist < T.ATTACK_RANGE) {
      this.inAttackRun = true;
      this._playOnce('attackrunstart', () => {
        if (this.state === S.CHASE && this.inAttackRun)
          this._playLoop('attackrun', 0.15);
      }, 0.15);
    } else if (this.inAttackRun && dist > T.ATTACK_EXIT_RANGE) {
      this.inAttackRun = false;
      this.inReverseAttackRun = true;
      this._playReverse('attackrunstart', () => {
        this.inReverseAttackRun = false;
        if (this.state === S.CHASE && !this.inAttackRun)
          this._playLoop('running', 0.2);
      }, 0.15);
    }

    if (dist < T.KILL_RANGE) this._enterAttack();
  }

  _updateAttack(dt) {
    if (!this.respawned && this._attackAction) {
      if (this._attackAction.time >= T.RESPAWN_AT) {
        this.respawned = true;
        if (this.onKill) this.onKill('respawn');
      }
    }
  }
}
