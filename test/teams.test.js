import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { Teams } from '../src/game/teams.js';
import { World } from '../src/game/World.js';
import { decodeClientMessage } from '../src/net/protocol.js';

let nextId = 1;
const client = (name) => ({ id: nextId++, name, room: {}, team: 0, player: null });

test('invite and accept makes a team; leaving down to one disbands it', () => {
  const teams = new Teams();
  const [a, b, c] = [client('a'), client('b'), client('c')];
  assert.equal(teams.accept(b, a), 'team_no_invite');
  assert.equal(teams.invite(a, b), null);
  assert.deepEqual(teams.describe(b).invites.map((i) => i.name), ['a']);
  assert.equal(teams.accept(b, a), null);
  assert.ok(a.team && a.team === b.team);
  assert.deepEqual(teams.mates(a), [b]);
  assert.equal(teams.invite(b, a), 'team_already');
  // A teammate can bring in a third.
  teams.invite(b, c);
  teams.accept(c, b);
  assert.equal(teams.describe(a).members.length, 3);
  teams.leave(c);
  teams.remove(b); // disconnected
  assert.equal(a.team, 0);
  assert.equal(teams.teams.size, 0);
});

test('teams cap at maxSize and invites expire', () => {
  const teams = new Teams();
  const lead = client('lead');
  for (let i = 1; i < config.teams.maxSize; i++) {
    const m = client(`m${i}`);
    teams.invite(lead, m);
    assert.equal(teams.accept(m, lead), null);
  }
  assert.equal(teams.invite(lead, client('late')), 'team_full');
  const [x, y] = [client('x'), client('y')];
  teams.invite(x, y, 0);
  assert.equal(teams.accept(y, x, config.teams.inviteSec * 1000 + 1), 'team_no_invite');
});

test('X drops up to the amount of cash you carry, for someone else to pick up', () => {
  const world = new World({ ...config.world, width: 1000, height: 1000, foodCount: 0, pickupStart: 0, pickupIntervalSec: Infinity, buildingCount: 0, terrain: false }, config.player, config.weapons);
  const p = world.spawnPlayer('a');
  p.cash = 300;
  assert.equal(world.dropCash(p, 500), 300);
  assert.equal(p.cash, 0);
  assert.equal(world.dropCash(p, 500), 'no_cash');
  const bag = [...world.pickups.values()].find((g) => g.cash);
  assert.equal(bag.cash, 300);
  const q = world.spawnPlayer('b');
  q.cash = 0;
  Object.assign(q, { x: bag.x, y: bag.y });
  world.step(1 / 30);
  assert.equal(q.cash, 300);
});

test('protocol accepts cash drops and team actions', () => {
  assert.deepEqual(decodeClientMessage('{"t":"drop","cash":500}').msg, { t: 'drop', cash: 500 });
  assert.equal(decodeClientMessage('{"t":"drop","cash":-5}').ok, false);
  assert.deepEqual(decodeClientMessage('{"t":"team","action":"invite","id":3}').msg, { t: 'team', action: 'invite', id: 3 });
  assert.equal(decodeClientMessage('{"t":"team","action":"accept"}').ok, false);
});
