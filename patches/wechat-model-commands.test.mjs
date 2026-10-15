// wechat-model-commands.test.mjs —— 微信插件 /models 与 /model 的桩网关单测（可重跑）
// 用法: node wechat-model-commands.test.mjs
// 期望: 五条路径全绿（看当前 / 列表 / 按编号切 / 写全切 / 越界提示），selectModel 参数正确
import { SessionRouter } from 'file:///C:/固态盘秘钥/.dsh/profiles/web/node_modules/dsh-wechat-plugin/dist/core/lib/index.js';
const calls = [];
const gateway = {
  modelList: async () => ([
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', label: '官方' },
    { provider: 'moonshotai-cn', model: 'kimi-k2.7-code', label: 'Kimi' },
    { provider: 'our-free-model', model: 'openai/gpt-oss-20b', label: '免费池' },
  ]),
  currentModel: async () => ({ provider: 'moonshotai-cn', model: 'kimi-k2.7-code' }),
  selectModel: async (sid, p, m) => { calls.push([sid, p, m]); return {}; },
  ensureSession: async () => {}, listSessions: async () => [], listOwnSessions: async () => [],
  createSession: async () => {}, cancel: async () => {},
};
let bindings = { c1: { conversationId: 'c1', accountId: 'a1', peerId: 'p1', sessionId: 'session-aaaaaaaa-bbbb', title: 'T', lastUsedAt: Date.now() } };
// store.load() 必须直接返回绑定表（router: this.#bindings ??= await this.#store.load()）
const store = { load: async () => bindings, save: async (b) => { bindings = b; } };
const router = new SessionRouter({ gateway, store });
const params = { conversationId: 'c1', accountId: 'a1', peerId: 'p1' };
const show = (label, r) => console.log('--- ' + label + ' ---\n' + ((r && r.text) ? r.text : JSON.stringify(r)).slice(0, 400));
show('/model（看当前）', await router.route({ ...params, text: '/model' }));
show('/models', await router.route({ ...params, text: '/models' }));
show('/model 2（按编号）', await router.route({ ...params, text: '/model 2' }));
show('/model our-free-model/openai/gpt-oss-20b（写全）', await router.route({ ...params, text: '/model our-free-model/openai/gpt-oss-20b' }));
show('/model 99（越界）', await router.route({ ...params, text: '/model 99' }));
console.log('selectModel 实际调用: ' + JSON.stringify(calls));