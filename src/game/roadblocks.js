import { config } from '../config.js';
import { Vehicle } from './vehicles.js';
import { waterDistance } from './water.js';

// Militsiya checkpoints. Each blocks a stretch of road with two parked Militsiya cars (a chicane you
// can just squeeze through) and an officer at the roadside.
//   Stop in the zone (slower than slowSpeed for searchSec) and they search you and your car:
//     clean → wave you on; contraband → seized, and you're wanted (smuggling).
//   A bribe (cash, while you're in the zone) gets you waved through for a while.
//   Someone else's car (or a Militsiya one) is recognised as stolen: no bribe covers it. Stop and
//   you're pulled out and wanted for car theft, and the car's taken back; drive on and you ran it.

export class Roadblocks {
  constructor(world, avoid = []) {
    this.world = world;
    this.list = [];
    this.events = []; // { player, kind, ... } for the room to pass on
    const roads = world.roads;
    const rb = config.roadblocks;
    for (let tries = 0; this.list.length < rb.count && tries < rb.count * 80 && roads.length; tries++) {
      const road = roads[Math.floor(Math.random() * roads.length)];
      const horizontal = road.w > road.h;
      const len = horizontal ? road.w : road.h;
      const along = 600 + Math.random() * (len - 1200);
      const cx = horizontal ? road.x + along : road.x + road.w / 2;
      const cy = horizontal ? road.y + road.h / 2 : road.y + along;
      const zone = horizontal ? { x: cx - 150, y: road.y, w: 300, h: road.h } : { x: road.x, y: cy - 150, w: road.w, h: 300 };
      const near = (r, gap) => zone.x < r.x + r.w + gap && r.x < zone.x + zone.w + gap && zone.y < r.y + r.h + gap && r.y < zone.y + zone.h + gap;
      if (roads.some((o) => o !== road && near(o, 400))) continue; // not at a junction
      if (avoid.some((r) => near(r, 200)) || waterDistance(world.water, cx, cy).d < 300) continue; // not on the railway or a bridge
      if (this.list.some((o) => Math.hypot(o.x - cx, o.y - cy) < 2500)) continue;
      this.#make(this.list.length + 1, zone, horizontal, cx, cy, road);
    }
  }

  #make(id, zone, horizontal, cx, cy, road) {
    const w = this.world;
    const size = horizontal ? road.h : road.w;
    const cars = [];
    // Two cars, one in each half of the road and staggered, leaving a gap through the middle.
    for (const side of [-1, 1]) {
      const across = side * (size / 2 - 52);
      const stagger = side * 55;
      const x = horizontal ? cx + stagger : cx + across;
      const y = horizontal ? cy + across : cy + stagger;
      const v = new Vehicle(w.nextEntityId++, 'police', x, y, horizontal ? 0 : Math.PI / 2);
      Object.assign(v, { police: true, roadblock: id });
      w.vehicles.set(v.id, v);
      cars.push(v.id);
    }
    // The officer stands at the roadside next to the zone.
    const officer = horizontal ? { x: cx, y: road.y - 26, angle: Math.PI / 2 } : { x: road.x - 26, y: cy, angle: 0 };
    this.list.push({ id, ...zone, horizontal, x: cx, y: cy, zone, officer, cars });
  }

  get time() {
    return this.world.economy.time;
  }

  /** The checkpoint whose zone (plus `margin`) a point is in. */
  at(x, y, margin = 0) {
    return this.list.find((r) => x > r.zone.x - margin && x < r.zone.x + r.zone.w + margin && y > r.zone.y - margin && y < r.zone.y + r.zone.h + margin) ?? null;
  }

  /** Is p driving a car that isn't theirs: someone else's, or a Militsiya car? */
  stolen(p) {
    const v = p.vehicle;
    return Boolean(v && (v.police || (v.owner && v.owner !== p.account)));
  }

  step(dt) {
    const rb = config.roadblocks;
    for (const p of this.world.players.values()) {
      const v = p.vehicle;
      const mine = v && (!v.police || this.stolen(p)) ? v : null; // (a Militsiya car driven by a player is stolen)
      p.handledAt ??= {};
      // Coming within range of a checkpoint by car: you have checkWithinSec to stop and be checked.
      const near = mine && v.driver === p ? this.at(v.x, v.y, rb.range) : null;
      if (near && !p.checkDue && (p.handledAt[near.id] ?? -Infinity) <= this.time) {
        p.checkDue = { id: near.id, until: this.time + rb.checkWithinSec };
        this.events.push({ player: p, kind: 'roadblock_due', sec: rb.checkWithinSec });
      }
      if (p.checkDue && this.time > p.checkDue.until) {
        // Didn't stop: unless they were paid off, that's running the checkpoint.
        const id = p.checkDue.id;
        p.checkDue = null;
        p.handledAt[id] = this.time + rb.againSec;
        if (((p.bribedUntil ?? -Infinity) <= this.time || this.stolen(p)) && p.alive) {
          this.world.police.crime(p, 'run_roadblock', true);
          this.events.push({ player: p, kind: 'roadblock_run' });
        }
      }
      const block = mine && v.driver === p ? this.at(v.x, v.y) : null;
      if (!block) {
        p.checkTimer = 0;
        continue;
      }
      if ((p.handledAt[block.id] ?? -Infinity) > this.time) continue; // dealt with recently
      const speed = Math.hypot(v.vx, v.vy); // stop (slow right down) in the zone to be checked
      p.checkTimer = speed < rb.slowSpeed ? (p.checkTimer ?? 0) + dt : 0;
      if (p.checkTimer < rb.searchSec) continue;
      p.checkTimer = 0;
      p.checkDue = null; // checked in time
      p.handledAt[block.id] = this.time + rb.againSec;
      const stolen = this.stolen(p);
      if ((p.bribedUntil ?? -Infinity) > this.time && !stolen) {
        this.events.push({ player: p, kind: 'roadblock_waved' });
        continue;
      }
      // Search everything you're carrying and the car's trunk.
      const holder = this.world.economy.cargoOf(p);
      const seized = {};
      for (const [good, qty] of Object.entries(holder.items)) {
        if (!config.goods[good]?.illegal) continue;
        holder.add(good, -qty);
        seized[good] = qty;
      }
      if (Object.keys(seized).length) {
        this.world.police.crime(p, 'smuggling', true);
        this.events.push({ player: p, kind: 'roadblock_seized', seized });
      } else if (!stolen) this.events.push({ player: p, kind: 'roadblock_clean' });
      if (stolen) {
        this.world.police.crime(p, v.police ? 'steal_police_car' : 'steal_car', true);
        this.world.impound(v);
        this.events.push({ player: p, kind: 'roadblock_stolen' });
      }
    }
  }

  /** Cash to look the other way: you're waved through checkpoints for a while. */
  bribe(p) {
    const rb = config.roadblocks;
    const where = p.vehicle ?? p;
    if (!this.at(where.x, where.y, 200)) return 'no_roadblock';
    if (this.stolen(p)) return 'stolen_car';
    if ((p.bribedUntil ?? -Infinity) > this.time) return 'already_bribed';
    if (p.cash < rb.bribe) return 'not_enough_cash';
    p.cash -= rb.bribe;
    p.bribedUntil = this.time + rb.bribeSec;
    this.events.push({ player: p, kind: 'roadblock_bribed' });
    return null;
  }

  /** For clients: where the checkpoints are (static). */
  describe() {
    return this.list.map(({ id, zone, horizontal, officer }) => ({ id, ...zone, horizontal, officer }));
  }
}
