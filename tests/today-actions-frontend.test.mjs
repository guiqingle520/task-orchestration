import { test } from 'node:test';
import assert from 'node:assert/strict';

test('T-58: Overview today actions (follow-up + ready), shared owner filter, quick edit unlocks downstream, handoff preview/copy, and read-only time machine', async (t) => {
  const saved = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    setInterval: globalThis.setInterval,
    localStorage: globalThis.localStorage,
  };
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    Object.assign(globalThis, saved);
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  });

  const elements = new Map();
  const makeEl = (id) => {
    const listeners = {};
    return {
      id,
      value: '',
      checked: false,
      hidden: false,
      disabled: false,
      open: false,
      innerHTML: '',
      textContent: '',
      className: '',
      scrollLeft: 0,
      clientWidth: 600,
      dataset: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      setAttribute() {},
      removeAttribute() {},
      focus() {},
      select() {},
      listeners,
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, ev = {}) {
        const event = { preventDefault() {}, target: this, ...ev };
        if (event.target && !event.target.closest) event.target.closest = () => null;
        return Promise.all((listeners[type] || []).map((fn) => fn(event)));
      },
      showModal() { this.open = true; },
      close() { this.open = false; },
    };
  };

  const docListeners = {};
  globalThis.document = {
    body: { dataset: {}, classList: { add() {}, remove() {}, contains: () => false } },
    documentElement: {},
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
  globalThis.EventSource = class {
    constructor() {}
    addEventListener() {}
    close() {}
  };

  let copiedText = '';
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async writeText(text) { copiedText = text; },
      },
    },
  });

  const plan = {
    project: 'task-orchestration',
    milestones: [{ id: 'M8', name: 'M8 行动台', due: '2026-11-30' }],
    tasks: [
      { id: 'T-1', title: '完成前置算法', owner: 'codex', milestone: 'M8', start: '2026-11-16', end: '2026-11-17', deps: [], status: 'doing', progress: 60, actualStart: '2026-11-16', actualEnd: null },
      { id: 'T-2', title: '联调总览界面', owner: 'antigravity', milestone: 'M8', start: '2026-11-19', end: '2026-11-21', deps: ['T-1'], status: 'todo', progress: 0, actualStart: null, actualEnd: null },
      { id: 'T-3', title: '现在即可开工任务', owner: 'codex', milestone: 'M8', start: '2026-11-19', end: '2026-11-22', deps: [], status: 'todo', progress: 0, actualStart: null, actualEnd: null },
      { id: 'T-4', title: '计划未来开始任务', owner: 'antigravity', milestone: 'M8', start: '2026-11-25', end: '2026-11-26', deps: [], status: 'todo', progress: 0, actualStart: null, actualEnd: null },
    ],
  };
  const acceptanceByTask = {
    'T-2': '完成前置后下游自动出现在可开工列表，复制说明不改状态。',
  };
  const historyCommits = [
    { hash: 'aaaa111', shortHash: 'aaaa111', date: '2026-11-18', author: 'codex', subject: '历史切片', overall: 15, doneCount: 0, taskCount: 4 },
  ];

  const taskWrites = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (url.startsWith('/api/task') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      taskWrites.push(body);
      const target = plan.tasks.find((item) => item.id === body.id);
      assert.deepEqual(body.expected, {
        status: target.status,
        progress: target.progress,
        actualStart: target.actualStart,
        actualEnd: target.actualEnd,
      });
      target.status = body.status;
      target.progress = body.progress;
      if (target.status === 'done') target.actualEnd = '2026-11-19';
      return { ok: true, status: 200, json: async () => ({ ok: true, task: target }) };
    }
    if (url.startsWith('/api/plan')) {
      return { ok: true, json: async () => ({ data: structuredClone(plan), acceptanceByTask, revision: 'rev-1', commits: {}, errors: [] }) };
    }
    if (url === '/api/projects') {
      return { ok: true, json: async () => ({ default: 'default', projects: [{ id: 'default', name: 'task-orchestration', health: 'yellow', overall: 15, taskCount: 4 }] }) };
    }
    if (url.startsWith('/api/history') && url.includes('rev=aaaa111')) {
      return { ok: true, json: async () => ({ projectId: 'default', commit: historyCommits[0], data: structuredClone(plan), acceptanceByTask }) };
    }
    if (url.startsWith('/api/history')) {
      return { ok: true, json: async () => ({ projectId: 'default', current: { revision: 'rev-1', date: '2026-11-19' }, commits: historyCommits }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  await import(`../web/app.js?t=${Date.now()}`);
  await new Promise((r) => setTimeout(r, 30));
  document.getElementById('today').value = '2026-11-19';
  await document.getElementById('today').dispatch('change');
  await new Promise((r) => setTimeout(r, 30));

  // 1. 初始渲染：T-1 在需跟进，T-3(现在可开工) 与 T-4(可提前开始) 在可开工，T-2 等待前置不入可开工，且无 +25% 按钮
  const followHtml = elements.get('todayFollowList').innerHTML;
  const readyHtml = elements.get('todayReadyList').innerHTML;
  assert.match(followHtml, /T-1 · 完成前置算法/);
  assert.match(followHtml, /已逾期 2 天/);
  assert.match(followHtml, /data-quick-edit="T-1"/);
  assert.match(followHtml, /data-handoff-task="T-1"/);
  assert.doesNotMatch(followHtml + readyHtml, /\+25%/);
  assert.match(readyHtml, /T-3 · 现在即可开工任务/);
  assert.match(readyHtml, /现在可开工/);
  assert.match(readyHtml, /无前置依赖/);
  assert.match(readyHtml, /T-4 · 计划未来开始任务/);
  assert.match(readyHtml, /可提前开始/);
  assert.doesNotMatch(readyHtml, /T-2 · 联调总览界面/);

  // 2. 共用负责人筛选同时作用于「需跟进」与「可开工」
  elements.get('todayActionOwner').value = 'antigravity';
  await elements.get('todayActionOwner').dispatch('change');
  assert.doesNotMatch(elements.get('todayFollowList').innerHTML, /T-1/);
  assert.doesNotMatch(elements.get('todayReadyList').innerHTML, /T-3/);
  assert.match(elements.get('todayReadyList').innerHTML, /T-4 · 计划未来开始任务/);
  elements.get('todayActionOwner').value = '';
  await elements.get('todayActionOwner').dispatch('change');

  // 3. 端到端验收：在总览点「更新进度」完成前置 T-1 → 下游 T-2 立即进入「可开工」
  const click = (selector, target) => docListeners.click[0]({ target: { closest: (sel) => (sel === selector ? target : null) } });
  await click('[data-quick-edit]', { dataset: { quickEdit: 'T-1' } });
  assert.equal(elements.get('taskDialog').open, true, 'task modal opens from overview quick edit');
  elements.get('taskStatus').value = 'done';
  elements.get('taskProgress').value = '100';
  await elements.get('taskForm').dispatch('submit');
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(taskWrites.length, 1);
  assert.equal(taskWrites[0].id, 'T-1');
  const readyAfterDone = elements.get('todayReadyList').innerHTML;
  assert.match(readyAfterDone, /T-2 · 联调总览界面/);
  assert.match(readyAfterDone, /现在可开工/);
  assert.match(readyAfterDone, /前置 T-1 均已完成/);

  // 4. 预览并复制 T-2 开工说明，验证验收要求精确展示且不修改 T-2 状态
  await click('[data-handoff-task]', { dataset: { handoffTask: 'T-2' } });
  assert.equal(elements.get('handoffDialog').open, true);
  assert.match(elements.get('handoffText').value, /任务：T-2 联调总览界面/);
  assert.match(elements.get('handoffText').value, /验收要求：完成前置后下游自动出现在可开工列表/);
  await elements.get('copyHandoffBtn').dispatch('click');
  assert.equal(copiedText, elements.get('handoffText').value);
  assert.equal(taskWrites.length, 1, 'copying handoff does not modify task state');
  assert.equal(plan.tasks.find((x) => x.id === 'T-2').status, 'todo');

  // 无验收要求的任务预览明确显示「未填写」
  await click('[data-handoff-task]', { dataset: { handoffTask: 'T-3' } });
  assert.match(elements.get('handoffText').value, /验收要求：未填写/);

  // 5. 时间机器模式下保持只读（不渲染更新进度按钮，仍可预览开工说明）
  await click('[data-act]', { dataset: { act: 'toggle-time-machine' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.doesNotMatch(elements.get('todayFollowList').innerHTML + elements.get('todayReadyList').innerHTML, /data-quick-edit/);
  assert.match(elements.get('todayReadyList').innerHTML, /data-handoff-task/);
});
