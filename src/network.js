export class NetworkClient {
  constructor() {
    this.ws = null;
    this.id = null;
    this.username = null;
    this.maze = null;
    this.spawn = null;
    this.players = new Map();
    this.scpPos = null;
    this.scpState = null;
    this.handlers = {};
    this.onState = null;
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(e));
      this.ws.addEventListener('close', () => console.log('[net] disconnected'));
      this.ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        this._handle(msg);
      });
    });
  }

  _handle(msg) {
    switch (msg.type) {
      case 'welcome':
        this.id = msg.id;
        this.username = msg.username;
        this.maze = msg.maze;
        this.spawn = msg.spawn;
        this.players.clear();
        for (const p of msg.players) {
          if (p.id !== this.id) this.players.set(p.id, p);
        }
        this.scpPos   = msg.scpPos   || null;
        this.scpState = msg.scpState || null;
        this._emit('welcome', msg);
        break;

      case 'player_joined':
        if (msg.player.id !== this.id) this.players.set(msg.player.id, msg.player);
        this._emit('player_joined', msg.player);
        break;

      case 'player_left':
        this.players.delete(msg.id);
        this._emit('player_left', msg.id);
        break;

      case 'state':
        for (const p of msg.players) {
          if (p.id !== this.id) this.players.set(p.id, p);
        }
        if (msg.scpPos) this.scpPos = msg.scpPos;
        if (this.onState) this.onState(msg);
        break;

      case 'scp_state':
        this.scpState = msg.scp;
        this._emit('scp_state', msg.scp);
        break;

      case 'scp_event':
        this._emit('scp_event', msg);
        break;

      case 'killed':
        this._emit('killed', msg);
        break;

      case 'error':
        this._emit('error', msg);
        break;
    }
  }

  on(event, fn) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(fn);
  }
  _emit(event, data) {
    const list = this.handlers[event];
    if (!list) return;
    for (const fn of list) fn(data);
  }

  sendJoin(username, model) {
    if (this.isConnected())
      this.ws.send(JSON.stringify({ type: 'join', username, model }));
  }
  sendState(x, z, yaw, pitch, vel, running) {
    if (this.isConnected())
      this.ws.send(JSON.stringify({ type: 'state', x, z, yaw, pitch, vel, running }));
  }
  sendFire(ox, oy, oz, dx, dy, dz) {
    if (this.isConnected())
      this.ws.send(JSON.stringify({ type: 'fire', ox, oy, oz, dx, dy, dz }));
  }
  isConnected() {
    return this.ws && this.ws.readyState === 1;
  }
}
