import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';

config.player.healthRegenPerSec = 0;

// Open country with six forests and no town.
function country() {
  const forests = [[1000, 1000], [3000, 1000], [5000, 1000], [1000, 3000], [3000, 3000], [5000, 3000]].map(([x, y]) => ({ x, y, r: 300 }));
  const { map } = validateMap({ width: 6000, height: 4000, roads: [], buildings: [], forests });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  world.hires.list.length = 0;
  world.hires.gangsterTimers.length = 0;
  world.hires.step = () => {};
  for (const u of world.police.units) u.officer.health = -1e9;
  world.police.policeSee = () => false;
  world.police.witnessed = () => false;
  return world;
}
const run = (world, sec) => { for (let i = 0; i < sec * 30; i++) world.step(1 / 30); };
function player(world, id, x, y) {
  const p = world.spawnPlayer(`p${id}`);
  p.account = { id, name: `p${id}`, bank: 0, guest: false };
  Object.assign(p, { x, y });
  return p;
}

test('five packs come out of the forests at nightfall and are gone at dawn', () => {
  const world = country();
  run(world, 1);
  assert.equal(world.wolves.list.length, 0, 'none by day');
  world.night = true;
  run(world, 1);
  assert.equal(world.wolves.packs.length, config.wolves.packsPerNight);
  for (const pack of world.wolves.packs) {
    const size = world.wolves.list.filter((w) => w.pack === pack).length;
    assert.ok(size >= config.wolves.packSize[0] && size <= config.wolves.packSize[1], `pack of ${size}`);
  }
  for (const w of world.wolves.list) assert.ok(Math.hypot(w.x - w.pack.den.x, w.y - w.pack.den.y) < w.pack.den.r * 1.2, 'in its forest');
  run(world, 20);
  assert.equal(world.wolves.packs.length, config.wolves.packsPerNight, 'no more packs later the same night');
  world.night = false;
  run(world, 0.1);
  assert.equal(world.wolves.list.length, 0, 'gone at dawn');
  world.night = true;
  run(world, 0.1);
  assert.equal(world.wolves.packs.length, config.wolves.packsPerNight, 'new packs the next night');
});

test('walk up to a pack on foot and it kills you fast; nobody in a car is touched', () => {
  const world = country();
  world.night = true;
  run(world, 0.1);
  const w = world.wolves.list[0];
  const p = player(world, 1, w.x + 200, w.y);
  const deaths = [];
  for (let i = 0; i < 4 * 30 && p.alive; i++) deaths.push(...world.step(1 / 30).deaths);
  assert.equal(p.alive, false, 'dead within a few seconds');
  assert.equal(deaths.find((d) => d.victim === p)?.killer.name, 'the wolves');

  const q = player(world, 2, w.x + 150, w.y);
  q.vehicle = { id: -1 }; // (sitting in a car)
  const hp = q.health;
  run(world, 3);
  assert.equal(q.health, hp, 'left alone in a car');
});

test('wolves die to gunfire, and the pack goes for whoever shot one', () => {
  const world = country();
  world.night = true;
  run(world, 0.1);
  const [w, other] = world.wolves.list;
  const p = player(world, 1, 100, 100); // (far from every den)
  world.wolves.damage(w, 10, p);
  assert.equal(w.pack.target, p);
  world.wolves.damage(w, config.wolves.health, p);
  assert.ok(!world.wolves.list.includes(w));
  assert.ok(world.wolves.list.includes(other));
});
