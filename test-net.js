const { createApp } = require('./server');
const { WebSocket } = require('ws');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function openClient(port, room, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws?room=' + room);
    const client = { ws, last: null };
    ws.on('message', (buf) => { client.last = JSON.parse(buf.toString()); });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', name }));
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
  const gear = rules.emptyGear();
  gear.t = 8;
  assert(rules.buy(gear, 'boots').ok, 'boots fit the round stipend');
  assert(gear.equipped.body.id === 'boots' && gear.equipped.body.level === 1, 'empty body slot auto-equips');
  assert(!rules.upgrade(gear, 'boots').ok, 'level 2 costs more than the leftover');
  gear.t = 16;
  assert(rules.upgrade(gear, 'boots').ok && gear.equipped.body.level === 2, 'level 2');
  gear.t = 24;
  assert(rules.upgrade(gear, 'boots').ok && gear.equipped.body.level === 3, 'level 3');
  assert(rules.upgrade(gear, 'boots').reason === 'max_level', 'cap is 3');
  assert(rules.statsOf(gear).speed === 1.55, 'boots change speed');
  gear.t = 100;
  assert(rules.buy(gear, 'helm').ok, 'helm takes the head slot');
  assert(rules.buy(gear, 'glasses').ok && gear.bag.some((item) => item.id === 'glasses'), 'second head item waits in the bag');
  assert(rules.equip(gear, 'glasses').ok && gear.equipped.head.id === 'glasses', 'equip swaps the head slot');
  assert(gear.bag.some((item) => item.id === 'helm'), 'previous head piece returns to the bag');
  assert(rules.statsOf(gear).warn === 130 && rules.statsOf(gear).maxHp === 1, 'only the worn piece applies');
  assert(rules.equip(gear, 'helm').ok && rules.statsOf(gear).maxHp === 2, 'helm adds a hit point');

  const a = await openClient(port, 'gear', '甲');
  const b = await openClient(port, 'gear', '乙');
  await waitFor(b, (snap) => snap.players.length === 2, 'gear lobby');
  send(a, { type: 'start' });
  await waitFor(a, (snap) => snap.state === 'play', 'gear start');
  send(a, { type: 'buy', id: 'boots' });
  await flush();
  app.tickAll();
  await flush();
  assert(a.last.coins === 0 && !(a.last.players.find((p) => p.id === a.last.you).gear || []).length, 'play rejects a purchase');
  for (let i = 0; i < 360; i++) app.tickAll();
  await waitFor(a, (snap) => snap.state === 'shop', 'gear shop');
  app.debugCoins('gear', '甲', 80);
  app.debugCoins('gear', '乙', 80);
  app.tickAll();
  await waitFor(a, (snap) => snap.coins === 80, 'granted coins');
  send(a, { type: 'buy', id: 'boots' });
  send(a, { type: 'buy', id: 'helm' });
  send(b, { type: 'buy', id: 'dash' });
  await flush();
  for (let i = 0; i < 3; i++) app.tickAll();
  await waitFor(a, (snap) => (me(snap).gear || []).length === 2, 'both pieces equipped');
  const wornA = me(a.last).gear.map((item) => item.id).sort();
  const seenByB = other(b.last).gear.map((item) => item.id).sort();
  assert(wornA.join() === 'boots,helm', 'server equipped both open slots, saw ' + wornA.join());
  assert(seenByB.join() === wornA.join(), 'the other client sees the worn gear');
  assert(me(a.last).maxHp === 2 && me(a.last).warnAt === 75, 'helm raises hp, glasses are not worn');
  await leaveShop(app, [a, b], 2);
  send(a, { type: 'input', ax: 1, ay: 0, mouse: null, keyboard: true });
  send(b, { type: 'input', ax: 1, ay: 0, mouse: null, keyboard: true });
  await flush();
  const x0 = me(a.last).x;
  const y0 = me(b.last).x;
  for (let i = 0; i < 40; i++) app.tickAll();
  await flush();
  assert(me(a.last).x - x0 > me(b.last).x - y0 + 15, 'boots are faster than bare feet');
  send(b, { type: 'dash' });
  await flush();
  const before = me(b.last).x;
  for (let i = 0; i < 6; i++) app.tickAll();
  await flush();
  assert(me(b.last).x - before > 40, 'dash gloves actually burst forward');
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
  app.debugCoins('guard', '甲', 40);
  app.debugCoins('guard', '乙', 40);
  app.tickAll();
  await waitFor(c, (snap) => snap.coins === 40, 'guard coins');
  send(c, { type: 'buy', id: 'shield' });
  send(d, { type: 'buy', id: 'helm' });
  await flush();
  app.tickAll();
  await waitFor(c, (snap) => me(snap).shield === 1, 'shield armed');
  await waitFor(d, (snap) => me(snap).hp === 2, 'helm hp');
  assert(me(c.last).shield === 1 && me(d.last).hp === 2, 'shop fills shield charges and helm hp');
  await leaveShop(app, [c, d], 2);
  for (let i = 0; i < 61; i++) app.tickAll();
  await waitFor(c, (snap) => snap.t === 60, 'guard grace over');
  assert(me(c.last).mode === 'play' && me(c.last).shield === 0, 'shield spends one charge instead of dying');
  assert(me(d.last).mode === 'play' && me(d.last).hp === 1, 'helm spends a hit point instead of dying');
  for (let i = 0; i < rules.IFRAMES + 2; i++) app.tickAll();
  await flush();
  assert(me(c.last).mode === 'dead' && me(d.last).mode === 'dead', 'a second overlap after the grace frames is fatal');
  c.ws.close();
  d.ws.close();
  await flush();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
