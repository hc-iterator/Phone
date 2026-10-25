/**
 * dsh-restart —— 给 Agent 一个可靠重启 DSH 的能力（用户 2026-10-17 要求）
 * ======================================================================
 * 关键设计（根据实测反复修正）：
 *   · schtasks 排定 .cmd；cmd 用【绝对路径 powershell】拉起 doer（任务环境 PATH 极简）
 *   · 延迟【写死】进 cmd（老版本 -Delay %1 ⇒ 任务无参数 ⇒ MissingArgument ⇒ 从不执行）
 *   · doer 等待 → 杀 3080 → node bin.js web --no-open（不弹浏览器）→ 轮询 3080 + 插件状态
 *   · 结果写 %TEMP%\dsh_restart_result.json
 *   · 重启后把结果作为一条消息推给当初调用工具的会话 = 「发给 Agent」
 *   · 同时用 systemPrompt 片段兜底（10 分钟内）
 */
import * as nodeFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const inject = ['tools'];

const TMP = 'C:\\Users\\Chen\\AppData\\Local\\Temp';
const LOG = TMP + '\\dsh_restart_log.txt';
const RES = TMP + '\\dsh_restart_result.json';
const REQ = TMP + '\\dsh_restart_request.json';
const MARKER = TMP + '\\dsh_restart_marker.txt';
const VBS = TMP + '\\dsh_restart_silent.vbs';
const DOER = TMP + '\\dsh_restart_doer.ps1';
const KILL_PS1_PATH = TMP + '\\dsh_killdsh.ps1';
const KILL_VBS_PATH = TMP + '\\dsh_killdsh.vbs';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BIN = 'C:\\Users\\Chen\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
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
  '$pluginOk = $false; $accts = 0',
  'for ($k = 0; $k -lt 20; $k++) { Start-Sleep -Seconds 3; try { $st = Invoke-RestMethod -Uri "http://127.0.0.1:3080/.dsh-wechat-plugin/status" -TimeoutSec 5 -ErrorAction Stop; $pluginOk = [bool]$st.enabled; $accts = ($st.accounts | Measure-Object).Count; if ($pluginOk) { break } } catch { } }',
  '$result = [ordered]@{ at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss"); up = $up; oldPid = $oldPid; newPid = $newPid; pluginEnabled = $pluginOk; accounts = $accts; ok = ($up -and $pluginOk) }',
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
function plog(m) { try { nodeFs.appendFileSync(PLOG, new Date().toISOString() + ' ' + m + '\n', 'utf8'); } catch (e) { } }
function readJson(p) {
  try {
    // PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM；JSON.parse 会抛 ⇒ 必须先剥掉（2026-10-17 实测根因）
    return JSON.parse(String(nodeFs.readFileSync(p, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (e) { return null; }
}
function recent(at, ms) { const t = Date.parse(String(at || '').replace(' ', 'T')); return Number.isFinite(t) && Date.now() - t <= ms; }

export function apply(ctx, config) {
  plog('apply entered');
  // 2026-10-25：重启任务只该活到"被 /run 一次"为止。新 Host 一启动就把它删掉 ——
  // 此刻本次任务早已跑完、wscript 已退出，删它不可能掐断正在进行的重启。
  // 旧代码缺了这一下，一次性任务会一直留在计划任务里。
  try {
    execFileSync('schtasks', ['/delete', '/tn', 'dsh_restart_once', '/f'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    plog('cleanup: removed leftover dsh_restart_once');
  } catch (e) { }
  const ensureFiles = (delay) => {
    try { nodeFs.writeFileSync(DOER, DOER_PS1, 'utf8'); nodeFs.writeFileSync(VBS, vbsText(delay), 'utf8'); return true; }
    catch (e) { return false; }
  };

  const definition = {
    name: 'dsh_restart',
    description:
      'Restart the DeepSeek Harness host reliably, then deliver the completion result to the session that asked for it. ' +
      'Schedules a detached Windows task (cmd + absolute powershell) which waits, stops the process listening on 3080, ' +
      'relaunches with node bin.js web --no-open, polls port and WeChat-plugin status, writes a result JSON, and after the ' +
      'restart prompts the requesting session with the outcome. Use dryRun to validate paths and the target pid.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        delaySeconds: { type: 'number', description: 'Grace period before the kill so the current reply can leave first. Default 25.' },
        dryRun: { type: 'boolean', description: 'Only log the target pid and paths; do not restart.' }
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]
    },
    async execute(args, exec) {
      const a = args ?? {};
      const delay = typeof a.delaySeconds === 'number' && a.delaySeconds >= 0 ? Math.floor(a.delaySeconds) : 25;
      const sessionId = (exec && exec.agent && exec.agent.id) || (exec && exec.sessionId) || '';
      if (!ensureFiles(delay)) return { ok: false, text: '无法写入重启脚本到 ' + TMP };
      if (a.dryRun) {
        try { execFileSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DOER, '-Delay', '0', '-DryRun'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
          return { ok: true, dryRun: true, text: '干跑完成（未重启）日志：' + LOG }; }
        catch (e) { return { ok: false, dryRun: true, text: '干跑失败：' + (e && e.message ? e.message : String(e)) }; }
      }
      const altIds = [];
      try { if (exec && exec.agent && exec.agent.sessionId) altIds.push(String(exec.agent.sessionId)); } catch (e) { }
      try { if (exec && exec.sessionId) altIds.push(String(exec.sessionId)); } catch (e) { }
      try { nodeFs.writeFileSync(REQ, JSON.stringify({ sessionId, altIds, at: new Date().toISOString(), delay }), 'utf8'); } catch (e) { }
      try { nodeFs.unlinkSync(RES); } catch (e) { }
      try { execFileSync('schtasks', ['/delete', '/tn', 'dsh_restart_once', '/f'], { encoding: 'utf8', timeout: 30000, windowsHide: true }); } catch (e) { }
      // 2026-10-25：原实现 /st 取"现在+5分钟"，只是为了给 /SC ONCE 凑一个合法的"将来"时刻；
      // 但 /run 只是提前跑一遍，并不消掉触发器 ⇒ 5 分钟后任务自己再响一次，
      // 拿当时 VBS 里的延时又杀一遍 3080（实测：12:52 排的重启在 12:57 又跑了一遍）。
      // 现在把 /st 钉在 9999 年，触发器永远到不了；真正执行只靠 /run。
      const SCT = { encoding: 'utf8', timeout: 30000, windowsHide: true };
      // /SC ONCE 强制要 /ST，且必须是"将来"；日期写法随系统区域，按几种写法依次试。
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
          execFileSync('schtasks', ['/create', '/tn', 'dsh_restart_once', '/tr', 'wscript.exe //B //Nologo ' + VBS, '/sc', 'once', '/sd', sd, '/st', st, '/f'], SCT);
          used = sd + ' ' + st;
          break;
        } catch (e) { lastErr = e; }
      }
      if (!used) return { ok: false, text: '排定重启任务失败（/create 所有日期写法都被拒）：' + (lastErr && lastErr.message ? lastErr.message : String(lastErr)) };
      try { execFileSync('schtasks', ['/run', '/tn', 'dsh_restart_once'], SCT); }
      catch (e) { return { ok: false, text: '排定重启任务失败（/run）：' + (e && e.message ? e.message : String(e)) }; }
      return { ok: true, scheduled: true, delaySeconds: delay, sessionId, taskStart: used, resultPath: RES, logPath: LOG,
        text: '已排定重启：约 ' + delay + ' 秒后重启（任务触发器 ' + used + '，不会自己再响；新 Host 启动后会删掉该任务）。完成后插件会把结果作为一条消息推给本会话（发给 Agent），并在 systemPrompt 里保留 10 分钟。' };
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
      } catch (e) { }
    });
  } catch (e) { }


  // ---- 仅用户命令：/restartdsh ----------------------------------------------
  // 用户 2026-10-18 要求：/killdsh 只杀不拉；再给一个「停 + 拉起」的仅用户命令。
  // 实现上直接复用 dsh_restart 工具那条【已实测】的排定路径（不另写一套，避免新风险）。
  try {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        commandCtx.commands.register({
          name: 'restartdsh',
          description: '重启 DSH（仅用户可输入；约 20 秒后停 3080 → 自动拉起 → 探活）',
          handler: async () => {
            try {
              const r = await definition.execute({ delaySeconds: 20 }, {});
              const base = r && r.text ? String(r.text) : '已排定重启 ✓';
              return { kind: 'success', text: base + '\n（页面会短暂断连，约 20 秒后自动回来 ✓；结果也会写进 %TEMP%\\dsh_restart_result.json ✓）' };
            } catch (e) {
              return { kind: 'error', text: '排定重启失败：' + (e && e.message ? e.message : String(e)) };
            }
          }
        });
      } catch (e) { }
    });
  } catch (e) { }
  try {
    ctx.inject(['sessionController'], (sc) => {
      plog('inject sessionController resolved');
      /*
       * 关键：结果文件是【重启之后】才写的，而本插件是在【重启过程中】挂载的 ⇒
       * 只在挂载时读一次永远赶不上（实测：用户一直看不到通知）。
       * 所以挂载后轮询最多 3 分钟，看到结果就推给会话，然后删掉请求文件。
       */
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (tries <= 2 || tries % 20 === 0) plog('tick ' + tries + ' req=' + (nodeFs.existsSync(REQ) ? 'y' : 'n') + ' res=' + (nodeFs.existsSync(RES) ? 'y' : 'n'));
        if (tries > 60) { clearInterval(timer); return; }
        try {
          const req = readJson(REQ); const res = readJson(RES);
          if (!req || !res || !recent(res.at, 10 * 60000) || !req.sessionId) return;
          clearInterval(timer);
          const text0 = '【DSH 重启完成】' + String(res.at) + '：3080 监听=' + res.up + '，pid ' + res.oldPid + ' → ' + res.newPid +
            '，微信插件=' + (res.pluginEnabled ? 'OK' : 'FAIL') + '，账号=' + res.accounts + '。本次重启由该会话的工具调用触发。';
          let done = false;
          for (const sid of [req.sessionId].concat(req.altIds || [])) {
            if (done || !sid) continue;
            try { sc.sessionController.prompt({ requestId: 'dsh-restart-' + randomUUID(), sessionId: sid, mode: 'queue', content: [{ type: 'text', text: text0 }], source: { kind: 'tool', callId: 'dsh-restart-' + randomUUID() } }, new AbortController().signal); plog('prompt ok sid=' + sid); done = true; } catch (e) { plog('prompt FAILED sid=' + sid + ' :: ' + (e && e.message ? e.message : String(e))); }
          }
          try { nodeFs.unlinkSync(REQ); } catch (e) { }
        } catch (e) { }
      }, 3000);
      try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch (e) { }
      try {
        const req = readJson(REQ); const res = readJson(RES);
        if (!req || !res || !recent(res.at, 10 * 60000) || !req.sessionId) return;
        const text = '【DSH 重启完成】' + String(res.at) + '：3080 监听=' + res.up + '，pid ' + res.oldPid + ' → ' + res.newPid +
          '，微信插件=' + (res.pluginEnabled ? 'OK' : 'FAIL') + '，账号=' + res.accounts + '。本次重启由该会话的工具调用触发。';
        try { sc.sessionController.prompt({ requestId: 'dsh-restart-' + randomUUID(), sessionId: req.sessionId, mode: 'queue', content: [{ type: 'text', text }], source: { kind: 'tool', callId: 'dsh-restart-' + randomUUID() } }, new AbortController().signal); } catch (e) { }
        try { nodeFs.unlinkSync(REQ); } catch (e) { }
      } catch (e) { }
    });
  } catch (e) { }

  try {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        promptCtx.systemPrompt.section({
          id: 'dsh-restart-result',
          text: () => {
            try {
              const r = readJson(RES);
              if (!r || !recent(r.at, 10 * 60000)) return '';
              return '【DSH 上次重启完成】' + String(r.at) + '：3080=' + r.up + '，pid ' + r.oldPid + ' → ' + r.newPid + '，微信插件=' + (r.pluginEnabled ? 'OK' : 'FAIL') + '，账号=' + r.accounts;
            } catch (e) { return ''; }
          }
        });
      } catch (e) { }
    });
  } catch (e) { }
}
