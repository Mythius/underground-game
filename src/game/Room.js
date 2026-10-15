import { config } from '../config.js';
import { PLACEABLE } from './furnishing.js';
import { ServerMsg, encode } from '../net/protocol.js';
import { logger } from '../utils/logger.js';
import { round1 } from '../utils/math.js';
import { Environment } from './Environment.js';
import { Teams } from './teams.js';
import { World, createWorld } from './World.js';
import { makeWeapon } from './entities.js';
import { ACHIEVEMENTS, earn, fromMessage, fromState } from './achievements.js';

/** Asleep, as far as skipping the night goes: in bed, or in a dumpster. */
const asleep = (p) => Boolean(p.sleeping || p.hidden?.dumpster);

/** Hotbar slots as saved on the account: guns by type and ammo, goods and food by kind and count (borrowed tools go back). In prison: what the warden's keeping. */
export function carriedSlots(p) {
  return (p.jailed?.stash ?? p.inventory).map((s) => (s?.type === 'rod' ? { type: 'rod' } : s?.type === 'bunkerkey' ? { type: 'bunkerkey' } : !s || s.tool ? null : s.good ? { good: s.good, qty: s.qty } : s.food ? { food: s.food, qty: s.qty } : { type: s.type, ammo: s.ammo, ...(s.illegal ? { illegal: true } : {}) }));
}

/** Saved hotbar slots back into a player's hotbar (anything no longer in the game is dropped). */
export function restoreSlots(p, slots) {
  if (!Array.isArray(slots)) return;
  const qty = (n) => (Number.isInteger(n) && n > 0 ? n : 0);
  const inv = p.inventory.map((_, i) => {
    const s = slots[i];
    if (s?.good && config.goods[s.good] && qty(s.qty)) return { good: s.good, qty: s.qty };
    if (s?.food && config.economy.menu[s.food] && qty(s.qty)) return { food: s.food, qty: s.qty };
    if (s?.type === 'rod') return { type: 'rod', tool: true };
    if (s?.type === 'bunkerkey') return { type: 'bunkerkey', tool: true };
    if (s?.type && config.weapons[s.type]) return { ...makeWeapon(s.type), ammo: Math.min(qty(s.ammo), config.weapons[s.type].magazineSize), ...(s.illegal ? { illegal: true } : {}) };
    return null;
  });
  if (!inv.some((s) => s?.type === p.inventory[0]?.type)) { // never without the starting knife
    const free = inv.indexOf(null);
    if (free !== -1) inv[free] = p.inventory[0];
  }
  p.inventory = inv;
}

let nextRoomId = 1;

/** A game instance: one World, its clients, and its fixed-timestep loop. */
export class Room {
  /**
   * With `store` (an AccountStore) owned warehouses are saved and come back after a restart.
   * `kind` 'underground' is the world under the town: built from `map`, keeping the town's `env` (its
   * clock and weather) and saving only what players carry, never homes, factories or cars.
   */
  constructor(map = null, store = null, { kind = 'town', env = null } = {}) {
    this.id = `room-${nextRoomId++}`;
    this.kind = kind;
    this.store = store;
    this.world = kind === 'town' ? createWorld(config.world, config.player, config.weapons, map) : new World(config.world, config.player, config.weapons, map);
    this.#restoreWarehouses();
    this.#restoreProperties();
    this.teams = new Teams();
    this.#wireWorld();
    this.carSaveTimer = 0;
    this.ownEnv = !env; // (a borrowed clock is stepped by the room it belongs to)
    this.env = env ?? new Environment();
    this.lastOwners = '';
    this.lastProps = '';
    this.sentLayouts = new Map(); // warehouse id -> layout version last broadcast
    this.saveTimer = 0;
    this.lastEnvBroadcast = 0;
    this.clients = new Set();
    this.timer = null;
    this.stepMs = 1000 / config.tickRate;
    // Snapshots go out every N simulation ticks so they're evenly spaced for client interpolation.
    this.ticksPerSnapshot = Math.max(1, Math.round(config.tickRate / config.snapshotRate));
    this.snapshotRate = config.tickRate / this.ticksPerSnapshot;
    this.stats = { avgTickMs: 0, maxTickMs: 0 };
  }

  get size() {
    return this.clients.size;
  }

  get isFull() {
    return this.clients.size >= config.maxPlayersPerRoom;
  }

  // ---- lifecycle -------------------------------------------------------

  start() {
    if (this.timer) return;
    const now = performance.now();
    this.lastTime = now;
    this.lastLeaderboard = now;
    this.accumulator = 0;
    this.timer = setInterval(() => this.#loop(), this.stepMs);
    logger.info('room started', { room: this.id });
  }

  stop() {
    for (const c of this.clients) if (c.player?.alive) this.#saveCarried(c.player);
    this.#saveHomes();
    this.#saveWarehouses();
    this.#saveProperties();
    this.#saveCars();
    clearInterval(this.timer);
    this.timer = null;
    logger.info('room stopped', { room: this.id });
  }

  #loop() {
    const start = performance.now();
    // Cap catch-up so a long GC pause doesn't trigger a spiral of death.
    this.accumulator += Math.min(start - this.lastTime, 250);
    this.lastTime = start;

    while (this.accumulator >= this.stepMs) {
      this.#step(this.stepMs / 1000);
      this.accumulator -= this.stepMs;
      if (this.world.tick % this.ticksPerSnapshot === 0) this.#sendSnapshots();
    }

    if (start - this.lastLeaderboard >= config.leaderboardIntervalMs) {
      this.lastLeaderboard = start;
      this.broadcast({ t: ServerMsg.LEADERBOARD, entries: this.world.leaderboard() });
    }

    const elapsed = performance.now() - start;
    this.stats.avgTickMs = this.stats.avgTickMs * 0.95 + elapsed * 0.05;
    this.stats.maxTickMs = Math.max(this.stats.maxTickMs, elapsed);
    if (elapsed > this.stepMs) logger.warn('slow tick', { room: this.id, ms: round1(elapsed) });
  }

  /** One fixed step of the game (the loop's, and tests'). */
  step(dt) {
    this.#step(dt);
  }

  #step(dt) {
    if (this.ownEnv) this.env.step(dt);
    this.world.gripScale = 1 - (1 - config.environment.rainGrip) * this.env.intensity('rain');
    this.world.frozen = this.env.season.name === 'winter';
    this.world.night = this.env.isNight;
    this.world.dayClock = this.env.clock; // seconds into the day (meal times at the prison)
    this.world.dayNumber = Math.floor(this.env.time / this.env.cycle);
    if (this.env.time - this.lastEnvBroadcast >= config.environment.broadcastEverySec) {
      this.lastEnvBroadcast = this.env.time;
      this.broadcast({ t: ServerMsg.ENV, ...this.env.state() });
    }
    this.world.onBankChange = this.onBankChange;
    const { deaths, doorChanges, explosions } = this.world.step(dt);
    this.#sleep(dt);
    if (this.world.tick % config.tickRate === 0) for (const c of this.clients) if (c.player) for (const id of fromState(c.player)) this.#earn(c, id);
    // Tell players about arrests, releases, robberies and new stars.
    // Roadblock searches, raids on warehouses (to their owner) and on shops (everyone hears), the train.
    // Work sites: what changed at the rock face / in the fields, and what happened to whom.
    const changed = this.world.work.changed.splice(0);
    if (changed.length) this.broadcast({ t: ServerMsg.NODES, list: [...new Set(changed)].map((n) => [n.id, n.hp]) });
    for (const e of this.world.work.events.splice(0)) {
      const { player, ...rest } = e;
      const c = this.#clientForPlayer(player);
      if (e.kind === 'error') c?.send({ t: ServerMsg.ERROR, code: e.code });
      else c?.send({ t: ServerMsg.POLICE, ...rest });
    }
    for (const e of this.world.fishing.events.splice(0)) {
      const { player, ...rest } = e;
      this.#clientForPlayer(player)?.send({ t: ServerMsg.POLICE, ...rest });
    }
    for (const e of this.world.wolves.events.splice(0)) {
      const { player, ...rest } = e;
      this.#clientForPlayer(player)?.send({ t: ServerMsg.POLICE, ...rest });
    }
    for (const e of this.world.bodies.events.splice(0)) {
      const { player, ...rest } = e;
      this.#clientForPlayer(player)?.send({ t: ServerMsg.POLICE, ...rest });
    }
    for (const e of this.world.hires.events.splice(0)) {
      const { player, ...rest } = e;
      this.#clientForPlayer(player)?.send({ t: ServerMsg.POLICE, ...rest });
    }
    for (const e of this.world.cats.events.splice(0)) {
      const { player, ...rest } = e;
      if (player) this.#clientForPlayer(player)?.send({ t: ServerMsg.POLICE, ...rest });
    }
    for (const e of this.world.prison.events.splice(0)) {
      const { player, ...rest } = e;
      if (player) this.#clientForPlayer(player)?.send({ t: ServerMsg.POLICE, ...rest });
      else this.broadcast({ t: ServerMsg.POLICE, ...rest }); // (the hole in the wall: everyone sees it)
    }
    for (const e of this.world.roadblocks.events.splice(0)) {
      const { player, ...rest } = e;
      this.#clientForPlayer(player)?.send({ t: ServerMsg.POLICE, ...rest });
    }
    for (const e of this.world.warehouses.events.splice(0)) {
      for (const c of this.clients) if (c.account && c.account === e.account) c.send({ t: ServerMsg.POLICE, kind: 'warehouse_raid', building: e.building, seized: e.seized });
    }
    for (const e of this.world.economy.events.splice(0)) this.broadcast({ t: ServerMsg.NEWS, ...e });
    if (this.world.railway && this.world.tick % 10 === 0) this.broadcast({ t: ServerMsg.TRAIN, ...this.world.railway.state() });
    for (const e of this.world.police.events.splice(0)) {
      const client = this.#clientForPlayer(e.player);
      const { player, ...rest } = e;
      if (e.kind === 'error') client?.send({ t: ServerMsg.ERROR, code: e.code });
      else client?.send({ t: ServerMsg.POLICE, ...rest });
    }
    // Tell everyone when a warehouse changes hands or its layout changes.
    const warehouses = this.world.warehouses;
    if (this.world.tick % 5 === 0) {
      const list = [...warehouses.ownership(), ...this.world.economy.siteOwners()];
      const owners = JSON.stringify(list);
      if (owners !== this.lastOwners) {
        this.lastOwners = owners;
        this.broadcast({ t: ServerMsg.OWNERS, list });
      }
      for (const w of warehouses.all.values()) {
        if (this.sentLayouts.get(w.id) === w.version) continue;
        this.sentLayouts.set(w.id, w.version);
        this.broadcast({ t: ServerMsg.WAREHOUSE, layout: w.layout() });
      }
    }
    // What's moving inside warehouses, to whoever's close enough to look in (10 times a second).
    if (this.world.tick % 3 === 0) {
      const live = new Map();
      for (const c of this.clients) {
        const p = c.player;
        if (!p?.alive) continue;
        const list = [];
        for (const w of warehouses.all.values()) {
          if (!w.owner) continue;
          const b = w.building;
          if (Math.abs(b.x + b.w / 2 - p.x) > 1200 || Math.abs(b.y + b.h / 2 - p.y) > 900) continue;
          if (!live.has(w)) live.set(w, w.live());
          list.push(live.get(w));
        }
        if (list.length) c.send({ t: ServerMsg.WH_LIVE, list });
      }
    }
    this.carSaveTimer += dt;
    if (this.carSaveTimer >= config.homes.saveCarsEverySec) {
      this.#saveCars();
      for (const c of this.clients) if (c.player?.alive) this.#saveCarried(c.player); // (in case the server goes down)
    }
    this.saveTimer += dt;
    if (this.saveTimer >= config.warehouses.saveEverySec || (warehouses.changed && this.saveTimer >= 2)) this.#saveWarehouses();
    // Homes: who owns and rents what (everyone sees), rent days, and saving.
    const homes = this.world.homes;
    if (this.world.tick % 5 === 0) {
      const list = homes.describe();
      const props = JSON.stringify(list);
      if (props !== this.lastProps) {
        this.lastProps = props;
        this.broadcast({ t: ServerMsg.PROPS, list });
      }
    }
    for (const e of homes.events.splice(0)) {
      const { account, ...rest } = e;
      for (const c of this.clients) if (c.account && c.account === account) c.send({ t: ServerMsg.POLICE, ...rest });
    }
    this.propSaveTimer = (this.propSaveTimer ?? 0) + dt;
    if (this.propSaveTimer >= config.warehouses.saveEverySec || (homes.changed && this.propSaveTimer >= 2)) this.#saveProperties();
    // ATMs smashed with a bat: everyone sees which (and they mend themselves; clients count down).
    if (this.world.atmsChanged) {
      this.world.atmsChanged = false;
      this.broadcast({ t: ServerMsg.ATMS, broken: this.world.brokenAtmList() });
    }
    // Furniture: everyone redraws when it moves; homes are saved with their accounts.
    const furnish = this.world.furnishings;
    if (furnish.changed) {
      furnish.changed = false;
      this.broadcast({ t: ServerMsg.FURNISH, list: furnish.list() });
    }
    if (furnish.homesChanged.size && this.world.tick % 30 === 0) this.#saveHomes();
    for (const d of doorChanges) this.broadcast({ t: ServerMsg.DOOR, id: d.id, open: d.open });
    for (const e of explosions) this.broadcast({ t: ServerMsg.BOOM, x: e.x, y: e.y });
    for (const { victim, killer } of deaths) {
      // What they carried is on their body now: nothing to come back with.
      // (Died inside the wire: the warden still has your things, and you'll be back in the camp.)
      if (victim.account?.id && !victim.account.guest) this.#store('setCarried', victim.account.id, 0, victim.jailed?.prison ? carriedSlots(victim) : null);
      const client = this.#clientForPlayer(victim);
      if (client) {
        client.player = null;
        client.send({ t: ServerMsg.DIED, killedBy: killer.name, score: victim.score });
        for (const c of [client, ...this.teams.mates(client)]) this.teams.changed.add(c);
      }
      this.broadcast({ t: ServerMsg.PLAYER_LEFT, id: victim.id });
    }
    if (this.teams.changed.size) this.#sendTeams();
  }

  /**
   * Everyone's up at dawn; at night, once every player's been asleep a little while — in a bed, or
   * curled up in a dumpster — it's morning. (Those in a dumpster stay in it.)
   */
  #sleep(dt) {
    const alive = [...this.world.players.values()].filter((p) => p.alive);
    if (!this.env.isNight) {
      for (const p of alive) p.sleeping = null;
      this.allAsleepFor = 0;
      return;
    }
    if (!alive.length || !alive.every(asleep)) {
      this.allAsleepFor = 0;
      return;
    }
    this.allAsleepFor = (this.allAsleepFor ?? 0) + dt;
    if (this.allAsleepFor < config.homes.sleepSkipSec) return;
    this.allAsleepFor = 0;
    this.env.time += this.env.cycle - this.env.clock; // to the first moment of the next day
    for (const p of alive) p.sleeping = null;
    this.lastEnvBroadcast = this.env.time;
    this.broadcast({ t: ServerMsg.ENV, ...this.env.state() });
    this.broadcast({ t: ServerMsg.POLICE, kind: 'slept' });
    logger.info('night skipped: everyone slept', { room: this.id, players: alive.length });
  }

  /** Hooks from the world to this room: teams, and saving homes and bought cars. */
  #wireWorld() {
    const w = this.world;
    w.areTeammates = (a, b) => {
      const ca = this.#clientForPlayer(a);
      const team = ca && this.teams.teamOf(ca);
      return Boolean(team && [...team].some((c) => c.player === b));
    };
    w.homes.onAssign = (account, slot) => this.store?.setHomeSlot(account.id, slot);
    w.onCarBought = (v) => {
      if (!this.store || !v.owner?.id || v.owner.guest) return;
      v.carId = this.store.addCar(v.owner.id, { type: v.type, color: v.color, fuel: v.fuel, cargo: v.cargo });
    };
    w.onCarLost = (v) => this.#saveCar(v);
    w.onCopChange = (account) => !account.guest && this.#store('setCop', account.id, account.cop);
    w.hires.online = (account) => [...this.clients].some((c) => c.account === account);
    w.hires.onCrewChange = (account) => account.id && !account.guest && this.#store('setCrew', account.id, w.hires.crewSave(account));
    w.onFinesChange = (account) => account.id && !account.guest && this.#store('setFines', account.id, account.fines);
    w.prison.onChange = (account) => account.id && !account.guest && this.#store('setPrison', account.id, account.prison ?? null);
  }

  /** Homes, factories and cars are saved from the town (the underground has none of its own). */
  get #persists() {
    return Boolean(this.store) && this.kind === 'town';
  }

  /** A store call that can't take the game down if the database has a problem. */
  #store(method, ...args) {
    if (!this.store) return;
    try {
      this.store[method](...args);
    } catch (err) {
      logger.error(`store.${method} failed`, { err: err.message });
    }
  }

  /** Cash and hotbar onto the account. */
  /** Save the furniture in the homes that changed. */
  #saveHomes() {
    if (!this.#persists) return;
    const furnish = this.world.furnishings;
    for (const id of furnish.homesChanged) {
      const account = this.store?.live(id);
      if (account) this.#store('setHomeItems', id, furnish.saveHome(account));
    }
    furnish.homesChanged.clear();
  }

  /** Closed the game: their homes, factories and cars out on the road are saved and taken off the map (not when they just die). */
  #unload(account) {
    if (!account?.id || account.guest || !this.#persists) return;
    if ([...this.clients].some((c) => c.account?.id === account.id)) return; // (still playing in another tab)
    try {
      const carIds = this.store.cars(account.id).map((c) => c.id);
      for (const v of this.world.vehicles.values()) if (v.carId && carIds.includes(v.carId)) this.#saveCar(v);
      const items = this.world.unloadAccount(account, carIds);
      if (items) this.#store('setHomeItems', account.id, items);
      this.#saveProperties();
      this.#saveWarehouses();
    } catch (err) {
      logger.error('unloading a player\'s things failed', { err: err.message });
    }
  }

  #saveCarried(p) {
    if (p.account?.id && !p.account.guest) this.#store('setCarried', p.account.id, p.cash, carriedSlots(p));
  }

  #saveCar(v) {
    try {
      this.store?.saveCar(v.carId, { fuel: Math.round(v.fuel * 10) / 10, cargo: v.cargo });
    } catch (err) {
      logger.error('saving a car failed', { err: err.message });
    }
  }

  /** Fuel and trunks of saved cars out on the road. */
  #saveCars() {
    this.carSaveTimer = 0;
    if (!this.#persists) return;
    for (const v of this.world.vehicles.values()) if (v.carId) this.#saveCar(v);
  }

  /** Garage (E at the spot inside your home): 'list' your saved cars, or 'take' one out. */
  garage(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const saved = this.store && client.account?.id && !client.account.guest ? this.store.cars(client.account.id) : [];
    if (msg.action === 'take') {
      const car = saved.find((c) => c.id === msg.id);
      if (car) this.#saveCars(); // (so a car that's out comes back with what's in it now)
      const fresh = car && this.store.cars(client.account.id).find((c) => c.id === msg.id);
      const error = fresh ? this.world.bringCar(p, fresh) : 'unknown';
      if (error) return client.send({ t: ServerMsg.ERROR, code: error });
      client.send({ t: ServerMsg.DONE, what: 'garage_take', type: fresh.type });
    }
    const out = new Map([...this.world.vehicles.values()].filter((v) => v.carId).map((v) => [v.carId, v]));
    client.send({
      t: ServerMsg.GARAGE,
      cars: saved.map((c) => [c.id, c.type, c.color, Math.round(out.get(c.id)?.fuel ?? c.fuel), out.has(c.id) ? 1 : 0]),
    });
  }

  /** Bought homes and rented rooms back from the database: each waits for its owner (or tenant) to load it in. */
  #restoreProperties() {
    if (!this.#persists) return;
    this.world.homes.stored = this.store.loadProperties();
    if (this.world.homes.stored.length) logger.info('saved homes waiting to be loaded', { room: this.id, count: this.world.homes.stored.length });
  }

  #saveProperties() {
    this.propSaveTimer = 0;
    this.world.homes.changed = false;
    if (!this.#persists) return;
    try {
      this.store.saveProperties(this.world.homes.toSave());
    } catch (err) {
      logger.error('saving homes failed', { err: err.message });
    }
  }

  /** Owned factories back from the database: each waits for its owner to load it into a free warehouse of the same size. */
  #restoreWarehouses() {
    if (!this.#persists) return;
    this.world.warehouses.stored = this.store.loadWarehouses();
    if (this.world.warehouses.stored.length) logger.info('saved factories waiting to be loaded', { room: this.id, count: this.world.warehouses.stored.length });
  }

  #saveWarehouses() {
    this.saveTimer = 0;
    this.world.warehouses.changed = false;
    if (!this.#persists) return;
    try {
      this.store.saveWarehouses(this.world.warehouses.toSave());
    } catch (err) {
      logger.error('saving warehouses failed', { err: err.message });
    }
  }

  #clientForPlayer(player) {
    for (const c of this.clients) if (c.player === player) return c;
    return null;
  }

  // ---- client management ----------------------------------------------

  addClient(client) {
    this.clients.add(client);
    client.room = this;
    client.onSend = (msg) => this.#earn(client, fromMessage(msg));
    client.send({
      t: ServerMsg.WELCOME,
      clientId: client.id,
      roomId: this.id,
      world: { width: this.world.width, height: this.world.height, kind: this.kind },
      underground: this.world.underground?.layout ?? null, // the maze down there: its grid of cells and what's in it
      tickRate: config.tickRate,
      snapshotRate: this.snapshotRate,
      buildings: this.world.buildings,
      doorReach: config.world.doorReach,
      vehicles: { reach: config.vehicles.reach, types: config.vehicles.types, boost: config.vehicles.boost, knockDecay: config.vehicles.knockDecay },
      homes: {
        lockedTypes: config.homes.lockedTypes, garageReach: config.homes.garageReach,
        prices: config.homes.prices, rent: config.homes.rent, sellBack: config.homes.sellBack, npcRent: config.homes.npcRent, buyReach: config.homes.buyReach, // buying and renting homes
        props: this.world.homes.describe(), // who owns and rents what
      },
      brokenAtms: this.world.brokenAtmList(),
      visionSec: config.economy.visionSec,
      furnish: { list: this.world.furnishings.list(), kinds: PLACEABLE, cabinetSlots: config.furnishing.cabinetSlots, reach: config.furnishing.reach, placeReach: config.furnishing.placeReach, nudge: config.furnishing.nudge },
      cats: { reach: config.cats.reach },
      crows: { reach: config.crows.reach },
      fishing: { rodPrice: config.fishing.rodPrice, pulls: config.fishing.pulls, lineReach: config.fishing.lineReach, cast: config.fishing.cast },
      env: this.env.state(),
      achievements: ACHIEVEMENTS,
      rainGrip: config.environment.rainGrip,
      gravelGrip: config.vehicles.gravelGrip,
      looks: config.looks,
      gunstore: config.gunstore,
      dealership: config.dealership,
      shop: { reach: config.economy.shopReach, menu: config.economy.menu, shopkeepers: this.world.shopkeepers },
      goods: config.goods,
      cargo: { slotWeight: config.cargo.slotWeight, vehicleSlotWeight: config.cargo.vehicleSlotWeight, trunkReach: config.cargo.trunkReach, vehicles: config.cargo.vehicles },
      factories: config.factories,
      factoryRules: { reach: config.factory.reach, marketReach: config.markets.reach, pumpReach: config.fuel.pumpReach },
      owners: [...this.world.warehouses.ownership(), ...this.world.economy.siteOwners()],
      // Rocks, trees and wheat at the work sites: [id, kind, x, y, r, hp, max].
      nodes: [...this.world.work.nodes.values()].map((n) => [n.id, n.kind, n.x, n.y, n.r, n.hp, n.max]),
      prisonWall: [this.world.prison.wallHits ?? 0, config.prison.wallHits], // how far the digging at the inner fence has got
      prisonLocked: Boolean(this.world.prison.lockdown), // the cell doors are locked for the night
      railway: this.world.railway?.station
        ? { y: this.world.railway.y, stopX: this.world.railway.stopX, length: this.world.railway.length, station: this.world.railway.station.id, smuggler: this.world.railway.smuggler, wagons: config.railway.wagons, reach: config.railway.reach, ...this.world.railway.state() }
        : null,
      roadblocks: { list: this.world.roadblocks.describe(), bribe: config.roadblocks.bribe },
      warehouses: {
        recipes: Object.fromEntries([
          ...Object.entries(config.factories).flatMap(([f, d]) => d.recipes.map((r, i) => [`${f}:${i}`, { ...r, sec: d.sec }])),
          ...Object.entries(config.illegalRecipes).map(([k, r]) => [`illegal:${k}`, { ...r, illegal: true }]),
        ]),
        sizes: config.warehouses.sizes,
        machines: config.machines,
        belts: config.belts,
        dockReach: config.warehouses.dockReach,
        containerCapacity: config.warehouses.containerCapacity,
        beltSpeed: config.warehouses.beltSpeed,
        sellBack: config.warehouses.sellBack,
        layouts: [...this.world.warehouses.all.values()].map((w) => w.layout()),
      },
      bank: { atms: this.world.atms, tellers: this.world.tellers, atmReach: config.economy.atmReach, tellerReach: config.economy.bankReach },
      terrain: {
        roads: this.world.roads,
        paths: this.world.paths,
        trails: this.world.trails,
        trees: this.world.trees,
        forests: this.world.forests,
        water: this.world.water,
        rails: this.world.rails,
        lamps: this.world.lamps,
        atms: this.world.atms,
        blocks: this.world.blocks,
        dumpsters: this.world.dumpsters,
        vents: this.world.vents, // sewer vents (E: inspect — the client makes something up)
        lots: this.world.lots,
        city: this.world.city, // asphalt + sidewalks inside, gravel outside (null: asphalt everywhere)
        bays: this.world.bays,
        pads: this.world.pads, // car pads outside starter houses (garages)
      },
      // Lets the client predict its own movement with the server's formula.
      player: {
        ...Object.fromEntries(
          ['baseSpeed', 'startMass', 'speedExponent', 'swimSpeed', 'iceGrip', 'sprintMultiplier', 'staminaMax', 'staminaDrainPerSec', 'staminaRegenPerSec', 'staminaRegenDelaySec', 'staminaMinToSprint'].map(
            (k) => [k, config.player[k]],
          ),
        ),
        carrySpeed: config.bodies.carrySpeed, // walking with a body over your shoulder
      },
      weapons: Object.fromEntries(
        Object.entries(config.weapons).map(([type, w]) => [type, { name: w.name, magazineSize: w.magazineSize, reloadSec: w.reloadSec, barrel: w.barrel, melee: w.melee ?? false, cooldownSec: w.cooldownSec }]),
      ),
    });
  }

  /** Swap in a new map: everyone's sent back to the menu and gets the new world. */
  loadMap(map) {
    for (const c of this.clients) if (c.player?.alive) this.#saveCarried(c.player); // they keep what they carried
    for (const c of this.clients) c.player = null;
    this.#saveWarehouses();
    this.#saveProperties();
    this.#saveCars();
    this.world = createWorld(config.world, config.player, config.weapons, map);
    this.#restoreWarehouses();
    this.#restoreProperties();
    this.#wireWorld();
    this.lastOwners = '';
    this.lastProps = '';
    this.sentLayouts.clear();
    for (const c of [...this.clients]) {
      this.clients.delete(c);
      this.addClient(c);
      c.send({ t: ServerMsg.MAP_CHANGED });
    }
  }

  /** `travel`: they're off to the other world (what they carry was taken out first), not logging off. */
  removeClient(client, { travel = false } = {}) {
    if (!this.clients.delete(client)) return;
    client.onSend = null;
    this.teams.remove(client);
    this.#sendTeams();
    if (client.player && travel) {
      this.world.removePlayer(client.player.id);
      this.broadcast({ t: ServerMsg.PLAYER_LEFT, id: client.player.id });
    } else if (client.player) {
      // Logging off alive: what they carry goes with the account (not onto the ground).
      const p = client.player;
      if (p.alive && p.account?.id && !p.account.guest) {
        this.#saveCarried(p);
        p.cash = 0;
        p.inventory = p.inventory.map(() => null);
      }
      this.world.removePlayer(client.player.id);
      this.broadcast({ t: ServerMsg.PLAYER_LEFT, id: client.player.id });
    }
    client.player = null;
    client.room = null;
    if (!travel) this.release(client.account);
  }

  /** Their account's gone from the game (closed it, here or in the other world): put their things away. */
  release(account) {
    if (!account || [...this.clients].some((c) => c.account === account)) return;
    this.#unload(account);
    const crew = this.world.hires.unload(account); // (a guest's crew isn't kept)
    if (crew && account.id && !account.guest) this.#store('setCrew', account.id, crew);
  }

  /**
   * Off to the other world: what they carry (cash, hotbar, health) comes off their player here, and
   * they leave this room. Null if they can't go just now (dead, in a car, carrying someone, jailed).
   */
  takeOut(client) {
    const p = client.player;
    if (!p?.alive || p.vehicle || p.carrying || p.holdingCat || p.jailed || p.hidden) return null;
    const carry = { cash: p.cash, inventory: p.inventory, selected: p.selected, health: p.health, mass: p.mass, stamina: p.stamina };
    p.cash = 0;
    p.inventory = p.inventory.map(() => null); // (so nothing drops here)
    this.removeClient(client, { travel: true });
    return carry;
  }

  /** In from the other world at `spot` (or anywhere open), with what they carried there. */
  bringIn(client, carry, spot = null) {
    this.spawn(client, client.name, client.look ?? null, { travel: true });
    const p = client.player;
    if (!p) return;
    if (spot) Object.assign(p, { x: spot.x, y: spot.y });
    if (carry) {
      Object.assign(p, { cash: carry.cash, inventory: carry.inventory, selected: carry.selected, health: carry.health, mass: carry.mass, stamina: carry.stamina });
      this.#saveCarried(p);
    }
    this.world.rebuildGrid();
  }

  /** Spawn (or respawn) a player for this client. */
  /** client.account is set before this (the browser's account, or a guest one whose money isn't saved). */
  spawn(client, name, look, { travel = false } = {}) {
    if (client.player?.alive) return;
    const account = client.account;
    client.look = look; // (kept for going between worlds)
    const town = this.kind === 'town' && !travel; // (homes, a crew and a sentence come back in town, once)
    if (account?.id && !account.guest && name !== 'Player' && this.store?.setName) {
      // My things are labelled with the name I play under (if nobody else has it).
      const was = account.name;
      if (this.store.setName(account.id, name) === 'taken') client.send({ t: ServerMsg.ERROR, code: 'name_taken', name: account.name });
      else if (account.name !== was) {
        this.world.furnishings.changed = true; // (owners and homes are re-sent when their lists change)
        for (const w of this.world.warehouses.all.values()) if (w.owner === account) w.version++;
      }
    }
    if (account?.id && !account.guest && this.kind === 'town') {
      this.world.homes.assign(account, this.store?.homeSlot(account.id) ?? null);
      this.world.furnishings.restoreHome(account, account.homeItems); // (once a session)
    }
    const player = this.world.spawnPlayer(name, look, account);
    player.account = client.account;
    if (account?.id && !account.guest && town) this.world.hires.restore(player, account.crew); // my goons and guards, back from when I left (once a session)
    player.achStart = { x: player.x, y: player.y }; // (walking away from here is the first achievement)
    // Back with what they had on them when they last left.
    if (account?.id && !account.guest && !travel) {
      player.cash = account.cash ?? 0;
      restoreSlots(player, account.carried);
    }
    if (account?.prison && this.kind === 'town') this.world.prison.jail(player, 0, account.prison); // still serving a sentence
    client.player = player;
    client.name = player.name;
    client.send({
      t: ServerMsg.SPAWNED,
      playerId: player.id,
      account: client.account?.guest ? null : client.account?.name ?? null, // to tell which warehouses are mine
      players: [...this.world.players.values()].map((p) => p.publicInfo),
      achievements: client.account?.achievements ?? [],
    });
    this.broadcast({ t: ServerMsg.PLAYER_JOINED, ...player.publicInfo }, client);
    for (const c of [client, ...this.teams.mates(client)]) this.teams.changed.add(c); // my new player id, for their maps
    this.#sendTeams();
  }

  chat(client, text) {
    if (!client.name) return client.send({ t: ServerMsg.ERROR, code: 'join_first' });
    if (!client.chatLimiter.tryConsume()) return client.send({ t: ServerMsg.ERROR, code: 'chat_too_fast' });
    const color = client.player?.color ?? '#999';
    (client.recentChat ??= []).push(text); // (sent along with any report about them)
    if (client.recentChat.length > 10) client.recentChat.shift();
    this.broadcast({ t: ServerMsg.CHAT, id: client.player?.id ?? null, name: client.name, color, text });
  }

  buy(client, item) {
    const p = client.player;
    if (!p?.alive) return;
    const error = this.world.buy(p, item);
    if (error) client.send({ t: ServerMsg.ERROR, code: error });
    else client.send({ t: ServerMsg.BOUGHT, item, cash: p.cash });
  }

  eat(client) {
    const p = client.player;
    if (!p?.alive) return;
    const error = this.world.eat(p);
    if (error) client.send({ t: ServerMsg.ERROR, code: error });
    else this.#earn(client, 'eat');
  }

  /** Achievement `id` earned (if it's new: saved, and they're told). */
  #earn(client, id) {
    const account = client.player?.account ?? client.account;
    if (!id || !earn(account, id)) return;
    if (account.id && !account.guest) this.#store('setAchievements', account.id, account.achievements);
    client.send({ t: ServerMsg.ACHIEVE, id });
  }

  /** Markets and factories: describe, trade, factory actions and refuelling. */
  inspect(client, id) {
    // The prison warden: your sentence, and bail for anyone inside.
    const prison = this.world.prison;
    if (prison.building && id === prison.building.id) return client.player?.alive && client.send({ t: ServerMsg.PLACE, ...prison.describe(client.player) });
    // A Militsiya front desk: join up (answer the questions) or hand in your badge.
    const desk = this.world.police.stations.find((s) => s.id === id);
    if (desk) return client.player?.alive && client.send({ t: ServerMsg.PLACE, ...this.world.police.describeDesk(client.player, desk) });
    // The laundry machine in the shed on the panelka.
    const shed = this.world.buildings[id - 1];
    if (shed?.type === 'laundry') {
      const p = client.player;
      return p?.alive && client.send({ t: ServerMsg.PLACE, kind: 'laundry', id, owner: this.world.ownsLaundry(p, shed), cash: p.cash, bank: p.account?.bank ?? 0 });
    }
    // The bar: the barman's list of muscle for hire, and yours.
    const hires = this.world.hires;
    if (hires.bar && id === hires.bar.id) return client.player?.alive && client.send({ t: ServerMsg.PLACE, ...hires.describe(client.player) });
    // The station: its freight clerk (building id) or the black-market buyer round the back (−id).
    const rail = this.world.railway;
    if (rail?.station && Math.abs(id) === rail.station.id) {
      return client.send({ t: ServerMsg.PLACE, id, ...rail.describe(client.player?.alive ? client.player : null), kind: id > 0 ? 'station' : 'black' });
    }
    const place = this.world.economy.describe(id, client.player?.account ?? client.account, client.player?.alive ? client.player : null);
    if (place) client.send({ t: ServerMsg.PLACE, ...place });
  }

  economyAction(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const eco = this.world.economy;
    let error;
    let extra = {};
    if (msg.t === 'job') {
      error = msg.action === 'list' ? null : eco.jobAction(p, msg.action, msg.id);
      if (error) return client.send({ t: ServerMsg.ERROR, code: error });
      if (msg.action !== 'list') client.send({ t: ServerMsg.DONE, what: `job_${msg.action}` });
      return client.send({ t: ServerMsg.JOBS, ...eco.jobBoard(p) });
    }
    if (msg.t === 'work') {
      const result = eco.workAction(p, msg.id, msg.action);
      if (typeof result === 'string') return client.send({ t: ServerMsg.ERROR, code: result });
      client.send({ t: ServerMsg.DONE, what: `work_${msg.action}`, ...result });
      return this.inspect(client, msg.id);
    }
    if (msg.t === 'wh') {
      error = this.world.warehouses.action(p, msg);
      if (error) return client.send({ t: ServerMsg.ERROR, code: error });
      return client.send({ t: ServerMsg.DONE, what: `wh_${msg.action}` });
    }
    if (msg.t === 'buygun') error = eco.buyGun(p, msg.id, msg.type);
    else if (msg.t === 'buycar') error = eco.buyVehicle(p, msg.id, msg.type);
    else if (msg.t === 'trade' && msg.side === 'under') {
      const result = eco.underTable(p, msg.id, msg.good, msg.qty);
      if (typeof result === 'string') error = result;
      else extra = result;
    } else if (msg.t === 'trade') error = eco.trade(p, msg.id, msg.good, msg.qty, msg.side);
    else if (msg.t === 'factory' && msg.action === 'process') {
      const result = eco.process(p, msg.id);
      if (typeof result === 'string') error = result;
      else extra = result;
    } else if (msg.t === 'factory') error = eco.factoryAction(p, msg.id, msg.action);
    else {
      if (msg.can) extra = { good: p.inventory[p.selected]?.good }; // fuel or vodka (before it's poured)
      error = msg.can ? this.world.pourFuel(p) : eco.refuel(p);
    }
    if (error) return client.send({ t: ServerMsg.ERROR, code: error });
    const what = msg.t === 'factory' ? msg.action : msg.t === 'trade' ? msg.side : msg.t === 'refuel' ? (msg.can ? 'pour' : 'refuel') : msg.t;
    client.send({ t: ServerMsg.DONE, what, good: msg.good, qty: msg.qty, type: msg.type, ...extra }); // (a pour says which good went in)
    if (msg.id !== undefined) this.inspect(client, msg.id);
  }

  /** Furniture: put it down, pick it up, and use a cabinet. */
  /** Homes: buy one, load a saved one in, sell it; rent a flat or garage box, or leave it. */
  homeAction(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const error = this.world.homes.action(p, msg);
    if (error) return client.send({ t: ServerMsg.ERROR, code: error });
    client.send({ t: ServerMsg.DONE, what: `home_${msg.action}`, id: msg.id, room: msg.room });
    this.#saveProperties();
  }

  furnish(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const f = this.world.furnishings;
    let error = null;
    if (msg.action === 'place') error = f.place(p, msg.angle, msg.at ?? null);
    else if (msg.action === 'pickup') error = f.pickUp(p, msg.id);
    else if (msg.action === 'sleep') error = f.sleep(p, msg.id);
    else if (msg.action === 'open') {
      const it = f.items.get(msg.id);
      error = !it?.slots || !f.near(p, it) ? 'too_far' : !f.mayOpen(p, it) ? 'locked' : null;
      if (!error) p.openCabinet = it.id;
    } else if (msg.action === 'close') p.openCabinet = null;
    else if (msg.action === 'put') error = f.put(p, msg.id, msg.slot);
    else if (msg.action === 'take') error = f.take(p, msg.id, msg.slot);
    if (error) client.send({ t: ServerMsg.ERROR, code: error });
  }

  /** The laundry machine: cash into the bank, without the tax inspector noticing. */
  launder(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const result = this.world.launder(p, msg.amount);
    if (typeof result === 'string') return client.send({ t: ServerMsg.ERROR, code: result });
    this.onBankChange?.(p.account);
    client.send({ t: ServerMsg.DONE, what: 'laundered', ...result, cash: p.cash, bank: p.account.bank });
  }

  /** A gangster: sell him your vodka (up to vodkaPerSale bottles). */
  gangster(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const result = this.world.hires.sellVodka(p, msg.id);
    if (typeof result === 'string') return client.send({ t: ServerMsg.ERROR, code: result });
    client.send({ t: ServerMsg.DONE, what: 'vodka_sold', ...result, cash: p.cash });
  }

  /** A stray cat: feed it a fish, pick it up or put it down, pet it. */
  cat(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const cats = this.world.cats;
    const error = msg.action === 'feed' ? cats.feed(p, msg.id) : msg.action === 'pickup' ? cats.pickUp(p, msg.id) : msg.action === 'drop' ? cats.putDown(p) : cats.pet(p, msg.id);
    if (error) client.send({ t: ServerMsg.ERROR, code: error });
  }

  /** Wheat in hand: a handful for the crows (the flocks are drawn by each client; this just uses up the wheat). */
  crows(client) {
    const p = client.player;
    if (!p?.alive) return;
    const error = this.world.feedCrows(p);
    if (error) client.send({ t: ServerMsg.ERROR, code: error });
  }

  /** The car radio: on/off, next song. */
  radio(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const error = this.world.radio(p, msg.action);
    if (error) client.send({ t: ServerMsg.ERROR, code: error });
  }

  /** Fishing: cast the line, or pull. */
  fish(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const fishing = this.world.fishing;
    const error = msg.action === 'cast' ? fishing.cast(p, msg.angle) : fishing.pull(p, msg.seen);
    if (error && error !== 'no_line') client.send({ t: ServerMsg.ERROR, code: error });
  }

  /** At a Militsiya front desk: apply to join (answers to the questions) or resign. As an officer: arrest or fine a player. */
  copAction(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const police = this.world.police;
    if (msg.action === 'arrest' || msg.action === 'fine') {
      const result = msg.action === 'arrest' ? police.copArrest(p, msg.id) : police.copFine(p, msg.id);
      if (typeof result === 'string') return client.send({ t: ServerMsg.ERROR, code: result });
      return client.send({ t: ServerMsg.DONE, what: `cop_${msg.action}`, ...result, cash: p.cash });
    }
    const error = msg.action === 'apply' ? police.apply(p, msg.answers) : police.resign(p);
    if (error) client.send({ t: ServerMsg.ERROR, code: error });
    else client.send({ t: ServerMsg.DONE, what: `cop_${msg.action}` });
    const desk = police.deskOf(p);
    if (desk) this.inspect(client, desk.id);
  }

  /** At the prison warden: pay bail (id: yourself, or anyone inside). */
  prisonAction(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const prison = this.world.prison;
    const result = prison.payBail(p, msg.id);
    if (typeof result === 'string') return client.send({ t: ServerMsg.ERROR, code: result });
    client.send({ t: ServerMsg.DONE, what: 'bail', ...result, self: msg.id === p.id });
    if (msg.id !== p.id && prison.building) this.inspect(client, prison.building.id);
  }

  /** At the bar: hire a goon, a guard (id: building to guard) or a hitman (id: target player), or let one go (id: hire). */
  hireAction(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const hires = this.world.hires;
    const error = msg.action === 'dismiss' ? hires.dismiss(p, msg.id) : msg.action === 'vodka' ? hires.buyVodka(p) : hires.hire(p, msg.action, { post: msg.id, target: msg.id });
    if (error) return client.send({ t: ServerMsg.ERROR, code: error });
    client.send({ t: ServerMsg.DONE, what: `hire_${msg.action}`, bank: Math.floor(p.account?.bank ?? 0) });
    if (hires.bar) this.inspect(client, hires.bar.id);
  }

  /** A bunker's trapdoor: a guard's key opens it; once it's open, down the ladder. Underground: up a ladder. */
  trapdoorAction(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    if (msg.action === 'up') {
      const ladder = this.world.underground?.ladderNear(p);
      return ladder ? this.onTravel?.(client, 'town', ladder) : client.send({ t: ServerMsg.ERROR, code: 'too_far' });
    }
    if (msg.action === 'down') {
      const error = this.world.trapdoorDown(p, msg.id);
      if (error) return client.send({ t: ServerMsg.ERROR, code: error });
      const t = this.world.trapdoorOf(this.world.buildings[msg.id - 1]);
      return this.onTravel?.(client, 'underground', { x: t.x + t.w / 2, y: t.y + t.h / 2 });
    }
    const error = this.world.openTrapdoor(p, msg.id);
    if (error) return client.send({ t: ServerMsg.ERROR, code: error });
    client.send({ t: ServerMsg.DONE, what: 'trapdoor_open', id: msg.id });
  }

  /** The clipboard: put away, bring out, fire, or give orders to one of your goons and guards. */
  crewAction(client, msg) {
    const p = client.player;
    if (!p) return;
    const error = this.world.hires.crew(p, msg);
    if (error) return client.send({ t: ServerMsg.ERROR, code: error });
    client.send({ t: ServerMsg.DONE, what: `crew_${msg.action}` });
  }

  /** Bodies: open (look in its pockets), loot a slot (−1: its cash), carry it, drop / get rid of the one you carry. */
  bodyAction(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    const bodies = this.world.bodies;
    let result;
    if (msg.action === 'open') result = null;
    else if (msg.action === 'loot') result = bodies.loot(p, msg.id, msg.slot);
    else if (msg.action === 'carry') result = bodies.carry(p, msg.id);
    else result = bodies.dropCarried(p);
    if (typeof result === 'string') return client.send({ t: ServerMsg.ERROR, code: result });
    if (msg.action === 'drop') return client.send({ t: ServerMsg.DONE, what: 'body_drop', how: result.how });
    if (msg.action === 'carry') return client.send({ t: ServerMsg.DONE, what: 'body_carry' });
    const info = bodies.describe(msg.id);
    if (info) client.send({ t: ServerMsg.BODY, ...info });
  }

  /** Selling to the freight train (contracts) or the black-market buyer behind the station. */
  trainAction(client, msg) {
    const p = client.player;
    const rail = this.world.railway;
    if (!p?.alive || !rail) return;
    const result = msg.action === 'deliver' ? rail.deliver(p, msg.good, msg.qty) : rail.sellBlack(p, msg.good, msg.qty);
    if (typeof result === 'string') return client.send({ t: ServerMsg.ERROR, code: result });
    client.send({ t: ServerMsg.DONE, what: msg.action === 'deliver' ? 'train_deliver' : 'black_sell', good: msg.good, ...result });
    this.inspect(client, msg.action === 'deliver' ? rail.station.id : -rail.station.id);
  }

  /** F tapped away from anything robbable: pickpocketing. (Robbing is F held — see the input.) Also bribes. */
  crimeAction(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    if (msg.t === 'bribe') {
      const error = this.world.roadblocks.bribe(p);
      if (error) client.send({ t: ServerMsg.ERROR, code: error });
      return;
    }
    const result = this.world.pickpocket(p);
    if (typeof result === 'string') client.send({ t: ServerMsg.ERROR, code: result });
    else if (result?.amount !== undefined) client.send({ t: ServerMsg.POLICE, kind: 'stole', amount: result.amount, unnoticed: result.unnoticed, food: result.food });
  }

  /** Q to drop, and trunk actions. */
  inventoryAction(client, msg) {
    const p = client.player;
    if (!p?.alive) return;
    if (msg.t === 'drop' && msg.cash) {
      const result = this.world.dropCash(p, msg.cash);
      if (typeof result === 'string') client.send({ t: ServerMsg.ERROR, code: result });
      else client.send({ t: ServerMsg.DONE, what: 'drop_cash', amount: result });
      return;
    }
    const error = msg.t === 'drop' ? this.world.drop(p, msg.slot) : msg.t === 'lights' ? this.world.toggleLights(p) : msg.t === 'siren' ? this.world.toggleSiren(p) : this.world.trunk(p, msg.id, msg.action, msg.slot);
    if (error) client.send({ t: ServerMsg.ERROR, code: error });
  }

  /** Invite, accept, decline, leave. */
  teamAction(client, msg) {
    let error = null;
    if (msg.action === 'invite') {
      if (!client.name) error = 'join_first';
      else {
        const target = [...this.clients].find((c) => c.player?.id === msg.id);
        error = target ? this.teams.invite(client, target) : 'team_no_player';
        if (!error) target.send({ t: ServerMsg.TEAM_INVITE, id: client.id, name: client.name });
      }
    } else if (msg.action === 'leave') this.teams.leave(client);
    else {
      const from = [...this.clients].find((c) => c.id === msg.id);
      if (msg.action === 'decline') from && this.teams.decline(client, from);
      else error = from ? this.teams.accept(client, from) : 'team_no_invite';
    }
    if (error) client.send({ t: ServerMsg.ERROR, code: error });
    else if (msg.action === 'invite') client.send({ t: ServerMsg.DONE, what: 'team_invite' });
    this.#sendTeams();
  }

  /** Resend the team panel to whoever's changed. */
  #sendTeams() {
    for (const c of this.teams.changed) if (this.clients.has(c)) c.send({ t: ServerMsg.TEAM, ...this.teams.describe(c) });
    this.teams.changed.clear();
  }

  bank(client, action, amount) {
    const p = client.player;
    if (!p?.alive) return;
    const error = this.world.bank(p, action, amount);
    if (error) return client.send({ t: ServerMsg.ERROR, code: error });
    this.onBankChange?.(p.account);
    client.send({ t: ServerMsg.BANKED, action, amount, cash: p.cash, bank: p.account.bank });
  }

  handleInput(client, msg) {
    if (client.player?.alive) client.player.applyInput(msg);
  }

  // ---- networking ------------------------------------------------------

  broadcast(msg, except = null) {
    const data = encode(msg);
    for (const c of this.clients) if (c !== except) c.sendRaw(data);
  }

  /** What only this player needs: exact stamina (for prediction) and their inventory. */
  #privateState(me) {
    return {
      id: me.id,
      x: round1(me.x),
      y: round1(me.y),
      mass: round1(me.mass),
      stamina: [Math.round(me.stamina * 100) / 100, Math.round(me.staminaDelay * 100) / 100, me.exhausted ? 1 : 0],
      vel: [round1(me.vx), round1(me.vy)], // walking velocity (it carries you on ice)
      knock: me.kx || me.ky ? [round1(me.kx), round1(me.ky)] : 0, // thrown by a car: the slide still to come
      cash: me.cash,
      bank: Math.floor(me.account?.bank ?? 0),
      job: this.world.economy.jobBoard(me).mine,
      wanted: me.wanted,
      jail: me.jailed && !me.jailed.prison ? Math.max(0, Math.ceil(me.jailed.until - this.world.economy.time)) : 0,
      prison: me.jailed?.prison ? [me.jailed.coal, me.jailed.quota, me.jailed.bail] : 0, // [coal in, quota, bail]
      carry: me.carrying?.id ?? 0, // the body you're carrying
      hidden: me.hidden ? 1 : 0, // in a dumpster
      rob: me.robbing ? [me.robbing.kind, Math.round((me.robbing.elapsed / me.robbing.sec) * 1000) / 1000, me.robbing.sec] : null, // [kind, progress, seconds]
      arrest: Math.round(me.arrest * 100) / 100,
      // The vehicle whose trunk counts as yours: [id, type, slots as [good, qty] | [gunType, ammo, 'gun'] | ['rod', 1, 'rod'] | null].
      trunk: (() => {
        const v = this.world.economy.vehicleOf(me);
        return v ? [v.id, v.type, v.cargo.map((s) => (s?.good ? [s.good, s.qty] : s?.type === 'rod' ? ['rod', 1, 'rod'] : s?.type ? [s.type, s.ammo, 'gun', s.illegal ? 1 : 0] : null))] : null;
      })(),
      slot: me.selected,
      stored: this.world.warehouses.storedFor(me.account), // sizes of my saved factories waiting to be loaded
      crew: (() => { // the clipboard: my goons and guards, where guards can go, and what they cost a day — [roster, [[building id, label]], [goon, guard, put away]] (0: none)
        const roster = this.world.hires.roster(me.account);
        const perDay = (role) => Math.round((config.hires[role].wagePerMin * this.env.cycle) / 60);
        return roster.length ? [roster, this.world.hires.posts(me.account).map((x) => [x.id, x.label]), [perDay('goon'), perDay('guard'), config.hires.awayPerDay]] : 0;
      })(),
      storedHomes: this.world.homes.storedFor(me.account), // { own: [types], rent: [types] } my homes (and rented rooms' things) from before the restart
      home: (() => { // my home: [building id, garage spot x, y]
        const b = this.world.homes.homeOf(me.account);
        if (!b) return null;
        const at = this.world.homes.garagePoint(b);
        return [b.id, Math.round(at.x), Math.round(at.y)];
      })(),
      sleep: asleep(me) && this.env.isNight ? [[...this.world.players.values()].filter((o) => o.alive && asleep(o)).length, [...this.world.players.values()].filter((o) => o.alive).length] : null, // asleep (bed or dumpster) at night: [asleep, everyone]
      garages: this.world.homes.garageSpots(me.account).filter((g) => !g.starter).map((g) => [g.b.id, Math.round(g.x), Math.round(g.y)]), // the garages I've bought: [building id, spot x, y]
      // While driving: the car's exact state, so the client can predict it.
      ride: me.vehicle && me.vehicle.driver !== me ? me.vehicle.id : 0, // a passenger: the car you're riding in
      car: me.vehicle?.driver === me ? [round1(me.vehicle.x), round1(me.vehicle.y), Math.round(me.vehicle.angle * 1000) / 1000, round1(me.vehicle.vx), round1(me.vehicle.vy), me.vehicle.id, me.vehicle.type, Math.round(me.vehicle.fuel * 10) / 10, Math.round(me.vehicle.boost * 10) / 10] : null,
      // [type, ammo, reload seconds left] per slot; reload rounds up so it never shows 0 while still reloading.
      // Guns: [type, ammo, reload seconds left]; goods: ['goods', good, qty].
      heal: Math.round((me.digesting ?? []).reduce((sum, d) => sum + d.perSec * d.left, 0)), // still to come from food
      cop: me.account?.cop ? 1 : 0, // I've joined the Militsiya
      buzz: Math.ceil(me.buzz ?? 0), // seconds of vodka buzz left (less damage taken)
      visions: Object.entries(me.visions ?? {}).map(([kind, left]) => [kind, Math.ceil(left)]),
      holdup: me.heldUp ? [Math.max(0, Math.round(me.heldUp.left * 10) / 10), me.heldUp.of, Math.ceil(me.heldUp.grace ?? 0)] : null, // a gangster's got me at gunpoint: [seconds left, of, seconds left to stop moving] // vodka's (and the mixes') effects on how I see, stacked: [[kind, seconds left]]
      cabinet: me.openCabinet ? this.world.furnishings.contents(me, me.openCabinet) : null, // [id, slots] while I have one open
      fish: this.world.fishing.view(me), // my line: [x, y] waiting, or [x, y, t, cycle, from, to, pulls] while a fish fights
      inv: me.inventory.map((s) => (s?.good ? ['goods', s.good, s.qty] : s?.food ? ['food', s.food, s.qty] : s?.tool ? ['tool', s.type] : s ? [s.type, s.ammo, Math.ceil(s.reloadTimer * 10) / 10, s.illegal ? 1 : 0] : null)), // (a gun: [type, ammo, reload, unregistered])
    };
  }

  #bulletsInView(cx, cy) {
    const range = config.world.viewDistance;
    const out = [];
    for (const b of this.world.bullets.values()) {
      if (Math.abs(b.x - cx) <= range && Math.abs(b.y - cy) <= range) out.push([b.id, Math.round(b.x), Math.round(b.y), b.weaponType]);
    }
    return out;
  }

  /** Per-client snapshot containing only what's in that client's view. */
  #sendSnapshots() {
    const tick = this.world.tick;
    for (const client of this.clients) {
      const me = client.player;
      // Spectators (dead / not yet spawned) watch the world centre.
      const cx = me ? me.x : this.world.width / 2;
      const cy = me ? me.y : this.world.height / 2;

      const players = [];
      const lines = []; // other people's fishing lines: [player id, float x, float y, fighting]
      const food = [];
      const pickups = [];
      const vehicles = [];
      for (const e of this.world.queryView(cx, cy)) {
        if (e.kind === 'vehicle') {
          vehicles.push([e.id, e.type, round1(e.x), round1(e.y), Math.round(e.angle * 100) / 100, e.driver?.id ?? 0, Math.ceil(e.health), e.color, e.slipping ? 1 : 0, e.owner?.name ?? null, e.siren ? 1 : 0, e.lights ? 1 : 0, me && this.world.carLockedFor(e, me) ? 1 : 0, e.boosting ? 1 : 0, e.radio ? [e.radio.song, round1(this.world.economy.time - e.radio.since)] : 0]);
        } else if (e.kind === 'player') {
          if (e.vehicle) continue; // drawn as their vehicle
          if (e.hidden && e !== me) continue; // in a dumpster: nobody else sees them
          const aim = Math.round(e.input.aim * 100) / 100;
          players.push([e.id, round1(e.x), round1(e.y), round1(e.radius), Math.ceil(e.health), aim, e.weapon?.type ?? e.tool?.type ?? null, e.maxHealth, e.account?.cop ? 1 : e.jailed?.prison ? 2 : 0, me?.account?.cop && e.wanted ? 1 : 0, e.sleeping ? 1 : 0, heldIcon(e), e.swings ?? 0]); // (in Militsiya uniform; wanted — only officers are told; asleep in bed; goods or food in hand; knife/bat swings so far, to animate them)
          if (e.fishing && e !== me) lines.push([e.id, Math.round(e.fishing.x), Math.round(e.fishing.y), e.fishing.victim ? 2 : e.fishing.phase === 'bite' ? 1 : 0]); // 2: hooked onto a player
        } else if (e.kind === 'pickup') {
          const at = [e.id, Math.round(e.x), Math.round(e.y)];
          pickups.push(e.goods ? [...at, 'goods', e.goods.good, e.goods.qty] : e.cash ? [...at, 'cash', e.cash] : [...at, e.weapon.type]);
        } else {
          food.push([e.id, Math.round(e.x), Math.round(e.y)]);
        }
      }

      client.send(
        {
          t: ServerMsg.SNAPSHOT,
          tick,
          ack: me ? me.lastInputSeq : -1,
          you: me ? this.#privateState(me) : null,
          players,
          traps: this.world.openTrapdoors.size ? [...this.world.openTrapdoors] : 0, // bunkers whose trapdoor is open
          lines,
          food,
          pickups,
          vehicles,
          bullets: this.#bulletsInView(cx, cy),
          npcs: this.world.townsfolk.visible(cx, cy, config.world.viewDistance),
          bodies: this.world.bodies.near(cx, cy, config.world.viewDistance),
          cops: this.world.police.visible(cx, cy, config.world.viewDistance),
          wolves: this.world.wolves.visible(cx, cy, config.world.viewDistance),
          cats: this.world.cats.visible(cx, cy, config.world.viewDistance, me),
          crew: this.world.hires.visible(cx, cy, config.world.viewDistance, client.account),
          // Teammates wherever they are, for the map: [player id, x, y, driving].
          team: this.teams.mates(client).filter((c) => c.player?.alive).map((c) => [c.player.id, Math.round(c.player.x), Math.round(c.player.y), c.player.vehicle ? 1 : 0]),
        },
        { droppable: true },
      );
    }
  }
}

/** The goods or food in p's hand, as the client's icon key (a gun or tool is sent as the weapon instead). */
function heldIcon(p) {
  const slot = p.inventory[p.selected];
  return slot?.good ?? (slot?.food ? `food:${slot.food}` : null);
}
