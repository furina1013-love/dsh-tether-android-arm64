import { compressPayload } from './compress.js';
import { tokenCount } from './tokens.js';
import { toolName } from './names.js';
import { patchParameters, patchOutput } from './tool-defs.js';

const MAX_EDIT_BYTES = 1024 * 1024;

/** Build the on-demand bounded multi-file literal editor. Preview is the default. */
export function createPatchTool({ ctx, config, refs }) {
  return {
    deferLoading: true,
    name: toolName('patch'),
    description: 'Preview or apply bounded exact literal replacements across files. Preview reports match counts without writing; apply checks per-file versions and reports every failure without rollback.',
    parameters: patchParameters,
    output: {
      schema: patchOutput,
      render: (_args, value) => [{ type: 'text', text: `${value.mode} · ${value.files.length} file${value.files.length === 1 ? '' : 's'} · saved ~${value.saved} tok${value.ref ? ` · ${value.ref}` : ''}\n${value.text}` }]
    },
    async execute(args, exec) {
      if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error('edits must contain at least one edit');
      if (args.edits.length > config.maxBatchOps) throw new Error(`at most ${config.maxBatchOps} edits per call`);
      const mode = args.mode === 'apply' ? 'apply' : 'preview';
      const cwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const files = [];
      const report = [];
      for (const edit of args.edits) {
        const path = String(edit?.path ?? '');
        if (path.length === 0 || typeof edit?.oldString !== 'string' || edit.oldString.length === 0 || typeof edit?.newString !== 'string') {
          files.push({ path, replacements: 0, status: 'failed', error: 'path, non-empty oldString, and newString are required' });
          continue;
        }
        try {
          const target = await ctx.fs.resolve(path, { cwd, signal: exec.signal });
          const info = await ctx.fs.stat(target, exec.signal);
          if (info === undefined) throw new Error('file not found');
          if (info.type !== 'file') throw new Error('not a regular file');
          if (typeof info.size === 'number' && info.size > MAX_EDIT_BYTES) throw new Error(`file is ${info.size} bytes, above the ${MAX_EDIT_BYTES}-byte edit limit`);
          const text = await ctx.fs.readText(target, exec.signal);
          const count = countMatches(text, edit.oldString);
          const selected = edit.replaceAll === true ? count : Math.min(count, 1);
          if (mode === 'preview') {
            files.push({ path, replacements: selected, status: count > 0 ? 'preview' : 'skipped', ...(count === 0 ? { error: 'no matches' } : {}) });
            report.push(`${path}: ${count} match${count === 1 ? '' : 'es'}${count > 0 ? `; would replace ${selected}` : '; no change'}`);
            continue;
          }
          if (count === 0) {
            files.push({ path, replacements: 0, status: 'skipped', error: 'no matches' });
            report.push(`${path}: skipped (no matches)`);
            continue;
          }
          await ctx.fs.editText(target, {
            oldString: edit.oldString,
            newString: edit.newString,
            replaceAll: edit.replaceAll === true
          }, { kind: 'replaceIfVersion', version: info.version }, exec.signal);
          files.push({ path, replacements: selected, status: 'applied' });
          report.push(`${path}: replaced ${selected}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          files.push({ path, replacements: 0, status: 'failed', error: message });
          report.push(`${path}: ERROR ${message}`);
        }
      }
      const full = report.join('\n') || '(no edits)';
      const stored = refs.put(full, { kind: 'patch', mode, files });
      const compressed = compressPayload(full, { budget: config.maxResultTokens, path: '.txt' });
      return {
        mode,
        text: compressed.text,
        files,
        ...(stored.ref === undefined ? {} : { ref: stored.ref }),
        truncated: compressed.truncated,
        saved: Math.max(0, (stored.tokens ?? compressed.originalTokens) - tokenCount(compressed.text))
      };
    }
  };
}

function countMatches(text, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}
