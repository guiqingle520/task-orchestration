import { validate } from '../scripts/validate-plan.mjs';
import { evaluateClaims } from '../web/claims.js';
import { compute } from '../web/metrics.js';
import { readyTasks } from '../web/task-handoff.js';

export function validPortfolioDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

export function summarizeProject(project, today, readSnapshot) {
  const { id, name } = project;
  try {
    const { data } = readSnapshot(project);
    if (data && !validate(data).length) {
      const { summary, milestones } = compute(data, today);
      // 空阶段没有交付进度；已逾期的未完成阶段仍是待交付项。
      const next = milestones.filter(m => m.doneCount < m.taskCount)
        .sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id, 'en', { numeric: true }))[0];
      return {
        id, name, health: summary.health, overall: summary.overall, taskCount: data.tasks.length,
        overdueCount: summary.overdueCount, blockedCount: summary.blockedCount,
        nextMilestone: next ? { id: next.id, name: next.name, due: next.due } : null,
      };
    }
  } catch { /* 单个项目不可用时，其他项目仍可查看。 */ }
  return { id, name, health: 'unavailable', overall: null, taskCount: 0, overdueCount: null, blockedCount: null, nextMilestone: null };
}

function packActionClaim(claim) {
  if (!claim || (claim.state !== 'active' && claim.state !== 'stale')) return null;
  return {
    actor: claim.actor,
    actorKind: claim.actorKind,
    state: claim.state,
    remainingMinutes: claim.remainingMinutes ?? null,
  };
}

export function summarizePortfolioDetails(project, today, readSnapshot, readClaimsFn, now = Date.now()) {
  try {
    const { data } = readSnapshot(project);
    if (!data || validate(data).length) return null;
    let claimsConfig;
    try { claimsConfig = readClaimsFn(project); }
    catch { claimsConfig = { version: 1, roster: [], claims: {}, activityLog: [], auditLog: [] }; }
    const { claims } = evaluateClaims(claimsConfig, data, now);
    const activeAgents = new Set(
      Object.values(claims)
        .filter((claim) => claim.state === 'active' && claim.actorKind === 'agent')
        .map((claim) => claim.actor),
    );
    const doingTasks = data.tasks.filter(
      (task) => task.status === 'doing' || (task.status === 'todo' && claims[task.id]?.state === 'active'),
    );
    const blockedTasks = data.tasks.filter((task) => task.status === 'blocked');
    const readyList = readyTasks(data.tasks, today);
    const toItem = (task, extra = {}) => ({
      projectId: project.id,
      projectName: project.name,
      id: task.id,
      title: task.title,
      owner: task.owner,
      status: task.status,
      progress: task.progress,
      start: task.start,
      end: task.end,
      claim: packActionClaim(claims[task.id]),
      ...extra,
    });
    return {
      doingCount: doingTasks.length,
      activeAgentCount: activeAgents.size,
      actions: {
        blocked: blockedTasks.map((task) => toItem(task)),
        doing: doingTasks.map((task) => toItem(task, { claimedPending: task.status === 'todo' })),
        ready: readyList.map(({ task, availability, reason }) => toItem(task, { availability, reason })),
      },
    };
  } catch {
    return null;
  }
}

const compareActionItem = (a, b) => a.end.localeCompare(b.end)
  || a.projectName.localeCompare(b.projectName, 'zh-CN', { numeric: true })
  || a.id.localeCompare(b.id, 'en', { numeric: true });

export function aggregatePortfolioActions(detailsList) {
  const blocked = [];
  const doing = [];
  const ready = [];
  for (const actions of detailsList || []) {
    if (!actions) continue;
    if (Array.isArray(actions.blocked)) blocked.push(...actions.blocked);
    if (Array.isArray(actions.doing)) doing.push(...actions.doing);
    if (Array.isArray(actions.ready)) ready.push(...actions.ready);
  }
  blocked.sort(compareActionItem);
  doing.sort((a, b) => Number(Boolean(a.claimedPending)) - Number(Boolean(b.claimedPending)) || compareActionItem(a, b));
  ready.sort(compareActionItem);
  return { blocked, doing, ready };
}
