import { config } from '../config.js';
import { hotbarOf } from './cargo.js';
import { waterDistance } from './water.js';

// Bodies: whoever dies (players, townsfolk, Militsiya officers) leaves one. You can loot it (its
// hotbar, its cash), pick it up and carry it (slowly, hands full), and get rid of it:
//   E while carrying, next to a dumpster → in the dumpster (gone)
//                     at a river or an unfrozen lake → thrown in the water (gone)
//                     under a tree → hidden there (the Militsiya won't find it)
//                     anywhere else → put down
// A body lying in the open is found sooner or later (its killer hears about it). Being seen carrying
// one is a crime, and so is being seen standing right next to one.
//
// Dumpsters stand beside city buildings (and some country ones): solid green bins.

export class Bodies {
  constructor(world) {
    this.world = world;
    this.list = new Map(); // id -> body
    this.nextId = 1;
    this.events = []; // { player, kind, ... } for the room to pass on
    this.timer = 0;
  }

  get time() {
    return this.world.economy.time;
  }

  /**
   * A new body. look: [skin, shirt, pants, hat] indexes; kind: 'player' | 'npc' | 'officer';
   * items: hotbar-style slots (guns or { good, qty }); killer: the player who did it, if any.
   */
  add({ x, y, angle = 0, kind, look, items = [], cash = 0, killer = null, victimId = null, name = '' }) {
    const body = { id: this.nextId++, x, y, angle, kind, look, items: [...items], cash: Math.floor(cash), killer, victimId, name, carriedBy: null, hidden: false, reported: false, born: this.time };
    this.list.set(body.id, body);
    // Keep it bounded: the oldest go first.
    while (this.list.size > config.bodies.max) this.#remove([...this.list.values()][0]);
    return body;
  }

  #remove(body) {
    if (body.carriedBy) body.carriedBy.carrying = null;
    this.list.delete(body.id);
  }

  /** The body whose killer was recorded only after it was made (players: the death is sorted out later). */
  setKiller(victimId, killer) {
    for (const b of this.list.values()) if (b.victimId === victimId && !b.killer && killer?.kind === 'player') b.killer = killer;
  }

  nearest(p, reach = config.bodies.reach) {
    let best = null;
    let bestD = Infinity;
    for (const b of this.list.values()) {
      if (b.carriedBy) continue;
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d < reach + p.radius && d < bestD) [best, bestD] = [b, d];
    }
    return best;
  }

  step(dt) {
    const w = this.world;
    // Carried bodies follow their carrier (slung behind them).
    for (const b of this.list.values()) {
      const p = b.carriedBy;
      if (!p) continue;
      if (!p.alive || p.vehicle || p.jailed) {
        this.#putDown(p, b);
        continue;
      }
      const a = p.input.aim ?? 0;
      b.x = p.x - Math.cos(a) * 10;
      b.y = p.y - Math.sin(a) * 10;
      b.angle = a + Math.PI / 2;
    }
    this.timer += dt;
    if (this.timer < 1) return;
    this.timer = 0;
    for (const b of [...this.list.values()]) {
      if (this.time - b.born > config.bodies.lifeSec) {
        this.#remove(b);
        continue;
      }
      // Seen carrying a body: that's a crime.
      const p = b.carriedBy;
      if (p && (p.carrySeenAt ?? -Infinity) < this.time - 10 && w.police.witnessed(p.x, p.y, p)) {
        p.carrySeenAt = this.time;
        w.police.crime(p, 'carry_body', true);
      }
      // Seen standing over a body that's lying in the open: that's suspicious enough to be wanted.
      if (!p && !b.hidden) {
        for (const o of w.players.values()) {
          if (!o.alive || o.vehicle || o.hidden || o.jailed || (o.nearBodySeenAt ?? -Infinity) > this.time - 10) continue;
          if (Math.hypot(o.x - b.x, o.y - b.y) > config.bodies.nearRange + o.radius) continue;
          if (!w.police.witnessed(o.x, o.y, o)) continue;
          o.nearBodySeenAt = this.time;
          w.police.crime(o, 'near_body', true);
        }
      }
      // A body lying in the open gets found. That alone doesn't name the killer (only being seen does:
      // at the killing, or near the body); they just hear about it.
      if (!p && !b.hidden && !b.reported && (w.police.policeSee(b.x, b.y) || w.police.witnessed(b.x, b.y))) {
        b.reported = true;
        if (b.killer?.alive) this.events.push({ player: b.killer, kind: 'body_found' });
      }
    }
  }

  // ---- player actions (each returns an error code, or null / a result) ----------------

  /** Pick up the nearest body. */
  carry(p, id) {
    if (p.vehicle || p.jailed) return 'busy';
    if (p.carrying) return 'already_carrying';
    const b = this.list.get(id);
    if (!b || b.carriedBy || Math.hypot(b.x - p.x, b.y - p.y) > config.bodies.reach + p.radius) return 'too_far';
    b.carriedBy = p;
    b.hidden = false;
    p.carrying = b;
    return null;
  }

  #putDown(p, b) {
    b.carriedBy = null;
    p.carrying = null;
    b.x = p.x;
    b.y = p.y;
  }

  /** E while carrying: into a dumpster, into the water, hidden under a tree, or just put down. */
  dropCarried(p) {
    const b = p.carrying;
    if (!b) return 'not_carrying';
    const w = this.world;
    const reach = config.bodies.reach + p.radius;
    const dumpster = w.dumpsters.find((d) => Math.hypot(d.x + d.w / 2 - p.x, d.y + d.h / 2 - p.y) < reach + d.w / 2);
    if (dumpster) {
      this.#remove(b);
      p.carrying = null;
      return { how: 'dumpster' };
    }
    // Rivers always; lakes only when they aren't frozen over.
    const water = w.frozen ? { rivers: w.water.rivers, lakes: [] } : w.water;
    if (waterDistance(water, p.x, p.y).d < config.bodies.waterReach) {
      this.#remove(b);
      p.carrying = null;
      return { how: 'water' };
    }
    this.#putDown(p, b);
    const tree = w.trees.find((t) => Math.hypot(t.x - p.x, t.y - p.y) < t.canopy * 0.75);
    if (tree) {
      b.hidden = true;
      return { how: 'tree' };
    }
    return { how: 'ground' };
  }

  /** Take one of the body's hotbar slots (or its cash, slot −1) into your hotbar. */
  loot(p, id, slot) {
    const b = this.list.get(id);
    if (!b || b.carriedBy || Math.hypot(b.x - p.x, b.y - p.y) > config.bodies.reach + p.radius) return 'too_far';
    if (slot === -1) {
      if (b.cash <= 0) return 'nothing_there';
      p.cash += b.cash;
      b.cash = 0;
      return null;
    }
    const item = b.items[slot];
    if (!item) return 'nothing_there';
    if (item.good) {
      const left = hotbarOf(p).add(item.good, item.qty);
      if (left === item.qty) return 'no_room';
      if (left > 0) item.qty = left;
      else b.items[slot] = null;
      return null;
    }
    if (item.food) {
      const left = this.world.addFood(p, item.food, item.qty);
      if (left === item.qty) return 'no_room';
      if (left > 0) item.qty = left;
      else b.items[slot] = null;
      return null;
    }
    // A gun.
    if (p.hasWeapon(item.type)) return 'already_have';
    if (!p.inventory.includes(null)) return 'no_room';
    p.addWeapon({ ...item, reloadTimer: 0 });
    b.items[slot] = null;
    return null;
  }

  /** What the loot panel shows. */
  describe(id) {
    const b = this.list.get(id);
    if (!b) return null;
    return {
      id: b.id,
      kind: b.kind,
      name: b.name,
      cash: b.cash,
      items: b.items.map((s) => (s?.good ? ['goods', s.good, s.qty] : s?.food ? ['food', s.food, s.qty] : s ? [s.type, s.ammo] : null)),
    };
  }

  /** Snapshot rows for bodies near (x, y): [id, x, y, angle, kind (0 player, 1 townsperson, 2 officer), skin, shirt, pants, hat, carrierId]. */
  near(x, y, range) {
    const out = [];
    const kinds = { player: 0, npc: 1, officer: 2 };
    for (const b of this.list.values()) {
      if (Math.abs(b.x - x) > range || Math.abs(b.y - y) > range) continue;
      out.push([b.id, Math.round(b.x), Math.round(b.y), Math.round(b.angle * 100) / 100, kinds[b.kind], ...b.look, b.carriedBy?.id ?? 0]);
    }
    return out;
  }
}

/** Dumpsters: beside city buildings (and some warehouses and factories out of town), clear of everything. */
export function generateDumpsters(buildings, city, isClear) {
  const out = [];
  const W = 56, H = 36;
  const wanted = new Set(['panelka', 'shop', 'kiosk', 'market', 'office', 'garages', 'bank', 'gunstore', 'dealership', 'police', 'smallwarehouse', 'warehouse', 'bigwarehouse']);
  for (const b of buildings) {
    if (!wanted.has(b.type) || Math.random() > 0.7) continue;
    // Try beside each wall, a little way along, until one is clear.
    const spots = [
      { x: b.x + b.w + 10, y: b.y + b.h * 0.25, horizontal: false },
      { x: b.x - 10 - H, y: b.y + b.h * 0.6, horizontal: false },
      { x: b.x + b.w * 0.7, y: b.y - 10 - H, horizontal: true },
      { x: b.x + b.w * 0.2, y: b.y + b.h + 10, horizontal: true },
    ];
    for (const s of spots) {
      const r = s.horizontal ? { x: Math.round(s.x), y: Math.round(s.y), w: W, h: H } : { x: Math.round(s.x), y: Math.round(s.y), w: H, h: W };
      if (!isClear(r) || out.some((d) => Math.abs(d.x - r.x) < 120 && Math.abs(d.y - r.y) < 120)) continue;
      out.push(r);
      break;
    }
  }
  return out;
}
