import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { claimsPath, readClaims, writeClaims } from '../server/claims.mjs';
import { withPlanLock } from '../server/plan-lock.mjs';

test('plan and claim changes reach isolated SSE clients, with coordination across all write paths', { timeout: 25000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-live-'));
  for (const path of ['server', 'scripts', 'web', 'package.json']) {
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
  assert.match((await response.json()).errors.join(' '), /找不到/);
  assert.equal((await fetch(base)).status, 200);
  const list = async () => (await (await fetch(`${base}/api/projects`)).json()).projects;
  const portfolio = async () => (await (await fetch(`${base}/api/portfolio?today=2026-11-19`)).json());
  assert.equal((await list())[0].health, 'unavailable');
  assert.equal((await portfolio()).projects[0].overdueCount, null);
  assert.equal((await fetch(`${base}/api/portfolio?today=2026-02-29`)).status, 400);
  await mkdir(join(root, 'plan'));
  const file = join(root, 'plan', 'plan.md');
  await writeFile(file, '---\nproject: broken\ninvalid YAML\n---\n');
  assert.equal((await list())[0].health, 'unavailable');
  const original = await readFile(resolve('plan/plan.md'), 'utf8');
  await writeFile(file, original);
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
  assert.match(loaded.acceptanceByTask['T-57'], /现在可开工/);
  assert.equal(loaded.raw, undefined);
  const payload = { ...loaded.data, expectedRevision: loaded.revision, reason: '' };
  payload.tasks[0].title += ' 修改';
  const save = (body) => fetch(`${base}/api/plan/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const rawBeforeConflict = await readFile(file, 'utf8');
  const conflicting = structuredClone(payload);
  conflicting.reason = '尝试提前依赖任务';
  conflicting.tasks.find(({ id }) => id === 'T-2').start = '2026-11-16';
  const rejected = await save(conflicting);
  assert.equal(rejected.status, 400);
  const body = await rejected.json();
  assert.equal(body.code, 'DEPENDENCY_CONFLICT');
  assert.deepEqual(body.conflicts, [{ upstreamId: 'T-1', downstreamId: 'T-2', upstreamEnd: '2026-11-17', downstreamStart: '2026-11-16', overlapDays: 1 }]);
  assert.equal(await readFile(file, 'utf8'), rawBeforeConflict);
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
  await writeFile(secondFile, original.replace('project: task-orchestration', 'project: second').replace(/^(  - id: )(T-\d+)/m, '$1"$2" # keep the ID comment'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=History QA', '-c', 'user.email=qa@example.com',
    '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=.git/no-test-hooks', ...args], { cwd: secondRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--object-format=sha1');
  git('add', 'plan/plan.md');
  const historySubject = 'OFFLINE-COMMIT-FIXTURE ' + current.id;
  git('commit', '-qm', historySubject);
  const historyHash = git('rev-parse', 'HEAD');
  const register = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'second', name: 'Second', repoRoot: secondRoot }) });
  assert.equal(register.status, 200, await register.clone().text());
  assert.equal((await (await fetch(`${base}/api/projects`)).json()).projects.length, 2);
  const workspaceSummary = await portfolio();
  assert.equal(workspaceSummary.today, '2026-11-19');
  assert.deepEqual(workspaceSummary.projects.map(({ id }) => id), ['default', 'second']);
  assert.ok(workspaceSummary.projects.every(project => project.health !== 'unavailable'));
  assert.doesNotMatch(JSON.stringify(workspaceSummary), /repoRoot|planPath|commits|OFFLINE-COMMIT-FIXTURE/);
  assert.equal((await (await fetch(`${base}/api/plan?project=second`)).json()).data.project, 'second');
  assert.equal((await (await fetch(`${base}/api/plan`)).json()).data.project, 'replaced');
  assert.equal((await fetch(`${base}/api/plan?project=missing`)).status, 404);
  const secondPlan = await (await fetch(`${base}/api/plan?project=second`)).json();
  const secondTask = secondPlan.data.tasks[0];
  const expectedSecond = Object.fromEntries(['status', 'progress', 'actualStart', 'actualEnd'].map((key) => [key, secondTask[key]]));
  const updatedSecond = await fetch(`${base}/api/task?project=second`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: secondTask.id, expected: expectedSecond, status: 'doing', progress: 35 }) });
  assert.equal(updatedSecond.status, 200);
  assert.equal((await (await fetch(`${base}/api/plan?project=second`)).json()).data.tasks[0].progress, 35);
  assert.match(await readFile(secondFile, 'utf8'), /"T-\d+" # keep the ID comment/);
  assert.equal((await (await fetch(`${base}/api/plan`)).json()).data.tasks[0].progress, 20);
  const liveSecond = await (await fetch(`${base}/api/plan?project=second`)).json();
  const readHistory = (query) => fetch(`${base}/api/history?${query}`);
  const listing = await (await readHistory('project=second&limit=2')).json();
  assert.equal(listing.projectId, 'second');
  assert.equal(listing.frames, undefined);
  assert.equal(listing.current.revision, liveSecond.revision);
  assert.deepEqual(listing.commits.map(({ hash, subject, taskCount }) => [hash, subject, taskCount]), [[historyHash, historySubject, secondPlan.data.tasks.length]]);
  const historical = await (await readHistory(`project=second&rev=${historyHash.slice(0, 7)}`)).json();
  const preloaded = await (await readHistory('project=second&limit=2&frames=1')).json();
  assert.deepEqual(preloaded.commits, listing.commits);
  assert.deepEqual(preloaded.frames[historyHash], { data: historical.data, acceptanceByTask: historical.acceptanceByTask });
  assert.equal(historical.currentRevision, liveSecond.revision);
  assert.equal(historical.commit.hash, historyHash);
  assert.equal(historical.data.tasks[0].progress, secondTask.progress);
  assert.equal(historical.diff.tasks[secondTask.id].progressDelta, 35 - secondTask.progress);
  const defaultHistory = await (await readHistory('limit=1')).json();
  assert.equal(defaultHistory.current.revision, (await (await fetch(`${base}/api/plan`)).json()).revision);
  assert.deepEqual(defaultHistory.commits, []);
  assert.equal((await readHistory(`rev=${historyHash}`)).status, 404);
  assert.equal((await readHistory('project=second&rev=HEAD')).status, 400);
  assert.equal((await readHistory('project=second&limit=101')).status, 400);
  assert.equal((await readHistory('project=missing')).status, 404);
  const postJson = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const exportResponse = await postJson('/api/export/html?project=second', {
    today: '2026-11-18', customTitle: '第二个项目分享版', maskOwners: true, stripInternalNotes: true,
  });
  assert.equal(exportResponse.status, 200, await exportResponse.clone().text().then((body) => body.slice(0, 256)));
  const exported = await exportResponse.json();
  assert.equal(exported.filename, 'task-orchestration-2026-11-18.html');
  assert.match(exported.html, /<title>第二个项目分享版<\/title>/);
  assert.match(exported.html, /成员-A/);
  assert.equal(/ownerMap|规划者按用户要求|OFFLINE-COMMIT-FIXTURE/.test(exported.html), false, 'do not embed private export metadata');
  const withoutMask = await postJson('/api/export/html?project=second', { today: '2026-11-18' });
  assert.ok((await withoutMask.json()).html.includes(historySubject));
  assert.equal((await postJson('/api/export/html?project=second', { today: '2026-04-31' })).status, 400);

  const capacity = async (id) => (await fetch(base + '/api/capacity?project=' + id)).json();
  assert.equal((await capacity('second')).config.hoursPerDay, 8);
  const updateHours = (body) => postJson('/api/capacity?project=second', body);
  const keepPlan = await readFile(secondFile, 'utf8');
  const savedHours = await updateHours({ hoursPerDay: 7.5, tasks: { [secondTask.id]: { estimateHours: 0, actualHours: 0, storyPoints: 0 } } });
  assert.equal(savedHours.status, 200);
  assert.deepEqual((await capacity('second')).config.tasks[secondTask.id], { estimateHours: 0, actualHours: 0, storyPoints: 0 });
  assert.equal((await capacity('second')).metrics.tasks[secondTask.id].actualSource, 'reported');
  assert.equal((await updateHours({ holidays: ['2026-12-32'] })).status, 400);
  assert.equal((await capacity('second')).config.hoursPerDay, 7.5);
  assert.equal(await readFile(secondFile, 'utf8'), keepPlan);

  const alternateFile = join(secondRoot, 'plan', 'alternate.md');
  await writeFile(alternateFile, keepPlan);
  const alternate = await postJson('/api/projects', { id: 'alternate', name: 'Alternate', repoRoot: secondRoot, planPath: alternateFile });
  assert.equal(alternate.status, 200);
  assert.equal((await capacity('alternate')).config.hoursPerDay, 8);
  assert.equal((await postJson('/api/capacity?project=alternate', { hoursPerDay: 6 })).status, 200);
  assert.equal((await capacity('alternate')).config.hoursPerDay, 6);
  assert.equal((await capacity('second')).config.hoursPerDay, 7.5);
  assert.equal((await capacity('default')).config.hoursPerDay, 8);
  const integrationPath = '/api/integrations?project=second';
  const savedIntegration = await postJson(integrationPath, { provider: 'github', enabled: true, repo: 'fixture/project', token: 'M5-TEST-TOKEN' });
  assert.equal(savedIntegration.status, 200);
  const integration = await (await fetch(base + integrationPath)).json();
  assert.equal(integration.token, '');
  assert.equal(integration.tokenConfigured, true);
  assert.equal(JSON.stringify(integration).includes('M5-TEST-TOKEN'), false);
  assert.equal((await (await fetch(base + '/api/integrations?project=alternate')).json()).tokenConfigured, false);
  assert.equal((await postJson('/api/integrations/sync?project=second', { direction: 'push', taskIds: [] })).status, 400);
  assert.equal((await postJson('/api/integrations/sync?project=second', { direction: 'pull', taskIds: [current.id] })).status, 400);
  await delay(250);
  const firstController = new AbortController(), secondController = new AbortController();
  t.after(() => { firstController.abort(); secondController.abort(); });
  const firstEvents = (await fetch(`${base}/api/events`, { signal: firstController.signal })).body.getReader();
  const secondEvents = (await fetch(`${base}/api/events?project=second`, { signal: secondController.signal })).body.getReader();
  await firstEvents.read(); await secondEvents.read();
  await writeFile(secondFile, `${await readFile(secondFile, 'utf8')}\n`);
  assert.match(new TextDecoder().decode((await secondEvents.read()).value), /event: plan-change/);

  const actor = 'PRIVATE-CLAIM-ACTOR';
  const note = 'PRIVATE-HEARTBEAT-NOTE';
  const reason = 'PRIVATE-AUDIT-REASON';
  const rosterLabel = 'PRIVATE-ROSTER-LABEL';
  const saveClaims = (body) => postJson('/api/claims?project=second', body);
  const readProjectClaims = async (id) => (await fetch(`${base}/api/claims?project=${id}`)).json();
  const beforeClaim = await readFile(secondFile, 'utf8');
  const claimed = await saveClaims({ action: 'claim', id: secondTask.id, actor, actorKind: 'agent', note });
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const { claim } = await claimed.json();
  assert.match(new TextDecoder().decode((await secondEvents.read()).value), /event: plan-change/);
  assert.equal(await readFile(secondFile, 'utf8'), beforeClaim);
  assert.equal((await readProjectClaims('second')).claims[secondTask.id].leaseId, claim.leaseId);
  assert.deepEqual((await readProjectClaims('alternate')).claims, {});
  const heartbeatNote = 'PRIVATE-MCP-SSE-HEARTBEAT';
  const heartbeat = execFileSync(process.execPath, ['--input-type=module', '-e', [
    "import { createMcpService } from './server/mcp.mjs';",
    'const mcp = createMcpService(process.argv[1]);',
    "console.log(JSON.stringify(mcp.callTool('plan_heartbeat_task', JSON.parse(process.argv[2])).structuredContent));",
  ].join('\n'), secondRoot, JSON.stringify({ id: secondTask.id, actor, leaseId: claim.leaseId, note: heartbeatNote })], { encoding: 'utf8' });
  assert.equal(JSON.parse(heartbeat).claim.note, heartbeatNote);
  assert.match(new TextDecoder().decode((await secondEvents.read()).value), /event: plan-change/);
  assert.equal((await readProjectClaims('second')).claims[secondTask.id].note, heartbeatNote);
  assert.equal(await readFile(secondFile, 'utf8'), beforeClaim);

  const assertWritten = await (await fetch(`${base}/api/plan?project=second`)).json();
  const taskExpected = Object.fromEntries(['status', 'progress', 'actualStart', 'actualEnd'].map((key) => [key, assertWritten.data.tasks[0][key]]));
  const update = { id: secondTask.id, expected: taskExpected, status: 'doing', progress: 80 };
  const legacyWrite = await postJson('/api/task?project=second', update);
  assert.equal(legacyWrite.status, 409);
  assert.equal((await legacyWrite.json()).code, 'TASK_LOCKED_BY_CLAIM');
  assert.equal((await postJson('/api/task?project=second', { ...update, actor, leaseId: claim.leaseId })).status, 200);

  const paths = ['.githooks', 'scripts', 'server', 'web', 'package.json'];
  await Promise.all(paths.map((path) => cp(resolve(path), join(secondRoot, path), { recursive: true })));
  const beforeGit = await readFile(secondFile, 'utf8');
  const subject = 'done ' + secondTask.id;
  git('-c', 'core.hooksPath=.githooks', 'commit', '--allow-empty', '-m', subject);
  assert.equal(await readFile(secondFile, 'utf8'), beforeGit);
  execFileSync(process.execPath, ['scripts/sync-git-progress.mjs'], { cwd: secondRoot, stdio: 'pipe' });
  assert.equal(await readFile(secondFile, 'utf8'), beforeGit);
  const synchronized = await (await fetch(`${base}/api/sync-git?project=second`, { method: 'POST' })).json();
  assert.deepEqual(synchronized.skippedLockedTasks, [{ id: secondTask.id, actor, leaseId: claim.leaseId }]);
  assert.equal(await readFile(secondFile, 'utf8'), beforeGit);

  const currentPlan = await (await fetch(`${base}/api/plan?project=second`)).json();
  const amended = { ...currentPlan.data, expectedRevision: currentPlan.revision, reason };
  amended.tasks.find(({ id }) => id === secondTask.id).owner = 'new-owner';
  const rejectedOverride = await postJson('/api/plan/save?project=second', amended);
  assert.equal(rejectedOverride.status, 409);
  assert.equal((await rejectedOverride.json()).code, 'ACTIVE_CLAIM_CONFLICT');
  const rejectedDelete = await postJson('/api/plan/save?project=second', {
    ...amended, tasks: amended.tasks.filter(({ id }) => id !== secondTask.id)
      .map((task) => ({ ...task, deps: task.deps.filter((id) => id !== secondTask.id) })),
  });
  assert.equal(rejectedDelete.status, 409);
  assert.equal((await rejectedDelete.json()).code, 'ACTIVE_CLAIM_CONFLICT');
  assert.equal(await readFile(secondFile, 'utf8'), beforeGit);
  // Earlier checks deliberately use a front matter comment, which the planner cannot rewrite.
  await writeFile(secondFile, beforeGit.replace(' # keep the ID comment', ''));
  const { revision: rewritableRevision } = await (await fetch(`${base}/api/plan?project=second`)).json();
  const planReason = 'Change planned owner';
  const forced = await postJson('/api/plan/save?project=second', {
    ...amended, expectedRevision: rewritableRevision, reason: planReason, forceOverrideClaims: true,
  });
  assert.equal(forced.status, 200, await forced.clone().text());
  assert.equal((await readProjectClaims('second')).claims[secondTask.id], undefined);
  const reserved = await (await saveClaims({ action: 'claim', id: secondTask.id, actor, note })).json();
  assert.equal((await saveClaims({ action: 'release', id: secondTask.id, actor: 'coordinator', leaseId: reserved.claim.leaseId, force: true, reason })).status, 200);
  assert.equal((await saveClaims({ action: 'roster', roster: [{ id: actor, label: rosterLabel, kind: 'agent' }] })).status, 200);
  const liveClaim = await (await saveClaims({ action: 'claim', id: secondTask.id, actor, note })).json();
  withPlanLock(secondFile, () => {
    const config = readClaims(secondFile);
    config.claims['T-999'] = { ...config.claims[secondTask.id], taskId: 'T-999' };
    writeClaims(secondFile, config);
  });
  assert.equal((await readProjectClaims('second')).claims['T-999'].state, 'orphaned');
  assert.equal((await saveClaims({ action: 'roster', cleanupOrphans: true })).status, 200);
  const cleanedClaims = await readProjectClaims('second');
  assert.equal(cleanedClaims.claims['T-999'], undefined);
  assert.equal(cleanedClaims.claims[secondTask.id].leaseId, liveClaim.claim.leaseId);
  assert.equal(cleanedClaims.configuredRoster[0].label, rosterLabel);
  assert.equal(claimsPath(alternateFile), join(secondRoot, 'plan', 'alternate.md.claims.json'));

  for (const masked of [false, true]) {
    const response = await postJson('/api/export/html?project=second', { today: '2026-11-18', maskOwners: masked, stripInternalNotes: masked });
    assert.equal(response.status, 200);
    const { html } = await response.json();
    for (const value of [actor, note, heartbeatNote, reason, rosterLabel, liveClaim.claim.leaseId]) {
      assert.equal(html.includes(value), false, 'offline HTML contains sidecar data');
    }
  }
  assert.equal(await Promise.race([firstEvents.read().then(() => 'unexpected'), delay(400).then(() => 'isolated')]), 'isolated');
  assert.equal((await fetch(`${base}/api/projects`, { headers: { origin: 'https://unrelated.example' } })).status, 403);
  const configure = (projects) => fetch(`${base}/api/webhooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channels: [{ id: 'test', name: 'Test', type: 'generic', url: 'https://example.com/secret', enabled: false, autoAlert: false, projects }] }) });
  assert.equal((await configure(['unknown'])).status, 400);
  const configResponse = await configure(['default']);
  assert.equal(configResponse.status, 200);
  const channels = (await (await fetch(`${base}/api/webhooks`)).json()).channels;
  assert.equal(channels[0].url, '');
  assert.equal(channels[0].configured, true);
  assert.deepEqual(channels[0].projects, ['default']);
  assert.equal(JSON.stringify(channels).includes('secret'), false);
  assert.equal((await fetch(`${base}/api/notify?project=second`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: 'test', mode: 'report' }) })).status, 400);
  await writeFile(secondFile, '---\nproject: broken\nbad syntax\n---\n');
  assert.equal((await (await readHistory('project=second')).json()).current, null);
  const withoutCurrent = await (await readHistory(`project=second&rev=${historyHash}`)).json();
  assert.equal(withoutCurrent.currentRevision, null);
  assert.equal(withoutCurrent.diff, null);
  assert.equal(withoutCurrent.data.tasks.length, secondPlan.data.tasks.length);
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
  globalThis.fetch = async (url) => { if (url === '/api/plan') requests++; return { json: async () => ({ errors: [] }) }; };
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
