import { config } from '../config.js';

// Where carried goods live. Everything is slots: one kind of good per slot, up to a weight per slot.
//   Slots     — a hotbar (guns in some slots are skipped) or a vehicle's trunk.
//   Combined  — what a player can trade with: their hotbar plus the vehicle they're with, as one.
// All share: count(good), room(good), add(good, qty), items ({ good: qty }), clone().

const weight = (good) => config.goods[good].weight;

export class Slots {
  /**
   * `slots` is mutated in place: entries are guns ({ type, … }, never touched), goods ({ good, qty }) or null.
   * `accepts(good)` limits what may go in (e.g. new cars only in pickups and trucks).
   */
  constructor(slots, slotWeight, accepts = () => true) {
    this.slots = slots;
    this.slotWeight = slotWeight;
    this.accepts = accepts;
  }

  /** Units of `good` one slot holds. */
  perSlot(good) {
    return this.accepts(good) ? Math.floor(this.slotWeight / weight(good)) : 0;
  }

  count(good) {
    return this.slots.reduce((sum, s) => sum + (s?.good === good ? s.qty : 0), 0);
  }

  room(good) {
    const per = this.perSlot(good);
    return this.slots.reduce((sum, s) => sum + (s === null ? per : s.good === good ? per - s.qty : 0), 0);
  }

  get items() {
    const out = {};
    for (const s of this.slots) if (s?.good) out[s.good] = (out[s.good] ?? 0) + s.qty;
    return out;
  }

  /** Adds goods (topping up existing stacks, then empty slots) or, with a negative qty, removes them (last stacks first). */
  add(good, qty) {
    const per = this.perSlot(good);
    if (qty > 0) {
      for (const s of this.slots) {
        if (qty <= 0) break;
        if (s?.good !== good) continue;
        const put = Math.min(qty, per - s.qty);
        s.qty += put;
        qty -= put;
      }
      for (let i = 0; i < this.slots.length && qty > 0; i++) {
        if (this.slots[i] !== null) continue;
        const put = Math.min(qty, per);
        this.slots[i] = { good, qty: put };
        qty -= put;
      }
    } else {
      qty = -qty;
      for (let i = this.slots.length - 1; i >= 0 && qty > 0; i--) {
        const s = this.slots[i];
        if (s?.good !== good) continue;
        const take = Math.min(qty, s.qty);
        s.qty -= take;
        qty -= take;
        if (s.qty <= 0) this.slots[i] = null;
      }
    }
    return qty; // whatever didn't fit / wasn't there
  }

  clone() {
    return new Slots(this.slots.map((s) => (s?.good ? { ...s } : s)), this.slotWeight, this.accepts);
  }
}

/** A player's hotbar: free slots carry goods. */
export const hotbarOf = (player) => new Slots(player.inventory, config.cargo.slotWeight);

/** A vehicle's trunk. */
export const trunkOf = (vehicle) =>
  new Slots(vehicle.cargo, config.cargo.vehicleSlotWeight, (good) => !config.goods[good].vehicles || config.goods[good].vehicles.includes(vehicle.type));

/**
 * Several holders acting as one. Taking empties the first holder first (the hotbar); putting fills
 * the last first (the vehicle), so produce goes in the car and your hands stay free.
 */
export class Combined {
  constructor(parts) {
    this.parts = parts;
  }

  count(good) {
    return this.parts.reduce((sum, p) => sum + p.count(good), 0);
  }

  room(good) {
    return this.parts.reduce((sum, p) => sum + p.room(good), 0);
  }

  get items() {
    const out = {};
    for (const p of this.parts) for (const [g, q] of Object.entries(p.items)) out[g] = (out[g] ?? 0) + q;
    return out;
  }

  add(good, qty) {
    if (qty > 0) {
      for (const p of [...this.parts].reverse()) {
        const put = Math.min(qty, p.room(good));
        if (put > 0) p.add(good, put);
        qty -= put;
      }
    } else {
      qty = -qty;
      for (const p of this.parts) {
        const take = Math.min(qty, p.count(good));
        if (take > 0) p.add(good, -take);
        qty -= take;
      }
    }
  }

  clone() {
    return new Combined(this.parts.map((p) => p.clone()));
  }
}

/** Would taking `remove` and then adding `add` ({ good: qty } each) fit in this holder? */
export function fits(holder, remove, add) {
  const test = holder.clone();
  for (const [g, q] of Object.entries(remove)) {
    if (test.count(g) < q) return false;
    test.add(g, -q);
  }
  for (const [g, q] of Object.entries(add)) {
    if (test.room(g) < q) return false;
    test.add(g, q);
  }
  return true;
}
