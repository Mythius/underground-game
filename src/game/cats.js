import { config } from '../config.js';

// Stray cats. A score of them round town — by the dumpsters, outside the homes, a couple at the prison
// and the farms — each keeping round its own spot. They keep their distance from strangers (and
// anything with an engine), but a fish in your hand brings one over. Feed it the fish and it follows
// you about for a while; then you can pick it up (your hands are full: no guns or tools, and it
// wriggles free after a while) and pet it.
//
//   cat: { id, x, y, angle, look, home: { x, y }, move (0 sitting · 1 walking · 2 running), friend, friendUntil,
//          heldBy, heldUntil, pettedAt, wander }
//   player.holdingCat: the cat in their arms

const HOMES = new Set(['house', 'cabin', 'mansion', 'panelka', 'barn']);

export class Cats {
  constructor(world) {
    this.world = world;
    this.list = [];
    this.events = []; // { player, kind } for the room to pass on
    this.time = 0;
    this.nextId = 1;
    const spots = this.#spots();
    for (let i = 0; i < config.cats.count && spots.length; i++) {
      const at = spots.splice(Math.floor(Math.random() * spots.length), 1)[0];
      this.list.push({ id: this.nextId++, x: at.x, y: at.y, angle: Math.random() * Math.PI * 2, look: Math.floor(Math.random() * 6), home: at, move: 0, friend: null, friendUntil: 0, heldBy: null, heldUntil: 0, pettedAt: -Infinity, wander: null });
    }
  }

  /** Where strays hang about: beside the dumpsters, outside homes, a couple at the prison and at the farms. */
  #spots() {
    const w = this.world;
    const ok = (x, y) => x > 50 && y > 50 && x < w.width - 50 && y < w.height - 50 && !w.isBlocked(x, y, config.cats.radius + 4) && !w.isSwimming(x, y);
    const out = [];
    const pushNear = (x, y, tries = 8) => {
      for (let k = 0; k < tries; k++) {
        const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 50;
        const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
        if (ok(px, py)) return out.push({ x: px, y: py });
      }
    };
    for (const d of w.dumpsters ?? []) pushNear(d.x + d.w / 2, d.y + d.h / 2);
    for (const s of w.townsfolk?.spots ?? []) {
      const b = w.buildings[s.building - 1];
      if (b && HOMES.has(b.type) && s.walk[2]) pushNear(s.walk[2].x, s.walk[2].y);
    }
    const extra = [];
    const prison = w.prison?.spots;
    if (prison) for (let i = 0; i < 2; i++) extra.push(prison.spawn);
    for (const b of w.buildings.filter((x) => x.type === 'farm' && x.npc).slice(0, 2)) extra.push(b.npc);
    const special = [];
    for (const e of extra) { const n = out.length; pushNear(e.x, e.y, 20); if (out.length > n) special.push(out.pop()); }
    // The prison's and farms' cats first, then the town's at random.
    const town = out.sort(() => Math.random() - 0.5);
    return [...town.slice(0, Math.max(0, config.cats.count - special.length)), ...special];
  }

  near(p, id) {
    const c = this.list.find((x) => x.id === id);
    return c && !c.heldBy && Math.hypot(c.x - p.x, c.y - p.y) < config.cats.reach + p.radius ? c : null;
  }

  friendly(c, p) {
    return c.friend === p && c.friendUntil > this.time;
  }

  // ---- what you can do with one (each returns an error code or null) --------------------------

  /** E with a fish in hand: it eats, and follows you about for a while. */
  feed(p, id) {
    const slot = p.inventory[p.selected];
    if (slot?.good !== 'fish') return 'no_fish';
    if (p.vehicle || p.hidden || !p.alive) return 'busy';
    const c = this.near(p, id);
    if (!c) return 'too_far';
    slot.qty -= 1;
    if (slot.qty <= 0) p.inventory[p.selected] = null;
    Object.assign(c, { friend: p, friendUntil: this.time + config.cats.friendSec, pettedAt: this.time, angle: Math.atan2(p.y - c.y, p.x - c.x) });
    this.events.push({ player: p, kind: 'cat_fed' });
    return null;
  }

  /** E: up into your arms (only a cat that knows you). */
  pickUp(p, id) {
    if (p.vehicle || p.hidden || p.carrying || p.holdingCat || !p.alive) return 'busy';
    const c = this.near(p, id);
    if (!c) return 'too_far';
    if (!this.friendly(c, p)) return 'cat_wary';
    Object.assign(c, { heldBy: p, heldUntil: this.time + config.cats.holdSec, move: 0 });
    p.holdingCat = c;
    return null;
  }

  /** E again: down it goes, at your feet. */
  putDown(p, why = null) {
    const c = p.holdingCat;
    if (!c) return 'no_cat';
    p.holdingCat = null;
    c.heldBy = null;
    const a = (p.input?.aim ?? 0);
    for (const d of [p.radius + 18, p.radius + 8, 0]) {
      const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
      if (!this.world.isBlocked(x, y, config.cats.radius)) { c.x = x; c.y = y; break; }
    }
    if (why) this.events.push({ player: p, kind: 'cat_free', why });
    return null;
  }

  /** P: a pet (the one in your arms, or one beside you that knows you). */
  pet(p, id) {
    const c = p.holdingCat ?? this.near(p, id);
    if (!c) return 'too_far';
    if (!this.friendly(c, p) && c.heldBy !== p) return 'cat_wary';
    if (this.time - c.pettedAt < config.cats.petCooldownSec) return null;
    c.pettedAt = this.time;
    c.friendUntil = Math.max(c.friendUntil, this.time + 60); // (it likes you a little longer)
    if (c.heldBy === p) c.heldUntil += 3; // …and settles in your arms
    this.events.push({ player: p, kind: 'cat_pet' });
    return null;
  }

  // ---- every step ---------------------------------------------------------------------------------

  step(dt) {
    this.time += dt;
    const w = this.world;
    const k = config.cats;
    const players = [...w.players.values()].filter((p) => p.alive);
    for (const c of this.list) {
      if (c.heldBy) {
        const p = c.heldBy;
        if (!p.alive || p.vehicle || p.hidden || p.carrying || !w.players.has(p.id)) { this.putDown(p); continue; }
        if (this.time > c.heldUntil) { this.putDown(p, 'wriggled'); continue; }
        c.x = p.x;
        c.y = p.y;
        c.angle = p.input?.aim ?? c.angle;
        continue;
      }
      if (c.friend && (this.time > c.friendUntil || !c.friend.alive || !w.players.has(c.friend.id) || Math.hypot(c.friend.x - c.x, c.friend.y - c.y) > 1500)) c.friend = null; // (gone off somewhere: it stays)
      // Trouble: a car coming, or a stranger close (unless they've a fish to offer).
      const fishy = (p) => p.inventory[p.selected]?.good === 'fish' && !p.vehicle;
      let danger = null;
      for (const v of w.vehicles.values()) if (v.speed > 60 && Math.hypot(v.x - c.x, v.y - c.y) < 160) { danger = v; break; }
      if (!danger) for (const p of players) {
        if (p === c.friend || p.hidden || p.vehicle || fishy(p)) continue;
        const run = p.input?.throttle > 0 && p.input?.boost;
        if (Math.hypot(p.x - c.x, p.y - c.y) < k.shyRange * (run ? 1.6 : 1)) { danger = p; break; }
      }
      if (danger) {
        const a = Math.atan2(c.y - danger.y, c.x - danger.x);
        this.#step(c, a, k.runSpeed, dt);
        c.move = 2;
        c.wander = null;
        continue;
      }
      // A friend: at their heels (sitting by their car if they drive off).
      const f = c.friend && !c.friend.vehicle && !c.friend.hidden ? c.friend : null;
      const lure = f ?? players.find((p) => fishy(p) && Math.hypot(p.x - c.x, p.y - c.y) < k.curiousRange);
      if (lure) {
        const d = Math.hypot(lure.x - c.x, lure.y - c.y);
        const keep = lure.radius + 30;
        if (d > keep + 10) {
          this.#step(c, Math.atan2(lure.y - c.y, lure.x - c.x), d > 250 ? k.followSpeed : f ? k.followSpeed * 0.6 : k.wanderSpeed * 1.5, dt);
          c.move = d > 250 ? 2 : 1;
        } else {
          c.move = 0;
          c.angle = Math.atan2(lure.y - c.y, lure.x - c.x);
        }
        if (f) c.home = { x: c.x, y: c.y }; // (it settles wherever you leave it)
        continue;
      }
      // A stray's day: sit a while, pad about near its spot.
      if (!c.wander || this.time > c.wander.until) {
        const sit = Math.random() < 0.55;
        const a = Math.random() * Math.PI * 2, r = Math.random() * k.homeRange;
        c.wander = sit ? { until: this.time + 4 + Math.random() * 10 } : { until: this.time + 8, x: c.home.x + Math.cos(a) * r, y: c.home.y + Math.sin(a) * r };
      }
      if (c.wander.x === undefined || Math.hypot(c.wander.x - c.x, c.wander.y - c.y) < 8) {
        c.move = 0;
        continue;
      }
      this.#step(c, Math.atan2(c.wander.y - c.y, c.wander.x - c.x), k.wanderSpeed, dt);
      c.move = 1;
    }
  }

  /** Pad along, round walls and out of the water. */
  #step(c, angle, speed, dt) {
    const w = this.world, r = config.cats.radius;
    const nx = c.x + Math.cos(angle) * speed * dt, ny = c.y + Math.sin(angle) * speed * dt;
    c.angle = angle;
    if (nx < r || ny < r || nx > w.width - r || ny > w.height - r || w.isSwimming(nx, ny)) { if (c.wander) c.wander.until = 0; return; }
    c.x = nx;
    c.y = ny;
    for (const wall of w.wallsNear(c.x, c.y, r)) {
      const cx = Math.min(Math.max(c.x, wall.x), wall.x + wall.w), cy = Math.min(Math.max(c.y, wall.y), wall.y + wall.h);
      const dx = c.x - cx, dy = c.y - cy, dd = Math.hypot(dx, dy);
      if (dd > 0 && dd < r) { c.x += (dx / dd) * (r - dd); c.y += (dy / dd) * (r - dd); }
    }
  }

  /** Cats within `range` of (x, y): [id, x, y, angle, move (0 sit · 1 walk · 2 run · 3 held), look, petted just now, knows viewer, held by (player id)]. */
  visible(x, y, range, viewer) {
    const out = [];
    for (const c of this.list) {
      if (Math.abs(c.x - x) > range || Math.abs(c.y - y) > range) continue;
      out.push([c.id, Math.round(c.x), Math.round(c.y), Math.round(c.angle * 100) / 100, c.heldBy ? 3 : c.move, c.look, this.time - c.pettedAt < 1.5 ? 1 : 0, viewer && (this.friendly(c, viewer) || c.heldBy === viewer) ? 1 : 0, c.heldBy?.id ?? 0]);
    }
    return out;
  }
}
