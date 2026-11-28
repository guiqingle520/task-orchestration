export const KANBAN_COLUMNS = Object.freeze([
  { status: 'todo', label: '未开始' },
  { status: 'doing', label: '进行中' },
  { status: 'blocked', label: '阻塞' },
  { status: 'done', label: '已完成' },
]);

export const DONE_COLLAPSE_LIMIT = 6;

const compareIdAsc = (a, b) => a.id.localeCompare(b.id, 'en', { numeric: true });
const compareOpen = (a, b) => a.end.localeCompare(b.end) || compareIdAsc(a, b);
const compareDone = (a, b) => (b.actualEnd || b.end).localeCompare(a.actualEnd || a.end) || compareIdAsc(b, a);

export function groupKanbanTasks(tasks, {
  doneExpanded = false,
  expandedCols = null,
  doneLimit = DONE_COLLAPSE_LIMIT,
  openLimit = 0,
} = {}) {
  const buckets = { todo: [], doing: [], blocked: [], done: [] };
  for (const task of tasks || []) {
    if (buckets[task.status]) buckets[task.status].push(task);
  }
  return KANBAN_COLUMNS.map(({ status, label }) => {
    const sorted = [...buckets[status]].sort(status === 'done' ? compareDone : compareOpen);
    const limit = status === 'done' ? doneLimit : openLimit;
    const isExpanded = (status === 'done' && doneExpanded) || Boolean(expandedCols?.has?.(status));
    const shouldCollapse = limit > 0 && !isExpanded && sorted.length > limit;
    const visibleTasks = shouldCollapse ? sorted.slice(0, limit) : sorted;
    const hiddenTasks = shouldCollapse ? sorted.slice(limit) : [];
    return {
      status,
      label,
      total: sorted.length,
      allTasks: sorted,
      stacked: shouldCollapse,
      visibleTasks,
      hiddenTasks,
      hiddenCount: hiddenTasks.length,
      isExpanded,
    };
  });
}

export function kanbanStatusTransition(task, targetStatus) {
  if (!task || !['todo', 'doing', 'blocked', 'done'].includes(targetStatus)) return null;
  if (task.status === targetStatus) return null;
  let progress = Number(task.progress ?? 0);
  if (targetStatus === 'todo') progress = 0;
  else if (targetStatus === 'done') progress = 100;
  else if (targetStatus === 'doing') progress = progress > 0 && progress < 100 ? progress : 10;
  else if (targetStatus === 'blocked') progress = progress === 100 ? 90 : progress;
  return { status: targetStatus, progress };
}
