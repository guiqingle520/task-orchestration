import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installOwnerPanel } from '../web/owner-panel.js';
import { installPortfolio } from '../web/portfolio-panel.js';

function samplePlan(projectName, id = 'T-1') {
  return [
    '---',
    `project: ${projectName}`,
    'milestones:',
    '  - id: M1',
    '    name: 第一阶段',
    '    due: 2026-12-10',
    'tasks:',
    `  - id: ${id}`,
    '    title: 核心开发',
    '    owner: alice',
    '    milestone: M1',
    '    start: 2026-11-20',
    '    end: 2026-11-25',
    '    deps: []',
    '    status: todo',
    '    progress: 0',
    '    actualStart: null',
    '    actualEnd: null',
    '---',
    '',
    '# 计划',
    '',
  ].join('\n');
}

test('T-82 HTTP API: setDefault and remove project endpoints preserve disk files and protect last project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'm11-workspaces-'));
  const projA = join(root, 'proj-a');
  const projB = join(root, 'proj-b');
  await mkdir(join(projA, 'plan'), { recursive: true });
  await mkdir(join(projB, 'plan'), { recursive: true });
  const planA = samplePlan('项目A', 'T-1');
  const planB = samplePlan('项目B', 'T-2');
  await writeFile(join(projA, 'plan', 'plan.md'), planA, 'utf8');
  await writeFile(join(projB, 'plan', 'plan.md'), planB, 'utf8');

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
    try { ready = await fetch(`${base}/api/projects`); break; } catch { await delay(100); }
  }
  assert.ok(ready?.ok, 'server started');

  const pre = await (await fetch(`${base}/api/projects/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoRoot: projB }),
  })).json();
  assert.equal(pre.state, 'valid');

  const added = await (await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoRoot: projB, name: pre.name, id: pre.id, previewId: pre.previewId }),
  })).json();
  assert.equal(added.ok, true);
  const list = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(list.projects.length, 2);

  // 设置 proj-b 为默认
  const defRes = await fetch(`${base}/api/projects/default`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: pre.id }),
  });
  assert.equal(defRes.status, 200);
  const defBody = await defRes.json();
  assert.equal(defBody.default, pre.id);

  // 通过 DELETE /api/projects 移除默认项目 proj-b，回退默认到 default 且不删除磁盘文件
  const delRes = await fetch(`${base}/api/projects?id=${encodeURIComponent(pre.id)}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  const delBody = await delRes.json();
  assert.equal(delBody.default, 'default');
  assert.equal(delBody.projects.length, 1);
  assert.equal(existsSync(join(projB, 'plan', 'plan.md')), true);
  assert.equal(await readFile(join(projB, 'plan', 'plan.md'), 'utf8'), planB);

  // 禁止移除最后一个项目
  const lastRes = await fetch(`${base}/api/projects/remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'default' }),
  });
  assert.equal(lastRes.status, 400);
  assert.match((await lastRes.json()).message, /最后一个项目/);
});

test('T-81 unified owner-panel synchronizes both /api/owners and /api/claims roster', async () => {
  const elements = new Map();
  const makeEl = (id) => {
    const listeners = {};
    return {
      id,
      value: '',
      hidden: false,
      disabled: false,
      open: false,
      innerHTML: '',
      textContent: '',
      dataset: {},
      closest() { return null; },
      focus() {},
      showModal() { this.open = true; },
      close() { this.open = false; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, ev = {}) {
        const event = { preventDefault() {}, target: this, ...ev };
        return Promise.all((listeners[type] || []).map((fn) => fn(event)));
      },
    };
  };
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  const calls = [];
  let onChangedCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method || 'GET', body });
    if (url.startsWith('/api/owners') && !opts.method) {
      return { ok: true, json: async () => ({ owners: [{ name: 'alice', role: '前端', active: true, openTaskCount: 1, taskCount: 1 }], roster: [{ name: 'alice', role: '前端', active: true }] }) };
    }
    if (url.startsWith('/api/claims') && !opts.method) {
      return { ok: true, json: async () => ({ configuredRoster: [{ id: 'alice', label: 'alice (前端)', kind: 'human', defaultTtlMinutes: 480 }] }) };
    }
    if (url.startsWith('/api/owners') && opts.method === 'POST') {
      return { ok: true, json: async () => ({ ok: true, owners: [], roster: body.owners }) };
    }
    if (url.startsWith('/api/claims') && opts.method === 'POST') {
      return { ok: true, json: async () => ({ ok: true, roster: body.roster }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  try {
    installOwnerPanel($, {
      apiUrl: (p) => `${p}?project=default`,
      getProject: () => ({ projectId: 'default', epoch: 1, data: { tasks: [] }, revision: 'rev-1' }),
      onRename: async () => {},
      onChanged: async () => { onChangedCalls++; },
    });

    await $('manageOwnersBtn').dispatch('click');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal($('ownersDialog').open, true);
    assert.match($('ownersList').innerHTML, /alice/);

    // 打开新增成员编辑器，自动推断 agent 类型与默认 30m 租约
    await $('addOwnerBtn').dispatch('click');
    assert.equal($('ownerEditDialog').open, true);
    $('ownerName').value = 'codex#2';
    await $('ownerName').dispatch('input');
    assert.equal($('ownerKind').value, 'agent');
    assert.equal(String($('ownerTtl').value), '30');

    $('ownerRole').value = '自动执行';
    await $('ownerEditForm').dispatch('submit');
    await new Promise((r) => setTimeout(r, 20));

    const ownersPost = calls.find((c) => c.url.startsWith('/api/owners') && c.method === 'POST');
    const claimsPost = calls.find((c) => c.url.startsWith('/api/claims') && c.method === 'POST');
    assert.ok(ownersPost);
    assert.equal(ownersPost.body.owners.length, 2);
    assert.ok(claimsPost);
    assert.equal(claimsPost.body.action, 'roster');
    assert.deepEqual(
      claimsPost.body.roster.find((r) => r.id === 'codex#2'),
      { id: 'codex#2', label: 'codex#2 (自动执行)', kind: 'agent', defaultTtlMinutes: 30 },
    );
    assert.equal(onChangedCalls, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('T-82 portfolio-panel renders set-default and remove controls and updates registry', async () => {
  const elements = new Map();
  const makeStub = (id) => {
    const listeners = {};
    return {
      id,
      innerHTML: '',
      textContent: '',
      value: '',
      hidden: false,
      focus() {},
      select() {},
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatch(type, ev = {}) {
        const event = { preventDefault() {}, target: this, ...ev };
        return Promise.all((listeners[type] || []).map((fn) => fn(event)));
      },
    };
  };
  const origDoc = globalThis.document;
  const origFetch = globalThis.fetch;
  const origConfirm = globalThis.confirm;
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeStub(id));
      return elements.get(id);
    },
  };
  let removedId = null;
  let defaultId = 'default';
  const changed = [];
  globalThis.confirm = () => true;
  globalThis.fetch = async (url, opts = {}) => {
    if (url.startsWith('/api/portfolio')) {
      return {
        ok: true,
        json: async () => ({
          generatedAt: '2026-11-28T00:00:00.000Z',
          today: '2026-11-28',
          default: defaultId,
          projects: [
            { id: 'default', name: '项目A', health: 'green', available: true, taskCount: 2, doneCount: 1, blockedCount: 0, overdueCount: 0, overall: 50, today: '2026-11-28', nextMilestone: null, activeRiskCount: 0, error: null },
            { id: 'proj-b', name: '项目B', health: 'yellow', available: true, taskCount: 3, doneCount: 1, blockedCount: 0, overdueCount: 1, overall: 33, today: '2026-11-28', nextMilestone: null, activeRiskCount: 1, error: null },
          ].filter((p) => p.id !== removedId),
        }),
      };
    }
    if (url === '/api/projects/default') {
      defaultId = JSON.parse(opts.body).id;
      return { ok: true, json: async () => ({ default: defaultId, projects: [{ id: 'default', name: '项目A' }, { id: 'proj-b', name: '项目B' }] }) };
    }
    if (url === '/api/projects/remove') {
      removedId = JSON.parse(opts.body).id;
      if (defaultId === removedId) defaultId = 'default';
      return { ok: true, json: async () => ({ default: defaultId, projects: [{ id: 'default', name: '项目A' }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  try {
    const p = installPortfolio({
      esc: (s) => String(s),
      syncProjects: () => {},
      onProjectsChanged: (reg) => changed.push(reg),
    });
    await p.refresh('2026-11-28');
    const bodyEl = elements.get('portfolioBody');
    assert.match(bodyEl.innerHTML, /data-project-default="proj-b"/);
    assert.match(bodyEl.innerHTML, /data-project-remove="proj-b"/);

    // 设为默认
    await bodyEl.dispatch('click', {
      target: { closest: (sel) => (sel === '[data-project-default]' ? { dataset: { projectDefault: 'proj-b' } } : null) },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(defaultId, 'proj-b');
    assert.equal(changed.length, 1);

    // 移除注册
    await bodyEl.dispatch('click', {
      target: { closest: (sel) => (sel === '[data-project-remove]' ? { dataset: { projectRemove: 'proj-b', projectName: '项目B' } } : null) },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(removedId, 'proj-b');
    assert.equal(defaultId, 'default');
    assert.equal(changed.length, 2);
  } finally {
    globalThis.document = origDoc;
    globalThis.fetch = origFetch;
    globalThis.confirm = origConfirm;
  }
});
