// Pass the whole plan's task list, then apply the owner's filter to the result.
export function readyTasks(tasks, today) {
  const completed = new Set(tasks.filter(task => task.status === 'done').map(task => task.id));
  return tasks
    .filter(task => task.status === 'todo' && task.deps.every(id => completed.has(id)))
    .map(task => ({
      task,
      availability: task.start <= today ? 'now' : 'early',
      reason: task.deps.length ? `前置 ${task.deps.join('、')} 均已完成` : '无前置依赖',
    }))
    .sort((a, b) => a.task.start.localeCompare(b.task.start)
      || a.task.id.localeCompare(b.task.id, 'en', { numeric: true }));
}

// Preview and clipboard use the same plain text and the same displayed snapshot.
export function buildTaskHandoff(plan, taskId, acceptanceByTask = {}) {
  const tasks = new Map(plan.tasks.map(task => [task.id, task]));
  const task = tasks.get(taskId);
  if (!task) return null;
  const milestone = plan.milestones.find(item => item.id === task.milestone);
  const dependencies = task.deps.map(id => {
    const dependency = tasks.get(id);
    return dependency ? `- ${id} ${dependency.title}（${dependency.status}，${dependency.progress}%）` : `- ${id}（找不到任务）`;
  });
  return [
    `项目：${plan.project}`,
    `任务：${task.id} ${task.title}`,
    `里程碑：${task.milestone}${milestone ? ' ' + milestone.name : ''}`,
    `负责人：${task.owner}`,
    `计划日期：${task.start} 至 ${task.end}`,
    `当前进度：${task.status}，${task.progress}%`,
    dependencies.length ? '前置任务：\n' + dependencies.join('\n') : '前置任务：无前置依赖',
    `验收要求：${acceptanceByTask[task.id] || '未填写'}`,
    '计划来源：plan/plan.md',
  ].join('\n');
}
