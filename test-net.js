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

async function main() {
  const app = createApp({ autoTick: false });
  const port = await app.listen(0);
  try {
    await testMoveAndStars(app, port);
    await testGrace(app, port);
    await testPaths(app, port);
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
  await waitFor(a, (snap) => snap.round === 2 && snap.t === 0 && snap.step === 0, 'round rolls over at t=0');
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
  await waitFor(a, (snap) => snap.round === 2 && snap.t === 0, 'path round 2');
  await waitFor(b, (snap) => snap.round === 2 && snap.t === 0, 'path round 2 b');
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
