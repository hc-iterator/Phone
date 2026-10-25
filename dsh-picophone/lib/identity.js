// 台架锁（串口/烧写互斥）+ 会话身份（session id / profile 名）。

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- 台架锁（#1）

/** 锁文件：默认 $DSH_HOME\picophone.lock —— 放在 profile 之外，任何会话都看得见。 */
export function lockFilePath(cfg) {
  if (cfg.lockPath) return path.resolve(String(cfg.lockPath));
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return path.join(home, 'picophone.lock');
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

export function readLockFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function lockHolderText(info) {
  if (!info) return '(锁文件在，但读不出来)';
  const ageSec = Math.max(0, Math.round((Date.now() - Number(info.since ?? Date.now())) / 1000));
  const parts = [info.what ?? '?', `pid=${info.pid}`, `会话=${info.session ?? '?'}`];
  if (info.profile) parts.push(`profile=${info.profile}`);
  parts.push(`起于 ${info.sinceText ?? '?'}（已占用 ${ageSec}s）`);
  return parts.join(' · ');
}

/**
 * 会话 id 的来源顺序：工具调用上下文里带的 agent → Host 环境变量 → 明说取不到。
 * ⚠️ Host 进程的 env 里【没有】DSH_SESSION_ID（Harness 只把它注入给派出去的子进程），
 * 所以第一顺位才是正路；取不到时写成一句人话，不写 "(unknown)" 免得看着像"没有会话"。
 */
export function currentSessionId(ctx) {
  const fromCtx = ctx && ctx.sessionId ? String(ctx.sessionId) : '';
  if (fromCtx) return fromCtx;
  const fromEnv = process.env.DSH_SESSION_ID;
  if (fromEnv) return String(fromEnv);
  return '(取不到会话 id：工具上下文与 Host env 都没有)';
}

/**
 * profile 名同理：Host env 里也没有 DSH_PROFILE。
 * 退路是从 hmr 服务的 baseDir 反推（它形如 <DSH_HOME>\profiles\<名字>），
 * 但只在父目录确实叫 profiles 时才认 —— 宁可留空，也不要写个错的。
 */
export function detectProfileName(ctx) {
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
  try {
    const baseDir = ctx && ctx.get ? ctx.get('hmr')?.baseDir : undefined;
    if (baseDir && path.basename(path.dirname(baseDir)) === 'profiles') return path.basename(baseDir);
  } catch {
    /* 没有 hmr 就算了 */
  }
  return '';
}

/** 占用台架（串口/烧写互斥）。陈锁（进程已死 / 超过 lockStaleMs）会被接手。 */
export function acquireRigLock(cfg, what, ctx) {
  const file = lockFilePath(cfg);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const payload = {
    token,
    pid: process.pid,
    session: currentSessionId(ctx),
    profile: cfg.profileName || process.env.DSH_PROFILE || '',
    what,
    since: Date.now(),
    sinceText: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      closeSync(fd);
      return { ok: true, token, file, text: `已占台架锁（${what}）: ${file}` };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        return { ok: false, token: '', text: `台架锁创建失败: ${error && error.message ? error.message : error}` };
      }
      const info = readLockFile(file);
      const staleByAge = Boolean(info) && Number.isFinite(Number(info.since)) && Date.now() - Number(info.since) > cfg.lockStaleMs;
      const staleByPid = Boolean(info) && Number.isFinite(Number(info.pid)) && !pidAlive(Number(info.pid));
      if (attempt === 0 && (staleByAge || staleByPid)) {
        try {
          unlinkSync(file);
        } catch {
          /* 别人抢先删了 */
        }
        continue;
      }
      const why = staleByAge ? '（陈锁：超过 lockStaleMs）' : staleByPid ? '（陈锁：占用进程已不在）' : '';
      return {
        ok: false,
        token: '',
        text:
          `台架被占用 ✗ ${why}\n  占用者: ${lockHolderText(info)}\n  锁文件: ${file}\n` +
          `串口/烧写不是可并发资源 —— 等它结束，或确认是陈锁后手动删掉该文件再试。`,
      };
    }
  }
  return { ok: false, token: '', text: '台架锁竞争失败（重试后仍被占）' };
}

export function releaseRigLock(lock) {
  if (!lock || !lock.ok) return;
  try {
    const info = readLockFile(lock.file);
    if (info && info.token === lock.token) unlinkSync(lock.file);
  } catch {
    /* 已经不在了 */
  }
}
