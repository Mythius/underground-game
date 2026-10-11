import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)
config.player.healthRegenPerSec = 0;

// A police station by a road, and the prison on the other side of it (its gatehouse facing the road).
function camp() {
  const { map, error } = validateMap({
    width: 6000,
    height: 5000,
    roads: [{ x: 0, y: 1900, w: 6000, h: 270 }],
    buildings: [
      { type: 'police', x: 400, y: 1400, rot: 0 },
      { type: 'prison', x: 2000, y: 300, rot: 0, size: { w: 1600, h: 1400 } },
    ],
  });
  assert.equal(error, undefined);
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0, parkingLots: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  const b = world.buildings.find((x) => x.type === 'prison');
  const p = world.spawnPlayer('crook');
  p.account = { id: 7, name: 'crook', bank: 0, guest: false };
  return { world, b, p, prison: world.prison, s: b.prison };
}

let seq = 1;
const walk = (world, p, angle, sec, extra = {}) => {
  p.applyInput({ seq: seq++, angle, throttle: 1, aim: angle, ...extra });
  for (let i = 0; i < sec * 30; i++) world.step(1 / 30);
  p.applyInput({ seq: seq++, angle, throttle: 0, aim: angle });
};
const inside = (r, x, y) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;

test('arrested by the Militsiya: off to the prison, hotbar held by the warden, a pickaxe and a coal quota', () => {
  const { world, p, prison, s } = camp();
  const unit = world.police.units.find((u) => !u.post);
  p.x = 1000; p.y = 2400;
  p.wanted = 2;
  p.cash = 100;
  const knife = p.inventory[0];
  unit.officer.onFoot = true;
  unit.officer.x = p.x + 30;
  unit.officer.y = p.y;
  unit.target = p;
  for (let i = 0; i < (config.police.arrestSec + 0.5) * 30 && !p.jailed; i++) world.step(1 / 30);
  assert.ok(p.jailed?.prison, 'in prison');
  assert.equal(p.cash, 100, 'no bail taken on the spot');
  assert.equal(p.jailed.quota, 2 * config.prison.coalPerStar);
  assert.equal(p.jailed.bail, 2 * config.police.bailPerStar);
  assert.equal(p.jailed.stash[0], knife, 'the warden has the knife');
  assert.equal(p.inventory[0].type, 'pickaxe');
  assert.ok(inside(s.inner, p.x, p.y), 'on the parade ground');
  assert.deepEqual(p.account.prison, { quota: 20, coal: 0, bail: 500 });
  assert.equal(p.wanted, 0);
});

test('the wire and the gatehouse counter keep prisoners in; the warden takes bail and lets you out', () => {
  const { world, b, p, prison, s } = camp();
  prison.jail(p, 1);
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const start = { ...s.spawn };
    Object.assign(p, start);
    walk(world, p, angle, 8);
    assert.ok(inside(b, p.x, p.y), `still inside heading ${angle}`);
    assert.ok(p.jailed, 'still a prisoner');
  }
  // Up to the counter from the camp side: the warden is there, but there's no way past him.
  const warden = b.npc;
  Object.assign(p, { x: warden.x, y: warden.y - 60 });
  walk(world, p, Math.PI / 2, 3);
  assert.ok(p.y < warden.y, 'the counter holds');
  assert.equal(prison.payBail(p, p.id), 'cant_afford_bail');
  p.cash = 300;
  assert.deepEqual(prison.payBail(p, p.id), { name: 'crook', bail: config.police.bailPerStar });
  assert.equal(p.jailed, null);
  assert.equal(p.cash, 300 - config.police.bailPerStar);
  assert.equal(p.inventory[0].type, 'knife', 'things back from the warden');
  assert.ok(!inside(b, p.x, p.y) || p.y > b.y + b.h - 20, 'out by the road');
  assert.equal(p.account.prison, null);
});

test('a friend pays your bail from the visitors\' side of the counter', () => {
  const { world, b, p, prison } = camp();
  prison.jail(p, 3);
  const friend = world.spawnPlayer('friend');
  friend.account = { id: 8, name: 'friend', bank: 5000, guest: false };
  friend.cash = 0;
  Object.assign(friend, { x: b.npc.x, y: b.npc.y + 70 });
  assert.equal(prison.describe(friend).prisoners[0].name, 'crook');
  assert.deepEqual(prison.payBail(friend, p.id), { name: 'crook', bail: 3 * config.police.bailPerStar });
  assert.equal(friend.account.bank, 5000 - 3 * config.police.bailPerStar);
  assert.equal(p.jailed, null);
});

test('mine coal and tip it into the bunker: your quota served, you go free', () => {
  const { world, b, p, prison, s } = camp();
  const coalFace = [...world.work.nodes.values()].filter((n) => n.kind === 'coal');
  assert.ok(coalFace.length > 25, `${coalFace.length} coal rocks`);
  assert.ok(coalFace.every((n) => inside(s.inner, n.x, n.y)), 'inside the wire');
  prison.jail(p, 1);
  p.jailed.quota = 4;
  const node = coalFace[0];
  Object.assign(p, { x: node.x - node.r - p.radius - 10, y: node.y });
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, aim: 0, fire: true });
  for (let i = 0; i < 30 * config.work.swingSec * (node.max + 1) && node.hp > 0; i++) world.step(1 / 30);
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, aim: 0, fire: false });
  assert.equal(hotbarOf(p).count('coal'), 2);
  Object.assign(p, { x: s.hopper.x + 70, y: s.hopper.y });
  world.step(1 / 30);
  assert.equal(p.jailed.coal, 2);
  assert.equal(hotbarOf(p).count('coal'), 0, 'into the bunker');
  hotbarOf(p).add('coal', 2);
  world.step(1 / 30);
  assert.equal(p.jailed, null, 'served');
  assert.equal(hotbarOf(p).count('coal'), 0, 'no coal out of the camp');
});

test('escape: lift a guard\'s key, open the inner door, pick the outer lock — wanted, and the towers shoot', () => {
  const { world, b, p, prison, s } = camp();
  prison.jail(p, 1);
  const guard = world.police.prisonGuards()[0];
  assert.ok(guard, 'guards on patrol');
  // From the front he catches you: more coal.
  guard.angle = 0;
  Object.assign(p, { x: guard.x + 40, y: guard.y });
  world.pickpocket(p);
  assert.equal(p.jailed.quota, config.prison.coalPerStar + config.prison.caughtCoal);
  assert.ok(!p.inventory.some((x) => x?.type === 'key'));
  // From behind he never feels it.
  p.pickpocketReady = 0;
  Object.assign(p, { x: guard.x - 40, y: guard.y });
  world.pickpocket(p);
  assert.ok(p.inventory.some((x) => x?.type === 'key'), 'got the key');
  // The inner door: shut to anyone without a key, open with one.
  const kd = prison.keyDoor;
  Object.assign(p, { x: kd.x + kd.w / 2, y: kd.y + kd.h + 30 });
  for (const g of world.police.prisonGuards()) { g.x = -9999; g.y = -9999; } // (out of the way)
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, use: true });
  world.step(1 / 30);
  assert.equal(kd.open, true, 'the key opens it');
  assert.ok(!p.inventory.some((x) => x?.type === 'key'), 'key used up');
  // Through to the strip, along to the outer door, and pick it.
  walk(world, p, -Math.PI / 2, 0.6);
  assert.ok(p.y < kd.y, 'in the strip');
  const od = prison.outerDoor;
  Object.assign(p, { x: od.x + od.w / 2, y: od.y + od.h + 30 });
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, rob: true });
  for (let i = 0; i < (config.prison.lockpickSec + 0.5) * 30 && !od.open; i++) world.step(1 / 30);
  assert.equal(od.open, true, 'picked');
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, rob: false });
  walk(world, p, -Math.PI / 2, 0.8);
  assert.ok(p.y < b.y, 'over the wire');
  assert.equal(p.jailed, null);
  assert.equal(p.wanted, config.prison.escapeStars);
  assert.ok(p.account.prison, 'not away yet: shot down here, you\'d be back inside');
  // The snipers open up.
  let sniped = false;
  for (let i = 0; i < 3 * 30 && !sniped; i++) {
    world.step(1 / 30);
    sniped = [...world.bullets.values()].some((x) => x.weaponType === 'sniper' && x.owner.name === 'a tower sniper');
  }
  assert.ok(sniped || !p.alive, 'shot at from the towers');
  // Out of their range: got away.
  if (!p.alive) return;
  Object.assign(p, { x: 5900, y: 4900 });
  world.step(1 / 30);
  assert.equal(p.account.prison, null, 'got away');
});

test('the escape doors swing shut and lock again', () => {
  const { world, prison } = camp();
  prison.picked(prison.outerDoor);
  assert.equal(prison.lockedFor(prison.outerDoor), false);
  for (let i = 0; i < (config.prison.doorOpenSec + 1) * 30; i++) world.step(1 / 30);
  assert.equal(prison.outerDoor.open, false);
  assert.equal(prison.lockedFor(prison.outerDoor), true);
});

test('a sentence carries on after logging off (resume)', () => {
  const { world, p, prison } = camp();
  prison.jail(p, 0, { quota: 30, coal: 12, bail: 750 });
  assert.equal(p.jailed.coal, 12);
  assert.equal(p.jailed.quota, 30);
  assert.equal(p.jailed.bail, 750);
});
