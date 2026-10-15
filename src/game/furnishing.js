import { config } from '../config.js';
import { hotbarOf, Slots } from './cargo.js';
import { makeWeapon } from './entities.js';

// Furniture you place in your own home or warehouse: cabinets (storage), beds, sofas ("furniture"),
// tables and chairs.
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

// w: across its front; h: front to back. max: how many of it fit in one home or warehouse.
export const PLACEABLE = {
  cabinet: { w: 46, h: 26, max: 3 },
  bed: { w: 52, h: 88, max: 2 }, // (its foot is the front)
  furniture: { w: 76, h: 34, max: 3 },
  table: { w: 64, h: 40, max: 3 },
  chair: { w: 24, h: 24, max: 8 },
};

/** Its footprint turned `rot` (0, 2: front to back runs along x; 1, 3: along y). */
const dims = (kind, rot) => (rot % 2 ? [PLACEABLE[kind].w, PLACEABLE[kind].h] : [PLACEABLE[kind].h, PLACEABLE[kind].w]);

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
    // Homes nobody lives in yet are furnished (it goes with the home to whoever moves in or buys it).
    for (const b of world.buildings) if (b.furnish && world.homes.isHomeType(b.type)) this.furnishDefaults(b);
  }

  #building(id) {
    return this.world.buildings[id - 1] ?? null;
  }

  /**
   * Where p may furnish, as { b, area }: the home (starter or bought) or owned warehouse they're standing
   * in, or the flat or garage box they rent (area: just that room). A block of flats or a row of garages
   * is its tenants' to furnish, not its owner's: 'tenants' for its owner.
   */
  #ownSpace(p) {
    const w = this.world;
    const home = w.homes.homeOf(p.account);
    const inside = (b) => b && p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
    if (inside(home)) return { b: home };
    const rented = w.homes.rentedRoomAt(p);
    if (rented) return { b: rented.b, area: rented.b.rooms[rented.room] };
    const bought = w.homes.boughtBy(p.account).find(inside);
    if (bought) return bought.rooms ? 'tenants' : { b: bought };
    const wh = w.warehouses.containing(p.x, p.y);
    return wh && wh.owner && wh.owner === p.account ? { b: wh.building } : null;
  }

  /** Is `r` (world) a clear spot inside building b: off its walls, out of doorways and machines, clear of other furniture? */
  fits(b, r, except = null, area = null) {
    if (area && (r.x < area.x || r.y < area.y || r.x + r.w > area.x + area.w || r.y + r.h > area.y + area.h)) return false; // (a rented room's furniture stays in the room)
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

  /** The rect a `kind` takes centred on (x, y), turned `rot` quarter-turns (0 east … 3 north, as #spotFor). */
  #spotAt(kind, x, y, rot) {
    const def = PLACEABLE[kind];
    const [w, h] = rot % 2 ? [def.w, def.h] : [def.h, def.w];
    return { x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h, rot };
  }

  /** A cabinet, bed or sofa selected, inside your own place: set it down where you clicked (`at`: { x, y, rot }),
   *  or (no `at`: E, or on a phone) in front of you, facing `angle`. */
  place(p, angle, at = null) {
    const slot = p.inventory[p.selected];
    const kind = slot?.good;
    if (!PLACEABLE[kind]) return 'nothing_to_place';
    if (p.vehicle || p.hidden || p.jailed) return 'busy';
    const space = this.#ownSpace(p);
    if (space === 'tenants') return 'tenants_furnish';
    if (!space) return 'not_your_place';
    const { b, area } = space;
    const inArea = (it) => !area || (it.x + it.w / 2 > area.x && it.x + it.w / 2 < area.x + area.w && it.y + it.h / 2 > area.y && it.y + it.h / 2 < area.y + area.h);
    const count = [...this.items.values()].filter((it) => it.building === b.id && it.kind === kind && inArea(it)).length; // (a rented room: as many as a home)
    if (count >= PLACEABLE[kind].max) return 'too_many_here';
    if (at && Math.hypot(at.x - p.x, at.y - p.y) > config.furnishing.placeReach) return 'too_far';
    let spot = at ? this.#spotAt(kind, at.x, at.y, at.rot) : this.#spotFor(p, kind, Number.isFinite(angle) ? angle : 0);
    // Not quite clear: slide it to the nearest spot that is (in a small room, like a cabin, the exact
    // spot in front of you rarely fits). Set down in front of you (a phone), it may turn too.
    if (!this.fits(b, spot, null, area)) spot = this.#nearestFit(b, kind, spot, !at, area);
    if (!spot) return 'no_space';
    hotbarOf(p).add(kind, -1);
    this.#add(b, kind, spot, p.account);
    return null;
  }

  /** The clear spot nearest `r` (within config.furnishing.nudge), turned as it is, or (`turn`) either way; null if none. */
  #nearestFit(b, kind, r, turn, area = null) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, max = config.furnishing.nudge;
    let best = null, bestD = Infinity;
    for (const rot of turn ? [r.rot, (r.rot + 1) % 4] : [r.rot]) {
      for (let dy = -max; dy <= max; dy += 4) {
        for (let dx = -max; dx <= max; dx += 4) {
          const d = Math.hypot(dx, dy) + (rot === r.rot ? 0 : max); // (rather as it was turned)
          if (d >= bestD || Math.hypot(dx, dy) > max) continue;
          const t = this.#spotAt(kind, cx + dx, cy + dy, rot);
          if (this.fits(b, t, null, area)) [best, bestD] = [t, d];
        }
      }
    }
    return best;
  }

  #add(b, kind, r, owner, slots = null) {
    const it = { id: this.nextId++, kind, building: b.id, x: r.x, y: r.y, w: r.w, h: r.h, rot: r.rot ?? 0, owner, ownerId: owner?.id ?? null };
    if (kind === 'cabinet') it.slots = slots ?? Array.from({ length: config.furnishing.cabinetSlots }, () => null);
    this.items.set(it.id, it);
    this.#touched(it);
    return it;
  }

  /** A cabinet (or anything) in no building, nobody's: the underground's. */
  addLoose(kind, r) {
    return this.#add({ id: 0 }, kind, r, null);
  }

  #touched(it) {
    this.changed = true;
    if (this.world.warehouses.all.has(it.building)) this.world.warehouses.changed = true;
    else if (this.world.homes.isProperty(it.building)) this.world.homes.changed = true; // (a bought or rented one: saved with the properties)
    else if (it.ownerId) this.homesChanged.add(it.ownerId);
  }

  /** Within arm's reach of a placed thing (its edge). */
  near(p, it) {
    const dx = Math.max(it.x - p.x, 0, p.x - (it.x + it.w)), dy = Math.max(it.y - p.y, 0, p.y - (it.y + it.h));
    return Math.hypot(dx, dy) < config.furnishing.reach + p.radius;
  }

  /** May p open this cabinet? Its owner and their team always (a rented room's: its tenant); anyone else only after a break-in. */
  mayOpen(p, it) {
    if (!it.building) return true; // (out in the open, underground: anyone's)
    const w = this.world;
    const tenant = w.homes.tenantOf(it);
    const holder = tenant ?? it.owner; // (renting a room, the cabinet in it is the tenant's, not the landlord's)
    if (holder && holder === p.account) return true;
    const owner = [...w.players.values()].find((o) => o.account && o.account === holder);
    if (owner && w.areTeammates(owner, p)) return true;
    const wh = w.warehouses.all.get(it.building);
    if (wh) return wh.unlockedUntil >= w.warehouses.time;
    const b = this.#building(it.building);
    return w.homes.picked(b, b?.rooms ? w.homes.roomAt(b, it.x + it.w / 2, it.y + it.h / 2) : -1); // (a flat's or box's cabinet: that one's lock)
  }

  /**
   * Into bed (your own, or a teammate's), at night: you lie with your head on the pillow until you move,
   * press E, get hurt, or it's morning. When everyone's asleep the night's skipped (see the room).
   */
  sleep(p, id) {
    const it = this.items.get(id);
    if (it?.kind !== 'bed' || !this.near(p, it)) return 'too_far';
    if (!this.world.night) return 'not_night';
    if (p.vehicle || p.hidden || p.jailed || p.carrying || p.holdingCat || !p.alive) return 'busy';
    const w = this.world;
    const owner = [...w.players.values()].find((o) => o.account && o.account === it.owner);
    if (it.owner !== p.account && !(owner && w.areTeammates(owner, p))) return 'not_your_bed';
    if ([...w.players.values()].some((o) => o !== p && o.sleeping?.bed === it.id)) return 'bed_taken';
    // The head of the bed is the way its placer faced (its foot, the front, faces back toward them).
    const a = (it.rot * Math.PI) / 2, depth = it.rot % 2 ? it.h : it.w;
    const along = depth / 2 - 16;
    p.sleeping = { bed: it.id, x: it.x + it.w / 2 + Math.cos(a) * along, y: it.y + it.h / 2 + Math.sin(a) * along };
    Object.assign(p, { x: p.sleeping.x, y: p.sleeping.y, vx: 0, vy: 0 });
    return null;
  }

  /** E on a bed, sofa or (empty) cabinet of yours: back into your hotbar. */
  pickUp(p, id) {
    const it = this.items.get(id);
    if (!it || !this.near(p, it)) return 'too_far';
    if (it.owner !== p.account) return 'not_yours';
    if ([...this.world.players.values()].some((o) => o.sleeping?.bed === it.id)) return 'someone_asleep';
    const tenant = this.world.homes.tenantOf(it);
    if (tenant && tenant !== p.account) return 'rented_out'; // (the tenant's storage)
    if (!tenant && this.#building(it.building)?.rooms) return 'tenants_furnish'; // (flats and garage boxes: their tenants furnish them)
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
      it.slots[free] = s.type === 'rod' ? { type: 'rod' } : { type: s.type, ammo: s.ammo, ...(s.illegal ? { illegal: true } : {}) };
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
      const free = p.inventory.indexOf(null);
      if (free < 0) return 'no_room';
      p.inventory[free] = s.type === 'rod' ? { type: 'rod', tool: true } : { ...makeWeapon(s.type), ammo: s.ammo, ...(s.illegal ? { illegal: true } : {}) };
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

  #save(it, withContents = true) {
    const b = this.#building(it.building);
    const local = toLocal(b, it);
    const rot = (((it.rot - (b.rot ?? 0)) % 4) + 4) % 4;
    return { kind: it.kind, x: local.x, y: local.y, w: local.w, h: local.h, rot, ...(it.slots ? { slots: withContents ? it.slots.map((s) => s && { ...s }) : [] } : {}) };
  }

  /** Everything placed in building b, for saving (`contents(it)` false: a cabinet's saved empty; `include(it)` false: left out). */
  saveIn(b, contents = () => true, include = () => true) {
    return [...this.items.values()].filter((it) => it.building === b.id && include(it)).map((it) => this.#save(it, contents(it)));
  }

  /**
   * The furniture a tenant has put in room `room` of b, for keeping with them (`take`: and out it comes —
   * they're moving out). Positions are the room's own, so it goes back the same in their next one.
   */
  tenantFurniture(b, room, accountId, take = false) {
    const local = toLocal(b, b.rooms[room]);
    const out = [];
    for (const it of [...this.items.values()]) {
      if (it.building !== b.id || !accountId || it.ownerId !== accountId || this.world.homes.roomAt(b, it.x + it.w / 2, it.y + it.h / 2) !== room) continue;
      const s = this.#save(it);
      out.push({ ...s, x: s.x - local.x, y: s.y - local.y });
      if (take) {
        this.items.delete(it.id);
        this.changed = true;
      }
    }
    return out;
  }

  /** A tenant's kept furniture set out in their new room (as it was in their last one, or the nearest free spot); returns what didn't fit. */
  loadTenantFurniture(b, room, saved, account) {
    const area = b.rooms[room];
    const local = toLocal(b, area);
    const left = [];
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!PLACEABLE[s?.kind]) continue;
      const rot = (((s.rot ?? 0) % 4) + 4) % 4;
      const [w, h] = dims(s.kind, rot);
      let r = { ...toWorld(b, { x: s.x + local.x, y: s.y + local.y, w, h }), rot: (rot + (b.rot ?? 0)) % 4 };
      if (!this.fits(b, r, null, area)) r = this.#nearestFit(b, s.kind, r, true, area) ?? this.#freeSpot(b, r, area);
      if (r) this.#add(b, s.kind, r, account, s.kind === 'cabinet' ? cleanSlots(s.slots) : null);
      else left.push(s);
    }
    return left;
  }

  /** Set saved furniture back out in building b (owned by `owner`). Anything that no longer fits goes to the nearest free spot; if none, it's returned as left over. */
  loadIn(b, saved, owner) {
    const left = [];
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!PLACEABLE[s?.kind]) continue;
      const slots = s.kind === 'cabinet' ? cleanSlots(s.slots) : null;
      const rot = (((s.rot ?? 0) % 4) + 4) % 4;
      const [w, h] = dims(s.kind, rot); // (its size as it is now, however it was saved)
      let r = { ...toWorld(b, { x: s.x, y: s.y, w, h }), rot: (rot + (b.rot ?? 0)) % 4 };
      // One just like it already there (a tenant's cabinet in their room): it's taken over, not doubled.
      const same = [...this.items.values()].find((it) => it.building === b.id && it.kind === s.kind && Math.abs(it.x - r.x) < 1 && Math.abs(it.y - r.y) < 1 && it.w === r.w && it.h === r.h);
      if (same) {
        Object.assign(same, { owner, ownerId: owner?.id ?? null });
        this.changed = true;
        continue;
      }
      if (!this.fits(b, r)) r = this.#freeSpot(b, r);
      if (r) this.#add(b, s.kind, r, owner, slots);
      else left.push(s);
    }
    return left;
  }

  #freeSpot(b, r, area = null) {
    const box = area ?? { x: b.x + 10, y: b.y + 10, w: b.w - 20, h: b.h - 20 };
    for (let y = box.y; y + r.h < box.y + box.h; y += 10) {
      for (let x = box.x; x + r.w < box.x + box.w; x += 10) {
        const t = { ...r, x, y };
        if (this.fits(b, t, null, area)) return t;
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

  /**
   * Once per session, when they first spawn: their saved home furniture back in their (possibly new)
   * home. Never saved anything: a starter home comes with a bed and a cabinet.
   */
  restoreHome(account, saved) {
    if (!account?.id || this.restoredHomes.has(account.id)) return;
    this.restoredHomes.add(account.id);
    const home = this.world.homes.homeOf(account);
    if (!home) return;
    this.clearUnowned(home); // (what was set out while nobody lived there)
    if (!Array.isArray(saved)) {
      this.loadIn(home, (home.furnish ?? []).filter((f) => STARTER_KINDS.includes(f.kind)), account);
      this.homesChanged.add(account.id);
      return;
    }
    const left = this.loadIn(home, saved, account);
    (this.leftOver ??= new Map()).set(account.id, left);
    this.homesChanged.delete(account.id); // (just as saved)
  }

  /** The furniture a home comes with, set out owned by nobody (homes nobody lives in), or by `owner`. */
  furnishDefaults(b, owner = null) {
    this.loadIn(b, b.furnish ?? [], owner);
    if (!owner) for (const it of this.cabinetsIn(b)) if (!it.owner) this.#stock(it);
  }

  /** Now and then: empty cabinets nobody owns may have something left in them again. */
  restock() {
    for (const it of this.items.values()) if (it.slots && it.building && !it.owner && !this.world.homes.tenantOf(it) && !it.slots.some(Boolean)) this.#stock(it);
  }

  /** Maybe a few things in a cabinet nobody owns: food, a fishing rod, a bat, an old pistol (config.furnishing.loot). */
  #stock(it) {
    const rule = config.furnishing.loot;
    if (Math.random() >= rule.chance) return;
    const n = 1 + Math.floor(Math.random() * rule.most);
    for (let k = 0; k < n; k++) {
      const free = it.slots.indexOf(null);
      if (free < 0) break;
      const what = pick(rule.odds);
      if (config.economy.menu[what]) {
        const stack = it.slots.find((s) => s?.food === what && s.qty < config.economy.foodStack);
        if (stack) stack.qty++;
        else it.slots[free] = { food: what, qty: 1 };
      } else if (what === 'rod') it.slots[free] = { type: 'rod' };
      else if (config.goods[what]) it.slots[free] = { good: what, qty: 1 }; // (the bat)
      else if (config.weapons[what]) {
        const [lo, hi] = rule.pistolAmmo;
        it.slots[free] = { type: what, ammo: Math.min(config.weapons[what].magazineSize, lo + Math.floor(Math.random() * (hi - lo + 1))), illegal: true }; // (nobody's registered it)
      }
    }
  }

  /** Take away whatever nobody owns in building b (the furniture a home was set out with), except what `keep(it)`. */
  clearUnowned(b, keep = () => false) {
    for (const it of [...this.items.values()]) {
      if (it.building !== b.id || it.owner || keep(it)) continue;
      this.items.delete(it.id);
      this.changed = true;
    }
  }

  /** Take everything out of building b (its owner logged off: it was saved first), except what `keep(it)`. */
  removeIn(b, keep = () => false) {
    for (const it of [...this.items.values()]) {
      if (it.building !== b.id || keep(it)) continue;
      this.items.delete(it.id);
      this.changed = true;
    }
  }

  /**
   * Logged off: their home furniture to save (the room saves it), then it's taken out and the home is
   * set out again like any empty one. Restored from the saved list when they next spawn.
   */
  unloadHome(account) {
    const home = this.world.homes.homeOf(account);
    const saved = this.saveHome(account);
    if (home) {
      this.removeIn(home);
      this.furnishDefaults(home);
    }
    this.restoredHomes.delete(account.id);
    this.homesChanged.delete(account.id);
    this.leftOver?.delete(account.id);
    return saved;
  }

  /** Everything in building b changes hands: to `owner`, or to nobody (null), except what `keep(it)` (a tenant's own). */
  handOver(b, owner, keep = () => false) {
    for (const it of this.items.values()) {
      if (it.building !== b.id || keep(it)) continue;
      Object.assign(it, { owner, ownerId: owner?.id ?? null });
      this.changed = true;
    }
  }

  /** The cabinets in building b (with which room each is in). */
  cabinetsIn(b) {
    return [...this.items.values()].filter((it) => it.building === b.id && it.slots);
  }

  /** Anything placed in building b? (A warehouse can't be sold with furniture in it.) */
  anyIn(b) {
    return [...this.items.values()].some((it) => it.building === b.id);
  }
}

/** A random key of `odds` ({ key: relative odds }). */
export function pick(odds) {
  const list = Object.entries(odds);
  let roll = Math.random() * list.reduce((t, [, n]) => t + n, 0);
  return (list.find(([, n]) => (roll -= n) < 0) ?? list[0])[0];
}

/** What a starter home comes with (no table or chairs: there's no room). */
const STARTER_KINDS = ['bed', 'cabinet'];

/** A cabinet slot for the client. */
function slotView(s) {
  if (!s) return null;
  if (s.good) return [s.good, s.qty];
  if (s.food) return [s.food, s.qty, 'food'];
  if (s.type === 'rod') return ['rod', 1, 'rod'];
  return [s.type, s.ammo, 'gun', s.illegal ? 1 : 0];
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
    if (s?.type && config.weapons[s.type]) return { type: s.type, ammo: Math.min(qty(s.ammo), config.weapons[s.type].magazineSize), ...(s.illegal ? { illegal: true } : {}) };
    return null;
  });
}
