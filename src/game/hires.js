import { config } from '../config.js';
import { isCop } from './police.js';
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
const STATE = ['governor', 'govguard', 'inspector']; // the governor's household (employer null, side 'state')
const ALL_ROLES = [...ROLES, 'gangster', ...STATE]; // (gangsters work for nobody: employer null)
const CREW = ['goon', 'guard']; // the hires that stay yours (saved with your account) until you fire them
const POST_NAMES = { house: 'House', cabin: 'Cabin', mansion: 'Mansion', panelka: 'Panelka', garages: 'Lock-up garages', garage: 'Garage' };
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
    this.away = []; // goons and guards put away: { id, role, employer, mode, postRef } (still on the books, at awayPerDay)
    this.restored = new Set(); // account ids whose saved crew is already back (once a session)
    this.online = null; // (account) => still connected (dead or alive), set by the room
    this.lastDay = null;
    this.vodkaSales = new Map(); // 'gangster id:account (or player) id' → when they last sold him vodka
    for (let i = 0; i < config.gangsters.count; i++) this.#spawnGangster();
    // The governor's household, at his residence (if the map has one).
    this.residence = world.buildings.find((b) => b.type === 'governor' && b.spots) ?? null;
    this.stateTimers = []; // [role, index, seconds] until a killed member of the household is replaced
    this.inspections = []; // visits the inspector has still to make: { account, reason }
    this.watch = new Map(); // account -> { day, abandoned, flagged: Set } (what the inspector keeps an eye on)
    if (this.residence) {
      this.#spawnState('governor', 0);
      this.residence.spots.guards.forEach((_, i) => this.#spawnState('govguard', i));
      this.#spawnState('inspector', 0);
    }
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
    if (a.side === 'state' && b.side === 'state') return true;
    if (a.role === 'hitman' || b.role === 'hitman') return false; // a hitman spares only whoever hired him
    const pa = a.kind === 'hire' ? this.bossOf(a) : a;
    const pb = b.kind === 'hire' ? this.bossOf(b) : b;
    return Boolean(pa?.kind === 'player' && pb?.kind === 'player' && this.world.areTeammates(pa, pb));
  }

  /** `attacker` hurt `victim`: each is fair game for the other's side for a while. */
  noteAttack(attacker, victim) {
    if (!attacker || !victim || attacker === victim) return;
    if (victim.side === 'state' && attacker.side !== 'state') { // hurt one of the governor's people: all of them come for you
      for (const h of this.list) if (h.side === 'state' && h !== victim) this.#foe(h, attacker);
    }
    const until = this.time + config.hires.foeSec;
    for (const [a, b] of [[attacker, victim], [victim, attacker]]) {
      if (a.kind !== 'player' && a.kind !== 'hire') continue;
      a.foes ??= new Map();
      if (a.foes.size > 8) for (const [k, t] of a.foes) if (t < this.time) a.foes.delete(k);
      a.foes.set(b, until);
    }
  }

  #foe(a, b) {
    a.foes ??= new Map();
    a.foes.set(b, this.time + config.hires.foeSec);
  }

  #isFoe(of, x) {
    return (of?.foes?.get(x) ?? -Infinity) >= this.time;
  }

  // ---- the barman -----------------------------------------------------------------------

  atBar(p) {
    const n = this.bar?.npc;
    return Boolean(n && !p.vehicle && Math.hypot(n.x - p.x, n.y - p.y) < config.hires.reach + p.radius);
  }

  /**
   * Buildings `account` can post a guard in: their home, the homes they've bought and their warehouses.
   * `ref` names the post so it survives a restart (the map's new): the starter home, a bought home by
   * type (one of each), a warehouse by size and which of theirs of that size.
   */
  posts(account) {
    const out = [];
    if (!account) return out;
    const homes = this.world.homes;
    const home = homes.homeOf(account);
    if (home) out.push({ id: home.id, label: 'Your home', ref: { kind: 'home' } });
    for (const b of homes.boughtBy(account)) out.push({ id: b.id, label: POST_NAMES[b.type] ?? 'Home', ref: { kind: 'own', type: b.type } });
    const n = {};
    for (const w of [...this.world.warehouses.all.values()].sort((a, b) => a.id - b.id)) {
      if (!w.owner || w.owner !== account) continue;
      n[w.size] = (n[w.size] ?? 0) + 1;
      out.push({ id: w.id, label: `${config.warehouses.sizes[w.size]?.name ?? 'Warehouse'}${n[w.size] > 1 ? ` ${n[w.size]}` : ''}`, ref: { kind: 'wh', size: w.size, n: n[w.size] } });
    }
    return out;
  }

  /** The post `ref` names, among account's buildings now: { id, label, ref } or null. */
  #resolvePost(account, ref) {
    if (!ref) return null;
    return this.posts(account).find((x) => x.ref.kind === ref.kind && x.ref.type === ref.type && x.ref.size === ref.size && x.ref.n === ref.n) ?? null;
  }

  /** Hire a goon, a guard (post: building id) or a hitman (target: player id). Returns an error code or null. */
  hire(p, role, { post = 0, target = 0 } = {}) {
    if (!ROLES.includes(role)) return 'unknown';
    if (!this.atBar(p)) return 'too_far';
    if (!p.account) return 'no_account';
    const rule = config.hires[role];
    if (this.mine(p.account).filter((h) => h.role === role).length + this.away.filter((a) => a.employer === p.account && a.role === role).length >= rule.max) return 'hire_limit'; // (put-away ones count)
    if (p.account.bank < rule.fee) return 'not_enough_bank';
    let at = null;
    let extra = {};
    if (role === 'guard') {
      const spot = this.posts(p.account).find((x) => x.id === post);
      if (!spot) return 'not_your_building';
      const b = this.world.buildings[post - 1];
      at = this.#spotInside(b);
      extra = { post: b, home: at, postRef: spot.ref };
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
    this.#add(role, p.account, at, CREW.includes(role) ? { mode: 'follow', ...extra } : extra);
    if (CREW.includes(role)) this.onCrewChange?.(p.account);
    return null;
  }

  #add(role, account, at, extra = {}) {
    const r = config.hires;
    const rule = r[role];
    const h = {
      kind: 'hire', role, id: this.nextId++, employer: account, name: role === 'hitman' ? 'a hitman' : `${account.name}'s ${rule.name.toLowerCase()}`,
      x: at.x, y: at.y, angle: 0, health: r.health, maxHealth: r.health, radius: r.radius,
      weapon: rule.weapon ?? r.weapon, fireCooldown: 0, ammo: config.weapons[rule.weapon ?? r.weapon].magazineSize, reload: 0,
      vehicle: null, alive: true, wanted: 0, lastSeen: 0, hidden: null, jailed: null, shotPolice: false,
      foes: new Map(), offline: 0, pick: null, ...extra,
    };
    this.list.push(h);
    return h;
  }

  /** Let one of your hires go (no refund). */
  dismiss(p, id) {
    const h = this.list.find((x) => x.id === id && x.employer === p.account);
    if (!h) return 'unknown';
    this.#remove(h);
    return null;
  }

  // ---- the clipboard: your goons and guards ---------------------------------------------------

  /** Off the map but still on the books (at awayPerDay): the clipboard, logging off, a goon whose boss died. */
  #putAway(h) {
    this.away.push({ id: this.nextId++, role: h.role, employer: h.employer, mode: h.mode ?? 'follow', postRef: h.postRef ?? null });
    this.#remove(h); // (and saved: onCrewChange)
  }

  /** Back out of the way: a goon by you, a guard at his post. Returns the hire, or an error code. */
  #bringOut(a, boss) {
    let at, extra = { mode: a.role === 'goon' ? 'follow' : a.mode, postRef: a.postRef };
    if (a.role === 'guard') {
      const spot = this.#resolvePost(a.employer, a.postRef);
      if (!spot) return 'no_post';
      const b = this.world.buildings[spot.id - 1];
      at = this.#spotInside(b);
      Object.assign(extra, { post: b, home: at });
    } else {
      if (!boss) return 'not_now';
      at = { x: boss.x, y: boss.y };
    }
    this.away.splice(this.away.indexOf(a), 1);
    const h = this.#add(a.role, a.employer, at, extra);
    if (a.role === 'goon') this.#catchUp(h, boss);
    return h;
  }

  /**
   * The clipboard: `action` on your goon or guard `id` — 'away' (put away), 'out' (bring back out),
   * 'fire', 'mode' (a goon: 'follow' you, or 'wait' where he stands), 'post' (a guard: building `post`).
   */
  crew(p, { action, id, mode, post } = {}) {
    const account = p.account;
    if (!account) return 'no_account';
    const h = this.list.find((x) => x.id === id && x.employer === account && CREW.includes(x.role));
    const a = h ? null : this.away.find((x) => x.id === id && x.employer === account);
    if (!h && !a) return 'unknown';
    if (action === 'away') {
      if (!h) return 'already_away';
      this.#putAway(h);
    } else if (action === 'out') {
      if (!a) return 'already_out';
      if (!p.alive) return 'not_now';
      const out = this.#bringOut(a, p);
      if (typeof out === 'string') return out;
    } else if (action === 'fire') {
      if (h) this.#remove(h);
      else this.away.splice(this.away.indexOf(a), 1);
    } else if (action === 'mode') {
      const it = h ?? a;
      if (it.role !== 'goon' || (mode !== 'follow' && mode !== 'wait')) return 'unknown';
      it.mode = mode;
      if (h && mode === 'wait') {
        if (h.vehicle) this.#leaveCar(h);
        h.waitAt = { x: h.x, y: h.y };
      }
    } else if (action === 'post') {
      const it = h ?? a;
      if (it.role !== 'guard') return 'unknown';
      const spot = this.posts(account).find((x) => x.id === post);
      if (!spot) return 'not_your_building';
      it.postRef = spot.ref;
      if (h) { // he goes straight over
        h.post = this.world.buildings[spot.id - 1];
        h.home = this.#spotInside(h.post);
        Object.assign(h, { x: h.home.x, y: h.home.y });
      }
    } else return 'unknown';
    this.onCrewChange?.(account);
    return null;
  }

  /** The clipboard's list for account: [id, role, out (1/0), mode, post building id (0: none here now), health, max health]. */
  roster(account) {
    if (!account) return [];
    return [
      ...this.list.filter((h) => h.employer === account && CREW.includes(h.role)).map((h) => [h.id, h.role, 1, h.mode ?? 'follow', h.post?.id ?? 0, Math.ceil(h.health), h.maxHealth]),
      ...this.away.filter((a) => a.employer === account).map((a) => [a.id, a.role, 0, a.mode, this.#resolvePost(account, a.postRef)?.id ?? 0, 0, 0]),
    ];
  }

  /** Account's goons and guards, for saving: [{ role, mode, post, out }]. */
  crewSave(account) {
    return [
      ...this.list.filter((h) => h.employer === account && CREW.includes(h.role)).map((h) => ({ role: h.role, mode: h.mode ?? 'follow', post: h.postRef ?? null, out: 1 })),
      ...this.away.filter((a) => a.employer === account).map((a) => ({ role: a.role, mode: a.mode, post: a.postRef, out: 0 })),
    ];
  }

  /** Logged in (once a session): their saved goons and guards — those out when they left come back out (a guard whose post isn't on the map yet waits, put away). */
  restore(p, saved) {
    const account = p.account;
    if (!account?.id || this.restored.has(account.id)) return;
    this.restored.add(account.id);
    if (this.list.some((h) => h.employer === account && CREW.includes(h.role)) || this.away.some((a) => a.employer === account)) return; // (never lost them)
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!CREW.includes(s?.role)) continue;
      const a = { id: this.nextId++, role: s.role, employer: account, mode: s.mode === 'wait' ? 'wait' : 'follow', postRef: s.post ?? null };
      this.away.push(a);
      if (s.out) this.#bringOut(a, p);
    }
  }

  /** Logged off: their goons and guards are put away; returns them for saving, and they're off the books here until they're back. */
  unload(account) {
    if (!account) return null;
    const saved = this.crewSave(account); // (who's out now comes back out when they log in)
    for (const h of this.list.filter((x) => x.employer === account && CREW.includes(x.role))) this.#putAway(h);
    this.away = this.away.filter((a) => a.employer !== account);
    if (account.id) this.restored.delete(account.id);
    return saved;
  }

  /** Dawn: put-away goons and guards cost awayPerDay each (can't pay: they quit). */
  #awayPay() {
    const byEmployer = new Map();
    for (const a of this.away) byEmployer.set(a.employer, [...(byEmployer.get(a.employer) ?? []), a]);
    for (const [account, list] of byEmployer) {
      const due = list.length * config.hires.awayPerDay;
      if (account.bank >= due) {
        account.bank -= due;
        this.world.onBankChange?.(account);
        continue;
      }
      this.away = this.away.filter((a) => a.employer !== account);
      const boss = [...this.world.players.values()].find((o) => o.account === account);
      if (boss) for (const a of list) this.events.push({ player: boss, kind: 'hire_quit', role: a.role });
      this.onCrewChange?.(account);
    }
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
      posts: this.posts(p.account).map(({ id, label }) => ({ id, label })),
      targets: [...this.world.players.values()].filter((o) => o !== p && o.alive && !(o.account && o.account === p.account)).map((o) => ({ id: o.id, name: o.name })),
    };
  }

  // ---- getting hurt ------------------------------------------------------------------------

  /** The hire (on foot) a bullet path a→b of radius r hits, other than the shooter's own side. */
  hitBy(ax, ay, bx, by, r, segmentDistSq, shooter) {
    for (const h of this.list) {
      if (h.vehicle || h === shooter) continue;
      if (shooter && (shooter.kind === 'player' || shooter.kind === 'hire') && h.employer && h.employer === (shooter.employer ?? shooter.account)) continue; // no shooting your own
      if (h.role === 'gangster' && (shooter?.role === 'gangster' || shooter?.kind === 'officer')) continue;
      if (h.side === 'state' && (shooter?.side === 'state' || shooter?.kind === 'officer')) continue; // (the Militsiya and the governor's people are on the same side) // (nor your own crew; and the Militsiya leave gangsters be)
      if (segmentDistSq(ax, ay, bx, by, h.x, h.y) < (h.radius + r) ** 2) return h;
    }
    return null;
  }

  /** Hurt hire h (armour soaks up part of it). Returns true if it killed them. */
  damage(h, amount, attacker) {
    if (!this.list.includes(h)) return false;
    h.health -= amount * (1 - (h.role === 'gangster' ? config.gangsters.armor : h.side === 'state' ? config.governor[h.role].armor : config.hires.armor));
    if (attacker) this.noteAttack(attacker, h);
    if ((attacker?.kind === 'player' || attacker?.kind === 'hire') && attacker.side !== 'state') this.world.police.crime(attacker, h.health <= 0 ? 'murder' : 'assault');
    if (h.health > 0) return false;
    const items = [{ type: h.weapon, ammo: h.ammo, reloadTimer: 0 }];
    if (h.role === 'govguard') items.push({ type: 'bunkerkey', tool: true }); // each of the governor's guards carries a key to a bunker trapdoor
    if (h.oil && h.role === 'inspector') items.push({ type: 'cellkey', tool: true }); // the overseer: the key to the oil hall's cells
    this.world.bodies?.add({ x: h.x, y: h.y, angle: h.angle, kind: 'npc', look: LOOKS[h.role], items, cash: h.cash ?? 0, killer: attacker?.kind === 'player' ? attacker : null });
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
    if (CREW.includes(h.role) && h.employer) this.onCrewChange?.(h.employer); // (their clipboard is saved)
    if (h.side === 'state' && !h.oil) { // (the oil hall's: see OilHall)
      this.stateTimers.push([h.role, h.slot ?? 0, config.governor.respawnSec]); // someone new, in a while
      if (h.role === 'inspector' && h.task && !h.task.fined) this.inspections.unshift({ account: h.task.account, reason: h.task.reason, warehouse: h.task.spot?.warehouse }); // (his successor makes the visit)
      if (h.vehicle) { h.vehicle.ai = null; }
    }
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
    const day = this.world.dayNumber;
    if (day !== undefined && day !== null) {
      if (this.lastDay !== null && day !== this.lastDay) this.#awayPay();
      this.lastDay = day;
    }
    for (let i = this.gangsterTimers.length - 1; i >= 0; i--) if ((this.gangsterTimers[i] -= dt) <= 0 && this.#spawnGangster()) this.gangsterTimers.splice(i, 1);
    for (let i = this.stateTimers.length - 1; i >= 0; i--) if ((this.stateTimers[i][2] -= dt) <= 0) { this.#spawnState(this.stateTimers[i][0], this.stateTimers[i][1]); this.stateTimers.splice(i, 1); }
    for (const h of [...this.list]) {
      if (!this.list.includes(h)) continue;
      if (h.jailed) continue;
      if (h.role !== 'gangster' && h.side !== 'state') h.health = Math.min(h.maxHealth, h.health + config.hires.regenPerSec * dt); // (gangsters don't heal)
      h.fireCooldown = Math.max(0, h.fireCooldown - dt);
      if (h.reload > 0 && (h.reload -= dt) <= 0) h.ammo = config.weapons[h.weapon].magazineSize;
      if (h.role === 'goon') this.#goon(h, dt);
      else if (h.role === 'guard') this.#guard(h, dt);
      else if (h.role === 'gangster') this.#gangster(h, dt);
      else if (h.oil) this.#oilWatch(h, dt);
      else if (h.role === 'governor') this.#governor(h, dt);
      else if (h.role === 'govguard') this.#govGuard(h, dt);
      else if (h.role === 'inspector') this.#inspector(h, dt);
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
      // The boss died: his goons are put away (on the clipboard, to bring back out). Left: wait about, then the same.
      if (h.vehicle) this.#leaveCar(h);
      if ((this.online?.(h.employer) ?? this.#bossOnline(h)) || (h.offline += dt) > r.goonOfflineSec) this.#putAway(h); // (online: the room knows who's connected, dead or alive)
      return;
    }
    h.offline = 0;
    if (h.mode === 'wait' && h.waitAt) { // told to wait: he holds that spot, and fights for you there
      if (h.vehicle) this.#leaveCar(h);
      const threat = this.#threat(h, boss, r.engageRange);
      if (threat) return this.#fightThreat(h, threat, dt, 260);
      if (Math.hypot(h.waitAt.x - h.x, h.waitAt.y - h.y) > 20) this.#walk(h, h.waitAt.x, h.waitAt.y, r.speed, dt);
      else h.angle += dt * 0.3; // looking about
      return;
    }
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
    // Lost the building (sold it, or it was put away)? Nothing to guard here: he's put away, to post elsewhere.
    if (!this.posts(h.employer).some((x) => x.id === b.id)) {
      this.#tell(h, 'hire_no_post');
      return this.#putAway(h);
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
    if (h.side !== 'state' && (h.nextFireCrime ?? 0) <= this.time) {
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
    this.doorBuildings ??= w.buildings.filter((b) => b.doors.length); // (buildings never change)
    const holder = (x, y) => this.doorBuildings.find((b) => inside(b, x, y));
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

  // ---- the governor's household ---------------------------------------------------------------

  /** The governor, one of his guards (slot: which post) or the inspector, at the residence. */
  #spawnState(role, slot) {
    const b = this.residence, cfg = config.governor[role];
    if (!b) return;
    const at = role === 'governor' ? b.spots.governor[0] : role === 'inspector' ? b.spots.inspector : b.spots.guards[slot];
    const h = {
      kind: 'hire', role, side: 'state', slot, id: this.nextId++, employer: null,
      name: { governor: 'the governor', govguard: "the governor's guard", inspector: 'the tax inspector' }[role],
      x: at.x, y: at.y, angle: at.angle ?? Math.PI / 2, health: cfg.health, maxHealth: cfg.health, radius: cfg.radius,
      weapon: cfg.weapon, fireCooldown: 0, ammo: config.weapons[cfg.weapon].magazineSize, reload: 0,
      vehicle: null, alive: true, wanted: 0, lastSeen: 0, hidden: null, jailed: null, shotPolice: false,
      foes: new Map(), offline: 0, pick: null, route: [], post: at, next: 0, task: null, cash: cfg.cash ?? 0,
    };
    if (role === 'inspector') h.car = this.#officialCar();
    this.list.push(h);
  }

  /**
   * The oil hall's watchers underground: a governor's guard (`govguard`) or the overseer (an `inspector`),
   * on `at`, keeping to `hall` (a rect) and shooting anyone who comes into it. The overseer strolls between
   * `beat` (points along the cells).
   */
  spawnOil(role, at, hall, beat = null) {
    const cfg = config.governor[role];
    this.list.push({
      kind: 'hire', role, side: 'state', oil: true, hall, beat, slot: 0, id: this.nextId++, employer: null,
      name: role === 'inspector' ? 'the overseer' : "the governor's guard",
      x: at.x, y: at.y, angle: at.a ?? 0, health: cfg.health, maxHealth: cfg.health, radius: cfg.radius,
      weapon: cfg.weapon, fireCooldown: 0, ammo: config.weapons[cfg.weapon].magazineSize, reload: 0,
      vehicle: null, alive: true, wanted: 0, lastSeen: 0, hidden: null, jailed: null, shotPolice: false,
      foes: new Map(), offline: 0, pick: null, route: [], post: { x: at.x, y: at.y, angle: at.a }, next: 0, task: null, cash: role === 'inspector' ? 300 : 0,
    });
  }

  /** In the oil hall: anyone in it is shot at (chased a little, never out of the hall); otherwise his post, or the overseer's beat. */
  #oilWatch(h, dt) {
    const c = config.oilHall;
    const threat = this.#threat(h, null, c.fightRange, h.hall);
    if (threat) return this.#fightThreat(h, threat, dt, h.role === 'inspector' ? 0 : 280, h.hall);
    if (h.beat?.length && (h.next -= dt) <= 0) {
      const b = h.beat[Math.floor(Math.random() * h.beat.length)];
      h.post = { x: b.x, y: b.y, angle: h.post.angle };
      h.next = 8 + Math.random() * 10;
    }
    if (Math.hypot(h.post.x - h.x, h.post.y - h.y) > 15) this.#walk(h, h.post.x, h.post.y, config.governor.walkSpeed, dt, null, h.hall);
    else if (h.post.angle !== undefined) h.angle = h.post.angle;
  }

  /** The inspector's black Lada, parked along the front of the residence (a fresh one if his is gone). */
  #officialCar() {
    const w = this.world, at = this.residence.spots.car;
    const v = new Vehicle(w.nextEntityId++, config.governor.car, at.x, at.y, at.angle);
    Object.assign(v, { owner: { id: null, name: null }, color: '#141414', fuel: 100, official: true });
    w.vehicles.set(v.id, v);
    return v;
  }

  /** Someone who's hurt any of the household, near enough to deal with. */
  #stateThreat(h, range) {
    return this.#threat(h, null, range);
  }

  /** The governor: strolls between his study, the hall and the dining room; shoots back if attacked. */
  #governor(h, dt) {
    const threat = this.#stateThreat(h, config.governor.fightRange);
    if (threat) return this.#fightThreat(h, threat, dt, 0);
    if ((h.next -= dt) <= 0) {
      const spots = this.residence.spots.governor;
      h.post = spots[Math.floor(Math.random() * spots.length)];
      h.next = 15 + Math.random() * 25;
    }
    if (Math.hypot(h.post.x - h.x, h.post.y - h.y) > 20) this.#walkState(h, h.post.x, h.post.y, config.governor.walkSpeed, dt);
    else h.angle += dt * 0.2;
  }

  /**
   * Walking about the residence: through the gate, up to the porch, in through the hall and the wing
   * doors (the house's doors are inside the grounds, so plain #walk wouldn't find them).
   */
  #walkState(h, tx, ty, speed, dt, toCar = null) {
    const s = this.residence.spots;
    const level = (x, y) => (inside(s.house, x, y) ? 0 : inside(s.grounds, x, y) ? 1 : 2); // in the house, the grounds, outside
    // Which part of the house: along the line from the west wing's door to the east's (any rotation).
    const ax = s.doorE.x - s.doorW.x, ay = s.doorE.y - s.doorW.y, len = Math.hypot(ax, ay);
    const wing = (x, y) => { const t = ((x - s.doorW.x) * ax + (y - s.doorW.y) * ay) / len; return t < 0 ? 'W' : t > len ? 'E' : 'H'; };
    const from = level(h.x, h.y), to = level(tx, ty);
    const near = (p) => Math.hypot(p.x - h.x, p.y - h.y) < 30;
    // a, then b: once at a (or anywhere past it, nearer b than a is), straight on to b.
    const pair = (a, b) => (Math.hypot(b.x - h.x, b.y - h.y) < Math.hypot(b.x - a.x, b.y - a.y) + 10 ? b : a);
    let via = null;
    if (from < to) via = from === 0 ? (wing(h.x, h.y) !== 'H' && !near(s.doorW) && !near(s.doorE) ? (wing(h.x, h.y) === 'W' ? s.doorW : s.doorE) : pair(s.hall, s.porch)) : pair(s.gateIn, s.gateOut);
    else if (from > to) via = from === 2 ? pair(s.gateOut, s.gateIn) : pair(s.porch, s.hall);
    else if (from === 0 && wing(h.x, h.y) !== wing(tx, ty)) { // across the house: through the wing door
      const [a, b] = [wing(h.x, h.y), wing(tx, ty)];
      const door = a === 'W' || (a === 'H' && b === 'W') ? s.doorW : s.doorE;
      if (a !== 'H' && b !== 'H' && near(door)) via = s.hall;
      else if (!near(door)) via = door;
    }
    if (via) this.#walk(h, via.x, via.y, speed, dt);
    else this.#walk(h, tx, ty, speed, dt, toCar);
  }

  /** A guard: stands at his post by the gate; goes after anyone who's attacked the household, but not far. */
  #govGuard(h, dt) {
    const g = config.governor;
    const threat = this.#stateThreat(h, g.fightRange);
    const fromPost = threat ? Math.hypot((threat.vehicle ?? threat).x - h.post.x, (threat.vehicle ?? threat).y - h.post.y) : 0;
    if (threat && fromPost < g.guardLeash) return this.#fightThreat(h, threat, dt, 240);
    if (threat) return this.#fightThreat(h, threat, dt, 0); // (too far to chase: shoot from where he is)
    if (Math.hypot(h.post.x - h.x, h.post.y - h.y) > 15) this.#walk(h, h.post.x, h.post.y, config.hires.runSpeed * 0.8, dt);
    else h.angle = h.post.angle ?? h.angle;
  }

  // The inspector's rounds. He keeps an eye on everyone's day: abandonLimit delivery jobs dropped and he
  // comes to check one of your factories — a fine and the contraband seized if there's anything illegal in it.

  #watchOf(account) {
    const day = this.world.dayNumber ?? 0;
    let w = this.watch.get(account);
    if (!w || w.day !== day) this.watch.set(account, (w = { day, abandoned: 0, flagged: new Set() }));
    return w;
  }

  /** A delivery job abandoned. */
  noteAbandon(account) {
    if (!account || !this.residence) return;
    const w = this.#watchOf(account);
    if (++w.abandoned >= config.governor.abandonLimit) this.#flag(account, w, 'jobs');
  }

  #flag(account, w, reason) {
    if (w.flagged.has(reason)) return; // (once a day for each)
    w.flagged.add(reason);
    if (![...this.world.warehouses.all.values()].some((x) => x.owner === account)) return; // (no factory to go through)
    this.inspections.push({ account, reason });
    const p = this.#playerOf(account);
    if (p) this.events.push({ player: p, kind: 'inspector_coming', reason, fine: config.governor.fine });
  }

  #playerOf(account) {
    for (const p of this.world.players.values()) if (p.account === account) return p;
    return null;
  }

  /** Where he goes: outside the door of one of account's factories (`warehouse`, or one at random). Null: none. */
  #visitSpot(account, warehouse) {
    const owned = [...this.world.warehouses.all.values()].filter((w) => w.owner === account && (!warehouse || w.id === warehouse));
    const w = owned[Math.floor(Math.random() * owned.length)];
    const b = w && this.world.buildings[w.id - 1];
    const d = b?.doors.find((x) => x.exterior);
    if (!d) return null;
    return { x: d.x + d.w / 2 + d.nx * 70, y: d.y + d.h / 2 + d.ny * 70, building: b, warehouse: w.id };
  }

  /** He goes through the factory: anything illegal and it's the fine, the contraband seized; else nothing. */
  #check(task) {
    task.fined = true;
    const wh = this.world.warehouses.all.get(task.spot?.warehouse);
    const acc = task.account;
    const p = this.#playerOf(acc);
    if (!wh || wh.owner !== acc || !wh.hasIllegal()) {
      if (p) this.events.push({ player: p, kind: 'inspector_clean', reason: task.reason, post: task.post ?? false });
      return;
    }
    const seized = wh.raid();
    const amount = config.governor.fine;
    const fromBank = Math.min(amount, Math.max(0, acc.bank));
    acc.bank -= fromBank;
    this.world.onBankChange?.(acc);
    let fromCash = 0;
    if (p && fromBank < amount) {
      fromCash = Math.min(amount - fromBank, p.cash);
      p.cash -= fromCash;
    }
    this.world.warehouses.changed = true;
    if (p) this.events.push({ player: p, kind: 'inspector_fined', amount: fromBank + fromCash, reason: task.reason, post: task.post ?? false, seized });
  }

  #inspector(h, dt) {
    const g = config.governor;
    if (!h.car || !this.world.vehicles.has(h.car.id)) h.car = null;
    const threat = this.#stateThreat(h, g.fightRange);
    if (threat) {
      if (h.vehicle) { h.vehicle.ai = null; this.#leaveCar(h); }
      return this.#fightThreat(h, threat, dt, 200);
    }
    if (!h.task) {
      const next = this.inspections.shift();
      if (next) {
        const spot = this.#visitSpot(next.account, next.warehouse);
        h.task = spot ? { ...next, spot, stage: 'out', started: this.time, wait: 0 } : null; // (no factory: nothing to inspect)
      }
    }
    const t = h.task;
    if (!t) return this.#goHome(h, dt);
    if (this.time - t.started > g.tripSec) { // stuck: he goes through the books instead, and it comes in the post
      t.post = true;
      if (!t.fined) this.#check(t);
      h.task = null;
      return this.#teleportHome(h);
    }
    const home = this.residence.spots.car;
    if (t.stage === 'out') { // drive there
      if (this.#drive(h, t, t.spot, dt)) t.stage = 'walk';
      return;
    }
    if (t.stage === 'walk') { // on foot to the door
      if (h.vehicle) { h.vehicle.ai = null; this.#leaveCar(h); }
      if (Math.hypot(t.spot.x - h.x, t.spot.y - h.y) > 40) return this.#walkState(h, t.spot.x, t.spot.y, config.hires.speed, dt);
      this.#check(t);
      t.stage = 'wait';
      t.wait = 3; // writes it up
      return;
    }
    if (t.stage === 'wait') {
      if ((t.wait -= dt) <= 0) { t.stage = 'back'; t.route = null; }
      return;
    }
    if (t.stage === 'back') { // drive home
      if (this.#drive(h, t, home, dt)) { t.stage = 'home'; if (h.vehicle) { h.vehicle.ai = null; this.#leaveCar(h); } }
      return;
    }
    // Home: parked; walk in. (Nobody about: his car's put back square in its spot.)
    if (!this.#goHome(h, dt)) return;
    h.task = null;
    const spot = this.residence.spots.car, car = h.car;
    if (car && !car.driver && !car.passenger && ![...this.world.players.values()].some((p) => Math.hypot(p.x - spot.x, p.y - spot.y) < 1500)) {
      Object.assign(car, { x: spot.x, y: spot.y, angle: spot.angle, vx: 0, vy: 0, ai: null });
    }
  }

  /** Walk back to his desk (true once there). */
  #goHome(h, dt) {
    if (h.vehicle) { h.vehicle.ai = null; this.#leaveCar(h); }
    const at = this.residence.spots.inspector;
    if (Math.hypot(at.x - h.x, at.y - h.y) < 20) return true;
    this.#walkState(h, at.x, at.y, config.governor.walkSpeed * 1.5, dt);
    return false;
  }

  /** Stuck out somewhere: back at his desk (and his car back out front), out of sight. */
  #teleportHome(h) {
    if (h.vehicle) { h.vehicle.ai = null; this.#leaveCar(h, false); }
    const at = this.residence.spots.inspector, car = this.residence.spots.car;
    Object.assign(h, { x: at.x, y: at.y, route: [] });
    if (h.car && !h.car.driver && !h.car.passenger) Object.assign(h.car, { x: car.x, y: car.y, angle: car.angle, vx: 0, vy: 0, ai: null });
    else h.car = this.#officialCar();
  }

  /** To his car if he's not in it, then along the roads to `dest`; parks when he's near. True once parked there. */
  #drive(h, t, dest, dt) {
    if (!h.car) h.car = this.#officialCar();
    const car = h.car;
    if (!h.vehicle) {
      if (car.driver || car.passenger) { h.car = null; return false; } // someone's taken it: a new one turns up
      if (Math.hypot(car.x - h.x, car.y - h.y) > car.radius + h.radius + 30) { this.#walkState(h, car.x, car.y, config.hires.runSpeed, dt, car); return false; }
      this.#board(h, car);
      t.route = null;
      t.jam = { stuck: 0, reverse: 0 };
    }
    h.x = car.x;
    h.y = car.y;
    const graph = this.world.townsfolk.graph;
    t.route ??= graph.route({ x: car.x, y: car.y }, dest);
    t.jam ??= { stuck: 0, reverse: 0 };
    const forward = vehicleMotion(car).forward;
    const near = Math.hypot(dest.x - car.x, dest.y - car.y) < 260;
    if (!t.route.length || near) {
      car.ai = { gas: Math.abs(forward) > 30 ? -Math.sign(forward) : 0, steer: 0, drift: false };
      if (car.speed < 40) {
        car.ai = null;
        if (near || !t.route.length) { this.#leaveCar(h); return true; }
      }
      return false;
    }
    const next = t.route[0];
    if (Math.hypot(next.x - car.x, next.y - car.y) < 110) t.route.shift();
    const want = Math.atan2(next.y - car.y, next.x - car.x);
    const diff = Math.atan2(Math.sin(want - car.angle), Math.cos(want - car.angle));
    const j = t.jam;
    if (j.reverse > 0) {
      j.reverse -= dt;
      car.ai = { gas: -1, steer: -Math.sign(diff) || 1, drift: false };
      return false;
    }
    j.stuck = Math.abs(forward) < 20 ? j.stuck + dt : 0;
    if (j.stuck > 1.2) { j.stuck = 0; j.reverse = 0.9; }
    car.ai = { gas: Math.abs(diff) > 1.2 && forward > 150 ? -0.6 : 0.6, steer: Math.max(-1, Math.min(1, diff * 2.2)), drift: false };
    return false;
  }

  /** The household for the client: the inspector's errand, for a marker. */
  inspectorFor(account) {
    const h = this.list.find((x) => x.role === 'inspector');
    return h?.task && h.task.account === account ? { x: Math.round((h.vehicle ?? h).x), y: Math.round((h.vehicle ?? h).y) } : null;
  }

  // ---- gangsters ---------------------------------------------------------------------------

  /** Is (x, y) in town? (Gangsters keep to the city's streets; anywhere, on a map without one.) */
  #inTown(x, y) {
    const c = this.world.city;
    return !c || (x > c.x && x < c.x + c.w && y > c.y && y < c.y + c.h);
  }

  /** A new gangster, on a street in town, out of sight of everyone. Returns false if there's nowhere. */
  #spawnGangster() {
    const w = this.world, g = config.gangsters;
    const roads = w.roads.filter((r) => this.#inTown(r.x + r.w / 2, r.y + r.h / 2));
    for (let i = 0; i < 80 && roads.length; i++) {
      const road = roads[Math.floor(Math.random() * roads.length)];
      const x = road.x + Math.random() * road.w, y = road.y + Math.random() * road.h;
      if (!this.#inTown(x, y)) continue;
      if (w.isBlocked(x, y, 22) || w.isSwimming(x, y)) continue;
      if ([...w.players.values()].some((p) => Math.hypot(p.x - x, p.y - y) < 900)) continue;
      const r = config.hires;
      const g2 = {
        kind: 'hire', role: 'gangster', id: this.nextId++, employer: null, name: 'a gangster',
        x, y, angle: 0, health: g.health, maxHealth: g.health, radius: r.radius,
        weapon: g.weapon, fireCooldown: 0, ammo: config.weapons[g.weapon].magazineSize, reload: 0,
        vehicle: null, alive: true, wanted: 0, lastSeen: 0, hidden: null, jailed: null, shotPolice: false,
        foes: new Map(), offline: 0, pick: null, route: [], seen: new Map(), cash: 0, nextTheft: 0, look: 0,
      };
      this.list.push(g2);
      return true;
    }
    return false;
  }

  /** A gangster's turn: a fight if anyone's after him; else a hold-up or a stolen car under way; else looking for trouble while he walks the town (each on his own). */
  #gangster(h, dt) {
    const g = config.gangsters, w = this.world;
    h.aiming = false;
    const threat = this.#threat(h, null, g.fightRange);
    if (threat) {
      if (h.holdup?.p) h.holdup.p.heldUp = null;
      h.holdup = null;
      if (h.vehicle) h.vehicle.stolenBy === h ? this.#dumpCar(h) : this.#leaveCar(h);
      return this.#fightThreat(h, threat, dt, 220);
    }
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

  /** Walk the town: from road to road, somewhere new each time. */
  #wander(h, dt) {
    const graph = this.world.townsfolk.graph;
    if (!h.route.length) {
      const near = graph.nodes.filter((n) => Math.hypot(n.x - h.x, n.y - h.y) < 1800 && this.#inTown(n.x, n.y)); // (they keep to town)
      const node = near[Math.floor(Math.random() * near.length)];
      if (!node) return;
      h.route = graph.route({ x: h.x, y: h.y }, node);
    }
    const next = h.route[0];
    if (Math.hypot(next.x - h.x, next.y - h.y) < 30) return void h.route.shift();
    this.#walk(h, next.x, next.y, config.gangsters.walkSpeed, dt);
  }

  /**
   * Walk up, rifle raised: hands up and stand still for holdupSec and they take your cash. You've
   * holdupGraceSec to stop and stand still (moving just starts the countdown over, and he keeps up with
   * you); still moving after that and it's a fight. Shoot at him and it's a fight at once.
   */
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
      Object.assign(hu, { started: true, at: { x: p.x, y: p.y }, left: g.holdupSec, grace: g.holdupGraceSec });
      p.heldUp = { by: h, left: g.holdupSec, of: g.holdupSec, grace: g.holdupGraceSec };
      (p.foes ??= new Map()).set(h, this.time + config.hires.foeSec); // (your goons, if any, see the threat)
      this.events.push({ player: p, kind: 'holdup', sec: g.holdupSec, grace: g.holdupGraceSec });
      return;
    }
    hu.left -= dt;
    hu.grace = Math.max(0, hu.grace - dt);
    const moved = Math.hypot(p.x - hu.at.x, p.y - hu.at.y) > g.holdupMove || d > g.holdupRange * 2;
    const drew = p.input?.fire && p.weapon && !config.weapons[p.weapon.type]?.melee;
    if (moved && !drew && hu.grace > 0) { // not standing still yet: the countdown starts over from here (and he keeps close)
      hu.at = { x: p.x, y: p.y };
      hu.left = g.holdupSec;
    }
    if (d > g.holdupRange && hu.grace > 0) this.#walk(h, p.x, p.y, config.hires.runSpeed, dt);
    h.angle = Math.atan2(p.y - h.y, p.x - h.x); // (the rifle stays on you)
    Object.assign(p.heldUp, { left: hu.left, grace: hu.grace });
    if ((moved && hu.grace <= 0) || drew) { // resisting: he opens fire
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
    const far = graph.nodes.filter((n) => Math.hypot(n.x - v.x, n.y - v.y) > 1500 && this.#inTown(n.x, n.y)); // (dumped somewhere in town)
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

  /** Sell a gangster the vodka you've got on you (and in your car), up to vodkaPerSale bottles: vodkaPrice × base a bottle. */
  sellVodka(p, id) {
    const h = this.gangsterFor(p, id);
    if (!h) return 'too_far';
    if (this.#isFoe(h, p) || h.holdup) return 'gangster_hostile';
    if (isCop(p)) return 'cop_no_illegal';
    const seller = `${h.id}:${p.account?.id ?? `p${p.id}`}`;
    if (this.time < (this.vodkaSales.get(seller) ?? -Infinity) + config.gangsters.vodkaCooldownSec) return 'vodka_cooldown';
    const holder = this.world.economy.cargoOf(p);
    const sold = {};
    let total = 0;
    let room = config.gangsters.vodkaPerSale;
    for (const good of Object.keys(config.economy.visions)) {
      const qty = Math.min(holder.count(good), room);
      if (!qty) continue;
      holder.add(good, -qty);
      room -= qty;
      sold[good] = qty;
      total += qty * Math.round(config.goods[good].base * config.gangsters.vodkaPrice);
    }
    if (!total) return 'no_vodka';
    p.cash += total;
    this.vodkaSales.set(seller, this.time);
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
const LOOKS = { goon: [2, 1, 1, 5], guard: [1, 0, 1, 4], hitman: [0, 0, 0, 3], gangster: [1, 0, 0, 3], governor: [0, 10, 5, 9], govguard: [2, 11, 5, 0], inspector: [1, 11, 4, 10] };
