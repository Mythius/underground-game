import { Room } from './Room.js';

/** Places clients into rooms, creating new ones as existing rooms fill up. */
export class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  join(client) {
    let room = [...this.rooms.values()].find((r) => !r.isFull);
    if (!room) {
      room = new Room();
      this.rooms.set(room.id, room);
      room.start();
    }
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
