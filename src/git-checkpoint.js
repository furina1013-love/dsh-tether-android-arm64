import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { PLUGIN_NAME, STATE_BASENAME } from './names.js';

const run = promisify(execFile);

/** Resolve $DSH_HOME the same way the host does, with a safe fallback. */
export function resolveDshHome(home = process.env.DSH_HOME) {
  return home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh');
}

async function git(cwd, args, { timeout = 15000 } = {}) {
  try {
    const result = await run('git', args, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true
    });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : String(error?.message ?? error)
    };
  }
}

function oneLine(value, fallback, maxLength = 180) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  const resolved = text.length > 0 ? text : fallback;
  return resolved.slice(0, maxLength);
}

function messageFor(prefix, turn) {
  const stamp = new Date().toISOString();
  return oneLine(`${prefix} checkpoint ${turn > 0 ? `t${turn} ` : ''}${stamp}`, 'checkpoint');
}

/**
 * Durable session -> checkpoint mapping under $DSH_HOME, never inside the
 * session workspace. Writes are atomic best-effort; a state write failure is
 * reported but does not roll back an already-created commit.
 */
export class CheckpointStore {
  constructor({ home, pluginName = PLUGIN_NAME, logger } = {}) {
    this.home = resolveDshHome(home);
    this.file = join(this.home, `${STATE_BASENAME}.json`);
    this.pluginName = pluginName;
    this.logger = logger;
    this.data = { version: 1, plugin: pluginName, updatedAt: null, sessions: {} };
    this.writeQueue = Promise.resolve();
  }

  async init() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && parsed.version === 1 && parsed.sessions !== null && typeof parsed.sessions === 'object') {
        this.data = { ...parsed, plugin: this.pluginName };
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.(() => `${this.pluginName}: checkpoint state is unreadable; starting a new state file (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return this;
  }

  getSession(sessionId) {
    const id = String(sessionId);
    const value = this.data.sessions[id];
    return value === undefined ? undefined : { ...value };
  }

  async record(sessionId, patch) {
    const id = String(sessionId);
    const previous = this.data.sessions[id] ?? {};
    this.data.sessions[id] = {
      ...previous,
      ...patch,
      ...(patch.turn === undefined ? {} : { lastTurn: patch.turn })
    };
    this.data.updatedAt = new Date().toISOString();
    if (patch.commit !== undefined) this.data.lastCommit = patch.commit;
    this.writeQueue = this.writeQueue.then(() => this.#save()).catch((error) => {
      this.logger?.warn?.(() => `${this.pluginName}: could not save checkpoint state: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.writeQueue;
  }

  async #save() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
    await chmod(this.file, 0o600).catch(() => {});
  }

  /**
   * Create one checkpoint in cwd. Never pushes, resets, cleans, or touches
   * another working tree. Every failure is returned as data and logged by the
   * caller; this method does not throw for ordinary git problems.
   */
  async checkpoint({ cwd, sessionId, turn = 0, prefix = `[${PLUGIN_NAME}]`, autoInit = false, automatic = false } = {}) {
    const at = new Date().toISOString();
    const id = String(sessionId ?? 'unknown');
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      const result = { status: 'failed', reason: 'invalid-cwd', message: 'checkpoint requires an absolute working directory', at };
      await this.record(id, { cwd: cwd ?? null, turn, lastStatus: result.status, lastReason: result.reason, lastAt: at });
      return result;
    }
    const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      if (!autoInit) {
        const result = { status: 'skipped', reason: 'not-a-git-repository', at, cwd };
        await this.record(id, { cwd, turn, lastStatus: result.status, lastReason: result.reason, lastAt: at });
        return result;
      }
      const initialized = await git(cwd, ['init']);
      if (initialized.code !== 0) {
        const result = { status: 'failed', reason: 'init-failed', message: oneLine(initialized.stderr, 'git init failed'), at, cwd };
        await this.record(id, { cwd, turn, lastStatus: result.status, lastReason: result.reason, lastAt: at, lastError: result.message });
        return result;
      }
    }

    const status = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.']);
    if (status.code !== 0) {
      const result = { status: 'failed', reason: 'status-failed', message: oneLine(status.stderr, 'git status failed'), at, cwd };
      await this.record(id, { cwd, turn, lastStatus: result.status, lastReason: result.reason, lastAt: at, lastError: result.message });
      return result;
    }
    if (status.stdout.trim().length === 0) {
      const result = { status: 'skipped', reason: 'no-changes', at, cwd };
      await this.record(id, { cwd, turn, lastStatus: result.status, lastReason: result.reason, lastAt: at });
      return result;
    }

    const add = await git(cwd, ['add', '-A', '--', '.']);
    if (add.code !== 0) {
      const result = { status: 'failed', reason: 'add-failed', message: oneLine(add.stderr, 'git add failed'), at, cwd };
      await this.record(id, { cwd, turn, lastStatus: result.status, lastReason: result.reason, lastAt: at, lastError: result.message });
      return result;
    }
    const staged = await git(cwd, ['diff', '--cached', '--quiet', '--', '.']);
    if (staged.code === 0) {
      const result = { status: 'skipped', reason: 'no-staged-changes', at, cwd };
      await this.record(id, { cwd, turn, lastStatus: result.status, lastReason: result.reason, lastAt: at });
      return result;
    }
    if (staged.code !== 1) {
      const result = { status: 'failed', reason: 'diff-failed', message: oneLine(staged.stderr, 'git diff failed'), at, cwd };
      await this.record(id, { cwd, turn, lastStatus: result.status, lastReason: result.reason, lastAt: at, lastError: result.message });
      return result;
    }

    const message = messageFor(oneLine(prefix, `[${PLUGIN_NAME}]`), turn);
    // --only with a pathspec keeps unrelated staged work out of this commit.
    const commit = await git(cwd, ['commit', '--only', '-m', message, '--', '.']);
    if (commit.code !== 0) {
      const result = { status: 'failed', reason: 'commit-failed', message: oneLine(commit.stderr, 'git commit failed'), at, cwd, message };
      await this.record(id, { cwd, turn, lastStatus: result.status, lastReason: result.reason, lastAt: at, lastError: result.message });
      return result;
    }
    const head = await git(cwd, ['rev-parse', '--short', 'HEAD']);
    const hash = head.code === 0 ? head.stdout.trim() : undefined;
    const result = { status: 'committed', commit: hash, message, at, cwd, automatic };
    await this.record(id, {
      cwd,
      turn,
      lastStatus: result.status,
      lastReason: null,
      lastAt: at,
      lastCommit: hash ?? null,
      lastMessage: message,
      ...(automatic ? { lastAutoAt: at } : { lastManualAt: at })
    });
    return result;
  }
}
