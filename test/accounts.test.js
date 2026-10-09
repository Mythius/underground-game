import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountStore } from '../src/accounts.js';
import { config } from '../src/config.js';

test('each browser gets its own account, reached by the token it keeps', () => {
  const store = new AccountStore(':memory:');
  const a = store.createDeviceAccount();
  const b = store.createDeviceAccount();
  assert.notEqual(a.account.id, b.account.id);
  assert.notEqual(a.token, b.token);
  assert.equal(a.account.bank, config.accounts.startingBank);
  assert.deepEqual(store.accountForToken(a.token), a.account);
  assert.equal(store.accountForToken('made-up'), null);
  assert.equal(store.accountForToken(null), null);
});

test('bank balances are saved', () => {
  const store = new AccountStore(':memory:');
  const { token, account } = store.createDeviceAccount();
  store.setBank(account.id, 1234);
  assert.equal(store.accountForToken(token).bank, 1234);
});

test('other login providers (e.g. Google later) map to one account each', () => {
  const store = new AccountStore(':memory:');
  const first = store.findOrCreateByIdentity('google', 'g-123', 'Matt Smith');
  const second = store.findOrCreateByIdentity('google', 'g-123', 'Matt Smith');
  assert.equal(first.account.id, second.account.id);
  assert.match(first.account.name, /^[A-Za-z0-9_]{3,16}$/);
});
