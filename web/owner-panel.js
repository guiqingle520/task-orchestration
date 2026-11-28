export const UNASSIGNED = 'unassigned';
export const ownerLabel = (name) => name === UNASSIGNED ? '未分配' : name;

const keyOf = (name) => name.toLowerCase();
const findOwner = (owners, name) => owners.find((owner) => keyOf(owner.name) === keyOf(name));
const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function installOwnerPanel($, { apiUrl, getProject, onRename }) {
  const dialog = $('ownersDialog');
  if (!dialog) return { close() {} };
  const editDialog = $('ownerEditDialog');
  const list = $('ownersList');
  const notice = $('ownersMessage');
  const add = $('addOwnerBtn');
  const submit = $('saveOwnerEdit');
  const nameInput = $('ownerName');
  const roleInput = $('ownerRole');
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
    if (!response.ok || data?.projectId !== projectId) {
      const message = data?.message || '无法读取或保存负责人，请确认服务已更新后重试。';
      throw Object.assign(new Error(message), { status: response.status, code: data?.code });
    }
    return data;
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
      const status = !owner.active ? '已停用' : owner.inRoster ? '已启用' : '来自现有任务';
      return `<li class="owner-row" data-owner="${esc(owner.name)}">
        <div class="owner-info">
          <strong>${esc(owner.name)}</strong><span class="owner-state">${status}</span>
          ${owner.role ? `<span class="owner-meta">${esc(owner.role)}</span>` : ''}
          <span class="owner-meta">${owner.taskCount} 项任务 · ${owner.openTaskCount} 项未完成</span>
        </div>
        <div class="owner-actions">
          ${button('role', '编辑备注')}${button('rename', '更名 / 归并')}${button('toggle', owner.active ? '停用' : '启用')}
          ${owner.inRoster && owner.taskCount === 0 ? button('delete', '删除') : ''}
        </div>
      </li>`;
    }).join('') : '<li class="empty">还没有负责人。添加后即可在新建或编辑任务时选用。</li>';
    notice.textContent = message;
  }

  $('manageOwnersBtn').addEventListener('click', async () => {
    const base = getProject();
    if (!base || dialog.open) return;
    const session = panel = { base, data: null };
    add.disabled = true;
    list.innerHTML = '';
    notice.textContent = '正在加载负责人…';
    dialog.showModal();
    try {
      session.data = await request(base.projectId);
      if (panelIsCurrent(session)) {
        renderList(session);
        add.disabled = false;
      }
    } catch (error) {
      if (panelIsCurrent(session)) notice.textContent = error.message;
    }
  });
  $('closeOwners').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (!dialog.open) panel = null; });

  function toggleSummary(owner) {
    if (!owner.active) return `重新启用「${owner.name}」后，可在任务表单中选择该负责人。`;
    const reminder = owner.openTaskCount > 0 ? `还有 ${owner.openTaskCount} 项未完成任务，请确认是否需要转交。` : '';
    return `${reminder}停用「${owner.name}」后，现有任务保留原负责人。`;
  }

  function renderEditor(session) {
    const { kind, owner, preview, pending } = session;
    const isMerge = preview?.merging && keyOf(preview.from) !== keyOf(preview.to);
    const titles = {
      add: '新增负责人',
      role: `编辑「${owner?.name}」的角色备注`,
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
      delete: owner ? `从花名册删除「${owner.name}」。` : '',
    };
    $('ownerEditTitle').textContent = titles[kind];
    $('ownerEditSummary').textContent = summary[kind];
    $('ownerEditSummary').hidden = !summary[kind];
    const showName = kind === 'rename' || kind === 'add';
    const showRole = kind === 'role' || kind === 'add';
    $('ownerNameRow').hidden = !showName;
    $('ownerNameLabel').textContent = kind === 'rename' ? '新名称或归并目标' : '负责人名称';
    $('ownerRoleRow').hidden = !showRole;
    $('ownerReasonRow').hidden = !preview;
    nameInput.required = showName && !preview;
    nameInput.disabled = !showName || pending || Boolean(preview);
    roleInput.disabled = !showRole || pending;
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
    const session = edit = { kind, source, owner, preview: null, pending: false };
    nameInput.value = '';
    roleInput.value = kind === 'role' ? owner.role : '';
    reasonInput.value = '';
    $('ownerEditMessage').textContent = '';
    $('ownerNames').innerHTML = kind === 'rename' ? source.data.owners
      .filter(({ name }) => name !== owner.name)
      .map(({ name, active }) => `<option value="${esc(name)}"${active ? '' : ' label="已停用"'}></option>`).join('') : '';
    renderEditor(session);
    editDialog.showModal();
  }

  add.addEventListener('click', () => { if (panel?.data && panelIsCurrent(panel)) openEditor('add', panel); });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-owner-action]');
    if (!button || !panel?.data || !panelIsCurrent(panel)) return;
    const row = button.closest('[data-owner]');
    const owner = panel.data.owners.find(({ name }) => name === row?.dataset.owner);
    if (owner) openEditor(button.dataset.ownerAction, panel, owner);
  });
  $('closeOwnerEdit').addEventListener('click', () => { if (!edit?.pending) editDialog.close(); });
  editDialog.addEventListener('cancel', (event) => { if (edit?.pending) event.preventDefault(); });
  editDialog.addEventListener('close', () => { if (!editDialog.open) edit = null; });

  function editIsCurrent(session) {
    return edit === session && editDialog.open
      && panelIsCurrent(session.source);
  }

  $('ownerEditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = edit;
    if (!session || session.pending || !editIsCurrent(session)) return;
    const { kind, source, preview } = session;
    const { projectId } = source.base;
    const name = nameInput.value.trim();
    const role = roleInput.value.trim();
    const reason = reasonInput.value.trim();
    const message = $('ownerEditMessage');
    session.pending = true;
    message.textContent = '';
    renderEditor(session);
    try {
      let result;
      let success = '已保存负责人。';
      if (preview) {
        result = await request(projectId, '/api/owners/rename', {
          from: preview.from, to: preview.to, expectedRevision: preview.revision, ...(reason ? { reason } : {}),
        });
        success = `已更新 ${result.affectedCount} 项任务的负责人。`;
        if (projectMatches(source.base)) await onRename(result.from, result.to);
      } else {
        const latest = await request(projectId);
        if (!editIsCurrent(session)) return;
        const current = latest.owners.find(({ name }) => name === session.owner?.name);
        if (kind !== 'add' && !current) throw new Error('该负责人已被移除，请关闭弹窗后重新打开名单。');
        if (kind === 'rename') {
          const target = findOwner(latest.owners, name);
          const to = keyOf(name) === UNASSIGNED ? UNASSIGNED : target && target.name !== current.name ? target.name : name;
          session.preview = await request(projectId, '/api/owners/rename', { from: current.name, to, dryRun: true });
          return;
        }
        if (kind === 'add' && findOwner(latest.owners, name)) throw new Error('该负责人已存在，请选择已有负责人或先在名单中启用。');
        if (kind === 'delete' && current.taskCount > 0) throw new Error('该负责人已有任务，请保留或归并。');
        if (kind === 'toggle' && (current.active !== session.owner.active || (current.active && current.openTaskCount !== session.owner.openTaskCount))) {
          session.owner = current;
          message.textContent = '负责人状态或任务数已变化，请核对后再确认。';
          return;
        }
        const roster = [...latest.roster];
        const index = roster.findIndex((item) => keyOf(item.name) === keyOf(current?.name ?? name));
        if (kind === 'delete') {
          if (index < 0) throw new Error('该负责人已从花名册移除。');
          roster.splice(index, 1);
        } else {
          const item = {
            name: current?.name ?? name,
            role: kind === 'add' || kind === 'role' ? role : current.role,
            active: kind === 'toggle' ? !current.active : current?.active ?? true,
          };
          if (index < 0) roster.push(item);
          else roster[index] = item;
        }
        result = await request(projectId, '/api/owners', { owners: roster });
      }
      if (!editIsCurrent(session)) return;
      editDialog.close();
      source.data = result;
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
      if (editDialog.open) editDialog.close();
      if (dialog.open) dialog.close();
    },
  };
}
