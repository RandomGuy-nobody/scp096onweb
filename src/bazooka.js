import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const BAZOOKA_MODEL = '/models/bazooka.glb';

const FIRE_COOLDOWN    = 0.9;
const PROJECTILE_SPEED = 45;
const PROJECTILE_LIFE  = 3.5;
const PROJECTILE_R     = 0.18;

const DEBUG = false;

/* ------------------------------------------------------------------ *
 *  EXPLOSION
 * ------------------------------------------------------------------ */
class Explosion {
  constructor(scene, pos, big = false) {
    this.scene    = scene;
    this.age      = 0;
    this.duration = big ? 0.95 : 0.6;
    this.maxSize  = big ? 1.9 : 1.1;

    this.group = new THREE.Group();
    this.group.position.copy(pos);
    scene.add(this.group);

    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 10, 8),
      new THREE.MeshBasicMaterial({
        color: 0xfff0b0, transparent: true, opacity: 1,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    this.group.add(this.core);

    this.fireball = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 12, 10),
      new THREE.MeshBasicMaterial({
        color: 0xff7a1a, transparent: true, opacity: 0.85,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    this.group.add(this.fireball);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.16, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffaa44, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring);

    this.light = new THREE.PointLight(0xffaa44, big ? 26 : 14, 14, 2);
    this.light.position.y = 0.2;
    this.group.add(this.light);

    this.debris = [];
    const count = big ? 12 : 7;
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 0.07, 0.07),
        new THREE.MeshBasicMaterial({ color: 0x3a2418 })
      );
      const v = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() * 0.9 + 0.25,
        Math.random() - 0.5
      ).normalize().multiplyScalar(3.5 + Math.random() * 4.5);
      this.group.add(m);
      this.debris.push({ mesh: m, vel: v });
    }
  }

  update(dt) {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    if (t >= 1) return false;
    const ease = 1 - Math.pow(1 - t, 3);

    this.core.scale.setScalar(0.15 + ease * this.maxSize * 0.55);
    this.core.material.opacity = 1 - t * t;

    this.fireball.scale.setScalar(0.2 + ease * this.maxSize);
    this.fireball.material.opacity = 0.85 * (1 - t);

    this.ring.scale.setScalar(1 + ease * 3.5);
    this.ring.material.opacity = 0.9 * (1 - t) * (1 - t);

    const li = (1 - t) * (1 - t);
    this.light.intensity = li * (this.maxSize > 1.5 ? 26 : 14);

    for (const d of this.debris) {
      d.mesh.position.x += d.vel.x * dt;
      d.mesh.position.y += d.vel.y * dt;
      d.mesh.position.z += d.vel.z * dt;
      d.vel.y -= 14 * dt;
      d.mesh.rotation.x += dt * 12;
      d.mesh.rotation.y += dt * 9;
      d.mesh.scale.setScalar(Math.max(0.01, 1 - t));
    }
    return true;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

/* ------------------------------------------------------------------ *
 *  BAZOOKA
 * ------------------------------------------------------------------ */
export class Bazooka {
  /**
   * @param {object} opts
   * @param {THREE.Camera} opts.camera
   * @param {THREE.Scene}  opts.scene
   * @param {() => any}    opts.getSCP  — returns hitTest-capable SCP or null
   * @param {object}       opts.world   — LIVE reference; fields are filled in later
   *   { grid: Uint8Array|null, W, H, CELL, originX, originZ }
   */
  constructor({ camera, scene, getSCP, world }) {
    this.camera = camera;
    this.scene = scene;
    this.getSCP = getSCP;
    this.world = world;

    this.projectiles = [];
    this.explosions  = [];
    this.cooldown    = 0;
    this._firstPerson = true;
    this.viewModelPivot = null;

    this._loadViewModel();
  }

  async _loadViewModel() {
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(BAZOOKA_MODEL);
      const root = gltf.scene;

      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      root.scale.setScalar(0.55 / maxDim);
      root.updateMatrixWorld(true);

      const box2 = new THREE.Box3().setFromObject(root);
      const center = box2.getCenter(new THREE.Vector3());
      root.position.sub(center);
      root.updateMatrixWorld(true);

      root.traverse(o => {
        if (o.isMesh) {
          o.castShadow = false;
          o.receiveShadow = false;
          if (o.material) o.material.fog = false;
          o.renderOrder = 900;
        }
      });

      this.viewModelPivot = new THREE.Group();
      this.viewModelPivot.add(root);
      this.viewModelPivot.position.set(0.32, -0.30, -0.55);
      this.viewModelPivot.rotation.y = Math.PI;
      this.camera.add(this.viewModelPivot);
      console.log('[Bazooka] viewmodel loaded');
    } catch (err) {
      console.warn('[Bazooka] viewmodel failed to load:', err);
    }
  }

  setFirstPerson(fp) {
    this._firstPerson = fp;
    if (this.viewModelPivot) this.viewModelPivot.visible = fp;
  }

  fire() {
    if (this.cooldown > 0) return false;
    this.cooldown = FIRE_COOLDOWN;

    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);

    /* spawn very close to camera — the player's own collision radius (1u)
       guarantees no wall is within 0.3u of the camera, so the projectile
       always starts in free space */
    const origin = this.camera.position.clone()
      .add(dir.clone().multiplyScalar(0.3));

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(PROJECTILE_R, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb347 })
    );
    mesh.position.copy(origin);
    mesh.renderOrder = 800;
    this.scene.add(mesh);

    const light = new THREE.PointLight(0xff7a1a, 7, 11, 2);
    mesh.add(light);

    this.projectiles.push({
      mesh,
      vel: dir.clone().multiplyScalar(PROJECTILE_SPEED),
      life: PROJECTILE_LIFE,
    });

    if (this.viewModelPivot) this.viewModelPivot.position.z = -0.44;

    if (DEBUG) {
      console.log(
        `[Bazooka] fire @ (${origin.x.toFixed(2)}, ${origin.y.toFixed(2)}, ${origin.z.toFixed(2)})` +
        ` dir (${dir.x.toFixed(2)}, ${dir.y.toFixed(2)}, ${dir.z.toFixed(2)})`
      );
    }

    return true;
  }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;

    if (this.viewModelPivot) {
      const targetZ = -0.55;
      const cur = this.viewModelPivot.position.z;
      this.viewModelPivot.position.z = cur + (targetZ - cur) * Math.min(1, dt * 12);
    }

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      if (p.life <= 0) { this._explode(p.mesh.position, false); this._remove(i); continue; }

      const prevX = p.mesh.position.x;
      const prevY = p.mesh.position.y;
      const prevZ = p.mesh.position.z;

      const nx = prevX + p.vel.x * dt;
      const ny = prevY + p.vel.y * dt;
      const nz = prevZ + p.vel.z * dt;

      if (ny < 0.05) {
        p.mesh.position.set(nx, 0.06, nz);
        this._explode(p.mesh.position, false);
        this._remove(i);
        continue;
      }

      if (this._rayWall(prevX, prevZ, nx, nz)) {
        p.mesh.position.set(nx, ny, nz);
        this._explode(p.mesh.position, false);
        this._remove(i);
        continue;
      }

      p.mesh.position.set(nx, ny, nz);

      const scp = this.getSCP();
      if (scp && scp.hitTestSegment && !scp.isStunned?.()) {
        if (scp.hitTestSegment(prevX, prevY, prevZ, nx, ny, nz, PROJECTILE_R)) {
          const did = scp.stun?.() ?? false;
          if (DEBUG) console.log(`[Bazooka] SCP hit → stun() = ${did}`);
          this._explode(p.mesh.position, true);
          this._remove(i);
        }
      }
    }

    for (let i = this.explosions.length - 1; i >= 0; i--) {
      if (!this.explosions[i].update(dt)) {
        this.explosions[i].dispose();
        this.explosions.splice(i, 1);
      }
    }
  }

  _explode(worldPos, big) {
    this.explosions.push(new Explosion(this.scene, worldPos, big));
  }

  _rayWall(x1, z1, x2, z2) {
    const g = this.world;
    if (!g || !g.grid || !g.W || !g.H) return false;   // no world yet → no walls

    const dx = x2 - x1, dz = z2 - z1;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(dist / (g.CELL * 0.25)));

    /* If BOTH endpoints are inside the same wall cell, the projectile is
       already embedded — don't fire a hit, let it escape on the next tick. */
    const startGx = Math.floor((x1 - g.originX) / g.CELL);
    const startGy = Math.floor((z1 - g.originZ) / g.CELL);
    const startInWall =
      startGx >= 0 && startGy >= 0 && startGx < g.W && startGy < g.H &&
      g.grid[startGy * g.W + startGx] === 1;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = x1 + dx * t;
      const z = z1 + dz * t;
      const gx = Math.floor((x - g.originX) / g.CELL);
      const gy = Math.floor((z - g.originZ) / g.CELL);
      if (gx < 0 || gy < 0 || gx >= g.W || gy >= g.H) return true;
      if (g.grid[gy * g.W + gx] === 1) {
        if (startInWall && s === 1) continue;   // ignore first sample if embedded
        return true;
      }
    }
    return false;
  }

  _remove(index) {
    const p = this.projectiles[index];
    this.scene.remove(p.mesh);
    p.mesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.projectiles.splice(index, 1);
  }
}
