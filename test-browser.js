const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { createApp } = require('./server');

const CHROME = process.env.CHROME || '/usr/local/bin/google-chrome';
const OUT = process.env.ECHO_SHOTS || '/tmp/echo-shots';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function boot(browser, port, name) {
  const page = await browser.newPage();
  for (const extra of await browser.pages()) {
    if (extra !== page) await extra.close();
  }
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.setViewport({ width: 960, height: 540, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:' + port + '/?name=' + encodeURIComponent(name), { waitUntil: 'domcontentloaded', timeout: 10000 });
  return { page, errors };
}

function launch(x) {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: process.env.DISPLAY ? false : 'new',
    protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-fake-ui-for-media-stream', '--window-size=960,700', '--window-position=' + x + ',30'],
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const app = createApp();
  const port = await app.listen(8791);
  const solo = await launch(0);
  try {
    await testSolo(solo, port);
  } finally {
    await solo.close();
  }
  const left = await launch(0);
  const right = await launch(980);
  try {
    await testPair(left, right, port);
    console.log('browser ok');
  } finally {
    await left.close();
    await right.close();
    await app.close();
  }
}

async function testSolo(browser, port) {
  const { page, errors } = await boot(browser, port, '单');
  const menu = await page.evaluate(() => window.__echo());
  assert(menu.state === 'menu', 'solo menu');
  assert(windowActive(await page.evaluate(() => window.__echoNet())) === false, 'solo does not connect by itself');
  await key(page, 'keydown', ' ');
  await until(page, () => window.__echo().state === 'play', 'solo play');
  await key(page, 'keydown', 'ArrowRight');
  await until(page, () => window.__echo().x > 520, 'solo move');
  const moved = await page.evaluate(() => window.__echo());
  assert(moved.W === 960 && moved.H === 540, 'solo arena');
  assert(moved.round === 1 && moved.footDash === false, 'round 1 is not in grace');
  await key(page, 'keyup', 'ArrowRight');
  await key(page, 'keydown', 'ArrowLeft');
  await until(page, () => {
    const e = window.__echo();
    return e.state === 'shop' || (e.round === 2 && e.footDash === true);
  }, 'solo shop', 12000);
  const mid = await page.evaluate(() => window.__echo());
  if (mid.state === 'shop') {
    assert(mid.coins >= 8, 'solo round pays T');
    await page.evaluate(() => window.__echoShop({ act: 'buy', id: 'boots' }));
    const bought = await page.evaluate(() => window.__echo());
    assert(bought.worn.some(g => g.id === 'boots'), 'solo shop equips boots');
    await page.evaluate(() => window.__echoShop({ act: 'ready' }));
  }
  await until(page, () => window.__echo().round === 2 && window.__echo().footDash === true, 'solo grace', 4000);
  const grace = await page.evaluate(() => window.__echo());
  assert(grace.grace > 0 && grace.t < 60, 'solo grace uses the 60-step rule');
  assert(grace.flicker === (Math.floor(grace.t / 2) % 2 === 0 ? 0.5 : 0.15), 'solo flicker follows the step');
  await key(page, 'keyup', 'ArrowLeft');
  assert(!errors.length, 'solo console errors ' + errors.join(' | '));
  await page.close();
}

function windowActive(net) {
  return !!(net && net.active);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// waitForFunction polls through CDP often enough to stall this page.
async function key(page, type, name) {
  await page.evaluate((type, name) => {
    window.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true }));
  }, type, name);
}

async function until(page, pred, label, timeout = 12000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await page.evaluate(pred);
    if (last) return last;
    await sleep(80);
  }
  throw new Error('timeout ' + label + ' ' + JSON.stringify(last));
}

async function testPair(leftBrowser, rightBrowser, port) {
  const left = await boot(leftBrowser, port, '甲');
  const right = await boot(rightBrowser, port, '乙');
  await left.page.evaluate(() => document.getElementById('multi').click());
  await right.page.evaluate(() => document.getElementById('multi').click());
  await until(left.page, () => window.__echoNet().active && window.__echoNet().players.length === 2, 'lobby a');
  await until(right.page, () => window.__echoNet().active && window.__echoNet().players.length === 2, 'lobby b');
  await left.page.screenshot({ path: path.join(OUT, 'lobby-a.png') });
  await right.page.screenshot({ path: path.join(OUT, 'lobby-b.png') });
  await key(left.page, 'keydown', ' ');
  await until(left.page, () => window.__echo().state === 'play' && window.__echo().round === 1, 'play a');
  await until(right.page, () => window.__echo().state === 'play', 'play b');
  const starsA = await left.page.evaluate(() => window.__echo().starPos);
  const starsB = await right.page.evaluate(() => window.__echo().starPos);
  assert(JSON.stringify(starsA) === JSON.stringify(starsB), 'both clients share stars');
  assert(starsA.length === 2, 'two opening stars');
  await key(left.page, 'keydown', 'ArrowRight');
  await key(right.page, 'keydown', 'ArrowLeft');
  await until(left.page, () => window.__echo().x > 620, 'move a', 4000);
  await until(right.page, () => window.__echo().x < 340, 'move b', 4000);
  await left.page.screenshot({ path: path.join(OUT, 'move-a.png') });
  await right.page.screenshot({ path: path.join(OUT, 'move-b.png') });
  const seeA = await left.page.evaluate(() => window.__echoNet().players.map(p => ({ name: p.name, x: Math.round(p.x), mode: p.mode })));
  const seeB = await right.page.evaluate(() => window.__echoNet().players.map(p => ({ name: p.name, x: Math.round(p.x), mode: p.mode })));
  assert(seeA.find(p => p.name === '乙').x < 400, '甲 sees 乙 on the left');
  assert(seeB.find(p => p.name === '甲').x > 560, '乙 sees 甲 on the right');
  await until(left.page, () => {
    const e = window.__echo();
    return e.state === 'shop' || (e.round === 2 && e.footDash && e.grace > 0);
  }, 'shop or grace', 12000);
  const shopping = await left.page.evaluate(() => window.__echo().state === 'shop');
  if (shopping) {
    await left.page.evaluate(() => window.__echoShop({ act: 'buy', id: 'boots' }));
    await right.page.evaluate(() => window.__echoShop({ act: 'ready' }));
    await left.page.evaluate(() => window.__echoShop({ act: 'ready' }));
    await until(right.page, () => {
      const players = window.__echoNet().players;
      return players.some(p => (p.gear || []).some(g => g.id === 'boots'));
    }, 'peer sees boots', 4000);
  }
  await until(left.page, () => {
    const e = window.__echo();
    return e.round === 2 && e.footDash && e.grace > 0 && e.ghosts >= 2;
  }, 'grace a', 4000);
  await until(right.page, () => window.__echo().round === 2 && window.__echo().footDash, 'grace b', 2000);
  const graceA = await left.page.evaluate(() => window.__echo());
  const graceB = await right.page.evaluate(() => window.__echo());
  assert(graceA.footDash && graceB.footDash, 'both draw dashed rings from the server grace bit');
  assert(graceA.t === graceB.t || Math.abs(graceA.t - graceB.t) <= 1, 'grace step stays together');
  assert(graceA.flicker === (Math.floor(graceA.t / 2) % 2 === 0 ? 0.5 : 0.15), 'flicker is a function of the server step');
  await left.page.screenshot({ path: path.join(OUT, 'grace-a.png') });
  await right.page.screenshot({ path: path.join(OUT, 'grace-b.png') });
  await until(left.page, () => {
    const live = window.__echo();
    return live.round === 2 && live.flicker === 0.5;
  }, 'flicker bright', 2000).catch(() => {});
  await left.page.screenshot({ path: path.join(OUT, 'flicker-bright-a.png') });
  await until(left.page, () => window.__echo().flicker === 0.15, 'flicker dim', 2000);
  await left.page.screenshot({ path: path.join(OUT, 'flicker-dim-a.png') });
  await right.page.screenshot({ path: path.join(OUT, 'flicker-dim-b.png') });
  await until(left.page, () => {
    const e = window.__echo();
    return e.round === 2 && !e.footDash && e.t >= 60 && e.state === 'play';
  }, 'solid a', 4000);
  await until(right.page, () => {
    const e = window.__echo();
    return e.round === 2 && !e.footDash && e.state === 'play';
  }, 'solid b', 2000);
  const solidA = await left.page.evaluate(() => window.__echo());
  const solidB = await right.page.evaluate(() => window.__echo());
  assert(!solidA.footDash && !solidB.footDash, 'rings turn solid when the server ends grace');
  assert(solidA.ghosts === solidB.ghosts && solidA.ghosts >= 2, 'echo count matches');
  const ghostsA = await left.page.evaluate(() => window.__echoNet().ghosts.map(g => g.pts.length));
  const ghostsB = await right.page.evaluate(() => window.__echoNet().ghosts.map(g => g.pts.length));
  assert(JSON.stringify(ghostsA) === JSON.stringify(ghostsB), 'echo route lengths match');
  await left.page.screenshot({ path: path.join(OUT, 'solid-a.png') });
  await right.page.screenshot({ path: path.join(OUT, 'solid-b.png') });
  await key(left.page, 'keyup', 'ArrowRight');
  await key(right.page, 'keyup', 'ArrowLeft');
  assert(!left.errors.length, 'client A errors ' + left.errors.join(' | '));
  assert(!right.errors.length, 'client B errors ' + right.errors.join(' | '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
