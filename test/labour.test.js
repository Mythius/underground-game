import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { trunkOf } from '../src/game/cargo.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)

// A farm, the flour mill, the bakery and a shop along one road.
function chain() {
  const { map, error } = validateMap({
    width: 8000,
    height: 4000,
    roads: [{ x: 0, y: 1900, w: 8000, h: 270 }],
    buildings: [
      { type: 'farm', x: 200, y: 200, rot: 0, size: { w: 1400, h: 1400 } },
      { type: 'flourmill', x: 2600, y: 1500, rot: 0 },
      { type: 'bakery', x: 4000, y: 1500, rot: 0 },
      { type: 'shop', x: 5400, y: 1600, rot: 0 },
    ],
  });
  assert.equal(error, undefined);
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0, parkingLots: 0 }, config.player, config.weapons, map);
  const byType = (t) => world.buildings.find((b) => b.type === t);
  return { world, byType, eco: world.economy, labour: world.labour };
}

const run = (world, sec, dt = 1 / 4) => { for (let i = 0; i < sec / dt; i++) world.step(dt); };

test('two hands at each work site work the wheat and carry it to the foreman', () => {
  const { world, byType, eco } = chain();
  const farm = byType('farm');
  const hands = world.townsfolk.people.filter((p) => p.job?.kind === 'worker');
  assert.equal(hands.length, config.labour.workers);
  assert.ok(hands.every((h) => h.job.site === farm && h.job.tool === 'scythe'));
  const wheat = eco.markets.get(farm.id).goods.wheat;
  wheat.stock = 0;
  const ripe = () => [...world.work.nodes.values()].filter((n) => n.site === farm.id && n.hp > 0).length;
  const before = ripe();
  run(world, 90);
  assert.ok(ripe() < before, 'they cut the wheat');
  assert.ok(wheat.stock > 0, `and hand it in (${wheat.stock})`);
  // In winter there's no wheat to cut: they wait by the foreman.
  world.frozen = true;
  wheat.stock = 0;
  for (const h of hands) Object.assign(h.job, { carry: 0, bag: {}, target: null });
  run(world, 30);
  assert.equal(wheat.stock, 0, 'nothing to cut in winter');
});

test('a killed hand is replaced a while later', () => {
  const { world } = chain();
  const hand = world.townsfolk.people.find((p) => p.job?.kind === 'worker');
  world.townsfolk.damage(hand, 1000);
  assert.equal(world.townsfolk.people.filter((p) => p.job?.kind === 'worker').length, config.labour.workers - 1);
  run(world, config.labour.replaceSec + 2, 1);
  assert.equal(world.townsfolk.people.filter((p) => p.job?.kind === 'worker').length, config.labour.workers);
});

test('trucks carry wheat to the mill, flour to the bakery and bread to the shop', () => {
  const { world, byType, eco, labour } = chain();
  for (const p of world.townsfolk.people) if (p.job?.kind === 'worker') p.job.site = { ...p.job.site, id: -1 }; // (the hands sit this one out)
  assert.equal(labour.legs.length, 3, 'farm → mill, mill → bakery, bakery → shop');
  assert.ok(labour.supplies.has('bread'), 'bread only comes by truck now');
  const farm = eco.markets.get(byType('farm').id);
  const shop = eco.markets.get(byType('shop').id);
  farm.goods.wheat.stock = 200;
  shop.goods.bread.stock = 0;
  run(world, 1);
  assert.ok(labour.legs.every((l) => l.truck && l.truck.type === 'truck'), 'a KAMAZ on every route');
  run(world, 600);
  assert.ok(farm.goods.wheat.stock < 200, 'wheat collected from the farm');
  assert.ok(shop.goods.bread.stock > 0, `bread delivered to the shop (${shop.goods.bread.stock})`);
});

test('the shops no longer get bread from nowhere', () => {
  const { world, byType, eco } = chain();
  const shop = eco.markets.get(byType('shop').id);
  for (const l of world.labour.legs) l.respawnAt = Infinity; // no trucks
  shop.goods.bread.stock = 2;
  run(world, 300, 1);
  assert.ok(shop.goods.bread.stock <= 2);
});

test('a city mill works its stock, several batches at a time, up to its target', () => {
  const { world, byType, eco } = chain();
  for (const l of world.labour.legs) l.respawnAt = Infinity;
  const mill = eco.factories.get(byType('flourmill').id);
  mill.stock.wheat = 1000;
  run(world, config.factories.flourmill.sec + 1, 1);
  assert.equal(mill.stock.flour, config.labour.factoryLines);
  run(world, 300, 1);
  assert.equal(mill.stock.flour, config.labour.factoryTarget, 'stops once it has its fill');
});

test('hijack a cargo truck: the driver jumps out and runs to phone it in; the load is yours; another truck comes later', () => {
  const { world, labour } = chain();
  const crimes = [];
  world.police.crime = (who, kind, alarm) => crimes.push({ who, kind, alarm });
  run(world, 1);
  const leg = labour.legs[0];
  const truck = leg.truck;
  trunkOf(truck).add(leg.good, 30);
  truck.ai = null;
  Object.assign(truck, { vx: 0, vy: 0 });
  const p = world.spawnPlayer('hijacker');
  Object.assign(p, { x: truck.x, y: truck.y - truck.stats.width / 2 - p.radius - 10 });
  p.applyInput({ seq: 1, angle: 0, throttle: 0, aim: 0, use: true });
  world.step(1 / 30);
  assert.equal(p.vehicle, truck, 'in the cab');
  assert.equal(leg.truck, null);
  assert.equal(truck.labourTruck, null);
  const driver = world.townsfolk.people.find((x) => x.job?.kind === 'driver');
  assert.ok(driver?.flee, 'the driver runs for it');
  run(world, config.townsfolk.fleeSec + 1, 1 / 10);
  assert.ok(crimes.some((c) => c.who === p && c.kind === 'steal_car'), 'and phones it in');
  assert.equal(trunkOf(truck).count(leg.good), 30, 'the load is in the back');
  run(world, config.labour.truckReplaceSec, 1);
  assert.ok(leg.truck && leg.truck !== truck, 'a new truck on the route');
});
