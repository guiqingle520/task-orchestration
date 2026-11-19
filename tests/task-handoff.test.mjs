import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractAcceptanceByTask } from '../server/plan-acceptance.mjs';
import { buildTaskHandoff, readyTasks } from '../web/task-handoff.js';

const today = '2026-11-19';
function task(id, status, deps = [], start = today) {
  return { id, title: '任务 ' + id, owner: 'dev', milestone: 'M1', start, end: '2026-11-30',
    deps, status, progress: status === 'done' ? 100 : 0 };
}

test('only todo tasks with all prerequisites done qualify, using the displayed date', () => {
  const tasks = [
    task('T-1', 'done'), task('T-2', 'doing'), task('T-3', 'blocked'),
    task('T-4', 'todo', ['T-1', 'T-2']), task('T-5', 'todo', ['T-1'], '2026-11-20'),
    task('T-6', 'todo'), task('T-7', 'todo', ['T-99']), task('T-8', 'todo', [], '2026-11-18'),
  ];
  assert.deepEqual(readyTasks(tasks, today).map(({ task, availability, reason }) => [task.id, availability, reason]), [
    ['T-8', 'now', '无前置依赖'], ['T-6', 'now', '无前置依赖'], ['T-5', 'early', '前置 T-1 均已完成'],
  ]);
  const updated = tasks.map(item => item.id === 'T-2' ? { ...item, status: 'done', progress: 100 } : item);
  assert.equal(readyTasks(updated, today).find(row => row.task.id === 'T-4').reason, '前置 T-1、T-2 均已完成');
  assert.equal(readyTasks(updated, '2026-11-20').find(row => row.task.id === 'T-5').availability, 'now');
});

test('acceptance comes from exact ID cells in plan body tables only', () => {
  const table = '| 任务 | 验收标准 |\n|---|---|';
  const markdown = ['\uFEFF---', table, '| T-5 | YAML |', '---', '变更记录：T-5 提到 T-50。',
    '~~~~md', table, '| T-5 | 示例 |', '~~~', '~~~~', table, '| `T-50` | 支持 A \\| B |',
    '| T-51 |   |', '| T-5 和 T-50 | 无归属 |', '', '| 任务 | 备注 |', '|---|---|', '| T-5 | 其他表 |',
    '', table, '| T-50 | 覆盖第二种情况 |'].join('\n');
  assert.deepEqual(extractAcceptanceByTask(markdown.replaceAll('\n', '\r\n')), { 'T-50': '支持 A | B\n覆盖第二种情况' });
  assert.deepEqual(extractAcceptanceByTask(markdown + '\n| T-5 | 只验收五号 |')['T-5'], '只验收五号');
});

test('handoff uses the selected task and snapshot without changing task state', () => {
  const plan = { project: '示例', milestones: [{ id: 'M1', name: '交付' }],
    tasks: [task('T-1', 'done'), task('T-5', 'todo', ['T-1'])] };
  const before = structuredClone(plan);
  const text = buildTaskHandoff(plan, 'T-5', { 'T-50': '另一个任务' });
  for (const field of ['项目：示例', 'T-5 任务 T-5', 'M1 交付', '负责人：dev', 'todo，0%',
    'T-1 任务 T-1（done，100%）', '验收要求：未填写', today]) assert.ok(text.includes(field), field);
  assert.doesNotMatch(text, /另一个任务/);
  assert.match(buildTaskHandoff(plan, 'T-5', { 'T-5': '精确验收' }), /验收要求：精确验收/);
  assert.equal(buildTaskHandoff(plan, 'T-99'), null);
  assert.deepEqual(plan, before);
});
