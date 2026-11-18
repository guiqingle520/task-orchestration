import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIntegrationService, createIssueAdapter } from '../server/integrations.mjs';
import { issueApiBase } from '../server/issue-transport.mjs';
import { parseFrontMatter, serializePlanMarkdown } from '../scripts/validate-plan.mjs';

const githubConfig = { provider: 'github', apiBase: 'https://api.github.com', repo: 'owner/tasks', enabled: true, token: 'TEST-ONLY-SECRET' };
const githubIssue = (number, title, state = 'open', labels = [], body = '') => ({ number, title, state, labels, body, html_url: 'https://github.com/owner/tasks/issues/' + number });
async function fixture(t, transport) {
  const root = await mkdtemp(join(tmpdir(), 'm5-issues-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'plan'));
  const project = { id: 'first', planPath: join(root, 'plan', 'plan.md') };
  const task = (id, status, progress) => ({ id, status, progress, title: id, owner: 'dev', start: '2026-11-17', end: '2026-11-20',
    milestone: 'M1', deps: [], actualStart: status === 'todo' ? null : '2026-11-17', actualEnd: status === 'done' ? '2026-11-17' : null });
  const plan = { project: 'Fixture', milestones: [{ id: 'M1', name: 'Stage', due: '2026-11-22' }],
    tasks: [task('T-1', 'doing', 25), task('T-2', 'done', 100), task('T-3', 'todo', 0)] };
  const seed = serializePlanMarkdown(plan, '---\nproject: Fixture\n---\n\n# Notes\nKeep this.\n');
  writeFileSync(project.planPath, seed);
  const readPlan = ({ planPath }) => {
    const raw = readFileSync(planPath, 'utf8');
    return { data: parseFrontMatter(raw), raw, revision: createHash('sha256').update(raw).digest('hex') };
  };
  let today = '2026-11-18';
  const service = createIntegrationService(root, { readPlan, transport, today: () => today });
  return { project, seed, service, readPlan, configFile: join(root, 'plan', 'integrations.json'), changeDate: (date) => { today = date; } };
}

test('pull previews isolate bindings and apply only confirmed fields and dates', async (t) => {
  const remote = [
    githubIssue(1, '[T-1] task', 'closed'),
    githubIssue(2, '[T-2] task', 'open', ['status:blocked']),
    githubIssue(3, '[T-3] other project', 'closed', [], '<!-- task-orchestration:other:T-3 -->'),
  ];
  const { project, seed, service, readPlan, changeDate } = await fixture(t, async () => ({ data: remote }));
  const config = service.save(project.id, githubConfig);
  assert.equal(config.token, '');
  assert.equal(config.tokenConfigured, true);
  assert.equal(service.get('second').tokenConfigured, false);
  const preview = await service.synchronize(project, { direction: 'pull', dryRun: true, taskIds: [] });
  assert.equal(preview.proposedUpdates[0].after.actualEnd, '2026-11-18');
  assert.equal(preview.skippedConflicts[0].id, 'T-2');
  assert.equal(readPlan(project).raw, seed);
  assert.deepEqual(service.get(project.id).issueMap, {});
  changeDate('2026-11-19');
  const input = { direction: 'pull', previewId: preview.previewId, expectedRevision: preview.expectedRevision };
  const applied = await service.synchronize(project, input);
  assert.deepEqual(applied.updated, ['T-1']);
  assert.deepEqual(readPlan(project).data.tasks.map(({ status, actualEnd }) => [status, actualEnd]), [
    ['done', '2026-11-18'], ['done', '2026-11-17'], ['todo', null],
  ]);
  assert.match(readPlan(project).raw, /Keep this\./);
  assert.equal(applied.issueMap['T-1'].number, 1);
  assert.equal(applied.issueMap['T-3'], undefined);
  await assert.rejects(service.synchronize(project, input), { status: 409, code: 'SYNC_PREVIEW_STALE' });
});

test('changed remote state, issue binding or local plan invalidates preview without writing it', async (t) => {
  let remote = [githubIssue(1, '[T-1] task', 'closed')], onList;
  const { project, seed, service, readPlan, configFile } = await fixture(t, async () => { onList?.(); return { data: remote }; });
  service.save(project.id, githubConfig);
  const getPreview = () => service.synchronize(project, { direction: 'pull', dryRun: true, taskIds: ['T-1'] });
  const confirm = ({ previewId, expectedRevision }) => service.synchronize(project, { direction: 'pull', previewId, expectedRevision, taskIds: ['T-1'] });
  let preview = await getPreview();
  remote = [githubIssue(1, '[T-1] task')];
  await assert.rejects(confirm(preview), { code: 'SYNC_PREVIEW_STALE' });
  assert.equal(readPlan(project).raw, seed);
  assert.deepEqual(service.get(project.id).issueMap, {});

  remote = [githubIssue(1, '[T-1] task', 'closed')];
  preview = await getPreview();
  const stored = JSON.parse(readFileSync(configFile, 'utf8'));
  stored.projects.first.issueMap['T-1'] = { number: 9, state: 'open', url: 'https://github.com/owner/tasks/issues/9' };
  writeFileSync(configFile, JSON.stringify(stored));
  await assert.rejects(confirm(preview), { code: 'SYNC_PREVIEW_STALE' });
  assert.equal(readPlan(project).raw, seed);

  stored.projects.first.issueMap = {};
  writeFileSync(configFile, JSON.stringify(stored));
  preview = await getPreview();
  onList = () => writeFileSync(project.planPath, seed + '\nConcurrent edit');
  await assert.rejects(confirm(preview), { code: 'SYNC_PREVIEW_STALE' });
  assert.match(readPlan(project).raw, /Concurrent edit$/);
  assert.deepEqual(service.get(project.id).issueMap, {});
});

test('push requires selected tasks or explicit allow-all, avoids duplicate creation, and preserves user labels and body', async (t) => {
  const calls = [], remote = [githubIssue(22, '[T-2] previous title', 'open', ['triage', 'status:doing'], 'Human-written context')];
  const { service, project } = await fixture(t, async (_config, req) => {
    calls.push(req);
    if (req.method === 'GET') return { data: remote };
    if (req.method === 'PATCH') {
      assert.match(req.url, /\/22$/);
      Object.assign(remote[0], req.body);
      return { data: remote[0] };
    }
    assert.fail('already matched; no issue should be created');
  });
  service.save(project.id, githubConfig);
  await assert.rejects(service.synchronize(project, { direction: 'push' }), { status: 400 });
  await assert.rejects(service.synchronize(project, { direction: 'push', taskIds: ['T-2'], expectedTarget: { ...githubConfig, repo: 'other/repo' } }), { code: 'SYNC_TARGET_CHANGED' });
  assert.equal(calls.length, 0);
  const changed = await service.synchronize(project, { direction: 'push', taskIds: ['T-2'] });
  assert.deepEqual(changed.updated, ['T-2']);
  assert.deepEqual(changed.created, []);
  assert.equal(remote[0].state, 'closed');
  assert.equal(remote[0].body, 'Human-written context');
  assert.deepEqual(remote[0].labels, ['triage', 'task-orchestration', 'milestone:M1', 'status:done']);
  const replay = await service.synchronize(project, { direction: 'push', taskIds: ['T-2'] });
  assert.deepEqual(replay.updated, []);
  assert.equal(calls.filter(({ method }) => method === 'PATCH').length, 1);
  assert.throws(() => service.save(project.id, { ...githubConfig, repo: 'other/repo', token: '' }), { status: 400 });
  assert.equal(service.get(project.id).issueMap['T-2'].number, 22);
  service.save(project.id, { ...githubConfig, repo: 'other/repo' });
  assert.deepEqual(service.get(project.id).issueMap, {});
});

test('GitLab uses project IID, encoded namespace and state_event, while GitHub skips pull requests', async () => {
  const requests = [];
  const item = { iid: 13, id: 901, title: 'fixture', description: '', labels: [], state: 'opened', web_url: 'https://gitlab.com/group/sub/repo/-/issues/13' };
  const gitlab = createIssueAdapter({ provider: 'gitlab', repo: 'group/sub/repo', apiBase: 'https://gitlab.com/api/v4' }, async (_cfg, req) => {
    requests.push(req);
    if (req.method === 'GET') return { data: [item] };
    return { data: { ...item, state: 'closed' } };
  });
  const [issue] = await gitlab.list();
  assert.equal(issue.number, 13);
  await gitlab.update(issue, { title: 'new title', body: 'context', labels: ['a', 'b'], state: 'closed' });
  assert.equal(requests[1].url, 'https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/issues/13');
  assert.deepEqual(requests[1].body, { title: 'new title', description: 'context', labels: 'a,b', state_event: 'close' });
  const github = createIssueAdapter(githubConfig, async () => ({ data: [{ pull_request: {} }, githubIssue(2, 'real issue')] }));
  assert.equal((await github.list()).length, 1);
  for (const value of ['http://example.com', 'https://127.0.0.1', 'https://localhost', 'https://user@example.com', 'https://example.com/?key=redacted']) {
    assert.throws(() => issueApiBase(value), { status: 400 });
  }
});

test('a provider that drops managed labels reports a partial result and keeps the binding for retry', async (t) => {
  let issue;
  const writes = [];
  const { service, project } = await fixture(t, async (_config, request) => {
    if (request.method === 'GET') return { data: issue ? [issue] : [] };
    writes.push(request.method);
    if (!issue) issue = githubIssue(81, request.body.title, 'open', [], request.body.body);
    return { data: issue };
  });
  service.save(project.id, githubConfig);
  const push = () => service.synchronize(project, { direction: 'push', taskIds: ['T-3'] });
  const first = await push();
  assert.equal(first.ok, false);
  assert.deepEqual(first.created, ['T-3']);
  assert.match(first.failed[0].message, /标签/);
  assert.equal(first.issueMap['T-3'].number, 81);
  const retry = await push();
  assert.equal(retry.ok, false);
  assert.deepEqual(retry.created, []);
  assert.equal(writes.filter((method) => method === 'POST').length, 1);
});
