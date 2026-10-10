import { config } from '../config.js';

// Homes: every account gets a small starter house (a house or cabin on the map). You spawn there and
// respawn there after dying, and E at the spot inside opens your garage of bought cars.
//
// Homes (houses, cabins, mansions, apartment blocks) are private: their outside doors are locked to
// everyone but the owner. Hold F at a door to pick the lock (a break-in), and it stays open a while.
// Like warehouses, which house is yours is saved as a slot ("house-3": the 3rd house by building id),
// because the map can be regenerated on a restart.

const inside = (b, x, y) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;

export class Homes {
  constructor(world) {
    this.world = world;
    this.time = 0;
    this.owners = new Map(); // building id -> account
    this.byAccount = new Map(); // account id -> building
    this.unlockedUntil = new Map(); // building id -> a picked lock lasts until this (world time)
    this.locked = new Set(world.buildings.filter((b) => config.homes.lockedTypes.includes(b.type)).map((b) => b.id));
    this.onAssign = null; // (account, slot) -> void: save who lives where
  }

  step(dt) {
    this.time += dt;
  }

  /** slot name -> building, for starter houses: "<type>-<n>", the n-th of that type by building id. */
  slots() {
    const out = new Map();
    const seen = {};
    for (const b of this.world.buildings) {
      if (!config.homes.starterTypes.includes(b.type)) continue;
      seen[b.type] = (seen[b.type] ?? 0) + 1;
      out.set(`${b.type}-${seen[b.type]}`, b);
    }
    return out;
  }

  /** The account's home building, or null. */
  homeOf(account) {
    return account?.id ? this.byAccount.get(account.id) ?? null : null;
  }

  /**
   * The account's home, handing them one if they haven't got one yet: the slot they had before if
   * it's still free, otherwise any free starter house. Guests get none.
   */
  assign(account, savedSlot = null) {
    if (!account?.id || account.guest) return null;
    const have = this.byAccount.get(account.id);
    if (have) return have;
    const slots = this.slots();
    let b = savedSlot ? slots.get(savedSlot) : null;
    if (!b || this.owners.has(b.id)) {
      const free = [...slots.values()].filter((x) => !this.owners.has(x.id));
      b = free[Math.floor(Math.random() * free.length)] ?? null;
    }
    if (!b) return null;
    this.owners.set(b.id, account);
    this.byAccount.set(account.id, b);
    for (const [slot, x] of slots) if (x === b && slot !== savedSlot) this.onAssign?.(account, slot);
    return b;
  }

  /** Where you appear at home (and where E opens the garage): the open spot inside nearest its middle. */
  spawnPoint(b) {
    if (b.spawn) return b.spawn;
    const r = this.world.playerOpts.startMass ** 0.5 * 4 + 10;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let best = null;
    for (let x = b.x + r + 14; x < b.x + b.w - r - 14; x += 10) {
      for (let y = b.y + r + 14; y < b.y + b.h - r - 14; y += 10) {
        if (this.world.isBlocked(x, y, r)) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    b.spawn = best ? { x: best.x, y: best.y } : { x: cx, y: cy };
    return b.spawn;
  }

  /** Is p standing by their garage (the spot inside their home)? */
  atGarage(p) {
    const b = this.homeOf(p.account);
    if (!b || p.vehicle) return false;
    const at = this.spawnPoint(b);
    return Math.hypot(at.x - p.x, at.y - p.y) < config.homes.garageReach + p.radius;
  }

  /** Is `door` a locked home door, as far as player p is concerned? */
  lockedFor(door, p) {
    if (!door.exterior || !this.locked.has(door.building)) return false;
    const b = this.world.buildings[door.building - 1];
    const owner = this.owners.get(b.id);
    if (owner && owner === p.account) return false;
    if ((this.unlockedUntil.get(b.id) ?? -Infinity) >= this.time) return false;
    return !inside(b, p.x, p.y); // anyone inside can always get out
  }

  /** A picked lock: anyone can open the doors for a while. */
  unlock(door) {
    this.unlockedUntil.set(door.building, this.time + config.homes.unlockedSec);
  }

  /** [buildingId, ownerName] for every owned home. */
  ownership() {
    return [...this.owners].map(([id, a]) => [id, a.name]);
  }
}
