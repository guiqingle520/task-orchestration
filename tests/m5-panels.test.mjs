import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installM5Panels } from '../web/m5-panels.js';

test('offline export explains a legacy text 404, preserves JSON validation messages and can retry', async (t) => {
  const saved = { document: globalThis.document, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, saved));
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      const events = new Map();
      elements.set(id, {
        open: false, addEventListener: (type, handler) => events.set(type, handler),
        showModal() { this.open = true; },
        close() { this.open = false; events.get('close')?.(); },
        fire: (name) => events.get(name)?.({ preventDefault() {} }),
      });
    }
    return elements.get(id);
  };
  globalThis.document = { getElementById: el, addEventListener() {} };
  const responses = [
    new Response('Not found', { status: 404 }),
    Response.json({ message: '统计日期无效' }, { status: 400 }),
    Response.json({ html: '<!doctype html><title>Share</title>', filename: 'share.html' }),
  ];
  globalThis.fetch = async (path) => path.startsWith('/api/export/html?') ? responses.shift() : Response.json({});
  let downloaded;
  const base = { projectId: 'default', epoch: 0, m: { today: '2026-11-18' }, data: { project: 'Demo', milestones: [], tasks: [] } };
  const panels = installM5Panels({
    getLive: () => base, apiUrl: (path, id) => path + '?project=' + id,
    downloadFile: (_content, _type, filename) => { downloaded = filename; },
    refresh() {}, rerenderDetail() {}, esc: String,
  });
  panels.setAvailable(base);
  el('exportHtmlBtn').fire('click');
  await el('exportHtmlForm').fire('submit');
  assert.match(el('exportHtmlStatus').textContent, /重启 npm start/);
  assert.doesNotMatch(el('exportHtmlStatus').textContent, /Unexpected token/);
  assert.equal(el('exportHtmlDialog').open, true);
  assert.equal(el('exportHtmlSubmit').disabled, false);
  await el('exportHtmlForm').fire('submit');
  assert.equal(el('exportHtmlStatus').textContent, '统计日期无效');
  await el('exportHtmlForm').fire('submit');
  assert.equal(downloaded, 'share.html');
  assert.equal(el('exportHtmlDialog').open, false);
});
