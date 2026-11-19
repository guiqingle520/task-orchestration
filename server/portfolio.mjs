import { validate } from '../scripts/validate-plan.mjs';
import { compute } from '../web/metrics.js';

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
