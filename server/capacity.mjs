import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fromDay, toDay } from '../web/metrics.js';

const taskFields = ['storyPoints', 'estimateHours', 'actualHours'];
const configFields = ['hoursPerDay', 'excludeWeekends', 'holidays', 'workdays', 'tasks'];
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class CapacityConfigError extends Error {}

export function normalizeCapacityConfig(input) {
  if (!record(input) || Object.keys(input).some((key) => !configFields.includes(key))) {
    throw new CapacityConfigError('工时配置字段无效');
  }
  const { hoursPerDay = 8, excludeWeekends = true, holidays = [], workdays = [], tasks = {} } = input;
  if (!Number.isFinite(hoursPerDay) || hoursPerDay < 1 || hoursPerDay > 24) throw new CapacityConfigError('每日标准工时须在 1 至 24 之间');
  if (typeof excludeWeekends !== 'boolean') throw new CapacityConfigError('排除周末须为布尔值');
  const dates = (items, label) => {
    if (!Array.isArray(items) || items.some((date) => typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(toDay(date)) || fromDay(toDay(date)) !== date)) {
      throw new CapacityConfigError(label + '须为有效日期 YYYY-MM-DD 的列表');
    }
    return [...new Set(items)].sort();
  };
  if (!record(tasks)) throw new CapacityConfigError('任务工时须按任务 ID 填写');
  const entries = Object.entries(tasks).map(([id, row]) => {
    if (!/^T-\d+$/.test(id) || !record(row)) throw new CapacityConfigError('任务工时条目无效');
    for (const [field, value] of Object.entries(row)) {
      if (!taskFields.includes(field) || !Number.isFinite(value) || value < 0) {
        throw new CapacityConfigError(id + ' 的工时和故事点须为非负数；留空请省略字段');
      }
    }
    return [id, Object.fromEntries(taskFields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]))];
  });
  return { hoursPerDay, excludeWeekends, holidays: dates(holidays, '节假日'), workdays: dates(workdays, '调休补班日'), tasks: Object.fromEntries(entries) };
}

function capacityPath(project) {
  const filename = basename(project.planPath);
  return join(dirname(project.planPath), filename === 'plan.md' ? 'capacity.json' : filename + '.capacity.json');
}

function hasCapacityFile(file) {
  try {
    if (!lstatSync(file).isFile()) throw new Error('工时配置须为普通文件');
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export function readCapacityConfig(project) {
  const file = capacityPath(project);
  return normalizeCapacityConfig(hasCapacityFile(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
}

// config 必须先通过 normalizeCapacityConfig。与 plan.md 无关，写入中断也保留旧配置。
export function writeCapacityConfig(project, config) {
  const file = capacityPath(project);
  hasCapacityFile(file);
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  }
  catch (err) { try { unlinkSync(temp); } catch { /* 保留原错误 */ } throw err; }
}
