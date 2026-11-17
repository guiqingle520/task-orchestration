import { compute, toDay, fromDay } from './metrics.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const RH = 60;
const STATUS = { todo: '未开始', doing: '进行中', done: '已完成', blocked: '阻塞' };

let last = null;      // 最近一次 { data, m }
let selected = null;  // 选中的任务或里程碑 id

$('today').value = todayLocal();
$('today').addEventListener('change', refresh);
$('reset').addEventListener('click', () => { $('today').value = todayLocal(); refresh(); });
$('syncGit')?.addEventListener('click', async () => {
  try {
    const r = await (await fetch('/api/sync-git', { method: 'POST' })).json();
    $('updated').textContent = r.ok
      ? (r.touched.length ? `已同步: ${r.touched.join(', ')}` : 'Git 无新变更')
      : `同步失败: ${r.message}`;
    await refresh();
  } catch {
    $('updated').textContent = '同步请求失败';
  }
});

// 点击联动:风险项 / 甘特行 / 条带 / 里程碑 都带 data-id,再次点击取消选中
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-id]');
  if (!el) return;
  selected = selected === el.dataset.id ? null : el.dataset.id;
  renderAll(true);
});

async function refresh() {
  let res;
  try { res = await (await fetch('/api/plan')).json(); }
  catch { $('updated').textContent = '无法连接服务'; return showErrors(['无法连接服务']); }
  showErrors(res.errors);
  if (!res.data || !res.data.tasks) return;
  last = { data: res.data, commits: res.commits || {}, m: compute(res.data, $('today').value || todayLocal()) };
  $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
  renderAll(false);
}

function renderAll(scroll) {
  if (!last) return;
  const { data, m } = last;
  if (selected && !data.tasks.some((t) => t.id === selected) && !m.milestones.some((x) => x.id === selected)) selected = null;
  $('project').textContent = data.project;
  renderKpis(data, m);
  renderGantt(data, m);
  renderDetail(data, m);
  renderRisks(m);
  renderMilestones(m);
  renderLoad(m);
  if (scroll && selected) document.querySelector('.lrow.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showErrors(errs) {
  const el = $('errors');
  el.hidden = !errs || errs.length === 0;
  el.innerHTML = el.hidden ? '' : `<b>plan.md 校验问题(请让智能体修复):</b><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
}

function renderKpis(data, m) {
  const s = m.summary, nm = s.nextMilestone;
  const label = { green: '正常', yellow: '有风险', red: '告急' }[s.health];
  $('pill').className = 'pill ' + s.health;
  $('pill').textContent = label;
  const diff = Math.round(s.overall - s.expectedAll);
  const dcls = diff < -20 ? 'red' : diff < -5 ? 'yellow' : 'green';
  const kpi = (v, l, cls = '') => `<div class="kpi"><div class="v ${cls}">${v}</div><div class="l">${l}</div></div>`;
  $('kpis').innerHTML =
    `<div class="kpi main"><div class="v">${Math.round(s.overall)}% <span class="dev ${dcls}">${diff >= 0 ? '+' : ''}${diff}% vs 计划</span></div>
      <div class="track"><i style="width:${s.overall}%"></i><b style="left:${s.expectedAll}%" title="计划应达 ${Math.round(s.expectedAll)}%"></b></div>
      <div class="l">实际进度 · 黑线为计划应达 ${Math.round(s.expectedAll)}%</div></div>` +
    kpi(nm ? `${nm.daysLeft} 天` : '—', nm ? `距里程碑「${esc(nm.name)}」` : '无未到期里程碑') +
    kpi(s.overdueCount, '逾期任务', s.overdueCount ? 'red' : '') +
    kpi(s.blockedCount, '阻塞任务', s.blockedCount ? 'red' : '') +
    kpi(`${data.tasks.filter((t) => t.status === 'done').length}/${data.tasks.length}`, '已完成任务');
}

function renderGantt(data, m) {
  const tasks = data.tasks, I = m.info;
  const days = [...tasks.flatMap((t) => [I[t.id].s, I[t.id].e + 1, I[t.id].forecastEnd + 1]), toDay(m.today), ...m.milestones.map((x) => toDay(x.due) + 1)];
  const min = Math.min(...days) - 1, max = Math.max(...days) + 1, n = max - min;
  const pct = (d) => ((d - min) / n) * 100;
  const H = tasks.length * RH;
  const row = new Map(tasks.map((t, i) => [t.id, i]));

  let ticks = '', grid = '';
  const want = Math.ceil(n / 9);
  const step = want <= 1 ? 1 : want === 2 ? 2 : want <= 4 ? 3 : 7;
  for (let d = min; d <= max; d++) {
    const wk = new Date(d * 86400000).getUTCDay();
    const tick = step === 7 ? wk === 1 : (d - min) % step === 0;
    if (tick && pct(d) < 93) { ticks += `<span style="left:${pct(d)}%">${fromDay(d).slice(5)}</span>`; grid += `<div class="gl" style="left:${pct(d)}%"></div>`; }
  }

  const left = tasks.map((t) => {
    const i = I[t.id];
    return `<div class="lrow ${selected === t.id ? 'sel' : ''}" data-id="${esc(t.id)}" title="${esc(t.title)}">
      <div class="t"><span class="id ${i.critical ? 'crit' : ''}">${i.critical ? '★' : ''}${esc(t.id)}</span><span class="title">${esc(t.title)}</span></div>
      <div class="s"><span>${esc(t.owner)}</span><span class="pbar"><i style="width:${t.progress}%"></i></span><span>${t.progress}%</span></div></div>`;
  }).join('');

  let bands = '', bars = '';
  tasks.forEach((t, k) => {
    const i = I[t.id], sel = selected === t.id ? 'sel' : '';
    bands += `<div class="band ${sel}" data-id="${esc(t.id)}" style="top:${k * RH}px;height:${RH}px"></div>`;
    bars += `<div class="bar plan ${sel}" style="left:${pct(i.s)}%;width:${(i.dur / n) * 100}%;top:${k * RH + 10}px" title="计划 ${t.start} ~ ${t.end}"></div>`;
    if (t.actualStart) {
      const as = toDay(t.actualStart), ae = t.actualEnd ? toDay(t.actualEnd) : Math.max(as, toDay(m.today));
      bars += `<div class="bar act ${i.health}" style="left:${pct(as)}%;width:${((ae - as + 1) / n) * 100}%;top:${k * RH + 26}px" title="实际 ${t.actualStart} ~ ${t.actualEnd || '进行中'},进度 ${t.progress}%"><i style="width:${t.progress}%"></i></div>`;
    }
    if (i.slip > 0 && t.status !== 'done')
      bars += `<div class="bar slip" style="left:${pct(i.e + 1)}%;width:${(i.slip / n) * 100}%;top:${k * RH + 10}px" title="预计延期 ${i.slip} 天"></div>`;
  });

  let paths = '';
  for (const t of tasks) for (const d of t.deps) {
    if (!row.has(d)) continue;
    const a = I[d], b = I[t.id];
    const x1 = pct(a.e + 1), y1 = row.get(d) * RH + 15, x2 = pct(b.s), y2 = row.get(t.id) * RH + 15;
    const cls = [a.critical && b.critical ? 'crit' : '', selected === t.id || selected === d ? 'hl' : ''].join(' ');
    paths += `<path class="${cls}" d="M${x1} ${y1} C${x1 + 1.5} ${y1},${x2 - 1.5} ${y2},${x2} ${y2}"/>`;
  }

  const msl = m.milestones.map((x) => `<div class="msline ${selected === x.id ? 'sel' : ''}" style="left:${pct(toDay(x.due) + 1)}%"><em>◆ ${esc(x.name)}</em></div>`).join('');
  const today = `<div class="todayline" style="left:${pct(toDay(m.today))}%"><em>今天</em></div>`;

  $('gantt').innerHTML = `<div class="gwrap"><div><div class="lhead">任务 / 负责人 / 进度</div>${left}</div>
    <div><div class="thead">${ticks}</div><div class="tl" style="height:${H}px">${grid}${bands}${bars}
    <svg class="deps" viewBox="0 0 100 ${H}" preserveAspectRatio="none">${paths}</svg>${msl}${today}</div></div></div>`;
}

function renderDetail(data, m) {
  const el = $('detail');
  const t = data.tasks.find((x) => x.id === selected);
  if (t) {
    const i = m.info[t.id];
    const cmts = (last.commits?.[t.id] || []).slice(-3).map((c) => `<code>${esc(c.hash)}</code> ${esc(c.subject)}(${esc(c.date)})`).join(' · ');
    el.innerHTML = `<b>${esc(t.id)} ${esc(t.title)}</b> · ${STATUS[t.status]} · 负责人 ${esc(t.owner)}<br>
      计划 ${t.start} ~ ${t.end}(应达 ${Math.round(i.expected)}%),实际 ${t.actualStart || '—'} ~ ${t.actualEnd || '—'}(完成 ${t.progress}%)<br>
      依赖:${t.deps.length ? t.deps.join(', ') : '无'}${i.slip > 0 && t.status !== 'done' ? ` · <span class="red">预计延期 ${i.slip} 天(预计 ${fromDay(i.forecastEnd)} 完成)</span>` : ''}${i.critical ? ' · <span class="red">关键路径</span>' : ''}${cmts ? `<br>关联提交:${cmts}` : ''}`;
    return;
  }
  const ms = m.milestones.find((x) => x.id === selected);
  el.innerHTML = ms
    ? `<b>◆ ${esc(ms.name)}</b> · 目标 ${ms.due} · 预计 ${ms.forecast} 完成 · 包含 ${ms.taskCount} 个任务`
    : '<span>提示:点击右侧风险项、左侧任务行或里程碑,可在时间线中高亮并查看详情。</span>';
}

function renderRisks(m) {
  $('risks').innerHTML = m.risks.length
    ? m.risks.map((r) => `<li class="${r.level} ${selected === r.id ? 'sel' : ''}" data-id="${esc(r.id)}"><b>${esc(r.id)}</b>${esc(r.text)}</li>`).join('')
    : '<li class="empty" style="cursor:default;border-color:var(--g)">暂无风险 🎉</li>';
}

function renderMilestones(m) {
  $('milestones').innerHTML = m.milestones.map((x) => `<div class="ms ${selected === x.id ? 'sel' : ''}" data-id="${esc(x.id)}">
    <div><b>${esc(x.name)}</b> <span class="empty">${x.due}(${x.daysLeft >= 0 ? `还剩 ${x.daysLeft} 天` : `已过 ${-x.daysLeft} 天`})</span></div>
    <div class="bar2"><i style="width:${Math.round(x.progress)}%"></i></div>
    <div class="${x.slipDays > 0 ? 'red' : 'green'}">${x.slipDays > 0 ? `预计 ${x.forecast} 完成,延期 ${x.slipDays} 天` : '按期可完成'} · 进度 ${Math.round(x.progress)}%</div></div>`).join('');
}

function renderLoad(m) {
  const owners = Object.keys(m.load);
  if (!owners.length) { $('load').innerHTML = '<span class="empty">没有未完成任务</span>'; return; }
  const head = m.weeks.map((w) => `<th>${fromDay(w).slice(5)}</th>`).join('');
  const rows = owners.map((o) => `<tr><th>${esc(o)}</th>${m.weeks.map((w) => {
    const c = m.load[o][w] || 0;
    return `<td class="${c >= 3 ? 'l3' : c === 2 ? 'l2' : c ? 'l1' : ''}">${c || ''}</td>`;
  }).join('')}</tr>`).join('');
  $('load').innerHTML = `<div class="loadw"><table class="load"><tr><th>周起</th>${head}</tr>${rows}</table></div><div class="empty" style="font-size:12px;margin-top:6px">≥3 个并行任务标红(资源冲突)</div>`;
}

refresh();
setInterval(refresh, 5000);
