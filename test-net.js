const { createApp } = require('./server');
const { WebSocket } = require('ws');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function openClient(port, room, name, role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?room=' + room);
    const client = { ws, last: null };
    ws.on('message', (buf) => { client.last = JSON.parse(buf.toString()); });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', name, role: role || '' }));
      resolve(client);
    });
    ws.on('error', reject);
  });
}

function send(client, msg) {
  client.ws.send(JSON.stringify(msg));
}

function me(snap) {
  return snap.players.find((player) => player.id === snap.you);
}

function other(snap) {
  return snap.players.find((player) => player.id !== snap.you);
}

async function waitFor(client, pred, label) {
  const start = Date.now();
  while (Date.now() - start < 2000) {
    if (client.last && pred(client.last)) return client.last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timeout ' + label + ' ' + JSON.stringify(client.last && {
    state: client.last.state,
    players: client.last.players && client.last.players.length,
  }));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function leaveShop(app, clients, round) {
  const rules = require('./shared');
  await waitFor(clients[0], (snap) => snap.state === 'shop', 'enter shop');
  for (let i = 0; i < clients.length; i++) send(clients[i], { type: 'ready' });
  await flush();
  const left = clients[0].last.shopLeft;
  const threshold = rules.SHOP_STEPS - rules.SHOP_MIN;
  const need = left > threshold ? left - threshold : 1;
  for (let i = 0; i < need; i++) app.tickAll();
  await waitFor(clients[0], (snap) => snap.state === 'play' && snap.round === round, 'left the shop for round ' + round);
}

async function main() {
  const app = createApp({ autoTick: false, testGrant: true });
  const port = await app.listen(0);
  try {
    await testMoveAndStars(app, port);
    await testGrace(app, port);
    await testPaths(app, port);
    await testGear(app, port);
    await testItems(app, port);
    await testCampaign(app, port);
    await testRoles(app, port);
    console.log('net rules ok');
  } finally {
    await app.close();
  }
}

async function testMoveAndStars(app, port) {
  const a = await openClient(port, 'move', '甲');
  const b = await openClient(port, 'move', '乙');
  await waitFor(a, (snap) => snap.players.length === 2, 'lobby a');
  await waitFor(b, (snap) => snap.players.length === 2, 'lobby b');
  assert(Math.abs(me(a.last).x - other(a.last).x) > 20, 'lobby spawns are separated');
  send(a, { type: 'start' });
  await waitFor(a, (snap) => snap.state === 'play' && snap.round === 1 && snap.grace === false, 'start');
  await waitFor(b, (snap) => snap.state === 'play', 'start b');
  assert(a.last.stars.length === 2, 'round 1 has two stars');
  assert(JSON.stringify(a.last.stars) === JSON.stringify(b.last.stars), 'stars match');
  for (const star of a.last.stars) {
    const d = Math.hypot(star.x - 480, star.y - 270);
    assert(d > 60 && d < 210, 'opening stars stay nearby, saw ' + d);
  }
  send(a, { type: 'input', ax: 1, ay: 0, mouse: null, keyboard: true });
  send(b, { type: 'input', ax: -1, ay: 0, mouse: null, keyboard: true });
  await flush();
  for (let i = 0; i < 30; i++) app.tickAll();
  await flush();
  assert(me(a.last).x > 530, 'local player moved right');
  assert(me(b.last).x < 430, 'second player moved left');
  assert(other(a.last).x === me(b.last).x && other(b.last).x === me(a.last).x, 'both clients see the same positions');
  assert(me(a.last).mode === 'play' && me(b.last).mode === 'play', 'bodies do not kill each other');
  send(a, { type: 'input', ax: 0, ay: 0, mouse: null, keyboard: false });
  send(b, { type: 'input', ax: 0, ay: 0, mouse: null, keyboard: false });
  await flush();
  for (let i = 0; i < 40; i++) app.tickAll();
  await flush();
  const star = a.last.stars.slice().sort((p, q) => Math.hypot(p.x - me(a.last).x, p.y - me(a.last).y) - Math.hypot(q.x - me(a.last).x, q.y - me(a.last).y))[0];
  send(a, { type: 'input', ax: 0, ay: 0, mouse: { x: star.x, y: star.y }, keyboard: false });
  await flush();
  const before = me(b.last).score;
  for (let i = 0; i < 120; i++) app.tickAll();
  await flush();
  assert(me(a.last).score > before, 'first player to the star scores');
  assert(me(b.last).score === before, 'the player who stayed did not score');
  assert(other(b.last).score === me(a.last).score, 'the score is on both clients');
  a.ws.close();
  b.ws.close();
  await flush();
}

async function testGrace(app, port) {
  const a = await openClient(port, 'grace', '甲');
  const b = await openClient(port, 'grace', '乙');
  await waitFor(b, (snap) => snap.players.length === 2, 'grace lobby');
  send(a, { type: 'start' });
  await waitFor(a, (snap) => snap.state === 'play', 'grace start');
  for (let i = 0; i < 360; i++) {
    app.tickAll();
    if (i === 29) {
      await flush();
      assert(a.last.round === 1 && a.last.t === 29 && a.last.grace === false, 'round 1 has no grace flag');
      assert(a.last.grace === (a.last.ghosts.length > 0 && a.last.t < 60), 'grace matches the shared predicate');
    }
  }
  await waitFor(a, (snap) => snap.state === 'shop', 'shop after the first round');
  await waitFor(b, (snap) => snap.state === 'shop', 'shop reaches the other client');
  assert(a.last.coins >= 8 && b.last.coins >= 8, 'clearing a round pays T, saw ' + a.last.coins);
  await leaveShop(app, [a, b], 2);
  await waitFor(b, (snap) => snap.round === 2 && snap.grace === true, 'server raises grace when the echo appears');
  assert(a.last.grace === true && b.last.grace === true, 'server raises grace when the echo appears');
  assert(a.last.ghosts.length === 2 && a.last.ghosts[0].pts.length === 360, 'both full routes are committed');
  for (let i = 0; i < 60; i++) {
    app.tickAll();
    if (i === 59) {
      await waitFor(a, (snap) => snap.round === 2 && snap.t === 59 && snap.grace === true, 'tick 59 is still protected');
      await waitFor(b, (snap) => snap.round === 2 && snap.t === 59, 'tick 59 peer');
      assert(me(a.last).mode === 'play' && me(b.last).mode === 'play', 'overlap during grace is not death');
    }
  }
  app.tickAll();
  await waitFor(a, (snap) => snap.round === 2 && snap.t === 60 && snap.grace === false, 'protection ends on step 60');
  await waitFor(b, (snap) => snap.t === 60, 'protection ends peer');
  assert(me(a.last).mode === 'dead' && me(b.last).mode === 'dead', 'standing on an echo dies when grace ends');
  assert(a.last.state === 'over', 'the match ends when nobody is left');
  const death = a.last.events.find((event) => event.type === 'die' && event.id === a.last.you);
  assert(death && death.self === true, 'own echo is named when both overlap');
  a.ws.close();
  b.ws.close();
  await flush();
}

async function testPaths(app, port) {
  const a = await openClient(port, 'paths', '甲');
  const b = await openClient(port, 'paths', '乙');
  await waitFor(b, (snap) => snap.players.length === 2, 'path lobby');
  send(a, { type: 'start' });
  await waitFor(a, (snap) => snap.state === 'play', 'path start');
  send(a, { type: 'input', ax: 1, ay: 0, mouse: null, keyboard: true });
  send(b, { type: 'input', ax: 0, ay: 0, mouse: null, keyboard: false });
  await flush();
  for (let i = 0; i < 360; i++) app.tickAll();
  await leaveShop(app, [a, b], 2);
  assert(JSON.stringify(a.last.ghosts) === JSON.stringify(b.last.ghosts), 'echo routes match on both clients');
  assert(a.last.ghosts.length === 2, 'each finished route became an echo, saw ' + a.last.ghosts.length);
  const moving = a.last.ghosts.find((ghost) => ghost.ownerId === a.last.you);
  const still = a.last.ghosts.find((ghost) => ghost.ownerId !== a.last.you);
  assert(moving.pts[0].x < moving.pts[moving.pts.length - 1].x - 100, 'moving echo records the run');
  assert(Math.abs(still.pts[0].x - still.pts[still.pts.length - 1].x) < 0.01, 'still echo stays put');
  for (let i = 0; i < 61; i++) app.tickAll();
  await waitFor(a, (snap) => snap.round === 2 && snap.t === 60, 'path grace over');
  await waitFor(b, (snap) => snap.round === 2 && snap.t === 60, 'path grace over b');
  assert(a.last.grace === false && a.last.t === 60, 'shared clock left grace together');
  assert(me(b.last).mode === 'dead' && me(a.last).mode === 'play', 'only the player on an echo dies');
  assert(b.last.state === 'play', 'the survivor keeps the round going');
  const hints = a.last.ghosts.map((ghost) => ghost.pts[0]);
  assert(JSON.stringify(hints) === JSON.stringify(b.last.ghosts.map((ghost) => ghost.pts[0])), 'restart points match');
  a.ws.close();
  b.ws.close();
  await flush();
}

async function testGear(app, port) {
  const rules = require('./shared');
  const seen = [];
  rules.setNamer((ctx) => {
    seen.push(ctx.noun);
    return '测试·' + ctx.noun + (ctx.core ? '·' + ctx.core : '');
  });
  const boots = rules.rollPiece(42, { primary: 'speed', extra: null, core: null, negative: null });
  const again = rules.rollPiece(42, { primary: 'speed', extra: null, core: null, negative: null });
  assert(boots.name === '测试·注意力靴' && again.uid === boots.uid, 'the same seed asks the namer for the same piece');
  assert(boots.price === 8 && seen[0] === '注意力靴', 'a clean speed affix is the 8T stipend piece');
  rules.setNamer(null);
  const named = rules.rollPiece(42, { primary: 'speed', extra: null, core: 'predict', negative: 'hallucination' });
  assert(named.name.indexOf('注意力靴') >= 0 && named.name.indexOf('预判核') >= 0, 'the local lexicon names the noun and the core');
  assert(named.price === 13, 'a core raises the price and hallucination refunds some of it');

  const rackA = rules.emptyGear();
  const rackB = rules.emptyGear();
  rules.openStock(rackA, 99, 1, 'p1');
  rules.openStock(rackB, 99, 1, 'p2');
  assert(rackA.stock[0].price === 8 && rackA.stock[0].affixes.length === 1 && !rackA.stock[0].core, 'the first offer is always affordable');
  assert(rackA.stock[1].uid !== rackB.stock[1].uid, 'each player gets a private rack');
  rackA.t = 8;
  assert(rules.buy(rackA, rackA.stock[0].uid).ok, 'buying takes the generated uid');
  const worn = rackA.equipped.head || rackA.equipped.body || rackA.equipped.accessory;
  assert(worn && worn.tier === 0, 'an empty slot auto-equips the v1 piece');
  rackA.t = 18;
  assert(rules.train(rackA, worn.uid).reason === 'need_samples', 'training needs match samples');
  worn.samples = 1;
  assert(rules.train(rackA, worn.uid).ok && worn.tier === 1, 'one sample and 18T trains v1 into v2');
  const speedOnly = rules.emptyGear();
  speedOnly.equipped.body = rules.rollPiece(7, { primary: 'speed', extra: null, core: null, negative: null, tier: 3 });
  assert(rules.statsOf(speedOnly).speed === 1.55, 'frontier speed is +55%');
  const coreGear = rules.emptyGear();
  coreGear.equipped.body = rules.rollPiece(8, { primary: 'speed', extra: null, core: 'predict', negative: null });
  assert(rules.statsOf(coreGear).reward === 1.5 && rules.statsOf(coreGear).core.kind === 'predict', 'a predict core pays more');
  const ahead = rules.echoAt(
    [{ x: 100, y: 100 }, { x: 110, y: 100 }],
    0,
    { x: 80, y: 100, vx: 100, vy: 0, core: { kind: 'predict', lead: 40 }, w: 960, h: 540 },
  );
  assert(ahead.x > 120 && ahead.baseX === 100, 'predict core leads the echo along velocity');
  const aside = rules.echoAt(
    [{ x: 100, y: 100 }],
    0,
    { x: 100, y: 160, vx: 0, vy: 0, core: { kind: 'evade', dodge: 40 }, w: 960, h: 540 },
  );
  assert(Math.hypot(aside.x - 100, aside.y - 100) > 10, 'evade core steps off the recorded point');
  const bagGear = rules.emptyGear();
  bagGear.t = 100;
  rules.openStock(bagGear, 3, 1, 'bag');
  const first = bagGear.stock[0];
  const twin = rules.rollPiece(first.seed, { primary: first.affixes[0], extra: null, core: null, negative: null });
  bagGear.equipped[first.slot] = twin;
  assert(rules.buy(bagGear, first.uid).ok && bagGear.bag.length === 1, 'a filled slot parks the new piece in the bag');
  assert(rules.equip(bagGear, bagGear.bag[0].uid).ok, 'equip swaps by uid');

  const a = await openClient(port, 'gear', '甲');
  const b = await openClient(port, 'gear', '乙');
  await waitFor(b, (snap) => snap.players.length === 2, 'gear lobby');
  send(a, { type: 'start' });
  await waitFor(a, (snap) => snap.state === 'play', 'gear start');
  send(a, { type: 'buy', id: 'nope' });
  await flush();
  app.tickAll();
  await flush();
  assert(!(me(a.last).gear || []).length, 'play rejects a purchase');
  for (let i = 0; i < 360; i++) app.tickAll();
  await waitFor(a, (snap) => snap.state === 'shop' && (snap.offers || []).length === 3, 'gear shop');
  await waitFor(b, (snap) => snap.state === 'shop' && (snap.offers || []).length === 3, 'gear shop for the other player');
  assert(a.last.offers[0].price === 8 && a.last.offers[0].tierLabel === 'v1', 'server rack starts with a v1 stipend piece');
  assert(a.last.offers[1].uid !== b.last.offers[1].uid, 'the two racks are not the same');
  const offer = a.last.offers[0];
  send(a, { type: 'buy', id: offer.uid });
  await flush();
  app.tickAll();
  await waitFor(a, (snap) => (me(snap).gear || []).some((item) => item.uid === offer.uid), 'bought the generated piece');
  const seenByB = (other(b.last).gear || []).map((item) => item.name);
  assert(seenByB.indexOf(offer.name) >= 0, 'the other client sees the generated name');
  app.debugForge('gear', '甲', { seed: 11, primary: 'speed', extra: null, core: null, negative: null, tier: 0, samples: 1 });
  app.debugForge('gear', '乙', { seed: 12, primary: 'dash', extra: null, core: null, negative: null, tier: 0 });
  app.debugCoins('gear', '甲', 40);
  app.tickAll();
  await waitFor(a, (snap) => (me(snap).gear || []).some((item) => (item.affixes || []).indexOf('speed') >= 0), 'forged speed');
  const speedUid = me(a.last).gear.filter((item) => item.affixes.indexOf('speed') >= 0)[0].uid;
  send(a, { type: 'train', id: speedUid });
  await flush();
  app.tickAll();
  await waitFor(a, (snap) => (me(snap).gear || []).some((item) => item.uid === speedUid && item.tierLabel === 'v2'), 'training advances a generation');
  await leaveShop(app, [a, b], 2);
  send(a, { type: 'input', ax: 1, ay: 0, mouse: null, keyboard: true });
  send(b, { type: 'input', ax: 1, ay: 0, mouse: null, keyboard: true });
  await flush();
  const x0 = me(a.last).x;
  const y0 = me(b.last).x;
  for (let i = 0; i < 40; i++) app.tickAll();
  await flush();
  assert(me(a.last).x - x0 > me(b.last).x - y0 + 15, 'trained speed affix is faster than bare feet');
  send(b, { type: 'dash' });
  await flush();
  const before = me(b.last).x;
  for (let i = 0; i < 6; i++) app.tickAll();
  await flush();
  assert(me(b.last).x - before > 40, 'dash affix actually bursts forward');
  send(a, { type: 'input', ax: 0, ay: 0, mouse: null, keyboard: false });
  send(b, { type: 'input', ax: 0, ay: 0, mouse: null, keyboard: false });
  await flush();
  for (let i = 0; i < 360; i++) app.tickAll();
  await waitFor(a, (snap) => snap.state === 'shop' || snap.state === 'over' || (snap.round === 2 && snap.t > 60), 'after dash round');
  a.ws.close();
  b.ws.close();
  await flush();

  const c = await openClient(port, 'guard', '甲');
  const d = await openClient(port, 'guard', '乙');
  await waitFor(d, (snap) => snap.players.length === 2, 'guard lobby');
  send(c, { type: 'start' });
  await waitFor(c, (snap) => snap.state === 'play', 'guard start');
  for (let i = 0; i < 360; i++) app.tickAll();
  await waitFor(c, (snap) => snap.state === 'shop', 'guard shop');
  app.debugForge('guard', '甲', { seed: 21, primary: 'shield', extra: null, core: null, negative: null });
  app.debugForge('guard', '乙', { seed: 22, primary: 'hp', extra: null, core: null, negative: null });
  app.tickAll();
  await waitFor(c, (snap) => me(snap).shield === 1, 'shield armed');
  await waitFor(d, (snap) => me(snap).hp === 2, 'helm hp');
  assert(me(c.last).shield === 1 && me(d.last).hp === 2, 'shop fills shield charges and parameter hp');
  await leaveShop(app, [c, d], 2);
  for (let i = 0; i < 61; i++) app.tickAll();
  await waitFor(c, (snap) => snap.t === 60, 'guard grace over');
  assert(me(c.last).mode === 'play' && me(c.last).shield === 0, 'shield spends one charge instead of dying');
  assert(me(d.last).mode === 'play' && me(d.last).hp === 1, 'parameter helm spends a hit point instead of dying');
  for (let i = 0; i < rules.IFRAMES + 2; i++) app.tickAll();
  await flush();
  assert(me(c.last).mode === 'dead' && me(d.last).mode === 'dead', 'a second overlap after the grace frames is fatal');
  c.ws.close();
  d.ws.close();
  await flush();
}

async function testItems(app, port) {
  const rules = require('./shared');
  const gear = rules.emptyGear();
  gear.t = 10;
  assert(rules.buyItem(gear, 'reset').ok && rules.countItem(gear, 'reset') === 1, 'reset card takes one bag stack');
  assert(gear.t === 0, 'the card is paid from the same balance');
  assert(rules.spendItem(gear, 'reset') && rules.countItem(gear, 'reset') === 0, 'one use consumes one card');
  const core = rules.emptyGear();
  core.t = 2;
  core.equipped.body = rules.rollPiece(4, { primary: 'speed', extra: null, core: 'predict', negative: null });
  const stats = rules.statsOf(core);
  assert(rules.tickDrain(core, stats, 45) === 1 && core.t === 1, 'a worn core spends one token every 45 steps');
  assert(rules.poweredStats(core).reward === 1.5, 'the last token still powers inference');
  assert(rules.tickDrain(core, stats, 90) === 1 && core.t === 0, 'the next interval spends the last token');
  assert(!rules.poweredStats(core).core && rules.poweredStats(core).reward === 1, 'an empty balance pauses the core');
  assert(!rules.payDash(core), 'a dash cannot fire without tokens');

  const a = await openClient(port, 'items', '甲');
  const b = await openClient(port, 'items', '乙');
  await waitFor(b, (snap) => snap.players.length === 2, 'items lobby');
  send(a, { type: 'start' });
  await waitFor(a, (snap) => snap.state === 'play', 'items start');
  app.debugGrantItem('items', '甲', 'reset', 1);
  app.tickAll();
  await waitFor(a, (snap) => (snap.bag || []).some((item) => item.kind === 'card' && item.id === 'reset' && item.count === 1), 'card synced');
  send(a, { type: 'input', ax: 1, ay: 0, mouse: null, keyboard: true });
  send(b, { type: 'input', ax: -1, ay: 0, mouse: null, keyboard: true });
  await flush();
  for (let i = 0; i < 30; i++) app.tickAll();
  await flush();
  const moved = me(a.last).x;
  const t0 = a.last.t;
  const score = me(a.last).score;
  assert(moved > 520, '甲 walked away from the checkpoint, saw ' + moved);
  send(a, { type: 'input', ax: 0, ay: 0, mouse: null, keyboard: false });
  send(a, { type: 'reset' });
  await flush();
  app.tickAll();
  await waitFor(a, (snap) => Math.abs(me(snap).x - rules.W / 2) < 30, 'reset returns 甲 to the round start');
  assert(me(b.last).x < 440, '乙 stays where 乙 walked');
  assert(a.last.t === t0 + 1, 'the shared clock is not rewound');
  assert(me(a.last).score === score, 'score stays');
  assert(!(a.last.bag || []).some((item) => item.kind === 'card' && item.count > 0), 'the card is consumed');
  assert(a.last.ghosts.length === b.last.ghosts.length, 'echoes are still shared');
  send(a, { type: 'reset' });
  await flush();
  app.tickAll();
  await flush();
  assert((a.last.events || []).some((ev) => ev.reason === 'no_card'), 'a second reset needs another card');
  a.ws.close();
  b.ws.close();
  await flush();
}

async function testCampaign(app, port) {
  const rules = require('./shared');
  assert(rules.xpToNext(1) === 10 && rules.xpToNext(2) === 16 && rules.xpToNext(20) === 0, 'xp curve follows 10+5(n-1)+(n-1)^2');
  let total = 0;
  for (let level = 1; level < 20; level++) total += rules.xpToNext(level);
  assert(total === 3154, 'reaching Lv20 costs 3154 xp, saw ' + total);
  const waveA = rules.spawnWave(rules.stageById(1), 1, 7);
  const waveB = rules.spawnWave(rules.stageById(1), 1, 7);
  assert(waveA.length === 2 && waveA[0].kind === 'patrol' && waveA[0].x === waveB[0].x, 'stage 1 wave is seeded');
  const fighter = { id: 'solo', x: waveA[0].x, y: waveA[0].y, hp: 3, iframes: 0, r: 12, dashHits: {}, mode: 'play' };
  const pack = JSON.parse(JSON.stringify(waveA));
  rules.fightMonsters(fighter, pack, [], true);
  assert(pack[0].hp === 0 && fighter.hp === 3, 'a dash hits the monster and not the player');
  assert(pack[1].hp === 1, 'the dash does not splash onto the other monster');
  const slime = { id: 's', kind: 'slime', name: '分裂泥', x: 100, y: 100, hp: 0, maxHp: 2, r: 13, color: '#7affd4', xp: 3, token: 2, drop: 0, baby: false };
  const nest = [slime];
  const reaped = rules.reapMonsters(nest, 1, 1);
  assert(reaped.killed.length === 1 && nest.length === 2 && nest.every((mon) => mon.name === '小泥'), 'slime splits into two babies');
  const profile = rules.freshProfile();
  const today = '2026-10-13';
  assert(rules.acceptQuest(profile, 'eat-stars', today).ok, 'a daily quest can be accepted');
  rules.bumpQuest(profile, 'stars', 20, null, today);
  assert(profile.quests['eat-stars'].status === 'done', 'twenty stars finish the quest');
  assert(rules.turnInQuest(profile, 'eat-stars', today, profile.gear).ok && profile.gear.t === 20, 'turning it in pays tokens');
  assert(!rules.turnInQuest(profile, 'eat-stars', today, profile.gear).ok, 'a turned-in quest cannot be turned in again');
  const flawless = rules.freshProfile();
  rules.acceptQuest(flawless, 'flawless', today);
  rules.bumpQuest(flawless, 'flawless', 1, null, today);
  assert(rules.turnInQuest(flawless, 'flawless', today, flawless.gear).ok && rules.countItem(flawless.gear, 'reset') === 1, 'a flawless clear pays a reset card');
  assert(flawless.gear.t === 0, 'the quest card is not bought with tokens');
  assert(rules.stageById(5).boss && rules.MONSTERS.king.name === '回声王' && rules.MONSTERS.king.hp === 10, 'stage 5 keeps the echo king');
  assert(rules.starGoal(1, rules.stageById(1)) === 2 && rules.stageEcho(rules.stageById(1), 1) === null, 'stage 1 stays slow');
  assert(rules.stageEcho(rules.stageById(3), 1).kind === 'predict', 'later stages raise the echo');

  const a = await openClient(port, 'camp', '闯甲');
  const b = await openClient(port, 'camp', '闯乙');
  await waitFor(b, (snap) => snap.players.length === 2 && (snap.quests || []).length === 5, 'campaign lobby');
  send(a, { type: 'campaign', stage: 2 });
  await flush();
  app.tickAll();
  await flush();
  assert((a.last.events || []).some((ev) => ev.reason === 'locked'), 'stage 2 is locked until stage 1 is cleared');
  assert(a.last.state !== 'play', 'a locked stage does not start');
  send(a, { type: 'accept', id: 'kill-8' });
  await flush();
  app.tickAll();
  await flush();
  const mine = (a.last.quests || []).find((quest) => quest.id === 'kill-8');
  const theirs = (b.last.quests || []).find((quest) => quest.id === 'kill-8');
  assert(mine && mine.status === 'accepted', 'the acceptor sees the quest');
  assert(theirs && theirs.status === 'open', 'the other player keeps their own quest log');
  send(a, { type: 'campaign', stage: 1 });
  await waitFor(a, (snap) => snap.state === 'play' && snap.mode === 'campaign' && snap.stageName === '训练场', 'campaign start');
  await waitFor(b, (snap) => snap.mode === 'campaign' && snap.monsters.length === 2, 'peer sees the wave');
  assert(JSON.stringify(a.last.monsters.map((mon) => [mon.x, mon.y, mon.hp])) === JSON.stringify(b.last.monsters.map((mon) => [mon.x, mon.y, mon.hp])), 'both clients share the monsters');
  assert(me(a.last).hp === 3 && me(a.last).maxHp === 3, 'campaign hearts are 3');
  assert(a.last.ghosts.length === 0, 'round 1 has not drawn an echo yet');
  send(a, { type: 'dash' });
  await flush();
  for (let i = 0; i < 4; i++) app.tickAll();
  await flush();
  assert(me(a.last).mode === 'play' && me(a.last).hp === 3, 'the opening dash does not spend a heart');
  a.ws.close();
  b.ws.close();
  await flush();
}

async function testRoles(app, port) {
  const rules = require('./shared');
  const fs = require('fs');
  const whale = rules.roleById('whale');
  const echo = rules.roleById('echo');
  assert(whale && whale.name === '巨鲸' && whale.sheet === 'assets/sperm_whale_sheet_1x.png', 'the whale is a config row');
  assert(echo && !echo.sheet && echo.slots.join(',') === 'head,body,accessory', 'the original body keeps every slot');
  assert(whale.slots.join(',') === 'head,body,accessory', 'the whale can wear head, body, and accessory');
  assert(rules.SPRITE.frame === 48 && rules.SPRITE.cols === 6 && rules.SPRITE.rows === 4, 'sheet is 6 by 4 frames');
  assert(rules.SPRITE.idle === 2 && rules.SPRITE.walk === 4, 'two idle frames then four walk frames');
  assert(rules.SPRITE.footX === 24 && rules.SPRITE.footY === 46, 'the foot stays at (24, 46)');
  assert(rules.SPRITE.dirs.join(',') === 'down,left,right,up', 'rows run down, left, right, up');
  const png = fs.readFileSync(require('path').join(__dirname, 'assets/sperm_whale_sheet_1x.png'));
  assert(png.readUInt32BE(16) === 288 && png.readUInt32BE(20) === 192, 'the sheet is 288 by 192');

  const a = await openClient(port, 'cast', '鲸甲', 'whale');
  const b = await openClient(port, 'cast', '鲸乙', 'echo');
  await waitFor(a, (snap) => snap.players.length === 2 && me(snap).role === 'whale', 'whale joined');
  await waitFor(b, (snap) => me(snap).role === 'echo' && other(snap).role === 'whale', 'peer sees the whale');
  assert(other(a.last).role === 'echo', '甲 sees 乙 as the original body');
  send(a, { type: 'role', id: 'nope' });
  await flush();
  app.tickAll();
  await flush();
  assert(me(a.last).role === 'whale', 'an unknown role is ignored');
  assert((a.last.events || []).some((ev) => ev.reason === 'role'), 'unknown role is denied');
  send(b, { type: 'role', id: 'whale' });
  await flush();
  app.tickAll();
  await waitFor(a, (snap) => other(snap).role === 'whale' && me(snap).role === 'whale', '乙 switched and both clients agree');
  a.ws.close();
  b.ws.close();
  await flush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
