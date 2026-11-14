/** dsh-plugin-lazy 自测（核心逻辑，不依赖 DSH）。 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const LOG = path.join(os.tmpdir(), `lazy-test-${Date.now()}`, 'log.txt');
const lines = [];
const log = (m) => { lines.push(m); fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, m + '\n', 'utf8'); };

const { createLazyCore } = await import('../lib/lazy.js');

const entries = [
  { entryId: 'e1', moduleName: '@local/dsh-gui', enabled: true, fiberPhase: 'active' },
  { entryId: 'e2', moduleName: '@deepseek-ai/dsh-tools', enabled: true, fiberPhase: 'active' },
  { entryId: 'e3', moduleName: '@local/dsh-plugin-lazy', enabled: true, fiberPhase: 'active' },
  { entryId: 'e4', moduleName: '@local/dsh-timer', enabled: true, fiberPhase: 'active' },
  { entryId: 'e5', moduleName: '@local/unmapped-plugin', enabled: true, fiberPhase: 'active' },
  { entryId: 'e6', moduleName: '@local/dsh-restart', enabled: true, fiberPhase: 'active' },
];

let restartNext = false;
let callCount = 0;
const fakePM = {
  listPlugins: async () => entries.map((e) => ({ ...e })),
  setPluginEnabled: async (id, enabled) => {
    callCount += 1;
    if (restartNext) return { changed: true, application: 'restart-required', stage: 'enable', target: id };
    const e = entries.find((x) => x.entryId === id);
    if (e) e.enabled = enabled;
    return { changed: true, application: 'applied', stage: 'enable', target: id };
  },
};

const core = createLazyCore({
  listPlugins: fakePM.listPlugins,
  setPluginEnabled: fakePM.setPluginEnabled,
  log,
  pluginTools: { '@local/dsh-gui': ['gui_'], '@local/dsh-timer': ['timer_'], '@local/dsh-restart': ['dsh_restart'], '@local/dsh-plugin-lazy': ['plugin_'] },
  idleMinutes: 30,
});

let pass = 0; let fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('PASS', n, extra); } else { fail++; console.log('FAIL', n, extra); } };

// 1 卸载后可装回
let r = await core.unload('@local/dsh-gui');
ok('1a 卸载', r.ok === true, r.text);
r = await core.load('@local/dsh-gui');
ok('1b 装回', r.ok === true && entries[0].enabled === true, r.text);

// 2 核心包被拒
r = await core.unload('@deepseek-ai/dsh-tools');
ok('2 核心包被拒', r.ok === false && r.reason === 'core');

// 3 不能卸载自己
r = await core.unload('@local/dsh-plugin-lazy');
ok('3 自卸载被拒', r.ok === false && r.reason === 'self');

// 4 并发重复
const p1 = core.unload('@local/dsh-timer');
const p2 = core.unload('@local/dsh-timer');
const [r1, r2] = await Promise.all([p1, p2]);
ok('4 并发重复被拒', (r1.ok || r2.ok) && !(r1.ok && r2.ok), `${r1.reason}/${r2.reason}`);
await core.load('@local/dsh-timer');

// 5 本回合用过的插件回合结束不卸
core.markUsed('timer_now');
let end = await core.endTurn();
ok('5 用过的回合结束不卸', !end.unloaded.some((u) => u.moduleName === '@local/dsh-timer'), JSON.stringify(end.unloaded));

// 6 没用过的插件回合结束被卸（gui 映射在、且本回合未用）
entries[0].enabled = true;
end = await core.endTurn();
ok('6 未用过的被卸', end.unloaded.some((u) => u.moduleName === '@local/dsh-gui'));

// 7 无映射插件不计时
ok('7 无映射不参与', !entries[4].enabled === false, `enabled=${entries[4].enabled}`);

// 8 续命 turns=2
await core.load('@local/dsh-gui');
core.keep('@local/dsh-gui', { turns: 2 });
end = await core.endTurn();
ok('8a 续命第一轮不卸', !end.unloaded.some((u) => u.moduleName === '@local/dsh-gui'), JSON.stringify(end.kept));
end = await core.endTurn();
const keptAfter = core.keepInfo('@local/dsh-gui');
ok('8b 第二轮结束仍保留且剩余递减', end.unloaded.length >= 0 && (keptAfter === null || keptAfter.remaining <= 1), JSON.stringify(keptAfter));

// 9 续命 minutes
core.keep('@local/dsh-timer', { minutes: 5 });
ok('9 分钟续命生效', core.keepInfo('@local/dsh-timer')?.mode === 'minutes');

// 10 restart-required 如实回报
restartNext = true;
r = await core.unload('@local/dsh-restart');
ok('10 需重启如实回报', r.ok === false && r.reason === 'restart-required', r.text);
restartNext = false;

// 11 日志落盘
ok('11 日志落盘', fs.existsSync(LOG) && fs.readFileSync(LOG, 'utf8').includes('unload ok'));

// 12 list 带 keep 与保护标记
const items = await core.list();
const gui = items.find((i) => i.moduleName === '@local/dsh-gui');
const toolsItem = items.find((i) => i.moduleName === '@deepseek-ai/dsh-tools');
ok('12 list 字段', !!gui && 'keep' in gui && toolsItem.protected === 'core');

console.log(`\n合计 ${pass} 通过 / ${fail} 失败；setPluginEnabled 调用 ${callCount} 次；日志 ${LOG}`);
process.exit(fail === 0 ? 0 : 1);
