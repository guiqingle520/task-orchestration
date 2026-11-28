import { readFileSync } from 'node:fs';
import { parseFrontMatter, validate } from '../scripts/validate-plan.mjs';
import { updatePlanMarkdown, verifyTaskUpdates } from '../scripts/sync-git-progress.mjs';
import { evaluateClaims } from '../web/claims.js';
import { ClaimError, claimTask, heartbeatTask, reconcileDoneClaims, releaseClaim, replaceRoster, writeClaims } from './claims.mjs';
import { atomicReplaceFile, revisionOf, withPlanLock } from './plan-lock.mjs';
import { readOwnersConfig } from './owners.mjs';

export function withClaimsSnapshot(project, fn) {
  return withPlanLock(project.planPath, (planPath) => {
    let raw;
    try { raw = readFileSync(planPath, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new ClaimError(400, 'PLAN_UNAVAILABLE', '找不到 plan/plan.md');
    }
    const data = parseFrontMatter(raw);
    const errors = data ? validate(data) : ['plan.md 缺少 YAML front matter'];
    if (errors.length) throw new ClaimError(400, 'PLAN_INVALID', errors.join('; '), { errors });
    const now = Date.now();
    const config = reconcileDoneClaims(planPath, data, now);
    return fn({ planPath, raw, data, revision: revisionOf(raw), now, config });
  });
}

export function getClaimsSnapshot(project, today) {
  return withClaimsSnapshot(project, ({ data, config, now }) => {
    const { claims, mergedRoster, summary } = evaluateClaims(config, data, now);
    let planOwners = [];
    try { planOwners = readOwnersConfig(project).owners; }
    catch { /* 负责人列表的读取错误由 /api/owners 报告。 */ }
    return { projectId: project.id, today, now: new Date(now).toISOString(),
      roster: mergedRoster, configuredRoster: config.roster, planOwners, claims, summary, activityLog: config.activityLog, auditLog: config.auditLog };
  });
}

export function mutateClaims(project, input, today) {
  return withClaimsSnapshot(project, ({ planPath, raw, data, revision, now, config }) => {
    const result = { ok: true, projectId: project.id };
    switch (input?.action) {
      case 'claim': {
        for (const key of ['startImmediately', 'takeoverStale', 'force']) {
          if (input[key] !== undefined && typeof input[key] !== 'boolean') {
            throw new ClaimError(400, 'INVALID_CLAIM_INPUT', `${key} 必须为布尔值`);
          }
        }
        const claim = claimTask(config, data, input, now);
        writeClaims(planPath, config);
        const task = data.tasks.find(({ id }) => id === claim.taskId);
        if (input.startImmediately !== true || task.status !== 'todo') return { ...result, claim, taskStarted: false };
        try {
          Object.assign(task, { status: 'doing', progress: 10, actualStart: today, actualEnd: null });
          const output = updatePlanMarkdown(raw, [task]);
          if (validate(data).length || !verifyTaskUpdates(output, [task]) || !atomicReplaceFile(planPath, output, revision)) {
            throw new Error('Plan start write did not complete');
          }
          return { ...result, claim, taskStarted: true, task };
        } catch {
          return {
            ...result, claim, taskStarted: false, claimed_but_not_started: true,
            warningCode: 'CLAIMED_BUT_NOT_STARTED',
            message: '已认领，未更新为进行中。请刷新任务后使用当前租约重试开工。',
          };
        }
      }
      case 'heartbeat': {
        const claim = heartbeatTask(config, input, now);
        if (!data.tasks.some(({ id }) => id === claim.taskId)) throw new ClaimError(404, 'TASK_NOT_FOUND', '任务已不存在，请释放孤儿租约');
        writeClaims(planPath, config);
        return { ...result, claim };
      }
      case 'release': {
        const released = releaseClaim(config, input, now);
        if (released) writeClaims(planPath, config);
        return { ...result, released };
      }
      case 'roster': {
        const roster = replaceRoster(config, data, input, now);
        writeClaims(planPath, config);
        return { ...result, roster };
      }
      default:
        throw new ClaimError(400, 'INVALID_CLAIM_ACTION', '认领操作须为 claim、heartbeat、release 或 roster');
    }
  });
}
