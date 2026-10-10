import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World, roughly } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';

// A bar and two starter houses along a road.
const MAP = {
  width: 4000,
  height: 3000,
  roads: [{ x: 0, y: 1400, w: 4000, h: 200 }],
  buildings: [
    { type: 'bar', x: 500, y: 1000, rot: 0 },
    { type: 'house', x: 1500, y: 1000, rot: 0 },
    { type: 'house', x: 2500, y: 1000, rot: 0 },
  ],
};

function town({ keepPeople = 0 } = {}) {
  const { map } = validateMap(MAP);
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = keepPeople;
  world.police.witnessed = () => false;
  world.police.policeSee = () => false;
  return world;
}

const account = (id, bank = 50000) => ({ id, name: `p${id}`, bank, guest: false });

/** A player for `acc`, standing at the barman. */
function atBar(world, acc) {
  world.homes.assign(acc);
  const p = world.spawnPlayer(acc.name, null, acc);
  p.account = acc;
  const n = world.hires.bar.npc;
  Object.assign(p, { x: n.x, y: n.y + 50 });
  return p;
}

const run = (world, sec) => {
  for (let i = 0; i < Math.round(sec * 30); i++) world.step(1 / 30);
};

test('the leaderboard ranks players by bank balance, rounded', () => {
  const world = town();
  const rich = atBar(world, account(1, 123456));
  atBar(world, account(2, 987));
  const poor = atBar(world, account(3, 40));
  const board = world.leaderboard();
  assert.deepEqual(board.map((e) => e.id), [rich.id, board[1].id, poor.id]);
  assert.deepEqual(board.map((e) => e.score), [120000, 990, 40]);
  assert.equal(roughly(12345), 12000);
});

test('hiring at the bar: fee from the bank, limits, and only near the barman', () => {
  const world = town();
  const acc = account(1);
  const p = atBar(world, acc);
  assert.equal(world.hires.hire(p, 'goon'), null);
  assert.equal(acc.bank, 50000 - config.hires.goon.fee);
  assert.equal(world.hires.hire(p, 'goon'), null);
  assert.equal(world.hires.hire(p, 'goon'), 'hire_limit', `max ${config.hires.goon.max} goons`);
  // A guard for my home (not someone else's).
  const home = world.homes.homeOf(acc);
  const other = world.buildings.find((b) => b.type === 'house' && b !== home);
  assert.equal(world.hires.hire(p, 'guard', { post: other.id }), 'not_your_building');
  assert.equal(world.hires.hire(p, 'guard', { post: home.id }), null);
  const guard = world.hires.list.find((h) => h.role === 'guard');
  assert.ok(guard.x > home.x && guard.x < home.x + home.w && guard.y > home.y && guard.y < home.y + home.h, 'posted inside');
  // Away from the bar: no deal.
  p.x += 2000;
  assert.equal(world.hires.hire(p, 'guard', { post: home.id }), 'too_far');
  const broke = atBar(world, account(2, 100));
  assert.equal(world.hires.hire(broke, 'goon'), 'not_enough_bank');
});

test('goons follow you and ride along in your car; wages come out every minute', () => {
  const world = town();
  const acc = account(1);
  const p = atBar(world, acc);
  world.hires.hire(p, 'goon');
  const goon = world.hires.list[0];
  // Walk off: the goon keeps up.
  Object.assign(p, { x: 1200, y: 1300 });
  run(world, 5);
  assert.ok(Math.hypot(goon.x - p.x, goon.y - p.y) < 200, `goon close (${Math.round(Math.hypot(goon.x - p.x, goon.y - p.y))})`);
  // Into a car: the goon gets in too, and out again with you.
  const car = world.spawnVehicle('sedan');
  Object.assign(car, { x: p.x + 100, y: 1500, vx: 0, vy: 0 });
  car.driver = p;
  p.vehicle = car;
  run(world, 3);
  assert.equal(goon.vehicle, car, 'riding along');
  car.driver = null;
  p.vehicle = null;
  run(world, 0.2);
  assert.equal(goon.vehicle, null, 'out with the boss');
  // Wages.
  const before = acc.bank;
  run(world, 61);
  assert.equal(acc.bank, before - config.hires.goon.wagePerMin);
  acc.bank = 0;
  run(world, 61);
  assert.equal(world.hires.list.length, 0, 'unpaid: they walk off');
});

test('guards shoot intruders; armour and healing make hires hard to kill', () => {
  const world = town();
  const acc = account(1);
  const p = atBar(world, acc);
  const home = world.homes.homeOf(acc);
  world.hires.hire(p, 'guard', { post: home.id });
  const guard = world.hires.list[0];
  const thief = atBar(world, account(2));
  const spot = world.homes.spawnPoint(home);
  Object.assign(thief, { x: spot.x + (guard.x > spot.x ? -60 : 60), y: spot.y });
  const hp = thief.health;
  run(world, 1);
  assert.ok(!thief.alive || thief.health < hp, 'the guard opened fire');
  // Armour halves the damage, and they heal back.
  guard.health = 100;
  world.hires.damage(guard, 40, null);
  assert.equal(guard.health, 100 - 40 * (1 - config.hires.armor));
  run(world, 2);
  assert.ok(guard.health > 80);
});

test('a hitman hunts his target; a failed contract refunds half', () => {
  const world = town();
  const acc = account(1);
  const p = atBar(world, acc);
  const target = atBar(world, account(2));
  Object.assign(target, { x: 3500, y: 1500 });
  assert.equal(world.hires.hire(p, 'hitman', { target: p.id }), 'no_target', 'not yourself');
  assert.equal(world.hires.hire(p, 'hitman', { target: target.id }), null);
  assert.equal(world.hires.hire(p, 'hitman', { target: target.id }), 'hire_limit');
  const hitman = world.hires.list[0];
  const warned = world.hires.events.some((e) => e.player === target && e.kind === 'contract_on_you');
  assert.ok(warned, 'the target is warned');
  assert.equal(hitman.weapon, 'sniper');
  assert.ok(hitman.car && hitman.vehicle === hitman.car, 'he starts in his own car');
  assert.ok(world.carLockedFor(hitman.car, p), 'locked to everyone');
  const start = Math.hypot(hitman.x - target.x, hitman.y - target.y);
  assert.ok(start >= 1600, 'parked well away');
  // He drives up, parks in range, gets out and snipes from a distance.
  let shotFrom = null;
  for (let i = 0; i < 30 * 30 && !shotFrom; i++) {
    world.step(1 / 30);
    if ([...world.bullets.values()].some((b) => b.owner === hitman)) shotFrom = Math.hypot(hitman.x - target.x, hitman.y - target.y);
  }
  assert.ok(shotFrom, 'he shot the target');
  assert.equal(hitman.vehicle, null, 'on foot to shoot');
  assert.ok(shotFrom > 400, `from a distance (${Math.round(shotFrom)})`);
  // Time's up without a kill: half back.
  const bank = acc.bank;
  const car = hitman.car;
  world.bullets.clear();
  target.health = target.maxHealth;
  hitman.until = world.hires.time;
  run(world, 0.1);
  assert.equal(world.hires.list.length, 0);
  assert.ok(!world.vehicles.has(car.id), 'his car goes with him');
  assert.equal(acc.bank, bank + config.hires.hitman.fee * config.hires.hitman.refundShare);
});

test("a goon's crime is theirs; the police can chase hires", () => {
  const world = town();
  const p = atBar(world, account(1));
  world.hires.hire(p, 'goon');
  const goon = world.hires.list[0];
  const realTrace = Math.random;
  Math.random = () => 0.99; // no witness ties it to the boss
  try {
    assert.ok(world.police.crime(goon, 'murder', true));
  } finally {
    Math.random = realTrace;
  }
  assert.equal(goon.wanted, config.crime.stars.murder);
  assert.equal(p.wanted, 0, 'not traced');
});

test('goons shoot whoever hurts the boss: a townsperson who swung at you, a player who shot you', () => {
  const world = town({ keepPeople: 1 });
  const p = atBar(world, account(1));
  assert.equal(world.hires.hire(p, 'goon'), null);
  Object.assign(p, { x: 1200, y: 1500 });
  const goon = world.hires.list[0];
  Object.assign(goon, { x: 1150, y: 1500 });
  // A townsperson lands a hit, then runs off: still fair game.
  const person = world.townsfolk.people[0];
  Object.assign(person, { x: 1300, y: 1500, inside: 0, fight: null });
  world.hires.noteAttack(person, p);
  let fired = false;
  for (let i = 0; i < 60 && !fired; i++) {
    world.step(1 / 30);
    fired = [...world.bullets.values()].some((b) => b.owner === goon);
  }
  assert.ok(fired, 'the goon opened fire on the townsperson');
  world.townsfolk.people.length = 0;
  world.bullets.clear();
  // Another player shoots the boss.
  const shooter = atBar(world, account(2));
  Object.assign(shooter, { x: 1350, y: 1500 });
  world.hires.noteAttack(shooter, p);
  fired = false;
  for (let i = 0; i < 60 && !fired; i++) {
    world.step(1 / 30);
    fired = [...world.bullets.values()].some((b) => b.owner === goon && Math.abs(Math.atan2(shooter.y - goon.y, shooter.x - goon.x) - goon.angle) < 0.3);
  }
  assert.ok(fired, 'the goon opened fire on the player');
});

test('goons go for whoever you attack or rob', () => {
  const world = town({ keepPeople: 1 });
  const p = atBar(world, account(1));
  assert.equal(world.hires.hire(p, 'goon'), null);
  Object.assign(p, { x: 1200, y: 1500 });
  const goon = world.hires.list[0];
  Object.assign(goon, { x: 1100, y: 1500 });
  const person = world.townsfolk.people[0];
  Object.assign(person, { x: 1240, y: 1500, angle: 0, inside: 0, fight: null, wallet: 100 });
  const res = world.police.pickpocket(p);
  assert.ok(res.unnoticed, `picked a pocket unnoticed (${JSON.stringify(res)})`);
  let fired = false;
  for (let i = 0; i < 60 && !fired; i++) {
    world.step(1 / 30);
    fired = [...world.bullets.values()].some((b) => b.owner === goon);
  }
  assert.ok(fired, 'the goon opened fire on the person you robbed');
});
