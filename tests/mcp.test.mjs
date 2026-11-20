import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function createNdjsonClient(child) {
  let buf = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolveWaiter = waiters.get(msg.id);
      if (resolveWaiter) {
        waiters.delete(msg.id);
        resolveWaiter(msg);
      }
    }
  });
  let nextId = 1;
  return {
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolvePromise) => {
        waiters.set(id, resolvePromise);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
  };
}

test('T-60: stdio MCP server supports query, validate, role guard, and dual-agent 409 conflict detection', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plan-mcp-'));
  await mkdir(join(root, 'plan'));
  const samplePlan = [
    '---',
    'project: mcp-demo',
    'milestones:',
    '  - id: M1',
    '    name: 核心交付',
    '    due: 2026-11-30',
    'tasks:',
    '  - id: T-1',
    '    title: 实现 MCP 查询工具',
    '    owner: antigravity',
    '    milestone: M1',
    '    start: 2026-11-18',
    '    end: 2026-11-20',
    '    deps: []',
    '    status: doing',
    '    progress: 20',
    '    actualStart: 2026-11-18',
    '    actualEnd: null',
    '  - id: T-2',
    '    title: 联调下游任务',
    '    owner: codex',
    '    milestone: M1',
    '    start: 2026-11-21',
    '    end: 2026-11-22',
    '    deps: [T-1]',
    '    status: todo',
    '    progress: 0',
    '    actualStart: null',
    '    actualEnd: null',
    '---',
    '',
    '# 计划说明',
    '',
    '| 任务 | 验收标准 |',
    '|---|---|',
    '| T-1 | 查询与校验通过后再允许带冲突锁写回。 |',
    '',
  ].join('\n');
  const planPath = join(root, 'plan', 'plan.md');
  await writeFile(planPath, samplePlan, 'utf8');

  const child = spawn(process.execPath, [resolve('server/mcp.mjs'), '--root', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.once('exit', r));
    await rm(root, { recursive: true, force: true });
  });

  const client = createNdjsonClient(child);

  // 1. MCP 协议握手与工具列表
  const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qa', version: '1.0' } });
  assert.equal(init.result.serverInfo.name, 'task-orchestration');
  client.notify('notifications/initialized');

  const list = await client.request('tools/list');
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['plan_list_projects', 'plan_get_overview', 'plan_get_task', 'plan_validate', 'plan_update_task']);

  // 2. 查询与校验
  const projects = (await client.request('tools/call', { name: 'plan_list_projects', arguments: { today: '2026-11-19' } })).result;
  assert.equal(projects.structuredContent.projects[0].name, 'mcp-demo');

  const validated = (await client.request('tools/call', { name: 'plan_validate', arguments: {} })).result;
  assert.equal(validated.structuredContent.valid, true);
  assert.equal(validated.structuredContent.taskCount, 2);

  const overview = (await client.request('tools/call', { name: 'plan_get_overview', arguments: { today: '2026-11-19' } })).result;
  assert.equal(overview.structuredContent.project, 'mcp-demo');
  assert.equal(overview.structuredContent.followUp[0].id, 'T-1');

  // 3. 权限边界：禁止普通执行工具修改标题/依赖等规划字段
  const agentAView = (await client.request('tools/call', { name: 'plan_get_task', arguments: { id: 'T-1' } })).result.structuredContent;
  const agentBView = (await client.request('tools/call', { name: 'plan_get_task', arguments: { id: 'T-1' } })).result.structuredContent;
  assert.equal(agentAView.acceptance, '查询与校验通过后再允许带冲突锁写回。');

  const forbidden = (await client.request('tools/call', {
    name: 'plan_update_task',
    arguments: { id: 'T-1', expected: agentAView.expected, status: 'doing', progress: 30, title: '试图篡改标题' },
  })).result;
  assert.equal(forbidden.isError, true);
  assert.equal(forbidden.structuredContent.status, 403);
  assert.equal(forbidden.structuredContent.code, 'FORBIDDEN_FIELDS');

  // 4. 双 Agent 并发写入冲突检查：A 先提交成功，B 用旧 expected 提交收到 409 CONFLICT 且不覆盖 A
  const writeA = (await client.request('tools/call', {
    name: 'plan_update_task',
    arguments: { id: 'T-1', expected: agentAView.expected, status: 'doing', progress: 50, today: '2026-11-19' },
  })).result;
  assert.equal(writeA.isError, undefined);
  assert.equal(writeA.structuredContent.task.progress, 50);

  const writeB = (await client.request('tools/call', {
    name: 'plan_update_task',
    arguments: { id: 'T-1', expected: agentBView.expected, status: 'doing', progress: 80, today: '2026-11-19' },
  })).result;
  assert.equal(writeB.isError, true);
  assert.equal(writeB.structuredContent.status, 409);
  assert.equal(writeB.structuredContent.code, 'CONFLICT');
  assert.equal(writeB.structuredContent.current.progress, 50);

  const afterDisk = await readFile(planPath, 'utf8');
  assert.match(afterDisk, /progress: 50/);
  assert.doesNotMatch(afterDisk, /progress: 80/);
});

test('T-60: plugin bundle manifest and install script produce valid Antigravity plugin directory', async (t) => {
  const target = await mkdtemp(join(tmpdir(), 'plan-plugin-'));
  t.after(() => rm(target, { recursive: true, force: true }));

  execFileSync(process.execPath, [resolve('scripts/install-plugin.mjs'), '--target', target], { encoding: 'utf8' });

  const manifest = JSON.parse(await readFile(join(target, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'task-orchestration');
  assert.equal(manifest.logo, 'assets/logo.svg');
  assert.equal(manifest.suggestedPrompts.length, 3);

  const mcpCfg = JSON.parse(await readFile(join(target, 'mcp_config.json'), 'utf8'));
  assert.equal(mcpCfg.mcpServers['task-orchestration'].command, 'node');
  assert.equal(mcpCfg.mcpServers['task-orchestration'].args[0], resolve('server/mcp.mjs'));

  const ruleText = await readFile(join(target, 'rules', 'AGENTS.md'), 'utf8');
  assert.match(ruleText, /plan_update_task/);
  const skillText = await readFile(join(target, 'skills', 'generate-plan', 'SKILL.md'), 'utf8');
  assert.match(skillText, /generate-plan/);
});
