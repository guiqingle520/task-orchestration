import { bindProjectWizard } from './project-wizard.js';
import { compute, previewPlanEdit, simulateDelays, toDay, fromDay } from './metrics.js';
import { analyzeLoad, buildReport, buildReportSvg, comparePlans, computeBurndown, computeTimelineDiff } from './analysis.js';
import { installM5Panels } from './m5-panels.js';
import { filterTasks, followUpTasks, milestoneDelay, normalizeQuery, readTaskLink, taskLinkUrl } from './m6.js';
import { closeSearchPicker, enhanceSearchPicker, syncSearchPicker } from './search-picker.js';
import { installPortfolio } from './portfolio-panel.js';
import { PROJECT_HEALTH_LABELS } from './portfolio.js';
import { installTimelineView } from './timeline-view.js';
import { computeFitTickDays, layoutMilestoneLabels } from './gantt-layout.js';
import { buildTaskHandoff, readyTasks } from './task-handoff.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const RH = 52;
const STATUS = { todo: '未开始', doing: '进行中', done: '已完成', blocked: '阻塞' };
const renderedMarkup = new WeakMap();
function renderMarkup(el, markup) {
  if (renderedMarkup.get(el) === markup) return;
  el.innerHTML = markup;
  renderedMarkup.set(el, markup);
}

let last = null;      // 最近一次 { data, revision, commits, m }
let selected = null;  // 选中的任务或里程碑 id
let refreshSequence = 0;
let projectsSequence = 0;
let workspaceEpoch = 0;
let editingTask = null;
let taskEditBase = null;
let milestoneEditBase = null;
let planGesture = null;
let planConfirmation = null;
let isCreatingTask = false;
let plannerMode = false;
const pageSearch = new URLSearchParams(globalThis.location?.search);
let pendingTaskLink = readTaskLink(pageSearch);
let currentProjectId = pageSearch.get('project') || '';
let scrollToDeliveries = !pendingTaskLink && globalThis.location?.hash === '#deliveries';
let portfolioActive = false;
let defaultProjectId = 'default';
let eventSource = null;
let webhookChannelsDraft = [];
let webhookProjects = [];
const taskFilterFields = { query: 'taskQuery', status: 'filterStatus', owner: 'filterOwner', milestone: 'filterMilestone' };
let taskFilters = {};
let todayActionOwner = '';

// T-29: 时间机器与基线幽灵条状态
let isTimeMachine = false;
let showBaselineGhost = false;
let historyCommits = [];
const historyCache = new Map();
let historyFetch = null;
let historySliderFrame = null;
let historySeekTimer = null;
let baselinePlanData = null;
let currentFrameIndex = 0;
let historyRequest = 0;
let isPlaying = false;
let playTimer = null;
let liveBackup = null;

const selectedProjectId = () => currentProjectId || defaultProjectId;
const apiUrl = (path, projectId = currentProjectId) => projectId
  ? `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}`
  : path;

function downloadFile(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadReport(content, type, extension) {
  downloadFile(content, type, `progress-${last.m.today}.${extension}`);
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

const snapshotKey = () => `task-orchestration.snapshots.by-project.${last.projectId}`;
function readSnapshots() {
  try {
    const saved = JSON.parse(localStorage.getItem(snapshotKey())
      ?? (last.projectId === 'default' ? localStorage.getItem(`task-orchestration.snapshots.${last.data.project}`) : null)
      ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch { return []; }
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
    syncSearchPicker($('snapshots'));
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
  $('timelineFocusPlanner').setAttribute?.('aria-pressed', String(plannerMode));
  if (!plannerMode) resetPlanGesture();
  renderAll(false);
});
$('timelineFocusPlanner').addEventListener('click', () => $('plannerMode').click());

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

function openTaskModal(task, isNew = false, prefillReason = '', base = last) {
  if (isTimeMachine || !base || base.epoch !== workspaceEpoch) return;
  taskEditBase = { ...base };
  isCreatingTask = isNew;
  editingTask = isNew
    ? {
        id: nextTaskId(base.data.tasks),
        title: '',
        owner: 'dev',
        milestone: base.data.milestones.at(-1)?.id || 'M1',
        start: base.m.today,
        end: base.m.today,
        deps: [],
        status: 'todo',
        progress: 0,
        actualStart: null,
        actualEnd: null,
      }
    : { ...task, deps: [...(task.deps || [])] };

  $('taskTitle').textContent = isNew ? `新建任务 (${editingTask.id})` : `${editingTask.id} ${editingTask.title}`;
  if ($('taskIssue')) $('taskIssue').innerHTML = isNew ? '' : m5Panels.issueMarkup(editingTask.id);
  $('taskMeta').textContent = isNew
    ? '规划模式：填写新任务排期与变更原因后保存'
    : `负责人 ${editingTask.owner} · 计划 ${editingTask.start} ~ ${editingTask.end} · 依赖 ${editingTask.deps.join('、') || '无'}`;
  $('plannerFields').hidden = !plannerMode && !isNew;
  $('splitTaskBtn').hidden = !(plannerMode && !isNew);
  $('planTaskMilestone').innerHTML = base.data.milestones.map((ms) => `<option value="${esc(ms.id)}">${esc(ms.id)} · ${esc(ms.name)}</option>`).join('');
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
  if (isTimeMachine) return;
  const simBar = event.target.closest('[data-sim-drag]');
  if (last && simBar && event.button === 0) {
    event.preventDefault();
    const id = simBar.dataset.simDrag, startX = event.clientX;
    const pxPerDay = simBar.closest('.tl').getBoundingClientRect().width / Number(simBar.dataset.days);
    const original = delays[id] || 0;
    const epoch = workspaceEpoch;
    const finish = (up) => {
      document.removeEventListener('pointerup', finish);
      if (!last || epoch !== workspaceEpoch) return;
      const days = Math.max(0, Math.min(3650, original + Math.round((up.clientX - startX) / pxPerDay)));
      if (days) delays[id] = days; else delete delays[id];
      $('simTask').value = id; $('simDays').value = days;
      syncSearchPicker($('simTask'));
      renderAll(false);
    };
    document.addEventListener('pointerup', finish, { once: true });
    return;
  }
  if (!last || !plannerMode || event.button !== 0 || planGesture) return;
  const bar = event.target.closest('[data-plan-drag]');
  if (!bar) return;
  const edge = event.target.closest('[data-plan-resize]')?.dataset.planResize;
  const anchor = event.target.closest('[data-dep-from]');
  if (!anchor && event.target.closest('[data-dep-to]')) return;
  const timeline = bar.closest('.tl');
  const task = last.data.tasks.find((item) => item.id === bar.dataset.planDrag);
  const pxPerDay = timeline.getBoundingClientRect().width / Number(bar.dataset.days);
  if (!task || !(pxPerDay > 0)) return;
  event.preventDefault();
  planGesture = { base: last, task, timeline, pxPerDay, edge, anchor, pointerId: event.pointerId, startX: event.clientX };
});

function resetPlanGesture() {
  const gesture = planGesture, timeline = gesture?.timeline;
  timeline?.querySelectorAll('.conflict-highlight,.dep-target').forEach((bar) => bar.classList.remove('conflict-highlight', 'dep-target'));
  timeline?.querySelector('.dep-draft')?.removeAttribute('d');
  $('planDragTip').hidden = true;
  planGesture = null;
  if (gesture && last && last !== gesture.base) renderAll(false);
}

function describeConflict({ upstreamId, downstreamId, upstreamEnd, downstreamStart }) {
  return `${downstreamId} 从 ${downstreamStart} 开始，早于前置任务 ${upstreamId} 的结束日 ${upstreamEnd}`;
}

function gestureOperation(gesture, event) {
  const { task, timeline, anchor, edge, startX, pxPerDay } = gesture;
  if (anchor) {
    const row = document.elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest('[data-dep-to],[data-gantt-task]')).find((element) => element && timeline.contains(element));
    const toId = row?.dataset.depTo || row?.dataset.ganttTask;
    return toId ? { type: 'link', fromId: task.id, toId } : null;
  }
  const deltaDays = Math.round((event.clientX - startX) / pxPerDay);
  if (!deltaDays) return null;
  if (!edge) return { type: 'move', taskId: task.id, deltaDays };
  const date = new Date((toDay(task[edge]) + deltaDays) * 86400000);
  return { type: 'resize', taskId: task.id, edge, targetDate: Number.isNaN(date.getTime()) ? '' : date.toISOString().split('T')[0] };
}

document.addEventListener('pointermove', (event) => {
  const gesture = planGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const { timeline, anchor, task, base } = gesture;
  const operation = gestureOperation(gesture, event);
  // 指针在同一天或同一个目标任务内移动时复用试算结果。
  const key = JSON.stringify(operation);
  if (key !== gesture.key) {
    gesture.key = key;
    gesture.preview = operation ? previewPlanEdit(base.data, operation) : null;
    const affected = new Set(gesture.preview?.conflicts.map(({ downstreamId }) => downstreamId));
    timeline.querySelectorAll('[data-plan-drag]').forEach((bar) => {
      bar.classList.toggle('conflict-highlight', affected.has(bar.dataset.planDrag));
      bar.classList.toggle('dep-target', Boolean(gesture.preview?.valid && operation?.toId === bar.dataset.planDrag));
    });
  }
  const result = gesture.preview;
  const tip = $('planDragTip');
  tip.hidden = !operation && !anchor;
  if (tip.hidden) return;
  const updated = result?.nextPlan?.tasks.find((item) => item.id === task.id);
  const dates = updated ? `${updated.start} ～ ${updated.end}（${toDay(updated.end) - toDay(updated.start) + 1} 天）` : '';
  const summary = anchor ? (operation ? `${task.id} → ${operation.toId}` : '拖到下游任务所在行以建立依赖') : dates;
  tip.textContent = [summary, result?.conflicts.length ? describeConflict(result.conflicts[0]) : result?.message].filter(Boolean).join(' · ');
  tip.style.left = Math.max(0, Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - 8)) + 'px';
  tip.style.top = Math.max(0, Math.min(event.clientY + 14, window.innerHeight - tip.offsetHeight - 8)) + 'px';
  if (anchor) {
    const rect = timeline.getBoundingClientRect(), start = anchor.getBoundingClientRect();
    const line = timeline.querySelector('.dep-draft');
    const x1 = (start.left + start.width / 2 - rect.left) / rect.width * 100;
    const x2 = (event.clientX - rect.left) / rect.width * 100;
    line?.setAttribute('d', `M${x1} ${start.top + start.height / 2 - rect.top} L${x2} ${event.clientY - rect.top}`);
    line?.classList.toggle('invalid', Boolean(result && !result.valid));
  }
});

document.addEventListener('pointerup', (event) => {
  const gesture = planGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const operation = gestureOperation(gesture, event);
  resetPlanGesture();
  if (!operation) return;
  const result = previewPlanEdit(gesture.base.data, operation);
  if (operation.type === 'link' && !result.nextPlan) {
    $('planGestureMessage').textContent = result.message;
    return;
  }
  openPlanConfirmation(gesture.base, operation);
});
document.addEventListener('pointercancel', (event) => {
  if (event.pointerId === planGesture?.pointerId) resetPlanGesture();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && planGesture) {
    event.preventDefault();
    resetPlanGesture();
  }
  if (plannerMode && last && ['Enter', ' '].includes(event.key)) {
    const line = event.target.closest?.('[data-unlink-from]');
    if (line) {
      event.preventDefault();
      openPlanConfirmation(last, { type: 'unlink', fromId: line.dataset.unlinkFrom, toId: line.dataset.unlinkTo });
    }
  }
});

$('closeTask').addEventListener('click', () => $('taskDialog').close?.());
$('taskDialog').addEventListener('close', () => { if (!$('taskDialog').open) taskEditBase = null; });
$('taskStatus').addEventListener('change', () => {
  if ($('taskStatus').value === 'done') $('taskProgress').value = 100;
  if ($('taskStatus').value === 'todo') $('taskProgress').value = 0;
});
$('validatePlan').addEventListener('click', async () => {
  const base = taskEditBase;
  if (!base || !last || base.epoch !== workspaceEpoch) return;
  try {
    const result = await (await fetch(apiUrl('/api/plan', base.projectId))).json();
    if (taskEditBase !== base) return;
    $('taskMessage').textContent = result.message || (result.errors?.length ? result.errors.join('；') : '计划校验通过');
  } catch { if (taskEditBase === base) $('taskMessage').textContent = '无法连接服务'; }
});

async function saveFullPlan(base, nextData, reason, statusEl, isCurrent) {
  const response = await fetch(apiUrl('/api/plan/save', base.projectId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project: nextData.project,
      expectedRevision: base.revision,
      milestones: nextData.milestones,
      tasks: nextData.tasks,
      reason,
    }),
  });
  const result = await response.json();
  if (!isCurrent()) return false;
  if (!response.ok) {
    statusEl.textContent = response.status === 409 ? '计划已变化，请关闭弹窗后重新打开，再应用你的更改。' : result.message || '保存失败';
    return false;
  }
  return result;
}

function updatePlanConfirmation() {
  const edit = planConfirmation;
  if (!edit) return;
  const previousReason = edit.preview?.suggestedReason || '';
  const operation = { ...edit.operation, cascade: $('planCascade').checked };
  const chosenDate = $('planGestureDate').value;
  if (operation.type === 'move') operation.deltaDays = toDay(chosenDate) - toDay(edit.task.start);
  if (operation.type === 'resize') operation.targetDate = chosenDate;
  const result = edit.preview = previewPlanEdit(edit.base.data, operation);
  const manualConflict = edit.task && result.conflicts.some(({ downstreamId }) => downstreamId === edit.task.id);
  $('planCascadeRow').hidden = operation.type === 'unlink' || Boolean(manualConflict)
    || !result.conflicts.length && !result.cascadedTaskIds.length && !$('planCascade').checked;
  const changes = (result.nextPlan?.tasks || []).flatMap((next, index) => {
    const original = edit.base.data.tasks[index];
    if (next.start === original.start && next.end === original.end) return [];
    return [`<li><b>${esc(next.id)}</b>：${esc(next.start)} ～ ${esc(next.end)}${result.cascadedTaskIds.includes(next.id) ? '（顺延）' : ''}</li>`];
  });
  $('planEditChanges').innerHTML = changes.join('');
  $('planEditConflicts').innerHTML = result.conflicts.map((conflict) => `<li>${esc(describeConflict(conflict))}</li>`).join('');
  $('planEditMessage').textContent = result.message;
  const reason = $('planEditReason');
  if (!reason.value || reason.value === previousReason) reason.value = result.suggestedReason;
  edit.noChange = !changes.length && edit.task !== undefined;
  $('savePlanEdit').disabled = edit.pending || !result.valid || edit.noChange;
}

function openPlanConfirmation(base, operation) {
  if (!last || isTimeMachine || !plannerMode || base.epoch !== workspaceEpoch || $('planEditDialog').open) return;
  $('planGestureMessage').textContent = '';
  const task = base.data.tasks.find(({ id }) => id === operation.taskId);
  planConfirmation = { base, operation, task, pending: false };
  $('planEditTitle').textContent = task ? `调整 ${task.id} 的计划日期`
    : `${operation.type === 'link' ? '建立' : '解除'}依赖：${operation.fromId} → ${operation.toId}`;
  $('planEditDateRow').hidden = !task;
  $('planEditDateLabel').textContent = operation.edge === 'end' ? '结束日期' : '开始日期';
  const day = task && operation.type === 'move' ? new Date((toDay(task.start) + operation.deltaDays) * 86400000) : null;
  $('planGestureDate').value = day && !Number.isNaN(day.getTime()) ? day.toISOString().split('T')[0] : operation.targetDate || '';
  $('planCascade').checked = false;
  $('planEditReason').value = '';
  $('planGestureDate').disabled = $('planCascade').disabled = $('planEditReason').disabled = false;
  updatePlanConfirmation();
  $('planEditDialog').showModal();
}

$('planCascade').addEventListener('change', updatePlanConfirmation);
$('planGestureDate').addEventListener('input', updatePlanConfirmation);
$('closePlanEdit').addEventListener('click', () => { planConfirmation = null; $('planEditDialog').close(); });
$('planEditDialog').addEventListener('close', () => { if (!$('planEditDialog').open) planConfirmation = null; });
$('planEditForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const edit = planConfirmation;
  if (!edit || !last || edit.base.epoch !== workspaceEpoch || edit.pending || edit.noChange || !edit.preview.valid) return;
  const isCurrent = () => planConfirmation === edit;
  edit.pending = true;
  $('savePlanEdit').disabled = $('planGestureDate').disabled = $('planCascade').disabled = $('planEditReason').disabled = true;
  try {
    const saved = await saveFullPlan(edit.base, edit.preview.nextPlan, $('planEditReason').value.trim(), $('planEditMessage'), isCurrent);
    if (saved && isCurrent()) {
      selected = edit.operation.taskId || edit.operation.toId;
      if (last.revision === edit.base.revision && saved.data && saved.revision) {
        last = { ...last, data: saved.data, revision: saved.revision, m: compute(saved.data, last.m.today) };
        renderAll(false);
      }
      planConfirmation = null;
      $('planEditDialog').close();
      await refresh();
    }
  } catch { if (isCurrent()) $('planEditMessage').textContent = '保存失败，无法连接服务'; }
  finally {
    if (isCurrent()) {
      edit.pending = false;
      $('savePlanEdit').disabled = $('planGestureDate').disabled = $('planCascade').disabled = $('planEditReason').disabled = false;
    }
  }
});

$('taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const base = taskEditBase;
  const isCurrent = () => taskEditBase === base;
  if (!editingTask || !last || !base || base.epoch !== workspaceEpoch) return;
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
    const today = base.m.today;
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
      ? [...base.data.tasks, updatedTask]
      : base.data.tasks.map((t) => (t.id === editingTask.id ? updatedTask : t));
    try {
      const ok = await saveFullPlan(base, { ...base.data, tasks: nextTasks }, reason, $('taskMessage'), isCurrent);
      if (!ok) return;
      $('taskDialog').close?.();
      selected = updatedTask.id;
      await refresh();
    } catch { if (isCurrent()) $('taskMessage').textContent = '保存失败，无法连接服务'; }
    return;
  }
  const expected = Object.fromEntries(['status', 'progress', 'actualStart', 'actualEnd'].map((key) => [key, editingTask[key]]));
  try {
    const response = await fetch(apiUrl('/api/task', base.projectId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: editingTask.id, expected, status: $('taskStatus').value, progress: Number($('taskProgress').value) }) });
    const result = await response.json();
    if (!isCurrent()) return;
    if (!response.ok) { $('taskMessage').textContent = result.message; return; }
    $('taskDialog').close?.();
    await refresh();
  } catch { if (isCurrent()) $('taskMessage').textContent = '保存失败，无法连接服务'; }
});

$('splitTaskBtn').addEventListener('click', async () => {
  const base = taskEditBase;
  const isCurrent = () => taskEditBase === base;
  if (!editingTask || isCreatingTask || !last || !base || base.epoch !== workspaceEpoch) return;
  const reason = $('planChangeReason').value.trim() || `将 ${editingTask.id} 拆分为两个子任务`;
  const s = toDay($('planTaskStart').value || editingTask.start);
  const e = toDay($('planTaskEnd').value || editingTask.end);
  const mid = s + Math.floor((e - s) / 2);
  const secondStart = Math.min(e, mid + 1);
  const newId = nextTaskId(base.data.tasks);
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
  for (const t of base.data.tasks) {
    if (t.id === firstTask.id) {
      nextTasks.push(firstTask, secondTask);
    } else {
      const nextDeps = (t.deps || []).map((d) => (d === firstTask.id ? secondTask.id : d));
      nextTasks.push({ ...t, deps: nextDeps });
    }
  }
  try {
    const ok = await saveFullPlan(base, { ...base.data, tasks: nextTasks }, reason, $('taskMessage'), isCurrent);
    if (!ok) return;
    $('taskDialog').close?.();
    selected = secondTask.id;
    await refresh();
  } catch { if (isCurrent()) $('taskMessage').textContent = '拆分失败，无法连接服务'; }
});

$('closeMilestone').addEventListener('click', () => $('milestoneDialog').close?.());
$('milestoneDialog').addEventListener('close', () => { if (!$('milestoneDialog').open) milestoneEditBase = null; });
$('milestoneForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const base = milestoneEditBase;
  const isCurrent = () => milestoneEditBase === base;
  if (!last || !base || base.epoch !== workspaceEpoch) return;
  const id = $('msIdInput').value.trim();
  const name = $('msNameInput').value.trim();
  const due = $('msDueInput').value;
  const reason = $('msReasonInput').value.trim();
  const nextMilestones = [...base.data.milestones, { id, name, due }];
  try {
    const ok = await saveFullPlan(base, { ...base.data, milestones: nextMilestones }, reason, $('milestoneMessage'), isCurrent);
    if (!ok) return;
    $('milestoneDialog').close?.();
    await refresh();
  } catch { if (isCurrent()) $('milestoneMessage').textContent = '保存失败，无法连接服务'; }
});

// 多项目工作区切换与注册 (T-22)
function syncProjectOptions(registry) {
  defaultProjectId = registry.default || 'default';
  const select = $('projectSelect');
  const options = registry.projects.map(p => {
    const progress = typeof p.overall === 'number' ? `${Math.round(p.overall)}%` : '';
    const state = Object.hasOwn(PROJECT_HEALTH_LABELS, p.health) ? p.health : 'unavailable';
    const label = progress ? `${p.name} · ${progress}` : p.name;
    return `<option value="${esc(p.id)}" data-health="${state}" data-label="${esc(label)}" data-search-label="${esc(p.name)}">${esc(label)} · ${PROJECT_HEALTH_LABELS[state]}</option>`;
  }).join('');
  if (select.innerHTML !== options) select.innerHTML = options;
  select.value = selectedProjectId();
  syncSearchPicker(select);
}

async function refreshProjects() {
  if (portfolioActive) return;
  const sequence = ++projectsSequence;
  try {
    const res = await (await fetch('/api/projects')).json();
    if (portfolioActive || sequence !== projectsSequence || !Array.isArray(res.projects)) return;
    syncProjectOptions(res);
  } catch { /* 单项目回退 */ }
}

function bindEventsStream() {
  if (typeof EventSource === 'undefined') return;
  try { eventSource?.close?.(); } catch { /* 忽略 */ }
  eventSource = new EventSource(apiUrl('/api/events'));
  eventSource.addEventListener('plan-change', refresh);
}

function setPlanAvailable(available) {
  const isWritable = available && !isTimeMachine;
  for (const id of ['plannerMode', 'timelineFocusPlanner', 'syncGit', 'simEnabled', 'simTask', 'simDays', 'simApply', 'simReset',
    'exportMarkdown', 'exportSvg', 'copySummary', 'pushReportBtn', 'saveSnapshot', 'snapshots', 'compareSnapshot', 'pushRisksBtn']) {
    if ($(id)) $(id).disabled = !isWritable;
  }
  if ($('burndownScope')) $('burndownScope').disabled = !available;
  m5Panels.setAvailable(isWritable ? last : null);
}

function clearPlan() {
  if (isTimeMachine) exitTimeMachine(false);
  historyRequest++;
  historyCommits = [];
  historyCache.clear();
  baselinePlanData = null;
  last = null;
  resetPlanGesture();
  planConfirmation = null;
  selected = null;
  editingTask = taskEditBase = milestoneEditBase = null;
  todayActionOwner = '';
  for (const id of ['taskDialog', 'milestoneDialog', 'planEditDialog', 'handoffDialog']) if ($(id)?.open) $(id).close();
  for (const id of ['kpis', 'gctrl', 'timelineActions', 'timelineOptions', 'timelineRange', 'gantt', 'detail', 'milestones', 'risks', 'load', 'burndownSummary',
    'burndownChart', 'snapshots', 'simTask', 'simResult', 'snapshotResult', 'reportMessage', 'webhookStatus', 'planGestureMessage', 'followUpTasks', 'todayFollowList', 'todayReadyList']) {
    if ($(id)) {
      $(id).innerHTML = '';
      renderedMarkup.delete($(id));
    }
  }
  for (const id of ['project', 'overviewProject', 'pill', 'riskCount', 'todayFollowCount', 'todayReadyCount']) if ($(id)) $(id).textContent = '';
  if ($('pill')) $('pill').className = 'pill';
  $('taskFilters').hidden = $('follow-up').hidden = true;
  setPlanAvailable(false);
}

async function ensureBaselinePlan() {
  if (baselinePlanData) return baselinePlanData;
  const base = last;
  if (!base) return null;
  const sameWorkspace = () => last && base.epoch === workspaceEpoch && last.projectId === base.projectId;
  try {
    const res = await (await fetch(apiUrl('/api/history', base.projectId))).json();
    if (!sameWorkspace()) return null;
    if (res.commits && res.commits.length) {
      const firstCommit = res.commits[0];
      let cached = historyCache.get(firstCommit.hash);
      if (!cached) {
        cached = await (await fetch(apiUrl(`/api/history?rev=${encodeURIComponent(firstCommit.hash)}`, base.projectId))).json();
        if (!sameWorkspace()) return null;
        if (cached?.data) historyCache.set(firstCommit.hash, cached);
      }
      if (cached?.data) {
        baselinePlanData = cached.data;
        return baselinePlanData;
      }
    }
  } catch { /* 忽略 */ }
  return null;
}

async function enterTimeMachine() {
  if (isTimeMachine || !last) return;
  const base = last;
  const sequence = ++historyRequest;
  try {
    const res = await (await fetch(apiUrl('/api/history?frames=1', base.projectId))).json();
    if (!last || sequence !== historyRequest || base.epoch !== workspaceEpoch || last.projectId !== base.projectId) return;
    if (!res.commits || !res.commits.length) {
      if ($('planGestureMessage')) $('planGestureMessage').textContent = '当前项目暂无有效的 Git 历史计划快照';
      return;
    }
    isTimeMachine = true;
    resetPlanGesture();
    for (const id of ['taskDialog', 'milestoneDialog', 'planEditDialog', 'webhookDialog']) if ($(id)?.open) $(id).close();
    editingTask = taskEditBase = milestoneEditBase = planConfirmation = null;
    historyCommits = res.commits;
    for (const [hash, frame] of Object.entries(res.frames || {})) historyCache.set(hash, frame);
    liveBackup = { ...last, data: structuredClone(last.data) };
    if ($('timeMachineBar')) $('timeMachineBar').hidden = false;
    if ($('tmBanner')) $('tmBanner').hidden = false;
    const slider = $('tmSlider');
    if (slider) {
      slider.min = 0;
      slider.max = historyCommits.length - 1;
      currentFrameIndex = 0;
      slider.value = currentFrameIndex;
    }
    setPlanAvailable(false);
    await loadHistoryFrame(currentFrameIndex);
  } catch (err) {
    if (sequence === historyRequest && $('planGestureMessage')) $('planGestureMessage').textContent = '加载 Git 历史失败：' + (err.message || err);
  }
}

function exitTimeMachine(restore = true) {
  if (!isTimeMachine) return;
  stopPlay();
  isTimeMachine = false;
  historyRequest++;
  historyFetch?.abort();
  historyFetch = null;
  if (historySliderFrame !== null) cancelAnimationFrame(historySliderFrame);
  historySliderFrame = null;
  clearTimeout(historySeekTimer);
  historySeekTimer = null;
  if ($('timeMachineBar')) $('timeMachineBar').hidden = true;
  if ($('tmBanner')) $('tmBanner').hidden = true;
  if (liveBackup) {
    last = liveBackup;
    liveBackup = null;
  }
  if (restore) {
    setPlanAvailable(true);
    renderAll(false);
  }
}

async function loadHistoryFrame(index) {
  if (!isTimeMachine || !historyCommits[index] || !liveBackup) return;
  const base = liveBackup;
  const sequence = ++historyRequest;
  currentFrameIndex = index;
  const commit = historyCommits[index];
  if ($('tmSlider')) $('tmSlider').value = index;
  historyFetch?.abort();
  historyFetch = null;

  let cached = historyCache.get(commit.hash);
  if (!cached) {
    const controller = new AbortController();
    historyFetch = controller;
    try {
      const res = await (await fetch(apiUrl(`/api/history?rev=${encodeURIComponent(commit.hash)}`, base.projectId), { signal: controller.signal })).json();
      if (!controller.signal.aborted && isTimeMachine && base.epoch === workspaceEpoch && res.data) {
        cached = res;
        historyCache.set(commit.hash, cached);
      }
    } catch { /* A later slider position can cancel the read. */ }
    finally { if (historyFetch === controller) historyFetch = null; }
  }
  if (!isTimeMachine || sequence !== historyRequest || base.epoch !== workspaceEpoch) return;
  if (!cached?.data) {
    $('tmFrameInfo').textContent = `无法加载快照 ${commit.shortHash}，请重试`;
    return;
  }
  if ($('tmBannerCommit')) $('tmBannerCommit').textContent = `${commit.shortHash} (${commit.date}) - ${commit.subject}`;
  if ($('tmFrameInfo')) {
    $('tmFrameInfo').innerHTML = `<span class="tm-badge">${esc(commit.shortHash)}</span>
      <b>${esc(commit.date)}</b> · ${esc(commit.author)} · ${esc(commit.subject)} ·
      当时进度: <b>${Math.round(commit.overall)}%</b> (${commit.doneCount}/${commit.taskCount} 项完成)`;
  }

  const frameDate = commit.date;
  const m = compute(cached.data, frameDate);
  last = {
    projectId: base.projectId,
    epoch: workspaceEpoch,
    data: cached.data,
    acceptanceByTask: cached.acceptanceByTask || {},
    revision: commit.hash,
    commits: {},
    m,
    isHistory: true,
  };
  renderAll(false);
}

function togglePlay() {
  if (isPlaying) stopPlay();
  else startPlay();
}

function startPlay() {
  if (isPlaying || !historyCommits.length) return;
  isPlaying = true;
  if ($('tmPlayPause')) $('tmPlayPause').textContent = '⏸ 暂停';
  if (currentFrameIndex >= historyCommits.length - 1) {
    currentFrameIndex = -1;
  }
  stepPlay();
}

function stepPlay() {
  if (!isPlaying) return;
  const speed = Number($('tmSpeed')?.value || 1);
  const interval = speed === 2 ? 750 : 1500;
  playTimer = setTimeout(async () => {
    if (!isPlaying) return;
    if (currentFrameIndex < historyCommits.length - 1) {
      await loadHistoryFrame(currentFrameIndex + 1);
      stepPlay();
    } else {
      stopPlay();
    }
  }, interval);
}

function stopPlay() {
  isPlaying = false;
  if (playTimer) { clearTimeout(playTimer); playTimer = null; }
  if ($('tmPlayPause')) $('tmPlayPause').textContent = '▶ 播放';
}

async function switchProject(projectId) {
  closeSearchPicker();
  pendingTaskLink = null;
  scrollToDeliveries = false;
  showTaskLinkNotice('');
  if (globalThis.location) {
    const url = new URL(location.href);
    url.searchParams.set('project', projectId);
    url.searchParams.delete('task');
    if (portfolioActive) {
      url.hash = '#overview';
      history.pushState(null, '', url);
      updateWorkspaceNav();
      $('overview').scrollIntoView?.({ block: 'start' });
    } else history.replaceState(null, '', url);
  }
  currentProjectId = projectId;
  workspaceEpoch++;
  setTaskFilters();
  clearPlan();
  delays = {};
  $('simDays').value = 0;
  $('burndownScope').value = 'all';
  $('updated').textContent = '正在加载项目计划…';
  showErrors([]);
  bindEventsStream();
  await refresh();
}

$('projectSelect').addEventListener('change', () => switchProject($('projectSelect').value));

bindProjectWizard($, async (project) => {
  const select = $('projectSelect');
  if (![...select.options].some(({ value }) => value === project.id)) select.add(new Option(project.name, project.id));
  select.value = project.id;
  void refreshProjects();
  await switchProject(project.id);
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
      <fieldset class="webhook-row">
        <legend>允许发送的项目（未选择时不发送）</legend>
        ${webhookProjects.map(({ id, name }) => `<label><input type="checkbox" data-wh-project value="${esc(id)}" ${ch.projects?.includes(id) ? 'checked' : ''}> ${esc(name)}（${esc(id)}）</label>`).join('')}
      </fieldset>
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
    item.projects = [...row.querySelectorAll('[data-wh-project]:checked')].map((input) => input.value);
  });
}

$('configWebhookBtn').addEventListener('click', async () => {
  if (isTimeMachine) return;
  $('webhookDialogMsg').textContent = '';
  try {
    const [config, registry] = await Promise.all([fetch('/api/webhooks'), fetch('/api/projects')]);
    if (isTimeMachine) return;
    if (!config.ok || !registry.ok) throw new Error();
    const [{ channels }, { projects }] = await Promise.all([config.json(), registry.json()]);
    if (!Array.isArray(channels) || !Array.isArray(projects)) throw new Error();
    webhookProjects = projects;
    webhookChannelsDraft = channels.map((channel) => ({ ...channel }));
    renderWebhookDraft();
    if (!$('webhookDialog').open) $('webhookDialog').showModal?.();
  } catch { $('webhookStatus').textContent = '无法读取渠道或项目列表，请重试'; }
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
    projects: [],
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
  if (!last || isTimeMachine) return;
  const { epoch, projectId } = last;
  statusEl.textContent = '正在推送…';
  try {
    const response = await fetch(apiUrl('/api/notify', projectId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channelId: 'all', mode }),
    });
    const result = await response.json();
    if (!last || epoch !== workspaceEpoch) return;
    if (!response.ok) { statusEl.textContent = result.message || '推送失败'; return; }
    if (!result.results?.length) { statusEl.textContent = '当前项目没有可用渠道，请在「配置渠道」中授权该项目'; return; }
    const sent = result.results.filter((r) => r.status === 'sent').length;
    statusEl.textContent = `推送完成：成功 ${sent}/${result.results.length} 个渠道`;
  } catch { if (last && epoch === workspaceEpoch) statusEl.textContent = '推送请求失败'; }
}

$('pushRisksBtn').addEventListener('click', () => triggerNotify('risks', $('webhookStatus')));
$('pushReportBtn').addEventListener('click', () => triggerNotify('report', $('reportMessage')));

$('today').value = (!pendingTaskLink && pageSearch.get('today')) || todayLocal();
if (!$('today').value) $('today').value = todayLocal();
$('today').addEventListener('change', refresh);
$('reset').addEventListener('click', () => { $('today').value = todayLocal(); refresh(); });
$('syncGit')?.addEventListener('click', async () => {
  if (!last || isTimeMachine) return;
  const { epoch, projectId } = last;
  try {
    const r = await (await fetch(apiUrl('/api/sync-git', projectId), { method: 'POST' })).json();
    if (!last || epoch !== workspaceEpoch) return;
    $('updated').textContent = r.ok
      ? (r.touched.length ? `已同步: ${r.touched.join(', ')}` : 'Git 无新变更')
      : `同步失败: ${r.message}`;
    await refresh();
  } catch {
    if (last && epoch === workspaceEpoch) $('updated').textContent = '同步请求失败';
  }
});

// 点击联动:风险项 / 甘特行 / 条带 / 里程碑 都带 data-id,再次点击取消选中
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-copy-task-link]')) {
    void copyTaskLink();
    return;
  }
  const followUp = e.target.closest('[data-follow-task]');
  if (followUp && last) {
    revealTimelineItem(followUp.dataset.followTask);
    return;
  }
  const quickEdit = e.target.closest('[data-quick-edit]');
  if (quickEdit && last && !isTimeMachine) {
    const task = last.data.tasks.find((item) => item.id === quickEdit.dataset.quickEdit);
    if (task) openTaskModal(task, false);
    return;
  }
  const handoff = e.target.closest('[data-handoff-task]');
  if (handoff && last) {
    openHandoffModal(handoff.dataset.handoffTask);
    return;
  }
  const stage = e.target.closest('[data-show-stage]');
  if (stage && last) {
    setTaskFilters({ milestone: stage.dataset.showStage });
    revealTimelineItem(stage.dataset.showStage);
    return;
  }
  const link = e.target.closest('[data-unlink-from]');
  if (link && plannerMode && last) {
    openPlanConfirmation(last, { type: 'unlink', fromId: link.dataset.unlinkFrom, toId: link.dataset.unlinkTo });
    return;
  }
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
      milestoneEditBase = { ...last };
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
    if (act === 'toggle-time-machine') {
      if (isTimeMachine) exitTimeMachine();
      else void enterTimeMachine();
      return;
    }
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
  const fromSideList = Boolean(e.target.closest('#risks, #milestones, #capacityMetrics'));
  selected = selected === el.dataset.id ? null : el.dataset.id;
  // 选中的任务所在里程碑被折叠时自动展开
  const t = last?.data.tasks.find((x) => x.id === selected);
  if (t && !filterTasks([t], taskFilters).length) setTaskFilters();
  if (t && collapsed.has(t.milestone)) { collapsed.delete(t.milestone); saveCollapsed(); }
  if (fromSideList && selected) ensureTimelineView();
  const focusList = e.target.closest('#milestones, #risks');
  renderAll(true);
  if (!fromSideList) {
    [...(focusList?.querySelectorAll('button[data-id]') || [])].find((button) => button.dataset.id === el.dataset.id)?.focus({ preventScroll: true });
  }
});

const VIEW_META = {
  portfolio: { view: 'portfolio', title: '跨项目总览', desc: '' },
  overview: { view: 'overview', title: '项目总览', desc: '' },
  timeline: { view: 'timeline', title: '计划时间线', desc: '' },
  delivery: { view: 'delivery', title: '里程碑与风险', desc: '追踪阶段交付进度、延期风险与 Webhook 预警推送。' },
  capacity: { view: 'capacity', title: '负载与工时', desc: '查看成员每周并行峰值、工作日历配置与预估准确率。' },
  tools: { view: 'tools', title: '报告与集成', desc: '导出周报与脱敏离线驾驶舱、管理快照并同步平台 Issue。' },
};

function resolveWorkspaceView(hash) {
  switch (hash) {
    case '#portfolio': return VIEW_META.portfolio;
    case '#timeline':
    case '#follow-up': return VIEW_META.timeline;
    case '#deliveries':
    case '#risk-panel': return VIEW_META.delivery;
    case '#capacityCard':
    case '#loadCard': return VIEW_META.capacity;
    case '#reports':
    case '#snapshots-panel':
    case '#integrations': return VIEW_META.tools;
    default: return VIEW_META.overview;
  }
}

function ensureTimelineView() {
  if (typeof location === 'undefined') return;
  if (resolveWorkspaceView(location.hash).view === 'timeline') return;
  const url = new URL(location.href);
  url.hash = '#timeline';
  history.pushState(null, '', url);
  updateWorkspaceNav();
}

function updateWorkspaceNav() {
  if (typeof location === 'undefined') return;
  const active = location.hash || (pendingTaskLink ? '#timeline' : '#overview');
  const meta = resolveWorkspaceView(active);
  const wasPortfolio = portfolioActive;
  portfolioActive = meta.view === 'portfolio';
  if (meta.view !== 'timeline') void timelineView.close({ restore: false });
  if (wasPortfolio && !portfolioActive) portfolio.cancel();
  if (document.body?.dataset) document.body.dataset.view = meta.view;
  $('portfolio').hidden = $('portfolioCrumb').hidden = !portfolioActive;
  $('singleProjectView').hidden = $('project').hidden = $('plannerToggle').hidden = $('syncGit').hidden = portfolioActive;
  if ($('viewCrumbSep')) $('viewCrumbSep').hidden = portfolioActive;
  if ($('viewCrumb')) {
    $('viewCrumb').hidden = portfolioActive;
    $('viewCrumb').textContent = meta.title;
  }
  const sectionHead = $('sectionViewHead');
  if (sectionHead) {
    const showSectionHead = !portfolioActive && meta.view !== 'overview' && meta.view !== 'timeline';
    sectionHead.hidden = !showSectionHead;
    if (showSectionHead) {
      $('sectionViewTitle').textContent = meta.title;
      $('sectionViewDesc').textContent = meta.desc;
    }
  }
  $('updated').hidden = portfolioActive;
  $('workspaceSkip').href = portfolioActive ? '#portfolio' : meta.view === 'timeline' ? '#timeline' : '#overview';
  $('workspaceSkip').textContent = portfolioActive ? '跳到跨项目总览' : `跳到${meta.title}`;
  document.querySelectorAll('.workspace-nav a').forEach((link) => {
    if (link.dataset?.view === meta.view || link.hash === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  if (meta.view === 'timeline' && last && !planGesture) {
    globalThis.requestAnimationFrame?.(() => {
      if (last && !planGesture) renderGantt(last.data, last.m);
    });
  }
  return wasPortfolio !== portfolioActive;
}

async function refresh() {
  const sequence = ++refreshSequence;
  if (portfolioActive) return portfolio.refresh($('today').value || todayLocal());
  const projectId = selectedProjectId();
  let res;
  try { res = await (await fetch(apiUrl('/api/plan'))).json(); }
  catch {
    if (sequence === refreshSequence) {
      $('updated').textContent = '无法连接服务';
      showErrors(['无法连接服务']);
      if (pendingTaskLink) showTaskLinkNotice('暂时无法连接服务，任务链接将在连接恢复后重试。');
    }
    return;
  }
  if (sequence !== refreshSequence) return;
  showErrors(res.errors?.length ? res.errors : res.message ? [res.message] : []);
  if (!res.data || !Array.isArray(res.data.tasks) || res.errors?.length) {
    if (!isTimeMachine) {
      clearPlan();
      $('updated').textContent = '项目计划不可用';
      if (pendingTaskLink) showTaskLinkNotice('无法打开任务链接：项目不存在或计划不可用。');
      refreshProjects();
    }
    return;
  }
  const refreshed = { projectId: res.projectId || projectId, epoch: workspaceEpoch, data: res.data, revision: res.revision || '',
    acceptanceByTask: res.acceptanceByTask || {}, commits: res.commits || {}, m: compute(res.data, $('today').value || todayLocal()) };
  if (isTimeMachine) {
    liveBackup = refreshed;
    return;
  }
  last = refreshed;
  setPlanAvailable(true);
  m5Panels.syncLive(last);
  $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
  const linked = pendingTaskLink;
  pendingTaskLink = null;
  let revealed = false;
  if (linked) {
    if (!linked.project || linked.project !== last.projectId) showTaskLinkNotice('无法打开任务链接：项目不存在或未指定。');
    else if (!last.data.tasks.some(({ id }) => id === linked.task)) showTaskLinkNotice(`无法打开任务链接：当前项目找不到任务 ${linked.task || '（未指定）'}。`);
    else { showTaskLinkNotice(''); revealTimelineItem(linked.task); revealed = true; }
  }
  if (!planGesture && !revealed) renderAll(false);
  if (scrollToDeliveries) {
    scrollToDeliveries = false;
    if (location.hash === '#deliveries') $('deliveries').scrollIntoView?.({ block: 'start' });
  }
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
  $('overviewProject').textContent = data.project;
  updateTaskFilters(data);
  renderKpis(data, m);
  renderTodayActions(data, m);
  renderGantt(data, m);
  renderFollowUp(data, m);
  renderDetail(data, m);
  renderBurndown(data, m);
  renderRisks(data, m);
  renderMilestones(m);
  renderLoad(m);
  for (const id of ['snapshots', 'simTask', 'burndownScope', 'filterOwner', 'filterMilestone', 'todayActionOwner']) syncSearchPicker($(id));
  if (scroll && selected) document.querySelector('.lrow.sel, .lgroup.sel')?.scrollIntoView({ block: 'nearest' });
}

function setTaskFilters(filters = {}) {
  taskFilters = filters;
  for (const [key, id] of Object.entries(taskFilterFields)) {
    $(id).value = filters[key] ?? '';
    syncSearchPicker($(id));
  }
}

function updateTaskFilters(data) {
  $('taskFilters').hidden = $('follow-up').hidden = false;
  const optionList = (key, entries, all) => {
    const el = $(taskFilterFields[key]);
    const chosen = taskFilters[key] ?? '';
    const options = [['', all], ...entries];
    if (chosen && !entries.some(([id]) => id === chosen)) options.push([chosen, `${chosen}（当前版本无此选项）`]);
    const markup = options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    if (el.innerHTML !== markup) el.innerHTML = markup;
    el.value = chosen;
  };
  const owners = [...new Set(data.tasks.map(task => task.owner))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  optionList('owner', owners.map(owner => [owner, owner]), '全部负责人');
  optionList('milestone', data.milestones.map(({ id, name }) => [id, `${id} · ${name}`]), '全部里程碑');
}

function applyTaskFilters() {
  if (!last || planGesture) return;
  const { data, m } = last;
  const task = data.tasks.find(item => item.id === selected);
  if (task && !filterTasks([task], taskFilters).length) {
    selected = null;
    renderDetail(data, m);
  }
  renderGantt(data, m);
  renderFollowUp(data, m);
}

for (const [key, id] of Object.entries(taskFilterFields)) {
  $(id).addEventListener(key === 'query' ? 'input' : 'change', (event) => {
    if (event.isComposing) return;
    taskFilters[key] = $(id).value;
    applyTaskFilters();
  });
}
$('taskQuery').addEventListener('compositionend', () => {
  taskFilters.query = $('taskQuery').value;
  applyTaskFilters();
});
$('clearTaskFilters').addEventListener('click', () => {
  setTaskFilters();
  applyTaskFilters();
  $('taskQuery').focus?.();
});

function revealTimelineItem(id) {
  if (!last) return;
  ensureTimelineView();
  const task = last.data.tasks.find(task => task.id === id);
  const milestone = task?.milestone ?? id;
  collapsed.delete(milestone);
  saveCollapsed();
  selected = id;
  renderAll(false);
  const row = document.querySelector('.lrow.sel, .lgroup.sel');
  row?.focus?.({ preventScroll: true });
  row?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
}

function showTaskLinkNotice(message) {
  const notice = $('taskLinkNotice');
  notice.textContent = message;
  notice.hidden = !message;
}

async function copyTaskLink() {
  if (!last || isTimeMachine || !last.data.tasks.some(task => task.id === selected)) return;
  const url = taskLinkUrl(location.href, last.projectId, selected);
  const message = $('taskCopyMessage');
  try {
    await navigator.clipboard.writeText(url);
    message.textContent = '任务链接已复制。';
  } catch {
    const field = $('taskLinkFallback');
    field.value = url;
    field.hidden = false;
    field.focus();
    field.select();
    message.textContent = '无法访问剪贴板，请手动复制链接。';
  }
}

function openHandoffModal(taskId) {
  if (!last) return;
  const text = buildTaskHandoff(last.data, taskId, last.acceptanceByTask || {});
  if (!text) return;
  const field = $('handoffText');
  if (field) field.value = text;
  if ($('handoffCopyStatus')) $('handoffCopyStatus').textContent = '';
  $('handoffDialog')?.showModal?.();
}

function renderTodayActions(data, m) {
  const ownerSelect = $('todayActionOwner');
  if (ownerSelect) {
    const owners = [...new Set(data.tasks.map((task) => task.owner))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    if (todayActionOwner && !owners.includes(todayActionOwner)) todayActionOwner = '';
    const markup = [['', '全部负责人'], ...owners.map((owner) => [owner, owner])]
      .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
    if (ownerSelect.innerHTML !== markup) ownerSelect.innerHTML = markup;
    ownerSelect.value = todayActionOwner;
  }
  const byOwner = ({ task }) => !todayActionOwner || task.owner === todayActionOwner;
  const followItems = followUpTasks(data.tasks, m.today).filter(byOwner);
  const readyItems = readyTasks(data.tasks, m.today).filter(byOwner);
  const actionButtons = (task) => {
    const edit = isTimeMachine ? '' : `<button type="button" data-quick-edit="${esc(task.id)}">更新进度</button>`;
    return `<div class="action-item-buttons">${edit}<button type="button" data-handoff-task="${esc(task.id)}">复制开工说明</button></div>`;
  };
  if ($('todayFollowCount')) $('todayFollowCount').textContent = `${followItems.length} 项`;
  if ($('todayFollowList')) {
    renderMarkup($('todayFollowList'), followItems.map(({ task, priority, days }) => {
      const date = days < 0 ? `已逾期 ${-days} 天` : days === 0 ? '今天到期' : `${days} 天后到期`;
      const reason = priority === 0 && days > 7 ? `阻塞中 · 计划截止 ${task.end}` : date;
      return `<li class="action-item">
        <div class="action-item-main">
          <span class="status-chip ${priority === 0 ? 'red' : 'yellow'}">${['阻塞', '逾期', '即将到期'][priority]}</span>
          <div class="action-item-info">
            <button type="button" class="action-task-title" data-follow-task="${esc(task.id)}">${esc(task.id)} · ${esc(task.title)}</button>
            <span class="action-item-reason">${esc(task.owner)} · ${esc(reason)} · 当前 ${task.progress}%</span>
          </div>
        </div>
        ${actionButtons(task)}
      </li>`;
    }).join('') || '<li class="empty">当前没有阻塞、逾期或 7 天内到期的任务。</li>');
  }
  if ($('todayReadyCount')) $('todayReadyCount').textContent = `${readyItems.length} 项`;
  if ($('todayReadyList')) {
    renderMarkup($('todayReadyList'), readyItems.map(({ task, availability, reason }) => {
      const [label, tone] = availability === 'now' ? ['现在可开工', 'green'] : ['可提前开始', 'blue'];
      return `<li class="action-item">
        <div class="action-item-main">
          <span class="status-chip ${tone}">${label}</span>
          <div class="action-item-info">
            <button type="button" class="action-task-title" data-follow-task="${esc(task.id)}">${esc(task.id)} · ${esc(task.title)}</button>
            <span class="action-item-reason">${esc(task.owner)} · ${esc(reason)} · 计划 ${task.start} 开始</span>
          </div>
        </div>
        ${actionButtons(task)}
      </li>`;
    }).join('') || '<li class="empty">当前没有前置已完成的待开始任务。</li>');
  }
}

function renderFollowUp(data, m) {
  const items = followUpTasks(filterTasks(data.tasks, taskFilters), m.today);
  renderMarkup($('followUpTasks'), items.map(({ task, priority, days }) => {
    const date = days < 0 ? `逾期 ${-days} 天` : days === 0 ? '今天到期' : `${days} 天后到期`;
    const deadline = priority === 0 && days > 7 ? `计划截止 ${task.end}` : date;
    return `<li><button type="button" class="follow-up-task" data-follow-task="${esc(task.id)}">
      <span class="status-chip ${priority === 0 ? 'red' : 'yellow'}">${['阻塞', '逾期', '即将到期'][priority]}</span>
      <span><strong>${esc(task.id)} · ${esc(task.title)}</strong><small>${esc(task.owner)} · ${esc(deadline)}</small></span>
      <span aria-hidden="true">›</span></button></li>`;
  }).join('') || '<li class="empty">当前条件下没有需要跟进的任务。</li>');
}

function showErrors(errs) {
  const el = $('errors');
  el.hidden = !errs || errs.length === 0;
  el.innerHTML = el.hidden ? '' : `<b>plan.md 校验问题(请让智能体修复):</b><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
}

function renderKpis(data, m) {
  const s = m.summary, nm = s.nextMilestone;
  $('pill').className = 'pill ' + s.health;
  $('pill').textContent = { green: '正常', yellow: '有风险', red: '告急' }[s.health];
  const diff = Math.round(s.overall - s.expectedAll);
  const dcls = diff < -20 ? 'red' : diff < -5 ? 'yellow' : '';
  const done = data.tasks.filter((t) => t.status === 'done').length;
  $('kpis').innerHTML = `
    <div class="kpi main"><div class="l">总体进度</div>
      <div class="kpi-progress"><div class="v">${Math.round(s.overall)}%</div><span class="dev ${dcls}">较计划 ${diff > 0 ? '+' : ''}${diff} 个百分点</span></div>
      <div class="track" role="img" aria-label="总体进度 ${Math.round(s.overall)}%，计划应达 ${Math.round(s.expectedAll)}%"><i style="width:${s.overall}%"></i><b style="--expected:${s.expectedAll}%" title="计划应达 ${Math.round(s.expectedAll)}%"></b></div></div>
    <div class="kpi"><div class="l">已完成任务</div><div class="v">${done} / ${data.tasks.length}</div><div class="l">共 ${data.tasks.length} 项任务</div></div>
    <div class="kpi"><div class="l">逾期 / 阻塞</div><div class="v"><span class="${s.overdueCount ? 'yellow' : ''}">${s.overdueCount}</span> / <span class="${s.blockedCount ? 'red' : ''}">${s.blockedCount}</span></div><div class="l">${s.overdueCount || s.blockedCount ? '有任务需要跟进' : '暂无逾期或阻塞'}</div></div>
    <div class="kpi"><div class="l">距下个里程碑</div><div class="v">${nm ? nm.daysLeft + ' 天' : '—'}</div><div class="l">${nm ? esc(nm.id + ' · ' + nm.name) : '无未到期里程碑'}</div></div>`;
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
      ? `<span class="yellow">预计晚 ${bd.slipDays} 天 (${bd.forecastEnd})</span>`
      : bd.slipDays < 0
        ? `<span class="green">预计早 ${-bd.slipDays} 天 (${bd.forecastEnd})</span>`
        : `<span class="green">预计按期 (${bd.forecastEnd})</span>`;
  $('burndownSummary').innerHTML =
    `<div class="burndown-value"><strong>${rem}</strong> 人日剩余</div><div>共 ${bd.totalScope} 人日 · 7 日速率 ${bd.velocity} 人日/天 · ${slipTxt}</div>`;

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
  let forecastLine = '';
  if (bd.forecastEnd && bd.remainingScope > 0 && actualSeries.length) {
    const lastPt = actualSeries.at(-1);
    const fx1 = xOf(toDay(lastPt.date)), fy1 = yOf(lastPt.actual);
    const fx2 = xOf(Math.min(maxDay, forecastDay)), fy2 = yOf(0);
    const fColor = bd.slipDays > 0 ? 'var(--y)' : 'var(--acc)';
    forecastLine = `<line x1="${fx1.toFixed(1)}" y1="${fy1.toFixed(1)}" x2="${fx2.toFixed(1)}" y2="${fy2.toFixed(1)}" stroke="${fColor}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  }

  const dueX = xOf(endDay);
  const todayX = xOf(toDay(m.today));
  $('burndownChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="燃尽图">
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="var(--b)"/>
    <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="var(--b)"/>
    <line x1="${padL}" y1="${yOf(maxScope / 2).toFixed(1)}" x2="${padL + plotW}" y2="${yOf(maxScope / 2).toFixed(1)}" stroke="var(--b)"/>
    <text x="4" y="${padT + 8}" font-size="9" fill="var(--m)">${maxScope}</text>
    <text x="4" y="${padT + plotH}" font-size="9" fill="var(--m)">0</text>
    <text x="${padL}" y="${H - 5}" font-size="9" fill="var(--m)">${bd.startDate.slice(5)}</text>
    <text x="${Math.min(W - 34, Math.max(padL + 36, dueX - 14)).toFixed(1)}" y="${H - 5}" font-size="9" fill="var(--ms)">${bd.endDate.slice(5)}</text>
    <line x1="${dueX.toFixed(1)}" y1="${padT}" x2="${dueX.toFixed(1)}" y2="${padT + plotH}" stroke="var(--ms)" stroke-dasharray="3 2"/>
    ${ todayX >= padL && todayX <= padL + plotW ? `<line x1="${todayX.toFixed(1)}" y1="${padT}" x2="${todayX.toFixed(1)}" y2="${padT + plotH}" stroke="var(--acc)" stroke-opacity="0.4"/>` : '' }
    <polyline fill="none" stroke="var(--ms)" stroke-width="1.5" stroke-dasharray="4 3" points="${idealPts}"/>
    ${ actualPts ? `<polyline fill="none" stroke="var(--acc)" stroke-width="2" points="${actualPts}"/>` : '' }
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
  const plannerBtns = (plannerMode && !isTimeMachine)
    ? `<button type="button" data-act="new-task">+ 新建任务</button><button type="button" data-act="new-milestone">+ 新建里程碑</button>
      <span class="planner-legend">拖两端改期，拖右侧锚点到下游任务，点击连线解除依赖。规划允许同日交接；模拟按次日开工。</span>`
    : '';
  $('gctrl').innerHTML =
    `<div class="seg" role="group" aria-label="时间线缩放">${Object.entries(SCALES).map(([k, v]) => `<button data-scale="${k}" class="${scale === k ? 'on' : ''}" aria-pressed="${scale === k}">${v}</button>`).join('')}</div>`;
  $('timelineActions').innerHTML =
    `<button data-act="today">回到今天</button><button type="button" data-act="toggle-time-machine" class="${isTimeMachine ? 'on' : ''}" aria-pressed="${isTimeMachine}" title="基于 Git 历史切片回放计划演进">时间机器</button>`;
  $('timelineOptions').innerHTML =
    `<button data-act="expand">全部展开</button><button data-act="collapse">全部折叠</button>` +
    `<label class="ghost-toggle" title="在甘特图上叠加历史基线幽灵条对比排期演变"><input type="checkbox" id="showBaselineGhost" ${showBaselineGhost ? 'checked' : ''}> 叠加基线幽灵条</label>` +
    plannerBtns;
}

function renderGantt(data, m) {
  renderCtrl();
  const filtering = Boolean(normalizeQuery(taskFilters.query) || taskFilters.status || taskFilters.owner || taskFilters.milestone);
  const visibleTasks = filterTasks(data.tasks, taskFilters);
  $('filterCount').textContent = `${visibleTasks.length} / ${data.tasks.length} 项任务`;
  if (filtering && !visibleTasks.length) {
    $('timelineRange').textContent = '';
    renderMarkup($('gantt'), '<p class="gantt-empty">没有匹配的任务。请调整条件或点击「清空筛选」。</p>');
    return;
  }
  let timelineDiff = null;
  if (showBaselineGhost) {
    const basePlan = isTimeMachine ? (baselinePlanData || liveBackup?.data) : baselinePlanData;
    if (basePlan && basePlan.tasks) {
      try { timelineDiff = computeTimelineDiff(basePlan, data); } catch { /* 忽略 */ }
    }
  }
  const I = m.info;
  const ghostDays = [];
  if (showBaselineGhost && timelineDiff) {
    for (const item of Object.values(timelineDiff.tasks)) {
      if (item.baselineStart) ghostDays.push(toDay(item.baselineStart));
      if (item.baselineEnd) ghostDays.push(toDay(item.baselineEnd) + 1);
    }
  }
  const days = [...data.tasks.flatMap((t) => [I[t.id].s, I[t.id].e + 1, I[t.id].forecastEnd + 1, ...(simulationResult ? [toDay(simulationResult.tasks[t.id].end) + 1] : [])]), toDay(m.today), ...m.milestones.map((x) => toDay(x.due) + 1), ...ghostDays];
  const min = Math.min(...days) - 1, max = Math.max(...days) + 1, n = max - min;
  const pct = (d) => ((d - min) / n) * 100;
  $('timelineRange').textContent = `${fromDay(min + 1)} 至 ${fromDay(max - 1)}`;
  const fit = scale === 'fit';
  const innerW = fit ? null : n * PX[scale];
  const chart = $('gantt');
  const labelWidth = chart.querySelector?.('.lhead')?.offsetWidth ?? 220;
  const trackW = Math.max(1, (chart.clientWidth || 820) - labelWidth);
  const totalW = fit ? trackW : Math.max(trackW, innerW);

  // 行布局:里程碑分组行 + (未折叠时)任务行
  const groups = m.milestones.map((ms) => ({ ms, tasks: visibleTasks.filter((t) => t.milestone === ms.id) }))
    .filter(group => !filtering || group.tasks.length);
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
    for (const d of computeFitTickDays(min, max, trackW)) tick(d, fromDay(d).slice(5));
  }

  // 左侧列表
  const left = rows.map((r) => {
    if (r.type === 'g') {
      const ms = r.g.ms;
      return `<div class="lgroup ${selected === ms.id ? 'sel' : ''}" tabindex="-1" data-toggle="${esc(ms.id)}" title="点击${r.isC ? '展开' : '折叠'}">
        <span class="car">${r.isC ? '▸' : '▾'}</span><b>${esc(ms.name)}</b>
        <span class="gmeta">${filtering ? `${r.g.tasks.length}/${ms.taskCount}` : ms.taskCount} 个任务 · ${Math.round(ms.progress)}%</span>${delayBadge(ms)}</div>`;
    }
    const t = r.t, i = I[t.id];
    return `<div class="lrow ${selected === t.id ? 'sel' : ''}" tabindex="-1" data-id="${esc(t.id)}" title="${esc(t.title)}">
      <div class="t"><span class="title">${esc(t.title)}</span></div>
      <div class="s"><span class="id ${i.critical ? 'crit' : ''}" title="${i.critical ? '关键路径' : ''}">${i.critical ? '★ ' : ''}${esc(t.id)}</span><span class="task-owner" title="${esc(t.owner)}">${esc(t.owner)}</span><span class="task-status ${t.status === 'blocked' ? 'red' : i.overdue ? 'yellow' : ''}">${t.status !== 'blocked' && i.overdue ? '逾期' : STATUS[t.status]} · ${t.progress}%</span></div></div>`;
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
        const cls = milestoneDelay(ms) ? 'red' : 'green';
        bars += `<div class="bar gsum ${cls}" style="left:${pct(s)}%;width:${((e - s) / n) * 100}%;top:${r.y + 12}px" title="${esc(ms.name)} ${fromDay(s)} ~ ${fromDay(e - 1)},进度 ${Math.round(ms.progress)}%"><i style="width:${Math.round(ms.progress)}%"></i></div>`;
        if (fe > e) bars += `<div class="bar slip" style="left:${pct(e)}%;width:${((fe - e) / n) * 100}%;top:${r.y + 12}px" title="预计延期 ${fe - e} 天"></div>`;
      }
      continue;
    }
    const t = r.t, i = I[t.id], sel = selected === t.id ? 'sel' : '';
    const dragAttr = (plannerMode && !isTimeMachine) ? `data-plan-drag="${esc(t.id)}" data-days="${n}"` : '';
    const dragCls = (plannerMode && !isTimeMachine) ? 'draggable' : '';
    bands += `<div class="band ${sel}" data-id="${esc(t.id)}" data-gantt-task="${esc(t.id)}" style="top:${r.y}px;height:${RH}px"></div>`;
    const handles = (plannerMode && !isTimeMachine) ? `<span class="resize-handle start" data-plan-resize="start" title="拉伸开始日期"></span>
      <span class="resize-handle end" data-plan-resize="end" title="拉伸结束日期"></span>
      <i class="dep-anchor in" data-dep-to="${esc(t.id)}" title="接收前置依赖"></i>
      <i class="dep-anchor out" data-dep-from="${esc(t.id)}" title="拖到下游任务以建立依赖"></i>` : '';
    if (showBaselineGhost && timelineDiff && timelineDiff.tasks[t.id]) {
      const btask = timelineDiff.tasks[t.id];
      if (btask.baselineStart && btask.baselineEnd) {
        const bs = toDay(btask.baselineStart), be = toDay(btask.baselineEnd);
        const shift = btask.endShiftDays;
        const shiftBadge = shift > 0
          ? `<span class="ghost-badge red">+${shift}天</span>`
          : shift < 0
            ? `<span class="ghost-badge green">${shift}天</span>`
            : '';
        bars += `<div class="bar ghost" style="left:${pct(bs)}%;width:${((be - bs + 1) / n) * 100}%;top:${r.y + 10}px" title="基线排期: ${btask.baselineStart} ~ ${btask.baselineEnd}${shift ? ` (排期偏移 ${shift > 0 ? '+' : ''}${shift} 天)` : ''}">${shiftBadge}</div>`;
      }
    }
    bars += `<div class="bar plan ${dragCls} ${sel}" ${dragAttr} data-gantt-task="${esc(t.id)}" style="left:${pct(i.s)}%;width:${(i.dur / n) * 100}%;top:${r.y + 10}px" title="${plannerMode ? '拖拽平移计划排期：' : '计划 '}${t.start} ~ ${t.end}">${handles}</div>`;
    if (t.actualStart) {
      const as = toDay(t.actualStart), ae = t.actualEnd ? toDay(t.actualEnd) : Math.max(as, toDay(m.today));
      bars += `<div class="bar act ${i.health}" style="left:${pct(as)}%;width:${((ae - as + 1) / n) * 100}%;top:${r.y + 26}px" title="实际 ${t.actualStart} ~ ${t.actualEnd || '进行中'},进度 ${t.progress}%"><i style="width:${t.progress}%"></i></div>`;
    }
    if (i.slip > 0 && t.status !== 'done')
      bars += `<div class="bar slip" style="left:${pct(i.e + 1)}%;width:${(i.slip / n) * 100}%;top:${r.y + 10}px" title="预计延期 ${i.slip} 天"></div>`;
    if (simulationResult) {
      const sim = simulationResult.tasks[t.id], ss = toDay(sim.start), se = toDay(sim.end);
      bars += `<div class="bar simulation ${sim.critical ? 'critical' : ''}" data-sim-drag="${esc(t.id)}" data-days="${n}" style="left:${pct(ss)}%;width:${((se - ss + 1) / n) * 100}%;top:${r.y + 39}px" title="拖动模拟延期：${sim.start} ~ ${sim.end}，延期 ${sim.delayDays} 天"></div>`;
    }
  }

  // 依赖线(两端任务都可见时才画)
  let paths = '';
  for (const t of data.tasks) for (const d of t.deps) {
    const ra = trow.get(d), rb = trow.get(t.id);
    if (!ra || !rb) continue;
    const a = I[d], b = I[t.id];
    const anchorY = (plannerMode && !isTimeMachine) ? 31 : 15;
    const x1 = pct(a.e + 1), y1 = ra.y + anchorY, x2 = pct(b.s), y2 = rb.y + anchorY;
    const cls = [a.critical && b.critical ? 'crit' : '', selected === t.id || selected === d ? 'hl' : ''].join(' ');
    const curve = `M${x1} ${y1} C${x1 + 1.5} ${y1},${x2 - 1.5} ${y2},${x2} ${y2}`;
    paths += `<path class="${cls}" d="${curve}" marker-end="url(#${a.critical && b.critical ? 'depArrowCritical' : 'depArrow'})"/>`;
    if (plannerMode && !isTimeMachine) paths += `<path class="dep-hit" d="${curve}" data-unlink-from="${esc(d)}" data-unlink-to="${esc(t.id)}" tabindex="0" role="button" aria-label="解除 ${esc(d)} 到 ${esc(t.id)} 的依赖"><title>解除 ${esc(d)} → ${esc(t.id)} 的依赖</title></path>`;
  }

  const msLabels = layoutMilestoneLabels(groups.map(({ ms: x }) => ({ id: x.id, name: x.name, leftPct: pct(toDay(x.due) + 1) })), totalW, selected);
  const msl = groups.map(({ ms: x }) => {
    const pos = msLabels.get(x.id);
    const label = pos?.visible ? `<em class="${pos.align === 'right' ? 'flip' : ''}" style="bottom:${2 + pos.lane * 18}px">◆ ${esc(x.name)}</em>` : '';
    return `<div class="msline ${selected === x.id ? 'sel' : ''}" style="left:${pct(toDay(x.due) + 1)}%" title="${esc(x.name)}（${esc(x.due)}）">${label}</div>`;
  }).join('');
  const todayX = pct(toDay(m.today));
  const today = `<div class="todayline" style="left:${todayX}%"></div>`;
  const todayLabel = `<b class="today-label" style="left:clamp(20px, ${todayX}%, 100% - 20px)">今天</b>`;

  renderMarkup(chart, `<div class="gwrap" style="--track-min:${innerW || 0}px">
    <div class="lhead">任务与状态</div><div class="thead">${ticks}${todayLabel}</div>
    <div class="task-column">${left}</div><div class="tl" style="height:${H}px">${grid}${bands}${bars}
    <svg class="deps" viewBox="0 0 100 ${H}" preserveAspectRatio="none">
      <defs>${['depArrow', 'depArrowCritical'].map((id) => `<marker id="${id}" markerUnits="userSpaceOnUse" markerWidth=".8" markerHeight="7" viewBox="0 0 8 8" preserveAspectRatio="none" refX="8" refY="4" orient="auto"><polygon points="0,0 8,4 0,8"/></marker>`).join('')}</defs>
      ${paths}<path class="dep-draft" aria-hidden="true"/></svg>${msl}${today}</div></div>`);

  if (scrollToTodayNext && !fit) {
    chart.scrollLeft = Math.max(0, (pct(toDay(m.today)) / 100) * totalW - trackW / 2);
  }
  scrollToTodayNext = false;
}

function renderDetail(data, m) {
  const el = $('detail');
  const t = data.tasks.find((x) => x.id === selected);
  if (t) {
    const i = m.info[t.id];
    const cmts = (last.commits?.[t.id] || []).slice(-3).map((c) => `<code>${esc(c.hash)}</code> ${esc(c.subject)}(${esc(c.date)})`).join(' · ');
    const handoffBtn = `<button type="button" data-handoff-task="${esc(t.id)}">复制开工说明</button>`;
    const editBtn = isTimeMachine ? `<br>${handoffBtn}` : `<br><button type="button" data-edit-task>${plannerMode ? '规划/拆分任务' : '编辑任务'}</button> ${handoffBtn} ${m5Panels.issueMarkup(t.id)}
      <button type="button" data-copy-task-link>复制任务链接</button> <span id="taskCopyMessage" role="status"></span>
      <input type="url" id="taskLinkFallback" class="task-link-fallback" aria-label="任务链接" readonly hidden>`;
    renderMarkup(el, `<span class="detail-label">当前任务</span><b>${esc(t.id)} ${esc(t.title)}</b> · ${STATUS[t.status]} · 负责人 ${esc(t.owner)}<br>
      计划 ${t.start} ~ ${t.end}(应达 ${Math.round(i.expected)}%),实际 ${t.actualStart || '—'} ~ ${t.actualEnd || '—'}(完成 ${t.progress}%)<br>
      依赖:${t.deps.length ? t.deps.join(', ') : '无'}${i.slip > 0 && t.status !== 'done' ? ` · <span class="red">预计延期 ${i.slip} 天(预计 ${fromDay(i.forecastEnd)} 完成)</span>` : ''}${i.critical ? ' · <span class="red">关键路径</span>' : ''}${cmts ? `<br>关联提交:${cmts}` : ''}${editBtn}`);
    return;
  }
  const ms = m.milestones.find((x) => x.id === selected);
  renderMarkup(el, ms
    ? `<b>${esc(ms.name)}</b> · 计划交付 ${ms.due} · 完成 ${ms.doneCount}/${ms.taskCount} 项 ${delayBadge(ms)}`
    : '<span>选择任务、里程碑或风险，即可在此查看详情。</span>');
}

function renderRisks(data, m) {
  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  $('riskCount').textContent = `${m.risks.length} 项`;
  $('risks').innerHTML = m.risks.length
    ? m.risks.map((r) => {
      const task = tasks.get(r.id);
      const [label, tone] = task?.status === 'blocked' ? ['阻塞', 'red'] : m.info[r.id]?.overdue ? ['逾期', 'yellow'] : ['延期风险', 'yellow'];
      const title = task?.title || m.milestones.find((ms) => ms.id === r.id)?.name || r.id;
      const prefix = task ? title : `里程碑 ${title}`;
      const reason = r.text.startsWith(prefix) ? r.text.slice(prefix.length).trim() : r.text;
      return `<li><button type="button" class="risk-item ${selected === r.id ? 'sel' : ''}" data-id="${esc(r.id)}" aria-pressed="${selected === r.id}">
        <span class="status-chip ${tone}">${label}</span><span><strong>${esc(title)}</strong><small>${esc(r.id)} · ${esc(reason)}</small></span><span aria-hidden="true">›</span></button></li>`;
    }).join('')
    : '<li class="empty">暂无需要关注的风险</li>';
}

function delayBadge(ms) {
  const delay = milestoneDelay(ms);
  return delay ? `<span class="status-chip red milestone-delay">${delay.label} ${delay.days} 天</span>` : '';
}

function renderMilestones(m) {
  renderMarkup($('milestones'), m.milestones.map((ms) => {
    const progress = Math.round(ms.progress);
    const subtitle = ms.taskCount ? `${progress}% · 已完成 ${ms.doneCount}/${ms.taskCount} 项` : '暂无任务 · 0/0 项';
    const delay = milestoneDelay(ms);
    return `<article class="stage-progress">
      <div class="stage-heading"><span class="ms-id">${esc(ms.id)}</span><strong>${esc(ms.name)}</strong>${delayBadge(ms)}</div>
      ${ms.taskCount ? `<progress value="${ms.progress}" max="100" aria-label="${esc(ms.name)}完成进度"></progress>` : ''}
      <div class="stage-summary"><span>${subtitle}</span><span>计划 <time datetime="${ms.due}">${ms.due}</time></span>
        ${delay?.label === '预计延期' ? `<span>预计 <time datetime="${ms.forecast}">${ms.forecast}</time></span>` : ''}
      </div>
      ${ms.taskCount ? `<button type="button" class="btn-sm stage-jump" data-show-stage="${esc(ms.id)}" aria-label="查看${esc(ms.name)}的甘特任务">查看阶段任务</button>` : ''}
    </article>`;
  }).join('') || '<p class="empty">暂无里程碑</p>');
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

$('tmExit')?.addEventListener('click', () => exitTimeMachine(true));
$('tmBannerExit')?.addEventListener('click', () => exitTimeMachine(true));
$('tmPlayPause')?.addEventListener('click', togglePlay);
$('tmSlider')?.addEventListener('input', (e) => {
  stopPlay();
  historyRequest++;
  historyFetch?.abort();
  clearTimeout(historySeekTimer);
  historySeekTimer = null;
  if (historySliderFrame !== null) cancelAnimationFrame(historySliderFrame);
  historySliderFrame = null;
  const index = Number(e.target.value);
  if (!historyCache.has(historyCommits[index]?.hash)) {
    historySeekTimer = setTimeout(() => {
      historySeekTimer = null;
      void loadHistoryFrame(index);
    }, 100);
    return;
  }
  historySliderFrame = requestAnimationFrame(() => {
    historySliderFrame = null;
    void loadHistoryFrame(index);
  });
});
document.addEventListener('change', async (e) => {
  if (e.target?.id === 'showBaselineGhost') {
    showBaselineGhost = Boolean(e.target.checked);
    if (showBaselineGhost && !baselinePlanData) {
      await ensureBaselinePlan();
    }
    renderAll(false);
  }
});

const m5Panels = installM5Panels({
  getLive: () => !isTimeMachine && last?.epoch === workspaceEpoch ? last : null,
  apiUrl, refresh, downloadFile, esc,
  rerenderDetail() {
    if (!last) return;
    renderDetail(last.data, last.m);
    if ($('taskDialog')?.open && $('taskIssue') && editingTask && !isCreatingTask) $('taskIssue').innerHTML = m5Panels.issueMarkup(editingTask.id);
  },
});
const portfolio = installPortfolio({ esc, syncProjects: syncProjectOptions });
const timelineView = installTimelineView({ beforeOpen: closeSearchPicker });
globalThis.addEventListener?.('hashchange', () => {
  const modeChanged = updateWorkspaceNav();
  if (location.hash === '#follow-up') {
    $('follow-up')?.scrollIntoView?.({ block: 'start' });
  } else {
    globalThis.scrollTo?.(0, 0);
  }
  if (portfolioActive) $('portfolio')?.focus?.({ preventScroll: true });
  if (modeChanged) void refresh();
});
let resizeTimer = null;
globalThis.addEventListener?.('resize', () => {
  if (!last || scale !== 'fit' || planGesture) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (last && scale === 'fit' && !planGesture) renderGantt(last.data, last.m); }, 120);
});
updateWorkspaceNav();
$('todayActionOwner')?.addEventListener('change', () => {
  todayActionOwner = $('todayActionOwner').value;
  if (last) renderTodayActions(last.data, last.m);
});
$('closeHandoff')?.addEventListener('click', () => $('handoffDialog')?.close?.());
$('copyHandoffBtn')?.addEventListener('click', async () => {
  const text = $('handoffText')?.value || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if ($('handoffCopyStatus')) $('handoffCopyStatus').textContent = '已复制开工说明到剪贴板，任务状态未改动。';
  } catch {
    $('handoffText')?.focus?.();
    $('handoffText')?.select?.();
    if ($('handoffCopyStatus')) $('handoffCopyStatus').textContent = '无法自动访问剪贴板，已选中文本，请按 Ctrl+C 复制。';
  }
});
for (const [id, label] of Object.entries({
  projectSelect: '工作区项目', simTask: '模拟任务', burndownScope: '燃尽图里程碑', snapshots: '历史快照',
  planTaskMilestone: '所属里程碑', integrationTasks: 'Issue 同步任务范围', filterOwner: '负责人', filterMilestone: '里程碑', todayActionOwner: '今日行动负责人',
})) enhanceSearchPicker($(id), label);
setPlanAvailable(false);
refresh();
refreshProjects();
bindEventsStream();
// 监听不可用时仍可恢复更新。
setInterval(refresh, 5000);
