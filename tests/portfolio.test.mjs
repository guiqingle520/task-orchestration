import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProject, validPortfolioDate } from '../server/portfolio.mjs';
import { buildPortfolioMarkdown, makePortfolioView } from '../web/portfolio.js';

const today = '2026-11-19';
const task = (id, milestone, end, extra = {}) => ({
  id, milestone, title: '任务明细', owner: '负责人', start: end, end, status: 'todo', progress: 0, deps: [], ...extra,
});
const project = { id: 'default', name: '项目', planPath: 'private-plan-path', repoRoot: 'private-repo-path', channels: ['private-channel'] };
const milestones = [
  { id: 'M0', name: '空阶段', due: '2026-11-10' },
  { id: 'M1', name: '已交付', due: '2026-11-11' },
  { id: 'M2', name: '已过期但未交付', due: '2026-11-18' },
  { id: 'M3', name: '未来交付', due: '2026-12-05' },
];
const completed = task('T-1', 'M1', '2026-11-11', { status: 'done', progress: 100, actualEnd: '2026-11-11' });

test('read-only project summary picks the earliest unfinished nonempty milestone, even after its deadline', () => {
  const tasks = [completed, task('T-2', 'M2', '2026-11-18', { status: 'blocked' }), task('T-3', 'M3', '2026-12-05')];
  const read = data => summarizeProject(project, today, () => ({ data }));
  const summary = read({ project: '项目', milestones, tasks });
  assert.equal(summary.health, 'red');
  assert.equal(summary.blockedCount, 1);
  assert.equal(summary.overdueCount, 1);
  assert.deepEqual(summary.nextMilestone, milestones[2]);
  assert.equal(read({ project: '项目', milestones, tasks: [completed] }).nextMilestone, null);
  assert.doesNotMatch(JSON.stringify(summary), /private-|任务明细|负责人/);
  const missing = summarizeProject(project, today, () => { throw new Error('private-path'); });
  assert.deepEqual(missing, { id: project.id, name: project.name, health: 'unavailable', overall: null, taskCount: 0, overdueCount: null, blockedCount: null, nextMilestone: null });
  assert.equal(read({ project: 'bad', milestones, tasks: [] }).health, 'unavailable');
});

test('portfolio date validation rejects rollover dates and handles leap days', () => {
  assert.equal(validPortfolioDate('2024-02-29'), true);
  assert.equal(validPortfolioDate('2026-02-29'), false);
  assert.equal(validPortfolioDate('2026-13-01'), false);
  assert.equal(validPortfolioDate('2026-1-01'), false);
});

test('portfolio totals, ordering and Markdown share the same view and omit private fields', () => {
  const row = (id, name, health, blockedCount, overdueCount) => ({
    id, name, health, blockedCount, overdueCount, overall: 54.6, nextMilestone: null,
    owner: 'private-owner', tasks: ['private-task'], planPath: 'private-path', commits: ['private-commit'],
  });
  const projects = [
    row('green', '正常项目', 'green', 0, 0),
    row('late', '逾期项目', 'red', 0, 3),
    row('no', '不可用 | <项目>', 'unavailable', 99, 99),
    { ...row('blocked', '阻塞项目', 'red', 2, 1), nextMilestone: { id: 'M2', name: '阶段 [A]', due: today } },
  ];
  const view = makePortfolioView({ today, projects });
  assert.deepEqual(view.available.map(({ id }) => id), ['blocked', 'late', 'green']);
  assert.deepEqual([view.total, view.blocked, view.overdue], [4, 2, 4]);
  const report = buildPortfolioMarkdown(view);
  assert.ok(report.includes('统计日：2026-11-19'));
  assert.ok(report.includes('项目：4 个（3 个可用，1 个不可用）'));
  assert.ok(report.includes('阻塞 2 项，逾期 4 项'));
  assert.ok(report.includes('| 阻塞项目 | 告急 | 55% | 2 | 1 | M2 · 阶段 \\[A\\]（2026-11-19） |'));
  assert.ok(report.includes('## 不可用项目\n\n- 不可用 \\| &lt;项目&gt;'));
  assert.doesNotMatch(report, /private-|99/);
});
