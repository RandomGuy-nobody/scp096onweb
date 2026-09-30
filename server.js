import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

/* ================================================================== *
 *  STATIC FILE SERVER
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
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end(); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(serveStatic);

/* ================================================================== *
 *  MAZE (server generates once, all clients use the same one)
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

  return {
    grid: Array.from(grid),
    W, H,
    SPAWN_GX, SPAWN_GY,
    scpCell,
  };
}

const maze = generateMaze();
const originX = -(maze.W * CELL) / 2;
const originZ = -(maze.H * CELL) / 2;
const cellToWorldX = gx => originX + gx * CELL + CELL / 2;
const cellToWorldZ = gy => originZ + gy * CELL + CELL / 2;

console.log(`[server] maze ${maze.W}x${maze.H} — player spawn (${maze.SPAWN_GX},${maze.SPAWN_GY}) — SCP (${maze.scpCell.gx},${maze.scpCell.gy})`);

/* ================================================================== *
 *  GAME STATE
 * ================================================================== */
const players = new Map();          // id -> player
const usernameIndex = new Map();    // lowercase -> id
let nextId = 1;

const scp = {
  x: cellToWorldX(maze.scpCell.gx),
  z: cellToWorldZ(maze.scpCell.gy),
  yaw: 0,
  state: 'IDLE',
  stateTime: 0,
  currentAnim: 'sit',
  targetId: null,
  threatList: [],
  stunned: false,
  stunTimer: 0,
};

function publicPlayer(p) {
  return {
    id: p.id,
    username: p.username,
    model: p.model,
    x: p.x, z: p.z,
    yaw: p.yaw, pitch: p.pitch,
    vel: p.vel, running: p.running,
  };
}
function publicScp() {
  return {
    x: scp.x, z: scp.z, yaw: scp.yaw,
    state: scp.state,
    currentAnim: scp.currentAnim,
    targetId: scp.targetId,
    threatList: scp.threatList,
    stunned: scp.stunned,
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

/* ================================================================== *
 *  SCP AI
 * ================================================================== */
const SCP_SPEED = 12;
const KILL_RANGE = 1.7;
const ATTACK_RANGE = 7;
const PANIC_DURATION = 10;

let scpPath = null, scpPathIdx = 0, repathTimer = 0;

function worldToCell(x, z) {
  return {
    gx: Math.max(0, Math.min(maze.W - 1, Math.floor((x - originX) / CELL))),
    gy: Math.max(0, Math.min(maze.H - 1, Math.floor((z - originZ) / CELL))),
  };
}
function cellCenter(gx, gy) {
  return { x: cellToWorldX(gx), z: cellToWorldZ(gy) };
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
  for (let head = 0; head < q.length; head++) {
    const c = q[head];
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
  return cells.map(idx => cellCenter(idx % W, (idx / W) | 0));
}

function isPlayerLookingAtFace(p) {
  const dx = scp.x - p.x;
  const dz = scp.z - p.z;
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

function tickScp(dt) {
  /* stun: no logic runs, only timer */
  if (scp.stunned) {
    scp.stunTimer -= dt;
    if (scp.stunTimer <= 0) {
      scp.stunned = false;
      scp.currentAnim = scp.state === 'CHASE' ? 'running' : 'sit';
      broadcast({ type: 'scp', scp: publicScp() });
    }
    return;
  }

  scp.stateTime += dt;

  switch (scp.state) {
    case 'IDLE': {
      for (const [id, p] of players) {
        if (isPlayerLookingAtFace(p)) {
          scp.threatList = [id];
          scp.state = 'PANIC';
          scp.stateTime = 0;
          scp.currentAnim = 'getup';
          broadcast({ type: 'scp', scp: publicScp() });
          broadcast({ type: 'scp_event', event: 'face_seen', playerId: id });
          break;
        }
      }
      break;
    }

    case 'PANIC': {
      /* getup (~1.5s) → panicstart1 (~2s) → panic loop (PANIC_DURATION) */
      if (scp.stateTime < 1.5) {
        scp.currentAnim = 'getup';
      } else if (scp.stateTime < 3.5) {
        scp.currentAnim = 'panicstart1';
      } else {
        scp.currentAnim = 'panic';
        if (scp.stateTime > PANIC_DURATION) {
          scp.targetId = scp.threatList[0] || null;
          if (!scp.targetId) {
            scp.state = 'IDLE';
            scp.stateTime = 0;
            scp.currentAnim = 'sit';
          } else {
            scp.state = 'CHASE';
            scp.stateTime = 0;
            scp.currentAnim = 'running';
            broadcast({ type: 'scp_event', event: 'chase_start', targetId: scp.targetId });
          }
          broadcast({ type: 'scp', scp: publicScp() });
        }
      }
      break;
    }

    case 'CHASE': {
      /* add new threats if anyone looks at face while SCP is chasing someone */
      for (const [id, p] of players) {
        if (id === scp.targetId) continue;
        if (scp.threatList.includes(id)) continue;
        if (isPlayerLookingAtFace(p)) {
          scp.threatList.push(id);
          broadcast({ type: 'scp_event', event: 'threat_added', playerId: id });
        }
      }

      const tgt = players.get(scp.targetId);
      if (!tgt) {
        scp.threatList = scp.threatList.filter(id => id !== scp.targetId);
        scp.targetId = scp.threatList[0] || null;
        if (!scp.targetId) {
          scp.state = 'IDLE';
          scp.stateTime = 0;
          scp.currentAnim = 'sit';
          broadcast({ type: 'scp', scp: publicScp() });
        } else {
          broadcast({ type: 'scp_event', event: 'chase_start', targetId: scp.targetId });
        }
        break;
      }

      const dx = tgt.x - scp.x, dz = tgt.z - scp.z;
      const dist = Math.hypot(dx, dz);

      if (dist < KILL_RANGE) {
        scp.state = 'ATTACK';
        scp.stateTime = 0;
        scp.currentAnim = 'attackjump';
        broadcast({ type: 'scp', scp: publicScp() });
        broadcast({ type: 'scp_event', event: 'kill_start', playerId: scp.targetId });
        sendTo(scp.targetId, {
          type: 'killed',
          x: cellToWorldX(maze.SPAWN_GX),
          z: cellToWorldZ(maze.SPAWN_GY),
        });
        break;
      }

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
          scp.x += (ndx / nd) * SCP_SPEED * dt;
          scp.z += (ndz / nd) * SCP_SPEED * dt;
          scp.yaw = Math.atan2(ndx, ndz);
        }
      } else if (dist > 0.01) {
        scp.x += (dx / dist) * SCP_SPEED * dt;
        scp.z += (dz / dist) * SCP_SPEED * dt;
        scp.yaw = Math.atan2(dx, dz);
      }

      scp.currentAnim = dist < ATTACK_RANGE ? 'attackrun' : 'running';
      break;
    }

    case 'ATTACK': {
      if (scp.stateTime < 1.0) scp.currentAnim = 'attackjump';
      else {
        scp.currentAnim = 'attack';
        if (scp.stateTime > 3.5) {
          scp.threatList = scp.threatList.filter(id => id !== scp.targetId);
          if (scp.threatList.length > 0) {
            scp.targetId = scp.threatList[0];
            scp.state = 'CHASE';
            scp.stateTime = 0;
            scp.currentAnim = 'running';
            broadcast({ type: 'scp_event', event: 'chase_start', targetId: scp.targetId });
          } else {
            scp.targetId = null;
            scp.state = 'IDLE';
            scp.stateTime = 0;
            scp.currentAnim = 'sit';
          }
          broadcast({ type: 'scp', scp: publicScp() });
        }
      }
      break;
    }
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
        scp: publicScp(),
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

    if (msg.type === 'fire') {
      broadcast({
        type: 'fire',
        id: myId,
        ox: msg.ox, oy: msg.oy, oz: msg.oz,
        dx: msg.dx, dy: msg.dy, dz: msg.dz,
      });
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
      scp.targetId = scp.threatList[0] || null;
      if (!scp.targetId && scp.state === 'CHASE') {
        scp.state = 'IDLE';
        scp.stateTime = 0;
        scp.currentAnim = 'sit';
      }
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
    scp: publicScp(),
  });
}, 1000 / 20);

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
