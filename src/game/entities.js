import { config } from '../config.js';

const COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4'];

export const massToRadius = (mass) => 4 * Math.sqrt(mass);

export class Player {
  constructor(id, name, x, y) {
    this.kind = 'player';
    this.id = id;
    this.name = name;
    this.color = COLORS[id % COLORS.length];
    this.x = x;
    this.y = y;
    this.mass = config.player.startMass;
    this.health = config.player.maxHealth;
    this.shotCooldown = 0;
    this.alive = true;
    this.input = { angle: 0, throttle: 0, boost: false, aim: 0, fire: false };
    this.lastInputSeq = -1;
    this.spawnedAt = Date.now();
  }

  get radius() {
    return massToRadius(this.mass);
  }

  get score() {
    return Math.floor(this.mass);
  }

  /** Bigger players move slower. */
  get speed() {
    const { baseSpeed, startMass } = config.player;
    return baseSpeed * Math.pow(startMass / this.mass, 0.25);
  }

  applyInput({ seq, angle, throttle, boost, aim = angle, fire = false }) {
    if (seq <= this.lastInputSeq) return; // stale / reordered
    this.lastInputSeq = seq;
    this.input.angle = angle;
    this.input.throttle = throttle;
    this.input.boost = boost;
    this.input.aim = aim;
    this.input.fire = fire;
  }

  get publicInfo() {
    return { id: this.id, name: this.name, color: this.color };
  }
}

export class Bullet {
  constructor(id, owner, x, y, angle) {
    const { bulletSpeed, bulletLifetimeSec, bulletRadius } = config.gun;
    this.kind = 'bullet';
    this.id = id;
    this.owner = owner;
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * bulletSpeed;
    this.vy = Math.sin(angle) * bulletSpeed;
    this.ttl = bulletLifetimeSec;
    this.radius = bulletRadius;
  }
}

export class Food {
  constructor(id, x, y) {
    this.kind = 'food';
    this.id = id;
    this.x = x;
    this.y = y;
    this.mass = config.world.foodMass;
    this.radius = 6;
  }
}
