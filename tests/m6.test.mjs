import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute } from '../web/metrics.js';
import { filterTasks, followUpTasks, matchOptions, milestoneDelay, readTaskLink, taskLinkUrl } from '../web/m6.js';

const task = (id, end, fields = {}) => ({
  id, title: id, owner: 'codex', milestone: 'M1', start: end, end,
  status: 'todo', progress: 0, deps: [], ...fields,
});

test('queries combine exact structured filters with case-insensitive ID or title fragments', () => {
  const tasks = [
    task('T-3', '2026-11-18', { title: 'HTML 离线报告', status: 'blocked' }),
    task('T-30', '2026-11-18', { title: 'HTML 离线网页', owner: 'dev', status: 'blocked' }),
    task('T-31', '2026-11-18', { title: 'HTML 工时', owner: 'dev', milestone: 'M2' }),
  ];
  assert.deepEqual(filterTasks(tasks, { query: '  html ', status: 'blocked', owner: 'dev', milestone: 'M1' }).map(t => t.id), ['T-30']);
  assert.deepEqual(filterTasks(tasks, { status: ['todo', 'blocked'], owner: ['codex', 'dev'], milestone: ['M1'] }).map(t => t.id), ['T-3', 'T-30']);
  assert.deepEqual(filterTasks(tasks, { status: ['doing', 'blocked'] }).map(t => t.id), ['T-3', 'T-30']);
  assert.deepEqual(filterTasks(tasks, { query: '离线', milestone: 'M2' }), []);
  assert.deepEqual(filterTasks(tasks, { query: 'ｔ－３' }).map(t => t.id), ['T-3', 'T-30', 'T-31']);
  assert.deepEqual(filterTasks(tasks), tasks);
});

test('follow-up includes each task once and orders blocked, overdue, today and the seven-day boundary', () => {
  const tasks = [
    task('T-1', '2026-11-26'),
    task('T-2', '2026-11-17'),
    task('T-3', '2026-11-18', { status: 'blocked' }),
    task('T-4', '2026-11-19'),
    task('T-5', '2026-11-27'),
    task('T-6', '2026-11-14', { status: 'done', progress: 100 }),
    task('T-7', '2026-12-15', { status: 'blocked' }),
  ];
  assert.deepEqual(followUpTasks(tasks, '2026-11-19').map(({ task, days, priority }) => [task.id, days, priority]),
    [['T-3', -1, 0], ['T-7', 26, 0], ['T-2', -2, 1], ['T-4', 0, 2], ['T-1', 7, 2]]);
});

test('milestone delay distinguishes overdue, forecast, completed late, and empty with shared weighted progress', () => {
  const milestone = (id, due) => ({ id, name: id, due });
  const data = {
    milestones: [milestone('M1', '2026-11-18'), milestone('M2', '2026-11-20'), milestone('M3', '2026-11-16'), milestone('M4', '2026-11-15'), milestone('M5', '2026-11-19')],
    tasks: [
      task('T-1', '2026-11-18', { start: '2026-11-16', progress: 20, status: 'doing' }),
      task('T-2', '2026-11-18', { progress: 100, status: 'done', actualEnd: '2026-11-18' }),
      task('T-3', '2026-11-21', { milestone: 'M2' }),
      task('T-4', '2026-11-16', { milestone: 'M3', progress: 100, status: 'done', actualEnd: '2026-11-18' }),
      task('T-5', '2026-11-19', { milestone: 'M5' }),
    ],
  };
  const [overdue, forecast, completed, empty, today] = compute(data, '2026-11-19').milestones;
  assert.equal(overdue.progress, 40);
  assert.equal(overdue.doneCount, 1);
  assert.deepEqual(milestoneDelay(overdue), { label: '已延期', days: 1 });
  assert.deepEqual(milestoneDelay(forecast), { label: '预计延期', days: 1 });
  assert.deepEqual(milestoneDelay(completed), { label: '延期完成', days: 2 });
  assert.equal(milestoneDelay(empty), null);
  assert.deepEqual(milestoneDelay(today), { label: '预计延期', days: 1 });
});

test('picker search ranks exact IDs first, preserves selection and handles fragments', () => {
  const options = [
    { value: 'T-30', label: 'T-30 · 离线网页', selected: true },
    { value: 'T-3', label: 'T-3 · 导出离线报告', selected: false },
    { value: 'T-1', label: 'T-1 · 任务' },
  ];
  assert.deepEqual(matchOptions(options, '  T-3  ').map(o => o.value), ['T-3', 'T-30']);
  assert.deepEqual(matchOptions(options, '离线 报告').map(o => o.value), ['T-3']);
  assert.equal(matchOptions(options, '网页')[0].selected, true);
  assert.deepEqual(matchOptions(options, '不存在'), []);
});

test('task links store both IDs and discard unrelated URL state', () => {
  const href = taskLinkUrl('http://localhost:5196/?view=history&task=T-99#overview', 'project-2', 'T-9');
  assert.equal(href, 'http://localhost:5196/?project=project-2&task=T-9');
  assert.deepEqual(readTaskLink(new URL(href).search), { project: 'project-2', task: 'T-9' });
  assert.deepEqual(readTaskLink('?task=T-9'), { project: '', task: 'T-9' });
  assert.equal(readTaskLink('?project=project-2'), null);
});
