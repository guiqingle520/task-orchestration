import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { installTimelineView } from '../web/timeline-view.js';

function setup() {
  const doc = new EventTarget();
  const elements = new Map();
  const classes = new Set();
  const toolClasses = new Set();
  doc.body = { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  doc.getElementById = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(new EventTarget(), {
      scrollTop: 0, scrollLeft: 0, setAttribute() {}, focus() { doc.activeElement = id; },
      classList: { toggle(value, open) { if (open) toolClasses.add(value); else toolClasses.delete(value); }, contains: value => toolClasses.has(value) },
    }));
    return elements.get(id);
  };
  doc.querySelector = () => null;
  doc.documentElement = {};
  doc.fullscreenEnabled = true;
  doc.fullscreenElement = null;
  doc.defaultView = {
    scrollX: 0, scrollY: 260,
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
    requestAnimationFrame(callback) { callback(); },
  };
  const chart = doc.getElementById('gantt');
  chart.scrollTop = 180;
  chart.scrollLeft = 420;
  const view = installTimelineView({ document: doc });
  return {
    doc, view, chart,
    click: id => doc.getElementById(id).dispatchEvent(new Event('click')),
    focused: () => classes.has('timeline-focused'),
    label: id => doc.getElementById(id).textContent,
  };
}

test('a denied fullscreen request leaves the expanded timeline open and Esc restores both scroll areas', async () => {
  const { doc, click, focused, label, chart } = setup();
  doc.documentElement.requestFullscreen = async () => { throw new Error('denied'); };
  click('timelineFullscreen');
  await flush();
  assert.equal(focused(), true);
  assert.match(label('timelineViewStatus'), /保留展开视图/);
  [doc.defaultView.scrollY, chart.scrollTop, chart.scrollLeft] = [0, 50, 0];
  const escape = new Event('keydown', { cancelable: true });
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  doc.dispatchEvent(escape);
  assert.equal(focused(), false);
  assert.deepEqual([doc.defaultView.scrollY, chart.scrollTop, chart.scrollLeft], [260, 180, 420]);
  assert.equal(doc.activeElement, 'timelineFocusToggle');
});

test('closing while browser permission is pending cannot reopen the expanded view when it arrives', async () => {
  const { doc, view, click, focused } = setup();
  let grant, exits = 0;
  doc.documentElement.requestFullscreen = () => new Promise(resolve => {
    grant = () => { doc.fullscreenElement = doc.documentElement; resolve(); };
  });
  doc.exitFullscreen = async () => { exits++; doc.fullscreenElement = null; };
  click('timelineFullscreen');
  assert.equal(focused(), true);
  await view.close();
  grant();
  await flush();
  assert.equal(focused(), false);
  assert.equal(doc.fullscreenElement, null);
  assert.equal(exits, 1);
});
