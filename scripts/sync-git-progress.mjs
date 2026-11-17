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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseFrontMatter, validate } from './validate-plan.mjs';

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
  let out = planText;
  for (const t of tasks) {
    const idRe = new RegExp(`(  - id: ${t.id}\\r?\\n)([\\s\\S]*?)(?=\\r?\\n  - id: |\\r?\\n---)`);
    const m = out.match(idRe);
    if (!m) continue;
    let block = m[2];
    block = block.replace(/^(\s*status:\s*)([^\s#]+)(.*)$/m, `$1${t.status}$3`);
    block = block.replace(/^(\s*progress:\s*)([^\s#]+)(.*)$/m, `$1${t.progress}$3`);
    block = block.replace(/^(\s*actualStart:\s*)([^\s#]+)(.*)$/m, `$1${t.actualStart ?? 'null'}$3`);
    block = block.replace(/^(\s*actualEnd:\s*)([^\s#]+)(.*)$/m, `$1${t.actualEnd ?? 'null'}$3`);
    out = out.slice(0, m.index) + m[1] + block + out.slice(m.index + m[0].length);
  }
  return out;
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

  if (!existsSync(planFile)) {
    console.error(`✗ 找不到 ${planFile}`);
    process.exit(1);
  }

  const rawPlan = readFileSync(planFile, 'utf8');
  const data = parseFrontMatter(rawPlan);
  if (!data || !Array.isArray(data.tasks)) {
    console.error(`✗ ${planFile} 缺少有效的 YAML front matter`);
    process.exit(1);
  }
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const touched = [];

  if (msgFile || msgText !== null) {
    const content = msgFile ? readFileSync(msgFile, 'utf8') : msgText;
    const updates = parseCommitMessage(content);
    for (const [id, u] of updates) {
      const task = byId.get(id);
      if (task && applyCommitToTask(task, u, dateOverride)) {
        touched.push(`${id}(${task.status} ${task.progress}%)`);
      }
    }
  } else {
    const commits = readGitCommits();
    for (const c of commits) {
      for (const [id, u] of c.updates) {
        const task = byId.get(id);
        if (task && applyCommitToTask(task, u, c.date)) {
          touched.push(`${id}@${c.hash}(${task.status} ${task.progress}%)`);
        }
      }
    }
  }

  if (touched.length === 0) {
    console.log('✓ 无需更新任务进度');
    process.exit(0);
  }

  const errs = validate(data);
  if (errs.length) {
    console.error(`✗ 同步后校验未通过:`, errs.join('; '));
    process.exit(1);
  }

  const nextText = updatePlanMarkdown(rawPlan, data.tasks);
  writeFileSync(planFile, nextText, 'utf8');
  console.log(`✓ 已根据 git commit 同步任务进度: ${touched.join(', ')}`);
}
