import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWebhookPayload, createWebhookService, isPublicAddress } from '../server/webhooks.mjs';

const event = { project: 'demo', today: '2026-11-17', summary: '摘要', risks: [{ id: 'T-1', level: 'red', text: '延期' }], markdown: '# 报告', timestamp: '2026-11-17T00:00:00Z' };

test('webhook adapters build channel-specific payloads', () => {
  assert.equal(buildWebhookPayload('feishu', event).msg_type, 'post');
  assert.equal(buildWebhookPayload('dingtalk', event).markdown.text, '# 报告');
  assert.equal(buildWebhookPayload('wecom', event).markdown.content, '# 报告');
  assert.deepEqual(buildWebhookPayload('generic', event).risks, event.risks);
  assert.throws(() => buildWebhookPayload('invalid', event));
});

test('private network addresses are rejected', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('webhook config masks URLs and automatic dedup retries failures per channel and project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'webhooks-'));
  await mkdir(join(root, 'plan'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0, fail = true;
  const service = createWebhookService(root, async () => { calls++; if (fail) throw new Error('secret URL'); });
  const legacy = { id: 'a', name: 'A', type: 'generic', url: 'https://example.com/secret', enabled: true, autoAlert: true };
  await writeFile(join(root, 'plan', 'webhooks.json'), JSON.stringify([legacy]));
  assert.equal(service.list()[0].configured, true);
  assert.deepEqual(service.list()[0].projects, []);
  assert.deepEqual((await service.notify('p1', event, 'all', true)).results, []);
  assert.deepEqual((await service.notify('p1', event)).results, []);
  assert.equal(calls, 0);
  const channel = { ...legacy, projects: ['p1', 'p3'] };
  const visible = service.save([channel]);
  assert.equal(visible[0].url, '');
  assert.equal(visible[0].configured, true);
  service.save(visible);
  assert.match(await readFile(join(root, 'plan', 'webhooks.json'), 'utf8'), /secret/);
  assert.throws(() => service.save([{ ...channel, url: 'http://127.0.0.1/' }]));
  assert.deepEqual((await service.notify('p1', event, 'all', true)).results, [{ id: 'a', status: 'failed' }]);
  fail = false;
  assert.deepEqual((await service.notify('p1', event, 'all', true)).results, [{ id: 'a', status: 'sent' }]);
  assert.deepEqual((await service.notify('p1', event, 'all', true)).results, []);
  assert.deepEqual((await service.notify('p2', event, 'all', true)).results, []);
  assert.deepEqual((await service.notify('p2', event)).results, []);
  await assert.rejects(service.notify('p2', event, 'a'));
  assert.deepEqual((await service.notify('p3', event, 'all', true)).results, [{ id: 'a', status: 'sent' }]);
  assert.equal(calls, 3);
});
