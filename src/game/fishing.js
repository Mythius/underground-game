import { config } from '../config.js';
import { waterDistance } from './water.js';
import { hotbarOf } from './cargo.js';
import { STARTER_WEAPON, makeWeapon } from './entities.js';

// Fishing. With a rod in hand by a river or lake, click to cast: the float lands out on the water.
// After a while the fish flashes at the surface — for a split second (showSec). Click (pull) right then
// and it's landed: usually a fish, sometimes something else that was down there. Too late and it's
// gone; click while there's nothing on and you reel in for nothing.
//
// Cast at another player instead (they're in the way of the line, within reach) and you hook them:
// the same split second comes a moment later, on them — and they're warned, and can snap the line by
// walking off. Pull in time and you've reeled in one random thing from their hotbar (never their
// starting knife). That's theft: anyone who sees it (police or townsfolk) reports you, as for pickpocketing.

const rand = ([a, b]) => a + Math.random() * (b - a);

export class Fishing {
  constructor(world) {
    this.world = world;
    this.time = 0;
    this.events = []; // { player, kind, … } for the room to pass on
  }

  /** Is (x, y) open water a float can sit on (not dry land, not a bridge, not a frozen lake)? */
  #water(x, y) {
    const w = this.world;
    if (w.iceHoles?.some((h) => Math.hypot(x - h.x, y - h.y) < h.r)) return true; // (a hole cut in the ice)
    const water = w.frozen ? { rivers: w.water.rivers, lakes: [] } : w.water; // (the lakes are ice in winter)
    if (waterDistance(water, x, y).d > -12) return false;
    return !w.roads.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h);
  }

  hasRod(p) {
    return p.inventory[p.selected]?.type === 'rod';
  }

  /** Cast toward `angle`: the float lands on the first water out that way. */
  cast(p, angle) {
    const r = config.fishing;
    if (!this.hasRod(p)) return 'no_rod';
    if (p.vehicle || p.hidden || p.jailed || p.carrying || p.holdingCat || !p.alive) return 'busy';
    if (p.fishing) return this.pull(p, null); // (a click while the line's out is a pull)
    if (this.world.isSwimming(p.x, p.y)) return 'busy';
    if (!Number.isFinite(angle)) return 'no_water';
    const victim = this.#playerInLine(p, angle);
    if (victim) {
      p.fishing = { x: victim.x, y: victim.y, from: { x: p.x, y: p.y }, victim, hookedAt: { x: victim.x, y: victim.y }, phase: 'wait', biteAt: this.time + rand(config.fishing.hookBiteSec) };
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
      p.fishing = { x: fx, y: fy, castAt: { x: fx, y: fy }, from: { x: p.x, y: p.y }, phase: 'wait', biteAt: this.time + rand(r.biteSec) };
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
   * A pull. `seen` is how far into the fish's moment (seconds) the player saw it when they clicked; it's
   * trusted only within slackSec of the server's clock (lag), and otherwise the server's own clock decides.
   */
  pull(p, seen) {
    const f = p.fishing;
    if (!f) return 'no_line';
    const r = config.fishing;
    if (f.phase === 'wait') { // nothing showing yet: reel in (for nothing)
      p.fishing = null;
      this.events.push({ player: p, kind: 'fish_reeled' });
      if (f.victim) this.events.push({ player: f.victim, kind: 'hook_free' });
      return null;
    }
    const now = this.time - f.start;
    const t = Number.isFinite(seen) && Math.abs(seen - now) <= r.slackSec ? seen : now;
    if (t < 0 || t > r.showSec) { // too late: it's gone
      p.fishing = null;
      this.events.push({ player: p, kind: 'fish_escaped', why: 'slow' });
      if (f.victim) this.events.push({ player: f.victim, kind: 'hook_free' });
      return null;
    }
    return f.victim ? this.#landPlayer(p, f.victim) : this.#land(p);
  }

  /** Landed: usually a fish, sometimes something else. */
  #land(p) {
    const r = config.fishing;
    p.fishing = null;
    const w = this.world;
    if (w.tutorial || Math.random() < r.fishChance) { // (breakfast, in the tutorial: always a fish)
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
    const w = this.world;
    const worth = victim.inventory.map((s, i) => [s, i]).filter(([s]) => s && s.type !== STARTER_WEAPON && !(s.tool && s.type !== 'rod'));
    if (!worth.length) {
      this.events.push({ player: p, kind: 'fish_escaped', why: 'empty' });
      return null;
    }
    // Only what you could take: room for it in your hotbar.
    const fits = (item) => (item.good ? hotbarOf(p).room(item.good) >= item.qty : item.food ? w.foodRoom(p, item.food) : p.inventory.includes(null));
    const takeable = worth.filter(([s]) => fits(s));
    if (!takeable.length) {
      // Their things are all ones you already have (a gun like yours, a rod) — or your hotbar really is full.
      this.events.push({ player: p, kind: 'fish_escaped', why: p.inventory.includes(null) ? 'have_all' : 'full' });
      return null;
    }
    const [item, i] = takeable[Math.floor(Math.random() * takeable.length)];
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
      // Walked off, put the rod away, got in a car, the lake froze over…: the line comes in. (Ice is checked
      // where the float landed: reeling a fish in drags the float toward the bank, and that's not ice.)
      const iced = !f.victim && this.world.frozen && !this.#water(f.castAt.x, f.castAt.y);
      if (!p.alive || iced || !this.hasRod(p) || p.vehicle || p.hidden || p.jailed || Math.hypot(p.x - f.from.x, p.y - f.from.y) > config.fishing.lineReach) {
        p.fishing = null;
        if (p.alive) this.events.push({ player: p, kind: f.phase === 'bite' ? 'fish_escaped' : 'fish_reeled', why: iced ? 'frozen' : 'moved' });
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
        f.start = this.time;
        this.events.push({ player: p, kind: 'fish_bite' });
      } else if (f.phase === 'bite' && this.time > f.start + config.fishing.showSec + config.fishing.slackSec) { // (missed it: a late click is still judged by what they saw)
        p.fishing = null;
        this.events.push({ player: p, kind: 'fish_escaped', why: 'slow' });
        if (f.victim) this.events.push({ player: f.victim, kind: 'hook_free' });
      }
    }
  }

  /** For the snapshot: [x, y] while waiting (on a hooked player: [x, y, 0, 0, their id]), [x, y, secondsIntoTheMoment, showSec, hooked player id or 0] once it shows. */
  view(p) {
    const f = p.fishing;
    if (!f) return null;
    const at = [Math.round(f.x), Math.round(f.y)];
    if (f.phase !== 'bite') return f.victim ? [...at, -1, 0, f.victim.id] : at;
    return [...at, Math.round((this.time - f.start) * 1000) / 1000, config.fishing.showSec, f.victim?.id ?? 0];
  }
}
