import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

function site(type) {
  const { map, error } = validateMap({
    width: 6000, height: 6000,
    buildings: [{ type, x: 1000, y: 1000, rot: 0, size: { w: 1600, h: 1600 } }],
  });
  assert.equal(error, undefined);
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0, parkingLots: 0 }, config.player, config.weapons, map);
  const b = world.buildings[0];
  const p = world.spawnPlayer('worker');
  p.account = { id: 1, name: 'worker', bank: 100000, guest: false };
  p.cash = 0;
  Object.assign(p, { x: b.npc.x, y: b.npc.y - 50 });
  world.police.witnessed = () => false;
  return { world, b, p, act: (action) => world.economy.workAction(p, b.id, action) };
}

/** Stand next to a node, aim at it and swing until it's worked out. */
function workOut(world, p, node) {
  Object.assign(p, { x: node.x - node.r - p.radius - 10, y: node.y });
  p.applyInput({ seq: 1, angle: 0, throttle: 0, aim: 0, fire: true });
  for (let i = 0; i < 30 * config.work.swingSec * (node.max + 1) && node.hp > 0; i++) world.step(1 / 30);
  p.applyInput({ seq: 2, angle: 0, throttle: 0, aim: 0, fire: false });
}

test('the mine fills its block with rocks and ore veins; borrow a pickaxe, mine, and sell the ore to the foreman', () => {
  const { world, b, p, act } = site('mine');
  const nodes = [...world.work.nodes.values()];
  assert.ok(nodes.length > 100, `${nodes.length} rocks`);
  assert.ok(nodes.some((n) => n.kind === 'vein') && nodes.some((n) => n.kind === 'rock'));
  assert.ok(nodes.every((n) => n.x > b.x && n.x < b.x + b.w && n.y > b.y && n.y < b.y + b.h), 'inside the site');
  assert.deepEqual(act('tool'), { borrowed: 'pickaxe' });
  assert.equal(p.tool.type, 'pickaxe');
  assert.equal(p.weapon, null, 'a pickaxe is not a gun');
  const rock = nodes.find((n) => n.kind === 'vein');
  workOut(world, p, rock);
  assert.equal(rock.hp, 0, 'worked out');
  assert.equal(hotbarOf(p).count('ore'), config.work.yield.vein.ore);
  assert.equal(world.drop(p, p.selected), 'cant_drop_tool');
  Object.assign(p, { x: b.npc.x, y: b.npc.y - 50 });
  const ore = hotbarOf(p).count('ore');
  assert.deepEqual(act('haul'), { qty: ore, paid: ore * world.work.wage('ore') });
  assert.equal(p.cash, ore * Math.round(config.goods.ore.base * config.work.wageShare));
  assert.equal(act('haul'), 'nothing_to_sell');
  // It grows back.
  for (let i = 0; i < config.work.regrowSec.vein + 2; i++) world.step(1);
  assert.equal(rock.hp, rock.max);
});

test('trees at the lumberyard, wheat on the farm; the tool goes back if you walk off the site', () => {
  for (const [type, kind, good] of [['logging', 'tree', 'logs'], ['farm', 'wheat', 'wheat']]) {
    const { world, b, p, act } = site(type);
    act('tool');
    const node = [...world.work.nodes.values()].find((n) => n.kind === kind);
    workOut(world, p, node);
    assert.equal(hotbarOf(p).count(good), config.work.yield[kind][good], `${type}: gathered`);
    p.x = b.x + b.w + config.work.leaveRange + 100;
    world.step(1.1);
    assert.equal(p.tool, null, `${type}: tool returned`);
    assert.ok(!p.inventory.some((s) => s?.tool));
  }
});

test('buying a site: the owner pays the wages and takes the sales; anyone can still work it', () => {
  const { world, p, act } = site('farm');
  assert.deepEqual(act('buy'), { bought: 'farm' });
  assert.equal(p.account.bank, 100000 - config.work.prices.farm);
  const market = world.economy.markets.get(world.buildings[0].id);
  assert.equal(market.owner, p.account);
  // Another worker sells wheat: paid by the owner.
  const other = world.spawnPlayer('hand');
  Object.assign(other, { x: p.x, y: p.y, cash: 0 });
  hotbarOf(other).add('wheat', 10);
  const bank = p.account.bank;
  assert.deepEqual(world.economy.workAction(other, market.id, 'haul'), { qty: 10, paid: 10 * world.work.wage('wheat') });
  assert.equal(p.account.bank, bank - 10 * world.work.wage('wheat'));
  // Someone buys wheat from the farm: the owner gets it.
  other.cash = 10000;
  const before = p.account.bank;
  assert.equal(world.economy.trade(other, market.id, 'wheat', 5, 'buy'), null);
  assert.ok(p.account.bank > before);
});
