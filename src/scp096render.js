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

/* Which clips loop vs play-once */
const LOOPING = new Set(['sit', 'sit2', 'panic', 'running', 'attackrun', 'teslagatehit']);

export class SCP096Renderer {
  constructor({ model, gltf, scene }) {
    this.model = model;
    this.gltf = gltf;

    /* feet on floor */
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    model.position.y = -box.min.y;
    model.updateMatrixWorld(true);

    /* red point light */
    this.redLight = new THREE.PointLight(0xff1a1a, 3.2, 14, 1.8);
    this.redLight.position.set(0, 1.6, 0);
    model.add(this.redLight);

    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    const byName = new Map(gltf.animations.map(c => [c.name, c]));
    for (const [key, name] of Object.entries(CLIP)) {
      const clip = byName.get(name);
      if (!clip) { console.warn('[SCP] missing clip:', name); continue; }
      this.actions[key] = this.mixer.clipAction(clip);
    }

    this.currentAnim = null;
    this._targetPos = new THREE.Vector3();
    this._targetYaw = 0;
    this._posInit = false;
  }

  /** Called every frame with the server-authoritative SCP state. */
  applyServerState(scp) {
    if (!scp) return;

    this._targetPos.set(scp.x, 0, scp.z);
    this._targetYaw = scp.yaw;

    if (!this._posInit) {
      this.model.position.x = scp.x;
      this.model.position.z = scp.z;
      this.model.rotation.y = scp.yaw;
      this._posInit = true;
    }

    if (scp.currentAnim !== this.currentAnim) {
      this._play(scp.currentAnim);
      this.currentAnim = scp.currentAnim;
    }
  }

  _play(name) {
    const action = this.actions[name];
    if (!action) return;

    for (const [k, a] of Object.entries(this.actions)) {
      if (k === name) continue;
      if (a.isRunning() || a.getEffectiveWeight() > 0.001) a.fadeOut(0.2);
    }

    action.reset();
    if (LOOPING.has(name)) action.setLoop(THREE.LoopRepeat, Infinity);
    else                    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.timeScale = 1;
    action.paused = false;
    action.fadeIn(0.2).play();
  }

  update(dt) {
    this.mixer.update(dt);

    const t = Math.min(1, dt * 15);
    this.model.position.x += (this._targetPos.x - this.model.position.x) * t;
    this.model.position.z += (this._targetPos.z - this.model.position.z) * t;

    let dy = this._targetYaw - this.model.rotation.y;
    while (dy >  Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.model.rotation.y += dy * t;
  }
}
