// 纯函数指标计算,浏览器与 Node 通用。
const DAY = 86400000;
export const toDay = (s) => Math.floor(Date.parse(s + 'T00:00:00Z') / DAY);
export const fromDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);

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
    i.forecastEnd = i.e + i.slip;
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
  for (const t of data.tasks) if (!tail || longest(t.id).len > best.get(tail).len) tail = t.id;
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
