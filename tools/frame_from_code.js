#!/usr/bin/env node
'use strict';
/**
 * frame_from_code.js —— 把 hstx_copy.c 的 scanline_cb 逐像素算出来，落成 BMP 参考图
 * ===================================================================
 * 为什么：要给「板子出的画面」一个**可信的对照**。手画近似图没有意义；
 * 这里从源码抽 FRAME_W/FRAME_H/color_bars[8]/bars，按 scanline_cb 的同一套
 * （含 dst 每字两像素、start=b*(W/bars)/2 那个 /2）逐像素模拟，再写 24 位 BMP。
 *
 * 用法：
 *   node tools/frame_from_code.js [输出目录]     默认写到当前目录
 *   产物：frame-from-code-640x480.bmp（1:1）、frame-from-code-1920x1080.bmp（3 倍最近邻）
 *
 * 自检：打印每色像素数（等宽应全等于 W*H/bars）与越界像素数（应为 0）
 */
const fs = require('fs');
const path = require('path');
const outDir = process.argv[2] || process.cwd();
const srcPath = path.join(__dirname, '..', 'src', 'hstx_copy.c');
const src = fs.readFileSync(srcPath, 'utf8');
const W = Number((src.match(/#define\s+FRAME_W\s+(\d+)/) || [])[1]);
const H = Number((src.match(/#define\s+FRAME_H\s+(\d+)/) || [])[1]);
const barLine = (src.match(/color_bars\[8\]\s*=\s*\{([^}]*)\}/) || [])[1] || '';
const c565 = [...barLine.matchAll(/0x([0-9A-Fa-f]{4})/g)].map((m) => parseInt(m[1], 16));
const bars = Number((src.match(/const int bars = (\d+)/) || [])[1]);
if (!W || !H || c565.length === 0 || !bars) { console.error('源码里没抽到常数: ' + srcPath); process.exit(1); }
const to888 = (v) => [Math.round(((v >> 11) & 31) * 255 / 31), Math.round(((v >> 5) & 63) * 255 / 63), Math.round((v & 31) * 255 / 31)];
const cols = c565.map(to888);
console.log('源码: ' + W + 'x' + H + '  bars=' + bars + '  颜色=' + cols.map((c) => c.join(',')).join(' | '));
const px = new Uint8Array(W * H * 3);
let bad = 0;
for (let y = 0; y < H; y++) for (let b = 0; b < bars; b++) {
  const start = Math.floor(b * (W / bars) / 2), end = Math.floor((b + 1) * (W / bars) / 2);
  const c = cols[b] || [0, 0, 0];
  for (let w = start; w < end; w++) for (let k = 0; k < 2; k++) {
    const x = w * 2 + k; if (x >= W) { bad++; continue; }
    const o = (y * W + x) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
  }
}
const tally = cols.map(() => 0);
for (let i = 0; i < W * H; i++) { const r = px[i*3], g = px[i*3+1], bl = px[i*3+2]; const idx = cols.findIndex((c) => c[0] === r && c[1] === g && c[2] === bl); if (idx >= 0) tally[idx]++; }
console.log('各色像素数: ' + tally.join(', ') + '  (等宽应全等于 ' + (W * H / bars) + ')');
console.log('越界像素(应为 0): ' + bad);
function writeBmp(file, scale) {
  const w = W * scale, h = H * scale, rowBytes = Math.ceil(w * 3 / 4) * 4, size = 54 + rowBytes * h;
  const buf = Buffer.alloc(size);
  buf.write('BM', 0); buf.writeUInt32LE(size, 2); buf.writeUInt32LE(54, 10); buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(rowBytes * h, 34);
  for (let y = 0; y < h; y++) { const sy = H - 1 - Math.floor(y / scale);
    for (let x = 0; x < w; x++) { const o = 54 + y * rowBytes + x * 3, s = (sy * W + Math.floor(x / scale)) * 3; buf[o] = px[s+2]; buf[o+1] = px[s+1]; buf[o+2] = px[s]; } }
  fs.writeFileSync(file, buf); console.log('写出 ' + path.basename(file) + '  ' + size + 'B');
}
writeBmp(path.join(outDir, 'frame-from-code-640x480.bmp'), 1);
writeBmp(path.join(outDir, 'frame-from-code-1920x1080.bmp'), 3);
