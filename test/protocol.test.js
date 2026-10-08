import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeClientMessage } from '../src/net/protocol.js';

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

test('clamps input throttle and coerces boost', () => {
  const { msg } = decodeClientMessage('{"t":"input","seq":3,"angle":1.5,"throttle":9,"boost":"yes"}');
  assert.deepEqual(msg, { t: 'input', seq: 3, angle: 1.5, throttle: 1, boost: false });
});
