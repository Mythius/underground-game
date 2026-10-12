import { config } from '../config.js';
import { bezierPoint } from './terrain.js';
import { WAREHOUSE_SIZES } from './buildings.js';
import { SIDEWALK, inBox } from './placement.js';

const STUCK_SEC = 2; // how often a walker's progress is checked
const STUCK_MOVE = 25; // moving less than this in STUCK_SEC counts as stuck
const STUCK_CLEAR = 200; // this far from where they got stuck, they're on their way again

// NPC townsfolk: they walk out of a building, along its dirt path to the road, along the roads to
// another building's path, and go in for a while. Where they go, they spend: food at shops (bread),
// fuel at gas stations, goods at markets. That spending is the town's demand.
//
// Some have a job instead (person.job: { kind, owner, … }): the hands at the work sites, the convicts
// and the cook at the prison. They don't go visiting; each step their job's owner moves them
// (owner.stepJob), and when one is killed the owner hires a replacement (owner.jobLost). They still
// fight back when hurt — convicts with their fists, and they never call the Militsiya.
//
// Walking happens on a small graph of the road centre-lines (junctions and ends are nodes), each
// townsperson keeping to one side of the road: on the sidewalk in town, the verge in the country.

/** Centre-line of a road: { horizontal, at (the fixed coordinate), from, to }. */
function centreLine(r) {
  const horizontal = r.w > r.h;
  return horizontal ? { horizontal, at: r.y + r.h / 2, from: r.x, to: r.x + r.w, half: r.h / 2 } : { horizontal, at: r.x + r.w / 2, from: r.y, to: r.y + r.h, half: r.w / 2 };
}

const pointOn = (line, s) => (line.horizontal ? { x: s, y: line.at } : { x: line.at, y: s });

export class RoadGraph {
  constructor(roads) {
    this.lines = roads.map(centreLine);
    this.nodes = []; // { x, y, links: [{ to, cost }] }
    // Each road's stops: its two ends plus every crossing with a perpendicular road.
    const stops = this.lines.map((line) => [line.from, line.to]);
    this.lines.forEach((a, i) =>
      this.lines.forEach((b, j) => {
        if (a.horizontal === b.horizontal) return;
        // b crosses a at b.at along a, if each lies within the other's span.
        if (b.at > a.from && b.at < a.to && a.at > b.from && a.at < b.to) {
          stops[i].push(b.at);
          stops[j].push(a.at);
        }
      }),
    );
    const key = new Map(); // "x,y" -> node index, so crossings are shared by both roads
    const nodeAt = (p) => {
      const k = `${Math.round(p.x)},${Math.round(p.y)}`;
      if (!key.has(k)) {
        key.set(k, this.nodes.length);
        this.nodes.push({ x: p.x, y: p.y, links: [] });
      }
      return key.get(k);
    };
    this.lineNodes = stops.map((list, i) => {
      const sorted = [...new Set(list.map(Math.round))].sort((a, b) => a - b);
      const ids = sorted.map((s) => nodeAt(pointOn(this.lines[i], s)));
      for (let k = 1; k < ids.length; k++) this.#link(ids[k - 1], ids[k]);
      return sorted.map((s, k) => ({ s, id: ids[k] }));
    });
  }

  #link(a, b) {
    const cost = Math.hypot(this.nodes[a].x - this.nodes[b].x, this.nodes[a].y - this.nodes[b].y);
    this.nodes[a].links.push({ to: b, cost });
    this.nodes[b].links.push({ to: a, cost });
  }

  /** The road whose area p is in (or nearest to), and where along its centre-line p projects. */
  locate(p) {
    let best = null;
    this.lines.forEach((line, i) => {
      const s = Math.min(Math.max(line.horizontal ? p.x : p.y, line.from), line.to);
      const q = pointOn(line, s);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.d) best = { line: i, s, d };
    });
    return best;
  }

  /** Points along the roads from a to b (both near roads), shortest way round. */
  route(a, b) {
    if (!this.lines.length) return [b];
    const from = this.locate(a);
    const to = this.locate(b);
    const lineA = this.lines[from.line];
    if (from.line === to.line) return [pointOn(lineA, from.s), pointOn(lineA, to.s)];
    // Dijkstra from a's two neighbouring stops to b's two neighbouring stops.
    const around = (loc) => {
      const stops = this.lineNodes[loc.line];
      const after = stops.findIndex((x) => x.s >= loc.s);
      const near = after === -1 ? [stops.at(-1)] : after === 0 ? [stops[0]] : [stops[after - 1], stops[after]];
      return near.map((x) => ({ id: x.id, cost: Math.abs(x.s - loc.s) }));
    };
    const dist = new Map();
    const prev = new Map();
    const open = around(from);
    for (const o of open) dist.set(o.id, o.cost);
    const goals = new Map(around(to).map((x) => [x.id, x.cost]));
    const done = new Set();
    let best = null;
    while (open.length) {
      open.sort((x, y) => dist.get(x.id) - dist.get(y.id));
      const { id } = open.shift();
      if (done.has(id)) continue;
      done.add(id);
      if (goals.has(id)) {
        const total = dist.get(id) + goals.get(id);
        if (!best || total < best.total) best = { id, total };
      }
      for (const { to: next, cost } of this.nodes[id].links) {
        const d = dist.get(id) + cost;
        if (d < (dist.get(next) ?? Infinity)) {
          dist.set(next, d);
          prev.set(next, id);
          open.push({ id: next });
        }
      }
    }
    if (!best) return [pointOn(lineA, from.s), b]; // disconnected roads: just head there
    const ids = [];
    for (let id = best.id; id !== undefined; id = prev.get(id)) ids.unshift(id);
    return [pointOn(lineA, from.s), ...ids.map((id) => ({ x: this.nodes[id].x, y: this.nodes[id].y })), pointOn(this.lines[to.line], to.s)];
  }
}

const JOB_CODES = { farm: 1, logging: 2, mine: 3, convict: 4, cook: 5 }; // (how the client dresses them)

/**
 * One step of someone with a job walking straight to (tx, ty) (sliding along walls, round parked
 * cars). True once they're within `near`. Stuck a while with nobody watching, they're just put there.
 */
export function walkTo(world, person, tx, ty, speed, dt, near = 8) {
  const d = Math.hypot(tx - person.x, ty - person.y);
  if (d <= near) {
    person.stuckFor = 0;
    return true;
  }
  const heading = Math.atan2(ty - person.y, tx - person.x);
  const way = world.steerAroundCars?.(person.x, person.y, heading) ?? heading;
  const step = Math.min(d, speed * dt);
  const [ox, oy] = [person.x, person.y];
  person.x += Math.cos(way) * step;
  person.y += Math.sin(way) * step;
  person.angle = way;
  for (const w of world.wallsNear(person.x, person.y, 17)) {
    const cx = Math.min(Math.max(person.x, w.x), w.x + w.w), cy = Math.min(Math.max(person.y, w.y), w.y + w.h);
    const dx = person.x - cx, dy = person.y - cy, dd = Math.hypot(dx, dy);
    if (dd > 0 && dd < 17) { person.x += (dx / dd) * (17 - dd); person.y += (dy / dd) * (17 - dd); }
  }
  const moved = Math.hypot(person.x - ox, person.y - oy);
  person.stuckFor = moved < step * 0.3 ? (person.stuckFor ?? 0) + dt : 0;
  if (person.stuckFor > 6 && ![...world.players.values()].some((p) => Math.hypot(p.x - person.x, p.y - person.y) < 1200 || Math.hypot(p.x - tx, p.y - ty) < 1200)) {
    person.x = tx;
    person.y = ty;
    person.stuckFor = 0;
    return true;
  }
  return false;
}

// Where townsfolk like to go, and how often (weights).
const VISITS = { home: 40, shop: 18, gas: 8, market: 12, work: 22 };
const HOMES = new Set(['house', 'cabin', 'mansion', 'barn', 'panelka']);

export class Townsfolk {
  constructor(world) {
    this.world = world;
    this.graph = new RoadGraph(world.roads);
    this.people = [];
    this.arrivals = []; // seconds until a replacement for each townsperson who died
    this.kills = []; // players beaten to death by townsfolk fighting back (the World removes them)
    this.time = 0;
    // Places to visit: buildings with a dirt path that reaches a road. The path (door → road) is the
    // last stretch of every trip there.
    this.spots = [];
    for (const path of world.paths) {
      const b = world.buildings.find((x) => path.from[0] >= x.x && path.from[0] <= x.x + x.w && path.from[1] >= x.y && path.from[1] <= x.y + x.h);
      if (!b || WAREHOUSE_SIZES[b.type] || !world.roads.some((r) => this.#onRoad(r, path.to))) continue; // warehouses are locked
      const kind = b.type === 'shop' || b.type === 'kiosk' ? 'shop' : b.type === 'gas' ? 'gas' : b.type === 'market' ? 'market' : HOMES.has(b.type) ? 'home' : 'work';
      const walk = Array.from({ length: 9 }, (_, i) => bezierPoint(path, i / 8)).map(([x, y]) => ({ x, y })); // door → road
      this.spots.push({ building: b.id, kind, walk });
    }
    this.nextId = 1;
    const count = this.spots.length ? Math.min(config.townsfolk.maxPopulation, Math.round(config.townsfolk.perBuilding * world.buildings.length)) : 0;
    for (let i = 0; i < count; i++) this.#spawn();
  }

  #onRoad(r, [x, y]) {
    return x >= r.x - 15 && x <= r.x + r.w + 15 && y >= r.y - 15 && y <= r.y + r.h + 15;
  }

  #pick() {
    const total = Object.values(VISITS).reduce((a, b) => a + b, 0);
    for (let tries = 0; tries < 10; tries++) {
      let roll = Math.random() * total;
      const kind = Object.keys(VISITS).find((k) => (roll -= VISITS[k]) < 0);
      const options = this.spots.filter((s) => s.kind === kind);
      if (options.length) return options[Math.floor(Math.random() * options.length)];
    }
    return this.spots[Math.floor(Math.random() * this.spots.length)];
  }

  /** Someone new in town; a newcomer (replacing someone who died) moves into one of the houses and steps out from there. */
  #spawn(newcomer = false) {
    const homes = newcomer ? this.spots.filter((s) => s.kind === 'home') : [];
    const at = homes.length ? homes[Math.floor(Math.random() * homes.length)] : this.#pick();
    this.people.push({
      id: this.nextId++,
      at, // where they are (inside) or last were
      x: at.walk[0].x,
      y: at.walk[0].y,
      angle: 0,
      inside: newcomer ? 2 + Math.random() * 10 : Math.random() * config.townsfolk.maxStaySec, // seconds left indoors
      route: [],
      side: Math.random() < 0.5 ? -1 : 1, // which pavement they keep to
      speed: config.townsfolk.walkSpeed * (0.8 + Math.random() * 0.4),
      wallet: 200 + Math.random() * 400,
      mood: 0.7, // 0 (angry) – 1 (happy), nudged by what things cost
      health: config.townsfolk.health,
    });
  }

  /** Someone with a job, out and about at (x, y) from the start. */
  add(x, y, job, extra = {}) {
    const person = {
      id: this.nextId++, at: null, x, y, angle: 0, inside: 0, route: [], side: 1,
      speed: config.townsfolk.walkSpeed, wallet: 50 + Math.random() * 100, mood: 0.7, health: config.townsfolk.health,
      job, ...extra,
    };
    this.people.push(person);
    return person;
  }

  /** Door → own path → roads → their path → door. */
  #plan(person, dest) {
    const out = person.at.walk; // door → road
    const back = [...dest.walk].reverse(); // road → door
    const roads = this.graph.route(out.at(-1), back[0]).map((p, i, list) => this.#pavement(p, list[i - 1] ?? p, list[i + 1] ?? p, person.side));
    person.route = [...out, ...roads, ...back];
    person.dest = dest;
  }

  /**
   * Barely moved for a couple of seconds while out walking (a car or a crowd in the way, or lost after
   * running off)? First they step aside in another direction, then they head somewhere else from where
   * they stand, and as a last resort they slip into the building they were making for.
   */
  #stuckCheck(person, dt) {
    const c = (person.stuck ??= { x: person.x, y: person.y, left: person.route.length, t: 0, tries: 0 });
    if ((c.t += dt) < STUCK_SEC) return;
    const moved = Math.hypot(person.x - c.x, person.y - c.y);
    const passed = person.route.length < c.left; // got past a waypoint (some routes double back on themselves)
    Object.assign(c, { x: person.x, y: person.y, t: 0 });
    if (moved >= STUCK_MOVE || passed || !person.route.length) {
      c.left = person.route.length;
      // Well clear of where they got stuck: it worked. (Reaching their own sidestep doesn't count.)
      if (c.where && Math.hypot(person.x - c.where.x, person.y - c.where.y) > STUCK_CLEAR) Object.assign(c, { tries: 0, where: null });
      return;
    }
    c.where ??= { x: person.x, y: person.y };
    c.tries++;
    if (c.tries <= 2) this.#sidestep(person, c.tries);
    else if (c.tries <= 4) this.#replan(person, this.#pick());
    c.left = person.route.length;
    if (c.tries <= 4) return;
    // Nothing works: they go indoors at their destination and set off again later.
    const at = person.dest ?? person.at;
    Object.assign(person, { at, dest: null, route: [], x: at.walk[0].x, y: at.walk[0].y, inside: config.townsfolk.minStaySec });
    Object.assign(c, { tries: 0, where: null });
  }

  /** A few steps off to one side (or back the way they came), somewhere clear, before carrying on. */
  #sidestep(person, tries) {
    const next = person.route[0];
    const ahead = Math.atan2(next.y - person.y, next.x - person.x);
    const side = (tries % 2 ? 1 : -1) * (Math.random() < 0.5 ? 1 : -1);
    for (const turn of [Math.PI / 2, (2 * Math.PI) / 3, Math.PI, Math.PI / 3]) {
      for (const s of [side, -side]) {
        const a = ahead + s * turn;
        const x = person.x + Math.cos(a) * 90, y = person.y + Math.sin(a) * 90;
        if (this.world.isBlocked?.(x, y, 20) || this.world.steerAroundCars?.(x, y, a) !== a) continue;
        person.route.unshift({ x, y });
        return;
      }
    }
  }

  /** Off to `dest` from wherever they are now (not from the door they left by). */
  #replan(person, dest) {
    const back = [...dest.walk].reverse(); // road → door
    const roads = this.graph.route({ x: person.x, y: person.y }, back[0]).map((p, i, list) => this.#pavement(p, list[i - 1] ?? p, list[i + 1] ?? p, person.side));
    person.route = [...roads, ...back];
    person.dest = dest;
  }

  /** Shift a road point sideways onto the pavement on this person's side. */
  #pavement(p, before, after, side) {
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return p;
    const loc = this.graph.locate(p);
    const half = this.graph.lines[loc.line]?.half ?? 60;
    const off = inBox(this.world.city, p.x, p.y) ? half + SIDEWALK / 2 : half - 18; // the sidewalk in town, the verge outside
    return { x: p.x - (dy / len) * off * side, y: p.y + (dx / len) * off * side };
  }

  /** The townsperson out walking whom bullet path a→b (radius r) hits, or null. */
  hitBy(ax, ay, bx, by, r, segmentDistSq) {
    for (const person of this.people) {
      if (person.inside > 0) continue;
      if (segmentDistSq(ax, ay, bx, by, person.x, person.y) < (17 + r) ** 2) return person;
    }
    return null;
  }

  /** Returns true if it killed them. They're replaced by a newcomer a while later. */
  damage(person, amount) {
    person.health -= amount;
    if (person.health > 0) return false;
    this.people.splice(this.people.indexOf(person), 1);
    if (person.job) person.job.owner.jobLost?.(person);
    else this.arrivals.push(config.townsfolk.replaceSec);
    return true;
  }

  /**
   * Stabbed, shot or robbed by `player` (the `crime`): if they're still standing, they come at them
   * swinging a purse. Already running away, they just keep running (and remember the worse crime).
   */
  provoke(person, player, crime = 'assault') {
    if (!player?.alive || person.inside > 0 || !this.people.includes(person)) return;
    if (person.job?.fists) { // a convict: he squares up to whoever hit him (and settles it himself)
      if (!person.fight) person.fight = { target: player, crime, until: this.time + person.job.fists.fightSec, cooldown: 0.4, hits: 0 };
      return;
    }
    if (player.kind === 'hire' && !person.flee) { // nobody takes a purse to an armed thug: they run and phone it in
      person.fight = null;
      person.flee = { from: player, crime, until: this.time + config.townsfolk.fleeSec };
      return;
    }
    if (person.flee) {
      const stars = config.crime.stars;
      if ((stars[crime] ?? 1) > (stars[person.flee.crime] ?? 1)) person.flee.crime = crime;
      return;
    }
    person.fight = { target: player, crime, until: this.time + config.townsfolk.fightSec, cooldown: 0.4, hits: 0 };
  }

  /** The fight's over: run from them, and phone the Militsiya once clear (unless they're dead). */
  #runFrom(person, f) {
    person.fight = null;
    if (person.job?.fists) return; // a convict just goes back to work
    if (f.target.alive) person.flee = { from: f.target, crime: f.crime, until: this.time + config.townsfolk.fleeSec };
  }

  /** One step of running away; at the end they call it in and go back to their day. */
  #flee(person, dt) {
    const f = person.flee;
    if (this.time >= f.until) {
      person.flee = null;
      if (!person.job?.quiet) this.world.police?.crime(f.from, f.crime, true); // (nobody in the camp talks to the Militsiya)
      return;
    }
    const t = f.from;
    person.angle = Math.atan2(person.y - t.y, person.x - t.x);
    const step = config.townsfolk.fightSpeed * dt;
    person.x += Math.cos(person.angle) * step;
    person.y += Math.sin(person.angle) * step;
    this.#unwall(person);
  }

  /** Push them out of any wall they've run into (round walls, not through them). */
  #unwall(person) {
    for (const w of this.world.wallsNear(person.x, person.y, 17)) {
      const cx = Math.min(Math.max(person.x, w.x), w.x + w.w), cy = Math.min(Math.max(person.y, w.y), w.y + w.h);
      const dx = person.x - cx, dy = person.y - cy, dd = Math.hypot(dx, dy);
      if (dd > 0 && dd < 17) { person.x += (dx / dd) * (17 - dd); person.y += (dy / dd) * (17 - dd); }
    }
  }

  /** One step of a fight: run at them, swing when close; after a couple of hits (or giving up) they run. */
  #fight(person, dt) {
    const f = person.fight;
    const t = f.target;
    const rule = { ...config.townsfolk, ...(person.job?.fists ?? {}) }; // (a convict: fists, harder and for longer)
    const d = Math.hypot(t.x - person.x, t.y - person.y);
    if (!t.alive || t.vehicle || t.hidden || (t.jailed && !person.job?.fists) || this.time > f.until || d > rule.fightGiveUpRange) { // (a convict settles it inside the wire too)
      this.#runFrom(person, f);
      return;
    }
    person.angle = Math.atan2(t.y - person.y, t.x - person.x);
    const reach = rule.purseReach + t.radius + 17;
    if (d > reach - 6) {
      const step = Math.min(d - (reach - 8), rule.fightSpeed * dt);
      person.x += Math.cos(person.angle) * step;
      person.y += Math.sin(person.angle) * step;
      this.#unwall(person);
    }
    f.cooldown -= dt;
    if (d <= reach && f.cooldown <= 0) {
      f.cooldown = rule.fightCooldownSec;
      t.hurt(t.maxHealth * rule.purseShare);
      this.world.hires?.noteAttack(person, t); // (your goons go for whoever hits you)
      if (t.health <= 0) {
        this.kills.push(t);
        person.fight = null;
      } else if (++f.hits >= rule.purseHits) this.#runFrom(person, f);
    }
  }

  step(dt) {
    this.time += dt;
    for (let i = this.arrivals.length - 1; i >= 0; i--) {
      this.arrivals[i] -= dt;
      if (this.arrivals[i] <= 0) {
        this.arrivals.splice(i, 1);
        if (this.spots.length) this.#spawn(true);
      }
    }
    for (const person of this.people) {
      if (person.inside > 0) {
        person.inside -= dt;
        if (person.inside <= 0) {
          this.#plan(person, this.#pick());
          person.stuck = null; // a fresh start for the stuck check
        }
        continue;
      }
      if (person.fight) {
        this.#fight(person, dt);
        continue;
      }
      if (person.flee) {
        this.#flee(person, dt);
        continue;
      }
      if (person.job) {
        person.job.owner.stepJob(person, dt);
        continue;
      }
      this.#stuckCheck(person, dt);
      let move = person.speed * dt;
      while (move > 0 && person.route.length) {
        const next = person.route[0];
        const d = Math.hypot(next.x - person.x, next.y - person.y);
        const heading = Math.atan2(next.y - person.y, next.x - person.x);
        const around = this.world.steerAroundCars?.(person.x, person.y, heading) ?? heading; // parked cars in the way
        if (around !== heading && d < 50 && person.route.length > 1) {
          person.route.shift(); // the waypoint's under the car: skip on to the next one
          continue;
        }
        if (d <= move && around === heading) {
          person.x = next.x;
          person.y = next.y;
          person.route.shift();
          move -= d;
        } else {
          person.angle = around;
          move = Math.min(move, d);
          person.x += Math.cos(person.angle) * move;
          person.y += Math.sin(person.angle) * move;
          move = 0;
        }
      }
      if (!person.route.length && person.dest) {
        person.at = person.dest;
        person.dest = null;
        this.visit(person, person.at);
        person.inside = config.townsfolk.minStaySec + Math.random() * (config.townsfolk.maxStaySec - config.townsfolk.minStaySec);
      }
    }
  }

  /** What they buy where they've arrived. Paying over the odds sours their mood, bargains lift it. */
  visit(person, spot) {
    const eco = this.world.economy;
    const market = eco.markets.get(spot.building);
    person.wallet += config.townsfolk.wagePerVisit; // townsfolk earn as they go about their day
    if (!market) return;
    const buy = (good, qty) => {
      const entry = market.goods[good];
      if (!entry || entry.stock < qty) {
        person.mood = Math.max(0, person.mood - 0.05); // couldn't get it
        return;
      }
      const ratio = eco.scarcity(market, good);
      const cost = config.goods[good].base * ratio * qty;
      if (cost > person.wallet) return;
      person.wallet -= cost;
      entry.stock -= qty;
      person.mood = Math.min(1, Math.max(0, person.mood + (1 - ratio) * 0.1));
    };
    if (spot.kind === 'shop') buy('bread', 1 + Math.floor(Math.random() * 2));
    if (spot.kind === 'gas') buy(Math.random() < 0.7 ? 'fuel' : 'bread', 1);
    if (spot.kind === 'market') {
      const basket = config.townsfolk.marketBasket;
      buy(basket[Math.floor(Math.random() * basket.length)], 1);
    }
  }

  /**
   * Townsfolk out and about within `range` of (x, y): [id, x, y, angle, 1 fighting (purse swinging) · 2 running away · 0,
   * job (0 none · 1 farm hand · 2 lumberjack · 3 miner · 4 convict · 5 cook), 1 working (swinging his tool) · 2 carrying a load · 0].
   */
  visible(x, y, range) {
    const out = [];
    for (const p of this.people) {
      if (p.inside > 0 || Math.abs(p.x - x) > range || Math.abs(p.y - y) > range) continue;
      const row = [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.angle * 100) / 100, p.fight ? (p.fight.crime === 'pickpocket' ? 3 : 1) : p.flee ? 2 : 0]; // 1 fighting, 2 fleeing, 3 fighting a pickpocket
      if (p.job) row.push(JOB_CODES[p.job.look ?? p.job.kind] ?? 0, p.job.swinging > 0 ? 1 : p.job.carry > 0 ? 2 : 0);
      out.push(row);
    }
    return out;
  }

  /** Average mood, 0–1 (for elections later). */
  mood() {
    const folk = this.people.filter((p) => !p.job);
    return folk.length ? folk.reduce((sum, p) => sum + p.mood, 0) / folk.length : 0.7;
  }
}
