import { compute, simulateDelays, toDay, fromDay } from './metrics.js';
import { analyzeLoad, buildReport, buildReportSvg, comparePlans, computeBurndown } from './analysis.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const RH = 60;
const STATUS = { todo: '未开始', doing: '进行中', done: '已完成', blocked: '阻塞' };

let last = null;      // 最近一次 { data, revision, commits, m }
let selected = null;  // 选中的任务或里程碑 id
let refreshSequence = 0;
let editingTask = null;
let isCreatingTask = false;
let plannerMode = false;
let currentProjectId = '';
let defaultProjectId = '';
let eventSource = null;
let webhookChannelsDraft = [];

const apiUrl = (path) => (currentProjectId && currentProjectId !== defaultProjectId)
  ? `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(currentProjectId)}`
  : path;

function downloadReport(content, type, extension) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = `progress-${last.m.today}.${extension}`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('exportMarkdown').addEventListener('click', () => {
  if (last) downloadReport(buildReport(last.data, last.m, last.m.today).markdown, 'text/markdown;charset=utf-8', 'md');
});
$('exportSvg').addEventListener('click', () => {
  if (last) downloadReport(buildReportSvg(last.data, last.m, last.m.today), 'image/svg+xml;charset=utf-8', 'svg');
});
$('copySummary').addEventListener('click', async () => {
  if (!last) return;
  try { await navigator.clipboard.writeText(buildReport(last.data, last.m, last.m.today).summary); $('reportMessage').textContent = '摘要已复制'; }
  catch { $('reportMessage').textContent = '无法访问剪贴板，请检查浏览器权限'; }
});

const snapshotKey = () => `task-orchestration.snapshots.${last.data.project}`;
function readSnapshots() {
  try { const saved = JSON.parse(localStorage.getItem(snapshotKey()) || '[]'); return Array.isArray(saved) ? saved : []; } catch { return []; }
}
function updateSnapshots() {
  const selectedSnapshot = $('snapshots').value;
  const snapshots = readSnapshots();
  $('snapshots').innerHTML = snapshots.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.label)}</option>`).join('');
  if (snapshots.some((entry) => entry.id === selectedSnapshot)) $('snapshots').value = selectedSnapshot;
}
$('saveSnapshot').addEventListener('click', () => {
  if (!last) return;
  try {
    const entries = readSnapshots();
    entries.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label: new Date().toLocaleString(), plan: structuredClone(last.data) });
    localStorage.setItem(snapshotKey(), JSON.stringify(entries));
    updateSnapshots(); $('snapshots').value = entries.at(-1).id;
    $('snapshotResult').textContent = '快照已保存';
  } catch { $('snapshotResult').textContent = '无法保存快照，请检查浏览器存储空间和权限'; }
});
$('compareSnapshot').addEventListener('click', () => {
  if (!last) return;
  const snapshot = readSnapshots().find((entry) => entry.id === $('snapshots').value);
  if (!snapshot) { $('snapshotResult').textContent = '请先保存或选择快照'; return; }
  const changes = comparePlans(snapshot.plan, last.data);
  $('snapshotResult').innerHTML = changes.length ? `<b>${changes.length} 个任务有变化</b><ul>${changes.map((change) => `<li>${esc(change.id)} ${esc(change.title)}：${change.type === 'added' ? '新增' : change.type === 'removed' ? '移除' : change.differences.map((item) => `${esc(item.field)} ${esc(item.before ?? '—')} → ${esc(item.after ?? '—')}`).join('；')}</li>`).join('')}</ul>` : '与当前计划无差异';
});

let simulation = false, delays = {}, simulationResult = null;
$('simEnabled').addEventListener('change', () => { simulation = $('simEnabled').checked; renderAll(false); });
$('simApply').addEventListener('click', () => {
  const days = Number($('simDays').value), id = $('simTask').value;
  if (!id || !Number.isInteger(days) || days < 0 || days > 3650) { $('simResult').textContent = '请输入 0 至 3650 的整数天数'; return; }
  simulation = $('simEnabled').checked = true;
  if (days) delays[id] = days; else delete delays[id];
  renderAll(false);
});
$('simReset').addEventListener('click', () => { delays = {}; $('simDays').value = 0; renderAll(false); });
$('simTask').addEventListener('change', () => { $('simDays').value = delays[$('simTask').value] || 0; });

$('plannerMode').addEventListener('change', () => {
  plannerMode = Boolean($('plannerMode').checked);
  renderAll(false);
});

$('burndownScope').addEventListener('change', () => {
  if (last) renderBurndown(last.data, last.m);
});

function nextTaskId(tasks) {
  const maxNum = tasks.reduce((max, t) => {
    const m = /^T-(\d+)$/.exec(t.id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `T-${maxNum + 1}`;
}

function openTaskModal(task, isNew = false, prefillReason = '') {
  if (!last) return;
  isCreatingTask = isNew;
  editingTask = isNew
    ? {
        id: nextTaskId(last.data.tasks),
        title: '',
        owner: 'dev',
        milestone: last.data.milestones.at(-1)?.id || 'M1',
        start: last.m.today,
        end: last.m.today,
        deps: [],
        status: 'todo',
        progress: 0,
        actualStart: null,
        actualEnd: null,
      }
    : { ...task, deps: [...(task.deps || [])] };

  $('taskTitle').textContent = isNew ? `新建任务 (${editingTask.id})` : `${editingTask.id} ${editingTask.title}`;
  $('taskMeta').textContent = isNew
    ? '规划模式：填写新任务排期与变更原因后保存'
    : `负责人 ${editingTask.owner} · 计划 ${editingTask.start} ~ ${editingTask.end} · 依赖 ${editingTask.deps.join('、') || '无'}`;
  $('plannerFields').hidden = !plannerMode && !isNew;
  $('splitTaskBtn').hidden = !(plannerMode && !isNew);
  $('planTaskMilestone').innerHTML = last.data.milestones.map((ms) => `<option value="${esc(ms.id)}">${esc(ms.id)} · ${esc(ms.name)}</option>`).join('');
  $('planTaskId').value = editingTask.id;
  $('planTaskTitle').value = editingTask.title;
  $('planTaskOwner').value = editingTask.owner;
  $('planTaskMilestone').value = editingTask.milestone;
  $('planTaskStart').value = editingTask.start;
  $('planTaskEnd').value = editingTask.end;
  $('planTaskDeps').value = (editingTask.deps || []).join(', ');
  $('planChangeReason').value = prefillReason;
  $('taskStatus').value = editingTask.status;
  $('taskProgress').value = editingTask.progress;
  $('taskMessage').textContent = '';
  $('taskDialog').showModal?.();
}

document.addEventListener('pointerdown', (event) => {
  const simBar = event.target.closest('[data-sim-drag]');
  if (simBar && event.button === 0) {
    event.preventDefault();
    const id = simBar.dataset.simDrag, startX = event.clientX;
    const pxPerDay = simBar.closest('.tl').getBoundingClientRect().width / Number(simBar.dataset.days);
    const original = delays[id] || 0;
    const finish = (up) => {
      document.removeEventListener('pointerup', finish);
      const days = Math.max(0, Math.min(3650, original + Math.round((up.clientX - startX) / pxPerDay)));
      if (days) delays[id] = days; else delete delays[id];
      $('simTask').value = id; $('simDays').value = days;
      renderAll(false);
    };
    document.addEventListener('pointerup', finish, { once: true });
    return;
  }
  const planBar = event.target.closest('[data-plan-drag]');
  if (planBar && plannerMode && event.button === 0 && last) {
    event.preventDefault();
    const id = planBar.dataset.planDrag, startX = event.clientX;
    const pxPerDay = planBar.closest('.tl').getBoundingClientRect().width / Number(planBar.dataset.days);
    const task = last.data.tasks.find((item) => item.id === id);
    if (!task) return;
    const finishPlanDrag = (up) => {
      document.removeEventListener('pointerup', finishPlanDrag);
      const delta = Math.round((up.clientX - startX) / pxPerDay);
      if (!delta) return;
      const newStart = fromDay(toDay(task.start) + delta);
      const newEnd = fromDay(toDay(task.end) + delta);
      selected = id;
      openTaskModal({ ...task, start: newStart, end: newEnd }, false, `拖拽调整 ${id} 排期(${delta > 0 ? '+' : ''}${delta}天: ${newStart} ~ ${newEnd})`);
    };
    document.addEventListener('pointerup', finishPlanDrag, { once: true });
  }
});

$('closeTask').addEventListener('click', () => $('taskDialog').close?.());
$('taskStatus').addEventListener('change', () => {
  if ($('taskStatus').value === 'done') $('taskProgress').value = 100;
  if ($('taskStatus').value === 'todo') $('taskProgress').value = 0;
});
$('validatePlan').addEventListener('click', async () => {
  try {
    const result = await (await fetch(apiUrl('/api/plan'))).json();
    $('taskMessage').textContent = result.errors?.length ? result.errors.join('；') : '计划校验通过';
  } catch { $('taskMessage').textContent = '无法连接服务'; }
});

async function saveFullPlan(nextData, reason, statusEl) {
  const response = await fetch(apiUrl('/api/plan/save'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project: nextData.project,
      expectedRevision: last?.revision || '',
      milestones: nextData.milestones,
      tasks: nextData.tasks,
      reason,
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    statusEl.textContent = result.message || '保存失败';
    return false;
  }
  return true;
}

$('taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingTask || !last) return;
  if (plannerMode || isCreatingTask) {
    const title = $('planTaskTitle').value.trim();
    const owner = $('planTaskOwner').value.trim();
    const milestone = $('planTaskMilestone').value;
    const start = $('planTaskStart').value;
    const end = $('planTaskEnd').value;
    const deps = $('planTaskDeps').value.split(/[,\s，、]+/).map((s) => s.trim()).filter(Boolean);
    const status = $('taskStatus').value;
    const progress = Number($('taskProgress').value);
    const reason = $('planChangeReason').value.trim();
    const today = last.m.today;
    const updatedTask = {
      id: editingTask.id,
      title,
      owner,
      milestone,
      start,
      end,
      deps,
      status,
      progress,
      actualStart: status === 'todo' ? null : (editingTask.actualStart || today),
      actualEnd: status === 'done' ? (editingTask.actualEnd || today) : null,
    };
    const nextTasks = isCreatingTask
      ? [...last.data.tasks, updatedTask]
      : last.data.tasks.map((t) => (t.id === editingTask.id ? updatedTask : t));
    try {
      const ok = await saveFullPlan({ ...last.data, tasks: nextTasks }, reason, $('taskMessage'));
      if (!ok) return;
      $('taskDialog').close?.();
      selected = updatedTask.id;
      await refresh();
    } catch { $('taskMessage').textContent = '保存失败，无法连接服务'; }
    return;
  }
  const expected = Object.fromEntries(['status', 'progress', 'actualStart', 'actualEnd'].map((key) => [key, editingTask[key]]));
  try {
    const response = await fetch(apiUrl('/api/task'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: editingTask.id, expected, status: $('taskStatus').value, progress: Number($('taskProgress').value) }) });
    const result = await response.json();
    if (!response.ok) { $('taskMessage').textContent = result.message; return; }
    $('taskDialog').close?.();
    await refresh();
  } catch { $('taskMessage').textContent = '保存失败，无法连接服务'; }
});

$('splitTaskBtn').addEventListener('click', async () => {
  if (!editingTask || isCreatingTask || !last) return;
  const reason = $('planChangeReason').value.trim() || `将 ${editingTask.id} 拆分为两个子任务`;
  const s = toDay($('planTaskStart').value || editingTask.start);
  const e = toDay($('planTaskEnd').value || editingTask.end);
  const mid = s + Math.floor((e - s) / 2);
  const secondStart = Math.min(e, mid + 1);
  const newId = nextTaskId(last.data.tasks);
  const baseTitle = ($('planTaskTitle').value || editingTask.title).trim();
  const firstTask = {
    ...editingTask,
    title: `${baseTitle}(上)`,
    owner: $('planTaskOwner').value.trim() || editingTask.owner,
    milestone: $('planTaskMilestone').value || editingTask.milestone,
    start: fromDay(s),
    end: fromDay(mid),
    deps: $('planTaskDeps').value.split(/[,\s，、]+/).map((x) => x.trim()).filter(Boolean),
  };
  const secondTask = {
    id: newId,
    title: `${baseTitle}(下)`,
    owner: firstTask.owner,
    milestone: firstTask.milestone,
    start: fromDay(secondStart),
    end: fromDay(e),
    deps: [firstTask.id],
    status: 'todo',
    progress: 0,
    actualStart: null,
    actualEnd: null,
  };
  const nextTasks = [];
  for (const t of last.data.tasks) {
    if (t.id === firstTask.id) {
      nextTasks.push(firstTask, secondTask);
    } else {
      const nextDeps = (t.deps || []).map((d) => (d === firstTask.id ? secondTask.id : d));
      nextTasks.push({ ...t, deps: nextDeps });
    }
  }
  try {
    const ok = await saveFullPlan({ ...last.data, tasks: nextTasks }, reason, $('taskMessage'));
    if (!ok) return;
    $('taskDialog').close?.();
    selected = secondTask.id;
    await refresh();
  } catch { $('taskMessage').textContent = '拆分失败，无法连接服务'; }
});

$('closeMilestone').addEventListener('click', () => $('milestoneDialog').close?.());
$('milestoneForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!last) return;
  const id = $('msIdInput').value.trim();
  const name = $('msNameInput').value.trim();
  const due = $('msDueInput').value;
  const reason = $('msReasonInput').value.trim();
  const nextMilestones = [...last.data.milestones, { id, name, due }];
  try {
    const ok = await saveFullPlan({ ...last.data, milestones: nextMilestones }, reason, $('milestoneMessage'));
    if (!ok) return;
    $('milestoneDialog').close?.();
    await refresh();
  } catch { $('milestoneMessage').textContent = '保存失败，无法连接服务'; }
});

// 多项目工作区切换与注册 (T-22)
async function refreshProjects() {
  try {
    const res = await (await fetch('/api/projects')).json();
    if (!res || !Array.isArray(res.projects)) return;
    defaultProjectId = res.default || '';
    if (!currentProjectId) currentProjectId = defaultProjectId;
    const dot = { green: '🟢', yellow: '🟡', red: '🔴', unavailable: '⚪' };
    $('projectSelect').innerHTML = res.projects.map((p) => {
      const pctText = typeof p.overall === 'number' ? `${Math.round(p.overall)}%` : '不可用';
      return `<option value="${esc(p.id)}">${dot[p.health] || '⚪'} ${esc(p.name)} (${pctText})</option>`;
    }).join('');
    if (res.projects.some((p) => p.id === currentProjectId)) {
      $('projectSelect').value = currentProjectId;
    }
  } catch { /* 单项目回退 */ }
}

function bindEventsStream() {
  if (typeof EventSource === 'undefined') return;
  try { eventSource?.close?.(); } catch { /* 忽略 */ }
  eventSource = new EventSource(apiUrl('/api/events'));
  eventSource.addEventListener('plan-change', refresh);
}

$('projectSelect').addEventListener('change', async () => {
  currentProjectId = $('projectSelect').value;
  selected = null;
  delays = {};
  bindEventsStream();
  await refresh();
});

$('addProjectBtn').addEventListener('click', () => {
  $('projIdInput').value = '';
  $('projNameInput').value = '';
  $('projRootInput').value = '';
  $('projectMessage').textContent = '';
  $('projectDialog').showModal?.();
});
$('closeProject').addEventListener('click', () => $('projectDialog').close?.());
$('projectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: $('projIdInput').value.trim(),
        name: $('projNameInput').value.trim(),
        repoRoot: $('projRootInput').value.trim(),
      }),
    });
    const result = await response.json();
    if (!response.ok) { $('projectMessage').textContent = result.message || '注册失败'; return; }
    $('projectDialog').close?.();
    currentProjectId = result.project.id;
    bindEventsStream();
    await refresh();
  } catch { $('projectMessage').textContent = '无法连接服务'; }
});

// Webhook 预警渠道配置与一键推送 (T-24)
function renderWebhookDraft() {
  if (!webhookChannelsDraft.length) {
    $('webhookList').innerHTML = '<div class="empty">暂未配置渠道，点击下方「+ 添加渠道」新增。</div>';
    return;
  }
  $('webhookList').innerHTML = webhookChannelsDraft.map((ch, idx) => `
    <div class="webhook-item" data-wh-idx="${idx}">
      <div class="webhook-row">
        <input type="text" data-wh-field="name" value="${esc(ch.name)}" placeholder="渠道名称，如 研发群机器人" required>
        <select data-wh-field="type">
          <option value="feishu" ${ch.type === 'feishu' ? 'selected' : ''}>飞书</option>
          <option value="dingtalk" ${ch.type === 'dingtalk' ? 'selected' : ''}>钉钉</option>
          <option value="wecom" ${ch.type === 'wecom' ? 'selected' : ''}>企业微信</option>
          <option value="generic" ${ch.type === 'generic' ? 'selected' : ''}>通用 JSON</option>
        </select>
        <button type="button" data-wh-remove="${idx}">删除</button>
      </div>
      <div class="webhook-row">
        <input type="url" data-wh-field="url" value="${esc(ch.url || '')}" placeholder="${ch.configured ? '已配置密钥 URL（留空保持不变）' : 'https:// 公网 Webhook 地址'}">
      </div>
      <div class="webhook-row">
        <label><input type="checkbox" data-wh-field="enabled" ${ch.enabled ? 'checked' : ''}> 启用渠道</label>
        <label><input type="checkbox" data-wh-field="autoAlert" ${ch.autoAlert ? 'checked' : ''}> 新增红色高危风险时自动推送</label>
      </div>
    </div>`).join('');
}

function syncWebhookDraftFromDom() {
  document.querySelectorAll('#webhookList .webhook-item').forEach((row) => {
    const idx = Number(row.dataset.whIdx);
    const item = webhookChannelsDraft[idx];
    if (!item) return;
    item.name = row.querySelector('[data-wh-field="name"]').value.trim();
    item.type = row.querySelector('[data-wh-field="type"]').value;
    item.url = row.querySelector('[data-wh-field="url"]').value.trim();
    item.enabled = row.querySelector('[data-wh-field="enabled"]').checked;
    item.autoAlert = row.querySelector('[data-wh-field="autoAlert"]').checked;
  });
}

$('configWebhookBtn').addEventListener('click', async () => {
  $('webhookDialogMsg').textContent = '';
  try {
    const res = await (await fetch('/api/webhooks')).json();
    webhookChannelsDraft = Array.isArray(res.channels) ? res.channels.map((c) => ({ ...c })) : [];
  } catch { webhookChannelsDraft = []; }
  renderWebhookDraft();
  $('webhookDialog').showModal?.();
});

$('addWebhookChannelBtn').addEventListener('click', () => {
  syncWebhookDraftFromDom();
  webhookChannelsDraft.push({
    id: `ch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    name: `通知渠道 ${webhookChannelsDraft.length + 1}`,
    type: 'feishu',
    url: '',
    configured: false,
    enabled: true,
    autoAlert: true,
  });
  renderWebhookDraft();
});

$('webhookList').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-wh-remove]');
  if (!rm) return;
  syncWebhookDraftFromDom();
  webhookChannelsDraft.splice(Number(rm.dataset.whRemove), 1);
  renderWebhookDraft();
});

$('closeWebhook').addEventListener('click', () => $('webhookDialog').close?.());
$('webhookForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  syncWebhookDraftFromDom();
  try {
    const response = await fetch('/api/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: webhookChannelsDraft }),
    });
    const result = await response.json();
    if (!response.ok) { $('webhookDialogMsg').textContent = result.message || '保存失败'; return; }
    $('webhookDialog').close?.();
    $('webhookStatus').textContent = `已保存 ${result.channels.length} 个通知渠道`;
  } catch { $('webhookDialogMsg').textContent = '无法连接服务'; }
});

async function triggerNotify(mode, statusEl) {
  statusEl.textContent = '正在推送…';
  try {
    const response = await fetch(apiUrl('/api/notify'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'all', mode }),
    });
    const result = await response.json();
    if (!response.ok) { statusEl.textContent = result.message || '推送失败'; return; }
    if (!result.results?.length) { statusEl.textContent = '无已启用的 Webhook 渠道，请先点击「配置渠道」'; return; }
    const sent = result.results.filter((r) => r.status === 'sent').length;
    statusEl.textContent = `推送完成：成功 ${sent}/${result.results.length} 个渠道`;
  } catch { statusEl.textContent = '推送请求失败'; }
}

$('pushRisksBtn').addEventListener('click', () => triggerNotify('risks', $('webhookStatus')));
$('pushReportBtn').addEventListener('click', () => triggerNotify('report', $('reportMessage')));

$('today').value = todayLocal();
$('today').addEventListener('change', refresh);
$('reset').addEventListener('click', () => { $('today').value = todayLocal(); refresh(); });
$('syncGit')?.addEventListener('click', async () => {
  try {
    const r = await (await fetch(apiUrl('/api/sync-git'), { method: 'POST' })).json();
    $('updated').textContent = r.ok
      ? (r.touched.length ? `已同步: ${r.touched.join(', ')}` : 'Git 无新变更')
      : `同步失败: ${r.message}`;
    await refresh();
  } catch {
    $('updated').textContent = '同步请求失败';
  }
});

// 点击联动:风险项 / 甘特行 / 条带 / 里程碑 都带 data-id,再次点击取消选中
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-edit-task]')) {
    const task = last?.data.tasks.find((item) => item.id === selected);
    if (!task) return;
    openTaskModal(task, false);
    return;
  }
  const sc = e.target.closest('[data-scale]');
  if (sc) { scale = sc.dataset.scale; store.set('gantt.scale', scale); scrollToTodayNext = true; return renderAll(false); }
  const ac = e.target.closest('[data-act]');
  if (ac && last) {
    const act = ac.dataset.act;
    if (act === 'new-task') { openTaskModal(null, true); return; }
    if (act === 'new-milestone') {
      const nextIdx = last.data.milestones.length + 1;
      $('msIdInput').value = `M${nextIdx}`;
      $('msNameInput').value = '';
      $('msDueInput').value = last.m.today;
      $('msReasonInput').value = '';
      $('milestoneMessage').textContent = '';
      $('milestoneDialog').showModal?.();
      return;
    }
    const ids = last.data.milestones.map((x) => x.id);
    if (act === 'today') scrollToTodayNext = true;
    if (act === 'expand') collapsed.clear();
    if (act === 'collapse') collapsed = new Set(ids);
    saveCollapsed();
    return renderAll(false);
  }
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    const id = tg.dataset.toggle;
    collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
    saveCollapsed();
    return renderAll(false);
  }
  const el = e.target.closest('[data-id]');
  if (!el) return;
  selected = selected === el.dataset.id ? null : el.dataset.id;
  // 选中的任务所在里程碑被折叠时自动展开
  const t = last?.data.tasks.find((x) => x.id === selected);
  if (t && collapsed.has(t.milestone)) { collapsed.delete(t.milestone); saveCollapsed(); }
  renderAll(true);
});

async function refresh() {
  const sequence = ++refreshSequence;
  let res;
  try { res = await (await fetch(apiUrl('/api/plan'))).json(); }
  catch {
    if (sequence === refreshSequence) { $('updated').textContent = '无法连接服务'; showErrors(['无法连接服务']); }
    return;
  }
  if (sequence !== refreshSequence) return;
  showErrors(res.errors);
  if (!res.data || !res.data.tasks) return;
  last = { data: res.data, revision: res.revision || '', commits: res.commits || {}, m: compute(res.data, $('today').value || todayLocal()) };
  $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
  renderAll(false);
  refreshProjects();
}

function renderAll(scroll) {
  if (!last) return;
  const { data, m } = last;
  updateSnapshots();
  const previousTask = $('simTask').value;
  $('simTask').innerHTML = data.tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.id)} ${esc(t.title)}</option>`).join('');
  if (data.tasks.some((t) => t.id === previousTask)) $('simTask').value = previousTask;
  for (const id of Object.keys(delays)) if (!data.tasks.some((task) => task.id === id)) delete delays[id];
  simulationResult = simulation ? simulateDelays(data, delays) : null;
  if (simulationResult) {
    const affected = Object.entries(simulationResult.tasks).filter(([, task]) => task.delayDays > 0);
    const milestones = simulationResult.milestones.filter((item) => item.delayDays > 0);
    $('simResult').textContent = `推演影响 ${affected.length} 个任务${affected.length ? '：' + affected.map(([id, item]) => `${id} +${item.delayDays} 天`).join('、') : ''}；${milestones.length ? '里程碑：' + milestones.map((item) => `${item.id} +${item.delayDays} 天`).join('、') : '里程碑无变化'}。关键任务：${simulationResult.criticalTaskIds.join('、') || '无'}。不写入计划。`;
  } else $('simResult').textContent = '';
  if (selected && !data.tasks.some((t) => t.id === selected) && !m.milestones.some((x) => x.id === selected)) selected = null;
  $('project').textContent = data.project;
  renderKpis(data, m);
  renderGantt(data, m);
  renderDetail(data, m);
  renderBurndown(data, m);
  renderRisks(m);
  renderMilestones(m);
  renderLoad(m);
  if (scroll && selected) document.querySelector('.lrow.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showErrors(errs) {
  const el = $('errors');
  el.hidden = !errs || errs.length === 0;
  el.innerHTML = el.hidden ? '' : `<b>plan.md 校验问题(请让智能体修复):</b><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
}

function renderKpis(data, m) {
  const s = m.summary, nm = s.nextMilestone;
  const label = { green: '正常', yellow: '有风险', red: '告急' }[s.health];
  $('pill').className = 'pill ' + s.health;
  $('pill').textContent = label;
  const diff = Math.round(s.overall - s.expectedAll);
  const dcls = diff < -20 ? 'red' : diff < -5 ? 'yellow' : 'green';
  const kpi = (v, l, cls = '') => `<div class="kpi"><div class="v ${cls}">${v}</div><div class="l">${l}</div></div>`;
  $('kpis').innerHTML =
    `<div class="kpi main"><div class="v">${Math.round(s.overall)}% <span class="dev ${dcls}">${diff >= 0 ? '+' : ''}${diff}% vs 计划</span></div>
      <div class="track"><i style="width:${s.overall}%"></i><b style="left:${s.expectedAll}%" title="计划应达 ${Math.round(s.expectedAll)}%"></b></div>
      <div class="l">实际进度 · 黑线为计划应达 ${Math.round(s.expectedAll)}%</div></div>` +
    kpi(nm ? `${nm.daysLeft} 天` : '—', nm ? `距里程碑「${esc(nm.name)}」` : '无未到期里程碑') +
    kpi(s.overdueCount, '逾期任务', s.overdueCount ? 'red' : '') +
    kpi(s.blockedCount, '阻塞任务', s.blockedCount ? 'red' : '') +
    kpi(`${data.tasks.filter((t) => t.status === 'done').length}/${data.tasks.length}`, '已完成任务');
}

// T-18: SVG 燃尽图与七日速率预测卡片
function renderBurndown(data, m) {
  const scopeEl = $('burndownScope');
  const prevScope = scopeEl.value || 'all';
  scopeEl.innerHTML = `<option value="all">全部里程碑</option>` +
    data.milestones.map((ms) => `<option value="${esc(ms.id)}">${esc(ms.id)} · ${esc(ms.name)}</option>`).join('');
  scopeEl.value = data.milestones.some((ms) => ms.id === prevScope) ? prevScope : 'all';

  let bd;
  try { bd = computeBurndown(data, m.today, scopeEl.value); }
  catch (err) {
    $('burndownSummary').textContent = err.message;
    $('burndownChart').innerHTML = '';
    return;
  }
  if (!bd.series.length) {
    $('burndownSummary').textContent = '当前范围内暂无任务';
    $('burndownChart').innerHTML = '';
    return;
  }
  const rem = Math.round(bd.remainingScope * 10) / 10;
  const slipTxt = bd.slipDays === null
    ? '速率待形成'
    : bd.slipDays > 0
      ? `<span class="red">预计晚 ${bd.slipDays} 天 (${bd.forecastEnd})</span>`
      : bd.slipDays < 0
        ? `<span class="green">预计早 ${-bd.slipDays} 天 (${bd.forecastEnd})</span>`
        : `<span class="green">预计按期 (${bd.forecastEnd})</span>`;
  $('burndownSummary').innerHTML =
    `剩余 <b>${rem}</b> / ${bd.totalScope} 人日 · 7日速率 <b>${bd.velocity}</b> 人日/天 · ${slipTxt}`;

  const W = 320, H = 148, padL = 28, padR = 12, padT = 12, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const startDay = toDay(bd.startDate);
  const endDay = toDay(bd.endDate);
  const forecastDay = bd.forecastEnd ? toDay(bd.forecastEnd) : endDay;
  const maxDay = Math.max(endDay, toDay(m.today), Math.min(endDay + 30, forecastDay));
  const spanDays = Math.max(1, maxDay - startDay);
  const maxScope = Math.max(1, bd.totalScope);
  const xOf = (day) => padL + ((day - startDay) / spanDays) * plotW;
  const yOf = (val) => padT + (1 - val / maxScope) * plotH;

  const idealPts = bd.series.map((pt) => `${xOf(toDay(pt.date)).toFixed(1)},${yOf(pt.ideal).toFixed(1)}`).join(' ');
  const actualSeries = bd.series.filter((pt) => pt.actual !== null);
  const actualPts = actualSeries.map((pt) => `${xOf(toDay(pt.date)).toFixed(1)},${yOf(pt.actual).toFixed(1)}`).join(' ');
  const areaPts = actualSeries.length
    ? `${xOf(toDay(actualSeries[0].date)).toFixed(1)},${(padT + plotH).toFixed(1)} ${actualPts} ${xOf(toDay(actualSeries.at(-1).date)).toFixed(1)},${(padT + plotH).toFixed(1)}`
    : '';

  let forecastLine = '';
  if (bd.forecastEnd && bd.remainingScope > 0 && actualSeries.length) {
    const lastPt = actualSeries.at(-1);
    const fx1 = xOf(toDay(lastPt.date)), fy1 = yOf(lastPt.actual);
    const fx2 = xOf(Math.min(maxDay, forecastDay)), fy2 = yOf(0);
    const fColor = bd.slipDays > 0 ? '#dc2626' : '#16a34a';
    forecastLine = `<line x1="${fx1.toFixed(1)}" y1="${fy1.toFixed(1)}" x2="${fx2.toFixed(1)}" y2="${fy2.toFixed(1)}" stroke="${fColor}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  }

  const dueX = xOf(endDay);
  const todayX = xOf(toDay(m.today));
  $('burndownChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="燃尽图">
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#cbd5e1"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#cbd5e1"/>
    <line x1="${padL}" y1="${yOf(maxScope / 2).toFixed(1)}" x2="${padL + plotW}" y2="${yOf(maxScope / 2).toFixed(1)}" stroke="#f1f5f9"/>
    <text x="4" y="${padT + 8}" font-size="9" fill="#64748b">${maxScope}</text>
    <text x="4" y="${padT + plotH}" font-size="9" fill="#64748b">0</text>
    <text x="${padL}" y="${H - 5}" font-size="9" fill="#64748b">${bd.startDate.slice(5)}</text>
    <text x="${Math.min(W - 34, Math.max(padL + 36, dueX - 14)).toFixed(1)}" y="${H - 5}" font-size="9" fill="#7c3aed">${bd.endDate.slice(5)}</text>
    <line x1="${dueX.toFixed(1)}" y1="${padT}" x2="${dueX.toFixed(1)}" y2="${padT + plotH}" stroke="#7c3aed" stroke-dasharray="3 2"/>
    ${ todayX >= padL && todayX <= padL + plotW ? `<line x1="${todayX.toFixed(1)}" y1="${padT}" x2="${todayX.toFixed(1)}" y2="${padT + plotH}" stroke="#2563eb" stroke-opacity="0.4"/>` : '' }
    <polyline fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4 3" points="${idealPts}"/>
    ${ areaPts ? `<polygon fill="rgba(37,99,235,0.10)" points="${areaPts}"/>` : '' }
    ${ actualPts ? `<polyline fill="none" stroke="#2563eb" stroke-width="2" points="${actualPts}"/>` : '' }
    ${ forecastLine }
  </svg>`;
}

const GH = 34; // 里程碑分组行高
const SCALES = { fit: '适应', day: '日', week: '周', month: '月' };
const PX = { day: 36, week: 14, month: 4 }; // 各缩放档位每天的像素宽度
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } },
};
let scale = store.get('gantt.scale', 'fit');
if (!SCALES[scale]) scale = 'fit';
let collapsed = new Set(store.get('gantt.collapsed', []));
let scrollToTodayNext = false;
const saveCollapsed = () => store.set('gantt.collapsed', [...collapsed]);

function renderCtrl() {
  const plannerBtns = plannerMode
    ? `<button type="button" data-act="new-task">+ 新建任务</button><button type="button" data-act="new-milestone">+ 新建里程碑</button>`
    : '';
  $('gctrl').innerHTML =
    `<div class="seg">${Object.entries(SCALES).map(([k, v]) => `<button data-scale="${k}" class="${scale === k ? 'on' : ''}">${v}</button>`).join('')}</div>` +
    `<button data-act="today">回到今天</button><button data-act="expand">全部展开</button><button data-act="collapse">全部折叠</button>` +
    plannerBtns;
}

function renderGantt(data, m) {
  renderCtrl();
  const I = m.info;
  const days = [...data.tasks.flatMap((t) => [I[t.id].s, I[t.id].e + 1, I[t.id].forecastEnd + 1, ...(simulationResult ? [toDay(simulationResult.tasks[t.id].end) + 1] : [])]), toDay(m.today), ...m.milestones.map((x) => toDay(x.due) + 1)];
  const min = Math.min(...days) - 1, max = Math.max(...days) + 1, n = max - min;
  const pct = (d) => ((d - min) / n) * 100;
  const fit = scale === 'fit';
  const innerW = fit ? null : n * PX[scale];

  // 行布局:里程碑分组行 + (未折叠时)任务行
  const groups = m.milestones.map((ms) => ({ ms, tasks: data.tasks.filter((t) => t.milestone === ms.id) }));
  const rows = [];
  let y = 0;
  for (const g of groups) {
    const isC = collapsed.has(g.ms.id);
    rows.push({ type: 'g', g, y, h: GH, isC });
    y += GH;
    if (!isC) for (const t of g.tasks) { rows.push({ type: 't', t, y, h: RH }); y += RH; }
  }
  const H = y;
  const trow = new Map(rows.filter((r) => r.type === 't').map((r) => [r.t.id, r]));

  // 刻度与网格
  let ticks = '', grid = '';
  const tick = (d, label) => { ticks += `<span style="left:${pct(d)}%">${label}</span>`; grid += `<div class="gl" style="left:${pct(d)}%"></div>`; };
  const dow = (d) => new Date(d * 86400000).getUTCDay();
  if (scale === 'day') {
    for (let d = min; d <= max; d++) {
      const dd = fromDay(d);
      tick(d, d === min || dd.endsWith('-01') ? dd.slice(5) : dd.slice(8));
      if (dow(d) === 0 || dow(d) === 6) grid += `<div class="we" style="left:${pct(d)}%;width:${100 / n}%"></div>`;
    }
  } else if (scale === 'week') {
    for (let d = min; d <= max; d++) {
      if (dow(d) === 1) tick(d, fromDay(d).slice(5));
      if (dow(d) === 0 || dow(d) === 6) grid += `<div class="we" style="left:${pct(d)}%;width:${100 / n}%"></div>`;
    }
  } else if (scale === 'month') {
    for (let d = min; d <= max; d++) {
      const dd = fromDay(d);
      if (dd.endsWith('-01')) tick(d, dd.slice(0, 7));
      else if (dow(d) === 1) grid += `<div class="gl weak" style="left:${pct(d)}%"></div>`;
    }
  } else {
    const want = Math.ceil(n / 9);
    const step = want <= 1 ? 1 : want === 2 ? 2 : want <= 4 ? 3 : 7;
    for (let d = min; d <= max; d++) {
      const t = step === 7 ? dow(d) === 1 : (d - min) % step === 0;
      if (t && pct(d) < 93) tick(d, fromDay(d).slice(5));
    }
  }

  // 左侧列表
  const left = rows.map((r) => {
    if (r.type === 'g') {
      const ms = r.g.ms;
      return `<div class="lgroup" data-toggle="${esc(ms.id)}" title="点击${r.isC ? '展开' : '折叠'}">
        <span class="car">${r.isC ? '▸' : '▾'}</span><b>${esc(ms.name)}</b>
        <span class="gmeta">${r.g.tasks.length} 个任务 · ${Math.round(ms.progress)}%${ms.slipDays > 0 ? ` · <span class="red">延期 ${ms.slipDays} 天</span>` : ''}</span></div>`;
    }
    const t = r.t, i = I[t.id];
    return `<div class="lrow ${selected === t.id ? 'sel' : ''}" data-id="${esc(t.id)}" title="${esc(t.title)}">
      <div class="t"><span class="id ${i.critical ? 'crit' : ''}">${i.critical ? '★' : ''}${esc(t.id)}</span><span class="title">${esc(t.title)}</span></div>
      <div class="s"><span>${esc(t.owner)}</span><span class="pbar"><i style="width:${t.progress}%"></i></span><span>${t.progress}%</span></div></div>`;
  }).join('');

  // 时间线:条带与柱
  let bands = '', bars = '';
  for (const r of rows) {
    if (r.type === 'g') {
      const g = r.g, ms = g.ms;
      bands += `<div class="gband" data-toggle="${esc(ms.id)}" style="top:${r.y}px;height:${GH}px"></div>`;
      if (g.tasks.length) {
        const s = Math.min(...g.tasks.map((t) => I[t.id].s));
        const e = Math.max(...g.tasks.map((t) => I[t.id].e)) + 1;
        const fe = Math.max(...g.tasks.map((t) => I[t.id].forecastEnd)) + 1;
        const cls = ms.slipDays > 0 ? 'red' : 'green';
        bars += `<div class="bar gsum ${cls}" style="left:${pct(s)}%;width:${((e - s) / n) * 100}%;top:${r.y + 12}px" title="${esc(ms.name)} ${fromDay(s)} ~ ${fromDay(e - 1)},进度 ${Math.round(ms.progress)}%"><i style="width:${Math.round(ms.progress)}%"></i></div>`;
        if (fe > e) bars += `<div class="bar slip" style="left:${pct(e)}%;width:${((fe - e) / n) * 100}%;top:${r.y + 12}px" title="预计延期 ${fe - e} 天"></div>`;
      }
      continue;
    }
    const t = r.t, i = I[t.id], sel = selected === t.id ? 'sel' : '';
    const dragAttr = plannerMode ? `data-plan-drag="${esc(t.id)}" data-days="${n}"` : '';
    const dragCls = plannerMode ? 'draggable' : '';
    bands += `<div class="band ${sel}" data-id="${esc(t.id)}" style="top:${r.y}px;height:${RH}px"></div>`;
    bars += `<div class="bar plan ${dragCls} ${sel}" ${dragAttr} style="left:${pct(i.s)}%;width:${(i.dur / n) * 100}%;top:${r.y + 10}px" title="${plannerMode ? '拖拽平移计划排期：' : '计划 '}${t.start} ~ ${t.end}"></div>`;
    if (t.actualStart) {
      const as = toDay(t.actualStart), ae = t.actualEnd ? toDay(t.actualEnd) : Math.max(as, toDay(m.today));
      bars += `<div class="bar act ${i.health}" style="left:${pct(as)}%;width:${((ae - as + 1) / n) * 100}%;top:${r.y + 26}px" title="实际 ${t.actualStart} ~ ${t.actualEnd || '进行中'},进度 ${t.progress}%"><i style="width:${t.progress}%"></i></div>`;
    }
    if (i.slip > 0 && t.status !== 'done')
      bars += `<div class="bar slip" style="left:${pct(i.e + 1)}%;width:${(i.slip / n) * 100}%;top:${r.y + 10}px" title="预计延期 ${i.slip} 天"></div>`;
    if (simulationResult) {
      const sim = simulationResult.tasks[t.id], ss = toDay(sim.start), se = toDay(sim.end);
      bars += `<div class="bar simulation ${sim.critical ? 'critical' : ''}" data-sim-drag="${esc(t.id)}" data-days="${n}" style="left:${pct(ss)}%;width:${((se - ss + 1) / n) * 100}%;top:${r.y + 43}px" title="拖动模拟延期：${sim.start} ~ ${sim.end}，延期 ${sim.delayDays} 天"></div>`;
    }
  }

  // 依赖线(两端任务都可见时才画)
  let paths = '';
  for (const t of data.tasks) for (const d of t.deps) {
    const ra = trow.get(d), rb = trow.get(t.id);
    if (!ra || !rb) continue;
    const a = I[d], b = I[t.id];
    const x1 = pct(a.e + 1), y1 = ra.y + 15, x2 = pct(b.s), y2 = rb.y + 15;
    const cls = [a.critical && b.critical ? 'crit' : '', selected === t.id || selected === d ? 'hl' : ''].join(' ');
    paths += `<path class="${cls}" d="M${x1} ${y1} C${x1 + 1.5} ${y1},${x2 - 1.5} ${y2},${x2} ${y2}"/>`;
  }

  const msl = m.milestones.map((x) => `<div class="msline ${selected === x.id ? 'sel' : ''}" style="left:${pct(toDay(x.due) + 1)}%"><em>◆ ${esc(x.name)}</em></div>`).join('');
  const today = `<div class="todayline" style="left:${pct(toDay(m.today))}%"><em>今天</em></div>`;

  const prevScroll = $('tscroll')?.scrollLeft || 0;
  $('gantt').innerHTML = `<div class="gwrap"><div><div class="lhead">里程碑 / 任务 / 进度</div>${left}</div>
    <div class="tscroll" id="tscroll"><div class="tinner" style="${fit ? 'width:100%' : `width:${innerW}px;min-width:100%`}">
    <div class="thead">${ticks}</div><div class="tl" style="height:${H}px">${grid}${bands}${bars}
    <svg class="deps" viewBox="0 0 100 ${H}" preserveAspectRatio="none">${paths}</svg>${msl}${today}</div></div></div></div>`;

  const sc = $('tscroll');
  if (scrollToTodayNext && !fit) {
    sc.scrollLeft = Math.max(0, (pct(toDay(m.today)) / 100) * innerW - sc.clientWidth / 2);
  } else {
    sc.scrollLeft = prevScroll;
  }
  scrollToTodayNext = false;
}

function renderDetail(data, m) {
  const el = $('detail');
  const t = data.tasks.find((x) => x.id === selected);
  if (t) {
    const i = m.info[t.id];
    const cmts = (last.commits?.[t.id] || []).slice(-3).map((c) => `<code>${esc(c.hash)}</code> ${esc(c.subject)}(${esc(c.date)})`).join(' · ');
    el.innerHTML = `<b>${esc(t.id)} ${esc(t.title)}</b> · ${STATUS[t.status]} · 负责人 ${esc(t.owner)}<br>
      计划 ${t.start} ~ ${t.end}(应达 ${Math.round(i.expected)}%),实际 ${t.actualStart || '—'} ~ ${t.actualEnd || '—'}(完成 ${t.progress}%)<br>
      依赖:${t.deps.length ? t.deps.join(', ') : '无'}${i.slip > 0 && t.status !== 'done' ? ` · <span class="red">预计延期 ${i.slip} 天(预计 ${fromDay(i.forecastEnd)} 完成)</span>` : ''}${i.critical ? ' · <span class="red">关键路径</span>' : ''}${cmts ? `<br>关联提交:${cmts}` : ''}<br><button type="button" data-edit-task>${plannerMode ? '规划/拆分任务' : '编辑任务'}</button>`;
    return;
  }
  const ms = m.milestones.find((x) => x.id === selected);
  el.innerHTML = ms
    ? `<b>◆ ${esc(ms.name)}</b> · 目标 ${ms.due} · 预计 ${ms.forecast} 完成 · 包含 ${ms.taskCount} 个任务`
    : '<span>提示:点击右侧风险项、左侧任务行或里程碑,可在时间线中高亮并查看详情。</span>';
}

function renderRisks(m) {
  $('risks').innerHTML = m.risks.length
    ? m.risks.map((r) => `<li class="${r.level} ${selected === r.id ? 'sel' : ''}" data-id="${esc(r.id)}"><b>${esc(r.id)}</b>${esc(r.text)}</li>`).join('')
    : '<li class="empty" style="cursor:default;border-color:var(--g)">暂无风险 🎉</li>';
}

function renderMilestones(m) {
  $('milestones').innerHTML = m.milestones.map((x) => `<div class="ms ${selected === x.id ? 'sel' : ''}" data-id="${esc(x.id)}">
    <div><b>${esc(x.name)}</b> <span class="empty">${x.due}(${x.daysLeft >= 0 ? `还剩 ${x.daysLeft} 天` : `已过 ${-x.daysLeft} 天`})</span></div>
    <div class="bar2"><i style="width:${Math.round(x.progress)}%"></i></div>
    <div class="${x.slipDays > 0 ? 'red' : 'green'}">${x.slipDays > 0 ? `预计 ${x.forecast} 完成,延期 ${x.slipDays} 天` : '按期可完成'} · 进度 ${Math.round(x.progress)}%</div></div>`).join('');
}

function renderLoad(m) {
  const analysis = analyzeLoad(last.data);
  const owners = Object.keys(analysis.load);
  if (!owners.length) { $('load').innerHTML = '<span class="empty">没有未完成任务</span>'; return; }
  const head = analysis.weeks.map((w) => `<th>${fromDay(w).slice(5)}</th>`).join('');
  const rows = owners.map((o) => `<tr><th>${esc(o)}</th>${analysis.weeks.map((w) => {
    const c = analysis.load[o][w] || 0;
    return `<td class="${c >= 3 ? 'l3' : c === 2 ? 'l2' : c ? 'l1' : ''}">${c || ''}</td>`;
  }).join('')}</tr>`).join('');
  const suggestions = analysis.suggestions.map((s) => `<li>${esc(s.owner)}：${s.conflictDay} 出现冲突，可试将 ${esc(s.id)} 顺延至 ${s.start} ~ ${s.end}；需复核下游依赖和交付日期。</li>`).join('');
  $('load').innerHTML = `<div class="loadw"><table class="load"><tr><th>周起</th>${head}</tr>${rows}</table></div><div class="empty" style="font-size:12px;margin-top:6px">每周展示每日并行任务峰值；≥3 标红。</div>${suggestions ? `<ul class="load-suggestions">${suggestions}</ul>` : '<div class="empty">暂无资源冲突建议</div>'}`;
}

refresh();
bindEventsStream();
// 监听不可用时仍可恢复更新。
setInterval(refresh, 5000);
