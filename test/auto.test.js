import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoCheckpoint } from '../index.js';

test('auto checkpoint interval and completed-turn guard', () => {
  assert.equal(shouldAutoCheckpoint(1, undefined, 1), true);
  assert.equal(shouldAutoCheckpoint(2, 1, 1), true);
  assert.equal(shouldAutoCheckpoint(2, 1, 2), false);
  assert.equal(shouldAutoCheckpoint(3, 1, 2), true);
  assert.equal(shouldAutoCheckpoint(3, 1, 0), false);
  assert.equal(shouldAutoCheckpoint(Number.NaN, 1, 1), false);
});
