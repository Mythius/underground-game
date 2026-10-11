import { config } from '../config.js';
import { waterDistance } from './water.js';
import { hotbarOf } from './cargo.js';
import { STARTER_WEAPON, makeWeapon } from './entities.js';

// Fishing. With a rod in hand by a river or lake, click to cast: the float lands out on the water.
// After a while a fish bites and fights the line. It fights in cycles: thrashing most of the time, then
// tiring for a moment (it goes still, and a ripple rings it). Click to pull while it's tired and it
// comes closer; pull while it's thrashing and it breaks free; leave it too long and it swims off.
// Enough good pulls lands it: usually a fish, sometimes something else that was down there.
//
// Cast at another player instead (they're in the way of the line, within reach) and you hook them:
// the same fight, but on them — and they're warned, and can snap the line by walking off. Land it and
// you've reeled in one random thing from their hotbar (never their starting knife). That's theft:
// anyone who sees it (police or townsfolk) reports you, as for pickpocketing.
//
// The fight is the same for everyone who sees it: whether the fish is tired at time t is a pure
// function of the bite's start, its cycle length and the windows (see tiredAt), and the client draws
// it from the same numbers.

const rand = ([a, b]) => a + Math.random() * (b - a);

/** Is the fish tired (the moment to pull) `t` seconds into the fight? `window` = [start, end] as a share of the cycle. */
export function tiredAt(t, cycle, window) {
  const phase = (((t / cycle) % 1) + 1) % 1;
  return phase >= window[0] && phase <= window[1];
}

export class Fishing {
  constructor(world) {
    this.world = world;
    this.time = 0;
    this.events = []; // { player, kind, … } for the room to pass on
  }

  /** Is (x, y) open water a float can sit on (not dry land, not a bridge)? */
  #water(x, y) {
    const w = this.world;
    if (waterDistance(w.water, x, y).d > -12) return false;
    return !w.roads.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h);
  }

  hasRod(p) {
    return p.inventory[p.selected]?.type === 'rod';
  }

  /** Cast toward `angle`: the float lands on the first water out that way. */
  cast(p, angle) {
    const r = config.fishing;
    if (!this.hasRod(p)) return 'no_rod';
    if (p.vehicle || p.hidden || p.jailed || p.carrying || !p.alive) return 'busy';
    if (p.fishing) return this.pull(p, null); // (a click while the line's out is a pull)
    if (this.world.isSwimming(p.x, p.y)) return 'busy';
    if (!Number.isFinite(angle)) return 'no_water';
    const victim = this.#playerInLine(p, angle);
    if (victim) {
      p.fishing = { x: victim.x, y: victim.y, from: { x: p.x, y: p.y }, victim, hookedAt: { x: victim.x, y: victim.y }, phase: 'bite', pulls: 0 };
      this.#newRound(p.fishing);
      this.events.push({ player: p, kind: 'fish_hooked_player', name: victim.name });
      this.events.push({ player: victim, kind: 'hooked_by', name: p.name });
      return null;
    }
    const [near, far] = r.cast;
    for (let d = near; d <= far; d += 10) {
      const x = p.x + Math.cos(angle) * d, y = p.y + Math.sin(angle) * d;
      if (!this.#water(x, y)) continue;
      // Out a bit further if there's room, so it doesn't sit on the bank.
      const out = Math.min(far, d + 40);
      const [fx, fy] = this.#water(p.x + Math.cos(angle) * out, p.y + Math.sin(angle) * out) ? [p.x + Math.cos(angle) * out, p.y + Math.sin(angle) * out] : [x, y];
      p.fishing = { x: fx, y: fy, from: { x: p.x, y: p.y }, phase: 'wait', biteAt: this.time + rand(r.biteSec) };
      return null;
    }
    return 'no_water';
  }

  /** Another player standing in the way of a cast toward `angle`, within the line's reach (nearest first). */
  #playerInLine(p, angle) {
    const [, far] = config.fishing.cast;
    const fx = Math.cos(angle), fy = Math.sin(angle);
    let best = null, bestD = Infinity;
    for (const q of this.world.players.values()) {
      if (q === p || !q.alive || q.vehicle || q.hidden || q.jailed) continue;
      const dx = q.x - p.x, dy = q.y - p.y;
      const along = dx * fx + dy * fy;
      if (along < 20 || along > far) continue;
      if (Math.abs(dx * fy - dy * fx) > q.radius + 14) continue; // off to the side of the line
      if (along < bestD && this.world.lineOfSight(p.x, p.y, q.x, q.y)) [best, bestD] = [q, along];
    }
    return best;
  }

  /**
   * A pull. `seen` is how far into the fight (seconds) the player saw it when they clicked; it's trusted
   * only within slackSec of the server's clock (lag), and otherwise the server's own clock decides.
   */
  pull(p, seen) {
    const f = p.fishing;
    if (!f) return 'no_line';
    const r = config.fishing;
    if (f.phase === 'wait') { // nothing on it yet: reel in
      p.fishing = null;
      this.events.push({ player: p, kind: 'fish_reeled' });
      return null;
    }
    if (this.time < f.nextPull) return null; // (one pull at a time)
    const now = this.time - f.start;
    const t = Number.isFinite(seen) && Math.abs(seen - now) <= r.slackSec ? seen : now;
    if (!tiredAt(t, f.cycle, f.window)) {
      p.fishing = null;
      this.events.push({ player: p, kind: 'fish_escaped', why: 'snapped' });
      if (f.victim) this.events.push({ player: f.victim, kind: 'hook_free' });
      return null;
    }
    f.pulls++;
    // It comes in a third of the way toward you each time (a hooked player just stays hooked where they are).
    const left = r.pulls - f.pulls + 1;
    if (!f.victim) {
      f.x += (p.x - f.x) / (left + 1);
      f.y += (p.y - f.y) / (left + 1);
    }
    if (f.pulls >= r.pulls) return f.victim ? this.#landPlayer(p, f.victim) : this.#land(p);
    this.#newRound(f);
    this.events.push({ player: p, kind: 'fish_pull', pulls: f.pulls, of: r.pulls });
    return null;
  }

  /** The fish starts fighting again: a fresh window somewhere in the cycle, and a fresh clock to give up on. */
  #newRound(f) {
    const r = config.fishing;
    f.cycle = r.cycleSec * (0.85 + Math.random() * 0.3);
    const start = 0.35 + Math.random() * (1 - r.tiredShare - 0.4); // never right at the start: watch it first
    f.window = [start, start + r.tiredShare];
    f.start = this.time;
    f.until = this.time + r.giveUpSec;
    f.nextPull = this.time + 0.25;
  }

  /** Landed: usually a fish, sometimes something else. */
  #land(p) {
    const r = config.fishing;
    p.fishing = null;
    const w = this.world;
    if (Math.random() < r.fishChance) {
      if (hotbarOf(p).room('fish') < 1) return this.#full(p);
      hotbarOf(p).add('fish', 1);
      this.events.push({ player: p, kind: 'fish_caught', what: 'fish' });
      return null;
    }
    if (Math.random() < r.junk.food / (r.junk.food + r.junk.gun)) {
      const menu = Object.keys(config.economy.menu).filter((k) => k !== 'feast');
      const item = menu[Math.floor(Math.random() * menu.length)];
      if (!w.foodRoom(p, item)) return this.#full(p);
      w.addFood(p, item, 1);
      this.events.push({ player: p, kind: 'fish_caught', what: 'food', item });
      return null;
    }
    const free = p.inventory.indexOf(null);
    if (free < 0) return this.#full(p);
    const odds = Object.entries(r.junkGuns).filter(([t]) => config.weapons[t]);
    let roll = Math.random() * odds.reduce((s, [, n]) => s + n, 0);
    const type = (odds.find(([, n]) => (roll -= n) < 0) ?? odds[0])[0];
    const gun = makeWeapon(type);
    gun.ammo = Math.min(config.weapons[type].magazineSize, Math.round(rand(r.junkAmmo)));
    p.inventory[free] = gun;
    this.events.push({ player: p, kind: 'fish_caught', what: 'gun', item: type });
    return null;
  }

  /** Landed another player: one random thing from their hotbar is yours. That's theft. */
  #landPlayer(p, victim) {
    p.fishing = null;
    const slots = victim.inventory.map((s, i) => [s, i]).filter(([s]) => s && s.type !== STARTER_WEAPON && !(s.tool && s.type !== 'rod'));
    if (!slots.length) {
      this.events.push({ player: p, kind: 'fish_escaped', why: 'empty' });
      return null;
    }
    const [item, i] = slots[Math.floor(Math.random() * slots.length)];
    const w = this.world;
    // Into your hotbar if there's room for it.
    let ok;
    if (item.good) ok = hotbarOf(p).room(item.good) >= item.qty;
    else if (item.food) ok = w.foodRoom(p, item.food);
    else ok = p.inventory.includes(null) && !p.hasWeapon(item.type);
    if (!ok) return this.#full(p);
    victim.inventory[i] = null;
    if (item.good) hotbarOf(p).add(item.good, item.qty);
    else if (item.food) w.addFood(p, item.food, item.qty);
    else p.inventory[p.inventory.indexOf(null)] = item;
    w.police.crime(p, 'pickpocket'); // (reported if anyone saw)
    const what = item.good ?? item.food ?? item.type;
    this.events.push({ player: p, kind: 'fish_caught', what: 'player', item: what, qty: item.qty ?? 1, name: victim.name });
    this.events.push({ player: victim, kind: 'hooked_robbed', item: what, qty: item.qty ?? 1, name: p.name });
    return null;
  }

  #full(p) {
    this.events.push({ player: p, kind: 'fish_escaped', why: 'full' });
    return null;
  }

  step(dt) {
    this.time += dt;
    for (const p of this.world.players.values()) {
      const f = p.fishing;
      if (!f) continue;
      // Walked off, put the rod away, got in a car…: the line comes in.
      if (!p.alive || !this.hasRod(p) || p.vehicle || p.hidden || p.jailed || Math.hypot(p.x - f.from.x, p.y - f.from.y) > config.fishing.lineReach) {
        p.fishing = null;
        if (p.alive) this.events.push({ player: p, kind: f.phase === 'bite' ? 'fish_escaped' : 'fish_reeled', why: 'moved' });
        if (f.victim) this.events.push({ player: f.victim, kind: 'hook_free' });
        continue;
      }
      // A hooked player: the hook follows them; walking far enough off (or dying, driving off…) snaps it.
      if (f.victim) {
        const v = f.victim;
        const gone = !v.alive || v.vehicle || v.hidden || v.jailed || !this.world.players.has(v.id);
        if (gone || Math.hypot(v.x - f.hookedAt.x, v.y - f.hookedAt.y) > config.fishing.hookBreak) {
          p.fishing = null;
          this.events.push({ player: p, kind: 'fish_escaped', why: 'pulled_free', name: v.name });
          if (!gone) this.events.push({ player: v, kind: 'hook_free', escaped: true });
          continue;
        }
        f.x = v.x;
        f.y = v.y;
      }
      if (f.phase === 'wait' && this.time >= f.biteAt) {
        f.phase = 'bite';
        f.pulls = 0;
        this.#newRound(f);
        this.events.push({ player: p, kind: 'fish_bite' });
      } else if (f.phase === 'bite' && this.time > f.until) {
        p.fishing = null;
        this.events.push({ player: p, kind: 'fish_escaped', why: 'slow' });
        if (f.victim) this.events.push({ player: f.victim, kind: 'hook_free' });
      }
    }
  }

  /** For the snapshot: [x, y] while waiting, [x, y, secondsIntoFight, cycle, windowStart, windowEnd, pulls, hooked player id or 0] while it fights. */
  view(p) {
    const f = p.fishing;
    if (!f) return null;
    const at = [Math.round(f.x), Math.round(f.y)];
    if (f.phase !== 'bite') return at;
    const r3 = (n) => Math.round(n * 1000) / 1000;
    return [...at, r3(this.time - f.start), r3(f.cycle), r3(f.window[0]), r3(f.window[1]), f.pulls, f.victim?.id ?? 0];
  }
}
