import { config } from '../config.js';
import { segmentRectHit } from '../utils/math.js';
import { Bullet } from './entities.js';
import { hotbarOf, trunkOf } from './cargo.js';
import { Vehicle, vehicleMotion } from './vehicles.js';
import { nextWaypoint } from './pathfind.js';

// Crime and the police.
//
// Crimes give the player a wanted level (stars) if the police see them or a townsperson nearby calls it
// in; alarms always report. Police cruisers patrol the roads; when someone is wanted, up to one car per
// star chases them. Close to a suspect on foot, the officer gets out, runs them down and arrests them
// (standing next to an officer for a moment). At 3+ stars, or once they've shot at police, officers shoot.
// Busted: illegal goods are taken and bail is paid (cash, then bank) — or, if you can't afford it, you sit
// in the station's cell for a while. Out of police sight for a while, stars fall away one by one.

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Has p joined the Militsiya? (Officers wear the uniform and can't make or sell anything illegal.) */
export const isCop = (p) => Boolean(p?.account?.cop);

export class Police {
  constructor(world) {
    this.world = world;
    this.stations = world.buildings.filter((b) => b.type === 'police');
    this.units = [];
    this.waiting = []; // { station, in }: replacements still waiting for a parking space at the station
    this.events = []; // { player, kind: 'busted' | 'released' | 'crime', … } for the room to tell players
    this.robCooldown = new Map(); // target key -> economy time it can be robbed again
    this.nextOfficerId = 1;
    if (!this.stations.length) return;
    const cars = Math.min(config.police.maxUnits, Math.max(1, Math.round(world.buildings.length * config.police.carsPerBuildings)));
    for (let i = 0; i < cars; i++) this.#replace(this.stations[i % this.stations.length]);
    for (const b of world.buildings.filter((x) => x.type === 'bank')) this.#bankGuard(b);
  }

  /**
   * An officer on foot posted just inside a bank's front door. He goes for anyone robbing the bank,
   * and deals with trouble he sees in and around it like any cop — but never chases far — and walks
   * back to his post after. Replaced there if he's killed.
   */
  #bankGuard(b) {
    const door = b.doors.filter((d) => d.exterior).sort((a, c) => Math.max(c.w, c.h) - Math.max(a.w, a.h))[0];
    if (!door) return;
    const cx = door.x + door.w / 2, cy = door.y + door.h / 2;
    for (let d = 50; d <= 200; d += 5) { // a clear spot a few steps in from the door, on the public side (in plain view of it)
      const x = cx - door.nx * d, y = cy - door.ny * d;
      if (this.world.isBlocked(x, y, 22) || !this.world.lineOfSight(cx - door.nx * 20, cy - door.ny * 20, x, y)) continue;
      this.#newUnit(this.#nearestStation(cx, cy), { guard: b.id, x, y, angle: Math.atan2(door.ny, door.nx), range: config.police.guardRange, door: { x: cx, y: cy, nx: door.nx, ny: door.ny } });
      return;
    }
  }

  /**
   * Guards walking a loop inside the prison's wire. They deal with trouble in and round the camp like
   * a bank guard; a prisoner can lift the key off one's belt from behind (see Prison.liftKey).
   */
  postPrisonGuards(b) {
    const s = b.prison;
    const c = { x: s.inner.x + s.inner.w / 2, y: s.inner.y + s.inner.h / 2 };
    for (let i = 0; i < config.prison.guards; i++) {
      const leg = Math.floor((i * s.patrol.length) / config.prison.guards);
      const at = s.patrol[leg];
      const u = this.#newUnit(this.#nearestStation(c.x, c.y), { guard: b.id, prison: true, x: c.x, y: c.y, angle: 0, range: Math.max(s.inner.w, s.inner.h), patrol: s.patrol });
      Object.assign(u.officer, { x: at.x, y: at.y });
      u.leg = (leg + 1) % s.patrol.length;
    }
  }

  /** The prison guards on their feet. */
  prisonGuards() {
    return this.units.filter((u) => u.post?.prison && u.officer.health > 0).map((u) => u.officer);
  }

  /** The (living) guard posted in bank building `id`, if any. */
  bankGuardOf(id) {
    return this.units.find((u) => u.post?.guard === id && !u.post.prison && u.officer.health > 0) ?? null;
  }

  /** The old cruiser of a replaced unit goes back to the depot, unless someone's in it (stolen ones stay out there). */
  #towAway(car) {
    if (car && this.world.vehicles.has(car.id) && !car.driver && !car.passenger) this.world.vehicles.delete(car.id);
  }

  /** A new unit at `station` (or at its `post`); with no space to park its car, it tries again a little later (the force never shrinks). */
  #replace(station, post = null) {
    if (!this.#newUnit(station, post)) this.waiting.push({ station, post, in: 10 });
  }

  /**
   * A unit stationed at a checkpoint: its cruiser parked by the road there, officer inside. It chases
   * whoever runs the checkpoint, answers crimes nearby like any patrol, and goes back to park after.
   * `post`: { roadblock, x, y, angle }.
   */
  post(post) {
    return this.#newUnit(this.#nearestStation(post.x, post.y), post);
  }

  /** The (living) unit posted at checkpoint `roadblock`, if any. */
  checkpointUnit(roadblock) {
    return this.units.find((u) => u.post?.roadblock === roadblock && u.officer.health > 0) ?? null;
  }

  get time() {
    return this.world.economy.time;
  }

  #newUnit(station, post = null) {
    if (post?.guard) { // a bank guard: on foot, no car
      const unit = { station, car: null, officer: { id: this.nextOfficerId++, kind: 'officer', name: 'Police', vehicle: null, x: post.x, y: post.y, angle: post.angle, health: config.police.officerHealth, onFoot: true, fireCooldown: 0 }, target: null, route: [], stuck: 0, reverse: 0, arrest: 0, respawn: 0, post };
      this.units.push(unit);
      return unit;
    }
    let car;
    if (post) { // parked at its checkpoint (a new car turns up there)
      car = new Vehicle(this.world.nextEntityId++, 'police', post.x, post.y, post.angle);
      this.world.vehicles.set(car.id, car);
    } else car = station && this.world.parkNewVehicle('police', station.id, null);
    if (!car) return null;
    car.police = true;
    car.lights = true;
    car.fuel = 100;
    const unit = {
      station,
      car,
      officer: { id: this.nextOfficerId++, kind: 'officer', name: 'Police', vehicle: null, x: car.x, y: car.y, angle: car.angle, health: config.police.officerHealth, onFoot: false, fireCooldown: 0 },
      target: null,
      route: [],
      stuck: 0,
      reverse: 0,
      arrest: 0,
      respawn: 0,
      post, // null for patrol cars
    };
    this.units.push(unit);
    return unit;
  }

  // ---- crimes -------------------------------------------------------------------

  /** Can someone at (vx, vy) facing `angle` see (x, y)? A half circle in front of them, within `range`; walls block. */
  sees(vx, vy, angle, x, y, range) {
    const dx = x - vx;
    const dy = y - vy;
    const d = Math.hypot(dx, dy);
    if (d > range) return false;
    if (d > 30 && dx * Math.cos(angle ?? 0) + dy * Math.sin(angle ?? 0) < 0) return false; // behind them
    return this.world.lineOfSight(vx, vy, x, y);
  }

  /** How far away player p can be noticed: never in a dumpster; only up close under a tree or sitting in a parked car. */
  #spotRange(p, range) {
    if (!p) return range;
    if (p.hidden) return 0;
    const close = Math.min(range, config.police.hideSeenRange);
    if (p.vehicle) return !p.vehicle.ai && Math.hypot(p.vehicle.vx, p.vehicle.vy) < 20 ? close : range;
    return this.world.trees.some((t) => Math.hypot(t.x - p.x, t.y - p.y) < t.canopy * 0.75) ? close : range;
  }

  /** Does any officer (in a car or on foot) see (x, y) — or player `target` there? */
  policeSee(x, y, target = null) {
    const r = this.#spotRange(target, config.crime.policeSees);
    return r > 0 && this.units.some((u) => u.officer.health > 0 && this.sees(u.officer.x, u.officer.y, u.officer.angle, x, y, r));
  }

  /** Would anyone report what happens at (x, y)? An officer, or a townsperson out walking who's facing that way (other than `except`). */
  witnessed(x, y, target = null, except = null) {
    if (this.policeSee(x, y, target)) return true;
    const r = this.#spotRange(target, config.crime.witnessSees);
    return r > 0 && this.world.townsfolk.people.some((t) => t !== except && t.inside <= 0 && !t.job?.quiet && this.sees(t.x, t.y, t.angle, x, y, r));
  }

  /**
   * Player (or hire) p did `kind`. With `alarm`, it's reported whatever; otherwise only if someone
   * (other than `except`) saw it. `stars` overrides how bad it counts.
   */
  crime(p, kind, alarm = false, except = null, stars = config.crime.stars[kind] ?? 1) {
    if (!p?.alive || (p.kind !== 'player' && p.kind !== 'hire')) return false;
    if (p.role === 'gangster') return false; // the Militsiya and the gangsters leave each other be
    if (p.kind === 'player' && isCop(p)) {
      if (kind === 'fire' || kind === 'steal_police_car') return false; // officers may shoot, and drive Militsiya cars
      if (kind !== 'near_body') this.#fire(p, kind); // any real crime, seen or not, costs an officer the badge
    }
    if (!alarm && !this.witnessed(p.x, p.y, p, except)) return false;
    const before = p.wanted;
    p.wanted = Math.min(5, Math.max(p.wanted, stars));
    // The search starts from here.
    this.#lastKnown(p);
    p.inSight = this.policeSee(p.x, p.y, p); // (a phoned-in report doesn't mean they're watching)
    if (!before) p.reportedAt = this.time;
    if (p.wanted > before && p.kind === 'player') this.events.push({ player: p, kind: 'crime', crime: kind, stars: p.wanted });
    // An officer who saw it with their own eyes (on foot or from a passing car) goes after them at once,
    // without waiting for the call to come through.
    const range = this.#spotRange(p, config.crime.policeSees);
    for (const u of this.units) {
      const o = u.officer;
      if (u.target || o.health <= 0 || !this.sees(o.x, o.y, o.angle, p.x, p.y, range)) continue;
      u.target = p;
      u.route = [];
    }
    if (p.wanted > before && p.kind === 'hire') this.world.hires.traced(p, kind, stars); // a witness may know who they work for
    return true;
  }

  /** Everyone the Militsiya might be after: players and hired muscle. */
  #suspects() {
    return [...this.world.players.values(), ...(this.world.hires?.list ?? []).filter((h) => h.role !== 'gangster')];
  }

  /** The Militsiya know where p is right now: the trail starts again from here. */
  #lastKnown(p) {
    p.lastSeen = this.time;
    p.lastKnown = { x: p.vehicle?.x ?? p.x, y: p.vehicle?.y ?? p.y, inCar: Boolean(p.vehicle) };
    p.searched = new Set();
    p.searchSpots = null;
    p.hideSpot = null;
    p.inSight = true;
  }

  /**
   * They had eyes on p a moment ago and now they don't: if p ducked into a hiding place right there
   * (a dumpster, under a tree, a parked car, a building), the Militsiya saw where they went.
   */
  #sawHide(p) {
    const spot = this.#spots(p).find((s) => this.#hidingAt(p, s));
    if (spot) p.hideSpot = spot.key;
  }

  // ---- robbery and pickpocketing ------------------------------------------------------

  /** Start robbing the ATM, till (shop/gas) or bank teller you're next to. The alarm goes off at once. */
  startRobbery(p) {
    const w = this.world;
    if (p.jailed?.prison && !p.robbing) { // inside the wire, only the lock on the outer fence's door
      const door = w.lockedDoorNear(p);
      if (!door || !w.prison.isPrisonDoor(door)) return 'nothing_to_rob';
      p.robbing = { kind: 'lockpick', door, prison: true, x: door.x + door.w / 2, y: door.y + door.h / 2, elapsed: 0, sec: config.prison.lockpickSec };
      return null;
    }
    if (p.vehicle || p.robbing || p.jailed) return 'busy';
    const near = (list, reach) => list.find((s) => Math.hypot(s.x - p.x, s.y - p.y) < reach + p.radius);
    const atm = near(w.atms.filter((a) => !w.atmBroken(a)), config.economy.atmReach); // (a smashed one has nothing left)
    const teller = near(w.tellers, config.economy.bankReach);
    const keeper = near(w.shopkeepers.filter((k) => k.building), config.economy.shopReach);
    const [kind, target] = atm ? ['atm', atm] : teller ? ['bank', teller] : keeper ? ['shop', keeper] : [null, null];
    if (!kind) {
      // Someone's locked warehouse or home, or their car: pick the lock. Only a crime if somebody sees it.
      const door = w.lockedDoorNear(p);
      if (door) {
        const prison = w.prison.isPrisonDoor(door); // breaking someone out
        const sec = prison ? config.prison.lockpickSec : w.warehouses.all.has(door.building) ? config.warehouses.lockpickSec : config.homes.lockpickSec;
        p.robbing = { kind: 'lockpick', door, prison, x: door.x + door.w / 2, y: door.y + door.h / 2, elapsed: 0, sec };
        this.crime(p, 'break_in');
        return null;
      }
      const car = w.lockedCarNear(p);
      if (!car) return 'nothing_to_rob';
      p.robbing = { kind: 'carpick', car, x: car.x, y: car.y, elapsed: 0, sec: config.vehicles.lockpickSec };
      this.crime(p, car.police ? 'steal_police_car' : 'steal_car', car.police); // a Militsiya car is always reported
      return null;
    }
    const rule = config.robbery[kind];
    if (rule.needsGun && !p.weapon) return 'need_gun';
    const key = `${kind}:${Math.round(target.x)},${Math.round(target.y)}`;
    if ((this.robCooldown.get(key) ?? 0) > this.time) return 'recently_robbed';
    p.robbing = { kind, key, x: target.x, y: target.y, elapsed: 0, sec: rule.sec };
    // A shop or bank: the clerk is right there and calls it in. An ATM: only if someone sees you.
    this.crime(p, `rob_${kind}`, kind !== 'atm');
    if (kind === 'bank') { // the guard inside comes straight for you
      const bank = w.buildings.find((b) => b.type === 'bank' && target.x > b.x && target.x < b.x + b.w && target.y > b.y && target.y < b.y + b.h);
      const guard = bank && this.bankGuardOf(bank.id);
      if (guard) Object.assign(guard, { target: p, route: [] });
    }
    return null;
  }

  #robberies(dt) {
    for (const p of this.world.players.values()) {
      // Pressing F starts a robbery at whatever's in reach; letting go (or walking off) abandons it.
      const pressed = p.input.rob && !p.robHeld;
      p.robHeld = p.input.rob;
      if (pressed && !p.robbing) {
        const error = this.startRobbery(p);
        if (error && error !== 'nothing_to_rob') this.events.push({ player: p, kind: 'error', code: error });
      }
      const r = p.robbing;
      if (!r) continue;
      if (!p.input.rob || p.vehicle || (p.jailed && !r.prison) || Math.hypot(r.x - p.x, r.y - p.y) > 160) {
        p.robbing = null; // gave up: no money (the alarm already went off)
        this.events.push({ player: p, kind: 'rob_stopped' });
        continue;
      }
      r.elapsed += dt;
      if (r.elapsed < r.sec) continue;
      if (r.kind === 'carpick') {
        if (this.world.vehicles.has(r.car.id)) r.car.picked = true; // open to anyone until the owner's back in it
        this.events.push({ player: p, kind: 'picked_car' });
        p.robbing = null;
        continue;
      }
      if (r.kind === 'lockpick' && r.prison) {
        this.world.prison.picked(r.door);
        this.events.push({ player: p, kind: 'picked' });
        p.robbing = null;
        continue;
      }
      if (r.kind === 'lockpick') {
        if (this.world.warehouses.all.has(r.door.building)) this.world.warehouses.unlock(r.door);
        else this.world.homes.unlock(r.door);
        r.door.open = true;
        this.world.pendingDoors.push(r.door);
        this.events.push({ player: p, kind: 'picked' });
        p.robbing = null;
        continue;
      }
      const rule = config.robbery[r.kind];
      const take = Math.round(rule.min + Math.random() * (rule.max - rule.min));
      p.cash += take;
      this.robCooldown.set(r.key, this.time + rule.cooldownSec);
      if (r.kind === 'atm') (p.robbedAtms ??= new Map()).set(r.key, this.time + rule.noDepositSec); // no paying it straight back in here
      this.events.push({ player: p, kind: 'robbed', amount: take, what: r.kind });
      p.robbing = null;
    }
  }

  /** F: lift some cash from the nearest townsperson or player. */
  pickpocket(p) {
    const rule = config.pickpocket;
    const key = this.world.prison?.liftKey(p); // a prisoner next to a guard: his key
    if (key) return key;
    if (p.vehicle || p.jailed) return 'busy';
    if ((p.pickpocketReady ?? 0) > this.time) return 'too_soon';
    const reach = rule.reach + p.radius;
    const npc = this.world.townsfolk.people.find((t) => t.inside <= 0 && Math.hypot(t.x - p.x, t.y - p.y) < reach);
    let take = 0;
    let unnoticed = false;
    let victim = null;
    if (npc) {
      take = Math.min(Math.floor(npc.wallet), Math.round(rule.npcMin + Math.random() * (rule.npcMax - rule.npcMin)));
      npc.wallet -= take;
      // From behind (you're outside the half circle they face), they never feel a thing.
      unnoticed = !npc.fight && (p.x - npc.x) * Math.cos(npc.angle ?? 0) + (p.y - npc.y) * Math.sin(npc.angle ?? 0) < 0;
      if (!unnoticed) {
        npc.mood = Math.max(0, npc.mood - 0.1);
        this.world.townsfolk.provoke(npc, p, 'pickpocket'); // they noticed — and they've got a purse
      }
    } else {
      victim = [...this.world.players.values()].find((o) => o !== p && o.alive && !o.vehicle && Math.hypot(o.x - p.x, o.y - p.y) < reach + o.radius);
      if (!victim) return 'nobody_to_rob';
      take = Math.floor(victim.cash * rule.playerShare);
      victim.cash -= take;
      this.events.push({ player: victim, kind: 'pickpocketed', amount: take });
    }
    this.world.hires?.noteAttack(p, npc ?? victim); // your goons go for whoever you rob // your goons go for whoever you rob
    p.pickpocketReady = this.time + rule.cooldownSec;
    p.cash += take;
    this.crime(p, 'pickpocket', false, unnoticed ? npc : null); // (someone else may still see it)
    return { amount: take, unnoticed };
  }

  // ---- being shot -------------------------------------------------------------------

  /** An officer hit by bullet path a→b (radius r), or null. */
  officerHit(ax, ay, bx, by, r, segmentDistSq) {
    for (const u of this.units) {
      const o = u.officer;
      if (o.health <= 0 || !o.onFoot) continue;
      if (segmentDistSq(ax, ay, bx, by, o.x, o.y) < (20 + r) ** 2) return o;
    }
    return null;
  }

  damageOfficer(officer, damage, attacker) {
    const alive = officer.health > 0;
    officer.health -= damage * (1 - config.police.officerArmor); // body armour
    // A fallen officer leaves a body (with their service rifle on it).
    if (alive && officer.health <= 0) {
      this.world.bodies?.add({ x: officer.x, y: officer.y, angle: officer.angle ?? 0, kind: 'officer', look: [0, 0, 0, 0], items: [{ type: 'rifle', ammo: config.weapons.rifle.magazineSize, reloadTimer: 0 }], killer: attacker?.kind === 'player' ? attacker : null });
    }
    // The officer reports it only if they survived and can see who did it; otherwise only if someone else saw.
    const seenByVictim = officer.health > 0 && attacker && this.sees(officer.x, officer.y, officer.angle, attacker.x, attacker.y, config.crime.policeSees);
    if (attacker?.kind === 'player' || attacker?.kind === 'hire') this.crime(attacker, 'attack_police', seenByVictim);
    if (attacker) attacker.shotPolice = true;
    this.world.hires?.noteAttack(attacker, officer); // (your goons join in)
  }

  // ---- joining the Militsiya ---------------------------------------------------------------

  /** The station whose desk officer p is standing at, or null. */
  deskOf(p) {
    if (!p?.alive || p.vehicle) return null;
    const reach = config.police.academy.reach + p.radius;
    return this.stations.find((s) => s.npc && Math.hypot(s.npc.x - p.x, s.npc.y - p.y) < reach) ?? null;
  }

  /** What the desk panel shows p: their status, or the application's questions (without the answers). */
  describeDesk(p, station) {
    const a = config.police.academy;
    return {
      kind: 'police',
      id: station.id,
      cop: isCop(p),
      retryIn: Math.max(0, Math.ceil((p.account?.copRetryAt ?? 0) - this.time)),
      questions: a.questions.map(({ q, options }) => ({ q, options })),
    };
  }

  /** Apply to join, with an answer (option index) for each question. Returns an error code, or null. */
  apply(p, answers) {
    const a = config.police.academy;
    if (!this.deskOf(p)) return 'too_far';
    if (!p.account || p.account.guest) return 'need_account';
    if (isCop(p)) return 'already_cop';
    if ((p.account.copRetryAt ?? 0) > this.time) return 'cop_retry';
    if (p.wanted || p.jailed) return 'cop_wanted';
    // Nobody joins with contraband on them.
    if (Object.keys(hotbarOf(p).items).some((g) => config.goods[g]?.illegal) || p.inventory.some((s) => s?.illegal)) return 'cop_contraband';
    if (!Array.isArray(answers) || answers.length !== a.questions.length || a.questions.some((q, i) => answers[i] !== q.answer)) {
      p.account.copRetryAt = this.time + a.retrySec;
      return 'cop_failed';
    }
    p.account.cop = true;
    this.world.onCopChange?.(p.account);
    return null;
  }

  /** Use of force that isn't a crime: an officer hurting a wanted player. */
  lawful(attacker, victim) {
    return isCop(attacker) && victim?.kind === 'player' && victim.wanted > 0;
  }

  /** An officer who broke the law is thrown out of the Militsiya. */
  #fire(p, crime) {
    p.account.cop = false;
    this.world.onCopChange?.(p.account);
    this.events.push({ player: p, kind: 'cop_fired', crime });
  }

  /** Hand in the badge. */
  resign(p) {
    if (!this.deskOf(p)) return 'too_far';
    if (!isCop(p)) return 'not_cop';
    p.account.cop = false;
    this.world.onCopChange?.(p.account);
    return null;
  }

  /** The player a player officer wants to arrest or fine, if it's allowed right now; else an error code. */
  #collar(cop, id) {
    const a = config.police.academy;
    if (!isCop(cop)) return 'not_cop';
    if (!cop.alive || cop.vehicle || cop.jailed) return 'busy';
    const t = this.world.players.get(id);
    if (!t?.alive || t === cop || t.vehicle || t.jailed || t.hidden) return 'nobody_to_collar';
    if (!t.wanted) return 'not_wanted_player'; // only someone wanted for a crime
    if (Math.hypot(t.x - cop.x, t.y - cop.y) > a.collarReach + cop.radius + t.radius) return 'too_far';
    if ((cop.collaredAt ?? -Infinity) + a.cooldownSec > this.time) return 'too_soon';
    cop.collaredAt = this.time;
    return t;
  }

  /** A player officer arrests player `id`: contraband seized, and off to the cells (no bail). */
  copArrest(cop, id) {
    const t = this.#collar(cop, id);
    if (typeof t === 'string') return t;
    const seized = this.#seize(t);
    if (this.world.prison?.jail(t, t.wanted)) {
      t.arrest = 0;
      this.events.push({ player: t, kind: 'cop_arrested', by: cop.name, prison: true, quota: t.jailed.quota, bail: t.jailed.bail, seized });
      return { name: t.name, prison: true, seized };
    }
    t.wanted = 0;
    t.robbing = null;
    t.arrest = 0;
    const station = this.#nearestStation(t.x, t.y);
    const jail = config.police.academy.jailSec;
    t.jailed = { until: this.time + jail, station };
    if (station?.jail) {
      t.x = station.jail.x;
      t.y = station.jail.y;
    }
    this.events.push({ player: t, kind: 'cop_arrested', by: cop.name, jail, seized });
    return { name: t.name, jail, seized };
  }

  /** A player officer fines player `id`: cash first, then the bank, all of it to the officer. */
  copFine(cop, id) {
    const t = this.#collar(cop, id);
    if (typeof t === 'string') return t;
    const fine = config.police.academy.fine;
    const fromCash = Math.min(t.cash, fine);
    const fromBank = Math.min(Math.floor(t.account?.bank ?? 0), fine - fromCash);
    t.cash -= fromCash;
    if (fromBank) {
      t.account.bank -= fromBank;
      this.world.onBankChange?.(t.account);
    }
    cop.cash += fromCash + fromBank;
    t.wanted = 0; // paid up: the matter is closed
    t.lastKnown = null;
    this.events.push({ player: t, kind: 'cop_fined', by: cop.name, amount: fromCash + fromBank });
    return { name: t.name, amount: fromCash + fromBank };
  }

  /** Takes every illegal good off p (hands and the car with them). Returns how many. */
  #seize(p) {
    const holders = [hotbarOf(p)];
    const v = this.world.economy.vehicleOf(p);
    if (v) holders.push(trunkOf(v));
    let seized = 0;
    for (const h of holders) {
      for (const [g, q] of Object.entries(h.items)) {
        if (!config.goods[g]?.illegal) continue;
        h.add(g, -q);
        seized += q;
      }
    }
    return seized;
  }

  // ---- arrests --------------------------------------------------------------------

  #bust(p) {
    const w = this.world;
    if (p.kind === 'hire') return w.hires.busted(p); // hired muscle is taken away
    if (p.vehicle) w.leaveSeat(p);
    const seized = this.#seize(p); // illegal goods are confiscated (from hands and the car with them)
    // Off to the prison (bail is paid to the warden there, by you or a friend).
    const stars0 = p.wanted;
    if (this.world.prison?.jail(p, stars0)) {
      p.arrest = 0;
      this.events.push({ player: p, kind: 'busted', prison: true, quota: p.jailed.quota, bail: p.jailed.bail, seized });
      return;
    }
    const bail = config.police.bailPerStar * p.wanted;
    const fromCash = Math.min(p.cash, bail);
    const fromBank = Math.min(Math.floor(p.account?.bank ?? 0), bail - fromCash);
    const stars = p.wanted;
    p.wanted = 0;
    p.robbing = null;
    p.arrest = 0;
    if (fromCash + fromBank >= bail) {
      p.cash -= fromCash;
      if (fromBank) {
        p.account.bank -= fromBank;
        w.onBankChange?.(p.account);
      }
      this.events.push({ player: p, kind: 'busted', bail, jail: 0, seized });
      return;
    }
    // Can't make bail: off to the cells.
    const station = this.#nearestStation(p.x, p.y);
    const jailSec = config.police.jailSecPerStar * stars;
    p.jailed = { until: this.time + jailSec, station };
    if (station?.jail) {
      p.x = station.jail.x;
      p.y = station.jail.y;
    }
    this.events.push({ player: p, kind: 'busted', bail, jail: jailSec, seized });
  }

  #nearestStation(x, y) {
    return this.stations.reduce((best, s) => (!best || Math.hypot(s.x - x, s.y - y) < Math.hypot(best.x - x, best.y - y) ? s : best), null);
  }

  #jail() {
    for (const p of this.world.players.values()) {
      if (!p.jailed || p.jailed.prison) continue; // (the prison looks after its own)
      const { until, station } = p.jailed;
      if (station?.jail) {
        p.x = station.jail.x; // stay in the cell
        p.y = station.jail.y;
      }
      if (this.time < until) continue;
      p.jailed = null;
      // Out the front door.
      const d = station?.doors.find((x) => x.exterior);
      if (d) {
        p.x = d.x + d.w / 2 + d.nx * 60;
        p.y = d.y + d.h / 2 + d.ny * 60;
      }
      this.events.push({ player: p, kind: 'released' });
    }
  }

  // ---- the police AI --------------------------------------------------------------------

  step(dt) {
    for (const w of this.waiting.splice(0)) {
      if ((w.in -= dt) > 0) this.waiting.push(w);
      else this.#replace(w.station, w.post);
    }
    this.#robberies(dt);
    this.#jail();
    // An officer who sees an unregistered gun in your hand reports it (now and then, not every tick).
    for (const p of this.world.players.values()) {
      if (!p.alive || p.vehicle || p.jailed || p.hidden || !p.weapon?.illegal) continue;
      if ((p.illegalSeenAt ?? -Infinity) + config.police.illegalGunEverySec > this.time) continue;
      if (!this.policeSee(p.x, p.y, p)) continue;
      p.illegalSeenAt = this.time;
      if (this.crime(p, 'illegal_gun', true)) this.events.push({ player: p, kind: 'illegal_gun_seen' });
    }
    // Driving a stolen Militsiya car with its siren on: the whole force can hear (and track) you.
    const wailing = (p) => p.vehicle?.police && p.vehicle.siren && p.vehicle.driver === p && p.kind === 'player';
    for (const p of this.world.players.values()) {
      if (wailing(p) && !p.wanted && !p.jailed) this.crime(p, 'steal_police_car', true);
    }
    // While they can see you they know where you are; out of sight long enough (longer for worse
    // crimes) and they give up.
    for (const p of this.#suspects()) {
      if (!p.wanted) continue;
      if (p.jailed) continue;
      if (wailing(p) || this.policeSee(p.x, p.y, p)) this.#lastKnown(p);
      else if (p.inSight) {
        p.inSight = false;
        this.#sawHide(p);
      } else if (this.time - (p.lastSeen ?? 0) > config.crime.searchSec[p.wanted]) {
        p.wanted = 0;
        p.lastKnown = null;
        this.events.push({ player: p, kind: 'lost_you' });
      }
    }
    this.#assign();
    for (const u of this.units) this.#runUnit(u, dt);
  }

  /** Up to one car per star goes after each wanted player, nearest cars first. */
  #assign() {
    for (const u of this.units) {
      if (u.target && (!u.target.alive || !u.target.wanted || u.target.jailed)) u.target = null;
    }
    // Cars only go out a little while after the call comes in.
    const wanted = this.#suspects().filter((p) => p.alive && p.wanted > 0 && !p.jailed && this.time - (p.reportedAt ?? -Infinity) >= config.police.responseSec);
    for (const p of wanted.sort((a, b) => b.wanted - a.wanted)) {
      const chasing = this.units.filter((u) => u.target === p).length;
      const free = this.units
        .filter((u) => !u.target && u.officer.health > 0 && (!u.post || Math.hypot(u.post.x - p.x, u.post.y - p.y) < (u.post.range ?? config.police.postRange))) // checkpoint cars and bank guards only answer calls nearby
        .sort((a, b) => Math.hypot(a.officer.x - p.x, a.officer.y - p.y) - Math.hypot(b.officer.x - p.x, b.officer.y - p.y));
      for (const u of free.slice(0, Math.max(0, p.wanted - chasing))) {
        u.target = p;
        u.route = [];
      }
    }
  }

  #runUnit(u, dt) {
    const o = u.officer;
    const car = u.car && this.world.vehicles.has(u.car.id) ? u.car : null;
    if (o.health <= 0) {
      if (car) car.ai = null;
      u.respawn += dt;
      if (u.respawn > config.police.respawnSec) {
        this.units.splice(this.units.indexOf(u), 1);
        this.#towAway(u.car);
        this.#replace(u.station, u.post);
      }
      return;
    }
    o.fireCooldown = Math.max(0, o.fireCooldown - dt);
    if (u.post?.guard) return this.#guardDuty(u, dt);
    const t = u.target;
    const seen = t && t.lastSeen === this.time; // someone has eyes on them right now
    if (o.onFoot) {
      if (car) car.ai = car.driver || car.speed < 5 ? null : { gas: vehicleMotion(car).forward > 0 ? -0.5 : 0.5, steer: 0, drift: false }; // parked: brake to a stop (not creep off in reverse)
      const ownCar = car && !car.driver ? car : null;
      // They've jumped in a car (or were last seen driving): back to the cruiser to give chase.
      const d = t ? Math.hypot((t.vehicle?.x ?? t.x) - o.x, (t.vehicle?.y ?? t.y) - o.y) : 0;
      const drivingOff = t && (t.vehicle ? t.vehicle.speed > 60 || d > 300 : !seen && t.lastKnown?.inCar && !t.hideSpot);
      if (ownCar && drivingOff) return this.#walkBack(u, ownCar, dt);
      if (t && seen && Math.hypot(t.x - o.x, t.y - o.y) < 900) this.#footChase(u, t, dt);
      else if (t?.lastKnown) this.#search(u, t, dt);
      else this.#walkBack(u, car, dt);
      return;
    }
    if (!car) {
      o.onFoot = true; // their car was destroyed
      return;
    }
    if (car.driver) {
      // Someone hijacked the cruiser: the officer is left standing.
      o.onFoot = true;
      car.ai = null;
      return;
    }
    o.x = car.x;
    o.y = car.y;
    o.angle = car.angle;
    car.siren = Boolean(t);
    if (t) u.parked = false; // (a checkpoint car off on a chase drives right back to its spot after)
    if (t && !seen && t.lastKnown) {
      const lk = t.lastKnown;
      // Lost in a car chase: cruise the roads round where they were last seen, looking.
      if (lk.inCar && !t.hideSpot) return this.#cruise(u, car, lk, dt);
      // Out of sight: drive to where they were last seen, then search on foot.
      if (Math.hypot(lk.x - car.x, lk.y - car.y) < 300 || (u.stuck > 0.6 && Math.hypot(lk.x - car.x, lk.y - car.y) < 700)) {
        o.onFoot = true;
        o.x = car.x - Math.sin(car.angle) * 50;
        o.y = car.y + Math.cos(car.angle) * 50;
        car.ai = { gas: -0.5, steer: 0, drift: false };
        return;
      }
      this.#drive(u, car, lk.x, lk.y, config.police.chaseThrottle, dt);
      return;
    }
    if (t) {
      const tx = t.vehicle ? t.vehicle.x : t.x;
      const ty = t.vehicle ? t.vehicle.y : t.y;
      const d = Math.hypot(tx - car.x, ty - car.y);
      if (!t.vehicle && (d < config.police.exitRange || (d < config.police.stuckExitRange && (u.stuck > 0.6 || u.reverse > 0)))) {
        // Out of the car and after them.
        o.onFoot = true;
        o.x = car.x - Math.sin(car.angle) * 50;
        o.y = car.y + Math.cos(car.angle) * 50;
        car.ai = { gas: -0.5, steer: 0, drift: false };
        return;
      }
      // Next to a stopped car with the suspect in it: pull them out.
      if (t.vehicle && d < 140 && t.vehicle.speed < 40) this.#arrestTick(u, t, dt);
      else u.arrest = Math.max(0, u.arrest - dt);
      this.#drive(u, car, tx, ty, config.police.chaseThrottle, dt);
      return;
    }
    u.cruiseFor = null;
    if (u.post) return this.#backToPost(u, car, dt);
    // Patrol along the roads.
    const graph = this.world.townsfolk.graph;
    if (!u.route.length && graph.nodes.length) {
      const node = graph.nodes[Math.floor(Math.random() * graph.nodes.length)];
      u.route = graph.route({ x: car.x, y: car.y }, node);
    }
    this.#followRoute(u, car, 0.55, dt);
  }

  /** A bank guard's turn: after whoever he's after (not far from the bank, and not a car), else back to his post. */
  #guardDuty(u, dt) {
    const o = u.officer, post = u.post;
    const t = u.target;
    if (t && Math.hypot(t.x - post.x, t.y - post.y) > post.range) u.target = null; // too far from the bank: not his job
    const target = u.target;
    if (target && !target.vehicle) {
      const seen = target.lastSeen === this.time;
      if (seen && Math.hypot(target.x - o.x, target.y - o.y) < 900) return this.#footChase(u, target, dt);
      if (target.lastKnown) return this.#search(u, target, dt);
    }
    u.arrest = 0;
    const outAfterDark = post.patrol ? this.world.prison?.curfewTarget(o) : null;
    if (outAfterDark) { // a prisoner out of the cells after lights-out: over to him with the baton
      o.angle = Math.atan2(outAfterDark.y - o.y, outAfterDark.x - o.x);
      if (Math.hypot(outAfterDark.x - o.x, outAfterDark.y - o.y) > outAfterDark.radius + 34) return this.#walk(o, outAfterDark.x, outAfterDark.y, dt);
      this.world.prison.club(o, outAfterDark);
      return;
    }
    if (post.patrol) { // a prison guard: round the camp at a stroll
      const at = post.patrol[u.leg ?? 0];
      if (Math.hypot(at.x - o.x, at.y - o.y) < 14) u.leg = ((u.leg ?? 0) + 1) % post.patrol.length;
      o.angle = Math.atan2(at.y - o.y, at.x - o.x);
      return this.#walk(o, at.x, at.y, dt * 0.45);
    }
    // Back to his post, in through the front door if he's outside.
    const b = this.world.buildings[post.guard - 1];
    const inside = b && o.x > b.x && o.x < b.x + b.w && o.y > b.y && o.y < b.y + b.h;
    const d = post.door;
    if (!inside && d) {
      // To just outside the door first, then (once he's at the doorway) on in.
      if (Math.hypot(d.x - o.x, d.y - o.y) > 60) return this.#walk(o, d.x + d.nx * 45, d.y + d.ny * 45, dt);
      return this.#walk(o, d.x - d.nx * 45, d.y - d.ny * 45, dt);
    }
    if (Math.hypot(post.x - o.x, post.y - o.y) > 6) {
      o.angle = Math.atan2(post.y - o.y, post.x - o.x);
      this.#walk(o, post.x, post.y, dt);
    } else o.angle = post.angle; // at his post, watching the door
  }

  /** A checkpoint car with nothing to do: drive back along the roads and park at its post. */
  #backToPost(u, car, dt) {
    const p = u.post;
    const d = Math.hypot(p.x - car.x, p.y - car.y);
    if (d < (u.parked ? 200 : 90)) { // there (or near enough): stop and stay stopped
      u.parked = true;
      u.route = [];
      car.ai = car.speed < 5 ? null : { gas: vehicleMotion(car).forward > 0 ? -1 : 1, steer: 0, drift: false };
      return;
    }
    u.parked = false;
    const graph = this.world.townsfolk.graph;
    if (!u.route.length || u.routeTo !== p) {
      u.routeTo = p;
      u.route = d > 400 && graph.nodes.length ? [...graph.route({ x: car.x, y: car.y }, p), { x: p.x, y: p.y }] : [{ x: p.x, y: p.y }];
    }
    this.#followRoute(u, car, d < 300 ? 0.25 : 0.55, dt);
  }

  #followRoute(u, car, throttle, dt) {
    const next = u.route[0];
    if (!next) return void (car.ai = { gas: 0, steer: 0, drift: false });
    if (Math.hypot(next.x - car.x, next.y - car.y) < 90) u.route.shift();
    this.#drive(u, car, next.x, next.y, throttle, dt);
  }

  /** Looking for a car that got away: to where it was last seen, then round the roads near there. */
  #cruise(u, car, lk, dt) {
    const graph = this.world.townsfolk.graph;
    car.siren = true;
    if (u.cruiseFor !== lk) {
      u.cruiseFor = lk;
      u.route = graph.nodes.length ? graph.route({ x: car.x, y: car.y }, lk) : [{ x: lk.x, y: lk.y }];
    }
    if (!u.route.length) {
      const near = graph.nodes.filter((n) => Math.hypot(n.x - lk.x, n.y - lk.y) < config.police.cruiseRadius);
      const node = near[Math.floor(Math.random() * near.length)];
      if (node) u.route = graph.route({ x: car.x, y: car.y }, node);
    }
    this.#followRoute(u, car, config.police.chaseThrottle * 0.85, dt);
  }

  /** Steer a car toward (tx, ty) at a share of full throttle; back out when stuck on something. */
  #drive(u, car, tx, ty, throttle, dt) {
    const diff = wrap(Math.atan2(ty - car.y, tx - car.x) - car.angle);
    const forward = vehicleMotion(car).forward;
    if (u.reverse > 0) {
      u.reverse -= dt;
      car.ai = { gas: -1, steer: -Math.sign(diff) || 1, drift: false };
      return;
    }
    u.stuck = Math.abs(forward) < 20 ? u.stuck + dt : 0;
    if (u.stuck > 1.2) {
      u.stuck = 0;
      u.reverse = 0.9;
    }
    let gas = throttle;
    if (Math.abs(diff) > 1.2 && forward > 160) gas = -0.6; // brake into tight turns
    car.ai = { gas, steer: Math.max(-1, Math.min(1, diff * 2.2)), drift: false };
  }

  #footChase(u, t, dt) {
    const o = u.officer;
    const d = Math.hypot(t.x - o.x, t.y - o.y);
    o.angle = Math.atan2(t.y - o.y, t.x - o.x);
    if (d > config.police.arrestRange * 0.7) this.#walk(o, t.x, t.y, dt);
    const shoot = t.wanted >= config.police.shootFrom || t.shotPolice;
    if (shoot && d < config.police.shootRange && o.fireCooldown <= 0 && this.#clearShot(o.x, o.y, t.x, t.y)) {
      o.fireCooldown = config.police.fireEverySec;
      const angle = o.angle + (Math.random() - 0.5) * config.police.aimSpread;
      const b = new Bullet(this.world.nextEntityId++, o, o.x + Math.cos(angle) * 30, o.y + Math.sin(angle) * 30, angle, 'pistol');
      this.world.bullets.set(b.id, b);
    }
    if (d < config.police.arrestRange + t.radius && (!t.vehicle || t.vehicle.speed < 40)) this.#arrestTick(u, t, dt);
    else u.arrest = Math.max(0, u.arrest - dt);
  }

  // ---- searching ------------------------------------------------------------------------

  /** Places to hide near where p was last seen: trees, dumpsters, cars and buildings (checked at a door). */
  #spots(p) {
    if (p.searchSpots) return p.searchSpots;
    const w = this.world;
    const lk = p.lastKnown;
    const R = config.police.searchRadius;
    const near = (x, y) => Math.hypot(x - lk.x, y - lk.y) < R;
    const spots = [];
    w.trees.forEach((t, i) => near(t.x, t.y) && spots.push({ key: `t${i}`, kind: 'tree', ref: t, x: t.x, y: t.y + t.canopy * 0.4 }));
    w.dumpsters.forEach((d, i) => near(d.x + d.w / 2, d.y + d.h / 2) && spots.push({ key: `d${i}`, kind: 'dumpster', ref: d, x: d.x + d.w / 2, y: d.y + d.h + 22 }));
    for (const v of w.vehicles.values()) if (!v.police && near(v.x, v.y)) spots.push({ key: `v${v.id}`, kind: 'car', ref: v, x: v.x, y: v.y + 50 });
    for (const b of w.buildings) {
      const d = b.doors.find((x) => x.exterior);
      if (d && near(b.x + b.w / 2, b.y + b.h / 2)) spots.push({ key: `b${b.id}`, kind: 'building', ref: b, x: d.x + d.w / 2 + d.nx * 30, y: d.y + d.h / 2 + d.ny * 30 });
    }
    return (p.searchSpots = spots);
  }

  /** Is p hiding at this spot? */
  #hidingAt(p, spot) {
    if (spot.kind === 'dumpster') return p.hidden?.dumpster === spot.ref;
    if (spot.kind === 'car') return p.vehicle === spot.ref;
    if (spot.kind === 'tree') return !p.vehicle && Math.hypot(spot.ref.x - p.x, spot.ref.y - p.y) < spot.ref.canopy * 0.75;
    const b = spot.ref;
    return !p.vehicle && p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
  }

  /** On foot from the last known spot: check each hiding place nearby in turn, nearest first. */
  #search(u, t, dt) {
    const o = u.officer;
    u.arrest = 0;
    // They saw where you hid: straight there.
    if (t.hideSpot && !t.searched.has(t.hideSpot) && u.spot?.key !== t.hideSpot) {
      u.spot = this.#spots(t).find((s) => s.key === t.hideSpot) ?? u.spot;
      u.inspect = 0;
    }
    const taken = new Set(this.units.filter((x) => x !== u && x.target === t && x.spot).map((x) => x.spot.key));
    if (!u.spot || t.searched.has(u.spot.key)) {
      u.spot = this.#spots(t)
        .filter((s) => !t.searched.has(s.key) && !taken.has(s.key))
        .sort((a, b) => Math.hypot(a.x - o.x, a.y - o.y) - Math.hypot(b.x - o.x, b.y - o.y))[0] ?? null;
      u.inspect = 0;
    }
    if (!u.spot) {
      // Nothing left to check: wait round where they were last seen.
      const lk = t.lastKnown;
      o.angle += dt * 0.8; // looking around
      if (Math.hypot(lk.x - o.x, lk.y - o.y) > 60) this.#walk(o, lk.x, lk.y, dt);
      return;
    }
    const s = u.spot;
    if (Math.hypot(s.x - o.x, s.y - o.y) > 40) {
      o.angle = Math.atan2(s.y - o.y, s.x - o.x);
      this.#walk(o, s.x, s.y, dt);
      return;
    }
    o.angle = Math.atan2((s.ref.y ?? s.y) - o.y, (s.ref.x ?? s.x) - o.x);
    if (s.kind === 'building') this.#openDoor(s.ref.doors.find((x) => x.exterior)); // have a look inside
    u.inspect = (u.inspect ?? 0) + dt;
    if (u.inspect < config.police.inspectSec) return;
    t.searched.add(s.key);
    if (this.#hidingAt(t, s)) {
      // Found! Out of the dumpster (or wherever) and the chase is on.
      if (t.hidden) this.world.unhide(t);
      this.#lastKnown(t);
      this.events.push({ player: t, kind: 'found_you' });
    }
    u.spot = null;
  }

  #arrestTick(u, t, dt) {
    u.arrest += dt;
    t.arrest = Math.max(t.arrest ?? 0, u.arrest / config.police.arrestSec);
    if (u.arrest >= config.police.arrestSec) {
      u.arrest = 0;
      this.#bust(t);
      u.target = null;
    }
  }

  #walkBack(u, car, dt) {
    const o = u.officer;
    if (!car) {
      // No car to go back to: head back to the station and get a new one.
      u.respawn += dt;
      if (u.respawn > config.police.respawnSec / 2) {
        this.units.splice(this.units.indexOf(u), 1);
        this.#towAway(u.car);
        this.#replace(u.station, u.post);
      }
      return;
    }
    u.arrest = 0;
    if (Math.hypot(car.x - o.x, car.y - o.y) < car.stats.length / 2 + 40) { // beside it (front, back or side)
      o.onFoot = false;
      car.picked = false; // back in: locked again
      return;
    }
    o.angle = Math.atan2(car.y - o.y, car.x - o.x);
    this.#walk(o, car.x, car.y, dt, car);
  }

  #walk(o, tx, ty, dt, toCar = null) {
    const d = Math.hypot(tx - o.x, ty - o.y);
    if (d < 1) return;
    const r = 16;
    const next = nextWaypoint(this.world, o, tx, ty, 20, dt, r, (door) => this.#mayOpen(door)); // (round walls, through doors he can open)
    const step = Math.min(d, Math.hypot(next.x - o.x, next.y - o.y), config.police.footSpeed * dt);
    const heading = Math.atan2(next.y - o.y, next.x - o.x);
    const way = this.world.steerAroundCars?.(o.x, o.y, heading, toCar) ?? heading; // round parked cars, not into them
    const [ox, oy] = [o.x, o.y];
    o.x += Math.cos(way) * step;
    o.y += Math.sin(way) * step;
    // Officers open any public door they walk up to.
    for (const e of this.world.wallGrid.query(o.x, o.y, r + 24)) {
      const door = e.door;
      if (!door || door.open) continue;
      const cx = Math.min(Math.max(o.x, door.x), door.x + door.w), cy = Math.min(Math.max(o.y, door.y), door.y + door.h);
      if (Math.hypot(o.x - cx, o.y - cy) <= r + 20) this.#openDoor(door);
    }
    for (const w of this.world.wallsNear(o.x, o.y, r)) {
      // Slide along walls rather than through them.
      const cx = Math.min(Math.max(o.x, w.x), w.x + w.w);
      const cy = Math.min(Math.max(o.y, w.y), w.y + w.h);
      const dx = o.x - cx;
      const dy = o.y - cy;
      const dd = Math.hypot(dx, dy);
      if (dd > 0 && dd < r) {
        o.x += (dx / dd) * (r - dd);
        o.y += (dy / dd) * (r - dd);
      }
    }
    o.stuckFor = step > 0.5 && Math.hypot(o.x - ox, o.y - oy) < step * 0.3 ? (o.stuckFor ?? 0) + dt : 0;
  }

  /** A public door (not a privately owned warehouse's, nor one in the prison wire)? */
  #mayOpen(door) {
    return !this.world.warehouses.all.get(door.building)?.owner && !this.world.prison?.isPrisonDoor(door);
  }

  /** Open a closed public door and tell everyone. */
  #openDoor(door) {
    if (!door || door.open || !this.#mayOpen(door)) return;
    door.open = true;
    this.world.pendingDoors.push(door);
  }

  #clearShot(ax, ay, bx, by) {
    const len = Math.hypot(bx - ax, by - ay);
    return !this.world.wallsNear((ax + bx) / 2, (ay + by) / 2, len / 2, true).some((w) => segmentRectHit(ax, ay, bx, by, w, 2) !== null);
  }

  /** On-foot officers within `range` of (x, y): [id, x, y, angle]. */
  visible(x, y, range) {
    const out = [];
    for (const u of this.units) {
      const o = u.officer;
      if (!o.onFoot || o.health <= 0 || Math.abs(o.x - x) > range || Math.abs(o.y - y) > range) continue;
      out.push([o.id, Math.round(o.x), Math.round(o.y), Math.round(o.angle * 100) / 100, u.post?.prison ? 1 : 0]); // (1: a prison guard)
    }
    return out;
  }
}
