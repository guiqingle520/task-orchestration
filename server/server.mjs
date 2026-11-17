#!/usr/bin/env node
// 驾驶舱服务: node server/server.mjs  → http://localhost:5173
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, watch } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter, validate } from '../scripts/validate-plan.mjs';
import { getTaskCommitsMap, readGitCommits, applyCommitToTask, updatePlanMarkdown } from '../scripts/sync-git-progress.mjs';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const planFile = join(root, 'plan', 'plan.md');
const webDir = join(root, 'web');
const port = Number(process.env.PORT || 5173);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const clients = new Set();
let changeTimer;

// 监听目录以兼容编辑器通过重命名替换 plan.md 的保存方式。
try {
  const watcher = watch(join(root, 'plan'), (_event, filename) => {
    if (filename && String(filename) !== 'plan.md') return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      for (const client of clients) client.write('event: plan-change\ndata: changed\n\n');
    }, 150);
  });
  watcher.on('error', (err) => console.error('计划文件监听失败:', err.message));
} catch (err) {
  console.error('计划文件监听失败:', err.message);
}

function loadPlan() {
  if (!existsSync(planFile)) return { error: ['找不到 plan/plan.md'] };
  try {
    const data = parseFrontMatter(readFileSync(planFile, 'utf8'));
    if (!data) return { error: ['plan.md 缺少 YAML front matter'] };
    return { data, commits: getTaskCommitsMap(root) };
  } catch (e) {
    return { error: [e.message] };
  }
}

function syncFromGit() {
  if (!existsSync(planFile)) return { ok: false, message: '找不到 plan/plan.md' };
  const raw = readFileSync(planFile, 'utf8');
  const data = parseFrontMatter(raw);
  if (!data || !Array.isArray(data.tasks)) return { ok: false, message: 'plan.md 格式错误' };
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const touched = [];
  for (const c of readGitCommits(root)) {
    for (const [id, u] of c.updates) {
      const t = byId.get(id);
      if (t && applyCommitToTask(t, u, c.date)) touched.push(`${id}@${c.hash}`);
    }
  }
  if (touched.length) {
    const errs = validate(data);
    if (errs.length) return { ok: false, message: errs.join('; ') };
    writeFileSync(planFile, updatePlanMarkdown(raw, data.tasks), 'utf8');
  }
  return { ok: true, touched };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function updateTask(body) {
  const raw = readFileSync(planFile, 'utf8');
  const data = parseFrontMatter(raw);
  if (!data || validate(data).length) throw new Error('当前计划无效，请先修复');
  const task = data.tasks.find((item) => item.id === body.id);
  if (!task) throw new Error('任务不存在');
  const fields = ['status', 'progress', 'actualStart', 'actualEnd'];
  if (!body.expected || fields.some((key) => task[key] !== body.expected[key])) return { conflict: true, message: '任务已被其他操作修改，请刷新后重试' };
  if (!['todo', 'doing', 'blocked', 'done'].includes(body.status) || !Number.isInteger(body.progress) || body.progress < 0 || body.progress > 100) throw new Error('状态或进度无效');
  if ((body.status === 'todo' && body.progress !== 0) || (body.status === 'done' && body.progress !== 100)) throw new Error('未开始任务进度必须为 0，已完成任务必须为 100');
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  task.status = body.status;
  task.progress = body.progress;
  if (task.status === 'todo') { task.actualStart = null; task.actualEnd = null; }
  else { task.actualStart ||= today; task.actualEnd = task.status === 'done' ? (task.actualEnd || today) : null; }
  const errors = validate(data);
  if (errors.length) throw new Error(errors.join('; '));
  writeFileSync(planFile, updatePlanMarkdown(raw, [task]), 'utf8');
  return { ok: true, task };
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('event: plan-change\ndata: connected\n\n');
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
    return;
  }
  if (url.pathname === '/api/plan') {
    const r = loadPlan();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ...r, errors: r.data ? validate(r.data) : r.error }));
  }
  if (url.pathname === '/api/task' && req.method === 'POST') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { message: '请求格式错误' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      try { const result = updateTask(JSON.parse(body)); json(res, result.conflict ? 409 : 200, result); }
      catch (err) { json(res, 400, { message: err.message }); }
    });
    return;
  }
  if (url.pathname === '/api/sync-git' && req.method === 'POST') {
    const out = syncFromGit();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/, '');
  const file = join(webDir, rel);
  if (!file.startsWith(webDir) || !existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`驾驶舱运行于 http://localhost:${port}`));
