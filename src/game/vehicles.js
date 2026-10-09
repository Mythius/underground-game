import { config } from '../config.js';
import { clamp } from '../utils/math.js';

// Soviet-era paint: beige, white, cherry, sky blue, olive, aubergine, mustard, "wet asphalt", black.
const COLORS = ['#d8c8a0', '#ecebe4', '#7a1f2b', '#7fa6c9', '#6b7448', '#4a2a44', '#c9a43a', '#5a6068', '#1d1d1f'];

/** A drivable car or truck, facing `angle` (radians), moving at (vx, vy). */
export class Vehicle {
  constructor(id, type, x, y, angle) {
    this.kind = 'vehicle';
    this.id = id;
    this.type = type;
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.vx = 0; // velocity; can point a different way from `angle` while sliding
    this.vy = 0;
    this.driver = null;
    this.health = config.vehicles.types[type].health;
    this.color = COLORS[Math.floor(Math.random() * COLORS.length)];
    this.fuel = 40 + Math.random() * 60; // percent of a tank
    this.owner = null; // the account that bought it at a dealership (anyone can still drive it)
    this.cargo = Array.from({ length: config.cargo.vehicles[type] ?? 1 }, () => null); // trunk slots: { good, qty } or null
  }

  get stats() {
    return config.vehicles.types[this.type];
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }

  /** Bounding radius, for the spatial grid. */
  get radius() {
    return this.stats.length / 2;
  }
}

/**
 * The body as a row of circles along its length. Collision works on these.
 * Keep in sync with vehicleCircles() in public/index.html.
 */
export function vehicleCircles(v, stats) {
  const r = stats.width / 2;
  const reach = stats.length / 2 - r;
  const n = Math.max(2, Math.ceil(stats.length / (stats.width * 0.8)));
  const cos = Math.cos(v.angle);
  const sin = Math.sin(v.angle);
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = -reach + (2 * reach * i) / (n - 1);
    out.push({ x: v.x + cos * off, y: v.y + sin * off, r });
  }
  return out;
}

/** Speed and sideways slip relative to the way the vehicle points. */
export function vehicleMotion(v) {
  const cos = Math.cos(v.angle);
  const sin = Math.sin(v.angle);
  return { forward: v.vx * cos + v.vy * sin, lateral: -v.vx * sin + v.vy * cos };
}

/** With an empty tank you can still brake (and roll), but not drive forward or reverse. Keep in sync with the client. */
export function emptyTankGas(v, gas) {
  return gas < 0 && vehicleMotion(v).forward > 1 ? gas : 0;
}

/**
 * One physics step. gas: -1..1 (W/S), steer: -1..1 (A/D), drift: handbrake (Space); gripScale < 1 in rain.
 * Velocity is kept separately from heading, so when the car turns its momentum carries on and it
 * slides; tyre grip bleeds that sideways slide away — slowly while drifting.
 * `collide(circle)` pushes a circle out of walls and returns true if it moved.
 * Keep in sync with stepVehicle() in public/index.html, which predicts the car you drive.
 */
export function stepVehicle(v, stats, gas, steer, drift, dt, bounds, collide, gripScale = 1) {
  const cos = Math.cos(v.angle);
  const sin = Math.sin(v.angle);
  let { forward, lateral } = vehicleMotion(v);

  if (gas > 0) {
    forward += stats.accel * gas * dt * (forward < 0 ? 2.5 : 1); // braking out of reverse is quicker
  } else if (gas < 0) {
    forward += (forward > 0 ? -stats.brake : -stats.accel * 0.6) * -gas * dt;
  } else {
    const roll = 150 * dt;
    forward = Math.abs(forward) < roll ? 0 : forward - Math.sign(forward) * roll;
  }
  forward -= forward * (drift ? 0.6 : 0.25) * dt; // drag, more with the handbrake on
  forward = clamp(forward, -stats.maxSpeed * 0.35, stats.maxSpeed);
  lateral *= Math.exp(-(drift ? stats.driftGrip : stats.grip) * gripScale * dt); // wet roads grip less

  // Rebuild the velocity on the old heading, then turn: the car rotates under its momentum.
  v.vx = forward * cos - lateral * sin;
  v.vy = forward * sin + lateral * cos;
  // Steering needs movement, flips when reversing, and bites harder with the back end loose.
  v.angle += steer * stats.turnRate * dt * clamp(forward / 200, -1, 1) * (drift ? 1.4 : 1);

  const half = stats.length / 2;
  v.x = clamp(v.x + v.vx * dt, half, bounds.width - half);
  v.y = clamp(v.y + v.vy * dt, half, bounds.height - half);

  let hit = false;
  for (let pass = 0; pass < 2; pass++) {
    for (const c of vehicleCircles(v, stats)) {
      const before = { x: c.x, y: c.y };
      if (collide(c)) {
        v.x += c.x - before.x;
        v.y += c.y - before.y;
        hit = true;
      }
    }
  }
  if (hit) {
    const scrape = Math.pow(0.02, dt); // scraping a wall bleeds speed fast
    v.vx *= scrape;
    v.vy *= scrape;
  }
  return hit;
}
