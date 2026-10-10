import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { hotbarOf } from '../src/game/cargo.js';

function world() {
  const w = new World({ ...config.world, width: 4000, height: 4000, terrain: false, buildingCount: 0, foodCount: 0, pickupStart: 0, parkingLots: 0 });
  w.water = { rivers: [{ points: [[3000, 0], [3000, 4000]], width: 200 }], lakes: [] };
  w.trees = [{ x: 1000, y: 3000, canopy: 70, trunk: { x: 991, y: 2991, w: 18, h: 18 }, seed: 1 }];
  w.dumpsters = [{ x: 2000, y: 2000, w: 56, h: 36 }];
  w.police.policeSee = () => false;
  w.police.witnessed = () => false;
  return w;
}

test('a dead player leaves a body with their goods, found guns and cash on it, for anyone to loot', () => {
  const w = world();
  const victim = w.spawnPlayer('victim');
  Object.assign(victim, { x: 500, y: 500, cash: 300 });
  hotbarOf(victim).add('vodka', 4);
  victim.addWeapon({ type: 'rifle', ammo: 10, reloadTimer: 0 });
  victim.health = 0;
  w.removePlayer(victim.id);
  const body = [...w.bodies.list.values()][0];
  assert.ok(body, 'a body');
  assert.equal(body.cash, 300);
  assert.equal([...w.pickups.values()].filter((x) => x.cash).length, 0, 'the cash stays on the body');
  const looter = w.spawnPlayer('looter');
  Object.assign(looter, { x: 520, y: 500, cash: 0 });
  assert.equal(w.bodies.loot(looter, body.id, -1), null);
  assert.equal(looter.cash, 300);
  const vodkaSlot = body.items.findIndex((s) => s?.good === 'vodka');
  const gunSlot = body.items.findIndex((s) => s?.type === 'rifle');
  assert.equal(w.bodies.loot(looter, body.id, vodkaSlot), null);
  assert.equal(hotbarOf(looter).count('vodka'), 4);
  assert.equal(w.bodies.loot(looter, body.id, gunSlot), null);
  assert.ok(looter.hasWeapon('rifle'));
  looter.x = 900;
  assert.equal(w.bodies.loot(looter, body.id, -1), 'too_far');
});

test('carry a body: slower, no shooting, no driving; get rid of it in a dumpster, the river or under a tree', () => {
  const w = world();
  const p = w.spawnPlayer('cleaner');
  const mk = (x, y) => w.bodies.add({ x, y, kind: 'npc', look: [1, 2, 3, 4] });
  Object.assign(p, { x: 2028, y: 2100 });
  const a = mk(2028, 2100);
  assert.equal(w.bodies.carry(p, a.id), null);
  // Slower.
  p.applyInput({ seq: 1, angle: 0, throttle: 1, aim: 0 });
  const x0 = p.x;
  w.step(1 / 30);
  assert.ok(p.x - x0 < p.speed / 30 * 0.7, 'walks slower with a body');
  // Next to the dumpster: gone.
  Object.assign(p, { x: 2028, y: 2080 });
  assert.deepEqual(w.bodies.dropCarried(p), { how: 'dumpster' });
  assert.equal(w.bodies.list.has(a.id), false);
  // The river.
  const b = mk(2960, 500);
  Object.assign(p, { x: 2960, y: 500 });
  w.bodies.carry(p, b.id);
  assert.deepEqual(w.bodies.dropCarried(p), { how: 'water' });
  // Under a tree: still there, but hidden.
  const c = mk(1000, 3000);
  Object.assign(p, { x: 1010, y: 3010 });
  w.bodies.carry(p, c.id);
  assert.deepEqual(w.bodies.dropCarried(p), { how: 'tree' });
  assert.equal(c.hidden, true);
  // Anywhere else: just put down.
  const d = mk(500, 500);
  Object.assign(p, { x: 500, y: 500 });
  w.bodies.carry(p, d.id);
  assert.deepEqual(w.bodies.dropCarried(p), { how: 'ground' });
  assert.equal(d.hidden, false);
});

test('a body left in the open gets found (the killer hears, but isn\'t named unless seen); a hidden one is not', () => {
  const w = world();
  const killer = w.spawnPlayer('killer');
  Object.assign(killer, { x: 100, y: 100 });
  const open = w.bodies.add({ x: 500, y: 500, kind: 'npc', look: [0, 0, 0, 0], killer });
  const hidden = w.bodies.add({ x: 1000, y: 3000, kind: 'npc', look: [0, 0, 0, 0], killer });
  hidden.hidden = true;
  w.police.policeSee = (x, y) => Math.hypot(x - 500, y - 500) < 50 || Math.hypot(x - 1000, y - 3000) < 50;
  for (let i = 0; i < 40; i++) w.step(1 / 30);
  assert.equal(open.reported, true);
  assert.equal(hidden.reported, false);
  assert.equal(killer.wanted, 0, 'nobody saw who did it');
  assert.equal(w.bodies.events.at(-1).kind, 'body_found');
});

test('walking into townsfolk bumps them out of the way', () => {
  const w = world();
  const p = w.spawnPlayer('walker');
  Object.assign(p, { x: 1500, y: 1500 });
  const person = { id: 1, x: 1510, y: 1500, inside: 0, route: [], health: 40, wallet: 0, mood: 0.5 };
  w.townsfolk.people.push(person);
  p.applyInput({ seq: 1, angle: 0, throttle: 0, aim: 0 });
  w.step(1 / 30);
  assert.ok(Math.hypot(person.x - p.x, person.y - p.y) >= p.radius + config.townsfolk.bodyRadius - 0.01);
});

test('being seen standing next to a body in the open makes you wanted', () => {
  const w = world();
  const victim = w.spawnPlayer('victim');
  Object.assign(victim, { x: 500, y: 500 });
  victim.health = 0;
  w.removePlayer(victim.id);
  const p = w.spawnPlayer('passer-by');
  Object.assign(p, { x: 1500, y: 1500 });
  w.police.witnessed = () => true;
  for (let i = 0; i < 40; i++) w.step(1 / 30);
  assert.equal(p.wanted, 0, 'far away: fine');
  Object.assign(p, { x: 560, y: 500 });
  for (let i = 0; i < 40; i++) w.step(1 / 30);
  assert.equal(p.wanted, config.crime.stars.near_body);
});
