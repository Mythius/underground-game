import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)
config.player.healthRegenPerSec = 0;

// A police station by a road, and the prison on the other side of it (its gatehouse facing the road).
function camp() {
  const { map, error } = validateMap({
    width: 6000,
    height: 5000,
    roads: [{ x: 0, y: 1900, w: 6000, h: 270 }],
    buildings: [
      { type: 'police', x: 400, y: 1400, rot: 0 },
      { type: 'prison', x: 2000, y: 300, rot: 0, size: { w: 1600, h: 1400 } },
    ],
  });
  assert.equal(error, undefined);
  const world = new World({ ...config.world, foodCount: 0, pickupStart: 0, parkingLots: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  const b = world.buildings.find((x) => x.type === 'prison');
  const p = world.spawnPlayer('crook');
  p.account = { id: 7, name: 'crook', bank: 0, guest: false };
  return { world, b, p, prison: world.prison, s: b.prison };
}

let seq = 1;
const walk = (world, p, angle, sec, extra = {}) => {
  p.applyInput({ seq: seq++, angle, throttle: 1, aim: angle, ...extra });
  for (let i = 0; i < sec * 30; i++) world.step(1 / 30);
  p.applyInput({ seq: seq++, angle, throttle: 0, aim: angle });
};
const inside = (r, x, y) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;

test('arrested by the Militsiya: off to the prison, hotbar held by the warden, a pickaxe and a coal quota', () => {
  const { world, p, prison, s } = camp();
  const unit = world.police.units.find((u) => !u.post);
  p.x = 1000; p.y = 2400;
  p.wanted = 2;
  p.cash = 100;
  const knife = p.inventory[0];
  unit.officer.onFoot = true;
  unit.officer.x = p.x + 30;
  unit.officer.y = p.y;
  unit.target = p;
  for (let i = 0; i < (config.police.arrestSec + 0.5) * 30 && !p.jailed; i++) world.step(1 / 30);
  assert.ok(p.jailed?.prison, 'in prison');
  assert.equal(p.cash, 100, 'no bail taken on the spot');
  assert.equal(p.jailed.quota, 2 * config.prison.coalPerStar);
  assert.equal(p.jailed.bail, 2 * config.police.bailPerStar);
  assert.equal(p.jailed.stash[0], knife, 'the warden has the knife');
  assert.equal(p.inventory[0].type, 'pickaxe');
  assert.ok(inside(s.inner, p.x, p.y), 'on the parade ground');
  assert.deepEqual(p.account.prison, { quota: 2 * config.prison.coalPerStar, coal: 0, bail: 500 });
  assert.equal(p.wanted, 0);
});

test('the wire and the gatehouse counter keep prisoners in; the warden takes bail and lets you out', () => {
  const { world, b, p, prison, s } = camp();
  prison.jail(p, 1);
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const start = { ...s.spawn };
    Object.assign(p, start);
    walk(world, p, angle, 8);
    assert.ok(inside(b, p.x, p.y), `still inside heading ${angle}`);
    assert.ok(p.jailed, 'still a prisoner');
  }
  // Up to the counter from the camp side: the warden is there, but there's no way past him.
  const warden = b.npc;
  Object.assign(p, { x: warden.x, y: warden.y - 60 });
  walk(world, p, Math.PI / 2, 3);
  assert.ok(p.y < warden.y, 'the counter holds');
  assert.equal(prison.payBail(p, p.id), 'cant_afford_bail');
  p.cash = 300;
  assert.deepEqual(prison.payBail(p, p.id), { name: 'crook', bail: config.police.bailPerStar });
  assert.equal(p.jailed, null);
  assert.equal(p.cash, 300 - config.police.bailPerStar);
  assert.equal(p.inventory[0].type, 'knife', 'things back from the warden');
  assert.ok(!inside(b, p.x, p.y) || p.y > b.y + b.h - 20, 'out by the road');
  assert.equal(p.account.prison, null);
});

test('a friend pays your bail from the visitors\' side of the counter', () => {
  const { world, b, p, prison } = camp();
  prison.jail(p, 3);
  const friend = world.spawnPlayer('friend');
  friend.account = { id: 8, name: 'friend', bank: 5000, guest: false };
  friend.cash = 0;
  Object.assign(friend, { x: b.npc.x, y: b.npc.y + 70 });
  assert.equal(prison.describe(friend).prisoners[0].name, 'crook');
  assert.deepEqual(prison.payBail(friend, p.id), { name: 'crook', bail: 3 * config.police.bailPerStar });
  assert.equal(friend.account.bank, 5000 - 3 * config.police.bailPerStar);
  assert.equal(p.jailed, null);
});

test('mine coal and tip it into the bunker: your quota served, you go free', () => {
  const { world, b, p, prison, s } = camp();
  const coalFace = [...world.work.nodes.values()].filter((n) => n.kind === 'coal');
  assert.ok(coalFace.length > 25, `${coalFace.length} coal rocks`);
  assert.ok(coalFace.every((n) => inside(s.inner, n.x, n.y)), 'inside the wire');
  prison.jail(p, 1);
  p.jailed.quota = 4;
  const node = coalFace[0];
  Object.assign(p, { x: node.x - node.r - p.radius - 10, y: node.y });
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, aim: 0, fire: true });
  for (let i = 0; i < 30 * config.work.swingSec * (node.max + 1) && node.hp > 0; i++) world.step(1 / 30);
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, aim: 0, fire: false });
  assert.equal(hotbarOf(p).count('coal'), 2);
  Object.assign(p, { x: s.hopper.x + 70, y: s.hopper.y });
  world.step(1 / 30);
  assert.equal(p.jailed.coal, 2);
  assert.equal(hotbarOf(p).count('coal'), 0, 'into the bunker');
  hotbarOf(p).add('coal', 2);
  world.step(1 / 30);
  assert.equal(p.jailed, null, 'served');
  assert.equal(hotbarOf(p).count('coal'), 0, 'no coal out of the camp');
});

test('escape: lift a guard\'s key, dig through the inner fence, key the outer door — wanted, and the towers shoot', () => {
  const { world, b, p, prison, s } = camp();
  prison.jail(p, 1);
  const guard = world.police.prisonGuards()[0];
  assert.ok(guard, 'guards on patrol');
  // From the front he catches you: more coal.
  guard.angle = 0;
  Object.assign(p, { x: guard.x + 40, y: guard.y });
  world.pickpocket(p);
  assert.equal(p.jailed.quota, config.prison.coalPerStar + config.prison.caughtCoal);
  assert.ok(!p.inventory.some((x) => x?.type === 'key'));
  // From behind he never feels it.
  p.pickpocketReady = 0;
  Object.assign(p, { x: guard.x - 40, y: guard.y });
  world.pickpocket(p);
  assert.ok(p.inventory.some((x) => x?.type === 'key'), 'got the key');
  // The inner fence: dig through its concrete with the pickaxe (no guard looking).
  const wd = prison.wallDoor;
  for (const g of world.police.prisonGuards()) { g.x = -9999; g.y = -9999; } // (out of the way)
  Object.assign(p, { x: wd.x + wd.w / 2, y: wd.y + wd.h + 30 });
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, use: true });
  world.step(1 / 30);
  assert.equal(wd.open, false, 'no door to open: it has to be dug through');
  p.selected = p.inventory.findIndex((x) => x?.type === 'pickaxe');
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, aim: -Math.PI / 2, fire: true });
  for (let i = 0; i < 30 * config.work.swingSec * config.prison.wallHits * 1.2 && !wd.open; i++) world.step(1 / 30);
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, aim: -Math.PI / 2, fire: false });
  assert.equal(wd.open, true, 'dug through');
  // Through to the strip, along to the outer door: the key opens it.
  walk(world, p, -Math.PI / 2, 0.6);
  assert.ok(p.y < wd.y, 'in the strip');
  const kd = prison.keyDoor;
  Object.assign(p, { x: kd.x + kd.w / 2, y: kd.y + kd.h + 30 });
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, rob: true });
  for (let i = 0; i < (config.prison.lockpickSec + 0.5) * 30; i++) world.step(1 / 30);
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, rob: false });
  assert.equal(kd.open, false, 'no picking this one');
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, use: true });
  world.step(1 / 30);
  assert.equal(kd.open, true, 'the key opens it');
  assert.ok(!p.inventory.some((x) => x?.type === 'key'), 'key used up');
  walk(world, p, -Math.PI / 2, 0.8);
  assert.ok(p.y < b.y, 'over the wire');
  assert.equal(p.jailed, null);
  assert.equal(p.wanted, config.prison.escapeStars);
  assert.ok(p.account.prison, 'not away yet: shot down here, you\'d be back inside');
  // The snipers open up.
  let sniped = false;
  for (let i = 0; i < 3 * 30 && !sniped; i++) {
    world.step(1 / 30);
    sniped = [...world.bullets.values()].some((x) => x.weaponType === 'sniper' && x.owner.name === 'a tower sniper');
  }
  assert.ok(sniped || !p.alive, 'shot at from the towers');
  // Out of their range: got away.
  if (!p.alive) return;
  Object.assign(p, { x: 5900, y: 4900 });
  world.step(1 / 30);
  assert.equal(p.account.prison, null, 'got away');
});

test('the escape doors swing shut and lock again', () => {
  const { world, prison } = camp();
  prison.picked(prison.keyDoor);
  assert.equal(prison.lockedFor(prison.keyDoor), false);
  for (let i = 0; i < (config.prison.doorOpenSec + 1) * 30; i++) world.step(1 / 30);
  assert.equal(prison.keyDoor.open, false);
  assert.equal(prison.lockedFor(prison.keyDoor), true);
});

test('digging at the inner fence: a guard who sees it fills the hole in and beats you; once through, it\'s filled in behind you', () => {
  const { world, p, prison } = camp();
  prison.jail(p, 1);
  const quota = p.jailed.quota;
  const wd = prison.wallDoor;
  const [guard, ...rest] = world.police.prisonGuards();
  for (const g of rest) { g.x = -9999; g.y = -9999; }
  guard.x = -9999; guard.y = -9999;
  Object.assign(p, { x: wd.x + wd.w / 2, y: wd.y + wd.h + 30 });
  p.inventory.fill(null);
  p.inventory[0] = { type: 'pickaxe', tool: true, site: prison.building.id };
  p.selected = 0;
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, aim: -Math.PI / 2 });
  for (let i = 0; i < 5; i++) assert.equal(prison.digWall(p), true);
  assert.equal(prison.wallHits, 5);
  // A guard comes round, facing you: seen.
  Object.assign(guard, { x: p.x + 200, y: p.y, angle: Math.PI });
  const health = p.health;
  assert.equal(prison.digWall(p), true);
  assert.equal(prison.wallHits, 0, 'the hole is filled in');
  assert.equal(p.jailed.quota, quota + config.prison.caughtCoal);
  assert.ok(prison.events.some((e) => e.kind === 'wall_caught'));
  for (let i = 0; i < 30 * config.prison.clubEverySec * (config.prison.beatClubs + 2); i++) world.step(1 / 30);
  assert.ok(p.health < health, 'beaten');
  assert.ok(p.alive, 'but not killed');
  assert.equal(p.jailed.beating, 0, 'and then left alone');
  // Facing away, he doesn't see it: dig on through.
  Object.assign(guard, { x: p.x + 200, y: p.y, angle: 0 });
  p.health = p.maxHealth;
  for (let i = 0; i < config.prison.wallHits; i++) prison.digWall(p);
  assert.equal(wd.open, true, 'through');
  assert.equal(prison.digWall(p), false, 'nothing left to dig');
  // Nobody in the gap: it's filled in again, and the digging starts over.
  p.x -= 300;
  for (let i = 0; i < (config.prison.doorOpenSec + 1) * 30; i++) world.step(1 / 30);
  assert.equal(wd.open, false);
  assert.equal(prison.wallHits, 0);
  assert.equal(prison.lockedFor(wd), true);
});

test('a sentence carries on after logging off (resume)', () => {
  const { world, p, prison } = camp();
  prison.jail(p, 0, { quota: 30, coal: 12, bail: 750 });
  assert.equal(p.jailed.coal, 12);
  assert.equal(p.jailed.quota, 30);
  assert.equal(p.jailed.bail, 750);
});

// ---- camp life: cells, lights out, convicts, slop ----------------------------------------------

test('you arrive in one of the cells by the gatehouse', () => {
  const { world, p, prison, s } = camp();
  assert.equal(s.cells.length, 8);
  prison.jail(p, 1);
  assert.ok(prison.inCell(p.x, p.y), 'in a cell');
  assert.ok(inside(s.block, p.x, p.y), 'in the cell block');
  // A second prisoner gets the next (emptiest) cell.
  const q = world.spawnPlayer('crook2');
  prison.jail(q, 1);
  assert.ok(prison.inCell(q.x, q.y));
  assert.notDeepEqual(s.cells.find((c) => inside(c, p.x, p.y)), s.cells.find((c) => inside(c, q.x, q.y)));
});

test('lights out: back to the cells or a guard comes with his baton (more coal); the cells lock till morning', () => {
  const { world, p, prison, s } = camp();
  prison.jail(p, 1);
  const quota = p.jailed.quota;
  Object.assign(p, { x: s.spawn.x, y: s.spawn.y }); // out on the parade ground
  world.night = true;
  world.step(1 / 30);
  assert.ok(prison.lockdown);
  const evs = prison.events.splice(0);
  assert.ok(evs.some((e) => e.kind === 'lights_out'));
  assert.ok(p.jailed.out, 'out of the cells after lights-out');
  for (let i = 0; i < 30 * (config.prison.curfewWarnSec - 2); i++) world.step(1 / 30);
  assert.equal(p.jailed.quota, quota, 'the warning first');
  let clubbed = false;
  for (let i = 0; i < 30 * 90 && !clubbed; i++) {
    world.step(1 / 30);
    clubbed = prison.events.splice(0).some((e) => e.kind === 'clubbed');
  }
  assert.ok(clubbed, 'a guard came and clubbed him');
  assert.equal(p.jailed.quota, quota + config.prison.curfewCoal);
  assert.ok(p.health > 0, 'beaten, not killed');
  // The cell doors are locked; picking one is the only way out.
  const door = [...prison.cellDoors][0];
  assert.ok(world.lockedFor(door, p));
  assert.ok(prison.isPrisonDoor(door));
  // Back in a cell: left alone.
  const cell = s.cells[0];
  Object.assign(p, { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 });
  world.step(1 / 30);
  assert.equal(p.jailed.out, null);
  // Morning: unlocked and opened up.
  world.night = false;
  world.step(1 / 30);
  assert.ok(!prison.lockdown);
  assert.ok(!world.lockedFor(door, p) && door.open);
});

test('locked in your cell at night: hold F at the door to pick it open', () => {
  const { world, p, prison, s } = camp();
  prison.jail(p, 1);
  const cell = s.cells[0];
  Object.assign(p, { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2 });
  world.night = true;
  for (let i = 0; i < 30 * 5; i++) world.step(1 / 30);
  const door = prison.cellDoorList[0];
  assert.ok(!door.open && world.lockedFor(door, p), 'locked in for the night');
  assert.ok(prison.events.splice(0).some((e) => e.kind === 'prison_lockdown' && e.on && !e.player), 'everyone told the cells are locked');
  Object.assign(p, { x: (p.x + door.x + door.w / 2) / 2, y: (p.y + door.y + door.h / 2) / 2 }); // up at the door, still inside
  assert.equal(world.lockedDoorNear(p), door);
  p.applyInput({ seq: seq++, angle: 0, throttle: 0, aim: 0, rob: true });
  for (let i = 0; i < 30 * (config.prison.cellLockpickSec + 0.5); i++) world.step(1 / 30);
  assert.ok(door.open && !world.lockedFor(door, p), 'picked open');
});

test('the big convicts dig coal and tip it in the bunker; hit one and he fights back with his fists', () => {
  const { world, p, prison, b } = camp();
  world.townsfolk.people.length = 0;
  for (let i = 0; i < config.prison.convicts.count; i++) prison.jobLost({ job: { kind: 'convict' } });
  prison.jobLost({ job: { kind: 'cook' } });
  for (let i = 0; i < config.labour.replaceSec + 1; i++) world.step(1);
  const convicts = world.townsfolk.people.filter((x) => x.job?.kind === 'convict');
  assert.equal(convicts.length, config.prison.convicts.count);
  assert.ok(convicts.every((c) => c.big && c.health === config.prison.convicts.health));
  assert.equal(world.townsfolk.people.filter((x) => x.job?.kind === 'cook').length, 1, 'and the cook');
  const coal = () => [...world.work.nodes.values()].filter((n) => n.site === b.id).reduce((sum, n) => sum + n.hp, 0);
  const before = coal();
  for (let i = 0; i < 60 * 4; i++) world.step(1 / 4);
  assert.ok(coal() < before, 'coal dug');
  // A punch-up.
  prison.jail(p, 1);
  const c = convicts[0];
  Object.assign(p, { x: c.x + 40, y: c.y });
  const crimes = [];
  world.police.crime = (who, kind) => crimes.push(kind);
  world.townsfolk.provoke(c, p, 'assault');
  const hp = p.health;
  for (let i = 0; i < 30 * 3; i++) world.step(1 / 30);
  assert.ok(p.health < hp, 'he hits back');
  assert.ok(!c.flee, 'and doesn\'t run off');
  assert.deepEqual(crimes, [], 'nobody calls the Militsiya');
});

test('meal times: the bell, then one bowl of slop at the kitchen hatch', () => {
  const { world, p, prison, s } = camp();
  prison.jail(p, 1);
  prison.jobLost({ job: { kind: 'cook' } });
  for (let i = 0; i < config.labour.replaceSec + 1; i++) world.step(1);
  Object.assign(p, { x: s.serve.x, y: s.serve.y + 10 });
  Object.assign(world, { dayClock: config.environment.daySec / 2, dayNumber: 3 }); // between meals
  world.step(1 / 30);
  assert.ok(!prison.events.splice(0).some((e) => e.kind === 'slop'), 'nothing between meals');
  world.dayClock = 5; // breakfast
  world.step(1 / 30);
  const evs = prison.events.splice(0);
  assert.ok(evs.some((e) => e.kind === 'meal_bell'));
  assert.ok(evs.some((e) => e.kind === 'slop'));
  assert.ok(p.digesting.length > 0, 'it heals like a loaf');
  world.step(1 / 30);
  assert.ok(!prison.events.splice(0).some((e) => e.kind === 'slop'), 'one bowl each');
  world.dayClock = config.environment.daySec - 6 * 60 + 5; // supper
  world.step(1 / 30);
  assert.ok(prison.events.splice(0).some((e) => e.kind === 'slop'), 'another at supper');
});
