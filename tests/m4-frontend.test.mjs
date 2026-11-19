import { test } from 'node:test';
import assert from 'node:assert/strict';

test('M4 frontend renders burndown, planner mode, project switcher, and webhook actions', async (t) => {
  const saved = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    setInterval: globalThis.setInterval,
    localStorage: globalThis.localStorage,
  };
  t.after(() => Object.assign(globalThis, saved));

  const elements = new Map();
  const makeEl = (id) => {
    const listeners = {};
    return {
      id,
      value: '',
      checked: false,
      hidden: false,
      innerHTML: '',
      textContent: '',
      className: '',
      scrollLeft: 0,
      clientWidth: 600,
      listeners,
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, ev = { preventDefault() {}, target: { closest: () => null } }) {
        return Promise.all((listeners[type] || []).map((fn) => fn(ev)));
      },
      showModal() { this.open = true; },
      close() { this.open = false; },
    };
  };

  const docListeners = {};
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.setInterval = () => 0;

  const sseUrls = [];
  globalThis.EventSource = class {
    constructor(url) { sseUrls.push(url); }
    addEventListener() {}
    close() {}
  };

  const samplePlan = {
    project: 'task-orchestration',
    milestones: [
      { id: 'M1', name: 'MVP', due: '2026-11-20' },
      { id: 'M4', name: 'M4演进', due: '2026-12-15' },
    ],
    tasks: [
      { id: 'T-1', title: '基础规范', owner: 'planner', milestone: 'M1', start: '2026-11-17', end: '2026-11-17', deps: [], status: 'done', progress: 100, actualStart: '2026-11-17', actualEnd: '2026-11-17' },
      { id: 'T-18', title: '燃尽图卡片', owner: 'antigravity', milestone: 'M4', start: '2026-11-18', end: '2026-11-20', deps: ['T-1'], status: 'doing', progress: 50, actualStart: '2026-11-17', actualEnd: null },
    ],
  };

  let defaultPlan = samplePlan, revision = 'rev-1', pendingSecond;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (url.startsWith('/api/plan/save')) {
      if (JSON.parse(opts.body).expectedRevision !== revision) return { ok: false, status: 409, json: async () => ({ message: '计划已变化' }) };
      return { ok: true, json: async () => ({ ok: true, data: samplePlan, revision: 'rev-2' }) };
    }
    if (url.startsWith('/api/plan')) {
      if (url.endsWith('project=second') && pendingSecond) return pendingSecond;
      return { ok: true, json: async () => ({ data: defaultPlan, revision, commits: {}, errors: [] }) };
    }
    if (url === '/api/webhooks') return { ok: true, json: async () => ({ channels: [{ id: 'ch-1', name: '群机器人', type: 'generic', enabled: true, projects: ['default'] }] }) };
    if (url === '/api/projects') {
      return {
        ok: true,
        json: async () => ({
          default: 'default',
          projects: [
            { id: 'default', name: 'task-orchestration', health: 'green', overall: 75, taskCount: 2 },
            { id: 'second', name: '支付网关', health: 'yellow', overall: 40, taskCount: 5 },
          ],
        }),
      };
    }
    if (url.startsWith('/api/notify')) {
      return { ok: true, json: async () => ({ ok: true, results: [{ id: 'ch-1', status: 'sent' }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  await import(`../web/app.js?t=${Date.now()}`);
  await new Promise((r) => setTimeout(r, 20));

  // 1. T-18: 验证燃尽图 SVG 与里程碑筛选
  assert.match(elements.get('burndownChart').innerHTML, /<svg viewBox="0 0 320 148"/);
  assert.match(elements.get('burndownSummary').innerHTML, /7 日速率/);
  elements.get('burndownScope').value = 'M4';
  await elements.get('burndownScope').dispatch('change');
  assert.match(elements.get('burndownChart').innerHTML, /<polyline/);

  // 2. T-20: 验证规划模式开启、新建任务按钮与计划条拖拽属性
  elements.get('plannerMode').checked = true;
  await elements.get('plannerMode').dispatch('change');
  assert.match(elements.get('timelineOptions').innerHTML, /data-act="new-task"/);
  assert.match(elements.get('gantt').innerHTML, /data-plan-drag="T-18"/);

  // 触发新建任务弹窗并提交保存
  await docListeners.click[0]({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act: 'new-task' } } : null) } });
  assert.equal(elements.get('planTaskId').value, 'T-19');
  elements.get('planTaskTitle').value = '新增验证任务';
  elements.get('planChangeReason').value = '补充前端自动化验证任务';
  await elements.get('taskForm').dispatch('submit');
  const saveCall = calls.find((c) => c.url.startsWith('/api/plan/save'));
  assert.ok(saveCall, 'called /api/plan/save');
  assert.equal(saveCall.body.expectedRevision, 'rev-1');
  assert.equal(saveCall.body.reason, '补充前端自动化验证任务');

  // 拉伸前置条后需先解决下游冲突，确认仍使用起手时的版本。
  assert.match(elements.get('gantt').innerHTML, /data-plan-resize="start"/);
  assert.match(elements.get('gantt').innerHTML, /data-dep-from="T-1"/);
  assert.match(elements.get('gantt').innerHTML, /data-unlink-from="T-1" data-unlink-to="T-18"/);
  const timeline = { getBoundingClientRect: () => ({ width: 200 }), querySelectorAll: () => [], querySelector: () => null };
  const bar = { dataset: { planDrag: 'T-1', days: '20' }, closest: () => timeline };
  docListeners.pointerdown[0]({
    pointerId: 1, button: 0, clientX: 40, preventDefault() {},
    target: { closest: (sel) => sel === '[data-plan-drag]' ? bar
      : sel === '[data-plan-resize]' ? { dataset: { planResize: 'end' } } : null },
  });
  docListeners.pointerup[0]({ pointerId: 1, clientX: 60 });
  assert.equal(elements.get('planEditDialog').open, true);
  assert.equal(elements.get('savePlanEdit').disabled, true);
  assert.match(elements.get('planEditConflicts').innerHTML, /T-18/);
  const beforeSubmit = calls.length;
  await elements.get('planEditForm').dispatch('submit');
  assert.equal(calls.length, beforeSubmit);
  elements.get('planCascade').checked = true;
  await elements.get('planCascade').dispatch('change');
  assert.equal(elements.get('savePlanEdit').disabled, false);
  assert.match(elements.get('planEditChanges').innerHTML, /T-18.*2026-11-19 ～ 2026-11-21（顺延）/);
  revision = 'rev-2';
  await elements.get('today').dispatch('change');
  await elements.get('planEditForm').dispatch('submit');
  assert.equal(calls.filter((call) => call.url.startsWith('/api/plan/save')).at(-1).body.expectedRevision, 'rev-1');
  assert.match(elements.get('planEditMessage').textContent, /重新打开/);
  await elements.get('closePlanEdit').dispatch('click');
  revision = 'rev-1';
  await elements.get('today').dispatch('change');

  const click = (selector, target) => docListeners.click[0]({ target: { closest: (sel) => sel === selector ? target : null } });
  await click('[data-id]', { dataset: { id: 'T-18' } });
  await click('[data-edit-task]', {});
  assert.equal(elements.get('taskProgress').value, 50);
  defaultPlan = structuredClone(samplePlan);
  defaultPlan.tasks[1].progress = 80;
  revision = 'rev-2';
  await elements.get('today').dispatch('change');
  elements.get('planChangeReason').value = '调整计划';
  await elements.get('taskForm').dispatch('submit');
  const stale = calls.filter((c) => c.url.startsWith('/api/plan/save')).at(-1);
  assert.equal(stale.url, '/api/plan/save?project=default');
  assert.equal(stale.body.expectedRevision, 'rev-1');
  assert.equal(stale.body.tasks[1].progress, 50);
  assert.match(elements.get('taskMessage').textContent, /重新打开/);

  // 3. T-22: 验证多项目切换器加载与切换
  assert.match(elements.get('projectSelect').innerHTML, /支付网关/);
  const overviewBeforeFilter = elements.get('kpis').innerHTML;
  const milestonesBeforeFilter = elements.get('milestones').innerHTML;
  elements.get('taskQuery').value = '燃尽';
  await elements.get('taskQuery').dispatch('input');
  assert.match(elements.get('gantt').innerHTML, /data-gantt-task="T-18"/);
  assert.doesNotMatch(elements.get('gantt').innerHTML, /data-gantt-task="T-1"|marker-end="/);
  assert.equal(elements.get('kpis').innerHTML, overviewBeforeFilter);
  assert.equal(elements.get('milestones').innerHTML, milestonesBeforeFilter);
  let finishLoad;
  pendingSecond = new Promise((resolve) => { finishLoad = resolve; });
  elements.get('projectSelect').value = 'second';
  const switching = elements.get('projectSelect').dispatch('change');
  assert.ok(sseUrls.includes('/api/events?project=second'));
  assert.ok(calls.some((c) => c.url === '/api/plan?project=second'));
  assert.equal(elements.get('gantt').innerHTML, '');
  assert.equal(elements.get('taskQuery').value, '');
  assert.equal(elements.get('taskDialog').open, false);
  assert.equal(elements.get('pushRisksBtn').disabled, true);
  const requestsDuringSwitch = calls.length;
  await elements.get('taskForm').dispatch('submit');
  await elements.get('pushRisksBtn').dispatch('click');
  assert.equal(calls.length, requestsDuringSwitch);
  finishLoad({ ok: false, json: async () => ({ message: '计划找不到' }) });
  await switching;
  assert.equal(elements.get('gantt').innerHTML, '');
  assert.equal(elements.get('syncGit').disabled, true);
  pendingSecond = null;
  await elements.get('today').dispatch('change');
  assert.equal(elements.get('pushRisksBtn').disabled, false);

  // 4. T-24: 验证一键推送预警与周报
  await elements.get('configWebhookBtn').dispatch('click');
  assert.match(elements.get('webhookList').innerHTML, /data-wh-project value="default" checked/);
  assert.doesNotMatch(elements.get('webhookList').innerHTML, /data-wh-project value="second" checked/);
  await elements.get('pushRisksBtn').dispatch('click');
  assert.match(elements.get('webhookStatus').textContent, /推送完成：成功 1\/1/);
});
