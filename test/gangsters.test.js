import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { Vehicle } from '../src/game/vehicles.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

config.player.healthRegenPerSec = 0;

// A long road through open ground.
function town() {
  const { map } = validateMap({ width: 8000, height: 4000, roads: [{ x: 0, y: 1900, w: 8000, h: 200 }, { x: 3900, y: 0, w: 200, h: 4000 }], buildings: [] });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  for (const u of world.police.units) u.officer.health = -1e9; // (no Militsiya getting involved)
  world.police.policeSee = () => false;
  world.police.witnessed = () => false;
  return world;
}
const gangsters = (world) => world.hires.list.filter((h) => h.role === 'gangster');
const run = (world, sec) => { for (let i = 0; i < sec * 30; i++) world.step(1 / 30); };

/** One gangster left, at (x, y), and a player for `id`. */
function oneGangster(world, x, y) {
  const [g, ...rest] = gangsters(world);
  for (const o of rest) world.hires.list.splice(world.hires.list.indexOf(o), 1);
  world.hires.gangsterTimers.length = 0;
  Object.assign(g, { x, y, route: [] });
  return g;
}
function player(world, id, x, y) {
  const p = world.spawnPlayer(`p${id}`);
  p.account = { id, name: `p${id}`, bank: 0, guest: false };
  Object.assign(p, { x, y });
  return p;
}

test('four gangsters walk the town with rifles; they take 30% less damage and come back after one is killed', () => {
  const world = town();
  assert.equal(gangsters(world).length, config.gangsters.count);
  const g = gangsters(world)[0];
  assert.equal(g.weapon, 'rifle');
  assert.equal(g.employer, null);
  world.hires.damage(g, 100, null);
  assert.equal(g.health, config.gangsters.health - 100 * (1 - config.gangsters.armor));
  world.hires.damage(g, 1e6, null);
  assert.equal(gangsters(world).length, config.gangsters.count - 1);
  run(world, config.gangsters.respawnSec + 2);
  assert.equal(gangsters(world).length, config.gangsters.count, 'a new one turns up');
});

test('a hold-up: stand still with your hands up and they take half your cash', () => {
  const world = town();
  const g = oneGangster(world, 2000, 2000);
  const p = player(world, 1, 2300, 2000);
  p.cash = 400;
  const chance = config.gangsters.robChance;
  config.gangsters.robChance = 1;
  try {
    run(world, 0.6);
    assert.equal(g.holdup?.p, p, 'he picks them');
    run(world, 6); // he walks up, they stand still
  } finally {
    config.gangsters.robChance = chance;
  }
  assert.equal(p.cash, 200);
  assert.equal(g.cash, 200, 'on him (on his body if he dies)');
  assert.ok(world.hires.events.some((e) => e.player === p && e.kind === 'held_up' && e.amount === 200));
  assert.equal(p.heldUp, null);
});

test('run off during a hold-up and he opens fire', () => {
  const world = town();
  const g = oneGangster(world, 2000, 2000);
  const p = player(world, 1, 2100, 2000);
  p.cash = 400;
  config.gangsters.robChance = 1;
  try {
    run(world, 0.8);
    assert.ok(g.holdup?.started && p.heldUp, 'hands up');
    p.x += 120; // legging it
    let shot = false;
    for (let i = 0; i < 30 * 3 && !shot; i++) {
      world.step(1 / 30);
      shot = [...world.bullets.values()].some((b) => b.owner === g);
    }
    assert.ok(shot, 'he shoots');
    assert.equal(p.cash, 400, 'nothing taken');
  } finally {
    config.gangsters.robChance = 0.2;
  }
});

test('he steals a parked car whose owner is away, drives it off and dumps it; the owner hears where', () => {
  const world = town();
  const g = oneGangster(world, 3000, 2000);
  const owner = player(world, 7, 7500, 3800);
  const car = new Vehicle(9500, 'sedan', 3300, 2000, 0);
  Object.assign(car, { owner: owner.account, fuel: 100 });
  world.vehicles.set(car.id, car);
  const joy = config.gangsters.joyrideSec;
  config.gangsters.joyrideSec = [6, 6];
  try {
    run(world, 4);
    assert.equal(g.vehicle, car, 'in it');
    assert.ok(world.hires.events.some((e) => e.player === owner && e.kind === 'car_stolen'));
    const from = { x: car.x, y: car.y };
    run(world, 12);
    assert.equal(g.vehicle, null, 'dumped');
    assert.ok(Math.hypot(car.x - from.x, car.y - from.y) > 300, 'somewhere else');
    const dumped = world.hires.events.find((e) => e.player === owner && e.kind === 'car_dumped');
    assert.ok(dumped && Math.hypot(dumped.x - car.x, dumped.y - car.y) < 5, 'told where');
  } finally {
    config.gangsters.joyrideSec = joy;
  }
});

test('they buy all your vodka, at three times what it is worth', () => {
  const world = town();
  const g = oneGangster(world, 2000, 2000);
  const p = player(world, 1, 2060, 2000);
  p.cash = 0;
  hotbarOf(p).add('vodka', 2);
  hotbarOf(p).add('firewater', 1);
  assert.equal(world.hires.sellVodka(player(world, 2, 5000, 2000), g.id), 'too_far');
  const r = world.hires.sellVodka(p, g.id);
  assert.deepEqual(r.sold, { vodka: 2, firewater: 1 });
  assert.equal(p.cash, 2 * config.goods.vodka.base * 3 + config.goods.firewater.base * 3);
  assert.equal(hotbarOf(p).count('vodka'), 0);
  assert.equal(world.hires.sellVodka(p, g.id), 'no_vodka');
});

test('they go about on their own, not in pairs', () => {
  const world = town();
  const gs = gangsters(world);
  assert.ok(gs.length > 1);
  assert.ok(gs.every((g) => !g.partner), 'nobody has a mate');
});

test('the police and the gangsters leave each other be; goons and guards go for gangsters on sight', () => {
  const world = town();
  const g = oneGangster(world, 2000, 2000);
  assert.equal(world.police.crime(g, 'murder', true), false, 'no crime is ever theirs to answer for');
  assert.equal(g.wanted, 0);
  // A goon on a job near him opens fire.
  const boss = player(world, 5, 2300, 2000);
  boss.account.bank = 1e6;
  Object.assign(boss, { x: world.hires.bar ? world.hires.bar.npc.x : 2300 });
  const goon = { kind: 'hire', role: 'goon', id: 999, employer: boss.account, name: 'goon', x: 2200, y: 2000, angle: 0, health: 150, maxHealth: 150, radius: 18, weapon: 'rifle', fireCooldown: 0, ammo: 30, reload: 0, vehicle: null, alive: true, wanted: 0, lastSeen: 0, hidden: null, jailed: null, shotPolice: false, foes: new Map(), offline: 0, pick: null };
  world.hires.list.push(goon);
  Object.assign(boss, { x: 2250, y: 2000 });
  let shot = false;
  for (let i = 0; i < 30 * 2 && !shot; i++) {
    world.step(1 / 30);
    shot = [...world.bullets.values()].some((b) => b.owner === goon);
  }
  assert.ok(shot, 'the goon shoots at the gangster');
});

test('a stolen car that runs out of petrol is ditched where it stops', () => {
  const world = town();
  const g = oneGangster(world, 3000, 2000);
  const owner = player(world, 7, 7500, 3800);
  const car = new Vehicle(9501, 'sedan', 3300, 2000, 0);
  Object.assign(car, { owner: owner.account, fuel: 1.5 });
  world.vehicles.set(car.id, car);
  run(world, 4);
  assert.equal(g.vehicle, car, 'in it');
  run(world, 15);
  assert.equal(car.fuel, 0, 'ran dry');
  assert.equal(g.vehicle, null, 'ditched it');
  assert.ok(world.hires.events.some((e) => e.player === owner && e.kind === 'car_dumped'));
});

test('the barman sells vodka, dear', () => {
  const { map } = validateMap({ width: 4000, height: 3000, roads: [{ x: 0, y: 1400, w: 4000, h: 200 }], buildings: [{ type: 'bar', x: 500, y: 1000, rot: 0 }] });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  const p = player(world, 1, 3000, 2500);
  p.cash = 300;
  assert.equal(world.hires.buyVodka(p), 'too_far');
  const n = world.hires.bar.npc;
  Object.assign(p, { x: n.x, y: n.y + 50 });
  assert.equal(world.hires.buyVodka(p), null);
  assert.equal(p.cash, 300 - config.hires.barVodkaPrice);
  assert.equal(hotbarOf(p).count('vodka'), 1);
  assert.equal(world.hires.buyVodka(p), 'not_enough_cash');
  assert.ok(config.hires.barVodkaPrice > config.goods.vodka.base * config.gangsters.vodkaPrice, 'dearer than the gangsters pay (no easy money)');
});
