import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountStore } from '../src/accounts.js';
import { config } from '../src/config.js';
import { Room } from '../src/game/Room.js';
import { validateMap } from '../src/game/mapFile.js';
import { ACHIEVEMENTS, fromMessage } from '../src/game/achievements.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)

const { map } = validateMap({
  width: 3000,
  height: 2000,
  roads: [{ x: 0, y: 900, w: 3000, h: 200 }],
  buildings: [{ type: 'house', x: 500, y: 500, rot: 0 }],
});

function join(room, store, accountId) {
  const sent = [];
  const client = { id: 1, account: store.live(accountId), sent, sendRaw: () => {}, chatLimiter: { tryConsume: () => true } };
  client.send = (msg) => { sent.push(msg); client.onSend?.(msg); }; // (as Client.send does)
  room.addClient(client);
  room.spawn(client, 'me', null);
  return client;
}

test('achievements: earned from what happens to you, once each, told to you and saved with the account', () => {
  const store = new AccountStore(':memory:');
  const { account } = store.createDeviceAccount();
  const room = new Room(map, store);
  let client = join(room, store, account.id);
  assert.deepEqual(client.sent.find((m) => m.t === 'welcome').achievements, ACHIEVEMENTS, 'the list (with how-tos) comes with the welcome');
  assert.deepEqual(client.sent.find((m) => m.t === 'spawned').achievements, []);

  // Selling at a market, catching a fish: what the player is told is what earns it.
  client.send({ t: 'done', what: 'sell', good: 'ore', qty: 1 });
  client.send({ t: 'police', kind: 'fish_caught', what: 'fish' });
  client.send({ t: 'done', what: 'sell', good: 'ore', qty: 1 }); // (only once)
  assert.deepEqual(client.sent.filter((m) => m.t === 'achieve').map((m) => m.id), ['sell', 'fish']);

  // Walking away from where you appeared (checked once a second).
  client.player.x += 600;
  for (let i = 0; i < config.tickRate; i++) room.step(1 / config.tickRate);
  assert.ok(client.sent.some((m) => m.t === 'achieve' && m.id === 'walk'));

  // Saved: they come back with the next spawn.
  room.removeClient(client);
  client = join(room, store, account.id);
  assert.deepEqual(new Set(client.sent.find((m) => m.t === 'spawned').achievements), new Set(['sell', 'fish', 'walk']));
  assert.deepEqual(new Set(store.account(account.id).achievements), new Set(['sell', 'fish', 'walk']));
});

test('which messages count', () => {
  assert.equal(fromMessage({ t: 'bought', item: 'bread' }), 'shop');
  assert.equal(fromMessage({ t: 'banked', action: 'deposit' }), 'bank');
  assert.equal(fromMessage({ t: 'banked', action: 'withdraw' }), null);
  assert.equal(fromMessage({ t: 'done', what: 'buy' }), null, 'buying at a market is not selling');
  assert.equal(fromMessage({ t: 'done', what: 'hire_vodka' }), null);
  assert.equal(fromMessage({ t: 'done', what: 'hire_goon' }), 'hire');
  assert.equal(fromMessage({ t: 'police', kind: 'stole', amount: 5 }), 'pickpocket');
  assert.equal(fromMessage({ t: 'team', members: [{}] }), null, 'a team of one');
  assert.equal(fromMessage({ t: 'team', members: [{}, {}] }), 'team');
});
