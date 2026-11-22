import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { claimState, defaultClaimTtl, inferActorKind } from '../web/claims.js';
import { atomicReplaceFile, PlanLockError } from './plan-lock.mjs';

const TASK_ID = /^T-\d+$/;
const LOG_LIMIT = 100;

export class ClaimError extends PlanLockError {
  constructor(status, code, message, details = {}, options) {
    super(status, code, message, options);
    this.details = details;
  }
}

export function claimsPath(planPath) {
  const name = basename(planPath);
  return join(dirname(planPath), name.toLowerCase() === 'plan.md' ? 'claims.json' : `${name}.claims.json`);
}

export function readClaims(planPath) {
  const file = claimsPath(planPath);
  try {
    let info;
    try { info = lstatSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, roster: [], claims: {}, activityLog: [], auditLog: [] };
      throw error;
    }
    if (!info.isFile()) throw new Error('Expected a regular claims file');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    if (config?.version !== 1 || !Array.isArray(config.roster) || !Array.isArray(config.activityLog) || !Array.isArray(config.auditLog)
      || !config.claims || typeof config.claims !== 'object' || Array.isArray(config.claims)
      || Object.entries(config.claims).some(([id, claim]) => !TASK_ID.test(id) || claim?.taskId !== id
        || typeof claim.actor !== 'string' || !claim.actor || typeof claim.leaseId !== 'string' || !claim.leaseId
        || !['agent', 'human'].includes(claim.actorKind) || !Number.isFinite(Date.parse(claim.expiresAt)))) {
      throw new Error('Invalid claims format');
    }
    config.roster = normalizeRoster(config.roster);
    return config;
  } catch (error) {
    throw new ClaimError(500, 'CLAIMS_UNREADABLE', '无法读取认领侧车文件，请检查文件格式和权限', {}, { cause: error });
  }
}

// All callers must hold the corresponding plan lock while mutating the sidecar.
export function writeClaims(planPath, config) {
  atomicReplaceFile(claimsPath(planPath), JSON.stringify(config, null, 2) + '\n', null, { mode: 0o600 });
}

function inputError(message) {
  return new ClaimError(400, 'INVALID_CLAIM_INPUT', message);
}

function text(value, label, limit, minimum = 0, singleLine = false) {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > limit
    || (singleLine && /[\r\n]/.test(value))) throw inputError(`${label} 格式无效`);
  return value.trim();
}

function actorId(value) {
  return text(value, '执行人', 120, 1, true);
}

function actorKind(value) {
  if (value !== 'agent' && value !== 'human') throw inputError('负责人类型须为 human 或 agent');
  return value;
}

function ttlMinutes(value, kind) {
  const max = kind === 'human' ? 1440 : 240;
  if (!Number.isInteger(value) || value < 5 || value > max) throw inputError(`租约时长须为 5 至 ${max} 分钟`);
  return value;
}

function normalizeRoster(input) {
  if (!Array.isArray(input)) throw inputError('负责人名录须为数组');
  const ids = new Set();
  return input.map((entry) => {
    const id = actorId(entry?.id);
    if (ids.has(id)) throw inputError(`负责人名录包含重复标识 ${id}`);
    ids.add(id);
    const kind = actorKind(entry.kind ?? inferActorKind(id));
    return { id, label: entry.label === undefined ? id : text(entry.label, '显示名', 160, 1, true), kind,
      defaultTtlMinutes: ttlMinutes(entry.defaultTtlMinutes ?? defaultClaimTtl(kind), kind) };
  });
}

export function recordClaimEvent(config, log, now, type, details) {
  config[log] = [...config[log], { id: randomUUID(), at: new Date(now).toISOString(), type, ...details }].slice(-LOG_LIMIT);
}

function leaseEvent(claim) {
  return { taskId: claim.taskId, actor: claim.actor, leaseId: claim.leaseId };
}

export function removeClaim(config, claim, now, type) {
  if (config.claims[claim.taskId]?.leaseId !== claim.leaseId) return false;
  delete config.claims[claim.taskId];
  recordClaimEvent(config, 'activityLog', now, type, leaseEvent(claim));
  return true;
}

export function reconcileDoneClaims(planPath, plan, now) {
  const config = readClaims(planPath);
  let changed = false;
  for (const task of plan.tasks) {
    const claim = config.claims[task.id];
    if (claim && task.status === 'done') {
      removeClaim(config, claim, now, 'auto_reconcile_done');
      changed = true;
    }
  }
  if (changed) writeClaims(planPath, config);
  return config;
}

function taskId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!TASK_ID.test(id)) throw inputError('必须提供有效的任务 ID');
  return id;
}

function superseded() {
  return new ClaimError(409, 'LEASE_SUPERSEDED', '租约已失效或被接管，请重新读取任务');
}

function verifyGeneration(current, leaseId) {
  if (leaseId !== undefined && (typeof leaseId !== 'string' || !leaseId || current?.leaseId !== leaseId)) throw superseded();
}

function renewClaim(claim, input, now) {
  const ttl = ttlMinutes(input.ttlMinutes ?? claim.ttlMinutes, claim.actorKind);
  return {
    ...claim,
    ttlMinutes: ttl,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 60_000).toISOString(),
    note: input.note === undefined ? claim.note : text(input.note, '心跳备注', 1000),
  };
}

export function claimTask(config, plan, input, now) {
  const id = taskId(input.id);
  const actor = actorId(input.actor);
  const task = plan.tasks.find((item) => item.id === id);
  if (!task) throw new ClaimError(404, 'TASK_NOT_FOUND', `找不到任务 ${id}`);
  if (task.status === 'done') throw new ClaimError(409, 'TASK_ALREADY_DONE', '已完成任务无法认领');
  const current = config.claims[id];
  verifyGeneration(current, input.expectedLeaseId);
  const force = input.force === true;
  const reason = force ? text(input.reason, '强制操作原因', 500, 2) : undefined;
  const state = current ? claimState(current, task, now) : null;
  if (current && !force) {
    const sameActor = current.actor === actor;
    if (sameActor && (state === 'active' || (input.expectedLeaseId === current.leaseId && input.takeoverStale !== true))) {
      const claim = renewClaim(current, input, now);
      config.claims[id] = claim;
      return claim;
    }
    if (state === 'active') throw new ClaimError(409, 'TASK_ALREADY_CLAIMED', '任务已被认领', { claim: current });
    if (input.takeoverStale !== true) throw new ClaimError(409, 'CLAIM_STALE_CONFIRM_REQUIRED', '租约已超时，请确认接管', { claim: current });
  }
  const member = config.roster.find((entry) => entry.id === actor);
  const kind = actorKind(input.actorKind ?? member?.kind ?? inferActorKind(actor));
  const ttl = member?.kind === kind ? member.defaultTtlMinutes : defaultClaimTtl(kind);
  const claim = renewClaim({
    taskId: id, leaseId: randomUUID(), actor, actorKind: kind, ownerSnapshot: task.owner,
    claimedAt: new Date(now).toISOString(), ttlMinutes: ttl, note: '',
  }, input, now);
  config.claims[id] = claim;
  if (current) {
    recordClaimEvent(config, 'auditLog', now, force ? 'force_takeover' : 'takeover', {
      taskId: id, actor, previousActor: current.actor, previousLeaseId: current.leaseId, newLeaseId: claim.leaseId,
      ...(reason === undefined ? {} : { reason }),
    });
  } else {
    recordClaimEvent(config, 'activityLog', now, 'claim', leaseEvent(claim));
  }
  return claim;
}

export function heartbeatTask(config, input, now) {
  const id = taskId(input.id);
  const actor = actorId(input.actor);
  const leaseId = text(input.leaseId, '租约代次', 120, 1, true);
  const current = config.claims[id];
  verifyGeneration(current, leaseId);
  if (current.actor !== actor) throw new ClaimError(409, 'CLAIM_CONFLICT', '执行人与当前认领不匹配', { claim: current });
  const claim = renewClaim(current, input, now);
  config.claims[id] = claim;
  return claim;
}

export function releaseClaim(config, input, now) {
  const id = taskId(input.id);
  const current = config.claims[id];
  verifyGeneration(current, input.leaseId);
  if (input.force === true) {
    const reason = text(input.reason, '强制释放原因', 500, 2);
    const actor = input.actor === undefined ? undefined : actorId(input.actor);
    if (!current) return false;
    delete config.claims[id];
    recordClaimEvent(config, 'auditLog', now, 'force_release', {
      taskId: id, actor, previousActor: current.actor, previousLeaseId: current.leaseId, reason,
    });
    return true;
  }
  const actor = actorId(input.actor);
  if (!current) return false;
  if (current.actor !== actor) throw new ClaimError(409, 'CLAIM_CONFLICT', '执行人与当前认领不匹配', { claim: current });
  return removeClaim(config, current, now, 'release');
}

export function replaceRoster(config, plan, input, now) {
  if (input.roster !== undefined || input.cleanupOrphans !== true) {
    config.roster = normalizeRoster(input.roster);
  }
  if (input.cleanupOrphans === true) {
    const ids = new Set(plan.tasks.map(({ id }) => id));
    for (const claim of Object.values(config.claims)) {
      if (!ids.has(claim.taskId)) removeClaim(config, claim, now, 'cleanup_orphan');
    }
  }
  return config.roster;
}

export function checkTaskWrite(config, task, input, now) {
  const current = config.claims[task.id];
  verifyGeneration(current, input.leaseId);
  if (!current) return null;
  if (claimState(current, task, now) !== 'active') {
    if (input.leaseId !== undefined) throw superseded();
    return null;
  }
  if (input.actor === undefined) {
    throw new ClaimError(409, 'TASK_LOCKED_BY_CLAIM', '任务正在执行，请提供当前认领信息或等待释放', { claim: current });
  }
  if (actorId(input.actor) !== current.actor) throw new ClaimError(409, 'CLAIM_CONFLICT', '执行人与当前认领不匹配', { claim: current });
  return current;
}

export function completeClaim(planPath, config, claim, now) {
  if (!claim || !removeClaim(config, claim, now, 'complete_release')) return {};
  try {
    writeClaims(planPath, config);
    return { claimReleased: true };
  } catch {
    // The plan write already succeeded. The next locked read or write can reconcile it.
    return { claimReleased: false, warningCode: 'DONE_CLAIM_RELEASE_PENDING' };
  }
}
