import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { getPlanAtCommit, listPlanHistory } from '../server/history.mjs';
import { serializePlanMarkdown } from '../scripts/validate-plan.mjs';

test('Git history stays in the registered repo and skips broken versions of its literal plan path', { timeout: 15000 }, async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'plan-history-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const project = { repoRoot, planPath: join(repoRoot, 'project', '计划 [v1].md') };
  const git = (args, date = '2026-01-01T10:00:00+08:00') => execFileSync(
    'git', ['-c', 'user.name=QA 团队', '-c', 'user.email=qa@example.com', '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-test-hooks', ...args],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
  ).trim();
  const commit = (message, date) => {
    git(['add', '.']);
    git(['commit', '-qm', message], date);
    return git(['rev-parse', 'HEAD']);
  };
  const makePlan = (status, progress) => ({
    project: '第一个项目', milestones: [{ id: 'M1', name: 'Milestone', due: '2026-01-06' }],
    tasks: [{
      id: 'T-1', title: '任务', owner: 'dev', milestone: 'M1', start: '2026-01-01', end: '2026-01-03', deps: [],
      status, progress, actualStart: status === 'todo' ? null : '2026-01-01', actualEnd: status === 'done' ? '2026-01-02' : null,
    }],
  });
  const markdown = (status, progress) => serializePlanMarkdown(makePlan(status, progress), '---\nproject: fixture\n---\n');

  git(['init', '-q', '--object-format=sha1']);
  await mkdir(dirname(project.planPath));
  assert.deepEqual(await listPlanHistory(project), []);
  await writeFile(project.planPath, markdown('todo', 0));
  const first = commit('初始计划', '2026-01-02T00:30:00+08:00');
  await writeFile(join(repoRoot, 'README.md'), 'unrelated');
  commit('Unrelated file', '2026-01-02T10:00:00+08:00');
  await writeFile(project.planPath, '---\nproject: invalid\nbad syntax\n---\n');
  const broken = commit('损坏快照', '2026-01-02T11:00:00+08:00');
  await writeFile(project.planPath, markdown('done', 100));
  const last = commit('完成任务', '2026-01-02T12:00:00+08:00');
  await writeFile(project.planPath, markdown('doing', 70));

  const frames = await listPlanHistory(project);
  assert.deepEqual(frames.map(({ hash, date, subject, author, overall, doneCount }) => [hash, date, subject, author, overall, doneCount]), [
    [first, '2026-01-02', '初始计划', 'QA 团队', 0, 0],
    [last, '2026-01-02', '完成任务', 'QA 团队', 100, 1],
  ]);
  assert.deepEqual((await listPlanHistory(project, 1)).map(({ hash }) => hash), [last]);
  assert.equal((await getPlanAtCommit(project, first.slice(0, 7).toUpperCase())).data.tasks[0].progress, 0);
  await assert.rejects(getPlanAtCommit(project, broken), { status: 404 });
  await assert.rejects(getPlanAtCommit(project, 'HEAD'), { status: 400 });
  const outsideHistory = git(['commit-tree', git(['rev-parse', 'HEAD^{tree}']), '-m', 'Detached snapshot']);
  await assert.rejects(getPlanAtCommit(project, outsideHistory), { status: 404 });
  const nested = { ...project, repoRoot: dirname(project.planPath) };
  assert.deepEqual(await listPlanHistory(nested), []);
  await assert.rejects(getPlanAtCommit(nested, first), { status: 404 });
  assert.equal(await readFile(project.planPath, 'utf8'), markdown('doing', 70));
});
