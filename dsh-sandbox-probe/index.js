/**
 * dsh-sandbox-probe —— 临时诊断插件（用完就卸）。
 *
 * 只回答一个问题：**插件能不能要求 ctx.shell 按我显式指定的 sandboxPolicy 执行**，
 * 以及在该策略下：工具链能不能跑、能写哪里、写窗口之外是不是被系统拒。
 *
 * 关键 API（来自 cordis_inspect_query 的 shell 服务契约）：
 *   ctx.shell.resolve({ command, workdir, sandboxPolicy }) -> ShellExecSpec
 *   ctx.shell.execute(spec) -> ShellExecution
 *   await exec.result() -> { exitCode, stdout, stderr, sandbox: { mode, denied, enforcement, runnerFailed } }
 */
export const name = 'dsh-sandbox-probe';
export const inject = ['shell', 'tools'];

export function apply(ctx, config) {
  const workspaceRoot = String(config?.workspaceRoot ?? 'C:\\Users\\Chen\\Desktop\\Pico\\PicoPhone');

  ctx.tools.register({
    name: 'probe_sandbox',
    description:
      'Temporary diagnostic: run one command through ctx.shell under an explicit sandbox policy and report whether that policy was honoured. Remove the dsh-sandbox-probe bundle when finished.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'The command to run (executed by the profile shell runner).' },
        mode: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: 'Sandbox mode to request; default workspace-write.',
        },
        workdir: { type: 'string', description: 'Working directory; default the probe workspace root.' },
      },
    },
    timeoutMs: 180000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const mode = String(args.mode ?? 'workspace-write');
      const workdir = String(args.workdir ?? workspaceRoot);
      let spec;
      try {
        spec = ctx.shell.resolve({
          command: String(args.command),
          workdir,
          sandboxPolicy: { mode, workspaceRoot },
        });
      } catch (error) {
        return { ok: false, text: `resolve 失败: ${error && error.message ? error.message : error}`, stage: 'resolve' };
      }
      const requested = spec?.sandboxPolicy ? JSON.stringify(spec.sandboxPolicy) : '(spec 里没有 sandboxPolicy)';
      let execution;
      try {
        execution = await ctx.shell.execute(spec);
      } catch (error) {
        return { ok: false, text: `execute 失败: ${error && error.message ? error.message : error}\nrequested=${requested}`, stage: 'execute' };
      }
      const result = await execution.result();
      const sb = result.sandbox ?? null;
      const text = [
        `command      : ${args.command}`,
        `requested    : mode=${mode} workspaceRoot=${workspaceRoot}`,
        `spec.policy  : ${requested}`,
        `exit         : ${result.exitCode}  timedOut=${result.timedOut}  aborted=${result.aborted}`,
        `sandbox      : ${sb ? JSON.stringify(sb) : '(结果里没有 sandbox 字段)'}`,
        `stdout       : ${(result.stdout?.text ?? '').trim().slice(0, 500) || '(空)'}`,
        `stderr       : ${(result.stderr?.text ?? '').trim().slice(0, 500) || '(空)'}`,
      ].join('\n');
      return { ok: result.exitCode === 0, text, sandbox: sb, spec: spec?.sandboxPolicy ?? null, exitCode: result.exitCode };
    },
  });
}
