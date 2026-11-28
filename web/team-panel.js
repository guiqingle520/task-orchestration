import { defaultClaimTtl, inferActorKind } from './claims.js';

const LOAD_LABELS = {
  collision: '撞车预警',
  multi: '多项目并行',
  normal: '正常',
  idle: '空闲',
};

export function installTeamPanel({ esc, onTeamSaved } = {}) {
  const $ = (id) => document.getElementById(id);
  let view = null;
  let lastMarkup = null;
  let sequence = 0;
  let preset = 'all';
  let groupFilter = '';
  let search = '';
  let expandedCollisionId = null;
  const expandedStandup = new Set();
  let standupInitialized = false;
  let standupMode = (() => {
    try { return localStorage.getItem('team.standupMode') === 'list' ? 'list' : 'matrix'; } catch { return 'matrix'; }
  })();
  let configDraft = [];
  let configBusy = false;

  const status = (msg) => {
    if ($('teamStatus')) $('teamStatus').textContent = msg;
  };

  function syncFilterUi() {
    document.querySelectorAll('#teamPresetFilters [data-team-preset]')?.forEach?.((btn) => {
      const on = btn.dataset?.teamPreset === preset;
      btn.classList?.toggle?.('on', on);
      btn.setAttribute?.('aria-pressed', String(on));
    });
    const groupSelect = $('teamGroupFilter');
    if (groupSelect && view) {
      const prev = groupFilter;
      const options = [['', '全部分组'], ...(view.groups || []).map((g) => [g, g])];
      const html = options.map(([val, label]) => `<option value="${esc(val)}">${esc(label)}</option>`).join('');
      if (groupSelect.innerHTML !== html) groupSelect.innerHTML = html;
      groupSelect.value = view.groups?.includes(prev) ? prev : '';
      groupFilter = groupSelect.value;
    }
  }

  function filteredMembers() {
    if (!view) return [];
    const q = search.trim().toLowerCase();
    return (view.members || []).filter((m) => {
      if (preset === 'human' && m.kind !== 'human') return false;
      if (preset === 'agent' && m.kind !== 'agent') return false;
      if (preset === 'risk' && m.loadState !== 'collision' && m.blockedCount === 0) return false;
      if (groupFilter && m.group !== groupFilter) return false;
      if (q) {
        const hay = [
          m.id, m.label, m.group, ...(m.aliases || []),
          ...m.standup.doing.map((t) => `${t.id} ${t.title} ${t.projectName}`),
          ...m.standup.blocked.map((t) => `${t.id} ${t.title} ${t.projectName}`),
          ...m.standup.recentDone.map((t) => `${t.id} ${t.title} ${t.projectName}`),
          ...m.standup.ready.map((t) => `${t.id} ${t.title} ${t.projectName}`),
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderTaskLinks(items, tagFn) {
    return `<ul class="team-task-list">${items.map((item) => {
      const href = `?project=${encodeURIComponent(item.projectId)}&amp;task=${encodeURIComponent(item.id)}#timeline`;
      const claimTag = item.claim
        ? `<span class="claim-chip ${item.claim.state === 'stale' ? 'stale' : 'active'}">${item.claim.state === 'stale' ? '超时' : '持锁'} ${esc(item.claim.actor)}${item.claim.remainingMinutes != null ? ` ${item.claim.remainingMinutes}m` : ''}</span>`
        : '';
      return `<li class="team-task-row">
        <a class="team-task-link" href="${href}"><span class="portfolio-proj-badge">${esc(item.projectName)}</span><span class="team-task-title">${esc(item.id)} · ${esc(item.title)}</span></a>
        <div class="team-task-meta">${tagFn(item)}${claimTag}<span class="team-task-due">${esc(item.end.slice(5))}</span></div>
      </li>`;
    }).join('')}</ul>`;
  }

  function render() {
    if (!view || !$('teamBody')) return;
    syncFilterUi();
    const members = filteredMembers();
    const s = view.summary;

    const summaryHtml = `<dl class="portfolio-summary">
      <div><dt>团队成员</dt><dd>${s.memberCount}</dd></div>
      <div><dt>跨项目撞车</dt><dd>${s.collisionCount}</dd></div>
      <div><dt>多项目并行</dt><dd>${s.multiProjectCount}</dd></div>
      <div><dt>在岗 AI</dt><dd>${s.activeAgentCount}</dd></div>
      <div><dt>进行中 / 阻塞</dt><dd>${s.totalDoing} / ${s.totalBlocked}</dd></div>
    </dl>`;

    const weekHeaders = (view.weeks || []).map((w) => `<th>${esc(w.label)}</th>`).join('');
    const loadRows = members.map((m) => {
      const kindBadge = `<span class="roster-kind ${m.kind}">${m.kind === 'agent' ? 'AI' : '人类'}</span>`;
      const groupBadge = m.group ? `<span class="team-group-tag">${esc(m.group)}</span>` : '';
      const cells = (m.weekly || []).map((w) => {
        const cls = w.overloaded ? 'collision' : w.multiProject ? 'multi' : w.peak > 0 ? 'normal' : 'idle';
        return `<td><span class="team-heat-cell ${cls}" title="最大日并行 ${w.peak} 项">${w.peak || '—'}</span></td>`;
      }).join('');
      const hasConflicts = m.collisions?.length > 0;
      const isExpanded = expandedCollisionId === m.id;
      const detailBtn = hasConflicts
        ? `<button type="button" class="btn-sm" data-team-collision="${esc(m.id)}" aria-expanded="${isExpanded}">${isExpanded ? '收起明细' : `查看撞车 (${m.collisions.length}天)`}</button>`
        : '<span class="empty">无冲突</span>';
      const conflictRow = isExpanded && hasConflicts
        ? `<tr class="team-collision-row"><td colspan="${5 + (view.weeks?.length || 4)}">
            <div class="team-collision-panel">
              <strong>${esc(m.label)} 跨项目排期撞车明细（每日上限 ${m.dailyLimit} 项）</strong>
              <ul>${m.collisions.map((c) => `<li><b>${esc(c.date)}</b>：并行 ${c.count} 项（跨 ${c.projectCount} 个项目）${c.overloaded ? ' · <span class="team-over-tag">超上限</span>' : ''} — ${c.tasks.map((t) => `<a href="?project=${encodeURIComponent(t.projectId)}&amp;task=${encodeURIComponent(t.id)}#timeline">[${esc(t.projectName)}] ${esc(t.id)} ${esc(t.title)}</a>`).join('；')}</li>`).join('')}</ul>
            </div>
          </td></tr>`
        : '';
      return `<tr>
        <td><div class="team-member-cell"><strong>${esc(m.label)}</strong>${kindBadge}${groupBadge}</div></td>
        <td>${m.projectCount} 个项目</td>
        <td>${m.dailyLimit} 项/天</td>
        ${cells}
        <td><span class="team-state-badge ${m.loadState}">${LOAD_LABELS[m.loadState]}</span></td>
        <td>${detailBtn}</td>
      </tr>${conflictRow}`;
    }).join('');

    const loadTable = `<section class="team-section">
      <div class="portfolio-list-head"><h2>跨项目个人负载与撞车预警</h2><p>统计日 ${esc(view.today)} · 按天叠加所有可用项目并行任务</p></div>
      ${members.length ? `<div class="team-table-wrap"><table class="team-load-table">
        <thead><tr><th>成员</th><th>覆盖项目</th><th>每日上限</th>${weekHeaders}<th>状态</th><th>冲突明细</th></tr></thead>
        <tbody>${loadRows}</tbody>
      </table></div>` : '<p class="empty">没有符合筛选条件的成员。</p>'}
    </section>`;

    if (!standupInitialized && view.members?.length) {
      standupInitialized = true;
      expandedStandup.clear();
      const focus = view.members.find((m) => m.loadState === 'collision' || m.blockedCount > 0) || view.members[0];
      if (focus) expandedStandup.add(focus.id);
    }

    const standupCards = members.map((m) => {
      const kindBadge = `<span class="roster-kind ${m.kind}">${m.kind === 'agent' ? 'AI' : '人类'}</span>`;
      const groupBadge = m.group ? `<span class="team-group-tag">${esc(m.group)}</span>` : '';
      const isOpen = expandedStandup.has(m.id);
      const countPills = [
        m.doingCount ? `<span class="team-count-pill doing">进行中 ${m.doingCount}</span>` : '',
        m.blockedCount ? `<span class="team-count-pill blocked">阻塞 ${m.blockedCount}</span>` : '',
        m.recentDoneCount ? `<span class="team-count-pill done">近期完成 ${m.recentDoneCount}</span>` : '',
        m.readyCount ? `<span class="team-count-pill ready">可开工 ${m.readyCount}</span>` : '',
      ].filter(Boolean).join('') || '<span class="empty">暂无待办</span>';

      const groups = [
        m.standup.blocked.length ? `<div class="team-standup-group"><h4>阻塞卡点（${m.standup.blocked.length}）</h4>${renderTaskLinks(m.standup.blocked, (item) => `<span class="status-chip red">阻塞 ${item.progress}%</span>`)}</div>` : '',
        m.standup.doing.length ? `<div class="team-standup-group"><h4>进行中 / 持锁执行（${m.standup.doing.length}）</h4>${renderTaskLinks(m.standup.doing, (item) => item.claimedPending ? '<span class="status-chip claimed-pending">已认领·待更新进度</span>' : `<span class="status-chip doing">${item.progress}%</span>`)}</div>` : '',
        m.standup.recentDone.length ? `<div class="team-standup-group"><h4>近 2 天已完成（${m.standup.recentDone.length}）</h4>${renderTaskLinks(m.standup.recentDone, (item) => `<span class="status-chip green">完成 ${(item.actualEnd || item.end).slice(5)}</span>`)}</div>` : '',
        m.standup.ready.length ? `<div class="team-standup-group"><h4>待认领 / 可开工（${m.standup.ready.length}）</h4>${renderTaskLinks(m.standup.ready, (item) => `<span class="status-chip ${item.availability === 'now' ? 'green' : 'blue'}">${item.availability === 'now' ? '现在可开工' : '可提前开始'}</span>`)}</div>` : '',
      ].filter(Boolean);

      const bodyHtml = isOpen
        ? `<div class="team-standup-body">${groups.length ? `<div class="team-standup-sections">${groups.join('')}</div>` : '<p class="empty">当前无活跃、阻塞、近期完成或可开工任务。</p>'}</div>`
        : '';

      return `<article class="team-member-card state-${esc(m.loadState)} ${isOpen ? 'open' : 'collapsed'}">
        <button type="button" class="team-card-toggle" data-team-standup="${esc(m.id)}" aria-expanded="${isOpen}">
          <span class="team-card-identity">
            <strong>${esc(m.label)}</strong>${kindBadge}${groupBadge}<span class="team-state-badge ${m.loadState}">${LOAD_LABELS[m.loadState]}</span>
          </span>
          <span class="team-card-summary">
            ${countPills}
            <span class="team-chevron" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
          </span>
        </button>
        ${bodyHtml}
      </article>`;
    }).join('');

    const renderMatrixCell = (items, emptyCls, tagFn) => {
      if (!items.length) return '<span class="team-matrix-empty">—</span>';
      return `<ul class="team-matrix-items">${items.map((item) => {
        const href = `?project=${encodeURIComponent(item.projectId)}&amp;task=${encodeURIComponent(item.id)}#timeline`;
        const claimTag = item.claim
          ? `<span class="claim-chip ${item.claim.state === 'stale' ? 'stale' : 'active'}">${esc(item.claim.actor)}${item.claim.remainingMinutes != null ? ` ${item.claim.remainingMinutes}m` : ''}</span>`
          : '';
        return `<li class="team-matrix-item ${emptyCls || ''}">
          <a href="${href}"><span class="portfolio-proj-badge">${esc(item.projectName)}</span> ${esc(item.id)} · ${esc(item.title)}</a>
          <div class="team-matrix-tags">${tagFn(item)}${claimTag}</div>
        </li>`;
      }).join('')}</ul>`;
    };

    const standupMatrix = `<div class="team-table-wrap"><table class="team-matrix-table">
      <thead><tr><th>成员</th><th>阻塞卡点</th><th>进行中 / 持锁执行</th><th>近 2 天已完成</th><th>待认领 / 可开工</th></tr></thead>
      <tbody>${members.map((m) => {
        const kindBadge = `<span class="roster-kind ${m.kind}">${m.kind === 'agent' ? 'AI' : '人类'}</span>`;
        const groupBadge = m.group ? `<span class="team-group-tag">${esc(m.group)}</span>` : '';
        return `<tr class="state-${esc(m.loadState)}">
          <td class="team-matrix-member">
            <strong>${esc(m.label)}</strong>
            <div class="team-card-badges">${kindBadge}${groupBadge}<span class="team-state-badge ${m.loadState}">${LOAD_LABELS[m.loadState]}</span></div>
          </td>
          <td>${renderMatrixCell(m.standup.blocked, 'is-blocked', (item) => `<span class="status-chip red">阻塞 ${item.progress}%</span>`)}</td>
          <td>${renderMatrixCell(m.standup.doing, '', (item) => item.claimedPending ? '<span class="status-chip claimed-pending">已认领·待更新进度</span>' : `<span class="status-chip doing">${item.progress}%</span>`)}</td>
          <td>${renderMatrixCell(m.standup.recentDone, '', (item) => `<span class="status-chip green">${esc((item.actualEnd || item.end).slice(5))}</span>`)}</td>
          <td>${renderMatrixCell(m.standup.ready, '', (item) => `<span class="status-chip ${item.availability === 'now' ? 'green' : 'blue'}">${item.availability === 'now' ? '可开工' : '可提前'}</span>`)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;

    const allOpen = members.length > 0 && members.every((m) => expandedStandup.has(m.id));
    const modeSwitch = `<div class="seg" role="group" aria-label="站会展示模式">
      <button type="button" data-standup-mode="matrix" class="${standupMode === 'matrix' ? 'on' : ''}" aria-pressed="${standupMode === 'matrix'}">矩阵视图</button>
      <button type="button" data-standup-mode="list" class="${standupMode === 'list' ? 'on' : ''}" aria-pressed="${standupMode === 'list'}">列表视图</button>
    </div>`;
    const expandAllBtn = standupMode === 'list' && members.length
      ? `<button type="button" class="btn-sm" data-team-standup-all="${allOpen ? 'collapse' : 'expand'}">${allOpen ? '全部收起' : '全部展开'}</button>`
      : '';
    const standupContent = !members.length
      ? '<p class="empty">暂无符合条件的团队成员。</p>'
      : standupMode === 'matrix'
        ? standupMatrix
        : `<div class="team-standup-list">${standupCards}</div>`;

    const standupSection = `<section class="team-section">
      <div class="portfolio-list-head">
        <div><h2>每日站会按人视图</h2><p>${standupMode === 'matrix' ? '成员 × 状态矩阵，横向扫视阻塞、进展、近期完成与可接手任务' : '默认展开重点关注成员，点击成员行展开或收起明细'}</p></div>
        <div class="snapshot-controls">${modeSwitch}${expandAllBtn}</div>
      </div>
      ${standupContent}
    </section>`;

    const nextHtml = summaryHtml + loadTable + standupSection;
    if (nextHtml !== lastMarkup) {
      lastMarkup = nextHtml;
      $('teamBody').innerHTML = nextHtml;
    }
  }

  async function refresh(today) {
    const request = ++sequence;
    if (!view || view.today !== today) status('正在聚合跨项目团队负载…');
    try {
      const response = await fetch(`/api/team/overview?today=${encodeURIComponent(today)}`);
      const data = await response.json().catch(() => null);
      if (request !== sequence) return;
      if (!response.ok || !data || !Array.isArray(data.members)) {
        throw new Error(data?.message || '无法读取团队负载数据');
      }
      view = data;
      render();
      status('');
    } catch (err) {
      if (request !== sequence) return;
      status(err.message || '跨项目团队负载加载失败');
    }
  }

  function renderConfigDraft() {
    const listEl = $('teamConfigList');
    if (!listEl) return;
    if (!configDraft.length) {
      listEl.innerHTML = '<div class="empty">尚未配置全局团队成员。可点击下方「+ 新增成员」或「+ 从现有项目导入未配置成员」。</div>';
      return;
    }
    listEl.innerHTML = configDraft.map((item, idx) => `
      <div class="webhook-item" data-team-idx="${idx}">
        <div class="webhook-row team-config-row">
          <input type="text" data-team-field="id" value="${esc(item.id)}" placeholder="唯一标识，如 linxiao、codex#1" required maxlength="80">
          <input type="text" data-team-field="label" value="${esc(item.label || item.id)}" placeholder="显示名称，如 林晓" maxlength="120">
          <input type="text" data-team-field="group" value="${esc(item.group || '')}" placeholder="小组，如 前端、AI军团" maxlength="60">
          <select data-team-field="kind">
            <option value="human" ${item.kind === 'human' ? 'selected' : ''}>人类</option>
            <option value="agent" ${item.kind === 'agent' ? 'selected' : ''}>AI 智能体</option>
          </select>
          <input type="number" data-team-field="dailyLimit" value="${esc(item.dailyLimit ?? (item.kind === 'agent' ? 1 : 2))}" min="1" max="20" title="每日并行上限" style="width:70px">
          <input type="number" data-team-field="defaultTtlMinutes" value="${esc(item.defaultTtlMinutes ?? defaultClaimTtl(item.kind))}" min="5" max="${item.kind === 'agent' ? 240 : 1440}" title="默认租约(分钟)" style="width:82px">
          <button type="button" data-team-remove="${idx}">移除</button>
        </div>
        <div class="webhook-row">
          <input type="text" data-team-field="aliases" value="${esc((item.aliases || []).join(', '))}" placeholder="跨项目别名（逗号分隔，如 林晓, linxiao）">
        </div>
      </div>
    `).join('');
  }

  function syncConfigDraftFromDom() {
    document.querySelectorAll('#teamConfigList [data-team-idx]')?.forEach?.((row) => {
      const idx = Number(row.dataset.teamIdx);
      const entry = configDraft[idx];
      if (!entry) return;
      const val = (f) => row.querySelector(`[data-team-field="${f}"]`)?.value ?? '';
      entry.id = val('id').trim();
      entry.label = val('label').trim() || entry.id;
      entry.group = val('group').trim();
      entry.kind = val('kind') === 'agent' ? 'agent' : 'human';
      entry.dailyLimit = Number(val('dailyLimit')) || (entry.kind === 'agent' ? 1 : 2);
      entry.defaultTtlMinutes = Number(val('defaultTtlMinutes')) || defaultClaimTtl(entry.kind);
      entry.aliases = val('aliases').split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
    });
  }

  async function openConfigDialog() {
    if ($('teamConfigStatus')) $('teamConfigStatus').textContent = '正在加载全局团队配置…';
    $('teamConfigDialog')?.showModal?.();
    try {
      const res = await fetch('/api/team');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || '读取团队配置失败');
      configDraft = (data.members || []).map((m) => ({ ...m, aliases: [...(m.aliases || [])] }));
      renderConfigDraft();
      if ($('teamConfigStatus')) $('teamConfigStatus').textContent = '';
    } catch (err) {
      if ($('teamConfigStatus')) $('teamConfigStatus').textContent = err.message || '读取团队配置失败';
    }
  }

  $('teamRefresh')?.addEventListener('click', () => {
    if (view?.today) void refresh(view.today);
  });
  $('teamPresetFilters')?.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-team-preset]');
    if (!btn) return;
    preset = btn.dataset.teamPreset;
    render();
  });
  $('teamGroupFilter')?.addEventListener('change', () => {
    groupFilter = $('teamGroupFilter').value;
    render();
  });
  $('teamSearch')?.addEventListener('input', () => {
    search = $('teamSearch').value;
    render();
  });
  $('teamBody')?.addEventListener('click', (e) => {
    const colBtn = e.target?.closest?.('[data-team-collision]');
    if (colBtn) {
      const id = colBtn.dataset.teamCollision;
      expandedCollisionId = expandedCollisionId === id ? null : id;
      render();
      return;
    }
    const standupBtn = e.target?.closest?.('[data-team-standup]');
    if (standupBtn) {
      const id = standupBtn.dataset.teamStandup;
      if (expandedStandup.has(id)) expandedStandup.delete(id);
      else expandedStandup.add(id);
      render();
      return;
    }
    const allBtn = e.target?.closest?.('[data-team-standup-all]');
    if (allBtn) {
      if (allBtn.dataset.teamStandupAll === 'expand') {
        for (const m of filteredMembers()) expandedStandup.add(m.id);
      } else {
        expandedStandup.clear();
      }
      render();
      return;
    }
    const modeBtn = e.target?.closest?.('[data-standup-mode]');
    if (modeBtn) {
      const nextMode = modeBtn.dataset.standupMode;
      if (nextMode === 'matrix' || nextMode === 'list') {
        standupMode = nextMode;
        try { localStorage.setItem('team.standupMode', nextMode); } catch { /* ignore */ }
        render();
      }
    }
  });

  $('configTeamBtn')?.addEventListener('click', () => { void openConfigDialog(); });
  $('closeTeamConfig')?.addEventListener('click', () => $('teamConfigDialog')?.close?.());
  $('addTeamMemberBtn')?.addEventListener('click', () => {
    syncConfigDraftFromDom();
    configDraft.push({
      id: `member-${configDraft.length + 1}`,
      label: `成员 ${configDraft.length + 1}`,
      group: '',
      kind: 'human',
      dailyLimit: 2,
      defaultTtlMinutes: 480,
      aliases: [],
    });
    renderConfigDraft();
  });
  $('syncTeamFromProjectsBtn')?.addEventListener('click', () => {
    syncConfigDraftFromDom();
    const existing = new Set(configDraft.map((m) => m.id.toLowerCase()));
    for (const m of view?.members || []) {
      if (existing.has(m.id.toLowerCase())) continue;
      existing.add(m.id.toLowerCase());
      configDraft.push({
        id: m.id,
        label: m.label || m.id,
        group: m.group || '',
        kind: m.kind || inferActorKind(m.id),
        dailyLimit: m.dailyLimit || (m.kind === 'agent' ? 1 : 2),
        defaultTtlMinutes: m.defaultTtlMinutes || defaultClaimTtl(m.kind || 'human'),
        aliases: [...(m.aliases || [])],
      });
    }
    renderConfigDraft();
  });
  $('teamConfigList')?.addEventListener('change', (e) => {
    if (e.target?.dataset?.teamField === 'kind') {
      const row = e.target.closest?.('[data-team-idx]');
      const kind = e.target.value;
      const limitEl = row?.querySelector?.('[data-team-field="dailyLimit"]');
      const ttlEl = row?.querySelector?.('[data-team-field="defaultTtlMinutes"]');
      if (limitEl) limitEl.value = kind === 'agent' ? 1 : 2;
      if (ttlEl) {
        ttlEl.max = kind === 'agent' ? 240 : 1440;
        ttlEl.value = defaultClaimTtl(kind);
      }
    }
  });
  $('teamConfigList')?.addEventListener('click', (e) => {
    const rm = e.target?.closest?.('[data-team-remove]');
    if (!rm) return;
    syncConfigDraftFromDom();
    configDraft.splice(Number(rm.dataset.teamRemove), 1);
    renderConfigDraft();
  });
  $('teamConfigForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (configBusy) return;
    syncConfigDraftFromDom();
    configBusy = true;
    if ($('saveTeamConfigBtn')) $('saveTeamConfigBtn').disabled = true;
    if ($('teamConfigStatus')) $('teamConfigStatus').textContent = '正在保存团队配置…';
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ members: configDraft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || '保存团队配置失败');
      $('teamConfigDialog')?.close?.();
      await onTeamSaved?.(data);
      if (view?.today) await refresh(view.today);
    } catch (err) {
      if ($('teamConfigStatus')) $('teamConfigStatus').textContent = err.message || '保存团队配置失败';
    } finally {
      configBusy = false;
      if ($('saveTeamConfigBtn')) $('saveTeamConfigBtn').disabled = false;
    }
  });

  return {
    refresh,
    cancel() { sequence++; },
  };
}
