import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import { loadSCP096 }    from './scp096.js';
import { SCP096AI }      from './scp096ai.js';
import { SoundManager }  from './sounds.js';
import { Bazooka }       from './bazooka.js';
import { PlayerModel, makePreviewScene, framePreview } from './playermodel.js';

/* ================================================================== *
 *  CONFIG
 * ================================================================== */
const COLS = 16, ROWS = 16, CELL = 4, WALL_H = 4, SPAWN_CHAMBER = 7;

const PLAYER_RADIUS = 1.0;
const EYE_HEIGHT    = 2.4;
const WALK_SPEED    = 9;
const RUN_SPEED     = 20;
const DAMPING       = 14;
const LOOK_SENS     = 0.0022;

const SHADOW_LEVELS = [4096, 2048, 1024, 512];
const FPS_TARGET     = 50;
const FPS_BAD_SAMPLES = 2;

const FP_THRESHOLD = 0.12;
const TP_MIN = 2.5, TP_MAX = 30;

const SCP_CLEARANCE_RADIUS = 1;

/* ================================================================== *
 *  i18n
 * ================================================================== */
const STRINGS = {
  en: {
    title:        'Maze',
    subtitle:     'Select your survivor',
    card1Title:   'Teletubby',
    card1Sub:     'Suspiciously white',
    card2Title:   'Roblox Noob',
    card2Sub:     'Blocky & proud',
    play:         'PLAY',
    loading:      'Loading…',
    noModels:     'No models',
    dragRotate:   n => `Survivor ${n} — drag to rotate`,
    notLoaded:    n => `Model ${n} not loaded`,
    controls:     'WASD — move · Shift — run · Click — fire · Q — highlight · E — path · Ctrl — lock · P — post-fx · L — language',
    achUnlocked:  'Achievement unlocked',
    achName:      'Survivor',
    achDesc:      'Survived an active chase for 30 seconds',
    langLabel:    'PT',
  },
  pt: {
    title:        'Labirinto',
    subtitle:     'Escolha seu sobrevivente',
    card1Title:   'Teletubby',
    card1Sub:     'Suspeitamente branco',
    card2Title:   'Noob do Roblox',
    card2Sub:     'Noob',
    play:         'JOGAR',
    loading:      'Carregando…',
    noModels:     'Sem modelos',
    dragRotate:   n => `Sobrevivente ${n} — arraste para girar`,
    notLoaded:    n => `Modelo ${n} não carregado`,
    controls:     'WASD — mover · Shift — correr · Clique — atirar · Q — destacar · E — caminho · Ctrl — travar · P — pós-fx · L — idioma',
    achUnlocked:  'Conquista desbloqueada',
    achName:      'Sobrevivente',
    achDesc:      'Sobreviveu a uma perseguição ativa por 30 segundos',
    langLabel:    'EN',
  },
};

let lang = 'en';
try {
  const browser = (navigator.language || 'en').toLowerCase();
  if (browser.startsWith('pt')) lang = 'pt';
} catch (_) { /* keep default */ }
console.log(`[i18n] detected language: ${lang}`);

function t(key, ...args) {
  const entry = STRINGS[lang]?.[key];
  if (entry === undefined) return key;
  return typeof entry === 'function' ? entry(...args) : entry;
}

/* ================================================================== *
 *  MAZE
 * ================================================================== */
function generateMaze(cols, rows) {
  const W = cols * 2 + 1, H = rows * 2 + 1;
  const grid = new Uint8Array(W * H).fill(1);
  const idx = (x, y) => y * W + x;
  const stack = [[1, 1]];
  grid[idx(1, 1)] = 0;
  const dirs = [[0,-2],[0,2],[-2,0],[2,0]];
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const options = [];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx > 0 && nx < W - 1 && ny > 0 && ny < H - 1 && grid[idx(nx, ny)] === 1)
        options.push([nx, ny, dx, dy]);
    }
    if (!options.length) { stack.pop(); continue; }
    const [nx, ny, dx, dy] = options[(Math.random() * options.length) | 0];
    grid[idx(cx + dx / 2, cy + dy / 2)] = 0;
    grid[idx(nx, ny)] = 0;
    stack.push([nx, ny]);
  }
  const extras = Math.floor(cols * rows * 0.10);
  for (let i = 0; i < extras; i++) {
    const x = 1 + ((Math.random() * (W - 2)) | 0);
    const y = 1 + ((Math.random() * (H - 2)) | 0);
    if (grid[idx(x, y)] !== 1) continue;
    const openH = grid[idx(x - 1, y)] === 0 && grid[idx(x + 1, y)] === 0;
    const openV = grid[idx(x, y - 1)] === 0 && grid[idx(x, y + 1)] === 0;
    if (openH !== openV) grid[idx(x, y)] = 0;
  }
  return { grid, W, H };
}

function pickFarSpawnCell(grid, W, H, ax, ay, minDist) {
  const c = [];
  for (let gy = 1; gy < H - 1; gy++)
    for (let gx = 1; gx < W - 1; gx++) {
      if (grid[gy * W + gx] !== 0) continue;
      if (Math.hypot(gx - ax, gy - ay) < minDist) continue;
      c.push([gx, gy]);
    }
  if (!c.length) return { gx: W - 2, gy: H - 2 };
  const [gx, gy] = c[(Math.random() * c.length) | 0];
  return { gx, gy };
}

/* ================================================================== *
 *  BUILD MAZE
 * ================================================================== */
const { grid, W, H } = generateMaze(COLS, ROWS);

{
  const x0 = 1, y0 = 1, x1 = x0 + SPAWN_CHAMBER - 1, y1 = y0 + SPAWN_CHAMBER - 1;
  for (let gy = y0; gy <= y1; gy++)
    for (let gx = x0; gx <= x1; gx++) grid[gy * W + gx] = 0;
}
const SPAWN_GX = 1 + (SPAWN_CHAMBER - 1) / 2;
const SPAWN_GY = 1 + (SPAWN_CHAMBER - 1) / 2;

const scpSpawnCell = pickFarSpawnCell(grid, W, H, SPAWN_GX, SPAWN_GY, 12);
for (let dy = -SCP_CLEARANCE_RADIUS; dy <= SCP_CLEARANCE_RADIUS; dy++)
  for (let dx = -SCP_CLEARANCE_RADIUS; dx <= SCP_CLEARANCE_RADIUS; dx++) {
    const gx = scpSpawnCell.gx + dx, gy = scpSpawnCell.gy + dy;
    if (gx > 0 && gx < W - 1 && gy > 0 && gy < H - 1) grid[gy * W + gx] = 0;
  }

const originX = -(W * CELL) / 2;
const originZ = -(H * CELL) / 2;
const cellToWorldX = gx => originX + gx * CELL + CELL / 2;
const cellToWorldZ = gy => originZ + gy * CELL + CELL / 2;

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
 *  RENDERER
 * ================================================================== */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.getElementById('app').appendChild(renderer.domElement);

/* ================================================================== *
 *  SCENE / CAMERA
 * ================================================================== */
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x9fb8d4, 0.011);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 800);
camera.rotation.order = 'YXZ';
scene.add(camera);

/* ================================================================== *
 *  SKY
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
    vertexShader: /* glsl */`
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
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

/* ================================================================== *
 *  LIGHTS
 * ================================================================== */
scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x50493c, 0.85));

const sun = new THREE.DirectionalLight(0xffeed0, 3.0);
sun.castShadow = true;

const mazeExtent   = Math.max(W, H) * CELL;
const shadowExtent = mazeExtent * 0.62;
sun.shadow.camera.left   = -shadowExtent;
sun.shadow.camera.right  =  shadowExtent;
sun.shadow.camera.top    =  shadowExtent;
sun.shadow.camera.bottom = -shadowExtent;
sun.shadow.camera.near   = 1;
sun.shadow.camera.far    = 700;
sun.shadow.bias          = -0.0005;
sun.shadow.normalBias    = 0.03;
sun.shadow.radius        = 3.5;
sun.position.copy(sunDir).multiplyScalar(shadowExtent * 2.4);
sun.target.position.set(0, 0, 0);
scene.add(sun, sun.target);

const fill = new THREE.DirectionalLight(0xffd8a0, 0.35);
fill.position.copy(sunDir).multiplyScalar(-1);
scene.add(fill);

/* ================================================================== *
 *  ADAPTIVE SHADOWS
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
 *  WALLS
 * ================================================================== */
{
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
}

/* ================================================================== *
 *  FLOOR
 * ================================================================== */
{
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
  pos: new THREE.Vector3(cellToWorldX(SPAWN_GX), 0, cellToWorldZ(SPAWN_GY)),
  vel: new THREE.Vector3(),
  yaw: 0, pitch: 0,
};

/* ================================================================== *
 *  SOUND + BAZOOKA
 * ================================================================== */
const soundManager = new SoundManager(camera);
soundManager.loadAll('/sounds/');

const bazooka = new Bazooka({
  camera, scene,
  getSCP: () => scpAI,
  grid, W, H, CELL, originX, originZ,
});

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
  uniforms: {
    tDiffuse:         { value: null },
    vignetteStrength: { value: 1.05 },
  },
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
  zIndex: '50', textAlign: 'center',
  maxWidth: '520px',
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
 *  MENU DOM + PLAYER MODEL
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

let hasStarted  = false;
let manualLock  = false;
let menuState   = 'loading';   // 'loading' | 'no-models' | 'ready'

const preview = makePreviewScene(previewCanvas);
let selectedModelIdx = 1;
let loadedModels = {};
let previewClones = {};
let playerModel = null;

/* ================================================================== *
 *  LANGUAGE
 * ================================================================== */
function setMenuState(s) {
  menuState = s;
  if (s === 'loading') {
    playBtn.disabled = true;
    playBtn.textContent = t('loading');
  } else if (s === 'no-models') {
    playBtn.disabled = true;
    playBtn.textContent = t('noModels');
  } else {
    playBtn.disabled = false;
    playBtn.textContent = t('play');
  }
}

function applyLanguage() {
  document.documentElement.lang = lang;

  menuTitleEl.textContent = t('title');
  menuSubEl.textContent   = t('subtitle');
  menuKeysEl.textContent  = t('controls');

  document.querySelector('.card[data-model="1"] .card-title').textContent = t('card1Title');
  document.querySelector('.card[data-model="1"] .card-sub').textContent   = t('card1Sub');
  document.querySelector('.card[data-model="2"] .card-title').textContent = t('card2Title');
  document.querySelector('.card[data-model="2"] .card-sub').textContent   = t('card2Sub');

  langBtn.textContent = t('langLabel');

  /* play button follows menuState */
  setMenuState(menuState);

  /* preview hint reflects current selection */
  if (previewClones[selectedModelIdx]) {
    previewHint.textContent = t('dragRotate', selectedModelIdx);
  } else if (menuState === 'loading') {
    previewHint.textContent = t('loading');
  } else {
    previewHint.textContent = t('notLoaded', selectedModelIdx);
  }
}

function setLanguage(l) {
  lang = l;
  applyLanguage();
  console.log(`[i18n] language → ${l}`);
}

function toggleLanguage() {
  setLanguage(lang === 'en' ? 'pt' : 'en');
}

langBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleLanguage();
});

/* initial paint */
applyLanguage();

/* ================================================================== *
 *  PREVIEW + CARD SELECTION
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
  card.addEventListener('click', () => {
    selectModelCard(Number(card.dataset.model));
  });
});

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
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      previewClones[k] = previewClone;

      console.log(`[PlayerModel:${k}] loaded from ${path}`);
    } catch (err) {
      console.warn(`[PlayerModel:${k}] failed to load ${path}`, err);
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
 *  START GAME
 * ================================================================== */
function startGame() {
  if (!loadedModels[selectedModelIdx]) return;

  hasStarted = true;
  overlay.classList.add('hidden');

  preview.group.remove(previewClones[selectedModelIdx]);

  playerModel = new PlayerModel({
    scene,
    gltf: loadedModels[selectedModelIdx],
    name: `model${selectedModelIdx}`,
  });
  playerModel.setVisible(zoomT >= FP_THRESHOLD);
  playerModel.syncTransform(player.pos, player.yaw);

  playBtn.disabled = true;

  canvas.requestPointerLock();
  soundManager.resumeContext();
}

playBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  startGame();
});

/* ================================================================== *
 *  INPUT
 * ================================================================== */
const keys = Object.create(null);
const canvas = renderer.domElement;

let debugMode = false;

const DEBUG_STATES = ['IDLE', 'PANIC', 'CHASE', 'ATTACK'];

function toggleDebugMode() {
  debugMode = !debugMode;
  debugHudEl.style.display = debugMode ? 'block' : 'none';
  console.log(`[debug] ${debugMode ? 'ON' : 'OFF'}`);
}

function cycleDebugState() {
  if (!scpAI) return;

  /* clear any active stun so state switches take effect immediately */
  scpAI.stunned = false;
  scpAI.stunTimer = 0;

  const cur = DEBUG_STATES.indexOf(scpAI.state);
  const next = DEBUG_STATES[(cur + 1) % DEBUG_STATES.length];

  console.log(`[debug] SCP state: ${scpAI.state} → ${next}`);

  switch (next) {
    case 'IDLE':   scpAI._enterIdle();   break;
    case 'PANIC':  scpAI._enterPanic();  break;
    case 'CHASE':  scpAI._enterChase();  break;
    case 'ATTACK': scpAI._enterAttack(); break;
  }
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (!hasStarted) overlay.classList.toggle('hidden', !locked && false);
});

window.addEventListener('keydown', (e) => {
  /* language works even before starting */
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
      manualLock = false;
      document.exitPointerLock();
    } else {
      manualLock = true;
      canvas.requestPointerLock();
    }
    return;
  }
  if (e.code === 'ArrowUp')   { e.preventDefault(); if (!e.repeat) stepShadow(+1); return; }
  if (e.code === 'ArrowDown') { e.preventDefault(); if (!e.repeat) stepShadow(-1); return; }
  if (e.code === 'KeyQ')      { e.preventDefault(); if (!e.repeat) toggleHighlight(); return; }
  if (e.code === 'KeyE')      { e.preventDefault(); if (!e.repeat) togglePath(); return; }
  if (e.code === 'KeyP')      { e.preventDefault(); if (!e.repeat) window.__togglePostFX(); return; }
  if (e.code === 'KeyH') {
    e.preventDefault();
    if (!e.repeat && scpAI) scpAI.toggleFaceHitbox();
    return;
  }
  if (e.code === 'KeyB') {
    e.preventDefault();
    if (!e.repeat) toggleDebugMode();
    return;
  }
  if (e.code === 'KeyF') {
    e.preventDefault();
    if (!e.repeat && debugMode) cycleDebugState();
    return;
  }
  keys[e.code] = true;
  if (['ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
}, true);

window.addEventListener('keyup', (e) => { keys[e.code] = false; });

let rightDragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!hasStarted) return;
  if (e.button === 0 && !jumpscare.active) bazooka.fire();
  if (e.button === 2) { rightDragging = true; lastX = e.clientX; lastY = e.clientY; }
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
    manualLock = false;
    canvas.requestPointerLock();
  }
  if (wasFP && !isFP && !manualLock && document.pointerLockElement === canvas) {
    document.exitPointerLock();
  }
}, { passive: false });

/* ================================================================== *
 *  HIGHLIGHT MODE
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
  if (!scpAI) { console.info('[highlight] no SCP loaded'); return; }
  highlightActive = !highlightActive;
  if (!highlightMarker) {
    highlightMarker = makeHighlightMarker();
    scene.add(highlightMarker);
  }
  highlightMarker.visible = highlightActive;
}

/* ================================================================== *
 *  PATH VISUALIZER
 * ================================================================== */
let pathActive = false, pathMesh = null;

function computePathCells(sx, sy, gx, gy) {
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
  if (!pathActive || !pathMesh || !scpAI) {
    if (pathMesh) pathMesh.visible = false;
    return;
  }
  const sx = Math.max(0, Math.min(W - 1, Math.floor((player.pos.x - originX) / CELL)));
  const sy = Math.max(0, Math.min(H - 1, Math.floor((player.pos.z - originZ) / CELL)));
  const gx = Math.max(0, Math.min(W - 1, Math.floor((scpAI.model.position.x - originX) / CELL)));
  const gy = Math.max(0, Math.min(H - 1, Math.floor((scpAI.model.position.z - originZ) / CELL)));
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
 *  FPS / ADAPTIVE
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
 *  JUMPSCARE / RESPAWN
 * ================================================================== */
const jumpscare = { active: false };

function startJumpscare() {
  jumpscare.active = true;
  if (document.pointerLockElement) document.exitPointerLock();
  player.vel.set(0, 0, 0);
  for (const k of ['KeyW','KeyA','KeyS','KeyD']) keys[k] = false;
}
function endJumpscare() { jumpscare.active = false; }

function respawnPlayer() {
  player.pos.set(cellToWorldX(SPAWN_GX), 0, cellToWorldZ(SPAWN_GY));
  player.vel.set(0, 0, 0);
  player.yaw = 0; player.pitch = 0;
  endJumpscare();
  if (!survivorAchieved) { huntTime = 0; isHunted = false; }

  /* re-lock if the player was in first person */
  if (zoomT < FP_THRESHOLD && document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
  }
}

/* ================================================================== *
 *  SCP-096
 * ================================================================== */
let scpAI = null;
const scpSpawnPos = new THREE.Vector3(
  cellToWorldX(scpSpawnCell.gx), 0, cellToWorldZ(scpSpawnCell.gy)
);

soundManager.onReady = () => {
  if (scpAI && scpAI.refreshSoundState) scpAI.refreshSoundState();
};

loadSCP096(scene, scpSpawnPos).then((res) => {
  if (!res) return;
  scpAI = new SCP096AI({
    model: res.model, gltf: res.gltf, scene,
    grid, W, H, CELL, originX, originZ,
    camera, player,
    sounds: soundManager,
    eyeHeight: EYE_HEIGHT,
  });
  scpAI.onKill = (phase) => {
    if (phase === 'start')   startJumpscare();
    if (phase === 'respawn') respawnPlayer();
    if (phase === 'done')    endJumpscare();
  };
  window.__scpAI = scpAI;
  if (soundManager._readyFired) scpAI.refreshSoundState();
});

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
  if (jumpscare.active && scpAI && scpAI.headBone) {
    scpAI.headBone.getWorldPosition(_jsHead);
    const yaw = scpAI.model.rotation.y;
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

  if (scpAI) scpAI.update(dt);
  bazooka.update(dt);
  bazooka.setFirstPerson(zoomT < FP_THRESHOLD);

  if (playerModel) {
    const isFP = zoomT < FP_THRESHOLD;
    playerModel.setVisible(!isFP);
    playerModel.syncTransform(player.pos, player.yaw);

    const speed = Math.hypot(player.vel.x, player.vel.z);
    const running = !!(keys['ShiftLeft'] || keys['ShiftRight']);
    playerModel.setMotion(speed, running);
    playerModel.update(dt);
  }

  if (highlightActive && highlightMarker && scpAI) {
    highlightMarker.position.copy(scpAI.model.position);
    highlightMarker.position.y += 4.2;
  }

  if (pathActive) updatePathLine();

  if (scpAI) {
    const chasing = scpAI.state === 'CHASE' && !jumpscare.active;
    if (chasing) {
      if (!isHunted) { isHunted = true; huntTime = 0; }
      huntTime += dt;
      if (!survivorAchieved && huntTime >= 30) {
        survivorAchieved = true;
        showAchievement(t('achName'), t('achDesc'));
      }
    } else if (isHunted && scpAI.state !== 'PANIC') {
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
  if (scpAI) debugStateEl.textContent = scpAI.state;
  else       debugStateEl.textContent = '(not loaded)';
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
