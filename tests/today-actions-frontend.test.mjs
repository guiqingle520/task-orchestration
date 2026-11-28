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

  // 1. 初始渲染：T-1 在进行中与需跟进，T-3(现在可开工) 与 T-4(可提前开始) 在可开工，T-2 等待前置不入可开工，且无 +25% 按钮
  const doingHtml = elements.get('todayDoingList').innerHTML;
  const followHtml = elements.get('todayFollowList').innerHTML;
  const readyHtml = elements.get('todayReadyList').innerHTML;
  assert.match(doingHtml, /T-1 · 完成前置算法/);
  assert.match(doingHtml, /status-chip doing/);
  assert.match(doingHtml, /status-dot/);
  assert.match(doingHtml, /action-progress-bar/);
  assert.match(elements.get('kpis').innerHTML, /kpi-doing-pill/);
  assert.match(elements.get('kpis').innerHTML, /进行中 1/);
  assert.match(elements.get('gantt').innerHTML, /st-row-doing/);
  assert.match(elements.get('gantt').innerHTML, /st-act-doing/);
  assert.match(elements.get('gantt').innerHTML, /st-bar-todo/);
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

  // 2. 共用负责人筛选同时作用于「进行中」「需跟进」与「可开工」
  elements.get('todayActionOwner').value = 'antigravity';
  await elements.get('todayActionOwner').dispatch('change');
  assert.doesNotMatch(elements.get('todayDoingList').innerHTML, /T-1/);
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

test('T-70 & T-71: Multi-owner roster, step-by-step claim and copy with clipboard failure fallback, live claims panel, gantt claim badge, stale takeover and time machine isolation', async (t) => {
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
      readOnly: false,
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
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
  };
  globalThis.setInterval = () => 0;
  globalThis.EventSource = class {
    constructor() {}
    addEventListener() {}
    close() {}
  };

  let failClipboard = false;
  let copiedText = '';
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async writeText(text) {
          if (failClipboard) throw new Error('Clipboard permission denied');
          copiedText = text;
        },
      },
    },
  });

  const plan = {
    project: 'task-orchestration',
    milestones: [{ id: 'M9', name: '多负责人与多智能体协同', due: '2026-12-02' }],
    tasks: [
      { id: 'T-70', title: '分步认领与复制交互', owner: 'antigravity', milestone: 'M9', start: '2026-11-22', end: '2026-11-23', deps: [], status: 'todo', progress: 0, actualStart: null, actualEnd: null },
      { id: 'T-71', title: '在岗执行动态面板', owner: 'alice', milestone: 'M9', start: '2026-11-24', end: '2026-11-25', deps: [], status: 'doing', progress: 40, actualStart: '2026-11-22', actualEnd: null },
    ],
  };

  const orphanActor = '<orphan-marker data-test="literal">';
  const claimsState = {
    projectId: 'default',
    today: '2026-11-22',
    now: '2026-11-22T08:00:00.000Z',
    roster: [
      { id: 'antigravity', label: 'Antigravity', kind: 'agent', defaultTtlMinutes: 30 },
      { id: 'alice', label: 'Alice (前端负责人)', kind: 'human', defaultTtlMinutes: 480 },
      { id: 'claude-code', label: 'Claude Code', kind: 'agent', defaultTtlMinutes: 30 },
    ],
    configuredRoster: [
      { id: 'alice', label: 'Alice (前端负责人)', kind: 'human', defaultTtlMinutes: 480 },
      { id: 'claude-code', label: 'Claude Code', kind: 'agent', defaultTtlMinutes: 30 },
    ],
    claims: {
      'T-71': {
        taskId: 'T-71',
        leaseId: 'lease-stale-11112222',
        actor: 'codex#1',
        actorKind: 'agent',
        ownerSnapshot: 'alice',
        claimedAt: '2026-11-22T06:00:00.000Z',
        heartbeatAt: '2026-11-22T06:10:00.000Z',
        expiresAt: '2026-11-22T06:40:00.000Z',
        ttlMinutes: 30,
        note: '已完成静态布局草稿',
        state: 'stale',
        overdueMinutes: 80,
      },
      'T-999': {
        taskId: 'T-999',
        actor: orphanActor,
        leaseId: 'orphan-test-lease',
        expiresAt: '2026-11-22T08:30:00.000Z',
        state: 'orphaned',
      },
    },
    summary: { active: 0, stale: 1, orphaned: 1, done_pending_reconcile: 0 },
    activityLog: [
      { id: 'ev-1', at: '2026-11-22T06:00:00.000Z', type: 'claim', taskId: 'T-71', actor: 'codex#1', leaseId: 'lease-stale-11112222' },
    ],
    auditLog: [],
  };

  const historyCommits = [
    { hash: 'bbbb222', shortHash: 'bbbb222', date: '2026-11-20', author: 'codex', subject: 'M8 快照', overall: 100, doneCount: 2, taskCount: 2 },
  ];

  const claimPosts = [];
  const snapshotReads = { plan: 0, claims: 0 };
  globalThis.fetch = async (url, opts = {}) => {
    if (url.startsWith('/api/claims') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      claimPosts.push(body);
      if (body.action === 'heartbeat' && body.leaseId !== claimsState.claims[body.id]?.leaseId) {
        return { ok: false, status: 409, json: async () => ({ ok: false, code: 'LEASE_SUPERSEDED', message: '租约已被接管，请重新读取任务' }) };
      }
      if (body.action === 'claim') {
        const leaseId = body.takeoverStale ? 'lease-takeover-99998888' : 'lease-new-33334444';
        const claim = {
          taskId: body.id,
          leaseId,
          actor: body.actor,
          actorKind: body.actorKind || 'agent',
          ownerSnapshot: plan.tasks.find((x) => x.id === body.id)?.owner || 'dev',
          claimedAt: '2026-11-22T08:00:00.000Z',
          heartbeatAt: '2026-11-22T08:00:00.000Z',
          expiresAt: '2026-11-22T08:30:00.000Z',
          ttlMinutes: body.ttlMinutes || 30,
          note: body.note || '',
          state: 'active',
          remainingMinutes: body.ttlMinutes || 30,
        };
        claimsState.claims[body.id] = claim;
        claimsState.summary.active = Object.values(claimsState.claims).filter((c) => c.state === 'active').length;
        claimsState.summary.stale = Object.values(claimsState.claims).filter((c) => c.state === 'stale').length;
        if (body.takeoverStale) {
          claimsState.auditLog.push({ id: 'aud-1', at: '2026-11-22T08:01:00.000Z', type: 'takeover', taskId: body.id, actor: body.actor, previousActor: 'codex#1' });
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, claim, taskStarted: false }) };
      }
      if (body.action === 'roster' && body.cleanupOrphans) {
        delete claimsState.claims['T-999'];
        claimsState.summary.orphaned = 0;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.startsWith('/api/claims')) {
      snapshotReads.claims++;
      return { ok: true, status: 200, json: async () => structuredClone(claimsState) };
    }
    if (url.startsWith('/api/plan')) {
      snapshotReads.plan++;
      return { ok: true, json: async () => ({ data: structuredClone(plan), acceptanceByTask: { 'T-70': '分步反馈且不悄悄改状态' }, revision: 'rev-m9', commits: {}, errors: [] }) };
    }
    if (url === '/api/projects') {
      return { ok: true, json: async () => ({ default: 'default', projects: [{ id: 'default', name: 'task-orchestration', health: 'green', overall: 50, taskCount: 2 }] }) };
    }
    if (url.startsWith('/api/history')) {
      return { ok: true, json: async () => ({ projectId: 'default', commits: historyCommits, frames: { bbbb222: { data: structuredClone(plan), acceptanceByTask: {} } } }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  await import(`../web/app.js?t=${Date.now() + 1}`);
  await new Promise((r) => setTimeout(r, 40));

  // 1. 多负责人名录自动聚合（包含未分配任务但已在 roster 中的 claude-code 与人类负责人 alice）
  assert.match(elements.get('filterOwner').innerHTML, /claude-code/);
  assert.match(elements.get('todayActionOwner').innerHTML, /Alice \(前端负责人\)/);
  assert.match(elements.get('ownerRosterList').innerHTML, /value="claude-code"/);

  // 2. owner 与 actor 展示规则：T-70 待认领只显示单一负责人；T-71 跨人代领且超时并列显示「负责人：alice · ⚠️ 租约超时：codex#1」
  assert.match(elements.get('todayReadyList').innerHTML, /负责人：antigravity/);
  assert.match(elements.get('todayReadyList').innerHTML, /待认领/);
  assert.match(elements.get('gantt').innerHTML, /gantt-claim-badge stale/);
  assert.match(elements.get('claimsLiveBody').innerHTML, /计划负责人：alice · 执行人：<b>codex#1<\/b>/);
  assert.match(elements.get('claimsLiveBody').innerHTML, /已完成静态布局草稿/);

  // 3. 保留「仅复制说明（不改状态）」纯只读行为，再验证「认领并复制」在剪贴板失败时的分步提示
  const click = (selector, target) => docListeners.click[0]({ target: { closest: (sel) => (sel === selector ? target : null) } });
  await click('[data-follow-task]', { dataset: { followTask: 'T-71' } });
  const detail = () => elements.get('detail').innerHTML;
  assert.match(detail(), /首次认领时间 <time datetime="2026-11-22T06:00:00.000Z">/);
  assert.match(detail(), /最后心跳时间 <time datetime="2026-11-22T06:10:00.000Z">/);
  assert.match(detail(), /到期时间 <time datetime="2026-11-22T06:40:00.000Z">/);
  await click('[data-handoff-task]', { dataset: { handoffTask: 'T-70' } });
  assert.equal(elements.get('handoffDialog').open, true);
  await elements.get('copyHandoffBtn').dispatch('click');
  assert.equal(claimPosts.length, 0, 'pure copyHandoffBtn never triggers claim API');
  assert.match(elements.get('handoffCopyStatus').textContent, /任务状态与认领锁均未改动/);

  // 模拟认领成功但剪贴板失败：必须明确提示「已认领成功，但复制失败」并更新文本框包含新 leaseId
  failClipboard = true;
  elements.get('handoffActor').value = 'antigravity';
  elements.get('handoffNote').value = '正在编写 T-70 单测';
  await elements.get('claimAndCopyHandoffBtn').dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(claimPosts.length, 1);
  assert.equal(claimPosts[0].actor, 'antigravity');
  assert.equal(claimPosts[0].startImmediately, false);
  assert.match(elements.get('handoffText').value, /lease-new-33334444/);
  assert.match(elements.get('handoffCopyStatus').textContent, /已由 antigravity 认领成功.*但复制失败/);
  failClipboard = false;

  // 同 owner 与 actor 认领后合并显示「antigravity 执行中」
  assert.match(elements.get('todayReadyList').innerHTML, /antigravity 执行中（剩余 30m）/);
  assert.match(elements.get('gantt').innerHTML, /🔒 antigravity/);

  // 4. 超时租约接管二次确认交互（T-71）
  await click('[data-claim-op]', { dataset: { claimOp: 'takeover', claimTask: 'T-71' } });
  assert.equal(elements.get('claimActionDialog').open, true);
  elements.get('claimActionActor').value = 'alice';
  await elements.get('claimActionActor').dispatch('input');
  assert.equal(elements.get('claimActionKind').value, 'human');
  assert.equal(elements.get('claimActionTtl').value, 480);
  // 未勾选确认接管时拦截
  await elements.get('claimActionForm').dispatch('submit');
  assert.equal(claimPosts.length, 1);
  assert.match(elements.get('claimActionStatus').textContent, /请先勾选确认接管/);
  // 勾选后成功接管并生成新 leaseId，记入审计日志
  elements.get('claimActionTakeoverConfirm').checked = true;
  await elements.get('claimActionForm').dispatch('submit');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(claimPosts.length, 2);
  assert.equal(claimPosts[1].takeoverStale, true);
  assert.equal(claimPosts[1].expectedLeaseId, 'lease-stale-11112222');

  // GUIQ-27 B10: Switching event feeds or refreshing their data keeps the disclosure state.
  const eventDetails = elements.get('claimsLiveEvents');
  const eventList = elements.get('claimsLiveEventList');
  assert.equal(eventDetails.hidden, false);
  eventDetails.open = true;
  await click('[data-event-tab]', { dataset: { eventTab: 'audit' } });
  assert.equal(eventDetails.open, true);
  assert.match(eventList.innerHTML, /超时确认接管/);
  claimsState.auditLog.push({ id: 'aud-2', at: '2026-11-22T08:02:00.000Z', type: 'force_release', taskId: 'T-71', actor: 'alice', reason: '新的审计记录' });
  await elements.get('refreshClaimsBtn').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventDetails.open, true);
  assert.match(eventList.innerHTML, /新的审计记录/);
  await click('[data-event-tab]', { dataset: { eventTab: 'activity' } });
  assert.equal(eventDetails.open, true);
  assert.doesNotMatch(eventList.innerHTML, /新的审计记录/);
  eventDetails.open = false;
  await elements.get('refreshClaimsBtn').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventDetails.open, false);

  // GUIQ-27 B09: Opening a handoff or changing its actor never confirms a takeover.
  Object.assign(claimsState.claims['T-71'], { state: 'stale', actor: 'codex#2', leaseId: 'handoff-expired-1' });
  claimsState.summary.stale = 1;
  await elements.get('refreshClaimsBtn').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  await click('[data-handoff-task]', { dataset: { handoffTask: 'T-71' } });
  const handoffActor = elements.get('handoffActor');
  const handoffConfirmation = elements.get('handoffTakeoverStale');
  const claimAndCopy = () => elements.get('claimAndCopyHandoffBtn').dispatch('click');
  assert.equal(elements.get('handoffTakeoverRow').hidden, false);
  assert.equal(handoffConfirmation.checked, false);
  handoffActor.value = 'antigravity';
  await handoffActor.dispatch('input');
  await claimAndCopy();
  assert.equal(claimPosts.length, 2);
  assert.match(elements.get('handoffCopyStatus').textContent, /请勾选/);
  handoffConfirmation.checked = true;
  handoffActor.value = 'alice';
  await handoffActor.dispatch('input');
  assert.equal(handoffConfirmation.checked, false);
  handoffConfirmation.checked = true;
  claimsState.claims['T-71'].leaseId = 'handoff-expired-2';
  await elements.get('refreshClaimsBtn').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handoffConfirmation.checked, false);
  await claimAndCopy();
  assert.equal(claimPosts.length, 2);
  handoffConfirmation.checked = true;
  await claimAndCopy();
  assert.equal(claimPosts.length, 3);
  assert.equal(claimPosts[2].takeoverStale, true);
  assert.equal(claimPosts[2].expectedLeaseId, 'handoff-expired-2');
  assert.match(copiedText, /lease-takeover-99998888/);
  await elements.get('closeHandoff').dispatch('click');

  // GUIQ-27 B14: A superseded heartbeat refreshes both snapshots without an SSE event.
  await click('[data-claim-op]', { dataset: { claimOp: 'heartbeat', claimTask: 'T-71' } });
  plan.tasks[1].title = '已从权威计划重读';
  Object.assign(claimsState.claims['T-71'], {
    actor: 'codex#3', leaseId: 'external-new-lease', claimedAt: '2026-11-22T08:12:00.000Z',
    heartbeatAt: '2026-11-22T08:15:00.000Z', expiresAt: '2026-11-22T08:45:00.000Z',
  });
  const readsBeforeConflict = { ...snapshotReads };
  await elements.get('claimActionForm').dispatch('submit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements.get('claimActionStatus').textContent, /租约已被接管/);
  assert.deepEqual(snapshotReads, { plan: readsBeforeConflict.plan + 1, claims: readsBeforeConflict.claims + 1 });
  assert.match(detail(), /已从权威计划重读/);
  assert.match(detail(), /codex#3/);
  assert.match(detail(), /首次认领时间 <time datetime="2026-11-22T08:12:00.000Z">/);
  assert.match(detail(), /最后心跳时间 <time datetime="2026-11-22T08:15:00.000Z">/);
  assert.match(detail(), /到期时间 <time datetime="2026-11-22T08:45:00.000Z">/);
  await elements.get('closeClaimAction').dispatch('click');

  // T-72: A deleted task appears in the orphan warning only and cannot expose task actions.
  const liveBody = () => elements.get('claimsLiveBody').innerHTML;
  assert.match(elements.get('claimsLiveNotice').textContent, /孤儿租约 1 项/);
  assert.match(liveBody(), /T-999（&lt;orphan-marker data-test=&quot;literal&quot;&gt;）/);
  assert.equal(liveBody().includes(orphanActor), false);
  assert.doesNotMatch(liveBody(), /data-(?:claim|follow)-task="T-999"/);
  assert.doesNotMatch(elements.get('gantt').innerHTML, /T-999/);
  await click('[data-cleanup-orphans]', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(claimPosts.at(-1), { action: 'roster', cleanupOrphans: true });
  assert.doesNotMatch(liveBody(), /T-999|data-cleanup-orphans/);
  assert.match(liveBody(), /Alice \(前端负责人\)/);

  // 5. 时间机器历史回放模式下隐藏实时认领并明确标注
  await click('[data-act]', { dataset: { act: 'toggle-time-machine' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.match(elements.get('claimsLiveNotice').textContent, /历史回放，不显示实时认领/);
  assert.equal(eventDetails.hidden, true);
  assert.doesNotMatch(elements.get('gantt').innerHTML, /gantt-claim-badge/);
});
