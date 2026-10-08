import { config } from '../config.js';
import { ServerMsg, encode } from '../net/protocol.js';
import { logger } from '../utils/logger.js';
import { round1 } from '../utils/math.js';
import { World } from './World.js';

let nextRoomId = 1;

/** A game instance: one World, its clients, and its fixed-timestep loop. */
export class Room {
  constructor() {
    this.id = `room-${nextRoomId++}`;
    this.world = new World();
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
    const { deaths } = this.world.step(dt);
    for (const { victim, killer } of deaths) {
      const client = this.#clientForPlayer(victim);
      if (client) {
        client.player = null;
        client.send({ t: ServerMsg.DIED, killedBy: killer.name, score: victim.score });
      }
      this.broadcast({ t: ServerMsg.PLAYER_LEFT, id: victim.id });
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
    });
  }

  removeClient(client) {
    if (!this.clients.delete(client)) return;
    if (client.player) {
      this.world.removePlayer(client.player.id);
      this.broadcast({ t: ServerMsg.PLAYER_LEFT, id: client.player.id });
    }
    client.player = null;
    client.room = null;
  }

  /** Spawn (or respawn) a player for this client. */
  spawn(client, name) {
    if (client.player?.alive) return;
    const player = this.world.spawnPlayer(name);
    client.player = player;
    client.send({
      t: ServerMsg.SPAWNED,
      playerId: player.id,
      players: [...this.world.players.values()].map((p) => p.publicInfo),
    });
    this.broadcast({ t: ServerMsg.PLAYER_JOINED, ...player.publicInfo }, client);
  }

  handleInput(client, msg) {
    if (client.player?.alive) client.player.applyInput(msg);
  }

  // ---- networking ------------------------------------------------------

  broadcast(msg, except = null) {
    const data = encode(msg);
    for (const c of this.clients) if (c !== except) c.sendRaw(data);
  }

  #bulletsInView(cx, cy) {
    const range = config.world.viewDistance;
    const out = [];
    for (const b of this.world.bullets.values()) {
      if (Math.abs(b.x - cx) <= range && Math.abs(b.y - cy) <= range) out.push([b.id, Math.round(b.x), Math.round(b.y)]);
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
      for (const e of this.world.queryView(cx, cy)) {
        if (e.kind === 'player') players.push([e.id, round1(e.x), round1(e.y), round1(e.radius), e.health]);
        else food.push([e.id, Math.round(e.x), Math.round(e.y)]);
      }

      client.send(
        {
          t: ServerMsg.SNAPSHOT,
          tick,
          ack: me ? me.lastInputSeq : -1,
          you: me ? { id: me.id, x: round1(me.x), y: round1(me.y), mass: round1(me.mass) } : null,
          players,
          food,
          bullets: this.#bulletsInView(cx, cy),
        },
        { droppable: true },
      );
    }
  }
}
