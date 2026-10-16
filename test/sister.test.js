import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { undergroundMap } from '../src/game/underground.js';

config.gangsters.count = 0;

function underground() {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  world.hires.list = world.hires.list.filter((h) => !h.oil); // (no shooting at us)
  return world;
}

test("Katya's in the oil hall's last cell (only her sibling sees her); open it and she runs to you, hugs you, then follows", () => {
  const world = underground();
  const s = world.sisters;
  assert.ok(s.cell, 'her cell');
  const account = { id: 5, name: 'ivan', bank: 0, guest: false, sisterFree: false };
  const p = world.spawnPlayer('ivan', null, account);
  p.account = account;
  const saved = [];
  s.onFree = (a) => saved.push(a);
  Object.assign(p, { x: s.cell.front.x, y: s.cell.front.y });
  world.step(1 / 30);
  assert.equal(s.view(p)[0], 3, 'sitting in her cell');
  assert.ok(!account.sisterFree, 'still locked in');
  s.door.open = true;
  world.step(1 / 30);
  assert.ok(account.sisterFree);
  assert.deepEqual(saved, [account]);
  assert.ok(s.events.some((e) => e.kind === 'sister_freed'));
  for (let t = 0; t < 5 && p.sis.state === 'run'; t += 1 / 30) world.step(1 / 30);
  assert.equal(p.sis.state, 'hug', 'she reaches you and hugs you');
  for (let t = 0; t < config.sister.hugSec + 1; t += 1 / 30) world.step(1 / 30);
  assert.equal(p.sis.state, 'follow');
  p.x += 300;
  for (let t = 0; t < 4; t += 1 / 30) world.step(1 / 30);
  assert.ok(Math.hypot(p.x - p.sis.x, p.y - p.sis.y) < 200, 'she keeps up');
  const other = world.spawnPlayer('olga', null, null);
  other.account = { id: 6, name: 'olga', bank: 0, guest: false, sisterFree: false };
  assert.equal(s.view(other)[0], 3, 'everyone else still has their own Katya in there');
});

test('at home: your dearest loaded bought home, else the starter house (poor!); she wanders inside, for everyone to see', () => {
  const { map } = validateMap({
    width: 4000, height: 3000, roads: [{ x: 0, y: 1400, w: 4000, h: 200 }],
    buildings: [{ type: 'house', x: 500, y: 1000, rot: 0 }, { type: 'mansion', x: 1500, y: 300, rot: 0 }, { type: 'garages', x: 2800, y: 1000, rot: 0 }],
  });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  const account = { id: 5, name: 'ivan', bank: 1e6, guest: false, sisterFree: true };
  const starter = world.homes.assign(account);
  assert.ok(starter);
  const p = world.spawnPlayer('ivan', null, account);
  p.account = account;
  world.step(1 / 30);
  let seen = world.sisters.visible(starter.x, starter.y, 2000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][4], 'ivan');
  assert.equal(seen[0][5], 1, 'only the starter house: she calls you poor');
  const inside = (b, x, y) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  assert.ok(inside(starter, seen[0][1], seen[0][2]));
  // Buy the mansion (and the garages: she won't live in those).
  const mansion = world.buildings.find((b) => b.type === 'mansion');
  const garages = world.buildings.find((b) => b.type === 'garages');
  world.homes.bought.set(mansion.id, { owner: account, ownerId: account.id });
  world.homes.bought.set(garages.id, { owner: account, ownerId: account.id });
  for (let t = 0; t < 20; t += 1 / 30) world.step(1 / 30);
  seen = world.sisters.visible(mansion.x, mansion.y, 3000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][5], 0);
  assert.ok(inside(mansion, seen[0][1], seen[0][2]), 'moved into the mansion, and stays inside');
  // Gone when her sibling isn't about.
  world.removePlayer(p.id);
  world.step(1 / 30);
  assert.equal(world.sisters.visible(mansion.x, mansion.y, 3000).length, 0);
});

test('accounts remember she is free', async () => {
  const { AccountStore } = await import('../src/accounts.js');
  const store = new AccountStore(':memory:');
  const { account } = store.createDeviceAccount();
  assert.equal(store.account(account.id).sisterFree, false);
  store.setSister(account.id, true);
  assert.equal(store.account(account.id).sisterFree, true);
});
