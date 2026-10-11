import { config } from '../config.js';
import { hotbarOf } from './cargo.js';
import { Bullet } from './entities.js';

// The prison (ИТК-7): a gulag on the edge of town, where every arrest ends up.
//
// You arrive in prisoner's clothes with a pickaxe; the warden keeps your hotbar until you leave.
// Three ways out:
//   - bail: pay the warden at the gatehouse counter (cash, then bank) — or a friend pays it from the
//     visitors' side of the counter;
//   - work: mine your quota of coal at the coal face and tip it into the boiler house's coal bunker;
//   - escape: lift a key off a patrolling guard (F, from behind), open the door in the inner fence
//     with it, then pick the lock on the door in the outer fence. Out past the wire you're wanted, and
//     the snipers in the watchtowers shoot at anyone wanted round the camp. Whatever the warden was
//     keeping for you stays with him. Shot down (or logged off) before you're out of their range,
//     you're back inside.
//
// The sentence lives on the account (account.prison: { quota, coal, bail }), so logging off or dying
// inside doesn't get you out: you're back at the parade ground when you next spawn.
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
    this.keyDoor = doorAt(b.prison.keyDoor);
    this.outerDoor = doorAt(b.prison.outerDoor);
    // The tower snipers: they shoot from up in the towers (over the wire), and never come down.
    this.snipers = b.prison.towers.map((t) => ({ kind: 'officer', name: 'a tower sniper', x: t.x, y: t.y, vehicle: null, cooldown: Math.random() * 2 }));
    world.police.postPrisonGuards(b);
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

  /** A clear spot on the parade ground (not on top of anyone). */
  #spawnSpot(p) {
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

  /** The door in the inner fence (a guard's key) and the one in the outer fence (pick it) are locked. */
  lockedFor(door) {
    if (door !== this.keyDoor && door !== this.outerDoor) return false;
    return !this.unlockedUntil.has(door);
  }

  /** Only a key opens this one: no picking it. */
  keyOnly(door) {
    return door === this.keyDoor;
  }

  isPrisonDoor(door) {
    return Boolean(door) && (door === this.keyDoor || door === this.outerDoor);
  }

  /** E at the inner door with a guard's key in your hotbar: it opens (and the key's used up). */
  useKey(door, p) {
    if (door !== this.keyDoor || door.open) return false;
    const i = p.inventory.findIndex((s) => s?.type === 'key');
    if (i < 0) return false;
    p.inventory[i] = null;
    this.#unlock(door);
    return true;
  }

  /** The outer door's lock is picked: it swings open. */
  picked(door) {
    this.#unlock(door);
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
