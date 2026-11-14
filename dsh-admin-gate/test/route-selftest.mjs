/**
 * 路由自测：进程内挂插件，直接调用 /api/admin-gate 的 handler。
 * 目的：证明 GET 返回 JSON、POST 能任命并写审计（不依赖 DSH 起来）。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const home = path.join(os.tmpdir(), `pm-route-test-${Date.now()}`);
process.env.DSH_HOME = home;

const mod = await import('../index.js');

const tools = new Map();
let route = null;

const fakeCtx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => {}; } },
  effect: (fn) => { fn(); },
  get: (name) => {
    if (name === 'webServer') return { register: (r) => { route = r; return () => {}; } };
    if (name === 'sessions') return { get: () => ({ ownEvents: () => [{ type: 'user/message', data: { source: { kind: 'agent-message' } }, time: Date.now() }] }) };
    return undefined;
  },
  logger: { info: () => {} },
};

mod.apply(fakeCtx);

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk) { this.body += chunk || ''; },
  };
}

function fakeReq(method, bodyObj, path = '/.dsh-admin-gate/state') {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  setTimeout(() => {
    if (bodyObj !== undefined) req.emit('data', JSON.stringify(bodyObj));
    req.emit('end');
  }, 0);
  return req;
}

console.log('路由注册:', route ? `${route.kind} ${route.path}` : '❌ 未注册');

let res = fakeRes();
await route.handler(fakeReq('GET'), res);
console.log('GET  status=', res.statusCode, 'content-type=', res.headers['content-type']);
console.log('GET  body=', res.body);

const target = 'session-dddddddd-dddd-dddd-dddd-dddddddddddd';
res = fakeRes();
await route.handler(fakeReq('POST', { action: 'grant', sessionId: target }, '/.dsh-admin-gate/grant'), res);
console.log('POST grant status=', res.statusCode, 'body=', res.body.slice(0, 220));

res = fakeRes();
await route.handler(fakeReq('GET'), res);
console.log('GET2 body=', res.body);

const stateFile = path.join(home, 'pm', 'state.json');
const auditFile = path.join(home, 'pm', 'audit.jsonl');
console.log('state.json 存在=', fs.existsSync(stateFile), ' audit.jsonl 行数=', fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').length : 0);
console.log('审计内容=', fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim() : '');
