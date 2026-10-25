import Schema from '@deepseek-ai/schemastery';
import { PLUGIN_NAME } from './names.js';

/**
 * Plugin configuration. Defaults are declared here, not in apply().
 * Every object/array limit is a hard ceiling in the code that consumes it.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  // Token budget for tools this plugin exposes to the model (not all of DSH).
  schemaBudget: Schema.natural().min(400).max(20000).default(900),
  // Allow one call to run several independent read-only operations.
  batchEnabled: Schema.boolean().default(true),
  // Hard per-result budget; the batch total gets a small multiple of this.
  maxResultTokens: Schema.natural().min(80).max(4000).default(320),
  // Completed turns between automatic checkpoints; 0 disables automatic saves.
  autoSaveInterval: Schema.natural().min(0).max(1000).default(1),
  // One-line prefix on every checkpoint commit.
  commitPrefix: Schema.string().default('[dsh-tether]'),
  // Per-call ceiling on the number of batch items and patch edits.
  maxBatchOps: Schema.natural().min(1).max(16).default(8),
  // Create a repository in the session workspace when none exists.
  autoInit: Schema.boolean().default(false),
  // In-memory, content-addressed result cache size.
  refCacheSize: Schema.natural().min(0).max(1000).default(128)
});
