import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { carriedSlots, restoreSlots } from '../src/game/Room.js';
import { hotbarOf } from '../src/game/cargo.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)

config.player.healthRegenPerSec = 0;

// A pond (centre 2000,1500, radius 300) and a shopkeeper by the road west of it.
function pond() {
  const { map } = validateMap({ width: 4000, height: 3000, lakes: [{ x: 2000, y: 1500, r: 300 }], buildings: [] });
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  world.shopkeepers.push({ x: 1000, y: 1500, angle: 0 });
  const p = world.spawnPlayer('angler');
  Object.assign(p, { x: 1000, y: 1560, cash: 1000 });
  return { world, p, fishing: world.fishing };
}

/** Stand on the west bank, rod in hand. */
function onBank({ world, p }) {
  assert.equal(world.buy(p, 'rod'), null);
  p.selected = p.inventory.findIndex((s) => s?.type === 'rod');
  Object.assign(p, { x: 2000 - 300 - 40, y: 1500 });
}

/** Seconds after the fish shows: in the split second (`inTime`), or just too late. */
const nextMoment = (f, inTime) => (inTime ? config.fishing.showSec / 2 : config.fishing.showSec + 0.1);

/** Step the world until the fish bites. */
function waitForBite(f) {
  f.p.fishing.biteAt = f.fishing.time; // (no need to wait it out)
  f.world.step(1 / 30);
  assert.equal(f.p.fishing.phase, 'bite');
}

/** Step to `t` seconds after it shows and pull. */
function pullAt(f, t) {
  while (f.fishing.time - f.p.fishing.start < t) f.world.step(1 / 60);
  return f.fishing.pull(f.p, t);
}

test('a rod from the shop; cast onto water only', () => {
  const f = pond();
  const { world, p, fishing } = f;
  assert.equal(world.buy(p, 'rod'), null);
  assert.equal(p.cash, 1000 - config.fishing.rodPrice);
  assert.equal(world.buy(p, 'rod'), 'have_rod', 'one is enough');
  p.selected = p.inventory.findIndex((s) => s?.type === 'rod');
  assert.equal(fishing.cast(p, 0), 'no_water', 'nowhere near the pond');
  Object.assign(p, { x: 2000 - 300 - 40, y: 1500 });
  assert.equal(fishing.cast(p, Math.PI), 'no_water', 'facing away from it');
  assert.equal(fishing.cast(p, 0), null);
  assert.ok(Math.hypot(p.fishing.x - 2000, p.fishing.y - 1500) < 300 - 12, 'the float is on the water');
  // Walking off brings the line in.
  p.x -= config.fishing.lineReach + 5;
  world.step(1 / 30);
  assert.equal(p.fishing, null);
});

test('pull in the split second the fish shows, and it is landed', () => {
  const f = pond();
  onBank(f);
  assert.equal(f.fishing.cast(f.p, 0), null);
  waitForBite(f);
  const start = { x: f.p.fishing.x, y: f.p.fishing.y };
  const random = Math.random;
  try {
    for (let i = 0; i < 1; i++) {
      if (i === 1 - 1) Math.random = () => 0.1; // a fish, not junk
      assert.equal(pullAt(f, nextMoment(f, true)), null);
    }
  } finally {
    Math.random = random;
  }
  assert.equal(f.p.fishing, null);
  assert.equal(hotbarOf(f.p).count('fish'), 1);
  void start;
});

test('pull too late and it is gone; never pull and it swims off; pull before it shows and you reel in for nothing', () => {
  const f = pond();
  onBank(f);
  f.fishing.cast(f.p, 0);
  waitForBite(f);
  assert.equal(pullAt(f, nextMoment(f, false)), null);
  assert.equal(f.p.fishing, null);
  assert.equal(hotbarOf(f.p).count('fish'), 0);
  assert.ok(f.fishing.events.some((e) => e.kind === 'fish_escaped' && e.why === 'slow'));
  f.fishing.events.length = 0;
  f.fishing.cast(f.p, 0);
  waitForBite(f);
  for (let i = 0; i < 30; i++) f.world.step(1 / 30);
  assert.equal(f.p.fishing, null);
  assert.ok(f.fishing.events.some((e) => e.kind === 'fish_escaped' && e.why === 'slow'));
  f.fishing.cast(f.p, 0);
  assert.equal(f.fishing.pull(f.p, null), null, 'nothing on yet');
  assert.equal(f.p.fishing, null);
  assert.ok(f.fishing.events.some((e) => e.kind === 'fish_reeled'));
});

test("the player's own view of the moment counts, within the lag allowance", () => {
  const f = pond();
  onBank(f);
  f.fishing.cast(f.p, 0);
  waitForBite(f);
  const seen = nextMoment(f, true);
  // The server is past the split second by now, but the player clicked when they saw it.
  while (f.fishing.time - f.p.fishing.start < seen + 0.3) f.world.step(1 / 60);
  assert.ok(f.p.fishing, 'still on the line (waiting on a laggy click)');
  const random = Math.random;
  Math.random = () => 0.1;
  try { assert.equal(f.fishing.pull(f.p, seen), null); } finally { Math.random = random; }
  assert.equal(hotbarOf(f.p).count('fish'), 1);
  // A claim far from the server's clock isn't believed.
  f.fishing.cast(f.p, 0);
  waitForBite(f);
  while (f.fishing.time - f.p.fishing.start < config.fishing.showSec + 0.1) f.world.step(1 / 60);
  f.fishing.pull(f.p, 0.1 - 3);
  assert.equal(hotbarOf(f.p).count('fish'), 1, 'not another');
});

test('sometimes it is not a fish: food or a gun with a few rounds', () => {
  for (const [roll, kind] of [[[0.9, 0.1, 0.3], 'food'], [[0.9, 0.99, 0.01, 0.5], 'gun']]) {
    const f = pond();
    onBank(f);
    f.fishing.cast(f.p, 0);
    waitForBite(f);
    const random = Math.random;
    try {
      for (let i = 0; i < 1; i++) {
        const t = nextMoment(f, true);
        if (i === 1 - 1) { const rolls = [...roll]; Math.random = () => rolls.shift() ?? 0.5; }
        pullAt(f, t);
      }
    } finally {
      Math.random = random;
    }
    const caught = f.fishing.events.find((e) => e.kind === 'fish_caught');
    assert.equal(caught?.what, kind);
    if (kind === 'food') assert.ok(f.p.inventory.some((s) => s?.food === caught.item));
    else {
      const gun = f.p.inventory.find((s) => s?.type === caught.item);
      assert.ok(gun && gun.ammo >= 1 && gun.ammo <= config.fishing.junkAmmo[1]);
    }
  }
});

test('fish eat; the rod is yours to keep (work sites leave it alone, and it is saved with your hotbar)', () => {
  const f = pond();
  onBank(f);
  hotbarOf(f.p).add('fish', 1);
  f.p.selected = f.p.inventory.findIndex((s) => s?.good === 'fish');
  f.p.health = 50;
  assert.equal(f.world.eat(f.p), null);
  for (let i = 0; i < 30 * (config.economy.fish.healSec + 1); i++) f.world.step(1 / 30);
  assert.ok(Math.abs(f.p.health - (50 + config.economy.fish.heal)) < 1);
  for (let i = 0; i < 30 * 2; i++) f.world.step(1 / 30); // (the work sites check every second)
  assert.ok(f.p.inventory.some((s) => s?.type === 'rod'), 'still got it');
  const saved = JSON.parse(JSON.stringify(carriedSlots(f.p)));
  const next = f.world.spawnPlayer('later');
  restoreSlots(next, saved);
  assert.ok(next.inventory.some((s) => s?.type === 'rod' && s.tool));
});

test('cast at another player: hook them, pull in the split second and take one random thing from their hotbar (theft)', () => {
  const f = pond();
  onBank(f);
  Object.assign(f.p, { x: 600, y: 2600 }); // dry land, nowhere near the pond
  const mark = f.world.spawnPlayer('mark');
  mark.account = { id: 9, name: 'mark', bank: 0, guest: false };
  Object.assign(mark, { x: 750, y: 2600 });
  hotbarOf(mark).add('steel', 3);
  assert.equal(f.fishing.cast(f.p, 0), null);
  assert.equal(f.p.fishing.victim, mark, 'hooked');
  assert.ok(f.fishing.events.some((e) => e.player === mark && e.kind === 'hooked_by'), 'they are warned');
  const crimes = [];
  f.world.police.crime = (who, kind) => { crimes.push([who, kind]); return true; };
  waitForBite(f);
  pullAt(f, nextMoment(f, true));
  assert.equal(f.p.fishing, null);
  assert.equal(hotbarOf(f.p).count('steel'), 3, 'the only thing worth taking (not the knife)');
  assert.equal(hotbarOf(mark).count('steel'), 0);
  assert.ok(mark.inventory.some((s) => s?.type === 'knife'), 'they keep their starting knife');
  assert.deepEqual(crimes, [[f.p, 'pickpocket']]);
});

test('a hooked player walks off and snaps the line', () => {
  const f = pond();
  onBank(f);
  Object.assign(f.p, { x: 600, y: 2600 });
  const mark = f.world.spawnPlayer('mark');
  Object.assign(mark, { x: 750, y: 2600 });
  hotbarOf(mark).add('steel', 3);
  f.fishing.cast(f.p, 0);
  assert.ok(f.p.fishing?.victim);
  mark.y += config.fishing.hookBreak + 10;
  f.world.step(1 / 30);
  assert.equal(f.p.fishing, null);
  assert.ok(f.fishing.events.some((e) => e.player === mark && e.kind === 'hook_free' && e.escaped));
  assert.equal(hotbarOf(mark).count('steel'), 3);
});

test('hooking a player reels in something they carry — even a gun like one you have', () => {
  const f = pond();
  onBank(f);
  Object.assign(f.p, { x: 600, y: 2600 });
  const mark = f.world.spawnPlayer('mark');
  Object.assign(mark, { x: 750, y: 2600 });
  mark.inventory[2] = f.world.makeWeapon('pistol');
  f.p.inventory[3] = f.world.makeWeapon('pistol'); // you've a pistol already: you can still take theirs
  f.fishing.cast(f.p, 0);
  waitForBite(f);
  pullAt(f, nextMoment(f, true));
  assert.equal(f.fishing.events.find((e) => e.kind === 'fish_caught')?.item, 'pistol');
  assert.equal(f.p.inventory.filter((s) => s?.type === 'pistol').length, 2);
});

test('in winter the lakes are ice, but the rivers still run: cast into a river only (and both in summer)', () => {
  const f = pond();
  const { world, p, fishing } = f;
  onBank(f);
  world.water = { ...world.water, rivers: [{ points: [[3200, 0], [3200, 3000]], width: 200 }] }; // a river east of the pond
  world.frozen = true;
  assert.equal(fishing.cast(p, 0), 'no_water', 'the pond is frozen');
  assert.equal(p.fishing, undefined);
  Object.assign(p, { x: 3200 - 100 - 40, y: 1500 }); // the river's west bank
  assert.equal(fishing.cast(p, 0), null, 'the river is open');
  assert.ok(p.fishing);
  // Summer again: the pond thaws, and both are open.
  world.frozen = false;
  p.fishing = null;
  assert.equal(fishing.cast(p, 0), null, 'the river in summer');
  p.fishing = null;
  Object.assign(p, { x: 2000 - 300 - 40, y: 1500 });
  assert.equal(fishing.cast(p, 0), null, 'the pond in summer');
});
