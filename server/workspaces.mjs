import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseFrontMatter, serializePlanMarkdown, validate } from '../scripts/validate-plan.mjs';

function assertInside(repoRoot, file) {
  const rel = relative(repoRoot, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('计划文件必须位于项目目录内');
}

function validPlan(file) {
  if (!statSync(file).isFile()) throw new Error('计划路径不是普通文件');
  const data = parseFrontMatter(readFileSync(file, 'utf8'));
  if (!data) throw new Error('项目计划缺少 YAML front matter');
  const errors = validate(data);
  if (errors.length) throw new Error(errors.join('；'));
  return data;
}

export function createWorkspaces(root, {
  configRoot = process.env.TASK_COCKPIT_HOME || root,
  defaultRepoRoot = process.env.TASK_COCKPIT_PROJECT_ROOT || root,
} = {}) {
  const defaultRoot = existsSync(defaultRepoRoot) ? realpathSync(defaultRepoRoot) : resolve(defaultRepoRoot);
  const configPath = join(configRoot, 'plan', 'workspaces.json');
  const defaultPlan = join(defaultRoot, 'plan', 'plan.md');
  const defaultName = () => {
    // 默认计划缺失或无法解析时不能让服务启动失败,该项目之后会被标记为不可用
    try { return parseFrontMatter(readFileSync(defaultPlan, 'utf8'))?.project || '默认项目'; } catch { return '默认项目'; }
  };
  const fallback = () => ({ default: 'default', projects: [{ id: 'default', name: defaultName(), repoRoot: defaultRoot, planPath: defaultPlan }] });
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
  function preflight(input) {
    if (typeof input?.repoRoot !== 'string' || !isAbsolute(input.repoRoot)) throw new Error('项目路径必须是绝对路径');
    const repoRoot = realpathSync(input.repoRoot);
    if (!statSync(repoRoot).isDirectory()) throw new Error('请选择项目文件夹');
    const folder = basename(repoRoot) || 'project';
    const hash = createHash('sha256').update(repoRoot);
    const id = folder.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
      || 'project-' + hash.copy().digest('hex').slice(0, 8);
    const planDir = join(repoRoot, 'plan');
    const target = join(planDir, 'plan.md');
    try {
      if (lstatSync(planDir, { throwIfNoEntry: false })) {
        assertInside(repoRoot, realpathSync(planDir));
        if (!statSync(planDir).isDirectory()) throw new Error('plan 路径不是目录');
      }
      if (lstatSync(target, { throwIfNoEntry: false })) {
        const file = realpathSync(target);
        assertInside(repoRoot, file);
        return { state: 'valid', id, name: validPlan(file).project, repoRoot };
      }
    } catch (err) {
      return { state: 'invalid', message: '无法使用 plan/plan.md：' + err.message };
    }
    const template = readFileSync(join(root, 'plan', 'plan.template.md'), 'utf8');
    const defaults = parseFrontMatter(template);
    if (!defaults || validate(defaults).length) throw new Error('默认计划模板未通过校验，请检查 plan/plan.template.md');
    if (!/["\r\n]|\s+#/.test(folder)) defaults.project = folder;
    // Generate editable YAML from the template, keeping its Markdown instructions.
    const skeleton = template.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/, '---\nproject: template\n---');
    const preview = serializePlanMarkdown(defaults, skeleton);
    return { state: 'missing', id, name: folder.slice(0, 100), repoRoot, preview, previewId: hash.update('\0' + preview).digest('hex') };
  }

  function saveRegistry(registry) {
    mkdirSync(dirname(configPath), { recursive: true });
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); renameSync(temporary, configPath); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }

  function add(input) {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !name || name.length > 100) throw new Error('项目 ID 或名称无效');
    if ((!input.repoRoot && !input.planPath) || (input.repoRoot && !isAbsolute(input.repoRoot)) || (input.planPath && !isAbsolute(input.planPath))) throw new Error('项目路径必须是绝对路径');
    const registry = read();
    if (registry.projects.some(item => item.id === id)) throw new Error('项目 ID 已存在');
    if (input.previewId !== undefined) {
      if (input.planPath) throw new Error('新计划仅支持默认计划路径');
      const check = preflight(input);
      if (check.state !== 'missing' || check.previewId !== input.previewId) throw new Error('计划或目录已变化，请重新检查');
      const dir = join(check.repoRoot, 'plan');
      const target = join(dir, 'plan.md');
      if (registry.projects.some(item => item.planPath === target)) throw new Error('计划路径已注册');
      mkdirSync(dir, { recursive: true });
      assertInside(check.repoRoot, realpathSync(dir));
      // Exclusive create: another process may have saved a plan since the preview.
      writeFileSync(target, check.preview, { encoding: 'utf8', flag: 'wx' });
    }
    const file = realpathSync(input.planPath || join(input.repoRoot, 'plan', 'plan.md'));
    const repoRoot = realpathSync(input.repoRoot || (basename(dirname(file)) === 'plan' ? dirname(dirname(file)) : dirname(file)));
    assertInside(repoRoot, file);
    validPlan(file);
    if (registry.projects.some(item => item.planPath === file)) throw new Error('计划路径已注册');
    const project = { id, name, repoRoot, planPath: file };
    registry.projects.push(project);
    saveRegistry(registry);
    return project;
  }

  function remove(id) {
    const targetId = typeof id === 'string' ? id.trim() : '';
    if (!targetId) throw new Error('请提供要移除的项目 ID');
    const registry = read();
    const index = registry.projects.findIndex((item) => item.id === targetId);
    if (index < 0) throw new Error('项目不存在');
    if (registry.projects.length <= 1) throw new Error('至少保留一个工作区项目，无法移除最后一个项目');
    const [removed] = registry.projects.splice(index, 1);
    if (registry.default === targetId) registry.default = registry.projects[0].id;
    saveRegistry(registry);
    return { removed, default: registry.default, projects: registry.projects };
  }

  function setDefault(id) {
    const targetId = typeof id === 'string' ? id.trim() : '';
    if (!targetId) throw new Error('请提供要设为默认的项目 ID');
    const registry = read();
    if (!registry.projects.some((item) => item.id === targetId)) throw new Error('项目不存在');
    registry.default = targetId;
    saveRegistry(registry);
    return { default: registry.default, projects: registry.projects };
  }

  return { read, get, add, remove, setDefault, preflight };
}

export function registerWorkspace(workspaces, repoRoot) {
  const check = workspaces.preflight({ repoRoot });
  if (check.state !== 'valid') return { projectId: null, registered: false };
  const planPath = realpathSync(join(check.repoRoot, 'plan', 'plan.md'));
  const { projects } = workspaces.read();
  const existing = projects.find((project) => project.planPath === planPath);
  if (existing) return { projectId: existing.id, registered: false };
  const id = projects.some((project) => project.id === check.id)
    ? `${check.id.slice(0, 67)}-${randomUUID().slice(0, 12)}`
    : check.id;
  const added = workspaces.add({ repoRoot: check.repoRoot, id, name: check.name });
  return { projectId: added.id, registered: true };
}
