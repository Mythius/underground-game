import { config } from '../config.js';
import { Pickup, makeWeapon } from './entities.js';

// The underground: old Soviet bunkers, joined up by abandoned metro lines and a maze of mine
// shafts. It's laid out on a grid of square cells; anything that isn't floor is solid rock.
// The same seed (and the same town bunkers) always digs out the same maze.

export const CELL = 160;
export const UG = { ROCK: 0, MINE: 1, TUNNEL: 2, PLATFORM: 3, BUNKER: 4, PASSAGE: 5 };

const STATIONS = ['Площадь Ильича', 'Заводская', 'Партизанская', 'Октябрьская', 'Пролетарская', 'Шахтёрская', 'Комсомольская', 'Красный Октябрь', 'Спутник', 'Гагаринская', 'Дружба народов', 'Победа'];
const BUNKER_NAMES = ['ОБЪЕКТ 17', 'ОБЪЕКТ 42', 'ГО-3', 'ОБЪЕКТ 9', 'УЗЕЛ СВЯЗИ', 'ОБЪЕКТ 101', 'ГО-11', 'СКЛАД №6', 'ОБЪЕКТ 23', 'ГО-7', 'ПУНКТ УПРАВЛЕНИЯ', 'ОБЪЕКТ 55', 'ГО-15', 'ОБЪЕКТ 8', 'СКЛАД №2', 'ОБЪЕКТ 31'];

/** A small seeded random generator (mulberry32): the same seed, the same maze. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Digs out the underground. `anchors` are points (in this map's coordinates) where the entrance
 * bunkers go, one per bunker trapdoor in town. Returns a plain object the World and the client share:
 *   { cell, cols, rows, grid (string of cell codes), lines (metro track centre lines), stations,
 *     bunkers, decor: [{ k, x, y, w, h, solid?, … }], loot: [{ x, y }], ladders: [{ x, y, entrance }] }
 */
export function generateUnderground({ width, height, anchors = [], seed = 1937 }) {
  const rnd = seeded(seed);
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const cols = Math.floor(width / CELL), rows = Math.floor(height / CELL);
  const g = new Uint8Array(cols * rows); // cell codes (UG)
  const zone = new Int16Array(cols * rows).fill(-1); // which station or bunker a cell belongs to
  const keep = new Uint8Array(cols * rows); // the maze stays out of these (features and the rock round them)
  const at = (x, y) => y * cols + x;
  const inside = (x, y) => x >= 1 && y >= 1 && x < cols - 1 && y < rows - 1;
  const set = (x, y, code, z = -1) => {
    if (!inside(x, y)) return;
    g[at(x, y)] = code;
    if (z >= 0) zone[at(x, y)] = z;
  };
  const fill = (x0, y0, w, h, code, z = -1) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, code, z); };
  const keepOut = (x0, y0, w, h, m) => { for (let y = y0 - m; y < y0 + h + m; y++) for (let x = x0 - m; x < x0 + w + m; x++) if (x >= 0 && y >= 0 && x < cols && y < rows) keep[at(x, y)] = 1; };
  const free = (x0, y0, w, h, m) => {
    for (let y = y0 - m; y < y0 + h + m; y++) for (let x = x0 - m; x < x0 + w + m; x++) if (!inside(x, y) || keep[at(x, y)] || g[at(x, y)]) return false;
    return true;
  };
  const decor = [], loot = [], ladders = [], stations = [], bunkers = [], lines = [];
  const exits = []; // { x, y, dx, dy, z }: the cell just inside a feature's way out, and which way is out

  // ---- the metro: two lines east–west, two north–south, each with a jog or two -------------------
  const lineCells = []; // [{ horizontal, a, b, c }] straight two-cell-wide runs: from a to b, at row/col c
  function digLine(horizontal) {
    const len = horizontal ? cols : rows, across = horizontal ? rows : cols;
    let c = Math.round(across * (lineCells.filter((l) => l.line && l.horizontal === horizontal).length ? 0.68 : 0.3)) + ri(-3, 3);
    const jogs = [ri(Math.round(len * 0.22), Math.round(len * 0.36)), ri(Math.round(len * 0.6), Math.round(len * 0.76))].filter(() => rnd() < 0.8);
    const pts = [];
    let a = 3;
    const centre = (along, ac) => (horizontal ? [along * CELL, (ac + 1) * CELL] : [(ac + 1) * CELL, along * CELL]);
    pts.push(centre(a, c));
    for (const j of [...jogs, len - 3]) {
      lineCells.push({ horizontal, a, b: j + 1, c, line: true });
      for (let s = a; s <= j + 1; s++) horizontal ? fill(s, c, 1, 2, UG.TUNNEL) : fill(c, s, 2, 1, UG.TUNNEL);
      if (j === len - 3) { pts.push(centre(len - 3, c)); break; }
      const shift = (rnd() < 0.5 ? -1 : 1) * ri(4, 7), c2 = Math.max(4, Math.min(across - 6, c + shift));
      const lo = Math.min(c, c2), hi = Math.max(c, c2);
      for (let s = lo; s <= hi + 1; s++) horizontal ? fill(j, s, 2, 1, UG.TUNNEL) : fill(s, j, 1, 2, UG.TUNNEL);
      pts.push(centre(j + 1, c), centre(j + 1, c2));
      c = c2;
      a = j + 1;
    }
    lines.push({ horizontal, pts });
    // The far ends caved in long ago.
    const [sx, sy] = pts[0], [ex, ey] = pts.at(-1);
    decor.push({ k: 'collapse', x: sx - (horizontal ? CELL * 0.6 : CELL), y: sy - (horizontal ? CELL : CELL * 0.6), w: horizontal ? CELL * 1.2 : CELL * 2, h: horizontal ? CELL * 2 : CELL * 1.2, end: horizontal ? 'w' : 'n' });
    decor.push({ k: 'collapse', x: ex - (horizontal ? CELL * 0.6 : CELL), y: ey - (horizontal ? CELL : CELL * 0.6), w: horizontal ? CELL * 1.2 : CELL * 2, h: horizontal ? CELL * 2 : CELL * 1.2, end: horizontal ? 'e' : 's' });
  }
  digLine(true);
  digLine(true);
  digLine(false);
  digLine(false);
  for (let i = 0; i < g.length; i++) if (g[i] === UG.TUNNEL) keep[i] = 1;
  // (and a cell of rock either side of every tunnel, so the maze runs alongside and doesn't eat into it)
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (g[at(x, y)] === UG.TUNNEL) keepOut(x, y, 1, 1, 1);

  // ---- stations: a hall of platforms either side of the track, every so often along a straight run -----
  const tunnelAt = (x, y) => inside(x, y) && g[at(x, y)] === UG.TUNNEL;
  let names = 0;
  for (const run of lineCells) {
    for (let s = run.a + 6; s + 12 < run.b - 4; s += ri(20, 28)) {
      const len = 10;
      // The hall: three cells of platform each side of the two-cell track.
      const hx = run.horizontal ? s : run.c - 3, hy = run.horizontal ? run.c - 3 : s;
      const hw = run.horizontal ? len : 8, hh = run.horizontal ? 8 : len;
      let clear = true;
      for (let y = hy - 2; y < hy + hh + 2 && clear; y++) {
        for (let x = hx - 2; x < hx + hw + 2 && clear; x++) {
          const onTrack = run.horizontal ? y === run.c || y === run.c + 1 : x === run.c || x === run.c + 1;
          if (!inside(x, y) || (tunnelAt(x, y) && !onTrack) || zone[at(x, y)] >= 0) clear = false;
        }
      }
      if (!clear) continue;
      const z = 100 + stations.length;
      for (let y = hy; y < hy + hh; y++) for (let x = hx; x < hx + hw; x++) if (!tunnelAt(x, y)) set(x, y, UG.PLATFORM, z);
      keepOut(hx, hy, hw, hh, 1);
      const name = STATIONS[names++ % STATIONS.length];
      const st = { x: hx * CELL, y: hy * CELL, w: hw * CELL, h: hh * CELL, horizontal: run.horizontal, track: (run.c + 1) * CELL, name };
      stations.push(st);
      stationDecor(st);
      // Ways out: a passage off the middle of each platform's back wall.
      const mid = (run.horizontal ? hx : hy) + (len >> 1) | 1;
      exits.push(run.horizontal ? { x: mid, y: hy, dx: 0, dy: -1, z } : { x: hx, y: mid, dx: -1, dy: 0, z });
      exits.push(run.horizontal ? { x: mid, y: hy + hh - 1, dx: 0, dy: 1, z } : { x: hx + hw - 1, y: mid, dx: 1, dy: 0, z });
    }
  }

  function stationDecor(st) {
    const H = st.horizontal;
    // Along the hall (u) and across it (v), in world units; v=0 is the hall's edge.
    const P = (u, v, w, h, extra) => (H ? { x: st.x + u, y: st.y + v, w, h, ...extra } : { x: st.x + v, y: st.y + u, w: h, h: w, ...extra });
    const L = H ? st.w : st.h;
    const sides = [{ v0: 0, back: 0 }, { v0: 5 * CELL, back: 3 * CELL }]; // the two platforms, 3 cells deep
    for (const [i, side] of sides.entries()) {
      // A row of marble-clad pillars down the middle of each platform, chandeliers between them.
      const v = side.v0 + CELL * 1.5;
      for (let u = CELL; u < L - CELL / 2; u += CELL * 2) decor.push({ k: 'pillar', ...P(u - 26, v - 26, 52, 52), solid: true });
      for (let u = CELL * 2; u < L - CELL; u += CELL * 2) decor.push({ k: 'chandelier', ...P(u - 30, v - 30, 60, 60), over: true });
      // Benches against the back wall, between the pillars.
      const bv = i === 0 ? side.v0 + 12 : side.v0 + side.back - 12 - 30;
      for (let u = CELL * 2; u < L - CELL; u += CELL * 2) if (Math.abs(u - L / 2) > CELL * 0.7) decor.push({ k: 'bench', ...P(u - 50, bv, 100, 30), solid: true });
      // The station's name on the back wall, at both ends.
      for (const u of [CELL * 1.2, L - CELL * 1.2]) decor.push({ k: 'sign', ...P(u - 90, i === 0 ? side.v0 - 22 : side.v0 + side.back - 2, 180, 24), text: st.name, wall: true });
      // A mosaic panel set in the floor in the middle of the platform.
      decor.push({ k: 'mosaic', ...P(L / 2 - 70, v - 70, 140, 140), seed: ri(0, 9999) });
    }
    if (rnd() < 0.4) { // a train that never left
      const cars = ri(1, 2), carLen = CELL * 3.4;
      const u0 = (L - cars * carLen - (cars - 1) * 16) / 2;
      for (let c = 0; c < cars; c++) decor.push({ k: 'wagon', ...P(u0 + c * (carLen + 16), 3 * CELL + 40, carLen, 2 * CELL - 80), solid: true, n: ri(1000, 9999) });
    }
    for (let i = 0; i < 2; i++) loot.push(H ? { x: st.x + ri(1, 9) * CELL, y: st.y + (i ? 6.5 : 1) * CELL } : { x: st.x + (i ? 6.5 : 1) * CELL, y: st.y + ri(1, 9) * CELL });
  }

  // ---- bunkers: entrance bunkers where the town's trapdoors lead, and a few more about ------------------
  // The nearest spot to (cx, cy) a bunker fits (its corner on odd cells, so its doors line up with the
  // maze); random spots for the rest. Entrance bunkers may come out smaller, rather than far away.
  function placeBunker(cx, cy, entrance) {
    const spots = [];
    if (entrance !== null) {
      for (let y = 1; y < rows; y += 2) for (let x = 1; x < cols; x += 2) spots.push([x, y, (x - cx) ** 2 + (y - cy) ** 2]);
      spots.sort((a, b) => a[2] - b[2]);
    } else for (let k = 0; k < 12; k++) spots.push([ri(1, cols - 2) | 1, ri(1, rows - 2) | 1]);
    for (const [x0, y0] of spots) {
      for (const [w, h] of [[ri(5, 9), ri(4, 6)], [5, 4]]) {
        const bx = Math.round(x0 - w / 2) | 1, by = Math.round(y0 - h / 2) | 1;
        if (!free(bx, by, w, h, 2)) continue;
        const z = bunkers.length;
        fill(bx, by, w, h, UG.BUNKER, z);
        keepOut(bx, by, w, h, 1);
        const b = { x: bx * CELL, y: by * CELL, w: w * CELL, h: h * CELL, cx: bx, cy: by, cw: w, ch: h, name: BUNKER_NAMES[z % BUNKER_NAMES.length], entrance, doors: [] };
        bunkers.push(b);
        // Two or three ways in, on different walls (on odd cells, so they line up with the maze).
        const walls = [['n', 0, -1], ['s', 0, 1], ['w', -1, 0], ['e', 1, 0]].sort(() => rnd() - 0.5).slice(0, ri(2, 3));
        for (const [side, dx, dy] of walls) {
          const ox = dx ? (dx < 0 ? bx : bx + w - 1) : (bx + ri(1, w - 2)) | 1, oy = dy ? (dy < 0 ? by : by + h - 1) : (by + ri(1, h - 2)) | 1;
          const dxx = Math.min(ox, bx + w - 1), dyy = Math.min(oy, by + h - 1);
          exits.push({ x: dxx, y: dyy, dx, dy, z });
          b.doors.push({ side, x: dxx, y: dyy });
        }
        return b;
      }
    }
    return null;
  }
  // Placed before the stations' passages and the maze, so they get first pick of the rock.
  const entranceBunkers = anchors.map((a, i) => placeBunker(Math.round(a.x / CELL), Math.round(a.y / CELL), i)).filter(Boolean);
  for (let tries = 0; bunkers.length < Math.max(14, entranceBunkers.length + 6) && tries < 30; tries++) placeBunker(0, 0, null);
  if (!entranceBunkers.length) entranceBunkers.push(placeBunker(cols >> 1, rows >> 1, 0)); // (always one way in and out)
  for (const b of bunkers) bunkerDecor(b);

  // ---- the mine: a maze of shafts on the odd cells, through all the rock that's left ------------------
  const node = (x, y) => x % 2 === 1 && y % 2 === 1 && inside(x, y) && !keep[at(x, y)] && !g[at(x, y)];
  const seen = new Uint8Array(cols * rows);
  for (let sy = 1; sy < rows - 1; sy += 2) {
    for (let sx = 1; sx < cols - 1; sx += 2) {
      if (!node(sx, sy) || seen[at(sx, sy)]) continue;
      const stack = [[sx, sy]];
      seen[at(sx, sy)] = 1;
      set(sx, sy, UG.MINE);
      while (stack.length) {
        const [x, y] = stack.at(-1);
        const next = [[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dy]) => [x + dx, y + dy, dx, dy]).filter(([nx, ny, dx, dy]) => node(nx, ny) && !seen[at(nx, ny)] && !keep[at(x + dx / 2, y + dy / 2)]);
        if (!next.length) { stack.pop(); continue; }
        // Shafts run straight more often than not.
        const [nx, ny, dx, dy] = next[Math.floor(rnd() * next.length)];
        seen[at(nx, ny)] = 1;
        set(x + dx / 2, y + dy / 2, UG.MINE);
        set(nx, ny, UG.MINE);
        stack.push([nx, ny]);
      }
    }
  }
  const floor = (x, y) => inside(x, y) && g[at(x, y)] !== UG.ROCK;
  // Knock through a few walls so it isn't one long dead end after another.
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      if (g[at(x, y)] || keep[at(x, y)] || (x + y) % 2 === 0) continue;
      const horiz = x % 2 === 0 && g[at(x - 1, y)] === UG.MINE && g[at(x + 1, y)] === UG.MINE;
      const vert = y % 2 === 0 && g[at(x, y - 1)] === UG.MINE && g[at(x, y + 1)] === UG.MINE;
      if ((horiz || vert) && rnd() < 0.13) set(x, y, UG.MINE);
    }
  }
  // Worked-out galleries: here and there the shafts open into a chamber.
  const galleries = [];
  for (let i = 0; i < 40; i++) {
    const x = ri(2, cols - 6) | 1, y = ri(2, rows - 6) | 1;
    if (g[at(x, y)] !== UG.MINE) continue;
    let ok = true;
    for (let yy = y - 1; yy <= y + 1 && ok; yy++) for (let xx = x - 1; xx <= x + 1 && ok; xx++) if (!inside(xx, yy) || keep[at(xx, yy)] || (g[at(xx, yy)] && g[at(xx, yy)] !== UG.MINE)) ok = false;
    if (!ok) continue;
    fill(x - 1, y - 1, 3, 3, UG.MINE);
    galleries.push({ x: x * CELL + CELL / 2, y: y * CELL + CELL / 2 });
  }

  // ---- ways out of the stations and bunkers: a concrete passage straight out until it meets something ----
  for (const e of exits) {
    for (let i = 1; i < 14; i++) {
      const x = e.x + e.dx * i, y = e.y + e.dy * i;
      if (!inside(x, y)) break;
      const c = g[at(x, y)];
      if (c && zone[at(x, y)] !== e.z) break; // through into a shaft, a tunnel or somewhere else
      if (!c) set(x, y, UG.PASSAGE);
    }
  }
  // Now and then a service passage off the side of a metro tunnel.
  for (const run of lineCells) {
    for (let s = run.a + 4; s < run.b - 2; s += ri(7, 13)) {
      const along = s | 1;
      for (const dir of [-1, 1]) {
        if (rnd() < 0.5) continue;
        let x = run.horizontal ? along : dir < 0 ? run.c - 1 : run.c + 2, y = run.horizontal ? (dir < 0 ? run.c - 1 : run.c + 2) : along;
        const dx = run.horizontal ? 0 : dir, dy = run.horizontal ? dir : 0;
        const dug = [];
        for (let i = 0; i < 4; i++, x += dx, y += dy) {
          if (!inside(x, y) || zone[at(x, y)] >= 0) { dug.length = 0; break; }
          if (g[at(x, y)]) break;
          dug.push([x, y]);
        }
        if (dug.length && floor(x, y) && g[at(x, y)] !== UG.TUNNEL) for (const [px, py] of dug) set(px, py, UG.PASSAGE);
      }
    }
  }

  // ---- everything joined up: dig through from any part you can't reach to the nearest part you can ----
  const start = entranceBunkers[0];
  for (let guard = 0; guard < 200; guard++) {
    const reach = new Uint8Array(cols * rows);
    const q = [at(start.cx + 1, start.cy + 1)];
    reach[q[0]] = 1;
    while (q.length) {
      const i = q.pop(), x = i % cols, y = (i / cols) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (floor(nx, ny) && !reach[at(nx, ny)]) { reach[at(nx, ny)] = 1; q.push(at(nx, ny)); }
    }
    let lost = -1;
    for (let i = 0; i < g.length && lost < 0; i++) if (g[i] && !reach[i]) lost = i;
    if (lost < 0) break;
    // Out from the lost part (through rock) until we hit a reached cell, then carve the way back.
    const from = new Int32Array(cols * rows).fill(-2);
    const q2 = [];
    const flood = [lost];
    from[lost] = -1;
    while (flood.length) { // the whole lost part is the start
      const i = flood.pop(), x = i % cols, y = (i / cols) | 0;
      q2.push(i);
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (floor(nx, ny) && from[at(nx, ny)] === -2) { from[at(nx, ny)] = -1; flood.push(at(nx, ny)); }
    }
    let hit = -1;
    for (let h = 0; h < q2.length && hit < 0; h++) {
      const i = q2[h], x = i % cols, y = (i / cols) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (!inside(nx, ny) || from[at(nx, ny)] !== -2) continue;
        from[at(nx, ny)] = i;
        if (reach[at(nx, ny)]) { hit = at(nx, ny); break; }
        if (zone[at(nx, ny)] < 0 && g[at(nx, ny)] !== UG.TUNNEL) q2.push(at(nx, ny)); // (not through a station's or bunker's walls)
      }
    }
    if (hit < 0) { g[lost] = UG.ROCK; continue; } // walled in for good: fill it in
    for (let i = from[hit]; i >= 0 && !g[i]; i = from[i]) g[i] = UG.MINE;
  }

  // ---- the mine's fittings: narrow-gauge rails down the long straight shafts, carts, lamps, dynamite ----
  const isMine = (x, y) => inside(x, y) && g[at(x, y)] === UG.MINE;
  for (const horizontal of [true, false]) {
    for (let c = 1; c < (horizontal ? rows : cols) - 1; c += 2) {
      let runStart = -1;
      for (let s = 0; s <= (horizontal ? cols : rows); s++) {
        const m = horizontal ? isMine(s, c) : isMine(c, s);
        if (m && runStart < 0) runStart = s;
        if (!m && runStart >= 0) {
          if (s - runStart >= 7 && rnd() < 0.45) {
            const a = (runStart + 0.3) * CELL, b = (s - 0.3) * CELL, m2 = (c + 0.5) * CELL;
            decor.push(horizontal ? { k: 'mrail', x: a, y: m2 - 14, w: b - a, h: 28 } : { k: 'mrail', x: m2 - 14, y: a, w: 28, h: b - a });
            if (rnd() < 0.5) { // a cart left on the line
              const u = (runStart + 1 + Math.floor(rnd() * (s - runStart - 2))) * CELL + CELL / 2;
              decor.push(horizontal ? { k: 'cart', x: u - 40, y: m2 - 26, w: 80, h: 52, solid: true, coal: rnd() < 0.6 } : { k: 'cart', x: m2 - 26, y: u - 40, w: 52, h: 80, solid: true, coal: rnd() < 0.6 });
            }
          }
          runStart = -1;
        }
      }
    }
  }
  // Dead ends: something left behind (and something worth finding).
  for (let y = 1; y < rows - 1; y += 2) {
    for (let x = 1; x < cols - 1; x += 2) {
      if (!isMine(x, y)) continue;
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => floor(x + dx, y + dy));
      if (open.length !== 1) continue;
      const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
      if (rnd() < 0.35) loot.push({ x: px, y: py });
      const r = rnd();
      if (r < 0.25) decor.push({ k: 'tnt', x: px - 22 - open[0][0] * 40, y: py - 16 - open[0][1] * 40, w: 44, h: 32, solid: true });
      else if (r < 0.45) decor.push({ k: 'rubble', x: px - 50 - open[0][0] * 30, y: py - 50 - open[0][1] * 30, w: 100, h: 100, seed: ri(0, 9999) });
    }
  }
  for (const gl of galleries) {
    loot.push({ x: gl.x + ri(-80, 80), y: gl.y + ri(-80, 80) });
    if (rnd() < 0.5) decor.push({ k: 'barrel', x: gl.x + 100, y: gl.y - 120, w: 40, h: 40, solid: true });
    decor.push({ k: 'lantern', x: gl.x - 12, y: gl.y - CELL * 1.5 + 4, w: 24, h: 24 });
  }

  // ---- bunker interiors -----------------------------------------------------------------------------
  function bunkerDecor(b) {
    const solid = [];
    const doorKeep = b.doors.map((d) => ({ x: d.x * CELL - CELL, y: d.y * CELL - CELL, w: CELL * 3, h: CELL * 3 }));
    const hits = (r, list) => list.some((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);
    const put = (d) => {
      if (d.solid && (hits(d, doorKeep) || hits({ x: d.x - 10, y: d.y - 10, w: d.w + 20, h: d.h + 20 }, solid))) return false;
      if (d.solid) solid.push(d);
      decor.push(d);
      return true;
    };
    // Blast doors in each doorway (swung open, against the wall).
    for (const d of b.doors) decor.push({ k: 'blastdoor', x: d.x * CELL, y: d.y * CELL, w: CELL, h: CELL, side: d.side });
    decor.push({ k: 'stencil', x: b.x + b.w / 2 - 100, y: b.y + b.h - CELL * 0.75, w: 200, h: 30, text: b.name }); // (painted on the floor, under everything)
    // Bigger bunkers are split in two by a concrete wall with a doorway through the middle (clear of the
    // doors in the north and south walls).
    const rooms = [];
    const split = b.cw >= 7 ? [3, 4, 2, 5].filter((k) => k <= b.cw - 2).find((k) => !b.doors.some((d) => (d.side === 'n' || d.side === 's') && (d.x - b.cx === k || d.x - b.cx === k - 1))) : undefined;
    if (split !== undefined) {
      const wx = b.x + split * CELL - 12;
      const gap = b.y + Math.floor(b.ch / 2) * CELL;
      for (const part of [{ k: 'partition', x: wx, y: b.y, w: 24, h: gap - b.y - CELL / 2, solid: true }, { k: 'partition', x: wx, y: gap + CELL / 2, w: 24, h: b.y + b.h - gap - CELL / 2, solid: true }]) { solid.push(part); decor.push(part); }
      decor.push({ k: 'doorframe', x: wx - 6, y: gap - CELL / 2, w: 36, h: CELL });
      doorKeep.push({ x: wx - CELL, y: gap - CELL, w: CELL * 2, h: CELL * 2 });
      rooms.push({ x: b.x, y: b.y, w: wx - b.x, h: b.h }, { x: wx + 24, y: b.y, w: b.x + b.w - wx - 24, h: b.h });
    } else rooms.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    const kinds = ['barracks', 'command', 'store', 'generator', 'infirmary'];
    rooms.forEach((r, i) => {
      const kind = b.entrance !== null && i === 0 ? 'command' : kinds[(ri(0, 99) + i) % kinds.length];
      const pad = 18;
      const along = (step, w, h, k, extra = {}) => { // a row against the top wall, then the bottom
        for (const top of [true, false]) for (let x = r.x + pad + 20; x + w < r.x + r.w - pad; x += step) put({ k, x, y: top ? r.y + pad : r.y + r.h - pad - h, w, h, solid: true, flip: !top, ...extra });
      };
      if (kind === 'barracks') {
        along(110, 56, 120, 'bunk');
        put({ k: 'table', x: r.x + r.w / 2 - 60, y: r.y + r.h / 2 - 35, w: 120, h: 70, solid: true });
      } else if (kind === 'command') {
        put({ k: 'maptable', x: r.x + r.w / 2 - 110, y: r.y + r.h / 2 - 70, w: 220, h: 140, solid: true });
        along(150, 110, 54, 'desk', { radio: true });
        decor.push({ k: 'star', x: r.x + r.w / 2 - 110, y: r.y + r.h / 2 - 110, w: 220, h: 220 });
      } else if (kind === 'store') {
        for (let n = 0; n < 9; n++) put({ k: 'crate', x: r.x + pad + rnd() * (r.w - 2 * pad - 60), y: r.y + pad + rnd() * (r.h - 2 * pad - 60), w: 56, h: 56, solid: true, a: rnd() * 0.3 - 0.15 });
        for (let n = 0; n < 5; n++) put({ k: 'barrel', x: r.x + pad + rnd() * (r.w - 2 * pad - 40), y: r.y + pad + rnd() * (r.h - 2 * pad - 40), w: 40, h: 40, solid: true });
      } else if (kind === 'generator') {
        put({ k: 'generator', x: r.x + r.w / 2 - 90, y: r.y + r.h / 2 - 55, w: 180, h: 110, solid: true });
        along(90, 40, 40, 'barrel');
      } else {
        along(130, 60, 110, 'cot');
        put({ k: 'cabinet', x: r.x + r.w - pad - 70, y: r.y + r.h / 2 - 25, w: 70, h: 50, solid: true });
      }
      // Gas masks hang by the door; lockers along a side wall.
      for (let y = r.y + pad + 40; y + 50 < r.y + r.h - pad - 40; y += 56) put({ k: 'locker', x: r.x + pad, y, w: 34, h: 50, solid: true });
      decor.push({ k: 'poster', x: r.x + r.w - 110, y: r.y - 20, w: 80, h: 16, n: ri(0, 3), wall: true });
      loot.push({ x: r.x + r.w / 2 + ri(-60, 60), y: r.y + r.h / 2 + (kind === 'command' ? 110 : ri(-50, 50)) });
    });
    // The ladder up to the trapdoor in town.
    if (b.entrance !== null) {
      const r = rooms[0];
      const lx = r.x + 40, ly = r.y + r.h / 2 - 40;
      decor.push({ k: 'ladder', x: lx, y: ly, w: 60, h: 80 });
      ladders.push({ x: lx + 30, y: ly + 40, entrance: b.entrance });
    }
  }

  // Signal lamps along the tunnel walls.
  for (const run of lineCells) {
    for (let s = run.a + 3; s < run.b - 1; s += 9) {
      const u = s * CELL;
      decor.push(run.horizontal ? { k: 'signal', x: u, y: run.c * CELL + 6, w: 20, h: 14 } : { k: 'signal', x: run.c * CELL + 6, y: u, w: 14, h: 20 });
    }
  }

  let grid = '';
  for (let i = 0; i < g.length; i++) grid += g[i];
  return { cell: CELL, cols, rows, grid, lines, stations, bunkers: bunkers.map(({ x, y, w, h, name, entrance }) => ({ x, y, w, h, name, entrance })), decor, loot, ladders };
}

/** The solid rock as rectangles: runs along each row, merged down with identical runs below (at most 8 cells long, for the grids). */
export function rockRects(ug) {
  const { cols, rows, grid, cell } = ug;
  const open = new Map(); // "x0,x1" -> rect still growing down
  const out = [];
  for (let y = 0; y <= rows; y++) {
    const runs = new Set();
    if (y < rows) {
      for (let x = 0; x < cols;) {
        if (grid.charCodeAt(y * cols + x) !== 48) { x++; continue; }
        const x0 = x;
        while (x < cols && x - x0 < 8 && grid.charCodeAt(y * cols + x) === 48) x++;
        runs.add(`${x0},${x}`);
      }
    }
    for (const [key, r] of open) {
      if (runs.has(key) && r.h < cell * 8) { r.h += cell; runs.delete(key); } else { out.push(r); open.delete(key); }
    }
    for (const key of runs) {
      const [x0, x1] = key.split(',').map(Number);
      open.set(key, { x: x0 * cell, y: y * cell, w: (x1 - x0) * cell, h: cell });
    }
  }
  // (the map's edge beyond the last whole cell)
  const W = cols * cell, H = rows * cell;
  out.push({ x: W, y: 0, w: cell, h: H + cell }, { x: 0, y: H, w: W, h: cell });
  return out;
}

/** The underground's own goings-on: loot lying about that comes back a while after it's taken. */
export class Underground {
  constructor(world, layout) {
    this.world = world;
    this.layout = layout;
    this.spots = layout.loot.map((s) => ({ ...s, pickup: null, wait: Math.random() * 20 }));
  }

  /** The ladder (up to town) within reach of p, or null. */
  ladderNear(p, reach = 70) {
    return this.layout.ladders.find((l) => Math.hypot(l.x - p.x, l.y - p.y) < reach + p.radius) ?? null;
  }

  /** Where someone climbing down a trapdoor at (x, y) in town comes out: at the foot of the nearest ladder. */
  arrival(x, y) {
    const k = config.underground.scale;
    let best = null, bd = Infinity;
    for (const l of this.layout.ladders) {
      const d = Math.hypot(l.x - x * k, l.y - y * k);
      if (d < bd) [best, bd] = [l, d];
    }
    return best ? { x: best.x + 60, y: best.y } : { x: this.world.width / 2, y: this.world.height / 2 };
  }

  step(dt) {
    const w = this.world, cfg = config.underground;
    for (const s of this.spots) {
      if (s.pickup && w.pickups.has(s.pickup.id)) continue;
      if (s.pickup) { s.pickup = null; s.wait = cfg.lootRespawnSec * (0.75 + Math.random() * 0.5); }
      if ((s.wait -= dt) > 0) continue;
      s.pickup = this.#drop(s.x, s.y);
      w.grid.insert(s.pickup);
    }
  }

  /** Something worth picking up: mostly cash or goods, now and then a gun. */
  #drop(x, y) {
    const w = this.world, cfg = config.underground, r = Math.random();
    let p;
    if (r < cfg.gunChance) {
      const types = Object.keys(w.weapons).filter((t) => w.weapons[t].spawnWeight > 0);
      let roll = Math.random() * types.reduce((sum, t) => sum + w.weapons[t].spawnWeight, 0);
      p = new Pickup(w.nextEntityId++, x, y, makeWeapon(types.find((t) => (roll -= w.weapons[t].spawnWeight) < 0) ?? types[0]));
    } else if (r < cfg.gunChance + cfg.goodsChance) {
      const [good, lo, hi] = cfg.goods[Math.floor(Math.random() * cfg.goods.length)];
      p = new Pickup(w.nextEntityId++, x, y, null, 0, { good, qty: lo + Math.floor(Math.random() * (hi - lo + 1)) });
    } else p = new Pickup(w.nextEntityId++, x, y, null, cfg.cash[0] + Math.floor(Math.random() * (cfg.cash[1] - cfg.cash[0])));
    w.pickups.set(p.id, p);
    return p;
  }
}

/** The town's bunkers with a trapdoor, in a fixed order: number i leads down to entrance bunker i. */
export function trapdoorBunkers(town) {
  return town.buildings.filter((b) => town.trapdoorOf(b));
}

/** The underground beneath `town` (a World), as a map the World can be built from. */
export function undergroundMap(town) {
  const k = config.underground.scale;
  const width = Math.round(town.width * k), height = Math.round(town.height * k);
  // Entrance bunkers roughly beneath the town's trapdoors (at the underground's scale), spread out:
  // each trapdoor leads down to the nearest one.
  const all = trapdoorBunkers(town).map((b) => ({ x: (b.x + b.w / 2) * k, y: (b.y + b.h / 2) * k }));
  const anchors = all.length ? [all[0]] : [];
  while (anchors.length < Math.min(all.length, config.underground.entrances)) {
    let best = null, bd = -1;
    for (const p of all) {
      const d = Math.min(...anchors.map((a) => Math.hypot(a.x - p.x, a.y - p.y)));
      if (d > bd) [best, bd] = [p, d];
    }
    anchors.push(best);
  }
  const layout = generateUnderground({ width, height, anchors, seed: config.underground.seed });
  return { version: 1, width, height, roads: [], rivers: [], lakes: [], trails: [], buildings: [], trees: [], forests: [], lamps: [], vehicles: [], npcs: [], atms: [], lots: [], underground: layout };
}
