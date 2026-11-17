import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute, simulateDelays } from '../web/metrics.js';

const task = (id, start, end, deps = [], milestone = 'M1') => ({ id, start, end, deps, milestone });
const plan = () => ({
  milestones: [{ id: 'M1' }, { id: 'M2' }, { id: 'empty' }],
  tasks: [
    task('A', '2026-01-01', '2026-01-02'),
    task('B', '2026-01-05', '2026-01-06', ['A']),
    task('C', '2026-01-03', '2026-01-05', [], 'M2'),
    task('D', '2026-01-07', '2026-01-08', ['B', 'C'], 'M2'),
  ],
});

test('delay propagates through gaps and converging dependencies without mutating the plan', () => {
  const data = plan(), before = structuredClone(data);
  const absorbed = simulateDelays(data, { A: 2 });
  assert.equal(absorbed.tasks.A.end, '2026-01-04');
  assert.equal(absorbed.tasks.B.delayDays, 0);
  const result = simulateDelays(data, { A: 4, C: 3 });
  assert.equal(result.tasks.B.start, '2026-01-07');
  assert.equal(result.tasks.D.start, '2026-01-09');
  assert.equal(result.tasks.D.delayDays, 2);
  assert.deepEqual(result.milestones[1], { id: 'M2', baselineEnd: '2026-01-08', end: '2026-01-10', delayDays: 2 });
  assert.deepEqual(result.milestones[2], { id: 'empty', baselineEnd: null, end: null, delayDays: 0 });
  assert.deepEqual(data, before);
});

test('multiple direct delays, baseline overlap, and critical paths are calculated consistently', () => {
  const data = { milestones: [{ id: 'M1' }], tasks: [
    task('B', '2026-01-02', '2026-01-03', ['A']),
    task('A', '2026-01-01', '2026-01-02'),
    task('C', '2026-01-01', '2026-01-04'),
  ] };
  const base = simulateDelays(data);
  assert.equal(base.tasks.B.baselineStart, '2026-01-03');
  assert.equal(base.tasks.B.delayDays, 0);
  assert.deepEqual(new Set(base.criticalTaskIds), new Set(['A', 'B', 'C']));
  const result = simulateDelays(data, { A: 2, B: 1 });
  assert.equal(result.tasks.B.start, '2026-01-05');
  assert.equal(result.tasks.B.delayDays, 2);
  assert.equal(result.tasks.C.slackDays, 2);
  assert.deepEqual(new Set(result.criticalTaskIds), new Set(['A', 'B']));
});

test('rejects invalid scenarios and dependency graphs', () => {
  assert.throws(() => simulateDelays(plan(), { unknown: 1 }), /未知任务/);
  assert.throws(() => simulateDelays(plan(), { A: -1 }), /非负整数/);
  assert.throws(() => simulateDelays(plan(), { A: 0.5 }), /非负整数/);
  const missing = plan(); missing.tasks[0].deps = ['missing'];
  assert.throws(() => simulateDelays(missing), /未知依赖/);
  const cyclic = plan(); cyclic.tasks[0].deps = ['D'];
  assert.throws(() => simulateDelays(cyclic), /循环/);
  const invalid = plan(); invalid.tasks[0].start = '2026-02-30';
  assert.throws(() => simulateDelays(invalid), /日期无效/);
});

test('dashboard metrics handle an independent first task', () => {
  const data = { milestones: [{ id: 'M1', due: '2026-01-10' }], tasks: [
    { ...task('X', '2026-01-01', '2026-01-01'), status: 'todo', progress: 0, owner: 'a' },
    { ...task('A', '2026-01-01', '2026-01-02'), status: 'todo', progress: 0, owner: 'a' },
  ] };
  assert.equal(compute(data, '2026-01-01').info.A.critical, true);
});

test('completed milestone forecasts use actual completion dates', () => {
  const data = { milestones: [{ id: 'M1', due: '2026-01-04' }], tasks: [
    { ...task('A', '2026-01-01', '2026-01-06'), status: 'done', progress: 100, actualStart: '2026-01-01', actualEnd: '2026-01-03', owner: 'a' },
  ] };
  const metrics = compute(data, '2026-01-03');
  assert.equal(metrics.milestones[0].forecast, '2026-01-03');
  assert.equal(metrics.risks.length, 0);
});
