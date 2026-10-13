import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { censor, rudeName, BanList } from '../src/moderation.js';

test('swears are starred out, ordinary words are left alone', () => {
  assert.equal(censor('what the fuck'), 'what the ****');
  assert.equal(censor('fuuuck $h1t'), '****** ****');
  assert.equal(censor('you ass'), 'you ***');
  assert.equal(censor('сука блять'), '**** *****');
  assert.equal(censor('as I said, class assassin with a cocktail in Scunthorpe'), 'as I said, class assassin with a cocktail in Scunthorpe');
});

test('rude names are caught even run together', () => {
  assert.ok(rudeName('BigFuckGuy'));
  assert.ok(!rudeName('Cassie'));
  assert.ok(!rudeName('Matthias'));
});

test('bans by IP or account, saved, and lifted by name', () => {
  const file = pathToFileURL(join(mkdtempSync(join(tmpdir(), 'bans-')), 'bans.json'));
  const bans = new BanList(file);
  bans.ban({ ip: '1.2.3.4', accountId: 7, name: 'Griefer' });
  const again = new BanList(file);
  assert.ok(again.isBanned({ ip: '1.2.3.4' }));
  assert.ok(again.isBanned({ accountId: 7 }));
  assert.ok(!again.isBanned({ ip: '5.6.7.8', accountId: 8 }));
  assert.equal(again.unban('griefer'), 1);
  assert.ok(!again.isBanned({ ip: '1.2.3.4' }));
});
