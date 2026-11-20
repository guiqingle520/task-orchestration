import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseFrontMatter, validate } from '../scripts/validate-plan.mjs';
import { compute } from '../web/metrics.js';
import { extractAcceptanceByTask } from './plan-acceptance.mjs';

const run = promisify(execFile);
const FORMAT = '%H%x00%h%x00%aI%x00%an%x00%s';
const REVISION = /^[0-9a-f]{7,40}$/i;
const MAX_HISTORY = 100;
const FRAME_BUDGET = 1024 * 1024;
const GIT_LOCATION_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_SHALLOW_FILE', 'GIT_REPLACE_REF_BASE',
  'GIT_GRAFT_FILE', 'GIT_PREFIX',
];

export class HistoryError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gitContext(project) {
  const root = await realpath(project.repoRoot);
  const path = relative(root, project.planPath);
  if (!path || isAbsolute(path) || path === '..' || path.startsWith('..' + sep)) {
    throw new HistoryError(400, '计划文件必须位于项目目录内');
  }
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  for (const key of GIT_LOCATION_VARS) delete env[key];
  const git = async (args, missingExitCodes = [], input) => {
    try {
      const command = run('git', ['--no-pager', '--no-replace-objects', '--literal-pathspecs', ...args], {
        cwd: root, encoding: input === undefined ? 'utf8' : 'buffer', env, timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      });
      const stdin = command.child.stdin;
      stdin.on('error', () => {}); // Git can close stdin before a failed command exits.
      stdin.end(input);
      const { stdout } = await command;
      return stdout;
    } catch (err) {
      if (missingExitCodes.includes(err.code)) return null;
      throw err;
    }
  };
  const top = await git(['rev-parse', '--show-toplevel'], [128, 'ENOENT']);
  // Git 会自动寻找父目录仓库；注册项目没有自己的仓库时不返回父项目历史。
  if (!top || relative(root, await realpath(top.replace(/\r?\n$/, ''))) !== '') return null;
  return { git, path: path.split(sep).join('/') };
}

function commitMetadata(line) {
  const [hash, shortHash, timestamp, author, subject] = line.split('\u0000');
  return { hash, shortHash, date: timestamp.slice(0, 10), timestamp, author, subject };
}

function parseVersion(raw, includeAcceptance) {
  if (raw == null) return null;
  try {
    const data = parseFrontMatter(raw);
    if (!data || validate(data).length) return null;
    return includeAcceptance ? { data, acceptanceByTask: extractAcceptanceByTask(raw) } : { data };
  } catch { return null; }
}

async function readVersion({ git, path }, hash, includeAcceptance = false) {
  return parseVersion(await git(['show', hash + ':' + path], [128]), includeAcceptance);
}

async function readHistoryBlobs({ git, path }, records) {
  // Files with line breaks and histories that exceed the output limit use the per-commit reader.
  if (path.includes('\n') || !records.length) return null;
  try {
    const input = records.map(({ hash }) => `${hash}:${path}\n`).join('');
    const output = await git(['cat-file', '--batch'], [], input);
    let offset = 0;
    return records.map(() => {
      const end = output.indexOf(10, offset);
      if (end < 0) throw new Error('Git batch response missing header');
      const header = output.toString('utf8', offset, end);
      offset = end + 1;
      if (header.endsWith(' missing')) return null;
      const match = /^[a-f0-9]+ (\w+) (\d+)$/.exec(header);
      if (!match) throw new Error('Invalid Git object header');
      const next = offset + Number(match[2]);
      if (output[next] !== 10) throw new Error('Truncated Git object');
      const content = match[1] === 'blob' ? output.toString('utf8', offset, next) : null;
      offset = next + 1;
      return content;
    });
  } catch {
    return null;
  }
}

export function summarizePlanFrame(data, date) {
  return {
    date,
    taskCount: data.tasks.length,
    doneCount: data.tasks.filter(({ status }) => status === 'done').length,
    overall: compute(data, date).summary.overall,
  };
}

export async function listPlanHistory(project, limit = 50) {
  return (await readPlanHistory(project, limit)).commits;
}

export async function readPlanHistory(project, limit = 50, includeFrames = false) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY) {
    throw new HistoryError(400, '历史提交 limit 必须是 1 至 100 的整数');
  }
  const context = await gitContext(project);
  const commits = [];
  const frames = {};
  if (!context) return { commits, frames };
  const { git, path } = context;
  const log = await git(['log', '-n', String(limit), '--format=' + FORMAT, 'HEAD', '--', path], [128]);
  if (!log) return { commits, frames };
  const records = log.split(/\r?\n/).filter(Boolean).map(commitMetadata).reverse()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const blobs = await readHistoryBlobs(context, records);
  let remaining = FRAME_BUDGET;
  for (let i = 0; i < records.length; i += 4) {
    const batch = records.slice(i, i + 4);
    const versions = blobs ? blobs.slice(i, i + batch.length).map(raw => parseVersion(raw, includeFrames && remaining > 0))
      : await Promise.all(batch.map(commit => readVersion(context, commit.hash)));
    for (const [index, commit] of batch.entries()) {
      const frame = versions[index];
      if (!frame) continue;
      commits.push({ ...commit, ...summarizePlanFrame(frame.data, commit.date) });
      if (frame.acceptanceByTask) {
        remaining -= Buffer.byteLength(JSON.stringify(frame));
        if (remaining >= 0) frames[commit.hash] = frame;
      }
    }
  }
  return { commits, frames };
}

export async function getPlanAtCommit(project, commitHash) {
  if (typeof commitHash !== 'string' || !REVISION.test(commitHash)) throw new HistoryError(400, '历史版本必须是 7 至 40 位 Git 提交哈希');
  const missing = () => new HistoryError(404, '当前项目历史中找不到有效的计划快照');
  const context = await gitContext(project);
  if (!context) throw missing();
  const { git } = context;
  const resolved = await git(['rev-parse', '--verify', '--end-of-options', commitHash.toLowerCase() + '^{commit}'], [128]);
  if (!resolved) throw missing();
  const hash = resolved.trim();
  if (await git(['merge-base', '--is-ancestor', hash, 'HEAD'], [1, 128]) === null) throw missing();
  const frame = await readVersion(context, hash, true);
  if (!frame) throw missing();
  const line = await git(['show', '-s', '--format=' + FORMAT, hash]);
  return { commit: commitMetadata(line.replace(/\r?\n$/, '')), ...frame };
}
