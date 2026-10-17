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
import { randomUUID } from 'node:crypto';

export const inject = ['tools'];

const TMP = 'C:\\Users\\Chen\\AppData\\Local\\Temp';
const LOG = TMP + '\\dsh_restart_log.txt';
const RES = TMP + '\\dsh_restart_result.json';
const REQ = TMP + '\\dsh_restart_request.json';
const MARKER = TMP + '\\dsh_restart_marker.txt';
const CMD = TMP + '\\dsh_restart.cmd';
const DOER = TMP + '\\dsh_restart_doer.ps1';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BIN = 'C:\\Users\\Chen\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const PWSH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const DOER_PS1 = [
  'param([int]$Delay = 25)',
  "$NODE = '" + NODE + "'", "$BIN = '" + BIN + "'", "$LOG = '" + LOG + "'", "$RES = '" + RES + "'",
  'function W($m) { ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $m) | Add-Content -LiteralPath $LOG -Encoding UTF8 }',
  'function ListenerPid { $l = (netstat -ano | Select-String ":3080 .*LISTENING" | Select-Object -First 1); if ($l) { return [int](($l -replace "\s+"," ").Trim().Split(" ")[-1]) } return 0 }',
  'W ("doer start delay=" + $Delay)',
  'Start-Sleep -Seconds $Delay',
  '$oldPid = ListenerPid',
  'W ("current dsh pid=" + $oldPid)',
  'if ($oldPid -gt 0) { try { Stop-Process -Id $oldPid -Force -ErrorAction Stop; W ("STOPPED pid=" + $oldPid) } catch { W ("stop failed: " + $_.Exception.Message) } }',
  'Start-Sleep -Seconds 8',
  'for ($i = 0; $i -lt 2; $i++) { try { Start-Process -FilePath $NODE -ArgumentList @($BIN, "web", "--no-open") -WindowStyle Hidden; W ("launched attempt " + ($i + 1)); break } catch { W ("launch failed: " + $_.Exception.Message); Start-Sleep -Seconds 3 } }',
  '$up = $false; $newPid = 0',
  'for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Seconds 2; $newPid = ListenerPid; if ($newPid -gt 0) { $up = $true; break } }',
  'W ("listening=" + $up + " pid=" + $newPid)',
  '$pluginOk = $false; $accts = 0',
  'for ($k = 0; $k -lt 20; $k++) { Start-Sleep -Seconds 3; try { $st = Invoke-RestMethod -Uri "http://127.0.0.1:3080/.dsh-wechat-plugin/status" -TimeoutSec 5 -ErrorAction Stop; $pluginOk = [bool]$st.enabled; $accts = ($st.accounts | Measure-Object).Count; if ($pluginOk) { break } } catch { } }',
  '$result = [ordered]@{ at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss"); up = $up; oldPid = $oldPid; newPid = $newPid; pluginEnabled = $pluginOk; accounts = $accts; ok = ($up -and $pluginOk) }',
  '($result | ConvertTo-Json -Compress) | Set-Content -LiteralPath $RES -Encoding UTF8',
  'W ("RESULT " + ($result | ConvertTo-Json -Compress))',
  'W "doer done"'
].join('\r\n');

const cmdText = (delay) => [
  '@echo off',
  'echo task ran %DATE% %TIME% > ' + MARKER,
  '"' + PWSH + '" -NoProfile -ExecutionPolicy Bypass -File "' + DOER + '" -Delay ' + String(delay) + ' >> ' + TMP + '\\dsh_restart_stdout.txt 2>&1',
  'echo task end %DATE% %TIME% >> ' + MARKER
].join('\r\n');

function readJson(p) { try { return JSON.parse(nodeFs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function recent(at, ms) { const t = Date.parse(String(at || '').replace(' ', 'T')); return Number.isFinite(t) && Date.now() - t <= ms; }

export function apply(ctx, config) {
  const ensureFiles = (delay) => {
    try { nodeFs.writeFileSync(DOER, DOER_PS1, 'utf8'); nodeFs.writeFileSync(CMD, cmdText(delay), 'utf8'); return true; }
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
      const { execFileSync } = await import('node:child_process');
      if (a.dryRun) {
        try { execFileSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DOER, '-Delay', '0'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
          return { ok: true, dryRun: true, text: '干跑完成（未重启）日志：' + LOG }; }
        catch (e) { return { ok: false, dryRun: true, text: '干跑失败：' + (e && e.message ? e.message : String(e)) }; }
      }
      const altIds = [];
      try { if (exec && exec.agent && exec.agent.sessionId) altIds.push(String(exec.agent.sessionId)); } catch (e) { }
      try { if (exec && exec.sessionId) altIds.push(String(exec.sessionId)); } catch (e) { }
      try { nodeFs.writeFileSync(REQ, JSON.stringify({ sessionId, altIds, at: new Date().toISOString(), delay }), 'utf8'); } catch (e) { }
      try { nodeFs.unlinkSync(RES); } catch (e) { }
      try { execFileSync('schtasks', ['/delete', '/tn', 'dsh_restart_once', '/f'], { encoding: 'utf8', timeout: 30000, windowsHide: true }); } catch (e) { }
      try {
        const st = new Date(Date.now() + 5 * 60000);
        const hhmm = String(st.getHours()).padStart(2, '0') + ':' + String(st.getMinutes()).padStart(2, '0');
        execFileSync('schtasks', ['/create', '/tn', 'dsh_restart_once', '/tr', CMD, '/sc', 'once', '/st', hhmm, '/f'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
        execFileSync('schtasks', ['/run', '/tn', 'dsh_restart_once'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      } catch (e) { return { ok: false, text: '排定重启任务失败：' + (e && e.message ? e.message : String(e)) }; }
      return { ok: true, scheduled: true, delaySeconds: delay, sessionId, resultPath: RES, logPath: LOG,
        text: '已排定重启：约 ' + delay + ' 秒后重启。完成后插件会把结果作为一条消息推给本会话（发给 Agent），并在 systemPrompt 里保留 10 分钟。' };
    }
  };

  ctx.effect(() => ctx.tools.register(definition), 'dsh-restart: dsh_restart');

  try {
    ctx.inject(['sessionController'], (sc) => {
      /*
       * 关键：结果文件是【重启之后】才写的，而本插件是在【重启过程中】挂载的 ⇒
       * 只在挂载时读一次永远赶不上（实测：用户一直看不到通知）。
       * 所以挂载后轮询最多 3 分钟，看到结果就推给会话，然后删掉请求文件。
       */
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
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
            try { sc.sessionController.prompt({ requestId: 'dsh-restart-' + randomUUID(), sessionId: sid, mode: 'queue', content: [{ type: 'text', text: text0 }] }, new AbortController().signal); done = true; } catch (e) { }
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
        try { sc.sessionController.prompt({ requestId: 'dsh-restart-' + randomUUID(), sessionId: req.sessionId, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal); } catch (e) { }
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
