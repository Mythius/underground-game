import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';

config.gangsters.count = 0;

function town() {
  const { map } = validateMap({ width: 4000, height: 3000, buildings: [{ type: 'bunker', x: 1000, y: 1000, rot: 0 }] });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  world.police.witnessed = () => false;
  return world;
}
const acc = { id: 1, name: 'p1', bank: 0, guest: false };

test("a bunker's door is locked to everyone until its lock is picked", () => {
  const world = town();
  const b = world.buildings.find((x) => x.type === 'bunker');
  const p = world.spawnPlayer('p1', null, acc);
  const door = b.doors.find((d) => d.exterior);
  Object.assign(p, { x: b.x - 30, y: door.y + door.h / 2 }); // (outside, by the door in the west wall)
  assert.equal(world.lockedFor(door, p), true);
  assert.equal(world.lockedDoorNear(p), door, 'hold F to pick it');
  world.homes.unlock(door);
  assert.equal(world.lockedFor(door, p), false);
});

test("the trapdoor only opens with a key off one of the governor's guards, and the key's used up", () => {
  const world = town();
  const b = world.buildings.find((x) => x.type === 'bunker');
  const t = world.trapdoorOf(b);
  const p = world.spawnPlayer('p1', null, acc);
  Object.assign(p, { x: t.x + t.w / 2, y: t.y + t.h + 20 });
  assert.equal(world.openTrapdoor(p, b.id), 'trapdoor_locked');
  p.inventory[2] = { type: 'bunkerkey', tool: true };
  assert.equal(world.openTrapdoor(p, b.id), null);
  assert.ok(world.openTrapdoors.has(b.id));
  assert.ok(!p.inventory.some((s) => s?.type === 'bunkerkey'), 'single use');
  assert.equal(world.openTrapdoor(p, b.id), 'trapdoor_open');
});

test("each of the governor's guards drops a bunker key on his body", () => {
  const world = town();
  const added = [];
  world.bodies.add = (body) => added.push(body);
  const h = { kind: 'hire', role: 'govguard', side: 'state', x: 500, y: 500, angle: 0, health: 1, maxHealth: 220, weapon: 'rifle', ammo: 5, foes: new Map() };
  world.hires.list.push(h);
  world.hires.damage(h, 1e6, null);
  assert.ok(added[0].items.some((s) => s?.type === 'bunkerkey'));
});
