import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { World } from '../src/game/World.js';
import { validateMap } from '../src/game/mapFile.js';
import { hotbarOf } from '../src/game/cargo.js';

config.gangsters.count = 0;

// A police station and a shop; one player standing at the station's front desk.
function town() {
  const { map } = validateMap({
    width: 6000,
    height: 4000,
    roads: [{ x: 0, y: 1800, w: 6000, h: 270 }],
    buildings: [{ type: 'police', x: 400, y: 1300, rot: 0 }, { type: 'shop', x: 2500, y: 1400, rot: 0 }],
    atms: [],
  });
  const world = new World({ ...config.world, foodCount: 0 }, config.player, config.weapons, map);
  world.townsfolk.people.length = 0;
  const desk = world.police.stations[0].npc;
  const p = world.spawnPlayer('rookie');
  p.account = { id: 1, name: 'rookie', bank: 1000, guest: false };
  p.x = desk.x;
  p.y = desk.y + 40;
  return { world, p, police: world.police };
}

const right = () => config.police.academy.questions.map((q) => q.answer);

test('answering every question right at the desk makes you Militsiya; a wrong answer means waiting to retry', () => {
  const { world, p, police } = town();
  const saved = [];
  world.onCopChange = (a) => saved.push(a.cop);
  const desk = police.describeDesk(p, police.stations[0]);
  assert.equal(desk.cop, false);
  assert.ok(desk.questions.length >= 3 && desk.questions.every((q) => q.answer === undefined), 'answers are not sent');
  const wrong = right();
  wrong[0] = (wrong[0] + 1) % config.police.academy.questions[0].options.length;
  assert.equal(police.apply(p, wrong), 'cop_failed');
  assert.equal(police.apply(p, right()), 'cop_retry', 'has to wait');
  world.economy.time += config.police.academy.retrySec + 1;
  assert.equal(police.apply(p, right()), null);
  assert.equal(p.account.cop, true);
  assert.deepEqual(saved, [true]);
  assert.equal(police.resign(p), null);
  assert.equal(p.account.cop, false);
});

test('you can\'t join while wanted, carrying contraband, or away from the desk', () => {
  const { p, police } = town();
  p.wanted = 1;
  assert.equal(police.apply(p, right()), 'cop_wanted');
  p.wanted = 0;
  hotbarOf(p).add('vodka', 1);
  assert.equal(police.apply(p, right()), 'cop_contraband');
  hotbarOf(p).add('vodka', -1);
  p.x += 2000;
  assert.equal(police.apply(p, right()), 'too_far');
});

test('an officer can\'t sell contraband or build illegal machines, and their stills stand idle', () => {
  const { world, p } = town();
  p.account.cop = true;
  hotbarOf(p).add('vodka', 2);
  assert.equal(world.railway?.sellBlack(p, 'vodka', 1) ?? 'cop_no_illegal', 'cop_no_illegal');
  const shop = [...world.economy.markets.values()].find((m) => world.economy.underTableHere(m));
  if (shop) assert.equal(world.economy.underTable(p, shop.id, 'vodka', 1), 'cop_no_illegal');
});

test('an officer arrests (jail, contraband seized) or fines (to the officer) a wanted player close by', () => {
  const { world, p, police } = town();
  p.account.cop = true;
  p.cash = 0;
  const q = world.spawnPlayer('someone');
  q.account = { id: 2, name: 'someone', bank: 500, guest: false };
  q.x = p.x + 30;
  q.y = p.y;
  q.cash = 50;
  assert.equal(police.copFine(p, q.id), 'not_wanted_player', 'only someone wanted');
  q.wanted = 2;
  const fine = config.police.academy.fine;
  const r = police.copFine(p, q.id);
  assert.equal(r.amount, fine);
  assert.equal(q.cash, 0);
  assert.equal(q.account.bank, 500 - (fine - 50));
  assert.equal(p.cash, fine);
  assert.equal(q.wanted, 0, 'the fine settles it');
  q.wanted = 1;
  assert.equal(police.copArrest(p, q.id), 'too_soon', 'one at a time');
  world.economy.time += config.police.academy.cooldownSec + 1;
  hotbarOf(q).add('vodka', 3);
  const a = police.copArrest(p, q.id);
  assert.equal(a.seized, 3);
  assert.ok(q.jailed && q.jailed.until > police.time);
  assert.equal(hotbarOf(q).count('vodka'), 0);
  // Not an officer: no such powers.
  world.economy.time += 100;
  q.jailed = null;
  p.wanted = 1;
  assert.equal(police.copFine(q, p.id), 'not_cop');
  p.wanted = 0;
  q.wanted = 1;
  // Too far away.
  q.x += 1000;
  assert.equal(police.copFine(p, q.id), 'too_far');
});

test('an officer who commits any crime, even unseen, is fired; shooting and police cars are allowed', () => {
  const { world, p, police } = town();
  p.account.cop = true;
  const fired = [];
  world.onCopChange = (a) => fired.push(a.cop);
  assert.equal(police.crime(p, 'fire'), false);
  assert.equal(police.crime(p, 'steal_police_car', true), false);
  const q = world.spawnPlayer('crook');
  q.wanted = 2;
  assert.equal(police.lawful(p, q), true, 'force against a wanted player');
  q.wanted = 0;
  assert.equal(police.lawful(p, q), false);
  assert.equal(p.account.cop, true);
  p.x = p.y = 50; // nobody around to see
  police.crime(p, 'pickpocket');
  assert.equal(p.account.cop, false);
  assert.deepEqual(fired, [false]);
  assert.ok(police.events.some((e) => e.player === p && e.kind === 'cop_fired'));
});
