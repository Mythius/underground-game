import { randRange, segmentDistSq } from '../utils/math.js';
import { waterDistance } from './water.js';

// Static scenery generated once per room and sent to clients in the welcome message.
//   roads: paved rectangles crossing the map (buildings and trees avoid them)
//   paths: dirt trails out of every outside door, drawn as a cubic curve from → c1 → c2 → to
//   trees: a solid trunk (a wall rect) under a canopy that hides whoever stands beneath it

const overlaps = (a, b, margin = 0) =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;

/** A grid of roads across the map, about one every 2200 units each way, each nudged off its even spacing. */
export function generateRoads(width, height, roadWidth = 270) {
  const roads = [];
  const across = (size) => {
    const n = Math.max(2, Math.round(size / 2200));
    return Array.from({ length: n }, (_, k) => Math.round(((k + 0.5) / n + randRange(-0.12, 0.12) / n) * size - roadWidth / 2));
  };
  for (const y of across(height)) roads.push({ x: 0, y, w: width, h: roadWidth });
  for (const x of across(width)) roads.push({ x, y: 0, w: roadWidth, h: height });
  return roads;
}

/** Point on the cubic curve from → c1 → c2 → to at t (0..1). */
export function bezierPoint({ from, c1, c2, to }, t) {
  const u = 1 - t;
  const f = (i) => u * u * u * from[i] + 3 * u * u * t * c1[i] + 3 * u * t * t * c2[i] + t * t * t * to[i];
  return [f(0), f(1)];
}

/**
 * A dirt trail out of every outside door. Doors facing a road get a curving trail all the way to it;
 * doors facing away get a short apron, so every entrance is marked.
 */
export function generatePaths(buildings, roads) {
  const paths = [];
  const round = ([x, y]) => [Math.round(x), Math.round(y)];
  for (const b of buildings) {
    for (const d of b.doors ?? []) {
      if (!d.exterior) continue;
      const width = Math.min(Math.max(d.w, d.h) * 0.8, 90);
      // Start inside the doorway so the trail meets the floor.
      const sx = d.x + d.w / 2;
      const sy = d.y + d.h / 2;

      let best = null;
      for (const r of roads) {
        const horizontal = r.w > r.h;
        const x = horizontal ? sx : sx < r.x ? r.x : r.x + r.w;
        const y = horizontal ? (sy < r.y ? r.y : r.y + r.h) : sy;
        const dist = Math.hypot(x - sx, y - sy);
        // The trail meets the road head-on, so remember which way the road edge faces.
        const rn = horizontal ? [0, sy < r.y ? -1 : 1] : [sx < r.x ? -1 : 1, 0];
        if (!best || dist < best.dist) best = { x, y, dist, rn };
      }
      const facing = best && ((best.x - sx) * d.nx + (best.y - sy) * d.ny) / best.dist;
      if (best && best.dist < 1200 && facing > 0.2) {
        const pull = Math.min(best.dist * 0.45, 260);
        paths.push({
          from: round([sx, sy]),
          c1: round([sx + d.nx * pull, sy + d.ny * pull]),
          c2: round([best.x + best.rn[0] * pull, best.y + best.rn[1] * pull]),
          to: round([best.x - best.rn[0] * 10, best.y - best.rn[1] * 10]), // tuck the end under the road edge
          width,
        });
      } else {
        const len = 90;
        const end = [sx + d.nx * len, sy + d.ny * len];
        paths.push({ from: round([sx, sy]), c1: round([sx + d.nx * len * 0.33, sy + d.ny * len * 0.33]), c2: round([sx + d.nx * len * 0.66, sy + d.ny * len * 0.66]), to: round(end), width });
      }
    }
  }
  return paths;
}

function nearPath(x, y, paths, margin) {
  return paths.some((p) => {
    const reach = (p.width / 2 + margin) ** 2;
    let prev = p.from;
    for (let i = 1; i <= 16; i++) {
      const next = bezierPoint(p, i / 16);
      if (segmentDistSq(prev[0], prev[1], next[0], next[1], x, y) < reach) return true;
      prev = next;
    }
    return false;
  });
}

const TRUNK = 18;

/** A tree: a solid trunk (wall rect) under a canopy. `seed` gives each one its own shape. */
export function makeTree(x, y, canopy, seed = Math.floor(Math.random() * 1e6)) {
  return {
    x: Math.round(x),
    y: Math.round(y),
    canopy: Math.round(canopy),
    trunk: { x: Math.round(x - TRUNK / 2), y: Math.round(y - TRUNK / 2), w: TRUNK, h: TRUNK },
    seed,
  };
}

/** Street lamps about every 450 units along alternating road edges, skipping junctions and water. */
export function generateLamps(roads, water) {
  const out = [];
  for (const r of roads) {
    const horizontal = r.w > r.h;
    const len = horizontal ? r.w : r.h;
    for (let s = 200, i = 0; s < len - 200; s += 450, i++) {
      const side = i % 2 ? -1 : 1;
      const x = horizontal ? r.x + s : side > 0 ? r.x + r.w + 14 : r.x - 14;
      const y = horizontal ? (side > 0 ? r.y + r.h + 14 : r.y - 14) : r.y + s;
      if (roads.some((o) => o !== r && x > o.x - 30 && x < o.x + o.w + 30 && y > o.y - 30 && y < o.y + o.h + 30)) continue;
      if (waterDistance(water, x, y).d < 20) continue;
      out.push({ x: Math.round(x), y: Math.round(y) });
    }
  }
  return out;
}

/**
 * Sewer vents: iron grates in the pavement at the kerb, along the town's roads (nothing comes of
 * them — walk up, E, and you hear or smell something down there). `isClear(rect)` keeps them off
 * buildings, lots, dumpsters and the like.
 */
export function generateVents(roads, city, isClear) {
  const out = [];
  const S = 30;
  for (const r of roads) {
    const horizontal = r.w > r.h;
    const len = horizontal ? r.w : r.h;
    for (let s = 150 + Math.random() * 300; s < len - 150; s += 550 + Math.random() * 500) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const cx = horizontal ? r.x + s : side > 0 ? r.x + r.w + 20 : r.x - 20;
      const cy = horizontal ? (side > 0 ? r.y + r.h + 20 : r.y - 20) : r.y + s;
      if (city && !(cx > city.x && cx < city.x + city.w && cy > city.y && cy < city.y + city.h)) continue; // (town only)
      const v = { x: Math.round(cx - S / 2), y: Math.round(cy - S / 2), w: S, h: S };
      if (roads.some((o) => v.x < o.x + o.w && o.x < v.x + S && v.y < o.y + o.h && o.y < v.y + S)) continue; // (not out in the road at a junction)
      if (!isClear(v) || out.some((o) => Math.abs(o.x - v.x) < 300 && Math.abs(o.y - v.y) < 300)) continue;
      out.push(v);
    }
  }
  return out;
}

/**
 * Forests (dense patches with a darker floor) plus scattered single trees, clear of roads,
 * buildings, paths, water and each other. Returns { trees, forests }.
 */
export function generateTrees(width, height, { roads, buildings, paths, inWater = () => false, forests = 7, perForest = 16, scattered = 45 }) {
  const trees = [];
  const forestAreas = [];
  // Buckets (400-unit cells) so each candidate only checks the paths, buildings and trees near it.
  const CELL = 400;
  const cellKey = (cx, cy) => cx * 100000 + cy;
  const bucket = (grid, x0, y0, x1, y1, item) => {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const k = cellKey(cx, cy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(item);
      }
    }
  };
  const near = (grid, x, y) => grid.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))) ?? [];
  const pathGrid = new Map();
  for (const p of paths) {
    // Each path as 16 short segments, bucketed (with its reach) by the cells they cross.
    let prev = p.from;
    for (let i = 1; i <= 16; i++) {
      const next = bezierPoint(p, i / 16);
      const m = p.width / 2 + 20;
      bucket(pathGrid, Math.min(prev[0], next[0]) - m, Math.min(prev[1], next[1]) - m, Math.max(prev[0], next[0]) + m, Math.max(prev[1], next[1]) + m, { a: prev, b: next, reach: m * m });
      prev = next;
    }
  }
  const buildingGrid = new Map();
  for (const b of buildings) bucket(buildingGrid, b.x - 40, b.y - 40, b.x + b.w + 40, b.y + b.h + 40, b);
  const treeGrid = new Map();

  const tryPlace = (x, y) => {
    if (x < 60 || y < 60 || x > width - 60 || y > height - 60) return;
    const trunk = { x: Math.round(x - TRUNK / 2), y: Math.round(y - TRUNK / 2), w: TRUNK, h: TRUNK };
    if (roads.some((r) => overlaps(trunk, r, 20))) return;
    if (near(buildingGrid, x, y).some((b) => overlaps(trunk, b, 30))) return;
    if (near(pathGrid, x, y).some((s) => segmentDistSq(s.a[0], s.a[1], s.b[0], s.b[1], x, y) < s.reach)) return;
    if (inWater(x, y, 40)) return;
    if (near(treeGrid, x, y).some((t) => Math.hypot(t.x - x, t.y - y) < 70)) return;
    const tree = makeTree(x, y, randRange(48, 78));
    trees.push(tree);
    bucket(treeGrid, x - 70, y - 70, x + 70, y + 70, tree);
  };

  for (let f = 0; f < forests; f++) {
    const cx = randRange(300, width - 300);
    const cy = randRange(300, height - 300);
    const spread = randRange(170, 420); // some copses, some proper woods
    const before = trees.length;
    const tries = Math.round(perForest * 3 * (spread / 170) ** 2);
    for (let i = 0; i < tries; i++) {
      // Roughly normal spread around the forest centre.
      const a = Math.random() * Math.PI * 2;
      const d = Math.abs(randRange(-1, 1) + randRange(-1, 1)) * spread;
      tryPlace(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    }
    if (trees.length - before >= 6) forestAreas.push({ x: Math.round(cx), y: Math.round(cy), r: Math.round(spread * 1.3) });
  }
  for (let i = 0; i < scattered * 3; i++) tryPlace(randRange(0, width), randRange(0, height));
  return { trees, forests: forestAreas };
}
