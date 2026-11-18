import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeCapacityMetrics, countWorkingDays } from '../web/analysis.js';
import { normalizeCapacityConfig } from '../server/capacity.mjs';

test('working days use inclusive UTC dates, makeup weekends, and holiday priority', () => {
  const config = { holidays: ['2026-12-25', '2026-12-27'], workdays: ['2026-12-26', '2026-12-27'] };
  assert.equal(countWorkingDays('2026-12-25', '2026-12-27'), 1);
  assert.equal(countWorkingDays('2026-12-26', '2026-12-27'), 0);
  assert.equal(countWorkingDays('2026-12-25', '2026-12-27', config), 1);
  assert.equal(countWorkingDays('2026-12-25', '2026-12-27', { ...config, excludeWeekends: false }), 1);
  assert.equal(countWorkingDays('2026-12-25', '2027-01-08', config), 11);
  assert.throws(() => countWorkingDays('2026-02-30', '2026-03-01'), /无效/);
});

test('capacity preserves reported zeros and computes team and owner accuracy only for comparable completed tasks', () => {
  const done = (id, owner) => ({ id, owner, start: '2026-12-26', end: '2026-12-27', status: 'done', actualStart: '2026-12-26', actualEnd: '2026-12-27' });
  const plan = { tasks: [
    done('T-1', 'dev'), done('T-2', 'dev'), done('T-3', 'qa'), done('T-4', 'qa'),
    { ...done('T-5', 'qa'), status: 'doing', actualEnd: null }, done('T-6', 'dev'),
  ] };
  const config = normalizeCapacityConfig({ tasks: {
    'T-1': { storyPoints: 0, estimateHours: 0, actualHours: 0 },
    'T-2': { estimateHours: 10, actualHours: 0 },
    'T-3': { estimateHours: 20, actualHours: 30 },
    'T-4': { estimateHours: 0, actualHours: 7 },
    'T-5': { actualHours: 5 },
  } });
  const stats = computeCapacityMetrics(plan, config, '2026-12-27');
  assert.equal(stats.tasks['T-1'].storyPoints, 0);
  assert.equal(stats.tasks['T-1'].estimateHours, 0);
  assert.equal(stats.tasks['T-1'].actualHours, 0);
  assert.equal(stats.tasks['T-1'].estimateSource, 'reported');
  assert.equal(stats.tasks['T-1'].actualSource, 'reported');
  assert.equal(stats.tasks['T-1'].accuracyPct, null);
  assert.equal(stats.tasks['T-2'].accuracyPct, 0);
  assert.equal(stats.tasks['T-3'].inflationRatio, 1.5);
  assert.equal(stats.tasks['T-4'].inflationRatio, null);
  assert.equal(stats.tasks['T-5'].accuracyPct, null);
  assert.equal(stats.tasks['T-6'].actualSource, 'inferred');
  assert.equal(stats.tasks['T-6'].actualHours, 8);
  assert.equal(stats.tasks['T-6'].workingDays, 0);
  assert.equal(stats.calendarWarnings.length, plan.tasks.length);
  assert.deepEqual([stats.totalStoryPoints, stats.completedStoryPoints, stats.totalEstimateHours, stats.reportedActualHours, stats.inferredActualHours], [5, 4, 46, 42, 8]);
  assert.deepEqual([stats.sampledDoneCount, stats.overallAccuracyPct, stats.overallInflationRatio], [2, 25, 1]);
  assert.deepEqual(stats.byOwner.map(({ owner, sampledDoneCount, accuracyPct }) => [owner, sampledDoneCount, accuracyPct]), [
    ['dev', 1, 0], ['qa', 1, 50],
  ]);
  const cleared = computeCapacityMetrics(plan, { tasks: { 'T-1': { storyPoints: 0, estimateHours: 0 } } }, '2026-12-27');
  assert.equal(cleared.tasks['T-1'].actualSource, 'inferred');
  assert.equal(cleared.sampledDoneCount, 0);
  assert.equal(cleared.overallAccuracyPct, null);
  assert.equal(cleared.overallInflationRatio, null);
});

test('capacity schema rejects malformed dates, invalid zero bounds and nonnumeric task fields', () => {
  for (const bad of [
    { hoursPerDay: 0 }, { hoursPerDay: 25 }, { excludeWeekends: 0 },
    { holidays: ['2026-02-29'] }, { workdays: '2026-12-27' },
    { tasks: { 'T-1': { actualHours: null } } }, { tasks: { 'T-1': { actualHours: -1 } } },
    { tasks: { 'T-1': { estimateHours: '0' } } }, { tasks: { bad: { storyPoints: 2 } } },
  ]) assert.throws(() => normalizeCapacityConfig(bad));
});
