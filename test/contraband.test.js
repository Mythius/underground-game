import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
config.crime.newcomer.crimes = 0; // (no newcomer fines: crimes give stars straight away; they have their own test)
import { carriedSlots } from '../src/game/Room.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf, trunkOf } from '../src/game/cargo.js';
import { Vehicle } from '../src/game/vehicles.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)

// A small town on a railway: the station north of the track, a shop, a market, a warehouse and a shack.
function town() {
  const { map, error } = validateMap({
    width: 6000,
    height: 6000,
    roads: [{ x: 0, y: 1000, w: 6000, h: 270 }, { x: 3000, y: 0, w: 270, h: 6000 }],
    railway: { y: 2400 },
    buildings: [
      { type: 'station', x: 1200, y: 2000, rot: 0 },
      { type: 'shop', x: 400, y: 300, rot: 0 },
      { type: 'market', x: 1200, y: 300, rot: 0 },
      { type: 'warehouse', x: 400, y: 3000, rot: 0 },
      { type: 'shack', x: 1600, y: 3000, rot: 0 },
    ],
  });
  assert.equal(error, undefined);
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0, parkingLots: 0 }, config.player, config.weapons, map);
  const byType = (t) => world.buildings.find((b) => b.type === t);
  const player = world.spawnPlayer('boss');
  player.account = { id: 1, name: 'boss', bank: 1e6, guest: false };
  player.cash = 0;
  world.police.policeSee = () => false; // nobody's watching unless a test says so
  world.police.witnessed = () => false;
  return { world, player, byType, at: (x, y) => Object.assign(player, { x, y }) };
}

test('the freight train arrives, takes contract goods at a premium, leaves, and posts new contracts', () => {
  const { world, player, at } = town();
  const rail = world.railway;
  assert.ok(rail.contracts.length >= config.railway.contracts[0]);
  const c = rail.contracts[0];
  at(rail.clerk.x, rail.clerk.y + 40);
  hotbarOf(player).add(c.good, 4);
  // No train: the clerk still buys it, as freight (below market).
  assert.deepEqual(rail.deliver(player, c.good, 1), { qty: 1, paid: rail.freightPrice(c.good) });
  rail.train.timer = 0;
  for (let i = 0; i < 30 * 60 && rail.train.state !== 'docked'; i++) world.step(1 / 30);
  assert.equal(rail.train.state, 'docked');
  const r = rail.deliver(player, c.good, 3);
  assert.deepEqual(r, { qty: Math.min(3, c.qty), paid: Math.min(3, c.qty) * c.price });
  assert.equal(c.price, Math.round(config.goods[c.good].base * config.railway.premium));
  // Any legal good sells as freight, any time; contraband doesn't.
  hotbarOf(player).add('wheat', 2);
  assert.deepEqual(rail.deliver(player, 'wheat', 2), { qty: 2, paid: 2 * Math.round(config.goods.wheat.base * config.railway.freightShare) });
  assert.equal(rail.deliver(player, 'wheat', 1), 'not_carrying');
  hotbarOf(player).add('vodka', 1);
  assert.equal(rail.deliver(player, 'vodka', 1), 'not_wanted');
  const before = rail.contracts;
  for (let i = 0; i < 30 * (config.railway.dockSec + 120) && rail.train.state !== 'away'; i++) world.step(1 / 30);
  assert.equal(rail.train.state, 'away');
  assert.notEqual(rail.contracts, before, 'new contracts for the next train');
});

test('the train throws people off the track', () => {
  const { world, player } = town();
  const rail = world.railway;
  Object.assign(rail.train, { state: 'arriving', x: 500, speed: 600 });
  Object.assign(player, { x: 450, y: rail.y }); // right where the train is coming through
  world.step(1 / 30);
  assert.ok(Math.abs(player.y - rail.y) > 34, 'shoved clear');
  assert.ok(player.health < player.maxHealth);
});

test('black market behind the station buys contraband at a discount; markets never touch it', () => {
  const { world, player, at, byType } = town();
  const depot = world.economy.markets.get(byType('market').id);
  assert.equal(depot.goods.vodka, undefined);
  const s = world.railway.smuggler;
  at(s.x, s.y - 40);
  hotbarOf(player).add('vodka', 5);
  assert.equal(world.railway.sellBlack(player, 'logs', 1), 'not_wanted');
  assert.deepEqual(world.railway.sellBlack(player, 'vodka', 5), { qty: 5, paid: 5 * Math.round(60 * config.blackMarket.share) });
  assert.equal(player.cash, 5 * Math.round(60 * config.blackMarket.share));
});

test('under the counter at a shop: full price, but heat builds until the Militsiya raid and shut it', () => {
  const { world, player, at, byType } = town();
  const shop = byType('shop');
  const eco = world.economy;
  at(shop.npc.x, shop.npc.y + 40);
  hotbarOf(player).add('vodka', 5);
  assert.deepEqual(eco.underTable(player, shop.id, 'vodka', 5), { qty: 5, paid: 300 });
  assert.ok(eco.markets.get(shop.id).heat > 0);
  // Keep selling until it's raided.
  for (let i = 0; i < 200 && !eco.isClosed(eco.markets.get(shop.id)); i++) {
    hotbarOf(player).add('counterfeit', 5);
    eco.underTable(player, shop.id, 'counterfeit', 5);
  }
  assert.ok(eco.isClosed(eco.markets.get(shop.id)), 'raided');
  assert.deepEqual(eco.events.at(-1), { kind: 'raid', building: shop.id });
  hotbarOf(player).add('vodka', 1);
  assert.equal(eco.underTable(player, shop.id, 'vodka', 1), 'closed_raid');
  assert.equal(world.buy(player, Object.keys(config.economy.menu)[0]), 'closed_raid', 'no food either');
  // Selling in front of the Militsiya is a crime.
  const other = town();
  const s2 = other.byType('shop');
  other.at(s2.npc.x, s2.npc.y + 40);
  other.world.police.policeSee = () => true;
  hotbarOf(other.player).add('vodka', 1);
  other.world.economy.underTable(other.player, s2.id, 'vodka', 1);
  assert.equal(other.player.wanted, config.crime.stars.sell_contraband);
});

test('roadblocks: stop and get searched (contraband seized), bribe to pass, or drive past and be wanted', () => {
  const { world, player } = town();
  const block = world.roadblocks.list[0];
  assert.ok(block, 'there is a roadblock');
  const car = new Vehicle(9200, 'truck', block.x, block.y, 0);
  world.vehicles.set(car.id, car);
  Object.assign(car, { driver: player });
  Object.assign(player, { vehicle: car, lastVehicle: car, x: car.x, y: car.y });
  trunkOf(car).add('vodka', 10);
  trunkOf(car).add('planks', 10);
  for (let i = 0; i < 30 * 2; i++) world.roadblocks.step(1 / 30);
  assert.equal(trunkOf(car).count('vodka'), 0, 'seized');
  assert.equal(trunkOf(car).count('planks'), 10, 'legal goods stay');
  assert.equal(player.wanted, config.crime.stars.smuggling);
  assert.equal(world.roadblocks.events.at(-1).kind, 'roadblock_seized');

  // Somebody else bribes first.
  const t2 = town();
  const b2 = t2.world.roadblocks.list[0];
  const car2 = new Vehicle(9201, 'sedan', b2.x, b2.y, 0);
  t2.world.vehicles.set(car2.id, car2);
  Object.assign(car2, { driver: t2.player });
  Object.assign(t2.player, { vehicle: car2, lastVehicle: car2, x: car2.x, y: car2.y, cash: 1000 });
  trunkOf(car2).add('vodka', 2);
  assert.equal(t2.world.roadblocks.bribe(t2.player), null);
  assert.equal(t2.player.cash, 1000 - config.roadblocks.bribe);
  for (let i = 0; i < 30 * 2; i++) t2.world.roadblocks.step(1 / 30);
  assert.equal(trunkOf(car2).count('vodka'), 2, 'waved through');

  // Coming into range starts a countdown: not checked within it means you ran the checkpoint.
  const t3 = town();
  const b3 = t3.world.roadblocks.list[0];
  const car3 = new Vehicle(9202, 'sports', b3.x, b3.y, 0);
  t3.world.vehicles.set(car3.id, car3);
  Object.assign(car3, { driver: t3.player, vx: 400 });
  Object.assign(t3.player, { vehicle: car3, x: car3.x, y: car3.y });
  t3.world.roadblocks.step(1 / 30);
  assert.equal(t3.world.roadblocks.events.at(-1).kind, 'roadblock_due');
  assert.equal(t3.player.wanted, 0, 'not straight away');
  car3.x += 3000; // drove off without stopping
  for (let i = 0; i < 30 * (config.roadblocks.checkWithinSec + 1); i++) t3.world.economy.time += 1 / 30, t3.world.roadblocks.step(1 / 30);
  assert.equal(t3.player.wanted, config.crime.stars.run_roadblock);
});

test("roadblocks know a car that isn't yours: no bribe, you're pulled out and it goes back", () => {
  const { world, player } = town();
  const block = world.roadblocks.list[0];
  const owner = { id: 99, name: 'owner', bank: 0, guest: false };
  const car = new Vehicle(9300, 'sedan', block.x, block.y, 0);
  Object.assign(car, { owner, carId: 5, driver: player, picked: true });
  world.vehicles.set(car.id, car);
  Object.assign(player, { vehicle: car, lastVehicle: car, x: car.x, y: car.y, cash: 5000 });
  const lost = [];
  world.onCarLost = (v) => lost.push(v);
  assert.equal(world.roadblocks.bribe(player), 'stolen_car');
  for (let i = 0; i < 30 * 2; i++) world.roadblocks.step(1 / 30);
  assert.equal(player.vehicle, null, 'pulled out');
  assert.equal(player.wanted, config.crime.stars.steal_car);
  assert.ok(!world.vehicles.has(car.id) && lost[0] === car, "back in the owner's garage");
  assert.equal(world.roadblocks.events.at(-1).kind, 'roadblock_stolen');

  // Your own car is fine.
  const t2 = town();
  const b2 = t2.world.roadblocks.list[0];
  const mine = new Vehicle(9301, 'sedan', b2.x, b2.y, 0);
  Object.assign(mine, { owner: t2.player.account, driver: t2.player });
  t2.world.vehicles.set(mine.id, mine);
  Object.assign(t2.player, { vehicle: mine, x: mine.x, y: mine.y });
  for (let i = 0; i < 30 * 2; i++) t2.world.roadblocks.step(1 / 30);
  assert.equal(t2.player.vehicle, mine);
  assert.equal(t2.world.roadblocks.events.at(-1).kind, 'roadblock_clean');
});

test('illegal machines: shacks take only them; making contraband builds heat until a raid seizes it', () => {
  const { world, player, byType } = town();
  const shack = [...world.warehouses.all.values()].find((w) => w.size === 'shack');
  const big = [...world.warehouses.all.values()].find((w) => w.size === 'medium');
  const act = (w, msg) => world.warehouses.action(player, { id: w.id, ...msg });
  const inside = (w) => { const c = w.tileCenter(1, 1); Object.assign(player, { x: c.x, y: c.y }); };
  inside(shack);
  assert.equal(act(shack, { action: 'buy' }), null);
  assert.equal(act(shack, { action: 'place', kind: 'saw', x: 0, y: 0, dir: 0 }), 'shack_illegal_only');
  assert.equal(act(shack, { action: 'place', kind: 'still', x: 0, y: 0, dir: 0 }), null);
  inside(big);
  assert.equal(act(big, { action: 'buy' }), null);
  assert.equal(act(big, { action: 'place', kind: 'still', x: 3, y: 2, dir: 0 }), null);
  const still = big.at(3, 2);
  assert.equal(still.recipe, 'illegal:vodka');
  still.in = { wheat: 20 };
  for (let i = 0; i < 30 * 12; i++) world.step(1 / 30);
  assert.ok(still.out.vodka >= 1, 'vodka made');
  assert.ok(big.heat > 0, 'and it drew attention');
  // Push it over the top: a raid takes all the contraband.
  big.heat = 100;
  big.dockOut.stock = { vodka: 7, planks: 3 };
  world.step(1 / 30);
  assert.equal(big.dockOut.stock.vodka, undefined);
  assert.equal(big.dockOut.stock.planks, 3);
  assert.equal(still.out.vodka, undefined);
  const raid = world.warehouses.events.at(-1);
  assert.equal(raid.kind, 'raid');
  assert.ok(raid.seized.vodka >= 7);
});

test('chop shop: a car that is not yours, parked inside, becomes stolen parts in the IN dock', () => {
  const { world, player, byType } = town();
  const w = [...world.warehouses.all.values()].find((x) => x.size === 'medium');
  const c = w.tileCenter(5, 3);
  Object.assign(player, { x: c.x - 100, y: c.y });
  world.warehouses.action(player, { id: w.id, action: 'buy' });
  assert.equal(world.warehouses.action(player, { id: w.id, action: 'chop' }), 'no_car_inside');
  const mine = new Vehicle(9300, 'sedan', c.x, c.y, 0);
  mine.owner = player.account;
  world.vehicles.set(mine.id, mine);
  assert.equal(world.warehouses.action(player, { id: w.id, action: 'chop' }), 'no_car_inside', 'not your own car');
  world.vehicles.delete(mine.id);
  const stolen = new Vehicle(9301, 'pickup', c.x, c.y, 0);
  trunkOf(stolen).add('logs', 10);
  world.vehicles.set(stolen.id, stolen);
  assert.equal(world.warehouses.action(player, { id: w.id, action: 'chop' }), null);
  assert.equal(world.vehicles.has(stolen.id), false);
  assert.equal(w.dockIn.stock.hotparts, config.warehouses.chopParts.pickup);
  assert.equal(w.dockIn.stock.logs, 10);
});

test('most delivery jobs haul contract goods to the train', () => {
  const { world } = town();
  world.economy.jobs.clear();
  for (let i = 0; i < 40; i++) world.economy.jobTimer = config.jobs.everySec, world.step(1 / 30), world.economy.jobs.forEach((j) => { if (!j.taker) j.offeredUntil = 1e9; });
  const jobs = [...world.economy.jobs.values()];
  assert.ok(jobs.length > 0);
  assert.ok(jobs.some((j) => j.train && j.to === world.railway.station.id), 'train jobs');
});

test('unregistered pistols: taken up from the box, still illegal — the Militsiya report them, checkpoints seize them, the smuggler buys them', () => {
  const { world, player, at } = town();
  assert.equal(config.machines.gunsmith.recipes[0], 'illegal:blackguns', 'made on a gunsmith bench');
  hotbarOf(player).add('blackguns', 2);
  player.selected = player.inventory.findIndex((s) => s?.good === 'blackguns');
  assert.equal(world.eat(player), null, 'E takes one up');
  const gun = player.weapon;
  assert.equal(gun.type, 'pistol');
  assert.equal(gun.illegal, true);
  assert.equal(hotbarOf(player).count('blackguns'), 1, 'one still boxed');
  assert.equal(world.eat(Object.assign(player, { selected: player.inventory.findIndex((s) => s?.good === 'blackguns') })), null);
  assert.equal(player.inventory.filter((s) => s?.type === 'pistol').length, 2, 'two of the same gun');
  // Kept with your hotbar.
  const back = JSON.parse(JSON.stringify(carriedSlots(player)));
  assert.ok(back.some((s) => s?.type === 'pistol' && s.illegal));
  // A cop who sees it in your hand.
  player.selected = player.inventory.findIndex((s) => s?.illegal);
  world.police.policeSee = () => true;
  world.police.step(1 / 30);
  assert.equal(player.wanted, config.crime.stars.illegal_gun);
  world.police.policeSee = () => false;
  player.wanted = 0;
  // The smuggler buys them as guns.
  const s = world.railway.smuggler;
  at(s.x, s.y - 40);
  const r = world.railway.sellBlack(player, 'blackguns', 1);
  assert.equal(r.qty, 1);
  assert.equal(player.inventory.filter((x) => x?.illegal).length, 1);
  // A checkpoint takes the other.
  const block = world.roadblocks.list[0];
  const car = new Vehicle(9201, 'sedan', block.x, block.y, 0);
  world.vehicles.set(car.id, car);
  Object.assign(car, { driver: player });
  Object.assign(player, { vehicle: car, lastVehicle: car, x: car.x, y: car.y, handledAt: {} });
  for (let i = 0; i < 30 * 2; i++) world.roadblocks.step(1 / 30);
  assert.equal(player.inventory.filter((x) => x?.illegal).length, 0, 'seized');
  assert.equal(world.roadblocks.events.at(-1).seized.blackguns, 1);
});
