import { isAbsolute, relative } from 'node:path';
import { tokenCount } from './tokens.js';
import { compressPayload, fitText } from './compress.js';
import { toolName } from './names.js';
import { batchParameters, batchOutput } from './tool-defs.js';

const READ_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const HARD_MAX_BYTES = 2 * 1024 * 1024;
const MAX_GREP_MATCHES = 80;
const MAX_WALK_FILES = 400;
const MAX_WALK_DEPTH = 8;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm-store', '.cache', 'dist', 'build', 'coverage', '.next', '.turbo']);

/** Build the always-visible bounded batch tool. */
export function createBatchTool({ ctx, config, refs, logger }) {
  const readCache = new Map();

  function showPath(cwd, target) {
    const value = target.displayPath ?? target.targetKey;
    if (typeof value !== 'string') return String(value ?? '');
    if (!isAbsolute(value)) return value;
    const rel = relative(cwd, value);
    return rel.length === 0 ? '.' : rel;
  }

  async function resolve(cwd, path, exec) {
    if (typeof path !== 'string' || path.trim().length === 0) throw new Error('path is required for this operation');
    return ctx.fs.resolve(path, { cwd, signal: exec.signal });
  }

  async function textOf(target, exec, maxBytes) {
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined) throw new Error('path not found');
    if (info.type !== 'file') throw new Error('not a regular file');
    if (typeof info.size === 'number' && info.size > maxBytes) {
      throw new Error(`file is ${info.size} bytes, above the ${maxBytes}-byte limit; use a smaller file or document extraction`);
    }
    try {
      return { info, text: await ctx.fs.readText(target, exec.signal) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read as UTF-8 text (binary?): ${message}`);
    }
  }

  function sliceLines(text, offset = 0, limit = Number.MAX_SAFE_INTEGER) {
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
    const count = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : Number.MAX_SAFE_INTEGER);
    const selected = lines.slice(start, start + count);
    return { text: selected.join('\n'), start, totalLines: lines.length, returnedLines: selected.length };
  }

  function publish(text, meta, emittedRefs) {
    const stored = refs.put(text, meta);
    if (stored.ref === undefined) return { ref: undefined, tokens: stored.tokens, deduped: false };
    if (emittedRefs.has(stored.ref) && stored.duplicate) {
      return { ref: stored.ref, tokens: stored.tokens, deduped: true };
    }
    emittedRefs.add(stored.ref);
    return { ref: stored.ref, tokens: stored.tokens, deduped: false };
  }

  async function readOp(op, cwd, exec, emittedRefs) {
    const target = await resolve(cwd, op.path, exec);
    const path = showPath(cwd, target);
    const maxBytes = Math.max(1, Math.min(HARD_MAX_BYTES, Math.floor(op.maxBytes ?? DEFAULT_MAX_BYTES)));
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined) throw new Error('path not found');
    if (info.type !== 'file') throw new Error('not a regular file');
    const cached = readCache.get(target.targetKey);
    if (op.offset === undefined && op.limit === undefined && cached !== undefined && cached.version === info.version && refs.has(cached.ref) && Date.now() - cached.at < READ_CACHE_TTL_MS) {
      const text = `[unchanged; ${cached.ref} has ${cached.tokens} tokens — use fetch to view]`;
      return {
        path,
        ok: true,
        text,
        ref: cached.ref,
        truncated: false,
        deduped: true,
        sourceTokens: cached.tokens,
        saved: Math.max(0, cached.tokens - tokenCount(text))
      };
    }
    const read = await textOf(target, exec, maxBytes);
    const window = sliceLines(read.text, op.offset ?? 0, op.limit ?? Number.MAX_SAFE_INTEGER);
    const source = window.text;
    const published = publish(source, { kind: 'read', path, version: read.info.version }, emittedRefs);
    if (published.deduped) {
      const text = `[same content as ${published.ref}; use fetch to view]`;
      return { path, ok: true, text, ref: published.ref, truncated: false, deduped: true, sourceTokens: published.tokens, saved: Math.max(0, published.tokens - tokenCount(text)) };
    }
    const compressed = compressPayload(source, { budget: config.maxResultTokens, path });
    if (published.ref !== undefined && !published.deduped && op.offset === undefined && op.limit === undefined) {
      readCache.set(target.targetKey, { version: read.info.version, ref: published.ref, tokens: published.tokens, at: Date.now() });
    }
    return {
      path,
      ok: true,
      text: compressed.text.length > 0 ? compressed.text : '(empty)',
      ref: published.ref,
      truncated: compressed.truncated,
      sourceTokens: published.tokens,
      saved: compressed.saved
    };
  }

  async function grepFile(target, regex, displayPath, exec, matches, stats) {
    if (stats.files >= MAX_WALK_FILES) return;
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined || info.type !== 'file') return;
    if (typeof info.size === 'number' && info.size > 512 * 1024) return;
    stats.files += 1;
    stats.bytes += info.size ?? 0;
    if (stats.bytes > 4 * 1024 * 1024) return;
    let text;
    try {
      text = await ctx.fs.readText(target, exec.signal);
    } catch {
      return;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i += 1) {
      if (!regex.test(lines[i])) continue;
      const line = lines[i].length > 300 ? `${lines[i].slice(0, 300)}…` : lines[i];
      matches.push(`${displayPath}:${i + 1}: ${line.trimEnd()}`);
    }
  }

  async function walk(target, depth, includeRe, exec, onFile, stats) {
    if (stats.files >= MAX_WALK_FILES || depth > MAX_WALK_DEPTH) return;
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined) return;
    if (info.type === 'file') {
      if (includeRe === undefined || includeRe.test(target.displayPath ?? '')) await onFile(target);
      return;
    }
    if (info.type !== 'directory') return;
    const entries = await ctx.fs.listDir(target, exec.signal);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.type === 'directory' && SKIP_DIRS.has(entry.name)) continue;
      if (entry.type === 'directory') {
        await walk(entry.target, depth + 1, includeRe, exec, onFile, stats);
      } else if (entry.type === 'file' && (includeRe === undefined || includeRe.test(entry.name))) {
        await onFile(entry.target);
      }
      if (stats.files >= MAX_WALK_FILES) break;
    }
  }

  async function grepOp(op, cwd, exec, emittedRefs) {
    if (typeof op.pattern !== 'string' || op.pattern.length === 0) throw new Error('pattern is required for grep');
    let regex;
    try {
      regex = new RegExp(op.pattern, op.ignoreCase === true ? 'i' : '');
    } catch (error) {
      throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    const target = await resolve(cwd, op.path ?? '.', exec);
    const includeRe = typeof op.include === 'string' && op.include.length > 0 ? globToRegExp(op.include) : undefined;
    const matches = [];
    const stats = { files: 0, bytes: 0 };
    const onFile = async (file) => {
      await grepFile(file, regex, showPath(cwd, file), exec, matches, stats);
    };
    await walk(target, 0, includeRe, exec, onFile, stats);
    const text = matches.length === 0 ? '(no matches)' : matches.join('\n');
    const published = publish(text, { kind: 'grep', path: showPath(cwd, target) }, emittedRefs);
    const compressed = compressPayload(text, { budget: config.maxResultTokens, path: '.txt' });
    return {
      path: showPath(cwd, target),
      ok: true,
      text: compressed.text,
      ref: published.ref,
      truncated: compressed.truncated || matches.length >= MAX_GREP_MATCHES,
      sourceTokens: published.tokens,
      saved: compressed.saved,
      deduped: published.deduped
    };
  }

  async function listOp(op, cwd, exec, emittedRefs) {
    const target = await resolve(cwd, op.path ?? '.', exec);
    const info = await ctx.fs.stat(target, exec.signal);
    if (info === undefined) throw new Error('path not found');
    if (info.type !== 'directory') throw new Error('not a directory');
    const entries = await ctx.fs.listDir(target, exec.signal);
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    const max = Math.max(1, Math.min(500, Math.floor(op.limit ?? 200)));
    const shown = entries.slice(0, max);
    const lines = shown.map((entry) => `${entry.name}${entry.type === 'directory' ? '/' : ''}${typeof entry.size === 'number' ? ` (${entry.size}b)` : ''}`);
    if (entries.length > shown.length) lines.push(`… [omitted ${entries.length - shown.length} entries] …`);
    const text = lines.join('\n') || '(empty)';
    const published = publish(text, { kind: 'list', path: showPath(cwd, target) }, emittedRefs);
    const compressed = compressPayload(text, { budget: config.maxResultTokens, path: '.txt' });
    return {
      path: showPath(cwd, target),
      ok: true,
      text: compressed.text,
      ref: published.ref,
      truncated: compressed.truncated || entries.length > shown.length,
      sourceTokens: published.tokens,
      saved: compressed.saved,
      deduped: published.deduped
    };
  }

  async function statOp(op, cwd, exec, emittedRefs) {
    const target = await resolve(cwd, op.path, exec);
    const info = await ctx.fs.stat(target, exec.signal);
    const text = info === undefined
      ? 'absent'
      : `type=${info.type} size=${info.size ?? '?'} version=${String(info.version ?? '?')}`;
    const compressed = compressPayload(text, { budget: config.maxResultTokens, path: '.txt' });
    return {
      path: showPath(cwd, target),
      ok: true,
      text: compressed.text,
      truncated: false,
      sourceTokens: compressed.originalTokens,
      saved: compressed.saved
    };
  }

  async function fetchOp(op, cwd, exec) {
    if (typeof op.ref !== 'string' || op.ref.length === 0) throw new Error('ref is required for fetch');
    const entry = refs.get(op.ref);
    if (entry === undefined) throw new Error(`unknown or expired ref "${op.ref}"; re-read the source`);
    const window = sliceLines(entry.body, op.offset ?? 0, op.limit ?? Number.MAX_SAFE_INTEGER);
    const compressed = compressPayload(window.text, { budget: config.maxResultTokens, path: entry.meta?.path ?? '' });
    return {
      path: entry.meta?.path,
      ok: true,
      text: compressed.text.length > 0 ? compressed.text : '(empty)',
      ref: entry.ref,
      truncated: compressed.truncated,
      sourceTokens: entry.tokens,
      saved: Math.max(0, entry.tokens - compressed.tokens)
    };
  }

  async function executeOp(op, cwd, exec, emittedRefs) {
    if (op === null || typeof op !== 'object' || typeof op.op !== 'string') throw new Error('op must be an object with op string');
    switch (op.op) {
      case 'read': return readOp(op, cwd, exec, emittedRefs);
      case 'grep': return grepOp(op, cwd, exec, emittedRefs);
      case 'list': return listOp(op, cwd, exec, emittedRefs);
      case 'stat': return statOp(op, cwd, exec, emittedRefs);
      case 'fetch': return fetchOp(op, cwd, exec);
      default: throw new Error(`unsupported op "${op.op}"`);
    }
  }

  return {
    name: toolName('batch'),
    description: 'Run independent read-only filesystem operations in one call. Output is bounded; oversized results return a fetchable ref, and duplicates are collapsed.',
    parameters: batchParameters,
    output: {
      schema: batchOutput,
      render: (_args, value) => {
        const lines = [`${value.results.length} op${value.results.length === 1 ? '' : 's'} · ~${value.tokens} tok · saved ~${value.saved}`];
        for (const result of value.results) {
          const bits = [`[${result.i}] ${result.op}`];
          if (result.path) bits.push(result.path);
          bits.push(result.ok ? 'ok' : 'ERROR');
          if (result.truncated) bits.push('truncated');
          if (result.deduped) bits.push('deduped');
          if (result.ref) bits.push(result.ref);
          lines.push(bits.join(' · '));
          lines.push(result.text);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    async execute(args, exec) {
      if (!Array.isArray(args.ops) || args.ops.length === 0) throw new Error('ops must contain at least one operation');
      const limit = config.batchEnabled ? config.maxBatchOps : 1;
      if (args.ops.length > limit) throw new Error(`this deployment allows at most ${limit} operation${limit === 1 ? '' : 's'} per batch`);
      const cwd = exec.agent === undefined
        ? process.cwd()
        : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const emittedRefs = new Set();
      const seen = new Map();
      const results = [];
      for (let i = 0; i < args.ops.length; i += 1) {
        const op = args.ops[i];
        const key = op === null || typeof op !== 'object' ? undefined : JSON.stringify(op);
        const prior = key === undefined ? undefined : seen.get(key);
        if (prior !== undefined) {
          const text = `duplicate of #${prior.i}${prior.ref ? ` (${prior.ref})` : ''}`;
          results.push({ i, op: op.op ?? '?', ok: prior.ok, text, ref: prior.ref, truncated: false, deduped: true, saved: Math.max(0, prior.sourceTokens - tokenCount(text)) });
          continue;
        }
        try {
          const result = await executeOp(op, cwd, exec, emittedRefs);
          const normalized = { i, op: op.op, ok: true, ...result };
          normalized.saved = Math.max(0, Math.floor(normalized.saved ?? 0));
          normalized.sourceTokens = typeof result.sourceTokens === 'number' ? result.sourceTokens : 0;
          results.push(normalized);
          seen.set(key, normalized);
        } catch (error) {
          const text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
          const failed = { i, op: op?.op ?? '?', ok: false, text, truncated: false, saved: 0, sourceTokens: 0 };
          results.push(failed);
          if (key !== undefined) seen.set(key, failed);
          logger?.warn?.(() => `tether: batch op ${i} failed: ${text}`);
        }
      }
      const totalBudget = Math.floor(config.maxResultTokens * (args.ops.length > 1 ? 1.5 : 1));
      let total = results.reduce((sum, result) => sum + tokenCount(result.text), 0);
      if (total > totalBudget) {
        const per = Math.max(16, Math.floor((totalBudget - 16) / Math.max(1, results.length)));
        for (const result of results) {
          if (!result.ok) continue;
          const fitted = fitText(result.text, per);
          result.text = fitted.text;
          result.truncated = true;
        }
        total = results.reduce((sum, result) => sum + tokenCount(result.text), 0);
      }
      const saved = results.reduce((sum, result) => sum + Math.max(0, Math.floor(result.saved ?? 0)), 0);
      for (const result of results) delete result.sourceTokens;
      return { results, tokens: total, saved, budget: totalBudget };
    }
  };
}

/** Convert the small glob subset (*, ?, **) into a RegExp. */
export function globToRegExp(glob) {
  const source = String(glob);
  let body = '^';
  const special = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '*') {
      if (source[i + 1] === '*') {
        i += 1;
        if (source[i + 1] === '/') {
          i += 1;
          body += '(?:.*/)?';
        } else {
          body += '.*';
        }
      } else {
        body += '[^/]*';
      }
    } else if (char === '?') {
      body += '[^/]';
    } else if (char === '/') {
      body += '/';
    } else {
      body += special.has(char) ? '\\' + char : char;
    }
  }
  return new RegExp(body + '$');
}

