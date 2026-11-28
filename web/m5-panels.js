import { renderCapacityHoursSvg } from './charts.js';

const capacityFields = ['storyPoints', 'estimateHours', 'actualHours'];
const providerBase = { github: 'https://api.github.com', gitlab: 'https://gitlab.com/api/v4' };
export function installM5Panels({ getLive, apiUrl, refresh, downloadFile, rerenderDetail, esc }) {
  const $ = (id) => document.getElementById(id);
  const bind = (id, type, listener) => $(id)?.addEventListener(type, listener);
  const show = (id) => { if (!$(id).open) $(id).showModal(); };
  const close = (id) => { if ($(id)?.open) $(id).close(); };
  const keyFor = (base) => base ? base.epoch + ':' + base.projectId : '';
  let view = null, exportEdit = null, capacityEdit = null, issueEdit = null;
  const active = (state) => state && state === view && state.key === keyFor(getLive());
  const num = (n) => typeof n === 'number' ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
  const pct = (n) => n == null ? '—' : num(n) + '%';
  const message = (id, value) => { if ($(id)) $(id).textContent = value; };
  const optionsFor = (data, choose) => data.tasks.map(({ id, title }) =>
    `<option value="${esc(id)}"${id === choose ? ' selected' : ''}>${esc(id)} · ${esc(title)}</option>`).join('');
  const body = (input) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  async function call(path, state, input) {
    const response = await fetch(apiUrl(path, state.projectId), input === undefined ? undefined : body(input));
    let data;
    try { data = await response.json(); } catch { /* 旧服务可能返回纯文本 404 */ }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const message = response.status === 404
        ? (path === '/api/export/html' ? '当前运行的服务不支持离线导出。请在项目目录重启 npm start，再刷新页面重试。'
          : '当前运行的服务缺少此接口。请在项目目录重启 npm start，再刷新页面重试。')
        : '服务返回了无法识别的结果，请刷新页面后重试。';
      throw Object.assign(new Error(message), { status: response.status });
    }
    if (response.ok === false) throw Object.assign(new Error(data.message || '请求未成功'), { status: response.status, code: data.code });
    return data;
  }

  function renderCapacity(state) {
    if (!active(state) || !state.capacity?.metrics) return;
    const m = state.capacity.metrics;
    $('capacityMetrics').innerHTML = `<div class="m5-metrics">
      <div>故事点 <b>${num(m.completedStoryPoints)} / ${num(m.totalStoryPoints)}</b></div>
      <div>总预估 <b>${num(m.totalEstimateHours)} 小时</b></div>
      <div>实际填报 <b>${num(m.reportedActualHours)} 小时</b></div>
      <div>实际推算 <b>${num(m.inferredActualHours)} 小时</b></div>
      <div>实测准确率 <b>${pct(m.overallAccuracyPct)}</b></div>
      <div>实测膨胀系数 <b>${m.overallInflationRatio == null ? '—' : num(m.overallInflationRatio) + '×'}</b></div>
      </div><p class="empty">${m.sampledDoneCount ? '基于 ' + num(m.sampledDoneCount) + ' 项实测样本' : '暂无可计算的实测样本'}</p>
      ${renderCapacityHoursSvg(m.byOwner, esc)}
      ${(m.byOwner || []).map((owner) => `<div class="m5-owner">
        <div><b>${esc(owner.owner)}</b> · ${pct(owner.accuracyPct)} · ${num(owner.sampledDoneCount)} 项样本</div>
        ${owner.accuracyPct == null ? '' : `<progress max="100" value="${Number(owner.accuracyPct)}" aria-label="预估准确率"></progress>`}
        <span class="empty">预估 ${num(owner.estimateHours)}h · 填报 ${num(owner.reportedActualHours)}h · 推算 ${num(owner.inferredActualHours)}h</span></div>`).join('')}
      ${m.calendarWarnings?.length ? `<ul class="m5-results">${m.calendarWarnings.map(({ id, message: warning }) =>
        `<li><button type="button" class="btn-sm" data-id="${esc(id)}">${esc(id)}</button> ${esc(warning)}</li>`).join('')}</ul>` : ''}`;
  }

  function renderIssueState(state) {
    if (!active(state) || !state.integration) return;
    const config = state.integration;
    message('issueStatus', config.enabled ? (config.provider === 'gitlab' ? 'GitLab' : 'GitHub') + ' · ' + config.repo
      + ' · 已绑定 ' + Object.keys(config.issueMap || {}).length + ' 项' : '当前项目尚未启用平台集成');
  }

  function setAvailable(base) {
    const key = keyFor(base);
    for (const id of ['exportHtmlBtn', 'configCapacityBtn', 'configIntegrationBtn', 'issueSyncBtn']) if ($(id)) $(id).disabled = !key;
    if (view?.key === key || (!view && !key)) return;
    exportEdit = capacityEdit = issueEdit = null;
    for (const id of ['exportHtmlDialog', 'capacityDialog', 'integrationDialog']) close(id);
    if ($('integrationToken')) $('integrationToken').value = '';
    view = key ? { key, projectId: base.projectId, revision: base.revision } : null;
    message('capacityMetrics', key ? '正在读取工时…' : '当前视图不显示实时工时');
    message('issueStatus', key ? '正在读取平台配置…' : '');
    if (view) load(view);
  }

  function loadCapacity(state) {
    const sequence = state.capacitySequence = (state.capacitySequence || 0) + 1;
    return call('/api/capacity', state).then((data) => {
      if (!active(state) || sequence !== state.capacitySequence || !data.metrics) return;
      state.capacity = data;
      renderCapacity(state);
    }).catch(() => { if (active(state) && sequence === state.capacitySequence) message('capacityMetrics', '暂时无法读取工时配置'); });
  }

  function load(state) {
    void loadCapacity(state);
    void call('/api/integrations', state).then((data) => {
      if (!active(state) || state.integration || !data.provider) return;
      state.integration = data;
      renderIssueState(state);
      rerenderDetail();
    }).catch(() => { if (active(state) && !state.integration) message('issueStatus', '暂时无法读取平台配置'); });
  }

  function syncLive(base) {
    setAvailable(base);
    if (view && base && view.revision !== base.revision) {
      view.revision = base.revision;
      if (issueEdit?.preview) resetPreview('计划已变化，请重新预览');
      void loadCapacity(view);
    }
  }

  bind('exportHtmlBtn', 'click', () => {
    const base = getLive();
    if (!base || !active(view)) return;
    exportEdit = { state: view, today: base.m.today };
    $('exportCustomTitle').value = base.data.project;
    $('exportMaskOwners').checked = $('exportStripNotes').checked = true;
    $('exportHtmlSubmit').disabled = false;
    message('exportHtmlSummary', base.data.milestones.length + ' 个里程碑 · ' + base.data.tasks.length + ' 项任务 · 统计日 ' + base.m.today);
    message('exportHtmlStatus', '');
    show('exportHtmlDialog');
  });
  bind('exportHtmlForm', 'submit', async (event) => {
    event.preventDefault();
    const edit = exportEdit;
    if (!edit || !active(edit.state) || edit.busy) return;
    edit.busy = true;
    $('exportHtmlSubmit').disabled = true;
    message('exportHtmlStatus', '正在生成离线文件…');
    try {
      const data = await call('/api/export/html', edit.state, {
        today: edit.today, customTitle: $('exportCustomTitle').value.trim(),
        maskOwners: $('exportMaskOwners').checked, stripInternalNotes: $('exportStripNotes').checked,
      });
      if (exportEdit !== edit || !active(edit.state) || !$('exportHtmlDialog').open) return;
      if (typeof data.html !== 'string' || !data.html.startsWith('<!doctype html>')) throw new Error('服务未返回离线网页');
      const filename = typeof data.filename === 'string' && /^[\w.-]+\.html$/.test(data.filename) ? data.filename : 'dashboard.html';
      downloadFile(data.html, 'text/html;charset=utf-8', filename);
      message('reportMessage', '已下载 ' + filename);
      close('exportHtmlDialog');
    } catch (err) { if (exportEdit === edit && active(edit.state)) message('exportHtmlStatus', err.message); }
    finally { if (exportEdit === edit) { edit.busy = false; $('exportHtmlSubmit').disabled = false; } }
  });

  const capacityLabels = { storyPoints: '故事点', estimateHours: '预估工时', actualHours: '实际工时' };
  bind('configCapacityBtn', 'click', async () => {
    const base = getLive(), state = view;
    if (!base || !active(state)) return;
    const edit = capacityEdit = { state };
    $('capacitySave').disabled = true;
    $('capacityTaskRows').innerHTML = '';
    message('capacityDialogStatus', '正在读取配置…');
    show('capacityDialog');
    try {
      const { config } = await call('/api/capacity', state);
      if (capacityEdit !== edit || !active(state) || !$('capacityDialog').open) return;
      if (!config) throw new Error('服务未返回配置');
      edit.config = config;
      $('capacityHours').value = config.hoursPerDay;
      $('capacityWeekends').checked = config.excludeWeekends;
      $('capacityHolidays').value = config.holidays.join('\n');
      $('capacityWorkdays').value = config.workdays.join('\n');
      $('capacityTaskRows').innerHTML = base.data.tasks.map(({ id, title }) =>
        `<tr data-capacity-id="${esc(id)}"><th scope="row">${esc(id)} · ${esc(title)}</th>${capacityFields.map((field) =>
          `<td><input type="number" min="0" step="any" data-capacity-field="${field}" aria-label="${esc(id)} ${capacityLabels[field]}"
            value="${esc(config.tasks[id]?.[field] ?? '')}"></td>`).join('')}</tr>`).join('');
      $('capacitySave').disabled = false;
      message('capacityDialogStatus', '');
    } catch (err) { if (capacityEdit === edit && active(state)) message('capacityDialogStatus', err.message); }
  });
  bind('capacityForm', 'submit', async (event) => {
    event.preventDefault();
    const edit = capacityEdit;
    if (!edit?.config || !active(edit.state) || edit.busy) return;
    const tasks = { ...edit.config.tasks };
    for (const row of $('capacityTaskRows').querySelectorAll('[data-capacity-id]')) {
      const id = row.dataset.capacityId;
      const values = Object.fromEntries([...row.querySelectorAll('[data-capacity-field]')]
        .filter(({ value }) => value.trim() !== '').map((input) => [input.dataset.capacityField, Number(input.value)]));
      if (Object.keys(values).length) tasks[id] = values; else delete tasks[id];
    }
    const dates = (id) => $(id).value.trim().split(/[\s,，、]+/).filter(Boolean);
    edit.busy = true;
    $('capacitySave').disabled = true;
    message('capacityDialogStatus', '正在保存…');
    try {
      const response = await call('/api/capacity', edit.state, {
        hoursPerDay: Number($('capacityHours').value), excludeWeekends: $('capacityWeekends').checked,
        holidays: dates('capacityHolidays'), workdays: dates('capacityWorkdays'), tasks,
      });
      if (capacityEdit !== edit || !active(edit.state)) return;
      edit.state.capacitySequence++;
      edit.state.capacity = response;
      renderCapacity(edit.state);
      close('capacityDialog');
    } catch (err) { if (capacityEdit === edit && active(edit.state)) message('capacityDialogStatus', err.message); }
    finally { if (capacityEdit === edit) { edit.busy = false; $('capacitySave').disabled = false; } }
  });

  function buttons() {
    const config = issueEdit?.state.integration;
    const busy = issueEdit?.busy;
    $('integrationConfigSave').disabled = !issueEdit?.ready || Boolean(busy);
    $('integrationPreview').disabled = $('integrationPush').disabled = !config?.enabled || Boolean(busy || issueEdit?.dirty);
    $('integrationConfirm').disabled = !config?.enabled || !issueEdit?.preview || Boolean(busy || issueEdit?.dirty);
    $('integrationTasks').disabled = $('integrationAllowAll').disabled = Boolean(busy);
  }
  function resetPreview(text = '') {
    if (issueEdit) issueEdit.preview = null;
    if ($('integrationResults')) $('integrationResults').innerHTML = '';
    message('integrationDialogStatus', text);
    if (issueEdit) buttons();
  }
  function fillIntegration(config) {
    $('integrationProvider').value = config.provider;
    $('integrationRepo').value = config.repo || '';
    $('integrationBase').value = config.apiBase || providerBase[config.provider];
    $('integrationEnabled').checked = Boolean(config.enabled);
    $('integrationToken').value = '';
    $('integrationToken').placeholder = config.tokenConfigured ? '已配置，留空保留当前 Token' : '';
  }
  async function openIssue({ task, settings = false } = {}) {
    const base = getLive(), state = view;
    if (!base || !active(state)) return;
    const edit = issueEdit = { state };
    $('integrationTasks').innerHTML = optionsFor(base.data, task);
    $('integrationAllowAll').checked = false;
    $('integrationSettings').open = settings || !state.integration?.enabled;
    resetPreview('正在读取平台配置…');
    show('integrationDialog');
    try {
      const config = await call('/api/integrations', state);
      if (issueEdit !== edit || !active(state) || !$('integrationDialog').open) return;
      if (!config.provider) throw new Error('服务未返回平台配置');
      state.integration = config;
      fillIntegration(config);
      renderIssueState(state);
      rerenderDetail();
      edit.ready = true;
      resetPreview();
    } catch (err) { if (issueEdit === edit && active(state)) message('integrationDialogStatus', err.message); }
  }
  bind('configIntegrationBtn', 'click', () => openIssue({ settings: true }));
  bind('issueSyncBtn', 'click', () => openIssue());
  bind('integrationProvider', 'change', () => {
    $('integrationBase').value = providerBase[$('integrationProvider').value];
    $('integrationToken').value = '';
    resetPreview('切换平台后请保存配置');
  });
  bind('integrationForm', 'input', () => {
    if (issueEdit) { issueEdit.dirty = true; resetPreview('请先保存新的平台配置'); }
  });
  bind('integrationTasks', 'change', () => resetPreview('同步范围已变化'));
  bind('integrationForm', 'submit', async (event) => {
    event.preventDefault();
    const edit = issueEdit;
    if (!edit?.ready || !active(edit.state) || edit.busy) return;
    edit.busy = true;
    resetPreview('正在保存平台配置…');
    try {
      const result = await call('/api/integrations', edit.state, {
        provider: $('integrationProvider').value, repo: $('integrationRepo').value.trim(),
        apiBase: $('integrationBase').value.trim(), token: $('integrationToken').value.trim(),
        enabled: $('integrationEnabled').checked,
      });
      if (issueEdit !== edit || !active(edit.state)) return;
      edit.state.integration = result;
      edit.dirty = false;
      fillIntegration(result);
      renderIssueState(edit.state);
      rerenderDetail();
      message('integrationDialogStatus', '平台配置已保存');
    } catch (err) { if (issueEdit === edit && active(edit.state)) message('integrationDialogStatus', err.message); }
    finally { if (issueEdit === edit) { edit.busy = false; buttons(); } }
  });
  async function syncIssues(action) {
    const edit = issueEdit;
    if (!edit || !active(edit.state) || !edit.state.integration?.enabled || edit.busy || edit.dirty) return;
    const taskIds = [...$('integrationTasks').selectedOptions].map(({ value }) => value);
    const preview = edit.preview;
    const { provider, apiBase, repo } = edit.state.integration;
    const input = action === 'preview' ? { direction: 'pull', dryRun: true, taskIds }
      : action === 'confirm' && preview ? { direction: 'pull', dryRun: false, taskIds: preview.taskIds, previewId: preview.previewId, expectedRevision: preview.expectedRevision }
        : action === 'push' ? { direction: 'push', taskIds, expectedTarget: { provider, apiBase, repo }, allowAll: !taskIds.length && $('integrationAllowAll').checked } : null;
    if (!input) return;
    if (action === 'push' && !taskIds.length) {
      if (!input.allowAll) return message('integrationDialogStatus', '请先选择推送任务，或勾选允许全量推送');
      if (!window.confirm('确认把当前项目的全部任务推送到 ' + edit.state.integration.repo + '？')) return;
    }
    if (action !== 'confirm') resetPreview();
    edit.busy = true; buttons();
    message('integrationDialogStatus', '正在与平台同步…');
    try {
      const result = await call('/api/integrations/sync', edit.state, input);
      if (issueEdit !== edit || !active(edit.state)) return;
      if (action === 'preview') {
        if (!result.previewId) throw new Error('服务未返回有效预览');
        edit.preview = { previewId: result.previewId, expectedRevision: result.expectedRevision, taskIds };
        const changes = (result.proposedUpdates || []).map(({ id, before, after }) =>
          `${id}：${before.status} → ${after.status}，进度 ${before.progress}% → ${after.progress}%，开始 ${after.actualStart || '—'}，结束 ${after.actualEnd || '—'}`);
        const skipped = (result.skippedConflicts || []).map(({ id, reason }) => id + '：' + reason);
        $('integrationResults').innerHTML = [...changes, ...skipped].map((line) => '<div>' + esc(line) + '</div>').join('');
        message('integrationDialogStatus', changes.length + ' 项进度变更，' + skipped.length + ' 项跳过。请核对后确认。');
      } else {
        resetPreview();
        edit.state.integration = { ...edit.state.integration, issueMap: result.issueMap || {} };
        renderIssueState(edit.state); rerenderDetail();
        const failed = (result.failed || []).map(({ id, message: detail }) => id + '：' + detail);
        $('integrationResults').innerHTML = failed.map((line) => '<div>' + esc(line) + '</div>').join('');
        message('integrationDialogStatus', action === 'push' ? '新建 ' + (result.created?.length || 0) + ' 项，更新 ' + (result.updated?.length || 0) + ' 项，失败 ' + failed.length + ' 项'
          : '已写入 ' + (result.touchedTasks?.length || 0) + ' 项任务');
        if (action === 'confirm') await refresh();
      }
    } catch (err) {
      if (issueEdit === edit && active(edit.state)) {
        if (err.code === 'SYNC_PREVIEW_STALE') resetPreview('预览已失效，请重新预览');
        else if (err.code === 'SYNC_TARGET_CHANGED') { edit.dirty = true; resetPreview(err.message); }
        else message('integrationDialogStatus', err.message);
      }
    } finally { if (issueEdit === edit) { edit.busy = false; buttons(); } }
  }
  bind('integrationPreview', 'click', () => syncIssues('preview'));
  bind('integrationConfirm', 'click', () => syncIssues('confirm'));
  bind('integrationPush', 'click', () => syncIssues('push'));

  document.addEventListener('click', (event) => {
    const target = event.target;
    const closeDialog = target.closest?.('[data-close-m5]')?.dataset.closeM5;
    if (closeDialog) close(closeDialog);
    const issueTask = target.closest?.('[data-issue-task]')?.dataset.issueTask;
    if (issueTask) void openIssue({ task: issueTask });
  });
  bind('exportHtmlDialog', 'close', () => { if (!$('exportHtmlDialog').open) exportEdit = null; });
  bind('capacityDialog', 'close', () => { if (!$('capacityDialog').open) capacityEdit = null; });
  bind('integrationDialog', 'close', () => {
    if (!$('integrationDialog').open) { issueEdit = null; $('integrationToken').value = ''; }
  });

  function issueMarkup(id) {
    if (!active(view) || !view.integration?.enabled) return '';
    const issue = view.integration.issueMap?.[id];
    let badge = '';
    if (issue) {
      try {
        const url = new URL(issue.url);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          badge = `<a class="issue-badge" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">#${esc(issue.number)} (${esc(issue.state)})</a>`;
        }
      } catch { /* no link for an invalid URL */ }
    }
    return `<span class="m5-task-issue">${badge}<button type="button" class="btn-sm" data-issue-task="${esc(id)}">同步此任务 Issue</button></span>`;
  }

  return { syncLive, setAvailable, issueMarkup };
}
