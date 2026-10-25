import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointStore } from '../src/git-checkpoint.js';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

test('checkpoint commits once and skips a clean tree', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'tether-git-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  mkdirSync(root);
  const stateHome = join(parent, 'state');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Tether Test']);
  git(root, ['config', 'user.email', 'tether@example.test']);
  writeFileSync(join(root, 'a.txt'), 'hello\n');
  const store = new CheckpointStore({ home: stateHome, logger: {} });
  await store.init();
  const first = await store.checkpoint({ cwd: root, sessionId: 's1', turn: 1, prefix: '[test]' });
  assert.equal(first.status, 'committed');
  assert.match(first.message, /^\[test\] checkpoint t1 /);
  const log = git(root, ['log', '-1', '--pretty=%s']);
  assert.match(log, /^\[test\] checkpoint/);
  const second = await store.checkpoint({ cwd: root, sessionId: 's1', turn: 2, prefix: '[test]' });
  assert.equal(second.status, 'skipped');
  assert.equal(second.reason, 'no-changes');
  const state = JSON.parse(readFileSync(join(stateHome, 'dsh-tether-android-arm64.json'), 'utf8'));
  assert.equal(state.plugin, 'dsh-tether-android-arm64');
  assert.equal(state.sessions.s1.lastTurn, 2);
});

test('non-repository is skipped when autoInit is false', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'tether-norepo-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  mkdirSync(root);
  const store = new CheckpointStore({ home: join(parent, 'state'), logger: {} });
  await store.init();
  const result = await store.checkpoint({ cwd: root, sessionId: 's1', turn: 1, prefix: '[test]' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'not-a-git-repository');
});
