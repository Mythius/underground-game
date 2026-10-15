import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { coalMined, drank, fitLook, fromMessage, smuggled, unlock } from '../src/game/wardrobe.js';

test('hats and outfits: won by what you do, and a look only wears what you have won', () => {
  const account = {};
  const hat = (id) => config.looks.hats.indexOf(id);
  // Nothing won yet: the cap (or no hat) only; a crown asked for comes back as the cap, no coat, no shades.
  assert.deepEqual(fitLook({ skin: 1, shirt: 2, pants: 3, hat: hat('crown'), coat: 'trench', shades: true }, account), { skin: 1, shirt: 2, pants: 3, hat: hat('cap'), coat: null, shades: false });
  assert.equal(fitLook({ hat: hat('none') }, account).hat, hat('none'));
  // What messages win.
  assert.equal(fromMessage({ t: 'done', what: 'wh_buy' }), 'tophat');
  assert.equal(fromMessage({ t: 'police', kind: 'robbed', what: 'bank' }), 'ushanka');
  assert.equal(fromMessage({ t: 'police', kind: 'robbed', what: 'atm' }), null);
  assert.equal(fromMessage({ t: 'police', kind: 'governor_killed' }), 'crown');
  assert.equal(fromMessage({ t: 'police', kind: 'govguard_killed' }), 'shades');
  assert.ok(unlock(account, 'crown'));
  assert.ok(!unlock(account, 'crown')); // (once)
  assert.ok(!unlock(account, 'cap')); // (everyone's already)
  assert.ok(unlock(account, 'shades'));
  assert.deepEqual(fitLook({ hat: hat('crown'), shades: true }, account), { skin: 0, shirt: 0, pants: 0, hat: hat('crown'), coat: null, shades: true });
  // Every kind of vodka for the kubanka; over 20,000 ₽ to the smuggler for the jacket; 2,000 coal for the prison outfit.
  const kinds = Object.keys(config.economy.visions);
  for (const k of kinds.slice(0, -1)) assert.deepEqual(drank(account, k), ['party']);
  assert.deepEqual(drank(account, kinds.at(-1)), ['party', 'kubanka']);
  assert.equal(smuggled(account, 20000), null);
  assert.equal(smuggled(account, 1), 'leather');
  assert.deepEqual(coalMined(account, 1999), []);
  assert.deepEqual(coalMined(account, 1), ['prison', 'zek']);
});
