import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { hotbarOf } from '../src/game/cargo.js';
import { STAGES, WinterMorning, alongRoute, routePoint, tutorialMap } from '../src/game/tutorial.js';

function tutorial() {
  const map = tutorialMap();
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  const p = world.spawnPlayer('newbie', null, null);
  world.tutorial.start(p);
  return { world, p, L: map.tutorial };
}

/** Step the world until `until()` (or give up after `sec`). */
function run(world, until, sec = 60, dt = 1 / 30) {
  for (let t = 0; t < sec; t += dt) {
    world.step(dt);
    if (until()) return true;
  }
  return false;
}

test('the tutorial map: long, a log cabin, a lake out back, a winding gravel driveway, a forest', () => {
  const map = tutorialMap();
  assert.equal(map.width, config.tutorial.width);
  assert.ok(map.width > map.height * 3, 'long');
  const ug = config.world.width * config.underground.scale * config.world.height * config.underground.scale;
  assert.ok(Math.abs(map.width * map.height - ug / 2) < ug * 0.05, 'half the underground');
  assert.equal(map.buildings[0].type, 'logcabin');
  assert.ok(map.trails.every((t) => t.gravel));
  assert.ok(map.lakes[0].y < map.buildings[0].y, 'the lake is behind the cabin');
  assert.ok(map.trees.length > 1000);
  const { route, cum } = map.tutorial;
  for (const t of map.trees.slice(1)) assert.ok(alongRoute(route, cum, t.x, t.y).d > 200, 'no trees on the driveway');
});

test('always winter, always morning, a little snow', () => {
  const env = new WinterMorning();
  env.step(5000);
  assert.equal(env.season.name, 'winter');
  assert.equal(env.isNight, false);
  assert.ok(env.intensity('rain') > 0);
});

test('waking up: nothing on you but a little cash, Katya at the door; she walks to the kitchen and hands you the rod', () => {
  const { world, p, L } = tutorial();
  assert.equal(p.cash, config.tutorial.startCash);
  assert.ok(p.inventory.every((s) => s === null), 'no knife yet');
  assert.equal(p.story.stage, 'wake');
  assert.ok(run(world, () => p.story.left && p.story.katya.path.length === 0 && p.story.katya.path.length === 0, 15));
  assert.ok(Math.hypot(p.story.katya.x - L.spots.kitchen.x, p.story.katya.y - L.spots.kitchen.y) < 2);
  Object.assign(p, { x: L.spots.kitchen.x + 60, y: L.spots.kitchen.y + 40 });
  world.step(1 / 30);
  assert.equal(p.story.stage, 'rod');
  assert.ok(p.inventory.some((s) => s?.type === 'rod'));
});

test('the ice hole: you can fish through it in winter, and in the tutorial you always land a fish', () => {
  const { world, p, L } = tutorial();
  world.frozen = true;
  const hole = L.iceHoles[0];
  p.inventory[0] = { type: 'rod', tool: true };
  p.selected = 0;
  Object.assign(p, { x: hole.x, y: hole.y + 150 });
  assert.equal(world.fishing.cast(p, -Math.PI / 2), null, 'cast into the hole');
  assert.ok(Math.hypot(p.fishing.x - hole.x, p.fishing.y - hole.y) < hole.r);
  p.fishing = null;
  assert.equal(world.fishing.cast(p, -Math.PI / 2 + 0.6), 'no_water', 'the rest of the lake is ice');
});

test("once you've a fish Katya comes out (Dad's spot), then shows you how to pick a pocket — on you; pick hers back and she is furious", () => {
  const { world, p, L } = tutorial();
  world.frozen = true;
  p.story.stage = 'fish';
  p.story.t = 0;
  p.story.katya.path = [];
  Object.assign(p.story.katya, { x: L.spots.kitchen.x, y: L.spots.kitchen.y });
  const hole = L.iceHoles[0];
  Object.assign(p, { x: hole.x, y: hole.y + 150 });
  p.input.aim = -Math.PI / 2;
  run(world, () => false, 3);
  assert.ok(!p.story.coming, 'she waits for you to catch one');
  hotbarOf(p).add('fish', 1);
  assert.ok(run(world, () => p.story.praised, 30), 'she comes out to see it');
  assert.ok(world.tutorial.events.some((e) => e.kind === 'dads_spot'));
  assert.equal(p.cash, config.tutorial.startCash);
  assert.ok(run(world, () => p.story.lifted, 30), 'then she lifts your cash');
  assert.equal(p.cash, 0);
  assert.equal(p.story.held, config.tutorial.startCash);
  assert.equal(p.story.stage, 'back');
  Object.assign(p, { x: p.story.katya.x + 20, y: p.story.katya.y });
  const got = world.tutorial.pickpocket(p);
  assert.equal(got.amount, config.tutorial.startCash);
  assert.equal(p.cash, config.tutorial.startCash);
  assert.ok(p.story.mad);
});

test('bring her the fish and she gives you the axe; chop a birch and the black car comes', () => {
  const { world, p, L } = tutorial();
  Object.assign(p.story, { stage: 'back', lifted: true });
  Object.assign(p.story.katya, { x: L.spots.kitchen.x, y: L.spots.kitchen.y, path: [] });
  hotbarOf(p).add('fish', 1);
  Object.assign(p, { x: L.spots.kitchen.x + 40, y: L.spots.kitchen.y + 50 });
  world.step(1 / 30);
  assert.equal(p.story.stage, 'axe');
  assert.equal(hotbarOf(p).count('fish'), 0);
  const axe = p.inventory.findIndex((s) => s?.type === 'axe');
  assert.ok(axe >= 0);
  // At the woodlot: swing at a birch until it's down.
  const [tx, ty] = L.woodTrees[0];
  Object.assign(p, { x: tx + 50, y: ty, selected: axe });
  p.input.aim = Math.PI;
  p.input.fire = true;
  assert.ok(run(world, () => p.story.stage === 'blackcar', 10), 'a car is coming');
  p.input.fire = false;
  assert.ok(p.story.black.s > alongRoute(L.route, L.cum, p.x, p.y).s, 'from further down the driveway');
  assert.ok(run(world, () => p.story.stage === 'fire', 20), 'it reaches the house');
  assert.ok(p.story.katya.gone);
  assert.ok(p.story.car, 'your Lada, out front');
  const other = world.spawnPlayer('other', null, null);
  assert.equal(world.carLockedFor(p.story.car, other), true, "nobody else's");
  assert.equal(world.carLockedFor(p.story.car, p), false);
});

test('the chase: the black car stays ahead; black ice halfway puts you into a tree, then the story ends', () => {
  const { world, p, L } = tutorial();
  Object.assign(p.story, { stage: 'blackcar', t: 0, black: { s: 10, x: 0, y: 0, angle: 0, back: true } });
  world.step(1 / 30);
  assert.equal(p.story.stage, 'fire');
  Object.assign(p, { x: L.park.x - 80, y: L.park.y }); // (ran back to the house: it drives off)
  run(world, () => false, 6, 1 / 10);
  assert.ok(p.story.black.s > 1000, 'it gets a head start');
  const car = p.story.car;
  car.driver = p; // (got in, as the World does on E)
  p.vehicle = car;
  world.step(1 / 30);
  assert.equal(p.story.stage, 'chase');
  // Drive along the route: the black car keeps ahead.
  for (let s = 300; s < L.crash.s - 600; s += 40) {
    const q = routePoint(L.route, L.cum, s);
    Object.assign(car, { x: q.x, y: q.y, angle: q.angle, vx: 0, vy: 0 });
    world.step(1 / 10);
    assert.ok(p.story.black.s > s, 'still ahead');
  }
  const q = routePoint(L.route, L.cum, L.crash.s);
  Object.assign(car, { x: q.x, y: q.y, angle: q.angle, vx: Math.cos(q.angle) * 300, vy: Math.sin(q.angle) * 300 });
  world.step(1 / 30);
  assert.equal(p.story.stage, 'crash');
  assert.ok(car.script, 'the ice has the wheel');
  assert.ok(run(world, () => world.tutorial.finished.length > 0, 10));
  assert.equal(world.tutorial.finished[0], p);
  world.removePlayer(p.id);
  assert.ok(![...world.vehicles.values()].includes(car), 'the Lada goes with them');
});

test('the story as the client sees it', () => {
  const { world, p } = tutorial();
  const view = world.tutorial.view(p);
  assert.equal(view[0], STAGES.indexOf('wake'));
  assert.ok(Array.isArray(view[2]), 'Katya is there');
});

test('a new account starts in the tutorial; the crash lands them in the gulag, and Lyosha gets them out to their house with money and a knife', async () => {
  const { AccountStore } = await import('../src/accounts.js');
  const { RoomManager } = await import('../src/game/RoomManager.js');
  const { validateMap } = await import('../src/game/mapFile.js');
  const { map } = validateMap({
    width: 6000, height: 5000,
    roads: [{ x: 0, y: 1900, w: 6000, h: 270 }],
    buildings: [{ type: 'police', x: 400, y: 1400, rot: 0 }, { type: 'prison', x: 2000, y: 300, rot: 0, size: { w: 1600, h: 1400 } }, { type: 'house', x: 600, y: 2600, rot: 0 }],
  });
  const store = new AccountStore(':memory:');
  const old = store.createDeviceAccount().account;
  store.db.prepare('UPDATE accounts SET tutorial = 1 WHERE id = ?').run(old.id);
  assert.equal(store.account(old.id).tutorial, true, 'accounts from before are done with it');
  const { account } = store.createDeviceAccount();
  assert.equal(account.tutorial, false, 'a new account has it ahead of them');
  const rooms = new RoomManager({ store });
  rooms.map = map;
  rooms.warm();
  try {
    const sent = [];
    const client = { id: 1, account: store.live(account.id), send: (m) => sent.push(m), sendRaw: () => {}, chatLimiter: { tryConsume: () => true }, isOpen: true };
    rooms.join(client);
    rooms.place(client, 'tutorial');
    client.room.spawn(client, 'newbie', null);
    assert.equal(client.room.kind, 'tutorial');
    assert.ok(sent.some((m) => m.t === 'welcome' && m.tutorial?.spots), 'the client gets the cabin');
    const p = client.player;
    p.story.stage = 'crash';
    p.story.t = 100;
    client.room.step(1 / 30); // (the story's over: the room sends them on)
    assert.equal(client.room.kind, 'town');
    assert.equal(store.account(account.id).tutorial, true);
    const q = client.player;
    assert.ok(q.jailed?.prison, 'in the gulag');
    assert.equal(q.jailed.quota, config.tutorial.quota);
    assert.ok(q.inventory.some((s) => s?.type === 'pickaxe'));
    const town = client.room;
    town.step(config.tutorial.lyoshaSec + 1);
    assert.equal(q.jailed, null, 'Lyosha paid them out');
    assert.equal(q.cash, config.tutorial.lyoshaCash);
    assert.ok(q.inventory.some((s) => s?.type === 'knife'), "Katya's knife");
    const home = town.world.homes.homeOf(client.account);
    assert.ok(home && Math.hypot(q.x - (home.x + home.w / 2), q.y - (home.y + home.h / 2)) < 400, 'dropped at their starter house');
    assert.ok(sent.some((m) => m.t === 'police' && m.kind === 'prison_out' && m.how === 'lyosha'));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    rooms.stopAll();
  }
});

test('skipping the tutorial: straight to town, a free player', async () => {
  const { AccountStore } = await import('../src/accounts.js');
  const { RoomManager } = await import('../src/game/RoomManager.js');
  const store = new AccountStore(':memory:');
  const { account } = store.createDeviceAccount();
  const rooms = new RoomManager({ store });
  rooms.warm();
  try {
    const client = { id: 1, account: store.live(account.id), send: () => {}, sendRaw: () => {}, chatLimiter: { tryConsume: () => true }, isOpen: true };
    rooms.join(client);
    rooms.place(client, 'tutorial');
    client.room.spawn(client, 'newbie', null);
    const tut = client.room;
    assert.equal(rooms.leaveTutorial(client, 'skip'), true);
    assert.equal(client.room.kind, 'town');
    assert.ok(client.player && !client.player.jailed);
    assert.equal(store.account(account.id).tutorial, true);
    assert.equal(tut.size, 0);
  } finally {
    rooms.stopAll();
  }
});

test('an account from before the tutorial gets it once too, and keeps what it had saved', async () => {
  const { AccountStore } = await import('../src/accounts.js');
  const { RoomManager } = await import('../src/game/RoomManager.js');
  const store = new AccountStore(':memory:');
  const { account } = store.createDeviceAccount();
  store.setCarried(account.id, 777, [null, { good: 'vodka', qty: 3 }, null, null, null]);
  const rooms = new RoomManager({ store });
  rooms.warm();
  try {
    const client = { id: 1, account: store.live(account.id), send: () => {}, sendRaw: () => {}, chatLimiter: { tryConsume: () => true }, isOpen: true };
    rooms.join(client);
    rooms.place(client, 'tutorial');
    client.room.spawn(client, 'vet', null);
    assert.equal(client.player.cash, config.tutorial.startCash, 'nothing of theirs in the tutorial');
    client.room.step(1 / 30);
    assert.equal(store.account(account.id).cash, 777, 'still saved');
    rooms.leaveTutorial(client, 'skip');
    assert.equal(client.player.cash, 777, 'back in town with it all');
    assert.deepEqual(client.player.inventory[1], { good: 'vodka', qty: 3 });
  } finally {
    rooms.stopAll();
  }
});
