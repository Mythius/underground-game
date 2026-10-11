import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RadioStore, radioAt } from '../src/radio.js';

/** A short silent mp3 made with ffmpeg (`sec` long). */
function mp3(sec) {
  const dir = mkdtempSync(join(tmpdir(), 'mp3-'));
  const file = join(dir, 'a.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=22050:cl=mono`, '-t', String(sec), '-q:a', '9', file]);
  return readFileSync(file);
}

test('the playlist: upload as many songs as you like (lengths measured), rename, reorder, delete', async () => {
  const store = new RadioStore(`${mkdtempSync(join(tmpdir(), 'radio-'))}/`);
  assert.equal(await store.add('Kino — Gruppa krovi', 'audio/mpeg', mp3(2)), null);
  assert.equal(await store.add('  Song\ttwo ', 'audio/mpeg', mp3(3)), null);
  assert.equal(await store.add('three', 'audio/mpeg', mp3(1)), null);
  assert.equal(await store.add('nope', 'text/plain', Buffer.from('hi')), 'not an audio file (mp3, ogg, wav, m4a, webm or flac)');
  const list = store.list();
  assert.deepEqual(list.map((s) => s.name), ['Kino — Gruppa krovi', 'Song two', 'three']);
  assert.ok(Math.abs(list[0].duration - 2) < 0.2 && Math.abs(list[1].duration - 3) < 0.2, `measured: ${list.map((s) => s.duration)}`);
  assert.ok(store.file(list[0].url.split('/').pop()), 'streamable');
  assert.equal(store.file('../playlist.json'), null);
  assert.equal(store.update(list[2].id, { to: 0, name: 'First now' }), null);
  assert.deepEqual(store.list().map((s) => s.name), ['First now', 'Kino — Gruppa krovi', 'Song two']);
  assert.equal(store.remove(list[1].id), null);
  assert.equal(store.list().length, 2);
  assert.deepEqual(new RadioStore(store.dir).list().map((s) => s.name), ['First now', 'Kino — Gruppa krovi'], 'kept on disk');
});

test('a radio plays through the playlist in order: which song, and how far in', () => {
  const d = [10, 20, 5];
  assert.deepEqual(radioAt(0, 3, d), { index: 0, offset: 3 });
  assert.deepEqual(radioAt(0, 12, d), { index: 1, offset: 2 });
  assert.deepEqual(radioAt(1, 22, d), { index: 2, offset: 2 });
  assert.deepEqual(radioAt(2, 6, d), { index: 0, offset: 1 }, 'round to the start again');
  assert.deepEqual(radioAt(4, 0, []), { index: 4, offset: 0 }, 'no playlist: the number stands');
});
