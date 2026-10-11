import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { RoadGraph } from '../src/game/townsfolk.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

config.player.healthRegenPerSec = 0; // these tests count exact damage and healing

test('road routes follow the roads through junctions', () => {
  // An L of roads: a horizontal one at y≈500 from x 0–3000, a vertical one at x≈2500 from y 0–3000.
  const graph = new RoadGraph([{ x: 0, y: 450, w: 3000, h: 100 }, { x: 2450, y: 0, w: 100, h: 3000 }]);
  const route = graph.route({ x: 200, y: 500 }, { x: 2500, y: 2800 });
  assert.deepEqual(route[0], { x: 200, y: 500 });
  assert.ok(route.some((p) => p.x === 2500 && p.y === 500), 'turns at the junction');
  assert.deepEqual(route.at(-1), { x: 2500, y: 2800 });
});

function town() {
  const { map } = validateMap({
    width: 5000,
    height: 3000,
    roads: [{ x: 0, y: 1400, w: 5000, h: 200 }],
    buildings: [
      { type: 'house', x: 500, y: 900, rot: 0 },
      { type: 'shop', x: 2000, y: 900, rot: 0 },
      { type: 'market', x: 3500, y: 800, rot: 0 },
    ],
  });
  return new World({ ...config.world, foodCount: 0 }, config.player, config.weapons, map);
}

test('townsfolk go out walking, and buy where they arrive, draining stock', () => {
  const world = town();
  const folk = world.townsfolk;
  assert.ok(folk.people.length > 0);
  for (let i = 0; i < 30 * 60; i++) world.step(1 / 30); // a minute: everyone has left their first stop
  assert.ok(folk.people.some((p) => p.inside <= 0 || p.at !== p.dest), 'people have been out and about');

  const shopSpot = folk.spots.find((s) => s.kind === 'shop');
  const shop = world.economy.markets.get(shopSpot.building);
  const before = shop.goods.bread.stock;
  for (const person of folk.people) folk.visit(person, shopSpot);
  assert.ok(shop.goods.bread.stock < before, `bread ${before} → ${shop.goods.bread.stock}`);
});

test('walking or driving into townsfolk does nothing to them and is no crime', () => {
  const world = town();
  const person = world.townsfolk.people[0];
  person.inside = 0;
  const p = world.spawnPlayer('bumper');
  p.x = person.x;
  p.y = person.y;
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.equal(person.health, config.townsfolk.health);
  assert.equal(p.wanted, 0);
});

test('meals use a shop\'s bread and cost more when bread is scarce; anyone can restock it', () => {
  const world = town();
  const eco = world.economy;
  const shopB = world.buildings.find((b) => b.type === 'shop');
  const shop = eco.markets.get(shopB.id);
  const p = world.spawnPlayer('hungry');
  p.x = shopB.npc.x;
  p.y = shopB.npc.y + 40;
  p.cash = 500;
  const normal = eco.foodPrice(shop, 'burger');
  shop.goods.bread.stock = 1;
  assert.ok(eco.foodPrice(shop, 'burger') > normal, 'scarce bread, dearer burgers');
  assert.equal(world.buy(p, 'burger'), 'sold_out', 'a burger needs 2 bread');
  assert.equal(world.buy(p, 'bread'), null);
  assert.equal(shop.goods.bread.stock, 0);
  hotbarOf(p).add('bread', 5);
  assert.equal(eco.trade(p, shopB.id, 'bread', 5, 'sell'), null);
  assert.equal(shop.goods.bread.stock, 5);
});

test('provoked townsfolk hit you twice with their purse, run, then call the cops', () => {
  const world = town();
  world.police.witnessed = () => false; // nobody else sees a thing
  world.police.policeSee = () => false;
  const folk = world.townsfolk;
  const person = folk.people[0];
  person.inside = 0;
  const p = world.spawnPlayer('victim');
  p.x = person.x + 40;
  p.y = person.y;
  folk.provoke(person, p);
  for (let i = 0; i < 30 * 3 && !person.flee; i++) world.step(1 / 30);
  assert.ok(person.flee, 'ran off after their hits');
  assert.equal(p.health, p.maxHealth * (1 - config.townsfolk.purseHits * config.townsfolk.purseShare));
  assert.equal(p.wanted, 0, 'not called in yet');
  for (let i = 0; i < 30 * (config.townsfolk.fleeSec - 0.5); i++) world.step(1 / 30);
  assert.ok(Math.hypot(person.x - p.x, person.y - p.y) > 300, 'ran away');
  assert.equal(p.wanted, 0);
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.equal(person.flee, null);
  assert.equal(p.wanted, config.crime.stars.assault, 'called the cops');
});

test('the town keeps its numbers: someone who dies is replaced by a newcomer at one of the houses', () => {
  const world = town();
  const folk = world.townsfolk;
  const count = folk.people.length;
  const victim = folk.people[0];
  assert.equal(folk.damage(victim, 1e6), true);
  assert.equal(folk.people.length, count - 1);
  for (let i = 0; i < 30 * (config.townsfolk.replaceSec + 1); i++) world.step(1 / 30);
  assert.equal(folk.people.length, count);
  const newcomer = folk.people.at(-1); // (the newest)
  assert.ok(newcomer.id > victim.id && !folk.people.includes(victim));
  const home = world.buildings.find((b) => b.type === 'house');
  assert.equal(newcomer.at.building, home.id, 'moved into the house');
});

test('a walker who is stuck tries another way: a sidestep, then somewhere else, then indoors', () => {
  const world = town();
  const folk = world.townsfolk;
  folk.people.length = 1;
  const person = folk.people[0];
  person.inside = 0.01;
  world.step(1 / 30); // out the door with somewhere to go
  assert.ok(person.route.length > 0 && person.inside <= 0);
  const pin = { x: person.x, y: person.y };
  const firstDest = person.dest;
  const hold = (sec) => { for (let i = 0; i < 30 * sec; i++) { world.step(1 / 30); if (person.inside <= 0) Object.assign(person, pin); } };
  for (let i = 0; i < 4 && !(person.stuck?.tries >= 1); i++) hold(1);
  assert.equal(person.stuck.tries, 1);
  const step = person.route[0];
  assert.ok(Math.abs(Math.hypot(step.x - pin.x, step.y - pin.y) - 90) < 1, 'a sidestep off in another direction first');
  assert.equal(person.dest, firstDest, 'same destination for now');
  hold(4);
  assert.ok(person.stuck.tries >= 3, 'still stuck');
  assert.ok(person.dest !== firstDest || person.route[0] !== step, 'a new plan from where they stand');
  hold(6);
  assert.ok(person.inside > 0, 'gave up and went indoors');
  for (let i = 0; i < 30 * (config.townsfolk.minStaySec + 1); i++) world.step(1 / 30);
  assert.ok(person.inside <= 0 && person.route.length > 0, 'and out again later');
});

test('a full-size map is capped at maxPopulation townsfolk and maxUnits police', () => {
  const world = new World();
  assert.ok(world.buildings.length * config.townsfolk.perBuilding > config.townsfolk.maxPopulation, 'a big enough town to hit the cap');
  assert.equal(world.townsfolk.people.length, config.townsfolk.maxPopulation);
  assert.equal(world.police.units.length + world.police.waiting.length, config.police.maxUnits);
  assert.equal(config.townsfolk.maxPopulation, 300);
  assert.equal(config.police.maxUnits, 20);
});
