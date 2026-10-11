import { config } from '../config.js';
import { waterDistance } from './water.js';
import { hotbarOf } from './cargo.js';
import { makeWeapon } from './entities.js';

// Fishing. With a rod in hand by a river or lake, click to cast: the float lands out on the water.
// After a while a fish bites and fights the line. It fights in cycles: thrashing most of the time, then
// tiring for a moment (it goes still, and a ripple rings it). Click to pull while it's tired and it
// comes closer; pull while it's thrashing and it breaks free; leave it too long and it swims off.
// Enough good pulls lands it: usually a fish, sometimes something else that was down there.
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
      return null;
    }
    f.pulls++;
    // It comes in a third of the way toward you each time.
    const left = r.pulls - f.pulls + 1;
    f.x += (p.x - f.x) / (left + 1);
    f.y += (p.y - f.y) / (left + 1);
    if (f.pulls >= r.pulls) return this.#land(p);
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
        continue;
      }
      if (f.phase === 'wait' && this.time >= f.biteAt) {
        f.phase = 'bite';
        f.pulls = 0;
        this.#newRound(f);
        this.events.push({ player: p, kind: 'fish_bite' });
      } else if (f.phase === 'bite' && this.time > f.until) {
        p.fishing = null;
        this.events.push({ player: p, kind: 'fish_escaped', why: 'slow' });
      }
    }
  }

  /** For the snapshot: [x, y] while waiting, [x, y, secondsIntoFight, cycle, windowStart, windowEnd, pulls] while it fights. */
  view(p) {
    const f = p.fishing;
    if (!f) return null;
    const at = [Math.round(f.x), Math.round(f.y)];
    if (f.phase !== 'bite') return at;
    const r3 = (n) => Math.round(n * 1000) / 1000;
    return [...at, r3(this.time - f.start), r3(f.cycle), r3(f.window[0]), r3(f.window[1]), f.pulls];
  }
}
