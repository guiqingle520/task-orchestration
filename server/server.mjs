#!/usr/bin/env node
// 驾驶舱服务: node server/server.mjs  → http://localhost:5173
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter, validate } from '../scripts/validate-plan.mjs';
import { getTaskCommitsMap, readGitCommits, applyCommitToTask, updatePlanMarkdown } from '../scripts/sync-git-progress.mjs';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const planFile = join(root, 'plan', 'plan.md');
const webDir = join(root, 'web');
const port = Number(process.env.PORT || 5173);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function loadPlan() {
  if (!existsSync(planFile)) return { error: ['找不到 plan/plan.md'] };
  try {
    const data = parseFrontMatter(readFileSync(planFile, 'utf8'));
    if (!data) return { error: ['plan.md 缺少 YAML front matter'] };
    return { data, commits: getTaskCommitsMap(root) };
  } catch (e) {
    return { error: [e.message] };
  }
}

function syncFromGit() {
  if (!existsSync(planFile)) return { ok: false, message: '找不到 plan/plan.md' };
  const raw = readFileSync(planFile, 'utf8');
  const data = parseFrontMatter(raw);
  if (!data || !Array.isArray(data.tasks)) return { ok: false, message: 'plan.md 格式错误' };
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const touched = [];
  for (const c of readGitCommits(root)) {
    for (const [id, u] of c.updates) {
      const t = byId.get(id);
      if (t && applyCommitToTask(t, u, c.date)) touched.push(`${id}@${c.hash}`);
    }
  }
  if (touched.length) {
    const errs = validate(data);
    if (errs.length) return { ok: false, message: errs.join('; ') };
    writeFileSync(planFile, updatePlanMarkdown(raw, data.tasks), 'utf8');
  }
  return { ok: true, touched };
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/plan') {
    const r = loadPlan();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ...r, errors: r.data ? validate(r.data) : r.error }));
  }
  if (url.pathname === '/api/sync-git' && req.method === 'POST') {
    const out = syncFromGit();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(out));
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/, '');
  const file = join(webDir, rel);
  if (!file.startsWith(webDir) || !existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`驾驶舱运行于 http://localhost:${port}`));
