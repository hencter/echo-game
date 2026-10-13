// Movement, stars, grace, and the gear shop. Online matches run this on the
// server. The page loads the same file, so solo play does not need a server.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EchoRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STEPS = 360;
  const GRACE = 60;
  const W = 960;
  const H = 540;
  const WARN_BASE = 75;
  const SHOP_STEPS = 480;
  const SHOP_MIN = 90;
  const T_STAR = 4;
  const T_ROUND = 8;
  const IFRAMES = 36;
  const BAG = 6;
  const ITEMS = {
    reset: {
      id: 'reset',
      name: '重置卡',
      mark: '复',
      color: '#9ad0ff',
      price: 10,
      blurb: '回到这一轮开始。得分保留。',
      stack: 6,
    },
  };
  const DRAIN = { coreSteps: 45, warnSteps: 90, dash: 1 };
  const SCORE_STAR = 10;
  const SCORE_ROUND = 50;

  const SLOTS = ['head', 'body', 'accessory'];
  const SLOT_NAME = { head: '头', body: '身', accessory: '饰品' };
  const TIERS = [
    { id: 'v1', label: 'v1', params: '7M' },
    { id: 'v2', label: 'v2', params: '70M' },
    { id: 'v3', label: 'v3', params: '7B' },
    { id: 'frontier', label: '前沿模型', params: '未公开' },
  ];
  const TRAIN = [
    { cost: 18, samples: 1 },
    { cost: 32, samples: 2 },
    { cost: 48, samples: 3 },
  ];
  const HALLU = [16, 10, 6, 2];
  const AFFIX = {
    speed: {
      slot: 'body', mark: '靴', noun: '注意力靴', color: '#b8ff7a',
      tiers: [{ speed: 1.12 }, { speed: 1.24 }, { speed: 1.38 }, { speed: 1.55 }],
      line: function (row) { return '移速 +' + Math.round((row.speed - 1) * 100) + '%'; },
    },
    shield: {
      slot: 'accessory', mark: '盾', noun: '对齐盾', color: '#7ad7ff',
      tiers: [{ blocks: 1 }, { blocks: 2 }, { blocks: 3 }, { blocks: 4 }],
      line: function (row) { return '护盾 ' + row.blocks + ' 次'; },
    },
    warn: {
      slot: 'head', mark: '镜', noun: '推理镜', color: '#d4a5ff',
      tiers: [{ warn: 130 }, { warn: 190 }, { warn: 250 }, { warn: 310 }],
      line: function (row) { return '推理提前 ' + (row.warn / 60).toFixed(1) + ' 秒'; },
    },
    magnet: {
      slot: 'accessory', mark: '磁', noun: '检索磁', color: '#ffd27a',
      tiers: [
        { magnet: 1.8, attract: 90, pull: 10 },
        { magnet: 2.5, attract: 140, pull: 16 },
        { magnet: 3.4, attract: 200, pull: 24 },
        { magnet: 4.2, attract: 260, pull: 32 },
      ],
      line: function (row) { return '检索 ×' + row.magnet + '，吸引 ' + row.attract + 'px'; },
    },
    dash: {
      slot: 'body', mark: '冲', noun: '思维链手套', color: '#ff8ad4',
      tiers: [
        { dash: { frames: 8, speed: 2.6, cd: 180 } },
        { dash: { frames: 10, speed: 3.0, cd: 120 } },
        { dash: { frames: 12, speed: 3.4, cd: 72 } },
        { dash: { frames: 14, speed: 3.8, cd: 48 } },
      ],
      line: function (row) { return '冲刺 ' + row.dash.frames + ' 步 ×' + row.dash.speed; },
    },
    hp: {
      slot: 'head', mark: '盔', noun: '参数盔', color: '#d8d2c8',
      tiers: [{ hp: 1 }, { hp: 2 }, { hp: 3 }, { hp: 4 }],
      line: function (row) { return '参数生命 +' + row.hp; },
    },
    score: {
      slot: 'accessory', mark: '草', noun: '奖励草', color: '#7affd4',
      tiers: [{ score: 1.5 }, { score: 2 }, { score: 2.6 }, { score: 3.4 }],
      line: function (row) { return '得分 ×' + row.score; },
    },
  };
  const CORES = {
    predict: { reward: 1.5, power: [28, 40, 56, 72], blurb: '预判核：回声沿你的速度提前走' },
    evade: { reward: 1.35, power: [24, 36, 50, 68], blurb: '回避核：回声绕开你，换一条走法' },
  };
  const AFFIX_KEYS = ['speed', 'shield', 'warn', 'magnet', 'dash', 'hp', 'score'];
  const PREFIXES = ['微调版', '蒸馏版', '量化版', '对齐版', '温度版', '检索版', '思维链'];

  const REASON = {
    not_enough_T: 'token 余额不够',
    no_card: '背包里没有重置卡',
    locked: '还没解锁这一关',
    quest: '这张任务现在不能交',
    role: '没有这个角色',
    bag_full: '背包满了',
    max_tier: '已经是前沿模型',
    not_owned: '还没有这件',
    shop_only: '只能在轮间推理时操作',
    unknown: '没有这件装备',
    bad_slot: '槽位不对',
    need_samples: '对局样本不够，再活过几轮',
  };

  let namer = defaultNamer;

  function defaultNamer(ctx) {
    const prefix = PREFIXES[Math.floor(ctx.rng() * PREFIXES.length)];
    let name = prefix + '·' + ctx.noun;
    if (ctx.core === 'predict') name += '·预判核';
    else if (ctx.core === 'evade') name += '·回避核';
    return name;
  }

  function setNamer(fn) {
    namer = typeof fn === 'function' ? fn : defaultNamer;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mixSeed(seed, round, who, index) {
    const text = String(who) + ':' + round + ':' + index + ':' + (seed >>> 0);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function unit(w, h) {
    return Math.min(w, h);
  }

  function bodyR(w, h) {
    return unit(w, h) * 0.02;
  }

  function collideDist(w, h, ghostCount) {
    const u = unit(w, h);
    return bodyR(w, h) * 2 + u * 0.00115 * Math.min(ghostCount, 10);
  }

  function starGoal(round, stage) {
    if (stage && stage.slowRounds && round <= stage.slowRounds) return 2;
    if (stage && stage.id > 1) return Math.min(5, 1 + stage.id);
    return Math.min(4, 2 + Math.floor((round - 1) / 2));
  }

  function protecting(ghostCount, t) {
    return ghostCount > 0 && t < GRACE;
  }

  function axis(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return 0;
    return n > 0 ? 1 : -1;
  }

  function applyMove(body, input, w, h, tune) {
    const dt = 1 / 60;
    const u = unit(w, h);
    const speed = tune && tune.speed ? tune.speed : 1;
    const max = u * 0.44 * speed;
    const rad = bodyR(w, h);
    const dash = tune && tune.dash;
    if (dash && dash.x != null) {
      const burst = u * 0.44 * (dash.mul || 1);
      const len = Math.hypot(dash.x, dash.y) || 1;
      body.vx = dash.x / len * burst;
      body.vy = dash.y / len * burst;
      body.x += body.vx * dt;
      body.y += body.vy * dt;
    } else {
      const src = input || {};
      let ix = src.ax || 0;
      let iy = src.ay || 0;
      let mouse = src.mouse || null;
      if (ix || iy) {
        const l = Math.hypot(ix, iy);
        ix /= l;
        iy /= l;
        mouse = null;
      } else if (mouse) {
        const ex = mouse.x - body.x;
        const ey = mouse.y - body.y;
        const l = Math.hypot(ex, ey);
        if (l > u * 0.008) {
          ix = ex / l;
          iy = ey / l;
        }
      }
      const k = 1 - Math.exp(-dt / 0.022);
      body.vx += (ix * max - body.vx) * k;
      body.vy += (iy * max - body.vy) * k;
      if (!ix && !iy && Math.hypot(body.vx, body.vy) < max * 0.04) {
        body.vx = 0;
        body.vy = 0;
      }
      let stepX = body.vx * dt;
      let stepY = body.vy * dt;
      if (mouse && !src.keyboard) {
        const l = Math.hypot(mouse.x - body.x, mouse.y - body.y);
        const mag = Math.hypot(stepX, stepY);
        if (mag > l) {
          stepX *= l / mag;
          stepY *= l / mag;
          body.vx *= 0.35;
          body.vy *= 0.35;
        }
      }
      body.x += stepX;
      body.y += stepY;
    }
    const m = rad + 2;
    body.x = Math.max(m, Math.min(w - m, body.x));
    body.y = Math.max(m, Math.min(h - m, body.y));
  }

  function emptyGear() {
    return {
      t: 0,
      bag: [],
      stock: [],
      equipped: { head: null, body: null, accessory: null },
    };
  }

  function findOwned(gear, uid) {
    for (let i = 0; i < SLOTS.length; i++) {
      const slot = SLOTS[i];
      const item = gear.equipped[slot];
      if (item && item.uid === uid) return { where: 'equipped', slot: slot, item: item };
    }
    for (let i = 0; i < gear.bag.length; i++) {
      if (gear.bag[i].uid === uid) return { where: 'bag', index: i, item: gear.bag[i] };
    }
    return null;
  }

  function priceOf(item) {
    let price = 8;
    if (item.affixes.length > 1) price += 6;
    if (item.core) price += 8;
    if (item.negative) price -= 3;
    return Math.max(6, price);
  }

  function rollPiece(seed, force) {
    const spec = force || {};
    const rng = mulberry32(seed >>> 0);
    const primary = spec.primary || AFFIX_KEYS[Math.floor(rng() * AFFIX_KEYS.length)];
    let extra = null;
    if (Object.prototype.hasOwnProperty.call(spec, 'extra')) extra = spec.extra;
    else if (rng() < 0.45) {
      const rest = AFFIX_KEYS.filter(function (key) { return key !== primary; });
      extra = rest[Math.floor(rng() * rest.length)];
    }
    let negative = null;
    if (Object.prototype.hasOwnProperty.call(spec, 'negative')) negative = spec.negative;
    else if (rng() < 0.35) negative = 'hallucination';
    let core = null;
    if (Object.prototype.hasOwnProperty.call(spec, 'core')) core = spec.core;
    else if (rng() < 0.28) core = rng() < 0.5 ? 'predict' : 'evade';
    const tier = spec.tier | 0;
    const affixes = [primary];
    if (extra && extra !== primary && AFFIX[extra]) affixes.push(extra);
    const base = AFFIX[primary];
    const item = {
      uid: 'g' + (seed >>> 0).toString(36),
      seed: seed >>> 0,
      slot: base.slot,
      tier: Math.max(0, Math.min(3, tier)),
      affixes: affixes,
      negative: negative || null,
      core: core || null,
      samples: 0,
      mark: base.mark,
      color: core ? '#ffcc66' : base.color,
    };
    item.price = priceOf(item);
    item.name = namer({
      rng: rng,
      primary: primary,
      affixes: affixes,
      tier: item.tier,
      core: item.core,
      negative: item.negative,
      noun: base.noun,
    });
    return item;
  }

  function rollShop(seed, round, who) {
    const clean = rollPiece(mixSeed(seed, round, who, 0), { extra: null, core: null, negative: null });
    return [
      clean,
      rollPiece(mixSeed(seed, round, who, 1)),
      rollPiece(mixSeed(seed, round, who, 2)),
    ];
  }

  function openStock(gear, seed, round, who) {
    gear.stock = rollShop(seed, round, who);
  }

  function trainQuote(item) {
    if (!item || item.tier >= 3) return null;
    const row = TRAIN[item.tier];
    return { cost: row.cost, samples: row.samples, next: TIERS[item.tier + 1].label };
  }

  function linesOf(item) {
    const tier = item.tier || 0;
    const lines = [];
    for (let i = 0; i < item.affixes.length; i++) {
      const def = AFFIX[item.affixes[i]];
      if (def) lines.push(def.line(def.tiers[tier]));
    }
    if (item.negative === 'hallucination') lines.push('幻觉 噪声 ' + HALLU[tier] + 'px');
    if (item.core && CORES[item.core]) {
      lines.push(CORES[item.core].blurb + ' ' + CORES[item.core].power[tier] + 'px');
    }
    lines.push(TIERS[tier].label + ' · 参数量 ' + TIERS[tier].params);
    return lines;
  }

  function viewItem(item) {
    const quote = trainQuote(item);
    return {
      uid: item.uid,
      slot: item.slot,
      slotName: SLOT_NAME[item.slot],
      name: item.name,
      mark: item.mark,
      color: item.color,
      tier: item.tier,
      tierLabel: TIERS[item.tier].label,
      params: TIERS[item.tier].params,
      affixes: item.affixes.slice(),
      negative: item.negative,
      core: item.core,
      samples: item.samples || 0,
      price: item.price,
      lines: linesOf(item),
      trainCost: quote ? quote.cost : 0,
      trainSamples: quote ? quote.samples : 0,
      trainNext: quote ? quote.next : '',
    };
  }

  function applyItem(stats, item) {
    if (!item) return;
    const tier = item.tier || 0;
    const affixes = item.affixes || [];
    for (let i = 0; i < affixes.length; i++) {
      const def = AFFIX[affixes[i]];
      const row = def && def.tiers[tier];
      if (!row) continue;
      if (row.speed) stats.speed = Math.max(stats.speed, row.speed);
      if (row.blocks) stats.blocks += row.blocks;
      if (row.warn) stats.warn = Math.max(stats.warn, row.warn);
      if (row.magnet) stats.magnet = Math.max(stats.magnet, row.magnet);
      if (row.attract) stats.attract = Math.max(stats.attract, row.attract);
      if (row.pull) stats.pull = Math.max(stats.pull, row.pull);
      if (row.dash && (!stats.dash || row.dash.cd < stats.dash.cd)) stats.dash = row.dash;
      if (row.hp) stats.bonusHp += row.hp;
      if (row.score) stats.score = Math.max(stats.score, row.score);
    }
    if (item.negative === 'hallucination') stats.noise = Math.max(stats.noise, HALLU[tier]);
    if (item.core && CORES[item.core]) {
      const power = CORES[item.core].power[tier];
      if (!stats.core || power > stats.core.power) {
        stats.core = { kind: item.core, lead: power, dodge: power, power: power };
      }
      stats.reward = Math.max(stats.reward, CORES[item.core].reward);
    }
  }

  function statsOf(gear) {
    const stats = {
      speed: 1,
      blocks: 0,
      warn: WARN_BASE,
      magnet: 1,
      attract: 0,
      pull: 0,
      dash: null,
      bonusHp: 0,
      score: 1,
      reward: 1,
      noise: 0,
      core: null,
      maxHp: 1,
    };
    for (let i = 0; i < SLOTS.length; i++) applyItem(stats, gear.equipped[SLOTS[i]]);
    stats.maxHp = 1 + stats.bonusHp;
    return stats;
  }

  function ok() { return { ok: true, reason: '' }; }
  function fail(reason) { return { ok: false, reason: reason }; }

  function buy(gear, uid) {
    const index = (gear.stock || []).findIndex(function (item) { return item.uid === uid; });
    if (index < 0) return fail('unknown');
    const item = gear.stock[index];
    if (gear.t < item.price) return fail('not_enough_T');
    if (!gear.equipped[item.slot]) {
      gear.t -= item.price;
      gear.stock.splice(index, 1);
      gear.equipped[item.slot] = item;
      return ok();
    }
    if (gear.bag.length >= bagCap(gear)) return fail('bag_full');
    gear.t -= item.price;
    gear.stock.splice(index, 1);
    gear.bag.push(item);
    return ok();
  }

  function train(gear, uid) {
    const owned = findOwned(gear, uid);
    if (!owned) return fail('not_owned');
    const quote = trainQuote(owned.item);
    if (!quote) return fail('max_tier');
    if ((owned.item.samples || 0) < quote.samples) return fail('need_samples');
    if (gear.t < quote.cost) return fail('not_enough_T');
    gear.t -= quote.cost;
    owned.item.samples -= quote.samples;
    owned.item.tier += 1;
    return ok();
  }

  function equip(gear, uid) {
    const owned = findOwned(gear, uid);
    if (!owned) return fail('not_owned');
    if (owned.where === 'equipped') return ok();
    const prev = gear.equipped[owned.item.slot];
    gear.bag.splice(owned.index, 1);
    if (prev) gear.bag.push(prev);
    gear.equipped[owned.item.slot] = owned.item;
    return ok();
  }

  function unequip(gear, slot) {
    if (SLOTS.indexOf(slot) < 0) return fail('bad_slot');
    const item = gear.equipped[slot];
    if (!item) return ok();
    if (gear.bag.length >= bagCap(gear)) return fail('bag_full');
    gear.bag.push(item);
    gear.equipped[slot] = null;
    return ok();
  }

  function noteSamples(gear) {
    for (let i = 0; i < SLOTS.length; i++) {
      const item = gear.equipped[SLOTS[i]];
      if (item) item.samples = (item.samples || 0) + 1;
    }
  }

  function echoAt(pts, t, wearer) {
    if (!pts || !pts.length) return null;
    const index = Math.min(Math.max(0, t | 0), pts.length - 1);
    const q = pts[index];
    if (!q) return null;
    let x = q.x;
    let y = q.y;
    const core = wearer && wearer.core;
    if (core && core.kind === 'predict') {
      const vx = wearer.vx || 0;
      const vy = wearer.vy || 0;
      const speed = Math.hypot(vx, vy);
      if (speed > 1) {
        x += vx / speed * core.lead;
        y += vy / speed * core.lead;
      }
    } else if (core && core.kind === 'evade') {
      const dx = q.x - (wearer.x || 0);
      const dy = q.y - (wearer.y || 0);
      const len = Math.hypot(dx, dy) || 1;
      const dodge = core.dodge || 0;
      x += (dx / len) * dodge * 0.45 + (-dy / len) * dodge * 0.65;
      y += (dy / len) * dodge * 0.45 + (dx / len) * dodge * 0.65;
    }
    const w = wearer && wearer.w ? wearer.w : W;
    const h = wearer && wearer.h ? wearer.h : H;
    return {
      x: Math.max(8, Math.min(w - 8, x)),
      y: Math.max(8, Math.min(h - 8, y)),
      baseX: q.x,
      baseY: q.y,
    };
  }

  function hallucinationNudge(step, noise, salt) {
    if (!noise || (step % 20) !== 0) return { x: 0, y: 0 };
    const rng = mulberry32((salt ^ Math.imul(step, 997)) >>> 0);
    return { x: (rng() * 2 - 1) * noise, y: (rng() * 2 - 1) * noise };
  }

  function publicGear(gear) {
    const out = [];
    for (let i = 0; i < SLOTS.length; i++) {
      const item = gear.equipped[SLOTS[i]];
      if (item) out.push(viewItem(item));
    }
    return out;
  }

  function isCard(entry) {
    return !!(entry && entry.kind === 'card');
  }

  function countItem(gear, id) {
    let n = 0;
    const bag = gear && gear.bag || [];
    for (let i = 0; i < bag.length; i++) {
      if (isCard(bag[i]) && bag[i].id === id) n += bag[i].count || 0;
    }
    return n;
  }

  function buyItem(gear, id) {
    const spec = ITEMS[id];
    if (!spec) return fail('unknown');
    if (gear.t < spec.price) return fail('not_enough_T');
    for (let i = 0; i < gear.bag.length; i++) {
      const entry = gear.bag[i];
      if (isCard(entry) && entry.id === id) {
        if (entry.count >= spec.stack) return fail('bag_full');
        gear.t -= spec.price;
        entry.count += 1;
        return ok();
      }
    }
    if (gear.bag.length >= bagCap(gear)) return fail('bag_full');
    gear.t -= spec.price;
    gear.bag.push({ kind: 'card', id: id, count: 1 });
    return ok();
  }

  function spendItem(gear, id) {
    for (let i = 0; i < gear.bag.length; i++) {
      const entry = gear.bag[i];
      if (isCard(entry) && entry.id === id && entry.count > 0) {
        entry.count -= 1;
        if (entry.count <= 0) gear.bag.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function itemCatalog() {
    return Object.keys(ITEMS).map(function (id) {
      const spec = ITEMS[id];
      return {
        id: id,
        name: spec.name,
        mark: spec.mark,
        color: spec.color,
        price: spec.price,
        blurb: spec.blurb,
        stack: spec.stack,
      };
    });
  }

  function poweredStats(gear) {
    const stats = statsOf(gear);
    if (!gear || gear.t <= 0) {
      stats.core = null;
      stats.reward = 1;
      if (stats.warn > WARN_BASE) stats.warn = WARN_BASE;
      stats.dash = null;
    }
    return stats;
  }

  function tickDrain(gear, stats, step) {
    if (!gear || gear.t <= 0 || !step) return 0;
    let spent = 0;
    if (stats && stats.core && step % DRAIN.coreSteps === 0) spent += 1;
    if (stats && stats.warn > WARN_BASE && step % DRAIN.warnSteps === 0) spent += 1;
    if (!spent) return 0;
    const take = Math.min(gear.t, spent);
    gear.t -= take;
    return take;
  }

  function payDash(gear) {
    if (!gear || gear.t < DRAIN.dash) return false;
    gear.t -= DRAIN.dash;
    return true;
  }

  function bagView(gear) {
    return gear.bag.map(function (entry) {
      if (isCard(entry)) {
        const spec = ITEMS[entry.id] || {};
        return {
          kind: 'card',
          id: entry.id,
          count: entry.count,
          name: spec.name || entry.id,
          mark: spec.mark || '?',
          color: spec.color || '#fff',
          blurb: spec.blurb || '',
        };
      }
      return viewItem(entry);
    });
  }

  function offers(gear) {
    return (gear.stock || []).map(viewItem);
  }

  const BASE_HP = 3;
  const BASE_DASH = { frames: 3, speed: 2.5, cd: 180 };
  const MONSTERS = {
    chaser: { name: '小追追', hp: 1, speed: 0.6, xp: 2, token: 1, drop: 0.08, r: 11, color: '#ff6d6d', behavior: 'chase' },
    patrol: { name: '巡逻蛋', hp: 1, speed: 0.5, xp: 1, token: 1, drop: 0.06, r: 11, color: '#ffd27a', behavior: 'patrol' },
    eater: { name: '噬影虫', hp: 2, speed: 0.48, xp: 4, token: 2, drop: 0.1, r: 12, color: '#d4a5ff', behavior: 'eat' },
    slime: { name: '分裂泥', hp: 2, speed: 0.42, xp: 3, token: 2, drop: 0.1, r: 13, color: '#7affd4', behavior: 'split' },
    king: { name: '回声王', hp: 10, speed: 0.34, xp: 30, token: 10, drop: 1, r: 20, color: '#ff8ad4', behavior: 'king', boss: true },
  };
  const STAGES = [
    { id: 1, name: '训练场', rounds: 2, slowRounds: 2, echo: null, echoLead: 0, walls: [], waves: [[{ kind: 'patrol', count: 2 }], [{ kind: 'patrol', count: 1 }, { kind: 'chaser', count: 1 }]] },
    { id: 2, name: '巡逻带', rounds: 2, slowRounds: 0, echo: 'evade', echoLead: 18, walls: [{ x: 300, y: 0, w: 28, h: 230 }, { x: 632, y: 310, w: 28, h: 230 }], waves: [[{ kind: 'patrol', count: 2 }, { kind: 'chaser', count: 1 }], [{ kind: 'chaser', count: 2 }, { kind: 'patrol', count: 2 }]] },
    { id: 3, name: '噬影廊', rounds: 3, slowRounds: 0, echo: 'predict', echoLead: 28, walls: [{ x: 0, y: 180, w: 420, h: 26 }, { x: 540, y: 330, w: 420, h: 26 }], waves: [[{ kind: 'chaser', count: 2 }, { kind: 'eater', count: 1 }], [{ kind: 'eater', count: 2 }, { kind: 'patrol', count: 1 }], [{ kind: 'chaser', count: 2 }, { kind: 'eater', count: 2 }]] },
    { id: 4, name: '分裂沼', rounds: 3, slowRounds: 0, echo: 'evade', echoLead: 40, walls: [{ x: 180, y: 120, w: 64, h: 64 }, { x: 720, y: 140, w: 64, h: 64 }, { x: 430, y: 360, w: 80, h: 48 }], waves: [[{ kind: 'slime', count: 2 }], [{ kind: 'slime', count: 1 }, { kind: 'chaser', count: 2 }], [{ kind: 'slime', count: 2 }, { kind: 'eater', count: 1 }]] },
    { id: 5, name: '回声王座', rounds: 5, slowRounds: 0, echo: 'predict', echoLead: 56, boss: true, walls: [{ x: 70, y: 36, w: 90, h: 70 }, { x: 800, y: 36, w: 90, h: 70 }, { x: 70, y: 430, w: 90, h: 70 }, { x: 800, y: 430, w: 90, h: 70 }], waves: [[{ kind: 'chaser', count: 2 }, { kind: 'king', count: 1 }], [{ kind: 'patrol', count: 2 }], [{ kind: 'eater', count: 1 }, { kind: 'slime', count: 1 }], [{ kind: 'chaser', count: 2 }], [{ kind: 'patrol', count: 2 }]] },
  ];
  const QUESTS = [
    { id: 'eat-stars', kind: 'daily', name: '吃 20 颗星', goal: 20, metric: 'stars', reward: { token: 20 }, blurb: '今天捡满 20 颗金星' },
    { id: 'kill-8', kind: 'daily', name: '击倒 8 只怪物', goal: 8, metric: 'kills', reward: { token: 12 }, blurb: '小追追、巡逻蛋都算' },
    { id: 'clear-1', kind: 'main', name: '打通训练场', goal: 1, metric: 'clear', stage: 1, reward: { token: 15 }, blurb: '活过第 1 关的每一轮' },
    { id: 'flawless', kind: 'main', name: '无伤过一关', goal: 1, metric: 'flawless', reward: { item: 'reset', count: 1 }, blurb: '一整关都不要掉血' },
    { id: 'king-v2', kind: 'main', name: '穿戴 v2 品质装备击败回声王', goal: 1, metric: 'king-v2', reward: { gear: { tier: 1, primary: 'speed', core: 'predict', extra: null, negative: null } }, blurb: '身上要有一件 v2 或更高' },
  ];

  function bagCap(gear) {
    const level = gear && gear.level ? gear.level : 1;
    return BAG + (level >= 10 ? 3 : 0);
  }

  function xpToNext(level) {
    if (level >= 20) return 0;
    const k = level - 1;
    return 10 + 5 * k + k * k;
  }

  function heartsOf(level, bonusHp) {
    return BASE_HP + (bonusHp || 0) + (level >= 10 ? 1 : 0);
  }

  function levelTitle(level) {
    if (level >= 20) return '前沿行者';
    if (level >= 5) return '微调学徒';
    return '';
  }

  function freshProfile() {
    return {
      level: 1,
      xp: 0,
      unlocked: 1,
      gear: emptyGear(),
      quests: {},
      title: '',
    };
  }

  function cloneGear(gear) {
    return JSON.parse(JSON.stringify(gear || emptyGear()));
  }

  function addXp(profile, amount) {
    const gained = [];
    let bonus = 0;
    profile.xp = (profile.xp || 0) + (amount || 0);
    while (profile.level < 20 && profile.xp >= xpToNext(profile.level)) {
      profile.xp -= xpToNext(profile.level);
      profile.level += 1;
      bonus += 3;
      gained.push(profile.level);
    }
    if (profile.level >= 20) profile.xp = 0;
    profile.title = levelTitle(profile.level);
    if (profile.gear) profile.gear.level = profile.level;
    return { levels: gained, bonus: bonus };
  }

  function stageById(id) {
    return STAGES.filter(function (stage) { return stage.id === id; })[0] || null;
  }

  function slowMul(stage, round) {
    if (stage && stage.slowRounds && round <= stage.slowRounds) return 0.55;
    return 1;
  }

  function stageEcho(stage, round) {
    if (!stage || !stage.echo || !stage.echoLead) return null;
    if (stage.slowRounds && round <= stage.slowRounds) return null;
    return { kind: stage.echo, lead: stage.echoLead, dodge: stage.echoLead, power: stage.echoLead };
  }

  function mergeCore(personal, ambient) {
    if (!personal) return ambient || null;
    if (!ambient) return personal;
    return (personal.power || 0) >= (ambient.power || 0) ? personal : ambient;
  }

  function attackDash(stats, level, campaign) {
    if (!campaign) return stats && stats.dash ? { frames: stats.dash.frames, speed: stats.dash.speed, cd: stats.dash.cd, paid: true } : null;
    const src = stats && stats.dash ? stats.dash : BASE_DASH;
    const cd = Math.max(36, src.cd - (level >= 15 ? 30 : 0));
    return { frames: src.frames, speed: src.speed, cd: cd, paid: !!(stats && stats.dash) };
  }

  function clampBox(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  function pushOut(body, walls, rad) {
    const list = walls || [];
    for (let i = 0; i < list.length; i++) {
      const wall = list[i];
      const hit = body.x > wall.x - rad && body.x < wall.x + wall.w + rad && body.y > wall.y - rad && body.y < wall.y + wall.h + rad;
      if (!hit) continue;
      const left = body.x - (wall.x - rad);
      const right = wall.x + wall.w + rad - body.x;
      const top = body.y - (wall.y - rad);
      const bottom = wall.y + wall.h + rad - body.y;
      const min = Math.min(left, right, top, bottom);
      if (min === left) body.x = wall.x - rad;
      else if (min === right) body.x = wall.x + wall.w + rad;
      else if (min === top) body.y = wall.y - rad;
      else body.y = wall.y + wall.h + rad;
    }
  }

  function makeMonster(kind, stage, round, index, rng) {
    const spec = MONSTERS[kind];
    const angle = rng() * Math.PI * 2;
    const dist = 150 + rng() * 200;
    const mon = {
      id: 'm' + stage.id + 'r' + round + 'i' + index,
      kind: kind,
      name: spec.name,
      x: clampBox(W / 2 + Math.cos(angle) * dist, 48, W - 48),
      y: clampBox(H / 2 + Math.sin(angle) * dist, 48, H - 48),
      hp: spec.hp,
      maxHp: spec.hp,
      r: spec.r,
      color: spec.color,
      xp: spec.xp,
      token: spec.token,
      drop: spec.drop,
      axis: rng() < 0.5 ? 'x' : 'y',
      dir: rng() < 0.5 ? -1 : 1,
      range: 80 + rng() * 40,
      baby: false,
    };
    mon.originX = mon.x;
    mon.originY = mon.y;
    return mon;
  }

  function spawnWave(stage, round, seed, keep) {
    const rng = mulberry32(mixSeed(seed >>> 0, stage.id, 'wave', round));
    const wave = stage.waves[Math.min(round, stage.waves.length) - 1] || stage.waves[0];
    const out = [];
    const kept = (keep || []).filter(function (mon) { return mon.kind === 'king' && mon.hp > 0; });
    kept.forEach(function (mon) { out.push(mon); });
    let index = kept.length;
    for (let g = 0; g < wave.length; g++) {
      const group = wave[g];
      if (group.kind === 'king' && kept.length) continue;
      for (let n = 0; n < group.count; n++) {
        index += 1;
        out.push(makeMonster(group.kind, stage, round, index, rng));
      }
    }
    for (let i = 0; i < out.length; i++) pushOut(out[i], stage.walls, out[i].r);
    return out;
  }

  function nearestPlayer(players, mon) {
    let best = null;
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (player.mode && player.mode !== 'play') continue;
      const dist = Math.hypot(player.x - mon.x, player.y - mon.y);
      if (!best || dist < best.dist) best = { player: player, dist: dist };
    }
    return best && best.player;
  }

  function stepMonsters(monsters, players, ghosts, stage, round, walls) {
    const mul = slowMul(stage, round);
    const scale = unit(W, H) * 0.44 / 60 * mul;
    for (let i = 0; i < monsters.length; i++) {
      const mon = monsters[i];
      const spec = MONSTERS[mon.kind];
      const step = scale * spec.speed;
      if (spec.behavior === 'patrol') {
        if (mon.axis === 'x') mon.x += mon.dir * step;
        else mon.y += mon.dir * step;
        const span = mon.axis === 'x' ? mon.x - mon.originX : mon.y - mon.originY;
        if (Math.abs(span) > mon.range) mon.dir *= -1;
      } else if (spec.behavior === 'eat') {
        let target = null;
        for (let g = 0; g < ghosts.length; g++) {
          const pts = ghosts[g].pts || [];
          if (!pts.length) continue;
          const q = pts[Math.min(pts.length - 1, Math.max(0, ghosts[g].t | 0))];
          if (!q) continue;
          const dist = Math.hypot(q.x - mon.x, q.y - mon.y);
          if (!target || dist < target.dist) target = { x: q.x, y: q.y, dist: dist };
        }
        if (!target) {
          const player = nearestPlayer(players, mon);
          if (player) target = { x: player.x, y: player.y, dist: 1 };
        }
        if (target) {
          const len = Math.hypot(target.x - mon.x, target.y - mon.y) || 1;
          mon.x += (target.x - mon.x) / len * step;
          mon.y += (target.y - mon.y) / len * step;
        }
      } else {
        const player = nearestPlayer(players, mon);
        if (player) {
          const len = Math.hypot(player.x - mon.x, player.y - mon.y) || 1;
          mon.x += (player.x - mon.x) / len * step;
          mon.y += (player.y - mon.y) / len * step;
        }
      }
      pushOut(mon, walls, mon.r);
      mon.x = clampBox(mon.x, mon.r + 2, W - mon.r - 2);
      mon.y = clampBox(mon.y, mon.r + 2, H - mon.r - 2);
    }
  }

  function eatEchoes(monsters, ghosts) {
    for (let i = 0; i < monsters.length; i++) {
      const mon = monsters[i];
      if (mon.kind !== 'eater') continue;
      for (let g = 0; g < ghosts.length; g++) {
        const ghost = ghosts[g];
        const pts = ghost.pts || [];
        ghost.eaten = ghost.eaten || {};
        for (let p = 0; p < pts.length; p += 3) {
          const q = pts[p];
          if (q && Math.hypot(q.x - mon.x, q.y - mon.y) < mon.r + 16) ghost.eaten[p] = 1;
        }
      }
    }
  }

  function kingBarrage(monsters, ghosts, players, shots, step, seed) {
    if (step % 24 !== 0) return;
    for (let i = 0; i < monsters.length; i++) {
      const mon = monsters[i];
      if (mon.kind !== 'king' || mon.hp <= 0) continue;
      const rng = mulberry32(mixSeed(seed >>> 0, step, mon.id, 1));
      let tx = null;
      let ty = null;
      if (ghosts.length) {
        const ghost = ghosts[Math.floor(rng() * ghosts.length)];
        const pts = ghost.pts || [];
        const q = pts.length ? pts[Math.floor(rng() * pts.length)] : null;
        if (q) { tx = q.x; ty = q.y; }
      }
      if (tx == null) {
        const player = nearestPlayer(players, mon);
        if (!player) continue;
        tx = player.x;
        ty = player.y;
      }
      const len = Math.hypot(tx - mon.x, ty - mon.y) || 1;
      shots.push({
        id: 's' + step + '-' + mon.id,
        x: mon.x,
        y: mon.y,
        vx: (tx - mon.x) / len * 3.1,
        vy: (ty - mon.y) / len * 3.1,
        life: 80,
        r: 5,
      });
    }
  }

  function stepShots(shots, walls) {
    for (let i = shots.length - 1; i >= 0; i--) {
      const shot = shots[i];
      shot.x += shot.vx;
      shot.y += shot.vy;
      shot.life -= 1;
      const blocked = (walls || []).some(function (wall) {
        return shot.x > wall.x && shot.x < wall.x + wall.w && shot.y > wall.y && shot.y < wall.y + wall.h;
      });
      if (shot.life <= 0 || blocked || shot.x < 0 || shot.y < 0 || shot.x > W || shot.y > H) shots.splice(i, 1);
    }
  }

  function fightMonsters(player, monsters, shots, dashing) {
    const events = [];
    const reach = (player.r || 11);
    if (dashing) {
      player.dashHits = player.dashHits || {};
      for (let i = 0; i < monsters.length; i++) {
        const mon = monsters[i];
        if (player.dashHits[mon.id]) continue;
        if (Math.hypot(mon.x - player.x, mon.y - player.y) > reach + mon.r) continue;
        player.dashHits[mon.id] = 1;
        mon.hp -= 1;
        mon.lastHit = player.id;
        events.push({ type: 'smack', id: mon.id, x: mon.x, y: mon.y, name: mon.name });
      }
      return events;
    }
    if ((player.iframes || 0) > 0) return events;
    for (let i = 0; i < monsters.length; i++) {
      const mon = monsters[i];
      if (Math.hypot(mon.x - player.x, mon.y - player.y) > reach + mon.r) continue;
      player.hp -= 1;
      player.iframes = 60;
      player.hurt = (player.hurt || 0) + 1;
      events.push({ type: 'bite', id: player.id, hp: player.hp, x: player.x, y: player.y, by: mon.name });
      break;
    }
    if ((player.iframes || 0) > 0) return events;
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      if (Math.hypot(shot.x - player.x, shot.y - player.y) > reach + shot.r) continue;
      player.hp -= 1;
      player.iframes = 60;
      player.hurt = (player.hurt || 0) + 1;
      events.push({ type: 'bite', id: player.id, hp: player.hp, x: player.x, y: player.y, by: '回声王' });
      break;
    }
    return events;
  }

  function babySlime(parent, index) {
    const spec = MONSTERS.slime;
    return {
      id: parent.id + 'b' + index,
      kind: 'slime',
      name: '小泥',
      x: clampBox(parent.x + (index === 0 ? -16 : 16), 20, W - 20),
      y: clampBox(parent.y + 8, 20, H - 20),
      hp: 1,
      maxHp: 1,
      r: 7,
      color: spec.color,
      xp: 1,
      token: 1,
      drop: 0,
      axis: 'x',
      dir: index === 0 ? -1 : 1,
      range: 40,
      originX: parent.x,
      originY: parent.y,
      baby: true,
    };
  }

  function reapMonsters(monsters, seed, step) {
    const drops = [];
    const killed = [];
    for (let i = monsters.length - 1; i >= 0; i--) {
      const mon = monsters[i];
      if (mon.hp > 0) continue;
      monsters.splice(i, 1);
      killed.push(mon);
      const rng = mulberry32(mixSeed(seed >>> 0, step, mon.id, 4));
      drops.push({ id: mon.id + 't', x: mon.x, y: mon.y, kind: 'token', amount: mon.token, xp: mon.xp, name: mon.name });
      if (rng() < mon.drop) {
        const forced = { tier: mon.kind === 'king' ? 1 : 0 };
        drops.push({ id: mon.id + 'g', x: mon.x + 14, y: mon.y, kind: 'gear', item: rollPiece(mixSeed(seed >>> 0, step, mon.id, 8), forced) });
      }
      if (mon.kind === 'slime' && !mon.baby) {
        monsters.push(babySlime(mon, 0));
        monsters.push(babySlime(mon, 1));
      }
    }
    return { drops: drops, killed: killed };
  }

  function takeDrop(gear, profile, drop) {
    if (!drop) return [];
    if (drop.kind === 'gear' && drop.item) {
      if (!gear.equipped[drop.item.slot]) gear.equipped[drop.item.slot] = drop.item;
      else if (gear.bag.length < bagCap(gear)) gear.bag.push(drop.item);
      else gear.t += 4;
      return [];
    }
    const up = addXp(profile, drop.xp || 0);
    gear.t += (drop.amount || 0) + up.bonus;
    if (profile.gear) profile.gear.level = profile.level;
    return up.levels;
  }

  function questSpec(id) {
    return QUESTS.filter(function (quest) { return quest.id === id; })[0] || null;
  }

  function refreshQuests(profile, today) {
    const quests = profile.quests || {};
    Object.keys(quests).forEach(function (id) {
      const spec = questSpec(id);
      const row = quests[id];
      if (!spec || spec.kind !== 'daily' || !row) return;
      if (row.day === today || row.status === 'turned') return;
      row.status = 'open';
      row.progress = 0;
      row.day = today;
    });
  }

  function acceptQuest(profile, id, today) {
    const spec = questSpec(id);
    if (!spec) return fail('unknown');
    profile.quests = profile.quests || {};
    refreshQuests(profile, today);
    const row = profile.quests[id] || { status: 'open', progress: 0, day: today };
    if (row.status === 'accepted' || row.status === 'done' || row.status === 'turned') return fail('quest');
    row.status = 'accepted';
    row.progress = 0;
    row.day = today;
    profile.quests[id] = row;
    return ok();
  }

  function bumpQuest(profile, metric, amount, extra, today) {
    if (!profile) return;
    refreshQuests(profile, today);
    QUESTS.forEach(function (spec) {
      if (spec.metric !== metric) return;
      const row = profile.quests[spec.id];
      if (!row || row.status !== 'accepted') return;
      if (spec.kind === 'daily' && row.day !== today) return;
      if (spec.stage && (!extra || extra.stage !== spec.stage)) return;
      if (metric === 'king-v2' && !(extra && extra.v2)) return;
      row.progress = Math.min(spec.goal, (row.progress || 0) + (amount || 1));
      if (row.progress >= spec.goal) row.status = 'done';
    });
  }

  function turnInQuest(profile, id, today, gear) {
    const spec = questSpec(id);
    if (!spec) return { ok: false, reason: 'unknown', levels: [] };
    refreshQuests(profile, today);
    const row = profile.quests && profile.quests[id];
    if (!row || row.status !== 'done') return { ok: false, reason: 'quest', levels: [] };
    gear = gear || profile.gear;
    let levels = [];
    if (spec.reward.token) {
      gear.t += spec.reward.token;
    } else if (spec.reward.item) {
      for (let n = 0; n < (spec.reward.count || 1); n++) {
        if (countItem(gear, spec.reward.item) > 0 || gear.bag.length < bagCap(gear)) {
          const held = gear.t;
          gear.t = Math.max(gear.t, ITEMS[spec.reward.item].price);
          buyItem(gear, spec.reward.item);
          gear.t = held;
        }
      }
    } else if (spec.reward.gear) {
      const item = rollPiece(mixSeed(id.length, profile.level, id, 2), spec.reward.gear);
      if (!gear.equipped[item.slot]) gear.equipped[item.slot] = item;
      else if (gear.bag.length < bagCap(gear)) gear.bag.push(item);
      else gear.t += item.price;
    }
    row.status = 'turned';
    return { ok: true, reason: '', levels: levels };
  }

  function questBoard(profile, today) {
    refreshQuests(profile, today);
    return QUESTS.map(function (spec) {
      const row = (profile.quests && profile.quests[spec.id]) || { status: 'open', progress: 0 };
      return {
        id: spec.id,
        kind: spec.kind,
        name: spec.name,
        blurb: spec.blurb,
        goal: spec.goal,
        progress: row.progress || 0,
        status: row.status || 'open',
        reward: spec.reward.token ? (spec.reward.token + ' token') : (spec.reward.item ? '重置卡' : '一件 v2 装备'),
      };
    });
  }

  const CAST = [
    { id: 'echo', name: '回声', blurb: '原来的圆身体', color: '#7ad7ff', sheet: '', slots: ['head', 'body', 'accessory'] },
    { id: 'whale', name: '巨鲸', blurb: '一头抹香鲸', color: '#8fd0e8', sheet: 'assets/whale.png', slots: ['head', 'body', 'accessory'] },
  ];
  const SPRITE = { frame: 48, cols: 6, rows: 4, idle: 2, walk: 4, footX: 24, footY: 46, dirs: ['down', 'left', 'right', 'up'] };

  function roleById(id) {
    return CAST.filter(function (role) { return role.id === id; })[0] || null;
  }

  function slotsOf(id) {
    const role = roleById(id);
    return role && role.slots ? role.slots.slice() : SLOTS.slice();
  }

  function wornV2(gear) {
    const slots = ['head', 'body', 'accessory'];
    for (let i = 0; i < slots.length; i++) {
      const item = gear.equipped[slots[i]];
      if (item && item.tier >= 1) return true;
    }
    return false;
  }

  return {
    STEPS: STEPS,
    GRACE: GRACE,
    W: W,
    H: H,
    WARN_BASE: WARN_BASE,
    SHOP_STEPS: SHOP_STEPS,
    SHOP_MIN: SHOP_MIN,
    T_STAR: T_STAR,
    T_ROUND: T_ROUND,
    IFRAMES: IFRAMES,
    BAG: BAG,
    SCORE_STAR: SCORE_STAR,
    SCORE_ROUND: SCORE_ROUND,
    SLOTS: SLOTS,
    SLOT_NAME: SLOT_NAME,
    TIERS: TIERS,
    TRAIN: TRAIN,
    HALLU: HALLU,
    AFFIX: AFFIX,
    CORES: CORES,
    REASON: REASON,
    unit: unit,
    bodyR: bodyR,
    collideDist: collideDist,
    starGoal: starGoal,
    protecting: protecting,
    axis: axis,
    applyMove: applyMove,
    emptyGear: emptyGear,
    findOwned: findOwned,
    statsOf: statsOf,
    setNamer: setNamer,
    rollPiece: rollPiece,
    rollShop: rollShop,
    openStock: openStock,
    trainQuote: trainQuote,
    linesOf: linesOf,
    viewItem: viewItem,
    priceOf: priceOf,
    buy: buy,
    train: train,
    equip: equip,
    unequip: unequip,
    noteSamples: noteSamples,
    echoAt: echoAt,
    hallucinationNudge: hallucinationNudge,
    publicGear: publicGear,
    bagView: bagView,
    offers: offers,
    ITEMS: ITEMS,
    DRAIN: DRAIN,
    countItem: countItem,
    buyItem: buyItem,
    spendItem: spendItem,
    itemCatalog: itemCatalog,
    poweredStats: poweredStats,
    tickDrain: tickDrain,
    payDash: payDash,
    BASE_HP: BASE_HP,
    BASE_DASH: BASE_DASH,
    MONSTERS: MONSTERS,
    STAGES: STAGES,
    QUESTS: QUESTS,
    bagCap: bagCap,
    xpToNext: xpToNext,
    heartsOf: heartsOf,
    levelTitle: levelTitle,
    freshProfile: freshProfile,
    cloneGear: cloneGear,
    addXp: addXp,
    stageById: stageById,
    slowMul: slowMul,
    stageEcho: stageEcho,
    mergeCore: mergeCore,
    attackDash: attackDash,
    pushOut: pushOut,
    spawnWave: spawnWave,
    stepMonsters: stepMonsters,
    eatEchoes: eatEchoes,
    kingBarrage: kingBarrage,
    stepShots: stepShots,
    fightMonsters: fightMonsters,
    reapMonsters: reapMonsters,
    takeDrop: takeDrop,
    acceptQuest: acceptQuest,
    bumpQuest: bumpQuest,
    turnInQuest: turnInQuest,
    questBoard: questBoard,
    wornV2: wornV2,
    CAST: CAST,
    SPRITE: SPRITE,
    roleById: roleById,
    slotsOf: slotsOf,
  };
});
