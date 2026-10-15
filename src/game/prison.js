import { config } from '../config.js';
import { hotbarOf } from './cargo.js';
import { Bullet } from './entities.js';
import { walkTo } from './townsfolk.js';

// The prison (ИТК-7): a gulag on the edge of town, where every arrest ends up.
//
// You arrive in prisoner's clothes with a pickaxe; the warden keeps your hotbar until you leave.
// Three ways out:
//   - bail: pay the warden at the gatehouse counter (cash, then bank) — or a friend pays it from the
//     visitors' side of the counter;
//   - work: mine your quota of coal at the coal face and tip it into the boiler house's coal bunker;
//   - escape: dig through the concrete section of the inner fence with your pickaxe — if a guard sees
//     you at it, the hole's filled in and he beats you (more coal on your quota) — then open the door
//     in the outer fence with a key lifted off a patrolling guard (F, from behind). Out past the wire you're wanted, and
//     the snipers in the watchtowers shoot at anyone wanted round the camp. Whatever the warden was
//     keeping for you stays with him. Shot down (or logged off) before you're out of their range,
//     you're back inside.
//
// The sentence lives on the account (account.prison: { quota, coal, bail }), so logging off or dying
// inside doesn't get you out: you're back in the cells when you next spawn.
//
// Camp life: you arrive in one of the cells by the gatehouse. At nightfall the guards order everyone
// back to the cells; still out when the warning runs out and a guard comes over and clubs you (more
// coal on your quota each time) until you're back. The cell doors lock till dawn — picking one open
// gets the guards straight onto you. The cook serves slop at the morning and evening meals (a bell
// rings; one bowl each). The big convicts (NPCs) dig coal and tip it in the bunker all day, and go to
// their cells at night; hit one and he fights back with his fists.
//
//   p.jailed: { prison: true, quota, coal, bail, stash (your hotbar, held by the warden) }

const inRect = (r, x, y, m = 0) => x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.h + m;

export class Prison {
  constructor(world) {
    this.world = world;
    this.events = []; // { player, kind, ... } for the room to pass on
    this.building = world.buildings.find((b) => b.type === 'prison' && b.prison) ?? null;
    this.onChange = null; // (account) -> save account.prison
    this.unlockedUntil = new Map(); // door -> world time it swings shut and locks again
    this.snipers = [];
    this.timer = 0;
    if (!this.building) return;
    const b = this.building;
    const doors = world.doors.filter((d) => d.building === b.id);
    const doorAt = ({ x, y }) => doors.reduce((best, d) => (Math.hypot(d.x + d.w / 2 - x, d.y + d.h / 2 - y) < Math.hypot(best.x + best.w / 2 - x, best.y + best.h / 2 - y) ? d : best));
    this.wallDoor = doorAt(b.prison.wallDoor); // the inner fence: dug through with a pickaxe
    this.keyDoor = doorAt(b.prison.keyDoor); // the outer fence: a guard's key
    this.wallHits = 0; // how far the digging's got (the hole's filled in when a guard sees, or once it's been used)
    // The tower snipers: they shoot from up in the towers (over the wire), and never come down.
    this.snipers = b.prison.towers.map((t) => ({ kind: 'officer', name: 'a tower sniper', x: t.x, y: t.y, vehicle: null, cooldown: Math.random() * 2 }));
    world.police.postPrisonGuards(b);
    this.cellDoorList = (b.prison.cellDoors ?? []).map(doorAt); // (cell i's door)
    this.cellDoors = new Set(this.cellDoorList);
    this.lockdown = false; // the cell doors are locked (night)
    this.lockedAt = -Infinity;
    this.meal = null; // the meal being served: its id (one bowl each)
    this.hiring = []; // seconds until each lost convict (or the cook) is replaced: { kind, left }
    for (let i = 0; i < config.prison.convicts.count; i++) this.#newConvict(i);
    this.#newCook();
  }

  // ---- the convicts and the cook (townsfolk with a job: see Townsfolk) -------------------

  #newConvict(i = Math.floor(Math.random() * 100)) {
    const c = config.prison.convicts;
    const s = this.spots;
    const cell = s.cells.length ? i % s.cells.length : 0;
    const w = this.building.work;
    const x = w.x + Math.random() * w.w, y = w.y + Math.random() * w.h;
    this.world.townsfolk.add(x, y, {
      kind: 'convict', owner: this, cell, carry: 0, target: null, swingT: Math.random() * c.swingSec, swinging: 0, quiet: true,
      fists: { purseShare: c.punchShare, purseHits: c.punchHits, fightSec: c.fightSec, purseReach: 30, fightCooldownSec: 1 },
    }, { health: c.health, speed: c.speed * (0.9 + Math.random() * 0.2), big: true });
  }

  #newCook() {
    const at = this.spots.cook;
    if (!at) return;
    this.world.townsfolk.add(at.x, at.y, { kind: 'cook', owner: this, quiet: true }, { angle: -Math.PI / 2 });
  }

  jobLost(person) {
    this.hiring.push({ kind: person.job.kind, left: config.labour.replaceSec });
  }

  stepJob(person, dt) {
    const j = person.job;
    if (j.kind === 'cook') { // behind his counter, facing the hatch
      if (walkTo(this.world, person, this.spots.cook.x, this.spots.cook.y, 80, dt, 4)) person.angle = -Math.PI / 2;
      return;
    }
    const c = config.prison.convicts;
    const w = this.world;
    j.swinging = Math.max(0, j.swinging - dt);
    const cell = this.spots.cells[j.cell];
    // Night: into his cell (a guard lets him in if the door's shut already), out again at dawn.
    if (this.lockdown && cell) {
      if (!j.inCell) {
        const bunk = { x: cell.x + cell.w / 2 + (j.cell % 2 ? 14 : -14), y: cell.y + cell.h / 2 };
        if (!j.atDoor) {
          const door = this.#cellDoorPoint(j.cell);
          if (!walkTo(w, person, door.x, door.y, person.speed * 1.5, dt, 30)) {
            if (!this.#lockedLongAgo()) return;
            Object.assign(person, bunk); // (still out long after lights-out: he's just there)
            j.inCell = true;
            return;
          }
          j.atDoor = true;
          j.inT = 0;
          const d = this.cellDoorList[j.cell];
          if (d && !d.open) { d.open = true; w.pendingDoors.push(d); }
        }
        if (!walkTo(w, person, bunk.x, bunk.y, person.speed, dt, 8) && (j.inT += dt) < 6) return;
        Object.assign(person, bunk);
        j.inCell = true;
        j.atDoor = false;
      }
      return;
    }
    if (j.inCell) { // morning: out into the corridor
      const door = this.#cellDoorPoint(j.cell);
      j.outT = (j.outT ?? 0) + dt;
      if (!walkTo(w, person, door.x, door.y, person.speed, dt, 20) && j.outT < 8) return;
      j.inCell = false;
      j.outT = 0;
    }
    if (j.carry >= c.carry) { // to the bunker with it
      const hop = this.spots.hopper;
      if (!walkTo(w, person, hop.x, hop.y, person.speed, dt, config.prison.hopperReach - 20)) return;
      j.carry = 0; // (into the boiler: it doesn't count for anyone's quota)
      return;
    }
    if (!j.target || j.target.hp <= 0) {
      const taken = new Set(w.townsfolk.people.filter((p) => p !== person && p.job?.target).map((p) => p.job.target));
      let best = null, bestD = Infinity;
      for (const n of w.work.workable(this.building.id, 'pickaxe')) {
        const d = Math.hypot(n.x - person.x, n.y - person.y) + Math.random() * 200;
        if (!taken.has(n) && d < bestD) [best, bestD] = [n, d];
      }
      j.target = best;
      if (!best) return;
    }
    const n = j.target;
    if (!walkTo(w, person, n.x, n.y, person.speed, dt, n.r + 32)) return;
    person.angle = Math.atan2(n.y - person.y, n.x - person.x);
    if ((j.swingT -= dt) > 0) return;
    j.swingT = c.swingSec;
    j.swinging = 0.4;
    const got = w.work.hit(n);
    if (got) {
      j.carry += got.coal ?? 0;
      j.target = null;
    }
  }

  /** Just outside cell `i`'s door, in the corridor. */
  #cellDoorPoint(i) {
    const cell = this.spots.cells[i], d = this.spots.cellDoors[i];
    const dx = d.x - (cell.x + cell.w / 2), dy = d.y - (cell.y + cell.h / 2), len = Math.hypot(dx, dy) || 1;
    return { x: d.x + (dx / len) * 40, y: d.y + (dy / len) * 40 };
  }

  #lockedLongAgo() {
    return this.time - this.lockedAt > config.prison.curfewWarnSec;
  }

  /** Is (x, y) inside one of the cells? */
  inCell(x, y) {
    return (this.spots?.cells ?? []).some((c) => inRect(c, x, y, 6));
  }

  get time() {
    return this.world.economy.time;
  }

  get spots() {
    return this.building?.prison ?? null;
  }

  /** Is (x, y) inside the camp's outer fence? */
  inside(x, y) {
    return Boolean(this.building) && inRect(this.building, x, y);
  }

  // ---- in and out ----------------------------------------------------------------------

  /**
   * Off to the camp: hotbar handed to the warden, a pickaxe instead, and a coal quota for the stars.
   * `resume` (the account's saved sentence) carries on one you hadn't finished. False if there's no prison.
   */
  jail(p, stars = 0, resume = null) {
    if (!this.building) return false;
    const c = config.prison;
    const n = Math.max(c.minStars, stars | 0);
    const sentence = resume ?? { quota: c.coalPerStar * n, coal: 0, bail: config.police.bailPerStar * n };
    if (p.vehicle) this.world.leaveSeat(p);
    if (p.carrying) this.world.bodies.dropCarried?.(p);
    if (p.holdingCat) this.world.cats?.putDown(p);
    if (p.hidden) this.world.unhide(p);
    p.robbing = null;
    p.wanted = 0;
    p.lastKnown = null;
    p.hideSpot = null;
    p.escaping = false;
    p.jailed = { prison: true, quota: sentence.quota, coal: sentence.coal, bail: sentence.bail, stash: p.inventory };
    p.inventory = p.inventory.map(() => null);
    p.inventory[0] = { type: 'pickaxe', tool: true, site: this.building.id };
    p.selected = 0;
    const at = this.#spawnSpot(p);
    p.x = at.x;
    p.y = at.y;
    if (p.account) {
      p.account.prison = { quota: sentence.quota, coal: sentence.coal, bail: sentence.bail };
      this.onChange?.(p.account);
    }
    return true;
  }

  /** Let p go (served, bailed out): hotbar back from the warden, out of the gatehouse by the road. */
  release(p, how, by = null) {
    const j = p.jailed;
    if (!j?.prison) return;
    p.jailed = null;
    p.inventory = j.stash;
    p.selected = 0;
    const at = this.spots.release;
    p.x = at.x;
    p.y = at.y;
    if (p.account) {
      p.account.prison = null;
      this.onChange?.(p.account);
    }
    this.events.push({ player: p, kind: 'prison_out', how, by });
  }

  /** A clear spot in the emptiest cell (or on the parade ground, if the camp has no cells). */
  #spawnSpot(p) {
    const cells = this.spots.cells ?? [];
    if (cells.length) {
      const inside = (c) => [...this.world.players.values()].filter((q) => q !== p && q.alive && inRect(c, q.x, q.y)).length;
      const cell = cells.reduce((best, c) => (inside(c) < inside(best) ? c : best));
      for (const dx of [-16, 16, 0]) {
        const x = cell.x + cell.w / 2 + dx, y = cell.y + cell.h / 2;
        if (!this.world.isBlocked(x, y, p.radius)) return { x, y };
      }
      return { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 };
    }
    const s = this.spots.spawn;
    for (let k = 0; k < 40; k++) {
      const a = k * 2.4, d = k * 9;
      const x = s.x + Math.cos(a) * d, y = s.y + Math.sin(a) * d;
      if (!this.world.isBlocked(x, y, p.radius)) return { x, y };
    }
    return s;
  }

  // ---- the warden ------------------------------------------------------------------------

  wardenNear(p) {
    const n = this.building?.npc;
    return Boolean(n) && !p.vehicle && Math.hypot(n.x - p.x, n.y - p.y) < config.prison.wardenReach + p.radius;
  }

  /** What the warden tells you: your own sentence, and everyone inside (for paying a friend's bail). */
  describe(viewer) {
    const mine = viewer?.jailed?.prison ? viewer.jailed : null;
    return {
      kind: 'prison',
      id: this.building.id,
      me: mine ? { coal: mine.coal, quota: mine.quota, bail: mine.bail } : null,
      prisoners: [...this.world.players.values()]
        .filter((q) => q.alive && q.jailed?.prison && q !== viewer)
        .map((q) => ({ id: q.id, name: q.name, coal: q.jailed.coal, quota: q.jailed.quota, bail: q.jailed.bail })),
    };
  }

  /** `payer` pays the bail for prisoner `id` (themselves too), cash first, then the bank. */
  payBail(payer, id) {
    if (!this.building) return 'no_prison';
    if (!this.wardenNear(payer)) return 'too_far';
    const q = this.world.players.get(id);
    if (!q?.alive || !q.jailed?.prison) return 'not_in_prison';
    const bail = q.jailed.bail;
    const fromCash = Math.min(payer.cash, bail);
    const fromBank = Math.min(Math.floor(payer.account?.bank ?? 0), bail - fromCash);
    if (fromCash + fromBank < bail) return 'cant_afford_bail';
    payer.cash -= fromCash;
    if (fromBank) {
      payer.account.bank -= fromBank;
      this.world.onBankChange?.(payer.account);
    }
    this.release(q, 'bail', q === payer ? null : payer.name);
    return { name: q.name, bail };
  }

  // ---- the doors in the wire ---------------------------------------------------------------

  /** The concrete in the inner fence (dig through it) and the outer fence's door (a guard's key) are shut; the cells at night. */
  lockedFor(door) {
    if (this.cellDoors?.has(door)) return this.lockdown && !this.unlockedUntil.has(door);
    if (door !== this.wallDoor && door !== this.keyDoor) return false;
    return !this.unlockedUntil.has(door);
  }

  /** Only a key opens this one: no picking it. */
  keyOnly(door) {
    return door === this.keyDoor;
  }

  /** The concrete section of the inner fence: only a pickaxe gets through it. */
  wallOnly(door) {
    return door === this.wallDoor;
  }

  isPrisonDoor(door) {
    return Boolean(door) && (door === this.keyDoor || door === this.wallDoor || Boolean(this.cellDoors?.has(door)));
  }

  /**
   * A prisoner's pickaxe swing: at the concrete in the inner fence, if it's in reach and in front of
   * them (true: the swing went into the wall). A guard who sees it: the hole's filled in and he comes
   * over and beats you, and there's more coal on your quota. Enough hits unseen and you're through.
   */
  digWall(p) {
    const door = this.wallDoor;
    if (!door || !p.jailed?.prison || this.unlockedUntil.has(door)) return false;
    const c = config.prison;
    const cx = door.x + door.w / 2, cy = door.y + door.h / 2;
    const dx = Math.max(door.x - p.x, 0, p.x - (door.x + door.w)), dy = Math.max(door.y - p.y, 0, p.y - (door.y + door.h));
    if (Math.hypot(dx, dy) > config.work.reach + p.radius) return false;
    const aim = p.input.aim ?? 0, d = Math.hypot(cx - p.x, cy - p.y);
    if (d > 10 && ((cx - p.x) * Math.cos(aim) + (cy - p.y) * Math.sin(aim)) / d < 0.3) return false; // has to be in front of you
    const police = this.world.police;
    const guard = police.prisonGuards().find((o) => police.sees(o.x, o.y, o.angle, p.x, p.y, c.wallSeenRange));
    if (guard) {
      this.#setWall(0);
      p.jailed.quota += c.caughtCoal;
      p.jailed.beating = c.beatClubs;
      this.#saveSentence(p);
      this.events.push({ player: p, kind: 'wall_caught', extra: c.caughtCoal, quota: p.jailed.quota });
      return true;
    }
    this.#setWall(this.wallHits + 1);
    if (this.wallHits >= c.wallHits) {
      this.#unlock(door);
      this.events.push({ player: p, kind: 'wall_through' });
    }
    return true;
  }

  #setWall(hits) {
    if (hits === this.wallHits) return;
    this.wallHits = hits;
    this.events.push({ kind: 'prison_wall', hits, max: config.prison.wallHits }); // (everyone sees the hole)
  }

  /** E at the outer door with a guard's key in your hotbar: it opens (and the key's used up). */
  useKey(door, p) {
    if (door !== this.keyDoor || door.open) return false;
    const i = p.inventory.findIndex((s) => s?.type === 'key');
    if (i < 0) return false;
    p.inventory[i] = null;
    this.#unlock(door);
    return true;
  }

  /** A cell's lock is picked: it swings open. */
  picked(door) {
    this.#unlock(door);
  }

  // ---- lights out, and meal times --------------------------------------------------------------

  /** Seconds into the day, and which day it is (the room sets these from its clock). */
  #clock() {
    return { at: this.world.dayClock ?? null, day: this.world.dayNumber ?? 0 };
  }

  /** The prison guard `guard` (on his rounds): a prisoner for him to deal with (caught at the wall, or out after lights-out), if any. */
  curfewTarget(guard) {
    let best = null, bestD = Infinity;
    for (const p of this.world.players.values()) {
      if (!p.alive || !p.jailed?.prison) continue;
      if (!(p.jailed.beating > 0) && (!this.lockdown || !p.jailed.out || this.time < p.jailed.out.warnUntil)) continue;
      const d = Math.hypot(p.x - guard.x, p.y - guard.y);
      if (d < bestD) [best, bestD] = [p, d];
    }
    return best;
  }

  /** A guard's baton: it hurts (never kills); out after lights-out, there's more coal on the quota each time. */
  club(guard, p) {
    const c = config.prison;
    const j = p.jailed;
    if (!j || (j.clubbed ?? -Infinity) > this.time - c.clubEverySec) return false;
    if (j.beating > 0) { // caught at the wall: a few blows (the coal's already on the quota)
      j.clubbed = this.time;
      j.beating--;
      p.hurt(Math.min(c.clubDamage, Math.max(0, p.health - 1)));
      this.events.push({ player: p, kind: 'beaten', left: j.beating });
      return true;
    }
    const out = j.out;
    if (!out) return false;
    j.clubbed = this.time;
    p.hurt(Math.min(c.clubDamage, Math.max(0, p.health - 1)));
    p.jailed.quota += c.curfewCoal;
    this.#saveSentence(p);
    this.events.push({ player: p, kind: 'clubbed', extra: c.curfewCoal, quota: p.jailed.quota });
    return true;
  }

  #lightsOut(w) {
    const c = config.prison;
    if (w.night && !this.lockdown) {
      this.lockdown = true;
      this.lockedAt = this.time;
      for (const door of this.cellDoors) this.unlockedUntil.delete(door);
      this.events.push({ kind: 'prison_lockdown', on: true }); // (everyone: a locked cell door can be picked with F)
      for (const p of w.players.values()) if (p.alive && p.jailed?.prison) this.events.push({ player: p, kind: 'lights_out', sec: c.curfewWarnSec });
    } else if (!w.night && this.lockdown) {
      this.lockdown = false;
      this.events.push({ kind: 'prison_lockdown', on: false });
      for (const door of this.cellDoors) if (!door.open) { door.open = true; w.pendingDoors.push(door); } // morning: the cells are opened up
      for (const p of w.players.values()) if (p.jailed?.prison) { p.jailed.out = null; if (p.alive) this.events.push({ player: p, kind: 'cells_open' }); }
    }
    if (!this.lockdown) return;
    // The cell doors swing shut behind whoever's in (not on anyone in a doorway) and stay locked.
    if (this.time - this.lockedAt > 3) {
      for (const door of this.cellDoors) {
        if (!door.open || this.unlockedUntil.has(door)) continue;
        if ([...w.players.values()].some((o) => o.alive && Math.abs(o.x - (door.x + door.w / 2)) < door.w / 2 + o.radius && Math.abs(o.y - (door.y + door.h / 2)) < door.h / 2 + o.radius)) continue;
        if (w.townsfolk.people.some((o) => o.job?.kind === 'convict' && o.job.atDoor && this.cellDoorList[o.job.cell] === door)) continue; // (one still going in)
        door.open = false;
        w.pendingDoors.push(door);
      }
    }
    // Anyone out of the cells: warned (once lights-out's warning has run out, no more warnings).
    for (const p of w.players.values()) {
      if (!p.alive || !p.jailed?.prison) continue;
      if (this.inCell(p.x, p.y)) { p.jailed.out = null; continue; }
      if (p.jailed.out) continue;
      const warnUntil = Math.max(this.time, this.lockedAt + c.curfewWarnSec);
      p.jailed.out = { warnUntil };
      if (warnUntil > this.time + 1) this.events.push({ player: p, kind: 'curfew_warn', sec: Math.round(warnUntil - this.time) });
    }
  }

  /** Morning and evening: the bell, then slop at the kitchen hatch for a while (one bowl each). */
  #meals(w) {
    const s = config.prison.slop;
    const { at, day } = this.#clock();
    if (at === null || !this.spots.serve) return;
    const daySec = config.environment.daySec;
    const times = [0, daySec - 6 * 60]; // first thing, and before lights-out
    const k = times.findIndex((t) => at >= t && at < t + s.servingSec);
    const id = k < 0 ? null : day * 2 + k;
    if (id !== null && id !== this.meal) {
      for (const p of w.players.values()) if (p.alive && p.jailed?.prison) this.events.push({ player: p, kind: 'meal_bell', meal: k ? 'supper' : 'breakfast' });
    }
    this.meal = id;
    if (id === null) return;
    const cook = w.townsfolk.people.find((x) => x.job?.kind === 'cook' && !x.fight && !x.flee);
    if (!cook) return; // (no cook, no slop)
    const hatch = this.spots.serve;
    for (const p of w.players.values()) {
      if (!p.alive || !p.jailed?.prison || p.jailed.meal === id) continue;
      if (Math.hypot(hatch.x - p.x, hatch.y - p.y) > s.reach + p.radius) continue;
      p.jailed.meal = id;
      (p.digesting ??= []).push({ perSec: s.heal / s.healSec, left: s.healSec });
      this.events.push({ player: p, kind: 'slop' });
    }
  }

  #unlock(door) {
    this.unlockedUntil.set(door, this.time + config.prison.doorOpenSec);
    door.open = true;
    this.world.pendingDoors.push(door);
  }

  // ---- a guard's key ---------------------------------------------------------------------

  /**
   * F next to a guard, as a prisoner: from behind you lift his key; face to face he catches you, and
   * that's more coal on your quota. Null if no guard is close (so F does what it always does).
   */
  liftKey(p) {
    if (!p.jailed?.prison) return null;
    const c = config.prison;
    const guard = this.world.police.prisonGuards().find((o) => Math.hypot(o.x - p.x, o.y - p.y) < c.keyReach + p.radius + 16);
    if (!guard) return null;
    if ((p.pickpocketReady ?? 0) > this.time) return 'too_soon';
    p.pickpocketReady = this.time + config.pickpocket.cooldownSec;
    const behind = (p.x - guard.x) * Math.cos(guard.angle ?? 0) + (p.y - guard.y) * Math.sin(guard.angle ?? 0) < 0;
    if (!behind) {
      p.jailed.quota += c.caughtCoal;
      this.#saveSentence(p);
      this.events.push({ player: p, kind: 'key_caught', extra: c.caughtCoal, quota: p.jailed.quota });
      return {};
    }
    if (p.inventory.some((s) => s?.type === 'key')) return 'have_key';
    const free = p.inventory.indexOf(null);
    if (free < 0) return 'hotbar_full';
    p.inventory[free] = { type: 'key', tool: true, site: this.building.id };
    this.events.push({ player: p, kind: 'key_lifted' });
    return {};
  }

  #saveSentence(p) {
    if (!p.account) return;
    p.account.prison = { quota: p.jailed.quota, coal: p.jailed.coal, bail: p.jailed.bail };
    this.onChange?.(p.account);
  }

  // ---- every step ----------------------------------------------------------------------------

  step(dt) {
    if (!this.building) return;
    const w = this.world;
    const c = config.prison;
    const b = this.building;
    for (let i = this.hiring.length - 1; i >= 0; i--) {
      if ((this.hiring[i].left -= dt) > 0) continue;
      if (this.hiring[i].kind === 'cook') this.#newCook();
      else this.#newConvict();
      this.hiring.splice(i, 1);
    }
    this.#lightsOut(w);
    this.#meals(w);
    const mid = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    for (const p of w.players.values()) {
      if (p.alive && p.escaping && Math.hypot(p.x - mid.x, p.y - mid.y) > Math.max(b.w, b.h) / 2 + c.sniperRange) this.#gotAway(p);
      if (!p.alive || !p.jailed?.prison) continue;
      // Past the outer fence: escaped.
      if (!inRect(b, p.x, p.y)) {
        this.#escaped(p);
        continue;
      }
      // Coal tipped into the bunker.
      const hop = this.spots.hopper;
      const coal = hotbarOf(p).count('coal');
      if (coal > 0 && Math.hypot(hop.x - p.x, hop.y - p.y) < c.hopperReach + p.radius) {
        hotbarOf(p).add('coal', -coal);
        p.jailed.coal += coal;
        this.events.push({ player: p, kind: 'coal_mined', qty: coal }); // (all the coal they've ever dug counts for the prison outfit)
        if (p.jailed.coal >= p.jailed.quota) this.release(p, 'served');
        else {
          this.#saveSentence(p);
          this.events.push({ player: p, kind: 'coal_in', qty: coal, coal: p.jailed.coal, quota: p.jailed.quota });
        }
      }
    }
    // The escape doors swing shut and lock again (not on anyone standing in the doorway).
    for (const [door, until] of this.unlockedUntil) {
      if (this.time < until) continue;
      if ([...w.players.values()].some((o) => o.alive && Math.abs(o.x - (door.x + door.w / 2)) < door.w / 2 + o.radius && Math.abs(o.y - (door.y + door.h / 2)) < door.h / 2 + o.radius)) continue;
      this.unlockedUntil.delete(door);
      if (door === this.wallDoor) this.#setWall(0); // the hole's bricked up again
      if (door.open) {
        door.open = false;
        w.pendingDoors.push(door);
      }
    }
    // The tower snipers: at anyone wanted round the camp, in sight.
    for (const s of this.snipers) {
      s.cooldown -= dt;
      if (s.cooldown > 0) continue;
      let target = null, best = c.sniperRange;
      for (const p of w.players.values()) {
        if (!p.alive || !p.wanted || p.jailed || p.hidden) continue;
        const tx = p.vehicle?.x ?? p.x, ty = p.vehicle?.y ?? p.y;
        const d = Math.hypot(tx - s.x, ty - s.y);
        if (d < best && w.lineOfSight(s.x, s.y, tx, ty)) [target, best] = [{ x: tx, y: ty }, d];
      }
      if (!target) {
        s.cooldown = 0.5;
        continue;
      }
      s.cooldown = c.sniperEverySec;
      const angle = Math.atan2(target.y - s.y, target.x - s.x) + (Math.random() - 0.5) * c.sniperSpread;
      const bullet = new Bullet(w.nextEntityId++, s, s.x + Math.cos(angle) * 40, s.y + Math.sin(angle) * 40, angle, 'sniper');
      w.bullets.set(bullet.id, bullet);
      this.events.push({ kind: 'sniper', x: s.x, y: s.y });
    }
  }

  /**
   * Over the wire: wanted, and whatever the warden had of yours is gone. You've only got away once
   * you're out of the snipers' range: until then the sentence stays on the account, so if they drop
   * you (or you log off) you're back in the camp.
   */
  #escaped(p) {
    p.jailed = null;
    p.escaping = true;
    this.world.police.crime(p, 'prison_escape', true);
    p.wanted = Math.max(p.wanted, config.prison.escapeStars);
    this.events.push({ player: p, kind: 'escaped' });
  }

  #gotAway(p) {
    p.escaping = false;
    if (p.account) {
      p.account.prison = null;
      this.onChange?.(p.account);
    }
    this.events.push({ player: p, kind: 'got_away' });
  }
}
