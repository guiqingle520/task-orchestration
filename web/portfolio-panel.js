import { buildPortfolioMarkdown, formatNextMilestone, formatProjectProgress, makePortfolioView, PROJECT_HEALTH_LABELS } from './portfolio.js';

export function installPortfolio({ esc, syncProjects, onProjectsChanged }) {
  const $ = id => document.getElementById(id);
  let view = null, defaultId = 'default', sequence = 0, copySequence = 0, markup = null;
  const status = message => { $('portfolioStatus').textContent = message; };
  const writeBody = html => {
    if (markup === html) return;
    $('portfolioBody').innerHTML = html;
    markup = html;
  };
  const statusChip = project => `<span class="portfolio-status"><i aria-hidden="true" class="picker-health-dot ${esc(project.health)}"></i>${PROJECT_HEALTH_LABELS[project.health]}</span>`;

  function render(snapshot) {
    const { today, total, available, unavailable, blocked, overdue } = snapshot;
    const href = (id, anchor) => `?project=${encodeURIComponent(id)}&amp;today=${encodeURIComponent(today)}#${anchor}`;
    const summary = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const manageBtns = (p, removeLabel = '移除') => {
      const def = p.id === defaultId
        ? '<span class="portfolio-default-tag">默认</span>'
        : p.health !== 'unavailable'
          ? `<button type="button" class="btn-sm" data-project-default="${esc(p.id)}">设为默认</button>`
          : '';
      const rm = total > 1
        ? `<button type="button" class="btn-sm portfolio-remove" data-project-remove="${esc(p.id)}" data-project-name="${esc(p.name)}">${removeLabel}</button>`
        : '';
      return def + rm;
    };
    const renderActionList = (items, emptyText, tagBuilder) => items.length
      ? `<ul class="portfolio-action-list">${items.map((item) => {
          const hrefLink = `?project=${encodeURIComponent(item.projectId)}&amp;task=${encodeURIComponent(item.id)}#timeline`;
          const actorLabel = item.claim
            ? `${item.claim.state === 'stale' ? '租约超时' : '执行中'}：${item.claim.actor}`
            : `负责人：${item.owner}`;
          return `<li class="portfolio-action-item">
            <a href="${hrefLink}"><span class="portfolio-proj-badge">${esc(item.projectName)}</span> ${esc(item.id)} · ${esc(item.title)}</a>
            <div class="portfolio-action-sub">${tagBuilder(item)}<span>${esc(actorLabel)}</span><span>截止 ${esc(item.end)}</span></div>
          </li>`;
        }).join('')}</ul>`
      : `<p class="empty">${emptyText}</p>`;
    const actionsBoard = available.length ? (() => {
      const actions = snapshot.todayActions || { blocked: [], doing: [], ready: [] };
      return `<section class="portfolio-actions-board" aria-label="跨项目今日行动">
        <div class="portfolio-list-head"><h2>跨项目今日行动</h2><p>汇总所有可用项目的阻塞、进行中与可开工任务</p></div>
        <div class="portfolio-actions-grid">
          <div class="portfolio-action-group">
            <h3><span>阻塞待处理</span><span class="empty">${actions.blocked.length} 项</span></h3>
            ${renderActionList(actions.blocked, '当前无阻塞任务。', (item) => `<span class="status-chip red">阻塞 ${item.progress}%</span>`)}
          </div>
          <div class="portfolio-action-group">
            <h3><span>进行中</span><span class="empty">${actions.doing.length} 项</span></h3>
            ${renderActionList(actions.doing, '当前无进行中任务。', (item) => item.claimedPending ? '<span class="status-chip claimed-pending">已认领·待更新进度</span>' : `<span class="status-chip doing">进行中 ${item.progress}%</span>`)}
          </div>
          <div class="portfolio-action-group">
            <h3><span>可开工</span><span class="empty">${actions.ready.length} 项</span></h3>
            ${renderActionList(actions.ready, '当前无可开工任务。', (item) => `<span class="status-chip ${item.availability === 'now' ? 'green' : 'blue'}">${item.availability === 'now' ? '现在可开工' : '可提前开始'}</span>`)}
          </div>
        </div>
      </section>`;
    })() : '';
    const card = p => `<li class="portfolio-project">
      <div class="portfolio-project-title"><h3>${esc(p.name)}</h3>${statusChip(p)}</div>
      <dl class="portfolio-project-stats">
        ${summary('总体进度', formatProjectProgress(p.overall))}
        ${summary('阻塞任务', p.blockedCount)}
        ${summary('逾期任务', p.overdueCount)}
      </dl>
      <p class="portfolio-live-meta">进行中 <strong>${p.doingCount ?? 0}</strong> 项 · 在岗 AI <strong>${p.activeAgentCount ?? 0}</strong> 个</p>
      <p class="portfolio-next"><span>下个里程碑</span><strong>${esc(formatNextMilestone(p.nextMilestone))}</strong></p>
      <div class="portfolio-actions">
        <a class="portfolio-open" href="${href(p.id, 'overview')}" aria-label="打开${esc(p.name)}项目">打开项目</a>
        <a href="${href(p.id, 'deliveries')}" aria-label="查看${esc(p.name)}的里程碑">查看里程碑</a>
        ${manageBtns(p)}
      </div>
    </li>`;
    writeBody(`<dl class="portfolio-summary">
      ${summary('已注册项目', total)}
      ${summary('可用项目', available.length)}
      ${summary('阻塞任务', blocked)}
      ${summary('逾期任务', overdue)}
    </dl>
    <div class="portfolio-list-head"><h2>可用项目</h2><p>统计日 ${esc(today)} · 有阻塞或逾期的项目优先</p></div>
    ${available.length ? `<ul class="portfolio-projects">${available.map(card).join('')}</ul>` : '<p class="portfolio-empty">暂无可统计的项目。</p>'}
    ${actionsBoard}
    <div class="portfolio-list-head"><h2>不可用项目（${unavailable.length}）</h2><p>不计入风险合计</p></div>
    ${unavailable.length ? `<ul class="portfolio-unavailable">${unavailable.map(p => `<li><strong>${esc(p.name)}</strong><div class="portfolio-actions">${statusChip(p)}${manageBtns(p, '移除注册')}</div></li>`).join('')}</ul>`
      : '<p class="portfolio-empty">没有不可用项目。</p>'}`);
  }

  function clearCopyStatus() {
    copySequence++;
    $('portfolioCopyStatus').textContent = '';
    $('portfolioMarkdown').hidden = true;
    $('portfolioMarkdown').value = '';
  }

  async function refresh(today) {
    const request = ++sequence;
    if (view?.today !== today) {
      view = null;
      writeBody('');
      clearCopyStatus();
      $('copyPortfolio').disabled = true;
      status('正在读取项目进度…');
    }
    try {
      const response = await fetch(`/api/portfolio?today=${encodeURIComponent(today)}`);
      if (!response.ok) {
        const message = response.status === 404 ? '当前服务不支持跨项目总览，请重启驾驶舱服务后重试。' : '无法读取项目进度，请重试。';
        throw new PortfolioError(message);
      }
      const snapshot = await response.json();
      if (request !== sequence) return;
      if (snapshot.today !== today || !Array.isArray(snapshot.projects)) throw new PortfolioError('未收到有效的项目统计，请重试。');
      const next = makePortfolioView(snapshot);
      if (JSON.stringify(next) !== JSON.stringify(view)) clearCopyStatus();
      view = next;
      defaultId = snapshot.default || 'default';
      syncProjects(snapshot);
      render(view);
      $('copyPortfolio').disabled = false;
      status('');
    } catch (err) {
      if (request !== sequence) return;
      const message = err instanceof TypeError ? '无法连接服务，请重试。' : '跨项目总览加载失败。';
      status((err.message && err instanceof PortfolioError ? err.message : message) + (view ? ' 当前显示的是上次成功读取的结果。' : ''));
    }
  }

  $('portfolioBody')?.addEventListener('click', async (event) => {
    const defBtn = event.target.closest?.('[data-project-default]');
    if (defBtn && view) {
      try {
        const response = await fetch('/api/projects/default', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: defBtn.dataset.projectDefault }),
        });
        const result = await response.json();
        if (!response.ok) throw new PortfolioError(result.message || '无法设为默认项目');
        await onProjectsChanged?.(result, 'default');
        await refresh(view.today);
      } catch (err) { status(err.message || '设为默认项目失败'); }
      return;
    }
    const rmBtn = event.target.closest?.('[data-project-remove]');
    if (rmBtn && view) {
      const id = rmBtn.dataset.projectRemove;
      const name = rmBtn.dataset.projectName || id;
      if (typeof globalThis.confirm === 'function' && !globalThis.confirm(`确认从工作区移除项目「${name}」？（仅移除注册记录，不会删除本地目录与文件）`)) return;
      try {
        const response = await fetch('/api/projects/remove', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const result = await response.json();
        if (!response.ok) throw new PortfolioError(result.message || '移除项目失败');
        await onProjectsChanged?.(result, 'remove');
        await refresh(view.today);
      } catch (err) { status(err.message || '移除项目失败'); }
    }
  });

  $('copyPortfolio').addEventListener('click', async () => {
    if (!view) return;
    const request = ++copySequence;
    const markdown = buildPortfolioMarkdown(view);
    try {
      await navigator.clipboard.writeText(markdown);
      if (request === copySequence) $('portfolioCopyStatus').textContent = 'Markdown 摘要已复制。';
    } catch {
      if (request !== copySequence) return;
      const field = $('portfolioMarkdown');
      field.value = markdown;
      field.hidden = false;
      field.focus();
      field.select();
      $('portfolioCopyStatus').textContent = '无法访问剪贴板，请手动复制选中的摘要。';
    }
  });
  return { refresh, cancel() { sequence++; clearCopyStatus(); } };
}

class PortfolioError extends Error {}
