import { toDay, fromDay } from './metrics.js';

// 历史值仅根据当前完成日期重建，不代表历史时点的真实进度或范围。
export function computeBurndown(plan, todayStr, milestoneId = null) {
  const today = toDay(todayStr);
  if (!Number.isFinite(today) || fromDay(today) !== todayStr) throw new Error('日期无效');
  const scope = milestoneId && milestoneId !== 'all' ? milestoneId : 'all';
  const milestone = scope === 'all' ? null : plan.milestones.find((item) => item.id === scope);
  if (scope !== 'all' && !milestone) throw new Error('里程碑不存在');
  const tasks = plan.tasks.filter((task) => scope === 'all' || task.milestone === scope);
  if (!tasks.length) return { milestoneId: scope, startDate: null, endDate: null, totalScope: 0, remainingScope: 0, velocity: 0, forecastEnd: null, slipDays: null, series: [] };
  const items = tasks.map((task) => {
    const start = toDay(task.start), end = toDay(task.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || fromDay(start) !== task.start || fromDay(end) !== task.end || end < start) throw new Error(`任务日期无效: ${task.id}`);
    return { task, start, end, weight: end - start + 1 };
  });
  const start = Math.min(...items.map((item) => item.start));
  const due = scope === 'all' ? plan.milestones.map((item) => toDay(item.due)) : [toDay(milestone.due)];
  const end = Math.max(...items.map((item) => item.end), ...due);
  if (!Number.isFinite(end)) throw new Error('里程碑日期无效');
  const totalScope = items.reduce((sum, item) => sum + item.weight, 0);
  const actualAt = (day) => items.reduce((sum, item) => {
    const { task, weight } = item;
    if (task.status === 'done' && task.actualEnd && toDay(task.actualEnd) <= day) return sum;
    if (day === today && task.status !== 'done') return sum + weight * (1 - Math.max(0, Math.min(100, task.progress || 0)) / 100);
    return sum + weight;
  }, 0);
  const remainingScope = actualAt(today);
  const startWindow = Math.max(start, today - 7);
  const window = today - startWindow;
  const rawVelocity = window > 0 ? Math.max(0, actualAt(startWindow) - remainingScope) / window : 0;
  const velocity = Math.round(rawVelocity * 100) / 100;
  const finish = remainingScope === 0 ? today : rawVelocity > 0 ? today + Math.ceil(remainingScope / rawVelocity) : null;
  const series = [];
  for (let day = start; day <= Math.max(end, today); day++) {
    const ideal = items.reduce((sum, item) => sum + Math.max(0, item.end - Math.max(day, item.start - 1)), 0);
    series.push({ date: fromDay(day), ideal, actual: day <= today ? actualAt(day) : null });
  }
  return { milestoneId: scope, startDate: fromDay(start), endDate: fromDay(end), totalScope, remainingScope, velocity, forecastEnd: finish === null ? null : fromDay(finish), slipDays: finish === null ? null : remainingScope === 0 ? 0 : finish - end, series };
}

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

// 回放差异按任务 ID 连接两帧。负值表示提前或进度回退，缺失一侧用 null。
export function computeTimelineDiff(baselinePlan, currentPlan) {
  const baseline = new Map(baselinePlan.tasks.map((task) => [task.id, task]));
  const current = new Map(currentPlan.tasks.map((task) => [task.id, task]));
  const summary = { addedCount: 0, removedCount: 0, shiftedCount: 0, totalSlipDays: 0 };
  const entries = [];
  for (const id of new Set([...baseline.keys(), ...current.keys()])) {
    const before = baseline.get(id), after = current.get(id);
    const status = !before ? 'added' : !after ? 'removed' : 'common';
    const startShiftDays = status === 'common' ? toDay(after.start) - toDay(before.start) : null;
    const endShiftDays = status === 'common' ? toDay(after.end) - toDay(before.end) : null;
    if (status === 'added') summary.addedCount++;
    else if (status === 'removed') summary.removedCount++;
    else {
      if (startShiftDays || endShiftDays) summary.shiftedCount++;
      summary.totalSlipDays += endShiftDays;
    }
    entries.push([id, {
      status,
      baselineStart: before?.start ?? null, baselineEnd: before?.end ?? null,
      currentStart: after?.start ?? null, currentEnd: after?.end ?? null,
      startShiftDays, endShiftDays,
      durationDelta: status === 'common' ? endShiftDays - startShiftDays : null,
      progressDelta: status === 'common' ? after.progress - before.progress : null,
    }]);
  }
  return { baselineProject: baselinePlan.project, currentProject: currentPlan.project, summary, tasks: Object.fromEntries(entries) };
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

// 只投影公开快照所需要的字段；不会把侧车配置或计划正文带入分享包。
export function sanitizePlanForShare(plan, options = {}) {
  const owners = new Map();
  const label = (index) => {
    let suffix = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
      suffix = String.fromCharCode(65 + (n - 1) % 26) + suffix;
    }
    return '成员-' + suffix;
  };
  const publicTitle = (title) => options.stripInternalNotes
    ? String(title).replace(/\s*(?:\[内部[:：][^\]]*\]|【内部[:：][^】]*】|<!--[\s\S]*?-->)\s*/g, ' ').trim()
    : title;
  const tasks = plan.tasks.map(({ id, title, owner, milestone, start, end, deps, status, progress, actualStart, actualEnd }) => {
    if (options.maskOwners && !owners.has(owner)) owners.set(owner, label(owners.size));
    return {
      id, title: publicTitle(title), owner: options.maskOwners ? owners.get(owner) : owner,
      milestone, start, end, deps: [...deps], status, progress, actualStart: actualStart ?? null, actualEnd: actualEnd ?? null,
    };
  });
  return {
    plan: {
      project: options.customTitle?.trim() || plan.project,
      milestones: plan.milestones.map(({ id, name, due }) => ({ id, name, due })),
      tasks,
    },
    ownerMap: Object.fromEntries(owners),
  };
}

const calendarDay = (date) => {
  const day = toDay(date);
  if (typeof date !== 'string' || !Number.isFinite(day) || fromDay(day) !== date) throw new Error('无效日历日期');
  return day;
};
const weekday = (day) => ((day + 4) % 7 + 7) % 7;
const isWeekend = (day) => weekday(day) === 0 || weekday(day) === 6;

function workingDayCounter(config) {
  const holidays = new Set((config.holidays ?? []).map(calendarDay));
  const workdays = new Set((config.workdays ?? []).map(calendarDay));
  const excludeWeekends = config.excludeWeekends !== false;
  return (start, end) => {
    if (end < start) return 0;
    const span = end - start + 1;
    const fullWeeks = Math.floor(span / 7);
    let count = excludeWeekends ? fullWeeks * 5 : span;
    if (excludeWeekends) {
      for (let day = start + fullWeeks * 7; day <= end; day++) if (!isWeekend(day)) count++;
      for (const day of workdays) if (day >= start && day <= end && isWeekend(day) && !holidays.has(day)) count++;
    }
    for (const day of holidays) if (day >= start && day <= end && (!excludeWeekends || !isWeekend(day))) count--;
    return count;
  };
}

export function countWorkingDays(startStr, endStr, calendarConfig = {}) {
  return workingDayCounter(calendarConfig)(calendarDay(startStr), calendarDay(endStr));
}

export function computeCapacityMetrics(plan, capacityConfig = {}, todayStr) {
  const countDays = workingDayCounter(capacityConfig);
  const today = calendarDay(todayStr);
  const hoursPerDay = capacityConfig.hoursPerDay ?? 8;
  const calendarWarnings = [];
  const owners = new Map();
  const empty = () => ({
    taskCount: 0, doneCount: 0, storyPoints: 0, completedStoryPoints: 0, estimateHours: 0,
    reportedActualHours: 0, inferredActualHours: 0, sampledDoneCount: 0, accuracyTotal: 0,
    sampleEstimate: 0, sampleActual: 0,
  });
  const team = empty();
  const round = (value, digits) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
  const totalsFor = (group, item, done, sampled) => {
    group.taskCount++;
    group.storyPoints += item.storyPoints;
    group.estimateHours += item.estimateHours;
    if (done) { group.doneCount++; group.completedStoryPoints += item.storyPoints; }
    if (item.actualSource === 'reported') group.reportedActualHours += item.actualHours;
    if (item.actualSource === 'inferred') group.inferredActualHours += item.actualHours;
    if (sampled) {
      group.sampledDoneCount++;
      group.accuracyTotal += item.accuracyPct;
      group.sampleEstimate += item.estimateHours;
      group.sampleActual += item.actualHours;
    }
  };
  const tasks = Object.fromEntries(plan.tasks.map((task) => {
    const config = capacityConfig.tasks?.[task.id] ?? {};
    const start = calendarDay(task.start), end = calendarDay(task.end);
    const workingDays = countDays(start, end);
    if (!workingDays) calendarWarnings.push({ id: task.id, message: '计划排期完全处于周末或节假日(有效工作日为 0)' });
    const done = task.status === 'done';
    const defaultEstimateHours = Math.max(1, workingDays) * hoursPerDay;
    const estimateHours = config.estimateHours ?? defaultEstimateHours;
    const actualWorkingDays = task.actualStart
      ? countDays(calendarDay(task.actualStart), task.actualEnd ? calendarDay(task.actualEnd) : today) : null;
    const actualSource = config.actualHours != null ? 'reported' : done ? 'inferred' : 'none';
    const actualHours = config.actualHours ?? (done ? Math.max(1, actualWorkingDays ?? 1) * hoursPerDay : null);
    const sampled = done && actualSource === 'reported' && estimateHours > 0;
    const result = {
      calendarDays: end - start + 1, workingDays, defaultEstimateHours, actualWorkingDays,
      storyPoints: config.storyPoints ?? Math.max(1, workingDays), estimateHours,
      estimateSource: config.estimateHours != null ? 'reported' : 'inferred', actualHours, actualSource,
      inflationRatio: sampled ? round(actualHours / estimateHours, 2) : null,
      accuracyPct: sampled ? round(Math.max(0, 1 - Math.abs(actualHours - estimateHours) / estimateHours) * 100, 1) : null,
    };
    if (!owners.has(task.owner)) owners.set(task.owner, empty());
    totalsFor(team, result, done, sampled);
    totalsFor(owners.get(task.owner), result, done, sampled);
    return [task.id, result];
  }));
  const summarize = ({ accuracyTotal, sampleEstimate, sampleActual, ...group }) => ({
    ...group,
    accuracyPct: group.sampledDoneCount ? round(accuracyTotal / group.sampledDoneCount, 1) : null,
    inflationRatio: group.sampledDoneCount ? round(sampleActual / sampleEstimate, 2) : null,
  });
  const summary = summarize(team);
  return {
    hoursPerDay, totalStoryPoints: summary.storyPoints, completedStoryPoints: summary.completedStoryPoints,
    totalEstimateHours: summary.estimateHours, reportedActualHours: summary.reportedActualHours,
    inferredActualHours: summary.inferredActualHours, sampledDoneCount: summary.sampledDoneCount,
    overallAccuracyPct: summary.accuracyPct, overallInflationRatio: summary.inflationRatio,
    calendarWarnings, byOwner: [...owners].map(([owner, totals]) => ({ owner, ...summarize(totals) })), tasks,
  };
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
