/**
 * dsh-restart —— 给 Agent 一个可靠重启 DSH 的能力（用户 2026-10-17 要求）
 * ======================================================================
 * 为什么需要它：插件/配置改动必须重启 DSH 才生效，而"自己重启自己"这件事
 * 在真实环境里踩过两次坑（任务环境 PATH 极简导致 powershell 找不到 / 日志撞车）。
 * 本插件把已验证的做法固化下来：
 *   1) 工具 dsh_restart 被调用 ⇒ 写好自己的 doer 脚本 ⇒ 用 schtasks 排定一个 .cmd
 *   2) .cmd 用【绝对路径的 powershell】拉起 doer（这是当初失败的点）
 *   3) doer 等 N 秒（让本轮回复先发出去）⇒ 杀掉 3080 监听进程 ⇒ 用 node bin.js web 重启
 *   4) 轮询直到 3080 重新监听 ⇒ 查插件状态 ⇒ 写结果 JSON ⇒ 用微信插件发一条通知（用户要求 ✓）
 *   5) 重启后的 DSH 里，本插件把结果通过 systemPrompt 片段告诉 Agent（10 分钟内）
 */
export const inject = ['tools'];

const TMP = 'C:\\Users\\Chen\\AppData\\Local\\Temp';
const LOG = TMP + '\\dsh_restart_log.txt';
const RES = TMP + '\\dsh_restart_result.json';
const MARKER = TMP + '\\dsh_restart_marker.txt';
const CMD = TMP + '\\dsh_restart.cmd';
const DOER = TMP + '\\dsh_restart_doer.ps1';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BIN = 'C:\\Users\\Chen\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const PWSH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const DOER_PS1 = [
  'param([int]$Delay = 25, [switch]$DryRun)',
  "$NODE = '" + NODE.replace(/\\/g, '\\\\') + "'",
  "$BIN = '" + BIN.replace(/\\/g, '\\\\') + "'",
  "$LOG = '" + LOG.replace(/\\/g, '\\\\') + "'",
  "$RES = '" + RES.replace(/\\/g, '\\\\') + "'",
  'function W($m) { ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $m) | Add-Content -LiteralPath $LOG -Encoding UTF8 }',
  'function ListenerPid { $l = (netstat -ano | Select-String ":3080 .*LISTENING" | Select-Object -First 1); if ($l) { return [int](($l -replace "\s+"," ").Trim().Split(" ")[-1]) } return 0 }',
  'W ("doer start delay=" + $Delay + " dryRun=" + $DryRun.IsPresent)',
  'Start-Sleep -Seconds $Delay',
  '$oldPid = ListenerPid',
  'W ("current dsh pid=" + $oldPid)',
  'if ($DryRun) { W "dryRun: skip kill/restart"; exit 0 }',
  'if ($oldPid -gt 0) { try { Stop-Process -Id $oldPid -Force -ErrorAction Stop; W ("stopped pid=" + $oldPid) } catch { W ("stop failed: " + $_.Exception.Message) } }',
  'Start-Sleep -Seconds 8',
  'for ($i = 0; $i -lt 2; $i++) { try { Start-Process -FilePath $NODE -ArgumentList @($BIN, "web") -WindowStyle Hidden; W ("launched attempt " + ($i + 1)); break } catch { W ("launch failed: " + $_.Exception.Message); Start-Sleep -Seconds 3 } }',
  '$up = $false; $newPid = 0',
  'for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Seconds 2; $newPid = ListenerPid; if ($newPid -gt 0) { $up = $true; break } }',
  'W ("check listening=" + $up + " pid=" + $newPid)',
  '$pluginOk = $false; $accts = 0',
  'try { $st = Invoke-RestMethod -Uri "http://127.0.0.1:3080/.dsh-wechat-plugin/status" -TimeoutSec 10 -ErrorAction Stop; $pluginOk = [bool]$st.enabled; $accts = ($st.accounts | Measure-Object).Count } catch { W ("status query failed: " + $_.Exception.Message) }',
  '$now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
  '$result = [ordered]@{ at = $now; up = $up; oldPid = $oldPid; newPid = $newPid; pluginEnabled = $pluginOk; accounts = $accts; ok = ($up -and $pluginOk) }',
  '($result | ConvertTo-Json -Compress) | Set-Content -LiteralPath $RES -Encoding UTF8',
  'W ("result: " + ($result | ConvertTo-Json -Compress))',
  'try {',
  '  $js = @""',
  'const fs = require("fs");',
  'const { pathToFileURL } = require("url");',
  '(async () => {',
  '  const st = JSON.parse(fs.readFileSync("C:/固态盘秘钥/.dsh/wechat/state.json", "utf8"));',
  '  const acctId = Object.keys(st.accounts)[0];',
  '  const account = st.accounts[acctId];',
  '  const convId = Object.keys(st.bindings)[0];',
  '  const peer = st.bindings[convId].peerId;',
  '  const token = (st.contextTokens[acctId] || {})[convId];',
  '  const r = JSON.parse(fs.readFileSync("' + 'C:/Users/Chen/AppData/Local/Temp/dsh_restart_result.json' + '", "utf8"));',
  '  const mod = await import(pathToFileURL("C:/固态盘秘钥/.dsh/profiles/web/node_modules/dsh-wechat-plugin/dist/core/lib/index.js").href);',
  '  const text = "【DSH 重启完成】" + r.at + " 3080=" + r.up + " pid " + r.oldPid + "->" + r.newPid + " 插件=" + (r.pluginEnabled ? "OK" : "FAIL");',
  '  const res = await mod.sendText({ account: account, to: peer, text: text, contextToken: token });',
  '  console.log("SENT " + JSON.stringify(res));',
  '})().catch((e) => console.log("SEND-ERR " + e.message));',
  '@""',
  '  $tmpJs = "' + 'C:/Users/Chen/AppData/Local/Temp/dsh_restart_notify.cjs' + '"',
  '  [System.IO.File]::WriteAllText($tmpJs, $js, (New-Object System.Text.UTF8Encoding($false)))',
  '  W ("notify: " + ((& $NODE $tmpJs 2>&1 | Out-String).Trim()))',
  '} catch { W ("notify block failed: " + $_.Exception.Message) }',
  'W "doer done"'
].join('\r\n');

const CMD_TEXT = [
  '@echo off',
  'echo task ran %DATE% %TIME% > ' + MARKER,
  '"' + PWSH + '" -NoProfile -ExecutionPolicy Bypass -File "' + DOER + '" -Delay %1 >> ' + LOG + ' 2>&1',
  'echo task end %DATE% %TIME% >> ' + MARKER
].join('\r\n');

import * as nodeFs from 'node:fs';

export function apply(ctx, config) {
  const ensureFiles = () => {
    try {
      nodeFs.writeFileSync(DOER, DOER_PS1, 'utf8');
      nodeFs.writeFileSync(CMD, CMD_TEXT, 'utf8');
      return true;
    } catch (e) { /* 写不了就让工具报错 */ }
    return false;
  };

  const definition = {
    name: 'dsh_restart',
    description:
      'Restart the DeepSeek Harness host reliably (for changes that need a process restart), then report completion. ' +
      'Schedules a detached Windows task (cmd + absolute powershell), which waits, stops the process listening on 3080, ' +
      'relaunches it with node bin.js web, verifies port + plugin status, writes a result JSON, and sends a WeChat notice. ' +
      'Use dryRun to validate paths and the target pid without restarting.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        delaySeconds: { type: 'number', description: 'Grace period before the kill, so the current reply can leave first. Default 25.' },
        dryRun: { type: 'boolean', description: 'Only log the target pid and paths; do not restart.' }
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]
    },
    async execute(args) {
      const a = args ?? {};
      const delay = typeof a.delaySeconds === 'number' && a.delaySeconds >= 0 ? Math.floor(a.delaySeconds) : 25;
      if (!ensureFiles()) return { ok: false, text: '无法写入重启脚本到 ' + TMP + '（权限？）' };
      const { execFileSync } = await import('node:child_process');
      if (a.dryRun) {
        try {
          const out = execFileSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DOER, '-Delay', '0', '-DryRun'], { encoding: 'utf8', timeout: 60000 });
          return { ok: true, dryRun: true, text: '干跑完成（未重启）。输出：\n' + String(out).trim() + '\n日志：' + LOG };
        } catch (e) {
          return { ok: false, dryRun: true, text: '干跑失败：' + (e && e.message ? e.message : String(e)) };
        }
      }
      try {
        execFileSync('schtasks', ['/delete', '/tn', 'dsh_restart_once', '/f'], { encoding: 'utf8', timeout: 30000 });
      } catch (e) { /* 没有旧任务就算了 */ }
      try {
        const st = new Date(Date.now() + 5 * 60000);
        const hhmm = String(st.getHours()).padStart(2, '0') + ':' + String(st.getMinutes()).padStart(2, '0');
        execFileSync('schtasks', ['/create', '/tn', 'dsh_restart_once', '/tr', CMD, '/sc', 'once', '/st', hhmm, '/f'], { encoding: 'utf8', timeout: 30000 });
        execFileSync('schtasks', ['/run', '/tn', 'dsh_restart_once'], { encoding: 'utf8', timeout: 30000 });
      } catch (e) {
        return { ok: false, text: '排定重启任务失败：' + (e && e.message ? e.message : String(e)) };
      }
      return {
        ok: true,
        scheduled: true,
        delaySeconds: delay,
        resultPath: RES,
        logPath: LOG,
        text: '已排定重启：约 ' + delay + ' 秒后 DSH 会被重启。\n' +
          '· 本轮回复会先发出去；重启完成后会发一条微信通知，并把结果写到 ' + RES + '\n' +
          '· 重启后本插件的 systemPrompt 片段会把你上次重启的结果告诉你（10 分钟内有效）'
      };
    }
  };

  ctx.effect(() => ctx.tools.register(definition), 'dsh-restart: dsh_restart');

  // 重启后告诉 Agent 结果（10 分钟内有效；读不到就不注入）
  try {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    try { promptCtx.systemPrompt.section({
      id: 'dsh-restart-result',
      text: () => {
        try {
          const raw = nodeFs.readFileSync(RES, 'utf8');
          const r = JSON.parse(raw);
          const t = Date.parse(String(r.at || '').replace(' ', 'T'));
          if (!Number.isFinite(t) || Date.now() - t > 10 * 60000) return '';
          return '【DSH 上次重启完成】' + String(r.at) + '：3080 监听=' + r.up + '，pid ' + r.oldPid + ' → ' + r.newPid +
            '，微信插件=' + (r.pluginEnabled ? 'OK' : 'FAIL') + '，账号=' + r.accounts + '（结果文件 ' + RES + '）';
        } catch (e) { return ''; }
      }
    }); } catch (e) { /* 注入失败就静默 */ }
  });
  } catch (e) { /* 服务不存在就静默 */ }
}
