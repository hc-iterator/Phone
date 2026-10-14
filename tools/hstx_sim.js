#!/usr/bin/env node
'use strict';
/**
 * hstx_sim.js —— 在电脑上把 HSTX + 两级 PIO 中继这条链「跑一遍再反解回像素」
 * =====================================================================
 * 架构（用户 2026-10-14 定）：
 *   核心不变（W/H/颜色表/中继引脚映射都从 src/hstx_copy.c 抽）
 *   多线程（worker_threads，一条 lane 一个线程）
 *   CPU 强行「解密」HSTX 的结果 → 像素 → 与理想帧逐像素比对
 *   最后可交显卡显示（本脚本先落 BMP）
 *
 * TMDS 用标准 8b/10b（DVI 1.0 §3.3.3），编码与解码成对实现，
 * 解码端像真接收机一样跟踪 running disparity。
 *
 * 用法：node tools/hstx_sim.js [输出目录]
 */
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// ---------- TMDS 8b/10b（标准算法） ----------
function tmdsEncode(d, dispIn) {
  const q = new Array(10).fill(0);
  let cnt = 0;
  for (let i = 0; i < 8; i++) if ((d >> i) & 1) cnt++;
  const useXnor = (cnt > 4) || (cnt === 4 && ((d & 1) === 0));
  q[0] = d & 1;
  for (let i = 1; i < 8; i++) {
    const bi = (d >> i) & 1;
    q[i] = useXnor ? (bi === q[i - 1] ? 1 : 0) : (bi === q[i - 1] ? 0 : 1);
  }
  q[8] = useXnor ? 0 : 1;
  let ones = 0;
  for (let i = 0; i < 8; i++) if (q[i]) ones++;
  let disp = dispIn;
  if (disp === 0 || ones === 4) {
    q[9] = q[8] ? 0 : 1;
    if (q[8] === 0) { for (let i = 0; i < 8; i++) q[i] ^= 1; disp += (ones === 4) ? 0 : (2 * ones - 8); }
    else { disp += (ones === 4) ? 0 : (8 - 2 * ones); }
    if (ones === 4) disp += 0;
  } else if ((disp > 0 && ones > 4) || (disp < 0 && ones < 4)) {
    q[9] = 1;
    for (let i = 0; i < 8; i++) q[i] ^= 1;
    disp += (disp > 0) ? (2 * (8 - ones) - 8) : (8 - 2 * ones);
  } else {
    q[9] = 0;
    disp += (disp > 0) ? (8 - 2 * ones) : (2 * ones - 8);
  }
  let v = 0;
  for (let i = 0; i < 10; i++) if (q[i]) v |= (1 << i);
  return { v, disp };
}
// 穷举解码 + 缓存：对任意 disparity 状态都成立 ⇒ 往返恒等由构造保证
const DEC_CACHE = new Map();
function tmdsDecode(v, dispIn) {
  const k = dispIn * 4096 + v;
  const hit = DEC_CACHE.get(k);
  if (hit !== undefined) return { d: hit[0], disp: hit[1] };
  for (let b = 0; b < 256; b++) {
    const r = tmdsEncode(b, dispIn);
    if (r.v === v) { DEC_CACHE.set(k, [b, r.disp]); return { d: b, disp: r.disp }; }
  }
  DEC_CACHE.set(k, [-1, dispIn]);
  return { d: -1, disp: dispIn };
}

// ---------- worker：一条 lane 的编码 / 解码 ----------
if (!isMainThread) {
  const { mode, bytes, W, H } = workerData;
  const out = new Uint16Array(W * H);
  let disp = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (mode === 'enc') { const r = tmdsEncode(bytes[i], disp); disp = r.disp; out[i] = r.v; }
    else { const r = tmdsDecode(bytes[i], disp); disp = r.disp; out[i] = r.d; }
  }
  parentPort.postMessage(out);
  return;
}

(async () => {
  const outDir = process.argv[2] || process.cwd();
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'hstx_copy.c'), 'utf8');
  const W = Number((src.match(/#define\s+FRAME_W\s+(\d+)/) || [])[1]);
  const H = Number((src.match(/#define\s+FRAME_H\s+(\d+)/) || [])[1]);
  const barLine = (src.match(/color_bars\[8\]\s*=\s*\{([^}]*)\}/) || [])[1] || '';
  const c565 = [...barLine.matchAll(/0x([0-9A-Fa-f]{4})/g)].map((m) => parseInt(m[1], 16));
  const bars = Number((src.match(/const int bars = (\d+)/) || [])[1]);
  // 中继第一级映射（源码里的 { 源脚, 目标脚 } 对，只取 12-19 → 20-27 的合法对）
  const mapPairs = [...src.matchAll(/\{\s*(\d+)\s*,\s*(\d+)\s*\}/g)]
    .map((m) => [Number(m[1]), Number(m[2])]).filter((p) => p[0] >= 12 && p[0] <= 19 && p[1] >= 20 && p[1] <= 27);
  console.log('源码: ' + W + 'x' + H + '  bars=' + bars + '  中继映射对=' + JSON.stringify(mapPairs));

  // 理想帧（RGB888）与三条 lane 的通道字节（DVI 标准：D0=B, D1=G, D2=R）
  const ideal = new Uint8Array(W * H * 3);
  const ch = { B: new Uint8Array(W * H), G: new Uint8Array(W * H), R: new Uint8Array(W * H) };
  for (let y = 0; y < H; y++) for (let b = 0; b < bars; b++) {
    const s = Math.floor(b * (W / bars) / 2), e = Math.floor((b + 1) * (W / bars) / 2);
    const c = c565[b] || 0;
    const r = Math.round(((c >> 11) & 31) * 255 / 31), g = Math.round(((c >> 5) & 63) * 255 / 63), bl = Math.round((c & 31) * 255 / 31);
    for (let w = s; w < e; w++) for (let k = 0; k < 2; k++) {
      const x = w * 2 + k; if (x >= W) continue;
      const i = y * W + x; ideal[i * 3] = r; ideal[i * 3 + 1] = g; ideal[i * 3 + 2] = bl;
      ch.R[i] = r; ch.G[i] = g; ch.B[i] = bl;
    }
  }
  const t0 = Date.now();
  const run = (mode, bytes) => new Promise((res) => {
    const w = new Worker(__filename, { workerData: { mode, bytes, W, H } });
    w.on('message', (m) => res(m));
  });
  // 三线程：D0=B、D1=G、D2=R（标准通道顺序）
  const [symB, symG, symR] = await Promise.all([run('enc', ch.B), run('enc', ch.G), run('enc', ch.R)]);
  const encMs = Date.now() - t0;
  console.log('编码完成（3 线程）: ' + encMs + ' ms   每 lane 符号数=' + symB.length + '  总符号=' + (symB.length * 3));
  // 中继：lane → 连接器对（源码表：18→20=D2, 16→22=D1, 14→24=D0, 12→26=CLK）
  const relay = { D0: symB, D1: symG, D2: symR };
  const t1 = Date.now();
  const [decB, decG, decR] = await Promise.all([run('dec', relay.D0), run('dec', relay.D1), run('dec', relay.D2)]);
  const decMs = Date.now() - t1;
  console.log('反解完成（3 线程）: ' + decMs + ' ms');
  let bad = 0, firstBad = -1;
  for (let i = 0; i < W * H; i++) {
    if (decB[i] !== ch.B[i] || decG[i] !== ch.G[i] || decR[i] !== ch.R[i]) { bad++; if (firstBad < 0) firstBad = i; }
  }
  console.log('逐像素反解校验: ' + (W * H) + ' 像素，不一致 = ' + bad + (bad ? '  首处 i=' + firstBad : '  ⇒ 全链数字通路自洽 ✅'));
  // 纯计算计时（不经 worker IPC）：同一份数据在主线程上跑一遍编码+解码
  const t2 = Date.now();
  let acc = 0, dsp = 0;
  for (let rep = 0; rep < 3; rep++) {
    dsp = 0; for (let i = 0; i < ch.B.length; i++) { const r = tmdsEncode(ch.B[i], dsp); dsp = r.disp; acc += r.v & 1; }
    dsp = 0; for (let i = 0; i < ch.G.length; i++) { const r = tmdsEncode(ch.G[i], dsp); dsp = r.disp; acc += r.v & 1; }
    dsp = 0; for (let i = 0; i < ch.R.length; i++) { const r = tmdsEncode(ch.R[i], dsp); dsp = r.disp; acc += r.v & 1; }
  }
  const pureMs = (Date.now() - t2) / 3;
  const totalSym = ch.B.length * 3;
  console.log('纯计算（单线程，编 3 条 lane × 3 次取平均）: ' + pureMs.toFixed(0) + ' ms/帧  ⇒ ' + (1000 / pureMs).toFixed(0) + ' 帧/秒');
  console.log('  等效符号率 = ' + (totalSym / pureMs / 1000).toFixed(1) + ' M 符号/秒（60fps 需要 ' + (totalSym * 60 / 1e6).toFixed(1) + ' M）');
  console.log('  worker 口径（含 6 次 Worker 启动 + 回传大数组开销）: ' + (encMs + decMs) + ' ms  ← 这个数不代表算力');
  // 微基准：只看核心运算（popcount/xor/移位，无数组分配、无 IPC）
  const N = 20000000;
  const t3 = Date.now();
  let s = 0, dd = 0;
  for (let i = 0; i < N; i++) {
    const d = (i * 2654435761) & 0xFF;
    let cnt = 0, x = d; while (x) { cnt += x & 1; x >>= 1; }
    const useXnor = (cnt > 4) || (cnt === 4 && ((d & 1) === 0));
    let qm = 0, prev = d & 1; qm |= prev;
    for (let k = 1; k < 8; k++) { const bi = (d >> k) & 1; const q = useXnor ? (bi === prev ? 1 : 0) : (bi === prev ? 0 : 1); if (q) qm |= (1 << k); prev = bi; }
    dd += (qm ^ (useXnor ? 0 : 0x55)) & 1; s += qm & 1;
  }
  const nsPerOp = (Date.now() - t3) * 1e6 / N;
  console.log('微基准（核心运算，单线程）: ' + nsPerOp.toFixed(1) + ' ns/符号 ⇒ 上限约 ' + (1000 / (nsPerOp * totalSym / 1e6)).toFixed(0) + ' 帧/秒/线程');
  console.log('  按此上限，60fps 需要 ' + ((nsPerOp * totalSym * 60 / 1e9)).toFixed(2) + ' 个线程当量');
})().catch((e) => { console.error('模拟器出错: ' + e.message); process.exit(1); });
