import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

config.gangsters.count = 0;

function yard() {
  const { map, error } = validateMap({ width: 4000, height: 4000, buildings: [{ type: 'house', x: 1800, y: 1800, rot: 0 }] });
  assert.equal(error, undefined);
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0, parkingLots: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  world.cats.list.length = 0;
  const cat = { id: 1, x: 1000, y: 1000, angle: 0, look: 0, home: { x: 1000, y: 1000 }, move: 0, friend: null, friendUntil: 0, heldBy: null, heldUntil: 0, pettedAt: -Infinity, wander: null };
  world.cats.list.push(cat);
  const p = world.spawnPlayer('catlady');
  Object.assign(p, { x: 1000, y: 1060 });
  p.inventory.fill(null);
  return { world, cats: world.cats, cat, p };
}

const fishInHand = (p, qty = 1) => { p.inventory[0] = { good: 'fish', qty }; p.selected = 0; };

test('a score of strays round town on a full map', () => {
  const world = new World();
  assert.equal(world.cats.list.length, config.cats.count);
  assert.ok(world.cats.list.every((c) => !world.isBlocked(c.x, c.y, config.cats.radius)));
});

test('a stray keeps away from strangers — unless they have a fish', () => {
  const { world, cat, p } = yard();
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.ok(Math.hypot(cat.x - p.x, cat.y - p.y) > 80, 'it backs off');
  fishInHand(p);
  Object.assign(cat, { x: p.x + 250, y: p.y });
  for (let i = 0; i < 30 * 6; i++) world.step(1 / 30);
  assert.ok(Math.hypot(cat.x - p.x, cat.y - p.y) < 80, 'a fish brings it over');
});

test('feed it a fish and it follows you; then pick it up (no guns) and pet it; it wriggles free after a while', () => {
  const { world, cats, cat, p } = yard();
  assert.equal(cats.pickUp(p, cat.id), 'cat_wary', 'a stranger can\'t pick it up');
  assert.equal(cats.feed(p, cat.id), 'no_fish');
  fishInHand(p, 2);
  assert.equal(cats.feed(p, cat.id), null);
  assert.equal(hotbarOf(p).count('fish'), 1, 'one fish eaten');
  assert.ok(cats.friendly(cat, p));
  // It follows.
  p.inventory.fill(null);
  Object.assign(p, { x: 1600, y: 1000 });
  for (let i = 0; i < 30 * 6; i++) world.step(1 / 30);
  assert.ok(Math.hypot(cat.x - p.x, cat.y - p.y) < 100, `at your heels (${Math.round(Math.hypot(cat.x - p.x, cat.y - p.y))})`);
  // Up it comes: no shooting with your arms full.
  assert.equal(cats.pickUp(p, cat.id), null);
  assert.equal(p.holdingCat, cat);
  p.inventory[0] = { type: 'pistol', ammo: 12, reloadTimer: 0 };
  p.selected = 0;
  p.applyInput({ seq: 1, angle: 0, throttle: 0, aim: 0, fire: true });
  world.step(1 / 30);
  assert.equal(world.bullets.size, 0, 'no shooting while holding a cat');
  p.applyInput({ seq: 2, angle: 0, throttle: 0, aim: 0, fire: false });
  assert.equal(cats.pet(p, 0), null);
  assert.ok(cats.events.splice(0).some((e) => e.kind === 'cat_pet'));
  assert.deepEqual(cats.visible(p.x, p.y, 500, p)[0].slice(4, 9), [3, 0, 1, 1, p.id], 'held, petted, knows me');
  for (let i = 0; i < config.cats.holdSec + 5; i++) world.step(1);
  assert.equal(p.holdingCat, null, 'it wriggled free');
  assert.ok(cats.events.some((e) => e.kind === 'cat_free'));
  // Put down on purpose.
  assert.equal(cats.pickUp(p, cat.id), null);
  assert.equal(cats.putDown(p), null);
  assert.equal(cat.heldBy, null);
});

test('wheat in hand feeds the crows (one wheat a handful)', () => {
  const { world, p } = yard();
  assert.equal(world.feedCrows(p), 'no_wheat');
  p.inventory[0] = { good: 'wheat', qty: 3 };
  p.selected = 0;
  assert.equal(world.feedCrows(p), null);
  assert.equal(hotbarOf(p).count('wheat'), 2);
});
