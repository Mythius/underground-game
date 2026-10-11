import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { AccountStore } from '../src/accounts.js';
import { World } from '../src/game/World.js';
import { Room } from '../src/game/Room.js';
import { validateMap } from '../src/game/mapFile.js';

// Two starter houses and a cabin by a road.
const MAP = {
  width: 4000,
  height: 3000,
  roads: [{ x: 0, y: 1400, w: 4000, h: 200 }],
  buildings: [
    { type: 'house', x: 500, y: 1000, rot: 0 },
    { type: 'house', x: 1500, y: 1000, rot: 0 },
    { type: 'cabin', x: 2500, y: 1000, rot: 0 },
  ],
};

function town() {
  const { map } = validateMap(MAP);
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  world.police.witnessed = () => false;
  world.police.policeSee = () => false;
  return world;
}

// Just outside a door.
const outside = (p, d) => Object.assign(p, { x: d.x + d.w / 2 + d.nx * (p.radius + 25), y: d.y + d.h / 2 + d.ny * (p.radius + 25) });

const hold = (p, sec, world) => {
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, rob: true });
  for (let i = 0; i < Math.ceil(sec * 30) + 5; i++) world.step(1 / 30);
  p.applyInput({ seq: 2, angle: 0, throttle: 0, boost: false, rob: false });
};

test('everyone gets a starter house, spawns inside it, and only they can open its doors', () => {
  const world = town();
  const me = { id: 1, name: 'me', bank: 0, guest: false };
  const home = world.homes.assign(me);
  assert.ok(config.homes.starterTypes.includes(home.type));
  assert.equal(world.homes.assign(me), home, 'one each');
  assert.equal(world.homes.assign({ id: null, name: 'guest', guest: true }), null, 'guests get none');

  const p = world.spawnPlayer('me', null, me);
  p.account = me;
  assert.ok(p.x > home.x && p.x < home.x + home.w && p.y > home.y && p.y < home.y + home.h, 'spawned at home');

  const door = world.doors.find((d) => d.building === home.id && d.exterior);
  const thief = world.spawnPlayer('thief');
  thief.account = { id: 2, name: 'thief', bank: 0, guest: false };
  outside(thief, door);
  thief.input.use = true;
  world.step(1 / 30);
  assert.equal(door.open, false, 'locked to others');

  // Hold F to pick it: a break-in, and the door's open.
  world.police.witnessed = () => true;
  hold(thief, config.homes.lockpickSec, world);
  assert.equal(door.open, true, 'picked');
  assert.ok(thief.wanted >= config.crime.stars.break_in);

  // The owner just walks in.
  door.open = false;
  const other = world.doors.find((d) => d.building === home.id && d.exterior);
  outside(p, other);
  world.homes.unlockedUntil.clear();
  p.input.use = true;
  world.step(1 / 30);
  assert.equal(other.open, true, 'owner opens it');
});

test('someone else\'s car is locked until you pick it; the owner coming back locks it again', () => {
  const world = town();
  const owner = { id: 1, name: 'owner', bank: 0, guest: false };
  const car = world.parkNewVehicle('sedan', world.buildings[0].id, owner);
  const thief = world.spawnPlayer('thief');
  thief.account = { id: 2, name: 'thief', bank: 0, guest: false };
  Object.assign(thief, { x: car.x, y: car.y + car.stats.width / 2 + thief.radius + 10 });

  thief.input.use = true;
  world.step(1 / 30);
  assert.equal(thief.vehicle, null, "can't get in");

  hold(thief, config.vehicles.lockpickSec, world);
  assert.equal(car.picked, true);
  thief.input.use = true;
  world.step(1 / 30);
  assert.equal(thief.vehicle, car, 'in it now');

  // The owner gets it back and it's locked to the thief again.
  world.leaveSeat(thief);
  const p = world.spawnPlayer('owner');
  p.account = owner;
  Object.assign(p, { x: car.x, y: car.y + car.stats.width / 2 + p.radius + 10 });
  p.input.use = true;
  world.step(1 / 30);
  assert.equal(p.vehicle, car);
  assert.equal(world.carLockedFor(car, thief), true);
});

test('bought cars are saved and come out of the garage at home, even after a restart', () => {
  const store = new AccountStore(':memory:');
  const { account } = store.createDeviceAccount();
  const { map } = validateMap(MAP);
  const sent = [];
  const join = (room) => {
    const client = { id: 1, account: store.live(account.id), send: (m) => sent.push(m), chatLimiter: { tryConsume: () => true } };
    room.clients.add(client);
    room.spawn(client, 'me', null);
    return client;
  };

  const room = new Room(map, store);
  const client = join(room);
  const home = room.world.homes.homeOf(client.account);
  assert.ok(home);
  // Buying at a dealership saves the car.
  const car = room.world.parkNewVehicle('pickup', home.id, client.account);
  room.world.onCarBought(car);
  car.cargo[0] = { good: 'planks', qty: 5 };
  car.fuel = 42;
  room.stop();
  assert.equal(store.cars(account.id).length, 1);

  // After a restart: same house, and the car comes out of the garage.
  const again = new Room(map, store);
  const c2 = join(again);
  assert.equal(again.world.homes.homeOf(c2.account).id, home.id, 'same house');
  sent.length = 0;
  const me = [...again.world.players.values()].find((x) => x.account === c2.account);
  const pad = again.world.homes.padOf(home);
  // Inside, at the far side from the car pad (the pad's placed at random: it can be near the door).
  const corners = [[home.x + 40, home.y + 40], [home.x + home.w - 40, home.y + 40], [home.x + 40, home.y + home.h - 40], [home.x + home.w - 40, home.y + home.h - 40]];
  const [fx, fy] = corners.sort((a, b) => Math.hypot(b[0] - pad.x, b[1] - pad.y) - Math.hypot(a[0] - pad.x, a[1] - pad.y))[0];
  Object.assign(me, { x: fx, y: fy });
  again.garage(c2, { action: 'take', id: store.cars(account.id)[0].id });
  assert.equal([...again.world.vehicles.values()].filter((v) => v.carId).length, 0, 'not from inside the house');
  Object.assign(me, { x: pad.x + pad.w / 2, y: pad.y + pad.h / 2 });
  sent.length = 0;
  again.garage(c2, { action: 'list' });
  const list = sent.find((m) => m.t === 'garage').cars;
  assert.equal(list.length, 1);
  again.garage(c2, { action: 'take', id: list[0][0] });
  const out = [...again.world.vehicles.values()].find((v) => v.carId === list[0][0]);
  assert.ok(out, 'parked outside');
  assert.ok(out.x > pad.x && out.x < pad.x + pad.w && out.y > pad.y && out.y < pad.y + pad.h, 'on the car pad');
  assert.equal(out.owner, c2.account);
  assert.equal(Math.round(out.fuel), 42);
  assert.deepEqual(out.cargo[0], { good: 'planks', qty: 5 });

  // Taking it out again brings that same car back, not a second one.
  out.x += 500;
  again.garage(c2, { action: 'take', id: list[0][0] });
  assert.equal([...again.world.vehicles.values()].filter((v) => v.carId === list[0][0]).length, 1);
  again.stop();
});

test('Militsiya cars are locked too: pick one and it counts as stealing a police car', () => {
  const world = town();
  const car = world.parkNewVehicle('police', world.buildings[0].id, null);
  car.police = true;
  const p = world.spawnPlayer('thief');
  p.account = { id: 2, name: 'thief', bank: 0, guest: false };
  Object.assign(p, { x: car.x, y: car.y + car.stats.width / 2 + p.radius + 10 });
  p.input.use = true;
  world.step(1 / 30);
  assert.equal(p.vehicle, null, 'locked');
  world.police.witnessed = () => true;
  hold(p, config.vehicles.lockpickSec, world);
  assert.equal(car.picked, true);
  assert.equal(p.wanted, config.crime.stars.steal_police_car);
  p.input.use = true;
  world.step(1 / 30);
  assert.equal(p.vehicle, car);
});

test('every starter house gets a car pad outside, clear of walls, and the garage is there', () => {
  const world = town();
  const homes = world.buildings.filter((b) => config.homes.starterTypes.includes(b.type));
  assert.equal(world.pads.length, homes.length);
  for (const b of homes) {
    const pad = world.homes.padOf(b);
    assert.ok(pad, `${b.type} ${b.id} has a pad`);
    const overlaps = pad.x < b.x + b.w && b.x < pad.x + pad.w && pad.y < b.y + b.h && b.y < pad.y + pad.h;
    assert.ok(!overlaps, 'outside the house');
    const g = world.homes.garagePoint(b);
    assert.ok(!world.isBlocked(g.x, g.y, 30), 'nothing in the way');
  }
  const me = { id: 1, name: 'me', bank: 0, guest: false };
  const home = world.homes.assign(me);
  const p = world.spawnPlayer('me', null, me);
  p.account = me;
  const pad = world.homes.padOf(home);
  const corners = [[home.x + 40, home.y + 40], [home.x + home.w - 40, home.y + 40], [home.x + 40, home.y + home.h - 40], [home.x + home.w - 40, home.y + home.h - 40]];
  const [fx, fy] = corners.sort((a, b) => Math.hypot(b[0] - pad.x, b[1] - pad.y) - Math.hypot(a[0] - pad.x, a[1] - pad.y))[0];
  Object.assign(p, { x: fx, y: fy }); // inside, at the far side from the pad (placed at random: it can be near)
  assert.equal(world.homes.atGarage(p), false, 'not from inside');
  Object.assign(p, world.homes.garagePoint(home));
  assert.equal(world.homes.atGarage(p), true);
});
