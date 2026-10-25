import test from 'node:test';
import assert from 'node:assert/strict';
import { RefStore } from '../src/refs.js';

test('refs are content addressed and deduplicated', () => {
  const store = new RefStore({ maxEntries: 4 });
  const first = store.put('same body', { path: 'a' });
  const second = store.put('same body', { path: 'b' });
  assert.equal(first.ref, second.ref);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.size, 1);
  assert.equal(store.get(first.ref).body, 'same body');
});

test('refs evict by entry count and stay bounded', () => {
  const store = new RefStore({ maxEntries: 2 });
  store.put('one');
  store.put('two');
  store.put('three');
  assert.equal(store.size, 2);
  assert.equal(store.has(RefStore.idFor('one')), false);
});
