import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { makeWeapon } from '../src/game/entities.js';

// A small town with a police station, a shop, a bank and a road.
function town({ townsfolk = true } = {}) {
  const { map } = validateMap({
    width: 6000,
    height: 4000,
    roads: [{ x: 0, y: 1800, w: 6000, h: 270 }],
    buildings: [
      { type: 'police', x: 400, y: 1300, rot: 0 },
      { type: 'shop', x: 2500, y: 1400, rot: 0 },
      { type: 'bank', x: 4500, y: 1400, rot: 0 },
      { type: 'house', x: 3500, y: 2400, rot: 0 },
    ],
    atms: [{ x: 2400, y: 1700, angle: 0 }],
  });
  const world = new World({ ...config.world, foodCount: 0 }, config.player, config.weapons, map);
  if (!townsfolk) world.townsfolk.people.length = 0;
  const p = world.spawnPlayer('crook');
  p.account = { id: 7, name: 'crook', bank: 0, guest: false };
  return { world, p, police: world.police };
}

// A townsperson standing still at (x, y).
const person = (x, y, extra = {}) => ({ id: Math.random(), x, y, angle: 0, inside: 0, route: [], speed: 0, side: 1, mood: 0.7, wallet: 100, health: 40, ...extra });

const nobodyAround = (world) => {
  world.townsfolk.people.length = 0;
  for (const u of world.police.units) {
    u.officer.x = u.officer.y = -99999; // far away and not coming back this test
    if (u.car) { u.car.x = 50; u.car.y = 50; }
  }
};

test('a crime counts only if police or a townsperson sees it; alarms always count', () => {
  const { world, p, police } = town();
  nobodyAround(world);
  p.x = 5500;
  p.y = 3500;
  assert.equal(police.crime(p, 'fire'), false);
  assert.equal(p.wanted, 0);
  // Someone looking the other way (they see a half circle in front of them) doesn't count…
  const witness = person(p.x + 100, p.y, { angle: 0 });
  world.townsfolk.people.push(witness);
  assert.equal(police.crime(p, 'fire'), false, 'facing away');
  // …but facing this way, they do.
  witness.angle = Math.PI;
  assert.equal(police.crime(p, 'fire'), true);
  assert.equal(p.wanted, config.crime.stars.fire);
  assert.equal(police.crime(p, 'murder', true), true);
  assert.equal(p.wanted, config.crime.stars.murder);
});

test('robbing an ATM takes a few seconds and pays cash; it\'s only reported if someone sees', () => {
  const { world, p, police } = town();
  police.witnessed = () => true; // someone's watching
  const atm = world.atms[0];
  assert.ok(atm, 'the shop or bank has an ATM');
  p.x = atm.x;
  p.y = atm.y + 30;
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, rob: true }); // hold F
  world.step(1 / 30);
  assert.ok(p.robbing, 'robbing');
  assert.equal(p.wanted, config.crime.stars.rob_atm, 'seen: wanted straight away');
  for (let i = 0; i < config.robbery.atm.sec * 30 + 5; i++) world.step(1 / 30);
  assert.ok(p.cash >= config.robbery.atm.min);
  assert.equal(world.rob(p), 'recently_robbed');
  assert.ok(police.events.some((e) => e.kind === 'robbed') || p.cash > 0);
});

test('walking away from a robbery gets you nothing; shops and banks need a gun in hand', () => {
  const { world, p } = town();
  const keeper = world.shopkeepers.find((k) => k.type === 'shop');
  p.x = keeper.x;
  p.y = keeper.y + 50;
  p.selected = 2; // an empty slot: no gun
  assert.equal(world.rob(p), 'need_gun');
  p.selected = 0;
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, rob: true });
  world.step(1 / 30);
  assert.ok(p.robbing);
  p.x += 1000;
  world.step(1 / 30);
  assert.equal(p.robbing, null);
  assert.equal(p.cash, 0);
});

test('letting go of F stops a robbery with nothing to show for it', () => {
  const { world, p } = town();
  const atm = world.atms[0];
  p.x = atm.x;
  p.y = atm.y + 30;
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, rob: true });
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  p.applyInput({ seq: 2, angle: 0, throttle: 0, boost: false, rob: false });
  world.step(1 / 30);
  assert.equal(p.robbing, null);
  for (let i = 0; i < config.robbery.atm.sec * 30; i++) world.step(1 / 30);
  assert.ok(p.cash < config.robbery.atm.min, `no payout (cash ${p.cash} is just street income)`);
});

test('cars shove townsfolk and officers aside without hurting them', () => {
  const { world, p } = town();
  const car = [...world.vehicles.values()].find((v) => v.police);
  const walker = person(car.x, car.y); // standing right where the car is
  world.townsfolk.people.push(walker);
  world.step(1 / 30);
  const gap = Math.hypot(walker.x - car.x, walker.y - car.y);
  assert.ok(gap >= car.stats.width / 2, `pushed clear (${Math.round(gap)})`);
  assert.equal(walker.health, 40);
  assert.equal(p.wanted, 0);
});

test('pickpocketing lifts cash from a townsperson', () => {
  const { world, p } = town();
  const victim = person(1000, 1000, { wallet: 500 });
  world.townsfolk.people.push(victim);
  p.x = 1010;
  p.y = 1000;
  const result = world.pickpocket(p);
  assert.ok(result.amount >= config.pickpocket.npcMin);
  assert.equal(p.cash, result.amount);
  assert.equal(victim.wallet, 500 - result.amount);
  assert.equal(p.wanted, 1, 'the victim was right there');
  assert.equal(world.pickpocket(p), 'too_soon');
});

test('arrested next to an officer: bail comes out of cash, then bank', () => {
  const { world, p, police } = town({ townsfolk: false });
  const unit = police.units[0];
  p.wanted = 2;
  p.cash = 100;
  p.account.bank = 1000;
  unit.officer.onFoot = true;
  unit.officer.x = p.x + 30;
  unit.officer.y = p.y;
  unit.target = p;
  for (let i = 0; i < (config.police.arrestSec + 0.5) * 30; i++) world.step(1 / 30);
  assert.equal(p.wanted, 0);
  assert.equal(p.cash, 0);
  assert.equal(p.account.bank, 1000 - (config.police.bailPerStar * 2 - 100));
});

test("can't make bail: jail at the station, frozen until released", () => {
  const { world, p, police } = town({ townsfolk: false });
  const unit = police.units[0];
  p.wanted = 1;
  unit.officer.onFoot = true;
  unit.officer.x = p.x + 30;
  unit.officer.y = p.y;
  unit.target = p;
  for (let i = 0; i < (config.police.arrestSec + 0.5) * 30 && !p.jailed; i++) world.step(1 / 30);
  assert.ok(p.jailed, 'jailed');
  const cell = { x: p.x, y: p.y };
  p.applyInput({ seq: 999, angle: 0, throttle: 1, boost: false });
  for (let i = 0; i < 30; i++) world.step(1 / 30);
  assert.deepEqual({ x: Math.round(p.x), y: Math.round(p.y) }, { x: Math.round(cell.x), y: Math.round(cell.y) }, 'stays in the cell');
  for (let i = 0; i < config.police.jailSecPerStar * 30 + 30; i++) world.step(1 / 30);
  assert.equal(p.jailed, null, 'released');
});

test('police cars chase a wanted player and close in', () => {
  const { world, p, police } = town({ townsfolk: false });
  p.x = 3000;
  p.y = 1935; // on the road
  p.wanted = 1;
  p.lastSeen = police.time;
  p.reportedAt = -100; // called in a while ago
  const car = police.units[0].car;
  const start = Math.hypot(car.x - p.x, car.y - p.y);
  for (let i = 0; i < 30 * 8; i++) world.step(1 / 30);
  const unit = police.units[0];
  const now = unit.officer.onFoot ? Math.hypot(unit.officer.x - p.x, unit.officer.y - p.y) : Math.hypot(unit.car.x - p.x, unit.car.y - p.y);
  assert.equal(unit.target, p);
  assert.ok(now < start * 0.6, `closed from ${Math.round(start)} to ${Math.round(now)}`);
});

test('out of sight long enough, the Militsiya give up (longer for worse crimes)', () => {
  const { world, p, police } = town({ townsfolk: false });
  nobodyAround(world);
  for (const u of police.units) u.officer.health = 0; // nobody hunting
  p.x = 5800;
  p.y = 3900;
  p.wanted = 2;
  p.lastSeen = police.time;
  for (let i = 0; i < config.crime.searchSec[2] - 5; i++) world.step(1);
  assert.equal(p.wanted, 2, 'still looking');
  for (let i = 0; i < 10; i++) world.step(1);
  assert.equal(p.wanted, 0, 'gave up');
  assert.ok(police.events.some((e) => e.kind === 'lost_you'));
  assert.ok(config.crime.searchSec[5] > config.crime.searchSec[1]);
});

test('walls block the view; behind a building nobody sees you', () => {
  const { world, p, police } = town({ townsfolk: false });
  nobodyAround(world);
  const shop = world.buildings.find((b) => b.type === 'shop');
  // A witness on one side of the shop, the crime on the other, looking straight at it.
  world.townsfolk.people.push(person(shop.x + shop.w / 2, shop.y - 60, { angle: Math.PI / 2 }));
  p.x = shop.x + shop.w / 2;
  p.y = shop.y + shop.h + 60;
  assert.equal(police.crime(p, 'fire'), false, 'the shop is in the way');
  p.x = shop.x - 120; // round the corner, in plain view
  p.y = shop.y + 40;
  world.townsfolk.people[0].angle = Math.atan2(p.y - world.townsfolk.people[0].y, p.x - world.townsfolk.people[0].x);
  assert.equal(police.crime(p, 'fire'), true);
});

test('hiding: in a dumpster nobody sees you; the Militsiya search where you were last seen and find you', () => {
  const { world, p, police } = town({ townsfolk: false });
  nobodyAround(world);
  const d = { x: 3000, y: 2400, w: 56, h: 36 };
  world.dumpsters.push(d);
  p.x = d.x + 28;
  p.y = d.y + 80;
  p.wanted = 1;
  police.crime(p, 'murder', true); // reported: the search starts here
  p.input.use = true;
  world.step(1 / 30);
  assert.ok(p.hidden, 'in the dumpster');
  assert.equal(police.policeSee(p.x, p.y, p), false);
  // An officer turns up and checks the hiding spots round the last known position.
  const unit = police.units[0];
  Object.assign(unit.officer, { health: 50, onFoot: true, x: d.x + 300, y: d.y + 200, angle: 0 });
  unit.target = p;
  for (let i = 0; i < 30 * 40 && p.hidden; i++) world.step(1 / 30);
  assert.equal(p.hidden, null, 'pulled out of the dumpster');
  assert.ok(police.events.some((e) => e.kind === 'found_you'));
});

test('shooting a townsperson is murder if anyone sees it', () => {
  const { world, p } = town();
  const target = person(1500, 3000, { health: 1 });
  world.townsfolk.people.push(target);
  world.townsfolk.people.push(person(1700, 3000, { angle: Math.PI })); // a witness, looking this way
  p.inventory[0] = makeWeapon('pistol'); // (everyone starts with a knife)
  p.x = 1400;
  p.y = 3000;
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, aim: 0, fire: true });
  for (let i = 0; i < 15; i++) world.step(1 / 30);
  assert.ok(!world.townsfolk.people.includes(target), 'killed');
  assert.equal(p.wanted, config.crime.stars.murder);
});

test('officers on foot open public doors on their way through', () => {
  const { world, p, police } = town({ townsfolk: false });
  nobodyAround(world);
  const house = world.buildings.find((b) => b.type === 'house');
  const door = house.doors.find((d) => d.exterior);
  door.open = false;
  // Wanted, and hiding indoors: the officer heads in after them.
  Object.assign(p, { x: house.x + house.w / 2, y: house.y + house.h / 2 });
  police.crime(p, 'murder', true);
  const unit = police.units[0];
  const out = { x: door.x + door.w / 2 + door.nx * 120, y: door.y + door.h / 2 + door.ny * 120 };
  Object.assign(unit.officer, { health: 50, onFoot: true, ...out, angle: 0 });
  unit.target = p;
  for (let i = 0; i < 30 * 20 && !door.open; i++) world.step(1 / 30);
  assert.ok(door.open, 'the officer opened the door');
});

test("you can't pay cash straight back in at the ATM you just robbed", () => {
  const { world, p } = town();
  p.account.bank = 0;
  const atm = world.atms[0];
  Object.assign(p, { x: atm.x, y: atm.y + 30, cash: 0 });
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, rob: true });
  for (let i = 0; i < config.robbery.atm.sec * 30 + 10; i++) world.step(1 / 30);
  assert.ok(p.cash > 0, 'robbed it');
  p.applyInput({ seq: 2, angle: 0, throttle: 0, boost: false, rob: false });
  world.step(1 / 30);
  assert.equal(world.bank(p, 'deposit', 50), 'robbed_atm');
  assert.equal(world.bank(p, 'withdraw', 0) ?? null, null, 'withdrawing is still fine');
  world.economy.time += config.robbery.atm.noDepositSec + 1; // later, it's fine
  assert.equal(world.bank(p, 'deposit', 50), null);
});

test('a knife takes a third of anyone’s health; stabbed (or robbed) townsfolk fight back with a purse', () => {
  const { world, p } = town({ townsfolk: false });
  nobodyAround(world);
  assert.equal(p.inventory[0].type, 'knife', 'everyone starts with a knife');
  // Another player: three stabs.
  const other = world.spawnPlayer('victim');
  Object.assign(p, { x: 3000, y: 3000 });
  Object.assign(other, { x: 3040, y: 3000 });
  const stab = (seq) => {
    p.applyInput({ seq, angle: 0, throttle: 0, boost: false, aim: 0, fire: true });
    world.step(1 / 30);
    p.applyInput({ seq: seq + 1, angle: 0, throttle: 0, boost: false, aim: 0, fire: false });
    for (let i = 0; i < 30; i++) world.step(1 / 30);
  };
  stab(1);
  assert.ok(Math.abs(other.health - other.maxHealth * (2 / 3)) < 1, `a third gone (${other.health})`);
  stab(3);
  stab(5);
  assert.equal(other.alive, false, 'three stabs kill');
  // A townsperson: stab them once and they come at you swinging a purse.
  const t = person(3040, 3000, { angle: Math.PI });
  world.townsfolk.people.push(t);
  p.health = p.maxHealth;
  stab(7);
  assert.ok(t.fight, 'fighting back');
  const before = p.health;
  for (let i = 0; i < 30 * 1.2; i++) world.step(1 / 30);
  assert.ok(p.health < before, 'they hit back');
  assert.ok(before - p.health <= p.maxHealth * config.townsfolk.purseShare * config.townsfolk.purseHits, 'a couple of purse hits at most');
  assert.ok(p.alive);
  // Pickpocketing one does it too.
  world.townsfolk.people.length = 0; // (the angry one goes home)
  const mark = person(2000, 2000);
  world.townsfolk.people.push(mark);
  Object.assign(p, { x: 2030, y: 2000 });
  world.pickpocket(p);
  assert.ok(mark.fight, 'robbed: fighting back');
  // …but not if you lift it from behind: they never notice (and don't report it).
  world.townsfolk.people.length = 0;
  const unaware = person(2000, 2000, { angle: Math.PI }); // facing away from you
  world.townsfolk.people.push(unaware);
  Object.assign(p, { wanted: 0, pickpocketReady: 0 });
  const result = world.pickpocket(p);
  assert.equal(result.unnoticed, true);
  assert.ok(!unaware.fight, 'no fight');
  assert.equal(p.wanted, 0, 'nobody reported it');
});

test('an ATM robbed with nobody looking is not reported', () => {
  const { world, p, police } = town();
  police.witnessed = () => false;
  police.policeSee = () => false;
  const atm = world.atms[0];
  Object.assign(p, { x: atm.x, y: atm.y + 30 });
  p.applyInput({ seq: 1, angle: 0, throttle: 0, boost: false, rob: true });
  world.step(1 / 30);
  assert.ok(p.robbing);
  assert.equal(p.wanted, 0);
});

test('a victim only reports you if they see you and live: stabbed from behind or killed, nobody calls it in', () => {
  const { world, p } = town({ townsfolk: false });
  nobodyAround(world);
  const stab = (seq) => {
    p.applyInput({ seq, angle: 0, throttle: 0, boost: false, aim: 0, fire: true });
    world.step(1 / 30);
    p.applyInput({ seq: seq + 1, angle: 0, throttle: 0, boost: false, aim: 0, fire: false });
    for (let i = 0; i < 20; i++) world.step(1 / 30);
  };
  Object.assign(p, { x: 3000, y: 3000 });
  // Facing away from you: hurt, but didn't see who.
  const back = person(3040, 3000, { angle: 0 });
  world.townsfolk.people.push(back);
  stab(1);
  assert.ok(back.health < config.townsfolk.health, 'stabbed');
  assert.equal(p.wanted, 0, 'they never saw you');
  // Killed outright: can't report either.
  world.townsfolk.people.length = 0;
  const dead = person(3040, 3000, { angle: Math.PI, health: 1 });
  world.townsfolk.people.push(dead);
  stab(3);
  assert.ok(!world.townsfolk.people.includes(dead), 'dead');
  assert.equal(p.wanted, 0, 'the dead tell no tales');
  // Facing you and still standing: they report it.
  const front = person(3040, 3000, { angle: Math.PI });
  world.townsfolk.people.push(front);
  stab(5);
  assert.equal(p.wanted, config.crime.stars.assault);
});
