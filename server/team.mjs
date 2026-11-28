import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validate } from '../scripts/validate-plan.mjs';
import { defaultClaimTtl, evaluateClaims, inferActorKind } from '../web/claims.js';
import { fromDay, toDay } from '../web/metrics.js';
import { readyTasks } from '../web/task-handoff.js';

export class TeamConfigError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const keyOf = (name) => String(name || '').trim().toLowerCase();

export function teamPath(configRoot) {
  return join(configRoot, 'plan', 'team.json');
}

export function normalizeTeamConfig(input) {
  const list = Array.isArray(input?.members) ? input.members : Array.isArray(input) ? input : null;
  if (!list || list.length > 200) throw new TeamConfigError('团队成员配置格式无效或数量超限');

  const seenIds = new Set();
  const seenKeys = new Map();
  const members = list.map((raw) => {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!id || id.length > 80 || keyOf(id) === 'unassigned') {
      throw new TeamConfigError('成员标识不能为空、超过 80 字或使用保留名 unassigned');
    }
    const idKey = keyOf(id);
    if (seenIds.has(idKey)) throw new TeamConfigError(`成员标识重复：${id}`);
    seenIds.add(idKey);
    if (seenKeys.has(idKey)) throw new TeamConfigError(`成员标识「${id}」与「${seenKeys.get(idKey)}」的别名冲突`);
    seenKeys.set(idKey, id);

    const kind = raw?.kind === 'agent' || raw?.kind === 'human' ? raw.kind : inferActorKind(id);
    const label = typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 120) : id;
    const group = typeof raw?.group === 'string' ? raw.group.trim().slice(0, 60) : '';
    const defaultLimit = kind === 'agent' ? 1 : 2;
    const dailyLimit = raw?.dailyLimit === undefined || raw?.dailyLimit === ''
      ? defaultLimit
      : Number(raw.dailyLimit);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 20) {
      throw new TeamConfigError(`成员「${id}」的每日并行上限须为 1 至 20 的整数`);
    }

    const maxTtl = kind === 'agent' ? 240 : 1440;
    const defaultTtlMinutes = raw?.defaultTtlMinutes === undefined || raw?.defaultTtlMinutes === ''
      ? defaultClaimTtl(kind)
      : Number(raw.defaultTtlMinutes);
    if (!Number.isInteger(defaultTtlMinutes) || defaultTtlMinutes < 5 || defaultTtlMinutes > maxTtl) {
      throw new TeamConfigError(`成员「${id}」的默认租约时长须为 5 至 ${maxTtl} 分钟`);
    }

    const rawAliases = Array.isArray(raw?.aliases)
      ? raw.aliases
      : typeof raw?.aliases === 'string'
        ? raw.aliases.split(/[,，\n]+/)
        : [];
    const aliases = [];
    for (const item of rawAliases) {
      const alias = String(item || '').trim();
      if (!alias || alias.length > 80) continue;
      const ak = keyOf(alias);
      if (ak === idKey || ak === 'unassigned') continue;
      if (seenKeys.has(ak)) {
        if (seenKeys.get(ak) !== id) throw new TeamConfigError(`别名「${alias}」在成员「${id}」与「${seenKeys.get(ak)}」之间冲突`);
        continue;
      }
      seenKeys.set(ak, id);
      aliases.push(alias);
    }

    return { id, label, group, kind, dailyLimit, defaultTtlMinutes, aliases };
  });

  return { version: 1, members };
}

export function readTeamConfig(configRoot) {
  const file = teamPath(configRoot);
  if (!existsSync(file)) return { version: 1, members: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return normalizeTeamConfig(parsed);
}

export function writeTeamConfig(configRoot, input) {
  const normalized = normalizeTeamConfig(input);
  const file = teamPath(configRoot);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  return normalized;
}

const weekStartDay = (day) => day - ((day + 3) % 7 + 7) % 7;

export function buildTeamOverview({
  today,
  projects,
  readSnapshot,
  readClaimsFn,
  readOwnersFn,
  teamConfig = { version: 1, members: [] },
  now = Date.now(),
}) {
  const todayDay = toDay(today);
  const baseWeekStart = weekStartDay(todayDay);
  const weeks = Array.from({ length: 4 }, (_, idx) => {
    const start = baseWeekStart + idx * 7;
    const end = start + 6;
    return {
      id: `W${idx + 1}`,
      label: idx === 0 ? `本周 (${fromDay(start).slice(5)})` : `${fromDay(start).slice(5)}~${fromDay(end).slice(5)}`,
      start,
      end,
      startDate: fromDay(start),
      endDate: fromDay(end),
    };
  });
  const horizonStart = weeks[0].start;
  const horizonEnd = weeks[weeks.length - 1].end;

  const aliasToId = new Map();
  const memberMap = new Map();

  const ensureMember = (rawId, defaults = {}) => {
    const trimmed = String(rawId || '').trim();
    if (!trimmed || keyOf(trimmed) === 'unassigned') return null;
    const canonical = aliasToId.get(keyOf(trimmed)) || trimmed;
    const ck = keyOf(canonical);
    if (!memberMap.has(ck)) {
      const kind = defaults.kind || inferActorKind(canonical);
      memberMap.set(ck, {
        id: canonical,
        label: defaults.label || canonical,
        group: defaults.group || '',
        kind,
        dailyLimit: defaults.dailyLimit || (kind === 'agent' ? 1 : 2),
        defaultTtlMinutes: defaults.defaultTtlMinutes || defaultClaimTtl(kind),
        aliases: defaults.aliases || [],
        configured: Boolean(defaults.configured),
        projects: new Set(),
        scheduleTasks: [],
        doing: [],
        blocked: [],
        recentDone: [],
        ready: [],
        activeClaimCount: 0,
      });
    }
    return memberMap.get(ck);
  };

  for (const m of teamConfig?.members || []) {
    aliasToId.set(keyOf(m.id), m.id);
    for (const a of m.aliases || []) aliasToId.set(keyOf(a), m.id);
    ensureMember(m.id, { ...m, configured: true });
  }

  for (const project of projects || []) {
    let data;
    try {
      const snap = readSnapshot(project);
      data = snap?.data;
      if (!data || validate(data).length) continue;
    } catch {
      continue;
    }

    let claimsConfig = { version: 1, roster: [], claims: {}, activityLog: [], auditLog: [] };
    try {
      const read = readClaimsFn?.(project);
      if (read) claimsConfig = read;
    } catch { /* ignore */ }
    const { claims } = evaluateClaims(claimsConfig, data, now);

    let ownersConfig = { owners: [] };
    try {
      const read = readOwnersFn?.(project);
      if (read) ownersConfig = read;
    } catch { /* ignore */ }

    for (const o of ownersConfig.owners || []) {
      const entry = ensureMember(o.name, { label: o.role ? `${o.name} (${o.role})` : o.name });
      if (entry) entry.projects.add(project.id);
    }
    for (const r of claimsConfig.roster || []) {
      const entry = ensureMember(r.id, { label: r.label || r.id, kind: r.kind, defaultTtlMinutes: r.defaultTtlMinutes });
      if (entry) entry.projects.add(project.id);
    }

    const readySet = new Map(readyTasks(data.tasks, today).map((item) => [item.task.id, item]));

    for (const task of data.tasks) {
      const claim = claims[task.id] || null;
      const isActiveClaim = claim?.state === 'active';
      const ownerMember = ensureMember(task.owner);
      const actorMember = claim && (claim.state === 'active' || claim.state === 'stale') ? ensureMember(claim.actor) : null;
      if (ownerMember) ownerMember.projects.add(project.id);
      if (actorMember) actorMember.projects.add(project.id);

      const packItem = (extra = {}) => ({
        projectId: project.id,
        projectName: project.name,
        id: task.id,
        title: task.title,
        owner: task.owner,
        milestone: task.milestone,
        start: task.start,
        end: task.end,
        status: task.status,
        progress: task.progress,
        actualEnd: task.actualEnd,
        claim: claim && (claim.state === 'active' || claim.state === 'stale')
          ? { actor: claim.actor, actorKind: claim.actorKind, state: claim.state, remainingMinutes: claim.remainingMinutes ?? null }
          : null,
        ...extra,
      });

      if (task.status === 'doing' || (task.status === 'todo' && isActiveClaim)) {
        const target = isActiveClaim && actorMember ? actorMember : ownerMember;
        if (target) {
          target.doing.push(packItem({ claimedPending: task.status === 'todo' }));
          if (isActiveClaim) target.activeClaimCount++;
        }
      }
      if (task.status === 'blocked' && ownerMember) {
        ownerMember.blocked.push(packItem());
      }
      if (task.status === 'done') {
        const doneDay = toDay(task.actualEnd || task.end);
        if (Number.isFinite(doneDay) && doneDay >= todayDay - 1 && doneDay <= todayDay) {
          const target = ownerMember;
          if (target) target.recentDone.push(packItem());
        }
      }
      if (readySet.has(task.id) && !isActiveClaim && ownerMember) {
        const readyMeta = readySet.get(task.id);
        ownerMember.ready.push(packItem({ availability: readyMeta.availability, reason: readyMeta.reason }));
      }
      if (task.status !== 'done') {
        const loadTarget = isActiveClaim && actorMember ? actorMember : ownerMember;
        if (loadTarget) {
          loadTarget.scheduleTasks.push({
            projectId: project.id,
            projectName: project.name,
            id: task.id,
            title: task.title,
            status: task.status,
            startDay: toDay(task.start),
            endDay: toDay(task.end),
          });
        }
      }
    }
  }

  const compareItem = (a, b) => a.end.localeCompare(b.end)
    || a.projectName.localeCompare(b.projectName, 'zh-CN', { numeric: true })
    || a.id.localeCompare(b.id, 'en', { numeric: true });

  const members = [...memberMap.values()].map((m) => {
    let maxPeak = 0;
    let multiProjectDays = 0;
    let overloadedDays = 0;
    const conflictDays = [];

    const weekly = weeks.map((w) => {
      let peak = 0;
      let weekOverloaded = false;
      let weekMulti = false;
      for (let day = w.start; day <= w.end; day++) {
        const active = m.scheduleTasks.filter((t) => t.startDay <= day && t.endDay >= day);
        if (!active.length) continue;
        const projCount = new Set(active.map((t) => t.projectId)).size;
        if (active.length > peak) peak = active.length;
        if (active.length > maxPeak) maxPeak = active.length;
        if (projCount >= 2) {
          multiProjectDays++;
          weekMulti = true;
        }
        if (active.length > m.dailyLimit) {
          overloadedDays++;
          weekOverloaded = true;
        }
        if (active.length > m.dailyLimit || projCount >= 2) {
          conflictDays.push({
            date: fromDay(day),
            count: active.length,
            projectCount: projCount,
            overloaded: active.length > m.dailyLimit,
            tasks: active.map((t) => ({ projectId: t.projectId, projectName: t.projectName, id: t.id, title: t.title, status: t.status })),
          });
        }
      }
      return {
        id: w.id,
        peak,
        overloaded: weekOverloaded,
        multiProject: weekMulti,
      };
    });

    // Also include any tasks outside the 4-week window? No, 4-week horizon is explicit, and keep top 6 most severe conflict days.
    const collisions = conflictDays
      .sort((a, b) => Number(b.overloaded) - Number(a.overloaded) || b.count - a.count || b.projectCount - a.projectCount || a.date.localeCompare(b.date))
      .slice(0, 6);

    const loadState = overloadedDays > 0
      ? 'collision'
      : multiProjectDays > 0
        ? 'multi'
        : maxPeak > 0
          ? 'normal'
          : 'idle';

    m.doing.sort((a, b) => Number(Boolean(a.claimedPending)) - Number(Boolean(b.claimedPending)) || compareItem(a, b));
    m.blocked.sort(compareItem);
    m.recentDone.sort((a, b) => (b.actualEnd || b.end).localeCompare(a.actualEnd || a.end) || compareItem(a, b));
    m.ready.sort(compareItem);

    return {
      id: m.id,
      label: m.label,
      group: m.group,
      kind: m.kind,
      dailyLimit: m.dailyLimit,
      defaultTtlMinutes: m.defaultTtlMinutes,
      aliases: m.aliases,
      configured: m.configured,
      projectCount: m.projects.size,
      doingCount: m.doing.length,
      activeClaimCount: m.activeClaimCount,
      blockedCount: m.blocked.length,
      recentDoneCount: m.recentDone.length,
      readyCount: m.ready.length,
      maxPeak,
      multiProjectDays,
      overloadedDays,
      loadState,
      weekly,
      collisions,
      standup: {
        doing: m.doing,
        blocked: m.blocked,
        recentDone: m.recentDone,
        ready: m.ready,
      },
    };
  });

  const stateRank = { collision: 0, multi: 1, normal: 2, idle: 3 };
  members.sort((a, b) =>
    stateRank[a.loadState] - stateRank[b.loadState]
    || b.blockedCount - a.blockedCount
    || b.doingCount - a.doingCount
    || a.id.localeCompare(b.id, 'zh-CN', { numeric: true }),
  );

  const groups = [...new Set(members.map((m) => m.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return {
    today,
    horizon: { startDate: fromDay(horizonStart), endDate: fromDay(horizonEnd) },
    weeks: weeks.map(({ id, label, startDate, endDate }) => ({ id, label, startDate, endDate })),
    groups,
    summary: {
      memberCount: members.length,
      collisionCount: members.filter((m) => m.loadState === 'collision').length,
      multiProjectCount: members.filter((m) => m.loadState === 'multi').length,
      activeAgentCount: members.filter((m) => m.kind === 'agent' && m.activeClaimCount > 0).length,
      totalDoing: members.reduce((s, m) => s + m.doingCount, 0),
      totalBlocked: members.reduce((s, m) => s + m.blockedCount, 0),
    },
    members,
  };
}
