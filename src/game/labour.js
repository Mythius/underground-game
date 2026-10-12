import { config } from '../config.js';
import { trunkOf } from './cargo.js';
import { Vehicle, vehicleMotion } from './vehicles.js';
import { walkTo } from './townsfolk.js';

// The town's own supply chain: NPC hands at the work sites, the city mills working what's brought to
// them, and the KAMAZ trucks carrying it all along:
//
//   farm (wheat) → flour mill → bakery → shops, kiosks, gas stations, markets (bread)
//   lumberyard (logs) → sawmill → markets (planks);  mine (ore) → foundry → markets (steel)
//
// Hands are townsfolk with a job (see Townsfolk): they work the site's wheat / trees / rocks (the
// same ones players do, slowly) and carry the haul to the foreman, whose stock the trucks collect.
// The city mills keep a stock of what's delivered and work it themselves (`lines` batches at a time).
// The goods that only arrive by truck (bread, planks, steel at the shops and markets) no longer refill
// by themselves — so how much bread there is comes down to how many farms there are, how busy their
// hands are, and whether the trucks get through.
//
// A truck is hijackable: get in and its driver jumps out and runs off to phone the Militsiya (a stolen
// car); the cargo in the back is yours. A new truck takes over the route a while later.
//
//   leg:   { from: stop, to: [stop], good, truck, state, timer, respawnAt }
//   stop:  { building, market | factory, x, y (at the road) }

const MILL_TYPES = ['flourmill', 'bakery', 'sawmill', 'foundry'];

export class Labour {
  constructor(world) {
    this.world = world;
    this.time = 0;
    this.hires = []; // seconds until each lost hand is replaced: { site, left }
    this.legs = [];
    this.millTimer = 0;
    const L = config.labour;
    const eco = world.economy;
    // The hands.
    this.sites = world.buildings.filter((b) => L.sites.includes(b.type) && b.npc && b.work?.w);
    for (const b of this.sites) for (let i = 0; i < L.workers; i++) this.#hire(b);
    // The mills keep a stock of their own.
    for (const f of eco.factories.values()) if (MILL_TYPES.includes(f.type)) Object.assign(f, { stock: {}, timer: 0 });
    // The routes: each raw site to its mill, each mill to wherever its output goes.
    const mills = (type) => [...eco.factories.values()].filter((f) => f.type === type);
    const nearest = (list, at) => list.reduce((best, f) => (!best || Math.hypot(f.x - at.x, f.y - at.y) < Math.hypot(best.x - at.x, best.y - at.y) ? f : best), null);
    for (const b of this.sites) {
      const market = eco.markets.get(b.id);
      const mill = nearest(mills(L.chain[b.type]), market);
      const good = Object.keys(market?.goods ?? {})[0];
      if (!market || !good) continue;
      if (mill) this.#leg(this.#stop(b.id, { market }), [this.#stop(mill.id, { factory: mill })], good);
      else { // no mill on this map: straight to the markets
        const to = [...eco.markets.values()].filter((m) => m.kind === 'depot').map((m) => this.#stop(m.id, { market: m }));
        if (to.length) this.#leg(this.#stop(b.id, { market }), to, good);
      }
    }
    this.supplies = new Set(); // goods the shops and markets now only get by truck
    for (const f of eco.factories.values()) {
      if (!MILL_TYPES.includes(f.type)) continue;
      const out = Object.keys(config.factories[f.type].recipes[0].out)[0];
      const kinds = L.deliver[f.type] ?? [];
      const to = [];
      for (const t of kinds) {
        if (config.factories[t]) for (const g of mills(t)) to.push(this.#stop(g.id, { factory: g }));
        for (const m of eco.markets.values()) if (m.type === t && m.goods[out]) to.push(this.#stop(m.id, { market: m }));
      }
      if (!to.length) continue;
      this.#leg(this.#stop(f.id, { factory: f }), to, out);
      if (!to.some((s) => s.factory)) this.supplies.add(out);
    }
  }

  // ---- the hands --------------------------------------------------------------------------

  #hire(b) {
    const L = config.labour;
    const at = b.npc;
    const a = Math.random() * Math.PI * 2;
    this.world.townsfolk.add(at.x + Math.cos(a) * 60, at.y + Math.sin(a) * 60, {
      kind: 'worker', look: b.type, owner: this, site: b, tool: config.work.tools[b.type],
      carry: 0, bag: {}, target: null, swingT: L.swingSec * Math.random(), swinging: 0,
    }, { speed: L.speed * (0.85 + Math.random() * 0.3) });
  }

  /** A hand was killed: someone new turns up for the job a while later. */
  jobLost(person) {
    if (person.job.kind === 'worker') this.hires.push({ site: person.job.site, left: config.labour.replaceSec });
  }

  /** One step of a hand's (or a runaway truck driver's) day. */
  stepJob(person, dt) {
    const j = person.job;
    if (j.kind === 'driver') return this.#driverRuns(person, dt);
    const L = config.labour;
    const w = this.world;
    const b = j.site;
    j.swinging = Math.max(0, j.swinging - dt);
    const full = j.carry >= L.carry;
    if (!full && (!j.target || j.target.hp <= 0)) j.target = this.#pickNode(person);
    // Off to the foreman with the haul (or nothing left to work and something to hand in).
    if (full || (!j.target && j.carry > 0)) {
      const n = b.npc;
      if (!walkTo(w, person, n.x, n.y, person.speed, dt, 60)) return;
      const market = w.economy.markets.get(b.id);
      for (const [good, qty] of Object.entries(j.bag)) {
        const entry = market?.goods[good];
        if (entry) entry.stock = Math.min(entry.target * 1.5, entry.stock + qty);
      }
      j.bag = {};
      j.carry = 0;
      return;
    }
    if (!j.target) { // nothing to work (winter on the farm, or all worked out): wait by the foreman
      const n = b.npc;
      walkTo(w, person, n.x + 70, n.y + 40, person.speed, dt, 30);
      return;
    }
    const n = j.target;
    if (!walkTo(w, person, n.x, n.y, person.speed, dt, n.r + 30)) return;
    person.angle = Math.atan2(n.y - person.y, n.x - person.x);
    if ((j.swingT -= dt) > 0) return;
    j.swingT = L.swingSec;
    j.swinging = 0.4;
    const got = w.work.hit(n);
    if (!got) return;
    for (const [good, qty] of Object.entries(got)) {
      j.bag[good] = (j.bag[good] ?? 0) + qty;
      j.carry += qty;
    }
    j.target = null;
  }

  /** The nearest node nobody else is working on. */
  #pickNode(person) {
    const j = person.job;
    const taken = new Set(this.world.townsfolk.people.filter((p) => p !== person && p.job?.target).map((p) => p.job.target));
    let best = null, bestD = Infinity;
    for (const n of this.world.work.workable(j.site.id, j.tool)) {
      if (taken.has(n)) continue;
      const d = Math.hypot(n.x - person.x, n.y - person.y);
      if (d < bestD) [best, bestD] = [n, d];
    }
    return best;
  }

  /** A driver whose truck was taken: runs for it (and phones it in — see Townsfolk), then he's gone. */
  #driverRuns(person, dt) {
    if ((person.job.left -= dt) <= 0) {
      const list = this.world.townsfolk.people;
      list.splice(list.indexOf(person), 1);
      return;
    }
    const a = person.job.away;
    walkTo(this.world, person, person.x + Math.cos(a) * 100, person.y + Math.sin(a) * 100, 200, dt, 1);
  }

  // ---- the routes -------------------------------------------------------------------------

  /** Where a truck pulls up for a building: the end of its path at the road (or the nearest road). */
  #stop(id, what) {
    const spot = this.world.townsfolk.spots.find((s) => s.building === id);
    const b = this.world.buildings[id - 1];
    let at = spot?.walk.at(-1);
    if (!at) {
      const g = this.world.townsfolk.graph;
      const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const loc = g.lines.length ? g.locate(c) : null;
      at = loc ? (g.lines[loc.line].horizontal ? { x: loc.s, y: g.lines[loc.line].at } : { x: g.lines[loc.line].at, y: loc.s }) : c;
    }
    return { building: id, x: at.x, y: at.y, ...what };
  }

  #leg(from, to, good) {
    this.legs.push({ from, to, good, truck: null, state: 'toPickup', timer: 0, waited: 0, dest: null, route: [], respawnAt: 0 });
  }

  /** How much of `good` a stop has to give, and taking it. */
  #available(stop, good) {
    if (stop.factory) return Math.floor(stop.factory.stock[good] ?? 0);
    const entry = stop.market.goods[good];
    return entry ? Math.max(0, Math.floor(entry.stock - 20)) : 0; // (the foreman keeps a little for players to buy)
  }

  #take(stop, good, qty) {
    if (stop.factory) stop.factory.stock[good] -= qty;
    else stop.market.goods[good].stock -= qty;
  }

  #give(stop, good, qty) {
    if (stop.factory) stop.factory.stock[good] = (stop.factory.stock[good] ?? 0) + qty;
    else {
      const entry = stop.market.goods[good];
      if (entry) entry.stock += qty;
    }
  }

  /** Where this load goes: the drop that needs it most (mills before markets), nearer ones winning ties. */
  #pickDrop(leg) {
    const need = (s) => {
      if (s.factory) return 1 - (s.factory.stock[leg.good] ?? 0) / (config.labour.factoryTarget * 2);
      const e = s.market.goods[leg.good];
      return e ? 1 - e.stock / e.target : -1;
    };
    let best = null, bestScore = -Infinity;
    for (const s of leg.to) {
      const score = need(s) - Math.hypot(s.x - leg.from.x, s.y - leg.from.y) / 40000;
      if (score > bestScore) [best, bestScore] = [s, score];
    }
    return best;
  }

  #spawnTruck(leg) {
    const w = this.world;
    const at = leg.from;
    const v = new Vehicle(w.nextEntityId++, 'truck', at.x, at.y, 0);
    Object.assign(v, { color: '#3d5a3f', fuel: 100, labourTruck: leg, lights: true });
    w.vehicles.set(v.id, v);
    Object.assign(leg, { truck: v, state: 'loading', timer: config.labour.loadSec, waited: 0, route: [], stuck: 0, reverse: 0, noProgress: 0 });
  }

  /** E on a cargo truck: its driver jumps out and runs for it; it (and its load) is the hijacker's. */
  hijack(v, p) {
    const leg = v.labourTruck;
    if (!leg) return;
    this.#lose(leg);
    const away = Math.atan2(v.y - p.y, v.x - p.x);
    const person = this.world.townsfolk.add(v.x + Math.cos(away) * 70, v.y + Math.sin(away) * 70, { kind: 'driver', owner: this, left: 12, away }, { speed: 200 });
    person.flee = { from: p, crime: 'steal_car', until: this.world.townsfolk.time + config.townsfolk.fleeSec };
  }

  /** The route's truck is gone (taken, wrecked): another takes over later. */
  #lose(leg) {
    const v = leg.truck;
    if (v) {
      v.ai = null;
      v.labourTruck = null;
    }
    Object.assign(leg, { truck: null, respawnAt: this.time + config.labour.truckReplaceSec });
  }

  // ---- every step ---------------------------------------------------------------------------

  step(dt) {
    this.time += dt;
    const w = this.world;
    for (let i = this.hires.length - 1; i >= 0; i--) {
      if ((this.hires[i].left -= dt) > 0) continue;
      this.#hire(this.hires[i].site);
      this.hires.splice(i, 1);
    }
    this.#mills(dt);
    for (const leg of this.legs) {
      if (!leg.truck) {
        if (this.time >= leg.respawnAt) this.#spawnTruck(leg);
        continue;
      }
      const v = leg.truck;
      if (!w.vehicles.has(v.id) || v.driver) { this.#lose(leg); continue; } // wrecked, or someone's at the wheel
      this.#run(leg, v, dt);
    }
  }

  /** The city mills work their stock, `lines` batches at a time, while they've room for the output. */
  #mills(dt) {
    this.millTimer += dt;
    if (this.millTimer < 1) return;
    const step = this.millTimer;
    this.millTimer = 0;
    for (const f of this.world.economy.factories.values()) {
      if (!f.stock) continue;
      const spec = config.factories[f.type];
      f.timer += step;
      while (f.timer >= spec.sec) {
        f.timer -= spec.sec;
        for (let k = 0; k < config.labour.factoryLines; k++) {
          const recipe = spec.recipes.find((r) => Object.entries(r.in).every(([g, q]) => (f.stock[g] ?? 0) >= q));
          if (!recipe || Object.keys(recipe.out).some((g) => (f.stock[g] ?? 0) >= config.labour.factoryTarget)) break;
          for (const [g, q] of Object.entries(recipe.in)) f.stock[g] -= q;
          for (const [g, q] of Object.entries(recipe.out)) f.stock[g] = (f.stock[g] ?? 0) + q;
        }
      }
    }
  }

  #run(leg, v, dt) {
    const L = config.labour;
    const trunk = trunkOf(v);
    if (leg.state === 'loading' || leg.state === 'unloading') {
      this.#brake(v);
      if ((leg.timer -= dt) > 0) return;
      if (leg.state === 'unloading') {
        const qty = trunk.count(leg.good);
        if (qty > 0) {
          trunk.add(leg.good, -qty);
          this.#give(leg.dest, leg.good, qty);
        }
        return this.#setOff(leg, v, leg.from, 'toPickup');
      }
      const have = this.#available(leg.from, leg.good);
      leg.waited += L.loadSec;
      if (have < L.minLoad && leg.waited < L.waitSec) { leg.timer = L.loadSec; return; } // wait for more
      if (have <= 0) { leg.timer = L.loadSec; leg.waited = 0; return; }
      const qty = Math.min(have, L.truckCapacity, trunk.room(leg.good));
      this.#take(leg.from, leg.good, qty);
      trunk.add(leg.good, qty);
      leg.dest = this.#pickDrop(leg);
      return this.#setOff(leg, v, leg.dest, 'toDrop');
    }
    const stop = leg.state === 'toDrop' ? leg.dest : leg.from;
    if (this.#drive(leg, v, stop, dt)) {
      leg.state = leg.state === 'toDrop' ? 'unloading' : 'loading';
      leg.timer = L.loadSec;
      leg.waited = 0;
    }
  }

  #setOff(leg, v, stop, state) {
    const g = this.world.townsfolk.graph;
    Object.assign(leg, { state, route: g.lines.length ? g.route({ x: v.x, y: v.y }, stop) : [], stuck: 0, reverse: 0, noProgress: 0, best: Infinity });
    leg.route.push({ x: stop.x, y: stop.y });
  }

  #brake(v) {
    const forward = vehicleMotion(v).forward;
    v.ai = v.speed < 5 ? null : { gas: Math.abs(forward) > 20 ? -Math.sign(forward) : 0, steer: 0, drift: false };
  }

  /** One step along the roads toward `stop`; true once pulled up there. */
  #drive(leg, v, stop, dt) {
    const d = Math.hypot(stop.x - v.x, stop.y - v.y);
    if (d < 130 && v.speed < 60) return true;
    // Not getting any closer for a long while (stuck on something), with nobody about: it's just there.
    if (d < (leg.best ?? Infinity) - 50) { leg.best = d; leg.noProgress = 0; leg.unjamAt = 0; } else leg.noProgress += dt;
    if (leg.noProgress > 45 && ![...this.world.players.values()].some((p) => Math.hypot(p.x - v.x, p.y - v.y) < 1500 || Math.hypot(p.x - stop.x, p.y - stop.y) < 1500)) {
      Object.assign(v, { x: stop.x, y: stop.y, vx: 0, vy: 0 });
      return true;
    }
    while (leg.route.length > 1 && Math.hypot(leg.route[0].x - v.x, leg.route[0].y - v.y) < 110) leg.route.shift();
    const next = leg.route[0] ?? stop;
    const forward = vehicleMotion(v).forward;
    const want = Math.atan2(next.y - v.y, next.x - v.x);
    const diff = Math.atan2(Math.sin(want - v.angle), Math.cos(want - v.angle));
    if (leg.reverse > 0) {
      leg.reverse -= dt;
      v.ai = { gas: -1, steer: -Math.sign(diff) || 1, drift: false };
      return false;
    }
    leg.stuck = Math.abs(forward) < 20 ? leg.stuck + dt : 0;
    if (leg.stuck > 1.5) { leg.stuck = 0; leg.reverse = 1.1; }
    if (leg.noProgress - (leg.unjamAt ?? 0) > 8) { leg.unjamAt = leg.noProgress; leg.reverse = 1.6; } // shoving something for ages: back off and try again
    const slow = d < 300 || (Math.abs(diff) > 0.6 && forward > 110); // turning, or pulling in
    v.ai = { gas: slow ? (forward > 90 ? -0.5 : 0.45) : 0.65, steer: Math.max(-1, Math.min(1, diff * 2.2)), drift: false };
    return false;
  }

  /** For the city mills' panels: what they have on hand. */
  stockOf(id) {
    return this.world.economy.factories.get(id)?.stock ?? null;
  }
}
