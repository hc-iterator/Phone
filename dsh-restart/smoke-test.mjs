import { apply } from './index.js';
let tool = null, prompted = 0, sectioned = 0, cmd = null;
const ctx = {
  effect: (cb) => { const r = cb(); return typeof r === 'function' ? r : () => {}; },
  tools: { register: (d) => { tool = d; return () => {}; } },
  inject: (names, cb) => {
    if (names.includes('sessionController')) cb({ sessionController: { prompt: () => { prompted++; } } });
    if (names.includes('systemPrompt')) cb({ systemPrompt: { section: () => { sectioned++; } } });
    if (names.includes('commands')) cb({ commands: { register: (c) => { cmd = c; } } });
  },
};
apply(ctx, {});
console.log('tool=' + (tool && tool.name) + '  command=' + (cmd && cmd.name) + '  handler=' + typeof (cmd && cmd.handler) + '  sectioned=' + sectioned);
const ok = tool && tool.name === 'dsh_restart' && cmd && cmd.name === 'killdsh' && typeof cmd.handler === 'function';
console.log(ok ? 'SMOKE-OK' : 'SMOKE-FAIL');
