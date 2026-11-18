import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress } from './webhooks.mjs';

export class IntegrationError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

export function issueApiBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new IntegrationError(400, 'API 地址格式无效'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host))) {
    throw new IntegrationError(400, 'API 地址必须是公网 HTTPS，且不能包含凭证、查询或片段');
  }
  return url.href.replace(/\/+$/, '');
}

export async function sendIssueRequest(config, { url, method, body }) {
  const endpoint = new URL(url);
  if (new URL(issueApiBase(config.apiBase)).origin !== endpoint.origin) throw new IntegrationError(502, '平台 API 地址不一致');
  const host = endpoint.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true }); }
  catch { throw new IntegrationError(502, '无法解析平台 API 地址'); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new IntegrationError(502, '平台 API 域名解析到非公网地址');
  }
  const pinned = addresses[0];
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { accept: 'application/json', 'user-agent': 'task-orchestration' };
  if (config.provider === 'github') {
    headers.authorization = 'Bearer ' + config.token;
    headers['x-github-api-version'] = '2022-11-28';
  } else headers['private-token'] = config.token;
  if (payload !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
  const unavailable = () => new IntegrationError(502, '无法连接平台 API');
  return new Promise((resolve, reject) => {
    const req = request(endpoint, {
      method, headers, agent: false,
      lookup: (_name, opts, callback) => {
        if (opts.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family);
      },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // 不跟随重定向，也不把远端响应或 Token 写入错误消息。
        res.resume();
        reject(new IntegrationError(502, '平台 API 返回 HTTP ' + res.statusCode));
        return;
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { req.destroy(); reject(new IntegrationError(502, '平台 API 响应过大')); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(unavailable()));
      res.on('end', () => {
        try { resolve({ data: JSON.parse(Buffer.concat(chunks).toString('utf8')), headers: res.headers }); }
        catch { reject(new IntegrationError(502, '平台 API 响应不是有效 JSON')); }
      });
    });
    const timeout = setTimeout(() => req.destroy(unavailable()), 12000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', () => reject(unavailable()));
    req.end(payload ?? undefined);
  });
}
