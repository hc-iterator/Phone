/**
 * 跨模块共享的可变状态 —— 拆分前是 index.js 顶层的两个 let。
 * ESM 的 import 绑定是只读的，所以收进一个对象；读写点与语义与拆分前完全一致。
 */

export const state = {

  // 子进程要用的 PATH 前缀：系统 PATH 里没有 ninja / openocd / arm-none-eabi-* / vswhere，
  // 而它们都躺在 ~\.pico-sdk 与 VS 安装目录下 ⇒ 由 resolveConfig 补上，否则 pico_exec 会 ENOENT。
  toolPathPrefix: '',

  // 由 apply() 填：{ shell, workspaceRoot }
  sandboxContext: null,

};
