import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { AccountStore } from '../src/accounts.js';
import { Room } from '../src/game/Room.js';
import { validateMap } from '../src/game/mapFile.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)
config.player.healthRegenPerSec = 0;

const MAP = {
  width: 4000,
  height: 3000,
  roads: [{ x: 0, y: 1400, w: 4000, h: 200 }],
  buildings: [
    { type: 'house', x: 500, y: 1000, rot: 0 },
    { type: 'house', x: 1500, y: 1000, rot: 1 },
  ],
};

/** A room with `n` players at their starter homes (each with a bed and a cabinet). */
function setup(n) {
  const store = new AccountStore(':memory:');
  const { map } = validateMap(MAP);
  const room = new Room(map, store);
  room.world.townsfolk.people.length = 0;
  const players = [];
  for (let i = 0; i < n; i++) {
    const { account } = store.createDeviceAccount();
    const client = { id: i + 1, account: store.live(account.id), send: () => {}, sendRaw: () => {}, chatLimiter: { tryConsume: () => true } };
    room.clients.add(client);
    room.spawn(client, `p${i}`, null);
    players.push(client.player);
  }
  return { room, world: room.world, players };
}
const night = (room) => {
  room.env.time = Math.floor(room.env.time / room.env.cycle) * room.env.cycle + config.environment.daySec + 20;
  room.step(1 / 30);
};
const run = (room, sec) => { for (let i = 0; i < sec * 30; i++) room.step(1 / 30); };
/** p's bed at home, with p standing beside it. */
function byBed(world, p) {
  const home = world.homes.homeOf(p.account);
  const bed = [...world.furnishings.items.values()].find((it) => it.building === home.id && it.kind === 'bed');
  Object.assign(p, { x: bed.x + bed.w / 2, y: bed.y + bed.h + 20 });
  if (world.isBlocked(p.x, p.y, p.radius)) Object.assign(p, { x: bed.x + bed.w + 20, y: bed.y + bed.h / 2 });
  return bed;
}

test('sleep in your own bed at night only; moving, E or getting hurt wakes you', () => {
  const { room, world, players: [p, q] } = setup(2);
  const bed = byBed(world, p);
  assert.equal(world.furnishings.sleep(p, bed.id), 'not_night');
  night(room);
  Object.assign(q, { x: p.x, y: p.y });
  assert.equal(world.furnishings.sleep(q, bed.id), 'not_your_bed');
  assert.equal(world.furnishings.sleep(p, bed.id), null);
  assert.ok(p.sleeping);
  assert.ok(p.x > bed.x && p.x < bed.x + bed.w && p.y > bed.y && p.y < bed.y + bed.h, 'lying in it');
  const at = { x: p.x, y: p.y };
  run(room, 0.5);
  assert.deepEqual({ x: p.x, y: p.y }, at, 'lying still');
  assert.equal(world.furnishings.pickUp(p, bed.id), 'someone_asleep');
  // Walking off gets you up.
  p.applyInput({ seq: 1, angle: 0, throttle: 1 });
  run(room, 0.2);
  assert.equal(p.sleeping, null);
  p.applyInput({ seq: 2, angle: 0, throttle: 0 });
  // So does E, and so does getting hurt.
  byBed(world, p);
  assert.equal(world.furnishings.sleep(p, bed.id), null);
  p.input.use = true;
  room.step(1 / 30);
  assert.equal(p.sleeping, null);
  byBed(world, p);
  assert.equal(world.furnishings.sleep(p, bed.id), null);
  p.hurt(1);
  assert.equal(p.sleeping, null);
});

test('everyone asleep (in bed, or in a dumpster): the night is skipped to the morning', () => {
  const { room, world, players: [p, q] } = setup(2);
  night(room);
  const bed = byBed(world, p);
  assert.equal(world.furnishings.sleep(p, bed.id), null);
  // One still up: no skipping.
  run(room, config.homes.sleepSkipSec + 1);
  assert.ok(room.env.isNight, 'still night');
  assert.ok(p.sleeping);
  // The other curls up in a dumpster.
  q.hidden = { dumpster: { x: q.x, y: q.y, w: 40, h: 30 } };
  const day = Math.floor(room.env.time / room.env.cycle);
  run(room, config.homes.sleepSkipSec + 0.5);
  assert.ok(!room.env.isNight, 'morning');
  assert.equal(Math.floor(room.env.time / room.env.cycle), day + 1, 'the next day');
  assert.ok(room.env.clock < 5, 'first thing');
  assert.equal(p.sleeping, null, 'up');
  assert.ok(q.hidden, 'still in the dumpster');
});
