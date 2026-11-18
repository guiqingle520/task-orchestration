import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';

export function buildWebhookPayload(channelType, event) {
  const text = event.markdown || event.summary;
  switch (channelType) {
    case 'feishu': return { msg_type: 'post', content: { post: { zh_cn: { title: `${event.project} 项目进展`, content: [[{ tag: 'text', text }]] } } } };
    case 'dingtalk': return { msgtype: 'markdown', markdown: { title: `${event.project} 项目进展`, text } };
    case 'wecom': return { msgtype: 'markdown', markdown: { content: text } };
    case 'generic': return { project: event.project, today: event.today, summary: event.summary, risks: event.risks, markdown: event.markdown, timestamp: event.timestamp };
    default: throw new Error('不支持的渠道类型');
  }
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)));
  }
  if (family === 6) {
    const first = parseInt(address.split(':')[0] || '0', 16);
    const lower = address.toLowerCase();
    return first >= 0x2000 && first <= 0x3fff && !lower.startsWith('2001:db8:') && !lower.startsWith('2001:0:') && !lower.startsWith('2002:');
  }
  return false;
}

function parseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Webhook 地址必须是 HTTPS，且不能包含用户名、密码或片段');
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Webhook 地址不能指向内部网络');
  return url;
}

export async function sendWebhook(urlText, payload) {
  const url = parseUrl(urlText);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) throw new Error('Webhook 域名解析到非公网地址');
  const selected = addresses[0];
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, lookup: (_name, opts, cb) => cb(null, ...(opts.all ? [[selected]] : [selected.address, selected.family])) }, (res) => {
      let response = '';
      res.on('data', (chunk) => { response += chunk.toString(); if (response.length > 65536) req.destroy(new Error('响应过大')); });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Webhook 返回 HTTP ${res.statusCode}`));
        let parsed; try { parsed = JSON.parse(response); } catch { /* 部分通用端点返回非 JSON */ }
        if (parsed && ((typeof parsed.code === 'number' && parsed.code !== 0) || (typeof parsed.errcode === 'number' && parsed.errcode !== 0) || (typeof parsed.StatusCode === 'number' && parsed.StatusCode !== 0))) return reject(new Error('Webhook 渠道返回失败'));
        resolve();
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Webhook 请求超时')));
    req.on('error', reject);
    req.end(body);
  });
}

export function createWebhookService(root, sender = sendWebhook) {
  const file = join(root, 'plan', 'webhooks.json');
  const sent = new Set(), pending = new Set();
  const read = () => {
    if (!existsSync(file)) return [];
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Webhook 配置无效');
    return data;
  };
  const list = () => read().map(({ url, projects, ...channel }) => ({ ...channel, projects: Array.isArray(projects) ? projects : [], url: '', configured: Boolean(url) }));
  // validProjectIds 传入时,渠道里引用的项目必须已注册
  function save(channels, validProjectIds = null) {
    if (!Array.isArray(channels) || channels.length > 50) throw new Error('渠道配置无效');
    const previous = new Map(read().map((channel) => [channel.id, channel]));
    const ids = new Set();
    const normalized = channels.map((channel) => {
      const { id, name, type, enabled, autoAlert, projects } = channel;
      if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || ids.has(id) || typeof name !== 'string' || !name.trim() || name.length > 100 || !['feishu', 'dingtalk', 'wecom', 'generic'].includes(type) || typeof enabled !== 'boolean' || typeof autoAlert !== 'boolean') throw new Error('渠道配置字段无效');
      if (!Array.isArray(projects) || projects.length > 100 || projects.some((item) => typeof item !== 'string' || !/^[\w-]{1,80}$/.test(item))) throw new Error('渠道必须显式选择允许发送的项目');
      if (validProjectIds && projects.some((item) => !validProjectIds.includes(item))) throw new Error('渠道引用了未注册的项目');
      ids.add(id);
      const url = channel.url || previous.get(id)?.url;
      if (typeof url !== 'string' || url.length > 4096) throw new Error('Webhook 地址无效');
      parseUrl(url);
      return { id, name: name.trim(), type, url, enabled, autoAlert, projects: [...new Set(projects)] };
    });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }); renameSync(tmp, file); }
    finally { if (existsSync(tmp)) unlinkSync(tmp); }
    return list();
  }
  async function notify(projectId, event, channelId = 'all', auto = false) {
    // 渠道只接收显式授权项目的消息;没有 projects 的旧配置视为不接收任何项目
    const channels = read().filter((channel) => channel.enabled && Array.isArray(channel.projects) && channel.projects.includes(projectId) && (!auto || channel.autoAlert) && (channelId === 'all' || channel.id === channelId));
    if (channelId !== 'all' && !channels.length) throw new Error('渠道不存在、未启用或未授权该项目');
    if (!auto && !channels.length) return { ok: false, results: [] };
    const results = [];
    for (const channel of channels) {
      const risks = event.risks.filter((risk) => risk.level === 'red');
      const fingerprints = risks.map((risk) => createHash('sha256').update(JSON.stringify([projectId, channel.id, risk.id, risk.level, risk.text])).digest('hex'));
      const fresh = fingerprints.filter((key) => !sent.has(key) && !pending.has(key));
      if (auto && !fresh.length) continue;
      if (auto) for (const key of fresh) pending.add(key);
      try {
        await sender(channel.url, buildWebhookPayload(channel.type, event));
        if (auto) for (const key of fresh) sent.add(key);
        results.push({ id: channel.id, status: 'sent' });
      } catch { results.push({ id: channel.id, status: 'failed' }); }
      finally { if (auto) for (const key of fresh) pending.delete(key); }
    }
    return { ok: results.every((item) => item.status === 'sent'), results };
  }
  return { list, save, notify };
}
