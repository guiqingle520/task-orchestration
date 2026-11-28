import { toDay } from './metrics.js';

export const normalizeQuery = (value = '') => value.trim().normalize('NFKC').toLowerCase();

const toFilterSet = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value) return [value];
  return [];
};

export function filterTasks(tasks, { query = '', status = '', owner = '', milestone = '' } = {}) {
  const search = normalizeQuery(query);
  const statuses = toFilterSet(status);
  const owners = toFilterSet(owner);
  const milestones = toFilterSet(milestone);
  return tasks.filter(task => (!statuses.length || statuses.includes(task.status))
    && (!owners.length || owners.includes(task.owner))
    && (!milestones.length || milestones.includes(task.milestone))
    && (!search || normalizeQuery(task.id).includes(search) || normalizeQuery(task.title).includes(search)));
}

export function followUpTasks(tasks, today) {
  const day = toDay(today);
  const items = [];
  for (const task of tasks) {
    if (task.status === 'done') continue;
    const days = toDay(task.end) - day;
    const priority = task.status === 'blocked' ? 0 : days < 0 ? 1 : days <= 7 ? 2 : null;
    if (priority !== null) items.push({ task, priority, days });
  }
  return items.sort((a, b) => a.priority - b.priority || a.days - b.days || a.task.id.localeCompare(b.task.id, 'en', { numeric: true }));
}

export function milestoneDelay(milestone) {
  if (!milestone.taskCount) return null;
  const late = milestone.slipDays;
  if (milestone.doneCount === milestone.taskCount) return late > 0 ? { label: '延期完成', days: late } : null;
  if (milestone.daysLeft < 0) return { label: '已延期', days: -milestone.daysLeft };
  return late > 0 ? { label: '预计延期', days: late } : null;
}

export function matchOptions(options, query) {
  const search = normalizeQuery(query);
  if (!search) return options;
  const terms = search.split(/\s+/u);
  return options.map(option => {
    const value = normalizeQuery(option.value);
    const label = normalizeQuery(option.label);
    const name = normalizeQuery(option.searchLabel ?? option.label);
    const haystack = `${name} ${value}`;
    const score = value === search || name === search ? 0 : label.startsWith(search) || value.startsWith(search) ? 1
      : terms.every(term => haystack.includes(term)) ? 2 : -1;
    return { option, score };
  }).filter(({ score }) => score >= 0).sort((a, b) => a.score - b.score).map(({ option }) => option);
}

export function readTaskLink(search) {
  const params = new URLSearchParams(search);
  if (!params.has('task')) return null;
  return { project: params.get('project') || '', task: params.get('task') || '' };
}

export function taskLinkUrl(href, project, task) {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('project', project);
  url.searchParams.set('task', task);
  return url.href;
}
