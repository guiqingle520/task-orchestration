import { test } from 'node:test';
import assert from 'node:assert/strict';

test('T-29: Time machine playback, read-only controls, and baseline ghost bar overlay', async (t) => {
  const saved = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    EventSource: globalThis.EventSource,
    setInterval: globalThis.setInterval,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
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
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = clearTimeout;

  globalThis.EventSource = class {
    constructor() {}
    addEventListener() {}
    close() {}
  };

  // 模拟历史版本 1 (初始提交: T-1 todo, T-2 计划 11-17 ~ 11-19)
  const commit1Plan = {
    project: 'task-orchestration',
    milestones: [{ id: 'M1', name: 'MVP', due: '2026-11-20' }],
    tasks: [
      { id: 'T-1', title: '基础规范', owner: 'planner', milestone: 'M1', start: '2026-11-17', end: '2026-11-17', deps: [], status: 'todo', progress: 0, actualStart: null, actualEnd: null },
      { id: 'T-2', title: '服务端开发', owner: 'dev', milestone: 'M1', start: '2026-11-17', end: '2026-11-19', deps: ['T-1'], status: 'todo', progress: 0, actualStart: null, actualEnd: null },
    ],
  };

  // 模拟当前最新版本 (T-1 done, T-2 排期推迟至 11-18 ~ 11-21)
  const currentPlan = {
    project: 'task-orchestration',
    milestones: [{ id: 'M1', name: 'MVP', due: '2026-11-20' }],
    tasks: [
      { id: 'T-1', title: '基础规范', owner: 'planner', milestone: 'M1', start: '2026-11-17', end: '2026-11-17', deps: [], status: 'done', progress: 100, actualStart: '2026-11-17', actualEnd: '2026-11-17' },
      { id: 'T-2', title: '服务端开发', owner: 'dev', milestone: 'M1', start: '2026-11-18', end: '2026-11-21', deps: ['T-1'], status: 'doing', progress: 40, actualStart: '2026-11-18', actualEnd: null },
    ],
  };

  const historyCommits = [
    { hash: '1111111', shortHash: '1111111', date: '2026-11-17', author: 'planner', subject: '初始计划', overall: 0, doneCount: 0, taskCount: 2 },
    { hash: '2222222', shortHash: '2222222', date: '2026-11-18', author: 'dev', subject: '完成 T-1 并调整 T-2 排期', overall: 65, doneCount: 1, taskCount: 2 },
  ];

  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    if (url.startsWith('/api/plan')) {
      return { ok: true, json: async () => ({ data: currentPlan, revision: 'rev-current', commits: {}, errors: [] }) };
    }
    if (url === '/api/projects') {
      return { ok: true, json: async () => ({ default: 'default', projects: [{ id: 'default', name: 'task-orchestration', health: 'green', overall: 65, taskCount: 2 }] }) };
    }
    if (url.startsWith('/api/history') && url.includes('rev=1111111')) {
      return { ok: true, json: async () => ({ projectId: 'default', commit: historyCommits[0], data: commit1Plan }) };
    }
    if (url.startsWith('/api/history') && url.includes('rev=2222222')) {
      return { ok: true, json: async () => ({ projectId: 'default', commit: historyCommits[1], data: currentPlan }) };
    }
    if (url.startsWith('/api/history')) {
      return { ok: true, json: async () => ({
        projectId: 'default', current: { revision: 'rev-current', date: '2026-11-18' }, commits: historyCommits,
        ...(url.includes('frames=1') ? { frames: { '1111111': { data: commit1Plan }, '2222222': { data: currentPlan } } } : {}),
      }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  await import(`../web/app.js?t=${Date.now()}`);
  await new Promise((r) => setTimeout(r, 20));

  // 1. 验证控制栏渲染了时间机器按钮与基线幽灵条选项
  assert.match(elements.get('timelineActions').innerHTML, /data-act="toggle-time-machine"/);
  assert.match(elements.get('timelineOptions').innerHTML, /id="showBaselineGhost"/);

  // 2. 点击「时间机器」按钮进入回放模式
  const click = (selector, target) => docListeners.click[0]({ target: { closest: (sel) => sel === selector ? target : null } });
  await click('[data-act]', { dataset: { act: 'toggle-time-machine' } });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(elements.get('timeMachineBar').hidden, false, 'time machine bar is displayed');
  assert.equal(elements.get('tmBanner').hidden, false, 'time machine banner is displayed');
  assert.match(elements.get('tmFrameInfo').innerHTML, /1111111/);
  assert.match(elements.get('tmBannerCommit').textContent, /初始计划/);
  assert.equal(elements.get('syncGit').disabled, true, 'syncGit is disabled in time machine mode');
  assert.equal(elements.get('plannerMode').disabled, true, 'plannerMode is disabled in time machine mode');

  // 验证在时间机器模式下任务详情不展示编辑按钮
  await click('[data-id]', { dataset: { id: 'T-1' } });
  assert.doesNotMatch(elements.get('detail').innerHTML, /data-edit-task/);

  // 3. 拖动时间滑块切换到帧 1 (第二帧)
  elements.get('tmSlider').value = 1;
  await elements.get('tmSlider').dispatch('input');
  await new Promise((r) => setTimeout(r, 20));

  assert.match(elements.get('tmFrameInfo').innerHTML, /2222222/);
  assert.match(elements.get('tmBannerCommit').textContent, /完成 T-1/);
  assert.equal(fetchCalls.some(url => url.includes('rev=')), false);

  // 4. 退出时间机器模式
  await elements.get('tmExit').dispatch('click');
  assert.equal(elements.get('timeMachineBar').hidden, true, 'time machine bar is hidden on exit');
  assert.equal(elements.get('tmBanner').hidden, true, 'time machine banner is hidden on exit');
  assert.equal(elements.get('syncGit').disabled, false, 'syncGit re-enabled after exit');

  // 5. 验证叠加基线幽灵条
  const ghostToggle = document.getElementById('showBaselineGhost');
  ghostToggle.checked = true;
  await docListeners.change[0]({ target: ghostToggle });
  await new Promise((r) => setTimeout(r, 50));

  assert.match(elements.get('gantt').innerHTML, /class="bar ghost"/);
  assert.match(elements.get('gantt').innerHTML, /ghost-badge red/);
  assert.match(elements.get('gantt').innerHTML, /\+2天/, 'shows +2 days schedule slip badge');
});
