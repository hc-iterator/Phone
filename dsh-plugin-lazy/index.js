/**
 * dsh-plugin-lazy · 插件级懒加载
 * ================================================================
 * 三件事：
 *   1. plugin_list              看当前挂载条目（含是否有工具、最后使用时间、是否受保护）
 *   2. plugin_unload / plugin_load  运行时卸载 / 装回（pluginManager.setPluginEnabled）
 *   3. 自动卸载：有工具映射且 N 分钟（默认 30）未用 ⇒ 卸载；忙时整轮跳过
 *
 * 日志：%TEMP%\dsh-plugin-lazy\log.txt
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLazyCore, DEFAULT_IDLE_MIN } from './lib/lazy.js';

export const name = '@local/dsh-plugin-lazy';
export const inject = { tools: { required: true }, pluginManager: { required: false }, timer: { required: false } };

const LOG_FILE = path.join(os.tmpdir(), 'dsh-plugin-lazy', 'log.txt');

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 默认工具前缀映射；可用 config.pluginTools 覆盖/追加。 */
const DEFAULT_PLUGIN_TOOLS = {
  '@local/dsh-admin-gate': ['pm_', 'gate_'],
  '@local/dsh-gui': ['gui_'],
  '@local/dsh-picophone': ['pico_'],
  '@local/dsh-restart': ['dsh_restart', 'dsh_wake_session', 'allowdshrestarting', 'stopdshfromrestarting'],
  '@local/dsh-memory': ['mem_'],
  '@local/dsh-projectdb': ['proj_'],
  '@local/dsh-search': ['search_'],
  '@local/dsh-timer': ['timer_'],
  '@local/dsh-session-gc': ['session_gc_'],
};

const render = (v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v) }];
const output = { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => render(v) };

export function apply(ctx, config = {}) {
  const pluginTools = { ...DEFAULT_PLUGIN_TOOLS, ...(config.pluginTools || {}) };
  const idleMinutes = Number(config.idleMinutes) > 0 ? Number(config.idleMinutes) : DEFAULT_IDLE_MIN;

  const pm = ctx.get ? ctx.get('pluginManager') : undefined;
  if (!pm || typeof pm.setPluginEnabled !== 'function') {
    log('apply: pluginManager 不可用 -> 只读模式');
  }

  /*
   * 2026-11-13 用户反馈：收缩（自动卸载）把"任何时候都会用到"的插件也卸了，
   * 导致 dsh_wake_session / gate_* 等工具突然消失。这里把这一类列进"永不卸载"：
   * 核心包以外，凡是项目治理/通信/恢复链路上的 @local 插件都保护起来。
   */
  const denylist = [
    '@deepseek-ai/',
    '@local/dsh-agent-bus',
    '@local/dsh-admin-gate',
    '@local/dsh-restart',
    '@local/dsh-session-resume',
    '@local/dsh-tool-lazy',
    '@local/dsh-plugin-lazy',
    '@local/dsh-working-state',
    '@local/dsh-memdb',
    '@local/dsh-projectdb',
    '@local/dsh-auto-compact',
  ];

  const core = createLazyCore({
    listPlugins: () => (pm && typeof pm.listPlugins === 'function' ? pm.listPlugins() : []),
    setPluginEnabled: (id, enabled) => {
      if (!pm || typeof pm.setPluginEnabled !== 'function') throw new Error('pluginManager 不可用，无法运行时装卸');
      return pm.setPluginEnabled(id, enabled);
    },
    pluginTools,
    idleMinutes,
    denyPrefixes: denylist,
    log,
  });

  const listTool = {
    name: 'plugin_list',
    description: 'List mounted plugin entries with tool ownership, last-used time and protection status.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output,
    async execute() {
      const items = await core.list();
      const lines = items.map((e) => `- ${e.moduleName} [${e.entryId}] enabled=${e.enabled} phase=${e.phase} tools=${e.hasTools ? 'yes' : 'no'} lastUsed=${e.lastUsedAt || '-'}${e.protected ? ' (' + e.protected + ')' : ''}`);
      return { ok: true, count: items.length, items, text: `已挂载 ${items.length} 条：\n${lines.join('\n')}` };
    },
  };

  const unloadTool = {
    name: 'plugin_unload',
    description: 'Unload one plugin at runtime (config kept). Core @deepseek-ai packages and this plugin itself are refused unless force+user confirmation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'entryId, patchId or module name.' },
        force: { type: 'boolean', description: 'Allow unloading a core package (needs userConfirmed too).' },
        userConfirmed: { type: 'boolean', description: 'The user explicitly confirmed this risky unload.' },
      },
      required: ['id'],
    },
    output,
    async execute(args) {
      const r = await core.unload(args.id, { force: args.force === true, userConfirmed: args.userConfirmed === true });
      log(`plugin_unload ${args.id} -> ${r.reason}: ${r.text}`);
      return { ok: r.ok, reason: r.reason, text: r.text };
    },
  };

  const loadTool = {
    name: 'plugin_load',
    description: 'Load one previously unloaded plugin back at runtime.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: 'entryId, patchId or module name.' } },
      required: ['id'],
    },
    output,
    async execute(args) {
      const r = await core.load(args.id);
      log(`plugin_load ${args.id} -> ${r.reason}: ${r.text}`);
      return { ok: r.ok, reason: r.reason, text: r.text };
    },
  };

  const keepTool = {
    name: 'plugin_keep',
    description: 'Keep one plugin loaded across the next N turns (default 1) or for N minutes; otherwise it is unloaded when the turn ends.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Plugin module name or entryId.' },
        turns: { type: 'number', description: 'Keep for the next N turns (default 1).' },
        minutes: { type: 'number', description: 'Keep for N minutes instead of turns.' },
      },
      required: ['id'],
    },
    output,
    async execute(args) {
      const r = core.keep(args.id, { turns: args.turns, minutes: args.minutes });
      log(`plugin_keep ${args.id} turns=${args.turns ?? '-'} minutes=${args.minutes ?? '-'} -> ${r.ok ? 'ok' : 'fail'}`);
      return { ok: r.ok, text: r.text };
    },
  };

  for (const def of [listTool, unloadTool, loadTool, keepTool]) {
    ctx.effect(() => ctx.tools.register(def), `dsh-plugin-lazy: ${def.name}`);
  }
  log(`apply: tools registered; pluginManager=${pm ? 'yes' : 'no'} idleMinutes=${idleMinutes}`);

  // 回合结束（agent 转 idle）⇒ 卸载本轮未用且未续命的插件
  try {
    ctx.effect(() => ctx.on('agent/status', async (payload) => {
      try {
        const status = payload && payload.status;
        if (status !== 'idle') return;
        const r = await core.endTurn();
        if (r && r.unloaded && r.unloaded.length) {
          log(`turn-end: unloaded ${r.unloaded.map((u) => u.moduleName).join(',')}`);
        }
      } catch (err) {
        log(`turn-end THREW ${err && err.message ? err.message : String(err)}`);
      }
    }), 'dsh-plugin-lazy: turn-end unloader');
    log('apply: turn-end unloader installed');
  } catch (err) {
    log(`apply: turn-end listener THREW ${err && err.message ? err.message : String(err)}`);
  }

  // 记录使用：工具执行前按前缀归属到插件
  try {
    ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
      try { core.markUsed(exec && exec.name); } catch { /* ignore */ }
      return next();
    }), 'dsh-plugin-lazy: usage tracker');
  } catch (err) {
    log(`apply: usage tracker THREW ${err && err.message ? err.message : String(err)}`);
  }

  // 自动卸载：每 60 秒一轮；会话忙则跳过
  try {
    const timer = setInterval(async () => {
      try {
        const sc = ctx.get ? ctx.get('sessionController') : undefined;
        let busy = false;
        if (sc && typeof sc.list === 'function') {
          const r = await sc.list({});
          busy = !!r && Array.isArray(r.items) && r.items.some((s) => s && s.running === true);
        }
        await core.sweep({ busy });
      } catch (err) {
        log(`sweep THREW ${err && err.message ? err.message : String(err)}`);
      }
    }, 60_000);
    if (timer.unref) timer.unref();
    ctx.effect(() => () => clearInterval(timer), 'dsh-plugin-lazy: sweeper');
    log('apply: sweeper started');
  } catch (err) {
    log(`apply: sweeper THREW ${err && err.message ? err.message : String(err)}`);
  }
}

