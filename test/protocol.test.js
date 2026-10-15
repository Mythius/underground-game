import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { decodeClientMessage } from '../src/net/protocol.js';

config.gangsters.count = 0; // (no gangsters wandering in; they have their own tests)

test('rejects malformed frames', () => {
  assert.equal(decodeClientMessage('not json').error, 'invalid_json');
  assert.equal(decodeClientMessage('[1,2]').error, 'invalid_shape');
  assert.equal(decodeClientMessage('null').error, 'invalid_shape');
  assert.equal(decodeClientMessage('{"t":"hack"}').error, 'unknown_type');
  assert.equal(decodeClientMessage('{"t":"input","seq":1,"angle":"x"}').error, 'invalid_payload');
  assert.equal(decodeClientMessage('{"t":"input","seq":-1,"angle":0}').error, 'invalid_payload');
});

test('sanitizes join names', () => {
  const { msg } = decodeClientMessage(JSON.stringify({ t: 'join', name: '  a\u0000b   c very long name here ' }));
  assert.equal(msg.name, 'ab c very long n');
  assert.equal(decodeClientMessage('{"t":"join"}').msg.name, 'Player');
});

test('cleans chat text and rejects empty messages', () => {
  const { msg } = decodeClientMessage(JSON.stringify({ t: 'chat', text: '  hi\u0000   there ' }));
  assert.deepEqual(msg, { t: 'chat', text: 'hi there' });
  assert.equal(decodeClientMessage('{"t":"chat","text":"   "}').error, 'invalid_payload');
  assert.equal(decodeClientMessage('{"t":"chat","text":5}').error, 'invalid_payload');
  assert.equal(decodeClientMessage(JSON.stringify({ t: 'chat', text: 'x'.repeat(500) })).msg.text.length, 120);
});

test('looks must be valid indexes; anything else is replaced', () => {
  const ok = decodeClientMessage(JSON.stringify({ t: 'join', name: 'a', look: { skin: 1, shirt: 2, pants: 3, hat: 4 } })).msg.look;
  assert.deepEqual(ok, { skin: 1, shirt: 2, pants: 3, hat: 4 });
  const bad = decodeClientMessage(JSON.stringify({ t: 'join', name: 'a', look: { skin: 99, shirt: -1, pants: 'x', hat: 1.5 } })).msg.look;
  for (const [part, list] of [['skin', 'skins'], ['shirt', 'shirts'], ['pants', 'pants'], ['hat', 'hats']]) {
    assert.ok(Number.isInteger(bad[part]) && bad[part] >= 0 && bad[part] < config.looks[list].length);
  }
});

test('bank requests need a valid action and a positive whole amount', () => {
  assert.deepEqual(decodeClientMessage('{"t":"bank","action":"deposit","amount":50}').msg, { t: 'bank', action: 'deposit', amount: 50 });
  for (const bad of ['{"t":"bank","action":"steal","amount":5}', '{"t":"bank","action":"withdraw","amount":-5}', '{"t":"bank","action":"withdraw","amount":1.5}']) {
    assert.equal(decodeClientMessage(bad).error, 'invalid_payload');
  }
});

test('clamps input throttle and coerces boost', () => {
  const { msg } = decodeClientMessage('{"t":"input","seq":3,"angle":1.5,"throttle":9,"boost":"yes"}');
  assert.deepEqual(msg, { t: 'input', seq: 3, angle: 1.5, throttle: 1, boost: false, aim: 1.5, fire: false, reload: false, use: false, slot: null, gas: 0, steer: 0, drift: false, rob: false, light: false });
});

test('fishing messages: cast with an angle, pull with what you saw; rods are on the shop list', () => {
  assert.deepEqual(decodeClientMessage(JSON.stringify({ t: 'fish', action: 'cast', angle: 1.5 })).msg, { t: 'fish', action: 'cast', angle: 1.5 });
  assert.deepEqual(decodeClientMessage(JSON.stringify({ t: 'fish', action: 'pull', seen: 0.8 })).msg, { t: 'fish', action: 'pull', seen: 0.8 });
  assert.deepEqual(decodeClientMessage(JSON.stringify({ t: 'fish', action: 'pull' })).msg, { t: 'fish', action: 'pull', seen: null });
  assert.equal(decodeClientMessage(JSON.stringify({ t: 'fish', action: 'cast' })).ok, false, 'a cast needs a direction');
  assert.equal(decodeClientMessage(JSON.stringify({ t: 'fish', action: 'dynamite' })).ok, false);
  assert.equal(decodeClientMessage(JSON.stringify({ t: 'buy', item: 'rod' })).ok, true);
});

test('radio messages', () => {
  assert.deepEqual(decodeClientMessage(JSON.stringify({ t: 'radio', action: 'next' })).msg, { t: 'radio', action: 'next' });
  assert.equal(decodeClientMessage(JSON.stringify({ t: 'radio', action: 'louder' })).ok, false);
});
