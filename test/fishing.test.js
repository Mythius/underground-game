import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { tiredAt } from '../src/game/fishing.js';
import { carriedSlots, restoreSlots } from '../src/game/Room.js';
import { hotbarOf } from '../src/game/cargo.js';

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

/** Seconds into the fight when the fish is next tired (or fighting, with `tired` false). */
function nextMoment(f, tired) {
  const now = Math.max(0.3, f.fishing.time - f.p.fishing.start); // (clicks just after a pull are ignored)
  for (let t = now; t < now + 5; t += 0.01) if (tiredAt(t, f.p.fishing.cycle, f.p.fishing.window) === tired && (!tired || tiredAt(t + 0.05, f.p.fishing.cycle, f.p.fishing.window))) return t;
  throw new Error('no such moment');
}

/** Step the world until the fish bites. */
function waitForBite(f) {
  f.p.fishing.biteAt = f.fishing.time; // (no need to wait it out)
  f.world.step(1 / 30);
  assert.equal(f.p.fishing.phase, 'bite');
}

/** Step to `t` seconds into the fight and pull. */
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

test('pull while the fish is tired, three times, and it is landed', () => {
  const f = pond();
  onBank(f);
  assert.equal(f.fishing.cast(f.p, 0), null);
  waitForBite(f);
  const start = { x: f.p.fishing.x, y: f.p.fishing.y };
  const random = Math.random;
  try {
    for (let i = 0; i < config.fishing.pulls; i++) {
      if (i === config.fishing.pulls - 1) Math.random = () => 0.1; // a fish, not junk
      assert.equal(pullAt(f, nextMoment(f, true)), null);
      if (i < config.fishing.pulls - 1) assert.equal(f.p.fishing.pulls, i + 1);
    }
  } finally {
    Math.random = random;
  }
  assert.equal(f.p.fishing, null);
  assert.equal(hotbarOf(f.p).count('fish'), 1);
  assert.ok(Math.hypot(start.x - f.p.x, start.y - f.p.y) > 0);
});

test('pull while it is thrashing and it breaks free; wait too long and it swims off', () => {
  const f = pond();
  onBank(f);
  f.fishing.cast(f.p, 0);
  waitForBite(f);
  assert.equal(pullAt(f, nextMoment(f, false)), null);
  assert.equal(f.p.fishing, null);
  assert.equal(hotbarOf(f.p).count('fish'), 0);
  assert.ok(f.fishing.events.some((e) => e.kind === 'fish_escaped' && e.why === 'snapped'));
  f.fishing.cast(f.p, 0);
  waitForBite(f);
  for (let i = 0; i < 30 * (config.fishing.giveUpSec + 1); i++) f.world.step(1 / 30);
  assert.equal(f.p.fishing, null);
  assert.ok(f.fishing.events.some((e) => e.kind === 'fish_escaped' && e.why === 'slow'));
});

test("the player's own view of the fight counts, within the lag allowance", () => {
  const f = pond();
  onBank(f);
  f.fishing.cast(f.p, 0);
  waitForBite(f);
  const tired = nextMoment(f, true);
  // The server is a little past the window by now, but the player clicked when they saw it tired.
  while (f.fishing.time - f.p.fishing.start < tired + 0.2) f.world.step(1 / 60);
  assert.equal(f.fishing.pull(f.p, tired), null);
  assert.equal(f.p.fishing.pulls, 1);
  // A claim far from the server's clock isn't believed.
  const fighting = nextMoment(f, false);
  while (f.fishing.time - f.p.fishing.start < fighting) f.world.step(1 / 60);
  f.fishing.pull(f.p, fighting + 3);
  assert.ok(f.p.fishing === null || f.p.fishing.pulls === 1);
});

test('sometimes it is not a fish: food or a gun with a few rounds', () => {
  for (const [roll, kind] of [[[0.9, 0.1, 0.3], 'food'], [[0.9, 0.99, 0.01, 0.5], 'gun']]) {
    const f = pond();
    onBank(f);
    f.fishing.cast(f.p, 0);
    waitForBite(f);
    const random = Math.random;
    try {
      for (let i = 0; i < config.fishing.pulls; i++) {
        const t = nextMoment(f, true);
        if (i === config.fishing.pulls - 1) { const rolls = [...roll]; Math.random = () => rolls.shift() ?? 0.5; }
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
