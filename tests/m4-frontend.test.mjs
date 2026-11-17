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

  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (url.startsWith('/api/plan/save')) {
      return { ok: true, json: async () => ({ ok: true, data: samplePlan, revision: 'rev-2' }) };
    }
    if (url.startsWith('/api/plan')) {
      return { ok: true, json: async () => ({ data: samplePlan, revision: 'rev-1', commits: {}, errors: [] }) };
    }
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
  assert.match(elements.get('burndownSummary').innerHTML, /7日速率/);
  elements.get('burndownScope').value = 'M4';
  await elements.get('burndownScope').dispatch('change');
  assert.match(elements.get('burndownChart').innerHTML, /<polyline/);

  // 2. T-20: 验证规划模式开启、新建任务按钮与计划条拖拽属性
  elements.get('plannerMode').checked = true;
  await elements.get('plannerMode').dispatch('change');
  assert.match(elements.get('gctrl').innerHTML, /data-act="new-task"/);
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

  // 3. T-22: 验证多项目切换器加载与切换
  assert.match(elements.get('projectSelect').innerHTML, /支付网关/);
  elements.get('projectSelect').value = 'second';
  await elements.get('projectSelect').dispatch('change');
  assert.ok(sseUrls.includes('/api/events?project=second'));
  assert.ok(calls.some((c) => c.url === '/api/plan?project=second'));

  // 4. T-24: 验证一键推送预警与周报
  await elements.get('pushRisksBtn').dispatch('click');
  assert.match(elements.get('webhookStatus').textContent, /推送完成：成功 1\/1/);
});
