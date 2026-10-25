// /pico 命令：帮助文本、参数解析、子命令分发。人工入口，不进系统提示。

import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { lockFilePath, lockHolderText, readLockFile } from '../lib/identity.js';
import { opAgents } from './agents.js';
import { opBuild } from './build.js';
import { opConsole } from './console.js';
import { opDocs } from './docs.js';
import { opExec } from './exec.js';
import { opFlash } from './flash.js';
import { opGit } from './git.js';
import { opProcs } from './procs.js';
import { opRun } from './run.js';
import { opSerial } from './serial.js';
import { opStatus } from './status.js';
import { opSwd } from './swd.js';
import { opTemp } from './temp.js';
import { opTrust } from './trust.js';

// ---------------------------------------------------------------- /pico 命令

const HELP = [
  '/pico —— PicoPhone 台架命令',
  '',
  '  /pico status [--probe [--seconds N]]  路径 / 工具链 / git / 设备 / 台架锁 / 烧写账本 / 悬挂进程',
  '  /pico lock [clear]                看谁占着台架锁 / 清掉（确认是陈锁再用）',
  '  /pico build [root|<子工程>|host-test] [--sub <目录>] [--no-uf2] [--D <定义>]',
  '  /pico flash <dut|probe|sampler> [uf2路径] [--list] [--dry] [--method auto|backdoor|bootsel|picotool] [--force]',
  '  /pico serial [dut|probe|sampler] [秒数] [--send <文本>] [--esc] [--out <文件>] [--list]',
  '  /pico console <open|send|read|expect|close|list> [会话名] [数据] [--until <正则>] [--timeout <ms>] [--target <板>] [--no-stamp]',
  '  /pico swd <参数...>               （原样转发给 tools\\swd.ps1）',
  '  /pico procs [list|kill|sweep] [COM号]',
  '  /pico temp <path|ls|read|write|append|stat|mkdir|rm> <相对路径> [内容]',
  '  /pico git [main|<空间名>] <git 参数...>   （写操作加 --mutate）',
  '  /pico run <tools下的脚本> [参数...]',
  '  /pico exec <白名单可执行文件> [参数...]',
  '  /pico docs <check|patch ...>',
  '  /pico agents <list|sync|create <名字>> [--force|--recreate]',
  '',
  'Agent 侧对应工具：pico_status / pico_build / pico_flash / pico_serial / pico_console / pico_temp / pico_git / pico_run / pico_exec',
].join('\n');

function parseFlags(argv) {
  const rest = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      rest.push(token);
    }
  }
  return { rest, flags };
}

export async function dispatchCommand(cfg, line, ctx = {}) {
  const argv = line.trim().split(/\s+/).filter((s) => s !== '');
  if (argv.length === 0) return { kind: 'success', text: HELP };
  const verb = argv[0].toLowerCase();
  const tail = argv.slice(1);

  if (verb === 'help' || verb === '?') return { kind: 'success', text: HELP };

  const wrap = (result) => (result.ok ? { kind: 'success', text: result.text } : { kind: 'error', text: result.text });

  try {
    switch (verb) {
      case 'status':
      case 'env': {
        const { flags } = parseFlags(tail);
        return wrap(
          await opStatus(cfg, {
            probeSerial: flags.has('probe'),
            probeSeconds: flags.get('seconds') === undefined || flags.get('seconds') === true ? undefined : Number(flags.get('seconds')),
            probeTarget: flags.get('target'),
          }, ctx),
        );
      }
      case 'trust': {
        return await opTrust(cfg, { action: (tail[0] ?? 'list').toLowerCase(), name: tail[1] ?? '' });
      }
      case 'lock': {
        const file = lockFilePath(cfg);
        const info = readLockFile(file);
        if (tail[0] === 'clear' || tail[0] === 'unlock' || tail[0] === '--force') {
          try {
            unlinkSync(file);
            return { kind: 'success', text: `已删除台架锁 ${file}` };
          } catch (error) {
            return { kind: 'error', text: `删除失败: ${error && error.message ? error.message : error}` };
          }
        }
        return { kind: 'success', text: info ? `台架被占用: ${lockHolderText(info)}\n锁文件: ${file}` : `台架空闲（${file} 不存在）` };
      }
      case 'console': {
        const { rest, flags } = parseFlags(tail);
        const op = (rest[0] ?? 'list').toLowerCase();
        const data = flags.get('data') ?? (rest.length > 2 ? rest.slice(2).join(' ') : undefined);
        return wrap(
          await opConsole(cfg, {
            op,
            sessionId: rest[1],
            target: flags.get('target'),
            port: flags.get('port'),
            data: data === true ? undefined : data,
            until: flags.get('until'),
            timeoutMs: flags.get('timeout') === undefined || flags.get('timeout') === true ? undefined : Number(flags.get('timeout')),
            escapes: flags.has('esc'),
            stamp: flags.has('no-stamp') ? false : undefined,
          }, ctx),
        );
      }
      case 'build': {
        const { rest, flags } = parseFlags(tail);
        const target = rest[0] ?? 'root';
        const cacheArgs = [];
        for (const [k, v] of flags) if (k.startsWith('D')) cacheArgs.push(v === true ? `-D${k.slice(1)}` : `-D${k.slice(1)}=${v}`);
        return wrap(
          await opBuild(cfg, {
            target,
            buildSub: flags.get('sub'),
            noUf2: flags.has('no-uf2') || flags.has('nouf2'),
            cacheArgs,
          }),
        );
      }
      case 'flash': {
        const { rest, flags } = parseFlags(tail);
        if (flags.has('list')) return wrap(await opFlash(cfg, { method: 'list' }, ctx));
        return wrap(
          await opFlash(cfg, {
            board: rest[0] ?? 'dut',
            firmware: rest[1],
            method: flags.get('method') ?? 'backdoor',
            dryRun: flags.has('dry') || flags.has('dry-run'),
          }, ctx),
        );
      }
      case 'serial': {
        const { rest, flags } = parseFlags(tail);
        if (flags.has('list')) return wrap(await opSerial(cfg, { list: true }, ctx));
        return wrap(
          await opSerial(cfg, {
            target: rest[0] ?? 'dut',
            seconds: rest[1] === undefined ? undefined : Number(rest[1]),
            send: flags.get('send'),
            escapes: flags.has('esc') || flags.has('escapes'),
            outFile: flags.get('out'),
          }, ctx),
        );
      }
      case 'swd':
        return wrap(await opSwd(cfg, { args: tail }));
      case 'procs':
      case 'guard': {
        const action = (tail[0] ?? 'list').toLowerCase();
        return wrap(await opProcs(cfg, { action, waitFree: tail[1] }));
      }
      case 'temp': {
        const op = (tail[0] ?? 'path').toLowerCase();
        const rel = tail[1];
        const content = tail.slice(2).join(' ');
        return wrap(await opTemp(cfg, { op, path: rel, content: content === '' ? undefined : content }));
      }
      case 'git': {
        const { rest, flags } = parseFlags(tail);
        let repo = 'main';
        let gitArgv = rest;
        if (rest[0] === 'main' || rest[0] === 'agent' || rest[0]?.startsWith('agent/')) {
          repo = rest[0] === 'agent' ? rest[1] : rest[0];
          gitArgv = rest.slice(rest[0] === 'agent' ? 2 : 1);
        } else if (rest.length > 0 && existsSync(path.join(cfg.root, '_agents', rest[0]))) {
          repo = rest[0];
          gitArgv = rest.slice(1);
        }
        return wrap(await opGit(cfg, { repo, args: gitArgv, mutate: flags.has('mutate') }));
      }
      case 'run':
        if (tail.length === 0) return { kind: 'error', text: '用法: /pico run <tools下的脚本> [参数...]' };
        return wrap(await opRun(cfg, { script: tail[0], args: tail.slice(1) }));
      case 'exec':
        if (tail.length === 0) return { kind: 'error', text: '用法: /pico exec <白名单可执行文件> [参数...]' };
        return wrap(await opExec(cfg, { file: tail[0], args: tail.slice(1) }));
      case 'docs': {
        const action = (tail[0] ?? 'check').toLowerCase();
        return wrap(await opDocs(cfg, { action, args: tail.slice(1) }));
      }
      case 'agents': {
        const { rest, flags } = parseFlags(tail);
        const action = (rest[0] ?? 'list').toLowerCase();
        return wrap(await opAgents(cfg, { action, name: rest[1], force: flags.has('force'), recreate: flags.has('recreate') }));
      }
      default:
        return { kind: 'error', text: `未知子命令: ${verb}\n\n${HELP}` };
    }
  } catch (error) {
    return { kind: 'error', text: `执行失败: ${error && error.message ? error.message : error}` };
  }
}
