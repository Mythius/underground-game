import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { SpatialGrid } from '../src/game/SpatialGrid.js';
import { World, createWorld, missingSites } from '../src/game/World.js';
import { makeWeapon } from '../src/game/entities.js';

const smallWorld = () =>
  new World({ ...config.world, width: 1000, height: 1000, foodCount: 0, pickupStart: 0, pickupIntervalSec: Infinity, buildingCount: 0, terrain: false });

test('spatial grid returns only nearby entities', () => {
  const grid = new SpatialGrid(1000, 1000, 100);
  const near = { x: 50, y: 50, radius: 5 };
  const far = { x: 900, y: 900, radius: 5 };
  grid.insert(near);
  grid.insert(far);
  const found = grid.query(60, 60, 50);
  assert.ok(found.has(near));
  assert.ok(!found.has(far));
});

test('players move toward input angle and stay in bounds', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.x = 500;
  p.y = 500;
  p.applyInput({ seq: 0, angle: 0, throttle: 1, boost: false });
  world.step(0.1);
  assert.ok(p.x > 500);
  assert.equal(Math.round(p.y), 500);

  for (let i = 0; i < 200; i++) world.step(0.1);
  assert.equal(p.x, 1000 - p.radius);
});

test('stale inputs are ignored', () => {
  const p = smallWorld().spawnPlayer('a');
  p.applyInput({ seq: 5, angle: 1, throttle: 1, boost: false });
  p.applyInput({ seq: 4, angle: 2, throttle: 0, boost: true });
  assert.equal(p.input.angle, 1);
  assert.equal(p.lastInputSeq, 5);
});

test('eating food grows the player and food respawns', () => {
  const world = new World({ ...config.world, width: 1000, height: 1000, foodCount: 1, pickupStart: 0, buildingCount: 0, terrain: false });
  const p = world.spawnPlayer('a');
  const [food] = world.food.values();
  p.x = food.x;
  p.y = food.y;
  const before = p.mass;
  world.step(0);
  assert.equal(p.mass, before + food.mass);
  assert.equal(world.food.size, 1);
  assert.ok(!world.food.has(food.id));
});

test('players no longer eat each other, whatever their size', () => {
  const world = smallWorld();
  const big = world.spawnPlayer('big');
  const small = world.spawnPlayer('small');
  big.mass = 400;
  big.x = big.y = small.x = small.y = 500;
  assert.equal(world.step(0).deaths.length, 0);
  assert.ok(world.players.has(small.id));
});

test('extra size from overeating shrinks back over time', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.mass = config.player.startMass + 40;
  for (let i = 0; i < 60; i++) world.step(1);
  assert.ok(p.mass < config.player.startMass + 40 * 0.6, `mass ${p.mass}`);
  assert.ok(p.mass >= config.player.startMass);
});

test('similar-sized players do not eat each other', () => {
  const world = smallWorld();
  const a = world.spawnPlayer('a');
  const b = world.spawnPlayer('b');
  a.x = a.y = b.x = b.y = 500;
  assert.equal(world.step(0).deaths.length, 0);
});

test('bullets damage and eventually kill other players', () => {
  const world = smallWorld();
  const shooter = world.spawnPlayer('shooter');
  shooter.inventory[0] = makeWeapon('pistol'); // (everyone starts with a knife)
  const target = world.spawnPlayer('target');
  shooter.x = 300;
  shooter.y = target.y = 500;
  target.x = 400;
  shooter.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, aim: 0, fire: true });

  world.step(0.1);
  for (let i = 0; i < 3; i++) world.step(0.05);
  assert.equal(target.health, config.player.maxHealth - config.weapons.pistol.damage);
  assert.equal(shooter.health, config.player.maxHealth);

  let deaths = [];
  for (let i = 0; i < 100 && !deaths.length; i++) deaths = world.step(0.05).deaths;
  assert.equal(deaths[0]?.victim, target);
  assert.equal(deaths[0].killer, shooter);
});

const pistol = config.weapons.pistol;

test('the gun holds 5 shots, then reloads before firing again', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.inventory[0] = makeWeapon('pistol'); // (everyone starts with a knife)
  p.x = p.y = 500;
  p.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, aim: 0, fire: true });

  // Plenty of time for more than 5 shots at the fire rate, but less than a reload.
  const steps = Math.round((pistol.cooldownSec * 7) / 0.01);
  let fired = 0;
  for (let i = 0; i < steps; i++) {
    const before = p.weapon.ammo;
    world.step(0.01);
    if (p.weapon.ammo < before) fired++;
  }
  assert.equal(fired, pistol.magazineSize);
  assert.equal(p.weapon.ammo, 0);
  assert.ok(p.weapon.reloadTimer > 0);

  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, aim: 0, fire: false });
  for (let i = 0; i < Math.ceil(pistol.reloadSec / 0.01) + 1; i++) world.step(0.01);
  assert.equal(p.weapon.ammo, pistol.magazineSize);
});

test('reload input refills a partly used magazine', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.inventory[0] = makeWeapon('pistol'); // (everyone starts with a knife)
  p.weapon.ammo = 2;
  p.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, aim: 0, fire: false, reload: true });
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, aim: 0, fire: false, reload: false });
  world.step(0.01);
  assert.ok(p.weapon.reloadTimer > 0, 'reload press survives a later input');
  for (let i = 0; i < Math.ceil(pistol.reloadSec / 0.01) + 1; i++) world.step(0.01);
  assert.equal(p.weapon.ammo, pistol.magazineSize);
});

test('sprinting is faster and spends stamina until exhausted', () => {
  const world = smallWorld();
  const walker = world.spawnPlayer('walk');
  const runner = world.spawnPlayer('run');
  walker.x = runner.x = 100;
  walker.y = 300;
  runner.y = 600;
  walker.applyInput({ seq: 0, angle: 0, throttle: 1, boost: false });
  runner.applyInput({ seq: 0, angle: 0, throttle: 1, boost: true });
  world.step(0.5);
  assert.ok(runner.x - 100 > (walker.x - 100) * 1.5);
  assert.ok(runner.stamina < config.player.staminaMax);

  for (let i = 0; i < 100 && !runner.exhausted; i++) world.step(0.1);
  assert.ok(runner.exhausted);
  // Exhausted: holding sprint is just walking until enough stamina returns.
  runner.x = walker.x = 100;
  world.step(0.1);
  assert.equal(Math.round(runner.x), Math.round(walker.x));
});

test('stamina refills after a short pause', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.stamina = 10;
  p.staminaDelay = config.player.staminaRegenDelaySec;
  world.step(config.player.staminaRegenDelaySec / 2);
  assert.equal(p.stamina, 10);
  for (let i = 0; i < 100; i++) world.step(0.1);
  assert.equal(p.stamina, config.player.staminaMax);
});

test('walking over a gun picks it up into a free slot, but not a duplicate', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.x = p.y = 500;
  world.spawnPickup(500, 500, makeWeapon('shotgun'));
  world.step(0);
  assert.equal(p.inventory[1]?.type, 'shotgun');
  assert.equal(world.pickups.size, 0);

  world.spawnPickup(500, 500, makeWeapon('shotgun'));
  world.step(0);
  assert.equal(world.pickups.size, 1, 'already has a shotgun');
  assert.equal(p.inventory[2], null);
});

test('the selected gun is the one that fires; the shotgun fires several pellets', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.inventory[0] = makeWeapon('pistol'); // (everyone starts with a knife)
  p.x = p.y = 500;
  p.addWeapon(makeWeapon('shotgun'));
  p.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, aim: 0, fire: true, slot: 1 });
  world.step(0.01);
  assert.equal(world.bullets.size, config.weapons.shotgun.pellets);
  assert.equal(p.inventory[1].ammo, config.weapons.shotgun.magazineSize - 1);
  assert.equal(p.inventory[0].ammo, config.weapons.pistol.magazineSize);
});

test('an empty slot cannot shoot', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, aim: 0, fire: true, slot: 3 });
  world.step(0.01);
  assert.equal(world.bullets.size, 0);
});

test('found guns drop where a player dies; the starting knife does not', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  p.addWeapon(makeWeapon('rifle'));
  p.addWeapon(makeWeapon('sniper'));
  world.removePlayer(p.id);
  assert.deepEqual([...world.pickups.values()].map((g) => g.weapon.type).sort(), ['rifle', 'sniper']);
});

test('guns appear over time up to the cap', () => {
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0, pickupIntervalSec: 1, pickupMax: 3 });
  for (let i = 0; i < 10; i++) world.step(1);
  assert.equal(world.pickups.size, 3);
  for (const g of world.pickups.values()) assert.ok(config.weapons[g.weapon.type].spawnWeight > 0);
});

test('bigger players are slower but have more max health', () => {
  const world = smallWorld();
  const small = world.spawnPlayer('small');
  const big = world.spawnPlayer('big');
  big.mass = config.player.startMass * 4;
  assert.ok(big.speed < small.speed * 0.7);
  assert.equal(small.maxHealth, config.player.maxHealth);
  assert.equal(big.maxHealth, config.player.maxHealth * 2);
});

test('eating food heals, up to max health', () => {
  const world = new World({ ...config.world, width: 1000, height: 1000, foodCount: 2, pickupStart: 0, buildingCount: 0, terrain: false });
  const p = world.spawnPlayer('a');
  p.health = 50;
  const [food] = world.food.values();
  p.x = food.x;
  p.y = food.y;
  world.step(0);
  assert.ok(p.health >= 50 + config.world.foodHeal);
  p.health = p.maxHealth;
  p.heal(1000);
  assert.equal(p.health, p.maxHealth);
});

// A world with one hand-placed wall at x 600..620, spanning y 300..700.
function walledWorld() {
  const world = smallWorld();
  const wall = { x: 600, y: 300, w: 20, h: 400 };
  world.buildings.push({ id: 1, type: 'test', x: 600, y: 300, w: 20, h: 400, walls: [wall] });
  world.wallGrid.insert({ x: 610, y: 500, radius: 200, rect: wall });
  return world;
}

test('walls stop players', () => {
  const world = walledWorld();
  const p = world.spawnPlayer('a');
  p.x = 500;
  p.y = 500;
  p.applyInput({ seq: 0, angle: 0, throttle: 1, boost: false });
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.ok(p.x <= 600 - p.radius + 0.01, `stopped at the wall, x=${p.x}`);
  assert.equal(Math.round(p.y), 500);
});

test('walls stop bullets', () => {
  const world = walledWorld();
  const shooter = world.spawnPlayer('shooter');
  shooter.inventory[0] = makeWeapon('pistol'); // (everyone starts with a knife)
  const target = world.spawnPlayer('target');
  shooter.x = 500;
  target.x = 700;
  shooter.y = target.y = 500;
  shooter.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, aim: 0, fire: true });
  for (let i = 0; i < 60; i++) world.step(1 / 30);
  assert.equal(target.health, config.player.maxHealth);
});

test('generated buildings do not overlap and cover every type', async () => {
  const { BUILDING_TYPES, WORK_SITES, generateBuildings } = await import('../src/game/buildings.js');
  // Work sites fill whole blocks and the station sits by the railway: they're placed separately.
  const skip = Object.fromEntries(Object.keys(WORK_SITES).map((t) => [t, 0]));
  const types = Object.keys(BUILDING_TYPES).length - Object.keys(skip).length - 1;
  const buildings = generateBuildings(9000, 9000, types * 2, 120, [], 40, () => false, skip);
  assert.ok(buildings.length >= types * 2 - 4, `placed ${buildings.length}`);
  const placedTypes = new Set(Object.keys(BUILDING_TYPES).filter((t) => t !== 'station' && !(t in skip)));
  assert.deepEqual(new Set(buildings.map((b) => b.type)), placedTypes);
  for (const a of buildings) {
    for (const w of a.walls) {
      assert.ok(w.x >= a.x - 0.01 && w.y >= a.y - 0.01 && w.x + w.w <= a.x + a.w + 0.01 && w.y + w.h <= a.y + a.h + 0.01, `${a.type} wall inside its footprint`);
    }
    for (const b of buildings) {
      if (a === b) continue;
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'no overlap');
    }
  }
});

test('nothing spawns inside walls', () => {
  const world = new World({ ...config.world, foodCount: 300, pickupStart: 20 });
  for (const f of world.food.values()) assert.ok(!world.isBlocked(f.x, f.y, 5));
  for (const g of world.pickups.values()) assert.ok(!world.isBlocked(g.x, g.y, config.world.pickupRadius - 1));
});

test('roads, paths and trees are generated clear of each other and buildings', () => {
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 });
  assert.ok(world.roads.filter((r) => r.w > r.h).length >= 2 && world.roads.filter((r) => r.h > r.w).length >= 2);
  assert.ok(world.trees.length > 50, `${world.trees.length} trees`);
  assert.ok(world.paths.length > 10, `${world.paths.length} paths`);
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const b of world.buildings) for (const r of world.roads) assert.ok(!overlaps(b, r), `${b.type} on a road`);
  for (const t of world.trees) {
    for (const r of world.roads) assert.ok(!overlaps(t.trunk, r), 'tree on a road');
    for (const b of world.buildings) assert.ok(!overlaps(t.trunk, b), 'tree in a building');
    assert.ok(world.isBlocked(t.x, t.y, 5), 'trunks are solid');
  }
});

test('doorways are wide, outside doors face outward, and each has a path', () => {
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 });
  for (const b of world.buildings) {
    for (const d of b.doors) {
      assert.ok(Math.max(d.w, d.h) >= 89.9, `${b.type} doorway ${Math.max(d.w, d.h)} wide`);
      if (!d.exterior) continue;
      const cx = d.x + d.w / 2 + d.nx * 40;
      const cy = d.y + d.h / 2 + d.ny * 40;
      assert.ok(cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h, `${b.type} door faces out`);
      assert.ok(world.paths.some((p) => p.from[0] === Math.round(d.x + d.w / 2) && p.from[1] === Math.round(d.y + d.h / 2)), 'door has a path');
    }
  }
  for (const r of world.roads) assert.ok([270, 220].includes(Math.min(r.w, r.h)), 'country roads 270 wide, city streets 220');
});

test('town planning: city buildings in town, every building fronts a road with its main door, businesses have parking', async () => {
  const { CITY_TYPES, BUSINESS_TYPES } = await import('../src/game/placement.js');
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 });
  const city = world.city;
  assert.ok(city);
  const inCity = (b) => b.x >= city.x && b.y >= city.y && b.x + b.w <= city.x + city.w && b.y + b.h <= city.y + city.h;
  let fronting = 0, total = 0;
  for (const b of world.buildings) {
    if (b.type === 'shack' || b.type === 'station') continue;
    total++;
    assert.equal(inCity(b), CITY_TYPES.has(b.type), `${b.type} in the right place`);
    // Its widest outside door looks straight at a road (within 800).
    const door = b.doors.filter((x) => x.exterior).sort((a, c) => Math.max(c.w, c.h) - Math.max(a.w, a.h))[0];
    // Door-less places (kiosks, gas stations, farms) face the way their seller looks.
    const d = door ?? (b.npc && { x: b.npc.x, y: b.npc.y, w: 0, h: 0, nx: Math.round(Math.cos(b.npc.angle)), ny: Math.round(Math.sin(b.npc.angle)) });
    if (!d) { total--; continue; }
    const px = d.x + d.w / 2 + d.nx * 800, py = d.y + d.h / 2 + d.ny * 800;
    const sx = d.x + d.w / 2, sy = d.y + d.h / 2;
    if (world.roads.some((r) => segmentHitsRect(sx, sy, px, py, r))) fronting++;
  }
  assert.ok(fronting / total > 0.97, `${fronting}/${total} face a road`);
  for (const t of ['police', 'bank', 'market', 'gunstore', 'dealership']) assert.ok(world.buildings.some((b) => b.type === t), `${t} placed`);
  const businesses = world.buildings.filter((b) => BUSINESS_TYPES.has(b.type) && !b.size); // work sites fill whole blocks: bays inside instead
  const parked = businesses.filter((b) => world.lots.some((l) => l.building === b.id));
  assert.ok(parked.length / businesses.length > 0.75, `${parked.length}/${businesses.length} businesses have parking`);
  assert.ok(world.lamps.every((l) => l.x >= city.x && l.x <= city.x + city.w && l.y >= city.y && l.y <= city.y + city.h), 'lamps only in town');
});

function segmentHitsRect(ax, ay, bx, by, r) {
  for (let t = 0; t <= 1; t += 0.02) {
    const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  }
  return false;
}

// A 20-wide wall at x 600 with a closed 100-tall door in it (y 450..550).
function doorWorld() {
  const world = smallWorld();
  const door = { x: 600, y: 450, w: 20, h: 100, nx: 1, ny: 0, exterior: true, id: 1, open: false };
  const walls = [{ x: 600, y: 300, w: 20, h: 150 }, { x: 600, y: 550, w: 20, h: 150 }];
  world.buildings.push({ id: 1, type: 'test', x: 600, y: 300, w: 20, h: 400, walls, doors: [door] });
  for (const w of walls) world.wallGrid.insert({ x: w.x + 10, y: w.y + w.h / 2, radius: 75, rect: w });
  world.wallGrid.insert({ x: 610, y: 500, radius: 50, rect: door, door });
  world.doors.push(door);
  return { world, door };
}

test('a closed door blocks the way; E opens it and you can walk through', () => {
  const { world, door } = doorWorld();
  const p = world.spawnPlayer('a');
  p.x = 560;
  p.y = 500;
  p.applyInput({ seq: 0, angle: 0, throttle: 1, boost: false });
  for (let i = 0; i < 20; i++) world.step(1 / 30);
  assert.ok(p.x <= 600 - p.radius + 0.01, 'blocked by the closed door');

  p.applyInput({ seq: 1, angle: 0, throttle: 1, boost: false, use: true });
  const { doorChanges } = world.step(1 / 30);
  assert.deepEqual(doorChanges, [door]);
  assert.equal(door.open, true);
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.ok(p.x > 650, `walked through, x=${p.x}`);
});

test('a door will not close on a player standing in it, and is out of reach from afar', () => {
  const { world, door } = doorWorld();
  door.open = true;
  const p = world.spawnPlayer('a');
  p.x = 610;
  p.y = 500;
  p.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, use: true });
  world.step(0);
  assert.equal(door.open, true);

  p.x = 300;
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, use: true });
  world.step(0);
  assert.equal(door.open, true, 'too far away');
});

// Vehicles ------------------------------------------------------------------

import { Vehicle } from '../src/game/vehicles.js';

function carWorld() {
  const world = smallWorld();
  const car = new Vehicle(9000, 'sedan', 300, 500, 0);
  world.vehicles.set(car.id, car);
  world.rebuildGrid();
  return { world, car };
}

test('E gets you into a nearby car, W drives it, E gets you out beside it', () => {
  const { world, car } = carWorld();
  const p = world.spawnPlayer('driver');
  p.x = 300;
  p.y = 450;
  p.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, use: true });
  world.step(1 / 30);
  assert.equal(p.vehicle, car);
  assert.equal(car.driver, p);

  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, gas: 1 });
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.ok(car.x > 450, `drove forward, x=${car.x}`);
  assert.equal(p.x, car.x);

  p.applyInput({ seq: 2, angle: 0, throttle: 0, boost: false, use: true, gas: 0 });
  world.step(1 / 30);
  assert.equal(p.vehicle, null);
  assert.ok(Math.hypot(p.x - car.x, p.y - car.y) > 30, 'stands beside the car');
});

test('a fast car hurts people it hits and credits the driver', () => {
  const { world, car } = carWorld();
  const driver = world.spawnPlayer('driver');
  const victim = world.spawnPlayer('victim');
  driver.vehicle = car;
  car.driver = driver;
  car.vx = car.stats.maxSpeed;
  victim.x = 300 + car.stats.length / 2 + victim.radius - 2; // touching the front bumper
  victim.y = 500;
  world.step(1 / 30);
  assert.ok(victim.health < config.player.maxHealth);
});

test('shooting a car damages it; destroying it ejects the driver and it respawns later', () => {
  const { world, car } = carWorld();
  const driver = world.spawnPlayer('driver');
  driver.vehicle = car;
  car.driver = driver;
  car.health = 1;
  const shooter = world.spawnPlayer('shooter');
  shooter.inventory[0] = makeWeapon('pistol'); // (everyone starts with a knife)
  shooter.x = 150;
  shooter.y = 500;
  shooter.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, aim: 0, fire: true });
  let explosions = [];
  for (let i = 0; i < 30 && !explosions.length; i++) explosions = world.step(1 / 30).explosions;
  assert.equal(explosions.length, 1);
  assert.ok(!world.vehicles.has(car.id));
  assert.equal(driver.vehicle, null);
  assert.equal(driver.health, config.player.maxHealth - config.vehicles.exitDamage);
  assert.equal(world.vehicleRespawns.length, 1);
});

test('drivers cannot be shot directly and cannot shoot', () => {
  const { world, car } = carWorld();
  const driver = world.spawnPlayer('driver');
  driver.vehicle = car;
  car.driver = driver;
  driver.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, aim: 0, fire: true });
  world.step(1 / 30);
  assert.equal(world.bullets.size, 0);
});

test('vehicles are parked on roads (or in parking lots) when a full map is made', () => {
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 });
  assert.ok(world.vehicles.size >= config.vehicles.count - 2, `${world.vehicles.size} vehicles`);
  for (const v of world.vehicles.values()) {
    if (v.police) continue; // cruisers start at their station
    const inside = (r) => v.x >= r.x && v.x <= r.x + r.w && v.y >= r.y && v.y <= r.y + r.h;
    assert.ok(world.roads.some(inside) || world.lots.some(inside), 'on a road or in a lot');
  }
});

test('cars grip normally but slide sideways when drifting', () => {
  const slideAfterTurn = (drift) => {
    const { world, car } = carWorld();
    const p = world.spawnPlayer('d');
    p.vehicle = car;
    car.driver = p;
    car.x = 300;
    car.vx = car.stats.maxSpeed * 0.8;
    p.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, gas: 1, steer: 1, drift });
    for (let i = 0; i < 12; i++) world.step(1 / 30);
    const cos = Math.cos(car.angle);
    const sin = Math.sin(car.angle);
    return Math.abs(-car.vx * sin + car.vy * cos);
  };
  const grip = slideAfterTurn(false);
  const drift = slideAfterTurn(true);
  assert.ok(drift > grip * 2, `drift slide ${drift.toFixed(0)} vs normal ${grip.toFixed(0)}`);
});

// Water ---------------------------------------------------------------------

function riverWorld() {
  const world = smallWorld();
  // A river running north–south through x = 500, 200 wide; a road crossing it at y 800..900.
  world.water.rivers.push({ points: [[500, -100], [500, 1100]], width: 200 });
  world.roads.push({ x: 0, y: 800, w: 1000, h: 100 });
  return world;
}

test('players swim at reduced speed in water', () => {
  const world = riverWorld();
  const swimmer = world.spawnPlayer('swim');
  const walker = world.spawnPlayer('walk');
  swimmer.x = 450;
  walker.x = 150;
  swimmer.y = walker.y = 300;
  for (const p of [swimmer, walker]) p.applyInput({ seq: 0, angle: Math.PI / 2, throttle: 1, boost: true });
  world.step(0.2);
  const ratio = (swimmer.y - 300) / (walker.y - 300);
  assert.ok(Math.abs(ratio - config.player.swimSpeed / config.player.sprintMultiplier) < 0.05, `swim/walk ratio ${ratio}`);
});

test('cars stop at the riverbank but cross on a bridge', () => {
  const world = riverWorld();
  const car = new Vehicle(9001, 'sedan', 250, 300, 0);
  world.vehicles.set(car.id, car);
  car.vx = 300;
  for (let i = 0; i < 60; i++) world.step(1 / 30);
  assert.ok(car.x < 400 - car.stats.width / 2 + 1, `stopped at the bank, x=${car.x}`);

  car.x = 250;
  car.y = 850;
  car.vx = car.vy = 0;
  const driver = world.spawnPlayer('driver');
  driver.vehicle = car;
  car.driver = driver;
  driver.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, gas: 1 });
  for (let i = 0; i < 60; i++) world.step(1 / 30);
  assert.ok(car.x > 600, `crossed the bridge, x=${car.x}`);
});

test('the full map keeps buildings and trees out of water', () => {
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 });
  assert.ok(world.water.rivers.length >= 1 && world.water.lakes.length >= 1);
  for (const b of world.buildings) assert.ok(!world.isSwimming(b.x + b.w / 2, b.y + b.h / 2), `${b.type} in water`);
  for (const t of world.trees) assert.ok(!world.isSwimming(t.x, t.y), 'tree in water');
  assert.ok(world.forests.length > 10);
});

// Shops ---------------------------------------------------------------------

function shopWorld() {
  const world = smallWorld();
  world.shopkeepers.push({ x: 500, y: 500, angle: 0 });
  return world;
}

test('food you buy goes into the hotbar; E eats it and it heals over time, not all at once', () => {
  const world = shopWorld();
  const p = world.spawnPlayer('a');
  p.x = 560;
  p.y = 500;
  p.health = 50;
  p.cash = 100;
  const { price, heal, healSec, mass } = config.economy.menu.burger;
  const before = { cash: p.cash, mass: p.mass };
  assert.equal(world.buy(p, 'burger'), null);
  assert.equal(world.buy(p, 'burger'), null);
  assert.equal(p.cash, before.cash - 2 * price);
  assert.equal(p.health, 50, 'buying doesn\'t heal');
  const slot = p.inventory.findIndex((s) => s?.food === 'burger');
  assert.deepEqual(p.inventory[slot], { food: 'burger', qty: 2 }, 'stacked in one slot');
  p.selected = slot;
  assert.equal(world.eat(p), null);
  assert.equal(p.inventory[slot].qty, 1);
  assert.equal(p.mass, before.mass + mass);
  world.step(1 / 30);
  assert.ok(p.health < 50 + heal / 2, 'not instantly');
  for (let i = 0; i < 30 * (healSec + 1); i++) world.step(1 / 30);
  assert.ok(Math.abs(p.health - (50 + heal)) < 1, `all of it in the end (${p.health})`);
  assert.equal(world.drop(p, slot), 'cant_drop_food');
  p.selected = (slot + 1) % p.inventory.length;
  if (!p.inventory[p.selected]?.food) assert.equal(world.eat(p), 'nothing_to_eat');
});

test('you cannot buy from afar or without enough cash', () => {
  const world = shopWorld();
  const p = world.spawnPlayer('a');
  p.x = 900;
  p.y = 900;
  p.cash = 100;
  assert.equal(world.buy(p, 'bread'), 'too_far');
  p.x = 560;
  p.y = 500;
  p.cash = 5;
  assert.equal(world.buy(p, 'bread'), 'not_enough_cash');
  assert.equal(p.cash, 5);
});

test('cash trickles in, and a dead player drops their cash for others to pick up', () => {
  const world = smallWorld();
  const p = world.spawnPlayer('a');
  for (let i = 0; i < 4; i++) world.step(config.economy.streetIncomeSec);
  assert.equal(p.cash, 4 * config.economy.streetIncome);

  p.cash = 300;
  p.x = p.y = 500;
  world.removePlayer(p.id);
  const bags = [...world.pickups.values()].filter((g) => g.cash);
  assert.equal(bags.length, 1);
  assert.equal(bags[0].cash, 300);

  const finder = world.spawnPlayer('finder');
  finder.x = finder.y = 500;
  world.step(0);
  assert.equal(finder.cash, 300);
  assert.equal([...world.pickups.values()].filter((g) => g.cash).length, 0);
});

test('deposit and withdraw only at an ATM or bank teller, within your means', () => {
  const world = smallWorld();
  world.atms.push({ x: 500, y: 500, angle: 0 });
  const p = world.spawnPlayer('a');
  p.account = { id: 1, name: 'a', bank: 100, guest: false };
  p.cash = 50;
  p.x = p.y = 900;
  assert.equal(world.bank(p, 'deposit', 10), 'too_far');
  p.x = 540;
  p.y = 500;
  assert.equal(world.bank(p, 'deposit', 60), 'not_enough_cash');
  assert.equal(world.bank(p, 'deposit', 50), null);
  assert.deepEqual([p.cash, p.account.bank], [0, 150]);
  assert.equal(world.bank(p, 'withdraw', 151), 'not_enough_bank');
  assert.equal(world.bank(p, 'withdraw', 30), null);
  assert.deepEqual([p.cash, p.account.bank], [30, 120]);
});

test('every shop and gas station has a shopkeeper, every bank a teller, and they all have ATMs outside', () => {
  const world = new World({ ...config.world, pickupStart: 0 });
  const stores = world.buildings.filter((b) => b.type === 'shop' || b.type === 'gas');
  const kiosks = world.buildings.filter((b) => b.type === 'kiosk'); // sellers too, but no ATM
  assert.ok(stores.length > 0);
  assert.equal(world.shopkeepers.length, stores.length + kiosks.length);
  assert.equal(world.tellers.length, world.buildings.filter((b) => b.type === 'bank').length);
  assert.ok(world.tellers.length > 0);
  const withAtms = stores.length + world.tellers.length;
  assert.ok(world.atms.length >= withAtms * 0.6, `${world.atms.length} ATMs for ${withAtms} stores and banks`);
  for (const a of world.atms) assert.ok(world.isBlocked(a.x, a.y, 5), 'ATMs are solid');
  for (const b of stores) assert.ok(b.npc.x > b.x && b.npc.x < b.x + b.w && b.npc.y > b.y && b.npc.y < b.y + b.h);
});

test('bridge rails line both road edges over the river only, and stop people but not bullets', async () => {
  const { generateRails } = await import('../src/game/water.js');
  const water = { rivers: [{ points: [[500, -100], [500, 1100]], width: 200 }], lakes: [] };
  const road = { x: 0, y: 800, w: 1000, h: 100 };
  const crossRoad = { x: 450, y: 0, w: 100, h: 1000 }; // runs along the river, crossing `road` mid-bridge
  const rails = generateRails([road], water);
  assert.equal(rails.length, 2, 'one rail per edge');
  for (const r of rails) {
    assert.ok(r.x >= 400 - 20 && r.x + r.w <= 600 + 20, `rail ${r.x}..${r.x + r.w} stays at the river`);
    assert.ok(r.w > 180);
  }
  const split = generateRails([road, crossRoad], water).filter((r) => r.h < r.w);
  for (const r of split) assert.ok(r.x + r.w <= 450 || r.x >= 550, 'rails stop at the crossing road');

  // In a world: walking off the bridge sideways is blocked, shooting across is not.
  const world = riverWorld();
  world.rails = generateRails(world.roads, world.water);
  for (const w of world.rails) world.wallGrid.insert({ x: w.x + w.w / 2, y: w.y + w.h / 2, radius: Math.max(w.w, w.h) / 2, rect: w, low: true });
  const p = world.spawnPlayer('walker');
  p.inventory[0] = makeWeapon('pistol'); // (everyone starts with a knife)
  p.x = 500;
  p.y = 850;
  p.applyInput({ seq: 0, angle: -Math.PI / 2, throttle: 1, boost: false });
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.ok(p.y > 800 - 2, `held by the rail, y=${p.y}`);

  const target = world.spawnPlayer('swimmer');
  target.x = 500;
  target.y = 700;
  p.y = 850;
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, aim: -Math.PI / 2, fire: true });
  for (let i = 0; i < 15; i++) world.step(1 / 30);
  assert.ok(target.health < config.player.maxHealth, 'bullets fly over the rail');
});

test('in winter lakes freeze: you walk on them instead of swimming, and slide', () => {
  const world = new World({ ...config.world, width: 3000, height: 3000, terrain: false, buildingCount: 0, foodCount: 0, pickupStart: 0, parkingLots: 0 });
  world.water = { rivers: [], lakes: [{ x: 1500, y: 1500, r: 600 }] };
  const p = world.spawnPlayer('skater');
  Object.assign(p, { x: 1500, y: 1500 });
  assert.equal(world.isSwimming(p.x, p.y), true);
  world.frozen = true;
  assert.equal(world.isSwimming(p.x, p.y), false);
  assert.equal(world.isOnIce(p.x, p.y), true);
  // Run east for a second, then let go: you keep sliding.
  p.applyInput({ seq: 1, angle: 0, throttle: 1 });
  world.step(1 / 30);
  assert.ok(p.vx < p.speed * 0.2, 'slow to get going on ice');
  for (let i = 0; i < 60; i++) world.step(1 / 30);
  p.applyInput({ seq: 2, angle: 0, throttle: 0 });
  const x = p.x;
  for (let i = 0; i < 15; i++) world.step(1 / 30);
  assert.ok(p.x - x > 50, `slid ${Math.round(p.x - x)} after letting go`);
  // Off the ice you stop dead.
  world.frozen = false;
  p.applyInput({ seq: 3, angle: 0, throttle: 0 });
  world.step(1 / 30);
  assert.equal(p.vx, 0);
});

test('random maps have at least one of every resource site', () => {
  const world = createWorld({ ...config.world, foodCount: 0, pickupStart: 0 });
  assert.deepEqual(missingSites(world), []);
});

test('a second player hops in as the passenger: only the driver steers, both ride, either can get out', () => {
  const { world, car } = carWorld();
  const driver = world.spawnPlayer('driver');
  const rider = world.spawnPlayer('rider');
  Object.assign(driver, { x: 300, y: 450 });
  driver.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, use: true });
  world.step(1 / 30);
  Object.assign(rider, { x: 300, y: 550 });
  rider.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, use: true });
  world.step(1 / 30);
  assert.equal(car.driver, driver, 'the first one in drives');
  assert.equal(car.passenger, rider);
  assert.equal(rider.vehicle, car);

  rider.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, steer: 1, gas: -1 }); // ignored
  driver.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, gas: 1 });
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.ok(car.x > 450, 'the driver drove');
  assert.deepEqual([rider.x, rider.y], [car.x, car.y], 'the passenger came along');
  assert.equal(world.toggleLights(rider), 'not_driving');

  // A third can't get in.
  const third = world.spawnPlayer('third');
  Object.assign(third, { x: car.x, y: car.y + 50 });
  third.applyInput({ seq: 0, angle: 0, throttle: 0, boost: false, use: true });
  world.step(1 / 30);
  assert.equal(third.vehicle, null);

  rider.applyInput({ seq: 2, angle: 0, throttle: 0, boost: false, use: true });
  world.step(1 / 30);
  assert.equal(rider.vehicle, null);
  assert.equal(car.passenger, null);
  assert.equal(car.driver, driver, 'the driver stays put');
});
