import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SLOT_IDS, SoundStore } from '../src/sounds.js';

const store = () => new SoundStore(`${mkdtempSync(join(tmpdir(), 'ug-sounds-'))}/`);

test('every sound slot has a unique id, and rain and the guns are among them', () => {
  for (const id of ['rain', 'pistol', 'engine', 'siren', 'footstep', 'doorOpen']) assert.ok(SLOT_IDS.has(id), id);
});

test('upload a sound, serve it, change its volume, reset it', () => {
  const s = store();
  assert.deepEqual(s.list().custom, {});
  assert.equal(s.upload('nope', 'audio/mpeg', Buffer.from('x')), 'unknown sound');
  assert.match(s.upload('pistol', 'text/html', Buffer.from('x')), /not an audio file/);
  assert.equal(s.upload('pistol', 'audio/mpeg', Buffer.from('ID3fake')), null);
  const { url, volume } = s.list().custom.pistol;
  assert.equal(volume, 1);
  assert.match(url, /^\/sounds\/file\/pistol\.mp3\?v=1$/);
  assert.equal(s.read('pistol.mp3').data.toString(), 'ID3fake');
  assert.equal(s.read('../manifest.json'), null, 'no path tricks');
  // A new upload in another format replaces it, with a new version.
  assert.equal(s.upload('pistol', 'audio/ogg', Buffer.from('OggS')), null);
  assert.match(s.list().custom.pistol.url, /pistol\.ogg\?v=2/);
  assert.equal(s.read('pistol.mp3'), null);
  assert.equal(s.setVolume('pistol', 5), null);
  assert.equal(s.list().custom.pistol.volume, 2, 'capped at 200%');
  // Volume alone works for built-in sounds too.
  assert.equal(s.setVolume('rain', 0.5), null);
  assert.deepEqual(s.list().custom.rain, { url: null, volume: 0.5 });
  assert.equal(s.reset('pistol'), null);
  assert.equal(s.list().custom.pistol, undefined);
  // It survives a restart.
  const again = new SoundStore(s.dir);
  assert.equal(again.list().custom.rain.volume, 0.5);
});

