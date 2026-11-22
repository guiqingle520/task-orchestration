#!/usr/bin/env node
// 从 git commit 消息解析任务 ID(T-数字)并自动更新 plan/plan.md 的状态、进度与实际日期。
// 用法:
//   1) 扫描 git log 历史同步: node scripts/sync-git-progress.mjs [--plan plan/plan.md]
//   2) commit-msg 钩子单条消息同步: node scripts/sync-git-progress.mjs --msg-file .git/COMMIT_EDITMSG [--date YYYY-MM-DD]
//
// 支持的 commit message 语法(大小写不敏感,单条消息可包含多个任务):
//   - 标记完成: "done T-3" / "T-3 done" / "closes T-3" / "fixes T-3" / "完成 T-3" / "T-3 完成" / "T-3 100%"
//   - 标记阻塞: "blocked T-3" / "T-3 blocked" / "阻塞 T-3" / "T-3 阻塞"
//   - 指定进度: "T-3 60%" / "[T-3: 60%]" / "T-3 progress 60"
//   - 仅提及任务(如 "feat(T-3): xxx"): 若为 todo 则自动转为 doing、填 actualStart、progress 设为 મેં(默认至少 10)

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseFrontMatter, parseScalar, validate } from './validate-plan.mjs';
import { reconcileDoneClaims } from '../server/claims.mjs';
import { atomicReplaceFile, PlanLockError, revisionOf, withPlanLock } from '../server/plan-lock.mjs';
import { claimState } from '../web/claims.js';

const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/**
 * 解析一条 commit message 中针对各任务的更新指令
 * @param {string} msg
 * @returns {Map<string, { status?: string, progress?: number, touch?: boolean }>}
 */
export function parseCommitMessage(msg) {
  const clean = String(msg || '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  const updates = new Map();
  const ensure = (id) => {
    const key = id.toUpperCase();
    if (!updates.has(key)) updates.set(key, { touch: true });
    return updates.get(key);
  };

  // 1. 提及的所有 T-数字
  for (const m of clean.matchAll(/\b(T-\d+)\b/gi)) {
    ensure(m[1]);
  }

  // 2. 进度百分比: T-12 60% / T-12: 60% / T-12 progress 60%
  for (const m of clean.matchAll(/\b(T-\d+)\b[\s:：,-]*(?:progress[\s:：]*)?(\d{1,3})\s*%/gi)) {
    const u = ensure(m[1]);
    const pct = Math.max(0, Math.min(100, Number(m[2])));
    u.progress = pct;
    if (pct === 100) u.status = 'done';
    else if (pct === 0) u.status = 'todo';
    else u.status = 'doing';
  }

  // 3. 完成关键词: (close|closes|closed|fix|fixes|fixed|resolve|resolves|done|完成) T-12 或 T-12 (done|完成|已完成)
  const doneBefore = /(?:(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|done|complete[sd]?|finish(?:ed)?))|完成|已完成)[\s:：,#-]*(T-\d+)\b/gi;
  const doneAfter = /\b(T-\d+)\b[\s:：,-]*(?:(?:\b(?:done|complete[sd]?|finish(?:ed)?)\b)|完成|已完成)/gi;
  for (const m of [...clean.matchAll(doneBefore), ...clean.matchAll(doneAfter)]) {
    const u = ensure(m[1]);
    u.status = 'done';
    u.progress = 100;
  }

  // 4. 阻塞关键词: (block|blocked|阻塞) T-12 或 T-12 (blocked|阻塞)
  const blockBefore = /(?:(?:\bblock(?:ed)?)|阻塞)[\s:：,#-]*(T-\d+)\b/gi;
  const blockAfter = /\b(T-\d+)\b[\s:：,-]*(?:(?:\bblocked\b)|阻塞)/gi;
  for (const m of [...clean.matchAll(blockBefore), ...clean.matchAll(blockAfter)]) {
    const u = ensure(m[1]);
    u.status = 'blocked';
  }

  return updates;
}

/**
 * 将单次提交的更新应用到任务对象上,返回是否有字段变化
 */
export function applyCommitToTask(task, update, dateStr) {
  const date = dateStr || todayLocal();
  const before = JSON.stringify({
    status: task.status,
    progress: task.progress,
    actualStart: task.actualStart,
    actualEnd: task.actualEnd,
  });

  if (update.status === 'done') {
    task.status = 'done';
    task.progress = 100;
    if (!task.actualStart || date < task.actualStart) task.actualStart = task.actualStart || date;
    task.actualEnd = date;
  } else if (update.status === 'blocked') {
    task.status = 'blocked';
    if (!task.actualStart && task.progress > 0) task.actualStart = date;
  } else if (update.status === 'todo' && update.progress === 0) {
    task.status = 'todo';
    task.progress = 0;
    task.actualStart = null;
    task.actualEnd = null;
  } else if (typeof update.progress === 'number') {
    task.status = 'doing';
    task.progress = update.progress;
    if (!task.actualStart) task.actualStart = date;
    task.actualEnd = null;
  } else if (update.touch) {
    // 仅提及 T-ID: 若还是 todo 则启动任务
    if (task.status === 'todo') {
      task.status = 'doing';
      if (!task.progress || task.progress === 0) task.progress = 10;
      if (!task.actualStart) task.actualStart = date;
    } else if (task.status === 'doing' && !task.actualStart) {
      task.actualStart = date;
    }
  }

  const after = JSON.stringify({
    status: task.status,
    progress: task.progress,
    actualStart: task.actualStart,
    actualEnd: task.actualEnd,
  });
  return before !== after;
}

/**
 * 将更新后的任务状态回写到 plan.md 文本中(只替换对应任务块的 status/progress/actualStart/actualEnd,保留注释与正文)
 */
export function updatePlanMarkdown(planText, tasks) {
  const sections = planText.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)(?=\r?\n|$)/);
  if (!sections) return planText;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const progressFields = ['status', 'progress', 'actualStart', 'actualEnd'];
  const lines = sections[2].split(/(\r?\n)/);
  let inTasks = false, item = [];
  const writeItem = () => {
    const task = byId.get(item.findLast((field) => field.key === 'id')?.value);
    if (!task) return;
    for (const key of progressFields) {
      const field = item.findLast((entry) => entry.key === key);
      if (field && field.value !== (task[key] ?? null)) {
        const value = String(task[key] ?? 'null');
        lines[field.index] = field.prefix + value + field.suffix;
      } else if (!field && task[key] != null) {
        const last = item.at(-1);
        const indent = item[1]?.prefix.match(/^\s*/)[0] ?? item[0].prefix.match(/^\s*/)[0] + '  ';
        const eol = lines[last.index + 1] ?? (sections[1].endsWith('\r\n') ? '\r\n' : '\n');
        lines[last.index] += eol + indent + key + ': ' + task[key];
      }
    }
  };
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const root = /^(\w+):/.exec(line);
    if (root) {
      writeItem();
      item = [];
      inTasks = root[1] === 'tasks';
    } else if (inTasks) {
      const entry = /^(\s+-\s+|\s+)(\w+):(.*)$/.exec(line);
      if (!entry) continue;
      if (entry[1].includes('-')) { writeItem(); item = []; }
      const remainder = entry[3];
      const suffix = /[ \t]+#.*$/.exec(remainder)?.[0] ?? /[ \t]*$/.exec(remainder)[0];
      const scalar = remainder.slice(0, remainder.length - suffix.length);
      const space = scalar ? /^[ \t]*/.exec(scalar)[0] : ' ';
      item.push({ index, key: entry[2], prefix: entry[1] + entry[2] + ':' + space, value: parseScalar(scalar), suffix });
    }
  }
  writeItem();
  return sections[1] + lines.join('') + sections[3] + planText.slice(sections[0].length);
}

/**
 * 写盘前确认生成的文本重新解析后确实包含预期的任务进度字段,
 * 避免“校验通过但文件没变”仍返回成功。
 */
export function verifyTaskUpdates(output, tasks) {
  let parsed;
  try { parsed = parseFrontMatter(output); } catch { return false; }
  if (!parsed || !Array.isArray(parsed.tasks)) return false;
  return tasks.every((t) => {
    const got = parsed.tasks.find((item) => item.id === t.id);
    return got && ['status', 'progress', 'actualStart', 'actualEnd'].every((key) => (got[key] ?? null) === (t[key] ?? null));
  });
}

/**
 * 读取仓库的 git log,返回按时间从旧到新排列的提交列表
 */
export function readGitCommits(cwd = process.cwd(), limit = 200) {
  try {
    const raw = execFileSync(
      'git',
      ['log', `-n`, String(limit), '--reverse', '--date=short', '--pretty=format:%h%x09%ad%x09%s%x09%b%x1e'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return raw
      .split('\x1e')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const [hash, date, subject = '', body = ''] = entry.split('\t');
        const message = body ? `${subject}\n${body}` : subject;
        const updates = parseCommitMessage(message);
        return { hash, date, subject: subject.trim(), taskIds: [...updates.keys()], updates };
      })
      .filter((c) => c.taskIds.length > 0);
  } catch {
    return [];
  }
}

/**
 * 供服务端调用:返回每个任务关联的提交记录 { 'T-1': [{ hash, date, subject }] }
 */
export function getTaskCommitsMap(cwd = process.cwd()) {
  const commits = readGitCommits(cwd);
  const map = {};
  for (const c of commits) {
    for (const id of c.taskIds) {
      (map[id] ||= []).push({ hash: c.hash, date: c.date, subject: c.subject });
    }
  }
  return map;
}

export function syncPlanFromCommits(planFile, commits, { describe = (task, commit) => `${task.id}@${commit.hash}` } = {}) {
  return withPlanLock(planFile, (file) => {
    const raw = readFileSync(file, 'utf8');
    const data = parseFrontMatter(raw);
    if (!data || !Array.isArray(data.tasks)) return { ok: false, message: 'plan.md 格式错误' };
    const now = Date.now();
    const config = reconcileDoneClaims(file, data, now);
    const byId = new Map(data.tasks.map((task) => [task.id, task]));
    const touched = [];
    const skipped = new Map();
    for (const commit of commits) {
      for (const [id, update] of commit.updates) {
        const task = byId.get(id);
        if (!task) continue;
        const claim = config.claims[id];
        if (claim && claimState(claim, task, now) === 'active') {
          skipped.set(id, { id, actor: claim.actor, leaseId: claim.leaseId });
        } else if (applyCommitToTask(task, update, commit.date)) {
          touched.push(describe(task, commit));
        }
      }
    }
    if (touched.length) {
      const errors = validate(data);
      if (errors.length) return { ok: false, message: errors.join('; ') };
      const output = updatePlanMarkdown(raw, data.tasks);
      if (!verifyTaskUpdates(output, data.tasks)) return { ok: false, message: '无法安全写回任务进度，计划未修改' };
      if (output !== raw && !atomicReplaceFile(file, output, revisionOf(raw))) {
        throw new PlanLockError(409, 'CONFLICT', '计划已变化，请刷新后重试');
      }
    }
    return { ok: true, touched, skippedLockedTasks: [...skipped.values()] };
  });
}

// CLI 入口
const isCli = process.argv[1]?.endsWith('sync-git-progress.mjs');
if (isCli) {
  const args = process.argv.slice(2);
  const getArg = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const planFile = getArg('--plan') || 'plan/plan.md';
  const msgFile = getArg('--msg-file');
  const msgText = getArg('--msg');
  const dateOverride = getArg('--date') || todayLocal();

  try {
    const commits = msgFile || msgText !== null
      ? [{ date: dateOverride, updates: parseCommitMessage(msgFile ? readFileSync(msgFile, 'utf8') : msgText) }]
      : readGitCommits();
    const result = syncPlanFromCommits(planFile, commits, {
      describe: (task, { hash }) => `${task.id}${hash ? '@' + hash : ''}(${task.status} ${task.progress}%)`,
    });
    if (!result.ok) throw new Error(result.message);
    for (const { id, actor } of result.skippedLockedTasks) console.error(`跳过 ${id}：${actor} 持有活跃租约`);
    console.log(result.touched.length ? `✓ 已根据 git commit 同步任务进度: ${result.touched.join(', ')}` : '✓ 无需更新任务进度');
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
