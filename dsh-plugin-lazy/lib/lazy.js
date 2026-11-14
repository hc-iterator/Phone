/**
 * dsh-plugin-lazy · 核心逻辑（不依赖 ctx，便于自测）
 * ================================================================
 * 运行时装卸走 pluginManager.setPluginEnabled(entryId, enabled)：
 *   - 返回 application='applied' 才是真正生效；
 *   - 'restart-required' 必须如实回报"需重启"，不许假装卸载。
 *
 * 保护：
 *   - denyPrefixes（默认 @deepseek-ai/）一律拒；
 *   - 插件不能卸载自己；
 *   - 只有配置了工具前缀映射（pluginTools）的插件才参与自动卸载，避免误伤；
 *   - 会话忙时整轮跳过自动卸载。
 */

export const DEFAULT_IDLE_MIN = 30;
export const RESULT_APPLIED = 'applied';
export const RESULT_RESTART = 'restart-required';

export function createLazyCore(options) {
  const {
    listPlugins,
    setPluginEnabled,
    log = () => {},
    now = () => Date.now(),
    pluginTools = {},
    denyPrefixes = ['@deepseek-ai/'],
    selfNames = ['@local/dsh-plugin-lazy'],
    idleMinutes = DEFAULT_IDLE_MIN,
  } = options;

  /** moduleName → 最近一次工具调用时间 */
  const lastUsed = new Map();
  /** entryId 正在处理中，防并发重复 */
  const inFlight = new Set();
  /** 本回合用过的插件 */
  const usedThisTurn = new Set();
  /** 续命登记：moduleName → { mode:'turns'|'minutes', remaining?, expiresAt? } */
  const keeps = new Map();

  const isDenied = (moduleName) => denyPrefixes.some((p) => String(moduleName).startsWith(p));
  const isSelf = (moduleName) => selfNames.includes(String(moduleName));

  /** 工具名 → 归属插件（最长前缀匹配）。 */
  function ownerOfTool(toolName) {
    const name = String(toolName || '');
    let best = '';
    let bestPrefix = '';
    for (const [mod, prefixes] of Object.entries(pluginTools)) {
      for (const prefix of prefixes || []) {
        if (name.startsWith(prefix) && prefix.length > bestPrefix.length) {
          best = mod;
          bestPrefix = prefix;
        }
      }
    }
    return best;
  }

  function markUsed(toolName) {
    const mod = ownerOfTool(toolName);
    if (!mod) return '';
    lastUsed.set(mod, now());
    usedThisTurn.add(mod);
    return mod;
  }

  /** 续命：turns=N 保留接下来 N 个回合结束；minutes=N 保留到到期。 */
  function keep(id, { turns, minutes } = {}) {
    const mod = String(id || '').trim();
    if (!mod) return { ok: false, text: 'id 不能为空' };
    if (Number(minutes) > 0) {
      const expiresAt = now() + Number(minutes) * 60_000;
      keeps.set(mod, { mode: 'minutes', expiresAt });
      log(`keep ${mod} minutes=${Number(minutes)} until ${new Date(expiresAt).toISOString()}`);
      return { ok: true, text: `${mod} 续命 ${Number(minutes)} 分钟` };
    }
    const n = Number(turns) > 0 ? Math.floor(Number(turns)) : 1;
    keeps.set(mod, { mode: 'turns', remaining: n });
    log(`keep ${mod} turns=${n}`);
    return { ok: true, text: `${mod} 续命 ${n} 个回合` };
  }

  function keepActive(mod) {
    const k = keeps.get(mod);
    if (!k) return false;
    if (k.mode === 'minutes') {
      if (now() >= k.expiresAt) { keeps.delete(mod); return false; }
      return true;
    }
    return (k.remaining || 0) > 0;
  }

  function keepInfo(mod) {
    const k = keeps.get(mod);
    if (!k) return null;
    if (k.mode === 'minutes') {
      if (now() >= k.expiresAt) return null;
      return { mode: 'minutes', expiresAt: new Date(k.expiresAt).toISOString() };
    }
    return { mode: 'turns', remaining: k.remaining };
  }

  /**
   * 回合结束：卸载"本轮没用过、没续命、不是保护/核心"的插件。
   * 先算 keeps 快照，再递减 turns 型续命。
   */
  async function endTurn() {
    const listNow = await entries();
    const keptNow = new Set();
    const unloaded = [];
    for (const e of listNow) {
      if (!Object.prototype.hasOwnProperty.call(pluginTools, e.moduleName)) continue;
      if (keepActive(e.moduleName)) keptNow.add(e.moduleName);
    }
    for (const e of listNow) {
      if (!e.enabled) continue;
      if (!Object.prototype.hasOwnProperty.call(pluginTools, e.moduleName)) continue;
      if (isDenied(e.moduleName) || isSelf(e.moduleName)) continue;
      if (keptNow.has(e.moduleName)) continue;
      if (usedThisTurn.has(e.moduleName)) continue;
      const r = await unload(e.moduleName);
      unloaded.push({ moduleName: e.moduleName, ok: r.ok, reason: r.reason });
    }
    // turns 型续命在本回合结束后递减（本轮已被保留）
    for (const [mod, k] of [...keeps.entries()]) {
      if (k.mode !== 'turns') continue;
      k.remaining = Math.max(0, (k.remaining || 0) - 1);
      if (k.remaining === 0) {
        keeps.delete(mod);
        log(`keep expired ${mod}`);
      } else {
        keeps.set(mod, k);
      }
    }
    usedThisTurn.clear();
    if (unloaded.length) log(`turn-end unloaded ${unloaded.map((u) => u.moduleName).join(',')}`);
    return { skipped: null, unloaded, kept: [...keptNow] };
  }

  async function entries() {
    try {
      const list = await listPlugins();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function findEntry(list, id) {
    const raw = String(id || '').trim();
    if (!raw) return undefined;
    return list.find((e) => String(e.entryId) === raw || String(e.moduleName) === raw || String(e.patchId) === raw);
  }

  async function list() {
    const list = await entries();
    return list.map((e) => ({
      entryId: e.entryId,
      moduleName: e.moduleName,
      enabled: e.enabled,
      phase: e.fiberPhase,
      hasTools: Object.prototype.hasOwnProperty.call(pluginTools, e.moduleName),
      lastUsedAt: lastUsed.has(e.moduleName) ? new Date(lastUsed.get(e.moduleName)).toISOString() : null,
      keep: keepInfo(e.moduleName),
      protected: isDenied(e.moduleName) ? 'core' : (isSelf(e.moduleName) ? 'self' : null),
    }));
  }

  async function toggle(id, enabled, { force = false, userConfirmed = false } = {}) {
    const listNow = await entries();
    const entry = findEntry(listNow, id);
    if (!entry) return { ok: false, reason: 'not-found', text: `找不到插件条目：${id}` };
    if (isSelf(entry.moduleName)) return { ok: false, reason: 'self', text: '插件不能卸载/重载自己' };
    if (!enabled && isDenied(entry.moduleName) && !(force && userConfirmed)) {
      return { ok: false, reason: 'core', text: `${entry.moduleName} 属于核心包，默认拒绝（需 force + 用户确认）` };
    }
    if (inFlight.has(String(entry.entryId))) return { ok: false, reason: 'inflight', text: `${entry.entryId} 正在处理中，忽略重复请求` };

    inFlight.add(String(entry.entryId));
    try {
      const result = await setPluginEnabled(entry.entryId, enabled);
      const application = result && result.application;
      if (application === RESULT_APPLIED) {
        log(`${enabled ? 'load' : 'unload'} ok ${entry.moduleName} (${entry.entryId})`);
        if (enabled) lastUsed.set(entry.moduleName, now());
        return { ok: true, reason: 'applied', text: `已${enabled ? '装回' : '卸载'}：${entry.moduleName}` };
      }
      if (application === RESULT_RESTART) {
        log(`${enabled ? 'load' : 'unload'} restart-required ${entry.moduleName}`);
        return {
          ok: false,
          reason: 'restart-required',
          text: `${entry.moduleName} 的${enabled ? '装回' : '卸载'}需要重启才生效（当前运行期未变化）`,
        };
      }
      log(`${enabled ? 'load' : 'unload'} failed ${entry.moduleName} :: ${application || 'unknown'}`);
      return { ok: false, reason: 'failed', text: `操作失败：${(result && result.error && result.error.code) || application || 'unknown'}` };
    } catch (err) {
      log(`${enabled ? 'load' : 'unload'} threw ${entry.moduleName} :: ${err && err.message ? err.message : String(err)}`);
      return { ok: false, reason: 'threw', text: `调用失败：${err && err.message ? err.message : String(err)}` };
    } finally {
      inFlight.delete(String(entry.entryId));
    }
  }

  const unload = (id, opts) => toggle(id, false, opts);
  const load = (id) => toggle(id, true, {});

  /** 自动卸载：忙则跳过；只处理有工具映射且超时的插件。 */
  async function sweep({ busy = false } = {}) {
    if (busy) { log('sweep skipped: session busy'); return { skipped: 'busy', unloaded: [] }; }
    const listNow = await entries();
    const unloaded = [];
    const cutoff = now() - idleMinutes * 60_000;
    for (const e of listNow) {
      if (!e.enabled) continue;
      if (!Object.prototype.hasOwnProperty.call(pluginTools, e.moduleName)) continue; // 无映射=不计时
      if (isDenied(e.moduleName) || isSelf(e.moduleName)) continue;
      const used = lastUsed.get(e.moduleName);
      if (used === undefined) continue; // 从未用过 → 不触发
      if (used > cutoff) continue;
      const r = await unload(e.moduleName);
      unloaded.push({ moduleName: e.moduleName, ok: r.ok, reason: r.reason });
    }
    if (unloaded.length) log(`sweep unloaded ${unloaded.map((u) => u.moduleName).join(',')}`);
    return { skipped: null, unloaded };
  }

  return { list, unload, load, sweep, markUsed, ownerOfTool, keep, endTurn, keepInfo, _lastUsed: lastUsed, _inFlight: inFlight, _keeps: keeps, _usedThisTurn: usedThisTurn };
}
