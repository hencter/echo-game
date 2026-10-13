// Movement, stars, and the round-start grace rule shared with index.html.
// Online matches run these on the server. Solo play keeps its own copy and
// does not load this file.

const STEPS = 360;
const GRACE = 60;
const W = 960;
const H = 540;

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

// Same predicate as index.html protecting(): echoes exist and the step is
// still inside the opening 60 ticks. The server is the only place that
// decides this for an online match.
function protecting(ghostCount, t) {
  return ghostCount > 0 && t < GRACE;
}

function axis(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

function applyMove(body, input, w, h) {
  const dt = 1 / 60;
  const u = unit(w, h);
  const max = u * 0.44;
  const rad = bodyR(w, h);
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
  const m = rad + 2;
  body.x = Math.max(m, Math.min(w - m, body.x));
  body.y = Math.max(m, Math.min(h - m, body.y));
}

module.exports = {
  STEPS,
  GRACE,
  W,
  H,
  unit,
  bodyR,
  collideDist,
  starGoal,
  protecting,
  axis,
  applyMove,
};
