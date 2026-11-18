import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLoad, buildReport, buildReportSvg, comparePlans, computeBurndown, computeTimelineDiff } from '../web/analysis.js';

test('snapshot comparison identifies additions, removals, schedule and progress changes', () => {
  const before = { tasks: [{ id: 'A', title: 'A', start: '2026-01-01', end: '2026-01-02', progress: 0, deps: [] }, { id: 'B', title: 'B' }] };
  const after = { tasks: [{ id: 'A', title: 'A', start: '2026-01-01', end: '2026-01-04', progress: 30, deps: ['C'] }, { id: 'C', title: 'C' }] };
  const result = comparePlans(before, after);
  assert.deepEqual(result.map((x) => [x.id, x.type]), [['A', 'changed'], ['B', 'removed'], ['C', 'added']]);
  assert.deepEqual(result[0].differences.map((x) => x.field), ['end', 'progress', 'deps']);
  assert.deepEqual(comparePlans(before, before), []);
});

test('timeline diff keeps signed schedule deltas and uses null for the missing side', () => {
  const task = (id, start, end, progress) => ({ id, start, end, progress });
  const baseline = { project: 'Baseline', tasks: [
    task('T-1', '2026-01-03', '2026-01-06', 25), task('T-2', '2026-01-07', '2026-01-08', 0),
    task('T-3', '2026-01-02', '2026-01-02', 70), task('T-4', '2026-01-02', '2026-01-03', 0),
  ] };
  const current = { project: 'Current', tasks: [
    task('T-1', '2026-01-05', '2026-01-07', 50), task('T-3', '2026-01-01', '2026-01-01', 60),
    task('T-4', '2026-01-02', '2026-01-03', 10), task('T-5', '2026-01-02', '2026-01-02', 0),
  ] };
  const before = structuredClone([baseline, current]);
  const diff = computeTimelineDiff(baseline, current);
  assert.equal(diff.baselineProject, 'Baseline');
  assert.equal(diff.currentProject, 'Current');
  assert.deepEqual(diff.summary, { addedCount: 1, removedCount: 1, shiftedCount: 2, totalSlipDays: 0 });
  assert.deepEqual(diff.tasks['T-1'], {
    status: 'common', baselineStart: '2026-01-03', baselineEnd: '2026-01-06', currentStart: '2026-01-05', currentEnd: '2026-01-07',
    startShiftDays: 2, endShiftDays: 1, durationDelta: -1, progressDelta: 25,
  });
  assert.equal(diff.tasks['T-3'].endShiftDays, -1);
  assert.equal(diff.tasks['T-3'].progressDelta, -10);
  assert.equal(diff.tasks['T-4'].startShiftDays, 0);
  assert.equal(diff.tasks['T-5'].status, 'added');
  assert.equal(diff.tasks['T-5'].baselineStart, null);
  assert.equal(diff.tasks['T-5'].progressDelta, null);
  assert.equal(diff.tasks['T-2'].status, 'removed');
  assert.equal(diff.tasks['T-2'].currentEnd, null);
  assert.equal(diff.tasks['T-2'].durationDelta, null);
  assert.deepEqual([baseline, current], before);
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

test('burndown reconstructs completed history, current progress and forecast by scope', () => {
  const plan = { milestones: [{ id: 'M1', due: '2026-01-10' }, { id: 'M2', due: '2026-01-12' }], tasks: [
    { id: 'A', milestone: 'M1', start: '2026-01-01', end: '2026-01-04', status: 'done', progress: 100, actualEnd: '2026-01-03' },
    { id: 'B', milestone: 'M1', start: '2026-01-05', end: '2026-01-08', status: 'doing', progress: 50 },
    { id: 'C', milestone: 'M2', start: '2026-01-08', end: '2026-01-09', status: 'todo', progress: 0 },
  ] };
  const result = computeBurndown(plan, '2026-01-07', 'M1');
  assert.equal(result.totalScope, 8);
  assert.equal(result.remainingScope, 2);
  assert.equal(result.series[0].ideal, 7);
  assert.equal(result.series[1].actual, 8);
  assert.equal(result.series[2].actual, 4);
  assert.equal(result.series.find((row) => row.date === '2026-01-08').actual, null);
  assert.equal(result.velocity, 1);
  assert.equal(result.forecastEnd, '2026-01-09');
  assert.equal(result.slipDays, -1);
  assert.equal(computeBurndown(plan, '2026-01-07', 'M2').forecastEnd, null);
  assert.throws(() => computeBurndown(plan, '2026-01-07', 'missing'), /不存在/);
});

test('burndown handles completed and empty scopes without inventing velocity', () => {
  const plan = { milestones: [{ id: 'M1', due: '2026-01-10' }, { id: 'M2', due: '2026-01-10' }], tasks: [{ id: 'A', milestone: 'M1', start: '2026-01-01', end: '2026-01-02', status: 'done', progress: 100, actualEnd: '2026-01-02' }] };
  const done = computeBurndown(plan, '2026-01-05', 'M1');
  assert.equal(done.forecastEnd, '2026-01-05');
  assert.equal(done.slipDays, 0);
  const empty = computeBurndown(plan, '2026-01-05', 'M2');
  assert.equal(empty.forecastEnd, null);
  assert.deepEqual(empty.series, []);
});
