import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/* If the model looks backwards in-game, set this to 0. If it looks
   sideways, try Math.PI/2 or -Math.PI/2. */
const MODEL_YAW_OFFSET = Math.PI;

const WALK_TIME_SCALE_DEFAULT = 1.0;
const RUN_TIME_SCALE_SPEDWALK = 1.65;

export class PlayerModel {
  constructor({ scene, gltf, name }) {
    this.scene = scene;
    this.gltf = gltf;
    this.name = name;

    /* IMPORTANT: clone the gltf scene so each PlayerModel instance owns
       its own rig. Without this, every player shares the same Object3D
       reference — syncTransform() from different players would fight
       over the same transform and only one would win per frame. */
    this.model = cloneSkinned(gltf.scene);
    this.model.visible = false;

    /* ---- feet on the floor ------------------------------------- */
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model);
    this.model.position.y = -box.min.y;
    this.model.updateMatrixWorld(true);

    /* ---- shadows ----------------------------------------------- */
    this.model.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });

    scene.add(this.model);

    /* ---- animations -------------------------------------------- */
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};

    const clips = gltf.animations || [];

    console.group(`[PlayerModel:${name}] ${clips.length} animation clips`);
    clips.forEach((c, i) => {
      console.log(`  ${i}: "${c.name}" — ${c.duration.toFixed(3)}s`);
    });
    console.groupEnd();

    const walkClip = clips.find(c => /walk/i.test(c.name));
    const runClip  = clips.find(c => /run/i.test(c.name) && c !== walkClip);

    this.walkAction = walkClip ? this.mixer.clipAction(walkClip) : null;
    this.runAction  = runClip  ? this.mixer.clipAction(runClip)  : null;

    if (this.walkAction) this.walkAction.setLoop(THREE.LoopRepeat, Infinity);
    if (this.runAction)  this.runAction.setLoop(THREE.LoopRepeat, Infinity);

    this.runIsSpedWalk = !!this.walkAction && !this.runAction;

    if (this.walkAction) {
      console.log(`[PlayerModel:${name}] walk clip → "${walkClip.name}"`);
    } else {
      console.warn(`[PlayerModel:${name}] no "walk" clip found`);
    }

    if (this.runAction) {
      console.log(`[PlayerModel:${name}] run clip  → "${runClip.name}"`);
    } else if (this.runIsSpedWalk) {
      console.log(`[PlayerModel:${name}] no distinct "run" clip — will speed up walk ×${RUN_TIME_SCALE_SPEDWALK}`);
    }

    if (!this.walkAction && !this.runAction) {
      console.warn(`[PlayerModel:${name}] no walk/run clips — model will be static.`);
    }

    this.currentAction = null;
  }

  setVisible(v) {
    this.model.visible = !!v;
  }

  syncTransform(pos, yaw) {
    this.model.position.x = pos.x;
    this.model.position.z = pos.z;
    this.model.rotation.y = yaw + MODEL_YAW_OFFSET;
  }

  setMotion(speed, running) {
    const moving = speed > 0.6;

    if (!moving) {
      if (this.currentAction) {
        this.currentAction.fadeOut(0.15);
        this.currentAction = null;
      }
      return;
    }

    const target = (running && this.runAction) ? this.runAction : this.walkAction;
    if (!target) return;

    if (target !== this.currentAction) {
      if (this.currentAction) this.currentAction.fadeOut(0.15);
      this.currentAction = target;
      target.reset().fadeIn(0.15).play();
    }

    let scale;
    if (running) {
      scale = this.runAction ? 1.0 : RUN_TIME_SCALE_SPEDWALK;
    } else {
      scale = WALK_TIME_SCALE_DEFAULT;
    }
    target.setEffectiveTimeScale(scale);
  }

  update(dt) {
    this.mixer.update(dt);
  }
}

/* ------------------------------------------------------------------ *
 *  Helpers for the menu preview
 * ------------------------------------------------------------------ */
export function makePreviewScene(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

  scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x2a2030, 1.0));

  const key = new THREE.DirectionalLight(0xfff0d0, 2.6);
  key.position.set(3, 5, 4);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x88bbff, 1.4);
  rim.position.set(-3, 2.5, -3);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xffaa88, 0.6);
  fill.position.set(0, -2, 2);
  scene.add(fill);

  const group = new THREE.Group();
  scene.add(group);

  return { renderer, scene, cam, group };
}

export function framePreview(group, cam, canvas) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(2, rect.width), h = Math.max(2, rect.height);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
  cam.position.set(0, 1.0, 3.4);
  cam.lookAt(0, 1.0, 0);
}
