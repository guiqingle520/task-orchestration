const AGENT_ID = /^(?:codex|antigravity|claude|cursor|qoder|copilot|opencode|agent)(?:[#_-].*)?$/i;

export function inferActorKind(id) {
  return AGENT_ID.test(id) ? 'agent' : 'human';
}

export function defaultClaimTtl(kind) {
  return kind === 'human' ? 480 : 30;
}

export function claimState(claim, task, now) {
  if (!task) return 'orphaned';
  if (task.status === 'done') return 'done_pending_reconcile';
  return now < Date.parse(claim.expiresAt) ? 'active' : 'stale';
}

export function evaluateClaims(claimsConfig, plan, nowIso) {
  const now = typeof nowIso === 'number' ? nowIso : Date.parse(nowIso);
  if (!Number.isFinite(now)) throw new TypeError('The claim evaluation time must be valid');
  const tasks = new Map((plan.tasks ?? []).map((task) => [task.id, task]));
  const roster = new Map((claimsConfig.roster ?? []).map((entry) => [entry.id, entry]));
  const addMember = (id, kind) => {
    if (id && !roster.has(id)) roster.set(id, { id, label: id, kind, defaultTtlMinutes: defaultClaimTtl(kind) });
  };
  const summary = { active: 0, stale: 0, orphaned: 0, done_pending_reconcile: 0 };
  const entries = Object.entries(claimsConfig.claims ?? {}).map(([id, claim]) => {
    const task = tasks.get(id);
    const state = claimState(claim, task, now);
    summary[state]++;
    addMember(claim.actor, claim.actorKind ?? inferActorKind(claim.actor));
    const remaining = Date.parse(claim.expiresAt) - now;
    const timing = state === 'active' ? { remainingMs: remaining, remainingMinutes: Math.ceil(remaining / 60_000) }
      : state === 'stale' ? { overdueMinutes: Math.floor(-remaining / 60_000) } : {};
    return [id, { ...claim, state, ...timing }];
  });
  for (const task of tasks.values()) addMember(task.owner, inferActorKind(task.owner));
  return { claims: Object.fromEntries(entries), mergedRoster: [...roster.values()], summary };
}
