/**
 * dsh-restart —— 给 Agent 一个可靠重启 DSH 的能力（用户 2026-10-17 要求）
 * ======================================================================
 * 关键设计（根据实测反复修正）：
 *   · schtasks 排定 .cmd；cmd 用【绝对路径 powershell】拉起 doer（任务环境 PATH 极简）
 *   · 延迟【写死】进 cmd（老版本 -Delay %1 ⇒ 任务无参数 ⇒ MissingArgument ⇒ 从不执行）
 *   · doer 等待 → 杀 3080 → node bin.js web --no-open（不弹浏览器）→ 轮询 3080 + 插件状态
 *   · 结果写 %TEMP%\dsh_restart_result.json
 *   · 重启后把结果作为一条消息推给当初调用工具的会话 = 「发给 Agent」
 */
import * as nodeFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const inject = ['tools'];

// 2026-10-25 移植（本机）。原版把脚本放 %TEMP%，这里改到 %LOCALAPPDATA%\dsh-restart，
// 两条理由：
//   ① 安全：workspace-write 沙箱下，文件工具的可写根 = 工作区 + /tmp + tmpdir()
//      （dsh-sandbox 的 writableRoots）⇒ %TEMP% 根目录【Agent 写得到】。
//      而这几个脚本是【沙箱外执行】的，doer 还有 20~25 秒等待窗口
//      ⇒ 放 %TEMP% 等于"改脚本 = 沙箱外任意代码"，这条必须堵。
//   ② 持久：%TEMP% 会被清理，LOCALAPPDATA 不会。
const BASE_DIR = path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || 'C:\\', 'dsh-restart');
const TMP = BASE_DIR;
const LOG = TMP + '\\dsh_restart_log.txt';
const RES = TMP + '\\dsh_restart_result.json';
const REQ = TMP + '\\dsh_restart_request.json';
const MARKER = TMP + '\\dsh_restart_marker.txt';
const VBS = TMP + '\\dsh_restart_silent.vbs';
const DOER = TMP + '\\dsh_restart_doer.ps1';
const KILL_PS1_PATH = TMP + '\\dsh_killdsh.ps1';
const KILL_VBS_PATH = TMP + '\\dsh_killdsh.vbs';
// 2026-10-25 去硬编码：node 用当前进程的可执行文件；dsh 入口用"谁加载了我们"反推
// （本插件就是被 <dsh>\lib\bin.js 拉起来的）。换机自适配，不用改源码；
// 若 argv[1] 不是 bin.js（比如被测试宿主 import），退回旧路径，行为不劣化。
const NODE = process.execPath || 'C:\\Program Files\\nodejs\\node.exe';
const BIN = (typeof process.argv[1] === 'string' && process.argv[1].endsWith('bin.js'))
  ? process.argv[1]
  : 'C:\\Users\\Rain\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const PWSH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const DOER_PS1 = [
  'param([int]$Delay = 25, [switch]$DryRun)',
  "$NODE = '" + NODE + "'", "$BIN = '" + BIN + "'", "$LOG = '" + LOG + "'", "$RES = '" + RES + "'",
  'function W($m) { ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $m) | Add-Content -LiteralPath $LOG -Encoding UTF8 }',
  'function ListenerPid { $l = (netstat -ano | Select-String ":3080 .*LISTENING" | Select-Object -First 1); if ($l) { return [int](($l -replace "\s+"," ").Trim().Split(" ")[-1]) } return 0 }',
  'W ("doer start delay=" + $Delay)',
  'Start-Sleep -Seconds $Delay',
  '$oldPid = ListenerPid',
  'W ("current dsh pid=" + $oldPid)',
  'if ($DryRun) { W "dryRun: skip kill/restart"; exit 0 }',
  'if ($oldPid -gt 0) { try { Stop-Process -Id $oldPid -Force -ErrorAction Stop; W ("STOPPED pid=" + $oldPid) } catch { W ("stop failed: " + $_.Exception.Message) } }',
  'Start-Sleep -Seconds 8',
  'for ($i = 0; $i -lt 2; $i++) { try { Start-Process -FilePath $NODE -ArgumentList @($BIN, "web", "--no-open") -WindowStyle Hidden; W ("launched attempt " + ($i + 1)); break } catch { W ("launch failed: " + $_.Exception.Message); Start-Sleep -Seconds 3 } }',
  '$up = $false; $newPid = 0',
  'for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Seconds 2; $newPid = ListenerPid; if ($newPid -gt 0) { $up = $true; break } }',
  'W ("listening=" + $up + " pid=" + $newPid)',
  // 2026-10-25 移植：原版在这里轮询 http://127.0.0.1:3080/.dsh-wechat-plugin/status
  // 判活并记录账号数。本机没有那个插件（实测 404）⇒ 保留会让每次重启白等 60 秒、
  // 并把结果写成 ok=false（假故障）。改成只认「3080 重新监听」这一个真实信号。
  '$pluginOk = $null; $accts = 0',
  '$result = [ordered]@{ at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss"); up = $up; oldPid = $oldPid; newPid = $newPid; pluginEnabled = $pluginOk; accounts = $accts; ok = $up }',
  '[System.IO.File]::WriteAllText($RES, ($result | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))',
  'W ("RESULT " + ($result | ConvertTo-Json -Compress))',
  'W "doer done"'
].join('\r\n');

// 计划任务绝不能跑 .cmd：以登录用户身份运行的任务会显示控制台窗口（用户实测被弹窗多次）。
// VBScript 的 Run(cmd, 0, False) 用窗口样式 0 ⇒ 完全不创建窗口。
const vbsText = (delay) => [
  'Set sh = CreateObject("WScript.Shell")',
  'sh.Run """' + PWSH + '"" -NoProfile -ExecutionPolicy Bypass -File ""' + DOER + '"" -Delay ' + String(delay) + '", 0, False',
  'CreateObject("Scripting.FileSystemObject").CreateTextFile("' + MARKER + '", True).WriteLine "task ran " & Now'
].join('\r\n');

const PLOG = TMP + '\\dsh_restart_plugin.log';
const errText = (e) => (e && e.message ? e.message : String(e));
function plog(m) {
  try { nodeFs.appendFileSync(PLOG, new Date().toISOString() + ' ' + m + '\n', 'utf8'); }
  catch (e) {
    // 这里【不能】再调 plog（会无限递归）。退回 stderr，至少让终端里看得见"日志本身坏了"。
    try { process.stderr.write('[dsh-restart] plog failed: ' + errText(e) + ' | msg=' + m + '\n'); }
    catch (_) { /* stderr 也写不出去，只能放弃：此处任何"再记一次"的尝试都无处落笔 */ }
  }
}
// --- 失败处理约定（本轮 Agent 修的，别再退回空 catch）-------------------------
// ignore(tag, e)：真的可以忽略（best-effort 删除/清理、可选文件不存在）⇒ 记一行 'ignored'，流程照旧、不中断。
// fail(tag, e)  ：不该吞、但此处没法把错误交还给调用方（插件接线 / 定时回调）⇒ 记一行 'FAILED'。
// 只写日志、绝不抛：记日志这件事自己失败，不能再连锁弄死调用方。
function logLine(level, tag, e) { try { plog(level + ' ' + tag + ': ' + errText(e)); } catch (_) { /* plog 自己已兜底 */ } }
const ignore = (tag, e) => logLine('ignored', tag, e);
const fail = (tag, e) => logLine('FAILED', tag, e);
function readJson(p) {
  try {
    // PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM；JSON.parse 会抛 ⇒ 必须先剥掉（2026-10-17 实测根因）
    return JSON.parse(String(nodeFs.readFileSync(p, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (e) {
    // ENOENT = 这个文件按设计可能还没写出来（或已被消费）⇒ 正常的"没有"，不算失败。
    // 其它情况（权限、半截文件、BOM 之外的花样）读结果失败必须留痕，仍然返回 null 让轮询/兜底继续。
    if (e && e.code === 'ENOENT') return null;
    fail('readJson ' + p, e);
    return null;
  }
}
function recent(at, ms) { const t = Date.parse(String(at || '').replace(' ', 'T')); return Number.isFinite(t) && Date.now() - t <= ms; }

export function apply(ctx, config) {
  plog('apply entered');
  // 2026-10-25 兜底清理（用户要求"正确删除"）：重启任务只该活到"被 /run 一次"为止。
  // 新 Host 一启动就把它删掉 —— 此刻本次任务早已跑完、wscript 已退出，
  // 删它不可能掐断任何正在进行的重启；而 /ST=9999 本来就让触发器永远到不了。
  // 旧代码缺了这一下，才有 12:57 那次"没人排、自己跑"的重启。
  try {
    execFileSync('schtasks', ['/delete', '/tn', 'dsh_restart_once', '/f'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    plog('cleanup: removed leftover dsh_restart_once');
  } catch (e) {
    // 这里失败的最常见原因就是"本来就没有残留任务"（/delete 找不到）；真出错也不该拦住 Host 启动。
    ignore('apply:delete-leftover-dsh_restart_once', e);
  }
  const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  // 写完立刻读回来比哈希：这条挡不住"写完之后又被改"，但能挡住磁盘/编码层面的意外，
  // 而且把"我们这个文件确实是我刚写的那份"变成一次显式断言，而不是假设。
  const writeVerified = (file, text) => {
    nodeFs.writeFileSync(file, text, 'utf8');
    const back = nodeFs.readFileSync(file, 'utf8');
    if (sha(back) !== sha(text)) throw new Error('自检失败：写回内容与预期不一致 ' + file);
    return true;
  };
  const ensureFiles = (delay) => {
    try {
      nodeFs.mkdirSync(TMP, { recursive: true });
      writeVerified(DOER, DOER_PS1);
      writeVerified(VBS, vbsText(delay));
      return true;
    } catch (e) { plog('ensureFiles failed: ' + (e && e.message ? e.message : String(e))); return false; }
  };

  const definition = {
    name: 'dsh_restart',
    description:
      'Restart the DeepSeek Harness host reliably, then deliver the completion result to the session that asked for it. ' +
      'Schedules a detached Windows task (cmd + absolute powershell) which waits, stops the process listening on 3080, ' +
      'relaunches with node bin.js web --no-open, polls the port until it listens again, writes a result JSON, and after the ' +
      'restart prompts the requesting session with the outcome. Use dryRun to validate paths and the target pid.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        delaySeconds: { type: 'number', description: 'Grace period before the kill so the current reply can leave first. Default 30.' },
        dryRun: { type: 'boolean', description: 'Only log the target pid and paths; do not restart.' }
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]
    },
    async execute(args, exec) {
      const a = args ?? {};
      // 默认 30s：Agent 自己调时，工具返回后它还要继续写完这一轮的回复，5s 会把那半截掐断。
      // 人手敲的 /restartdsh 显式传 5s —— 那条路径的返回值是即时给出的，不需要等这么久。
      const delay = typeof a.delaySeconds === 'number' && a.delaySeconds >= 0 ? Math.floor(a.delaySeconds) : 30;
      const sessionId = (exec && exec.agent && exec.agent.id) || (exec && exec.sessionId) || '';
      if (!ensureFiles(delay)) return { ok: false, text: '无法写入重启脚本到 ' + TMP };
      if (a.dryRun) {
        try { execFileSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DOER, '-Delay', '0', '-DryRun'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
          return { ok: true, dryRun: true, text: '干跑完成（未重启）日志：' + LOG }; }
        catch (e) { return { ok: false, dryRun: true, text: '干跑失败：' + (e && e.message ? e.message : String(e)) }; }
      }
      const altIds = [];
      // exec.agent.sessionId / exec.sessionId 都是"有就多一个投递候选"，没有也能靠 sessionId 送达。
      try { if (exec && exec.agent && exec.agent.sessionId) altIds.push(String(exec.agent.sessionId)); } catch (e) { ignore('altIds:exec.agent.sessionId', e); }
      try { if (exec && exec.sessionId) altIds.push(String(exec.sessionId)); } catch (e) { ignore('altIds:exec.sessionId', e); }
      // 请求文件是"结果回送发起会话"的唯一凭据（RES 只是结果，没人认领就等于没通知）。
      let reqErr = null;
      try { nodeFs.writeFileSync(REQ, JSON.stringify({ sessionId, altIds, at: new Date().toISOString(), delay }), 'utf8'); }
      catch (e) { reqErr = e; }
      // 旧结果先删掉：留着会让新 Host 的 tryDeliver 把上一次的旧结果再送一遍（best-effort）。
      try { nodeFs.unlinkSync(RES); } catch (e) { ignore('unlink-stale-result', e); }
      if (reqErr) {
        fail('write-request ' + REQ, reqErr);
        // 不吞：请求文件写不进去，重启完谁也不会收到通知 —— 那正是这次要消灭的静默失败。
        // 此时 3080 还没被动过，直接报错比"重启了但没人知道"安全。
        return { ok: false, text: '无法写重启请求文件 ' + REQ + '：' + errText(reqErr) + '（结果将无人接收，已中止排定，未动 3080）' };
      }
      // 2026-10-25 修（用户要求的两点）：
      //   ① /ST 原来取"现在+5分钟" —— 那只是给 /SC ONCE 凑一个合法的"将来"时刻，
      //      可 /run 只是提前跑一遍，并不消掉触发器 ⇒ 5 分钟后任务自己再响一次，
      //      拿当时 VBS 里的旧延时又杀一遍 3080（实测 12:52:10 排的重启在 12:57:00
      //      又跑一遍：3812 → 4580，而且没有 REQ，谁也没收到通知）。现在钉在"世界末日"。
      //   ② 删除不靠"触发器不响"来回避，而是真删；但删除时机不能和刚起的 wscript 抢，
      //      所以这里只删【上一次遗留的旧定义】，本次的删除交给新 Host 启动时的兜底清理。
      const TASK = 'dsh_restart_once';
      const SCT = { encoding: 'utf8', timeout: 30000, windowsHide: true };
      // 删上一次遗留的旧定义：多数时候"没有旧定义"才是常态 ⇒ 失败不拦流程（best-effort）。
      try { execFileSync('schtasks', ['/delete', '/tn', TASK, '/f'], SCT); } catch (e) { ignore('delete-previous-task-def', e); }
      // /SC ONCE 强制要 /ST，/ST 又必须是"将来"；日期写法随系统区域（zh-CN 用 yyyy/M/d），
      // 三种写法依次试；万一系统整段拒收 9999 年，退到"今天 23:59"（至少不是 5 分钟后）。
      const pad2 = (n) => String(n).padStart(2, '0');
      const nowD = new Date();
      const ymdDash = nowD.getFullYear() + '-' + pad2(nowD.getMonth() + 1) + '-' + pad2(nowD.getDate());
      const ymdSlash = nowD.getFullYear() + '/' + pad2(nowD.getMonth() + 1) + '/' + pad2(nowD.getDate());
      const schedules = [
        ['9999-12-31', '23:59'], ['9999/12/31', '23:59'], ['12/31/9999', '23:59'],
        [ymdDash, '23:59'], [ymdSlash, '23:59']
      ];
      let used = null, lastErr = null;
      for (const [sd, st] of schedules) {
        try {
          execFileSync('schtasks', ['/create', '/tn', TASK, '/tr', 'wscript.exe //B //Nologo ' + VBS, '/sc', 'once', '/sd', sd, '/st', st, '/f'], SCT);
          used = sd + ' ' + st;
          break;
        } catch (e) { lastErr = e; }
      }
      if (!used) return { ok: false, text: '排定重启任务失败（/create 所有日期写法都被拒）：' + (lastErr && lastErr.message ? lastErr.message : String(lastErr)) };
      try { execFileSync('schtasks', ['/run', '/tn', TASK], SCT); }
      catch (e) { return { ok: false, text: '排定重启任务失败（/run）：' + (e && e.message ? e.message : String(e)) }; }
      return { ok: true, scheduled: true, delaySeconds: delay, sessionId, taskStart: used, resultPath: RES, logPath: LOG,
        text: '已排定重启：约 ' + delay + ' 秒后重启（任务触发器 ' + used + '，不会自己再响；新 Host 启动后会删掉该任务）。完成后插件会把结果作为一条消息推给本会话（发给 Agent）。' };
    }
  };

  ctx.effect(() => ctx.tools.register(definition), 'dsh-restart: dsh_restart');

  // ---- 仅用户命令：/killdsh -------------------------------------------------
  // 用户 2026-10-18 要求：插件起的 DSH 是隐藏进程，用户关不掉 ⇒ 给一个人能输入的开关。
  // 斜杠命令天生只能由人输入（Agent 无法触发），所以它天然就是「仅用户工具」。
  const KILL_PS1 = [
    'Start-Sleep -Seconds 3',
    '$LOG = ' + JSON.stringify(LOG),
    'function W($m) { ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $m) | Add-Content -LiteralPath $LOG -Encoding UTF8 }',
    'W "killdsh: requested by user"',
    '$l = (netstat -ano | Select-String ":3080 .*LISTENING" | Select-Object -First 1)',
    'if ($l) { $p = [int](($l -replace "\s+"," ").Trim().Split(" ")[-1]); try { Stop-Process -Id $p -Force -ErrorAction Stop; W ("killdsh: killed pid=" + $p) } catch { W ("killdsh: failed " + $_.Exception.Message) } } else { W "killdsh: no listener on 3080" }'
  ].join('\r\n');
  const KILL_VBS = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run """' + PWSH + '"" -NoProfile -ExecutionPolicy Bypass -File ""' + KILL_PS1_PATH + '""", 0, False'
  ].join('\r\n');
  try {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        commandCtx.commands.register({
          name: 'killdsh',
          description: '关闭 DSH（仅用户可输入；3 秒后杀掉 3080 监听进程）',
          handler: async () => {
            try {
              nodeFs.mkdirSync(TMP, { recursive: true });
              nodeFs.writeFileSync(KILL_PS1_PATH, KILL_PS1, 'utf8');
              nodeFs.writeFileSync(KILL_VBS_PATH, KILL_VBS, 'utf8');
              const { execFileSync } = await import('node:child_process');
              execFileSync('wscript.exe', ['//B', '//Nologo', KILL_VBS_PATH], { timeout: 30000, windowsHide: true });
              return { kind: 'success', text: '正在关闭 DSH ✓ —— 约 3 秒后进程结束 ✓。\n重新启动：双击桌面「启动 DSH」或运行 dsh web --no-open ✓。' };
            } catch (e) {
              return { kind: 'error', text: '关闭失败：' + (e && e.message ? e.message : String(e)) };
            }
          }
        });
      } catch (e) {
        // 注册失败 = 用户敲 /killdsh 会"命令不存在"。这里抛会连带拆掉下面 /restartdsh 的注册，
        // 所以只留痕、继续挂载其余入口。
        fail('register /killdsh', e);
      }
    });
  } catch (e) {
    fail('inject commands (/killdsh)', e);
  }


  // ---- 仅用户命令：/restartdsh ----------------------------------------------
  // 用户 2026-10-18 要求：/killdsh 只杀不拉；再给一个「停 + 拉起」的仅用户命令。
  // 实现上直接复用 dsh_restart 工具那条【已实测】的排定路径（不另写一套，避免新风险）。
  try {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        commandCtx.commands.register({
          name: 'restartdsh',
          description: '重启 DSH（仅用户可输入；约 5 秒后停 3080 → 自动拉起 → 探活）',
          handler: async () => {
            try {
              const r = await definition.execute({ delaySeconds: 5 }, {});
              if (!r || r.ok === false) return { kind: 'error', text: (r && r.text) || '排定重启失败' };
              // 2026-10-25 用户要求：人手敲命令只要一行短话，不要工具那段长文案。
              const sec = typeof r.delaySeconds === 'number' ? r.delaySeconds : 5;
              return { kind: 'success', text: 'Message:已排定在' + sec + 's后重启，期间请不要刷新浏览器，日志文件%LOCALAPPDATA%\\dsh-restart\\dsh_restart_result.json' };
            } catch (e) {
              return { kind: 'error', text: '排定重启失败：' + (e && e.message ? e.message : String(e)) };
            }
          }
        });
      } catch (e) {
        fail('register /restartdsh', e);
      }
    });
  } catch (e) {
    fail('inject commands (/restartdsh)', e);
  }
  // ---- 重启结果回送：走 Agent 层，不走 sessionController.prompt --------------
  // 2026-10-25 为什么改：`sessionController.prompt()` 是"冒充用户发消息"的远端 API，
  // 它自己重建 source（dsh-api-session-controller/lib/index.js:856 写死 kind:"user"），
  // 调用方传的 source 被整段丢掉 ⇒ 重启通知在 goal 眼里等同于人类输入，实测能建目标。
  // 官方插件（dsh-subagent / dsh-tool-goal）都走 Agent 层并自带 source：
  //   agent.followup({ role:'user', content, source:{kind:'tool'} })
  // 消息对象与 @deepseek-ai/dsh-llm 的 createUserMessage 等价（它只是补 id + role），
  // 这样插件不必去 import 一个不在自身依赖里的包。
  const resultText = (res) => '【DSH 重启完成】' + String(res.at) + '：3080 监听=' + res.up + '，pid ' + res.oldPid + ' → ' + res.newPid +
    '。本次重启由该会话的工具调用触发。';
  const deliver = (ag, text) => {
    ag.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: 'dsh-restart-' + randomUUID() }
    });
  };
  // 返回被送达的 sid；会话还没被 Agent 恢复时返回 null，让轮询继续等。
  const tryDeliver = (agents) => {
    const req = readJson(REQ);
    if (!req || !req.sessionId) return null;
    const res = readJson(RES);
    if (!res || !recent(res.at, 10 * 60000)) return null;
    for (const sid of [req.sessionId].concat(req.altIds || [])) {
      if (!sid) continue;
      const ag = agents.get(sid);
      if (!ag || typeof ag.followup !== 'function') continue;
      deliver(ag, resultText(res));
      return sid;
    }
    return null;
  };
  try {
    ctx.inject(['agents'], (ac) => {
      plog('inject agents resolved');
      let tries = 0; let timer = null;
      const finish = (sid) => {
        if (timer) { clearInterval(timer); timer = null; }
        plog('delivered sid=' + sid);
        // 请求文件已消费；删不掉只会导致下次多投一遍（10 分钟窗口内），不拦流程。
        try { nodeFs.unlinkSync(REQ); } catch (e) { ignore('delivered:unlink-request', e); }
      };
      /*
       * 结果文件是【重启之后】才写的，而本插件是【重启过程中】挂载的 ⇒ 只读一次赶不上。
       * 轮询最多 3 分钟：既等结果文件出现，也等那个会话的 Agent 被恢复（懒加载）。
       */
      timer = setInterval(() => {
        tries += 1;
        if (tries <= 2 || tries % 20 === 0) plog('tick ' + tries + ' req=' + (nodeFs.existsSync(REQ) ? 'y' : 'n') + ' res=' + (nodeFs.existsSync(RES) ? 'y' : 'n'));
        if (tries > 60) { clearInterval(timer); timer = null; return; }
        // 投递失败不能吞：这直接决定"Agent 收不收得到重启结果"。抛在这里会打断定时器，
        // 所以记 FAILED 后让下一轮继续（下一轮仍有机会送达）。
        try { const sid = tryDeliver(ac.agents); if (sid) finish(sid); } catch (e) { fail('poll:tick-deliver', e); }
      }, 3000);
      try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch (e) { ignore('timer.unref', e); }
      // 挂载时先试一次：多数情况下重启回来时会话已经恢复，不必等第一个 tick。
      try { const sid = tryDeliver(ac.agents); if (sid) finish(sid); } catch (e) { fail('poll:initial-deliver', e); }
    });
  } catch (e) {
    fail('inject agents', e);
  }

  // 2026-10-25（用户拍板删除）：这里原有 systemPrompt.section('dsh-restart-result')，
  // 在重启后 10 分钟内往【系统提示】里塞一行结果。删掉的理由：
  //   ① 系统提示是最贵的位置——它每轮都在，且是缓存前缀，一出现/一消失就各作废一次前缀缓存；
  //   ② 内容本来就已经通过 agent.followup 送进对话（本次实测可送达），这段是纯重复的兜底；
  //   ③ 真要查结果，日志在 %LOCALAPPDATA%\dsh-restart\dsh_restart_result.json。
  // 代价：如果那条 followup 送达失败（会话 3 分钟内没被恢复），结果只能从日志里看。
  // 这是明知取舍：宁可偶发丢一次通知，也不让每轮上下文和缓存前缀为它买单。
}
