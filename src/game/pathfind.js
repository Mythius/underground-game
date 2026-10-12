import { segmentRectHit } from '../utils/math.js';

// Finding a way round walls on foot, for the NPCs who walk to a spot (the hands at the work sites,
// the convicts, the cook): a straight line when it's clear, otherwise A* over a fine grid of the
// walls near the trip (fences, huts, tree trunks, closed doors), pulled taut into a few waypoints.
// `opens` (door -> bool) says which closed doors the walker opens as they go (the Militsiya open any
// public door): those don't count as walls.

const CELL = 10; // grid size (fine enough for a body to find the gap between a fence and a hut)
const MARGIN = 400; // how far outside the from–to box a detour may go (three times that, failing)
const MAX_CELLS = 600000; // trips longer than this just head straight there
const MAX_EXPAND = 5000; // cells looked at per search (an unreachable spot gives up after this, a few ms)

/** Walls near (x, y) within `range` that are in this walker's way. */
function wallsFor(world, x, y, range, opens) {
  if (!opens) return world.wallsNear(x, y, range);
  const out = [];
  for (const e of world.wallGrid.query(x, y, range)) if (!e.door || (!e.door.open && !opens(e.door))) out.push(e.rect);
  return out;
}

/** Is the straight walk from a to b clear of walls for a body of radius r? */
export function clearWalk(world, ax, ay, bx, by, r, opens = null) {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(len / 200));
  const seen = new Set();
  for (let i = 0; i <= steps; i++) {
    const x = ax + ((bx - ax) * i) / steps, y = ay + ((by - ay) * i) / steps;
    for (const w of wallsFor(world, x, y, 100 + r, opens)) {
      if (seen.has(w)) continue;
      seen.add(w);
      if (segmentRectHit(ax, ay, bx, by, w, r) !== null) return false;
    }
  }
  return true;
}

/** A binary min-heap of grid cells keyed by f. */
class Heap {
  constructor() { this.ids = []; this.keys = []; }
  get size() { return this.ids.length; }
  push(id, key) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up] <= key) break;
      ids[i] = ids[up]; keys[i] = keys[up];
      i = up;
    }
    ids[i] = id; keys[i] = key;
  }
  pop() {
    const { ids, keys } = this;
    const top = ids[0];
    const id = ids.pop(), key = keys.pop();
    if (ids.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= ids.length) break;
        if (c + 1 < ids.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c]; keys[i] = keys[c];
        i = c;
      }
      ids[i] = id; keys[i] = key;
    }
    return top;
  }
}

// Scratch space shared by every search, grown as needed: a cell's entries only count when its stamp
// is the current search's, so nothing needs clearing (a search costs what it looks at, not its box).
let cap = 0, stamp = null, info = null, gArr = null, parentArr = null, gen = 0;
function scratch(n) {
  if (n > cap) {
    cap = n;
    stamp = new Uint32Array(n);
    info = new Uint8Array(n); // 1 free · 2 blocked, +4 once done
    gArr = new Float32Array(n);
    parentArr = new Int32Array(n);
    gen = 0;
  }
  if (++gen === 0xffffffff) { stamp.fill(0); gen = 1; }
}

const DC = [1, -1, 0, 0, 1, 1, -1, -1], DR = [0, 0, 1, -1, 1, -1, 1, -1], COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
const GREED = 1.5; // weighted A*: leans toward the target (far fewer cells looked at; the path's pulled taut after anyway)

/**
 * Waypoints from (sx, sy) to within `near` of (tx, ty) for a body of radius r, round the walls — or
 * null if there's no way there (or it's too far to search).
 */
export function findPath(world, sx, sy, tx, ty, r, near, opens = null) {
  const first = search(world, sx, sy, tx, ty, r, near, opens, MARGIN);
  if (first !== 'boxed') return first;
  const wide = search(world, sx, sy, tx, ty, r, near, opens, MARGIN * 3); // (the way round runs outside the box: look wider)
  return Array.isArray(wide) ? wide : null;
}

/** One A* search inside the from–to box grown by `margin`: waypoints, null, or 'boxed' (no way inside the box). */
function search(world, sx, sy, tx, ty, r, near, opens, margin) {
  const x0 = Math.max(0, Math.min(sx, tx) - margin), y0 = Math.max(0, Math.min(sy, ty) - margin);
  const x1 = Math.min(world.width, Math.max(sx, tx) + margin), y1 = Math.min(world.height, Math.max(sy, ty) + margin);
  const cols = Math.ceil((x1 - x0) / CELL), rows = Math.ceil((y1 - y0) / CELL);
  if (cols * rows > MAX_CELLS || cols <= 0 || rows <= 0) return null;
  scratch(cols * rows);
  const cx = (i) => x0 + ((i % cols) + 0.5) * CELL, cy = (i) => y0 + (Math.floor(i / cols) + 0.5) * CELL;
  // The walls near each 80px patch of the box, looked up the first time the search reaches it.
  const B = 80, bc = Math.ceil((x1 - x0) / B), buckets = new Map();
  const wallsAt = (x, y) => {
    const bx = Math.floor((x - x0) / B), by = Math.floor((y - y0) / B), k = by * bc + bx;
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = wallsFor(world, x0 + (bx + 0.5) * B, y0 + (by + 0.5) * B, B * 0.71 + r, opens)));
    return list;
  };
  const free = (i) => {
    if (stamp[i] !== gen) {
      const x = cx(i), y = cy(i);
      stamp[i] = gen;
      info[i] = 1;
      for (const w of wallsAt(x, y)) { // (does a body here overlap it?)
        const dx = x - (x < w.x ? w.x : x > w.x + w.w ? w.x + w.w : x), dy = y - (y < w.y ? w.y : y > w.y + w.h ? w.y + w.h : y);
        if (dx * dx + dy * dy < r * r) { info[i] = 2; break; }
      }
      gArr[i] = Infinity;
      parentArr[i] = -1;
    }
    return (info[i] & 3) === 1;
  };
  const cellOf = (x, y) => Math.min(rows - 1, Math.max(0, Math.floor((y - y0) / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.floor((x - x0) / CELL)));
  // Start from the nearest free cell (someone pressed up against a wall sits in a blocked one).
  let start = cellOf(sx, sy);
  if (!free(start)) {
    const c0 = start % cols, r0 = Math.floor(start / cols);
    let best = -1, bestD = Infinity;
    for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) {
      const c = c0 + dc, rr = r0 + dr;
      if (c < 0 || rr < 0 || c >= cols || rr >= rows) continue;
      const i = rr * cols + c, d = Math.hypot(cx(i) - sx, cy(i) - sy);
      if (d < bestD && free(i)) [best, bestD] = [i, d];
    }
    if (best < 0) return null;
    start = best;
  }
  const goalR = Math.max(near, CELL * 0.75);
  const h = (i) => { const dx = cx(i) - tx, dy = cy(i) - ty; return (Math.max(0, Math.sqrt(dx * dx + dy * dy) - goalR) / CELL) * GREED; };
  const open = new Heap();
  gArr[start] = 0;
  open.push(start, h(start));
  let goal = -1, expanded = 0, boxed = false;
  while (open.size && expanded < MAX_EXPAND) {
    const i = open.pop();
    if (info[i] & 4) continue;
    info[i] |= 4;
    expanded++;
    const gx = cx(i) - tx, gy = cy(i) - ty;
    if (gx * gx + gy * gy <= goalR * goalR) { goal = i; break; }
    const c = i % cols, rr = (i - c) / cols;
    for (let k = 0; k < 8; k++) {
      const dc = DC[k], dr = DR[k], nc = c + dc, nr = rr + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) { boxed = true; continue; }
      const j = nr * cols + nc;
      if (!free(j) || info[j] & 4) continue;
      if (dc && dr && (!free(rr * cols + nc) || !free(nr * cols + c))) continue; // (no cutting corners)
      const ng = gArr[i] + COST[k];
      if (ng >= gArr[j]) continue;
      gArr[j] = ng;
      parentArr[j] = i;
      open.push(j, ng + h(j));
    }
  }
  if (goal < 0) return boxed && expanded < MAX_EXPAND ? 'boxed' : null; // (the search ran into the edge of its box)
  const cells = [];
  for (let i = goal; i !== -1; i = parentArr[i]) cells.unshift({ x: cx(i), y: cy(i) });
  // Pull it taut: from each waypoint, on to the furthest one in a clear straight line.
  const pts = [];
  let at = { x: sx, y: sy };
  for (let k = 0; k < cells.length;) {
    let j = k;
    while (j + 1 < cells.length && clearWalk(world, at.x, at.y, cells[j + 1].x, cells[j + 1].y, r - 2, opens)) j++;
    pts.push(cells[j]);
    at = cells[j];
    k = j + 1;
  }
  return pts;
}

/**
 * Where a walker of radius `body` should head next on the way to (tx, ty): the target itself when the
 * straight walk is clear, or the next waypoint round the walls (kept on the walker as `walkPath`).
 * Worked out again when the target moves, or when they've been stuck a second (`walker.stuckFor`: a
 * door shut in their face, a car parked in the way).
 */
export function nextWaypoint(world, walker, tx, ty, near, dt, body, opens = null) {
  let r = walker.walkPath;
  const moved = r && Math.hypot(r.tx - tx, r.ty - ty) > 40 && (!r.pts.length || r.age > 0.5); // (a moving target: a found path is kept a moment)
  const stale = !r || moved || ((walker.stuckFor ?? 0) > 1 && r.age > (r.failed ? r.retry : 1.5));
  if (stale) {
    r = walker.walkPath = { tx, ty, pts: [], age: 0, failed: false, retry: 4 + Math.random() * 3 }; // (failed ones try again now and then, not all at once)
    if (!clearWalk(world, walker.x, walker.y, tx, ty, body - 3, opens)) {
      const pts = findPath(world, walker.x, walker.y, tx, ty, body - 2, near, opens);
      if (pts) r.pts = pts;
      else r.failed = true; // (no way round: head straight for it, and try again in a while)
    }
  }
  r.age += dt;
  while (r.pts.length && Math.hypot(r.pts[0].x - walker.x, r.pts[0].y - walker.y) < 6) r.pts.shift();
  return r.pts[0] ?? { x: tx, y: ty };
}
