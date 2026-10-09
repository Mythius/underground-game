import { loadSavedMap } from './mapFile.js';
import { Room } from './Room.js';

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
  }

  /** The map the editor should start from: the saved one, or what the first room is using. */
  currentMap() {
    return this.map ?? [...this.rooms.values()][0]?.world.toMap() ?? null;
  }

  /** Use a newly saved map everywhere, right away. */
  applyMap(map) {
    this.map = map;
    for (const room of this.rooms.values()) room.loadMap(map);
  }

  #openRoom() {
    const persistent = this.store && ![...this.rooms.values()].some((r) => r.store);
    const room = new Room(this.map, persistent ? this.store : null);
    room.onBankChange = this.onBankChange;
    this.rooms.set(room.id, room);
    room.start();
    return room;
  }

  /** Keep one room running even with nobody in it, so the editor always has the live map to load. */
  warm() {
    if (this.rooms.size === 0) this.#openRoom();
  }

  join(client) {
    const room = [...this.rooms.values()].find((r) => !r.isFull) ?? this.#openRoom();
    room.addClient(client);
    return room;
  }

  leave(client) {
    const room = client.room;
    if (!room) return;
    room.removeClient(client);
    // Keep one room warm; tear down extra empty rooms.
    if (room.size === 0 && this.rooms.size > 1) {
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
      clients: r.size,
      players: r.world.players.size,
      tick: r.world.tick,
      avgTickMs: Math.round(r.stats.avgTickMs * 100) / 100,
      maxTickMs: Math.round(r.stats.maxTickMs * 100) / 100,
    }));
  }

  stopAll() {
    for (const room of this.rooms.values()) room.stop();
    this.rooms.clear();
  }
}
