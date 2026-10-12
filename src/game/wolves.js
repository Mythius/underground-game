import { config } from '../config.js';

// Wolves. When night falls, a few packs come out of the forests in the country (never in town): each
// pack keeps to its den, padding about between the trees. Walk within sight of one on foot and the whole
// pack runs you down — they're faster than you, and a few bites kill. A car is the way out: they won't
// go for anyone driving, and one hit at speed kills a wolf. Shoot or stab them and they come for you.
// At dawn they're gone, and the next night brings new packs.

const rand = ([a, b]) => a + Math.random() * (b - a);

export class Wolves {
  constructor(world) {
    this.world = world;
    this.list = []; // { id, pack, x, y, angle, health, target, bite, wander }
    this.packs = []; // { id, den: { x, y, r }, target, until }
    this.nextId = 1;
    this.wasNight = false;
    this.kills = []; // players bitten to death (the World removes them)
    this.events = []; // { player, kind } for the room to pass on
  }

  /** Is (x, y) in town? Wolves keep to the country. */
  #inTown(x, y) {
    const c = this.world.city;
    return Boolean(c) && x > c.x - 300 && x < c.x + c.w + 300 && y > c.y - 300 && y < c.y + c.h + 300;
  }

  /** Forests out in the country, where packs make their dens. */
  dens() {
    return (this.world.forests ?? []).filter((f) => !this.#inTown(f.x, f.y));
  }

  #canStand(x, y) {
    const w = this.world;
    return x > 40 && y > 40 && x < w.width - 40 && y < w.height - 40 && !w.isBlocked(x, y, config.wolves.radius) && !w.isSwimming(x, y) && !this.#inTown(x, y);
  }

  /** Night falls: up to packsPerNight packs, each in its own forest where there are enough, away from everyone. */
  spawnNight() {
    const r = config.wolves;
    const dens = this.dens().sort(() => Math.random() - 0.5);
    if (!dens.length) return;
    const players = [...this.world.players.values()];
    const clear = (d) => !players.some((p) => Math.hypot(p.x - d.x, p.y - d.y) < r.spawnClear);
    const order = [...dens.filter(clear), ...dens.filter((d) => !clear(d))]; // (crowded forests only if there's no choice)
    for (let k = 0; k < r.packsPerNight; k++) {
      const den = order[k % order.length];
      const pack = { id: this.packs.length + 1, den, target: null, until: 0 };
      const size = Math.round(rand(r.packSize));
      let placed = 0;
      for (let i = 0; i < 60 && placed < size; i++) {
        const a = Math.random() * Math.PI * 2, d = Math.random() * den.r * 0.6;
        const x = den.x + Math.cos(a) * d, y = den.y + Math.sin(a) * d;
        if (!this.#canStand(x, y) || players.some((p) => Math.hypot(p.x - x, p.y - y) < r.sight + 100)) continue;
        this.list.push({ id: this.nextId++, pack, x, y, angle: Math.random() * Math.PI * 2, health: r.health, bite: 0, wander: null });
        placed++;
      }
      if (placed) this.packs.push(pack);
    }
  }

  /** Dawn: every wolf slinks off. */
  clear() {
    this.list = [];
    this.packs = [];
  }

  /** Can a wolf go for p? On foot, in the open, alive and free. */
  #prey(p) {
    return p && p.alive && !p.vehicle && !p.hidden && !p.jailed && this.world.players.get(p.id) === p;
  }

  step(dt) {
    const night = Boolean(this.world.night);
    if (night && !this.wasNight) this.spawnNight();
    if (!night && this.wasNight) this.clear();
    this.wasNight = night;
    if (!this.list.length) return;
    const r = config.wolves;
    this.time = (this.time ?? 0) + dt;

    // Each pack picks its prey: whoever comes within sight of any of them; it gives up past the leash.
    for (const pack of this.packs) {
      const members = this.list.filter((w) => w.pack === pack);
      if (pack.target && (!this.#prey(pack.target) || Math.hypot(pack.target.x - pack.den.x, pack.target.y - pack.den.y) > r.leash)) pack.target = null;
      if (pack.target) continue;
      for (const p of this.world.players.values()) {
        if (!this.#prey(p) || Math.hypot(p.x - pack.den.x, p.y - pack.den.y) > r.leash) continue;
        if (members.some((w) => Math.hypot(p.x - w.x, p.y - w.y) < r.sight + p.radius)) {
          pack.target = p;
          this.events.push({ player: p, kind: 'wolves' });
          break;
        }
      }
    }

    for (const w of [...this.list]) {
      const t = w.pack.target;
      w.bite = Math.max(0, w.bite - dt);
      if (t) {
        w.running = true;
        const d = Math.hypot(t.x - w.x, t.y - w.y);
        const reach = t.radius + r.radius + r.biteReach;
        w.angle = Math.atan2(t.y - w.y, t.x - w.x);
        if (d > reach - 4) this.#move(w, Math.min(d - (reach - 6), r.runSpeed * dt));
        if (d <= reach && w.bite <= 0) {
          w.bite = r.biteCooldownSec;
          t.hurt(t.maxHealth * r.biteShare);
          if (t.health <= 0) {
            this.kills.push(t);
            w.pack.target = null;
          }
        }
        continue;
      }
      // No prey: pad about the den, now and then trotting to a new spot.
      w.running = false;
      if (!w.wander || this.time > w.wander.until) {
        const den = w.pack.den, a = Math.random() * Math.PI * 2, d = Math.random() * den.r * 0.7;
        w.wander = { x: den.x + Math.cos(a) * d, y: den.y + Math.sin(a) * d, until: this.time + rand(r.wanderSec) };
      }
      const d = Math.hypot(w.wander.x - w.x, w.wander.y - w.y);
      const far = Math.hypot(w.x - w.pack.den.x, w.y - w.pack.den.y) > w.pack.den.r;
      if (d > 20) {
        w.angle = Math.atan2(w.wander.y - w.y, w.wander.x - w.x);
        this.#move(w, Math.min(d, (far ? r.runSpeed * 0.5 : r.wanderSpeed) * dt)); // (heading home after a chase: a lope)
      }
    }
    this.#crushedByCars();
  }

  #move(w, step) {
    const nx = w.x + Math.cos(w.angle) * step, ny = w.y + Math.sin(w.angle) * step;
    if (this.#inTown(nx, ny) && !this.#inTown(w.x, w.y)) return; // (they won't follow you into town)
    w.x = nx;
    w.y = ny;
    const rad = config.wolves.radius;
    for (const wall of this.world.wallsNear(w.x, w.y, rad)) {
      const cx = Math.min(Math.max(w.x, wall.x), wall.x + wall.w), cy = Math.min(Math.max(w.y, wall.y), wall.y + wall.h);
      const dx = w.x - cx, dy = w.y - cy, dd = Math.hypot(dx, dy);
      if (dd > 0 && dd < rad) { w.x += (dx / dd) * (rad - dd); w.y += (dy / dd) * (rad - dd); }
    }
  }

  /** A car hitting a wolf at speed kills it. */
  #crushedByCars() {
    for (const v of this.world.vehicles.values()) {
      if ((v.speed ?? 0) < config.vehicles.crushMinSpeed) continue;
      const reach = (v.stats?.length ?? 90) / 2 + config.wolves.radius;
      for (const w of [...this.list]) if (Math.hypot(w.x - v.x, w.y - v.y) < reach) this.#remove(w);
    }
  }

  #remove(w) {
    this.list.splice(this.list.indexOf(w), 1);
  }

  /** The wolf bullet path a→b (radius r) hits, or null. */
  hitBy(ax, ay, bx, by, r, segmentDistSq) {
    for (const w of this.list) if (segmentDistSq(ax, ay, bx, by, w.x, w.y) < (config.wolves.radius + r) ** 2) return w;
    return null;
  }

  /** Hurt by `attacker` (a player or a hire): it may die; if not, the pack comes for a player who did it. */
  damage(w, amount, attacker) {
    w.health -= amount;
    if (w.health <= 0) return void this.#remove(w);
    if (attacker?.kind === 'player' && this.#prey(attacker) && !w.pack.target) {
      w.pack.target = attacker;
      this.events.push({ player: attacker, kind: 'wolves' });
    }
  }

  /** Wolves within `range` of (x, y): [id, x, y, angle, running]. */
  visible(x, y, range) {
    const out = [];
    for (const w of this.list) {
      if (Math.abs(w.x - x) > range || Math.abs(w.y - y) > range) continue;
      out.push([w.id, Math.round(w.x), Math.round(w.y), Math.round(w.angle * 100) / 100, w.running ? 1 : 0]);
    }
    return out;
  }
}
