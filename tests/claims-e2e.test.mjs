import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { getClaimsSnapshot, mutateClaims } from '../server/claim-service.mjs';
import { claimsPath, readClaims } from '../server/claims.mjs';
import { createMcpService } from '../server/mcp.mjs';
import { parseFrontMatter, serializePlanMarkdown } from '../scripts/validate-plan.mjs';

const today = '2026-11-22';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'claims-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'plan'));
  const planPath = join(root, 'plan', 'plan.md');
  const tasks = [{ id: 'T-1', title: 'Claimed work', owner: 'codex', milestone: 'M1', start: today, end: today,
    deps: [], status: 'todo', progress: 0, actualStart: null, actualEnd: null }];
  const raw = serializePlanMarkdown({ project: 'Claims', milestones: [{ id: 'M1', name: 'Claims', due: today }], tasks },
    '---\nproject: seed\n---\n');
  fs.writeFileSync(planPath, raw);
  return { root, raw, project: { id: 'default', planPath: fs.realpathSync(planPath) } };
}

function failRenameTo(path, run) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path) throw Object.assign(new Error('Injected disk error'), { code: 'EIO' });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try { return run(); }
  finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
}

test('a failed immediate start preserves the lease and allows a safe retry', (t) => {
  const { project, raw } = fixture(t);
  const input = { action: 'claim', id: 'T-1', actor: 'codex', startImmediately: true };
  const partial = failRenameTo(project.planPath, () => mutateClaims(project, input, today));
  assert.equal(partial.ok, true);
  assert.equal(partial.claimed_but_not_started, true);
  assert.equal(partial.warningCode, 'CLAIMED_BUT_NOT_STARTED');
  assert.equal(fs.readFileSync(project.planPath, 'utf8'), raw);
  assert.equal(getClaimsSnapshot(project, today).claims['T-1'].leaseId, partial.claim.leaseId);
  assert.deepEqual(fs.readdirSync(dirname(project.planPath)).sort(), ['claims.json', 'plan.md']);
  const retried = mutateClaims(project, { ...input, expectedLeaseId: partial.claim.leaseId }, today);
  assert.equal(retried.taskStarted, true);
  assert.equal(retried.claim.leaseId, partial.claim.leaseId);
  assert.equal(retried.task.status, 'doing');
});

test('a failed release after completion is recovered exactly once when the next process reads', (t) => {
  const { root, project } = fixture(t);
  const { claim } = mutateClaims(project, { action: 'claim', id: 'T-1', actor: 'codex' }, today);
  const mcp = createMcpService(root);
  const { expected } = mcp.callTool('plan_get_task', { id: 'T-1' }).structuredContent;
  const partial = failRenameTo(claimsPath(project.planPath), () => mcp.callTool('plan_update_task', {
    id: 'T-1', status: 'done', progress: 100, today, expected, actor: claim.actor, leaseId: claim.leaseId,
  }).structuredContent);
  assert.equal(partial.ok, true);
  assert.equal(partial.claimReleased, false);
  assert.equal(partial.warningCode, 'DONE_CLAIM_RELEASE_PENDING');
  assert.equal(parseFrontMatter(fs.readFileSync(project.planPath, 'utf8')).tasks[0].status, 'done');
  assert.equal(readClaims(project.planPath).claims['T-1'].leaseId, claim.leaseId);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', [
    "import { createMcpService } from './server/mcp.mjs';",
    'const mcp = createMcpService(process.argv[1]);',
    "console.log(JSON.stringify([1, 2].map(() => mcp.callTool('plan_get_task', { id: 'T-1' }).structuredContent)));",
  ].join('\n'), root], { encoding: 'utf8' });
  for (const task of JSON.parse(output)) {
    assert.equal(task.task.status, 'done');
    assert.equal(task.claim, null);
  }
  assert.deepEqual(readClaims(project.planPath).activityLog.map(({ type }) => type), ['claim', 'auto_reconcile_done']);
});
