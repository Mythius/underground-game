import { config } from '../config.js';
import { UG } from './underground.js';

// The homeless underground: ragged men with knives, who speak only Russian (see the client's lines).
//
//   sitters   keep to their own spot in a tunnel, a station or a shaft, rocking where they sit. Walk past
//             one and now and then (followChance) he gets up and creeps after you, and when he's close
//             behind you, stabs you in the back.
//   wanderers shuffle about the maze. One that sees you (attackChance) comes straight at you, knife out.
//
// Anyone who's hurt one has a fight on his hands, whichever kind. They give up on you after a while out of
// sight, or once they're too far from home (a sitter goes back to his spot). Killed, one leaves a body with
// his knife and a few coins on it, and someone new turns up a while later, out of everyone's sight.

const WANDER_CELLS = new Set([UG.MINE, UG.TUNNEL, UG.PLATFORM, UG.PASSAGE, UG.CAVE]); // (not the bunkers, the oil hall or the sewers)
const SIT_CELLS = new Set([UG.TUNNEL, UG.PLATFORM, UG.PASSAGE, UG.MINE]);
const LOOK = [1, 11, 2, 9]; // their bodies: a dark coat, brown trousers, an ushanka (indexes into config.looks)

export class Homeless {
  constructor(world, layout) {
    this.world = world;
    this.layout = layout;
    this.list = []; // { id, kind: 'sit' | 'roam', home, x, y, angle, health, state, target, route, … }
    this.nextId = 1;
    this.time = 0;
    this.kills = []; // players stabbed to death (the World removes them)
    this.events = []; // { player, kind } for the room to pass on
    this.timers = []; // [kind, seconds] until a dead one is replaced
    const { cols, rows, grid } = layout;
    this.open = (cx, cy) => cx >= 0 && cy >= 0 && cx < cols && cy < rows && grid.charCodeAt(cy * cols + cx) !== 48 && grid.charCodeAt(cy * cols + cx) - 48 !== UG.HALL;
    this.kindAt = (cx, cy) => grid.charCodeAt(cy * cols + cx) - 48;
    const c = config.homeless;
    for (let i = 0; i < c.sitters; i++) this.#spawn('sit');
    for (let i = 0; i < c.wanderers; i++) this.#spawn('roam');
  }

  // ---- placing them --------------------------------------------------------------------------

  /** The middle of a random floor cell of one of `kinds`, clear to stand in and away from everyone. */
  #spot(kinds, clearOf = 0) {
    const { cols, rows, cell } = this.layout, w = this.world, r = config.homeless.radius;
    for (let i = 0; i < 400; i++) {
      const cx = Math.floor(Math.random() * cols), cy = Math.floor(Math.random() * rows);
      if (!this.open(cx, cy) || !kinds.has(this.kindAt(cx, cy))) continue;
      const x = (cx + 0.5) * cell + (Math.random() - 0.5) * cell * 0.3, y = (cy + 0.5) * cell + (Math.random() - 0.5) * cell * 0.3;
      if (w.isBlocked(x, y, r + 4) || w.isSwimming(x, y)) continue;
      if (clearOf && [...w.players.values()].some((p) => Math.hypot(p.x - x, p.y - y) < clearOf)) continue;
      if (this.list.some((h) => Math.hypot(h.x - x, h.y - y) < cell * 3)) continue; // (spread out)
      return { x, y };
    }
    return null;
  }

  #spawn(kind) {
    let at = null;
    for (let i = 0; i < 20 && !at; i++) {
      at = this.#spot(kind === 'sit' ? SIT_CELLS : WANDER_CELLS, config.homeless.spawnClear);
      if (at && kind === 'roam' && !this.#wanderRoute({ ...at, home: at }).length) at = null; // (not in a pocket with nowhere to go)
    }
    if (!at) return false;
    this.list.push({
      id: this.nextId++, kind, home: at, x: at.x, y: at.y, angle: Math.random() * Math.PI * 2, health: config.homeless.health,
      state: kind === 'sit' ? 'sit' : 'roam', target: null, route: [], lastSeen: 0, stab: 0, stabAt: -9, passing: new Map(), judged: new Map(), look: 0, stuck: 0,
    });
    return true;
  }

  // ---- who they go after ------------------------------------------------------------------------

  #prey(p) {
    return p && p.alive && !p.vehicle && !p.hidden && !p.jailed && this.world.players.get(p.id) === p;
  }

  #sees(h, p) {
    return Math.hypot(p.x - h.x, p.y - h.y) < config.homeless.sight && this.world.lineOfSight(h.x, h.y, p.x, p.y);
  }

  /** Go after p: 'stalk' (creeping up behind) or 'fight' (straight at them). */
  #hunt(h, p, state) {
    if (h.target === p && (h.state === 'fight' || h.state === state)) return;
    Object.assign(h, { target: p, state, lastSeen: this.time, route: [] });
    if (state === 'fight') this.events.push({ player: p, kind: 'homeless_attack' });
  }

  /** A sitter: did anyone just walk past him? Once each time they go by, followChance he gets up after them. */
  #watchPassers(h) {
    const c = config.homeless;
    for (const p of this.world.players.values()) {
      if (!this.#prey(p)) { h.passing.delete(p); continue; }
      const d = Math.hypot(p.x - h.x, p.y - h.y);
      if (d < c.passRange && this.world.lineOfSight(h.x, h.y, p.x, p.y)) { h.passing.set(p, true); continue; }
      if (!h.passing.get(p) || d < c.passRange * 1.6) continue;
      h.passing.delete(p); // gone by: does he follow?
      if ((h.judged.get(p) ?? -Infinity) > this.time) continue;
      h.judged.set(p, this.time + c.rejudgeSec);
      if (Math.random() < c.followChance) return this.#hunt(h, p, 'stalk');
    }
  }

  /** A wanderer, looking about now and then: anyone in sight, attackChance he goes for them. */
  #lookAbout(h) {
    const c = config.homeless;
    if ((h.look -= 1) > 0) return;
    h.look = 10; // (every so many ticks)
    for (const p of this.world.players.values()) {
      if (!this.#prey(p) || !this.#sees(h, p)) continue;
      if ((h.judged.get(p) ?? -Infinity) > this.time) continue;
      h.judged.set(p, this.time + c.rejudgeSec);
      if (Math.random() < c.attackChance) return this.#hunt(h, p, 'fight');
    }
  }

  // ---- the simulation ---------------------------------------------------------------------------

  step(dt) {
    this.time += dt;
    const c = config.homeless;
    for (let i = this.timers.length - 1; i >= 0 && !this.world.flood?.active; i--) { // (nobody new while it's flooded)
      if ((this.timers[i][1] -= dt) > 0) continue;
      if (this.#spawn(this.timers[i][0])) this.timers.splice(i, 1);
      else this.timers[i][1] = 10; // (nowhere out of sight just now: try again in a bit)
    }
    for (const h of this.list) {
      h.stab = Math.max(0, h.stab - dt);
      const p = h.target;
      if (p && !this.#prey(p)) Object.assign(h, { target: null, state: h.kind === 'sit' ? 'back' : 'roam', route: [] });
      if (!h.target) {
        if (h.kind === 'sit') {
          if (h.state === 'back') { if (this.#goTo(h, h.home.x, h.home.y, c.walkSpeed, dt) < 12) h.state = 'sit'; }
          else h.angle += Math.sin(this.time * 0.7 + h.id) * dt * 0.4; // (rocking, muttering)
          this.#watchPassers(h);
        } else {
          this.#roam(h, dt);
          this.#lookAbout(h);
        }
        continue;
      }
      // After someone: give up once they've been out of sight long enough, or he's strayed too far.
      if (this.#sees(h, p)) h.lastSeen = this.time;
      if (this.time - h.lastSeen > c.giveUpSec || Math.hypot(h.x - h.home.x, h.y - h.home.y) > c.leash) {
        Object.assign(h, { target: null, state: h.kind === 'sit' ? 'back' : 'roam', route: [] });
        continue;
      }
      const d = Math.hypot(p.x - h.x, p.y - h.y);
      const reach = c.radius + p.radius + c.reach;
      if (h.state === 'stalk') { // creeping along behind: quick when far, a lunge when close
        const facingAway = Math.cos(Math.atan2(h.y - p.y, h.x - p.x) - (p.input?.aim ?? 0)) < 0.2; // (they're not looking his way)
        if ((d < c.lungeRange && facingAway) || d < c.lungeRange * 0.6) { // (turned round on him: it's a fight anyway)
          h.state = 'fight';
          this.events.push({ player: p, kind: 'homeless_attack', behind: facingAway });
        }
        this.#goTo(h, p.x, p.y, d < c.lungeRange ? c.runSpeed : c.stalkSpeed, dt);
      } else if (d > reach * 0.8) this.#goTo(h, p.x, p.y, c.runSpeed, dt);
      if (h.state === 'fight' || d < reach) {
        h.angle = Math.atan2(p.y - h.y, p.x - h.x);
        if (d < reach && h.stab <= 0) {
          h.stab = c.stabCooldownSec;
          h.stabAt = this.time;
          p.hurt(p.maxHealth * c.stabShare);
          if (p.health <= 0) this.kills.push(p);
        }
      }
    }
  }

  /** Wanderers: from one floor cell to another a little way off, along the shafts and tunnels. */
  #roam(h, dt) {
    const c = config.homeless;
    if (!h.route.length) {
      h.route = this.#wanderRoute(h);
      h.stuck = 0;
      if (!h.route.length) return;
    }
    const [nx, ny] = h.route[0];
    if (Math.hypot(nx - h.x, ny - h.y) < 24) { h.route.shift(); return; }
    if (this.#step(h, nx, ny, c.walkSpeed * dt)) h.stuck = Math.max(0, h.stuck - dt);
    else if ((h.stuck += dt) > 1.5) h.route = []; // (wedged on something: somewhere else, then)
  }

  /** A walk to a random cell a few to a dozen-odd cells away, through cells he wanders (homeward if he's far from home). */
  #wanderRoute(h) {
    const { cols, cell: C } = this.layout;
    const s = [Math.floor(h.x / C), Math.floor(h.y / C)];
    const from = new Map([[s[1] * cols + s[0], -1]]), depth = new Map([[s[1] * cols + s[0], 0]]);
    const q = [s], picks = [];
    const far = Math.hypot(h.x - h.home.x, h.y - h.home.y) > config.homeless.roamRange;
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i], k0 = y * cols + x, d = depth.get(k0);
      if (d >= 4) {
        const cx = (x + 0.5) * C, cy = (y + 0.5) * C;
        if (!far || Math.hypot(cx - h.home.x, cy - h.home.y) < Math.hypot(h.x - h.home.x, h.y - h.home.y) - C * 2) picks.push(k0);
      }
      if (d >= 16) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = ny * cols + nx;
        if (from.has(k) || !this.open(nx, ny) || !WANDER_CELLS.has(this.kindAt(nx, ny))) continue;
        from.set(k, k0);
        depth.set(k, d + 1);
        q.push([nx, ny]);
      }
    }
    if (!picks.length) return [];
    const path = [];
    for (let k = picks[Math.floor(Math.random() * picks.length)]; k !== -1; k = from.get(k)) path.push([((k % cols) + 0.5) * C, (Math.floor(k / cols) + 0.5) * C]);
    return path.reverse().slice(1);
  }

  /** Toward (tx, ty): straight if he can, else cell by cell round the rock. Returns how far there is to go. */
  #goTo(h, tx, ty, speed, dt) {
    const d = Math.hypot(tx - h.x, ty - h.y);
    const straight = d < this.layout.cell * 1.2 || this.world.lineOfSight(h.x, h.y, tx, ty);
    if (straight) { h.route = []; this.#step(h, tx, ty, speed * dt); return d; }
    const C = this.layout.cell, last = h.route.at(-1);
    if (!h.route.length || !last || Math.floor(last[0] / C) !== Math.floor(tx / C) || Math.floor(last[1] / C) !== Math.floor(ty / C)) h.route = this.#route(h.x, h.y, tx, ty, null);
    if (!h.route.length) { this.#step(h, tx, ty, speed * dt); return d; }
    const [nx, ny] = h.route[0];
    if (Math.hypot(nx - h.x, ny - h.y) < 24) h.route.shift();
    else this.#step(h, nx, ny, speed * dt);
    return d;
  }

  /** Cell centres from (sx, sy) to (tx, ty), breadth-first over the open cells (only `kinds`, if given). */
  #route(sx, sy, tx, ty, kinds) {
    const { cols, cell: C } = this.layout;
    const s = [Math.floor(sx / C), Math.floor(sy / C)], t = [Math.floor(tx / C), Math.floor(ty / C)];
    const ok = (x, y) => this.open(x, y) && (!kinds || kinds.has(this.kindAt(x, y)) || (x === s[0] && y === s[1]));
    const from = new Map([[s[1] * cols + s[0], -1]]);
    const q = [s];
    for (let i = 0; i < q.length && i < 6000; i++) {
      const [x, y] = q[i];
      if (x === t[0] && y === t[1]) {
        const path = [];
        for (let k = y * cols + x; k !== -1; k = from.get(k)) path.push([((k % cols) + 0.5) * C, (Math.floor(k / cols) + 0.5) * C]);
        path.reverse().shift(); // (not the cell he's in)
        if (path.length) path[path.length - 1] = [tx, ty];
        return path;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = ny * cols + nx;
        if (from.has(k) || !ok(nx, ny)) continue;
        from.set(k, y * cols + x);
        q.push([nx, ny]);
      }
    }
    return [];
  }

  /** A step toward (tx, ty), pushed off walls, opening any unlocked door in the way. False if he didn't get anywhere. */
  #step(h, tx, ty, step) {
    const dx = tx - h.x, dy = ty - h.y, d = Math.hypot(dx, dy);
    if (d < 1) return true;
    h.angle = Math.atan2(dy, dx);
    const w = this.world, rad = config.homeless.radius, was = [h.x, h.y];
    for (const door of w.doors) {
      if (!door.underground || door.open || door.locked) continue;
      if (Math.abs(door.x + door.w / 2 - h.x) < 80 && Math.abs(door.y + door.h / 2 - h.y) < 80 && Math.hypot(door.x + door.w / 2 - h.x, door.y + door.h / 2 - h.y) < rad + 50) {
        door.open = true;
        w.pendingDoors.push(door);
      }
    }
    h.x += (dx / d) * Math.min(step, d);
    h.y += (dy / d) * Math.min(step, d);
    for (const wall of w.wallsNear(h.x, h.y, rad)) {
      const cx = Math.min(Math.max(h.x, wall.x), wall.x + wall.w), cy = Math.min(Math.max(h.y, wall.y), wall.y + wall.h);
      const ex = h.x - cx, ey = h.y - cy, dd = Math.hypot(ex, ey);
      if (dd > 0 && dd < rad) { h.x += (ex / dd) * (rad - dd); h.y += (ey / dd) * (rad - dd); }
    }
    if (w.isSwimming(h.x, h.y)) [h.x, h.y] = was; // (they keep out of the lake)
    return Math.hypot(h.x - was[0], h.y - was[1]) > step * 0.2;
  }

  // ---- getting hurt ------------------------------------------------------------------------------

  hitBy(ax, ay, bx, by, r, segmentDistSq) {
    for (const h of this.list) if (segmentDistSq(ax, ay, bx, by, h.x, h.y) < (config.homeless.radius + r) ** 2) return h;
    return null;
  }

  /** Gone, with nothing left behind (cleared out by a flood, or swept off by its wave): someone new turns up later. */
  vanish(h) {
    if (!this.list.includes(h)) return;
    this.list.splice(this.list.indexOf(h), 1);
    this.timers.push([h.kind, config.homeless.respawnSec]);
  }

  /** Hurt by `attacker`: he fights back (whichever kind he is). Killed: a body with his knife and a few coins. */
  damage(h, amount, attacker) {
    if (!this.list.includes(h)) return false;
    h.health -= amount;
    if (attacker?.kind === 'player' && this.#prey(attacker)) { h.target = null; this.#hunt(h, attacker, 'fight'); }
    if (h.health > 0) return false;
    this.list.splice(this.list.indexOf(h), 1);
    const c = config.homeless;
    const cash = c.cash[0] + Math.floor(Math.random() * (c.cash[1] - c.cash[0] + 1));
    this.world.bodies?.add({ x: h.x, y: h.y, angle: h.angle, kind: 'npc', look: LOOK, items: [{ type: 'knife', ammo: 0, reloadTimer: 0 }], cash, killer: attacker?.kind === 'player' ? attacker : null });
    this.timers.push([h.kind, c.respawnSec]);
    return true;
  }

  /** In view: [id, x, y, angle, state (0 sitting, 1 wandering / going home, 2 creeping after someone, 3 fighting), health 0–100, stabbing]. */
  visible(x, y, range) {
    const states = { sit: 0, roam: 1, back: 1, stalk: 2, fight: 3 };
    const out = [];
    for (const h of this.list) {
      if (Math.abs(h.x - x) > range || Math.abs(h.y - y) > range) continue;
      out.push([h.id, Math.round(h.x), Math.round(h.y), Math.round(h.angle * 100) / 100, states[h.state] ?? 1, Math.round((h.health / config.homeless.health) * 100), this.time - h.stabAt < 0.3 ? 1 : 0]);
    }
    return out;
  }
}
