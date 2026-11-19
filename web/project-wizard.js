export function bindProjectWizard($, onRegistered) {
  const dialog = $('projectDialog');
  const path = $('projRootInput');
  const submit = $('registerProject');
  const preview = $('projectPreview');
  const message = $('projectMessage');
  const pick = $('pickProjectDirBtn');
  const id = $('projIdInput');
  const name = $('projNameInput');
  let request = 0, pendingPreview = null, saving = false;
  let suggestedId = '', suggestedName = '';

  function clearPreview() {
    pendingPreview = null;
    preview.hidden = true;
    $('projectTemplate').value = '';
    submit.textContent = '检查并注册';
    message.textContent = '';
  }
  function lock(busy) {
    for (const field of [path, id, name, submit, pick]) field.disabled = busy;
  }
  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (response.status === 404) throw new Error('当前服务不支持此操作，请重启驾驶舱服务');
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '请求失败，请重试');
    return result;
  }
  async function checkAndRegister(usePicker) {
    const current = ++request;
    lock(true);
    message.textContent = '';
    try {
      if (usePicker) {
        const choice = await post('/api/projects/pick-directory', { initialPath: path.value.trim() });
        if (request !== current || !dialog.open || choice.cancelled || !choice.path) return;
        path.value = choice.path;
        clearPreview();
      }
      const repoRoot = path.value.trim();
      if (!pendingPreview) {
        message.textContent = '正在检查 plan/plan.md…';
        const info = await post('/api/projects/preflight', { repoRoot });
        if (request !== current || !dialog.open) return;
        if (info.state === 'invalid') throw new Error(info.message);
        if (!id.value.trim() || id.value === suggestedId) id.value = info.id;
        if (!name.value.trim() || name.value === suggestedName) name.value = info.name;
        suggestedId = info.id;
        suggestedName = info.name;
        if (info.state === 'missing') {
          pendingPreview = info.previewId;
          $('projectTemplate').value = info.preview;
          preview.hidden = false;
          submit.textContent = '确认创建并注册';
          message.textContent = '未找到计划。确认后将把以下模板写入所选目录的 plan/plan.md。';
          return;
        }
        if (info.state !== 'valid') throw new Error('未能确认计划状态，请重新检查');
      }
      saving = true;
      $('closeProject').disabled = true;
      message.textContent = '正在注册项目…';
      const result = await post('/api/projects', {
        repoRoot, id: id.value.trim(), name: name.value.trim(), previewId: pendingPreview || undefined,
      });
      dialog.close();
      await onRegistered(result.project);
    } catch (err) {
      if (request === current) {
        clearPreview();
        message.textContent = err.message || '无法连接服务，请重试';
      }
    } finally {
      if (request === current) {
        saving = false;
        $('closeProject').disabled = false;
        lock(false);
      }
    }
  }
  $('addProjectBtn').addEventListener('click', () => {
    request++;
    saving = false;
    suggestedId = suggestedName = id.value = name.value = path.value = '';
    clearPreview();
    lock(false);
    $('closeProject').disabled = false;
    dialog.showModal();
    void post('/api/projects/pick-directory', { warmup: true }).catch(() => {});
  });
  path.addEventListener('input', clearPreview);
  pick.addEventListener('click', () => checkAndRegister(true));
  $('projectForm').addEventListener('submit', event => {
    event.preventDefault();
    if (!submit.disabled) return checkAndRegister(false);
  });
  $('closeProject').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
}
