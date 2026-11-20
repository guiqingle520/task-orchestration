#!/usr/bin/env node
// 将本仓库的 task-orchestration 插件同步安装到 Antigravity 用户插件目录，并打印 Codex 接入配置。
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const mcpEntry = resolve(root, 'server', 'mcp.mjs');
const targetArg = process.argv.indexOf('--target');
const targetDir = targetArg >= 0 && process.argv[targetArg + 1]
  ? resolve(process.argv[targetArg + 1])
  : join(homedir(), '.gemini', 'config', 'plugins', 'task-orchestration');

mkdirSync(join(targetDir, 'assets'), { recursive: true });
mkdirSync(join(targetDir, 'rules'), { recursive: true });
mkdirSync(join(targetDir, 'skills', 'generate-plan'), { recursive: true });

copyFileSync(join(root, 'plugin.json'), join(targetDir, 'plugin.json'));
copyFileSync(join(root, 'assets', 'logo.svg'), join(targetDir, 'assets', 'logo.svg'));
copyFileSync(join(root, 'rules', 'AGENTS.md'), join(targetDir, 'rules', 'AGENTS.md'));
copyFileSync(join(root, '.agents', 'skills', 'generate-plan', 'SKILL.md'), join(targetDir, 'skills', 'generate-plan', 'SKILL.md'));

const mcpConfig = {
  mcpServers: {
    'task-orchestration': {
      command: 'node',
      args: [mcpEntry],
    },
  },
};
writeFileSync(join(targetDir, 'mcp_config.json'), JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');

console.log(`✓ Antigravity 插件已同步至：${targetDir}`);
console.log(`✓ MCP 入口：node ${mcpEntry}`);
console.log('\nCodex CLI 接入命令：');
console.log(`  codex mcp add task-orchestration -- node "${mcpEntry}"`);
