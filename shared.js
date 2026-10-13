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
  const SCORE_STAR = 10;
  const SCORE_ROUND = 50;

  const SLOTS = ['head', 'body', 'accessory'];
  const SLOT_NAME = { head: '头', body: '身', accessory: '饰品' };
  const GEAR_ORDER = ['boots', 'shield', 'glasses', 'magnet', 'dash', 'helm', 'clover'];

  const GEAR = {
    boots: {
      id: 'boots', name: '轻风靴', slot: 'body', mark: '靴', color: '#b8ff7a', price: 8,
      levels: [{ speed: 1.18 }, { speed: 1.36 }, { speed: 1.55 }],
    },
    shield: {
      id: 'shield', name: '回声护盾', slot: 'accessory', mark: '盾', color: '#7ad7ff', price: 15,
      levels: [{ blocks: 1 }, { blocks: 2 }, { blocks: 3 }],
    },
    glasses: {
      id: 'glasses', name: '淡影眼镜', slot: 'head', mark: '镜', color: '#d4a5ff', price: 12,
      levels: [{ warn: 130 }, { warn: 190 }, { warn: 250 }],
    },
    magnet: {
      id: 'magnet', name: '星星磁铁', slot: 'accessory', mark: '磁', color: '#ffd27a', price: 10,
      levels: [
        { magnet: 1.8, attract: 90, pull: 10 },
        { magnet: 2.5, attract: 140, pull: 16 },
        { magnet: 3.4, attract: 200, pull: 24 },
      ],
    },
    dash: {
      id: 'dash', name: '冲刺手套', slot: 'body', mark: '冲', color: '#ff8ad4', price: 12,
      levels: [
        { dash: { frames: 8, speed: 2.6, cd: 180 } },
        { dash: { frames: 10, speed: 3.0, cd: 120 } },
        { dash: { frames: 12, speed: 3.4, cd: 72 } },
      ],
    },
    helm: {
      id: 'helm', name: '铁头盔', slot: 'head', mark: '盔', color: '#d8d2c8', price: 10,
      levels: [{ hp: 1 }, { hp: 2 }, { hp: 3 }],
    },
    clover: {
      id: 'clover', name: '幸运草', slot: 'accessory', mark: '草', color: '#7affd4', price: 14,
      levels: [{ score: 1.5 }, { score: 2 }, { score: 3 }],
    },
  };

  const REASON = {
    not_enough_T: 'T 币不够',
    bag_full: '背包满了',
    max_level: '已经 3 级',
    not_owned: '还没有这件',
    owned: '已经有了，去升级',
    shop_only: '只能在轮间商店操作',
    unknown: '没有这件装备',
    bad_slot: '槽位不对',
  };

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
      equipped: { head: null, body: null, accessory: null },
    };
  }

  function findOwned(gear, id) {
    for (let i = 0; i < SLOTS.length; i++) {
      const slot = SLOTS[i];
      const item = gear.equipped[slot];
      if (item && item.id === id) return { where: 'equipped', slot, item };
    }
    for (let i = 0; i < gear.bag.length; i++) {
      if (gear.bag[i].id === id) return { where: 'bag', index: i, item: gear.bag[i] };
    }
    return null;
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
      maxHp: 1,
    };
    for (let i = 0; i < SLOTS.length; i++) {
      const item = gear.equipped[SLOTS[i]];
      if (!item) continue;
      const def = GEAR[item.id];
      const lv = def && def.levels[item.level - 1];
      if (!lv) continue;
      if (lv.speed) stats.speed = lv.speed;
      if (lv.blocks) stats.blocks = lv.blocks;
      if (lv.warn) stats.warn = lv.warn;
      if (lv.magnet) stats.magnet = lv.magnet;
      if (lv.attract) stats.attract = lv.attract;
      if (lv.pull) stats.pull = lv.pull;
      if (lv.dash) stats.dash = lv.dash;
      if (lv.hp) stats.bonusHp = lv.hp;
      if (lv.score) stats.score = lv.score;
    }
    stats.maxHp = 1 + stats.bonusHp;
    return stats;
  }

  function describe(id, level) {
    const def = GEAR[id];
    const lv = def && def.levels[level - 1];
    if (!lv) return '';
    if (id === 'boots') return '移速 ×' + lv.speed.toFixed(2);
    if (id === 'shield') return '每轮抵挡 ' + lv.blocks + ' 次回声';
    if (id === 'glasses') return '提示提前到轮末 ' + (lv.warn / 60).toFixed(1) + ' 秒';
    if (id === 'magnet') return '拾取 ×' + lv.magnet + '，吸引 ' + lv.attract + 'px';
    if (id === 'dash') return '冲刺 ' + lv.dash.frames + ' 步 ×' + lv.dash.speed + '，冷却 ' + (lv.dash.cd / 60).toFixed(1) + ' 秒';
    if (id === 'helm') return '最大生命 ' + (1 + lv.hp);
    if (id === 'clover') return '得分 ×' + lv.score;
    return '';
  }

  function ok() { return { ok: true, reason: '' }; }
  function fail(reason) { return { ok: false, reason: reason }; }

  function buy(gear, id) {
    const def = GEAR[id];
    if (!def) return fail('unknown');
    if (findOwned(gear, id)) return fail('owned');
    if (gear.t < def.price) return fail('not_enough_T');
    const item = { id: id, level: 1 };
    if (!gear.equipped[def.slot]) {
      gear.t -= def.price;
      gear.equipped[def.slot] = item;
      return ok();
    }
    if (gear.bag.length >= BAG) return fail('bag_full');
    gear.t -= def.price;
    gear.bag.push(item);
    return ok();
  }

  function upgrade(gear, id) {
    const owned = findOwned(gear, id);
    if (!owned) return fail('not_owned');
    if (owned.item.level >= 3) return fail('max_level');
    const cost = GEAR[id].price * (owned.item.level + 1);
    if (gear.t < cost) return fail('not_enough_T');
    gear.t -= cost;
    owned.item.level += 1;
    return ok();
  }

  function buyOrUpgrade(gear, id) {
    if (findOwned(gear, id)) return upgrade(gear, id);
    return buy(gear, id);
  }

  function equip(gear, id) {
    const owned = findOwned(gear, id);
    if (!owned) return fail('not_owned');
    if (owned.where === 'equipped') return ok();
    const def = GEAR[id];
    const prev = gear.equipped[def.slot];
    gear.bag.splice(owned.index, 1);
    if (prev) gear.bag.push(prev);
    gear.equipped[def.slot] = owned.item;
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

  function publicGear(gear) {
    const out = [];
    for (let i = 0; i < SLOTS.length; i++) {
      const slot = SLOTS[i];
      const item = gear.equipped[slot];
      if (!item) continue;
      const def = GEAR[item.id];
      out.push({
        slot: slot,
        id: item.id,
        name: def.name,
        level: item.level,
        mark: def.mark,
        color: def.color,
      });
    }
    return out;
  }

  function bagView(gear) {
    return gear.bag.map(function (item) {
      const def = GEAR[item.id];
      return {
        id: item.id,
        level: item.level,
        name: def.name,
        mark: def.mark,
        color: def.color,
        slot: def.slot,
      };
    });
  }

  function offers(gear) {
    return GEAR_ORDER.map(function (id) {
      const def = GEAR[id];
      const owned = findOwned(gear, id);
      const level = owned ? owned.item.level : 0;
      const next = Math.min(3, level + 1);
      let action = 'buy';
      let cost = def.price;
      if (level >= 3) {
        action = 'max';
        cost = 0;
      } else if (level > 0) {
        action = 'upgrade';
        cost = def.price * (level + 1);
      }
      return {
        id: id,
        name: def.name,
        slot: def.slot,
        slotName: SLOT_NAME[def.slot],
        mark: def.mark,
        color: def.color,
        price: def.price,
        level: level,
        equipped: !!(owned && owned.where === 'equipped'),
        action: action,
        cost: cost,
        nextText: describe(id, next),
        nowText: level ? describe(id, level) : '',
      };
    });
  }

  function upgradeCost(id, level) {
    const def = GEAR[id];
    if (!def || level < 1 || level >= 3) return 0;
    return def.price * (level + 1);
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
    GEAR_ORDER: GEAR_ORDER,
    GEAR: GEAR,
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
    describe: describe,
    buy: buy,
    upgrade: upgrade,
    buyOrUpgrade: buyOrUpgrade,
    equip: equip,
    unequip: unequip,
    publicGear: publicGear,
    bagView: bagView,
    offers: offers,
    upgradeCost: upgradeCost,
  };
});
