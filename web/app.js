import { compute, simulateDelays, toDay, fromDay } from './metrics.js';
import { analyzeLoad, buildReport, buildReportSvg, comparePlans } from './analysis.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const RH = 60;
const STATUS = { todo: '未开始', doing: '进行中', done: '已完成', blocked: '阻塞' };

let last = null;      // 最近一次 { data, m }
let selected = null;  // 选中的任务或里程碑 id
let refreshSequence = 0;
let editingTask = null;
function downloadReport(content, type, extension) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = `progress-${last.m.today}.${extension}`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('exportMarkdown').addEventListener('click', () => {
  if (last) downloadReport(buildReport(last.data, last.m, last.m.today).markdown, 'text/markdown;charset=utf-8', 'md');
});
$('exportSvg').addEventListener('click', () => {
  if (last) downloadReport(buildReportSvg(last.data, last.m, last.m.today), 'image/svg+xml;charset=utf-8', 'svg');
});
$('copySummary').addEventListener('click', async () => {
  if (!last) return;
  try { await navigator.clipboard.writeText(buildReport(last.data, last.m, last.m.today).summary); $('reportMessage').textContent = '摘要已复制'; }
  catch { $('reportMessage').textContent = '无法访问剪贴板，请检查浏览器权限'; }
});
const snapshotKey = () => `task-orchestration.snapshots.${last.data.project}`;
function readSnapshots() {
  try { const saved = JSON.parse(localStorage.getItem(snapshotKey()) || '[]'); return Array.isArray(saved) ? saved : []; } catch { return []; }
}
function updateSnapshots() {
  const selectedSnapshot = $('snapshots').value;
  const snapshots = readSnapshots();
  $('snapshots').innerHTML = snapshots.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.label)}</option>`).join('');
  if (snapshots.some((entry) => entry.id === selectedSnapshot)) $('snapshots').value = selectedSnapshot;
}
$('saveSnapshot').addEventListener('click', () => {
  if (!last) return;
  try {
    const entries = readSnapshots();
    entries.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label: new Date().toLocaleString(), plan: structuredClone(last.data) });
    localStorage.setItem(snapshotKey(), JSON.stringify(entries));
    updateSnapshots(); $('snapshots').value = entries.at(-1).id;
    $('snapshotResult').textContent = '快照已保存';
  } catch { $('snapshotResult').textContent = '无法保存快照，请检查浏览器存储空间和权限'; }
});
$('compareSnapshot').addEventListener('click', () => {
  if (!last) return;
  const snapshot = readSnapshots().find((entry) => entry.id === $('snapshots').value);
  if (!snapshot) { $('snapshotResult').textContent = '请先保存或选择快照'; return; }
  const changes = comparePlans(snapshot.plan, last.data);
  $('snapshotResult').innerHTML = changes.length ? `<b>${changes.length} 个任务有变化</b><ul>${changes.map((change) => `<li>${esc(change.id)} ${esc(change.title)}：${change.type === 'added' ? '新增' : change.type === 'removed' ? '移除' : change.differences.map((item) => `${esc(item.field)} ${esc(item.before ?? '—')} → ${esc(item.after ?? '—')}`).join('；')}</li>`).join('')}</ul>` : '与当前计划无差异';
});
let simulation = false, delays = {}, simulationResult = null;
$('simEnabled').addEventListener('change', () => { simulation = $('simEnabled').checked; renderAll(false); });
$('simApply').addEventListener('click', () => {
  const days = Number($('simDays').value), id = $('simTask').value;
  if (!id || !Number.isInteger(days) || days < 0 || days > 3650) { $('simResult').textContent = '请输入 0 至 3650 的整数天数'; return; }
  simulation = $('simEnabled').checked = true;
  if (days) delays[id] = days; else delete delays[id];
  renderAll(false);
});
$('simReset').addEventListener('click', () => { delays = {}; $('simDays').value = 0; renderAll(false); });
$('simTask').addEventListener('change', () => { $('simDays').value = delays[$('simTask').value] || 0; });

document.addEventListener('pointerdown', (event) => {
  const bar = event.target.closest('[data-sim-drag]');
  if (!bar || event.button !== 0) return;
  event.preventDefault();
  const id = bar.dataset.simDrag, startX = event.clientX;
  const pxPerDay = bar.closest('.tl').getBoundingClientRect().width / Number(bar.dataset.days);
  const original = delays[id] || 0;
  const finish = (up) => {
    document.removeEventListener('pointerup', finish);
    const days = Math.max(0, Math.min(3650, original + Math.round((up.clientX - startX) / pxPerDay)));
    if (days) delays[id] = days; else delete delays[id];
    $('simTask').value = id; $('simDays').value = days;
    renderAll(false);
  };
  document.addEventListener('pointerup', finish, { once: true });
});

$('closeTask').addEventListener('click', () => $('taskDialog').close());
$('taskStatus').addEventListener('change', () => {
  if ($('taskStatus').value === 'done') $('taskProgress').value = 100;
  if ($('taskStatus').value === 'todo') $('taskProgress').value = 0;
});
$('validatePlan').addEventListener('click', async () => {
  try {
    const result = await (await fetch('/api/plan')).json();
    $('taskMessage').textContent = result.errors?.length ? result.errors.join('；') : '计划校验通过';
  } catch { $('taskMessage').textContent = '无法连接服务'; }
});
$('taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingTask) return;
  const expected = Object.fromEntries(['status', 'progress', 'actualStart', 'actualEnd'].map((key) => [key, editingTask[key]]));
  try {
    const response = await fetch('/api/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: editingTask.id, expected, status: $('taskStatus').value, progress: Number($('taskProgress').value) }) });
    const result = await response.json();
    if (!response.ok) { $('taskMessage').textContent = result.message; return; }
    $('taskDialog').close();
    await refresh();
  } catch { $('taskMessage').textContent = '保存失败，无法连接服务'; }
});

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
  if (e.target.closest('[data-edit-task]')) {
    const task = last?.data.tasks.find((item) => item.id === selected);
    if (!task) return;
    editingTask = { ...task };
    $('taskTitle').textContent = `${task.id} ${task.title}`;
    $('taskMeta').textContent = `负责人 ${task.owner} · 计划 ${task.start} ~ ${task.end} · 依赖 ${task.deps.join('、') || '无'}`;
    $('taskStatus').value = task.status;
    $('taskProgress').value = task.progress;
    $('taskMessage').textContent = '';
    $('taskDialog').showModal();
    return;
  }
  const sc = e.target.closest('[data-scale]');
  if (sc) { scale = sc.dataset.scale; store.set('gantt.scale', scale); scrollToTodayNext = true; return renderAll(false); }
  const ac = e.target.closest('[data-act]');
  if (ac && last) {
    const ids = last.data.milestones.map((x) => x.id);
    if (ac.dataset.act === 'today') scrollToTodayNext = true;
    if (ac.dataset.act === 'expand') collapsed.clear();
    if (ac.dataset.act === 'collapse') collapsed = new Set(ids);
    saveCollapsed();
    return renderAll(false);
  }
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    const id = tg.dataset.toggle;
    collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
    saveCollapsed();
    return renderAll(false);
  }
  const el = e.target.closest('[data-id]');
  if (!el) return;
  selected = selected === el.dataset.id ? null : el.dataset.id;
  // 选中的任务所在里程碑被折叠时自动展开
  const t = last?.data.tasks.find((x) => x.id === selected);
  if (t && collapsed.has(t.milestone)) { collapsed.delete(t.milestone); saveCollapsed(); }
  renderAll(true);
});

async function refresh() {
  const sequence = ++refreshSequence;
  let res;
  try { res = await (await fetch('/api/plan')).json(); }
  catch {
    if (sequence === refreshSequence) { $('updated').textContent = '无法连接服务'; showErrors(['无法连接服务']); }
    return;
  }
  if (sequence !== refreshSequence) return;
  showErrors(res.errors);
  if (!res.data || !res.data.tasks) return;
  last = { data: res.data, commits: res.commits || {}, m: compute(res.data, $('today').value || todayLocal()) };
  $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
  renderAll(false);
}

function renderAll(scroll) {
  if (!last) return;
  const { data, m } = last;
  updateSnapshots();
  const previousTask = $('simTask').value;
  $('simTask').innerHTML = data.tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.id)} ${esc(t.title)}</option>`).join('');
  if (data.tasks.some((t) => t.id === previousTask)) $('simTask').value = previousTask;
  for (const id of Object.keys(delays)) if (!data.tasks.some((task) => task.id === id)) delete delays[id];
  simulationResult = simulation ? simulateDelays(data, delays) : null;
  if (simulationResult) {
    const affected = Object.entries(simulationResult.tasks).filter(([, task]) => task.delayDays > 0);
    const milestones = simulationResult.milestones.filter((item) => item.delayDays > 0);
    $('simResult').textContent = `推演影响 ${affected.length} 个任务${affected.length ? '：' + affected.map(([id, item]) => `${id} +${item.delayDays} 天`).join('、') : ''}；${milestones.length ? '里程碑：' + milestones.map((item) => `${item.id} +${item.delayDays} 天`).join('、') : '里程碑无变化'}。关键任务：${simulationResult.criticalTaskIds.join('、') || '无'}。不写入计划。`;
  } else $('simResult').textContent = '';
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

const GH = 34; // 里程碑分组行高
const SCALES = { fit: '适应', day: '日', week: '周', month: '月' };
const PX = { day: 36, week: 14, month: 4 }; // 各缩放档位每天的像素宽度
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } },
};
let scale = store.get('gantt.scale', 'fit');
if (!SCALES[scale]) scale = 'fit';
let collapsed = new Set(store.get('gantt.collapsed', []));
let scrollToTodayNext = false;
const saveCollapsed = () => store.set('gantt.collapsed', [...collapsed]);

function renderCtrl() {
  $('gctrl').innerHTML =
    `<div class="seg">${Object.entries(SCALES).map(([k, v]) => `<button data-scale="${k}" class="${scale === k ? 'on' : ''}">${v}</button>`).join('')}</div>` +
    `<button data-act="today">回到今天</button><button data-act="expand">全部展开</button><button data-act="collapse">全部折叠</button>`;
}

function renderGantt(data, m) {
  renderCtrl();
  const I = m.info;
  const days = [...data.tasks.flatMap((t) => [I[t.id].s, I[t.id].e + 1, I[t.id].forecastEnd + 1, ...(simulationResult ? [toDay(simulationResult.tasks[t.id].end) + 1] : [])]), toDay(m.today), ...m.milestones.map((x) => toDay(x.due) + 1)];
  const min = Math.min(...days) - 1, max = Math.max(...days) + 1, n = max - min;
  const pct = (d) => ((d - min) / n) * 100;
  const fit = scale === 'fit';
  const innerW = fit ? null : n * PX[scale];

  // 行布局:里程碑分组行 + (未折叠时)任务行
  const groups = m.milestones.map((ms) => ({ ms, tasks: data.tasks.filter((t) => t.milestone === ms.id) }));
  const rows = [];
  let y = 0;
  for (const g of groups) {
    const isC = collapsed.has(g.ms.id);
    rows.push({ type: 'g', g, y, h: GH, isC });
    y += GH;
    if (!isC) for (const t of g.tasks) { rows.push({ type: 't', t, y, h: RH }); y += RH; }
  }
  const H = y;
  const trow = new Map(rows.filter((r) => r.type === 't').map((r) => [r.t.id, r]));

  // 刻度与网格
  let ticks = '', grid = '';
  const tick = (d, label) => { ticks += `<span style="left:${pct(d)}%">${label}</span>`; grid += `<div class="gl" style="left:${pct(d)}%"></div>`; };
  const dow = (d) => new Date(d * 86400000).getUTCDay();
  if (scale === 'day') {
    for (let d = min; d <= max; d++) {
      const dd = fromDay(d);
      tick(d, d === min || dd.endsWith('-01') ? dd.slice(5) : dd.slice(8));
      if (dow(d) === 0 || dow(d) === 6) grid += `<div class="we" style="left:${pct(d)}%;width:${100 / n}%"></div>`;
    }
  } else if (scale === 'week') {
    for (let d = min; d <= max; d++) {
      if (dow(d) === 1) tick(d, fromDay(d).slice(5));
      if (dow(d) === 0 || dow(d) === 6) grid += `<div class="we" style="left:${pct(d)}%;width:${100 / n}%"></div>`;
    }
  } else if (scale === 'month') {
    for (let d = min; d <= max; d++) {
      const dd = fromDay(d);
      if (dd.endsWith('-01')) tick(d, dd.slice(0, 7));
      else if (dow(d) === 1) grid += `<div class="gl weak" style="left:${pct(d)}%"></div>`;
    }
  } else {
    const want = Math.ceil(n / 9);
    const step = want <= 1 ? 1 : want === 2 ? 2 : want <= 4 ? 3 : 7;
    for (let d = min; d <= max; d++) {
      const t = step === 7 ? dow(d) === 1 : (d - min) % step === 0;
      if (t && pct(d) < 93) tick(d, fromDay(d).slice(5));
    }
  }

  // 左侧列表
  const left = rows.map((r) => {
    if (r.type === 'g') {
      const ms = r.g.ms;
      return `<div class="lgroup" data-toggle="${esc(ms.id)}" title="点击${r.isC ? '展开' : '折叠'}">
        <span class="car">${r.isC ? '▸' : '▾'}</span><b>${esc(ms.name)}</b>
        <span class="gmeta">${r.g.tasks.length} 个任务 · ${Math.round(ms.progress)}%${ms.slipDays > 0 ? ` · <span class="red">延期 ${ms.slipDays} 天</span>` : ''}</span></div>`;
    }
    const t = r.t, i = I[t.id];
    return `<div class="lrow ${selected === t.id ? 'sel' : ''}" data-id="${esc(t.id)}" title="${esc(t.title)}">
      <div class="t"><span class="id ${i.critical ? 'crit' : ''}">${i.critical ? '★' : ''}${esc(t.id)}</span><span class="title">${esc(t.title)}</span></div>
      <div class="s"><span>${esc(t.owner)}</span><span class="pbar"><i style="width:${t.progress}%"></i></span><span>${t.progress}%</span></div></div>`;
  }).join('');

  // 时间线:条带与柱
  let bands = '', bars = '';
  for (const r of rows) {
    if (r.type === 'g') {
      const g = r.g, ms = g.ms;
      bands += `<div class="gband" data-toggle="${esc(ms.id)}" style="top:${r.y}px;height:${GH}px"></div>`;
      if (g.tasks.length) {
        const s = Math.min(...g.tasks.map((t) => I[t.id].s));
        const e = Math.max(...g.tasks.map((t) => I[t.id].e)) + 1;
        const fe = Math.max(...g.tasks.map((t) => I[t.id].forecastEnd)) + 1;
        const cls = ms.slipDays > 0 ? 'red' : 'green';
        bars += `<div class="bar gsum ${cls}" style="left:${pct(s)}%;width:${((e - s) / n) * 100}%;top:${r.y + 12}px" title="${esc(ms.name)} ${fromDay(s)} ~ ${fromDay(e - 1)},进度 ${Math.round(ms.progress)}%"><i style="width:${Math.round(ms.progress)}%"></i></div>`;
        if (fe > e) bars += `<div class="bar slip" style="left:${pct(e)}%;width:${((fe - e) / n) * 100}%;top:${r.y + 12}px" title="预计延期 ${fe - e} 天"></div>`;
      }
      continue;
    }
    const t = r.t, i = I[t.id], sel = selected === t.id ? 'sel' : '';
    bands += `<div class="band ${sel}" data-id="${esc(t.id)}" style="top:${r.y}px;height:${RH}px"></div>`;
    bars += `<div class="bar plan ${sel}" style="left:${pct(i.s)}%;width:${(i.dur / n) * 100}%;top:${r.y + 10}px" title="计划 ${t.start} ~ ${t.end}"></div>`;
    if (t.actualStart) {
      const as = toDay(t.actualStart), ae = t.actualEnd ? toDay(t.actualEnd) : Math.max(as, toDay(m.today));
      bars += `<div class="bar act ${i.health}" style="left:${pct(as)}%;width:${((ae - as + 1) / n) * 100}%;top:${r.y + 26}px" title="实际 ${t.actualStart} ~ ${t.actualEnd || '进行中'},进度 ${t.progress}%"><i style="width:${t.progress}%"></i></div>`;
    }
    if (i.slip > 0 && t.status !== 'done')
      bars += `<div class="bar slip" style="left:${pct(i.e + 1)}%;width:${(i.slip / n) * 100}%;top:${r.y + 10}px" title="预计延期 ${i.slip} 天"></div>`;
    if (simulationResult) {
      const sim = simulationResult.tasks[t.id], ss = toDay(sim.start), se = toDay(sim.end);
      bars += `<div class="bar simulation ${sim.critical ? 'critical' : ''}" data-sim-drag="${esc(t.id)}" data-days="${n}" style="left:${pct(ss)}%;width:${((se - ss + 1) / n) * 100}%;top:${r.y + 43}px" title="拖动模拟延期：${sim.start} ~ ${sim.end}，延期 ${sim.delayDays} 天"></div>`;
    }
  }

  // 依赖线(两端任务都可见时才画)
  let paths = '';
  for (const t of data.tasks) for (const d of t.deps) {
    const ra = trow.get(d), rb = trow.get(t.id);
    if (!ra || !rb) continue;
    const a = I[d], b = I[t.id];
    const x1 = pct(a.e + 1), y1 = ra.y + 15, x2 = pct(b.s), y2 = rb.y + 15;
    const cls = [a.critical && b.critical ? 'crit' : '', selected === t.id || selected === d ? 'hl' : ''].join(' ');
    paths += `<path class="${cls}" d="M${x1} ${y1} C${x1 + 1.5} ${y1},${x2 - 1.5} ${y2},${x2} ${y2}"/>`;
  }

  const msl = m.milestones.map((x) => `<div class="msline ${selected === x.id ? 'sel' : ''}" style="left:${pct(toDay(x.due) + 1)}%"><em>◆ ${esc(x.name)}</em></div>`).join('');
  const today = `<div class="todayline" style="left:${pct(toDay(m.today))}%"><em>今天</em></div>`;

  const prevScroll = $('tscroll')?.scrollLeft || 0;
  $('gantt').innerHTML = `<div class="gwrap"><div><div class="lhead">里程碑 / 任务 / 进度</div>${left}</div>
    <div class="tscroll" id="tscroll"><div class="tinner" style="${fit ? 'width:100%' : `width:${innerW}px;min-width:100%`}">
    <div class="thead">${ticks}</div><div class="tl" style="height:${H}px">${grid}${bands}${bars}
    <svg class="deps" viewBox="0 0 100 ${H}" preserveAspectRatio="none">${paths}</svg>${msl}${today}</div></div></div></div>`;

  const sc = $('tscroll');
  if (scrollToTodayNext && !fit) {
    sc.scrollLeft = Math.max(0, (pct(toDay(m.today)) / 100) * innerW - sc.clientWidth / 2);
  } else {
    sc.scrollLeft = prevScroll;
  }
  scrollToTodayNext = false;
}

function renderDetail(data, m) {
  const el = $('detail');
  const t = data.tasks.find((x) => x.id === selected);
  if (t) {
    const i = m.info[t.id];
    const cmts = (last.commits?.[t.id] || []).slice(-3).map((c) => `<code>${esc(c.hash)}</code> ${esc(c.subject)}(${esc(c.date)})`).join(' · ');
    el.innerHTML = `<b>${esc(t.id)} ${esc(t.title)}</b> · ${STATUS[t.status]} · 负责人 ${esc(t.owner)}<br>
      计划 ${t.start} ~ ${t.end}(应达 ${Math.round(i.expected)}%),实际 ${t.actualStart || '—'} ~ ${t.actualEnd || '—'}(完成 ${t.progress}%)<br>
      依赖:${t.deps.length ? t.deps.join(', ') : '无'}${i.slip > 0 && t.status !== 'done' ? ` · <span class="red">预计延期 ${i.slip} 天(预计 ${fromDay(i.forecastEnd)} 完成)</span>` : ''}${i.critical ? ' · <span class="red">关键路径</span>' : ''}${cmts ? `<br>关联提交:${cmts}` : ''}<br><button type="button" data-edit-task>编辑任务</button>`;
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
  const analysis = analyzeLoad(last.data);
  const owners = Object.keys(analysis.load);
  if (!owners.length) { $('load').innerHTML = '<span class="empty">没有未完成任务</span>'; return; }
  const head = analysis.weeks.map((w) => `<th>${fromDay(w).slice(5)}</th>`).join('');
  const rows = owners.map((o) => `<tr><th>${esc(o)}</th>${analysis.weeks.map((w) => {
    const c = analysis.load[o][w] || 0;
    return `<td class="${c >= 3 ? 'l3' : c === 2 ? 'l2' : c ? 'l1' : ''}">${c || ''}</td>`;
  }).join('')}</tr>`).join('');
  const suggestions = analysis.suggestions.map((s) => `<li>${esc(s.owner)}：${s.conflictDay} 出现冲突，可试将 ${esc(s.id)} 顺延至 ${s.start} ~ ${s.end}；需复核下游依赖和交付日期。</li>`).join('');
  $('load').innerHTML = `<div class="loadw"><table class="load"><tr><th>周起</th>${head}</tr>${rows}</table></div><div class="empty" style="font-size:12px;margin-top:6px">每周展示每日并行任务峰值；≥3 标红。</div>${suggestions ? `<ul class="load-suggestions">${suggestions}</ul>` : '<div class="empty">暂无资源冲突建议</div>'}`;
}

refresh();
if (typeof EventSource !== 'undefined') {
  const events = new EventSource('/api/events');
  events.addEventListener('plan-change', refresh);
}
// 监听不可用时仍可恢复更新。
setInterval(refresh, 5000);
