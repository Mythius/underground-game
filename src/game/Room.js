import { config } from '../config.js';
import { ServerMsg, encode } from '../net/protocol.js';
import { logger } from '../utils/logger.js';
import { round1 } from '../utils/math.js';
import { Environment } from './Environment.js';
import { Teams } from './teams.js';
import { createWorld } from './World.js';

let nextRoomId = 1;

/** A game instance: one World, its clients, and its fixed-timestep loop. */
export class Room {
  /** With `store` (an AccountStore) owned warehouses are saved and come back after a restart. */
  constructor(map = null, store = null) {
    this.id = `room-${nextRoomId++}`;
    this.store = store;
    this.world = createWorld(config.world, config.player, config.weapons, map);
    this.#restoreWarehouses();
    this.env = new Environment();
    this.lastOwners = '';
    this.sentLayouts = new Map(); // warehouse id -> layout version last broadcast
    this.saveTimer = 0;
    this.lastEnvBroadcast = 0;
    this.clients = new Set();
    this.teams = new Teams();
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
    this.#saveWarehouses();
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

  #step(dt) {
    this.env.step(dt);
    this.world.gripScale = 1 - (1 - config.environment.rainGrip) * this.env.intensity('rain');
    this.world.frozen = this.env.season.name === 'winter';
    if (this.env.time - this.lastEnvBroadcast >= config.environment.broadcastEverySec) {
      this.lastEnvBroadcast = this.env.time;
      this.broadcast({ t: ServerMsg.ENV, ...this.env.state() });
    }
    this.world.onBankChange = this.onBankChange;
    const { deaths, doorChanges, explosions } = this.world.step(dt);
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
    for (const e of this.world.bodies.events.splice(0)) {
      const { player, ...rest } = e;
      this.#clientForPlayer(player)?.send({ t: ServerMsg.POLICE, ...rest });
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
    this.saveTimer += dt;
    if (this.saveTimer >= config.warehouses.saveEverySec || (warehouses.changed && this.saveTimer >= 2)) this.#saveWarehouses();
    for (const d of doorChanges) this.broadcast({ t: ServerMsg.DOOR, id: d.id, open: d.open });
    for (const e of explosions) this.broadcast({ t: ServerMsg.BOOM, x: e.x, y: e.y });
    for (const { victim, killer } of deaths) {
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

  /** Owned warehouses back from the database, each into a warehouse of the same size. */
  #restoreWarehouses() {
    this.unplaced = [];
    if (!this.store) return;
    const rows = this.store.loadWarehouses();
    const placed = this.world.warehouses.restore(rows, (id) => this.store.live(id));
    // Ones with nowhere to go (the map has fewer warehouses of that size now) stay saved for later.
    this.unplaced = rows.filter((r) => !placed.some((x) => x.source === r));
    if (rows.length) logger.info('warehouses restored', { room: this.id, placed: placed.length, waiting: this.unplaced.length });
  }

  #saveWarehouses() {
    this.saveTimer = 0;
    this.world.warehouses.changed = false;
    if (!this.store) return;
    try {
      this.store.saveWarehouses([...this.world.warehouses.toSave(), ...this.unplaced]);
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
    client.send({
      t: ServerMsg.WELCOME,
      clientId: client.id,
      roomId: this.id,
      world: { width: this.world.width, height: this.world.height },
      tickRate: config.tickRate,
      snapshotRate: this.snapshotRate,
      buildings: this.world.buildings,
      doorReach: config.world.doorReach,
      vehicles: { reach: config.vehicles.reach, types: config.vehicles.types },
      env: this.env.state(),
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
        lots: this.world.lots,
        city: this.world.city, // asphalt + sidewalks inside, gravel outside (null: asphalt everywhere)
        bays: this.world.bays,
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
        Object.entries(config.weapons).map(([type, w]) => [type, { name: w.name, magazineSize: w.magazineSize, reloadSec: w.reloadSec, barrel: w.barrel, melee: w.melee ?? false }]),
      ),
    });
  }

  /** Swap in a new map: everyone's sent back to the menu and gets the new world. */
  loadMap(map) {
    for (const c of this.clients) c.player = null;
    this.#saveWarehouses();
    this.world = createWorld(config.world, config.player, config.weapons, map);
    this.#restoreWarehouses();
    this.lastOwners = '';
    this.sentLayouts.clear();
    for (const c of [...this.clients]) {
      this.clients.delete(c);
      this.addClient(c);
      c.send({ t: ServerMsg.MAP_CHANGED });
    }
  }

  removeClient(client) {
    if (!this.clients.delete(client)) return;
    this.teams.remove(client);
    this.#sendTeams();
    if (client.player) {
      this.world.removePlayer(client.player.id);
      this.broadcast({ t: ServerMsg.PLAYER_LEFT, id: client.player.id });
    }
    client.player = null;
    client.room = null;
  }

  /** Spawn (or respawn) a player for this client. */
  /** client.account is set before this (the browser's account, or a guest one whose money isn't saved). */
  spawn(client, name, look) {
    if (client.player?.alive) return;
    const player = this.world.spawnPlayer(name, look);
    player.account = client.account;
    client.player = player;
    client.name = player.name;
    client.send({
      t: ServerMsg.SPAWNED,
      playerId: player.id,
      account: client.account?.guest ? null : client.account?.name ?? null, // to tell which warehouses are mine
      players: [...this.world.players.values()].map((p) => p.publicInfo),
    });
    this.broadcast({ t: ServerMsg.PLAYER_JOINED, ...player.publicInfo }, client);
    for (const c of [client, ...this.teams.mates(client)]) this.teams.changed.add(c); // my new player id, for their maps
    this.#sendTeams();
  }

  chat(client, text) {
    if (!client.name) return client.send({ t: ServerMsg.ERROR, code: 'join_first' });
    if (!client.chatLimiter.tryConsume()) return client.send({ t: ServerMsg.ERROR, code: 'chat_too_fast' });
    const color = client.player?.color ?? '#999';
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
  }

  /** Markets and factories: describe, trade, factory actions and refuelling. */
  inspect(client, id) {
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
    else error = eco.refuel(p);
    if (error) return client.send({ t: ServerMsg.ERROR, code: error });
    const what = msg.t === 'factory' ? msg.action : msg.t === 'trade' ? msg.side : msg.t === 'refuel' ? 'refuel' : msg.t;
    client.send({ t: ServerMsg.DONE, what, good: msg.good, qty: msg.qty, type: msg.type, ...extra });
    if (msg.id !== undefined) this.inspect(client, msg.id);
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
    else if (result?.amount !== undefined) client.send({ t: ServerMsg.POLICE, kind: 'stole', amount: result.amount, unnoticed: result.unnoticed });
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
    const error = msg.t === 'drop' ? this.world.drop(p, msg.slot) : msg.t === 'lights' ? this.world.toggleLights(p) : this.world.trunk(p, msg.id, msg.action, msg.slot);
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
      cash: me.cash,
      bank: Math.floor(me.account?.bank ?? 0),
      job: this.world.economy.jobBoard(me).mine,
      wanted: me.wanted,
      jail: me.jailed ? Math.max(0, Math.ceil(me.jailed.until - this.world.economy.time)) : 0,
      carry: me.carrying?.id ?? 0, // the body you're carrying
      hidden: me.hidden ? 1 : 0, // in a dumpster
      rob: me.robbing ? [me.robbing.kind, Math.round((me.robbing.elapsed / me.robbing.sec) * 100) / 100] : null,
      arrest: Math.round(me.arrest * 100) / 100,
      // The vehicle whose trunk counts as yours: [id, type, slots as [good, qty] | null].
      trunk: (() => {
        const v = this.world.economy.vehicleOf(me);
        return v ? [v.id, v.type, v.cargo.map((s) => (s ? [s.good, s.qty] : null))] : null;
      })(),
      slot: me.selected,
      // While driving: the car's exact state, so the client can predict it.
      ride: me.vehicle && me.vehicle.driver !== me ? me.vehicle.id : 0, // a passenger: the car you're riding in
      car: me.vehicle?.driver === me ? [round1(me.vehicle.x), round1(me.vehicle.y), Math.round(me.vehicle.angle * 1000) / 1000, round1(me.vehicle.vx), round1(me.vehicle.vy), me.vehicle.id, me.vehicle.type, Math.round(me.vehicle.fuel * 10) / 10] : null,
      // [type, ammo, reload seconds left] per slot; reload rounds up so it never shows 0 while still reloading.
      // Guns: [type, ammo, reload seconds left]; goods: ['goods', good, qty].
      heal: Math.round((me.digesting ?? []).reduce((sum, d) => sum + d.perSec * d.left, 0)), // still to come from food
      inv: me.inventory.map((s) => (s?.good ? ['goods', s.good, s.qty] : s?.food ? ['food', s.food, s.qty] : s?.tool ? ['tool', s.type] : s ? [s.type, s.ammo, Math.ceil(s.reloadTimer * 10) / 10] : null)),
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
      const food = [];
      const pickups = [];
      const vehicles = [];
      for (const e of this.world.queryView(cx, cy)) {
        if (e.kind === 'vehicle') {
          vehicles.push([e.id, e.type, round1(e.x), round1(e.y), Math.round(e.angle * 100) / 100, e.driver?.id ?? 0, Math.ceil(e.health), e.color, e.slipping ? 1 : 0, e.owner?.name ?? null, e.siren ? 1 : 0, e.lights ? 1 : 0]);
        } else if (e.kind === 'player') {
          if (e.vehicle) continue; // drawn as their vehicle
          if (e.hidden && e !== me) continue; // in a dumpster: nobody else sees them
          const aim = Math.round(e.input.aim * 100) / 100;
          players.push([e.id, round1(e.x), round1(e.y), round1(e.radius), Math.ceil(e.health), aim, e.weapon?.type ?? e.tool?.type ?? null, e.maxHealth]);
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
          food,
          pickups,
          vehicles,
          bullets: this.#bulletsInView(cx, cy),
          npcs: this.world.townsfolk.visible(cx, cy, config.world.viewDistance),
          bodies: this.world.bodies.near(cx, cy, config.world.viewDistance),
          cops: this.world.police.visible(cx, cy, config.world.viewDistance),
          // Teammates wherever they are, for the map: [player id, x, y, driving].
          team: this.teams.mates(client).filter((c) => c.player?.alive).map((c) => [c.player.id, Math.round(c.player.x), Math.round(c.player.y), c.player.vehicle ? 1 : 0]),
        },
        { droppable: true },
      );
    }
  }
}
