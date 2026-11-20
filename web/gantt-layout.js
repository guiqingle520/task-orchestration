// 甘特图时间轴刻度密度与里程碑竖线标签防重叠纯函数布局。

const FIT_STEPS = [1, 2, 3, 7, 14, 30];
const dow = (d) => new Date(d * 86400000).getUTCDay();

export function computeFitTickDays(min, max, trackWidth = 600, avoidDay = null) {
  const n = Math.max(1, max - min);
  const width = Math.max(120, Number(trackWidth) || 600);
  const maxTicks = Math.max(2, Math.floor(width / 56));
  const want = Math.ceil(n / maxTicks);
  const step = FIT_STEPS.find((candidate) => candidate >= want) ?? Math.ceil(want / 7) * 7;
  const avoidX = typeof avoidDay === 'number' && Number.isFinite(avoidDay)
    ? Math.max(20, Math.min(width - 20, ((avoidDay - min) / n) * width))
    : null;
  const result = [];
  let lastX = -Infinity;
  for (let d = min; d <= max; d++) {
    const match = step === 7 ? dow(d) === 1 : (d - min) % step === 0;
    if (!match) continue;
    const x = ((d - min) / n) * width;
    if (x > width - 38) continue;
    if (x - lastX < 48) continue;
    if (avoidX !== null && x + 36 > avoidX - 24 && x < avoidX + 24) continue;
    result.push(d);
    lastX = x;
  }
  return result;
}

function estimateLabelWidth(name) {
  let px = 22;
  for (const ch of String(name || '')) px += ch.charCodeAt(0) > 127 ? 10.5 : 6.5;
  return Math.min(116, Math.ceil(px));
}

function overlaps(ranges, start, end) {
  return ranges.some(([s, e]) => start < e + 6 && end + 6 > s);
}

export function layoutMilestoneLabels(milestones, totalWidth = 600, selectedId = null) {
  const width = Math.max(120, Number(totalWidth) || 600);
  const items = milestones.map((item) => {
    const leftPx = (item.leftPct / 100) * width;
    const labelW = estimateLabelWidth(item.name);
    let align = 'left';
    let start = leftPx - 4 - labelW;
    let end = leftPx - 4;
    if (start < 2 && leftPx + 4 + labelW <= width - 2) {
      align = 'right';
      start = leftPx + 4;
      end = leftPx + 4 + labelW;
    }
    return { ...item, leftPx, start, end, align };
  });

  const ordered = [...items].sort((a, b) =>
    Number(b.id === selectedId) - Number(a.id === selectedId) || a.leftPx - b.leftPx);
  const lanes = [[], []];
  const layout = new Map();

  for (const item of ordered) {
    if (item.start < 0 || item.end > width) {
      layout.set(item.id, { visible: false, lane: 0, align: item.align });
      continue;
    }
    let placed = -1;
    for (let lane = 0; lane < lanes.length; lane++) {
      if (!overlaps(lanes[lane], item.start, item.end)) {
        lanes[lane].push([item.start, item.end]);
        placed = lane;
        break;
      }
    }
    layout.set(item.id, { visible: placed >= 0, lane: Math.max(0, placed), align: item.align });
  }
  return layout;
}
