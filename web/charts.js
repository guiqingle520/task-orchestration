import { fromDay, toDay } from './metrics.js';

const STATUS_META = [
  { key: 'done', label: '已完成', color: '#16a34a' },
  { key: 'doing', label: '进行中', color: '#2458cf' },
  { key: 'blocked', label: '阻塞', color: '#dc2626' },
  { key: 'todo', label: '未开始', color: '#94a3b8' },
];

export function computeStatusBreakdown(tasks, milestoneId = 'all') {
  const scope = milestoneId && milestoneId !== 'all' ? milestoneId : 'all';
  const scoped = (tasks || []).filter((t) => scope === 'all' || t.milestone === scope);
  const counts = { done: 0, doing: 0, blocked: 0, todo: 0 };
  for (const t of scoped) {
    if (Object.hasOwn(counts, t.status)) counts[t.status]++;
  }
  const total = scoped.length;
  const items = STATUS_META.map((m) => ({
    ...m,
    count: counts[m.key],
    pct: total ? Math.round((counts[m.key] / total) * 1000) / 10 : 0,
  }));
  return {
    milestoneId: scope,
    total,
    donePct: total ? Math.round((counts.done / total) * 100) : 0,
    counts,
    items,
  };
}

export function renderStatusDonutSvg(breakdown, esc = (s) => String(s)) {
  if (!breakdown?.total) return '<p class="empty">当前范围内暂无任务</p>';
  const cx = 68, cy = 72, r = 46, circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = breakdown.items
    .filter((item) => item.count > 0)
    .map((item) => {
      const len = (item.count / breakdown.total) * circ;
      const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${item.color}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${circ.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})" data-chart-status="${esc(item.key)}" style="cursor:pointer"><title>${esc(item.label)}：${item.count} 项 (${item.pct}%)</title></circle>`;
      offset += len;
      return seg;
    }).join('');

  const legend = breakdown.items.map((item) => `
    <button type="button" class="chart-legend-btn" data-chart-status="${esc(item.key)}" title="点击到时间线筛选「${esc(item.label)}」">
      <i class="chart-dot" style="background:${item.color}"></i>
      <span>${esc(item.label)}</span>
      <strong>${item.count}</strong>
      <small>${item.pct}%</small>
    </button>
  `).join('');

  return `<div class="chart-donut-wrap">
    <svg viewBox="0 0 136 144" class="chart-donut-svg" role="img" aria-label="任务四态分布环形图">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f1f5f9" stroke-width="18"/>
      ${arcs}
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="18" font-weight="700" fill="var(--t)">${breakdown.donePct}%</text>
      <text x="${cx}" y="${cy + 13}" text-anchor="middle" font-size="10" fill="var(--m)">已完成 (${breakdown.total})</text>
    </svg>
    <div class="chart-donut-legend">${legend}</div>
  </div>`;
}

export function computeThroughput(tasks, todayStr, days = 14, milestoneId = 'all') {
  const today = toDay(todayStr);
  if (!Number.isFinite(today) || fromDay(today) !== todayStr) return { days: [], totalDone: 0, avgPerDay: 0 };
  const scope = milestoneId && milestoneId !== 'all' ? milestoneId : 'all';
  const scoped = (tasks || []).filter((t) => (scope === 'all' || t.milestone === scope) && t.status === 'done');
  const byDay = new Map();
  for (const t of scoped) {
    const dStr = t.actualEnd || t.end;
    const d = toDay(dStr);
    if (!Number.isFinite(d)) continue;
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  const start = today - days + 1;
  const series = [];
  for (let d = start; d <= today; d++) {
    const count = byDay.get(d) || 0;
    let sum7 = 0;
    let win = 0;
    for (let k = Math.max(start, d - 6); k <= d; k++) {
      sum7 += byDay.get(k) || 0;
      win++;
    }
    series.push({
      date: fromDay(d),
      label: fromDay(d).slice(5),
      count,
      avg7: Math.round((sum7 / win) * 100) / 100,
    });
  }
  const totalDone = series.reduce((s, x) => s + x.count, 0);
  return {
    days: series,
    totalDone,
    avgPerDay: Math.round((totalDone / Math.max(1, series.length)) * 100) / 100,
  };
}

export function renderThroughputSvg(throughput, esc = (s) => String(s)) {
  const list = throughput?.days || [];
  if (!list.length) return '<p class="empty">暂无交付数据</p>';
  const W = 320, H = 148, padL = 26, padR = 10, padT = 14, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxY = Math.max(2, ...list.map((d) => Math.max(d.count, d.avg7)));
  const step = plotW / list.length;
  const barW = Math.max(6, step * 0.58);
  const yOf = (v) => padT + (1 - v / maxY) * plotH;
  const xCenter = (i) => padL + i * step + step / 2;

  const bars = list.map((d, i) => {
    const h = (d.count / maxY) * plotH;
    const x = xCenter(i) - barW / 2;
    const y = yOf(d.count);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="2" fill="${d.count ? '#2458cf' : '#e2e8f0'}" opacity="0.82"><title>${esc(d.date)}：完成 ${d.count} 项（7日均值 ${d.avg7}）</title></rect>`;
  }).join('');

  const avgPts = list.map((d, i) => `${xCenter(i).toFixed(1)},${yOf(d.avg7).toFixed(1)}`).join(' ');
  const xLabels = [0, Math.floor((list.length - 1) / 2), list.length - 1]
    .map((idx) => `<text x="${xCenter(idx).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--m)">${esc(list[idx].label)}</text>`)
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="burndown-svg" role="img" aria-label="近14天交付吞吐量趋势图">
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="var(--b)" stroke-width="1"/>
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--b)" stroke-width="1"/>
    <text x="${padL - 4}" y="${padT + 4}" text-anchor="end" font-size="9" fill="var(--m)">${Math.ceil(maxY)}</text>
    <text x="${padL - 4}" y="${H - padB}" text-anchor="end" font-size="9" fill="var(--m)">0</text>
    ${bars}
    <polyline fill="none" stroke="#16a34a" stroke-width="2" points="${avgPts}"/>
    ${xLabels}
  </svg>`;
}

export function renderMilestoneCompareSvg(milestones, milestoneDelayFn, esc = (s) => String(s)) {
  if (!milestones?.length) return '<p class="empty">暂无可对比的里程碑</p>';
  const rowH = 28, padL = 112, padR = 76, padT = 8, W = 540;
  const barAreaW = W - padL - padR;
  const H = padT * 2 + milestones.length * rowH;

  const rows = milestones.map((ms, i) => {
    const y = padT + i * rowH;
    const pct = Math.max(0, Math.min(100, Math.round(ms.progress || 0)));
    const delay = milestoneDelayFn ? milestoneDelayFn(ms) : null;
    const color = delay ? '#dc2626' : pct === 100 ? '#16a34a' : '#2458cf';
    const fillW = (pct / 100) * barAreaW;
    const tag = delay ? `${delay.label} ${delay.days}天` : pct === 100 ? '已交付' : `${pct}%`;
    return `<g>
      <text x="${padL - 8}" y="${y + 16}" text-anchor="end" font-size="11" font-weight="600" fill="var(--t)">${esc(ms.id)} · ${esc(ms.name.slice(0, 7))}${ms.name.length > 7 ? '…' : ''}<title>${esc(ms.id)} · ${esc(ms.name)}（${pct}%，截止 ${esc(ms.due)}）</title></text>
      <rect x="${padL}" y="${y + 6}" width="${barAreaW}" height="12" rx="4" fill="#f1f5f9"/>
      <rect x="${padL}" y="${y + 6}" width="${fillW.toFixed(1)}" height="12" rx="4" fill="${color}"><title>${esc(ms.id)} · ${esc(ms.name)}：${pct}%（已完成 ${ms.doneCount}/${ms.taskCount}）</title></rect>
      <text x="${padL + barAreaW + 8}" y="${y + 16}" font-size="11" font-weight="600" fill="${delay ? '#b91c1c' : 'var(--m)'}">${esc(tag)}</text>
    </g>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart-wide-svg" role="img" aria-label="里程碑进度与延期横向对比图">${rows}</svg>`;
}

export function computeMemberWorkload(tasks) {
  const map = new Map();
  for (const t of tasks || []) {
    const key = t.owner || 'unassigned';
    if (!map.has(key)) map.set(key, { owner: key, done: 0, doing: 0, blocked: 0, todo: 0, total: 0 });
    const entry = map.get(key);
    if (Object.hasOwn(entry, t.status)) entry[t.status]++;
    entry.total++;
  }
  return [...map.values()].sort((a, b) => b.total - a.total || b.blocked - a.blocked || a.owner.localeCompare(b.owner, 'zh-CN'));
}

export function renderMemberLoadSvg(members, esc = (s) => String(s)) {
  if (!members?.length) return '<p class="empty">暂无成员任务分布</p>';
  const list = members.slice(0, 10);
  const rowH = 26, padL = 96, padR = 46, padT = 8, W = 520;
  const barW = W - padL - padR;
  const maxTotal = Math.max(1, ...list.map((m) => m.total));
  const H = padT * 2 + list.length * rowH;

  const rows = list.map((m, i) => {
    const y = padT + i * rowH;
    let x = padL;
    const segs = STATUS_META.map((s) => {
      const cnt = m[s.key] || 0;
      if (!cnt) return '';
      const w = (cnt / maxTotal) * barW;
      const rect = `<rect x="${x.toFixed(1)}" y="${y + 5}" width="${w.toFixed(1)}" height="13" fill="${s.color}"><title>${esc(m.owner)} · ${s.label}：${cnt} 项</title></rect>`;
      x += w;
      return rect;
    }).join('');
    return `<g>
      <text x="${padL - 8}" y="${y + 15}" text-anchor="end" font-size="11" font-weight="600" fill="var(--t)">${esc(m.owner.slice(0, 10))}</text>
      <rect x="${padL}" y="${y + 5}" width="${barW}" height="13" rx="3" fill="#f1f5f9"/>
      ${segs}
      <text x="${padL + barW + 8}" y="${y + 15}" font-size="11" fill="var(--m)">${m.total} 项</text>
    </g>`;
  }).join('');

  const legend = STATUS_META.map((s) => `<span><i class="chart-dot" style="background:${s.color}"></i>${s.label}</span>`).join('');
  return `<div class="chart-block">
    <svg viewBox="0 0 ${W} ${H}" class="chart-wide-svg" role="img" aria-label="成员工作量状态分布图">${rows}</svg>
    <div class="chart-inline-legend">${legend}</div>
  </div>`;
}

export function renderCapacityHoursSvg(byOwner, esc = (s) => String(s)) {
  if (!byOwner?.length) return '';
  const list = byOwner.slice(0, 8);
  const rowH = 30, padL = 88, padR = 56, padT = 8, W = 500;
  const barW = W - padL - padR;
  const maxH = Math.max(1, ...list.map((o) => Math.max(o.estimateHours || 0, (o.reportedActualHours || 0) + (o.inferredActualHours || 0))));
  const H = padT * 2 + list.length * rowH;

  const rows = list.map((o, i) => {
    const y = padT + i * rowH;
    const est = o.estimateHours || 0;
    const act = (o.reportedActualHours || 0) + (o.inferredActualHours || 0);
    const estW = (est / maxH) * barW;
    const actW = (act / maxH) * barW;
    const over = est > 0 && act > est * 1.15;
    const actColor = over ? '#dc2626' : '#2458cf';
    return `<g>
      <text x="${padL - 8}" y="${y + 18}" text-anchor="end" font-size="11" font-weight="600" fill="var(--t)">${esc(o.owner.slice(0, 9))}</text>
      <rect x="${padL}" y="${y + 4}" width="${estW.toFixed(1)}" height="8" rx="2" fill="#cbd5e1"><title>${esc(o.owner)} · 预估 ${est}h</title></rect>
      <rect x="${padL}" y="${y + 14}" width="${actW.toFixed(1)}" height="8" rx="2" fill="${actColor}"><title>${esc(o.owner)} · 实际 ${act}h（填报 ${o.reportedActualHours || 0}h + 推算 ${o.inferredActualHours || 0}h）</title></rect>
      <text x="${padL + barW + 6}" y="${y + 17}" font-size="10" fill="${over ? '#b91c1c' : 'var(--m)'}">${Math.round(est)}h / ${Math.round(act)}h</text>
    </g>`;
  }).join('');

  return `<div class="chart-block">
    <div class="chart-inline-legend"><span><i class="chart-dot" style="background:#cbd5e1"></i>预估工时</span><span><i class="chart-dot" style="background:#2458cf"></i>实际工时</span><span><i class="chart-dot" style="background:#dc2626"></i>超出预估 15%+</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="chart-wide-svg" role="img" aria-label="预估与实际工时对比柱状图">${rows}</svg>
  </div>`;
}
