// 串口常驻会话（#3/#4/#7）：一个常开的 worker 进程 + 一发一收的请求/应答，跨调用复用端口。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { spawnEnv } from './exec.js';
import { acquireRigLock, currentSessionId, releaseRigLock } from './identity.js';
import { PACKAGE_DIR } from './paths.js';
import {
  askTrustApproval,
  registerTrust,
  relToRoot,
  resolveRuntimeScript,
  trustRefusal,
  trustVerdict,
} from './trust.js';
import { clip, killTree } from './util.js';

// ---------------------------------------------------------------- 串口常驻会话（#3/#4/#7）

// 会话表：opConsole 要按 id 直接取（console.js 里 sessions.get(id)），所以必须导出。
export const sessions = new Map();

export function sessionList() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    port: s.port || '(未开)',
    owner: s.owner,
    openedAt: s.openedAtText,
    idleSec: Math.round((Date.now() - s.lastUsed) / 1000),
    alive: s.child.exitCode === null,
  }));
}

export function sessionTouch(cfg, s) {
  s.lastUsed = Date.now();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    sessionClose(cfg, s.id, '空闲超时自动关闭');
  }, cfg.sessionIdleMs);
  if (s.timer.unref) s.timer.unref();
}

/** 一发一收：一个会话同时只允许一个在途请求（串口本来就是串行的）。 */
export function sessionRequest(s, message, timeoutMs) {
  return new Promise((resolve) => {
    if (s.pending) {
      resolve({ ok: false, event: 'busy', text: `会话 ${s.id} 还有一个请求在途，稍后再试。` });
      return;
    }
    const timer = setTimeout(() => {
      s.pending = null;
      resolve({ ok: false, event: 'timeout', text: `会话 ${s.id} 在 ${timeoutMs}ms 内没有任何回应（端口卡住或板子没反应）。` });
    }, timeoutMs);
    s.pending = { resolve, timer, message };
    try {
      s.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      clearTimeout(timer);
      s.pending = null;
      resolve({ ok: false, event: 'error', text: `写入会话失败: ${error && error.message ? error.message : error}` });
    }
  });
}

export function onSessionData(cfg, s, chunk) {
  s.buffer += chunk;
  let index = s.buffer.indexOf('\n');
  while (index >= 0) {
    const line = s.buffer.slice(0, index).trim();
    s.buffer = s.buffer.slice(index + 1);
    index = s.buffer.indexOf('\n');
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const pending = s.pending;
    if (!pending) continue;
    s.pending = null;
    clearTimeout(pending.timer);
    if (event.event === 'opened') s.port = event.port ?? s.port;
    pending.resolve({
      ok: event.event !== 'error',
      event: event.event,
      matched: event.matched,
      text: event.event === 'error' ? `会话错误: ${event.message}` : event.text,
      bytes: event.bytes,
      lines: event.lines,
      port: event.port,
      timedOut: event.timedOut,
    });
  }
}

export async function sessionOpen(cfg, args, ctx = {}) {
  const id = String(args.sessionId ?? 'default');
  const existing = sessions.get(id);
  if (existing && existing.child.exitCode === null) {
    sessionTouch(cfg, existing);
    return { ok: true, text: `会话 ${id} 已经开着（端口 ${existing.port || '?'}，起于 ${existing.openedAtText}）。` };
  }
  const lock = acquireRigLock(cfg, `serial session ${id}`, ctx);
  if (!lock.ok) return { ok: false, text: lock.text };

  const worker = path.join(PACKAGE_DIR, 'serial-session.ps1');
  if (!existsSync(worker)) {
    releaseRigLock(lock);
    return { ok: false, text: `缺少 ${worker}` };
  }
  // 【信任门】worker 是【直接 spawn】的（不经过 runProjectScript）⇒ 必须在 here 手动加同一道门。
  // 2026-10-07：它先前是漏的 —— 往 serial-session.ps1 里塞点东西再 pico_console open 就是沙箱外任意代码。
  let workerTrust = trustVerdict(cfg, worker);
  if (!workerTrust.ok) {
    // ⚠️ 这里必须 try/catch：锁已经拿在手里了，审批若抛异常而直接冒泡，就会【漏锁】
    //    （2026-10-07 实测漏了一把，得等 10 分钟陈锁判据或人手动清）。
    let ask;
    try {
      ask = await askTrustApproval(cfg, worker, { toolName: 'pico_console' });
    } catch (error) {
      ask = { outcome: 'unavailable', detail: `审批异常: ${error && error.message ? error.message : error}` };
    }
    if (ask.outcome === 'allowed-once' && registerTrust(cfg, worker)) {
      workerTrust = trustVerdict(cfg, worker);
    } else {
      releaseRigLock(lock);
      return { ok: false, text: `${trustRefusal(cfg, worker)}\n\n（审批结果：${ask.outcome}${ask.detail ? ` — ${ask.detail}` : ''}）` };
    }
  }
  // 【运行本】worker 也只跑 Pico 文件夹里那一份
  const workerRuntime = resolveRuntimeScript(cfg, worker);
  if (!workerRuntime) {
    releaseRigLock(lock);
    return { ok: false, text: `⛔ 会话 worker 的运行本不可用：${relToRoot(cfg, worker)}\n⇒ 先登记，或走 pico_amend。` };
  }
  let child;
  try {
    child = spawn(cfg.powershell, ['-NoProfile', '-NonInteractive', '-File', workerRuntime], {
      cwd: cfg.repo,
      windowsHide: true,
      env: spawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    releaseRigLock(lock);
    return { ok: false, text: `启动会话进程失败: ${error && error.message ? error.message : error}` };
  }

  const s = {
    id,
    child,
    port: '',
    buffer: '',
    pending: null,
    stderr: '',
    lock,
    owner: currentSessionId(ctx),
    lastUsed: Date.now(),
    openedAtText: new Date().toISOString(),
    timer: null,
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => onSessionData(cfg, s, chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    s.stderr = `${s.stderr}${chunk}`.slice(-4000);
  });
  child.on('close', () => {
    if (s.timer) clearTimeout(s.timer);
    sessions.delete(id);
    releaseRigLock(s.lock);
  });
  sessions.set(id, s);

  const target = args.port ? null : cfg.devices[String(args.target ?? 'dut')];
  const open = await sessionRequest(
    s,
    {
      cmd: 'open',
      port: args.port ? String(args.port) : '',
      vid: args.vid ?? target?.vid ?? '',
      pid: args.pid ?? target?.pid ?? '',
      baud: Number.isFinite(args.baud) ? args.baud : 115200,
    },
    cfg.sessionOpenTimeoutMs,
  );
  if (!open.ok) {
    const stderr = s.stderr.trim() ? `\n子进程 stderr（前 1500 字）:\n${clip(s.stderr, 1500)}` : '';
    sessionClose(cfg, id, '打开失败');
    return { ok: false, text: `${open.text}${stderr}\n（实测 open 本身要 4.5~4.7s；超时多半是端口被占或在 BOOTSEL 里没跑应用）` };
  }
  sessionTouch(cfg, s);
  return { ok: true, text: `会话 ${id} 已打开：${s.port}（DTR 已拉高）—— 之后可以反复 send/read，不用再重开口。` };
}

export async function sessionSend(cfg, s, args) {
  const res = await sessionRequest(s, { cmd: 'send', data: String(args.data ?? ''), escapes: args.escapes === true }, 15000);
  if (res.ok) sessionTouch(cfg, s);
  return { ok: res.ok, text: res.ok ? `已发送 ${res.bytes ?? 0} 字节到 ${s.port}。` : res.text };
}

export async function sessionRead(cfg, s, args) {
  const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 2000;
  const res = await sessionRequest(
    s,
    { cmd: 'read', timeoutMs, until: args.until === undefined ? '' : String(args.until), stamp: args.stamp !== false },
    timeoutMs + 8000,
  );
  if (!res.ok) return { ok: false, text: res.text };
  sessionTouch(cfg, s);
  const head = res.matched
    ? `命中 until（${args.until}），${res.bytes ?? 0} 字节 / ${res.lines ?? 0} 行：`
    : `超时无匹配（读了 ${res.bytes ?? 0} 字节 / ${res.lines ?? 0} 行；不是"没打印"就是板子没反应）：`;
  return { ok: true, text: `${head}\n${res.text && res.text.trim() !== '' ? res.text : '(这段时间没有输出)'}` };
}

export function sessionClose(cfg, id, why) {
  const s = sessions.get(id);
  if (!s) return { ok: false, text: `没有会话 ${id}。` };
  sessions.delete(id);
  if (s.timer) clearTimeout(s.timer);
  try {
    s.child.stdin.write(`${JSON.stringify({ cmd: 'close' })}\n`);
    s.child.stdin.end();
  } catch {
    /* 已经关了 */
  }
  setTimeout(() => killTree(s.child), 800).unref?.();
  releaseRigLock(s.lock);
  return { ok: true, text: `会话 ${id} 已关闭（${why}）。` };
}
