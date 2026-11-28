import { defaultClaimTtl, inferActorKind } from './claims.js';

export const UNASSIGNED = 'unassigned';
export const ownerLabel = (name) => name === UNASSIGNED ? '未分配' : name;

const keyOf = (name) => String(name || '').toLowerCase();
const findOwner = (owners, name) => owners.find((owner) => keyOf(owner.name) === keyOf(name));
const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function roleFromLabel(id, label) {
  if (!label || label === id) return '';
  const prefix = `${id} (`;
  if (label.startsWith(prefix) && label.endsWith(')')) return label.slice(prefix.length, -1).trim();
  return label;
}

function mergeRosterMembers(ownersData, claimsData) {
  const configured = Array.isArray(claimsData?.configuredRoster) ? claimsData.configuredRoster : [];
  const claimsByKey = new Map(configured.map((entry) => [keyOf(entry.id), entry]));
  const seen = new Set();
  const merged = (ownersData?.owners || []).map((owner) => {
    const k = keyOf(owner.name);
    seen.add(k);
    const claimEntry = claimsByKey.get(k);
    const kind = claimEntry?.kind || inferActorKind(owner.name);
    const ttl = claimEntry?.defaultTtlMinutes || defaultClaimTtl(kind);
    return {
      ...owner,
      role: owner.role || (claimEntry ? roleFromLabel(claimEntry.id, claimEntry.label) : ''),
      kind,
      defaultTtlMinutes: ttl,
      inClaimsRoster: Boolean(claimEntry),
    };
  });
  for (const entry of configured) {
    const k = keyOf(entry.id);
    if (seen.has(k) || k === UNASSIGNED) continue;
    seen.add(k);
    merged.push({
      name: entry.id,
      role: roleFromLabel(entry.id, entry.label),
      active: true,
      inRoster: false,
      inClaimsRoster: true,
      taskCount: 0,
      openTaskCount: 0,
      kind: entry.kind || inferActorKind(entry.id),
      defaultTtlMinutes: entry.defaultTtlMinutes || defaultClaimTtl(entry.kind || inferActorKind(entry.id)),
    });
  }
  return merged;
}

export function installOwnerPanel($, { apiUrl, getProject, onRename, onChanged }) {
  const dialog = $('ownersDialog');
  if (!dialog) return { close() {} };
  const editDialog = $('ownerEditDialog');
  const list = $('ownersList');
  const notice = $('ownersMessage');
  const add = $('addOwnerBtn');
  const submit = $('saveOwnerEdit');
  const nameInput = $('ownerName');
  const roleInput = $('ownerRole');
  const kindInput = $('ownerKind');
  const ttlInput = $('ownerTtl');
  const reasonInput = $('ownerReason');
  let panel = null;
  let edit = null;

  async function request(projectId, path = '/api/owners', body) {
    const response = await fetch(apiUrl(path, projectId), body && {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || (data?.projectId && data.projectId !== projectId)) {
      const message = data?.message || '无法读取或保存负责人，请确认服务已更新后重试。';
      throw Object.assign(new Error(message), { status: response.status, code: data?.code });
    }
    return data;
  }

  async function requestOptionalClaims(projectId, body) {
    try {
      const response = await fetch(apiUrl('/api/claims', projectId), body && {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      return await response.json().catch(() => null);
    } catch {
      return null;
    }
  }

  const projectMatches = (base) => {
    const current = getProject();
    return current?.projectId === base.projectId && current.epoch === base.epoch;
  };
  const panelIsCurrent = (session) => panel === session && dialog.open && projectMatches(session.base);

  function renderList(session, message = '') {
    const owners = session.data.owners;
    const button = (action, label) => `<button type="button" data-owner-action="${action}">${label}</button>`;
    list.innerHTML = owners.length ? owners.map((owner) => {
      const status = !owner.active ? '已停用' : owner.inRoster ? '已启用' : owner.inClaimsRoster ? '协同名录' : '来自现有任务';
      const kind = owner.kind || inferActorKind(owner.name);
      const ttl = owner.defaultTtlMinutes || defaultClaimTtl(kind);
      const kindBadge = `<span class="roster-kind ${kind}">${kind === 'human' ? '人类负责人' : 'AI 智能体'} · ${ttl}m</span>`;
      return `<li class="owner-row" data-owner="${esc(owner.name)}">
        <div class="owner-info">
          <strong>${esc(owner.name)}</strong>${kindBadge}<span class="owner-state">${status}</span>
          ${owner.role ? `<span class="owner-meta">${esc(owner.role)}</span>` : ''}
          <span class="owner-meta">${owner.taskCount} 项任务 · ${owner.openTaskCount} 项未完成</span>
        </div>
        <div class="owner-actions">
          ${button('role', '编辑')}${button('rename', '更名 / 归并')}${button('toggle', owner.active ? '停用' : '启用')}
          ${(owner.inRoster || owner.inClaimsRoster) && owner.taskCount === 0 ? button('delete', '删除') : ''}
        </div>
      </li>`;
    }).join('') : '<li class="empty">还没有团队成员或智能体。添加后即可在派单与认领时直接选用。</li>';
    notice.textContent = message;
  }

  $('manageOwnersBtn')?.addEventListener('click', async () => {
    const base = getProject();
    if (!base || dialog.open) return;
    const session = panel = { base, data: null, claimsData: null };
    add.disabled = true;
    list.innerHTML = '';
    notice.textContent = '正在加载团队与智能体名录…';
    dialog.showModal();
    try {
      const [ownersData, claimsData] = await Promise.all([
        request(base.projectId),
        requestOptionalClaims(base.projectId),
      ]);
      if (panelIsCurrent(session)) {
        session.claimsData = claimsData;
        session.data = { ...ownersData, owners: mergeRosterMembers(ownersData, claimsData) };
        renderList(session);
        add.disabled = false;
      }
    } catch (error) {
      if (panelIsCurrent(session)) notice.textContent = error.message;
    }
  });
  $('closeOwners')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (!dialog.open) panel = null; });

  function toggleSummary(owner) {
    if (!owner.active) return `重新启用「${owner.name}」后，可在任务表单中选择该负责人。`;
    const reminder = owner.openTaskCount > 0 ? `还有 ${owner.openTaskCount} 项未完成任务，请确认是否需要转交。` : '';
    return `${reminder}停用「${owner.name}」后，现有任务保留原负责人。`;
  }

  function syncTtlBounds() {
    if (!kindInput || !ttlInput) return;
    const isAgent = kindInput.value === 'agent';
    ttlInput.max = isAgent ? '240' : '1440';
  }

  function renderEditor(session) {
    const { kind, owner, preview, pending } = session;
    const isMerge = preview?.merging && keyOf(preview.from) !== keyOf(preview.to);
    const titles = {
      add: '新增成员 / 智能体',
      role: `编辑「${owner?.name}」`,
      rename: `更名或归并「${owner?.name}」`,
      toggle: owner?.active ? '确认停用' : '确认启用',
      delete: '确认删除',
    };
    const summary = {
      add: '',
      role: '',
      rename: preview ? `将「${preview.from}」${isMerge ? '归并到' : '更名为'}「${preview.to}」，会更新当前计划中的 ${preview.affectedCount} 项任务（${preview.openAffectedCount} 项未完成）。`
        : '输入新名称，或选择已有负责人进行归并。',
      toggle: owner ? toggleSummary(owner) : '',
      delete: owner ? `从花名册与智能体名录删除「${owner.name}」。` : '',
    };
    $('ownerEditTitle').textContent = titles[kind];
    $('ownerEditSummary').textContent = summary[kind];
    $('ownerEditSummary').hidden = !summary[kind];
    const showName = kind === 'rename' || kind === 'add';
    const showProfile = kind === 'role' || kind === 'add';
    $('ownerNameRow').hidden = !showName;
    $('ownerNameLabel').textContent = kind === 'rename' ? '新名称或归并目标' : '成员或智能体名称';
    $('ownerRoleRow').hidden = !showProfile;
    if ($('ownerProfileRow')) $('ownerProfileRow').hidden = !showProfile;
    $('ownerReasonRow').hidden = !preview;
    nameInput.required = showName && !preview;
    nameInput.disabled = !showName || pending || Boolean(preview);
    roleInput.disabled = !showProfile || pending;
    if (kindInput) kindInput.disabled = !showProfile || pending;
    if (ttlInput) ttlInput.disabled = !showProfile || pending;
    syncTtlBounds();
    reasonInput.disabled = !preview || pending;
    $('closeOwnerEdit').disabled = pending;
    submit.disabled = pending;
    submit.textContent = kind === 'rename'
      ? (preview ? (isMerge ? '确认归并并更新计划' : '更名并更新当前计划') : '预览影响')
      : kind === 'toggle' ? (owner.active ? '确认停用' : '确认启用')
      : kind === 'delete' ? '确认删除' : '保存';
  }

  function openEditor(kind, source, owner = null) {
    if (editDialog.open || !projectMatches(source.base)) return;
    const session = edit = { kind, source, owner, preview: null, pending: false, kindTouched: false };
    nameInput.value = '';
    roleInput.value = kind === 'role' ? (owner.role || '') : '';
    if (kindInput && ttlInput) {
      const k = kind === 'role' ? (owner.kind || inferActorKind(owner.name)) : 'human';
      kindInput.value = k;
      ttlInput.value = String(kind === 'role' ? (owner.defaultTtlMinutes || defaultClaimTtl(k)) : defaultClaimTtl(k));
      syncTtlBounds();
    }
    reasonInput.value = '';
    $('ownerEditMessage').textContent = '';
    $('ownerNames').innerHTML = kind === 'rename' ? source.data.owners
      .filter(({ name }) => name !== owner.name)
      .map(({ name, active }) => `<option value="${esc(name)}"${active ? '' : ' label="已停用"'}></option>`).join('') : '';
    renderEditor(session);
    editDialog.showModal();
  }

  nameInput?.addEventListener('input', () => {
    if (!edit || edit.kind !== 'add' || edit.kindTouched || !kindInput || !ttlInput) return;
    const inferred = inferActorKind(nameInput.value.trim() || 'dev');
    if (kindInput.value !== inferred) {
      kindInput.value = inferred;
      ttlInput.value = String(defaultClaimTtl(inferred));
      syncTtlBounds();
    }
  });
  kindInput?.addEventListener('change', () => {
    if (!edit) return;
    edit.kindTouched = true;
    if (ttlInput) {
      ttlInput.value = String(defaultClaimTtl(kindInput.value));
      syncTtlBounds();
    }
  });

  add?.addEventListener('click', () => { if (panel?.data && panelIsCurrent(panel)) openEditor('add', panel); });
  $('importFromTeamBtn')?.addEventListener('click', async () => {
    if (!panel?.data || !panelIsCurrent(panel)) return;
    const session = panel;
    const { projectId } = session.base;
    notice.textContent = '正在从全局团队导入成员…';
    try {
      const teamRes = await fetch('/api/team');
      const teamData = await teamRes.json().catch(() => null);
      if (!teamRes.ok || !Array.isArray(teamData?.members)) throw new Error(teamData?.message || '无法读取全局团队配置');
      if (!teamData.members.length) {
        notice.textContent = '全局团队配置为空，请先在「团队与负载」中添加成员。';
        return;
      }
      const [latest, latestClaims] = await Promise.all([request(projectId), requestOptionalClaims(projectId)]);
      if (!panelIsCurrent(session)) return;
      const roster = [...latest.roster];
      const existingOwnerKeys = new Set(roster.map((r) => keyOf(r.name)));
      const claimsSnapshot = latestClaims || session.claimsData;
      const claimsRoster = Array.isArray(claimsSnapshot?.configuredRoster) ? [...claimsSnapshot.configuredRoster] : [];
      const existingClaimKeys = new Set(claimsRoster.map((r) => keyOf(r.id)));
      let addedCount = 0;
      for (const m of teamData.members) {
        const k = keyOf(m.id);
        const role = m.group || (m.label && m.label !== m.id ? m.label : '');
        if (!existingOwnerKeys.has(k)) {
          existingOwnerKeys.add(k);
          roster.push({ name: m.id, role, active: true });
          addedCount++;
        }
        if (!existingClaimKeys.has(k)) {
          existingClaimKeys.add(k);
          claimsRoster.push({
            id: m.id,
            label: role ? `${m.id} (${role})` : m.id,
            kind: m.kind || inferActorKind(m.id),
            defaultTtlMinutes: m.defaultTtlMinutes || defaultClaimTtl(m.kind || 'human'),
          });
        }
      }
      if (!addedCount) {
        notice.textContent = '全局团队成员均已在当前项目名录中。';
        return;
      }
      const result = await request(projectId, '/api/owners', { owners: roster });
      const updatedClaims = await requestOptionalClaims(projectId, { action: 'roster', roster: claimsRoster });
      const nextClaims = updatedClaims ? { ...claimsSnapshot, configuredRoster: updatedClaims.roster || claimsRoster } : claimsSnapshot;
      if (!panelIsCurrent(session)) return;
      session.claimsData = nextClaims;
      session.data = { ...result, owners: mergeRosterMembers(result, nextClaims) };
      renderList(session, `已从全局团队导入 ${addedCount} 位成员。`);
      if (projectMatches(session.base)) await onChanged?.();
    } catch (err) {
      if (panelIsCurrent(session)) notice.textContent = err.message || '导入全局团队失败';
    }
  });
  list?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-owner-action]');
    if (!button || !panel?.data || !panelIsCurrent(panel)) return;
    const row = button.closest('[data-owner]');
    const owner = panel.data.owners.find(({ name }) => name === row?.dataset.owner);
    if (owner) openEditor(button.dataset.ownerAction, panel, owner);
  });
  $('closeOwnerEdit')?.addEventListener('click', () => { if (!edit?.pending) editDialog.close(); });
  editDialog?.addEventListener('cancel', (event) => { if (edit?.pending) event.preventDefault(); });
  editDialog?.addEventListener('close', () => { if (!editDialog.open) edit = null; });

  function editIsCurrent(session) {
    return edit === session && editDialog.open
      && panelIsCurrent(session.source);
  }

  async function syncClaimsRoster(projectId, claimsData, nextEntry, removeKey = null, renamePair = null) {
    if (!claimsData) return null;
    const baseRoster = Array.isArray(claimsData.configuredRoster) ? claimsData.configuredRoster : [];
    const roster = [];
    const seen = new Set();
    for (const item of baseRoster) {
      let entry = { ...item };
      if (renamePair && keyOf(entry.id) === keyOf(renamePair.from)) {
        if (keyOf(renamePair.to) === UNASSIGNED) continue;
        entry = { ...entry, id: renamePair.to, label: renamePair.to };
      }
      const k = keyOf(entry.id);
      if (removeKey && k === removeKey) continue;
      if (nextEntry && k === keyOf(nextEntry.id)) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      roster.push({
        id: entry.id,
        label: entry.label || entry.id,
        kind: entry.kind || inferActorKind(entry.id),
        defaultTtlMinutes: Number(entry.defaultTtlMinutes) || defaultClaimTtl(entry.kind || inferActorKind(entry.id)),
      });
    }
    if (nextEntry && !seen.has(keyOf(nextEntry.id))) roster.push(nextEntry);
    const updated = await requestOptionalClaims(projectId, { action: 'roster', roster });
    return updated ? { ...claimsData, configuredRoster: updated.roster || roster } : claimsData;
  }

  $('ownerEditForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = edit;
    if (!session || session.pending || !editIsCurrent(session)) return;
    const { kind, source, preview } = session;
    const { projectId } = source.base;
    const name = nameInput.value.trim();
    const role = roleInput.value.trim();
    const memberKind = kindInput?.value === 'agent' ? 'agent' : 'human';
    const maxTtl = memberKind === 'agent' ? 240 : 1440;
    const ttlMinutes = ttlInput ? Number(ttlInput.value) : defaultClaimTtl(memberKind);
    const reason = reasonInput.value.trim();
    const message = $('ownerEditMessage');
    session.pending = true;
    message.textContent = '';
    renderEditor(session);
    try {
      let result;
      let nextClaimsData = source.claimsData;
      let success = '已保存成员配置。';
      if (preview) {
        result = await request(projectId, '/api/owners/rename', {
          from: preview.from, to: preview.to, expectedRevision: preview.revision, ...(reason ? { reason } : {}),
        });
        nextClaimsData = await syncClaimsRoster(projectId, nextClaimsData, null, null, { from: result.from, to: result.to });
        success = `已更新 ${result.affectedCount} 项任务的负责人。`;
        if (projectMatches(source.base)) {
          await onRename?.(result.from, result.to);
          await onChanged?.();
        }
      } else {
        if ((kind === 'add' || kind === 'role') && (!Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > maxTtl)) {
          throw new Error(`租约时长须为 5 至 ${maxTtl} 分钟`);
        }
        const [latest, latestClaims] = await Promise.all([
          request(projectId),
          requestOptionalClaims(projectId),
        ]);
        if (!editIsCurrent(session)) return;
        const claimsSnapshot = latestClaims || source.claimsData;
        const mergedOwners = mergeRosterMembers(latest, claimsSnapshot);
        const current = mergedOwners.find(({ name: n }) => n === session.owner?.name);
        if (kind !== 'add' && !current) throw new Error('该成员已被移除，请关闭弹窗后重新打开名单。');
        if (kind === 'rename') {
          const target = findOwner(mergedOwners, name);
          const to = keyOf(name) === UNASSIGNED ? UNASSIGNED : target && target.name !== current.name ? target.name : name;
          session.preview = await request(projectId, '/api/owners/rename', { from: current.name, to, dryRun: true });
          return;
        }
        if (kind === 'add' && findOwner(mergedOwners, name)) throw new Error('该成员已存在，请选择已有成员或先在名单中启用。');
        if (kind === 'delete' && current.taskCount > 0) throw new Error('该成员已有任务，请保留或归并。');
        if (kind === 'toggle' && (current.active !== session.owner.active || (current.active && current.openTaskCount !== session.owner.openTaskCount))) {
          session.owner = current;
          message.textContent = '成员状态或任务数已变化，请核对后再确认。';
          return;
        }
        const roster = [...latest.roster];
        const index = roster.findIndex((item) => keyOf(item.name) === keyOf(current?.name ?? name));
        if (kind === 'delete') {
          if (index < 0 && !current.inClaimsRoster) throw new Error('该成员已从名录移除。');
          if (index >= 0) roster.splice(index, 1);
          result = await request(projectId, '/api/owners', { owners: roster });
          nextClaimsData = await syncClaimsRoster(projectId, claimsSnapshot, null, keyOf(current.name));
        } else {
          const targetName = current?.name ?? name;
          const targetRole = kind === 'add' || kind === 'role' ? role : (current.role || '');
          const item = {
            name: targetName,
            role: targetRole,
            active: kind === 'toggle' ? !current.active : current?.active ?? true,
          };
          if (index < 0) roster.push(item);
          else roster[index] = item;
          result = await request(projectId, '/api/owners', { owners: roster });
          const nextKind = kind === 'add' || kind === 'role' ? memberKind : (current.kind || inferActorKind(targetName));
          const nextTtl = kind === 'add' || kind === 'role' ? ttlMinutes : (current.defaultTtlMinutes || defaultClaimTtl(nextKind));
          const claimEntry = {
            id: targetName,
            label: targetRole ? `${targetName} (${targetRole})` : targetName,
            kind: nextKind,
            defaultTtlMinutes: Math.min(nextKind === 'agent' ? 240 : 1440, Math.max(5, nextTtl)),
          };
          nextClaimsData = await syncClaimsRoster(projectId, claimsSnapshot, claimEntry);
        }
        if (projectMatches(source.base)) await onChanged?.();
      }
      if (!editIsCurrent(session)) return;
      editDialog.close();
      source.claimsData = nextClaimsData;
      source.data = { ...result, owners: mergeRosterMembers(result, nextClaimsData) };
      renderList(source, success);
      add.focus?.();
    } catch (error) {
      if (editIsCurrent(session)) {
        if (error.status === 409 && preview && error.code !== 'ACTIVE_CLAIM_CONFLICT') {
          session.preview = null;
          message.textContent = '计划已变化，请重新预览影响后再确认。';
        } else message.textContent = error.message;
      }
    } finally {
      if (editIsCurrent(session)) {
        session.pending = false;
        renderEditor(session);
        if (session.preview) reasonInput.focus?.();
      }
    }
  });

  return {
    close() {
      panel = edit = null;
      if (editDialog?.open) editDialog.close();
      if (dialog.open) dialog.close();
    },
  };
}
