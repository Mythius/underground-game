import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { loadSavedMap } from './mapFile.js';
import { Room } from './Room.js';
import { undergroundMap } from './underground.js';
import { WinterMorning, tutorialMap } from './tutorial.js';

/** Places clients into rooms, creating new ones as existing rooms fill up. */
export class RoomManager {
  /**
   * onBankChange(account) is called whenever a player's bank balance changes, to save it.
   * `store` (an AccountStore) saves the first room's owned warehouses.
   */
  constructor({ onBankChange = null, store = null } = {}) {
    this.onBankChange = onBankChange;
    this.store = store;
    this.rooms = new Map();
    this.map = loadSavedMap(); // the admin-saved map, or null for random maps
    this.underground = null; // the room for the world under the town, while anyone's down there
    this.idleTimer = null; // (stops the underground a while after the last one leaves)
    this.tutorial = null; // the newcomers' world (the cabin in the woods), while any newcomer's in it
    this.tutorialTimer = null;
  }

  /** The town room the underground lies under (the saved one). */
  get town() {
    return [...this.rooms.values()].find((r) => r.kind === 'town' && r.store) ?? [...this.rooms.values()].find((r) => r.kind === 'town') ?? null;
  }

  /** The underground room, started up the first time someone needs it. */
  #undergroundRoom() {
    clearTimeout(this.idleTimer);
    if (this.underground) return this.underground;
    const town = this.town;
    const t = performance.now();
    const room = new Room(undergroundMap(town.world), this.store, { kind: 'underground', env: town.env });
    room.onBankChange = this.onBankChange;
    room.onTravel = (client, to, at) => this.travel(client, to, at);
    this.rooms.set(room.id, room);
    room.start();
    this.underground = room;
    logger.info('underground loaded', { room: room.id, ms: Math.round(performance.now() - t) });
    return room;
  }

  /** The tutorial's room, started up when a newcomer needs it (always winter, always morning). */
  #tutorialRoom() {
    clearTimeout(this.tutorialTimer);
    if (this.tutorial) return this.tutorial;
    const t = performance.now();
    const room = new Room(tutorialMap(), this.store, { kind: 'tutorial', env: new WinterMorning() });
    room.onBankChange = this.onBankChange;
    room.onTravel = (client, to, at) => this.travel(client, to, at);
    room.onTutorialDone = (client, how) => this.leaveTutorial(client, how);
    this.rooms.set(room.id, room);
    room.start();
    this.tutorial = room;
    logger.info('tutorial loaded', { room: room.id, ms: Math.round(performance.now() - t) });
    return room;
  }

  /** No newcomers left in it: stop it after a while. */
  #idleTutorial() {
    const room = this.tutorial;
    if (!room || room.size) return;
    clearTimeout(this.tutorialTimer);
    this.tutorialTimer = setTimeout(() => {
      if (this.tutorial !== room || room.size) return;
      room.stop();
      this.rooms.delete(room.id);
      this.tutorial = null;
      logger.info('tutorial unloaded', { room: room.id });
    }, config.tutorial.idleSec * 1000);
    this.tutorialTimer.unref?.();
  }

  #roomFor(to) {
    return to === 'underground' ? this.#undergroundRoom() : to === 'tutorial' ? this.#tutorialRoom() : this.town;
  }

  #left(room) {
    if (room === this.underground) this.#idleUnderground();
    if (room === this.tutorial) this.#idleTutorial();
  }

  /**
   * Out of the tutorial for good, on to town: they skipped it (`how` 'skip': home, as usual), or the black
   * ice put them into a tree ('crash': they wake up in the gulag, owing more coal than they'll ever dig).
   * Nothing from the tutorial comes along.
   */
  leaveTutorial(client, how) {
    const from = client.room, account = client.account;
    if (!from || from !== this.tutorial || !this.town) return false;
    if (account?.id && !account.guest && this.store) {
      this.store.setTutorial(account.id, true); // (what they had saved from before the tutorial is untouched: it never saves anything)
      if (how === 'crash' && !account.prison) this.store.setPrison(account.id, { quota: config.tutorial.quota, coal: 0, bail: config.tutorial.bail, lyosha: true });
    } else if (account) account.tutorial = true;
    from.removeClient(client, { travel: true });
    this.town.addClient(client);
    if (client.name) this.town.spawn(client, client.name, client.look ?? null);
    this.#idleTutorial();
    return true;
  }

  /** Nobody down there: stop it after a while (loot and all start afresh next time). */
  #idleUnderground() {
    const room = this.underground;
    if (!room || room.size) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.underground !== room || room.size) return;
      room.stop();
      this.rooms.delete(room.id);
      this.underground = null;
      logger.info('underground unloaded', { room: room.id });
    }, config.underground.idleSec * 1000);
    this.idleTimer.unref?.();
  }

  /**
   * A player goes to the other world ('underground' or 'town') with what they carry: down a trapdoor
   * (`at`: where it is in town), up a ladder (`at`: where it is down there), or the admin's switch.
   */
  travel(client, to, at = null) {
    const from = client.room;
    if (!from || from.kind === to) return false;
    const dest = this.#roomFor(to);
    if (!dest) return false;
    const carry = from.takeOut(client);
    if (!carry) {
      this.#left(from);
      if (dest !== from && !dest.size) this.#left(dest);
      return false;
    }
    dest.addClient(client);
    // (the admin's switch: at the foot of any ladder down there; in town, wherever they'd spawn)
    const ladders = to === 'underground' && !at ? dest.world.underground.layout.ladders.filter((l) => !l.vent) : [];
    if (ladders.length) {
      const l = ladders[Math.floor(Math.random() * ladders.length)];
      at = { x: l.x / config.underground.scale, y: l.y / config.underground.scale };
    }
    const spot = !at ? null : to === 'underground' ? dest.world.underground.arrival(at.x, at.y) : at.vent ? dest.world.ventArrival() : dest.world.trapdoorArrival(at.x, at.y); // (the oil hall office's ladder: up out of a sewer vent)
    dest.bringIn(client, carry, spot);
    this.#left(from);
    return true;
  }

  /** Not playing just now (in the menu, or dead): over to the other world's room, ready to spawn there. */
  place(client, to) {
    const from = client.room;
    if (!from || from.kind === to) return;
    const dest = this.#roomFor(to);
    if (!dest) return;
    from.removeClient(client, { travel: true });
    dest.addClient(client);
    this.#left(from);
  }

  /** The map the editor should start from: the saved one, or what the first room is using. */
  currentMap() {
    return this.map ?? this.town?.world.toMap() ?? null;
  }

  /** Use a newly saved map everywhere, right away. */
  applyMap(map) {
    this.map = map;
    // Anyone underground comes back up to the new town (the underground is dug again under it next time).
    const under = this.underground;
    if (under) {
      for (const c of [...under.clients]) if (!this.travel(c, 'town')) this.place(c, 'town'); // (with what they carry)
      clearTimeout(this.idleTimer);
      under.stop();
      this.rooms.delete(under.id);
      this.underground = null;
    }
    for (const room of this.rooms.values()) room.loadMap(map);
  }

  #openRoom() {
    const persistent = this.store && ![...this.rooms.values()].some((r) => r.store);
    const room = new Room(this.map, persistent ? this.store : null);
    room.onBankChange = this.onBankChange;
    room.onTravel = (client, to, at) => this.travel(client, to, at);
    this.rooms.set(room.id, room);
    room.start();
    return room;
  }

  /** Keep one room running even with nobody in it, so the editor always has the live map to load. */
  warm() {
    if (this.rooms.size === 0) this.#openRoom();
  }

  join(client) {
    const room = [...this.rooms.values()].find((r) => r.kind === 'town' && !r.isFull) ?? this.#openRoom();
    room.addClient(client);
    return room;
  }

  leave(client) {
    const room = client.room;
    if (!room) return;
    room.removeClient(client);
    if (room === this.underground || room === this.tutorial) {
      this.town?.release(client.account); // (logged off down there: their things up in town are put away)
      return this.#left(room);
    }
    // Keep one room warm; tear down extra empty rooms.
    if (room.size === 0 && [...this.rooms.values()].filter((r) => r.kind === 'town').length > 1) {
      room.stop();
      this.rooms.delete(room.id);
    }
  }

  /** A message to everyone in every room. */
  broadcastAll(msg) {
    for (const room of this.rooms.values()) room.broadcast(msg);
  }

  stats() {
    return [...this.rooms.values()].map((r) => ({
      id: r.id,
      kind: r.kind,
      clients: r.size,
      players: r.world.players.size,
      tick: r.world.tick,
      avgTickMs: Math.round(r.stats.avgTickMs * 100) / 100,
      maxTickMs: Math.round(r.stats.maxTickMs * 100) / 100,
    }));
  }

  stopAll() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.tutorialTimer);
    for (const room of this.rooms.values()) room.stop();
    this.rooms.clear();
  }
}
