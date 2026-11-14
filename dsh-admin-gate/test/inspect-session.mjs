/** 只读：检查某会话最近几条 user/message 的来源与时间，用于核对身份判定。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const root = path.join(home, 'sessions');
const want = (process.argv[2] || '').replace(/^session-/, '');

const found = [];
for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
  if (!ws.isDirectory()) continue;
  for (const s of fs.readdirSync(path.join(root, ws.name), { withFileTypes: true })) {
    if (!s.isDirectory() || !s.name.includes(want)) continue;
    found.push(path.join(root, ws.name, s.name, 'session.v4.jsonl.zstd'));
  }
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
for (const file of found) {
  const buf = fs.readFileSync(file);
  const msgs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    let text = '';
    try { text = zstdDecompressSync(buf.subarray(i)).toString('utf8'); } catch { i += MAGIC.length; continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'user/message') {
          msgs.push({ time: ev.time, kind: ev.data?.source?.kind, preview: String(ev.data?.content?.[0]?.text || '').slice(0, 40) });
        }
      } catch { /* 头行等非事件行 */ }
    }
    i += MAGIC.length;
  }
  console.log('file:', file);
  console.log('user/message 共', msgs.length, '条，最后 6 条：');
  for (const m of msgs.slice(-6)) {
    console.log(`  ${new Date(m.time).toISOString()}  kind=${m.kind}  ${m.preview}`);
  }
}
if (!found.length) console.log('未找到会话文件，want=', want);
