/**
 * 离线冒烟：dsh-tool-lazy 的 catalog / load / unload。
 * 伪造 ctx（schemas + restrict），不依赖 DSH 运行时。
 * 运行：node smoke-test.mjs   （退出码 0 = 全过）
 */
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href);

const defs = {};
const restricts = [];
const ctx = {
  effect: (fn) => fn(),
  tools: {
    register: (definition) => { defs[definition.name] = definition; return () => {}; },
    schemas: () => ['pico_status', 'pico_build', 'gui_capture', 'gui_click', 'rea_search', 'read', 'write'].map((name) => ({ name })),
    restrict: (filter) => { restricts.push(filter); return () => {}; },
  },
};
await mod.apply(ctx);
const agent = { id: 'sess-x' };
let failures = 0;
const check = (label, ok, extra = '') => {
  console.log((ok ? '✓ ' : '✗ ') + label + (extra ? '   ' + extra : ''));
  if (!ok) failures += 1;
};

check('注册 3 个工具', Object.keys(defs).sort().join(',') === 'tools_catalog,tools_load,tools_unload', Object.keys(defs).join(','));

const cat0 = await defs.tools_catalog.execute({}, { agent });
check('初始全为未加载', /pico\s+未加载\s+2/.test(cat0.text) && /gui\s+未加载\s+2/.test(cat0.text) && /rea\s+未加载\s+1/.test(cat0.text), cat0.text.split('\n')[1]);

const load = await defs.tools_load.execute({ group: 'pico' }, { agent });
const f1 = restricts.at(-1) ?? {};
check('load pico 成功', load.ok === true);
check('load 后 deny 不含 pico_*', !(f1.deny ?? []).some((n) => n.startsWith('pico_')), JSON.stringify(f1));
check('load 后 deny 含 gui_/rea_', (f1.deny ?? []).includes('gui_capture') && (f1.deny ?? []).includes('rea_search'));

const cat1 = await defs.tools_catalog.execute({}, { agent });
check('catalog 显示 pico 已加载', /pico\s+已加载\s+2/.test(cat1.text), cat1.text.split('\n')[1]);

const un = await defs.tools_unload.execute({ group: 'pico' }, { agent });
const f2 = restricts.at(-1) ?? {};
check('unload pico 成功', un.ok === true);
check('unload 后 deny 重新含 pico_*', (f2.deny ?? []).includes('pico_status'), JSON.stringify(f2));

const bad = await defs.tools_load.execute({ group: 'nope' }, { agent });
check('未知组被拒', bad.ok === false);

const rea = await defs.tools_load.execute({ group: 'rea' }, { agent });
check('rea 有工具时可加载', rea.ok === true, String(rea.text).slice(0, 50));
const f3 = restricts.at(-1) ?? {};
check('加载 rea 后 deny 不含 rea_*', !(f3.deny ?? []).some((n) => n.startsWith('rea_')), JSON.stringify(f3.deny));

console.log(failures === 0 ? '\nRESULT: ALL PASS ✓' : '\nRESULT: ' + failures + ' FAILED ✗');
process.exit(failures === 0 ? 0 : 1);
