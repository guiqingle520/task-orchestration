import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter, serializePlanMarkdown, validate } from '../scripts/validate-plan.mjs';
import { updatePlanMarkdown, verifyTaskUpdates } from '../scripts/sync-git-progress.mjs';

test('plan serialization retains body and CRLF and rejects unsafe roundtrips', () => {
  const raw = '---\r\nproject: demo\r\nmilestones:\r\n  - id: M1\r\n    name: 目标\r\n    due: 2026-01-01\r\ntasks:\r\n  - id: T-1\r\n    title: 工作\r\n    owner: dev\r\n    milestone: M1\r\n    start: 2026-01-01\r\n    end: 2026-01-01\r\n    deps: []\r\n    status: todo\r\n    progress: 0\r\n    actualStart: null\r\n    actualEnd: null\r\n---\r\n\r\n# 说明\r\n正文\r\n';
  const plan = parseFrontMatter(raw);
  plan.tasks[0].title = '新任务';
  const output = serializePlanMarkdown(plan, raw, '调整标题');
  assert.equal(parseFrontMatter(output).tasks[0].title, '新任务');
  assert.match(output, /\r\n# 说明\r\n正文\r\n/);
  assert.match(output, /planner 调整标题/);
  assert.throws(() => serializePlanMarkdown(plan, raw.replace('project: demo', 'project: demo # 原注释')), /注释/);
  plan.tasks[0].title = 'bad " quote';
  assert.throws(() => serializePlanMarkdown(plan, raw), /不支持/);
});

test('task progress writeback preserves quoted IDs, inline comments and the Markdown body', () => {
  const raw = [
    '---', 'project: demo', 'milestones:', '  - id: M1', '    name: 目标', '    due: 2026-01-01',
    'tasks:', '  - title: 工作', "    id: 'T-1' # ID", '    owner: dev', '    milestone: M1',
    '    start: 2026-01-01', '    end: 2026-01-01', '    deps: []', '    status: todo',
    '    progress: 0 # progress', '    actualStart: # start', '---', '', '  - id: T-1', '    progress: 0', '',
  ].join('\r\n');
  const plan = parseFrontMatter(raw);
  assert.deepEqual(validate(plan), []);
  const task = { ...plan.tasks[0], status: 'done', progress: 100, actualStart: '2026-01-01', actualEnd: '2026-01-01' };
  const output = updatePlanMarkdown(raw, [task]);
  assert.equal(verifyTaskUpdates(raw, [task]), false);
  assert.equal(verifyTaskUpdates(output, [task]), true);
  assert.match(output, /    progress: 100 # progress\r\n    actualStart: 2026-01-01 # start\r\n    actualEnd: 2026-01-01/);
  assert.ok(output.endsWith('\r\n  - id: T-1\r\n    progress: 0\r\n'));
});
