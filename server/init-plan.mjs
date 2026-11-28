import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDate, serializePlanMarkdown, validate } from '../scripts/validate-plan.mjs';

const PACKAGE_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));

export const minimalPlanExample = [
  '---',
  'project: my-app',
  'milestones:',
  '  - id: M1',
  '    name: 核心交付',
  '    due: 2026-12-01',
  'tasks:',
  '  - id: T-1',
  '    title: 完成核心功能并验证',
  '    start: 2026-11-21',
  '    end: 2026-11-23',
  '---',
].join('\n');

function localToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function initPlanFile(cwd, options = {}) {
  const repoRoot = realpathSync(resolve(cwd));
  const planDir = join(repoRoot, 'plan');
  const planFile = join(planDir, 'plan.md');
  if (existsSync(planFile)) return { planCreated: false, planPath: planFile };
  const today = options.today || localToday();
  const due = options.due || new Date(Date.now() + 7 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (!isDate(due)) throw new Error('due 必须是有效的 YYYY-MM-DD 日期');
  const endDay = due >= today ? due : today;
  const folder = basename(repoRoot) || 'my-project';
  const project = (options.project && String(options.project).trim()) || folder;
  const milestone = (options.milestone && String(options.milestone).trim()) || '核心交付';
  const owner = (options.owner && String(options.owner).trim()) || 'unassigned';

  const template = readFileSync(join(PACKAGE_ROOT, 'plan', 'plan.template.md'), 'utf8');
  const skeleton = template.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/, '---\nproject: template\n---');
  const data = {
    project,
    milestones: [{ id: 'M1', name: milestone, due: endDay }],
    tasks: [{
      id: 'T-1',
      title: '拆解开发需求并更新计划任务',
      owner,
      milestone: 'M1',
      start: today,
      end: endDay,
      deps: [],
      status: 'todo',
      progress: 0,
      actualStart: null,
      actualEnd: null,
    }],
  };
  const errs = validate(data);
  if (errs.length) throw new Error(errs.join('; '));
  const content = serializePlanMarkdown(data, skeleton);
  mkdirSync(planDir, { recursive: true });
  if (realpathSync(planDir) !== planDir) throw new Error('plan 目录不能指向其他位置');
  writeFileSync(planFile, content, { encoding: 'utf8', flag: 'wx' });
  return { planCreated: true, planPath: planFile, data };
}
