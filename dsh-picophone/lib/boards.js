// BOOTSEL 盘身份：DUT 与探针的引导盘几乎同名，烧错板代价很大 ⇒ 写盘前先认 Board-ID。

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- BOOTSEL 盘身份（#6）

export function bootVolumes() {
  const found = [];
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    const infoFile = path.join(root, 'INFO_UF2.TXT');
    if (!existsSync(infoFile)) continue;
    let text = '';
    try {
      text = readFileSync(infoFile, 'utf8');
    } catch {
      continue;
    }
    found.push({
      drive: root,
      boardId: (text.match(/Board-ID:\s*(\S+)/i) ?? [])[1] ?? '',
      model: ((text.match(/Model:\s*(.+)/i) ?? [])[1] ?? '').trim(),
      text: text.trim().split(/\r?\n/).slice(0, 6).join(' | '),
    });
  }
  return found;
}

/** 烧写前核对引导盘身份：DUT 与探针的盘几乎同名，写错就是把固件烧到另一块板。 */
export function checkBootVolume(cfg, board, force) {
  const want = String(cfg.boardIds?.[board] ?? '');
  const vols = bootVolumes();
  if (vols.length === 0) {
    // kind='none' 交给调用方按方法措辞：backdoor 方式下"现在没有 BOOTSEL 盘"本来就是正常前态，
    // 不该长得像报错（2026-10-06 反馈：它和同一屏后面的"已刷入"自相矛盾，害人以为失败）。
    return { ok: false, kind: 'none', text: '当前没有 BOOTSEL 盘（找不到 INFO_UF2.TXT）。' };
  }
  const listing = vols.map((v) => `  ${v.drive}  Board-ID=${v.boardId || '?'}  Model=${v.model || '?'}`).join('\n');
  const matched = vols.find((v) => v.boardId.toLowerCase() === want.toLowerCase());
  if (matched) return { ok: true, kind: 'match', drive: matched.drive, text: `BOOTSEL 盘身份匹配（${board} → Board-ID ${want}）\n${listing}` };
  if (force) return { ok: true, kind: 'forced', drive: vols[0].drive, text: `⚠️ 强制作业：盘身份不匹配（期望 ${board} → "${want}"）\n${listing}` };
  return {
    ok: false,
    kind: 'mismatch',
    text:
      `拒绝烧写 ✗ BOOTSEL 盘身份不匹配（期望 ${board} → Board-ID "${want}"，实际看到：\n${listing}\n` +
      `本台架没引出 RUN 脚，BOOTSEL 按钮是唯一救援手段；写错板代价很大。确认无误要强来就加 force: true。`,
  };
}
