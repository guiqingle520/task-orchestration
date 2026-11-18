import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '../scripts/validate-plan.mjs';
import { updatePlanMarkdown, verifyTaskUpdates } from '../scripts/sync-git-progress.mjs';
import { IntegrationError, issueApiBase, sendIssueRequest } from './issue-transport.mjs';

export { IntegrationError };
const fields = ['status', 'progress', 'actualStart', 'actualEnd'];
const defaults = { github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4' };
const idPattern = /^T-\d+$/;
const stateLabels = ['status:blocked', 'status:doing'];
const hash = (data) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const stale = () => new IntegrationError(409, '预览已失效，请重新预览后再确认同步', 'SYNC_PREVIEW_STALE');
const badRemote = () => new IntegrationError(502, '平台返回了无效的 Issue 数据');
const marker = /<!-- task-orchestration:([\w-]+):(T-\d+) -->/;

function safeIssueUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return ''; }
}

export function buildIssuePayload(provider, task, milestone) {
  if (!Object.hasOwn(defaults, provider)) throw new IntegrationError(400, '不支持的 Issue 平台');
  const source = [
    '负责人：' + task.owner, '里程碑：' + task.milestone + (milestone?.name ? ' · ' + milestone.name : ''),
    '计划：' + task.start + ' ～ ' + task.end, '依赖：' + (task.deps.join('、') || '无'),
    '进度：' + task.progress + '%',
  ].join('\n');
  return {
    title: '[' + task.id + '] ' + task.title, body: source,
    state: task.status === 'done' ? 'closed' : 'open',
    labels: ['task-orchestration', 'milestone:' + task.milestone, 'status:' + task.status],
  };
}

function getIssueForTask(task, issues, issueMap, projectId) {
  const bound = issueMap[task.id];
  const otherBindings = new Set(Object.entries(issueMap).filter(([id]) => id !== task.id).map(([, issue]) => issue.number));
  const candidates = issues.filter((issue) => {
    const managed = marker.exec(issue.body);
    if (managed && projectId && (managed[1] !== projectId || managed[2] !== task.id)) return false;
    if (bound) return issue.number === bound.number;
    if (otherBindings.has(issue.number)) return false;
    return managed && projectId ? managed[2] === task.id : /^\[(T-\d+)\]\s*\S/.exec(issue.title)?.[1] === task.id;
  });
  return { issue: candidates.length === 1 ? candidates[0] : null, ambiguous: candidates.length > 1, bound };
}

function taskState(task) { return Object.fromEntries(fields.map((field) => [field, task[field] ?? null])); }

export function reconcileIssuesWithPlan(plan, remoteIssues, issueMap = {}, todayStr, { projectId } = {}) {
  const proposedUpdates = [], skippedConflicts = [], bindings = {}, remoteState = [];
  for (const task of plan.tasks) {
    const { issue, ambiguous, bound } = getIssueForTask(task, remoteIssues, issueMap, projectId);
    // 预览比较包括匹配关系和参与裁决的状态/标签，不受无关标题或备注变动影响。
    remoteState.push([task.id, issue?.number ?? null, issue?.state ?? null,
      stateLabels.filter((label) => issue?.labels.includes(label)), issue?.url ?? null, ambiguous]);
    if (ambiguous || (bound && !issue)) {
      skippedConflicts.push({ id: task.id, reason: ambiguous ? '多个 Issue 匹配该任务，未自动绑定' : '已绑定的 Issue 不可用' });
      continue;
    }
    if (!issue) continue;
    bindings[task.id] = { number: issue.number, url: issue.url, state: issue.state };
    if (task.status === 'done') {
      if (issue.state === 'open' || stateLabels.some((label) => issue.labels.includes(label))) {
        skippedConflicts.push({ id: task.id, number: issue.number, localStatus: 'done', remoteState: issue.state, reason: '本地任务已完成，不自动回退状态' });
      }
      continue;
    }
    const before = taskState(task), after = { ...before };
    if (issue.state === 'closed') Object.assign(after, { status: 'done', progress: 100, actualStart: before.actualStart ?? todayStr, actualEnd: todayStr });
    else if (issue.labels.includes('status:blocked')) {
      after.status = 'blocked';
      if (task.status === 'todo') after.actualStart ??= todayStr;
    } else if (issue.labels.includes('status:doing') && task.status === 'todo') {
      Object.assign(after, { status: 'doing', progress: Math.max(10, task.progress), actualStart: todayStr });
    }
    if (fields.some((field) => before[field] !== after[field])) proposedUpdates.push({ id: task.id, number: issue.number, before, after });
  }
  return { proposedUpdates, skippedConflicts, bindings, remoteState };
}

export function createIssueAdapter(config, transport = sendIssueRequest) {
  const github = config.provider === 'github';
  const repo = github ? config.repo.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(config.repo);
  const endpoint = config.apiBase + (github ? '/repos/' : '/projects/') + repo + '/issues';
  const request = (method, suffix, body) => transport(config, { method, url: endpoint + suffix, body });
  const normalized = (item) => {
    if (github && item?.pull_request) return null;
    const number = github ? item?.number : item?.iid;
    const url = safeIssueUrl(github ? item?.html_url : item?.web_url);
    const state = item?.state === 'closed' ? 'closed' : ['open', 'opened', 'reopened'].includes(item?.state) ? 'open' : null;
    if (!Number.isSafeInteger(number) || number <= 0 || !state || !url || typeof item.title !== 'string') throw badRemote();
    return {
      number, url, state, title: item.title, body: typeof (github ? item.body : item.description) === 'string' ? (github ? item.body : item.description) : '',
      labels: Array.isArray(item.labels) ? item.labels.map((label) => typeof label === 'string' ? label : label?.name).filter((label) => typeof label === 'string') : [],
    };
  };
  async function list() {
    const result = new Map();
    for (let page = 1; page <= 20; page++) {
      const { data, headers = {} } = await request('GET', '?state=all&per_page=100&page=' + page + (github ? '' : '&scope=all&issue_type=issue'));
      if (!Array.isArray(data)) throw badRemote();
      for (const item of data) {
        const issue = normalized(item);
        if (issue) result.set(issue.number, issue);
      }
      if (!/rel="next"/i.test(headers.link || '') && !headers['x-next-page'] && data.length < 100) return [...result.values()];
    }
    throw new IntegrationError(502, 'Issue 数量超过单次同步范围，未写入任何变更');
  }
  const write = async (method, suffix, body) => {
    const { data } = await request(method, suffix, body);
    const issue = normalized(data);
    if (!issue) throw badRemote();
    return issue;
  };
  const payload = ({ title, body, labels }) => github ? { title, body, labels } : { title, description: body, labels: labels.join(',') };
  return {
    list,
    create: (draft) => write('POST', '', payload(draft)),
    update: (issue, draft) => {
      const data = payload(draft);
      // GitHub 的 state 与 GitLab 的 state_event 分开编码；没有状态变化时不发送。
      if (draft.state !== issue.state) {
        if (github) data.state = draft.state;
        else data.state_event = draft.state === 'closed' ? 'close' : 'reopen';
      }
      return write(github ? 'PATCH' : 'PUT', '/' + issue.number, data);
    },
  };
}

function atomicWrite(file, data) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* retain original error */ }
    throw err;
  }
}

function publicIssueMap(map) {
  return Object.fromEntries(Object.entries(map ?? {}).flatMap(([id, issue]) => {
    const url = safeIssueUrl(issue?.url);
    if (!idPattern.test(id) || !Number.isSafeInteger(issue?.number) || issue.number <= 0 || !url || !['open', 'closed'].includes(issue.state)) return [];
    return [[id, { number: issue.number, state: issue.state, url, syncedAt: issue.syncedAt }]];
  }));
}

function safeConfig(config) {
  return {
    provider: config?.provider ?? 'github', apiBase: config?.apiBase ?? defaults.github, repo: config?.repo ?? '',
    enabled: config?.enabled ?? false, token: '', tokenConfigured: Boolean(config?.token), issueMap: publicIssueMap(config?.issueMap),
  };
}

export function createIntegrationService(root, { readPlan, transport = sendIssueRequest, now = () => Date.now(), today } = {}) {
  const file = join(root, 'plan', 'integrations.json');
  const previews = new Map(), inFlight = new Set();
  const read = () => {
    try {
      if (!lstatSync(file).isFile()) throw new Error('集成配置须为普通文件');
      const state = JSON.parse(readFileSync(file, 'utf8'));
      if (!state.projects || typeof state.projects !== 'object' || Array.isArray(state.projects)) throw new Error('集成配置无效');
      return state;
    } catch (err) { if (err.code === 'ENOENT') return { projects: {} }; throw err; }
  };
  const write = (state) => atomicWrite(file, JSON.stringify(state, null, 2) + '\n');
  const get = (id) => { const all = read().projects; return Object.hasOwn(all, id) ? all[id] : null; };
  const target = ({ provider, apiBase, repo, token, enabled }) => hash([provider, apiBase, repo, token, enabled]);
  const bindingKey = (config, ids) => hash(ids.map((id) => config.issueMap[id] ?? null));
  const applyBindings = (projectId, config, bindings) => {
    const state = read(), current = state.projects[projectId];
    if (!current || target(current) !== target(config)) throw stale();
    if (!Object.keys(bindings).length) return current.issueMap;
    const stamp = new Date(now()).toISOString();
    current.issueMap = { ...current.issueMap, ...Object.fromEntries(Object.entries(bindings).map(([id, issue]) => [id, { ...issue, syncedAt: stamp }])) };
    write(state);
    return current.issueMap;
  };
  function save(projectId, input) {
    if (inFlight.has(projectId)) throw new IntegrationError(409, '此项目正在同步，请稍后保存配置');
    const { provider, repo, enabled, token = '' } = input ?? {};
    if (!Object.hasOwn(defaults, provider) || typeof repo !== 'string' || repo.length > 255 || typeof enabled !== 'boolean'
      || typeof token !== 'string' || token.length > 4096 || /[^\x21-\x7e]/.test(token)) {
      throw new IntegrationError(400, '平台配置字段无效');
    }
    const slug = repo.trim();
    const isPath = /^(?:[\w.-]+\/)+[\w.-]+$/.test(slug) && !slug.split('/').some((part) => part === '..' || part === '.');
    if ((enabled || slug) && !(provider === 'github' ? isPath && slug.split('/').length === 2 : isPath || /^\d+$/.test(slug))) {
      throw new IntegrationError(400, '仓库标识须为所有者/仓库，GitLab 也支持项目 ID');
    }
    if (input.apiBase != null && typeof input.apiBase !== 'string') throw new IntegrationError(400, 'API 地址格式无效');
    const apiBase = issueApiBase(input.apiBase?.trim() || defaults[provider]);
    const previous = get(projectId);
    const same = previous && previous.provider === provider && previous.apiBase === apiBase && previous.repo === slug;
    const next = { provider, apiBase, repo: slug, enabled, token: token || (same ? previous.token : ''),
      issueMap: same ? previous.issueMap : {} };
    if (enabled && !next.token) throw new IntegrationError(400, '启用同步前请填写当前仓库的 Token');
    const state = read();
    state.projects = { ...state.projects, [projectId]: next };
    write(state);
    return safeConfig(next);
  }

  async function synchronize(project, input) {
    const id = project.id;
    if (inFlight.has(id)) throw new IntegrationError(409, '当前项目已有同步任务');
    inFlight.add(id);
    try {
      const { direction, taskIds, dryRun, previewId, expectedRevision, allowAll, expectedTarget } = input ?? {};
      if (!['push', 'pull'].includes(direction) || (taskIds != null && (!Array.isArray(taskIds) || taskIds.some((key) => typeof key !== 'string' || !idPattern.test(key))))) {
        throw new IntegrationError(400, '同步方向或任务列表无效');
      }
      if (direction === 'push' && !taskIds?.length && allowAll !== true) throw new IntegrationError(400, '请选择推送任务，或显式确认全量推送');
      if (direction === 'pull' && dryRun !== true && (typeof previewId !== 'string' || !previewId || typeof expectedRevision !== 'string' || !expectedRevision)) {
        throw new IntegrationError(400, '请先预览远端变更，再确认写入');
      }
      const config = get(id);
      if (direction === 'push' && expectedTarget && ['provider', 'apiBase', 'repo'].some((key) => expectedTarget[key] !== config?.[key])) {
        throw new IntegrationError(409, '平台配置已变化，请关闭并重新打开同步窗口', 'SYNC_TARGET_CHANGED');
      }
      if (!config?.enabled || !config.token) throw new IntegrationError(400, '请先启用当前项目的平台集成');
      const snapshot = readPlan(project);
      if (!snapshot?.data || validate(snapshot.data).length) throw new IntegrationError(400, '当前计划无效，无法同步');
      const all = new Map(snapshot.data.tasks.map((item) => [item.id, item]));
      const ids = [...new Set(taskIds?.length ? taskIds : all.keys())].sort();
      if (ids.some((taskId) => !all.has(taskId))) throw new IntegrationError(400, '同步任务不属于当前计划');
      const selection = { ...snapshot.data, tasks: ids.map((taskId) => all.get(taskId)) };
      const adapter = createIssueAdapter(config, transport);
      const signature = hash([id, project.planPath, snapshot.revision, ids, target(config), bindingKey(config, ids)]);
      const stillCurrent = () => {
        const latest = get(id);
        const current = readPlan(project);
        if (!latest || hash([id, project.planPath, current?.revision, ids, target(latest), bindingKey(latest, ids)]) !== signature) throw stale();
        return current;
      };
      if (direction === 'pull') {
        for (const [key, value] of previews) if (value.expires <= now()) previews.delete(key);
        const preview = dryRun === true ? null : previews.get(previewId);
        if (dryRun !== true && (!preview || preview.signature !== signature || expectedRevision !== snapshot.revision)) throw stale();
        const remoteIssues = await adapter.list();
        const result = reconcileIssuesWithPlan(selection, remoteIssues, config.issueMap, today(), { projectId: id });
        const current = stillCurrent();
        const fingerprint = hash(result.remoteState);
        if (dryRun === true) {
          const key = randomUUID();
          if (previews.size >= 128) previews.delete(previews.keys().next().value);
          previews.set(key, { signature, fingerprint, result, expires: now() + 5 * 60 * 1000 });
          return { ok: true, direction, dryRun: true, previewId: key, expectedRevision: snapshot.revision,
            proposedUpdates: result.proposedUpdates, skippedConflicts: result.skippedConflicts };
        }
        if (preview.expires <= now() || fingerprint !== preview.fingerprint) { previews.delete(previewId); throw stale(); }
        previews.delete(previewId);
        const verified = preview.result;
        const changes = new Map(verified.proposedUpdates.map(({ id: taskId, after }) => [taskId, after]));
        if (changes.size) {
          const tasks = current.data.tasks.map((task) => ({ ...task, ...changes.get(task.id) }));
          const output = updatePlanMarkdown(current.raw, tasks.filter(({ id: taskId }) => changes.has(taskId)));
          if (validate({ ...current.data, tasks }).length || !verifyTaskUpdates(output, tasks)) throw new IntegrationError(400, '无法安全写回任务进度');
          stillCurrent();
          atomicWrite(project.planPath, output);
        }
        const issueMap = applyBindings(id, config, verified.bindings);
        return { ok: true, direction, dryRun: false, created: [], updated: [...changes.keys()], issueMap: publicIssueMap(issueMap), skippedConflicts: verified.skippedConflicts,
          touchedTasks: verified.proposedUpdates.map((item) => ({ id: item.id, beforeStatus: item.before.status, afterStatus: item.after.status })) };
      }

      const issues = await adapter.list();
      stillCurrent();
      const created = [], updated = [], failed = [];
      let issueMap = config.issueMap;
      const persist = (taskId, issue) => {
        issueMap = applyBindings(id, config, { [taskId]: { number: issue.number, url: issue.url, state: issue.state } });
      };
      for (const task of selection.tasks) {
        try {
          const current = readPlan(project);
          if (current?.revision !== snapshot.revision) throw new IntegrationError(409, '本地计划已变化，请刷新后继续');
          const { issue: existing, ambiguous, bound } = getIssueForTask(task, issues, issueMap, id);
          if (ambiguous || (bound && !existing)) throw new IntegrationError(409, ambiguous ? '多个 Issue 匹配，未推送' : '已绑定的 Issue 不可用');
          const draft = buildIssuePayload(config.provider, task, selection.milestones.find(({ id: ms }) => ms === task.milestone));
          const start = '<!-- task-orchestration:' + id + ':' + task.id + ' -->';
          const end = '<!-- /task-orchestration -->';
          const block = start + '\n' + draft.body + '\n' + end;
          let issue = existing;
          if (!issue) {
            issue = await adapter.create({ ...draft, body: block });
            persist(task.id, issue);
            created.push(task.id);
          }
          const bodyStart = issue.body.indexOf(start);
          const bodyEnd = bodyStart < 0 ? -1 : issue.body.indexOf(end, bodyStart + start.length);
          const body = bodyEnd < 0 ? issue.body : issue.body.slice(0, bodyStart) + block + issue.body.slice(bodyEnd + end.length);
          const labels = [...new Set([...issue.labels.filter((label) =>
            !/^milestone:|^status:/.test(label)), ...draft.labels])];
          if (issue.title !== draft.title || issue.state !== draft.state || issue.body !== body
            || hash([...labels].sort()) !== hash([...issue.labels].sort())) {
            if (readPlan(project)?.revision !== snapshot.revision) throw new IntegrationError(409, '本地计划已变化，请刷新后继续');
            issue = await adapter.update(issue, { ...draft, body, labels });
            if (existing && issue.title === draft.title && issue.state === draft.state && draft.labels.every((label) => issue.labels.includes(label))) updated.push(task.id);
          }
          persist(task.id, issue);
          if (issue.title !== draft.title || issue.state !== draft.state || draft.labels.some((label) => !issue.labels.includes(label))) {
            throw new IntegrationError(502, '平台未应用所请求的状态或标签，请核对仓库标签和 Token 权限');
          }
        } catch (err) { failed.push({ id: task.id, message: err instanceof IntegrationError ? err.message : '无法保存同步结果' }); }
      }
      return { ok: failed.length === 0, direction, created, updated, touchedTasks: [], skippedConflicts: [], issueMap: publicIssueMap(issueMap), failed };
    } finally { inFlight.delete(id); }
  }
  return { get: (id) => safeConfig(get(id)), save, synchronize };
}
