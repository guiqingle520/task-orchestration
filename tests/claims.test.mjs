import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claimTask, claimsPath, heartbeatTask, readClaims, reconcileDoneClaims, releaseClaim, replaceRoster, writeClaims } from '../server/claims.mjs';
import { atomicReplaceFile, revisionOf, withPlanLock } from '../server/plan-lock.mjs';
import { evaluateClaims } from '../web/claims.js';

const now = Date.parse('2026-11-23T01:00:00Z');
const seed = { tasks: [{ id: 'T-1', status: 'todo', owner: 'codex' }, { id: 'T-2', status: 'todo', owner: 'alice' }] };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-claims-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'plan.md');
  writeFileSync(path, 'plan');
  return { dir, path };
}

test('evaluates expiration at the exact boundary, merges the roster, and surfaces orphaned and done leases', (t) => {
  const { path } = fixture(t);
  const config = readClaims(path);
  const first = claimTask(config, seed, { id: 'T-1', actor: 'codex#1' }, now);
  const second = claimTask(config, seed, { id: 'T-2', actor: 'alice' }, now);
  assert.equal(first.ttlMinutes, 30);
  assert.equal(second.ttlMinutes, 480);
  assert.equal(evaluateClaims(config, seed, Date.parse(first.expiresAt) - 1).claims['T-1'].remainingMs, 1);
  assert.equal(evaluateClaims(config, seed, first.expiresAt).claims['T-1'].state, 'stale');
  const plan = { tasks: [{ ...seed.tasks[0], status: 'done' }] };
  const evaluated = evaluateClaims(config, plan, now);
  assert.equal(evaluated.claims['T-1'].state, 'done_pending_reconcile');
  assert.equal(evaluated.claims['T-2'].state, 'orphaned');
  assert.deepEqual(Object.fromEntries(evaluated.mergedRoster.map(({ id, kind }) => [id, kind])), { alice: 'human', codex: 'agent', 'codex#1': 'agent' });
  assert.equal(evaluated.summary.orphaned, 1);
  replaceRoster(config, plan, { roster: [{ id: 'alice', kind: 'agent', label: 'A', defaultTtlMinutes: 10 }], cleanupOrphans: true }, now);
  assert.equal(config.claims['T-2'], undefined);
  assert.equal(config.roster[0].defaultTtlMinutes, 10);
});

test('renewal preserves generation and audit history while confirmed takeover supersedes an identical actor', (t) => {
  const { path } = fixture(t);
  const config = readClaims(path);
  const first = claimTask(config, seed, { id: 'T-1', actor: 'codex' }, now);
  assert.equal(claimTask(config, seed, { id: 'T-1', actor: 'codex' }, now).leaseId, first.leaseId);
  assert.throws(() => claimTask(config, seed, { id: 'T-1', actor: 'alice' }, now), { code: 'TASK_ALREADY_CLAIMED' });
  const expired = Date.parse(first.expiresAt);
  assert.throws(() => claimTask(config, seed, { id: 'T-1', actor: 'codex' }, expired), { code: 'CLAIM_STALE_CONFIRM_REQUIRED' });
  const next = claimTask(config, seed, { id: 'T-1', actor: 'codex', takeoverStale: true }, expired);
  assert.notEqual(next.leaseId, first.leaseId);
  assert.throws(() => heartbeatTask(config, { id: 'T-1', actor: 'codex', leaseId: first.leaseId }, expired), { code: 'LEASE_SUPERSEDED' });
  assert.throws(() => releaseClaim(config, { id: 'T-1', actor: 'codex', leaseId: first.leaseId }, expired), { code: 'LEASE_SUPERSEDED' });
  for (let i = 0; i < 105; i++) heartbeatTask(config, { id: 'T-1', actor: 'codex', leaseId: next.leaseId }, expired + i);
  assert.equal(config.activityLog.length, 1);
  assert.equal(config.auditLog[0].previousLeaseId, first.leaseId);
  assert.equal(config.auditLog[0].newLeaseId, next.leaseId);
});

test('isolates plan sidecars and reconciles done claims idempotently', (t) => {
  const { dir, path } = fixture(t);
  const alternate = join(dir, 'sprint.md');
  assert.equal(claimsPath(path), join(dir, 'claims.json'));
  assert.equal(claimsPath(alternate), join(dir, 'sprint.md.claims.json'));
  const config = readClaims(path);
  claimTask(config, seed, { id: 'T-1', actor: 'codex' }, now);
  withPlanLock(path, () => writeClaims(path, config));
  const done = { tasks: [{ ...seed.tasks[0], status: 'done' }, seed.tasks[1]] };
  for (let i = 0; i < 2; i++) withPlanLock(path, () => reconcileDoneClaims(path, done, now));
  assert.deepEqual(Object.keys(readClaims(path).claims), []);
  assert.deepEqual(readClaims(path).activityLog.map(({ type }) => type), ['claim', 'auto_reconcile_done']);
  assert.deepEqual(readClaims(alternate).activityLog, []);
});

test('holds the lock through the write, preserves the original on conflict or error, and cleans up', (t) => {
  const { dir, path } = fixture(t);
  assert.throws(() => withPlanLock(path, () => {
    assert.throws(() => withPlanLock(path, () => {}, { timeoutMs: 0 }), { code: 'LOCK_BUSY' });
    assert.equal(atomicReplaceFile(path, 'next', revisionOf('earlier')), false);
    const directory = join(dir, 'directory');
    mkdirSync(directory);
    assert.throws(() => atomicReplaceFile(directory, 'next'), { code: 'ATOMIC_REPLACE_FAILED' });
    throw new Error('operation failed');
  }), /operation failed/);
  assert.equal(readFileSync(path, 'utf8'), 'plan');
  assert.deepEqual(readdirSync(dir).sort(), ['directory', 'plan.md']);
  withPlanLock(path, () => assert.equal(atomicReplaceFile(path, 'next', revisionOf('plan')), true));
  assert.equal(readFileSync(path, 'utf8'), 'next');
});

test('reclaims an old lock only when its recorded process is gone', (t) => {
  const { dir, path } = fixture(t);
  const pid = Number(execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).trim());
  const lock = path + '.lock';
  mkdirSync(lock);
  const lockInfo = join(lock, 'owner.json');
  const owner = { holderId: randomUUID(), acquiredAt: '2000-01-01T00:00:00Z', pid: process.pid };
  writeFileSync(lockInfo, JSON.stringify(owner));
  assert.throws(() => withPlanLock(path, () => assert.fail('A live lock was reclaimed'), { timeoutMs: 0, staleLockMs: 0 }), { code: 'LOCK_BUSY' });
  writeFileSync(lockInfo, JSON.stringify({ ...owner, pid }));
  withPlanLock(path, () => {
    assert.equal(JSON.parse(readFileSync(lockInfo, 'utf8')).pid, process.pid);
  }, { staleLockMs: 0 });
  assert.deepEqual(readdirSync(dir), ['plan.md']);
});

test('Windows retries transient access errors when replacing a locked plan file', { skip: process.platform !== 'win32' }, (t) => {
  const { dir, path } = fixture(t);
  const rename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (to === path && ++attempts <= 2) throw Object.assign(new Error('Injected Windows sharing violation'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    withPlanLock(path, () => assert.equal(atomicReplaceFile(path, 'updated', revisionOf('plan')), true));
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(attempts, 3);
  assert.equal(readFileSync(path, 'utf8'), 'updated');
  assert.deepEqual(readdirSync(dir), ['plan.md']);
});
