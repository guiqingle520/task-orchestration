export function installTimelineView({ document: doc = document, beforeOpen = () => {} } = {}) {
  const $ = id => doc.getElementById(id);
  const win = doc.defaultView;
  const root = doc.documentElement;
  const toggle = $('timelineFocusToggle');
  const menu = $('timelineViewMenu');
  const tools = $('timelineTools');
  const toolsToggle = $('timelineToolsToggle');
  let original = null, native = '', ticket = 0, restoreOnExit = true;

  function setStatus(message = '') {
    $('timelineViewStatus').textContent = message;
  }

  function sync() {
    toggle.textContent = native === 'active' ? '退出全屏' : original ? '退出专注' : '展开时间线';
    toggle.setAttribute('aria-expanded', String(Boolean(original)));
    $('timelineFullscreen').textContent = native === 'active' ? '退出浏览器全屏' : '浏览器全屏';
  }

  function restoreChart(position) {
    const chart = $('gantt');
    chart.scrollTop = position.chartTop;
    chart.scrollLeft = position.chartLeft;
    const track = $('tscroll');
    if (track) track.scrollLeft = position.trackLeft;
  }

  function setToolsOpen(open) {
    toolsToggle.setAttribute('aria-expanded', String(open));
    tools.classList.toggle('is-open', open);
  }

  function open() {
    if (original) return;
    beforeOpen();
    const chart = $('gantt');
    original = {
      x: win.scrollX, y: win.scrollY,
      chartTop: chart.scrollTop, chartLeft: chart.scrollLeft, trackLeft: $('tscroll')?.scrollLeft ?? 0,
    };
    restoreOnExit = true;
    menu.open = false;
    setToolsOpen(false);
    doc.body.classList.add('timeline-focused');
    $('timelineFocusScroll').scrollTop = 0;
    restoreChart(original);
    setStatus();
    sync();
    toggle.focus({ preventScroll: true });
  }

  function finish() {
    if (!original) return;
    const position = original;
    original = null;
    native = '';
    const closed = ++ticket;
    menu.open = false;
    doc.body.classList.remove('timeline-focused');
    setStatus();
    sync();
    if (!restoreOnExit) return;
    toggle.focus({ preventScroll: true });
    const restore = () => {
      if (ticket !== closed || original) return;
      win.scrollTo(position.x, position.y);
      restoreChart(position);
    };
    restore();
    // 浏览器退出原生全屏时，窗口尺寸也可能在下一帧才稳定。
    win.requestAnimationFrame(restore);
  }

  async function close({ restore = true } = {}) {
    if (!original) return;
    restoreOnExit &&= restore;
    if (native === 'leaving') return;
    if (native && doc.fullscreenElement === root) {
      native = 'leaving';
      try {
        await doc.exitFullscreen();
      } catch {
        if (doc.fullscreenElement === root) {
          native = 'active';
          sync();
          setStatus('无法自动退出浏览器全屏，请按 Esc 退出。');
          return;
        }
      }
    }
    finish();
  }

  async function fullscreen() {
    menu.open = false;
    if (native === 'active') { await close(); return; }
    if (native) return;
    open();
    toggle.focus({ preventScroll: true });
    if (!root.requestFullscreen || doc.fullscreenEnabled === false) {
      setStatus('当前环境不支持浏览器全屏，已保留展开视图。');
      return;
    }
    const requested = ++ticket;
    native = 'pending';
    try {
      await root.requestFullscreen();
      if (requested !== ticket) {
        if (!native && doc.fullscreenElement === root) await doc.exitFullscreen();
        return;
      }
      native = 'active';
      sync();
    } catch {
      if (requested !== ticket) return;
      native = '';
      sync();
      setStatus('浏览器未进入全屏，已保留展开视图。');
    }
  }

  toggle.addEventListener('click', () => original ? void close() : open());
  $('timelineFullscreen').addEventListener('click', fullscreen);
  toolsToggle.addEventListener('click', () => setToolsOpen(!tools.classList.contains('is-open')));
  $('timelineDetailJump').addEventListener('click', () => {
    const detail = $('detail');
    detail.focus({ preventScroll: true });
    detail.scrollIntoView({ block: 'start' });
  });
  doc.addEventListener('fullscreenchange', () => {
    if (doc.fullscreenElement === root) {
      if (original && native === 'pending') { native = 'active'; sync(); }
    } else if (native === 'active' || native === 'leaving') finish();
  });
  doc.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  doc.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || doc.querySelector('dialog[open]')) return;
    if (menu.open) {
      event.preventDefault();
      menu.open = false;
      $('timelineViewMenuButton').focus();
    } else if (original) {
      event.preventDefault();
      void close();
    }
  });
  return { close };
}
