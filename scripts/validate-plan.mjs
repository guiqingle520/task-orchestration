#!/usr/bin/env node
// 零依赖的 plan.md 校验器。用法: node scripts/validate-plan.mjs [plan文件路径]
// 仅支持 docs/PLAN_SPEC.md 规定的 YAML 子集。
import { readFileSync, existsSync } from 'node:fs';

const file = process.argv[2] || 'plan/plan.md';
const errors = [];
const err = (m) => errors.push(m);

export function parseScalar(v) {
  v = v.trim();
  if (v === '' || v === 'null' || v === '~') return null;
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(',').map((s) => parseScalar(s)) : [];
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

const stripComment = (s) => s.replace(/\s+#.*$/, '');

export function parseFrontMatter(text) {
  const m = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const data = {};
  let list = null; // 当前列表
  let item = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = stripComment(raw).replace(/\s+$/, '');
    if (!line.trim()) continue;
    let mm;
    if ((mm = line.match(/^(\w+):\s*(.*)$/))) {
      item = null;
      if (mm[2] === '') { data[mm[1]] = list = []; } else { data[mm[1]] = parseScalar(mm[2]); list = null; }
    } else if (list && (mm = line.match(/^\s+-\s+(\w+):\s*(.*)$/))) {
      item = { [mm[1]]: parseScalar(mm[2]) };
      list.push(item);
    } else if (item && (mm = line.match(/^\s+(\w+):\s*(.*)$/))) {
      item[mm[1]] = parseScalar(mm[2]);
    } else {
      throw new Error(`无法解析的行: "${raw}"`);
    }
  }
  return data;
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const STATUS = ['todo', 'doing', 'done', 'blocked'];

export function validate(data) {
  errors.length = 0;
  validateInner(data);
  return [...errors];
}

function validateInner(data) {
  if (!data.project || typeof data.project !== 'string') err('缺少 project(字符串)');
  const ms = data.milestones, ts = data.tasks;
  if (!Array.isArray(ms) || ms.length === 0) err('milestones 必须是非空列表');
  if (!Array.isArray(ts) || ts.length === 0) err('tasks 必须是非空列表');
  if (!Array.isArray(ms) || !Array.isArray(ts)) return;

  const msIds = new Set();
  ms.forEach((x, i) => {
    const p = `milestones[${i}]`;
    if (!x.id) err(`${p} 缺少 id`);
    else if (msIds.has(x.id)) err(`${p} id 重复: ${x.id}`);
    else msIds.add(x.id);
    if (!x.name) err(`${p} 缺少 name`);
    if (!isDate(x.due)) err(`${p} due 必须是 YYYY-MM-DD`);
  });

  const ids = new Set();
  ts.forEach((t) => { if (t.id) ids.add(t.id); });
  const seen = new Set();
  ts.forEach((t, i) => {
    const p = `任务 ${t.id ?? `#${i}`}`;
    for (const k of ['id', 'title', 'owner', 'milestone', 'start', 'end', 'deps', 'status', 'progress'])
      if (t[k] === undefined || t[k] === null || t[k] === '') err(`${p} 缺少字段 ${k}`);
    if (t.id) {
      if (!/^T-\d+$/.test(t.id)) err(`${p} id 格式必须为 T-数字`);
      if (seen.has(t.id)) err(`${p} id 重复`);
      seen.add(t.id);
    }
    if (t.milestone && !msIds.has(t.milestone)) err(`${p} milestone "${t.milestone}" 不存在`);
    if (t.start != null && !isDate(t.start)) err(`${p} start 必须是 YYYY-MM-DD`);
    if (t.end != null && !isDate(t.end)) err(`${p} end 必须是 YYYY-MM-DD`);
    if (isDate(t.start) && isDate(t.end) && t.end < t.start) err(`${p} end 早于 start`);
    if (t.status && !STATUS.includes(t.status)) err(`${p} status 必须是 ${STATUS.join('|')}`);
    if (t.progress != null && !(typeof t.progress === 'number' && t.progress >= 0 && t.progress <= 100))
      err(`${p} progress 必须是 0-100 的数字`);
    if (t.status === 'done' && t.progress !== 100) err(`${p} 已 done 但 progress 不是 100`);
    if (t.status === 'todo' && t.progress > 0) err(`${p} 为 todo 但 progress > 0`);
    for (const k of ['actualStart', 'actualEnd'])
      if (t[k] != null && !isDate(t[k])) err(`${p} ${k} 必须是 YYYY-MM-DD 或 null`);
    if (t.status === 'done' && !isDate(t.actualEnd)) err(`${p} 已 done 必须填写 actualEnd`);
    if (t.deps !== undefined && !Array.isArray(t.deps)) err(`${p} deps 必须是列表,例如 [T-1, T-2]`);
    else (t.deps || []).forEach((d) => {
      if (d === t.id) err(`${p} 不能依赖自己`);
      else if (!ids.has(d)) err(`${p} 依赖的任务 ${d} 不存在`);
    });
  });

  // 循环依赖检测 (DFS)
  const graph = new Map(ts.map((t) => [t.id, Array.isArray(t.deps) ? t.deps : []]));
  const state = new Map();
  const dfs = (n, path) => {
    if (state.get(n) === 1) { err(`存在循环依赖: ${[...path.slice(path.indexOf(n)), n].join(' -> ')}`); return; }
    if (state.get(n) === 2 || !graph.has(n)) return;
    state.set(n, 1);
    for (const d of graph.get(n)) dfs(d, [...path, n]);
    state.set(n, 2);
  };
  for (const n of graph.keys()) dfs(n, []);
}

if (process.argv[1]?.endsWith('validate-plan.mjs')) {
  if (!existsSync(file)) {
    console.error(`✗ 找不到 ${file}。请先按 plan/plan.template.md 生成计划。`);
    process.exit(1);
  }
  try {
    const data = parseFrontMatter(readFileSync(file, 'utf8'));
    if (!data) err('文件开头缺少 YAML front matter(--- ... ---)');
    else validate(data);
  } catch (e) {
    err(e.message);
  }
  if (errors.length) {
    console.error(`✗ ${file} 校验失败 (${errors.length} 个问题):`);
    errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  console.log(`✓ ${file} 校验通过`);
}
