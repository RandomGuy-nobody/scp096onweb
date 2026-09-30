import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Loads /models/scp-096.glb, adds it to the scene, and dumps a big
 * diagnostic report to the console. No AI, no animation playback — 
 * just enough to verify the asset loads and inspect its clips.
 *
 * @param {THREE.Scene} scene
 * @param {THREE.Vector3} [position]
 * @returns {Promise<{gltf: any, model: THREE.Object3D} | null>}
 */
export async function loadSCP096(scene, position = new THREE.Vector3()) {
  const loader = new GLTFLoader();
  const url = '/models/scp-096.glb';

  console.log(
    '%c[SCP-096] Loading ' + url + ' ...',
    'color:#ff8a5c;font-weight:bold;font-size:12px'
  );

  const t0 = performance.now();
  let gltf;
  try {
    gltf = await loader.loadAsync(url);
  } catch (err) {
    console.error('[SCP-096] Load failed:', err);
    console.error(
      '[SCP-096] Check that models/scp-096.glb actually exists and is a valid .glb.'
    );
    return null;
  }
  const loadMs = performance.now() - t0;

  console.log(
    `%c[SCP-096] Loaded in ${loadMs.toFixed(1)} ms`,
    'color:#7fff7f;font-weight:bold'
  );

  const model = gltf.scene;
  model.name = model.name || 'SCP-096';
  model.position.copy(position);

  // Enable shadows on any mesh that has them
  model.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { m.side = THREE.FrontSide; });
      }
    }
  });

  scene.add(model);

  dumpModelReport(gltf, loadMs);

  return { gltf, model };
}

/* ------------------------------------------------------------------ */
/*  Console diagnostics                                                */
/* ------------------------------------------------------------------ */
function dumpModelReport(gltf, loadMs) {
  const root = gltf.scene;

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const min = box.min, max = box.max;

  // ---- geometry / material tally -----------------------------------
  let meshCount = 0, skinnedCount = 0, boneCount = 0;
  let vertCount = 0, triCount = 0;
  const materials = new Set();
  const textures = new Set();

  root.traverse((o) => {
    if (o.isBone) boneCount++;
    if (o.isSkinnedMesh) skinnedCount++;
    if (o.isMesh) {
      meshCount++;
      const pos = o.geometry?.attributes?.position;
      if (pos) vertCount += pos.count;
      if (o.geometry?.index) triCount += o.geometry.index.count / 3;
      else if (pos) triCount += pos.count / 3;

      const mats = o.material
        ? (Array.isArray(o.material) ? o.material : [o.material])
        : [];
      mats.forEach((m) => {
        materials.add(m);
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
                          'emissiveMap', 'aoMap', 'alphaMap']) {
          if (m[k]) textures.add(m[k]);
        }
      });
    }
  });

  console.group(
    `%c[SCP-096] MODEL REPORT  (load ${loadMs.toFixed(1)} ms)`,
    'color:#ffaa55;font-weight:bold;font-size:13px'
  );
  console.log('Root name            :', root.name || '(unnamed)');
  console.log('Root children        :', root.children.length);
  console.log('Meshes               :', meshCount);
  console.log('Skinned meshes       :', skinnedCount);
  console.log('Bones                :', boneCount);
  console.log('Materials (unique)   :', materials.size);
  console.log('Textures (unique)    :', textures.size);
  console.log('Vertices             :', vertCount.toLocaleString());
  console.log('Triangles            :', Math.round(triCount).toLocaleString());

  console.group('Bounding box (world units)');
  console.log('size   (w, h, d)     :',
    size.x.toFixed(3), size.y.toFixed(3), size.z.toFixed(3));
  console.log('center (x, y, z)     :',
    center.x.toFixed(3), center.y.toFixed(3), center.z.toFixed(3));
  console.log('min    (x, y, z)     :',
    min.x.toFixed(3), min.y.toFixed(3), min.z.toFixed(3));
  console.log('max    (x, y, z)     :',
    max.x.toFixed(3), max.y.toFixed(3), max.z.toFixed(3));
  console.groupEnd();

  // Material list (handy for spotting missing textures / KHR extensions)
  if (materials.size) {
    console.group('Materials');
    [...materials].forEach((m, i) => {
      console.log(
        `${i}: "${m.name || '(unnamed)'}"`,
        '| type:', m.type,
        '| transparent:', m.transparent,
        '| opacity:', m.opacity,
        '| side:', m.side
      );
    });
    console.groupEnd();
  }

  console.groupEnd(); // end MODEL REPORT

  // ---- animations --------------------------------------------------
  const clips = gltf.animations ?? [];
  console.group(
    `%c[SCP-096] ANIMATIONS (${clips.length})`,
    'color:#55aaff;font-weight:bold;font-size:13px'
  );

  if (!clips.length) {
    console.warn('No animation clips found in this model.');
    console.groupEnd();
    return;
  }

  // Summary table
  const rows = clips.map((clip, i) => {
    let keyframes = 0;
    const kinds = { position: 0, quaternion: 0, scale: 0, morph: 0, other: 0 };
    for (const t of clip.tracks) {
      keyframes += t.times.length;
      if (t.name.endsWith('.position'))            kinds.position++;
      else if (t.name.endsWith('.quaternion'))     kinds.quaternion++;
      else if (t.name.endsWith('.scale'))          kinds.scale++;
      else if (t.name.includes('.morphTargetInfluences')) kinds.morph++;
      else                                          kinds.other++;
    }
    const fps = clip.duration > 0 ? (keyframes / clip.duration) : 0;
    return {
      '#': i,
      name: clip.name || '(unnamed)',
      'duration (s)': +clip.duration.toFixed(3),
      tracks: clip.tracks.length,
      keyframes,
      'avg fps': +fps.toFixed(1),
      'pos/q/s/m': `${kinds.position}/${kinds.quaternion}/${kinds.scale}/${kinds.morph}`,
      blend: clip.blendMode,
    };
  });
  console.table(rows);

  // Per-clip detail
  clips.forEach((clip, i) => {
    console.group(
      `%cClip ${i}: "${clip.name || '(unnamed)'}"`,
      'color:#aaddff;font-weight:bold'
    );
    console.log('duration        :', clip.duration.toFixed(4), 's');
    console.log('tracks          :', clip.tracks.length);
    console.log('blend mode      :', clip.blendMode);
    console.log('uuid            :', clip.uuid);

    // Longest / shortest track by last keyframe time
    let lastT = 0, firstT = Infinity;
    for (const t of clip.tracks) {
      if (!t.times.length) continue;
      lastT  = Math.max(lastT,  t.times[t.times.length - 1]);
      firstT = Math.min(firstT, t.times[0]);
    }
    console.log('first keyframe  :', isFinite(firstT) ? firstT.toFixed(4) + ' s' : '—');
    console.log('last keyframe   :', lastT.toFixed(4), 's');

    // Sample of track names
    const sample = clip.tracks.slice(0, 12);
    console.log(`track names (${sample.length} of ${clip.tracks.length}):`);
    sample.forEach((t) => {
      console.log(
        `   • ${t.name}  —  ${t.times.length} keys, ` +
        `vals/keys=${(t.values.length / Math.max(1, t.times.length)).toFixed(1)}`
      );
    });
    if (clip.tracks.length > sample.length) {
      console.log(`   … +${clip.tracks.length - sample.length} more`);
    }
    console.groupEnd();
  });

  console.groupEnd(); // end ANIMATIONS
}

/**
 * Convenience: creates an AnimationMixer ready to play a clip by name.
 * NOT called automatically — here so you can experiment from the console:
 *
 *   const { gltf, model } = await __scp096;
 *   const mixer = window.__makeMixer(gltf, model);
 *   mixer.clipAction(gltf.animations[0]).play();
 *   window.__scp096Mixer = mixer;
 */
export function makeMixer(gltf, model) {
  return new THREE.AnimationMixer(model);
}
