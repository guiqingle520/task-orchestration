#!/usr/bin/env node
// 驾驶舱服务: node server/server.mjs  → http://localhost:5173
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, watch, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter, serializePlanMarkdown, validate } from '../scripts/validate-plan.mjs';
import { getTaskCommitsMap, readGitCommits, applyCommitToTask, updatePlanMarkdown, verifyTaskUpdates } from '../scripts/sync-git-progress.mjs';
import { createWorkspaces } from './workspaces.mjs';
import { createWebhookService } from './webhooks.mjs';
import { compute } from '../web/metrics.js';
import { buildReport } from '../web/analysis.js';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const webDir = join(root, 'web');
const port = Number(process.env.PORT || 5173);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const clients = new Map();
const workspaces = createWorkspaces(root);
const webhooks = createWebhookService(root);
const revisionOf = (text) => createHash('sha256').update(text).digest('hex');
const watchers = new Map();

// 监听目录以兼容编辑器通过重命名替换 plan.md 的保存方式。
function watchProject(project) {
  if (watchers.has(project.id)) return;
  let timer;
  try {
    const watcher = watch(dirname(project.planPath), (_event, filename) => {
      if (filename && String(filename) !== project.planPath.split(/[\\/]/).at(-1)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const [client, id] of clients) if (id === project.id) client.write('event: plan-change\ndata: changed\n\n');
        try {
          const event = notificationEvent(project, 'risks');
          void webhooks.notify(project.id, event, 'all', true).catch(() => console.error('自动预警失败'));
        } catch { console.error('无法生成自动预警'); }
      }, 150);
    });
    watcher.on('error', (err) => console.error('计划文件监听失败:', err.message));
    watchers.set(project.id, watcher);
  } catch (err) { console.error('计划文件监听失败:', err.message); }
}
for (const project of workspaces.read().projects) watchProject(project);

function loadPlan(project) {
  const planFile = project.planPath;
  if (!existsSync(planFile)) return { error: ['找不到 plan/plan.md'] };
  try {
    const raw = readFileSync(planFile, 'utf8');
    const data = parseFrontMatter(raw);
    if (!data) return { error: ['plan.md 缺少 YAML front matter'] };
    return { data, revision: revisionOf(raw), commits: getTaskCommitsMap(project.repoRoot) };
  } catch (e) {
    return { error: [e.message] };
  }
}

function syncFromGit(project) {
  const planFile = project.planPath;
  if (!existsSync(planFile)) return { ok: false, message: '找不到 plan/plan.md' };
  const raw = readFileSync(planFile, 'utf8');
  const data = parseFrontMatter(raw);
  if (!data || !Array.isArray(data.tasks)) return { ok: false, message: 'plan.md 格式错误' };
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const touched = [];
  for (const c of readGitCommits(project.repoRoot)) {
    for (const [id, u] of c.updates) {
      const t = byId.get(id);
      if (t && applyCommitToTask(t, u, c.date)) touched.push(`${id}@${c.hash}`);
    }
  }
  if (touched.length) {
    const errs = validate(data);
    if (errs.length) return { ok: false, message: errs.join('; ') };
    const output = updatePlanMarkdown(raw, data.tasks);
    if (!verifyTaskUpdates(output, data.tasks)) return { ok: false, message: '无法安全写回任务进度，计划未修改' };
    writeFileSync(planFile, output, 'utf8');
  }
  return { ok: true, touched };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function notificationEvent(project, mode) {
  const loaded = loadPlan(project);
  if (!loaded.data || validate(loaded.data).length) throw new Error('项目计划无效');
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const metrics = compute(loaded.data, today);
  const report = buildReport(loaded.data, metrics, today);
  const risks = metrics.risks.filter((risk) => risk.level === 'red');
  const markdown = mode === 'report' ? report.markdown : [`# ${loaded.data.project} 风险预警`, '', ...(risks.length ? risks.map((risk) => `- ${risk.id}：${risk.text}`) : ['暂无红色风险'])].join('\n');
  return { project: loaded.data.project, today, summary: report.summary, risks, markdown, timestamp: now.toISOString() };
}

function updateTask(body, project) {
  const planFile = project.planPath;
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
  const output = updatePlanMarkdown(raw, [task]);
  if (!verifyTaskUpdates(output, [task])) throw new Error('无法安全写回任务进度，计划未修改');
  if (output !== raw) writeFileSync(planFile, output, 'utf8');
  return { ok: true, task };
}

function savePlan(body, project) {
  const planFile = project.planPath;
  const raw = readFileSync(planFile, 'utf8');
  if (typeof body.expectedRevision !== 'string' || body.expectedRevision !== revisionOf(raw)) return { conflict: true, message: '计划已变化或缺少版本，请刷新后重试' };
  const before = parseFrontMatter(raw);
  if (!before || validate(before).length) throw new Error('当前计划无效，请先修复');
  if (Object.keys(before).some((key) => !['project', 'milestones', 'tasks'].includes(key))) throw new Error('现有计划含不支持的字段，无法安全重写');
  const next = { project: body.project, milestones: body.milestones, tasks: body.tasks };
  const errors = validate(next);
  if (errors.length) return { errors, message: errors.join('; ') };
  const structure = (data) => ({ project: data.project, milestones: data.milestones, tasks: data.tasks.map(({ id, title, owner, milestone, start, end, deps }) => ({ id, title, owner, milestone, start, end, deps })) });
  const changed = JSON.stringify(structure(before)) !== JSON.stringify(structure(next));
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (changed && (reason.length < 2 || /[\r\n]/.test(reason))) throw new Error('修改排期或任务结构必须填写单行变更原因');
  const output = serializePlanMarkdown(next, raw, changed ? reason : null);
  const temporary = `${planFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, output, { encoding: 'utf8', flag: 'wx' });
    if (revisionOf(readFileSync(planFile, 'utf8')) !== body.expectedRevision) return { conflict: true, message: '计划已变化，请刷新后重试' };
    renameSync(temporary, planFile);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return { ok: true, data: next, revision: revisionOf(output) };
}

createServer((req, res) => {
  const host = req.headers.host || '';
  if (!new RegExp(`^(?:localhost|127\\.0\\.0\\.1):${port}$`, 'i').test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(res, 403, { message: '仅允许本机同源访问' });
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    try {
      const registry = workspaces.read();
      const now = new Date();
      const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const projects = registry.projects.map((project) => {
        const loaded = loadPlan(project);
        if (!loaded.data || validate(loaded.data).length) return { ...project, health: 'unavailable', overall: null, taskCount: 0 };
        const metrics = compute(loaded.data, today);
        return { ...project, health: metrics.summary.health, overall: metrics.summary.overall, taskCount: loaded.data.tasks.length };
      });
      return json(res, 200, { default: registry.default, projects });
    } catch (err) { return json(res, 500, { message: err.message }); }
  }
  if (url.pathname === '/api/projects' && req.method === 'POST') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { message: '请求格式错误' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      try { const project = workspaces.add(JSON.parse(body)); watchProject(project); json(res, 200, { ok: true, project }); }
      catch (err) { json(res, 400, { message: err.message }); }
    });
    return;
  }
  let project;
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/webhooks') {
    try { project = workspaces.get(url.searchParams.get('project')); }
    catch (err) { return json(res, 404, { message: err.message }); }
  }
  if (url.pathname === '/api/webhooks' && req.method === 'GET') {
    try { return json(res, 200, { channels: webhooks.list() }); }
    catch { return json(res, 500, { message: '无法读取渠道配置' }); }
  }
  if (url.pathname === '/api/webhooks' && req.method === 'POST') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { message: '请求格式错误' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 262144) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const projectIds = workspaces.read().projects.map(({ id }) => id);
        json(res, 200, { ok: true, channels: webhooks.save(Array.isArray(parsed) ? parsed : parsed.channels, projectIds) });
      }
      catch { json(res, 400, { message: '渠道配置无效或无法保存' }); }
    });
    return;
  }
  if (url.pathname === '/api/notify' && req.method === 'POST') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { message: '请求格式错误' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 16384) req.destroy(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (!['risks', 'report'].includes(payload.mode) || typeof payload.channelId !== 'string') throw new Error('请求无效');
        const event = notificationEvent(project, payload.mode);
        json(res, 200, await webhooks.notify(project.id, event, payload.channelId));
      } catch { json(res, 400, { message: '推送请求无效或项目不可用' }); }
    });
    return;
  }
  if (url.pathname === '/api/events' && req.method === 'GET') {
    watchProject(project);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('event: plan-change\ndata: connected\n\n');
    clients.set(res, project.id);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
    return;
  }
  if (url.pathname === '/api/plan') {
    if (existsSync(project.planPath)) watchProject(project);
    const r = loadPlan(project);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ...r, projectId: project.id, errors: r.data ? validate(r.data) : r.error }));
  }
  if (url.pathname === '/api/task' && req.method === 'POST') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { message: '请求格式错误' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      try { const result = updateTask(JSON.parse(body), project); json(res, result.conflict ? 409 : 200, result); }
      catch (err) { json(res, 400, { message: err.message }); }
    });
    return;
  }
  if (url.pathname === '/api/plan/save' && req.method === 'POST') {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { message: '请求格式错误' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const result = savePlan(JSON.parse(body), project);
        json(res, result.conflict ? 409 : result.errors ? 400 : 200, result);
      } catch (err) { json(res, 400, { message: err.message }); }
    });
    return;
  }
  if (url.pathname === '/api/sync-git' && req.method === 'POST') {
    const out = syncFromGit(project);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/, '');
  const file = join(webDir, rel);
  if (!file.startsWith(webDir) || !existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log(`驾驶舱运行于 http://localhost:${port}`));
