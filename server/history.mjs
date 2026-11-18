import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseFrontMatter, validate } from '../scripts/validate-plan.mjs';
import { compute } from '../web/metrics.js';

const run = promisify(execFile);
const FORMAT = '%H%x00%h%x00%aI%x00%an%x00%s';
const REVISION = /^[0-9a-f]{7,40}$/i;
const MAX_HISTORY = 100;
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
  const git = async (args, missingExitCodes = []) => {
    try {
      const { stdout } = await run('git', ['--no-pager', '--no-replace-objects', '--literal-pathspecs', ...args], {
        cwd: root, encoding: 'utf8', env, timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      });
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

async function readVersion({ git, path }, hash) {
  const raw = await git(['show', hash + ':' + path], [128]);
  if (raw == null) return null;
  try {
    const data = parseFrontMatter(raw);
    return data && !validate(data).length ? data : null;
  } catch { return null; }
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
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY) {
    throw new HistoryError(400, '历史提交 limit 必须是 1 至 100 的整数');
  }
  const context = await gitContext(project);
  if (!context) return [];
  const { git, path } = context;
  if (!await git(['rev-parse', '--verify', 'HEAD'], [128])) return [];
  const log = await git(['log', '-n', String(limit), '--format=' + FORMAT, 'HEAD', '--', path]);
  const records = log.split(/\r?\n/).filter(Boolean).map(commitMetadata).reverse()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const commits = [];
  // 有界并行读取快照，让 Git I/O 不阻塞实时刷新和 SSE。
  for (let i = 0; i < records.length; i += 4) {
    const batch = await Promise.all(records.slice(i, i + 4).map(async (commit) => {
      const data = await readVersion(context, commit.hash);
      return data && { ...commit, ...summarizePlanFrame(data, commit.date) };
    }));
    commits.push(...batch.filter(Boolean));
  }
  return commits;
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
  const data = await readVersion(context, hash);
  if (!data) throw missing();
  const line = await git(['show', '-s', '--format=' + FORMAT, hash]);
  return { commit: commitMetadata(line.replace(/\r?\n$/, '')), data };
}
