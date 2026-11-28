import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkAndFixPlanFile, parseFrontMatter, validate } from '../scripts/validate-plan.mjs';
import { ensureWorkspaceForCwd, initProject } from '../bin/task-cockpit.mjs';
import { createMcpService } from '../server/mcp.mjs';

test('T-68: minimal 4-field task plan parses with defaults, actionable hints on errors, and check --fix normalizes on disk', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-minimal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const planFile = join(dir, 'plan.md');

  const minimal = [
    '---',
    'project: quick-app',
    'milestones:',
    '  - id: M1',
    '    name: MVP',
    '    due: 2026-12-01',
    'tasks:',
    '  - id: T-1',
    '    title: 核心功能实现',
    '    start: 2026-11-21',
    '    end: 2026-11-23',
    '---',
    '',
    '# 说明',
  ].join('\n');

  const parsed = parseFrontMatter(minimal);
  assert.deepEqual(validate(parsed), []);
  assert.equal(parsed.tasks[0].owner, 'unassigned');
  assert.equal(parsed.tasks[0].milestone, 'M1');
  assert.deepEqual(parsed.tasks[0].deps, []);
  assert.equal(parsed.tasks[0].status, 'todo');
  assert.equal(parsed.tasks[0].progress, 0);
  assert.equal(parsed.tasks[0].actualStart, null);
  assert.equal(parsed.tasks[0].actualEnd, null);

  // Actionable error suggestions when status=todo & progress>0 or bad ID
  const flawed = [
    '---',
    'project: quick-app',
    'milestones:',
    '  - id: M1',
    '    name: MVP',
    '    due: 2026-12-01',
    'tasks:',
    '  - id: 1',
    '    title: 忘记写 T- 前缀且 todo 写了进度',
    '    start: 2026-11-21',
    '    end: 2026-11-23',
    '    status: todo',
    '    progress: 40',
    '---',
  ].join('\n');
  await writeFile(planFile, flawed, 'utf8');
  const checkBefore = checkAndFixPlanFile(planFile, { fix: false });
  assert.equal(checkBefore.ok, false);
  assert.ok(checkBefore.errors.some((e) => e.includes('T-1') && e.includes('check --fix')));
  assert.ok(checkBefore.errors.some((e) => e.includes('doing') && e.includes('check --fix')));

  // Running with fix=true repairs numeric ID, status/progress mismatch, and writes canonical fields
  const checkAfter = checkAndFixPlanFile(planFile, { fix: true });
  assert.equal(checkAfter.ok, true);
  assert.equal(checkAfter.fixed, true);
  const fixedText = await readFile(planFile, 'utf8');
  assert.match(fixedText, /id: T-1/);
  assert.match(fixedText, /status: doing/);
  assert.match(fixedText, /owner: unassigned/);
  assert.match(fixedText, /milestone: M1/);
});

test('T-67 & T-69 & T-70: initProject creates valid plan, hooks, idempotent AGENTS.md, and auto-registers workspace in TASK_COCKPIT_HOME', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-init-'));
  const home = await mkdtemp(join(tmpdir(), 'cockpit-home-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const first = initProject(root, {
    project: 'demo-repo',
    milestone: '首期交付',
    due: '2026-11-30',
    owner: 'claude',
    all: true,
    today: '2026-11-21',
  });
  assert.equal(first.planCreated, true);
  assert.equal(first.hooksInstalled, true);
  assert.equal(first.agentsInstalled, true);
  assert.equal(existsSync(join(root, 'plan', 'plan.md')), true);
  assert.equal(existsSync(join(root, '.githooks', 'pre-commit')), true);
  assert.equal(existsSync(join(root, '.githooks', 'commit-msg')), true);
  assert.equal(existsSync(join(root, '.agents', 'skills', 'generate-plan', 'SKILL.md')), true);

  // Never overwrites existing plan on re-run, and AGENTS.md block is idempotent
  const customContent = (await readFile(join(root, 'plan', 'plan.md'), 'utf8')) + '\n自定义备注\n';
  await writeFile(join(root, 'plan', 'plan.md'), customContent, 'utf8');
  const second = initProject(root, { all: true });
  assert.equal(second.planCreated, false);
  assert.equal(await readFile(join(root, 'plan', 'plan.md'), 'utf8'), customContent);
  const agentsText = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(agentsText.split('<!-- task-cockpit:start -->').length - 1, 1);

  // Auto-registers into isolated TASK_COCKPIT_HOME
  const reg1 = ensureWorkspaceForCwd(root, home);
  assert.equal(reg1.registered, true);
  assert.ok(reg1.projectId);
  const reg2 = ensureWorkspaceForCwd(root, home);
  assert.equal(reg2.registered, false);
  assert.equal(reg2.projectId, reg1.projectId);

  // CLI check and spec subcommands
  const specOut = execFileSync(process.execPath, [resolve('bin/task-cockpit.mjs'), 'spec', '--minimal'], { cwd: root, encoding: 'utf8' });
  assert.match(specOut, /project: my-app/);
  const checkOut = execFileSync(process.execPath, [resolve('bin/task-cockpit.mjs'), 'check'], { cwd: root, encoding: 'utf8' });
  assert.match(checkOut, /校验通过/);
});

test('T-71: MCP plan_spec and plan_init work on empty directory and refuse overwriting existing plan', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'cockpit-mcp-init-'));
  const home = await mkdtemp(join(tmpdir(), 'cockpit-mcp-home-'));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const mcp = createMcpService(repo, { configRoot: home, defaultRepoRoot: repo });
  const specRes = mcp.callTool('plan_spec', {});
  assert.equal(specRes.structuredContent.ok, true);
  assert.match(specRes.structuredContent.minimalExample, /tasks:/);

  const initRes = mcp.callTool('plan_init', { project: 'ai-service', milestone: 'M1 核心', due: '2026-12-05', owner: 'codex' });
  assert.equal(initRes.structuredContent.ok, true);
  assert.equal(initRes.structuredContent.project, 'ai-service');

  // Calling plan_init again returns 409 and preserves existing file
  const conflictRes = mcp.callTool('plan_init', { project: 'overwrite-attempt' });
  assert.equal(conflictRes.isError, true);
  assert.equal(conflictRes.structuredContent.status, 409);

  // Overview works immediately after plan_init
  const overview = mcp.callTool('plan_get_overview', { today: '2026-11-21' });
  assert.equal(overview.structuredContent.project, 'ai-service');
  assert.equal(overview.structuredContent.tasks.length, 1);
});
