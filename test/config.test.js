import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config.js';

test('config defaults are declared in the schema', () => {
  const config = Config({});
  assert.equal(config.enabled, true);
  assert.equal(config.schemaBudget, 900);
  assert.equal(config.batchEnabled, true);
  assert.equal(config.maxResultTokens, 320);
  assert.equal(config.autoSaveInterval, 1);
  assert.equal(config.commitPrefix, '[dsh-tether]');
  assert.equal(config.maxBatchOps, 8);
  assert.equal(config.autoInit, false);
});

test('config overrides and rejects out-of-range values', () => {
  const config = Config({ maxResultTokens: 1200, commitPrefix: '[ci]' });
  assert.equal(config.maxResultTokens, 1200);
  assert.equal(config.commitPrefix, '[ci]');
  assert.throws(() => Config({ maxBatchOps: 0 }));
  assert.throws(() => Config({ schemaBudget: 10 }));
});
