import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFitTickDays, layoutMilestoneLabels } from '../web/gantt-layout.js';
import { toDay } from '../web/metrics.js';

test('computeFitTickDays adapts tick density to track width without crowding', () => {
  const min = toDay('2026-11-09');
  const max = toDay('2026-12-03');
  const n = max - min;

  const narrow = computeFitTickDays(min, max, 200);
  const wide = computeFitTickDays(min, max, 760);

  assert.ok(narrow.length >= 2 && narrow.length <= 4, `expected 2..4 narrow ticks, got ${narrow.length}`);
  assert.ok(wide.length > narrow.length, 'wide track shows more ticks than narrow track');

  for (let i = 1; i < narrow.length; i++) {
    const gapPx = ((narrow[i] - narrow[i - 1]) / n) * 200;
    assert.ok(gapPx >= 48, `narrow tick gap ${gapPx}px should be >= 48px`);
  }
});

test('layoutMilestoneLabels staggers close milestones, flips left edge, and hides unplaceable overlaps', () => {
  const milestones = [
    { id: 'M1', name: '支付接入与联调', leftPct: 48 },
    { id: 'M2', name: '灰度验收与发布', leftPct: 68 },
    { id: 'M3', name: '交付资料归档', leftPct: 92 },
  ];

  // 窄屏 210px 下 3 个里程碑彼此靠近，最多错开 2 层，放不下的隐藏而非重叠
  const narrow = layoutMilestoneLabels(milestones, 210, 'M2');
  assert.equal(narrow.get('M2').visible, true, 'selected milestone keeps priority');
  assert.equal(narrow.get('M2').lane, 0);
  const visibleCount = [...narrow.values()].filter((v) => v.visible).length;
  assert.ok(visibleCount <= 2, `narrow 210px should place at most 2 overlapping labels, got ${visibleCount}`);

  // 宽屏 900px 下全部可见
  const wide = layoutMilestoneLabels(milestones, 900);
  assert.equal([...wide.values()].filter((v) => v.visible).length, 3);

  // 靠左边界的里程碑自动右翻，不裁出左侧
  const leftEdge = layoutMilestoneLabels([{ id: 'M0', name: '启动里程碑', leftPct: 5 }], 400);
  assert.equal(leftEdge.get('M0').visible, true);
  assert.equal(leftEdge.get('M0').align, 'right');
});
