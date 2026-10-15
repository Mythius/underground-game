import { config } from '../config.js';
import { Pickup } from './entities.js';

// The albino bear: it lives in one of the caves underground, and it's blind. It never sees you: it hears
// you. A gunshot carries a long way; sprinting is loud, walking less so, creeping (a gentle push on the
// stick) hardly at all, and standing still is silent. It lumbers over to see what the noise was, or, if
// it was close, charges straight at where it came from and swipes at whatever's there. Bump into it and
// it knows exactly where you are. It takes an absurd amount of killing; a while after it dies another
// one has moved into the cave.

const rand = ([a, b]) => a + Math.random() * (b - a);

export class Bears {
  constructor(world) {
    this.world = world;
    this.list = []; // { id, home: { x, y, r }, x, y, angle, health, state: 'roam' | 'listen' | 'charge' | 'search', to, until, swipe }
    this.homes = []; // { x, y, r, cells: [[x, y]], dead: seconds till the next one moves in, or null }
    this.nextId = 1;
    this.kills = []; // players it's killed (the World removes them)
    this.events = []; // { player, kind } for the room to pass on
    this.lastPos = new Map(); // player -> [x, y]: how fast they're going (their footsteps)
    this.heard = new WeakSet(); // bullets already heard
    this.time = 0;
  }

  /** A bear's den: a cave (centre, radius) and the floor cells in it (where it wanders). */
  addHome(home) {
    this.homes.push({ ...home, dead: null });
    this.#spawn(this.homes.at(-1));
  }

  #spawn(home) {
    const [cx, cy] = home.cells[Math.floor(Math.random() * home.cells.length)] ?? [home.x, home.y];
    this.list.push({ id: this.nextId++, home, x: cx, y: cy, angle: Math.random() * Math.PI * 2, health: config.bear.health, state: 'roam', to: null, until: 0, swipe: 0, hurtAt: -99 });
    home.dead = null;
  }

  /** Can it hurt p? On foot, alive and free. */
  #prey(p) {
    return p && p.alive && !p.vehicle && !p.hidden && !p.jailed && this.world.players.get(p.id) === p;
  }

  /** Something made a noise at (x, y), heard out to `range`: each bear in earshot goes to look (or charges, if it's close). */
  noise(x, y, range, who = null) {
    for (const b of this.list) {
      const d = Math.hypot(x - b.x, y - b.y);
      if (d > range || Math.hypot(x - b.home.x, y - b.home.y) > config.bear.leash) continue;
      const close = d < config.bear.chargeWithin;
      if (b.state === 'charge' && !close && b.to && Math.hypot(b.to.x - b.x, b.to.y - b.y) < d) continue; // (already after something nearer)
      if (close && b.state !== 'charge' && who?.kind === 'player') this.events.push({ player: who, kind: 'bear' });
      b.state = close ? 'charge' : 'listen';
      b.to = { x, y };
      b.until = this.time + (close ? 8 : 14);
    }
  }

  step(dt) {
    this.time += dt;
    const c = config.bear;
    for (const home of this.homes) { // a while after it's killed, another one's moved in (if nobody's watching)
      if (home.dead === null || (home.dead -= dt) > 0) continue;
      if ([...this.world.players.values()].some((p) => Math.hypot(p.x - home.x, p.y - home.y) < home.r + 600)) { home.dead = 20; continue; }
      this.#spawn(home);
    }
    if (!this.list.length) return;
    this.#listen(dt);
    for (const b of this.list) {
      b.swipe = Math.max(0, b.swipe - dt);
      // Anyone it bumps into, it knows is there: a swipe.
      for (const p of this.world.players.values()) {
        if (!this.#prey(p) || Math.hypot(p.x - b.x, p.y - b.y) > c.radius + p.radius + c.reach) continue;
        b.angle = Math.atan2(p.y - b.y, p.x - b.x);
        if (b.state !== 'charge') { b.state = 'charge'; b.to = { x: p.x, y: p.y }; b.until = this.time + 6; this.events.push({ player: p, kind: 'bear' }); }
        if (b.swipe <= 0) {
          b.swipe = c.swipeCooldownSec;
          p.hurt(p.maxHealth * c.swipeShare);
          if (p.health <= 0) this.kills.push(p);
        }
      }
      if (b.state === 'roam') {
        if (!b.to || this.time > b.until || Math.hypot(b.to.x - b.x, b.to.y - b.y) < 20) {
          const [x, y] = b.home.cells[Math.floor(Math.random() * b.home.cells.length)] ?? [b.home.x, b.home.y];
          b.to = { x, y };
          b.until = this.time + rand(c.wanderSec);
        }
        this.#toward(b, c.roamSpeed * dt);
        continue;
      }
      // After a noise: get there (or give up), then nose about a while, then back to wandering.
      const far = Math.hypot(b.x - b.home.x, b.y - b.home.y) > c.leash;
      if (far || this.time > b.until) { Object.assign(b, { state: 'roam', to: null }); continue; }
      if (b.state === 'search') { b.angle += Math.sin(this.time * 2 + b.id) * dt; continue; }
      const arrived = Math.hypot(b.to.x - b.x, b.to.y - b.y) < c.radius;
      if (arrived) { Object.assign(b, { state: 'search', until: this.time + rand(c.searchSec) }); continue; }
      if (!this.#toward(b, (b.state === 'charge' ? c.chargeSpeed : c.listenSpeed) * dt)) Object.assign(b, { state: 'search', until: this.time + rand(c.searchSec) }); // (stuck: sniffs about where it is)
    }
  }

  /** What it can hear this tick: footsteps (by how fast each player's going) and new gunshots. */
  #listen(dt) {
    const c = config.bear;
    for (const p of this.world.players.values()) {
      const last = this.lastPos.get(p);
      this.lastPos.set(p, [p.x, p.y]);
      if (!last || !this.#prey(p)) continue;
      const speed = Math.hypot(p.x - last[0], p.y - last[1]) / dt;
      const range = speed > c.sprintSpeed ? c.hear.sprint : speed > c.walkSpeed ? c.hear.walk : speed > 15 ? c.hear.creep : 0;
      if (range) this.noise(p.x, p.y, range, p);
    }
    for (const b of this.world.bullets.values()) {
      if (this.heard.has(b)) continue;
      this.heard.add(b);
      const o = b.owner;
      if (o && Number.isFinite(o.x)) this.noise(o.x, o.y, c.hear.gunshot, o);
    }
  }

  /** A step toward b.to; false if it's walked into something. */
  #toward(b, step) {
    const dx = b.to.x - b.x, dy = b.to.y - b.y, d = Math.hypot(dx, dy);
    if (d < 1) return true;
    b.angle = Math.atan2(dy, dx);
    const was = [b.x, b.y];
    b.x += (dx / d) * Math.min(step, d);
    b.y += (dy / d) * Math.min(step, d);
    const rad = config.bear.radius;
    for (const wall of this.world.wallsNear(b.x, b.y, rad)) {
      const cx = Math.min(Math.max(b.x, wall.x), wall.x + wall.w), cy = Math.min(Math.max(b.y, wall.y), wall.y + wall.h);
      const ex = b.x - cx, ey = b.y - cy, dd = Math.hypot(ex, ey);
      if (dd > 0 && dd < rad) { b.x += (ex / dd) * (rad - dd); b.y += (ey / dd) * (rad - dd); }
    }
    if (this.world.isSwimming(b.x, b.y)) [b.x, b.y] = was; // (it won't go in the water)
    return Math.hypot(b.x - was[0], b.y - was[1]) > step * 0.2;
  }

  /** The bear a bullet path a→b (radius r) hits, or null. */
  hitBy(ax, ay, bx, by, r, segmentDistSq) {
    for (const b of this.list) if (segmentDistSq(ax, ay, bx, by, b.x, b.y) < (config.bear.radius + r) ** 2) return b;
    return null;
  }

  /** Hurt by `attacker`: it knows where that came from. Killed, it drops what it had in it. */
  damage(b, amount, attacker) {
    b.health -= amount;
    b.hurtAt = this.time;
    if (attacker && Number.isFinite(attacker.x)) this.noise(attacker.x, attacker.y, Infinity, attacker);
    if (b.health > 0) return;
    this.list.splice(this.list.indexOf(b), 1);
    b.home.dead = config.bear.respawnSec;
    const w = this.world, p = new Pickup(w.nextEntityId++, b.x, b.y, null, config.bear.cash);
    w.pickups.set(p.id, p);
    w.grid.insert(p);
    if (attacker?.kind === 'player') this.events.push({ player: attacker, kind: 'bear_killed' });
  }

  /** Bears within `range` of (x, y): [id, x, y, angle, state (0 wandering, 1 heard something, 2 charging, 3 sniffing about), health 0–1, hurt lately]. */
  visible(x, y, range) {
    const out = [];
    const states = { roam: 0, listen: 1, charge: 2, search: 3 };
    for (const b of this.list) {
      if (Math.abs(b.x - x) > range || Math.abs(b.y - y) > range) continue;
      out.push([b.id, Math.round(b.x), Math.round(b.y), Math.round(b.angle * 100) / 100, states[b.state], Math.round((b.health / config.bear.health) * 1000) / 1000, this.time - b.hurtAt < 6 ? 1 : 0]);
    }
    return out;
  }
}
