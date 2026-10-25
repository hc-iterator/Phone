// 工具装配件：定义形状 + 注册时的统一包装（记下 exec.agent 供审批用）。
// 与拆分前唯一的差别：tool() 的第 5 个参数直接收 op 函数（原先收 opName 再查 OPS 表，表里是同一批函数）。

// ---------------------------------------------------------------- 工具定义

export const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

export const BOARD_ENUM = ['dut', 'probe', 'sampler'];

export function tool(cfg, name, description, parameters, op) {
  return {
    name: `pico_${name}`,
    description,
    parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) },
      ],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? cfg.agentsService?.currentInitiator?.()?.id ?? null;
      return await op(cfg, args ?? {}, { sessionId });
    },
  };
}

/**
 * 注册一个工具定义。
 * 下面的包装与 ctx.effect 用法原样搬自 apply() 里那段 for 循环 —— 只记不拦：
 * 绝不改参数、绝不吞异常；拦/放仍由信任门自己决定。
 */
export function registerDefinition(ctx, cfg, definition) {

    // 【审批用】每次工具调用都记下它的 exec 上下文 —— `approval.request` 必须带 agent 才发得出去。
    // 只记不拦：绝不改参数、绝不吞异常；拦/放仍由信任门自己决定。
    // 拿不到 agent 时 cfg.currentAgent 保持原样（最终为 undefined）⇒ 审批报 'unavailable' ⇒ 拒绝（fail-closed）。
    const inner = definition.execute;
    if (typeof inner === 'function') {
      definition.execute = async (args, exec) => {
        if (exec && exec.agent) cfg.currentAgent = exec.agent;
        return inner.call(definition, args, exec);
      };
    }
    ctx.effect(() => ctx.tools.register(definition), `dsh-picophone: ${definition.name}`);

  return definition;
}
