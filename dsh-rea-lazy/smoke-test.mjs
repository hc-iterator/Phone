import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href);
const GROUPS = mod.__test.GROUPS;
const GROUP_KEYS = Object.keys(GROUPS);
const allNames = [...new Set(GROUP_KEYS.flatMap((k) => GROUPS[k].tools))];
const calls = [];
const mcp = { client: { callTool: async ({ name, arguments: a }) => { calls.push({ name, a }); return { content: [{ type: 'text', text: 'ok:' + name }] }; } }, tools: new Map(allNames.map((n) => [n, { description: 'd:' + n, inputSchema: { type: 'object', properties: {} } }])) };
mod.__test.setMcp(mcp);
const defs = {}; const registered = new Map(); let seq = 0;
const fakeTools = {
  register: (d) => { defs[d.name] = d; const id = ++seq; registered.set(d.name, id); return () => { if (registered.get(d.name) === id) registered.delete(d.name); }; },
  guard: () => () => {},
};
const agent = { id: 'sess-rea', ctx: { tools: fakeTools } };
const ctx = { effect: (fn) => fn(), tools: fakeTools, systemPrompt: { section: () => {}, getSectionOrder: () => 0 } };
await mod.apply(ctx, { idleMs: 80, sweepMs: 10, maxAgeMs: 10000, thirdPartyDir: '' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ck = (l, ok, x = '') => { console.log((ok ? '✓ ' : '✗ ') + l + (x ? '   ' + x : '')); if (!ok) fails++; };

ck('注册 3 个管理工具', ['tools_catalog','tools_load','tools_unload'].every((n) => defs[n]));
ck('20 组', GROUP_KEYS.length === 20, String(GROUP_KEYS.length));
const cat = await defs.tools_catalog.execute({}, { agent });
ck('catalog 列 20 组', GROUP_KEYS.every((k) => cat.text.includes(k)));
ck('catalog 总计 207', /连上后共 207 个工具/.test(cat.text), cat.text.split('\n')[0]);
const catG = await defs.tools_catalog.execute({ group: 'fn-analysis', limit: 5 }, { agent });
ck('catalog{group} 分页', /共 23 个/.test(catG.text) && /下一页/.test(catG.text));
const l1 = await defs.tools_load.execute({ group: 'fn-analysis' }, { agent });
ck('load 组：新注册 23', l1.ok && /新注册 23 个/.test(l1.text), l1.text.replace(/\n/g,' ').slice(0,50));
const l2 = await defs.tools_load.execute({ group: 'fn-analysis' }, { agent });
ck('重复 load 幂等（新注册 0）', /新注册 0 个/.test(l2.text), l2.text.replace(/\n/g, ' '));
const l3 = await defs.tools_load.execute({ group: 'xrefs' }, { agent });
ck('load 第二组（跨组工具不重复注册）', l3.ok && /新注册 \d+ 个/.test(l3.text), l3.text.replace(/\n/g, ' '));
const before = registered.size;
const u1 = await defs.tools_unload.execute({ group: 'xrefs' }, { agent });
ck('unload 引用计数：仍被 fn-analysis 引用的保留', registered.size > 0 && registered.size <= before, before + '→' + registered.size);
const t1 = await defs.tools_load.execute({ tool: 'binary_overview' }, { agent });
ck('按单工具加载', t1.ok && registered.has('binary_overview'));
const t2 = await defs.tools_load.execute({ group: 'compare', tools: ['binary_overview'] }, { agent });
ck('组+单工具混合', t2.ok, t2.text.replace(/\n/g, ' ').slice(0, 60));
await sleep(250);
ck('自动回收（reloaded 组清空，管理工具保留 3）', registered.size === 3, String(registered.size));

console.log(fails === 0 ? '\nRESULT: ALL PASS ✓' : '\nRESULT: ' + fails + ' FAILED ✗');
process.exit(fails === 0 ? 0 : 1);
