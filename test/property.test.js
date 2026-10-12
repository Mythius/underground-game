import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)
config.player.healthRegenPerSec = 0;

// A house, a cabin, a panelka and a row of garages.
function town() {
  const { map } = validateMap({
    width: 6000,
    height: 4000,
    buildings: [
      { type: 'house', x: 600, y: 600, rot: 0 },
      { type: 'cabin', x: 1200, y: 600, rot: 1 },
      { type: 'panelka', x: 2000, y: 600, rot: 0 },
      { type: 'garages', x: 3200, y: 600, rot: 0 },
      { type: 'house', x: 600, y: 1600, rot: 2 },
      { type: 'garage', x: 2000, y: 1600, rot: 1 },
    ],
  });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  world.police.witnessed = () => false;
  return world;
}
const of = (world, type, n = 0) => world.buildings.filter((b) => b.type === type)[n];
const account = (id, bank = 1e6) => ({ id, name: `p${id}`, bank, guest: false });
function player(world, acc, b) {
  const p = world.spawnPlayer(acc.name, null, acc);
  p.account = acc;
  Object.assign(p, { x: b.x + b.w / 2, y: b.y + b.h + 40 }); // outside its front
  return p;
}
const itemsIn = (world, b) => [...world.furnishings.items.values()].filter((it) => it.building === b.id);
/** A new day dawns. */
function dawn(world) {
  world.dayNumber = (world.dayNumber ?? 0) + 1;
  world.homes.step(0);
}

test('homes nobody owns come furnished, with a fireplace; a starter home gets just a bed and a cabinet', () => {
  const world = town();
  const house = of(world, 'house');
  assert.ok(house.walls.some((w) => w.fireplace), 'a fireplace');
  assert.deepEqual(itemsIn(world, house).map((it) => it.kind).sort(), ['bed', 'cabinet', 'chair', 'table']);
  assert.ok(itemsIn(world, house).every((it) => it.owner === null));
  assert.equal(itemsIn(world, of(world, 'panelka')).filter((it) => it.kind === 'cabinet').length, 3, 'a cabinet in each flat');
  assert.equal(itemsIn(world, of(world, 'garages')).filter((it) => it.kind === 'cabinet').length, 5, 'one in each box');
  const acc = account(1);
  const home = world.homes.assign(acc);
  world.furnishings.restoreHome(acc, null); // (never furnished)
  assert.deepEqual(itemsIn(world, home).map((it) => it.kind).sort(), ['bed', 'cabinet']);
  assert.ok(itemsIn(world, home).every((it) => it.owner === acc));
});

test('buy a home: it comes furnished and you can move the furniture; one of each type; someone\'s starter home is not for sale', () => {
  const world = town();
  const starter = account(9);
  const taken = world.homes.assign(starter, 'house-1');
  const acc = account(1);
  const house = [...world.buildings].find((b) => b.type === 'house' && b !== taken);
  const p = player(world, acc, house);
  assert.equal(world.homes.action(p, { id: taken.id, action: 'buy' }), 'too_far');
  Object.assign(p, { x: taken.x + taken.w / 2, y: taken.y + taken.h + 40 });
  assert.equal(world.homes.action(p, { id: taken.id, action: 'buy' }), 'someones_home');
  Object.assign(p, { x: house.x + house.w / 2, y: house.y + house.h + 40 });
  assert.equal(world.homes.action(p, { id: house.id, action: 'buy' }), null);
  assert.equal(acc.bank, 1e6 - config.homes.prices.house);
  assert.ok(itemsIn(world, house).every((it) => it.owner === acc), 'its furniture is yours');
  assert.equal(world.homes.action(player(world, account(2), house), { id: house.id, action: 'buy' }), 'already_owned');
  // Its door opens for you, and stays locked to others.
  const door = house.doors.find((d) => d.exterior);
  assert.equal(world.lockedFor(door, p), false);
  assert.equal(world.lockedFor(door, player(world, account(3), house)), true);
  // Move the table: pick it up, set it down somewhere else.
  const table = itemsIn(world, house).find((it) => it.kind === 'table');
  Object.assign(p, { x: table.x + table.w / 2, y: table.y - 30 });
  assert.equal(world.furnishings.pickUp(p, table.id), null);
  assert.equal(hotbarOf(p).count('table'), 1);
  p.selected = p.inventory.findIndex((s) => s?.good === 'table');
  let placed = false;
  for (let y = house.y + 40; y < house.y + house.h - 40 && !placed; y += 10) {
    for (let x = house.x + 40; x < house.x + house.w - 40 && !placed; x += 10) {
      if (world.isBlocked(x, y, p.radius)) continue;
      Object.assign(p, { x, y });
      placed = [0, 1, 2, 3].some((k) => world.furnishings.place(p, (k * Math.PI) / 2) === null);
    }
  }
  assert.ok(placed, 'set down again');
  // One of each type.
  Object.assign(p, { x: house.x + house.w / 2, y: house.y + house.h + 40 });
  const cabin = of(world, 'cabin');
  Object.assign(p, { x: cabin.x + cabin.w / 2, y: cabin.y + cabin.h / 2 });
  assert.equal(world.homes.action(p, { id: cabin.id, action: 'buy' }), null, 'a cabin as well is fine');
  const other = [...world.buildings].find((b) => b.type === 'house' && b !== house && b !== taken);
  if (other) {
    Object.assign(p, { x: other.x + other.w / 2, y: other.y + other.h / 2 });
    assert.equal(world.homes.action(p, { id: other.id, action: 'buy' }), 'one_per_type');
  }
});

test('sell a home: half back, the furniture stays; cabinets have to be emptied first', () => {
  const world = town();
  const acc = account(1);
  const cabin = of(world, 'cabin');
  const p = player(world, acc, cabin);
  Object.assign(p, { x: cabin.x + cabin.w / 2, y: cabin.y + cabin.h / 2 });
  assert.equal(world.homes.action(p, { id: cabin.id, action: 'buy' }), null);
  const cab = itemsIn(world, cabin).find((it) => it.slots);
  cab.slots[0] = { good: 'logs', qty: 2 };
  assert.equal(world.homes.action(p, { id: cabin.id, action: 'sell' }), 'empty_cabinets_first');
  cab.slots[0] = null;
  assert.equal(world.homes.action(p, { id: cabin.id, action: 'sell' }), null);
  assert.equal(acc.bank, 1e6 - config.homes.prices.cabin + config.homes.prices.cabin * config.homes.sellBack);
  assert.ok(itemsIn(world, cabin).length && itemsIn(world, cabin).every((it) => it.owner === null));
});

test('rent a flat: locked storage for you alone; rent at dawn goes to the owner, who also gets the NPCs\' rent', () => {
  const world = town();
  const landlord = account(1);
  const tenant = account(2);
  const block = of(world, 'panelka');
  const lp = player(world, landlord, block);
  assert.equal(world.homes.action(lp, { id: block.id, action: 'buy' }), null);
  assert.equal(world.homes.action(lp, { id: block.id, action: 'rent', room: 0 }), 'its_yours');
  const tp = player(world, tenant, block);
  assert.equal(world.homes.action(tp, { id: block.id, action: 'rent', room: 1 }), null);
  assert.equal(tenant.bank, 1e6 - config.homes.rent.panelka, 'the first day up front');
  assert.equal(world.homes.action(tp, { id: block.id, action: 'rent', room: 2 }), 'one_per_type');
  assert.equal(world.homes.action(player(world, account(3), block), { id: block.id, action: 'rent', room: 1 }), 'room_taken');
  // The flat's door: the tenant's (not even the landlord's); the other flats: the landlord's.
  const doorOf = (room) => block.doors.find((d) => d.exterior && world.homes.roomAt(block, d.x + d.w / 2, d.y + d.h / 2, 30) === room);
  assert.equal(world.lockedFor(doorOf(1), tp), false);
  assert.equal(world.lockedFor(doorOf(1), lp), true);
  assert.equal(world.lockedFor(doorOf(0), lp), false);
  assert.equal(world.lockedFor(doorOf(0), tp), true);
  // Its cabinet: the tenant's to use, and the landlord can't take it away.
  const cab = itemsIn(world, block).find((it) => it.slots && world.homes.roomAt(block, it.x + it.w / 2, it.y + it.h / 2) === 1);
  Object.assign(tp, { x: cab.x + cab.w / 2, y: cab.y + cab.h + 30 });
  Object.assign(lp, { x: tp.x, y: tp.y });
  hotbarOf(tp).add('steel', 2);
  assert.equal(world.furnishings.put(tp, cab.id, tp.inventory.findIndex((s) => s?.good === 'steel')), null);
  assert.equal(world.furnishings.take(lp, cab.id, 0), 'locked');
  assert.equal(world.furnishings.pickUp(lp, cab.id), 'rented_out');
  // Dawn: the tenant pays the landlord; the two flats nobody rents bring in the NPCs' share.
  const before = landlord.bank;
  dawn(world); // (the first dawn just starts the clock)
  dawn(world);
  assert.equal(tenant.bank, 1e6 - 2 * config.homes.rent.panelka);
  assert.equal(landlord.bank - before, config.homes.rent.panelka + Math.round((config.homes.npcRent * 2) / 3));
});

test('can\'t pay the rent: out you go, and what you stored waits for your next flat', () => {
  const world = town();
  const tenant = account(2, config.homes.rent.panelka); // just the first day
  const block = of(world, 'panelka');
  const tp = player(world, tenant, block);
  assert.equal(world.homes.action(tp, { id: block.id, action: 'rent', room: 0 }), null);
  const cab = itemsIn(world, block).find((it) => it.slots && world.homes.roomAt(block, it.x + it.w / 2, it.y + it.h / 2) === 0);
  cab.slots[0] = { good: 'steel', qty: 2 };
  dawn(world);
  dawn(world);
  assert.equal(world.homes.rentals.size, 0, 'evicted');
  assert.deepEqual(cab.slots.filter(Boolean), [], 'the cabinet is cleared');
  assert.deepEqual(world.homes.storedFor(tenant).rent, ['panelka']);
  tenant.bank = 1000;
  assert.equal(world.homes.action(tp, { id: block.id, action: 'rent', room: 2 }), null);
  const cab2 = itemsIn(world, block).find((it) => it.slots && world.homes.roomAt(block, it.x + it.w / 2, it.y + it.h / 2) === 2);
  assert.deepEqual(cab2.slots.filter(Boolean), [{ good: 'steel', qty: 2 }], 'back in the new flat');
});

test('after a restart: load your saved home (its furniture) into a free one of the same type', () => {
  const world = town();
  const acc = account(1);
  const house = of(world, 'house', 1);
  const p = player(world, acc, house);
  assert.equal(world.homes.action(p, { id: house.id, action: 'buy' }), null);
  const cab = itemsIn(world, house).find((it) => it.slots);
  cab.slots[3] = { good: 'glass', qty: 4 };
  const saved = JSON.parse(JSON.stringify(world.homes.toSave()));
  // A new map: the saved home waits.
  const next = town();
  next.homes.stored = saved;
  const again = of(next, 'house', 0);
  const q = player(next, acc, again);
  assert.deepEqual(next.homes.storedFor(acc).own, ['house']);
  assert.equal(next.homes.action(q, { id: again.id, action: 'buy' }), 'load_saved_instead');
  const bank = acc.bank;
  assert.equal(next.homes.action(q, { id: again.id, action: 'bring' }), null);
  assert.equal(acc.bank, bank, 'free');
  const back = itemsIn(next, again);
  assert.equal(back.length, itemsIn(world, house).length);
  assert.deepEqual(back.find((it) => it.slots).slots[3], { good: 'glass', qty: 4 });
  assert.ok(back.every((it) => it.owner === acc));
  assert.deepEqual(next.homes.storedFor(acc).own, []);
});

test('garage boxes are locked: a rented one opens for its tenant, the rest for the owner (nobody, if unowned)', () => {
  const world = town();
  const row = of(world, 'garages');
  const tenant = account(2);
  const tp = player(world, tenant, row);
  const stranger = player(world, account(3), row);
  const doorOf = (room) => row.doors.find((d) => d.exterior && world.homes.roomAt(row, d.x + d.w / 2, d.y + d.h / 2, 30) === room);
  assert.equal(world.lockedFor(doorOf(3), stranger), true, 'locked, even with nobody renting it');
  assert.equal(world.lockedFor(doorOf(3), tp), true);
  assert.equal(world.homes.action(tp, { id: row.id, action: 'rent', room: 3 }), null);
  assert.equal(tenant.bank, 1e6 - config.homes.rent.garages);
  assert.equal(world.lockedFor(doorOf(3), stranger), true);
  assert.equal(world.lockedFor(doorOf(3), tp), false);
  assert.equal(world.lockedFor(doorOf(2), tp), true, 'not the other boxes');
  assert.equal(world.homes.action(tp, { id: row.id, action: 'leave', room: 3 }), null);
  assert.equal(world.lockedFor(doorOf(3), tp), true, 'gave it up: locked to them again');
  // The owner of the row has the keys to every box nobody rents.
  const owner = player(world, account(4), row);
  assert.equal(world.homes.action(owner, { id: row.id, action: 'buy' }), null);
  assert.equal(world.lockedFor(doorOf(3), owner), false);
  assert.equal(world.lockedFor(doorOf(3), stranger), true);
  // A picked lock: open to anyone for a while (that box only).
  world.homes.unlock(doorOf(1));
  assert.equal(world.lockedFor(doorOf(1), stranger), false);
  assert.equal(world.lockedFor(doorOf(2), stranger), true, 'the box next door is still locked');
});

test('a single garage: locked, two cabinets; buy it and bring your cars out at the spot inside', () => {
  const world = town();
  const g = of(world, 'garage');
  const cabs = itemsIn(world, g).filter((it) => it.kind === 'cabinet');
  assert.equal(cabs.length, 2, 'two cabinets');
  assert.ok(cabs.every((it) => world.furnishings.fits(g, it, it)), 'clear of the walls and the door');
  const acc = account(1);
  const p = player(world, acc, g);
  const door = g.doors.find((d) => d.exterior);
  assert.equal(world.lockedFor(door, p), true, 'locked before you buy it');
  assert.equal(world.homes.action(p, { id: g.id, action: 'buy' }), null);
  assert.equal(acc.bank, 1e6 - config.homes.prices.garage);
  assert.equal(world.lockedFor(door, p), false, 'yours');
  assert.equal(world.lockedFor(door, player(world, account(2), g)), true);
  // At the spot inside: one of your saved cars comes out, parked there.
  const saved = { id: 77, type: 'sedan', color: '#2f5b8a', fuel: 60, cargo: [] };
  Object.assign(p, { x: g.x + g.w + 600, y: g.y });
  assert.equal(world.bringCar(p, saved), 'too_far');
  Object.assign(p, { x: g.carSpot.x + 70, y: g.carSpot.y });
  if (world.isBlocked(p.x, p.y, p.radius)) Object.assign(p, { x: g.carSpot.x - 70, y: g.carSpot.y });
  assert.ok(world.homes.atGarage(p), 'at the garage');
  assert.equal(world.bringCar(p, saved), null);
  const car = [...world.vehicles.values()].find((v) => v.carId === 77);
  assert.ok(car, 'out');
  assert.ok(Math.hypot(car.x - g.carSpot.x, car.y - g.carSpot.y) < 1, 'parked on the spot');
  assert.ok(car.x > g.x && car.x < g.x + g.w && car.y > g.y && car.y < g.y + g.h, 'inside the garage');
  assert.equal(car.fuel, 60);
  // One garage each.
  const other = world.buildings.filter((x) => x.type === 'garage')[1];
  if (other) assert.equal(world.homes.action(player(world, acc, other), { id: other.id, action: 'buy' }), 'one_per_type');
});
