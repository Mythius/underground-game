import { config } from '../config.js';

// Katya, your sister (taken from the cabin in the tutorial). Everyone has their own, locked in the last
// of the oil hall's cells underground — only you see yours there. Open that cell (the overseer's key)
// and she runs to you, hugs you, crying, and follows you about down there. Freed is for good: from then
// on she lives at your house in town — your dearest bought home that's loaded in (not a garage), or your
// starter house, where she tells you how poor you are — wandering round inside, for everyone to see.
// Nothing can hurt her.

const STATES = { run: 0, hug: 1, follow: 2, cell: 3 };
const HOME_TYPES_NOT = new Set(['garage', 'garages']); // (nobody lives in a garage)

export class Sisters {
  constructor(world) {
    this.world = world;
    this.events = []; // { player, kind } for the room to pass on
    this.onFree = null; // (account) she's been let out: save it
    const ug = world.underground?.layout;
    const cells = ug?.oil?.cells ?? [];
    this.cell = cells.length ? cells[cells.length - 1] : null; // (hers: the last cell along the back wall)
    this.door = this.cell ? ug.doors[this.cell.door] : null;
    this.homes = new Map(); // account id -> { id, account, x, y, angle, to, wait, b, poor }
    this.nextId = 1;
  }

  /** Where `account`'s sister lives: { b, poor } (poor: only the starter house), or null. */
  homeFor(account) {
    const homes = this.world.homes, prices = config.homes.prices;
    const bought = homes.boughtBy(account).filter((b) => b && !HOME_TYPES_NOT.has(b.type));
    if (bought.length) return { b: bought.reduce((best, b) => ((prices[b.type] ?? 0) > (prices[best.type] ?? 0) ? b : best)), poor: false };
    const starter = homes.homeOf(account);
    return starter ? { b: starter, poor: true } : null;
  }

  step(dt) {
    const c = config.sister, w = this.world;
    const here = new Set();
    for (const p of w.players.values()) {
      const a = p.account;
      if (!a || !p.alive) continue;
      // Underground: in her cell till its door's open and you're at it; then running to you, hugging you, following.
      if (this.cell && !a.sisterFree && this.door.open && Math.hypot(p.x - this.cell.front.x, p.y - this.cell.front.y) < c.freeReach) {
        a.sisterFree = true;
        this.onFree?.(a);
        p.sis = { state: 'run', x: this.cell.x, y: this.cell.y, angle: 0, t: 0 };
        this.events.push({ player: p, kind: 'sister_freed' });
      }
      const s = p.sis;
      if (s) {
        s.t += dt;
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        if (s.state === 'run' && !s.out && this.cell) { // out through her cell door first
          this.#walk(s, this.cell.front.x, this.cell.front.y, c.runSpeed * dt, 0);
          if (Math.hypot(this.cell.front.x - s.x, this.cell.front.y - s.y) < 30 || s.t > 3) s.out = true;
        } else if (s.state === 'run') {
          this.#walk(s, p.x, p.y, c.runSpeed * dt, p.radius + 22);
          if (d < p.radius + 26) Object.assign(s, { state: 'hug', t: 0 }), this.events.push({ player: p, kind: 'sister_hug' });
        } else if (s.state === 'hug') {
          s.angle = Math.atan2(p.y - s.y, p.x - s.x);
          if (d > p.radius + 30) this.#walk(s, p.x, p.y, c.runSpeed * dt, p.radius + 22);
          if (s.t > c.hugSec) Object.assign(s, { state: 'follow', t: 0 });
        } else if (d > c.lostRange) Object.assign(s, { x: p.x - Math.cos(p.input.aim ?? 0) * 60, y: p.y - Math.sin(p.input.aim ?? 0) * 60 }); // (fell behind: she catches up)
        else this.#walk(s, p.x, p.y, Math.min(c.runSpeed, Math.max(c.walkSpeed, d * 2)) * dt, c.followGap);
      }
      // In town: at home.
      if (!a.sisterFree) continue;
      const at = this.homeFor(a);
      if (!at) continue;
      here.add(a.id ?? a);
      let h = this.homes.get(a.id ?? a);
      if (!h || h.b !== at.b) {
        const spot = this.#spotIn(at.b) ?? { x: at.b.x + at.b.w / 2, y: at.b.y + at.b.h / 2 };
        h = { id: h?.id ?? this.nextId++, account: a, ...spot, angle: Math.random() * Math.PI * 2, to: null, wait: 1, b: at.b };
        this.homes.set(a.id ?? a, h);
      }
      h.poor = at.poor;
      if (h.wait > 0) { h.wait -= dt; continue; }
      h.to ??= this.#spotIn(h.b);
      if (!h.to || Math.hypot(h.to.x - h.x, h.to.y - h.y) < 6 || this.#walk(h, h.to.x, h.to.y, c.homeSpeed * dt, 0)) {
        h.to = null;
        h.wait = c.homeWait[0] + Math.random() * (c.homeWait[1] - c.homeWait[0]);
      }
    }
    for (const key of this.homes.keys()) if (!here.has(key)) this.homes.delete(key); // (her sibling's not about: their house is put away)
  }

  /** A clear spot somewhere inside building b, or null. */
  #spotIn(b) {
    for (let i = 0; i < 12; i++) {
      const x = b.x + 40 + Math.random() * Math.max(0, b.w - 80), y = b.y + 40 + Math.random() * Math.max(0, b.h - 80);
      if (!this.world.isBlocked(x, y, config.sister.radius)) return { x, y };
    }
    return null;
  }

  /** A step toward (tx, ty), stopping `gap` short, pushed off the walls. True if she's stuck (got nowhere). */
  #walk(s, tx, ty, step, gap) {
    const dx = tx - s.x, dy = ty - s.y, d = Math.hypot(dx, dy);
    if (d <= gap + 1) return false;
    s.angle = Math.atan2(dy, dx);
    const was = { x: s.x, y: s.y }, go = Math.min(step, d - gap);
    s.x += (dx / d) * go;
    s.y += (dy / d) * go;
    const r = config.sister.radius;
    for (const wall of this.world.wallsNear(s.x, s.y, r)) {
      const cx = Math.min(Math.max(s.x, wall.x), wall.x + wall.w), cy = Math.min(Math.max(s.y, wall.y), wall.y + wall.h);
      const ex = s.x - cx, ey = s.y - cy, dd = Math.hypot(ex, ey);
      if (dd > 0 && dd < r) { s.x += (ex / dd) * (r - dd); s.y += (ey / dd) * (r - dd); }
    }
    return Math.hypot(s.x - was.x, s.y - was.y) < go * 0.1;
  }

  /** My sister, as only I see her: [state (0 running to me, 1 hugging me, 2 following, 3 in her cell), x, y, angle], or 0. */
  view(p) {
    const r = (n) => Math.round(n * 10) / 10;
    if (p.sis) return [STATES[p.sis.state], r(p.sis.x), r(p.sis.y), Math.round(p.sis.angle * 100) / 100];
    if (this.cell && p.account && !p.account.sisterFree) return [STATES.cell, r(this.cell.x), r(this.cell.y), Math.PI / 2];
    return 0;
  }

  /** Sisters at home, near (x, y): [id, x, y, angle, her sibling's name, 1 if it's only the starter house]. */
  visible(x, y, range) {
    const out = [];
    for (const h of this.homes.values()) {
      if (Math.abs(h.x - x) > range || Math.abs(h.y - y) > range) continue;
      out.push([h.id, Math.round(h.x), Math.round(h.y), Math.round(h.angle * 100) / 100, h.account.name ?? '', h.poor ? 1 : 0]);
    }
    return out;
  }
}
