import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compute, toDay, fromDay } from '../web/metrics.js';
import { computeBurndown, sanitizePlanForShare } from '../web/analysis.js';
import { startOfflineDashboard } from '../web/offline.js';

const asset = (name) => readFileSync(new URL('../web/' + name, import.meta.url), 'utf8');
const escapeText = (value) => String(value).replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const jsonForScript = (data) => JSON.stringify(data).replace(/[<\u2028\u2029]/g,
  (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));

export class ExportInputError extends Error {}

export function normalizeExportOptions(input, today) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ExportInputError('导出选项格式无效');
  const { maskOwners = false, stripInternalNotes = false, customTitle = '', today: reportDate = today } = input;
  if (typeof maskOwners !== 'boolean' || typeof stripInternalNotes !== 'boolean') throw new ExportInputError('脱敏选项须为布尔值');
  if (typeof customTitle !== 'string' || customTitle.length > 160 || /[\r\n]/.test(customTitle)) {
    throw new ExportInputError('导出标题须为不超过 160 字的单行文本');
  }
  if (typeof reportDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)
    || !Number.isFinite(toDay(reportDate)) || fromDay(toDay(reportDate)) !== reportDate) {
    throw new ExportInputError('统计日期须为有效的 YYYY-MM-DD 日期');
  }
  return { maskOwners, stripInternalNotes, customTitle, today: reportDate };
}

export function buildStandaloneHtml(payload, options = {}) {
  const { plan } = sanitizePlanForShare(payload.plan, options);
  const { today, exportedOn = today } = payload;
  let min = toDay(today), max = min;
  for (const date of [
    ...plan.milestones.map(({ due }) => due),
    ...plan.tasks.flatMap(({ start, end, actualStart, actualEnd }) => [start, end, actualStart, actualEnd]).filter(Boolean),
  ]) {
    min = Math.min(min, toDay(date));
    max = Math.max(max, toDay(date));
  }
  if (max - min > 3660) throw new ExportInputError('离线时间线日期跨度不能超过 3660 天');
  // 不复制传入 payload。只嵌入项目快照、由该快照计算的指标和明确允许的提交。
  const { summary, info, milestones, risks, load, weeks } = compute(plan, today);
  const snapshot = { plan, today, metrics: { summary, info, milestones, risks, load, weeks } };
  if (!options.maskOwners && !options.stripInternalNotes && payload.commits) {
    snapshot.commits = Object.fromEntries(plan.tasks.filter(({ id }) => Array.isArray(payload.commits[id])).map(({ id }) =>
      [id, payload.commits[id].map(({ hash, date, subject }) => ({ hash, date, subject }))]));
  }
  const script = [
    "'use strict';", 'const DAY = 86400000;',
    'const toDay = ' + toDay.toString() + ';', 'const fromDay = ' + fromDay.toString() + ';',
    computeBurndown.toString(), startOfflineDashboard.toString(),
    'window.__OFFLINE_PLAN__ = ' + jsonForScript(snapshot) + ';',
    'startOfflineDashboard(window.__OFFLINE_PLAN__);',
  ].join('\n').replace(/\r\n?/g, '\n');
  const scriptHash = createHash('sha256').update(script).digest('base64');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeText(plan.project)}</title><style>${asset('style.css')}</style></head>
<body class="offline">
<header class="top"><h1>${escapeText(plan.project)}</h1><div class="proj">离线只读快照 · 导出于 ${escapeText(exportedOn)} · 统计日 ${escapeText(today)}</div></header>
<section id="offlineKpis" class="kpis" aria-label="进度概况"></section>
<main>
<section class="card"><h2>时间线 <small>计划 / 实际</small></h2>
<div class="gctrl" id="offlineControls"><div class="seg" aria-label="时间线缩放">
<button type="button" data-scale="fit">适应</button><button type="button" data-scale="day">日</button>
<button type="button" data-scale="week">周</button><button type="button" data-scale="month">月</button></div>
<button type="button" data-groups="expand">全部展开</button><button type="button" data-groups="collapse">全部折叠</button></div>
<div id="offlineGantt" class="offline-scroll"></div><div id="offlineDetail" class="detail" aria-live="polite">点击任务查看详情。</div>
</section>
<aside>
<section class="card"><div class="card-head"><h2>燃尽图</h2><select id="offlineScope" class="scope-select" aria-label="筛选燃尽图里程碑"></select></div>
<div id="offlineBurnSummary" class="burndown-summary"></div><div id="offlineBurn" class="burndown-chart"></div></section>
<section class="card"><h2>里程碑</h2><div id="offlineMilestones"></div></section>
<section class="card"><h2>风险预警</h2><ul id="offlineRisks" class="risks"></ul></section>
<section class="card"><h2>人员负载 <small>每周未完成任务数</small></h2><div id="offlineLoad" class="loadw"></div></section>
</aside></main>
<script>${script}</script></body></html>`;
}
