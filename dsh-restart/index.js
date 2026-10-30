/**
 * dsh-restart —— 重启 DSH，带【表决】收敛
 * ==========================================================================
 * 依据：手稿 2026-10-21 纸2 §7「重启」原文：
 *
 *   「现在的 Agent 个个都能重启 DSH，弄得鸡犬不宁。」（红笔原话）
 *   - 重启接口必须收敛，这是个好接口，但不好拿捏。
 *   - **用户的重启接口延时不要了。**
 *   - Agent 的重启接口调用后并不立刻重启，而是通知**所有正在运行或有任务
 *     （所有）正在运行或有子 Agent 正在运行的 Agent**。所有被通知的 Agent
 *     都能调用以下 2 个功能：
 *       1. stopdshfromrestarting
 *       2. allowdshrestarting
 *   - 1 号功能不用多说；当所有被通知的 Agent 调用 **2 号**功能后，重启才会开始。
 *     重启后，所有刚被通知的 Agent 都会被通知。
 *   - 同时，用户也要被通知。重启接口被调用后，用户随时在任意对话输入
 *     `/stopdshfromrestarting`，重启即停止。
 *
 * 于是本插件分两条路：
 *   · **用户**：/restartdsh —— 延时 0，直接重启（手稿明确"延时不要了"）
 *   · **Agent**：dsh_restart —— 只发起表决，不重启；所有被通知者 allow 后才执行
 *
 * 底层重启机制沿用原来那套【已实测】的路径（schtasks + VBS 隐藏窗口 + doer 杀 3080
 * → 拉起 → 探活 → 写结果），没有另写一套，避免引入新风险。
 */
import * as nodeFs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const inject = ['tools'];

const TMP = 'C:\\Users\\Chen\\AppData\\Local\\Temp';
const LOG = TMP + '\\dsh_restart_log.txt';
const RES = TMP + '\\dsh_restart_result.json';
const REQ = TMP + '\\dsh_restart_request.json';
const VOTE = TMP + '\\dsh_restart_vote.json';
const MARKER = TMP + '\\dsh_restart_marker.txt';
const VBS = TMP + '\\dsh_restart_silent.vbs';
const DOER = TMP + '\\dsh_restart_doer.ps1';
const KILL_PS1_PATH = TMP + '\\dsh_killdsh.ps1';
const KILL_VBS_PATH = TMP + '\\dsh_killdsh.vbs';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const BIN = 'C:\\Users\\Chen\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const PWSH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

// 表决有效期：10 分钟没人齐就作废（避免一条永远挂着的"待表决"）
const VOTE_TTL = 10 * 60000;

const DOER_PS1 = [
  'param([int]$Delay = 0, [switch]$DryRun)',
  "$NODE = '" + NODE + "'", "$BIN = '" + BIN + "'", "$LOG = '" + LOG + "'", "$RES = '" + RES + "'",
  'function W($m) { ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $m) | Add-Content -LiteralPath $LOG -Encoding UTF8 }',
  'function ListenerPid { $l = (netstat -ano | Select-String ":3080 .*LISTENING" | Select-Object -First 1); if ($l) { return [int](($l -replace "\s+"," ").Trim().Split(" ")[-1]) } return 0 }',
  'W ("doer start delay=" + $Delay)',
  'if ($Delay -gt 0) { Start-Sleep -Seconds $Delay }',
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
  // 干完活把那个计划任务删掉：它排在 2099，本不会触发，但留着是隐患（下次 /create 会先删它）
  'try { schtasks /delete /tn dsh_restart_once /f 2>$null | Out-Null; W "task dsh_restart_once deleted" } catch { W ("task delete failed: " + $_.Exception.Message) }',
  'W "doer done"'
].join('\r\n');

// 计划任务绝不能跑 .cmd：以登录用户身份运行的任务会显示控制台窗口（用户实测被弹窗多次）。
// VBScript 的 Run(cmd, 0, False) 用窗口样式 0 ⇒ 完全不创建窗口。
const vbsText = (delay) => [
  'Set sh = CreateObject("WScript.Shell")',
  'sh.Run """' + PWSH + '"" -NoProfile -ExecutionPolicy Bypass -File ""' + DOER + '"" -Delay ' + String(Math.max(0, Math.floor(delay))) + '", 0, False',
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

// ── 表决状态（手稿 §7）──────────────────────────────────────────────────────
function readVote() {
  const v = readJson(VOTE);
  if (!v || !v.at || v.phase !== 'voting') return null;
  if (!recent(v.at, VOTE_TTL)) return null;   // 过期作废
  return v;
}
function writeVote(v) { try { nodeFs.writeFileSync(VOTE, JSON.stringify(v), 'utf8'); } catch (e) { } }
function clearVote() { try { nodeFs.unlinkSync(VOTE); } catch (e) { } }

// 拿所有【活着的】Agent。手稿要求"所有正在运行或有子 Agent 正在运行的 Agent"，
// 对应 agents service 的 list()（全部注册中的 agent，含子 agent）。
function listLiveAgentIds(ctx) {
  try {
    const svc = ctx.get ? ctx.get('agents') : undefined;
    if (!svc || typeof svc.list !== 'function') return [];
    return svc.list().map((a) => String(a && a.id ? a.id : '')).filter(Boolean);
  } catch (e) { return []; }
}

function callerId(exec) {
  try { if (exec && exec.agent && exec.agent.id) return String(exec.agent.id); } catch (e) { }
  try { if (exec && exec.sessionId) return String(exec.sessionId); } catch (e) { }
  return '';
}

export function apply(ctx, config) {
  plog('apply entered (vote mode)');
  const ensureFiles = (delay) => {
    try { nodeFs.writeFileSync(DOER, DOER_PS1, 'utf8'); nodeFs.writeFileSync(VBS, vbsText(delay), 'utf8'); return true; }
    catch (e) { return false; }
  };

  // ── 底层：排定一次重启（投票通过后 / 用户直接重启 都走这里）──────────────
  const scheduleRestart = (delay, sessionId, altIds) => {
    if (!ensureFiles(delay)) return { ok: false, text: '无法写入重启脚本到 ' + TMP };
    try { nodeFs.writeFileSync(REQ, JSON.stringify({ sessionId, altIds: altIds || [], at: new Date().toISOString(), delay }), 'utf8'); } catch (e) { }
    try { nodeFs.unlinkSync(RES); } catch (e) { }
    try { execFileSync('schtasks', ['/delete', '/tn', 'dsh_restart_once', '/f'], { encoding: 'utf8', timeout: 30000, windowsHide: true }); } catch (e) { }
    try {
      // ── 2026-10-30 修掉"重启两次"的 bug ──────────────────────────────────
      // 旧代码：任务排在 now+5min，然后立刻 /run ⇒ 5 分钟后又自己跑一次，
      // 把刚起来的 DSH 再杀一遍（用户实测：20:23 请求 → 20:28 第二次重启）。
      // 新做法（用户 2026-10-30 定的"9999"方案）：把任务排到 2099-12-31 23:59，
      // 它**永远不会自己触发**；只靠下面那次 /run 跑一次；跑完由 doer 自己删任务。
      //
      // 2026-10-30 第二修：/sd 的日期格式跟系统区域走 —— 中文环境下 '12/31/2099'
      // 会被 schtasks 直接拒（"无效的起始日期，格式应为 yyyy/mm/dd"），
      // 而 en-US 又只认 MM/dd/yyyy。所以按顺序试两种格式，
      // 全失败就**不排任务**、直接把 doer 拉起来（少一层依赖，绝不会因此不重启）。
      const createRun = (sd) => {
        execFileSync('schtasks', ['/create', '/tn', 'dsh_restart_once',
          '/tr', 'wscript.exe //B //Nologo ' + VBS,
          '/sc', 'once', '/sd', sd, '/st', '23:59', '/f'],
          { encoding: 'utf8', timeout: 30000, windowsHide: true });
        execFileSync('schtasks', ['/run', '/tn', 'dsh_restart_once'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      };
      let scheduled = false;
      let lastErr = null;
      for (const sd of ['2099/12/31', '12/31/2099']) {
        try { createRun(sd); scheduled = true; break; } catch (e) { lastErr = e; }
      }
      if (!scheduled) {
        // 兜底：wscript 起的 doer 是独立进程，父进程被 Stop-Process 杀掉也不会跟着死
        plog('schtasks schedule failed (' + (lastErr && lastErr.message ? lastErr.message : 'unknown') + '); fallback to direct wscript');
        execFileSync('wscript.exe', ['//B', '//Nologo', VBS], { timeout: 30000, windowsHide: true, stdio: 'ignore' });
      }
    } catch (e) { return { ok: false, text: '排定重启任务失败：' + (e && e.message ? e.message : String(e)) }; }
    return { ok: true, scheduled: true, delaySeconds: delay, sessionId, resultPath: RES, logPath: LOG };
  };

  // ── 通知：给每个被通知的 Agent 发一条消息（走 sessionController.prompt）────
  const notifySessions = (ids, text) => {
    let sc = null;
    try { sc = ctx.get ? ctx.get('sessionController') : undefined; } catch (e) { sc = null; }
    if (!sc || typeof sc.prompt !== 'function') { plog('notify skipped: no sessionController'); return 0; }
    let n = 0;
    for (const sid of ids) {
      if (!sid) continue;
      try {
        sc.prompt({
          requestId: 'dsh-restart-vote-' + randomUUID(),
          sessionId: sid,
          mode: 'queue',
          content: [{ type: 'text', text }],
          source: { kind: 'tool', callId: 'dsh-restart-vote-' + randomUUID() }
        }, new AbortController().signal);
        n += 1;
      } catch (e) { plog('prompt FAILED sid=' + sid + ' :: ' + (e && e.message ? e.message : String(e))); }
    }
    return n;
  };

  // ── 工具 1：dsh_restart —— 只发起表决，不重启 ──────────────────────────
  const defRestart = {
    name: 'dsh_restart',
    description:
      'Request a DSH restart. This does NOT restart immediately: it notifies every live Agent (including sub-agents) ' +
      'and waits until all of them call allowdshrestarting; any of them (or the user via /stopdshfromrestarting) can ' +
      'cancel it. Per the manuscript, the user-side restart has no delay; this agent-side path is deliberately a vote. ' +
      'Use dryRun to validate paths and the target pid without scheduling anything.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: 'Only validate paths and the target pid; do not start a vote.' }
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]
    },
    async execute(args, exec) {
      const a = args ?? {};
      const sessionId = callerId(exec);

      if (a.dryRun) {
        if (!ensureFiles(0)) return { ok: false, text: '无法写入重启脚本到 ' + TMP };
        try {
          execFileSync(PWSH, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DOER, '-Delay', '0', '-DryRun'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
          return { ok: true, dryRun: true, text: '干跑完成（未重启）日志：' + LOG };
        } catch (e) { return { ok: false, dryRun: true, text: '干跑失败：' + (e && e.message ? e.message : String(e)) }; }
      }

      // 已经有待表决的？直接提示，不重复发起
      const existing = readVote();
      if (existing) {
        const pending = existing.targets.filter((t) => !existing.votes[t]);
        return {
          ok: true, phase: 'voting', targets: existing.targets,
          text: '已有一个待表决的重启请求（' + (existing.at || '') + '，还等 ' + pending.length + ' 个：' +
            pending.join(', ') + '）。表决用 allowdshrestarting / stopdshfromrestarting。'
        };
      }

      const live = listLiveAgentIds(ctx);
      const targets = live.includes(sessionId) || !sessionId ? live : [sessionId].concat(live);
      if (targets.length === 0) {
        // 拿不到 agents 服务：不猜，直接拒绝（fail-closed）
        return { ok: false, text: '拿不到 agents.list()，无法确定要通知哪些 Agent ⇒ 不发起重启。' };
      }

      const v = { phase: 'voting', at: new Date().toISOString(), requester: sessionId, targets, votes: {}, delay: 0 };
      writeVote(v);

      const notice = '【DSH 重启请求】' + sessionId + ' 请求重启 DSH。\n' +
        '按手稿要求，Agent 发起的重启不立刻执行，必须**所有被通知的 Agent**都放行。\n' +
        '你可以：\n' +
        '  · 调用 allowdshrestarting 放行（全部放行后才重启）\n' +
        '  · 调用 stopdshfromrestarting 立即取消\n' +
        '用户也可以在任意对话输入 /stopdshfromrestarting 取消。';
      const notified = notifySessions(targets, notice);

      return {
        ok: true, phase: 'voting', requester: sessionId, targets, notified,
        votePath: VOTE,
        text: '已发起重启表决（不是重启）：通知了 ' + notified + '/' + targets.length + ' 个 Agent。\n' +
          '等待它们调用 allowdshrestarting；任一调用 stopdshfromrestarting（或用户输入 /stopdshfromrestarting）即取消。\n' +
          '全部放行后才会真正重启。'
      };
    }
  };

  // ── 工具 2：allowdshrestarting ─────────────────────────────────────────
  const defAllow = {
    name: 'allowdshrestarting',
    description:
      'Allow the pending DSH restart. When every notified Agent has called this, the restart runs immediately ' +
      '(no delay). Returns the remaining agents if others have not voted yet.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]
    },
    async execute(args, exec) {
      const sid = callerId(exec);
      const v = readVote();
      if (!v) return { ok: false, text: '当前没有待表决的重启请求（可能已取消、已执行或已过期）。' };
      if (!v.targets.includes(sid)) return { ok: false, text: '你不是本次通知的对象（' + sid + ' 不在 [' + v.targets.join(', ') + '] 里）。' };

      v.votes[sid] = 'allow';
      writeVote(v);
      const pending = v.targets.filter((t) => !v.votes[t]);
      const done = Object.keys(v.votes).length;

      if (pending.length === 0) {
        v.phase = 'approved';
        writeVote(v);
        const r = scheduleRestart(0, v.requester, []);
        notifySessions(v.targets, '【DSH 重启已放行】全部 Agent 已同意，重启开始（无延时）。重启完成后会通知各会话。');
        clearVote();
        return {
          ok: true, phase: 'approved', restart: r,
          text: '全部放行（' + done + '/' + v.targets.length + '）⇒ 正在重启（无延时）。\n' + (r.text || '') +
            '\n完成后结果会推到发起会话。'
        };
      }

      return {
        ok: true, phase: 'voting', votes: done, total: v.targets.length, pending,
        text: '已放行（' + done + '/' + v.targets.length + '）。还等：' + pending.join(', ') + '。'
      };
    }
  };

  // ── 工具 3：stopdshfromrestarting ──────────────────────────────────────
  const defStop = {
    name: 'stopdshfromrestarting',
    description:
      'Cancel the pending DSH restart immediately. Any notified Agent may call this; the user can also type ' +
      '/stopdshfromrestarting in any conversation.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }]
    },
    async execute(args, exec) {
      const sid = callerId(exec);
      const v = readVote();
      if (!v) return { ok: false, text: '当前没有待表决的重启请求。' };
      v.phase = 'cancelled';
      v.cancelledBy = sid;
      v.cancelledAt = new Date().toISOString();
      writeVote(v);
      notifySessions(v.targets, '【DSH 重启已取消】由 ' + sid + ' 阻止，不会重启。');
      clearVote();
      return { ok: true, phase: 'cancelled', text: '已阻止本次重启（' + sid + '）。' };
    }
  };

  ctx.effect(() => ctx.tools.register(defRestart), 'dsh-restart: dsh_restart (vote)');
  ctx.effect(() => ctx.tools.register(defAllow), 'dsh-restart: allowdshrestarting');
  ctx.effect(() => ctx.tools.register(defStop), 'dsh-restart: stopdshfromrestarting');

  // ---- 仅用户命令：/killdsh -------------------------------------------------
  const KILL_PS1 = [
    'Start-Sleep -Seconds 3',
    '$LOG = ' + JSON.stringify(LOG),
    'function W($m) { ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $m) | Add-Content -LiteralPath $LOG -Encoding UTF8 }',
    'W "killdsh: requested by user"',
    '$l = (netstat -ano | Select-String ":3080 .*LISTENING" | Select-Object -First 1)',
    'if ($l) { $p = [int](($l -replace "\\s+"," ").Trim().Split(" ")[-1]); try { Stop-Process -Id $p -Force -ErrorAction Stop; W ("killdsh: killed pid=" + $p) } catch { W ("killdsh: failed " + $_.Exception.Message) } } else { W "killdsh: no listener on 3080" }'
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

  // ---- 仅用户命令：/restartdsh（延时 0 —— 手稿："用户的重启接口延时不要了"）----
  try {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        commandCtx.commands.register({
          name: 'restartdsh',
          description: '重启 DSH（仅用户可输入；无延时，立即停 3080 → 自动拉起 → 探活）',
          handler: async () => {
            try {
              // 用户重启不走表决，且延时为 0（手稿明确要求）
              clearVote();
              const r = scheduleRestart(0, '', []);
              if (!r.ok) return { kind: 'error', text: r.text || '排定重启失败' };
              return { kind: 'success', text: '已立即重启（无延时）。页面会短暂断连，约 20 秒后自动回来。\n结果写入 %TEMP%\\dsh_restart_result.json。' };
            } catch (e) {
              return { kind: 'error', text: '重启失败：' + (e && e.message ? e.message : String(e)) };
            }
          }
        });
      } catch (e) { }
    });
  } catch (e) { }

  // ---- 仅用户命令：/stopdshfromrestarting（手稿要求）-----------------------
  try {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        commandCtx.commands.register({
          name: 'stopdshfromrestarting',
          description: '取消待表决的 DSH 重启（仅用户可输入，任何对话都能用）',
          handler: async () => {
            try {
              const v = readVote();
              if (!v) return { kind: 'success', text: '当前没有待表决的重启请求，无需取消。' };
              v.phase = 'cancelled';
              v.cancelledBy = 'user';
              v.cancelledAt = new Date().toISOString();
              writeVote(v);
              notifySessions(v.targets, '【DSH 重启已取消】用户执行了 /stopdshfromrestarting，重启停止。');
              clearVote();
              return { kind: 'success', text: '已取消待表决的重启（user）。' };
            } catch (e) {
              return { kind: 'error', text: '取消失败：' + (e && e.message ? e.message : String(e)) };
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
       * 结果文件是【重启之后】才写的，而本插件是在【重启过程中】挂载的 ⇒
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
