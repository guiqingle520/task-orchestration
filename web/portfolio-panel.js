import { buildPortfolioMarkdown, formatNextMilestone, formatProjectProgress, makePortfolioView, PROJECT_HEALTH_LABELS } from './portfolio.js';

export function installPortfolio({ esc, syncProjects }) {
  const $ = id => document.getElementById(id);
  let view = null, sequence = 0, copySequence = 0, markup = null;
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
    const card = p => `<li class="portfolio-project">
      <div class="portfolio-project-title"><h3>${esc(p.name)}</h3>${statusChip(p)}</div>
      <dl class="portfolio-project-stats">
        ${summary('总体进度', formatProjectProgress(p.overall))}
        ${summary('阻塞任务', p.blockedCount)}
        ${summary('逾期任务', p.overdueCount)}
      </dl>
      <p class="portfolio-next"><span>下个里程碑</span><strong>${esc(formatNextMilestone(p.nextMilestone))}</strong></p>
      <div class="portfolio-actions">
        <a class="portfolio-open" href="${href(p.id, 'overview')}" aria-label="打开${esc(p.name)}项目">打开项目</a>
        <a href="${href(p.id, 'deliveries')}" aria-label="查看${esc(p.name)}的里程碑">查看里程碑</a>
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
    <div class="portfolio-list-head"><h2>不可用项目（${unavailable.length}）</h2><p>不计入风险合计</p></div>
    ${unavailable.length ? `<ul class="portfolio-unavailable">${unavailable.map(p => `<li><strong>${esc(p.name)}</strong>${statusChip(p)}</li>`).join('')}</ul>`
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
