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

test('Google sign-in: the first time it adopts this browser\'s account; after that it always finds the same one', () => {
  const store = new AccountStore(':memory:');
  const browser = store.createDeviceAccount();
  store.setBank(browser.account.id, 777);
  // First sign-in on this browser: the browser's account (and its bank) becomes the Google one.
  const first = store.signIn('google', 'g-123', { name: 'Matt Smith', email: 'matt@example.com', currentId: browser.account.id });
  assert.equal(first.account.id, browser.account.id);
  assert.equal(first.account.bank, 777);
  assert.match(first.account.name, /^MattSmith/, 'the made-up name gives way to theirs');
  assert.deepEqual(store.linkedLogin(first.account.id), { provider: 'google', email: 'matt@example.com' });
  assert.equal(store.accountForToken(first.token).id, browser.account.id);
  // Another device (its own browser account): signing in switches it to the same account.
  const laptop = store.createDeviceAccount();
  const again = store.signIn('google', 'g-123', { name: 'Matt Smith', currentId: laptop.account.id });
  assert.equal(again.account.id, browser.account.id);
  assert.equal(store.linkedLogin(laptop.account.id), null, 'the laptop\'s own account is left alone');
  // A different Google account on the first browser can't take over an already-linked account.
  const other = store.signIn('google', 'g-999', { name: 'Someone', currentId: browser.account.id });
  assert.notEqual(other.account.id, browser.account.id);
  assert.match(other.account.name, /^[A-Za-z0-9_]{3,16}$/);
});

test('what you carry (cash and hotbar) is kept on the account', () => {
  const store = new AccountStore(':memory:');
  const { token, account } = store.createDeviceAccount();
  assert.equal(account.cash, 0);
  assert.equal(account.carried, null);
  const live = store.live(account.id);
  store.setCarried(account.id, 321, [{ type: 'knife' }, { good: 'logs', qty: 4 }, null]);
  assert.equal(live.cash, 321, 'the live account sees it too');
  assert.deepEqual(store.accountForToken(token).carried, [{ type: 'knife' }, { good: 'logs', qty: 4 }, null]);
  assert.equal(store.accountForToken(token).cash, 321);
});
