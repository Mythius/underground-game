import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
config.gangsters.count = 0;
const HOMELESS = { sitters: config.homeless.sitters, wanderers: config.homeless.wanderers };
Object.assign(config.homeless, { sitters: 0, wanderers: 0 }); // (no knives in the other tests; theirs put them back)
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
  assert.equal(a.ladders.length, 3, 'an entrance bunker (with a ladder) for each anchor');
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
  const doors = world.doors.filter((d) => d.underground);
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

test("nothing lies about on the floor: it's in the bunkers' cabinets, which anyone can open, and they fill again once emptied", () => {
  const town = { width: 27000, height: 27000, buildings: [], trapdoorOf: () => null };
  const world = new World(config.world, config.player, config.weapons, undergroundMap(town));
  const u = world.underground.layout;
  assert.equal(u.loot, undefined);
  assert.equal(world.pickups.size, 0, 'nothing on the ground');
  assert.ok(u.cabinets.length >= u.bunkers.length, 'a cabinet or two in every bunker room');
  for (const c of u.cabinets) assert.ok(u.bunkers.some((b) => c.x >= b.x && c.y >= b.y && c.x + c.w <= b.x + b.w && c.y + c.h <= b.y + b.h), 'in a bunker');
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
  assert.equal(depot.goods.gold.stock, 2);
  assert.equal(world.economy.cargoOf(p).count('gold'), 0);
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
