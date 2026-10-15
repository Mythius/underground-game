import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
config.gangsters.count = 0;
const HOMELESS = { sitters: config.homeless.sitters, wanderers: config.homeless.wanderers };
Object.assign(config.homeless, { sitters: 0, wanderers: 0 }); // (no knives in the other tests; theirs put them back)
const RATS = config.giantRats.count;
config.giantRats.count = 0; // (no giant rats either, but in their own test)
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/game/RoomManager.js';
import { validateMap } from '../src/game/mapFile.js';
import { makeWeapon } from '../src/game/entities.js';
import { CELL, UG, generateUnderground, rockRects, undergroundMap } from '../src/game/underground.js';
import { World } from '../src/game/World.js';

test('the underground is dug the same every time, and every bit of it can be walked to from the first ladder', () => {
  const anchors = [{ x: 1500, y: 1500 }, { x: 6000, y: 2000 }, { x: 3000, y: 6000 }];
  const a = generateUnderground({ width: 8000, height: 8000, anchors });
  const b = generateUnderground({ width: 8000, height: 8000, anchors });
  assert.equal(a.grid, b.grid);
  assert.deepEqual(a.decor, b.decor);
  assert.equal(a.ladders.filter((l) => !l.vent).length, 3, 'an entrance bunker (with a ladder) for each anchor');
  assert.ok(a.ladders.filter((l) => l.vent).length <= 1, "(and the oil hall office's, up to a vent in town)");
  for (const kind of [UG.MINE, UG.TUNNEL, UG.PLATFORM, UG.BUNKER]) assert.ok(a.grid.includes(String(kind)), `has some ${kind}`);
  assert.ok(a.stations.length >= 1 && a.bunkers.length >= 6);
  const { cols, rows, grid } = a;
  const floor = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && grid[y * cols + x] !== '0';
  const l = a.ladders[0];
  const start = [Math.floor(l.x / CELL), Math.floor(l.y / CELL)];
  const seen = new Set([start.join()]);
  const q = [start];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (floor(nx, ny) && !seen.has(`${nx},${ny}`)) { seen.add(`${nx},${ny}`); q.push([nx, ny]); }
  }
  assert.equal(seen.size, [...grid].filter((c) => c !== '0').length, 'no part of it is cut off');
  // The rock rectangles cover exactly the rock.
  const rock = rockRects(a).reduce((sum, r) => sum + r.w * r.h, 0) - (cols * CELL + CELL) * CELL - cols * CELL * CELL; // (less the strips past the edge)
  assert.equal(rock, [...grid].filter((c) => c === '0').length * CELL * CELL);
});

test('caves wind through the rock, one round a lake with a shore all the way round it', () => {
  const u = generateUnderground({ width: 13500, height: 13500, anchors: [{ x: 3000, y: 3000 }, { x: 10000, y: 9000 }] });
  assert.ok(u.caves.length >= 3, 'a few caves');
  assert.equal(u.caves.filter((c) => c.lake).length, 1, 'one of them has the lake');
  assert.ok(u.lakes.length >= 1 && u.lakes[0].r >= 400, 'a good-sized lake');
  const cellAt = (x, y) => u.grid[Math.floor(y / CELL) * u.cols + Math.floor(x / CELL)];
  for (const l of u.lakes) {
    for (let a = 0; a < Math.PI * 2; a += 0.1) for (const d of [0, l.r / 2, l.r + 60]) assert.equal(cellAt(l.x + Math.cos(a) * d, l.y + Math.sin(a) * d), String(UG.CAVE), 'water (and its shore) is all cave floor');
  }
});

test('an oil hall with pits and cells lies against the edge of the map, behind locked doors', () => {
  const u = generateUnderground({ width: 13500, height: 13500, anchors: [{ x: 3000, y: 3000 }, { x: 10000, y: 9000 }] });
  assert.equal(u.halls.length, 1, 'an oil hall');
  const hall = u.halls[0];
  assert.ok(hall.x <= CELL || hall.y <= CELL || hall.x + hall.w >= (u.cols - 1) * CELL || hall.y + hall.h >= (u.rows - 1) * CELL, 'against an edge');
  const inHall = (d) => d.x >= hall.x && d.y >= hall.y && d.x + d.w <= hall.x + hall.w && d.y + d.h <= hall.y + hall.h;
  assert.equal(u.decor.filter((d) => d.k === 'oilpit' && inHall(d)).length, 3, 'three oil pits');
  assert.ok(u.decor.filter((d) => d.k === 'bars' && inHall(d)).length >= 3, 'a row of cells');
  assert.ok(u.decor.some((d) => d.k === 'tube' && inHall(d)), 'strip lights');
});

test("doors where the shafts come out into built places; the oil hall's are locked till picked, and lock again once shut", () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  world.hires.list = world.hires.list.filter((h) => !h.oil); // (not shot at by the oil hall's watchers meanwhile)
  const doors = world.doors.filter((d) => d.underground && !d.cell && !d.office);
  assert.ok(doors.length > 20, 'plenty of doors');
  const u = world.underground.layout, cell = (x, y) => u.grid[Math.floor(y / CELL) * u.cols + Math.floor(x / CELL)];
  for (const d of doors.filter((x) => !x.locked)) assert.equal(cell(d.x + d.w / 2, d.y + d.h / 2), String(UG.MINE), 'a shaft door is in the shaft');
  const locked = doors.filter((d) => d.locked);
  assert.ok(locked.length >= 2, 'the ways into the hall');
  const hall = u.halls[0];
  for (const d of locked) assert.ok(d.x + d.w >= hall.x - CELL && d.x <= hall.x + hall.w + CELL && d.y + d.h >= hall.y - CELL && d.y <= hall.y + hall.h + CELL, 'beside the hall');

  const d = locked[0];
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  Object.assign(p, { x: d.x + d.w / 2 + d.nx * 40, y: d.y + d.h / 2 + d.ny * 40 });
  assert.ok(world.isBlocked(d.x + d.w / 2, d.y + d.h / 2, 5), 'shut: solid');
  p.input.use = true;
  world.step(1 / 30);
  assert.equal(d.open, false, "E won't open it");
  assert.equal(world.lockedDoorNear(p), d);
  p.input.rob = true;
  for (let t = 0; t < config.underground.lockpickSec + 1; t += 1 / 30) world.step(1 / 30);
  assert.equal(d.open, true, 'picked: it swings open');
  assert.ok(!world.isBlocked(d.x + d.w / 2, d.y + d.h / 2, 5));
  p.input.rob = false;
  world.step(1 / 30);
  Object.assign(p, { x: d.x + d.w / 2 + d.nx * 60, y: d.y + d.h / 2 + d.ny * 60 });
  p.input.use = true;
  world.step(1 / 30);
  assert.equal(d.open, false, 'shut again');
  assert.equal(world.lockedFor(d, p), true, 'and locked again');

  const plain = doors.find((x) => !x.locked);
  Object.assign(p, { x: plain.x + plain.w / 2 + plain.nx * 40, y: plain.y + plain.h / 2 + plain.ny * 40 });
  p.input.use = true;
  world.step(1 / 30);
  assert.equal(plain.open, true, 'a shaft door just opens');
});

test("loot's in the bunkers' cabinets, which anyone can open, and they fill again once emptied (on the floor: only bottles of vodka)", () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const u = world.underground.layout;
  assert.equal(u.loot, undefined);
  assert.ok([...world.pickups.values()].every((k) => k.goods?.good === 'vodka' && k.goods.qty === 1), 'nothing on the ground but loose bottles');
  assert.ok(u.cabinets.length >= u.bunkers.length, 'a cabinet or two in every bunker room');
  const within = (c, b) => c.x >= b.x && c.y >= b.y && c.x + c.w <= b.x + b.w && c.y + c.h <= b.y + b.h;
  for (const c of u.cabinets) assert.ok(u.bunkers.some((b) => within(c, b)) || within(c, u.oil.office), "in a bunker (or the oil hall's office)");
  const cabs = world.underground.cabinets.map((c) => c.it);
  assert.ok(cabs.every((it) => it.slots.some(Boolean)), 'all stocked');
  const it = cabs[0];
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  Object.assign(p, { x: it.x - 30, y: it.y + it.h / 2 });
  p.inventory = p.inventory.map((s, i) => (i ? null : s));
  assert.ok(world.furnishings.contents(p, it.id), 'it opens for anyone');
  for (let s = 0; s < it.slots.length; s++) {
    while (it.slots[s]) { // (whatever it is, room for it: the hotbar emptied each time)
      p.inventory = p.inventory.map((x, i) => (i ? null : x));
      assert.equal(world.furnishings.take(p, it.id, s), null);
    }
  }
  assert.ok(!it.slots.some(Boolean), 'emptied');
  for (let t = 0; t < config.underground.lootRespawnSec * 1.3; t += 1) world.underground.step(1);
  assert.ok(it.slots.some(Boolean), 'something in it again');
});

test('some shafts and passages are sewers: a channel down the middle you wade through, walkways either side', () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const u = world.underground.layout;
  const sewers = [...u.grid].filter((c) => c === String(UG.SEWER)).length;
  assert.ok(sewers > 50, 'a good few');
  assert.ok(u.channels.length > 0 && world.water.rivers.length === u.channels.length, 'the channels are water');
  const cellAt = (x, y) => u.grid[Math.floor(y / CELL) * u.cols + Math.floor(x / CELL)];
  for (const { points } of u.channels) for (const [x, y] of points) assert.equal(cellAt(x, y), String(UG.SEWER));
  const { points: [[ax, ay], [bx, by]] } = u.channels.find(({ points: [[ax], [bx]] }) => ax !== bx); // (an east–west bit)
  const mx = (ax + bx) / 2;
  assert.ok(world.isSwimming(mx, ay), 'wading in the channel');
  assert.ok(!world.isSwimming(mx, ay + 55) && !world.isBlocked(mx, ay + 55, 20), 'dry on the walkway');
});

test("gold in the old miner's cave: he lends you his pickaxe, the gold's slow to come back, and he wants the pick back if you wander off", () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const u = world.underground.layout;
  const gold = [...world.work.nodes.values()].filter((n) => n.kind === 'gold');
  assert.ok(gold.length >= 6, 'gold rocks');
  const cave = u.caves.find((c) => c.gold);
  assert.ok(cave && !cave.lake, 'in a dry cave');
  assert.ok(gold.every((n) => Math.hypot(n.x - cave.x, n.y - cave.y) < cave.r + CELL));
  assert.ok(Math.hypot(u.miner.x - cave.x, u.miner.y - cave.y) < cave.r, 'the miner lives there');
  const bear = world.bears.list[0];
  assert.ok(!bear || Math.hypot(bear.x - cave.x, bear.y - cave.y) > cave.r, "and the bear doesn't");

  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  Object.assign(p, { x: u.miner.x + 60, y: u.miner.y });
  assert.deepEqual(world.underground.lend(p), { borrowed: 'pickaxe' });
  assert.equal(p.tool?.type, 'pickaxe');
  // Dig a gold rock out.
  const n = gold[0];
  Object.assign(p, { x: n.x + n.r + p.radius + 5, y: n.y });
  p.input.aim = Math.PI; // (facing it)
  for (let i = 0; i < n.max * 2 + 4 && n.hp > 0; i++) { p.input.fire = true; p.swingCooldown = 0; world.work.step(0.01); }
  assert.equal(n.hp, 0, 'worked out');
  assert.ok(p.inventory.some((s) => s?.good === 'gold'), 'a gold nugget');
  assert.ok(n.readyAt - world.work.time >= config.work.regrowSec.gold - 1, 'slow to come back');
  // Off too far with it: back to him.
  Object.assign(p, { x: u.miner.x + config.underground.minerLeash + 200, y: u.miner.y });
  world.underground.step(1.1);
  assert.ok(!p.inventory.some((s) => s?.minerLoan), 'gone back to the miner');
});

test('the blind albino bear: it hears footsteps and gunshots (not someone standing still), charges what it hears close, and takes an awful lot of killing', () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const u = world.underground.layout;
  assert.equal(world.bears.list.length, 1, 'one bear');
  const bear = world.bears.list[0];
  const den = u.caves.find((c) => !c.lake && Math.hypot(c.x - bear.x, c.y - bear.y) <= c.r + 1);
  assert.ok(den, 'in a cave without the lake');
  assert.equal(bear.health, config.bear.health);
  bear.x = den.x; bear.y = den.y;

  // Standing still a little way off: it never knows.
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  Object.assign(p, { x: bear.x + 200, y: bear.y });
  world.bears.step(1 / 30); world.bears.step(1 / 30);
  bear.x = den.x; bear.y = den.y; bear.state = 'roam';
  for (let i = 0; i < 5; i++) { world.bears.step(1 / 30); Object.assign(bear, { x: den.x, y: den.y }); }
  assert.notEqual(bear.state, 'charge', 'silent: not heard');

  // Sprinting past, close: it charges where it heard you.
  world.bears.lastPos.set(p, [p.x - 12, p.y]); // (12 units in a thirtieth of a second: a sprint)
  world.bears.step(1 / 30);
  assert.equal(bear.state, 'charge');

  // A gunshot far off: it goes to listen.
  bear.state = 'roam';
  world.bears.noise(bear.x + 1500, bear.y, config.bear.hear.gunshot);
  assert.equal(bear.state, 'listen');

  // Up against it: a swipe takes a big piece of you.
  Object.assign(p, { x: bear.x + config.bear.radius + p.radius, y: bear.y });
  bear.swipe = 0;
  const before = p.health;
  world.bears.step(1 / 30);
  assert.ok(p.health <= before - p.maxHealth * config.bear.swipeShare + 0.01, 'swiped');

  // Shot a hundred times with a pistol it's barely hurt; it takes thousands.
  for (let i = 0; i < 100; i++) world.bears.damage(bear, 20, p);
  assert.ok(world.bears.list.includes(bear) && bear.health > config.bear.health * 0.6);
  const pickups = world.pickups.size;
  world.bears.damage(bear, config.bear.health, p);
  assert.equal(world.bears.list.length, 0, 'dead');
  assert.equal(world.pickups.size, pickups + 1, 'it drops cash');
  world.removePlayer(p.id);
  for (let t = 0; t < config.bear.respawnSec + 2; t += 1) world.bears.step(1);
  assert.equal(world.bears.list.length, 1, 'another one moves in');
});

// A town with two bunkers (trapdoors in their floors) along a road.
const { map } = validateMap({
  width: 12000,
  height: 12000,
  roads: [{ x: 0, y: 5900, w: 12000, h: 200 }],
  buildings: [{ type: 'bunker', x: 3000, y: 5000, rot: 0 }, { type: 'bunker', x: 9000, y: 5000, rot: 0 }],
});

test('down an opened trapdoor into the underground with what you carry, and back up the ladder', () => {
  const store = new AccountStore(':memory:');
  const { account } = store.createDeviceAccount();
  const rooms = new RoomManager({ store });
  rooms.map = map;
  rooms.warm();
  try {
    const sent = [];
    const client = { id: 1, account: store.live(account.id), send: (m) => sent.push(m), sendRaw: () => {}, chatLimiter: { tryConsume: () => true }, isOpen: true };
    rooms.join(client);
    const town = client.room;
    town.spawn(client, 'me', null);
    const p = client.player;
    p.cash = 300;
    p.inventory[1] = makeWeapon('rifle');
    p.inventory[2] = { good: 'vodka', qty: 4 };
    const bunker = town.world.buildings.find((b) => b.type === 'bunker');
    const t = town.world.trapdoorOf(bunker);
    Object.assign(p, { x: t.x + t.w / 2, y: t.y + t.h + 25 });

    // Still locked: nobody goes anywhere.
    town.trapdoorAction(client, { id: bunker.id, action: 'down' });
    assert.equal(client.room, town);
    assert.equal(sent.at(-1).code, 'trapdoor_locked');
    assert.equal(rooms.underground, null, "the underground isn't loaded till someone goes down");

    town.world.openTrapdoors.add(bunker.id);
    town.trapdoorAction(client, { id: bunker.id, action: 'down' });
    const under = client.room;
    assert.equal(under.kind, 'underground');
    assert.equal(rooms.underground, under);
    assert.ok(!town.world.players.has(p.id), 'gone from town');
    assert.ok(sent.some((m) => m.t === 'welcome' && m.underground?.grid), 'the client gets the underground');
    const q = client.player;
    assert.equal(q.cash, 300);
    assert.equal(q.inventory[1].type, 'rifle');
    assert.deepEqual(q.inventory[2], { good: 'vodka', qty: 4 });
    assert.ok(!under.world.isBlocked(q.x, q.y, q.radius), 'standing on open floor');
    const lake = under.world.underground.layout.lakes[0];
    if (lake) assert.ok(under.world.isSwimming(lake.x, lake.y) && !under.world.isBlocked(lake.x, lake.y, 20), 'you swim in the underground lake');
    const ladder = under.world.underground.ladderNear(q);
    assert.ok(ladder, 'at the foot of a ladder');
    assert.equal(store.account(account.id).cash, 300, 'what they carry is saved down there too');

    // Back up: beside a trapdoor in town (open now), still with it all.
    under.trapdoorAction(client, { id: 0, action: 'up' });
    assert.equal(client.room, town);
    const r = client.player;
    assert.equal(r.cash, 300);
    assert.equal(r.inventory[1].type, 'rifle');
    const near = town.world.buildings.filter((b) => b.type === 'bunker').map((b) => town.world.trapdoorOf(b)).find((d) => Math.hypot(d.x + d.w / 2 - r.x, d.y + d.h / 2 - r.y) < 120);
    assert.ok(near, 'beside a trapdoor');
    assert.ok(!town.world.isBlocked(r.x, r.y, r.radius));
    assert.ok(!under.world.players.size);
  } finally {
    rooms.stopAll();
  }
});

test('a saved crew survives a session that starts underground, and comes back out up the ladder', () => {
  const store = new AccountStore(':memory:');
  const { account } = store.createDeviceAccount();
  const crew = [{ role: 'goon', mode: 'follow', post: null, out: 1 }, { role: 'guard', mode: 'follow', post: null, out: 0 }];
  store.setCrew(account.id, crew);
  const rooms = new RoomManager({ store });
  rooms.map = map;
  rooms.warm();
  try {
    const client = () => ({ id: 1, account: store.live(account.id), send: () => {}, sendRaw: () => {}, chatLimiter: { tryConsume: () => true }, isOpen: true });
    // Straight into the underground (the admin's switch), then off again: the saved crew is left alone.
    let c = client();
    rooms.join(c);
    rooms.place(c, 'underground');
    c.room.spawn(c, 'me', null);
    rooms.leave(c);
    assert.deepEqual(store.account(account.id).crew, crew, 'still saved');
    // Again, but up the ladder into town this time: the crew's back (the goon who was out comes out).
    c = client();
    rooms.join(c);
    rooms.place(c, 'underground');
    const under = c.room;
    under.spawn(c, 'me', null);
    Object.assign(c.player, under.world.underground.arrival(under.world.underground.layout.ladders[0].x / config.underground.scale, under.world.underground.layout.ladders[0].y / config.underground.scale));
    under.trapdoorAction(c, { id: 0, action: 'up' });
    const town = c.room;
    assert.equal(town.kind, 'town');
    const acc = c.account;
    assert.deepEqual(town.world.hires.roster(acc).map((r) => [r[1], r[2]]).sort(), [['goon', 1], ['guard', 0]]);
    rooms.leave(c);
    assert.deepEqual(store.account(account.id).crew.map((s) => [s.role, s.out]).sort(), [['goon', 1], ['guard', 0]], 'saved again on logging off');
  } finally {
    rooms.stopAll();
  }
});

test("the admin's switch: over to the underground from the menu, and everyone else respawns in town", () => {
  const rooms = new RoomManager();
  rooms.map = map;
  rooms.warm();
  try {
    const client = { id: 2, account: { id: null, name: 'a', bank: 0, guest: true }, send: () => {}, sendRaw: () => {}, chatLimiter: { tryConsume: () => true }, isOpen: true };
    rooms.join(client);
    rooms.place(client, 'underground');
    assert.equal(client.room.kind, 'underground');
    client.room.spawn(client, 'a', null);
    assert.ok(!client.room.world.isBlocked(client.player.x, client.player.y, client.player.radius));
    assert.equal(rooms.travel(client, 'town'), true);
    assert.equal(client.room.kind, 'town');
  } finally {
    rooms.stopAll();
  }
});

test('gold sells at a town market (it starts with none, so it pays well)', () => {
  const world = new World();
  const depot = [...world.economy.markets.values()].find((m) => m.kind === 'depot');
  assert.equal(depot.goods.gold.stock, 0, 'none for sale till someone sells some');
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  Object.assign(p, { x: depot.x, y: depot.y, cash: 0 });
  world.economy.cargoOf(p).add('gold', 2);
  const price = world.economy.sellPrice(depot, 'gold');
  assert.ok(price > config.goods.gold.base, 'above its base price while the market has none');
  assert.equal(world.economy.trade(p, depot.id, 'gold', 2, 'sell'), null);
  assert.equal(p.cash, price * 2);
  assert.equal(world.economy.cargoOf(p).count('gold'), 0);
  assert.ok(price >= 290, 'about 300 ₽ where there is none');
  // The price holds a few seconds: sell more straight after and it's the same price.
  world.economy.cargoOf(p).add('gold', 3);
  assert.equal(world.economy.sellPrice(depot, 'gold'), price, 'not dropped yet');
  assert.equal(world.economy.trade(p, depot.id, 'gold', 3, 'sell'), null);
  assert.equal(p.cash, price * 5, 'all five at the same price');
  world.economy.step(config.goods.gold.settleSec + 0.1);
  assert.ok(Math.abs(depot.goods.gold.stock - 5) < 0.1, 'then it takes it all in');
  assert.ok(world.economy.sellPrice(depot, 'gold') < price, 'and the price drops');
});

test('dying underground: you come back in one of the bunkers, not just anywhere in the maze', () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const { bunkers } = world.underground.layout;
  for (let i = 0; i < 30; i++) {
    const p = world.spawnPlayer(`p${i}`, null, null);
    assert.ok(bunkers.some((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h), `in a bunker (${p.x}, ${p.y})`);
    assert.ok(!world.isBlocked(p.x, p.y, p.radius), 'and not in a wall');
  }
});

test('the homeless underground: 10 sitters and 10 wanderers with knives; a sitter you pass may creep after you and stab you in the back, a wanderer who sees you may come straight at you', () => {
  Object.assign(config.homeless, HOMELESS);
  try {
    const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
    const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
    const H = world.homeless;
    assert.equal(H.list.filter((h) => h.kind === 'sit').length, config.homeless.sitters);
    assert.equal(H.list.filter((h) => h.kind === 'roam').length, config.homeless.wanderers);
    assert.ok(H.list.every((h) => !world.isBlocked(h.x, h.y, config.homeless.radius)), 'none stuck in a wall');

    // A sitter: walk past him (he always follows, for the test) and keep going, facing away.
    const was = config.homeless.followChance;
    config.homeless.followChance = 1;
    try {
      const clearWay = (h) => [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dy]) => world.lineOfSight(h.x, h.y, h.x + dx * 520, h.y + dy * 520) && [100, 200, 300, 400, 520].every((k) => !world.isBlocked(h.x + dx * k, h.y + dy * k, 20)));
      const s = H.list.find((h) => h.kind === 'sit' && clearWay(h));
      assert.ok(s, 'a sitter with a clear way past him');
      const dir = clearWay(s);
      const p = world.spawnPlayer('p', null, null);
      for (let i = 0; i < 24; i++) {
        Object.assign(p, { x: s.home.x + dir[0] * (40 + i * 20), y: s.home.y + dir[1] * (40 + i * 20) });
        p.input.aim = Math.atan2(dir[1], dir[0]);
        world.step(0.05);
      }
      assert.notEqual(s.state, 'sit', 'he gets up after you');
      const hp = p.health;
      for (let i = 0; i < 80 && p.health === hp; i++) world.step(0.05);
      assert.ok(p.health < hp, 'and stabs you from behind');
    } finally { config.homeless.followChance = was; }

    // Stab one back: three knife stabs and he's a body with his knife on him.
    const r = H.list.find((h) => h.kind === 'roam');
    const q = world.spawnPlayer('q', null, null);
    const before = H.list.length;
    for (let i = 0; i < 3; i++) H.damage(r, config.homeless.health / 3 + 0.01, q);
    assert.equal(H.list.length, before - 1);
    assert.ok([...world.bodies.list.values()].some((b) => b.items.some((it) => it.type === 'knife')), 'his knife on his body');
  } finally { Object.assign(config.homeless, { sitters: 0, wanderers: 0 }); }
});

test('a wanderer who sees you comes at you (80% of the time), and keeps on until you get away', () => {
  Object.assign(config.homeless, HOMELESS);
  try {
    const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
    const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
    const was = config.homeless.attackChance;
    config.homeless.attackChance = 1;
    try {
      const r = world.homeless.list.find((h) => h.kind === 'roam');
      r.route = []; // (standing still)
      const p = world.spawnPlayer('p', null, null);
      Object.assign(p, { x: r.x + 50, y: r.y });
      const hp = p.health;
      for (let i = 0; i < 60; i++) world.step(0.05);
      assert.equal(r.state, 'fight');
      assert.ok(p.health < hp, 'stabbed');
    } finally { config.homeless.attackChance = was; }
  } finally { Object.assign(config.homeless, { sitters: 0, wanderers: 0 }); }
});

test('bottles of vodka lie about the underground, and turn up again somewhere else once picked up', () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const bottles = [...world.pickups.values()];
  assert.equal(bottles.length, config.underground.bottles);
  for (const b of bottles) assert.ok(!world.isBlocked(b.x, b.y, 10) && !world.isSwimming(b.x, b.y), 'on open, dry floor');
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  p.inventory = p.inventory.map((s, i) => (i ? null : s));
  Object.assign(p, { x: bottles[0].x, y: bottles[0].y });
  world.step(1 / 30);
  assert.equal(p.inventory.find((s) => s?.good === 'vodka')?.qty, 1, 'walked over it: a bottle in the hotbar');
  assert.equal(world.pickups.size, config.underground.bottles - 1);
  Object.assign(p, { x: -9999, y: -9999 }); // (out of the way: new ones turn up out of everyone's sight)
  world.underground.step(config.underground.bottleRespawnSec + 1);
  assert.equal(world.pickups.size, config.underground.bottles, 'another one somewhere');
});

test('the trader in a bunker swaps one bottle of vodka for 3 bread, a bat, a knife or a Molotov', () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const u = world.underground.layout, t = u.traders[0];
  assert.ok(u.traders.length >= u.bunkers.length / 2, 'one in most of the bunkers');
  for (const o of u.traders) assert.ok(u.bunkers.some((b) => o.x > b.x && o.x < b.x + b.w && o.y > b.y && o.y < b.y + b.h), 'in a bunker');
  assert.equal(u.decor.filter((d) => d.k === 'tent').length, u.traders.length, 'each with his tent');
  assert.equal(u.decor.filter((d) => d.k === 'lantern' && d.lit).length, u.traders.length + (u.miner ? 1 : 0), 'and a lantern going (and the old miner\'s)');
  for (const o of u.traders) assert.ok(!world.isBlocked(o.x + 50, o.y + 40, 10) || !world.isBlocked(o.x - 50, o.y + 40, 10) || !world.isBlocked(o.x, o.y + 60, 10), 'you can get to him');
  assert.deepEqual(generateUnderground({ width: 13500, height: 13500, seed: config.underground.seed }).traders, generateUnderground({ width: 13500, height: 13500, seed: config.underground.seed }).traders, 'always the same spots');
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  p.inventory = [makeWeapon('knife'), { good: 'vodka', qty: 4 }, null, null, null];
  Object.assign(p, { x: t.x + 300, y: t.y });
  assert.equal(world.underground.trade(p, 'bread'), 'too_far');
  Object.assign(p, { x: t.x + 50, y: t.y });
  assert.equal(world.underground.trade(p, 'vodka'), 'bad_item');
  assert.ok(config.underground.trades.includes('rod'), 'he has fishing rods too');
  assert.deepEqual(world.underground.trade(p, 'bread'), { item: 'bread' });
  assert.deepEqual(world.underground.trade(p, 'bread'), { item: 'bread' });
  assert.deepEqual(p.inventory[2], { food: 'bread', qty: 5 }, 'three loaves a bottle, stacked');
  assert.deepEqual(p.inventory[3], { food: 'bread', qty: 1 }, 'the rest in the next free slot');
  assert.deepEqual(world.underground.trade(p, 'bat'), { item: 'bat' });
  assert.equal(p.inventory[4].type, 'bat');
  assert.deepEqual(world.underground.trade(p, 'molotov'), { item: 'molotov' });
  assert.ok(!p.inventory.some((s) => s?.good === 'vodka'), 'four bottles spent');
  assert.equal(p.inventory[1].type, 'molotov', "in the last bottle's slot");
  assert.ok(p.inventory[1].illegal, 'contraband');
  assert.equal(world.underground.trade(p, 'knife'), 'no_vodka');
  p.inventory[4] = { good: 'vodka', qty: 1 };
  assert.deepEqual(world.underground.trade(p, 'molotov'), { item: 'molotov' });
  assert.equal(p.inventory[1].ammo, 2, 'Molotovs stack');
  p.inventory = [makeWeapon('knife'), makeWeapon('pistol'), makeWeapon('pistol'), makeWeapon('pistol'), { good: 'vodka', qty: 2 }];
  assert.equal(world.underground.trade(p, 'knife'), 'no_room', 'no room: and he gives the bottle back');
  assert.equal(p.inventory[4].qty, 2);
  p.inventory[4].qty = 1;
  assert.deepEqual(world.underground.trade(p, 'knife'), { item: 'knife' }, "the last bottle's slot takes what he gives you");
  assert.equal(p.inventory[4].type, 'knife');
});

test('a thrown Molotov flies, breaks into a pool of fire that burns whoever is in it, and goes out', () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const b = world.underground.layout.bunkers.toSorted((x, y) => y.w * y.h - x.w * x.h)[0];
  const thrower = world.spawnPlayer('a', null, { id: 1, name: 'a', bank: 0, guest: false });
  const victim = world.spawnPlayer('b', null, { id: 2, name: 'b', bank: 0, guest: false });
  for (const pl of [thrower, victim]) pl.inventory = pl.inventory.map((s, i) => (i ? null : s));
  thrower.inventory[1] = { type: 'molotov', ammo: 2, reloadTimer: 0 };
  thrower.selected = 1;
  // Somewhere clear: a straight run inside the bunker.
  let spot = null;
  for (let y = b.y + 60; y < b.y + b.h - 60 && !spot; y += 10) {
    for (let x = b.x + 60; x < b.x + b.w - 260 && !spot; x += 10) {
      let clear = true;
      for (let d = 0; d <= 200 && clear; d += 10) clear = !world.isBlocked(x + d, y, 30);
      if (clear) spot = { x, y };
    }
  }
  assert.ok(spot, 'a clear run in the bunker');
  Object.assign(thrower, { x: spot.x, y: spot.y });
  Object.assign(victim, { x: spot.x + 200, y: spot.y });
  const range = config.weapons.molotov.range;
  config.weapons.molotov.range = 200 - thrower.radius; // (lands right on him)
  try {
    thrower.applyInput({ seq: 1, angle: 0, aim: 0, throttle: 0, fire: true });
    world.step(1 / 30);
    thrower.applyInput({ seq: 2, angle: 0, aim: 0, throttle: 0, fire: false });
  } finally { config.weapons.molotov.range = range; }
  assert.equal(world.molotovs.length, 1, 'in the air');
  assert.equal(thrower.inventory[1].ammo, 1, 'one left');
  const hp = victim.health;
  for (let t = 0; t < 1; t += 1 / 30) world.step(1 / 30);
  assert.equal(world.molotovs.length, 0);
  assert.equal(world.fires.length, 1, 'burning');
  assert.ok(victim.health < hp, 'he burns');
  for (let t = 0; t < config.weapons.molotov.fire.sec + 1 && world.players.has(victim.id); t += 1 / 30) {
    victim.health = victim.maxHealth; // (keep him alive to see it out)
    world.step(1 / 30);
  }
  assert.equal(world.fires.length, 0, 'it burns out');
});

test('giant rats: one that sees you comes for you and bites, and dies to a few stabs (another turns up later)', () => {
  config.giantRats.count = RATS;
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const rats = world.giantRats;
  assert.equal(rats.list.length, config.giantRats.count);
  const r = rats.list[0];
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  // Beside it, where it can see you.
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const x = r.x + Math.cos(a) * 120, y = r.y + Math.sin(a) * 120;
    if (!world.isBlocked(x, y, p.radius) && world.lineOfSight(r.x, r.y, x, y)) { Object.assign(p, { x, y }); break; }
  }
  const hp = p.health;
  for (let t = 0; t < 2; t += 1 / 30) { p.health = Math.max(p.health, 1); world.step(1 / 30); }
  assert.equal(r.target, p, 'it comes for you');
  assert.ok(p.health < hp, 'and bites');
  p.health = p.maxHealth;
  p.inventory[0] = makeWeapon('knife');
  p.selected = 0;
  let killed = false;
  let stabs = 0;
  for (; stabs < 20 && !killed; stabs++) killed = rats.damage(r, (config.giantRats.health / 3) / 3 + 0.01, p);
  assert.ok(killed && !rats.list.includes(r), 'it dies in the end');
  assert.equal(stabs, 9, 'nine stabs (three times as tough)');
  Object.assign(p, { x: -9999, y: -9999 });
  rats.step(config.giantRats.respawnSec + 1);
  assert.equal(rats.list.length, config.giantRats.count, 'another one turns up');
});

test('shoot a crate of dynamite in the mine and it goes off: it hurts whoever is close, sets off crates nearby, and a new one is left later', () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  assert.ok(world.tnt.length > 0, 'some crates in the dead ends');
  assert.ok(!world.blocks.some((b) => world.tnt.some((c) => c.x === b.x && c.y === b.y)), "(not sent as plain blocks: the client's told when one's gone)");
  const c = world.tnt[0], cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  assert.ok(world.isBlocked(cx, cy, 5), 'solid');
  // Stand back from it where there's a clear shot, and shoot it.
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  let spot = null;
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    for (let d = 140; d >= 70 && !spot; d -= 10) {
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      if (!world.isBlocked(x, y, p.radius)) spot = { x, y, a: a + Math.PI };
    }
    if (spot) break;
  }
  assert.ok(spot);
  Object.assign(p, { x: spot.x, y: spot.y });
  p.inventory[1] = makeWeapon('pistol');
  p.selected = 1;
  p.applyInput({ seq: 1, angle: 0, aim: spot.a, throttle: 0, fire: true });
  const hp = p.health;
  let boom = false;
  for (let t = 0; t < 0.5 && !boom; t += 1 / 30) {
    const before = c.blown;
    world.step(1 / 30);
    boom = !before && c.blown;
  }
  assert.ok(c.blown, 'it went off');
  assert.ok(!world.isBlocked(cx, cy, 5), 'and the crate is gone');
  assert.ok(!world.players.has(p.id) || p.health < hp, 'standing that close hurts (or kills)');
  for (const o of world.players.values()) Object.assign(o, { x: -9999, y: -9999 });
  for (let t = 0; t < config.tnt.respawnSec + 1; t += 1) world.step(1);
  assert.ok(!c.blown, 'a new crate later');
});

test('the homeless are solid: walk into one and you shove him aside, not through him', () => {
  Object.assign(config.homeless, HOMELESS);
  try {
    const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
    const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
    const h = world.homeless.list.find((x) => x.kind === 'sit');
    const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
    world.homeless.list = [h];
    h.passing = { get: () => false, set() {}, delete() {} }; // (he stays put)
    Object.assign(p, { x: h.x - 5, y: h.y });
    world.step(1 / 30);
    assert.ok(Math.hypot(p.x - h.x, p.y - h.y) >= p.radius + config.homeless.radius - 1, 'not overlapping');
  } finally { Object.assign(config.homeless, { sitters: 0, wanderers: 0 }); }
});

test('the oil hall: two guards and the overseer shoot trespassers, workers pump, prisoners sit in locked cells', () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const oil = world.underground.layout.oil, hall = oil.hall;
  const watchers = world.hires.list.filter((h) => h.oil);
  assert.deepEqual(watchers.map((h) => h.role).sort(), ['govguard', 'govguard', 'inspector'], 'two guards and the overseer');
  const folk = world.oilHall.folk;
  assert.equal(folk.filter((f) => f.kind === 'worker').length, oil.pumps.length);
  assert.ok(oil.pumps.length >= 9, 'about ten at the pumps');
  assert.ok(folk.filter((f) => f.kind === 'prisoner').length >= oil.cells.length, 'someone in every cell');
  for (const c of oil.cells) {
    const d = world.underground.layout.doors[c.door];
    assert.ok(d.cell && d.locked && !d.open, 'cell doors shut and locked');
  }
  // Walk in: they open fire.
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  Object.assign(p, { x: oil.guard.x, y: oil.guard.y - (oil.guard.y > hall.y + hall.h / 2 ? 200 : -200) });
  for (let t = 0; t < 3 && !world.bullets.size; t += 1 / 30) { p.health = p.maxHealth; world.step(1 / 30); }
  assert.ok([...world.bullets.values()].some((b) => b.owner.oil), 'shot at');
});

test("only the overseer's key opens a cell (no picking); the prisoners run, one thanks you; the key's gone once you leave", () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const layout = world.underground.layout, oil = layout.oil;
  const guards = world.hires.list.filter((h) => h.oil && h.role === 'govguard'), overseer = world.hires.list.find((h) => h.oil && h.role === 'inspector');
  const p = world.spawnPlayer('p1', null, { id: 1, name: 'p1', bank: 0, guest: false });
  p.inventory = p.inventory.map((s, i) => (i ? null : s));
  // Kill them all: the overseer leaves his key; the workers run for it.
  for (const g of guards) world.hires.damage(g, 1e6, p);
  world.hires.damage(overseer, 1e6, p);
  const body = [...world.bodies.list.values()].find((b) => b.items.some((i) => i?.type === 'cellkey'));
  assert.ok(body, "the key's on the overseer's body");
  for (let t = 0; t < config.oilHall.fleeSec + 1; t += 1 / 30) world.step(1 / 30);
  assert.equal(world.oilHall.folk.filter((f) => f.kind === 'worker').length, 0, 'the workers are gone');

  const cell = oil.cells[0], door = layout.doors[cell.door];
  Object.assign(p, { x: cell.front.x, y: cell.front.y });
  assert.equal(world.lockedDoorNear(p), null, "the lock can't be picked");
  p.input.use = true;
  world.step(1 / 30);
  assert.equal(door.open, false, 'no key: it stays shut');
  p.inventory[1] = { type: 'cellkey', tool: true };
  const cash = p.cash, vodka = () => p.inventory.reduce((n, s) => n + (s?.good === 'vodka' ? s.qty : 0), 0) + p.inventory.reduce((n, s) => n + (s?.good === 'bread' ? s.qty : 0), 0);
  p.input.use = true;
  world.step(1 / 30);
  assert.equal(door.open, true, 'the key opens it');
  world.step(1 / 30);
  assert.ok(world.oilHall.folk.filter((f) => f.cell === 0).every((f) => f.state === 'free'), "they're out");
  assert.ok(p.cash > cash || vodka() > 0 || world.pickups.size > config.underground.bottles, 'and one thanked you');
  for (let t = 0; t < config.oilHall.fleeSec + 1; t += 1 / 30) world.step(1 / 30);
  assert.ok(!world.oilHall.folk.some((f) => f.cell === 0), 'gone');
  // Out of the hall: the key's no good, and gone.
  Object.assign(p, { x: oil.doorsOut[0].x, y: oil.doorsOut[0].y });
  for (let t = 0; t < 1; t += 1 / 30) world.step(1 / 30);
  assert.ok(!p.inventory.some((s) => s?.type === 'cellkey'), 'the key went');
});

test("the ladder in the oil hall's office comes out of a sewer vent in town", () => {
  const town = new World(config.world, config.player, config.weapons);
  assert.ok(town.vents.length > 0);
  const at = town.ventArrival();
  assert.ok(at && town.vents.some((v) => Math.hypot(v.x + v.w / 2 - at.x, v.y + v.h / 2 - at.y) < 120), 'beside a vent');
  const u = generateUnderground({ width: 13500, height: 13500, seed: config.underground.seed });
  const l = u.ladders.find((x) => x.vent);
  assert.ok(l && l.x > u.oil.office.x && l.x < u.oil.office.x + u.oil.office.w && l.y > u.oil.office.y && l.y < u.oil.office.y + u.oil.office.h, 'in the office');
  assert.ok(u.doors.some((d) => d.office && d.locked && !d.cell), 'behind a locked (pickable) door');
});

test("the trader's message gets through to the server (every trade, nothing else)", async () => {
  const { decodeClientMessage } = await import('../src/net/protocol.js');
  for (const item of config.underground.trades) assert.deepEqual(decodeClientMessage(JSON.stringify({ t: 'trader', item })), { ok: true, msg: { t: 'trader', item } });
  assert.equal(decodeClientMessage(JSON.stringify({ t: 'trader', item: 'sniper' })).ok, false);
});

test('a flash flood while it rains in town: warned, everyone clears out, waves from the sewers drown you outside the oil hall, then it drains', () => {
  Object.assign(config.homeless, HOMELESS);
  config.giantRats.count = RATS;
  try { floodTest(); } finally { Object.assign(config.homeless, { sitters: 0, wanderers: 0 }); config.giantRats.count = 0; }
});

function floodTest() {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const f = world.flood, u = world.underground.layout, c = config.flood;
  assert.ok(f.dist.some((d) => d === 0), 'the sewers are where it comes from');
  const hall = u.oil.hall;
  assert.equal(f.distAt(hall.x + hall.w / 2, hall.y + hall.h / 2), -1, 'the oil hall stays dry');
  const run = (sec) => { for (let t = 0; t < sec; t += 0.5) world.step(0.5); };
  run(1);
  assert.ok(world.homeless.list.length && world.giantRats.list.length, 'the homeless and the rats are about');
  // A player out in the tunnels, far from the sewers, and one in the oil hall.
  const far = f.dist.reduce((best, d, i) => (d > f.dist[best] ? i : best), 0);
  const out = world.spawnPlayer('out', null, { id: 1, name: 'out', bank: 0, guest: false });
  const safe = world.spawnPlayer('safe', null, { id: 2, name: 'safe', bank: 0, guest: false });
  const keep = () => {
    Object.assign(out, { x: ((far % u.cols) + 0.5) * u.cell, y: (Math.floor(far / u.cols) + 0.5) * u.cell, health: out.maxHealth });
    Object.assign(safe, { x: hall.x + hall.w / 2, y: hall.y + hall.h / 2, health: safe.maxHealth });
  };
  keep();
  f.raining = true;
  world.step(0.1);
  assert.ok(f.active);
  assert.ok(f.events.some((e) => e.kind === 'flood_warning'), 'warned');
  run(5);
  assert.ok(world.homeless.list.every((h) => [out, safe].some((p) => Math.hypot(p.x - h.x, p.y - h.y) < c.clear)), 'the homeless have cleared out');
  assert.ok(world.giantRats.list.every((r) => [out, safe].some((p) => Math.hypot(p.x - r.x, p.y - r.y) < c.clear)), 'and the rats');
  assert.equal(f.goneTraders.size + u.traders.filter((t) => [out, safe].some((p) => Math.hypot(p.x - t.x, p.y - t.y) < c.clear)).length, u.traders.length, 'the traders too');
  assert.equal(world.underground.trade(Object.assign(out, { x: u.traders[[...f.goneTraders][0]].x + 40, y: u.traders[[...f.goneTraders][0]].y }), 'bread'), 'too_far', 'no trading with a trader who has gone');
  keep();
  f.kills.length = 0;
  for (let t = 0; t < c.waveSec - c.deepSec - 15; t += 1) { world.step(1); keep(); }
  assert.ok(!f.deep, 'walkable at first');
  for (let t = c.waveSec - c.deepSec - 15; t < c.waveSec - 10; t += 1) { world.step(1); keep(); }
  assert.ok(f.deepAt(out.x, out.y), 'deep before the wave: swimming');
  assert.ok(!f.deepAt(safe.x, safe.y), 'not in the oil hall');
  assert.ok(f.level === 1, 'risen');
  assert.ok(world.players.has(out.id), 'still alive before the wave');
  assert.ok(f.events.some((e) => e.kind === 'flood_wave_soon'), 'a last warning');
  let t = 0;
  while (world.players.has(out.id) && t < 60) { world.step(0.5); Object.assign(safe, { x: hall.x + hall.w / 2, y: hall.y + hall.h / 2 }); t += 0.5; }
  assert.ok(!world.players.has(out.id), 'the wave got the one out in the tunnels');
  assert.ok(world.players.has(safe.id), 'not the one in the oil hall');
  assert.ok(t * c.waveSpeed > f.distAt(((far % u.cols) + 0.5) * u.cell, (Math.floor(far / u.cols) + 0.5) * u.cell) - c.waveSpeed, 'it took its time getting there');
  // Still raining: another wave a while later. Then the rain stops: it drains, and they come back.
  assert.ok(f.nextWave > c.waveSec - 60, 'the next one is on its way');
  f.raining = false;
  run(c.drainSec + 70);
  assert.ok(!f.active && f.level === 0, 'drained');
  assert.equal(f.goneTraders.size, 0, 'the traders are back');
  assert.ok(f.events.some((e) => e.kind === 'flood_over'));
  assert.ok(f.events.some((e) => e.kind === 'flood_survived' && e.player === safe), 'made it through the wave: the swimming goggles');
  assert.ok(!f.events.some((e) => e.kind === 'flood_survived' && e.player === out), 'not the one it drowned');
  run(config.homeless.respawnSec + 30);
  assert.ok(world.homeless.list.length > 2, 'the homeless come back in time');
}
