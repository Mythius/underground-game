import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { AccountStore } from '../src/accounts.js';
import { Room } from '../src/game/Room.js';
import { validateMap } from '../src/game/mapFile.js';

config.gangsters.count = 0;

const { map } = validateMap({
  width: 6000,
  height: 4000,
  roads: [{ x: 0, y: 1900, w: 6000, h: 200 }],
  buildings: [
    { type: 'house', x: 600, y: 600, rot: 0 },
    { type: 'house', x: 600, y: 2600, rot: 0 },
    { type: 'panelka', x: 2000, y: 600, rot: 0 },
    { type: 'smallwarehouse', x: 4000, y: 600, rot: 0 },
  ],
});

test('closing the game puts away your homes, factories and cars (dying doesn\'t); you bring them back yourself', () => {
  const store = new AccountStore(':memory:');
  const room = new Room(map, store);
  const world = () => room.world;
  let nextId = 1;
  const join = (acc) => {
    const client = { id: nextId++, account: store.live(acc.id), send: () => {}, sendRaw: () => {}, chatLimiter: { tryConsume: () => true } };
    client.account.bank = 1e6;
    room.clients.add(client);
    room.spawn(client, `p${acc.id}`, null);
    return client;
  };
  const owner = store.createDeviceAccount().account;
  const tenant = store.createDeviceAccount().account;
  const block = world().buildings.find((b) => b.type === 'panelka');
  const wh = [...world().warehouses.all.values()][0];
  const near = (p, b) => Object.assign(p, { x: b.x + b.w / 2, y: b.y + b.h + 40 });

  let me = join(owner);
  const home = world().homes.homeOf(me.account);
  assert.ok(home, 'a starter home');
  assert.equal(world().homes.action(near(me.player, block), { id: block.id, action: 'buy' }), null);
  assert.equal(world().warehouses.action(near(me.player, wh.building), { id: wh.id, action: 'buy' }), null);
  // A car of theirs out on the road, with someone else in it.
  const car = world().parkNewVehicle('sedan', home.id, me.account);
  car.carId = store.addCar(owner.id, { type: 'sedan', color: 'red', fuel: 50, cargo: [] });
  car.fuel = 33;
  const them = join(tenant);
  car.passenger = them.player;
  them.player.vehicle = car;
  // The tenant keeps something in their flat's cabinet.
  assert.equal(world().homes.action(near(them.player, block), { id: block.id, action: 'rent', room: 1 }), null);
  const cab = [...world().furnishings.items.values()].find((it) => it.building === block.id && it.slots && world().homes.roomAt(block, it.x + it.w / 2, it.y + it.h / 2) === 1);
  cab.slots[0] = { good: 'steel', qty: 2 };

  // Dying keeps everything where it is.
  me.player.health = 0;
  world().removePlayer(me.player.id);
  assert.equal(world().homes.homeOf(me.account), home);
  assert.equal(world().homes.boughtBy(me.account).length, 1);
  assert.equal(wh.owner, me.account);
  assert.ok(world().vehicles.has(car.id));

  // Closing the game: all of it comes off the map.
  room.removeClient(me);
  assert.equal(world().homes.homeOf(owner), null);
  assert.equal(world().homes.owners.has(home.id), false, 'the starter house is free');
  assert.equal(world().homes.boughtBy(owner).length, 0);
  assert.equal(wh.owner, null);
  assert.equal(world().vehicles.has(car.id), false);
  assert.equal(them.player.vehicle, null, 'the passenger is out');
  assert.equal(store.cars(owner.id)[0].fuel, 33, 'the car was saved first');
  assert.deepEqual(world().homes.storedFor(owner).own, ['panelka']);
  assert.deepEqual(world().warehouses.storedFor(owner), ['small']);
  assert.equal(store.loadProperties().filter((r) => r.accountId === owner.id && r.kind === 'own').length, 1, 'saved to the database');
  assert.equal(store.loadWarehouses().filter((r) => r.accountId === owner.id).length, 1);
  assert.ok(world().homes.rentals.has(`${block.id}:1`), 'the tenant keeps their flat');
  assert.deepEqual(cab.slots[0], { good: 'steel', qty: 2 }, 'and what\'s in it');
  assert.ok(world().furnishings.items.has(cab.id));

  // Back: the same starter house (still free), and the rest brought back by hand.
  me = join(owner);
  assert.equal(world().homes.homeOf(me.account), home);
  assert.equal(world().homes.action(near(me.player, block), { id: block.id, action: 'bring' }), null);
  assert.equal(world().warehouses.action(near(me.player, wh.building), { id: wh.id, action: 'bring' }), null);
  assert.equal(wh.owner, me.account);
  const cabs = [...world().furnishings.items.values()].filter((it) => it.building === block.id && it.slots && world().homes.roomAt(block, it.x + it.w / 2, it.y + it.h / 2) === 1);
  assert.equal(cabs.length, 1, 'the tenant\'s cabinet isn\'t doubled');
  assert.deepEqual(cabs[0].slots[0], { good: 'steel', qty: 2 });
  assert.equal(cabs[0].owner, me.account);
});
