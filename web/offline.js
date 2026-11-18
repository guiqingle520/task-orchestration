// 此函数随导出文件内联；只使用快照、同文件中的日期和燃尽图函数，以及浏览器 DOM。
export function startOfflineDashboard({ plan, today, metrics, commits = {} }) {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const percent = (value) => Math.round(value) + '%';
  const states = { todo: '未开始', doing: '进行中', done: '已完成', blocked: '阻塞' };
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const collapse = new Set();
  const ranges = plan.tasks.flatMap(({ start, end, actualStart, actualEnd }) => [
    toDay(start), toDay(end) + 1, actualStart ? toDay(actualStart) : toDay(start), actualEnd ? toDay(actualEnd) + 1 : toDay(today) + 1,
  ]);
  const min = Math.min(toDay(today), ...ranges);
  const max = Math.max(toDay(today) + 1, ...ranges);
  const days = max - min;
  const pos = (day) => (day - min) / days * 100;
  let scale = 'fit', selected = '';

  const summary = metrics.summary;
  $('offlineKpis').innerHTML = [
    ['总体进度', percent(summary.overall)], ['计划进度', percent(summary.expectedAll)],
    ['已完成', plan.tasks.filter(({ status }) => status === 'done').length + '/' + plan.tasks.length],
    ['逾期任务', summary.overdueCount], ['阻塞任务', summary.blockedCount],
  ].map(([label, value]) => `<article class="kpi"><div class="v">${esc(value)}</div><div class="l">${label}</div></article>`).join('');

  $('offlineMilestones').innerHTML = metrics.milestones.map((milestone) =>
    `<div class="offline-milestone"><b>${esc(milestone.name)}</b><progress max="100" value="${milestone.progress}"></progress><div>交付 ${esc(milestone.due)} · ${percent(milestone.progress)}${milestone.taskCount ? ' · 预计 ' + esc(milestone.forecast) : ''}</div></div>`).join('');
  $('offlineRisks').innerHTML = metrics.risks.map(({ id, text, level }) =>
    `<li class="${level === 'red' ? 'red' : 'yellow'}"><b>${esc(id)}</b> ${esc(text)}</li>`).join('') || '<li>暂无风险</li>';
  $('offlineLoad').innerHTML = metrics.weeks.length
    ? `<table class="load"><thead><tr><th>负责人</th>${metrics.weeks.map((day) => `<th>${esc(fromDay(day).slice(5))}</th>`).join('')}</tr></thead>
       <tbody>${Object.entries(metrics.load).map(([owner, row]) => `<tr><th>${esc(owner)}</th>${metrics.weeks.map((day) => {
         const value = row[day] || 0;
         return `<td class="${value > 2 ? 'red' : value === 2 ? 'yellow' : ''}">${value}</td>`;
       }).join('')}</tr>`).join('')}</tbody></table>` : '<p class="empty">暂无未完成任务</p>';

  function showTask(id) {
    const task = tasks.get(id);
    if (!task) return;
    selected = id;
    $('offlineGantt').querySelectorAll('[data-offline-task]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.offlineTask === id)));
    const links = commits[id]?.length ? `<p>关联提交</p><ul>${commits[id].map(({ hash, date, subject }) =>
      `<li>${esc(date)} · ${esc(hash)} · ${esc(subject)}</li>`).join('')}</ul>` : '';
    $('offlineDetail').innerHTML = `<b>${esc(id)} · ${esc(task.title)}</b><div>负责人：${esc(task.owner)} · ${esc(states[task.status])} ${percent(task.progress)}</div>
      <div>计划：${esc(task.start)} ～ ${esc(task.end)} · 实际：${esc(task.actualStart || '未开始')} ～ ${esc(task.actualEnd || '未结束')}</div>
      <div>前置任务：${esc(task.deps.join('、') || '无')}</div>${links}`;
  }

  function renderGantt() {
    const box = $('offlineGantt'), previousScroll = box.scrollLeft;
    const px = { day: 34, week: 13, month: 4 }[scale];
    const stride = scale === 'day' ? 1 : scale === 'week' ? 7 : Math.max(1, Math.ceil(days / 7));
    const ticks = [];
    for (let day = min; day < max; day++) {
      const date = fromDay(day);
      if (scale === 'month' ? date.endsWith('-01') || day === min : (day - min) % stride === 0) {
        ticks.push(`<span style="left:${pos(day)}%">${esc(scale === 'month' ? date.slice(0, 7) : date.slice(5))}</span>`);
      }
    }
    const row = (task) => {
      const item = metrics.info[task.id], active = task.id === selected;
      const a = task.actualStart ? toDay(task.actualStart) : null;
      const b = a == null ? null : task.actualEnd ? toDay(task.actualEnd) : Math.max(toDay(today), a);
      const range = esc(task.start + ' ～ ' + task.end);
      return `<div class="offline-row"><button type="button" class="offline-task-name" data-offline-task="${esc(task.id)}" aria-pressed="${active}">${esc(task.id)} · ${esc(task.title)}</button>
        <div class="offline-track"><i class="offline-today" style="left:${pos(toDay(today))}%" title="统计日期"></i>
        <button type="button" tabindex="-1" class="offline-plan-bar" data-offline-task="${esc(task.id)}" aria-pressed="${active}" title="${range}" style="left:${pos(item.s)}%;width:${item.dur / days * 100}%"></button>
        ${a == null || b < a ? '' : `<span class="offline-actual" style="left:${pos(a)}%;width:${(b - a + 1) / days * 100}%"><i style="width:${task.progress}%"></i></span>`}</div></div>`;
    };
    box.innerHTML = `<div class="offline-timeline" style="width:${px ? 'calc(var(--offline-label) + ' + (days * px) + 'px)' : '100%'}">
      <div class="offline-row offline-axis"><b>任务</b><div class="offline-track">${ticks.join('')}</div></div>
      ${plan.milestones.map((group) => `<details data-offline-group="${esc(group.id)}"${collapse.has(group.id) ? '' : ' open'}>
      <summary>${esc(group.name)}</summary>${plan.tasks.filter(({ milestone }) => milestone === group.id).map(row).join('') || '<p class="empty">暂无任务</p>'}</details>`).join('')}</div>`;
    box.scrollLeft = previousScroll;
    $('offlineControls').querySelectorAll('[data-scale]').forEach((button) => {
      const active = button.dataset.scale === scale;
      button.classList.toggle('on', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  $('offlineGantt').addEventListener('click', (event) => showTask(event.target.closest('[data-offline-task]')?.dataset.offlineTask));
  $('offlineGantt').addEventListener('toggle', (event) => {
    const group = event.target;
    if (!group.matches('[data-offline-group]') || !group.isConnected) return;
    if (group.open) collapse.delete(group.dataset.offlineGroup); else collapse.add(group.dataset.offlineGroup);
  }, true);
  $('offlineControls').addEventListener('click', (event) => {
    const { scale: next, groups } = event.target.dataset;
    if (next) { scale = next; renderGantt(); }
    if (groups) for (const group of $('offlineGantt').querySelectorAll('[data-offline-group]')) {
      group.open = groups === 'expand';
      if (group.open) collapse.delete(group.dataset.offlineGroup); else collapse.add(group.dataset.offlineGroup);
    }
  });

  const scope = $('offlineScope');
  scope.innerHTML = '<option value="">全部里程碑</option>' + plan.milestones.map(({ name }, index) => `<option value="${index}">${esc(name)}</option>`).join('');
  function renderBurn() {
    const group = scope.value === '' ? null : plan.milestones[Number(scope.value)];
    const scopePlan = group ? { milestones: [group], tasks: plan.tasks.filter(({ milestone }) => milestone === group.id) } : plan;
    const burn = computeBurndown(scopePlan, today);
    $('offlineBurnSummary').textContent = burn.series.length
      ? `剩余 ${burn.remainingScope.toFixed(1)} 天当量 · 7 日速率 ${burn.velocity} · 预计 ${burn.forecastEnd || '暂无'}` : '暂无里程碑任务';
    const series = burn.series;
    const maxScope = Math.max(1, burn.totalScope);
    const points = (key) => series.flatMap((sample, index) => sample[key] == null ? [] :
      [`${16 + 288 * index / Math.max(1, series.length - 1)},${104 - 88 * sample[key] / maxScope}`]).join(' ');
    $('offlineBurn').innerHTML = series.length ? `<svg viewBox="0 0 320 120" role="img" aria-label="计划与实际剩余工期">
      <path d="M16 12V104H304" fill="none" stroke="#cbd5e1"/>
      <polyline points="${points('ideal')}" fill="none" stroke="#64748b" stroke-dasharray="4 3"/>
      <polyline points="${points('actual')}" fill="none" stroke="#2563eb" stroke-width="2"/></svg>
      <p class="empty">灰色虚线：计划 · 蓝色实线：实际</p>` : '';
  }
  scope.addEventListener('change', renderBurn);
  renderGantt();
  renderBurn();
}
