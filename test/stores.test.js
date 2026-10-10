import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

function town() {
  const { map } = validateMap({
    width: 5000,
    height: 4000,
    buildings: [
      { type: 'gunstore', x: 300, y: 300, rot: 0 },
      { type: 'dealership', x: 1200, y: 300, rot: 0 },
      { type: 'logging', x: 300, y: 2500, rot: 0 },
      { type: 'market', x: 3800, y: 2500, rot: 0 },
    ],
  });
  const world = new World({ ...config.world, foodCount: 0 }, config.player, config.weapons, map);
  const byType = (t) => world.buildings.find((b) => b.type === t);
  const p = world.spawnPlayer('buyer');
  p.account = { id: 1, name: 'buyer', bank: 20000, guest: false };
  const standAt = (b) => { p.x = b.npc.x; p.y = b.npc.y + 40; };
  return { world, eco: world.economy, p, byType, standAt };
}

test('gun stores sell guns for cash, one of each, using their stock', () => {
  const { eco, p, byType, standAt } = town();
  const store = byType('gunstore');
  standAt(store);
  const market = eco.markets.get(store.id);
  const before = market.goods.guns.stock;
  const price = eco.gunPrice(market, 'rifle') + eco.gunTax(market, 'rifle'); // plus the licence tax
  assert.equal(eco.gunTax(market, 'rifle'), Math.round(eco.gunPrice(market, 'rifle') * config.gunstore.taxRate));
  p.cash = price - 1;
  assert.equal(eco.buyGun(p, store.id, 'rifle'), 'not_enough_cash');
  p.cash = 5000;
  assert.equal(eco.buyGun(p, store.id, 'rifle'), null);
  assert.ok(p.hasWeapon('rifle'));
  assert.equal(p.cash, 5000 - price);
  assert.equal(market.goods.guns.stock, before - 1);
  assert.equal(eco.buyGun(p, store.id, 'rifle'), 'already_have');
  // Gun factories restock the store by selling it crates of guns.
  hotbarOf(p).add('guns', 2);
  assert.equal(eco.trade(p, store.id, 'guns', 2, 'sell'), null);
  assert.equal(market.goods.guns.stock, before + 1);
});

test('dealerships sell new vehicles from the bank, parked outside with your name', () => {
  const { world, eco, p, byType, standAt } = town();
  const dealer = byType('dealership');
  standAt(dealer);
  const market = eco.markets.get(dealer.id);
  const price = eco.vehiclePrice(market, 'truck');
  const cars = world.vehicles.size;
  assert.equal(eco.buyVehicle(p, dealer.id, 'truck'), null);
  assert.equal(world.vehicles.size, cars + 1);
  const truck = [...world.vehicles.values()].at(-1);
  assert.equal(truck.type, 'truck');
  assert.equal(truck.owner, p.account);
  assert.equal(truck.fuel, 100);
  assert.equal(p.account.bank, 20000 - price);
  assert.ok(!world.isBlocked(truck.x, truck.y, 10), 'parked somewhere clear');
  market.goods.car.stock = 0;
  assert.equal(eco.buyVehicle(p, dealer.id, 'sedan'), 'sold_out');
});

test('delivery jobs: offered, accepted, picked up into your cargo, delivered for pay', () => {
  const { world, eco, p, byType, standAt } = town();
  for (let i = 0; i < 20 && !eco.jobs.size; i++) world.step(config.jobs.everySec);
  const offer = [...eco.jobs.values()].find((j) => eco.markets.get(j.from).type === 'logging');
  assert.ok(offer, 'a logging → market job was offered');
  assert.ok(offer.reward > 0 && offer.qty >= config.jobs.minQty);

  assert.equal(eco.jobAction(p, 'accept', offer.id), null);
  assert.equal(eco.jobAction(p, 'deliver'), 'not_picked');
  standAt(byType('logging'));
  p.inventory = [p.inventory[0], null, null, null, null];
  const hotbarRoom = hotbarOf(p).room(offer.good);
  if (hotbarRoom < offer.qty) assert.equal(eco.jobAction(p, 'pickup'), 'no_room');
  // Bring a truck.
  const dealer = byType('dealership');
  standAt(dealer);
  assert.equal(eco.buyVehicle(p, dealer.id, 'truck'), null);
  const truck = p.lastVehicle;
  standAt(byType('logging'));
  truck.x = p.x + 150;
  truck.y = p.y;
  assert.equal(eco.jobAction(p, 'pickup'), null);
  assert.equal(eco.cargoOf(p).count(offer.good), offer.qty);

  const bank = p.account.bank;
  standAt(byType('market'));
  truck.x = p.x + 150;
  truck.y = p.y;
  assert.equal(eco.jobAction(p, 'deliver'), null);
  assert.equal(p.account.bank, bank + offer.reward);
  assert.equal(eco.jobOf(p), null);
  assert.equal(eco.cargoOf(p).count(offer.good), 0);
});

test('jobs run out: offers expire, and accepted ones have a time limit', () => {
  const { world, eco, p } = town();
  for (let i = 0; i < 20 && !eco.jobs.size; i++) world.step(config.jobs.everySec);
  const job = [...eco.jobs.values()][0];
  eco.jobAction(p, 'accept', job.id);
  world.step(config.jobs.timeLimitSec + 1);
  assert.equal(eco.jobOf(p), null);
});

test('no guns lie around on a fresh map any more', () => {
  const world = new World({ ...config.world, foodCount: 0 });
  for (let i = 0; i < 30; i++) world.step(1);
  assert.equal([...world.pickups.values()].filter((g) => g.weapon).length, 0);
  assert.ok(world.buildings.some((b) => b.type === 'gunstore') && world.buildings.some((b) => b.type === 'dealership'));
});

test('nobody can have licensed guns made: not at the gun factory, not on a warehouse machine', () => {
  const { map } = validateMap({ width: 4000, height: 3000, buildings: [{ type: 'gunfactory', x: 500, y: 500, rot: 0 }] });
  const world = new World({ ...config.world, foodCount: 0 }, config.player, config.weapons, map);
  const factory = world.buildings.find((b) => b.type === 'gunfactory');
  const p = world.spawnPlayer('maker');
  const f = world.economy.factories.get(factory.id);
  Object.assign(p, { x: f.x, y: f.y + 40, cash: 10000 });
  hotbarOf(p).add('steel', 3);
  hotbarOf(p).add('parts', 2);
  assert.equal(world.economy.process(p, factory.id), 'licensed_only');
  assert.equal(hotbarOf(p).count('steel'), 3, 'nothing used');
  assert.ok(!Object.values(config.machines).some((m) => m.recipes.includes('gunfactory:0')), 'no machine makes them');
  assert.ok(config.machines.gunsmith.recipes.includes('illegal:blackguns'), 'unregistered ones still can be');
});
