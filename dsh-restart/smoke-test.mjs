import { apply, inject } from './index.js';
let registered = null, sectioned = false;
const ctx = {
  effect: (cb, label) => { const r = cb(); return typeof r === 'function' ? r : () => {}; },
  tools: { register: (def) => { registered = def; return () => {}; } },
  inject: (names, cb) => { cb({ systemPrompt: { section: (s) => { sectioned = true; return () => {}; } } }); },
};
apply(ctx, {});
if (!registered) { console.log('FAIL: 没注册工具'); process.exit(1); }
const ok = registered.name === 'dsh_restart' && typeof registered.execute === 'function' && registered.parameters && registered.output && typeof registered.output.render === 'function';
console.log('inject=' + JSON.stringify(inject));
console.log('tool=' + registered.name + '  execute=' + typeof registered.execute + '  output.render=' + typeof registered.output.render);
console.log('systemPrompt.section 被调用=' + sectioned);
console.log(ok ? 'SMOKE-OK' : 'SMOKE-FAIL');
