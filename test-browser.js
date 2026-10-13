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
    await testWhaleCard(solo, port);
    await testMenuGap(solo, port);
    await testEndMenu(solo, port);
  } finally {
    await solo.close();
  }
  const left = await launch(0);
  const right = await launch(980);
  try {
    await testEsc(left, right, port);
    await testDeathNames(left, right, port);
    await testPair(left, right, port, app);
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
  const menuButtons = await hiddenButtons(page);
  assert(!menuButtons.campaign && !menuButtons.quests && !menuButtons.multi, 'menu shows the three buttons');
  await key(page, 'keydown', ' ');
  await until(page, () => window.__echo().state === 'play', 'solo play');
  const playButtons = await hiddenButtons(page);
  assert(playButtons.campaign && playButtons.quests && playButtons.multi, 'play hides the menu buttons');
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
  await key(page, 'keyup', 'ArrowLeft');
  const mid = await page.evaluate(() => window.__echo());
  if (mid.state === 'shop') {
    const shopButtons = await hiddenButtons(page);
    assert(shopButtons.campaign && shopButtons.quests && shopButtons.multi, 'shop keeps the menu buttons hidden');
    await key(page, 'keydown', 'ArrowRight');
    await sleep(300);
    const held = await page.evaluate(() => window.__echo());
    assert(held.state === 'shop', 'a direction key does not leave the shop');
    assert(Math.abs(held.x - mid.x) < 1 && Math.abs(held.y - mid.y) < 1, 'solo shop ignores movement, saw ' + held.x);
    await key(page, 'keyup', 'ArrowRight');
    assert(mid.coins >= 8, 'solo round pays T');
    await page.evaluate(() => {
      const offer = window.__echo().offers[0];
      if (offer) window.__echoShop({ act: 'buy', uid: offer.uid });
    });
    const bought = await page.evaluate(() => window.__echo());
    assert(bought.worn.length >= 1 && bought.worn[0].name && bought.worn[0].tierLabel === 'v1', 'solo shop equips a generated v1 piece');
    await until(page, () => (document.getElementById('ui').textContent || '').indexOf('token 余额') >= 0, 'token label', 4000);
    await page.evaluate(() => window.__echoShop({ act: 'ready' }));
  }
  await until(page, () => window.__echo().round === 2 && window.__echo().footDash === true, 'solo grace', 4000);
  const grace = await page.evaluate(() => window.__echo());
  assert(grace.grace > 0 && grace.t < 60, 'solo grace uses the 60-step rule');
  if (mid.state === 'shop') {
    assert(Math.abs(grace.x - mid.x) < 2 && Math.abs(grace.y - mid.y) < 2, 'round 2 starts where the shop opened');
  }
  assert(grace.flicker === (Math.floor(grace.t / 2) % 2 === 0 ? 0.5 : 0.15), 'solo flicker follows the step');
  const ring = await page.evaluate(() => {
    const echo = window.__echo();
    const ghost = (echo.ghostPos || []).find((g) => g);
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / window.innerWidth;
    const gx = (echo.view.ox + ghost.x * echo.view.s) * dpr;
    const gy = (echo.view.oy + ghost.y * echo.view.s) * dpr;
    const rad = 18 * dpr;
    const x0 = Math.max(0, Math.floor(gx - rad));
    const y0 = Math.max(0, Math.floor(gy - rad));
    const w = Math.min(canvas.width, Math.ceil(gx + rad)) - x0;
    const h = Math.min(canvas.height, Math.ceil(gy + rad)) - y0;
    const img = ctx.getImageData(x0, y0, Math.max(1, w), Math.max(1, h));
    let n = 0;
    let sx = 0;
    let sy = 0;
    let maxY = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i] < 235 || img.data[i + 1] < 235 || img.data[i + 2] < 235) continue;
        n++;
        sx += x0 + x;
        sy += y0 + y;
        if (y0 + y > maxY) maxY = y0 + y;
      }
    }
    return {
      n,
      gapX: n ? sx / n / dpr - ghost.x : null,
      gapY: n ? sy / n / dpr - ghost.y : null,
      maxY: maxY / dpr,
      H: echo.H,
    };
  });
  assert(ring.n >= 6, 'the foot ring is visible, saw ' + ring.n);
  assert(Math.abs(ring.gapX) < 3 && Math.abs(ring.gapY) < 3, 'the ring center stays on the foot, gap ' + ring.gapX + ',' + ring.gapY);
  assert(ring.maxY < ring.H - 2, 'the ring stays inside the canvas');
  await key(page, 'keyup', 'ArrowLeft');
  assert(!errors.length, 'solo console errors ' + errors.join(' | '));
}

async function testWhaleCard(browser, port) {
  const { page, errors } = await boot(browser, port, '鲸');
  await until(page, () => (window.__echo().castHits || []).some((hit) => hit.id === 'whale'), 'whale card');
  const hit = await page.evaluate(() => {
    const card = window.__echo().castHits.find((item) => item.id === 'whale');
    return { x: card.x + card.w / 2, y: card.y + card.h / 2 };
  });
  await page.mouse.click(hit.x, hit.y);
  await sleep(120);
  await until(page, () => window.__echo().role === 'whale' && window.__echo().sheet, 'whale sheet', 4000);
  const picked = await page.evaluate(() => window.__echo());
  assert(picked.state === 'menu', 'the whale card does not start a match');
  assert(picked.role === 'whale', 'the whale card selects the whale');
  await page.screenshot({ path: path.join(OUT, 'whale-card.png') });
  await key(page, 'keydown', ' ');
  await until(page, () => window.__echo().state === 'play', 'space starts after the whale is selected');
  const playing = await page.evaluate(() => window.__echo());
  assert(playing.role === 'whale', 'the match keeps the selected whale');
  assert(!errors.length, 'whale card errors ' + errors.join(' | '));
}

async function testMenuGap(browser, port) {
  const { page, errors } = await boot(browser, port, '窄');
  await page.setViewport({ width: 480, height: 540, deviceScaleFactor: 1 });
  await sleep(200);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await sleep(200);
  const gap = await page.evaluate(() => {
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, Math.min(canvas.height, 180));
    const rows = [];
    for (let y = 0; y < img.height; y++) {
      let n = 0;
      const x0 = Math.floor(img.width * 0.28);
      const x1 = Math.floor(img.width * 0.72);
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i] > 170 && img.data[i + 1] > 170 && img.data[i + 2] > 170) n++;
      }
      if (n > 4) rows.push(y);
    }
    const runs = [];
    rows.forEach((y) => {
      const last = runs[runs.length - 1];
      if (!last || y > last.end + 1) runs.push({ start: y, end: y });
      else last.end = y;
    });
    const first = runs[0] || { start: 0, end: 0 };
    const second = runs[1] || { start: 0, end: 0 };
    return {
      runs: runs.length,
      titleH: first.end - first.start + 1,
      split: runs.length > 1 ? second.start - first.end - 1 : 0,
    };
  });
  await page.screenshot({ path: path.join(OUT, 'menu-half.png') });
  assert(gap.runs >= 2, 'the half-width menu draws the title and the intro apart');
  assert(gap.titleH <= 40, 'the title is its own line, height ' + gap.titleH);
  assert(gap.split >= 6, 'the title and the intro do not overlap, gap ' + gap.split);
  assert(!errors.length, 'menu gap errors ' + errors.join(' | '));
}

async function testEndMenu(browser, port) {
  const { page, errors } = await boot(browser, port, '终');
  await key(page, 'keydown', ' ');
  await until(page, () => window.__echo().state === 'play', 'end play');
  await until(page, () => window.__echo().state === 'shop', 'end shop', 12000);
  await until(page, () => {
    const left = window.__echo().shopLeft;
    return left > 0 && left <= 390;
  }, 'shop warmed', 8000);
  await page.evaluate(() => window.__echoShop({ act: 'ready' }));
  await until(page, () => window.__echo().state === 'over', 'solo over', 8000);
  const over = await page.evaluate(() => window.__echo());
  assert(over.endPrompt.indexOf('回主菜单') >= 0 && over.endPrompt.indexOf('Esc') >= 0, 'prompt lists the menu actions, saw ' + over.endPrompt);
  assert(over.endPrompt.indexOf('闯关') < 0, 'prompt does not mention the hidden campaign button');
  const hidden = await hiddenButtons(page);
  assert(hidden.campaign && hidden.quests && hidden.multi, 'the end screen keeps the mode buttons hidden');
  const hit = (over.endHits || []).find((item) => item.act === 'menu');
  assert(hit, 'the end screen has a menu button');
  await page.mouse.click(hit.x + hit.w / 2, hit.y + hit.h / 2);
  await until(page, () => window.__echo().state === 'menu', 'click returns to the menu');
  const clicked = await hiddenButtons(page);
  assert(!clicked.campaign && !clicked.quests && !clicked.multi, 'the mode buttons return after the click');
  await key(page, 'keydown', ' ');
  await until(page, () => window.__echo().state === 'play', 'second play');
  await until(page, () => window.__echo().state === 'shop', 'second shop', 12000);
  await until(page, () => {
    const left = window.__echo().shopLeft;
    return left > 0 && left <= 390;
  }, 'second shop warmed', 8000);
  await page.evaluate(() => window.__echoShop({ act: 'ready' }));
  await until(page, () => window.__echo().state === 'over', 'second over', 8000);
  await key(page, 'keydown', 'Escape');
  await until(page, () => window.__echo().state === 'menu', 'escape returns to the menu');
  const keyed = await hiddenButtons(page);
  assert(!keyed.campaign && !keyed.quests && !keyed.multi, 'escape shows the mode buttons again');
  assert(!errors.length, 'end menu errors ' + errors.join(' | '));
}

function windowActive(net) {
  return !!(net && net.active);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// waitForFunction polls through CDP often enough to stall this page.
function hiddenButtons(page) {
  return page.evaluate(() => ({
    campaign: document.getElementById('campaign').hidden,
    quests: document.getElementById('quests').hidden,
    multi: document.getElementById('multi').hidden,
  }));
}

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

async function testEsc(leftBrowser, rightBrowser, port) {
  const left = await boot(leftBrowser, port, '甲');
  const right = await boot(rightBrowser, port, '乙');
  await left.page.evaluate(() => document.getElementById('multi').click());
  await right.page.evaluate(() => document.getElementById('multi').click());
  await until(left.page, () => window.__echoNet().active && window.__echoNet().players.length === 2, 'esc lobby');
  await key(left.page, 'keydown', ' ');
  await key(left.page, 'keyup', ' ');
  await until(left.page, () => window.__echo().state === 'play', 'esc play');
  await key(left.page, 'keydown', 'Escape');
  await until(left.page, () => !window.__echoNet().active && window.__echo().state === 'menu', 'esc leaves the match');
  const playNote = await left.page.evaluate(() => document.getElementById('netmsg').textContent || '');
  assert(playNote.indexOf('连不上') < 0, 'esc during a match is not a connection failure, saw ' + playNote);
  const back = await hiddenButtons(left.page);
  assert(!back.campaign && !back.quests && !back.multi, 'esc restores the menu buttons');
  await left.page.evaluate(() => document.getElementById('multi').click());
  await until(left.page, () => window.__echoNet().active && window.__echoNet().players.length === 2, 'esc lobby again');
  await key(right.page, 'keydown', ' ');
  await key(right.page, 'keyup', ' ');
  await until(left.page, () => window.__echo().state === 'shop', 'esc shop', 12000);
  await key(left.page, 'keydown', 'Escape');
  await until(left.page, () => !window.__echoNet().active && window.__echo().state === 'menu', 'esc leaves the shop');
  const shopNote = await left.page.evaluate(() => document.getElementById('netmsg').textContent || '');
  assert(shopNote.indexOf('连不上') < 0, 'esc during the shop is not a connection failure, saw ' + shopNote);
  assert(!left.errors.length, 'esc client errors ' + left.errors.join(' | '));
  assert(!right.errors.length, 'esc peer errors ' + right.errors.join(' | '));
}

async function testDeathNames(leftBrowser, rightBrowser, port) {
  const left = await boot(leftBrowser, port, '甲');
  const right = await boot(rightBrowser, port, '乙');
  await left.page.evaluate(() => document.getElementById('multi').click());
  await right.page.evaluate(() => document.getElementById('multi').click());
  await until(left.page, () => window.__echoNet().active && window.__echoNet().players.length === 2, 'death lobby');
  await key(left.page, 'keydown', ' ');
  await key(left.page, 'keyup', ' ');
  await until(left.page, () => window.__echo().state === 'shop', 'death shop', 12000);
  await left.page.evaluate(() => window.__echoShop({ act: 'ready' }));
  await right.page.evaluate(() => window.__echoShop({ act: 'ready' }));
  await until(left.page, () => {
    const lines = window.__echo().deathLines || [];
    return window.__echo().state === 'over' && lines.length >= 2;
  }, 'both deaths listed', 8000);
  await until(right.page, () => (window.__echo().deathLines || []).length >= 2 && window.__echo().state === 'over', 'peer lists both deaths', 8000);
  const mine = await left.page.evaluate(() => window.__echo().deathLines.slice());
  const peer = await right.page.evaluate(() => window.__echo().deathLines.slice());
  assert(JSON.stringify(mine) === JSON.stringify(peer), 'both clients show the same death list, ' + mine.join(' | ') + ' vs ' + peer.join(' | '));
  assert(mine.length === 2, 'the panel lists both deaths, saw ' + mine.join(' | '));
  assert(mine.indexOf('甲撞上了自己的回声') >= 0 && mine.indexOf('乙撞上了自己的回声') >= 0, 'each victim is on the list, saw ' + mine.join(' | '));
  assert(mine[0].indexOf('甲') === 0 && mine[1].indexOf('乙') === 0, 'the list follows death tick order, saw ' + mine.join(' | '));
  await left.page.screenshot({ path: path.join(OUT, 'death-a.png') });
  await right.page.screenshot({ path: path.join(OUT, 'death-b.png') });
  await key(left.page, 'keydown', ' ');
  await key(left.page, 'keyup', ' ');
  await until(left.page, () => window.__echo().state === 'play' && window.__echo().round === 1 && (window.__echo().deathLines || []).length === 0, 'a new round clears the death list');
  await until(right.page, () => window.__echo().state === 'play' && (window.__echo().deathLines || []).length === 0, 'the other client clears the death list too');
  assert(!left.errors.length, 'death client errors ' + left.errors.join(' | '));
  assert(!right.errors.length, 'death peer errors ' + right.errors.join(' | '));
}

async function testPair(leftBrowser, rightBrowser, port, app) {
  const left = await boot(leftBrowser, port, '甲');
  const right = await boot(rightBrowser, port, '乙');
  await left.page.evaluate(() => document.getElementById('multi').click());
  await right.page.evaluate(() => document.getElementById('multi').click());
  await until(left.page, () => window.__echoNet().active && window.__echoNet().players.length === 2, 'lobby a');
  await until(right.page, () => window.__echoNet().active && window.__echoNet().players.length === 2, 'lobby b');
  const lobbyButtons = await hiddenButtons(left.page);
  assert(!lobbyButtons.campaign && !lobbyButtons.quests && !lobbyButtons.multi, 'the lobby menu still shows the three buttons');
  const lobbyNote = await left.page.evaluate(() => document.getElementById('netmsg').textContent || '');
  assert(lobbyNote.indexOf('同一块') >= 0, 'the lobby shows the start hint');
  await left.page.screenshot({ path: path.join(OUT, 'lobby-a.png') });
  await right.page.screenshot({ path: path.join(OUT, 'lobby-b.png') });
  await key(left.page, 'keydown', ' ');
  await until(left.page, () => window.__echo().state === 'play' && window.__echo().round === 1, 'play a');
  await until(right.page, () => window.__echo().state === 'play', 'play b');
  const matchButtons = await hiddenButtons(left.page);
  assert(matchButtons.campaign && matchButtons.quests && matchButtons.multi, 'a multiplayer match hides the menu buttons');
  const playNote = await left.page.evaluate(() => document.getElementById('netmsg').textContent || '');
  assert(playNote.indexOf('同一块') < 0, 'a match hides the start hint, saw ' + playNote);
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
    const shopNote = await left.page.evaluate(() => document.getElementById('netmsg').textContent || '');
    assert(shopNote.indexOf('同一块') < 0, 'the shop hides the start hint, saw ' + shopNote);
    await left.page.screenshot({ path: path.join(OUT, 'shop-a.png') });
    const edge = await left.page.evaluate(() => {
      const echo = window.__echo();
      const me = window.__echoNet().players.find((p) => p.name === '甲');
      const hex = (me && me.color) || '#ff8ad4';
      const n = parseInt(hex.slice(1), 16);
      const pr = (n >> 16) & 255;
      const pg = (n >> 8) & 255;
      const pb = n & 255;
      const frame = { x: 28 + 12, y: 12 + 12, s: 64 };
      const canvas = document.getElementById('c');
      const ctx = canvas.getContext('2d');
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const dpr = canvas.width / window.innerWidth;
      let inFrame = 0;
      let inField = 0;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          const dr = Math.abs(img.data[i] - pr);
          const dg = Math.abs(img.data[i + 1] - pg);
          const db = Math.abs(img.data[i + 2] - pb);
          if (dr + dg + db > 40) continue;
          const gx = (x / dpr - echo.view.ox) / echo.view.s;
          const gy = (y / dpr - echo.view.oy) / echo.view.s;
          if (gx >= frame.x && gx <= frame.x + frame.s && gy >= frame.y && gy <= frame.y + frame.s) inFrame++;
          else if (gx > frame.x + frame.s + 80) inField++;
        }
      }
      return { x: echo.x, inFrame, inField, panelRight: 28 + echo.W - 56, color: hex };
    });
    assert(edge.x > edge.panelRight - 40, 'the shop opened with the player against the arena edge, saw ' + edge.x);
    assert(edge.inFrame > 20, 'the shop portrait holds the character, saw ' + edge.inFrame);
    assert(edge.inField === 0, 'the character is not drawn in the play field, spill ' + edge.inField);
    await left.page.evaluate(() => {
      const offer = window.__echo().offers[0];
      if (offer) window.__echoShop({ act: 'buy', uid: offer.uid });
    });
    await right.page.evaluate(() => window.__echoShop({ act: 'ready' }));
    await left.page.evaluate(() => window.__echoShop({ act: 'ready' }));
    await until(right.page, () => {
      const players = window.__echoNet().players;
      return players.some(p => (p.gear || []).length > 0 && p.gear[0].name);
    }, 'peer sees generated gear', 4000);
  }
  await until(left.page, () => {
    const e = window.__echo();
    return e.round === 2 && e.footDash && e.grace > 0 && e.ghosts >= 2;
  }, 'grace a', 4000);
  await until(right.page, () => window.__echo().round === 2 && window.__echo().footDash, 'grace b', 2000);
  const graceA = await left.page.evaluate(() => window.__echo());
  const graceB = await right.page.evaluate(() => window.__echo());
  assert(graceA.footDash && graceB.footDash, 'both draw dashed rings from the server grace bit');
  const labels = await left.page.evaluate(() => {
    const echo = window.__echo();
    const net = window.__echoNet();
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / window.innerWidth;
    let colored = 0;
    let white = 0;
    (net.ghosts || []).forEach((ghost) => {
      const pts = ghost.pts || [];
      const q = pts[Math.min(echo.t, Math.max(0, pts.length - 1))];
      if (!q) return;
      const sx = (echo.view.ox + q.x * echo.view.s) * dpr;
      const sy = (echo.view.oy + (q.y + 12) * echo.view.s) * dpr;
      const x0 = Math.max(0, Math.floor(sx - 16));
      const y0 = Math.max(0, Math.floor(sy));
      const img = ctx.getImageData(x0, y0, 32, 12);
      for (let i = 0; i < img.data.length; i += 4) {
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        if (r > 200 && g > 200 && b > 200) white++;
        if (r > g + 15 && r > 50 && r > b) colored++;
      }
    });
    return { colored, white };
  });
  assert(labels.colored >= 4, 'echo names are tinted under the ring, saw ' + labels.colored);
  assert(labels.white === 0, 'echo names are not white, saw ' + labels.white);
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
  await sleep(250);
  const [localA, remoteA] = await Promise.all([
    left.page.evaluate(() => window.__echo().x),
    right.page.evaluate(() => {
      const row = window.__echoNet().players.find((p) => p.name === '甲');
      return row ? row.x : null;
    }),
  ]);
  assert(remoteA != null && Math.abs(localA - remoteA) < 2, 'the local player matches the server, ' + localA + ' vs ' + remoteA);
  await left.page.evaluate(() => document.getElementById('leave').click());
  await until(left.page, () => window.__echo().state === 'menu', 'left the match');
  const returned = await hiddenButtons(left.page);
  assert(!returned.campaign && !returned.quests && !returned.multi, 'the menu buttons return after leaving');
  const leftNote = await left.page.evaluate(() => document.getElementById('netmsg').textContent || '');
  assert(leftNote.indexOf('连不上') < 0, 'leaving is not a connection failure, saw ' + leftNote);
  assert(!left.errors.length, 'client A errors ' + left.errors.join(' | '));
  assert(!right.errors.length, 'client B errors ' + right.errors.join(' | '));
  await app.close();
  await left.page.evaluate(() => document.getElementById('multi').click());
  await until(left.page, () => (document.getElementById('netmsg').textContent || '').indexOf('连不上') >= 0, 'offline note', 4000);
  const fail = await left.page.evaluate(() => document.getElementById('netmsg').textContent || '');
  assert(fail.indexOf(String(port)) >= 0, 'the failure names the port in use, saw ' + fail);
  if (String(port) !== '8787') assert(fail.indexOf('8787') < 0, 'the failure does not hardcode 8787, saw ' + fail);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
