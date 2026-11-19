import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaces } from '../server/workspaces.mjs';
import { parseFrontMatter, validate } from '../scripts/validate-plan.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-wizard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'plan'));
  await copyFile('plan/plan.template.md', join(root, 'plan/plan.template.md'));
  const repoRoot = join(root, '新项目');
  await mkdir(repoRoot);
  return { root, repoRoot, file: join(repoRoot, 'plan/plan.md'), service: createWorkspaces(root) };
}

test('preflight is read-only; confirmation writes the exact preview and registers once', async t => {
  const { repoRoot, file, service } = await fixture(t);
  const info = service.preflight({ repoRoot });
  assert.equal(info.state, 'missing');
  assert.equal(existsSync(join(repoRoot, 'plan')), false);
  assert.deepEqual(validate(parseFrontMatter(info.preview)), []);
  const { id, name, previewId } = info;
  assert.throws(() => service.add({ repoRoot, id, name }));
  assert.throws(() => service.add({ repoRoot, id: 'default', name, previewId }));
  assert.throws(() => service.add({ repoRoot, id, name, previewId: 'stale' }), /重新检查/);
  assert.equal(existsSync(file), false);
  const project = service.add({ repoRoot, id, name, previewId });
  assert.equal(project.id, id);
  assert.equal(await readFile(file, 'utf8'), info.preview);
  assert.equal(service.get(id).name, '新项目');
  assert.throws(() => service.add({ repoRoot, id, name, previewId }));
  assert.equal(service.read().projects.length, 2);
});

test('valid plans register directly; malformed, semantically invalid and newly appeared files are preserved', async t => {
  const { repoRoot, file, service } = await fixture(t);
  const { previewId, preview, name, id } = service.preflight({ repoRoot });
  await mkdir(join(repoRoot, 'plan'));
  for (const content of ['用户原始正文', '---\ninvalid YAML\n---', preview.replace('progress: 0', 'progress: 150')]) {
    await writeFile(file, content);
    const check = service.preflight({ repoRoot });
    assert.equal(check.state, 'invalid');
    assert.match(check.message, /front matter|无法解析|progress/);
    assert.throws(() => service.add({ repoRoot, name, id, previewId }), /重新检查/);
    assert.throws(() => service.add({ repoRoot, name, id }));
    assert.equal(await readFile(file, 'utf8'), content);
    assert.equal(service.read().projects.length, 1);
  }
  const valid = preview.replace('project: 新项目', 'project: 已有项目');
  await writeFile(file, valid);
  assert.throws(() => service.add({ repoRoot, name, id, previewId }), /重新检查/);
  const existing = service.preflight({ repoRoot });
  assert.equal(existing.state, 'valid');
  assert.equal(existing.name, '已有项目');
  service.add({ repoRoot, name: existing.name, id });
  assert.equal(await readFile(file, 'utf8'), valid);
});

test('preflight and confirmation reject a plan directory redirected outside the selected project', async t => {
  const { root, repoRoot, service } = await fixture(t);
  const { id, name, previewId } = service.preflight({ repoRoot });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(repoRoot, 'plan'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(service.preflight({ repoRoot }).state, 'invalid');
  assert.throws(() => service.add({ repoRoot, name, id, previewId }));
  assert.equal(existsSync(join(outside, 'plan.md')), false);
});
