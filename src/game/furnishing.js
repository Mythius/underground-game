import { config } from '../config.js';
import { hotbarOf, Slots } from './cargo.js';
import { makeWeapon } from './entities.js';

// Furniture you place in your own home or warehouse: cabinets (storage), beds and sofas ("furniture").
// They're goods first: made at the furniture factory (or an assembler) or bought at a market, carried
// in, and with one selected you press E to set it down in front of you. Pick it back up with E.
//
// A cabinet holds `cabinetSlots` hotbar slots of anything: goods, food, guns (with their ammo), a
// fishing rod. It opens for its owner and teammates — and for anyone else only after a break-in (the
// home's lock or the warehouse's picked within the last little while).
//
// Positions are kept in the building's own unrotated layout coordinates when saved, so a home or a
// factory moved into another building of the same kind (facing any way) gets its furniture back where
// it was. Homes are saved per account; warehouse furniture goes with the factory's saved layout.

export const PLACEABLE = {
  cabinet: { w: 46, h: 26, max: 3 },
  bed: { w: 88, h: 52, max: 2 },
  furniture: { w: 76, h: 34, max: 3 },
};

/** Rotate rect r a quarter turn clockwise `k` times inside a box W×H (as buildings are turned). */
function turn(r, k, W, H) {
  let { x, y, w, h } = r;
  for (let i = 0; i < k; i++) {
    [x, y, w, h] = [H - y - h, x, h, w];
    [W, H] = [H, W];
  }
  return { x, y, w, h };
}
const overlaps = (a, b, gap = 0) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/** World rect -> the building's unrotated layout coordinates, and back. */
function toLocal(b, r) {
  return turn({ x: r.x - b.x, y: r.y - b.y, w: r.w, h: r.h }, (4 - (b.rot ?? 0)) % 4, b.w, b.h);
}
function toWorld(b, r) {
  const k = b.rot ?? 0;
  const [W, H] = k % 2 ? [b.h, b.w] : [b.w, b.h];
  const t = turn(r, k, W, H);
  return { x: t.x + b.x, y: t.y + b.y, w: t.w, h: t.h };
}

export class Furnishings {
  constructor(world) {
    this.world = world;
    this.items = new Map(); // id -> { id, kind, building, x, y, w, h, rot, owner, ownerId, slots? }
    this.nextId = 1;
    this.changed = true; // the list everyone draws needs sending
    this.homesChanged = new Set(); // account ids whose home furniture needs saving
    this.restoredHomes = new Set(); // account ids whose saved home furniture is already out
  }

  #building(id) {
    return this.world.buildings[id - 1] ?? null;
  }

  /** The building p may furnish: the home or owned warehouse they're standing in. */
  #ownSpace(p) {
    const w = this.world;
    const home = w.homes.homeOf(p.account);
    const inside = (b) => b && p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
    if (inside(home)) return home;
    const wh = w.warehouses.containing(p.x, p.y);
    return wh && wh.owner && wh.owner === p.account ? wh.building : null;
  }

  /** Is `r` (world) a clear spot inside building b: off its walls, out of doorways and machines, clear of other furniture? */
  fits(b, r, except = null) {
    if (r.x < b.x + 6 || r.y < b.y + 6 || r.x + r.w > b.x + b.w - 6 || r.y + r.h > b.y + b.h - 6) return false;
    if (b.walls.some((wall) => overlaps(r, wall, 2))) return false;
    if (b.doors.some((d) => overlaps(r, d, 34))) return false; // keep doorways free
    for (const it of this.items.values()) if (it !== except && overlaps(r, it, 2)) return false;
    const wh = this.world.warehouses.all.get(b.id);
    if (wh) { // not on top of a machine, belt or pallet
      const T = 40;
      for (let ty = Math.floor((r.y - wh.origin.y) / T); ty <= Math.floor((r.y + r.h - wh.origin.y) / T); ty++) {
        for (let tx = Math.floor((r.x - wh.origin.x) / T); tx <= Math.floor((r.x + r.w - wh.origin.x) / T); tx++) if (wh.at(tx, ty)) return false;
      }
    }
    return true;
  }

  /** Does anything placed cover `r`? (Warehouse floors ask before a machine goes down.) */
  covers(r) {
    for (const it of this.items.values()) if (overlaps(r, it, 0)) return true;
    return false;
  }

  /** The rect a `kind` takes set down in front of p facing `angle` (snapped to the four ways). */
  #spotFor(p, kind, angle) {
    const def = PLACEABLE[kind];
    const rot = ((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4;
    const [w, h] = rot % 2 ? [def.w, def.h] : [def.h, def.w]; // the long side across the way you face
    const along = (rot % 2 ? h : w) / 2 + p.radius + 8;
    const cx = p.x + Math.cos((rot * Math.PI) / 2) * along, cy = p.y + Math.sin((rot * Math.PI) / 2) * along;
    return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, rot };
  }

  /** E with a cabinet, bed or sofa selected, inside your own place: set it down in front of you. */
  place(p, angle) {
    const slot = p.inventory[p.selected];
    const kind = slot?.good;
    if (!PLACEABLE[kind]) return 'nothing_to_place';
    if (p.vehicle || p.hidden || p.jailed) return 'busy';
    const b = this.#ownSpace(p);
    if (!b) return 'not_your_place';
    const count = [...this.items.values()].filter((it) => it.building === b.id && it.kind === kind).length;
    if (count >= PLACEABLE[kind].max) return 'too_many_here';
    const spot = this.#spotFor(p, kind, Number.isFinite(angle) ? angle : 0);
    if (!this.fits(b, spot)) return 'no_space';
    hotbarOf(p).add(kind, -1);
    this.#add(b, kind, spot, p.account);
    return null;
  }

  #add(b, kind, r, owner, slots = null) {
    const it = { id: this.nextId++, kind, building: b.id, x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot ?? 0, owner, ownerId: owner?.id ?? null };
    if (kind === 'cabinet') it.slots = slots ?? Array.from({ length: config.furnishing.cabinetSlots }, () => null);
    this.items.set(it.id, it);
    this.#touched(it);
    return it;
  }

  #touched(it) {
    this.changed = true;
    if (this.world.warehouses.all.has(it.building)) this.world.warehouses.changed = true;
    else if (it.ownerId) this.homesChanged.add(it.ownerId);
  }

  /** Within arm's reach of a placed thing (its edge). */
  near(p, it) {
    const dx = Math.max(it.x - p.x, 0, p.x - (it.x + it.w)), dy = Math.max(it.y - p.y, 0, p.y - (it.y + it.h));
    return Math.hypot(dx, dy) < config.furnishing.reach + p.radius;
  }

  /** May p open this cabinet? Its owner and their team always; anyone else only after a break-in. */
  mayOpen(p, it) {
    const w = this.world;
    if (it.owner && it.owner === p.account) return true;
    const owner = [...w.players.values()].find((o) => o.account && o.account === it.owner);
    if (owner && w.areTeammates(owner, p)) return true;
    const wh = w.warehouses.all.get(it.building);
    if (wh) return wh.unlockedUntil >= w.warehouses.time;
    return (w.homes.unlockedUntil.get(it.building) ?? -Infinity) >= w.homes.time;
  }

  /** E on a bed, sofa or (empty) cabinet of yours: back into your hotbar. */
  pickUp(p, id) {
    const it = this.items.get(id);
    if (!it || !this.near(p, it)) return 'too_far';
    if (it.owner !== p.account) return 'not_yours';
    if (it.slots?.some(Boolean)) return 'empty_it_first';
    if (hotbarOf(p).room(it.kind) < 1) return 'no_room';
    hotbarOf(p).add(it.kind, 1);
    this.items.delete(id);
    this.#touched(it);
    return null;
  }

  /** Hotbar slot `index` into the cabinet (goods top up stacks of the same; everything else takes a slot). */
  put(p, id, index) {
    const it = this.items.get(id);
    if (!it?.slots || !this.near(p, it)) return 'too_far';
    if (!this.mayOpen(p, it)) return 'locked';
    const s = p.inventory[index];
    if (!s) return 'nothing_there';
    if (s.tool && s.type !== 'rod') return 'cant_store_tool'; // the foreman's
    if (s.good) {
      const left = new Slots(it.slots, config.cargo.slotWeight).add(s.good, s.qty);
      if (left === s.qty) return 'no_room';
      hotbarOf(p).add(s.good, -(s.qty - left));
    } else if (s.food) {
      const stack = it.slots.find((c) => c?.food === s.food && c.qty < config.economy.foodStack);
      const free = it.slots.indexOf(null);
      if (stack) {
        const moved = Math.min(s.qty, config.economy.foodStack - stack.qty);
        stack.qty += moved;
        s.qty -= moved;
        if (s.qty <= 0) p.inventory[index] = null;
      } else if (free >= 0) {
        it.slots[free] = { food: s.food, qty: s.qty };
        p.inventory[index] = null;
      } else return 'no_room';
    } else {
      const free = it.slots.indexOf(null);
      if (free < 0) return 'no_room';
      it.slots[free] = s.type === 'rod' ? { type: 'rod' } : { type: s.type, ammo: s.ammo };
      p.inventory[index] = null;
    }
    this.#touched(it);
    return null;
  }

  /** Cabinet slot `slot` into your hotbar (as much as fits). */
  take(p, id, slot) {
    const it = this.items.get(id);
    if (!it?.slots || !this.near(p, it)) return 'too_far';
    if (!this.mayOpen(p, it)) return 'locked';
    const s = it.slots[slot];
    if (!s) return 'nothing_there';
    if (s.good) {
      const left = hotbarOf(p).add(s.good, s.qty);
      if (left === s.qty) return 'no_room';
      if (left > 0) s.qty = left;
      else it.slots[slot] = null;
    } else if (s.food) {
      const left = this.world.addFood(p, s.food, s.qty);
      if (left === s.qty) return 'no_room';
      if (left > 0) s.qty = left;
      else it.slots[slot] = null;
    } else {
      if (p.hasWeapon(s.type)) return 'already_have';
      const free = p.inventory.indexOf(null);
      if (free < 0) return 'no_room';
      p.inventory[free] = s.type === 'rod' ? { type: 'rod', tool: true } : { ...makeWeapon(s.type), ammo: s.ammo };
      it.slots[slot] = null;
    }
    this.#touched(it);
    return null;
  }

  /** What everyone draws: [id, kind, x, y, w, h, rot, building, owner name]. */
  list() {
    return [...this.items.values()].map((it) => [it.id, it.kind, it.x, it.y, it.w, it.h, it.rot, it.building, it.owner?.name ?? null]);
  }

  /** A cabinet's contents for the person who has it open: [good, qty] | [type, ammo, 'gun'] | [item, qty, 'food'] | ['rod', 1, 'rod'] | null. */
  contents(p, id) {
    const it = this.items.get(id);
    if (!it?.slots || !this.near(p, it) || !this.mayOpen(p, it)) return null;
    return [it.id, it.slots.map(slotView)];
  }

  // ---- saving: positions in the building's own layout coordinates ----------------------------

  #save(it) {
    const b = this.#building(it.building);
    const local = toLocal(b, it);
    const rot = (((it.rot - (b.rot ?? 0)) % 4) + 4) % 4;
    return { kind: it.kind, x: local.x, y: local.y, w: local.w, h: local.h, rot, ...(it.slots ? { slots: it.slots.map((s) => s && { ...s }) } : {}) };
  }

  /** Everything placed in building b, for saving. */
  saveIn(b) {
    return [...this.items.values()].filter((it) => it.building === b.id).map((it) => this.#save(it));
  }

  /** Set saved furniture back out in building b (owned by `owner`). Anything that no longer fits goes to the nearest free spot; if none, it's returned as left over. */
  loadIn(b, saved, owner) {
    const left = [];
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!PLACEABLE[s?.kind]) continue;
      const slots = s.kind === 'cabinet' ? cleanSlots(s.slots) : null;
      let r = { ...toWorld(b, s), rot: ((s.rot ?? 0) + (b.rot ?? 0)) % 4 };
      if (!this.fits(b, r)) r = this.#freeSpot(b, r);
      if (r) this.#add(b, s.kind, r, owner, slots);
      else left.push(s);
    }
    return left;
  }

  #freeSpot(b, r) {
    for (let y = b.y + 10; y + r.h < b.y + b.h - 10; y += 10) {
      for (let x = b.x + 10; x + r.w < b.x + b.w - 10; x += 10) {
        const t = { ...r, x, y };
        if (this.fits(b, t)) return t;
      }
    }
    return null;
  }

  /** A home's furniture for saving with its account (with anything that didn't fit last time). */
  saveHome(account) {
    const home = this.world.homes.homeOf(account);
    const placed = home ? this.saveIn(home) : [];
    return [...placed, ...(this.leftOver?.get(account.id) ?? [])];
  }

  /** Once per session, when they first spawn: their saved home furniture back in their (possibly new) home. */
  restoreHome(account, saved) {
    if (!account?.id || this.restoredHomes.has(account.id)) return;
    this.restoredHomes.add(account.id);
    const home = this.world.homes.homeOf(account);
    if (!home || !Array.isArray(saved)) return;
    const left = this.loadIn(home, saved, account);
    (this.leftOver ??= new Map()).set(account.id, left);
    this.homesChanged.delete(account.id); // (just as saved)
  }

  /** Anything placed in building b? (A warehouse can't be sold with furniture in it.) */
  anyIn(b) {
    return [...this.items.values()].some((it) => it.building === b.id);
  }
}

/** A cabinet slot for the client. */
function slotView(s) {
  if (!s) return null;
  if (s.good) return [s.good, s.qty];
  if (s.food) return [s.food, s.qty, 'food'];
  if (s.type === 'rod') return ['rod', 1, 'rod'];
  return [s.type, s.ammo, 'gun'];
}

/** Saved cabinet slots back (anything no longer in the game is dropped). */
function cleanSlots(slots) {
  const n = config.furnishing.cabinetSlots;
  const qty = (q) => (Number.isInteger(q) && q > 0 ? q : 0);
  return Array.from({ length: n }, (_, i) => {
    const s = Array.isArray(slots) ? slots[i] : null;
    if (s?.good && config.goods[s.good] && qty(s.qty)) return { good: s.good, qty: s.qty };
    if (s?.food && config.economy.menu[s.food] && qty(s.qty)) return { food: s.food, qty: s.qty };
    if (s?.type === 'rod') return { type: 'rod' };
    if (s?.type && config.weapons[s.type]) return { type: s.type, ammo: Math.min(qty(s.ammo), config.weapons[s.type].magazineSize) };
    return null;
  });
}
