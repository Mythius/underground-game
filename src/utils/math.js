export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export const distSq = (ax, ay, bx, by) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

export const randRange = (min, max) => min + Math.random() * (max - min);

export const round1 = (v) => Math.round(v * 10) / 10;

/** Squared distance from point (x, y) to the segment (ax, ay)-(bx, by). */
export const segmentDistSq = (ax, ay, bx, by, x, y) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? clamp(((x - ax) * dx + (y - ay) * dy) / lenSq, 0, 1) : 0;
  return distSq(x, y, ax + t * dx, ay + t * dy);
};

/**
 * Pushes circle `p` (with `x`, `y`) of radius r out of rectangle `rect`. Returns true if it moved.
 * Keep in sync with pushOut() in public/index.html.
 */
export function pushCircleOutOfRect(p, r, rect) {
  const cx = clamp(p.x, rect.x, rect.x + rect.w);
  const cy = clamp(p.y, rect.y, rect.y + rect.h);
  const dx = p.x - cx;
  const dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return false;
  if (d2 > 0) {
    const d = Math.sqrt(d2);
    p.x += (dx / d) * (r - d);
    p.y += (dy / d) * (r - d);
    return true;
  }
  // Centre is inside the rectangle: leave by the nearest edge.
  const left = p.x - rect.x;
  const right = rect.x + rect.w - p.x;
  const top = p.y - rect.y;
  const bottom = rect.y + rect.h - p.y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) p.x = rect.x - r;
  else if (m === right) p.x = rect.x + rect.w + r;
  else if (m === top) p.y = rect.y - r;
  else p.y = rect.y + rect.h + r;
  return true;
}

/** Where along segment (x0,y0)-(x1,y1), as 0..1, it first touches `rect` grown by `pad`; null if it misses. */
export function segmentRectHit(x0, y0, x1, y1, rect, pad = 0) {
  let tmin = 0;
  let tmax = 1;
  const axes = [
    [x0, x1 - x0, rect.x - pad, rect.x + rect.w + pad],
    [y0, y1 - y0, rect.y - pad, rect.y + rect.h + pad],
  ];
  for (const [p0, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (p0 < lo || p0 > hi) return null;
      continue;
    }
    let t1 = (lo - p0) / d;
    let t2 = (hi - p0) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
