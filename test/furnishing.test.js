import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { Vehicle } from '../src/game/vehicles.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)

config.player.healthRegenPerSec = 0;

// A house and a medium warehouse, each turned `rot` quarter turns.
function town(rot = 0) {
  const { map } = validateMap({
    width: 5000,
    height: 4000,
    buildings: [
      { type: 'house', x: 600, y: 600, rot },
      { type: 'warehouse', x: 2500, y: 600, rot },
    ],
  });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  world.police.witnessed = () => false;
  return world;
}

const account = (id) => ({ id, name: `p${id}`, bank: 1e6, guest: false });

/** A player for `acc` standing in the middle of their home. */
function atHome(world, acc) {
  const home = world.homes.assign(acc);
  const p = world.spawnPlayer(acc.name, null, acc);
  p.account = acc;
  Object.assign(p, world.homes.spawnPoint(home));
  return { p, home };
}

/** Try setting `kind` down facing each way in turn, from a few spots; the first that works. */
function placeSomewhere(world, p, kind, b, step = 30) {
  hotbarOf(p).add(kind, 1);
  p.selected = p.inventory.findIndex((s) => s?.good === kind);
  for (let y = b.y + 60; y < b.y + b.h - 60; y += step) {
    for (let x = b.x + 60; x < b.x + b.w - 60; x += step) {
      if (world.isBlocked(x, y, p.radius)) continue;
      Object.assign(p, { x, y });
      for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) if (world.furnishings.place(p, a) === null) return [...world.furnishings.items.values()].at(-1);
    }
  }
  return null;
}

test('a cabinet set down at home holds goods, food, guns and the rod; it has to be empty to pick up', () => {
  const world = town();
  const acc = account(1);
  const { p, home } = atHome(world, acc);
  hotbarOf(p).add('cabinet', 1);
  p.selected = p.inventory.findIndex((s) => s?.good === 'cabinet');
  p.x += 3000; // not at home: no
  assert.equal(world.furnishings.place(p, 0), 'not_your_place');
  const cab = placeSomewhere(world, p, 'cabinet', home);
  assert.ok(cab, 'placed');
  assert.equal(hotbarOf(p).count('cabinet'), 1, 'one used (the other is still in hand from the first try)');
  hotbarOf(p).add('cabinet', -1); // (room in the hotbar for what comes back out)
  assert.ok(cab.x > home.x && cab.x + cab.w < home.x + home.w, 'inside the house');
  Object.assign(p, { x: cab.x + cab.w / 2, y: cab.y + cab.h + p.radius + 10 });
  // Fill it from the hotbar, one thing at a time.
  const putIn = (make) => {
    const i = p.inventory.indexOf(null);
    make(i);
    assert.equal(world.furnishings.put(p, cab.id, i), null);
  };
  putIn(() => hotbarOf(p).add('planks', 4));
  putIn((i) => { p.inventory[i] = { ...world.makeWeapon('pistol'), ammo: 5 }; });
  putIn((i) => { p.inventory[i] = { type: 'rod', tool: true }; });
  putIn(() => world.addFood(p, 'burger', 2));
  const view = world.furnishings.contents(p, cab.id)[1].filter(Boolean);
  assert.deepEqual(view.map((s) => s[2] ?? 'goods').sort(), ['food', 'goods', 'gun', 'rod']);
  assert.ok(!p.inventory.some((s) => s?.type === 'rod' || s?.type === 'pistol' || s?.good === 'planks' || s?.food));
  assert.equal(world.furnishings.pickUp(p, cab.id), 'empty_it_first');
  // And back out.
  for (let i = 0; i < config.furnishing.cabinetSlots; i++) if (cab.slots[i]) assert.equal(world.furnishings.take(p, cab.id, i), null);
  assert.equal(p.inventory.find((s) => s?.type === 'pistol').ammo, 5);
  assert.ok(p.inventory.some((s) => s?.type === 'rod' && s.tool));
  assert.equal(hotbarOf(p).count('planks'), 4);
  hotbarOf(p).add('planks', -4); // (a free slot for the cabinet itself)
  assert.equal(world.furnishings.pickUp(p, cab.id), null);
  assert.equal(hotbarOf(p).count('cabinet'), 1);
  assert.equal(world.furnishings.items.size, 0);
});

test('up to three cabinets a building; beds and sofas too', () => {
  const world = town();
  const { p, home } = atHome(world, account(1));
  let n = 0;
  while (placeSomewhere(world, p, 'cabinet', home)) n++;
  assert.equal(n, 3, 'three fit in a house, and no more');
  hotbarOf(p).add('cabinet', 1);
  p.selected = p.inventory.findIndex((s) => s?.good === 'cabinet');
  assert.equal(world.furnishings.place(p, 0), 'too_many_here');
  assert.ok(placeSomewhere(world, p, 'bed', home, 10) || placeSomewhere(world, p, 'furniture', home, 10), 'a bed or a sofa fits too');
});

test("other people only get into your cabinet after a break-in", () => {
  const world = town();
  const owner = atHome(world, account(1));
  const cab = placeSomewhere(world, owner.p, 'cabinet', owner.home);
  hotbarOf(owner.p).add('logs', 2);
  Object.assign(owner.p, { x: cab.x + cab.w / 2, y: cab.y + cab.h + 30 });
  world.furnishings.put(owner.p, cab.id, owner.p.inventory.findIndex((s) => s?.good === 'logs'));
  const thief = world.spawnPlayer('thief');
  thief.account = account(2);
  Object.assign(thief, { x: owner.p.x, y: owner.p.y });
  assert.equal(world.furnishings.take(thief, cab.id, 0), 'locked');
  world.homes.unlock(owner.home.doors.find((d) => d.exterior));
  assert.equal(world.furnishings.take(thief, cab.id, 0), null);
  assert.equal(hotbarOf(thief).count('logs'), 2);
});

test('home furniture is saved with the account and comes back in a house facing another way', () => {
  const world = town(0);
  const acc = account(1);
  const { p, home } = atHome(world, acc);
  const cab = placeSomewhere(world, p, 'cabinet', home);
  Object.assign(p, { x: cab.x + cab.w / 2, y: cab.y + cab.h + 30 });
  hotbarOf(p).add('steel', 3);
  world.furnishings.put(p, cab.id, p.inventory.findIndex((s) => s?.good === 'steel'));
  const saved = JSON.parse(JSON.stringify(world.furnishings.saveHome(acc)));
  const rel = { x: cab.x - home.x, y: cab.y - home.y };
  for (const rot of [0, 1, 2]) {
    const next = town(rot);
    const again = atHome(next, acc);
    next.furnishings.restoreHome(acc, saved);
    const back = [...next.furnishings.items.values()][0];
    assert.ok(back, `rot ${rot}: placed`);
    assert.deepEqual(back.slots.filter(Boolean), [{ good: 'steel', qty: 3 }]);
    if (rot === 0) assert.deepEqual({ x: back.x - again.home.x, y: back.y - again.home.y }, rel, 'same spot');
    assert.ok(next.furnishings.fits(again.home, back, back), `rot ${rot}: inside the walls`);
    assert.equal(back.w === cab.w, rot % 2 === 0, 'turned with the house');
  }
});

test('warehouse furniture: not under machines, saved with the factory, and no selling it furnished', () => {
  const world = town();
  const acc = account(1);
  const p = world.spawnPlayer('boss', null, acc);
  p.account = acc;
  const wh = [...world.warehouses.all.values()][0];
  Object.assign(wh, { owner: acc, ownerId: acc.id });
  const cab = placeSomewhere(world, p, 'cabinet', wh.building);
  assert.ok(cab, 'placed in the warehouse');
  // No machine on top of it.
  const T = 40;
  const tx = Math.floor((cab.x + cab.w / 2 - wh.origin.x) / T), ty = Math.floor((cab.y + cab.h / 2 - wh.origin.y) / T);
  if (tx >= 0 && ty >= 0 && tx < wh.cols && ty < wh.rows) assert.equal(wh.canPlace('belt', tx, ty), false);
  const rows = world.warehouses.toSave();
  assert.equal(rows[0].data.furnishings.length, 1);
  Object.assign(p, wh.tileCenter(4, 2));
  assert.equal(world.warehouses.action(p, { id: wh.id, action: 'sell' }), 'remove_furniture_first');
  // Brought into a warehouse turned the other way after a restart: the cabinet comes too.
  const next = town(1);
  next.warehouses.stored = JSON.parse(JSON.stringify(rows));
  const p2 = next.spawnPlayer('boss', null, acc);
  p2.account = acc;
  const wh2 = [...next.warehouses.all.values()][0];
  Object.assign(p2, wh2.tileCenter(2, 2));
  assert.equal(next.warehouses.action(p2, { id: wh2.id, action: 'bring' }), null);
  assert.equal([...next.furnishings.items.values()].filter((it) => it.building === wh2.id).length, 1);
});

test('the fishing rod drops and picks up like a gun, and rides in a trunk', () => {
  const world = town();
  const p = world.spawnPlayer('angler');
  Object.assign(p, { x: 4000, y: 3000 });
  p.inventory[2] = { type: 'rod', tool: true };
  assert.equal(world.drop(p, 2), null);
  assert.equal(p.inventory[2], null);
  const other = world.spawnPlayer('finder');
  Object.assign(other, { x: 4000, y: 3000 });
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.ok(other.inventory.some((s) => s?.type === 'rod' && s.tool), 'picked up as a rod');
  const car = new Vehicle(9300, 'sedan', 4000, 2600, 0);
  world.vehicles.set(car.id, car);
  Object.assign(other, { vehicle: car, x: car.x, y: car.y });
  car.driver = other;
  const at = other.inventory.findIndex((s) => s?.type === 'rod');
  assert.equal(world.trunk(other, car.id, 'put', at), null);
  assert.deepEqual(car.cargo.find(Boolean), { type: 'rod' });
  assert.equal(world.trunk(other, car.id, 'take', car.cargo.findIndex(Boolean)), null);
  assert.ok(other.inventory.some((s) => s?.type === 'rod' && s.tool));
});

test('in a starter cabin, a bed picked up goes back down from where you stand (slid to the nearest spot that fits)', () => {
  const { map } = validateMap({ width: 3000, height: 3000, buildings: [{ type: 'cabin', x: 600, y: 600, rot: 0 }] });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  const acc = account(1);
  const { p, home } = atHome(world, acc);
  world.furnishings.restoreHome(acc, undefined);
  const bed = [...world.furnishings.items.values()].find((it) => it.kind === 'bed');
  Object.assign(p, { x: bed.x + bed.w / 2, y: bed.y + bed.h + 20 });
  assert.equal(world.furnishings.pickUp(p, bed.id), null);
  Object.assign(p, world.homes.spawnPoint(home));
  p.selected = p.inventory.findIndex((s) => s?.good === 'bed');
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    if (world.furnishings.place(p, a) === null) return;
  }
  assert.fail('the bed fits nowhere near');
});
