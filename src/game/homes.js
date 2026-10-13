import { config } from '../config.js';

// Homes: every account gets a small starter house (a house or cabin on the map). You spawn there and
// respawn there after dying, and E on the car pad outside it opens your garage of bought cars.
//
// Homes (houses, cabins, mansions, apartment blocks) are private: their outside doors are locked to
// everyone but the owner. Hold F at a door to pick the lock (a break-in), and it stays open a while.
// Like warehouses, which house is yours is saved as a slot ("house-3": the 3rd house by building id),
// because the map can be regenerated on a restart.
//
// On top of the starter home you can buy homes (config.homes.prices: cabins, houses, mansions,
// panelkas, rows of garages), one of each type. They come furnished, and you place and move furniture
// in them as at home. Like factories they're saved; after a restart (a new map) you load what you had
// (its furniture) into a free home of the same type. Panelka flats and garage boxes can be rented as
// locked storage (the cabinet in each): rent comes out of the tenant's bank every dawn and goes to the
// building's owner, who also gets a little from NPC tenants for the rooms no player rents.

const inside = (b, x, y) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;
const within = (r, x, y, m = 0) => x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.h + m;

export class Homes {
  constructor(world) {
    this.world = world;
    this.time = 0;
    this.owners = new Map(); // building id -> account
    this.byAccount = new Map(); // account id -> building
    this.unlockedUntil = new Map(); // building id (or "<id>:<room>", a flat or garage box) -> a picked lock lasts until this (world time)
    this.locked = new Set(world.buildings.filter((b) => config.homes.lockedTypes.includes(b.type)).map((b) => b.id));
    this.onAssign = null; // (account, slot) -> void: save who lives where
    this.bought = new Map(); // building id -> { owner (account), ownerId, spent }
    this.rentals = new Map(); // "<building id>:<room>" -> { tenant (account), tenantId }
    // Homes owned (and rooms rented) before a restart: [{ accountId, kind: 'own' | 'rent', slot, data }].
    // An owned one waits for its owner to load it into a free home of the same type; a tenant's stored
    // things go into the cabinet of the next room they rent of that type.
    this.stored = [];
    this.changed = false; // something worth saving happened
    this.events = []; // { account, kind, ... } for the room to pass on to whoever's playing
    this.lastDay = null;
  }

  step(dt) {
    this.time += dt;
    const day = this.world.dayNumber;
    if (day === undefined || day === null) return;
    if (this.lastDay !== null && day !== this.lastDay) this.#payDay();
    this.lastDay = day;
  }

  // ---- buying, selling and renting -------------------------------------------------------

  /** Can this type of building be bought as a home? */
  isHomeType(type) {
    return type in config.homes.prices;
  }

  /** A bought home, or one with rooms to rent (its furniture is saved with the properties). */
  isProperty(id) {
    return this.bought.has(id) || Boolean(this.world.buildings[id - 1]?.rooms);
  }

  /** The homes `account` has bought. */
  boughtBy(account) {
    if (!account?.id) return [];
    return [...this.bought].filter(([, o]) => o.ownerId === account.id).map(([id]) => this.world.buildings[id - 1]);
  }

  /** Who owns building b: whoever lives there (a starter home) or bought it. */
  ownerOf(b) {
    return this.owners.get(b.id) ?? this.bought.get(b.id)?.owner ?? null;
  }

  /** Which of b's rooms (x, y) is in, or -1. */
  roomAt(b, x, y, margin = 0) {
    return (b.rooms ?? []).findIndex((r) => within(r, x, y, margin));
  }

  /** The tenant of the room a placed thing is in, if that room's rented. */
  tenantOf(it) {
    const b = this.world.buildings[it.building - 1];
    if (!b?.rooms) return null;
    const room = this.roomAt(b, it.x + it.w / 2, it.y + it.h / 2);
    return room < 0 ? null : this.rentals.get(`${b.id}:${room}`)?.tenant ?? null;
  }

  /** The room `account` rents in a building of this type: { b, room } or null. */
  #rentalOf(account, type) {
    for (const [key, r] of this.rentals) {
      if (r.tenantId !== account?.id) continue;
      const [id, room] = key.split(':').map(Number);
      const b = this.world.buildings[id - 1];
      if (b?.type === type) return { b, room };
    }
    return null;
  }

  /** The cabinet in room `room` of building b, if there is one. */
  #cabinetIn(b, room) {
    return this.world.furnishings.cabinetsIn(b).find((it) => this.roomAt(b, it.x + it.w / 2, it.y + it.h / 2) === room) ?? null;
  }

  /**
   * Everything players do with homes: buy, bring (load a saved one in), sell (the owner); rent and leave
   * (a room). Returns an error code, or null.
   */
  action(p, msg) {
    const b = this.world.buildings[msg.id - 1];
    if (!b || !this.isHomeType(b.type)) return 'unknown';
    const account = p.account;
    if (!account?.id || account.guest) return 'need_account';
    const c = config.homes;
    const near = inside(b, p.x, p.y) || Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h))) < c.buyReach;
    if (!near) return 'too_far';
    const own = this.bought.get(b.id);
    const mine = own?.ownerId === account.id;
    const furn = this.world.furnishings;
    const result = (() => {
      if (msg.action === 'buy' || msg.action === 'bring') {
        if (own) return 'already_owned';
        if (this.owners.has(b.id)) return 'someones_home';
        if (this.boughtBy(account).some((x) => x.type === b.type)) return 'one_per_type';
        const saved = this.stored.find((r) => r.kind === 'own' && r.accountId === account.id && r.data.type === b.type);
        if (msg.action === 'buy') {
          if (saved) return 'load_saved_instead'; // (you had one of these before the restart: load it)
          const price = c.prices[b.type];
          if (account.bank < price) return 'not_enough_bank';
          account.bank -= price;
          this.bought.set(b.id, { owner: account, ownerId: account.id, spent: price });
          furn.handOver(b, account); // it comes furnished
          this.world.onBankChange?.(account);
          return null;
        }
        if (!saved) return 'nothing_stored';
        this.stored.splice(this.stored.indexOf(saved), 1);
        this.bought.set(b.id, { owner: account, ownerId: account.id, spent: saved.data.spent ?? c.prices[b.type] });
        furn.clearUnowned(b, (it) => this.tenantOf(it)); // (a tenant's cabinet stays, with their things in it)
        furn.loadIn(b, saved.data.furnishings, account); // your furniture, cabinets and all
        return null;
      }
      if (msg.action === 'sell') {
        if (!mine) return 'not_owner';
        const rooms = b.rooms ?? [];
        const yours = furn.cabinetsIn(b).filter((it) => !this.tenantOf(it));
        if (yours.some((it) => it.slots.some(Boolean))) return 'empty_cabinets_first';
        rooms.forEach((_, i) => this.rentals.has(`${b.id}:${i}`) && this.#evict(`${b.id}:${i}`, 'sold'));
        account.bank += Math.floor(own.spent * c.sellBack);
        this.bought.delete(b.id);
        furn.handOver(b, null); // the furniture stays with the house
        this.world.onBankChange?.(account);
        return null;
      }
      if (msg.action === 'rent' || msg.action === 'leave') {
        const room = msg.room | 0;
        if (!b.rooms?.[room]) return 'no_such_room';
        const key = `${b.id}:${room}`;
        const rental = this.rentals.get(key);
        if (msg.action === 'leave') {
          if (rental?.tenantId !== account.id) return 'not_your_room';
          this.#evict(key, 'left');
          return null;
        }
        if (rental) return 'room_taken';
        if (mine) return 'its_yours';
        if (this.#rentalOf(account, b.type)) return 'one_per_type';
        const rent = c.rent[b.type] ?? 0;
        if (account.bank < rent) return 'not_enough_bank';
        account.bank -= rent; // the first day, up front
        if (own) own.owner.bank += rent;
        this.rentals.set(key, { tenant: account, tenantId: account.id });
        // Anything kept from your last room of this kind goes in the cabinet.
        const saved = this.stored.find((r) => r.kind === 'rent' && r.accountId === account.id && r.data.type === b.type);
        const cab = this.#cabinetIn(b, room);
        if (saved && cab && !cab.slots.some(Boolean)) {
          this.stored.splice(this.stored.indexOf(saved), 1);
          cab.slots = cab.slots.map((_, i) => saved.data.slots?.[i] ?? null);
          furn.changed = true;
        }
        this.world.onBankChange?.(account);
        if (own) this.world.onBankChange?.(own.owner);
        return null;
      }
      return 'unknown';
    })();
    if (result === null) this.changed = true;
    return result;
  }

  /** A tenant out of their room: what was in its cabinet is kept for their next room of this kind. */
  #evict(key, why) {
    const rental = this.rentals.get(key);
    if (!rental) return;
    const [id, room] = key.split(':').map(Number);
    const b = this.world.buildings[id - 1];
    const cab = this.#cabinetIn(b, room);
    if (cab?.slots.some(Boolean)) {
      const kept = this.stored.find((r) => r.kind === 'rent' && r.accountId === rental.tenantId && r.data.type === b.type);
      if (kept) { // (already keeping some: what fits goes with it)
        for (const s of cab.slots) { const i = kept.data.slots.indexOf(null); if (s && i >= 0) kept.data.slots[i] = s; }
      } else this.stored.push({ accountId: rental.tenantId, kind: 'rent', slot: null, data: { type: b.type, slots: cab.slots.map((s) => s && { ...s }) } });
      cab.slots = cab.slots.map(() => null);
      this.world.furnishings.changed = true;
    }
    this.rentals.delete(key);
    this.changed = true;
    if (why !== 'left') this.events.push({ account: rental.tenant, kind: 'evicted', why, type: b.type });
  }

  /** Dawn: tenants pay their rent (or they're out), and owners of flats and garages get the NPCs' rent too. */
  #payDay() {
    const c = config.homes;
    const touched = new Set();
    for (const [key, r] of [...this.rentals]) {
      const b = this.world.buildings[Number(key.split(':')[0]) - 1];
      const rent = c.rent[b.type] ?? 0;
      if (r.tenant.bank < rent) {
        this.#evict(key, 'unpaid');
        continue;
      }
      r.tenant.bank -= rent;
      touched.add(r.tenant);
      const own = this.bought.get(b.id);
      if (own) {
        own.owner.bank += rent;
        touched.add(own.owner);
        this.events.push({ account: own.owner, kind: 'rent_in', amount: rent, from: r.tenant.name, type: b.type });
      }
      this.events.push({ account: r.tenant, kind: 'rent_paid', amount: rent, type: b.type });
    }
    for (const [id, own] of this.bought) {
      const b = this.world.buildings[id - 1];
      const rooms = b.rooms?.length ?? 0;
      if (!rooms) continue;
      const free = rooms - [...Array(rooms).keys()].filter((i) => this.rentals.has(`${id}:${i}`)).length;
      const amount = Math.round((c.npcRent * free) / rooms);
      if (amount <= 0) continue;
      own.owner.bank += amount;
      touched.add(own.owner);
      this.events.push({ account: own.owner, kind: 'rent_in', amount, from: null, type: b.type });
    }
    for (const a of touched) this.world.onBankChange?.(a);
    this.changed = true;
  }

  /**
   * Logged off: their starter home is free again (they get it back next time if nobody's taken it),
   * and each home they bought is put away as after a restart, to bring back into a free one of the
   * type. Tenants keep their rooms and what's in them. Returns the starter home's furniture to save.
   */
  unload(account) {
    if (!account?.id) return null;
    const furn = this.world.furnishings;
    const items = furn.unloadHome(account);
    const home = this.byAccount.get(account.id);
    if (home) {
      this.owners.delete(home.id);
      this.byAccount.delete(account.id);
    }
    for (const b of this.boughtBy(account)) {
      const own = this.bought.get(b.id);
      const tenants = (it) => Boolean(this.tenantOf(it));
      this.stored.push({ accountId: own.ownerId, kind: 'own', slot: null, data: { type: b.type, spent: own.spent, furnishings: furn.saveIn(b, (it) => !tenants(it)) } });
      this.bought.delete(b.id);
      furn.removeIn(b, tenants);
      furn.furnishDefaults(b); // (set out like any home nobody owns; a tenant's cabinet is left as it is)
      this.changed = true;
    }
    return items;
  }

  /** For the clients: every home that's someone's, [id, owner name | null, 1 if a starter home, [tenant name | null per room] | null]. */
  describe() {
    const out = [];
    for (const b of this.world.buildings) {
      if (!this.isHomeType(b.type)) continue;
      const starter = this.owners.get(b.id);
      const own = this.bought.get(b.id);
      const rooms = b.rooms ? b.rooms.map((_, i) => this.rentals.get(`${b.id}:${i}`)?.tenant.name ?? null) : null;
      if (!starter && !own && !rooms?.some(Boolean)) continue;
      out.push([b.id, (starter ?? own?.owner)?.name ?? null, starter ? 1 : 0, rooms]);
    }
    return out;
  }

  /** What `account` has waiting from before a restart: { own: [types], rent: [types] }. */
  storedFor(account) {
    const mine = this.stored.filter((r) => r.accountId === account?.id);
    return { own: mine.filter((r) => r.kind === 'own').map((r) => r.data.type), rent: mine.filter((r) => r.kind === 'rent').map((r) => r.data.type) };
  }

  /** Rows to save: every bought home (with its furniture), every rented room's storage, and what's still waiting. */
  toSave() {
    const furn = this.world.furnishings;
    const rows = [];
    for (const [id, own] of this.bought) {
      const b = this.world.buildings[id - 1];
      const furnishings = furn.saveIn(b, (it) => !this.tenantOf(it)); // (a tenant's things are saved with the tenant)
      rows.push({ accountId: own.ownerId, kind: 'own', slot: null, data: { type: b.type, spent: own.spent, furnishings } });
    }
    for (const [key, r] of this.rentals) {
      const [id, room] = key.split(':').map(Number);
      const b = this.world.buildings[id - 1];
      const cab = this.#cabinetIn(b, room);
      rows.push({ accountId: r.tenantId, kind: 'rent', slot: null, data: { type: b.type, slots: cab ? cab.slots.map((s) => s && { ...s }) : [] } });
    }
    return [...rows, ...this.stored];
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
    if (!b || this.owners.has(b.id) || this.bought.has(b.id)) {
      const free = [...slots.values()].filter((x) => !this.owners.has(x.id) && !this.bought.has(x.id));
      const withPad = free.filter((x) => this.padOf(x)); // houses with a car pad outside first
      const pick = withPad.length ? withPad : free;
      b = pick[Math.floor(Math.random() * pick.length)] ?? null;
    }
    if (!b) return null;
    this.world.furnishings?.clearUnowned(b); // (what was set out while nobody lived there: they bring their own, or get a bed and a cabinet)
    this.owners.set(b.id, account);
    this.byAccount.set(account.id, b);
    for (const [slot, x] of slots) if (x === b && slot !== savedSlot) this.onAssign?.(account, slot);
    return b;
  }

  /** Where you appear at home: the open spot inside nearest its middle. */
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

  /** The car pad outside a starter house, or null if none fit there. */
  padOf(b) {
    return this.world.pads?.find((x) => x.building === b.id) ?? null;
  }

  /** Where E opens the garage: the middle of the car pad outside (inside, where you spawn, if it has none). */
  garagePoint(b) {
    const pad = this.padOf(b);
    return pad ? { x: pad.x + pad.w / 2, y: pad.y + pad.h / 2 } : this.spawnPoint(b);
  }

  /** Every spot `account` can bring a car out at: their home's pad, and the spot inside each garage they've bought. [{ b, x, y, pad, starter }] */
  garageSpots(account) {
    const out = [];
    const home = this.homeOf(account);
    if (home) out.push({ b: home, ...this.garagePoint(home), pad: this.padOf(home), starter: true });
    for (const b of this.boughtBy(account)) {
      const s = b.carSpot;
      if (!s) continue;
      const along = Math.abs(Math.cos(s.angle)) > 0.5; // (the car lies along x)
      const [w, h] = along ? [100, 50] : [50, 100];
      out.push({ b, x: s.x, y: s.y, pad: { x: s.x - w / 2, y: s.y - h / 2, w, h, angle: s.angle }, starter: false });
    }
    return out;
  }

  /** The spot p's standing at to bring out a car, or null. */
  garageAt(p) {
    if (p.vehicle) return null;
    return this.garageSpots(p.account).find((g) => Math.hypot(g.x - p.x, g.y - p.y) < config.homes.garageReach + p.radius) ?? null;
  }

  /** Is p standing by one of their garages (the car pad outside their home, or a garage they've bought)? */
  atGarage(p) {
    return Boolean(this.garageAt(p));
  }

  /**
   * Is `door` a locked home door, as far as player p is concerned? A rented room's door opens for its
   * tenant; the rest of a home's for its owner (nobody's: locked to all, short of picking it).
   */
  lockedFor(door, p) {
    if (!door.exterior) return false;
    const b = this.world.buildings[door.building - 1];
    if (!b || (!this.locked.has(b.id) && !b.rooms)) return false;
    if (inside(b, p.x, p.y)) return false; // anyone inside can always get out
    if (b.rooms) {
      const room = this.roomAt(b, door.x + door.w / 2, door.y + door.h / 2, 30);
      if (this.picked(b, room)) return false;
      const rental = room >= 0 ? this.rentals.get(`${b.id}:${room}`) : null;
      if (rental) return rental.tenant !== p.account;
      const owner = this.bought.get(b.id)?.owner;
      if (owner) return owner !== p.account;
      return this.locked.has(b.id);
    }
    if (this.picked(b)) return false;
    const owner = this.ownerOf(b);
    return !(owner && owner === p.account);
  }

  /** A picked lock: anyone can open the door for a while (a flat's or garage box's: just that one). */
  unlock(door) {
    const b = this.world.buildings[door.building - 1];
    const room = b?.rooms ? this.roomAt(b, door.x + door.w / 2, door.y + door.h / 2, 30) : -1;
    this.unlockedUntil.set(room >= 0 ? `${door.building}:${room}` : door.building, this.time + config.homes.unlockedSec);
  }

  /** Is b's lock picked just now (room: one flat's or garage box's)? */
  picked(b, room = -1) {
    return (this.unlockedUntil.get(room >= 0 ? `${b.id}:${room}` : b.id) ?? -Infinity) >= this.time;
  }

  /** [buildingId, ownerName] for every owned home. */
  ownership() {
    return [...this.owners].map(([id, a]) => [id, a.name]);
  }
}
