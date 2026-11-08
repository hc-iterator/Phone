/**
 * 离线冒烟：dsh-tool-lazy（分组 / load / unload / 自动回收）。
 */
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href);

const NAMES = ['rea_disasm_func','rea_decompil_pseudo','rea_elf_section','rea_strings_extract','timer_countdown','timer_now','read','write'];
const defs = {}; const restricts = []; const guards = [];
const fakeTools = {
  register: (d) => { defs[d.name] = d; return () => {}; },
  schemas: () => NAMES.map((name) => ({ name })),
  restrict: (filter) => { restricts.push(filter); return () => {}; },
  guard: (fn) => { guards.push(fn); return () => {}; },
};
const ctx = { effect: (fn) => fn(), tools: fakeTools, systemPrompt: { section: () => {}, getSectionOrder: () => 0 } };
await mod.apply(ctx, { idleMs: 60, sweepMs: 10, maxAgeMs: 10000 });

const agent = { id: 'sess-x', ctx: { tools: { guard: fakeTools.guard } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, extra = '') => { console.log((ok ? '✓ ' : '✗ ') + label + (extra ? '   ' + extra : '')); if (!ok) failures += 1; };

check('注册 3 个工具', Object.keys(defs).sort().join(',') === 'tools_catalog,tools_load,tools_unload');

const cat0 = await defs.tools_catalog.execute({}, { agent });
check('catalog: rea-disasm=2 / rea-binary=1 / rea-strings=1',
  /rea-disasm\s+未加载\s+2/.test(cat0.text) && /rea-binary\s+未加载\s+1/.test(cat0.text) && /rea-strings\s+未加载\s+1/.test(cat0.text),
  cat0.text.split('\n')[1]);
check('catalog 不含 probe（测试组不进目录）', !/probe/.test(cat0.text));

const load = await defs.tools_load.execute({ group: 'probe' }, { agent });
const f1 = restricts.at(-1) ?? {};
check('load probe 成功', load.ok === true, String(load.text).slice(0, 40));
check('load probe 后 deny 含 rea_* 且不含 timer_*',
  (f1.deny ?? []).some((n) => n.startsWith('rea_')) && !(f1.deny ?? []).some((n) => n.startsWith('timer_')),
  JSON.stringify(f1.deny));

const un = await defs.tools_unload.execute({ group: 'probe' }, { agent });
const f2 = restricts.at(-1) ?? {};
check('unload probe 后 deny 重新含 timer_*', un.ok === true && (f2.deny ?? []).includes('timer_now'), JSON.stringify(f2.deny));

const load2 = await defs.tools_load.execute({ group: 'rea-disasm' }, { agent });
const f3 = restricts.at(-1) ?? {};
check('load rea-disasm：只放行 disasm 关键字',
  load2.ok === true && !(f3.deny ?? []).includes('rea_disasm_func') && (f3.deny ?? []).includes('rea_elf_section'),
  JSON.stringify(f3.deny));

await sleep(200);
const cat1 = await defs.tools_catalog.execute({}, { agent });
check('自动回收：等待 > idleMs 后 rea-disasm 变回未加载', /rea-disasm\s+未加载/.test(cat1.text), cat1.text.split('\n')[1]);
check('guard 已注册', guards.length >= 1, 'guards=' + guards.length);

console.log(failures === 0 ? '\nRESULT: ALL PASS ✓' : '\nRESULT: ' + failures + ' FAILED ✗');
process.exit(failures === 0 ? 0 : 1);
