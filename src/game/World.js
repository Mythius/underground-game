import { config } from '../config.js';
import { clamp, distSq, randRange } from '../utils/math.js';
import { Bullet, Food, Player } from './entities.js';
import { SpatialGrid } from './SpatialGrid.js';

/** Pure simulation state. Knows nothing about sockets. */
export class World {
  constructor(opts = config.world, playerOpts = config.player, gunOpts = config.gun) {
    this.opts = opts;
    this.playerOpts = playerOpts;
    this.gunOpts = gunOpts;
    this.width = opts.width;
    this.height = opts.height;
    this.players = new Map();
    this.food = new Map();
    this.bullets = new Map();
    this.grid = new SpatialGrid(opts.width, opts.height, opts.gridCellSize);
    this.nextEntityId = 1;
    this.tick = 0;
    for (let i = 0; i < opts.foodCount; i++) this.spawnFood();
    this.rebuildGrid();
  }

  spawnFood() {
    const f = new Food(this.nextEntityId++, randRange(0, this.width), randRange(0, this.height));
    this.food.set(f.id, f);
    return f;
  }

  spawnPlayer(name) {
    const { x, y } = this.#findSpawnPoint();
    const p = new Player(this.nextEntityId++, name, x, y);
    this.players.set(p.id, p);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p) p.alive = false;
    this.players.delete(id);
  }

  #findSpawnPoint() {
    const safeSq = this.playerOpts.spawnSafeDistance ** 2;
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < 10; i++) {
      const x = randRange(100, this.width - 100);
      const y = randRange(100, this.height - 100);
      let nearest = Infinity;
      for (const p of this.players.values()) nearest = Math.min(nearest, distSq(x, y, p.x, p.y));
      if (nearest >= safeSq) return { x, y };
      if (nearest > bestDist) [best, bestDist] = [{ x, y }, nearest];
    }
    return best;
  }

  rebuildGrid() {
    this.grid.clear();
    for (const f of this.food.values()) this.grid.insert(f);
    for (const p of this.players.values()) this.grid.insert(p);
  }

  /**
   * Advance the simulation by `dt` seconds.
   * @returns {{ deaths: Array<{ victim: Player, killer: Player }> }}
   */
  step(dt) {
    this.tick++;
    this.#movePlayers(dt);
    this.#fireGuns(dt);
    this.rebuildGrid();
    const deaths = this.#resolveCollisions();
    deaths.push(...this.#moveBullets(dt));
    while (this.food.size < this.opts.foodCount) this.grid.insert(this.spawnFood());
    return { deaths };
  }

  #movePlayers(dt) {
    const { boostMultiplier, boostDrainPerSec, minBoostMass, massDecayPerSec, decayThreshold, startMass } =
      this.playerOpts;

    for (const p of this.players.values()) {
      const { angle, throttle, boost } = p.input;
      let speed = p.speed * throttle;

      if (boost && p.mass > minBoostMass && throttle > 0) {
        speed *= boostMultiplier;
        p.mass -= p.mass * boostDrainPerSec * dt;
      }
      if (p.mass > decayThreshold) p.mass -= p.mass * massDecayPerSec * dt;
      p.mass = Math.max(p.mass, startMass);

      const r = p.radius;
      p.x = clamp(p.x + Math.cos(angle) * speed * dt, r, this.width - r);
      p.y = clamp(p.y + Math.sin(angle) * speed * dt, r, this.height - r);
    }
  }

  #fireGuns(dt) {
    const { cooldownSec, bulletRadius } = this.gunOpts;
    for (const p of this.players.values()) {
      p.shotCooldown = Math.max(0, p.shotCooldown - dt);
      if (!p.input.fire || p.shotCooldown > 0) continue;
      p.shotCooldown = cooldownSec;
      // Spawn just outside the shooter so it can't hit itself.
      const offset = p.radius + bulletRadius + 1;
      const { aim } = p.input;
      const b = new Bullet(this.nextEntityId++, p, p.x + Math.cos(aim) * offset, p.y + Math.sin(aim) * offset, aim);
      this.bullets.set(b.id, b);
    }
  }

  /** Moves bullets and applies hits. Runs after the grid is rebuilt so it can query players. */
  #moveBullets(dt) {
    const deaths = [];
    const nearby = new Set();
    for (const b of this.bullets.values()) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.ttl -= dt;
      if (b.ttl <= 0 || b.x < 0 || b.y < 0 || b.x > this.width || b.y > this.height) {
        this.bullets.delete(b.id);
        continue;
      }

      nearby.clear();
      this.grid.query(b.x, b.y, b.radius, nearby);
      for (const p of nearby) {
        if (p.kind !== 'player' || !p.alive || p === b.owner) continue;
        const reach = p.radius + b.radius;
        if (distSq(p.x, p.y, b.x, b.y) >= reach * reach) continue;
        this.bullets.delete(b.id);
        p.health -= this.gunOpts.damage;
        if (p.health <= 0) {
          this.removePlayer(p.id);
          deaths.push({ victim: p, killer: b.owner });
        }
        break;
      }
    }
    return deaths;
  }

  #resolveCollisions() {
    const deaths = [];
    const { eatRatio } = this.playerOpts;
    const nearby = new Set();

    // Larger players resolve first so chains (A eats B eats C) are deterministic.
    const ordered = [...this.players.values()].sort((a, b) => b.mass - a.mass);

    for (const p of ordered) {
      if (!p.alive) continue;
      nearby.clear();
      const r = p.radius;
      this.grid.query(p.x, p.y, r, nearby);

      for (const other of nearby) {
        if (other === p) continue;

        if (other.kind === 'food') {
          if (!this.food.has(other.id)) continue;
          if (distSq(p.x, p.y, other.x, other.y) < r * r) {
            p.mass += other.mass;
            this.food.delete(other.id);
          }
          continue;
        }

        // Player vs player: must be noticeably larger and cover most of the victim.
        if (!other.alive || r < other.radius * eatRatio) continue;
        const reach = r - other.radius * 0.4;
        if (distSq(p.x, p.y, other.x, other.y) < reach * reach) {
          p.mass += other.mass;
          this.removePlayer(other.id);
          deaths.push({ victim: other, killer: p });
        }
      }
    }
    return deaths;
  }

  /** Entities visible from (x, y). */
  queryView(x, y, range = this.opts.viewDistance) {
    return this.grid.query(x, y, range);
  }

  leaderboard(limit = 10) {
    return [...this.players.values()]
      .sort((a, b) => b.mass - a.mass)
      .slice(0, limit)
      .map((p) => ({ id: p.id, name: p.name, score: p.score }));
  }
}
