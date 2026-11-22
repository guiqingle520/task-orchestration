import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const waitCell = new Int32Array(new SharedArrayBuffer(4));
const wait = (ms) => Atomics.wait(waitCell, 0, 0, ms);

export class PlanLockError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.status = status;
    this.code = code;
  }
}

export function revisionOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalPlanPath(path) {
  try { return realpathSync(resolve(path)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return resolve(path);
  }
}

function deadOwner(directory, staleLockMs) {
  try {
    const owner = JSON.parse(readFileSync(`${directory}/owner.json`, 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9-]{36}$/.test(owner.holderId)) return null;
    const age = Date.now() - Math.max(Date.parse(owner.acquiredAt), statSync(`${directory}/owner.json`).mtimeMs);
    if (!(age >= staleLockMs)) return null;
    try { process.kill(owner.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return owner; }
  } catch {
    // An unreadable or incomplete owner record cannot establish that its process died.
  }
  return null;
}

function recoverDeadLock(directory, staleLockMs) {
  const owner = deadOwner(directory, staleLockMs);
  if (!owner) return;
  const marker = `${directory}.${owner.holderId}.recovery.lock`;
  const abandoned = `${directory}.${randomUUID()}.lock`;
  try { mkdirSync(marker); }
  catch (error) {
    if (['EEXIST', 'ENOENT', 'EPERM', 'EACCES'].includes(error.code)) return;
    throw error;
  }
  let moved = false;
  try {
    // The marker is specific to this generation and never touches a new owner's directory.
    if (deadOwner(directory, staleLockMs)?.holderId !== owner.holderId) return;
    renameSync(directory, abandoned);
    moved = true;
  } catch (error) {
    if (!['ENOENT', 'EPERM', 'EACCES'].includes(error.code)) throw error;
  } finally {
    rmdirSync(marker);
    if (moved) {
      unlinkSync(`${abandoned}/owner.json`);
      rmdirSync(abandoned);
    }
  }
}

// The critical section performs synchronous disk work only. Keep network I/O outside it.
export function withPlanLock(planPath, fn, { timeoutMs = 2500, staleLockMs = 30_000 } = {}) {
  const canonicalPath = canonicalPlanPath(planPath);
  const directory = `${canonicalPath}.lock`;
  const deadline = performance.now() + timeoutMs;
  let delay = 20;
  for (;;) {
    try {
      mkdirSync(directory, { mode: 0o700 });
      break;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      recoverDeadLock(directory, staleLockMs);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new PlanLockError(409, 'LOCK_BUSY', '当前计划正在被另一进程写入，请稍后重试');
      wait(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 120);
    }
  }
  const ownerPath = `${directory}/owner.json`;
  try {
    const owner = { holderId: randomUUID(), pid: process.pid, acquiredAt: new Date().toISOString() };
    writeFileSync(ownerPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return fn(canonicalPath);
  } finally {
    try { unlinkSync(ownerPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(directory);
  }
}

// Returns false on revision mismatch. A failed rename leaves the original target intact.
export function atomicReplaceFile(targetPath, content, expectedRevision = null, { mode = 0o666 } = {}) {
  const temporary = `${targetPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
    if (expectedRevision !== null && revisionOf(readFileSync(targetPath, 'utf8')) !== expectedRevision) return false;
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, targetPath);
        return true;
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt >= 5) {
          throw new PlanLockError(500, 'ATOMIC_REPLACE_FAILED', '无法原子替换文件，请检查文件权限或占用情况', { cause: error });
        }
        wait(15 * (attempt + 1));
      }
    }
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
