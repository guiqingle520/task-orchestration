import { toDay, fromDay } from './metrics.js';

// 快照按任务 ID 对比；返回变化值而非修改任何计划。
export function comparePlans(before, after) {
  const old = new Map(before.tasks.map((task) => [task.id, task]));
  const now = new Map(after.tasks.map((task) => [task.id, task]));
  const changes = [];
  for (const id of new Set([...old.keys(), ...now.keys()])) {
    const a = old.get(id), b = now.get(id);
    if (!a || !b) { changes.push({ id, type: a ? 'removed' : 'added', title: (a || b).title }); continue; }
    const fields = ['title', 'owner', 'milestone', 'start', 'end', 'status', 'progress', 'actualStart', 'actualEnd'];
    const differences = fields.filter((key) => a[key] !== b[key]).map((key) => ({ field: key, before: a[key], after: b[key] }));
    if (JSON.stringify(a.deps || []) !== JSON.stringify(b.deps || [])) differences.push({ field: 'deps', before: (a.deps || []).join(', '), after: (b.deps || []).join(', ') });
    if (differences.length) changes.push({ id, type: 'changed', title: b.title, differences });
  }
  return changes;
}

// 热力图按周取每日并行任务的峰值；建议是单任务顺延试算，不自动改计划。
export function analyzeLoad(plan, capacity = 2) {
  const unfinished = plan.tasks.filter((task) => task.status !== 'done');
  const owners = [...new Set(unfinished.map((task) => task.owner))];
  const weekStart = (day) => day - ((day + 3) % 7 + 7) % 7;
  if (!unfinished.length) return { weeks: [], load: {}, conflicts: [], suggestions: [] };
  const min = Math.min(...unfinished.map((task) => toDay(task.start)));
  const max = Math.max(...unfinished.map((task) => toDay(task.end)));
  const weeks = [], load = Object.fromEntries(owners.map((owner) => [owner, {}])), conflicts = [];
  for (let w = weekStart(min); w <= max; w += 7) weeks.push(w);
  for (const owner of owners) {
    const assigned = unfinished.filter((task) => task.owner === owner);
    for (const week of weeks) {
      let peak = 0;
      for (let day = week; day < week + 7; day++) {
        const active = assigned.filter((task) => toDay(task.start) <= day && toDay(task.end) >= day);
        peak = Math.max(peak, active.length);
        if (active.length > capacity) conflicts.push({ owner, day: fromDay(day), taskIds: active.map((task) => task.id) });
      }
      load[owner][week] = peak;
    }
  }
  const suggestions = [];
  for (const owner of owners) {
    const conflict = conflicts.find((item) => item.owner === owner);
    if (!conflict) continue;
    const assigned = unfinished.filter((task) => task.owner === owner);
    const candidate = assigned.find((task) => task.id === conflict.taskIds.at(-1));
    const duration = toDay(candidate.end) - toDay(candidate.start) + 1;
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    let start = Math.max(toDay(candidate.start) + 1, ...candidate.deps.map((id) => byId.has(id) ? toDay(byId.get(id).end) + 1 : toDay(candidate.start)));
    let found = false;
    for (let attempt = 0; attempt < 3650; attempt++, start++) {
      let fits = true;
      for (let day = start; day < start + duration && fits; day++) {
        fits = assigned.filter((task) => task.id !== candidate.id && toDay(task.start) <= day && toDay(task.end) >= day).length < capacity;
      }
      if (fits) { found = true; break; }
    }
    if (found) suggestions.push({ owner, id: candidate.id, start: fromDay(start), end: fromDay(start + duration - 1), conflictDay: conflict.day });
  }
  return { weeks, load, conflicts, suggestions };
}

const markdownCell = (value) => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const xmlText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

export function buildReport(plan, metrics, today) {
  const since = fromDay(toDay(today) - 6);
  const completed = plan.tasks.filter((task) => task.actualEnd && task.actualEnd >= since && task.actualEnd <= today);
  const started = plan.tasks.filter((task) => task.actualStart && task.actualStart >= since && task.actualStart <= today);
  const summary = `${plan.project}：总体进度 ${Math.round(metrics.summary.overall)}%，已完成 ${plan.tasks.filter((t) => t.status === 'done').length}/${plan.tasks.length} 项，逾期 ${metrics.summary.overdueCount} 项，阻塞 ${metrics.summary.blockedCount} 项。`;
  const lines = [`# ${markdownCell(plan.project)} 进度报告`, '', `截至：${today}；周报范围：${since} 至 ${today}（按实际开始和结束日期统计）`, '', summary, '', '## 本周动态', '', `- 开始：${started.length ? started.map((task) => markdownCell(task.id)).join('、') : '无'}`, `- 完成：${completed.length ? completed.map((task) => markdownCell(task.id)).join('、') : '无'}`, '', '## 里程碑', '', '| 里程碑 | 目标日期 | 预计完成 | 进度 |', '| --- | --- | --- | ---: |', ...metrics.milestones.map((m) => `| ${markdownCell(m.name)} | ${m.due} | ${m.forecast} | ${Math.round(m.progress)}% |`), '', '## 风险', '', ...(metrics.risks.length ? metrics.risks.map((risk) => `- ${markdownCell(risk.id)}：${markdownCell(risk.text)}`) : ['- 暂无']), '', '## 任务', '', '| ID | 任务 | 负责人 | 状态 | 进度 |', '| --- | --- | --- | --- | ---: |', ...plan.tasks.map((task) => `| ${markdownCell(task.id)} | ${markdownCell(task.title)} | ${markdownCell(task.owner)} | ${markdownCell(task.status)} | ${task.progress}% |`), ''];
  return { summary, markdown: lines.join('\n') };
}

export function buildReportSvg(plan, metrics, today) {
  const height = 150 + plan.tasks.length * 30;
  const rows = plan.tasks.map((task, index) => {
    const y = 130 + index * 30;
    const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
    const title = Array.from(task.title);
    const label = title.length > 28 ? `${title.slice(0, 28).join('')}…` : task.title;
    return `<text x="24" y="${y}" font-size="13"><title>${xmlText(task.title)}</title>${xmlText(task.id)} ${xmlText(label)}</text><rect x="490" y="${y - 12}" width="220" height="12" rx="6" fill="#e2e8f0"/><rect x="490" y="${y - 12}" width="${220 * progress / 100}" height="12" rx="6" fill="#2563eb"/><text x="720" y="${y}" font-size="12">${progress}%</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${height}" viewBox="0 0 800 ${height}"><rect width="100%" height="100%" fill="white"/><g font-family="Arial, Microsoft YaHei, sans-serif" fill="#0f172a"><text x="24" y="38" font-size="22" font-weight="bold">${xmlText(plan.project)} 进度报告</text><text x="24" y="66" font-size="13">截至 ${xmlText(today)} · 总体 ${Math.round(metrics.summary.overall)}% · 逾期 ${metrics.summary.overdueCount} · 阻塞 ${metrics.summary.blockedCount}</text><text x="24" y="100" font-size="14" font-weight="bold">任务</text><text x="490" y="100" font-size="14" font-weight="bold">完成进度</text>${rows}</g></svg>`;
}
