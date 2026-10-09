import { config } from '../config.js';

// The railway: one straight track right across the map (west → east), the freight station beside it,
// and a freight train that calls every few minutes.
//
//   away     → the train is elsewhere; the next train's export contracts are already posted
//   arriving → it rolls in from the west edge and brakes to a stop at the platform
//   docked   → the station clerk pays contract prices for what the contracts want
//   leaving  → it pulls out east and off the map, and the next contracts go up
//
// Contracts: { good, qty, delivered, price }. Deliveries count toward them (partly is fine) and are
// paid per unit. Delivery jobs also haul contract goods here (see Economy).
// Behind the station a black-market buyer takes contraband any time, at a discount.

export const TRACK_HALF = 40; // the track bed is 80 wide
export const LOCO = 240;
export const WAGON = 190;
export const GAP = 14;

/** Where the railway goes on a map: between the two horizontal roads closest to the middle. */
export function planRailway(width, height, roads, isWet = () => false) {
  const horizontal = roads.filter((r) => r.w > r.h).sort((a, b) => a.y - b.y);
  const gaps = [];
  for (let i = 0; i + 1 < horizontal.length; i++) {
    const top = horizontal[i].y + horizontal[i].h, bottom = horizontal[i + 1].y;
    if (bottom - top > 900) gaps.push((top + bottom) / 2);
  }
  if (!gaps.length) gaps.push(height / 2);
  gaps.sort((a, b) => Math.abs(a - height / 2) - Math.abs(b - height / 2));
  // The station sits just north of the track, between two vertical roads, on dry ground.
  const vertical = roads.filter((r) => r.h > r.w).sort((a, b) => a.x - b.x);
  const slots = [];
  for (let i = -1; i < vertical.length; i++) {
    const left = i < 0 ? 200 : vertical[i].x + vertical[i].w + 150;
    const right = i + 1 < vertical.length ? vertical[i + 1].x - 150 : width - 200;
    if (right - left > 900) slots.push((left + right) / 2);
  }
  slots.sort((a, b) => Math.abs(a - width / 2) - Math.abs(b - width / 2));
  for (const y of gaps) {
    for (const cx of slots) {
      const station = { x: Math.round(cx - 360), y: Math.round(y - TRACK_HALF - 60 - 260), w: 720, h: 260 };
      if (!isWet(station)) return { y: Math.round(y), station };
    }
  }
  return { y: Math.round(gaps[0]), station: { x: Math.round(width / 2 - 360), y: Math.round(gaps[0] - TRACK_HALF - 320), w: 720, h: 260 } };
}

/** The strip buildings, trees and lots keep clear of. */
export const railCorridor = (width, y) => ({ x: 0, y: y - TRACK_HALF - 40, w: width, h: TRACK_HALF * 2 + 80 });

const add = (bag, good, qty) => {
  bag[good] = (bag[good] ?? 0) + qty;
  if (bag[good] <= 0) delete bag[good];
};

export class Railway {
  /** `y`: the track's centre line. `station`: the station building (null if the map has none). */
  constructor(world, y, station) {
    this.world = world;
    this.y = y;
    this.station = station;
    this.length = LOCO + config.railway.wagons * (WAGON + GAP);
    // The locomotive's front stops level with the east end of the station, so the wagons line the platform.
    this.stopX = station ? station.x + station.w + 160 : world.width / 2;
    this.smuggler = station ? { x: station.x + station.w / 2 + 120, y: station.y - 40, angle: -Math.PI / 2 } : null; // round the back
    this.train = { x: -this.length, speed: 0, state: 'away', timer: config.railway.everySec - 60 };
    this.contracts = [];
    this.#postContracts();
  }

  get clerk() {
    return this.station?.npc ?? null;
  }

  /** The train's body as a rect (only while it's on the map). */
  trainRect() {
    const t = this.train;
    if (t.state === 'away') return null;
    return { x: t.x - this.length, y: this.y - 34, w: this.length, h: 68 };
  }

  /** Seconds until the train is in (0 while it's docked). */
  get nextIn() {
    const t = this.train;
    if (t.state === 'docked' || t.state === 'leaving') return 0;
    const travel = (this.stopX + this.length) / config.railway.speed;
    return Math.max(0, Math.round((t.state === 'away' ? t.timer + travel : (this.stopX - t.x) / Math.max(60, t.speed))));
  }

  #postContracts() {
    const r = config.railway;
    const goods = Object.entries(config.goods).filter(([, g]) => !g.illegal && g.tier !== 'raw' && !g.vehicles).map(([k]) => k);
    const n = r.contracts[0] + Math.floor(Math.random() * (r.contracts[1] - r.contracts[0] + 1));
    const picked = [...goods].sort(() => Math.random() - 0.5).slice(0, n);
    this.contracts = picked.map((good) => {
      const base = config.goods[good].base;
      const value = r.contractValue[0] + Math.random() * (r.contractValue[1] - r.contractValue[0]);
      const most = Math.floor(120 / config.goods[good].weight); // about one box truck's worth
      const qty = Math.max(2, Math.min(most, Math.round(value / base / 5) * 5));
      return { good, qty, delivered: 0, price: Math.round(base * r.premium) };
    });
  }

  /** Moves the train. Returns who it killed and which vehicles it wrecked this step (the World deals with them). */
  step(dt) {
    this.killed = [];
    this.wrecked = [];
    if (!this.station) return this;
    const r = config.railway;
    const t = this.train;
    if (t.state === 'away') {
      t.timer -= dt;
      if (t.timer <= 0) Object.assign(t, { state: 'arriving', x: 0, speed: r.speed });
    } else if (t.state === 'arriving') {
      const left = this.stopX - t.x;
      t.speed = Math.max(40, Math.min(r.speed, Math.sqrt(2 * 300 * Math.max(0, left)))); // brake at 300 units/s²
      t.x = Math.min(this.stopX, t.x + t.speed * dt);
      if (t.x >= this.stopX) Object.assign(t, { state: 'docked', speed: 0, timer: r.dockSec });
    } else if (t.state === 'docked') {
      t.timer -= dt;
      if (t.timer <= 0) Object.assign(t, { state: 'leaving', speed: 0 });
    } else {
      t.speed = Math.min(r.speed, t.speed + 200 * dt);
      t.x += t.speed * dt;
      if (t.x - this.length > this.world.width) {
        const travel = (this.stopX + this.length) / r.speed;
        Object.assign(t, { state: 'away', x: -this.length, speed: 0, timer: Math.max(30, r.everySec - r.dockSec - travel * 2) });
        this.#postContracts();
      }
    }
    if (t.state === 'arriving' || t.state === 'leaving') this.#runOver(dt);
    return this;
  }

  /** Anyone on the track in front of a moving train gets thrown aside (and hurt); cars get shoved off. */
  #runOver(dt) {
    const rect = this.trainRect();
    if (!rect || this.train.speed < 30) return;
    const w = this.world;
    const inside = (x, y, r) => x + r > rect.x && x - r < rect.x + rect.w && y + r > rect.y && y - r < rect.y + rect.h;
    const shove = (e, r) => {
      const side = e.y < this.y ? -1 : 1;
      e.y = this.y + side * (rect.h / 2 + r + 2);
    };
    for (const p of w.players.values()) {
      if (!p.alive || p.vehicle || !inside(p.x, p.y, p.radius)) continue;
      shove(p, p.radius);
      p.health -= Math.min(60, this.train.speed * 0.15);
      if (p.health <= 0) this.killed.push(p);
    }
    for (const v of w.vehicles.values()) {
      if (!inside(v.x, v.y, v.radius)) continue;
      shove(v, v.radius);
      v.vx = 0;
      v.vy = 0;
      v.health -= this.train.speed * 0.3 * dt * 30;
      if (v.driver) v.driver.y = v.y;
      if (v.health <= 0) this.wrecked.push(v);
    }
    for (const t of w.townsfolk.people) if (t.inside <= 0 && inside(t.x, t.y, 16)) shove(t, 16);
  }

  // ---- trading -----------------------------------------------------------------------

  #near(p, at) {
    return at && Math.hypot(at.x - p.x, at.y - p.y) < config.railway.reach + p.radius;
  }

  /** Sell `qty` of `good` to the freight clerk toward a contract (the train must be in). */
  deliver(p, good, qty) {
    if (!this.#near(p, this.clerk)) return 'too_far';
    if (this.train.state !== 'docked') return 'no_train';
    const c = this.contracts.find((x) => x.good === good);
    if (!c) return 'not_wanted';
    const holder = this.world.economy.cargoOf(p);
    qty = Math.min(qty, holder.count(good), c.qty - c.delivered);
    if (qty <= 0) return c.delivered >= c.qty ? 'contract_full' : 'not_carrying';
    holder.add(good, -qty);
    c.delivered += qty;
    p.cash += qty * c.price;
    return { qty, paid: qty * c.price };
  }

  /** A delivery job's cargo dropped at the station: it counts toward a matching contract, if any. */
  receive(good, qty) {
    const c = this.contracts.find((x) => x.good === good);
    if (c) c.delivered = Math.min(c.qty, c.delivered + qty);
  }

  /** The back-door buyer: any contraband, any time, for less. */
  sellBlack(p, good, qty) {
    if (!this.#near(p, this.smuggler)) return 'too_far';
    if (!config.goods[good]?.illegal) return 'not_wanted';
    const holder = this.world.economy.cargoOf(p);
    qty = Math.min(qty, holder.count(good));
    if (qty <= 0) return 'not_carrying';
    const price = this.blackPrice(good);
    holder.add(good, -qty);
    p.cash += qty * price;
    return { qty, paid: qty * price };
  }

  blackPrice(good) {
    return Math.round(config.goods[good].base * config.blackMarket.share);
  }

  /** The station panel: train status, contracts, and (for the back door) black-market prices. */
  describe(p) {
    const holder = p ? this.world.economy.cargoOf(p) : null;
    return {
      kind: 'station',
      state: this.train.state,
      nextIn: this.nextIn,
      leavesIn: this.train.state === 'docked' ? Math.round(this.train.timer) : 0,
      contracts: this.contracts.map((c) => ({ ...c, have: holder?.count(c.good) ?? 0 })),
      black: Object.entries(config.goods).filter(([, g]) => g.illegal).map(([good]) => ({ good, price: this.blackPrice(good), have: holder?.count(good) ?? 0 })),
    };
  }

  /** What every client needs to draw the train (sent a few times a second). */
  state() {
    const t = this.train;
    return { x: Math.round(t.x), speed: Math.round(t.speed), state: t.state, nextIn: this.nextIn };
  }
}
