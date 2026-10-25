import test from 'node:test';
import assert from 'node:assert/strict';
import { compressPayload, fitText } from '../src/compress.js';
import { initTokenizer, tokenCount } from '../src/tokens.js';

await initTokenizer();

test('text compression keeps head and tail under the budget', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const result = compressPayload(text, { budget: 400, path: 'app.log' });
  assert.equal(result.kind, 'text');
  assert.ok(result.text.includes('line 0'));
  assert.ok(result.text.includes('line 1999'));
  assert.ok(result.text.includes('omitted'));
  assert.ok(result.tokens <= 420, `got ${result.tokens} tokens`);
  assert.ok(result.saved > 0);
});

test('json compression preserves key skeleton and reports savings', () => {
  const value = { users: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `user${i}` })), total: 100 };
  const result = compressPayload(JSON.stringify(value), { budget: 200, path: 'users.json' });
  assert.equal(result.kind, 'json');
  assert.ok(result.text.includes('users'));
  assert.ok(result.text.includes('more'));
  assert.ok(result.tokens <= 200);
  assert.ok(result.saved > 0);
});

test('csv compression keeps header and samples', () => {
  const rows = ['id,name,score', ...Array.from({ length: 100 }, (_, i) => `${i},user${i},${i * 3}`)];
  const result = compressPayload(rows.join('\n'), { budget: 200, path: 'scores.csv' });
  assert.equal(result.kind, 'csv');
  assert.ok(result.text.includes('id,name,score'));
  assert.ok(result.text.includes('user99'));
  assert.ok(result.text.includes('omitted'));
  assert.ok(result.tokens <= 200);
});

test('invalid json fails open as text', () => {
  const text = '{not json ' + 'z'.repeat(5000);
  const result = compressPayload(text, { budget: 100, path: 'broken.json' });
  assert.ok(typeof result.text === 'string');
  assert.ok(result.text.length > 0);
  assert.equal(result.kind, 'text');
});

test('empty and zero-budget inputs do not throw', () => {
  assert.equal(compressPayload('', { budget: 10 }).tokens, 0);
  const zero = compressPayload('hello world', { budget: 0 });
  assert.ok(zero.text.length > 0);
  assert.equal(zero.tokens, tokenCount(zero.text));
});

test('fitText respects a tight budget', () => {
  const fitted = fitText(Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n'), 80);
  assert.ok(tokenCount(fitted.text) <= 90, `got ${tokenCount(fitted.text)}`);
});
