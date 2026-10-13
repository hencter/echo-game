// Local WebSocket room for Echo. One shared 960×540 field.
// The opening 60-step grace is decided here and sent as `grace`.
// Clients only draw that bit; they do not call the hit test online.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const rules = require('./shared');

const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const COLORS = ['#ff8ad4', '#b8ff7a', '#ffd27a', '#d4a5ff', '#7affd4', '#ffaa7a', '#a0b4ff', '#7ad7ff'];
const MAX_PLAYERS = 8;
const FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/shared.js', 'shared.js'],
]);

function cleanName(value) {
  const text = String(value || '').trim().slice(0, 12);
  if (!text || !/^[\w\u4e00-\u9fff-]+$/.test(text)) return '';
  return text;
}

function roomOf(url) {
  const parsed = new URL(url, 'http://127.0.0.1');
  const raw = parsed.searchParams.get('room') || 'hall';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'hall';
}

function starValid(sx, sy, room, alive) {
  const u = rules.unit(rules.W, rules.H);
  const hit = rules.collideDist(rules.W, rules.H, room.ghosts.length);
  for (const player of alive) {
    if (Math.hypot(sx - player.x, sy - player.y) < u * 0.12) return false;
  }
  for (const star of room.stars) {
    if (Math.hypot(star.x - sx, star.y - sy) < u * 0.1) return false;
  }
  for (const ghost of room.ghosts) {
    const q = ghost.pts[Math.min(room.t, ghost.pts.length - 1)];
    if (q && Math.hypot(q.x - sx, q.y - sy) < hit + u * 0.02) return false;
  }
  return true;
}

function spawnStar(room, alive) {
  if (!alive.length) return false;
  const u = rules.unit(rules.W, rules.H);
  const anchor = alive[Math.floor(Math.random() * alive.length)];
  const maxD = Math.min(Math.hypot(rules.W, rules.H), u * (0.34 + (room.round - 1) * 0.13));
  const minD = u * 0.14;
  for (let n = 0; n < 28; n++) {
    let sx;
    let sy;
    if (n < 22) {
      const angle = Math.random() * Math.PI * 2;
      const dist = minD + Math.random() * Math.max(8, maxD - minD);
      sx = anchor.x + Math.cos(angle) * dist;
      sy = anchor.y + Math.sin(angle) * dist;
    } else {
      sx = u * 0.06 + Math.random() * (rules.W - u * 0.12);
      sy = u * 0.06 + Math.random() * (rules.H - u * 0.12);
    }
    sx = Math.max(u * 0.05, Math.min(rules.W - u * 0.05, sx));
    sy = Math.max(u * 0.05, Math.min(rules.H - u * 0.05, sy));
    if (!starValid(sx, sy, room, alive)) continue;
    room.stars.push({ x: sx, y: sy });
    return true;
  }
  return false;
}

function createRoom(name, dispose) {
  const room = {
    name,
    state: 'lobby',
    round: 1,
    t: 0,
    step: 0,
    epoch: 0,
    banner: 0,
    seq: 0,
    nextId: 0,
    ghosts: [],
    stars: [],
    events: [],
    players: new Map(),
    bySocket: new Map(),
  };

  function alive() {
    return [...room.players.values()].filter((player) => player.mode === 'play');
  }

  function graceNow() {
    return room.state === 'play' && rules.protecting(room.ghosts.length, room.t);
  }

  function fillStars() {
    const playing = alive();
    let guard = 0;
    while (room.stars.length < rules.starGoal(room.round) && guard++ < 4) spawnStar(room, playing);
  }

  function snapshot() {
    return {
      type: 'snap',
      seq: ++room.seq,
      epoch: room.epoch,
      state: room.state,
      round: room.round,
      t: room.t,
      step: room.step,
      grace: graceNow(),
      banner: room.banner,
      stars: room.stars.map((star) => ({ x: star.x, y: star.y })),
      players: [...room.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        x: player.x,
        y: player.y,
        vx: player.vx,
        vy: player.vy,
        mode: player.mode,
        score: player.score,
      })),
      ghosts: room.ghosts.map((ghost) => ({
        ownerId: ghost.ownerId,
        name: ghost.name,
        color: ghost.color,
        pts: ghost.pts,
      })),
      trails: [...room.players.values()].filter((player) => player.mode === 'play' && player.rec.length).map((player) => ({
        id: player.id,
        pts: player.rec,
      })),
      events: room.events.slice(),
    };
  }

  function broadcast() {
    const message = snapshot();
    room.events = [];
    for (const player of room.players.values()) {
      if (!player.socket || player.socket.readyState !== 1) continue;
      message.you = player.id;
      player.socket.send(JSON.stringify(message));
    }
  }

  function collide() {
    if (rules.protecting(room.ghosts.length, room.t)) return;
    const dist = rules.collideDist(rules.W, rules.H, room.ghosts.length);
    for (const player of alive()) {
      let best = null;
      for (const ghost of room.ghosts) {
        const q = ghost.pts[Math.min(room.t, ghost.pts.length - 1)];
        if (!q) continue;
        const d = Math.hypot(q.x - player.x, q.y - player.y);
        if (d >= dist) continue;
        const self = ghost.ownerId === player.id;
        if (!best || (self && !best.self) || (self === best.self && d < best.d)) {
          best = { ghost, d, self };
        }
      }
      if (!best) continue;
      player.mode = 'dead';
      player.vx = 0;
      player.vy = 0;
      player.rec = [];
      room.events.push({
        type: 'die',
        id: player.id,
        by: best.ghost.name,
        self: best.self,
        x: player.x,
        y: player.y,
      });
    }
  }

  function collectStars() {
    const got = rules.unit(rules.W, rules.H) * 0.04;
    const playing = alive();
    room.stars = room.stars.filter((star) => {
      for (const player of playing) {
        if (Math.hypot(star.x - player.x, star.y - player.y) >= got) continue;
        player.score += 10 * room.round;
        room.events.push({ type: 'pick', id: player.id, x: star.x, y: star.y });
        return false;
      }
      return true;
    });
  }

  function finishRound() {
    for (const player of room.players.values()) {
      if (player.mode !== 'play') continue;
      player.score += 50;
      if (player.rec.length) {
        room.ghosts.push({
          ownerId: player.id,
          name: player.name,
          color: player.color,
          pts: player.rec.map((point) => ({ x: point.x, y: point.y })),
        });
      }
      player.rec = [];
    }
    room.round += 1;
    room.step = 0;
    room.t = 0;
    room.banner = 70;
    room.events.push({ type: 'round' });
  }

  function playTick() {
    if (room.banner > 0) room.banner--;
    if (!alive().length) {
      room.state = 'over';
      return;
    }
    for (const player of alive()) {
      rules.applyMove(player, player.input, rules.W, rules.H);
      player.rec.push({ x: player.x, y: player.y });
    }
    room.step += 1;
    room.t = room.step - 1;
    collide();
    if (!alive().length) {
      room.state = 'over';
      return;
    }
    collectStars();
    fillStars();
    if (room.step >= rules.STEPS) finishRound();
  }

  function beginMatch() {
    room.state = 'play';
    room.round = 1;
    room.t = 0;
    room.step = 0;
    room.banner = 0;
    room.ghosts = [];
    room.stars = [];
    room.events = [];
    room.epoch += 1;
    for (const player of room.players.values()) {
      player.mode = 'play';
      player.score = 0;
      player.x = rules.W / 2;
      player.y = rules.H / 2;
      player.vx = 0;
      player.vy = 0;
      player.rec = [];
      player.input = { ax: 0, ay: 0, mouse: null, keyboard: false };
    }
    fillStars();
    broadcast();
  }

  return {
    name,
    tick() {
      if (room.state === 'lobby') {
        for (const player of room.players.values()) {
          if (player.mode === 'lobby') rules.applyMove(player, player.input, rules.W, rules.H);
        }
        broadcast();
        return;
      }
      if (room.state !== 'play') {
        broadcast();
        return;
      }
      playTick();
      broadcast();
    },
    hello(socket, msg) {
      if (room.bySocket.has(socket)) return;
      if (room.players.size >= MAX_PLAYERS) {
        socket.close(1008, 'full');
        return;
      }
      const index = room.players.size;
      const id = 'p' + (++room.nextId);
      const player = {
        id,
        name: cleanName(msg && msg.name) || NAMES[index % NAMES.length],
        color: COLORS[index % COLORS.length],
        socket,
        x: rules.W / 2 + ((index % 2 === 0 ? -1 : 1) * Math.ceil(index / 2) * 48),
        y: rules.H / 2,
        vx: 0,
        vy: 0,
        mode: room.state === 'play' ? 'spectate' : 'lobby',
        score: 0,
        rec: [],
        input: { ax: 0, ay: 0, mouse: null, keyboard: false },
      };
      player.x = Math.max(20, Math.min(rules.W - 20, player.x));
      room.players.set(id, player);
      room.bySocket.set(socket, player);
      broadcast();
    },
    input(socket, msg) {
      const player = room.bySocket.get(socket);
      if (!player || (player.mode !== 'play' && player.mode !== 'lobby')) return;
      let mouse = null;
      if (msg && msg.mouse && Number.isFinite(+msg.mouse.x) && Number.isFinite(+msg.mouse.y)) {
        mouse = {
          x: Math.max(0, Math.min(rules.W, +msg.mouse.x)),
          y: Math.max(0, Math.min(rules.H, +msg.mouse.y)),
        };
      }
      player.input = {
        ax: rules.axis(msg && msg.ax),
        ay: rules.axis(msg && msg.ay),
        mouse,
        keyboard: !!(msg && msg.keyboard),
      };
    },
    requestStart(socket) {
      if (!room.bySocket.has(socket)) return;
      if (room.state === 'play') return;
      beginMatch();
    },
    leave(socket) {
      const player = room.bySocket.get(socket);
      if (!player) return;
      room.bySocket.delete(socket);
      room.players.delete(player.id);
      if (!room.players.size) {
        dispose(room.name);
        return;
      }
      if (room.state === 'play' && !alive().length) room.state = 'over';
      broadcast();
    },
  };
}

function createApp(options = {}) {
  const autoTick = options.autoTick !== false;
  const rooms = new Map();
  let timer = null;
  let acc = 0;
  let last = Date.now();

  function getRoom(name) {
    if (!rooms.has(name)) {
      rooms.set(name, createRoom(name, (key) => rooms.delete(key)));
    }
    return rooms.get(name);
  }

  function tickAll() {
    for (const room of rooms.values()) room.tick();
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = FILES.get(url.pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const body = fs.readFileSync(path.join(__dirname, file));
    const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket, req) => {
    const room = getRoom(roomOf(req.url || '/ws'));
    socket.on('message', (data) => {
      if (data.length > 4000) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'hello') room.hello(socket, msg);
      else if (msg.type === 'input') room.input(socket, msg);
      else if (msg.type === 'start') room.requestStart(socket);
    });
    socket.on('close', () => room.leave(socket));
  });

  return {
    tickAll,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          if (autoTick) {
            last = Date.now();
            timer = setInterval(() => {
              const now = Date.now();
              let dt = now - last;
              last = now;
              if (dt < 0) dt = 0;
              if (dt > 250) dt = 250;
              acc += dt;
              let n = 0;
              while (acc >= 1000 / 60 && n++ < 8) {
                tickAll();
                acc -= 1000 / 60;
              }
            }, 4);
          }
          resolve(server.address().port);
        });
      });
    },
    close() {
      if (timer) clearInterval(timer);
      for (const socket of wss.clients) socket.close();
      wss.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  createApp().listen(port).then((bound) => {
    console.log('回声多人服务 http://127.0.0.1:' + bound + '/');
    console.log('开两个浏览器窗口，各自点「多人同场」。看到人数后，按空格开始。');
  });
}

module.exports = { createApp };
