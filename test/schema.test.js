import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../src/config.js';
import { assertToolSchema, validateSchemaNode } from '../src/schema-check.js';
import { createBatchTool } from '../src/batch.js';
import { createActivateTool } from '../src/activate.js';
import { createDocumentTool } from '../src/document.js';
import { createPatchTool } from '../src/patch.js';
import { RefStore } from '../src/refs.js';

const config = Config({});
const refs = new RefStore();
const documentTool = createDocumentTool({ ctx: {}, config, refs });
const patchTool = createPatchTool({ ctx: {}, config, refs });
const batchTool = createBatchTool({ ctx: {}, config, refs, logger: {} });
const activateTool = createActivateTool({
  ctx: {},
  config,
  budget: { used: 0, limit: config.schemaBudget, tools: new Map() },
  advancedFactories: { document: () => documentTool, patch: () => patchTool },
  checkpoint: async () => ({ status: 'skipped', reason: 'test' }),
  logger: {}
});

test('all shipped tools satisfy the DSH schema traps', () => {
  for (const tool of [batchTool, activateTool, documentTool, patchTool]) {
    assert.doesNotThrow(() => assertToolSchema(tool), tool.name);
    assert.ok(tool.name.startsWith('tether_'));
  }
});

test('object without additionalProperties is rejected', () => {
  assert.throws(() => validateSchemaNode({ type: 'object', properties: {} }), /additionalProperties/);
});

test('union type array is rejected', () => {
  assert.throws(() => validateSchemaNode({ type: ['string', 'null'] }), /single type/);
});

test('nested object must also declare additionalProperties', () => {
  assert.throws(() => validateSchemaNode({
    type: 'object',
    additionalProperties: false,
    properties: { nested: { type: 'object', properties: {} } }
  }), /additionalProperties/);
});

test('schema makes optional fields absent rather than nullable', () => {
  const json = JSON.stringify(batchTool.parameters);
  assert.equal(json.includes('"null"'), false);
});
