import { config } from '../config.js';
import { UG } from './underground.js';

// Flash floods underground: whenever it's raining up in town (the room sets `raining`). Everyone down there is
// warned; the water rises (you can still walk and run in it); everyone and everything outside the oil hall clears
// out of sight, the traders and the old miner too. A while after the warning a wave rushes out of the sewers along
// the tunnels and drowns whoever it reaches (not in the oil hall, which stays dry), and another comes every so often
// while it rains. When the rain stops the water drains away and they all come back.
//
// Where the wave has got to is a distance: each cell's distance (along the open cells) from the nearest sewer,
// worked out once. The client works out the same distances, so it can draw the wave from just how far it's got.

const inRect = (r, x, y) => r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/** Each cell's distance (in world units) from the nearest sewer cell through the open cells, or -1 (rock, the oil hall, or cut off). */
export function floodDistances(layout) {
  const { cols, rows, cell, grid } = layout, oil = layout.oil;
  const dist = new Float32Array(cols * rows).fill(-1);
  const dry = (i) => {
    const x = ((i % cols) + 0.5) * cell, y = (Math.floor(i / cols) + 0.5) * cell;
    return inRect(oil?.hall, x, y) || inRect(oil?.office, x, y) || grid.charCodeAt(i) - 48 === UG.HALL;
  };
  const open = (i) => grid.charCodeAt(i) - 48 !== UG.ROCK && !dry(i);
  let queue = [];
  for (let i = 0; i < cols * rows; i++) if (grid.charCodeAt(i) - 48 === UG.SEWER && open(i)) { dist[i] = 0; queue.push(i); }
  if (!queue.length) for (const l of layout.ladders ?? []) { const i = Math.floor(l.y / cell) * cols + Math.floor(l.x / cell); if (dist[i] < 0 && open(i)) { dist[i] = 0; queue.push(i); } } // (no sewers: from the ladders)
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head], x = i % cols, y = Math.floor(i / cols);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, j = ny * cols + nx;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || dist[j] >= 0 || !open(j)) continue;
      dist[j] = dist[i] + cell;
      queue.push(j);
    }
  }
  queue = null;
  return dist;
}

export class Flood {
  constructor(world, layout) {
    this.world = world;
    this.layout = layout;
    this.dist = floodDistances(layout);
    this.far = this.dist.reduce((m, d) => Math.max(m, d), 0);
    this.raining = false; // (set by the room from the town's weather)
    this.active = false; // flooded (or flooding, or draining)
    this.level = 0; // 0..1: how far the water's risen
    this.nextWave = 0; // seconds till the next wave (while it rains)
    this.warned = false; // told about the next wave
    this.front = -1; // how far the wave has got (world units from the sewers), or -1
    this.goneTraders = new Set(); // (indexes into layout.traders) cleared out
    this.minerGone = false;
    this.kills = []; // players the wave got
    this.events = []; // { kind } for everyone down here
  }

  /** In the oil hall (or its office): the flood never gets in there. */
  safe(x, y) {
    const oil = this.layout.oil;
    return inRect(oil?.hall, x, y) || inRect(oil?.office, x, y);
  }

  /** Deep enough to swim in, everywhere it's flooded: the last stretch before a wave (and while one goes through). */
  get deep() {
    return this.active && this.level >= 1 && ((this.raining && this.nextWave <= config.flood.deepSec) || this.front >= 0);
  }

  /** Swimming here (the flood's deep, and this is in it). */
  deepAt(x, y) {
    return this.deep && this.distAt(x, y) >= 0 && !this.safe(x, y);
  }

  /** How far (x, y) is from the sewers along the tunnels, or -1. */
  distAt(x, y) {
    const { cols, rows, cell } = this.layout, cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    return cx < 0 || cy < 0 || cx >= cols || cy >= rows ? -1 : this.dist[cy * cols + cx];
  }

  step(dt) {
    const c = config.flood, w = this.world;
    if (!this.active) {
      if (!this.raining) return;
      Object.assign(this, { active: true, nextWave: c.waveSec, warned: false, front: -1 });
      this.events.push({ kind: 'flood_warning', sec: c.waveSec });
    }
    if (this.raining) {
      this.level = Math.min(1, this.level + dt / c.riseSec);
      this.nextWave -= dt;
      if (!this.warned && this.nextWave <= c.warnSec) { this.warned = true; this.events.push({ kind: 'flood_wave_soon', sec: Math.ceil(this.nextWave) }); }
      if (this.nextWave <= 0) {
        this.front = 0;
        this.nextWave = c.waveSec;
        this.warned = false;
        this.events.push({ kind: 'flood_wave' });
      }
    } else if (this.front < 0) { // the rain's stopped (and no wave on its way): it drains away
      this.level = Math.max(0, this.level - dt / c.drainSec);
      if (this.level === 0) {
        Object.assign(this, { active: false, minerGone: false });
        this.goneTraders.clear();
        this.events.push({ kind: 'flood_over' });
        return;
      }
    }
    // The wave: out from the sewers, drowning whoever it reaches.
    if (this.front >= 0) {
      this.front += c.waveSpeed * dt;
      for (const p of w.players.values()) {
        const d = this.distAt(p.x, p.y);
        if (p.alive && d >= 0 && d <= this.front && !this.safe(p.x, p.y)) this.kills.push(p);
      }
      const swept = (o) => { const d = this.distAt(o.x, o.y); return d >= 0 && d <= this.front && !this.safe(o.x, o.y); };
      for (const h of [...(w.homeless?.list ?? [])]) if (swept(h)) w.homeless.vanish(h);
      for (const r of [...(w.giantRats?.list ?? [])]) if (swept(r)) w.giantRats.vanish(r);
      for (const b of [...w.bears.list]) if (swept(b)) w.bears.vanish(b);
      if (this.front > this.far + 600) this.front = -1; // (it's been everywhere)
    }
    // Everyone and everything else clears out, out of sight.
    const unseen = (x, y) => ![...w.players.values()].some((p) => Math.hypot(p.x - x, p.y - y) < c.clear);
    for (const h of [...(w.homeless?.list ?? [])]) if (!this.safe(h.x, h.y) && unseen(h.x, h.y)) w.homeless.vanish(h);
    for (const r of [...(w.giantRats?.list ?? [])]) if (!this.safe(r.x, r.y) && unseen(r.x, r.y)) w.giantRats.vanish(r);
    for (const b of [...w.bears.list]) if (unseen(b.x, b.y)) w.bears.vanish(b);
    (this.layout.traders ?? []).forEach((t, i) => { if (!this.goneTraders.has(i) && unseen(t.x, t.y)) this.goneTraders.add(i); });
    const m = this.layout.miner;
    if (m && !this.minerGone && unseen(m.x, m.y)) this.minerGone = true;
  }

  /** For the clients: [water level %, seconds till the wave (-1: none coming), how far the wave's got (-1), traders gone, miner gone, deep (swimming)], or 0. */
  state() {
    if (!this.active) return 0;
    return [Math.round(this.level * 100), this.raining ? Math.ceil(this.nextWave) : -1, this.front >= 0 ? Math.round(this.front) : -1, [...this.goneTraders], this.minerGone ? 1 : 0, this.deep ? 1 : 0];
  }
}
