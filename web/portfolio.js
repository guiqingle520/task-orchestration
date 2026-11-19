export const PROJECT_HEALTH_LABELS = Object.freeze({ green: '正常', yellow: '有风险', red: '告急', unavailable: '不可用' });

const healthRank = { red: 0, yellow: 1, green: 2 };
const riskCount = project => project.blockedCount + project.overdueCount;
const compareName = (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.id.localeCompare(b.id);
export const formatProjectProgress = progress => `${Math.round(progress)}%`;
export const formatNextMilestone = milestone => milestone ? `${milestone.id} · ${milestone.name}（${milestone.due}）` : '无待交付里程碑';

export function makePortfolioView({ today, projects }) {
  const available = projects.filter(project => project.health !== 'unavailable').sort((a, b) =>
    Number(riskCount(b) > 0) - Number(riskCount(a) > 0)
    || b.blockedCount - a.blockedCount || b.overdueCount - a.overdueCount
    || healthRank[a.health] - healthRank[b.health] || compareName(a, b));
  const unavailable = projects.filter(project => project.health === 'unavailable').sort(compareName);
  return {
    today, available, unavailable, total: projects.length,
    blocked: available.reduce((total, project) => total + project.blockedCount, 0),
    overdue: available.reduce((total, project) => total + project.overdueCount, 0),
  };
}

function markdownText(value) {
  return value.replace(/\s+/gu, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\|\x60*_{}\[\]~]/g, token => '\\' + token);
}

export function buildPortfolioMarkdown(view) {
  const { today, available, unavailable, total, blocked, overdue } = view;
  const lines = [
    '# 跨项目进度摘要', '',
    `统计日：${today}`,
    `项目：${total} 个（${available.length} 个可用，${unavailable.length} 个不可用）`,
    `可用项目合计：阻塞 ${blocked} 项，逾期 ${overdue} 项`,
  ];
  if (available.length) {
    lines.push('', '| 项目 | 状态 | 进度 | 阻塞 | 逾期 | 下个里程碑 |', '|---|---|---:|---:|---:|---|');
    for (const p of available) {
      lines.push(`| ${markdownText(p.name)} | ${PROJECT_HEALTH_LABELS[p.health]} | ${formatProjectProgress(p.overall)} | ${p.blockedCount} | ${p.overdueCount} | ${markdownText(formatNextMilestone(p.nextMilestone))} |`);
    }
  } else lines.push('', '暂无可统计的项目。');
  lines.push('', '## 不可用项目', '');
  if (unavailable.length) lines.push(...unavailable.map(p => `- ${markdownText(p.name)}`));
  else lines.push('无');
  return lines.join('\n') + '\n';
}
