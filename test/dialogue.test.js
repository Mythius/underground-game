import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIALOGUE, DialogueStore } from '../src/dialogue.js';

test('every kind of line has built-in lines; edits are cleaned, saved and can be reset', () => {
  const ids = DIALOGUE.flatMap((g) => g.kinds.map((k) => k.id));
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  for (const g of DIALOGUE) for (const k of g.kinds) assert.ok(k.lines.length > 0, k.id);
  for (const id of ['robbed', 'robShop', 'robBank', 'copArrest', 'goon', 'guard', 'hitman']) assert.ok(ids.includes(id), id);

  const file = join(mkdtempSync(join(tmpdir(), 'dlg-')), 'sub', 'dialogue.json');
  const store = new DialogueStore(file);
  assert.deepEqual(store.list().custom, {});
  assert.equal(store.set('nope', ['x']), 'unknown kind of line');
  assert.equal(store.set('greet', ['  ', '']), 'give it at least one line');
  assert.equal(store.set('greet', ['  Hello\tthere  ', 'x'.repeat(200), 'Bye', 42]), null);
  const saved = store.list().custom.greet;
  assert.equal(saved[0], 'Hello there', 'tidied');
  assert.equal(saved[1].length, 90, 'cut to length');
  assert.equal(saved.length, 3, 'non-strings dropped');
  assert.deepEqual(new DialogueStore(file).list().custom.greet, saved, 'kept on disk');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).greet);
  assert.equal(store.reset('greet'), null);
  assert.equal(store.list().custom.greet, undefined);
});
