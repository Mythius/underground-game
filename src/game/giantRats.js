import { config } from '../config.js';

// Giant rats underground: three times the size of the ordinary ones (those are only drawn by each client
// and pay you no mind), with eyes that glow in the dark. They nose about their own patch of the maze, and
// one that sees you comes for you — faster than you walk, not as fast as you sprint — biting till you're
// dead or away. They give up after a while out of sight or too far from home. Killed, another turns up
// later, out of everyone's sight.

export class GiantRats {
  constructor(world, layout) {
    this.world = world;
    this.layout = layout;
    this.list = []; // { id, home, x, y, angle, health, target, lastSeen, bite, biteAt, wander, look }
    this.nextId = 1;
    this.time = 0;
    this.kills = []; // players bitten to death (the World removes them)
    this.events = []; // { player, kind } for the room to pass on
    this.timers = []; // seconds until each dead one is replaced
    for (let i = 0; i < config.giantRats.count; i++) this.#spawn(0);
  }

  #floor(x, y) {
    const { cols, rows, cell, grid } = this.layout, cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    return cx >= 0 && cy >= 0 && cx < cols && cy < rows && grid.charCodeAt(cy * cols + cx) !== 48;
  }

  /** Somewhere on open, dry floor, at least `clearOf` from every player and spread out from the others. */
  #spawn(clearOf) {
    const { cols, rows, cell } = this.layout, w = this.world, c = config.giantRats;
    for (let i = 0; i < 300; i++) {
      const x = (Math.floor(Math.random() * cols) + 0.5) * cell, y = (Math.floor(Math.random() * rows) + 0.5) * cell;
      if (!this.#floor(x, y) || w.isBlocked(x, y, c.radius + 4) || w.isSwimming(x, y)) continue;
      if (clearOf && [...w.players.values()].some((p) => Math.hypot(p.x - x, p.y - y) < clearOf)) continue;
      if (this.list.some((r) => Math.hypot(r.x - x, r.y - y) < cell * 4)) continue;
      this.list.push({ id: this.nextId++, home: { x, y }, x, y, angle: Math.random() * Math.PI * 2, health: c.health, target: null, lastSeen: 0, bite: 0, biteAt: -9, wander: null, look: 0 });
      return true;
    }
    return false;
  }

  #prey(p) {
    return p && p.alive && !p.vehicle && !p.hidden && !p.jailed && this.world.players.get(p.id) === p;
  }

  #sees(r, p) {
    return Math.hypot(p.x - r.x, p.y - r.y) < config.giantRats.sight && this.world.lineOfSight(r.x, r.y, p.x, p.y);
  }

  #hunt(r, p) {
    if (r.target === p) return;
    Object.assign(r, { target: p, lastSeen: this.time });
    this.events.push({ player: p, kind: 'giant_rat' });
  }

  step(dt) {
    this.time += dt;
    const c = config.giantRats;
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if ((this.timers[i] -= dt) > 0) continue;
      if (this.#spawn(c.spawnClear)) this.timers.splice(i, 1);
      else this.timers[i] = 10;
    }
    for (const r of this.list) {
      r.bite = Math.max(0, r.bite - dt);
      if (r.target && !this.#prey(r.target)) r.target = null;
      if (!r.target) {
        if ((r.look -= 1) <= 0) { // (looking about every so many ticks)
          r.look = 8;
          for (const p of this.world.players.values()) if (this.#prey(p) && this.#sees(r, p)) { this.#hunt(r, p); break; }
        }
        if (!r.target) { this.#nose(r, dt); continue; }
      }
      const p = r.target;
      if (this.#sees(r, p)) r.lastSeen = this.time;
      if (this.time - r.lastSeen > c.giveUpSec || Math.hypot(r.x - r.home.x, r.y - r.home.y) > c.leash) { r.target = null; r.wander = null; continue; }
      const d = Math.hypot(p.x - r.x, p.y - r.y), reach = c.radius + p.radius + c.reach;
      r.angle = Math.atan2(p.y - r.y, p.x - r.x);
      if (d > reach - 4) this.#step(r, Math.min(d - (reach - 6), c.runSpeed * dt));
      if (d <= reach && r.bite <= 0) {
        r.bite = c.biteCooldownSec;
        r.biteAt = this.time;
        p.hurt(p.maxHealth * c.biteShare);
        if (p.health <= 0) { this.kills.push(p); r.target = null; }
      }
    }
  }

  /** No one to bite: scurry to a spot it can see a little way off, sniff about, and again (homeward if it's strayed). */
  #nose(r, dt) {
    const c = config.giantRats;
    if (!r.wander || this.time > r.wander.until) {
      const home = Math.hypot(r.x - r.home.x, r.y - r.home.y) > c.roam;
      for (let i = 0; i < 8; i++) {
        const a = home ? Math.atan2(r.home.y - r.y, r.home.x - r.x) + (Math.random() - 0.5) : Math.random() * Math.PI * 2, d = 80 + Math.random() * 300;
        const x = r.x + Math.cos(a) * d, y = r.y + Math.sin(a) * d;
        if (!this.#floor(x, y) || this.world.isSwimming(x, y) || !this.world.lineOfSight(r.x, r.y, x, y)) continue;
        r.wander = { x, y, until: this.time + 2 + Math.random() * 5 };
        break;
      }
      if (!r.wander || this.time > r.wander.until) { r.wander = { x: r.x, y: r.y, until: this.time + 1 }; return; }
    }
    const d = Math.hypot(r.wander.x - r.x, r.wander.y - r.y);
    if (d < 10) return;
    r.angle = Math.atan2(r.wander.y - r.y, r.wander.x - r.x);
    this.#step(r, Math.min(d, c.walkSpeed * dt));
  }

  /** Along r.angle, pushed off the walls, kept out of the water. */
  #step(r, step) {
    const was = [r.x, r.y], rad = config.giantRats.radius;
    r.x += Math.cos(r.angle) * step;
    r.y += Math.sin(r.angle) * step;
    for (const wall of this.world.wallsNear(r.x, r.y, rad)) {
      const cx = Math.min(Math.max(r.x, wall.x), wall.x + wall.w), cy = Math.min(Math.max(r.y, wall.y), wall.y + wall.h);
      const ex = r.x - cx, ey = r.y - cy, dd = Math.hypot(ex, ey);
      if (dd > 0 && dd < rad) { r.x += (ex / dd) * (rad - dd); r.y += (ey / dd) * (rad - dd); }
    }
    if (this.world.isSwimming(r.x, r.y) || !this.#floor(r.x, r.y)) [r.x, r.y] = was;
  }

  hitBy(ax, ay, bx, by, rad, segmentDistSq) {
    for (const r of this.list) if (segmentDistSq(ax, ay, bx, by, r.x, r.y) < (config.giantRats.radius + rad) ** 2) return r;
    return null;
  }

  /** Hurt by `attacker`: it comes for whoever did it, or dies (and another turns up later). */
  damage(r, amount, attacker) {
    if (!this.list.includes(r)) return false;
    r.health -= amount;
    if (r.health > 0) {
      if (attacker?.kind === 'player' && this.#prey(attacker)) this.#hunt(r, attacker);
      return false;
    }
    this.list.splice(this.list.indexOf(r), 1);
    this.timers.push(config.giantRats.respawnSec);
    return true;
  }

  /** In view: [id, x, y, angle, running (0/1), health 0–100, biting (0/1)]. */
  visible(x, y, range) {
    const out = [];
    for (const r of this.list) {
      if (Math.abs(r.x - x) > range || Math.abs(r.y - y) > range) continue;
      out.push([r.id, Math.round(r.x), Math.round(r.y), Math.round(r.angle * 100) / 100, r.target ? 1 : 0, Math.round((r.health / config.giantRats.health) * 100), this.time - r.biteAt < 0.25 ? 1 : 0]);
    }
    return out;
  }
}
