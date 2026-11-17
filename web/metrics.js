// 纯函数指标计算,浏览器与 Node 通用。
const DAY = 86400000;
export const toDay = (s) => Math.floor(Date.parse(s + 'T00:00:00Z') / DAY);
export const fromDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);

// 推演使用日历日及完成后下一日开始的依赖关系,不修改输入计划。
export function simulateDelays(data, delays = {}) {
  const tasks = data.tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('任务 ID 重复');
  for (const [id, days] of Object.entries(delays)) {
    if (!byId.has(id)) throw new Error(`未知任务: ${id}`);
    if (!Number.isSafeInteger(days) || days < 0) throw new Error(`延期天数必须为非负整数: ${id}`);
  }

  const ordered = [], visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`任务依赖存在循环: ${id}`);
    const task = byId.get(id);
    if (!task) throw new Error(`未知依赖: ${id}`);
    visiting.add(id);
    for (const dep of task.deps || []) visit(dep);
    visiting.delete(id);
    visited.add(id);
    ordered.push(task);
  }
  for (const task of tasks) visit(task.id);

  const baseline = new Map(), simulated = new Map(), successors = new Map(tasks.map((t) => [t.id, []]));
  for (const task of ordered) {
    const start = toDay(task.start), end = toDay(task.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || fromDay(start) !== task.start || fromDay(end) !== task.end || end < start) {
      throw new Error(`任务日期无效: ${task.id}`);
    }
    const duration = end - start + 1;
    const deps = task.deps || [];
    for (const dep of deps) successors.get(dep).push(task.id);
    const baseStart = Math.max(start, ...deps.map((id) => baseline.get(id).end + 1));
    const simStart = Math.max(baseStart + (delays[task.id] || 0), ...deps.map((id) => simulated.get(id).end + 1));
    baseline.set(task.id, { start: baseStart, end: baseStart + duration - 1 });
    simulated.set(task.id, { start: simStart, end: simStart + duration - 1 });
  }

  const projectEnd = Math.max(...Array.from(simulated.values(), (item) => item.end));
  const latestStart = new Map(), slack = new Map();
  for (const task of [...ordered].reverse()) {
    const item = simulated.get(task.id);
    const ends = successors.get(task.id).map((id) => latestStart.get(id) - 1);
    const latestEnd = Math.min(projectEnd, ...ends);
    slack.set(task.id, latestEnd - item.end);
    latestStart.set(task.id, latestEnd - (item.end - item.start));
  }

  const resultTasks = Object.fromEntries(tasks.map((task) => {
    const base = baseline.get(task.id), sim = simulated.get(task.id);
    return [task.id, {
      baselineStart: fromDay(base.start), baselineEnd: fromDay(base.end),
      start: fromDay(sim.start), end: fromDay(sim.end),
      delayDays: sim.end - base.end, directDelayDays: delays[task.id] || 0,
      slackDays: slack.get(task.id), critical: slack.get(task.id) === 0,
    }];
  }));
  const milestones = data.milestones.map((milestone) => {
    const members = tasks.filter((task) => task.milestone === milestone.id);
    if (!members.length) return { id: milestone.id, baselineEnd: null, end: null, delayDays: 0 };
    const baseEnd = Math.max(...members.map((task) => baseline.get(task.id).end));
    const simEnd = Math.max(...members.map((task) => simulated.get(task.id).end));
    return { id: milestone.id, baselineEnd: fromDay(baseEnd), end: fromDay(simEnd), delayDays: simEnd - baseEnd };
  });
  return { tasks: resultTasks, milestones, criticalTaskIds: tasks.filter((task) => resultTasks[task.id].critical).map((task) => task.id) };
}

export function compute(data, todayStr) {
  const today = toDay(todayStr);
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const info = new Map();

  for (const t of data.tasks) {
    const s = toDay(t.start), e = toDay(t.end);
    const dur = e - s + 1;
    const expected = t.status === 'done' ? 100 : Math.max(0, Math.min(100, ((today - s + 1) / dur) * 100));
    const behind = Math.max(0, expected - t.progress); // 落后百分点
    const overdue = t.status !== 'done' && today > e;
    let ownSlip = 0;
    if (t.status === 'done') ownSlip = Math.max(0, toDay(t.actualEnd) - e);
    else if (overdue) ownSlip = today - e;
    else if (behind > 20) ownSlip = Math.ceil((behind / 100) * dur);
    let health = 'green';
    if (t.status === 'blocked' || overdue || behind > 40) health = 'red';
    else if (behind > 20) health = 'yellow';
    if (t.status === 'done') health = 'green';
    info.set(t.id, { s, e, dur, expected, behind, overdue, ownSlip, health });
  }

  // 延期传导(按拓扑序记忆化)
  const slip = new Map();
  const slipOf = (id) => {
    if (slip.has(id)) return slip.get(id);
    slip.set(id, 0);
    const t = byId.get(id);
    const v = Math.max(info.get(id).ownSlip, ...(t.deps || []).map(slipOf), 0);
    slip.set(id, v);
    return v;
  };
  for (const t of data.tasks) {
    const i = info.get(t.id);
    i.slip = slipOf(t.id);
    i.forecastEnd = t.status === 'done' && t.actualEnd ? toDay(t.actualEnd) : i.e + i.slip;
    i.propagated = t.status !== 'done' && i.slip > i.ownSlip; // 因上游而延期
  }

  // 关键路径:按计划时长累计的最长链
  const best = new Map();
  const longest = (id) => {
    if (best.has(id)) return best.get(id);
    best.set(id, { len: 0, prev: null });
    const t = byId.get(id);
    let b = { len: info.get(id).dur, prev: null };
    for (const d of t.deps || []) {
      const l = longest(d).len + info.get(id).dur;
      if (l > b.len) b = { len: l, prev: d };
    }
    best.set(id, b);
    return b;
  };
  let tail = null;
  for (const t of data.tasks) {
    const length = longest(t.id).len;
    if (!tail || length > best.get(tail).len) tail = t.id;
  }
  const critical = new Set();
  for (let n = tail; n; n = best.get(n).prev) critical.add(n);
  for (const t of data.tasks) info.get(t.id).critical = critical.has(t.id);

  // 里程碑
  const milestones = data.milestones.map((m) => {
    const ts = data.tasks.filter((t) => t.milestone === m.id);
    const due = toDay(m.due);
    const forecast = Math.max(due - 9999, ...ts.map((t) => info.get(t.id).forecastEnd));
    const total = ts.reduce((a, t) => a + info.get(t.id).dur, 0) || 1;
    const progress = ts.reduce((a, t) => a + (t.progress * info.get(t.id).dur) / 100, 0) / total * 100;
    return { ...m, daysLeft: due - today, forecast: fromDay(forecast), slipDays: forecast - due, progress, taskCount: ts.length };
  });

  // 负载:每人每周(周一起算)未完成任务数
  const weekStart = (d) => d - ((d + 3) % 7); // 1970-01-01 是周四
  const load = {};
  let minW = Infinity, maxW = -Infinity;
  for (const t of data.tasks) {
    if (t.status === 'done') continue;
    const i = info.get(t.id);
    for (let w = weekStart(i.s); w <= i.e; w += 7) {
      (load[t.owner] ||= {})[w] = (load[t.owner][w] || 0) + 1;
      minW = Math.min(minW, w); maxW = Math.max(maxW, w);
    }
  }
  const weeks = [];
  for (let w = minW; w <= maxW; w += 7) weeks.push(w);

  // 风险列表
  const risks = [];
  for (const t of data.tasks) {
    const i = info.get(t.id);
    if (t.status === 'done') continue;
    if (t.status === 'blocked') risks.push({ level: 'red', id: t.id, text: `${t.title} 被阻塞` });
    else if (i.overdue) risks.push({ level: 'red', id: t.id, text: `${t.title} 已逾期 ${today - i.e} 天(进度 ${t.progress}%)` });
    else if (i.behind > 20) risks.push({ level: i.health, id: t.id, text: `${t.title} 落后计划 ${Math.round(i.behind)} 个百分点` });
    else if (i.propagated) risks.push({ level: 'yellow', id: t.id, text: `${t.title} 受上游延期影响,预计晚 ${i.slip} 天` });
  }
  for (const m of milestones) if (m.slipDays > 0) risks.push({ level: 'red', id: m.id, text: `里程碑 ${m.name} 预计延期 ${m.slipDays} 天(预计 ${m.forecast})` });
  risks.sort((a, b) => (a.level === 'red' ? 0 : 1) - (b.level === 'red' ? 0 : 1));

  const totalDur = data.tasks.reduce((a, t) => a + info.get(t.id).dur, 0) || 1;
  const overall = data.tasks.reduce((a, t) => a + (t.progress * info.get(t.id).dur) / 100, 0) / totalDur * 100;
  const expectedAll = data.tasks.reduce((a, t) => a + (info.get(t.id).expected * info.get(t.id).dur) / 100, 0) / totalDur * 100;
  const reds = data.tasks.filter((t) => info.get(t.id).health === 'red').length;
  const health = reds || milestones.some((m) => m.slipDays > 0) ? 'red'
    : data.tasks.some((t) => info.get(t.id).health === 'yellow') ? 'yellow' : 'green';

  return {
    today: todayStr, info: Object.fromEntries(info), milestones, risks, load, weeks, weekStart,
    summary: { overall, expectedAll, health, overdueCount: data.tasks.filter((t) => info.get(t.id).overdue).length,
      blockedCount: data.tasks.filter((t) => t.status === 'blocked').length,
      nextMilestone: milestones.filter((m) => m.daysLeft >= 0).sort((a, b) => a.daysLeft - b.daysLeft)[0] || null },
  };
}
