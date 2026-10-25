import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config.js';
import { createActivateTool } from '../src/activate.js';
import { createPatchTool } from '../src/patch.js';
import { RefStore } from '../src/refs.js';
import { initTokenizer } from '../src/tokens.js';

await initTokenizer();
const config = Config({});
const patchTool = createPatchTool({ ctx: {}, config, refs: new RefStore() });

test('schema budget blocks an advanced tool before registration', async () => {
  const budget = { used: 800, limit: 900, tools: new Map() };
  let registered = 0;
  const tool = createActivateTool({
    ctx: { tools: { register: () => { registered += 1; return () => {}; } } },
    config,
    budget,
    advancedFactories: { patch: () => patchTool },
    checkpoint: async () => ({ status: 'skipped', reason: 'test' }),
    logger: {}
  });
  const result = await tool.execute({ action: 'enable', capability: 'patch' }, {});
  assert.equal(result.ok, false);
  assert.match(result.text, /schema budget/);
  assert.equal(registered, 0);
  assert.equal(budget.used, 800);
});

test('disable subtracts the schema cost and is idempotent', async () => {
  const budget = { used: 600, limit: 900, tools: new Map() };
  let disposed = 0;
  const tool = createActivateTool({
    ctx: { tools: { register: () => () => { disposed += 1; } } },
    config,
    budget,
    advancedFactories: { patch: () => patchTool },
    checkpoint: async () => ({ status: 'skipped', reason: 'test' }),
    logger: {}
  });
  const enabled = await tool.execute({ action: 'enable', capability: 'patch' }, {});
  assert.equal(enabled.ok, true);
  assert.ok(budget.used > 600);
  const disabled = await tool.execute({ action: 'disable', capability: 'patch' }, {});
  assert.equal(disabled.ok, true);
  assert.equal(budget.used, 600);
  assert.equal(disposed, 1);
  const again = await tool.execute({ action: 'disable', capability: 'patch' }, {});
  assert.equal(again.ok, true);
  assert.equal(budget.used, 600);
});
