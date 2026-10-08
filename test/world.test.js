import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { SpatialGrid } from '../src/game/SpatialGrid.js';
import { World } from '../src/game/World.js';

const smallWorld = () => new World({ ...config.world, width: 1000, height: 1000, foodCount: 0 });

test('spatial grid returns only nearby entities', () => {
  const grid = new SpatialGrid(1000, 1000, 100);
  const near = { x: 50, y: 50, radius: 5 };
  const far = { x: 900, y: 900, radius: 5 };
  grid.insert(near);
  grid.insert(far);
  const found = grid.query(60, 60, 50);
  assert.ok(found.has(near));
  assert.ok(!found.has(far));
});

test('players move toward input angle and stay in bounds', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.x = 500;
  p.y = 500;
  p.applyInput({ seq: 0, angle: 0, throttle: 1, boost: false });
  world.step(0.1);
  assert.ok(p.x > 500);
  assert.equal(Math.round(p.y), 500);

  for (let i = 0; i < 200; i++) world.step(0.1);
  assert.equal(p.x, 1000 - p.radius);
});

test('stale inputs are ignored', () => {
  const p = smallWorld().spawnPlayer('a');
  p.applyInput({ seq: 5, angle: 1, throttle: 1, boost: false });
  p.applyInput({ seq: 4, angle: 2, throttle: 0, boost: true });
  assert.equal(p.input.angle, 1);
  assert.equal(p.lastInputSeq, 5);
});

test('eating food grows the player and food respawns', () => {
  const world = new World({ ...config.world, width: 1000, height: 1000, foodCount: 1 });
  const p = world.spawnPlayer('a');
  const [food] = world.food.values();
  p.x = food.x;
  p.y = food.y;
  const before = p.mass;
  world.step(0);
  assert.equal(p.mass, before + food.mass);
  assert.equal(world.food.size, 1);
  assert.ok(!world.food.has(food.id));
});

test('a much larger player eats a smaller one', () => {
  const world = smallWorld();
  const big = world.spawnPlayer('big');
  const small = world.spawnPlayer('small');
  big.mass = 400;
  big.x = big.y = small.x = small.y = 500;
  const { deaths } = world.step(0);
  assert.equal(deaths.length, 1);
  assert.equal(deaths[0].victim, small);
  assert.equal(deaths[0].killer, big);
  assert.ok(!world.players.has(small.id));
  assert.equal(big.mass, 400 + config.player.startMass);
});

test('similar-sized players do not eat each other', () => {
  const world = smallWorld();
  const a = world.spawnPlayer('a');
  const b = world.spawnPlayer('b');
  a.x = a.y = b.x = b.y = 500;
  assert.equal(world.step(0).deaths.length, 0);
});

test('bullets damage and eventually kill other players', () => {
  const world = smallWorld();
  const shooter = world.spawnPlayer('shooter');
  const target = world.spawnPlayer('target');
  shooter.x = 300;
  shooter.y = target.y = 500;
  target.x = 400;
  shooter.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, aim: 0, fire: true });

  world.step(0.1);
  for (let i = 0; i < 3; i++) world.step(0.05);
  assert.equal(target.health, config.player.maxHealth - config.gun.damage);
  assert.equal(shooter.health, config.player.maxHealth);

  let deaths = [];
  for (let i = 0; i < 100 && !deaths.length; i++) deaths = world.step(0.05).deaths;
  assert.equal(deaths[0]?.victim, target);
  assert.equal(deaths[0].killer, shooter);
});
