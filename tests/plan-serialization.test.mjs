import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter, serializePlanMarkdown } from '../scripts/validate-plan.mjs';

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
