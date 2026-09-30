import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

/* ================================================================== *
 *  STATIC
 * ================================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb':  'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(serveStatic);

/* ================================================================== *
 *  MAZE
 * ================================================================== */
const COLS = 16, ROWS = 16, CELL = 4, SPAWN_CHAMBER = 7;
const SCP_CLEARANCE_RADIUS = 1;

function pickFarSpawn(grid, W, H, ax, ay, minDist) {
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

function generateMaze() {
  const W = COLS * 2 + 1, H = ROWS * 2 + 1;
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
  const extras = Math.floor(COLS * ROWS * 0.10);
  for (let i = 0; i < extras; i++) {
    const x = 1 + ((Math.random() * (W - 2)) | 0);
    const y = 1 + ((Math.random() * (H - 2)) | 0);
    if (grid[idx(x, y)] !== 1) continue;
    const openH = grid[idx(x - 1, y)] === 0 && grid[idx(x + 1, y)] === 0;
    const openV = grid[idx(x, y - 1)] === 0 && grid[idx(x, y + 1)] === 0;
    if (openH !== openV) grid[idx(x, y)] = 0;
  }
  {
    const x0 = 1, y0 = 1, x1 = x0 + SPAWN_CHAMBER - 1, y1 = y0 + SPAWN_CHAMBER - 1;
    for (let gy = y0; gy <= y1; gy++)
      for (let gx = x0; gx <= x1; gx++) grid[idx(gx, gy)] = 0;
  }
  const SPAWN_GX = 1 + (SPAWN_CHAMBER - 1) / 2;
  const SPAWN_GY = 1 + (SPAWN_CHAMBER - 1) / 2;

  const scpCell = pickFarSpawn(grid, W, H, SPAWN_GX, SPAWN_GY, 12);
  for (let dy = -SCP_CLEARANCE_RADIUS; dy <= SCP_CLEARANCE_RADIUS; dy++)
    for (let dx = -SCP_CLEARANCE_RADIUS; dx <= SCP_CLEARANCE_RADIUS; dx++) {
      const gx = scpCell.gx + dx, gy = scpCell.gy + dy;
      if (gx > 0 && gx < W - 1 && gy > 0 && gy < H - 1) grid[idx(gx, gy)] = 0;
    }

  return { grid: Array.from(grid), W, H, SPAWN_GX, SPAWN_GY, scpCell };
}

const maze = generateMaze();
const originX = -(maze.W * CELL) / 2;
const originZ = -(maze.H * CELL) / 2;
const cellToWorldX = gx => originX + gx * CELL + CELL / 2;
const cellToWorldZ = gy => originZ + gy * CELL + CELL / 2;

console.log(`[server] maze ${maze.W}x${maze.H} — spawn (${maze.SPAWN_GX},${maze.SPAWN_GY}) — SCP (${maze.scpCell.gx},${maze.scpCell.gy})`);

/* ================================================================== *
 *  GAME STATE
 * ================================================================== */
const players = new Map();
const usernameIndex = new Map();
let nextId = 1;

/* ---- AI timing constants (clip durations from the model dump) ---- */
const RAGE_DURATION        = 28.0;   // ← total PANIC state
const CHASE_SPEED          = 23;
const ATTACK_RANGE         = 7.0;
const ATTACK_EXIT_RANGE    = 10.5;
const KILL_RANGE           = 1.7;
const ATTACKRUNSTART_DUR   = 1.208;
const ATTACK_JUMP_DUR      = 1.042;
const ATTACK_KILL_AT       = 1.5;    // seconds INTO the attack clip when target dies
const ATTACK_TOTAL         = ATTACK_JUMP_DUR + 6.875;   // attackjump + attack full

const scp = {
  x: cellToWorldX(maze.scpCell.gx),
  z: cellToWorldZ(maze.scpCell.gy),
  yaw: 0,
  state: 'IDLE',              // IDLE | PANIC | CHASE | ATTACK
  substate: null,             // CHASE: 'running'|'attackrunstart'|'attackrun'|'attackrunstart_reverse'
                              // ATTACK: 'attackjump'|'attack'
  stateTime: 0,
  targetId: null,
  threatList: [],
  stunned: false,
  stunTimer: 0,
  killFired: false,
  chaseTimer: 0,
};

function publicPlayer(p) {
  return {
    id: p.id, username: p.username, model: p.model,
    x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch,
    vel: p.vel, running: p.running,
  };
}
function publicScpPos() {
  return { x: scp.x, z: scp.z, yaw: scp.yaw, stunned: scp.stunned };
}
function publicScpState() {
  return {
    state: scp.state,
    substate: scp.substate,
    targetId: scp.targetId,
    threatList: scp.threatList.slice(),
  };
}

function broadcast(msg, excludeId) {
  const data = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id === excludeId) continue;
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}
function sendTo(id, msg) {
  const p = players.get(id);
  if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}
function broadcastScpState() {
  broadcast({ type: 'scp_state', scp: publicScpState() });
}

/* ================================================================== *
 *  BFS
 * ================================================================== */
let scpPath = null, scpPathIdx = 0, repathTimer = 0;

function worldToCell(x, z) {
  return {
    gx: Math.max(0, Math.min(maze.W - 1, Math.floor((x - originX) / CELL))),
    gy: Math.max(0, Math.min(maze.H - 1, Math.floor((z - originZ) / CELL))),
  };
}
function bfsPath(sx, sy, gx, gy) {
  const W = maze.W, H = maze.H;
  const sIdx = sy * W + sx, gIdx = gy * W + gx;
  if (sIdx === gIdx || maze.grid[sIdx] === 1 || maze.grid[gIdx] === 1) return null;
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
      if (maze.grid[n] === 1 || visited[n] !== -1) continue;
      visited[n] = visited[c] + 1;
      prev[n] = c;
      q.push(n);
    }
  }
  if (!found) return null;
  const cells = [];
  let c = gIdx;
  while (c !== -1 && c !== sIdx) { cells.push(c); c = prev[c]; }
  cells.reverse();
  return cells.map(idx => ({
    x: originX + (idx % W) * CELL + CELL / 2,
    z: originZ + ((idx / W) | 0) * CELL + CELL / 2,
  }));
}

/* ================================================================== *
 *  PERCEPTION
 * ================================================================== */
function isPlayerLookingAtFace(p) {
  const dx = scp.x - p.x, dz = scp.z - p.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 42) return false;
  if (dist < 0.5) return true;

  const cp = Math.cos(p.pitch || 0);
  const vx = -Math.sin(p.yaw) * cp;
  const vz = -Math.cos(p.yaw) * cp;
  const ndx = dx / dist, ndz = dz / dist;
  if (vx * ndx + vz * ndz < Math.cos(Math.PI / 4.5)) return false;

  const fdx = Math.sin(scp.yaw), fdz = Math.cos(scp.yaw);
  const toPX = p.x - scp.x, toPZ = p.z - scp.z;
  const toPLen = Math.hypot(toPX, toPZ) || 1e-6;
  const faceDot = (fdx * toPX + fdz * toPZ) / toPLen;
  return faceDot >= 0.25;
}

/* ================================================================== *
 *  STATE MACHINE
 * ================================================================== */
function enterIdle() {
  scp.state = 'IDLE';
  scp.substate = null;
  scp.stateTime = 0;
  scp.targetId = null;
  scp.killFired = false;
  scp.chaseTimer = 0;
  broadcastScpState();
  console.log('[scp] → IDLE');
}

function enterPanic() {
  scp.state = 'PANIC';
  scp.substate = null;
  scp.stateTime = 0;
  broadcastScpState();
  broadcast({ type: 'scp_event', event: 'rage_start' });
  console.log(`[scp] → PANIC (rage for ${RAGE_DURATION}s) threatList=[${scp.threatList}]`);
}

function enterChase(targetId) {
  scp.state = 'CHASE';
  scp.substate = 'running';
  scp.stateTime = 0;
  scp.targetId = targetId;
  scp.chaseTimer = 0;
  scpPath = null;
  scpPathIdx = 0;
  repathTimer = 0;
  broadcastScpState();
  broadcast({ type: 'scp_event', event: 'chase_start', targetId });
  console.log(`[scp] → CHASE → ${targetId}`);
}

function enterAttack() {
  scp.state = 'ATTACK';
  scp.substate = 'attackjump';
  scp.stateTime = 0;
  scp.killFired = false;
  broadcastScpState();
  broadcast({ type: 'scp_event', event: 'kill_start', playerId: scp.targetId });
  console.log(`[scp] → ATTACK → ${scp.targetId}`);
}

/* ================================================================== *
 *  TICK
 * ================================================================== */
function tickIdle(dt) {
  for (const [id, p] of players) {
    if (isPlayerLookingAtFace(p)) {
      scp.threatList = [id];
      enterPanic();
      return;
    }
  }
}

function tickPanic(dt) {
  if (scp.stateTime >= RAGE_DURATION) {
    const next = scp.threatList[0];
    if (next && players.has(next)) enterChase(next);
    else enterIdle();
  }
}

function tickChase(dt) {
  /* new threats can be added any time during chase */
  for (const [id, p] of players) {
    if (id === scp.targetId) continue;
    if (scp.threatList.includes(id)) continue;
    if (isPlayerLookingAtFace(p)) {
      scp.threatList.push(id);
      broadcast({ type: 'scp_event', event: 'threat_added', playerId: id });
      console.log(`[scp] threat added: ${id}`);
    }
  }

  const tgt = players.get(scp.targetId);
  if (!tgt) {
    scp.threatList = scp.threatList.filter(id => id !== scp.targetId);
    const next = scp.threatList[0];
    if (next && players.has(next)) enterChase(next);
    else enterIdle();
    return;
  }

  const dx = tgt.x - scp.x, dz = tgt.z - scp.z;
  const dist = Math.hypot(dx, dz);

  /* --- attackrun substate transitions --- */
  if (dist < ATTACK_RANGE &&
      (scp.substate === 'running')) {
    scp.substate = 'attackrunstart';
    scp.chaseTimer = ATTACKRUNSTART_DUR;
    broadcastScpState();
  } else if (dist > ATTACK_EXIT_RANGE &&
             (scp.substate === 'attackrunstart' || scp.substate === 'attackrun')) {
    scp.substate = 'attackrunstart_reverse';
    scp.chaseTimer = ATTACKRUNSTART_DUR;
    broadcastScpState();
  }

  if (scp.chaseTimer > 0) {
    scp.chaseTimer -= dt;
    if (scp.chaseTimer <= 0) {
      if (scp.substate === 'attackrunstart') {
        scp.substate = 'attackrun';
      } else if (scp.substate === 'attackrunstart_reverse') {
        scp.substate = 'running';
      }
      broadcastScpState();
    }
  }

  /* --- kill --- */
  if (dist < KILL_RANGE) {
    enterAttack();
    return;
  }

  /* --- pathfind + move (keeps moving during attackrun!) --- */
  repathTimer -= dt;
  if (repathTimer <= 0 || !scpPath || scpPathIdx >= scpPath.length) {
    const a = worldToCell(scp.x, scp.z);
    const b = worldToCell(tgt.x, tgt.z);
    scpPath = bfsPath(a.gx, a.gy, b.gx, b.gy);
    scpPathIdx = 0;
    repathTimer = 0.6;
  }

  if (scpPath && scpPathIdx < scpPath.length) {
    const node = scpPath[scpPathIdx];
    const ndx = node.x - scp.x, ndz = node.z - scp.z;
    const nd = Math.hypot(ndx, ndz);
    if (nd < 0.35) scpPathIdx++;
    else {
      scp.x += (ndx / nd) * CHASE_SPEED * dt;
      scp.z += (ndz / nd) * CHASE_SPEED * dt;
      scp.yaw = Math.atan2(ndx, ndz);
    }
  } else if (dist > 0.01) {
    scp.x += (dx / dist) * CHASE_SPEED * dt;
    scp.z += (dz / dist) * CHASE_SPEED * dt;
    scp.yaw = Math.atan2(dx, dz);
  }
}

function tickAttack(dt) {
  if (scp.stateTime < ATTACK_JUMP_DUR) {
    if (scp.substate !== 'attackjump') {
      scp.substate = 'attackjump';
      broadcastScpState();
    }
  } else {
    if (scp.substate !== 'attack') {
      scp.substate = 'attack';
      broadcastScpState();
    }
    const attackElapsed = scp.stateTime - ATTACK_JUMP_DUR;
    if (attackElapsed >= ATTACK_KILL_AT && !scp.killFired) {
      scp.killFired = true;
      sendTo(scp.targetId, {
        type: 'killed',
        x: cellToWorldX(maze.SPAWN_GX),
        z: cellToWorldZ(maze.SPAWN_GY),
      });
      console.log(`[scp] kill landed on ${scp.targetId}`);
    }
  }

  if (scp.stateTime >= ATTACK_TOTAL) {
    scp.threatList = scp.threatList.filter(id => id !== scp.targetId);
    const next = scp.threatList[0];
    if (next && players.has(next)) enterChase(next);
    else enterIdle();
  }
}

function tickScp(dt) {
  if (scp.stunned) {
    scp.stunTimer -= dt;
    if (scp.stunTimer <= 0) {
      scp.stunned = false;
      broadcastScpState();
    }
    return;
  }
  scp.stateTime += dt;
  switch (scp.state) {
    case 'IDLE':   tickIdle(dt);   break;
    case 'PANIC':  tickPanic(dt);  break;
    case 'CHASE':  tickChase(dt);  break;
    case 'ATTACK': tickAttack(dt); break;
  }
}

/* ================================================================== *
 *  WEBSOCKETS
 * ================================================================== */
const wss = new WebSocketServer({ server });

function sendToWs(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  let myId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'join') {
      if (myId !== null) return;
      const name = String(msg.username || '').trim().slice(0, 20);
      if (!name) return sendToWs(ws, { type: 'error', msg: 'Empty username' });

      const lower = name.toLowerCase();
      if (usernameIndex.has(lower))
        return sendToWs(ws, { type: 'error', msg: 'Username already taken' });

      const model = [1, 2].includes(msg.model) ? msg.model : 1;
      myId = nextId++;
      usernameIndex.set(lower, myId);

      const spawnX = cellToWorldX(maze.SPAWN_GX);
      const spawnZ = cellToWorldZ(maze.SPAWN_GY);

      players.set(myId, {
        id: myId, username: name, model, ws,
        x: spawnX, z: spawnZ,
        yaw: 0, pitch: 0, vel: 0, running: false,
      });

      sendToWs(ws, {
        type: 'welcome',
        id: myId,
        username: name,
        model,
        maze: {
          grid: maze.grid,
          W: maze.W, H: maze.H,
          SPAWN_GX: maze.SPAWN_GX, SPAWN_GY: maze.SPAWN_GY,
        },
        spawn: { x: spawnX, z: spawnZ },
        players: [...players.values()].map(publicPlayer),
        scpPos: publicScpPos(),
        scpState: publicScpState(),
      });

      broadcast({ type: 'player_joined', player: publicPlayer(players.get(myId)) }, myId);
      console.log(`[server] +${name} #${myId} — ${players.size} online`);
      return;
    }

    if (myId === null) return;

    if (msg.type === 'state') {
      const p = players.get(myId);
      if (!p) return;
      p.x = msg.x; p.z = msg.z;
      p.yaw = msg.yaw; p.pitch = msg.pitch;
      p.vel = msg.vel; p.running = msg.running;
      return;
    }
  });

  ws.on('close', () => {
    if (myId === null) return;
    const p = players.get(myId);
    if (!p) return;
    usernameIndex.delete(p.username.toLowerCase());
    players.delete(myId);

    scp.threatList = scp.threatList.filter(id => id !== myId);
    if (scp.targetId === myId) {
      const next = scp.threatList[0];
      if (next && players.has(next)) enterChase(next);
      else if (scp.state === 'CHASE' || scp.state === 'ATTACK') enterIdle();
    }
    broadcast({ type: 'player_left', id: myId });
    console.log(`[server] -${p.username} — ${players.size} online`);
  });
});

/* ================================================================== *
 *  TICK LOOP @ 20Hz
 * ================================================================== */
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;

  tickScp(dt);

  broadcast({
    type: 'state',
    players: [...players.values()].map(publicPlayer),
    scpPos: publicScpPos(),
  });
}, 1000 / 20);

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
