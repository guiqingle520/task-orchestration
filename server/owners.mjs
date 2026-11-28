import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_OWNERS = 200;
const UNASSIGNED = 'unassigned';
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class OwnersConfigError extends Error {}

export function normalizeOwnerName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new OwnersConfigError('负责人名称不能为空');
  if (name.length > 60) throw new OwnersConfigError(`负责人名称过长（最多 60 字符）：${name.slice(0, 20)}`);
  if (/[\r\n"]|\s+#/.test(name)) throw new OwnersConfigError(`负责人名称包含不支持的字符：${name}`);
  return name;
}

export function normalizeOwnersConfig(input) {
  if (!record(input)) throw new OwnersConfigError('负责人配置格式无效');
  const keys = Object.keys(input);
  if (keys.some((key) => key !== 'owners')) throw new OwnersConfigError('负责人配置包含不支持的字段');
  const rawList = input.owners ?? [];
  if (!Array.isArray(rawList)) throw new OwnersConfigError('owners 必须是列表');
  if (rawList.length > MAX_OWNERS) throw new OwnersConfigError(`负责人数量不能超过 ${MAX_OWNERS} 人`);

  const seen = new Set();
  const owners = [];
  for (const entry of rawList) {
    const item = typeof entry === 'string' ? { name: entry, role: '', active: true } : entry;
    if (!record(item)) throw new OwnersConfigError('负责人条目格式无效');
    if (Object.keys(item).some((k) => k !== 'name' && k !== 'role' && k !== 'active')) {
      throw new OwnersConfigError('负责人条目仅支持 name、role 和 active 字段');
    }
    const name = normalizeOwnerName(item.name);
    const role = typeof item.role === 'string' ? item.role.trim() : '';
    const active = item.active === undefined ? true : item.active;
    if (typeof active !== 'boolean') throw new OwnersConfigError(`负责人 ${name} 的 active 状态须为布尔值`);
    if (role.length > 60 || /[\r\n]/.test(role)) throw new OwnersConfigError('负责人角色备注无效（最多 60 字符且为单行）');
    const key = name.toLowerCase();
    if (key === UNASSIGNED) throw new OwnersConfigError('unassigned 为系统保留的未分配标识，无需重复添加');
    if (seen.has(key)) throw new OwnersConfigError(`负责人名称重复：${name}`);
    seen.add(key);
    owners.push({ name, role, active });
  }
  return { owners };
}

export function ownersPath(project) {
  const filename = basename(project.planPath);
  return join(dirname(project.planPath), filename === 'plan.md' ? 'owners.json' : filename + '.owners.json');
}

function hasOwnersFile(file) {
  try {
    if (!lstatSync(file).isFile()) throw new Error('负责人配置须为普通文件');
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export function readOwnersConfig(project) {
  const file = ownersPath(project);
  return normalizeOwnersConfig(hasOwnersFile(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
}

// config 必须先通过 normalizeOwnersConfig。与 plan.md 独立，原子写盘。
export function writeOwnersConfig(project, config) {
  const file = ownersPath(project);
  hasOwnersFile(file);
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* 保留原错误 */ }
    throw err;
  }
}

/**
 * 合并花名册与当前 plan.md 中已出现的负责人，并统计每个人的总任务数与未完成任务数。
 * 返回 { owners: [{ name, role, active, inRoster, taskCount, openTaskCount }] }
 */
export function mergeOwnersWithPlan(rosterOwners, planData) {
  const tasks = Array.isArray(planData?.tasks) ? planData.tasks : [];
  const stats = new Map();
  for (const task of tasks) {
    const owner = typeof task?.owner === 'string' ? task.owner.trim() : '';
    if (!owner) continue;
    const entry = stats.get(owner) || { taskCount: 0, openTaskCount: 0 };
    entry.taskCount += 1;
    if (task.status !== 'done') entry.openTaskCount += 1;
    stats.set(owner, entry);
  }

  const result = [];
  const seen = new Set();
  for (const item of rosterOwners || []) {
    const count = stats.get(item.name) || { taskCount: 0, openTaskCount: 0 };
    seen.add(item.name.toLowerCase());
    result.push({
      name: item.name,
      role: item.role || '',
      active: item.active !== false,
      inRoster: true,
      taskCount: count.taskCount,
      openTaskCount: count.openTaskCount,
    });
  }

  const extraNames = [...stats.keys()]
    .filter((name) => name.toLowerCase() !== UNASSIGNED && !seen.has(name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const name of extraNames) {
    const count = stats.get(name);
    result.push({
      name,
      role: '',
      active: true,
      inRoster: false,
      taskCount: count.taskCount,
      openTaskCount: count.openTaskCount,
    });
  }
  return result;
}

/**
 * 将花名册中的 fromName 更名或归并到 toName（纯函数，返回新数组）。
 */
export function applyOwnerRenameToRoster(rosterOwners, fromName, toName) {
  const fromKey = fromName.toLowerCase();
  const toKey = toName.toLowerCase();
  const source = (rosterOwners || []).find((item) => item.name.toLowerCase() === fromKey);
  const existingTarget = (rosterOwners || []).find((item) => item.name.toLowerCase() === toKey);
  const next = [];
  let insertedTarget = false;

  for (const item of rosterOwners || []) {
    const key = item.name.toLowerCase();
    if (key === fromKey) {
      if (!existingTarget && toKey !== UNASSIGNED) {
        next.push({ name: toName, role: item.role || '', active: item.active !== false });
        insertedTarget = true;
      }
      continue;
    }
    if (key === toKey) {
      next.push({
        name: toName,
        role: item.role || source?.role || '',
        active: item.active !== false,
      });
      insertedTarget = true;
      continue;
    }
    next.push({ name: item.name, role: item.role || '', active: item.active !== false });
  }

  if (!insertedTarget && toKey !== UNASSIGNED) {
    next.push({ name: toName, role: source?.role || '', active: true });
  }
  return normalizeOwnersConfig({ owners: next }).owners;
}
