import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('server rejects directory reads, sibling-prefix traversal, oversized POST bodies, and writes tasks atomically', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-hardening-'));
  for (const path of ['server', 'scripts', 'web', 'package.json']) {
    await cp(resolve(path), join(root, path), { recursive: true });
  }
  await mkdir(join(root, 'web', 'subdir'));
  await mkdir(join(root, 'web-secret'));
  await writeFile(join(root, 'web-secret', 'leak.txt'), 'secret');
  await mkdir(join(root, 'plan'));
  const planContent = await readFile(resolve('plan/plan.md'), 'utf8');
  await writeFile(join(root, 'plan', 'plan.md'), planContent);

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
    try { ready = await fetch(`${base}/api/plan`); break; } catch { await delay(100); }
  }
  assert.ok(ready?.ok, 'server started');

  // 1. 目录请求不得触发 EISDIR 崩溃，应返回 404 且服务持续存活
  assert.equal((await fetch(`${base}/subdir`)).status, 404);
  assert.equal((await fetch(`${base}/subdir/`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 200);

  // 2. 同前缀兄弟目录路径逃逸（含 URL 编码）必须被拦截
  assert.equal((await fetch(`${base}/..%2fweb-secret/leak.txt`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/web-secret/leak.txt`)).status, 404);
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);

  // 3. /api/plan 仅接受 GET
  assert.equal((await fetch(`${base}/api/plan`, { method: 'POST' })).status, 404);

  // 4. 旧 POST 路由超限返回 413 JSON，而非粗暴断连
  const oversized = JSON.stringify({ id: 'T-1', pad: 'x'.repeat(20 * 1024) });
  const overTask = await fetch(`${base}/api/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized });
  assert.equal(overTask.status, 413);
  assert.match((await overTask.json()).message, /过大/);

  const overProject = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized });
  assert.equal(overProject.status, 413);

  // 5. 任务更新原子落盘后无残留 .tmp 文件
  const plan = await (await fetch(`${base}/api/plan`)).json();
  const task = plan.data.tasks[0];
  const expected = Object.fromEntries(['status', 'progress', 'actualStart', 'actualEnd'].map((k) => [k, task[k]]));
  const update = await fetch(`${base}/api/task`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: task.id, expected, status: 'doing', progress: 50 }),
  });
  assert.equal(update.status, 200);
  const files = await readdir(join(root, 'plan'));
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);
});
