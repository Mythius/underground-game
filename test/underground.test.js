import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
config.gangsters.count = 0;
import { AccountStore } from '../src/accounts.js';
import { RoomManager } from '../src/game/RoomManager.js';
import { validateMap } from '../src/game/mapFile.js';
import { makeWeapon } from '../src/game/entities.js';
import { CELL, UG, generateUnderground, rockRects } from '../src/game/underground.js';

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
