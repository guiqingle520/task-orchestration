import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeMemberWorkload,
  computeStatusBreakdown,
  computeThroughput,
  renderCapacityHoursSvg,
  renderMemberLoadSvg,
  renderMilestoneCompareSvg,
  renderStatusDonutSvg,
  renderThroughputSvg,
} from '../web/charts.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const sampleTasks = [
  { id: 'T-1', milestone: 'M1', owner: 'Alice', status: 'done', actualEnd: '2026-11-28', end: '2026-11-28' },
  { id: 'T-2', milestone: 'M1', owner: 'Alice', status: 'done', actualEnd: '2026-11-29', end: '2026-11-29' },
  { id: 'T-3', milestone: 'M1', owner: 'Bob', status: 'doing' },
  { id: 'T-4', milestone: 'M2', owner: 'Bob', status: 'blocked' },
  { id: 'T-5', milestone: 'M2', owner: 'Carol', status: 'todo' },
];

test('computeStatusBreakdown counts 4 statuses and filters by milestone', () => {
  const all = computeStatusBreakdown(sampleTasks, 'all');
  assert.equal(all.total, 5);
  assert.equal(all.donePct, 40);
  assert.deepEqual(all.counts, { done: 2, doing: 1, blocked: 1, todo: 1 });

  const m2 = computeStatusBreakdown(sampleTasks, 'M2');
  assert.equal(m2.total, 2);
  assert.equal(m2.donePct, 0);
  assert.deepEqual(m2.counts, { done: 0, doing: 0, blocked: 1, todo: 1 });

  const html = renderStatusDonutSvg(all, esc);
  assert.match(html, /role="img"/);
  assert.match(html, /data-chart-status="blocked"/);
  assert.match(html, /40%/);
});

test('computeThroughput builds 14-day series and 7-day rolling average', () => {
  const tp = computeThroughput(sampleTasks, '2026-11-29', 14, 'all');
  assert.equal(tp.days.length, 14);
  assert.equal(tp.totalDone, 2);
  assert.equal(tp.days.at(-1).date, '2026-11-29');
  assert.equal(tp.days.at(-1).count, 1);
  assert.equal(tp.days.at(-2).count, 1);
  assert.ok(tp.days.at(-1).avg7 > 0);

  const svg = renderThroughputSvg(tp, esc);
  assert.match(svg, /<svg/);
  assert.match(svg, /<polyline/);
});

test('renderMilestoneCompareSvg renders bars and delay badges', () => {
  const milestones = [
    { id: 'M1', name: '启动', progress: 100, taskCount: 3, doneCount: 3, due: '2026-11-28', forecast: '2026-11-28' },
    { id: 'M2', name: '核心', progress: 45, taskCount: 4, doneCount: 2, due: '2026-11-30', forecast: '2026-12-03' },
  ];
  const delayFn = (ms) => (ms.forecast > ms.due ? { label: '预计延期', tone: 'bad' } : { label: '按期', tone: 'ok' });
  const svg = renderMilestoneCompareSvg(milestones, delayFn, esc);
  assert.match(svg, /M1/);
  assert.match(svg, /M2/);
  assert.match(svg, /100%/);
  assert.match(svg, /45%/);
});

test('computeMemberWorkload and renderMemberLoadSvg produce stacked bars', () => {
  const members = computeMemberWorkload(sampleTasks);
  assert.equal(members.length, 3);
  assert.equal(members[0].owner, 'Bob');
  assert.equal(members[0].blocked, 1);
  assert.equal(members[1].owner, 'Alice');
  assert.equal(members[1].done, 2);
  const html = renderMemberLoadSvg(members, esc);
  assert.match(html, /Alice/);
  assert.match(html, /Bob/);
  assert.match(html, /<svg/);
});

test('renderCapacityHoursSvg compares estimated vs actual hours', () => {
  const html = renderCapacityHoursSvg([
    { owner: 'Alice', estimateHours: 16, reportedActualHours: 14, inferredActualHours: 0 },
    { owner: 'Bob', estimateHours: 20, reportedActualHours: 20, inferredActualHours: 4 },
  ], esc);
  assert.match(html, /预估工时/);
  assert.match(html, /实际工时/);
  assert.match(html, /16h \/ 14h/);
  assert.match(html, /20h \/ 24h/);
});
