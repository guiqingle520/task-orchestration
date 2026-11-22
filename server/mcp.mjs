#!/usr/bin/env node
// 零依赖标准 stdio MCP 服务：提供计划查询、校验与带并发冲突检查的任务进度写回工具。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter, validate } from '../scripts/validate-plan.mjs';
import { updatePlanMarkdown, verifyTaskUpdates } from '../scripts/sync-git-progress.mjs';
import { createWorkspaces } from './workspaces.mjs';
import { extractAcceptanceByTask } from './plan-acceptance.mjs';
import { summarizeProject } from './portfolio.mjs';
import { compute } from '../web/metrics.js';
import { filterTasks, followUpTasks } from '../web/m6.js';
import { buildTaskHandoff, readyTasks } from '../web/task-handoff.js';
import { checkTaskWrite, completeClaim } from './claims.mjs';
import { mutateClaims, withClaimsSnapshot } from './claim-service.mjs';
import { atomicReplaceFile, PlanLockError, revisionOf } from './plan-lock.mjs';
import { evaluateClaims } from '../web/claims.js';

const DEFAULT_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const SERVER_INFO = { name: 'task-orchestration', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';
const EXEC_FIELDS = ['status', 'progress', 'actualStart', 'actualEnd'];
const VALID_STATUSES = ['todo', 'doing', 'blocked', 'done'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function localToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function readPlanSnapshot(project) {
  const planFile = project.planPath;
  if (!existsSync(planFile)) return { error: ['找不到 plan/plan.md'] };
  try {
    const raw = readFileSync(planFile, 'utf8');
    const data = parseFrontMatter(raw);
    if (!data) return { error: ['plan.md 缺少 YAML front matter'] };
    return { data, revision: revisionOf(raw) };
  } catch (err) {
    return { error: [err.message] };
  }
}

function toolOk(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function toolErr(status, code, message, extra = {}) {
  const payload = { ok: false, status, code, message, ...extra };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

const claimAddress = { projectId: { type: 'string' }, id: { type: 'string' }, actor: { type: 'string' } };
const renewalFields = { ttlMinutes: { type: 'integer', minimum: 5, maximum: 1440 }, note: { type: 'string' } };
const forceFields = { force: { type: 'boolean' }, reason: { type: 'string' } };

function claimTool(name, description, required, properties) {
  return { name, description, inputSchema: { type: 'object', required, properties: { ...claimAddress, ...properties }, additionalProperties: false } };
}

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'plan_list_projects',
    description: '列出驾驶舱已注册的所有项目及其健康度、总体进度、阻塞数和逾期数。',
    inputSchema: {
      type: 'object',
      properties: {
        today: { type: 'string', description: '可选统计日 YYYY-MM-DD，默认本机今天。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'plan_get_overview',
    description: '查询指定项目的整体进度、需跟进任务、可开工任务（区分现在可开工与可提前开始）及过滤后的任务列表。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 ID，默认使用工作区默认项目。' },
        today: { type: 'string', description: '可选统计日 YYYY-MM-DD，默认本机今天。' },
        owner: { type: 'string', description: '按负责人筛选。' },
        status: { type: 'string', enum: VALID_STATUSES, description: '按状态筛选。' },
        milestone: { type: 'string', description: '按里程碑 ID 筛选。' },
        query: { type: 'string', description: '按任务 ID 或标题关键字筛选。' },
        unclaimedOnly: { type: 'boolean', description: '仅列出当前没有活跃认领的任务。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'plan_get_task',
    description: '读取单个任务的完整信息、并发冲突锁快照 expected、验收要求与可直接交接的开工说明文本。',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        projectId: { type: 'string', description: '项目 ID，默认使用工作区默认项目。' },
        id: { type: 'string', description: '任务编号，如 T-60。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'plan_validate',
    description: '校验指定项目的 plan/plan.md 格式、日期合法性与无环依赖。',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 ID，默认使用工作区默认项目。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'plan_update_task',
    description: '带乐观锁并发冲突检查地更新单个任务的执行字段（仅允许 status、progress、actualStart、actualEnd，遵守 PLAN_SPEC 角色权限，不允许修改计划结构或排期）。',
    inputSchema: {
      type: 'object',
      required: ['id', 'expected', 'status', 'progress'],
      properties: {
        projectId: { type: 'string', description: '项目 ID，默认使用工作区默认项目。' },
        id: { type: 'string', description: '任务编号，如 T-60。' },
        expected: {
          type: 'object',
          description: '通过 plan_get_task 读取的当前执行字段快照，用于并发冲突检查。',
          required: EXEC_FIELDS,
          properties: {
            status: { type: 'string' },
            progress: { type: 'number' },
            actualStart: { type: ['string', 'null'] },
            actualEnd: { type: ['string', 'null'] },
          },
          additionalProperties: false,
        },
        status: { type: 'string', enum: VALID_STATUSES, description: '目标状态。' },
        progress: { type: 'integer', minimum: 0, maximum: 100, description: '目标进度（todo 必须为 0，done 必须为 100）。' },
        actualStart: { type: ['string', 'null'], description: '可选实际开始日期 YYYY-MM-DD（未传时自动维护）。' },
        actualEnd: { type: ['string', 'null'], description: '可选实际结束日期 YYYY-MM-DD（未传时自动维护）。' },
        today: { type: 'string', description: '可选当天日期 YYYY-MM-DD，用于自动填充 actualStart/actualEnd。' },
        actor: { type: 'string', description: '任务有活跃认领时须提供当前执行人。' },
        leaseId: { type: 'string', description: '认领返回的租约代次，写回时携带以防旧实例覆盖。' },
      },
      additionalProperties: false,
    },
  },
  claimTool('plan_claim_task', '认领任务并返回租约代次。默认保留计划进度，接管已超时的租约需显式确认。',
    ['id', 'actor'], { actorKind: { type: 'string', enum: ['human', 'agent'] }, ...renewalFields, ...forceFields,
      startImmediately: { type: 'boolean' }, takeoverStale: { type: 'boolean' }, expectedLeaseId: { type: 'string' } }),
  claimTool('plan_heartbeat_task', '用当前租约代次续租，可同时更新备注。',
    ['id', 'actor', 'leaseId'], { ...renewalFields, leaseId: { type: 'string' } }),
  claimTool('plan_release_task', '释放认领。正常释放时提供执行人和租约代次，强制释放时提供原因。',
    ['id'], { ...forceFields, leaseId: { type: 'string' } }),
];

const claimActions = new Map([['plan_claim_task', 'claim'], ['plan_heartbeat_task', 'heartbeat'], ['plan_release_task', 'release']]);

function compactClaim(claim) {
  if (!claim) return null;
  const { state, actor, leaseId, expiresAt, note } = claim;
  return { state, actor, leaseId, expiresAt, note };
}

export function createMcpService(rootDir = DEFAULT_ROOT) {
  const root = resolve(rootDir);
  const workspaces = createWorkspaces(root);

  function resolveProject(projectId) {
    return workspaces.get(projectId || '');
  }

  function invokeTool(name, args = {}) {
    const input = args && typeof args === 'object' ? args : {};
    if (name === 'plan_list_projects') {
      const today = input.today || localToday();
      if (!validDate(today)) return toolErr(400, 'INVALID_DATE', 'today 必须是有效的 YYYY-MM-DD 日期');
      try {
        const registry = workspaces.read();
        const readRegistered = ({ id }) => readPlanSnapshot(workspaces.get(id, registry));
        const projects = registry.projects.map((project) => summarizeProject(project, today, readRegistered));
        return toolOk({ ok: true, today, default: registry.default, projects });
      } catch (err) {
        return toolErr(500, 'WORKSPACE_ERROR', err.message || '无法读取工作区项目列表');
      }
    }

    let project;
    try {
      project = resolveProject(input.projectId);
    } catch (err) {
      return toolErr(404, 'PROJECT_NOT_FOUND', err.message || '项目不存在');
    }

    if (claimActions.has(name)) return toolOk(mutateClaims(project, { ...input, action: claimActions.get(name) }, localToday()));

    if (name === 'plan_validate') {
      const snap = readPlanSnapshot(project);
      if (snap.error) return toolOk({ ok: true, projectId: project.id, valid: false, errors: snap.error });
      const errors = validate(snap.data);
      return toolOk({
        ok: true,
        projectId: project.id,
        valid: errors.length === 0,
        errors,
        revision: snap.revision,
        milestoneCount: snap.data.milestones.length,
        taskCount: snap.data.tasks.length,
      });
    }

    if (name === 'plan_get_overview') {
      const today = input.today || localToday();
      if (!validDate(today)) return toolErr(400, 'INVALID_DATE', 'today 必须是有效的 YYYY-MM-DD 日期');
      return withClaimsSnapshot(project, (snap) => {
        const { claims } = evaluateClaims(snap.config, snap.data, snap.now);
        const metrics = compute(snap.data, today);
        const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
        const eligible = (task) => input.unclaimedOnly !== true || claims[task.id]?.state !== 'active';
        const visible = ({ task }) => (!owner || task.owner === owner) && eligible(task);
        const filtered = filterTasks(snap.data.tasks.filter(eligible), {
          owner,
          status: input.status || '',
          milestone: input.milestone || '',
          query: input.query || '',
        });
        return toolOk({
          ok: true,
          projectId: project.id,
          project: snap.data.project,
          today,
          revision: snap.revision,
          summary: metrics.summary,
          followUp: followUpTasks(snap.data.tasks, today).filter(visible).map(({ task, priority, days }) => ({
            id: task.id, title: task.title, owner: task.owner, status: task.status, progress: task.progress,
            priority: ['blocked', 'overdue', 'due-soon'][priority], daysLeft: days, claim: compactClaim(claims[task.id]),
          })),
          ready: readyTasks(snap.data.tasks, today).filter(visible).map(({ task, availability, reason }) => ({
            id: task.id, title: task.title, owner: task.owner, start: task.start, end: task.end, availability, reason, claim: compactClaim(claims[task.id]),
          })),
          tasks: filtered.map((task) => ({ ...task, claim: compactClaim(claims[task.id]) })),
        });
      });
    }

    if (name === 'plan_get_task') {
      if (typeof input.id !== 'string' || !input.id.trim()) return toolErr(400, 'INVALID_ID', '必须提供任务 ID');
      return withClaimsSnapshot(project, (snap) => {
        const task = snap.data.tasks.find((item) => item.id === input.id.trim());
        if (!task) return toolErr(404, 'TASK_NOT_FOUND', `找不到任务 ${input.id}`);
        const expected = Object.fromEntries(EXEC_FIELDS.map((key) => [key, task[key]]));
        const acceptanceByTask = extractAcceptanceByTask(snap.raw);
        const claim = evaluateClaims(snap.config, snap.data, snap.now).claims[task.id] ?? null;
        return toolOk({
          ok: true,
          projectId: project.id,
          revision: snap.revision,
          task,
          expected,
          claim,
          acceptance: acceptanceByTask[task.id] || '未填写',
          handoff: buildTaskHandoff(snap.data, task.id, acceptanceByTask, { claim, projectId: project.id }),
        });
      });
    }

    if (name === 'plan_update_task') {
      const allowedKeys = new Set(['projectId', 'id', 'expected', 'status', 'progress', 'actualStart', 'actualEnd', 'today', 'actor', 'leaseId']);
      const forbidden = Object.keys(input).filter((key) => !allowedKeys.has(key));
      if (forbidden.length) {
        return toolErr(403, 'FORBIDDEN_FIELDS', `普通执行工具仅允许更新任务执行字段（status/progress/actualStart/actualEnd），拒绝字段：${forbidden.join(', ')}`);
      }
      if (typeof input.id !== 'string' || !input.id.trim()) return toolErr(400, 'INVALID_ID', '必须提供任务 ID');
      if (!input.expected || typeof input.expected !== 'object') return toolErr(400, 'MISSING_EXPECTED', '必须提供 expected 执行字段快照用于并发冲突检查');
      if (!VALID_STATUSES.includes(input.status) || !Number.isInteger(input.progress) || input.progress < 0 || input.progress > 100) {
        return toolErr(400, 'INVALID_PROGRESS', '状态或进度无效');
      }
      if ((input.status === 'todo' && input.progress !== 0) || (input.status === 'done' && input.progress !== 100)) {
        return toolErr(400, 'INVALID_PROGRESS', '未开始任务进度必须为 0，已完成任务必须为 100');
      }
      const today = input.today || localToday();
      if (!validDate(today)) return toolErr(400, 'INVALID_DATE', 'today 必须是有效的 YYYY-MM-DD 日期');
      if (input.actualStart !== undefined && input.actualStart !== null && !validDate(input.actualStart)) {
        return toolErr(400, 'INVALID_DATE', 'actualStart 必须是 YYYY-MM-DD 或 null');
      }
      if (input.actualEnd !== undefined && input.actualEnd !== null && !validDate(input.actualEnd)) {
        return toolErr(400, 'INVALID_DATE', 'actualEnd 必须是 YYYY-MM-DD 或 null');
      }

      return withClaimsSnapshot(project, (snap) => {
        const task = snap.data.tasks.find((item) => item.id === input.id.trim());
        if (!task) return toolErr(404, 'TASK_NOT_FOUND', `找不到任务 ${input.id}`);
        const claim = checkTaskWrite(snap.config, task, input, snap.now);

        const currentExpected = Object.fromEntries(EXEC_FIELDS.map((key) => [key, task[key]]));
        if (EXEC_FIELDS.some((key) => task[key] !== input.expected[key])) {
          return toolErr(409, 'CONFLICT', '任务已被其他智能体或操作修改，请重新读取后再提交', { current: currentExpected, revision: snap.revision });
        }

        task.status = input.status;
        task.progress = input.progress;
        if (task.status === 'todo') {
          task.actualStart = null;
          task.actualEnd = null;
        } else {
          task.actualStart = input.actualStart !== undefined ? input.actualStart : (task.actualStart || today);
          task.actualEnd = input.actualEnd !== undefined
            ? input.actualEnd
            : (task.status === 'done' ? (task.actualEnd || today) : null);
        }

        const afterErrors = validate(snap.data);
        if (afterErrors.length) return toolErr(400, 'PLAN_INVALID', afterErrors.join('; '), { errors: afterErrors });
        const output = updatePlanMarkdown(snap.raw, [task]);
        if (!verifyTaskUpdates(output, [task])) return toolErr(500, 'WRITEBACK_VERIFY_FAILED', '无法安全写回任务进度，计划未修改');
        if (output !== snap.raw && !atomicReplaceFile(snap.planPath, output, snap.revision)) {
          return toolErr(409, 'CONFLICT', '写入瞬间计划已变化，请重新读取后再提交');
        }
        const completion = task.status === 'done' ? completeClaim(snap.planPath, snap.config, claim, snap.now) : {};
        return toolOk({
          ok: true,
          projectId: project.id,
          revision: revisionOf(output),
          task,
          expected: Object.fromEntries(EXEC_FIELDS.map((key) => [key, task[key]])),
          ...completion,
        });
      });
    }

    return toolErr(404, 'UNKNOWN_TOOL', `未知工具：${name}`);
  }

  function callTool(name, args) {
    try { return invokeTool(name, args); }
    catch (error) {
      if (error instanceof PlanLockError) return toolErr(error.status, error.code, error.message, error.details);
      return toolErr(500, 'PLAN_OPERATION_FAILED', '无法完成计划操作');
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const { id, method, params } = message;
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
    if (id === undefined) return null;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: MCP_TOOL_DEFINITIONS } };
    if (method === 'tools/call') {
      const toolName = params?.name;
      if (typeof toolName !== 'string') {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing tool name' } };
      }
      return { jsonrpc: '2.0', id, result: callTool(toolName, params?.arguments) };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return { callTool, handleMessage };
}

export function startStdioServer(rootDir = DEFAULT_ROOT) {
  const service = createMcpService(rootDir);
  let framing = 'ndjson';
  let buf = Buffer.alloc(0);

  function send(payload) {
    const json = JSON.stringify(payload);
    if (framing === 'content-length') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(json + '\n');
    }
  }

  function dispatchRaw(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const response = service.handleMessage(message);
    if (response) send(response);
  }

  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')]);
    while (buf.length > 0) {
      const preview = buf.subarray(0, Math.min(buf.length, 32)).toString('utf8');
      if (/^content-length:/i.test(preview.trimStart())) {
        framing = 'content-length';
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerText = buf.subarray(0, headerEnd).toString('utf8');
        const match = headerText.match(/content-length:\s*(\d+)/i);
        if (!match) { buf = buf.subarray(headerEnd + 4); continue; }
        const len = Number(match[1]);
        if (buf.length < headerEnd + 4 + len) return;
        const body = buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
        buf = buf.subarray(headerEnd + 4 + len);
        dispatchRaw(body);
      } else {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) return;
        const line = buf.subarray(0, nl).toString('utf8').trim();
        buf = buf.subarray(nl + 1);
        if (line) dispatchRaw(line);
      }
    }
  });
}

const isMain = process.argv[1] && (
  process.platform === 'win32'
    ? resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
    : resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);
if (isMain) {
  const rootIdx = process.argv.indexOf('--root');
  const cliRoot = rootIdx >= 0 && process.argv[rootIdx + 1] ? process.argv[rootIdx + 1] : '';
  startStdioServer(cliRoot || process.env.TASK_ORCHESTRATION_ROOT || DEFAULT_ROOT);
}
