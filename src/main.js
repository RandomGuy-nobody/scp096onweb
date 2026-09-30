import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import { loadSCP096 }       from './scp096.js';
import { SCP096Renderer }   from './scp096render.js';
import { SoundManager }     from './sounds.js';
import { Bazooka }          from './bazooka.js';
import { PlayerModel, makePreviewScene, framePreview } from './playermodel.js';
import { NetworkClient }    from './network.js';

/* ================================================================== *
 *  CONFIG
 * ================================================================== */
const CELL = 4, WALL_H = 4;
const PLAYER_RADIUS = 1.0;
const EYE_HEIGHT = 2.4;
const WALK_SPEED = 9, RUN_SPEED = 20;
const DAMPING = 14, LOOK_SENS = 0.0022;
const SHADOW_LEVELS = [4096, 2048, 1024, 512];
const FPS_TARGET = 50, FPS_BAD_SAMPLES = 2;
const FP_THRESHOLD = 0.12, TP_MIN = 2.5, TP_MAX = 30;

/* ================================================================== *
 *  i18n
 * ================================================================== */
const STRINGS = {
  en: {
    title: 'Maze',
    subtitle: 'Select your survivor',
    card1Title: 'Teletubby',
    card1Sub: 'Suspiciously white',
    card2Title: 'Roblox Noob',
    card2Sub: 'Stupid',
    play: 'PLAY',
    loading: 'Loading…',
    connecting: 'Connecting…',
    noModels: 'No models',
    usernamePlaceholder: 'Enter username',
    errUsername: 'Pick a username',
    errTaken: 'That username is taken',
    errConn: 'Connection failed',
    dragRotate: n => `Survivor ${n} — drag to rotate`,
    notLoaded: n => `Model ${n} not loaded`,
    controls: 'WASD — move · Shift — run · Click — fire · Q — highlight · E — path · Ctrl — lock · P — post-fx · L — language',
    achUnlocked: 'Achievement unlocked',
    achName: 'Survivor',
    achDesc: 'Survived an active chase for 30 seconds',
    langLabel: 'PT',
  },
  pt: {
    title: 'Labirinto',
    subtitle: 'Escolha seu sobrevivente',
    card1Title: 'Teletubby',
    card1Sub: 'Suspeitamente branco',
    card2Title: 'Noob do Roblox',
    card2Sub: 'Noob',
    play: 'JOGAR',
    loading: 'Carregando…',
    connecting: 'Conectando…',
    noModels: 'Sem modelos',
    usernamePlaceholder: 'Digite seu nome',
    errUsername: 'Escolha um nome',
    errTaken: 'Esse nome já está em uso',
    errConn: 'Falha na conexão',
    dragRotate: n => `Sobrevivente ${n} — arraste para girar`,
    notLoaded: n => `Modelo ${n} não carregado`,
    controls: 'WASD — mover · Shift — correr · Clique — atirar · Q — destacar · E — caminho · Ctrl — travar · P — pós-fx · L — idioma',
    achUnlocked: 'Conquista desbloqueada',
    achName: 'Sobrevivente',
    achDesc: 'Sobreviveu a uma perseguição ativa por 30 segundos',
    langLabel: 'EN',
  },
};

let lang = 'en';
try {
  const browser = (navigator.language || 'en').toLowerCase();
  if (browser.startsWith('pt')) lang = 'pt';
} catch (_) {}

function t(key, ...args) {
  const entry = STRINGS[lang]?.[key];
  if (entry === undefined) return key;
  return typeof entry === 'function' ? entry(...args) : entry;
}

/* ================================================================== *
 *  NETWORK
 * ================================================================== */
const net = new NetworkClient();

let maze = null;
let grid = null, W = 0, H = 0;
let originX = 0, originZ = 0;
let cellToWorldX = () => 0, cellToWorldZ = () => 0;
let SPAWN_GX = 0, SPAWN_GY = 0;
let spawnWorld = { x: 0, z: 0 };

/* ================================================================== *
 *  RENDERER / SCENE / CAMERA
 * ================================================================== */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x9fb8d4, 0.011);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 800);
camera.rotation.order = 'YXZ';
scene.add(camera);

/* ================================================================== *
 *  SKY / LIGHTS
 * ================================================================== */
const sunDir = new THREE.Vector3(0.55, 0.85, 0.35).normalize();

{
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor:     { value: new THREE.Color(0x2456b8) },
      horizonColor: { value: new THREE.Color(0xcfe1f5) },
      bottomColor:  { value: new THREE.Color(0x6d7d8f) },
      sunDir:       { value: sunDir.clone() },
      sunColor:     { value: new THREE.Color(0xfff2c0) },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 bottomColor;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float h = dir.y;
        vec3 col = (h > 0.0)
          ? mix(horizonColor, topColor, pow(h, 0.55))
          : mix(horizonColor, bottomColor, pow(-h, 0.5));
        float sd = max(0.0, dot(dir, sunDir));
        float disc = pow(sd, 1400.0) * 6.0;
        float glow = pow(sd, 14.0) * 0.55;
        col += sunColor * (disc + glow);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(600, 48, 28), skyMat));
}

scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x50493c, 0.85));

const sun = new THREE.DirectionalLight(0xffeed0, 3.0);
sun.castShadow = true;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 700;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 3.5;
sun.position.copy(sunDir).multiplyScalar(120);
sun.target.position.set(0, 0, 0);
scene.add(sun, sun.target);

const fill = new THREE.DirectionalLight(0xffd8a0, 0.35);
fill.position.copy(sunDir).multiplyScalar(-1);
scene.add(fill);

/* ================================================================== *
 *  SHADOW CONTROL
 * ================================================================== */
let shadowLevel = 0, manualShadow = false;
const shadowResEl = document.getElementById('shadowRes');

function applyShadowResolution(size) {
  sun.shadow.mapSize.set(size, size);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  if (shadowResEl) shadowResEl.textContent = `${size}²`;
}
applyShadowResolution(SHADOW_LEVELS[0]);

function stepShadow(dir) {
  const next = Math.max(0, Math.min(SHADOW_LEVELS.length - 1, shadowLevel + dir));
  if (next === shadowLevel) return;
  shadowLevel = next;
  manualShadow = true;
  applyShadowResolution(SHADOW_LEVELS[shadowLevel]);
}

/* ================================================================== *
 *  PROCEDURAL TEXTURES
 * ================================================================== */
function makeFloorTexture(size = 512) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#787f70';
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 34;
    img.data[i]   = Math.max(0, Math.min(255, img.data[i]   + n));
    img.data[i+1] = Math.max(0, Math.min(255, img.data[i+1] + n));
    img.data[i+2] = Math.max(0, Math.min(255, img.data[i+2] + n));
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    const p = i * (size / 8);
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {
    ctx.strokeStyle = `rgba(60, 55, 40, ${0.03 + Math.random() * 0.05})`;
    ctx.lineWidth = 1 + Math.random() * 3;
    const x = Math.random() * size, y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 200, y + (Math.random() - 0.5) * 200);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function makeWallBumpTexture(size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = 128 + (Math.random() - 0.5) * 60;
    img.data[i] = img.data[i+1] = img.data[i+2] = n;
    img.data[i+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/* ================================================================== *
 *  WORLD BUILD
 * ================================================================== */
let worldBuilt = false;

function buildWorld() {
  if (worldBuilt) return;
  worldBuilt = true;

  W = maze.W; H = maze.H;
  grid = new Uint8Array(maze.grid);
  SPAWN_GX = maze.SPAWN_GX;
  SPAWN_GY = maze.SPAWN_GY;

  /* hand the world to the bazooka so wall detection works */
  bazookaWorld.grid = grid;
  bazookaWorld.W = W;
  bazookaWorld.H = H;

  originX = -(W * CELL) / 2;
  originZ = -(H * CELL) / 2;
  cellToWorldX = gx => originX + gx * CELL + CELL / 2;
  cellToWorldZ = gy => originZ + gy * CELL + CELL / 2;
  spawnWorld = { x: cellToWorldX(SPAWN_GX), z: cellToWorldZ(SPAWN_GY) };

  bazookaWorld.originX = originX;
  bazookaWorld.originZ = originZ;

  const mazeExtent = Math.max(W, H) * CELL;
  const shadowExtent = mazeExtent * 0.62;
  sun.shadow.camera.left   = -shadowExtent;
  sun.shadow.camera.right  =  shadowExtent;
  sun.shadow.camera.top    =  shadowExtent;
  sun.shadow.camera.bottom = -shadowExtent;
  sun.shadow.camera.updateProjectionMatrix();
  sun.position.copy(sunDir).multiplyScalar(shadowExtent * 2.4);

  const wallCells = [];
  for (let gy = 0; gy < H; gy++)
    for (let gx = 0; gx < W; gx++)
      if (grid[gy * W + gx] === 1) wallCells.push([gx, gy]);

  const bump = makeWallBumpTexture(256);
  bump.repeat.set(3, 3);
  const wallGeo = new THREE.BoxGeometry(CELL, WALL_H, CELL);
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xd6cfbf, roughness: 0.94, metalness: 0.02,
    bumpMap: bump, bumpScale: 0.06,
  });
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, wallCells.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  wallCells.forEach(([gx, gy], i) => {
    m.makeTranslation(cellToWorldX(gx), WALL_H / 2, cellToWorldZ(gy));
    walls.setMatrixAt(i, m);
    const v = 0.90 + Math.random() * 0.10;
    col.setRGB(v, v * 0.995, v * 0.965);
    walls.setColorAt(i, col);
  });
  walls.instanceMatrix.needsUpdate = true;
  if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
  walls.castShadow = true;
  walls.receiveShadow = true;
  scene.add(walls);

  const floorTex = makeFloorTexture(512);
  floorTex.repeat.set(W * 0.25, H * 0.25);
  const floorGeo = new THREE.PlaneGeometry(W * CELL, H * CELL);
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex, color: 0x909888, roughness: 1.0, metalness: 0.0,
  });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
}

/* ================================================================== *
 *  PLAYER STATE
 * ================================================================== */
const player = {
  pos: new THREE.Vector3(0, 0, 0),
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0,
};

/* ================================================================== *
 *  POSTPROCESSING
 * ================================================================== */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.55, 0.85
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, vignetteStrength: { value: 1.05 } },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float vignetteStrength;
    varying vec2 vUv;
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
      vec3 shadows    = vec3(0.90, 0.95, 1.08);
      vec3 highlights = vec3(1.06, 1.00, 0.90);
      vec3 tint = mix(shadows, highlights, smoothstep(0.2, 0.8, lum));
      col.rgb *= tint;
      col.rgb = (col.rgb - 0.5) * 1.10 + 0.5;
      float l2 = dot(col.rgb, vec3(0.299, 0.587, 0.114));
      col.rgb = mix(vec3(l2), col.rgb, 1.15);
      vec2 d = vUv - 0.5;
      col.rgb *= 1.0 - dot(d, d) * vignetteStrength;
      gl_FragColor = col;
    }`,
};
composer.addPass(new ShaderPass(GradeShader));

let postFX = true;
window.__togglePostFX = () => { postFX = !postFX; };

/* ================================================================== *
 *  ACHIEVEMENT TOAST
 * ================================================================== */
const achievementEl = document.createElement('div');
Object.assign(achievementEl.style, {
  position: 'fixed', top: '80px', left: '50%',
  transform: 'translateX(-50%) translateY(-20px)',
  padding: '14px 26px', borderRadius: '10px',
  background: 'linear-gradient(135deg, rgba(255,205,80,.18), rgba(255,140,40,.18))',
  border: '1px solid rgba(255,205,80,.55)',
  color: '#ffe6a7',
  font: '600 14px ui-monospace, monospace',
  letterSpacing: '.12em', textTransform: 'uppercase',
  boxShadow: '0 10px 30px rgba(0,0,0,.5), 0 0 40px rgba(255,180,60,.25)',
  backdropFilter: 'blur(8px)',
  pointerEvents: 'none',
  opacity: '0', transition: 'opacity .4s ease, transform .4s ease',
  zIndex: '50', textAlign: 'center', maxWidth: '520px',
});
document.body.appendChild(achievementEl);

let achievementTimer = null;
function showAchievement(title, desc) {
  achievementEl.innerHTML =
    `<div style="font-size:11px;opacity:.7">${t('achUnlocked')}</div>` +
    `<div style="margin-top:4px">${title}</div>` +
    `<div style="font-size:11px;font-weight:400;opacity:.75;margin-top:4px">${desc}</div>`;
  achievementEl.style.opacity = '1';
  achievementEl.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(achievementTimer);
  achievementTimer = setTimeout(() => {
    achievementEl.style.opacity = '0';
    achievementEl.style.transform = 'translateX(-50%) translateY(-20px)';
  }, 4200);
}

let huntTime = 0, isHunted = false, survivorAchieved = false;

/* ================================================================== *
 *  MENU DOM
 * ================================================================== */
const overlay       = document.getElementById('overlay');
const playBtn       = document.getElementById('play-btn');
const langBtn       = document.getElementById('lang-btn');
const previewCanvas = document.getElementById('preview-canvas');
const previewHint   = document.getElementById('preview-hint');
const menuTitleEl   = document.getElementById('menu-title');
const menuSubEl     = document.getElementById('menu-subtitle');
const menuKeysEl    = document.getElementById('menu-keys');
const debugHudEl    = document.getElementById('debug-hud');
const debugStateEl  = document.getElementById('debug-state');
const debugCountEl  = document.getElementById('debug-count');
const usernameInput = document.getElementById('username');
const errorMsgEl    = document.getElementById('error-msg');

let hasStarted = false;
let manualLock = false;
let menuState = 'loading';
let netReady  = false;

const preview = makePreviewScene(previewCanvas);
let selectedModelIdx = 1;
let loadedModels = {};
let previewClones = {};
let playerModel = null;

/* ================================================================== *
 *  i18n APPLICATION
 * ================================================================== */
function setMenuState(s) {
  menuState = s;
  const canPlay = (s === 'ready' || s === 'connecting') && netReady;
  playBtn.disabled = !canPlay;
  if (s === 'loading')         playBtn.textContent = t('loading');
  else if (s === 'no-models')  playBtn.textContent = t('noModels');
  else if (s === 'connecting') playBtn.textContent = t('connecting');
  else                         playBtn.textContent = t('play');
}

function applyLanguage() {
  document.documentElement.lang = lang;
  menuTitleEl.textContent = t('title');
  menuSubEl.textContent   = t('subtitle');
  menuKeysEl.textContent  = t('controls');
  usernameInput.placeholder = t('usernamePlaceholder');

  document.querySelector('.card[data-model="1"] .card-title').textContent = t('card1Title');
  document.querySelector('.card[data-model="1"] .card-sub').textContent   = t('card1Sub');
  document.querySelector('.card[data-model="2"] .card-title').textContent = t('card2Title');
  document.querySelector('.card[data-model="2"] .card-sub').textContent   = t('card2Sub');

  langBtn.textContent = t('langLabel');
  setMenuState(menuState);

  if (previewClones[selectedModelIdx]) {
    previewHint.textContent = t('dragRotate', selectedModelIdx);
  } else if (menuState === 'loading') {
    previewHint.textContent = t('loading');
  } else {
    previewHint.textContent = t('notLoaded', selectedModelIdx);
  }
}

function setLanguage(l) { lang = l; applyLanguage(); }
function toggleLanguage() { setLanguage(lang === 'en' ? 'pt' : 'en'); }
langBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLanguage(); });
applyLanguage();

/* ================================================================== *
 *  PREVIEW
 * ================================================================== */
function selectModelCard(n) {
  selectedModelIdx = n;
  document.querySelectorAll('.card').forEach(c => {
    c.classList.toggle('selected', Number(c.dataset.model) === n);
  });
  preview.group.clear();
  const clone = previewClones[n];
  if (clone) {
    preview.group.add(clone);
    clone.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(clone);
    clone.position.y -= box.min.y;
    clone.updateMatrixWorld(true);
    const box2 = new THREE.Box3().setFromObject(clone);
    const center = box2.getCenter(new THREE.Vector3());
    clone.position.x -= center.x;
    clone.position.z -= center.z;
    framePreview(preview.group, preview.cam, previewCanvas);
    previewHint.textContent = t('dragRotate', n);
    previewHint.style.display = 'block';
  } else {
    previewHint.textContent = t('notLoaded', n);
  }
}

{
  let dragging = false, lastX = 0;
  previewCanvas.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    preview.group.rotation.y += (e.clientX - lastX) * 0.01;
    lastX = e.clientX;
  });
}

document.querySelectorAll('.card').forEach(card => {
  card.addEventListener('click', () => selectModelCard(Number(card.dataset.model)));
});

/* ================================================================== *
 *  MODEL LOADING
 * ================================================================== */
async function loadPlayerModels() {
  const loader = new GLTFLoader();
  const paths = {
    1: '/models/playermodel1.glb',
    2: '/models/playermodel2.glb',
  };
  for (const [k, path] of Object.entries(paths)) {
    try {
      const gltf = await loader.loadAsync(path);
      loadedModels[k] = gltf;
      const previewClone = cloneSkinned(gltf.scene);
      previewClone.traverse(o => {
        if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      previewClones[k] = previewClone;
    } catch (err) {
      console.warn(`[PlayerModel:${k}] failed`, err);
    }
  }
  if (loadedModels[1])      selectedModelIdx = 1;
  else if (loadedModels[2]) selectedModelIdx = 2;

  if (loadedModels[selectedModelIdx]) {
    selectModelCard(selectedModelIdx);
    setMenuState('ready');
  } else {
    setMenuState('no-models');
  }
}
loadPlayerModels();

function resizePreview() {
  const rect = previewCanvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  preview.renderer.setSize(rect.width, rect.height, false);
  preview.cam.aspect = rect.width / rect.height;
  preview.cam.updateProjectionMatrix();
}
window.addEventListener('resize', resizePreview);
setTimeout(resizePreview, 0);

/* ================================================================== *
 *  NETWORK CONNECT
 * ================================================================== */
async function connectToServer() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}`;
  console.log(`[net] connecting to ${url}`);
  try {
    await net.connect(url);
    netReady = true;
    setMenuState(menuState === 'loading' ? 'ready' : menuState);
    console.log('[net] ready');
  } catch (err) {
    console.error('[net] failed', err);
    errorMsgEl.textContent = t('errConn');
  }
}
connectToServer();

/* ================================================================== *
 *  PLAYER MODEL INSTANCES
 * ================================================================== */
function spawnLocalPlayerModel() {
  if (playerModel) return;
  playerModel = new PlayerModel({
    scene,
    gltf: loadedModels[selectedModelIdx],
    name: `model${selectedModelIdx}`,
  });
  playerModel.setVisible(zoomT >= FP_THRESHOLD);
  playerModel.syncTransform(player.pos, player.yaw);
}

/** Remote players: id -> { model, sprite, smoothing } */
const remotePlayers = new Map();

function spawnRemotePlayer(remote) {
  if (remote.id === net.id) return;
  if (remotePlayers.has(remote.id)) return;
  const gltf = loadedModels[remote.model] || loadedModels[1];
  if (!gltf) return;

  const pm = new PlayerModel({
    scene,
    gltf,
    name: `remote${remote.id}`,
  });
  pm.setVisible(true);
  pm.syncTransform(new THREE.Vector3(remote.x, 0, remote.z), remote.yaw);

  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, 512, 128);
  ctx.font = 'bold 56px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffe6a7';
  ctx.fillText(remote.username.slice(0, 20), 256, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
  }));
  sprite.scale.set(3, 0.75, 1);
  sprite.renderOrder = 999;
  scene.add(sprite);

  remotePlayers.set(remote.id, {
    model: pm,
    sprite,
    _smoothedX: remote.x,
    _smoothedZ: remote.z,
  });
}

function despawnRemotePlayer(id) {
  const r = remotePlayers.get(id);
  if (!r) return;
  scene.remove(r.model.model);
  scene.remove(r.sprite);
  if (r.sprite.material.map) r.sprite.material.map.dispose();
  r.sprite.material.dispose();
  remotePlayers.delete(id);
}

/* ================================================================== *
 *  PLAY
 * ================================================================== */
function startGame() {
  const username = usernameInput.value.trim().slice(0, 20);
  if (!username) { errorMsgEl.textContent = t('errUsername'); return; }
  if (!net.isConnected()) { errorMsgEl.textContent = t('errConn'); return; }
  errorMsgEl.textContent = '';
  net.sendJoin(username, selectedModelIdx);
  setMenuState('connecting');
}

playBtn.addEventListener('click', (e) => { e.stopPropagation(); startGame(); });
usernameInput.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') startGame();
  e.stopPropagation();
});

/* ================================================================== *
 *  NETWORK EVENTS
 * ================================================================== */
net.on('error', (msg) => {
  console.warn('[net] error:', msg.msg);
  errorMsgEl.textContent = msg.msg === 'Username already taken' ? t('errTaken') : msg.msg;
  setMenuState('ready');
});

net.on('welcome', (msg) => {
  maze = msg.maze;
  buildWorld();

  player.pos.set(msg.spawn.x, 0, msg.spawn.z);
  player.vel.set(0, 0, 0);
  player.yaw = 0; player.pitch = 0;

  hasStarted = true;
  overlay.classList.add('hidden');
  playBtn.disabled = true;

  spawnLocalPlayerModel();
  for (const p of msg.players) spawnRemotePlayer(p);

  /* Only load SCP once. If a previous SCP exists (reconnect, hot reload),
     strip it from the scene before adding a new one. */
  if (scpRenderer) {
    console.warn('[SCP] renderer already exists — removing old model');
    scene.remove(scpRenderer.model);
    scpRenderer.model.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    scpRenderer = null;
  }

  loadSCP096(scene, new THREE.Vector3(0, 0, 0)).then((res) => {
    if (!res) return;
    if (scpRenderer) {
      /* race guard: another welcome slipped in while we were loading */
      scene.remove(res.model);
      return;
    }
    scpRenderer = new SCP096Renderer({
      model: res.model,
      gltf: res.gltf,
      scene,
      sounds: soundManager,
    });
    if (net.scpPos)   scpRenderer.setPosition(net.scpPos);
    if (net.scpState) scpRenderer.setState(net.scpState.state, net.scpState.substate);
    console.log('[SCP render] ready — applied state:', net.scpState);
  });

  canvas.requestPointerLock();
  soundManager.resumeContext();
  console.log(`[game] joined as "${msg.username}" (#${msg.id})`);
});

net.on('player_joined', (p) => {
  console.log(`[game] ${p.username} joined`);
  spawnRemotePlayer(p);
});

net.on('player_left', (id) => {
  despawnRemotePlayer(id);
  console.log(`[game] remote player left`);
});

net.on('scp_state', (s) => {
  if (scpRenderer) scpRenderer.setState(s.state, s.substate);

  /* jumpscare: server says we're the target of an ATTACK */
  if (s.state === 'ATTACK' && s.targetId === net.id && !jumpscare.active) {
    startJumpscare();
  }
});

net.on('killed', (msg) => {
  player.pos.set(msg.x, 0, msg.z);
  player.vel.set(0, 0, 0);
  endJumpscare();
  if (!survivorAchieved) { huntTime = 0; isHunted = false; }
  /* don't auto-lock — browsers require a user gesture. player clicks to re-lock */
  console.log('[game] killed — respawned (click to re-lock mouse)');
});

net.on('scp_event', (msg) => {
  if (msg.event === 'chase_start' && msg.targetId === net.id) {
    isHunted = true; huntTime = 0;
  }
  if (msg.event === 'threat_added' && msg.playerId === net.id) {
    console.log('[game] you got added to SCP threat list');
  }
});

/* ================================================================== *
 *  SOUND MANAGER + BAZOOKA
 * ================================================================== */
const soundManager = new SoundManager(camera);
soundManager.loadAll('/sounds/');

let scpRenderer = null;

const bazookaWorld = { grid: null, W: 0, H: 0, CELL, originX: 0, originZ: 0 };
const bazooka = new Bazooka({
  camera, scene,
  getSCP: () => scpRenderer,          // ← live reference to the renderer
  world: bazookaWorld,
});
bazooka.onScpHit = () => {
  if (net.isConnected()) net.ws.send(JSON.stringify({ type: 'stun_scp' }));
};

/* ================================================================== *
 *  INPUT
 * ================================================================== */
const keys = Object.create(null);
const canvas = renderer.domElement;

let debugMode = false;

function toggleDebugMode() {
  debugMode = !debugMode;
  debugHudEl.style.display = debugMode ? 'block' : 'none';
}
function cycleDebugState() {
  if (!net.scpState) return;
  console.log(`[debug] server-side state is "${net.scpState.state}". Cycle is client-only.`);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyL') {
    e.preventDefault();
    if (!e.repeat) toggleLanguage();
    return;
  }
  if (!hasStarted) return;

  if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
    e.preventDefault();
    if (e.repeat) return;
    if (document.pointerLockElement === canvas) {
      manualLock = false; document.exitPointerLock();
    } else {
      manualLock = true; canvas.requestPointerLock();
    }
    return;
  }
  if (e.code === 'ArrowUp')   { e.preventDefault(); if (!e.repeat) stepShadow(+1); return; }
  if (e.code === 'ArrowDown') { e.preventDefault(); if (!e.repeat) stepShadow(-1); return; }
  if (e.code === 'KeyQ')      { e.preventDefault(); if (!e.repeat) toggleHighlight(); return; }
  if (e.code === 'KeyE')      { e.preventDefault(); if (!e.repeat) togglePath(); return; }
  if (e.code === 'KeyP')      { e.preventDefault(); if (!e.repeat) window.__togglePostFX(); return; }
  if (e.code === 'KeyB')      { e.preventDefault(); if (!e.repeat) toggleDebugMode(); return; }
  if (e.code === 'KeyF')      { e.preventDefault(); if (!e.repeat && debugMode) cycleDebugState(); return; }

  keys[e.code] = true;
  if (['ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
}, true);

window.addEventListener('keyup', (e) => { keys[e.code] = false; });

let rightDragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!hasStarted) return;
  if (e.button === 0) {
    if (document.pointerLockElement !== canvas) {
      /* re-acquire lock — first click after respawn/escape just grabs the mouse */
      canvas.requestPointerLock();
      return;
    }
    if (!jumpscare.active) bazooka.fire();
  }
  if (e.button === 2) { rightDragging = true; lastX = e.clientX; lastY = e.clientY; }
});  loadSCP096(scene, new THREE.Vector3(0, 0, 0)).then((res) => {
    if (!res) return;
    scpRenderer = new SCP096Renderer({
      model: res.model,
      gltf: res.gltf,
      scene,
      sounds: soundManager,
    });
    /* use the LATEST state, not the stale welcome snapshot —
       the server may have transitioned to PANIC while the model was loading */
    if (net.scpPos)   scpRenderer.setPosition(net.scpPos);
    if (net.scpState) scpRenderer.setState(net.scpState.state, net.scpState.substate);
    console.log('[SCP render] applied latest state:', net.scpState);
  });
window.addEventListener('mouseup', (e) => { if (e.button === 2) rightDragging = false; });

function clampPitch() {
  const lim = Math.PI / 2 - 0.02;
  player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
}

window.addEventListener('mousemove', (e) => {
  if (!hasStarted) return;
  if (jumpscare.active) { lastX = e.clientX; lastY = e.clientY; return; }
  const locked = document.pointerLockElement === canvas;
  let dx, dy;
  if (locked) { dx = e.movementX; dy = e.movementY; }
  else        { dx = e.clientX - lastX; dy = e.clientY - lastY; }
  lastX = e.clientX; lastY = e.clientY;
  if (locked || rightDragging) {
    player.yaw   -= dx * LOOK_SENS;
    player.pitch -= dy * LOOK_SENS;
    clampPitch();
  }
});

let zoomT = 0;
window.addEventListener('wheel', (e) => {
  if (!hasStarted) return;
  e.preventDefault();
  const wasFP = zoomT < FP_THRESHOLD;
  zoomT = Math.max(0, Math.min(1, zoomT + e.deltaY * 0.0012));
  const isFP = zoomT < FP_THRESHOLD;
  if (!wasFP && isFP && document.pointerLockElement !== canvas) {
    manualLock = false; canvas.requestPointerLock();
  }
  if (wasFP && !isFP && !manualLock && document.pointerLockElement === canvas) {
    document.exitPointerLock();
  }
}, { passive: false });

/* ================================================================== *
 *  HIGHLIGHT / PATH
 * ================================================================== */
let highlightActive = false, highlightMarker = null;
function makeHighlightMarker() {
  const group = new THREE.Group();
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xff2b2b, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false })
  );
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xff5566, depthTest: false })
  );
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 40, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xff3b3b, transparent: true, opacity: 0.25,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    })
  );
  beam.position.y = -20;
  glow.renderOrder = 998; core.renderOrder = 999; beam.renderOrder = 997;
  group.add(glow, core, beam);
  return group;
}
function toggleHighlight() {
  if (!scpRenderer) return;
  highlightActive = !highlightActive;
  if (!highlightMarker) {
    highlightMarker = makeHighlightMarker();
    scene.add(highlightMarker);
  }
  highlightMarker.visible = highlightActive;
}

let pathActive = false, pathMesh = null;
function computePathCells(sx, sy, gx, gy) {
  if (!grid) return null;
  const sIdx = sy * W + sx, gIdx = gy * W + gx;
  if (sIdx === gIdx || grid[sIdx] === 1 || grid[gIdx] === 1) return null;
  const visited = new Int32Array(W * H).fill(-1);
  const prev    = new Int32Array(W * H).fill(-1);
  visited[sIdx] = 0;
  const q = [sIdx];
  let found = false;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (c === gIdx) { found = true; break; }
    const cx = c % W, cy = (c / W) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (grid[n] === 1 || visited[n] !== -1) continue;
      visited[n] = visited[c] + 1;
      prev[n] = c;
      q.push(n);
    }
  }
  if (!found) return null;
  const cells = [];
  let c = gIdx;
  while (c !== -1 && c !== sIdx) { cells.push(c); c = prev[c]; }
  cells.push(sIdx); cells.reverse();
  return cells.map(i => ({ gx: i % W, gy: (i / W) | 0 }));
}
function togglePath() {
  if (!pathActive && !pathMesh) {
    pathMesh = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x00ffcc, depthTest: false, transparent: true, opacity: 0.95 })
    );
    pathMesh.renderOrder = 997;
    pathMesh.frustumCulled = false;
    scene.add(pathMesh);
  }
  pathActive = !pathActive;
  pathMesh.visible = pathActive;
}
let _lastPathKey = '';
function updatePathLine() {
  if (!pathActive || !pathMesh || !scpRenderer || !grid) {
    if (pathMesh) pathMesh.visible = false;
    return;
  }
  const sx = Math.max(0, Math.min(W - 1, Math.floor((player.pos.x - originX) / CELL)));
  const sy = Math.max(0, Math.min(H - 1, Math.floor((player.pos.z - originZ) / CELL)));
  const gx = Math.max(0, Math.min(W - 1, Math.floor((scpRenderer.model.position.x - originX) / CELL)));
  const gy = Math.max(0, Math.min(H - 1, Math.floor((scpRenderer.model.position.z - originZ) / CELL)));
  const key = `${sx},${sy}->${gx},${gy}`;
  if (key === _lastPathKey) { pathMesh.visible = true; return; }
  _lastPathKey = key;
  const cells = computePathCells(sx, sy, gx, gy);
  if (!cells) { pathMesh.visible = false; return; }
  const pts = cells.map(({ gx, gy }) => new THREE.Vector3(
    originX + gx * CELL + CELL / 2, 0.15, originZ + gy * CELL + CELL / 2
  ));
  pathMesh.geometry.dispose();
  pathMesh.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  pathMesh.visible = true;
}

/* ================================================================== *
 *  COLLISION
 * ================================================================== */
function collides(x, z, r) {
  if (!grid) return false;
  const gx0 = Math.floor((x - r - originX) / CELL);
  const gx1 = Math.floor((x + r - originX) / CELL);
  const gy0 = Math.floor((z - r - originZ) / CELL);
  const gy1 = Math.floor((z + r - originZ) / CELL);
  for (let gy = gy0; gy <= gy1; gy++)
    for (let gx = gx0; gx <= gx1; gx++) {
      if (gx < 0 || gy < 0 || gx >= W || gy >= H) return true;
      if (grid[gy * W + gx] === 1) return true;
    }
  return false;
}

/* ================================================================== *
 *  FPS
 * ================================================================== */
const fpsEl = document.getElementById('fps');
let frames = 0, fpsWindowStart = performance.now(), badSamples = 0;
function evaluateFps(now) {
  const elapsed = now - fpsWindowStart;
  if (elapsed < 1000) return;
  const fps = (frames * 1000) / elapsed;
  frames = 0; fpsWindowStart = now;
  if (fpsEl) fpsEl.textContent = fps.toFixed(0);
  if (manualShadow) return;
  if (fps < FPS_TARGET) {
    badSamples++;
    if (badSamples >= FPS_BAD_SAMPLES && shadowLevel < SHADOW_LEVELS.length - 1) {
      shadowLevel++;
      applyShadowResolution(SHADOW_LEVELS[shadowLevel]);
      badSamples = 0;
    }
  } else badSamples = 0;
}

/* ================================================================== *
 *  JUMPSCARE
 * ================================================================== */
const jumpscare = { active: false };
function startJumpscare() {
  jumpscare.active = true;
  if (document.pointerLockElement) document.exitPointerLock();
  player.vel.set(0, 0, 0);
  for (const k of ['KeyW','KeyA','KeyS','KeyD']) keys[k] = false;
}
function endJumpscare() { jumpscare.active = false; }

/* ================================================================== *
 *  STATE UPLOAD
 * ================================================================== */
let lastUpload = 0;
function uploadState(dt) {
  if (!hasStarted || !net.isConnected()) return;
  lastUpload += dt;
  if (lastUpload < 0.05) return;
  lastUpload = 0;
  const vel = Math.hypot(player.vel.x, player.vel.z);
  const running = !!(keys['ShiftLeft'] || keys['ShiftRight']);
  net.sendState(player.pos.x, player.pos.z, player.yaw, player.pitch, vel, running);
}

/* ================================================================== *
 *  GAME LOOP
 * ================================================================== */
let bobPhase = 0;
const clock = new THREE.Clock();
const tmpForward = new THREE.Vector3();
const tmpRight   = new THREE.Vector3();
const wish       = new THREE.Vector3();
const _jsHead    = new THREE.Vector3();
const _lookAt    = new THREE.Vector3();

function updateCamera(dt) {
  if (jumpscare.active && scpRenderer) {
    scpRenderer.model.getWorldPosition(_jsHead);
    _jsHead.y += 1.6;
    const yaw = scpRenderer.model.rotation.y;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const camX = _jsHead.x + fx * 1.55;
    const camY = _jsHead.y + 0.18;
    const camZ = _jsHead.z + fz * 1.55;
    const t = performance.now() * 0.02;
    camera.position.set(
      camX + Math.sin(t * 1.7) * 0.035,
      camY + Math.cos(t * 2.3) * 0.035,
      camZ + Math.sin(t * 1.9) * 0.035
    );
    camera.lookAt(_jsHead.x, _jsHead.y + 0.05, _jsHead.z);
    return;
  }

  const yaw = player.yaw, pitch = player.pitch;
  const px = player.pos.x, pz = player.pos.z;
  const planarSpeed = Math.hypot(player.vel.x, player.vel.z);
  bobPhase += planarSpeed * dt * 1.4;
  const bob = Math.sin(bobPhase) * Math.min(planarSpeed / WALK_SPEED, 1) * 0.055;

  if (zoomT < FP_THRESHOLD) {
    camera.position.set(px, EYE_HEIGHT + bob, pz);
    camera.rotation.set(pitch, yaw, 0);
    return;
  }

  const t = (zoomT - FP_THRESHOLD) / (1 - FP_THRESHOLD);
  const d = TP_MIN + t * (TP_MAX - TP_MIN);
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  camera.position.set(
    px - fx * cp * d,
    EYE_HEIGHT + (-sp) * d,
    pz - fz * cp * d
  );
  _lookAt.set(px, EYE_HEIGHT + bob, pz);
  camera.lookAt(_lookAt);
}

function update(dt) {
  if (jumpscare.active || !hasStarted) {
    player.vel.multiplyScalar(Math.exp(-DAMPING * dt));
  } else {
    tmpForward.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    tmpRight  .set( Math.cos(player.yaw), 0, -Math.sin(player.yaw));
    wish.set(0, 0, 0);
    if (keys['KeyW']) wish.add(tmpForward);
    if (keys['KeyS']) wish.sub(tmpForward);
    if (keys['KeyD']) wish.add(tmpRight);
    if (keys['KeyA']) wish.sub(tmpRight);
    const running = keys['ShiftLeft'] || keys['ShiftRight'];
    const speed = running ? RUN_SPEED : WALK_SPEED;
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    const k = 1 - Math.exp(-DAMPING * dt);
    player.vel.x += (wish.x - player.vel.x) * k;
    player.vel.z += (wish.z - player.vel.z) * k;
  }

  const nx = player.pos.x + player.vel.x * dt;
  if (!collides(nx, player.pos.z, PLAYER_RADIUS)) player.pos.x = nx; else player.vel.x = 0;
  const nz = player.pos.z + player.vel.z * dt;
  if (!collides(player.pos.x, nz, PLAYER_RADIUS)) player.pos.z = nz; else player.vel.z = 0;

  uploadState(dt);
  bazooka.update(dt);
  bazooka.setFirstPerson(zoomT < FP_THRESHOLD);

  if (playerModel && hasStarted) {
    const isFP = zoomT < FP_THRESHOLD;
    playerModel.setVisible(!isFP);
    playerModel.syncTransform(player.pos, player.yaw);
    const speed = Math.hypot(player.vel.x, player.vel.z);
    const running = !!(keys['ShiftLeft'] || keys['ShiftRight']);
    playerModel.setMotion(speed, running);
    playerModel.update(dt);
  }

  for (const [id, r] of remotePlayers) {
    const remote = net.players.get(id);
    if (!remote) continue;

    const t = Math.min(1, dt * 12);
    r._smoothedX += (remote.x - r._smoothedX) * t;
    r._smoothedZ += (remote.z - r._smoothedZ) * t;

    r.model.syncTransform(new THREE.Vector3(r._smoothedX, 0, r._smoothedZ), remote.yaw);

    const speed = remote.vel || 0;
    const running = !!remote.running;
    r.model.setMotion(speed, running);
    r.model.update(dt);

    r.sprite.position.set(r._smoothedX, 3.1, r._smoothedZ);
  }

  /* SCP render from server */
  if (scpRenderer && net.scpPos) {
    scpRenderer.setPosition(net.scpPos);
    scpRenderer.update(dt);
  }

  if (highlightActive && highlightMarker && scpRenderer) {
    highlightMarker.position.copy(scpRenderer.model.position);
    highlightMarker.position.y += 4.2;
  }

  if (pathActive) updatePathLine();

  /* achievement */
  if (net.scpState) {
    const chasingMe = net.scpState.state === 'CHASE' && net.scpState.targetId === net.id && !jumpscare.active;
    if (chasingMe) {
      if (!isHunted) { isHunted = true; huntTime = 0; }
      huntTime += dt;
      if (!survivorAchieved && huntTime >= 30) {
        survivorAchieved = true;
        showAchievement(t('achName'), t('achDesc'));
      }
    } else if (isHunted && net.scpState.state !== 'PANIC') {
      isHunted = false; huntTime = 0;
    }
  }

  updateCamera(dt);
}

function updatePreview(dt) {
  if (hasStarted) return;
  preview.group.rotation.y += dt * 0.25;
  preview.renderer.render(preview.scene, preview.cam);
}

function updateDebugHud() {
  if (!debugMode) return;
  if (net.scpState) {
    debugStateEl.textContent = net.scpState.state + (net.scpState.substate ? `/${net.scpState.substate}` : '');
    debugCountEl.textContent = remotePlayers.size + (hasStarted ? 1 : 0);
  } else {
    debugStateEl.textContent = '--';
    debugCountEl.textContent = '0';
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  update(dt);
  updatePreview(dt);
  updateDebugHud();

  if (postFX && hasStarted) composer.render();
  else                      renderer.render(scene, camera);

  frames++;
  evaluateFps(performance.now());
}
animate();

/* ================================================================== *
 *  RESIZE
 * ================================================================== */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.setSize(window.innerWidth, window.innerHeight);
  resizePreview();
});
