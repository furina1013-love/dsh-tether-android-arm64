import { schemaTokenCount } from './tokens.js';
import { toolName } from './names.js';
import { activateParameters, activateOutput } from './tool-defs.js';

const CAPABILITIES = ['document', 'patch'];

/**
 * Always-visible control plane: progressive disclosure plus a manual
 * checkpoint. Advanced tool definitions exist as factories, so they cost zero
 * schema tokens until enabled.
 */
export function createActivateTool({ ctx, config, budget, advancedFactories, checkpoint, logger }) {
  const active = new Map();

  function costOf(capability) {
    const factory = advancedFactories[capability];
    if (factory === undefined) return undefined;
    return schemaTokenCount(factory());
  }

  function activeNames() {
    return [...active.keys()];
  }

  function summary(ok, text, extra = {}) {
    return {
      ok,
      text,
      active: activeNames(),
      schemaTokens: budget.used,
      schemaBudget: budget.limit,
      ...extra
    };
  }

  function listText() {
    const lines = [`schema ~${budget.used}/${budget.limit} tok; core tools are always on`];
    for (const capability of CAPABILITIES) {
      const cost = costOf(capability);
      const state = active.has(capability) ? 'active' : 'hidden';
      lines.push(`${capability}: ${state}, +${cost} tok on enable`);
    }
    lines.push('enable registers a tool for the next request; disable removes it again.');
    return lines.join('\n');
  }

  return {
    name: toolName('activate'),
    description: 'List, enable, or disable optional tools; schemas stay out of requests until enabled. Also creates a manual git checkpoint. Enabled tools appear next step.',
    parameters: activateParameters,
    output: {
      schema: activateOutput,
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    async execute(args, exec) {
      const action = args.action;
      if (action === 'list' || action === 'status') {
        return summary(true, listText());
      }
      if (action === 'checkpoint') {
        const result = await checkpoint(exec);
        const detail = result.status === 'committed'
          ? `committed ${result.commit ?? '(unknown hash)'} · ${result.message ?? ''}`
          : `${result.status}: ${result.reason ?? result.message ?? 'no detail'}`;
        return summary(result.status !== 'failed', `checkpoint ${detail}`, result.commit === undefined ? {} : { commit: result.commit });
      }
      if (action !== 'enable' && action !== 'disable') throw new Error(`unsupported action "${String(action)}"`);
      const capability = args.capability;
      if (typeof capability !== 'string' || !CAPABILITIES.includes(capability)) {
        return summary(false, `capability must be one of: ${CAPABILITIES.join(', ')}`);
      }
      if (action === 'enable') {
        if (active.has(capability)) return summary(true, `${capability} is already active (+0 tok)`);
        const definition = advancedFactories[capability]();
        const cost = schemaTokenCount(definition);
        if (budget.used + cost > budget.limit) {
          logger?.warn?.(() => `tether: schema budget blocks ${capability} (${budget.used}+${cost}>${budget.limit})`);
          return summary(false, `schema budget would be exceeded: ${budget.used} used + ${cost} for ${capability} > ${budget.limit}. Disable another capability or raise schemaBudget.`);
        }
        const dispose = ctx.tools.register(definition);
        active.set(capability, { dispose, cost, name: definition.name });
        budget.used += cost;
        budget.tools.set(definition.name, { cost, dispose });
        logger?.info?.(() => `tether: enabled ${capability} (${definition.name}, +${cost} schema tok)`);
        return summary(true, `enabled ${capability} (+${cost} schema tok); it becomes callable on the next step and stays until disabled or the plugin unloads.`);
      }
      const entry = active.get(capability);
      if (entry === undefined) return summary(true, `${capability} is already hidden (+0 tok)`);
      entry.dispose();
      active.delete(capability);
      budget.used = Math.max(0, budget.used - entry.cost);
      budget.tools.delete(entry.name);
      logger?.info?.(() => `tether: disabled ${capability} (-${entry.cost} schema tok)`);
      return summary(true, `disabled ${capability} (-${entry.cost} schema tok); its tool is removed from the next request.`);
    }
  };
}
