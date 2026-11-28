import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DONE_COLLAPSE_LIMIT, groupKanbanTasks, kanbanStatusTransition } from '../web/kanban.js';
import { aggregatePortfolioActions, summarizePortfolioDetails } from '../server/portfolio.mjs';
import { diffExternalClaimUpdates, diffExternalTaskUpdates, installToastHost } from '../web/toast.js';
import { installPortfolio } from '../web/portfolio-panel.js';

function sampleTask(id, status, extra = {}) {
  return {
    id,
    title: `任务 ${id}`,
    owner: 'dev',
    milestone: 'M1',
    start: '2026-11-20',
    end: '2026-11-25',
    deps: [],
    status,
    progress: status === 'done' ? 100 : status === 'doing' ? 40 : 0,
    actualStart: status === 'todo' ? null : '2026-11-20',
    actualEnd: status === 'done' ? '2026-11-22' : null,
    ...extra,
  };
}

test('T-83 unit: groupKanbanTasks sorts, collapses done beyond limit, and kanbanStatusTransition computes progress', () => {
  const tasks = [
    sampleTask('T-2', 'todo', { end: '2026-11-28' }),
    sampleTask('T-1', 'todo', { end: '2026-11-22' }),
    sampleTask('T-3', 'doing', { progress: 55 }),
    sampleTask('T-4', 'blocked', { progress: 20 }),
    ...Array.from({ length: DONE_COLLAPSE_LIMIT + 2 }, (_, idx) =>
      sampleTask(`T-${10 + idx}`, 'done', { actualEnd: `2026-11-${String(10 + idx).padStart(2, '0')}` }),
    ),
  ];

  const collapsed = groupKanbanTasks(tasks, { doneExpanded: false });
  assert.deepEqual(collapsed.map((c) => c.status), ['todo', 'doing', 'blocked', 'done']);
  assert.deepEqual(collapsed[0].visibleTasks.map((t) => t.id), ['T-1', 'T-2']);
  assert.equal(collapsed[3].total, DONE_COLLAPSE_LIMIT + 2);
  assert.equal(collapsed[3].visibleTasks.length, DONE_COLLAPSE_LIMIT);
  assert.equal(collapsed[3].hiddenCount, 2);
  // Done column sorted descending by actualEnd
  assert.equal(collapsed[3].visibleTasks[0].id, `T-${10 + DONE_COLLAPSE_LIMIT + 1}`);

  const expanded = groupKanbanTasks(tasks, { doneExpanded: true });
  assert.equal(expanded[3].visibleTasks.length, DONE_COLLAPSE_LIMIT + 2);
  assert.equal(expanded[3].hiddenCount, 0);

  assert.equal(kanbanStatusTransition(tasks[0], 'todo'), null);
  assert.deepEqual(kanbanStatusTransition(tasks[0], 'doing'), { status: 'doing', progress: 10 });
  assert.deepEqual(kanbanStatusTransition(tasks[2], 'blocked'), { status: 'blocked', progress: 55 });
  assert.deepEqual(kanbanStatusTransition(tasks[4], 'blocked'), { status: 'blocked', progress: 90 });
  assert.deepEqual(kanbanStatusTransition(tasks[2], 'done'), { status: 'done', progress: 100 });
  assert.deepEqual(kanbanStatusTransition(tasks[4], 'todo'), { status: 'todo', progress: 0 });
});

test('T-84 unit: summarizePortfolioDetails, aggregatePortfolioActions, and toast diff helpers', () => {
  const project = { id: 'p1', name: '项目一' };
  const planData = {
    project: '项目一',
    milestones: [{ id: 'M1', name: 'M1', due: '2026-12-01' }],
    tasks: [
      sampleTask('T-1', 'doing', { end: '2026-11-26' }),
      sampleTask('T-2', 'todo', { end: '2026-11-27' }), // active claimed -> counted in doing + doing action
      sampleTask('T-3', 'blocked', { end: '2026-11-24' }),
      sampleTask('T-4', 'todo', { start: '2026-11-20', end: '2026-11-29' }), // ready
    ],
  };
  const now = Date.parse('2026-11-28T08:00:00.000Z');
  const claimsConfig = {
    version: 1,
    roster: [],
    claims: {
      'T-1': { taskId: 'T-1', actor: 'alice', actorKind: 'human', leaseId: 'l1', expiresAt: '2026-11-28T10:00:00.000Z' },
      'T-2': { taskId: 'T-2', actor: 'codex#1', actorKind: 'agent', leaseId: 'l2', expiresAt: '2026-11-28T09:00:00.000Z' },
      'T-3': { taskId: 'T-3', actor: 'claude-code', actorKind: 'agent', leaseId: 'l3', expiresAt: '2026-11-28T07:00:00.000Z' }, // stale -> not active
    },
    activityLog: [],
    auditLog: [],
  };

  const details = summarizePortfolioDetails(
    project,
    '2026-11-28',
    () => ({ data: planData }),
    () => claimsConfig,
    now,
  );
  assert.equal(details.doingCount, 2);
  assert.equal(details.activeAgentCount, 1);
  assert.deepEqual(details.actions.blocked.map((x) => x.id), ['T-3']);
  assert.deepEqual(details.actions.doing.map((x) => [x.id, x.claimedPending]), [['T-1', false], ['T-2', true]]);

  const merged = aggregatePortfolioActions([details.actions]);
  assert.equal(merged.blocked.length, 1);
  assert.equal(merged.doing.length, 2);
  assert.ok(merged.ready.some((x) => x.id === 'T-2') && merged.ready.some((x) => x.id === 'T-4'));

  // External diff helpers
  const taskToasts = diffExternalTaskUpdates(
    [sampleTask('T-1', 'doing'), sampleTask('T-2', 'doing')],
    [sampleTask('T-1', 'done'), sampleTask('T-2', 'blocked')],
  );
  assert.deepEqual(taskToasts.map((x) => [x.taskId, x.status]), [['T-1', 'done'], ['T-2', 'blocked']]);

  const claimToasts = diffExternalClaimUpdates(
    { 'T-1': { actor: 'codex#1', leaseId: 'l1', state: 'active' } },
    { 'T-2': { actor: 'antigravity', leaseId: 'l2', state: 'active' } },
    { 'T-1': '旧任务', 'T-2': '新任务' },
  );
  assert.equal(claimToasts.some((t) => t.title.includes('释放了 T-1')), true);
  assert.equal(claimToasts.some((t) => t.title.includes('antigravity 认领了 T-2')), true);
});

test('T-84 HTTP & portfolio-panel: GET /api/portfolio returns live counts + cross-project todayActions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'm12-portfolio-'));
  const projA = join(root, 'proj-a');
  await mkdir(join(projA, 'plan'), { recursive: true });
  await writeFile(join(projA, 'plan', 'plan.md'), [
    '---',
    'project: 旗舰驾驶舱',
    'milestones:',
    '  - id: M1',
    '    name: 第一阶段',
    '    due: 2026-12-10',
    'tasks:',
    '  - id: T-1',
    '    title: 核心开发',
    '    owner: antigravity',
    '    milestone: M1',
    '    start: 2026-11-20',
    '    end: 2026-11-29',
    '    deps: []',
    '    status: doing',
    '    progress: 50',
    '    actualStart: 2026-11-20',
    '    actualEnd: null',
    '  - id: T-2',
    '    title: 等待联调',
    '    owner: alice',
    '    milestone: M1',
    '    start: 2026-11-20',
    '    end: 2026-11-30',
    '    deps: []',
    '    status: blocked',
    '    progress: 10',
    '    actualStart: 2026-11-20',
    '    actualEnd: null',
    '---',
    '',
    '# 计划',
    '',
  ].join('\n'), 'utf8');

  const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
  await writeFile(join(projA, 'plan', 'claims.json'), JSON.stringify({
    version: 1,
    roster: [],
    claims: {
      'T-1': {
        taskId: 'T-1',
        actor: 'antigravity',
        actorKind: 'agent',
        leaseId: 'lease-m12-1',
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: futureExpiry,
        ttlMinutes: 30,
        note: '正在推进',
      },
    },
    activityLog: [],
    auditLog: [],
  }, null, 2));

  const socket = createServer();
  await new Promise((res) => socket.listen(0, '127.0.0.1', res));
  const port = socket.address().port;
  await new Promise((res) => socket.close(res));

  const child = spawn(process.execPath, ['server/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      TASK_COCKPIT_HOME: root,
      TASK_COCKPIT_PROJECT_ROOT: projA,
    },
  });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise((res) => child.once('exit', res));
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let res;
  for (let i = 0; i < 50; i++) {
    try { res = await fetch(`${base}/api/portfolio?today=2026-11-28`); break; } catch { await delay(100); }
  }
  assert.ok(res?.ok, 'server started');
  const snapshot = await res.json();
  assert.equal(snapshot.projects[0].doingCount, 1);
  assert.equal(snapshot.projects[0].activeAgentCount, 1);
  assert.equal(snapshot.todayActions.blocked.length, 1);
  assert.equal(snapshot.todayActions.doing.length, 1);

  // Verify portfolio-panel renders counts and cross-project action links
  const elements = new Map();
  const makeStub = (id) => ({ id, innerHTML: '', textContent: '', value: '', hidden: false, focus() {}, select() {}, addEventListener() {} });
  const origDoc = globalThis.document;
  const origFetch = globalThis.fetch;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeStub(id));
      return elements.get(id);
    },
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => snapshot });
  try {
    const panel = installPortfolio({ esc: (s) => String(s), syncProjects: () => {} });
    await panel.refresh('2026-11-28');
    const html = elements.get('portfolioBody').innerHTML;
    assert.match(html, /进行中 <strong>1<\/strong> 项 · 在岗 AI <strong>1<\/strong> 个/);
    assert.match(html, /跨项目今日行动/);
    assert.match(html, /\?project=default&amp;task=T-1#timeline/);
    assert.match(html, /\?project=default&amp;task=T-2#timeline/);
  } finally {
    globalThis.document = origDoc;
    globalThis.fetch = origFetch;
  }
});

test('T-83 & T-84 frontend: Kanban view switch, drag-drop, lock conflict, Time Machine readonly, and SSE external Toast', async () => {
  const elements = new Map();
  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => (force === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (force ? set.add(c) : set.delete(c))),
      contains: (c) => set.has(c),
    };
  };
  const makeModeBtn = (mode) => {
    const attrs = {};
    return {
      dataset: { timelineMode: mode },
      classList: makeClassList(),
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => attrs[k],
    };
  };
  const modeBtns = ['gantt', 'kanban'].map(makeModeBtn);

  const makeEl = (id) => {
    const listeners = {};
    let html = '';
    return {
      id,
      value: '',
      hidden: false,
      disabled: false,
      open: false,
      checked: false,
      textContent: '',
      dataset: {},
      style: {},
      options: [],
      classList: makeClassList(),
      closest() { return null; },
      focus() {},
      scrollIntoView() {},
      showModal() { this.open = true; },
      close() { this.open = false; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, ev = {}) {
        const event = { preventDefault() {}, target: this, ...ev };
        if (event.target && !event.target.closest) event.target.closest = () => null;
        return Promise.all((listeners[type] || []).map((fn) => fn(event)));
      },
      get innerHTML() { return html; },
      set innerHTML(v) { html = String(v); },
    };
  };

  const docListeners = {};
  globalThis.document = {
    body: { dataset: {}, classList: makeClassList() },
    documentElement: {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    querySelector() { return null; },
    querySelectorAll(sel) {
      if (sel === '#timelineModeSwitch [data-timeline-mode]') return modeBtns;
      return [];
    },
  };
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  globalThis.location = new URL('http://localhost:5173/?project=default');
  globalThis.history = { pushState() {}, replaceState() {} };
  globalThis.setInterval = () => 0;

  let activeEventSource = null;
  globalThis.EventSource = class {
    constructor() {
      this.listeners = {};
      activeEventSource = this;
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, data) { return Promise.all((this.listeners[type] || []).map((fn) => fn({ data }))); }
    close() {}
  };

  const plan = {
    project: 'M12看板演示',
    milestones: [{ id: 'M12', name: 'M12阶段', due: '2026-12-16' }],
    tasks: [
      sampleTask('T-1', 'todo'),
      sampleTask('T-2', 'doing', { progress: 60 }),
      sampleTask('T-3', 'blocked', { progress: 30 }),
      ...Array.from({ length: 7 }, (_, i) => sampleTask(`T-${10 + i}`, 'done')),
    ],
  };
  const claimsState = {
    projectId: 'default',
    today: '2026-11-28',
    now: '2026-11-28T08:00:00.000Z',
    roster: [],
    configuredRoster: [],
    claims: {
      'T-3': { taskId: 'T-3', actor: 'codex#1', actorKind: 'agent', leaseId: 'l3', state: 'active', remainingMinutes: 20 },
    },
    summary: { active: 1, stale: 0, orphaned: 0, done_pending_reconcile: 0 },
    activityLog: [],
    auditLog: [],
  };

  const taskPosts = [];
  let rejectT3Conflict = false;
  globalThis.fetch = async (url, opts = {}) => {
    if (url.startsWith('/api/task') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      taskPosts.push(body);
      if (rejectT3Conflict && body.id === 'T-3') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            ok: false,
            code: 'ACTIVE_CLAIM_CONFLICT',
            message: '任务当前正被其他执行人认领锁定',
            claim: { actor: 'codex#1' },
          }),
        };
      }
      const target = plan.tasks.find((t) => t.id === body.id);
      if (target) {
        target.status = body.status;
        target.progress = body.progress;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.startsWith('/api/plan')) {
      return { ok: true, json: async () => ({ projectId: 'default', data: structuredClone(plan), acceptanceByTask: {}, revision: 'rev-1', commits: {}, errors: [] }) };
    }
    if (url.startsWith('/api/claims')) return { ok: true, json: async () => structuredClone(claimsState) };
    if (url.startsWith('/api/owners')) return { ok: true, json: async () => ({ owners: [], roster: [] }) };
    if (url.startsWith('/api/projects')) return { ok: true, json: async () => ({ default: 'default', projects: [{ id: 'default', name: 'M12看板演示', health: 'yellow', overall: 70 }] }) };
    if (url.startsWith('/api/history')) {
      return {
        ok: true,
        json: async () => ({
          projectId: 'default',
          commits: [{ hash: 'c1', shortHash: 'c1', date: '2026-11-28', author: 'dev', subject: 'hist', overall: 70, doneCount: 7, taskCount: 10 }],
          frames: { c1: { data: structuredClone(plan), acceptanceByTask: {} } },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };

  await import(`../web/app.js?t=${Date.now() + 3}`);
  await new Promise((r) => setTimeout(r, 40));

  // 1. 切换到看板模式并验证列、已完成折叠/展开及视图持久化
  await elements.get('timelineModeSwitch').dispatch('click', {
    target: { closest: (sel) => (sel === '[data-timeline-mode]' ? { dataset: { timelineMode: 'kanban' } } : null) },
  });
  assert.equal(elements.get('gantt').hidden, true);
  assert.equal(elements.get('kanban').hidden, false);
  assert.equal(JSON.parse(storage.get('timeline.mode')), 'kanban');
  assert.match(elements.get('kanban').innerHTML, /展开其余 1 项已完成/);

  await elements.get('kanban').dispatch('click', {
    target: { closest: (sel) => (sel === '[data-kanban-done-toggle]' ? {} : null) },
  });
  assert.match(elements.get('kanban').innerHTML, /收起较早已完成/);

  // 2. 拖拽 T-1 从 todo 到 doing，验证 POST /api/task 参数与状态更新
  await elements.get('kanban').dispatch('dragstart', {
    target: { closest: (sel) => (sel === '[data-kanban-card]' ? { dataset: { kanbanCard: 'T-1' }, classList: makeClassList() } : null) },
    dataTransfer: { setData() {} },
  });
  await elements.get('kanban').dispatch('drop', {
    target: { closest: (sel) => (sel === '[data-kanban-col]' ? { dataset: { kanbanCol: 'doing' }, classList: makeClassList() } : null) },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(taskPosts.length, 1);
  assert.equal(taskPosts[0].id, 'T-1');
  assert.equal(taskPosts[0].status, 'doing');
  assert.equal(taskPosts[0].progress, 10);

  // 3. 认领锁冲突：拖 T-3 返回 409 时展示持锁人提示且不跳过校验
  rejectT3Conflict = true;
  await elements.get('kanban').dispatch('dragstart', {
    target: { closest: (sel) => (sel === '[data-kanban-card]' ? { dataset: { kanbanCard: 'T-3' }, classList: makeClassList() } : null) },
    dataTransfer: { setData() {} },
  });
  await elements.get('kanban').dispatch('drop', {
    target: { closest: (sel) => (sel === '[data-kanban-col]' ? { dataset: { kanbanCol: 'doing' }, classList: makeClassList() } : null) },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.match(elements.get('kanbanNotice').textContent, /codex#1/);

  // 4. SSE 外部变更 Toast 提醒：模拟超过本地写抑制窗口后的外部完成与外部认领
  // 推进时间等待本地抑制窗口或直接让外部更新发生在非抑制窗口：这里修改 Date.now 模拟经过 3s
  const realNow = Date.now;
  let clockOffset = 0;
  Date.now = () => realNow() + clockOffset;
  try {
    clockOffset = 3500;
    plan.tasks.find((t) => t.id === 'T-2').status = 'done';
    plan.tasks.find((t) => t.id === 'T-2').progress = 100;
    claimsState.claims['T-1'] = { taskId: 'T-1', actor: 'claude-code', actorKind: 'agent', leaseId: 'l-ext', state: 'active', remainingMinutes: 30 };
    await activeEventSource.emit('plan-change', 'changed');
    await new Promise((r) => setTimeout(r, 40));

    const toastHtml = elements.get('toastStack').innerHTML;
    assert.match(toastHtml, /T-2 已完成/);
    assert.match(toastHtml, /claude-code 认领了 T-1/);

    // 点击 Toast 定位按钮选中 T-2
    await elements.get('toastStack').dispatch('click', {
      target: { closest: (sel) => (sel === '[data-toast-locate]' ? { dataset: { toastLocate: 'T-2', toastDismiss: 'toast-1' } } : null) },
    });
    assert.match(elements.get('detail').innerHTML, /T-2/);
  } finally {
    Date.now = realNow;
  }

  // 5. 时间机器模式下看板卡片不可拖拽（draggable="false" 且 drop 无效）
  const clickDoc = (selector, target) => docListeners.click[0]({ target: { closest: (sel) => (sel === selector ? target : null) } });
  await clickDoc('[data-act]', { dataset: { act: 'toggle-time-machine' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.match(elements.get('kanban').innerHTML, /draggable="false"/);
  const countBeforeTmDrop = taskPosts.length;
  await elements.get('kanban').dispatch('drop', {
    target: { closest: (sel) => (sel === '[data-kanban-col]' ? { dataset: { kanbanCol: 'done' }, classList: makeClassList() } : null) },
    dataTransfer: { getData: () => 'T-1' },
  });
  assert.equal(taskPosts.length, countBeforeTmDrop);
});
