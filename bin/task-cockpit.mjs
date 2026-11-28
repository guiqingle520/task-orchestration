#!/usr/bin/env node
// task-cockpit 统一命令行入口：start (默认) | init | check | sync | spec | mcp | help
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkAndFixPlanFile } from '../scripts/validate-plan.mjs';
import { initPlanFile, minimalPlanExample } from '../server/init-plan.mjs';
import { createWorkspaces, registerWorkspace } from '../server/workspaces.mjs';
import { startStdioServer } from '../server/mcp.mjs';

const PACKAGE_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_HOME = process.env.TASK_COCKPIT_HOME || join(homedir(), '.task-cockpit');

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('-') ? args[idx + 1] : null;
}

function printHelp() {
  console.log(`task-cockpit v${readPackageVersion()} — AI 智能体与开发者的任务时间线驾驶舱

用法:
  npx task-cockpit [start] [--port 5173] [--no-open]   启动驾驶舱并自动接入当前目录
  npx task-cockpit init [选项]                         在当前项目初始化 plan/plan.md
  npx task-cockpit check [plan/plan.md] [--fix]        校验计划（--fix 自动补齐并规范化字段）
  npx task-cockpit sync [--plan plan/plan.md]          根据 Git 提交历史同步任务进度
  npx task-cockpit spec [--template|--minimal]         输出 plan.md 规范、模板或最小示例（供 AI 读取）
  npx task-cockpit mcp [--root <dir>]                  启动标准 stdio MCP 服务

init 选项:
  --project <name>     项目名称（默认取当前文件夹名）
  --milestone <name>   首个里程碑名称（默认“核心交付”）
  --due <YYYY-MM-DD>   首个里程碑交付日（默认 7 天后）
  --owner <name>       默认任务负责人（默认 unassigned）
  --hooks              同时安装 .githooks（提交前校验 + 提交消息自动推进进度）
  --agents             同时写入 AGENTS.md 协作规则与 .agents/skills/generate-plan 技能
  --all                等价于同时开启 --hooks 与 --agents
`);
}

export function initProject(cwd = process.cwd(), options = {}) {
  const repoRoot = resolve(cwd);
  const { planCreated, planPath } = initPlanFile(repoRoot, options);
  const created = { planCreated, planPath, hooksInstalled: false, agentsInstalled: false };

  if (options.hooks || options.all) {
    const hooksDir = join(repoRoot, '.githooks');
    mkdirSync(hooksDir, { recursive: true });
    const preCommit = [
      '#!/bin/sh',
      '# 提交前校验 plan/plan.md，不通过则阻止提交',
      'if [ -f scripts/validate-plan.mjs ]; then',
      '  node scripts/validate-plan.mjs || exit 1',
      'else',
      '  npx --no-install task-cockpit check || npx -y task-cockpit check || exit 1',
      'fi',
      '',
    ].join('\n');
    const commitMsg = [
      '#!/bin/sh',
      '# 根据 commit message 中的任务 ID（如 "T-3 60%"、"done T-3"）自动更新 plan/plan.md',
      'if [ -f scripts/sync-git-progress.mjs ]; then',
      '  node scripts/sync-git-progress.mjs --msg-file "$1" || exit 1',
      'else',
      '  npx --no-install task-cockpit sync --msg-file "$1" || npx -y task-cockpit sync --msg-file "$1" || exit 1',
      'fi',
      'git add plan/plan.md 2>/dev/null || true',
      '',
    ].join('\n');
    writeFileSync(join(hooksDir, 'pre-commit'), preCommit, 'utf8');
    writeFileSync(join(hooksDir, 'commit-msg'), commitMsg, 'utf8');
    try {
      chmodSync(join(hooksDir, 'pre-commit'), 0o755);
      chmodSync(join(hooksDir, 'commit-msg'), 0o755);
    } catch { /* Windows 下忽略 chmod */ }
    if (existsSync(join(repoRoot, '.git'))) {
      try {
        execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repoRoot, stdio: 'ignore' });
      } catch { /* git 未安装或受限时忽略 */ }
    }
    created.hooksInstalled = true;
  }

  if (options.agents || options.all) {
    const markerStart = '<!-- task-cockpit:start -->';
    const markerEnd = '<!-- task-cockpit:end -->';
    const block = [
      markerStart,
      '## 任务计划与进度规范（task-cockpit）',
      '- 任何编码任务开始前，先在 `plan/plan.md` 创建或更新任务排期（可执行 `npx task-cockpit spec` 查看最小格式，或按 `.agents/skills/generate-plan/SKILL.md` 执行）。',
      '- 每个任务最少只需填写 `id`（如 `T-1`）、`title`、`start`、`end`（`YYYY-MM-DD`），其余字段自动补默认值；修改后运行 `npx task-cockpit check`（或 `--fix`）确保校验通过。',
      '- 任务开始时将 `status` 设为 `doing`，完成时设为 `done`（`progress: 100`）；提交 Git 时在消息中携带任务 ID（如 `feat(T-1): ...` 或 `done T-1`）。',
      markerEnd,
    ].join('\n');

    const agentsFile = join(repoRoot, 'AGENTS.md');
    if (existsSync(agentsFile)) {
      const current = readFileSync(agentsFile, 'utf8');
      if (current.includes(markerStart) && current.includes(markerEnd)) {
        const updated = current.replace(new RegExp(`${markerStart}[\\s\\S]*?${markerEnd}`), block);
        writeFileSync(agentsFile, updated, 'utf8');
      } else {
        writeFileSync(agentsFile, current.replace(/\s*$/, '') + '\n\n' + block + '\n', 'utf8');
      }
    } else {
      writeFileSync(agentsFile, `# 智能体协作规则\n\n${block}\n`, 'utf8');
    }

    const skillDir = join(repoRoot, '.agents', 'skills', 'generate-plan');
    const skillTarget = join(skillDir, 'SKILL.md');
    if (!existsSync(skillTarget)) {
      mkdirSync(skillDir, { recursive: true });
      copyFileSync(join(PACKAGE_ROOT, '.agents', 'skills', 'generate-plan', 'SKILL.md'), skillTarget);
    }
    created.agentsInstalled = true;
  }

  return created;
}

async function findAvailablePort(startPort, maxTries = 20) {
  for (let offset = 0; offset < maxTries; offset++) {
    const candidate = startPort + offset;
    const free = await new Promise((resolvePromise) => {
      const srv = createServer();
      srv.once('error', () => resolvePromise(false));
      srv.listen(candidate, '127.0.0.1', () => srv.close(() => resolvePromise(true)));
    });
    if (free) return candidate;
  }
  return startPort;
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 无图形界面时静默忽略 */ }
}

export function ensureWorkspaceForCwd(cwd = process.cwd(), configRoot = DEFAULT_HOME) {
  const repoRoot = realpathSync(resolve(cwd));
  const workspaces = createWorkspaces(PACKAGE_ROOT, { configRoot, defaultRepoRoot: PACKAGE_ROOT });
  try {
    return registerWorkspace(workspaces, repoRoot);
  } catch (err) {
    console.error(`无法自动注册当前项目：${err.message}`);
    return { projectId: null, registered: false };
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  const first = args[0] || 'start';

  if (first === '-v' || first === '--version' || first === 'version') {
    console.log(readPackageVersion());
    return;
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    printHelp();
    return;
  }

  if (first === 'spec') {
    const showTemplate = args.includes('--template');
    const showMinimal = args.includes('--minimal');
    if (showMinimal) {
      console.log(minimalPlanExample);
      return;
    }
    if (showTemplate) {
      console.log(readFileSync(join(PACKAGE_ROOT, 'plan', 'plan.template.md'), 'utf8'));
      return;
    }
    console.log(readFileSync(join(PACKAGE_ROOT, 'docs', 'PLAN_SPEC.md'), 'utf8'));
    return;
  }

  if (first === 'check' || first === 'validate') {
    const rest = args.slice(1);
    const fix = rest.includes('--fix');
    const target = rest.find((a) => !a.startsWith('-')) || 'plan/plan.md';
    const res = checkAndFixPlanFile(target, { fix });
    if (!res.ok) {
      console.error(`✗ ${target} 校验失败 (${res.errors.length} 个问题):`);
      res.errors.forEach((e) => console.error('  - ' + e));
      process.exit(1);
    }
    console.log(`✓ ${target} 校验通过${res.fixed ? '（已规范化写回完整字段）' : ''}`);
    return;
  }

  if (first === 'sync') {
    const syncScript = join(PACKAGE_ROOT, 'scripts', 'sync-git-progress.mjs');
    const child = spawn(process.execPath, [syncScript, ...args.slice(1)], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  if (first === 'init') {
    try {
      const result = initProject(process.cwd(), {
        project: getArg(args, '--project'),
        milestone: getArg(args, '--milestone'),
        due: getArg(args, '--due'),
        owner: getArg(args, '--owner'),
        hooks: args.includes('--hooks'),
        agents: args.includes('--agents'),
        all: args.includes('--all'),
      });
      if (result.planCreated) console.log(`✓ 已生成初始计划: ${result.planPath}`);
      else console.log(`• 已保留现有计划（未覆盖）: ${result.planPath}`);
      if (result.hooksInstalled) console.log('✓ 已安装 Git 钩子 (.githooks/pre-commit, .githooks/commit-msg)');
      if (result.agentsInstalled) console.log('✓ 已写入 AGENTS.md 规则与 .agents/skills/generate-plan 技能');
      console.log('下一步: 运行 npx task-cockpit 启动驾驶舱，或运行 npx task-cockpit check 校验计划。');
    } catch (err) {
      console.error(`✗ 初始化失败: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (first === 'mcp') {
    const cliRoot = getArg(args, '--root') || process.env.TASK_ORCHESTRATION_ROOT || process.cwd();
    const isInsidePkg = resolve(cliRoot) === resolve(PACKAGE_ROOT);
    const configRoot = process.env.TASK_COCKPIT_HOME || (isInsidePkg ? PACKAGE_ROOT : DEFAULT_HOME);
    startStdioServer(cliRoot, { configRoot, defaultRepoRoot: resolve(cliRoot) });
    return;
  }

  if (first === 'start' || first.startsWith('-')) {
    const cwd = process.cwd();
    const isInsidePkg = resolve(cwd) === resolve(PACKAGE_ROOT);
    const configRoot = process.env.TASK_COCKPIT_HOME || (isInsidePkg ? PACKAGE_ROOT : DEFAULT_HOME);
    const desiredPort = Number(getArg(args, '--port') || process.env.PORT || 5173);
    const port = await findAvailablePort(desiredPort);
    const noOpen = args.includes('--no-open') || process.env.CI === 'true' || process.env.NODE_ENV === 'test';
    const { projectId, registered } = ensureWorkspaceForCwd(cwd, configRoot);
    if (registered) console.log(`✓ 已自动注册当前项目 (${projectId})`);

    const url = projectId && projectId !== 'default'
      ? `http://localhost:${port}/?project=${encodeURIComponent(projectId)}`
      : `http://localhost:${port}`;

    const serverScript = join(PACKAGE_ROOT, 'server', 'server.mjs');
    const child = spawn(process.execPath, [serverScript], {
      cwd: PACKAGE_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(port),
        TASK_COCKPIT_HOME: configRoot,
        TASK_COCKPIT_PROJECT_ROOT: resolve(cwd),
      },
    });
    if (!noOpen) {
      setTimeout(() => openBrowser(url), 350).unref();
    }
    if (port !== desiredPort) {
      console.log(`• 端口 ${desiredPort} 已被占用，已自动切换至 ${port}`);
    }
    console.log(`→ 打开地址: ${url}`);
    const forward = (sig) => { if (!child.killed) child.kill(sig); };
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  console.error(`✗ 未知子命令: ${first}`);
  printHelp();
  process.exit(1);
}

const isMain = process.argv[1] && (
  process.platform === 'win32'
    ? realpathSync(resolve(process.argv[1])).toLowerCase() === realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
    : realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
);
if (isMain) {
  void runCli();
}
