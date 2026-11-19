#!/usr/bin/env node
// 驾驶舱服务: node server/server.mjs  → http://localhost:5173
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, watch, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter, serializePlanMarkdown, validate } from '../scripts/validate-plan.mjs';
import { getTaskCommitsMap, parseCommitMessage, readGitCommits, applyCommitToTask, updatePlanMarkdown, verifyTaskUpdates } from '../scripts/sync-git-progress.mjs';
import { createWorkspaces } from './workspaces.mjs';
import { extractAcceptanceByTask } from './plan-acceptance.mjs';
import { summarizeProject, validPortfolioDate } from './portfolio.mjs';
import { createWebhookService } from './webhooks.mjs';
import { getPlanAtCommit, HistoryError, listPlanHistory, summarizePlanFrame } from './history.mjs';
import { buildStandaloneHtml, ExportInputError, normalizeExportOptions } from './exporter.mjs';
import { CapacityConfigError, normalizeCapacityConfig, readCapacityConfig, writeCapacityConfig } from './capacity.mjs';
import { createIntegrationService, IntegrationError } from './integrations.mjs';
import { createFolderPicker, FolderPickerError } from './folder-picker.mjs';
import { compute, findNewDependencyConflicts } from '../web/metrics.js';
import { buildReport, computeCapacityMetrics, computeTimelineDiff } from '../web/analysis.js';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const webDir = join(root, 'web');
const port = Number(process.env.PORT || 5173);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const clients = new Map();
const workspaces = createWorkspaces(root);
const pickFolder = createFolderPicker();
const webhooks = createWebhookService(root);
const integrations = createIntegrationService(root, {
  today: dashboardToday,
  readPlan(project) {
    let current;
    try { current = workspaces.get(project.id); } catch { return null; }
    if (current.planPath !== project.planPath || current.repoRoot !== project.repoRoot) return null;
    return readPlanSnapshot(current, { includeRaw: true });
  },
});
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

function readPlanSnapshot(project, { includeRaw = false } = {}) {
  const planFile = project.planPath;
  if (!existsSync(planFile)) return { error: ['找不到 plan/plan.md'] };
  try {
    const raw = readFileSync(planFile, 'utf8');
    const data = parseFrontMatter(raw);
    if (!data) return { error: ['plan.md 缺少 YAML front matter'] };
    return { data, revision: revisionOf(raw), ...(includeRaw ? { raw } : {}) };
  } catch (e) {
    return { error: [e.message] };
  }
}

function loadPlan(project) {
  const { raw, ...snapshot } = readPlanSnapshot(project, { includeRaw: true });
  if (!snapshot.data) return snapshot;
  return { ...snapshot, acceptanceByTask: extractAcceptanceByTask(raw), commits: getTaskCommitsMap(project.repoRoot) };
}

function writePlanAtomically(planFile, output, expectedRevision = null) {
  const temporary = `${planFile}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, output, { encoding: 'utf8', flag: 'wx' });
    if (expectedRevision !== null && revisionOf(readFileSync(planFile, 'utf8')) !== expectedRevision) return false;
    renameSync(temporary, planFile);
    return true;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
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
    writePlanAtomically(planFile, output);
  }
  return { ok: true, touched };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function dashboardToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function withJsonBody(req, res, limit, handle) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { message: '请求格式错误' });
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    if (size > limit) return;
    size += chunk.length;
    if (size > limit) { chunks.length = 0; json(res, 413, { message: '请求内容过大' }); }
    else chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > limit) return;
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return json(res, 400, { message: 'JSON 请求内容无效' }); }
    handle(input);
  });
}

async function exportPlanHtml(res, project, input) {
  try {
    const exportedOn = dashboardToday();
    const options = normalizeExportOptions(input, exportedOn);
    const { data } = readPlanSnapshot(project);
    if (!data || validate(data).length) return json(res, 400, { message: '当前计划无效，无法导出' });
    let commits;
    if (!options.maskOwners && !options.stripInternalNotes) {
      const history = await listPlanHistory(project).catch(() => []);
      commits = {};
      for (const { shortHash: hash, date, subject } of history) {
        for (const id of parseCommitMessage(subject).keys()) (commits[id] ??= []).push({ hash, date, subject });
      }
    }
    const html = buildStandaloneHtml({ plan: data, today: options.today, exportedOn, commits }, options);
    return json(res, 200, { ok: true, filename: 'task-orchestration-' + options.today + '.html', html });
  } catch (err) {
    return err instanceof ExportInputError ? json(res, 400, { message: err.message })
      : json(res, 500, { message: '无法生成离线驾驶舱' });
  }
}

function serveCapacity(res, project, input) {
  const saving = input !== undefined;
  try {
    const { data } = readPlanSnapshot(project);
    if (!data || validate(data).length) return json(res, 400, { message: '当前计划无效，无法核算工时' });
    const config = saving ? normalizeCapacityConfig(input) : readCapacityConfig(project);
    const metrics = computeCapacityMetrics(data, config, dashboardToday());
    if (saving) writeCapacityConfig(project, config);
    return json(res, 200, { ...(saving ? { ok: true } : {}), projectId: project.id, config, metrics });
  } catch (err) {
    if (saving && err instanceof CapacityConfigError) return json(res, 400, { message: err.message });
    return json(res, 500, { message: saving ? '无法保存工时配置' : '无法读取工时配置' });
  }
}

async function serveIntegrations(res, project, action, input) {
  try {
    const result = action === 'sync' ? await integrations.synchronize(project, input)
      : action === 'save' ? integrations.save(project.id, input) : integrations.get(project.id);
    return json(res, 200, action === 'save' ? { ok: true, ...result } : result);
  } catch (err) {
    if (err instanceof IntegrationError) return json(res, err.status, { message: err.message, code: err.code });
    return json(res, 500, { message: '无法读取或保存平台集成配置' });
  }
}

async function serveHistory(res, project, params) {
  try {
    const rev = params.get('rev');
    const limit = params.get('limit');
    const historical = rev === null ? null : await getPlanAtCommit(project, rev);
    const commits = historical ? null : await listPlanHistory(project, limit === null ? undefined : /^\d+$/.test(limit) ? Number(limit) : NaN);
    // Git 读取期间工作树可能更新。版本与 diff 始终使用同一次当前计划读取。
    let currentProject;
    try { currentProject = workspaces.get(project.id); }
    catch { return json(res, 409, { message: '项目路径已变化，请重新加载历史' }); }
    if (currentProject.repoRoot !== project.repoRoot || currentProject.planPath !== project.planPath) {
      return json(res, 409, { message: '项目路径已变化，请重新加载历史' });
    }
    const snapshot = readPlanSnapshot(currentProject);
    const current = snapshot.data && !validate(snapshot.data).length ? snapshot : null;
    if (historical) return json(res, 200, {
      projectId: project.id, ...historical, currentRevision: current?.revision ?? null,
      diff: current ? computeTimelineDiff(historical.data, current.data) : null,
    });
    const today = dashboardToday();
    return json(res, 200, {
      projectId: project.id, commits,
      current: current ? { revision: current.revision, ...summarizePlanFrame(current.data, today) } : null,
    });
  } catch (err) {
    return err instanceof HistoryError ? json(res, err.status, { message: err.message })
      : json(res, 500, { message: '无法读取 Git 历史计划' });
  }
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
  if (output !== raw && !writePlanAtomically(planFile, output, revisionOf(raw))) return { conflict: true, message: '任务已被其他操作修改，请刷新后重试' };
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
  const conflicts = findNewDependencyConflicts(before, next);
  if (conflicts.length) {
    const { upstreamId, downstreamId, upstreamEnd, downstreamStart } = conflicts[0];
    return { code: 'DEPENDENCY_CONFLICT', message: `${downstreamId} 开始于 ${downstreamStart}，早于前置任务 ${upstreamId} 的结束日 ${upstreamEnd}`, conflicts };
  }
  const structure = (data) => ({ project: data.project, milestones: data.milestones, tasks: data.tasks.map(({ id, title, owner, milestone, start, end, deps }) => ({ id, title, owner, milestone, start, end, deps })) });
  const changed = JSON.stringify(structure(before)) !== JSON.stringify(structure(next));
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (changed && (reason.length < 2 || /[\r\n]/.test(reason))) throw new Error('修改排期或任务结构必须填写单行变更原因');
  const output = serializePlanMarkdown(next, raw, changed ? reason : null);
  if (!writePlanAtomically(planFile, output, body.expectedRevision)) return { conflict: true, message: '计划已变化，请刷新后重试' };
  return { ok: true, data: next, revision: revisionOf(output) };
}

createServer((req, res) => {
  const host = req.headers.host || '';
  if (!new RegExp(`^(?:localhost|127\\.0\\.0\\.1):${port}$`, 'i').test(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(res, 403, { message: '仅允许本机同源访问' });
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/portfolio' && req.method === 'GET') {
    const today = url.searchParams.get('today') ?? dashboardToday();
    if (!validPortfolioDate(today)) return json(res, 400, { message: '统计日必须是有效的 YYYY-MM-DD 日期' });
    try {
      const registry = workspaces.read();
      const readRegisteredPlan = ({ id }) => readPlanSnapshot(workspaces.get(id, registry));
      const projects = registry.projects.map(project => summarizeProject(project, today, readRegisteredPlan));
      return json(res, 200, { today, default: registry.default, projects });
    } catch { return json(res, 500, { message: '无法读取工作区项目列表' }); }
  }
  if (url.pathname === '/api/projects' && req.method === 'GET') {
    try {
      const registry = workspaces.read();
      const today = dashboardToday();
      const projects = registry.projects.map((project) => {
        const loaded = readPlanSnapshot(project);
        if (!loaded.data || validate(loaded.data).length) return { ...project, health: 'unavailable', overall: null, taskCount: 0 };
        const metrics = compute(loaded.data, today);
        return { ...project, health: metrics.summary.health, overall: metrics.summary.overall, taskCount: loaded.data.tasks.length };
      });
      return json(res, 200, { default: registry.default, projects });
    } catch (err) { return json(res, 500, { message: err.message }); }
  }
  if (url.pathname === '/api/projects/preflight' && req.method === 'POST') {
    return withJsonBody(req, res, 16 * 1024, (input) => {
      try { json(res, 200, workspaces.preflight(input)); }
      catch (err) { json(res, 400, { message: err.message }); }
    });
  }
  if (url.pathname === '/api/projects' && req.method === 'POST') {
    return withJsonBody(req, res, 16 * 1024, (input) => {
      try { const added = workspaces.add(input); watchProject(added); json(res, 200, { ok: true, project: added }); }
      catch (err) { json(res, 400, { message: err.message }); }
    });
  }
  if (url.pathname === '/api/projects/pick-directory' && req.method === 'POST') {
    return withJsonBody(req, res, 4 * 1024, (input) => {
      if (input?.warmup === true) {
        pickFolder.warmup?.();
        return json(res, 200, { ok: true, warmed: true });
      }
      void (async () => {
        try {
          const initialPath = typeof input?.initialPath === 'string' ? input.initialPath : '';
          const picked = await pickFolder({ initialPath });
          json(res, 200, { ok: true, ...picked });
        } catch (err) {
          json(res, err instanceof FolderPickerError ? err.status : 500, { message: err.message || '无法打开文件夹选择器' });
        }
      })();
    });
  }
  let project;
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/webhooks') {
    try { project = workspaces.get(url.searchParams.get('project')); }
    catch (err) { return json(res, 404, { message: err.message }); }
  }
  if (url.pathname === '/api/history' && req.method === 'GET') {
    return void serveHistory(res, project, url.searchParams);
  }
  if (url.pathname === '/api/export/html' && req.method === 'POST') {
    return withJsonBody(req, res, 16 * 1024, (input) => { void exportPlanHtml(res, project, input); });
  }
  if (url.pathname === '/api/capacity') {
    if (req.method === 'GET') return serveCapacity(res, project);
    if (req.method === 'POST') return withJsonBody(req, res, 256 * 1024, (input) => serveCapacity(res, project, input));
  }
  if (url.pathname === '/api/integrations') {
    if (req.method === 'GET') return void serveIntegrations(res, project, 'get');
    if (req.method === 'POST') return withJsonBody(req, res, 16 * 1024, (input) => { void serveIntegrations(res, project, 'save', input); });
  }
  if (url.pathname === '/api/integrations/sync' && req.method === 'POST') {
    return withJsonBody(req, res, 64 * 1024, (input) => { void serveIntegrations(res, project, 'sync', input); });
  }
  if (url.pathname === '/api/webhooks' && req.method === 'GET') {
    try { return json(res, 200, { channels: webhooks.list() }); }
    catch { return json(res, 500, { message: '无法读取渠道配置' }); }
  }
  if (url.pathname === '/api/webhooks' && req.method === 'POST') {
    return withJsonBody(req, res, 256 * 1024, (parsed) => {
      try {
        const projectIds = workspaces.read().projects.map(({ id }) => id);
        json(res, 200, { ok: true, channels: webhooks.save(Array.isArray(parsed) ? parsed : parsed.channels, projectIds) });
      } catch { json(res, 400, { message: '渠道配置无效或无法保存' }); }
    });
  }
  if (url.pathname === '/api/notify' && req.method === 'POST') {
    return withJsonBody(req, res, 16 * 1024, (payload) => {
      void (async () => {
        try {
          if (!payload || !['risks', 'report'].includes(payload.mode) || typeof payload.channelId !== 'string') throw new Error('请求无效');
          const event = notificationEvent(project, payload.mode);
          json(res, 200, await webhooks.notify(project.id, event, payload.channelId));
        } catch { json(res, 400, { message: '推送请求无效或项目不可用' }); }
      })();
    });
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
  if (url.pathname === '/api/plan' && req.method === 'GET') {
    if (existsSync(project.planPath)) watchProject(project);
    const r = loadPlan(project);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ...r, projectId: project.id, errors: r.data ? validate(r.data) : r.error }));
  }
  if (url.pathname === '/api/task' && req.method === 'POST') {
    return withJsonBody(req, res, 16 * 1024, (input) => {
      try { const result = updateTask(input, project); json(res, result.conflict ? 409 : 200, result); }
      catch (err) { json(res, 400, { message: err.message }); }
    });
  }
  if (url.pathname === '/api/plan/save' && req.method === 'POST') {
    return withJsonBody(req, res, 1024 * 1024, (input) => {
      try {
        const result = savePlan(input, project);
        json(res, result.conflict ? 409 : result.errors || result.code === 'DEPENDENCY_CONFLICT' ? 400 : 200, result);
      } catch (err) { json(res, 400, { message: err.message }); }
    });
  }
  if (url.pathname === '/api/sync-git' && req.method === 'POST') {
    const out = syncFromGit(project);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(404); return res.end('Not found'); }
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  const rel = normalize(decodedPath === '/' ? '/index.html' : decodedPath).replace(/^([/\\])+/, '');
  const file = join(webDir, rel);
  const inside = relative(webDir, file);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) { res.writeHead(404); return res.end('Not found'); }
  let stat;
  try { stat = statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
}).listen(port, '127.0.0.1', () => console.log(`驾驶舱运行于 http://localhost:${port}`));
