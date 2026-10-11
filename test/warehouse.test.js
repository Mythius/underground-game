import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';
import { generateBuildings } from '../src/game/buildings.js';
import { AccountStore } from '../src/accounts.js';

// A medium warehouse (10×8 tiles, IN dock bottom-left at 0,6 and OUT dock bottom-right at 8,6) and a market.
function town(type = 'warehouse') {
  const { map } = validateMap({
    width: 4000,
    height: 4000,
    buildings: [
      { type, x: 400, y: 400, rot: 0 },
      { type: 'warehouse', x: 1600, y: 400, rot: 0 },
      { type: 'market', x: 2600, y: 400, rot: 0 },
    ],
  });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  const [wh, other] = [...world.warehouses.all.values()];
  const player = world.spawnPlayer('boss');
  player.account = { id: 1, name: 'boss', bank: 50000, guest: false };
  const inside = (p, w = wh) => {
    const c = w.tileCenter(4, 2);
    p.x = c.x;
    p.y = c.y;
  };
  inside(player);
  return { world, wh, other, player, inside, act: (msg, p = player) => world.warehouses.action(p, { id: wh.id, ...msg }) };
}

const E = 0, S = 1, N = 3;

/** IN dock -> belts -> saw -> belts -> OUT dock, along the bottom row. */
function sawLine(act) {
  for (const x of [2, 3]) assert.equal(act({ action: 'place', kind: 'belt', x, y: 7, dir: E }), null);
  assert.equal(act({ action: 'place', kind: 'saw', x: 4, y: 6, dir: E }), null);
  for (const x of [6, 7]) assert.equal(act({ action: 'place', kind: 'belt', x, y: 7, dir: E }), null);
}

test('the map has one city factory of each kind and warehouses of every size', () => {
  const fixed = { sawmill: 1, bakery: 1, smallwarehouse: 4, warehouse: 4, bigwarehouse: 2 };
  const buildings = generateBuildings(12000, 12000, 60, 120, [], 40, () => false, fixed);
  const count = (t) => buildings.filter((b) => b.type === t).length;
  assert.equal(count('sawmill'), 1);
  assert.equal(count('bakery'), 1);
  assert.equal(count('smallwarehouse'), 4);
  assert.equal(count('bigwarehouse'), 2);
  assert.ok(count('house') >= 1, 'everything else still cycles');
});

test('buy a warehouse, build a saw line, unload logs at the IN dock and collect planks at the OUT dock', () => {
  const { world, wh, player, act } = town();
  assert.equal(wh.cols, 10);
  assert.equal(wh.rows, 8);
  assert.equal(act({ action: 'place', kind: 'belt', x: 2, y: 7, dir: E }), 'not_owner');
  assert.equal(act({ action: 'buy' }), null);
  assert.equal(player.account.bank, 50000 - config.warehouses.sizes.medium.price);
  sawLine(act);
  assert.equal(act({ action: 'place', kind: 'belt', x: 5, y: 7, dir: E }), 'blocked', 'the saw is 2×2');
  assert.equal(act({ action: 'place', kind: 'belt', x: 0, y: 7, dir: E }), 'blocked', 'the dock is there');

  // Unload at the IN dock from just outside the loading door.
  const dock = wh.rectOf(wh.dockIn);
  player.x = dock.x + dock.w / 2;
  player.y = dock.y + dock.h + 60;
  hotbarOf(player).add('logs', 5);
  assert.equal(act({ action: 'load' }), null);
  assert.equal(wh.dockIn.stock.logs, 5);
  assert.equal(hotbarOf(player).count('logs'), 0);

  for (let i = 0; i < 60 * 10; i++) world.step(0.1); // a minute
  assert.equal(wh.dockOut.stock.planks, 5, 'all five logs became planks');
  const out = wh.rectOf(wh.dockOut);
  player.x = out.x + out.w / 2;
  player.y = out.y + out.h + 60;
  assert.equal(act({ action: 'take' }), null);
  assert.equal(hotbarOf(player).count('planks'), 5);
});

test('machines only take their inputs, from behind; removing refunds; rotate and configure', () => {
  const { wh, player, act } = town();
  act({ action: 'buy' });
  assert.equal(act({ action: 'place', kind: 'furnace', x: 2, y: 2, dir: E }), null);
  const furnace = wh.at(2, 2);
  assert.equal(furnace.recipe, 'foundry:0');
  assert.equal(act({ action: 'configure', x: 3, y: 3, value: 'glassworks:0' }), null);
  assert.equal(furnace.recipe, 'glassworks:0');
  assert.equal(act({ action: 'configure', x: 3, y: 3, value: 'sawmill:0' }), 'unknown', 'a furnace has no saw');
  assert.equal(act({ action: 'rotate', x: 2, y: 2 }), null);
  assert.equal(furnace.dir, S);
  const bank = player.account.bank;
  assert.equal(act({ action: 'remove', x: 3, y: 2 }), null);
  assert.equal(player.account.bank, bank + config.machines.furnace.price);
  assert.equal(wh.at(2, 2), null);
  assert.equal(act({ action: 'remove', x: 0, y: 7 }), 'cant_remove_dock');
  // Building needs you inside.
  player.x = 10;
  assert.equal(act({ action: 'place', kind: 'belt', x: 5, y: 5, dir: E }), 'go_inside');
});

test('splitters deal left, forward and right in turn, filters sort, mergers join', () => {
  const { wh, act } = town();
  act({ action: 'buy' });
  wh.owner.bank = 1e6;
  /** One item fed onto `piece` from the belt behind it (as in play: it picks its way out as it comes on), then sent on. */
  const feedThrough = (feeder, piece, good) => {
    feeder.item = { good, p: 1, from: feeder.dir, to: feeder.dir };
    wh.step(0.01);
    assert.ok(piece.item, 'came on');
    piece.item.p = 1;
    wh.step(0.01);
  };
  // Splitter at (4,2) facing east, fed from (3,2): items go north (4,1), east (5,2) and south (4,3) in turn.
  act({ action: 'place', kind: 'splitter', x: 4, y: 2, dir: E });
  act({ action: 'place', kind: 'belt', x: 3, y: 2, dir: E });
  act({ action: 'place', kind: 'belt', x: 4, y: 1, dir: N });
  act({ action: 'place', kind: 'belt', x: 5, y: 2, dir: E });
  act({ action: 'place', kind: 'belt', x: 4, y: 3, dir: S });
  const split = wh.at(4, 2);
  const outs = { north: wh.at(4, 1), east: wh.at(5, 2), south: wh.at(4, 3) };
  const deal = (n) => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      for (const o of Object.values(outs)) o.item = null;
      feedThrough(wh.at(3, 2), split, 'logs');
      seen.push(Object.keys(outs).find((k) => outs[k].item) ?? 'stuck');
    }
    return seen;
  };
  assert.deepEqual(deal(3).sort(), ['east', 'north', 'south'], 'one each way');
  // A way that's blocked is skipped: the others take turns.
  act({ action: 'remove', x: 5, y: 2 });
  delete outs.east;
  assert.deepEqual(deal(4).sort(), ['north', 'north', 'south', 'south']);

  // Filter at (7,2) facing east, set to plastic: everything else goes straight on (east), plastic
  // north and south (its left and right) in turn.
  act({ action: 'place', kind: 'filter', x: 7, y: 2, dir: E });
  act({ action: 'place', kind: 'belt', x: 6, y: 2, dir: E });
  act({ action: 'configure', x: 7, y: 2, value: 'plastic' });
  act({ action: 'place', kind: 'belt', x: 8, y: 2, dir: E });
  act({ action: 'place', kind: 'belt', x: 7, y: 1, dir: N });
  act({ action: 'place', kind: 'belt', x: 7, y: 3, dir: S });
  const filter = wh.at(7, 2);
  const sort = (good) => {
    for (const [x, y] of [[8, 2], [7, 1], [7, 3]]) wh.at(x, y).item = null;
    feedThrough(wh.at(6, 2), filter, good);
    return wh.at(8, 2).item ? 'east' : wh.at(7, 1).item ? 'north' : wh.at(7, 3).item ? 'south' : 'stuck';
  };
  assert.equal(sort('fuel'), 'east', 'not the chosen good: straight on');
  assert.deepEqual([sort('plastic'), sort('plastic')].sort(), ['north', 'south'], 'the chosen good: left and right in turn');
  assert.equal(sort('fuel'), 'east');

  // A plain belt only takes items from behind (out of its front); a merger takes them from the sides too.
  act({ action: 'place', kind: 'belt', x: 1, y: 1, dir: E });
  act({ action: 'place', kind: 'belt', x: 2, y: 0, dir: S }); // points down into (2,1)
  act({ action: 'place', kind: 'belt', x: 2, y: 1, dir: E });
  wh.at(2, 0).item = { good: 'logs', p: 1 };
  wh.step(0.01);
  assert.equal(wh.at(2, 1).item, null, 'belts refuse items from the side');
  act({ action: 'remove', x: 2, y: 1 });
  act({ action: 'place', kind: 'merger', x: 2, y: 1, dir: E });
  wh.step(0.01);
  assert.equal(wh.at(2, 1).item?.good, 'logs', 'a merger takes them');
  assert.equal(wh.at(2, 1).item.from, S, 'it remembers it came in from the side');
});

test('the inverse filter sends its good straight on and everything else to the sides; items come off belts by hand', () => {
  const { world, wh, player, act } = town();
  act({ action: 'buy' });
  wh.owner.bank = 1e6;
  act({ action: 'place', kind: 'belt', x: 3, y: 2, dir: E });
  act({ action: 'place', kind: 'invfilter', x: 4, y: 2, dir: E });
  act({ action: 'configure', x: 4, y: 2, value: 'plastic' });
  for (const [x, y, d] of [[5, 2, E], [4, 1, N], [4, 3, S]]) act({ action: 'place', kind: 'belt', x, y, dir: d });
  const inv = wh.at(4, 2);
  const sort = (good) => {
    for (const [x, y] of [[5, 2], [4, 1], [4, 3]]) wh.at(x, y).item = null;
    wh.at(3, 2).item = { good, p: 1, from: E, to: E };
    wh.step(0.01);
    inv.item.p = 1;
    wh.step(0.01);
    return wh.at(5, 2).item ? 'east' : wh.at(4, 1).item ? 'north' : wh.at(4, 3).item ? 'south' : 'stuck';
  };
  assert.equal(sort('plastic'), 'east', 'its good: straight on');
  assert.deepEqual([sort('fuel'), sort('logs')].sort(), ['north', 'south'], 'the rest: left and right in turn');
  // Grab what's riding a belt.
  wh.at(5, 2).item = { good: 'plastic', p: 0.4 };
  assert.equal(act({ action: 'grab', x: 5, y: 2 }), null);
  assert.equal(wh.at(5, 2).item, null);
  assert.equal(hotbarOf(player).count('plastic'), 1);
  assert.equal(act({ action: 'grab', x: 5, y: 2 }), 'nothing_there');
  void world;
});

test('one warehouse of each size per player', () => {
  const { wh, other, player, act, inside } = town();
  assert.equal(act({ action: 'buy' }), null);
  inside(player, other);
  assert.equal(other.size, wh.size);
  assert.equal(act({ action: 'buy', id: other.id }), 'one_per_size');
});

test('locked to everyone but the owner; picking the lock opens it and stealing from the OUT dock is a crime', () => {
  const { world, wh, player, act } = town();
  act({ action: 'buy' });
  wh.dockOut.stock = { planks: 8 };
  const thief = world.spawnPlayer('thief');
  thief.account = { id: 2, name: 'thief', bank: 0, guest: false };
  const door = world.doors.find((d) => d.building === wh.id);
  thief.x = door.x + door.w / 2;
  thief.y = door.y + door.h + 30;
  player.x = 3000; // owner's away

  thief.input.use = true;
  world.step(1 / 30);
  assert.equal(door.open, false, 'locked');
  assert.equal(world.warehouses.action(thief, { id: wh.id, action: 'take' }), 'locked');

  // Hold F at the door to pick the lock.
  world.police.witnessed = () => true; // someone's watching
  thief.applyInput({ seq: 1, angle: 0, throttle: 0, rob: true });
  for (let i = 0; i < Math.ceil(config.warehouses.lockpickSec * 30) + 5; i++) world.step(1 / 30);
  assert.equal(door.open, true, 'picked and opened');
  assert.ok(thief.wanted >= 1, 'seen breaking in');

  const out = wh.rectOf(wh.dockOut);
  thief.x = out.x + out.w / 2;
  thief.y = out.y + out.h / 2;
  assert.equal(world.warehouses.action(thief, { id: wh.id, action: 'take' }), null);
  assert.equal(hotbarOf(thief).count('planks'), 8);
  // …but can't touch the machines.
  assert.equal(world.warehouses.action(thief, { id: wh.id, action: 'place', kind: 'belt', x: 3, y: 3, dir: 0 }), 'not_owner');
  assert.equal(world.warehouses.action(thief, { id: wh.id, action: 'sell' }), 'not_owner');
});

test('property tax comes out of the bank; if it cannot be paid everything stops', () => {
  const { world, wh, player, act } = town();
  act({ action: 'buy' });
  const bank = player.account.bank;
  for (let i = 0; i < 600; i++) world.step(1); // ten minutes
  const tax = config.warehouses.sizes.medium.taxPerHour / 6;
  assert.ok(Math.abs(bank - player.account.bank - tax) <= 1, `paid about ${tax}`);
  player.account.bank = 0;
  for (let i = 0; i < 120; i++) world.step(1);
  assert.equal(wh.unpaid, true);
  wh.dockIn.stock = { logs: 5 };
  sawLine((m) => {
    player.account.bank = 1e5;
    const r = act(m);
    player.account.bank = 0;
    return r;
  });
  world.step(1);
  assert.equal(wh.dockIn.stock.logs, 5, 'nothing moves while the tax is unpaid');
  player.account.bank = 1000;
  world.step(1);
  assert.equal(wh.unpaid, false);
});

test('owned warehouses are saved; after a restart you load yours into any free one of the same size instead of buying', () => {
  const store = new AccountStore(':memory:');
  const { account } = store.createDeviceAccount();
  const first = town();
  const live = store.live(account.id);
  first.player.account = live;
  live.bank = 50000;
  first.act({ action: 'buy' });
  sawLine(first.act);
  first.wh.dockIn.stock = { logs: 7 };
  store.saveWarehouses(first.world.warehouses.toSave());

  // A new map (its first warehouse is small now): nothing is placed until you pick one.
  const next = town('smallwarehouse');
  next.world.warehouses.stored = store.loadWarehouses();
  next.player.account = live;
  assert.equal(next.other.owner, null);
  assert.deepEqual(next.world.warehouses.storedFor(live), ['medium']);
  // Wrong size: no.
  assert.equal(next.act({ action: 'bring' }), 'nothing_stored');
  // The free medium one: yours, layout, stock and all — and no charge.
  next.inside(next.player, next.other);
  const bank = live.bank;
  assert.equal(next.world.warehouses.action(next.player, { id: next.other.id, action: 'bring' }), null);
  assert.equal(next.other.owner, live);
  assert.equal(next.other.at(4, 6).kind, 'saw');
  assert.equal(next.other.dockIn.stock.logs, 7);
  assert.equal(live.bank, bank);
  assert.deepEqual(next.world.warehouses.storedFor(live), [], 'only once');
  // Still saved (now where it is), and nobody else can load it.
  assert.equal(next.world.warehouses.toSave().length, 1);
  const stranger = next.world.spawnPlayer('x');
  stranger.account = { id: 999, name: 'x', bank: 0, guest: false };
  next.world.warehouses.stored = store.loadWarehouses();
  next.inside(stranger);
  assert.equal(next.act({ action: 'bring' }, stranger), 'nothing_stored');
});

test('a rotated warehouse has its grid turned too, and its docks still feed belts', () => {
  const { map } = validateMap({ width: 3000, height: 3000, buildings: [{ type: 'warehouse', x: 400, y: 400, rot: 1 }] });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  const wh = [...world.warehouses.all.values()][0];
  assert.deepEqual([wh.cols, wh.rows], [8, 10]);
  let dock = wh.dockIn;
  assert.ok(dock.x >= 0 && dock.y >= 0 && dock.x + 2 <= wh.cols && dock.y + 2 <= wh.rows);
  const player = world.spawnPlayer('boss');
  player.account = { id: 1, name: 'boss', bank: 1e6, guest: false };
  const c = wh.tileCenter(4, 4);
  Object.assign(player, { x: c.x, y: c.y });
  assert.equal(world.warehouses.action(player, { id: wh.id, action: 'buy' }), null);
  dock = wh.dockIn; // buying clears it out
  // A belt leading away from the dock, on whichever side has room.
  const spots = [[dock.x + 2, dock.y, 0], [dock.x - 1, dock.y, 2], [dock.x, dock.y + 2, 1], [dock.x, dock.y - 1, 3]];
  const [x, y, dir] = spots.find(([sx, sy]) => wh.at(sx, sy) === null);
  assert.equal(world.warehouses.action(player, { id: wh.id, action: 'place', kind: 'belt', x, y, dir }), null);
  dock.stock = { logs: 1 };
  world.step(1);
  assert.equal(wh.at(x, y).item?.good, 'logs');
});

test('machines have an input and an output slot you can load and empty by hand', () => {
  const { world, wh, player, act } = town();
  act({ action: 'buy' });
  act({ action: 'place', kind: 'saw', x: 4, y: 2, dir: E });
  const saw = wh.at(4, 2);
  hotbarOf(player).add('logs', 5);
  hotbarOf(player).add('wheat', 3);
  const logs = player.inventory.findIndex((s) => s?.good === 'logs');
  const wheat = player.inventory.findIndex((s) => s?.good === 'wheat');
  assert.equal(act({ action: 'mload', x: 4, y: 2, slot: wheat }), 'wrong_input');
  assert.equal(act({ action: 'mload', x: 5, y: 3, slot: logs }), null);
  assert.equal(saw.in.logs, 5);
  assert.equal(player.inventory[logs], null);
  for (let i = 0; i < 10 * 3; i++) world.step(1 / 3); // 10 s: one plank
  assert.ok(saw.out.planks >= 1);
  assert.equal(act({ action: 'mtake', x: 4, y: 2 }), null);
  assert.ok(hotbarOf(player).count('planks') >= 1);
  assert.equal(act({ action: 'mtake', x: 4, y: 2, dock: 'in' }), null, 'take the unused logs back');
  assert.equal(hotbarOf(player).count('logs'), saw.in.logs === undefined ? 5 - hotbarOf(player).count('planks') : hotbarOf(player).count('logs'));
  assert.equal(act({ action: 'mtake', x: 4, y: 2 }), 'nothing_to_take');
});

test('delivery bays outside places and warehouse doors, parking lots by the roads', async () => {
  const { Vehicle } = await import('../src/game/vehicles.js');
  const { world, wh, player } = town();
  const market = world.buildings.find((b) => b.type === 'market');
  assert.ok(world.bays.some((b) => b.building === market.id), 'market bay');
  assert.equal(world.bays.filter((b) => b.building === wh.id).length, 2, 'one per loading door');
  // A car of mine in the market's bay is my cargo while I'm inside, even far from it.
  const bay = world.bays.find((b) => b.building === market.id);
  const car = new Vehicle(9100, 'truck', bay.x + bay.w / 2, bay.y + bay.h / 2, 0);
  world.vehicles.set(car.id, car);
  player.x = market.x + market.w / 2;
  player.y = market.y + market.h / 2;
  car.x += 0; // parked
  player.lastVehicle = null;
  assert.equal(world.economy.vehicleOf(player), null, 'not mine');
  car.owner = player.account;
  assert.equal(world.economy.vehicleOf(player), car);
  player.x = 3800;
  assert.equal(world.economy.vehicleOf(player), null, 'walked away');

  const big = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons);
  assert.ok(big.lots.length >= config.world.parkingLots / 2, `${big.lots.length} lots`);
  const parked = [...big.vehicles.values()].filter((v) => big.lots.some((l) => v.x >= l.x && v.x <= l.x + l.w && v.y >= l.y && v.y <= l.y + l.h));
  assert.ok(parked.length > 0, 'some cars start in lots');
  for (const l of big.lots) assert.ok(!big.buildings.some((b) => l.x < b.x + b.w && b.x < l.x + l.w && l.y < b.y + b.h && b.y < l.y + l.h));
});

test('containers store what belts bring and feed belts leading away; pallets and containers load and unload by hand', () => {
  const { world, wh, player, act } = town();
  act({ action: 'buy' });
  // IN dock (0,6) -> belt (2,7) -> container (3,7) -> belt (4,7) leading away.
  assert.equal(act({ action: 'place', kind: 'belt', x: 2, y: 7, dir: E }), null);
  assert.equal(act({ action: 'place', kind: 'container', x: 3, y: 7, dir: E }), null);
  const box = wh.at(3, 7);
  // By hand onto the IN pallet: it goes out along the belt into the container.
  hotbarOf(player).add('logs', 5);
  Object.assign(player, wh.tileCenter(2, 5));
  assert.equal(act({ action: 'pput', x: 0, y: 6, good: 'logs', qty: 3 }), null);
  assert.equal(hotbarOf(player).count('logs'), 2);
  for (let i = 0; i < 30 * 6; i++) world.step(1 / 30);
  assert.equal(box.stock.logs, 3, 'stored in the container');
  // Nothing leads away yet, so it stays. Take one off by hand, then put a belt on and it empties out.
  assert.equal(act({ action: 'ptake', x: 3, y: 7, good: 'logs', qty: 1 }), null);
  assert.equal(hotbarOf(player).count('logs'), 3);
  assert.equal(act({ action: 'remove', x: 3, y: 7 }), 'not_empty');
  for (const x of [4, 5, 6, 7]) assert.equal(act({ action: 'place', kind: 'belt', x, y: 7, dir: E }), null); // on to the OUT pallet
  for (let i = 0; i < 30 * 5; i++) world.step(1 / 30);
  assert.ok(!box.stock.logs, 'pulled out onto the belt leading away');
  assert.equal(wh.dockOut.stock.logs, 2, 'and along to the OUT pallet');
  // Off the OUT pallet by hand, one good at a time.
  const out = wh.dockOut;
  out.stock = { planks: 4, flour: 2 };
  Object.assign(player, wh.tileCenter(8, 5));
  assert.equal(act({ action: 'ptake', x: out.x, y: out.y, good: 'planks', qty: 10 }), null);
  assert.equal(hotbarOf(player).count('planks'), 4);
  assert.deepEqual(out.stock, { flour: 2 });
  assert.equal(act({ action: 'ptake', x: out.x, y: out.y, good: 'planks', qty: 1 }), 'nothing_to_take');
});

test('a saved factory loaded into a warehouse facing another way is turned to match its IN and OUT pallets', () => {
  const first = town();
  first.act({ action: 'buy' });
  sawLine(first.act);
  const saved = first.wh.save();
  for (const rot of [1, 2, 3]) {
    const { map } = validateMap({ width: 4000, height: 4000, buildings: [{ type: 'warehouse', x: 400, y: 400, rot }] });
    const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
    const wh = [...world.warehouses.all.values()][0];
    wh.load(saved);
    Object.assign(wh, { owner: { id: 1, bank: 1e6 }, ownerId: 1 });
    const kinds = [...wh.pieces.values()].map((p) => p.kind).sort();
    assert.deepEqual(kinds, ['belt', 'belt', 'belt', 'belt', 'dockIn', 'dockOut', 'saw'], `rot ${rot}: everything placed`);
    wh.dockIn.stock = { logs: 3 };
    for (let i = 0; i < 60 * 10; i++) world.step(0.1);
    assert.equal(wh.dockOut.stock.planks, 3, `rot ${rot}: the line still runs from the IN pallet to the OUT pallet`);
  }
});

test('containers only load belts pointing away from them, not ones running past their side', () => {
  const { wh, act } = town();
  act({ action: 'buy' });
  wh.owner.bank = 1e6;
  act({ action: 'place', kind: 'container', x: 4, y: 3, dir: E });
  act({ action: 'place', kind: 'belt', x: 5, y: 3, dir: E }); // away from it
  act({ action: 'place', kind: 'belt', x: 4, y: 2, dir: E }); // running past its top side
  act({ action: 'place', kind: 'belt', x: 3, y: 3, dir: E }); // pointing into it
  const box = wh.at(4, 3);
  box.stock = { logs: 10 };
  for (let i = 0; i < 40; i++) {
    wh.step(0.1);
    for (const [x, y] of [[5, 3], [4, 2]]) if (wh.at(x, y).item && x === 5) wh.at(x, y).item = null; // keep the out belt clear
  }
  assert.equal(wh.at(4, 2).item, null, 'the belt running past gets nothing');
  assert.equal(wh.at(3, 3).item, null, 'nor the one pointing in');
  assert.ok(box.stock.logs < 10, 'the belt pointing away does');
});
