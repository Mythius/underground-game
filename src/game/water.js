import { clamp, randRange } from '../utils/math.js';

// Rivers are polylines with a width; lakes are circles. Roads that cross water are bridges.
// Keep the distance and push-out maths in sync with the copies in public/index.html.

/** Winding rivers running edge to edge, alternating north–south and west–east. */
export function generateRivers(width, height, count) {
  const rivers = [];
  for (let i = 0; i < count; i++) {
    const southward = i % 2 === 0;
    const heading = southward ? Math.PI / 2 : 0;
    let x = southward ? randRange(0.15, 0.85) * width : -150;
    let y = southward ? -150 : randRange(0.15, 0.85) * height;
    let dir = heading;
    const points = [];
    while (x > -200 && y > -200 && x < width + 200 && y < height + 200 && points.length < 200) {
      points.push([Math.round(x), Math.round(y)]);
      // Meander, but never turn back on itself.
      dir = heading + clamp(dir - heading + randRange(-0.35, 0.35), -0.75, 0.75);
      x += Math.cos(dir) * 250;
      y += Math.sin(dir) * 250;
    }
    points.push([Math.round(x), Math.round(y)]);
    rivers.push({ points, width: Math.round(randRange(170, 250)) });
  }
  return rivers;
}

export function generateLakes(width, height, count) {
  const lakes = [];
  for (let i = 0; i < count; i++) {
    lakes.push({ x: Math.round(randRange(0.15, 0.85) * width), y: Math.round(randRange(0.15, 0.85) * height), r: Math.round(randRange(250, 450)) });
  }
  return lakes;
}

/** Closest point on segment a-b to p. */
function closestOnSegment(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
  return [ax + t * dx, ay + t * dy];
}

/**
 * How far (x, y) is from dry land: negative inside water, positive outside.
 * Also returns the nearest point on the water's centre (line or lake centre), to push things out.
 */
// Rivers are long polylines; each gets an index of 16-segment chunks with bounding boxes (built once),
// so a lookup only looks closely at the chunks near the point.
const chunkIndex = new WeakMap();
function chunksOf(river) {
  let chunks = chunkIndex.get(river);
  if (chunks) return chunks;
  chunks = [];
  const pts = river.points;
  for (let i = 0; i < pts.length - 1; i += 16) {
    const end = Math.min(i + 16, pts.length - 1);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = i; k <= end; k++) {
      x0 = Math.min(x0, pts[k][0]); x1 = Math.max(x1, pts[k][0]);
      y0 = Math.min(y0, pts[k][1]); y1 = Math.max(y1, pts[k][1]);
    }
    chunks.push({ from: i, to: end, x0, y0, x1, y1 });
  }
  chunkIndex.set(river, chunks);
  return chunks;
}

export function waterDistance(water, x, y) {
  let best = { d: Infinity, cx: x, cy: y };
  for (const river of water.rivers) {
    const pts = river.points;
    const half = river.width / 2;
    for (const c of chunksOf(river)) {
      const m = half + 300;
      if (x < c.x0 - m || x > c.x1 + m || y < c.y0 - m || y > c.y1 + m) continue;
      for (let i = c.from; i < c.to; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[i + 1];
        // Cheap reject before the exact distance.
        if (x < Math.min(ax, bx) - half - 300 || x > Math.max(ax, bx) + half + 300 || y < Math.min(ay, by) - half - 300 || y > Math.max(ay, by) + half + 300) continue;
        const [cx, cy] = closestOnSegment(ax, ay, bx, by, x, y);
        const d = Math.hypot(x - cx, y - cy) - half;
        if (d < best.d) best = { d, cx, cy };
      }
    }
  }
  for (const lake of water.lakes) {
    const d = Math.hypot(x - lake.x, y - lake.y) - lake.r;
    if (d < best.d) best = { d, cx: lake.x, cy: lake.y };
  }
  return best;
}

const onRoad = (roads, x, y) => roads.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);

/** In water and not on a bridge. With `frozen` (winter) the lakes are ice you walk on, so they don't count. */
export function isSwimming(water, roads, x, y, frozen = false) {
  return waterDistance(frozen ? { rivers: water.rivers, lakes: [] } : water, x, y).d < 0 && !onRoad(roads, x, y);
}

/** On a frozen lake (only in winter). */
export function onIce(water, x, y, frozen) {
  return frozen && water.lakes.some((l) => Math.hypot(x - l.x, y - l.y) < l.r);
}

/** Pushes circle c ({x, y, r}) back onto land unless it's on a bridge. Returns true if it moved. */
export function pushOutOfWater(water, roads, c) {
  if (onRoad(roads, c.x, c.y)) return false;
  const { d, cx, cy } = waterDistance(water, c.x, c.y);
  const overlap = c.r - d;
  if (overlap <= 0) return false;
  let nx = c.x - cx;
  let ny = c.y - cy;
  const len = Math.hypot(nx, ny);
  if (len < 1e-6) [nx, ny] = [1, 0];
  else [nx, ny] = [nx / len, ny / len];
  c.x += nx * overlap;
  c.y += ny * overlap;
  return true;
}

/**
 * Bridge rails: thin solid strips along each road edge wherever that edge crosses water,
 * reaching just past the banks and stopping at any road that crosses this one.
 */
export function generateRails(roads, water, { thickness = 10, step = 10, bankMargin = 14 } = {}) {
  const rails = [];
  for (const road of roads) {
    const horizontal = road.w > road.h;
    const length = horizontal ? road.w : road.h;
    // Each rail sits on the road edge, mostly outside the roadway.
    const edges = horizontal ? [road.y - thickness + 2, road.y + road.h - 2] : [road.x - thickness + 2, road.x + road.w - 2];
    const lineAt = (edge) => edge + (edge < (horizontal ? road.y : road.x) ? thickness - 2 : 2); // the edge itself
    for (const edge of edges) {
      const across = lineAt(edge);
      let start = null;
      for (let s = 0; s <= length; s += step) {
        const x = horizontal ? road.x + s : across;
        const y = horizontal ? across : road.y + s;
        const inOtherRoad = roads.some((r) => r !== road && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
        const wet = !inOtherRoad && waterDistance(water, x, y).d < bankMargin;
        if (wet && start === null) start = s;
        if ((!wet || s + step > length) && start !== null) {
          const end = wet ? s : s - step;
          if (end > start) {
            rails.push(horizontal ? { x: road.x + start, y: edge, w: end - start, h: thickness } : { x: edge, y: road.y + start, w: thickness, h: end - start });
          }
          start = null;
        }
      }
    }
  }
  return rails;
}
