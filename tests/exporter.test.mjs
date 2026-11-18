import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { buildStandaloneHtml, normalizeExportOptions } from '../server/exporter.mjs';
import { sanitizePlanForShare } from '../web/analysis.js';

function fixture() {
  const task = (id, owner, title) => ({
    id, title, owner, milestone: 'M1', start: '2026-11-18', end: '2026-11-20', status: 'todo',
    deps: [], progress: 0, actualStart: null, actualEnd: null, internal: 'EXTRA-INT',
  });
  return {
    project: 'PRIVATE-PROJECT',
    milestones: [{ id: 'M1', name: '第一阶段', due: '2026-11-22' }],
    tasks: [task('T-1', 'PRIVATE-OWNER', '标题 (保留) [内部:INT-NOTE] 【内部：INT-NOTE】 <!--INT-NOTE-->'),
      task('T-2', '__proto__', '</script><img src="https://example.invalid"> \u2028 \u2029'), task('T-3', 'PRIVATE-OWNER', '普通任务')],
  };
}

test('share sanitization is deterministic, keeps ordinary parentheses and never mutates the plan', () => {
  const plan = fixture(), original = structuredClone(plan);
  const result = sanitizePlanForShare(plan, { maskOwners: true, stripInternalNotes: true, customTitle: '  分享版  ' });
  assert.equal(result.plan.project, '分享版');
  assert.deepEqual(result.plan.tasks.map(({ owner }) => owner), ['成员-A', '成员-B', '成员-A']);
  assert.equal(result.ownerMap['__proto__'], '成员-B');
  assert.equal(result.plan.tasks[0].title, '标题 (保留)');
  assert.notEqual(result.plan.tasks[0].deps, plan.tasks[0].deps);
  assert.deepEqual(plan, original);
});

test('offline HTML embeds escaped data and excludes private data when either export filter is enabled', () => {
  const payload = { plan: fixture(), today: '2026-11-18', exportedOn: '2026-11-19', notes: 'PRIVATE-NOTES',
    commits: { 'T-1': [{ hash: 'abc123', date: '2026-11-18', subject: 'PRIVATE-COMMIT' }] } };
  const html = buildStandaloneHtml(payload, { maskOwners: true, stripInternalNotes: true, customTitle: '</title><script>BAD</script>' });
  const [opening, script] = html.match(/<script>([\s\S]+)<\/script>/);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.doesNotMatch(opening.slice('<script>'.length, -'</script>'.length), /<\/script>|\u2028|\u2029/i);
  assert.doesNotThrow(() => new Script(script));
  assert.match(html, /<title>&lt;\/title&gt;&lt;script&gt;BAD&lt;\/script&gt;<\/title>/);
  assert.match(html, /成员-A/);
  assert.match(html, /标题 \(保留\)/);
  assert.match(html, /离线只读快照 · 导出于 2026-11-19/);
  assert.doesNotMatch(html, /ownerMap|PRIVATE-|INT-NOTE|EXTRA-INT|<script[^>]+src=|<link[^>]+href=/);
  assert.ok(html.includes('sha256-' + createHash('sha256').update(script).digest('base64')));
  assert.match(buildStandaloneHtml(payload), /PRIVATE-COMMIT/);
  assert.doesNotMatch(buildStandaloneHtml(payload, { maskOwners: true }), /PRIVATE-COMMIT|PRIVATE-OWNER/);
  assert.doesNotMatch(buildStandaloneHtml(payload, { stripInternalNotes: true }), /PRIVATE-COMMIT|INT-NOTE/);
});

test('export accepts existing callers without options and rejects invalid options or report dates', () => {
  assert.equal(normalizeExportOptions({}, '2026-11-18').today, '2026-11-18');
  assert.throws(() => normalizeExportOptions({ today: '2026-02-30' }, '2026-11-18'), /日期/);
  assert.throws(() => normalizeExportOptions({ maskOwners: 'false' }, '2026-11-18'), /布尔/);
});
