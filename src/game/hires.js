import { config } from '../config.js';
import { segmentRectHit } from '../utils/math.js';
import { Bullet } from './entities.js';
import { hotbarOf } from './cargo.js';
import { Vehicle, vehicleCircles, vehicleMotion } from './vehicles.js';

// Hired muscle, from the barman at the БАР. Everything is paid from the bank.
//
//   goon    follows you on foot, hops in your car with you, and shoots whoever fights you (players,
//           officers who are shooting at you, townsfolk swinging a purse, other people's hires).
//   guard   is posted inside your home or one of your warehouses and shoots intruders and attackers.
//           Guards never leave the building.
//   hitman  hunts one player for a while: done when they die, half the fee back if they don't. He
//           drives a car of his own, parks within sniping range and takes them out from a distance
//           (a red laser shows while he's lining up a shot).
//
// Hires wear body armour, carry rifles and heal over time, so they're hard (not impossible) to kill.
// Goons and guards draw a wage every minute; if you can't pay, they walk off. Their crimes are their
// own (the Militsiya chase and arrest them like anyone), but a witness sometimes traces it back to
// whoever hired them. Hitmen are never traced.

const ROLES = ['goon', 'guard', 'hitman']; // the ones the barman hires out
const ALL_ROLES = [...ROLES, 'gangster']; // (gangsters work for nobody: employer null)
const inside = (b, x, y, m = 0) => x > b.x + m && x < b.x + b.w - m && y > b.y + m && y < b.y + b.h - m;

export class Hires {
  constructor(world) {
    this.world = world;
    this.bar = world.buildings.find((b) => b.type === 'bar') ?? null;
    this.list = [];
    this.nextId = 1;
    this.time = 0;
    this.wageTimer = 0;
    this.events = []; // { player | account, kind, … } for the room to tell people
    this.gangsterTimers = []; // seconds until each missing gangster is replaced
    for (let i = 0; i < config.gangsters.count; i++) this.#spawnGangster();
    this.started = true;
  }

  // ---- who's who ----------------------------------------------------------------------

  /** The employer's player, if they're in the game and alive. */
  bossOf(h) {
    for (const p of this.world.players.values()) if (p.account === h.employer && p.alive) return p;
    return null;
  }

  mine(account) {
    return this.list.filter((h) => h.employer === account);
  }

  /** Are a and b on the same side (a player and their hires, teammates, their teammates' hires)? */
  friendly(a, b) {
    if (a === b) return true;
    const acc = (x) => (x.kind === 'hire' ? x.employer : x.kind === 'player' ? x.account : null);
    const [aa, ab] = [acc(a), acc(b)];
    if (aa && aa === ab) return true;
    if (a.role === 'hitman' || b.role === 'hitman') return false; // a hitman spares only whoever hired him
    const pa = a.kind === 'hire' ? this.bossOf(a) : a;
    const pb = b.kind === 'hire' ? this.bossOf(b) : b;
    return Boolean(pa?.kind === 'player' && pb?.kind === 'player' && this.world.areTeammates(pa, pb));
  }

  /** `attacker` hurt `victim`: each is fair game for the other's side for a while. */
  noteAttack(attacker, victim) {
    if (!attacker || !victim || attacker === victim) return;
    const until = this.time + config.hires.foeSec;
    for (const [a, b] of [[attacker, victim], [victim, attacker]]) {
      if (a.kind !== 'player' && a.kind !== 'hire') continue;
      a.foes ??= new Map();
      if (a.foes.size > 8) for (const [k, t] of a.foes) if (t < this.time) a.foes.delete(k);
      a.foes.set(b, until);
    }
  }

  #isFoe(of, x) {
    return (of?.foes?.get(x) ?? -Infinity) >= this.time;
  }

  // ---- the barman -----------------------------------------------------------------------

  atBar(p) {
    const n = this.bar?.npc;
    return Boolean(n && !p.vehicle && Math.hypot(n.x - p.x, n.y - p.y) < config.hires.reach + p.radius);
  }

  /** Buildings p can post a guard in: their home and their warehouses. */
  posts(p) {
    const out = [];
    const home = this.world.homes.homeOf(p.account);
    if (home) out.push({ id: home.id, label: 'Your home' });
    for (const w of this.world.warehouses.all.values()) if (w.owner && w.owner === p.account) out.push({ id: w.id, label: config.warehouses.sizes[w.size]?.name ?? 'Warehouse' });
    return out;
  }

  /** Hire a goon, a guard (post: building id) or a hitman (target: player id). Returns an error code or null. */
  hire(p, role, { post = 0, target = 0 } = {}) {
    if (!ROLES.includes(role)) return 'unknown';
    if (!this.atBar(p)) return 'too_far';
    if (!p.account) return 'no_account';
    const rule = config.hires[role];
    if (this.mine(p.account).filter((h) => h.role === role).length >= rule.max) return 'hire_limit';
    if (p.account.bank < rule.fee) return 'not_enough_bank';
    let at = null;
    let extra = {};
    if (role === 'guard') {
      if (!this.posts(p).some((x) => x.id === post)) return 'not_your_building';
      const b = this.world.buildings[post - 1];
      at = this.#spotInside(b);
      extra = { post: b, home: at };
    } else if (role === 'hitman') {
      const victim = this.world.players.get(target);
      if (!victim?.alive || victim === p) return 'no_target';
      if (victim.account && victim.account === p.account) return 'no_target';
      at = this.#lurkNear(victim);
      extra = { target: victim, until: this.time + rule.contractSec, fee: rule.fee, aim: 0, backoff: 0, stuck: 0, jammed: 0, reverse: 0 };
      const car = this.#hitCar(victim);
      if (car) {
        Object.assign(extra, { car, vehicle: car });
        at = { x: car.x, y: car.y };
      }
      this.events.push({ player: victim, kind: 'contract_on_you' });
    } else {
      at = this.#besideBar(p);
    }
    p.account.bank -= rule.fee;
    this.world.onBankChange?.(p.account);
    const r = config.hires;
    this.list.push({
      kind: 'hire', role, id: this.nextId++, employer: p.account, name: role === 'hitman' ? 'a hitman' : `${p.name}'s ${rule.name.toLowerCase()}`,
      x: at.x, y: at.y, angle: 0, health: r.health, maxHealth: r.health, radius: r.radius,
      weapon: rule.weapon ?? r.weapon, fireCooldown: 0, ammo: config.weapons[rule.weapon ?? r.weapon].magazineSize, reload: 0,
      vehicle: null, alive: true, wanted: 0, lastSeen: 0, hidden: null, jailed: null, shotPolice: false,
      foes: new Map(), offline: 0, pick: null, ...extra,
    });
    return null;
  }

  /** Let one of your hires go (no refund). */
  dismiss(p, id) {
    const h = this.list.find((x) => x.id === id && x.employer === p.account);
    if (!h) return 'unknown';
    this.#remove(h);
    return null;
  }

  /** What the bar panel shows p. */
  /** A bottle of vodka from the barman: dear (cash), but no questions asked. */
  buyVodka(p) {
    if (!this.atBar(p)) return 'too_far';
    const price = config.hires.barVodkaPrice;
    if (p.cash < price) return 'not_enough_cash';
    if (hotbarOf(p).room('vodka') < 1) return 'no_room';
    p.cash -= price;
    hotbarOf(p).add('vodka', 1);
    return null;
  }

  describe(p) {
    const r = config.hires;
    return {
      kind: 'bar',
      id: this.bar?.id ?? 0,
      vodkaPrice: r.barVodkaPrice,
      prices: Object.fromEntries(ROLES.map((role) => [role, { fee: r[role].fee, wage: r[role].wagePerMin ?? 0, max: r[role].max, sec: r[role].contractSec ?? 0 }])),
      mine: this.mine(p.account).map((h) => ({
        id: h.id,
        role: h.role,
        health: Math.ceil(h.health),
        max: h.maxHealth,
        post: h.post ? h.post.id : 0,
        target: h.target?.name ?? null,
        left: h.until ? Math.max(0, Math.round(h.until - this.time)) : 0,
        riding: h.vehicle ? 1 : 0,
      })),
      posts: this.posts(p),
      targets: [...this.world.players.values()].filter((o) => o !== p && o.alive && !(o.account && o.account === p.account)).map((o) => ({ id: o.id, name: o.name })),
    };
  }

  // ---- getting hurt ------------------------------------------------------------------------

  /** The hire (on foot) a bullet path a→b of radius r hits, other than the shooter's own side. */
  hitBy(ax, ay, bx, by, r, segmentDistSq, shooter) {
    for (const h of this.list) {
      if (h.vehicle || h === shooter) continue;
      if (shooter && (shooter.kind === 'player' || shooter.kind === 'hire') && h.employer && h.employer === (shooter.employer ?? shooter.account)) continue; // no shooting your own
      if (h.role === 'gangster' && (shooter?.role === 'gangster' || shooter?.kind === 'officer')) continue; // (nor your own crew; and the Militsiya leave gangsters be)
      if (segmentDistSq(ax, ay, bx, by, h.x, h.y) < (h.radius + r) ** 2) return h;
    }
    return null;
  }

  /** Hurt hire h (armour soaks up part of it). Returns true if it killed them. */
  damage(h, amount, attacker) {
    if (!this.list.includes(h)) return false;
    h.health -= amount * (1 - (h.role === 'gangster' ? config.gangsters.armor : config.hires.armor));
    if (attacker) this.noteAttack(attacker, h);
    if (attacker?.kind === 'player' || attacker?.kind === 'hire') this.world.police.crime(attacker, h.health <= 0 ? 'murder' : 'assault');
    if (h.health > 0) return false;
    this.world.bodies?.add({ x: h.x, y: h.y, angle: h.angle, kind: 'npc', look: LOOKS[h.role], items: [{ type: h.weapon, ammo: h.ammo, reloadTimer: 0 }], cash: h.cash ?? 0, killer: attacker?.kind === 'player' ? attacker : null });
    this.#tell(h, 'hire_died');
    this.#remove(h, true);
    return true;
  }

  /** The Militsiya took them away. */
  busted(h) {
    this.#tell(h, 'hire_busted');
    this.#remove(h, true);
  }

  /** A hire's crime was reported: sometimes a witness ties it to whoever hired them. */
  traced(h, crime, stars) {
    if (h.role === 'hitman' || Math.random() >= config.hires.traceChance) return;
    const boss = this.bossOf(h);
    if (!boss) return;
    this.world.police.crime(boss, crime, true, null, Math.max(1, stars - 1));
    this.events.push({ player: boss, kind: 'traced', role: h.role });
  }

  #tell(h, kind) {
    const boss = this.bossOf(h);
    if (boss) this.events.push({ player: boss, kind, role: h.role });
  }

  #remove(h, killed = false) {
    const i = this.list.indexOf(h);
    if (i === -1) return;
    this.list.splice(i, 1);
    h.alive = false;
    if (h.role === 'gangster') {
      if (h.holdup?.p) h.holdup.p.heldUp = null;
      if (h.vehicle) { h.vehicle.ai = null; h.vehicle.stolenBy = null; }
      this.gangsterTimers.push(config.gangsters.respawnSec); // a new face, in a while
    }
    if (h.vehicle) this.#leaveCar(h, false);
    if (h.role !== 'gangster') for (const c of [h.car, h.oldCar]) if (c && !c.driver && !c.passenger) this.world.vehicles.delete(c.id); // his car goes with him
    // A hitman who didn't finish the job: half the fee back.
    if (h.role === 'hitman' && h.target && !h.done) {
      const back = Math.floor(h.fee * config.hires.hitman.refundShare);
      h.employer.bank += back;
      this.world.onBankChange?.(h.employer);
      const boss = this.bossOf(h);
      if (boss) this.events.push({ player: boss, kind: 'contract_failed', refund: back, killed });
      if (h.target.alive) this.events.push({ player: h.target, kind: 'contract_over' });
    }
  }

  // ---- the simulation -------------------------------------------------------------------------

  step(dt) {
    this.time += dt;
    this.#wages(dt);
    for (let i = this.gangsterTimers.length - 1; i >= 0; i--) if ((this.gangsterTimers[i] -= dt) <= 0 && this.#spawnGangster()) this.gangsterTimers.splice(i, 1);
    for (const h of [...this.list]) {
      if (!this.list.includes(h)) continue;
      if (h.jailed) continue;
      if (h.role !== 'gangster') h.health = Math.min(h.maxHealth, h.health + config.hires.regenPerSec * dt); // (gangsters don't heal)
      h.fireCooldown = Math.max(0, h.fireCooldown - dt);
      if (h.reload > 0 && (h.reload -= dt) <= 0) h.ammo = config.weapons[h.weapon].magazineSize;
      if (h.role === 'goon') this.#goon(h, dt);
      else if (h.role === 'guard') this.#guard(h, dt);
      else if (h.role === 'gangster') this.#gangster(h, dt);
      else this.#hitman(h, dt);
    }
  }

  /** Every minute: goons' and guards' wages from the bank. Can't pay? They walk off. */
  #wages(dt) {
    this.wageTimer += dt;
    if (this.wageTimer < 60) return;
    this.wageTimer -= 60;
    const byEmployer = new Map();
    for (const h of this.list) if (h.role !== 'hitman' && h.employer) byEmployer.set(h.employer, [...(byEmployer.get(h.employer) ?? []), h]);
    for (const [account, hires] of byEmployer) {
      const due = hires.reduce((sum, h) => sum + config.hires[h.role].wagePerMin, 0);
      if (account.bank >= due) {
        account.bank -= due;
        this.world.onBankChange?.(account);
        continue;
      }
      for (const h of hires) {
        this.#tell(h, 'hire_quit');
        this.#remove(h);
      }
    }
  }

  #goon(h, dt) {
    const r = config.hires;
    const boss = this.bossOf(h);
    if (!boss) {
      // The boss is gone (dead, or left): wait about, then go home.
      if (h.vehicle) this.#leaveCar(h);
      if (!this.#bossOnline(h) && (h.offline += dt) > r.goonOfflineSec) this.#remove(h);
      return;
    }
    h.offline = 0;
    // Riding along: stay in the car until the boss gets out (or the car's gone).
    if (h.vehicle) {
      const v = h.vehicle;
      if (!this.world.vehicles.has(v.id)) {
        this.#leaveCar(h, false);
        h.health -= config.vehicles.exitDamage * (1 - r.armor);
      } else if (boss.vehicle !== v) this.#leaveCar(h);
      else {
        h.x = v.x;
        h.y = v.y;
        return;
      }
    }
    const car = boss.vehicle;
    const threat = this.#threat(h, boss, r.engageRange);
    if (threat && !car) {
      this.#fightThreat(h, threat, dt, 260);
      return;
    }
    if (car) {
      const d = Math.hypot(car.x - h.x, car.y - h.y);
      const reach = car.radius + h.radius + 30;
      if (d < reach && Math.hypot(car.vx, car.vy) < 120) return this.#board(h, car);
      if (d < r.boardRange || Math.hypot(car.vx, car.vy) < 60) {
        this.#walk(h, car.x, car.y, r.runSpeed, dt, car);
        return;
      }
    }
    const bx = car ? car.x : boss.x, by = car ? car.y : boss.y;
    const d = Math.hypot(bx - h.x, by - h.y);
    if (d > r.catchUpRange) return this.#catchUp(h, boss);
    // Keep close, each goon a little to one side of the boss.
    const slot = this.mine(h.employer).filter((x) => x.role === 'goon').indexOf(h);
    const side = (boss.input?.angle ?? 0) + Math.PI + (slot ? 0.7 : -0.7);
    const tx = bx + Math.cos(side) * 75, ty = by + Math.sin(side) * 75;
    if (Math.hypot(tx - h.x, ty - h.y) > 25) this.#walk(h, tx, ty, d > 260 ? r.runSpeed : r.speed, dt);
    h.angle = threat ? h.angle : Math.atan2(by - h.y, bx - h.x);
  }

  #guard(h, dt) {
    const b = h.post;
    // Lost the building (sold the warehouse)? Nothing to guard.
    if (this.world.homes.homeOf(h.employer) !== b && this.world.warehouses.all.get(b.id)?.owner !== h.employer) {
      this.#tell(h, 'hire_quit');
      return this.#remove(h);
    }
    const threat = this.#threat(h, null, config.hires.engageRange, b);
    if (threat) {
      this.#fightThreat(h, threat, dt, 0, b);
      return;
    }
    if (Math.hypot(h.home.x - h.x, h.home.y - h.y) > 20) this.#walk(h, h.home.x, h.home.y, config.hires.speed, dt, null, b);
    else h.angle += dt * 0.3; // looking about
  }

  #hitman(h, dt) {
    const r = config.hires;
    const t = h.target;
    if (!t.alive) {
      // Dead: job done. (Left the game: the contract's off.)
      if (t.health <= 0) {
        h.done = true;
        const boss = this.bossOf(h);
        if (boss) this.events.push({ player: boss, kind: 'contract_done', name: t.name });
      }
      return this.#remove(h);
    }
    if (this.time > h.until) return this.#remove(h);
    const hm = r.hitman;
    const car = h.car && this.world.vehicles.has(h.car.id) ? h.car : null;
    if (!car) h.car = null;
    h.aiming = false;
    if (h.vehicle) {
      if (car && !car.driver) return this.#driveHunt(h, car, t, dt);
      // Blown up, or someone hijacked it: he's on foot.
      if (car) car.ai = null;
      else h.health -= config.vehicles.exitDamage * (1 - r.armor);
      this.#leaveCar(h, Boolean(car));
    }
    if (this.#unstick(h, t, dt)) return;
    // Someone right on top of him gets dealt with first.
    const threat = this.#threat(h, null, 350);
    if (threat) return this.#fightThreat(h, threat, dt, 0);
    const tx = t.vehicle ? t.vehicle.x : t.x, ty = t.vehicle ? t.vehicle.y : t.y;
    const d = Math.hypot(tx - h.x, ty - h.y);
    if (d > hm.driveFrom) {
      h.aim = 0;
      // They've moved off: back to the car and after them (or, carless and far behind, he turns up again nearby).
      if (car && Math.hypot(car.x - h.x, car.y - h.y) < 1500) {
        if (Math.hypot(car.x - h.x, car.y - h.y) < car.radius + h.radius + 30) {
          h.vehicle = car;
          h.x = car.x;
          h.y = car.y;
          h.lastD = null;
          h.jammed = 0;
        } else this.#walk(h, car.x, car.y, r.runSpeed, dt, car);
      } else if (d > r.catchUpRange + 800) {
        Object.assign(h, this.#lurkNear(t));
        if (!car) {
          const fresh = this.#hitCar(t);
          if (fresh) Object.assign(h, { car: fresh, vehicle: fresh, x: fresh.x, y: fresh.y });
        }
      } else this.#walk(h, tx, ty, r.runSpeed, dt);
      return;
    }
    this.#snipe(h, tx, ty, d, dt);
  }

  /**
   * On foot and getting nowhere (wedged between a wall and a car, a building in the way)? A short
   * detour in some clear direction; still stuck after a good while, he finds another way round and
   * turns up near the target, out of sight. Returns true while he's busy with that.
   */
  #unstick(h, t, dt) {
    const p = (h.prog ??= { x: h.x, y: h.y, t: 0, stuck: 0, tried: false });
    p.tried ||= h.tried;
    h.tried = false;
    if ((p.t += dt) >= 2) {
      const moved = Math.hypot(h.x - p.x, h.y - p.y);
      p.stuck = p.tried && moved < 40 ? p.stuck + 2 : 0;
      Object.assign(p, { x: h.x, y: h.y, t: 0, tried: false });
      if (p.stuck >= 12) {
        p.stuck = 0;
        h.detour = h.perch = null;
        Object.assign(h, this.#lurkNear(t));
        return true;
      }
      if (p.stuck >= 2) h.detour = { ...this.#detourPoint(h), until: this.time + 1.8 };
    }
    if (h.detour && this.time < h.detour.until) {
      this.#walk(h, h.detour.x, h.detour.y, config.hires.runSpeed, dt);
      return true;
    }
    h.detour = null;
    return false;
  }

  /** A clear spot a short walk away in a random direction. */
  #detourPoint(h) {
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, dist = 150 + Math.random() * 200;
      const x = h.x + Math.cos(a) * dist, y = h.y + Math.sin(a) * dist;
      if (this.world.isBlocked(x, y, h.radius + 4) || this.world.isSwimming(x, y)) continue;
      if (this.#clearShot(h.x, h.y, x, y)) return { x, y };
    }
    const a = Math.random() * Math.PI * 2;
    return { x: h.x + Math.cos(a) * 200, y: h.y + Math.sin(a) * 200 };
  }

  /** On foot within range of the target: find a line of sight, keep his distance, line up and fire. */
  #snipe(h, tx, ty, d, dt) {
    const hm = config.hires.hitman;
    h.angle = Math.atan2(ty - h.y, tx - h.x);
    if (d > hm.range[1] || !this.#clearShot(h.x, h.y, tx, ty)) {
      // No shot from here: a spot nearby that has one (looked for again every second or so).
      h.aim = 0;
      if (!h.perch || this.time > h.perch.until) h.perch = { ...(this.#perch(h, tx, ty) ?? { x: tx, y: ty }), until: this.time + 1.2 };
      this.#walk(h, h.perch.x, h.perch.y, config.hires.runSpeed, dt);
      return;
    }
    h.perch = null;
    // Too close for comfort: back off a while before taking the shot anyway.
    if (d < hm.range[0] && h.aim === 0 && (h.backoff += dt) < 3) {
      this.#walk(h, h.x - (tx - h.x), h.y - (ty - h.y), config.hires.runSpeed, dt);
      return;
    }
    if (d >= hm.range[0]) h.backoff = 0;
    if (h.reload > 0 || h.fireCooldown > 0) return;
    h.aiming = true;
    h.aim += dt;
    if (h.aim < hm.aimSec) return;
    h.aim = 0;
    h.backoff = 0;
    this.#shoot(h, h.angle + (Math.random() - 0.5) * hm.spread);
  }

  /**
   * A firing position: somewhere on a ring round the target (in sniping range) with a clear shot at
   * it, that h can walk straight to — the one nearest h.
   */
  #perch(h, tx, ty) {
    const hm = config.hires.hitman;
    const w = this.world;
    let best = null;
    for (const dist of [hm.range[1] - 250, (hm.range[0] + hm.range[1]) / 2, hm.range[0] + 50]) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = tx + Math.cos(a) * dist, y = ty + Math.sin(a) * dist;
        // Ones he can walk straight to are much better (the rest he has to find his way to).
        const cost = Math.hypot(x - h.x, y - h.y);
        if (best && cost >= best.cost) continue;
        if (x < 50 || y < 50 || x > w.width - 50 || y > w.height - 50) continue;
        if (w.isBlocked(x, y, h.radius + 4) || w.isSwimming(x, y) || !this.#clearShot(x, y, tx, ty)) continue;
        const total = cost + (this.#clearShot(h.x, h.y, x, y) ? 0 : 1500);
        if (!best || total < best.cost) best = { x, y, cost: total };
      }
    }
    return best;
  }

  /** Behind the wheel: drive at the target; park once within sniping range with a clear view (or stuck nearby), and get out. */
  #driveHunt(h, car, t, dt) {
    const hm = config.hires.hitman;
    h.x = car.x;
    h.y = car.y;
    const tx = t.vehicle ? t.vehicle.x : t.x, ty = t.vehicle ? t.vehicle.y : t.y;
    const d = Math.hypot(tx - car.x, ty - car.y);
    const forward = vehicleMotion(car).forward;
    // Not getting any closer (wedged against something, or going round in circles)?
    if ((h.check = (h.check ?? 0) + dt) >= 2) {
      h.jammed = (h.lastD ?? Infinity) - d < 80 ? h.jammed + 2 : 0;
      h.lastD = d;
      h.check = 0;
    }
    if (h.jammed >= 8) { // hopeless: leave the car where it is and go on foot
      h.oldCar = car;
      h.car = null;
      car.ai = null;
      h.jammed = 0;
      this.#leaveCar(h);
      return;
    }
    const park = (d < hm.range[1] - 150 && this.world.lineOfSight(car.x, car.y, tx, ty)) || d < hm.range[0] + 150 || (h.jammed >= 4 && d < hm.driveFrom);
    if (park) {
      car.ai = { gas: Math.abs(forward) > 30 ? -Math.sign(forward) : 0, steer: 0, drift: false };
      if (car.speed < 40) {
        car.ai = null;
        h.stuck = h.jammed = 0;
        h.lastD = null;
        this.#leaveCar(h);
      }
      return;
    }
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const diff = wrap(Math.atan2(ty - car.y, tx - car.x) - car.angle);
    if (h.reverse > 0) {
      h.reverse -= dt;
      car.ai = { gas: -1, steer: -Math.sign(diff) || 1, drift: false };
      return;
    }
    h.stuck = Math.abs(forward) < 20 ? h.stuck + dt : 0;
    if (h.stuck > 1.2) {
      h.stuck = 0;
      h.reverse = 0.9; // back out of whatever he's hit
    }
    const gas = Math.abs(diff) > 1.2 && forward > 160 ? -0.6 : 0.8; // brake into tight turns
    car.ai = { gas, steer: Math.max(-1, Math.min(1, diff * 2.2)), drift: false };
  }

  /** A plain car parked on a road a fair way from `t`, for the hitman (locked to everyone else). */
  #hitCar(t) {
    const w = this.world;
    const type = config.hires.hitman.car;
    const stats = config.vehicles.types[type];
    const cx = t.vehicle ? t.vehicle.x : t.x, cy = t.vehicle ? t.vehicle.y : t.y;
    for (let i = 0; i < 80 && w.roads.length; i++) {
      const road = w.roads[Math.floor(Math.random() * w.roads.length)];
      const horizontal = road.w > road.h;
      const x = horizontal ? road.x + Math.random() * road.w : road.x + road.w * 0.3;
      const y = horizontal ? road.y + road.h * 0.3 : road.y + Math.random() * road.h;
      const d = Math.hypot(x - cx, y - cy);
      if (d < 1600 || d > 2600 || x < 200 || y < 200 || x > w.width - 200 || y > w.height - 200) continue;
      const angle = horizontal ? Math.PI : -Math.PI / 2;
      const probe = { x, y, angle };
      if (vehicleCircles(probe, stats).some((c) => w.isBlocked(c.x, c.y, c.r) || w.isSwimming(c.x, c.y))) continue;
      if ([...w.vehicles.values()].some((o) => Math.hypot(o.x - x, o.y - y) < 220)) continue;
      const v = new Vehicle(w.nextEntityId++, type, x, y, angle);
      Object.assign(v, { owner: { id: null, name: null }, color: '#1c1c1c', fuel: 100, lights: true, hitman: true });
      w.vehicles.set(v.id, v);
      return v;
    }
    return null;
  }

  /** Close in on `t` (to `keep` away; 0: stay put), and shoot when there's a clear shot. */
  #fightThreat(h, t, dt, keep, within = null) {
    const r = config.hires;
    const tx = t.vehicle ? t.vehicle.x : t.x, ty = t.vehicle ? t.vehicle.y : t.y;
    const d = Math.hypot(tx - h.x, ty - h.y);
    h.angle = Math.atan2(ty - h.y, tx - h.x);
    const clear = this.#clearShot(h.x, h.y, tx, ty);
    if (keep && (d > keep || !clear)) this.#walk(h, tx, ty, r.runSpeed, dt, null, within);
    if (!clear || d > r.shootRange || h.fireCooldown > 0 || h.reload > 0) return;
    this.#shoot(h, h.angle + (Math.random() - 0.5) * r.aimSpread);
  }

  #shoot(h, angle) {
    const gun = config.weapons[h.weapon];
    h.fireCooldown = Math.max(config.hires.fireEverySec, gun.cooldownSec);
    const off = h.radius + 14;
    const b = new Bullet(this.world.nextEntityId++, h, h.x + Math.cos(angle) * off, h.y + Math.sin(angle) * off, angle, h.weapon);
    this.world.bullets.set(b.id, b);
    if (--h.ammo <= 0) h.reload = gun.reloadSec;
    if ((h.nextFireCrime ?? 0) <= this.time) {
      h.nextFireCrime = this.time + 1;
      this.world.police.crime(h, 'fire');
    }
  }

  /**
   * The nearest thing to shoot at, within `range`: anyone (player, townsperson, officer or hire) who
   * has hurt h or h's boss lately, townsfolk swinging at them, officers shooting at them, other
   * people's hires coming for them, and (for a
   * guard, `post`) any outsider who's got inside.
   */
  #threat(h, boss, range, post = null) {
    const w = this.world;
    let best = null, bestD = range;
    const consider = (x, ok) => {
      if (!ok) return;
      const tx = x.vehicle ? x.vehicle.x : x.x, ty = x.vehicle ? x.vehicle.y : x.y;
      const d = Math.hypot(tx - h.x, ty - h.y);
      if (d < bestD && w.lineOfSight(h.x, h.y, tx, ty)) [best, bestD] = [x, d];
    };
    const owner = boss ?? this.bossOf(h);
    for (const p of w.players.values()) {
      if (!p.alive || p.hidden || p.jailed || this.friendly(h, p)) continue;
      const intruder = post && !p.vehicle && inside(post, p.x, p.y);
      consider(p, intruder || this.#isFoe(h, p) || this.#isFoe(owner, p));
    }
    for (const o of this.list) {
      if (o === h || o.vehicle || this.friendly(h, o)) continue;
      const intruder = post && inside(post, o.x, o.y);
      const hood = o.role === 'gangster' && (h.role === 'goon' || h.role === 'guard'); // goons and guards go for gangsters on sight
      consider(o, intruder || hood || this.#isFoe(h, o) || (owner && this.#isFoe(owner, o)) || (o.role === 'hitman' && o.target === owner));
    }
    if (h.role === 'hitman') return best; // (the target is handled by the hunt)
    const hurtUs = (x) => this.#isFoe(h, x) || this.#isFoe(owner, x);
    for (const t of w.townsfolk.people) consider(t, t.inside <= 0 && ((t.fight && (t.fight.target === owner || t.fight.target === h)) || hurtUs(t)));
    for (const u of w.police.units) {
      const o = u.officer;
      if (!o.onFoot || o.health <= 0) continue;
      const tgt = u.target;
      const shooting = tgt && (tgt.wanted >= config.police.shootFrom || tgt.shotPolice);
      consider(o, hurtUs(o) || (shooting && (tgt === owner || tgt === h || (tgt.kind === 'hire' && tgt.employer === h.employer))));
    }
    return best;
  }

  #clearShot(ax, ay, bx, by) {
    const len = Math.hypot(bx - ax, by - ay);
    return !this.world.wallsNear((ax + bx) / 2, (ay + by) / 2, len / 2, true).some((w) => !w.npc && segmentRectHit(ax, ay, bx, by, w, 2) !== null);
  }

  /** Walk toward (tx, ty): round parked cars, sliding along walls, opening doors they may use. */
  #walk(h, tx, ty, speed, dt, toCar = null, within = null) {
    if (!within) [tx, ty] = this.#viaDoor(h, tx, ty);
    const d = Math.hypot(tx - h.x, ty - h.y);
    if (d < 1) return;
    if (d > 5) h.tried = true; // (for #unstick)
    const w = this.world;
    const step = Math.min(d, speed * dt);
    const heading = Math.atan2(ty - h.y, tx - h.x);
    const way = w.steerAroundCars(h.x, h.y, heading, toCar);
    const nx = h.x + Math.cos(way) * step, ny = h.y + Math.sin(way) * step;
    if (within && !inside(within, nx, ny, h.radius + 6)) return; // guards stay indoors
    h.x = nx;
    h.y = ny;
    h.angle = way;
    const r = h.radius;
    let blocked = null;
    for (const e of w.wallGrid.query(h.x, h.y, r + 24)) {
      const door = e.door;
      if (!door || door.open) continue;
      const cx = Math.min(Math.max(h.x, door.x), door.x + door.w), cy = Math.min(Math.max(h.y, door.y), door.y + door.h);
      if (Math.hypot(h.x - cx, h.y - cy) > r + 20) continue;
      const boss = this.bossOf(h);
      const locked = boss ? w.lockedFor(door, boss) : w.lockedFor(door, { account: h.employer, x: h.x, y: h.y });
      if (!locked) this.#open(door);
      else if (h.role === 'hitman') blocked = door;
    }
    // A hitman picks his way through a locked door.
    if (blocked) {
      if (h.pick?.door !== blocked) h.pick = { door: blocked, t: 0 };
      if ((h.pick.t += dt) >= config.hires.lockpickSec) {
        if (w.warehouses.all.has(blocked.building)) w.warehouses.unlock(blocked);
        else w.homes.unlock(blocked);
        this.#open(blocked);
        h.pick = null;
      }
    }
    for (const wall of w.wallsNear(h.x, h.y, r)) {
      const cx = Math.min(Math.max(h.x, wall.x), wall.x + wall.w), cy = Math.min(Math.max(h.y, wall.y), wall.y + wall.h);
      const dx = h.x - cx, dy = h.y - cy, dd = Math.hypot(dx, dy);
      if (dd > 0 && dd < r) {
        h.x += (dx / dd) * (r - dd);
        h.y += (dy / dd) * (r - dd);
      }
    }
  }

  /**
   * Buildings in the way: someone inside heading out goes for the nearest outside door first (and
   * someone outside heading in, the target building's door): through the doorway, then on.
   */
  #viaDoor(h, tx, ty) {
    const w = this.world;
    const holder = (x, y) => w.buildings.find((b) => b.doors.length && inside(b, x, y));
    const from = holder(h.x, h.y), to = holder(tx, ty);
    if (from === to) return [tx, ty];
    const b = from ?? to;
    const out = from ? 1 : -1; // leaving: aim past the doorway, outward; going in: aim just inside it
    let best = null;
    for (const d of b.doors) {
      if (!d.exterior) continue;
      const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
      const cost = Math.hypot(cx - h.x, cy - h.y) + Math.hypot(tx - cx, ty - cy);
      if (!best || cost < best.cost) best = { cost, cx, cy, nx: d.nx, ny: d.ny };
    }
    if (!best) return [tx, ty];
    // Line up square with the doorway before going through it.
    const before = { x: best.cx - best.nx * 40 * out, y: best.cy - best.ny * 40 * out };
    const lined = Math.abs((h.x - best.cx) * best.ny - (h.y - best.cy) * best.nx) < 25 || Math.hypot(h.x - best.cx, h.y - best.cy) < 30;
    return lined ? [best.cx + best.nx * 60 * out, best.cy + best.ny * 60 * out] : [before.x, before.y];
  }

  #open(door) {
    door.open = true;
    this.world.pendingDoors.push(door);
  }

  #board(h, car) {
    h.vehicle = car;
    (car.crew ??= []).push(h);
    h.x = car.x;
    h.y = car.y;
  }

  /** Out of the car, beside it (or right where it is if every side's blocked). */
  #leaveCar(h, place = true) {
    const v = h.vehicle;
    h.vehicle = null;
    if (v?.crew) v.crew = v.crew.filter((x) => x !== h);
    if (!place || !v) return;
    const { length, width } = v.stats;
    const cos = Math.cos(v.angle), sin = Math.sin(v.angle);
    const side = width / 2 + h.radius + 10, end = length / 2 + h.radius + 10;
    for (const [ox, oy] of [[-end * 0.4, side], [-end * 0.4, -side], [-end, 0], [end, 0]]) {
      const x = v.x + cos * ox - sin * oy, y = v.y + sin * ox + cos * oy;
      if (this.world.isBlocked(x, y, h.radius) || this.world.isSwimming(x, y)) continue;
      h.x = x;
      h.y = y;
      return;
    }
  }

  #bossOnline(h) {
    for (const p of this.world.players.values()) if (p.account === h.employer) return true;
    return false;
  }

  /** Turn up again near the boss (behind them, or by their car), somewhere clear. */
  #catchUp(h, boss) {
    const at = boss.vehicle ?? boss;
    for (let i = 0; i < 12; i++) {
      const a = (boss.vehicle ? Math.random() * Math.PI * 2 : (boss.input?.angle ?? 0) + Math.PI) + (Math.random() - 0.5) * 2;
      const x = at.x + Math.cos(a) * (140 + i * 15), y = at.y + Math.sin(a) * (140 + i * 15);
      if (this.world.isBlocked(x, y, h.radius + 4) || this.world.isSwimming(x, y)) continue;
      h.x = x;
      h.y = y;
      return;
    }
  }

  /** A free spot inside building b, a little apart from the other guards there. */
  #spotInside(b) {
    const taken = this.list.filter((h) => h.post === b).map((h) => h.home);
    const r = config.hires.radius + 16;
    let best = null;
    for (let x = b.x + r; x < b.x + b.w - r; x += 20) {
      for (let y = b.y + r; y < b.y + b.h - r; y += 20) {
        if (this.world.isBlocked(x, y, config.hires.radius + 4)) continue;
        const apart = Math.min(Infinity, ...taken.map((t) => Math.hypot(t.x - x, t.y - y)));
        const score = Math.min(apart, 120) - Math.hypot(x - (b.x + b.w / 2), y - (b.y + b.h / 2)) * 0.2;
        if (!best || score > best.score) best = { x, y, score };
      }
    }
    return best ? { x: best.x, y: best.y } : { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  /** Just inside the bar's front door (they were at a table). */
  #besideBar(p) {
    const d = this.bar?.doors.find((x) => x.exterior);
    if (!d) return { x: p.x, y: p.y + 50 };
    for (const along of [0, 40, -40]) {
      const x = d.x + d.w / 2 - d.nx * 50 + d.ny * along, y = d.y + d.h / 2 - d.ny * 50 + d.nx * along;
      if (!this.world.isBlocked(x, y, config.hires.radius + 4)) return { x, y };
    }
    return { x: p.x, y: p.y + 50 };
  }

  /** Somewhere clear a fair way from `t` (and out of its line of sight if possible) to start the hunt. */
  #lurkNear(t) {
    const w = this.world;
    const cx = t.vehicle ? t.vehicle.x : t.x, cy = t.vehicle ? t.vehicle.y : t.y;
    let fallback = null;
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, dist = 1100 + Math.random() * 500;
      const x = cx + Math.cos(a) * dist, y = cy + Math.sin(a) * dist;
      if (x < 50 || y < 50 || x > w.width - 50 || y > w.height - 50) continue;
      if (w.isBlocked(x, y, config.hires.radius + 4) || w.isSwimming(x, y)) continue;
      fallback ??= { x, y };
      if (!w.lineOfSight(cx, cy, x, y)) return { x, y };
    }
    return fallback ?? { x: cx + 1200, y: cy };
  }

  // ---- gangsters ---------------------------------------------------------------------------

  /** A new gangster, somewhere along a road out of sight of everyone. Returns false if there's nowhere. */
  #spawnGangster() {
    const w = this.world, g = config.gangsters;
    for (let i = 0; i < 60 && w.roads.length; i++) {
      const road = w.roads[Math.floor(Math.random() * w.roads.length)];
      const x = road.x + Math.random() * road.w, y = road.y + Math.random() * road.h;
      if (w.isBlocked(x, y, 22) || w.isSwimming(x, y)) continue;
      if ([...w.players.values()].some((p) => Math.hypot(p.x - x, p.y - y) < 900)) continue;
      const r = config.hires;
      const lonely = this.list.find((o) => o.role === 'gangster' && !this.#partner(o)); // they go about in pairs
      const g2 = {
        kind: 'hire', role: 'gangster', id: this.nextId++, employer: null, name: 'a gangster',
        x, y, angle: 0, health: g.health, maxHealth: g.health, radius: r.radius,
        weapon: g.weapon, fireCooldown: 0, ammo: config.weapons[g.weapon].magazineSize, reload: 0,
        vehicle: null, alive: true, wanted: 0, lastSeen: 0, hidden: null, jailed: null, shotPolice: false,
        foes: new Map(), offline: 0, pick: null, route: [], seen: new Map(), cash: 0, nextTheft: 0, look: 0, partner: null,
      };
      if (lonely) { // a mate for the one on his own (starting out together, or turning up to join him)
        g2.partner = lonely;
        lonely.partner = g2;
        if (!this.started) Object.assign(g2, { x: lonely.x + 50, y: lonely.y });
      }
      this.list.push(g2);
      return true;
    }
    return false;
  }

  /** His mate, if he has one still about. */
  #partner(h) {
    const m = h.partner;
    return m && this.list.includes(m) ? m : null;
  }

  /** A gangster's turn: a fight if anyone's after him (or his mate); else a hold-up or a stolen car under way; else looking for trouble while he walks the town. The second of a pair just sticks with the first. */
  #gangster(h, dt) {
    const g = config.gangsters, w = this.world;
    h.aiming = false;
    const mate = this.#partner(h);
    const threat = this.#threat(h, null, g.fightRange) ?? (mate ? this.#threat(mate, null, g.fightRange) : null); // (a fight with one is a fight with both)
    if (threat) {
      if (h.holdup?.p) h.holdup.p.heldUp = null;
      h.holdup = null;
      if (h.vehicle) h.vehicle.stolenBy === h ? this.#dumpCar(h) : this.#leaveCar(h);
      return this.#fightThreat(h, threat, dt, 220);
    }
    if (mate && mate.id < h.id) return this.#tagAlong(h, mate, dt);
    if (h.vehicle) return this.#joyride(h, dt);
    if (h.holdup) return this.#holdUp(h, dt);
    if (h.stealing) return this.#goSteal(h, dt);
    // Looking around (now and then): someone to rob, a car to take.
    if ((h.look -= dt) <= 0) {
      h.look = 0.5;
      for (const p of w.players.values()) {
        if (!p.alive || p.vehicle || p.hidden || p.jailed || p.heldUp) continue;
        if ((h.seen.get(p) ?? -Infinity) > this.time) continue;
        if (Math.hypot(p.x - h.x, p.y - h.y) > g.sight || !w.lineOfSight(h.x, h.y, p.x, p.y)) continue;
        h.seen.set(p, this.time + g.playerCooldownSec); // sized up: once in a while
        if (Math.random() < g.robChance && p.cash > 0) {
          h.holdup = { p, started: false };
          h.route = [];
          return;
        }
      }
      if (this.time >= h.nextTheft) {
        for (const v of w.vehicles.values()) {
          if (!v.owner?.id || v.hitman || v.police || v.driver || v.passenger || v.stolenBy) continue;
          if (Math.hypot(v.x - h.x, v.y - h.y) > g.sight || !w.lineOfSight(h.x, h.y, v.x, v.y)) continue;
          const owner = [...w.players.values()].find((p) => p.account === v.owner);
          if (owner && Math.hypot((owner.vehicle ?? owner).x - v.x, (owner.vehicle ?? owner).y - v.y) < g.ownerAwayRange) continue; // they're right there
          h.stealing = v;
          h.nextTheft = this.time + g.theftCooldownSec;
          h.route = [];
          return;
        }
      }
    }
    this.#wander(h, dt);
  }

  /** The second of a pair: rides along in his mate's stolen car, covers his hold-ups, otherwise walks at his shoulder. */
  #tagAlong(h, lead, dt) {
    const car = lead.vehicle;
    if (h.vehicle && h.vehicle !== car) this.#leaveCar(h); // the car's been dumped: out
    if (h.vehicle) { h.x = h.vehicle.x; h.y = h.vehicle.y; return; }
    if (car) {
      if (Math.hypot(car.x - h.x, car.y - h.y) < car.stats.length / 2 + 40) return this.#board(h, car);
      return this.#walk(h, car.x, car.y, config.hires.runSpeed, dt, car);
    }
    const victim = lead.holdup?.started ? lead.holdup.p : null;
    if (victim) { // rifle on them too
      h.angle = Math.atan2(victim.y - h.y, victim.x - h.x);
      h.aiming = true;
      return;
    }
    const d = Math.hypot(lead.x - h.x, lead.y - h.y);
    if (d > 60) this.#walk(h, lead.x - Math.cos(lead.angle) * 40, lead.y - Math.sin(lead.angle) * 40, d > 90 ? config.hires.runSpeed : config.gangsters.walkSpeed, dt); // (jogs to catch up)
    else h.angle = lead.angle;
  }

  /** Walk the town: from road to road, somewhere new each time. */
  #wander(h, dt) {
    const graph = this.world.townsfolk.graph;
    if (!h.route.length) {
      const near = graph.nodes.filter((n) => Math.hypot(n.x - h.x, n.y - h.y) < 1800);
      const node = near[Math.floor(Math.random() * near.length)];
      if (!node) return;
      h.route = graph.route({ x: h.x, y: h.y }, node);
    }
    const next = h.route[0];
    if (Math.hypot(next.x - h.x, next.y - h.y) < 30) return void h.route.shift();
    this.#walk(h, next.x, next.y, config.gangsters.walkSpeed, dt);
  }

  /** Walk up, rifle raised: hands up and stand still for holdupSec and they take your cash; run or shoot and it's a fight. */
  #holdUp(h, dt) {
    const g = config.gangsters, hu = h.holdup, p = hu.p;
    const end = () => { p.heldUp = null; h.holdup = null; };
    if (!p.alive || p.vehicle || p.hidden || p.jailed) return end();
    const d = Math.hypot(p.x - h.x, p.y - h.y);
    h.angle = Math.atan2(p.y - h.y, p.x - h.x);
    h.aiming = true;
    if (!hu.started) {
      if (d > g.sight * 1.5) return end(); // got away before he got there
      if (d > g.holdupRange) return this.#walk(h, p.x, p.y, config.hires.runSpeed, dt);
      Object.assign(hu, { started: true, at: { x: p.x, y: p.y }, left: g.holdupSec });
      p.heldUp = { by: h, left: g.holdupSec, of: g.holdupSec };
      (p.foes ??= new Map()).set(h, this.time + config.hires.foeSec); // (your goons, if any, see the threat)
      this.events.push({ player: p, kind: 'holdup', sec: g.holdupSec });
      return;
    }
    hu.left -= dt;
    p.heldUp.left = hu.left;
    const ran = Math.hypot(p.x - hu.at.x, p.y - hu.at.y) > g.holdupMove || d > g.holdupRange * 2;
    const drew = p.input?.fire && p.weapon && !config.weapons[p.weapon.type]?.melee;
    if (ran || drew) { // resisting: he opens fire
      end();
      this.noteAttack(p, h);
      this.events.push({ player: p, kind: 'holdup_resisted' });
      return;
    }
    if (hu.left > 0) return;
    const take = Math.floor(p.cash * g.take);
    p.cash -= take;
    h.cash += take;
    end();
    this.world.police.crime(h, 'mugging'); // (if anyone saw)
    this.events.push({ player: p, kind: 'held_up', amount: take });
    h.route = [];
  }

  /** Off to a parked car to steal it; in, and away. */
  #goSteal(h, dt) {
    const w = this.world, v = h.stealing;
    if (!w.vehicles.has(v.id) || v.driver || v.passenger || v.stolenBy) return void (h.stealing = null);
    const d = Math.hypot(v.x - h.x, v.y - h.y);
    if (d > v.stats.length / 2 + 40) return this.#walk(h, v.x, v.y, config.hires.runSpeed, dt, v);
    h.stealing = null;
    v.stolenBy = h;
    v.picked = false;
    this.#board(h, v);
    const graph = w.townsfolk.graph;
    const far = graph.nodes.filter((n) => Math.hypot(n.x - v.x, n.y - v.y) > 1500);
    const dest = far[Math.floor(Math.random() * far.length)];
    h.joy = { until: this.time + config.gangsters.joyrideSec[0] + Math.random() * (config.gangsters.joyrideSec[1] - config.gangsters.joyrideSec[0]), stuck: 0, reverse: 0 };
    h.route = dest && graph.nodes.length ? graph.route({ x: v.x, y: v.y }, dest) : [];
    w.police.crime(h, 'steal_car'); // (if anyone saw)
    const owner = [...w.players.values()].find((p) => p.account === v.owner);
    if (owner) this.events.push({ player: owner, kind: 'car_stolen', type: v.type });
  }

  /** Driving the stolen car off across town; after a while (or at the end of the road) he parks it and walks away. */
  #joyride(h, dt) {
    const car = h.vehicle, j = h.joy;
    if (!this.world.vehicles.has(car.id)) { this.#leaveCar(h, false); return; }
    h.x = car.x;
    h.y = car.y;
    if (this.time > j.until || !h.route.length) {
      const forward = vehicleMotion(car).forward;
      car.ai = { gas: Math.abs(forward) > 30 ? -Math.sign(forward) : 0, steer: 0, drift: false };
      if (car.speed < 40) this.#dumpCar(h);
      return;
    }
    if (car.fuel <= 0) return this.#dumpCar(h); // out of petrol: he ditches it where it is
    const partner = this.#partner(h);
    if (partner && !partner.vehicle && Math.hypot(partner.x - car.x, partner.y - car.y) < 500 && (j.waited = (j.waited ?? 0) + dt) < 8) { // waiting for his mate to get in
      const fw = vehicleMotion(car).forward;
      car.ai = { gas: Math.abs(fw) > 20 ? -Math.sign(fw) : 0, steer: 0, drift: false };
      return;
    }
    const next = h.route[0];
    if (Math.hypot(next.x - car.x, next.y - car.y) < 110) h.route.shift();
    const forward = vehicleMotion(car).forward;
    const diff = Math.atan2(Math.sin(Math.atan2(next.y - car.y, next.x - car.x) - car.angle), Math.cos(Math.atan2(next.y - car.y, next.x - car.x) - car.angle));
    if (j.reverse > 0) {
      j.reverse -= dt;
      car.ai = { gas: -1, steer: -Math.sign(diff) || 1, drift: false };
      return;
    }
    j.stuck = Math.abs(forward) < 20 ? j.stuck + dt : 0;
    if (j.stuck > 1.2) { j.stuck = 0; j.reverse = 0.9; }
    car.ai = { gas: Math.abs(diff) > 1.2 && forward > 150 ? -0.6 : 0.7, steer: Math.max(-1, Math.min(1, diff * 2.2)), drift: false };
  }

  /** Done with the stolen car (or it's out of petrol): leave it where it is; its owner hears where. */
  #dumpCar(h) {
    const car = h.vehicle;
    car.ai = null;
    car.stolenBy = null;
    this.#leaveCar(h);
    const mate = this.#partner(h);
    if (mate?.vehicle === car) this.#leaveCar(mate);
    h.route = [];
    const owner = [...this.world.players.values()].find((p) => p.account === car.owner);
    if (owner) this.events.push({ player: owner, kind: 'car_dumped', x: Math.round(car.x), y: Math.round(car.y), type: car.type, id: car.id });
  }

  /** The gangster `id`, if he's near p and not at war with them. */
  gangsterFor(p, id) {
    const h = this.list.find((x) => x.id === id && x.role === 'gangster');
    if (!h || h.vehicle || Math.hypot(h.x - p.x, h.y - p.y) > config.gangsters.tradeReach + p.radius + h.radius) return null;
    return h;
  }

  /** Sell a gangster all the vodka you've got on you (and in your car): vodkaPrice × base a bottle. */
  sellVodka(p, id) {
    const h = this.gangsterFor(p, id);
    if (!h) return 'too_far';
    if (this.#isFoe(h, p) || h.holdup) return 'gangster_hostile';
    const holder = this.world.economy.cargoOf(p);
    const sold = {};
    let total = 0;
    for (const good of Object.keys(config.economy.visions)) {
      const qty = holder.count(good);
      if (!qty) continue;
      holder.add(good, -qty);
      sold[good] = qty;
      total += qty * Math.round(config.goods[good].base * config.gangsters.vodkaPrice);
    }
    if (!total) return 'no_vodka';
    p.cash += total;
    return { sold, total };
  }

  /** Snapshot rows for hires on foot near (x, y): [id, x, y, angle, role (0 goon, 1 guard, 2 hitman, 3 gangster), mine, health %, aiming]. */
  visible(x, y, range, viewer) {
    const out = [];
    for (const h of this.list) {
      if (h.vehicle || Math.abs(h.x - x) > range || Math.abs(h.y - y) > range) continue;
      out.push([h.id, Math.round(h.x), Math.round(h.y), Math.round(h.angle * 100) / 100, ALL_ROLES.indexOf(h.role), viewer && h.employer && h.employer === viewer ? 1 : 0, Math.round((h.health / h.maxHealth) * 100), h.aiming ? 1 : 0]);
    }
    return out;
  }
}

// How their bodies look (indexes into config.looks: skin, shirt, pants, hat).
const LOOKS = { goon: [2, 1, 1, 5], guard: [1, 0, 1, 4], hitman: [0, 0, 0, 3], gangster: [1, 0, 0, 3] };
