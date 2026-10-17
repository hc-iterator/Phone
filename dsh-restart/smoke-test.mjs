import { apply } from './index.js';
let tool = null, prompted = 0, sectioned = 0;
const ctx = {
  effect: (cb) => { const r = cb(); return typeof r === 'function' ? r : () => {}; },
  tools: { register: (d) => { tool = d; return () => {}; } },
  inject: (names, cb) => {
    if (names.includes('sessionController')) cb({ sessionController: { prompt: () => { prompted++; } } });
    if (names.includes('systemPrompt')) cb({ systemPrompt: { section: () => { sectioned++; } } });
  },
};
apply(ctx, {});
console.log('tool=' + (tool && tool.name) + ' exec=' + typeof (tool && tool.execute) + ' prompted=' + prompted + ' sectioned=' + sectioned);
console.log(tool && tool.name === 'dsh_restart' ? 'SMOKE-OK' : 'SMOKE-FAIL');
