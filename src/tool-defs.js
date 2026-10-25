import { toolName } from './names.js';

/**
 * Wire schemas only. They deliberately avoid type unions, minItems/maxItems,
 * pattern, and other keywords outside the DSH JSON Schema subset; bounds are
 * enforced in execute() and stated in descriptions.
 */

const opItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['read', 'grep', 'list', 'stat', 'fetch'], description: 'Operation to run (fetch reads a saved ref).' },
    path: { type: 'string', description: 'Path for read/grep/list/stat; relative paths use session cwd.' },
    pattern: { type: 'string', description: 'JavaScript regex for grep (required for grep).' },
    include: { type: 'string', description: 'Grep file filter, e.g. *.js.' },
    ignoreCase: { type: 'boolean', description: 'Case-insensitive grep.' },
    ref: { type: 'string', description: 'Ref from an earlier result (required for fetch).' },
    offset: { type: 'integer', description: '0-based first line for read/fetch; negatives clamp to 0.' },
    limit: { type: 'integer', description: 'Max lines for read/fetch.' },
    maxBytes: { type: 'integer', description: 'Per-op byte cap (clamped).' }
  },
  required: ['op']
};

const batchResultItem = {
  type: 'object',
  additionalProperties: false,
  properties: {
    i: { type: 'integer' },
    op: { type: 'string' },
    ok: { type: 'boolean' },
    path: { type: 'string' },
    text: { type: 'string' },
    ref: { type: 'string' },
    truncated: { type: 'boolean' },
    deduped: { type: 'boolean' },
    saved: { type: 'integer' }
  },
  required: ['i', 'op', 'ok', 'text', 'truncated', 'saved']
};

export const batchParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ops: {
      type: 'array',
      description: 'Independent operations run in one call; per-call count and total output are bounded.',
      items: opItem
    }
  },
  required: ['ops']
};

export const batchOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: { type: 'array', items: batchResultItem },
    tokens: { type: 'integer' },
    saved: { type: 'integer' },
    budget: { type: 'integer' }
  },
  required: ['results', 'tokens', 'saved', 'budget']
};

export const activateParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'enable', 'disable', 'status', 'checkpoint'],
      description: 'list capabilities, enable/disable one, status, or checkpoint.'
    },
    capability: {
      type: 'string',
      enum: ['document', 'patch'],
      description: 'For enable/disable: document reads PDF/DOCX/text; patch edits files literally.'
    }
  },
  required: ['action']
};

export const activateOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    active: { type: 'array', items: { type: 'string' } },
    schemaTokens: { type: 'integer' },
    schemaBudget: { type: 'integer' },
    commit: { type: 'string' }
  },
  required: ['ok', 'text', 'active', 'schemaTokens', 'schemaBudget']
};

export const documentParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'PDF, DOCX, or UTF-8 text file to read.' },
    format: { type: 'string', enum: ['auto', 'text', 'docx', 'pdf'], description: 'Parser override; auto uses the extension.' },
    offset: { type: 'integer', description: '0-based character offset in extracted text.' },
    maxChars: { type: 'integer', description: 'Max extracted characters (bounded).' }
  },
  required: ['path']
};

export const documentOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    kind: { type: 'string' },
    ref: { type: 'string' },
    truncated: { type: 'boolean' },
    saved: { type: 'integer' },
    note: { type: 'string' }
  },
  required: ['text', 'kind', 'truncated', 'saved']
};

export const patchParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['preview', 'apply'], description: 'preview (default) reports matches without writing; apply writes them.' },
    edits: {
      type: 'array',
      description: 'Literal replacements; per-call limit enforced. Preview first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'File to edit.' },
          oldString: { type: 'string', description: 'Exact non-empty literal text to replace.' },
          newString: { type: 'string', description: 'Replacement text.' },
          replaceAll: { type: 'boolean', description: 'Replace all occurrences; default replaces one.' }
        },
        required: ['path', 'oldString', 'newString']
      }
    }
  },
  required: ['edits']
};

export const patchOutput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string' },
    text: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          replacements: { type: 'integer' },
          status: { type: 'string' },
          error: { type: 'string' }
        },
        required: ['path', 'replacements', 'status']
      }
    },
    ref: { type: 'string' },
    truncated: { type: 'boolean' },
    saved: { type: 'integer' }
  },
  required: ['mode', 'text', 'files', 'truncated', 'saved']
};

export const CORE_TOOL_NAMES = {
  batch: toolName('batch'),
  activate: toolName('activate')
};

export const ADVANCED_TOOL_NAMES = {
  document: toolName('document'),
  patch: toolName('patch')
};
