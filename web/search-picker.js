import { matchOptions } from './m6.js';

const controllers = new WeakMap();
const healthLabels = { green: '正常', yellow: '有风险', red: '告急', unavailable: '不可用' };
let openPicker = null;

export function syncSearchPicker(select) {
  controllers.get(select)?.sync();
}

export function closeSearchPicker() {
  openPicker?.close();
}

export function enhanceSearchPicker(select, name) {
  if (!select || typeof select.after !== 'function' || controllers.has(select)) return;
  const dom = select.ownerDocument;
  const create = (tag, cls) => {
    const el = dom.createElement(tag);
    el.className = cls;
    return el;
  };
  const root = create('span', 'search-picker');
  const trigger = create('button', 'picker-trigger');
  trigger.id = select.id + '-picker-button';
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  const popup = create('span', 'picker-popup');
  popup.hidden = true;
  if (typeof popup.showPopover === 'function') popup.setAttribute('popover', 'manual');
  const input = create('input', 'picker-query');
  input.type = 'text';
  input.placeholder = '输入名称或编号';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `搜索${name}`);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  const list = create('span', 'picker-results');
  list.id = select.id + '-picker-results';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', name);
  if (select.multiple) list.setAttribute('aria-multiselectable', 'true');
  const empty = create('span', 'picker-empty');
  empty.setAttribute('role', 'status');
  empty.hidden = true;
  for (const el of [trigger, input]) el.setAttribute('aria-controls', list.id);
  popup.append(input, list, empty);
  root.append(trigger, popup);
  for (const label of select.labels || []) {
    if (label.htmlFor === select.id) label.htmlFor = trigger.id;
  }
  select.after(root);
  select.hidden = true;

  let open = false, composing = false, activeIndex = -1, matches = [], prior = '';
  const options = () => [...select.options].map(option => ({
    value: option.value, label: option.dataset.label ?? option.label,
    searchLabel: option.dataset.searchLabel, health: option.dataset.health,
    selected: option.selected, disabled: Boolean(option.disabled || option.parentElement?.disabled),
  }));
  function appendLabel(el, text, health) {
    if (Object.hasOwn(healthLabels, health)) {
      const dot = create('i', 'picker-health-dot ' + health);
      dot.setAttribute('aria-hidden', 'true');
      el.append(dot);
    }
    const title = create('span', 'picker-label');
    title.textContent = text;
    el.append(title);
    if (Object.hasOwn(healthLabels, health)) {
      const status = create('span', 'picker-health-label');
      status.textContent = healthLabels[health];
      el.append(status);
    }
  }
  function expanded(value) {
    for (const el of [trigger, input]) el.setAttribute('aria-expanded', String(value));
  }
  function markActive(scroll) {
    [...list.children].forEach((row, i) => row.classList.toggle('active', i === activeIndex));
    const row = list.children[activeIndex];
    if (row) {
      input.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function renderResults(entries, reset = false) {
    const priorValue = reset ? null : matches[activeIndex]?.value;
    matches = matchOptions(entries, input.value);
    activeIndex = matches.findIndex(entry => entry.value === priorValue && !entry.disabled);
    const rows = matches.map((entry, i) => {
      const row = create('span', 'picker-option');
      row.id = list.id + '-' + i;
      row.dataset.index = i;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(entry.selected));
      if (entry.disabled) row.setAttribute('aria-disabled', 'true');
      appendLabel(row, entry.label, entry.health);
      if (entry.selected) {
        const mark = create('span', 'picker-check');
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = '✓';
        row.append(mark);
      }
      return row;
    });
    list.replaceChildren(...rows);
    empty.hidden = matches.length > 0;
    empty.textContent = matches.length ? '' : '没有匹配的选项';
    markActive(false);
  }
  function position() {
    if (!open || !popup.hasAttribute('popover')) return;
    const view = dom.defaultView;
    const rect = trigger.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > view.innerHeight) { close(); return; }
    const width = Math.min(Math.max(rect.width, 245), view.innerWidth - 16);
    const below = view.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const up = below < 185 && above > below;
    popup.style.width = width + 'px';
    popup.style.left = Math.max(8, Math.min(rect.left, view.innerWidth - width - 8)) + 'px';
    popup.style.maxHeight = Math.max(60, Math.min(340, up ? above : below)) + 'px';
    popup.style.top = up ? 'auto' : rect.bottom + 4 + 'px';
    popup.style.bottom = up ? view.innerHeight - rect.top + 4 + 'px' : 'auto';
  }
  function sync() {
    const entries = options();
    const next = JSON.stringify([select.disabled, entries]);
    if (next === prior) return;
    prior = next;
    const chosen = entries.filter(entry => entry.selected);
    const single = select.multiple ? null : chosen[0];
    const text = select.multiple ? (chosen.length ? `已选择 ${chosen.length} 项` : '选择任务')
      : single?.label ?? (entries.length ? `选择${name}` : '无可选项');
    trigger.replaceChildren();
    appendLabel(trigger, text, single?.health);
    trigger.setAttribute('aria-label', `${name}：${text}${healthLabels[single?.health] ? '，' + healthLabels[single.health] : ''}`);
    trigger.disabled = select.disabled || entries.length === 0;
    if (trigger.disabled) close();
    else if (open) renderResults(entries);
  }
  function show() {
    sync();
    if (trigger.disabled || open) return;
    openPicker?.close();
    openPicker = api;
    open = true;
    composing = false;
    input.value = '';
    expanded(true);
    popup.hidden = false;
    if (popup.hasAttribute('popover')) popup.showPopover();
    position();
    if (!open) return;
    renderResults(options(), true);
    dom.defaultView.addEventListener('resize', position);
    dom.addEventListener('scroll', position, true);
    input.focus({ preventScroll: true });
  }
  function close(restoreFocus = false) {
    if (!open) return;
    open = false;
    if (openPicker === api) openPicker = null;
    expanded(false);
    if (popup.hasAttribute('popover')) popup.hidePopover();
    popup.hidden = true;
    dom.defaultView.removeEventListener('resize', position);
    dom.removeEventListener('scroll', position, true);
    if (restoreFocus && !trigger.disabled) trigger.focus({ preventScroll: true });
  }
  function choose(index) {
    const match = matches[index];
    if (!match || match.disabled) return;
    const selectedOption = [...select.options].find(option => option.value === match.value);
    if (!selectedOption) return;
    const changed = select.multiple || select.value !== match.value;
    if (select.multiple) selectedOption.selected = !selectedOption.selected;
    else {
      select.value = match.value;
      close(true);
    }
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  }
  function move(direction) {
    for (let next = activeIndex < 0 ? (direction > 0 ? 0 : matches.length - 1) : activeIndex + direction;
      next >= 0 && next < matches.length; next += direction) {
      if (matches[next].disabled) continue;
      activeIndex = next;
      markActive(true);
      break;
    }
  }

  const api = { sync, close };
  controllers.set(select, api);
  expanded(false);
  const view = dom.defaultView;
  const observer = new view.MutationObserver(sync);
  observer.observe(select, { subtree: true, childList: true, characterData: true, attributes: true });
  select.addEventListener('change', sync);
  trigger.addEventListener('click', () => open ? close(true) : show());
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    show();
    move(event.key === 'ArrowDown' ? 1 : -1);
  });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; renderResults(options(), true); });
  input.addEventListener('input', event => { if (!event.isComposing && !composing) renderResults(options(), true); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || composing || event.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeIndex < 0 ? matches.findIndex(entry => !entry.disabled) : activeIndex);
    }
  });
  list.addEventListener('mousedown', event => event.preventDefault());
  list.addEventListener('click', event => {
    const row = event.target.closest('[data-index]');
    if (row) choose(Number(row.dataset.index));
  });
  dom.addEventListener('pointerdown', event => { if (open && !root.contains(event.target)) close(); }, true);
  root.addEventListener('focusout', event => { if (open && !root.contains(event.relatedTarget)) close(); });
  select.closest('dialog')?.addEventListener('close', () => close());
  sync();
}
