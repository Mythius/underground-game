import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World, trunkSlot } from '../src/game/World.js';
import { Vehicle } from '../src/game/vehicles.js';
import { validateMap } from '../src/game/mapFile.js';
import { Slots, hotbarOf, trunkOf } from '../src/game/cargo.js';

// What a player carries on foot ({ good: qty }), and putting goods in their hotbar.
const carried = (p) => hotbarOf(p).items;
const carry = (p, goods) => {
  p.inventory = p.inventory.map((s) => (s?.good ? null : s));
  for (const [g, q] of Object.entries(goods)) hotbarOf(p).add(g, q);
};
const perSlot = (g) => Math.floor(config.cargo.slotWeight / config.goods[g].weight);

// A small hand-made town: a logging camp, a sawmill, a market and a gas station.
function town() {
  const { map } = validateMap({
    width: 4000,
    height: 4000,
    buildings: [
      { type: 'logging', x: 200, y: 200, rot: 0 },
      { type: 'sawmill', x: 1000, y: 200, rot: 0 },
      { type: 'market', x: 2000, y: 200, rot: 0 },
      { type: 'gas', x: 3000, y: 200, rot: 0 },
    ],
  });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  const eco = world.economy;
  const byType = (t) => world.buildings.find((b) => b.type === t);
  const player = world.spawnPlayer('trader');
  player.account = { id: 1, name: 'trader', bank: 5000, guest: false };
  const standAt = (b) => { player.x = b.npc.x; player.y = b.npc.y + 40; };
  return { world, eco, player, byType, standAt };
}

test('buildings with jobs become markets and factories', () => {
  const { eco, byType } = town();
  assert.equal(eco.markets.get(byType('logging').id).kind, 'raw');
  assert.equal(eco.markets.get(byType('market').id).kind, 'depot');
  assert.equal(eco.markets.get(byType('gas').id).kind, 'gas');
  assert.ok(eco.factories.has(byType('sawmill').id));
});

test('prices rise as a market runs low and fall when it is flooded', () => {
  const { eco, byType } = town();
  const depot = eco.markets.get(byType('market').id);
  const normal = eco.price(depot, 'planks');
  depot.goods.planks.stock = 0;
  const scarce = eco.price(depot, 'planks');
  depot.goods.planks.stock = depot.goods.planks.target * 3;
  const flooded = eco.price(depot, 'planks');
  assert.ok(scarce > normal && normal > flooded, `${scarce} > ${normal} > ${flooded}`);
  assert.ok(eco.buyPrice(depot, 'planks') > eco.sellPrice(depot, 'planks'), 'you buy dearer than you sell');
});

test('on foot, bought goods fill the free hotbar slots (the starting knife keeps its slot)', () => {
  const { eco, player, byType, standAt } = town();
  const camp = byType('logging');
  standAt(camp);
  player.cash = 1000;
  const fit = perSlot('logs') * (config.player.inventorySize - 1);
  assert.equal(eco.trade(player, camp.id, 'logs', fit + 1, 'buy'), 'no_room');
  assert.equal(eco.trade(player, camp.id, 'logs', fit, 'buy'), null);
  assert.equal(carried(player).logs, fit);
  assert.equal(player.inventory[0].type, 'knife');
  assert.ok(player.inventory.slice(1).every((s) => s.good === 'logs' && s.qty === perSlot('logs')));
  assert.ok(player.cash < 1000);
  assert.equal(eco.trade(player, camp.id, 'logs', 1, 'sell'), 'not_bought_here');
});

test('a nearby car you drove carries your cargo', () => {
  const { world, eco, player, byType, standAt } = town();
  const camp = byType('logging');
  standAt(camp);
  const car = new Vehicle(9000, 'truck', player.x + 100, player.y, 0);
  world.vehicles.set(car.id, car);
  player.lastVehicle = car;
  player.cash = 2000;
  const fit = trunkOf(car).room('logs');
  assert.equal(fit, config.cargo.vehicles.truck * config.cargo.vehicleSlotWeight);
  assert.equal(eco.trade(player, camp.id, 'logs', fit, 'buy'), null);
  assert.equal(trunkOf(car).count('logs'), fit, 'bought goods go in the truck first');
  assert.equal(carried(player).logs, undefined);
  car.x += 1000; // drove off without you
  assert.equal(eco.vehicleOf(player), null);
});

test('cars burn fuel, stop accelerating when empty, and refill at a gas station for cash', () => {
  const { world, eco, player, byType } = town();
  const gas = byType('gas');
  const car = new Vehicle(9001, 'sedan', gas.npc.x, gas.npc.y + 120, 0);
  world.vehicles.set(car.id, car);
  car.fuel = 0.3; // about 360 units of driving
  player.vehicle = car;
  car.driver = player;
  player.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, gas: 1 });
  for (let i = 0; i < 90; i++) world.step(1 / 30);
  assert.equal(car.fuel, 0);
  const speed = Math.hypot(car.vx, car.vy);
  assert.ok(speed > 50, `was moving when it ran dry (${speed})`);
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.ok(Math.hypot(car.vx, car.vy) < speed, 'coasting to a stop');
  // Out of fuel: braking still works, but you can't reverse.
  player.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, gas: -1 });
  for (let i = 0; i < 120; i++) world.step(1 / 30);
  const forward = car.vx * Math.cos(car.angle) + car.vy * Math.sin(car.angle);
  assert.ok(forward > -5, `no reversing on an empty tank (${forward})`);
  assert.ok(Math.hypot(car.vx, car.vy) < 5, 'braked to a stop');

  car.x = gas.npc.x;
  car.y = gas.npc.y + 120;
  player.x = car.x;
  player.y = car.y;
  player.cash = 0;
  assert.equal(eco.refuel(player), 'not_enough_cash');
  player.cash = 1000;
  assert.equal(eco.refuel(player), null);
  assert.equal(car.fuel, 100);
});

test('markets breathe back toward normal stock over time', () => {
  const { world, eco, byType } = town();
  const depot = eco.markets.get(byType('market').id);
  depot.goods.steel.stock = 0;
  for (let i = 0; i < 300; i++) world.step(1);
  assert.ok(depot.goods.steel.stock > 5);
  const camp = eco.markets.get(byType('logging').id);
  camp.goods.logs.stock = 0;
  world.step(20);
  assert.ok(camp.goods.logs.stock >= config.work.npcProducePerSec * 20 * 0.9, 'raw sites produce (work sites slowly: players do most of it)');
});

test('anyone can have their own goods processed at a city factory for a fee', () => {
  const { eco, player, byType, standAt } = town();
  const mill = byType('sawmill');
  standAt(mill);
  const fee = eco.tollFee(config.factories.sawmill.recipes[0]);
  assert.equal(fee, Math.round((config.goods.planks.base - config.goods.logs.base) * config.factory.tollShare));
  carry(player, { logs: 4 });
  player.cash = fee * 3; // only enough for 3 batches
  const result = eco.process(player, mill.id);
  assert.deepEqual(result, { batches: 3, fee: fee * 3 });
  assert.deepEqual(carried(player), { logs: 1, planks: 3 });
  assert.equal(player.cash, 0);
  assert.equal(eco.process(player, mill.id), 'not_enough_cash');

  carry(player, { wheat: 3 });
  player.cash = 100;
  assert.equal(eco.process(player, mill.id), 'nothing_to_process');
});

test('processing respects cargo space when outputs are bulkier than inputs', () => {
  const { map } = validateMap({ width: 3000, height: 3000, buildings: [{ type: 'furniture', x: 500, y: 500, rot: 0 }] });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  const shop = world.buildings[0];
  const p = world.spawnPlayer('maker');
  p.x = shop.npc.x;
  p.y = shop.npc.y + 40;
  // 4 slots free; 16 planks = 4 batches, but furniture is bulky (one per slot)…
  carry(p, { planks: 16 });
  p.cash = 10_000;
  assert.equal(world.economy.process(p, shop.id).batches, 4);
  assert.deepEqual(carried(p), { furniture: 4 });
  // …so with a slot taken by something else, only 3 fit.
  carry(p, { planks: 12, logs: 5 });
  assert.equal(world.economy.process(p, shop.id).batches, 3);
});

test('hotbar slots: stacks fill up before new slots are used, and can hold guns or goods', () => {
  const slots = [{ type: 'pistol', ammo: 5, reloadTimer: 0 }, null, { good: 'logs', qty: 2 }, null, null];
  const bar = new Slots(slots, config.cargo.slotWeight);
  assert.equal(bar.room('logs'), perSlot('logs') * 4 - 2, 'three empty slots plus the rest of the logs stack');
  bar.add('logs', 4);
  assert.equal(slots[2].qty, perSlot('logs'), 'topped up the existing stack first');
  assert.equal(slots[1].qty, 4 - (perSlot('logs') - 2));
  bar.add('logs', -bar.count('logs'));
  assert.deepEqual(slots.slice(1), [null, null, null, null]);
  assert.equal(new Slots(slots, config.cargo.slotWeight).room('car'), 0, "a new car can't be carried on foot");
});

test('your hotbar and your nearby car count together (logs in hand, empty truck parked by the mill)', () => {
  const { world, eco, player, byType, standAt } = town();
  const mill = byType('sawmill');
  standAt(mill);
  const truck = new Vehicle(9100, 'truck', player.x + 120, player.y, 0);
  world.vehicles.set(truck.id, truck);
  player.lastVehicle = truck;
  carry(player, { logs: 10 });
  player.cash = 1000;
  const result = eco.process(player, mill.id);
  assert.equal(result.batches, 10);
  assert.equal(carried(player).logs, undefined, 'inputs came out of the hotbar');
  assert.equal(trunkOf(truck).count('planks'), 10, 'outputs went into the truck');
});

test('Q drops the selected slot; someone else can pick it up, you only after a moment', () => {
  const { world, player } = town();
  player.x = player.y = 1500;
  carry(player, { logs: 5 });
  player.selected = 1;
  assert.equal(world.drop(player), null);
  assert.equal(player.inventory[1], null);
  world.step(1 / 30);
  assert.equal(carried(player).logs, undefined, "can't grab it straight back");

  const other = world.spawnPlayer('finder');
  other.x = other.y = 1500;
  world.step(1 / 30);
  assert.equal(carried(other).logs, 5);

  player.selected = 0;
  assert.equal(world.drop(player), 'cant_drop_starter');
});

test('trunks: only from the driver seat, take a stack into your hotbar or put one in; C toggles the lights', () => {
  const { world, player } = town();
  const car = new Vehicle(9200, 'pickup', 2000, 2000, 0);
  world.vehicles.set(car.id, car);
  trunkOf(car).add('planks', 15);
  player.x = 2000 - car.stats.length / 2 - 25; // standing right at the back is not enough
  player.y = 2000;
  assert.equal(world.trunk(player, car.id, 'take', 0), 'get_in');
  Object.assign(player, { vehicle: car, x: car.x, y: car.y });
  car.driver = player;
  assert.equal(world.trunk(player, car.id, 'take', 0), null);
  assert.equal(carried(player).planks, 10, 'one trunk slot of planks (10) → two hotbar slots');
  player.selected = 1;
  assert.equal(world.trunk(player, car.id, 'put', 1), null);
  assert.equal(trunkOf(car).count('planks'), 10);
  car.lights = true;
  assert.equal(world.toggleLights(player), null);
  assert.equal(car.lights, false);
  player.vehicle = null;
  assert.equal(world.toggleLights(player), 'not_driving');
});

test('new cars only fit in pickups and box trucks', () => {
  const sedan = new Vehicle(1, 'sedan', 0, 0, 0);
  const truck = new Vehicle(2, 'truck', 0, 0, 0);
  assert.equal(trunkOf(sedan).room('car'), 0);
  assert.equal(trunkOf(truck).room('car'), config.cargo.vehicles.truck);
});

test('dragging: drop any hotbar slot', () => {
  const { world, player } = town();
  player.x = player.y = 1500;
  carry(player, { logs: 5 });
  const slot = player.inventory.findIndex((s) => s?.good);
  player.selected = 0;
  assert.equal(world.drop(player, slot), null);
  assert.equal(player.inventory[slot], null);
  assert.equal(world.drop(player, 0), 'cant_drop_starter');
});

test('fuel in hand pours into the car beside you, 20% of a tank each', () => {
  const { world, player } = town();
  Object.assign(player, { x: 2000, y: 2000 });
  carry(player, { fuel: 3 });
  player.selected = player.inventory.findIndex((s) => s?.good === 'fuel');
  assert.equal(world.pourFuel(player), 'no_car_near');
  const car = new Vehicle(9002, 'sedan', 2000, 2070, 0);
  car.fuel = 65; // needs two
  world.vehicles.set(car.id, car);
  assert.equal(world.pourFuel(player), null);
  assert.equal(car.fuel, 100);
  assert.equal(carried(player).fuel, 1, 'only what the tank needed');
  assert.equal(world.pourFuel(player), 'tank_full');
});

test('guns go in the trunk too: a whole slot each, ammo and all, and they keep in a saved car', () => {
  const { world, player } = town();
  const car = new Vehicle(9201, 'sedan', 2000, 2000, 0);
  world.vehicles.set(car.id, car);
  Object.assign(player, { vehicle: car, x: car.x, y: car.y });
  car.driver = player;
  const gun = world.makeWeapon('rifle');
  gun.ammo = 7;
  player.inventory[2] = gun;
  assert.equal(world.trunk(player, car.id, 'put', 2), null);
  assert.equal(player.inventory[2], null);
  assert.deepEqual(car.cargo.find(Boolean), { type: 'rifle', ammo: 7 });
  trunkOf(car).add('planks', 1); // goods still fit round it
  assert.equal(trunkOf(car).count('planks'), 1);
  // A saved car brings it back.
  const saved = JSON.parse(JSON.stringify(car.cargo)).map(trunkSlot);
  assert.deepEqual(saved.find((s) => s?.type), { type: 'rifle', ammo: 7 });
  // And out again, a gun you can shoot.
  const at = car.cargo.findIndex((s) => s?.type === 'rifle');
  assert.equal(world.trunk(player, car.id, 'take', at), null);
  const back = player.inventory.find((s) => s?.type === 'rifle');
  assert.equal(back.ammo, 7);
  assert.equal(car.cargo[at], null);
  assert.ok(player.inventory.filter((s) => s?.type === 'rifle').length === 1);
  // A full trunk: no room.
  car.cargo.fill({ good: 'planks', qty: 1 });
  player.selected = player.inventory.indexOf(back);
  assert.equal(world.trunk(player, car.id, 'put', player.selected), 'no_room');
});

test('vodka poured into a car fills its boost tank; Space burns it for more speed, then it eases back', () => {
  const { world, player } = town();
  Object.assign(player, { x: 2000, y: 2000 });
  carry(player, { vodka: 5 });
  player.selected = player.inventory.findIndex((s) => s?.good === 'vodka');
  const car = new Vehicle(9010, 'sedan', 2000, 2070, 0);
  car.fuel = 100;
  world.vehicles.set(car.id, car);
  assert.equal(world.pourFuel(player), null);
  assert.equal(car.boost, 100, 'four bottles fill it');
  assert.equal(carried(player).vodka, 1);
  assert.equal(car.fuel, 100, 'not the fuel tank');
  assert.equal(world.pourFuel(player), 'boost_full');
  // Drive flat out along an open stretch, without and then with the boost.
  const top = car.stats.maxSpeed;
  Object.assign(player, { vehicle: car, x: car.x, y: car.y });
  car.driver = player;
  Object.assign(car, { x: 300, y: 3700, angle: 0, vx: 0, vy: 0 });
  const drive = (sec, boost) => { for (let i = 0; i < sec * 30; i++) { player.input.gas = 1; player.input.boost = boost; world.step(1 / 30); } };
  drive(4, false);
  const plain = Math.hypot(car.vx, car.vy);
  assert.ok(plain <= top + 1, `no faster than its top speed (${plain})`);
  assert.equal(car.boost, 100, 'nothing burnt without Space');
  drive(1.5, true);
  assert.ok(Math.hypot(car.vx, car.vy) > top * 1.15, 'boosting: faster than its normal top speed');
  assert.ok(car.boost < 100 && car.boost > 50, 'burning');
  car.boost = 0;
  drive(4, true);
  assert.ok(Math.hypot(car.vx, car.vy) <= top + 1, 'out of vodka: back down to normal');
});

test('the car radio: V switches it on and off, N skips to the next song; others see what it plays', () => {
  const { world, player } = town();
  const car = new Vehicle(9020, 'sedan', 2000, 2000, 0);
  world.vehicles.set(car.id, car);
  assert.equal(world.radio(player, 'toggle'), 'not_in_car');
  Object.assign(player, { vehicle: car, x: car.x, y: car.y });
  car.driver = player;
  assert.equal(world.radio(player, 'toggle'), null);
  assert.deepEqual(car.radio, { song: 0, since: world.economy.time });
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.equal(world.radio(player, 'next'), null);
  assert.equal(car.radio.song, 1);
  assert.equal(car.radio.since, world.economy.time, 'the new song starts now');
  assert.equal(world.radio(player, 'toggle'), null);
  assert.equal(car.radio, null, 'off');
  world.radio(player, 'toggle');
  assert.equal(car.radio.song, 1, 'back on where it was');
});
