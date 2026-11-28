import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  OwnersConfigError,
  applyOwnerRenameToRoster,
  mergeOwnersWithPlan,
  normalizeOwnersConfig,
  readOwnersConfig,
  writeOwnersConfig,
} from '../server/owners.mjs';

test('T-73: owners schema validates uniqueness, active flag, reserved unassigned, and merges plan owners with task counts', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'plan-owners-unit-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = { repoRoot: dir, planPath: join(dir, 'plan.md') };

  assert.deepEqual(readOwnersConfig(project), { owners: [] });

  assert.throws(() => normalizeOwnersConfig({ owners: [{ name: '' }] }), OwnersConfigError);
  assert.throws(() => normalizeOwnersConfig({ owners: [{ name: 'unassigned' }] }), OwnersConfigError);
  assert.throws(() => normalizeOwnersConfig({ owners: [{ name: 'Alice' }, { name: 'alice' }] }), OwnersConfigError);
  assert.throws(() => normalizeOwnersConfig({ owners: [{ name: 'Bob', active: 'yes' }] }), OwnersConfigError);

  const normalized = normalizeOwnersConfig({
    owners: [
      { name: '张三', role: '前端', active: true },
      { name: 'codex', role: 'AI 智能体', active: false },
    ],
  });
  writeOwnersConfig(project, normalized);
  assert.deepEqual(readOwnersConfig(project), normalized);

  const merged = mergeOwnersWithPlan(normalized.owners, {
    tasks: [
      { id: 'T-1', owner: '张三', status: 'doing' },
      { id: 'T-2', owner: '张三', status: 'done' },
      { id: 'T-3', owner: 'codex', status: 'todo' },
      { id: 'T-4', owner: '张三（前端）', status: 'todo' },
      { id: 'T-5', owner: 'unassigned', status: 'todo' },
    ],
  });
  assert.deepEqual(merged, [
    { name: '张三', role: '前端', active: true, inRoster: true, taskCount: 2, openTaskCount: 1 },
    { name: 'codex', role: 'AI 智能体', active: false, inRoster: true, taskCount: 1, openTaskCount: 1 },
    { name: '张三（前端）', role: '', active: true, inRoster: false, taskCount: 1, openTaskCount: 1 },
  ]);

  const renamed = applyOwnerRenameToRoster(normalized.owners, '张三', '李四');
  assert.equal(renamed[0].name, '李四');
  assert.equal(renamed[0].role, '前端');

  const mergedRoster = applyOwnerRenameToRoster(
    [{ name: '张三', role: '前端', active: true }, { name: '张三（前端）', role: '', active: true }],
    '张三（前端）',
    '张三',
  );
  assert.deepEqual(mergedRoster, [{ name: '张三', role: '前端', active: true }]);
});

test('T-73: HTTP /api/owners and /api/owners/rename support roster CRUD, dryRun preview, 409 conflict guard, and atomic plan update', { timeout: 15000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plan-owners-http-')));
  for (const path of ['server', 'scripts', 'web', 'package.json']) {
    await cp(resolve(path), join(root, path), { recursive: true });
  }
  await mkdir(join(root, 'plan'));
  const samplePlan = [
    '---',
    'project: owners-demo',
    'milestones:',
    '  - id: M1',
    '    name: 第一阶段',
    '    due: 2026-12-10',
    'tasks:',
    '  - id: T-1',
    '    title: 前端页面开发',
    '    owner: 张三（前端）',
    '    milestone: M1',
    '    start: 2026-11-21',
    '    end: 2026-11-23',
    '    deps: []',
    '    status: doing',
    '    progress: 30',
    '    actualStart: 2026-11-21',
    '    actualEnd: null',
    '  - id: T-2',
    '    title: 联调验收',
    '    owner: 张三',
    '    milestone: M1',
    '    start: 2026-11-24',
    '    end: 2026-11-25',
    '    deps: [T-1]',
    '    status: todo',
    '    progress: 0',
    '    actualStart: null',
    '    actualEnd: null',
    '---',
    '',
    '# 计划说明',
    '',
  ].join('\n');
  await writeFile(join(root, 'plan', 'plan.md'), samplePlan, 'utf8');

  const socket = createServer();
  await new Promise((res) => socket.listen(0, '127.0.0.1', res));
  const port = socket.address().port;
  await new Promise((res) => socket.close(res));

  const child = spawn(process.execPath, ['server/server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) } });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise((res) => child.once('exit', res));
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready;
  for (let i = 0; i < 50; i++) {
    try { ready = await fetch(`${base}/api/owners`); break; } catch { await delay(100); }
  }
  assert.ok(ready?.ok, 'server started');

  // 1. 初始 GET 自动合并现有 plan.md 的负责人
  const initial = await ready.json();
  assert.deepEqual(initial.owners.map((o) => [o.name, o.inRoster, o.openTaskCount]), [
    ['张三', false, 1],
    ['张三（前端）', false, 1],
  ]);

  // 2. 保存花名册（含停用状态）
  const savedRes = await fetch(`${base}/api/owners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      owners: [
        { name: '张三', role: '前端负责人', active: true },
        { name: '王五', role: '后端', active: false },
      ],
    }),
  });
  assert.equal(savedRes.status, 200);
  const saved = await savedRes.json();
  assert.equal(saved.roster.length, 2);
  assert.equal(saved.owners.find((o) => o.name === '王五').active, false);

  // 3. 归并/更名预览（dryRun=true）
  const previewRes = await fetch(`${base}/api/owners/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '张三（前端）', to: '张三', dryRun: true }),
  });
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json();
  assert.equal(preview.affectedCount, 1);
  assert.equal(preview.openAffectedCount, 1);
  assert.equal(preview.merging, true);
  assert.deepEqual(preview.affectedTaskIds, ['T-1']);

  // 4. 缺少或过期的 expectedRevision 返回 409
  const conflictRes = await fetch(`${base}/api/owners/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '张三（前端）', to: '张三', expectedRevision: 'stale' }),
  });
  assert.equal(conflictRes.status, 409);

  const post = (endpoint, body) => fetch(base + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const claimed = await post('/api/claims', { action: 'claim', id: 'T-1', actor: 'codex' });
  assert.equal(claimed.status, 200);
  const { claim } = await claimed.json();
  const locked = await post('/api/owners/rename', { from: '张三（前端）', to: '张三', expectedRevision: preview.revision });
  assert.equal(locked.status, 409);
  assert.equal((await locked.json()).code, 'ACTIVE_CLAIM_CONFLICT');
  assert.equal((await post('/api/claims', { action: 'release', id: 'T-1', actor: claim.actor, leaseId: claim.leaseId })).status, 200);

  // 5. 释放租约后正式更名并更新当前计划
  const applyRes = await fetch(`${base}/api/owners/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '张三（前端）', to: '张三', expectedRevision: preview.revision }),
  });
  assert.equal(applyRes.status, 200);
  const applied = await applyRes.json();
  assert.equal(applied.affectedCount, 1);
  assert.equal(applied.owners.find((o) => o.name === '张三').taskCount, 2);
  assert.equal(applied.owners.some((o) => o.name === '张三（前端）'), false);

  const planAfter = await readFile(join(root, 'plan', 'plan.md'), 'utf8');
  assert.doesNotMatch(planAfter, /owner: 张三（前端）/);
  assert.match(planAfter, /负责人更名：张三（前端） -> 张三/);
});
