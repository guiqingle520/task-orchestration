import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFrontMatter, validate } from '../scripts/validate-plan.mjs';

export function createWorkspaces(root) {
  const configPath = join(root, 'plan', 'workspaces.json');
  const defaultPlan = join(root, 'plan', 'plan.md');
  const defaultName = () => {
    // 默认计划缺失或无法解析时不能让服务启动失败,该项目之后会被标记为不可用
    try { return parseFrontMatter(readFileSync(defaultPlan, 'utf8'))?.project || '默认项目'; } catch { return '默认项目'; }
  };
  const fallback = () => ({ default: 'default', projects: [{ id: 'default', name: defaultName(), repoRoot: root, planPath: defaultPlan }] });
  function read() {
    if (!existsSync(configPath)) return fallback();
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!data || !Array.isArray(data.projects) || !data.projects.some((item) => item.id === data.default)) throw new Error('工作区配置无效');
    return data;
  }
  function get(id, data = read()) {
    const project = data.projects.find((item) => item.id === (id || data.default));
    if (!project) throw new Error('项目不存在');
    // 计划文件尚不存在时没有可读写内容,交给调用方报告“不可用”,不在这里抛错
    if (!existsSync(project.planPath)) return project;
    const canonicalRoot = realpathSync(project.repoRoot), canonicalPlan = realpathSync(project.planPath);
    const rel = relative(canonicalRoot, canonicalPlan);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || canonicalPlan !== project.planPath) throw new Error('项目路径已改变，请重新注册');
    return project;
  }
  function add(input) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !name || name.length > 100) throw new Error('项目 ID 或名称无效');
    if ((!input.repoRoot && !input.planPath) || (input.repoRoot && !isAbsolute(input.repoRoot)) || (input.planPath && !isAbsolute(input.planPath))) throw new Error('项目路径必须是绝对路径');
    const file = realpathSync(input.planPath || join(input.repoRoot, 'plan', 'plan.md'));
    const repoRoot = realpathSync(input.repoRoot || (basename(dirname(file)) === 'plan' ? dirname(dirname(file)) : dirname(file)));
    const rel = relative(repoRoot, file);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('计划文件必须位于项目目录内');
    const data = parseFrontMatter(readFileSync(file, 'utf8'));
    if (!data) throw new Error('项目计划缺少 front matter');
    const errors = validate(data);
    if (errors.length) throw new Error(errors.join('; '));
    const registry = read();
    if (registry.projects.some((item) => item.id === id || item.planPath === file)) throw new Error('项目 ID 或计划路径已存在');
    const project = { id, name, repoRoot, planPath: file };
    registry.projects.push(project);
    mkdirSync(dirname(configPath), { recursive: true });
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); renameSync(temporary, configPath); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return project;
  }
  return { read, get, add };
}
