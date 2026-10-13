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

  function starGoal(round) {
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
    if (gear.bag.length >= BAG) return fail('bag_full');
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
    if (gear.bag.length >= BAG) return fail('bag_full');
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
    if (gear.bag.length >= BAG) return fail('bag_full');
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
  };
});
