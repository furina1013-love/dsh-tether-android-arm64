import { Config } from './src/config.js';
import { PLUGIN_NAME } from './src/names.js';
import { initTokenizer, hasExactTokenizer, schemaTokenCount } from './src/tokens.js';
import { RefStore } from './src/refs.js';
import { CheckpointStore, resolveDshHome } from './src/git-checkpoint.js';
import { assertToolSchema } from './src/schema-check.js';
import { createBatchTool } from './src/batch.js';
import { createActivateTool } from './src/activate.js';
import { createDocumentTool } from './src/document.js';
import { createPatchTool } from './src/patch.js';

/** Stable Loader identity. */
export const name = PLUGIN_NAME;
/** Host services this plugin needs. */
export const inject = ['tools', 'fs', 'workingDirectory'];
/** Validated configuration with defaults. */
export { Config };

export function shouldAutoCheckpoint(turn, lastTurn, interval) {
  if (!Number.isFinite(turn) || !Number.isFinite(interval) || interval < 1) return false;
  if (lastTurn === undefined || lastTurn === null) return true;
  return turn - lastTurn >= interval;
}

function latestSessionCwd(session) {
  let cwd = session.header?.cwd;
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type === 'working-directory/change' && typeof event.data?.cwd === 'string') cwd = event.data.cwd;
    }
  } catch {
    // Fall back to the header cwd when the session projection is unavailable.
  }
  return cwd;
}

function lastTurnOf(session) {
  let turn = 0;
  try {
    for (const event of session.snapshotEvents()) {
      if (event.type === 'turn/start' && typeof event.data?.turn === 'number') turn = Math.max(turn, event.data.turn);
    }
  } catch {
    // A missing projection only costs a less precise commit message.
  }
  return turn;
}

/**
 * Host plugin: two core tools, on-demand advanced schemas, and an automatic
 * checkpoint after a completed turn. The checkpoint listener deliberately
 * observes the durable session event instead of guessing a turn-end hook name
 * from another package.
 */
export async function apply(ctx, rawConfig) {
  const config = Config(rawConfig ?? {});
  if (!config.enabled) {
    ctx.logger?.info?.(`${PLUGIN_NAME}: disabled by configuration`);
    return;
  }

  const logger = {
    info: (message) => ctx.logger?.info?.(typeof message === 'function' ? message() : message),
    warn: (message) => ctx.logger?.warn?.(typeof message === 'function' ? message() : message)
  };

  await initTokenizer(logger);
  const refs = new RefStore({ maxEntries: config.refCacheSize });
  const store = new CheckpointStore({ home: resolveDshHome(), pluginName: PLUGIN_NAME, logger });
  await store.init();

  const budget = { used: 0, limit: config.schemaBudget, tools: new Map() };
  let disposed = false;

  async function manualCheckpoint(exec) {
    if (exec.agent === undefined) return { status: 'failed', reason: 'no-agent', message: 'checkpoint requires an agent Session' };
    try {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const session = exec.agent.session;
      return await store.checkpoint({
        cwd,
        sessionId: String(session.header.id),
        turn: lastTurnOf(session),
        prefix: config.commitPrefix,
        autoInit: config.autoInit,
        automatic: false
      });
    } catch (error) {
      return { status: 'failed', reason: 'checkpoint-error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  const advancedFactories = {
    document: () => createDocumentTool({ ctx, config, refs }),
    patch: () => createPatchTool({ ctx, config, refs })
  };
  const activateTool = createActivateTool({
    ctx,
    config,
    budget,
    advancedFactories,
    checkpoint: manualCheckpoint,
    logger
  });
  const batchTool = createBatchTool({ ctx, config, refs, logger });
  const coreTools = [batchTool, activateTool];

  for (const definition of coreTools) {
    assertToolSchema(definition);
    const cost = schemaTokenCount(definition);
    const dispose = ctx.tools.register(definition);
    budget.used += cost;
    budget.tools.set(definition.name, { cost, dispose });
  }
  if (budget.used > budget.limit) {
    logger.warn(`${PLUGIN_NAME}: core schemas use ~${budget.used} tokens, above schemaBudget ${budget.limit}; advanced activation stays blocked until the budget is raised`);
  }
  logger.info(`${PLUGIN_NAME}: ready; core schema ~${budget.used}/${budget.limit} tok; tokenizer=${hasExactTokenizer() ? 'js-tiktoken' : 'fallback'}`);

  const cwdBySession = new Map();
  const inFlight = new Set();
  const onSessionEvent = (session, event) => {
    if (disposed) return;
    const sessionId = String(session.id);
    if (event.type === 'working-directory/change') {
      if (typeof event.data?.cwd === 'string') cwdBySession.set(sessionId, event.data.cwd);
      return;
    }
    if (event.type !== 'turn/end') return;
    if (event.data?.reason?.kind !== 'completed') return;
    const turn = event.data.turn;
    const previous = store.getSession(sessionId);
    if (!shouldAutoCheckpoint(turn, previous?.lastTurn, config.autoSaveInterval)) return;
    const cwd = cwdBySession.get(sessionId) ?? latestSessionCwd(session);
    if (typeof cwd !== 'string' || cwd.length === 0) return;
    const key = `${sessionId}:${turn}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    void store.checkpoint({
      cwd,
      sessionId,
      turn,
      prefix: config.commitPrefix,
      autoInit: config.autoInit,
      automatic: true
    }).then((result) => {
      if (result.status === 'committed') logger.info(`${PLUGIN_NAME}: checkpoint ${result.commit ?? ''} ${result.message ?? ''}`);
      else if (result.status === 'failed') logger.warn(`${PLUGIN_NAME}: checkpoint failed: ${result.reason} ${result.message ?? ''}`);
    }).catch((error) => {
      logger.warn(`${PLUGIN_NAME}: checkpoint threw: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => inFlight.delete(key));
  };
  ctx.on('session/event', onSessionEvent);
  ctx.effect(() => () => {
    disposed = true;
    refs.clear();
  }, `${PLUGIN_NAME} cleanup`);
}
