import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountStore } from '../src/accounts.js';
import { Room } from '../src/game/Room.js';
import { validateMap } from '../src/game/mapFile.js';
import { makeWeapon } from '../src/game/entities.js';

const { map } = validateMap({
  width: 3000,
  height: 2000,
  roads: [{ x: 0, y: 900, w: 3000, h: 200 }],
  buildings: [{ type: 'house', x: 500, y: 500, rot: 0 }],
});

test('cash and the hotbar stay with the account when you log off (and come back with you); dying loses them', async () => {
  const store = new AccountStore(':memory:');
  const { account } = store.createDeviceAccount();
  const room = new Room(map, store);
  const join = () => {
    const client = { id: 1, account: store.live(account.id), send: () => {}, sendRaw: () => {}, chatLimiter: { tryConsume: () => true } };
    room.clients.add(client);
    room.spawn(client, 'me', null);
    return client;
  };

  let client = join();
  const p = client.player;
  p.cash = 450;
  p.inventory[1] = makeWeapon('sniper');
  p.inventory[1].ammo = 2;
  p.inventory[2] = { good: 'vodka', qty: 3 };
  p.inventory[3] = { tool: true, type: 'pickaxe', site: 1 }; // borrowed: it goes back
  const pickupsBefore = room.world.pickups.size;
  room.removeClient(client);
  assert.equal(room.world.pickups.size, pickupsBefore, 'nothing dropped on the ground');
  assert.equal(store.account(account.id).cash, 450);

  // Back again (even after a restart: it's in the database).
  client = join();
  const back = client.player;
  assert.equal(back.cash, 450);
  assert.equal(back.inventory[0].type, 'knife');
  assert.deepEqual([back.inventory[1].type, back.inventory[1].ammo], ['sniper', 2]);
  assert.deepEqual(back.inventory[2], { good: 'vodka', qty: 3 });
  assert.equal(back.inventory[3], null);

  // Killed: it's all on the body now, nothing to come back with.
  back.health = 0;
  room.world.removePlayer(back.id);
  const step = room.world.step.bind(room.world);
  let reported = false;
  room.world.step = (dt) => {
    const out = step(dt);
    if (!reported) {
      reported = true;
      out.deaths.push({ victim: back, killer: { name: 'x' } });
    }
    return out;
  };
  room.start();
  await new Promise((r) => setTimeout(r, 150));
  room.stop();
  assert.ok(reported);
  assert.equal(store.account(account.id).cash, 0);
  assert.equal(store.account(account.id).carried, null);
});
