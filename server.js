// Local WebSocket room for Echo. One shared 960×540 field.
// The opening 60-step grace is decided here and sent as `grace`.
// Clients only draw that bit; they do not call the hit test online.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const rules = require('./shared');

const profiles = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadProfile(name) {
  if (!profiles.has(name)) profiles.set(name, rules.freshProfile());
  const profile = profiles.get(name);
  if (!profile.gear) profile.gear = rules.emptyGear();
  profile.gear.level = profile.level || 1;
  return profile;
}

const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const COLORS = ['#ff8ad4', '#b8ff7a', '#ffd27a', '#d4a5ff', '#7affd4', '#ffaa7a', '#a0b4ff', '#7ad7ff'];
const MAX_PLAYERS = 8;
const FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/shared.js', 'shared.js'],
]);

function nudgeSalt(id) {
  let h = 2166136261;
  const text = String(id || '');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

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
    shopLeft: 0,
    seed: 1,
    mode: 'free',
    stageId: 0,
    walls: [],
    monsters: [],
    shots: [],
    drops: [],
    players: new Map(),
    bySocket: new Map(),
  };

  function alive() {
    return [...room.players.values()].filter((player) => player.mode === 'play');
  }

  function graceNow() {
    return room.state === 'play' && rules.protecting(room.ghosts.length, room.t);
  }

  function blankCombat(player, keepGear) {
    if (!keepGear) player.gear = rules.emptyGear();
    player.hp = 1;
    player.maxHp = 1;
    player.shield = 0;
    player.iframes = 0;
    player.dashLeft = 0;
    player.dashCd = 0;
    player.dashX = 1;
    player.dashY = 0;
    player.ready = false;
    player.warnAt = rules.WARN_BASE;
    player.nudgeSalt = nudgeSalt(player.id);
  }

  function syncVitals(player, fill) {
    const stats = rules.statsOf(player.gear);
    if (room.mode === 'campaign' && player.profile) {
      player.maxHp = rules.heartsOf(player.profile.level || 1, stats.bonusHp);
      player.gear.level = player.profile.level || 1;
    } else {
      player.maxHp = stats.maxHp;
    }
    player.warnAt = stats.warn;
    if (fill) {
      player.hp = player.maxHp;
      player.shield = stats.blocks;
      player.iframes = 0;
      player.dashLeft = 0;
      player.dashCd = 0;
    } else if (player.hp > player.maxHp) {
      player.hp = player.maxHp;
    }
    return stats;
  }

  function facing(player) {
    const input = player.input || {};
    if (input.ax || input.ay) {
      const len = Math.hypot(input.ax, input.ay) || 1;
      return { x: input.ax / len, y: input.ay / len };
    }
    if (input.mouse) {
      const dx = input.mouse.x - player.x;
      const dy = input.mouse.y - player.y;
      const len = Math.hypot(dx, dy);
      if (len > 4) return { x: dx / len, y: dy / len };
    }
    const speed = Math.hypot(player.vx, player.vy);
    if (speed > 1) return { x: player.vx / speed, y: player.vy / speed };
    const len = Math.hypot(player.dashX, player.dashY) || 1;
    return { x: player.dashX / len, y: player.dashY / len };
  }

  function movePlayer(player) {
    const stats = rules.statsOf(player.gear);
    if (player.dashLeft > 0) {
      rules.applyMove(player, player.input, rules.W, rules.H, {
        speed: stats.speed,
        dash: { x: player.dashX, y: player.dashY, mul: player.dashMul || (stats.dash ? stats.dash.speed : stats.speed) },
      });
      player.dashLeft--;
      return;
    }
    if (player.dashCd > 0) player.dashCd--;
    rules.applyMove(player, player.input, rules.W, rules.H, { speed: stats.speed });
  }

  function markCheckpoint(player) {
    player.checkpoint = {
      x: player.x,
      y: player.y,
      hp: player.hp,
      shield: player.shield,
    };
  }

  function startDash(player) {
    if (room.state !== 'play' || player.mode !== 'play') return;
    const stats = rules.poweredStats(player.gear);
    const dash = rules.attackDash(stats, (player.profile && player.profile.level) || 1, room.mode === 'campaign');
    if (!dash || player.dashCd > 0 || player.dashLeft > 0) return;
    if (dash.paid && !rules.payDash(player.gear)) {
      deny(player, 'not_enough_T');
      return;
    }
    const dir = facing(player);
    player.dashX = dir.x;
    player.dashY = dir.y;
    player.dashLeft = dash.frames;
    player.dashCd = dash.cd;
    player.dashMul = dash.speed;
    player.dashHits = {};
    room.events.push({ type: 'dash', id: player.id });
  }

  function fillStars() {
    const playing = alive();
    let guard = 0;
    const stage = room.mode === 'campaign' ? rules.stageById(room.stageId) : null;
    while (room.stars.length < rules.starGoal(room.round, stage) && guard++ < 4) spawnStar(room, playing);
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
        hp: player.hp,
        maxHp: player.maxHp,
        shield: player.shield,
        warnAt: player.warnAt,
        ready: !!player.ready,
        gear: player.gear ? rules.publicGear(player.gear) : [],
        role: player.role || 'echo',
        level: player.profile ? player.profile.level : 1,
        title: player.profile ? (player.profile.title || '') : '',
      })),
      mode: room.mode,
      stageId: room.stageId,
      stageName: room.mode === 'campaign' && rules.stageById(room.stageId) ? rules.stageById(room.stageId).name : '',
      stageRounds: room.mode === 'campaign' && rules.stageById(room.stageId) ? rules.stageById(room.stageId).rounds : 0,
      walls: room.walls || [],
      monsters: (room.monsters || []).map((mon) => ({
        id: mon.id, kind: mon.kind, name: mon.name, x: mon.x, y: mon.y, hp: mon.hp, maxHp: mon.maxHp, r: mon.r, color: mon.color,
      })),
      shots: (room.shots || []).map((shot) => ({ x: shot.x, y: shot.y, r: shot.r })),
      drops: (room.drops || []).map((drop) => ({ id: drop.id, x: drop.x, y: drop.y, kind: drop.kind, name: drop.item ? drop.item.name : '' })),
      shopLeft: room.shopLeft,
      ghosts: room.ghosts.map((ghost) => ({
        ownerId: ghost.ownerId,
        name: ghost.name,
        color: ghost.color,
        pts: ghost.pts,
        role: ghost.role || 'echo',
        eaten: Object.keys(ghost.eaten || {}).map(Number).slice(0, 80),
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
      if (!player.profile) player.profile = loadProfile(player.name);
      message.you = player.id;
      message.coins = player.gear ? player.gear.t : 0;
      message.bag = player.gear ? rules.bagView(player.gear) : [];
      message.offers = player.gear ? rules.offers(player.gear) : [];
      message.level = player.profile.level || 1;
      message.xp = player.profile.xp || 0;
      message.xpNext = rules.xpToNext(player.profile.level || 1);
      message.unlocked = player.profile.unlocked || 1;
      message.quests = rules.questBoard(player.profile, todayKey());
      message.title = player.profile.title || '';
      player.socket.send(JSON.stringify(message));
    }
  }

  function collide() {
    if (rules.protecting(room.ghosts.length, room.t)) return;
    const dist = rules.collideDist(rules.W, rules.H, room.ghosts.length);
    for (const player of alive()) {
      let best = null;
      const stats = rules.poweredStats(player.gear);
      const stage = room.mode === 'campaign' ? rules.stageById(room.stageId) : null;
      const core = rules.mergeCore(stats.core, rules.stageEcho(stage, room.round));
      for (const ghost of room.ghosts) {
        const index = Math.min(room.t, (ghost.pts || []).length - 1);
        if (ghost.eaten && ghost.eaten[index]) continue;
        const q = rules.echoAt(ghost.pts, room.t, {
          x: player.x,
          y: player.y,
          vx: player.vx,
          vy: player.vy,
          core: core,
          w: rules.W,
          h: rules.H,
        });
        if (!q) continue;
        const d = Math.hypot(q.x - player.x, q.y - player.y);
        if (d >= dist) continue;
        const self = ghost.ownerId === player.id;
        if (!best || (self && !best.self) || (self === best.self && d < best.d)) {
          best = { ghost, d, self };
        }
      }
      if (player.iframes > 0) {
        player.iframes--;
        continue;
      }
      if (!best) continue;
      if (player.shield > 0) {
        player.shield--;
        player.iframes = rules.IFRAMES;
        room.events.push({ type: 'block', id: player.id, x: player.x, y: player.y, self: best.self });
        continue;
      }
      if (player.hp > 1) {
        player.hp--;
        if (room.mode === 'campaign') player.stageDamage = (player.stageDamage || 0) + 1;
        player.iframes = rules.IFRAMES;
        room.events.push({ type: 'hurt', id: player.id, hp: player.hp, x: player.x, y: player.y, self: best.self });
        continue;
      }
      player.mode = 'dead';
      player.hp = 0;
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

  function pullStars() {
    const scale = rules.unit(rules.W, rules.H) / 540;
    const playing = alive();
    for (let i = 0; i < room.stars.length; i++) {
      const star = room.stars[i];
      let best = null;
      for (let p = 0; p < playing.length; p++) {
        const player = playing[p];
        const stats = rules.statsOf(player.gear);
        if (!stats.pull) continue;
        const attract = stats.attract * scale;
        const dist = Math.hypot(star.x - player.x, star.y - player.y);
        if (dist < 1 || dist > attract) continue;
        if (!best || dist < best.dist) best = { player: player, dist: dist, pull: stats.pull * scale };
      }
      if (!best) continue;
      const step = Math.min(best.pull, best.dist);
      star.x += (best.player.x - star.x) / best.dist * step;
      star.y += (best.player.y - star.y) / best.dist * step;
    }
  }

  function collectStars() {
    const base = rules.unit(rules.W, rules.H) * 0.04;
    const playing = alive();
    room.stars = room.stars.filter((star) => {
      for (let i = 0; i < playing.length; i++) {
        const player = playing[i];
        const stats = rules.poweredStats(player.gear);
        if (Math.hypot(star.x - player.x, star.y - player.y) >= base * stats.magnet) continue;
        const gain = stats.reward || 1;
        player.score += Math.round(rules.SCORE_STAR * room.round * stats.score * gain);
        const coins = Math.round(rules.T_STAR * gain);
        player.gear.t += coins;
        if (player.profile) rules.bumpQuest(player.profile, 'stars', 1, null, todayKey());
        if (room.mode === 'campaign' && player.profile) {
          const up = rules.addXp(player.profile, 1);
          player.gear.t += up.bonus;
          up.levels.forEach((level) => room.events.push({ type: 'level', id: player.id, level: level }));
          remember(player);
        }
        room.events.push({ type: 'pick', id: player.id, x: star.x, y: star.y, t: coins });
        return false;
      }
      return true;
    });
  }

  function remember(player) {
    if (!player.profile || !player.gear) return;
    player.gear.level = player.profile.level || 1;
    player.profile.gear = rules.cloneGear(player.gear);
    player.profile.gear.level = player.profile.level || 1;
  }

  function fightRoom() {
    const stage = rules.stageById(room.stageId);
    const players = alive();
    const ghosts = room.ghosts.map((ghost) => ({ pts: ghost.pts, t: room.t }));
    rules.stepMonsters(room.monsters, players, ghosts, stage, room.round, room.walls);
    rules.eatEchoes(room.monsters, room.ghosts);
    rules.kingBarrage(room.monsters, room.ghosts, players, room.shots, room.step, room.seed);
    rules.stepShots(room.shots, room.walls);
    for (const player of players) {
      const events = rules.fightMonsters(player, room.monsters, room.shots, player.dashing);
      events.forEach((event) => {
        if (event.type === 'bite') player.stageDamage = (player.stageDamage || 0) + 1;
        room.events.push(event);
      });
      if (player.hp <= 0 && player.mode === 'play') {
        player.mode = 'dead';
        player.hp = 0;
        player.vx = 0;
        player.vy = 0;
        player.rec = [];
        room.events.push({ type: 'die', id: player.id, by: '怪物', self: false, x: player.x, y: player.y });
      }
    }
    const reaped = rules.reapMonsters(room.monsters, room.seed, room.step);
    reaped.killed.forEach((mon) => {
      const killer = [...room.players.values()].find((player) => player.id === mon.lastHit);
      if (killer && killer.profile) {
        rules.bumpQuest(killer.profile, 'kills', 1, null, todayKey());
        if (mon.kind === 'king') rules.bumpQuest(killer.profile, 'king-v2', 1, { v2: rules.wornV2(killer.gear) }, todayKey());
      }
      room.events.push({ type: 'kill', id: mon.lastHit || '', name: mon.name, x: mon.x, y: mon.y });
    });
    room.drops = room.drops.concat(reaped.drops);
    room.drops = room.drops.filter((drop) => {
      for (const player of alive()) {
        if (Math.hypot(drop.x - player.x, drop.y - player.y) >= 24) continue;
        const levels = rules.takeDrop(player.gear, player.profile, drop);
        levels.forEach((level) => room.events.push({ type: 'level', id: player.id, level: level }));
        remember(player);
        syncVitals(player, false);
        room.events.push({ type: 'loot', id: player.id, kind: drop.kind, x: drop.x, y: drop.y });
        return false;
      }
      return true;
    });
  }

  function clearStage() {
    const stage = rules.stageById(room.stageId);
    for (const player of alive()) {
      if (!player.profile) continue;
      if (player.profile.unlocked < stage.id + 1) player.profile.unlocked = Math.min(rules.STAGES.length, stage.id + 1);
      rules.bumpQuest(player.profile, 'clear', 1, { stage: stage.id }, todayKey());
      if (!player.stageDamage) rules.bumpQuest(player.profile, 'flawless', 1, null, todayKey());
      remember(player);
    }
    room.monsters = [];
    room.shots = [];
    room.drops = [];
    room.state = 'clear';
    room.events.push({ type: 'clear', stage: stage.id, name: stage.name });
  }

  function finishRound() {
    for (const player of room.players.values()) {
      if (player.mode !== 'play') continue;
      const stats = rules.poweredStats(player.gear);
      const gain = stats.reward || 1;
      player.score += Math.round(rules.SCORE_ROUND * stats.score * gain);
      player.gear.t += Math.round(rules.T_ROUND * gain);
      rules.noteSamples(player.gear);
      rules.openStock(player.gear, room.seed, room.round, player.id);
      if (room.mode === 'campaign' && player.profile) {
        const up = rules.addXp(player.profile, 2);
        player.gear.t += up.bonus;
        up.levels.forEach((level) => room.events.push({ type: 'level', id: player.id, level: level }));
        remember(player);
      }
      if (player.rec.length) {
        room.ghosts.push({
          ownerId: player.id,
          name: player.name,
          color: player.color,
          role: player.role || 'echo',
          pts: player.rec.map((point) => ({ x: point.x, y: point.y })),
        });
      }
      player.rec = [];
      player.ready = false;
      player.dashLeft = 0;
      syncVitals(player, true);
    }
    room.stars = [];
    if (room.mode === 'campaign') {
      const stage = rules.stageById(room.stageId);
      const king = (room.monsters || []).some((mon) => mon.kind === 'king' && mon.hp > 0);
      if (stage && room.round >= stage.rounds && stage.boss && king) {
        room.state = 'over';
        room.events.push({ type: 'boss', name: stage.name });
        return;
      }
    }
    room.state = 'shop';
    room.shopLeft = rules.SHOP_STEPS;
    room.banner = 70;
    room.events.push({ type: 'shop' });
  }

  function startNextRound() {
    if (room.mode === 'campaign') {
      const stage = rules.stageById(room.stageId);
      if (stage && room.round >= stage.rounds) {
        clearStage();
        return;
      }
    }
    room.state = 'play';
    room.round += 1;
    if (room.mode === 'campaign') {
      const stage = rules.stageById(room.stageId);
      room.monsters = rules.spawnWave(stage, room.round, room.seed, room.monsters);
      room.shots = [];
    }
    room.t = 0;
    room.step = 0;
    room.shopLeft = 0;
    room.banner = 70;
    room.stars = [];
    for (const player of room.players.values()) {
      player.ready = false;
      player.rec = [];
      player.dashLeft = 0;
      player.dashCd = 0;
      if (player.mode === 'play') {
        syncVitals(player, true);
        markCheckpoint(player);
      }
    }
    fillStars();
    room.events.push({ type: 'round' });
  }

  function shopTick() {
    if (room.banner > 0) room.banner--;
    for (const player of alive()) {
      player.vx = 0;
      player.vy = 0;
      player.dashLeft = 0;
    }
    if (room.shopLeft > 0) room.shopLeft--;
    const warmed = room.shopLeft <= rules.SHOP_STEPS - rules.SHOP_MIN;
    const playing = alive();
    const allReady = playing.length > 0 && playing.every((player) => player.ready);
    if (room.shopLeft <= 0 || (warmed && allReady)) startNextRound();
  }

  function playTick() {
    if (room.banner > 0) room.banner--;
    if (!alive().length) {
      room.state = 'over';
      return;
    }
    for (const player of alive()) {
      player.dashing = player.dashLeft > 0;
      movePlayer(player);
      if (room.mode === 'campaign') rules.pushOut(player, room.walls, 12);
    }
    room.step += 1;
    room.t = room.step - 1;
    for (const player of alive()) {
      const stats = rules.statsOf(player.gear);
      const nudge = rules.hallucinationNudge(room.step, stats.noise, player.nudgeSalt);
      if (nudge.x || nudge.y) {
        player.x = Math.max(12, Math.min(rules.W - 12, player.x + nudge.x));
        player.y = Math.max(12, Math.min(rules.H - 12, player.y + nudge.y));
      }
      player.rec.push({ x: player.x, y: player.y });
      player.warnAt = rules.poweredStats(player.gear).warn;
    }
    for (const player of alive()) rules.tickDrain(player.gear, rules.statsOf(player.gear), room.step);
    if (room.mode === 'campaign') fightRoom();
    collide();
    if (!alive().length) {
      room.state = 'over';
      return;
    }
    pullStars();
    collectStars();
    fillStars();
    if (room.step >= rules.STEPS) finishRound();
  }

  function deny(player, reason) {
    room.events.push({ type: 'deny', id: player.id, reason: reason, text: rules.REASON[reason] || reason });
  }

  function changeGear(player, result) {
    if (!result.ok) {
      deny(player, result.reason);
      return;
    }
    syncVitals(player, true);
    if (room.mode === 'campaign') remember(player);
    room.events.push({ type: 'gear', id: player.id });
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
    room.shots = [];
    room.drops = [];
    room.epoch += 1;
    room.seed = (Math.random() * 0x100000000) >>> 0;
    const stage = room.mode === 'campaign' ? rules.stageById(room.stageId) : null;
    room.walls = stage ? stage.walls : [];
    room.monsters = stage ? rules.spawnWave(stage, 1, room.seed) : [];
    for (const player of room.players.values()) {
      player.mode = 'play';
      player.score = 0;
      player.x = rules.W / 2;
      player.y = rules.H / 2;
      player.vx = 0;
      player.vy = 0;
      player.rec = [];
      player.input = { ax: 0, ay: 0, mouse: null, keyboard: false };
      player.stageDamage = 0;
      if (room.mode === 'campaign') {
        player.profile = loadProfile(player.name);
        player.gear = rules.cloneGear(player.profile.gear);
        player.gear.level = player.profile.level || 1;
        blankCombat(player, true);
      } else {
        player.profile = loadProfile(player.name);
        blankCombat(player, false);
      }
      syncVitals(player, true);
      markCheckpoint(player);
    }
    room.shopLeft = 0;
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
      if (room.state === 'shop') {
        shopTick();
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
        role: rules.roleById(msg && msg.role) ? String(msg.role) : 'echo',
        socket,
        x: rules.W / 2 + ((index % 2 === 0 ? -1 : 1) * Math.ceil(index / 2) * 48),
        y: rules.H / 2,
        vx: 0,
        vy: 0,
        mode: room.state === 'play' || room.state === 'shop' ? 'spectate' : 'lobby',
        score: 0,
        rec: [],
        input: { ax: 0, ay: 0, mouse: null, keyboard: false },
      };
      blankCombat(player);
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
      if (msg && msg.dash) startDash(player);
    },
    role(socket, id) {
      const player = room.bySocket.get(socket);
      if (!player) return;
      if (!rules.roleById(id)) {
        deny(player, 'role');
        return;
      }
      player.role = id;
    },
    dash(socket) {
      const player = room.bySocket.get(socket);
      if (!player) return;
      startDash(player);
    },
    buy(socket, id) {
      const player = room.bySocket.get(socket);
      if (!player || player.mode !== 'play') return;
      if (room.state !== 'shop') {
        deny(player, 'shop_only');
        return;
      }
      changeGear(player, rules.buy(player.gear, id));
    },
    train(socket, id) {
      const player = room.bySocket.get(socket);
      if (!player || player.mode !== 'play') return;
      if (room.state !== 'shop') {
        deny(player, 'shop_only');
        return;
      }
      changeGear(player, rules.train(player.gear, id));
    },
    equip(socket, id) {
      const player = room.bySocket.get(socket);
      if (!player || player.mode !== 'play') return;
      if (room.state !== 'shop') {
        deny(player, 'shop_only');
        return;
      }
      changeGear(player, rules.equip(player.gear, id));
    },
    unequip(socket, slot) {
      const player = room.bySocket.get(socket);
      if (!player || player.mode !== 'play') return;
      if (room.state !== 'shop') {
        deny(player, 'shop_only');
        return;
      }
      changeGear(player, rules.unequip(player.gear, slot));
    },
    buyItem(socket, id) {
      const player = room.bySocket.get(socket);
      if (!player || player.mode !== 'play') return;
      if (room.state !== 'shop') {
        deny(player, 'shop_only');
        return;
      }
      changeGear(player, rules.buyItem(player.gear, id));
    },
    reset(socket) {
      const player = room.bySocket.get(socket);
      if (!player || player.mode !== 'play' || room.state !== 'play') return;
      if (!rules.spendItem(player.gear, 'reset')) {
        deny(player, 'no_card');
        return;
      }
      const spot = player.checkpoint || { x: player.x, y: player.y, hp: player.hp, shield: player.shield };
      player.x = spot.x;
      player.y = spot.y;
      player.vx = 0;
      player.vy = 0;
      player.hp = spot.hp;
      player.shield = spot.shield;
      player.iframes = 0;
      player.dashLeft = 0;
      player.dashCd = 0;
      player.rec = [];
      room.events.push({ type: 'reset', id: player.id, x: player.x, y: player.y });
    },
    ready(socket) {
      const player = room.bySocket.get(socket);
      if (!player || player.mode !== 'play' || room.state !== 'shop') return;
      player.ready = true;
    },
    debugCoins(playerName, amount) {
      for (const player of room.players.values()) {
        if (player.name === playerName) player.gear.t = amount;
      }
    },
    debugGrantItem(playerName, id, count) {
      if (!rules.ITEMS[id]) return;
      for (const player of room.players.values()) {
        if (player.name !== playerName) continue;
        player.gear.bag.push({ kind: 'card', id: id, count: Math.max(1, count | 0) });
      }
    },
    debugForge(playerName, spec) {
      const forced = spec || {};
      for (const player of room.players.values()) {
        if (player.name !== playerName) continue;
        const item = rules.rollPiece((forced.seed || 1) >>> 0, forced);
        if (forced.samples) item.samples = forced.samples;
        player.gear.equipped[item.slot] = item;
        syncVitals(player, true);
      }
    },
    requestStart(socket) {
      if (!room.bySocket.has(socket)) return;
      if (room.state === 'play' || room.state === 'shop') return;
      room.mode = 'free';
      room.stageId = 0;
      beginMatch();
    },
    campaign(socket, stageId) {
      if (!room.bySocket.has(socket)) return;
      if (room.state === 'play' || room.state === 'shop') return;
      const stage = rules.stageById(stageId | 0);
      if (!stage) return;
      for (const player of room.players.values()) {
        const profile = loadProfile(player.name);
        if ((profile.unlocked || 1) < stage.id) {
          deny(player, 'locked');
          return;
        }
      }
      room.mode = 'campaign';
      room.stageId = stage.id;
      beginMatch();
    },
    backToLobby(socket) {
      if (!room.bySocket.has(socket)) return;
      if (room.state === 'play' || room.state === 'shop') return;
      room.state = 'lobby';
      room.mode = 'free';
      room.monsters = [];
      room.shots = [];
      room.drops = [];
      room.walls = [];
      broadcast();
    },
    acceptQuest(socket, id) {
      const player = room.bySocket.get(socket);
      if (!player) return;
      player.profile = player.profile || loadProfile(player.name);
      const result = rules.acceptQuest(player.profile, id, todayKey());
      if (!result.ok) deny(player, result.reason);
    },
    turnIn(socket, id) {
      const player = room.bySocket.get(socket);
      if (!player) return;
      player.profile = player.profile || loadProfile(player.name);
      const wallet = room.mode === 'campaign' && player.gear ? player.gear : player.profile.gear;
      const result = rules.turnInQuest(player.profile, id, todayKey(), wallet);
      if (!result.ok) {
        deny(player, result.reason);
        return;
      }
      if (room.mode === 'campaign' && player.gear) remember(player);
      syncVitals(player, false);
      room.events.push({ type: 'turnin', id: player.id, quest: id });
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
    const asset = /^\/assets\/([a-z0-9_-]+\.png)$/.exec(url.pathname);
    if (asset) {
      const filePath = path.join(__dirname, 'assets', asset[1]);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(filePath));
      return;
    }
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
      else if (msg.type === 'role') room.role(socket, msg.id);
      else if (msg.type === 'input') room.input(socket, msg);
      else if (msg.type === 'start') room.requestStart(socket);
      else if (msg.type === 'campaign') room.campaign(socket, msg.stage);
      else if (msg.type === 'accept') room.acceptQuest(socket, msg.id);
      else if (msg.type === 'turnin') room.turnIn(socket, msg.id);
      else if (msg.type === 'lobby') room.backToLobby(socket);
      else if (msg.type === 'dash') room.dash(socket);
      else if (msg.type === 'buy') room.buy(socket, msg.id);
      else if (msg.type === 'buyItem') room.buyItem(socket, msg.id);
      else if (msg.type === 'reset') room.reset(socket);
      else if (msg.type === 'train') room.train(socket, msg.id);
      else if (msg.type === 'equip') room.equip(socket, msg.id);
      else if (msg.type === 'unequip') room.unequip(socket, msg.slot);
      else if (msg.type === 'ready') room.ready(socket);
    });
    socket.on('close', () => room.leave(socket));
  });

  return {
    tickAll,
    debugCoins(roomName, playerName, amount) {
      if (!options.testGrant) throw new Error('debug coins are off');
      const room = rooms.get(roomName);
      if (!room) throw new Error('no room');
      room.debugCoins(playerName, amount);
    },
    debugGrantItem(roomName, playerName, id, count) {
      if (!options.testGrant) throw new Error('debug items are off');
      const room = rooms.get(roomName);
      if (!room) throw new Error('no room');
      room.debugGrantItem(playerName, id, count);
    },
    debugForge(roomName, playerName, spec) {
      if (!options.testGrant) throw new Error('debug forge is off');
      const room = rooms.get(roomName);
      if (!room) throw new Error('no room');
      room.debugForge(playerName, spec);
    },
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
