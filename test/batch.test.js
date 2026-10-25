import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchTool } from '../src/batch.js';
import { Config } from '../src/config.js';
import { RefStore } from '../src/refs.js';
import { initTokenizer } from '../src/tokens.js';

await initTokenizer();

function fixture(maxResultTokens = 200) {
  const content = Array.from({ length: 60 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const ctx = {
    fs: {
      resolve: async (path) => ({ displayPath: path, targetKey: path }),
      stat: async () => ({ type: 'file', size: content.length, version: 'v1' }),
      readText: async () => content,
      listDir: async () => []
    },
    workingDirectory: { ensure: async () => '/tmp' }
  };
  const tool = createBatchTool({ ctx, config: Config({ maxResultTokens }), refs: new RefStore(), logger: {} });
  return { tool, content };
}

test('batch deduplicates full reads and applies line windows', async () => {
  const { tool, content } = fixture();
  const result = await tool.execute({ ops: [
    { op: 'read', path: 'a.txt' },
    { op: 'read', path: 'a.txt' },
    { op: 'read', path: 'a.txt', limit: 2 }
  ] }, { agent: {}, signal: new AbortController().signal });
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].deduped, true);
  assert.match(result.results[1].text, /duplicate of #0/);
  assert.equal(result.results[2].ok, true);
  assert.ok(result.results[2].text.startsWith('line 0'));
  assert.ok(result.results[2].text.startsWith(content.split('\n')[0]));
});

test('a failed op does not fail the batch', async () => {
  const { tool } = fixture();
  const result = await tool.execute({ ops: [
    { op: 'grep', path: 'a.txt', pattern: '(' },
    { op: 'stat', path: 'a.txt' }
  ] }, { agent: {}, signal: new AbortController().signal });
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].text, /ERROR/);
  assert.equal(result.results[1].ok, true);
});
test('a line-window read does not poison the full-read cache', async () => {
  const { tool } = fixture();
  const result = await tool.execute({ ops: [
    { op: 'read', path: 'a.txt', limit: 2 },
    { op: 'read', path: 'a.txt' }
  ] }, { agent: {}, signal: new AbortController().signal });
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, true);
  assert.equal(result.results[1].deduped, undefined);
  assert.match(result.results[1].text, /line 59/);
});

function exec() {
  return { agent: {}, signal: new AbortController().signal };
}

test('the batch total budget is 1x for one op and 1.5x for several', async () => {
  const single = await fixture(200).tool.execute({ ops: [{ op: 'stat', path: 'a.txt' }] }, exec());
  assert.equal(single.budget, 200);
  const multi = await fixture(200).tool.execute({ ops: [
    { op: 'read', path: 'a.txt' },
    { op: 'stat', path: 'a.txt' }
  ] }, exec());
  assert.equal(multi.budget, 300);
  // The 1.5x factor is floored so the total budget stays a whole token count.
  const odd = await fixture(333).tool.execute({ ops: [
    { op: 'read', path: 'a.txt' },
    { op: 'stat', path: 'a.txt' }
  ] }, exec());
  assert.equal(odd.budget, 499);
});

test('over-budget results are fitted to the total budget', async () => {
  const { tool } = fixture(80);
  const result = await tool.execute({ ops: [
    { op: 'read', path: 'a.txt', limit: 40 },
    { op: 'read', path: 'a.txt', offset: 20 }
  ] }, exec());
  assert.equal(result.budget, 120);
  assert.ok(result.tokens <= result.budget, `~${result.tokens} tokens exceeds the ${result.budget} budget`);
  assert.ok(result.results.every((item) => item.truncated));
});

test('an unchanged read is cached for 30 minutes and re-read after that', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { tool } = fixture();
  const ctx = exec();
  const first = await tool.execute({ ops: [{ op: 'read', path: 'a.txt' }] }, ctx);
  assert.equal(first.results[0].deduped, undefined);
  assert.match(first.results[0].text, /line 0 /);

  t.mock.timers.tick(29 * 60 * 1000);
  const hit = await tool.execute({ ops: [{ op: 'read', path: 'a.txt' }] }, ctx);
  assert.equal(hit.results[0].deduped, true);
  assert.match(hit.results[0].text, /unchanged/);

  t.mock.timers.tick(2 * 60 * 1000);
  const expired = await tool.execute({ ops: [{ op: 'read', path: 'a.txt' }] }, ctx);
  assert.equal(expired.results[0].deduped, undefined);
  assert.match(expired.results[0].text, /line 0 /);
});
