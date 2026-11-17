import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLoad, buildReport, buildReportSvg, comparePlans } from '../web/analysis.js';

test('snapshot comparison identifies additions, removals, schedule and progress changes', () => {
  const before = { tasks: [{ id: 'A', title: 'A', start: '2026-01-01', end: '2026-01-02', progress: 0, deps: [] }, { id: 'B', title: 'B' }] };
  const after = { tasks: [{ id: 'A', title: 'A', start: '2026-01-01', end: '2026-01-04', progress: 30, deps: ['C'] }, { id: 'C', title: 'C' }] };
  const result = comparePlans(before, after);
  assert.deepEqual(result.map((x) => [x.id, x.type]), [['A', 'changed'], ['B', 'removed'], ['C', 'added']]);
  assert.deepEqual(result[0].differences.map((x) => x.field), ['end', 'progress', 'deps']);
  assert.deepEqual(comparePlans(before, before), []);
});

test('load uses daily overlap and proposes a capacity-safe shift', () => {
  const make = (id, start, end, deps = []) => ({ id, owner: 'dev', status: 'todo', start, end, deps });
  const data = { tasks: [make('A', '2026-01-05', '2026-01-06'), make('B', '2026-01-05', '2026-01-06'), make('C', '2026-01-05', '2026-01-06'), make('D', '2026-01-07', '2026-01-07')] };
  const result = analyzeLoad(data);
  assert.equal(Object.values(result.load.dev)[0], 3);
  assert.deepEqual(result.conflicts[0].taskIds, ['A', 'B', 'C']);
  assert.equal(result.suggestions[0].start, '2026-01-07');
  const noOverlap = { tasks: [make('A', '2026-01-05', '2026-01-05'), make('B', '2026-01-06', '2026-01-06'), make('C', '2026-01-07', '2026-01-07')] };
  assert.equal(Object.values(analyzeLoad(noOverlap).load.dev)[0], 1);
  assert.deepEqual(analyzeLoad(noOverlap).conflicts, []);
});

test('reports summarize the selected week and escape user content', () => {
  const data = { project: '<Project>', tasks: [{ id: 'T-1', title: 'A | B & C', owner: 'dev', status: 'done', progress: 100, actualStart: '2026-01-02', actualEnd: '2026-01-05' }] };
  const metrics = { summary: { overall: 100, overdueCount: 0, blockedCount: 0 }, milestones: [], risks: [] };
  const report = buildReport(data, metrics, '2026-01-07');
  assert.match(report.markdown, /开始：T-1/);
  assert.match(report.markdown, /完成：T-1/);
  assert.match(report.markdown, /A \\\| B/);
  const svg = buildReportSvg(data, metrics, '2026-01-07');
  assert.match(svg, /&lt;Project&gt;/);
  assert.match(svg, /A \| B &amp; C/);
});
