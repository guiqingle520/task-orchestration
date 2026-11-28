export function diffExternalTaskUpdates(prevTasks, nextTasks) {
  if (!prevTasks || !nextTasks) return [];
  const prevById = prevTasks instanceof Map
    ? prevTasks
    : new Map(prevTasks.map((task) => [task.id, task]));
  const items = [];
  for (const task of nextTasks) {
    const prev = prevById.get(task.id);
    if (prev?.status === task.status) continue;
    if (task.status === 'done') {
      items.push({
        kind: 'task',
        taskId: task.id,
        status: 'done',
        tone: 'done',
        title: `${task.id} 已完成`,
        detail: `${task.title}${task.owner ? `（${task.owner}）` : ''}`,
      });
    } else if (task.status === 'blocked') {
      items.push({
        kind: 'task',
        taskId: task.id,
        status: 'blocked',
        tone: 'blocked',
        title: `${task.id} 进入阻塞`,
        detail: `${task.title}${task.owner ? `（${task.owner}）` : ''}`,
      });
    }
  }
  return items;
}

export function diffExternalClaimUpdates(prevClaims, nextClaims, taskTitleById = {}) {
  if (!prevClaims || !nextClaims) return [];
  const items = [];
  const ids = new Set([...Object.keys(prevClaims), ...Object.keys(nextClaims)]);
  for (const taskId of ids) {
    const prev = prevClaims[taskId] || null;
    const next = nextClaims[taskId] || null;
    const detail = taskTitleById[taskId] || '';
    if (next?.state === 'active' && (
      !prev || prev.state !== 'active' || prev.leaseId !== next.leaseId || prev.actor !== next.actor
    )) {
      items.push({
        kind: 'claim',
        taskId,
        tone: 'claim',
        title: `${next.actor} 认领了 ${taskId}`,
        detail,
      });
    } else if (prev && (prev.state === 'active' || prev.state === 'stale') && !next) {
      items.push({
        kind: 'claim',
        taskId,
        tone: 'claim',
        title: `${prev.actor} 释放了 ${taskId} 认领`,
        detail,
      });
    }
  }
  return items;
}

export function installToastHost(container, { onLocate, esc = (s) => String(s), autoHideMs = 7000, maxVisible = 4 } = {}) {
  let seq = 0;
  const entries = [];

  function render() {
    if (!container) return;
    container.innerHTML = entries.map((item) => `
      <div class="toast-card tone-${esc(item.tone || 'claim')}" data-toast-id="${esc(item.uid)}" role="status">
        <div class="toast-main">
          <strong>${esc(item.title)}</strong>
          ${item.detail ? `<span class="toast-detail">${esc(item.detail)}</span>` : ''}
        </div>
        <div class="toast-actions">
          ${item.taskId ? `<button type="button" class="toast-locate" data-toast-locate="${esc(item.taskId)}" data-toast-dismiss="${esc(item.uid)}">查看</button>` : ''}
          <button type="button" class="toast-close" data-toast-close="${esc(item.uid)}" aria-label="关闭通知">×</button>
        </div>
      </div>
    `).join('');
  }

  function dismiss(uid) {
    const idx = entries.findIndex((item) => item.uid === uid);
    if (idx < 0) return;
    const [removed] = entries.splice(idx, 1);
    if (removed.timer) clearTimeout(removed.timer);
    render();
  }

  container?.addEventListener('click', (event) => {
    const locate = event.target?.closest?.('[data-toast-locate]');
    if (locate) {
      const taskId = locate.dataset?.toastLocate;
      const uid = locate.dataset?.toastDismiss;
      if (uid) dismiss(uid);
      if (taskId) onLocate?.(taskId);
      return;
    }
    const closeBtn = event.target?.closest?.('[data-toast-close]');
    if (closeBtn) dismiss(closeBtn.dataset?.toastClose);
  });

  return {
    push(toast) {
      if (!toast?.title) return null;
      const uid = `toast-${++seq}`;
      const timer = autoHideMs > 0 ? setTimeout(() => dismiss(uid), autoHideMs) : null;
      if (timer?.unref) timer.unref();
      entries.push({ ...toast, uid, timer });
      while (entries.length > maxVisible) {
        const oldest = entries.shift();
        if (oldest?.timer) clearTimeout(oldest.timer);
      }
      render();
      return uid;
    },
    clear() {
      while (entries.length) {
        const entry = entries.pop();
        if (entry?.timer) clearTimeout(entry.timer);
      }
      render();
    },
    list() {
      return entries.map(({ uid, kind, taskId, tone, title, detail }) => ({ uid, kind, taskId, tone, title, detail }));
    },
  };
}
