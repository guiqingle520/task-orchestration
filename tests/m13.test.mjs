import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildTeamOverview, normalizeTeamConfig, readTeamConfig, TeamConfigError, writeTeamConfig } from '../server/team.mjs';
import { installTeamPanel } from '../web/team-panel.js';
import { installOwnerPanel } from '../web/owner-panel.js';

function makeTask(id, owner, start, end, extra = {}) {
  return {
    id,
    title: `任务 ${id}`,
    owner,
    milestone: 'M1',
    start,
    end,
    deps: [],
    status: 'todo',
    progress: 0,
    actualStart: null,
    actualEnd: null,
    ...extra,
  };
}

test('T-85 unit: team config validation & persistence + cross-project collision & standup aggregation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'm13-team-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(readTeamConfig(root), { version: 1, members: [] });
  assert.throws(() => normalizeTeamConfig({
    members: [
      { id: '林晓', aliases: ['linxiao'] },
      { id: 'bob', aliases: ['linxiao'] },
    ],
  }), TeamConfigError);

  const saved = writeTeamConfig(root, {
    members: [
      { id: '林晓', label: '林晓 (前端)', group: '前端', kind: 'human', dailyLimit: 2, defaultTtlMinutes: 480, aliases: ['linxiao'] },
      { id: '张伟', label: '张伟 (后端)', group: '后端', kind: 'human', dailyLimit: 2 },
      { id: 'codex#1', label: 'codex#1', group: 'AI 军团', kind: 'agent', dailyLimit: 1, defaultTtlMinutes: 30 },
    ],
  });
  assert.equal(saved.members.length, 3);
  assert.equal(readTeamConfig(root).members[0].aliases[0], 'linxiao');

  const today = '2026-11-28';
  const now = Date.parse('2026-11-28T08:00:00.000Z');
  const futureExp = '2026-11-28T10:00:00.000Z';

  const projA = { id: 'proj-a', name: '支付中台' };
  const projB = { id: 'proj-b', name: '商城改版' };
  const planA = {
    project: '支付中台',
    milestones: [{ id: 'M1', name: 'M1', due: '2026-12-05' }],
    tasks: [
      makeTask('T-1', '林晓', '2026-11-27', '2026-11-30', { status: 'doing', progress: 50, actualStart: '2026-11-27' }),
      makeTask('T-2', '林晓', '2026-11-28', '2026-11-29', { status: 'blocked', progress: 20, actualStart: '2026-11-28' }),
      makeTask('T-3', '林晓', '2026-11-20', '2026-11-27', { status: 'done', progress: 100, actualStart: '2026-11-20', actualEnd: '2026-11-27' }), // yesterday -> recentDone
      makeTask('T-4', '林晓', '2026-11-10', '2026-11-15', { status: 'done', progress: 100, actualStart: '2026-11-10', actualEnd: '2026-11-15' }), // older -> not recentDone
      makeTask('T-5', '张伟', '2026-11-28', '2026-11-30', { status: 'doing', progress: 40, actualStart: '2026-11-28' }),
      makeTask('T-6', '张伟', '2026-11-28', '2026-11-29', { status: 'todo' }), // ready
    ],
  };
  const planB = {
    project: '商城改版',
    milestones: [{ id: 'M1', name: 'M1', due: '2026-12-05' }],
    tasks: [
      // Alias 'linxiao' merges with '林晓' -> 3 overlapping tasks on 2026-11-28..2026-11-29 -> exceeds dailyLimit 2 -> collision!
      makeTask('T-11', 'linxiao', '2026-11-28', '2026-11-30', { status: 'doing', progress: 30, actualStart: '2026-11-28' }),
      // '张伟' has 1 task in projA (doing) + 1 in projB (todo) overlapping 2026-11-28 -> multi-project (2 <= dailyLimit 2)
      makeTask('T-12', '张伟', '2026-11-28', '2026-11-29', { status: 'todo' }),
      // Active claimed by codex#1 across projA and projB -> collision for agent (limit 1)
      makeTask('T-13', '张伟', '2026-11-28', '2026-11-29', { status: 'doing', progress: 10, actualStart: '2026-11-28' }),
    ],
  };

  const claimsB = {
    version: 1,
    roster: [],
    claims: {
      'T-12': { taskId: 'T-12', actor: 'codex#1', actorKind: 'agent', leaseId: 'lc1', expiresAt: futureExp },
      'T-13': { taskId: 'T-13', actor: 'codex#1', actorKind: 'agent', leaseId: 'lc2', expiresAt: futureExp },
    },
    activityLog: [],
    auditLog: [],
  };

  const overview = buildTeamOverview({
    today,
    projects: [projA, projB],
    readSnapshot: (p) => ({ data: p.id === 'proj-a' ? planA : planB }),
    readClaimsFn: (p) => (p.id === 'proj-b' ? claimsB : { version: 1, roster: [], claims: {}, activityLog: [], auditLog: [] }),
    readOwnersFn: () => ({ owners: [] }),
    teamConfig: saved,
    now,
  });

  assert.equal(overview.weeks.length, 4);
  assert.deepEqual(overview.groups, ['后端', '前端', 'AI 军团']);
  assert.equal(overview.summary.activeAgentCount, 1);

  const linxiao = overview.members.find((m) => m.id === '林晓');
  assert.equal(linxiao.loadState, 'collision');
  assert.equal(linxiao.maxPeak, 3);
  assert.equal(linxiao.projectCount, 2);
  assert.equal(linxiao.doingCount, 2);
  assert.equal(linxiao.blockedCount, 1);
  assert.equal(linxiao.recentDoneCount, 1);
  assert.equal(linxiao.collisions[0].overloaded, true);

  const codex = overview.members.find((m) => m.id === 'codex#1');
  assert.equal(codex.loadState, 'collision');
  assert.equal(codex.maxPeak, 2);
  assert.equal(codex.doingCount, 2); // T-12 (claimedPending) + T-13

  const zhangwei = overview.members.find((m) => m.id === '张伟');
  assert.equal(zhangwei.loadState, 'normal'); // T-12 & T-13 were actively claimed by codex#1, leaving 张伟 with T-5 & T-6 in projA
  assert.equal(zhangwei.readyCount, 1);
});

test('T-85 & T-87 HTTP API: /api/team and /api/team/overview work end-to-end', async t => {
  const root = await mkdtemp(join(tmpdir(), 'm13-http-'));
  const projA = join(root, 'proj-a');
  await mkdir(join(projA, 'plan'), { recursive: true });
  await writeFile(join(projA, 'plan', 'plan.md'), [
    '---',
    'project: 团队演示项目',
    'milestones:',
    '  - id: M1',
    '    name: 第一阶段',
    '    due: 2026-12-10',
    'tasks:',
    '  - id: T-1',
    '    title: 核心开发',
    '    owner: alice',
    '    milestone: M1',
    '    start: 2026-11-27',
    '    end: 2026-11-30',
    '    deps: []',
    '    status: doing',
    '    progress: 50',
    '    actualStart: 2026-11-27',
    '    actualEnd: null',
    '---',
    '',
    '# 计划',
    '',
  ].join('\n'), 'utf8');

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
  let ready;
  for (let i = 0; i < 50; i++) {
    try { ready = await fetch(`${base}/api/team`); break; } catch { await delay(100); }
  }
  assert.ok(ready?.ok, 'server started');
  assert.deepEqual(await ready.json(), { version: 1, members: [] });

  const saveRes = await fetch(`${base}/api/team`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      members: [{ id: 'alice', label: 'Alice', group: '前端', kind: 'human', dailyLimit: 2, defaultTtlMinutes: 480, aliases: [] }],
    }),
  });
  assert.equal(saveRes.status, 200);
  assert.equal((await saveRes.json()).members.length, 1);

  const badDate = await fetch(`${base}/api/team/overview?today=2026-99-99`);
  assert.equal(badDate.status, 400);

  const ovRes = await fetch(`${base}/api/team/overview?today=2026-11-28`);
  assert.equal(ovRes.status, 200);
  const ov = await ovRes.json();
  assert.equal(ov.summary.memberCount, 1);
  assert.equal(ov.members[0].doingCount, 1);
  assert.equal(ov.members[0].group, '前端');
});

test('T-86 & T-87 frontend: team-panel renders load heatmap, collision details, standup cards & owner-panel imports from global team', async () => {
  const elements = new Map();
  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, f) => (f === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (f ? set.add(c) : set.delete(c))),
      contains: (c) => set.has(c),
    };
  };
  const makeBtn = (dataset = {}) => ({
    dataset,
    classList: makeClassList(),
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
  });
  const presetBtns = ['all', 'human', 'agent', 'risk'].map((p) => makeBtn({ teamPreset: p }));
  const makeStub = (id) => {
    const listeners = {};
    return {
      id,
      innerHTML: '',
      textContent: '',
      value: '',
      hidden: false,
      disabled: false,
      open: false,
      dataset: {},
      classList: makeClassList(),
      closest() { return null; },
      focus() {},
      showModal() { this.open = true; },
      close() { this.open = false; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, ev = {}) {
        const event = { preventDefault() {}, target: this, ...ev };
        if (event.target && !event.target.closest) event.target.closest = () => null;
        return Promise.all((listeners[type] || []).map((fn) => fn(event)));
      },
    };
  };

  const origDoc = globalThis.document;
  const origFetch = globalThis.fetch;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeStub(id));
      return elements.get(id);
    },
    querySelectorAll(sel) {
      if (sel === '#teamPresetFilters [data-team-preset]') return presetBtns;
      return [];
    },
  };

  const mockOverview = {
    today: '2026-11-28',
    weeks: [{ id: 'W1', label: '本周 (11-23)' }],
    groups: ['前端', 'AI 军团'],
    summary: { memberCount: 2, collisionCount: 1, multiProjectCount: 0, activeAgentCount: 1, totalDoing: 2, totalBlocked: 0 },
    members: [
      {
        id: '林晓', label: '林晓 (前端)', group: '前端', kind: 'human', dailyLimit: 2, defaultTtlMinutes: 480, aliases: [],
        projectCount: 2, doingCount: 1, activeClaimCount: 0, blockedCount: 0, recentDoneCount: 0, readyCount: 0,
        maxPeak: 3, multiProjectDays: 2, overloadedDays: 2, loadState: 'collision',
        weekly: [{ id: 'W1', peak: 3, overloaded: true, multiProject: true }],
        collisions: [{ date: '2026-11-28', count: 3, projectCount: 2, overloaded: true, tasks: [{ projectId: 'p1', projectName: '项目A', id: 'T-1', title: '任务1', status: 'doing' }] }],
        standup: {
          doing: [{ projectId: 'p1', projectName: '项目A', id: 'T-1', title: '任务1', progress: 50, end: '2026-11-29', claim: null, claimedPending: false }],
          blocked: [], recentDone: [], ready: [],
        },
      },
      {
        id: 'codex#1', label: 'codex#1', group: 'AI 军团', kind: 'agent', dailyLimit: 1, defaultTtlMinutes: 30, aliases: [],
        projectCount: 1, doingCount: 1, activeClaimCount: 1, blockedCount: 0, recentDoneCount: 0, readyCount: 0,
        maxPeak: 1, multiProjectDays: 0, overloadedDays: 0, loadState: 'normal',
        weekly: [{ id: 'W1', peak: 1, overloaded: false, multiProject: false }],
        collisions: [],
        standup: {
          doing: [{ projectId: 'p2', projectName: '项目B', id: 'T-9', title: 'AI任务', progress: 10, end: '2026-11-30', claim: { actor: 'codex#1', state: 'active', remainingMinutes: 25 }, claimedPending: false }],
          blocked: [], recentDone: [], ready: [],
        },
      },
    ],
  };

  const posts = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (opts.method === 'POST') posts.push({ url, body });
    if (url.startsWith('/api/team/overview')) return { ok: true, json: async () => mockOverview };
    if (url === '/api/team') {
      return {
        ok: true,
        json: async () => ({
          version: 1,
          members: [
            { id: '林晓', label: '林晓 (前端)', group: '前端', kind: 'human', dailyLimit: 2, defaultTtlMinutes: 480, aliases: [] },
            { id: 'codex#1', label: 'codex#1', group: 'AI 军团', kind: 'agent', dailyLimit: 1, defaultTtlMinutes: 30, aliases: [] },
          ],
        }),
      };
    }
    if (url.startsWith('/api/owners') && !opts.method) return { ok: true, json: async () => ({ owners: [], roster: [] }) };
    if (url.startsWith('/api/claims') && !opts.method) return { ok: true, json: async () => ({ configuredRoster: [] }) };
    if (url.startsWith('/api/owners') && opts.method === 'POST') return { ok: true, json: async () => ({ ok: true, owners: body.owners.map((o) => ({ ...o, inRoster: true, taskCount: 0, openTaskCount: 0 })), roster: body.owners }) };
    if (url.startsWith('/api/claims') && opts.method === 'POST') return { ok: true, json: async () => ({ ok: true, roster: body.roster }) };
    return { ok: true, json: async () => ({}) };
  };

  try {
    const teamPanel = installTeamPanel({ esc: (s) => String(s) });
    await teamPanel.refresh('2026-11-28');
    const body = () => elements.get('teamBody').innerHTML;
    assert.match(body(), /撞车预警/);
    assert.match(body(), /team-matrix-table/);
    assert.match(body(), /林晓 \(前端\)/);
    assert.match(body(), /codex#1/);

    // 切换列表视图与矩阵视图
    await elements.get('teamBody').dispatch('click', {
      target: { closest: (sel) => (sel === '[data-standup-mode]' ? { dataset: { standupMode: 'list' } } : null) },
    });
    assert.match(body(), /team-standup-list/);
    await elements.get('teamBody').dispatch('click', {
      target: { closest: (sel) => (sel === '[data-standup-mode]' ? { dataset: { standupMode: 'matrix' } } : null) },
    });
    assert.match(body(), /team-matrix-table/);

    // 展开撞车明细
    await elements.get('teamBody').dispatch('click', {
      target: { closest: (sel) => (sel === '[data-team-collision]' ? { dataset: { teamCollision: '林晓' } } : null) },
    });
    assert.match(body(), /跨项目排期撞车明细/);
    assert.match(body(), /\?project=p1&amp;task=T-1#timeline/);

    // 按 AI 智能体过滤
    await elements.get('teamPresetFilters').dispatch('click', {
      target: { closest: (sel) => (sel === '[data-team-preset]' ? { dataset: { teamPreset: 'agent' } } : null) },
    });
    assert.doesNotMatch(body(), /林晓 \(前端\)/);
    assert.match(body(), /codex#1/);

    // 验证单项目 ownerPanel 一键从全局团队导入
    const $ = (id) => document.getElementById(id);
    let changedCalls = 0;
    installOwnerPanel($, {
      apiUrl: (p) => `${p}?project=default`,
      getProject: () => ({ projectId: 'default', epoch: 1, data: { tasks: [] }, revision: 'rev-1' }),
      onRename: async () => {},
      onChanged: async () => { changedCalls++; },
    });
    await $('manageOwnersBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 20));
    await $('importFromTeamBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 20));

    const ownersImport = posts.find((p) => p.url.startsWith('/api/owners'));
    const claimsImport = posts.find((p) => p.url.startsWith('/api/claims'));
    assert.equal(ownersImport.body.owners.length, 2);
    assert.equal(claimsImport.body.action, 'roster');
    assert.equal(claimsImport.body.roster.length, 2);
    assert.equal(changedCalls, 1);
  } finally {
    globalThis.document = origDoc;
    globalThis.fetch = origFetch;
  }
});
