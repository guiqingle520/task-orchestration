import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('plan changes and atomic replacements reach SSE clients and reconnects', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-live-'));
  for (const path of ['server', 'scripts', 'web', 'plan', 'package.json']) {
    await cp(resolve(path), join(root, path), { recursive: true });
  }
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, ['server/server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) } });
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let response;
  for (let i = 0; i < 50; i++) {
    try { response = await fetch(`${base}/api/plan`); break; } catch { await delay(100); }
  }
  assert.ok(response, 'server started');
  const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  async function nextEvent() {
    while (!buffer.includes('\n\n')) {
      const result = await reader.read();
      assert.equal(result.done, false);
      buffer += result.value;
    }
    const end = buffer.indexOf('\n\n');
    const event = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return event;
  }
  assert.match(await nextEvent(), /event: plan-change\ndata: connected/);
  const file = join(root, 'plan', 'plan.md');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace('project: task-orchestration', 'project: changed'));
  assert.match(await nextEvent(), /event: plan-change\ndata: changed/);
  assert.equal((await (await fetch(`${base}/api/plan`)).json()).data.project, 'changed');
  await writeFile(`${file}.tmp`, original.replace('project: task-orchestration', 'project: replaced'));
  await rename(`${file}.tmp`, file);
  assert.match(await nextEvent(), /event: plan-change\ndata: changed/);
  assert.equal((await (await fetch(`${base}/api/plan`)).json()).data.project, 'replaced');
  const current = (await (await fetch(`${base}/api/plan`)).json()).data.tasks[0];
  const expected = Object.fromEntries(['status', 'progress', 'actualStart', 'actualEnd'].map((key) => [key, current[key]]));
  const postTask = (status, progress) => fetch(`${base}/api/task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: current.id, expected, status, progress }) });
  assert.equal((await postTask('done', 40)).status, 400);
  assert.equal((await postTask('doing', 20)).status, 200);
  assert.equal((await postTask('doing', 30)).status, 409);
  const updated = (await (await fetch(`${base}/api/plan`)).json()).data.tasks.find((task) => task.id === current.id);
  assert.equal(updated.progress, 20);
  assert.ok(updated.actualStart);
  const loaded = await (await fetch(`${base}/api/plan`)).json();
  const payload = { ...loaded.data, expectedRevision: loaded.revision, reason: '' };
  payload.tasks[0].title += ' 修改';
  const save = (body) => fetch(`${base}/api/plan/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await save(payload)).status, 400);
  payload.reason = '调整任务标题';
  const saved = await save(payload);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await save(payload)).status, 409);
  const afterSave = await readFile(file, 'utf8');
  assert.match(afterSave, /变更记录:.*planner 调整任务标题/);
  const reconnect = await fetch(`${base}/api/events`, { signal: controller.signal });
  const first = await reconnect.body.getReader().read();
  assert.match(new TextDecoder().decode(first.value), /event: plan-change\ndata: connected/);
  const secondRoot = join(root, 'fixture-project');
  await cp(join(root, 'plan'), join(secondRoot, 'plan'), { recursive: true });
  const secondFile = join(secondRoot, 'plan', 'plan.md');
  await writeFile(secondFile, original.replace('project: task-orchestration', 'project: second'));
  const register = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'second', name: 'Second', repoRoot: secondRoot }) });
  assert.equal(register.status, 200, await register.clone().text());
  assert.equal((await (await fetch(`${base}/api/projects`)).json()).projects.length, 2);
  assert.equal((await (await fetch(`${base}/api/plan?project=second`)).json()).data.project, 'second');
  assert.equal((await (await fetch(`${base}/api/plan`)).json()).data.project, 'replaced');
  assert.equal((await fetch(`${base}/api/plan?project=missing`)).status, 404);
  const secondPlan = await (await fetch(`${base}/api/plan?project=second`)).json();
  const secondTask = secondPlan.data.tasks[0];
  const expectedSecond = Object.fromEntries(['status', 'progress', 'actualStart', 'actualEnd'].map((key) => [key, secondTask[key]]));
  const updatedSecond = await fetch(`${base}/api/task?project=second`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: secondTask.id, expected: expectedSecond, status: 'doing', progress: 35 }) });
  assert.equal(updatedSecond.status, 200);
  assert.equal((await (await fetch(`${base}/api/plan?project=second`)).json()).data.tasks[0].progress, 35);
  assert.equal((await (await fetch(`${base}/api/plan`)).json()).data.tasks[0].progress, 20);
  await delay(250);
  const firstController = new AbortController(), secondController = new AbortController();
  t.after(() => { firstController.abort(); secondController.abort(); });
  const firstEvents = (await fetch(`${base}/api/events`, { signal: firstController.signal })).body.getReader();
  const secondEvents = (await fetch(`${base}/api/events?project=second`, { signal: secondController.signal })).body.getReader();
  await firstEvents.read(); await secondEvents.read();
  await writeFile(secondFile, `${await readFile(secondFile, 'utf8')}\n`);
  assert.match(new TextDecoder().decode((await secondEvents.read()).value), /event: plan-change/);
  assert.equal(await Promise.race([firstEvents.read().then(() => 'unexpected'), delay(400).then(() => 'isolated')]), 'isolated');
  assert.equal((await fetch(`${base}/api/projects`, { headers: { origin: 'https://unrelated.example' } })).status, 403);
  const configResponse = await fetch(`${base}/api/webhooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channels: [{ id: 'test', name: 'Test', type: 'generic', url: 'https://example.com/secret', enabled: false, autoAlert: false }] }) });
  assert.equal(configResponse.status, 200);
  const channels = (await (await fetch(`${base}/api/webhooks`)).json()).channels;
  assert.equal(channels[0].url, '');
  assert.equal(channels[0].configured, true);
  assert.equal(JSON.stringify(channels).includes('secret'), false);
  assert.equal((await fetch(`${base}/api/notify?project=second`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: 'test', mode: 'report' }) })).status, 400);
});

test('browser refreshes the plan on SSE events', async (t) => {
  const saved = { document: globalThis.document, fetch: globalThis.fetch, EventSource: globalThis.EventSource, setInterval: globalThis.setInterval };
  t.after(() => Object.assign(globalThis, saved));
  const elements = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { addEventListener() {}, value: '', hidden: false, innerHTML: '' });
      return elements.get(id);
    },
    addEventListener() {},
  };
  let requests = 0;
  globalThis.fetch = async () => { requests++; return { json: async () => ({ errors: [] }) }; };
  globalThis.setInterval = () => 0;
  let events;
  globalThis.EventSource = class {
    constructor(url) { assert.equal(url, '/api/events'); events = this; }
    addEventListener(name, handler) { assert.equal(name, 'plan-change'); this.onChange = handler; }
  };
  await import('../web/app.js');
  assert.equal(requests, 1);
  await events.onChange();
  assert.equal(requests, 2);
});
